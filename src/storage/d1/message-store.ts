import { DateTime, Effect, Option, Result, Schema } from "effect"
import {
  MessageStore,
  MessageStoreFailure,
  MessageTransitionConflict,
  type AttachOutboundRawInput,
  type ClaimOutboundInput,
  type ClaimOutboundResult,
  type CreateOutboundArchiveIntentInput,
  type FinalizeOutboundInput,
  type FindOutboundByIdempotencyInput,
  type GetMessageInput,
  type ListMessagesInput,
  type OutboundFinalization,
  type ReserveOutboundInput,
  type ReserveOutboundResult,
  type StoredMessage,
  type StoredMessagePage,
  type StoredOutboundMessage,
} from "../../adapters/message-store.js"
import type { EmailAddress } from "../../core/address.js"
import {
  DefaultPageSize,
  InvalidPageRequest,
  MaximumPageSize,
  type MessageId,
  PageCursorSchema,
  type PageCursor,
} from "../../core/identifiers.js"
import {
  InvalidStoredMessage,
  isSending,
  type MessageRecipient,
} from "../../core/message.js"
import type {
  D1Database,
  D1PreparedStatement,
} from "./contract.js"
import {
  decodeStoredMessage,
  decodeStoredOutboundMessage,
} from "./row-codecs.js"

