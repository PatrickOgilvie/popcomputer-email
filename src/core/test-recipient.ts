import { DateTime, Schema } from "effect"
import { ActorSchema } from "./actor.js"
import { EmailAddressSchema } from "./address.js"
import {
  DestinationIdSchema,
  IdempotencyKeySchema,
  TestRecipientIdSchema,
} from "./identifiers.js"
import { TestScopeSchema } from "./scope.js"

/** Provider verification state of a namespace-local test recipient. */
export const TestRecipientStateSchema = Schema.TaggedUnion({
  Pending: { requestedAt: Schema.DateTimeUtc },
  Verified: { verifiedAt: Schema.DateTimeUtc },
  Failed: {
    failedAt: Schema.DateTimeUtc,
    reason: Schema.Literals([
      "provider_rejected",
      "verification_expired",
      "destination_unavailable",
    ]),
  },
})

/** Provider verification state of a namespace-local test recipient. */
export type TestRecipientState = typeof TestRecipientStateSchema.Type

/** Test-environment grant for sending to one provider destination. */
export const TestRecipientSchema = Schema.Struct({
  id: TestRecipientIdSchema,
  scope: TestScopeSchema,
  destinationId: DestinationIdSchema,
  address: EmailAddressSchema,
  actor: ActorSchema,
  state: TestRecipientStateSchema,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
})

/** Test-environment grant for sending to one provider destination. */
export interface TestRecipient extends Schema.Schema.Type<
  typeof TestRecipientSchema
> {}

/** Pending test recipient that may become verified or failed. */
export type PendingTestRecipient = Omit<TestRecipient, "state"> & {
  readonly state: typeof TestRecipientStateSchema.cases.Pending.Type
}

/** Failed test recipient that may request verification again. */
export type FailedTestRecipient = Omit<TestRecipient, "state"> & {
  readonly state: typeof TestRecipientStateSchema.cases.Failed.Type
}

/** Verified test recipient permitted by outbound test-mode policy. */
export type VerifiedTestRecipient = Omit<TestRecipient, "state"> & {
  readonly state: typeof TestRecipientStateSchema.cases.Verified.Type
}

/** Parsed command for idempotently granting a test recipient. */
export const AddTestRecipientInputSchema = Schema.Struct({
  scope: TestScopeSchema,
  actor: ActorSchema,
  idempotencyKey: IdempotencyKeySchema,
  address: EmailAddressSchema,
})

/** Parsed command for idempotently granting a test recipient. */
export interface AddTestRecipientInput extends Schema.Schema.Type<
  typeof AddTestRecipientInputSchema
> {}

/** Parsed command for refreshing a pending or failed verification request. */
export const RefreshTestRecipientInputSchema = Schema.Struct({
  scope: TestScopeSchema,
  actor: ActorSchema,
  idempotencyKey: IdempotencyKeySchema,
  testRecipientId: TestRecipientIdSchema,
})

/** Parsed command for refreshing a pending or failed verification request. */
export interface RefreshTestRecipientInput extends Schema.Schema.Type<
  typeof RefreshTestRecipientInputSchema
> {}

/** Narrow a test recipient to a pending verification request. */
export const isPending = (
  recipient: TestRecipient,
): recipient is PendingTestRecipient => recipient.state._tag === "Pending"

/** Narrow a test recipient to a failed verification request. */
export const isFailed = (
  recipient: TestRecipient,
): recipient is FailedTestRecipient => recipient.state._tag === "Failed"

/** Narrow a test recipient to a verified outbound-policy grant. */
export const isVerified = (
  recipient: TestRecipient,
): recipient is VerifiedTestRecipient => recipient.state._tag === "Verified"

/** Mark a pending test recipient verified by its provider destination. */
export const markVerified = (
  recipient: PendingTestRecipient,
  verifiedAt: DateTime.Utc,
): VerifiedTestRecipient => ({
  ...recipient,
  state: TestRecipientStateSchema.cases.Verified.make({ verifiedAt }),
  updatedAt: verifiedAt,
})

/** Mark a pending test-recipient verification as failed. */
export const markFailed = (
  recipient: PendingTestRecipient,
  input: {
    readonly failedAt: DateTime.Utc
    readonly reason:
      | "provider_rejected"
      | "verification_expired"
      | "destination_unavailable"
  },
): FailedTestRecipient => ({
  ...recipient,
  state: TestRecipientStateSchema.cases.Failed.make(input),
  updatedAt: input.failedAt,
})

/** Start a fresh verification request for a failed recipient grant. */
export const refresh = (
  recipient: FailedTestRecipient,
  requestedAt: DateTime.Utc,
): PendingTestRecipient => ({
  ...recipient,
  state: TestRecipientStateSchema.cases.Pending.make({ requestedAt }),
  updatedAt: requestedAt,
})

/** A required namespace-local test-recipient grant was not found. */
export class TestRecipientNotFound extends Schema.TaggedError<
  TestRecipientNotFound
>()("TestRecipientNotFound", {
  testRecipientId: TestRecipientIdSchema,
  reason: Schema.Literal("not_found"),
}) {}

/** A matching add request is already executing under an active lease. */
export class TestRecipientAddInProgress extends Schema.TaggedError<
  TestRecipientAddInProgress
>()("TestRecipientAddInProgress", {
  reason: Schema.Literal("in_progress"),
}) {}

/** A destination exists but is not verified for test-mode delivery. */
export class TestRecipientNotVerified extends Schema.TaggedError<
  TestRecipientNotVerified
>()("TestRecipientNotVerified", {
  testRecipientId: TestRecipientIdSchema,
  reason: Schema.Literals(["pending", "failed"]),
}) {}
