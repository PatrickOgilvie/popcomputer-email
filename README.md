# `@popcomputer/email`

Effect-native email sending, receiving, routing, and workflow triggers for
Node.js and Cloudflare Workers.

`@popcomputer/email` provides a portable domain and application layer, a
runtime-validated hosted-service protocol and client, and focused adapters for
Cloudflare Email Sending, Email Routing, D1, and R2. It is designed to compose
with the other `@popcomputer` packages through Effect services and Layers
without introducing a shared framework package.

## Status

The package is under active development. The initial public API targets
Effect `4.0.0-rc.116`, Node.js 22 or newer, and Cloudflare Workers.

## Install

```sh
bun add @popcomputer/email effect
```

## What the package owns

- Strict email addresses, scopes, actors, identifiers, commands, and states.
- Outbound MIME rendering and idempotent send orchestration.
- Inbound MIME ingestion, bounded parsing, deduplication, and raw preservation.
- Integrity-checked, lazy Email Content and versioned attachment reads.
- Constrained, idempotent replies with derived addressing and RFC threading.
- Independently configurable inbound (`Store` / `Trigger`) and outbound
  (`Disabled` / `Sender`) route capabilities.
- Test-recipient grants.
- A durable workflow-event outbox with leases and retry policy.
- A typed HTTP protocol and Effect client.
- D1, R2, Cloudflare Email Sending, and Email Routing adapters.
- In-memory, deterministic, and recording adapters for tests.

The host application continues to own authentication, authorization, API-key
issuance, workspace membership, UI, HTTP framework integration, scheduling,
and workflow execution.

## Public modules

The package root exposes cohesive namespace modules:

```ts
import {
  Address,
  Email,
  Identifiers,
  Inbound,
  Maintenance,
  Message,
  Route,
  Scope,
  TestRecipient,
  Workflow,
} from "@popcomputer/email"
```

Infrastructure and protocol concerns use explicit entry points:

| Import | Purpose |
| --- | --- |
| `@popcomputer/email` | Domain schemas and application services |
| `@popcomputer/email/adapter` | Ports for storage, transport, archive, destinations, and workflows |
| `@popcomputer/email/client` | Hosted-service Effect client |
| `@popcomputer/email/protocol` | HTTP DTO schemas, operation contract, and error envelopes |
| `@popcomputer/email/cloudflare` | Cloudflare send, R2, destination, and inbound adapters |
| `@popcomputer/email/d1` | Structural D1 contract and persistence Layers |
| `@popcomputer/email/d1/schema` | Drizzle declarations for package-owned tables |
| `@popcomputer/email/testing` | In-memory and recording test Layers |

Importing the root does not load Drizzle or Cloudflare runtime code.

## Effect-first services

Dependencies are Effect services. Applications install Layers at their
composition root and business code yields the service it needs:

```ts
import { Effect } from "effect"
import { Email } from "@popcomputer/email"

const program = Effect.gen(function* () {
  const email = yield* Email.Service

  const details = yield* email.send(command)
  return details
})
```

`send` returns the persisted message together with recipient delivery state, so
a hosted adapter can pass it directly to `Protocol.projectMessageEnvelope`.
Raw archive metadata is never part of that result.

Boundary input must be decoded with the exported Effect Schemas before it
reaches the service. Expected failures remain in the Effect error channel.
Cloudflare bindings, D1 rows, provider JSON, and HTTP responses are parsed in
their owning adapters.

Portable production generators are included for Node and Workers:

```ts
import * as Adapter from "@popcomputer/email/adapter"

const identityLayer = Adapter.webCryptoIdentity
```

The Layer provides cryptographically random message, recipient, route, event,
lease, test-recipient, and generated mailbox identifiers. Deterministic
variants remain isolated under `@popcomputer/email/testing`.

## Scope and host integration

Every durable operation is scoped by:

```ts
interface Scope {
  readonly namespace: string
  readonly environment: "test" | "live"
}
```

`namespace` is deliberately host-neutral. A Popcomputer application can map a
workspace ID to it after authorization, while another host may use a tenant or
project ID. Actors are opaque audit identities; this package never queries a
host's user or workspace tables.

Hosted client credentials bind the namespace and environment. Remote client
commands cannot override them.

## Outbound delivery semantics

Every send requires an idempotency key. The package stores a fingerprint of
the parsed command with that key:

- Message-size and envelope-recipient limits are enforced before persistence
  and provider handoff.
- Test-environment sends require every To, Cc, and Bcc recipient to have a
  verified grant in the same namespace; live sends are not allow-list gated.
- The same scoped key and fingerprint returns or safely resumes the existing
  message.
- The same scoped key with a different fingerprint fails with a typed
  `IdempotencyConflict`.
- A compare-and-set claim permits at most one automatic provider handoff.
- A timeout, cancellation, network failure, invalid provider result, or crash
  after handoff becomes `DeliveryUnknown`.
- `Sending` and `DeliveryUnknown` messages are never automatically resent.

Workflow-generated sends set `automation: "auto_generated"`; the MIME renderer
then emits `Auto-Submitted: auto-generated` and response-suppression headers.
The reply action derives the distinct `auto_reply` classification itself.