const MessagesTable = "popcomputer_email_messages"
const RecipientsTable = "popcomputer_email_recipients"
const WorkflowEventsTable = "popcomputer_email_workflow_events"
const OutboundArchiveIntentsTable =
  "popcomputer_email_outbound_archive_intents"

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
  id,
  message_id,
  kind,
  position,
  address,
  status,
  created_at,
  updated_at`

const ChangedRowsSchema = Schema.Struct({
  meta: Schema.Struct({
    changes: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
    ),
  }),
})

const CursorSchema = Schema.Struct({
  version: Schema.Literal(1),
  createdAt: Schema.Number.check(
    Schema.isFinite(),
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  messageId: Schema.String,
})

const OutboundArchiveIntentRowSchema = Schema.Struct({
  namespace: Schema.String,
  environment: Schema.String,
  raw_sha256: Schema.String,
  raw_ref: Schema.String,
  size_bytes: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  status: Schema.String,
})

interface DecodedCursor {
  readonly createdAt: number
  readonly messageId: string
}

interface RecipientUpdate {
  readonly recipientId: MessageRecipient["id"]
  readonly status: "captured" | "queued" | "failed"
}

interface FinalizationProjection {
  readonly targetStatus:
    | "captured"
    | "accepted"
    | "partially_accepted"
    | "delivery_unknown"
    | "failed"
  readonly expectedStatusSql: string
  readonly stateReason: string | null
  readonly providerMessageId: string | null
  readonly sentAt: number | null
  readonly updatedAt: number
}

const storeFailure = (
  operation: MessageStoreFailure["operation"],
): MessageStoreFailure => new MessageStoreFailure({
  operation,
  reason: "unavailable",
})

const invalidStored = (
  reason: InvalidStoredMessage["reason"],
): InvalidStoredMessage => new InvalidStoredMessage({ reason })

const transitionConflict = (
  messageId: MessageId,
): MessageTransitionConflict => new MessageTransitionConflict({
  messageId,
  reason: "concurrent_update",
})

const changedRows = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- D1 execution metadata is untrusted at this adapter boundary and is immediately decoded with ChangedRowsSchema.
  result: unknown,
  operation: MessageStoreFailure["operation"],
): Effect.Effect<number, MessageStoreFailure> =>
  Schema.decodeUnknownEffect(ChangedRowsSchema)(result).pipe(
    Effect.map((decoded) => decoded.meta.changes),
    Effect.mapError(() => storeFailure(operation)),
  )

const runBatch = (
  database: D1Database,
  statements: Array<D1PreparedStatement>,
  operation: MessageStoreFailure["operation"],
): Effect.Effect<ReadonlyArray<unknown>, MessageStoreFailure> =>
  Effect.tryPromise({
    try: () => database.batch(statements),
    catch: () => storeFailure(operation),
  })

const readFirst = (
  database: D1Database,
  query: string,
  values: ReadonlyArray<unknown>,
  operation: MessageStoreFailure["operation"],
): Effect.Effect<unknown | null, MessageStoreFailure> =>
  Effect.tryPromise({
    try: () => database.prepare(query).bind(...values).first<unknown>(),
    catch: () => storeFailure(operation),
  })

const readAll = (
  database: D1Database,
  query: string,
  values: ReadonlyArray<unknown>,
  operation: MessageStoreFailure["operation"],
): Effect.Effect<ReadonlyArray<unknown>, MessageStoreFailure> =>
  Effect.tryPromise({
    try: () => database.prepare(query).bind(...values).all<unknown>(),
    catch: () => storeFailure(operation),
  }).pipe(Effect.map((result) => result.results))

const readRecipients = (
  database: D1Database,
  messageId: string,
  operation: MessageStoreFailure["operation"],
): Effect.Effect<ReadonlyArray<unknown>, MessageStoreFailure> =>
  readAll(
    database,
    `SELECT ${RecipientProjection}
     FROM ${RecipientsTable}
     WHERE message_id = ?1
     ORDER BY
       CASE kind WHEN 'to' THEN 0 WHEN 'cc' THEN 1 ELSE 2 END,
       position ASC`,
    [messageId],
    operation,
  )

const loadStoredFromRow = (
  database: D1Database,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This value came directly from D1 and is passed immediately to the strict persisted-row codec.
  row: unknown,
  messageId: string,
  operation: MessageStoreFailure["operation"],
): Effect.Effect<StoredMessage, MessageStoreFailure | InvalidStoredMessage> =>
  Effect.gen(function* () {
    const recipients = yield* readRecipients(
      database,
      messageId,
      operation,
    )
    return yield* decodeStoredMessage(row, recipients)
  })

const loadById = (
  database: D1Database,
  input: GetMessageInput,
  operation: MessageStoreFailure["operation"],
): Effect.Effect<
  Option.Option<StoredMessage>,
  MessageStoreFailure | InvalidStoredMessage
> =>
  Effect.gen(function* () {
    const row = yield* readFirst(
      database,
      `SELECT ${MessageProjection}
       FROM ${MessagesTable} AS m
       WHERE m.namespace = ?1
         AND m.environment = ?2
         AND m.id = ?3
       LIMIT 1`,
      [input.scope.namespace, input.scope.environment, input.messageId],
      operation,
    )
    if (row === null) {
      return Option.none()
    }
    const record = yield* loadStoredFromRow(
      database,
      row,
      input.messageId,
      operation,
    )
    return Option.some(record)
  })

const loadOutboundById = (
  database: D1Database,
  input: GetMessageInput,
  operation: MessageStoreFailure["operation"],
): Effect.Effect<
  Option.Option<StoredOutboundMessage>,
  MessageStoreFailure | InvalidStoredMessage
> =>
  loadById(database, input, operation).pipe(
    Effect.flatMap((record) => {
      if (Option.isNone(record)) {
        return Effect.succeed(Option.none())
      }
      if (record.value.message._tag !== "Outbound") {
        return Effect.fail(invalidStored("invalid_state"))
      }
      return Effect.succeed(Option.some({
        message: record.value.message,
        recipients: record.value.recipients,
        raw: record.value.raw,
      }))
    }),
  )

const loadOutboundByIdempotency = (
  database: D1Database,
  input: FindOutboundByIdempotencyInput,
  operation: MessageStoreFailure["operation"],
): Effect.Effect<
  Option.Option<StoredOutboundMessage>,
  MessageStoreFailure | InvalidStoredMessage
> =>
  Effect.gen(function* () {
    const row = yield* readFirst(
      database,
      `SELECT ${MessageProjection}
       FROM ${MessagesTable} AS m
       WHERE m.namespace = ?1
         AND m.environment = ?2
         AND m.direction = 'outbound'
         AND m.idempotency_key = ?3
       LIMIT 1`,
      [
        input.scope.namespace,
        input.scope.environment,
        input.idempotencyKey,
      ],
      operation,
    )
    if (row === null) {
      return Option.none()
    }
    const recipients = yield* readRecipients(
      database,
      // The row is still untrusted; the strict decoder will verify this value.
      // Loading by key cannot safely read `id` before parsing, so select it once
      // with a narrow companion query rather than shape-casting the row.
      yield* readMessageIdByIdempotency(database, input, operation),
      operation,
    )
    const record = yield* decodeStoredOutboundMessage(row, recipients)
    return Option.some(record)
  })

const readMessageIdByIdempotency = (
  database: D1Database,
  input: FindOutboundByIdempotencyInput,
  operation: MessageStoreFailure["operation"],
): Effect.Effect<string, MessageStoreFailure | InvalidStoredMessage> =>
  readFirst(
    database,
    `SELECT id
     FROM ${MessagesTable}
     WHERE namespace = ?1
       AND environment = ?2
       AND direction = 'outbound'
       AND idempotency_key = ?3
     LIMIT 1`,
    [
      input.scope.namespace,
      input.scope.environment,
      input.idempotencyKey,
    ],
    operation,
  ).pipe(
    Effect.flatMap((row) =>
      Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(row, {
        onExcessProperty: "error",
      }).pipe(
        Effect.map((decoded) => decoded.id),
        Effect.mapError(() => invalidStored("invalid_row")),
      ),
    ),
  )

const actorKind = (
  actor: ReserveOutboundInput["message"]["actor"],
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

const sameAddresses = (
  left: ReadonlyArray<EmailAddress>,
  right: ReadonlyArray<EmailAddress>,
): boolean =>
  left.length === right.length &&
  left.every((address, index) => address === right[index])

const validateReservationRecipients = (
  input: ReserveOutboundInput,
): Effect.Effect<void, InvalidStoredMessage> => {
  const to = input.recipients
    .filter((recipient) => recipient.kind === "to")
    .map((recipient) => recipient.address)
  const cc = input.recipients
    .filter((recipient) => recipient.kind === "cc")
    .map((recipient) => recipient.address)
  const bcc = input.recipients
    .filter((recipient) => recipient.kind === "bcc")
    .map((recipient) => recipient.address)

  return sameAddresses(to, input.message.to) &&
      sameAddresses(cc, input.message.cc) &&
      sameAddresses(bcc, input.message.bcc)
    ? Effect.void
    : Effect.fail(invalidStored("invalid_recipient"))
}

const reserveStatements = (
  database: D1Database,
  input: ReserveOutboundInput,
): Array<D1PreparedStatement> => {
  const message = input.message
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
      ) VALUES (
        ?1, ?2, ?3, ?4, NULL, 'outbound', 'reserved',
        NULL, ?5, ?6, ?7, NULL,
        NULL, NULL, ?8, ?9,
        ?10, NULL, ?11, ?12,
        NULL, NULL, NULL, ?13, ?14
      ) ON CONFLICT DO NOTHING`,
    ).bind(
      message.id,
      message.scope.namespace,
      message.scope.environment,
      message.routeId,
      message.from,
      message.to[0],
      message.subject,
      message.sizeBytes,
      message.idempotencyKey,
      message.requestFingerprint,
      actorKind(message.actor),
      message.actor.id,
      createdAt,
      updatedAt,
    ),
  ]

  const nextPosition = new Map<"to" | "cc" | "bcc", number>()
  for (const recipient of input.recipients) {
    const position = nextPosition.get(recipient.kind) ?? 0
    nextPosition.set(recipient.kind, position + 1)
    statements.push(
      database.prepare(
        `INSERT INTO ${RecipientsTable} (
          id, message_id, kind, position, address, status, created_at, updated_at
        )
        SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7
        WHERE EXISTS (
          SELECT 1
          FROM ${MessagesTable}
          WHERE id = ?2
            AND namespace = ?8
            AND environment = ?9
            AND direction = 'outbound'
            AND idempotency_key = ?10
        )`,
      ).bind(
        recipient.id,
        message.id,
        recipient.kind,
        position,
        recipient.address,
        createdAt,
        updatedAt,
        message.scope.namespace,
        message.scope.environment,
        message.idempotencyKey,
      ),
    )
  }
  return statements
}

