import { Schema } from "effect"
import { ErrorCodeSchema } from "../protocol/errors.js"

/** Hosted API rejected the configured access token. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "EmailClient.Unauthorized",
  { reason: Schema.Literal("unauthorized") },
) {}

/** Hosted API denied the requested email capability. */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "EmailClient.Forbidden",
  { reason: Schema.Literal("forbidden") },
) {}

/** Requested hosted email resource did not exist in the token scope. */
export class NotFound extends Schema.TaggedError<NotFound>()(
  "EmailClient.NotFound",
  { reason: Schema.Literal("not_found") },
) {}

/** Hosted command conflicted with an existing idempotency or lifecycle record. */
export class Conflict extends Schema.TaggedError<Conflict>()(
  "EmailClient.Conflict",
  { code: ErrorCodeSchema },
) {}

/** Hosted API rejected a syntactically valid request under domain policy. */
export class RequestRejected extends Schema.TaggedError<RequestRejected>()(
  "EmailClient.RequestRejected",
  {
    status: Schema.Number.check(Schema.isInt()),
    code: ErrorCodeSchema,
  },
) {}

/** Caller input could not be encoded into the package-owned HTTP contract. */
export class InvalidClientRequest extends Schema.TaggedError<
  InvalidClientRequest
>()("EmailClient.InvalidClientRequest", {
  reason: Schema.Literals(["invalid_body", "invalid_query"]),
}) {}

/** Hosted API asked the client to defer a safe read request. */
export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "EmailClient.RateLimited",
  {
    retryAfterMilliseconds: Schema.optionalKey(
      Schema.Number.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(0),
      ),
    ),
  },
) {}

/** Hosted service or network was unavailable before a valid response arrived. */
export class RemoteUnavailable extends Schema.TaggedError<RemoteUnavailable>()(
  "EmailClient.RemoteUnavailable",
  {
    reason: Schema.Literals(["network", "server"]),
    status: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  },
) {}

/** Hosted response did not satisfy the package-owned protocol contract. */
export class InvalidRemoteResponse extends Schema.TaggedError<
  InvalidRemoteResponse
>()("EmailClient.InvalidRemoteResponse", {
  reason: Schema.Literals([
    "invalid_json",
    "invalid_body",
    "unexpected_status",
    "unexpected_content_type",
    "invalid_header",
    "missing_body",
  ]),
}) {}

/** Caller-owned cancellation interrupted the hosted request. */
export class RequestCancelled extends Schema.TaggedError<RequestCancelled>()(
  "EmailClient.RequestCancelled",
  { reason: Schema.Literal("cancelled") },
) {}

/** Failures returned by ordinary hosted JSON operations. */
export type ClientError =
  | Unauthorized
  | Forbidden
  | NotFound
  | Conflict
  | InvalidClientRequest
  | RequestRejected
  | RateLimited
  | RemoteUnavailable
  | InvalidRemoteResponse
  | RequestCancelled
