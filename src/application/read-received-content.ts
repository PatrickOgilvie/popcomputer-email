import PostalMime, {
  type Address as PostalAddress,
  type Attachment as PostalAttachment,
  type Email as PostalEmail,
} from "postal-mime"
import {
  Effect,
  Option,
  Schema,
} from "effect"
import {
  ContentDigest,
  type ContentDigestFailure,
} from "../adapters/content-digest.js"
import {
  MessageStore,
  type GetMessageInput,
  type MessageStoreFailure,
} from "../adapters/message-store.js"
import {
  RawMessageArchive,
  type RawMessageArchiveFailure,
} from "../adapters/raw-message-archive.js"
import { EmailAddressSchema, type EmailAddress } from "../core/address.js"
import { MediaTypeSchema } from "../core/email-command.js"
import {
  type MessageId,
  MessageIdSchema,
} from "../core/identifiers.js"
import {
  type InboundMessage,
  type InvalidStoredMessage,
  MessageNotFound,
} from "../core/message.js"
import {
  ReceivedAttachmentFilenameSchema,
  ReceivedAttachmentIdSchema,
  ReceivedAttachmentSchema,
  ReceivedContentIdSchema,
  ReceivedContentSchema,
  type ReceivedAttachment,
  type ReceivedAttachmentContent,
  type ReceivedAttachmentId,
  type ReceivedAutomation,
  type ReceivedContent,
} from "../core/received-content.js"
import type { Scope } from "../core/scope.js"
import {
  isPositiveSafeInteger,
  PositiveSafeIntegerSchema,
} from "../core/positive-safe-integer.js"
import {
  ThreadMessageIdSchema,
  type ThreadMessageId,
} from "../core/threading.js"

/** Runtime schema for memory and projection limits applied to archived MIME. */
export const ReceivedContentConfigSchema = Schema.Struct({
  maxRawBytes: PositiveSafeIntegerSchema,
  maxAttachments: PositiveSafeIntegerSchema,
  maxTextCharacters: PositiveSafeIntegerSchema,
  maxHtmlCharacters: PositiveSafeIntegerSchema,
})

/** Memory and projection limits applied whenever archived MIME is parsed. */
export interface ReceivedContentConfig extends Schema.Schema.Type<
  typeof ReceivedContentConfigSchema
> {}

/** Conservative defaults aligned with the inbound ingestion byte policy. */
export const defaultReceivedContentConfig: ReceivedContentConfig = {
  maxRawBytes: 25 * 1024 * 1024,
  maxAttachments: 100,
  maxTextCharacters: 5_000_000,
  maxHtmlCharacters: 10_000_000,
}

/** One received-content limit was not a finite positive safe integer. */
export class InvalidReceivedContentConfig extends Schema.TaggedError<
  InvalidReceivedContentConfig
>()("InvalidReceivedContentConfig", {
  field: Schema.Literals([
    "maxRawBytes",
    "maxAttachments",
    "maxTextCharacters",
    "maxHtmlCharacters",
  ]),
  reason: Schema.Literal("not_positive_safe_integer"),
}) {}

type ReceivedContentConfigField =
  | "maxRawBytes"
  | "maxAttachments"
  | "maxTextCharacters"
  | "maxHtmlCharacters"

const invalidReceivedContentConfigField = (
  config: ReceivedContentConfig,
): ReceivedContentConfigField | undefined => {
  if (!isPositiveSafeInteger(config.maxRawBytes)) return "maxRawBytes"
  if (!isPositiveSafeInteger(config.maxAttachments)) return "maxAttachments"
  if (!isPositiveSafeInteger(config.maxTextCharacters)) {
    return "maxTextCharacters"
  }
  if (!isPositiveSafeInteger(config.maxHtmlCharacters)) {
    return "maxHtmlCharacters"
  }
  return undefined
}

/** Parse and detach one caller-owned received-content policy. */
export const parseReceivedContentConfig = Effect.fn(
  "Email.content.parseConfig",
)(function*(config: ReceivedContentConfig) {
  const field = invalidReceivedContentConfigField(config)
  if (field !== undefined) {
    return yield* new InvalidReceivedContentConfig({
      field,
      reason: "not_positive_safe_integer",
    })
  }
  return {
    maxRawBytes: config.maxRawBytes,
    maxAttachments: config.maxAttachments,
    maxTextCharacters: config.maxTextCharacters,
    maxHtmlCharacters: config.maxHtmlCharacters,
  }
})

