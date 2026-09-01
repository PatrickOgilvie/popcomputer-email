import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Result, Schema } from "effect"
import {
  MaintenanceStore,
  MaximumMaintenanceBatchLimit,
} from "../../../src/adapters/maintenance-store.js"
import {
  defaultConfig,
  InvalidMaintenanceConfig,
  InvalidMaintenanceLimit,
  layer as maintenanceLayer,
  MaintenanceConfigSchema,
  MaintenanceLimitSchema,
  MaintenanceService,
  parseMaintenanceConfig,
  parseMaintenanceLimit,
} from "../../../src/application/maintenance-service.js"
import {
  MaximumOperationalDurationMilliseconds,
  OperationalDurationMillisecondsSchema,
} from "../../../src/core/operational-duration.js"
import { deterministicIdentifiers } from "../../../src/testing/identifiers.js"
import { makeInMemoryMaintenanceStore } from "../../../src/testing/maintenance-store.js"
import { makeInMemoryRawArchive } from "../../../src/testing/raw-archive.js"

const invalidNumbers = [
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
] as const

const invalidBatchLimits = [
  ...invalidNumbers,
  MaximumMaintenanceBatchLimit + 1,
  Number.MAX_SAFE_INTEGER,
] as const

const maintenanceDependencies = () => Layer.mergeAll(
  deterministicIdentifiers("maintenance-config-validation"),
  makeInMemoryMaintenanceStore().layer,
  makeInMemoryRawArchive().layer,
)

