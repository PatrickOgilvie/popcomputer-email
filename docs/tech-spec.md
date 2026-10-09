# `@popcomputer/email` Technical Specification

## Summary

Extract Popcomputer's email capability into an open-source, Effect-native
package that can send, receive, route, archive, and dispatch email-triggered
workflow events without depending on the Popcomputer application, Honertia, or
another `@popcomputer` package.

The package owns email domain rules and orchestration. A host owns identity,
authorization, workspace membership, HTTP routing, scheduling, workflow
execution, UI, and the mapping from its tenant vocabulary to the package's
opaque `Scope`.

The recommended package is `@popcomputer/email`, with a portable root and
explicit `./adapter`, `./client`, `./protocol`, `./cloudflare`, `./d1`,
`./d1/schema`, and `./testing` entry points. It is designed to sit alongside the
other four `@popcomputer` packages without creating a common-core package or a
dependency cycle.

## Context / Current State

The original implementation is in `popcomputer/apps/web/src/email`. Its useful
domain behavior is mixed with application-owned types and infrastructure:

- workspace and user vocabulary;
- Honertia services and bindings;
- the application's Drizzle database and migrations;
- Cloudflare D1, R2, Email Routing, and Email Sending response types;
- application workflow runtime handles;
- HTTP actions and UI projections.

That implementation proves the capability, but publishing it directly would
make every consumer adopt the Popcomputer web application's runtime and release
cycle. Its migrations also cannot safely reference host-owned workspace or user
tables in a reusable package.

The package callers are:

- a local Effect application composing the domain services with adapters;
- a Cloudflare Worker receiving email and using D1/R2;
- a hosted SDK consumer using only `./client` and `./protocol`;
- another `@popcomputer` package that receives an email-derived event through a
  host composition seam, not a package dependency.

## Goals

- Preserve strict addresses, scoped routes, message states, recipient states,
  test-recipient grants, and workflow-event states as Effect Schemas.
- Provide concurrency-safe, idempotent outbound send orchestration.
- Await inbound archival and metadata persistence before accepting delivery.
- Preserve raw MIME behind an opaque archive reference and Web stream.
- Project bounded, integrity-checked Email Content lazily by message ID.
- Provide a constrained Reply Action with package-derived addressing and
  threading.
- Atomically persist inbound metadata and an optional workflow outbox event.
- Expose narrow Effect service ports for infrastructure.
- Ship D1 migrations and adapters plus Cloudflare R2, sending, destination, and
  inbound-handler adapters.
- Ship a strict versioned HTTP contract, generated OpenAPI, and hosted Effect
  client.
- Ship deterministic in-memory/recording adapters for consumer behavior tests.
- Keep secrets and email content out of typed diagnostics and telemetry.

## Non-Goals

- Authentication, API-key issuance, permissions, or workspace membership.
- A web framework, HTTP server/router, UI, mailbox reading experience, drafts,
  threads, or read state.
- Workflow definition lookup or workflow execution.
- An SMTP server/client or arbitrary mail-provider abstraction in v0.1.
- Custom-domain onboarding, delivery analytics, or retention policy selection.
- Exactly-once delivery across D1, R2, and an external email provider.
- Direct dependencies on another `@popcomputer` package.

## Invariants

1. Every durable operation is isolated by `{ namespace, environment }`.
2. Host user/workspace records never appear as package foreign keys.
3. Every route has independent inbound and outbound capabilities; lifecycle
   gates both without changing either capability.
4. Disabled routes continue reserving their address.
5. Outbound size and recipient-count limits apply in every environment; test
   sends additionally require every envelope recipient to have a verified,
   scope-local grant.
6. A scoped outbound idempotency key stores a canonical request fingerprint.
7. Replaying a key with a different fingerprint fails.
8. `Reserved -> Sending` is a compare-and-set transition.
9. Only the winner of that transition may perform provider handoff.
10. `Sending` and `DeliveryUnknown` are never automatically resent.
11. Cancellation or an ambiguous failure after handoff becomes
   `DeliveryUnknown`.
12. The Bcc header is absent from rendered MIME; Bcc remains SMTP-envelope data.
13. Inbound byte limits apply to bytes actually read, not only provider claims.
14. Persisted inbound `from` is the provider envelope sender; Header From and
    Reply-To remain untrusted MIME content.
15. A stable provider delivery ID is the durable inbound replay authority when
    supplied. Otherwise route, trusted envelope sender, and raw digest suppress
    duplicates only for a fixed first-observation window driven by the Effect
    clock. Sender-controlled RFC Message-ID is advisory metadata and never
    suppresses a distinct delivery.
16. Raw MIME is archived only after a deterministic reference and durable
    cleanup intent cover the D1/R2 failure window. For the receipt owner, the
    metadata association and intent deletion commit atomically; a concurrent
    loser retains its intent until object removal is proven or promotes that
    same intent in place to durable cleanup, preserving one retry/dead-letter
    budget.
17. An inbound workflow message and its `email.received` outbox event commit in
    one D1 batch.
18. Trigger events never contain bodies, HTML, attachments, or raw references;
    workflows resolve bounded Email Content by message ID.
19. Workflow dispatch requires an exclusive expiring lease and a stable host
    idempotency key whose sink guarantees same-key host-run deduplication.
