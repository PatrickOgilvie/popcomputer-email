import { Effect, Option, Result } from "effect"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { makeR2RawMessageArchive } from "../../src/adapters/cloudflare/r2-raw-message-archive.js"
import {
  MessageIdSchema,
  NamespaceSchema,
  Sha256Schema,
} from "../../src/core/identifiers.js"
import { ScopeSchema } from "../../src/core/scope.js"

let fixtureSequence = 0

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

const digest = async (content: Uint8Array): Promise<string> => {
  const value = await crypto.subtle.digest("SHA-256", Uint8Array.from(content))
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

const readStream = async (
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> => new Uint8Array(await new Response(stream).arrayBuffer())

const fixture = async (content: Uint8Array) => {
  const suffix = `r2-${fixtureSequence++}`
  const scope = ScopeSchema.make({
    namespace: NamespaceSchema.make(`namespace-${suffix}`),
    environment: "test",
  })
  return {
    scope,
    direction: "inbound" as const,
    messageId: MessageIdSchema.make(`message-${suffix}`),
    content,
    sha256: Sha256Schema.make(await digest(content)),
  }
}

describe("R2 raw-message archive", () => {
  it("stores idempotently under an opaque key and streams exact MIME bytes", async () => {
    const archive = makeR2RawMessageArchive(env.EMAIL_RAW)
    const input = await fixture(bytes(
      "From: sender@example.com\r\nTo: inbox@example.com\r\n\r\nhello\r\n",
    ))

    const reserved = await Effect.runPromise(archive.referenceFor(input))
    const [first, replay] = await Promise.all([
      Effect.runPromise(archive.put(input)),
      Effect.runPromise(archive.put(input)),
    ])
    expect(first).toBe(reserved)
    expect(replay).toBe(first)

    const listed = await env.EMAIL_RAW.list({
      prefix: "email-raw/v1/",
      include: ["customMetadata"],
    })
    const object = listed.objects.find((candidate) =>
      candidate.customMetadata?.["popcomputer-sha256"] === input.sha256
    )
    expect(object).toBeDefined()
    expect(object?.key).toMatch(/^email-raw\/v1\/[0-9a-f]{64}$/u)
    expect(object?.key).not.toContain(input.scope.namespace)
    expect(object?.key).not.toContain(input.messageId)

    const loaded = await Effect.runPromise(archive.get(first))
    expect(Option.isSome(loaded)).toBe(true)
    if (Option.isSome(loaded)) {
      expect(loaded.value.contentType).toBe("message/rfc822")
      expect(loaded.value.sizeBytes).toBe(input.content.byteLength)
      expect(await readStream(loaded.value.body)).toEqual(input.content)
    }

    await Effect.runPromise(archive.remove(first))
    expect(Option.isNone(await Effect.runPromise(archive.get(first)))).toBe(true)
  })

  it("refuses a conflicting replay without replacing the original object", async () => {
    const archive = makeR2RawMessageArchive(env.EMAIL_RAW)
    const original = await fixture(bytes("original MIME"))
    const conflictingContent = bytes("different MIME")
    const conflict = {
      ...original,
      content: conflictingContent,
      sha256: Sha256Schema.make(await digest(conflictingContent)),
    }

    const ref = await Effect.runPromise(archive.put(original))
    const attempted = await Effect.runPromise(Effect.result(
      archive.put(conflict),
    ))
    expect(Result.isFailure(attempted)).toBe(true)

    const loaded = await Effect.runPromise(archive.get(ref))
    expect(Option.isSome(loaded)).toBe(true)
    if (Option.isSome(loaded)) {
      expect(await readStream(loaded.value.body)).toEqual(original.content)
    }
    await Effect.runPromise(archive.remove(ref))
  })

  it("rejects content whose claimed digest does not match its bytes", async () => {
    const archive = makeR2RawMessageArchive(env.EMAIL_RAW)
    const input = await fixture(bytes("digest checked MIME"))
    const before = await env.EMAIL_RAW.list({ prefix: "email-raw/v1/" })
    const attempted = await Effect.runPromise(Effect.result(archive.put({
      ...input,
      sha256: Sha256Schema.make("f".repeat(64)),
    })))

    expect(Result.isFailure(attempted)).toBe(true)
    const after = await env.EMAIL_RAW.list({ prefix: "email-raw/v1/" })
    expect(after.objects.map((object) => object.key))
      .toEqual(before.objects.map((object) => object.key))
  })
})

describe("R2 raw-message archive key prefix", () => {
  it("prefixes every object key when a keyPrefix is configured", async () => {
    const archive = makeR2RawMessageArchive(env.EMAIL_RAW, {
      keyPrefix: "tenants/alpha/",
    })
    const input = await fixture(bytes("Subject: prefixed\r\n\r\nbody\r\n"))

    const reference = await Effect.runPromise(archive.referenceFor(input))
    await Effect.runPromise(archive.put(input))

    const listed = await env.EMAIL_RAW.list({
      prefix: "tenants/alpha/email-raw/v1/",
    })
    expect(listed.objects).toHaveLength(1)

    const read = await Effect.runPromise(archive.get(reference))
    expect(Option.isSome(read)).toBe(true)

    await Effect.runPromise(archive.remove(reference))
    const removed = await env.EMAIL_RAW.list({
      prefix: "tenants/alpha/email-raw/v1/",
    })
    expect(removed.objects).toHaveLength(0)
  })
})
