import {
  Effect,
  Redacted,
  Schedule,
  Schema,
} from "effect"
import type {
  IdempotencyKey,
  MessageId,
  RouteId,
  TestRecipientId,
} from "../core/identifiers.js"
import type {
  ReceivedAttachmentId,
  ReceivedContent,
} from "../core/received-content.js"
import {
  ErrorResponseSchema,
  type ErrorCode,
} from "../protocol/errors.js"
import {
  EmailMessageEnvelopeSchema,
  EmailMessagePageSchema,
  ListMessagesQuerySchema,
  ReceivedContentEnvelopeSchema,
  ReplyEmailRequestSchema,
  SendEmailRequestSchema,
  type EmailMessage,
  type EmailMessagePage,
  type ReplyEmailRequest,
  type SendEmailRequest,
} from "../protocol/messages.js"
import {
  EmailRouteEnvelopeSchema,
  EmailRouteListSchema,
  ProvisionRouteRequestSchema,
  RouteRotationSchema,
  type EmailRoute,
  type EmailRouteList,
  type ProvisionRouteRequest,
  type RouteRotation,
} from "../protocol/routes.js"
import {
  AddTestRecipientRequestSchema,
  EmailTestRecipientEnvelopeSchema,
  EmailTestRecipientListSchema,
  type AddTestRecipientRequest,
  type EmailTestRecipient,
  type EmailTestRecipientList,
} from "../protocol/test-recipients.js"
import {
  Conflict,
  Forbidden,
  InvalidClientRequest,
  InvalidRemoteResponse,
  type ClientError,
  NotFound,
  RateLimited,
  RemoteUnavailable,
  RequestCancelled,
  RequestRejected,
  Unauthorized,
} from "./client-errors.js"

