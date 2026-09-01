import { Context, DateTime, Effect, Layer, Option } from "effect"
import { ContentDigest, type ContentDigestFailure } from "../adapters/content-digest.js"
import {
  DestinationRegistry,
  type DestinationRegistryFailure,
} from "../adapters/destination-registry.js"
import { IdentifierGenerator } from "../adapters/identifier-generator.js"
import {
  TestRecipientStore,
  type StoredTestRecipientAdd,
  type StoredTestRecipient,
  type TestRecipientStoreConflict,
  type TestRecipientStoreFailure,
} from "../adapters/test-recipient-store.js"
import { IdempotencyConflict } from "../core/email-command.js"
import {
  isFailed,
  isPending,
  isVerified,
  markFailed,
  markVerified,
  refresh as restartVerification,
  TestRecipientAddInProgress,
  TestRecipientSchema,
  TestRecipientStateSchema,
} from "../core/test-recipient.js"
import type {
  AddTestRecipientInput,
  RefreshTestRecipientInput,
  TestRecipient,
} from "../core/test-recipient.js"
import { TestRecipientNotFound } from "../core/test-recipient.js"
import type { TestScope } from "../core/scope.js"

/** Failures returned by namespace-local test-recipient management. */
export type TestRecipientServiceError =
  | ContentDigestFailure
  | DestinationRegistryFailure
  | IdempotencyConflict
  | TestRecipientAddInProgress
  | TestRecipientNotFound
  | TestRecipientStoreConflict
  | TestRecipientStoreFailure

const encoder = new TextEncoder()
const AddLeaseDurationMilliseconds = 5 * 60 * 1_000

type TestRecipientFingerprintInput =
  | {
      readonly operation: "add"
      readonly address: AddTestRecipientInput["address"]
    }
  | {
      readonly operation: "refresh"
      readonly testRecipientId: RefreshTestRecipientInput["testRecipientId"]
    }

const fingerprint = (value: TestRecipientFingerprintInput) =>
  Effect.flatMap(ContentDigest, (digest) =>
    digest.requestFingerprint(encoder.encode(JSON.stringify(value))))

const assertReplay = (
  stored: StoredTestRecipientAdd,
  expected: import("../core/identifiers.js").RequestFingerprint,
): Effect.Effect<TestRecipient, IdempotencyConflict> =>
  stored.fingerprint === expected
    ? Effect.succeed(stored.recipient)
    : Effect.fail(new IdempotencyConflict({ reason: "fingerprint_mismatch" }))

const assertRefreshReplay = (
  stored: StoredTestRecipient,
  testRecipientId: RefreshTestRecipientInput["testRecipientId"],
  key: RefreshTestRecipientInput["idempotencyKey"],
  expected: import("../core/identifiers.js").RequestFingerprint,
): Effect.Effect<TestRecipient, IdempotencyConflict> =>
  stored.recipient.id === testRecipientId &&
      stored.lastRefresh?.idempotencyKey === key &&
      stored.lastRefresh.fingerprint === expected
    ? Effect.succeed(stored.recipient)
    : Effect.fail(new IdempotencyConflict({ reason: "fingerprint_mismatch" }))

const refreshedState = (
  recipient: TestRecipient,
  providerStatus: "pending" | "verified" | "failed",
  now: DateTime.Utc,
): Pick<TestRecipient, "state" | "updatedAt"> => {
  if (isVerified(recipient)) {
    return { state: recipient.state, updatedAt: recipient.updatedAt }
  }
  const pending = isFailed(recipient)
    ? restartVerification(recipient, now)
    : recipient
  if (!isPending(pending)) {
    return { state: recipient.state, updatedAt: recipient.updatedAt }
  }
  if (providerStatus === "verified") {
    const verified = markVerified(pending, now)
    return { state: verified.state, updatedAt: verified.updatedAt }
  }
  if (providerStatus === "failed") {
    const failed = markFailed(pending, {
      failedAt: now,
      reason: "provider_rejected",
    })
    return { state: failed.state, updatedAt: failed.updatedAt }
  }
  return { state: pending.state, updatedAt: pending.updatedAt }
}

/** Effect service for Cloudflare-style verified test destinations. */
export class TestRecipientService extends Context.Service<
  TestRecipientService,
  {
    readonly add: (
      input: AddTestRecipientInput,
    ) => Effect.Effect<TestRecipient, TestRecipientServiceError>
    readonly refresh: (
      input: RefreshTestRecipientInput,
    ) => Effect.Effect<TestRecipient, TestRecipientServiceError>
    readonly list: (
      scope: TestScope,
    ) => Effect.Effect<ReadonlyArray<TestRecipient>, TestRecipientServiceError>
  }
>()("@popcomputer/email/TestRecipientService") {}

/** Build the test-recipient service from one provider and one scoped store. */
export const layer: Layer.Layer<
  TestRecipientService,
  never,
  ContentDigest | DestinationRegistry | IdentifierGenerator | TestRecipientStore