describe("maintenance numeric configuration", () => {
  test("rejects every invalid config field with a typed field error", async () => {
    const fields = [
      "defaultLimit",
      "maxLimit",
      "staleSendingMilliseconds",
      "cleanupLeaseMilliseconds",
      "cleanupBaseRetryMilliseconds",
      "cleanupMaxRetryMilliseconds",
      "cleanupMaxAttempts",
    ] as const

    for (const field of fields) {
      for (const value of invalidNumbers) {
        const result = await Effect.runPromise(Effect.result(
          parseMaintenanceConfig({ ...defaultConfig, [field]: value }),
        ))

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(InvalidMaintenanceConfig)
          expect(result.failure.field).toBe(field)
        }
      }
    }

    for (const field of ["defaultLimit", "maxLimit"] as const) {
      for (const value of [
        MaximumMaintenanceBatchLimit + 1,
        Number.MAX_SAFE_INTEGER,
      ]) {
        const result = await Effect.runPromise(Effect.result(
          parseMaintenanceConfig({ ...defaultConfig, [field]: value }),
        ))

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(InvalidMaintenanceConfig)
          expect(result.failure.field).toBe(field)
          expect(result.failure.reason).toBe("exceeds_supported_maximum")
        }
      }
    }

    for (const field of [
      "staleSendingMilliseconds",
      "cleanupLeaseMilliseconds",
      "cleanupBaseRetryMilliseconds",
      "cleanupMaxRetryMilliseconds",
    ] as const) {
      for (const value of [
        MaximumOperationalDurationMilliseconds + 1,
        Number.MAX_SAFE_INTEGER,
      ]) {
        const result = await Effect.runPromise(Effect.result(
          parseMaintenanceConfig({ ...defaultConfig, [field]: value }),
        ))

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(InvalidMaintenanceConfig)
          expect(result.failure.field).toBe(field)
          expect(result.failure.reason).toBe("exceeds_supported_maximum")
        }
      }
    }
  })

  test("accepts adapter and operational duration ceilings", async () => {
    const config = await Effect.runPromise(parseMaintenanceConfig({
      defaultLimit: MaximumMaintenanceBatchLimit,
      maxLimit: MaximumMaintenanceBatchLimit,
      staleSendingMilliseconds: MaximumOperationalDurationMilliseconds,
      cleanupLeaseMilliseconds: MaximumOperationalDurationMilliseconds,
      cleanupBaseRetryMilliseconds: MaximumOperationalDurationMilliseconds,
      cleanupMaxRetryMilliseconds: MaximumOperationalDurationMilliseconds,
      cleanupMaxAttempts: Number.MAX_SAFE_INTEGER,
    }))
    const limit = await Effect.runPromise(
      parseMaintenanceLimit(MaximumMaintenanceBatchLimit),
    )

    expect(config.cleanupMaxAttempts).toBe(Number.MAX_SAFE_INTEGER)
    expect(limit).toBe(MaximumMaintenanceBatchLimit)
    expect(Schema.is(OperationalDurationMillisecondsSchema)(
      MaximumOperationalDurationMilliseconds,
    )).toBe(true)
    expect(Schema.is(OperationalDurationMillisecondsSchema)(
      MaximumOperationalDurationMilliseconds + 1,
    )).toBe(false)
    expect(Schema.is(MaintenanceLimitSchema)(
      MaximumMaintenanceBatchLimit,
    )).toBe(true)
    expect(Schema.is(MaintenanceLimitSchema)(
      MaximumMaintenanceBatchLimit + 1,
    )).toBe(false)
    expect(Schema.is(MaintenanceConfigSchema)({
      ...defaultConfig,
      maxLimit: MaximumMaintenanceBatchLimit + 1,
    })).toBe(false)
  })

  test("rejects invalid config while acquiring a custom layer", async () => {
    const live = maintenanceLayer({
      ...defaultConfig,
      cleanupLeaseMilliseconds:
        MaximumOperationalDurationMilliseconds + 1,
    }).pipe(Layer.provide(maintenanceDependencies()))
    const result = await Effect.runPromise(Effect.result(
      Effect.gen(function*() {
        return yield* MaintenanceService
      }).pipe(Effect.provide(live)),
    ))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InvalidMaintenanceConfig)
      expect(result.failure.field).toBe("cleanupLeaseMilliseconds")
      expect(result.failure.reason).toBe("exceeds_supported_maximum")
    }
  })

  test("rejects invalid method limits before any store access", async () => {
    const unsupported = await Effect.runPromise(Effect.result(
      parseMaintenanceLimit(MaximumMaintenanceBatchLimit + 1),
    ))
    expect(Result.isFailure(unsupported)).toBe(true)
    if (Result.isFailure(unsupported)) {
      expect(unsupported.failure).toBeInstanceOf(InvalidMaintenanceLimit)
      expect(unsupported.failure.reason).toBe("exceeds_supported_maximum")
    }

    let storeAccesses = 0
    const accessed = <A>(value: A): Effect.Effect<A> => Effect.sync(() => {
      storeAccesses += 1
      return value
    })
    const store = MaintenanceStore.of({
      recoverStaleSending: () => accessed(0),
      listArchiveCleanup: () => accessed([]),
      claimArchiveCleanup: () => accessed(Option.none()),
      completeArchiveCleanup: () => accessed(undefined),
      failArchiveCleanup: () => accessed(undefined),
    })
    const live = maintenanceLayer().pipe(Layer.provide(Layer.mergeAll(
      deterministicIdentifiers("invalid-maintenance-limit"),
      Layer.succeed(MaintenanceStore, store),
      makeInMemoryRawArchive().layer,
    )))
    const outcomes = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* MaintenanceService
      return yield* Effect.forEach(invalidBatchLimits, (limit) => Effect.all([
        Effect.result(service.recoverStaleSending(limit)),
        Effect.result(service.cleanupRawArchives(limit)),
      ]))
    }).pipe(Effect.provide(live)))

    for (const [recover, cleanup] of outcomes) {
      expect(Result.isFailure(recover)).toBe(true)
      if (Result.isFailure(recover)) {
        expect(recover.failure).toBeInstanceOf(InvalidMaintenanceLimit)
      }
      expect(Result.isFailure(cleanup)).toBe(true)
      if (Result.isFailure(cleanup)) {
        expect(cleanup.failure).toBeInstanceOf(InvalidMaintenanceLimit)
      }
    }
    expect(storeAccesses).toBe(0)
  })

  test("caps valid method overrides only after validation", async () => {
    const observedLimits: Array<number> = []
    const store = MaintenanceStore.of({
      recoverStaleSending: ({ limit }) => Effect.sync(() => {
        observedLimits.push(limit)
        return 0
      }),
      listArchiveCleanup: ({ limit }) => Effect.sync(() => {
        observedLimits.push(limit)
        return []
      }),
      claimArchiveCleanup: () => Effect.succeed(Option.none()),
      completeArchiveCleanup: () => Effect.void,
      failArchiveCleanup: () => Effect.void,
    })
    const live = maintenanceLayer({
      ...defaultConfig,
      maxLimit: 7,
    }).pipe(Layer.provide(Layer.mergeAll(
      deterministicIdentifiers("bounded-maintenance-limit"),
      Layer.succeed(MaintenanceStore, store),
      makeInMemoryRawArchive().layer,
    )))
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* MaintenanceService
      yield* service.recoverStaleSending(MaximumMaintenanceBatchLimit)
      yield* service.cleanupRawArchives(MaximumMaintenanceBatchLimit)
    }).pipe(Effect.provide(live)))

    expect(observedLimits).toEqual([7, 7])
  })
})
