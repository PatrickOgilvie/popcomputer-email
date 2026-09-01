-- @popcomputer/email v0.1 package-owned persistence.
--
-- The host maps its tenant vocabulary to `namespace` and its principals to the
-- opaque `(actor_kind, actor_id)` pair. No host-owned table is referenced here.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS popcomputer_email_domains (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'platform'),
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  inbound_status TEXT NOT NULL CHECK (inbound_status IN ('disabled', 'active', 'failed')),
  outbound_status TEXT NOT NULL CHECK (outbound_status IN ('disabled', 'active', 'failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (domain, environment)
);

CREATE INDEX IF NOT EXISTS popcomputer_email_domains_inbound
  ON popcomputer_email_domains(environment, inbound_status);

CREATE TABLE IF NOT EXISTS popcomputer_email_cf_domain_bindings (
  domain_id TEXT PRIMARY KEY
    REFERENCES popcomputer_email_domains(id) ON DELETE CASCADE,
  zone_id TEXT,
  catch_all_rule_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS popcomputer_email_routes (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  domain_id TEXT NOT NULL
    REFERENCES popcomputer_email_domains(id) ON DELETE RESTRICT,
  address TEXT NOT NULL,
  local_part TEXT NOT NULL,
  local_part_normalized TEXT NOT NULL,
  mailbox_handle TEXT NOT NULL,
  inbound_kind TEXT NOT NULL CHECK (inbound_kind IN ('store', 'trigger')),
  workflow_id TEXT,
  outbound_kind TEXT NOT NULL CHECK (outbound_kind IN ('disabled', 'sender')),
  sender_role TEXT CHECK (sender_role IN ('default', 'alternate')),
  metadata_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'disabled')),
  creation_idempotency_key TEXT,
  creation_fingerprint TEXT,
  rotation_idempotency_key TEXT,
  rotation_fingerprint TEXT,
  rotation_replacement_id TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'credential', 'system')),
  actor_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,
  CHECK (
    (inbound_kind = 'store' AND workflow_id IS NULL)
    OR
    (inbound_kind = 'trigger' AND workflow_id IS NOT NULL)
  ),
  CHECK (
    (outbound_kind = 'disabled' AND sender_role IS NULL)
    OR
    (outbound_kind = 'sender' AND sender_role IS NOT NULL)
  ),
  CHECK (
    (status = 'disabled' AND disabled_at IS NOT NULL)
    OR
    (status != 'disabled' AND disabled_at IS NULL)
  ),
  CHECK (
    (creation_idempotency_key IS NULL AND creation_fingerprint IS NULL)
    OR
    (creation_idempotency_key IS NOT NULL AND creation_fingerprint IS NOT NULL)
  ),
  CHECK (
    (
      rotation_idempotency_key IS NULL
      AND rotation_fingerprint IS NULL
      AND rotation_replacement_id IS NULL
    )
    OR
    (
      status = 'disabled'
      AND rotation_idempotency_key IS NOT NULL
      AND rotation_fingerprint IS NOT NULL
      AND rotation_replacement_id IS NOT NULL
    )
  )
);

-- Disabled routes deliberately continue reserving their address.
CREATE UNIQUE INDEX IF NOT EXISTS popcomputer_email_routes_domain_local_part
  ON popcomputer_email_routes(domain_id, local_part_normalized);

CREATE UNIQUE INDEX IF NOT EXISTS popcomputer_email_routes_address
  ON popcomputer_email_routes(address);

CREATE UNIQUE INDEX IF NOT EXISTS popcomputer_email_routes_default_from
  ON popcomputer_email_routes(namespace, environment)
  WHERE outbound_kind = 'sender'
    AND sender_role = 'default'
    AND status != 'disabled';

CREATE UNIQUE INDEX IF NOT EXISTS popcomputer_email_routes_creation_idempotency
  ON popcomputer_email_routes(namespace, environment, creation_idempotency_key)
  WHERE creation_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS popcomputer_email_routes_scope_inbound_status
  ON popcomputer_email_routes(namespace, environment, inbound_kind, status, created_at, id);

CREATE INDEX IF NOT EXISTS popcomputer_email_routes_workflow
  ON popcomputer_email_routes(namespace, environment, workflow_id);

