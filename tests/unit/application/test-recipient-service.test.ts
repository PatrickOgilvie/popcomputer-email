import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Result, Schema } from "effect"
import { layerWebCrypto } from "../../../src/adapters/content-digest.js"
import {
  DestinationRegistry,
  DestinationRegistryFailure,
  type Destination,
} from "../../../src/adapters/destination-registry.js"
import {
  TestRecipientService,
  layer as testRecipientLayer,
} from "../../../src/application/test-recipient-service.js"
import { EmailAddressSchema } from "../../../src/core/address.js"
import { DestinationIdSchema } from "../../../src/core/identifiers.js"
import {
  AddTestRecipientInputSchema,
  RefreshTestRecipientInputSchema,
} from "../../../src/core/test-recipient.js"
import { TestScopeSchema } from "../../../src/core/scope.js"
import { deterministicIdentifiers } from "../../../src/testing/identifiers.js"
import {
  makeInMemoryDestinationRegistry,
  makeInMemoryTestRecipientStore,
} from "../../../src/testing/test-recipients.js"

const fixture = (suffix: string) => {
  const scope = Schema.decodeUnknownSync(TestScopeSchema)({
    namespace: `tenant:test-recipient:${suffix}`,
    environment: "test",
  })
  const destinations = makeInMemoryDestinationRegistry()
  const store = makeInMemoryTestRecipientStore()
  const dependencies = Layer.mergeAll(
    layerWebCrypto,
    deterministicIdentifiers(`recipient-${suffix}`),
    destinations.layer,
    store.layer,
  )
  const address = EmailAddressSchema.make(`${suffix}@example.com`)
  const add = Schema.decodeUnknownSync(AddTestRecipientInputSchema)({
    scope,
    actor: { _tag: "User", id: `user:${suffix}` },
    idempotencyKey: `recipient:add:${suffix}`,
    address,
  })
  return {
    scope,
    destinations,
    store,
    address,
    add,
    live: testRecipientLayer.pipe(Layer.provide(dependencies)),
  }
}

const refreshInput = (
  current: ReturnType<typeof fixture>,
  testRecipientId: string,
  key: string,
) => Schema.decodeUnknownSync(RefreshTestRecipientInputSchema)({
  scope: current.scope,
  actor: { _tag: "User", id: "user:refresh" },
  idempotencyKey: key,
  testRecipientId,
})

const addInput = (
  current: ReturnType<typeof fixture>,
  key: string,
  address = current.address,
) => Schema.decodeUnknownSync(AddTestRecipientInputSchema)({
  scope: current.scope,
  actor: { _tag: "User", id: "user:add" },
  idempotencyKey: key,
  address,
})

