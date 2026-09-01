import { env } from "cloudflare:workers"
import { DateTime, Effect, Option, Result } from "effect"
import { describe, expect, it } from "vitest"
import { ActorSchema } from "../../src/core/actor.js"
import { EmailAddressSchema } from "../../src/core/address.js"
import {
  ActorIdSchema,
  DestinationIdSchema,
  IdempotencyKeySchema,
  LeaseTokenSchema,
  MessageIdSchema,
  NamespaceSchema,
  RequestFingerprintSchema,
  TestRecipientIdSchema,
} from "../../src/core/identifiers.js"
import { ScopeSchema, TestScopeSchema } from "../../src/core/scope.js"
import {
  TestRecipientSchema,
  TestRecipientStateSchema,
} from "../../src/core/test-recipient.js"
import { fromCloudflareD1 } from "../../src/storage/d1/cloudflare-adapter.js"
import { makeD1MaintenanceStore } from "../../src/storage/d1/maintenance-store.js"
import { makeD1MessageStore } from "../../src/storage/d1/message-store.js"
import { makeD1OutboundPolicy } from "../../src/storage/d1/outbound-policy.js"
import { makeD1TestRecipientStore } from "../../src/storage/d1/test-recipient-store.js"

let sequence = 0

const nextSuffix = (): string => `policy-${sequence++}`

