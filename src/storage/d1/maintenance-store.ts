import { DateTime, Effect, Option, Schema } from "effect"
import {
  MaximumMaintenanceBatchLimit,
  MaintenanceStore,
  MaintenanceStoreFailure,
  MaintenanceStoreOperationSchema,
  type ArchiveCleanupItem,
  type LeasedArchiveCleanupItem,
} from "../../adapters/maintenance-store.js"
import {
  LeaseTokenSchema,
  MessageIdSchema,
  RawMessageRefSchema,
} from "../../core/identifiers.js"
import { DirectionSchema } from "../../core/message.js"
import { ScopeSchema } from "../../core/scope.js"
import type {
  D1Database,
  D1ExecutionResult,
  D1PreparedStatement,
} from "./contract.js"

const MessagesTable = "popcomputer_email_messages"
const ArchiveIntentsTable = "popcomputer_email_inbound_archive_intents"
const OutboundArchiveIntentsTable =
  "popcomputer_email_outbound_archive_intents"
const ArchiveDeletionsTable = "popcomputer_email_archive_deletions"

type MaintenanceStoreOperation =
  typeof MaintenanceStoreOperationSchema.Type

const ArchiveCleanupRowSchema = Schema.Struct({
  item_tag: Schema.String,
  id: Schema.String,
  namespace: Schema.String,
  environment: Schema.String,
  direction: Schema.String,
  message_id: Schema.String,
  raw_ref: Schema.String,
  attempt_count: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  due_at: Schema.Number,
})

const ArchiveCleanupItemSchema = Schema.Struct({
  _tag: Schema.Literals(["InboundIntent", "OutboundIntent", "Deletion"]),
  id: Schema.String,
  scope: ScopeSchema,
  direction: DirectionSchema,
  messageId: MessageIdSchema,
  rawRef: RawMessageRefSchema,
  attempt: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
})

const ChangesSchema = Schema.Struct({
  meta: Schema.Struct({
    changes: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
    ),
  }),
})

const failure = (
  operation: MaintenanceStoreOperation,
): MaintenanceStoreFailure => new MaintenanceStoreFailure({
  operation,
  reason: "unavailable",
})

const readAll = (
  database: D1Database,
  query: string,
  values: ReadonlyArray<unknown>,
  operation: MaintenanceStoreOperation,
): Effect.Effect<ReadonlyArray<unknown>, MaintenanceStoreFailure> =>
  Effect.tryPromise({
    try: () => database.prepare(query).bind(...values).all<unknown>(),
    catch: () => failure(operation),
  }).pipe(Effect.map((result) => result.results))

const run = (
  statement: D1PreparedStatement,
  operation: MaintenanceStoreOperation,
): Effect.Effect<D1ExecutionResult<unknown>, MaintenanceStoreFailure> =>
  Effect.tryPromise({
    try: () => statement.run<unknown>(),
    catch: () => failure(operation),
  })

const changes = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- D1 execution metadata is decoded before the affected-row count is trusted.
  input: unknown,
  operation: MaintenanceStoreOperation,
): Effect.Effect<number, MaintenanceStoreFailure> =>
  Schema.decodeUnknownEffect(ChangesSchema)(input).pipe(
    Effect.map((decoded) => decoded.meta.changes),
    Effect.mapError(() => failure(operation)),
  )

const decodeCleanupItem = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A UNION projection from both package cleanup queues is parsed before returning an item.
  input: unknown,
): Effect.Effect<ArchiveCleanupItem, MaintenanceStoreFailure> =>
  Effect.gen(function*() {
    const row = yield* Schema.decodeUnknownEffect(ArchiveCleanupRowSchema)(
      input,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError(() => failure("list_archive_cleanup")))
    if (
      (
        row.item_tag !== "InboundIntent" &&
        row.item_tag !== "OutboundIntent" &&
        row.item_tag !== "Deletion"
      ) ||
      (row.item_tag === "InboundIntent" && row.direction !== "inbound") ||
      (row.item_tag === "OutboundIntent" && row.direction !== "outbound")
    ) {
      return yield* Effect.fail(failure("list_archive_cleanup"))
    }
    return yield* Schema.decodeUnknownEffect(ArchiveCleanupItemSchema)({
      _tag: row.item_tag,
      id: row.id,
      scope: {
        namespace: row.namespace,
        environment: row.environment,
      },
      direction: row.direction,
      messageId: row.message_id,
      rawRef: row.raw_ref,
      attempt: row.attempt_count,
    }, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => failure("list_archive_cleanup")),
    )
  })

