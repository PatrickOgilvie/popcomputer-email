# Effect Email Peer Review

## Verdict

At the pinned revisions reviewed below, `@popcomputer/email` is the strongest
of the inspected Effect-based projects for one specific boundary: durable,
programmatic email send and receive where workflow actions must survive retries
and inbound deliveries must become replay-safe workflow triggers.

That is not a claim that it is universally the best email library. Other
projects are broader or more mature at SMTP transport, JMAP mailbox access,
provider administration, React Email templates, IMAP interaction, and
broader cross-path telemetry privacy coverage. The comparative advantage is
ownership of both durability paths:

```txt
workflow action
  -> durable outbound reservation + request fingerprint
  -> compare-and-set provider handoff
  -> Accepted | PartiallyAccepted | Failed | DeliveryUnknown

provider delivery
  -> route resolution + bounded raw read + digest
  -> provider-identity or fixed-window digest replay lookup
  -> archive/cleanup intent
  -> atomic durable receipt claim
     + message + content-free workflow outbox event
  -> leased host workflow start with a stable idempotency key
  -> lazy content read and constrained reply action
```

No inspected peer combines those outbound and inbound guarantees in one
Effect-native package. The detailed package invariants remain authoritative in
the [technical specification](./tech-spec.md#invariants).

## Scope and Method

This review inspected manifests, implementation code, and tests rather than
relying only on README claims. A project is included only when the relevant
package declares Effect and its implementation imports Effect. All evidence
links are pinned to the reviewed commit so later upstream changes do not alter
the comparison.

The set is useful but not exhaustive. It covers the known Effect email
projects most relevant to sending, receiving, mailbox protocols, and workflow
integration as of 2026-09-01.

`honest-magic/mail-mcp` was checked but excluded: its
[manifest](https://github.com/honest-magic/mail-mcp/blob/3621ef92e96a1387dbff797c28d630259991b5a4/package.json)
does not depend on Effect. The Effect-based project with that name is
`davidvornholt/mail-mcp`, reviewed below.

## Comparison at a Glance

| Peer | Primary strength | Better than `@popcomputer/email` at | Why it is not a substitute for the target boundary |
| --- | --- | --- | --- |
| `effect-email` | Provider-neutral sending | Resend and SMTP breadth; broader telemetry privacy assertions | Its idempotency is provider- or Layer-local, and it has no receive/trigger path |
| `effect-jmap` | RFC 8621 mailbox client | Query/change sync, mailbox/thread state, scheduled submission and delivery status | It is a protocol client without persistent action or trigger orchestration |
| Blikka `@blikka/email` | Application email integration | React Email templates, batch send, carefully bounded Resend retries | Recovery is reimplemented in the consuming workflow and has no inbound trigger kernel |
| DSAR | Application-specific inbound/outbound adapters | Resend webhook verification, routing, diagnostics, and audit breadth | Its dedupe and notification writes are not atomic workflow handoff guarantees |
| `@siebix/resend-effect` | Typed Resend SDK | Provider management operations and response decoding | It wraps provider APIs; it does not own durable send/receive workflow state |
| `mail-mcp` | Human-in-the-loop IMAP tooling | Search/read/drafts, stable IMAP handles, cancellation and MCP contract tests | It explicitly does not send and has no pushed-delivery or durable workflow path |

## Peer Findings

### `effect-email`

Repository: [`EduSantosBrito/effect-email`](https://github.com/EduSantosBrito/effect-email/tree/62d109e8fcb747c8df4b1a2daa6fae0d9a9fcd9e)

Effect is verified by the
[`effect-email` manifest](https://github.com/EduSantosBrito/effect-email/blob/62d109e8fcb747c8df4b1a2daa6fae0d9a9fcd9e/packages/effect-email/package.json).
This is the strongest direct peer for a small outbound library.

What it does better:

- It already ships provider-neutral Resend and SMTP adapters, including Node
  and Cloudflare compatibility tests.
- Its test adapter scripts acceptance, rate limiting, failure before
  acceptance, permanent failure, and failure after possible acceptance. The
  [ambiguity and idempotency tests](https://github.com/EduSantosBrito/effect-email/blob/62d109e8fcb747c8df4b1a2daa6fae0d9a9fcd9e/packages/effect-email/src/test.test.ts#L57-L207)
  make provider behavior easy for consumers to simulate.
- Its [telemetry tests](https://github.com/EduSantosBrito/effect-email/blob/62d109e8fcb747c8df4b1a2daa6fae0d9a9fcd9e/packages/effect-email/src/index.test.ts#L271-L487)
  exhaustively assert that addresses, bodies, headers, attachments,
  idempotency keys, provider IDs, and secrets do not leak into spans.

Where `@popcomputer/email` is stronger:

- `effect-email` explicitly limits idempotency to provider behavior or the
  lifetime of its test Layer; its
  [README does not claim a persistent coordinator](https://github.com/EduSantosBrito/effect-email/blob/62d109e8fcb747c8df4b1a2daa6fae0d9a9fcd9e/packages/effect-email/README.md#L113-L147).
- It does not persist request fingerprints, compare-and-set handoff ownership,
  or workflow-visible `DeliveryUnknown` state across process restarts.
- It has no inbound archive, dedupe, workflow outbox, lazy content, or reply
  action.

The package has adopted `effect-email`'s negative outbound privacy pattern.
The remaining lessons are its adapter conformance discipline and broader
cross-path telemetry contract—not replacement of the durable application
kernel with its smaller sending API.

### `effect-jmap`

Repository: [`i11v/effect-jmap`](https://github.com/i11v/effect-jmap/tree/750fd85ea18cad7c19e4816b2d5480db79e39d59)

Effect v3 and `@effect/platform` are verified in its
[manifest](https://github.com/i11v/effect-jmap/blob/750fd85ea18cad7c19e4816b2d5480db79e39d59/package.json).

What it does better:

- It has a rich RFC 8621 surface: mailbox and email query/get/set/copy/import,
  change synchronization, identities, and submissions.
- Its [email schema](https://github.com/i11v/effect-jmap/blob/750fd85ea18cad7c19e4816b2d5480db79e39d59/src/email/schema.ts#L15-L165)
  models threads, message ancestry, body parts, body values, and attachment
  blobs in substantially more detail.
- Its [submission schema](https://github.com/i11v/effect-jmap/blob/750fd85ea18cad7c19e4816b2d5480db79e39d59/src/submission/schema.ts#L25-L118)
  supports scheduling, cancellation/undo, per-recipient delivery status, and
  DSN/MDN blobs.
- It includes a
  [real Stalwart functional harness](https://github.com/i11v/effect-jmap/blob/750fd85ea18cad7c19e4816b2d5480db79e39d59/tests/functional/mailbox.functional.test.ts).

Where `@popcomputer/email` is stronger:

- JMAP request success is not durable workflow progress. The client does not
  own a persistent application idempotency ledger, an ambiguous provider
  handoff state, inbound workflow publication, or workflow-start replay.
- `@popcomputer/email` tests the crash/retry boundary through application and
  storage seams. Some generated `effect-jmap`
  [spec tests](https://github.com/i11v/effect-jmap/blob/750fd85ea18cad7c19e4816b2d5480db79e39d59/tests/spec/email.spec.test.ts#L24-L83)
  only construct request/expected values and assert the expected object exists;
  they do not exercise the service.

Per-recipient delivery-state vocabulary is worth borrowing for future delivery
event reconciliation. Mailbox search, drafts, read state, and synchronization
remain a different product boundary.

### Blikka `@blikka/email`

Repository: [`strandhvilliam/blikka`](https://github.com/strandhvilliam/blikka/tree/71d770893f3a792cbf8a96e89f4e190becf5bec5)

Effect v4 beta is declared in the
[workspace manifest](https://github.com/strandhvilliam/blikka/blob/71d770893f3a792cbf8a96e89f4e190becf5bec5/package.json#L45-L75)
and consumed by the
[`@blikka/email` package](https://github.com/strandhvilliam/blikka/blob/71d770893f3a792cbf8a96e89f4e190becf5bec5/packages/email/package.json).

What it does better:

- The [email service](https://github.com/strandhvilliam/blikka/blob/71d770893f3a792cbf8a96e89f4e190becf5bec5/packages/email/src/service.ts#L14-L86)
  integrates React Email templates, batch sending, tag sanitization, and Resend
  idempotency keys with a small caller-facing API.
- It deliberately retries only Resend `429` responses. Network failures and
  `5xx` responses are treated as possibly accepted, with
  [tests covering the distinction](https://github.com/strandhvilliam/blikka/blob/71d770893f3a792cbf8a96e89f4e190becf5bec5/packages/email/src/service.test.ts#L129-L252).
- Its contact-sheet workflow contains a valuable production-shaped recovery
  example: persist the resource, send the notification, then persist the sent
  flag; redelivery recognizes a resource whose email flag is missing. See the
  [recovery branch](https://github.com/strandhvilliam/blikka/blob/71d770893f3a792cbf8a96e89f4e190becf5bec5/packages/uploads/src/contact-sheet-generator.ts#L248-L305)
  and [tests](https://github.com/strandhvilliam/blikka/blob/71d770893f3a792cbf8a96e89f4e190becf5bec5/packages/uploads/src/contact-sheet-generator.test.ts#L530-L608).

Where `@popcomputer/email` is stronger:

- Blikka has to reconstruct send recovery in each business workflow.
  `@popcomputer/email` centralizes the attempt fingerprint, transition guard,
  provider handoff, terminal replay, and ambiguous result.
- The application still has a crash window after provider acceptance and
  before the email flag is persisted; it relies on the provider key's retention
  period rather than a durable email state machine.
- It has no inbound delivery or trigger path.

Blikka is strong evidence that this package should remain a deep workflow
module. Optional template ergonomics can sit above that module without making
templates part of the durability contract.

### DSAR

Repository: [`inthhq/dsar`](https://github.com/inthhq/dsar/tree/364dfa23b9e39c1cc78fcc04b72d49061ca6afc1)

DSAR declares Effect v4 beta in its
[workspace catalog](https://github.com/inthhq/dsar/blob/364dfa23b9e39c1cc78fcc04b72d49061ca6afc1/package.json#L15-L24).
The relevant
[inbound Resend](https://github.com/inthhq/dsar/blob/364dfa23b9e39c1cc78fcc04b72d49061ca6afc1/packages/inbound-resend/package.json)
and
[outbound Resend](https://github.com/inthhq/dsar/blob/364dfa23b9e39c1cc78fcc04b72d49061ca6afc1/packages/outbound-resend/package.json)
packages import Effect, but are private, application-specific packages.

What it does better:

- Its inbound adapter owns Resend webhook signature verification and provider
  payload normalization. See the
  [adapter](https://github.com/inthhq/dsar/blob/364dfa23b9e39c1cc78fcc04b72d49061ca6afc1/packages/inbound-resend/src/adapter.ts)
  and [adapter tests](https://github.com/inthhq/dsar/blob/364dfa23b9e39c1cc78fcc04b72d49061ca6afc1/packages/inbound-resend/test/adapter.test.ts).
- It routes provider recipients into tenant/workspace/jurisdiction context and
  has broader adapter health, diagnostic, lifecycle, and audit concepts.
- Its outbound adapter has a useful stable provider-error catalog and persists
  delivery-attempt/audit records.

Where `@popcomputer/email` is stronger:

- DSAR's inbound path eagerly fetches content during webhook handling rather
  than committing a content-free trigger and resolving bounded content lazily.
- Lifecycle capture uses a
  [list-then-create idempotency check](https://github.com/inthhq/dsar/blob/364dfa23b9e39c1cc78fcc04b72d49061ca6afc1/packages/backend/src/lifecycle/service.ts#L64-L121)
  rather than an atomic unique claim.
- Notification dedupe similarly performs
  [find-then-append](https://github.com/inthhq/dsar/blob/364dfa23b9e39c1cc78fcc04b72d49061ca6afc1/packages/backend/src/services/notifications/service.ts#L289-L360),
  while the corresponding
  [database index is not unique](https://github.com/inthhq/dsar/blob/364dfa23b9e39c1cc78fcc04b72d49061ca6afc1/packages/internals/persistence/src/migrations/0001-initial.ts#L155-L230).
- Network and timeout failures are retryable without a distinct persisted state
  for "the provider may already have accepted this message."

Provider webhook verification, stable diagnostic categories, and adapter
health checks are useful lessons. DSAR's concurrency and ambiguity semantics
should not be copied.

### `@siebix/resend-effect`

Repository: [`siebix-studio/effect-reusables`](https://github.com/siebix-studio/effect-reusables/tree/402bf47a59d12f8d7da082a12d8aad1d7ab339cc)

Effect v4 beta is verified in the
[package manifest](https://github.com/siebix-studio/effect-reusables/blob/402bf47a59d12f8d7da082a12d8aad1d7ab339cc/packages/resend-effect/package.json).

What it does better:

- Its [email service](https://github.com/siebix-studio/effect-reusables/blob/402bf47a59d12f8d7da082a12d8aad1d7ab339cc/packages/resend-effect/src/emails.service.ts)
  covers send, get, list, update scheduled email, cancellation, and contacts.
- Its [tests](https://github.com/siebix-studio/effect-reusables/blob/402bf47a59d12f8d7da082a12d8aad1d7ab339cc/packages/resend-effect/tests/resend-effect.test.ts)
  exercise typed provider errors, malformed response decoding, configuration
  Layers, and isolation from caller payload mutation.

Where `@popcomputer/email` is stronger:

- `@siebix/resend-effect` is a typed provider SDK. It does not own persistence,
  action idempotency, ambiguous handoff, receive, archival, or triggers.
- Pulling get/list/update/cancel/contact operations into the portable email core
  would couple the workflow abstraction to Resend's management model.

If these operations become necessary, they belong in an optional Resend
adapter surface rather than `@popcomputer/email`'s core API.

### `mail-mcp`

Repository: [`davidvornholt/mail-mcp`](https://github.com/davidvornholt/mail-mcp/tree/dbf31c8bc9cd981a66163bd58033486009d5fb0f)

Effect v3.21 is verified in the
[`@mail-mcp/mail` manifest](https://github.com/davidvornholt/mail-mcp/blob/dbf31c8bc9cd981a66163bd58033486009d5fb0f/apps/mail/package.json)
and service imports. This is a private application, not a published library,
and its README explicitly says
[there is no send operation](https://github.com/davidvornholt/mail-mcp/blob/dbf31c8bc9cd981a66163bd58033486009d5fb0f/apps/mail/README.md).

What it does better:

- Multi-account IMAP search uses bounded concurrency, global dedupe/sort/limit,
  and partial failure results. The
  [service](https://github.com/davidvornholt/mail-mcp/blob/dbf31c8bc9cd981a66163bd58033486009d5fb0f/apps/mail/src/features/mail/services/account-search.ts#L47-L168)
  and [tests](https://github.com/davidvornholt/mail-mcp/blob/dbf31c8bc9cd981a66163bd58033486009d5fb0f/apps/mail/src/features/mail/services/account-search.test.ts#L15-L161)
  are particularly clear.
- Its cancellation tests model uninterruptible native IMAP work, deadline
  isolation, exact-once client retirement, and successful replacement clients.
  See the
  [deadline implementation](https://github.com/davidvornholt/mail-mcp/blob/dbf31c8bc9cd981a66163bd58033486009d5fb0f/apps/mail/src/features/mail/services/imap-client.ts#L77-L106)
  and [TestClock suite](https://github.com/davidvornholt/mail-mcp/blob/dbf31c8bc9cd981a66163bd58033486009d5fb0f/apps/mail/src/features/mail/services/imap-client-deadline.test.ts#L16-L141).
- Draft updates use generation-aware `{ account, folder, uid, uidValidity }`
  handles and append before delete. A failed delete preserves the new draft and
  reports its UID. See the
  [draft service](https://github.com/davidvornholt/mail-mcp/blob/dbf31c8bc9cd981a66163bd58033486009d5fb0f/apps/mail/src/features/mail/services/draft.ts#L134-L196)
  and [lifecycle tests](https://github.com/davidvornholt/mail-mcp/blob/dbf31c8bc9cd981a66163bd58033486009d5fb0f/apps/mail/src/features/mail/services/draft-lifecycle.test.ts#L26-L165).
- Attachment reads use stable MIME-part handles and both metadata and observed
  byte caps. Reply construction ignores remote HTML, escapes plain text, and
  preserves threading. Evidence:
  [attachment code](https://github.com/davidvornholt/mail-mcp/blob/dbf31c8bc9cd981a66163bd58033486009d5fb0f/apps/mail/src/features/mail/services/attachment.ts#L16-L148),
  [attachment tests](https://github.com/davidvornholt/mail-mcp/blob/dbf31c8bc9cd981a66163bd58033486009d5fb0f/apps/mail/src/features/mail/services/attachment.test.ts#L30-L168),
  and [reply tests](https://github.com/davidvornholt/mail-mcp/blob/dbf31c8bc9cd981a66163bd58033486009d5fb0f/apps/mail/src/features/mail/services/reply-quote.test.ts#L43-L137).
- Its subprocess
  [MCP contract test](https://github.com/davidvornholt/mail-mcp/blob/dbf31c8bc9cd981a66163bd58033486009d5fb0f/apps/mail/src/app/server.test.ts#L10-L115)
  asserts exact public tools, input schemas, safety annotations, and the promise
  never to claim a draft was sent.

Where `@popcomputer/email` is stronger:

- `mail-mcp` is intentionally human-in-the-loop draft and mailbox tooling. It
  does not send, receive pushed provider deliveries, persist inbound dedupe, or
  publish workflow triggers.
- It has no provider-handoff state, persistent action idempotency, raw archive
  cleanup protocol, or replay-safe workflow sink.
- Its broad suite uses fakes and a subprocess contract but does not include a
  representative live IMAP server harness.

The package has already adopted versioned attachment handles, metadata and
observed-byte caps, and safe reply provenance. The remaining transferable
lessons are exact-once resource-retirement tests and, if an agent adapter is
added later, tests for the exact public tool and safety-annotation contract.

## Why `@popcomputer/email` Is Better for the Workflow Boundary

The package's advantage is the combination, not any single API:

1. **Persistent outbound action identity.** A scoped key is bound to a
   canonical request fingerprint. A guarded `Reserved -> Sending` transition
   elects one provider-handoff owner, and replay returns or safely resumes the
   same logical message.
2. **Conservative ambiguity.** Cancellation, invalid provider results, and
   failures after possible handoff become `DeliveryUnknown`. Neither `Sending`
   nor `DeliveryUnknown` is automatically resent.
3. **Durable inbound capture.** Actual bytes are bounded and digested. A
   deterministic archive reference and cleanup intent cover the D1/R2 window,
   and stable provider delivery identity drives durable replay suppression.
   Without it, route + trusted-envelope-sender + raw digest is a clock-bounded
   fixed first-observation fallback that retries do not extend, so
   byte-identical later deliveries are not suppressed forever.
   Sender-controlled Message-ID values are never a dedupe authority. A losing
   archive candidate promotes its retained intent in place, so cleanup has one
   lease and one retry/dead-letter budget rather than competing queue records.
4. **Atomic trigger creation.** Message metadata and a content-free
   `email.received` event commit together. The event never contains MIME,
   bodies, attachments, or archive references.
5. **Replay-safe workflow delivery.** An exclusive expiring lease and stable
   host key cover workflow-start retries and ambiguous acknowledgements.
6. **Policy-composable action/trigger closure.** Workflow code lazily resolves
   bounded, integrity-checked content. Reply derives route, target, subject,
   and threading, rejects its own route before policy, then runs a
   host-supplied `ReplyPolicy`. The default rejects automatic/list sources and
   active Trigger targets; hosts may replace those checks without replacing
   durable send semantics. Successful replies remain classified `auto_reply`
   and carry response-suppression headers.
7. **Representative evidence.** The
   [vertical workflow test](../tests/unit/application/email-workflow-vertical.test.ts)
   combines inbound dedupe, lost workflow acknowledgement, lazy content, and a
   replayed reply action. The
   [workerd D1 test](../tests/cloudflare/route-inbound-workflow.worker.ts)
   verifies atomic dedupe and exclusive event leasing, while the
   [R2 test](../tests/cloudflare/r2-archive.worker.ts) verifies exact streaming,
   idempotent storage, conflict rejection, and digest checking.

This is the behavior application teams otherwise reconstruct imperfectly with
provider idempotency keys, queue retries, sent flags, and ad hoc dedupe tables.

## Lessons Already Adopted

- **Ambiguity is a state, not a generic retry.** The package takes the strongest
  part of `effect-email` and Blikka's retry reasoning further by persisting the
  result and refusing an unsafe automatic resend.
- **Adapters are real seams.** Production transports/archives/stores and
  recording or scripted test Layers implement the same narrow Effect service
  contracts.
- **Content is not a trigger payload.** Inbound events carry stable metadata;
  bodies and attachments are fetched only when workflow logic needs them.
- **Limits apply to observed data.** Raw MIME and archived content are bounded
  while read, not trusted from provider metadata alone. Integrity is verified
  before MIME projection.
- **Replies are constrained, policy-composable actions.** Callers provide
  response content, while the package derives routing and threading, enforces
  its non-overridable self-target guard, and lets a host replace the
  conservative automation/Trigger policy.
- **Telemetry privacy is tested negatively.** The outbound suite captures
  Effect spans, events, and logs for successful and rejected sends and proves
  that addresses, bodies, headers, attachment data, actor/scope values, and
  idempotency keys are absent. See the
  [privacy regression](../tests/unit/application/email-service.test.ts#L898).
- **Runtime behavior needs runtime tests.** D1 and R2 claims are exercised in
  workerd rather than inferred only from in-memory fakes.

## Remaining Gaps

Before or alongside a public release, the highest-value improvements are:

1. Extend the existing `effect-email`-inspired negative telemetry regression
   across inbound capture, workflow dispatch, and concrete provider adapters,
   including raw references, provider identifiers, and credentials. Add a
   positive low-cardinality allow-list for span names, attribute keys, and
   attribute values as well as the current forbidden-value assertions.
2. Run every production send adapter through one scripted conformance suite:
   accepted, definite rejection, rate limit, failure before handoff, ambiguous
   failure after possible handoff, malformed response, cancellation, and
   replay.
3. Add interruption/resource-lifecycle tests around provider streams and
   scoped resources, borrowing `mail-mcp`'s TestClock and exact-once retirement
   discipline.
4. Define provider webhook signature and payload contract tests for each
   hosted inbound integration. Signature verification remains at the provider
   adapter boundary.
5. Add safe adapter health/diagnostic summaries without exposing provider
   payloads or secrets.

Potential later capabilities, intentionally separate from the v0.1 core, are:

- optional Resend and SMTP adapters;
- provider delivery-event reconciliation for delivered, delayed, bounced,
  complained, and failed recipients, without claiming inbox delivery;
- optional React Email/template helpers and batch orchestration;
- provider-specific scheduled-send lifecycle APIs when a real workflow use
  case requires them.

## Non-Goals Preserved

Peer breadth should not pull the package away from its durable workflow role.
The following remain outside the portable core unless the product goal changes:

- mailbox search, folder synchronization, read state, threads, drafts, and a
  mailbox UI (`effect-jmap`, `mail-mcp`);
- contacts and general provider-account administration
  (`@siebix/resend-effect`);
- workflow definition lookup, business-action choice, or workflow execution;
- arbitrary provider abstraction in v0.1;
- exactly-once claims across a database, object store, provider, and host
  workflow runtime;
- trusting provider acceptance as proof of inbox delivery.

The open-source positioning should therefore be precise: this is an
Effect-native email action-and-trigger kernel for durable workflows, with
portable contracts and explicit adapters—not a universal email client.
