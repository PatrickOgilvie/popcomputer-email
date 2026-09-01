import { Schema, type JsonSchema } from "effect"
import {
  IdempotencyHeaderSchema,
  operations,
  type ErrorStatus,
  type Method,
  type Operation,
  type OperationParameter,
  type Permissions,
} from "./contract.js"
import { ErrorResponseSchema } from "./errors.js"
import {
  EmailMessageEnvelopeSchema,
  EmailMessagePageSchema,
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

interface OpenApiMediaType {
  readonly schema: JsonSchema.JsonSchema
}

interface OpenApiContent {
  readonly "application/json"?: OpenApiMediaType
  readonly "application/octet-stream"?: OpenApiMediaType
  readonly "message/rfc822"?: OpenApiMediaType
}

interface OpenApiResponse {
  readonly description: string
  readonly content?: OpenApiContent
}

interface OpenApiResponses {
  readonly [status: string]: OpenApiResponse
}

interface MutableOpenApiResponses {
  [status: string]: OpenApiResponse
}

interface OpenApiRequestBody {
  readonly required: true
  readonly content: OpenApiContent
}

interface OpenApiParameter {
  readonly name: string
  readonly in: "header" | "path" | "query"
  readonly required: boolean
  readonly schema: JsonSchema.JsonSchema
}

interface OpenApiOperation {
  readonly operationId: string
  readonly tags: ReadonlyArray<string>
  readonly parameters: ReadonlyArray<OpenApiParameter>
  readonly requestBody?: OpenApiRequestBody
  readonly responses: OpenApiResponses
  readonly "x-popcomputer-permissions": Permissions
  readonly "x-popcomputer-idempotency": "required" | "not_required"
}

interface MutableOpenApiOperation {
  operationId: string
  tags: Array<string>
  parameters: Array<OpenApiParameter>
  requestBody?: OpenApiRequestBody
  responses: MutableOpenApiResponses
  "x-popcomputer-permissions": Permissions
  "x-popcomputer-idempotency": "required" | "not_required"
}

interface OpenApiPathItem {
  readonly get?: OpenApiOperation
  readonly post?: OpenApiOperation
  readonly delete?: OpenApiOperation
}

interface MutableOpenApiPathItem {
  get?: OpenApiOperation
  post?: OpenApiOperation
  delete?: OpenApiOperation
}

interface OpenApiTag {
  readonly name: string
}

interface OpenApiSecurityScheme {
  readonly type: "http"
  readonly scheme: "bearer"
  readonly bearerFormat: "token"
}

interface OpenApiComponents {
  readonly schemas: Readonly<Record<string, JsonSchema.JsonSchema>>
  readonly securitySchemes: {
    readonly bearerAuth: OpenApiSecurityScheme
  }
}

interface NamedSchema {
  readonly name: string
  readonly schema: Schema.Top
}

const NamedSchemas: ReadonlyArray<NamedSchema> = [
  { name: "ErrorResponse", schema: ErrorResponseSchema },
  { name: "SendEmailRequest", schema: SendEmailRequestSchema },
  { name: "ReplyEmailRequest", schema: ReplyEmailRequestSchema },
  { name: "EmailMessageEnvelope", schema: EmailMessageEnvelopeSchema },
  { name: "EmailMessagePage", schema: EmailMessagePageSchema },
  {
    name: "ReceivedContentEnvelope",
    schema: ReceivedContentEnvelopeSchema,
  },
  { name: "EmailRouteList", schema: EmailRouteListSchema },
  { name: "ProvisionRouteRequest", schema: ProvisionRouteRequestSchema },
  { name: "EmailRouteEnvelope", schema: EmailRouteEnvelopeSchema },
  { name: "RouteRotation", schema: RouteRotationSchema },
  { name: "EmailTestRecipientList", schema: EmailTestRecipientListSchema },
  { name: "AddTestRecipientRequest", schema: AddTestRecipientRequestSchema },
  {
    name: "EmailTestRecipientEnvelope",
    schema: EmailTestRecipientEnvelopeSchema,
  },
]

/** Deterministic OpenAPI 3.1 representation of the hosted email protocol. */
export interface OpenApiDocument {
  readonly openapi: "3.1.0"
  readonly jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema"
  readonly info: {
    readonly title: "Pop Computer Email API"
    readonly version: "1.0.0"
  }
  readonly tags: ReadonlyArray<OpenApiTag>
  readonly security: ReadonlyArray<{
    readonly bearerAuth: ReadonlyArray<string>
  }>
  readonly paths: Readonly<Record<string, OpenApiPathItem>>
  readonly components: OpenApiComponents
}

const encodedSchema = (schema: Schema.Top): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema)
  if (Object.keys(document.definitions).length === 0) {
    return document.schema
  }
  return {
    ...document.schema,
    $defs: document.definitions,
  }
}

