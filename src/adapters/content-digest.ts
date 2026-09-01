import { Context, Effect, Layer, Schema } from "effect"
import { RequestFingerprintSchema, Sha256Schema, type RequestFingerprint, type Sha256 } from "../core/identifiers.js"

/** Cryptographic digest operation that failed. */
export class ContentDigestFailure extends Schema.TaggedError<ContentDigestFailure>()(
  "ContentDigestFailure",
  { reason: Schema.Literal("unavailable") },
) {}

/** Cryptographic digest port used for fingerprints and archive integrity. */
export class ContentDigest extends Context.Service<ContentDigest, {
  readonly sha256: (content: Uint8Array) => Effect.Effect<Sha256, ContentDigestFailure>
  readonly requestFingerprint: (
    content: Uint8Array,
  ) => Effect.Effect<RequestFingerprint, ContentDigestFailure>
}>()("@popcomputer/email/ContentDigest") {}

const digestHex = (content: Uint8Array): Effect.Effect<string, ContentDigestFailure> =>
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
    catch: () => new ContentDigestFailure({ reason: "unavailable" }),
  })

/** Web-Crypto implementation available in modern Node.js and Workers runtimes. */
export const layerWebCrypto: Layer.Layer<ContentDigest> = Layer.succeed(
  ContentDigest,
  ContentDigest.of({
    sha256: (content) => digestHex(content).pipe(Effect.map(Sha256Schema.make)),
    requestFingerprint: (content) =>
      digestHex(content).pipe(Effect.map(RequestFingerprintSchema.make)),
  }),
)
