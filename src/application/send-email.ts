import { DateTime, Effect, Option, Result, Schema } from "effect"
import { ContentDigest, type ContentDigestFailure } from "../adapters/content-digest.js"
import { IdentifierGenerator } from "../adapters/identifier-generator.js"
import { OutboundPolicy, type OutboundPolicyFailure } from "../adapters/outbound-policy.js"
import {
  MessageStore,
  type ArchivedRawMessage,
  type MessageStoreFailure,
  type MessageTransitionConflict,
  type OutboundFinalization,
  type ReservedRecipient,
  type StoredOutboundMessage,
} from "../adapters/message-store.js"
import {
  RawMessageArchive,
  RawMessageArchiveFailure,
} from "../adapters/raw-message-archive.js"
import { RouteStore, type RouteStoreFailure } from "../adapters/route-store.js"
import {
  SendTransport,
  type SendIndeterminate,
  type SendRejected,
  type SendTransportResult,
  type SendTransportUnavailable,
} from "../adapters/send-transport.js"
import type { EmailAddress } from "../core/address.js"
import type { SendCommand } from "../core/email-command.js"
import {
  IdempotencyConflict,
  type MessageTooLarge,
  type RecipientNotPermitted,
} from "../core/email-command.js"
import type {
  IdempotencyKey,
  RequestFingerprint,
} from "../core/identifiers.js"
import {
  MessageSchema,
  OutboundStateSchema,
  type InvalidStoredMessage,
  type RecipientTransportOutcome,
  type ReservedOutboundMessage,
  isReserved,
} from "../core/message.js"
import {
  RouteInactive,
  RouteNotFound,
  RouteNotSendable,
  isSendable,
  type SendableRoute,
} from "../core/route.js"
import type { MessageDetails } from "./read-email.js"
import { fingerprintSendCommand } from "./outbound-fingerprint.js"
import { renderMime } from "./render-mime.js"

/** No non-terminal default sender exists in the command scope. */
export class DefaultSenderNotFound extends Schema.TaggedError<DefaultSenderNotFound>()(
  "DefaultSenderNotFound",
  { reason: Schema.Literal("not_found") },
) {}

/** Re-rendered MIME did not match the bytes previously attached to a reservation. */
export class NonDeterministicMime extends Schema.TaggedError<NonDeterministicMime>()(
  "NonDeterministicMime",
  { reason: Schema.Literal("archive_digest_mismatch") },
) {}

/** Expected store invariants were absent while recovering a transition race. */
export class MessageInvariantViolation extends Schema.TaggedError<MessageInvariantViolation>()(
  "MessageInvariantViolation",
  { reason: Schema.Literals(["missing_after_transition", "wrong_direction"]) },
) {}

/** Typed failures produced by the internal outbound send workflow. */
export type SendEmailFailure =
  | ContentDigestFailure
  | DefaultSenderNotFound
  | IdempotencyConflict
  | InvalidStoredMessage
  | MessageInvariantViolation
  | MessageStoreFailure
  | MessageTransitionConflict
  | NonDeterministicMime
  | MessageTooLarge
  | OutboundPolicyFailure
  | RecipientNotPermitted
  | RawMessageArchiveFailure
  | RouteInactive
  | RouteNotFound
  | RouteNotSendable
  | RouteStoreFailure
  | SendTransportUnavailable

const OutboundArchiveIntentTtlMilliseconds = 24 * 60 * 60 * 1_000

const envelopeRecipients = (
  command: SendCommand,
): readonly [EmailAddress, ...Array<EmailAddress>] => [
  ...command.to,
  ...command.cc,
  ...command.bcc,
]

const assertMatchingFingerprint = (
  record: StoredOutboundMessage,
  fingerprint: RequestFingerprint,
): Effect.Effect<StoredOutboundMessage, IdempotencyConflict> =>
  record.message.requestFingerprint === fingerprint
    ? Effect.succeed(record)
    : Effect.fail(
        new IdempotencyConflict({ reason: "fingerprint_mismatch" }),
      )

