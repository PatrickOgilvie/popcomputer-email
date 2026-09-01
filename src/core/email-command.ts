import { Effect, Schema } from "effect"
import { ActorSchema } from "./actor.js"
import { EmailAddressSchema } from "./address.js"
import {
  IdempotencyKeySchema,
  RouteIdSchema,
} from "./identifiers.js"
import { ScopeSchema } from "./scope.js"
import { ThreadingSchema } from "./threading.js"

const HeaderLineValueSchema = Schema.String.check(
  Schema.isMaxLength(8_192),
  Schema.isPattern(/^[^\r\n]*$/u),
)

const hasNoAsciiControlCharacters = (value: string): boolean =>
  Array.from(value).every((character) => {
    const code = character.charCodeAt(0)
    return code >= 32 && code !== 127
  })

const ReservedHeaderNames = new Set([
  "bcc",
  "auto-submitted",
  "cc",
  "content-transfer-encoding",
  "content-type",
  "date",
  "from",
  "in-reply-to",
  "message-id",
  "mime-version",
  "reply-to",
  "return-path",
  "references",
  "sender",
  "subject",
  "to",
  "x-auto-response-suppress",
])

/** Header name callers may add without overriding routing or MIME structure. */
export const CustomHeaderNameSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(78),
  Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u),
  Schema.makeFilter(
    (name) => !ReservedHeaderNames.has(name.toLowerCase()),
    { title: "CustomEmailHeaderName" },
  ),
).pipe(Schema.brand("CustomEmailHeaderName"))

/** Header name callers may add without overriding routing or MIME structure. */
export type CustomHeaderName = typeof CustomHeaderNameSchema.Type

/** One safe caller-supplied message header. */
export const CustomHeaderSchema = Schema.Struct({
  name: CustomHeaderNameSchema,
  value: HeaderLineValueSchema,
})

/** One safe caller-supplied message header. */
export interface CustomHeader extends Schema.Schema.Type<
  typeof CustomHeaderSchema
> {}

/** Email body with exactly the content variants meaningful to MIME rendering. */
export const BodySchema = Schema.TaggedUnion({
  Empty: {},
  Text: { text: Schema.String },
  Html: { html: Schema.String },
  Multipart: {
    text: Schema.String,
    html: Schema.String,
  },
})

/** Email body with exactly the content variants meaningful to MIME rendering. */
export type Body = typeof BodySchema.Type

/** Filename safe to project into a MIME content-disposition parameter. */
export const AttachmentFilenameSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(255),
  Schema.makeFilter(
    (value) =>
      hasNoAsciiControlCharacters(value) &&
      !value.includes("/") &&
      !value.includes("\\"),
    { title: "EmailAttachmentFilename" },
  ),
).pipe(Schema.brand("EmailAttachmentFilename"))

/** Filename safe to project into a MIME content-disposition parameter. */
export type AttachmentFilename = typeof AttachmentFilenameSchema.Type

/** Parsed IANA-style media type used for one MIME attachment. */
export const MediaTypeSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(255),
  Schema.isPattern(
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+-]+|"[^"\r\n]*"))*$/u,
  ),
).pipe(Schema.brand("EmailMediaType"))

/** Parsed IANA-style media type used for one MIME attachment. */
export type MediaType = typeof MediaTypeSchema.Type

/** Binary attachment whose encoded representation is owned by boundary codecs. */
export const AttachmentSchema = Schema.Struct({
  filename: AttachmentFilenameSchema,
  mediaType: MediaTypeSchema,
  disposition: Schema.Literals(["attachment", "inline"]),
  contentId: Schema.optionalKey(
    Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(998),
      Schema.makeFilter(
        (value) =>
          hasNoAsciiControlCharacters(value) &&
          !value.includes("<") &&
          !value.includes(">"),
        { title: "EmailAttachmentContentId" },
      ),
    ),
  ),
  content: Schema.Uint8Array,
})

/** Binary attachment whose encoded representation is owned by boundary codecs. */
export interface Attachment extends Schema.Schema.Type<
  typeof AttachmentSchema
> {}

/** Explicit route-selection policy for an outbound sender. */
export const FromSelectorSchema = Schema.TaggedUnion({
  DefaultRoute: {},
  Route: { routeId: RouteIdSchema },
})

/** Explicit route-selection policy for an outbound sender. */
export type FromSelector = typeof FromSelectorSchema.Type

/** Explicit automatic-message classification rendered into loop-safety headers. */
export const OutboundAutomationSchema = Schema.Literals([
  "auto_generated",
  "auto_reply",
])

/** Explicit automatic-message classification rendered into loop-safety headers. */
export type OutboundAutomation = typeof OutboundAutomationSchema.Type

/** Complete parsed command for one idempotent outbound email send. */
export const SendCommandSchema = Schema.Struct({
  scope: ScopeSchema,
  actor: ActorSchema,
  idempotencyKey: IdempotencyKeySchema,
  from: FromSelectorSchema,
  to: Schema.NonEmptyArray(EmailAddressSchema),
  cc: Schema.Array(EmailAddressSchema),
  bcc: Schema.Array(EmailAddressSchema),
  subject: HeaderLineValueSchema.pipe(Schema.check(Schema.isMaxLength(998))),
  body: BodySchema,
  headers: Schema.Array(CustomHeaderSchema).check(Schema.isMaxLength(100)),
  attachments: Schema.Array(AttachmentSchema).check(
    Schema.isMaxLength(100),
  ),
  threading: Schema.optionalKey(ThreadingSchema),
  automation: Schema.optionalKey(OutboundAutomationSchema),
})

/** Complete parsed command for one idempotent outbound email send. */
export interface SendCommand extends Schema.Schema.Type<
  typeof SendCommandSchema
> {}

/** Safe reason a complete outbound command was rejected during parsing. */
export const InvalidEmailCommandReasonSchema = Schema.Literal(
  "invalid_input",
)

/** Untrusted input did not satisfy the outbound command contract. */
export class InvalidEmailCommand extends Schema.TaggedError<
  InvalidEmailCommand
>()("InvalidEmailCommand", {
  reason: InvalidEmailCommandReasonSchema,
}) {}

/** A scoped idempotency key was replayed with a different command. */
export class IdempotencyConflict extends Schema.TaggedError<
  IdempotencyConflict
>()("IdempotencyConflict", {
  reason: Schema.Literal("fingerprint_mismatch"),
}) {}

/** A parsed message exceeded the active transport or archive policy. */
export class MessageTooLarge extends Schema.TaggedError<MessageTooLarge>()(
  "MessageTooLarge",
  {
    actualBytes: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
    ),
    maximumBytes: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
    ),
  },
) {}

/** A recipient was outside the policy permitted for the command scope. */
export class RecipientNotPermitted extends Schema.TaggedError<
  RecipientNotPermitted
>()("RecipientNotPermitted", {
  reason: Schema.Literals([
    "test_recipient_unverified",
    "recipient_limit_exceeded",
  ]),
}) {}

/** Parse an untrusted value into a command without retaining rejected content. */
export const parseSendCommand = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This public boundary immediately decodes the complete command schema and discards unsafe details on failure.
  input: unknown,
): Effect.Effect<SendCommand, InvalidEmailCommand> =>
  Schema.decodeUnknownEffect(SendCommandSchema)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(() =>
      new InvalidEmailCommand({ reason: "invalid_input" })
    ),
  )
