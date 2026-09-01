import { Context, Effect, Option, Schema } from "effect"
import type {
  LeaseToken,
  MessageId,
  RawMessageRef,
} from "../core/identifiers.js"
import type { Direction } from "../core/message.js"
import type { Scope } from "../core/scope.js"

/** Largest recovery or cleanup batch every shipped MaintenanceStore accepts. */
export const MaximumMaintenanceBatchLimit = 1_000

/** One due raw-object cleanup item from either intent or deletion queue. */
export interface ArchiveCleanupItem {
  readonly _tag: "InboundIntent" | "OutboundIntent" | "Deletion"
  readonly id: string
  readonly scope: Scope
  readonly direction: Direction
  readonly messageId: MessageId
  readonly rawRef: RawMessageRef
  readonly attempt: number
}

/** Exclusively leased archive cleanup item. */
export interface LeasedArchiveCleanupItem extends ArchiveCleanupItem {
  readonly leaseToken: LeaseToken
}

/** Named maintenance persistence operation safe for diagnostics. */
export const MaintenanceStoreOperationSchema = Schema.Literals([
  "recover_stale_sending",
  "list_archive_cleanup",
  "claim_archive_cleanup",
  "complete_archive_cleanup",
  "fail_archive_cleanup",
])

/** Maintenance persistence could not complete an operation. */
export class MaintenanceStoreFailure extends Schema.TaggedError<
  MaintenanceStoreFailure
>()("MaintenanceStoreFailure", {
  operation: MaintenanceStoreOperationSchema,
  reason: Schema.Literal("unavailable"),
}) {}

/** Persistence seam for conservative crash recovery and raw cleanup. */
export class MaintenanceStore extends Context.Service<MaintenanceStore, {
  readonly recoverStaleSending: (input: {
    readonly staleBefore: import("effect").DateTime.Utc
    readonly occurredAt: import("effect").DateTime.Utc
    readonly limit: number
  }) => Effect.Effect<number, MaintenanceStoreFailure>
  readonly listArchiveCleanup: (input: {
    readonly now: import("effect").DateTime.Utc
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<ArchiveCleanupItem>, MaintenanceStoreFailure>
  readonly claimArchiveCleanup: (input: {
    readonly item: ArchiveCleanupItem
    readonly leaseToken: LeaseToken
    readonly leaseExpiresAt: import("effect").DateTime.Utc
  }) => Effect.Effect<Option.Option<LeasedArchiveCleanupItem>, MaintenanceStoreFailure>
  readonly completeArchiveCleanup: (
    item: LeasedArchiveCleanupItem,
  ) => Effect.Effect<void, MaintenanceStoreFailure>
  readonly failArchiveCleanup: (input: {
    readonly item: LeasedArchiveCleanupItem
    readonly nextAttemptAt: import("effect").DateTime.Utc
    readonly dead: boolean
    readonly safeErrorCode: "archive_remove_failed"
  }) => Effect.Effect<void, MaintenanceStoreFailure>
}>()("@popcomputer/email/MaintenanceStore") {}
