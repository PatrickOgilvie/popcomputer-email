import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { IdentifierGenerator } from "../../../src/adapters/identifier-generator.js"
import {
  defaultConfig,
  layer as workflowLayer,
  WorkflowService,
} from "../../../src/application/workflow-service.js"
import {
  MessageIdSchema,
  NamespaceSchema,
  RouteIdSchema,
  WorkflowEventIdSchema,
  WorkflowIdSchema,
  WorkflowRunIdSchema,
} from "../../../src/core/identifiers.js"
import { EmailAddressSchema } from "../../../src/core/address.js"
import { ScopeSchema } from "../../../src/core/scope.js"
import {
  dispatchIdempotencyKey,
  WorkflowEventSchema,
} from "../../../src/core/workflow.js"
import { makeDeterministicIdentifiers } from "../../../src/testing/identifiers.js"
import {
  makeInMemoryWorkflowStore,
  makeScriptedWorkflowSink,
  type ScriptedWorkflowSink,
  WorkflowStartScriptOutcomeSchema,
} from "../../../src/testing/workflow.js"

const scope = ScopeSchema.make({
  namespace: NamespaceSchema.make("namespace-workflow-service"),
  environment: "test",
})

const pendingEvent = (
  suffix: string,
  subject = "hello",
): typeof WorkflowEventSchema.Type => {
  const now = DateTime.makeUnsafe(0)
  return WorkflowEventSchema.make({
    event: {
      schemaVersion: 1,
      type: "email.received",
      eventId: WorkflowEventIdSchema.make(`event:${suffix}`),
      occurredAt: now,
      scope,
      workflowId: WorkflowIdSchema.make(`workflow:${suffix}`),
      message: {
        id: MessageIdSchema.make(`message:${suffix}`),
        routeId: RouteIdSchema.make(`route:${suffix}`),
        from: EmailAddressSchema.make("sender@example.net"),
        to: [EmailAddressSchema.make("inbox@example.com")],
        subject,
        sizeBytes: 10,
        receivedAt: now,
      },
    },
    state: WorkflowEventSchema.fields.state.cases.Pending.make({
      nextAttemptAt: now,
    }),
    createdAt: now,
    updatedAt: now,
  })
}

const liveWorkflow = (
  event: typeof WorkflowEventSchema.Type,
  sink: ScriptedWorkflowSink,
  maxAttempts = defaultConfig.maxAttempts,
) => {
  const store = makeInMemoryWorkflowStore([event])
  const dependencies = Layer.mergeAll(
    Layer.succeed(
      IdentifierGenerator,
      makeDeterministicIdentifiers("workflow-service"),
    ),
    store.layer,
    sink.layer,
  )
  const layer = workflowLayer({
    ...defaultConfig,
    concurrency: 1,
    maxAttempts,
  }).pipe(Layer.provide(dependencies))
  return { layer, store }
}

