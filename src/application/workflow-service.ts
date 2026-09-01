import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { IdentifierGenerator } from "../adapters/identifier-generator.js"
import {
  MaximumWorkflowReadyLimit,
  WorkflowStore,
  type WorkflowStoreFailure,
  type WorkflowStoreLeaseConflict,
} from "../adapters/workflow-store.js"
import { WorkflowTriggerSink } from "../adapters/workflow-trigger-sink.js"
import {
  MaximumOperationalDurationMilliseconds,
  OperationalDurationMillisecondsSchema,
} from "../core/operational-duration.js"
import {
  isPositiveSafeInteger,
  PositiveSafeIntegerSchema,
} from "../core/positive-safe-integer.js"
import {
  dispatchIdempotencyKey,
  lease,
  type DispatchableWorkflowEvent,
  type WorkflowFailureReason,
  type WorkflowStartFailure,
  WorkflowAttemptSchema,
  WorkflowFailureReasonSchema,
} from "../core/workflow.js"

/** Runtime schema for a workflow batch accepted by every shipped store. */
export const WorkflowDispatchLimitSchema = PositiveSafeIntegerSchema.check(
  Schema.isLessThanOrEqualTo(MaximumWorkflowReadyLimit),
)

/** Runtime schema for durable workflow dispatch policy. */
export const WorkflowDispatchConfigSchema = Schema.Struct({
  defaultLimit: WorkflowDispatchLimitSchema,
  maxLimit: WorkflowDispatchLimitSchema,
  concurrency: PositiveSafeIntegerSchema,
  maxAttempts: PositiveSafeIntegerSchema,
  leaseMilliseconds: OperationalDurationMillisecondsSchema,
  baseRetryMilliseconds: OperationalDurationMillisecondsSchema,
  maxRetryMilliseconds: OperationalDurationMillisecondsSchema,
})

/** Retry, lease, and batch policy for the durable workflow dispatcher. */
export interface WorkflowDispatchConfig extends Schema.Schema.Type<
  typeof WorkflowDispatchConfigSchema
> {}

/** Conservative default dispatch policy. */
export const defaultConfig: WorkflowDispatchConfig = {
  defaultLimit: 25,
  maxLimit: 100,
  concurrency: 4,
  maxAttempts: 5,
  leaseMilliseconds: 60_000,
  baseRetryMilliseconds: 1_000,
  maxRetryMilliseconds: 60 * 60 * 1_000,
}

/** One workflow dispatch policy field was outside its supported range. */
export class InvalidWorkflowDispatchConfig extends Schema.TaggedError<
  InvalidWorkflowDispatchConfig
>()("InvalidWorkflowDispatchConfig", {
  field: Schema.Literals([
    "defaultLimit",
    "maxLimit",
    "concurrency",
    "maxAttempts",
    "leaseMilliseconds",
    "baseRetryMilliseconds",
    "maxRetryMilliseconds",
  ]),
  reason: Schema.Literals([
    "not_positive_safe_integer",
    "exceeds_supported_maximum",
  ]),
}) {}

type WorkflowDispatchConfigField =
  | "defaultLimit"
  | "maxLimit"
  | "concurrency"
  | "maxAttempts"
  | "leaseMilliseconds"
  | "baseRetryMilliseconds"
  | "maxRetryMilliseconds"

const invalidWorkflowDispatchConfigField = (
  config: WorkflowDispatchConfig,
): WorkflowDispatchConfigField | undefined => {
  if (!isPositiveSafeInteger(config.defaultLimit)) return "defaultLimit"
  if (!isPositiveSafeInteger(config.maxLimit)) return "maxLimit"
  if (!isPositiveSafeInteger(config.concurrency)) return "concurrency"
  if (!isPositiveSafeInteger(config.maxAttempts)) return "maxAttempts"
  if (!isPositiveSafeInteger(config.leaseMilliseconds)) {
    return "leaseMilliseconds"
  }
  if (!isPositiveSafeInteger(config.baseRetryMilliseconds)) {
    return "baseRetryMilliseconds"
  }
  if (!isPositiveSafeInteger(config.maxRetryMilliseconds)) {
    return "maxRetryMilliseconds"
  }
  return undefined
}

