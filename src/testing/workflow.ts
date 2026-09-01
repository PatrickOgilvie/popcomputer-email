import { DateTime, Effect, Layer, Option, Schema } from "effect"
import {
  WorkflowStore,
  WorkflowStoreLeaseConflict,
} from "../adapters/workflow-store.js"
import {
  type StartWorkflowInput,
  WorkflowTriggerSink,
} from "../adapters/workflow-trigger-sink.js"
import {
  EmailReceivedEventV1Schema,
  lease,
  isFailed,
  isLeased,
  isPending,
  markDead,
  markFailed,
  markStarted,
  WorkflowAttemptSchema,
  WorkflowEventStateSchema,
  WorkflowFailureReasonSchema,
  WorkflowStartAmbiguousFailure,
  WorkflowStartAmbiguousFailureReasonSchema,
  WorkflowStartDefiniteFailure,
  WorkflowStartDefiniteFailureReasonSchema,
  type WorkflowStartFailure,
  WorkflowStartPermanentFailure,
  WorkflowStartPermanentFailureReasonSchema,
  type EmailReceivedEventV1,
  type WorkflowEvent,
  type DispatchableWorkflowEvent,
} from "../core/workflow.js"
import {
  type WorkflowRunId,
  WorkflowRunIdSchema,
} from "../core/identifiers.js"

/** Inspectable workflow store supporting the same lease CAS as D1. */
export interface InMemoryWorkflowStore {
  readonly service: WorkflowStore["Service"]
  readonly events: ReadonlyArray<WorkflowEvent>
  readonly enqueue: (event: WorkflowEvent) => void
  readonly layer: Layer.Layer<WorkflowStore>
}

