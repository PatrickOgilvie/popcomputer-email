import { describe, expect, test } from "bun:test"
import { DateTime, Result, Schema } from "effect"
import {
  claimForSending,
  failBeforeHandoff,
  isReserved,
  isSending,
  markAccepted,
  markDeliveryUnknown,
  MessageSchema,
  OutboundStateSchema,
  PartialRecipientOutcomesSchema,
  type ReservedOutboundMessage,
} from "../../../src/core/message.js"

const at = (millis: number) => DateTime.makeUnsafe(millis)

const reservedMessage = (): ReservedOutboundMessage => {
  const message = MessageSchema.cases.Outbound.make({
    id: Schema.decodeUnknownSync(
      MessageSchema.cases.Outbound.fields.id,
    )("msg_1"),
    scope: Schema.decodeUnknownSync(
      MessageSchema.cases.Outbound.fields.scope,
    )({ namespace: "tenant:acme", environment: "live" }),
    actor: Schema.decodeUnknownSync(
      MessageSchema.cases.Outbound.fields.actor,
    )({ _tag: "User", id: "user:1" }),
    idempotencyKey: Schema.decodeUnknownSync(
      MessageSchema.cases.Outbound.fields.idempotencyKey,
    )("send:1"),
    requestFingerprint: Schema.decodeUnknownSync(
      MessageSchema.cases.Outbound.fields.requestFingerprint,
    )("a".repeat(64)),
    routeId: Schema.decodeUnknownSync(
      MessageSchema.cases.Outbound.fields.routeId,
    )("route:1"),
    from: Schema.decodeUnknownSync(
      MessageSchema.cases.Outbound.fields.from,
    )("sender@example.com"),
    to: Schema.decodeUnknownSync(
      MessageSchema.cases.Outbound.fields.to,
    )(["recipient@example.com"]),
    cc: [],
    bcc: [],
    subject: "Hello",
    sizeBytes: 120,
    createdAt: at(1_000),
    updatedAt: at(1_000),
    state: OutboundStateSchema.cases.Reserved.make({}),
  })
  if (!isReserved(message)) throw new Error("expected reserved fixture")
  return message
}

describe("outbound message state", () => {
  test("allows one typed reserved to sending transition", () => {
    const sending = claimForSending(reservedMessage(), at(2_000))

    expect(isSending(sending)).toBe(true)
    expect(sending.state._tag).toBe("Sending")
    expect(DateTime.toEpochMillis(sending.updatedAt)).toBe(2_000)
  })

  test("finalizes accepted and ambiguous handoffs explicitly", () => {
    const sending = claimForSending(reservedMessage(), at(2_000))
    const accepted = markAccepted(sending, { sentAt: at(3_000) })
    const unknown = markDeliveryUnknown(sending, {
      occurredAt: at(4_000),
      reason: "timeout",
    })

    expect(accepted.state._tag).toBe("Accepted")
    expect(unknown.state).toEqual(
      OutboundStateSchema.cases.DeliveryUnknown.make({
        occurredAt: at(4_000),
        reason: "timeout",
      }),
    )
  })

  test("keeps pre-handoff failure separate from transport ambiguity", () => {
    const failed = failBeforeHandoff(reservedMessage(), {
      failedAt: at(2_000),
      reason: "archive",
    })
    expect(failed.state._tag).toBe("Failed")
  })

  test("requires both accepted and rejected recipients for partial success", () => {
    const mixed = Schema.decodeUnknownSync(PartialRecipientOutcomesSchema)([
      { _tag: "Accepted", address: "one@example.com" },
      { _tag: "Rejected", address: "two@example.com" },
    ])
    expect(mixed).toHaveLength(2)

    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(PartialRecipientOutcomesSchema)([
          { _tag: "Accepted", address: "one@example.com" },
        ]),
      ),
    ).toBe(true)
  })
})
