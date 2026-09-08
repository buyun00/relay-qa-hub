/** Additive only: legacy identities and historical audit records remain intact. */
export const PROJECT_MANAGEMENT_SQL = String.raw`
ALTER TABLE browser_sessions ADD COLUMN login_project_id TEXT REFERENCES projects(id);
ALTER TABLE browser_sessions ADD COLUMN is_gm INTEGER NOT NULL DEFAULT 0 CHECK (is_gm IN (0, 1));
CREATE TRIGGER browser_session_project_immutable BEFORE UPDATE ON browser_sessions
WHEN new.login_project_id IS NOT old.login_project_id OR new.is_gm IS NOT old.is_gm
BEGIN SELECT RAISE(ABORT, 'session project and GM identity are immutable'); END;

CREATE TABLE project_components (
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  component_key TEXT NOT NULL CHECK (component_key IN ('build', 'build_upload.single', 'upload.incremental', 'relay.production', 'qingyu.sync')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, project_id, component_key),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id),
  FOREIGN KEY (account_id, updated_by) REFERENCES users(account_id, id)
) STRICT;
CREATE TABLE project_management_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id),
  FOREIGN KEY (account_id, actor_id) REFERENCES users(account_id, id)
) STRICT;
CREATE TRIGGER project_management_events_no_update BEFORE UPDATE ON project_management_events
BEGIN SELECT RAISE(ABORT, 'project management audit is immutable'); END;
CREATE TRIGGER project_management_events_no_delete BEFORE DELETE ON project_management_events
BEGIN SELECT RAISE(ABORT, 'project management audit is append-only'); END;

CREATE TABLE project_identity_links (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_user_id TEXT NOT NULL,
  canonical_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_by_user_id TEXT,
  revoked_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK (source_user_id <> canonical_user_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id),
  FOREIGN KEY (account_id, source_user_id) REFERENCES users(account_id, id),
  FOREIGN KEY (account_id, canonical_user_id) REFERENCES users(account_id, id)
) STRICT;
CREATE UNIQUE INDEX project_identity_links_active_source ON project_identity_links(account_id, project_id, source_user_id) WHERE status = 'active';
INSERT INTO project_identity_links
SELECT link.id || ':' || membership.project_id, link.account_id, membership.project_id,
       link.source_user_id, link.canonical_user_id, link.status, link.created_by_user_id,
       link.created_at, link.revoked_by_user_id, link.revoked_at, link.version
FROM user_identity_links AS link JOIN memberships AS membership
  ON membership.account_id = link.account_id AND membership.user_id = link.source_user_id;
CREATE TRIGGER project_identity_links_transition_guard BEFORE UPDATE ON project_identity_links
WHEN NOT (old.status = 'active' AND new.status = 'revoked'
  AND new.id IS old.id AND new.account_id IS old.account_id AND new.project_id IS old.project_id
  AND new.source_user_id IS old.source_user_id AND new.canonical_user_id IS old.canonical_user_id
  AND new.created_by_user_id IS old.created_by_user_id AND new.created_at IS old.created_at
  AND new.revoked_by_user_id IS NOT NULL AND unixepoch(new.revoked_at) IS NOT NULL
  AND new.version = old.version + 1)
BEGIN SELECT RAISE(ABORT, 'project identity links use an exact revoke transition'); END;
CREATE TRIGGER project_identity_links_no_delete BEFORE DELETE ON project_identity_links
BEGIN SELECT RAISE(ABORT, 'project identity link history is append-only'); END;

-- Existing SQL invariants still inspect legacy flags. All employees receive the
-- same compatibility flags; these flags are no longer configurable identities.
INSERT OR IGNORE INTO membership_roles(account_id, project_id, membership_id, role, granted_at)
SELECT membership.account_id, membership.project_id, membership.id, capability.role, membership.created_at
FROM memberships AS membership CROSS JOIN (
  SELECT 'viewer' AS role UNION ALL SELECT 'reporter' UNION ALL SELECT 'developer'
  UNION ALL SELECT 'verifier' UNION ALL SELECT 'triager' UNION ALL SELECT 'release_manager'
  UNION ALL SELECT 'project_admin'
) AS capability;
`;