const componentName = (schema: Schema.Top): string => {
  for (const namedSchema of NamedSchemas) {
    if (namedSchema.schema === schema) {
      return namedSchema.name
    }
  }
  throw new Error("OpenAPI schema is missing a stable component name")
}

const componentReference = (schema: Schema.Top): JsonSchema.JsonSchema => ({
  $ref: `#/components/schemas/${componentName(schema)}`,
})

const parameterDocument = (
  parameter: OperationParameter,
): OpenApiParameter => ({
  name: parameter.name,
  in: parameter.location,
  required: parameter.required,
  schema: encodedSchema(parameter.schema),
})

const statusDescription = (status: ErrorStatus): string => {
  switch (status) {
    case 400:
      return "Bad Request"
    case 401:
      return "Unauthorized"
    case 403:
      return "Forbidden"
    case 404:
      return "Not Found"
    case 409:
      return "Conflict"
    case 413:
      return "Payload Too Large"
    case 415:
      return "Unsupported Media Type"
    case 422:
      return "Unprocessable Content"
    case 429:
      return "Too Many Requests"
    case 500:
      return "Internal Server Error"
    case 503:
      return "Service Unavailable"
  }
}

const operationTag = (operation: Operation): string => {
  if (operation.path.startsWith("/email-routes")) {
    return "Email routes"
  }
  if (operation.path.startsWith("/email-test-recipients")) {
    return "Test recipients"
  }
  return "Emails"
}

const successContent = (operation: Operation): OpenApiContent => {
  if (operation.successContentType === "application/octet-stream") {
    return {
      "application/octet-stream": {
        schema: {
          type: "string",
          format: "binary",
          contentMediaType: "application/octet-stream",
        },
      },
    }
  }
  if (operation.successContentType === "message/rfc822") {
    return {
      "message/rfc822": {
        schema: {
          type: "string",
          format: "binary",
          contentMediaType: "message/rfc822",
        },
      },
    }
  }
  return {
    "application/json": {
      schema: componentReference(operation.successSchema),
    },
  }
}

const operationResponses = (
  operation: Operation,
): OpenApiResponses => {
  const responses: MutableOpenApiResponses = {
    [String(operation.successStatus)]: {
      description: "Success",
      content: successContent(operation),
    },
  }
  const errorContent: OpenApiContent = {
    "application/json": {
      schema: componentReference(operation.errorSchema),
    },
  }
  for (const status of operation.errorStatuses) {
    responses[String(status)] = {
      description: statusDescription(status),
      content: errorContent,
    }
  }
  return responses
}

const idempotencyParameter = (): OpenApiParameter => ({
  name: "idempotency-key",
  in: "header",
  required: true,
  schema: encodedSchema(
    IdempotencyHeaderSchema.fields["idempotency-key"],
  ),
})

const operationDocument = (operation: Operation): OpenApiOperation => {
  const parameters = operation.parameters?.map(parameterDocument) ?? []
  if (operation.idempotency === "required") {
    parameters.push(idempotencyParameter())
  }

  const document: MutableOpenApiOperation = {
    operationId: operation.operationId,
    tags: [operationTag(operation)],
    parameters,
    responses: operationResponses(operation),
    "x-popcomputer-permissions": operation.permissions,
    "x-popcomputer-idempotency": operation.idempotency,
  }
  if (operation.bodySchema !== undefined) {
    document.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: componentReference(operation.bodySchema),
        },
      },
    }
  }
  return document
}

const assignMethod = (
  pathItem: MutableOpenApiPathItem,
  method: Method,
  operation: OpenApiOperation,
): void => {
  switch (method) {
    case "GET":
      pathItem.get = operation
      return
    case "POST":
      pathItem.post = operation
      return
    case "DELETE":
      pathItem.delete = operation
      return
  }
}

/** Generate the OpenAPI document directly from the canonical operation registry. */
export const generateOpenApiDocument = (): OpenApiDocument => {
  const paths: Record<string, MutableOpenApiPathItem> = {}
  for (const operation of operations) {
    const pathItem = paths[operation.path] ?? {}
    assignMethod(pathItem, operation.method, operationDocument(operation))
    paths[operation.path] = pathItem
  }

  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Pop Computer Email API",
      version: "1.0.0",
    },
    tags: [
      { name: "Emails" },
      { name: "Email routes" },
      { name: "Test recipients" },
    ],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      schemas: Object.fromEntries(
        NamedSchemas.map(({ name, schema }) => [name, encodedSchema(schema)]),
      ),
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "token",
        },
      },
    },
  }
}

/** Render the generated protocol document with stable indentation and newline. */
export const renderOpenApiDocument = (): string =>
  `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`
