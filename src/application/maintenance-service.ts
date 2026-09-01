import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { IdentifierGenerator } from "../adapters/identifier-generator.js"
import {
  MaximumMaintenanceBatchLimit,
  MaintenanceStore,
  type MaintenanceStoreFailure,
} from "../adapters/maintenance-store.js"
import {
  RawMessageArchive,
} from "../adapters/raw-message-archive.js"
import {
  MaximumOperationalDurationMilliseconds,
  OperationalDurationMillisecondsSchema,
} from "../core/operational-duration.js"
import {
  isPositiveSafeInteger,
  PositiveSafeIntegerSchema,
} from "../core/positive-safe-integer.js"

/** Runtime schema for a maintenance batch accepted by every shipped store. */
export const MaintenanceLimitSchema = PositiveSafeIntegerSchema.check(
  Schema.isLessThanOrEqualTo(MaximumMaintenanceBatchLimit),
)

/** Runtime schema for crash-recovery and archive-cleanup policy. */
export const MaintenanceConfigSchema = Schema.Struct({
  defaultLimit: MaintenanceLimitSchema,
  maxLimit: MaintenanceLimitSchema,
  staleSendingMilliseconds: OperationalDurationMillisecondsSchema,
  cleanupLeaseMilliseconds: OperationalDurationMillisecondsSchema,
  cleanupBaseRetryMilliseconds: OperationalDurationMillisecondsSchema,
  cleanupMaxRetryMilliseconds: OperationalDurationMillisecondsSchema,
  cleanupMaxAttempts: PositiveSafeIntegerSchema,
})

/** Bounded scheduler policy for crash recovery and archive cleanup. */
export interface MaintenanceConfig extends Schema.Schema.Type<
  typeof MaintenanceConfigSchema
> {}

/** Conservative maintenance defaults. */
export const defaultConfig: MaintenanceConfig = {
  defaultLimit: 100,
  maxLimit: 500,
  staleSendingMilliseconds: 15 * 60 * 1_000,
  cleanupLeaseMilliseconds: 60_000,
  cleanupBaseRetryMilliseconds: 60_000,
  cleanupMaxRetryMilliseconds: 24 * 60 * 60 * 1_000,
  cleanupMaxAttempts: 10,
}

/** One maintenance policy field was outside its supported range. */
export class InvalidMaintenanceConfig extends Schema.TaggedError<
  InvalidMaintenanceConfig
>()("InvalidMaintenanceConfig", {
  field: Schema.Literals([
    "defaultLimit",
    "maxLimit",
    "staleSendingMilliseconds",
    "cleanupLeaseMilliseconds",
    "cleanupBaseRetryMilliseconds",
    "cleanupMaxRetryMilliseconds",
    "cleanupMaxAttempts",
  ]),
  reason: Schema.Literals([
    "not_positive_safe_integer",
    "exceeds_supported_maximum",
  ]),
}) {}

/** A per-call maintenance limit was outside its supported range. */
export class InvalidMaintenanceLimit extends Schema.TaggedError<
  InvalidMaintenanceLimit
>()("InvalidMaintenanceLimit", {
  reason: Schema.Literals([
    "not_positive_safe_integer",
    "exceeds_supported_maximum",
  ]),
}) {}

type MaintenanceConfigField =
  | "defaultLimit"
  | "maxLimit"
  | "staleSendingMilliseconds"
  | "cleanupLeaseMilliseconds"
  | "cleanupBaseRetryMilliseconds"
  | "cleanupMaxRetryMilliseconds"
  | "cleanupMaxAttempts"

const invalidMaintenanceConfigField = (
  config: MaintenanceConfig,
): MaintenanceConfigField | undefined => {
  if (!isPositiveSafeInteger(config.defaultLimit)) return "defaultLimit"
  if (!isPositiveSafeInteger(config.maxLimit)) return "maxLimit"
  if (!isPositiveSafeInteger(config.staleSendingMilliseconds)) {
    return "staleSendingMilliseconds"
  }
  if (!isPositiveSafeInteger(config.cleanupLeaseMilliseconds)) {
    return "cleanupLeaseMilliseconds"
  }
  if (!isPositiveSafeInteger(config.cleanupBaseRetryMilliseconds)) {
    return "cleanupBaseRetryMilliseconds"
  }
  if (!isPositiveSafeInteger(config.cleanupMaxRetryMilliseconds)) {
    return "cleanupMaxRetryMilliseconds"
  }
  if (!isPositiveSafeInteger(config.cleanupMaxAttempts)) {
    return "cleanupMaxAttempts"
  }
  return undefined
}

