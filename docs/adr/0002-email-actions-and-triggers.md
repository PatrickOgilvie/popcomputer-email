# Model routes as capabilities and keep trigger payloads content-free

Status: accepted

An email address may need to receive a message, emit a workflow trigger, and
send the resulting reply. Routes therefore have independent inbound
(`Store | Trigger`) and outbound (`Disabled | Sender`) capabilities instead of
being classified as either inboxes or triggers. The durable
`email.received` event contains only scoped message metadata; workflows resolve
bounded Email Content lazily by message ID and invoke idempotent Email Actions.
This keeps large, sensitive MIME outside the outbox while allowing one address
to support the complete receive → inspect → act loop.

## Consequences

- Trigger delivery and workflow execution remain separate failure domains.
- Envelope sender provenance is persisted independently from untrusted Header
  From and Reply-To values.
- A provider delivery ID is the durable replay authority when available.
  Otherwise route, Envelope Sender, and raw digest suppress duplicates only
  inside a fixed first-observation window, so byte-identical later deliveries
  can trigger new workflow runs.
- Provider `receivedAt` is occurrence metadata only. Effect time drives archive
  expiry, cleanup, record timestamps, and workflow readiness.
- A concurrent receipt loser retains its raw archive intent until removal is
  proven or durable cleanup owns the object.
- Reply derives its route, target, subject, and threading from the immutable
  inbound message; callers provide only content and an idempotency key.
- Reply always fails before reservation for its own route. A host-composable
  `ReplyPolicy` conservatively rejects automatic/list sources and other active
  Trigger routes by default, while allowing a host to authorize deliberate
  machine-to-machine replies or add authentication-aware checks. Store-only
  routes remain composable targets. Successful replies identify themselves as
  automatic responses.
- Malformed optional MIME metadata is omitted from the typed content projection
  instead of preventing a workflow from reading otherwise safe content.
- Archived MIME retention must cover the period in which a workflow may first
  resolve Email Content. Completed reply replays do not require the source
  archive.