/** Validate and detach one caller-owned workflow dispatch policy. */
export const parseWorkflowDispatchConfig = Effect.fn(
  "Email.workflow.parseConfig",
)(function*(config: WorkflowDispatchConfig) {
  const field = invalidWorkflowDispatchConfigField(config)
  if (field !== undefined) {
    return yield* new InvalidWorkflowDispatchConfig({
      field,
      reason: "not_positive_safe_integer",
    })
  }
  if (config.defaultLimit > MaximumWorkflowReadyLimit) {
    return yield* new InvalidWorkflowDispatchConfig({
      field: "defaultLimit",
      reason: "exceeds_supported_maximum",
    })
  }
  if (config.maxLimit > MaximumWorkflowReadyLimit) {
    return yield* new InvalidWorkflowDispatchConfig({
      field: "maxLimit",
      reason: "exceeds_supported_maximum",
    })
  }
  if (config.leaseMilliseconds > MaximumOperationalDurationMilliseconds) {
    return yield* new InvalidWorkflowDispatchConfig({
      field: "leaseMilliseconds",
      reason: "exceeds_supported_maximum",
    })
  }
  if (
    config.baseRetryMilliseconds > MaximumOperationalDurationMilliseconds
  ) {
    return yield* new InvalidWorkflowDispatchConfig({
      field: "baseRetryMilliseconds",
      reason: "exceeds_supported_maximum",
    })
  }
  if (
    config.maxRetryMilliseconds > MaximumOperationalDurationMilliseconds
  ) {
    return yield* new InvalidWorkflowDispatchConfig({
      field: "maxRetryMilliseconds",
      reason: "exceeds_supported_maximum",
    })
  }
  return {
    defaultLimit: config.defaultLimit,
    maxLimit: config.maxLimit,
    concurrency: config.concurrency,
    maxAttempts: config.maxAttempts,
    leaseMilliseconds: config.leaseMilliseconds,
    baseRetryMilliseconds: config.baseRetryMilliseconds,
    maxRetryMilliseconds: config.maxRetryMilliseconds,
  }
})

/** Runtime schema for optional bounded overrides on one dispatch pass. */
export const DispatchReadyInputSchema = Schema.Struct({
  limit: Schema.optionalKey(WorkflowDispatchLimitSchema),
  concurrency: Schema.optionalKey(PositiveSafeIntegerSchema),
})

/** Optional bounded override for one scheduled dispatch pass. */
export interface DispatchReadyInput extends Schema.Schema.Type<
  typeof DispatchReadyInputSchema
> {}

/** One per-dispatch override was outside its supported range. */
export class InvalidWorkflowDispatchInput extends Schema.TaggedError<
  InvalidWorkflowDispatchInput
>()("InvalidWorkflowDispatchInput", {
  field: Schema.Literals(["limit", "concurrency"]),
  reason: Schema.Literals([
    "not_positive_safe_integer",
    "exceeds_supported_maximum",
  ]),
}) {}

/** Validate and detach optional caller-owned per-dispatch overrides. */
export const parseDispatchReadyInput = Effect.fn(
  "Email.workflow.parseDispatchInput",
)(function*(input: DispatchReadyInput) {
  if (input.limit !== undefined && !isPositiveSafeInteger(input.limit)) {
    return yield* new InvalidWorkflowDispatchInput({
      field: "limit",
      reason: "not_positive_safe_integer",
    })
  }
  if (
    input.limit !== undefined &&
    input.limit > MaximumWorkflowReadyLimit
  ) {
    return yield* new InvalidWorkflowDispatchInput({
      field: "limit",
      reason: "exceeds_supported_maximum",
    })
  }
  if (
    input.concurrency !== undefined &&
    !isPositiveSafeInteger(input.concurrency)
  ) {
    return yield* new InvalidWorkflowDispatchInput({
      field: "concurrency",
      reason: "not_positive_safe_integer",
    })
  }
  if (input.limit === undefined) {
    return input.concurrency === undefined
      ? {}
      : { concurrency: input.concurrency }
  }
  return input.concurrency === undefined
    ? { limit: input.limit }
    : { limit: input.limit, concurrency: input.concurrency }
})

/** Durable result of one bounded outbox pass. */
export interface DispatchReadyResult {
  readonly selected: number
  readonly claimed: number
  readonly started: number
  readonly failed: number
  readonly dead: number
}

/** Store failures and lost completion leases remain visible to the scheduler. */
export type WorkflowDispatchError =
  | InvalidWorkflowDispatchInput
  | WorkflowStoreFailure
  | WorkflowStoreLeaseConflict

const safeReason = (
  failure: WorkflowStartFailure,
): WorkflowFailureReason => {
  switch (failure._tag) {
    case "WorkflowStartDefiniteFailure":
      return WorkflowFailureReasonSchema.make(
        `workflow_runtime.definite.${failure.reason}`,
      )
    case "WorkflowStartAmbiguousFailure":
      return WorkflowFailureReasonSchema.make(
        `workflow_runtime.ambiguous.${failure.reason}`,
      )
    case "WorkflowStartPermanentFailure":
      return WorkflowFailureReasonSchema.make(
        `workflow_runtime.permanent.${failure.reason}`,
      )
  }
}

const attemptOf = (
  event: DispatchableWorkflowEvent,
): typeof WorkflowAttemptSchema.Type =>
  WorkflowAttemptSchema.make(
    event.state._tag === "Pending" ? 1 : event.state.attempt + 1,
  )

const retryDelay = (
  attempt: number,
  config: WorkflowDispatchConfig,
): number => Math.min(
  config.maxRetryMilliseconds,
  config.baseRetryMilliseconds * (2 ** Math.max(0, attempt - 1)),
)

/** Durable workflow-event outbox dispatcher. */
export class WorkflowService extends Context.Service<WorkflowService, {
  readonly dispatchReady: (
    input?: DispatchReadyInput,
  ) => Effect.Effect<DispatchReadyResult, WorkflowDispatchError>
}>()("@popcomputer/email/WorkflowService") {}

