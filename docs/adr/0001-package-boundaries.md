# ADR 0001: Portable email core with explicit runtime adapters

Status: accepted

## Context

The original email capability lived inside the Popcomputer web application. Its
domain behavior was useful outside that application, but its public-looking
service accepted the application database and leaked Honertia, Drizzle, R2, and
Cloudflare response types. Its migrations also referenced host workspace and
user tables.

Outbound email crosses D1, R2, and a provider request without a distributed
transaction. Inbound email crosses R2 and D1. Workflow-trigger delivery adds a
third durable runtime boundary. Those constraints need to be explicit in the
package contract rather than hidden by a broad application service.

## Decision

`@popcomputer/email` exposes a runtime-neutral Effect domain and application
surface from its root. External behavior is supplied through narrow Effect
services exported by `@popcomputer/email/adapter`.

Cloudflare, D1, protocol, client, and testing implementations live in explicit
subpath exports. Root modules do not import those implementations. The package
uses `{ namespace, environment }` as its host-neutral scope and opaque actor
identifiers instead of host foreign keys.

The send state machine guarantees at most one automatic provider handoff for a
scoped idempotency key. It does not claim exactly-once delivery. Any failure that
can occur after a request reached the provider becomes `DeliveryUnknown` and is
never automatically resent.

Inbound raw MIME is archived before its D1 metadata commit. A durable archive
intent plus compensation closes the ordinary orphan window. Message,
recipients, and an optional workflow event commit in one D1 batch.

The workflow integration is a durable package outbox plus a host-supplied
`WorkflowTriggerSink`. The package does not depend on a particular workflow or
chat package, and live composition never silently installs a no-op sink.

## Consequences

- Applications must map their tenant and actor vocabulary at the boundary.
- Cloudflare consumers opt into `./cloudflare` and `./d1`; browser or hosted
  consumers can use only `./client` and `./protocol`.
- D1, R2, and provider ambiguity remain visible and testable.
- The package can be used alongside other `@popcomputer` packages without a
  shared core package or dependency cycle.
- The Popcomputer application must use Effect 4 before directly composing the
  package services.

## Rejected alternatives

- An SDK-only package would discard the reusable local domain and orchestration.
- A Honertia/Cloudflare monolith would make the application framework part of
  every consumer's contract.
- Direct dependencies on `@popcomputer/structured-chat` or `@popcomputer/web`
  would couple release cycles and turn host composition into package policy.
