import { Effect, Layer } from "effect"
import { IdentifierGenerator } from "../adapters/identifier-generator.js"
import { RouteHandleGenerator } from "../adapters/route-handle-generator.js"
import {
  LeaseTokenSchema,
  MessageIdSchema,
  RecipientIdSchema,
  RouteIdSchema,
  TestRecipientIdSchema,
  WorkflowEventIdSchema,
} from "../core/identifiers.js"
import { MailboxHandleSchema } from "../core/address.js"

/** Deterministic test identifier service with an isolated monotonic sequence. */
export const makeDeterministicIdentifiers = (prefix = "test") => {
  let sequence = 0
  const next = (kind: string): string => {
    sequence += 1
    return `${prefix}:${kind}:${sequence}`
  }
  return IdentifierGenerator.of({
    messageId: Effect.sync(() => MessageIdSchema.make(next("message"))),
    recipientId: Effect.sync(() => RecipientIdSchema.make(next("recipient"))),
    routeId: Effect.sync(() => RouteIdSchema.make(next("route"))),
    testRecipientId: Effect.sync(() =>
      TestRecipientIdSchema.make(next("test-recipient"))),
    workflowEventId: Effect.sync(() =>
      WorkflowEventIdSchema.make(next("workflow-event"))),
    leaseToken: Effect.sync(() => LeaseTokenSchema.make(next("lease"))),
  })
}

/** Layer containing a fresh deterministic identifier sequence. */
export const deterministicIdentifiers = (
  prefix?: string,
): Layer.Layer<IdentifierGenerator> => Layer.sync(
  IdentifierGenerator,
  () => makeDeterministicIdentifiers(prefix),
)

/** Deterministic generated mailbox handles for route collision tests. */
export const makeDeterministicRouteHandles = (prefix = "mailbox") => {
  let sequence = 0
  return RouteHandleGenerator.of({
    next: Effect.sync(() => {
      sequence += 1
      return MailboxHandleSchema.make(`${prefix}-${sequence}`)
    }),
  })
}

/** Layer containing a fresh deterministic route-handle sequence. */
export const deterministicRouteHandles = (
  prefix?: string,
): Layer.Layer<RouteHandleGenerator> => Layer.sync(
  RouteHandleGenerator,
  () => makeDeterministicRouteHandles(prefix),
)
