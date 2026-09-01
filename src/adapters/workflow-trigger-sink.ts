import { Context, Effect } from "effect"
import type { WorkflowRunId } from "../core/identifiers.js"
import type {
  EmailReceivedEventV1,
  WorkflowDispatchIdempotencyKey,
  WorkflowStartFailure,
} from "../core/workflow.js"

/** Host-runtime request made after one durable event lease is acquired. */
export interface StartWorkflowInput {
  readonly event: EmailReceivedEventV1
  readonly idempotencyKey: WorkflowDispatchIdempotencyKey
}

/**
 * Explicit host seam for starting one workflow from a durable email trigger.
 *
 * Implementations must bind each idempotency key to the encoded event. Replaying
 * the same key and event returns the original run without starting another run;
 * reusing the key for a different event fails with `idempotency_conflict`.
 */
export class WorkflowTriggerSink extends Context.Service<WorkflowTriggerSink, {
  readonly start: (
    input: StartWorkflowInput,
  ) => Effect.Effect<WorkflowRunId, WorkflowStartFailure>
}>()("@popcomputer/email/WorkflowTriggerSink") {}