const queueTable = (
  item: ArchiveCleanupItem,
):
  | typeof ArchiveIntentsTable
  | typeof ArchiveDeletionsTable
  | typeof OutboundArchiveIntentsTable =>
  item._tag === "InboundIntent"
    ? ArchiveIntentsTable
    : item._tag === "OutboundIntent"
    ? OutboundArchiveIntentsTable
    : ArchiveDeletionsTable

const queueIdentity = (
  item: ArchiveCleanupItem,
): { readonly sql: string; readonly values: ReadonlyArray<unknown> } =>
  item._tag !== "Deletion"
    ? {
        sql: "message_id = ?6 AND namespace = ?7 AND environment = ?8",
        values: [
          item.messageId,
          item.scope.namespace,
          item.scope.environment,
        ],
      }
    : {
        sql: `id = ?6 AND namespace = ?7 AND environment = ?8
              AND direction = ?9 AND message_id = ?10`,
        values: [
          item.id,
          item.scope.namespace,
          item.scope.environment,
          item.direction,
          item.messageId,
        ],
      }

const pendingDueSql = (item: ArchiveCleanupItem): string =>
  item._tag !== "Deletion"
    ? "expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000"
    : "next_attempt_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000"

const claimArchiveCleanup = (
  database: D1Database,
  item: ArchiveCleanupItem,
  leaseToken: typeof LeaseTokenSchema.Type,
  leaseExpiresAt: DateTime.Utc,
): Effect.Effect<
  Option.Option<LeasedArchiveCleanupItem>,
  MaintenanceStoreFailure
> =>
  Effect.gen(function*() {
    const identity = queueIdentity(item)
    const result = yield* run(
      database.prepare(
        `UPDATE ${queueTable(item)}
         SET status = 'leased',
             attempt_count = ?1,
             lease_token = ?2,
             lease_expires_at = ?3,
             updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
         WHERE attempt_count = ?4
           AND raw_ref = ?5
           AND ${identity.sql}
           AND (
             (status = 'pending' AND ${pendingDueSql(item)})
             OR (status = 'failed' AND
                 next_attempt_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
             OR (status = 'leased' AND
                 lease_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
           )`,
      ).bind(
        item.attempt + 1,
        leaseToken,
        DateTime.toEpochMillis(leaseExpiresAt),
        item.attempt,
        item.rawRef,
        ...identity.values,
      ),
      "claim_archive_cleanup",
    )
    if ((yield* changes(result, "claim_archive_cleanup")) !== 1) {
      return Option.none()
    }
    return Option.some({
      ...item,
      attempt: item.attempt + 1,
      leaseToken,
    })
  })

const leasedIdentity = (
  item: LeasedArchiveCleanupItem,
): { readonly sql: string; readonly values: ReadonlyArray<unknown> } =>
  item._tag !== "Deletion"
    ? {
        sql: "message_id = ?1 AND namespace = ?2 AND environment = ?3",
        values: [
          item.messageId,
          item.scope.namespace,
          item.scope.environment,
        ],
      }
    : {
        sql: `id = ?1 AND namespace = ?2 AND environment = ?3
              AND direction = ?4 AND message_id = ?5`,
        values: [
          item.id,
          item.scope.namespace,
          item.scope.environment,
          item.direction,
          item.messageId,
        ],
      }

