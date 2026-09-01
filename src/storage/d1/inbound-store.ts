import { DateTime, Effect, Option, Schema } from "effect"
import {
  InboundStore,
  InboundStoreFailure,
  type CommitInboundInput,
  type CommitInboundResult,
  type CreateInboundArchiveIntentInput,
  type InboundDuplicateKey,
  type InboundStoreOperation,
  type MarkArchiveCleanupInput,
} from "../../adapters/inbound-store.js"
import type { MessageId } from "../../core/identifiers.js"
import type { InboundMessage } from "../../core/message.js"
import type { Scope } from "../../core/scope.js"
import { EmailReceivedEventV1Schema } from "../../core/workflow.js"
import type {
  D1Database,
  D1ExecutionResult,
  D1PreparedStatement,
} from "./contract.js"
import { decodeStoredMessage } from "./row-codecs.js"

const MessagesTable = "popcomputer_email_messages"
const RecipientsTable = "popcomputer_email_recipients"
const WorkflowEventsTable = "popcomputer_email_workflow_events"
const ArchiveIntentsTable = "popcomputer_email_inbound_archive_intents"
const DedupeReceiptsTable = "popcomputer_email_inbound_dedupe_receipts"

const MessageProjection = `
  m.id,
  m.namespace,
  m.environment,
  m.route_id,
  m.workflow_id,
  (
    SELECT e.id
    FROM ${WorkflowEventsTable} AS e
    WHERE e.message_id = m.id
    ORDER BY e.created_at ASC, e.id ASC
    LIMIT 1
  ) AS workflow_event_id,
  m.direction,
  m.status,
  m.state_reason,
  m.from_address,
  m.to_address,
  m.subject,
  m.rfc_message_id,
  m.raw_sha256,
  m.raw_ref,
  m.size_bytes,
  m.idempotency_key,
  m.request_fingerprint,
  m.provider_message_id,
  m.actor_kind,
  m.actor_id,
  m.claimed_at,
  m.sent_at,
  m.received_at,
  m.created_at,
  m.updated_at`

const RecipientProjection = `
  id, message_id, kind, position, address, status, created_at, updated_at`

const IntentRowSchema = Schema.Struct({
  message_id: Schema.String,
  namespace: Schema.String,
  environment: Schema.String,
  raw_sha256: Schema.String,
  raw_ref: Schema.NullOr(Schema.String),
  status: Schema.String,
  expires_at: Schema.Number,
  attempt_count: Schema.Number,
  next_attempt_at: Schema.Number,
  lease_token: Schema.NullOr(Schema.String),
  lease_expires_at: Schema.NullOr(Schema.Number),
  safe_error_code: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  updated_at: Schema.Number,
})

const failure = (operation: InboundStoreOperation): InboundStoreFailure =>
  new InboundStoreFailure({ operation, reason: "unavailable" })

const readFirst = (
  database: D1Database,
  query: string,
  values: ReadonlyArray<unknown>,
  operation: InboundStoreOperation,
): Effect.Effect<unknown | null, InboundStoreFailure> =>
  Effect.tryPromise({
    try: () => database.prepare(query).bind(...values).first<unknown>(),
    catch: () => failure(operation),
  })

const readAll = (
  database: D1Database,
  query: string,
  values: ReadonlyArray<unknown>,
  operation: InboundStoreOperation,
): Effect.Effect<ReadonlyArray<unknown>, InboundStoreFailure> =>
  Effect.tryPromise({
    try: () => database.prepare(query).bind(...values).all<unknown>(),
    catch: () => failure(operation),
  }).pipe(Effect.map((result) => result.results))

const run = (
  statement: D1PreparedStatement,
  operation: InboundStoreOperation,
): Effect.Effect<D1ExecutionResult<unknown>, InboundStoreFailure> =>
  Effect.tryPromise({
    try: () => statement.run<unknown>(),
    catch: () => failure(operation),
  })

const batch = (
  database: D1Database,
  statements: Array<D1PreparedStatement>,
  operation: InboundStoreOperation,
): Effect.Effect<Array<D1ExecutionResult<unknown>>, InboundStoreFailure> =>
  Effect.tryPromise({
    try: () => database.batch(statements),
    catch: () => failure(operation),
  })

const messageIdFromRow = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Only the message identity is needed to load the separately ordered recipient rows.
  input: unknown,
  operation: InboundStoreOperation,
): Effect.Effect<string, InboundStoreFailure> =>
  Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(input).pipe(
    Effect.map((decoded) => decoded.id),
    Effect.mapError(() => failure(operation)),
  )

