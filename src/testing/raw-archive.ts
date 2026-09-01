import { Effect, Layer, Option } from "effect"
import {
  RawMessageArchive,
  RawMessageArchiveFailure,
} from "../adapters/raw-message-archive.js"
import { RawMessageRefSchema } from "../core/identifiers.js"

interface StoredRaw {
  readonly content: Uint8Array
  readonly sha256: string
}

/** Inspectable in-memory raw MIME archive. */
export interface InMemoryRawArchive {
  readonly service: RawMessageArchive["Service"]
  readonly objects: ReadonlyMap<string, Uint8Array>
  readonly layer: Layer.Layer<RawMessageArchive>
}

/** Create an isolated archive honoring idempotent same-key writes. */
export const makeInMemoryRawArchive = (): InMemoryRawArchive => {
  const records = new Map<string, StoredRaw>()
  const referenceFor = (input: {
    readonly scope: import("../core/scope.js").Scope
    readonly direction: import("../core/message.js").Direction
    readonly messageId: import("../core/identifiers.js").MessageId
  }) => RawMessageRefSchema.make(
    `${input.scope.namespace}:${input.scope.environment}:${input.direction}:${input.messageId}`,
  )
  const service = RawMessageArchive.of({
    referenceFor: (input) => Effect.succeed(referenceFor(input)),
    put: (input) => Effect.gen(function*() {
      const ref = referenceFor(input)
      const existing = records.get(ref)
      if (existing !== undefined && existing.sha256 !== input.sha256) {
        return yield* new RawMessageArchiveFailure({
          operation: "put",
          reason: "unavailable",
        })
      }
      if (existing === undefined) {
        records.set(ref, {
          content: Uint8Array.from(input.content),
          sha256: input.sha256,
        })
      }
      return ref
    }),
    get: (ref) => Effect.sync(() => {
      const found = records.get(ref)
      if (found === undefined) return Option.none()
      const content = Uint8Array.from(found.content)
      return Option.some({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(content)
            controller.close()
          },
        }),
        contentType: "message/rfc822" as const,
        sizeBytes: content.byteLength,
      })
    }),
    remove: (ref) => Effect.sync(() => {
      records.delete(ref)
    }),
  })
  return {
    service,
    get objects() {
      return new Map(
        Array.from(records, ([key, value]) => [
          key,
          Uint8Array.from(value.content),
        ]),
      )
    },
    layer: Layer.succeed(RawMessageArchive, service),
  }
}