20. Reply derives route, recipient, subject, and threading from one scoped
    inbound message; its fingerprint covers the source and caller-owned content.
    Its own-route guard is non-overridable. The conservative `ReplyPolicy`
    rejects automatic/list sources and other active Trigger targets before
    outbound reservation; hosts may explicitly replace that policy, and
    successful replies are always marked automatic.
21. Every test-recipient add key is leased before provider I/O and completed
    with an immutable result; every refresh key retains its fingerprint and
    historical result. Replays happen before provider I/O, and a verified grant
    never downgrades.
22. The root entry point loads neither Drizzle nor Cloudflare runtime code.
23. Expected failures remain in the Effect error channel.
24. Public DTOs exclude scope namespace, actor, idempotency key, request
    fingerprint, RFC Message-ID, raw reference, and workflow payload content.

## Design Constraints

- TypeScript, ESM, strict compiler options, Node.js 22+, and Web platform
  streams/crypto.
- Effect `^4.0.0` (stable; verified against `4.0.2`) for schemas, services,
  layers, time, schedules, and typed errors.
- Cloudflare Workers for the first production adapter set.
- D1 cannot transact with R2 or an HTTP provider.
- Applying the package migration does not onboard a domain: the deployment
  must seed an active platform-domain row for each enabled environment.
- The D1 destination mirror is keyed by a stable provider account identity;
  Cloudflare hosts pass the same account ID to `D1.d1Layer` and the REST
  adapters.
- The host must be able to use only the protocol/client without loading Worker
  or Drizzle modules.
- Cloudflare bindings must be adapted at the infrastructure edge; application
  services do not accept a complete Worker environment.
- Package logs and errors use safe classifications, never message content or
  credentials.
- Public dedupe, retention, lease, stale-work, and retry durations are positive
  millisecond integers capped at 100 leap-length years, keeping contemporary
  deadline arithmetic and serialization inside ECMAScript's date range.

## Alternatives Considered

The code-and-test-level comparison behind these options is documented in the
[Effect email peer review](./peer-review.md).

### Option 1: Hosted SDK only

Expose only request/response DTOs and an HTTP client.

```ts
interface EmailClient {
  send(input: SendEmailRequest, key: IdempotencyKey): Effect.Effect<EmailMessage, ClientError>
}
```

This is easiest to publish but discards the reusable state machines,
orchestration, test seams, and local Worker use case. Every host would recreate
the hardest idempotency and cross-store logic.

### Option 2: Cloudflare application package

Publish the existing service around D1, R2, bindings, and application workflow
types.

```ts
interface EmailService {
  send(env: Bindings, db: AppDatabase, workspaceId: string, input: unknown): Promise<Response>
}
```

This minimizes extraction work but leaks host and runtime ownership into every
caller. It also prevents lightweight browser/Node SDK usage and couples the
other `@popcomputer` packages to Popcomputer's app schema.

### Option 3: Portable Effect core with explicit adapters

```ts
class EmailService extends Context.Service<EmailService, {
  readonly send: (command: SendCommand) => Effect.Effect<MessageDetails, SendError>
}>()("@popcomputer/email/EmailService") {}
```

Cloudflare, D1, hosted protocol, client, and testing implementations are
separate subpaths. This adds seams, but each seam corresponds to a real runtime,
storage, host, or nondeterminism boundary. It preserves local composition and a
small hosted-client surface.

## Recommendation

Use Option 3. Keep the domain and application layers runtime-neutral, and make
the first concrete infrastructure implementation Cloudflare-focused. Do not
create `@popcomputer/core`: packages interoperate through host-provided Effect
services and versioned DTOs/events.

Package boundary:

```txt
@popcomputer/email (domain + application namespaces)
  <- host Scope / Actor after authorization
  -> adapter ports
       -> @popcomputer/email/d1
       -> @popcomputer/email/cloudflare
       -> @popcomputer/email/testing

hosted HTTP adapter (owned by host)
  <- @popcomputer/email/protocol
  -> application services

remote consumer
  -> @popcomputer/email/client
  -> hosted HTTP adapter
```

## Proposed Design

The root exports namespaces only:

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

Infrastructure is opt-in:

```ts
import * as Adapter from "@popcomputer/email/adapter"
import * as Client from "@popcomputer/email/client"
import * as Protocol from "@popcomputer/email/protocol"
import * as Cloudflare from "@popcomputer/email/cloudflare"
import * as D1 from "@popcomputer/email/d1"
import * as Testing from "@popcomputer/email/testing"
```

A Cloudflare host composes the package at one Effect boundary:

```ts
import { Layer } from "effect"

const infrastructure = Layer.mergeAll(
  D1.d1Layer({
    database: D1.fromCloudflareD1(env.EMAIL_DB),
    providerAccountKey: cloudflareConfig.accountId,
  }),
  Adapter.layerWebCrypto,
  Adapter.webCryptoIdentity,
  Cloudflare.r2RawMessageArchiveLayer(env.EMAIL_RAW),
  Cloudflare.cloudflareSendTransportLayer(cloudflareConfig),
  Cloudflare.cloudflareDestinationRegistryLayer(cloudflareConfig),
  workflowTriggerSinkLayer,
)

const services = Layer.mergeAll(
  Email.layer,
  Inbound.layer(),
  Route.layer,
  Workflow.layer(),
  TestRecipient.layer,
  Maintenance.layer(),
).pipe(Layer.provide(infrastructure))
```

