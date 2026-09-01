import { DateTime, Effect, Option, Schema } from "effect"
import type {
  ArchivedRawMessage,
  StoredMessage,
  StoredOutboundMessage,
} from "../../adapters/message-store.js"
import {
  RawMessageRefSchema,
  Sha256Schema,
} from "../../core/identifiers.js"
import {
  InvalidStoredMessage,
  MessageRecipientSchema,
  MessageSchema,
  type Message,
  type MessageRecipient,
  type OutboundMessage,
  type RecipientTransportOutcome,
} from "../../core/message.js"

const EpochMillisSchema = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
)

const NullableTextSchema = Schema.NullOr(Schema.String)

const MessageRowSchema = Schema.Struct({
  id: Schema.String,
  namespace: Schema.String,
  environment: Schema.String,
  route_id: NullableTextSchema,
  workflow_id: NullableTextSchema,
  workflow_event_id: NullableTextSchema,
  direction: Schema.String,
  status: Schema.String,
  state_reason: NullableTextSchema,
  from_address: Schema.String,
  to_address: Schema.String,
  subject: NullableTextSchema,
  rfc_message_id: NullableTextSchema,
  raw_sha256: NullableTextSchema,
  raw_ref: NullableTextSchema,
  size_bytes: Schema.Number,
  idempotency_key: NullableTextSchema,
  request_fingerprint: NullableTextSchema,
  provider_message_id: NullableTextSchema,
  actor_kind: NullableTextSchema,
  actor_id: NullableTextSchema,
  claimed_at: Schema.NullOr(EpochMillisSchema),
  sent_at: Schema.NullOr(EpochMillisSchema),
  received_at: Schema.NullOr(EpochMillisSchema),
  created_at: EpochMillisSchema,
  updated_at: EpochMillisSchema,
})

const RecipientRowSchema = Schema.Struct({
  id: Schema.String,
  message_id: Schema.String,
  kind: Schema.String,
  position: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  address: Schema.String,
  status: Schema.String,
  created_at: EpochMillisSchema,
  updated_at: EpochMillisSchema,
})

const ArchivedRawMessageSchema = Schema.Struct({
  ref: RawMessageRefSchema,
  sha256: Sha256Schema,
  sizeBytes: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
})

/** Strict D1 projection consumed by the message-store adapter. */
export type MessageRow = typeof MessageRowSchema.Type

/** Strict D1 recipient projection including its stable envelope position. */
export type RecipientRow = typeof RecipientRowSchema.Type

type OutboundStateCandidate =
  | { readonly _tag: "Reserved" }
  | { readonly _tag: "Sending"; readonly claimedAt: DateTime.Utc }
  | { readonly _tag: "Captured"; readonly capturedAt: DateTime.Utc }
  | {
      readonly _tag: "Accepted"
      readonly sentAt: DateTime.Utc
      readonly providerMessageId?: string
    }
  | {
      readonly _tag: "PartiallyAccepted"
      readonly sentAt: DateTime.Utc
      readonly providerMessageId?: string
      readonly outcomes: ReadonlyArray<RecipientTransportOutcome>
    }
  | {
      readonly _tag: "DeliveryUnknown"
      readonly occurredAt: DateTime.Utc
      readonly reason:
        | "network"
        | "timeout"
        | "cancelled"
        | "crash_recovery"
        | "finalize_failed"
        | "invalid_response"
    }
  | {
      readonly _tag: "Failed"
      readonly failedAt: DateTime.Utc
      readonly reason: "archive" | "provider_rejected" | "configuration"
    }

type InboundStateCandidate =
  | { readonly _tag: "Received" }
  | { readonly _tag: "WorkflowEventCreated"; readonly eventId: string }

const invalid = (
  reason: InvalidStoredMessage["reason"],
): InvalidStoredMessage => new InvalidStoredMessage({ reason })

const decodeMessageRow = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- D1 rows are untrusted at this adapter boundary and are immediately decoded with MessageRowSchema.
  input: unknown,
): Effect.Effect<MessageRow, InvalidStoredMessage> =>
  Schema.decodeUnknownEffect(MessageRowSchema)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => invalid("invalid_row")))

/** Strictly parse ordered recipient projections returned by D1. */
export const decodeRecipientRows = (
  input: ReadonlyArray<unknown>,
): Effect.Effect<ReadonlyArray<RecipientRow>, InvalidStoredMessage> =>
  Schema.decodeUnknownEffect(Schema.Array(RecipientRowSchema))(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => invalid("invalid_recipient")))

