import { DateTime } from "effect"
import { domain, type EmailAddress } from "../core/address.js"
import type {
  Attachment,
  Body,
  OutboundAutomation,
  SendCommand,
} from "../core/email-command.js"
import type { MessageId } from "../core/identifiers.js"
import type { ThreadMessageId } from "../core/threading.js"

const Base64Alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

const encodeBase64 = (bytes: Uint8Array): string => {
  let encoded = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1] ?? 0
    const third = bytes[index + 2] ?? 0
    const value = (first << 16) | (second << 8) | third
    encoded += Base64Alphabet[(value >>> 18) & 63]
    encoded += Base64Alphabet[(value >>> 12) & 63]
    encoded += index + 1 < bytes.length
      ? Base64Alphabet[(value >>> 6) & 63]
      : "="
    encoded += index + 2 < bytes.length ? Base64Alphabet[value & 63] : "="
  }
  return encoded
}

const wrapBase64 = (encoded: string): string => {
  const lines: Array<string> = []
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76))
  }
  return lines.join("\r\n")
}

const encodeWords = (value: string): string => {
  const encoded = encodeBase64(new TextEncoder().encode(value))
  const words: Array<string> = []
  for (let index = 0; index < encoded.length; index += 60) {
    words.push(`=?UTF-8?B?${encoded.slice(index, index + 60)}?=`)
  }
  return words.join("\r\n ")
}

const renderHeaderValue = (value: string): string =>
  /^[\x20-\x7e]*$/u.test(value) && value.length <= 70
    ? value
    : encodeWords(value)

const safeBoundaryFragment = (messageId: MessageId): string =>
  messageId.replaceAll(/[^A-Za-z0-9._-]/gu, "_")

const renderTextEntity = (
  mediaType: "text/plain" | "text/html",
  content: string,
): string => [
  `Content-Type: ${mediaType}; charset=UTF-8`,
  "Content-Transfer-Encoding: base64",
  "",
  wrapBase64(encodeBase64(new TextEncoder().encode(content))),
].join("\r\n")

const renderBodyEntity = (body: Body, messageId: MessageId): string => {
  switch (body._tag) {
    case "Empty":
      return renderTextEntity("text/plain", "")
    case "Text":
      return renderTextEntity("text/plain", body.text)
    case "Html":
      return renderTextEntity("text/html", body.html)
    case "Multipart": {
      const boundary = `=_popcomputer_${safeBoundaryFragment(messageId)}_alternative`
      return [
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        renderTextEntity("text/plain", body.text),
        `--${boundary}`,
        renderTextEntity("text/html", body.html),
        `--${boundary}--`,
      ].join("\r\n")
    }
  }
}

const quoteParameter = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')

const asciiFilename = (filename: string): string => {
  const fallback = filename.replaceAll(/[^\x20-\x7e]/gu, "_")
  return fallback.length > 0 ? fallback : "attachment"
}

const renderAttachmentEntity = (attachment: Attachment): string => {
  const disposition = attachment.disposition
  const filename = quoteParameter(asciiFilename(attachment.filename))
  const encodedFilename = encodeURIComponent(attachment.filename)
  const contentDisposition =
    `Content-Disposition: ${disposition}; filename="${filename}"; filename*=UTF-8''${encodedFilename}`
  const headers = [
    `Content-Type: ${attachment.mediaType}`,
    "Content-Transfer-Encoding: base64",
    contentDisposition,
  ]
  if (attachment.contentId !== undefined) {
    headers.push(`Content-ID: <${attachment.contentId}>`)
  }
  return [
    ...headers,
    "",
    wrapBase64(encodeBase64(attachment.content)),
  ].join("\r\n")
}

const renderContent = (command: SendCommand, messageId: MessageId): string => {
  const body = renderBodyEntity(command.body, messageId)
  if (command.attachments.length === 0) return body

  const boundary = `=_popcomputer_${safeBoundaryFragment(messageId)}_mixed`
  const parts = [body, ...command.attachments.map(renderAttachmentEntity)]
  return [
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...parts.flatMap((part) => [`--${boundary}`, part]),
    `--${boundary}--`,
  ].join("\r\n")
}

const formatDate = (dateTime: DateTime.Utc): string =>
  DateTime.toDateUtc(dateTime).toUTCString().replace("GMT", "+0000")

const renderMessageId = (messageId: MessageId, from: EmailAddress): string => {
  const local = safeBoundaryFragment(messageId)
  return `<${local}@${domain(from)}>`
}

const renderReferences = (
  references: readonly [ThreadMessageId, ...Array<ThreadMessageId>],
): string => {
  const lines: Array<string> = []
  let current = "References:"
  for (const reference of references) {
    if (current.length + reference.length + 1 <= 78) {
      current += ` ${reference}`
      continue
    }
    lines.push(current)
    current = ` ${reference}`
  }
  lines.push(current)
  return lines.join("\r\n")
}

const renderAutomationHeaders = (
  automation: OutboundAutomation | undefined,
): ReadonlyArray<string> => {
  if (automation === undefined) return []
  const autoSubmitted = automation === "auto_reply"
    ? "auto-replied"
    : "auto-generated"
  return [
    `Auto-Submitted: ${autoSubmitted}`,
    "X-Auto-Response-Suppress: All",
  ]
}

/** Complete deterministic input required to render canonical outbound MIME. */
export interface RenderMimeInput {
  readonly messageId: MessageId
  readonly createdAt: DateTime.Utc
  readonly from: EmailAddress
  readonly command: SendCommand
}

/** Render deterministic RFC 5322/MIME bytes without adding a Bcc header. */
export const renderMime = (input: RenderMimeInput): Uint8Array => {
  const { command } = input
  const headers = [
    `Date: ${formatDate(input.createdAt)}`,
    `Message-ID: ${renderMessageId(input.messageId, input.from)}`,
    `From: ${input.from}`,
    `To: ${command.to.join(", ")}`,
    ...(command.cc.length > 0 ? [`Cc: ${command.cc.join(", ")}`] : []),
    `Subject: ${renderHeaderValue(command.subject)}`,
    ...(command.threading === undefined
      ? []
      : [
          `In-Reply-To: ${command.threading.inReplyTo}`,
          renderReferences(command.threading.references),
        ]),
    ...renderAutomationHeaders(command.automation),
    "MIME-Version: 1.0",
    ...command.headers.map(
      (header) => `${header.name}: ${renderHeaderValue(header.value)}`,
    ),
  ]
  const message = [...headers, renderContent(command, input.messageId), ""].join(
    "\r\n",
  )
  return new TextEncoder().encode(message)
}
