import { DateTime, Effect, Option, Schema } from "effect"
import {
  TestRecipientStore,
  TestRecipientStoreConflict,
  TestRecipientStoreFailure,
  type ClaimTestRecipientAddInput,
  type ClaimTestRecipientAddResult,
  type CompleteTestRecipientAddInput,
  type RefreshTestRecipientStoreInput,
  type ReleaseTestRecipientAddInput,
  type StoredTestRecipientAdd,
  type StoredTestRecipient,
  type TestRecipientStoreOperation,
} from "../../adapters/test-recipient-store.js"
import {
  EmailAddressSchema,
} from "../../core/address.js"
import {
  IdempotencyKeySchema,
  LeaseTokenSchema,
  RequestFingerprintSchema,
  TestRecipientIdSchema,
} from "../../core/identifiers.js"
import {
  TestRecipientSchema,
  type TestRecipient,
  type TestRecipientState,
} from "../../core/test-recipient.js"
import type { TestScope } from "../../core/scope.js"
import type {
  D1Database,
  D1ExecutionResult,
  D1PreparedStatement,
} from "./contract.js"

const GrantsTable = "popcomputer_email_test_recipient_grants"
const DestinationsTable = "popcomputer_email_cf_destinations"
const AddsTable = "popcomputer_email_test_recipient_adds"
const RefreshesTable = "popcomputer_email_test_recipient_refreshes"

/** Account-global identity needed to mirror provider destinations safely. */
export interface D1TestRecipientStoreConfig {
  readonly providerAccountKey: string
}

const GrantProjection = `
  g.id,
  g.namespace,
  g.environment,
  g.destination_id,
  d.address,
  g.idempotency_key,
  g.request_fingerprint,
  g.last_refresh_idempotency_key,
  g.last_refresh_fingerprint,
  g.state,
  g.state_at,
  g.failure_reason,
  g.actor_kind,
  g.actor_id,
  g.created_at,
  g.updated_at`

const RefreshProjection = `
  g.id,
  g.namespace,
  g.environment,
  g.destination_id,
  d.address,
  g.idempotency_key,
  g.request_fingerprint,
  r.idempotency_key AS last_refresh_idempotency_key,
  r.request_fingerprint AS last_refresh_fingerprint,
  r.state,
  r.state_at,
  r.failure_reason,
  g.actor_kind,
  g.actor_id,
  g.created_at,
  r.state_at AS updated_at`

const AddProjection = `
  g.id,
  g.namespace,
  g.environment,
  g.destination_id,
  d.address,
  a.idempotency_key,
  a.request_fingerprint,
  NULL AS last_refresh_idempotency_key,
  NULL AS last_refresh_fingerprint,
  a.state,
  a.state_at,
  a.failure_reason,
  g.actor_kind,
  g.actor_id,
  g.created_at,
  a.state_at AS updated_at`

const EpochMillisSchema = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
)

const GrantRowSchema = Schema.Struct({
  id: Schema.String,
  namespace: Schema.String,
  environment: Schema.String,
  destination_id: Schema.String,
  address: Schema.String,
  idempotency_key: Schema.String,
  request_fingerprint: Schema.String,
  last_refresh_idempotency_key: Schema.NullOr(Schema.String),
  last_refresh_fingerprint: Schema.NullOr(Schema.String),
  state: Schema.String,
  state_at: EpochMillisSchema,
  failure_reason: Schema.NullOr(Schema.String),
  actor_kind: Schema.String,
  actor_id: Schema.String,
  created_at: EpochMillisSchema,
  updated_at: EpochMillisSchema,
})

type GrantRow = typeof GrantRowSchema.Type

const AddIdentityRowSchema = Schema.Struct({
  request_fingerprint: RequestFingerprintSchema,
  address: EmailAddressSchema,
  status: Schema.Literals(["pending", "completed"]),
  test_recipient_id: Schema.NullOr(TestRecipientIdSchema),
  lease_token: Schema.NullOr(LeaseTokenSchema),
  lease_expires_at: Schema.NullOr(EpochMillisSchema),
})

type AddIdentityRow = typeof AddIdentityRowSchema.Type

