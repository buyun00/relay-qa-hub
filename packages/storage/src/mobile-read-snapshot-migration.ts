/** Durable, bounded list snapshots for frozen 1.1 read pagination. */
export const MOBILE_READ_SNAPSHOT_SQL = String.raw`
CREATE TABLE mobile_read_snapshots (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK(length(id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('visible-projects', 'project-members', 'project-builds', 'notifications')),
  account_id TEXT NOT NULL CHECK(length(account_id) = 36),
  actor_id TEXT NOT NULL CHECK(length(actor_id) = 36),
  project_id TEXT CHECK(project_id IS NULL OR length(project_id) = 36),
  authorization_digest TEXT NOT NULL CHECK(length(authorization_digest) = 43),
  filter_digest TEXT NOT NULL CHECK(length(filter_digest) = 43),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 0 AND 10000),
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 2 AND 67108864),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY(account_id, actor_id) REFERENCES users(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(account_id, project_id) REFERENCES projects(account_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX mobile_read_snapshots_actor_active
  ON mobile_read_snapshots(account_id, actor_id, expires_at, sequence);
CREATE INDEX mobile_read_snapshots_expiry
  ON mobile_read_snapshots(expires_at, sequence);

CREATE TABLE mobile_read_snapshot_items (
  snapshot_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  dto_json TEXT NOT NULL CHECK(json_valid(dto_json) AND json_type(dto_json) = 'object'),
  PRIMARY KEY(snapshot_id, ordinal),
  FOREIGN KEY(snapshot_id) REFERENCES mobile_read_snapshots(id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER mobile_read_snapshots_no_update
BEFORE UPDATE ON mobile_read_snapshots
BEGIN
  SELECT RAISE(ABORT, 'mobile read snapshots are immutable');
END;

CREATE TRIGGER mobile_read_snapshot_items_no_update
BEFORE UPDATE ON mobile_read_snapshot_items
BEGIN
  SELECT RAISE(ABORT, 'mobile read snapshot items are immutable');
END;

CREATE TRIGGER mobile_read_snapshot_item_capacity
BEFORE INSERT ON mobile_read_snapshot_items
WHEN new.ordinal >= (
  SELECT item_count FROM mobile_read_snapshots WHERE id = new.snapshot_id
)
BEGIN
  SELECT RAISE(ABORT, 'mobile read snapshot item set is sealed');
END;

CREATE TRIGGER mobile_read_snapshot_live_delete_guard
BEFORE DELETE ON mobile_read_snapshots
WHEN old.expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
BEGIN
  SELECT RAISE(ABORT, 'active mobile read snapshots cannot be deleted');
END;
`;
