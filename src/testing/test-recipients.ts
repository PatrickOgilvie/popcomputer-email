import { DateTime, Effect, Layer, Option } from "effect"
import {
  DestinationRegistry,
  DestinationRegistryFailure,
  type Destination,
} from "../adapters/destination-registry.js"
import {
  TestRecipientStore,
  TestRecipientStoreConflict,
  TestRecipientStoreFailure,
  type StoredTestRecipientAdd,
  type StoredTestRecipient,
} from "../adapters/test-recipient-store.js"
import type { EmailAddress } from "../core/address.js"
import { DestinationIdSchema } from "../core/identifiers.js"
import type { TestScope } from "../core/scope.js"

const scopeKey = (scope: TestScope): string =>
  `${scope.namespace}\u0000${scope.environment}`

/** Inspectable destination-provider fake with controllable verification state. */
export interface InMemoryDestinationRegistry {
  readonly service: DestinationRegistry["Service"]
  readonly destinations: ReadonlyArray<Destination>
  readonly setStatus: (
    address: EmailAddress,
    status: Destination["status"],
  ) => void
  readonly layer: Layer.Layer<DestinationRegistry>
}

/** Create an isolated destination registry fake. */
export const makeInMemoryDestinationRegistry = (): InMemoryDestinationRegistry => {
  const byId = new Map<string, Destination>()
  const byAddress = new Map<string, Destination>()
  let sequence = 0
  const service = DestinationRegistry.of({
    create: (address) => Effect.gen(function*() {
      if (byAddress.has(address)) {
        return yield* new DestinationRegistryFailure({
          operation: "create",
          reason: "duplicate",
        })
      }
      sequence += 1
      const destination: Destination = {
        id: DestinationIdSchema.make(`test:destination:${sequence}`),
        address,
        status: "pending",
      }
      byId.set(destination.id, destination)
      byAddress.set(address, destination)
      return destination
    }),
    get: (id) => Effect.gen(function*() {
      const found = byId.get(id)
      if (found === undefined) {
        return yield* new DestinationRegistryFailure({
          operation: "get",
          reason: "not_found",
        })
      }
      return found
    }),
    findByAddress: (address) => Effect.sync(() => {
      const found = byAddress.get(address)
      return found === undefined ? Option.none() : Option.some(found)
    }),
  })
  return {
    service,
    get destinations() {
      return Array.from(byId.values())
    },
    setStatus: (address, status) => {
      const current = byAddress.get(address)
      if (current === undefined) return
      const next = { ...current, status }
      byAddress.set(address, next)
      byId.set(next.id, next)
    },
    layer: Layer.succeed(DestinationRegistry, service),
  }
}

/** Inspectable namespace-local test-recipient persistence fake. */
export interface InMemoryTestRecipientStore {
  readonly service: TestRecipientStore["Service"]
  readonly records: ReadonlyArray<StoredTestRecipient>
  readonly layer: Layer.Layer<TestRecipientStore>
}

