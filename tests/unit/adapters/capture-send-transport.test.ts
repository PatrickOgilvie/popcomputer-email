import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { EmailAddressSchema } from "../../../src/core/address.js"
import { MessageIdSchema, NamespaceSchema } from "../../../src/core/identifiers.js"
import { ScopeSchema } from "../../../src/core/scope.js"
import { makeCaptureSendTransport } from "../../../src/adapters/capture-send-transport.js"

describe("capture send transport", () => {
  it("passes preflight and captures every send", async () => {
    const transport = makeCaptureSendTransport()
    const scope = ScopeSchema.make({
      namespace: NamespaceSchema.make("workspace-1"),
      environment: "live",
    })
    const from = EmailAddressSchema.make("sender@example.com")
    await Effect.runPromise(
      transport.preflight({ scope, from, recipientCount: 1, sizeBytes: 12 }),
    )
    const result = await Effect.runPromise(transport.send({
      scope,
      messageId: MessageIdSchema.make("message-1"),
      from,
      to: [EmailAddressSchema.make("to@example.com")],
      cc: [],
      bcc: [],
      rawMime: new TextEncoder().encode("Subject: hi\r\n\r\nbody"),
    }))
    expect(result).toEqual({ _tag: "Captured" })
  })
})
