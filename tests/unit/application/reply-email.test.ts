import { describe, expect, test } from "bun:test"
import {
  DateTime,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
} from "effect"
import { layerWebCrypto } from "../../../src/adapters/content-digest.js"
import { IdempotencyConflict } from "../../../src/core/email-command.js"
import {
  ActorIdSchema,
  IdempotencyKeySchema,
  MessageIdSchema,
  RequestFingerprintSchema,
  RouteIdSchema,
  Sha256Schema,
  WorkflowIdSchema,
} from "../../../src/core/identifiers.js"
import { MessageSchema } from "../../../src/core/message.js"
import { ReplyCommandSchema } from "../../../src/core/reply-command.js"
import { ScopeSchema } from "../../../src/core/scope.js"
import {
  EmailAddressSchema,
  MailboxHandleSchema,
} from "../../../src/core/address.js"
import {
  replyEmail,
  replyEmailWithPolicy,
  ReplyLoopPrevented,
  ReplyTargetUnavailable,
} from "../../../src/application/reply-email.js"
import {
  conservativeReplyPolicy,
  ReplyPolicy,
  ReplyPolicyRejected,
  type CheckReplyPolicyInput,
} from "../../../src/application/reply-policy.js"
import { deterministicIdentifiers } from "../../../src/testing/identifiers.js"
import { makeInMemoryMessageStore } from "../../../src/testing/message-store.js"
import { testOutboundPolicy } from "../../../src/testing/outbound-policy.js"
import { makeInMemoryRawArchive } from "../../../src/testing/raw-archive.js"
import { makeInMemoryRoutes } from "../../../src/testing/routes.js"
import {
  makeRecordingSendTransport,
} from "../../../src/testing/send-transport.js"

const scope = Schema.decodeUnknownSync(ScopeSchema)({
  namespace: "tenant:reply",
  environment: "live",
})

const actor = {
  _tag: "System" as const,
  id: ActorIdSchema.make("system:reply-test"),
}

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

interface FixtureOptions {
  readonly envelopeFrom?: string
  readonly extraHeaders?: ReadonlyArray<string>
  readonly from?: string
  readonly replyPolicy?: ReplyPolicy["Service"]
  readonly replyTo?: string | null
}

