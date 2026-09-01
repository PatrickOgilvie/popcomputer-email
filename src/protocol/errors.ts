import { Schema } from "effect"

/** Stable machine-readable error codes returned by the hosted email API. */
export const ErrorCodeSchema = Schema.Literals([
  "invalid_request",
  "invalid_idempotency_key",
  "unauthorized",
  "forbidden",
  "not_found",
  "idempotency_conflict",
  "transition_conflict",
  "message_too_large",
  "unsupported_media_type",
  "validation_failed",
  "recipient_not_permitted",
  "route_inactive",
  "route_not_sendable",
  "rate_limited",
  "service_unavailable",
  "internal_error",
])

/** Stable machine-readable error code returned by the hosted email API. */
export type ErrorCode = typeof ErrorCodeSchema.Type

/** Safe hosted API error with no dependency cause or rejected payload. */
export const ErrorResponseSchema = Schema.Struct({
  error: Schema.Struct({
    code: ErrorCodeSchema,
    message: Schema.String.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(500),
    ),
    requestId: Schema.optionalKey(
      Schema.Trimmed.check(
        Schema.isNonEmpty(),
        Schema.isMaxLength(200),
      ),
    ),
  }),
})

/** Safe hosted API error with no dependency cause or rejected payload. */
export interface ErrorResponse extends Schema.Schema.Type<
  typeof ErrorResponseSchema
> {}
