import { Context, Effect, Schema } from "effect"
import type { EmailAddress } from "../core/address.js"
import type {
  MessageTooLarge,
  RecipientNotPermitted,
} from "../core/email-command.js"
import type { Scope } from "../core/scope.js"

/** Complete information needed for one outbound policy decision. */
export interface CheckOutboundPolicyInput {
  readonly scope: Scope
  readonly recipients: readonly [EmailAddress, ...Array<EmailAddress>]
  readonly sizeBytes: number
}

/** Outbound policy storage/configuration could not make a safe decision. */
export class OutboundPolicyFailure extends Schema.TaggedError<
  OutboundPolicyFailure
>()("OutboundPolicyFailure", {
  reason: Schema.Literal("unavailable"),
}) {}

/** Recipient, quota, and message-size policy checked before provider handoff. */
export class OutboundPolicy extends Context.Service<OutboundPolicy, {
  readonly check: (
    input: CheckOutboundPolicyInput,
  ) => Effect.Effect<
    void,
    MessageTooLarge | OutboundPolicyFailure | RecipientNotPermitted
  >
}>()("@popcomputer/email/OutboundPolicy") {}