type WorkflowServiceDependencies =
  | IdentifierGenerator
  | WorkflowStore
  | WorkflowTriggerSink

const layerFromParsedConfig = (
  config: WorkflowDispatchConfig,
): Layer.Layer<
  WorkflowService,
  never,
  WorkflowServiceDependencies
> => Layer.effect(
  WorkflowService,
  Effect.gen(function*() {
    const identifiers = yield* IdentifierGenerator
    const store = yield* WorkflowStore
    const sink = yield* WorkflowTriggerSink

    const dispatchOne = Effect.fn("Email.workflow.dispatchOne")(function*(
      event: DispatchableWorkflowEvent,
    ) {
      const leasedAt = yield* DateTime.now
      const leaseToken = yield* identifiers.leaseToken
      const leased = lease(event, {
        attempt: attemptOf(event),
        leaseToken,
        leasedAt,
        leaseExpiresAt: DateTime.addDuration(
          leasedAt,
          config.leaseMilliseconds,
        ),
      })
      const claimed = yield* store.claim({
        event,
        leaseToken,
        leasedAt,
        leaseExpiresAt: leased.state.leaseExpiresAt,
      })
      if (Option.isNone(claimed)) {
        return { _tag: "NotClaimed" } as const
      }

      if (claimed.value.state.attempt > config.maxAttempts) {
        const deadAt = yield* DateTime.now
        yield* store.markDead({
          event: claimed.value,
          leaseToken,
          deadAt,
          reason: WorkflowFailureReasonSchema.make(
            "workflow_dispatch.max_attempts",
          ),
        })
        return { _tag: "Dead" } as const
      }

      const accepted = yield* Effect.result(sink.start({
        event: claimed.value.event,
        idempotencyKey: dispatchIdempotencyKey(claimed.value.event.eventId),
      }))
      const completedAt = yield* DateTime.now
      if (accepted._tag === "Success") {
        yield* store.markStarted({
          event: claimed.value,
          leaseToken,
          runId: accepted.success,
          startedAt: completedAt,
        })
        return { _tag: "Started" } as const
      }

      const reason = safeReason(accepted.failure)
      if (accepted.failure._tag === "WorkflowStartPermanentFailure") {
        yield* store.markDead({
          event: claimed.value,
          leaseToken,
          deadAt: completedAt,
          reason,
        })
        return { _tag: "Dead" } as const
      }
      if (claimed.value.state.attempt >= config.maxAttempts) {
        yield* store.markDead({
          event: claimed.value,
          leaseToken,
          deadAt: completedAt,
          reason,
        })
        return { _tag: "Dead" } as const
      }
      yield* store.markFailed({
        event: claimed.value,
        leaseToken,
        failedAt: completedAt,
        nextAttemptAt: DateTime.addDuration(
          completedAt,
          retryDelay(claimed.value.state.attempt, config),
        ),
        reason,
      })
      return { _tag: "Failed" } as const
    })

    return WorkflowService.of({
      dispatchReady: Effect.fn("Email.workflow.dispatchReady")(
        function*(input: DispatchReadyInput = {}) {
          const requested = yield* parseDispatchReadyInput(input)
          const now = yield* DateTime.now
          const limit = Math.max(
            1,
            Math.min(
              config.maxLimit,
              requested.limit ?? config.defaultLimit,
            ),
          )
          const concurrency = Math.max(
            1,
            Math.min(
              limit,
              requested.concurrency ?? config.concurrency,
            ),
          )
          const ready = yield* store.listReady({ now, limit })
          const outcomes = yield* Effect.forEach(ready, dispatchOne, {
            concurrency,
          })
          return {
            selected: ready.length,
            claimed: outcomes.filter(
              (outcome) => outcome._tag !== "NotClaimed",
            ).length,
            started: outcomes.filter(
              (outcome) => outcome._tag === "Started",
            ).length,
            failed: outcomes.filter(
              (outcome) => outcome._tag === "Failed",
            ).length,
            dead: outcomes.filter(
              (outcome) => outcome._tag === "Dead",
            ).length,
          }
        },
        (effect) => effect.pipe(
          Effect.provideService(IdentifierGenerator, identifiers),
          Effect.provideService(WorkflowStore, store),
          Effect.provideService(WorkflowTriggerSink, sink),
        ),
      ),
    })
  }),
)

/** Build a workflow dispatcher with conservative package defaults. */
export function layer(): Layer.Layer<
  WorkflowService,
  never,
  WorkflowServiceDependencies
>

/** Validate and build a workflow dispatcher with an explicit policy. */
export function layer(
  config: WorkflowDispatchConfig,
): Layer.Layer<
  WorkflowService,
  InvalidWorkflowDispatchConfig,
  WorkflowServiceDependencies
>

export function layer(
  config?: WorkflowDispatchConfig,
): Layer.Layer<
  WorkflowService,
  InvalidWorkflowDispatchConfig,
  WorkflowServiceDependencies
> {
  if (config === undefined) return layerFromParsedConfig(defaultConfig)
  return Layer.unwrap(
    parseWorkflowDispatchConfig(config).pipe(
      Effect.map(layerFromParsedConfig),
    ),
  )
}