const reserveOutbound = (
  database: D1Database,
  input: ReserveOutboundInput,
): Effect.Effect<
  ReserveOutboundResult,
  MessageStoreFailure | InvalidStoredMessage
> =>
  Effect.gen(function* () {
    yield* validateReservationRecipients(input)
    const lookup = {
      scope: input.message.scope,
      idempotencyKey: input.message.idempotencyKey,
    }
    const existing = yield* loadOutboundByIdempotency(
      database,
      lookup,
      "reserve",
    )
    if (Option.isSome(existing)) {
      return { _tag: "Existing", record: existing.value }
    }

    const results = yield* runBatch(
      database,
      reserveStatements(database, input),
      "reserve",
    ).pipe(
      Effect.catch(() =>
        loadOutboundByIdempotency(database, lookup, "reserve").pipe(
          Effect.flatMap((raced) =>
            Option.isSome(raced)
              ? Effect.succeed<ReadonlyArray<unknown>>([])
              : Effect.fail(storeFailure("reserve")),
          ),
        ),
      ),
    )

    const record = yield* loadOutboundByIdempotency(
      database,
      lookup,
      "reserve",
    ).pipe(
      Effect.flatMap((loaded) =>
        Option.isSome(loaded)
          ? Effect.succeed(loaded.value)
          : Effect.fail(storeFailure("reserve")),
      ),
    )

    if (results.length === 0) {
      return { _tag: "Existing", record }
    }
    const inserted = yield* changedRows(results[0], "reserve")
    if (inserted === 1 && record.message.id === input.message.id) {
      return { _tag: "Created", record }
    }
    return { _tag: "Existing", record }
  })

