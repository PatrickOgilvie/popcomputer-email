import { Context, Effect, Option, Schema } from "effect"
import type { Actor } from "../core/actor.js"
import type { EmailAddress, MailboxHandle } from "../core/address.js"
import type {
  IdempotencyKey,
  RequestFingerprint,
  RouteId,
} from "../core/identifiers.js"
import {
  RouteIdSchema,
} from "../core/identifiers.js"
import type {
  ActiveRoute,
  DisabledRoute,
  InboundCapability,
  OutboundCapability,
  Route,
  RouteRevision,
} from "../core/route.js"
import type { Scope } from "../core/scope.js"

/** Named route-persistence operation safe to expose in diagnostics. */
export const RouteAdminStoreOperationSchema = Schema.Literals([
  "find_idempotency",
  "reserve",
  "list",
  "transition",
  "rotate",
])

/** Named route-persistence operation safe to expose in diagnostics. */
export type RouteAdminStoreOperation =
  typeof RouteAdminStoreOperationSchema.Type

/** Route persistence infrastructure could not complete an operation. */
export class RouteAdminStoreFailure extends Schema.TaggedError<
  RouteAdminStoreFailure
>()("RouteAdminStoreFailure", {
  operation: RouteAdminStoreOperationSchema,
  reason: Schema.Literal("unavailable"),
}) {}

/** A requested or generated route address is already reserved. */
export class RouteAddressConflict extends Schema.TaggedError<
  RouteAddressConflict
>()("RouteAddressConflict", {
  reason: Schema.Literal("already_reserved"),
}) {}

/** A route mutation observed a stale optimistic revision. */
export class RouteStoreTransitionConflict extends Schema.TaggedError<
  RouteStoreTransitionConflict
>()("RouteStoreTransitionConflict", {
  routeId: RouteIdSchema,
  reason: Schema.Literal("concurrent_update"),
}) {}

/** Stored route plus its creation fingerprint for safe replay comparison. */
export interface StoredRoute {
  readonly route: Route
  readonly creationFingerprint: RequestFingerprint
}

/** Complete storage input for a new package-owned route. */
export interface ReserveRouteInput {
  readonly id: RouteId
  readonly scope: Scope
  readonly domainId: string
  readonly address: EmailAddress
  readonly mailboxHandle: MailboxHandle
  readonly inbound: InboundCapability
  readonly outbound: OutboundCapability
  readonly actor: Actor
  readonly idempotencyKey: IdempotencyKey
  readonly creationFingerprint: RequestFingerprint
  readonly createdAt: import("effect").DateTime.Utc
}

/** Atomic route reservation result. */
export type ReserveRouteResult =
  | { readonly _tag: "Created"; readonly record: StoredRoute }
  | { readonly _tag: "Existing"; readonly record: StoredRoute }

/** Compare-and-set route lifecycle update. */
export interface TransitionRouteInput {
  readonly scope: Scope
  readonly route: Route
  readonly expectedRevision: RouteRevision
}

/** Atomic disable-and-replace operation used by address rotation. */
export interface RotateRouteInput {
  readonly scope: Scope
  readonly previous: DisabledRoute
  readonly expectedRevision: RouteRevision
  readonly replacement: ReserveRouteInput
}

/** Scoped route administration persistence. */
export class RouteAdminStore extends Context.Service<RouteAdminStore, {
  readonly findByIdempotency: (
    scope: Scope,
    key: IdempotencyKey,
  ) => Effect.Effect<Option.Option<StoredRoute>, RouteAdminStoreFailure>
  readonly reserve: (
    input: ReserveRouteInput,
  ) => Effect.Effect<
    ReserveRouteResult,
    RouteAddressConflict | RouteAdminStoreFailure
  >
  readonly list: (
    scope: Scope,
  ) => Effect.Effect<ReadonlyArray<Route>, RouteAdminStoreFailure>
  readonly transition: (
    input: TransitionRouteInput,
  ) => Effect.Effect<
    Route,
    RouteAdminStoreFailure | RouteStoreTransitionConflict
  >
  readonly rotate: (
    input: RotateRouteInput,
  ) => Effect.Effect<
    { readonly previous: DisabledRoute; readonly replacement: ActiveRoute },
    RouteAddressConflict | RouteAdminStoreFailure | RouteStoreTransitionConflict
  >
}>()("@popcomputer/email/RouteAdminStore") {}
