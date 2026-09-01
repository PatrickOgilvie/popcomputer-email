import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { layerWebCrypto } from "../../../src/adapters/content-digest.js"
import { IdentifierGenerator } from "../../../src/adapters/identifier-generator.js"
import {
  InboundStore,
  InboundStoreFailure,
} from "../../../src/adapters/inbound-store.js"
import {
  RawMessageArchive,
  RawMessageArchiveFailure,
} from "../../../src/adapters/raw-message-archive.js"
import {
  RouteAdminStore,
  type ReserveRouteInput,
} from "../../../src/adapters/route-admin-store.js"
import { RouteStore } from "../../../src/adapters/route-store.js"
import {
  defaultConfig as defaultInboundConfig,
  InboundMessageTooLarge,
  InboundService,
  type InvalidInboundConfig,
  layer as inboundLayer,
} from "../../../src/application/inbound-service.js"
import {
  RouteService,
  layer as routeLayer,
} from "../../../src/application/route-service.js"
import {
  WorkflowService,
  layer as workflowLayer,
} from "../../../src/application/workflow-service.js"
import {
  ActorIdSchema,
  IdempotencyKeySchema,
  LeaseTokenSchema,
  MessageIdSchema,
  RequestFingerprintSchema,
  RawMessageRefSchema,
  RouteIdSchema,
  WorkflowEventIdSchema,
  WorkflowIdSchema,
  WorkflowRunIdSchema,
} from "../../../src/core/identifiers.js"
import { IdempotencyConflict } from "../../../src/core/email-command.js"
import {
  EmailAddressSchema,
  EmailDomainSchema,
  MailboxHandleSchema,
} from "../../../src/core/address.js"
import { InboundProviderDeliverySchema } from "../../../src/core/inbound-delivery.js"
import {
  RouteHandleRequestSchema,
  RouteLifecycleSchema,
  RouteRevisionSchema,
  RouteSchema,
  disable,
  isActive,
} from "../../../src/core/route.js"
import { ScopeSchema } from "../../../src/core/scope.js"
import {
  WorkflowEventSchema,
  WorkflowAttemptSchema,
} from "../../../src/core/workflow.js"
import {
  deterministicIdentifiers,
  deterministicRouteHandles,
  makeDeterministicIdentifiers,
} from "../../../src/testing/identifiers.js"
import { makeInMemoryInboundStore } from "../../../src/testing/inbound-store.js"
import { makeInMemoryRawArchive } from "../../../src/testing/raw-archive.js"
import {
  inMemoryPlatformDomains,
  makeInMemoryRoutes,
} from "../../../src/testing/routes.js"
import {
  makeInMemoryWorkflowStore,
  makeRecordingWorkflowSink,
} from "../../../src/testing/workflow.js"

const scope = Schema.decodeUnknownSync(ScopeSchema)({
  namespace: "tenant:integration",
  environment: "live",
})

const actor = {
  _tag: "System" as const,
  id: ActorIdSchema.make("system:test"),
}

const stream = (text: string, split = text.length): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, split))
      if (split < bytes.length) controller.enqueue(bytes.slice(split))
      controller.close()
    },
  })
}

const rawMime = [
  "From: Sender <sender@example.net>",
  "To: inbox@example.com",
  "Subject: Test inbound",
  "Message-ID: <message-1@example.net>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "hello",
].join("\r\n")

const reserveInboundRoute = async (
  routes: ReturnType<typeof makeInMemoryRoutes>,
  suffix: string,
) => {
  const route = RouteSchema.make({
    id: RouteIdSchema.make(`route:${suffix}`),
    scope,
    address: EmailAddressSchema.make(`${suffix}@example.com`),
    mailboxHandle: MailboxHandleSchema.make(suffix),
    inbound: { _tag: "Store" },
    outbound: { _tag: "Disabled" },
    lifecycle: RouteLifecycleSchema.cases.Active.make({}),
    revision: RouteRevisionSchema.make(1),
    actor,
    createdAt: DateTime.makeUnsafe(1_000),
    updatedAt: DateTime.makeUnsafe(1_000),
  })
  await Effect.runPromise(routes.adminStore.reserve({
    id: route.id,
    scope,
    domainId: "domain:live",
    address: route.address,
    mailboxHandle: route.mailboxHandle,
    inbound: route.inbound,
    outbound: route.outbound,
    actor,
    idempotencyKey: IdempotencyKeySchema.make(`route:${suffix}`),
    creationFingerprint: RequestFingerprintSchema.make("9".repeat(64)),
    createdAt: route.createdAt,
  }))
  return route
}

