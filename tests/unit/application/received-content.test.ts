import { describe, expect, test } from "bun:test"
import {
  DateTime,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
} from "effect"
import {
  layerWebCrypto,
} from "../../../src/adapters/content-digest.js"
import {
  MessageStore,
  type StoredMessage,
} from "../../../src/adapters/message-store.js"
import {
  RawMessageArchive,
} from "../../../src/adapters/raw-message-archive.js"
import {
  defaultReceivedContentConfig,
  getReceivedContent,
  InvalidReceivedMime,
  readReceivedAttachment,
  ReceivedAttachmentNotFound,
  ReceivedContentTooLarge,
} from "../../../src/application/read-received-content.js"
import {
  MessageIdSchema,
  RawMessageRefSchema,
  RouteIdSchema,
  Sha256Schema,
} from "../../../src/core/identifiers.js"
import {
  MessageSchema,
} from "../../../src/core/message.js"
import {
  ReceivedAttachmentIdSchema,
} from "../../../src/core/received-content.js"
import { ScopeSchema } from "../../../src/core/scope.js"
import { EmailAddressSchema } from "../../../src/core/address.js"
import { makeInMemoryRawArchive } from "../../../src/testing/raw-archive.js"

const scope = Schema.decodeUnknownSync(ScopeSchema)({
  namespace: "tenant:received-content",
  environment: "live",
})

const bytes = (value: string): Uint8Array =>
  new TextEncoder().encode(value)

const stream = (content: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from(content))
      controller.close()
    },
  })

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

const unsupported = <A>(): Effect.Effect<A> =>
  Effect.die(new Error("unsupported test operation"))

const storeFor = (record: StoredMessage): MessageStore["Service"] =>
  MessageStore.of({
    findOutboundByIdempotency: () => unsupported(),
    reserveOutbound: () => unsupported(),
    createOutboundArchiveIntent: () => unsupported(),
    attachOutboundRaw: () => unsupported(),
    claimOutbound: () => unsupported(),
    finalizeOutbound: () => unsupported(),
    get: (input) =>
      Effect.succeed(
        input.scope.namespace === record.message.scope.namespace &&
          input.scope.environment === record.message.scope.environment &&
          input.messageId === record.message.id
          ? Option.some(record)
          : Option.none(),
      ),
    list: () => unsupported(),
  })

const rawMime = [
  "From: Ada Lovelace <ada@example.net>",
  "Reply-To: replies@example.net",
  "To: workflow@example.com",
  "Subject: Unicode ✓",
  "Message-ID: <message-1@example.net>",
  "In-Reply-To: <parent@example.net>",
  "References: <root@example.net> <parent@example.net>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="mixed"',
  "",
  "--mixed",
  'Content-Type: multipart/alternative; boundary="alternative"',
  "",
  "--alternative",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello plain",
  "--alternative",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Hello HTML</p>",
  "--alternative--",
  "--mixed",
  "Content-Type: text/plain",
  "Content-Disposition: attachment; filename=\"notes/test.txt\"",
  "Content-Transfer-Encoding: base64",
  "",
  "YXR0YWNobWVudA==",
  "--mixed--",
  "",
].join("\r\n")

const fixture = async (
  mime: string = rawMime,
  descriptorDigest?: typeof Sha256Schema.Type,
) => {
  const raw = bytes(mime)
  const digest = await sha256(raw)
  const messageId = MessageIdSchema.make("message:received-content")
  const routeId = RouteIdSchema.make("route:workflow")
  const now = DateTime.makeUnsafe(1_000)
  const archive = makeInMemoryRawArchive()
  const ref = await Effect.runPromise(archive.service.put({
    scope,
    direction: "inbound",
    messageId,
    content: raw,
    sha256: digest,
  }))
  const message = MessageSchema.cases.Inbound.make({
    id: messageId,
    scope,
    routeId,
    from: EmailAddressSchema.make("bounce@example.net"),
    to: [EmailAddressSchema.make("workflow@example.com")],
    subject: "Unicode ✓",
    rfcMessageId: "<message-1@example.net>",
    sizeBytes: raw.byteLength,
    receivedAt: now,
    createdAt: now,
    updatedAt: now,
    state: MessageSchema.cases.Inbound.fields.state.cases.Received.make({}),
  })
  const record: StoredMessage = {
    message,
    recipients: [],
    raw: Option.some({
      ref,
      sha256: descriptorDigest ?? digest,
      sizeBytes: raw.byteLength,
    }),
  }
  const dependencies = Layer.mergeAll(
    layerWebCrypto,
    archive.layer,
    Layer.succeed(MessageStore, storeFor(record)),
  )
  return { archive, dependencies, message, raw }
}