const sameRaw = (
  record: StoredOutboundMessage,
  input: AttachOutboundRawInput,
): boolean =>
  Option.isSome(record.raw) &&
  record.raw.value.ref === input.raw.ref &&
  record.raw.value.sha256 === input.raw.sha256 &&
  record.raw.value.sizeBytes === input.raw.sizeBytes

const createOutboundArchiveIntent = (
  database: D1Database,
  input: CreateOutboundArchiveIntentInput,
): Effect.Effect<
  void,
  MessageStoreFailure | MessageTransitionConflict | InvalidStoredMessage
> =>
  Effect.gen(function*() {
    const expiresAt = DateTime.toEpochMillis(input.expiresAt)
    const now = DateTime.toEpochMillis(input.now)
    if (expiresAt <= now) {
      return yield* Effect.fail(transitionConflict(input.messageId))
    }

    const attempted = yield* Effect.result(runBatch(database, [
      database.prepare(
        `INSERT INTO ${OutboundArchiveIntentsTable} (
           message_id, namespace, environment, raw_sha256, raw_ref, size_bytes,
           status, expires_at, attempt_count, next_attempt_at, lease_token,
           lease_expires_at, safe_error_code, created_at, updated_at
         )
         SELECT
           ?1, ?2, ?3, ?4, ?5, ?6,
           'pending', ?7, 0, ?8, NULL,
           NULL, NULL, ?8, ?8
         FROM ${MessagesTable}
         WHERE id = ?1
           AND namespace = ?2
           AND environment = ?3
           AND direction = 'outbound'
           AND status = 'reserved'
           AND raw_ref IS NULL
           AND raw_sha256 IS NULL
           AND size_bytes = ?6
         ON CONFLICT(message_id) DO UPDATE SET
           status = 'pending',
           expires_at = excluded.expires_at,
           attempt_count = 0,
           next_attempt_at = excluded.next_attempt_at,
           lease_token = NULL,
           lease_expires_at = NULL,
           safe_error_code = NULL,
           updated_at = excluded.updated_at
         WHERE ${OutboundArchiveIntentsTable}.namespace = excluded.namespace
           AND ${OutboundArchiveIntentsTable}.environment = excluded.environment
           AND ${OutboundArchiveIntentsTable}.raw_sha256 = excluded.raw_sha256
           AND ${OutboundArchiveIntentsTable}.raw_ref = excluded.raw_ref
           AND ${OutboundArchiveIntentsTable}.size_bytes = excluded.size_bytes
           AND ${OutboundArchiveIntentsTable}.status != 'leased'`,
      ).bind(
        input.messageId,
        input.scope.namespace,
        input.scope.environment,
        input.raw.sha256,
        input.raw.ref,
        input.raw.sizeBytes,
        expiresAt,
        now,
      ),
    ], "create_archive_intent"))

    const row = yield* readFirst(
      database,
      `SELECT namespace, environment, raw_sha256, raw_ref, size_bytes, status
       FROM ${OutboundArchiveIntentsTable}
       WHERE message_id = ?1 AND namespace = ?2 AND environment = ?3
       LIMIT 1`,
      [input.messageId, input.scope.namespace, input.scope.environment],
      "create_archive_intent",
    )
    if (row !== null) {
      const intent = yield* Schema.decodeUnknownEffect(
        OutboundArchiveIntentRowSchema,
      )(row, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => storeFailure("create_archive_intent")),
      )
      if (
        intent.namespace === input.scope.namespace &&
        intent.environment === input.scope.environment &&
        intent.raw_sha256 === input.raw.sha256 &&
        intent.raw_ref === input.raw.ref &&
        intent.size_bytes === input.raw.sizeBytes &&
        intent.status === "pending"
      ) {
        return
      }
    }

    const loaded = yield* loadOutboundById(
      database,
      { scope: input.scope, messageId: input.messageId },
      "create_archive_intent",
    )
    if (Option.isSome(loaded) && sameRaw(loaded.value, input)) return
    if (Result.isFailure(attempted)) return yield* attempted.failure
    return yield* new MessageTransitionConflict({
      messageId: input.messageId,
      reason: "concurrent_update",
    })
  })

const attachOutboundRaw = (
  database: D1Database,
  input: AttachOutboundRawInput,
): Effect.Effect<
  StoredOutboundMessage,
  MessageStoreFailure | MessageTransitionConflict | InvalidStoredMessage
