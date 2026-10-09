import PostalMime from "postal-mime"
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect"
import {
  ContentDigest,
  type ContentDigestFailure,
} from "../adapters/content-digest.js"
import { IdentifierGenerator } from "../adapters/identifier-generator.js"
import {
  InboundStore,
  type InboundStoreFailure,
} from "../adapters/inbound-store.js"
import {
  RawMessageArchive,
  RawMessageArchiveFailure,
} from "../adapters/raw-message-archive.js"
import {
  RouteStore,
  type RouteStoreFailure,
} from "../adapters/route-store.js"
import type { EmailAddress } from "../core/address.js"
import type { InboundProviderDelivery } from "../core/inbound-delivery.js"
import {
  MessageSchema,
  MessageRecipientSchema,
  type InboundMessage,
} from "../core/message.js"
import {
  isPositiveSafeInteger,
  PositiveSafeIntegerSchema,
} from "../core/positive-safe-integer.js"
import {
  MaximumOperationalDurationMilliseconds,
  OperationalDurationMillisecondsSchema,
} from "../core/operational-duration.js"
import { RawMimeDescriptorSchema } from "../core/raw-mime.js"
import { isActive } from "../core/route.js"
import {
  WorkflowEventSchema,
} from "../core/workflow.js"

/** Runtime-neutral envelope accepted after a provider boundary is decoded. */
export interface InboundEnvelope {
  readonly from: EmailAddress
  readonly to: EmailAddress
  readonly raw: ReadableStream<Uint8Array>
  readonly providerDelivery?: InboundProviderDelivery
  readonly claimedSizeBytes?: number
  readonly receivedAt?: DateTime.Utc
}

/** Runtime schema for bounded inbound ingestion policy. */
export const InboundConfigSchema = Schema.Struct({
  maxBytes: PositiveSafeIntegerSchema,
  digestDedupeWindowMilliseconds: OperationalDurationMillisecondsSchema,
  archiveIntentTtlMilliseconds: OperationalDurationMillisecondsSchema,
  cleanupRetryMilliseconds: OperationalDurationMillisecondsSchema,
})

/** Bounded ingestion policy configured at composition time. */
export interface InboundConfig extends Schema.Schema.Type<
  typeof InboundConfigSchema
> {}

/** Default inbound policy: 25 MiB with one-day digest and archive horizons. */
export const defaultConfig: InboundConfig = {
  maxBytes: 25 * 1024 * 1024,
  digestDedupeWindowMilliseconds: 24 * 60 * 60 * 1_000,
  archiveIntentTtlMilliseconds: 24 * 60 * 60 * 1_000,
  cleanupRetryMilliseconds: 60_000,
}

/** One inbound policy field was outside its supported range. */
export class InvalidInboundConfig extends Schema.TaggedError<
  InvalidInboundConfig
>()("InvalidInboundConfig", {
  field: Schema.Literals([
    "maxBytes",
    "digestDedupeWindowMilliseconds",
    "archiveIntentTtlMilliseconds",
    "cleanupRetryMilliseconds",
  ]),
  reason: Schema.Literals([
    "not_positive_safe_integer",
    "exceeds_supported_maximum",
  ]),
}) {}

type InboundConfigField =
  | "maxBytes"
  | "digestDedupeWindowMilliseconds"
  | "archiveIntentTtlMilliseconds"
  | "cleanupRetryMilliseconds"

const invalidInboundConfigField = (
  config: InboundConfig,
): InboundConfigField | undefined => {
  if (!isPositiveSafeInteger(config.maxBytes)) return "maxBytes"
  if (!isPositiveSafeInteger(config.digestDedupeWindowMilliseconds)) {
    return "digestDedupeWindowMilliseconds"
  }
  if (!isPositiveSafeInteger(config.archiveIntentTtlMilliseconds)) {
    return "archiveIntentTtlMilliseconds"
  }
  if (!isPositiveSafeInteger(config.cleanupRetryMilliseconds)) {
    return "cleanupRetryMilliseconds"
  }
  return undefined
}

