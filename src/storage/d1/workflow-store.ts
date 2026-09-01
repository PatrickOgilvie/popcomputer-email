import { DateTime, Effect, Option, Schema } from "effect"
import {
  MaximumWorkflowReadyLimit,
  WorkflowStore,
  WorkflowStoreFailure,
  WorkflowStoreLeaseConflict,
  type ClaimWorkflowEventInput,
  type CompleteWorkflowLeaseInput,
  type WorkflowStoreOperation,
} from "../../adapters/workflow-store.js"
import {
  EmailReceivedEventV1Schema,
  WorkflowEventSchema,
  WorkflowEventStateSchema,
  WorkflowFailureReasonSchema,
  isFailed,
  isLeased,
  isPending,
  type DispatchableWorkflowEvent,
  type LeasedWorkflowEvent,
  type WorkflowEvent,
} from "../../core/workflow.js"
import type {
  D1Database,
  D1ExecutionResult,
  D1PreparedStatement,
} from "./contract.js"

const WorkflowEventsTable = "popcomputer_email_workflow_events"

const WorkflowProjection = `
  id,
  message_id,
  route_id,
  namespace,
  environment,
  workflow_id,
  event_json,
  status,
  attempt_count,
  next_attempt_at,
  lease_token,
  lease_expires_at,
  safe_error_code,
  external_run_id,
  created_at,
  updated_at`

const EpochMillisSchema = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
)

const WorkflowRowSchema = Schema.Struct({
  id: Schema.String,
  message_id: Schema.String,
  route_id: Schema.String,
  namespace: Schema.String,
  environment: Schema.String,
  workflow_id: Schema.String,
  event_json: Schema.String,
  status: Schema.String,
  attempt_count: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  next_attempt_at: EpochMillisSchema,
  lease_token: Schema.NullOr(Schema.String),
  lease_expires_at: Schema.NullOr(EpochMillisSchema),
  safe_error_code: Schema.NullOr(Schema.String),
  external_run_id: Schema.NullOr(Schema.String),
  created_at: EpochMillisSchema,
  updated_at: EpochMillisSchema,
})

const ChangesSchema = Schema.Struct({
  meta: Schema.Struct({
    changes: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
    ),
  }),
})

type WorkflowRow = typeof WorkflowRowSchema.Type

const failure = (operation: WorkflowStoreOperation): WorkflowStoreFailure =>
  new WorkflowStoreFailure({ operation, reason: "unavailable" })

const readFirst = (
  database: D1Database,
  query: string,
  values: ReadonlyArray<unknown>,
  operation: WorkflowStoreOperation,
): Effect.Effect<unknown | null, WorkflowStoreFailure> =>
  Effect.tryPromise({
    try: () => database.prepare(query).bind(...values).first<unknown>(),
    catch: () => failure(operation),
  })

const readAll = (
  database: D1Database,
  query: string,
  values: ReadonlyArray<unknown>,
  operation: WorkflowStoreOperation,
): Effect.Effect<ReadonlyArray<unknown>, WorkflowStoreFailure> =>
  Effect.tryPromise({
    try: () => database.prepare(query).bind(...values).all<unknown>(),
    catch: () => failure(operation),
  }).pipe(Effect.map((result) => result.results))

const run = (
  statement: D1PreparedStatement,
  operation: WorkflowStoreOperation,
): Effect.Effect<D1ExecutionResult<unknown>, WorkflowStoreFailure> =>
  Effect.tryPromise({
    try: () => statement.run<unknown>(),
    catch: () => failure(operation),
  })

const changes = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- D1 metadata is parsed immediately before its change count is trusted.
  input: unknown,
  operation: WorkflowStoreOperation,
): Effect.Effect<number, WorkflowStoreFailure> =>
  Schema.decodeUnknownEffect(ChangesSchema)(input).pipe(
    Effect.map((decoded) => decoded.meta.changes),
    Effect.mapError(() => failure(operation)),
  )

const decodeJson = (
  input: string,
  operation: WorkflowStoreOperation,
): Effect.Effect<unknown, WorkflowStoreFailure> =>
  Effect.try({
    try: () => {
      const decoded: unknown = JSON.parse(input)
      return decoded
    },
    catch: () => failure(operation),
  })