const resolveRoute = Effect.fn("Email.send.resolveRoute")(function*(
  command: SendCommand,
) {
  const routes = yield* RouteStore
  if (command.from._tag === "DefaultRoute") {
    const route = yield* routes.findDefaultSender(command.scope)
    if (Option.isNone(route)) {
      return yield* new DefaultSenderNotFound({ reason: "not_found" })
    }
    if (!isSendable(route.value)) {
      const reason = route.value.lifecycle._tag === "Paused"
        ? "paused"
        : "disabled"
      return yield* new RouteInactive({
        routeId: route.value.id,
        reason,
      })
    }
    return route.value
  }

  const route = yield* routes.findById(command.scope, command.from.routeId)
  if (Option.isNone(route)) {
    return yield* new RouteNotFound({
      routeId: command.from.routeId,
      reason: "not_found",
    })
  }
  if (route.value.outbound._tag === "Disabled") {
    return yield* new RouteNotSendable({
      routeId: route.value.id,
      reason: "outbound_disabled",
    })
  }
  if (!isSendable(route.value)) {
    return yield* new RouteInactive({
      routeId: route.value.id,
      reason: route.value.lifecycle._tag === "Paused" ? "paused" : "disabled",
    })
  }
  return route.value
})

const makeReservedRecipients = Effect.fn("Email.send.makeRecipients")(
  function*(command: SendCommand) {
    const ids = yield* IdentifierGenerator
    const first: ReservedRecipient = {
      id: yield* ids.recipientId,
      kind: "to",
      address: command.to[0],
    }
    const remaining: ReadonlyArray<Omit<ReservedRecipient, "id">> = [
      ...command.to.slice(1).map((address): Omit<ReservedRecipient, "id"> => ({
        kind: "to",
        address,
      })),
      ...command.cc.map((address): Omit<ReservedRecipient, "id"> => ({
        kind: "cc",
        address,
      })),
      ...command.bcc.map((address): Omit<ReservedRecipient, "id"> => ({
        kind: "bcc",
        address,
      })),
    ]
    const rest = yield* Effect.forEach(remaining, (recipient) =>
      Effect.map(ids.recipientId, (id): ReservedRecipient => ({
        id,
        ...recipient,
      })))
    const recipients: readonly [
      ReservedRecipient,
      ...Array<ReservedRecipient>,
    ] = [first, ...rest]
    return recipients
  },
)

const makeReservation = Effect.fn("Email.send.makeReservation")(function*(
  command: SendCommand,
  fingerprint: RequestFingerprint,
  route: SendableRoute,
) {
  const identifiers = yield* IdentifierGenerator
  const messageId = yield* identifiers.messageId
  const createdAt = yield* DateTime.now
  const rawMime = renderMime({
    messageId,
    createdAt,
    from: route.address,
    command,
  })
  const policy = yield* OutboundPolicy
  yield* policy.check({
    scope: command.scope,
    recipients: envelopeRecipients(command),
    sizeBytes: rawMime.byteLength,
  })
  const outbound = MessageSchema.cases.Outbound.make({
    id: messageId,
    scope: command.scope,
    actor: command.actor,
    idempotencyKey: command.idempotencyKey,
    requestFingerprint: fingerprint,
    routeId: route.id,
    from: route.address,
    to: command.to,
    cc: command.cc,
    bcc: command.bcc,
    subject: command.subject,
    sizeBytes: rawMime.byteLength,
    createdAt,
    updatedAt: createdAt,
    state: OutboundStateSchema.cases.Reserved.make({}),
  })
  if (!isReserved(outbound)) {
    return yield* Effect.die(
      new Error("new outbound reservation was not Reserved"),
    )
  }
  const message: ReservedOutboundMessage = outbound
  const recipients = yield* makeReservedRecipients(command)
  return { message, recipients, rawMime }
})

