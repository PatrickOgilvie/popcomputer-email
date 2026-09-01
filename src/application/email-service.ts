import { Context, Effect, Layer, Schema } from "effect"
import { ContentDigest } from "../adapters/content-digest.js"
import { IdentifierGenerator } from "../adapters/identifier-generator.js"
import {
  MessageStore,
  type GetMessageInput,
  type ListMessagesInput,
  type MessageStoreOperation,
} from "../adapters/message-store.js"
import { OutboundPolicy } from "../adapters/outbound-policy.js"
import {
  RawMessageArchive,
  type RawMessageArchiveOperation,
  type RawMime,
} from "../adapters/raw-message-archive.js"
import { RouteStore } from "../adapters/route-store.js"
import { SendTransport } from "../adapters/send-transport.js"
import {
  IdempotencyConflict,
  type MessageTooLarge,
  type RecipientNotPermitted,
  type SendCommand,
} from "../core/email-command.js"
import type { ReplyCommand } from "../core/reply-command.js"
import { type InvalidPageRequest, MessageIdSchema } from "../core/identifiers.js"
import {
  InvalidStoredMessage,
  MessageNotFound,
} from "../core/message.js"
import {
  RouteInactive,
  RouteNotFound,
  RouteNotSendable,
} from "../core/route.js"
import {
  getMessage,
  listMessages,
  readRawMime,
  type MessageDetails,
  type MessagePage,
  type ReadEmailFailure,
  type ReadRawMimeFailure,
} from "./read-email.js"
import {
  sendEmail,
  type SendEmailFailure,
} from "./send-email.js"
import {
  replyEmailWithPolicy,
  ReplySourceRouteMismatch,
  ReplyTargetUnavailable,
  type ReplyEmailFailure,
} from "./reply-email.js"
import {
  conservativeReplyPolicy,
  ReplyLoopPrevented,
  ReplyPolicy,
  ReplyPolicyRejected,
} from "./reply-policy.js"
import {
  defaultReceivedContentConfig,
  getReceivedContent,
  InvalidReceivedContentConfig,
  InvalidReceivedMime,
  parseReceivedContentConfig,
  readReceivedAttachment,
  ReceivedAttachmentNotFound,
  ReceivedContentReadFailure,
  ReceivedContentTooLarge,
  ReceivedContentUnavailable,
  type GetReceivedAttachmentInput,
  type ReadReceivedAttachmentFailure,
  type ReadReceivedContentFailure,
  type ReceivedContentConfig,
} from "./read-received-content.js"
import type {
  ReceivedAttachmentContent,
  ReceivedContent,
} from "../core/received-content.js"

/** No active default sender route is configured for a send scope. */
export class DefaultSenderUnavailable extends Schema.TaggedError<DefaultSenderUnavailable>()(
  "DefaultSenderUnavailable",
  { reason: Schema.Literal("not_found") },
) {}

/** Message persistence or route lookup is temporarily unavailable. */
export class EmailStoreUnavailable extends Schema.TaggedError<EmailStoreUnavailable>()(
  "EmailStoreUnavailable",
  {
    operation: Schema.Literals([
      "find_idempotency",
      "reserve",
      "create_archive_intent",
      "attach_raw",
      "claim",
      "finalize",
      "get",
      "list",
      "route_lookup",
    ]),
    reason: Schema.Literal("unavailable"),
  },
) {}

/** Raw MIME archive infrastructure is temporarily unavailable. */
export class EmailArchiveUnavailable extends Schema.TaggedError<EmailArchiveUnavailable>()(
  "EmailArchiveUnavailable",
  {
    operation: Schema.Literals(["reference", "put", "get", "remove"]),
    reason: Schema.Literal("unavailable"),
  },
) {}

/** Transport readiness could not be established before reservation. */
export class EmailTransportUnavailable extends Schema.TaggedError<EmailTransportUnavailable>()(
  "EmailTransportUnavailable",
  {
    reason: Schema.Literals(["configuration", "unavailable"]),
  },
) {}

