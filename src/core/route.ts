import { DateTime, Schema } from "effect"
import { ActorSchema } from "./actor.js"
import {
  EmailAddressSchema,
  MailboxHandleSchema,
} from "./address.js"
import {
  IdempotencyKeySchema,
  RouteIdSchema,
  WorkflowIdSchema,
} from "./identifiers.js"
import { ScopeSchema } from "./scope.js"

/** Positive optimistic revision of one persisted route. */
export const RouteRevisionSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
).pipe(Schema.brand("EmailRouteRevision"))

/** Positive optimistic revision of one persisted route. */
export type RouteRevision = typeof RouteRevisionSchema.Type

/** Lifecycle state controlling whether a reserved route accepts operations. */
export const RouteLifecycleSchema = Schema.TaggedUnion({
  Active: {},
  Paused: { pausedAt: Schema.DateTimeUtc },
  Disabled: { disabledAt: Schema.DateTimeUtc },
})

/** Lifecycle state controlling whether a reserved route accepts operations. */
export type RouteLifecycle = typeof RouteLifecycleSchema.Type

/** Active route lifecycle accepted by pause and disable transitions. */
export type ActiveRouteLifecycle =
  typeof RouteLifecycleSchema.cases.Active.Type

/** Paused route lifecycle accepted by resume and disable transitions. */
export type PausedRouteLifecycle =
  typeof RouteLifecycleSchema.cases.Paused.Type

/** Disabled terminal route lifecycle that continues reserving its address. */
export type DisabledRouteLifecycle =
  typeof RouteLifecycleSchema.cases.Disabled.Type

/** Sender-selection role available to outbound-capable routes. */
export const SenderRoleSchema = Schema.Literals([
  "default",
  "alternate",
])

/** Sender-selection role available to outbound-capable routes. */
export type SenderRole = typeof SenderRoleSchema.Type

/** Inbound behavior applied after a message is durably received. */
export const InboundCapabilitySchema = Schema.TaggedUnion({
  Store: {},
  Trigger: {
    workflowId: WorkflowIdSchema,
  },
})

/** Inbound behavior applied after a message is durably received. */
export type InboundCapability = typeof InboundCapabilitySchema.Type

/** Outbound behavior independently configured for one route address. */
export const OutboundCapabilitySchema = Schema.TaggedUnion({
  Disabled: {},
  Sender: { role: SenderRoleSchema },
})

/** Outbound behavior independently configured for one route address. */
export type OutboundCapability = typeof OutboundCapabilitySchema.Type

/** Reserved email route owned by one namespace. */
export const RouteSchema = Schema.Struct({
  id: RouteIdSchema,
  scope: ScopeSchema,
  address: EmailAddressSchema,
  mailboxHandle: MailboxHandleSchema,
  inbound: InboundCapabilitySchema,
  outbound: OutboundCapabilitySchema,
  lifecycle: RouteLifecycleSchema,
  revision: RouteRevisionSchema,
  actor: ActorSchema,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
})

/** Reserved email route owned by one namespace. */
export type Route = typeof RouteSchema.Type

/** Route configured to emit one durable workflow event per inbound message. */
export type TriggerRoute = Route & {
  readonly inbound: typeof InboundCapabilitySchema.cases.Trigger.Type
}

/** Route configured as an outbound sender independently of inbound behavior. */
export type SenderRoute = Route & {
  readonly outbound: typeof OutboundCapabilitySchema.cases.Sender.Type
}

/** Route whose lifecycle permits inbound processing. */
export type ActiveRoute = Route & {
  readonly lifecycle: ActiveRouteLifecycle
}

/** Route deliberately paused while keeping its address reserved. */
export type PausedRoute = Route & {
  readonly lifecycle: PausedRouteLifecycle
}

/** Permanently disabled route that continues reserving its address. */
export type DisabledRoute = Route & {
  readonly lifecycle: DisabledRouteLifecycle
}

/** Active sender-capable route legal to use for outbound delivery. */
export type SendableRoute = SenderRoute & {
  readonly lifecycle: ActiveRouteLifecycle
}

