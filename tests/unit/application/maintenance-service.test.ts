import { describe, expect, test } from "bun:test"
import { Clock, DateTime, Effect, Layer, Option } from "effect"
import {
  MaintenanceStore,
  type ArchiveCleanupItem,
} from "../../../src/adapters/maintenance-store.js"
import { RawMessageArchive } from "../../../src/adapters/raw-message-archive.js"
import {
  MaintenanceService,
  layer as maintenanceLayer,
} from "../../../src/application/maintenance-service.js"
import {
  MessageIdSchema,
  NamespaceSchema,
  RawMessageRefSchema,
} from "../../../src/core/identifiers.js"
import { ScopeSchema } from "../../../src/core/scope.js"
import { deterministicIdentifiers } from "../../../src/testing/identifiers.js"

const advancingClock = (): Clock.Clock => {
  let currentTimeMillis = 1_000
  const read = (): number => {
    const value = currentTimeMillis
    currentTimeMillis = 121_000
    return value
  }
  return {
    currentTimeMillisUnsafe: read,
    currentTimeMillis: Effect.sync(read),
    currentTimeNanosUnsafe: () => BigInt(currentTimeMillis) * 1_000_000n,
    currentTimeNanos: Effect.sync(() =>
      BigInt(currentTimeMillis) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(currentTimeMillis) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() =>
      BigInt(currentTimeMillis) * 1_000_000n),
    sleep: () => Effect.void,
  }
}

describe("maintenance service", () => {
  test("starts each cleanup lease from a fresh per-item clock reading", async () => {
    const scope = ScopeSchema.make({
      namespace: NamespaceSchema.make("namespace-maintenance-clock"),
      environment: "test",
    })
    const item: ArchiveCleanupItem = {
      _tag: "Deletion",
      id: "cleanup-clock",
      scope,
      direction: "outbound",
      messageId: MessageIdSchema.make("message-maintenance-clock"),
      rawRef: RawMessageRefSchema.make("raw:maintenance-clock"),
      attempt: 0,
    }
    let observedLeaseExpiry: DateTime.Utc | undefined
    const store = MaintenanceStore.of({
      recoverStaleSending: () => Effect.succeed(0),
      listArchiveCleanup: () => Effect.succeed([item]),
      claimArchiveCleanup: (input) => Effect.sync(() => {
        observedLeaseExpiry = input.leaseExpiresAt
        return Option.some({ ...input.item, leaseToken: input.leaseToken })
      }),
      completeArchiveCleanup: () => Effect.void,
      failArchiveCleanup: () => Effect.void,
    })
    const archive = RawMessageArchive.of({
      referenceFor: () => Effect.die("reference is not used by maintenance"),
      put: () => Effect.die("put is not used by maintenance"),
      get: () => Effect.succeed(Option.none()),
      remove: () => Effect.void,
    })
    const dependencies = Layer.mergeAll(
      deterministicIdentifiers("maintenance-clock"),
      Layer.succeed(MaintenanceStore, store),
      Layer.succeed(RawMessageArchive, archive),
    )
    const live = maintenanceLayer({
      defaultLimit: 10,
      maxLimit: 100,
      staleSendingMilliseconds: 60_000,
      cleanupLeaseMilliseconds: 60_000,
      cleanupBaseRetryMilliseconds: 1_000,
      cleanupMaxRetryMilliseconds: 60_000,
      cleanupMaxAttempts: 3,
    }).pipe(Layer.provide(dependencies))

    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* MaintenanceService
      return yield* service.cleanupRawArchives()
    }).pipe(
      Effect.provide(live),
      Effect.provideService(Clock.Clock, advancingClock()),
    ))

    expect(result.removed).toBe(1)
    expect(observedLeaseExpiry === undefined
      ? undefined
      : DateTime.toEpochMillis(observedLeaseExpiry)).toBe(181_000)
  })
})