const toDateTime = (epochMillis: number): DateTime.Utc =>
  DateTime.makeUnsafe(epochMillis)

const actorTag = (
  kind: string,
): "User" | "Credential" | "System" | undefined => {
  switch (kind) {
    case "user":
      return "User"
    case "credential":
      return "Credential"
    case "system":
      return "System"
    default:
      return undefined
  }
}

const ensureContiguousPositions = (
  rows: ReadonlyArray<RecipientRow>,
): boolean => {
  const nextByKind = new Map<string, number>()
  for (const row of rows) {
    const expected = nextByKind.get(row.kind) ?? 0
    if (row.position !== expected) {
      return false
    }
    nextByKind.set(row.kind, expected + 1)
  }
  return true
}

const decodeDomainRecipients = (
  messageId: string,
  rows: ReadonlyArray<RecipientRow>,
): Effect.Effect<ReadonlyArray<MessageRecipient>, InvalidStoredMessage> => {
  if (
    rows.some((row) => row.message_id !== messageId) ||
    !ensureContiguousPositions(rows)
  ) {
    return Effect.fail(invalid("invalid_recipient"))
  }

  return Effect.forEach(rows, (row) =>
    Schema.decodeUnknownEffect(MessageRecipientSchema)({
      id: row.id,
      messageId: row.message_id,
      kind: row.kind,
      address: row.address,
      status: row.status,
      createdAt: toDateTime(row.created_at),
      updatedAt: toDateTime(row.updated_at),
    }, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => invalid("invalid_recipient")),
    ),
  )
}

const recipientAddresses = (
  recipients: ReadonlyArray<MessageRecipient>,
  kind: MessageRecipient["kind"],
): ReadonlyArray<MessageRecipient["address"]> =>
  recipients
    .filter((recipient) => recipient.kind === kind)
    .map((recipient) => recipient.address)

const partialOutcomes = (
  recipients: ReadonlyArray<MessageRecipient>,
): ReadonlyArray<RecipientTransportOutcome> | undefined => {
  const outcomes: Array<RecipientTransportOutcome> = []
  for (const recipient of recipients) {
    switch (recipient.status) {
      case "queued":
      case "delivered":
        outcomes.push({ _tag: "Accepted", address: recipient.address })
        break
      case "failed":
      case "permanent_bounce":
        outcomes.push({ _tag: "Rejected", address: recipient.address })
        break
      case "pending":
      case "captured":
        return undefined
    }
  }
  return outcomes
}

const recipientsHaveStatus = (
  recipients: ReadonlyArray<MessageRecipient>,
  statuses: ReadonlyArray<MessageRecipient["status"]>,
): boolean =>
  recipients.every((recipient) => statuses.includes(recipient.status))