/** Handle-selection policy for a newly provisioned route. */
export const RouteHandleRequestSchema = Schema.TaggedUnion({
  Generated: {},
  Requested: { mailboxHandle: MailboxHandleSchema },
})

/** Handle-selection policy for a newly provisioned route. */
export type RouteHandleRequest = typeof RouteHandleRequestSchema.Type

/** Parsed command for idempotently provisioning one capability-configured route. */
export const ProvisionRouteInputSchema = Schema.Struct({
  scope: ScopeSchema,
  actor: ActorSchema,
  idempotencyKey: IdempotencyKeySchema,
  handle: RouteHandleRequestSchema,
  inbound: InboundCapabilitySchema,
  outbound: OutboundCapabilitySchema,
})

/** Parsed command for idempotently provisioning one capability-configured route. */
export interface ProvisionRouteInput extends Schema.Schema.Type<
  typeof ProvisionRouteInputSchema
> {}

/** Narrow a route to the only lifecycle accepted by pause. */
export const isActive = (route: Route): route is ActiveRoute =>
  route.lifecycle._tag === "Active"

/** Narrow a route to the only lifecycle accepted by resume. */
export const isPaused = (route: Route): route is PausedRoute =>
  route.lifecycle._tag === "Paused"

/** Narrow a route to its terminal disabled lifecycle. */
export const isDisabled = (route: Route): route is DisabledRoute =>
  route.lifecycle._tag === "Disabled"

/** Narrow a route to a sender-capable route regardless of lifecycle. */
export const isSender = (route: Route): route is SenderRoute =>
  route.outbound._tag === "Sender"

/** Narrow a route to a workflow-trigger route regardless of lifecycle. */
export const isTrigger = (route: Route): route is TriggerRoute =>
  route.inbound._tag === "Trigger"

/** Narrow a route to an active route legal for outbound sending. */
export const isSendable = (route: Route): route is SendableRoute =>
  isSender(route) && isActive(route)

/** Pause an active route while preserving its address and capabilities. */
export const pause = (
  route: ActiveRoute,
  pausedAt: DateTime.Utc,
): PausedRoute => ({
  ...route,
  lifecycle: RouteLifecycleSchema.cases.Paused.make({ pausedAt }),
  revision: RouteRevisionSchema.make(route.revision + 1),
  updatedAt: pausedAt,
})

/** Resume a paused route without changing its address or capabilities. */
export const resume = (
  route: PausedRoute,
  resumedAt: DateTime.Utc,
): ActiveRoute => ({
  ...route,
  lifecycle: RouteLifecycleSchema.cases.Active.make({}),
  revision: RouteRevisionSchema.make(route.revision + 1),
  updatedAt: resumedAt,
})

/** Permanently disable an active or paused route while reserving its address. */
export const disable = (
  route: ActiveRoute | PausedRoute,
  disabledAt: DateTime.Utc,
): DisabledRoute => ({
  ...route,
  lifecycle: RouteLifecycleSchema.cases.Disabled.make({ disabledAt }),
  revision: RouteRevisionSchema.make(route.revision + 1),
  updatedAt: disabledAt,
})

/** A required email route did not exist in the caller's scope. */
export class RouteNotFound extends Schema.TaggedError<RouteNotFound>()(
  "RouteNotFound",
  {
    routeId: RouteIdSchema,
    reason: Schema.Literal("not_found"),
  },
) {}

/** A route existed but its lifecycle did not permit the requested operation. */
export class RouteInactive extends Schema.TaggedError<RouteInactive>()(
  "RouteInactive",
  {
    routeId: RouteIdSchema,
    reason: Schema.Literals(["paused", "disabled"]),
  },
) {}

/** A route's outbound capability does not permit sending. */
export class RouteNotSendable extends Schema.TaggedError<RouteNotSendable>()(
  "RouteNotSendable",
  {
    routeId: RouteIdSchema,
    reason: Schema.Literal("outbound_disabled"),
  },
) {}

/** A route changed after the caller observed its optimistic revision. */
export class RouteTransitionConflict extends Schema.TaggedError<
  RouteTransitionConflict
>()("RouteTransitionConflict", {
  routeId: RouteIdSchema,
  reason: Schema.Literal("concurrent_update"),
}) {}