/** Validate and detach one caller-owned maintenance policy. */
export const parseMaintenanceConfig = Effect.fn(
  "Email.maintenance.parseConfig",
)(function*(config: MaintenanceConfig) {
  const field = invalidMaintenanceConfigField(config)
  if (field !== undefined) {
    return yield* new InvalidMaintenanceConfig({
      field,
      reason: "not_positive_safe_integer",
    })
  }
  if (config.defaultLimit > MaximumMaintenanceBatchLimit) {
    return yield* new InvalidMaintenanceConfig({
      field: "defaultLimit",
      reason: "exceeds_supported_maximum",
    })
  }
  if (config.maxLimit > MaximumMaintenanceBatchLimit) {
    return yield* new InvalidMaintenanceConfig({
      field: "maxLimit",
      reason: "exceeds_supported_maximum",
    })
  }
  if (
    config.staleSendingMilliseconds > MaximumOperationalDurationMilliseconds
  ) {
    return yield* new InvalidMaintenanceConfig({
      field: "staleSendingMilliseconds",
      reason: "exceeds_supported_maximum",
    })
  }
  if (
    config.cleanupLeaseMilliseconds > MaximumOperationalDurationMilliseconds
  ) {
    return yield* new InvalidMaintenanceConfig({
      field: "cleanupLeaseMilliseconds",
      reason: "exceeds_supported_maximum",
    })
  }
  if (
    config.cleanupBaseRetryMilliseconds >
      MaximumOperationalDurationMilliseconds
  ) {
    return yield* new InvalidMaintenanceConfig({
      field: "cleanupBaseRetryMilliseconds",
      reason: "exceeds_supported_maximum",
    })
  }
  if (
    config.cleanupMaxRetryMilliseconds >
      MaximumOperationalDurationMilliseconds
  ) {
    return yield* new InvalidMaintenanceConfig({
      field: "cleanupMaxRetryMilliseconds",
      reason: "exceeds_supported_maximum",
    })
  }
  return {
    defaultLimit: config.defaultLimit,
    maxLimit: config.maxLimit,
    staleSendingMilliseconds: config.staleSendingMilliseconds,
    cleanupLeaseMilliseconds: config.cleanupLeaseMilliseconds,
    cleanupBaseRetryMilliseconds: config.cleanupBaseRetryMilliseconds,
    cleanupMaxRetryMilliseconds: config.cleanupMaxRetryMilliseconds,
    cleanupMaxAttempts: config.cleanupMaxAttempts,
  }
})

/** Parse one caller-supplied maintenance batch limit. */
export const parseMaintenanceLimit = Effect.fn(
  "Email.maintenance.parseLimit",
)(function*(limit: number) {
  if (!isPositiveSafeInteger(limit)) {
    return yield* new InvalidMaintenanceLimit({
      reason: "not_positive_safe_integer",
    })
  }
  if (limit > MaximumMaintenanceBatchLimit) {
    return yield* new InvalidMaintenanceLimit({
      reason: "exceeds_supported_maximum",
    })
  }
  return limit
})

/** Summary of one bounded raw-archive cleanup pass. */
export interface ArchiveCleanupResult {
  readonly selected: number
  readonly claimed: number
  readonly removed: number
  readonly rescheduled: number
  readonly dead: number
}

/** Maintenance exposes invalid calls and store failures; archive failures are persisted. */
export type MaintenanceError = InvalidMaintenanceLimit | MaintenanceStoreFailure

const retryDelay = (attempt: number, config: MaintenanceConfig): number =>
  Math.min(
    config.cleanupMaxRetryMilliseconds,
    config.cleanupBaseRetryMilliseconds * (2 ** Math.max(0, attempt)),
  )

