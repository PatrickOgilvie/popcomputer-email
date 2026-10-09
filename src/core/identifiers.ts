import { Schema } from "effect"

const OpaqueIdentifierSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
)

const hasNoAsciiControlCharacters = (value: string): boolean =>
  Array.from(value).every((character) => {
    const code = character.charCodeAt(0)
    return code >= 32 && code !== 127
  })

/** Stable host-owned partition used to isolate every package operation. */
export const NamespaceSchema = OpaqueIdentifierSchema.pipe(
  Schema.brand("EmailNamespace"),
)

/** Stable host-owned partition used to isolate every package operation. */
export type Namespace = typeof NamespaceSchema.Type

/** Opaque identity for the actor responsible for a mutation. */
export const ActorIdSchema = OpaqueIdentifierSchema.pipe(
  Schema.brand("EmailActorId"),
)

/** Opaque identity for the actor responsible for a mutation. */
export type ActorId = typeof ActorIdSchema.Type

/** Stable identity of one email message. */
export const MessageIdSchema = OpaqueIdentifierSchema.pipe(
  Schema.brand("EmailMessageId"),
)

/** Stable identity of one email message. */
export type MessageId = typeof MessageIdSchema.Type

/** Stable identity of one persisted message recipient. */
export const RecipientIdSchema = OpaqueIdentifierSchema.pipe(
  Schema.brand("EmailRecipientId"),
)

/** Stable identity of one persisted message recipient. */
export type RecipientId = typeof RecipientIdSchema.Type

/** Stable identity of one inbound or outbound route. */
export const RouteIdSchema = OpaqueIdentifierSchema.pipe(
  Schema.brand("EmailRouteId"),
)

/** Stable identity of one inbound or outbound route. */
export type RouteId = typeof RouteIdSchema.Type

/** Opaque identity of a host-owned workflow definition. */
export const WorkflowIdSchema = OpaqueIdentifierSchema.pipe(
  Schema.brand("EmailWorkflowId"),
)

/** Opaque identity of a host-owned workflow definition. */
export type WorkflowId = typeof WorkflowIdSchema.Type

/** Stable identity of one durable workflow-trigger event. */
export const WorkflowEventIdSchema = OpaqueIdentifierSchema.pipe(
  Schema.brand("EmailWorkflowEventId"),
)

/** Stable identity of one durable workflow-trigger event. */
export type WorkflowEventId = typeof WorkflowEventIdSchema.Type

/** Stable identity returned by the host workflow runtime. */
export const WorkflowRunIdSchema = OpaqueIdentifierSchema.pipe(
  Schema.brand("EmailWorkflowRunId"),
)

/** Stable identity returned by the host workflow runtime. */
export type WorkflowRunId = typeof WorkflowRunIdSchema.Type

/** Exclusive ownership token for one leased maintenance or workflow item. */
export const LeaseTokenSchema = OpaqueIdentifierSchema.pipe(
  Schema.brand("EmailLeaseToken"),
)

/** Exclusive ownership token for one leased maintenance or workflow item. */
export type LeaseToken = typeof LeaseTokenSchema.Type

/** Opaque reference to raw MIME in an archive adapter. */
export const RawMessageRefSchema = OpaqueIdentifierSchema.pipe(
  Schema.brand("EmailRawMessageRef"),
)

/** Opaque reference to raw MIME in an archive adapter. */
export type RawMessageRef = typeof RawMessageRefSchema.Type

/** Opaque identity of a provider-level recipient destination. */
export const DestinationIdSchema = OpaqueIdentifierSchema.pipe(
  Schema.brand("EmailDestinationId"),
)

/** Opaque identity of a provider-level recipient destination. */
export type DestinationId = typeof DestinationIdSchema.Type

/** Stable identity of one namespace-local test-recipient grant. */
export const TestRecipientIdSchema = OpaqueIdentifierSchema.pipe(
  Schema.brand("EmailTestRecipientId"),
)

/** Stable identity of one namespace-local test-recipient grant. */
export type TestRecipientId = typeof TestRecipientIdSchema.Type

/** Caller-selected key that makes one mutation safely replayable. */
export const IdempotencyKeySchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[\x21-\x7e]+$/u),
).pipe(Schema.brand("EmailIdempotencyKey"))

/** Caller-selected key that makes one mutation safely replayable. */
export type IdempotencyKey = typeof IdempotencyKeySchema.Type

/** SHA-256 digest of a canonical mutation request. */
export const RequestFingerprintSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u),
).pipe(Schema.brand("EmailRequestFingerprint"))

/** SHA-256 digest of a canonical mutation request. */
export type RequestFingerprint = typeof RequestFingerprintSchema.Type

/** Lowercase hexadecimal SHA-256 digest of raw content. */
export const Sha256Schema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u),
).pipe(Schema.brand("EmailSha256"))

/** Lowercase hexadecimal SHA-256 digest of raw content. */
export type Sha256 = typeof Sha256Schema.Type

/** Opaque continuation cursor issued by a message listing operation. */
export const PageCursorSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(2_048),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
).pipe(Schema.brand("EmailPageCursor"))

/** Opaque continuation cursor issued by a message listing operation. */
export type PageCursor = typeof PageCursorSchema.Type

/** Default number of messages returned by one paginated read. */
export const DefaultPageSize = 50

/** Maximum number of messages accepted by one paginated read. */
export const MaximumPageSize = 100

/** A caller supplied a page cursor or limit that cannot be evaluated safely. */
export class InvalidPageRequest extends Schema.TaggedError<InvalidPageRequest>()(
  "InvalidPageRequest",
  {
    reason: Schema.Literals(["invalid_cursor", "invalid_limit"]),
  },
) {}

/** Provider-owned message identity retained for diagnostics and reconciliation. */
export const ProviderMessageIdSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(998),
  Schema.makeFilter(hasNoAsciiControlCharacters, {
    title: "EmailProviderMessageId",
  }),
).pipe(Schema.brand("EmailProviderMessageId"))

/** Provider-owned message identity retained for diagnostics and reconciliation. */
export type ProviderMessageId = typeof ProviderMessageIdSchema.Type