describe("received content", () => {
  test("projects trusted envelope provenance, MIME content, threading, and attachments", async () => {
    const { dependencies, message } = await fixture()
    const program = Effect.gen(function*() {
      const content = yield* getReceivedContent({
        scope,
        messageId: message.id,
      })
      const attachment = yield* readReceivedAttachment({
        scope,
        messageId: message.id,
        attachmentId: ReceivedAttachmentIdSchema.make("v1_0"),
      })
      return { content, attachment }
    }).pipe(Effect.provide(dependencies))

    const result = await Effect.runPromise(program)

    expect(String(result.content.envelopeFrom)).toBe("bounce@example.net")
    expect(result.content.headerFrom.map(String)).toEqual([
      "ada@example.net",
    ])
    expect(result.content.replyTo.map(String)).toEqual([
      "replies@example.net",
    ])
    expect(result.content.text).toContain("Hello plain")
    expect(result.content.html).toContain("<p>Hello HTML</p>")
    expect({
      messageId: result.content.threading.messageId === null
        ? null
        : String(result.content.threading.messageId),
      inReplyTo: result.content.threading.inReplyTo === null
        ? null
        : String(result.content.threading.inReplyTo),
      references: result.content.threading.references.map(String),
    }).toEqual({
      messageId: "<message-1@example.net>",
      inReplyTo: "<parent@example.net>",
      references: ["<root@example.net>", "<parent@example.net>"],
    })
    expect(result.content.automation).toEqual({
      autoSubmitted: null,
      precedence: null,
      listId: false,
      responseSuppression: false,
    })
    expect(result.content.attachments.map((attachment) => ({
      ...attachment,
      id: String(attachment.id),
      mediaType: String(attachment.mediaType),
    }))).toEqual([{
        id: "v1_0",
        filename: "notes/test.txt",
        mediaType: "text/plain",
        disposition: "attachment",
        contentId: null,
        sizeBytes: 10,
      }])
    expect(new TextDecoder().decode(result.attachment.content)).toBe(
      "attachment",
    )
  })

  test("uses stable attachment identities and fails a missing lookup precisely", async () => {
    const { dependencies, message } = await fixture()
    const program = Effect.gen(function*() {
      const first = yield* getReceivedContent({ scope, messageId: message.id })
      const second = yield* getReceivedContent({ scope, messageId: message.id })
      const missing = yield* Effect.result(readReceivedAttachment({
        scope,
        messageId: message.id,
        attachmentId: ReceivedAttachmentIdSchema.make("v1_99"),
      }))
      return { first, second, missing }
    }).pipe(Effect.provide(dependencies))

    const result = await Effect.runPromise(program)

    expect(result.second.attachments).toEqual(result.first.attachments)
    expect(Result.isFailure(result.missing)).toBe(true)
    if (Result.isFailure(result.missing)) {
      expect(result.missing.failure).toBeInstanceOf(
        ReceivedAttachmentNotFound,
      )
    }
  })

  test("normalizes automatic-message headers for workflow reply safety", async () => {
    const mime = rawMime.replace(
      "MIME-Version: 1.0",
      [
        "Auto-Submitted: auto-generated",
        "Precedence: list",
        "List-ID: Orders <orders.example.net>",
        "X-Auto-Response-Suppress: All",
        "MIME-Version: 1.0",
      ].join("\r\n"),
    )
    const { dependencies, message } = await fixture(mime)
    const content = await Effect.runPromise(getReceivedContent({
      scope,
      messageId: message.id,
    }).pipe(Effect.provide(dependencies)))

    expect(content.automation).toEqual({
      autoSubmitted: "automatic",
      precedence: "list",
      listId: true,
      responseSuppression: true,
    })
  })

  test("drops malformed optional MIME metadata without losing safe content", async () => {
    const longFilename = "x".repeat(300)
    const mime = [
      "From: invalid-address",
      "Reply-To: also-invalid",
      "To: workflow@example.com",
      "Subject: Optional metadata",
      "Message-ID: <optional-metadata@example.net>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="mixed"',
      "",
      "--mixed",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Still readable",
      "--mixed",
      "Content-Type: application/octet-stream",
      `Content-Disposition: unexpected; filename="${longFilename}"`,
      "Content-ID: <bad<id>",
      "Content-Transfer-Encoding: base64",
      "",
      "b2s=",
      "--mixed--",
      "",
    ].join("\r\n")
    const { dependencies, message } = await fixture(mime)
    const content = await Effect.runPromise(getReceivedContent({
      scope,
      messageId: message.id,
    }).pipe(Effect.provide(dependencies)))

    expect(content.headerFrom).toEqual([])
    expect(content.replyTo).toEqual([])
    expect(content.text?.trim()).toBe("Still readable")
    expect(content.attachments[0]?.filename).toBeNull()
    expect(content.attachments[0]?.disposition).toBeNull()
    expect(content.attachments[0]?.contentId).toBeNull()
  })

  test("detects archived content whose digest no longer matches metadata", async () => {
    const { dependencies, message } = await fixture(
      rawMime,
      Sha256Schema.make("0".repeat(64)),
    )
    const result = await Effect.runPromise(Effect.result(
      getReceivedContent({ scope, messageId: message.id }).pipe(
        Effect.provide(dependencies),
      ),
    ))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InvalidReceivedMime)
      if (result.failure._tag === "InvalidReceivedMime") {
        expect(result.failure.reason).toBe("archive_digest_mismatch")
      }
    }
  })

  test("enforces the actual streamed byte count despite small advertised sizes", async () => {
    const { dependencies, message } = await fixture()
    const lyingArchive = RawMessageArchive.of({
      referenceFor: () =>
        Effect.succeed(RawMessageRefSchema.make("raw:lying")),
      put: () => unsupported(),
      get: () =>
        Effect.succeed(Option.some({
          body: stream(bytes("x".repeat(64))),
          contentType: "message/rfc822" as const,
          sizeBytes: 1,
        })),
      remove: () => Effect.void,
    })
    const result = await Effect.runPromise(Effect.result(
      getReceivedContent(
        { scope, messageId: message.id },
        {
          ...defaultReceivedContentConfig,
          maxRawBytes: 16,
        },
      ).pipe(
        Effect.provide(dependencies),
        Effect.provideService(RawMessageArchive, lyingArchive),
      ),
    ))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ReceivedContentTooLarge)
      if (result.failure._tag === "ReceivedContentTooLarge") {
        expect(result.failure.part).toBe("raw")
      }
    }
  })
})
