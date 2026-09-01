import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Option, Redacted, Result } from "effect"
import type { CloudflareFetch } from "../../../src/adapters/cloudflare/config.js"
import {
  CloudflareDestinationDuplicateCode,
  CloudflareDestinationQuotaExceededCode,
  makeCloudflareDestinationRegistry,
} from "../../../src/adapters/cloudflare/destination-registry.js"
import {
  makeInboundEmailHandler,
  type ForwardableEmailMessageLike,
} from "../../../src/adapters/cloudflare/inbound-handler.js"
import { makeCloudflareSendTransport } from "../../../src/adapters/cloudflare/rest-send-transport.js"
import { InboundStoreFailure } from "../../../src/adapters/inbound-store.js"
import {
  type TransportMessage,
} from "../../../src/adapters/send-transport.js"
import {
  InboundMessageTooLarge,
  InboundRouteInactive,
  InboundRouteNotFound,
  InboundService,
  InvalidInboundMime,
  type InboundEnvelope,
  type InboundError,
} from "../../../src/application/inbound-service.js"
import { EmailAddressSchema } from "../../../src/core/address.js"
import {
  DestinationIdSchema,
  MessageIdSchema,
  NamespaceSchema,
  RouteIdSchema,
} from "../../../src/core/identifiers.js"
import {
  MessageSchema,
  type InboundMessage,
} from "../../../src/core/message.js"
import { ScopeSchema } from "../../../src/core/scope.js"

const config = {
  accountId: "account-test",
  apiToken: Redacted.make("test-api-token"),
}

const scope = ScopeSchema.make({
  namespace: NamespaceSchema.make("namespace-cloudflare-test"),
  environment: "live",
})

const rawMime = [
  "From: sender@example.com",
  "To: recipient@example.com",
  "Subject: Adapter test",
  "",
  "hello",
  "",
].join("\r\n")

const transportMessage: TransportMessage = {
  scope,
  messageId: MessageIdSchema.make("message-cloudflare-test"),
  from: EmailAddressSchema.make("sender@example.com"),
  to: [EmailAddressSchema.make("recipient@example.com")],
  cc: [EmailAddressSchema.make("copy@example.com")],
  bcc: [EmailAddressSchema.make("blind@example.com")],
  rawMime: new TextEncoder().encode(rawMime),
}

const providerEnvelope = <Result>(result: Result) => ({
  success: true,
  errors: [],
  messages: [],
  result,
})

const fetchResponse = <Body>(status: number, body: Body): CloudflareFetch =>
  async () => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

const inboundMessage: InboundMessage = MessageSchema.cases.Inbound.make({
  id: MessageIdSchema.make("message-inbound-cloudflare"),
  scope,
  routeId: RouteIdSchema.make("route-inbound-cloudflare"),
  from: EmailAddressSchema.make("sender@example.com"),
  to: [EmailAddressSchema.make("inbox@example.com")],
  subject: "Inbound adapter test",
  sizeBytes: 10,
  receivedAt: DateTime.makeUnsafe(1_000),
  createdAt: DateTime.makeUnsafe(1_000),
  updatedAt: DateTime.makeUnsafe(1_000),
  state: MessageSchema.cases.Inbound.fields.state.cases.Received.make({}),
})

interface ForwardableFixture {
  readonly message: ForwardableEmailMessageLike
  readonly rejections: Array<string>
}

const forwardable = (
  from = "sender@example.com",
  to = "inbox@example.com",
): ForwardableFixture => {
  const rejections: Array<string> = []
  return {
    message: {
      from,
      to,
      raw: new Blob([rawMime]).stream(),
      rawSize: rawMime.length,
      setReject: (reason) => {
        rejections.push(reason)
      },
    },
    rejections,
  }
}