/** A message cannot provide typed received content in its current form. */
export class ReceivedContentUnavailable extends Schema.TaggedError<
  ReceivedContentUnavailable
>()("ReceivedContentUnavailable", {
  messageId: MessageIdSchema,
  reason: Schema.Literals([
    "not_inbound",
    "not_archived",
    "archive_object_missing",
  ]),
}) {}

/** One bounded content projection exceeded its configured limit. */
export class ReceivedContentTooLarge extends Schema.TaggedError<
  ReceivedContentTooLarge
>()("ReceivedContentTooLarge", {
  part: Schema.Literals(["raw", "text", "html", "attachment_count"]),
  observed: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  maximum: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
}) {}

/** The archived MIME stream could not be consumed completely. */
export class ReceivedContentReadFailure extends Schema.TaggedError<
  ReceivedContentReadFailure
>()("ReceivedContentReadFailure", {
  reason: Schema.Literal("stream_failed"),
}) {}

/** Archived MIME failed integrity, parsing, or safe projection checks. */
export class InvalidReceivedMime extends Schema.TaggedError<
  InvalidReceivedMime
>()("InvalidReceivedMime", {
  reason: Schema.Literals([
    "parse_failed",
    "invalid_projection",
    "archive_size_mismatch",
    "archive_digest_mismatch",
  ]),
}) {}

/** A requested attachment identity is absent from the immutable message. */
export class ReceivedAttachmentNotFound extends Schema.TaggedError<
  ReceivedAttachmentNotFound
>()("ReceivedAttachmentNotFound", {
  messageId: MessageIdSchema,
  attachmentId: ReceivedAttachmentIdSchema,
  reason: Schema.Literal("not_found"),
}) {}

/** Scoped attachment lookup accepted by the received-content reader. */
export interface GetReceivedAttachmentInput {
  readonly scope: Scope
  readonly messageId: MessageId
  readonly attachmentId: ReceivedAttachmentId
}

/** Typed failures produced while reading and projecting archived MIME. */
export type ReadReceivedContentFailure =
  | ContentDigestFailure
  | InvalidReceivedContentConfig
  | InvalidReceivedMime
  | InvalidStoredMessage
  | MessageNotFound
  | MessageStoreFailure
  | RawMessageArchiveFailure
  | ReceivedContentReadFailure
  | ReceivedContentTooLarge
  | ReceivedContentUnavailable

/** Typed failures produced while reading one received attachment. */
export type ReadReceivedAttachmentFailure =
  | ReadReceivedContentFailure
  | ReceivedAttachmentNotFound

interface ParsedAttachment {
  readonly metadata: ReceivedAttachment
  readonly content: Uint8Array
}

/** Internal complete projection shared by content, attachment, and reply reads. */
export interface LoadedReceivedContent {
  readonly source: InboundMessage
  readonly content: ReceivedContent
  readonly attachments: ReadonlyArray<ParsedAttachment>
}

const invalidProjection = (): InvalidReceivedMime =>
  new InvalidReceivedMime({ reason: "invalid_projection" })

const readBounded = (
  stream: ReadableStream<Uint8Array>,
  maximum: number,
): Effect.Effect<
  Uint8Array,
  ReceivedContentReadFailure | ReceivedContentTooLarge
> =>
  Effect.tryPromise({
    try: async (signal) => {
      const reader = stream.getReader()
      const chunks: Array<Uint8Array> = []
      let total = 0
      const cancel = (): void => {
        void reader.cancel("received content read cancelled")
      }
      signal.addEventListener("abort", cancel, { once: true })
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          total += next.value.byteLength
          if (total > maximum) {
            await reader.cancel("received content exceeds byte limit")
            throw new ReceivedContentTooLarge({
              part: "raw",
              observed: total,
              maximum,
            })
          }
          chunks.push(next.value)
        }
      } finally {
        signal.removeEventListener("abort", cancel)
        reader.releaseLock()
      }
      const content = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        content.set(chunk, offset)
        offset += chunk.byteLength
      }
      return content
    },
    catch: (cause) =>
      cause instanceof ReceivedContentTooLarge
        ? cause
        : new ReceivedContentReadFailure({ reason: "stream_failed" }),
  })

