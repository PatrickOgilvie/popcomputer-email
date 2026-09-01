import { describe, expect, test } from "bun:test"
import {
  Effect,
  Fiber,
  Redacted,
  Result,
  Schema,
} from "effect"
import { TestClock } from "effect/testing"
import {
  type ClientError,
  InvalidClientRequest,
  InvalidRemoteResponse,
  RateLimited,
} from "../../../src/client/client-errors.js"
import {
  type Fetch,
  make,
} from "../../../src/client/email-client.js"
import {
  IdempotencyKeySchema,
  MessageIdSchema,
  PageCursorSchema,
  RouteIdSchema,
} from "../../../src/core/identifiers.js"
import { ReceivedAttachmentIdSchema } from "../../../src/core/received-content.js"
import type { ErrorCode } from "../../../src/protocol/errors.js"
import {
  ReplyEmailRequestSchema,
  SendEmailRequestSchema,
} from "../../../src/protocol/messages.js"
import { ProvisionRouteRequestSchema } from "../../../src/protocol/routes.js"

const messageId = Schema.decodeUnknownSync(MessageIdSchema)("msg_1")
const routeId = Schema.decodeUnknownSync(RouteIdSchema)("route_1")
const idempotencyKey = Schema.decodeUnknownSync(IdempotencyKeySchema)(
  "send:request-1",
)
const attachmentId = ReceivedAttachmentIdSchema.make("v1_0")

const messageEnvelope = () => ({
  message: {
    id: "msg_1",
    environment: "live",
    direction: "outbound",
    status: "accepted",
    routeId: null,
    workflowId: null,
    from: "sender@example.com",
    to: ["recipient@example.com"],
    cc: [],
    bcc: [],
    subject: "Hello",
    sizeBytes: 42,
    providerMessageId: null,
    sentAt: "2026-08-31T12:00:00.000Z",
    receivedAt: null,
    createdAt: "2026-08-31T12:00:00.000Z",
    updatedAt: "2026-08-31T12:00:00.000Z",
    recipients: [],
  },
})

const routeEnvelope = () => ({
  route: {
    id: "route_1",
    environment: "live",
    address: "replies@example.com",
    mailboxHandle: "replies",
    inbound: {
      kind: "trigger",
      workflowId: "workflow:triage",
    },
    outbound: { kind: "sender", role: "alternate" },
    status: "active",
    revision: 1,
    createdAt: "2026-08-31T12:00:00.000Z",
    updatedAt: "2026-08-31T12:00:00.000Z",
    disabledAt: null,
  },
})

const contentEnvelope = () => ({
  content: {
    messageId: "msg_1",
    routeId: "route_1",
    envelopeFrom: "sender@example.com",
    envelopeTo: ["replies@example.com"],
    headerFrom: ["sender@example.com"],
    replyTo: ["reply@example.com"],
    subject: "Hello",
    text: "Body",
    html: null,
    threading: {
      messageId: "<message-1@example.com>",
      inReplyTo: null,
      references: [],
    },
    automation: {
      autoSubmitted: null,
      precedence: null,
      listId: false,
      responseSuppression: false,
    },
    attachments: [{
      id: "v1_0",
      filename: "invoice.pdf",
      mediaType: "application/pdf",
      disposition: "attachment",
      contentId: null,
      sizeBytes: 3,
    }],
  },
})

interface EmptyListResponse {
  readonly items: ReadonlyArray<never>
  readonly cursor?: null
  readonly unexpected?: true
}

type JsonResponseBody =
  | ReturnType<typeof messageEnvelope>
  | ReturnType<typeof routeEnvelope>
  | ReturnType<typeof contentEnvelope>
  | EmptyListResponse