const loadInboundRow = (
  database: D1Database,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The complete row is delegated to the strict shared message decoder.
  row: unknown,
  operation: InboundStoreOperation,
): Effect.Effect<InboundMessage, InboundStoreFailure> =>
  Effect.gen(function*() {
    const messageId = yield* messageIdFromRow(row, operation)
    const recipients = yield* readAll(
      database,
      `SELECT ${RecipientProjection}
       FROM ${RecipientsTable}
       WHERE message_id = ?1
       ORDER BY CASE kind WHEN 'to' THEN 0 WHEN 'cc' THEN 1 ELSE 2 END,
                position ASC`,
      [messageId],
      operation,
    )
    const stored = yield* decodeStoredMessage(row, recipients).pipe(
      Effect.mapError(() => failure(operation)),
    )
    return stored.message._tag === "Inbound"
      ? stored.message
      : yield* Effect.fail(failure(operation))
  })

const duplicateRows = (
  database: D1Database,
  key: InboundDuplicateKey,
  operation: InboundStoreOperation,
): Effect.Effect<ReadonlyArray<unknown>, InboundStoreFailure> =>
  key._tag === "Provider"
    ? readAll(
        database,
        `SELECT ${MessageProjection}
         FROM ${DedupeReceiptsTable} AS d
         JOIN ${MessagesTable} AS m ON m.id = d.message_id
         WHERE d.namespace = ?1
           AND d.environment = ?2
           AND d.route_id = ?3
           AND d.identity_kind = 'provider'
           AND d.provider = ?4
           AND d.delivery_id = ?5
         LIMIT 2`,
        [
          key.scope.namespace,
          key.scope.environment,
          key.routeId,
          key.provider,
          key.deliveryId,
        ],
        operation,
      )
    : readAll(
        database,
        `SELECT ${MessageProjection}
         FROM ${DedupeReceiptsTable} AS d
         JOIN ${MessagesTable} AS m ON m.id = d.message_id
         WHERE d.namespace = ?1
           AND d.environment = ?2
           AND d.route_id = ?3
           AND d.identity_kind = 'digest'
           AND d.envelope_from = ?4
           AND d.raw_sha256 = ?5
           AND d.expires_at > ?6
         LIMIT 2`,
        [
          key.scope.namespace,
          key.scope.environment,
          key.routeId,
          key.envelopeFrom,
          key.rawSha256,
          DateTime.toEpochMillis(key.observedAt),
        ],
        operation,
      )

const findDuplicate = (
  database: D1Database,
  key: InboundDuplicateKey,
  operation: InboundStoreOperation,
): Effect.Effect<Option.Option<InboundMessage>, InboundStoreFailure> =>
  Effect.gen(function*() {
    const rows = yield* duplicateRows(database, key, operation)
    if (rows.length === 0) return Option.none()
    if (rows.length !== 1) {
      return yield* Effect.fail(failure(operation))
    }
    return Option.some(yield* loadInboundRow(database, rows[0], operation))
  })

const intentById = (
  database: D1Database,
  scope: Scope,
  messageId: MessageId,
  operation: InboundStoreOperation,
) => readFirst(
  database,
  `SELECT message_id, namespace, environment, raw_sha256, raw_ref, status,
          expires_at, attempt_count, next_attempt_at, lease_token,
          lease_expires_at, safe_error_code, created_at, updated_at
   FROM ${ArchiveIntentsTable}
   WHERE namespace = ?1 AND environment = ?2 AND message_id = ?3
   LIMIT 1`,
  [scope.namespace, scope.environment, messageId],
  operation,
)