const parseMime = (
  raw: Uint8Array,
): Effect.Effect<PostalEmail, InvalidReceivedMime> =>
  Effect.tryPromise({
    try: () => PostalMime.parse(raw, {
      attachmentEncoding: "arraybuffer",
      maxNestingDepth: 20,
      maxHeadersSize: 256 * 1024,
      rfc822Attachments: true,
    }),
    catch: () => new InvalidReceivedMime({ reason: "parse_failed" }),
  })

const flattenAddresses = (
  addresses: ReadonlyArray<PostalAddress>,
): ReadonlyArray<string> =>
  addresses.flatMap((address) => {
    if (address.group !== undefined) {
      return address.group.map((mailbox) => mailbox.address)
    }
    return address.address === undefined ? [] : [address.address]
  })

const decodeAddresses = (
  addresses: ReadonlyArray<PostalAddress> | undefined,
): Effect.Effect<ReadonlyArray<EmailAddress>> =>
  Effect.forEach(
    flattenAddresses(addresses ?? []),
    (address) =>
      Effect.option(Schema.decodeUnknownEffect(EmailAddressSchema)(address)),
  ).pipe(
    Effect.map((decoded) =>
      decoded.flatMap(Option.match({
        onNone: () => [],
        onSome: (address) => [address],
      }))),
  )

const decodeThreadMessageId = (
  value: string | undefined,
): Effect.Effect<ThreadMessageId | null> =>
  value === undefined
    ? Effect.succeed(null)
    : Effect.option(
        Schema.decodeUnknownEffect(ThreadMessageIdSchema)(value.trim()),
      ).pipe(Effect.map(Option.getOrNull))

const decodeReferences = (
  value: string | undefined,
): Effect.Effect<ReadonlyArray<ThreadMessageId>> => {
  const tokens = value?.match(/<[^<>\r\n]+>/gu) ?? []
  return Effect.forEach(tokens, (token) =>
    Effect.option(
      Schema.decodeUnknownEffect(ThreadMessageIdSchema)(token),
    )).pipe(
      Effect.map((items) =>
        items.flatMap(Option.match({
          onNone: () => [],
          onSome: (item) => [item],
        }))),
    )
}

const attachmentBytes = (
  attachment: PostalAttachment,
): Effect.Effect<Uint8Array, InvalidReceivedMime> => {
  if (attachment.content instanceof Uint8Array) {
    return Effect.succeed(Uint8Array.from(attachment.content))
  }
  if (attachment.content instanceof ArrayBuffer) {
    return Effect.succeed(
      new Uint8Array(attachment.content.slice(0)),
    )
  }
  return Effect.fail(invalidProjection())
}

const optionalDisplayFilename = (
  value: string | null,
): Effect.Effect<string | null> =>
  value === null
    ? Effect.succeed(null)
    : Effect.option(
        Schema.decodeUnknownEffect(ReceivedAttachmentFilenameSchema)(value),
      ).pipe(
        Effect.map(Option.getOrNull),
      )

const optionalContentId = (
  value: string | undefined,
): Effect.Effect<string | null> => {
  if (value === undefined) return Effect.succeed(null)
  const withoutBrackets = value.startsWith("<") && value.endsWith(">")
    ? value.slice(1, -1)
    : value
  return Effect.option(
    Schema.decodeUnknownEffect(ReceivedContentIdSchema)(withoutBrackets),
  ).pipe(Effect.map(Option.getOrNull))
}

const headerValues = (
  parsed: PostalEmail,
  key: string,
): ReadonlyArray<string> => parsed.headers
  .filter((header) => header.key.toLowerCase() === key)
  .map((header) => header.value.trim().toLowerCase())

const isAutomaticPrecedence = (
  value: string,
): value is "bulk" | "junk" | "list" =>
  value === "bulk" || value === "list" || value === "junk"

