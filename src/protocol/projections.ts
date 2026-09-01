import { Effect, Option, Schema } from "effect"
import type {
  MessageDetails,
  MessagePage,
} from "../application/read-email.js"
import type { Actor } from "../core/actor.js"
import {
  AttachmentSchema,
  BodySchema,
  FromSelectorSchema,
  SendCommandSchema,
  type Attachment,
  type Body,
  type FromSelector,
  type SendCommand,
} from "../core/email-command.js"
import {
  type IdempotencyKey,
  type MessageId,
  MessageIdSchema,
  RecipientIdSchema,
} from "../core/identifiers.js"
import type {
  Message,
  MessageRecipient as DomainMessageRecipient,
  OutboundMessage,
} from "../core/message.js"
import type { Route } from "../core/route.js"
import type { ReceivedContent } from "../core/received-content.js"
import {
  ReplyCommandSchema,
  type ReplyCommand,
} from "../core/reply-command.js"
import type { Scope } from "../core/scope.js"
import type { TestRecipient as DomainTestRecipient } from "../core/test-recipient.js"
import {
  type EmailMessage,
  type EmailMessageEnvelope,
  type EmailMessagePage,
  type MessageRecipient,
  type ReceivedContentEnvelope,
  type ReplyEmailRequest,
  type SendAttachment,
  type SendEmailRequest,
} from "./messages.js"
import type { EmailRoute } from "./routes.js"
import type { EmailTestRecipient } from "./test-recipients.js"

/** A recipient supplied for projection belonged to a different message. */
export class MessageProjectionMismatch extends Schema.TaggedError<
  MessageProjectionMismatch
>()("MessageProjectionMismatch", {
  messageId: MessageIdSchema,
  recipientId: RecipientIdSchema,
  reason: Schema.Literal("recipient_message_mismatch"),
}) {}

/** Authenticated context and decoded request needed to construct a send command. */
export interface AuthenticatedSendCommandInput {
  readonly scope: Scope
  readonly actor: Actor
  readonly idempotencyKey: IdempotencyKey
  readonly request: SendEmailRequest
}

/** Authenticated context and decoded request needed to construct a reply command. */
export interface AuthenticatedReplyCommandInput {
  readonly scope: Scope
  readonly actor: Actor
  readonly idempotencyKey: IdempotencyKey
  readonly sourceMessageId: MessageId
  readonly request: ReplyEmailRequest
}

const projectRecipient = (
  recipient: DomainMessageRecipient,
): MessageRecipient => ({
  id: recipient.id,
  kind: recipient.kind,
  address: recipient.address,
  status: recipient.status,
  createdAt: recipient.createdAt,
  updatedAt: recipient.updatedAt,
})

const outboundStatus = (
  message: OutboundMessage,
): EmailMessage["status"] => {
  switch (message.state._tag) {
    case "Reserved":
      return "reserved"
    case "Sending":
      return "sending"
    case "Captured":
      return "captured"
    case "Accepted":
      return "accepted"
    case "PartiallyAccepted":
      return "partially_accepted"
    case "DeliveryUnknown":
      return "delivery_unknown"
    case "Failed":
      return "failed"
  }
}

const messageStatus = (message: Message): EmailMessage["status"] => {
  if (message._tag === "Outbound") {
    return outboundStatus(message)
  }
  switch (message.state._tag) {
    case "Received":
      return "received"
    case "WorkflowEventCreated":
      return "workflow_event_created"
  }
}

const providerMessageId = (
  message: Message,
): EmailMessage["providerMessageId"] => {
  if (message._tag !== "Outbound") return null
  switch (message.state._tag) {
    case "Accepted":
    case "PartiallyAccepted":
      return message.state.providerMessageId ?? null
    case "Reserved":
    case "Sending":
    case "Captured":
    case "DeliveryUnknown":
    case "Failed":
      return null
  }
}

const sentAt = (message: Message): EmailMessage["sentAt"] => {
  if (message._tag !== "Outbound") return null
  switch (message.state._tag) {
    case "Accepted":
    case "PartiallyAccepted":
      return message.state.sentAt
    case "Reserved":
    case "Sending":
    case "Captured":
    case "DeliveryUnknown":
    case "Failed":
      return null
  }
}

/**
 * Project one application message result to the public DTO.
 *
 * The projection fails closed when a recipient belongs to another message so
 * a caller cannot accidentally disclose a recipient across message scopes.
 */
export const projectMessage = (
  details: MessageDetails,
): Effect.Effect<EmailMessage, MessageProjectionMismatch> => {
  const { message, recipients } = details
  const mismatch = recipients.find(
    (recipient) => recipient.messageId !== message.id,
  )
  if (mismatch !== undefined) {
    return Effect.fail(new MessageProjectionMismatch({
      messageId: message.id,
      recipientId: mismatch.id,
      reason: "recipient_message_mismatch",
    }))
  }

  const common = {
    id: message.id,
    environment: message.scope.environment,
    direction: message._tag === "Outbound" ? "outbound" as const : "inbound" as const,
    status: messageStatus(message),
    routeId: message.routeId,
    workflowId: message._tag === "Inbound"
      ? message.workflowId ?? null
      : null,
    from: message.from,
    to: message.to,
    cc: message._tag === "Outbound" ? message.cc : [],
    bcc: message._tag === "Outbound" ? message.bcc : [],
    subject: message.subject,
    sizeBytes: message.sizeBytes,
    providerMessageId: providerMessageId(message),
    sentAt: sentAt(message),
    receivedAt: message._tag === "Inbound" ? message.receivedAt : null,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    recipients: recipients.map(projectRecipient),
  }
  return Effect.succeed(common)
}

