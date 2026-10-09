import { Effect, Layer, Option } from "effect"
import {
  RawMessageArchive,
  RawMessageArchiveFailure,
  type PutRawMessageInput,
  type RawMime,
} from "../raw-message-archive.js"
import { RawMessageRefSchema, type RawMessageRef } from "../../core/identifiers.js"

const ReferencePattern = /^r2:([0-9a-f]{64}):([0-9a-f]{64}):([0-9a-z]+)$/u
const FormatVersion = "1"
const DigestMetadata = "popcomputer-sha256"
const SizeMetadata = "popcomputer-size"
const VersionMetadata = "popcomputer-format"

/** Structural R2 object metadata used by the raw-message adapter. */
export interface R2ObjectLike {
  readonly size: number
  readonly etag: string
  readonly customMetadata?: Readonly<Record<string, string>>
}

/** Structural R2 object body used by the raw-message adapter. */
export interface R2ObjectBodyLike extends R2ObjectLike {
  readonly body: ReadableStream<Uint8Array>
}

/** Narrow structural R2 bucket contract accepted at the Cloudflare seam. */
export interface R2BucketLike {
  readonly head: (key: string) => Promise<R2ObjectLike | null>
  readonly get: (key: string) => Promise<R2ObjectBodyLike | null>
  readonly put: (
    key: string,
    value: Uint8Array,
    options: {
      readonly onlyIf: { readonly etagDoesNotMatch: "*" }
      readonly httpMetadata: { readonly contentType: "message/rfc822" }
      readonly customMetadata: Readonly<Record<string, string>>
      readonly sha256: string
    },
  ) => Promise<R2ObjectLike | null>
  readonly delete: (key: string) => Promise<void>
}

interface ParsedReference {
  readonly identityDigest: string
  readonly contentDigest: string
  readonly sizeBytes: number
}

interface PreparedWrite {
  readonly key: string
  readonly ref: RawMessageRef
  readonly contentDigest: string
  readonly sizeBytes: number
}

type ArchiveWriteOperation = "reference" | "put"

const archiveFailure = (
  operation: "reference" | "put" | "get" | "remove",
): RawMessageArchiveFailure =>
  new RawMessageArchiveFailure({ operation, reason: "unavailable" })

const sha256Hex = (
  content: Uint8Array,
  operation: ArchiveWriteOperation,
): Effect.Effect<string, RawMessageArchiveFailure> =>
  Effect.tryPromise({
    try: async () => {
      const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        Uint8Array.from(content),
      )
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("")
    },
    catch: () => archiveFailure(operation),
  })

const identityBytes = (input: PutRawMessageInput): Uint8Array =>
  new TextEncoder().encode([
    FormatVersion,
    input.scope.namespace,
    input.scope.environment,
    input.direction,
    input.messageId,
  ].join("\u0000"))

const KeyPrefixPattern = /^(?:[A-Za-z0-9._-]+\/)*$/u

/** Host-owned key namespace placed in front of every archived object key. */
export interface R2RawMessageArchiveOptions {
  /** Empty, or one or more `segment/` groups such as `tenants/alpha/`. */
  readonly keyPrefix?: string
}

const keyPrefixOf = (options: R2RawMessageArchiveOptions): string => {
  const prefix = options.keyPrefix ?? ""
  if (!KeyPrefixPattern.test(prefix)) {
    throw new Error(
      "R2 raw-message archive keyPrefix must be empty or `segment/` groups",
    )
  }
  return prefix
}

const objectKey = (prefix: string, identityDigest: string): string =>
  `${prefix}email-raw/v1/${identityDigest}`

const rawReference = (
  identityDigest: string,
  contentDigest: string,
  sizeBytes: number,
): RawMessageRef => RawMessageRefSchema.make(
  `r2:${identityDigest}:${contentDigest}:${sizeBytes.toString(36)}`,
)

const parseReference = (
  ref: RawMessageRef,
  operation: "get" | "remove",
): Effect.Effect<ParsedReference, RawMessageArchiveFailure> => {
  const match = ReferencePattern.exec(ref)
  const identityDigest = match?.[1]
  const contentDigest = match?.[2]
  const sizeText = match?.[3]
  if (
    identityDigest === undefined ||
    contentDigest === undefined ||
    sizeText === undefined
  ) {
    return Effect.fail(archiveFailure(operation))
  }
  const sizeBytes = Number.parseInt(sizeText, 36)
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    return Effect.fail(archiveFailure(operation))
  }
  return Effect.succeed({ identityDigest, contentDigest, sizeBytes })
}

