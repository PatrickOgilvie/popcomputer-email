import { DateTime, Schema } from "effect"
import { EmailAddressSchema } from "./address.js"
import {
  LeaseTokenSchema,
  MessageIdSchema,
  RouteIdSchema,
  WorkflowEventIdSchema,
  WorkflowIdSchema,
  WorkflowRunIdSchema,
} from "./identifiers.js"
import { ScopeSchema } from "./scope.js"

/** Positive workflow dispatch attempt number. */
export const WorkflowAttemptSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
).pipe(Schema.brand("EmailWorkflowAttempt"))

/** Positive workflow dispatch attempt number. */
export type WorkflowAttempt = typeof WorkflowAttemptSchema.Type

/** Safe bounded reason persisted after workflow dispatch failure. */
export const WorkflowFailureReasonSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/u),
).pipe(Schema.brand("EmailWorkflowFailureReason"))

/** Safe bounded reason persisted after workflow dispatch failure. */
export type WorkflowFailureReason =
  typeof WorkflowFailureReasonSchema.Type

/** Stable v1 event emitted for an inbound workflow-trigger route. */
export const EmailReceivedEventV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  type: Schema.Literal("email.received"),
  eventId: WorkflowEventIdSchema,
  occurredAt: Schema.DateTimeUtcFromString,
  scope: ScopeSchema,
  workflowId: WorkflowIdSchema,
  message: Schema.Struct({
    id: MessageIdSchema,
    routeId: RouteIdSchema,
    from: EmailAddressSchema,
    to: Schema.NonEmptyArray(EmailAddressSchema),
    subject: Schema.NullOr(
      Schema.String.check(
        Schema.isMaxLength(998),
        Schema.isPattern(/^[^\r\n]*$/u),
      ),
    ),
    sizeBytes: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
    ),
    receivedAt: Schema.DateTimeUtcFromString,
  }),
})

/** Stable v1 event emitted for an inbound workflow-trigger route. */
export interface EmailReceivedEventV1 extends Schema.Schema.Type<
  typeof EmailReceivedEventV1Schema
> {}

/** Durable dispatch state of one workflow-trigger event. */
export const WorkflowEventStateSchema = Schema.TaggedUnion({
  Pending: { nextAttemptAt: Schema.DateTimeUtc },
  Leased: {
    attempt: WorkflowAttemptSchema,
    leaseToken: LeaseTokenSchema,
    leasedAt: Schema.DateTimeUtc,
    leaseExpiresAt: Schema.DateTimeUtc,
  },
  Started: {
    attempt: WorkflowAttemptSchema,
    runId: WorkflowRunIdSchema,
    startedAt: Schema.DateTimeUtc,
  },
  Failed: {
    attempt: WorkflowAttemptSchema,
    failedAt: Schema.DateTimeUtc,
    nextAttemptAt: Schema.DateTimeUtc,
    reason: WorkflowFailureReasonSchema,
  },
  Dead: {
    attempt: WorkflowAttemptSchema,
    deadAt: Schema.DateTimeUtc,
    reason: WorkflowFailureReasonSchema,
  },
})

/** Durable dispatch state of one workflow-trigger event. */
export type WorkflowEventState = typeof WorkflowEventStateSchema.Type

/** Persisted workflow event and its durable dispatch state. */
export const WorkflowEventSchema = Schema.Struct({
  event: EmailReceivedEventV1Schema,
  state: WorkflowEventStateSchema,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
})

/** Persisted workflow event and its durable dispatch state. */
export interface WorkflowEvent extends Schema.Schema.Type<
  typeof WorkflowEventSchema
> {}

/** Pending event eligible for its first dispatch claim. */
export type PendingWorkflowEvent = Omit<WorkflowEvent, "state"> & {
  readonly state: typeof WorkflowEventStateSchema.cases.Pending.Type
}

/** Failed event eligible for a later dispatch claim when due. */
export type FailedWorkflowEvent = Omit<WorkflowEvent, "state"> & {
  readonly state: typeof WorkflowEventStateSchema.cases.Failed.Type
}

/** Event exclusively leased to one dispatcher. */
export type LeasedWorkflowEvent = Omit<WorkflowEvent, "state"> & {
  readonly state: typeof WorkflowEventStateSchema.cases.Leased.Type
}

/** Event that may be atomically claimed by a dispatcher. */
export type DispatchableWorkflowEvent =
  | PendingWorkflowEvent
  | FailedWorkflowEvent

/** Narrow a workflow event to its first pending dispatch state. */
export const isPending = (
  event: WorkflowEvent,
): event is PendingWorkflowEvent => event.state._tag === "Pending"

/** Narrow a workflow event to a retryable failed state. */
export const isFailed = (
  event: WorkflowEvent,
): event is FailedWorkflowEvent => event.state._tag === "Failed"

/** Narrow a workflow event to the exclusively leased state. */
export const isLeased = (
  event: WorkflowEvent,
): event is LeasedWorkflowEvent => event.state._tag === "Leased"

