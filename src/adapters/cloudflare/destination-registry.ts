import { Effect, Layer, Option, Schema } from "effect"
import {
  DestinationRegistry,
  DestinationRegistryFailure,
  type Destination,
} from "../destination-registry.js"
import { EmailAddressSchema, type EmailAddress } from "../../core/address.js"
import { DestinationIdSchema, type DestinationId } from "../../core/identifiers.js"
import {
  cloudflareAccountUrl,
  cloudflareAuthorizationHeaders,
  hasUsableCloudflareEmailConfig,
  type CloudflareEmailApiConfig,
  type CloudflareFetch,
} from "./config.js"

/** Cloudflare error code for the account destination-address quota. */
export const CloudflareDestinationQuotaExceededCode = 10005

/** Cloudflare error code for an already registered destination address. */
export const CloudflareDestinationDuplicateCode = 10006

/** Cloudflare error code for a missing destination address. */
export const CloudflareDestinationNotFoundCode = 10007

const ProviderIssueSchema = Schema.Struct({
  code: Schema.Number.check(Schema.isInt()),
  message: Schema.String,
  documentation_url: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.Struct({
    pointer: Schema.optionalKey(Schema.String),
  })),
})

const ProviderEnvelopeSchema = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.Array(ProviderIssueSchema),
  messages: Schema.Array(ProviderIssueSchema),
  result: Schema.Unknown,
})

const ProviderDestinationSchema = Schema.Struct({
  id: Schema.optionalKey(DestinationIdSchema),
  tag: Schema.optionalKey(DestinationIdSchema),
  email: EmailAddressSchema,
  created: Schema.optionalKey(Schema.DateTimeUtcFromString),
  modified: Schema.optionalKey(Schema.DateTimeUtcFromString),
  verified: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtcFromString)),
})

const ProviderResultInfoSchema = Schema.Struct({
  page: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  per_page: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  count: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  total_count: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  total_pages: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
})

const ProviderDestinationListEnvelopeSchema = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.Array(ProviderIssueSchema),
  messages: Schema.Array(ProviderIssueSchema),
  result: Schema.Array(ProviderDestinationSchema),
  result_info: Schema.optionalKey(ProviderResultInfoSchema),
})

type DestinationOperation = "create" | "find_by_address" | "get"

const failure = (
  operation: DestinationOperation,
  reason:
    | "quota_exceeded"
    | "duplicate"
    | "not_found"
    | "provider_rejected"
    | "unavailable"
    | "invalid_response",
): DestinationRegistryFailure =>
  new DestinationRegistryFailure({ operation, reason })

const classifyProviderFailure = (
  operation: DestinationOperation,
  status: number,
  code: number | undefined,
): DestinationRegistryFailure => {
  if (code === CloudflareDestinationQuotaExceededCode || status === 429) {
    return failure(operation, "quota_exceeded")
  }
  if (code === CloudflareDestinationDuplicateCode) {
    return failure(operation, "duplicate")
  }
  if (
    code === CloudflareDestinationNotFoundCode ||
    ((operation === "get" || operation === "find_by_address") && status === 404)
  ) {
    return failure(operation, "not_found")
  }
  if (status >= 500) return failure(operation, "unavailable")
  if (status >= 400) return failure(operation, "provider_rejected")
  if (code !== undefined) return failure(operation, "provider_rejected")
  return failure(operation, "invalid_response")
}

const parseResponse = Effect.fn("Email.Cloudflare.Destination.parseResponse")(
  function*(operation: DestinationOperation, response: Response) {
    const body = yield* Effect.tryPromise({
      try: async () => {
        const value: unknown = await response.json()
        return value
      },
      catch: () => classifyProviderFailure(operation, response.status, undefined),
    })
    const envelope = yield* Schema.decodeUnknownEffect(ProviderEnvelopeSchema)(
      body,
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError(() =>
        classifyProviderFailure(operation, response.status, undefined)),
    )
    const firstCode = envelope.errors[0]?.code
    if (
      response.status < 200 ||
      response.status >= 300 ||
      !envelope.success ||
      envelope.errors.length > 0
    ) {
      return yield* classifyProviderFailure(
        operation,
        response.status,
        firstCode,
      )
    }
    const result = yield* Schema.decodeUnknownEffect(ProviderDestinationSchema)(
      envelope.result,
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError(() => failure(operation, "invalid_response")),
    )
    const id = result.id ?? result.tag
    if (
      id === undefined ||
      (result.id !== undefined &&
        result.tag !== undefined &&
        result.id !== result.tag)
    ) {
      return yield* failure(operation, "invalid_response")
    }
    const destination: Destination = {
      id,
      address: result.email,
      status: result.verified === undefined || result.verified === null
        ? "pending"
        : "verified",
    }
    return destination
  },
)