The host owns `env`, redacted Cloudflare configuration, the workflow sink,
authenticated scope/actor construction, HTTP routing, scheduled dispatch and
maintenance calls, migration deployment, and platform-domain seeding. No
umbrella live Layer is exported: `D1.d1Layer` provides infrastructure ports,
not application services, and the host keeps provider/runtime choices at its
composition root.

## Domain Model and Types

### Scope and actor

```ts
type Environment = "test" | "live"
type Namespace = string & Brand<"EmailNamespace">

interface Scope {
  readonly namespace: Namespace
  readonly environment: Environment
}

type Actor =
  | { readonly _tag: "User"; readonly id: ActorId }
  | { readonly _tag: "Credential"; readonly id: ActorId }
  | { readonly _tag: "System"; readonly id: ActorId }
```

The host constructs `Scope` and `Actor` only after authorization. Remote request
bodies cannot override credential-bound scope.

### Routes

```ts
type InboundCapability =
  | { readonly _tag: "Store" }
    | {
        readonly _tag: "Trigger"
        readonly workflowId: WorkflowId
      }

type OutboundCapability =
  | { readonly _tag: "Disabled" }
  | {
      readonly _tag: "Sender"
      readonly role: "default" | "alternate"
    }

interface Route {
  readonly id: RouteId
  readonly scope: Scope
  readonly address: EmailAddress
  readonly mailboxHandle: MailboxHandle
  readonly inbound: InboundCapability
  readonly outbound: OutboundCapability
  readonly lifecycle: RouteLifecycle
  readonly revision: RouteRevision
  readonly actor: Actor
  readonly createdAt: DateTime.Utc
  readonly updatedAt: DateTime.Utc
}

type RouteLifecycle =
  | { readonly _tag: "Active" }
  | { readonly _tag: "Paused"; readonly pausedAt: DateTime.Utc }
  | { readonly _tag: "Disabled"; readonly disabledAt: DateTime.Utc }
```

Legal transitions increment `revision`:

```txt
Active -> Paused -> Active
Active | Paused -> Disabled (terminal)
Active | Paused -> Disabled + Active replacement (atomic rotation)
```

### Outbound messages

```ts
interface SendCommand {
  readonly scope: Scope
  readonly actor: Actor
  readonly idempotencyKey: IdempotencyKey
  readonly from: { _tag: "DefaultRoute" } | { _tag: "Route"; routeId: RouteId }
  readonly to: readonly [EmailAddress, ...EmailAddress[]]
  readonly cc: readonly EmailAddress[]
  readonly bcc: readonly EmailAddress[]
  readonly subject: string
  readonly body: EmptyBody | TextBody | HtmlBody | MultipartBody
  readonly headers: readonly CustomHeader[]
  readonly attachments: readonly Attachment[]
  readonly automation?: "auto_generated" | "auto_reply"
}

// Workflow-generated sends use auto_generated. Reply derives auto_reply.

type OutboundState =
  | { readonly _tag: "Reserved" }
  | { readonly _tag: "Sending"; readonly claimedAt: DateTime.Utc }
  | { readonly _tag: "Captured"; readonly capturedAt: DateTime.Utc }
  | {
      readonly _tag: "Accepted"
      readonly sentAt: DateTime.Utc
      readonly providerMessageId?: ProviderMessageId
    }
  | {
      readonly _tag: "PartiallyAccepted"
      readonly sentAt: DateTime.Utc
      readonly providerMessageId?: ProviderMessageId
      readonly outcomes: PartialRecipientOutcomes
    }
  | {
      readonly _tag: "DeliveryUnknown"
      readonly occurredAt: DateTime.Utc
      readonly reason: AmbiguousReason
    }
  | {
      readonly _tag: "Failed"
      readonly failedAt: DateTime.Utc
      readonly reason: DefinitiveFailureReason
    }
```

### Inbound messages and raw MIME

```ts
interface InboundEnvelope {
  readonly from: EmailAddress
  readonly to: EmailAddress
  readonly raw: ReadableStream<Uint8Array>
  readonly providerDelivery?: {
    readonly provider: InboundProviderName
    readonly deliveryId: InboundProviderDeliveryId
  }
  readonly claimedSizeBytes?: number
  readonly receivedAt?: DateTime.Utc
}

interface InboundConfig {
  readonly maxBytes: number
  readonly digestDedupeWindowMilliseconds: number
  readonly archiveIntentTtlMilliseconds: number
  readonly cleanupRetryMilliseconds: number
}

interface RawMimeDescriptor {
  readonly scope: Scope
  readonly direction: "inbound" | "outbound"
  readonly messageId: MessageId
  readonly ref: RawMessageRef
  readonly sha256: Sha256
  readonly sizeBytes: number
}
```

`receivedAt` is occurrence metadata and may come from a provider. The package
uses a fresh Effect clock reading for dedupe windows, message/recipient record
timestamps, archive-intent expiry, cleanup scheduling, and workflow readiness,
so stale or future provider timestamps cannot control operational work.

The raw reference is storage-only. Public raw reads return a Web stream,
content type, size, and optional ETag.