const hasMatchingRecipientOutcomes = (
  record: StoredOutboundMessage,
  outcomes: ReadonlyArray<RecipientTransportOutcome>,
): boolean => {
  const remainingByAddress = new Map<string, number>()
  for (const recipient of record.recipients) {
    remainingByAddress.set(
      recipient.address,
      (remainingByAddress.get(recipient.address) ?? 0) + 1,
    )
  }

  const outcomeTagByAddress = new Map<
    string,
    RecipientTransportOutcome["_tag"]
  >()
  for (const outcome of outcomes) {
    const remaining = remainingByAddress.get(outcome.address) ?? 0
    const priorTag = outcomeTagByAddress.get(outcome.address)
    if (remaining === 0 || (priorTag !== undefined && priorTag !== outcome._tag)) {
      return false
    }
    remainingByAddress.set(outcome.address, remaining - 1)
    outcomeTagByAddress.set(outcome.address, outcome._tag)
  }
  return outcomes.length === record.recipients.length &&
    Array.from(remainingByAddress.values()).every((remaining) => remaining === 0)
}

const finalizationForSuccess = (
  record: StoredOutboundMessage,
  result: SendTransportResult,
  now: DateTime.Utc,
): OutboundFinalization => {
  if (result._tag === "Captured") {
    return { _tag: "Captured", capturedAt: now }
  }
  if (!hasMatchingRecipientOutcomes(record, result.outcomes)) {
    return {
      _tag: "DeliveryUnknown",
      occurredAt: now,
      reason: "invalid_response",
    }
  }
  const accepted = result.outcomes.filter(
    (outcome) => outcome._tag === "Accepted",
  )
  const rejected = result.outcomes.filter(
    (outcome) => outcome._tag === "Rejected",
  )
  if (accepted.length > 0 && rejected.length > 0) {
    const first = result.outcomes[0]
    if (first === undefined) {
      return {
        _tag: "Failed",
        failedAt: now,
        reason: "configuration",
      }
    }
    const outcomes: readonly [
      RecipientTransportOutcome,
      ...Array<RecipientTransportOutcome>,
    ] = [first, ...result.outcomes.slice(1)]
    if (result.providerMessageId === undefined) {
      return {
        _tag: "PartiallyAccepted",
        sentAt: now,
        outcomes,
      }
    }
    return {
      _tag: "PartiallyAccepted",
      sentAt: now,
      providerMessageId: result.providerMessageId,
      outcomes,
    }
  }
  if (rejected.length > 0) {
    return {
      _tag: "Failed",
      failedAt: now,
      reason: "provider_rejected",
    }
  }
  if (result.providerMessageId === undefined) {
    return {
      _tag: "Accepted",
      sentAt: now,
      outcomes: result.outcomes,
    }
  }
  return {
    _tag: "Accepted",
    sentAt: now,
    providerMessageId: result.providerMessageId,
    outcomes: result.outcomes,
  }
}

const toMessageDetails = (record: StoredOutboundMessage): MessageDetails => ({
  message: record.message,
  recipients: record.recipients,
})

const terminalize = Effect.fn("Email.send.terminalize")(function*(
  record: StoredOutboundMessage,
  finalization: OutboundFinalization,
) {
  const store = yield* MessageStore
  return yield* store.finalizeOutbound({
    scope: record.message.scope,
    messageId: record.message.id,
    finalization,
  })
})

const terminalizeAfterHandoff = Effect.fn("Email.send.terminalizeAfterHandoff")(
  function*(
    record: StoredOutboundMessage,
    finalization: OutboundFinalization,
  ) {
    const store = yield* MessageStore
    return yield* terminalize(record, finalization).pipe(
      Effect.catchTag("MessageTransitionConflict", () =>
        store.get({
          scope: record.message.scope,
          messageId: record.message.id,
        }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new MessageInvariantViolation({
                    reason: "missing_after_transition",
                  }),
                ),
              onSome: (stored) => stored.message._tag === "Outbound"
                ? Effect.succeed({ ...stored, message: stored.message })
                : Effect.fail(
                    new MessageInvariantViolation({
                      reason: "wrong_direction",
                    }),
                  ),
            }),
          ),
        )),
      Effect.catchTag("MessageStoreFailure", (failure) =>
        DateTime.now.pipe(
          Effect.flatMap((occurredAt) =>
            terminalize(record, {
              _tag: "DeliveryUnknown",
              occurredAt,
              reason: "finalize_failed",
            })),
          Effect.catch(() => Effect.fail(failure)),
        )),
    )
  },
)