> =>
  Effect.gen(function* () {
    const attempted = yield* Effect.result(runBatch(database, [
      database.prepare(
        `UPDATE ${MessagesTable}
         SET raw_ref = ?1,
             raw_sha256 = ?2,
             size_bytes = ?3
         WHERE namespace = ?4
           AND environment = ?5
           AND id = ?6
           AND direction = 'outbound'
           AND NOT EXISTS (
             SELECT 1 FROM ${OutboundArchiveIntentsTable}
             WHERE message_id = ?6
               AND namespace = ?4
               AND environment = ?5
               AND status = 'leased'
           )
           AND (
             (
               status = 'reserved'
               AND raw_ref IS NULL
               AND raw_sha256 IS NULL
               AND EXISTS (
                 SELECT 1 FROM ${OutboundArchiveIntentsTable}
                 WHERE message_id = ?6
                   AND namespace = ?4
                   AND environment = ?5
                   AND raw_ref = ?1
                   AND raw_sha256 = ?2
                   AND size_bytes = ?3
                   AND status = 'pending'
               )
             )
             OR
             (raw_ref = ?1 AND raw_sha256 = ?2 AND size_bytes = ?3)
           )`,
      ).bind(
        input.raw.ref,
        input.raw.sha256,
        input.raw.sizeBytes,
        input.scope.namespace,
        input.scope.environment,
        input.messageId,
      ),
      database.prepare(
        `DELETE FROM ${OutboundArchiveIntentsTable}
         WHERE message_id = ?1
           AND namespace = ?2
           AND environment = ?3
           AND raw_ref = ?4
           AND raw_sha256 = ?5
           AND size_bytes = ?6
           AND status != 'leased'
           AND EXISTS (
             SELECT 1 FROM ${MessagesTable}
             WHERE id = ?1
               AND namespace = ?2
               AND environment = ?3
               AND direction = 'outbound'
               AND raw_ref = ?4
               AND raw_sha256 = ?5
               AND size_bytes = ?6
           )`,
      ).bind(
        input.messageId,
        input.scope.namespace,
        input.scope.environment,
        input.raw.ref,
        input.raw.sha256,
        input.raw.sizeBytes,
      ),
    ], "attach_raw"))
    const loaded = yield* loadOutboundById(
      database,
      { scope: input.scope, messageId: input.messageId },
      "attach_raw",
    )
    if (Option.isNone(loaded)) {
      return yield* Effect.fail(transitionConflict(input.messageId))
    }
    if (sameRaw(loaded.value, input)) return loaded.value
    if (Result.isFailure(attempted)) return yield* attempted.failure
    return yield* Effect.fail(transitionConflict(input.messageId))
  })

const claimOutbound = (
  database: D1Database,
  input: ClaimOutboundInput,
): Effect.Effect<
  ClaimOutboundResult,
  MessageStoreFailure | InvalidStoredMessage
> =>
  Effect.gen(function* () {
    const claimedAt = DateTime.toEpochMillis(input.claimedAt)
    const results = yield* runBatch(database, [
      database.prepare(
        `UPDATE ${MessagesTable}
         SET status = 'sending',
             claimed_at = ?1,
             updated_at = ?1
         WHERE namespace = ?2
           AND environment = ?3
           AND id = ?4
           AND direction = 'outbound'
           AND status = 'reserved'
           AND raw_ref IS NOT NULL
           AND raw_sha256 IS NOT NULL`,
      ).bind(
        claimedAt,
        input.scope.namespace,
        input.scope.environment,
        input.messageId,
      ),
    ], "claim")
    const claimed = yield* changedRows(results[0], "claim")
    const loaded = yield* loadOutboundById(
      database,
      { scope: input.scope, messageId: input.messageId },
      "claim",
    ).pipe(
      Effect.flatMap((record) =>
        Option.isSome(record)
          ? Effect.succeed(record.value)
          : Effect.fail(storeFailure("claim")),
      ),
    )

    if (claimed === 1) {
      if (!isSending(loaded.message)) {
        return yield* Effect.fail(invalidStored("invalid_state"))
      }
      return {
        _tag: "Claimed",
        record: {
          message: loaded.message,
          recipients: loaded.recipients,
          raw: loaded.raw,
        },
      }
    }
    return { _tag: "NotClaimed", record: loaded }
  })