const failure = (
  operation: TestRecipientStoreOperation,
): TestRecipientStoreFailure => new TestRecipientStoreFailure({
  operation,
  reason: "unavailable",
})

const readFirst = (
  database: D1Database,
  query: string,
  values: ReadonlyArray<unknown>,
  operation: TestRecipientStoreOperation,
): Effect.Effect<unknown | null, TestRecipientStoreFailure> =>
  Effect.tryPromise({
    try: () => database.prepare(query).bind(...values).first<unknown>(),
    catch: () => failure(operation),
  })

const readAll = (
  database: D1Database,
  query: string,
  values: ReadonlyArray<unknown>,
  operation: TestRecipientStoreOperation,
): Effect.Effect<ReadonlyArray<unknown>, TestRecipientStoreFailure> =>
  Effect.tryPromise({
    try: () => database.prepare(query).bind(...values).all<unknown>(),
    catch: () => failure(operation),
  }).pipe(Effect.map((result) => result.results))

const batch = (
  database: D1Database,
  statements: Array<D1PreparedStatement>,
  operation: TestRecipientStoreOperation,
): Effect.Effect<ReadonlyArray<D1ExecutionResult>, TestRecipientStoreFailure> =>
  Effect.tryPromise({
    try: () => database.batch(statements),
    catch: () => failure(operation),
  })

const actorTag = (
  kind: string,
): "User" | "Credential" | "System" | undefined => {
  switch (kind) {
    case "user":
      return "User"
    case "credential":
      return "Credential"
    case "system":
      return "System"
    default:
      return undefined
  }
}

const actorKind = (
  actor: TestRecipient["actor"],
): "user" | "credential" | "system" => {
  switch (actor._tag) {
    case "User":
      return "user"
    case "Credential":
      return "credential"
    case "System":
      return "system"
  }
}

const stateFromRow = (
  row: GrantRow,
): TestRecipientState | undefined => {
  const stateAt = DateTime.makeUnsafe(row.state_at)
  if (row.state === "pending" && row.failure_reason === null) {
    return { _tag: "Pending", requestedAt: stateAt }
  }
  if (row.state === "verified" && row.failure_reason === null) {
    return { _tag: "Verified", verifiedAt: stateAt }
  }
  if (
    row.state === "failed" &&
    (row.failure_reason === "provider_rejected" ||
      row.failure_reason === "verification_expired" ||
      row.failure_reason === "destination_unavailable")
  ) {
    return {
      _tag: "Failed",
      failedAt: stateAt,
      reason: row.failure_reason,
    }
  }
  return undefined
}

const decodeStored = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The joined grant/destination row is decoded before constructing a scoped recipient.
  input: unknown,
  operation: TestRecipientStoreOperation,
): Effect.Effect<StoredTestRecipient, TestRecipientStoreFailure> =>
  Effect.gen(function*() {
    const row = yield* Schema.decodeUnknownEffect(GrantRowSchema)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => failure(operation)))
    const actor = actorTag(row.actor_kind)
    const state = stateFromRow(row)
    const refreshPairValid = (row.last_refresh_idempotency_key === null) ===
      (row.last_refresh_fingerprint === null)
    if (
      actor === undefined ||
      state === undefined ||
      row.environment !== "test" ||
      !refreshPairValid
    ) {
      return yield* Effect.fail(failure(operation))
    }
    const recipient = yield* Schema.decodeUnknownEffect(TestRecipientSchema)({
      id: row.id,
      scope: { namespace: row.namespace, environment: row.environment },
      destinationId: row.destination_id,
      address: row.address,
      actor: { _tag: actor, id: row.actor_id },
      state,
      createdAt: DateTime.makeUnsafe(row.created_at),
      updatedAt: DateTime.makeUnsafe(row.updated_at),
    }, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => failure(operation)),
    )
    const creationFingerprint = yield* Schema.decodeUnknownEffect(
      RequestFingerprintSchema,
    )(row.request_fingerprint).pipe(Effect.mapError(() => failure(operation)))
    if (
      row.last_refresh_idempotency_key === null ||
      row.last_refresh_fingerprint === null
    ) {
      return { recipient, creationFingerprint, lastRefresh: undefined }
    }
    const fingerprint = yield* Schema.decodeUnknownEffect(
      RequestFingerprintSchema,
    )(row.last_refresh_fingerprint).pipe(Effect.mapError(() => failure(operation)))
    return {
      recipient,
      creationFingerprint,
      lastRefresh: {
        idempotencyKey: yield* Schema.decodeUnknownEffect(
          IdempotencyKeySchema,
        )(row.last_refresh_idempotency_key).pipe(
          Effect.mapError(() => failure(operation)),
        ),
        fingerprint,
      },
    }
  })