const archive = Effect.fn("Email.send.archive")(function*(
  record: StoredOutboundMessage,
  rawMime: Uint8Array,
) {
  const digest = yield* ContentDigest
  const archiveService = yield* RawMessageArchive
  const store = yield* MessageStore
  const sha256 = yield* digest.sha256(rawMime)
  if (Option.isSome(record.raw)) {
    if (
      record.raw.value.sha256 !== sha256 ||
      record.raw.value.sizeBytes !== rawMime.byteLength
    ) {
      return yield* new NonDeterministicMime({
        reason: "archive_digest_mismatch",
      })
    }
    return record
  }

  const archiveInput = {
    scope: record.message.scope,
    direction: "outbound" as const,
    messageId: record.message.id,
    content: rawMime,
    sha256,
  }
  const ref = yield* archiveService.referenceFor(archiveInput)
  const raw: ArchivedRawMessage = {
    ref,
    sha256,
    sizeBytes: rawMime.byteLength,
  }
  const now = yield* DateTime.now
  yield* store.createOutboundArchiveIntent({
    scope: record.message.scope,
    messageId: record.message.id,
    raw,
    expiresAt: DateTime.addDuration(
      now,
      OutboundArchiveIntentTtlMilliseconds,
    ),
    now,
  })
  const writtenRef = yield* archiveService.put(archiveInput)
  if (writtenRef !== ref) {
    return yield* new RawMessageArchiveFailure({
      operation: "put",
      reason: "unavailable",
    })
  }
  return yield* store.attachOutboundRaw({
    scope: record.message.scope,
    messageId: record.message.id,
    raw,
  })
})

const deliver = Effect.fn("Email.send.deliver")(function*(
  record: StoredOutboundMessage,
  rawMime: Uint8Array,
) {
  const store = yield* MessageStore
  const transport = yield* SendTransport
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function*() {
      const claimedAt = yield* DateTime.now
      const claim = yield* store.claimOutbound({
        scope: record.message.scope,
        messageId: record.message.id,
        claimedAt,
      })
      if (claim._tag === "NotClaimed") return toMessageDetails(claim.record)

      const cancellationFinalizer = DateTime.now.pipe(
        Effect.flatMap((occurredAt) =>
          terminalize(claim.record, {
            _tag: "DeliveryUnknown",
            occurredAt,
            reason: "cancelled",
          })),
        Effect.asVoid,
      )
      const attempted = yield* restore(
        Effect.result(
          transport.send({
            scope: claim.record.message.scope,
            messageId: claim.record.message.id,
            from: claim.record.message.from,
            to: claim.record.message.to,
            cc: claim.record.message.cc,
            bcc: claim.record.message.bcc,
            rawMime,
          }),
        ).pipe(Effect.onInterrupt(() => cancellationFinalizer)),
      )
      const completedAt = yield* DateTime.now
      if (Result.isSuccess(attempted)) {
        const finalized = yield* terminalizeAfterHandoff(
          claim.record,
          finalizationForSuccess(claim.record, attempted.success, completedAt),
        )
        return toMessageDetails(finalized)
      }
      const failure: SendRejected | SendIndeterminate = attempted.failure
      const finalization: OutboundFinalization = failure._tag === "SendRejected"
        ? {
            _tag: "Failed",
            failedAt: completedAt,
            reason: "provider_rejected",
          }
        : {
            _tag: "DeliveryUnknown",
            occurredAt: completedAt,
            reason: failure.reason,
          }
      const finalized = yield* terminalizeAfterHandoff(
        claim.record,
        finalization,
      )
      return toMessageDetails(finalized)
    }),
  )
})