/** Minimal Fetch-compatible transport accepted for client injection and tests. */
export interface Fetch {
  (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response>
}

/** Configuration for a hosted email API client. */
export interface ClientConfig {
  readonly baseUrl: URL
  readonly accessToken: Redacted.Redacted<string>
  readonly fetch?: Fetch
}

/** Caller-owned cancellation options shared by client operations. */
export interface RequestOptions {
  readonly signal?: AbortSignal
}

/** Streamed raw MIME returned by the hosted raw-message endpoint. */
export interface RawMimeResponse {
  readonly body: ReadableStream<Uint8Array>
  readonly sizeBytes?: number
  readonly contentType: "message/rfc822"
  readonly etag?: string
}

/** Streamed bytes returned by the hosted received-attachment endpoint. */
export interface ReceivedAttachmentResponse {
  readonly body: ReadableStream<Uint8Array>
  readonly sizeBytes?: number
  readonly contentType: "application/octet-stream"
  readonly etag?: string
}

type BinaryContentType = "application/octet-stream" | "message/rfc822"

interface MutableBinaryResponse<ContentType extends BinaryContentType> {
  body: ReadableStream<Uint8Array>
  sizeBytes?: number
  contentType: ContentType
  etag?: string
}

/** Query for one stable page of hosted messages. */
export interface ListMessagesRequest extends Schema.Schema.Type<
  typeof ListMessagesQuerySchema
> {}

/** Hosted message operations. */
export interface MessageClient {
  readonly send: (
    input: SendEmailRequest,
    idempotencyKey: IdempotencyKey,
    options?: RequestOptions,
  ) => Effect.Effect<EmailMessage, ClientError>
  readonly list: (
    input?: ListMessagesRequest,
    options?: RequestOptions,
  ) => Effect.Effect<EmailMessagePage, ClientError>
  readonly get: (
    messageId: MessageId,
    options?: RequestOptions,
  ) => Effect.Effect<EmailMessage, ClientError>
  readonly getContent: (
    messageId: MessageId,
    options?: RequestOptions,
  ) => Effect.Effect<ReceivedContent, ClientError>
  readonly getAttachment: (
    messageId: MessageId,
    attachmentId: ReceivedAttachmentId,
    options?: RequestOptions,
  ) => Effect.Effect<ReceivedAttachmentResponse, ClientError>
  readonly getRawMime: (
    messageId: MessageId,
    options?: RequestOptions,
  ) => Effect.Effect<RawMimeResponse, ClientError>
  readonly reply: (
    messageId: MessageId,
    input: ReplyEmailRequest,
    idempotencyKey: IdempotencyKey,
    options?: RequestOptions,
  ) => Effect.Effect<EmailMessage, ClientError>
}

/** Hosted route operations. */
export interface RouteClient {
  readonly list: (
    options?: RequestOptions,
  ) => Effect.Effect<EmailRouteList, ClientError>
  readonly provision: (
    input: ProvisionRouteRequest,
    idempotencyKey: IdempotencyKey,
    options?: RequestOptions,
  ) => Effect.Effect<EmailRoute, ClientError>
  readonly pause: (
    routeId: RouteId,
    options?: RequestOptions,
  ) => Effect.Effect<EmailRoute, ClientError>
  readonly resume: (
    routeId: RouteId,
    options?: RequestOptions,
  ) => Effect.Effect<EmailRoute, ClientError>
  readonly rotate: (
    routeId: RouteId,
    idempotencyKey: IdempotencyKey,
    options?: RequestOptions,
  ) => Effect.Effect<RouteRotation, ClientError>
  readonly disable: (
    routeId: RouteId,
    options?: RequestOptions,
  ) => Effect.Effect<EmailRoute, ClientError>
}

/** Hosted test-recipient operations. */
export interface TestRecipientClient {
  readonly list: (
    options?: RequestOptions,
  ) => Effect.Effect<EmailTestRecipientList, ClientError>
  readonly add: (
    input: AddTestRecipientRequest,
    idempotencyKey: IdempotencyKey,
    options?: RequestOptions,
  ) => Effect.Effect<EmailTestRecipient, ClientError>
  readonly refresh: (
    recipientId: TestRecipientId,
    idempotencyKey: IdempotencyKey,
    options?: RequestOptions,
  ) => Effect.Effect<EmailTestRecipient, ClientError>
}

/** Complete hosted email client grouped by resource capability. */
export interface Client {
  readonly messages: MessageClient
  readonly routes: RouteClient
  readonly testRecipients: TestRecipientClient
}

interface JsonRequest {
  readonly method: "GET" | "POST" | "DELETE"
  readonly path: string
  readonly accept?:
    | "application/json"
    | "application/octet-stream"
    | "message/rfc822"
  readonly successStatus: 200 | 201
  readonly body: unknown | undefined
  readonly idempotencyKey: IdempotencyKey | undefined
  readonly options: RequestOptions | undefined
}

const isAbortCause = (cause: unknown): boolean =>
  cause instanceof DOMException && cause.name === "AbortError"

const hasMediaType = (response: Response, expected: string): boolean => {
  const header = response.headers.get("content-type")
  if (header === null) return false
  return header.split(";", 1)[0]?.trim().toLowerCase() === expected
}

const isSafeOpaqueHeader = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 1_024 &&
  !value.includes("\r") &&
  !value.includes("\n")

const retryAfterMilliseconds = (response: Response): number | undefined => {
  const raw = response.headers.get("retry-after")
  if (raw === null) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000)
  }
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return undefined
  return Math.max(0, at - Date.now())
}

const fallbackCode = (status: number): ErrorCode => {
  switch (status) {
    case 400:
      return "invalid_request"
    case 401:
      return "unauthorized"
    case 403:
      return "forbidden"
    case 404:
      return "not_found"
    case 409:
      return "idempotency_conflict"
    case 413:
      return "message_too_large"
    case 415:
      return "unsupported_media_type"
    case 422:
      return "validation_failed"
    case 429:
      return "rate_limited"
    case 503:
      return "service_unavailable"
    default:
      return "internal_error"
  }
}

const decodeErrorCode = (response: Response): Effect.Effect<ErrorCode> =>
  Effect.tryPromise({
    try: async () => {
      const body: unknown = await response.clone().json()
      return body
    },
    catch: () => undefined,
  }).pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(ErrorResponseSchema)(body).pipe(
        Effect.map((decoded) => decoded.error.code),
      )
    ),
    Effect.catch(() => Effect.succeed(fallbackCode(response.status))),
  )

