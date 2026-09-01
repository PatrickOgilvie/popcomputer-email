import { Effect, Option, Schema } from "effect"
import {
  MessageStore,
  type GetMessageInput,
  type ListMessagesInput,
  type MessageStoreFailure,
  type StoredMessage,
} from "../adapters/message-store.js"
import {
  RawMessageArchive,
  type RawMessageArchiveFailure,
  type RawMime,
} from "../adapters/raw-message-archive.js"
import { MessageIdSchema } from "../core/identifiers.js"
import type { InvalidPageRequest, PageCursor } from "../core/identifiers.js"
import {
  type InvalidStoredMessage,
  type Message,
  type MessageRecipient,
  MessageNotFound,
} from "../core/message.js"

/** Parsed message data and persisted recipient delivery state safe for reads. */
export interface MessageDetails {
  readonly message: Message
  readonly recipients: ReadonlyArray<MessageRecipient>
}

/** One cursor-paginated page of parsed message details. */
export interface MessagePage {
  readonly items: ReadonlyArray<MessageDetails>
  readonly nextCursor: Option.Option<PageCursor>
}

const toMessageDetails = (stored: StoredMessage): MessageDetails => ({
  message: stored.message,
  recipients: stored.recipients,
})

/** A message exists but has no readable raw MIME archive object. */
export class ArchivedMimeNotFound extends Schema.TaggedError<ArchivedMimeNotFound>()(
  "ArchivedMimeNotFound",
  {
    messageId: MessageIdSchema,
    reason: Schema.Literals(["not_archived", "archive_object_missing"]),
  },
) {}

/** Typed failures produced by the internal message-read workflow. */
export type ReadEmailFailure =
  | InvalidPageRequest
  | InvalidStoredMessage
  | MessageNotFound
  | MessageStoreFailure

/** Typed failures produced while streaming archived raw MIME. */
export type ReadRawMimeFailure =
  | ArchivedMimeNotFound
  | InvalidStoredMessage
  | MessageNotFound
  | MessageStoreFailure
  | RawMessageArchiveFailure

/** List one cursor-paginated page of messages in a caller scope. */
export const listMessages = Effect.fn("Email.listMessages")(function*(
  input: ListMessagesInput,
): Effect.fn.Return<MessagePage, ReadEmailFailure, MessageStore> {
  const store = yield* MessageStore
  const page = yield* store.list(input)
  return {
    items: page.items.map(toMessageDetails),
    nextCursor: page.nextCursor,
  }
})

/** Read one parsed message and its recipients without archive metadata. */
export const getMessage = Effect.fn("Email.getMessage")(function*(
  input: GetMessageInput,
): Effect.fn.Return<MessageDetails, ReadEmailFailure, MessageStore> {
  const store = yield* MessageStore
  const stored = yield* store.get(input)
  if (Option.isNone(stored)) {
    return yield* new MessageNotFound({
      messageId: input.messageId,
      reason: "not_found",
    })
  }
  return toMessageDetails(stored.value)
})

/** Read raw MIME as a Web stream while keeping provider handles private. */
export const readRawMime = Effect.fn("Email.readRawMime")(function*(
  input: GetMessageInput,
): Effect.fn.Return<RawMime, ReadRawMimeFailure, MessageStore | RawMessageArchive> {
  const store = yield* MessageStore
  const archive = yield* RawMessageArchive
  const stored = yield* store.get(input)
  if (Option.isNone(stored)) {
    return yield* new MessageNotFound({
      messageId: input.messageId,
      reason: "not_found",
    })
  }
  if (Option.isNone(stored.value.raw)) {
    return yield* new ArchivedMimeNotFound({
      messageId: input.messageId,
      reason: "not_archived",
    })
  }
  const raw = yield* archive.get(stored.value.raw.value.ref)
  if (Option.isNone(raw)) {
    return yield* new ArchivedMimeNotFound({
      messageId: input.messageId,
      reason: "archive_object_missing",
    })
  }
  return raw.value
})