/** Create an isolated durable-outbox fake. */
export const makeInMemoryWorkflowStore = (
  initial: ReadonlyArray<WorkflowEvent> = [],
): InMemoryWorkflowStore => {
  const events = new Map(
    initial.map((event) => [event.event.eventId, event]),
  )

  const readyAt = (
    event: WorkflowEvent,
    now: DateTime.Utc,
  ): DispatchableWorkflowEvent | undefined => {
    const nowEpoch = DateTime.toEpochMillis(now)
    if (isPending(event) || isFailed(event)) {
      return DateTime.toEpochMillis(event.state.nextAttemptAt) <= nowEpoch
        ? event
        : undefined
    }
    if (
      !isLeased(event) ||
      DateTime.toEpochMillis(event.state.leaseExpiresAt) > nowEpoch
    ) {
      return undefined
    }
    return {
      ...event,
      state: WorkflowEventStateSchema.cases.Failed.make({
        attempt: event.state.attempt,
        failedAt: event.state.leaseExpiresAt,
        nextAttemptAt: event.state.leaseExpiresAt,
        reason: WorkflowFailureReasonSchema.make(
          "workflow_store.lease_expired",
        ),
      }),
      updatedAt: event.state.leaseExpiresAt,
    }
  }

  const service = WorkflowStore.of({
    listReady: ({ now, limit }) => Effect.sync(() => {
      const ready: Array<DispatchableWorkflowEvent> = []
      for (const event of events.values()) {
        const projected = readyAt(event, now)
        if (projected !== undefined) ready.push(projected)
      }
      return ready.sort((left, right) =>
        DateTime.toEpochMillis(left.createdAt) -
        DateTime.toEpochMillis(right.createdAt)).slice(0, limit)
    }),
    claim: (input) => Effect.sync(() => {
      const current = events.get(input.event.event.eventId)
      if (current === undefined) {
        return Option.none()
      }
      const expiredLease = isLeased(current) &&
        input.event.state._tag === "Failed" &&
        input.event.state.reason === "workflow_store.lease_expired" &&
        current.state.attempt === input.event.state.attempt &&
        DateTime.toEpochMillis(current.state.leaseExpiresAt) <=
          DateTime.toEpochMillis(input.leasedAt)
      const currentDispatchable = isPending(current) || isFailed(current)
        ? current
        : undefined
      if (
        !expiredLease &&
        (currentDispatchable === undefined ||
          currentDispatchable.updatedAt !== input.event.updatedAt)
      ) {
        return Option.none()
      }
      const source = expiredLease ? input.event : currentDispatchable
      if (source === undefined) return Option.none()
      const claimed = lease(source, {
        attempt: WorkflowAttemptSchema.make(
          source.state._tag === "Pending" ? 1 : source.state.attempt + 1,
        ),
        leaseToken: input.leaseToken,
        leasedAt: input.leasedAt,
        leaseExpiresAt: input.leaseExpiresAt,
      })
      events.set(claimed.event.eventId, claimed)
      return Option.some(claimed)
    }),
    markStarted: (input) => Effect.gen(function*() {
      const current = events.get(input.event.event.eventId)
      if (
        current === undefined ||
        !isLeased(current) ||
        current.state.leaseToken !== input.leaseToken
      ) {
        return yield* new WorkflowStoreLeaseConflict({
          eventId: input.event.event.eventId,
          reason: "lease_conflict",
        })
      }
      const next = markStarted(current, {
        runId: input.runId,
        startedAt: input.startedAt,
      })
      events.set(next.event.eventId, next)
      return next
    }),
    markFailed: (input) => Effect.gen(function*() {
      const current = events.get(input.event.event.eventId)
      if (
        current === undefined ||
        !isLeased(current) ||
        current.state.leaseToken !== input.leaseToken
      ) {
        return yield* new WorkflowStoreLeaseConflict({
          eventId: input.event.event.eventId,
          reason: "lease_conflict",
        })
      }
      const next = markFailed(current, {
        failedAt: input.failedAt,
        nextAttemptAt: input.nextAttemptAt,
        reason: input.reason,
      })
      events.set(next.event.eventId, next)
      return next
    }),
    markDead: (input) => Effect.gen(function*() {
      const current = events.get(input.event.event.eventId)
      if (
        current === undefined ||
        !isLeased(current) ||
        current.state.leaseToken !== input.leaseToken
      ) {
        return yield* new WorkflowStoreLeaseConflict({
          eventId: input.event.event.eventId,
          reason: "lease_conflict",
        })
      }
      const next = markDead(current, {
        deadAt: input.deadAt,
        reason: input.reason,
      })
      events.set(next.event.eventId, next)
      return next
    }),
  })

  return {
    service,
    get events() {
      return Array.from(events.values())
    },
    enqueue: (event) => {
      if (!events.has(event.event.eventId)) {
        events.set(event.event.eventId, event)
      }
    },
    layer: Layer.succeed(WorkflowStore, service),
  }
}

/** One deterministic result consumed by the scripted workflow sink. */
export const WorkflowStartScriptOutcomeSchema = Schema.TaggedUnion({
  Accept: {
    runId: WorkflowRunIdSchema,
  },
  DefiniteFailure: {
    reason: WorkflowStartDefiniteFailureReasonSchema,
  },
  FailAfterPossibleAcceptance: {
    runId: WorkflowRunIdSchema,
    reason: WorkflowStartAmbiguousFailureReasonSchema,
  },
  PermanentFailure: {
    reason: WorkflowStartPermanentFailureReasonSchema,
  },
})

/** One deterministic result consumed by the scripted workflow sink. */
export type WorkflowStartScriptOutcome =
  typeof WorkflowStartScriptOutcomeSchema.Type

/** One workflow run actually accepted by the scripted host seam. */
export interface AcceptedWorkflowStart {
  readonly input: StartWorkflowInput
  readonly runId: WorkflowRunId
}

/** Inspectable host workflow sink with an injectable start behavior. */
export interface RecordingWorkflowSink {
  readonly service: WorkflowTriggerSink["Service"]
  readonly attempts: ReadonlyArray<StartWorkflowInput>
  readonly events: ReadonlyArray<EmailReceivedEventV1>
  readonly layer: Layer.Layer<WorkflowTriggerSink>
}