/** Create an isolated test-recipient store. */
export const makeInMemoryTestRecipientStore = (): InMemoryTestRecipientStore => {
  const byId = new Map<string, StoredTestRecipient>()
  const byAddress = new Map<string, StoredTestRecipient>()
  const addLedger = new Map<string,
    | {
        readonly _tag: "Pending"
        readonly address: EmailAddress
        readonly fingerprint: import("../core/identifiers.js").RequestFingerprint
        readonly leaseToken: import("../core/identifiers.js").LeaseToken | undefined
        readonly leaseExpiresAt: DateTime.Utc | undefined
      }
    | {
        readonly _tag: "Completed"
        readonly add: StoredTestRecipientAdd
      }
  >()
  const refreshLedger = new Map<string, StoredTestRecipient>()

  const failure = (
    operation: "claim_add" | "complete_add" | "release_add",
  ): TestRecipientStoreFailure => new TestRecipientStoreFailure({
    operation,
    reason: "unavailable",
  })

  const service = TestRecipientStore.of({
    findByIdempotency: (scope, key) => Effect.sync(() => {
      const found = addLedger.get(`${scopeKey(scope)}\u0000${key}`)
      return found?._tag === "Completed"
        ? Option.some(found.add)
        : Option.none()
    }),
    findByAddress: (scope, address) => Effect.sync(() => {
      const found = byAddress.get(`${scopeKey(scope)}\u0000${address}`)
      return found === undefined ? Option.none() : Option.some(found)
    }),
    findRefreshByIdempotency: (scope, key) => Effect.sync(() => {
      const found = refreshLedger.get(`${scopeKey(scope)}\u0000${key}`)
      return found === undefined ? Option.none() : Option.some(found)
    }),
    findById: (scope, id) => Effect.sync(() => {
      const found = byId.get(`${scopeKey(scope)}\u0000${id}`)
      return found === undefined ? Option.none() : Option.some(found)
    }),
    claimAdd: (input) => Effect.sync(() => {
      const ledgerKey = `${scopeKey(input.scope)}\u0000${input.idempotencyKey}`
      const current = addLedger.get(ledgerKey)
      if (current?._tag === "Completed") {
        return { _tag: "Completed" as const, add: current.add }
      }
      if (current?._tag === "Pending") {
        const leaseActive = current.leaseExpiresAt !== undefined &&
          DateTime.toEpochMillis(current.leaseExpiresAt) >
            DateTime.toEpochMillis(input.claimedAt)
        if (
          current.fingerprint !== input.fingerprint ||
          current.address !== input.address ||
          leaseActive
        ) {
          return {
            _tag: "Pending" as const,
            fingerprint: current.fingerprint,
          }
        }
      }
      addLedger.set(ledgerKey, {
        _tag: "Pending",
        address: input.address,
        fingerprint: input.fingerprint,
        leaseToken: input.leaseToken,
        leaseExpiresAt: input.leaseExpiresAt,
      })
      const existing = byAddress.get(
        `${scopeKey(input.scope)}\u0000${input.address}`,
      )
      if (existing === undefined) return { _tag: "Claimed" as const }
      const add: StoredTestRecipientAdd = {
        recipient: existing.recipient,
        fingerprint: input.fingerprint,
      }
      addLedger.set(ledgerKey, { _tag: "Completed", add })
      return { _tag: "Completed" as const, add }
    }),
    completeAdd: (input) => Effect.gen(function*() {
      const ledgerKey =
        `${scopeKey(input.recipient.scope)}\u0000${input.idempotencyKey}`
      const current = addLedger.get(ledgerKey)
      if (current?._tag === "Completed") return current.add
      if (
        current?._tag !== "Pending" ||
        current.address !== input.recipient.address ||
        current.fingerprint !== input.fingerprint ||
        current.leaseToken !== input.leaseToken
      ) {
        return yield* failure("complete_add")
      }
      const addressKey =
        `${scopeKey(input.recipient.scope)}\u0000${input.recipient.address}`
      let record = byAddress.get(addressKey)
      if (record === undefined) {
        record = {
          recipient: input.recipient,
          creationFingerprint: input.fingerprint,
          lastRefresh: undefined,
        }
        byId.set(
          `${scopeKey(input.recipient.scope)}\u0000${input.recipient.id}`,
          record,
        )
        byAddress.set(addressKey, record)
      }
      const add: StoredTestRecipientAdd = {
        recipient: record.recipient,
        fingerprint: input.fingerprint,
      }
      addLedger.set(ledgerKey, { _tag: "Completed", add })
      return add
    }),
    releaseAdd: (input) => Effect.sync(() => {
      const ledgerKey = `${scopeKey(input.scope)}\u0000${input.idempotencyKey}`
      const current = addLedger.get(ledgerKey)
      if (
        current?._tag === "Pending" &&
        current.fingerprint === input.fingerprint &&
        current.leaseToken === input.leaseToken
      ) {
        addLedger.set(ledgerKey, {
          ...current,
          leaseToken: undefined,
          leaseExpiresAt: undefined,
        })
      }
    }),
    refresh: (input) => Effect.gen(function*() {
      const key = `${scopeKey(input.scope)}\u0000${input.testRecipientId}`
      const ledgerKey = `${scopeKey(input.scope)}\u0000${input.idempotencyKey}`
      const replay = refreshLedger.get(ledgerKey)
      if (replay !== undefined) {
        if (
          replay.recipient.id === input.testRecipientId &&
          replay.lastRefresh?.fingerprint === input.fingerprint
        ) return replay
        return yield* new TestRecipientStoreConflict({
          testRecipientId: input.testRecipientId,
          reason: "concurrent_update",
        })
      }
      const current = byId.get(key)
      if (current === undefined) {
        return yield* new TestRecipientStoreConflict({
          testRecipientId: input.testRecipientId,
          reason: "concurrent_update",
        })
      }
      if (
        current.lastRefresh?.idempotencyKey === input.idempotencyKey &&
        current.lastRefresh.fingerprint !== input.fingerprint
      ) {
        return yield* new TestRecipientStoreConflict({
          testRecipientId: input.testRecipientId,
          reason: "concurrent_update",
        })
      }
      const record: StoredTestRecipient = {
        ...current,
        recipient: {
          ...current.recipient,
          state: input.state,
          updatedAt: input.updatedAt,
        },
        lastRefresh: {
          idempotencyKey: input.idempotencyKey,
          fingerprint: input.fingerprint,
        },
      }
      byId.set(key, record)
      byAddress.set(
        `${scopeKey(input.scope)}\u0000${record.recipient.address}`,
        record,
      )
      refreshLedger.set(ledgerKey, record)
      return record
    }),
    list: (scope) => Effect.sync(() =>
      Array.from(byId.values())
        .filter((record) =>
          scopeKey(record.recipient.scope) === scopeKey(scope))
        .map((record) => record.recipient)),
  })
  return {
    service,
    get records() {
      return Array.from(byId.values())
    },
    layer: Layer.succeed(TestRecipientStore, service),
  }
}