const findOne = (
  database: D1Database,
  scope: TestScope,
  predicate: string,
  value: string,
  operation: TestRecipientStoreOperation,
): Effect.Effect<Option.Option<StoredTestRecipient>, TestRecipientStoreFailure> =>
  Effect.gen(function*() {
    const row = yield* readFirst(
      database,
      `SELECT ${GrantProjection}
       FROM ${GrantsTable} AS g
       INNER JOIN ${DestinationsTable} AS d ON d.id = g.destination_id
       WHERE g.namespace = ?1 AND g.environment = ?2 AND ${predicate} = ?3
       LIMIT 1`,
      [scope.namespace, scope.environment, value],
      operation,
    )
    return row === null
      ? Option.none()
      : Option.some(yield* decodeStored(row, operation))
  })

const findAdd = (
  database: D1Database,
  scope: TestScope,
  key: string,
  operation: TestRecipientStoreOperation,
): Effect.Effect<Option.Option<StoredTestRecipientAdd>, TestRecipientStoreFailure> =>
  Effect.gen(function*() {
    const row = yield* readFirst(
      database,
      `SELECT ${AddProjection}
       FROM ${AddsTable} AS a
       INNER JOIN ${GrantsTable} AS g
         ON g.id = a.test_recipient_id
        AND g.namespace = a.namespace
        AND g.environment = a.environment
       INNER JOIN ${DestinationsTable} AS d ON d.id = g.destination_id
       WHERE a.namespace = ?1 AND a.environment = ?2
         AND a.idempotency_key = ?3 AND a.status = 'completed'
       LIMIT 1`,
      [scope.namespace, scope.environment, key],
      operation,
    )
    if (row === null) return Option.none()
    const stored = yield* decodeStored(row, operation)
    return Option.some({
      recipient: stored.recipient,
      fingerprint: stored.creationFingerprint,
    })
  })

const findAddIdentity = (
  database: D1Database,
  scope: TestScope,
  key: string,
  operation: TestRecipientStoreOperation,
): Effect.Effect<Option.Option<AddIdentityRow>, TestRecipientStoreFailure> =>
  Effect.gen(function*() {
    const row = yield* readFirst(
      database,
      `SELECT request_fingerprint, address, status, test_recipient_id,
              lease_token, lease_expires_at
       FROM ${AddsTable}
       WHERE namespace = ?1 AND environment = ?2 AND idempotency_key = ?3
       LIMIT 1`,
      [scope.namespace, scope.environment, key],
      operation,
    )
    return row === null
      ? Option.none()
      : Option.some(yield* Schema.decodeUnknownEffect(AddIdentityRowSchema)(
          row,
          { onExcessProperty: "error" },
        ).pipe(Effect.mapError(() => failure(operation))))
  })

const findRefresh = (
  database: D1Database,
  scope: TestScope,
  key: string,
  operation: TestRecipientStoreOperation,
): Effect.Effect<Option.Option<StoredTestRecipient>, TestRecipientStoreFailure> =>
  Effect.gen(function*() {
    const row = yield* readFirst(
      database,
      `SELECT ${RefreshProjection}
       FROM ${RefreshesTable} AS r
       INNER JOIN ${GrantsTable} AS g
         ON g.id = r.test_recipient_id
        AND g.namespace = r.namespace
        AND g.environment = r.environment
       INNER JOIN ${DestinationsTable} AS d ON d.id = g.destination_id
       WHERE r.namespace = ?1 AND r.environment = ?2
         AND r.idempotency_key = ?3
       LIMIT 1`,
      [scope.namespace, scope.environment, key],
      operation,
    )
    return row === null
      ? Option.none()
      : Option.some(yield* decodeStored(row, operation))
  })

