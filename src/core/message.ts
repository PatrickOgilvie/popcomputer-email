import { DateTime, Schema } from "effect"
import { ActorSchema } from "./actor.js"
import { EmailAddressSchema } from "./address.js"
import {
  IdempotencyKeySchema,
  MessageIdSchema,
  ProviderMessageIdSchema,
  RecipientIdSchema,
  RequestFingerprintSchema,
  RouteIdSchema,
  WorkflowEventIdSchema,
  WorkflowIdSchema,
} from "./identifiers.js"
import { ScopeSchema } from "./scope.js"

const NaturalBytesSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
)

const hasNoAsciiControlCharacters = (value: string): boolean =>
  Array.from(value).every((character) => {
    const code = character.charCodeAt(0)
    return code >= 32 && code !== 127
  })

const OptionalProviderMessageIdField = Schema.optionalKey(
  ProviderMessageIdSchema,
)

/** Direction in which a message crossed the email-service boundary. */
export const DirectionSchema = Schema.Literals(["inbound", "outbound"])

/** Direction in which a message crossed the email-service boundary. */
export type Direction = typeof DirectionSchema.Type

/** Envelope role of one persisted message recipient. */
export const RecipientKindSchema = Schema.Literals(["to", "cc", "bcc"])

/** Envelope role of one persisted message recipient. */
export type RecipientKind = typeof RecipientKindSchema.Type

/** Provider-observable lifecycle of one message recipient. */
export const RecipientStatusSchema = Schema.Literals([
  "pending",
  "captured",
  "queued",
  "delivered",
  "permanent_bounce",
  "failed",
])

/** Provider-observable lifecycle of one message recipient. */
export type RecipientStatus = typeof RecipientStatusSchema.Type

/** Persisted recipient associated with one email message. */
export const MessageRecipientSchema = Schema.Struct({
  id: RecipientIdSchema,
  messageId: MessageIdSchema,
  kind: RecipientKindSchema,
  address: EmailAddressSchema,
  status: RecipientStatusSchema,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
})

/** Persisted recipient associated with one email message. */
export interface MessageRecipient extends Schema.Schema.Type<
  typeof MessageRecipientSchema
> {}

/** Per-recipient outcome returned by an outbound transport. */
export const RecipientTransportOutcomeSchema = Schema.TaggedUnion({
  Accepted: { address: EmailAddressSchema },
  Rejected: {
    address: EmailAddressSchema,
    reasonCode: Schema.optionalKey(
      Schema.Trimmed.check(
        Schema.isNonEmpty(),
        Schema.isMaxLength(100),
        Schema.isPattern(/^[A-Za-z0-9._:-]+$/u),
      ),
    ),
  },
})

/** Per-recipient outcome returned by an outbound transport. */
export type RecipientTransportOutcome =
  typeof RecipientTransportOutcomeSchema.Type

/** Mixed accepted and rejected recipient outcomes for a partial send. */
export const PartialRecipientOutcomesSchema = Schema.NonEmptyArray(
  RecipientTransportOutcomeSchema,
).check(
  Schema.makeFilter(
    (outcomes) =>
      outcomes.some((outcome) => outcome._tag === "Accepted") &&
      outcomes.some((outcome) => outcome._tag === "Rejected"),
    { title: "PartiallyAcceptedRecipientOutcomes" },
  ),
).pipe(Schema.brand("EmailPartialRecipientOutcomes"))

/** Mixed accepted and rejected recipient outcomes for a partial send. */
export type PartialRecipientOutcomes =
  typeof PartialRecipientOutcomesSchema.Type