const projectFinalization = (
  finalization: OutboundFinalization,
): FinalizationProjection => {
  switch (finalization._tag) {
    case "Captured":
      return {
        targetStatus: "captured",
        expectedStatusSql: "status = 'sending'",
        stateReason: null,
        providerMessageId: null,
        sentAt: null,
        updatedAt: DateTime.toEpochMillis(finalization.capturedAt),
      }
    case "Accepted":
      return {
        targetStatus: "accepted",
        expectedStatusSql: "status = 'sending'",
        stateReason: null,
        providerMessageId: finalization.providerMessageId ?? null,
        sentAt: DateTime.toEpochMillis(finalization.sentAt),
        updatedAt: DateTime.toEpochMillis(finalization.sentAt),
      }
    case "PartiallyAccepted":
      return {
        targetStatus: "partially_accepted",
        expectedStatusSql: "status = 'sending'",
        stateReason: null,
        providerMessageId: finalization.providerMessageId ?? null,
        sentAt: DateTime.toEpochMillis(finalization.sentAt),
        updatedAt: DateTime.toEpochMillis(finalization.sentAt),
      }
    case "DeliveryUnknown":
      return {
        targetStatus: "delivery_unknown",
        expectedStatusSql: "status = 'sending'",
        stateReason: finalization.reason,
        providerMessageId: null,
        sentAt: null,
        updatedAt: DateTime.toEpochMillis(finalization.occurredAt),
      }
    case "Failed":
      return {
        targetStatus: "failed",
        expectedStatusSql: finalization.reason === "archive"
          ? "status = 'reserved'"
          : finalization.reason === "provider_rejected"
            ? "status = 'sending'"
            : "status IN ('reserved', 'sending')",
        stateReason: finalization.reason,
        providerMessageId: null,
        sentAt: null,
        updatedAt: DateTime.toEpochMillis(finalization.failedAt),
      }
  }
}

const outcomeStatusByAddress = (
  outcomes: ReadonlyArray<
    Extract<OutboundFinalization, { readonly _tag: "Accepted" }>[
      "outcomes"
    ][number]
  >,
): Map<EmailAddress, "queued" | "failed"> | undefined => {
  const statuses = new Map<EmailAddress, "queued" | "failed">()
  for (const outcome of outcomes) {
    const status = outcome._tag === "Accepted" ? "queued" : "failed"
    const current = statuses.get(outcome.address)
    if (current !== undefined && current !== status) {
      return undefined
    }
    statuses.set(outcome.address, status)
  }
  return statuses
}

const recipientUpdates = (
  messageId: MessageId,
  recipients: ReadonlyArray<MessageRecipient>,
  finalization: OutboundFinalization,
): Effect.Effect<ReadonlyArray<RecipientUpdate>, MessageTransitionConflict> => {
  switch (finalization._tag) {
    case "Captured":
      return Effect.succeed(recipients.map((recipient) => ({
        recipientId: recipient.id,
        status: "captured" as const,
      })))
    case "Accepted": {
      const statuses = outcomeStatusByAddress(finalization.outcomes)
      const addresses = new Set(
        recipients.map((recipient) => recipient.address),
      )
      if (
        statuses === undefined ||
        [...statuses.keys()].some((address) => !addresses.has(address)) ||
        [...statuses.values()].some((status) => status !== "queued") ||
        (statuses.size > 0 &&
          recipients.some((recipient) => !statuses.has(recipient.address)))
      ) {
        return Effect.fail(transitionConflict(messageId))
      }
      return Effect.succeed(recipients.map((recipient) => ({
        recipientId: recipient.id,
        status: "queued" as const,
      })))
    }
    case "PartiallyAccepted": {
      const statuses = outcomeStatusByAddress(finalization.outcomes)
      const addresses = new Set(
        recipients.map((recipient) => recipient.address),
      )
      if (
        statuses === undefined ||
        [...statuses.keys()].some((address) => !addresses.has(address)) ||
        ![...statuses.values()].includes("queued") ||
        ![...statuses.values()].includes("failed") ||
        recipients.some((recipient) => !statuses.has(recipient.address))
      ) {
        return Effect.fail(transitionConflict(messageId))
      }
      return Effect.succeed(recipients.map((recipient) => ({
        recipientId: recipient.id,
        status: statuses.get(recipient.address) ?? "failed",
      })))
    }
    case "Failed":
      return finalization.reason === "provider_rejected"
        ? Effect.succeed(recipients.map((recipient) => ({
            recipientId: recipient.id,
            status: "failed" as const,
          })))
        : Effect.succeed([])
    case "DeliveryUnknown":
      return Effect.succeed([])
  }
}

const matchesRecipientUpdates = (
  recipients: ReadonlyArray<MessageRecipient>,
  updates: ReadonlyArray<RecipientUpdate>,
): boolean => {
  if (updates.length === 0) {
    return true
  }
  if (updates.length !== recipients.length) {
    return false
  }
  const recipientById = new Map(
    recipients.map((recipient) => [recipient.id, recipient]),
  )
  return updates.every((update) => {
    const current = recipientById.get(update.recipientId)?.status
    switch (update.status) {
      case "captured":
        return current === "captured"
      case "queued":
        return current === "queued" || current === "delivered"
      case "failed":
        return current === "failed" || current === "permanent_bounce"
    }
  })
}

