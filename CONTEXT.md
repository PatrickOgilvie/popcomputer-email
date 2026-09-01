# Email Automation

This context turns workflow actions into durable outbound email attempts and
inbound deliveries into durable, replay-safe triggers. It owns the unreliable
email boundary; the host owns workflow execution and business decisions.

## Language

**Email Route**:
A reserved email address with independent inbound and outbound capabilities.
_Avoid_: Inbox kind, trigger address

**Inbound Capability**:
The route policy that either stores received mail or stores it and emits a
trigger.
_Avoid_: Route type, destination kind

**Outbound Capability**:
The route policy that either disables sending or permits the address to act as
a default or alternate sender.
_Avoid_: Inbox role, From address flag

**Email Action**:
A host-initiated, idempotent outbound mutation, currently send or reply.
_Avoid_: Email job, mail task

**Reply Action**:
An Email Action whose sender, recipient, subject, and threading are derived
from one scoped inbound message.
_Avoid_: Send with defaults, raw reply

**Reply Policy**:
A host-composable decision over the derived Reply Action. The package default
rejects automatic/list sources and active Trigger targets; the package's own
self-target guard is not policy-overridable.
_Avoid_: Reply callback, reply hook

**Email Trigger**:
A versioned `email.received` event emitted durably for a Trigger-capable route.
_Avoid_: Webhook, callback

**Email Content**:
A bounded, typed projection read lazily from immutable archived MIME by message
identity.
_Avoid_: Event payload, parsed blob

**Trigger Delivery**:
The leased, idempotent handoff of an Email Trigger to the host workflow runtime.
_Avoid_: Workflow execution, event processing

**Envelope Sender**:
The provider-boundary sender retained as delivery provenance.
_Avoid_: Header From, author

**Inbound Delivery Identity**:
A stable provider delivery ID when available; otherwise a bounded receipt key
derived from route, Envelope Sender, and raw digest.
_Avoid_: RFC Message-ID, email identity

**Header From**:
The untrusted author address declared inside MIME and exposed through Email
Content.
_Avoid_: Envelope sender

**Delivery Unknown**:
The terminal outbound state used when provider acceptance cannot be proved or
disproved.
_Avoid_: Failed, retryable
