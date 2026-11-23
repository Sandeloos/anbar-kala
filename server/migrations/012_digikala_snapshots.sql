CREATE TABLE dk_read_snapshots (
  account TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('catalog', 'packages', 'package')),
  lookup_key TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (account, kind, lookup_key)
);
CREATE INDEX dk_read_snapshots_checked ON dk_read_snapshots(checked_at);