/** Scheduler-facing maintenance capability. */
export class MaintenanceService extends Context.Service<MaintenanceService, {
  readonly recoverStaleSending: (
    limit?: number,
  ) => Effect.Effect<number, MaintenanceError>
  readonly cleanupRawArchives: (
    limit?: number,
  ) => Effect.Effect<ArchiveCleanupResult, MaintenanceError>
}>()("@popcomputer/email/MaintenanceService") {}

type MaintenanceServiceDependencies =
  | IdentifierGenerator
  | MaintenanceStore
  | RawMessageArchive

const layerFromParsedConfig = (
  config: MaintenanceConfig,
): Layer.Layer<
  MaintenanceService,
  never,
  MaintenanceServiceDependencies
> => Layer.effect(
  MaintenanceService,
  Effect.gen(function*() {
    const identifiers = yield* IdentifierGenerator
    const store = yield* MaintenanceStore
    const archive = yield* RawMessageArchive

    const bounded = Effect.fn("Email.maintenance.boundedLimit")(
      function*(limit: number | undefined) {
        const requested = limit === undefined
          ? config.defaultLimit
          : yield* parseMaintenanceLimit(limit)
        return Math.min(config.maxLimit, requested)
      },
    )

    return MaintenanceService.of({
      recoverStaleSending: Effect.fn(
        "Email.maintenance.recoverStaleSending",
      )(function*(limit) {
        const boundedLimit = yield* bounded(limit)
        const now = yield* DateTime.now
        return yield* store.recoverStaleSending({
          staleBefore: DateTime.subtractDuration(
            now,
            config.staleSendingMilliseconds,
          ),
          occurredAt: now,
          limit: boundedLimit,
        })
      }),
      cleanupRawArchives: Effect.fn(
        "Email.maintenance.cleanupRawArchives",
      )(function*(limit) {
        const boundedLimit = yield* bounded(limit)
        const listedAt = yield* DateTime.now
        const items = yield* store.listArchiveCleanup({
          now: listedAt,
          limit: boundedLimit,
        })
        const outcomes = yield* Effect.forEach(items, (item) =>
          Effect.gen(function*() {
            const claimedAt = yield* DateTime.now
            const leaseToken = yield* identifiers.leaseToken
            const claimed = yield* store.claimArchiveCleanup({
              item,
              leaseToken,
              leaseExpiresAt: DateTime.addDuration(
                claimedAt,
                config.cleanupLeaseMilliseconds,
              ),
            })
            if (Option.isNone(claimed)) return "not_claimed" as const
            const removed = yield* Effect.result(archive.remove(item.rawRef))
            if (removed._tag === "Success") {
              yield* store.completeArchiveCleanup(claimed.value)
              return "removed" as const
            }
            const dead = item.attempt + 1 >= config.cleanupMaxAttempts
            const failedAt = yield* DateTime.now
            yield* store.failArchiveCleanup({
              item: claimed.value,
              nextAttemptAt: DateTime.addDuration(
                failedAt,
                retryDelay(item.attempt, config),
              ),
              dead,
              safeErrorCode: "archive_remove_failed",
            })
            return dead ? "dead" as const : "rescheduled" as const
          }), { concurrency: 4 })
        return {
          selected: items.length,
          claimed: outcomes.filter((outcome) => outcome !== "not_claimed").length,
          removed: outcomes.filter((outcome) => outcome === "removed").length,
          rescheduled: outcomes.filter((outcome) => outcome === "rescheduled").length,
          dead: outcomes.filter((outcome) => outcome === "dead").length,
        }
      }),
    })
  }),
)

/** Build maintenance workflows with conservative package defaults. */
export function layer(): Layer.Layer<
  MaintenanceService,
  never,
  MaintenanceServiceDependencies
>

/** Validate and build maintenance workflows with an explicit policy. */
export function layer(
  config: MaintenanceConfig,
): Layer.Layer<
  MaintenanceService,
  InvalidMaintenanceConfig,
  MaintenanceServiceDependencies
>

export function layer(
  config?: MaintenanceConfig,
): Layer.Layer<
  MaintenanceService,
  InvalidMaintenanceConfig,
  MaintenanceServiceDependencies
> {
  if (config === undefined) return layerFromParsedConfig(defaultConfig)
  return Layer.unwrap(
    parseMaintenanceConfig(config).pipe(Effect.map(layerFromParsedConfig)),
  )
}
