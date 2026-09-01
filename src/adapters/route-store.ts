import { Context, Effect, Option, Schema } from "effect"
import type { EmailAddress } from "../core/address.js"
import type { RouteId } from "../core/identifiers.js"
import type { Route, SenderRoute } from "../core/route.js"
import type { Scope } from "../core/scope.js"

/** Route lookup performed by the send workflow. */
export const RouteStoreOperationSchema = Schema.Literals([
  "find_default_sender",
  "find_by_id",
  "find_by_inbound_address",
])

/** Route lookup performed by the send workflow. */
export type RouteStoreOperation = typeof RouteStoreOperationSchema.Type

/** The configured route store could not complete a lookup. */
export class RouteStoreFailure extends Schema.TaggedError<RouteStoreFailure>()(
  "RouteStoreFailure",
  {
    operation: RouteStoreOperationSchema,
    reason: Schema.Literal("unavailable"),
  },
) {}

/** Scope-safe read port for resolving outbound sender routes. */
export class RouteStore extends Context.Service<RouteStore, {
  readonly findDefaultSender: (
    scope: Scope,
  ) => Effect.Effect<Option.Option<SenderRoute>, RouteStoreFailure>
  readonly findById: (
    scope: Scope,
    routeId: RouteId,
  ) => Effect.Effect<Option.Option<Route>, RouteStoreFailure>
  readonly findByInboundAddress: (
    address: EmailAddress,
  ) => Effect.Effect<Option.Option<Route>, RouteStoreFailure>
}>()("@popcomputer/email/RouteStore") {}
