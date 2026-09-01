import { DateTime, Effect, Option } from "effect"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import type { ReserveOutboundInput } from "../../src/adapters/message-store.js"
import { ActorIdSchema, IdempotencyKeySchema, LeaseTokenSchema, MessageIdSchema, NamespaceSchema, PageCursorSchema, RawMessageRefSchema, RecipientIdSchema, RequestFingerprintSchema, RouteIdSchema, Sha256Schema } from "../../src/core/identifiers.js"
import { ActorSchema, type Actor } from "../../src/core/actor.js"
import { EmailAddressSchema, type EmailAddress } from "../../src/core/address.js"
import { OutboundStateSchema, type ReservedOutboundMessage } from "../../src/core/message.js"
import { ScopeSchema, type Scope } from "../../src/core/scope.js"
import type {
  D1Database as EmailD1Database,
  D1ExecutionResult as EmailD1ExecutionResult,
  D1PreparedStatement as EmailD1PreparedStatement,
} from "../../src/storage/d1/contract.js"
import { makeD1MessageStore } from "../../src/storage/d1/message-store.js"
import { makeD1MaintenanceStore } from "../../src/storage/d1/maintenance-store.js"

interface RouteFixture {
  readonly suffix: string
  readonly scope: Scope
  readonly actor: Actor
  readonly routeId: typeof RouteIdSchema.Type
  readonly address: EmailAddress
  readonly epochMillis: number
}

let fixtureSequence = 0

const nextSuffix = (): string => `store-${fixtureSequence++}`

const projectD1Result = <Row>(
  result: D1Result<Row>,
): EmailD1ExecutionResult<Row> => ({
  success: result.success,
  results: result.results,
  meta: {
    changes: result.meta.changes,
    rows_read: result.meta.rows_read,
    rows_written: result.meta.rows_written,
    duration: result.meta.duration,
  },
})

/**
 * Adapt the real Workers binding to the package's deliberately ambient-free D1
 * contract. The WeakMap preserves the native statements needed by `batch`
 * without weakening either side of the boundary with a type assertion.
 */
interface D1AdapterFaults {
  readonly attachBatch?: "before_commit" | "after_commit"
}

const adaptD1Database = (
  database: D1Database,
  faults: D1AdapterFaults = {},
): EmailD1Database => {
  const nativeStatements = new WeakMap<
    EmailD1PreparedStatement,
    D1PreparedStatement
  >()
  const statementQueries = new WeakMap<EmailD1PreparedStatement, string>()
  let attachFaultInjected = false

  const wrapStatement = (
    native: D1PreparedStatement,
    query: string,
  ): EmailD1PreparedStatement => {
    const wrapped: EmailD1PreparedStatement = {
      bind: (...values) => wrapStatement(native.bind(...values), query),
      first: <Row = unknown>() => native.first<Row>(),
      all: async <Row = unknown>() =>
        projectD1Result(await native.all<Row>()),
      run: async <Row = unknown>() =>
        projectD1Result(await native.run<Row>()),
    }
    nativeStatements.set(wrapped, native)
    statementQueries.set(wrapped, query)
    return wrapped
  }

  return {
    prepare: (query) => wrapStatement(database.prepare(query), query),
    batch: async <Row = unknown>(statements: Array<EmailD1PreparedStatement>) => {
      const nativeBatch: Array<D1PreparedStatement> = []
      let isAttachBatch = false
      for (const statement of statements) {
        const native = nativeStatements.get(statement)
        if (native === undefined) {
          throw new Error("D1 batch received a statement from another database")
        }
        nativeBatch.push(native)
        isAttachBatch ||= statementQueries.get(statement)?.includes(
          "SET raw_ref = ?1",
        ) === true
      }
      const injectFault = isAttachBatch && !attachFaultInjected &&
        faults.attachBatch !== undefined
      if (injectFault && faults.attachBatch === "before_commit") {
        attachFaultInjected = true
        throw new Error("Injected attach batch failure before commit")
      }
      const results = await database.batch<Row>(nativeBatch)
      if (injectFault && faults.attachBatch === "after_commit") {
        attachFaultInjected = true
        throw new Error("Injected attach batch failure after commit")
      }
      return results.map(projectD1Result)
    },
  }
}