### Received content and reply actions

`EmailService.getReceivedContent` retrieves the archived object only after a
scope-safe message lookup. It enforces advertised and actual byte limits,
checks stored size and SHA-256, parses MIME with bounded nesting and headers,
and projects text, HTML, envelope/header provenance, reply metadata, normalized
automation signals, threading, and attachment descriptors. Malformed optional
addresses, filenames, Content-IDs, media types, and dispositions are omitted or
normalized without losing otherwise safe content. HTML remains untrusted.
Attachment bytes are read separately by a versioned MIME-part identity.

`ReplyCommand` deliberately omits From, To, Cc, Bcc, subject, and threading.
The package selects exactly one valid Reply-To or Header From address, falling
back to the persisted envelope sender when no valid author candidate remains.
It sends from the original route and applies the ordinary outbound policy,
archive, claim, provider-handoff, and ambiguity state machine. The package
always rejects its own route before consulting a host-composable `ReplyPolicy`.
The default policy rejects automatic/list sources and other active Trigger
targets; a host may explicitly authorize deliberate machine-to-machine replies
or add authentication-aware rules. Successful replies render standard
automatic-response suppression headers.

### Workflow outbox

```ts
interface EmailReceivedEventV1 {
  readonly schemaVersion: 1
  readonly type: "email.received"
  readonly eventId: WorkflowEventId
  readonly occurredAt: DateTime.Utc
  readonly scope: Scope
  readonly workflowId: WorkflowId
  readonly message: {
    readonly id: MessageId
    readonly routeId: RouteId
    readonly from: EmailAddress
    readonly to: readonly [EmailAddress, ...EmailAddress[]]
    readonly subject: string | null
    readonly sizeBytes: number
    readonly receivedAt: DateTime.Utc
  }
}
```

The event excludes bodies, HTML, headers, attachments, raw references, RFC
Message-ID, URLs, credentials, and host workflow types.

## Types, Interfaces, and APIs

### Application services

```ts
class EmailService extends Context.Service<EmailService, {
  readonly send: (command: SendCommand) => Effect.Effect<MessageDetails, SendError>
  readonly reply: (command: ReplyCommand) => Effect.Effect<MessageDetails, ReplyError>
  readonly listMessages: (input: ListMessagesInput) => Effect.Effect<MessagePage, ReadError>
  readonly getMessage: (input: GetMessageInput) => Effect.Effect<MessageDetails, ReadError>
  readonly readRawMime: (input: GetMessageInput) => Effect.Effect<RawMime, RawReadError>
  readonly getReceivedContent: (input: GetMessageInput) => Effect.Effect<ReceivedContent, ReceivedContentReadError>
  readonly readReceivedAttachment: (input: GetReceivedAttachmentInput) => Effect.Effect<ReceivedAttachmentContent, ReceivedAttachmentReadError>
}>()("@popcomputer/email/EmailService") {}

interface CheckReplyPolicyInput {
  readonly source: InboundMessage
  readonly content: ReceivedContent
  readonly sourceRoute: Route
  readonly target: EmailAddress
  readonly targetRoute: Option.Option<Route>
}

class ReplyPolicy extends Context.Service<ReplyPolicy, {
  readonly check: (
    input: CheckReplyPolicyInput,
  ) => Effect.Effect<void, ReplyLoopPrevented | ReplyPolicyRejected>
}>()("@popcomputer/email/ReplyPolicy") {}

interface MessageDetails {
  readonly message: Message
  readonly recipients: ReadonlyArray<MessageRecipient>
}

interface ListMessagesInput {
  readonly scope: Scope
  readonly direction?: "inbound" | "outbound"
  readonly limit?: number
  readonly cursor?: PageCursor
}

interface MessagePage {
  readonly items: ReadonlyArray<MessageDetails>
  readonly nextCursor: Option.Option<PageCursor>
}

class InboundService extends Context.Service<InboundService, {
  readonly ingest: (input: InboundEnvelope) => Effect.Effect<InboundMessage, InboundError>
}>()("@popcomputer/email/InboundService") {}

class RouteService extends Context.Service<RouteService, {
  readonly provision: (input: ProvisionRouteInput) => Effect.Effect<Route, RouteServiceError>
  readonly list: (scope: Scope) => Effect.Effect<ReadonlyArray<Route>, RouteServiceError>
  readonly pause: (input: RouteMutationInput) => Effect.Effect<Route, RouteServiceError>
  readonly resume: (input: RouteMutationInput) => Effect.Effect<Route, RouteServiceError>
  readonly disable: (input: RouteMutationInput) => Effect.Effect<Route, RouteServiceError>
  readonly rotate: (input: RotateRouteCommand) => Effect.Effect<RouteRotation, RouteServiceError>
}>()("@popcomputer/email/RouteService") {}

class WorkflowService extends Context.Service<WorkflowService, {
  readonly dispatchReady: (input?: DispatchReadyInput) => Effect.Effect<DispatchReadyResult, WorkflowDispatchError>
}>()("@popcomputer/email/WorkflowService") {}

type SendError =
  | DefaultSenderUnavailable
  | EmailArchiveUnavailable
  | EmailDigestUnavailable
  | EmailPolicyUnavailable
  | EmailStoreUnavailable
  | EmailTransitionConflict
  | EmailTransportUnavailable
  | IdempotencyConflict
  | InvalidStoredMessage
  | MessageTooLarge
  | RecipientNotPermitted
  | RouteInactive
  | RouteNotFound
  | RouteNotSendable

type ReadError =
  | EmailStoreUnavailable
  | InvalidPageRequest
  | InvalidStoredMessage
  | MessageNotFound

type RawReadError =
  | EmailArchiveUnavailable
  | EmailStoreUnavailable
  | InvalidStoredMessage
  | MessageNotFound
  | RawMimeNotFound
```

