import { Effect, Schema } from "effect"
import {
  OutboundPolicy,
  OutboundPolicyFailure,
  type CheckOutboundPolicyInput,
} from "../../adapters/outbound-policy.js"
import {
  MessageTooLarge,
  RecipientNotPermitted,
} from "../../core/email-command.js"
import type { D1Database } from "./contract.js"

const GrantsTable = "popcomputer_email_test_recipient_grants"
const DestinationsTable = "popcomputer_email_cf_destinations"
const MaximumConfiguredRecipients = 500

/** Explicit message and envelope bounds enforced before provider handoff. */
export interface D1OutboundPolicyConfig {
  readonly maximumMessageBytes: number
  readonly maximumRecipients: number
}

/** Conservative defaults matching the inbound 25 MiB package boundary. */
export const defaultD1OutboundPolicyConfig: D1OutboundPolicyConfig = {
  maximumMessageBytes: 25 * 1024 * 1024,
  maximumRecipients: 100,
}

const AddressRowSchema = Schema.Struct({ address: Schema.String })

const validConfig = (config: D1OutboundPolicyConfig): boolean =>
  Number.isSafeInteger(config.maximumMessageBytes) &&
  config.maximumMessageBytes >= 0 &&
  Number.isSafeInteger(config.maximumRecipients) &&
  config.maximumRecipients >= 1 &&
  config.maximumRecipients <= MaximumConfiguredRecipients

const check = (
  database: D1Database,
  config: D1OutboundPolicyConfig,
  input: CheckOutboundPolicyInput,
): Effect.Effect<
  void,
  MessageTooLarge | OutboundPolicyFailure | RecipientNotPermitted
> =>
  Effect.gen(function*() {
    if (!validConfig(config)) {
      return yield* new OutboundPolicyFailure({ reason: "unavailable" })
    }
    if (input.sizeBytes > config.maximumMessageBytes) {
      return yield* new MessageTooLarge({
        actualBytes: input.sizeBytes,
        maximumBytes: config.maximumMessageBytes,
      })
    }
    if (input.recipients.length > config.maximumRecipients) {
      return yield* new RecipientNotPermitted({
        reason: "recipient_limit_exceeded",
      })
    }
    if (input.scope.environment === "live") return

    const distinct = [...new Set(input.recipients)]
    const placeholders = distinct.map((_, index) => `?${index + 2}`)
    const rows = yield* Effect.tryPromise({
      try: () => database.prepare(
        `SELECT d.address
         FROM ${GrantsTable} AS g
         INNER JOIN ${DestinationsTable} AS d ON d.id = g.destination_id
         WHERE g.namespace = ?1
           AND g.environment = 'test'
           AND g.state = 'verified'
           AND d.address IN (${placeholders.join(", ")})
         ORDER BY d.address ASC`,
      ).bind(input.scope.namespace, ...distinct).all<unknown>(),
      catch: () => new OutboundPolicyFailure({ reason: "unavailable" }),
    }).pipe(
      Effect.map((result) => result.results),
    )
    const verified = yield* Schema.decodeUnknownEffect(
      Schema.Array(AddressRowSchema),
    )(rows, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new OutboundPolicyFailure({
        reason: "unavailable",
      })),
    )
    const verifiedAddresses = new Set(verified.map((row) => row.address))
    if (distinct.some((address) => !verifiedAddresses.has(address))) {
      return yield* new RecipientNotPermitted({
        reason: "test_recipient_unverified",
      })
    }
  })

/** Construct the D1-backed outbound policy and test-recipient allow-list. */
export const makeD1OutboundPolicy = (
  database: D1Database,
  config: D1OutboundPolicyConfig = defaultD1OutboundPolicyConfig,
) => OutboundPolicy.of({
  check: (input) => check(database, config, input),
})