const makeStore = () => makeD1MessageStore(adaptD1Database(env.EMAIL_DB))

const insertRouteFixture = async (): Promise<RouteFixture> => {
  const suffix = nextSuffix()
  const namespace = NamespaceSchema.make(`namespace-${suffix}`)
  const scope = ScopeSchema.make({ namespace, environment: "test" })
  const actor = ActorSchema.cases.System.make({
    id: ActorIdSchema.make(`actor-${suffix}`),
  })
  const routeId = RouteIdSchema.make(`route-${suffix}`)
  const domainId = `domain-${suffix}`
  const domain = `${suffix}.example.com`
  const address = EmailAddressSchema.make(`sender@${domain}`)
  const epochMillis = 1_800_000_000_000 + fixtureSequence * 10_000

  await env.EMAIL_DB.batch([
    env.EMAIL_DB.prepare(
      `INSERT INTO popcomputer_email_domains (
        id, domain, kind, environment, inbound_status, outbound_status,
        created_at, updated_at
      ) VALUES (?, ?, 'platform', 'test', 'active', 'active', ?, ?)`,
    ).bind(domainId, domain, epochMillis, epochMillis),
    env.EMAIL_DB.prepare(
      `INSERT INTO popcomputer_email_routes (
        id, namespace, environment, domain_id, address, local_part,
        local_part_normalized, mailbox_handle, inbound_kind, workflow_id,
        outbound_kind, sender_role, metadata_json, status,
        creation_idempotency_key, creation_fingerprint, actor_kind, actor_id,
        revision, created_at, updated_at, disabled_at
      ) VALUES (
        ?, ?, 'test', ?, ?, 'sender', 'sender', 'sender', 'store', NULL,
        'sender', 'default', NULL, 'active', NULL, NULL,
        'system', ?, 1, ?, ?, NULL
      )`,
    ).bind(
      routeId,
      scope.namespace,
      domainId,
      address,
      actor.id,
      epochMillis,
      epochMillis,
    ),
  ])

  return { suffix, scope, actor, routeId, address, epochMillis }
}

const reservation = (
  fixture: RouteFixture,
  discriminator: string,
  options?: {
    readonly idempotencyKey?: string
    readonly fingerprintCharacter?: string
    readonly createdAtOffset?: number
  },
): ReserveOutboundInput => {
  const messageId = MessageIdSchema.make(
    `message-${fixture.suffix}-${discriminator}`,
  )
  const to = EmailAddressSchema.make("recipient@example.com")
  const cc = EmailAddressSchema.make("copy@example.com")
  const createdAt = DateTime.makeUnsafe(
    fixture.epochMillis + (options?.createdAtOffset ?? 0),
  )

  const message: ReservedOutboundMessage = {
    id: messageId,
    _tag: "Outbound",
    scope: fixture.scope,
    actor: fixture.actor,
    idempotencyKey: IdempotencyKeySchema.make(
      options?.idempotencyKey ??
        `send-${fixture.suffix}-${discriminator}`,
    ),
    requestFingerprint: RequestFingerprintSchema.make(
      (options?.fingerprintCharacter ?? "a").repeat(64),
    ),
    routeId: fixture.routeId,
    from: fixture.address,
    to: [to],
    cc: [cc],
    bcc: [],
    subject: `Subject ${discriminator}`,
    sizeBytes: 512,
    createdAt,
    updatedAt: createdAt,
    state: OutboundStateSchema.cases.Reserved.make({}),
  }

  return {
    message,
    recipients: [
      {
        id: RecipientIdSchema.make(
          `recipient-${fixture.suffix}-${discriminator}-to`,
        ),
        kind: "to",
        address: to,
      },
      {
        id: RecipientIdSchema.make(
          `recipient-${fixture.suffix}-${discriminator}-cc`,
        ),
        kind: "cc",
        address: cc,
      },
    ],
  }
}