interface StateProjection {
  readonly state: "pending" | "verified" | "failed"
  readonly stateAt: number
  readonly failureReason: string | null
}

const stateProjection = (
  state: TestRecipientState,
): StateProjection => {
  switch (state._tag) {
    case "Pending":
      return {
        state: "pending",
        stateAt: DateTime.toEpochMillis(state.requestedAt),
        failureReason: null,
      }
    case "Verified":
      return {
        state: "verified",
        stateAt: DateTime.toEpochMillis(state.verifiedAt),
        failureReason: null,
      }
    case "Failed":
      return {
        state: "failed",
        stateAt: DateTime.toEpochMillis(state.failedAt),
        failureReason: state.reason,
      }
  }
}

const completeAddLedger = (
  database: D1Database,
  input: {
    readonly scope: TestScope
    readonly idempotencyKey: CompleteTestRecipientAddInput["idempotencyKey"]
    readonly fingerprint: CompleteTestRecipientAddInput["fingerprint"]
    readonly leaseToken: CompleteTestRecipientAddInput["leaseToken"]
  },
  stored: StoredTestRecipient,
): Effect.Effect<StoredTestRecipientAdd, TestRecipientStoreFailure> =>
  Effect.gen(function*() {
    const state = stateProjection(stored.recipient.state)
    const updatedAt = DateTime.toEpochMillis(stored.recipient.updatedAt)
    const statement = database.prepare(
      `UPDATE ${AddsTable}
       SET status = 'completed',
           test_recipient_id = ?1,
           state = ?2,
           state_at = ?3,
           failure_reason = ?4,
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = ?5
       WHERE namespace = ?6 AND environment = ?7 AND idempotency_key = ?8
         AND status = 'pending'
         AND request_fingerprint = ?9
         AND address = ?10
         AND lease_token = ?11`,
    ).bind(
      stored.recipient.id,
      state.state,
      state.stateAt,
      state.failureReason,
      updatedAt,
      input.scope.namespace,
      input.scope.environment,
      input.idempotencyKey,
      input.fingerprint,
      stored.recipient.address,
      input.leaseToken,
    )
    const attempted = yield* Effect.result(batch(
      database,
      [statement],
      "complete_add",
    ))
    const completed = yield* findAdd(
      database,
      input.scope,
      input.idempotencyKey,
      "complete_add",
    )
    if (Option.isSome(completed)) return completed.value
    return attempted._tag === "Failure"
      ? yield* Effect.fail(attempted.failure)
      : yield* Effect.fail(failure("complete_add"))
  })

