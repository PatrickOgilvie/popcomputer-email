import { Effect } from "effect"
import { ContentDigest } from "../adapters/content-digest.js"
import type {
  Attachment,
  Body,
  SendCommand,
} from "../core/email-command.js"
import type {
  RequestFingerprint,
  Sha256,
} from "../core/identifiers.js"
import type { ReplyCommand } from "../core/reply-command.js"

const encoder = new TextEncoder()

interface CanonicalEmptyBody {
  readonly _tag: "Empty"
}

interface CanonicalTextBody {
  readonly _tag: "Text"
  readonly text: string
}

interface CanonicalHtmlBody {
  readonly _tag: "Html"
  readonly html: string
}

interface CanonicalMultipartBody {
  readonly _tag: "Multipart"
  readonly text: string
  readonly html: string
}

type CanonicalBody =
  | CanonicalEmptyBody
  | CanonicalHtmlBody
  | CanonicalMultipartBody
  | CanonicalTextBody

interface CanonicalAttachment {
  readonly filename: string
  readonly mediaType: string
  readonly disposition: "attachment" | "inline"
  readonly contentId?: string
  readonly sha256: Sha256
}

const canonicalBody = (body: Body): CanonicalBody => {
  switch (body._tag) {
    case "Empty":
      return { _tag: "Empty" }
    case "Text":
      return { _tag: "Text", text: body.text }
    case "Html":
      return { _tag: "Html", html: body.html }
    case "Multipart":
      return { _tag: "Multipart", text: body.text, html: body.html }
  }
}

const canonicalAttachment = (
  attachment: Attachment,
  sha256: Sha256,
): CanonicalAttachment => {
  const base = {
    filename: attachment.filename,
    mediaType: attachment.mediaType,
    disposition: attachment.disposition,
    sha256,
  }
  return attachment.contentId === undefined
    ? base
    : { ...base, contentId: attachment.contentId }
}

const canonicalAttachments = Effect.fn(
  "Email.outboundFingerprint.attachments",
)(function*(attachments: ReadonlyArray<Attachment>) {
  const digest = yield* ContentDigest
  return yield* Effect.forEach(
    attachments,
    (attachment) =>
      digest.sha256(attachment.content).pipe(
        Effect.map((sha256) => canonicalAttachment(attachment, sha256)),
      ),
  )
})

/** Fingerprint every caller-owned field of one direct send mutation. */
export const fingerprintSendCommand = Effect.fn(
  "Email.outboundFingerprint.send",
)(function*(command: SendCommand): Effect.fn.Return<
  RequestFingerprint,
  import("../adapters/content-digest.js").ContentDigestFailure,
  ContentDigest
> {
  const digest = yield* ContentDigest
  const attachments = yield* canonicalAttachments(command.attachments)
  const canonical = {
    version: 3,
    kind: "send",
    from: command.from._tag === "DefaultRoute"
      ? { _tag: "DefaultRoute" }
      : { _tag: "Route", routeId: command.from.routeId },
    to: Array.from(command.to),
    cc: Array.from(command.cc),
    bcc: Array.from(command.bcc),
    subject: command.subject,
    body: canonicalBody(command.body),
    headers: command.headers.map((header) => ({
      name: header.name,
      value: header.value,
    })),
    attachments,
    threading: command.threading === undefined
      ? null
      : {
          inReplyTo: command.threading.inReplyTo,
          references: Array.from(command.threading.references),
        },
    automation: command.automation ?? null,
  }
  return yield* digest.requestFingerprint(
    encoder.encode(JSON.stringify(canonical)),
  )
})

/**
 * Fingerprint caller-owned reply intent before source MIME is read.
 *
 * Derived route, recipient, subject, and threading are tied to the immutable
 * source message identity and therefore intentionally absent.
 */
export const fingerprintReplyCommand = Effect.fn(
  "Email.outboundFingerprint.reply",
)(function*(command: ReplyCommand): Effect.fn.Return<
  RequestFingerprint,
  import("../adapters/content-digest.js").ContentDigestFailure,
  ContentDigest
> {
  const digest = yield* ContentDigest
  const attachments = yield* canonicalAttachments(command.attachments)
  const canonical = {
    version: 1,
    kind: "reply",
    sourceMessageId: command.sourceMessageId,
    body: canonicalBody(command.body),
    headers: command.headers.map((header) => ({
      name: header.name,
      value: header.value,
    })),
    attachments,
  }
  return yield* digest.requestFingerprint(
    encoder.encode(JSON.stringify(canonical)),
  )
})