/** Cryptographic digest infrastructure needed by the send workflow failed. */
export class EmailDigestUnavailable extends Schema.TaggedError<EmailDigestUnavailable>()(
  "EmailDigestUnavailable",
  { reason: Schema.Literal("unavailable") },
) {}

/** Recipient and size policy could not make a safe outbound decision. */
export class EmailPolicyUnavailable extends Schema.TaggedError<EmailPolicyUnavailable>()(
  "EmailPolicyUnavailable",
  { reason: Schema.Literal("unavailable") },
) {}

/** A compare-and-set message transition lost a concurrent update. */
export class EmailTransitionConflict extends Schema.TaggedError<EmailTransitionConflict>()(
  "EmailTransitionConflict",
  {
    messageId: MessageIdSchema,
    reason: Schema.Literal("concurrent_update"),
  },
) {}

/** A message has no raw MIME object available for streaming. */
export class RawMimeNotFound extends Schema.TaggedError<RawMimeNotFound>()(
  "RawMimeNotFound",
  {
    messageId: MessageIdSchema,
    reason: Schema.Literals(["not_archived", "archive_object_missing"]),
  },
) {}

/** Public typed failures from one parsed send command. */
export type SendError =
  | DefaultSenderUnavailable
  | EmailArchiveUnavailable
  | EmailDigestUnavailable
  | EmailPolicyUnavailable
  | EmailStoreUnavailable
  | EmailTransitionConflict
  | EmailTransportUnavailable
  | IdempotencyConflict
  | InvalidStoredMessage
  | MessageTooLarge
  | RecipientNotPermitted
  | RouteInactive
  | RouteNotFound
  | RouteNotSendable

/** Public typed failures from parsed-message reads. */
export type ReadError =
  | EmailStoreUnavailable
  | InvalidPageRequest
  | InvalidStoredMessage
  | MessageNotFound

/** Public typed failures from raw MIME streaming reads. */
export type RawReadError =
  | EmailArchiveUnavailable
  | EmailStoreUnavailable
  | InvalidStoredMessage
  | MessageNotFound
  | RawMimeNotFound

/** Public typed failures from a bounded received-content projection. */
export type ReceivedContentReadError =
  | EmailArchiveUnavailable
  | EmailDigestUnavailable
  | EmailStoreUnavailable
  | InvalidReceivedContentConfig
  | InvalidReceivedMime
  | InvalidStoredMessage
  | MessageNotFound
  | ReceivedContentReadFailure
  | ReceivedContentTooLarge
  | ReceivedContentUnavailable

/** Public typed failures from one received-attachment read. */
export type ReceivedAttachmentReadError =
  | ReceivedAttachmentNotFound
  | ReceivedContentReadError

/** Public typed failures from one constrained reply action. */
export type ReplyError =
  | ReceivedContentReadError
  | ReplyLoopPrevented
  | ReplyPolicyRejected
  | ReplySourceRouteMismatch
  | ReplyTargetUnavailable
  | SendError

const unavailableStore = (
  operation: MessageStoreOperation | "route_lookup",
): EmailStoreUnavailable =>
  new EmailStoreUnavailable({ operation, reason: "unavailable" })

const unavailableArchive = (
  operation: RawMessageArchiveOperation,
): EmailArchiveUnavailable =>
  new EmailArchiveUnavailable({ operation, reason: "unavailable" })