/** Create a recording host-runtime sink. */
export const makeRecordingWorkflowSink = (
  start: (
    input: StartWorkflowInput,
  ) => Effect.Effect<WorkflowRunId, WorkflowStartFailure>,
): RecordingWorkflowSink => {
  const attempts: Array<StartWorkflowInput> = []
  const service = WorkflowTriggerSink.of({
    start: (input) => Effect.gen(function*() {
      attempts.push(input)
      return yield* start(input)
    }),
  })
  return {
    service,
    get attempts() {
      return Array.from(attempts)
    },
    get events() {
      return attempts.map((input) => input.event)
    },
    layer: Layer.succeed(WorkflowTriggerSink, service),
  }
}

/** Inspectable idempotent host sink driven by deterministic start outcomes. */
export interface ScriptedWorkflowSink extends RecordingWorkflowSink {
  readonly acceptedRuns: ReadonlyArray<AcceptedWorkflowStart>
}

/**
 * Create an idempotent host sink that consumes one outcome per new start.
 * Accepted starts are replayed by key before another scripted outcome is used.
 */
export const makeScriptedWorkflowSink = (
  outcomes: ReadonlyArray<WorkflowStartScriptOutcome>,
): ScriptedWorkflowSink => {
  const attempts: Array<StartWorkflowInput> = []
  const acceptedRuns: Array<AcceptedWorkflowStart> = []
  const fingerprints = new Map<string, string>()
  const acceptedByKey = new Map<string, WorkflowRunId>()
  let nextOutcome = 0

  const fingerprint = (event: EmailReceivedEventV1): string => JSON.stringify(
    Schema.encodeSync(EmailReceivedEventV1Schema)(event),
  )

  const accept = (
    input: StartWorkflowInput,
    runId: WorkflowRunId,
  ): void => {
    acceptedByKey.set(input.idempotencyKey, runId)
    acceptedRuns.push({ input, runId })
  }

  const service = WorkflowTriggerSink.of({
    start: (
      input,
    ): Effect.Effect<WorkflowRunId, WorkflowStartFailure> => Effect.suspend<
      WorkflowRunId,
      WorkflowStartFailure,
      never
    >(() => {
      attempts.push(input)
      const encodedEvent = fingerprint(input.event)
      const boundFingerprint = fingerprints.get(input.idempotencyKey)
      if (
        boundFingerprint !== undefined &&
        boundFingerprint !== encodedEvent
      ) {
        return Effect.fail(new WorkflowStartPermanentFailure({
          reason: "idempotency_conflict",
        }))
      }
      if (boundFingerprint === undefined) {
        fingerprints.set(input.idempotencyKey, encodedEvent)
      }

      const acceptedRunId = acceptedByKey.get(input.idempotencyKey)
      if (acceptedRunId !== undefined) {
        return Effect.succeed(acceptedRunId)
      }

      const outcome = outcomes[nextOutcome]
      if (outcome === undefined) {
        return Effect.die(new Error("Workflow start script exhausted"))
      }
      nextOutcome += 1

      switch (outcome._tag) {
        case "Accept":
          accept(input, outcome.runId)
          return Effect.succeed(outcome.runId)
        case "DefiniteFailure":
          return Effect.fail(new WorkflowStartDefiniteFailure({
            reason: outcome.reason,
          }))
        case "FailAfterPossibleAcceptance":
          accept(input, outcome.runId)
          return Effect.fail(new WorkflowStartAmbiguousFailure({
            reason: outcome.reason,
          }))
        case "PermanentFailure":
          return Effect.fail(new WorkflowStartPermanentFailure({
            reason: outcome.reason,
          }))
      }
    }),
  })

  return {
    service,
    get attempts() {
      return Array.from(attempts)
    },
    get events() {
      return attempts.map((input) => input.event)
    },
    get acceptedRuns() {
      return Array.from(acceptedRuns)
    },
    layer: Layer.succeed(WorkflowTriggerSink, service),
  }
}
