import { Schema } from "effect"
import { EmailAddressSchema } from "../core/address.js"
import {
  AttachmentSchema,
  AttachmentFilenameSchema,
  CustomHeaderSchema,
  MediaTypeSchema,
} from "../core/email-command.js"
import {
  MessageIdSchema,
  PageCursorSchema,
  ProviderMessageIdSchema,
  RecipientIdSchema,
  RouteIdSchema,
  WorkflowIdSchema,
} from "../core/identifiers.js"
import {
  DirectionSchema,
  RecipientKindSchema,
  RecipientStatusSchema,
} from "../core/message.js"
import { ReceivedContentSchema } from "../core/received-content.js"
import { EnvironmentSchema } from "../core/scope.js"

const NaturalBytesSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
)

/** Base64 HTTP representation of one outbound attachment. */
export const SendAttachmentSchema = Schema.Struct({
  filename: AttachmentFilenameSchema,
  mediaType: MediaTypeSchema,
  disposition: Schema.optionalKey(
    Schema.Literals(["attachment", "inline"]),
  ),
  contentId: AttachmentSchema.fields.contentId,
  content: Schema.Uint8ArrayFromBase64,
})

/** Base64 HTTP representation of one outbound attachment. */
export interface SendAttachment extends Schema.Schema.Type<
  typeof SendAttachmentSchema
> {}

/** Body accepted by the hosted outbound-send operation. */
export const SendEmailRequestSchema = Schema.Struct({
  fromRouteId: Schema.optionalKey(RouteIdSchema),
  to: Schema.NonEmptyArray(EmailAddressSchema),
  cc: Schema.optionalKey(Schema.Array(EmailAddressSchema)),
  bcc: Schema.optionalKey(Schema.Array(EmailAddressSchema)),
  subject: Schema.String.check(
    Schema.isMaxLength(998),
    Schema.isPattern(/^[^\r\n]*$/u),
  ),
  automation: Schema.optionalKey(Schema.Literal("auto_generated")),
  text: Schema.optionalKey(Schema.String),
  html: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(
    Schema.Array(CustomHeaderSchema).check(Schema.isMaxLength(100)),
  ),
  attachments: Schema.optionalKey(
    Schema.Array(SendAttachmentSchema).check(Schema.isMaxLength(100)),
  ),
})

/** Body accepted by the hosted outbound-send operation. */
export interface SendEmailRequest extends Schema.Schema.Type<
  typeof SendEmailRequestSchema
> {}

/** Body accepted by the hosted constrained-reply operation. */
export const ReplyEmailRequestSchema = Schema.Struct({
  text: SendEmailRequestSchema.fields.text,
  html: SendEmailRequestSchema.fields.html,
  headers: SendEmailRequestSchema.fields.headers,
  attachments: SendEmailRequestSchema.fields.attachments,
})

/** Body accepted by the hosted constrained-reply operation. */
export interface ReplyEmailRequest extends Schema.Schema.Type<
  typeof ReplyEmailRequestSchema
> {}

/** Hosted response containing bounded content for one received message. */
export const ReceivedContentEnvelopeSchema = Schema.Struct({
  content: ReceivedContentSchema,
})

/** Hosted response containing bounded content for one received message. */
export interface ReceivedContentEnvelope extends Schema.Schema.Type<
  typeof ReceivedContentEnvelopeSchema
> {}

/** Public state vocabulary for hosted message representations. */
export const MessageStatusSchema = Schema.Literals([
  "received",
  "workflow_event_created",
  "reserved",
  "sending",
  "captured",
  "accepted",
  "partially_accepted",
  "delivery_unknown",
  "failed",
])

/** Public state vocabulary for hosted message representations. */
export type MessageStatus = typeof MessageStatusSchema.Type

/** Public recipient projection returned with an email message. */
export const MessageRecipientSchema = Schema.Struct({
  id: RecipientIdSchema,
  kind: RecipientKindSchema,
  address: EmailAddressSchema,
  status: RecipientStatusSchema,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
})

/** Public recipient projection returned with an email message. */
export interface MessageRecipient extends Schema.Schema.Type<
  typeof MessageRecipientSchema
> {}

/** Public message projection returned by hosted read and send operations. */
export const EmailMessageSchema = Schema.Struct({
  id: MessageIdSchema,
  environment: EnvironmentSchema,
  direction: DirectionSchema,
  status: MessageStatusSchema,
  routeId: Schema.NullOr(RouteIdSchema),
  workflowId: Schema.NullOr(WorkflowIdSchema),
  from: EmailAddressSchema,
  to: Schema.NonEmptyArray(EmailAddressSchema),
  cc: Schema.Array(EmailAddressSchema),
  bcc: Schema.Array(EmailAddressSchema),
  subject: Schema.NullOr(Schema.String),
  sizeBytes: NaturalBytesSchema,
  providerMessageId: Schema.NullOr(ProviderMessageIdSchema),
  sentAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  receivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  recipients: Schema.Array(MessageRecipientSchema),
})

/** Public message projection returned by hosted read and send operations. */
export interface EmailMessage extends Schema.Schema.Type<
  typeof EmailMessageSchema
> {}

/** Hosted response containing one public email message. */
export const EmailMessageEnvelopeSchema = Schema.Struct({
  message: EmailMessageSchema,
})

/** Hosted response containing one public email message. */
export interface EmailMessageEnvelope extends Schema.Schema.Type<
  typeof EmailMessageEnvelopeSchema
> {}

/** Hosted response containing a stable page of public messages. */
export const EmailMessagePageSchema = Schema.Struct({
  cursor: Schema.NullOr(PageCursorSchema),
  items: Schema.Array(EmailMessageSchema),
})

/** Hosted response containing a stable page of public messages. */
export interface EmailMessagePage extends Schema.Schema.Type<
  typeof EmailMessagePageSchema
> {}

/** Query accepted by the hosted message-list operation. */
export const ListMessagesQuerySchema = Schema.Struct({
  direction: Schema.optionalKey(DirectionSchema),
  cursor: Schema.optionalKey(PageCursorSchema),
  limit: Schema.optionalKey(
    Schema.NumberFromString.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 100 }),
      ),
    ),
  ),
})