const hasExpectedMetadata = (
  object: R2ObjectLike,
  contentDigest: string,
  sizeBytes: number,
): boolean =>
  object.size === sizeBytes &&
  object.customMetadata?.[DigestMetadata] === contentDigest &&
  object.customMetadata?.[SizeMetadata] === String(sizeBytes) &&
  object.customMetadata?.[VersionMetadata] === FormatVersion

const prepareWrite = Effect.fn("Email.Cloudflare.R2.prepareWrite")(
  function*(
    input: PutRawMessageInput,
    operation: ArchiveWriteOperation,
    prefix: string,
  ) {
    const [identityDigest, actualContentDigest] = yield* Effect.all([
      sha256Hex(identityBytes(input), operation),
      sha256Hex(input.content, operation),
    ])
    if (actualContentDigest !== input.sha256) {
      return yield* archiveFailure(operation)
    }
    const sizeBytes = input.content.byteLength
    const prepared: PreparedWrite = {
      key: objectKey(prefix, identityDigest),
      ref: rawReference(identityDigest, input.sha256, sizeBytes),
      contentDigest: input.sha256,
      sizeBytes,
    }
    return prepared
  },
)

/** Build the R2-backed RawMessageArchive service without exposing object keys. */
export const makeR2RawMessageArchive = (
  bucket: R2BucketLike,
  options: R2RawMessageArchiveOptions = {},
): RawMessageArchive["Service"] => {
  const prefix = keyPrefixOf(options)
  const referenceFor = Effect.fn("Email.Cloudflare.R2.referenceFor")(
    function*(input: PutRawMessageInput) {
      return (yield* prepareWrite(input, "reference", prefix)).ref
    },
  )

  const put = Effect.fn("Email.Cloudflare.R2.put")(function*(
    input: PutRawMessageInput,
  ) {
    const prepared = yield* prepareWrite(input, "put", prefix)
    const existing = yield* Effect.tryPromise({
      try: () => bucket.head(prepared.key),
      catch: () => archiveFailure("put"),
    })
    if (existing !== null) {
      if (!hasExpectedMetadata(
        existing,
        prepared.contentDigest,
        prepared.sizeBytes,
      )) {
        return yield* archiveFailure("put")
      }
      return prepared.ref
    }

    const customMetadata = {
      [DigestMetadata]: prepared.contentDigest,
      [SizeMetadata]: String(prepared.sizeBytes),
      [VersionMetadata]: FormatVersion,
    }
    const written = yield* Effect.tryPromise({
      try: () => bucket.put(prepared.key, Uint8Array.from(input.content), {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "message/rfc822" },
        customMetadata,
        sha256: prepared.contentDigest,
      }),
      catch: () => archiveFailure("put"),
    })
    if (written !== null) {
      if (!hasExpectedMetadata(
        written,
        prepared.contentDigest,
        prepared.sizeBytes,
      )) {
        return yield* archiveFailure("put")
      }
      return prepared.ref
    }

    const winner = yield* Effect.tryPromise({
      try: () => bucket.head(prepared.key),
      catch: () => archiveFailure("put"),
    })
    if (
      winner === null ||
      !hasExpectedMetadata(
        winner,
        prepared.contentDigest,
        prepared.sizeBytes,
      )
    ) {
      return yield* archiveFailure("put")
    }
    return prepared.ref
  })

  const get = Effect.fn("Email.Cloudflare.R2.get")(function*(
    ref: RawMessageRef,
  ) {
    const parsed = yield* parseReference(ref, "get")
    const object = yield* Effect.tryPromise({
      try: () => bucket.get(objectKey(prefix, parsed.identityDigest)),
      catch: () => archiveFailure("get"),
    })
    if (object === null) return Option.none<RawMime>()
    if (
      !hasExpectedMetadata(
        object,
        parsed.contentDigest,
        parsed.sizeBytes,
      )
    ) {
      return yield* archiveFailure("get")
    }
    return Option.some<RawMime>({
      body: object.body,
      contentType: "message/rfc822",
      sizeBytes: object.size,
      etag: object.etag,
    })
  })

  const remove = Effect.fn("Email.Cloudflare.R2.remove")(function*(
    ref: RawMessageRef,
  ) {
    const parsed = yield* parseReference(ref, "remove")
    yield* Effect.tryPromise({
      try: () => bucket.delete(objectKey(prefix, parsed.identityDigest)),
      catch: () => archiveFailure("remove"),
    })
  })

  return RawMessageArchive.of({ referenceFor, put, get, remove })
}

/** Provide RawMessageArchive through one structural Cloudflare R2 binding. */
export const r2RawMessageArchiveLayer = (
  bucket: R2BucketLike,
  options: R2RawMessageArchiveOptions = {},
): Layer.Layer<RawMessageArchive> =>
  Layer.succeed(RawMessageArchive, makeR2RawMessageArchive(bucket, options))