const createArchiveIntent = (
  database: D1Database,
  input: CreateInboundArchiveIntentInput,
): Effect.Effect<void, InboundStoreFailure> =>
  Effect.gen(function*() {
    yield* run(
      database.prepare(
        `INSERT INTO ${ArchiveIntentsTable} (
           message_id, namespace, environment, raw_sha256, raw_ref, status,
           expires_at, attempt_count, next_attempt_at, lease_token,
           lease_expires_at, safe_error_code, created_at, updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, 'pending', ?6, 0, ?7,
           NULL, NULL, NULL, ?7, ?7
         ) ON CONFLICT(message_id) DO NOTHING`,
      ).bind(
        input.messageId,
        input.scope.namespace,
        input.scope.environment,
        input.rawSha256,
        input.rawRef,
        DateTime.toEpochMillis(input.expiresAt),
        DateTime.toEpochMillis(input.now),
      ),
      "create_archive_intent",
    )
    const row = yield* intentById(
      database,
      input.scope,
      input.messageId,
      "create_archive_intent",
    )
    if (row === null) {
      return yield* Effect.fail(failure("create_archive_intent"))
    }
    const decoded = yield* Schema.decodeUnknownEffect(IntentRowSchema)(row, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => failure("create_archive_intent")))
    if (
      decoded.raw_sha256 !== input.rawSha256 ||
      decoded.expires_at !== DateTime.toEpochMillis(input.expiresAt) ||
      decoded.status !== "pending" ||
      decoded.raw_ref !== input.rawRef
    ) {
      return yield* Effect.fail(failure("create_archive_intent"))
    }
  })

const validateCommit = (
  input: CommitInboundInput,
): Effect.Effect<void, InboundStoreFailure> => {
  const message = input.message
  const recipient = input.recipient
  const workflow = input.workflowEvent
  const scopeMatches = message.scope.namespace ===
      input.duplicateKey.scope.namespace &&
    message.scope.environment === input.duplicateKey.scope.environment
  const rawMatches = input.raw.scope.namespace === message.scope.namespace &&
    input.raw.scope.environment === message.scope.environment &&
    input.raw.direction === "inbound" &&
    input.raw.messageId === message.id &&
    input.raw.sizeBytes === message.sizeBytes
  const recipientMatches = recipient.messageId === message.id &&
    recipient.kind === "to" && recipient.address === message.to[0] &&
    recipient.status === "delivered"
  const duplicateMatches = message.routeId === input.duplicateKey.routeId &&
    (input.duplicateKey._tag === "Provider" || (
      message.from === input.duplicateKey.envelopeFrom &&
      input.raw.sha256 === input.duplicateKey.rawSha256 &&
      DateTime.toEpochMillis(input.duplicateKey.expiresAt) >
        DateTime.toEpochMillis(input.duplicateKey.observedAt)
    ))
  const workflowMatches = message.state._tag === "Received"
    ? workflow === undefined && message.workflowId === undefined
    : workflow !== undefined && message.workflowId !== undefined &&
      workflow.event.eventId === message.state.eventId &&
      workflow.event.message.id === message.id &&
      workflow.event.message.routeId === message.routeId &&
      workflow.event.scope.namespace === message.scope.namespace &&
      workflow.event.scope.environment === message.scope.environment &&
      workflow.event.workflowId === message.workflowId &&
      workflow.state._tag === "Pending"
  return scopeMatches && rawMatches && recipientMatches && duplicateMatches &&
      workflowMatches
    ? Effect.void
    : Effect.fail(failure("commit"))
}

const dedupeReceiptStatement = (
  database: D1Database,
  input: CommitInboundInput,
): D1PreparedStatement => {
  const key = input.duplicateKey
  if (key._tag === "Provider") {
    return database.prepare(
      `INSERT INTO ${DedupeReceiptsTable} (
         message_id, namespace, environment, route_id, identity_kind,
         provider, delivery_id, envelope_from, raw_sha256,
         window_started_at, expires_at
       ) VALUES (
         ?1, ?2, ?3, ?4, 'provider',
         ?5, ?6, NULL, NULL,
         ?7, NULL
       )
       ON CONFLICT(namespace, environment, route_id, provider, delivery_id)
       WHERE identity_kind = 'provider'
       DO NOTHING`,
    ).bind(
      input.message.id,
      key.scope.namespace,
      key.scope.environment,
      key.routeId,
      key.provider,
      key.deliveryId,
      DateTime.toEpochMillis(input.message.createdAt),
    )
  }
  return database.prepare(
    `INSERT INTO ${DedupeReceiptsTable} (
       message_id, namespace, environment, route_id, identity_kind,
       provider, delivery_id, envelope_from, raw_sha256,
       window_started_at, expires_at
     ) VALUES (
       ?1, ?2, ?3, ?4, 'digest',
       NULL, NULL, ?5, ?6,
       ?7, ?8
     )
     ON CONFLICT(namespace, environment, route_id, envelope_from, raw_sha256)
     WHERE identity_kind = 'digest'
     DO UPDATE SET
       message_id = excluded.message_id,
       window_started_at = excluded.window_started_at,
       expires_at = excluded.expires_at
     WHERE ${DedupeReceiptsTable}.expires_at <= excluded.window_started_at`,
  ).bind(
    input.message.id,
    key.scope.namespace,
    key.scope.environment,
    key.routeId,
    key.envelopeFrom,
    key.rawSha256,
    DateTime.toEpochMillis(key.observedAt),
    DateTime.toEpochMillis(key.expiresAt),
  )
}

