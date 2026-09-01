import { describe, expect, test } from "bun:test"
import {
  DateTime,
  Effect,
  Option,
  Result,
  Schema,
} from "effect"
import { ActorSchema } from "../../../src/core/actor.js"
import {
  IdempotencyKeySchema,
  MessageIdSchema,
  PageCursorSchema,
} from "../../../src/core/identifiers.js"
import {
  MessageRecipientSchema,
  MessageSchema,
  OutboundStateSchema,
} from "../../../src/core/message.js"
import { ReceivedContentSchema } from "../../../src/core/received-content.js"
import {
  RouteLifecycleSchema,
  RouteSchema,
} from "../../../src/core/route.js"
import { ScopeSchema } from "../../../src/core/scope.js"
import {
  TestRecipientSchema,
  TestRecipientStateSchema,
} from "../../../src/core/test-recipient.js"
import {
  EmailMessageEnvelopeSchema,
  EmailMessagePageSchema,
  EmailMessageSchema,
  ReceivedContentEnvelopeSchema,
  ReplyEmailRequestSchema,
  SendEmailRequestSchema,
} from "../../../src/protocol/messages.js"
import {
  makeReplyCommand,
  makeSendCommand,
  MessageProjectionMismatch,
  projectMessage,
  projectMessageEnvelope,
  projectMessagePage,
  projectReceivedContentEnvelope,
  projectRoute,
  projectTestRecipient,
} from "../../../src/protocol/projections.js"
import { EmailRouteSchema } from "../../../src/protocol/routes.js"
import { EmailTestRecipientSchema } from "../../../src/protocol/test-recipients.js"

const at = (millis: number) => DateTime.makeUnsafe(millis)

const scope = Schema.decodeUnknownSync(ScopeSchema)({
  namespace: "tenant:private",
  environment: "live",
})

const actor = Schema.decodeUnknownSync(ActorSchema)({
  _tag: "Credential",
  id: "credential:private",
})

const outboundMessage = MessageSchema.cases.Outbound.make({
  id: MessageIdSchema.make("message:1"),
  scope,
  actor,
  idempotencyKey: IdempotencyKeySchema.make("private-idempotency-key"),
  requestFingerprint: MessageSchema.cases.Outbound.fields.requestFingerprint
    .make("a".repeat(64)),
  routeId: MessageSchema.cases.Outbound.fields.routeId.make("route:1"),
  from: MessageSchema.cases.Outbound.fields.from.make("sender@example.com"),
  to: [MessageSchema.cases.Outbound.fields.from.make("to@example.com")],
  cc: [],
  bcc: [],
  subject: "Projection",
  sizeBytes: 42,
  createdAt: at(1_000),
  updatedAt: at(2_000),
  state: OutboundStateSchema.cases.Accepted.make({
    sentAt: at(2_000),
  }),
})

const recipient = MessageRecipientSchema.make({
  id: MessageRecipientSchema.fields.id.make("recipient:1"),
  messageId: outboundMessage.id,
  kind: "to",
  address: MessageRecipientSchema.fields.address.make("to@example.com"),
  status: "delivered",
  createdAt: at(1_000),
  updatedAt: at(2_000),
})