/** Construct D1 crash recovery and raw-archive cleanup queues. */
export const makeD1MaintenanceStore = (database: D1Database) =>
  MaintenanceStore.of({
    recoverStaleSending: ({ staleBefore, occurredAt, limit }) =>
      Effect.gen(function*() {
        if (
          !Number.isInteger(limit) || limit < 1 ||
          limit > MaximumMaintenanceBatchLimit
        ) {
          return yield* Effect.fail(failure("recover_stale_sending"))
        }
        const result = yield* run(
          database.prepare(
            `UPDATE ${MessagesTable}
             SET status = 'delivery_unknown',
                 state_reason = 'crash_recovery',
                 provider_message_id = NULL,
                 sent_at = NULL,
                 updated_at = ?1
             WHERE id IN (
               SELECT id
               FROM ${MessagesTable}
               WHERE direction = 'outbound'
                 AND status = 'sending'
                 AND claimed_at <= ?2
               ORDER BY claimed_at ASC, id ASC
               LIMIT ?3
             )
             AND direction = 'outbound'
             AND status = 'sending'
             AND claimed_at <= ?2`,
          ).bind(
            DateTime.toEpochMillis(occurredAt),
            DateTime.toEpochMillis(staleBefore),
            limit,
          ),
          "recover_stale_sending",
        )
        return yield* changes(result, "recover_stale_sending")
      }),
    listArchiveCleanup: ({ now, limit }) => Effect.gen(function*() {
      if (
        !Number.isInteger(limit) || limit < 1 ||
        limit > MaximumMaintenanceBatchLimit
      ) {
        return yield* Effect.fail(failure("list_archive_cleanup"))
      }
      const nowEpoch = DateTime.toEpochMillis(now)
      const rows = yield* readAll(
        database,
        `SELECT item_tag, id, namespace, environment, direction, message_id,
                raw_ref, attempt_count, due_at
         FROM (
           SELECT
             'InboundIntent' AS item_tag,
             message_id AS id,
             namespace,
             environment,
             'inbound' AS direction,
             message_id,
             raw_ref,
             attempt_count,
             CASE
               WHEN status = 'leased' THEN lease_expires_at
               WHEN status = 'pending' THEN expires_at
               ELSE next_attempt_at
             END AS due_at
           FROM ${ArchiveIntentsTable}
           WHERE raw_ref IS NOT NULL AND (
             (status = 'pending' AND expires_at <= ?1)
             OR (status = 'failed' AND next_attempt_at <= ?1)
             OR (status = 'leased' AND lease_expires_at <= ?1)
           )
           UNION ALL
           SELECT
             'OutboundIntent' AS item_tag,
             message_id AS id,
             namespace,
             environment,
             'outbound' AS direction,
             message_id,
             raw_ref,
             attempt_count,
             CASE
               WHEN status = 'leased' THEN lease_expires_at
               WHEN status = 'pending' THEN expires_at
               ELSE next_attempt_at
             END AS due_at
           FROM ${OutboundArchiveIntentsTable}
           WHERE (
             (status = 'pending' AND expires_at <= ?1)
             OR (status = 'failed' AND next_attempt_at <= ?1)
             OR (status = 'leased' AND lease_expires_at <= ?1)
           )
           UNION ALL
           SELECT
             'Deletion' AS item_tag,
             id,
             namespace,
             environment,
             direction,
             message_id,
             raw_ref,
             attempt_count,
             CASE
               WHEN status = 'leased' THEN lease_expires_at
               ELSE next_attempt_at
             END AS due_at
           FROM ${ArchiveDeletionsTable}
           WHERE raw_ref IS NOT NULL AND (
             (status IN ('pending', 'failed') AND next_attempt_at <= ?1)
             OR (status = 'leased' AND lease_expires_at <= ?1)
           )
         )
         ORDER BY due_at ASC, item_tag ASC, id ASC
         LIMIT ?2`,
        [nowEpoch, limit],
        "list_archive_cleanup",
      )
      return yield* Effect.forEach(rows, decodeCleanupItem)
    }),
    claimArchiveCleanup: ({ item, leaseToken, leaseExpiresAt }) =>
      claimArchiveCleanup(database, item, leaseToken, leaseExpiresAt),
    completeArchiveCleanup: (item) => Effect.gen(function*() {
      const identity = leasedIdentity(item)
      const result = yield* run(
        database.prepare(
          `DELETE FROM ${queueTable(item)}
           WHERE ${identity.sql}
             AND status = 'leased'
             AND attempt_count = ?${identity.values.length + 1}
             AND lease_token = ?${identity.values.length + 2}`,
        ).bind(...identity.values, item.attempt, item.leaseToken),
        "complete_archive_cleanup",
      )
      if ((yield* changes(result, "complete_archive_cleanup")) !== 1) {
        return yield* Effect.fail(failure("complete_archive_cleanup"))
      }
    }),
    failArchiveCleanup: ({
      item,
      nextAttemptAt,
      dead,
      safeErrorCode,
    }) => Effect.gen(function*() {
      const identity = leasedIdentity(item)
      const parameterOffset = identity.values.length
      const result = yield* run(
        database.prepare(
          `UPDATE ${queueTable(item)}
           SET status = ?${parameterOffset + 1},
               next_attempt_at = ?${parameterOffset + 2},
               lease_token = NULL,
               lease_expires_at = NULL,
               safe_error_code = ?${parameterOffset + 3},
               updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
           WHERE ${identity.sql}
             AND status = 'leased'
             AND attempt_count = ?${parameterOffset + 4}
             AND lease_token = ?${parameterOffset + 5}`,
        ).bind(
          ...identity.values,
          dead ? "dead" : "failed",
          DateTime.toEpochMillis(nextAttemptAt),
          safeErrorCode,
          item.attempt,
          item.leaseToken,
        ),
        "fail_archive_cleanup",
      )
      if ((yield* changes(result, "fail_archive_cleanup")) !== 1) {
        return yield* Effect.fail(failure("fail_archive_cleanup"))
      }
    }),
  })