const makeFixture = async (options: FixtureOptions = {}) => {
  const routes = makeInMemoryRoutes()
  const routeId = RouteIdSchema.make("route:workflow-reply")
  const address = EmailAddressSchema.make("workflow@example.com")
  const reserved = await Effect.runPromise(routes.adminStore.reserve({
    id: routeId,
    scope,
    domainId: "domain:live",
    address,
    mailboxHandle: MailboxHandleSchema.make("workflow"),
    inbound: {
      _tag: "Trigger",
      workflowId: WorkflowIdSchema.make("workflow:triage"),
    },
    outbound: { _tag: "Sender", role: "alternate" },
    actor,
    idempotencyKey: IdempotencyKeySchema.make("route:workflow-reply"),
    creationFingerprint: RequestFingerprintSchema.make("1".repeat(64)),
    createdAt: DateTime.makeUnsafe(1_000),
  }))
  const sourceMessageId = MessageIdSchema.make("message:source")
  const replyTo = options.replyTo === undefined
    ? "reply@example.net"
    : options.replyTo
  const rawText = [
    `From: ${options.from ?? "Sender <sender@example.net>"}`,
    ...(replyTo === null ? [] : [`Reply-To: ${replyTo}`]),
    `To: ${address}`,
    "Subject: Need assistance",
    "Message-ID: <source@example.net>",
    "References: <root@example.net>",
    ...(options.extraHeaders ?? []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Please help",
  ].join("\r\n")
  const raw = new TextEncoder().encode(rawText)
  const rawSha256 = await sha256(raw)
  const archive = makeInMemoryRawArchive()
  const rawRef = await Effect.runPromise(archive.service.put({
    scope,
    direction: "inbound",
    messageId: sourceMessageId,
    content: raw,
    sha256: rawSha256,
  }))
  const now = DateTime.makeUnsafe(2_000)
  const source = MessageSchema.cases.Inbound.make({
    id: sourceMessageId,
    scope,
    routeId,
    workflowId: WorkflowIdSchema.make("workflow:triage"),
    from: EmailAddressSchema.make(
      options.envelopeFrom ?? "bounce@example.net",
    ),
    to: [address],
    subject: "Need assistance",
    rfcMessageId: "<source@example.net>",
    sizeBytes: raw.byteLength,
    receivedAt: now,
    createdAt: now,
    updatedAt: now,
    state: MessageSchema.cases.Inbound.fields.state.cases.Received.make({}),
  })
  const messages = makeInMemoryMessageStore()
  messages.seed({
    message: source,
    recipients: [],
    raw: Option.some({
      ref: rawRef,
      sha256: rawSha256,
      sizeBytes: raw.byteLength,
    }),
  })
  const transport = makeRecordingSendTransport()
  const dependencies = Layer.mergeAll(
    layerWebCrypto,
    deterministicIdentifiers("reply"),
    messages.layer,
    testOutboundPolicy(),
    archive.layer,
    Layer.succeed(
      ReplyPolicy,
      options.replyPolicy ?? conservativeReplyPolicy,
    ),
    routes.layer,
    transport.layer,
  )
  const command = (body = "We can help") =>
    Schema.decodeUnknownSync(ReplyCommandSchema)({
      scope,
      actor,
      idempotencyKey: "reply:source",
      sourceMessageId,
      body: { _tag: "Text", text: body },
      headers: [],
      attachments: [],
    })
  const reply = (body?: string) =>
    (options.replyPolicy === undefined
      ? replyEmail(command(body))
      : replyEmailWithPolicy(command(body))).pipe(
        Effect.provide(dependencies),
      )
  return {
    archive,
    command,
    dependencies,
    messages,
    rawRef,
    reply,
    reserved,
    routes,
    source,
    transport,
  }
}

describe("reply email action", () => {
  test("replies from a Trigger + Sender route with derived target and threading", async () => {
    const fixture = await makeFixture()
    const first = await Effect.runPromise(fixture.reply())
    const replay = await Effect.runPromise(fixture.reply())

    expect(replay.message.id).toBe(first.message.id)
    expect(fixture.transport.sent).toHaveLength(1)
    const sent = fixture.transport.sent[0]
    if (sent === undefined) throw new Error("Expected one sent reply")
    const mime = new TextDecoder().decode(sent.rawMime)
    expect(String(sent.from)).toBe("workflow@example.com")
    expect(sent.to.map(String)).toEqual(["reply@example.net"])
    expect(mime).toContain("Subject: Re: Need assistance")
    expect(mime).toContain("In-Reply-To: <source@example.net>")
    expect(mime).toContain(
      "References: <root@example.net> <source@example.net>",
    )
    expect(mime).toContain("Auto-Submitted: auto-replied")
    expect(mime).toContain("X-Auto-Response-Suppress: All")
  })

  test("terminal replay does not require retained source MIME", async () => {
    const fixture = await makeFixture()
    const first = await Effect.runPromise(fixture.reply())
    await Effect.runPromise(fixture.archive.service.remove(fixture.rawRef))
    const replay = await Effect.runPromise(fixture.reply())

    expect(replay.message.id).toBe(first.message.id)
    expect(fixture.transport.sent).toHaveLength(1)
  })

  test("same key with different caller-owned reply content conflicts", async () => {
    const fixture = await makeFixture()
    await Effect.runPromise(fixture.reply())
    const result = await Effect.runPromise(Effect.result(
      fixture.reply("Changed response"),
    ))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(IdempotencyConflict)
    }
    expect(fixture.transport.sent).toHaveLength(1)
  })

  test("fails closed on an ambiguous Reply-To before reservation or handoff", async () => {
    const fixture = await makeFixture({
      replyTo: "first@example.net, second@example.net",
    })
    const result = await Effect.runPromise(Effect.result(fixture.reply()))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ReplyTargetUnavailable)
      if (result.failure._tag === "ReplyTargetUnavailable") {
        expect(result.failure.reason).toBe("ambiguous")
      }
    }
    expect(fixture.messages.records).toHaveLength(1)
    expect(fixture.transport.sent).toHaveLength(0)
  })

  test("falls back to trusted envelope provenance when optional address headers are malformed", async () => {
    const fixture = await makeFixture({
      from: "not-an-address",
      replyTo: "also-not-an-address",
    })
    await Effect.runPromise(fixture.reply())

    expect(fixture.transport.sent).toHaveLength(1)
    expect(fixture.transport.sent[0]?.to.map(String)).toEqual([
      "bounce@example.net",
    ])
  })

  test("prevents a reply back into its own managed receiving route", async () => {
    const fixture = await makeFixture({
      replyPolicy: ReplyPolicy.of({ check: () => Effect.void }),
      replyTo: "workflow@example.com",
    })
    const result = await Effect.runPromise(Effect.result(fixture.reply()))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ReplyLoopPrevented)
      if (result.failure._tag === "ReplyLoopPrevented") {
        expect(result.failure.reason).toBe("self_target")
      }
    }
    expect(fixture.messages.records).toHaveLength(1)
    expect(fixture.transport.sent).toHaveLength(0)
  })

  test("prevents a reply into any other active Trigger route", async () => {
    const fixture = await makeFixture({
      replyTo: "managed@example.com",
    })
    await Effect.runPromise(fixture.routes.adminStore.reserve({
      id: RouteIdSchema.make("route:managed-target"),
      scope,
      domainId: "domain:live",
      address: EmailAddressSchema.make("managed@example.com"),
      mailboxHandle: MailboxHandleSchema.make("managed"),
      inbound: {
        _tag: "Trigger",
        workflowId: WorkflowIdSchema.make("workflow:managed-target"),
      },
      outbound: { _tag: "Disabled" },
      actor,
      idempotencyKey: IdempotencyKeySchema.make("route:managed-target"),
      creationFingerprint: RequestFingerprintSchema.make("2".repeat(64)),
      createdAt: DateTime.makeUnsafe(1_500),
    }))
    const result = await Effect.runPromise(Effect.result(fixture.reply()))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ReplyLoopPrevented)
      if (result.failure._tag === "ReplyLoopPrevented") {
        expect(result.failure.reason).toBe("active_trigger_target")
      }
    }
    expect(fixture.messages.records).toHaveLength(1)
    expect(fixture.transport.sent).toHaveLength(0)
  })

  test("allows a reply into a managed Store route that cannot trigger a loop", async () => {
    const fixture = await makeFixture({
      replyTo: "stored@example.com",
    })
    await Effect.runPromise(fixture.routes.adminStore.reserve({
      id: RouteIdSchema.make("route:stored-target"),
      scope,
      domainId: "domain:live",
      address: EmailAddressSchema.make("stored@example.com"),
      mailboxHandle: MailboxHandleSchema.make("stored"),
      inbound: { _tag: "Store" },
      outbound: { _tag: "Disabled" },
      actor,
      idempotencyKey: IdempotencyKeySchema.make("route:stored-target"),
      creationFingerprint: RequestFingerprintSchema.make("3".repeat(64)),
      createdAt: DateTime.makeUnsafe(1_500),
    }))
    await Effect.runPromise(fixture.reply())

    expect(fixture.transport.sent).toHaveLength(1)
    expect(fixture.transport.sent[0]?.to.map(String)).toEqual([
      "stored@example.com",
    ])
  })

  test("prevents automatic and list-originated sources before sending", async () => {
    const fixture = await makeFixture({
      extraHeaders: [
        "Auto-Submitted: auto-generated",
        "Precedence: list",
        "List-ID: Updates <updates.example.net>",
      ],
    })
    const result = await Effect.runPromise(Effect.result(fixture.reply()))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ReplyLoopPrevented)
      if (result.failure._tag === "ReplyLoopPrevented") {
        expect(result.failure.reason).toBe("automatic_source")
      }
    }
    expect(fixture.messages.records).toHaveLength(1)
    expect(fixture.transport.sent).toHaveLength(0)
  })

  test("lets a host policy deliberately authorize an automated source", async () => {
    const fixture = await makeFixture({
      extraHeaders: [
        "Auto-Submitted: auto-generated",
        "Precedence: list",
        "List-ID: Updates <updates.example.net>",
      ],
      replyPolicy: ReplyPolicy.of({ check: () => Effect.void }),
    })

    await Effect.runPromise(fixture.reply())

    expect(fixture.transport.sent).toHaveLength(1)
  })

  test("exposes derived context to host authentication policy", async () => {
    const checked: Array<CheckReplyPolicyInput> = []
    const fixture = await makeFixture({
      replyPolicy: ReplyPolicy.of({
        check: (input) => {
          checked.push(input)
          return Effect.fail(new ReplyPolicyRejected({
            messageId: input.source.id,
            reason: "sender_authentication_required",
          }))
        },
      }),
    })

    const result = await Effect.runPromise(Effect.result(fixture.reply()))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ReplyPolicyRejected)
      if (result.failure._tag === "ReplyPolicyRejected") {
        expect(result.failure.reason).toBe("sender_authentication_required")
      }
    }
    expect(checked).toHaveLength(1)
    const policyInput = checked[0]
    if (policyInput === undefined) {
      throw new Error("Expected one reply-policy decision")
    }
    expect(policyInput.source.id).toBe(fixture.source.id)
    expect(policyInput.content.text?.trim()).toBe("Please help")
    expect(policyInput.sourceRoute.id).toBe(fixture.reserved.record.route.id)
    expect(String(policyInput.target)).toBe("reply@example.net")
    expect(Option.isNone(policyInput.targetRoute)).toBe(true)
    expect(fixture.messages.records).toHaveLength(1)
    expect(fixture.transport.sent).toHaveLength(0)
  })
})
