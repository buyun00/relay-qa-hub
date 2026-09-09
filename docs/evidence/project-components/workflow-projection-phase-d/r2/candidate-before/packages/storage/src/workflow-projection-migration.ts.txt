/** Additive schema17 payload. Earlier schema16 proposal was superseded by Phase B.
 * Registration is owned by the application integrator; this file never registers it. */
export const WORKFLOW_PROJECTION_SNAPSHOT_SQL = `
CREATE TABLE workflow_projection_snapshots (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  account_id TEXT NOT NULL, project_id TEXT NOT NULL, actor_id TEXT NOT NULL, bug_id TEXT NOT NULL,
  membership_digest TEXT NOT NULL CHECK(length(membership_digest)=64),
  filter_digest TEXT NOT NULL CHECK(length(filter_digest)=64),
  bug_version INTEGER NOT NULL CHECK(bug_version>=1),
  snapshot_sequence INTEGER NOT NULL CHECK(snapshot_sequence>=0),
  limit_per_collection INTEGER NOT NULL CHECK(limit_per_collection BETWEEN 1 AND 100),
  signing_key BLOB NOT NULL CHECK(length(signing_key)=32),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  item_count INTEGER NOT NULL CHECK(item_count>=0), byte_count INTEGER NOT NULL CHECK(byte_count>=0),
  FOREIGN KEY(account_id, project_id, bug_id) REFERENCES bugs(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(account_id, actor_id) REFERENCES users(account_id, id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX workflow_projection_active ON workflow_projection_snapshots(account_id, actor_id, expires_at);
CREATE TABLE workflow_projection_items (
  snapshot_id TEXT NOT NULL REFERENCES workflow_projection_snapshots(id) ON DELETE RESTRICT,
  collection TEXT NOT NULL CHECK(collection IN ('occurrences','repairAttempts','verifications','builds','relayReceipts')),
  sort_key TEXT NOT NULL CHECK(length(sort_key)=36),
  dto_json TEXT NOT NULL CHECK(json_valid(dto_json) AND json_type(dto_json)='object'),
  PRIMARY KEY(snapshot_id, collection, sort_key)
) STRICT;
CREATE TABLE workflow_projection_cursors (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  snapshot_id TEXT NOT NULL REFERENCES workflow_projection_snapshots(id) ON DELETE RESTRICT,
  watermarks_json TEXT NOT NULL CHECK(json_valid(watermarks_json) AND json_type(watermarks_json)='object'),
  UNIQUE(snapshot_id, watermarks_json)
) STRICT;
CREATE TRIGGER workflow_projection_items_capacity BEFORE INSERT ON workflow_projection_items
WHEN (SELECT count(*) FROM workflow_projection_items WHERE snapshot_id=new.snapshot_id)
  >= (SELECT item_count FROM workflow_projection_snapshots WHERE id=new.snapshot_id)
BEGIN SELECT RAISE(ABORT,'Workflow projection item set is sealed'); END;
${["snapshots", "items", "cursors"]
  .flatMap((name) => [
    `CREATE TRIGGER workflow_projection_${name}_immutable BEFORE UPDATE ON workflow_projection_${name}
   BEGIN SELECT RAISE(ABORT,'Workflow projection records are immutable'); END;`,
    `CREATE TRIGGER workflow_projection_${name}_retained BEFORE DELETE ON workflow_projection_${name}
   BEGIN SELECT RAISE(ABORT,'Workflow projection records are retained'); END;`,
  ])
  .join("\n")}
`;
