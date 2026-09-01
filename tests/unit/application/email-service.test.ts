import { describe, expect, test } from "bun:test"
import {
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Logger,
  Option,
  Result,
  Schema,
  Tracer,
} from "effect"
import { ContentDigest } from "../../../src/adapters/content-digest.js"
import { IdentifierGenerator } from "../../../src/adapters/identifier-generator.js"
import { OutboundPolicy } from "../../../src/adapters/outbound-policy.js"
import {
  MessageStore,
  MessageStoreFailure,
  MessageTransitionConflict,
  type ArchivedRawMessage,
  type FinalizeOutboundInput,
  type ReserveOutboundResult,
  type StoredOutboundMessage,
} from "../../../src/adapters/message-store.js"
import {
  RawMessageArchive,
  RawMessageArchiveFailure,
  type RawMime,
} from "../../../src/adapters/raw-message-archive.js"
import { RouteStore } from "../../../src/adapters/route-store.js"
import {
  SendIndeterminate,
  SendRejected,
  SendTransport,
  type SendTransportResult,
  type TransportMessage,
} from "../../../src/adapters/send-transport.js"
import { EmailAddressSchema, MailboxHandleSchema } from "../../../src/core/address.js"
import {
  MessageTooLarge,
  RecipientNotPermitted,
  SendCommandSchema,
  type SendCommand,
} from "../../../src/core/email-command.js"
import {
  ActorIdSchema,
  LeaseTokenSchema,
  type MessageId,
  MessageIdSchema,
  RawMessageRefSchema,
  RecipientIdSchema,
  RequestFingerprintSchema,
  RouteIdSchema,
  Sha256Schema,
  TestRecipientIdSchema,
  WorkflowEventIdSchema,
} from "../../../src/core/identifiers.js"
import {
  claimForSending,
  failAfterHandoff,
  failBeforeHandoff,
  isReserved,
  isSending,
  markAccepted,
  markCaptured,
  markDeliveryUnknown,
  markPartiallyAccepted,
  type MessageRecipient,
  type OutboundMessage,
  PartialRecipientOutcomesSchema,
} from "../../../src/core/message.js"
import {
  RouteLifecycleSchema,
  RouteRevisionSchema,
  RouteSchema,
  isSender,
} from "../../../src/core/route.js"
import { ScopeSchema, type Scope } from "../../../src/core/scope.js"
import {
  getMessage,
  listMessages,
  readRawMime,
} from "../../../src/application/read-email.js"
import { renderMime } from "../../../src/application/render-mime.js"
import { sendEmail } from "../../../src/application/send-email.js"
import { projectMessageEnvelope } from "../../../src/protocol/projections.js"
import { makeTestOutboundPolicy } from "../../../src/testing/outbound-policy.js"

const scope = Schema.decodeUnknownSync(ScopeSchema)({
  namespace: "tenant:application-test",
  environment: "live",
})

const routeCandidate = RouteSchema.make({
  id: RouteIdSchema.make("route:default"),
  scope,
  address: EmailAddressSchema.make("sender@example.com"),
  mailboxHandle: MailboxHandleSchema.make("sender"),
  inbound: { _tag: "Store" },
  outbound: { _tag: "Sender", role: "default" },
  lifecycle: RouteLifecycleSchema.cases.Active.make({}),
  revision: RouteRevisionSchema.make(1),
  actor: {
    _tag: "System",
    id: ActorIdSchema.make("system:test"),
  },
  createdAt: DateTime.makeUnsafe(1_000),
  updatedAt: DateTime.makeUnsafe(1_000),
})
if (!isSender(routeCandidate)) throw new Error("expected sender route fixture")
const route = routeCandidate

