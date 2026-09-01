import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import {
  disable,
  isActive,
  isDisabled,
  isPaused,
  isSendable,
  pause,
  resume,
  RouteLifecycleSchema,
  RouteSchema,
  type ActiveRoute,
} from "../../../src/core/route.js"
import {
  isFailed,
  isPending,
  isVerified,
  markFailed,
  markVerified,
  refresh,
  TestRecipientSchema,
  TestRecipientStateSchema,
  type PendingTestRecipient,
} from "../../../src/core/test-recipient.js"

const at = (millis: number) => DateTime.makeUnsafe(millis)

const activeInbox = (): ActiveRoute => {
  const route = Schema.decodeUnknownSync(RouteSchema)({
    id: "route:inbox",
    scope: { namespace: "tenant:acme", environment: "live" },
    address: "inbox@example.com",
    mailboxHandle: "inbox",
    inbound: { _tag: "Store" },
    outbound: { _tag: "Sender", role: "default" },
    lifecycle: { _tag: "Active" },
    revision: 1,
    actor: { _tag: "System", id: "system:provisioner" },
    createdAt: at(1_000),
    updatedAt: at(1_000),
  })
  if (!isActive(route)) throw new Error("expected active fixture")
  return route
}

const pendingRecipient = (): PendingTestRecipient => {
  const recipient = Schema.decodeUnknownSync(TestRecipientSchema)({
    id: "test-recipient:1",
    scope: { namespace: "tenant:acme", environment: "test" },
    destinationId: "destination:1",
    address: "member@example.com",
    actor: { _tag: "User", id: "user:1" },
    state: { _tag: "Pending", requestedAt: at(1_000) },
    createdAt: at(1_000),
    updatedAt: at(1_000),
  })
  if (!isPending(recipient)) throw new Error("expected pending fixture")
  return recipient
}

describe("route lifecycle", () => {
  test("pauses, resumes, and permanently disables through legal sources", () => {
    const route = activeInbox()
    const paused = pause(route, at(2_000))
    expect(isPaused(paused)).toBe(true)
    expect(isSendable(paused)).toBe(false)

    const resumed = resume(paused, at(3_000))
    expect(isSendable(resumed)).toBe(true)

    const disabled = disable(resumed, at(4_000))
    expect(isDisabled(disabled)).toBe(true)
    expect(disabled.address).toBe(route.address)
  })

  test("treats inbound and outbound capabilities independently", () => {
    const workflowRoute = Schema.decodeUnknownSync(RouteSchema)({
      id: "route:workflow",
      scope: { namespace: "tenant:acme", environment: "live" },
      address: "inbox+workflow@example.com",
      mailboxHandle: "inbox",
      inbound: {
        _tag: "Trigger",
        workflowId: "workflow:1",
      },
      outbound: { _tag: "Disabled" },
      lifecycle: RouteLifecycleSchema.cases.Active.make({}),
      revision: 1,
      actor: { _tag: "System", id: "system:provisioner" },
      createdAt: at(1_000),
      updatedAt: at(1_000),
    })
    expect(isSendable(workflowRoute)).toBe(false)
    const replyRoute = Schema.decodeUnknownSync(RouteSchema)({
      ...workflowRoute,
      outbound: { _tag: "Sender", role: "alternate" },
    })
    expect(isSendable(replyRoute)).toBe(true)
  })
})

describe("test recipient lifecycle", () => {
  test("moves pending recipients to verified", () => {
    const verified = markVerified(pendingRecipient(), at(2_000))
    expect(isVerified(verified)).toBe(true)
  })

  test("refreshes only a typed failed recipient", () => {
    const failed = markFailed(pendingRecipient(), {
      failedAt: at(2_000),
      reason: "verification_expired",
    })
    expect(isFailed(failed)).toBe(true)

    const pending = refresh(failed, at(3_000))
    expect(pending.state).toEqual(
      TestRecipientStateSchema.cases.Pending.make({
        requestedAt: at(3_000),
      }),
    )
  })
})
