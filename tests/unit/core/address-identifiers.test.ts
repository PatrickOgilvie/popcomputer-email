import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import {
  domain,
  EmailAddressSchema,
  EmailDomainSchema,
  InvalidEmailAddress,
  localPart,
  MailboxHandleSchema,
  parse,
} from "../../../src/core/address.js"
import {
  IdempotencyKeySchema,
  MessageIdSchema,
  RequestFingerprintSchema,
  Sha256Schema,
} from "../../../src/core/identifiers.js"
import { InboundProviderDeliverySchema } from "../../../src/core/inbound-delivery.js"

describe("email address", () => {
  test("preserves the local part and canonicalizes the domain", () => {
    const address = Schema.decodeUnknownSync(EmailAddressSchema)(
      "Case.Sensitive+tag@EXAMPLE.COM",
    )

    expect(String(address)).toBe("Case.Sensitive+tag@example.com")
    expect(localPart(address)).toBe("Case.Sensitive+tag")
    expect(String(domain(address))).toBe("example.com")
    expect(
      String(Schema.decodeUnknownSync(EmailDomainSchema)("MAIL.Example.COM")),
    ).toBe("mail.example.com")
  })

  test("rejects malformed local parts and domains", async () => {
    const malformed = [
      "missing-at.example.com",
      ".starts-with-dot@example.com",
      "two..dots@example.com",
      "user@-example.com",
      "user@example..com",
      "user name@example.com",
    ]

    for (const input of malformed) {
      const result = await Effect.runPromise(Effect.result(parse(input)))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(InvalidEmailAddress)
        expect(JSON.stringify(result.failure)).not.toContain(input)
      }
    }
  })

  test("canonicalizes mailbox handles", () => {
    expect(
      String(Schema.decodeUnknownSync(MailboxHandleSchema)("Product.Alerts")),
    ).toBe("product.alerts")
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(MailboxHandleSchema)("bad..handle"),
      ),
    ).toBe(true)
  })
})

describe("identifiers", () => {
  test("keeps opaque identities distinct and bounded", () => {
    expect(String(Schema.decodeUnknownSync(MessageIdSchema)("msg_123"))).toBe(
      "msg_123",
    )
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(MessageIdSchema)("contains spaces"),
      ),
    ).toBe(true)
    expect(
      String(
        Schema.decodeUnknownSync(IdempotencyKeySchema)("send:request-1"),
      ),
    ).toBe("send:request-1")
  })

  test("requires lowercase fixed-width SHA-256 values", () => {
    const digest = "a".repeat(64)
    expect(String(Schema.decodeUnknownSync(Sha256Schema)(digest))).toBe(digest)
    expect(
      String(Schema.decodeUnknownSync(RequestFingerprintSchema)(digest)),
    ).toBe(digest)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(Sha256Schema)("A".repeat(64)),
      ),
    ).toBe(true)
  })

  test("requires canonical provider delivery identities", () => {
    const delivery = Schema.decodeUnknownSync(InboundProviderDeliverySchema)({
      provider: "example-provider",
      deliveryId: "delivery/123",
    })

    expect(String(delivery.provider)).toBe("example-provider")
    expect(String(delivery.deliveryId)).toBe("delivery/123")
    expect(Result.isFailure(
      Schema.decodeUnknownResult(InboundProviderDeliverySchema)({
        provider: "Example-Provider",
        deliveryId: "delivery/123",
      }),
    )).toBe(true)
    expect(Result.isFailure(
      Schema.decodeUnknownResult(InboundProviderDeliverySchema)({
        provider: "example-provider",
        deliveryId: "delivery\n123",
      }),
    )).toBe(true)
  })
})
