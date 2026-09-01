import { Context, Effect } from "effect"
import type {
  LeaseToken,
  MessageId,
  RecipientId,
  RouteId,
  TestRecipientId,
  WorkflowEventId,
} from "../core/identifiers.js"

/** Host-neutral generator for opaque message and recipient identities. */
export class IdentifierGenerator extends Context.Service<IdentifierGenerator, {
  readonly messageId: Effect.Effect<MessageId>
  readonly recipientId: Effect.Effect<RecipientId>
  readonly routeId: Effect.Effect<RouteId>
  readonly testRecipientId: Effect.Effect<TestRecipientId>
  readonly workflowEventId: Effect.Effect<WorkflowEventId>
  readonly leaseToken: Effect.Effect<LeaseToken>
}>()("@popcomputer/email/IdentifierGenerator") {}
