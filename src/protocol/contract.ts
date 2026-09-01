import { Schema } from "effect"
import { IdempotencyKeySchema } from "../core/identifiers.js"
import {
  MessagePathSchema,
  ReceivedAttachmentPathSchema,
  RoutePathSchema,
  TestRecipientPathSchema,
} from "./common.js"
import { ErrorResponseSchema } from "./errors.js"
import {
  EmailMessageEnvelopeSchema,
  EmailMessagePageSchema,
  ListMessagesQuerySchema,
  ReceivedContentEnvelopeSchema,
  ReplyEmailRequestSchema,
  SendEmailRequestSchema,
} from "./messages.js"
import {
  EmailRouteEnvelopeSchema,
  EmailRouteListSchema,
  ProvisionRouteRequestSchema,
  RouteRotationSchema,
} from "./routes.js"
import {
  AddTestRecipientRequestSchema,
  EmailTestRecipientEnvelopeSchema,
  EmailTestRecipientListSchema,
} from "./test-recipients.js"

/** HTTP method supported by one hosted email operation. */
export type Method = "GET" | "POST" | "DELETE"

/** Permission label interpreted by the hosting application's auth boundary. */
export type Permission = "read" | "send" | "manage"

/** Non-empty permission set required by one hosted email operation. */
export type Permissions = readonly [Permission, ...ReadonlyArray<Permission>]

/** HTTP error status documented for one hosted operation. */
export type ErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 413
  | 415
  | 422
  | 429
  | 500
  | 503

/** Location of one operation parameter in the HTTP request. */
export type ParameterLocation = "path" | "query"

/** Schema-backed parameter metadata used by host conformance and OpenAPI. */
export interface OperationParameter {
  readonly name: string
  readonly location: ParameterLocation
  readonly required: boolean
  readonly schema: Schema.Top
}

/** Runtime schema and transport metadata for one hosted email operation. */
export interface Operation {
  readonly operationId: string
  readonly method: Method
  readonly path: string
  readonly permissions: Permissions
  readonly idempotency: "required" | "not_required"
  readonly pathSchema?: Schema.Top
  readonly querySchema?: Schema.Top
  readonly parameters?: ReadonlyArray<OperationParameter>
  readonly bodySchema?: Schema.Top
  readonly successStatus: number
  readonly successSchema: Schema.Top
  readonly successContentType:
    | "application/json"
    | "application/octet-stream"
    | "message/rfc822"
  readonly errorStatuses: ReadonlyArray<ErrorStatus>
  readonly errorSchema: typeof ErrorResponseSchema
}

const operation = (definition: Operation): Operation => definition

const parameter = (
  name: string,
  location: ParameterLocation,
  required: boolean,
  schema: Schema.Top,
): OperationParameter => ({ name, location, required, schema })

const MessagePathParameters = [
  parameter("email", "path", true, MessagePathSchema.fields.email),
] as const

const ReceivedAttachmentPathParameters = [
  parameter(
    "email",
    "path",
    true,
    ReceivedAttachmentPathSchema.fields.email,
  ),
  parameter(
    "attachment",
    "path",
    true,
    ReceivedAttachmentPathSchema.fields.attachment,
  ),
] as const

const RoutePathParameters = [
  parameter("route", "path", true, RoutePathSchema.fields.route),
] as const

const TestRecipientPathParameters = [
  parameter(
    "recipient",
    "path",
    true,
    TestRecipientPathSchema.fields.recipient,
  ),
] as const

const ListMessageParameters = [
  parameter(
    "direction",
    "query",
    false,
    ListMessagesQuerySchema.fields.direction,
  ),
  parameter(
    "cursor",
    "query",
    false,
    ListMessagesQuerySchema.fields.cursor,
  ),
  parameter(
    "limit",
    "query",
    false,
    ListMessagesQuerySchema.fields.limit,
  ),
] as const

