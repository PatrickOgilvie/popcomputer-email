import { Context, Effect, Option, Schema } from "effect"
import type { EmailAddress } from "../core/address.js"
import { type IdempotencyKey, type InvalidPageRequest, MessageIdSchema, type MessageId, type PageCursor, type ProviderMessageId, type RawMessageRef, type RecipientId, type RequestFingerprint, type Sha256 } from "../core/identifiers.js"
import { type InvalidStoredMessage, type Message, type MessageRecipient, type OutboundMessage, type RecipientTransportOutcome, type ReservedOutboundMessage, type SendingOutboundMessage } from "../core/message.js"
import type { Scope } from "../core/scope.js"

/** Storage operation whose infrastructure failure is safe to expose. */
export const MessageStoreOperationSchema = Schema.Literals([
  "find_idempotency",
  "reserve",
  "create_archive_intent",
  "attach_raw",
  "claim",
  "finalize",
  "get",
  "list",
])

/** Storage operation whose infrastructure failure is safe to expose. */
export type MessageStoreOperation = typeof MessageStoreOperationSchema.Type

/** The configured message store could not complete an operation. */
export class MessageStoreFailure extends Schema.TaggedError<MessageStoreFailure>()(
  "MessageStoreFailure",
  {
    operation: MessageStoreOperationSchema,
    reason: Schema.Literal("unavailable"),
  },
) {}

/** A compare-and-set message transition lost a concurrent race. */
export class MessageTransitionConflict extends Schema.TaggedError<MessageTransitionConflict>()(
  "MessageTransitionConflict",
  {
    messageId: MessageIdSchema,
    reason: Schema.Literal("concurrent_update"),
  },
) {}

/** Opaque archived MIME metadata retained beside a message record. */
export interface ArchivedRawMessage {
  readonly ref: RawMessageRef
  readonly sha256: Sha256
  readonly sizeBytes: number
}

/** Message plus storage-only metadata that never leaks through the domain API. */
export interface StoredMessage {
  readonly message: Message
  readonly recipients: ReadonlyArray<MessageRecipient>
  readonly raw: Option.Option<ArchivedRawMessage>
}

/** Outbound message plus storage-only metadata used by the send workflow. */
export interface StoredOutboundMessage extends Omit<StoredMessage, "message"> {
  readonly message: OutboundMessage
}

/** Recipient row reserved atomically with a new outbound message. */
export interface ReservedRecipient {
  readonly id: RecipientId
  readonly kind: "to" | "cc" | "bcc"
  readonly address: EmailAddress
}

/** Atomic reservation input for a newly rendered outbound message. */
export interface ReserveOutboundInput {
  readonly message: ReservedOutboundMessage
  readonly recipients: readonly [ReservedRecipient, ...Array<ReservedRecipient>]
}

/** Result of an atomic scoped idempotency reservation. */
export type ReserveOutboundResult =
  | { readonly _tag: "Created"; readonly record: StoredOutboundMessage }
  | { readonly _tag: "Existing"; readonly record: StoredOutboundMessage }

/** Metadata attached after raw MIME has been archived durably. */
export interface AttachOutboundRawInput {
  readonly scope: Scope
  readonly messageId: MessageId
  readonly raw: ArchivedRawMessage
}

/** Durable cleanup intent written before an outbound raw object is archived. */
export interface CreateOutboundArchiveIntentInput extends AttachOutboundRawInput {
  readonly expiresAt: import("effect").DateTime.Utc
  readonly now: import("effect").DateTime.Utc
}

/** Compare-and-set input that exclusively claims a provider handoff. */
export interface ClaimOutboundInput {
  readonly scope: Scope
  readonly messageId: MessageId
  readonly claimedAt: import("effect").DateTime.Utc
}

/** Result of claiming a reserved outbound message. */
export type ClaimOutboundResult =
  | { readonly _tag: "Claimed"; readonly record: StoredOutboundMessage & { readonly message: SendingOutboundMessage } }
  | { readonly _tag: "NotClaimed"; readonly record: StoredOutboundMessage }