const classifyStatus = (
  response: Response,
): Effect.Effect<never, ClientError> =>
  Effect.gen(function* () {
    const code = yield* decodeErrorCode(response)
    switch (response.status) {
      case 401:
        return yield* new Unauthorized({ reason: "unauthorized" })
      case 403:
        return yield* new Forbidden({ reason: "forbidden" })
      case 404:
        return yield* new NotFound({ reason: "not_found" })
      case 409:
        return yield* new Conflict({ code })
      case 400:
      case 413:
      case 415:
      case 422:
        return yield* new RequestRejected({ status: response.status, code })
      case 429: {
        const delay = retryAfterMilliseconds(response)
        return yield* new RateLimited(
          delay === undefined ? {} : { retryAfterMilliseconds: delay },
        )
      }
      default:
        if (response.status >= 500) {
          return yield* new RemoteUnavailable({
            reason: "server",
            status: response.status,
          })
        }
        return yield* new InvalidRemoteResponse({
          reason: "unexpected_status",
        })
    }
  })

const transientReadError = (error: ClientError): boolean =>
  error._tag === "EmailClient.RateLimited" ||
  error._tag === "EmailClient.RemoteUnavailable"

const readRetrySchedule = Schedule.exponential("250 millis").pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 2 }),
)

/** Construct a hosted email API client without performing network I/O. */
export const make = (config: ClientConfig): Client => {
  const fetch = config.fetch ?? globalThis.fetch

  const execute = Effect.fn("EmailClient.request")(function* (
    request: JsonRequest,
  ) {
    const url = new URL(request.path, config.baseUrl)
    const headers = new Headers({
      accept: request.accept ?? "application/json",
      authorization: `Bearer ${Redacted.value(config.accessToken)}`,
    })
    if (request.idempotencyKey !== undefined) {
      headers.set("idempotency-key", request.idempotencyKey)
    }
    if (request.body !== undefined) {
      headers.set("content-type", "application/json")
    }

    return yield* Effect.tryPromise({
      try: (effectSignal) => {
        const signal = request.options?.signal === undefined
          ? effectSignal
          : AbortSignal.any([effectSignal, request.options.signal])
        return fetch(url, {
          method: request.method,
          headers,
          body: request.body === undefined
            ? null
            : JSON.stringify(request.body),
          signal,
        })
      },
      catch: (cause) =>
        request.options?.signal?.aborted === true || isAbortCause(cause)
          ? new RequestCancelled({ reason: "cancelled" })
          : new RemoteUnavailable({ reason: "network" }),
    })
  })

  const requestJson = <A>(
    request: JsonRequest,
    schema: Schema.ConstraintDecoder<A, never>,
  ): Effect.Effect<A, ClientError> =>
    execute(request).pipe(
      Effect.flatMap((response) => {
        if (!response.ok) return classifyStatus(response)
        if (response.status !== request.successStatus) {
          return Effect.fail(
            new InvalidRemoteResponse({ reason: "unexpected_status" }),
          )
        }
        if (!hasMediaType(response, "application/json")) {
          return Effect.fail(
            new InvalidRemoteResponse({
              reason: "unexpected_content_type",
            }),
          )
        }
        return Effect.tryPromise({
          try: async () => {
            const body: unknown = await response.json()
            return body
          },
          catch: () =>
            new InvalidRemoteResponse({ reason: "invalid_json" }),
        }).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(schema, {
              onExcessProperty: "error",
            }),
          ),
          Effect.mapError((error) =>
            error._tag === "EmailClient.InvalidRemoteResponse"
              ? error
              : new InvalidRemoteResponse({ reason: "invalid_body" })
          ),
        )
      }),
    )

  const requestReadJson = <A>(
    request: JsonRequest,
    schema: Schema.ConstraintDecoder<A, never>,
  ): Effect.Effect<A, ClientError> =>
    requestJson(request, schema).pipe(
      Effect.retry({
        schedule: readRetrySchedule,
        while: transientReadError,
      }),
    )

  const requestReadBinary = <ContentType extends BinaryContentType>(
    request: JsonRequest,
    expectedContentType: ContentType,
  ): Effect.Effect<MutableBinaryResponse<ContentType>, ClientError> =>
    execute(request).pipe(
      Effect.flatMap((response) => {
        if (!response.ok) return classifyStatus(response)
        if (response.status !== request.successStatus) {
          return Effect.fail(
            new InvalidRemoteResponse({ reason: "unexpected_status" }),
          )
        }
        if (!hasMediaType(response, expectedContentType)) {
          return Effect.fail(
            new InvalidRemoteResponse({
              reason: "unexpected_content_type",
            }),
          )
        }
        if (response.body === null) {
          return Effect.fail(
            new InvalidRemoteResponse({ reason: "missing_body" }),
          )
        }

        const rawLength = response.headers.get("content-length")
        const parsedLength = rawLength === null ? undefined : Number(rawLength)
        if (
          rawLength !== null &&
          (
            rawLength.length === 0 ||
            parsedLength === undefined ||
            !Number.isSafeInteger(parsedLength) ||
            parsedLength < 0
          )
        ) {
          return Effect.fail(
            new InvalidRemoteResponse({ reason: "invalid_header" }),
          )
        }

        const etag = response.headers.get("etag")
        if (etag !== null && !isSafeOpaqueHeader(etag)) {
          return Effect.fail(
            new InvalidRemoteResponse({ reason: "invalid_header" }),
          )
        }

        const result: MutableBinaryResponse<ContentType> = {
          body: response.body,
          contentType: expectedContentType,
        }
        if (parsedLength !== undefined) {
          result.sizeBytes = parsedLength
        }
        if (etag !== null) {
          result.etag = etag
        }
        return Effect.succeed(result)
      }),
      Effect.retry({
        schedule: readRetrySchedule,
        while: transientReadError,
      }),
    )

  const encodeRequest = <A, I>(
    schema: Schema.ConstraintCodec<A, I, never, never>,
    input: A,
    reason: InvalidClientRequest["reason"],
  ): Effect.Effect<I, InvalidClientRequest> =>
    Schema.encodeEffect(schema)(input).pipe(
      Effect.mapError(() =>
        new InvalidClientRequest({ reason })
      ),
    )

  const envelopeRoute = (effect: Effect.Effect<
    { readonly route: EmailRoute },
    ClientError
  >): Effect.Effect<EmailRoute, ClientError> =>
    effect.pipe(Effect.map((response) => response.route))

  const envelopeRecipient = (effect: Effect.Effect<
    { readonly recipient: EmailTestRecipient },
    ClientError
  >): Effect.Effect<EmailTestRecipient, ClientError> =>
    effect.pipe(Effect.map((response) => response.recipient))

  return {
    messages: {
      send: (input, idempotencyKey, options) =>
        encodeRequest(SendEmailRequestSchema, input, "invalid_body").pipe(
          Effect.flatMap((body) =>
            requestJson({
              method: "POST",
              path: "/emails",
              successStatus: 201,
              body,
              idempotencyKey,
              options,
            }, EmailMessageEnvelopeSchema)
          ),
          Effect.map((response) => response.message),
        ),
      list: (input, options) =>
        encodeRequest(
          ListMessagesQuerySchema,
          input ?? {},
          "invalid_query",
        ).pipe(
          Effect.flatMap((query) => {
            const url = new URL("/emails", config.baseUrl)
            if (query.direction !== undefined) {
              url.searchParams.set("direction", query.direction)
            }
            if (query.cursor !== undefined) {
              url.searchParams.set("cursor", query.cursor)
            }
            if (query.limit !== undefined) {
              url.searchParams.set("limit", query.limit)
            }
            return requestReadJson({
              method: "GET",
              path: `${url.pathname}${url.search}`,
              successStatus: 200,
              body: undefined,
              idempotencyKey: undefined,
              options,
            }, EmailMessagePageSchema)
          }),
        ),
      get: (messageId, options) =>
        requestReadJson({
          method: "GET",
          path: `/emails/${encodeURIComponent(messageId)}`,
          successStatus: 200,
          body: undefined,
          idempotencyKey: undefined,
          options,
        }, EmailMessageEnvelopeSchema).pipe(
          Effect.map((response) => response.message),
        ),
      getContent: (messageId, options) =>
        requestReadJson({
          method: "GET",
          path: `/emails/${encodeURIComponent(messageId)}/content`,
          successStatus: 200,
          body: undefined,
          idempotencyKey: undefined,
          options,
        }, ReceivedContentEnvelopeSchema).pipe(
          Effect.map((response) => response.content),
        ),
      getAttachment: (messageId, attachmentId, options) =>
        requestReadBinary({
          method: "GET",
          path: `/emails/${encodeURIComponent(messageId)}/attachments/${
            encodeURIComponent(attachmentId)
          }`,
          accept: "application/octet-stream",
          successStatus: 200,
          body: undefined,
          idempotencyKey: undefined,
          options,
        }, "application/octet-stream"),
      getRawMime: (messageId, options) =>
        requestReadBinary({
          method: "GET",
          path: `/emails/${encodeURIComponent(messageId)}/raw`,
          accept: "message/rfc822",
          successStatus: 200,
          body: undefined,
          idempotencyKey: undefined,
          options,
        }, "message/rfc822"),
      reply: (messageId, input, idempotencyKey, options) =>
        encodeRequest(ReplyEmailRequestSchema, input, "invalid_body").pipe(
          Effect.flatMap((body) =>
            requestJson({
              method: "POST",
              path: `/emails/${encodeURIComponent(messageId)}/reply`,
              successStatus: 201,
              body,
              idempotencyKey,
              options,
            }, EmailMessageEnvelopeSchema)
          ),
          Effect.map((response) => response.message),
        ),
    },
    routes: {
      list: (options) =>
        requestReadJson({
          method: "GET",
          path: "/email-routes",
          successStatus: 200,
          body: undefined,
          idempotencyKey: undefined,
          options,
        }, EmailRouteListSchema),
      provision: (input, idempotencyKey, options) =>
        encodeRequest(
          ProvisionRouteRequestSchema,
          input,
          "invalid_body",
        ).pipe(
          Effect.flatMap((body) =>
            requestJson({
              method: "POST",
              path: "/email-routes",
              successStatus: 201,
              body,
              idempotencyKey,
              options,
            }, EmailRouteEnvelopeSchema)
          ),
          envelopeRoute,
        ),
      pause: (routeId, options) =>
        envelopeRoute(requestJson({
          method: "POST",
          path: `/email-routes/${encodeURIComponent(routeId)}/pause`,
          successStatus: 200,
          body: undefined,
          idempotencyKey: undefined,
          options,
        }, EmailRouteEnvelopeSchema)),
      resume: (routeId, options) =>
        envelopeRoute(requestJson({
          method: "POST",
          path: `/email-routes/${encodeURIComponent(routeId)}/resume`,
          successStatus: 200,
          body: undefined,
          idempotencyKey: undefined,
          options,
        }, EmailRouteEnvelopeSchema)),
      rotate: (routeId, idempotencyKey, options) =>
        requestJson({
          method: "POST",
          path: `/email-routes/${encodeURIComponent(routeId)}/rotate`,
          successStatus: 201,
          body: undefined,
          idempotencyKey,
          options,
        }, RouteRotationSchema),
      disable: (routeId, options) =>
        envelopeRoute(requestJson({
          method: "DELETE",
          path: `/email-routes/${encodeURIComponent(routeId)}`,
          successStatus: 200,
          body: undefined,
          idempotencyKey: undefined,
          options,
        }, EmailRouteEnvelopeSchema)),
    },
    testRecipients: {
      list: (options) =>
        requestReadJson({
          method: "GET",
          path: "/email-test-recipients",
          successStatus: 200,
          body: undefined,
          idempotencyKey: undefined,
          options,
        }, EmailTestRecipientListSchema),
      add: (input, idempotencyKey, options) =>
        encodeRequest(
          AddTestRecipientRequestSchema,
          input,
          "invalid_body",
        ).pipe(
          Effect.flatMap((body) =>
            requestJson({
              method: "POST",
              path: "/email-test-recipients",
              successStatus: 201,
              body,
              idempotencyKey,
              options,
            }, EmailTestRecipientEnvelopeSchema)
          ),
          envelopeRecipient,
        ),
      refresh: (recipientId, idempotencyKey, options) =>
        envelopeRecipient(requestJson({
          method: "POST",
          path: `/email-test-recipients/${encodeURIComponent(recipientId)}/refresh`,
          successStatus: 200,
          body: undefined,
          idempotencyKey,
          options,
        }, EmailTestRecipientEnvelopeSchema)),
    },
  }
}