const commitStatements = (
  database: D1Database,
  input: CommitInboundInput,
): Array<D1PreparedStatement> => {
  const message = input.message
  const receivedAt = DateTime.toEpochMillis(message.receivedAt)
  const createdAt = DateTime.toEpochMillis(message.createdAt)
  const updatedAt = DateTime.toEpochMillis(message.updatedAt)
  const statements: Array<D1PreparedStatement> = [
    database.prepare(
      `INSERT INTO ${MessagesTable} (
         id, namespace, environment, route_id, workflow_id, direction, status,
         state_reason, from_address, to_address, subject, rfc_message_id,
         raw_sha256, raw_ref, size_bytes, idempotency_key,
         request_fingerprint, provider_message_id, actor_kind, actor_id,
         claimed_at, sent_at, received_at, created_at, updated_at
       )
       SELECT
         ?1, ?2, ?3, ?4, ?5, 'inbound', ?6,
         NULL, ?7, ?8, ?9, ?10,
         ?11, ?12, ?13, NULL,
         NULL, NULL, NULL, NULL,
         NULL, NULL, ?14, ?15, ?16
       WHERE EXISTS (
         SELECT 1 FROM ${ArchiveIntentsTable}
         WHERE message_id = ?1 AND namespace = ?2 AND environment = ?3
           AND raw_sha256 = ?11 AND raw_ref = ?12 AND status = 'pending'
       )`,
    ).bind(
      message.id,
      message.scope.namespace,
      message.scope.environment,
      message.routeId,
      message.workflowId ?? null,
      message.state._tag === "Received"
        ? "received"
        : "workflow_event_created",
      message.from,
      message.to[0],
      message.subject,
      message.rfcMessageId ?? null,
      input.raw.sha256,
      input.raw.ref,
      message.sizeBytes,
      receivedAt,
      createdAt,
      updatedAt,
    ),
    dedupeReceiptStatement(database, input),
    database.prepare(
      `DELETE FROM ${MessagesTable}
       WHERE id = ?1
         AND NOT EXISTS (
           SELECT 1 FROM ${DedupeReceiptsTable}
           WHERE message_id = ?1
             AND namespace = ?2
             AND environment = ?3
             AND route_id = ?4
         )`,
    ).bind(
      message.id,
      message.scope.namespace,
      message.scope.environment,
      message.routeId,
    ),
    database.prepare(
      `INSERT INTO ${RecipientsTable} (
         id, message_id, kind, position, address, status, created_at, updated_at
       )
       SELECT ?1, ?2, 'to', 0, ?3, 'delivered', ?4, ?5
       WHERE EXISTS (
         SELECT 1 FROM ${MessagesTable}
         WHERE id = ?2 AND namespace = ?6 AND environment = ?7
           AND direction = 'inbound' AND route_id = ?8 AND raw_sha256 = ?9
       )`,
    ).bind(
      input.recipient.id,
      message.id,
      input.recipient.address,
      DateTime.toEpochMillis(input.recipient.createdAt),
      DateTime.toEpochMillis(input.recipient.updatedAt),
      message.scope.namespace,
      message.scope.environment,
      message.routeId,
      input.raw.sha256,
    ),
  ]

  if (input.workflowEvent !== undefined) {
    const workflow = input.workflowEvent
    const encodedEvent = Schema.encodeSync(EmailReceivedEventV1Schema)(
      workflow.event,
    )
    const nextAttemptAt = workflow.state._tag === "Pending"
      ? DateTime.toEpochMillis(workflow.state.nextAttemptAt)
      : DateTime.toEpochMillis(workflow.createdAt)
    statements.push(database.prepare(
      `INSERT INTO ${WorkflowEventsTable} (
         id, message_id, route_id, namespace, environment, workflow_id,
         event_json, status, attempt_count, next_attempt_at, lease_token,
         lease_expires_at, safe_error_code, external_run_id, created_at,
         updated_at
       )
       SELECT
         ?1, ?2, ?3, ?4, ?5, ?6,
         ?7, 'pending', 0, ?8, NULL,
         NULL, NULL, NULL, ?9, ?10
       WHERE EXISTS (
         SELECT 1 FROM ${MessagesTable}
         WHERE id = ?2 AND namespace = ?4 AND environment = ?5
           AND status = 'workflow_event_created' AND workflow_id = ?6
       )`,
    ).bind(
      workflow.event.eventId,
      message.id,
      message.routeId,
      message.scope.namespace,
      message.scope.environment,
      workflow.event.workflowId,
      JSON.stringify(encodedEvent),
      nextAttemptAt,
      DateTime.toEpochMillis(workflow.createdAt),
      DateTime.toEpochMillis(workflow.updatedAt),
    ))
  }

  statements.push(database.prepare(
    `DELETE FROM ${ArchiveIntentsTable}
     WHERE message_id = ?1 AND namespace = ?2 AND environment = ?3
       AND EXISTS (
         SELECT 1 FROM ${DedupeReceiptsTable}
         WHERE message_id = ?1
           AND namespace = ?2
           AND environment = ?3
       )`,
  ).bind(
    message.id,
    message.scope.namespace,
    message.scope.environment,
  ))
  return statements
}