const sameFinalization = (
  record: StoredOutboundMessage,
  finalization: OutboundFinalization,
): boolean => {
  const state = record.message.state
  if (state._tag !== finalization._tag) {
    return false
  }
  switch (finalization._tag) {
    case "Captured":
      return state._tag === "Captured" &&
        DateTime.toEpochMillis(state.capturedAt) ===
          DateTime.toEpochMillis(finalization.capturedAt)
    case "Accepted":
      return state._tag === "Accepted" &&
        DateTime.toEpochMillis(state.sentAt) ===
          DateTime.toEpochMillis(finalization.sentAt) &&
        state.providerMessageId === finalization.providerMessageId
    case "PartiallyAccepted":
      return state._tag === "PartiallyAccepted" &&
        DateTime.toEpochMillis(state.sentAt) ===
          DateTime.toEpochMillis(finalization.sentAt) &&
        state.providerMessageId === finalization.providerMessageId
    case "DeliveryUnknown":
      return state._tag === "DeliveryUnknown" &&
        DateTime.toEpochMillis(state.occurredAt) ===
          DateTime.toEpochMillis(finalization.occurredAt) &&
        state.reason === finalization.reason
    case "Failed":
      return state._tag === "Failed" &&
        DateTime.toEpochMillis(state.failedAt) ===
          DateTime.toEpochMillis(finalization.failedAt) &&
        state.reason === finalization.reason
  }
}

const finalizeOutbound = (
  database: D1Database,
  input: FinalizeOutboundInput,
): Effect.Effect<
  StoredOutboundMessage,
  MessageStoreFailure | MessageTransitionConflict | InvalidStoredMessage
> =>
  Effect.gen(function* () {
    const current = yield* loadOutboundById(
      database,
      { scope: input.scope, messageId: input.messageId },
      "finalize",
    )
    if (Option.isNone(current)) {
      return yield* Effect.fail(transitionConflict(input.messageId))
    }
    const updates = yield* recipientUpdates(
      input.messageId,
      current.value.recipients,
      input.finalization,
    ).pipe(
      Effect.mapError(() => transitionConflict(input.messageId)),
    )
    if (
      sameFinalization(current.value, input.finalization) &&
      matchesRecipientUpdates(current.value.recipients, updates)
    ) {
      return current.value
    }

    const projection = projectFinalization(input.finalization)
    const statements: Array<D1PreparedStatement> = [
      database.prepare(
        `UPDATE ${MessagesTable}
         SET status = ?1,
             state_reason = ?2,
             provider_message_id = ?3,
             sent_at = ?4,
             updated_at = ?5
         WHERE namespace = ?6
           AND environment = ?7
           AND id = ?8
           AND direction = 'outbound'
           AND ${projection.expectedStatusSql}`,
      ).bind(
        projection.targetStatus,
        projection.stateReason,
        projection.providerMessageId,
        projection.sentAt,
        projection.updatedAt,
        input.scope.namespace,
        input.scope.environment,
        input.messageId,
      ),
    ]

    for (const update of updates) {
      statements.push(
        database.prepare(
          `UPDATE ${RecipientsTable}
           SET status = ?1,
               updated_at = ?2
           WHERE id = ?3
             AND message_id = ?4
             AND status = 'pending'
             AND EXISTS (
               SELECT 1
               FROM ${MessagesTable}
               WHERE id = ?4
                 AND namespace = ?5
                 AND environment = ?6
                 AND status = ?7
                 AND updated_at = ?2
             )`,
        ).bind(
          update.status,
          projection.updatedAt,
          update.recipientId,
          input.messageId,
          input.scope.namespace,
          input.scope.environment,
          projection.targetStatus,
        ),
      )
    }

    const results = yield* runBatch(database, statements, "finalize")
    const finalized = yield* changedRows(results[0], "finalize")
    const loaded = yield* loadOutboundById(
      database,
      { scope: input.scope, messageId: input.messageId },
      "finalize",
    )
    if (Option.isNone(loaded)) {
      return yield* Effect.fail(transitionConflict(input.messageId))
    }
    if (
      finalized === 1 ||
      (sameFinalization(loaded.value, input.finalization) &&
        matchesRecipientUpdates(loaded.value.recipients, updates))
    ) {
      return loaded.value
    }
    return yield* Effect.fail(transitionConflict(input.messageId))
  })

