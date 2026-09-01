import { Context, Effect, Option, Schema } from "effect"
import type { EmailAddress } from "../core/address.js"
import type { DestinationId } from "../core/identifiers.js"

/** Provider-level destination verification projection. */
export interface Destination {
  readonly id: DestinationId
  readonly address: EmailAddress
  readonly status: "pending" | "verified" | "failed"
}

/** Verified-destination provider operation failed with a safe classification. */
export class DestinationRegistryFailure extends Schema.TaggedError<
  DestinationRegistryFailure
>()("DestinationRegistryFailure", {
  operation: Schema.Literals(["create", "find_by_address", "get"]),
  reason: Schema.Literals([
    "quota_exceeded",
    "duplicate",
    "not_found",
    "provider_rejected",
    "unavailable",
    "invalid_response",
  ]),
}) {}

/** Provider seam for destination-address verification. */
export class DestinationRegistry extends Context.Service<DestinationRegistry, {
  readonly create: (
    address: EmailAddress,
  ) => Effect.Effect<Destination, DestinationRegistryFailure>
  readonly get: (
    id: DestinationId,
  ) => Effect.Effect<Destination, DestinationRegistryFailure>
  readonly findByAddress: (
    address: EmailAddress,
  ) => Effect.Effect<Option.Option<Destination>, DestinationRegistryFailure>
}>()("@popcomputer/email/DestinationRegistry") {}