const decodeRow = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The complete outbox row is decoded before a workflow event is constructed.
  input: unknown,
  operation: WorkflowStoreOperation,
): Effect.Effect<WorkflowRow, WorkflowStoreFailure> =>
  Schema.decodeUnknownEffect(WorkflowRowSchema)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => failure(operation)))

const decodeEvent = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The persisted D1 row and versioned JSON payload are parsed as one invariant boundary.
  input: unknown,
  operation: WorkflowStoreOperation,
): Effect.Effect<WorkflowEvent, WorkflowStoreFailure> =>
  Effect.gen(function*() {
    const row = yield* decodeRow(input, operation)
    const payloadJson = yield* decodeJson(row.event_json, operation)
    const payload = yield* Schema.decodeUnknownEffect(
      EmailReceivedEventV1Schema,
    )(payloadJson, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => failure(operation)),
    )
    if (
      payload.eventId !== row.id ||
      payload.message.id !== row.message_id ||
      payload.message.routeId !== row.route_id ||
      payload.scope.namespace !== row.namespace ||
      payload.scope.environment !== row.environment ||
      payload.workflowId !== row.workflow_id
    ) {
      return yield* Effect.fail(failure(operation))
    }

    const state = row.status === "pending" && row.attempt_count === 0 &&
        row.lease_token === null && row.lease_expires_at === null &&
        row.safe_error_code === null && row.external_run_id === null
      ? {
          _tag: "Pending" as const,
          nextAttemptAt: DateTime.makeUnsafe(row.next_attempt_at),
        }
      : row.status === "leased" && row.attempt_count > 0 &&
          row.lease_token !== null && row.lease_expires_at !== null &&
          row.safe_error_code === null && row.external_run_id === null
      ? {
          _tag: "Leased" as const,
          attempt: row.attempt_count,
          leaseToken: row.lease_token,
          leasedAt: DateTime.makeUnsafe(row.updated_at),
          leaseExpiresAt: DateTime.makeUnsafe(row.lease_expires_at),
        }
      : row.status === "started" && row.attempt_count > 0 &&
          row.lease_token === null && row.lease_expires_at === null &&
          row.safe_error_code === null && row.external_run_id !== null
      ? {
          _tag: "Started" as const,
          attempt: row.attempt_count,
          runId: row.external_run_id,
          startedAt: DateTime.makeUnsafe(row.updated_at),
        }
      : row.status === "failed" && row.attempt_count > 0 &&
          row.lease_token === null && row.lease_expires_at === null &&
          row.safe_error_code !== null && row.external_run_id === null
      ? {
          _tag: "Failed" as const,
          attempt: row.attempt_count,
          failedAt: DateTime.makeUnsafe(row.updated_at),
          nextAttemptAt: DateTime.makeUnsafe(row.next_attempt_at),
          reason: row.safe_error_code,
        }
      : row.status === "dead" && row.attempt_count > 0 &&
          row.lease_token === null && row.lease_expires_at === null &&
          row.safe_error_code !== null && row.external_run_id === null
      ? {
          _tag: "Dead" as const,
          attempt: row.attempt_count,
          deadAt: DateTime.makeUnsafe(row.updated_at),
          reason: row.safe_error_code,
        }
      : undefined
    if (state === undefined) {
      return yield* Effect.fail(failure(operation))
    }
    return yield* Schema.decodeUnknownEffect(WorkflowEventSchema)({
      event: payloadJson,
      state,
      createdAt: DateTime.makeUnsafe(row.created_at),
      updatedAt: DateTime.makeUnsafe(row.updated_at),
    }, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => failure(operation)),
    )
  })

const loadById = (
  database: D1Database,
  eventId: string,
  operation: WorkflowStoreOperation,
): Effect.Effect<Option.Option<WorkflowEvent>, WorkflowStoreFailure> =>
  Effect.gen(function*() {
    const row = yield* readFirst(
      database,
      `SELECT ${WorkflowProjection}
       FROM ${WorkflowEventsTable}
       WHERE id = ?1
       LIMIT 1`,
      [eventId],
      operation,
    )
    return row === null
      ? Option.none()
      : Option.some(yield* decodeEvent(row, operation))
  })