/** Validate and detach one caller-owned inbound ingestion policy. */
export const parseInboundConfig = Effect.fn("Email.inbound.parseConfig")(
  function*(config: InboundConfig) {
    const field = invalidInboundConfigField(config)
    if (field !== undefined) {
      return yield* new InvalidInboundConfig({
        field,
        reason: "not_positive_safe_integer",
      })
    }
    if (
      config.digestDedupeWindowMilliseconds >
        MaximumOperationalDurationMilliseconds
    ) {
      return yield* new InvalidInboundConfig({
        field: "digestDedupeWindowMilliseconds",
        reason: "exceeds_supported_maximum",
      })
    }
    if (
      config.archiveIntentTtlMilliseconds >
        MaximumOperationalDurationMilliseconds
    ) {
      return yield* new InvalidInboundConfig({
        field: "archiveIntentTtlMilliseconds",
        reason: "exceeds_supported_maximum",
      })
    }
    if (
      config.cleanupRetryMilliseconds >
        MaximumOperationalDurationMilliseconds
    ) {
      return yield* new InvalidInboundConfig({
        field: "cleanupRetryMilliseconds",
        reason: "exceeds_supported_maximum",
      })
    }
    return {
      maxBytes: config.maxBytes,
      digestDedupeWindowMilliseconds:
        config.digestDedupeWindowMilliseconds,
      archiveIntentTtlMilliseconds: config.archiveIntentTtlMilliseconds,
      cleanupRetryMilliseconds: config.cleanupRetryMilliseconds,
    }
  },
)

/** The actual bytes read exceeded the configured hard limit. */
export class InboundMessageTooLarge extends Schema.TaggedError<
  InboundMessageTooLarge
>()("InboundMessageTooLarge", {
  limitBytes: Schema.Number,
  observedBytes: Schema.Number,
}) {}

/** The raw provider stream could not be read completely. */
export class InboundMimeReadFailure extends Schema.TaggedError<
  InboundMimeReadFailure
>()("InboundMimeReadFailure", {
  reason: Schema.Literal("stream_failed"),
}) {}

/** Raw MIME could not be parsed safely. */
export class InvalidInboundMime extends Schema.TaggedError<InvalidInboundMime>()(
  "InvalidInboundMime",
  { reason: Schema.Literal("parse_failed") },
) {}

/** No route owns the recipient address at the provider boundary. */
export class InboundRouteNotFound extends Schema.TaggedError<
  InboundRouteNotFound
>()("InboundRouteNotFound", {
  reason: Schema.Literal("not_found"),
}) {}

/** A reserved route rejects inbound delivery in its present lifecycle. */
export class InboundRouteInactive extends Schema.TaggedError<
  InboundRouteInactive
>()("InboundRouteInactive", {
  reason: Schema.Literals(["paused", "disabled"]),
}) {}

/** An R2 orphan could neither be removed nor durably queued for cleanup. */
export class InboundCompensationFailure extends Schema.TaggedError<
  InboundCompensationFailure
>()("InboundCompensationFailure", {
  reason: Schema.Literal("cleanup_unrecorded"),
}) {}

/** Public typed failures from awaited inbound ingestion. */
export type InboundError =
  | ContentDigestFailure
  | InboundCompensationFailure
  | InboundMessageTooLarge
  | InboundMimeReadFailure
  | InboundRouteInactive
  | InboundRouteNotFound
  | InboundStoreFailure
  | InvalidInboundMime
  | RawMessageArchiveFailure
  | RouteStoreFailure

const hasNoControl = (value: string): boolean =>
  Array.from(value).every((character) => {
    const code = character.charCodeAt(0)
    return code >= 32 && code !== 127
  })

const sanitizeSubject = (value: string | undefined): string | null => {
  if (value === undefined) return null
  return value.replace(/[\r\n]+/gu, " ").slice(0, 998)
}

const sanitizeMessageId = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 998 && hasNoControl(trimmed)
    ? trimmed
    : undefined
}

const readBounded = (
  stream: ReadableStream<Uint8Array>,
  limitBytes: number,
): Effect.Effect<Uint8Array, InboundMessageTooLarge | InboundMimeReadFailure> =>
  Effect.tryPromise({
    try: async (signal) => {
      const reader = stream.getReader()
      const chunks: Array<Uint8Array> = []
      let total = 0
      const cancel = (): void => {
        void reader.cancel("inbound ingestion cancelled")
      }
      signal.addEventListener("abort", cancel, { once: true })
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          total += next.value.byteLength
          if (total > limitBytes) {
            await reader.cancel("inbound message exceeds byte limit")
            throw new InboundMessageTooLarge({
              limitBytes,
              observedBytes: total,
            })
          }
          chunks.push(next.value)
        }
      } finally {
        signal.removeEventListener("abort", cancel)
        reader.releaseLock()
      }
      const content = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        content.set(chunk, offset)
        offset += chunk.byteLength
      }
      return content
    },
    catch: (cause) =>
      cause instanceof InboundMessageTooLarge
        ? cause
        : new InboundMimeReadFailure({ reason: "stream_failed" }),
  })

