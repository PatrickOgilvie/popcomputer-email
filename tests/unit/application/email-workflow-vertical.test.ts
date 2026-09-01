import { describe, expect, test } from "bun:test"
import {
  DateTime,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect"
import { TestClock } from "effect/testing"
import { layerWebCrypto } from "../../../src/adapters/content-digest.js"
import { WorkflowTriggerSink } from "../../../src/adapters/workflow-trigger-sink.js"
import {
  InboundService,
  layer as inboundLayer,
} from "../../../src/application/inbound-service.js"
import {
  getReceivedContent,
} from "../../../src/application/read-received-content.js"
import { replyEmail } from "../../../src/application/reply-email.js"
import {
  WorkflowService,
  layer as workflowLayer,
} from "../../../src/application/workflow-service.js"
import {
  EmailAddressSchema,
  MailboxHandleSchema,
} from "../../../src/core/address.js"
import {
  ActorIdSchema,
  IdempotencyKeySchema,
  RequestFingerprintSchema,
  RouteIdSchema,
  Sha256Schema,
  WorkflowIdSchema,
  WorkflowRunIdSchema,
} from "../../../src/core/identifiers.js"
import { ReplyCommandSchema } from "../../../src/core/reply-command.js"
import { ScopeSchema } from "../../../src/core/scope.js"
import {
  WorkflowStartAmbiguousFailure,
  type WorkflowDispatchIdempotencyKey,
} from "../../../src/core/workflow.js"
import {
  deterministicIdentifiers,
} from "../../../src/testing/identifiers.js"
import { makeInMemoryInboundStore } from "../../../src/testing/inbound-store.js"
import { makeInMemoryMessageStore } from "../../../src/testing/message-store.js"
import { testOutboundPolicy } from "../../../src/testing/outbound-policy.js"
import { makeInMemoryRawArchive } from "../../../src/testing/raw-archive.js"
import { makeInMemoryRoutes } from "../../../src/testing/routes.js"
import {
  makeRecordingSendTransport,
} from "../../../src/testing/send-transport.js"
import { makeInMemoryWorkflowStore } from "../../../src/testing/workflow.js"

const scope = Schema.decodeUnknownSync(ScopeSchema)({
  namespace: "tenant:vertical",
  environment: "live",
})

const actor = {
  _tag: "System" as const,
  id: ActorIdSchema.make("system:vertical"),
}

const rawMime = [
  "From: Customer <customer@example.net>",
  "Reply-To: customer-replies@example.net",
  "To: triage@example.com",
  "Subject: Help",
  "Message-ID: <vertical@example.net>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Please help with order 42.",
].join("\r\n")

const sha256 = async (content: Uint8Array) => {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(content),
  )
  return Sha256Schema.make(
    Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join(""),
  )
}

const stream = (content: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from(content))
      controller.close()
    },
  })