/** Terminal state written atomically after one outbound attempt. */
export type OutboundFinalization =
  | { readonly _tag: "Captured"; readonly capturedAt: import("effect").DateTime.Utc }
  | {
      readonly _tag: "Accepted"
      readonly sentAt: import("effect").DateTime.Utc
      readonly providerMessageId?: ProviderMessageId
      readonly outcomes: ReadonlyArray<RecipientTransportOutcome>
    }
  | {
      readonly _tag: "PartiallyAccepted"
      readonly sentAt: import("effect").DateTime.Utc
      readonly providerMessageId?: ProviderMessageId
      readonly outcomes: readonly [RecipientTransportOutcome, ...Array<RecipientTransportOutcome>]
    }
  | {
      readonly _tag: "DeliveryUnknown"
      readonly occurredAt: import("effect").DateTime.Utc
      readonly reason: "network" | "timeout" | "cancelled" | "crash_recovery" | "finalize_failed" | "invalid_response"
    }
  | {
      readonly _tag: "Failed"
      readonly failedAt: import("effect").DateTime.Utc
      readonly reason: "archive" | "provider_rejected" | "configuration"
    }

/** Compare-and-set terminalization input for a claimed outbound message. */
export interface FinalizeOutboundInput {
  readonly scope: Scope
  readonly messageId: MessageId
  readonly finalization: OutboundFinalization
}

/** Cursor-paginated read request scoped to one host partition. */
export interface ListMessagesInput {
  readonly scope: Scope
  readonly direction?: "inbound" | "outbound"
  readonly limit?: number
  readonly cursor?: PageCursor
}

/** Scoped lookup request for one message. */
export interface GetMessageInput {
  readonly scope: Scope
  readonly messageId: MessageId
}

/** One cursor-paginated page of parsed storage records. */
export interface StoredMessagePage {
  readonly items: ReadonlyArray<StoredMessage>
  readonly nextCursor: Option.Option<PageCursor>
}

/** Lookup request used to replay a scoped idempotent send safely. */
export interface FindOutboundByIdempotencyInput {
  readonly scope: Scope
  readonly idempotencyKey: IdempotencyKey
}

/** Request-fingerprint association stored atomically with every reservation. */
export interface OutboundReservationIdentity {
  readonly idempotencyKey: IdempotencyKey
  readonly requestFingerprint: RequestFingerprint
}

/** Persistence port for message reservation, transitions, and scoped reads. */
export class MessageStore extends Context.Service<MessageStore, {
  readonly findOutboundByIdempotency: (
    input: FindOutboundByIdempotencyInput,
  ) => Effect.Effect<Option.Option<StoredOutboundMessage>, MessageStoreFailure | InvalidStoredMessage>
  readonly reserveOutbound: (
    input: ReserveOutboundInput,
  ) => Effect.Effect<ReserveOutboundResult, MessageStoreFailure | InvalidStoredMessage>
  readonly createOutboundArchiveIntent: (
    input: CreateOutboundArchiveIntentInput,
  ) => Effect.Effect<
    void,
    MessageStoreFailure | MessageTransitionConflict | InvalidStoredMessage
  >
  readonly attachOutboundRaw: (
    input: AttachOutboundRawInput,
  ) => Effect.Effect<StoredOutboundMessage, MessageStoreFailure | MessageTransitionConflict | InvalidStoredMessage>
  readonly claimOutbound: (
    input: ClaimOutboundInput,
  ) => Effect.Effect<ClaimOutboundResult, MessageStoreFailure | InvalidStoredMessage>
  readonly finalizeOutbound: (
    input: FinalizeOutboundInput,
  ) => Effect.Effect<StoredOutboundMessage, MessageStoreFailure | MessageTransitionConflict | InvalidStoredMessage>
  readonly get: (
    input: GetMessageInput,
  ) => Effect.Effect<Option.Option<StoredMessage>, MessageStoreFailure | InvalidStoredMessage>
  readonly list: (
    input: ListMessagesInput,
  ) => Effect.Effect<StoredMessagePage, InvalidPageRequest | MessageStoreFailure | InvalidStoredMessage>
}>()("@popcomputer/email/MessageStore") {}