const outboundState = (
  row: MessageRow,
  recipients: ReadonlyArray<MessageRecipient>,
): OutboundStateCandidate | undefined => {
  switch (row.status) {
    case "reserved":
      return row.claimed_at === null && row.sent_at === null &&
          row.state_reason === null && row.provider_message_id === null &&
          recipientsHaveStatus(recipients, ["pending"])
        ? { _tag: "Reserved" }
        : undefined
    case "sending":
      return row.claimed_at === null || row.sent_at !== null ||
          row.state_reason !== null || row.provider_message_id !== null ||
          !recipientsHaveStatus(recipients, ["pending"])
        ? undefined
        : {
            _tag: "Sending",
            claimedAt: toDateTime(row.claimed_at),
          }
    case "captured":
      return row.claimed_at !== null && row.sent_at === null &&
          row.state_reason === null && row.provider_message_id === null &&
          recipientsHaveStatus(recipients, ["captured"])
        ? {
            _tag: "Captured",
            capturedAt: toDateTime(row.updated_at),
          }
        : undefined
    case "accepted": {
      if (
        row.claimed_at === null ||
        row.sent_at === null ||
        row.state_reason !== null ||
        !recipientsHaveStatus(recipients, ["queued", "delivered"])
      ) {
        return undefined
      }
      const sentAt = toDateTime(row.sent_at)
      return row.provider_message_id === null
        ? { _tag: "Accepted", sentAt }
        : {
            _tag: "Accepted",
            sentAt,
            providerMessageId: row.provider_message_id,
          }
    }
    case "partially_accepted": {
      const outcomes = partialOutcomes(recipients)
      if (
        row.claimed_at === null ||
        row.sent_at === null ||
        row.state_reason !== null ||
        outcomes === undefined ||
        outcomes.length === 0
      ) {
        return undefined
      }
      const sentAt = toDateTime(row.sent_at)
      return row.provider_message_id === null
        ? {
            _tag: "PartiallyAccepted",
            sentAt,
            outcomes,
          }
        : {
            _tag: "PartiallyAccepted",
            sentAt,
            providerMessageId: row.provider_message_id,
            outcomes,
          }
    }
    case "delivery_unknown":
      return row.claimed_at !== null && row.sent_at === null &&
          row.provider_message_id === null &&
          recipientsHaveStatus(recipients, ["pending"]) &&
          (row.state_reason === "network" ||
            row.state_reason === "timeout" ||
            row.state_reason === "cancelled" ||
            row.state_reason === "crash_recovery" ||
            row.state_reason === "finalize_failed" ||
            row.state_reason === "invalid_response")
        ? {
            _tag: "DeliveryUnknown",
            occurredAt: toDateTime(row.updated_at),
            reason: row.state_reason,
          }
        : undefined
    case "failed": {
      const validFailure =
        (row.state_reason === "archive" && row.claimed_at === null &&
          recipientsHaveStatus(recipients, ["pending"])) ||
        (row.state_reason === "provider_rejected" &&
          row.claimed_at !== null &&
          recipientsHaveStatus(recipients, ["failed"])) ||
        (row.state_reason === "configuration" &&
          recipientsHaveStatus(recipients, ["pending"]))
      return row.sent_at === null && row.provider_message_id === null &&
          validFailure
        ? {
            _tag: "Failed",
            failedAt: toDateTime(row.updated_at),
            reason: row.state_reason,
          }
        : undefined
    }
    default:
      return undefined
  }
}

const inboundState = (
  row: MessageRow,
): InboundStateCandidate | undefined => {
  switch (row.status) {
    case "received":
      return row.workflow_event_id === null
        ? { _tag: "Received" }
        : undefined
    case "workflow_event_created":
      return row.workflow_event_id === null
        ? undefined
        : {
            _tag: "WorkflowEventCreated",
            eventId: row.workflow_event_id,
          }
    default:
      return undefined
  }
}

const decodeOutbound = (
  row: MessageRow,
  recipients: ReadonlyArray<MessageRecipient>,
): Effect.Effect<OutboundMessage, InvalidStoredMessage> => {
  const to = recipientAddresses(recipients, "to")
  const cc = recipientAddresses(recipients, "cc")
  const bcc = recipientAddresses(recipients, "bcc")
  const actor = row.actor_kind === null
    ? undefined
    : actorTag(row.actor_kind)
  const state = outboundState(row, recipients)

  if (
    row.route_id === null ||
    row.workflow_id !== null ||
    row.workflow_event_id !== null ||
    row.subject === null ||
    row.rfc_message_id !== null ||
    row.idempotency_key === null ||
    row.request_fingerprint === null ||
    row.actor_id === null ||
    row.received_at !== null ||
    actor === undefined ||
    to.length === 0 ||
    to[0] !== row.to_address ||
    state === undefined
  ) {
    return Effect.fail(invalid("invalid_state"))
  }

  return Schema.decodeUnknownEffect(MessageSchema)({
    _tag: "Outbound",
    id: row.id,
    scope: {
      namespace: row.namespace,
      environment: row.environment,
    },
    actor: { _tag: actor, id: row.actor_id },
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    routeId: row.route_id,
    from: row.from_address,
    to,
    cc,
    bcc,
    subject: row.subject,
    sizeBytes: row.size_bytes,
    createdAt: toDateTime(row.created_at),
    updatedAt: toDateTime(row.updated_at),
    state,
  }, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => invalid("invalid_state")),
    Effect.flatMap((message) =>
      message._tag === "Outbound"
        ? Effect.succeed(message)
        : Effect.fail(invalid("invalid_state")),
    ),
  )
}