CREATE TABLE IF NOT EXISTS popcomputer_email_messages (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  route_id TEXT REFERENCES popcomputer_email_routes(id) ON DELETE SET NULL,
  workflow_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status TEXT NOT NULL,
  state_reason TEXT,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT,
  rfc_message_id TEXT,
  raw_sha256 TEXT,
  raw_ref TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  idempotency_key TEXT,
  request_fingerprint TEXT,
  provider_message_id TEXT,
  actor_kind TEXT CHECK (actor_kind IN ('user', 'credential', 'system')),
  actor_id TEXT,
  claimed_at INTEGER,
  sent_at INTEGER,
  received_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (direction = 'inbound' AND status IN ('received', 'workflow_event_created'))
    OR
    (direction = 'outbound' AND status IN (
      'reserved',
      'sending',
      'captured',
      'accepted',
      'partially_accepted',
      'delivery_unknown',
      'failed'
    ))
  ),
  CHECK (
    direction != 'outbound'
    OR (
      idempotency_key IS NOT NULL
      AND request_fingerprint IS NOT NULL
      AND actor_kind IS NOT NULL
      AND actor_id IS NOT NULL
    )
  ),
  CHECK ((actor_kind IS NULL) = (actor_id IS NULL)),
  CHECK (status != 'sending' OR claimed_at IS NOT NULL),
  CHECK (direction != 'inbound' OR received_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS popcomputer_email_messages_outbound_idempotency
  ON popcomputer_email_messages(namespace, environment, idempotency_key)
  WHERE direction = 'outbound' AND idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS popcomputer_email_messages_scope_created
  ON popcomputer_email_messages(namespace, environment, direction, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS popcomputer_email_messages_stale_sending
  ON popcomputer_email_messages(status, claimed_at)
  WHERE direction = 'outbound' AND status = 'sending';

-- A provider delivery ID is a durable replay authority. Without one, the
-- trusted envelope sender and raw digest suppress retries only inside a fixed
-- first-observation window. Receipt replacement and message/outbox creation
-- happen in one D1 batch transaction.
CREATE TABLE IF NOT EXISTS popcomputer_email_inbound_dedupe_receipts (
  message_id TEXT NOT NULL UNIQUE
    REFERENCES popcomputer_email_messages(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  route_id TEXT NOT NULL
    REFERENCES popcomputer_email_routes(id) ON DELETE CASCADE,
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('provider', 'digest')),
  provider TEXT,
  delivery_id TEXT,
  envelope_from TEXT,
  raw_sha256 TEXT,
  window_started_at INTEGER NOT NULL,
  expires_at INTEGER,
  CHECK (
    (
      identity_kind = 'provider'
      AND provider IS NOT NULL
      AND delivery_id IS NOT NULL
      AND envelope_from IS NULL
      AND raw_sha256 IS NULL
      AND expires_at IS NULL
    )
    OR
    (
      identity_kind = 'digest'
      AND provider IS NULL
      AND delivery_id IS NULL
      AND envelope_from IS NOT NULL
      AND raw_sha256 IS NOT NULL
      AND expires_at > window_started_at
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS popcomputer_email_inbound_dedupe_provider
  ON popcomputer_email_inbound_dedupe_receipts(
    namespace, environment, route_id, provider, delivery_id
  )
  WHERE identity_kind = 'provider';

CREATE UNIQUE INDEX IF NOT EXISTS popcomputer_email_inbound_dedupe_digest
  ON popcomputer_email_inbound_dedupe_receipts(
    namespace, environment, route_id, envelope_from, raw_sha256
  )
  WHERE identity_kind = 'digest';

CREATE TABLE IF NOT EXISTS popcomputer_email_recipients (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL
    REFERENCES popcomputer_email_messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('to', 'cc', 'bcc')),
  position INTEGER NOT NULL CHECK (position >= 0),
  address TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'captured', 'queued', 'delivered', 'permanent_bounce', 'failed'
  )),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS popcomputer_email_recipients_message_kind
  ON popcomputer_email_recipients(message_id, kind, position);

CREATE UNIQUE INDEX IF NOT EXISTS popcomputer_email_recipients_position
  ON popcomputer_email_recipients(message_id, kind, position);

CREATE TABLE IF NOT EXISTS popcomputer_email_inbound_archive_intents (
  message_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  raw_sha256 TEXT NOT NULL,
  raw_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'failed', 'dead')),
  expires_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  safe_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status != 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS popcomputer_email_inbound_archive_intents_due
  ON popcomputer_email_inbound_archive_intents(next_attempt_at, expires_at);

CREATE TABLE IF NOT EXISTS popcomputer_email_outbound_archive_intents (
  message_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  raw_sha256 TEXT NOT NULL,
  raw_ref TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'failed', 'dead')),
  expires_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  safe_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status != 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS popcomputer_email_outbound_archive_intents_due
  ON popcomputer_email_outbound_archive_intents(next_attempt_at, expires_at);

CREATE TABLE IF NOT EXISTS popcomputer_email_cf_destinations (
  id TEXT PRIMARY KEY,
  provider_account_key TEXT NOT NULL,
  address TEXT NOT NULL,
  provider_destination_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (provider_account_key, address)
);

CREATE TABLE IF NOT EXISTS popcomputer_email_test_recipient_grants (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment = 'test'),
  destination_id TEXT NOT NULL
    REFERENCES popcomputer_email_cf_destinations(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  last_refresh_idempotency_key TEXT,
  last_refresh_fingerprint TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'verified', 'failed')),
  state_at INTEGER NOT NULL,
  failure_reason TEXT CHECK (failure_reason IN (
    'provider_rejected', 'verification_expired', 'destination_unavailable'
  )),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'credential', 'system')),
  actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (last_refresh_idempotency_key IS NULL AND last_refresh_fingerprint IS NULL)
    OR
    (last_refresh_idempotency_key IS NOT NULL AND last_refresh_fingerprint IS NOT NULL)
  ),
  CHECK (
    (state = 'failed' AND failure_reason IS NOT NULL)
    OR
    (state != 'failed' AND failure_reason IS NULL)
  ),
  UNIQUE (namespace, environment, destination_id),
  UNIQUE (namespace, environment, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS popcomputer_email_test_recipient_grants_refresh_idempotency
  ON popcomputer_email_test_recipient_grants(namespace, environment, last_refresh_idempotency_key)
  WHERE last_refresh_idempotency_key IS NOT NULL;

-- An add key is claimed before provider I/O. Completed rows retain the exact
-- result observed by that key, while abandoned leases remain recoverable.
CREATE TABLE IF NOT EXISTS popcomputer_email_test_recipient_adds (
  namespace TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment = 'test'),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  test_recipient_id TEXT
    REFERENCES popcomputer_email_test_recipient_grants(id) ON DELETE CASCADE,
  state TEXT CHECK (state IN ('pending', 'verified', 'failed')),
  state_at INTEGER,
  failure_reason TEXT CHECK (failure_reason IN (
    'provider_rejected', 'verification_expired', 'destination_unavailable'
  )),
  lease_token TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (
      status = 'pending'
      AND test_recipient_id IS NULL
      AND state IS NULL
      AND state_at IS NULL
      AND failure_reason IS NULL
    )
    OR
    (
      status = 'completed'
      AND test_recipient_id IS NOT NULL
      AND state IS NOT NULL
      AND state_at IS NOT NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (
    (state = 'failed' AND failure_reason IS NOT NULL)
    OR
    ((state IS NULL OR state != 'failed') AND failure_reason IS NULL)
  ),
  PRIMARY KEY (namespace, environment, idempotency_key)
);

-- Preserve creation keys if this migration is applied to pre-ledger grant
-- rows during prerelease development.
INSERT INTO popcomputer_email_test_recipient_adds (
  namespace, environment, idempotency_key, request_fingerprint, address,
  status, test_recipient_id, state, state_at, failure_reason,
  lease_token, lease_expires_at, created_at, updated_at
)
SELECT
  g.namespace, g.environment, g.idempotency_key, g.request_fingerprint,
  d.address, 'completed', g.id, g.state, g.state_at, g.failure_reason,
  NULL, NULL, g.created_at, g.updated_at
FROM popcomputer_email_test_recipient_grants AS g
INNER JOIN popcomputer_email_cf_destinations AS d ON d.id = g.destination_id
WHERE 1
ON CONFLICT(namespace, environment, idempotency_key) DO NOTHING;

CREATE INDEX IF NOT EXISTS popcomputer_email_test_recipient_adds_recipient
  ON popcomputer_email_test_recipient_adds(
    namespace, environment, test_recipient_id, created_at
  );

-- Every refresh result is retained so replaying an older key after a newer
-- refresh returns its original outcome without calling the provider again.
CREATE TABLE IF NOT EXISTS popcomputer_email_test_recipient_refreshes (
  namespace TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment = 'test'),
  idempotency_key TEXT NOT NULL,
  test_recipient_id TEXT NOT NULL
    REFERENCES popcomputer_email_test_recipient_grants(id) ON DELETE CASCADE,
  request_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'verified', 'failed')),
  state_at INTEGER NOT NULL,
  failure_reason TEXT CHECK (failure_reason IN (
    'provider_rejected', 'verification_expired', 'destination_unavailable'
  )),
  created_at INTEGER NOT NULL,
  CHECK (
    (state = 'failed' AND failure_reason IS NOT NULL)
    OR
    (state != 'failed' AND failure_reason IS NULL)
  ),
  PRIMARY KEY (namespace, environment, idempotency_key)
);

