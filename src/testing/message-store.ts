import { DateTime, Effect, Layer, Option, Schema } from "effect"
import {
  DefaultPageSize,
  InvalidPageRequest,
  MaximumPageSize,
  PageCursorSchema,
} from "../core/identifiers.js"
import {
  MessageStore,
  MessageTransitionConflict,
  type ArchivedRawMessage,
  type CreateOutboundArchiveIntentInput,
  type FinalizeOutboundInput,
  type StoredMessage,
  type StoredOutboundMessage,
} from "../adapters/message-store.js"
import {
  claimForSending,
  failAfterHandoff,
  failBeforeHandoff,
  isReserved,
  isSending,
  markAccepted,
  markCaptured,
  markDeliveryUnknown,
  markPartiallyAccepted,
  MessageRecipientSchema,
  PartialRecipientOutcomesSchema,
  InvalidStoredMessage,
  type MessageRecipient,
  type OutboundMessage,
  type RecipientStatus,
  type SendingOutboundMessage,
} from "../core/message.js"
import type { Scope } from "../core/scope.js"

const scopeKey = (scope: Scope): string =>
  `${scope.namespace}\u0000${scope.environment}`

const recordKey = (scope: Scope, id: string): string =>
  `${scopeKey(scope)}\u0000${id}`

const idempotencyKey = (message: OutboundMessage): string =>
  `${scopeKey(message.scope)}\u0000${message.idempotencyKey}`

const updateRecipients = (
  recipients: ReadonlyArray<MessageRecipient>,
  input: FinalizeOutboundInput,
): ReadonlyArray<MessageRecipient> => {
  const statusByAddress = new Map<string, RecipientStatus>()
  const finalization = input.finalization
  switch (finalization._tag) {
    case "Captured":
      return recipients.map((recipient) => ({
        ...recipient,
        status: "captured",
        updatedAt: finalization.capturedAt,
      }))
    case "Accepted":
    case "PartiallyAccepted":
      for (const outcome of finalization.outcomes) {
        statusByAddress.set(
          outcome.address,
          outcome._tag === "Accepted" ? "queued" : "failed",
        )
      }
      return recipients.map((recipient) => ({
        ...recipient,
        status: statusByAddress.get(recipient.address) ?? "queued",
        updatedAt: finalization.sentAt,
      }))
    case "Failed":
      return finalization.reason === "provider_rejected"
        ? recipients.map((recipient) => ({
            ...recipient,
            status: "failed",
            updatedAt: finalization.failedAt,
          }))
        : recipients
    case "DeliveryUnknown":
      return recipients
  }
}

const finalize = (
  message: OutboundMessage,
  input: FinalizeOutboundInput,
): Effect.Effect<OutboundMessage, MessageTransitionConflict> => {
  const conflict = (): MessageTransitionConflict =>
    new MessageTransitionConflict({
      messageId: message.id,
      reason: "concurrent_update",
    })
  switch (input.finalization._tag) {
    case "Captured":
      return isSending(message)
        ? Effect.succeed(markCaptured(message, input.finalization.capturedAt))
        : Effect.fail(conflict())
    case "Accepted":
      return isSending(message)
        ? Effect.succeed(markAccepted(
            message,
            input.finalization.providerMessageId === undefined
              ? { sentAt: input.finalization.sentAt }
              : {
                  sentAt: input.finalization.sentAt,
                  providerMessageId: input.finalization.providerMessageId,
                },
          ))
        : Effect.fail(conflict())
    case "PartiallyAccepted":
      if (!isSending(message)) return Effect.fail(conflict())
      return Effect.succeed(markPartiallyAccepted(
        message,
        input.finalization.providerMessageId === undefined
          ? {
              sentAt: input.finalization.sentAt,
              outcomes: Schema.decodeUnknownSync(
                PartialRecipientOutcomesSchema,
              )(input.finalization.outcomes),
            }
          : {
              sentAt: input.finalization.sentAt,
              providerMessageId: input.finalization.providerMessageId,
              outcomes: Schema.decodeUnknownSync(
                PartialRecipientOutcomesSchema,
              )(input.finalization.outcomes),
            },
      ))
    case "DeliveryUnknown":
      return isSending(message)
        ? Effect.succeed(markDeliveryUnknown(message, {
            occurredAt: input.finalization.occurredAt,
            reason: input.finalization.reason,
          }))
        : Effect.fail(conflict())
    case "Failed":
      if (isReserved(message) && input.finalization.reason !== "provider_rejected") {
        return Effect.succeed(failBeforeHandoff(message, {
          failedAt: input.finalization.failedAt,
          reason: input.finalization.reason,
        }))
      }
      if (isSending(message) && input.finalization.reason !== "archive") {
        return Effect.succeed(failAfterHandoff(message, {
          failedAt: input.finalization.failedAt,
          reason: input.finalization.reason,
        }))
      }
      return Effect.fail(conflict())
  }
}