describe("Cloudflare raw send transport", () => {
  test("posts canonical MIME once and maps all recipient outcomes", async () => {
    const calls: Array<{
      readonly url: string
      readonly init: RequestInit | undefined
    }> = []
    const fetchFn: CloudflareFetch = async (input, init) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify(providerEnvelope({
        delivered: ["recipient@example.com"],
        queued: ["copy@example.com"],
        permanent_bounces: ["blind@example.com"],
        message_id: "provider-message-1",
      })), { status: 200 })
    }
    const transport = makeCloudflareSendTransport(config, fetchFn)

    const result = await Effect.runPromise(transport.send(transportMessage))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-test/email/sending/send_raw",
    )
    expect(calls[0]?.init?.method).toBe("POST")
    expect(new Headers(calls[0]?.init?.headers).get("Authorization"))
      .toBe("Bearer test-api-token")
    expect(calls[0]?.init?.body).toBe(JSON.stringify({
      from: "sender@example.com",
      mime_message: rawMime,
      recipients: [
        "recipient@example.com",
        "copy@example.com",
        "blind@example.com",
      ],
    }))
    expect(result._tag).toBe("Accepted")
    if (result._tag === "Accepted") {
      expect(String(result.providerMessageId)).toBe("provider-message-1")
      expect(result.outcomes.map((outcome) => ({
        tag: outcome._tag,
        address: String(outcome.address),
        reasonCode: outcome._tag === "Rejected"
          ? outcome.reasonCode
          : undefined,
      }))).toEqual([
        {
          tag: "Accepted",
          address: "recipient@example.com",
          reasonCode: undefined,
        },
        {
          tag: "Accepted",
          address: "copy@example.com",
          reasonCode: undefined,
        },
        {
          tag: "Rejected",
          address: "blind@example.com",
          reasonCode: "permanent_bounce",
        },
      ])
    }
  })

  test("treats a 4xx as definitive rejection", async () => {
    const transport = makeCloudflareSendTransport(
      config,
      fetchResponse(422, {}),
    )
    const attempted = await Effect.runPromise(Effect.result(
      transport.send(transportMessage),
    ))
    expect(Result.isFailure(attempted)).toBe(true)
    if (Result.isFailure(attempted)) {
      expect(attempted.failure._tag).toBe("SendRejected")
    }
  })

  test("treats 5xx, network, timeout, and malformed success as indeterminate", async () => {
    const cases: ReadonlyArray<{
      readonly fetchFn: CloudflareFetch
      readonly reason: "network" | "timeout"
    }> = [
      { fetchFn: fetchResponse(503, {}), reason: "network" },
      {
        fetchFn: async () => {
          throw new Error("network unavailable")
        },
        reason: "network",
      },
      {
        fetchFn: async () => {
          throw new DOMException("timed out", "TimeoutError")
        },
        reason: "timeout",
      },
      {
        fetchFn: fetchResponse(200, providerEnvelope({
          delivered: "recipient@example.com",
          queued: [],
          permanent_bounces: [],
          message_id: "provider-message-1",
        })),
        reason: "network",
      },
    ]

    for (const candidate of cases) {
      const attempted = await Effect.runPromise(Effect.result(
        makeCloudflareSendTransport(config, candidate.fetchFn)
          .send(transportMessage),
      ))
      expect(Result.isFailure(attempted)).toBe(true)
      if (Result.isFailure(attempted)) {
        expect(attempted.failure._tag).toBe("SendIndeterminate")
        expect(attempted.failure.reason).toBe(candidate.reason)
      }
    }
  })

  test("rejects provider outcome sets that are incomplete or overlapping", async () => {
    const fetchFn = fetchResponse(200, providerEnvelope({
      delivered: ["recipient@example.com"],
      queued: ["recipient@example.com", "copy@example.com"],
      permanent_bounces: ["blind@example.com"],
      message_id: "provider-message-1",
    }))
    const attempted = await Effect.runPromise(Effect.result(
      makeCloudflareSendTransport(config, fetchFn).send(transportMessage),
    ))
    expect(Result.isFailure(attempted)).toBe(true)
    if (Result.isFailure(attempted)) {
      expect(attempted.failure._tag).toBe("SendIndeterminate")
    }
  })
})