/** Header schema shared by hosted commands requiring replay protection. */
export const IdempotencyHeaderSchema = Schema.Struct({
  "idempotency-key": IdempotencyKeySchema,
})

/** Canonical registry from which clients, docs, and host conformance derive. */
export const operations = [
  operation({
    operationId: "sendEmail",
    method: "POST",
    path: "/emails",
    permissions: ["send"],
    idempotency: "required",
    bodySchema: SendEmailRequestSchema,
    successStatus: 201,
    successSchema: EmailMessageEnvelopeSchema,
    successContentType: "application/json",
    errorStatuses: [
      400,
      401,
      403,
      409,
      413,
      415,
      422,
      429,
      500,
      503,
    ],
    errorSchema: ErrorResponseSchema,
  }),
  operation({
    operationId: "listEmails",
    method: "GET",
    path: "/emails",
    permissions: ["read"],
    idempotency: "not_required",
    querySchema: ListMessagesQuerySchema,
    parameters: ListMessageParameters,
    successStatus: 200,
    successSchema: EmailMessagePageSchema,
    successContentType: "application/json",
    errorStatuses: [400, 401, 403, 429, 500, 503],
    errorSchema: ErrorResponseSchema,
  }),
  operation({
    operationId: "getEmailContent",
    method: "GET",
    path: "/emails/{email}/content",
    permissions: ["read"],
    idempotency: "not_required",
    pathSchema: MessagePathSchema,
    parameters: MessagePathParameters,
    successStatus: 200,
    successSchema: ReceivedContentEnvelopeSchema,
    successContentType: "application/json",
    errorStatuses: [400, 401, 403, 404, 413, 422, 429, 500, 503],
    errorSchema: ErrorResponseSchema,
  }),
  operation({
    operationId: "getEmailAttachment",
    method: "GET",
    path: "/emails/{email}/attachments/{attachment}",
    permissions: ["read"],
    idempotency: "not_required",
    pathSchema: ReceivedAttachmentPathSchema,
    parameters: ReceivedAttachmentPathParameters,
    successStatus: 200,
    successSchema: Schema.Uint8Array,
    successContentType: "application/octet-stream",
    errorStatuses: [400, 401, 403, 404, 413, 422, 429, 500, 503],
    errorSchema: ErrorResponseSchema,
  }),
  operation({
    operationId: "getRawEmail",
    method: "GET",
    path: "/emails/{email}/raw",
    permissions: ["read"],
    idempotency: "not_required",
    pathSchema: MessagePathSchema,
    parameters: MessagePathParameters,
    successStatus: 200,
    successSchema: Schema.Uint8Array,
    successContentType: "message/rfc822",
    errorStatuses: [400, 401, 403, 404, 429, 500, 503],
    errorSchema: ErrorResponseSchema,
  }),
  operation({
    operationId: "replyToEmail",
    method: "POST",
    path: "/emails/{email}/reply",
    permissions: ["read", "send"],
    idempotency: "required",
    pathSchema: MessagePathSchema,
    parameters: MessagePathParameters,
    bodySchema: ReplyEmailRequestSchema,
    successStatus: 201,
    successSchema: EmailMessageEnvelopeSchema,
    successContentType: "application/json",
    errorStatuses: [
      400,
      401,
      403,
      404,
      409,
      413,
      415,
      422,
      429,
      500,
      503,
    ],
    errorSchema: ErrorResponseSchema,
  }),
  operation({
    operationId: "getEmail",
    method: "GET",
    path: "/emails/{email}",
    permissions: ["read"],
    idempotency: "not_required",
    pathSchema: MessagePathSchema,
    parameters: MessagePathParameters,
    successStatus: 200,
    successSchema: EmailMessageEnvelopeSchema,
    successContentType: "application/json",
    errorStatuses: [400, 401, 403, 404, 429, 500, 503],
    errorSchema: ErrorResponseSchema,
  }),
  operation({
    operationId: "listEmailRoutes",
    method: "GET",
    path: "/email-routes",
    permissions: ["read"],
    idempotency: "not_required",
    successStatus: 200,
    successSchema: EmailRouteListSchema,
    successContentType: "application/json",
    errorStatuses: [401, 403, 429, 500, 503],
    errorSchema: ErrorResponseSchema,
  }),
  operation({
    operationId: "provisionEmailRoute",
    method: "POST",
    path: "/email-routes",
    permissions: ["manage"],
    idempotency: "required",
    bodySchema: ProvisionRouteRequestSchema,
    successStatus: 201,
    successSchema: EmailRouteEnvelopeSchema,
    successContentType: "application/json",
    errorStatuses: [400, 401, 403, 409, 422, 429, 500, 503],
    errorSchema: ErrorResponseSchema,
  }),
  ...["pause", "resume"].map((transition) =>
    operation({
      operationId: `${transition}EmailRoute`,
      method: "POST",
      path: `/email-routes/{route}/${transition}`,
      permissions: ["manage"],
      idempotency: "not_required",
      pathSchema: RoutePathSchema,
      parameters: RoutePathParameters,
      successStatus: 200,
      successSchema: EmailRouteEnvelopeSchema,
      successContentType: "application/json",
      errorStatuses: [400, 401, 403, 404, 409, 422, 429, 500, 503],
      errorSchema: ErrorResponseSchema,
    })
  ),
  operation({
    operationId: "rotateEmailRoute",
    method: "POST",
    path: "/email-routes/{route}/rotate",
    permissions: ["manage"],
    idempotency: "required",
    pathSchema: RoutePathSchema,
    parameters: RoutePathParameters,
    successStatus: 201,
    successSchema: RouteRotationSchema,
    successContentType: "application/json",
    errorStatuses: [400, 401, 403, 404, 409, 429, 500, 503],
    errorSchema: ErrorResponseSchema,
  }),
  operation({
    operationId: "disableEmailRoute",
    method: "DELETE",
    path: "/email-routes/{route}",
    permissions: ["manage"],
    idempotency: "not_required",
    pathSchema: RoutePathSchema,
    parameters: RoutePathParameters,
    successStatus: 200,
    successSchema: EmailRouteEnvelopeSchema,
    successContentType: "application/json",
    errorStatuses: [400, 401, 403, 404, 409, 429, 500, 503],
    errorSchema: ErrorResponseSchema,
  }),
  operation({
    operationId: "listEmailTestRecipients",
    method: "GET",
    path: "/email-test-recipients",
    permissions: ["read"],
    idempotency: "not_required",
    successStatus: 200,
    successSchema: EmailTestRecipientListSchema,
    successContentType: "application/json",
    errorStatuses: [401, 403, 429, 500, 503],
    errorSchema: ErrorResponseSchema,
  }),
  operation({
    operationId: "createEmailTestRecipient",
    method: "POST",
    path: "/email-test-recipients",
    permissions: ["manage"],
    idempotency: "required",
    bodySchema: AddTestRecipientRequestSchema,
    successStatus: 201,
    successSchema: EmailTestRecipientEnvelopeSchema,
    successContentType: "application/json",
    errorStatuses: [400, 401, 403, 409, 422, 429, 500, 503],
    errorSchema: ErrorResponseSchema,
  }),
  operation({
    operationId: "refreshEmailTestRecipient",
    method: "POST",
    path: "/email-test-recipients/{recipient}/refresh",
    permissions: ["manage"],
    idempotency: "required",
    pathSchema: TestRecipientPathSchema,
    parameters: TestRecipientPathParameters,
    successStatus: 200,
    successSchema: EmailTestRecipientEnvelopeSchema,
    successContentType: "application/json",
    errorStatuses: [400, 401, 403, 404, 409, 422, 429, 500, 503],
    errorSchema: ErrorResponseSchema,
  }),
] as const satisfies ReadonlyArray<Operation>