describe("D1 test-recipient policy", () => {
  it("allows only verified namespace-local recipients in test scope", async () => {
    const suffix = nextSuffix()
    const scope = TestScopeSchema.make({
      namespace: NamespaceSchema.make(`namespace-${suffix}`),
      environment: "test",
    })
    const otherScope = TestScopeSchema.make({
      namespace: NamespaceSchema.make(`namespace-${suffix}-other`),
      environment: "test",
    })
    const verifiedAddress = EmailAddressSchema.make("verified@example.com")
    const pendingAddress = EmailAddressSchema.make("pending@example.com")
    const verifiedDestination = DestinationIdSchema.make(
      `destination-${suffix}-verified`,
    )
    const pendingDestination = DestinationIdSchema.make(
      `destination-${suffix}-pending`,
    )
    const database = fromCloudflareD1(env.EMAIL_DB)
    const store = makeD1TestRecipientStore(database, {
      providerAccountKey: "account",
    })
    const now = DateTime.makeUnsafe(Date.now())
    const actor = ActorSchema.cases.System.make({
      id: ActorIdSchema.make(`actor-${suffix}`),
    })

    const persistGrant = async (
      recipient: typeof TestRecipientSchema.Type,
      key: typeof IdempotencyKeySchema.Type,
      fingerprint: typeof RequestFingerprintSchema.Type,
      tokenSuffix: string,
    ) => {
      const leaseToken = LeaseTokenSchema.make(
        `add-lease-${suffix}-${tokenSuffix}`,
      )
      const claim = await Effect.runPromise(store.claimAdd({
        scope,
        address: recipient.address,
        idempotencyKey: key,
        fingerprint,
        leaseToken,
        claimedAt: now,
        leaseExpiresAt: DateTime.addDuration(now, 60_000),
      }))
      expect(claim._tag).toBe("Claimed")
      return Effect.runPromise(store.completeAdd({
        recipient,
        idempotencyKey: key,
        fingerprint,
        leaseToken,
      }))
    }

    await persistGrant(
      TestRecipientSchema.make({
        id: TestRecipientIdSchema.make(`grant-${suffix}-verified`),
        scope,
        destinationId: verifiedDestination,
        address: verifiedAddress,
        actor,
        state: TestRecipientStateSchema.cases.Verified.make({
          verifiedAt: now,
        }),
        createdAt: now,
        updatedAt: now,
      }),
      IdempotencyKeySchema.make(`grant-${suffix}-verified`),
      RequestFingerprintSchema.make("a".repeat(64)),
      "verified",
    )
    await persistGrant(
      TestRecipientSchema.make({
        id: TestRecipientIdSchema.make(`grant-${suffix}-pending`),
        scope,
        destinationId: pendingDestination,
        address: pendingAddress,
        actor,
        state: TestRecipientStateSchema.cases.Pending.make({
          requestedAt: now,
        }),
        createdAt: now,
        updatedAt: now,
      }),
      IdempotencyKeySchema.make(`grant-${suffix}-pending`),
      RequestFingerprintSchema.make("b".repeat(64)),
      "pending",
    )
    const mirroredDestinations = await env.EMAIL_DB.prepare(
      `SELECT COUNT(*) AS count
       FROM popcomputer_email_cf_destinations
       WHERE provider_account_key = ?`,
    ).bind("account").first<{ readonly count: number }>()
    expect(mirroredDestinations?.count).toBe(2)

    const concurrentKey = IdempotencyKeySchema.make(
      `grant-${suffix}-concurrent`,
    )
    const concurrentAt = DateTime.addDuration(now, 1)
    const concurrentClaims = await Promise.all([
      Effect.runPromise(store.claimAdd({
        scope,
        address: EmailAddressSchema.make(`left-${suffix}@example.com`),
        idempotencyKey: concurrentKey,
        fingerprint: RequestFingerprintSchema.make("1".repeat(64)),
        leaseToken: LeaseTokenSchema.make(`add-lease-${suffix}-left`),
        claimedAt: concurrentAt,
        leaseExpiresAt: DateTime.addDuration(concurrentAt, 60_000),
      })),
      Effect.runPromise(store.claimAdd({
        scope,
        address: EmailAddressSchema.make(`right-${suffix}@example.com`),
        idempotencyKey: concurrentKey,
        fingerprint: RequestFingerprintSchema.make("2".repeat(64)),
        leaseToken: LeaseTokenSchema.make(`add-lease-${suffix}-right`),
        claimedAt: concurrentAt,
        leaseExpiresAt: DateTime.addDuration(concurrentAt, 60_000),
      })),
    ])
    expect(concurrentClaims.filter((claim) => claim._tag === "Claimed"))
      .toHaveLength(1)
    expect(concurrentClaims.filter((claim) => claim._tag === "Pending"))
      .toHaveLength(1)
    const concurrentRows = await env.EMAIL_DB.prepare(
      `SELECT COUNT(*) AS count
       FROM popcomputer_email_test_recipient_adds
       WHERE namespace = ? AND environment = 'test' AND idempotency_key = ?`,
    ).bind(scope.namespace, concurrentKey).first<{ readonly count: number }>()
    expect(concurrentRows?.count).toBe(1)

    const aliasKey = IdempotencyKeySchema.make(`grant-${suffix}-alias`)
    const aliasFingerprint = RequestFingerprintSchema.make("3".repeat(64))
    const alias = await Effect.runPromise(store.claimAdd({
      scope,
      address: verifiedAddress,
      idempotencyKey: aliasKey,
      fingerprint: aliasFingerprint,
      leaseToken: LeaseTokenSchema.make(`add-lease-${suffix}-alias`),
      claimedAt: concurrentAt,
      leaseExpiresAt: DateTime.addDuration(concurrentAt, 60_000),
    }))
    expect(alias._tag).toBe("Completed")
    const hijack = await Effect.runPromise(store.claimAdd({
      scope,
      address: pendingAddress,
      idempotencyKey: aliasKey,
      fingerprint: RequestFingerprintSchema.make("4".repeat(64)),
      leaseToken: LeaseTokenSchema.make(`add-lease-${suffix}-hijack`),
      claimedAt: concurrentAt,
      leaseExpiresAt: DateTime.addDuration(concurrentAt, 60_000),
    }))
    expect(hijack._tag).toBe("Completed")
    if (hijack._tag === "Completed") {
      expect(hijack.add.recipient.address).toBe(verifiedAddress)
      expect(hijack.add.fingerprint).toBe(aliasFingerprint)
    }

    const policy = makeD1OutboundPolicy(database, {
      maximumMessageBytes: 1_024,
      maximumRecipients: 2,
    })
    await Effect.runPromise(policy.check({
      scope,
      recipients: [verifiedAddress, verifiedAddress],
      sizeBytes: 100,
    }))
    const pending = await Effect.runPromise(Effect.flip(policy.check({
      scope,
      recipients: [pendingAddress],
      sizeBytes: 100,
    })))
    expect(pending._tag).toBe("RecipientNotPermitted")
    const crossScope = await Effect.runPromise(Effect.flip(policy.check({
      scope: otherScope,
      recipients: [verifiedAddress],
      sizeBytes: 100,
    })))
    expect(crossScope._tag).toBe("RecipientNotPermitted")

    await Effect.runPromise(policy.check({
      scope: ScopeSchema.make({
        namespace: otherScope.namespace,
        environment: "live",
      }),
      recipients: [pendingAddress],
      sizeBytes: 100,
    }))
    const tooLarge = await Effect.runPromise(Effect.flip(policy.check({
      scope,
      recipients: [verifiedAddress],
      sizeBytes: 1_025,
    })))
    expect(tooLarge._tag).toBe("MessageTooLarge")
    const tooMany = await Effect.runPromise(Effect.flip(policy.check({
      scope,
      recipients: [verifiedAddress, pendingAddress, verifiedAddress],
      sizeBytes: 100,
    })))
    expect(tooMany._tag).toBe("RecipientNotPermitted")
    const invalidPolicy = makeD1OutboundPolicy(database, {
      maximumMessageBytes: Number.MAX_SAFE_INTEGER + 1,
      maximumRecipients: 2,
    })
    const invalidPolicyResult = await Effect.runPromise(Effect.flip(
      invalidPolicy.check({
        scope,
        recipients: [verifiedAddress],
        sizeBytes: 100,
      }),
    ))
    expect(invalidPolicyResult._tag).toBe("OutboundPolicyFailure")

    const stored = await Effect.runPromise(store.findByAddress(
      scope,
      verifiedAddress,
    ))
    if (Option.isNone(stored)) throw new Error("Expected the verified grant")
    const updatedAt = DateTime.addDuration(now, 1)
    const refreshes = await Promise.all([
      Effect.runPromise(Effect.result(store.refresh({
        scope,
        testRecipientId: stored.value.recipient.id,
        state: TestRecipientStateSchema.cases.Pending.make({
          requestedAt: updatedAt,
        }),
        idempotencyKey: IdempotencyKeySchema.make(`refresh-${suffix}-left`),
        fingerprint: RequestFingerprintSchema.make("c".repeat(64)),
        updatedAt,
      }))),
      Effect.runPromise(Effect.result(store.refresh({
        scope,
        testRecipientId: stored.value.recipient.id,
        state: TestRecipientStateSchema.cases.Pending.make({
          requestedAt: updatedAt,
        }),
        idempotencyKey: IdempotencyKeySchema.make(`refresh-${suffix}-right`),
        fingerprint: RequestFingerprintSchema.make("d".repeat(64)),
        updatedAt,
      }))),
    ])
    expect(refreshes.filter(Result.isSuccess)).toHaveLength(1)
    expect(refreshes.filter(Result.isFailure)).toHaveLength(1)

    const historicalAt = DateTime.addDuration(now, 2)
    const historicalKey = IdempotencyKeySchema.make(`refresh-${suffix}-a`)
    const historicalFingerprint = RequestFingerprintSchema.make("e".repeat(64))
    const historical = await Effect.runPromise(store.refresh({
      scope,
      testRecipientId: stored.value.recipient.id,
      state: TestRecipientStateSchema.cases.Verified.make({
        verifiedAt: historicalAt,
      }),
      idempotencyKey: historicalKey,
      fingerprint: historicalFingerprint,
      updatedAt: historicalAt,
    }))
    const latestAt = DateTime.addDuration(now, 3)
    await Effect.runPromise(store.refresh({
      scope,
      testRecipientId: stored.value.recipient.id,
      state: TestRecipientStateSchema.cases.Pending.make({
        requestedAt: latestAt,
      }),
      idempotencyKey: IdempotencyKeySchema.make(`refresh-${suffix}-b`),
      fingerprint: RequestFingerprintSchema.make("f".repeat(64)),
      updatedAt: latestAt,
    }))
    const replay = await Effect.runPromise(store.findRefreshByIdempotency(
      scope,
      historicalKey,
    ))
    expect(Option.isSome(replay)).toBe(true)
    if (Option.isSome(replay)) {
      expect(replay.value.recipient.state).toEqual(historical.recipient.state)
      expect(replay.value.lastRefresh?.idempotencyKey).toBe(historicalKey)
    }
    const mismatchedReplay = await Effect.runPromise(Effect.result(
      store.refresh({
        scope,
        testRecipientId: stored.value.recipient.id,
        state: TestRecipientStateSchema.cases.Verified.make({
          verifiedAt: historicalAt,
        }),
        idempotencyKey: historicalKey,
        fingerprint: RequestFingerprintSchema.make("0".repeat(64)),
        updatedAt: historicalAt,
      }),
    ))
    expect(Result.isFailure(mismatchedReplay)).toBe(true)
  })
})

