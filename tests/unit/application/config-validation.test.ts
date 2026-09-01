import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result, Schema } from "effect"
import { layerWebCrypto } from "../../../src/adapters/content-digest.js"
import {
  MaximumWorkflowReadyLimit,
  WorkflowStore,
} from "../../../src/adapters/workflow-store.js"
import {
  defaultReceivedContentConfig,
  getReceivedContent,
  InvalidReceivedContentConfig,
  parseReceivedContentConfig,
} from "../../../src/application/read-received-content.js"
import {
  defaultConfig as defaultInboundConfig,
  InboundService,
  InvalidInboundConfig,
  layer as inboundLayer,
  parseInboundConfig,
} from "../../../src/application/inbound-service.js"
import {
  EmailService,
  layerWithConfig as emailLayerWithConfig,
} from "../../../src/application/email-service.js"
import {
  defaultConfig as defaultWorkflowConfig,
  InvalidWorkflowDispatchConfig,
  InvalidWorkflowDispatchInput,
  layer as workflowLayer,
  parseDispatchReadyInput,
  parseWorkflowDispatchConfig,
  WorkflowDispatchConfigSchema,
  WorkflowDispatchLimitSchema,
  WorkflowService,
} from "../../../src/application/workflow-service.js"
import { MessageIdSchema } from "../../../src/core/identifiers.js"
import {
  MaximumOperationalDurationMilliseconds,
  OperationalDurationMillisecondsSchema,
} from "../../../src/core/operational-duration.js"
import { ScopeSchema } from "../../../src/core/scope.js"
import { deterministicIdentifiers } from "../../../src/testing/identifiers.js"
import { makeInMemoryInboundStore } from "../../../src/testing/inbound-store.js"
import { makeInMemoryMessageStore } from "../../../src/testing/message-store.js"
import { testOutboundPolicy } from "../../../src/testing/outbound-policy.js"
import { makeInMemoryRawArchive } from "../../../src/testing/raw-archive.js"
import { makeInMemoryRoutes } from "../../../src/testing/routes.js"
import { makeRecordingSendTransport } from "../../../src/testing/send-transport.js"
import {
  makeInMemoryWorkflowStore,
  makeScriptedWorkflowSink,
} from "../../../src/testing/workflow.js"

const scope = Schema.decodeUnknownSync(ScopeSchema)({
  namespace: "tenant:config-validation",
  environment: "test",
})

const invalidNumbers = [
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
] as const