const encodeCursor = (message: StoredMessage["message"]): PageCursor =>
  PageCursorSchema.make(btoa(JSON.stringify({
    version: 1,
    createdAt: DateTime.toEpochMillis(message.createdAt),
    messageId: message.id,
  }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, ""))

const decodeCursor = (
  input: PageCursor,
): Effect.Effect<DecodedCursor, InvalidPageRequest> => {
  if (!/^[A-Za-z0-9_-]+$/u.test(input)) {
    return Effect.fail(new InvalidPageRequest({ reason: "invalid_cursor" }))
  }
  const padding = "=".repeat((4 - input.length % 4) % 4)
  return Effect.try({
    try: () => {
      const encoded = input.replaceAll("-", "+").replaceAll("_", "/") +
        padding
      const decoded: unknown = JSON.parse(atob(encoded))
      return Schema.decodeUnknownSync(CursorSchema)(decoded, {
        onExcessProperty: "error",
      })
    },
    catch: () => new InvalidPageRequest({ reason: "invalid_cursor" }),
  }).pipe(
    Effect.map((cursor) => ({
      createdAt: cursor.createdAt,
      messageId: cursor.messageId,
    })),
  )
}

const listMessages = (
  database: D1Database,
  input: ListMessagesInput,
): Effect.Effect<
  StoredMessagePage,
  InvalidPageRequest | MessageStoreFailure | InvalidStoredMessage
> =>
  Effect.gen(function* () {
    const limit = input.limit ?? DefaultPageSize
    if (!Number.isInteger(limit) || limit < 1 || limit > MaximumPageSize) {
      return yield* new InvalidPageRequest({ reason: "invalid_limit" })
    }
    const cursor = input.cursor === undefined
      ? undefined
      : yield* decodeCursor(input.cursor)
    const values: Array<unknown> = [
      input.scope.namespace,
      input.scope.environment,
    ]
    const predicates = [
      "m.namespace = ?1",
      "m.environment = ?2",
    ]

    if (input.direction !== undefined) {
      values.push(input.direction)
      predicates.push(`m.direction = ?${values.length}`)
    }
    if (cursor !== undefined) {
      values.push(cursor.createdAt)
      const createdAtParameter = values.length
      values.push(cursor.messageId)
      const messageIdParameter = values.length
      predicates.push(
        `(m.created_at < ?${createdAtParameter} OR ` +
          `(m.created_at = ?${createdAtParameter} AND ` +
          `m.id < ?${messageIdParameter}))`,
      )
    }
    values.push(limit + 1)

    const rows = yield* readAll(
      database,
      `SELECT ${MessageProjection}
       FROM ${MessagesTable} AS m
       WHERE ${predicates.join(" AND ")}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?${values.length}`,
      values,
      "list",
    )
    const pageRows = rows.slice(0, limit)
    const records = yield* Effect.forEach(
      pageRows,
      (row) =>
        // The page is bounded to 100 records; D1 read concurrency is bounded
        // below rather than creating one unbounded query fan-out.
        Effect.gen(function* () {
          const id = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ id: Schema.String }),
          )(row).pipe(
            Effect.map((decoded) => decoded.id),
            Effect.mapError(() => invalidStored("invalid_row")),
          )
          return yield* loadStoredFromRow(database, row, id, "list")
        }),
      { concurrency: 8 },
    )
    const lastRecord = records.at(-1)
    return {
      items: records,
      nextCursor: rows.length > limit && lastRecord !== undefined
        ? Option.some(encodeCursor(lastRecord.message))
        : Option.none(),
    }
  })

/**
 * Construct the D1 implementation of the package message-store port.
 *
 * Apply the bundled D1 migration before using this service. All reads are
 * scoped, persistence rows are parsed strictly, reservations batch message and
 * recipient creation atomically, and lifecycle writes use compare-and-set
 * guards.
 */
export const makeD1MessageStore = (database: D1Database) =>
  MessageStore.of({
    findOutboundByIdempotency: Effect.fn(
      "D1MessageStore.findOutboundByIdempotency",
    )((input) =>
      loadOutboundByIdempotency(
        database,
        input,
        "find_idempotency",
      )
    ),
    reserveOutbound: Effect.fn("D1MessageStore.reserveOutbound")(
      (input) => reserveOutbound(database, input),
    ),
    createOutboundArchiveIntent: Effect.fn(
      "D1MessageStore.createOutboundArchiveIntent",
    )((input) => createOutboundArchiveIntent(database, input)),
    attachOutboundRaw: Effect.fn("D1MessageStore.attachOutboundRaw")(
      (input) => attachOutboundRaw(database, input),
    ),
    claimOutbound: Effect.fn("D1MessageStore.claimOutbound")(
      (input) => claimOutbound(database, input),
    ),
    finalizeOutbound: Effect.fn("D1MessageStore.finalizeOutbound")(
      (input) => finalizeOutbound(database, input),
    ),
    get: Effect.fn("D1MessageStore.get")(
      (input) => loadById(database, input, "get"),
    ),
    list: Effect.fn("D1MessageStore.list")(
      (input) => listMessages(database, input),
    ),
  })