Before outbound MIME is written, the package derives its deterministic archive
reference and records a delayed cleanup intent in D1. Attaching that reference
to the reserved message and deleting the intent is one D1 batch. A failed or
uncommitted attachment therefore leaves durable cleanup work; a committed but
ambiguous attachment is reconciled from the message row. Same-key replay can
safely renew the intent and resume before provider handoff.

The package cannot promise exactly-once external delivery because no
transaction spans D1, R2, and the Cloudflare sending API. Its contract is
instead concurrency-safe, conservative, and explicit about ambiguity.

## Inbound email

The Cloudflare adapter converts a `ForwardableEmailMessage` at the Worker
boundary and awaits durable ingestion. Ingestion resolves the route, reads the
raw stream through an actual byte limit, parses MIME, computes a digest,
archives the raw message, and atomically commits metadata, recipients, and an
optional workflow event in D1.

A provider adapter may supply a stable `(provider, deliveryId)` identity, which
remains authoritative for retries of that delivery. Without one, the package
falls back to route, trusted envelope sender, and raw SHA-256 for a fixed
first-observation window (24 hours by default). The Effect clock—not optional
provider timestamp metadata—drives that window, and retries do not extend it.
The sender-controlled RFC Message-ID remains advisory only.

D1 atomically selects the receipt owner with message, recipient, and optional
workflow-event creation. A deterministic archive reference is written into a
D1 cleanup intent before R2 I/O. If a concurrent dedupe winner is known, the
loser's intent remains durable until immediate removal is proven or the work is
promoted in place to cleanup. That promotion preserves one leaseable job, one
attempt counter, and one dead-letter budget. If the D1 commit result is
indeterminate, an owning commit has linked the object and consumed its intent
atomically; a losing or uncommitted candidate retains the intent and object for
leased maintenance after expiry.

## Programmatic content and replies

Workflow events stay small: they identify the message but never carry its body,
HTML, attachments, or raw archive reference. Authorized workflow code resolves
typed Email Content by message ID only when it needs it:

```ts
const content = yield* email.getReceivedContent({
  scope,
  messageId: event.message.id,
})

const reply = yield* email.reply({
  scope,
  actor,
  idempotencyKey: actionKey,
  sourceMessageId: event.message.id,
  body: Email.BodySchema.cases.Text.make({ text: "We are on it." }),
  headers: [],
  attachments: [],
})
```

Content reads enforce archive size and digest integrity before bounded MIME
parsing. They distinguish the trusted provider envelope sender from untrusted
Header From and Reply-To values, drop malformed optional MIME metadata, and
project normalized automatic-message signals. HTML remains untrusted input.

Reply is intentionally narrower than send: callers cannot choose its sender,
recipient, subject, or threading. The package derives them from the immutable
inbound message, then reuses the ordinary outbound policy, archive,
compare-and-set handoff, and `DeliveryUnknown` semantics. A completed
same-key reply replay does not need the retained source MIME. Before reserving
an outbound attempt, reply always rejects its own receiving route.
`Email.layer` and `Email.replyEmail` also install a conservative `ReplyPolicy`
that rejects automatic/list sources and any other active `Trigger` route. A
host with stronger sender-authentication evidence can deliberately replace
those overridable checks through `Email.layerWithReplyPolicy` or
`Email.replyEmailWithPolicy`; the package-owned self-target check remains
non-overridable. Successful replies carry `Auto-Submitted: auto-replied` and
`X-Auto-Response-Suppress: All`.

## Test recipients

Cloudflare destination addresses are account-global, but package grants are
namespace-local. Creation reconciles a provider-side duplicate before writing
the local destination mirror and grant atomically. Every add key is claimed by
a recoverable D1 lease before provider I/O and completed with an immutable
result snapshot. A concurrent matching request gets typed
`TestRecipientAddInProgress`; a different payload gets `IdempotencyConflict`
without reaching the provider. Refresh uses a separate immutable idempotency
ledger: replaying an older key returns its recorded outcome, a verified grant
is never downgraded, and a failed grant restarts through the legal `Pending`
transition.

## Workflow triggers

Routes with the inbound `Trigger` capability write a versioned `email.received`
event to a durable outbox in the same D1 transaction as the inbound message.
The outbound capability is independent, so that same address may also be a
`Sender` for workflow replies. The host supplies a
`WorkflowTriggerSink` and calls `dispatchReady` through `Workflow.Service` from
scheduled work. The inbound handler only commits the outbox event; delivery to
the host workflow runtime is always a separate, leased operation.

The event contains scoped message metadata. It does not contain raw MIME,
message bodies, headers, attachments, archive references, application URLs, or
Popcomputer-specific workflow types.

The host sink must deduplicate workflow starts by the supplied stable key.
Definite and ambiguous start failures are retried with that same key;
permanent configuration, authorization, workflow, and key-conflict failures
dead-letter immediately.

Caller-configured dedupe, retention, lease, stale-work, and retry durations use
one shared operational-duration schema. Values must be positive millisecond
integers no greater than 100 leap-length years, which keeps ordinary deadline
arithmetic and serialization inside the supported JavaScript date range.