const command = (idempotencyKey = "send:test-1"): SendCommand =>
  Schema.decodeUnknownSync(SendCommandSchema)({
    scope,
    actor: { _tag: "User", id: "user:test" },
    idempotencyKey,
    from: { _tag: "DefaultRoute" },
    to: ["recipient@example.com"],
    cc: [],
    bcc: ["blind@example.com"],
    subject: "Application slice",
    body: { _tag: "Multipart", text: "hello", html: "<p>hello</p>" },
    headers: [{ name: "X-Test", value: "email-service" }],
    attachments: [],
  })

const scopeKey = (value: Scope): string =>
  `${value.namespace}\u0000${value.environment}`

const reservationKey = (message: OutboundMessage): string =>
  `${scopeKey(message.scope)}\u0000${message.idempotencyKey}`

const messageKey = (valueScope: Scope, messageId: string): string =>
  `${scopeKey(valueScope)}\u0000${messageId}`

const digestHex = (content: Uint8Array): Effect.Effect<string> =>
  Effect.promise(async () => {
    const result = await globalThis.crypto.subtle.digest(
      "SHA-256",
      Uint8Array.from(content),
    )
    return Array.from(new Uint8Array(result), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  })

const captureTelemetry = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const spans: Array<Tracer.NativeSpan> = []
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })
  const logger = Logger.make<unknown, void>((options) => {
    logs.push(Logger.formatStructured.log(options))
  })
  return effect.pipe(
    Effect.provideService(Tracer.Tracer, tracer),
    Effect.provide(Logger.layer([logger])),
    Effect.exit,
    Effect.map((exit) => ({ exit, logs, spans })),
  )
}

type SendBehavior = (
  message: TransportMessage,
) => Effect.Effect<SendTransportResult, SendRejected | SendIndeterminate>

const captured: SendTransportResult = { _tag: "Captured" }

const updateRecord = (
  recordsById: Map<string, StoredOutboundMessage>,
  record: StoredOutboundMessage,
  message: OutboundMessage,
): StoredOutboundMessage => {
  const next = { ...record, message }
  recordsById.set(messageKey(message.scope, message.id), next)
  return next
}

const finalizedMessage = (
  record: StoredOutboundMessage,
  input: FinalizeOutboundInput,
): Effect.Effect<OutboundMessage, MessageTransitionConflict> => {
  const message = record.message
  const finalization = input.finalization
  switch (finalization._tag) {
    case "Captured":
      return isSending(message)
        ? Effect.succeed(markCaptured(message, finalization.capturedAt))
        : Effect.fail(new MessageTransitionConflict({
            messageId: message.id,
            reason: "concurrent_update",
          }))
    case "Accepted":
      if (!isSending(message)) {
        return Effect.fail(new MessageTransitionConflict({
            messageId: message.id,
            reason: "concurrent_update",
          }))
      }
      return Effect.succeed(markAccepted(
        message,
        finalization.providerMessageId === undefined
          ? { sentAt: finalization.sentAt }
          : {
              sentAt: finalization.sentAt,
              providerMessageId: finalization.providerMessageId,
            },
      ))
    case "PartiallyAccepted":
      if (!isSending(message)) {
        return Effect.fail(new MessageTransitionConflict({
            messageId: message.id,
            reason: "concurrent_update",
          }))
      }
      const outcomes = Schema.decodeUnknownSync(
        PartialRecipientOutcomesSchema,
      )(finalization.outcomes)
      return Effect.succeed(markPartiallyAccepted(
        message,
        finalization.providerMessageId === undefined
          ? { sentAt: finalization.sentAt, outcomes }
          : {
              sentAt: finalization.sentAt,
              providerMessageId: finalization.providerMessageId,
              outcomes,
            },
      ))
    case "DeliveryUnknown":
      return isSending(message)
        ? Effect.succeed(markDeliveryUnknown(message, {
            occurredAt: finalization.occurredAt,
            reason: finalization.reason,
          }))
        : Effect.fail(new MessageTransitionConflict({
            messageId: message.id,
            reason: "concurrent_update",
          }))
    case "Failed":
      if (isReserved(message) && finalization.reason !== "provider_rejected") {
        return Effect.succeed(failBeforeHandoff(message, {
          failedAt: finalization.failedAt,
          reason: finalization.reason,
        }))
      }
      if (isSending(message) && finalization.reason !== "archive") {
        return Effect.succeed(failAfterHandoff(message, {
          failedAt: finalization.failedAt,
          reason: finalization.reason,
        }))
      }
      return Effect.fail(new MessageTransitionConflict({
        messageId: message.id,
        reason: "concurrent_update",
      }))
  }
}