/** Durable lifecycle state of an outbound message. */
export const OutboundStateSchema = Schema.TaggedUnion({
  Reserved: {},
  Sending: { claimedAt: Schema.DateTimeUtc },
  Captured: { capturedAt: Schema.DateTimeUtc },
  Accepted: {
    sentAt: Schema.DateTimeUtc,
    providerMessageId: OptionalProviderMessageIdField,
  },
  PartiallyAccepted: {
    sentAt: Schema.DateTimeUtc,
    providerMessageId: OptionalProviderMessageIdField,
    outcomes: PartialRecipientOutcomesSchema,
  },
  DeliveryUnknown: {
    occurredAt: Schema.DateTimeUtc,
    reason: Schema.Literals([
      "network",
      "timeout",
      "cancelled",
      "crash_recovery",
      "finalize_failed",
      "invalid_response",
    ]),
  },
  Failed: {
    failedAt: Schema.DateTimeUtc,
    reason: Schema.Literals([
      "archive",
      "provider_rejected",
      "configuration",
    ]),
  },
})

/** Durable lifecycle state of an outbound message. */
export type OutboundState = typeof OutboundStateSchema.Type

/** Outbound state before one worker has claimed the provider handoff. */
export type ReservedOutboundState =
  typeof OutboundStateSchema.cases.Reserved.Type

/** Outbound state whose provider handoff is exclusively claimed. */
export type SendingOutboundState =
  typeof OutboundStateSchema.cases.Sending.Type

/** Durable lifecycle state of an inbound message. */
export const InboundStateSchema = Schema.TaggedUnion({
  Received: {},
  WorkflowEventCreated: { eventId: WorkflowEventIdSchema },
})

/** Durable lifecycle state of an inbound message. */
export type InboundState = typeof InboundStateSchema.Type

/** Parsed email message returned by package services. */
export const MessageSchema = Schema.TaggedUnion({
  Outbound: {
    id: MessageIdSchema,
    scope: ScopeSchema,
    actor: ActorSchema,
    idempotencyKey: IdempotencyKeySchema,
    requestFingerprint: RequestFingerprintSchema,
    routeId: RouteIdSchema,
    from: EmailAddressSchema,
    to: Schema.NonEmptyArray(EmailAddressSchema),
    cc: Schema.Array(EmailAddressSchema),
    bcc: Schema.Array(EmailAddressSchema),
    subject: Schema.String.check(
      Schema.isMaxLength(998),
      Schema.isPattern(/^[^\r\n]*$/u),
    ),
    sizeBytes: NaturalBytesSchema,
    createdAt: Schema.DateTimeUtc,
    updatedAt: Schema.DateTimeUtc,
    state: OutboundStateSchema,
  },
  Inbound: {
    id: MessageIdSchema,
    scope: ScopeSchema,
    routeId: RouteIdSchema,
    workflowId: Schema.optionalKey(WorkflowIdSchema),
    from: EmailAddressSchema,
    to: Schema.NonEmptyArray(EmailAddressSchema),
    subject: Schema.NullOr(
      Schema.String.check(
        Schema.isMaxLength(998),
        Schema.isPattern(/^[^\r\n]*$/u),
      ),
    ),
    rfcMessageId: Schema.optionalKey(
      Schema.Trimmed.check(
        Schema.isNonEmpty(),
        Schema.isMaxLength(998),
        Schema.makeFilter(hasNoAsciiControlCharacters, {
          title: "EmailRfcMessageId",
        }),
      ),
    ),
    sizeBytes: NaturalBytesSchema,
    receivedAt: Schema.DateTimeUtc,
    createdAt: Schema.DateTimeUtc,
    updatedAt: Schema.DateTimeUtc,
    state: InboundStateSchema,
  },
})

/** Parsed email message returned by package services. */
export type Message = typeof MessageSchema.Type

/** Parsed outbound message returned by package services. */
export type OutboundMessage = typeof MessageSchema.cases.Outbound.Type

/** Parsed inbound message returned by package services. */
export type InboundMessage = typeof MessageSchema.cases.Inbound.Type

/** Outbound message that has not yet been claimed for provider handoff. */
export type ReservedOutboundMessage = Omit<OutboundMessage, "state"> & {
  readonly state: ReservedOutboundState
}

/** Outbound message exclusively claimed for provider handoff. */
export type SendingOutboundMessage = Omit<OutboundMessage, "state"> & {
  readonly state: SendingOutboundState
}