const decodeInbound = (
  row: MessageRow,
  recipients: ReadonlyArray<MessageRecipient>,
): Effect.Effect<Message, InvalidStoredMessage> => {
  const to = recipientAddresses(recipients, "to")
  const cc = recipientAddresses(recipients, "cc")
  const bcc = recipientAddresses(recipients, "bcc")
  const state = inboundState(row)
  if (
    row.route_id === null ||
    row.received_at === null ||
    row.idempotency_key !== null ||
    row.request_fingerprint !== null ||
    row.provider_message_id !== null ||
    row.actor_kind !== null ||
    row.actor_id !== null ||
    row.claimed_at !== null ||
    row.sent_at !== null ||
    to.length === 0 ||
    cc.length > 0 ||
    bcc.length > 0 ||
    to[0] !== row.to_address ||
    state === undefined
  ) {
    return Effect.fail(invalid("invalid_state"))
  }

  const base = {
    _tag: "Inbound",
    id: row.id,
    scope: {
      namespace: row.namespace,
      environment: row.environment,
    },
    routeId: row.route_id,
    from: row.from_address,
    to,
    subject: row.subject,
    sizeBytes: row.size_bytes,
    receivedAt: toDateTime(row.received_at),
    createdAt: toDateTime(row.created_at),
    updatedAt: toDateTime(row.updated_at),
    state,
  }
  const withWorkflow = row.workflow_id === null
    ? base
    : { ...base, workflowId: row.workflow_id }
  const candidate = row.rfc_message_id === null
    ? withWorkflow
    : { ...withWorkflow, rfcMessageId: row.rfc_message_id }

  return Schema.decodeUnknownEffect(MessageSchema)(candidate, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => invalid("invalid_state")))
}

const decodeRaw = (
  row: MessageRow,
): Effect.Effect<Option.Option<ArchivedRawMessage>, InvalidStoredMessage> => {
  if (row.raw_ref === null && row.raw_sha256 === null) {
    return Effect.succeed(Option.none())
  }
  if (row.raw_ref === null || row.raw_sha256 === null) {
    return Effect.fail(invalid("invalid_state"))
  }

  return Schema.decodeUnknownEffect(ArchivedRawMessageSchema)({
    ref: row.raw_ref,
    sha256: row.raw_sha256,
    sizeBytes: row.size_bytes,
  }, { onExcessProperty: "error" }).pipe(
    Effect.map(Option.some),
    Effect.mapError(() => invalid("invalid_state")),
  )
}

const requiresArchivedRaw = (message: Message): boolean => {
  if (message._tag !== "Outbound") {
    return false
  }
  switch (message.state._tag) {
    case "Reserved":
      return false
    case "Failed":
      return message.state.reason !== "archive"
    case "Sending":
    case "Captured":
    case "Accepted":
    case "PartiallyAccepted":
    case "DeliveryUnknown":
      return true
  }
}

/**
 * Parse one message and its ordered recipients from untrusted D1 rows.
 *
 * Contradictory lifecycle columns, incomplete archive metadata, non-contiguous
 * recipient positions, and invalid domain values fail closed.
 */
export const decodeStoredMessage = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- D1 message rows are untrusted at this exported adapter boundary and decodeStoredMessage parses them before constructing a domain value.
  rowInput: unknown,
  recipientInputs: ReadonlyArray<unknown>,
): Effect.Effect<StoredMessage, InvalidStoredMessage> =>
  Effect.gen(function* () {
    const row = yield* decodeMessageRow(rowInput)
    const recipientRows = yield* decodeRecipientRows(recipientInputs)
    const recipients = yield* decodeDomainRecipients(row.id, recipientRows)
    const message = row.direction === "outbound"
      ? yield* decodeOutbound(row, recipients)
      : row.direction === "inbound"
        ? yield* decodeInbound(row, recipients)
        : yield* Effect.fail(invalid("invalid_state"))
    const raw = yield* decodeRaw(row)
    if (requiresArchivedRaw(message) && Option.isNone(raw)) {
      return yield* Effect.fail(invalid("invalid_state"))
    }
    return { message, recipients, raw }
  })

/** Narrow a decoded stored record to an outbound message. */
export const decodeStoredOutboundMessage = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- D1 message rows are untrusted at this exported adapter boundary and decodeStoredOutboundMessage delegates immediately to the strict row decoder.
  rowInput: unknown,
  recipientInputs: ReadonlyArray<unknown>,
): Effect.Effect<StoredOutboundMessage, InvalidStoredMessage> =>
  decodeStoredMessage(rowInput, recipientInputs).pipe(
    Effect.flatMap((record) =>
      record.message._tag === "Outbound"
        ? Effect.succeed({
            message: record.message,
            recipients: record.recipients,
            raw: record.raw,
          })
        : Effect.fail(invalid("invalid_state")),
    ),
  )