const claimAdd = (
  database: D1Database,
  input: ClaimTestRecipientAddInput,
): Effect.Effect<ClaimTestRecipientAddResult, TestRecipientStoreFailure> =>
  Effect.gen(function*() {
    const claimedAt = DateTime.toEpochMillis(input.claimedAt)
    const leaseExpiresAt = DateTime.toEpochMillis(input.leaseExpiresAt)
    if (leaseExpiresAt <= claimedAt) {
      return yield* Effect.fail(failure("claim_add"))
    }
    const insertStatement = database.prepare(
      `INSERT INTO ${AddsTable} (
         namespace, environment, idempotency_key, request_fingerprint,
         address, status, test_recipient_id, state, state_at,
         failure_reason, lease_token, lease_expires_at, created_at, updated_at
       ) VALUES (
         ?1, ?2, ?3, ?4,
         ?5, 'pending', NULL, NULL, NULL,
         NULL, ?6, ?7, ?8, ?8
       )
       ON CONFLICT(namespace, environment, idempotency_key) DO NOTHING`,
    ).bind(
      input.scope.namespace,
      input.scope.environment,
      input.idempotencyKey,
      input.fingerprint,
      input.address,
      input.leaseToken,
      leaseExpiresAt,
      claimedAt,
    )
    const reclaimStatement = database.prepare(
      `UPDATE ${AddsTable}
       SET lease_token = ?1,
           lease_expires_at = ?2,
           updated_at = ?3
       WHERE namespace = ?4 AND environment = ?5 AND idempotency_key = ?6
         AND status = 'pending'
         AND request_fingerprint = ?7
         AND address = ?8
         AND (lease_token IS NULL OR lease_expires_at <= ?3)`,
    ).bind(
      input.leaseToken,
      leaseExpiresAt,
      claimedAt,
      input.scope.namespace,
      input.scope.environment,
      input.idempotencyKey,
      input.fingerprint,
      input.address,
    )
    yield* batch(
      database,
      [insertStatement, reclaimStatement],
      "claim_add",
    )
    const identity = yield* findAddIdentity(
      database,
      input.scope,
      input.idempotencyKey,
      "claim_add",
    )
    if (Option.isNone(identity)) {
      return yield* Effect.fail(failure("claim_add"))
    }
    if (identity.value.status === "completed") {
      const completed = yield* findAdd(
        database,
        input.scope,
        input.idempotencyKey,
        "claim_add",
      )
      return Option.isSome(completed)
        ? { _tag: "Completed", add: completed.value }
        : yield* Effect.fail(failure("claim_add"))
    }
    if (identity.value.lease_token !== input.leaseToken) {
      return {
        _tag: "Pending",
        fingerprint: identity.value.request_fingerprint,
      }
    }
    const existing = yield* findOne(
      database,
      input.scope,
      "d.address",
      input.address,
      "claim_add",
    )
    if (Option.isNone(existing)) return { _tag: "Claimed" }
    const add = yield* completeAddLedger(database, input, existing.value)
    return { _tag: "Completed", add }
  })

const completeAdd = (
  database: D1Database,
  config: D1TestRecipientStoreConfig,
  input: CompleteTestRecipientAddInput,
): Effect.Effect<StoredTestRecipientAdd, TestRecipientStoreFailure> =>
  Effect.gen(function*() {
    const identity = yield* findAddIdentity(
      database,
      input.recipient.scope,
      input.idempotencyKey,
      "complete_add",
    )
    if (Option.isNone(identity)) {
      return yield* Effect.fail(failure("complete_add"))
    }
    if (identity.value.status === "completed") {
      const completed = yield* findAdd(
        database,
        input.recipient.scope,
        input.idempotencyKey,
        "complete_add",
      )
      return Option.isSome(completed)
        ? completed.value
        : yield* Effect.fail(failure("complete_add"))
    }
    if (
      identity.value.request_fingerprint !== input.fingerprint ||
      identity.value.address !== input.recipient.address ||
      identity.value.lease_token !== input.leaseToken
    ) {
      return yield* Effect.fail(failure("complete_add"))
    }
    const state = stateProjection(input.recipient.state)
    const createdAt = DateTime.toEpochMillis(input.recipient.createdAt)
    const updatedAt = DateTime.toEpochMillis(input.recipient.updatedAt)
    if (
      state.stateAt !== updatedAt ||
      config.providerAccountKey.trim().length === 0
    ) {
      return yield* Effect.fail(failure("complete_add"))
    }
    const destinationStatement = database.prepare(
      `INSERT INTO ${DestinationsTable} (
         id, provider_account_key, address, provider_destination_id,
         status, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?1, ?4, ?5, ?6)
       ON CONFLICT(id) DO UPDATE SET
         provider_destination_id = excluded.provider_destination_id,
         status = excluded.status,
         updated_at = excluded.updated_at
       WHERE ${DestinationsTable}.provider_account_key = excluded.provider_account_key
         AND ${DestinationsTable}.address = excluded.address`,
    ).bind(
      input.recipient.destinationId,
      config.providerAccountKey,
      input.recipient.address,
      state.state,
      createdAt,
      updatedAt,
    )
    const grantStatement = database.prepare(
        `INSERT OR IGNORE INTO ${GrantsTable} (
           id, namespace, environment, destination_id, idempotency_key,
           request_fingerprint, last_refresh_idempotency_key,
           last_refresh_fingerprint, state, state_at, failure_reason,
           actor_kind, actor_id, created_at, updated_at
         )
         SELECT
           ?1, ?2, 'test', ?3, ?4,
           ?5, NULL,
           NULL, ?6, ?7, ?8,
           ?9, ?10, ?11, ?12
         FROM ${DestinationsTable}
         WHERE id = ?3 AND provider_account_key = ?13 AND address = ?14`,
      ).bind(
        input.recipient.id,
        input.recipient.scope.namespace,
        input.recipient.destinationId,
        input.idempotencyKey,
        input.fingerprint,
        state.state,
        state.stateAt,
        state.failureReason,
        actorKind(input.recipient.actor),
        input.recipient.actor.id,
        createdAt,
        updatedAt,
        config.providerAccountKey,
        input.recipient.address,
      )
    const attempted = yield* Effect.result(batch(
      database,
      [destinationStatement, grantStatement],
      "complete_add",
    ))
    const stored = yield* findOne(
      database,
      input.recipient.scope,
      "d.address",
      input.recipient.address,
      "complete_add",
    )
    if (Option.isSome(stored)) {
      return yield* completeAddLedger(database, {
        scope: input.recipient.scope,
        idempotencyKey: input.idempotencyKey,
        fingerprint: input.fingerprint,
        leaseToken: input.leaseToken,
      }, stored.value)
    }
    return attempted._tag === "Failure"
      ? yield* Effect.fail(attempted.failure)
      : yield* Effect.fail(failure("complete_add"))
  })

