import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

/**
 * Query-oriented table declarations only. The shipped D1 SQL migration is the
 * authoritative schema and deliberately carries stricter CHECK constraints and
 * partial indexes than consumers should regenerate from this module.
 */

/** Package-owned email domain records. */
export const emailDomains = sqliteTable(
  "popcomputer_email_domains",
  {
    id: text("id").primaryKey(),
    domain: text("domain").notNull(),
    kind: text("kind").$type<"platform">().notNull(),
    environment: text("environment").$type<"test" | "live">().notNull(),
    inboundStatus: text("inbound_status")
      .$type<"disabled" | "active" | "failed">()
      .notNull(),
    outboundStatus: text("outbound_status")
      .$type<"disabled" | "active" | "failed">()
      .notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("popcomputer_email_domains_identity").on(
      table.domain,
      table.environment,
    ),
    index("popcomputer_email_domains_inbound").on(
      table.environment,
      table.inboundStatus,
    ),
  ],
)

/** Cloudflare-specific identifiers for a package email domain. */
export const cloudflareDomainBindings = sqliteTable(
  "popcomputer_email_cf_domain_bindings",
  {
    domainId: text("domain_id")
      .primaryKey()
      .references(() => emailDomains.id, { onDelete: "cascade" }),
    zoneId: text("zone_id"),
    catchAllRuleId: text("catch_all_rule_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
)

/** Namespace-scoped inbound and outbound email routes. */
export const emailRoutes = sqliteTable(
  "popcomputer_email_routes",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull(),
    environment: text("environment").$type<"test" | "live">().notNull(),
    domainId: text("domain_id")
      .notNull()
      .references(() => emailDomains.id, { onDelete: "restrict" }),
    address: text("address").notNull(),
    localPart: text("local_part").notNull(),
    localPartNormalized: text("local_part_normalized").notNull(),
    mailboxHandle: text("mailbox_handle").notNull(),
    inboundKind: text("inbound_kind").$type<"store" | "trigger">().notNull(),
    workflowId: text("workflow_id"),
    outboundKind: text("outbound_kind")
      .$type<"disabled" | "sender">()
      .notNull(),
    senderRole: text("sender_role").$type<"default" | "alternate">(),
    metadataJson: text("metadata_json"),
    status: text("status").$type<"active" | "paused" | "disabled">().notNull(),
    creationIdempotencyKey: text("creation_idempotency_key"),
    creationFingerprint: text("creation_fingerprint"),
    rotationIdempotencyKey: text("rotation_idempotency_key"),
    rotationFingerprint: text("rotation_fingerprint"),
    rotationReplacementId: text("rotation_replacement_id"),
    actorKind: text("actor_kind")
      .$type<"user" | "credential" | "system">()
      .notNull(),
    actorId: text("actor_id").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    disabledAt: integer("disabled_at"),
  },
  (table) => [
    uniqueIndex("popcomputer_email_routes_domain_local_part").on(
      table.domainId,
      table.localPartNormalized,
    ),
    uniqueIndex("popcomputer_email_routes_address").on(table.address),
    uniqueIndex("popcomputer_email_routes_default_from")
      .on(table.namespace, table.environment)
      .where(sql`
        ${table.outboundKind} = 'sender'
        AND ${table.senderRole} = 'default'
        AND ${table.status} != 'disabled'
      `),
    uniqueIndex("popcomputer_email_routes_creation_idempotency")
      .on(
        table.namespace,
        table.environment,
        table.creationIdempotencyKey,
      )
      .where(sql`${table.creationIdempotencyKey} IS NOT NULL`),
    index("popcomputer_email_routes_scope_inbound_status").on(
      table.namespace,
      table.environment,
      table.inboundKind,
      table.status,
      table.createdAt,
      table.id,
    ),
    check(
      "popcomputer_email_routes_inbound_capability",
      sql`
        (
          ${table.inboundKind} = 'store'
          AND ${table.workflowId} IS NULL
        )
        OR
        (
          ${table.inboundKind} = 'trigger'
          AND ${table.workflowId} IS NOT NULL
        )
      `,
    ),
    check(
      "popcomputer_email_routes_outbound_capability",
      sql`
        (
          ${table.outboundKind} = 'disabled'
          AND ${table.senderRole} IS NULL
        )
        OR
        (
          ${table.outboundKind} = 'sender'
          AND ${table.senderRole} IS NOT NULL
        )
      `,
    ),
    check(
      "popcomputer_email_routes_revision",
      sql`${table.revision} > 0`,
    ),
    check(
      "popcomputer_email_routes_rotation_winner",
      sql`
        (
          ${table.rotationIdempotencyKey} IS NULL
          AND ${table.rotationFingerprint} IS NULL
          AND ${table.rotationReplacementId} IS NULL
        )
        OR
        (
          ${table.status} = 'disabled'
          AND ${table.rotationIdempotencyKey} IS NOT NULL
          AND ${table.rotationFingerprint} IS NOT NULL
          AND ${table.rotationReplacementId} IS NOT NULL
        )
      `,
    ),
  ],
)

/** Durable email-message metadata; raw MIME is stored behind an archive port. */
export const emailMessages = sqliteTable(
  "popcomputer_email_messages",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull(),
    environment: text("environment").$type<"test" | "live">().notNull(),
    routeId: text("route_id").references(() => emailRoutes.id, {
      onDelete: "set null",
    }),
    workflowId: text("workflow_id"),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    status: text("status")
      .$type<
        | "received"
        | "workflow_event_created"
        | "reserved"
        | "sending"
        | "captured"
        | "accepted"
        | "partially_accepted"
        | "delivery_unknown"
        | "failed"
      >()
      .notNull(),
    stateReason: text("state_reason"),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject"),
    rfcMessageId: text("rfc_message_id"),
    rawSha256: text("raw_sha256"),
    rawRef: text("raw_ref"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    idempotencyKey: text("idempotency_key"),
    requestFingerprint: text("request_fingerprint"),
    providerMessageId: text("provider_message_id"),
    actorKind: text("actor_kind").$type<"user" | "credential" | "system">(),
    actorId: text("actor_id"),
    claimedAt: integer("claimed_at"),
    sentAt: integer("sent_at"),
    receivedAt: integer("received_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("popcomputer_email_messages_outbound_idempotency")
      .on(
        table.namespace,
        table.environment,
        table.idempotencyKey,
      )
      .where(sql`
        ${table.direction} = 'outbound'
        AND ${table.idempotencyKey} IS NOT NULL
      `),
    index("popcomputer_email_messages_scope_created").on(
      table.namespace,
      table.environment,
      table.direction,
      table.createdAt,
      table.id,
    ),
    index("popcomputer_email_messages_stale_sending").on(
      table.status,
      table.claimedAt,
    ),
    check(
      "popcomputer_email_messages_size_non_negative",
      sql`${table.sizeBytes} >= 0`,
    ),
  ],
)

/** Current atomic replay receipt for each provider or fallback delivery key. */
export const inboundDedupeReceipts = sqliteTable(
  "popcomputer_email_inbound_dedupe_receipts",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull(),
    environment: text("environment").$type<"test" | "live">().notNull(),
    routeId: text("route_id")
      .notNull()
      .references(() => emailRoutes.id, { onDelete: "cascade" }),
    identityKind: text("identity_kind")
      .$type<"provider" | "digest">()
      .notNull(),
    provider: text("provider"),
    deliveryId: text("delivery_id"),
    envelopeFrom: text("envelope_from"),
    rawSha256: text("raw_sha256"),
    windowStartedAt: integer("window_started_at").notNull(),
    expiresAt: integer("expires_at"),
  },
  (table) => [
    uniqueIndex("popcomputer_email_inbound_dedupe_message")
      .on(table.messageId),
    uniqueIndex("popcomputer_email_inbound_dedupe_provider")
      .on(
        table.namespace,
        table.environment,
        table.routeId,
        table.provider,
        table.deliveryId,
      )
      .where(sql`${table.identityKind} = 'provider'`),
    uniqueIndex("popcomputer_email_inbound_dedupe_digest")
      .on(
        table.namespace,
        table.environment,
        table.routeId,
        table.envelopeFrom,
        table.rawSha256,
      )
      .where(sql`${table.identityKind} = 'digest'`),
    check(
      "popcomputer_email_inbound_dedupe_shape",
      sql`
        (
          ${table.identityKind} = 'provider'
          AND ${table.provider} IS NOT NULL
          AND ${table.deliveryId} IS NOT NULL
          AND ${table.envelopeFrom} IS NULL
          AND ${table.rawSha256} IS NULL
          AND ${table.expiresAt} IS NULL
        )
        OR
        (
          ${table.identityKind} = 'digest'
          AND ${table.provider} IS NULL
          AND ${table.deliveryId} IS NULL
          AND ${table.envelopeFrom} IS NOT NULL
          AND ${table.rawSha256} IS NOT NULL
          AND ${table.expiresAt} > ${table.windowStartedAt}
        )
      `,
    ),
  ],
)

/** Per-recipient delivery outcomes for an email message. */
export const emailRecipients = sqliteTable(
  "popcomputer_email_recipients",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"to" | "cc" | "bcc">().notNull(),
    position: integer("position").notNull(),
    address: text("address").notNull(),
    status: text("status")
      .$type<
        | "pending"
        | "captured"
        | "queued"
        | "delivered"
        | "permanent_bounce"
        | "failed"
      >()
      .notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("popcomputer_email_recipients_message_kind").on(
      table.messageId,
      table.kind,
      table.position,
    ),
    uniqueIndex("popcomputer_email_recipients_position").on(
      table.messageId,
      table.kind,
      table.position,
    ),
    check(
      "popcomputer_email_recipients_position_non_negative",
      sql`${table.position} >= 0`,
    ),
  ],
)