const resumeReserved = Effect.fn("Email.send.resumeReserved")(function*(
  command: SendCommand,
  record: StoredOutboundMessage,
) {
  if (record.message.state._tag !== "Reserved") return toMessageDetails(record)
  const rawMime = renderMime({
    messageId: record.message.id,
    createdAt: record.message.createdAt,
    from: record.message.from,
    command,
  })
  const policy = yield* OutboundPolicy
  const transport = yield* SendTransport
  yield* policy.check({
    scope: command.scope,
    recipients: envelopeRecipients(command),
    sizeBytes: rawMime.byteLength,
  })
  yield* transport.preflight({
    scope: command.scope,
    from: record.message.from,
    recipientCount: envelopeRecipients(command).length,
    sizeBytes: rawMime.byteLength,
  })
  const archived = yield* archive(record, rawMime)
  return yield* deliver(archived, rawMime)
})

type OutboundDependencies =
  | ContentDigest
  | IdentifierGenerator
  | MessageStore
  | OutboundPolicy
  | RawMessageArchive
  | RouteStore
  | SendTransport

/** Lazy preparation used to share durable send semantics with derived actions. */
export interface ExecuteOutboundInput<E, R> {
  readonly scope: import("../core/scope.js").Scope
  readonly idempotencyKey: IdempotencyKey
  readonly fingerprint: RequestFingerprint
  readonly prepare: Effect.Effect<SendCommand, E, R>
}

/**
 * Execute a fingerprinted outbound mutation, preparing derived content only
 * when a new or unfinished reservation actually requires it.
 */
export const executeOutbound = <E, R>(
  input: ExecuteOutboundInput<E, R>,
): Effect.Effect<
  MessageDetails,
  E | SendEmailFailure,
  OutboundDependencies | R
> =>
  Effect.gen(function*() {
    const store = yield* MessageStore
    const transport = yield* SendTransport
    const existing = yield* store.findOutboundByIdempotency({
      scope: input.scope,
      idempotencyKey: input.idempotencyKey,
    })
    if (Option.isSome(existing)) {
      const matching = yield* assertMatchingFingerprint(
        existing.value,
        input.fingerprint,
      )
      if (matching.message.state._tag !== "Reserved") {
        return toMessageDetails(matching)
      }
      const command = yield* input.prepare
      if (
        command.scope.namespace !== input.scope.namespace ||
        command.scope.environment !== input.scope.environment ||
        command.idempotencyKey !== input.idempotencyKey
      ) {
        return yield* Effect.die(
          new Error("outbound preparation changed mutation identity"),
        )
      }
      return yield* resumeReserved(command, matching)
    }

    const command = yield* input.prepare
    if (
      command.scope.namespace !== input.scope.namespace ||
      command.scope.environment !== input.scope.environment ||
      command.idempotencyKey !== input.idempotencyKey
    ) {
      return yield* Effect.die(
        new Error("outbound preparation changed mutation identity"),
      )
    }
    const route = yield* resolveRoute(command)
    const reservation = yield* makeReservation(
      command,
      input.fingerprint,
      route,
    )
    yield* transport.preflight({
      scope: command.scope,
      from: route.address,
      recipientCount:
        command.to.length + command.cc.length + command.bcc.length,
      sizeBytes: reservation.rawMime.byteLength,
    })
    const reserved = yield* store.reserveOutbound({
      message: reservation.message,
      recipients: reservation.recipients,
    })
    const matching = yield* assertMatchingFingerprint(
      reserved.record,
      input.fingerprint,
    )
    return yield* resumeReserved(command, matching)
  }).pipe(Effect.withSpan("Email.executeOutbound"))

/** Execute one parsed, scoped, idempotent outbound command. */
export const sendEmail = Effect.fn("Email.send")(function*(
  command: SendCommand,
): Effect.fn.Return<
  MessageDetails,
  SendEmailFailure,
  OutboundDependencies
> {
  const fingerprint = yield* fingerprintSendCommand(command)
  return yield* executeOutbound({
    scope: command.scope,
    idempotencyKey: command.idempotencyKey,
    fingerprint,
    prepare: Effect.succeed(command),
  })
})