const mapSendFailure = (failure: SendEmailFailure): SendError => {
  switch (failure._tag) {
    case "ContentDigestFailure":
      return new EmailDigestUnavailable({ reason: "unavailable" })
    case "DefaultSenderNotFound":
      return new DefaultSenderUnavailable({ reason: failure.reason })
    case "MessageInvariantViolation":
    case "NonDeterministicMime":
      return new InvalidStoredMessage({ reason: "invalid_state" })
    case "OutboundPolicyFailure":
      return new EmailPolicyUnavailable({ reason: failure.reason })
    case "MessageStoreFailure":
      return unavailableStore(failure.operation)
    case "MessageTransitionConflict":
      return new EmailTransitionConflict({
        messageId: failure.messageId,
        reason: failure.reason,
      })
    case "RawMessageArchiveFailure":
      return unavailableArchive(failure.operation)
    case "RouteStoreFailure":
      return unavailableStore("route_lookup")
    case "SendTransportUnavailable":
      return new EmailTransportUnavailable({ reason: failure.reason })
    case "IdempotencyConflict":
    case "InvalidStoredMessage":
    case "RouteInactive":
    case "RouteNotFound":
    case "RouteNotSendable":
    case "MessageTooLarge":
    case "RecipientNotPermitted":
      return failure
  }
}

const mapReadFailure = (failure: ReadEmailFailure): ReadError => {
  switch (failure._tag) {
    case "InvalidPageRequest":
      return failure
    case "MessageStoreFailure":
      return unavailableStore(failure.operation)
    case "InvalidStoredMessage":
    case "MessageNotFound":
      return failure
  }
}

const mapRawReadFailure = (failure: ReadRawMimeFailure): RawReadError => {
  switch (failure._tag) {
    case "ArchivedMimeNotFound":
      return new RawMimeNotFound({
        messageId: failure.messageId,
        reason: failure.reason,
      })
    case "RawMessageArchiveFailure":
      return unavailableArchive(failure.operation)
    case "MessageStoreFailure":
      return unavailableStore(failure.operation)
    case "InvalidStoredMessage":
    case "MessageNotFound":
      return failure
  }
}

const mapReceivedContentFailure = (
  failure: ReadReceivedContentFailure,
): ReceivedContentReadError => {
  switch (failure._tag) {
    case "ContentDigestFailure":
      return new EmailDigestUnavailable({ reason: "unavailable" })
    case "MessageStoreFailure":
      return unavailableStore(failure.operation)
    case "RawMessageArchiveFailure":
      return unavailableArchive(failure.operation)
    case "InvalidReceivedContentConfig":
    case "InvalidReceivedMime":
    case "InvalidStoredMessage":
    case "MessageNotFound":
    case "ReceivedContentReadFailure":
    case "ReceivedContentTooLarge":
    case "ReceivedContentUnavailable":
      return failure
  }
}

const mapReceivedAttachmentFailure = (
  failure: ReadReceivedAttachmentFailure,
): ReceivedAttachmentReadError =>
  failure._tag === "ReceivedAttachmentNotFound"
    ? failure
    : mapReceivedContentFailure(failure)

const mapReplyFailure = (failure: ReplyEmailFailure): ReplyError => {
  switch (failure._tag) {
    case "ContentDigestFailure":
      return new EmailDigestUnavailable({ reason: "unavailable" })
    case "MessageStoreFailure":
      return unavailableStore(failure.operation)
    case "RawMessageArchiveFailure":
      return unavailableArchive(failure.operation)
    case "RouteStoreFailure":
      return unavailableStore("route_lookup")
    case "DefaultSenderNotFound":
      return new DefaultSenderUnavailable({ reason: failure.reason })
    case "MessageInvariantViolation":
    case "NonDeterministicMime":
      return new InvalidStoredMessage({ reason: "invalid_state" })
    case "OutboundPolicyFailure":
      return new EmailPolicyUnavailable({ reason: failure.reason })
    case "MessageTransitionConflict":
      return new EmailTransitionConflict({
        messageId: failure.messageId,
        reason: failure.reason,
      })
    case "SendTransportUnavailable":
      return new EmailTransportUnavailable({ reason: failure.reason })
    case "IdempotencyConflict":
    case "InvalidReceivedContentConfig":
    case "InvalidReceivedMime":
    case "InvalidStoredMessage":
    case "MessageNotFound":
    case "MessageTooLarge":
    case "RecipientNotPermitted":
    case "ReceivedContentReadFailure":
    case "ReceivedContentTooLarge":
    case "ReceivedContentUnavailable":
    case "ReplyLoopPrevented":
    case "ReplyPolicyRejected":
    case "ReplySourceRouteMismatch":
    case "ReplyTargetUnavailable":
    case "RouteInactive":
    case "RouteNotFound":
    case "RouteNotSendable":
      return failure
  }
}