describe("test recipient service", () => {
  test("replays creation and refreshes provider verification state", async () => {
    const scope = Schema.decodeUnknownSync(TestScopeSchema)({
      namespace: "tenant:test-recipient",
      environment: "test",
    })
    const destinations = makeInMemoryDestinationRegistry()
    const store = makeInMemoryTestRecipientStore()
    const dependencies = Layer.mergeAll(
      layerWebCrypto,
      deterministicIdentifiers("recipient-test"),
      destinations.layer,
      store.layer,
    )
    const live = testRecipientLayer.pipe(Layer.provide(dependencies))
    const address = EmailAddressSchema.make("recipient@example.com")
    const add = Schema.decodeUnknownSync(AddTestRecipientInputSchema)({
      scope,
      actor: { _tag: "User", id: "user:test" },
      idempotencyKey: "recipient:add:one",
      address,
    })

    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* TestRecipientService
      const created = yield* service.add(add)
      const replayed = yield* service.add(add)
      destinations.setStatus(address, "verified")
      const refreshed = yield* service.refresh(
        Schema.decodeUnknownSync(RefreshTestRecipientInputSchema)({
          scope,
          actor: { _tag: "User", id: "user:test" },
          idempotencyKey: "recipient:refresh:one",
          testRecipientId: created.id,
        }),
      )
      return { created, replayed, refreshed }
    }).pipe(Effect.provide(live)))

    expect(result.created.state._tag).toBe("Pending")
    expect(result.replayed.id).toBe(result.created.id)
    expect(result.refreshed.state._tag).toBe("Verified")
    expect(destinations.destinations).toHaveLength(1)
    expect(store.records).toHaveLength(1)
  })

  test("reconciles a provider destination created before local persistence", async () => {
    const current = fixture("reconcile")
    await Effect.runPromise(current.destinations.service.create(current.address))

    const recipient = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* TestRecipientService
      return yield* service.add(current.add)
    }).pipe(Effect.provide(current.live)))

    expect(recipient.address).toBe(current.address)
    expect(current.destinations.destinations).toHaveLength(1)
    expect(current.store.records).toHaveLength(1)
  })

  test("never downgrades a verified grant during refresh", async () => {
    const current = fixture("verified-sticky")
    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* TestRecipientService
      const created = yield* service.add(current.add)
      current.destinations.setStatus(current.address, "verified")
      const verified = yield* service.refresh(refreshInput(
        current,
        created.id,
        "refresh:verified-sticky:first",
      ))
      current.destinations.setStatus(current.address, "failed")
      const refreshed = yield* service.refresh(refreshInput(
        current,
        created.id,
        "refresh:verified-sticky:second",
      ))
      return { verified, refreshed }
    }).pipe(Effect.provide(current.live)))

    expect(result.verified.state._tag).toBe("Verified")
    expect(result.refreshed.state).toEqual(result.verified.state)
  })

  test("restarts a failed grant through Pending before verification", async () => {
    const current = fixture("failed-restart")
    const states = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* TestRecipientService
      const created = yield* service.add(current.add)
      current.destinations.setStatus(current.address, "failed")
      const failed = yield* service.refresh(refreshInput(
        current,
        created.id,
        "refresh:failed-restart:failed",
      ))
      current.destinations.setStatus(current.address, "pending")
      const pending = yield* service.refresh(refreshInput(
        current,
        created.id,
        "refresh:failed-restart:pending",
      ))
      current.destinations.setStatus(current.address, "verified")
      const verified = yield* service.refresh(refreshInput(
        current,
        created.id,
        "refresh:failed-restart:verified",
      ))
      return [failed.state._tag, pending.state._tag, verified.state._tag]
    }).pipe(Effect.provide(current.live)))

    expect(states).toEqual(["Failed", "Pending", "Verified"])
  })

  test("replays an older refresh outcome after a newer key", async () => {
    const current = fixture("historical-replay")
    const states = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* TestRecipientService
      const created = yield* service.add(current.add)
      const keyA = "refresh:historical:a"
      const first = yield* service.refresh(refreshInput(
        current,
        created.id,
        keyA,
      ))
      current.destinations.setStatus(current.address, "failed")
      const second = yield* service.refresh(refreshInput(
        current,
        created.id,
        "refresh:historical:b",
      ))
      current.destinations.setStatus(current.address, "verified")
      const replay = yield* service.refresh(refreshInput(
        current,
        created.id,
        keyA,
      ))
      return [first.state._tag, second.state._tag, replay.state._tag]
    }).pipe(Effect.provide(current.live)))

    expect(states).toEqual(["Pending", "Failed", "Pending"])
  })

  test("binds every same-address add key to an immutable outcome", async () => {
    const current = fixture("add-alias")
    const aliasKey = "recipient:add:alias"
    const otherAddress = EmailAddressSchema.make("other-alias@example.com")
    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* TestRecipientService
      const created = yield* service.add(current.add)
      const aliased = yield* service.add(addInput(current, aliasKey))
      current.destinations.setStatus(current.address, "verified")
      const refreshed = yield* service.refresh(refreshInput(
        current,
        created.id,
        "recipient:refresh:add-alias",
      ))
      const replayedAlias = yield* service.add(addInput(current, aliasKey))
      const hijack = yield* Effect.result(service.add(addInput(
        current,
        aliasKey,
        otherAddress,
      )))
      return { aliased, hijack, refreshed, replayedAlias }
    }).pipe(Effect.provide(current.live)))

    expect(result.aliased.state._tag).toBe("Pending")
    expect(result.refreshed.state._tag).toBe("Verified")
    expect(result.replayedAlias.state._tag).toBe("Pending")
    expect(Result.isFailure(result.hijack)).toBe(true)
    if (Result.isFailure(result.hijack)) {
      expect(result.hijack.failure._tag).toBe("IdempotencyConflict")
    }
    expect(current.destinations.destinations).toHaveLength(1)
    expect(current.store.records).toHaveLength(1)
  })

  test("claims one concurrent add key before either provider side effect", async () => {
    const current = fixture("add-concurrent")
    const sharedKey = "recipient:add:shared-concurrent"
    const leftAddress = EmailAddressSchema.make("left-concurrent@example.com")
    const rightAddress = EmailAddressSchema.make("right-concurrent@example.com")
    const outcomes = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* TestRecipientService
      return yield* Effect.all([
        Effect.result(service.add(addInput(current, sharedKey, leftAddress))),
        Effect.result(service.add(addInput(current, sharedKey, rightAddress))),
      ], { concurrency: "unbounded" })
    }).pipe(Effect.provide(current.live)))

    expect(outcomes.filter(Result.isSuccess)).toHaveLength(1)
    expect(outcomes.filter(Result.isFailure)).toHaveLength(1)
    if (Result.isFailure(outcomes[0])) {
      expect(outcomes[0].failure._tag).toBe("IdempotencyConflict")
    }
    if (Result.isFailure(outcomes[1])) {
      expect(outcomes[1].failure._tag).toBe("IdempotencyConflict")
    }
    expect(current.destinations.destinations).toHaveLength(1)
    expect(current.store.records).toHaveLength(1)
  })

  test("releases a failed provider claim for same-request recovery", async () => {
    const current = fixture("add-recovery")
    let attempts = 0
    const destination: Destination = {
      id: DestinationIdSchema.make("destination:add-recovery"),
      address: current.address,
      status: "pending",
    }
    const registry = DestinationRegistry.of({
      create: () => Effect.suspend(() => {
        attempts += 1
        return attempts === 1
          ? Effect.fail(new DestinationRegistryFailure({
              operation: "create",
              reason: "unavailable",
            }))
          : Effect.succeed(destination)
      }),
      get: () => Effect.succeed(destination),
      findByAddress: () => Effect.succeed(Option.none()),
    })
    const dependencies = Layer.mergeAll(
      layerWebCrypto,
      deterministicIdentifiers("recipient-add-recovery"),
      Layer.succeed(DestinationRegistry, registry),
      current.store.layer,
    )
    const live = testRecipientLayer.pipe(Layer.provide(dependencies))

    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* TestRecipientService
      const first = yield* Effect.result(service.add(current.add))
      const replay = yield* service.add(current.add)
      return { first, replay }
    }).pipe(Effect.provide(live)))

    expect(Result.isFailure(result.first)).toBe(true)
    expect(result.replay.address).toBe(current.address)
    expect(attempts).toBe(2)
    expect(current.store.records).toHaveLength(1)
  })
})
