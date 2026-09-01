import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { ActorSchema } from "../../../src/core/actor.js"
import {
  BodySchema,
  CustomHeaderNameSchema,
  InvalidEmailCommand,
  parseSendCommand,
  SendCommandSchema,
} from "../../../src/core/email-command.js"
import { TestScopeSchema } from "../../../src/core/scope.js"

const validCommand = {
  scope: { namespace: "tenant:acme", environment: "test" },
  actor: { _tag: "Credential", id: "credential:sender" },
  idempotencyKey: "send:welcome-1",
  from: { _tag: "DefaultRoute" },
  to: ["Member@EXAMPLE.COM"],
  cc: [],
  bcc: [],
  subject: "Welcome",
  body: { _tag: "Multipart", text: "Hello", html: "<p>Hello</p>" },
  headers: [{ name: "X-Campaign", value: "welcome" }],
  attachments: [],
} as const

describe("send command", () => {
  test("parses the complete boundary and normalizes nested addresses", () => {
    const command = Schema.decodeUnknownSync(SendCommandSchema)(validCommand, {
      onExcessProperty: "error",
    })

    expect(command.to.map(String)).toEqual(["Member@example.com"])
    expect(command.actor).toEqual(
      ActorSchema.cases.Credential.make({ id: command.actor.id }),
    )
    expect(
      BodySchema.match(command.body, {
        Empty: () => "empty",
        Text: () => "text",
        Html: () => "html",
        Multipart: () => "multipart",
      }),
    ).toBe("multipart")
  })

  test("rejects routing and MIME headers controlled by the package", async () => {
    for (const name of [
      "From",
      "to",
      "Content-Type",
      "Message-ID",
      "Auto-Submitted",
      "X-Auto-Response-Suppress",
    ]) {
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(CustomHeaderNameSchema)(name),
        ),
      ).toBe(true)
    }

    const secret = "private-message-body"
    const result = await Effect.runPromise(
      Effect.result(
        parseSendCommand({
          ...validCommand,
          body: { _tag: "Text", text: secret },
          headers: [{ name: "Subject", value: "override" }],
        }),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InvalidEmailCommand)
      expect(JSON.stringify(result.failure)).not.toContain(secret)
    }
  })

  test("makes test-only scope illegal in live mode", () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(TestScopeSchema)({
          namespace: "tenant:acme",
          environment: "live",
        }),
      ),
    ).toBe(true)
  })
})
