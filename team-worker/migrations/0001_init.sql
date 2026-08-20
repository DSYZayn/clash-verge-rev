CREATE TABLE IF NOT EXISTS users (
  access_subject TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  display_name TEXT,
  team_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  quota_upload INTEGER,
  quota_download INTEGER,
  quota_total INTEGER,
  quota_expire INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  access_subject TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS audit_events_subject_idx
  ON audit_events(access_subject, created_at DESC);