const normalizePrecedence = (
  values: ReadonlyArray<string>,
): ReceivedAutomation["precedence"] => {
  const automatic = values.find(isAutomaticPrecedence)
  if (automatic !== undefined) return automatic
  return values.length === 0 ? null : "other"
}

const normalizeAutoSubmitted = (
  values: ReadonlyArray<string>,
): ReceivedAutomation["autoSubmitted"] => {
  if (values.length === 0) return null
  return values.every((value) => value === "no") ? "no" : "automatic"
}

const projectAutomation = (parsed: PostalEmail): ReceivedAutomation => {
  const autoSubmittedValues = headerValues(parsed, "auto-submitted")
  const precedenceValues = headerValues(parsed, "precedence")
  const keys = new Set(
    parsed.headers.map((header) => header.key.toLowerCase()),
  )
  return {
    autoSubmitted: normalizeAutoSubmitted(autoSubmittedValues),
    precedence: normalizePrecedence(precedenceValues),
    listId: keys.has("list-id"),
    responseSuppression: keys.has("x-auto-response-suppress") ||
      keys.has("x-autoreply") || keys.has("x-autorespond"),
  }
}

const mediaType = (
  value: string,
): Effect.Effect<typeof MediaTypeSchema.Type> =>
  Effect.option(Schema.decodeUnknownEffect(MediaTypeSchema)(value)).pipe(
    Effect.map(
      Option.getOrElse(() =>
        MediaTypeSchema.make("application/octet-stream")),
    ),
  )

const attachmentDisposition = (
  value: string | null,
): "attachment" | "inline" | null =>
  value === "attachment" || value === "inline" ? value : null

const projectAttachment = Effect.fn("Email.content.projectAttachment")(
  function*(attachment: PostalAttachment, index: number) {
    const content = yield* attachmentBytes(attachment)
    const metadata = ReceivedAttachmentSchema.make({
      id: ReceivedAttachmentIdSchema.make(`v1_${index}`),
      filename: yield* optionalDisplayFilename(attachment.filename),
      mediaType: yield* mediaType(attachment.mimeType),
      disposition: attachmentDisposition(attachment.disposition),
      contentId: yield* optionalContentId(attachment.contentId),
      sizeBytes: content.byteLength,
    })
    return { metadata, content }
  },
)

const assertCharacterLimit = (
  part: "text" | "html",
  value: string | undefined,
  maximum: number,
): Effect.Effect<string | null, ReceivedContentTooLarge> => {
  if (value === undefined) return Effect.succeed(null)
  return value.length <= maximum
    ? Effect.succeed(value)
    : Effect.fail(
        new ReceivedContentTooLarge({
          part,
          observed: value.length,
          maximum,
        }),
      )
}

const projectMime = Effect.fn("Email.content.projectMime")(function*(
  source: InboundMessage,
  parsed: PostalEmail,
  config: ReceivedContentConfig,
) {
  if (parsed.attachments.length > config.maxAttachments) {
    return yield* new ReceivedContentTooLarge({
      part: "attachment_count",
      observed: parsed.attachments.length,
      maximum: config.maxAttachments,
    })
  }
  const attachments = yield* Effect.forEach(
    parsed.attachments,
    projectAttachment,
  )
  const headerFrom = yield* decodeAddresses(
    parsed.from === undefined ? [] : [parsed.from],
  )
  const replyTo = yield* decodeAddresses(parsed.replyTo)
  const messageId = yield* decodeThreadMessageId(parsed.messageId)
  const inReplyTo = yield* decodeThreadMessageId(parsed.inReplyTo)
  const references = yield* decodeReferences(parsed.references)
  const text = yield* assertCharacterLimit(
    "text",
    parsed.text,
    config.maxTextCharacters,
  )
  const html = yield* assertCharacterLimit(
    "html",
    parsed.html,
    config.maxHtmlCharacters,
  )
  const content = ReceivedContentSchema.make({
    messageId: source.id,
    routeId: source.routeId,
    envelopeFrom: source.from,
    envelopeTo: source.to,
    headerFrom,
    replyTo,
    subject: source.subject,
    text,
    html,
    threading: {
      messageId,
      inReplyTo,
      references,
    },
    automation: projectAutomation(parsed),
    attachments: attachments.map((item) => item.metadata),
  })
  return { source, content, attachments }
})

