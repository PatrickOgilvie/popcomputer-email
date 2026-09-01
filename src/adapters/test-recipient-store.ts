import { Context, Effect, Option, Schema } from "effect"
import type { EmailAddress } from "../core/address.js"
import type {
  IdempotencyKey,
  RequestFingerprint,
  TestRecipientId,
} from "../core/identifiers.js"
import { TestRecipientIdSchema } from "../core/identifiers.js"
import type { TestScope } from "../core/scope.js"
import type {
  TestRecipient,
  TestRecipientState,
} from "../core/test-recipient.js"

/** Named test-recipient persistence operation safe for diagnostics. */
export const TestRecipientStoreOperationSchema = Schema.Literals([
  "find_idempotency",
  "find_refresh_idempotency",
  "find_address",
  "find_id",
  "claim_add",
  "complete_add",
  "release_add",
  "refresh",
  "list",
])

/** Named test-recipient persistence operation safe for diagnostics. */
export type TestRecipientStoreOperation =
  typeof TestRecipientStoreOperationSchema.Type

/** Test-recipient persistence could not complete an operation. */
export class TestRecipientStoreFailure extends Schema.TaggedError<
  TestRecipientStoreFailure
>()("TestRecipientStoreFailure", {
  operation: TestRecipientStoreOperationSchema,
  reason: Schema.Literal("unavailable"),
}) {}

/** A scoped test-recipient update lost an optimistic race. */
export class TestRecipientStoreConflict extends Schema.TaggedError<
  TestRecipientStoreConflict
>()("TestRecipientStoreConflict", {
  testRecipientId: TestRecipientIdSchema,
  reason: Schema.Literal("concurrent_update"),
}) {}

/** Test-recipient plus mutation fingerprints retained only for safe replay. */
export interface StoredTestRecipient {
  readonly recipient: TestRecipient
  readonly creationFingerprint: RequestFingerprint
  readonly lastRefresh:
    | {
        readonly idempotencyKey: IdempotencyKey
        readonly fingerprint: RequestFingerprint
      }
    | undefined
}

/** Immutable outcome retained for one scoped add idempotency key. */
export interface StoredTestRecipientAdd {
  readonly recipient: TestRecipient
  readonly fingerprint: RequestFingerprint
}

/** Lease-backed reservation made before an add reaches its provider. */
export interface ClaimTestRecipientAddInput {
  readonly scope: TestScope
  readonly address: EmailAddress
  readonly idempotencyKey: IdempotencyKey
  readonly fingerprint: RequestFingerprint
  readonly leaseToken: import("../core/identifiers.js").LeaseToken
  readonly claimedAt: import("effect").DateTime.Utc
  readonly leaseExpiresAt: import("effect").DateTime.Utc
}

/** Outcome of atomically claiming one add identity. */
export type ClaimTestRecipientAddResult =
  | { readonly _tag: "Claimed" }
  | {
      readonly _tag: "Pending"
      readonly fingerprint: RequestFingerprint
    }
  | {
      readonly _tag: "Completed"
      readonly add: StoredTestRecipientAdd
    }

/** Complete a claimed add with its durable recipient outcome. */
export interface CompleteTestRecipientAddInput {
  readonly recipient: TestRecipient
  readonly idempotencyKey: IdempotencyKey
  readonly fingerprint: RequestFingerprint
  readonly leaseToken: import("../core/identifiers.js").LeaseToken
}

/** Release a typed add failure so the same request can recover immediately. */
export interface ReleaseTestRecipientAddInput {
  readonly scope: TestScope
  readonly idempotencyKey: IdempotencyKey
  readonly fingerprint: RequestFingerprint
  readonly leaseToken: import("../core/identifiers.js").LeaseToken
  readonly releasedAt: import("effect").DateTime.Utc
}

/** Atomic refresh projection. */
export interface RefreshTestRecipientStoreInput {
  readonly scope: TestScope
  readonly testRecipientId: TestRecipientId
  readonly state: TestRecipientState
  readonly idempotencyKey: IdempotencyKey
  readonly fingerprint: RequestFingerprint
  readonly updatedAt: import("effect").DateTime.Utc
}

/** Scoped persistence for namespace-local test destination grants. */
export class TestRecipientStore extends Context.Service<TestRecipientStore, {
  readonly findByIdempotency: (
    scope: TestScope,
    key: IdempotencyKey,
  ) => Effect.Effect<Option.Option<StoredTestRecipientAdd>, TestRecipientStoreFailure>
  readonly findByAddress: (
    scope: TestScope,
    address: EmailAddress,
  ) => Effect.Effect<Option.Option<StoredTestRecipient>, TestRecipientStoreFailure>
  readonly findRefreshByIdempotency: (
    scope: TestScope,
    key: IdempotencyKey,
  ) => Effect.Effect<Option.Option<StoredTestRecipient>, TestRecipientStoreFailure>
  readonly findById: (
    scope: TestScope,
    id: TestRecipientId,
  ) => Effect.Effect<Option.Option<StoredTestRecipient>, TestRecipientStoreFailure>
  readonly claimAdd: (
    input: ClaimTestRecipientAddInput,
  ) => Effect.Effect<ClaimTestRecipientAddResult, TestRecipientStoreFailure>
  readonly completeAdd: (
    input: CompleteTestRecipientAddInput,
  ) => Effect.Effect<StoredTestRecipientAdd, TestRecipientStoreFailure>
  readonly releaseAdd: (
    input: ReleaseTestRecipientAddInput,
  ) => Effect.Effect<void, TestRecipientStoreFailure>
  readonly refresh: (
    input: RefreshTestRecipientStoreInput,
  ) => Effect.Effect<
    StoredTestRecipient,
    TestRecipientStoreConflict | TestRecipientStoreFailure
  >
  readonly list: (
    scope: TestScope,
  ) => Effect.Effect<ReadonlyArray<TestRecipient>, TestRecipientStoreFailure>
}>()("@popcomputer/email/TestRecipientStore") {}