const insertStaleSending = async (
  suffix: string,
  claimedAt: number,
): Promise<{
  readonly scope: ReturnType<typeof ScopeSchema.make>
  readonly messageId: typeof MessageIdSchema.Type
}> => {
  const namespace = NamespaceSchema.make(`namespace-${suffix}`)
  const scope = ScopeSchema.make({ namespace, environment: "test" })
  const domainId = `domain-${suffix}`
  const routeId = `route-${suffix}`
  const messageId = MessageIdSchema.make(`message-${suffix}`)
  const now = claimedAt - 1_000
  await env.EMAIL_DB.batch([
    env.EMAIL_DB.prepare(
      `INSERT INTO popcomputer_email_domains (
         id, domain, kind, environment, inbound_status, outbound_status,
         created_at, updated_at
       ) VALUES (?, ?, 'platform', 'test', 'active', 'active', ?, ?)`,
    ).bind(domainId, `${suffix}.example.com`, now, now),
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
      namespace,
      domainId,
      `sender@${suffix}.example.com`,
      `actor-${suffix}`,
      now,
      now,
    ),
    env.EMAIL_DB.prepare(
      `INSERT INTO popcomputer_email_messages (
         id, namespace, environment, route_id, workflow_id, direction, status,
         state_reason, from_address, to_address, subject, rfc_message_id,
         raw_sha256, raw_ref, size_bytes, idempotency_key,
         request_fingerprint, provider_message_id, actor_kind, actor_id,
         claimed_at, sent_at, received_at, created_at, updated_at
       ) VALUES (
         ?, ?, 'test', ?, NULL, 'outbound', 'sending',
         NULL, ?, 'recipient@example.com', 'Stale', NULL,
         ?, ?, 10, ?, ?, NULL, 'system', ?,
         ?, NULL, NULL, ?, ?
       )`,
    ).bind(
      messageId,
      namespace,
      routeId,
      `sender@${suffix}.example.com`,
      "e".repeat(64),
      `raw:${suffix}`,
      `send-${suffix}`,
      "f".repeat(64),
      `actor-${suffix}`,
      claimedAt,
      now,
      claimedAt,
    ),
    env.EMAIL_DB.prepare(
      `INSERT INTO popcomputer_email_recipients (
         id, message_id, kind, position, address, status, created_at, updated_at
       ) VALUES (?, ?, 'to', 0, 'recipient@example.com', 'pending', ?, ?)`,
    ).bind(`recipient-${suffix}`, messageId, now, claimedAt),
  ])
  return { scope, messageId }
}