const jsonResponse = (body: JsonResponseBody, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const errorResponse = (
  status: number,
  code: ErrorCode,
  retryAfter?: string,
): Response => {
  const headers = new Headers({ "content-type": "application/json" })
  if (retryAfter !== undefined) {
    headers.set("retry-after", retryAfter)
  }
  return new Response(JSON.stringify({
    error: {
      code,
      message: "request failed",
      requestId: "request_1",
    },
  }), { status, headers })
}

const clientFor = (fetch: Fetch) =>
  make({
    baseUrl: new URL("https://email.example.test"),
    accessToken: Redacted.make("secret-token"),
    fetch,
  })

const runFailure = async <A>(
  effect: Effect.Effect<A, ClientError>,
): Promise<ClientError> => {
  const result = await Effect.runPromise(Effect.result(effect))
  if (Result.isSuccess(result)) {
    throw new Error("expected client request to fail")
  }
  return result.failure
}

describe("hosted email client", () => {
  test("sends auth, idempotency, content headers, and encoded JSON", async () => {
    let capturedUrl: URL | undefined
    let capturedInit: RequestInit | undefined
    const fetch: Fetch = async (input, init) => {
      if (!(input instanceof URL)) {
        throw new Error("client must call fetch with a URL")
      }
      capturedUrl = input
      capturedInit = init
      return jsonResponse(messageEnvelope(), 201)
    }
    const input = Schema.decodeUnknownSync(SendEmailRequestSchema)({
      to: ["recipient@example.com"],
      subject: "Hello",
      automation: "auto_generated",
      text: "Body",
    })

    await Effect.runPromise(
      clientFor(fetch).messages.send(input, idempotencyKey),
    )

    if (capturedUrl === undefined || capturedInit === undefined) {
      throw new Error("fetch was not called")
    }
    const headers = new Headers(capturedInit.headers)
    expect(capturedUrl.pathname).toBe("/emails")
    expect(capturedInit.method).toBe("POST")
    expect(headers.get("authorization")).toBe("Bearer secret-token")
    expect(headers.get("idempotency-key")).toBe("send:request-1")
    expect(headers.get("accept")).toBe("application/json")
    expect(headers.get("content-type")).toBe("application/json")
    expect(capturedInit.body).toBe(JSON.stringify({
      to: ["recipient@example.com"],
      subject: "Hello",
      automation: "auto_generated",
      text: "Body",
    }))
  })

  test("encodes the documented message-list query path", async () => {
    let capturedUrl: URL | undefined
    const fetch: Fetch = async (input) => {
      if (!(input instanceof URL)) {
        throw new Error("client must call fetch with a URL")
      }
      capturedUrl = input
      return jsonResponse({ items: [], cursor: null })
    }

    await Effect.runPromise(clientFor(fetch).messages.list({
      direction: "outbound",
      cursor: PageCursorSchema.make("next_page"),
      limit: 25,
    }))

    expect(capturedUrl?.pathname).toBe("/emails")
    expect(capturedUrl?.search).toBe(
      "?direction=outbound&cursor=next_page&limit=25",
    )
  })

  test("rejects an invalid message-list limit before transport", async () => {
    let calls = 0
    const fetch: Fetch = async () => {
      calls += 1
      return jsonResponse({ items: [], cursor: null })
    }

    const failure = await runFailure(clientFor(fetch).messages.list({
      limit: Number.NaN,
    }))

    expect(failure).toBeInstanceOf(InvalidClientRequest)
    expect(failure).toMatchObject({ reason: "invalid_query" })
    expect(calls).toBe(0)
  })

  test("rejects an invalid request body before transport", async () => {
    let calls = 0
    const fetch: Fetch = async () => {
      calls += 1
      return jsonResponse(messageEnvelope(), 201)
    }
    const valid = Schema.decodeUnknownSync(SendEmailRequestSchema)({
      to: ["recipient@example.com"],
      subject: "Hello",
      text: "Body",
    })

    const failure = await runFailure(clientFor(fetch).messages.send({
      ...valid,
      subject: "invalid\rsubject",
    }, idempotencyKey))

    expect(failure).toBeInstanceOf(InvalidClientRequest)
    expect(failure).toMatchObject({ reason: "invalid_body" })
    expect(calls).toBe(0)
  })

  test("reads strict bounded content through the read retry policy", async () => {
    let calls = 0
    let capturedUrl: URL | undefined
    const fetch: Fetch = async (input) => {
      if (!(input instanceof URL)) {
        throw new Error("client must call fetch with a URL")
      }
      capturedUrl = input
      calls += 1
      return calls === 1
        ? errorResponse(503, "service_unavailable")
        : jsonResponse(contentEnvelope())
    }
    const client = clientFor(fetch)
    const program = Effect.gen(function* () {
      const fiber = yield* client.messages.getContent(messageId).pipe(
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 seconds")
      return yield* Fiber.join(fiber)
    })

    const content = await Effect.runPromise(
      program.pipe(Effect.provide(TestClock.layer())),
    )

    expect(capturedUrl?.pathname).toBe("/emails/msg_1/content")
    expect(content.replyTo.map(String)).toEqual(["reply@example.com"])
    expect(content.attachments.map(({ id }) => String(id))).toEqual(["v1_0"])
    expect(calls).toBe(2)
  })

  test("streams an attachment with validated binary metadata", async () => {
    let capturedUrl: URL | undefined
    let accept = ""
    const fetch: Fetch = async (input, init) => {
      if (!(input instanceof URL)) {
        throw new Error("client must call fetch with a URL")
      }
      capturedUrl = input
      accept = new Headers(init?.headers).get("accept") ?? ""
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "3",
          etag: '"attachment-v1"',
        },
      })
    }

    const response = await Effect.runPromise(
      clientFor(fetch).messages.getAttachment(messageId, attachmentId),
    )
    const bytes = new Uint8Array(
      await new Response(response.body).arrayBuffer(),
    )

    expect(capturedUrl?.pathname).toBe(
      "/emails/msg_1/attachments/v1_0",
    )
    expect(accept).toBe("application/octet-stream")
    expect(response.contentType).toBe("application/octet-stream")
    expect(response.sizeBytes).toBe(3)
    expect(response.etag).toBe('"attachment-v1"')
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  test("retries a transient received-attachment read", async () => {
    let calls = 0
    const fetch: Fetch = async () => {
      calls += 1
      return calls === 1
        ? errorResponse(503, "service_unavailable")
        : new Response(new Uint8Array([1]), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          })
    }
    const client = clientFor(fetch)
    const program = Effect.gen(function* () {
      const fiber = yield* client.messages.getAttachment(
        messageId,
        attachmentId,
      ).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 seconds")
      return yield* Fiber.join(fiber)
    })

    await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())))

    expect(calls).toBe(2)
  })

  test("rejects malformed attachment response metadata", async () => {
    const fetch: Fetch = async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "-1",
        },
      })

    const failure = await runFailure(
      clientFor(fetch).messages.getAttachment(messageId, attachmentId),
    )

    expect(failure).toBeInstanceOf(InvalidRemoteResponse)
    expect(failure).toMatchObject({ reason: "invalid_header" })
  })

  test("sends only caller-controlled reply content", async () => {
    let capturedUrl: URL | undefined
    let capturedInit: RequestInit | undefined
    const fetch: Fetch = async (input, init) => {
      if (!(input instanceof URL)) {
        throw new Error("client must call fetch with a URL")
      }
      capturedUrl = input
      capturedInit = init
      return jsonResponse(messageEnvelope(), 201)
    }
    const input = Schema.decodeUnknownSync(ReplyEmailRequestSchema)({
      text: "Workflow response",
      attachments: [{
        filename: "answer.txt",
        mediaType: "text/plain",
        content: "b2s=",
      }],
    })

    await Effect.runPromise(
      clientFor(fetch).messages.reply(messageId, input, idempotencyKey),
    )

    const headers = new Headers(capturedInit?.headers)
    expect(capturedUrl?.pathname).toBe("/emails/msg_1/reply")
    expect(capturedInit?.method).toBe("POST")
    expect(headers.get("idempotency-key")).toBe("send:request-1")
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      text: "Workflow response",
      attachments: [{
        filename: "answer.txt",
        mediaType: "text/plain",
        content: "b2s=",
      }],
    })
  })

  test("provisions independent route capabilities through one endpoint", async () => {
    let capturedUrl: URL | undefined
    let capturedInit: RequestInit | undefined
    const fetch: Fetch = async (input, init) => {
      if (!(input instanceof URL)) {
        throw new Error("client must call fetch with a URL")
      }
      capturedUrl = input
      capturedInit = init
      return jsonResponse(routeEnvelope(), 201)
    }
    const input = Schema.decodeUnknownSync(ProvisionRouteRequestSchema)({
      mailboxHandle: "replies",
      inbound: {
        kind: "trigger",
        workflowId: "workflow:triage",
      },
      outbound: { kind: "sender", role: "alternate" },
    })

    const route = await Effect.runPromise(
      clientFor(fetch).routes.provision(input, idempotencyKey),
    )

    expect(capturedUrl?.pathname).toBe("/email-routes")
    expect(capturedInit?.method).toBe("POST")
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      mailboxHandle: "replies",
      inbound: {
        kind: "trigger",
        workflowId: "workflow:triage",
      },
      outbound: { kind: "sender", role: "alternate" },
    })
    expect(route.inbound.kind).toBe("trigger")
    expect(route.outbound.kind).toBe("sender")
  })

  test("rejects unknown successful response fields", async () => {
    let calls = 0
    const fetch: Fetch = async () => {
      calls += 1
      return jsonResponse({ items: [], unexpected: true })
    }

    const failure = await runFailure(clientFor(fetch).routes.list())

    expect(failure).toBeInstanceOf(InvalidRemoteResponse)
    expect(failure).toMatchObject({ reason: "invalid_body" })
    expect(calls).toBe(1)
  })

  test("rejects an unexpected successful HTTP status", async () => {
    const fetch: Fetch = async () =>
      jsonResponse({ items: [], cursor: null }, 201)

    const failure = await runFailure(clientFor(fetch).messages.list())

    expect(failure).toBeInstanceOf(InvalidRemoteResponse)
    expect(failure).toMatchObject({ reason: "unexpected_status" })
  })

  test("rejects an undeclared successful response media type", async () => {
    const fetch: Fetch = async () =>
      new Response(JSON.stringify({ items: [], cursor: null }), {
        status: 200,
        headers: { "content-type": "text/plain" },
      })

    const failure = await runFailure(clientFor(fetch).messages.list())

    expect(failure).toBeInstanceOf(InvalidRemoteResponse)
    expect(failure).toMatchObject({
      reason: "unexpected_content_type",
    })
  })

  test("maps protocol statuses into the typed client error algebra", async () => {
    const cases: ReadonlyArray<{
      readonly status: number
      readonly code: ErrorCode
      readonly expectedTag: ClientError["_tag"]
      readonly retryAfter?: string
    }> = [
      {
        status: 400,
        code: "invalid_request",
        expectedTag: "EmailClient.RequestRejected",
      },
      {
        status: 401,
        code: "unauthorized",
        expectedTag: "EmailClient.Unauthorized",
      },
      {
        status: 403,
        code: "forbidden",
        expectedTag: "EmailClient.Forbidden",
      },
      {
        status: 404,
        code: "not_found",
        expectedTag: "EmailClient.NotFound",
      },
      {
        status: 409,
        code: "transition_conflict",
        expectedTag: "EmailClient.Conflict",
      },
      {
        status: 413,
        code: "message_too_large",
        expectedTag: "EmailClient.RequestRejected",
      },
      {
        status: 415,
        code: "unsupported_media_type",
        expectedTag: "EmailClient.RequestRejected",
      },
      {
        status: 422,
        code: "validation_failed",
        expectedTag: "EmailClient.RequestRejected",
      },
      {
        status: 429,
        code: "rate_limited",
        expectedTag: "EmailClient.RateLimited",
        retryAfter: "2",
      },
      {
        status: 503,
        code: "service_unavailable",
        expectedTag: "EmailClient.RemoteUnavailable",
      },
    ]

    for (const item of cases) {
      const fetch: Fetch = async () =>
        errorResponse(item.status, item.code, item.retryAfter)
      const failure = await runFailure(
        clientFor(fetch).routes.pause(routeId),
      )
      expect(failure._tag).toBe(item.expectedTag)
      if (failure instanceof RateLimited) {
        expect(failure.retryAfterMilliseconds).toBe(2_000)
      }
    }
  })

  test("retries a transient read and returns its later success", async () => {
    let calls = 0
    const fetch: Fetch = async () => {
      calls += 1
      return calls === 1
        ? errorResponse(503, "service_unavailable")
        : jsonResponse({ items: [] })
    }
    const client = clientFor(fetch)
    const program = Effect.gen(function* () {
      const fiber = yield* client.routes.list().pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 seconds")
      return yield* Fiber.join(fiber)
    })

    const response = await Effect.runPromise(
      program.pipe(Effect.provide(TestClock.layer())),
    )

    expect(response.items).toEqual([])
    expect(calls).toBe(2)
  })

  test("never retries a mutation automatically", async () => {
    let calls = 0
    const fetch: Fetch = async () => {
      calls += 1
      return errorResponse(503, "service_unavailable")
    }

    const failure = await runFailure(clientFor(fetch).routes.pause(routeId))

    expect(failure._tag).toBe("EmailClient.RemoteUnavailable")
    expect(calls).toBe(1)
  })

  test("never retries a reply after an ambiguous remote failure", async () => {
    let calls = 0
    const fetch: Fetch = async () => {
      calls += 1
      return errorResponse(503, "service_unavailable")
    }
    const request = ReplyEmailRequestSchema.make({ text: "Response" })

    const failure = await runFailure(
      clientFor(fetch).messages.reply(
        messageId,
        request,
        idempotencyKey,
      ),
    )

    expect(failure._tag).toBe("EmailClient.RemoteUnavailable")
    expect(calls).toBe(1)
  })

  test("maps caller cancellation without retrying the mutation", async () => {
    let calls = 0
    const fetch: Fetch = (_input, init) => {
      calls += 1
      return new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal === undefined || signal === null) {
          reject(new Error("missing fetch signal"))
          return
        }
        const cancel = () =>
          reject(new DOMException("request cancelled", "AbortError"))
        if (signal.aborted) {
          cancel()
          return
        }
        signal.addEventListener("abort", cancel, { once: true })
      })
    }
    const controller = new AbortController()
    const pending = Effect.runPromise(Effect.result(
      clientFor(fetch).routes.pause(routeId, {
        signal: controller.signal,
      }),
    ))
    await Promise.resolve()
    controller.abort()

    const result = await pending
    if (Result.isSuccess(result)) {
      throw new Error("expected cancellation to fail")
    }
    expect(result.failure._tag).toBe("EmailClient.RequestCancelled")
    expect(calls).toBe(1)
  })

  test("requests raw MIME with its protocol media type", async () => {
    let accept = ""
    const fetch: Fetch = async (_input, init) => {
      accept = new Headers(init?.headers).get("accept") ?? ""
      return new Response("raw message", {
        status: 200,
        headers: { "content-type": "message/rfc822" },
      })
    }

    const response = await Effect.runPromise(
      clientFor(fetch).messages.getRawMime(messageId),
    )

    expect(accept).toBe("message/rfc822")
    expect(response.contentType).toBe("message/rfc822")
  })
})
