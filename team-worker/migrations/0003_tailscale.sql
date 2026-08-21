-- tailscale_role is added by the runtime schema healer when an older users
-- table is detected. Keeping this migration free of ALTER TABLE makes the
-- self-healing bootstrap safe to execute repeatedly.

CREATE TABLE IF NOT EXISTS tailscale_key_issuances (
  id TEXT PRIMARY KEY,
  access_subject TEXT NOT NULL,
  team_device_id TEXT,
  key_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  tag TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS tailscale_key_issuances_subject_idx
  ON tailscale_key_issuances(access_subject, issued_at DESC);

CREATE TABLE IF NOT EXISTS tailscale_devices (
  node_id TEXT PRIMARY KEY,
  access_subject TEXT NOT NULL,
  team_device_id TEXT,
  hostname TEXT,
  ipv4 TEXT,
  ipv6 TEXT,
  role TEXT NOT NULL,
  tag TEXT NOT NULL,
  online INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS tailscale_devices_subject_idx
  ON tailscale_devices(access_subject, updated_at DESC);
