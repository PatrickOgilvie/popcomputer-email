import { Context, Effect, Option, Schema } from "effect"
import type {
  LeaseToken,
  WorkflowEventId,
  WorkflowRunId,
} from "../core/identifiers.js"
import { WorkflowEventIdSchema } from "../core/identifiers.js"
import type {
  DispatchableWorkflowEvent,
  LeasedWorkflowEvent,
  WorkflowEvent,
  WorkflowFailureReason,
} from "../core/workflow.js"

/** Largest ready-event batch every shipped WorkflowStore accepts. */
export const MaximumWorkflowReadyLimit = 500

/** Named workflow-outbox persistence operation safe for diagnostics. */
export const WorkflowStoreOperationSchema = Schema.Literals([
  "list_ready",
  "claim",
  "mark_started",
  "mark_failed",
  "mark_dead",
])

/** Named workflow-outbox persistence operation safe for diagnostics. */
export type WorkflowStoreOperation = typeof WorkflowStoreOperationSchema.Type

/** Workflow-outbox persistence could not complete an operation. */
export class WorkflowStoreFailure extends Schema.TaggedError<WorkflowStoreFailure>()(
  "WorkflowStoreFailure",
  {
    operation: WorkflowStoreOperationSchema,
    reason: Schema.Literal("unavailable"),
  },
) {}

/** Another dispatcher owns or changed the event lease. */
export class WorkflowStoreLeaseConflict extends Schema.TaggedError<
  WorkflowStoreLeaseConflict
>()("WorkflowStoreLeaseConflict", {
  eventId: WorkflowEventIdSchema,
  reason: Schema.Literal("lease_conflict"),
}) {}

/** Compare-and-set claim input for one ready workflow event. */
export interface ClaimWorkflowEventInput {
  readonly event: DispatchableWorkflowEvent
  readonly leaseToken: LeaseToken
  readonly leasedAt: import("effect").DateTime.Utc
  readonly leaseExpiresAt: import("effect").DateTime.Utc
}

/** Lease-owned terminal transition input. */
export interface CompleteWorkflowLeaseInput {
  readonly event: LeasedWorkflowEvent
  readonly leaseToken: LeaseToken
}

/** Durable workflow outbox persistence seam. */
export class WorkflowStore extends Context.Service<WorkflowStore, {
  readonly listReady: (input: {
    readonly now: import("effect").DateTime.Utc
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<DispatchableWorkflowEvent>, WorkflowStoreFailure>
  readonly claim: (
    input: ClaimWorkflowEventInput,
  ) => Effect.Effect<Option.Option<LeasedWorkflowEvent>, WorkflowStoreFailure>
  readonly markStarted: (
    input: CompleteWorkflowLeaseInput & {
      readonly runId: WorkflowRunId
      readonly startedAt: import("effect").DateTime.Utc
    },
  ) => Effect.Effect<WorkflowEvent, WorkflowStoreFailure | WorkflowStoreLeaseConflict>
  readonly markFailed: (
    input: CompleteWorkflowLeaseInput & {
      readonly failedAt: import("effect").DateTime.Utc
      readonly nextAttemptAt: import("effect").DateTime.Utc
      readonly reason: WorkflowFailureReason
    },
  ) => Effect.Effect<WorkflowEvent, WorkflowStoreFailure | WorkflowStoreLeaseConflict>
  readonly markDead: (
    input: CompleteWorkflowLeaseInput & {
      readonly deadAt: import("effect").DateTime.Utc
      readonly reason: WorkflowFailureReason
    },
  ) => Effect.Effect<WorkflowEvent, WorkflowStoreFailure | WorkflowStoreLeaseConflict>
}>()("@popcomputer/email/WorkflowStore") {}

export type { WorkflowEventId }