describe("D1 maintenance", () => {
  it("recovers stale sends and exclusively leases both cleanup queues", async () => {
    const suffix = nextSuffix()
    const database = fromCloudflareD1(env.EMAIL_DB)
    const maintenance = makeD1MaintenanceStore(database)
    const currentEpoch = Date.now()
    const stale = await insertStaleSending(suffix, currentEpoch - 120_000)
    const recovered = await Effect.runPromise(maintenance.recoverStaleSending({
      staleBefore: DateTime.makeUnsafe(currentEpoch - 60_000),
      occurredAt: DateTime.makeUnsafe(currentEpoch),
      limit: 10,
    }))
    expect(recovered).toBe(1)
    const stored = await Effect.runPromise(
      makeD1MessageStore(database).get({
        scope: stale.scope,
        messageId: stale.messageId,
      }),
    )
    expect(Option.getOrThrow(stored).message.state._tag)
      .toBe("DeliveryUnknown")

    const cleanupScope = ScopeSchema.make({
      namespace: NamespaceSchema.make(`cleanup-${suffix}`),
      environment: "test",
    })
    await env.EMAIL_DB.batch([
      env.EMAIL_DB.prepare(
        `INSERT INTO popcomputer_email_inbound_archive_intents (
           message_id, namespace, environment, raw_sha256, raw_ref, status,
           expires_at, attempt_count, next_attempt_at, lease_token,
           lease_expires_at, safe_error_code, created_at, updated_at
         ) VALUES (?, ?, 'test', ?, ?, 'pending', ?, 0, ?, NULL, NULL, NULL, ?, ?)`,
      ).bind(
        `intent-message-${suffix}`,
        cleanupScope.namespace,
        "a".repeat(64),
        `raw:intent:${suffix}`,
        currentEpoch - 10_000,
        currentEpoch - 10_000,
        currentEpoch - 20_000,
        currentEpoch - 20_000,
      ),
      env.EMAIL_DB.prepare(
        `INSERT INTO popcomputer_email_archive_deletions (
           id, namespace, environment, direction, message_id, raw_ref, status,
           attempt_count, next_attempt_at, lease_token, lease_expires_at,
           safe_error_code, created_at, updated_at
         ) VALUES (?, ?, 'test', 'outbound', ?, ?, 'pending', 0, ?, NULL, NULL,
                   NULL, ?, ?)`,
      ).bind(
        `deletion-${suffix}`,
        cleanupScope.namespace,
        `deletion-message-${suffix}`,
        `raw:deletion:${suffix}`,
        currentEpoch - 10_000,
        currentEpoch - 20_000,
        currentEpoch - 20_000,
      ),
    ])

    const listed = await Effect.runPromise(maintenance.listArchiveCleanup({
      now: DateTime.makeUnsafe(currentEpoch),
      limit: 10,
    }))
    expect(listed.map((item) => item._tag).sort()).toEqual([
      "Deletion",
      "InboundIntent",
    ])
    const item = listed[0]
    if (item === undefined) throw new Error("Expected a cleanup item")
    const leaseExpiresAt = DateTime.makeUnsafe(currentEpoch + 60_000)
    const claims = await Promise.all([
      Effect.runPromise(maintenance.claimArchiveCleanup({
        item,
        leaseToken: LeaseTokenSchema.make(`cleanup-${suffix}-left`),
        leaseExpiresAt,
      })),
      Effect.runPromise(maintenance.claimArchiveCleanup({
        item,
        leaseToken: LeaseTokenSchema.make(`cleanup-${suffix}-right`),
        leaseExpiresAt,
      })),
    ])
    expect(claims.filter(Option.isSome)).toHaveLength(1)
    const claimed = claims.find(Option.isSome)
    if (claimed === undefined) throw new Error("Expected one cleanup lease")
    await Effect.runPromise(maintenance.completeArchiveCleanup(claimed.value))

    const remaining = await Effect.runPromise(maintenance.listArchiveCleanup({
      now: DateTime.makeUnsafe(currentEpoch),
      limit: 10,
    }))
    expect(remaining).toHaveLength(1)
  })
})