/** Recovery record for an inbound archive written before the D1 commit. */
export const inboundArchiveIntents = sqliteTable(
  "popcomputer_email_inbound_archive_intents",
  {
    messageId: text("message_id").primaryKey(),
    namespace: text("namespace").notNull(),
    environment: text("environment").$type<"test" | "live">().notNull(),
    rawSha256: text("raw_sha256").notNull(),
    rawRef: text("raw_ref"),
    status: text("status")
      .$type<"pending" | "leased" | "failed" | "dead">()
      .notNull()
      .default("pending"),
    expiresAt: integer("expires_at").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at"),
    safeErrorCode: text("safe_error_code"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("popcomputer_email_inbound_archive_intents_due").on(
      table.nextAttemptAt,
      table.expiresAt,
    ),
  ],
)

/** Recovery record for an outbound archive written before its D1 attachment. */
export const outboundArchiveIntents = sqliteTable(
  "popcomputer_email_outbound_archive_intents",
  {
    messageId: text("message_id").primaryKey(),
    namespace: text("namespace").notNull(),
    environment: text("environment").$type<"test" | "live">().notNull(),
    rawSha256: text("raw_sha256").notNull(),
    rawRef: text("raw_ref").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    status: text("status")
      .$type<"pending" | "leased" | "failed" | "dead">()
      .notNull()
      .default("pending"),
    expiresAt: integer("expires_at").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at"),
    safeErrorCode: text("safe_error_code"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("popcomputer_email_outbound_archive_intents_due").on(
      table.nextAttemptAt,
      table.expiresAt,
    ),
    check(
      "popcomputer_email_outbound_archive_intents_size_non_negative",
      sql`${table.sizeBytes} >= 0`,
    ),
    check(
      "popcomputer_email_outbound_archive_intents_lease",
      sql`
        (
          ${table.status} = 'leased'
          AND ${table.leaseToken} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NOT NULL
        )
        OR
        (
          ${table.status} != 'leased'
          AND ${table.leaseToken} IS NULL
          AND ${table.leaseExpiresAt} IS NULL
        )
      `,
    ),
  ],
)

/** Cloudflare-account-global verified destination records. */
export const cloudflareDestinations = sqliteTable(
  "popcomputer_email_cf_destinations",
  {
    id: text("id").primaryKey(),
    providerAccountKey: text("provider_account_key").notNull(),
    address: text("address").notNull(),
    providerDestinationId: text("provider_destination_id"),
    status: text("status").$type<"pending" | "verified" | "failed">().notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("popcomputer_email_cf_destinations_identity").on(
      table.providerAccountKey,
      table.address,
    ),
  ],
)

/** Namespace-local permission to send test mail to a verified destination. */
export const testRecipientGrants = sqliteTable(
  "popcomputer_email_test_recipient_grants",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull(),
    environment: text("environment").$type<"test">().notNull(),
    destinationId: text("destination_id")
      .notNull()
      .references(() => cloudflareDestinations.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    lastRefreshIdempotencyKey: text("last_refresh_idempotency_key"),
    lastRefreshFingerprint: text("last_refresh_fingerprint"),
    state: text("state")
      .$type<"pending" | "verified" | "failed">()
      .notNull(),
    stateAt: integer("state_at").notNull(),
    failureReason: text("failure_reason").$type<
      | "provider_rejected"
      | "verification_expired"
      | "destination_unavailable"
    >(),
    actorKind: text("actor_kind")
      .$type<"user" | "credential" | "system">()
      .notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("popcomputer_email_test_recipient_grants_destination").on(
      table.namespace,
      table.environment,
      table.destinationId,
    ),
    uniqueIndex("popcomputer_email_test_recipient_grants_idempotency").on(
      table.namespace,
      table.environment,
      table.idempotencyKey,
    ),
    uniqueIndex("popcomputer_email_test_recipient_grants_refresh_idempotency")
      .on(
        table.namespace,
        table.environment,
        table.lastRefreshIdempotencyKey,
      ),
  ],
)

/** Lease-backed idempotency ledger for every test-recipient add outcome. */
export const testRecipientAdds = sqliteTable(
  "popcomputer_email_test_recipient_adds",
  {
    namespace: text("namespace").notNull(),
    environment: text("environment").$type<"test">().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    address: text("address").notNull(),
    status: text("status").$type<"pending" | "completed">().notNull(),
    testRecipientId: text("test_recipient_id")
      .references(() => testRecipientGrants.id, { onDelete: "cascade" }),
    state: text("state").$type<"pending" | "verified" | "failed">(),
    stateAt: integer("state_at"),
    failureReason: text("failure_reason").$type<
      | "provider_rejected"
      | "verification_expired"
      | "destination_unavailable"
    >(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.namespace,
        table.environment,
        table.idempotencyKey,
      ],
    }),
    index("popcomputer_email_test_recipient_adds_recipient").on(
      table.namespace,
      table.environment,
      table.testRecipientId,
      table.createdAt,
    ),
  ],
)