const finalizedRecipients = (
  record: StoredOutboundMessage,
  input: FinalizeOutboundInput,
): ReadonlyArray<MessageRecipient> => {
  const finalization = input.finalization
  switch (finalization._tag) {
    case "Captured":
      return record.recipients.map((recipient) => ({
        ...recipient,
        status: "captured",
        updatedAt: finalization.capturedAt,
      }))
    case "Accepted":
    case "PartiallyAccepted": {
      const statusByAddress = new Map(
        finalization.outcomes.map((outcome) => [
          outcome.address,
          outcome._tag === "Accepted" ? "queued" as const : "failed" as const,
        ]),
      )
      return record.recipients.map((recipient) => ({
        ...recipient,
        status: statusByAddress.get(recipient.address) ?? recipient.status,
        updatedAt: finalization.sentAt,
      }))
    }
    case "Failed":
      return finalization.reason === "provider_rejected"
        ? record.recipients.map((recipient) => ({
            ...recipient,
            status: "failed",
            updatedAt: finalization.failedAt,
          }))
        : record.recipients
    case "DeliveryUnknown":
      return record.recipients
  }
}

const makeHarness = (
  behavior: SendBehavior = () => Effect.succeed(captured),
  policy: OutboundPolicy["Service"] = makeTestOutboundPolicy(),
  options: {
    readonly archiveFailuresBeforeSuccess?: number
    readonly attachFailuresBeforeSuccess?: number
  } = {},
) => {
  const recordsById = new Map<string, StoredOutboundMessage>()
  const recordsByReservation = new Map<string, StoredOutboundMessage>()
  const archiveIntents = new Map<string, ArchivedRawMessage>()
  const archived = new Map<string, Uint8Array>()
  const sent: Array<TransportMessage> = []
  let identifier = 0
  let archiveAttempts = 0
  let attachAttempts = 0

  const store = MessageStore.of({
    findOutboundByIdempotency: (input) =>
      Effect.sync(() => {
        const record = recordsByReservation.get(
          `${scopeKey(input.scope)}\u0000${input.idempotencyKey}`,
        )
        return record === undefined ? Option.none() : Option.some(record)
      }),
    reserveOutbound: (input) =>
      Effect.sync(() => {
        const key = reservationKey(input.message)
        const existing = recordsByReservation.get(key)
        if (existing !== undefined) {
          const result: ReserveOutboundResult = {
            _tag: "Existing",
            record: existing,
          }
          return result
        }
        const recipients: ReadonlyArray<MessageRecipient> = input.recipients.map(
          (recipient) => ({
            ...recipient,
            messageId: input.message.id,
            status: "pending",
            createdAt: input.message.createdAt,
            updatedAt: input.message.createdAt,
          }),
        )
        const record: StoredOutboundMessage = {
          message: input.message,
          recipients,
          raw: Option.none(),
        }
        recordsByReservation.set(key, record)
        recordsById.set(
          messageKey(input.message.scope, input.message.id),
          record,
        )
        const result: ReserveOutboundResult = { _tag: "Created", record }
        return result
      }),
    createOutboundArchiveIntent: (input) =>
      Effect.sync(() => {
        const key = messageKey(input.scope, input.messageId)
        const record = recordsById.get(key)
        if (record === undefined) throw new Error("missing test reservation")
        if (Option.isSome(record.raw)) return
        const existing = archiveIntents.get(key)
        if (
          existing !== undefined &&
          (
            existing.ref !== input.raw.ref ||
            existing.sha256 !== input.raw.sha256 ||
            existing.sizeBytes !== input.raw.sizeBytes
          )
        ) {
          throw new Error("conflicting test archive intent")
        }
        archiveIntents.set(key, input.raw)
      }),
    attachOutboundRaw: (input) =>
      Effect.gen(function*() {
        attachAttempts += 1
        if (attachAttempts <= (options.attachFailuresBeforeSuccess ?? 0)) {
          return yield* new MessageStoreFailure({
            operation: "attach_raw",
            reason: "unavailable",
          })
        }
        const key = messageKey(input.scope, input.messageId)
        const record = recordsById.get(key)
        if (record === undefined) throw new Error("missing test reservation")
        const intent = archiveIntents.get(key)
        if (Option.isNone(record.raw) && intent === undefined) {
          throw new Error("missing test archive intent")
        }
        const next = { ...record, raw: Option.some(input.raw) }
        recordsById.set(key, next)
        recordsByReservation.set(reservationKey(record.message), next)
        archiveIntents.delete(key)
        return next
      }),
    claimOutbound: (input) =>
      Effect.sync(() => {
        const record = recordsById.get(messageKey(input.scope, input.messageId))
        if (record === undefined) throw new Error("missing test reservation")
        if (!isReserved(record.message)) {
          return { _tag: "NotClaimed" as const, record }
        }
        const next = updateRecord(
          recordsById,
          record,
          claimForSending(record.message, input.claimedAt),
        )
        recordsByReservation.set(reservationKey(next.message), next)
        if (!isSending(next.message)) throw new Error("test claim did not send")
        return { _tag: "Claimed" as const, record: { ...next, message: next.message } }
      }),
    finalizeOutbound: (input) =>
      Effect.gen(function*() {
        const record = recordsById.get(messageKey(input.scope, input.messageId))
        if (record === undefined) throw new Error("missing test reservation")
        const message = yield* finalizedMessage(record, input)
        const next = updateRecord(recordsById, {
          ...record,
          recipients: finalizedRecipients(record, input),
        }, message)
        recordsByReservation.set(reservationKey(next.message), next)
        return next
      }),
    get: (input) =>
      Effect.sync(() => {
        const record = recordsById.get(messageKey(input.scope, input.messageId))
        return record === undefined ? Option.none() : Option.some(record)
      }),
    list: (input) =>
      Effect.sync(() => ({
        items: Array.from(recordsById.values())
          .filter((record) =>
            scopeKey(record.message.scope) === scopeKey(input.scope)
          ),
        nextCursor: Option.none(),
      })),
  })

  const archive = RawMessageArchive.of({
    referenceFor: (input) =>
      Effect.succeed(RawMessageRefSchema.make(`raw:${input.messageId}`)),
    put: (input) =>
      Effect.gen(function*() {
        const ref = RawMessageRefSchema.make(`raw:${input.messageId}`)
        archived.set(ref, Uint8Array.from(input.content))
        archiveAttempts += 1
        if (
          archiveAttempts <= (options.archiveFailuresBeforeSuccess ?? 0)
        ) {
          return yield* new RawMessageArchiveFailure({
            operation: "put",
            reason: "unavailable",
          })
        }
        return ref
      }),
    get: (ref) =>
      Effect.sync(() => {
        const content = archived.get(ref)
        if (content === undefined) return Option.none()
        const raw: RawMime = {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Uint8Array.from(content))
              controller.close()
            },
          }),
          contentType: "message/rfc822",
          sizeBytes: content.byteLength,
        }
        return Option.some(raw)
      }),
    remove: (ref) => Effect.sync(() => void archived.delete(ref)),
  })

  const digest = ContentDigest.of({
    sha256: (content) =>
      digestHex(content).pipe(Effect.map(Sha256Schema.make)),
    requestFingerprint: (content) =>
      digestHex(content).pipe(Effect.map(RequestFingerprintSchema.make)),
  })

  const identifiers = IdentifierGenerator.of({
    messageId: Effect.sync(() => {
      identifier += 1
      return MessageIdSchema.make(`message:${identifier}`)
    }),
    recipientId: Effect.sync(() => {
      identifier += 1
      return RecipientIdSchema.make(`recipient:${identifier}`)
    }),
    routeId: Effect.succeed(RouteIdSchema.make("route:generated")),
    testRecipientId: Effect.succeed(
      TestRecipientIdSchema.make("test-recipient:generated"),
    ),
    workflowEventId: Effect.succeed(
      WorkflowEventIdSchema.make("workflow-event:generated"),
    ),
    leaseToken: Effect.succeed(LeaseTokenSchema.make("lease:generated")),
  })

  const routes = RouteStore.of({
    findDefaultSender: () => Effect.succeed(Option.some(route)),
    findById: (_inputScope, routeId) =>
      Effect.succeed(routeId === route.id ? Option.some(route) : Option.none()),
    findByInboundAddress: (address) =>
      Effect.succeed(address === route.address ? Option.some(route) : Option.none()),
  })

  const transport = SendTransport.of({
    preflight: () => Effect.void,
    send: (message) =>
      Effect.sync(() => void sent.push(message)).pipe(
        Effect.flatMap(() => behavior(message)),
      ),
  })
  const send = (input: SendCommand) =>
    sendEmail(input).pipe(
      Effect.provideService(ContentDigest, digest),
      Effect.provideService(IdentifierGenerator, identifiers),
      Effect.provideService(MessageStore, store),
      Effect.provideService(OutboundPolicy, policy),
      Effect.provideService(RawMessageArchive, archive),
      Effect.provideService(RouteStore, routes),
      Effect.provideService(SendTransport, transport),
    )

  const raw = (messageId: MessageId) =>
    readRawMime({ scope, messageId }).pipe(
      Effect.provideService(MessageStore, store),
      Effect.provideService(RawMessageArchive, archive),
    )

  const get = (messageId: MessageId) =>
    getMessage({ scope, messageId }).pipe(
      Effect.provideService(MessageStore, store),
    )

  const list = () =>
    listMessages({ scope }).pipe(
      Effect.provideService(MessageStore, store),
    )

  const record = (): StoredOutboundMessage | undefined =>
    recordsByReservation.values().next().value

  return {
    get,
    list,
    raw,
    record,
    send,
    sent,
    get archiveIntentCount() {
      return archiveIntents.size
    },
    get archiveAttempts() {
      return archiveAttempts
    },
  }
}