const commit = (
  database: D1Database,
  input: CommitInboundInput,
): Effect.Effect<CommitInboundResult, InboundStoreFailure> =>
  Effect.gen(function*() {
    yield* validateCommit(input)
    yield* batch(
      database,
      commitStatements(database, input),
      "commit",
    )
    const duplicate = yield* findDuplicate(
      database,
      input.duplicateKey,
      "commit",
    )
    if (Option.isNone(duplicate)) {
      return yield* Effect.fail(failure("commit"))
    }
    return duplicate.value.id === input.message.id
      ? { _tag: "Created", message: duplicate.value }
      : { _tag: "Existing", message: duplicate.value }
  })

const markArchiveCleanup = (
  database: D1Database,
  input: MarkArchiveCleanupInput,
): Effect.Effect<void, InboundStoreFailure> =>
  Effect.gen(function*() {
    const now = DateTime.toEpochMillis(input.now)
    const nextAttemptAt = DateTime.toEpochMillis(input.nextAttemptAt)
    yield* run(
      database.prepare(
        `UPDATE ${ArchiveIntentsTable}
         SET status = 'failed',
             next_attempt_at = ?1,
             lease_token = NULL,
             lease_expires_at = NULL,
             safe_error_code = ?2,
             updated_at = ?3
         WHERE namespace = ?4
           AND environment = ?5
           AND message_id = ?6
           AND raw_ref = ?7
           AND status = 'pending'`,
      ).bind(
        nextAttemptAt,
        input.safeErrorCode,
        now,
        input.scope.namespace,
        input.scope.environment,
        input.messageId,
        input.rawRef,
      ),
      "mark_archive_cleanup",
    )
    const row = yield* intentById(
      database,
      input.scope,
      input.messageId,
      "mark_archive_cleanup",
    )
    const decoded = yield* Schema.decodeUnknownEffect(
      IntentRowSchema,
    )(row, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => failure("mark_archive_cleanup")),
    )
    if (
      decoded.raw_ref !== input.rawRef ||
      decoded.safe_error_code !== input.safeErrorCode ||
      (
        decoded.status !== "failed" &&
        decoded.status !== "leased" &&
        decoded.status !== "dead"
      )
    ) {
      return yield* Effect.fail(failure("mark_archive_cleanup"))
    }
  })

/** Construct the D1 implementation of inbound dedupe and atomic outbox commit. */
export const makeD1InboundStore = (database: D1Database) =>
  InboundStore.of({
    findDuplicate: (key) => findDuplicate(database, key, "find_duplicate"),
    createArchiveIntent: (input) => createArchiveIntent(database, input),
    commit: (input) => commit(database, input),
    deleteArchiveIntent: (scope, messageId) =>
      run(
        database.prepare(
          `DELETE FROM ${ArchiveIntentsTable}
           WHERE namespace = ?1 AND environment = ?2 AND message_id = ?3`,
        ).bind(scope.namespace, scope.environment, messageId),
        "delete_archive_intent",
      ).pipe(Effect.asVoid),
    markArchiveCleanup: (input) => markArchiveCleanup(database, input),
  })
