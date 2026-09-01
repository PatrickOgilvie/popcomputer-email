import { Context, Effect, Option, Schema } from "effect"
import type { EmailAddress } from "../core/address.js"
import type {
  InboundProviderDeliveryId,
  InboundProviderName,
} from "../core/inbound-delivery.js"
import type {
  MessageId,
  RawMessageRef,
  RouteId,
  Sha256,
} from "../core/identifiers.js"
import type { InboundMessage, MessageRecipient } from "../core/message.js"
import type { RawMimeDescriptor } from "../core/raw-mime.js"
import type { Scope } from "../core/scope.js"
import type { WorkflowEvent } from "../core/workflow.js"

/** Named inbound persistence operation safe to expose in diagnostics. */
export const InboundStoreOperationSchema = Schema.Literals([
  "find_duplicate",
  "create_archive_intent",
  "commit",
  "delete_archive_intent",
  "mark_archive_cleanup",
])

/** Named inbound persistence operation safe to expose in diagnostics. */
export type InboundStoreOperation = typeof InboundStoreOperationSchema.Type

/** Inbound persistence infrastructure could not complete an operation. */
export class InboundStoreFailure extends Schema.TaggedError<InboundStoreFailure>()(
  "InboundStoreFailure",
  {
    operation: InboundStoreOperationSchema,
    reason: Schema.Literal("unavailable"),
  },
) {}

/** Stable provider identity used as the authoritative inbound replay key. */
export interface ProviderInboundDuplicateKey {
  readonly _tag: "Provider"
  readonly scope: Scope
  readonly routeId: RouteId
  readonly provider: InboundProviderName
  readonly deliveryId: InboundProviderDeliveryId
}

/** Fallback raw identity whose suppression ends at one fixed window boundary. */
export interface DigestInboundDuplicateKey {
  readonly _tag: "Digest"
  readonly scope: Scope
  readonly routeId: RouteId
  readonly envelopeFrom: EmailAddress
  readonly rawSha256: Sha256
  readonly observedAt: import("effect").DateTime.Utc
  readonly expiresAt: import("effect").DateTime.Utc
}

/** Provider identity when available, otherwise a bounded raw-delivery key. */
export type InboundDuplicateKey =
  | ProviderInboundDuplicateKey
  | DigestInboundDuplicateKey

/** Durable intent written before an inbound raw object is archived. */
export interface CreateInboundArchiveIntentInput {
  readonly messageId: MessageId
  readonly scope: Scope
  readonly rawSha256: Sha256
  readonly rawRef: RawMessageRef
  readonly expiresAt: import("effect").DateTime.Utc
  readonly now: import("effect").DateTime.Utc
}

/** One atomic inbound metadata/outbox commit. */
export interface CommitInboundInput {
  readonly duplicateKey: InboundDuplicateKey
  readonly message: InboundMessage
  readonly recipient: MessageRecipient
  readonly raw: RawMimeDescriptor
  readonly workflowEvent: WorkflowEvent | undefined
}

/** Result of an atomic inbound commit or a concurrent dedupe winner. */
export type CommitInboundResult =
  | { readonly _tag: "Created"; readonly message: InboundMessage }
  | { readonly _tag: "Existing"; readonly message: InboundMessage }

/** Record an archive object that still needs best-effort durable cleanup. */
export interface MarkArchiveCleanupInput {
  readonly messageId: MessageId
  readonly scope: Scope
  readonly rawRef: RawMessageRef
  readonly safeErrorCode: "archive_remove_failed"
  readonly now: import("effect").DateTime.Utc
  readonly nextAttemptAt: import("effect").DateTime.Utc
}

/** Persistence seam for inbound dedupe, archive intent, and atomic outbox commit. */
export class InboundStore extends Context.Service<InboundStore, {
  readonly findDuplicate: (
    key: InboundDuplicateKey,
  ) => Effect.Effect<Option.Option<InboundMessage>, InboundStoreFailure>
  readonly createArchiveIntent: (
    input: CreateInboundArchiveIntentInput,
  ) => Effect.Effect<void, InboundStoreFailure>
  readonly commit: (
    input: CommitInboundInput,
  ) => Effect.Effect<CommitInboundResult, InboundStoreFailure>
  readonly deleteArchiveIntent: (
    scope: Scope,
    messageId: MessageId,
  ) => Effect.Effect<void, InboundStoreFailure>
  readonly markArchiveCleanup: (
    input: MarkArchiveCleanupInput,
  ) => Effect.Effect<void, InboundStoreFailure>
}>()("@popcomputer/email/InboundStore") {}
