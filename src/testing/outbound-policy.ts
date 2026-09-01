import { Effect, Layer } from "effect"
import {
  OutboundPolicy,
  type CheckOutboundPolicyInput,
} from "../adapters/outbound-policy.js"
import type { EmailAddress } from "../core/address.js"
import {
  MessageTooLarge,
  RecipientNotPermitted,
} from "../core/email-command.js"

/** Test policy configuration with explicit limits and verified recipients. */
export interface TestOutboundPolicyConfig {
  readonly maximumBytes?: number
  readonly maximumRecipients?: number
  readonly verifiedTestRecipients?: ReadonlySet<EmailAddress>
}

/** Create an outbound policy for tests; live scopes pass after configured limits. */
export const makeTestOutboundPolicy = (
  config: TestOutboundPolicyConfig = {},
): OutboundPolicy["Service"] => {
  const maximumBytes = config.maximumBytes ?? 25 * 1024 * 1024
  const maximumRecipients = config.maximumRecipients ?? 100
  return OutboundPolicy.of({
    check: (input: CheckOutboundPolicyInput) => {
      if (input.sizeBytes > maximumBytes) {
        return Effect.fail(new MessageTooLarge({
          actualBytes: input.sizeBytes,
          maximumBytes,
        }))
      }
      if (input.recipients.length > maximumRecipients) {
        return Effect.fail(new RecipientNotPermitted({
          reason: "recipient_limit_exceeded",
        }))
      }
      if (
        input.scope.environment === "test" &&
        input.recipients.some((address) =>
          !config.verifiedTestRecipients?.has(address))
      ) {
        return Effect.fail(new RecipientNotPermitted({
          reason: "test_recipient_unverified",
        }))
      }
      return Effect.void
    },
  })
}

/** Layer containing one explicit testing-only outbound policy. */
export const testOutboundPolicy = (
  config?: TestOutboundPolicyConfig,
): Layer.Layer<OutboundPolicy> => Layer.succeed(
  OutboundPolicy,
  makeTestOutboundPolicy(config),
)