`Email.Service.send` returns the same raw-free read model used by `getMessage`,
including persisted recipient state. It can be projected directly into the
hosted response without a second store read.

A definitive provider rejection and an indeterminate handoff are durable send
outcomes, not `SendError` values: `send` succeeds with `MessageDetails` whose
message state is `Failed` or `DeliveryUnknown`. Errors describe an operation
that could not safely return a persisted result.

`Email.layer` and direct `replyEmail` use the conservative policy. Hosts opt
into a different decision explicitly through `layerWithReplyPolicy` or
`replyEmailWithPolicy`; the package checks a self-target before either policy.

Message pages default to 50 items, accept at most 100, and use descending
`(createdAt, id)` keyset order. Invalid limits or cursors fail with typed
`InvalidPageRequest`; the hosted projection deliberately encodes
`nextCursor` as `{ cursor: PageCursor | null, items: EmailMessage[] }`.

`TestRecipient.Service` owns test-environment grants and provider-status
refresh. Provider destinations are mirrored by stable provider account and
address. An add key is leased before provider I/O; a matching concurrent call
fails with `TestRecipientAddInProgress`, while a different fingerprint fails
with `IdempotencyConflict`. Completion atomically writes the destination/grant
and an immutable result snapshot. A separate refresh ledger makes every refresh
key replayable even after later refreshes, and verified grants never downgrade.
`Maintenance.Service` owns stale-send crash recovery and raw-archive cleanup.
Workflow dispatch batches are capped at the shared store ceiling of 500;
maintenance recovery and cleanup batches are capped at 1,000. Application
schemas, typed input errors, and D1 guards use the same exported constants.

### Hosted protocol

`Protocol.operations` is the source of truth for sixteen v1 operations:

```ts
type Permission = "read" | "send" | "manage"

interface Operation {
  readonly operationId: string
  readonly method: "GET" | "POST" | "DELETE"
  readonly path: string
  readonly permissions: readonly [Permission, ...ReadonlyArray<Permission>]
  readonly idempotency: "required" | "not_required"
  readonly pathSchema?: Schema.Top
  readonly querySchema?: Schema.Top
  readonly parameters?: ReadonlyArray<OperationParameter>
  readonly bodySchema?: Schema.Top
  readonly successStatus: number
  readonly successSchema: Schema.Top
  readonly successContentType:
    | "application/json"
    | "application/octet-stream"
    | "message/rfc822"
  readonly errorStatuses: ReadonlyArray<ErrorStatus>
  readonly errorSchema: typeof ErrorResponseSchema
}
```

The host consumes this metadata but owns authentication and HTTP-framework
integration. `openapi/email.v1.json` is generated deterministically from the
registry and checked for drift.

### Hosted client

```ts
interface ClientConfig {
  readonly baseUrl: URL
  readonly accessToken: Redacted.Redacted<string>
  readonly fetch?: Fetch
}

interface Client {
  readonly messages: MessageClient
  readonly routes: RouteClient
  readonly testRecipients: TestRecipientClient
}

type ClientError =
  | Unauthorized
  | Forbidden
  | NotFound
  | Conflict
  | InvalidClientRequest
  | RequestRejected
  | RateLimited
  | RemoteUnavailable
  | InvalidRemoteResponse
  | RequestCancelled
```

Reads retry only typed transient failures with a bounded jittered schedule.
Mutations never retry automatically. Every operation supports caller-owned
cancellation. Body or query encoding failures return `InvalidClientRequest`
before transport; `InvalidRemoteResponse` is reserved for invalid status,
headers, content type, JSON, or body received from the hosted service.

## Seams, Boundaries, Adapters, and Implementations

The aggregate persistence Layer is configured explicitly:

```ts
interface D1LayerConfig {
  readonly database: D1Database
  readonly providerAccountKey: string
  readonly policy?: D1OutboundPolicyConfig
}
```

`providerAccountKey` is a non-empty stable account identifier, not a secret;
with Cloudflare it is the same account ID used by `CloudflareEmailApiConfig`.
The focused message-store Layer only needs `{ database }`.

The migration intentionally does not seed `popcomputer_email_domains` or
provision DNS/routing. Before `Route.Service` can create a route, the host must
seed a stable row for the environment with `kind = 'platform'` and both
inbound/outbound statuses `active`; otherwise provisioning returns
`PlatformDomainUnavailable(not_configured)`. The
`popcomputer_email_cf_domain_bindings` table is a schema seam for host-managed
setup, not an exported setup API.