## D1 and R2

Package-owned D1 migrations ship under `migrations/d1`. The D1 adapter accepts
a narrow structural database contract so consuming applications do not expose
their complete Worker environment to the application layer.

After applying the migration, the host must seed at least one active platform
domain for each enabled environment: `kind = 'platform'`, with both
`inbound_status` and `outbound_status` set to `active`. Domain onboarding and
Cloudflare DNS rule creation remain host/deployment responsibilities. There is
no provisioning API in this package; `popcomputer_email_cf_domain_bindings` is
a persistence declaration for host-managed setup. Without an active row,
route provisioning fails with `PlatformDomainUnavailable(not_configured)`.

The aggregate D1 Layer accepts
`{ database, providerAccountKey, policy? }`. `providerAccountKey` must be a
non-empty, stable provider-account identity, not an API token. For the
Cloudflare adapters, use the same account ID supplied to the REST adapter
config. The focused `D1.d1MessageStore({ database })` Layer does not need it.

The migration directory is an explicit package export, so deployment tooling
can resolve it without relying on an internal package path:

```ts
const migration = import.meta.resolve(
  "@popcomputer/email/migrations/d1/0001_email.sql",
)
```

The optional Drizzle declarations live separately:

```ts
import * as EmailSchema from "@popcomputer/email/d1/schema"
```

They are query-oriented declarations, not a migration-generation source. The
shipped SQL is authoritative for `CHECK` constraints, partial indexes, and
lease/idempotency invariants; do not generate a replacement migration from the
Drizzle entry point.

Raw MIME is represented by an opaque reference in persistence and by a Web
`ReadableStream<Uint8Array>` at the service boundary. R2 object keys and
`R2ObjectBody` values are private to the Cloudflare adapter.

One production composition root can wire all package services without a shared
application framework:

```ts
import { Layer } from "effect"
import { Email, Inbound, Maintenance, Route, TestRecipient, Workflow } from "@popcomputer/email"
import * as Adapter from "@popcomputer/email/adapter"
import * as Cloudflare from "@popcomputer/email/cloudflare"
import * as D1 from "@popcomputer/email/d1"

const database = D1.fromCloudflareD1(env.EMAIL_DB)
const infrastructure = Layer.mergeAll(
  D1.d1Layer({
    database,
    providerAccountKey: cloudflareConfig.accountId,
  }),
  Adapter.layerWebCrypto,
  Adapter.webCryptoIdentity,
  Cloudflare.r2RawMessageArchiveLayer(env.EMAIL_RAW),
  Cloudflare.cloudflareSendTransportLayer(cloudflareConfig),
  Cloudflare.cloudflareDestinationRegistryLayer(cloudflareConfig),
  workflowTriggerSinkLayer,
)

export const emailLayer = Layer.mergeAll(
  Email.layer,
  Inbound.layer(),
  Route.layer,
  Workflow.layer(),
  TestRecipient.layer,
  Maintenance.layer(),
).pipe(Layer.provide(infrastructure))
```

Here `env`, `cloudflareConfig`, and `workflowTriggerSinkLayer` are supplied by
the host. The host also owns authenticated scope construction, HTTP routing,
scheduling calls through `Workflow.Service` and `Maintenance.Service`, and
deployment of the shipped migration. No umbrella live Layer is exported: the
explicit composition keeps provider, persistence, and host workflow choices at
the application boundary. `D1.d1Layer` provides ports, not application
services.

## Testing adapters

`@popcomputer/email/testing` provides deterministic identifiers, in-memory
stores, a recording transport, and recording/scripted workflow fakes through
the same Effect service seams used in production. These adapters are for
behavior tests; SQL,
transaction, R2, and Worker claims are separately verified inside workerd with
real D1 migrations and bindings.

Tests do not require module mocks or method spies.

## Privacy and observability

Email content is sensitive. Typed failures and safe diagnostic fields never
include addresses, route addresses, subjects, bodies, HTML, MIME, headers,
filenames, attachment contents, RFC Message-ID values, credentials,
authorization headers, idempotency keys, provider bodies, or workflow
payloads. Authorized resource DTOs necessarily contain addresses and subjects;
hosts must not copy those DTOs into logs or telemetry.

Safe diagnostics are limited to operation, environment, direction, route
capabilities, internal correlation IDs, counts, byte sizes, state, typed error tags,
provider status/code, and workflow attempts.

## Development

```sh
bun install
bun run verify
```

The verification gate performs architecture checks, strict TypeScript checks,
unit tests, real Cloudflare D1/R2 tests, built-package type tests, a Node.js ESM
smoke test, and an offline package dry run.

Important individual commands:

```sh
bun run check
bun test
bun run test:cloudflare
bun run test:package
```

## Non-goals

The initial package does not implement an SMTP server/client, email UI,
authentication, API-key management, arbitrary provider integrations, custom
domain onboarding, delivery analytics, threads, drafts, read state, or
workflow execution.

## License

MIT © Patrick Ogilvie
