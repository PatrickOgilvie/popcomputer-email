import { Effect, Layer, Schema } from "effect"
import {
  SendIndeterminate,
  SendRejected,
  SendTransport,
  SendTransportUnavailable,
  type SendTransportResult,
  type TransportMessage,
} from "../send-transport.js"
import { EmailAddressSchema, type EmailAddress } from "../../core/address.js"
import { ProviderMessageIdSchema } from "../../core/identifiers.js"
import type { RecipientTransportOutcome } from "../../core/message.js"
import {
  cloudflareAccountUrl,
  cloudflareAuthorizationHeaders,
  hasUsableCloudflareEmailConfig,
  type CloudflareEmailApiConfig,
  type CloudflareFetch,
} from "./config.js"

const ProviderIssueSchema = Schema.Struct({
  code: Schema.Number.check(Schema.isInt()),
  message: Schema.String,
})

const ProviderResultInfoSchema = Schema.Struct({
  count: Schema.Number,
  per_page: Schema.Number,
  total_count: Schema.Number,
  cursor: Schema.optionalKey(Schema.String),
  page: Schema.optionalKey(Schema.Number),
})

const ProviderEnvelopeSchema = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.Array(ProviderIssueSchema),
  messages: Schema.Array(ProviderIssueSchema),
  result: Schema.Unknown,
  result_info: Schema.optionalKey(ProviderResultInfoSchema),
})

const ProviderSendResultSchema = Schema.Struct({
  delivered: Schema.Array(EmailAddressSchema),
  message_id: ProviderMessageIdSchema,
  permanent_bounces: Schema.Array(EmailAddressSchema),
  queued: Schema.Array(EmailAddressSchema),
})

type ProviderSendResult = typeof ProviderSendResultSchema.Type

const indeterminate = (reason: "network" | "timeout"): SendIndeterminate =>
  new SendIndeterminate({ reason })

const isTimeoutCause = (cause: unknown): boolean =>
  (cause instanceof DOMException || cause instanceof Error) &&
  cause.name === "TimeoutError"

const responseJson = (
  response: Response,
): Effect.Effect<unknown, SendIndeterminate> =>
  Effect.tryPromise({
    try: async () => {
      const value: unknown = await response.json()
      return value
    },
    catch: () => indeterminate("network"),
  })

const decodeProviderEnvelope = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This provider boundary immediately decodes the complete response envelope schema.
  value: unknown,
): Effect.Effect<typeof ProviderEnvelopeSchema.Type, SendIndeterminate> =>
  Schema.decodeUnknownEffect(ProviderEnvelopeSchema)(value, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => indeterminate("network")))

const decodeProviderSendResult = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This provider boundary immediately decodes the complete raw-send result schema.
  value: unknown,
): Effect.Effect<ProviderSendResult, SendIndeterminate> =>
  Schema.decodeUnknownEffect(ProviderSendResultSchema)(value, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => indeterminate("network")))

const allRecipients = (
  message: TransportMessage,
): readonly [EmailAddress, ...Array<EmailAddress>] => [
  ...message.to,
  ...message.cc,
  ...message.bcc,
]

const providerOutcomes = (
  message: TransportMessage,
  result: ProviderSendResult,
): Effect.Effect<ReadonlyArray<RecipientTransportOutcome>, SendIndeterminate> => {
  const requested = allRecipients(message)
  const requestedSet = new Set<EmailAddress>(requested)
  const statuses = new Map<EmailAddress, "accepted" | "rejected">()

  for (const address of [...result.delivered, ...result.queued]) {
    if (!requestedSet.has(address) || statuses.has(address)) {
      return Effect.fail(indeterminate("network"))
    }
    statuses.set(address, "accepted")
  }
  for (const address of result.permanent_bounces) {
    if (!requestedSet.has(address) || statuses.has(address)) {
      return Effect.fail(indeterminate("network"))
    }
    statuses.set(address, "rejected")
  }
  const outcomes: Array<RecipientTransportOutcome> = []
  for (const address of requested) {
    const status = statuses.get(address)
    if (status === undefined) {
      return Effect.fail(indeterminate("network"))
    }
    outcomes.push(status === "accepted"
      ? { _tag: "Accepted", address }
      : {
          _tag: "Rejected",
          address,
          reasonCode: "permanent_bounce",
        })
  }
  return Effect.succeed(outcomes)
}

/** Build Cloudflare Email Sending's raw-MIME transport service. */
export const makeCloudflareSendTransport = (
  config: CloudflareEmailApiConfig,
  fetchFn: CloudflareFetch = globalThis.fetch,
): SendTransport["Service"] => {
  const preflight = () => hasUsableCloudflareEmailConfig(config)
    ? Effect.void
    : Effect.fail(new SendTransportUnavailable({
        operation: "preflight",
        reason: "configuration",
      }))

  const send = Effect.fn("Email.Cloudflare.SendTransport.send")(function*(
    message: TransportMessage,
  ) {
    let mimeMessage: string
    try {
      mimeMessage = new TextDecoder("utf-8", { fatal: true }).decode(
        message.rawMime,
      )
    } catch {
      return yield* new SendRejected({ reason: "provider_rejected" })
    }

    const headers = cloudflareAuthorizationHeaders(config)
    headers.set("Content-Type", "application/json")
    const response = yield* Effect.tryPromise({
      try: (signal) => fetchFn(
        cloudflareAccountUrl(config, "email/sending/send_raw"),
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            from: message.from,
            mime_message: mimeMessage,
            recipients: allRecipients(message),
          }),
          signal,
        },
      ),
      catch: (cause) =>
        indeterminate(isTimeoutCause(cause) ? "timeout" : "network"),
    })

    if (response.status >= 400 && response.status < 500) {
      return yield* new SendRejected({ reason: "provider_rejected" })
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* indeterminate("network")
    }

    const body = yield* responseJson(response)
    const envelope = yield* decodeProviderEnvelope(body)
    if (!envelope.success || envelope.errors.length > 0) {
      return yield* indeterminate("network")
    }
    const result = yield* decodeProviderSendResult(envelope.result)
    const outcomes = yield* providerOutcomes(message, result)
    const transportResult: SendTransportResult = {
      _tag: "Accepted",
      providerMessageId: result.message_id,
      outcomes,
    }
    return transportResult
  })

  return SendTransport.of({ preflight, send })
}

/** Provide SendTransport through Cloudflare's raw-MIME REST endpoint. */
export const cloudflareSendTransportLayer = (
  config: CloudflareEmailApiConfig,
  fetchFn: CloudflareFetch = globalThis.fetch,
): Layer.Layer<SendTransport> =>
  Layer.succeed(
    SendTransport,
    makeCloudflareSendTransport(config, fetchFn),
  )
