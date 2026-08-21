-- Per-device presence: the desktop sends a stable random device id on
-- authenticated calls; last_seen feeds the online-device counter.
CREATE TABLE IF NOT EXISTS devices (
  access_subject TEXT NOT NULL,
  device_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (access_subject, device_id)
);

CREATE INDEX IF NOT EXISTS idx_devices_subject_seen
  ON devices (access_subject, last_seen);