/** Effect-native application service for idempotent sends and scoped reads. */
export class EmailService extends Context.Service<EmailService, {
  readonly send: (
    command: SendCommand,
  ) => Effect.Effect<MessageDetails, SendError>
  readonly listMessages: (
    input: ListMessagesInput,
  ) => Effect.Effect<MessagePage, ReadError>
  readonly getMessage: (
    input: GetMessageInput,
  ) => Effect.Effect<MessageDetails, ReadError>
  readonly readRawMime: (
    input: GetMessageInput,
  ) => Effect.Effect<RawMime, RawReadError>
  readonly getReceivedContent: (
    input: GetMessageInput,
  ) => Effect.Effect<ReceivedContent, ReceivedContentReadError>
  readonly readReceivedAttachment: (
    input: GetReceivedAttachmentInput,
  ) => Effect.Effect<ReceivedAttachmentContent, ReceivedAttachmentReadError>
  readonly reply: (
    command: ReplyCommand,
  ) => Effect.Effect<MessageDetails, ReplyError>
}>()("@popcomputer/email/EmailService") {}

type EmailServiceDependencies =
  | ContentDigest
  | IdentifierGenerator
  | MessageStore
  | OutboundPolicy
  | RawMessageArchive
  | RouteStore
  | SendTransport

const layerFromParsedConfig = (
  contentConfig: ReceivedContentConfig,
  replyPolicy: ReplyPolicy["Service"],
): Layer.Layer<EmailService, never, EmailServiceDependencies> => Layer.effect(
  EmailService,
  Effect.gen(function*() {
    const contentDigest = yield* ContentDigest
    const identifiers = yield* IdentifierGenerator
    const messageStore = yield* MessageStore
    const outboundPolicy = yield* OutboundPolicy
    const rawArchive = yield* RawMessageArchive
    const routeStore = yield* RouteStore
    const transport = yield* SendTransport
    return EmailService.of({
      send: (command) =>
        sendEmail(command).pipe(
          Effect.provideService(ContentDigest, contentDigest),
          Effect.provideService(IdentifierGenerator, identifiers),
          Effect.provideService(MessageStore, messageStore),
          Effect.provideService(OutboundPolicy, outboundPolicy),
          Effect.provideService(RawMessageArchive, rawArchive),
          Effect.provideService(RouteStore, routeStore),
          Effect.provideService(SendTransport, transport),
          Effect.mapError(mapSendFailure),
        ),
      listMessages: (input) =>
        listMessages(input).pipe(
          Effect.provideService(MessageStore, messageStore),
          Effect.mapError(mapReadFailure),
        ),
      getMessage: (input) =>
        getMessage(input).pipe(
          Effect.provideService(MessageStore, messageStore),
          Effect.mapError(mapReadFailure),
        ),
      readRawMime: (input) =>
        readRawMime(input).pipe(
          Effect.provideService(MessageStore, messageStore),
          Effect.provideService(RawMessageArchive, rawArchive),
          Effect.mapError(mapRawReadFailure),
        ),
      getReceivedContent: (input) =>
        getReceivedContent(input, contentConfig).pipe(
          Effect.provideService(ContentDigest, contentDigest),
          Effect.provideService(MessageStore, messageStore),
          Effect.provideService(RawMessageArchive, rawArchive),
          Effect.mapError(mapReceivedContentFailure),
        ),
      readReceivedAttachment: (input) =>
        readReceivedAttachment(input, contentConfig).pipe(
          Effect.provideService(ContentDigest, contentDigest),
          Effect.provideService(MessageStore, messageStore),
          Effect.provideService(RawMessageArchive, rawArchive),
          Effect.mapError(mapReceivedAttachmentFailure),
        ),
      reply: (command) =>
        replyEmailWithPolicy(command, contentConfig).pipe(
          Effect.provideService(ContentDigest, contentDigest),
          Effect.provideService(IdentifierGenerator, identifiers),
          Effect.provideService(MessageStore, messageStore),
          Effect.provideService(OutboundPolicy, outboundPolicy),
          Effect.provideService(RawMessageArchive, rawArchive),
          Effect.provideService(ReplyPolicy, replyPolicy),
          Effect.provideService(RouteStore, routeStore),
          Effect.provideService(SendTransport, transport),
          Effect.mapError(mapReplyFailure),
        ),
    })
  }),
)