const releaseAdd = (
  database: D1Database,
  input: ReleaseTestRecipientAddInput,
): Effect.Effect<void, TestRecipientStoreFailure> => {
  const statement = database.prepare(
    `UPDATE ${AddsTable}
     SET lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = ?1
     WHERE namespace = ?2 AND environment = ?3 AND idempotency_key = ?4
       AND status = 'pending'
       AND request_fingerprint = ?5
       AND lease_token = ?6`,
  ).bind(
    DateTime.toEpochMillis(input.releasedAt),
    input.scope.namespace,
    input.scope.environment,
    input.idempotencyKey,
    input.fingerprint,
    input.leaseToken,
  )
  return batch(database, [statement], "release_add").pipe(Effect.asVoid)
}

const refresh = (
  database: D1Database,
  input: RefreshTestRecipientStoreInput,
): Effect.Effect<
  StoredTestRecipient,
  TestRecipientStoreConflict | TestRecipientStoreFailure
> =>
  Effect.gen(function*() {
    const replay = yield* findRefresh(
      database,
      input.scope,
      input.idempotencyKey,
      "refresh",
    )
    if (Option.isSome(replay)) {
      return replay.value.recipient.id === input.testRecipientId &&
          replay.value.lastRefresh?.fingerprint === input.fingerprint
        ? replay.value
        : yield* new TestRecipientStoreConflict({
            testRecipientId: input.testRecipientId,
            reason: "concurrent_update",
          })
    }
    const current = yield* findOne(
      database,
      input.scope,
      "g.id",
      input.testRecipientId,
      "refresh",
    )
    if (Option.isNone(current)) {
      return yield* new TestRecipientStoreConflict({
        testRecipientId: input.testRecipientId,
        reason: "concurrent_update",
      })
    }
    if (current.value.lastRefresh?.idempotencyKey === input.idempotencyKey) {
      return current.value.lastRefresh.fingerprint === input.fingerprint
        ? current.value
        : yield* new TestRecipientStoreConflict({
            testRecipientId: input.testRecipientId,
            reason: "concurrent_update",
          })
    }
    const state = stateProjection(input.state)
    const updatedAt = DateTime.toEpochMillis(input.updatedAt)
    if (state.stateAt !== updatedAt) {
      return yield* Effect.fail(failure("refresh"))
    }
    const priorRefreshKey = current.value.lastRefresh?.idempotencyKey ?? null
    const priorRefreshFingerprint = current.value.lastRefresh?.fingerprint ?? null
    const updateStatement = database.prepare(
        `UPDATE ${GrantsTable}
         SET state = ?1,
             state_at = ?2,
             failure_reason = ?3,
             last_refresh_idempotency_key = ?4,
             last_refresh_fingerprint = ?5,
             updated_at = ?6
         WHERE namespace = ?7 AND environment = 'test' AND id = ?8
           AND updated_at = ?9
           AND (
             (last_refresh_idempotency_key IS NULL AND ?10 IS NULL)
             OR last_refresh_idempotency_key = ?10
           )
           AND (
             (last_refresh_fingerprint IS NULL AND ?11 IS NULL)
             OR last_refresh_fingerprint = ?11
           )`,
      ).bind(
        state.state,
        state.stateAt,
        state.failureReason,
        input.idempotencyKey,
        input.fingerprint,
        updatedAt,
        input.scope.namespace,
        input.testRecipientId,
        DateTime.toEpochMillis(current.value.recipient.updatedAt),
        priorRefreshKey,
        priorRefreshFingerprint,
      )
    const ledgerStatement = database.prepare(
      `INSERT INTO ${RefreshesTable} (
         namespace, environment, idempotency_key, test_recipient_id,
         request_fingerprint, state, state_at, failure_reason, created_at
       )
       SELECT namespace, environment, ?1, id, ?2, state, state_at,
              failure_reason, ?3
       FROM ${GrantsTable}
       WHERE namespace = ?4 AND environment = 'test' AND id = ?5
         AND last_refresh_idempotency_key = ?1
         AND last_refresh_fingerprint = ?2
         AND state = ?6 AND state_at = ?7
         AND (
           (failure_reason IS NULL AND ?8 IS NULL)
           OR failure_reason = ?8
         )
         AND updated_at = ?3`,
    ).bind(
      input.idempotencyKey,
      input.fingerprint,
      updatedAt,
      input.scope.namespace,
      input.testRecipientId,
      state.state,
      state.stateAt,
      state.failureReason,
    )
    const attempted = yield* Effect.result(batch(
      database,
      [updateStatement, ledgerStatement],
      "refresh",
    ))
    const loaded = yield* findRefresh(
      database,
      input.scope,
      input.idempotencyKey,
      "refresh",
    )
    if (
      Option.isSome(loaded) &&
      loaded.value.recipient.id === input.testRecipientId &&
      loaded.value.lastRefresh?.idempotencyKey === input.idempotencyKey &&
      loaded.value.lastRefresh.fingerprint === input.fingerprint
    ) {
      return loaded.value
    }
    if (attempted._tag === "Failure") {
      return yield* Effect.fail(attempted.failure)
    }
    return yield* new TestRecipientStoreConflict({
      testRecipientId: input.testRecipientId,
      reason: "concurrent_update",
    })
  })