describe("public numeric configuration", () => {
  test("rejects every invalid received-content limit with a typed field error", async () => {
    const fields = [
      "maxRawBytes",
      "maxAttachments",
      "maxTextCharacters",
      "maxHtmlCharacters",
    ] as const

    for (const field of fields) {
      for (const value of invalidNumbers) {
        const result = await Effect.runPromise(Effect.result(
          parseReceivedContentConfig({
            ...defaultReceivedContentConfig,
            [field]: value,
          }),
        ))

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(InvalidReceivedContentConfig)
          expect(result.failure.field).toBe(field)
        }
      }
    }
  })

  test("accepts values up to each portable operational ceiling", async () => {
    const received = await Effect.runPromise(parseReceivedContentConfig({
      maxRawBytes: Number.MAX_SAFE_INTEGER,
      maxAttachments: Number.MAX_SAFE_INTEGER,
      maxTextCharacters: Number.MAX_SAFE_INTEGER,
      maxHtmlCharacters: Number.MAX_SAFE_INTEGER,
    }))
    const inbound = await Effect.runPromise(parseInboundConfig({
      maxBytes: Number.MAX_SAFE_INTEGER,
      digestDedupeWindowMilliseconds:
        MaximumOperationalDurationMilliseconds,
      archiveIntentTtlMilliseconds: MaximumOperationalDurationMilliseconds,
      cleanupRetryMilliseconds: MaximumOperationalDurationMilliseconds,
    }))
    const workflow = await Effect.runPromise(parseWorkflowDispatchConfig({
      defaultLimit: MaximumWorkflowReadyLimit,
      maxLimit: MaximumWorkflowReadyLimit,
      concurrency: Number.MAX_SAFE_INTEGER,
      maxAttempts: Number.MAX_SAFE_INTEGER,
      leaseMilliseconds: MaximumOperationalDurationMilliseconds,
      baseRetryMilliseconds: MaximumOperationalDurationMilliseconds,
      maxRetryMilliseconds: MaximumOperationalDurationMilliseconds,
    }))

    expect(received.maxRawBytes).toBe(Number.MAX_SAFE_INTEGER)
    expect(inbound.maxBytes).toBe(Number.MAX_SAFE_INTEGER)
    expect(workflow.maxAttempts).toBe(Number.MAX_SAFE_INTEGER)
    expect(Schema.is(OperationalDurationMillisecondsSchema)(
      MaximumOperationalDurationMilliseconds,
    )).toBe(true)
    expect(Schema.is(OperationalDurationMillisecondsSchema)(
      MaximumOperationalDurationMilliseconds + 1,
    )).toBe(false)
    expect(Schema.is(WorkflowDispatchLimitSchema)(
      MaximumWorkflowReadyLimit,
    )).toBe(true)
    expect(Schema.is(WorkflowDispatchLimitSchema)(
      MaximumWorkflowReadyLimit + 1,
    )).toBe(false)
    expect(Schema.is(WorkflowDispatchConfigSchema)({
      ...defaultWorkflowConfig,
      maxLimit: MaximumWorkflowReadyLimit + 1,
    })).toBe(false)
  })

  test("fails received-content operation and service construction without defects", async () => {
    const invalidConfig = {
      ...defaultReceivedContentConfig,
      maxRawBytes: Number.NaN,
    }
    const contentDependencies = Layer.mergeAll(
      layerWebCrypto,
      makeInMemoryMessageStore().layer,
      makeInMemoryRawArchive().layer,
    )
    const contentResult = await Effect.runPromise(Effect.result(
      getReceivedContent({
        scope,
        messageId: MessageIdSchema.make("message:invalid-content-config"),
      }, invalidConfig).pipe(Effect.provide(contentDependencies)),
    ))

    expect(Result.isFailure(contentResult)).toBe(true)
    if (Result.isFailure(contentResult)) {
      expect(contentResult.failure).toBeInstanceOf(
        InvalidReceivedContentConfig,
      )
    }

    const routes = makeInMemoryRoutes()
    const emailDependencies = Layer.mergeAll(
      layerWebCrypto,
      deterministicIdentifiers("invalid-email-config"),
      makeInMemoryMessageStore().layer,
      testOutboundPolicy(),
      makeInMemoryRawArchive().layer,
      routes.layer,
      makeRecordingSendTransport().layer,
    )
    const live = emailLayerWithConfig(invalidConfig).pipe(
      Layer.provide(emailDependencies),
    )
    const serviceResult = await Effect.runPromise(Effect.result(
      Effect.gen(function*() {
        return yield* EmailService
      }).pipe(Effect.provide(live)),
    ))

    expect(Result.isFailure(serviceResult)).toBe(true)
    if (Result.isFailure(serviceResult)) {
      expect(serviceResult.failure).toBeInstanceOf(
        InvalidReceivedContentConfig,
      )
    }
  })

  test("rejects every invalid inbound limit with a typed field error", async () => {
    const fields = [
      "maxBytes",
      "digestDedupeWindowMilliseconds",
      "archiveIntentTtlMilliseconds",
      "cleanupRetryMilliseconds",
    ] as const

    for (const field of fields) {
      for (const value of invalidNumbers) {
        const result = await Effect.runPromise(Effect.result(
          parseInboundConfig({ ...defaultInboundConfig, [field]: value }),
        ))

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(InvalidInboundConfig)
          expect(result.failure.field).toBe(field)
        }
      }
    }

    for (const field of [
      "digestDedupeWindowMilliseconds",
      "archiveIntentTtlMilliseconds",
      "cleanupRetryMilliseconds",
    ] as const) {
      for (const value of [
        MaximumOperationalDurationMilliseconds + 1,
        Number.MAX_SAFE_INTEGER,
      ]) {
        const result = await Effect.runPromise(Effect.result(
          parseInboundConfig({ ...defaultInboundConfig, [field]: value }),
        ))

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(InvalidInboundConfig)
          expect(result.failure.field).toBe(field)
          expect(result.failure.reason).toBe("exceeds_supported_maximum")
        }
      }
    }
  })

  test("rejects invalid inbound config while acquiring its service layer", async () => {
    const routes = makeInMemoryRoutes()
    const dependencies = Layer.mergeAll(
      layerWebCrypto,
      deterministicIdentifiers("invalid-inbound-config"),
      makeInMemoryInboundStore().layer,
      makeInMemoryRawArchive().layer,
      routes.layer,
    )
    const live = inboundLayer({
      ...defaultInboundConfig,
      cleanupRetryMilliseconds: MaximumOperationalDurationMilliseconds + 1,
    }).pipe(Layer.provide(dependencies))
    const result = await Effect.runPromise(Effect.result(
      Effect.gen(function*() {
        return yield* InboundService
      }).pipe(Effect.provide(live)),
    ))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InvalidInboundConfig)
      expect(result.failure.field).toBe("cleanupRetryMilliseconds")
      expect(result.failure.reason).toBe("exceeds_supported_maximum")
    }
  })

  test("rejects every invalid workflow limit with a typed field error", async () => {
    const fields = [
      "defaultLimit",
      "maxLimit",
      "concurrency",
      "maxAttempts",
      "leaseMilliseconds",
      "baseRetryMilliseconds",
      "maxRetryMilliseconds",
    ] as const

    for (const field of fields) {
      for (const value of invalidNumbers) {
        const result = await Effect.runPromise(Effect.result(
          parseWorkflowDispatchConfig({
            ...defaultWorkflowConfig,
            [field]: value,
          }),
        ))

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(
            InvalidWorkflowDispatchConfig,
          )
          expect(result.failure.field).toBe(field)
        }
      }
    }

    for (const field of ["defaultLimit", "maxLimit"] as const) {
      for (const value of [
        MaximumWorkflowReadyLimit + 1,
        Number.MAX_SAFE_INTEGER,
      ]) {
        const result = await Effect.runPromise(Effect.result(
          parseWorkflowDispatchConfig({
            ...defaultWorkflowConfig,
            [field]: value,
          }),
        ))

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(
            InvalidWorkflowDispatchConfig,
          )
          expect(result.failure.field).toBe(field)
          expect(result.failure.reason).toBe("exceeds_supported_maximum")
        }
      }
    }

    for (const field of [
      "leaseMilliseconds",
      "baseRetryMilliseconds",
      "maxRetryMilliseconds",
    ] as const) {
      for (const value of [
        MaximumOperationalDurationMilliseconds + 1,
        Number.MAX_SAFE_INTEGER,
      ]) {
        const result = await Effect.runPromise(Effect.result(
          parseWorkflowDispatchConfig({
            ...defaultWorkflowConfig,
            [field]: value,
          }),
        ))

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(
            InvalidWorkflowDispatchConfig,
          )
          expect(result.failure.field).toBe(field)
          expect(result.failure.reason).toBe("exceeds_supported_maximum")
        }
      }
    }
  })

  test("rejects invalid workflow config while acquiring its service layer", async () => {
    const dependencies = Layer.mergeAll(
      deterministicIdentifiers("invalid-workflow-config"),
      makeInMemoryWorkflowStore().layer,
      makeScriptedWorkflowSink([]).layer,
    )
    const live = workflowLayer({
      ...defaultWorkflowConfig,
      leaseMilliseconds: MaximumOperationalDurationMilliseconds + 1,
    }).pipe(Layer.provide(dependencies))
    const result = await Effect.runPromise(Effect.result(
      Effect.gen(function*() {
        return yield* WorkflowService
      }).pipe(Effect.provide(live)),
    ))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InvalidWorkflowDispatchConfig)
      expect(result.failure.field).toBe("leaseMilliseconds")
      expect(result.failure.reason).toBe("exceeds_supported_maximum")
    }
  })

  test("rejects invalid per-dispatch overrides before store access", async () => {
    for (const field of ["limit", "concurrency"] as const) {
      for (const value of invalidNumbers) {
        const parsed = await Effect.runPromise(Effect.result(
          parseDispatchReadyInput({ [field]: value }),
        ))
        expect(Result.isFailure(parsed)).toBe(true)
        if (Result.isFailure(parsed)) {
          expect(parsed.failure).toBeInstanceOf(
            InvalidWorkflowDispatchInput,
          )
          expect(parsed.failure.field).toBe(field)
        }
      }
    }

    for (const limit of [
      MaximumWorkflowReadyLimit + 1,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const parsed = await Effect.runPromise(Effect.result(
        parseDispatchReadyInput({ limit }),
      ))
      expect(Result.isFailure(parsed)).toBe(true)
      if (Result.isFailure(parsed)) {
        expect(parsed.failure).toBeInstanceOf(InvalidWorkflowDispatchInput)
        expect(parsed.failure.field).toBe("limit")
        expect(parsed.failure.reason).toBe("exceeds_supported_maximum")
      }
    }

    let listReadyCalls = 0
    const workflowStore = makeInMemoryWorkflowStore()
    const guardedStore = WorkflowStore.of({
      ...workflowStore.service,
      listReady: () => Effect.sync(() => {
        listReadyCalls += 1
        return []
      }),
    })
    const dependencies = Layer.mergeAll(
      deterministicIdentifiers("invalid-dispatch-input"),
      Layer.succeed(WorkflowStore, guardedStore),
      makeScriptedWorkflowSink([]).layer,
    )
    const result = await Effect.runPromise(Effect.result(
      Effect.gen(function*() {
        const service = yield* WorkflowService
        return yield* service.dispatchReady({
          limit: MaximumWorkflowReadyLimit + 1,
        })
      }).pipe(
        Effect.provide(workflowLayer().pipe(Layer.provide(dependencies))),
      ),
    ))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InvalidWorkflowDispatchInput)
    }
    expect(listReadyCalls).toBe(0)
  })
})