const asDispatchable = (
  event: WorkflowEvent,
  now: DateTime.Utc,
  operation: WorkflowStoreOperation,
): Effect.Effect<DispatchableWorkflowEvent, WorkflowStoreFailure> => {
  if (isPending(event) || isFailed(event)) {
    return Effect.succeed(event)
  }
  if (
    event.state._tag !== "Leased" ||
    DateTime.toEpochMillis(event.state.leaseExpiresAt) >
      DateTime.toEpochMillis(now)
  ) {
    return Effect.fail(failure(operation))
  }
  return Effect.succeed({
    ...event,
    state: WorkflowEventStateSchema.cases.Failed.make({
      attempt: event.state.attempt,
      failedAt: event.state.leaseExpiresAt,
      nextAttemptAt: event.state.leaseExpiresAt,
      reason: WorkflowFailureReasonSchema.make("workflow_store.lease_expired"),
    }),
    updatedAt: event.state.leaseExpiresAt,
  })
}

interface ClaimPredicate {
  readonly sql: string
  readonly values: ReadonlyArray<unknown>
}

const claimPredicate = (
  event: DispatchableWorkflowEvent,
): ClaimPredicate => {
  if (event.state._tag === "Pending") {
    return {
      sql: "status = 'pending' AND attempt_count = 0 AND next_attempt_at <= ?9",
      values: [],
    }
  }
  if (event.state.reason === "workflow_store.lease_expired") {
    return {
      sql: "status = 'leased' AND attempt_count = ?10 AND lease_expires_at <= ?9",
      values: [event.state.attempt],
    }
  }
  return {
    sql: "status = 'failed' AND attempt_count = ?10 AND next_attempt_at <= ?9",
    values: [event.state.attempt],
  }
}

const claim = (
  database: D1Database,
  input: ClaimWorkflowEventInput,
): Effect.Effect<Option.Option<LeasedWorkflowEvent>, WorkflowStoreFailure> =>
  Effect.gen(function*() {
    const event = input.event
    const attempt = event.state._tag === "Pending"
      ? 1
      : event.state.attempt + 1
    const leasedAt = DateTime.toEpochMillis(input.leasedAt)
    const leaseExpiresAt = DateTime.toEpochMillis(input.leaseExpiresAt)
    if (leaseExpiresAt <= leasedAt) {
      return yield* Effect.fail(failure("claim"))
    }
    const predicate = claimPredicate(event)
    const result = yield* run(
      database.prepare(
        `UPDATE ${WorkflowEventsTable}
         SET status = 'leased',
             attempt_count = ?1,
             lease_token = ?2,
             lease_expires_at = ?3,
             safe_error_code = NULL,
             external_run_id = NULL,
             updated_at = ?4
         WHERE id = ?5
           AND namespace = ?6
           AND environment = ?7
           AND workflow_id = ?8
           AND ${predicate.sql}`,
      ).bind(
        attempt,
        input.leaseToken,
        leaseExpiresAt,
        leasedAt,
        event.event.eventId,
        event.event.scope.namespace,
        event.event.scope.environment,
        event.event.workflowId,
        leasedAt,
        ...predicate.values,
      ),
      "claim",
    )
    if ((yield* changes(result, "claim")) !== 1) {
      return Option.none()
    }
    const loaded = yield* loadById(database, event.event.eventId, "claim")
    if (Option.isNone(loaded) || !isLeased(loaded.value)) {
      return yield* Effect.fail(failure("claim"))
    }
    return Option.some(loaded.value)
  })

interface CompletionProjection {
  readonly status: "started" | "failed" | "dead"
  readonly nextAttemptAt: number
  readonly safeErrorCode: string | null
  readonly externalRunId: string | null
  readonly updatedAt: number
}