/** Load, integrity-check, parse, and safely project one inbound MIME object. */
export const loadReceivedContent = Effect.fn("Email.content.load")(function*(
  input: GetMessageInput,
  config: ReceivedContentConfig = defaultReceivedContentConfig,
): Effect.fn.Return<
  LoadedReceivedContent,
  ReadReceivedContentFailure,
  ContentDigest | MessageStore | RawMessageArchive
> {
  const policy = yield* parseReceivedContentConfig(config)
  const store = yield* MessageStore
  const archive = yield* RawMessageArchive
  const digest = yield* ContentDigest
  const found = yield* store.get(input)
  if (Option.isNone(found)) {
    return yield* new MessageNotFound({
      messageId: input.messageId,
      reason: "not_found",
    })
  }
  if (found.value.message._tag !== "Inbound") {
    return yield* new ReceivedContentUnavailable({
      messageId: input.messageId,
      reason: "not_inbound",
    })
  }
  if (Option.isNone(found.value.raw)) {
    return yield* new ReceivedContentUnavailable({
      messageId: input.messageId,
      reason: "not_archived",
    })
  }
  const descriptor = found.value.raw.value
  if (descriptor.sizeBytes > policy.maxRawBytes) {
    return yield* new ReceivedContentTooLarge({
      part: "raw",
      observed: descriptor.sizeBytes,
      maximum: policy.maxRawBytes,
    })
  }
  const archived = yield* archive.get(descriptor.ref)
  if (Option.isNone(archived)) {
    return yield* new ReceivedContentUnavailable({
      messageId: input.messageId,
      reason: "archive_object_missing",
    })
  }
  if (archived.value.sizeBytes > policy.maxRawBytes) {
    return yield* new ReceivedContentTooLarge({
      part: "raw",
      observed: archived.value.sizeBytes,
      maximum: policy.maxRawBytes,
    })
  }
  const raw = yield* readBounded(archived.value.body, policy.maxRawBytes)
  if (
    raw.byteLength !== descriptor.sizeBytes ||
    raw.byteLength !== archived.value.sizeBytes
  ) {
    return yield* new InvalidReceivedMime({
      reason: "archive_size_mismatch",
    })
  }
  const sha256 = yield* digest.sha256(raw)
  if (sha256 !== descriptor.sha256) {
    return yield* new InvalidReceivedMime({
      reason: "archive_digest_mismatch",
    })
  }
  const parsed = yield* parseMime(raw)
  return yield* projectMime(found.value.message, parsed, policy)
})

/** Read bounded typed content without exposing archive implementation details. */
export const getReceivedContent = Effect.fn("Email.content.get")(function*(
  input: GetMessageInput,
  config: ReceivedContentConfig = defaultReceivedContentConfig,
): Effect.fn.Return<
  ReceivedContent,
  ReadReceivedContentFailure,
  ContentDigest | MessageStore | RawMessageArchive
> {
  const loaded = yield* loadReceivedContent(input, config)
  return loaded.content
})

/** Read one attachment by its stable versioned MIME-part identity. */
export const readReceivedAttachment = Effect.fn(
  "Email.content.readAttachment",
)(function*(
  input: GetReceivedAttachmentInput,
  config: ReceivedContentConfig = defaultReceivedContentConfig,
): Effect.fn.Return<
  ReceivedAttachmentContent,
  ReadReceivedAttachmentFailure,
  ContentDigest | MessageStore | RawMessageArchive
> {
  const loaded = yield* loadReceivedContent(input, config)
  const attachment = loaded.attachments.find(
    (item) => item.metadata.id === input.attachmentId,
  )
  if (attachment === undefined) {
    return yield* new ReceivedAttachmentNotFound({
      messageId: input.messageId,
      attachmentId: input.attachmentId,
      reason: "not_found",
    })
  }
  return {
    attachment: attachment.metadata,
    content: Uint8Array.from(attachment.content),
  }
})