const parseMime = (
  raw: Uint8Array,
): Effect.Effect<Awaited<ReturnType<typeof PostalMime.parse>>, InvalidInboundMime> =>
  Effect.tryPromise({
    try: () => PostalMime.parse(raw, {
      attachmentEncoding: "arraybuffer",
      maxNestingDepth: 20,
      maxHeadersSize: 256 * 1024,
    }),
    catch: () => new InvalidInboundMime({ reason: "parse_failed" }),
  })

/** Durable outcome of one ingestion: the message and whether it already existed. */
export interface InboundReceipt {
  readonly message: InboundMessage
  readonly replayed: boolean
}

/** Effect service that fully awaits raw archival and metadata/outbox commit. */
export class InboundService extends Context.Service<InboundService, {
  readonly ingest: (
    input: InboundEnvelope,
  ) => Effect.Effect<InboundMessage, InboundError>
  readonly receive: (
    input: InboundEnvelope,
  ) => Effect.Effect<InboundReceipt, InboundError>
}>()("@popcomputer/email/InboundService") {}

type InboundServiceDependencies =
  | ContentDigest
  | IdentifierGenerator
  | InboundStore
  | RawMessageArchive
  | RouteStore

const layerFromParsedConfig = (
  config: InboundConfig,
): Layer.Layer<
  InboundService,
  never,
  InboundServiceDependencies
