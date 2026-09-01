import { Context, Effect, Layer, Option, Schema } from "effect"
import type { EmailAddress } from "../core/address.js"
import { MessageIdSchema } from "../core/identifiers.js"
import type { InboundMessage } from "../core/message.js"
import type { ReceivedContent } from "../core/received-content.js"
import {
  isActive,
  isTrigger,
  type Route,
} from "../core/route.js"

/** Complete derived context available to one host-composable reply decision. */
export interface CheckReplyPolicyInput {
  readonly source: InboundMessage
  readonly content: ReceivedContent
  readonly sourceRoute: Route
  readonly target: EmailAddress
  readonly targetRoute: Option.Option<Route>
}

/** A reply would create a package-recognized automatic routing loop. */
export class ReplyLoopPrevented extends Schema.TaggedError<
  ReplyLoopPrevented
>()("ReplyLoopPrevented", {
  messageId: MessageIdSchema,
  reason: Schema.Literals([
    "automatic_source",
    "self_target",
    "active_trigger_target",
  ]),
}) {}

const ReplyPolicyRejectionReasonSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-z][a-z0-9._:-]*$/u),
)

/** A host-supplied reply rule deliberately rejected the derived action. */
export class ReplyPolicyRejected extends Schema.TaggedError<
  ReplyPolicyRejected
>()("ReplyPolicyRejected", {
  messageId: MessageIdSchema,
  reason: ReplyPolicyRejectionReasonSchema,
}) {}

/** Typed failures exposed by a reply-policy decision. */
export type ReplyPolicyFailure = ReplyLoopPrevented | ReplyPolicyRejected

/** Host-composable authorization and loop policy for derived email replies. */
export class ReplyPolicy extends Context.Service<ReplyPolicy, {
  readonly check: (
    input: CheckReplyPolicyInput,
  ) => Effect.Effect<void, ReplyPolicyFailure>
}>()("@popcomputer/email/ReplyPolicy") {}

const isAutomaticSource = (content: ReceivedContent): boolean =>
  content.automation.autoSubmitted === "automatic" ||
  content.automation.precedence === "bulk" ||
  content.automation.precedence === "list" ||
  content.automation.precedence === "junk" ||
  content.automation.listId || content.automation.responseSuppression

/** Conservative reply policy that rejects automated sources and active triggers. */
export const conservativeReplyPolicy = ReplyPolicy.of({
  check: Effect.fn("Email.replyPolicy.conservative")(function*(input) {
    if (isAutomaticSource(input.content)) {
      return yield* new ReplyLoopPrevented({
        messageId: input.source.id,
        reason: "automatic_source",
      })
    }
    const targetsActiveTrigger = Option.isSome(input.targetRoute) &&
      isActive(input.targetRoute.value) && isTrigger(input.targetRoute.value)
    if (targetsActiveTrigger) {
      return yield* new ReplyLoopPrevented({
        messageId: input.source.id,
        reason: "active_trigger_target",
      })
    }
  }),
})

/** Layer containing the package's conservative reply policy. */
export const conservativeReplyPolicyLayer: Layer.Layer<ReplyPolicy> =
  Layer.succeed(ReplyPolicy, conservativeReplyPolicy)