/** Immutable idempotency ledger for every test-recipient refresh outcome. */
export const testRecipientRefreshes = sqliteTable(
  "popcomputer_email_test_recipient_refreshes",
  {
    namespace: text("namespace").notNull(),
    environment: text("environment").$type<"test">().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    testRecipientId: text("test_recipient_id")
      .notNull()
      .references(() => testRecipientGrants.id, { onDelete: "cascade" }),
    requestFingerprint: text("request_fingerprint").notNull(),
    state: text("state")
      .$type<"pending" | "verified" | "failed">()
      .notNull(),
    stateAt: integer("state_at").notNull(),
    failureReason: text("failure_reason").$type<
      | "provider_rejected"
      | "verification_expired"
      | "destination_unavailable"
    >(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.namespace,
        table.environment,
        table.idempotencyKey,
      ],
    }),
    index("popcomputer_email_test_recipient_refreshes_recipient").on(
      table.namespace,
      table.environment,
      table.testRecipientId,
      table.createdAt,
    ),
  ],
)

/** Durable outbox events for inbound workflow-trigger routes. */
export const workflowEvents = sqliteTable(
  "popcomputer_email_workflow_events",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    routeId: text("route_id")
      .notNull()
      .references(() => emailRoutes.id, { onDelete: "restrict" }),
    namespace: text("namespace").notNull(),
    environment: text("environment").$type<"test" | "live">().notNull(),
    workflowId: text("workflow_id").notNull(),
    eventJson: text("event_json").notNull(),
    status: text("status")
      .$type<"pending" | "leased" | "started" | "failed" | "dead">()
      .notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at"),
    safeErrorCode: text("safe_error_code"),
    externalRunId: text("external_run_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("popcomputer_email_workflow_events_message_route").on(
      table.messageId,
      table.routeId,
    ),
    index("popcomputer_email_workflow_events_due").on(
      table.status,
      table.nextAttemptAt,
      table.leaseExpiresAt,
      table.createdAt,
    ),
  ],
)

/** Durable work queue for removing raw archives after scope deletion. */
export const archiveDeletions = sqliteTable(
  "popcomputer_email_archive_deletions",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull(),
    environment: text("environment").$type<"test" | "live">().notNull(),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    messageId: text("message_id").notNull(),
    rawRef: text("raw_ref"),
    status: text("status").$type<"pending" | "leased" | "failed" | "dead">().notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at"),
    safeErrorCode: text("safe_error_code"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("popcomputer_email_archive_deletions_identity").on(
      table.namespace,
      table.environment,
      table.direction,
      table.messageId,
    ),
    index("popcomputer_email_archive_deletions_due").on(
      table.status,
      table.nextAttemptAt,
      table.leaseExpiresAt,
      table.createdAt,
    ),
  ],
)
