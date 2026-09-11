/**
 * Project onboarding is additive. Historical projects keep their stable IDs,
 * data and memberships, but receive no default join code or public join name.
 * A GM must explicitly issue an initialization link before a legacy project can
 * accept a new name-and-code login.
 */
export const PROJECT_ONBOARDING_SQL = String.raw`
CREATE TABLE project_onboarding (
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  join_name TEXT,
  join_name_key TEXT,
  initialization_status TEXT NOT NULL CHECK (initialization_status IN ('pending', 'ready')),
  join_code_digest TEXT CHECK (join_code_digest IS NULL OR (length(join_code_digest) = 64 AND join_code_digest = lower(join_code_digest))),
  join_code_ciphertext TEXT CHECK (join_code_ciphertext IS NULL OR length(join_code_ciphertext) BETWEEN 20 AND 500),
  join_code_version INTEGER NOT NULL DEFAULT 0 CHECK (join_code_version >= 0),
  initialization_token_digest TEXT CHECK (initialization_token_digest IS NULL OR (length(initialization_token_digest) = 64 AND initialization_token_digest = lower(initialization_token_digest))),
  initialization_token_ciphertext TEXT CHECK (initialization_token_ciphertext IS NULL OR length(initialization_token_ciphertext) BETWEEN 20 AND 1000),
  initialization_token_status TEXT NOT NULL CHECK (initialization_token_status IN ('absent', 'issued', 'used', 'revoked')),
  initialization_submission_digest TEXT CHECK (initialization_submission_digest IS NULL OR (length(initialization_submission_digest) = 64 AND initialization_submission_digest = lower(initialization_submission_digest))),
  initialization_issued_at TEXT,
  initialization_used_at TEXT,
  initialization_revoked_at TEXT,
  logo_media_type TEXT CHECK (logo_media_type IS NULL OR logo_media_type IN ('image/png', 'image/jpeg', 'image/webp')),
  logo_sha256 TEXT CHECK (logo_sha256 IS NULL OR (length(logo_sha256) = 64 AND logo_sha256 = lower(logo_sha256))),
  logo_bytes BLOB CHECK (logo_bytes IS NULL OR length(logo_bytes) <= 524288),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  version INTEGER NOT NULL CHECK (version >= 1),
  PRIMARY KEY (account_id, project_id),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE,
  CHECK ((join_name IS NULL) = (join_name_key IS NULL)),
  CHECK ((join_code_digest IS NULL) = (join_code_ciphertext IS NULL)),
  CHECK ((join_code_digest IS NULL) = (join_code_version = 0)),
  CHECK ((initialization_token_digest IS NULL) = (initialization_token_ciphertext IS NULL)),
  CHECK ((logo_bytes IS NULL) = (logo_media_type IS NULL)),
  CHECK ((logo_bytes IS NULL) = (logo_sha256 IS NULL)),
  CHECK (
    (initialization_token_status = 'absent' AND initialization_token_digest IS NULL AND initialization_issued_at IS NULL AND initialization_used_at IS NULL AND initialization_revoked_at IS NULL)
    OR (initialization_token_status = 'issued' AND initialization_token_digest IS NOT NULL AND initialization_issued_at IS NOT NULL AND initialization_used_at IS NULL AND initialization_revoked_at IS NULL)
    OR (initialization_token_status = 'used' AND initialization_token_digest IS NOT NULL AND initialization_issued_at IS NOT NULL AND initialization_used_at IS NOT NULL AND initialization_revoked_at IS NULL)
    OR (initialization_token_status = 'revoked' AND initialization_token_digest IS NOT NULL AND initialization_issued_at IS NOT NULL AND initialization_revoked_at IS NOT NULL)
  ),
  CHECK ((initialization_status = 'ready') = (join_name_key IS NOT NULL AND join_code_digest IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX project_onboarding_join_name_unique
  ON project_onboarding(account_id, join_name_key)
  WHERE join_name_key IS NOT NULL;
CREATE UNIQUE INDEX project_onboarding_initialization_token_unique
  ON project_onboarding(initialization_token_digest)
  WHERE initialization_token_digest IS NOT NULL;

CREATE TABLE project_member_names (
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name_key TEXT NOT NULL CHECK (length(name_key) BETWEEN 1 AND 200),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  PRIMARY KEY (account_id, project_id, name_key),
  FOREIGN KEY (account_id, project_id, user_id)
    REFERENCES memberships(account_id, project_id, user_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX project_member_names_user_unique
  ON project_member_names(account_id, project_id, user_id);

INSERT INTO project_onboarding(
  account_id, project_id, initialization_status, join_code_version,
  initialization_token_status, created_at, updated_at, version
)
SELECT account_id, id, 'pending', 0, 'absent', created_at, updated_at, 1
FROM projects;

CREATE TRIGGER project_onboarding_seed_after_project_insert
AFTER INSERT ON projects
BEGIN
  INSERT INTO project_onboarding(
    account_id, project_id, initialization_status, join_code_version,
    initialization_token_status, created_at, updated_at, version
  ) VALUES (
    new.account_id, new.id, 'pending', 0, 'absent', new.created_at, new.updated_at, 1
  );
END;
`;