> => Layer.effect(
  InboundService,
  Effect.gen(function*() {
    const digest = yield* ContentDigest
    const identifiers = yield* IdentifierGenerator
    const inboundStore = yield* InboundStore
    const archive = yield* RawMessageArchive
    const routes = yield* RouteStore

    const receive = Effect.fn("Email.inbound.receive")(function*(
      input: InboundEnvelope,
    ): Effect.fn.Return<InboundReceipt, InboundError> {
      if (
        input.claimedSizeBytes !== undefined &&
        input.claimedSizeBytes > config.maxBytes
      ) {
        return yield* new InboundMessageTooLarge({
          limitBytes: config.maxBytes,
          observedBytes: input.claimedSizeBytes,
        })
      }

      const routeOption = yield* routes.findByInboundAddress(input.to)
      if (Option.isNone(routeOption)) {
        return yield* new InboundRouteNotFound({ reason: "not_found" })
      }
      const route = routeOption.value
      if (!isActive(route)) {
        return yield* new InboundRouteInactive({
          reason: route.lifecycle._tag === "Paused" ? "paused" : "disabled",
        })
      }

      const providerDuplicateKey = input.providerDelivery === undefined
        ? undefined
        : {
            _tag: "Provider" as const,
            scope: route.scope,
            routeId: route.id,
            provider: input.providerDelivery.provider,
            deliveryId: input.providerDelivery.deliveryId,
          }
      if (providerDuplicateKey !== undefined) {
        const providerDuplicate = yield* inboundStore.findDuplicate(
          providerDuplicateKey,
        )
        if (Option.isSome(providerDuplicate)) {
          return { message: providerDuplicate.value, replayed: true }
        }
      }

      const raw = yield* readBounded(input.raw, config.maxBytes)
      const parsed = yield* parseMime(raw)
      const rawSha256 = yield* digest.sha256(raw)
      const rfcMessageId = sanitizeMessageId(parsed.messageId)
      const observedAt = yield* DateTime.now
      const receivedAt = input.receivedAt ?? observedAt
      const duplicateKey = providerDuplicateKey === undefined
        ? {
            _tag: "Digest" as const,
            scope: route.scope,
            routeId: route.id,
            envelopeFrom: input.from,
            rawSha256,
            observedAt,
            expiresAt: DateTime.addDuration(
              observedAt,
              config.digestDedupeWindowMilliseconds,
            ),
          }
        : providerDuplicateKey
      const duplicate = yield* inboundStore.findDuplicate(duplicateKey)
      if (Option.isSome(duplicate)) {
        return { message: duplicate.value, replayed: true }
      }

      const messageId = yield* identifiers.messageId
      const recipientId = yield* identifiers.recipientId
      const eventId = route.inbound._tag === "Trigger"
        ? yield* identifiers.workflowEventId
        : undefined
      const subject = sanitizeSubject(parsed.subject)
      const to: readonly [EmailAddress] = [input.to]

      const commonMessage = {
        id: messageId,
        scope: route.scope,
        routeId: route.id,
        from: input.from,
        to,
        subject,
        sizeBytes: raw.byteLength,
        receivedAt,
        createdAt: observedAt,
        updatedAt: observedAt,
      }
      const messageWithRfc = rfcMessageId === undefined
        ? commonMessage
        : { ...commonMessage, rfcMessageId }
      const message = route.inbound._tag === "Trigger" && eventId !== undefined
        ? MessageSchema.cases.Inbound.make({
            ...messageWithRfc,
            workflowId: route.inbound.workflowId,
            state: MessageSchema.cases.Inbound.fields.state.cases
              .WorkflowEventCreated.make({ eventId }),
          })
        : MessageSchema.cases.Inbound.make({
            ...messageWithRfc,
            state: MessageSchema.cases.Inbound.fields.state.cases.Received.make({}),
          })
      const recipient = MessageRecipientSchema.make({
        id: recipientId,
        messageId,
        kind: "to",
        address: input.to,
        status: "delivered",
        createdAt: observedAt,
        updatedAt: observedAt,
      })
      const workflowEvent = route.inbound._tag === "Trigger" && eventId !== undefined
        ? WorkflowEventSchema.make({
            event: {
              schemaVersion: 1,
              type: "email.received",
              eventId,
              occurredAt: receivedAt,
              scope: route.scope,
              workflowId: route.inbound.workflowId,
              message: {
                id: messageId,
                routeId: route.id,
                from: input.from,
                to: [input.to],
                subject,
                sizeBytes: raw.byteLength,
                receivedAt,
              },
            },
            state: WorkflowEventSchema.fields.state.cases.Pending.make({
              nextAttemptAt: observedAt,
            }),
            createdAt: observedAt,
            updatedAt: observedAt,
          })
        : undefined

      const archiveInput = {
        scope: route.scope,
        direction: "inbound" as const,
        messageId,
        content: raw,
        sha256: rawSha256,
      }
      const rawRef = yield* archive.referenceFor(archiveInput)

      yield* inboundStore.createArchiveIntent({
        messageId,
        scope: route.scope,
        rawSha256,
        rawRef,
        expiresAt: DateTime.addDuration(
          observedAt,
          config.archiveIntentTtlMilliseconds,
        ),
        now: observedAt,
      })

      const writtenRef = yield* archive.put(archiveInput)
      if (writtenRef !== rawRef) {
        return yield* new RawMessageArchiveFailure({
          operation: "put",
          reason: "unavailable",
        })
      }

      const cleanup = (): Effect.Effect<void, InboundCompensationFailure> =>
        archive.remove(rawRef).pipe(
          Effect.flatMap(() =>
            inboundStore.deleteArchiveIntent(route.scope, messageId)),
          Effect.catch(() =>
            DateTime.now.pipe(
              Effect.flatMap((cleanupObservedAt) =>
                inboundStore.markArchiveCleanup({
                  messageId,
                  scope: route.scope,
                  rawRef,
                  safeErrorCode: "archive_remove_failed",
                  now: cleanupObservedAt,
                  nextAttemptAt: DateTime.addDuration(
                    cleanupObservedAt,
                    config.cleanupRetryMilliseconds,
                  ),
                })),
              Effect.mapError(() =>
                new InboundCompensationFailure({
                  reason: "cleanup_unrecorded",
                })),
            )),
        )

      const descriptor = RawMimeDescriptorSchema.make({
        scope: route.scope,
        direction: "inbound",
        messageId,
        ref: rawRef,
        sha256: rawSha256,
        sizeBytes: raw.byteLength,
      })
      const committed = yield* inboundStore.commit({
        duplicateKey,
        message,
        recipient,
        raw: descriptor,
        workflowEvent,
      })
      if (committed._tag === "Existing") {
        yield* cleanup()
        return { message: committed.message, replayed: true }
      }
      return { message: committed.message, replayed: false }
    })

    const provided = (input: InboundEnvelope) => receive(input).pipe(
      Effect.provideService(ContentDigest, digest),
      Effect.provideService(IdentifierGenerator, identifiers),
      Effect.provideService(InboundStore, inboundStore),
      Effect.provideService(RawMessageArchive, archive),
      Effect.provideService(RouteStore, routes),
    )

    return InboundService.of({
      ingest: (input) => provided(input).pipe(
        Effect.map((receipt) => receipt.message),
      ),
      receive: provided,
    })
  }),
)

/** Build inbound ingestion with the conservative package defaults. */
export function layer(): Layer.Layer<
  InboundService,
  never,
  InboundServiceDependencies
>

/** Validate and build inbound ingestion with an explicit byte/archive policy. */
export function layer(
  config: InboundConfig,
): Layer.Layer<
  InboundService,
  InvalidInboundConfig,
  InboundServiceDependencies
>

export function layer(
  config?: InboundConfig,
): Layer.Layer<
  InboundService,
  InvalidInboundConfig,
  InboundServiceDependencies
> {
  if (config === undefined) return layerFromParsedConfig(defaultConfig)
  return Layer.unwrap(
    parseInboundConfig(config).pipe(Effect.map(layerFromParsedConfig)),
  )
}
