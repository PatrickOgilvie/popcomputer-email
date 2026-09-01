import { Schema } from "effect"
import { EmailAddressSchema } from "./address.js"
import {
  MediaTypeSchema,
} from "./email-command.js"
import {
  MessageIdSchema,
  RouteIdSchema,
} from "./identifiers.js"
import { ThreadMessageIdSchema } from "./threading.js"

const NaturalBytesSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
)

const hasNoAsciiControlCharacters = (value: string): boolean =>
  Array.from(value).every((character) => {
    const code = character.charCodeAt(0)
    return code >= 32 && code !== 127
  })

/** Versioned attachment identity derived from immutable MIME part order. */
export const ReceivedAttachmentIdSchema = Schema.String.check(
  Schema.isPattern(/^v1_[0-9]+$/u),
).pipe(Schema.brand("EmailReceivedAttachmentId"))

/** Versioned attachment identity derived from immutable MIME part order. */
export type ReceivedAttachmentId = typeof ReceivedAttachmentIdSchema.Type

/** Display-only inbound filename; it is not a safe filesystem path. */
export const ReceivedAttachmentFilenameSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(255),
  Schema.makeFilter(hasNoAsciiControlCharacters, {
    title: "EmailReceivedAttachmentFilename",
  }),
)

/** Display-only inbound filename; it is not a safe filesystem path. */
export type ReceivedAttachmentFilename =
  typeof ReceivedAttachmentFilenameSchema.Type

/** Safe inbound Content-ID value with angle brackets removed. */
export const ReceivedContentIdSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(998),
  Schema.makeFilter(
    (value) =>
      hasNoAsciiControlCharacters(value) &&
      !value.includes("<") &&
      !value.includes(">"),
    { title: "EmailReceivedContentId" },
  ),
)

/** Safe inbound Content-ID value with angle brackets removed. */
export type ReceivedContentId = typeof ReceivedContentIdSchema.Type

/** Metadata for one lazily readable inbound attachment. */
export const ReceivedAttachmentSchema = Schema.Struct({
  id: ReceivedAttachmentIdSchema,
  filename: Schema.NullOr(ReceivedAttachmentFilenameSchema),
  mediaType: MediaTypeSchema,
  disposition: Schema.NullOr(
    Schema.Literals(["attachment", "inline"]),
  ),
  contentId: Schema.NullOr(ReceivedContentIdSchema),
  sizeBytes: NaturalBytesSchema,
})

/** Metadata for one lazily readable inbound attachment. */
export interface ReceivedAttachment extends Schema.Schema.Type<
  typeof ReceivedAttachmentSchema
> {}

/** Threading headers projected from one immutable received message. */
export const ReceivedThreadingSchema = Schema.Struct({
  messageId: Schema.NullOr(ThreadMessageIdSchema),
  inReplyTo: Schema.NullOr(ThreadMessageIdSchema),
  references: Schema.Array(ThreadMessageIdSchema),
})

/** Threading headers projected from one immutable received message. */
export interface ReceivedThreading extends Schema.Schema.Type<
  typeof ReceivedThreadingSchema
> {}

/** Normalized automation signals retained without exposing arbitrary headers. */
export const ReceivedAutomationSchema = Schema.Struct({
  autoSubmitted: Schema.NullOr(Schema.Literals(["no", "automatic"])),
  precedence: Schema.NullOr(
    Schema.Literals(["bulk", "list", "junk", "other"]),
  ),
  listId: Schema.Boolean,
  responseSuppression: Schema.Boolean,
})

/** Normalized automation signals retained without exposing arbitrary headers. */
export interface ReceivedAutomation extends Schema.Schema.Type<
  typeof ReceivedAutomationSchema
> {}

/**
 * Bounded, typed content projected lazily from one archived inbound message.
 *
 * HTML remains untrusted input and must be sanitized by any rendering host.
 */
export const ReceivedContentSchema = Schema.Struct({
  messageId: MessageIdSchema,
  routeId: RouteIdSchema,
  envelopeFrom: EmailAddressSchema,
  envelopeTo: Schema.NonEmptyArray(EmailAddressSchema),
  headerFrom: Schema.Array(EmailAddressSchema),
  replyTo: Schema.Array(EmailAddressSchema),
  subject: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  html: Schema.NullOr(Schema.String),
  threading: ReceivedThreadingSchema,
  automation: ReceivedAutomationSchema,
  attachments: Schema.Array(ReceivedAttachmentSchema),
})

/**
 * Bounded, typed content projected lazily from one archived inbound message.
 *
 * HTML remains untrusted input and must be sanitized by any rendering host.
 */
export interface ReceivedContent extends Schema.Schema.Type<
  typeof ReceivedContentSchema
> {}

/** Exact bytes and metadata returned for one authorized attachment read. */
export interface ReceivedAttachmentContent {
  readonly attachment: ReceivedAttachment
  readonly content: Uint8Array
}
