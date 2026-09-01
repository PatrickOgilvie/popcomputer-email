import { Context, Effect, Option, Schema } from "effect"
import type { MessageId, RawMessageRef, Sha256 } from "../core/identifiers.js"
import type { Direction } from "../core/message.js"
import type { Scope } from "../core/scope.js"

/** Raw-archive operation that failed. */
export const RawMessageArchiveOperationSchema = Schema.Literals([
  "reference",
  "put",
  "get",
  "remove",
])

/** Raw-archive operation that failed. */
export type RawMessageArchiveOperation = typeof RawMessageArchiveOperationSchema.Type

/** The configured raw MIME archive could not complete an operation. */
export class RawMessageArchiveFailure extends Schema.TaggedError<RawMessageArchiveFailure>()(
  "RawMessageArchiveFailure",
  {
    operation: RawMessageArchiveOperationSchema,
    reason: Schema.Literal("unavailable"),
  },
) {}

/** Input for archiving canonical raw MIME under a package-owned key. */
export interface PutRawMessageInput {
  readonly scope: Scope
  readonly direction: Direction
  readonly messageId: MessageId
  readonly content: Uint8Array
  readonly sha256: Sha256
}

/** Streamed raw MIME returned without leaking provider object handles. */
export interface RawMime {
  readonly body: ReadableStream<Uint8Array>
  readonly contentType: "message/rfc822"
  readonly sizeBytes: number
  readonly etag?: string
}

/** Durable archive port for package-owned raw MIME bytes. */
export class RawMessageArchive extends Context.Service<RawMessageArchive, {
  readonly referenceFor: (
    input: PutRawMessageInput,
  ) => Effect.Effect<RawMessageRef, RawMessageArchiveFailure>
  readonly put: (
    input: PutRawMessageInput,
  ) => Effect.Effect<RawMessageRef, RawMessageArchiveFailure>
  readonly get: (
    ref: RawMessageRef,
  ) => Effect.Effect<Option.Option<RawMime>, RawMessageArchiveFailure>
  readonly remove: (
    ref: RawMessageRef,
  ) => Effect.Effect<void, RawMessageArchiveFailure>
}>()("@popcomputer/email/RawMessageArchive") {}