| Seam | Owner | First implementation |
| --- | --- | --- |
| `MessageStore` | send lifecycle, outbound archive intents, and scoped reads | D1 / in-memory |
| `RawMessageArchive` | raw object I/O | R2 / in-memory |
| `SendTransport` | provider preflight and handoff | Cloudflare raw-send / recording |
| `OutboundPolicy` | size, envelope-count, and test-recipient authorization | D1 / deterministic test policy |
| `ReplyPolicy` | host-composable reply authorization after target derivation | conservative package policy / host-supplied |
| `RouteStore` | send/inbound route lookup | D1 / in-memory |
| `RouteAdminStore` | route reserve/CAS/rotation | D1 / in-memory |
| `PlatformDomainRegistry` | active package domains | D1 / in-memory |
| `InboundStore` | dedupe, intent, atomic message/outbox commit | D1 / in-memory |
| `WorkflowStore` | outbox selection and lease CAS | D1 / in-memory |
| `WorkflowTriggerSink` | host workflow start | host-supplied / recording |
| `DestinationRegistry` | provider destination verification | Cloudflare REST / in-memory |
| `TestRecipientStore` | namespace-local grants plus leased add and immutable refresh ledgers | D1 / in-memory |
| `MaintenanceStore` | crash recovery and inbound/outbound archive cleanup leases | D1 |
| `IdentifierGenerator` | opaque IDs and lease tokens | Web Crypto / deterministic test adapter |
| `RouteHandleGenerator` | collision-safe generated local parts | Web Crypto / deterministic test adapter |
| `ContentDigest` | SHA-256 and fingerprints | Web Crypto |

D1 rows and provider JSON are decoded in their adapters. R2 objects and Worker
message types do not cross into the application layer. `Redacted` credentials
are unwrapped only while constructing provider authorization headers.

Layer ownership is deliberate:

| Layer group | Provides |
| --- | --- |
| Portable | `Adapter.layerWebCrypto`, `Adapter.webCryptoIdentity` |
| Persistence | `D1.d1Layer` infrastructure ports |
| Cloudflare | R2 archive, raw-send transport, destination registry, inbound handler factory |
| Host | mandatory `WorkflowTriggerSink`, auth/scope mapping, HTTP and scheduling |
| Application | `Email.layer` with conservative reply policy, `Inbound.layer()`, `Route.layer`, `TestRecipient.layer`, `Workflow.layer()`, `Maintenance.layer()` |

Cross-`@popcomputer` composition remains host-owned through `Scope`, `Actor`,
`WorkflowTriggerSink`, and the versioned event DTO; this package has no direct
dependency on another `@popcomputer` package.

## Call Stacks and Data Flow

### Current / Old Flow

```txt
Popcomputer action / Worker handler
  -> application-specific session/workspace parsing
  -> app EmailService constructed with app DB + bindings
  -> app store / R2 / Cloudflare response
  -> app-specific node or HTTP response
```

The current flow conflates auth, domain orchestration, application persistence,
and provider adaptation.

### Proposed / New Flow

Outbound:

```txt
unknown HTTP body
  -> Protocol.SendEmailRequestSchema
  -> host injects authenticated Scope + Actor + IdempotencyKey
  -> SendCommand
  -> Email.Service.send
  -> canonical request fingerprint
  -> RouteStore lookup + deterministic MIME render
  -> OutboundPolicy.check + SendTransport.preflight
  -> MessageStore.reserveOutbound (message + recipients)
  -> deterministic MIME render
  -> OutboundPolicy.check + SendTransport.preflight (resume/handoff gate)
  -> RawMessageArchive.referenceFor
  -> MessageStore.createOutboundArchiveIntent
  -> RawMessageArchive.put
  -> MessageStore.attachOutboundRaw (association + intent deletion in one batch)
  -> MessageStore.claimOutbound CAS
  -> SendTransport.send
  -> MessageStore.finalizeOutbound
  -> MessageDetails (message + persisted recipients, no raw metadata)
  -> Protocol.projectMessageEnvelope
  -> encoded response
```

Inbound:

```txt
ForwardableEmailMessageLike
  -> Cloudflare adapter parses envelope addresses
  -> InboundEnvelope
  -> Inbound.Service.ingest (awaited inline)
  -> RouteStore.findByInboundAddress
  -> actual bounded stream read
  -> PostalMime parse + SHA-256
  -> provider identity or clock-bounded digest receipt key
  -> InboundStore.findDuplicate
  -> RawMessageArchive.referenceFor
  -> InboundStore.createArchiveIntent(rawRef)
  -> RawMessageArchive.put (must return the reserved rawRef)
  -> InboundStore.commit(
       message + recipient + optional workflow event + intent deletion
     ) [one D1 batch]
  -> accepted Worker email handler completion
```

Workflow dispatch:

```txt
scheduled host call
  -> Workflow.Service.dispatchReady
  -> WorkflowStore.listReady(limit)
  -> WorkflowStore.claim(event, leaseToken, expiry) CAS
  -> WorkflowTriggerSink.start(event, "email.received:<eventId>")
  -> WorkflowStore.markStarted
     | markFailed(nextAttemptAt, safeReason)
     | markDead(safeReason)
```

The sink contract requires the same idempotency key and encoded event to return
the same run ID without creating another run. Definite pre-handoff and
ambiguous post-handoff failures are retried with that key; permanent
configuration, authorization, workflow, or key-conflict failures dead-letter
immediately.