describe("route, inbound, and workflow application composition", () => {
  test("provisions idempotently and advances route revisions", async () => {
    const routes = makeInMemoryRoutes()
    const dependencies = Layer.mergeAll(
      layerWebCrypto,
      deterministicIdentifiers("route-test"),
      deterministicRouteHandles("inbox"),
      routes.layer,
      inMemoryPlatformDomains([{
        id: "domain:live",
        domain: EmailDomainSchema.make("example.com"),
        environment: "live",
      }]),
    )
    const live = routeLayer.pipe(Layer.provide(dependencies))
    const command = {
      scope,
      actor,
      idempotencyKey: IdempotencyKeySchema.make("route:one"),
      handle: RouteHandleRequestSchema.cases.Generated.make({}),
      inbound: { _tag: "Store" as const },
      outbound: { _tag: "Sender" as const, role: "default" as const },
    }
    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* RouteService
      const created = yield* service.provision(command)
      const replayed = yield* service.provision(command)
      const capabilityConflict = yield* Effect.result(service.provision({
        ...command,
        outbound: { _tag: "Disabled" },
      }))
      const paused = yield* service.pause({ scope, routeId: created.id })
      const resumed = yield* service.resume({ scope, routeId: created.id })
      const conflict = yield* Effect.result(service.provision({
        ...command,
        idempotencyKey: IdempotencyKeySchema.make("route:address-conflict"),
        handle: RouteHandleRequestSchema.cases.Requested.make({
          mailboxHandle: MailboxHandleSchema.make("inbox-1"),
        }),
      }))
      return {
        capabilityConflict,
        conflict,
        created,
        paused,
        replayed,
        resumed,
      }
    }).pipe(Effect.provide(live)))

    expect(result.replayed.id).toBe(result.created.id)
    expect(result.capabilityConflict._tag).toBe("Failure")
    if (result.capabilityConflict._tag === "Failure") {
      expect(result.capabilityConflict.failure).toBeInstanceOf(IdempotencyConflict)
    }
    expect(result.paused.lifecycle._tag).toBe("Paused")
    expect(result.paused.revision).toBe(RouteRevisionSchema.make(2))
    expect(result.resumed.lifecycle._tag).toBe("Active")
    expect(result.resumed.revision).toBe(RouteRevisionSchema.make(3))
    expect(result.conflict._tag).toBe("Failure")
    if (result.conflict._tag === "Failure") {
      expect(result.conflict.failure._tag).toBe("RouteAddressConflict")
      expect(JSON.stringify(result.conflict.failure))
        .not.toContain("inbox-1@example.com")
    }
    expect(routes.routes).toHaveLength(1)
  })

  test("rejects a conflicting replay returned by atomic route reservation", async () => {
    const routes = makeInMemoryRoutes()
    const domains = inMemoryPlatformDomains([{
      id: "domain:live",
      domain: EmailDomainSchema.make("example.com"),
      environment: "live",
    }])
    const initialDependencies = Layer.mergeAll(
      layerWebCrypto,
      deterministicIdentifiers("route-race-initial"),
      deterministicRouteHandles("inbox"),
      routes.layer,
      domains,
    )
    const key = IdempotencyKeySchema.make("route:race")
    const initial = {
      scope,
      actor,
      idempotencyKey: key,
      handle: RouteHandleRequestSchema.cases.Requested.make({
        mailboxHandle: MailboxHandleSchema.make("first"),
      }),
      inbound: { _tag: "Store" as const },
      outbound: { _tag: "Disabled" as const },
    }
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* RouteService
      return yield* service.provision(initial)
    }).pipe(Effect.provide(routeLayer.pipe(Layer.provide(initialDependencies)))))

    const raceStore = RouteAdminStore.of({
      ...routes.adminStore,
      findByIdempotency: () => Effect.succeed(Option.none()),
    })
    const raceDependencies = Layer.mergeAll(
      layerWebCrypto,
      deterministicIdentifiers("route-race-replay"),
      deterministicRouteHandles("other"),
      Layer.succeed(RouteAdminStore, raceStore),
      Layer.succeed(RouteStore, routes.routeStore),
      domains,
    )
    const result = await Effect.runPromise(Effect.result(Effect.gen(function*() {
      const service = yield* RouteService
      return yield* service.provision({
        ...initial,
        handle: RouteHandleRequestSchema.cases.Requested.make({
          mailboxHandle: MailboxHandleSchema.make("second"),
        }),
      })
    }).pipe(Effect.provide(routeLayer.pipe(Layer.provide(raceDependencies))))))

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(IdempotencyConflict)
    }
    expect(routes.routes).toHaveLength(1)
  })

  test("selects one durable winner across concurrent route rotations", async () => {
    const routes = makeInMemoryRoutes()
    const originalInput: ReserveRouteInput = {
      id: RouteIdSchema.make("route:rotation-original"),
      scope,
      domainId: "domain:live",
      address: EmailAddressSchema.make("rotation-original@example.com"),
      mailboxHandle: MailboxHandleSchema.make("rotation-original"),
      inbound: { _tag: "Store" },
      outbound: { _tag: "Sender", role: "default" },
      actor,
      idempotencyKey: IdempotencyKeySchema.make("route:rotation-original"),
      creationFingerprint: RequestFingerprintSchema.make("3".repeat(64)),
      createdAt: DateTime.makeUnsafe(1_000),
    }
    const reserved = await Effect.runPromise(
      routes.adminStore.reserve(originalInput),
    )
    if (!isActive(reserved.record.route)) {
      throw new Error("Expected an active rotation source")
    }
    const previous = disable(reserved.record.route, DateTime.makeUnsafe(2_000))
    const replacement = (
      discriminator: "left" | "right",
      fingerprintCharacter: "4" | "5",
    ): ReserveRouteInput => {
      const mailboxHandle = MailboxHandleSchema.make(`rotation-${discriminator}`)
      return {
        id: RouteIdSchema.make(`route:rotation-${discriminator}`),
        scope,
        domainId: "domain:live",
        address: EmailAddressSchema.make(`${mailboxHandle}@example.com`),
        mailboxHandle,
        inbound: originalInput.inbound,
        outbound: originalInput.outbound,
        actor,
        idempotencyKey: IdempotencyKeySchema.make(
          `route:rotation-${discriminator}`,
        ),
        creationFingerprint: RequestFingerprintSchema.make(
          fingerprintCharacter.repeat(64),
        ),
        createdAt: DateTime.makeUnsafe(2_000),
      }
    }
    const inputs = [
      replacement("left", "4"),
      replacement("right", "5"),
    ] as const
    const outcomes = await Promise.all(inputs.map((candidate) =>
      Effect.runPromise(Effect.result(routes.adminStore.rotate({
        scope,
        previous,
        expectedRevision: reserved.record.route.revision,
        replacement: candidate,
      })))))

    const successes = outcomes.filter((outcome) => outcome._tag === "Success")
    const failures = outcomes.filter((outcome) => outcome._tag === "Failure")
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    if (failures[0]?._tag === "Failure") {
      expect(failures[0].failure._tag).toBe("RouteStoreTransitionConflict")
    }
    expect(routes.routes.filter(isActive)).toHaveLength(1)
    const winner = successes[0]
    if (winner?._tag !== "Success") throw new Error("Expected one winner")
    const winnerInput = inputs.find((candidate) =>
      candidate.id === winner.success.replacement.id)
    if (winnerInput === undefined) throw new Error("Expected the winner input")
    const replay = await Effect.runPromise(routes.adminStore.rotate({
      scope,
      previous,
      expectedRevision: reserved.record.route.revision,
      replacement: winnerInput,
    }))
    expect(replay.replacement.id).toBe(winner.success.replacement.id)
  })

  test("uses provider delivery IDs and a bounded digest fallback", async () => {
    const routes = makeInMemoryRoutes()
    const workflows = makeInMemoryWorkflowStore()
    const inbound = makeInMemoryInboundStore({
      onWorkflowEvent: workflows.enqueue,
    })
    const archive = makeInMemoryRawArchive()
    const route = RouteSchema.make({
      id: RouteIdSchema.make("route:workflow"),
      scope,
      address: EmailAddressSchema.make("inbox@example.com"),
      mailboxHandle: MailboxHandleSchema.make("inbox"),
      inbound: {
        _tag: "Trigger",
        workflowId: WorkflowIdSchema.make("workflow:triage"),
      },
      outbound: { _tag: "Sender", role: "alternate" },
      lifecycle: RouteLifecycleSchema.cases.Active.make({}),
      revision: RouteRevisionSchema.make(1),
      actor,
      createdAt: DateTime.makeUnsafe(1_000),
      updatedAt: DateTime.makeUnsafe(1_000),
    })
    await Effect.runPromise(routes.adminStore.reserve({
      id: route.id,
      scope,
      domainId: "domain:live",
      address: route.address,
      mailboxHandle: route.mailboxHandle,
      inbound: route.inbound,
      outbound: route.outbound,
      actor,
      idempotencyKey: IdempotencyKeySchema.make("route:workflow"),
      creationFingerprint: RequestFingerprintSchema.make("1".repeat(64)),
      createdAt: route.createdAt,
    }))

    const dependencies = Layer.mergeAll(
      layerWebCrypto,
      Layer.succeed(
        IdentifierGenerator,
        makeDeterministicIdentifiers("inbound-test"),
      ),
      routes.layer,
      inbound.layer,
      archive.layer,
    )
    const live = inboundLayer({
      ...defaultInboundConfig,
      digestDedupeWindowMilliseconds: 1_000,
    }).pipe(Layer.provide(dependencies))
    const run = (
      service: InboundService["Service"],
      mime = rawMime,
      envelopeFrom = "envelope@example.net",
      receivedAt = DateTime.makeUnsafe(100),
      providerDelivery?: typeof InboundProviderDeliverySchema.Type,
    ) => {
      const envelope = {
        from: EmailAddressSchema.make(envelopeFrom),
        to: route.address,
        raw: stream(mime, 17),
        receivedAt,
      }
      return service.ingest(providerDelivery === undefined
        ? envelope
        : { ...envelope, providerDelivery })
    }
    const differentBody = rawMime.replace("hello", "different body")
    const providerDelivery = Schema.decodeUnknownSync(
      InboundProviderDeliverySchema,
    )({
      provider: "example-provider",
      deliveryId: "delivery-one",
    })
    const results = await Effect.runPromise(Effect.gen(function*() {
      yield* TestClock.setTime(1_000)
      const service = yield* InboundService
      const first = yield* run(service)
      const replay = yield* run(service)
      const distinct = yield* run(service, differentBody)
      const distinctEnvelope = yield* run(
        service,
        rawMime,
        "other-envelope@example.net",
      )
      yield* TestClock.adjust(1_000)
      const afterFallbackWindow = yield* run(service)
      const providerFirst = yield* run(
        service,
        rawMime,
        "envelope@example.net",
        DateTime.makeUnsafe(3_000),
        providerDelivery,
      )
      yield* TestClock.adjust(1_000_000)
      const providerReplay = yield* run(
        service,
        differentBody,
        "other-envelope@example.net",
        DateTime.makeUnsafe(3_000),
        providerDelivery,
      )
      const providerDistinct = yield* run(
        service,
        rawMime,
        "envelope@example.net",
        DateTime.makeUnsafe(9_000_000),
        Schema.decodeUnknownSync(InboundProviderDeliverySchema)({
          provider: "example-provider",
          deliveryId: "delivery-two",
        }),
      )
      return {
        afterFallbackWindow,
        distinct,
        distinctEnvelope,
        first,
        providerDistinct,
        providerFirst,
        providerReplay,
        replay,
      }
    }).pipe(
      Effect.provide(live),
      Effect.provide(TestClock.layer()),
    ))

    expect(results.replay.id).toBe(results.first.id)
    expect(results.first.from).toBe(
      EmailAddressSchema.make("envelope@example.net"),
    )
    expect(results.first.state._tag).toBe("WorkflowEventCreated")
    expect(DateTime.toEpochMillis(results.first.receivedAt)).toBe(100)
    expect(DateTime.toEpochMillis(results.first.createdAt)).toBe(1_000)
    expect(DateTime.toEpochMillis(results.first.updatedAt)).toBe(1_000)

    expect(results.distinct.id).not.toBe(results.first.id)
    expect(results.distinct.rfcMessageId).toBe(results.first.rfcMessageId)
    expect(results.distinctEnvelope.id).not.toBe(results.first.id)
    expect(results.distinctEnvelope.from).toBe(
      EmailAddressSchema.make("other-envelope@example.net"),
    )
    expect(results.afterFallbackWindow.id).not.toBe(results.first.id)
    expect(results.afterFallbackWindow.receivedAt).toEqual(
      results.first.receivedAt,
    )
    expect(results.providerReplay.id).toBe(results.providerFirst.id)
    expect(results.providerDistinct.id).not.toBe(results.providerFirst.id)
    expect(DateTime.toEpochMillis(results.providerDistinct.receivedAt)).toBe(
      9_000_000,
    )
    expect(DateTime.toEpochMillis(results.providerDistinct.createdAt)).toBe(
      1_002_000,
    )
    const firstWorkflow = workflows.events.find((event) =>
      event.event.message.id === results.first.id)
    const futureWorkflow = workflows.events.find((event) =>
      event.event.message.id === results.providerDistinct.id)
    if (firstWorkflow === undefined || futureWorkflow === undefined) {
      throw new Error("Expected workflow events for both clock regressions")
    }
    expect(DateTime.toEpochMillis(firstWorkflow.event.occurredAt)).toBe(100)
    expect(DateTime.toEpochMillis(firstWorkflow.createdAt)).toBe(1_000)
    expect(firstWorkflow.state._tag).toBe("Pending")
    if (firstWorkflow.state._tag === "Pending") {
      expect(DateTime.toEpochMillis(firstWorkflow.state.nextAttemptAt)).toBe(
        1_000,
      )
    }
    expect(DateTime.toEpochMillis(futureWorkflow.event.occurredAt)).toBe(
      9_000_000,
    )
    expect(DateTime.toEpochMillis(futureWorkflow.createdAt)).toBe(1_002_000)
    expect(futureWorkflow.state._tag).toBe("Pending")
    if (futureWorkflow.state._tag === "Pending") {
      expect(DateTime.toEpochMillis(futureWorkflow.state.nextAttemptAt)).toBe(
        1_002_000,
      )
    }
    expect(inbound.messages).toHaveLength(6)
    expect(workflows.events).toHaveLength(6)
    expect(archive.objects.size).toBe(6)
  })

  test("enforces the actual streamed byte limit even when the claim is small", async () => {
    const routes = makeInMemoryRoutes()
    const inbound = makeInMemoryInboundStore()
    const archive = makeInMemoryRawArchive()
    await Effect.runPromise(routes.adminStore.reserve({
      id: RouteIdSchema.make("route:bounded"),
      scope,
      domainId: "domain:live",
      address: EmailAddressSchema.make("bounded@example.com"),
      mailboxHandle: MailboxHandleSchema.make("bounded"),
      inbound: { _tag: "Store" },
      outbound: { _tag: "Sender", role: "default" },
      actor,
      idempotencyKey: IdempotencyKeySchema.make("route:bounded"),
      creationFingerprint: RequestFingerprintSchema.make("2".repeat(64)),
      createdAt: DateTime.makeUnsafe(1_000),
    }))
    const dependencies = Layer.mergeAll(
      layerWebCrypto,
      deterministicIdentifiers("bounded-test"),
      routes.layer,
      inbound.layer,
      archive.layer,
    )
    const live = inboundLayer({
      maxBytes: 32,
      digestDedupeWindowMilliseconds: 1_000,
      archiveIntentTtlMilliseconds: 1_000,
      cleanupRetryMilliseconds: 100,
    }).pipe(Layer.provide(dependencies))
    const result = await Effect.runPromise(Effect.result(Effect.gen(function*() {
      const service = yield* InboundService
      return yield* service.ingest({
        from: EmailAddressSchema.make("sender@example.net"),
        to: EmailAddressSchema.make("bounded@example.com"),
        raw: stream("x".repeat(64), 16),
        claimedSizeBytes: 1,
      })
    }).pipe(Effect.provide(live))))

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(InboundMessageTooLarge)
    }
    expect(archive.objects.size).toBe(0)
  })

  test("retains the deterministic intent when an archive put is ambiguous", async () => {
    const routes = makeInMemoryRoutes()
    const inbound = makeInMemoryInboundStore()
    const archive = makeInMemoryRawArchive()
    const route = await reserveInboundRoute(routes, "ambiguous-put")
    const failingArchive = RawMessageArchive.of({
      ...archive.service,
      put: () => Effect.fail(new RawMessageArchiveFailure({
        operation: "put",
        reason: "unavailable",
      })),
    })
    const live = inboundLayer().pipe(Layer.provide(Layer.mergeAll(
      layerWebCrypto,
      deterministicIdentifiers("ambiguous-put"),
      routes.layer,
      inbound.layer,
      Layer.succeed(RawMessageArchive, failingArchive),
    )))
    const result = await Effect.runPromise(Effect.gen(function*() {
      yield* TestClock.setTime(5_000)
      const service = yield* InboundService
      return yield* Effect.result(service.ingest({
        from: EmailAddressSchema.make("sender@example.net"),
        to: route.address,
        raw: stream(rawMime),
        receivedAt: DateTime.makeUnsafe(9_000_000),
      }))
    }).pipe(
      Effect.provide(live),
      Effect.provide(TestClock.layer()),
    ))

    expect(result._tag).toBe("Failure")
    expect(archive.objects.size).toBe(0)
    expect(inbound.intents).toHaveLength(1)
    const retainedIntent = inbound.intents[0]
    if (retainedIntent === undefined || retainedIntent.expiresAt === undefined) {
      throw new Error("Expected a retained archive intent")
    }
    expect(retainedIntent.rawRef).toBeDefined()
    expect(DateTime.toEpochMillis(retainedIntent.now)).toBe(5_000)
    expect(DateTime.toEpochMillis(retainedIntent.expiresAt)).toBe(
      5_000 + defaultInboundConfig.archiveIntentTtlMilliseconds,
    )
  })

  test("retains raw and intent when commit outcome is indeterminate", async () => {
    const routes = makeInMemoryRoutes()
    const inbound = makeInMemoryInboundStore()
    const archive = makeInMemoryRawArchive()
    const route = await reserveInboundRoute(routes, "indeterminate-commit")
    const corruptedStore = InboundStore.of({
      ...inbound.service,
      commit: (input) => inbound.service.commit({
        ...input,
        raw: {
          ...input.raw,
          ref: RawMessageRefSchema.make("raw:wrong-reference"),
        },
      }),
    })
    const live = inboundLayer().pipe(Layer.provide(Layer.mergeAll(
      layerWebCrypto,
      deterministicIdentifiers("indeterminate-commit"),
      routes.layer,
      Layer.succeed(InboundStore, corruptedStore),
      archive.layer,
    )))
    const result = await Effect.runPromise(Effect.result(Effect.gen(function*() {
      const service = yield* InboundService
      return yield* service.ingest({
        from: EmailAddressSchema.make("sender@example.net"),
        to: route.address,
        raw: stream(rawMime),
      })
    }).pipe(Effect.provide(live))))

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(InboundStoreFailure)
    }
    expect(archive.objects.size).toBe(1)
    expect(inbound.intents).toHaveLength(1)
  })

  test("retains a dedupe loser until cleanup and schedules from fresh time", async () => {
    const routes = makeInMemoryRoutes()
    const inbound = makeInMemoryInboundStore()
    const archive = makeInMemoryRawArchive()
    const route = await reserveInboundRoute(routes, "loser-cleanup")
    const config = {
      ...defaultInboundConfig,
      digestDedupeWindowMilliseconds: 10_000,
      cleanupRetryMilliseconds: 100,
    }
    const winnerLive = inboundLayer(config).pipe(Layer.provide(Layer.mergeAll(
      layerWebCrypto,
      deterministicIdentifiers("loser-cleanup-winner"),
      routes.layer,
      inbound.layer,
      archive.layer,
    )))
    const raceStore = InboundStore.of({
      ...inbound.service,
      findDuplicate: () => Effect.succeed(Option.none()),
    })
    const failingCleanupArchive = RawMessageArchive.of({
      ...archive.service,
      remove: () => Effect.gen(function*() {
        yield* TestClock.adjust(250)
        return yield* new RawMessageArchiveFailure({
          operation: "remove",
          reason: "unavailable",
        })
      }),
    })
    const loserLive = inboundLayer(config).pipe(Layer.provide(Layer.mergeAll(
      layerWebCrypto,
      deterministicIdentifiers("loser-cleanup-race"),
      routes.layer,
      Layer.succeed(InboundStore, raceStore),
      Layer.succeed(RawMessageArchive, failingCleanupArchive),
    )))
    const ingest = (
      live: Layer.Layer<InboundService, InvalidInboundConfig>,
      receivedAt: DateTime.Utc,
    ) => Effect.gen(function*() {
      const service = yield* InboundService
      return yield* service.ingest({
        from: EmailAddressSchema.make("sender@example.net"),
        to: route.address,
        raw: stream(rawMime),
        receivedAt,
      })
    }).pipe(Effect.provide(live))

    const messages = await Effect.runPromise(Effect.gen(function*() {
      yield* TestClock.setTime(1_000)
      const winner = yield* ingest(winnerLive, DateTime.makeUnsafe(100))
      yield* TestClock.adjust(4_000)
      const replay = yield* ingest(loserLive, DateTime.makeUnsafe(9_000_000))
      return { replay, winner }
    }).pipe(Effect.provide(TestClock.layer())))

    expect(messages.replay.id).toBe(messages.winner.id)
    expect(inbound.messages).toHaveLength(1)
    expect(inbound.intents).toHaveLength(1)
    const retainedIntent = inbound.intents[0]
    if (
      retainedIntent === undefined ||
      retainedIntent.cleanupObservedAt === undefined ||
      retainedIntent.nextAttemptAt === undefined
    ) {
      throw new Error("Expected a cleanup-ready losing intent")
    }
    expect(retainedIntent.cleanupNeeded).toBe(true)
    expect(DateTime.toEpochMillis(retainedIntent.now)).toBe(5_000)
    expect(DateTime.toEpochMillis(retainedIntent.cleanupObservedAt)).toBe(5_250)
    expect(DateTime.toEpochMillis(retainedIntent.nextAttemptAt)).toBe(5_350)
    expect(archive.objects.size).toBe(2)

    await Effect.runPromise(inbound.service.markArchiveCleanup({
      messageId: retainedIntent.messageId,
      scope,
      rawRef: retainedIntent.rawRef,
      safeErrorCode: "archive_remove_failed",
      now: DateTime.makeUnsafe(9_000),
      nextAttemptAt: DateTime.makeUnsafe(9_100),
    }))
    const replayedCleanup = inbound.intents[0]
    if (
      replayedCleanup === undefined ||
      replayedCleanup.cleanupObservedAt === undefined ||
      replayedCleanup.nextAttemptAt === undefined
    ) {
      throw new Error("Expected one stable cleanup job")
    }
    expect(inbound.intents).toHaveLength(1)
    expect(DateTime.toEpochMillis(replayedCleanup.cleanupObservedAt)).toBe(5_250)
    expect(DateTime.toEpochMillis(replayedCleanup.nextAttemptAt)).toBe(5_350)

    await Effect.runPromise(archive.service.remove(retainedIntent.rawRef))
    await Effect.runPromise(inbound.service.deleteArchiveIntent(
      scope,
      retainedIntent.messageId,
    ))
    expect(inbound.intents).toHaveLength(0)
    expect(archive.objects.size).toBe(1)
  })

  test("dispatches a due workflow event through the host sink", async () => {
    const now = DateTime.makeUnsafe(0)
    const event = WorkflowEventSchema.make({
      event: {
        schemaVersion: 1,
        type: "email.received",
        eventId: WorkflowEventIdSchema.make("event:one"),
        occurredAt: now,
        scope,
        workflowId: WorkflowIdSchema.make("workflow:one"),
        message: {
          id: MessageIdSchema.make("message:one"),
          routeId: RouteIdSchema.make("route:one"),
          from: EmailAddressSchema.make("sender@example.net"),
          to: [EmailAddressSchema.make("inbox@example.com")],
          subject: "hello",
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
    const store = makeInMemoryWorkflowStore([event])
    const sink = makeRecordingWorkflowSink(() => Effect.succeed(
      WorkflowRunIdSchema.make("run:one"),
    ))
    const dependencies = Layer.mergeAll(
      Layer.succeed(
        IdentifierGenerator,
        makeDeterministicIdentifiers("workflow-test"),
      ),
      store.layer,
      sink.layer,
    )
    const live = workflowLayer().pipe(Layer.provide(dependencies))
    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* WorkflowService
      return yield* service.dispatchReady()
    }).pipe(Effect.provide(live)))

    expect(result.started).toBe(1)
    expect(sink.events).toHaveLength(1)
    expect(store.events[0]?.state._tag).toBe("Started")
  })

  test("dead-letters an expired over-budget lease before calling the sink", async () => {
    const leasedAt = DateTime.makeUnsafe(1_000)
    const leaseExpiresAt = DateTime.makeUnsafe(2_000)
    const event = WorkflowEventSchema.make({
      event: {
        schemaVersion: 1,
        type: "email.received",
        eventId: WorkflowEventIdSchema.make("event:expired-max"),
        occurredAt: leasedAt,
        scope,
        workflowId: WorkflowIdSchema.make("workflow:expired-max"),
        message: {
          id: MessageIdSchema.make("message:expired-max"),
          routeId: RouteIdSchema.make("route:expired-max"),
          from: EmailAddressSchema.make("sender@example.net"),
          to: [EmailAddressSchema.make("inbox@example.com")],
          subject: null,
          sizeBytes: 10,
          receivedAt: leasedAt,
        },
      },
      state: WorkflowEventSchema.fields.state.cases.Leased.make({
        attempt: WorkflowAttemptSchema.make(2),
        leaseToken: LeaseTokenSchema.make("lease:expired-max"),
        leasedAt,
        leaseExpiresAt,
      }),
      createdAt: leasedAt,
      updatedAt: leasedAt,
    })
    const store = makeInMemoryWorkflowStore([event])
    const sink = makeRecordingWorkflowSink(() => Effect.succeed(
      WorkflowRunIdSchema.make("run:must-not-start"),
    ))
    const dependencies = Layer.mergeAll(
      Layer.succeed(
        IdentifierGenerator,
        makeDeterministicIdentifiers("workflow-expired-max"),
      ),
      store.layer,
      sink.layer,
    )
    const live = workflowLayer({
      defaultLimit: 25,
      maxLimit: 100,
      concurrency: 1,
      maxAttempts: 2,
      leaseMilliseconds: 60_000,
      baseRetryMilliseconds: 1_000,
      maxRetryMilliseconds: 60_000,
    }).pipe(Layer.provide(dependencies))

    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* WorkflowService
      return yield* service.dispatchReady()
    }).pipe(Effect.provide(live)))

    expect(result).toEqual({
      selected: 1,
      claimed: 1,
      started: 0,
      failed: 0,
      dead: 1,
    })
    expect(sink.events).toHaveLength(0)
    expect(store.events[0]?.state._tag).toBe("Dead")
    if (store.events[0]?.state._tag === "Dead") {
      expect(String(store.events[0].state.reason)).toBe(
        "workflow_dispatch.max_attempts",
      )
    }
  })
})