describe("protocol projections", () => {
  test("projects a message without internal authority or idempotency data", async () => {
    const projected = await Effect.runPromise(
      projectMessage({ message: outboundMessage, recipients: [recipient] }),
    )
    const encoded = Schema.encodeSync(EmailMessageSchema)(projected)

    expect(projected).toMatchObject({
      id: "message:1",
      environment: "live",
      direction: "outbound",
      status: "accepted",
      routeId: "route:1",
      workflowId: null,
      providerMessageId: null,
      sentAt: at(2_000),
      receivedAt: null,
      recipients: [{
        id: "recipient:1",
        kind: "to",
        address: "to@example.com",
        status: "delivered",
      }],
    })
    expect(encoded.createdAt).toBe("1970-01-01T00:00:01.000Z")
    expect(projected).not.toHaveProperty("scope")
    expect(projected).not.toHaveProperty("actor")
    expect(projected).not.toHaveProperty("idempotencyKey")
    expect(projected).not.toHaveProperty("requestFingerprint")
    expect(projected.recipients[0]).not.toHaveProperty("messageId")
  })

  test("fails closed for a recipient associated with another message", async () => {
    const mismatched = MessageRecipientSchema.make({
      ...recipient,
      messageId: MessageIdSchema.make("message:other"),
    })

    const result = await Effect.runPromise(
      Effect.result(projectMessage({
        message: outboundMessage,
        recipients: [mismatched],
      })),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(MessageProjectionMismatch)
      expect(result.failure).toMatchObject({
        reason: "recipient_message_mismatch",
        messageId: "message:1",
        recipientId: "recipient:1",
      })
    }
  })

  test("projects application envelopes and pages for thin hosted adapters", async () => {
    const details = { message: outboundMessage, recipients: [recipient] }
    const envelope = await Effect.runPromise(projectMessageEnvelope(details))
    const page = await Effect.runPromise(projectMessagePage({
      items: [details],
      nextCursor: Option.some(PageCursorSchema.make("cursor_next")),
    }))

    expect(Schema.encodeSync(EmailMessageEnvelopeSchema)(envelope).message.id)
      .toBe("message:1")
    expect(Schema.encodeSync(EmailMessagePageSchema)(page)).toMatchObject({
      cursor: "cursor_next",
      items: [{ id: "message:1", recipients: [{ id: "recipient:1" }] }],
    })
    expect(page.items[0]).not.toHaveProperty("actor")
    expect(page.items[0]).not.toHaveProperty("idempotencyKey")
  })

  test("projects routes and test recipients without internal ownership data", () => {
    const route = RouteSchema.make({
      id: RouteSchema.fields.id.make("route:1"),
      scope,
      address: RouteSchema.fields.address.make(
        "inbox@example.com",
      ),
      mailboxHandle: RouteSchema.fields.mailboxHandle.make(
        "inbox",
      ),
      inbound: { _tag: "Store" },
      outbound: { _tag: "Sender", role: "default" },
      lifecycle: RouteLifecycleSchema.cases.Disabled.make({
        disabledAt: at(3_000),
      }),
      revision: RouteSchema.fields.revision.make(2),
      actor,
      createdAt: at(1_000),
      updatedAt: at(3_000),
    })
    const testRecipient = TestRecipientSchema.make({
      id: TestRecipientSchema.fields.id.make("test-recipient:1"),
      scope: TestRecipientSchema.fields.scope.make({
        namespace: scope.namespace,
        environment: "test",
      }),
      destinationId: TestRecipientSchema.fields.destinationId.make(
        "destination:private",
      ),
      address: TestRecipientSchema.fields.address.make("test@example.com"),
      actor,
      state: TestRecipientStateSchema.cases.Verified.make({
        verifiedAt: at(2_000),
      }),
      createdAt: at(1_000),
      updatedAt: at(2_000),
    })

    const projectedRoute = projectRoute(route)
    const projectedRecipient = projectTestRecipient(testRecipient)

    expect(Schema.encodeSync(EmailRouteSchema)(projectedRoute)).toMatchObject({
      inbound: { kind: "store" },
      outbound: { kind: "sender", role: "default" },
      status: "disabled",
      disabledAt: "1970-01-01T00:00:03.000Z",
    })
    expect(projectedRoute).not.toHaveProperty("scope")
    expect(projectedRoute).not.toHaveProperty("actor")
    expect(
      Schema.encodeSync(EmailTestRecipientSchema)(projectedRecipient),
    ).toMatchObject({
      id: "test-recipient:1",
      status: "verified",
    })
    expect(projectedRecipient).not.toHaveProperty("scope")
    expect(projectedRecipient).not.toHaveProperty("actor")
    expect(projectedRecipient).not.toHaveProperty("destinationId")
    expect(projectedRecipient).not.toHaveProperty("state")
  })

  test("constructs a domain command from authenticated context and decoded JSON", () => {
    const request = Schema.decodeUnknownSync(SendEmailRequestSchema)({
      fromRouteId: "route:1",
      to: ["to@example.com"],
      subject: "Command",
      automation: "auto_generated",
      text: "plain",
      html: "<p>html</p>",
      attachments: [{
        filename: "hello.txt",
        mediaType: "text/plain",
        content: "aGVsbG8=",
      }],
    })

    const command = makeSendCommand({
      scope,
      actor,
      idempotencyKey: IdempotencyKeySchema.make("send:1"),
      request,
    })

    expect(command.from).toMatchObject({
      _tag: "Route",
      routeId: "route:1",
    })
    expect(command.body).toEqual({
      _tag: "Multipart",
      text: "plain",
      html: "<p>html</p>",
    })
    expect(command.cc).toEqual([])
    expect(command.bcc).toEqual([])
    expect(command.headers).toEqual([])
    expect(command.automation).toBe("auto_generated")
    expect(command.attachments[0]?.disposition).toBe("attachment")
    expect(command.attachments[0]?.content).toEqual(
      new Uint8Array([104, 101, 108, 108, 111]),
    )
  })

  test("constructs a constrained reply command without derived routing fields", () => {
    const request = Schema.decodeUnknownSync(ReplyEmailRequestSchema)({
      text: "Reply body",
      html: "<p>Reply body</p>",
      headers: [{ name: "x-workflow", value: "triage" }],
      attachments: [{
        filename: "answer.txt",
        mediaType: "text/plain",
        content: "b2s=",
      }],
    })

    const command = makeReplyCommand({
      scope,
      actor,
      idempotencyKey: IdempotencyKeySchema.make("reply:1"),
      sourceMessageId: MessageIdSchema.make("message:received"),
      request,
    })

    expect(command).toMatchObject({
      sourceMessageId: "message:received",
      body: {
        _tag: "Multipart",
        text: "Reply body",
        html: "<p>Reply body</p>",
      },
      headers: [{ name: "x-workflow", value: "triage" }],
    })
    expect(command.attachments[0]?.content).toEqual(
      new Uint8Array([111, 107]),
    )
    expect(command).not.toHaveProperty("from")
    expect(command).not.toHaveProperty("to")
    expect(command).not.toHaveProperty("subject")
    expect(command).not.toHaveProperty("threading")
  })

  test("envelopes bounded received content for the hosted boundary", () => {
    const content = ReceivedContentSchema.make({
      messageId: MessageIdSchema.make("message:received"),
      routeId: ReceivedContentSchema.fields.routeId.make("route:1"),
      envelopeFrom: ReceivedContentSchema.fields.envelopeFrom.make(
        "sender@example.com",
      ),
      envelopeTo: [
        ReceivedContentSchema.fields.envelopeFrom.make("inbox@example.com"),
      ],
      headerFrom: [
        ReceivedContentSchema.fields.envelopeFrom.make("author@example.com"),
      ],
      replyTo: [],
      subject: "Question",
      text: "Hello",
      html: null,
      threading: {
        messageId: null,
        inReplyTo: null,
        references: [],
      },
      automation: {
        autoSubmitted: null,
        precedence: null,
        listId: false,
        responseSuppression: false,
      },
      attachments: [],
    })

    expect(
      Schema.encodeSync(ReceivedContentEnvelopeSchema)(
        projectReceivedContentEnvelope(content),
      ),
    ).toEqual({
      content: {
        messageId: "message:received",
        routeId: "route:1",
        envelopeFrom: "sender@example.com",
        envelopeTo: ["inbox@example.com"],
        headerFrom: ["author@example.com"],
        replyTo: [],
        subject: "Question",
        text: "Hello",
        html: null,
        threading: {
          messageId: null,
          inReplyTo: null,
          references: [],
        },
        automation: {
          autoSubmitted: null,
          precedence: null,
          listId: false,
          responseSuppression: false,
        },
        attachments: [],
      },
    })
  })

  test("rejects attachment content IDs that the domain command cannot accept", () => {
    const result = Schema.decodeUnknownResult(SendEmailRequestSchema)({
      to: ["to@example.com"],
      subject: "Command",
      attachments: [{
        filename: "hello.txt",
        mediaType: "text/plain",
        contentId: "<unsafe@example.com>",
        content: "aGVsbG8=",
      }],
    })

    expect(Result.isFailure(result)).toBe(true)
  })
})
