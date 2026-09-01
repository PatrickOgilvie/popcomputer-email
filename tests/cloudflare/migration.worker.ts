import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

describe("package D1 migration", () => {
  it("creates only package-owned tables", async () => {
    const result = await env.EMAIL_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'popcomputer_email_%' ORDER BY name",
    ).all<{ name: string }>()

    expect(result.results.map((row) => row.name)).toEqual([
      "popcomputer_email_archive_deletions",
      "popcomputer_email_cf_destinations",
      "popcomputer_email_cf_domain_bindings",
      "popcomputer_email_domains",
      "popcomputer_email_inbound_archive_intents",
      "popcomputer_email_inbound_dedupe_receipts",
      "popcomputer_email_messages",
      "popcomputer_email_outbound_archive_intents",
      "popcomputer_email_recipients",
      "popcomputer_email_routes",
      "popcomputer_email_test_recipient_adds",
      "popcomputer_email_test_recipient_grants",
      "popcomputer_email_test_recipient_refreshes",
      "popcomputer_email_workflow_events",
    ])
  })

  it("rolls back a failed D1 batch", async () => {
    const createdAt = Date.now()
    const insert = env.EMAIL_DB.prepare(
      "INSERT INTO popcomputer_email_domains (id, domain, kind, environment, inbound_status, outbound_status, created_at, updated_at) VALUES (?, ?, 'platform', 'test', 'active', 'active', ?, ?)",
    )

    await expect(
      env.EMAIL_DB.batch([
        insert.bind(
          "domain-rollback",
          "rollback.example.com",
          createdAt,
          createdAt,
        ),
        insert.bind(
          "domain-invalid",
          "invalid.example.com",
          createdAt,
          // A missing final binding makes the second statement fail and must
          // roll the first statement back as part of the same D1 batch.
        ),
      ]),
    ).rejects.toBeDefined()

    const row = await env.EMAIL_DB.prepare(
      "SELECT id FROM popcomputer_email_domains WHERE id = ?",
    )
      .bind("domain-rollback")
      .first()

    expect(row).toBeNull()
  })
})