const parseListResponse = Effect.fn(
  "Email.Cloudflare.Destination.parseListResponse",
)(function*(response: Response) {
  const operation = "find_by_address" as const
  const body = yield* Effect.tryPromise({
    try: async () => {
      const value: unknown = await response.json()
      return value
    },
    catch: () => classifyProviderFailure(operation, response.status, undefined),
  })
  const envelope = yield* Schema.decodeUnknownEffect(
    ProviderDestinationListEnvelopeSchema,
  )(body, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() =>
      classifyProviderFailure(operation, response.status, undefined)),
  )
  const firstCode = envelope.errors[0]?.code
  if (
    response.status < 200 ||
    response.status >= 300 ||
    !envelope.success ||
    envelope.errors.length > 0
  ) {
    return yield* classifyProviderFailure(
      operation,
      response.status,
      firstCode,
    )
  }
  const destinations = yield* Effect.forEach(envelope.result, (result) =>
    Effect.gen(function*() {
      const id = result.id ?? result.tag
      if (
        id === undefined ||
        (result.id !== undefined &&
          result.tag !== undefined &&
          result.id !== result.tag)
      ) {
        return yield* failure(operation, "invalid_response")
      }
      const destination: Destination = {
        id,
        address: result.email,
        status: result.verified === undefined || result.verified === null
          ? "pending"
          : "verified",
      }
      return destination
    }))
  return {
    destinations,
    totalPages: envelope.result_info?.total_pages,
  }
})

const request = Effect.fn("Email.Cloudflare.Destination.request")(function*(
  operation: DestinationOperation,
  config: CloudflareEmailApiConfig,
  fetchFn: CloudflareFetch,
  id: DestinationId | undefined,
  address: EmailAddress | undefined,
) {
  if (!hasUsableCloudflareEmailConfig(config)) {
    return yield* failure(operation, "unavailable")
  }
  const path = id === undefined
    ? "email/routing/addresses"
    : `email/routing/addresses/${encodeURIComponent(id)}`
  const headers = cloudflareAuthorizationHeaders(config)
  if (operation === "create") headers.set("Content-Type", "application/json")
  const init: RequestInit = address === undefined
    ? {
        method: operation === "create" ? "POST" : "GET",
        headers,
      }
    : {
        method: operation === "create" ? "POST" : "GET",
        headers,
        body: JSON.stringify({ email: address }),
      }
  const response = yield* Effect.tryPromise({
    try: (signal) => fetchFn(
      cloudflareAccountUrl(config, path),
      { ...init, signal },
    ),
    catch: () => failure(operation, "unavailable"),
  })
  const destination = yield* parseResponse(operation, response)
  if (address !== undefined && destination.address !== address) {
    return yield* failure(operation, "invalid_response")
  }
  return destination
})

const findByAddress = Effect.fn(
  "Email.Cloudflare.Destination.findByAddress",
)(function*(
  config: CloudflareEmailApiConfig,
  fetchFn: CloudflareFetch,
  address: EmailAddress,
) {
  const operation = "find_by_address" as const
  if (!hasUsableCloudflareEmailConfig(config)) {
    return yield* failure(operation, "unavailable")
  }
  const headers = cloudflareAuthorizationHeaders(config)
  const perPage = 50
  const maxPages = 100

  const visit = (
    page: number,
    priorMatch: Destination | undefined,
  ): Effect.Effect<
    Option.Option<Destination>,
    DestinationRegistryFailure
  > => Effect.gen(function*() {
    const response = yield* Effect.tryPromise({
      try: (signal) => fetchFn(
        cloudflareAccountUrl(
          config,
          `email/routing/addresses?direction=asc&page=${page}&per_page=${perPage}`,
        ),
        { method: "GET", headers, signal },
      ),
      catch: () => failure(operation, "unavailable"),
    })
    const parsed = yield* parseListResponse(response)
    const matches = parsed.destinations.filter(
      (destination) => destination.address === address,
    )
    if (matches.length > 1 || (priorMatch !== undefined && matches.length > 0)) {
      return yield* failure(operation, "invalid_response")
    }
    const match = matches[0] ?? priorMatch
    const providerHasNext = parsed.totalPages === undefined
      ? parsed.destinations.length === perPage
      : page < parsed.totalPages
    if (
      parsed.totalPages !== undefined &&
      page < parsed.totalPages &&
      parsed.destinations.length < perPage
    ) {
      return yield* failure(operation, "invalid_response")
    }
    if (!providerHasNext) {
      return match === undefined ? Option.none() : Option.some(match)
    }
    if (page >= maxPages) {
      return yield* failure(operation, "unavailable")
    }
    return yield* Effect.suspend(() => visit(page + 1, match))
  })

  return yield* visit(1, undefined)
})

/** Build the Cloudflare Email Routing verified-destination service. */
export const makeCloudflareDestinationRegistry = (
  config: CloudflareEmailApiConfig,
  fetchFn: CloudflareFetch = globalThis.fetch,
): DestinationRegistry["Service"] => DestinationRegistry.of({
  create: (address) => request("create", config, fetchFn, undefined, address),
  get: (id) => request("get", config, fetchFn, id, undefined),
  findByAddress: (address) => findByAddress(config, fetchFn, address),
})

/** Provide DestinationRegistry through Cloudflare Email Routing REST APIs. */
export const cloudflareDestinationRegistryLayer = (
  config: CloudflareEmailApiConfig,
  fetchFn: CloudflareFetch = globalThis.fetch,
): Layer.Layer<DestinationRegistry> => Layer.succeed(
  DestinationRegistry,
  makeCloudflareDestinationRegistry(config, fetchFn),
)