> = Layer.effect(
  TestRecipientService,
  Effect.gen(function*() {
    const digest = yield* ContentDigest
    const destinations = yield* DestinationRegistry
    const identifiers = yield* IdentifierGenerator
    const store = yield* TestRecipientStore

    return TestRecipientService.of({
      add: (input) => Effect.gen(function*() {
        const requestFingerprint = yield* fingerprint({
          operation: "add",
          address: input.address,
        })
        const claimedAt = yield* DateTime.now
        const leaseToken = yield* identifiers.leaseToken
        const claim = yield* store.claimAdd({
          scope: input.scope,
          address: input.address,
          idempotencyKey: input.idempotencyKey,
          fingerprint: requestFingerprint,
          leaseToken,
          claimedAt,
          leaseExpiresAt: DateTime.addDuration(
            claimedAt,
            AddLeaseDurationMilliseconds,
          ),
        })
        if (claim._tag === "Completed") {
          return yield* assertReplay(claim.add, requestFingerprint)
        }
        if (claim._tag === "Pending") {
          if (claim.fingerprint !== requestFingerprint) {
            return yield* new IdempotencyConflict({
              reason: "fingerprint_mismatch",
            })
          }
          return yield* new TestRecipientAddInProgress({
            reason: "in_progress",
          })
        }

        const release = DateTime.now.pipe(
          Effect.flatMap((releasedAt) => store.releaseAdd({
            scope: input.scope,
            idempotencyKey: input.idempotencyKey,
            fingerprint: requestFingerprint,
            leaseToken,
            releasedAt,
          })),
          Effect.catch(() => Effect.void),
        )

        return yield* Effect.gen(function*() {
          const destination = yield* destinations.create(input.address).pipe(
            Effect.catchTag("DestinationRegistryFailure", (providerFailure) =>
              Effect.gen(function*() {
                if (providerFailure.reason !== "duplicate") {
                  return yield* providerFailure
                }
                const reconciled = yield* destinations.findByAddress(input.address)
                if (Option.isNone(reconciled)) return yield* providerFailure
                return reconciled.value
              })),
          )
          const now = yield* DateTime.now
          const state = destination.status === "verified"
            ? TestRecipientStateSchema.cases.Verified.make({ verifiedAt: now })
            : destination.status === "failed"
            ? TestRecipientStateSchema.cases.Failed.make({
                failedAt: now,
                reason: "provider_rejected",
              })
            : TestRecipientStateSchema.cases.Pending.make({ requestedAt: now })
          const recipient = TestRecipientSchema.make({
            id: yield* identifiers.testRecipientId,
            scope: input.scope,
            destinationId: destination.id,
            address: destination.address,
            actor: input.actor,
            state,
            createdAt: now,
            updatedAt: now,
          })
          const completed = yield* store.completeAdd({
            recipient,
            idempotencyKey: input.idempotencyKey,
            fingerprint: requestFingerprint,
            leaseToken,
          })
          return yield* assertReplay(completed, requestFingerprint)
        }).pipe(Effect.ensuring(release))
      }).pipe(Effect.provideService(ContentDigest, digest)),
      refresh: (input) => Effect.gen(function*() {
        const requestFingerprint = yield* fingerprint({
          operation: "refresh",
          testRecipientId: input.testRecipientId,
        })
        const replay = yield* store.findRefreshByIdempotency(
          input.scope,
          input.idempotencyKey,
        )
        if (Option.isSome(replay)) {
          return yield* assertRefreshReplay(
            replay.value,
            input.testRecipientId,
            input.idempotencyKey,
            requestFingerprint,
          )
        }
        const found = yield* store.findById(input.scope, input.testRecipientId)
        if (Option.isNone(found)) {
          return yield* new TestRecipientNotFound({
            testRecipientId: input.testRecipientId,
            reason: "not_found",
          })
        }
        if (found.value.lastRefresh?.idempotencyKey === input.idempotencyKey) {
          return yield* assertRefreshReplay(
            found.value,
            input.testRecipientId,
            input.idempotencyKey,
            requestFingerprint,
          )
        }
        const current = found.value.recipient
        const providerStatus = isVerified(current)
          ? "verified" as const
          : (yield* destinations.get(current.destinationId)).status
        const now = yield* DateTime.now
        const next = refreshedState(current, providerStatus, now)
        const refreshed = yield* store.refresh({
          scope: input.scope,
          testRecipientId: input.testRecipientId,
          state: next.state,
          idempotencyKey: input.idempotencyKey,
          fingerprint: requestFingerprint,
          updatedAt: next.updatedAt,
        })
        return yield* assertRefreshReplay(
          refreshed,
          input.testRecipientId,
          input.idempotencyKey,
          requestFingerprint,
        )
      }).pipe(Effect.provideService(ContentDigest, digest)),
      list: (scope) => store.list(scope),
    })
  }),
)