describe("email workflow vertical", () => {
  test("deduplicates delivery, workflow ACK loss, and replayed reply actions", async () => {
    const raw = new TextEncoder().encode(rawMime)
    const rawSha256 = await sha256(raw)
    const routes = makeInMemoryRoutes()
    const workflows = makeInMemoryWorkflowStore()
    const inbound = makeInMemoryInboundStore({
      onWorkflowEvent: workflows.enqueue,
    })
    const messages = makeInMemoryMessageStore()
    const archive = makeInMemoryRawArchive()
    const transport = makeRecordingSendTransport()
    const routeId = RouteIdSchema.make("route:vertical")
    const routeAddress = EmailAddressSchema.make("triage@example.com")
    await Effect.runPromise(routes.adminStore.reserve({
      id: routeId,
      scope,
      domainId: "domain:live",
      address: routeAddress,
      mailboxHandle: MailboxHandleSchema.make("triage"),
      inbound: {
        _tag: "Trigger",
        workflowId: WorkflowIdSchema.make("workflow:triage"),
      },
      outbound: { _tag: "Sender", role: "alternate" },
      actor,
      idempotencyKey: IdempotencyKeySchema.make("route:vertical"),
      creationFingerprint: RequestFingerprintSchema.make("4".repeat(64)),
      createdAt: DateTime.makeUnsafe(0),
    }))

    const inboundLive = inboundLayer().pipe(Layer.provide(Layer.mergeAll(
      layerWebCrypto,
      deterministicIdentifiers("vertical-inbound"),
      routes.layer,
      inbound.layer,
      archive.layer,
    )))
    const ingest = () => Effect.gen(function*() {
      const service = yield* InboundService
      return yield* service.ingest({
        from: EmailAddressSchema.make("bounce@example.net"),
        to: routeAddress,
        raw: stream(raw),
        receivedAt: DateTime.makeUnsafe(0),
      })
    }).pipe(Effect.provide(inboundLive))
    const { first, duplicate } = await Effect.runPromise(Effect.gen(function*() {
      yield* TestClock.setTime(1_000)
      const first = yield* ingest()
      const duplicate = yield* ingest()
      return { first, duplicate }
    }).pipe(Effect.provide(TestClock.layer())))

    expect(duplicate.id).toBe(first.id)
    expect(inbound.messages).toHaveLength(1)
    expect(workflows.events).toHaveLength(1)
    expect(archive.objects.size).toBe(1)

    const rawRef = await Effect.runPromise(archive.service.referenceFor({
      scope,
      direction: "inbound",
      messageId: first.id,
      content: raw,
      sha256: rawSha256,
    }))
    messages.seed({
      message: first,
      recipients: [],
      raw: Option.some({
        ref: rawRef,
        sha256: rawSha256,
        sizeBytes: raw.byteLength,
      }),
    })

    const emailDependencies = Layer.mergeAll(
      layerWebCrypto,
      deterministicIdentifiers("vertical-reply"),
      messages.layer,
      testOutboundPolicy(),
      archive.layer,
      routes.layer,
      transport.layer,
    )
    const attempts: Array<WorkflowDispatchIdempotencyKey> = []
    const resolvedBodies: Array<string | null> = []
    const accepted = new Map<WorkflowDispatchIdempotencyKey, string>()
    let bodyExecutions = 0
    const sink = WorkflowTriggerSink.of({
      start: (input) => Effect.gen(function*() {
        attempts.push(input.idempotencyKey)
        const existing = accepted.get(input.idempotencyKey)
        if (existing !== undefined) {
          return WorkflowRunIdSchema.make(existing)
        }
        const runId = WorkflowRunIdSchema.make("run:vertical")
        accepted.set(input.idempotencyKey, runId)
        bodyExecutions += 1
        const content = yield* getReceivedContent({
          scope: input.event.scope,
          messageId: input.event.message.id,
        }).pipe(
          Effect.provide(emailDependencies),
          Effect.orDie,
        )
        resolvedBodies.push(content.text)
        const replyCommand = Schema.decodeUnknownSync(ReplyCommandSchema)({
          scope: input.event.scope,
          actor,
          idempotencyKey:
            `workflow:${input.event.eventId}:reply`,
          sourceMessageId: input.event.message.id,
          body: { _tag: "Text", text: "We are on it." },
          headers: [],
          attachments: [],
        })
        yield* replyEmail(replyCommand).pipe(
          Effect.provide(emailDependencies),
          Effect.orDie,
        )
        yield* replyEmail(replyCommand).pipe(
          Effect.provide(emailDependencies),
          Effect.orDie,
        )
        return yield* new WorkflowStartAmbiguousFailure({
          reason: "timeout",
        })
      }),
    })
    const workflowLive = workflowLayer({
      defaultLimit: 25,
      maxLimit: 100,
      concurrency: 1,
      maxAttempts: 3,
      leaseMilliseconds: 60_000,
      baseRetryMilliseconds: 1_000,
      maxRetryMilliseconds: 1_000,
    }).pipe(Layer.provide(Layer.mergeAll(
      deterministicIdentifiers("vertical-workflow"),
      workflows.layer,
      Layer.succeed(WorkflowTriggerSink, sink),
    )))

    const dispatches = await Effect.runPromise(Effect.gen(function*() {
      yield* TestClock.setTime(1_000)
      const service = yield* WorkflowService
      const firstPass = yield* service.dispatchReady()
      yield* TestClock.adjust("1 second")
      const secondPass = yield* service.dispatchReady()
      return { firstPass, secondPass }
    }).pipe(
      Effect.provide(workflowLive),
      Effect.provide(TestClock.layer()),
    ))

    expect(dispatches.firstPass.failed).toBe(1)
    expect(dispatches.secondPass.started).toBe(1)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toBe(attempts[1])
    expect(accepted.size).toBe(1)
    expect(bodyExecutions).toBe(1)
    expect(resolvedBodies.map((body) => body?.trim() ?? null)).toEqual([
      "Please help with order 42.",
    ])
    expect(transport.sent).toHaveLength(1)
    const sent = transport.sent[0]
    if (sent === undefined) throw new Error("Expected one workflow reply")
    expect(String(sent.from)).toBe("triage@example.com")
    expect(sent.to.map(String)).toEqual([
      "customer-replies@example.net",
    ])
  })
})