describe("Cloudflare destination registry", () => {
  test("creates and reads strictly validated verification state", async () => {
    const calls: Array<{
      readonly url: string
      readonly init: RequestInit | undefined
    }> = []
    const fetchFn: CloudflareFetch = async (input, init) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify(providerEnvelope({
        id: "destination-1",
        email: "recipient@example.com",
        verified: "2026-08-31T12:00:00Z",
        created: "2026-08-31T11:00:00Z",
        modified: "2026-08-31T12:00:00Z",
      })), { status: 200 })
    }
    const registry = makeCloudflareDestinationRegistry(config, fetchFn)

    const created = await Effect.runPromise(
      registry.create(EmailAddressSchema.make("recipient@example.com")),
    )
    const loaded = await Effect.runPromise(
      registry.get(DestinationIdSchema.make("destination-1")),
    )

    expect(created.status).toBe("verified")
    expect(loaded).toEqual(created)
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-test/email/routing/addresses",
    )
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ email: "recipient@example.com" }),
    )
    expect(calls[1]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-test/email/routing/addresses/destination-1",
    )
    expect(calls[1]?.init?.method).toBe("GET")
  })

  test("classifies provider quota, duplicate, and malformed responses", async () => {
    const failures: ReadonlyArray<{
      readonly fetchFn: CloudflareFetch
      readonly reason: "quota_exceeded" | "duplicate" | "invalid_response"
    }> = [
      {
        fetchFn: fetchResponse(409, {
          success: false,
          errors: [{
            code: CloudflareDestinationQuotaExceededCode,
            message: "quota reached",
          }],
          messages: [],
          result: null,
        }),
        reason: "quota_exceeded",
      },
      {
        fetchFn: fetchResponse(409, {
          success: false,
          errors: [{
            code: CloudflareDestinationDuplicateCode,
            message: "already exists",
          }],
          messages: [],
          result: null,
        }),
        reason: "duplicate",
      },
      {
        fetchFn: fetchResponse(200, providerEnvelope({
          id: "destination-1",
          email: "recipient@example.com",
          verified: null,
          unexpected: true,
        })),
        reason: "invalid_response",
      },
    ]

    for (const candidate of failures) {
      const attempted = await Effect.runPromise(Effect.result(
        makeCloudflareDestinationRegistry(config, candidate.fetchFn).create(
          EmailAddressSchema.make("recipient@example.com"),
        ),
      ))
      expect(Result.isFailure(attempted)).toBe(true)
      if (Result.isFailure(attempted)) {
        expect(attempted.failure.reason).toBe(candidate.reason)
      }
    }
  })

  test("finds an exact destination through bounded provider pagination", async () => {
    const calls: Array<string> = []
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `destination-page-one-${index}`,
      email: `recipient-${index}@example.com`,
      verified: null,
    }))
    const fetchFn: CloudflareFetch = async (input) => {
      const url = String(input)
      calls.push(url)
      const page = new URL(url).searchParams.get("page")
      const result = page === "1"
        ? firstPage
        : [{
            id: "destination-target",
            email: "target@example.com",
            verified: "2026-08-31T12:00:00Z",
          }]
      return new Response(JSON.stringify({
        ...providerEnvelope(result),
        result_info: {
          page: Number(page),
          per_page: 50,
          count: result.length,
          total_count: 51,
          total_pages: 2,
        },
      }), { status: 200 })
    }
    const found = await Effect.runPromise(
      makeCloudflareDestinationRegistry(config, fetchFn).findByAddress(
        EmailAddressSchema.make("target@example.com"),
      ),
    )

    expect(Option.isSome(found)).toBe(true)
    if (Option.isSome(found)) {
      expect(found.value.id).toBe(
        DestinationIdSchema.make("destination-target"),
      )
      expect(found.value.status).toBe("verified")
    }
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain("page=1&per_page=50")
    expect(calls[1]).toContain("page=2&per_page=50")
  })
})

describe("Cloudflare inbound handler", () => {
  test("decodes the envelope and awaits inline ingestion", async () => {
    const observed: Array<InboundEnvelope> = []
    const gate = Promise.withResolvers<void>()
    let completed = false
    const service = InboundService.of({
      ingest: (input) => Effect.promise(async () => {
        observed.push(input)
        await gate.promise
        completed = true
        return inboundMessage
      }),
    })
    const incoming = forwardable()
    const pending = makeInboundEmailHandler(service)(incoming.message)
    await Promise.resolve()
    expect(observed).toHaveLength(1)
    expect(completed).toBe(false)
    gate.resolve()
    await pending

    expect(completed).toBe(true)
    expect(String(observed[0]?.from)).toBe("sender@example.com")
    expect(String(observed[0]?.to)).toBe("inbox@example.com")
    expect(observed[0]?.claimedSizeBytes).toBe(rawMime.length)
    expect(incoming.rejections).toEqual([])
  })

  test("sets a fixed rejection only for permanent inbound failures", async () => {
    const cases: ReadonlyArray<{
      readonly error: InboundError
      readonly rejection: string
    }> = [
      {
        error: new InboundRouteNotFound({ reason: "not_found" }),
        rejection: "Mailbox not found",
      },
      {
        error: new InboundRouteInactive({ reason: "disabled" }),
        rejection: "Mailbox unavailable",
      },
      {
        error: new InboundMessageTooLarge({
          limitBytes: 10,
          observedBytes: 11,
        }),
        rejection: "Message too large",
      },
      {
        error: new InvalidInboundMime({ reason: "parse_failed" }),
        rejection: "Invalid MIME message",
      },
    ]

    for (const candidate of cases) {
      const service = InboundService.of({
        ingest: () => Effect.fail(candidate.error),
      })
      const incoming = forwardable()
      await makeInboundEmailHandler(service)(incoming.message)
      expect(incoming.rejections).toEqual([candidate.rejection])
    }
  })

  test("rejects an invalid provider envelope without calling ingestion", async () => {
    let calls = 0
    const service = InboundService.of({
      ingest: () => {
        calls += 1
        return Effect.succeed(inboundMessage)
      },
    })
    const incoming = forwardable("not an address")

    await makeInboundEmailHandler(service)(incoming.message)

    expect(calls).toBe(0)
    expect(incoming.rejections).toEqual(["Invalid email envelope"])
  })

  test("rethrows transient durability failures for runtime retry", async () => {
    const service = InboundService.of({
      ingest: () => Effect.fail(new InboundStoreFailure({
        operation: "commit",
        reason: "unavailable",
      })),
    })
    const incoming = forwardable()

    await expect(makeInboundEmailHandler(service)(incoming.message))
      .rejects.toBeDefined()
    expect(incoming.rejections).toEqual([])
  })
})