describe("workflow service", () => {
  test("retries a definite pre-handoff failure with the same key", async () => {
    const event = pendingEvent("definite")
    const runId = WorkflowRunIdSchema.make("run:definite")
    const sink = makeScriptedWorkflowSink([
      WorkflowStartScriptOutcomeSchema.cases.DefiniteFailure.make({
        reason: "rate_limited",
      }),
      WorkflowStartScriptOutcomeSchema.cases.Accept.make({ runId }),
    ])
    const live = liveWorkflow(event, sink)

    const observed = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* WorkflowService
      const first = yield* service.dispatchReady()
      const firstState = live.store.events[0]?.state
      const beforeDue = yield* service.dispatchReady()
      yield* TestClock.adjust("1 second")
      const retry = yield* service.dispatchReady()
      return { beforeDue, first, firstState, retry }
    }).pipe(
      Effect.provide(live.layer),
      Effect.provide(TestClock.layer()),
    ))

    expect(observed.first.failed).toBe(1)
    expect(observed.beforeDue.selected).toBe(0)
    expect(observed.retry.started).toBe(1)
    expect(observed.firstState?._tag).toBe("Failed")
    if (observed.firstState?._tag === "Failed") {
      expect(String(observed.firstState.reason)).toBe(
        "workflow_runtime.definite.rate_limited",
      )
    }
    expect(sink.attempts).toHaveLength(2)
    expect(sink.attempts[0]?.idempotencyKey).toBe(
      sink.attempts[1]?.idempotencyKey,
    )
    expect(sink.attempts[0]?.event).toEqual(event.event)
    expect(sink.attempts[1]?.event).toEqual(event.event)
    const secondAttempt = sink.attempts[1]
    if (secondAttempt === undefined) {
      throw new Error("Expected the second workflow attempt")
    }
    expect(sink.acceptedRuns).toEqual([{
      input: secondAttempt,
      runId,
    }])
  })

  test("replays an ambiguously accepted start without creating another run", async () => {
    const event = pendingEvent("ambiguous")
    const runId = WorkflowRunIdSchema.make("run:ambiguous")
    const sink = makeScriptedWorkflowSink([
      WorkflowStartScriptOutcomeSchema.cases.FailAfterPossibleAcceptance.make({
        runId,
        reason: "transport",
      }),
    ])
    const live = liveWorkflow(event, sink)

    const observed = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* WorkflowService
      const first = yield* service.dispatchReady()
      const firstState = live.store.events[0]?.state
      yield* TestClock.adjust("1 second")
      const retry = yield* service.dispatchReady()
      return { first, firstState, retry }
    }).pipe(
      Effect.provide(live.layer),
      Effect.provide(TestClock.layer()),
    ))

    expect(observed.first.failed).toBe(1)
    expect(observed.retry.started).toBe(1)
    expect(observed.firstState?._tag).toBe("Failed")
    if (observed.firstState?._tag === "Failed") {
      expect(String(observed.firstState.reason)).toBe(
        "workflow_runtime.ambiguous.transport",
      )
    }
    expect(sink.attempts).toHaveLength(2)
    expect(sink.attempts[0]?.idempotencyKey).toBe(
      sink.attempts[1]?.idempotencyKey,
    )
    expect(sink.acceptedRuns).toHaveLength(1)
    expect(sink.acceptedRuns[0]?.runId).toBe(runId)
    expect(live.store.events[0]?.state._tag).toBe("Started")
    if (live.store.events[0]?.state._tag === "Started") {
      expect(live.store.events[0].state.runId).toBe(runId)
    }
  })

  test("dead-letters a permanent start failure without retrying", async () => {
    const event = pendingEvent("permanent")
    const sink = makeScriptedWorkflowSink([
      WorkflowStartScriptOutcomeSchema.cases.PermanentFailure.make({
        reason: "invalid_workflow",
      }),
    ])
    const live = liveWorkflow(event, sink)

    const observed = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* WorkflowService
      const first = yield* service.dispatchReady()
      yield* TestClock.adjust("1 hour")
      const later = yield* service.dispatchReady()
      return { first, later }
    }).pipe(
      Effect.provide(live.layer),
      Effect.provide(TestClock.layer()),
    ))

    expect(observed.first).toEqual({
      selected: 1,
      claimed: 1,
      started: 0,
      failed: 0,
      dead: 1,
    })
    expect(observed.later.selected).toBe(0)
    expect(sink.attempts).toHaveLength(1)
    expect(live.store.events[0]?.state._tag).toBe("Dead")
    if (live.store.events[0]?.state._tag === "Dead") {
      expect(String(live.store.events[0].state.reason)).toBe(
        "workflow_runtime.permanent.invalid_workflow",
      )
    }
  })

  test("dead-letters a retryable failure when its attempt budget is spent", async () => {
    const event = pendingEvent("attempt-budget")
    const sink = makeScriptedWorkflowSink([
      WorkflowStartScriptOutcomeSchema.cases.DefiniteFailure.make({
        reason: "unavailable_before_handoff",
      }),
      WorkflowStartScriptOutcomeSchema.cases.DefiniteFailure.make({
        reason: "rejected_before_start",
      }),
    ])
    const live = liveWorkflow(event, sink, 2)

    const observed = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* WorkflowService
      const first = yield* service.dispatchReady()
      yield* TestClock.adjust("1 second")
      const second = yield* service.dispatchReady()
      return { first, second }
    }).pipe(
      Effect.provide(live.layer),
      Effect.provide(TestClock.layer()),
    ))

    expect(observed.first.failed).toBe(1)
    expect(observed.second.dead).toBe(1)
    expect(sink.attempts).toHaveLength(2)
    expect(live.store.events[0]?.state._tag).toBe("Dead")
    if (live.store.events[0]?.state._tag === "Dead") {
      expect(String(live.store.events[0].state.reason)).toBe(
        "workflow_runtime.definite.rejected_before_start",
      )
    }
  })

  test("rejects one key for a different event before consuming the script", async () => {
    const first = pendingEvent("sink-first")
    const next = pendingEvent("sink-next")
    const firstRunId = WorkflowRunIdSchema.make("run:sink-first")
    const nextRunId = WorkflowRunIdSchema.make("run:sink-next")
    const sink = makeScriptedWorkflowSink([
      WorkflowStartScriptOutcomeSchema.cases.Accept.make({
        runId: firstRunId,
      }),
      WorkflowStartScriptOutcomeSchema.cases.Accept.make({
        runId: nextRunId,
      }),
    ])
    const firstInput = {
      event: first.event,
      idempotencyKey: dispatchIdempotencyKey(first.event.eventId),
    }

    const observed = await Effect.runPromise(Effect.gen(function*() {
      const accepted = yield* sink.service.start(firstInput)
      const conflict = yield* Effect.result(sink.service.start({
        ...firstInput,
        event: {
          ...first.event,
          message: {
            ...first.event.message,
            subject: "different payload",
          },
        },
      }))
      const nextAccepted = yield* sink.service.start({
        event: next.event,
        idempotencyKey: dispatchIdempotencyKey(next.event.eventId),
      })
      return { accepted, conflict, nextAccepted }
    }))

    expect(observed.accepted).toBe(firstRunId)
    expect(observed.conflict._tag).toBe("Failure")
    if (observed.conflict._tag === "Failure") {
      expect(observed.conflict.failure._tag).toBe(
        "WorkflowStartPermanentFailure",
      )
      expect(observed.conflict.failure.reason).toBe("idempotency_conflict")
    }
    expect(observed.nextAccepted).toBe(nextRunId)
    expect(sink.attempts).toHaveLength(3)
    expect(sink.acceptedRuns.map(({ runId }) => runId)).toEqual([
      firstRunId,
      nextRunId,
    ])
  })
})
