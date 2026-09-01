import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import {
  dispatchIdempotencyKey,
  EmailReceivedEventV1Schema,
  isLeased,
  isPending,
  lease,
  markStarted,
  WorkflowAttemptSchema,
  WorkflowEventSchema,
  WorkflowEventStateSchema,
} from "../../../src/core/workflow.js"
import {
  RawMimeDescriptorSchema,
} from "../../../src/core/raw-mime.js"
import {
  RawMessageArchiveFailure,
  type RawMime,
} from "../../../src/adapters/raw-message-archive.js"

const at = (millis: number) => DateTime.makeUnsafe(millis)

describe("workflow email event", () => {
  test("decodes and re-encodes its stable v1 wire contract", () => {
    const encoded = {
      schemaVersion: 1,
      type: "email.received",
      eventId: "workflow-event:1",
      occurredAt: "2026-08-31T10:00:00.000Z",
      scope: { namespace: "tenant:acme", environment: "live" },
      workflowId: "workflow:1",
      message: {
        id: "message:1",
        routeId: "route:1",
        from: "Sender@EXAMPLE.COM",
        to: ["workflow@example.com"],
        subject: "Run workflow",
        sizeBytes: 512,
        receivedAt: "2026-08-31T10:00:00.000Z",
      },
    } as const

    const event = Schema.decodeUnknownSync(EmailReceivedEventV1Schema)(encoded)
    expect(DateTime.isUtc(event.occurredAt)).toBe(true)
    expect(String(event.message.from)).toBe("Sender@example.com")
    expect(Schema.encodeSync(EmailReceivedEventV1Schema)(event)).toEqual({
      ...encoded,
      message: { ...encoded.message, from: "Sender@example.com" },
    })
    expect(dispatchIdempotencyKey(event.eventId)).toBe(
      "email.received:workflow-event:1",
    )
  })

  test("leases a pending event before marking it started", () => {
    const eventPayload = Schema.decodeUnknownSync(
      EmailReceivedEventV1Schema,
    )({
      schemaVersion: 1,
      type: "email.received",
      eventId: "workflow-event:1",
      occurredAt: "2026-08-31T10:00:00.000Z",
      scope: { namespace: "tenant:acme", environment: "live" },
      workflowId: "workflow:1",
      message: {
        id: "message:1",
        routeId: "route:1",
        from: "sender@example.com",
        to: ["workflow@example.com"],
        subject: null,
        sizeBytes: 512,
        receivedAt: "2026-08-31T10:00:00.000Z",
      },
    })
    const event = WorkflowEventSchema.make({
      event: eventPayload,
      state: WorkflowEventStateSchema.cases.Pending.make({
        nextAttemptAt: at(1_000),
      }),
      createdAt: at(1_000),
      updatedAt: at(1_000),
    })
    if (!isPending(event)) throw new Error("expected pending fixture")

    const leased = lease(event, {
      attempt: Schema.decodeUnknownSync(WorkflowAttemptSchema)(1),
      leaseToken: Schema.decodeUnknownSync(
        WorkflowEventStateSchema.cases.Leased.fields.leaseToken,
      )("lease:1"),
      leasedAt: at(2_000),
      leaseExpiresAt: at(62_000),
    })
    expect(isLeased(leased)).toBe(true)

    const started = markStarted(leased, {
      runId: Schema.decodeUnknownSync(
        WorkflowEventStateSchema.cases.Started.fields.runId,
      )("run:1"),
      startedAt: at(3_000),
    })
    expect(started.state._tag).toBe("Started")
  })
})

describe("raw MIME", () => {
  test("keeps archive identity runtime-neutral", () => {
    const descriptor = Schema.decodeUnknownSync(RawMimeDescriptorSchema)({
      scope: { namespace: "tenant:acme", environment: "live" },
      direction: "inbound",
      messageId: "message:1",
      ref: "raw:message:1",
      sha256: "a".repeat(64),
      sizeBytes: 12,
    })
    const raw: RawMime = {
      body: new ReadableStream<Uint8Array>(),
      sizeBytes: descriptor.sizeBytes,
      contentType: "message/rfc822",
    }

    expect(raw.contentType).toBe("message/rfc822")
    expect("key" in raw).toBe(false)
  })

  test("uses a schema-backed safe archive failure", () => {
    const error = new RawMessageArchiveFailure({
      operation: "get",
      reason: "unavailable",
    })
    expect(error._tag).toBe("RawMessageArchiveFailure")
    expect(JSON.stringify(error)).not.toContain("bucket")
  })
})
