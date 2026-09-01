import { Schema } from "effect"
import {
  EmailAddressSchema,
  MailboxHandleSchema,
} from "../core/address.js"
import {
  RouteIdSchema,
  WorkflowIdSchema,
} from "../core/identifiers.js"
import { EnvironmentSchema } from "../core/scope.js"

/** Hosted route lifecycle vocabulary. */
export const RouteStatusSchema = Schema.Literals([
  "active",
  "paused",
  "disabled",
])

/** Hosted route lifecycle vocabulary. */
export type RouteStatus = typeof RouteStatusSchema.Type

/** Hosted inbound route capability. Triggering still durably stores the message. */
export const EmailRouteInboundSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("store") }),
  Schema.Struct({
    kind: Schema.Literal("trigger"),
    workflowId: WorkflowIdSchema,
  }),
])

/** Hosted inbound route capability. */
export type EmailRouteInbound = typeof EmailRouteInboundSchema.Type

/** Hosted outbound route capability configured independently from inbound behavior. */
export const EmailRouteOutboundSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("disabled") }),
  Schema.Struct({
    kind: Schema.Literal("sender"),
    role: Schema.Literals(["default", "alternate"]),
  }),
])

/** Hosted outbound route capability. */
export type EmailRouteOutbound = typeof EmailRouteOutboundSchema.Type

/** Public route projection returned by hosted route operations. */
export const EmailRouteSchema = Schema.Struct({
  id: RouteIdSchema,
  environment: EnvironmentSchema,
  address: EmailAddressSchema,
  mailboxHandle: MailboxHandleSchema,
  inbound: EmailRouteInboundSchema,
  outbound: EmailRouteOutboundSchema,
  status: RouteStatusSchema,
  revision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
  ),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  disabledAt: Schema.NullOr(Schema.DateTimeUtcFromString),
})

/** Public route projection returned by hosted route operations. */
export interface EmailRoute extends Schema.Schema.Type<
  typeof EmailRouteSchema
> {}

/** Hosted response containing one public route. */
export const EmailRouteEnvelopeSchema = Schema.Struct({
  route: EmailRouteSchema,
})

/** Hosted response containing one public route. */
export interface EmailRouteEnvelope extends Schema.Schema.Type<
  typeof EmailRouteEnvelopeSchema
> {}

/** Hosted response containing all routes visible to the scoped credential. */
export const EmailRouteListSchema = Schema.Struct({
  items: Schema.Array(EmailRouteSchema),
})

/** Hosted response containing all routes visible to the scoped credential. */
export interface EmailRouteList extends Schema.Schema.Type<
  typeof EmailRouteListSchema
> {}

/** Body for provisioning one idempotent capability-configured route. */
export const ProvisionRouteRequestSchema = Schema.Struct({
  mailboxHandle: Schema.optionalKey(MailboxHandleSchema),
  inbound: EmailRouteInboundSchema,
  outbound: EmailRouteOutboundSchema,
})

/** Body for provisioning one idempotent capability-configured route. */
export interface ProvisionRouteRequest extends Schema.Schema.Type<
  typeof ProvisionRouteRequestSchema
> {}

/** Hosted response containing the disabled original and its replacement. */
export const RouteRotationSchema = Schema.Struct({
  previous: EmailRouteSchema,
  replacement: EmailRouteSchema,
})

/** Hosted response containing the disabled original and its replacement. */
export interface RouteRotation extends Schema.Schema.Type<
  typeof RouteRotationSchema
> {}