const completeLease = (
  database: D1Database,
  input: CompleteWorkflowLeaseInput,
  projection: CompletionProjection,
  operation: "mark_started" | "mark_failed" | "mark_dead",
): Effect.Effect<
  WorkflowEvent,
  WorkflowStoreFailure | WorkflowStoreLeaseConflict
> =>
  Effect.gen(function*() {
    if (
      input.event.state.leaseToken !== input.leaseToken ||
      projection.updatedAt <
        DateTime.toEpochMillis(input.event.state.leasedAt)
    ) {
      return yield* new WorkflowStoreLeaseConflict({
        eventId: input.event.event.eventId,
        reason: "lease_conflict",
      })
    }
    const result = yield* run(
      database.prepare(
        `UPDATE ${WorkflowEventsTable}
         SET status = ?1,
             next_attempt_at = ?2,
             lease_token = NULL,
             lease_expires_at = NULL,
             safe_error_code = ?3,
             external_run_id = ?4,
             updated_at = ?5
         WHERE id = ?6
           AND namespace = ?7
           AND environment = ?8
           AND status = 'leased'
           AND attempt_count = ?9
           AND lease_token = ?10`,
      ).bind(
        projection.status,
        projection.nextAttemptAt,
        projection.safeErrorCode,
        projection.externalRunId,
        projection.updatedAt,
        input.event.event.eventId,
        input.event.event.scope.namespace,
        input.event.event.scope.environment,
        input.event.state.attempt,
        input.leaseToken,
      ),
      operation,
    )
    if ((yield* changes(result, operation)) !== 1) {
      return yield* new WorkflowStoreLeaseConflict({
        eventId: input.event.event.eventId,
        reason: "lease_conflict",
      })
    }
    const loaded = yield* loadById(
      database,
      input.event.event.eventId,
      operation,
    )
    return Option.isSome(loaded)
      ? loaded.value
      : yield* Effect.fail(failure(operation))
  })

/** Construct the D1 workflow-outbox adapter with expiring CAS leases. */
export const makeD1WorkflowStore = (database: D1Database) =>
  WorkflowStore.of({
    listReady: ({ now, limit }) => Effect.gen(function*() {
      if (
        !Number.isInteger(limit) || limit < 1 ||
        limit > MaximumWorkflowReadyLimit
      ) {
        return yield* Effect.fail(failure("list_ready"))
      }
      const nowEpoch = DateTime.toEpochMillis(now)
      const rows = yield* readAll(
        database,
        `SELECT ${WorkflowProjection}
         FROM ${WorkflowEventsTable}
         WHERE (
           status IN ('pending', 'failed') AND next_attempt_at <= ?1
         ) OR (
           status = 'leased' AND lease_expires_at <= ?1
         )
         ORDER BY
           CASE WHEN status = 'leased' THEN lease_expires_at ELSE next_attempt_at END ASC,
           created_at ASC,
           id ASC
         LIMIT ?2`,
        [nowEpoch, limit],
        "list_ready",
      )
      return yield* Effect.forEach(rows, (row) =>
        decodeEvent(row, "list_ready").pipe(
          Effect.flatMap((event) => asDispatchable(event, now, "list_ready")),
        ))
    }),
    claim: (input) => claim(database, input),
    markStarted: (input) => completeLease(database, input, {
      status: "started",
      nextAttemptAt: DateTime.toEpochMillis(input.startedAt),
      safeErrorCode: null,
      externalRunId: input.runId,
      updatedAt: DateTime.toEpochMillis(input.startedAt),
    }, "mark_started"),
    markFailed: (input) => completeLease(database, input, {
      status: "failed",
      nextAttemptAt: DateTime.toEpochMillis(input.nextAttemptAt),
      safeErrorCode: input.reason,
      externalRunId: null,
      updatedAt: DateTime.toEpochMillis(input.failedAt),
    }, "mark_failed"),
    markDead: (input) => completeLease(database, input, {
      status: "dead",
      nextAttemptAt: DateTime.toEpochMillis(input.deadAt),
      safeErrorCode: input.reason,
      externalRunId: null,
      updatedAt: DateTime.toEpochMillis(input.deadAt),
    }, "mark_dead"),
  })