/** Narrow an outbound message to the only state that may claim a send. */
export const isReserved = (
  message: OutboundMessage,
): message is ReservedOutboundMessage => message.state._tag === "Reserved"

/** Narrow an outbound message to the state that owns a provider handoff. */
export const isSending = (
  message: OutboundMessage,
): message is SendingOutboundMessage => message.state._tag === "Sending"

/** Claim a reserved message for exactly one provider handoff attempt. */
export const claimForSending = (
  message: ReservedOutboundMessage,
  claimedAt: DateTime.Utc,
): SendingOutboundMessage => ({
  ...message,
  state: OutboundStateSchema.cases.Sending.make({ claimedAt }),
  updatedAt: claimedAt,
})

/** Finalize a claimed message captured by a recording transport. */
export const markCaptured = (
  message: SendingOutboundMessage,
  capturedAt: DateTime.Utc,
): OutboundMessage => ({
  ...message,
  state: OutboundStateSchema.cases.Captured.make({ capturedAt }),
  updatedAt: capturedAt,
})

/** Finalize a claimed message accepted for every transport recipient. */
export const markAccepted = (
  message: SendingOutboundMessage,
  input: {
    readonly sentAt: DateTime.Utc
    readonly providerMessageId?: typeof ProviderMessageIdSchema.Type
  },
): OutboundMessage => ({
  ...message,
  state: OutboundStateSchema.cases.Accepted.make(input),
  updatedAt: input.sentAt,
})

/** Finalize a claimed message with both accepted and rejected recipients. */
export const markPartiallyAccepted = (
  message: SendingOutboundMessage,
  input: {
    readonly sentAt: DateTime.Utc
    readonly providerMessageId?: typeof ProviderMessageIdSchema.Type
    readonly outcomes: PartialRecipientOutcomes
  },
): OutboundMessage => ({
  ...message,
  state: OutboundStateSchema.cases.PartiallyAccepted.make(input),
  updatedAt: input.sentAt,
})

/** Finalize an ambiguous claimed handoff without making it retryable. */
export const markDeliveryUnknown = (
  message: SendingOutboundMessage,
  input: {
    readonly occurredAt: DateTime.Utc
    readonly reason:
      | "network"
      | "timeout"
      | "cancelled"
      | "crash_recovery"
      | "finalize_failed"
      | "invalid_response"
  },
): OutboundMessage => ({
  ...message,
  state: OutboundStateSchema.cases.DeliveryUnknown.make(input),
  updatedAt: input.occurredAt,
})

/** Finalize a reserved message that failed before provider handoff. */
export const failBeforeHandoff = (
  message: ReservedOutboundMessage,
  input: {
    readonly failedAt: DateTime.Utc
    readonly reason: "archive" | "configuration"
  },
): OutboundMessage => ({
  ...message,
  state: OutboundStateSchema.cases.Failed.make(input),
  updatedAt: input.failedAt,
})

/** Finalize a claimed handoff that the provider deterministically rejected. */
export const failAfterHandoff = (
  message: SendingOutboundMessage,
  input: {
    readonly failedAt: DateTime.Utc
    readonly reason: "provider_rejected" | "configuration"
  },
): OutboundMessage => ({
  ...message,
  state: OutboundStateSchema.cases.Failed.make(input),
  updatedAt: input.failedAt,
})

/** A required message did not exist in the caller's scope. */
export class MessageNotFound extends Schema.TaggedError<MessageNotFound>()(
  "MessageNotFound",
  {
    messageId: MessageIdSchema,
    reason: Schema.Literal("not_found"),
  },
) {}

/** Persisted message data violated the package-owned domain contract. */
export class InvalidStoredMessage extends Schema.TaggedError<
  InvalidStoredMessage
>()("InvalidStoredMessage", {
  reason: Schema.Literals([
    "invalid_row",
    "invalid_state",
    "invalid_recipient",
  ]),
}) {}