CREATE INDEX IF NOT EXISTS popcomputer_email_test_recipient_refreshes_recipient
  ON popcomputer_email_test_recipient_refreshes(
    namespace, environment, test_recipient_id, created_at
  );

CREATE TABLE IF NOT EXISTS popcomputer_email_workflow_events (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL
    REFERENCES popcomputer_email_messages(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL
    REFERENCES popcomputer_email_routes(id) ON DELETE RESTRICT,
  namespace TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  workflow_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'started', 'failed', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  safe_error_code TEXT,
  external_run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status != 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  UNIQUE (message_id, route_id)
);

CREATE INDEX IF NOT EXISTS popcomputer_email_workflow_events_due
  ON popcomputer_email_workflow_events(status, next_attempt_at, lease_expires_at, created_at);

CREATE INDEX IF NOT EXISTS popcomputer_email_workflow_events_scope
  ON popcomputer_email_workflow_events(namespace, environment, workflow_id, status, created_at);

CREATE TABLE IF NOT EXISTS popcomputer_email_archive_deletions (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_id TEXT NOT NULL,
  raw_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'failed', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  safe_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status != 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  UNIQUE (namespace, environment, direction, message_id)
);

CREATE INDEX IF NOT EXISTS popcomputer_email_archive_deletions_due
  ON popcomputer_email_archive_deletions(status, next_attempt_at, lease_expires_at, created_at);