const attachRaw = (
  fixture: RouteFixture,
  messageId: typeof MessageIdSchema.Type,
  discriminator: string,
) => ({
  scope: fixture.scope,
  messageId,
  raw: {
    ref: RawMessageRefSchema.make(
      `raw:${fixture.suffix}:${discriminator}`,
    ),
    sha256: Sha256Schema.make("c".repeat(64)),
    sizeBytes: 512,
  },
})

const archiveIntent = (
  fixture: RouteFixture,
  raw: ReturnType<typeof attachRaw>,
) => ({
  ...raw,
  expiresAt: DateTime.makeUnsafe(fixture.epochMillis + 86_400_000),
  now: DateTime.makeUnsafe(fixture.epochMillis),
})

describe("D1 message store", () => {
  it("atomically reserves and replays one scoped idempotency identity", async () => {
    const fixture = await insertRouteFixture()
    const store = makeStore()
    const first = reservation(fixture, "first", {
      idempotencyKey: `shared-${fixture.suffix}`,
      fingerprintCharacter: "a",
    })
    const conflictingReplay = reservation(fixture, "second", {
      idempotencyKey: `shared-${fixture.suffix}`,
      fingerprintCharacter: "b",
    })

    const created = await Effect.runPromise(store.reserveOutbound(first))
    expect(created._tag).toBe("Created")
    expect(created.record.message.id).toBe(first.message.id)
    expect(created.record.recipients.map((recipient) => recipient.kind))
      .toEqual(["to", "cc"])

    const replayed = await Effect.runPromise(
      store.reserveOutbound(conflictingReplay),
    )
    expect(replayed._tag).toBe("Existing")
    expect(replayed.record.message.id).toBe(first.message.id)
    expect(replayed.record.message.requestFingerprint).toBe(
      first.message.requestFingerprint,
    )
    expect(replayed.record.message.requestFingerprint).not.toBe(
      conflictingReplay.message.requestFingerprint,
    )

    const row = await env.EMAIL_DB.prepare(
      `SELECT COUNT(*) AS item_count
       FROM popcomputer_email_messages
       WHERE namespace = ? AND environment = 'test'`,
    ).bind(fixture.scope.namespace).first<{ item_count: number }>()
    expect(row?.item_count).toBe(1)
  })

  it("allows only one concurrent reservation creator", async () => {
    const fixture = await insertRouteFixture()
    const store = makeStore()
    const key = `concurrent-${fixture.suffix}`
    const left = reservation(fixture, "left", {
      idempotencyKey: key,
      fingerprintCharacter: "d",
    })
    const right = reservation(fixture, "right", {
      idempotencyKey: key,
      fingerprintCharacter: "d",
    })

    const results = await Promise.all([
      Effect.runPromise(store.reserveOutbound(left)),
      Effect.runPromise(store.reserveOutbound(right)),
    ])

    expect(results.map((result) => result._tag).sort()).toEqual([
      "Created",
      "Existing",
    ])
    expect(results[0]?.record.message.id).toBe(results[1]?.record.message.id)
  })

  it("attaches raw metadata idempotently and grants one send claim", async () => {
    const fixture = await insertRouteFixture()
    const store = makeStore()
    const input = reservation(fixture, "claim")
    await Effect.runPromise(store.reserveOutbound(input))

    const beforeRaw = await Effect.runPromise(store.claimOutbound({
      scope: fixture.scope,
      messageId: input.message.id,
      claimedAt: DateTime.makeUnsafe(fixture.epochMillis + 100),
    }))
    expect(beforeRaw._tag).toBe("NotClaimed")

    const raw = attachRaw(fixture, input.message.id, "claim")
    await Effect.runPromise(
      store.createOutboundArchiveIntent(archiveIntent(fixture, raw)),
    )
    const attached = await Effect.runPromise(store.attachOutboundRaw(raw))
    expect(Option.isSome(attached.raw)).toBe(true)

    const claims = await Promise.all([
      Effect.runPromise(store.claimOutbound({
        scope: fixture.scope,
        messageId: input.message.id,
        claimedAt: DateTime.makeUnsafe(fixture.epochMillis + 200),
      })),
      Effect.runPromise(store.claimOutbound({
        scope: fixture.scope,
        messageId: input.message.id,
        claimedAt: DateTime.makeUnsafe(fixture.epochMillis + 201),
      })),
    ])
    expect(claims.map((claim) => claim._tag).sort()).toEqual([
      "Claimed",
      "NotClaimed",
    ])

    const replayedAttachment = await Effect.runPromise(
      store.attachOutboundRaw(raw),
    )
    expect(replayedAttachment.message.state._tag).toBe("Sending")

    const conflictingRaw = {
      ...raw,
      raw: {
        ...raw.raw,
        sha256: Sha256Schema.make("e".repeat(64)),
      },
    }
    const conflict = await Effect.runPromise(
      Effect.flip(store.attachOutboundRaw(conflictingRaw)),
    )
    expect(conflict._tag).toBe("MessageTransitionConflict")
  })

  it("retains an outbound intent when attachment fails before commit", async () => {
    const fixture = await insertRouteFixture()
    const store = makeStore()
    const input = reservation(fixture, "attach-before-commit", {
      idempotencyKey: `attach-replay-${fixture.suffix}`,
    })
    const raw = attachRaw(fixture, input.message.id, "attach-before-commit")
    await Effect.runPromise(store.reserveOutbound(input))
    await Effect.runPromise(
      store.createOutboundArchiveIntent(archiveIntent(fixture, raw)),
    )

    const faultedStore = makeD1MessageStore(adaptD1Database(env.EMAIL_DB, {
      attachBatch: "before_commit",
    }))
    const failure = await Effect.runPromise(
      Effect.flip(faultedStore.attachOutboundRaw(raw)),
    )
    expect(failure).toMatchObject({
      _tag: "MessageStoreFailure",
      operation: "attach_raw",
    })

    const retained = await env.EMAIL_DB.prepare(
      `SELECT m.raw_ref,
              (SELECT COUNT(*)
               FROM popcomputer_email_outbound_archive_intents AS i
               WHERE i.message_id = m.id) AS intent_count
       FROM popcomputer_email_messages AS m
       WHERE m.id = ?`,
    ).bind(input.message.id).first<{
      raw_ref: string | null
      intent_count: number
    }>()
    expect(retained).toEqual({ raw_ref: null, intent_count: 1 })

    const replayedReservation = await Effect.runPromise(
      store.reserveOutbound(input),
    )
    expect(replayedReservation._tag).toBe("Existing")
    expect(replayedReservation.record.message.id).toBe(input.message.id)
    await Effect.runPromise(
      store.createOutboundArchiveIntent(archiveIntent(fixture, raw)),
    )
    const attached = await Effect.runPromise(store.attachOutboundRaw(raw))
    expect(Option.isSome(attached.raw)).toBe(true)

    const repaired = await env.EMAIL_DB.prepare(
      `SELECT m.raw_ref,
              (SELECT COUNT(*)
               FROM popcomputer_email_outbound_archive_intents AS i
               WHERE i.message_id = m.id) AS intent_count
       FROM popcomputer_email_messages AS m
       WHERE m.id = ?`,
    ).bind(input.message.id).first<{
      raw_ref: string | null
      intent_count: number
    }>()
    expect(repaired).toEqual({ raw_ref: raw.raw.ref, intent_count: 0 })
  })

  it("reconciles an attachment whose commit response is ambiguous", async () => {
    const fixture = await insertRouteFixture()
    const store = makeStore()
    const input = reservation(fixture, "attach-after-commit")
    const raw = attachRaw(fixture, input.message.id, "attach-after-commit")
    await Effect.runPromise(store.reserveOutbound(input))
    await Effect.runPromise(
      store.createOutboundArchiveIntent(archiveIntent(fixture, raw)),
    )

    const faultedStore = makeD1MessageStore(adaptD1Database(env.EMAIL_DB, {
      attachBatch: "after_commit",
    }))
    const attached = await Effect.runPromise(faultedStore.attachOutboundRaw(raw))
    expect(Option.isSome(attached.raw)).toBe(true)

    const persisted = await env.EMAIL_DB.prepare(
      `SELECT m.raw_ref,
              (SELECT COUNT(*)
               FROM popcomputer_email_outbound_archive_intents AS i
               WHERE i.message_id = m.id) AS intent_count
       FROM popcomputer_email_messages AS m
       WHERE m.id = ?`,
    ).bind(input.message.id).first<{
      raw_ref: string | null
      intent_count: number
    }>()
    expect(persisted).toEqual({ raw_ref: raw.raw.ref, intent_count: 0 })
  })

  it("does not archive through an intent leased for cleanup", async () => {
    const fixture = await insertRouteFixture()
    const database = adaptD1Database(env.EMAIL_DB)
    const store = makeD1MessageStore(database)
    const maintenance = makeD1MaintenanceStore(database)
    const input = reservation(fixture, "attach-leased")
    const raw = attachRaw(fixture, input.message.id, "attach-leased")
    await Effect.runPromise(store.reserveOutbound(input))
    await Effect.runPromise(store.createOutboundArchiveIntent({
      ...raw,
      now: DateTime.makeUnsafe(0),
      expiresAt: DateTime.makeUnsafe(1),
    }))

    const now = DateTime.makeUnsafe(Date.now())
    const ready = await Effect.runPromise(
      maintenance.listArchiveCleanup({ now, limit: 100 }),
    )
    const item = ready.find((candidate) =>
      candidate._tag === "OutboundIntent" &&
      candidate.messageId === input.message.id
    )
    if (item === undefined) throw new Error("Expected a due outbound intent")
    const leased = await Effect.runPromise(maintenance.claimArchiveCleanup({
      item,
      leaseToken: LeaseTokenSchema.make(`lease-${fixture.suffix}`),
      leaseExpiresAt: DateTime.makeUnsafe(Date.now() + 60_000),
    }))
    expect(Option.isSome(leased)).toBe(true)

    const renewFailure = await Effect.runPromise(Effect.flip(
      store.createOutboundArchiveIntent({
        ...archiveIntent(fixture, raw),
        now,
      }),
    ))
    const attachFailure = await Effect.runPromise(
      Effect.flip(store.attachOutboundRaw(raw)),
    )
    expect(renewFailure._tag).toBe("MessageTransitionConflict")
    expect(attachFailure._tag).toBe("MessageTransitionConflict")

    const persisted = await env.EMAIL_DB.prepare(
      `SELECT m.raw_ref, i.status
       FROM popcomputer_email_messages AS m
       INNER JOIN popcomputer_email_outbound_archive_intents AS i
         ON i.message_id = m.id
       WHERE m.id = ?`,
    ).bind(input.message.id).first<{
      raw_ref: string | null
      status: string
    }>()
    expect(persisted).toEqual({ raw_ref: null, status: "leased" })
  })

  it("atomically finalizes the message and recipient outcomes", async () => {
    const fixture = await insertRouteFixture()
    const store = makeStore()
    const input = reservation(fixture, "finalize")
    await Effect.runPromise(store.reserveOutbound(input))
    const raw = attachRaw(fixture, input.message.id, "finalize")
    await Effect.runPromise(
      store.createOutboundArchiveIntent(archiveIntent(fixture, raw)),
    )
    await Effect.runPromise(
      store.attachOutboundRaw(raw),
    )
    await Effect.runPromise(store.claimOutbound({
      scope: fixture.scope,
      messageId: input.message.id,
      claimedAt: DateTime.makeUnsafe(fixture.epochMillis + 100),
    }))

    const sentAt = DateTime.makeUnsafe(fixture.epochMillis + 200)
    const finalization = {
      _tag: "Accepted" as const,
      sentAt,
      outcomes: input.recipients.map((recipient) => ({
        _tag: "Accepted" as const,
        address: recipient.address,
      })),
    }
    const finalized = await Effect.runPromise(store.finalizeOutbound({
      scope: fixture.scope,
      messageId: input.message.id,
      finalization,
    }))
    expect(finalized.message.state._tag).toBe("Accepted")
    expect(finalized.recipients.map((recipient) => recipient.status))
      .toEqual(["queued", "queued"])

    const replayed = await Effect.runPromise(store.finalizeOutbound({
      scope: fixture.scope,
      messageId: input.message.id,
      finalization,
    }))
    expect(replayed.message.state._tag).toBe("Accepted")

    const conflict = await Effect.runPromise(Effect.flip(
      store.finalizeOutbound({
        scope: fixture.scope,
        messageId: input.message.id,
        finalization: {
          _tag: "DeliveryUnknown",
          occurredAt: DateTime.makeUnsafe(fixture.epochMillis + 300),
          reason: "timeout",
        },
      }),
    ))
    expect(conflict._tag).toBe("MessageTransitionConflict")
  })

  it("isolates scoped reads and emits stable cursor pages", async () => {
    const fixture = await insertRouteFixture()
    const otherFixture = await insertRouteFixture()
    const store = makeStore()
    const older = reservation(fixture, "older", { createdAtOffset: 100 })
    const newer = reservation(fixture, "newer", { createdAtOffset: 200 })
    await Effect.runPromise(store.reserveOutbound(older))
    await Effect.runPromise(store.reserveOutbound(newer))

    const wrongScope = await Effect.runPromise(store.get({
      scope: otherFixture.scope,
      messageId: newer.message.id,
    }))
    expect(Option.isNone(wrongScope)).toBe(true)

    const firstPage = await Effect.runPromise(store.list({
      scope: fixture.scope,
      direction: "outbound",
      limit: 1,
    }))
    expect(firstPage.items.map((record) => record.message.id)).toEqual([
      newer.message.id,
    ])
    expect(firstPage.items[0]?.recipients).toHaveLength(2)
    expect(Option.isSome(firstPage.nextCursor)).toBe(true)

    if (Option.isNone(firstPage.nextCursor)) {
      throw new Error("Expected a cursor for the second message page")
    }
    const secondPage = await Effect.runPromise(store.list({
      scope: fixture.scope,
      direction: "outbound",
      limit: 1,
      cursor: firstPage.nextCursor.value,
    }))
    expect(secondPage.items.map((record) => record.message.id)).toEqual([
      older.message.id,
    ])
    expect(Option.isNone(secondPage.nextCursor)).toBe(true)

    const maximumPage = await Effect.runPromise(store.list({
      scope: fixture.scope,
      limit: 100,
    }))
    expect(maximumPage.items).toHaveLength(2)

    const invalidCursor = await Effect.runPromise(Effect.flip(store.list({
      scope: fixture.scope,
      cursor: PageCursorSchema.make("not_json"),
    })))
    expect(invalidCursor).toMatchObject({
      _tag: "InvalidPageRequest",
      reason: "invalid_cursor",
    })
  })

  it("fails closed when a persisted lifecycle row is contradictory", async () => {
    const fixture = await insertRouteFixture()
    const store = makeStore()
    const input = reservation(fixture, "invalid-row")
    await Effect.runPromise(store.reserveOutbound(input))

    await env.EMAIL_DB.prepare(
      `UPDATE popcomputer_email_messages
       SET subject = NULL
       WHERE id = ?`,
    ).bind(input.message.id).run()

    const error = await Effect.runPromise(Effect.flip(store.get({
      scope: fixture.scope,
      messageId: input.message.id,
    })))
    expect(error._tag).toBe("InvalidStoredMessage")
  })
})