Receive → inspect → act:

```txt
same provider delivery, or digest replay inside the fallback window
  -> one inbound message + one email.received outbox event
  -> leased Trigger Delivery with stable start key
  -> host workflow resolves Email Content(messageId)
  -> Email.reply(sourceMessageId, actionKey, body)
  -> source route + reply target + RFC threading derived by package
  -> non-overridable self-target guard + ReplyPolicy.check
  -> one durable outbound reservation
  -> one provider handoff across workflow/action replay
```

Test-recipient add:

```txt
AddTestRecipientInput
  -> canonical fingerprint(address)
  -> TestRecipientStore.claimAdd(key, fingerprint, address, lease)
     -> Completed: return immutable snapshot
     -> Pending: IdempotencyConflict | TestRecipientAddInProgress
     -> Claimed: continue
  -> existing same-address grant
     | DestinationRegistry.create + duplicate reconciliation
  -> TestRecipientStore.completeAdd(
       provider destination mirror + namespace grant + add snapshot
     ) [one D1 batch]
  -> typed failure/interruption: releaseAdd; crash: lease expiry
```

Test-recipient refresh checks the immutable refresh ledger before provider I/O,
then performs the legal sticky state transition and atomically updates the grant
plus inserts the historical outcome.

### Failure Flow

```txt
before provider handoff
  -> typed validation/config failure before reservation
     | archive/preflight/attach failure leaves Reserved replayable by the same key

after provider may have received request
  -> network / timeout / cancellation / malformed success / finalize failure
  -> DeliveryUnknown
  -> no automatic resend

R2 write succeeded, D1 reports a known dedupe winner
  -> losing D1 commit retains the candidate archive intent
  -> attempt immediate R2 removal
  -> delete intent only after proven removal
     | if removal cannot be proven, retain/promote durable cleanup work

R2 write succeeded, D1 commit result is indeterminate
  -> retain deterministic object + prewritten intent
  -> an owning committed batch linked the object and removed its intent
     | a losing or uncommitted batch leaves an expiring intent
  -> maintenance leases and retries only the remaining cleanup record

outbound R2 write succeeded, raw attachment did not commit
  -> reserved message remains replayable by the same key
  -> outbound intent remains eligible for leased cleanup
```

The Worker inbound handler calls `setReject` only for permanent caller/input
failures such as no route, inactive route, oversize message, or invalid MIME.
Durability failures are rethrown so the SMTP sender can retry.

### Retry / Cancellation / Idempotency Flow

- Outbound command replay: scope + idempotency key -> fingerprint comparison ->
  existing terminal message or safe `Reserved` resume.
- Concurrent send: one D1 CAS wins `Reserved -> Sending`; all other calls return
  the observed state without provider handoff.
- A same-key replay can safely resume a `Reserved` send after archive or
  preflight failure; deterministic R2 identity makes an ambiguous prior write
  idempotent.
- Cancellation after claim installs an uninterruptible finalizer that writes
  `DeliveryUnknown(cancelled)`.
- Empty, incomplete, duplicated, or contradictory provider recipient outcomes
  finalize as `DeliveryUnknown(invalid_response)` rather than overstating
  acceptance.
- Hosted client retries GET/raw reads only; sends, route mutations, and recipient
  mutations are single-attempt.
- Message listing accepts 1-100 items; malformed cursors and invalid limits are
  typed `InvalidPageRequest` failures in both D1 and in-memory adapters.
- Test-recipient add keys acquire an expiring D1 lease before provider I/O;
  completion records an immutable snapshot, while typed failure releases the
  lease and crashes recover after expiry. Provider duplicates are reconciled,
  and refresh keys live in a separate immutable historical ledger.
- Workflow retries use bounded exponential delay and a maximum attempt count.
- Cleanup retries use exclusive leases and eventually become dead work rather
  than looping forever.

### Observability Flow

The following is host guidance, not an exported telemetry API. The package
enforces the same boundary in typed errors; hosts may project those failures to
safe fields such as:

```ts
interface SafeEmailDiagnostic {
  readonly operation: string
  readonly environment?: Environment
  readonly direction?: Direction
  readonly inboundCapability?: "store" | "trigger"
  readonly outboundCapability?: "disabled" | "sender"
  readonly messageId?: MessageId
  readonly counts?: Readonly<Record<string, number>>
  readonly sizeBytes?: number
  readonly state?: string
  readonly errorTag?: string
  readonly providerStatus?: number
  readonly providerCode?: number
  readonly workflowAttempt?: number
}
```

Addresses, subjects, bodies, HTML, MIME, headers, filenames, attachment content,
RFC Message-ID, credentials, authorization headers, idempotency keys, raw
provider bodies, and workflow payloads are forbidden in diagnostics. Authorized
resource DTOs necessarily contain addresses and subjects and therefore must not
be logged wholesale.

## Files to Add / Change / Delete

New repository modules:

- `src/core/*`: schemas, branded values, states, transitions, typed domain
  failures.
- `src/application/*`: send, inbound, route, workflow, recipient, maintenance,
  and read orchestration.
- `src/adapters/*`: runtime-neutral service ports.
- `src/storage/d1/*`: D1 row codecs, queries, CAS operations, Layers, and
  query-oriented Drizzle declarations; shipped SQL remains the authoritative
  migration definition.
