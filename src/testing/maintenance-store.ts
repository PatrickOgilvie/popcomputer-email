import { Effect, Layer, Option } from "effect"
import {
  MaintenanceStore,
  type ArchiveCleanupItem,
  type LeasedArchiveCleanupItem,
} from "../adapters/maintenance-store.js"

/** Inspectable in-memory maintenance queue for scheduler behavior tests. */
export interface InMemoryMaintenanceStore {
  readonly service: MaintenanceStore["Service"]
  readonly cleanupItems: ReadonlyArray<ArchiveCleanupItem>
  readonly recoveredStaleSending: number
  readonly layer: Layer.Layer<MaintenanceStore>
}

/** Create an isolated cleanup queue and stale-send counter. */
export const makeInMemoryMaintenanceStore = (input: {
  readonly cleanupItems?: ReadonlyArray<ArchiveCleanupItem>
  readonly staleSending?: number
} = {}): InMemoryMaintenanceStore => {
  const queued = new Map(
    (input.cleanupItems ?? []).map((item) => [item.id, item]),
  )
  const leased = new Map<string, LeasedArchiveCleanupItem>()
  let staleSending = input.staleSending ?? 0
  let recoveredStaleSending = 0

  const service = MaintenanceStore.of({
    recoverStaleSending: ({ limit }) => Effect.sync(() => {
      const recovered = Math.min(limit, staleSending)
      staleSending -= recovered
      recoveredStaleSending += recovered
      return recovered
    }),
    listArchiveCleanup: ({ limit }) => Effect.sync(() =>
      Array.from(queued.values()).slice(0, limit)),
    claimArchiveCleanup: ({ item, leaseToken }) => Effect.sync(() => {
      const current = queued.get(item.id)
      if (current === undefined) return Option.none()
      queued.delete(item.id)
      const claimed: LeasedArchiveCleanupItem = {
        ...current,
        leaseToken,
      }
      leased.set(item.id, claimed)
      return Option.some(claimed)
    }),
    completeArchiveCleanup: (item) => Effect.sync(() => {
      if (leased.get(item.id)?.leaseToken === item.leaseToken) {
        leased.delete(item.id)
      }
    }),
    failArchiveCleanup: ({ item, dead }) => Effect.sync(() => {
      if (leased.get(item.id)?.leaseToken !== item.leaseToken) return
      leased.delete(item.id)
      if (!dead) {
        queued.set(item.id, { ...item, attempt: item.attempt + 1 })
      }
    }),
  })

  return {
    service,
    get cleanupItems() {
      return Array.from(queued.values())
    },
    get recoveredStaleSending() {
      return recoveredStaleSending
    },
    layer: Layer.succeed(MaintenanceStore, service),
  }
}