describe("email application service", () => {
  test("renders deterministic MIME without exposing blind recipients", () => {
    const input = command()
    const rendering = {
      messageId: MessageIdSchema.make("message:mime"),
      createdAt: DateTime.makeUnsafe(1_000),
      from: route.address,
      command: input,
    }
    const first = renderMime(rendering)
    const second = renderMime(rendering)
    const text = new TextDecoder().decode(first)

    expect(first).toEqual(second)
    expect(text).toContain("To: recipient@example.com")
    expect(text).not.toContain("Bcc:")
    expect(text).not.toContain("blind@example.com")
  })

  test("marks workflow-generated sends for automatic-response loop safety", () => {
    const input = SendCommandSchema.make({
      ...command("send:automated"),
      automation: "auto_generated",
    })
    const text = new TextDecoder().decode(renderMime({
      messageId: MessageIdSchema.make("message:automated"),
      createdAt: DateTime.makeUnsafe(1_000),
      from: route.address,
      command: input,
    }))

    expect(text).toContain("Auto-Submitted: auto-generated")
    expect(text).toContain("X-Auto-Response-Suppress: All")
  })

  test("replays matching reservations and rejects changed commands", async () => {
    const harness = makeHarness()
    const input = command()
    const first = await Effect.runPromise(harness.send(input))
    const replay = await Effect.runPromise(harness.send(input))
    const conflict = await Effect.runPromise(
      Effect.result(harness.send({ ...input, subject: "changed" })),
    )
    const automationConflict = await Effect.runPromise(
      Effect.result(harness.send({
        ...input,
        automation: "auto_generated",
      })),
    )

    expect(replay.message.id).toBe(first.message.id)
    expect(replay.recipients).toEqual(first.recipients)
    expect(harness.sent).toHaveLength(1)
    expect(Result.isFailure(conflict)).toBe(true)
    if (Result.isFailure(conflict)) {
      expect(conflict.failure._tag).toBe("IdempotencyConflict")
    }
    expect(Result.isFailure(automationConflict)).toBe(true)
    if (Result.isFailure(automationConflict)) {
      expect(automationConflict.failure._tag).toBe("IdempotencyConflict")
    }
  })

  test("allows exactly one transport call across concurrent replays", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const harness = makeHarness(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(captured),
          ))
        const input = command("send:concurrent")
        const first = yield* harness.send(input).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const replay = yield* harness.send(input)
        yield* Deferred.succeed(release, undefined)
        const completed = yield* Fiber.join(first)
        return {
          completed,
          replay,
          sends: harness.sent.length,
        }
      }),
    )

    expect(outcome.sends).toBe(1)
    expect(outcome.replay.message.id).toBe(outcome.completed.message.id)
    expect(outcome.replay.message.state._tag).toBe("Sending")
    expect(outcome.completed.message.state._tag).toBe("Captured")
  })

  test("persists captured, accepted, rejected, and indeterminate outcomes", async () => {
    const capturedHarness = makeHarness()
    const capturedMessage = await Effect.runPromise(
      capturedHarness.send(command("send:captured")),
    )

    const acceptedHarness = makeHarness((message) =>
      Effect.succeed({
        _tag: "Accepted",
        outcomes: [...message.to, ...message.cc, ...message.bcc].map((address) => ({
          _tag: "Accepted",
          address,
        })),
      }))
    const acceptedMessage = await Effect.runPromise(
      acceptedHarness.send(command("send:accepted")),
    )

    const rejectedHarness = makeHarness(() =>
      Effect.fail(new SendRejected({ reason: "provider_rejected" })))
    const rejectedMessage = await Effect.runPromise(
      rejectedHarness.send(command("send:rejected")),
    )

    const unknownHarness = makeHarness(() =>
      Effect.fail(new SendIndeterminate({ reason: "timeout" })))
    const unknownMessage = await Effect.runPromise(
      unknownHarness.send(command("send:unknown")),
    )

    expect(capturedMessage.message.state._tag).toBe("Captured")
    expect(acceptedMessage.message.state._tag).toBe("Accepted")
    expect(acceptedMessage.recipients.map((recipient) => recipient.status)).toEqual([
      "queued",
      "queued",
    ])
    expect(rejectedMessage.message.state._tag).toBe("Failed")
    expect(unknownMessage.message.state._tag).toBe("DeliveryUnknown")
  })

  test("treats incomplete or mismatched accepted outcomes as ambiguous", async () => {
    const incomplete = makeHarness(() =>
      Effect.succeed({ _tag: "Accepted", outcomes: [] }))
    const mismatched = makeHarness(() =>
      Effect.succeed({
        _tag: "Accepted",
        outcomes: [
          {
            _tag: "Accepted",
            address: EmailAddressSchema.make("someone-else@example.com"),
          },
          {
            _tag: "Accepted",
            address: EmailAddressSchema.make("blind@example.com"),
          },
        ],
      }))

    const [incompleteResult, mismatchedResult] = await Effect.runPromise(
      Effect.all([
        incomplete.send(command("send:incomplete-outcomes")),
        mismatched.send(command("send:mismatched-outcomes")),
      ]),
    )

    expect(incompleteResult.message.state).toMatchObject({
      _tag: "DeliveryUnknown",
      reason: "invalid_response",
    })
    expect(mismatchedResult.message.state).toMatchObject({
      _tag: "DeliveryUnknown",
      reason: "invalid_response",
    })
    expect(incompleteResult.recipients.map((recipient) => recipient.status))
      .toEqual(["pending", "pending"])
    expect(mismatchedResult.recipients.map((recipient) => recipient.status))
      .toEqual(["pending", "pending"])
  })

  test("keeps a pre-handoff archive failure replayable", async () => {
    const harness = makeHarness(
      () => Effect.succeed(captured),
      makeTestOutboundPolicy(),
      { archiveFailuresBeforeSuccess: 1 },
    )
    const input = command("send:archive-replay")
    const first = await Effect.runPromise(Effect.result(harness.send(input)))

    expect(Result.isFailure(first)).toBe(true)
    if (Result.isFailure(first)) {
      expect(first.failure._tag).toBe("RawMessageArchiveFailure")
    }
    expect(harness.record()?.message.state._tag).toBe("Reserved")
    expect(harness.sent).toHaveLength(0)

    const replay = await Effect.runPromise(harness.send(input))

    expect(replay.message.state._tag).toBe("Captured")
    expect(harness.archiveAttempts).toBe(2)
    expect(harness.sent).toHaveLength(1)
  })

  test("retains the outbound archive intent across an attach failure", async () => {
    const harness = makeHarness(
      () => Effect.succeed(captured),
      makeTestOutboundPolicy(),
      { attachFailuresBeforeSuccess: 1 },
    )
    const input = command("send:attach-replay")
    const first = await Effect.runPromise(Effect.result(harness.send(input)))

    expect(Result.isFailure(first)).toBe(true)
    if (Result.isFailure(first)) {
      expect(first.failure).toMatchObject({
        _tag: "MessageStoreFailure",
        operation: "attach_raw",
      })
    }
    expect(harness.record()?.message.state._tag).toBe("Reserved")
    expect(harness.archiveIntentCount).toBe(1)
    expect(harness.sent).toHaveLength(0)

    const replay = await Effect.runPromise(harness.send(input))

    expect(replay.message.state._tag).toBe("Captured")
    expect(harness.archiveIntentCount).toBe(0)
    expect(harness.archiveAttempts).toBe(2)
    expect(harness.sent).toHaveLength(1)
  })

  test("checks outbound policy before reserving or handing off", async () => {
    const harness = makeHarness(
      () => Effect.succeed(captured),
      makeTestOutboundPolicy({ maximumBytes: 1 }),
    )
    const result = await Effect.runPromise(
      Effect.result(harness.send(command("send:policy"))),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(MessageTooLarge)
    }
    expect(harness.record()).toBeUndefined()
    expect(harness.sent).toHaveLength(0)
  })

  test("rechecks outbound policy after reservation before provider handoff", async () => {
    let checks = 0
    const policy = OutboundPolicy.of({
      check: () => Effect.suspend(() => {
        checks += 1
        return checks === 1
          ? Effect.void
          : Effect.fail(new RecipientNotPermitted({
              reason: "test_recipient_unverified",
            }))
      }),
    })
    const harness = makeHarness(() => Effect.succeed(captured), policy)
    const result = await Effect.runPromise(
      Effect.result(harness.send(command("send:policy-recheck"))),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(RecipientNotPermitted)
    }
    expect(checks).toBe(2)
    expect(harness.record()?.message.state._tag).toBe("Reserved")
    expect(harness.sent).toHaveLength(0)
  })

  test("streams archived MIME without leaking archive references", async () => {
    const harness = makeHarness()
    const sent = await Effect.runPromise(harness.send(command("send:raw")))
    const raw = await Effect.runPromise(harness.raw(sent.message.id))
    const text = await new Response(raw.body).text()

    expect(raw.contentType).toBe("message/rfc822")
    expect(text).toContain("Subject: Application slice")
    expect("ref" in raw).toBe(false)
  })

  test("returns send recipients ready for direct hosted projection", async () => {
    const harness = makeHarness()
    const sent = await Effect.runPromise(
      harness.send(command("send:read-details")),
    )

    const envelope = await Effect.runPromise(projectMessageEnvelope(sent))
    const details = await Effect.runPromise(harness.get(sent.message.id))
    const page = await Effect.runPromise(harness.list())

    expect(sent.recipients.map((recipient) => String(recipient.address))).toEqual([
      "recipient@example.com",
      "blind@example.com",
    ])
    expect(sent).not.toHaveProperty("raw")
    expect(envelope.message.id).toBe(sent.message.id)
    expect(envelope.message.recipients).toHaveLength(2)
    expect(details.message.id).toBe(sent.message.id)
    expect(details.recipients.map((recipient) => String(recipient.address))).toEqual([
      "recipient@example.com",
      "blind@example.com",
    ])
    expect(details).not.toHaveProperty("raw")
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.message.id).toBe(sent.message.id)
    expect(page.items[0]?.recipients).toEqual(details.recipients)
    expect(page.items[0]).not.toHaveProperty("raw")
  })

  test("finalizes an interrupted provider handoff as DeliveryUnknown", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const never = yield* Deferred.make<void>()
        const harness = makeHarness(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(never)),
            Effect.as(captured),
          ))
        const fiber = yield* harness.send(command("send:cancelled")).pipe(
          Effect.forkChild,
        )
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        return harness.record()?.message.state._tag
      }),
    )

    expect(state).toBe("DeliveryUnknown")
  })

  test("does not author email PII or mutation secrets into telemetry", async () => {
    const attachment = new TextEncoder().encode("private-attachment-content")
    const input = Schema.decodeUnknownSync(SendCommandSchema)({
      scope: {
        namespace: "private-namespace",
        environment: "live",
      },
      actor: { _tag: "User", id: "private-actor" },
      idempotencyKey: "private-idempotency-key",
      from: { _tag: "DefaultRoute" },
      to: ["private-to@example.com"],
      cc: ["private-cc@example.com"],
      bcc: ["private-bcc@example.com"],
      subject: "private-subject",
      body: {
        _tag: "Multipart",
        text: "private-text-body",
        html: "<p>private-html-body</p>",
      },
      headers: [{ name: "X-Private-Header", value: "private-header-value" }],
      attachments: [{
        filename: "private-attachment.txt",
        mediaType: "text/plain",
        disposition: "inline",
        contentId: "private-content@example.com",
        content: attachment,
      }],
    })
    const accepted = makeHarness()
    const rejected = makeHarness(
      () => Effect.succeed(captured),
      OutboundPolicy.of({
        check: () => Effect.fail(new RecipientNotPermitted({
          reason: "test_recipient_unverified",
        })),
      }),
    )

    const [acceptedCapture, rejectedCapture] = await Effect.runPromise(
      Effect.all([
        captureTelemetry(accepted.send(input)),
        captureTelemetry(rejected.send(input)),
      ]),
    )
    const allSpans = [
      ...acceptedCapture.spans,
      ...rejectedCapture.spans,
    ]
    const authoredTelemetry = JSON.stringify({
      attributes: allSpans.map((span) => [...span.attributes]),
      events: allSpans.flatMap((span) => span.events),
      logs: [...acceptedCapture.logs, ...rejectedCapture.logs],
    })
    const forbidden = [
      "private-namespace",
      "private-actor",
      "private-idempotency-key",
      "private-to@example.com",
      "private-cc@example.com",
      "private-bcc@example.com",
      "private-subject",
      "private-text-body",
      "private-html-body",
      "X-Private-Header",
      "private-header-value",
      "private-attachment.txt",
      "private-content@example.com",
      "private-attachment-content",
    ]

    expect(allSpans.filter((span) => span.name === "Email.executeOutbound"))
      .toHaveLength(2)
    expect(acceptedCapture.logs).toEqual([])
    expect(rejectedCapture.logs).toEqual([])
    for (const value of forbidden) {
      expect(authoredTelemetry).not.toContain(value)
    }
  })
})