- `src/adapters/cloudflare/*`: R2, raw-send, destination, and inbound adapters.
- `src/protocol/*`: strict DTOs, operation registry, projections, and OpenAPI.
- `src/client/*`: hosted Effect client and typed remote failures.
- `src/testing/*`: deterministic/in-memory/recording adapters.
- `src/{index,adapter,client,protocol,cloudflare,d1,d1-schema,testing}.ts`:
  public entry points.
- `migrations/d1/0001_email.sql`: package-owned tables and indexes.
- `openapi/email.v1.json`: generated v1 contract.
- `tests/unit/*`: domain, orchestration, protocol, client, and adapter behavior.
- `tests/cloudflare/*`: real workerd D1/R2 migration, transaction, and CAS tests.
- `package-tests/*`: built-package import/type coverage.
- `docs/adr/0001-package-boundaries.md`: accepted boundary decision.
- `docs/adr/0002-email-actions-and-triggers.md`: route capability and
  content-free trigger decision.
- `CONTEXT.md`: canonical Email Action, Trigger, Content, and route terms.

The Popcomputer app extraction/migration is a later host change. No source file
in the original app is deleted as part of publishing this standalone package.

## RGR TDD Test Plan

Implement as vertical red-green-refactor slices:

1. Address and identifier parsing: reject malformed data; normalize domains.
2. Domain transitions: accept every legal message/route/workflow transition and
   reject illegal states at compile/runtime boundaries.
3. Outbound policy: enforce size and recipient-count bounds everywhere and
   verified, scope-local grants in test environments before reservation or
   provider handoff.
4. One send: reserve, archive, claim, capture; verify deterministic MIME and no
   Bcc header.
5. Send replay: same key/fingerprint returns one message; different fingerprint
   fails.
6. Concurrent send: block the first transport call, race a replay, and prove one
   handoff.
7. Send ambiguity: network, timeout, cancellation, and finalization failure
   persist `DeliveryUnknown` and never retry.
8. Outbound archive fault window: fail attachment before commit and after a
   committed-but-ambiguous response; prove the intent remains in the first
   case, the linked message wins in the second, and a cleanup lease excludes
   attachment.
9. Route lifecycle: provision replay, address collision, revision CAS,
   pause/resume/disable, and atomic rotation.
10. Inbound bounded read: a lying size claim cannot bypass the actual byte limit.
11. Inbound success: archive raw MIME, commit metadata, and stream it back.
12. Inbound dedupe race: one stable provider delivery ID produces one message
    indefinitely; without it, the same route, envelope sender, and raw digest
    produce one message only inside a fixed first-observation window. Prove the
    window uses Effect time rather than replayed provider timestamps, expires at
    its boundary, and does not slide. Distinct trusted envelope provenance
    remains distinct. A known losing raw object is removed or queued for
    cleanup, while an indeterminate commit retains its deterministic intent.
13. Workflow lease: two dispatchers claim once; definite and ambiguous failures
    retry with the same key, permanent failures dead-letter immediately, and
    accepted-start ACK loss creates one host run.
14. Test recipients: pre-provider add lease, creation replay and conflicting-key
    reuse, provider quota/duplicate reconciliation, sticky verification,
    failed-to-pending refresh, historical refresh replay after a newer key,
    scope isolation, and live-environment rejection by schema.
15. Read model: return persisted recipient delivery state with each message
    while proving archive metadata and raw references stay storage-only.
16. Received content: lazy parsing, envelope/header provenance, body and
    attachment limits, archive size/digest integrity, stable attachment IDs,
    normalized automation signals, and tolerant malformed optional metadata.
17. Reply action: package-derived target/threading, Trigger+Sender route,
    same-key replay, conflict, ambiguity, non-overridable self-loop prevention,
    conservative and host-supplied policy decisions, automatic-response
    marking, and source-retention independence.
18. North-star vertical: duplicate inbound → one trigger → ACK loss → content
    resolution → reply replay → one provider handoff.
19. Protocol: exact registry operation count, strict excess-property rejection,
    stable error codes, projections with no private fields, and current OpenAPI.
20. Client: auth/idempotency headers, status mapping, invalid response rejection,
    GET-only retry, raw stream, and cancellation.
21. Real workerd: apply migrations, prove D1 batch rollback, route/message CAS,
    inbound message+outbox atomicity, lease exclusivity, and R2 semantics.
22. Built artifact: type-check every export, import every ESM entry point in
    Node, and inspect an offline `npm pack --dry-run` file list.

## Risks and Open Questions

- Effect 4 is stable and the peer range is `^4.0.0`. The package uses only
  `@stability stable` Effect APIs; adopting an `@stability unstable` module
  would allow a minor Effect release to break it.
- Confirm npm organization publication access and whether the public name should
  remain singular `@popcomputer/email`.
- Select host-specific retention periods before enabling destructive archival
  maintenance in production.
- Confirm Cloudflare Email Sending availability, quotas, and account permissions
  for each deployment environment.
- Decide when the Popcomputer app switches from its internal implementation to
  this package; dual writes are not part of this design.
- Decide whether a future provider adapter should be standardized only after a
  second provider demonstrates the required common contract.