/** Construct EmailService with conservative package defaults. */
export const layer = layerFromParsedConfig(
  defaultReceivedContentConfig,
  conservativeReplyPolicy,
)

/** Construct EmailService with conservative package defaults. */
export function layerWithConfig(): Layer.Layer<
  EmailService,
  never,
  EmailServiceDependencies
>

/** Validate and construct EmailService with an explicit content-read policy. */
export function layerWithConfig(
  contentConfig: ReceivedContentConfig,
): Layer.Layer<
  EmailService,
  InvalidReceivedContentConfig,
  EmailServiceDependencies
>

export function layerWithConfig(
  contentConfig?: ReceivedContentConfig,
): Layer.Layer<
  EmailService,
  InvalidReceivedContentConfig,
  EmailServiceDependencies
> {
  if (contentConfig === undefined) return layer
  return Layer.unwrap(
    parseReceivedContentConfig(contentConfig).pipe(
      Effect.map((parsed) =>
        layerFromParsedConfig(parsed, conservativeReplyPolicy)),
    ),
  )
}

/** Construct EmailService with an explicit host-supplied reply policy. */
export function layerWithReplyPolicy(
  replyPolicy: ReplyPolicy["Service"],
): Layer.Layer<
  EmailService,
  never,
  EmailServiceDependencies
>

/** Validate content-read limits and use an explicit host reply policy. */
export function layerWithReplyPolicy(
  replyPolicy: ReplyPolicy["Service"],
  contentConfig: ReceivedContentConfig,
): Layer.Layer<
  EmailService,
  InvalidReceivedContentConfig,
  EmailServiceDependencies
>

export function layerWithReplyPolicy(
  replyPolicy: ReplyPolicy["Service"],
  contentConfig?: ReceivedContentConfig,
): Layer.Layer<
  EmailService,
  InvalidReceivedContentConfig,
  EmailServiceDependencies
> {
  if (contentConfig === undefined) {
    return layerFromParsedConfig(defaultReceivedContentConfig, replyPolicy)
  }
  return Layer.unwrap(
    parseReceivedContentConfig(contentConfig).pipe(
      Effect.map((parsed) => layerFromParsedConfig(parsed, replyPolicy)),
    ),
  )
}

/** Cursor-paginated request shape accepted by EmailService.listMessages. */
export type { ListMessagesInput }

/** Scoped lookup shape accepted by EmailService.getMessage and readRawMime. */
export type { GetMessageInput }

/** Cursor-paginated result returned by EmailService.listMessages. */
export type { MessagePage }

/** Parsed message and recipient data returned by EmailService.getMessage. */
export type { MessageDetails }

/** Streamed MIME result returned by EmailService.readRawMime. */
export type { RawMime }

/** Bounded policy accepted by EmailService content reads. */
export type { ReceivedContentConfig }

/** Exact attachment bytes and safe metadata returned by EmailService. */
export type { ReceivedAttachmentContent }

/** Typed body, reply metadata, and attachment descriptors for one inbound message. */
export type { ReceivedContent }

/** Scoped received-attachment lookup accepted by EmailService. */
export type { GetReceivedAttachmentInput }

/** Constrained reply command accepted by EmailService.reply. */
export type { ReplyCommand }
