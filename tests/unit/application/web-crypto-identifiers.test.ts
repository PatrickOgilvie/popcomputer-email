import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { IdentifierGenerator } from "../../../src/adapters/identifier-generator.js"
import { RouteHandleGenerator } from "../../../src/adapters/route-handle-generator.js"
import { webCryptoIdentity } from "../../../src/adapters/web-crypto-identifiers.js"

describe("Web Crypto production generators", () => {
  test("generate distinct schema-safe identities and mailbox handles", async () => {
    const generated = await Effect.runPromise(Effect.gen(function*() {
      const identifiers = yield* IdentifierGenerator
      const handles = yield* RouteHandleGenerator
      return {
        messages: [yield* identifiers.messageId, yield* identifiers.messageId],
        recipient: yield* identifiers.recipientId,
        route: yield* identifiers.routeId,
        testRecipient: yield* identifiers.testRecipientId,
        workflowEvent: yield* identifiers.workflowEventId,
        lease: yield* identifiers.leaseToken,
        handles: [yield* handles.next, yield* handles.next],
      }
    }).pipe(Effect.provide(webCryptoIdentity)))

    expect(generated.messages[0]).not.toBe(generated.messages[1])
    expect(generated.handles[0]).not.toBe(generated.handles[1])
    expect(generated.messages[0]).toStartWith("message:")
    expect(generated.recipient).toStartWith("recipient:")
    expect(generated.route).toStartWith("route:")
    expect(generated.testRecipient).toStartWith("test-recipient:")
    expect(generated.workflowEvent).toStartWith("workflow-event:")
    expect(generated.lease).toStartWith("lease:")
    expect(generated.handles[0]).toStartWith("mail-")
  })
})