/** Claim a due workflow event with an exclusive, expiring lease. */
export const lease = (
  event: DispatchableWorkflowEvent,
  input: {
    readonly attempt: WorkflowAttempt
    readonly leaseToken: typeof LeaseTokenSchema.Type
    readonly leasedAt: DateTime.Utc
    readonly leaseExpiresAt: DateTime.Utc
  },
): LeasedWorkflowEvent => ({
  ...event,
  state: WorkflowEventStateSchema.cases.Leased.make(input),
  updatedAt: input.leasedAt,
})

/** Mark a leased event accepted by the host workflow runtime. */
export const markStarted = (
  event: LeasedWorkflowEvent,
  input: {
    readonly runId: typeof WorkflowRunIdSchema.Type
    readonly startedAt: DateTime.Utc
  },
): WorkflowEvent => ({
  ...event,
  state: WorkflowEventStateSchema.cases.Started.make({
    attempt: event.state.attempt,
    ...input,
  }),
  updatedAt: input.startedAt,
})

/** Return a leased event to the retry queue with one safe failure reason. */
export const markFailed = (
  event: LeasedWorkflowEvent,
  input: {
    readonly failedAt: DateTime.Utc
    readonly nextAttemptAt: DateTime.Utc
    readonly reason: WorkflowFailureReason
  },
): FailedWorkflowEvent => ({
  ...event,
  state: WorkflowEventStateSchema.cases.Failed.make({
    attempt: event.state.attempt,
    ...input,
  }),
  updatedAt: input.failedAt,
})

/** Move a leased event to its terminal dead state after bounded attempts. */
export const markDead = (
  event: LeasedWorkflowEvent,
  input: {
    readonly deadAt: DateTime.Utc
    readonly reason: WorkflowFailureReason
  },
): WorkflowEvent => ({
  ...event,
  state: WorkflowEventStateSchema.cases.Dead.make({
    attempt: event.state.attempt,
    ...input,
  }),
  updatedAt: input.deadAt,
})

/** Idempotency key supplied to the host workflow runtime for one event. */
export type WorkflowDispatchIdempotencyKey = `email.received:${string}`

/** Derive the stable host-runtime idempotency key for one workflow event. */
export const dispatchIdempotencyKey = (
  eventId: typeof WorkflowEventIdSchema.Type,
): WorkflowDispatchIdempotencyKey => `email.received:${eventId}`

/** Persisted workflow event payload did not satisfy its versioned contract. */
export class InvalidWorkflowEvent extends Schema.TaggedError<
  InvalidWorkflowEvent
>()("InvalidWorkflowEvent", {
  reason: Schema.Literals(["invalid_payload", "unsupported_version"]),
}) {}

/** Another dispatcher owns or changed the workflow-event lease. */
export class WorkflowLeaseConflict extends Schema.TaggedError<
  WorkflowLeaseConflict
>()("WorkflowLeaseConflict", {
  eventId: WorkflowEventIdSchema,
  reason: Schema.Literal("lease_conflict"),
}) {}

/** Reason the host confirms no workflow run was started. */
export const WorkflowStartDefiniteFailureReasonSchema = Schema.Literals([
  "rate_limited",
  "unavailable_before_handoff",
  "rejected_before_start",
])

/** Reason the host confirms no workflow run was started. */
export type WorkflowStartDefiniteFailureReason =
  typeof WorkflowStartDefiniteFailureReasonSchema.Type

/** A retryable workflow start failure known to have created no run. */
export class WorkflowStartDefiniteFailure extends Schema.TaggedError<
  WorkflowStartDefiniteFailure
>()("WorkflowStartDefiniteFailure", {
  reason: WorkflowStartDefiniteFailureReasonSchema,
}) {}

/** Reason a workflow start may have succeeded without an observable response. */
export const WorkflowStartAmbiguousFailureReasonSchema = Schema.Literals([
  "transport",
  "timeout",
  "invalid_response",
  "cancelled",
])

/** Reason a workflow start may have succeeded without an observable response. */
export type WorkflowStartAmbiguousFailureReason =
  typeof WorkflowStartAmbiguousFailureReasonSchema.Type

/** A retryable workflow start whose acceptance is unknown. */
export class WorkflowStartAmbiguousFailure extends Schema.TaggedError<
  WorkflowStartAmbiguousFailure
>()("WorkflowStartAmbiguousFailure", {
  reason: WorkflowStartAmbiguousFailureReasonSchema,
}) {}

/** Reason retrying a workflow start cannot produce a valid run. */
export const WorkflowStartPermanentFailureReasonSchema = Schema.Literals([
  "not_configured",
  "invalid_workflow",
  "unauthorized",
  "idempotency_conflict",
])

/** Reason retrying a workflow start cannot produce a valid run. */
export type WorkflowStartPermanentFailureReason =
  typeof WorkflowStartPermanentFailureReasonSchema.Type

/** A terminal workflow start rejection that must not be retried. */
export class WorkflowStartPermanentFailure extends Schema.TaggedError<
  WorkflowStartPermanentFailure
>()("WorkflowStartPermanentFailure", {
  reason: WorkflowStartPermanentFailureReasonSchema,
}) {}

/** Every expected failure returned by the host workflow start seam. */
export type WorkflowStartFailure =
  | WorkflowStartDefiniteFailure
  | WorkflowStartAmbiguousFailure
  | WorkflowStartPermanentFailure