/** Construct the D1 namespace-local test-recipient grant store. */
export const makeD1TestRecipientStore = (
  database: D1Database,
  config: D1TestRecipientStoreConfig,
) =>
  TestRecipientStore.of({
    findByIdempotency: (scope, key) => findAdd(
      database,
      scope,
      key,
      "find_idempotency",
    ),
    findRefreshByIdempotency: (scope, key) => findRefresh(
      database,
      scope,
      key,
      "find_refresh_idempotency",
    ),
    findByAddress: (scope, address) => findOne(
      database,
      scope,
      "d.address",
      address,
      "find_address",
    ),
    findById: (scope, id) => findOne(
      database,
      scope,
      "g.id",
      id,
      "find_id",
    ),
    claimAdd: (input) => claimAdd(database, input),
    completeAdd: (input) => completeAdd(database, config, input),
    releaseAdd: (input) => releaseAdd(database, input),
    refresh: (input) => refresh(database, input),
    list: (scope) => Effect.gen(function*() {
      const rows = yield* readAll(
        database,
        `SELECT ${GrantProjection}
         FROM ${GrantsTable} AS g
         INNER JOIN ${DestinationsTable} AS d ON d.id = g.destination_id
         WHERE g.namespace = ?1 AND g.environment = 'test'
         ORDER BY g.created_at ASC, g.id ASC`,
        [scope.namespace],
        "list",
      )
      const stored = yield* Effect.forEach(rows, (row) =>
        decodeStored(row, "list"))
      return stored.map((record) => record.recipient)
    }),
  })
