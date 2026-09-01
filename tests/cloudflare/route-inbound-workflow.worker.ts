import { env } from "cloudflare:workers"
import { DateTime, Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { CommitInboundInput } from "../../src/adapters/inbound-store.js"
import { makeR2RawMessageArchive } from "../../src/adapters/cloudflare/r2-raw-message-archive.js"
import type { ReserveRouteInput } from "../../src/adapters/route-admin-store.js"
import { ActorSchema } from "../../src/core/actor.js"
import {
  EmailAddressSchema,
  MailboxHandleSchema,
} from "../../src/core/address.js"
import { InboundProviderDeliverySchema } from "../../src/core/inbound-delivery.js"
import {
  ActorIdSchema,
  IdempotencyKeySchema,
  LeaseTokenSchema,
  MessageIdSchema,
  NamespaceSchema,
  RawMessageRefSchema,
  RecipientIdSchema,
  RequestFingerprintSchema,
  RouteIdSchema,
  Sha256Schema,
  WorkflowEventIdSchema,
  WorkflowIdSchema,
  WorkflowRunIdSchema,
} from "../../src/core/identifiers.js"
import {
  MessageRecipientSchema,
  MessageSchema,
} from "../../src/core/message.js"
import { RawMimeDescriptorSchema } from "../../src/core/raw-mime.js"
import {
  disable,
  isActive,
  pause,
} from "../../src/core/route.js"
import { ScopeSchema, type Scope } from "../../src/core/scope.js"
import { WorkflowEventSchema } from "../../src/core/workflow.js"
import { fromCloudflareD1 } from "../../src/storage/d1/cloudflare-adapter.js"
import { makeD1InboundStore } from "../../src/storage/d1/inbound-store.js"
import { makeD1MaintenanceStore } from "../../src/storage/d1/maintenance-store.js"
import { makeD1RouteStores } from "../../src/storage/d1/route-store.js"
import { makeD1WorkflowStore } from "../../src/storage/d1/workflow-store.js"

let sequence = 0

const nextSuffix = (): string => `integration-${sequence++}`

const makeScope = (suffix: string): Scope => ScopeSchema.make({
  namespace: NamespaceSchema.make(`namespace-${suffix}`),
  environment: "test",
})

const insertDomain = async (suffix: string): Promise<string> => {
  const domainId = `domain-${suffix}`
  const now = 1_900_000_000_000 + sequence * 1_000
  await env.EMAIL_DB.prepare(
    `INSERT INTO popcomputer_email_domains (
       id, domain, kind, environment, inbound_status, outbound_status,
       created_at, updated_at
     ) VALUES (?, ?, 'platform', 'test', 'active', 'active', ?, ?)`,
  ).bind(domainId, `${suffix}.example.com`, now, now).run()
  return domainId
}

const makeRouteInput = (
  suffix: string,
  scope: Scope,
  domainId: string,
  kind: "Store" | "Trigger",
): ReserveRouteInput => {
  const mailboxHandle = MailboxHandleSchema.make(
    kind === "Store" ? `inbox-${suffix}` : `workflow-${suffix}`,
  )
  const shared = {
    id: RouteIdSchema.make(`route-${suffix}-${kind}`),
    scope,
    domainId,
    address: EmailAddressSchema.make(
      `${mailboxHandle}@${suffix}.example.com`,
    ),
    mailboxHandle,
    actor: ActorSchema.cases.System.make({
      id: ActorIdSchema.make(`actor-${suffix}`),
    }),
    idempotencyKey: IdempotencyKeySchema.make(`route-key-${suffix}-${kind}`),
    creationFingerprint: RequestFingerprintSchema.make(
      (kind === "Store" ? "a" : "b").repeat(64),
    ),
    createdAt: DateTime.makeUnsafe(1_900_000_000_000 + sequence * 1_000),
  } as const
  return {
    ...shared,
    inbound: kind === "Store"
      ? { _tag: "Store" }
      : {
          _tag: "Trigger",
          workflowId: WorkflowIdSchema.make(`workflow-${suffix}`),
        },
    outbound: { _tag: "Sender", role: "default" },
  }
}

describe("D1 route stores", () => {
  it("reserves, scopes, and compare-and-set transitions routes", async () => {
    const suffix = nextSuffix()
    const scope = makeScope(suffix)
    const domainId = await insertDomain(suffix)
    const database = fromCloudflareD1(env.EMAIL_DB)
    const stores = makeD1RouteStores(database)

    const domain = await Effect.runPromise(
      stores.platformDomainRegistry.requireActive("test"),
    )
    expect(domain.id).toBe(domainId)

    const input = makeRouteInput(suffix, scope, domainId, "Store")
    const created = await Effect.runPromise(stores.routeAdminStore.reserve(input))
    expect(created._tag).toBe("Created")
    const replay = await Effect.runPromise(stores.routeAdminStore.reserve(input))
    expect(replay._tag).toBe("Existing")

    const selected = await Effect.runPromise(
      stores.routeStore.findDefaultSender(scope),
    )
    expect(Option.isSome(selected)).toBe(true)
    const wrongScope = makeScope(`${suffix}-other`)
    const hidden = await Effect.runPromise(
      stores.routeStore.findById(wrongScope, input.id),
    )
    expect(Option.isNone(hidden)).toBe(true)

    const current = created.record.route
    if (!isActive(current)) throw new Error("Expected a newly active route")
    const paused = pause(
      current,
      DateTime.makeUnsafe(DateTime.toEpochMillis(current.updatedAt) + 1),
    )
    const transitioned = await Effect.runPromise(
      stores.routeAdminStore.transition({
        scope,
        route: paused,
        expectedRevision: current.revision,
      }),
    )
    expect(transitioned.lifecycle._tag).toBe("Paused")

    const conflict = await Effect.runPromise(Effect.flip(
      stores.routeAdminStore.transition({
        scope,
        route: paused,
        expectedRevision: current.revision,
      }),
    ))
    expect(conflict._tag).toBe("RouteStoreTransitionConflict")
  })

  it("round-trips inbound and outbound capabilities independently", async () => {
    const suffix = nextSuffix()
    const scope = makeScope(suffix)
    const domainId = await insertDomain(suffix)
    const stores = makeD1RouteStores(fromCloudflareD1(env.EMAIL_DB))
    const input: ReserveRouteInput = {
      ...makeRouteInput(suffix, scope, domainId, "Trigger"),
      outbound: { _tag: "Disabled" },
    }

    const reserved = await Effect.runPromise(
      stores.routeAdminStore.reserve(input),
    )
    const found = await Effect.runPromise(
      stores.routeStore.findById(scope, input.id),
    )
    const defaultSender = await Effect.runPromise(
      stores.routeStore.findDefaultSender(scope),
    )

    expect(reserved.record.route.inbound._tag).toBe("Trigger")
    expect(reserved.record.route.outbound._tag).toBe("Disabled")
    expect(Option.isSome(found)).toBe(true)
    expect(Option.isNone(defaultSender)).toBe(true)
  })

  it("persists exactly one winner across concurrent rotations", async () => {
    const suffix = nextSuffix()
    const scope = makeScope(suffix)
    const domainId = await insertDomain(suffix)
    const database = fromCloudflareD1(env.EMAIL_DB)
    const stores = makeD1RouteStores(database)
    const original = makeRouteInput(
      suffix,
      scope,
      domainId,
      "Store",
    )
    const reserved = await Effect.runPromise(
      stores.routeAdminStore.reserve(original),
    )
    if (!isActive(reserved.record.route)) {
      throw new Error("Expected an active rotation source")
    }
    const rotatedAt = DateTime.addDuration(reserved.record.route.updatedAt, 1)
    const previous = disable(reserved.record.route, rotatedAt)
    const replacement = (
      discriminator: "left" | "right",
      fingerprintCharacter: "d" | "e",
    ): ReserveRouteInput => {
      const mailboxHandle = MailboxHandleSchema.make(
        `rotated-${discriminator}-${suffix}`,
      )
      return {
        ...original,
        id: RouteIdSchema.make(`route-rotated-${discriminator}-${suffix}`),
        address: EmailAddressSchema.make(
          `${mailboxHandle}@${suffix}.example.com`,
        ),
        mailboxHandle,
        idempotencyKey: IdempotencyKeySchema.make(
          `rotate-${discriminator}-${suffix}`,
        ),
        creationFingerprint: RequestFingerprintSchema.make(
          fingerprintCharacter.repeat(64),
        ),
        createdAt: rotatedAt,
      }
    }
    const candidates = [
      replacement("left", "d"),
      replacement("right", "e"),
    ] as const
    const outcomes = await Promise.all(candidates.map((candidate) =>
      Effect.runPromise(Effect.result(stores.routeAdminStore.rotate({
        scope,
        previous,
        expectedRevision: reserved.record.route.revision,
        replacement: candidate,
      })))))
    const successes = outcomes.filter((outcome) => outcome._tag === "Success")
    const failures = outcomes.filter((outcome) => outcome._tag === "Failure")
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    if (failures[0]?._tag === "Failure") {
      expect(failures[0].failure._tag).toBe("RouteStoreTransitionConflict")
    }
    const winner = successes[0]
    if (winner?._tag !== "Success") throw new Error("Expected one winner")
    const winnerInput = candidates.find((candidate) =>
      candidate.id === winner.success.replacement.id)
    if (winnerInput === undefined) throw new Error("Expected the winner input")

    const rows = await env.EMAIL_DB.prepare(
      `SELECT id, status, rotation_idempotency_key, rotation_fingerprint,
              rotation_replacement_id
       FROM popcomputer_email_routes
       WHERE namespace = ? AND environment = 'test'
       ORDER BY id`,
    ).bind(scope.namespace).all<{
      readonly id: string
      readonly status: string
      readonly rotation_idempotency_key: string | null
      readonly rotation_fingerprint: string | null
      readonly rotation_replacement_id: string | null
    }>()
    expect(rows.results).toHaveLength(2)
    expect(rows.results.filter((row) => row.status === "active")).toHaveLength(1)
    const source = rows.results.find((row) => row.id === original.id)
    expect(source).toEqual({
      id: original.id,
      status: "disabled",
      rotation_idempotency_key: winnerInput.idempotencyKey,
      rotation_fingerprint: winnerInput.creationFingerprint,
      rotation_replacement_id: winner.success.replacement.id,
    })

    const replay = await Effect.runPromise(stores.routeAdminStore.rotate({
      scope,
      previous,
      expectedRevision: reserved.record.route.revision,
      replacement: winnerInput,
    }))
    expect(replay.replacement.id).toBe(winner.success.replacement.id)
  })
})

interface InboundFixture {
  readonly input: CommitInboundInput
  readonly expiresAt: DateTime.Utc
  readonly now: DateTime.Utc
}

const sha256 = async (content: Uint8Array): Promise<typeof Sha256Schema.Type> => {
  const hashed = await crypto.subtle.digest("SHA-256", Uint8Array.from(content))
  const hex = Array.from(new Uint8Array(hashed), (byte) =>
    byte.toString(16).padStart(2, "0")).join("")
  return Sha256Schema.make(hex)
}

const inboundFixture = (
  suffix: string,
  discriminator: string,
  scope: Scope,
  route: ReserveRouteInput,
  envelopeFrom = "sender@example.net",
  observedOffsetMilliseconds = 0,
): InboundFixture => {
  if (route.inbound._tag !== "Trigger") {
    throw new Error("Expected a trigger route input")
  }
  const now = DateTime.makeUnsafe(
    1_900_000_100_000 + sequence * 1_000 + observedOffsetMilliseconds,
  )
  const messageId = MessageIdSchema.make(`inbound-${suffix}-${discriminator}`)
  const eventId = WorkflowEventIdSchema.make(
    `event-${suffix}-${discriminator}`,
  )
  const rawSha256 = Sha256Schema.make("c".repeat(64))
  const from = EmailAddressSchema.make(envelopeFrom)
  const message = MessageSchema.cases.Inbound.make({
    id: messageId,
    scope,
    routeId: route.id,
    workflowId: route.inbound.workflowId,
    from,
    to: [route.address],
    subject: "Inbound integration",
    rfcMessageId: `<shared-${suffix}@example.net>`,
    sizeBytes: 128,
    receivedAt: now,
    createdAt: now,
    updatedAt: now,
    state: MessageSchema.cases.Inbound.fields.state.cases
      .WorkflowEventCreated.make({ eventId }),
  })
  const recipient = MessageRecipientSchema.make({
    id: RecipientIdSchema.make(`inbound-recipient-${suffix}-${discriminator}`),
    messageId,
    kind: "to",
    address: route.address,
    status: "delivered",
    createdAt: now,
    updatedAt: now,
  })
  const raw = RawMimeDescriptorSchema.make({
    scope,
    direction: "inbound",
    messageId,
    ref: RawMessageRefSchema.make(`raw:${suffix}:${discriminator}`),
    sha256: rawSha256,
    sizeBytes: 128,
  })
  const workflowEvent = WorkflowEventSchema.make({
    event: {
      schemaVersion: 1,
      type: "email.received",
      eventId,
      occurredAt: now,
      scope,
      workflowId: route.inbound.workflowId,
      message: {
        id: messageId,
        routeId: route.id,
        from,
        to: [route.address],
        subject: message.subject,
        sizeBytes: message.sizeBytes,
        receivedAt: now,
      },
    },
    state: WorkflowEventSchema.fields.state.cases.Pending.make({
      nextAttemptAt: now,
    }),
    createdAt: now,
    updatedAt: now,
  })
  return {
    now,
    expiresAt: DateTime.addDuration(now, 60_000),
    input: {
      duplicateKey: {
        _tag: "Digest",
        scope,
        routeId: route.id,
        envelopeFrom: from,
        rawSha256,
        observedAt: now,
        expiresAt: DateTime.addDuration(now, 60_000),
      },
      message,
      recipient,
      raw,
      workflowEvent,
    },
  }
}

const prepareArchivedFixture = async (
  archive: ReturnType<typeof makeR2RawMessageArchive>,
  fixture: InboundFixture,
  content: Uint8Array,
) => {
  if (fixture.input.duplicateKey._tag !== "Digest") {
    throw new Error("Expected a digest fixture")
  }
  const rawSha256 = await sha256(content)
  const archiveInput = {
    scope: fixture.input.message.scope,
    direction: "inbound" as const,
    messageId: fixture.input.message.id,
    content,
    sha256: rawSha256,
  }
  const rawRef = await Effect.runPromise(archive.referenceFor(archiveInput))
  const message = MessageSchema.cases.Inbound.make({
    ...fixture.input.message,
    sizeBytes: content.byteLength,
  })
  const workflowEvent = fixture.input.workflowEvent === undefined
    ? undefined
    : WorkflowEventSchema.make({
        ...fixture.input.workflowEvent,
        event: {
          ...fixture.input.workflowEvent.event,
          message: {
            ...fixture.input.workflowEvent.event.message,
            sizeBytes: content.byteLength,
          },
        },
      })
  return {
    archiveInput,
    fixture: {
      ...fixture,
      input: {
        ...fixture.input,
        duplicateKey: {
          ...fixture.input.duplicateKey,
          rawSha256,
        },
        message,
        raw: RawMimeDescriptorSchema.make({
          ...fixture.input.raw,
          ref: rawRef,
          sha256: rawSha256,
          sizeBytes: content.byteLength,
        }),
        workflowEvent,
      },
    } satisfies InboundFixture,
  }
}

describe("D1 inbound and workflow outbox", () => {
  it("atomically deduplicates inbound metadata and exclusively leases its event", async () => {
    const suffix = nextSuffix()
    const scope = makeScope(suffix)
    const domainId = await insertDomain(suffix)
    const database = fromCloudflareD1(env.EMAIL_DB)
    const routes = makeD1RouteStores(database)
    const routeInput = makeRouteInput(
      suffix,
      scope,
      domainId,
      "Trigger",
    )
    if (routeInput.inbound._tag !== "Trigger") {
      throw new Error("Expected a workflow route input")
    }
    await Effect.runPromise(routes.routeAdminStore.reserve(routeInput))

    const inbound = makeD1InboundStore(database)
    const left = inboundFixture(suffix, "left", scope, routeInput)
    const right = inboundFixture(suffix, "right", scope, routeInput)
    for (const fixture of [left, right]) {
      await Effect.runPromise(inbound.createArchiveIntent({
        messageId: fixture.input.message.id,
        scope,
        rawSha256: fixture.input.raw.sha256,
        rawRef: fixture.input.raw.ref,
        expiresAt: fixture.expiresAt,
        now: fixture.now,
      }))
    }

    const commits = await Promise.all([
      Effect.runPromise(inbound.commit(left.input)),
      Effect.runPromise(inbound.commit(right.input)),
    ])
    expect(commits.map((result) => result._tag).sort()).toEqual([
      "Created",
      "Existing",
    ])
    expect(commits[0]?.message.id).toBe(commits[1]?.message.id)
    const losingIndex = commits.findIndex((result) => result._tag === "Existing")
    const losingFixture = [left, right][losingIndex]
    if (losingFixture === undefined) throw new Error("Expected a losing fixture")

    const counts = await env.EMAIL_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM popcomputer_email_messages
          WHERE namespace = ? AND direction = 'inbound') AS messages,
         (SELECT COUNT(*) FROM popcomputer_email_recipients
          WHERE message_id IN (
            SELECT id FROM popcomputer_email_messages WHERE namespace = ?
          )) AS recipients,
         (SELECT COUNT(*) FROM popcomputer_email_workflow_events
          WHERE namespace = ?) AS events,
         (SELECT COUNT(*) FROM popcomputer_email_inbound_archive_intents
          WHERE namespace = ?) AS intents`,
    ).bind(
      scope.namespace,
      scope.namespace,
      scope.namespace,
      scope.namespace,
    ).first<{
      messages: number
      recipients: number
      events: number
      intents: number
    }>()
    expect(counts).toEqual({
      messages: 1,
      recipients: 1,
      events: 1,
      intents: 1,
    })
    const retainedIntent = await env.EMAIL_DB.prepare(
      `SELECT message_id FROM popcomputer_email_inbound_archive_intents
       WHERE namespace = ?`,
    ).bind(scope.namespace).first<{ message_id: string }>()
    expect(retainedIntent?.message_id).toBe(losingFixture.input.message.id)

    const workflow = makeD1WorkflowStore(database)
    const ready = await Effect.runPromise(workflow.listReady({
      now: DateTime.addDuration(left.now, 1),
      limit: 10,
    }))
    expect(ready).toHaveLength(1)
    const event = ready[0]
    if (event === undefined) throw new Error("Expected a ready event")
    const leasedAt = DateTime.addDuration(left.now, 2)
    const expiresAt = DateTime.addDuration(leasedAt, 60_000)
    const claims = await Promise.all([
      Effect.runPromise(workflow.claim({
        event,
        leaseToken: LeaseTokenSchema.make(`lease-${suffix}-left`),
        leasedAt,
        leaseExpiresAt: expiresAt,
      })),
      Effect.runPromise(workflow.claim({
        event,
        leaseToken: LeaseTokenSchema.make(`lease-${suffix}-right`),
        leasedAt,
        leaseExpiresAt: expiresAt,
      })),
    ])
    expect(claims.filter(Option.isSome)).toHaveLength(1)
    const claimed = claims.find(Option.isSome)
    if (claimed === undefined) throw new Error("Expected one lease owner")

    const started = await Effect.runPromise(workflow.markStarted({
      event: claimed.value,
      leaseToken: claimed.value.state.leaseToken,
      runId: WorkflowRunIdSchema.make(`run-${suffix}`),
      startedAt: DateTime.addDuration(leasedAt, 1),
    }))
    expect(started.state._tag).toBe("Started")
    const lostLease = await Effect.runPromise(Effect.flip(
      workflow.markDead({
        event: claimed.value,
        leaseToken: claimed.value.state.leaseToken,
        deadAt: DateTime.addDuration(leasedAt, 2),
        reason: WorkflowEventSchema.fields.state.cases.Dead.fields.reason.make(
          "workflow_runtime.start_failed",
        ),
      }),
    ))
    expect(lostLease._tag).toBe("WorkflowStoreLeaseConflict")
  })

  it("retains a losing D1 and R2 intent across a simulated post-commit crash", async () => {
    const suffix = nextSuffix()
    const scope = makeScope(suffix)
    const domainId = await insertDomain(suffix)
    const database = fromCloudflareD1(env.EMAIL_DB)
    const routes = makeD1RouteStores(database)
    const routeInput = makeRouteInput(suffix, scope, domainId, "Trigger")
    if (routeInput.inbound._tag !== "Trigger") {
      throw new Error("Expected a workflow route input")
    }
    await Effect.runPromise(routes.routeAdminStore.reserve(routeInput))

    const archive = makeR2RawMessageArchive(env.EMAIL_RAW)
    const inbound = makeD1InboundStore(database)
    const content = new TextEncoder().encode(
      "From: sender@example.net\r\nTo: inbox@example.com\r\n\r\nreplay\r\n",
    )
    const winner = await prepareArchivedFixture(
      archive,
      inboundFixture(suffix, "crash-winner", scope, routeInput),
      content,
    )
    const loser = await prepareArchivedFixture(
      archive,
      inboundFixture(suffix, "crash-loser", scope, routeInput),
      content,
    )
    for (const prepared of [winner, loser]) {
      await Effect.runPromise(inbound.createArchiveIntent({
        messageId: prepared.fixture.input.message.id,
        scope,
        rawSha256: prepared.fixture.input.raw.sha256,
        rawRef: prepared.fixture.input.raw.ref,
        expiresAt: prepared.fixture.expiresAt,
        now: prepared.fixture.now,
      }))
      await Effect.runPromise(archive.put(prepared.archiveInput))
    }

    const winnerResult = await Effect.runPromise(
      inbound.commit(winner.fixture.input),
    )
    const loserResult = await Effect.runPromise(
      inbound.commit(loser.fixture.input),
    )
    expect(winnerResult._tag).toBe("Created")
    expect(loserResult._tag).toBe("Existing")

    const retained = await env.EMAIL_DB.prepare(
      `SELECT message_id, raw_ref
       FROM popcomputer_email_inbound_archive_intents
       WHERE namespace = ?`,
    ).bind(scope.namespace).all<{
      readonly message_id: string
      readonly raw_ref: string
    }>()
    expect(retained.results).toEqual([{
      message_id: loser.fixture.input.message.id,
      raw_ref: loser.fixture.input.raw.ref,
    }])
    expect(Option.isSome(
      await Effect.runPromise(archive.get(loser.fixture.input.raw.ref)),
    )).toBe(true)

    const cleanupNow = DateTime.makeUnsafe(Date.now() - 2_000)
    const retryAt = DateTime.makeUnsafe(Date.now() - 1_000)
    await Effect.runPromise(inbound.markArchiveCleanup({
      messageId: loser.fixture.input.message.id,
      scope,
      rawRef: loser.fixture.input.raw.ref,
      safeErrorCode: "archive_remove_failed",
      now: cleanupNow,
      nextAttemptAt: retryAt,
    }))
    await Effect.runPromise(inbound.markArchiveCleanup({
      messageId: loser.fixture.input.message.id,
      scope,
      rawRef: loser.fixture.input.raw.ref,
      safeErrorCode: "archive_remove_failed",
      now: DateTime.makeUnsafe(Date.now()),
      nextAttemptAt: DateTime.makeUnsafe(Date.now() + 60_000),
    }))
    const promoted = await env.EMAIL_DB.prepare(
      `SELECT status, attempt_count, next_attempt_at,
              (SELECT COUNT(*)
               FROM popcomputer_email_archive_deletions
               WHERE namespace = ? AND environment = 'test'
                 AND direction = 'inbound' AND message_id = ?) AS deletions
       FROM popcomputer_email_inbound_archive_intents
       WHERE namespace = ? AND environment = 'test' AND message_id = ?`,
    ).bind(
      scope.namespace,
      loser.fixture.input.message.id,
      scope.namespace,
      loser.fixture.input.message.id,
    ).first<{
      readonly status: string
      readonly attempt_count: number
      readonly next_attempt_at: number
      readonly deletions: number
    }>()
    expect(promoted).toEqual({
      status: "failed",
      attempt_count: 0,
      next_attempt_at: DateTime.toEpochMillis(retryAt),
      deletions: 0,
    })

    const maintenance = makeD1MaintenanceStore(database)
    const firstCandidates = await Effect.runPromise(
      maintenance.listArchiveCleanup({
        now: DateTime.makeUnsafe(Date.now()),
        limit: 10,
      }),
    )
    expect(firstCandidates).toHaveLength(1)
    const firstCandidate = firstCandidates[0]
    if (firstCandidate === undefined) {
      throw new Error("Expected one promoted cleanup candidate")
    }
    expect(firstCandidate._tag).toBe("InboundIntent")
    expect(firstCandidate.attempt).toBe(0)
    expect(firstCandidate.rawRef).toBe(loser.fixture.input.raw.ref)
    const firstClaim = await Effect.runPromise(
      maintenance.claimArchiveCleanup({
        item: firstCandidate,
        leaseToken: LeaseTokenSchema.make(`cleanup-${suffix}-first`),
        leaseExpiresAt: DateTime.makeUnsafe(Date.now() + 60_000),
      }),
    )
    if (Option.isNone(firstClaim)) throw new Error("Expected the first lease")
    await Effect.runPromise(maintenance.failArchiveCleanup({
      item: firstClaim.value,
      nextAttemptAt: DateTime.makeUnsafe(Date.now() - 2_000),
      dead: false,
      safeErrorCode: "archive_remove_failed",
    }))

    const retryCandidates = await Effect.runPromise(
      maintenance.listArchiveCleanup({
        now: DateTime.makeUnsafe(Date.now()),
        limit: 10,
      }),
    )
    expect(retryCandidates).toHaveLength(1)
    const retryCandidate = retryCandidates[0]
    if (retryCandidate === undefined) {
      throw new Error("Expected one retry candidate")
    }
    expect(retryCandidate._tag).toBe("InboundIntent")
    expect(retryCandidate.attempt).toBe(1)
    const retryClaim = await Effect.runPromise(
      maintenance.claimArchiveCleanup({
        item: retryCandidate,
        leaseToken: LeaseTokenSchema.make(`cleanup-${suffix}-retry`),
        leaseExpiresAt: DateTime.makeUnsafe(Date.now() + 60_000),
      }),
    )
    if (Option.isNone(retryClaim)) throw new Error("Expected the retry lease")
    await Effect.runPromise(archive.remove(loser.fixture.input.raw.ref))
    await Effect.runPromise(maintenance.completeArchiveCleanup(
      retryClaim.value,
    ))
    expect(Option.isNone(
      await Effect.runPromise(archive.get(loser.fixture.input.raw.ref)),
    )).toBe(true)
    const afterRecovery = await env.EMAIL_DB.prepare(
      `SELECT
         (SELECT COUNT(*)
          FROM popcomputer_email_inbound_archive_intents
          WHERE namespace = ?) AS intents,
         (SELECT COUNT(*)
          FROM popcomputer_email_archive_deletions
          WHERE namespace = ?) AS deletions`,
    ).bind(scope.namespace, scope.namespace).first<{
      readonly intents: number
      readonly deletions: number
    }>()
    expect(afterRecovery).toEqual({ intents: 0, deletions: 0 })

    await Effect.runPromise(archive.remove(winner.fixture.input.raw.ref))
  })

  it("bounds digest receipts while provider delivery IDs remain stable", async () => {
    const suffix = nextSuffix()
    const scope = makeScope(suffix)
    const domainId = await insertDomain(suffix)
    const database = fromCloudflareD1(env.EMAIL_DB)
    const routes = makeD1RouteStores(database)
    const routeInput = makeRouteInput(
      suffix,
      scope,
      domainId,
      "Trigger",
    )
    if (routeInput.inbound._tag !== "Trigger") {
      throw new Error("Expected a workflow route input")
    }
    await Effect.runPromise(routes.routeAdminStore.reserve(routeInput))

    const inbound = makeD1InboundStore(database)
    const first = inboundFixture(suffix, "first", scope, routeInput)
    const secondBase = inboundFixture(suffix, "second", scope, routeInput)
    if (secondBase.input.duplicateKey._tag !== "Digest") {
      throw new Error("Expected a digest fixture")
    }
    const secondSha256 = Sha256Schema.make("d".repeat(64))
    const second = {
      ...secondBase,
      input: {
        ...secondBase.input,
        duplicateKey: {
          ...secondBase.input.duplicateKey,
          rawSha256: secondSha256,
        },
        raw: {
          ...secondBase.input.raw,
          sha256: secondSha256,
        },
      },
    }
    const distinctEnvelope = inboundFixture(
      suffix,
      "different-envelope",
      scope,
      routeInput,
      "other-sender@example.net",
    )
    const afterWindow = inboundFixture(
      suffix,
      "after-window",
      scope,
      routeInput,
      "sender@example.net",
      60_000,
    )
    const providerDelivery = Schema.decodeUnknownSync(
      InboundProviderDeliverySchema,
    )({
      provider: "example-provider",
      deliveryId: `delivery-${suffix}-one`,
    })
    const providerKey = {
      _tag: "Provider" as const,
      scope,
      routeId: routeInput.id,
      provider: providerDelivery.provider,
      deliveryId: providerDelivery.deliveryId,
    }
    const providerFirstBase = inboundFixture(
      suffix,
      "provider-first",
      scope,
      routeInput,
    )
    const providerFirst = {
      ...providerFirstBase,
      input: {
        ...providerFirstBase.input,
        duplicateKey: providerKey,
      },
    }
    const providerReplayBase = inboundFixture(
      suffix,
      "provider-replay",
      scope,
      routeInput,
      "other-sender@example.net",
      1_000_000,
    )
    const providerReplay = {
      ...providerReplayBase,
      input: {
        ...providerReplayBase.input,
        duplicateKey: providerKey,
      },
    }
    const distinctProviderDelivery = Schema.decodeUnknownSync(
      InboundProviderDeliverySchema,
    )({
      provider: "example-provider",
      deliveryId: `delivery-${suffix}-two`,
    })
    const providerDistinctBase = inboundFixture(
      suffix,
      "provider-distinct",
      scope,
      routeInput,
    )
    const providerDistinct = {
      ...providerDistinctBase,
      input: {
        ...providerDistinctBase.input,
        duplicateKey: {
          ...providerKey,
          deliveryId: distinctProviderDelivery.deliveryId,
        },
      },
    }
    const fixtures = [
      first,
      second,
      distinctEnvelope,
      afterWindow,
      providerFirst,
      providerReplay,
      providerDistinct,
    ]
    for (const fixture of fixtures) {
      await Effect.runPromise(inbound.createArchiveIntent({
        messageId: fixture.input.message.id,
        scope,
        rawSha256: fixture.input.raw.sha256,
        rawRef: fixture.input.raw.ref,
        expiresAt: fixture.expiresAt,
        now: fixture.now,
      }))
    }

    const firstResult = await Effect.runPromise(inbound.commit(first.input))
    const secondResult = await Effect.runPromise(inbound.commit(second.input))
    const distinctEnvelopeResult = await Effect.runPromise(
      inbound.commit(distinctEnvelope.input),
    )
    const afterWindowResult = await Effect.runPromise(
      inbound.commit(afterWindow.input),
    )
    const providerFirstResult = await Effect.runPromise(
      inbound.commit(providerFirst.input),
    )
    const providerReplayResult = await Effect.runPromise(
      inbound.commit(providerReplay.input),
    )
    const providerDistinctResult = await Effect.runPromise(
      inbound.commit(providerDistinct.input),
    )

    expect(firstResult._tag).toBe("Created")
    expect(secondResult._tag).toBe("Created")
    expect(distinctEnvelopeResult._tag).toBe("Created")
    expect(afterWindowResult._tag).toBe("Created")
    expect(afterWindowResult.message.id).not.toBe(firstResult.message.id)
    expect(providerFirstResult._tag).toBe("Created")
    expect(providerReplayResult._tag).toBe("Existing")
    expect(providerReplayResult.message.id).toBe(providerFirstResult.message.id)
    expect(providerDistinctResult._tag).toBe("Created")
    expect(providerDistinctResult.message.id).not.toBe(
      providerFirstResult.message.id,
    )
    expect(firstResult.message.rfcMessageId).toBe(
      secondResult.message.rfcMessageId,
    )
    expect(firstResult.message.id).not.toBe(secondResult.message.id)
    expect(distinctEnvelopeResult.message.from).not.toBe(
      firstResult.message.from,
    )
    const counts = await env.EMAIL_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM popcomputer_email_messages
          WHERE namespace = ? AND direction = 'inbound') AS messages,
         (SELECT COUNT(*) FROM popcomputer_email_workflow_events
          WHERE namespace = ?) AS events,
         (SELECT COUNT(*) FROM popcomputer_email_inbound_dedupe_receipts
          WHERE namespace = ?) AS receipts`,
    ).bind(scope.namespace, scope.namespace, scope.namespace).first<{
      messages: number
      events: number
      receipts: number
    }>()
    expect(counts).toEqual({ messages: 6, events: 6, receipts: 5 })
  })
})