/** Project one application message result into the hosted response envelope. */
export const projectMessageEnvelope = (
  details: MessageDetails,
): Effect.Effect<EmailMessageEnvelope, MessageProjectionMismatch> =>
  projectMessage(details).pipe(
    Effect.map((message) => ({ message })),
  )

/** Project one application message page into the hosted cursor page. */
export const projectMessagePage = (
  page: MessagePage,
): Effect.Effect<EmailMessagePage, MessageProjectionMismatch> =>
  Effect.forEach(page.items, projectMessage).pipe(
    Effect.map((items) => ({
      cursor: Option.getOrNull(page.nextCursor),
      items,
    })),
  )

/** Project bounded received content into the hosted response envelope. */
export const projectReceivedContentEnvelope = (
  content: ReceivedContent,
): ReceivedContentEnvelope => ({ content })

const routeStatus = (route: Route): EmailRoute["status"] => {
  switch (route.lifecycle._tag) {
    case "Active":
      return "active"
    case "Paused":
      return "paused"
    case "Disabled":
      return "disabled"
  }
}

/** Project a domain route without exposing namespace, actor, or lifecycle audit data. */
export const projectRoute = (route: Route): EmailRoute => ({
  id: route.id,
  environment: route.scope.environment,
  address: route.address,
  mailboxHandle: route.mailboxHandle,
  inbound: route.inbound._tag === "Store"
    ? { kind: "store" }
    : {
        kind: "trigger",
        workflowId: route.inbound.workflowId,
      },
  outbound: route.outbound._tag === "Disabled"
    ? { kind: "disabled" }
    : { kind: "sender", role: route.outbound.role },
  status: routeStatus(route),
  revision: route.revision,
  createdAt: route.createdAt,
  updatedAt: route.updatedAt,
  disabledAt: route.lifecycle._tag === "Disabled"
    ? route.lifecycle.disabledAt
    : null,
})

const testRecipientStatus = (
  recipient: DomainTestRecipient,
): EmailTestRecipient["status"] => {
  switch (recipient.state._tag) {
    case "Pending":
      return "pending"
    case "Verified":
      return "verified"
    case "Failed":
      return "failed"
  }
}

/** Project a test-recipient grant without provider, namespace, or actor details. */
export const projectTestRecipient = (
  recipient: DomainTestRecipient,
): EmailTestRecipient => ({
  id: recipient.id,
  address: recipient.address,
  status: testRecipientStatus(recipient),
  createdAt: recipient.createdAt,
  updatedAt: recipient.updatedAt,
})

interface BodyRequest {
  readonly text?: string
  readonly html?: string
}

const messageBody = (request: BodyRequest): Body => {
  const text = request.text
  const html = request.html
  if (text === undefined) {
    if (html === undefined) {
      return BodySchema.cases.Empty.make({})
    }
    return BodySchema.cases.Html.make({ html })
  }
  if (html === undefined) {
    return BodySchema.cases.Text.make({ text })
  }
  return BodySchema.cases.Multipart.make({
    text,
    html,
  })
}

const fromSelector = (request: SendEmailRequest): FromSelector =>
  request.fromRouteId === undefined
    ? FromSelectorSchema.cases.DefaultRoute.make({})
    : FromSelectorSchema.cases.Route.make({
        routeId: request.fromRouteId,
      })

const attachment = (input: SendAttachment): Attachment => {
  const fields = {
    filename: input.filename,
    mediaType: input.mediaType,
    disposition: input.disposition ?? "attachment",
    content: input.content,
  }
  if (input.contentId === undefined) {
    return AttachmentSchema.make(fields)
  }
  return AttachmentSchema.make({
    ...fields,
    contentId: input.contentId,
  })
}

/**
 * Construct a domain send command from trusted auth context and a decoded request.
 *
 * Authentication, authorization, and HTTP parsing remain responsibilities of
 * the hosting adapter; this helper only performs protocol-to-domain mapping.
 */
export const makeSendCommand = (
  input: AuthenticatedSendCommandInput,
): SendCommand => {
  const base = {
    scope: input.scope,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
    from: fromSelector(input.request),
    to: input.request.to,
    cc: input.request.cc ?? [],
    bcc: input.request.bcc ?? [],
    subject: input.request.subject,
    body: messageBody(input.request),
    headers: input.request.headers ?? [],
    attachments: (input.request.attachments ?? []).map(attachment),
  }
  return SendCommandSchema.make(input.request.automation === undefined
    ? base
    : { ...base, automation: input.request.automation })
}

/**
 * Construct a constrained domain reply command from trusted auth context and
 * a decoded request. Sender, recipient, subject, and threading remain derived
 * by the application service from the source received message.
 */
export const makeReplyCommand = (
  input: AuthenticatedReplyCommandInput,
): ReplyCommand => ReplyCommandSchema.make({
  scope: input.scope,
  actor: input.actor,
  idempotencyKey: input.idempotencyKey,
  sourceMessageId: input.sourceMessageId,
  body: messageBody(input.request),
  headers: input.request.headers ?? [],
  attachments: (input.request.attachments ?? []).map(attachment),
})