/** Inspectable in-memory implementation of the production MessageStore port. */
export interface InMemoryMessageStore {
  readonly service: MessageStore["Service"]
  readonly records: ReadonlyArray<StoredMessage>
  readonly archiveIntents: ReadonlyArray<CreateOutboundArchiveIntentInput>
  readonly seed: (record: StoredMessage) => void
  readonly layer: Layer.Layer<MessageStore>
}

/** Create an isolated, synchronous-CAS message store for behavior tests. */
export const makeInMemoryMessageStore = (): InMemoryMessageStore => {
  const byId = new Map<string, StoredMessage>()
  const byIdempotency = new Map<string, StoredOutboundMessage>()
  const archiveIntents = new Map<string, CreateOutboundArchiveIntentInput>()

  const rawMatches = (
    left: ArchivedRawMessage,
    right: ArchivedRawMessage,
  ): boolean =>
    left.ref === right.ref &&
    left.sha256 === right.sha256 &&
    left.sizeBytes === right.sizeBytes

  const saveOutbound = (record: StoredOutboundMessage): StoredOutboundMessage => {
    byId.set(recordKey(record.message.scope, record.message.id), record)
    byIdempotency.set(idempotencyKey(record.message), record)
    return record
  }

  const service = MessageStore.of({
    findOutboundByIdempotency: (input) => Effect.sync(() =>
      {
        const found = byIdempotency.get(
          `${scopeKey(input.scope)}\u0000${input.idempotencyKey}`,
        )
        return found === undefined ? Option.none() : Option.some(found)
      }),
    reserveOutbound: (input) => Effect.sync(() => {
      const existing = byIdempotency.get(idempotencyKey(input.message))
      if (existing !== undefined) {
        return { _tag: "Existing" as const, record: existing }
      }
      const recipients = input.recipients.map((recipient) =>
        MessageRecipientSchema.make({
          ...recipient,
          messageId: input.message.id,
          status: "pending",
          createdAt: input.message.createdAt,
          updatedAt: input.message.createdAt,
        }))
      const record: StoredOutboundMessage = {
        message: input.message,
        recipients,
        raw: Option.none(),
      }
      saveOutbound(record)
      return { _tag: "Created" as const, record }
    }),
    createOutboundArchiveIntent: (input) => Effect.gen(function*() {
      const key = recordKey(input.scope, input.messageId)
      const existing = byId.get(key)
      if (existing === undefined || existing.message._tag !== "Outbound") {
        return yield* new MessageTransitionConflict({
          messageId: input.messageId,
          reason: "concurrent_update",
        })
      }
      if (Option.isSome(existing.raw)) {
        if (rawMatches(existing.raw.value, input.raw)) return
        return yield* new MessageTransitionConflict({
          messageId: input.messageId,
          reason: "concurrent_update",
        })
      }
      if (!isReserved(existing.message)) {
        return yield* new MessageTransitionConflict({
          messageId: input.messageId,
          reason: "concurrent_update",
        })
      }
      const intent = archiveIntents.get(key)
      if (intent !== undefined && !rawMatches(intent.raw, input.raw)) {
        return yield* new MessageTransitionConflict({
          messageId: input.messageId,
          reason: "concurrent_update",
        })
      }
      archiveIntents.set(key, input)
    }),
    attachOutboundRaw: (input) => Effect.gen(function*() {
      const key = recordKey(input.scope, input.messageId)
      const existing = byId.get(key)
      if (existing === undefined || existing.message._tag !== "Outbound") {
        return yield* new MessageTransitionConflict({
          messageId: input.messageId,
          reason: "concurrent_update",
        })
      }
      const outbound: StoredOutboundMessage = {
        ...existing,
        message: existing.message,
      }
      if (Option.isSome(existing.raw)) {
        if (!rawMatches(existing.raw.value, input.raw)) {
          return yield* new MessageTransitionConflict({
            messageId: input.messageId,
            reason: "concurrent_update",
          })
        }
        return outbound
      }
      const intent = archiveIntents.get(key)
      if (
        intent === undefined ||
        !isReserved(existing.message) ||
        !rawMatches(intent.raw, input.raw)
      ) {
        return yield* new MessageTransitionConflict({
          messageId: input.messageId,
          reason: "concurrent_update",
        })
      }
      const saved = saveOutbound({ ...outbound, raw: Option.some(input.raw) })
      archiveIntents.delete(key)
      return saved
    }),
    claimOutbound: (input) => Effect.gen(function*() {
      const existing = byId.get(recordKey(input.scope, input.messageId))
      if (existing === undefined || existing.message._tag !== "Outbound") {
        return yield* new InvalidStoredMessage({ reason: "invalid_state" })
      }
      const outbound: StoredOutboundMessage = {
        ...existing,
        message: existing.message,
      }
      if (!isReserved(outbound.message)) {
        return { _tag: "NotClaimed" as const, record: outbound }
      }
      const record: StoredOutboundMessage & {
        readonly message: SendingOutboundMessage
      } = {
        ...outbound,
        message: claimForSending(outbound.message, input.claimedAt),
      }
      saveOutbound(record)
      return { _tag: "Claimed" as const, record }
    }),
    finalizeOutbound: (input) => Effect.gen(function*() {
      const existing = byId.get(recordKey(input.scope, input.messageId))
      if (existing === undefined || existing.message._tag !== "Outbound") {
        return yield* new MessageTransitionConflict({
          messageId: input.messageId,
          reason: "concurrent_update",
        })
      }
      const outbound: StoredOutboundMessage = {
        ...existing,
        message: existing.message,
      }
      const message = yield* finalize(outbound.message, input)
      return saveOutbound({
        ...outbound,
        message,
        recipients: updateRecipients(existing.recipients, input),
      })
    }),
    get: (input) => Effect.sync(() =>
      {
        const found = byId.get(recordKey(input.scope, input.messageId))
        return found === undefined ? Option.none() : Option.some(found)
      }),
    list: (input) => Effect.gen(function*() {
      const limit = input.limit ?? DefaultPageSize
      if (!Number.isInteger(limit) || limit < 1 || limit > MaximumPageSize) {
        return yield* new InvalidPageRequest({ reason: "invalid_limit" })
      }
      const offset = input.cursor === undefined ? 0 : Number(input.cursor)
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        (input.cursor !== undefined && String(offset) !== input.cursor)
      ) {
        return yield* new InvalidPageRequest({ reason: "invalid_cursor" })
      }
      const all = Array.from(byId.values())
        .filter((record) =>
          scopeKey(record.message.scope) === scopeKey(input.scope) &&
          (input.direction === undefined ||
            record.message._tag.toLowerCase() === input.direction))
        .sort((left, right) => {
          const byTime = DateTime.toEpochMillis(right.message.createdAt) -
            DateTime.toEpochMillis(left.message.createdAt)
          return byTime === 0
            ? right.message.id.localeCompare(left.message.id)
            : byTime
        })
      const items = all.slice(offset, offset + limit)
      const next = offset + items.length
      return {
        items,
        nextCursor: next < all.length
          ? Option.some(PageCursorSchema.make(String(next)))
          : Option.none(),
      }
    }),
  })

  return {
    service,
    get records() {
      return Array.from(byId.values())
    },
    get archiveIntents() {
      return Array.from(archiveIntents.values())
    },
    seed: (record) => {
      byId.set(recordKey(record.message.scope, record.message.id), record)
      if (record.message._tag === "Outbound") {
        byIdempotency.set(idempotencyKey(record.message), {
          ...record,
          message: record.message,
        })
      }
    },
    layer: Layer.succeed(MessageStore, service),
  }
}
