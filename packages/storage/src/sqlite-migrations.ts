import { createHash } from "node:crypto";

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const CORE_SCHEMA_SQL = String.raw`
CREATE TABLE accounts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(slug) BETWEEN 2 AND 80),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  version INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  email TEXT NOT NULL COLLATE NOCASE CHECK (length(email) BETWEEN 3 AND 320),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  UNIQUE (account_id, id),
  UNIQUE (account_id, email)
) STRICT;

CREATE TABLE service_principals (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  principal_type TEXT NOT NULL CHECK (principal_type IN ('relay', 'build_provider', 'worker')),
  credential_digest TEXT NOT NULL CHECK (length(credential_digest) = 64 AND credential_digest = lower(credential_digest)),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  revoked_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  UNIQUE (account_id, id),
  UNIQUE (account_id, name),
  UNIQUE (credential_digest)
) STRICT;

CREATE TABLE local_credentials (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  user_id TEXT NOT NULL CHECK (length(user_id) = 36),
  password_hash TEXT NOT NULL CHECK (length(password_hash) BETWEEN 40 AND 1000),
  algorithm TEXT NOT NULL CHECK (algorithm IN ('argon2id', 'scrypt')),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TEXT,
  changed_at TEXT NOT NULL CHECK (length(changed_at) >= 20),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id, user_id)
    REFERENCES users(account_id, id) ON DELETE CASCADE,
  UNIQUE (account_id, user_id)
) STRICT;

CREATE TABLE device_installations (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  installation_id TEXT NOT NULL CHECK (length(installation_id) = 36),
  platform TEXT NOT NULL CHECK (platform = 'android'),
  app_version TEXT NOT NULL CHECK (length(app_version) BETWEEN 1 AND 100),
  device_metadata_json TEXT NOT NULL CHECK (json_valid(device_metadata_json)),
  shared_device INTEGER NOT NULL DEFAULT 0 CHECK (shared_device IN (0, 1)),
  first_seen_at TEXT NOT NULL CHECK (length(first_seen_at) >= 20),
  last_seen_at TEXT NOT NULL CHECK (length(last_seen_at) >= 20 AND last_seen_at >= first_seen_at),
  revoked_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  UNIQUE (account_id, id),
  UNIQUE (account_id, id, shared_device),
  UNIQUE (account_id, installation_id)
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_key TEXT NOT NULL COLLATE NOCASE
    CHECK (
      length(project_key) BETWEEN 2 AND 16
      AND project_key = upper(project_key)
      AND substr(project_key, 1, 1) GLOB '[A-Z]'
      AND project_key NOT GLOB '*[^A-Z0-9]*'
    ),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  UNIQUE (account_id, id),
  UNIQUE (account_id, project_key)
) STRICT;

CREATE TABLE project_bug_counters (
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  last_number INTEGER NOT NULL CHECK (last_number >= 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  PRIMARY KEY (account_id, project_id),
  FOREIGN KEY (account_id, project_id)
    REFERENCES projects(account_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE memberships (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  user_id TEXT NOT NULL CHECK (length(user_id) = 36),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id, project_id)
    REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, user_id)
    REFERENCES users(account_id, id) ON DELETE CASCADE,
  UNIQUE (account_id, project_id, user_id),
  UNIQUE (account_id, project_id, id)
) STRICT;

CREATE TABLE membership_roles (
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  membership_id TEXT NOT NULL CHECK (length(membership_id) = 36),
  role TEXT NOT NULL CHECK (role IN (
    'viewer', 'reporter', 'developer', 'verifier', 'triager',
    'release_manager', 'project_admin'
  )),
  granted_at TEXT NOT NULL CHECK (length(granted_at) >= 20),
  PRIMARY KEY (account_id, project_id, membership_id, role),
  FOREIGN KEY (account_id, project_id, membership_id)
    REFERENCES memberships(account_id, project_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE modules (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id, project_id)
    REFERENCES projects(account_id, id) ON DELETE CASCADE,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, name)
) STRICT;

CREATE TABLE bugs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  number INTEGER NOT NULL CHECK (number >= 1),
  key TEXT NOT NULL COLLATE NOCASE CHECK (length(key) BETWEEN 4 AND 40),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 20000),
  expected_behavior TEXT NOT NULL CHECK (length(expected_behavior) BETWEEN 1 AND 10000),
  module_id TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'reported', 'needs_info', 'ready', 'in_progress', 'awaiting_build',
    'ready_for_verification', 'closed', 'deferred', 'rejected', 'duplicate'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('S0', 'S1', 'S2', 'S3', 'S4')),
  priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3', 'P4')),
  reporter_id TEXT NOT NULL CHECK (length(reporter_id) = 36),
  owner_id TEXT,
  verification_owner_id TEXT,
  duplicate_of_bug_id TEXT,
  active_repair_attempt_id TEXT,
  active_verification_id TEXT,
  occurrence_count INTEGER NOT NULL CHECK (occurrence_count >= 1),
  reopen_count INTEGER NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  closed_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK (
    (state = 'closed' AND closed_at IS NOT NULL)
    OR (state <> 'closed' AND closed_at IS NULL)
  ),
  CHECK (duplicate_of_bug_id IS NULL OR duplicate_of_bug_id <> id),
  FOREIGN KEY (account_id, project_id)
    REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, project_id, module_id)
    REFERENCES modules(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, reporter_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, owner_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, verification_owner_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, duplicate_of_bug_id)
    REFERENCES bugs(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, active_repair_attempt_id, id)
    REFERENCES repair_attempts(account_id, project_id, id, bug_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (account_id, project_id, active_verification_id, id)
    REFERENCES verifications(account_id, project_id, id, bug_id)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, number),
  UNIQUE (account_id, key)
) STRICT;

CREATE TABLE occurrences (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  bug_id TEXT NOT NULL CHECK (length(bug_id) = 36),
  reporter_id TEXT NOT NULL CHECK (length(reporter_id) = 36),
  client_submission_id TEXT NOT NULL CHECK (length(client_submission_id) = 36),
  observed_at TEXT NOT NULL CHECK (length(observed_at) >= 20 AND unixepoch(observed_at) IS NOT NULL),
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'windows', 'macos', 'linux', 'web', 'other')),
  app_version TEXT CHECK (app_version IS NULL OR length(app_version) <= 100),
  resource_version TEXT CHECK (resource_version IS NULL OR length(resource_version) <= 100),
  git_sha TEXT CHECK (git_sha IS NULL OR (length(git_sha) = 40 AND git_sha = lower(git_sha) AND git_sha NOT GLOB '*[^0-9a-f]*')),
  device_model TEXT CHECK (device_model IS NULL OR length(device_model) <= 200),
  os_version TEXT CHECK (os_version IS NULL OR length(os_version) <= 100),
  steps_json TEXT NOT NULL CHECK (
    json_valid(steps_json)
    AND json_type(steps_json) = 'array'
    AND json_array_length(steps_json) BETWEEN 1 AND 50
  ),
  actual_behavior TEXT NOT NULL CHECK (length(actual_behavior) BETWEEN 1 AND 10000),
  frequency TEXT CHECK (frequency IS NULL OR length(frequency) <= 100),
  error_signature TEXT CHECK (error_signature IS NULL OR length(error_signature) <= 500),
  environment_json TEXT CHECK (
    environment_json IS NULL
    OR (
      json_valid(environment_json)
      AND json_type(environment_json) = 'object'
      AND length(CAST(environment_json AS BLOB)) <= 256
    )
  ),
  build_id TEXT GENERATED ALWAYS AS (
    json_extract(environment_json, '$.buildId')
  ) STORED,
  capture_bundle_id TEXT CHECK (capture_bundle_id IS NULL OR length(capture_bundle_id) = 36),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id, project_id, bug_id)
    REFERENCES bugs(account_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, reporter_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, capture_bundle_id, reporter_id)
    REFERENCES capture_bundles(account_id, project_id, id, actor_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (account_id, project_id, build_id)
    REFERENCES builds(account_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, id, bug_id),
  UNIQUE (account_id, project_id, client_submission_id)
) STRICT;

CREATE TRIGGER occurrences_contract_insert
BEFORE INSERT ON occurrences
WHEN EXISTS (
  SELECT 1 FROM json_each(new.steps_json)
  WHERE type <> 'text' OR length(value) NOT BETWEEN 1 AND 1000
)
OR (
  new.environment_json IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM json_each(new.environment_json)
    WHERE key NOT IN ('qaAppVersion', 'testSessionId', 'buildId', 'networkType', 'networkMetered', 'orientation')
      OR (key = 'qaAppVersion' AND (type <> 'text' OR length(value) NOT BETWEEN 1 AND 100))
      OR (key IN ('testSessionId', 'buildId') AND type NOT IN ('text', 'null'))
      OR (key IN ('testSessionId', 'buildId') AND type = 'text' AND length(value) <> 36)
      OR (key = 'networkType' AND (type <> 'text' OR value NOT IN ('wifi', 'cellular', 'ethernet', 'vpn', 'offline', 'other', 'unknown')))
      OR (key = 'networkMetered' AND type NOT IN ('true', 'false', 'null'))
      OR (key = 'orientation' AND (type <> 'text' OR value NOT IN ('portrait', 'landscape', 'square', 'unknown')))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'occurrence payload violates frozen App-first contract');
END;

CREATE TRIGGER occurrences_contract_update
BEFORE UPDATE OF steps_json, environment_json ON occurrences
WHEN EXISTS (
  SELECT 1 FROM json_each(new.steps_json)
  WHERE type <> 'text' OR length(value) NOT BETWEEN 1 AND 1000
)
OR (
  new.environment_json IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM json_each(new.environment_json)
    WHERE key NOT IN ('qaAppVersion', 'testSessionId', 'buildId', 'networkType', 'networkMetered', 'orientation')
      OR (key = 'qaAppVersion' AND (type <> 'text' OR length(value) NOT BETWEEN 1 AND 100))
      OR (key IN ('testSessionId', 'buildId') AND type NOT IN ('text', 'null'))
      OR (key IN ('testSessionId', 'buildId') AND type = 'text' AND length(value) <> 36)
      OR (key = 'networkType' AND (type <> 'text' OR value NOT IN ('wifi', 'cellular', 'ethernet', 'vpn', 'offline', 'other', 'unknown')))
      OR (key = 'networkMetered' AND type NOT IN ('true', 'false', 'null'))
      OR (key = 'orientation' AND (type <> 'text' OR value NOT IN ('portrait', 'landscape', 'square', 'unknown')))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'occurrence payload violates frozen App-first contract');
END;

CREATE TABLE comments (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  bug_id TEXT NOT NULL CHECK (length(bug_id) = 36),
  author_id TEXT NOT NULL CHECK (length(author_id) = 36),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  client_submission_id TEXT NOT NULL CHECK (length(client_submission_id) = 36),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id, project_id, bug_id)
    REFERENCES bugs(account_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, author_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, id, bug_id),
  UNIQUE (account_id, project_id, client_submission_id)
) STRICT;

CREATE TABLE builds (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  provider TEXT NOT NULL CHECK (provider IN ('manual', 'ozdqp', 'custom')),
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 300),
  version_name TEXT NOT NULL CHECK (length(version_name) BETWEEN 1 AND 100),
  channel TEXT NOT NULL CHECK (length(channel) BETWEEN 1 AND 100),
  project_key TEXT NOT NULL CHECK (length(project_key) BETWEEN 2 AND 16),
  branch TEXT NOT NULL CHECK (length(branch) BETWEEN 1 AND 300),
  source_commit_sha TEXT NOT NULL CHECK (length(source_commit_sha) = 40 AND source_commit_sha = lower(source_commit_sha)),
  mode TEXT NOT NULL CHECK (mode IN ('full', 'hot_update', 'cdn', 'debug', 'other')),
  status TEXT NOT NULL CHECK (status IN ('registered', 'queued', 'building', 'validating', 'publishing', 'ready', 'failed')),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64 AND manifest_digest = lower(manifest_digest)),
  artifact_sha256 TEXT CHECK (artifact_sha256 IS NULL OR (length(artifact_sha256) = 64 AND artifact_sha256 = lower(artifact_sha256))),
  download_url TEXT CHECK (download_url IS NULL OR length(download_url) <= 4000),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK (status <> 'ready' OR (artifact_sha256 IS NOT NULL AND download_url IS NOT NULL)),
  FOREIGN KEY (account_id, project_id)
    REFERENCES projects(account_id, id) ON DELETE CASCADE,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, provider, external_id)
) STRICT;

CREATE TABLE build_manifest_commits (
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  build_id TEXT NOT NULL CHECK (length(build_id) = 36),
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) = 40 AND commit_sha = lower(commit_sha)),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (account_id, project_id, build_id, commit_sha),
  FOREIGN KEY (account_id, project_id, build_id)
    REFERENCES builds(account_id, project_id, id) ON DELETE CASCADE,
  UNIQUE (account_id, project_id, build_id, ordinal)
) STRICT;

CREATE TABLE repair_attempts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  bug_id TEXT NOT NULL CHECK (length(bug_id) = 36),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('human', 'relay', 'external')),
  status TEXT NOT NULL CHECK (status IN (
    'planned', 'queued', 'running', 'needs_input', 'blocked', 'delivered',
    'failed', 'verification_failed', 'cancelled', 'superseded'
  )),
  assignee_id TEXT NOT NULL CHECK (length(assignee_id) = 36),
  parent_attempt_id TEXT,
  summary TEXT CHECK (summary IS NULL OR length(summary) <= 10000),
  branch TEXT CHECK (branch IS NULL OR length(branch) <= 300),
  commit_sha TEXT CHECK (commit_sha IS NULL OR (length(commit_sha) = 40 AND commit_sha = lower(commit_sha))),
  merge_request_url TEXT CHECK (merge_request_url IS NULL OR length(merge_request_url) <= 4000),
  patch_url TEXT CHECK (patch_url IS NULL OR length(patch_url) <= 4000),
  no_code_reason TEXT CHECK (no_code_reason IS NULL OR length(no_code_reason) <= 5000),
  target_build_id TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK (parent_attempt_id IS NULL OR parent_attempt_id <> id),
  FOREIGN KEY (account_id, project_id, bug_id)
    REFERENCES bugs(account_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, assignee_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, parent_attempt_id, bug_id)
    REFERENCES repair_attempts(account_id, project_id, id, bug_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, target_build_id)
    REFERENCES builds(account_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, id, bug_id),
  UNIQUE (account_id, project_id, bug_id, sequence)
) STRICT;

CREATE TABLE build_requirements (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  bug_id TEXT NOT NULL CHECK (length(bug_id) = 36),
  repair_attempt_id TEXT NOT NULL CHECK (length(repair_attempt_id) = 36),
  source_delivery_version INTEGER NOT NULL CHECK (source_delivery_version >= 1),
  delivered_commit_sha TEXT CHECK (delivered_commit_sha IS NULL OR (length(delivered_commit_sha) = 40 AND delivered_commit_sha = lower(delivered_commit_sha))),
  requirement TEXT NOT NULL CHECK (requirement IN ('required', 'not_required')),
  decision_basis TEXT NOT NULL CHECK (decision_basis IN ('code_requires_build', 'no_code_delivery', 'authorized_no_build_exemption')),
  decision_reason TEXT CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 1 AND 5000),
  decision_actor_id TEXT NOT NULL CHECK (length(decision_actor_id) = 36),
  decision_audit_event_id TEXT NOT NULL CHECK (length(decision_audit_event_id) = 36),
  delivery_request_digest TEXT NOT NULL CHECK (length(delivery_request_digest) = 64 AND delivery_request_digest = lower(delivery_request_digest)),
  linked_build_id TEXT,
  link_id TEXT,
  policy_version TEXT NOT NULL CHECK (policy_version = '1.0.0'),
  bug_version_at_delivery INTEGER NOT NULL CHECK (bug_version_at_delivery >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  version INTEGER NOT NULL CHECK (version IN (1, 2)),
  CHECK (
    (requirement = 'required' AND decision_basis = 'code_requires_build' AND delivered_commit_sha IS NOT NULL AND decision_reason IS NULL)
    OR (requirement = 'not_required' AND decision_basis = 'no_code_delivery' AND delivered_commit_sha IS NULL AND decision_reason IS NOT NULL)
    OR (requirement = 'not_required' AND decision_basis = 'authorized_no_build_exemption' AND delivered_commit_sha IS NOT NULL AND decision_reason IS NOT NULL)
  ),
  CHECK (
    (version = 1 AND linked_build_id IS NULL AND link_id IS NULL)
    OR (version = 2 AND requirement = 'required' AND linked_build_id IS NOT NULL AND link_id IS NOT NULL)
  ),
  FOREIGN KEY (account_id, project_id, bug_id)
    REFERENCES bugs(account_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, project_id, repair_attempt_id, bug_id)
    REFERENCES repair_attempts(account_id, project_id, id, bug_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, decision_actor_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, linked_build_id)
    REFERENCES builds(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, link_id)
    REFERENCES build_repair_links(account_id, project_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (account_id, project_id, decision_audit_event_id)
    REFERENCES events(account_id, project_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (account_id, project_id, id),
  UNIQUE (
    account_id, project_id, id, bug_id, repair_attempt_id,
    version, delivered_commit_sha
  ),
  UNIQUE (account_id, project_id, repair_attempt_id)
) STRICT;

CREATE TABLE build_repair_links (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  bug_id TEXT NOT NULL CHECK (length(bug_id) = 36),
  repair_attempt_id TEXT NOT NULL CHECK (length(repair_attempt_id) = 36),
  build_id TEXT NOT NULL CHECK (length(build_id) = 36),
  build_requirement_id TEXT NOT NULL CHECK (length(build_requirement_id) = 36),
  build_requirement_version INTEGER NOT NULL CHECK (build_requirement_version = 2),
  delivered_commit_sha TEXT NOT NULL CHECK (length(delivered_commit_sha) = 40 AND delivered_commit_sha = lower(delivered_commit_sha)),
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('manifest', 'release_manager_override')),
  evidence_decision TEXT NOT NULL CHECK (evidence_decision IN ('manifest_verified', 'release_manager_authorized')),
  override_reason TEXT CHECK (override_reason IS NULL OR length(override_reason) BETWEEN 1 AND 5000),
  evidence_actor_id TEXT NOT NULL CHECK (length(evidence_actor_id) = 36),
  evidence_audit_event_id TEXT NOT NULL CHECK (length(evidence_audit_event_id) = 36),
  evidence_policy_version TEXT NOT NULL CHECK (evidence_policy_version = '1.0.0'),
  linked_at TEXT NOT NULL CHECK (length(linked_at) >= 20),
  version INTEGER NOT NULL CHECK (version = 1),
  CHECK (
    (evidence_type = 'manifest' AND evidence_decision = 'manifest_verified' AND override_reason IS NULL)
    OR (evidence_type = 'release_manager_override' AND evidence_decision = 'release_manager_authorized' AND override_reason IS NOT NULL)
  ),
  FOREIGN KEY (account_id, project_id, bug_id)
    REFERENCES bugs(account_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, project_id, repair_attempt_id, bug_id)
    REFERENCES repair_attempts(account_id, project_id, id, bug_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, project_id, build_id)
    REFERENCES builds(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    account_id, project_id, build_requirement_id, bug_id, repair_attempt_id,
    build_requirement_version, delivered_commit_sha
  ) REFERENCES build_requirements(
    account_id, project_id, id, bug_id, repair_attempt_id,
    version, delivered_commit_sha
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (account_id, evidence_actor_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, evidence_audit_event_id)
    REFERENCES events(account_id, project_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, repair_attempt_id),
  UNIQUE (account_id, project_id, build_requirement_id)
) STRICT;

CREATE TRIGGER build_requirements_update_guard
BEFORE UPDATE ON build_requirements
WHEN NOT (
  old.version = 1
  AND new.version = 2
  AND new.id IS old.id
  AND new.account_id IS old.account_id
  AND new.project_id IS old.project_id
  AND new.bug_id IS old.bug_id
  AND new.repair_attempt_id IS old.repair_attempt_id
  AND new.source_delivery_version IS old.source_delivery_version
  AND new.delivered_commit_sha IS old.delivered_commit_sha
  AND new.requirement IS old.requirement
  AND new.decision_basis IS old.decision_basis
  AND new.decision_reason IS old.decision_reason
  AND new.decision_actor_id IS old.decision_actor_id
  AND new.decision_audit_event_id IS old.decision_audit_event_id
  AND new.delivery_request_digest IS old.delivery_request_digest
  AND new.policy_version IS old.policy_version
  AND new.bug_version_at_delivery IS old.bug_version_at_delivery
  AND new.created_at IS old.created_at
  AND new.updated_at > old.updated_at
)
BEGIN
  SELECT RAISE(ABORT, 'build requirement decision is immutable');
END;

CREATE TRIGGER build_requirements_no_delete
BEFORE DELETE ON build_requirements
BEGIN
  SELECT RAISE(ABORT, 'build requirements are append-only');
END;

CREATE TRIGGER build_requirements_typed_decision_audit
BEFORE INSERT ON build_requirements
WHEN NOT EXISTS (
  SELECT 1 FROM events AS event
  WHERE event.id = new.decision_audit_event_id
    AND event.account_id = new.account_id
    AND event.project_id = new.project_id
    AND event.bug_id = new.bug_id
    AND event.source = 'qa_hub'
    AND event.actor_type = 'user'
    AND event.actor_user_id = new.decision_actor_id
    AND event.type = 'repair.delivered'
    AND event.aggregate_type = 'repair_attempt'
    AND event.aggregate_id = new.repair_attempt_id
    AND event.resource_type = 'build_requirement'
    AND event.resource_id = new.id
    AND event.resource_version_after = 1
    AND event.request_digest = new.delivery_request_digest
    AND json_extract(event.payload_json, '$.repairAttemptId') = new.repair_attempt_id
    AND json_extract(event.payload_json, '$.buildRequirementId') = new.id
    AND json_extract(event.payload_json, '$.sourceDeliveryVersion') = new.source_delivery_version
    AND json_extract(event.payload_json, '$.deliveredCommitSha') IS new.delivered_commit_sha
    AND json_extract(event.payload_json, '$.requirement') = new.requirement
    AND json_extract(event.payload_json, '$.decisionBasis') = new.decision_basis
    AND json_extract(event.payload_json, '$.decisionReason') IS new.decision_reason
    AND json_extract(event.payload_json, '$.actorId') = new.decision_actor_id
    AND json_extract(event.payload_json, '$.deliveryRequestDigest') = new.delivery_request_digest
    AND json_extract(event.payload_json, '$.policyVersion') = new.policy_version
    AND json_extract(event.payload_json, '$.serverPolicyEvaluatedAtDelivery') = 1
    AND json_extract(event.payload_json, '$.authorizedNoBuildExemptionAtDelivery') = (new.decision_basis = 'authorized_no_build_exemption')
    AND json_extract(event.payload_json, '$.noCodeDecisionValidatedAtDelivery') = (new.decision_basis = 'no_code_delivery')
    AND json_extract(event.payload_json, '$.committed') = 1
    AND json_extract(event.payload_json, '$.atomicWithDelivery') = 1
)
BEGIN
  SELECT RAISE(ABORT, 'BuildRequirement requires its exact typed delivery audit');
END;

CREATE TRIGGER build_requirements_exemption_authority
BEFORE INSERT ON build_requirements
WHEN new.decision_basis = 'authorized_no_build_exemption' AND NOT EXISTS (
  SELECT 1
  FROM memberships AS membership
  JOIN membership_roles AS membership_role
    ON membership_role.account_id = membership.account_id
   AND membership_role.project_id = membership.project_id
   AND membership_role.membership_id = membership.id
  WHERE membership.account_id = new.account_id
    AND membership.project_id = new.project_id
    AND membership.user_id = new.decision_actor_id
    AND membership.status = 'active'
    AND membership_role.role IN ('release_manager', 'project_admin')
)
BEGIN
  SELECT RAISE(ABORT, 'no-build exemption requires current release authority');
END;

CREATE TRIGGER build_repair_links_manifest_evidence
BEFORE INSERT ON build_repair_links
WHEN new.evidence_type = 'manifest' AND NOT EXISTS (
  SELECT 1
  FROM builds AS build
  JOIN build_manifest_commits AS manifest_commit
    ON manifest_commit.account_id = build.account_id
   AND manifest_commit.project_id = build.project_id
   AND manifest_commit.build_id = build.id
  WHERE build.account_id = new.account_id
    AND build.project_id = new.project_id
    AND build.id = new.build_id
    AND build.status = 'ready'
    AND manifest_commit.commit_sha = new.delivered_commit_sha
)
BEGIN
  SELECT RAISE(ABORT, 'manifest evidence must contain the exact delivered commit');
END;

CREATE TRIGGER build_repair_links_override_authority
BEFORE INSERT ON build_repair_links
WHEN new.evidence_type = 'release_manager_override' AND NOT EXISTS (
  SELECT 1
  FROM memberships AS membership
  JOIN membership_roles AS membership_role
    ON membership_role.account_id = membership.account_id
   AND membership_role.project_id = membership.project_id
   AND membership_role.membership_id = membership.id
  WHERE membership.account_id = new.account_id
    AND membership.project_id = new.project_id
    AND membership.user_id = new.evidence_actor_id
    AND membership.status = 'active'
    AND membership_role.role IN ('release_manager', 'project_admin')
)
BEGIN
  SELECT RAISE(ABORT, 'build override requires current release authority');
END;

CREATE TRIGGER build_repair_links_typed_evidence_audit
BEFORE INSERT ON build_repair_links
WHEN NOT EXISTS (
  SELECT 1 FROM events AS event
  WHERE event.id = new.evidence_audit_event_id
    AND event.account_id = new.account_id
    AND event.project_id = new.project_id
    AND event.bug_id = new.bug_id
    AND event.source = 'qa_hub'
    AND event.actor_type = 'user'
    AND event.actor_user_id = new.evidence_actor_id
    AND event.type = 'build.repair_linked'
    AND event.aggregate_type = 'repair_attempt'
    AND event.aggregate_id = new.repair_attempt_id
    AND event.resource_type = 'build_repair_link'
    AND event.resource_id = new.id
    AND event.resource_version_after = new.version
    AND json_extract(event.payload_json, '$.repairAttemptId') = new.repair_attempt_id
    AND json_extract(event.payload_json, '$.buildId') = new.build_id
    AND json_extract(event.payload_json, '$.linkId') = new.id
    AND json_extract(event.payload_json, '$.deliveredCommitSha') = new.delivered_commit_sha
    AND json_extract(event.payload_json, '$.evidenceType') = new.evidence_type
    AND json_extract(event.payload_json, '$.evidenceDecision') = new.evidence_decision
    AND json_extract(event.payload_json, '$.overrideReason') IS new.override_reason
    AND json_extract(event.payload_json, '$.policyVersion') = new.evidence_policy_version
    AND json_extract(event.payload_json, '$.manifestVerifiedAtLink') = (new.evidence_type = 'manifest')
    AND json_extract(event.payload_json, '$.releaseManagerAuthorizedAtLink') = (new.evidence_type = 'release_manager_override')
    AND json_extract(event.payload_json, '$.committed') = 1
    AND json_extract(event.payload_json, '$.atomicWithLink') = 1
)
BEGIN
  SELECT RAISE(ABORT, 'build repair link requires its exact typed evidence audit');
END;

CREATE TRIGGER build_repair_links_no_update
BEFORE UPDATE ON build_repair_links
BEGIN
  SELECT RAISE(ABORT, 'build repair links are immutable');
END;

CREATE TRIGGER build_repair_links_no_delete
BEFORE DELETE ON build_repair_links
BEGIN
  SELECT RAISE(ABORT, 'build repair links are append-only');
END;

CREATE TABLE verifications (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  bug_id TEXT NOT NULL CHECK (length(bug_id) = 36),
  repair_attempt_id TEXT NOT NULL CHECK (length(repair_attempt_id) = 36),
  build_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('requested', 'in_progress', 'passed', 'failed', 'blocked', 'cancelled')),
  verifier_id TEXT NOT NULL CHECK (length(verifier_id) = 36),
  criteria_snapshot TEXT NOT NULL CHECK (length(criteria_snapshot) BETWEEN 1 AND 10000),
  result_summary TEXT CHECK (result_summary IS NULL OR length(result_summary) <= 10000),
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) <= 5000),
  blocked_reason TEXT CHECK (blocked_reason IS NULL OR length(blocked_reason) <= 5000),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CHECK ((status = 'blocked') = (blocked_reason IS NOT NULL)),
  FOREIGN KEY (account_id, project_id, bug_id)
    REFERENCES bugs(account_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, project_id, repair_attempt_id, bug_id)
    REFERENCES repair_attempts(account_id, project_id, id, bug_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, build_id)
    REFERENCES builds(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, verifier_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, id, bug_id)
) STRICT;

CREATE TRIGGER verifications_exact_build_requirement
BEFORE INSERT ON verifications
WHEN NOT EXISTS (
  SELECT 1
  FROM build_requirements AS requirement
  WHERE requirement.account_id = new.account_id
    AND requirement.project_id = new.project_id
    AND requirement.bug_id = new.bug_id
    AND requirement.repair_attempt_id = new.repair_attempt_id
    AND (
      (
        requirement.requirement = 'not_required'
        AND requirement.version = 1
        AND requirement.linked_build_id IS NULL
        AND new.build_id IS NULL
      )
      OR (
        requirement.requirement = 'required'
        AND requirement.version = 2
        AND requirement.linked_build_id = new.build_id
        AND EXISTS (
          SELECT 1 FROM build_repair_links AS link
          WHERE link.account_id = requirement.account_id
            AND link.project_id = requirement.project_id
            AND link.bug_id = requirement.bug_id
            AND link.repair_attempt_id = requirement.repair_attempt_id
            AND link.build_requirement_id = requirement.id
            AND link.build_requirement_version = requirement.version
            AND link.build_id = new.build_id
            AND link.delivered_commit_sha = requirement.delivered_commit_sha
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'verification must reuse the exact immutable BuildRequirement and repair link');
END;

CREATE TRIGGER verifications_identity_immutable
BEFORE UPDATE ON verifications
WHEN new.id IS NOT old.id
  OR new.account_id IS NOT old.account_id
  OR new.project_id IS NOT old.project_id
  OR new.bug_id IS NOT old.bug_id
  OR new.repair_attempt_id IS NOT old.repair_attempt_id
  OR new.build_id IS NOT old.build_id
  OR new.verifier_id IS NOT old.verifier_id
  OR new.created_at IS NOT old.created_at
BEGIN
  SELECT RAISE(ABORT, 'verification identity and exact Build evidence are immutable');
END;

CREATE TABLE blobs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 = lower(sha256)),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 524288000),
  storage_key TEXT NOT NULL CHECK (length(storage_key) BETWEEN 1 AND 1000),
  encryption_json TEXT NOT NULL CHECK (json_valid(encryption_json)),
  state TEXT NOT NULL CHECK (state IN ('ready', 'quarantined', 'deleted')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  UNIQUE (account_id, id),
  UNIQUE (account_id, id, size_bytes, sha256, state),
  UNIQUE (account_id, sha256)
) STRICT;

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  actor_id TEXT NOT NULL CHECK (length(actor_id) = 36),
  client_submission_id TEXT NOT NULL CHECK (length(client_submission_id) = 36),
  client_attachment_id TEXT NOT NULL CHECK (length(client_attachment_id) = 36),
  capture_id TEXT CHECK (capture_id IS NULL OR length(capture_id) = 36),
  upload_attempt INTEGER NOT NULL CHECK (upload_attempt >= 1),
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 200),
  expected_size_bytes INTEGER NOT NULL CHECK (expected_size_bytes BETWEEN 1 AND 524288000),
  expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64 AND expected_sha256 = lower(expected_sha256) AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
  received_size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (received_size_bytes >= 0 AND received_size_bytes <= expected_size_bytes),
  chunk_size_bytes INTEGER NOT NULL CHECK (chunk_size_bytes BETWEEN 262144 AND 8388608),
  expected_chunk_count INTEGER NOT NULL CHECK (expected_chunk_count BETWEEN 1 AND 2000),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  finalized_attachment_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'finalizing', 'finalized', 'expired', 'rejected')),
  expires_at TEXT NOT NULL CHECK (length(expires_at) >= 20 AND unixepoch(expires_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND unixepoch(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id, project_id)
    REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, actor_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, finalized_attachment_id, id)
    REFERENCES attachments(account_id, project_id, id, upload_session_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (unixepoch(expires_at) > unixepoch(created_at)),
  CHECK (unixepoch(expires_at) - unixepoch(created_at) <= 3600),
  CHECK (expected_chunk_count = ((expected_size_bytes + chunk_size_bytes - 1) / chunk_size_bytes)),
  CHECK ((status IN ('finalized', 'rejected')) = (finalized_attachment_id IS NOT NULL)),
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, actor_id, client_submission_id, client_attachment_id, upload_attempt)
) STRICT;

CREATE TABLE upload_chunks (
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  upload_session_id TEXT NOT NULL CHECK (length(upload_session_id) = 36),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  offset_bytes INTEGER NOT NULL CHECK (offset_bytes >= 0),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 1),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 = lower(sha256)),
  storage_key TEXT NOT NULL CHECK (length(storage_key) BETWEEN 1 AND 1000),
  received_at TEXT NOT NULL CHECK (length(received_at) >= 20),
  PRIMARY KEY (account_id, project_id, upload_session_id, generation, chunk_index),
  FOREIGN KEY (account_id, project_id, upload_session_id)
    REFERENCES upload_sessions(account_id, project_id, id) ON DELETE CASCADE,
  UNIQUE (account_id, project_id, upload_session_id, generation, offset_bytes),
  UNIQUE (account_id, storage_key)
) STRICT;

CREATE TRIGGER upload_sessions_initial_guard
BEFORE INSERT ON upload_sessions
WHEN new.status <> 'open'
  OR new.received_size_bytes <> 0
  OR new.generation <> 1
  OR new.finalized_attachment_id IS NOT NULL
  OR new.version <> 1
  OR new.updated_at IS NOT new.created_at
  OR abs(unixepoch(new.created_at) - unixepoch('now')) > 600
  OR unixepoch(new.expires_at) <= unixepoch('now')
  OR unixepoch(new.expires_at) > unixepoch('now') + 3600
  OR (
    NOT EXISTS (
      SELECT 1 FROM upload_sessions AS prior
      WHERE prior.account_id = new.account_id
        AND prior.project_id = new.project_id
        AND prior.actor_id = new.actor_id
        AND prior.client_submission_id = new.client_submission_id
        AND prior.client_attachment_id = new.client_attachment_id
    )
    AND new.upload_attempt <> 1
  )
  OR EXISTS (
    SELECT 1 FROM upload_sessions AS prior
    WHERE prior.account_id = new.account_id
      AND prior.project_id = new.project_id
      AND prior.actor_id = new.actor_id
      AND prior.client_submission_id = new.client_submission_id
      AND prior.client_attachment_id = new.client_attachment_id
      AND (
        prior.status NOT IN ('expired', 'rejected')
        OR new.upload_attempt <> (
          SELECT max(sequence_prior.upload_attempt) + 1
          FROM upload_sessions AS sequence_prior
          WHERE sequence_prior.account_id = new.account_id
            AND sequence_prior.project_id = new.project_id
            AND sequence_prior.actor_id = new.actor_id
            AND sequence_prior.client_submission_id = new.client_submission_id
            AND sequence_prior.client_attachment_id = new.client_attachment_id
        )
        OR new.capture_id IS NOT prior.capture_id
        OR new.file_name IS NOT prior.file_name
        OR new.media_type IS NOT prior.media_type
        OR new.expected_size_bytes IS NOT prior.expected_size_bytes
        OR new.expected_sha256 IS NOT prior.expected_sha256
        OR new.chunk_size_bytes IS NOT prior.chunk_size_bytes
        OR new.expected_chunk_count IS NOT prior.expected_chunk_count
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'upload session must start as the exact next unexpired empty lease attempt');
END;

CREATE TRIGGER upload_chunks_geometry_insert
BEFORE INSERT ON upload_chunks
WHEN NOT EXISTS (
  SELECT 1 FROM upload_sessions AS upload
  WHERE upload.account_id = new.account_id
    AND upload.project_id = new.project_id
    AND upload.id = new.upload_session_id
    AND upload.generation = new.generation
    AND upload.status = 'open'
    AND unixepoch(upload.expires_at) > unixepoch('now')
    AND new.chunk_index < upload.expected_chunk_count
    AND new.offset_bytes = new.chunk_index * upload.chunk_size_bytes
    AND (
      (new.chunk_index < upload.expected_chunk_count - 1 AND new.size_bytes = upload.chunk_size_bytes)
      OR (
        new.chunk_index = upload.expected_chunk_count - 1
        AND new.size_bytes = upload.expected_size_bytes - (new.chunk_index * upload.chunk_size_bytes)
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'upload chunk geometry does not match the immutable session layout');
END;

CREATE TABLE attachments (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  actor_id TEXT NOT NULL CHECK (length(actor_id) = 36),
  client_submission_id TEXT NOT NULL CHECK (length(client_submission_id) = 36),
  client_attachment_id TEXT NOT NULL CHECK (length(client_attachment_id) = 36),
  capture_id TEXT CHECK (capture_id IS NULL OR length(capture_id) = 36),
  blob_id TEXT NOT NULL CHECK (length(blob_id) = 36),
  upload_session_id TEXT NOT NULL CHECK (length(upload_session_id) = 36),
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 200),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 524288000),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 = lower(sha256)),
  status TEXT NOT NULL CHECK (status IN ('ready', 'quarantined', 'deleted')),
  scan_state TEXT NOT NULL CHECK (scan_state IN ('pending', 'clean', 'rejected', 'unavailable')),
  quarantine_key TEXT,
  retention_until TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id, project_id)
    REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, actor_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, blob_id, size_bytes, sha256, status)
    REFERENCES blobs(account_id, id, size_bytes, sha256, state)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (account_id, project_id, upload_session_id)
    REFERENCES upload_sessions(account_id, project_id, id) ON DELETE RESTRICT,
  CHECK (status <> 'ready' OR scan_state = 'clean'),
  CHECK (scan_state <> 'clean' OR status IN ('ready', 'deleted')),
  CHECK ((status = 'quarantined') = (quarantine_key IS NOT NULL)),
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, id, actor_id),
  UNIQUE (account_id, project_id, id, upload_session_id),
  UNIQUE (account_id, project_id, upload_session_id),
  UNIQUE (account_id, actor_id, project_id, client_submission_id, client_attachment_id)
) STRICT;

CREATE TRIGGER attachments_match_upload_insert
BEFORE INSERT ON attachments
WHEN NOT EXISTS (
  SELECT 1
  FROM upload_sessions AS upload
  WHERE upload.account_id = new.account_id
    AND upload.project_id = new.project_id
    AND upload.id = new.upload_session_id
    AND upload.actor_id = new.actor_id
    AND upload.client_submission_id = new.client_submission_id
    AND upload.client_attachment_id = new.client_attachment_id
    AND upload.capture_id IS new.capture_id
    AND upload.file_name = new.file_name
    AND upload.media_type = new.media_type
    AND upload.expected_size_bytes = new.size_bytes
    AND upload.expected_sha256 = new.sha256
    AND upload.received_size_bytes = upload.expected_size_bytes
    AND upload.status = 'finalizing'
)
BEGIN
  SELECT RAISE(ABORT, 'attachment metadata does not match completed upload session');
END;

CREATE TRIGGER attachments_initial_guard
BEFORE INSERT ON attachments
WHEN new.version <> 1 OR new.status = 'deleted'
BEGIN
  SELECT RAISE(ABORT, 'attachment scan lifecycle must begin at version one before deletion');
END;

CREATE TRIGGER attachments_identity_immutable
BEFORE UPDATE ON attachments
WHEN new.id IS NOT old.id
  OR new.account_id IS NOT old.account_id
  OR new.project_id IS NOT old.project_id
  OR new.actor_id IS NOT old.actor_id
  OR new.client_submission_id IS NOT old.client_submission_id
  OR new.client_attachment_id IS NOT old.client_attachment_id
  OR new.capture_id IS NOT old.capture_id
  OR new.blob_id IS NOT old.blob_id
  OR new.upload_session_id IS NOT old.upload_session_id
  OR new.file_name IS NOT old.file_name
  OR new.media_type IS NOT old.media_type
  OR new.size_bytes IS NOT old.size_bytes
  OR new.sha256 IS NOT old.sha256
  OR new.created_at IS NOT old.created_at
BEGIN
  SELECT RAISE(ABORT, 'attachment identity and upload metadata are immutable');
END;

CREATE TRIGGER attachments_lifecycle_guard
BEFORE UPDATE ON attachments
WHEN NOT (
  old.status <> 'deleted'
  AND new.version = old.version + 1
  AND (
    (
      new.status IS old.status
      AND new.scan_state IS old.scan_state
      AND new.quarantine_key IS old.quarantine_key
    )
    OR (
      old.status = 'quarantined'
      AND old.scan_state = 'pending'
      AND EXISTS (
        SELECT 1 FROM upload_sessions AS upload
        WHERE upload.account_id = old.account_id
          AND upload.project_id = old.project_id
          AND upload.id = old.upload_session_id
          AND upload.status = 'finalizing'
      )
      AND (
        (
          new.status = 'ready'
          AND new.scan_state = 'clean'
          AND new.quarantine_key IS NULL
        )
        OR (
          new.status = 'quarantined'
          AND new.scan_state IN ('rejected', 'unavailable')
          AND new.quarantine_key IS old.quarantine_key
        )
      )
    )
    OR (
      new.status = 'deleted'
      AND new.scan_state IS old.scan_state
      AND new.quarantine_key IS NULL
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'attachment scan lifecycle requires a one-way exact version CAS');
END;

CREATE TRIGGER attachments_no_delete
BEFORE DELETE ON attachments
BEGIN
  SELECT RAISE(ABORT, 'attachment evidence lifecycle is append-only');
END;

CREATE TRIGGER upload_sessions_identity_immutable
BEFORE UPDATE ON upload_sessions
WHEN new.id IS NOT old.id
  OR new.account_id IS NOT old.account_id
  OR new.project_id IS NOT old.project_id
  OR new.actor_id IS NOT old.actor_id
  OR new.client_submission_id IS NOT old.client_submission_id
  OR new.client_attachment_id IS NOT old.client_attachment_id
  OR new.capture_id IS NOT old.capture_id
  OR new.upload_attempt IS NOT old.upload_attempt
  OR new.file_name IS NOT old.file_name
  OR new.media_type IS NOT old.media_type
  OR new.expected_size_bytes IS NOT old.expected_size_bytes
  OR new.expected_sha256 IS NOT old.expected_sha256
  OR new.chunk_size_bytes IS NOT old.chunk_size_bytes
  OR new.expected_chunk_count IS NOT old.expected_chunk_count
  OR new.generation IS NOT old.generation
  OR new.expires_at IS NOT old.expires_at
  OR new.created_at IS NOT old.created_at
  OR (old.finalized_attachment_id IS NOT NULL AND new.finalized_attachment_id IS NOT old.finalized_attachment_id)
BEGIN
  SELECT RAISE(ABORT, 'upload identity, content hash, layout, and lease are immutable');
END;

CREATE TRIGGER upload_sessions_complete_chunks
BEFORE UPDATE OF status, finalized_attachment_id ON upload_sessions
WHEN new.status IN ('finalizing', 'finalized', 'rejected') AND (
  new.received_size_bytes <> new.expected_size_bytes
  OR (SELECT count(*) FROM upload_chunks AS chunk
      WHERE chunk.account_id = new.account_id
        AND chunk.project_id = new.project_id
        AND chunk.upload_session_id = new.id
        AND chunk.generation = new.generation) <> new.expected_chunk_count
  OR (SELECT coalesce(sum(chunk.size_bytes), 0) FROM upload_chunks AS chunk
      WHERE chunk.account_id = new.account_id
        AND chunk.project_id = new.project_id
        AND chunk.upload_session_id = new.id
        AND chunk.generation = new.generation) <> new.expected_size_bytes
  OR EXISTS (
    SELECT 1 FROM upload_chunks AS chunk
    WHERE chunk.account_id = new.account_id
      AND chunk.project_id = new.project_id
      AND chunk.upload_session_id = new.id
      AND chunk.generation = new.generation
      AND (
        chunk.chunk_index >= new.expected_chunk_count
        OR chunk.offset_bytes <> chunk.chunk_index * new.chunk_size_bytes
        OR (
          chunk.chunk_index < new.expected_chunk_count - 1
          AND chunk.size_bytes <> new.chunk_size_bytes
        )
        OR (
          chunk.chunk_index = new.expected_chunk_count - 1
          AND chunk.size_bytes <> new.expected_size_bytes - (chunk.chunk_index * new.chunk_size_bytes)
        )
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'upload cannot finalize before every exact chunk is durable');
END;

CREATE TRIGGER upload_sessions_finalize_match
BEFORE UPDATE OF finalized_attachment_id, status ON upload_sessions
WHEN new.finalized_attachment_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM attachments AS attachment
  WHERE attachment.account_id = new.account_id
    AND attachment.project_id = new.project_id
    AND attachment.id = new.finalized_attachment_id
    AND attachment.upload_session_id = new.id
    AND attachment.actor_id = new.actor_id
    AND attachment.client_submission_id = new.client_submission_id
    AND attachment.client_attachment_id = new.client_attachment_id
    AND attachment.capture_id IS new.capture_id
    AND attachment.file_name = new.file_name
    AND attachment.media_type = new.media_type
    AND attachment.size_bytes = new.expected_size_bytes
    AND attachment.sha256 = new.expected_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'finalized upload does not match its attachment');
END;

CREATE TABLE attachment_bindings (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  attachment_id TEXT NOT NULL CHECK (length(attachment_id) = 36),
  intent TEXT NOT NULL CHECK (intent IN ('bug_create', 'occurrence_append', 'comment_append', 'verification_result')),
  target_bug_id TEXT CHECK (target_bug_id IS NULL OR length(target_bug_id) = 36),
  lease_generation INTEGER NOT NULL CHECK (lease_generation >= 1),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'claimed', 'released', 'expired')),
  expires_at TEXT,
  claimed_at TEXT,
  bound_by_actor_id TEXT NOT NULL CHECK (length(bound_by_actor_id) = 36),
  bound_at TEXT NOT NULL CHECK (length(bound_at) >= 20),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id, project_id, attachment_id, bound_by_actor_id)
    REFERENCES attachments(account_id, project_id, id, actor_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, bound_by_actor_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  CHECK (
    (state = 'reserved' AND expires_at IS NOT NULL AND claimed_at IS NULL
      AND unixepoch(expires_at) IS NOT NULL AND unixepoch(bound_at) IS NOT NULL
      AND unixepoch(expires_at) > unixepoch(bound_at)
      AND unixepoch(expires_at) - unixepoch(bound_at) <= 86400)
    OR (state = 'claimed' AND expires_at IS NULL AND claimed_at IS NOT NULL AND target_bug_id IS NOT NULL)
    OR (state IN ('released', 'expired') AND expires_at IS NULL AND claimed_at IS NULL)
  ),
  CHECK (intent <> 'bug_create' OR state <> 'reserved' OR target_bug_id IS NULL),
  CHECK (intent = 'bug_create' OR target_bug_id IS NOT NULL),
  FOREIGN KEY (account_id, project_id, target_bug_id)
    REFERENCES bugs(account_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, attachment_id, lease_generation)
) STRICT;

CREATE TRIGGER attachment_bindings_initial_state
BEFORE INSERT ON attachment_bindings
WHEN new.state <> 'reserved'
  OR new.lease_generation <> 1
  OR new.version <> 1
  OR unixepoch(new.bound_at) IS NULL
  OR abs(unixepoch(new.bound_at) - unixepoch('now')) > 5
  OR unixepoch(new.expires_at) <= unixepoch('now')
  OR EXISTS (
    SELECT 1 FROM attachment_bindings AS prior
    WHERE prior.account_id = new.account_id
      AND prior.project_id = new.project_id
      AND prior.attachment_id = new.attachment_id
  )
BEGIN
  SELECT RAISE(ABORT, 'attachment binding must begin at generation one with a server-clock lease');
END;

CREATE TRIGGER attachment_bindings_ready_insert
BEFORE INSERT ON attachment_bindings
WHEN NOT EXISTS (
  SELECT 1
  FROM attachments AS attachment
  JOIN upload_sessions AS upload
    ON upload.account_id = attachment.account_id
   AND upload.project_id = attachment.project_id
   AND upload.id = attachment.upload_session_id
  WHERE attachment.account_id = new.account_id
    AND attachment.project_id = new.project_id
    AND attachment.id = new.attachment_id
    AND attachment.actor_id = new.bound_by_actor_id
    AND attachment.status = 'ready'
    AND attachment.scan_state = 'clean'
    AND upload.status = 'finalized'
    AND upload.finalized_attachment_id = attachment.id
)
BEGIN
  SELECT RAISE(ABORT, 'only the owning actor can bind a ready clean attachment from its exact finalized upload');
END;

CREATE TRIGGER attachment_bindings_ready_claim
BEFORE UPDATE OF state ON attachment_bindings
WHEN new.state = 'claimed' AND NOT EXISTS (
  SELECT 1
  FROM attachments AS attachment
  JOIN upload_sessions AS upload
    ON upload.account_id = attachment.account_id
   AND upload.project_id = attachment.project_id
   AND upload.id = attachment.upload_session_id
  WHERE attachment.account_id = new.account_id
    AND attachment.project_id = new.project_id
    AND attachment.id = new.attachment_id
    AND attachment.actor_id = new.bound_by_actor_id
    AND attachment.status = 'ready'
    AND attachment.scan_state = 'clean'
    AND upload.status = 'finalized'
    AND upload.finalized_attachment_id = attachment.id
)
BEGIN
  SELECT RAISE(ABORT, 'only a ready clean attachment can be claimed from its exact finalized upload');
END;

CREATE TRIGGER attachment_bindings_transition_guard
BEFORE UPDATE ON attachment_bindings
WHEN NOT (
  (
    old.state = 'reserved'
    AND new.id IS old.id
    AND new.account_id IS old.account_id
    AND new.project_id IS old.project_id
    AND new.attachment_id IS old.attachment_id
    AND new.intent IS old.intent
    AND new.lease_generation IS old.lease_generation
    AND new.bound_by_actor_id IS old.bound_by_actor_id
    AND new.bound_at IS old.bound_at
    AND new.version = old.version + 1
    AND (
      (
        new.state = 'claimed'
        AND new.expires_at IS NULL
        AND new.claimed_at IS NOT NULL
        AND unixepoch(old.expires_at) > unixepoch('now')
        AND unixepoch(new.claimed_at) IS NOT NULL
        AND abs(unixepoch(new.claimed_at) - unixepoch('now')) <= 5
        AND (
          (old.intent = 'bug_create' AND old.target_bug_id IS NULL AND new.target_bug_id IS NOT NULL)
          OR (old.intent <> 'bug_create' AND new.target_bug_id IS old.target_bug_id)
        )
      )
      OR (
        new.state = 'released'
        AND new.target_bug_id IS old.target_bug_id
        AND new.expires_at IS NULL
        AND new.claimed_at IS NULL
      )
      OR (
        new.state = 'expired'
        AND new.target_bug_id IS old.target_bug_id
        AND new.expires_at IS NULL
        AND new.claimed_at IS NULL
        AND unixepoch(old.expires_at) <= unixepoch('now')
      )
    )
  )
  OR (
    old.state = 'expired'
    AND new.state = 'reserved'
    AND new.id IS old.id
    AND new.account_id IS old.account_id
    AND new.project_id IS old.project_id
    AND new.attachment_id IS old.attachment_id
    AND new.intent IS old.intent
    AND new.target_bug_id IS old.target_bug_id
    AND new.bound_by_actor_id IS old.bound_by_actor_id
    AND new.lease_generation = old.lease_generation + 1
    AND new.claimed_at IS NULL
    AND unixepoch(new.bound_at) IS NOT NULL
    AND abs(unixepoch(new.bound_at) - unixepoch('now')) <= 5
    AND unixepoch(new.expires_at) > unixepoch(new.bound_at)
    AND unixepoch(new.expires_at) - unixepoch(new.bound_at) <= 86400
    AND new.version = old.version + 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid attachment reservation transition or expired claim');
END;

CREATE UNIQUE INDEX attachment_bindings_one_current_idx
  ON attachment_bindings(account_id, project_id, attachment_id)
  WHERE state IN ('reserved', 'claimed');

CREATE TRIGGER attachment_bindings_claimed_immutable
BEFORE UPDATE ON attachment_bindings
WHEN old.state = 'claimed'
BEGIN
  SELECT RAISE(ABORT, 'claimed attachment bindings are immutable');
END;

CREATE TRIGGER attachment_bindings_no_delete
BEFORE DELETE ON attachment_bindings
BEGIN
  SELECT RAISE(ABORT, 'attachment binding lease history is append-only');
END;

CREATE TABLE bug_attachments (
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  bug_id TEXT NOT NULL CHECK (length(bug_id) = 36),
  attachment_id TEXT NOT NULL CHECK (length(attachment_id) = 36),
  binding_id TEXT NOT NULL CHECK (length(binding_id) = 36),
  PRIMARY KEY (account_id, project_id, bug_id, attachment_id),
  FOREIGN KEY (account_id, project_id, bug_id)
    REFERENCES bugs(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, attachment_id)
    REFERENCES attachments(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, binding_id)
    REFERENCES attachment_bindings(account_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, attachment_id)
) STRICT;

CREATE TABLE occurrence_attachments (
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  occurrence_id TEXT NOT NULL CHECK (length(occurrence_id) = 36),
  attachment_id TEXT NOT NULL CHECK (length(attachment_id) = 36),
  binding_id TEXT NOT NULL CHECK (length(binding_id) = 36),
  PRIMARY KEY (account_id, project_id, occurrence_id, attachment_id),
  FOREIGN KEY (account_id, project_id, occurrence_id)
    REFERENCES occurrences(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, attachment_id)
    REFERENCES attachments(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, binding_id)
    REFERENCES attachment_bindings(account_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, attachment_id)
) STRICT;

CREATE TABLE comment_attachments (
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  comment_id TEXT NOT NULL CHECK (length(comment_id) = 36),
  attachment_id TEXT NOT NULL CHECK (length(attachment_id) = 36),
  binding_id TEXT NOT NULL CHECK (length(binding_id) = 36),
  PRIMARY KEY (account_id, project_id, comment_id, attachment_id),
  FOREIGN KEY (account_id, project_id, comment_id)
    REFERENCES comments(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, attachment_id)
    REFERENCES attachments(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, binding_id)
    REFERENCES attachment_bindings(account_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, attachment_id)
) STRICT;

CREATE TABLE verification_attachments (
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  verification_id TEXT NOT NULL CHECK (length(verification_id) = 36),
  attachment_id TEXT NOT NULL CHECK (length(attachment_id) = 36),
  binding_id TEXT NOT NULL CHECK (length(binding_id) = 36),
  PRIMARY KEY (account_id, project_id, verification_id, attachment_id),
  FOREIGN KEY (account_id, project_id, verification_id)
    REFERENCES verifications(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, attachment_id)
    REFERENCES attachments(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, binding_id)
    REFERENCES attachment_bindings(account_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, attachment_id)
) STRICT;

CREATE TRIGGER bug_attachments_binding_guard
BEFORE INSERT ON bug_attachments
WHEN NOT EXISTS (
  SELECT 1 FROM attachment_bindings AS binding
  WHERE binding.account_id = new.account_id
    AND binding.project_id = new.project_id
    AND binding.id = new.binding_id
    AND binding.attachment_id = new.attachment_id
    AND binding.intent = 'bug_create'
    AND binding.target_bug_id = new.bug_id
    AND binding.state = 'claimed'
)
BEGIN
  SELECT RAISE(ABORT, 'bug attachment requires its claimed Bug binding');
END;

CREATE TRIGGER occurrence_attachments_binding_guard
BEFORE INSERT ON occurrence_attachments
WHEN NOT EXISTS (
  SELECT 1
  FROM attachment_bindings AS binding
  JOIN occurrences AS occurrence
    ON occurrence.account_id = new.account_id
   AND occurrence.project_id = new.project_id
   AND occurrence.id = new.occurrence_id
  WHERE binding.account_id = new.account_id
    AND binding.project_id = new.project_id
    AND binding.id = new.binding_id
    AND binding.attachment_id = new.attachment_id
    AND binding.intent = 'occurrence_append'
    AND binding.target_bug_id = occurrence.bug_id
    AND binding.state = 'claimed'
)
BEGIN
  SELECT RAISE(ABORT, 'occurrence attachment requires its claimed Bug binding');
END;

CREATE TRIGGER comment_attachments_binding_guard
BEFORE INSERT ON comment_attachments
WHEN NOT EXISTS (
  SELECT 1
  FROM attachment_bindings AS binding
  JOIN comments AS comment
    ON comment.account_id = new.account_id
   AND comment.project_id = new.project_id
   AND comment.id = new.comment_id
  WHERE binding.account_id = new.account_id
    AND binding.project_id = new.project_id
    AND binding.id = new.binding_id
    AND binding.attachment_id = new.attachment_id
    AND binding.intent = 'comment_append'
    AND binding.target_bug_id = comment.bug_id
    AND binding.state = 'claimed'
)
BEGIN
  SELECT RAISE(ABORT, 'comment attachment requires its claimed Bug binding');
END;

CREATE TRIGGER verification_attachments_binding_guard
BEFORE INSERT ON verification_attachments
WHEN NOT EXISTS (
  SELECT 1
  FROM attachment_bindings AS binding
  JOIN verifications AS verification
    ON verification.account_id = new.account_id
   AND verification.project_id = new.project_id
   AND verification.id = new.verification_id
  WHERE binding.account_id = new.account_id
    AND binding.project_id = new.project_id
    AND binding.id = new.binding_id
    AND binding.attachment_id = new.attachment_id
    AND binding.intent = 'verification_result'
    AND binding.target_bug_id = verification.bug_id
    AND binding.state = 'claimed'
)
BEGIN
  SELECT RAISE(ABORT, 'verification attachment requires its claimed Bug binding');
END;

CREATE TRIGGER bug_attachments_no_update
BEFORE UPDATE ON bug_attachments BEGIN
  SELECT RAISE(ABORT, 'bug attachment links are immutable');
END;
CREATE TRIGGER bug_attachments_no_delete
BEFORE DELETE ON bug_attachments BEGIN
  SELECT RAISE(ABORT, 'bug attachment links are append-only');
END;
CREATE TRIGGER occurrence_attachments_no_update
BEFORE UPDATE ON occurrence_attachments BEGIN
  SELECT RAISE(ABORT, 'occurrence attachment links are immutable');
END;
CREATE TRIGGER occurrence_attachments_no_delete
BEFORE DELETE ON occurrence_attachments BEGIN
  SELECT RAISE(ABORT, 'occurrence attachment links are append-only');
END;
CREATE TRIGGER comment_attachments_no_update
BEFORE UPDATE ON comment_attachments BEGIN
  SELECT RAISE(ABORT, 'comment attachment links are immutable');
END;
CREATE TRIGGER comment_attachments_no_delete
BEFORE DELETE ON comment_attachments BEGIN
  SELECT RAISE(ABORT, 'comment attachment links are append-only');
END;
CREATE TRIGGER verification_attachments_no_update
BEFORE UPDATE ON verification_attachments BEGIN
  SELECT RAISE(ABORT, 'verification attachment links are immutable');
END;
CREATE TRIGGER verification_attachments_no_delete
BEFORE DELETE ON verification_attachments BEGIN
  SELECT RAISE(ABORT, 'verification attachment links are append-only');
END;

CREATE TABLE capture_bundles (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  actor_id TEXT NOT NULL CHECK (length(actor_id) = 36),
  capture_id TEXT NOT NULL CHECK (length(capture_id) = 36),
  client_submission_id TEXT NOT NULL CHECK (length(client_submission_id) = 36),
  source TEXT NOT NULL CHECK (source IN (
    'overlay_single_tap', 'overlay_double_tap', 'recording_marker',
    'recording_stop', 'android_share', 'photo_picker'
  )),
  primary_client_attachment_id TEXT NOT NULL CHECK (length(primary_client_attachment_id) = 36),
  primary_attachment_id TEXT NOT NULL CHECK (length(primary_attachment_id) = 36),
  started_at TEXT NOT NULL CHECK (length(started_at) >= 20),
  ended_at TEXT NOT NULL CHECK (length(ended_at) >= 20 AND ended_at >= started_at),
  captured_at TEXT NOT NULL CHECK (length(captured_at) >= 20),
  device_metadata_json TEXT NOT NULL CHECK (json_valid(device_metadata_json)),
  build_id TEXT GENERATED ALWAYS AS (
    json_extract(device_metadata_json, '$.buildId')
  ) STORED,
  enrichment_status TEXT NOT NULL CHECK (enrichment_status IN ('unavailable', 'partial', 'complete')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'uploaded', 'bound', 'discarded')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id, project_id)
    REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, actor_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, primary_attachment_id)
    REFERENCES attachments(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, build_id)
    REFERENCES builds(account_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, id, actor_id),
  UNIQUE (account_id, project_id, id, capture_id),
  UNIQUE (account_id, project_id, capture_id),
  UNIQUE (account_id, project_id, actor_id, client_submission_id)
) STRICT;

CREATE TRIGGER capture_bundles_primary_evidence_insert
BEFORE INSERT ON capture_bundles
WHEN NOT EXISTS (
  SELECT 1 FROM attachments AS attachment
  WHERE attachment.account_id = new.account_id
    AND attachment.project_id = new.project_id
    AND attachment.id = new.primary_attachment_id
    AND attachment.actor_id = new.actor_id
    AND attachment.client_submission_id = new.client_submission_id
    AND attachment.client_attachment_id = new.primary_client_attachment_id
    AND attachment.capture_id = new.capture_id
    AND attachment.status = 'ready'
    AND attachment.scan_state = 'clean'
    AND attachment.media_type IN ('image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm')
)
BEGIN
  SELECT RAISE(ABORT, 'capture primary evidence must resolve to the exact ready clean attachment');
END;

CREATE TRIGGER capture_bundles_initial_enrichment_guard
BEFORE INSERT ON capture_bundles
WHEN new.enrichment_status <> 'unavailable' OR new.status NOT IN ('draft', 'queued')
BEGIN
  SELECT RAISE(ABORT, 'capture is initialized before child evidence is finalized');
END;

CREATE TRIGGER capture_bundles_primary_evidence_update
BEFORE UPDATE OF account_id, project_id, actor_id, capture_id, client_submission_id,
  primary_client_attachment_id, primary_attachment_id ON capture_bundles
WHEN NOT EXISTS (
  SELECT 1 FROM attachments AS attachment
  WHERE attachment.account_id = new.account_id
    AND attachment.project_id = new.project_id
    AND attachment.id = new.primary_attachment_id
    AND attachment.actor_id = new.actor_id
    AND attachment.client_submission_id = new.client_submission_id
    AND attachment.client_attachment_id = new.primary_client_attachment_id
    AND attachment.capture_id = new.capture_id
    AND attachment.status = 'ready'
    AND attachment.scan_state = 'clean'
    AND attachment.media_type IN ('image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm')
)
BEGIN
  SELECT RAISE(ABORT, 'capture primary evidence must remain the exact ready clean attachment');
END;

CREATE TABLE capture_artifacts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  capture_bundle_id TEXT NOT NULL CHECK (length(capture_bundle_id) = 36),
  capture_id TEXT NOT NULL CHECK (length(capture_id) = 36),
  client_attachment_id TEXT,
  attachment_id TEXT,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN (
    'system_screenshot', 'system_recording', 'poco_screenshot',
    'poco_hierarchy', 'poco_profiling', 'poco_snapshot'
  )),
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'skipped')),
  skew_ms INTEGER NOT NULL CHECK (skew_ms BETWEEN 0 AND 5000),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 300),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  started_at TEXT NOT NULL CHECK (length(started_at) >= 20),
  ended_at TEXT CHECK (ended_at IS NULL OR (length(ended_at) >= 20 AND ended_at >= started_at)),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK ((status = 'succeeded') = (attachment_id IS NOT NULL)),
  CHECK ((status = 'succeeded') = (client_attachment_id IS NOT NULL)),
  CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CHECK (status = 'pending' OR ended_at IS NOT NULL),
  FOREIGN KEY (account_id, project_id, capture_bundle_id, capture_id)
    REFERENCES capture_bundles(account_id, project_id, id, capture_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, project_id, attachment_id)
    REFERENCES attachments(account_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, capture_bundle_id, artifact_type),
  UNIQUE (account_id, project_id, client_attachment_id),
  UNIQUE (account_id, project_id, attachment_id)
) STRICT;

CREATE TRIGGER capture_artifacts_attachment_fact_insert
BEFORE INSERT ON capture_artifacts
WHEN new.status = 'succeeded' AND NOT EXISTS (
  SELECT 1
  FROM capture_bundles AS bundle
  JOIN attachments AS attachment
    ON attachment.account_id = bundle.account_id
   AND attachment.project_id = bundle.project_id
   AND attachment.id = new.attachment_id
  WHERE bundle.account_id = new.account_id
    AND bundle.project_id = new.project_id
    AND bundle.id = new.capture_bundle_id
    AND bundle.capture_id = new.capture_id
    AND attachment.actor_id = bundle.actor_id
    AND attachment.client_submission_id = bundle.client_submission_id
    AND attachment.client_attachment_id = new.client_attachment_id
    AND attachment.capture_id = bundle.capture_id
    AND attachment.status = 'ready'
    AND attachment.scan_state = 'clean'
    AND (
      (new.artifact_type IN ('system_screenshot', 'poco_screenshot')
        AND attachment.media_type IN ('image/png', 'image/jpeg', 'image/webp')
        AND attachment.size_bytes <= 20971520)
      OR (new.artifact_type = 'system_recording'
        AND attachment.media_type IN ('video/mp4', 'video/webm')
        AND attachment.size_bytes <= 20971520)
      OR (new.artifact_type = 'poco_hierarchy'
        AND attachment.media_type IN ('application/json', 'application/gzip')
        AND attachment.size_bytes <= 1048576)
      OR (new.artifact_type = 'poco_profiling'
        AND attachment.media_type IN ('application/json', 'application/gzip')
        AND attachment.size_bytes <= 20971520)
      OR (new.artifact_type = 'poco_snapshot'
        AND attachment.media_type IN ('application/json', 'application/gzip')
        AND attachment.size_bytes <= 262144)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'capture artifact must resolve to the exact bounded attachment fact');
END;

CREATE TRIGGER capture_artifacts_initial_guard
BEFORE INSERT ON capture_artifacts
WHEN new.version <> 1
  OR (
    new.status = 'pending'
    AND (
      new.client_attachment_id IS NOT NULL
      OR new.attachment_id IS NOT NULL
      OR new.ended_at IS NOT NULL
      OR new.failure_reason IS NOT NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'capture artifact must begin at version one with an effect-free pending state');
END;

CREATE TRIGGER capture_artifacts_pending_transition_guard
BEFORE UPDATE ON capture_artifacts
WHEN NOT (
  old.status = 'pending'
  AND new.status IN ('succeeded', 'failed', 'skipped')
  AND new.id IS old.id
  AND new.account_id IS old.account_id
  AND new.project_id IS old.project_id
  AND new.capture_bundle_id IS old.capture_bundle_id
  AND new.capture_id IS old.capture_id
  AND new.artifact_type IS old.artifact_type
  AND new.started_at IS old.started_at
  AND new.created_at IS old.created_at
  AND new.version = old.version + 1
)
BEGIN
  SELECT RAISE(ABORT, 'capture artifact pending transition requires exact attachment identity and CAS');
END;

CREATE TRIGGER capture_artifacts_attachment_fact_update
BEFORE UPDATE ON capture_artifacts
WHEN new.status = 'succeeded' AND NOT EXISTS (
  SELECT 1
  FROM capture_bundles AS bundle
  JOIN attachments AS attachment
    ON attachment.account_id = bundle.account_id
   AND attachment.project_id = bundle.project_id
   AND attachment.id = new.attachment_id
  WHERE bundle.account_id = new.account_id
    AND bundle.project_id = new.project_id
    AND bundle.id = new.capture_bundle_id
    AND bundle.capture_id = new.capture_id
    AND attachment.actor_id = bundle.actor_id
    AND attachment.client_submission_id = bundle.client_submission_id
    AND attachment.client_attachment_id = new.client_attachment_id
    AND attachment.capture_id = bundle.capture_id
    AND attachment.status = 'ready'
    AND attachment.scan_state = 'clean'
    AND (
      (new.artifact_type IN ('system_screenshot', 'poco_screenshot')
        AND attachment.media_type IN ('image/png', 'image/jpeg', 'image/webp')
        AND attachment.size_bytes <= 20971520)
      OR (new.artifact_type = 'system_recording'
        AND attachment.media_type IN ('video/mp4', 'video/webm')
        AND attachment.size_bytes <= 20971520)
      OR (new.artifact_type = 'poco_hierarchy'
        AND attachment.media_type IN ('application/json', 'application/gzip')
        AND attachment.size_bytes <= 1048576)
      OR (new.artifact_type = 'poco_profiling'
        AND attachment.media_type IN ('application/json', 'application/gzip')
        AND attachment.size_bytes <= 20971520)
      OR (new.artifact_type = 'poco_snapshot'
        AND attachment.media_type IN ('application/json', 'application/gzip')
        AND attachment.size_bytes <= 262144)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'capture artifact pending transition requires exact attachment identity and CAS');
END;

CREATE TRIGGER capture_artifacts_no_delete
BEFORE DELETE ON capture_artifacts
BEGIN
  SELECT RAISE(ABORT, 'capture artifact attempt history is append-only');
END;

CREATE TABLE capture_poco_methods (
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  capture_bundle_id TEXT NOT NULL CHECK (length(capture_bundle_id) = 36),
  method TEXT NOT NULL CHECK (method IN ('GetSDKVersion', 'Screenshot', 'Dump', 'GetScreenSize', 'GetDebugProfilingData', 'qa.snapshot')),
  negotiated INTEGER NOT NULL CHECK (negotiated IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'unavailable', 'timeout', 'cancelled', 'rejected', 'failed')),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  response_bytes INTEGER CHECK (response_bytes IS NULL OR response_bytes BETWEEN 0 AND 20971520),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 200),
  collected_at TEXT NOT NULL CHECK (length(collected_at) >= 20),
  CHECK (status <> 'succeeded' OR negotiated = 1),
  PRIMARY KEY (account_id, project_id, capture_bundle_id, method),
  FOREIGN KEY (account_id, project_id, capture_bundle_id)
    REFERENCES capture_bundles(account_id, project_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE poco_snapshots (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  capture_bundle_id TEXT NOT NULL CHECK (length(capture_bundle_id) = 36),
  capture_id TEXT NOT NULL CHECK (length(capture_id) = 36),
  schema_version TEXT NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 40),
  compression TEXT NOT NULL CHECK (compression IN ('none', 'gzip')),
  uncompressed_bytes INTEGER NOT NULL CHECK (uncompressed_bytes BETWEEN 2 AND 262144),
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json)
    AND length(CAST(payload_json AS BLOB)) <= 262144
    AND length(CAST(payload_json AS BLOB)) = uncompressed_bytes
  ),
  limited_error_count INTEGER NOT NULL CHECK (limited_error_count BETWEEN 0 AND 20),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  version INTEGER NOT NULL CHECK (version = 1),
  FOREIGN KEY (account_id, project_id, capture_bundle_id, capture_id)
    REFERENCES capture_bundles(account_id, project_id, id, capture_id) ON DELETE CASCADE,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, capture_bundle_id),
  UNIQUE (account_id, project_id, capture_id)
) STRICT;

CREATE TABLE poco_enrichments (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  capture_bundle_id TEXT NOT NULL CHECK (length(capture_bundle_id) = 36),
  capture_id TEXT NOT NULL CHECK (length(capture_id) = 36),
  nonce_hash TEXT NOT NULL CHECK (length(nonce_hash) = 64 AND nonce_hash = lower(nonce_hash)),
  schema_version TEXT NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 40),
  attempted INTEGER NOT NULL CHECK (attempted IN (0, 1)),
  connected_port INTEGER CHECK (connected_port IS NULL OR connected_port BETWEEN 1 AND 65535),
  sdk_version TEXT CHECK (sdk_version IS NULL OR length(sdk_version) <= 100),
  snapshot_capability TEXT NOT NULL CHECK (snapshot_capability IN ('not_probed', 'standard_only', 'qa_snapshot_available')),
  screen_width INTEGER CHECK (screen_width IS NULL OR screen_width BETWEEN 1 AND 32768),
  screen_height INTEGER CHECK (screen_height IS NULL OR screen_height BETWEEN 1 AND 32768),
  status TEXT NOT NULL CHECK (status IN ('unavailable', 'partial', 'complete')),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 200),
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 300),
  collected_at TEXT NOT NULL CHECK (length(collected_at) >= 20),
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK ((screen_width IS NULL) = (screen_height IS NULL)),
  CHECK (attempted = 1 OR (connected_port IS NULL AND status = 'unavailable' AND snapshot_capability = 'not_probed')),
  FOREIGN KEY (account_id, project_id, capture_bundle_id, capture_id)
    REFERENCES capture_bundles(account_id, project_id, id, capture_id) ON DELETE CASCADE,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, capture_bundle_id),
  UNIQUE (account_id, project_id, capture_id)
) STRICT;

CREATE TRIGGER capture_bundles_finalize_evidence
BEFORE UPDATE OF status, enrichment_status ON capture_bundles
WHEN (new.status IN ('uploaded', 'bound') OR new.enrichment_status <> 'unavailable')
  AND (
    (SELECT count(*) FROM capture_artifacts AS artifact
      WHERE artifact.account_id = new.account_id
        AND artifact.project_id = new.project_id
        AND artifact.capture_bundle_id = new.id) NOT BETWEEN 1 AND 12
    OR EXISTS (
      SELECT 1 FROM capture_artifacts AS artifact
      WHERE artifact.account_id = new.account_id
        AND artifact.project_id = new.project_id
        AND artifact.capture_bundle_id = new.id
        AND artifact.status = 'pending'
    )
    OR NOT EXISTS (
      SELECT 1 FROM capture_artifacts AS artifact
      WHERE artifact.account_id = new.account_id
        AND artifact.project_id = new.project_id
        AND artifact.capture_bundle_id = new.id
        AND artifact.capture_id = new.capture_id
        AND artifact.client_attachment_id = new.primary_client_attachment_id
        AND artifact.attachment_id = new.primary_attachment_id
        AND artifact.artifact_type IN ('system_screenshot', 'system_recording')
        AND artifact.status = 'succeeded'
    )
    OR NOT EXISTS (
      SELECT 1 FROM poco_enrichments AS enrichment
      WHERE enrichment.account_id = new.account_id
        AND enrichment.project_id = new.project_id
        AND enrichment.capture_bundle_id = new.id
        AND enrichment.capture_id = new.capture_id
        AND enrichment.status = new.enrichment_status
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'final capture requires primary artifact and matching Poco enrichment facts');
END;

CREATE TRIGGER capture_bundles_poco_status_guard
BEFORE UPDATE OF status, enrichment_status ON capture_bundles
WHEN (new.status IN ('uploaded', 'bound') OR new.enrichment_status <> 'unavailable')
  AND NOT (
    (
      new.enrichment_status = 'unavailable'
      AND NOT EXISTS (
        SELECT 1 FROM capture_poco_methods AS method
        WHERE method.account_id = new.account_id
          AND method.project_id = new.project_id
          AND method.capture_bundle_id = new.id
          AND method.status = 'succeeded'
      )
    )
    OR (
      new.enrichment_status = 'partial'
      AND EXISTS (
        SELECT 1 FROM poco_enrichments AS enrichment
        WHERE enrichment.account_id = new.account_id
          AND enrichment.project_id = new.project_id
          AND enrichment.capture_bundle_id = new.id
          AND enrichment.attempted = 1
      )
      AND EXISTS (
        SELECT 1 FROM capture_poco_methods AS method
        WHERE method.account_id = new.account_id
          AND method.project_id = new.project_id
          AND method.capture_bundle_id = new.id
          AND method.status = 'succeeded'
      )
      AND NOT (
        EXISTS (SELECT 1 FROM capture_poco_methods WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND method = 'GetSDKVersion' AND negotiated = 1 AND status = 'succeeded')
        AND EXISTS (SELECT 1 FROM capture_poco_methods WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND method = 'Screenshot' AND negotiated = 1 AND status = 'succeeded')
        AND EXISTS (SELECT 1 FROM capture_poco_methods WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND method = 'Dump' AND negotiated = 1 AND status = 'succeeded')
        AND NOT EXISTS (SELECT 1 FROM capture_poco_methods WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND negotiated = 1 AND status <> 'succeeded')
      )
    )
    OR (
      new.enrichment_status = 'complete'
      AND EXISTS (
        SELECT 1 FROM poco_enrichments AS enrichment
        WHERE enrichment.account_id = new.account_id
          AND enrichment.project_id = new.project_id
          AND enrichment.capture_bundle_id = new.id
          AND enrichment.attempted = 1
      )
      AND EXISTS (SELECT 1 FROM capture_poco_methods WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND method = 'GetSDKVersion' AND negotiated = 1 AND status = 'succeeded')
      AND EXISTS (SELECT 1 FROM capture_poco_methods WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND method = 'Screenshot' AND negotiated = 1 AND status = 'succeeded')
      AND EXISTS (SELECT 1 FROM capture_poco_methods WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND method = 'Dump' AND negotiated = 1 AND status = 'succeeded')
      AND NOT EXISTS (SELECT 1 FROM capture_poco_methods WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND negotiated = 1 AND status <> 'succeeded')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'capture Poco status must be derived from negotiated method outcomes');
END;

CREATE TRIGGER capture_bundles_poco_artifact_guard
BEFORE UPDATE OF status, enrichment_status ON capture_bundles
WHEN (new.status IN ('uploaded', 'bound') OR new.enrichment_status <> 'unavailable')
  AND (
    (EXISTS (SELECT 1 FROM capture_poco_methods WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND method = 'Screenshot' AND status = 'succeeded'))
      <> (EXISTS (SELECT 1 FROM capture_artifacts WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND artifact_type = 'poco_screenshot' AND status = 'succeeded'))
    OR (EXISTS (SELECT 1 FROM capture_poco_methods WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND method = 'Dump' AND status = 'succeeded'))
      <> (EXISTS (SELECT 1 FROM capture_artifacts WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND artifact_type = 'poco_hierarchy' AND status = 'succeeded'))
    OR (EXISTS (SELECT 1 FROM capture_poco_methods WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND method = 'GetDebugProfilingData' AND status = 'succeeded'))
      <> (EXISTS (SELECT 1 FROM capture_artifacts WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND artifact_type = 'poco_profiling' AND status = 'succeeded'))
    OR (EXISTS (SELECT 1 FROM capture_poco_methods WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND method = 'qa.snapshot' AND status = 'succeeded'))
      <> (EXISTS (SELECT 1 FROM capture_artifacts WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND artifact_type = 'poco_snapshot' AND status = 'succeeded'))
    OR (EXISTS (SELECT 1 FROM capture_poco_methods WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND method = 'qa.snapshot' AND status = 'succeeded'))
      <> (EXISTS (SELECT 1 FROM poco_snapshots WHERE account_id = new.account_id AND project_id = new.project_id AND capture_bundle_id = new.id AND capture_id = new.capture_id))
  )
BEGIN
  SELECT RAISE(ABORT, 'Poco method outcomes, snapshot facts, and artifacts must match exactly');
END;

CREATE TABLE native_sessions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  user_id TEXT NOT NULL CHECK (length(user_id) = 36),
  installation_id TEXT NOT NULL CHECK (length(installation_id) = 36),
  access_token_digest TEXT NOT NULL UNIQUE CHECK (length(access_token_digest) = 64 AND access_token_digest = lower(access_token_digest)),
  shared_device INTEGER NOT NULL CHECK (shared_device IN (0, 1)),
  push_allowed INTEGER NOT NULL CHECK (push_allowed IN (0, 1)),
  issued_at TEXT NOT NULL CHECK (length(issued_at) >= 20),
  access_expires_at TEXT NOT NULL CHECK (length(access_expires_at) >= 20),
  idle_expires_at TEXT NOT NULL CHECK (length(idle_expires_at) >= 20 AND idle_expires_at > issued_at),
  absolute_expires_at TEXT NOT NULL CHECK (length(absolute_expires_at) >= 20 AND absolute_expires_at >= idle_expires_at),
  revoked_at TEXT,
  revoked_reason TEXT CHECK (revoked_reason IS NULL OR length(revoked_reason) <= 5000),
  last_seen_at TEXT NOT NULL CHECK (length(last_seen_at) >= 20),
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK (shared_device = 0 OR push_allowed = 0),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CHECK (unixepoch(issued_at) IS NOT NULL),
  CHECK (unixepoch(access_expires_at) IS NOT NULL),
  CHECK (unixepoch(idle_expires_at) IS NOT NULL),
  CHECK (unixepoch(absolute_expires_at) IS NOT NULL),
  CHECK (unixepoch(last_seen_at) IS NOT NULL),
  CHECK (unixepoch(access_expires_at) > unixepoch(issued_at)),
  CHECK (unixepoch(access_expires_at) - unixepoch(issued_at) <= 900),
  CHECK (unixepoch(access_expires_at) <= unixepoch(idle_expires_at)),
  CHECK (unixepoch(idle_expires_at) <= unixepoch(absolute_expires_at)),
  CHECK (unixepoch(last_seen_at) BETWEEN unixepoch(issued_at) AND unixepoch(absolute_expires_at)),
  CHECK (
    shared_device = 0
    OR (
      unixepoch(idle_expires_at) - unixepoch(issued_at) <= 1800
      AND unixepoch(absolute_expires_at) - unixepoch(issued_at) <= 28800
    )
  ),
  FOREIGN KEY (account_id, user_id)
    REFERENCES users(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, installation_id, shared_device)
    REFERENCES device_installations(account_id, id, shared_device) ON DELETE RESTRICT,
  UNIQUE (account_id, id),
  UNIQUE (account_id, id, user_id, installation_id),
  UNIQUE (account_id, id, user_id, installation_id, shared_device)
) STRICT;

CREATE TABLE refresh_token_families (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  user_id TEXT NOT NULL CHECK (length(user_id) = 36),
  session_id TEXT NOT NULL CHECK (length(session_id) = 36),
  installation_id TEXT NOT NULL CHECK (length(installation_id) = 36),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  revoked_at TEXT,
  revoked_reason TEXT CHECK (revoked_reason IS NULL OR length(revoked_reason) <= 5000),
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (unixepoch(created_at) IS NOT NULL),
  CHECK (revoked_at IS NULL OR unixepoch(revoked_at) IS NOT NULL),
  FOREIGN KEY (account_id, user_id)
    REFERENCES users(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, session_id, user_id, installation_id)
    REFERENCES native_sessions(account_id, id, user_id, installation_id) ON DELETE CASCADE,
  UNIQUE (account_id, id),
  UNIQUE (account_id, id, session_id, user_id, installation_id),
  UNIQUE (account_id, session_id)
) STRICT;

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  family_id TEXT NOT NULL CHECK (length(family_id) = 36),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  token_digest TEXT NOT NULL UNIQUE CHECK (length(token_digest) = 64 AND token_digest = lower(token_digest)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'consumed', 'revoked', 'expired')),
  issued_at TEXT NOT NULL CHECK (length(issued_at) >= 20),
  expires_at TEXT NOT NULL CHECK (length(expires_at) >= 20 AND expires_at > issued_at),
  consumed_at TEXT,
  revoked_at TEXT,
  replaced_by_token_id TEXT,
  replaced_by_family_id TEXT,
  replaced_by_generation INTEGER,
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (unixepoch(issued_at) IS NOT NULL),
  CHECK (unixepoch(expires_at) IS NOT NULL),
  CHECK (unixepoch(expires_at) - unixepoch(issued_at) <= 2592000),
  CHECK (consumed_at IS NULL OR unixepoch(consumed_at) IS NOT NULL),
  CHECK (revoked_at IS NULL OR unixepoch(revoked_at) IS NOT NULL),
  CHECK (
    (status = 'consumed'
      AND replaced_by_token_id IS NOT NULL
      AND replaced_by_family_id = family_id
      AND replaced_by_generation = generation + 1)
    OR (status <> 'consumed'
      AND replaced_by_token_id IS NULL
      AND replaced_by_family_id IS NULL
      AND replaced_by_generation IS NULL)
  ),
  FOREIGN KEY (account_id, family_id)
    REFERENCES refresh_token_families(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, replaced_by_token_id, replaced_by_family_id, replaced_by_generation)
    REFERENCES refresh_tokens(account_id, id, family_id, generation) ON DELETE RESTRICT,
  UNIQUE (account_id, id),
  UNIQUE (account_id, id, family_id, generation),
  UNIQUE (account_id, family_id, generation)
) STRICT;

CREATE TRIGGER refresh_tokens_replacement_insert
BEFORE INSERT ON refresh_tokens
WHEN new.status = 'consumed' AND NOT EXISTS (
  SELECT 1 FROM refresh_tokens AS replacement
  WHERE replacement.account_id = new.account_id
    AND replacement.id = new.replaced_by_token_id
    AND replacement.family_id = new.family_id
    AND replacement.generation = new.generation + 1
    AND replacement.status IN ('pending', 'active')
)
BEGIN
  SELECT RAISE(ABORT, 'refresh replacement must be the next active generation in the same family');
END;

CREATE TRIGGER refresh_tokens_replacement_update
BEFORE UPDATE ON refresh_tokens
WHEN new.status = 'consumed' AND NOT EXISTS (
  SELECT 1 FROM refresh_tokens AS replacement
  WHERE replacement.account_id = new.account_id
    AND replacement.id = new.replaced_by_token_id
    AND replacement.family_id = new.family_id
    AND replacement.generation = new.generation + 1
    AND replacement.status IN ('pending', 'active')
)
BEGIN
  SELECT RAISE(ABORT, 'refresh replacement must be the next active generation in the same family');
END;

CREATE TRIGGER refresh_tokens_pending_activation
BEFORE UPDATE OF status ON refresh_tokens
WHEN old.status = 'pending' AND new.status = 'active' AND NOT EXISTS (
  SELECT 1 FROM refresh_tokens AS predecessor
  WHERE predecessor.account_id = new.account_id
    AND predecessor.family_id = new.family_id
    AND predecessor.generation = new.generation - 1
    AND predecessor.status = 'consumed'
    AND predecessor.replaced_by_token_id = new.id
    AND predecessor.replaced_by_family_id = new.family_id
    AND predecessor.replaced_by_generation = new.generation
)
BEGIN
  SELECT RAISE(ABORT, 'pending refresh token requires its consumed predecessor before activation');
END;

CREATE TRIGGER refresh_tokens_identity_immutable
BEFORE UPDATE ON refresh_tokens
WHEN new.id IS NOT old.id
  OR new.account_id IS NOT old.account_id
  OR new.family_id IS NOT old.family_id
  OR new.generation IS NOT old.generation
  OR new.token_digest IS NOT old.token_digest
  OR new.issued_at IS NOT old.issued_at
  OR new.expires_at IS NOT old.expires_at
BEGIN
  SELECT RAISE(ABORT, 'refresh token identity, family, generation, and secret digest are immutable');
END;

CREATE TABLE auth_secret_replays (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  actor_id TEXT NOT NULL CHECK (length(actor_id) = 36),
  installation_id TEXT NOT NULL CHECK (length(installation_id) = 36),
  session_id TEXT NOT NULL CHECK (length(session_id) = 36),
  refresh_family_id TEXT CHECK (refresh_family_id IS NULL OR length(refresh_family_id) = 36),
  action TEXT NOT NULL CHECK (action IN ('native_login', 'native_refresh')),
  operation_id TEXT NOT NULL CHECK (
    (action = 'native_login' AND operation_id = 'createNativeSession')
    OR (action = 'native_refresh' AND operation_id = 'refreshNativeSession')
  ),
  scope_digest TEXT NOT NULL CHECK (length(scope_digest) = 64 AND scope_digest = lower(scope_digest) AND scope_digest NOT GLOB '*[^0-9a-f]*'),
  idempotency_key_digest TEXT NOT NULL CHECK (length(idempotency_key_digest) = 64 AND idempotency_key_digest = lower(idempotency_key_digest)),
  request_hmac TEXT NOT NULL CHECK (length(request_hmac) = 64 AND request_hmac = lower(request_hmac) AND request_hmac NOT GLOB '*[^0-9a-f]*'),
  response_ciphertext TEXT NOT NULL CHECK (length(response_ciphertext) BETWEEN 1 AND 16000),
  response_secret_hmac TEXT NOT NULL CHECK (length(response_secret_hmac) = 64 AND response_secret_hmac = lower(response_secret_hmac) AND response_secret_hmac NOT GLOB '*[^0-9a-f]*'),
  encryption_key_version INTEGER NOT NULL CHECK (encryption_key_version >= 1),
  effect_session_version INTEGER NOT NULL CHECK (effect_session_version >= 1),
  effect_token_generation INTEGER NOT NULL CHECK (effect_token_generation >= 1),
  effect_committed INTEGER NOT NULL CHECK (effect_committed = 1),
  mutation_count INTEGER NOT NULL CHECK (mutation_count = 1),
  consumed_at TEXT CHECK (consumed_at IS NULL OR (length(consumed_at) >= 20 AND unixepoch(consumed_at) IS NOT NULL)),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND unixepoch(created_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (length(expires_at) >= 20 AND unixepoch(expires_at) IS NOT NULL),
  version INTEGER NOT NULL CHECK (version = 1),
  CHECK (unixepoch(expires_at) > unixepoch(created_at)),
  CHECK (unixepoch(expires_at) - unixepoch(created_at) <= 300),
  CHECK (
    (action = 'native_login'
      AND refresh_family_id IS NOT NULL
      AND consumed_at IS NULL
      AND effect_token_generation = 1)
    OR (
      action = 'native_refresh'
      AND refresh_family_id IS NOT NULL
      AND consumed_at = created_at
    )
  ),
  FOREIGN KEY (account_id, actor_id)
    REFERENCES users(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, session_id, actor_id, installation_id)
    REFERENCES native_sessions(account_id, id, user_id, installation_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (account_id, refresh_family_id, session_id, actor_id, installation_id)
    REFERENCES refresh_token_families(account_id, id, session_id, user_id, installation_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (account_id, actor_id, installation_id, operation_id, scope_digest, idempotency_key_digest)
) STRICT;

CREATE TRIGGER auth_secret_replays_exact_effect_insert
BEFORE INSERT ON auth_secret_replays
WHEN abs(unixepoch(new.created_at) - unixepoch('now')) > 5
  OR NOT EXISTS (
    SELECT 1
    FROM native_sessions AS session
    JOIN users AS user
      ON user.account_id = session.account_id AND user.id = session.user_id
    JOIN accounts AS account ON account.id = session.account_id
    JOIN device_installations AS installation
      ON installation.account_id = session.account_id
     AND installation.id = session.installation_id
    JOIN refresh_token_families AS family
      ON family.account_id = session.account_id
     AND family.session_id = session.id
     AND family.id = new.refresh_family_id
    JOIN refresh_tokens AS token
      ON token.account_id = family.account_id
     AND token.family_id = family.id
     AND token.generation = new.effect_token_generation
    WHERE session.account_id = new.account_id
      AND session.id = new.session_id
      AND session.user_id = new.actor_id
      AND session.installation_id = new.installation_id
      AND session.version = new.effect_session_version
      AND session.revoked_at IS NULL
      AND unixepoch(session.access_expires_at) > unixepoch('now')
      AND unixepoch(session.absolute_expires_at) > unixepoch('now')
      AND user.status = 'active'
      AND account.status = 'active'
      AND installation.revoked_at IS NULL
      AND family.status = 'active'
      AND token.status = 'active'
      AND unixepoch(token.issued_at) <= unixepoch('now')
      AND unixepoch(token.expires_at) > unixepoch('now')
  )
BEGIN
  SELECT RAISE(ABORT, 'auth replay snapshot must bind the exact current session and refresh effect');
END;

CREATE TABLE idempotency_records (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT,
  actor_id TEXT NOT NULL CHECK (length(actor_id) = 36),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 120),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  scope_digest TEXT NOT NULL CHECK (length(scope_digest) = 64 AND scope_digest = lower(scope_digest)),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest = lower(request_digest)),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'failed')),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  audit_event_id TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  expires_at TEXT NOT NULL CHECK (length(expires_at) >= 20),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, project_id)
    REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, actor_id)
    REFERENCES users(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, project_id, audit_event_id)
    REFERENCES events(account_id, project_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (unixepoch(created_at) IS NOT NULL),
  CHECK (unixepoch(expires_at) IS NOT NULL),
  CHECK (unixepoch(expires_at) > unixepoch(created_at)),
  CHECK (unixepoch(expires_at) - unixepoch(created_at) <= 2592000),
  CHECK (
    (status = 'reserved' AND http_status IS NULL AND response_json IS NULL AND audit_event_id IS NULL)
    OR (
      status = 'committed'
      AND project_id IS NOT NULL
      AND http_status IS NOT NULL
      AND http_status BETWEEN 200 AND 299
      AND response_json IS NOT NULL
      AND json_type(response_json) = 'object'
      AND audit_event_id IS NOT NULL
    )
    OR (
      status = 'failed'
      AND http_status IS NOT NULL
      AND http_status BETWEEN 400 AND 599
      AND response_json IS NOT NULL
      AND json_type(response_json) = 'object'
      AND audit_event_id IS NULL
    )
  ),
  UNIQUE (account_id, actor_id, operation_id, scope_digest, idempotency_key)
) STRICT;

CREATE TABLE submissions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  actor_id TEXT NOT NULL CHECK (length(actor_id) = 36),
  client_submission_id TEXT NOT NULL CHECK (length(client_submission_id) = 36),
  intent TEXT NOT NULL CHECK (intent IN ('bug_create', 'occurrence_append', 'comment_append', 'verification_result', 'capture_create')),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64 AND payload_digest = lower(payload_digest)),
  bug_id TEXT,
  occurrence_id TEXT,
  comment_id TEXT,
  verification_id TEXT,
  capture_bundle_id TEXT,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  committed_at TEXT NOT NULL CHECK (length(committed_at) >= 20),
  version INTEGER NOT NULL CHECK (version = 1),
  CHECK (
    (intent = 'bug_create' AND bug_id IS NOT NULL AND occurrence_id IS NULL AND comment_id IS NULL AND verification_id IS NULL)
    OR (intent = 'occurrence_append' AND bug_id IS NOT NULL AND occurrence_id IS NOT NULL AND comment_id IS NULL AND verification_id IS NULL)
    OR (intent = 'comment_append' AND bug_id IS NOT NULL AND occurrence_id IS NULL AND comment_id IS NOT NULL AND verification_id IS NULL)
    OR (intent = 'verification_result' AND bug_id IS NOT NULL AND occurrence_id IS NULL AND comment_id IS NULL AND verification_id IS NOT NULL)
    OR (intent = 'capture_create' AND bug_id IS NULL AND occurrence_id IS NULL AND comment_id IS NULL AND verification_id IS NULL AND capture_bundle_id IS NOT NULL)
  ),
  FOREIGN KEY (account_id, project_id)
    REFERENCES projects(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, actor_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, bug_id)
    REFERENCES bugs(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, occurrence_id, bug_id)
    REFERENCES occurrences(account_id, project_id, id, bug_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, comment_id, bug_id)
    REFERENCES comments(account_id, project_id, id, bug_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, verification_id, bug_id)
    REFERENCES verifications(account_id, project_id, id, bug_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, capture_bundle_id)
    REFERENCES capture_bundles(account_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, actor_id, project_id, client_submission_id)
) STRICT;

CREATE TRIGGER submissions_exact_effect_insert
BEFORE INSERT ON submissions
WHEN NOT (
  (new.capture_bundle_id IS NULL OR EXISTS (
    SELECT 1 FROM capture_bundles AS capture
    WHERE capture.account_id = new.account_id
      AND capture.project_id = new.project_id
      AND capture.id = new.capture_bundle_id
      AND capture.actor_id = new.actor_id
      AND capture.client_submission_id = new.client_submission_id
  ))
  AND (
    (new.intent = 'bug_create' AND EXISTS (
      SELECT 1 FROM bugs AS bug
      WHERE bug.account_id = new.account_id
        AND bug.project_id = new.project_id
        AND bug.id = new.bug_id
        AND bug.reporter_id = new.actor_id
    ))
    OR (new.intent = 'occurrence_append' AND EXISTS (
      SELECT 1 FROM occurrences AS occurrence
      WHERE occurrence.account_id = new.account_id
        AND occurrence.project_id = new.project_id
        AND occurrence.id = new.occurrence_id
        AND occurrence.bug_id = new.bug_id
        AND occurrence.reporter_id = new.actor_id
        AND occurrence.client_submission_id = new.client_submission_id
    ))
    OR (new.intent = 'comment_append' AND EXISTS (
      SELECT 1 FROM comments AS comment
      WHERE comment.account_id = new.account_id
        AND comment.project_id = new.project_id
        AND comment.id = new.comment_id
        AND comment.bug_id = new.bug_id
        AND comment.author_id = new.actor_id
        AND comment.client_submission_id = new.client_submission_id
    ))
    OR (new.intent = 'verification_result' AND EXISTS (
      SELECT 1 FROM verifications AS verification
      WHERE verification.account_id = new.account_id
        AND verification.project_id = new.project_id
        AND verification.id = new.verification_id
        AND verification.bug_id = new.bug_id
        AND verification.verifier_id = new.actor_id
    ))
    OR (new.intent = 'capture_create' AND EXISTS (
      SELECT 1 FROM capture_bundles AS capture
      WHERE capture.account_id = new.account_id
        AND capture.project_id = new.project_id
        AND capture.id = new.capture_bundle_id
        AND capture.actor_id = new.actor_id
        AND capture.client_submission_id = new.client_submission_id
    ))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'submission receipt does not match its exact typed effect');
END;

CREATE TRIGGER submissions_no_update
BEFORE UPDATE ON submissions
BEGIN
  SELECT RAISE(ABORT, 'submission receipts are immutable');
END;

CREATE TRIGGER submissions_no_delete
BEFORE DELETE ON submissions
BEGIN
  SELECT RAISE(ABORT, 'submission receipts are append-only');
END;

CREATE TABLE events (
  event_position INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT,
  bug_id TEXT,
  projection_version TEXT NOT NULL DEFAULT '1.1.0' CHECK (projection_version = '1.1.0'),
  redaction_policy_version TEXT NOT NULL DEFAULT '1.0.0' CHECK (redaction_policy_version = '1.0.0'),
  type TEXT NOT NULL CHECK (length(type) BETWEEN 3 AND 120),
  source TEXT NOT NULL CHECK (source IN ('qa_hub', 'relay', 'build', 'system')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'service', 'system')),
  actor_user_id TEXT,
  actor_service_principal_id TEXT,
  aggregate_type TEXT NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 80),
  aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 200),
  aggregate_sequence INTEGER NOT NULL CHECK (aggregate_sequence >= 1),
  resource_type TEXT NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 80),
  resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 200),
  resource_version_after INTEGER CHECK (resource_version_after IS NULL OR resource_version_after >= 1),
  request_digest TEXT CHECK (request_digest IS NULL OR (length(request_digest) = 64 AND request_digest = lower(request_digest))),
  correlation_id TEXT NOT NULL CHECK (length(correlation_id) = 36),
  causation_id TEXT CHECK (causation_id IS NULL OR length(causation_id) = 36),
  from_state TEXT CHECK (from_state IS NULL OR from_state IN (
    'reported', 'needs_info', 'ready', 'in_progress', 'awaiting_build',
    'ready_for_verification', 'closed', 'deferred', 'rejected', 'duplicate'
  )),
  to_state TEXT CHECK (to_state IS NULL OR to_state IN (
    'reported', 'needs_info', 'ready', 'in_progress', 'awaiting_build',
    'ready_for_verification', 'closed', 'deferred', 'rejected', 'duplicate'
  )),
  ip_hash TEXT,
  user_agent_hash TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  CHECK (
    (actor_type = 'user' AND actor_user_id IS NOT NULL AND actor_service_principal_id IS NULL)
    OR (actor_type = 'service' AND actor_user_id IS NULL AND actor_service_principal_id IS NOT NULL)
    OR (actor_type = 'system' AND actor_user_id IS NULL AND actor_service_principal_id IS NULL)
  ),
  CHECK (bug_id IS NULL OR project_id IS NOT NULL),
  CHECK (source <> 'system' OR actor_type = 'system'),
  CHECK (
    source NOT IN ('relay', 'build')
    OR (
      actor_type = 'service'
      AND from_state IS NULL
      AND to_state IS NULL
      AND (
        (source = 'relay' AND type IN (
          'repair.queued', 'repair.submitted', 'repair.running',
          'repair.needs_input', 'repair.blocked', 'repair.failed',
          'repair.fix_delivered', 'repair.awaiting_build',
          'repair.awaiting_verification'
        ))
        OR (source = 'build' AND type IN ('build.pending', 'build.exact_commit_eligible'))
      )
      AND (
        json_type(payload_json, '$.status') IS NULL
        OR (
          json_type(payload_json, '$.status') = 'text'
          AND json_extract(payload_json, '$.status') = substr(type, instr(type, '.') + 1)
        )
      )
    )
  ),
  CHECK (
    (from_state IS NULL AND to_state IS NULL AND type NOT GLOB 'bug.*' AND type NOT GLOB 'verification.*')
    OR (source = 'qa_hub' AND actor_type = 'user')
  ),
  CHECK (
    type <> 'bug.closed'
    OR (
      source = 'qa_hub'
      AND actor_type = 'user'
      AND to_state = 'closed'
      AND json_type(payload_json, '$.verificationId') = 'text'
      AND length(json_extract(payload_json, '$.verificationId')) = 36
    )
  ),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id)
    REFERENCES projects(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, bug_id)
    REFERENCES bugs(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, actor_user_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, actor_service_principal_id)
    REFERENCES service_principals(account_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, aggregate_type, aggregate_id, aggregate_sequence)
) STRICT;

CREATE TRIGGER events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE integration_links (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  integration_type TEXT NOT NULL CHECK (integration_type IN ('relay', 'build_provider')),
  local_resource_type TEXT NOT NULL CHECK (length(local_resource_type) BETWEEN 1 AND 80),
  local_resource_id TEXT NOT NULL CHECK (length(local_resource_id) BETWEEN 1 AND 200),
  external_resource_type TEXT NOT NULL CHECK (length(external_resource_type) BETWEEN 1 AND 80),
  external_resource_id TEXT NOT NULL CHECK (length(external_resource_id) BETWEEN 1 AND 300),
  state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'disabled')),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id, project_id)
    REFERENCES projects(account_id, id) ON DELETE CASCADE,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, integration_type, external_resource_type, external_resource_id)
) STRICT;

CREATE TABLE relay_receipts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  integration_link_id TEXT NOT NULL CHECK (length(integration_link_id) = 36),
  bug_id TEXT NOT NULL CHECK (length(bug_id) = 36),
  repair_attempt_id TEXT NOT NULL CHECK (length(repair_attempt_id) = 36),
  handoff_id TEXT NOT NULL CHECK (length(handoff_id) = 36),
  relay_instance_id TEXT NOT NULL CHECK (
    length(relay_instance_id) BETWEEN 3 AND 64
    AND substr(relay_instance_id, 1, 1) GLOB '[a-z0-9]'
    AND relay_instance_id NOT GLOB '*[^a-z0-9_-]*'
  ),
  relay_task_id TEXT CHECK (relay_task_id IS NULL OR length(relay_task_id) BETWEEN 1 AND 200),
  handoff_status TEXT NOT NULL CHECK (handoff_status IN (
    'queued', 'submitted', 'running', 'needs_input', 'blocked', 'failed',
    'fix_delivered', 'awaiting_build', 'awaiting_verification'
  )),
  external_revision INTEGER NOT NULL CHECK (external_revision >= 0),
  build_requirement TEXT NOT NULL CHECK (build_requirement IN ('not_required', 'required')),
  build_evidence_status TEXT NOT NULL CHECK (build_evidence_status IN ('not_required', 'pending', 'exact_commit_eligible')),
  delivered_commit_sha TEXT CHECK (delivered_commit_sha IS NULL OR (length(delivered_commit_sha) = 40 AND delivered_commit_sha = lower(delivered_commit_sha) AND delivered_commit_sha NOT GLOB '*[^0-9a-f]*')),
  build_id TEXT CHECK (build_id IS NULL OR length(build_id) = 36),
  requires_human_verification INTEGER NOT NULL DEFAULT 1 CHECK (requires_human_verification = 1),
  automation_authority TEXT NOT NULL DEFAULT 'delivery_build_projection_only' CHECK (automation_authority = 'delivery_build_projection_only'),
  last_event_at TEXT NOT NULL CHECK (length(last_event_at) >= 20 AND unixepoch(last_event_at) IS NOT NULL),
  failure_summary TEXT CHECK (failure_summary IS NULL OR length(failure_summary) BETWEEN 1 AND 2000),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64 AND payload_digest = lower(payload_digest)),
  received_at TEXT NOT NULL CHECK (length(received_at) >= 20),
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK (handoff_status = 'queued' OR relay_task_id IS NOT NULL),
  CHECK (
    (handoff_status IN ('queued', 'submitted', 'running', 'needs_input', 'blocked', 'failed') AND delivered_commit_sha IS NULL)
    OR (handoff_status IN ('fix_delivered', 'awaiting_build', 'awaiting_verification') AND delivered_commit_sha IS NOT NULL)
  ),
  CHECK (
    (build_requirement = 'not_required' AND build_evidence_status = 'not_required' AND build_id IS NULL)
    OR (build_requirement = 'required' AND build_evidence_status = 'pending' AND build_id IS NULL)
    OR (build_requirement = 'required' AND build_evidence_status = 'exact_commit_eligible' AND build_id IS NOT NULL)
  ),
  CHECK (handoff_status <> 'awaiting_build' OR (build_requirement = 'required' AND build_evidence_status = 'pending')),
  CHECK (
    handoff_status <> 'awaiting_verification'
    OR (build_requirement = 'not_required' AND build_evidence_status = 'not_required' AND build_id IS NULL)
    OR (build_requirement = 'required' AND build_evidence_status = 'exact_commit_eligible' AND build_id IS NOT NULL)
  ),
  CHECK ((handoff_status = 'failed') = (failure_summary IS NOT NULL)),
  FOREIGN KEY (account_id, project_id, integration_link_id)
    REFERENCES integration_links(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, bug_id)
    REFERENCES bugs(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, repair_attempt_id, bug_id)
    REFERENCES repair_attempts(account_id, project_id, id, bug_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, build_id)
    REFERENCES builds(account_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, handoff_id),
  UNIQUE (account_id, project_id, repair_attempt_id)
) STRICT;

CREATE TRIGGER relay_receipts_exact_handoff_insert
BEFORE INSERT ON relay_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM repair_attempts AS attempt
  JOIN integration_links AS integration
    ON integration.account_id = attempt.account_id
   AND integration.project_id = attempt.project_id
   AND integration.id = new.integration_link_id
  WHERE attempt.account_id = new.account_id
    AND attempt.project_id = new.project_id
    AND attempt.id = new.repair_attempt_id
    AND attempt.bug_id = new.bug_id
    AND attempt.mode = 'relay'
    AND integration.integration_type = 'relay'
    AND integration.local_resource_type = 'repair_attempt'
    AND integration.local_resource_id = new.repair_attempt_id
    AND integration.external_resource_type = 'relay_handoff'
    AND integration.external_resource_id = new.handoff_id
    AND integration.state = 'active'
    AND json_extract(integration.metadata_json, '$.relayInstanceId') = new.relay_instance_id
)
BEGIN
  SELECT RAISE(ABORT, 'Relay receipt must bind the exact Relay attempt and handoff integration');
END;

CREATE TRIGGER relay_receipts_revision_guard
BEFORE UPDATE ON relay_receipts
WHEN new.account_id IS NOT old.account_id
  OR new.project_id IS NOT old.project_id
  OR new.integration_link_id IS NOT old.integration_link_id
  OR new.bug_id IS NOT old.bug_id
  OR new.repair_attempt_id IS NOT old.repair_attempt_id
  OR new.handoff_id IS NOT old.handoff_id
  OR new.relay_instance_id IS NOT old.relay_instance_id
  OR new.requires_human_verification IS NOT old.requires_human_verification
  OR new.automation_authority IS NOT old.automation_authority
  OR new.external_revision <= old.external_revision
BEGIN
  SELECT RAISE(ABORT, 'Relay receipt identity is immutable and revisions must increase');
END;

CREATE TABLE outbox (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  aggregate_type TEXT NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 80),
  aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 200),
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 1),
  destination TEXT NOT NULL CHECK (length(destination) BETWEEN 1 AND 120),
  dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 300),
  event_id TEXT NOT NULL CHECK (length(event_id) = 36),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'retry', 'sent', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL CHECK (length(next_attempt_at) >= 20),
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  sent_at TEXT,
  CHECK (
    (status = 'claimed' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'claimed' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id)
    REFERENCES projects(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, event_id)
    REFERENCES events(account_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, destination, event_id),
  UNIQUE (account_id, destination, dedupe_key)
) STRICT;

CREATE TABLE inbox (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 120),
  source_instance_id TEXT NOT NULL CHECK (length(source_instance_id) BETWEEN 1 AND 300),
  external_event_id TEXT NOT NULL CHECK (length(external_event_id) BETWEEN 1 AND 300),
  delivery_id TEXT NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 300),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 160),
  aggregate_id TEXT,
  aggregate_sequence INTEGER CHECK (aggregate_sequence IS NULL OR aggregate_sequence >= 0),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64 AND payload_digest = lower(payload_digest)),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('received', 'applied', 'ignored', 'rejected', 'dead')),
  received_at TEXT NOT NULL CHECK (length(received_at) >= 20),
  applied_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id)
    REFERENCES projects(account_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, source, source_instance_id, external_event_id),
  UNIQUE (account_id, source, source_instance_id, delivery_id)
) STRICT;

CREATE TABLE notifications (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  user_id TEXT NOT NULL CHECK (length(user_id) = 36),
  type TEXT NOT NULL CHECK (length(type) BETWEEN 3 AND 160),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  bug_id TEXT,
  source_event_id TEXT NOT NULL CHECK (length(source_event_id) = 36),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  read_at TEXT CHECK (read_at IS NULL OR read_at >= created_at),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id, project_id)
    REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, user_id)
    REFERENCES users(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, project_id, bug_id)
    REFERENCES bugs(account_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, project_id, source_event_id)
    REFERENCES events(account_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, source_event_id, user_id, type)
) STRICT;

CREATE TABLE notification_devices (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  user_id TEXT NOT NULL CHECK (length(user_id) = 36),
  session_id TEXT NOT NULL CHECK (length(session_id) = 36),
  installation_id TEXT NOT NULL CHECK (length(installation_id) = 36),
  shared_device INTEGER NOT NULL DEFAULT 0 CHECK (shared_device = 0),
  device_id_hash TEXT NOT NULL CHECK (length(device_id_hash) = 64 AND device_id_hash = lower(device_id_hash)),
  platform TEXT NOT NULL CHECK (platform = 'android'),
  provider TEXT NOT NULL CHECK (provider = 'fcm'),
  push_token_hmac TEXT CHECK (push_token_hmac IS NULL OR (length(push_token_hmac) = 64 AND push_token_hmac = lower(push_token_hmac))),
  push_token_ciphertext TEXT CHECK (push_token_ciphertext IS NULL OR length(push_token_ciphertext) BETWEEN 1 AND 8000),
  token_issued_at TEXT NOT NULL CHECK (length(token_issued_at) >= 20),
  server_received_at TEXT NOT NULL CHECK (length(server_received_at) >= 20 AND unixepoch(server_received_at) IS NOT NULL),
  qa_app_version TEXT NOT NULL CHECK (length(qa_app_version) BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20 AND unixepoch(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id, user_id)
    REFERENCES users(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, session_id, user_id, installation_id, shared_device)
    REFERENCES native_sessions(account_id, id, user_id, installation_id, shared_device) ON DELETE CASCADE,
  CHECK (
    (status = 'active' AND push_token_hmac IS NOT NULL AND push_token_ciphertext IS NOT NULL)
    OR (status <> 'active' AND push_token_hmac IS NULL AND push_token_ciphertext IS NULL)
  ),
  CHECK (unixepoch(token_issued_at) IS NOT NULL),
  CHECK (unixepoch(token_issued_at) <= unixepoch(server_received_at) + 300),
  CHECK (unixepoch(created_at) <= unixepoch(server_received_at)),
  UNIQUE (account_id, id),
  UNIQUE (account_id, user_id, installation_id, provider)
) STRICT;

CREATE UNIQUE INDEX notification_devices_active_token_idx
  ON notification_devices(provider, push_token_hmac)
  WHERE status = 'active';

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  user_id TEXT NOT NULL CHECK (length(user_id) = 36),
  endpoint_hmac TEXT NOT NULL CHECK (length(endpoint_hmac) = 64 AND endpoint_hmac = lower(endpoint_hmac)),
  endpoint_ciphertext TEXT NOT NULL CHECK (length(endpoint_ciphertext) BETWEEN 1 AND 8000),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20 AND updated_at >= created_at),
  version INTEGER NOT NULL CHECK (version >= 1),
  FOREIGN KEY (account_id, user_id)
    REFERENCES users(account_id, id) ON DELETE CASCADE,
  UNIQUE (account_id, id),
  UNIQUE (endpoint_hmac)
) STRICT;

CREATE TRIGGER bugs_identity_immutable
BEFORE UPDATE ON bugs
WHEN new.id IS NOT old.id
  OR new.account_id IS NOT old.account_id
  OR new.project_id IS NOT old.project_id
  OR new.number IS NOT old.number
  OR new.key IS NOT old.key
  OR new.reporter_id IS NOT old.reporter_id
  OR new.created_at IS NOT old.created_at
BEGIN
  SELECT RAISE(ABORT, 'Bug tenant, key, reporter, and creation identity are immutable');
END;

CREATE TRIGGER bugs_version_cas_guard
BEFORE UPDATE ON bugs
WHEN new.version <> old.version + 1 OR new.updated_at <= old.updated_at
BEGIN
  SELECT RAISE(ABORT, 'Bug mutations require an exact optimistic-lock version CAS');
END;

CREATE TRIGGER comments_initial_guard
BEFORE INSERT ON comments
WHEN new.version <> 1
BEGIN
  SELECT RAISE(ABORT, 'comments must begin at version one');
END;

CREATE TRIGGER comments_no_update
BEFORE UPDATE ON comments
BEGIN
  SELECT RAISE(ABORT, 'comments are immutable; corrections require an appended comment');
END;

CREATE TRIGGER comments_no_delete
BEFORE DELETE ON comments
BEGIN
  SELECT RAISE(ABORT, 'comments are append-only');
END;

CREATE TRIGGER accounts_initial_guard
BEFORE INSERT ON accounts
WHEN new.version <> 1
BEGIN
  SELECT RAISE(ABORT, 'accounts must begin at version one');
END;

CREATE TRIGGER accounts_transition_guard
BEFORE UPDATE ON accounts
WHEN NOT (
  new.id IS old.id
  AND new.created_at IS old.created_at
  AND new.version = old.version + 1
  AND new.updated_at > old.updated_at
  AND (
    new.status IS old.status
    OR (old.status = 'active' AND new.status = 'disabled')
  )
  AND NOT (
    old.status = 'active'
    AND new.status = 'disabled'
    AND EXISTS (
      SELECT 1 FROM native_sessions AS session
      WHERE session.account_id = old.id AND session.revoked_at IS NULL
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid account lifecycle or version CAS transition');
END;

CREATE TRIGGER accounts_no_delete
BEFORE DELETE ON accounts
BEGIN
  SELECT RAISE(ABORT, 'account identity and lifecycle history are append-only');
END;

CREATE TRIGGER users_initial_guard
BEFORE INSERT ON users
WHEN new.version <> 1
BEGIN
  SELECT RAISE(ABORT, 'users must begin at version one');
END;

CREATE TRIGGER users_transition_guard
BEFORE UPDATE ON users
WHEN NOT (
  new.id IS old.id
  AND new.account_id IS old.account_id
  AND new.created_at IS old.created_at
  AND new.version = old.version + 1
  AND new.updated_at > old.updated_at
  AND (
    new.status IS old.status
    OR (old.status = 'active' AND new.status = 'disabled')
  )
  AND NOT (
    old.status = 'active'
    AND new.status = 'disabled'
    AND EXISTS (
      SELECT 1 FROM native_sessions AS session
      WHERE session.account_id = old.account_id
        AND session.user_id = old.id
        AND session.revoked_at IS NULL
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid user lifecycle or version CAS transition');
END;

CREATE TRIGGER users_no_delete
BEFORE DELETE ON users
BEGIN
  SELECT RAISE(ABORT, 'user identity and lifecycle history are append-only');
END;

CREATE TRIGGER device_installations_initial_guard
BEFORE INSERT ON device_installations
WHEN new.version <> 1
BEGIN
  SELECT RAISE(ABORT, 'device installations must begin at version one');
END;

CREATE TRIGGER device_installations_transition_guard
BEFORE UPDATE ON device_installations
WHEN NOT (
  old.revoked_at IS NULL
  AND new.id IS old.id
  AND new.account_id IS old.account_id
  AND new.installation_id IS old.installation_id
  AND new.platform IS old.platform
  AND new.first_seen_at IS old.first_seen_at
  AND new.last_seen_at >= old.last_seen_at
  AND new.version = old.version + 1
  AND (
    new.revoked_at IS NULL
    OR (
      unixepoch(new.revoked_at) IS NOT NULL
      AND unixepoch(new.revoked_at) >= unixepoch(new.last_seen_at)
    )
  )
  AND NOT (
    new.revoked_at IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM native_sessions AS session
      WHERE session.account_id = old.account_id
        AND session.installation_id = old.id
        AND session.revoked_at IS NULL
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid device installation lifecycle or version CAS transition');
END;

CREATE TRIGGER device_installations_no_delete
BEFORE DELETE ON device_installations
BEGIN
  SELECT RAISE(ABORT, 'device installation identity and revocation history are append-only');
END;

CREATE TRIGGER service_principals_initial_guard
BEFORE INSERT ON service_principals
WHEN new.status <> 'active'
  OR new.revoked_at IS NOT NULL
  OR new.version <> 1
  OR NOT EXISTS (
    SELECT 1 FROM accounts AS account
    WHERE account.id = new.account_id AND account.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'service principal must start active at version one in an active account');
END;

CREATE TRIGGER service_principals_transition_guard
BEFORE UPDATE ON service_principals
WHEN NOT (
  old.status = 'active'
  AND new.status = 'revoked'
  AND new.id IS old.id
  AND new.account_id IS old.account_id
  AND new.name IS old.name
  AND new.principal_type IS old.principal_type
  AND new.credential_digest IS old.credential_digest
  AND new.created_at IS old.created_at
  AND unixepoch(new.revoked_at) IS NOT NULL
  AND abs(unixepoch(new.revoked_at) - unixepoch('now')) <= 5
  AND new.version = old.version + 1
)
BEGIN
  SELECT RAISE(ABORT, 'service principal revocation is a one-way CAS transition');
END;

CREATE TRIGGER service_principals_no_delete
BEFORE DELETE ON service_principals
BEGIN
  SELECT RAISE(ABORT, 'service principal credential history is append-only');
END;

CREATE TRIGGER occurrences_build_identity_immutable
BEFORE UPDATE ON occurrences
WHEN new.id IS NOT old.id
  OR new.account_id IS NOT old.account_id
  OR new.project_id IS NOT old.project_id
  OR new.bug_id IS NOT old.bug_id
  OR new.reporter_id IS NOT old.reporter_id
  OR new.client_submission_id IS NOT old.client_submission_id
  OR new.build_id IS NOT old.build_id
  OR new.capture_bundle_id IS NOT old.capture_bundle_id
  OR new.created_at IS NOT old.created_at
BEGIN
  SELECT RAISE(ABORT, 'occurrence tenant, submission, Build, and capture identity are immutable');
END;

CREATE TRIGGER builds_identity_immutable
BEFORE UPDATE ON builds
WHEN new.id IS NOT old.id
  OR new.account_id IS NOT old.account_id
  OR new.project_id IS NOT old.project_id
  OR new.provider IS NOT old.provider
  OR new.external_id IS NOT old.external_id
  OR new.version_name IS NOT old.version_name
  OR new.channel IS NOT old.channel
  OR new.project_key IS NOT old.project_key
  OR new.branch IS NOT old.branch
  OR new.source_commit_sha IS NOT old.source_commit_sha
  OR new.mode IS NOT old.mode
  OR new.manifest_json IS NOT old.manifest_json
  OR new.manifest_digest IS NOT old.manifest_digest
  OR new.created_at IS NOT old.created_at
BEGIN
  SELECT RAISE(ABORT, 'Build identity, source, and manifest are immutable');
END;

CREATE TRIGGER builds_initial_guard
BEFORE INSERT ON builds
WHEN new.version <> 1
BEGIN
  SELECT RAISE(ABORT, 'Build lifecycle must begin at version one');
END;

CREATE TRIGGER builds_lifecycle_guard
BEFORE UPDATE ON builds
WHEN NOT (
  old.status NOT IN ('ready', 'failed')
  AND new.version = old.version + 1
  AND new.updated_at > old.updated_at
  AND (
    new.status = old.status
    OR new.status = 'failed'
    OR (
      CASE new.status
        WHEN 'registered' THEN 0
        WHEN 'queued' THEN 1
        WHEN 'building' THEN 2
        WHEN 'validating' THEN 3
        WHEN 'publishing' THEN 4
        WHEN 'ready' THEN 5
        ELSE -1
      END
      >
      CASE old.status
        WHEN 'registered' THEN 0
        WHEN 'queued' THEN 1
        WHEN 'building' THEN 2
        WHEN 'validating' THEN 3
        WHEN 'publishing' THEN 4
        ELSE 99
      END
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Build lifecycle requires a forward CAS transition');
END;

CREATE TRIGGER builds_linked_no_delete
BEFORE DELETE ON builds
WHEN EXISTS (
  SELECT 1 FROM build_repair_links AS link
  WHERE link.account_id = old.account_id
    AND link.project_id = old.project_id
    AND link.build_id = old.id
)
BEGIN
  SELECT RAISE(ABORT, 'Build evidence referenced by a repair link is append-only');
END;

CREATE TRIGGER builds_linked_no_update
BEFORE UPDATE ON builds
WHEN EXISTS (
  SELECT 1 FROM build_repair_links AS link
  WHERE link.account_id = old.account_id
    AND link.project_id = old.project_id
    AND link.build_id = old.id
)
BEGIN
  SELECT RAISE(ABORT, 'Build facts referenced by a repair link are immutable');
END;

CREATE TRIGGER build_manifest_commits_no_update
BEFORE UPDATE ON build_manifest_commits
BEGIN
  SELECT RAISE(ABORT, 'Build manifest commit facts are immutable');
END;

CREATE TRIGGER build_manifest_commits_sealed_insert
BEFORE INSERT ON build_manifest_commits
WHEN EXISTS (
  SELECT 1 FROM builds AS build
  WHERE build.account_id = new.account_id
    AND build.project_id = new.project_id
    AND build.id = new.build_id
    AND (
      build.status = 'ready'
      OR EXISTS (
        SELECT 1 FROM build_repair_links AS link
        WHERE link.account_id = build.account_id
          AND link.project_id = build.project_id
          AND link.build_id = build.id
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'a ready or linked Build manifest is sealed');
END;

CREATE TRIGGER build_manifest_commits_sealed_delete
BEFORE DELETE ON build_manifest_commits
WHEN EXISTS (
  SELECT 1 FROM builds AS build
  WHERE build.account_id = old.account_id
    AND build.project_id = old.project_id
    AND build.id = old.build_id
    AND (
      build.status = 'ready'
      OR EXISTS (
        SELECT 1 FROM build_repair_links AS link
        WHERE link.account_id = build.account_id
          AND link.project_id = build.project_id
          AND link.build_id = build.id
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'a ready or linked Build manifest is sealed');
END;

CREATE TRIGGER verifications_current_manifest_guard
BEFORE INSERT ON verifications
WHEN new.build_id IS NOT NULL AND EXISTS (
  SELECT 1
  FROM build_requirements AS requirement
  JOIN build_repair_links AS link
    ON link.account_id = requirement.account_id
   AND link.project_id = requirement.project_id
   AND link.build_requirement_id = requirement.id
  WHERE requirement.account_id = new.account_id
    AND requirement.project_id = new.project_id
    AND requirement.bug_id = new.bug_id
    AND requirement.repair_attempt_id = new.repair_attempt_id
    AND requirement.requirement = 'required'
    AND requirement.version = 2
    AND requirement.linked_build_id = new.build_id
    AND link.evidence_type = 'manifest'
    AND NOT EXISTS (
      SELECT 1 FROM build_manifest_commits AS manifest_commit
      WHERE manifest_commit.account_id = requirement.account_id
        AND manifest_commit.project_id = requirement.project_id
        AND manifest_commit.build_id = new.build_id
        AND manifest_commit.commit_sha = requirement.delivered_commit_sha
    )
)
BEGIN
  SELECT RAISE(ABORT, 'verification requires the current exact sealed Build manifest commit');
END;

CREATE TRIGGER upload_chunks_no_update
BEFORE UPDATE ON upload_chunks
BEGIN
  SELECT RAISE(ABORT, 'upload chunk geometry, digest, and storage identity are immutable');
END;

CREATE TRIGGER upload_chunks_no_delete
BEFORE DELETE ON upload_chunks
BEGIN
  SELECT RAISE(ABORT, 'durable upload chunks are append-only');
END;

CREATE TRIGGER upload_sessions_transition_guard
BEFORE UPDATE ON upload_sessions
WHEN NOT (
  new.version = old.version + 1
  AND new.updated_at > old.updated_at
  AND new.received_size_bytes >= old.received_size_bytes
  AND new.received_size_bytes = (
    SELECT coalesce(sum(chunk.size_bytes), 0)
    FROM upload_chunks AS chunk
    WHERE chunk.account_id = new.account_id
      AND chunk.project_id = new.project_id
      AND chunk.upload_session_id = new.id
      AND chunk.generation = new.generation
  )
  AND (
    (old.status = 'open' AND new.status = 'open'
      AND unixepoch(old.expires_at) > unixepoch('now')
      AND new.finalized_attachment_id IS NULL)
    OR (old.status = 'open' AND new.status = 'finalizing'
      AND unixepoch(old.expires_at) > unixepoch('now')
      AND new.received_size_bytes = new.expected_size_bytes
      AND new.finalized_attachment_id IS NULL)
    OR (old.status = 'open' AND new.status = 'expired'
      AND unixepoch(old.expires_at) <= unixepoch('now')
      AND new.finalized_attachment_id IS NULL)
    OR (old.status = 'finalizing' AND new.status IN ('finalized', 'rejected')
      AND new.finalized_attachment_id IS NOT NULL)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid upload session transition, CAS version, or terminal resurrection');
END;

CREATE TRIGGER upload_sessions_no_delete
BEFORE DELETE ON upload_sessions
BEGIN
  SELECT RAISE(ABORT, 'upload lease and submission history is append-only');
END;

CREATE TRIGGER blobs_identity_immutable
BEFORE UPDATE ON blobs
WHEN new.id IS NOT old.id
  OR new.account_id IS NOT old.account_id
  OR new.sha256 IS NOT old.sha256
  OR new.size_bytes IS NOT old.size_bytes
  OR new.storage_key IS NOT old.storage_key
  OR new.encryption_json IS NOT old.encryption_json
  OR new.created_at IS NOT old.created_at
BEGIN
  SELECT RAISE(ABORT, 'blob tenant, digest, size, storage, and encryption identity are immutable');
END;

CREATE TRIGGER blobs_initial_guard
BEFORE INSERT ON blobs
WHEN new.version <> 1 OR new.state = 'deleted'
BEGIN
  SELECT RAISE(ABORT, 'blob evidence must begin ready or quarantined at version one');
END;

CREATE TRIGGER blobs_lifecycle_guard
BEFORE UPDATE ON blobs
WHEN NOT (
  new.version = old.version + 1
  AND (
    (old.state IN ('ready', 'quarantined') AND new.state = 'deleted')
    OR (
      old.state = 'quarantined'
      AND new.state = 'ready'
      AND EXISTS (
        SELECT 1
        FROM attachments AS attachment
        JOIN upload_sessions AS upload
          ON upload.account_id = attachment.account_id
         AND upload.project_id = attachment.project_id
         AND upload.id = attachment.upload_session_id
        WHERE attachment.account_id = old.account_id
          AND attachment.blob_id = old.id
          AND attachment.status = 'quarantined'
          AND attachment.scan_state = 'pending'
          AND upload.status = 'finalizing'
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'blob lifecycle requires a one-way exact version CAS');
END;

CREATE TRIGGER blobs_no_delete
BEFORE DELETE ON blobs
BEGIN
  SELECT RAISE(ABORT, 'blob evidence lifecycle is append-only');
END;

CREATE TRIGGER attachments_referenced_truth_guard
BEFORE UPDATE OF status, scan_state ON attachments
WHEN (new.status <> 'ready' OR new.scan_state <> 'clean') AND (
  EXISTS (SELECT 1 FROM attachment_bindings AS binding
    WHERE binding.account_id = old.account_id AND binding.project_id = old.project_id
      AND binding.attachment_id = old.id AND binding.state = 'claimed')
  OR EXISTS (SELECT 1 FROM bug_attachments AS link
    WHERE link.account_id = old.account_id AND link.project_id = old.project_id AND link.attachment_id = old.id)
  OR EXISTS (SELECT 1 FROM occurrence_attachments AS link
    WHERE link.account_id = old.account_id AND link.project_id = old.project_id AND link.attachment_id = old.id)
  OR EXISTS (SELECT 1 FROM comment_attachments AS link
    WHERE link.account_id = old.account_id AND link.project_id = old.project_id AND link.attachment_id = old.id)
  OR EXISTS (SELECT 1 FROM verification_attachments AS link
    WHERE link.account_id = old.account_id AND link.project_id = old.project_id AND link.attachment_id = old.id)
  OR EXISTS (SELECT 1 FROM capture_bundles AS capture
    WHERE capture.account_id = old.account_id AND capture.project_id = old.project_id
      AND capture.primary_attachment_id = old.id)
  OR EXISTS (SELECT 1 FROM capture_artifacts AS artifact
    WHERE artifact.account_id = old.account_id AND artifact.project_id = old.project_id
      AND artifact.attachment_id = old.id)
)
BEGIN
  SELECT RAISE(ABORT, 'referenced attachment must remain ready and clean');
END;

CREATE TRIGGER attachments_referenced_no_delete
BEFORE DELETE ON attachments
WHEN EXISTS (SELECT 1 FROM attachment_bindings AS binding
  WHERE binding.account_id = old.account_id AND binding.project_id = old.project_id
    AND binding.attachment_id = old.id AND binding.state = 'claimed')
OR EXISTS (SELECT 1 FROM capture_bundles AS capture
  WHERE capture.account_id = old.account_id AND capture.project_id = old.project_id
    AND capture.primary_attachment_id = old.id)
OR EXISTS (SELECT 1 FROM capture_artifacts AS artifact
  WHERE artifact.account_id = old.account_id AND artifact.project_id = old.project_id
    AND artifact.attachment_id = old.id)
BEGIN
  SELECT RAISE(ABORT, 'referenced attachment evidence is append-only');
END;

CREATE TRIGGER blobs_referenced_truth_guard
BEFORE UPDATE OF state ON blobs
WHEN new.state <> 'ready' AND EXISTS (
  SELECT 1 FROM attachments AS attachment
  WHERE attachment.account_id = old.account_id
    AND attachment.blob_id = old.id
    AND attachment.status = 'ready'
    AND attachment.scan_state = 'clean'
    AND (
      EXISTS (SELECT 1 FROM attachment_bindings AS binding
        WHERE binding.account_id = attachment.account_id
          AND binding.project_id = attachment.project_id
          AND binding.attachment_id = attachment.id AND binding.state = 'claimed')
      OR EXISTS (SELECT 1 FROM capture_bundles AS capture
        WHERE capture.account_id = attachment.account_id
          AND capture.project_id = attachment.project_id
          AND capture.primary_attachment_id = attachment.id)
      OR EXISTS (SELECT 1 FROM capture_artifacts AS artifact
        WHERE artifact.account_id = attachment.account_id
          AND artifact.project_id = attachment.project_id
          AND artifact.attachment_id = attachment.id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'blob backing referenced ready evidence cannot be removed');
END;

CREATE TRIGGER capture_bundles_identity_immutable
BEFORE UPDATE ON capture_bundles
WHEN new.id IS NOT old.id
  OR new.account_id IS NOT old.account_id
  OR new.project_id IS NOT old.project_id
  OR new.actor_id IS NOT old.actor_id
  OR new.capture_id IS NOT old.capture_id
  OR new.client_submission_id IS NOT old.client_submission_id
  OR new.source IS NOT old.source
  OR new.primary_client_attachment_id IS NOT old.primary_client_attachment_id
  OR new.primary_attachment_id IS NOT old.primary_attachment_id
  OR new.started_at IS NOT old.started_at
  OR new.ended_at IS NOT old.ended_at
  OR new.captured_at IS NOT old.captured_at
  OR new.device_metadata_json IS NOT old.device_metadata_json
  OR new.build_id IS NOT old.build_id
  OR new.created_at IS NOT old.created_at
BEGIN
  SELECT RAISE(ABORT, 'capture identity, provenance, timestamps, device, and Build facts are immutable');
END;

CREATE TRIGGER capture_bundles_transition_guard
BEFORE UPDATE ON capture_bundles
WHEN NOT (
  new.version = old.version + 1
  AND new.updated_at > old.updated_at
  AND (
    new.enrichment_status = old.enrichment_status
    OR (old.enrichment_status = 'unavailable' AND new.enrichment_status IN ('partial', 'complete'))
    OR (old.enrichment_status = 'partial' AND new.enrichment_status = 'complete')
  )
  AND (
    (old.status = 'draft' AND new.status IN ('draft', 'queued', 'uploaded', 'discarded'))
    OR (old.status = 'queued' AND new.status IN ('queued', 'uploaded', 'discarded'))
    OR (old.status = 'uploaded' AND new.status = 'bound')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid capture transition, CAS version, or finalized evidence mutation');
END;

CREATE TRIGGER capture_artifacts_finalized_insert
BEFORE INSERT ON capture_artifacts
WHEN EXISTS (SELECT 1 FROM capture_bundles AS capture
  WHERE capture.account_id = new.account_id AND capture.project_id = new.project_id
    AND capture.id = new.capture_bundle_id AND capture.status IN ('uploaded', 'bound', 'discarded'))
BEGIN SELECT RAISE(ABORT, 'finalized capture children are sealed'); END;
CREATE TRIGGER capture_artifacts_finalized_update
BEFORE UPDATE ON capture_artifacts
WHEN EXISTS (SELECT 1 FROM capture_bundles AS capture
  WHERE capture.account_id = old.account_id AND capture.project_id = old.project_id
    AND capture.id = old.capture_bundle_id AND capture.status IN ('uploaded', 'bound', 'discarded'))
BEGIN SELECT RAISE(ABORT, 'finalized capture children are sealed'); END;
CREATE TRIGGER capture_artifacts_finalized_delete
BEFORE DELETE ON capture_artifacts
WHEN EXISTS (SELECT 1 FROM capture_bundles AS capture
  WHERE capture.account_id = old.account_id AND capture.project_id = old.project_id
    AND capture.id = old.capture_bundle_id AND capture.status IN ('uploaded', 'bound', 'discarded'))
BEGIN SELECT RAISE(ABORT, 'finalized capture children are append-only'); END;

CREATE TRIGGER capture_poco_methods_finalized_insert
BEFORE INSERT ON capture_poco_methods
WHEN EXISTS (SELECT 1 FROM capture_bundles AS capture
  WHERE capture.account_id = new.account_id AND capture.project_id = new.project_id
    AND capture.id = new.capture_bundle_id AND capture.status IN ('uploaded', 'bound', 'discarded'))
BEGIN SELECT RAISE(ABORT, 'finalized Poco outcomes are sealed'); END;
CREATE TRIGGER capture_poco_methods_no_update
BEFORE UPDATE ON capture_poco_methods
BEGIN SELECT RAISE(ABORT, 'Poco method outcomes are immutable terminal facts'); END;
CREATE TRIGGER capture_poco_methods_no_delete
BEFORE DELETE ON capture_poco_methods
BEGIN SELECT RAISE(ABORT, 'Poco method outcomes are append-only'); END;

CREATE TRIGGER poco_snapshots_finalized_insert
BEFORE INSERT ON poco_snapshots
WHEN EXISTS (SELECT 1 FROM capture_bundles AS capture
  WHERE capture.account_id = new.account_id AND capture.project_id = new.project_id
    AND capture.id = new.capture_bundle_id AND capture.status IN ('uploaded', 'bound', 'discarded'))
BEGIN SELECT RAISE(ABORT, 'finalized Poco snapshots are sealed'); END;
CREATE TRIGGER poco_snapshots_no_update
BEFORE UPDATE ON poco_snapshots
BEGIN SELECT RAISE(ABORT, 'Poco snapshots are immutable facts'); END;
CREATE TRIGGER poco_snapshots_no_delete
BEFORE DELETE ON poco_snapshots
BEGIN SELECT RAISE(ABORT, 'Poco snapshots are append-only'); END;

CREATE TRIGGER poco_enrichments_finalized_insert
BEFORE INSERT ON poco_enrichments
WHEN EXISTS (SELECT 1 FROM capture_bundles AS capture
  WHERE capture.account_id = new.account_id AND capture.project_id = new.project_id
    AND capture.id = new.capture_bundle_id AND capture.status IN ('uploaded', 'bound', 'discarded'))
BEGIN SELECT RAISE(ABORT, 'finalized Poco enrichment is sealed'); END;

CREATE TRIGGER poco_enrichments_initial_guard
BEFORE INSERT ON poco_enrichments
WHEN new.version <> 1
  OR new.attempted <> 0
  OR new.status <> 'unavailable'
  OR new.connected_port IS NOT NULL
  OR new.sdk_version IS NOT NULL
  OR new.snapshot_capability <> 'not_probed'
  OR new.screen_width IS NOT NULL
  OR new.screen_height IS NOT NULL
  OR new.error_code IS NOT NULL
  OR new.failure_reason IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Poco enrichment must begin effect-free at version one');
END;

CREATE TRIGGER poco_enrichments_transition_guard
BEFORE UPDATE ON poco_enrichments
WHEN NOT (
  new.id IS old.id
  AND new.account_id IS old.account_id
  AND new.project_id IS old.project_id
  AND new.capture_bundle_id IS old.capture_bundle_id
  AND new.capture_id IS old.capture_id
  AND new.nonce_hash IS old.nonce_hash
  AND new.schema_version IS old.schema_version
  AND new.version = old.version + 1
  AND new.collected_at >= old.collected_at
  AND new.attempted = 1
  AND new.attempted >= old.attempted
  AND old.status <> 'complete'
  AND (
    new.status IS old.status
    OR (old.status = 'unavailable' AND new.status IN ('partial', 'complete'))
    OR (old.status = 'partial' AND new.status = 'complete')
  )
  AND (
    new.snapshot_capability IS old.snapshot_capability
    OR (old.snapshot_capability = 'not_probed' AND new.snapshot_capability IN ('standard_only', 'qa_snapshot_available'))
    OR (old.snapshot_capability = 'standard_only' AND new.snapshot_capability = 'qa_snapshot_available')
  )
  AND (old.connected_port IS NULL OR new.connected_port IS old.connected_port)
  AND (old.sdk_version IS NULL OR new.sdk_version IS old.sdk_version)
  AND (old.screen_width IS NULL OR new.screen_width IS old.screen_width)
  AND (old.screen_height IS NULL OR new.screen_height IS old.screen_height)
  AND (
    (
      new.attempted = 0
      AND new.status = 'unavailable'
      AND new.connected_port IS NULL
      AND new.sdk_version IS NULL
      AND new.snapshot_capability = 'not_probed'
      AND new.screen_width IS NULL
      AND new.screen_height IS NULL
      AND new.error_code IS NULL
      AND new.failure_reason IS NULL
    )
    OR (
      new.attempted = 1
      AND new.status IN ('unavailable', 'partial', 'complete')
      AND (new.snapshot_capability = 'not_probed' OR new.connected_port IS NOT NULL)
      AND (new.sdk_version IS NULL OR new.connected_port IS NOT NULL)
      AND (
        new.status <> 'complete'
        OR (
          new.connected_port IS NOT NULL
          AND new.sdk_version IS NOT NULL
          AND new.snapshot_capability IN ('standard_only', 'qa_snapshot_available')
          AND new.screen_width IS NOT NULL
          AND new.screen_height IS NOT NULL
          AND new.error_code IS NULL
          AND new.failure_reason IS NULL
        )
      )
    )
  )
  AND EXISTS (
    SELECT 1 FROM capture_bundles AS capture
    WHERE capture.account_id = old.account_id
      AND capture.project_id = old.project_id
      AND capture.id = old.capture_bundle_id
      AND capture.status IN ('draft', 'queued')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Poco enrichment requires a coherent one-way exact CAS transition');
END;

CREATE TRIGGER poco_enrichments_no_delete
BEFORE DELETE ON poco_enrichments
BEGIN SELECT RAISE(ABORT, 'Poco enrichment history is append-only'); END;

CREATE TRIGGER native_sessions_transition_guard
BEFORE UPDATE ON native_sessions
WHEN NOT (
  old.revoked_at IS NULL
  AND new.id IS old.id
  AND new.account_id IS old.account_id
  AND new.user_id IS old.user_id
  AND new.installation_id IS old.installation_id
  AND new.access_token_digest IS old.access_token_digest
  AND new.shared_device IS old.shared_device
  AND new.push_allowed IS old.push_allowed
  AND new.issued_at IS old.issued_at
  AND new.access_expires_at IS old.access_expires_at
  AND new.idle_expires_at IS old.idle_expires_at
  AND new.absolute_expires_at IS old.absolute_expires_at
  AND unixepoch(new.last_seen_at) >= unixepoch(old.last_seen_at)
  AND new.version = old.version + 1
  AND (
    (new.revoked_at IS NULL AND new.revoked_reason IS NULL)
    OR (
      unixepoch(new.revoked_at) IS NOT NULL
      AND abs(unixepoch(new.revoked_at) - unixepoch('now')) <= 5
      AND new.revoked_reason IS NOT NULL
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid native session CAS transition or revoked-session resurrection');
END;

CREATE TRIGGER native_sessions_initial_guard
BEFORE INSERT ON native_sessions
WHEN new.version <> 1
  OR new.revoked_at IS NOT NULL
  OR new.revoked_reason IS NOT NULL
  OR new.last_seen_at IS NOT new.issued_at
  OR unixepoch(new.access_expires_at) <= unixepoch('now')
  OR unixepoch(new.idle_expires_at) <= unixepoch('now')
  OR unixepoch(new.absolute_expires_at) <= unixepoch('now')
  OR NOT EXISTS (
    SELECT 1
    FROM users AS user
    JOIN accounts AS account ON account.id = user.account_id
    JOIN device_installations AS installation
      ON installation.account_id = user.account_id
     AND installation.id = new.installation_id
    WHERE user.account_id = new.account_id
      AND user.id = new.user_id
      AND user.status = 'active'
      AND account.status = 'active'
      AND installation.revoked_at IS NULL
      AND installation.shared_device = new.shared_device
  )
BEGIN
  SELECT RAISE(ABORT, 'native session must start current, active, and at version one');
END;

CREATE TRIGGER native_sessions_revoke_active_family_guard
BEFORE UPDATE OF revoked_at ON native_sessions
WHEN old.revoked_at IS NULL AND new.revoked_at IS NOT NULL AND EXISTS (
  SELECT 1 FROM refresh_token_families AS family
  WHERE family.account_id = old.account_id
    AND family.session_id = old.id
    AND family.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'native session revocation requires every refresh family to be terminal first');
END;

CREATE TRIGGER native_sessions_no_delete
BEFORE DELETE ON native_sessions
BEGIN
  SELECT RAISE(ABORT, 'native session security history is append-only');
END;

CREATE TRIGGER refresh_token_families_initial_guard
BEFORE INSERT ON refresh_token_families
WHEN new.status <> 'active'
  OR new.version <> 1
  OR new.revoked_at IS NOT NULL
  OR new.revoked_reason IS NOT NULL
  OR abs(unixepoch(new.created_at) - unixepoch('now')) > 5
  OR NOT EXISTS (
    SELECT 1
    FROM native_sessions AS session
    JOIN users AS user
      ON user.account_id = session.account_id AND user.id = session.user_id
    JOIN accounts AS account ON account.id = session.account_id
    JOIN device_installations AS installation
      ON installation.account_id = session.account_id
     AND installation.id = session.installation_id
    WHERE session.account_id = new.account_id
      AND session.id = new.session_id
      AND session.user_id = new.user_id
      AND session.installation_id = new.installation_id
      AND session.revoked_at IS NULL
      AND user.status = 'active'
      AND account.status = 'active'
      AND installation.revoked_at IS NULL
      AND unixepoch(session.access_expires_at) > unixepoch('now')
      AND unixepoch(session.absolute_expires_at) > unixepoch('now')
  )
BEGIN
  SELECT RAISE(ABORT, 'refresh family must start active on a current non-revoked native session');
END;

CREATE TRIGGER refresh_token_families_transition_guard
BEFORE UPDATE ON refresh_token_families
WHEN NOT (
  old.status = 'active'
  AND new.status IN ('revoked', 'expired')
  AND new.id IS old.id
  AND new.account_id IS old.account_id
  AND new.user_id IS old.user_id
  AND new.session_id IS old.session_id
  AND new.installation_id IS old.installation_id
  AND new.created_at IS old.created_at
  AND new.version = old.version + 1
  AND (
    (new.status = 'revoked'
      AND unixepoch(new.revoked_at) IS NOT NULL
      AND abs(unixepoch(new.revoked_at) - unixepoch('now')) <= 5
      AND new.revoked_reason IS NOT NULL)
    OR (new.status = 'expired' AND new.revoked_at IS NULL AND new.revoked_reason IS NULL)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'refresh family status is one-way and terminal');
END;

CREATE TRIGGER refresh_token_families_terminal_token_guard
BEFORE UPDATE OF status ON refresh_token_families
WHEN new.status IN ('revoked', 'expired') AND EXISTS (
  SELECT 1 FROM refresh_tokens AS token
  WHERE token.account_id = old.account_id
    AND token.family_id = old.id
    AND token.status IN ('pending', 'active')
)
BEGIN
  SELECT RAISE(ABORT, 'refresh family cannot terminate while a usable token remains');
END;

CREATE TRIGGER refresh_token_families_no_delete
BEFORE DELETE ON refresh_token_families
BEGIN
  SELECT RAISE(ABORT, 'refresh family reuse and revocation history is append-only');
END;

CREATE TRIGGER refresh_tokens_initial_guard
BEFORE INSERT ON refresh_tokens
WHEN NOT EXISTS (
  SELECT 1
  FROM refresh_token_families AS family
  JOIN native_sessions AS session
    ON session.account_id = family.account_id
   AND session.id = family.session_id
  JOIN users AS user
    ON user.account_id = session.account_id AND user.id = session.user_id
  JOIN accounts AS account ON account.id = session.account_id
  JOIN device_installations AS installation
    ON installation.account_id = session.account_id
   AND installation.id = session.installation_id
  WHERE family.account_id = new.account_id
    AND family.id = new.family_id
    AND family.status = 'active'
    AND session.revoked_at IS NULL
    AND user.status = 'active'
    AND account.status = 'active'
    AND installation.revoked_at IS NULL
    AND abs(unixepoch(new.issued_at) - unixepoch('now')) <= 5
    AND unixepoch(session.absolute_expires_at) > unixepoch('now')
    AND unixepoch(new.expires_at) > unixepoch('now')
    AND unixepoch(new.expires_at) <= unixepoch(session.absolute_expires_at)
    AND unixepoch(new.expires_at) <= unixepoch(family.created_at) + 2592000
    AND (
      (
        new.status = 'active'
        AND new.generation = 1
        AND new.version = 1
        AND NOT EXISTS (
          SELECT 1 FROM refresh_tokens AS existing
          WHERE existing.account_id = new.account_id
            AND existing.family_id = new.family_id
        )
      )
      OR (
        new.status = 'pending'
        AND new.generation > 1
        AND new.version = 1
        AND EXISTS (
          SELECT 1 FROM refresh_tokens AS predecessor
          WHERE predecessor.account_id = new.account_id
            AND predecessor.family_id = new.family_id
            AND predecessor.generation = new.generation - 1
            AND predecessor.status = 'active'
        )
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'refresh token must be the exact next generation of an active current family');
END;

CREATE TRIGGER refresh_tokens_transition_guard
BEFORE UPDATE ON refresh_tokens
WHEN NOT (
  new.id IS old.id
  AND new.account_id IS old.account_id
  AND new.family_id IS old.family_id
  AND new.generation IS old.generation
  AND new.token_digest IS old.token_digest
  AND new.issued_at IS old.issued_at
  AND new.expires_at IS old.expires_at
  AND new.version = old.version + 1
  AND (
    (old.status = 'pending' AND new.status IN ('active', 'revoked', 'expired'))
    OR (old.status = 'active' AND new.status IN ('consumed', 'revoked', 'expired'))
  )
  AND (
    new.status IN ('revoked', 'expired')
    OR (
      new.status IN ('active', 'consumed')
      AND unixepoch(new.expires_at) > unixepoch('now')
      AND EXISTS (
        SELECT 1
        FROM refresh_token_families AS family
        JOIN native_sessions AS session
          ON session.account_id = family.account_id
         AND session.id = family.session_id
        JOIN users AS user
          ON user.account_id = session.account_id AND user.id = session.user_id
        JOIN accounts AS account ON account.id = session.account_id
        JOIN device_installations AS installation
          ON installation.account_id = session.account_id
         AND installation.id = session.installation_id
        WHERE family.account_id = new.account_id
          AND family.id = new.family_id
          AND family.status = 'active'
          AND session.revoked_at IS NULL
          AND user.status = 'active'
          AND account.status = 'active'
          AND installation.revoked_at IS NULL
          AND unixepoch(new.issued_at) <= unixepoch('now')
          AND unixepoch(new.expires_at) <= unixepoch(family.created_at) + 2592000
          AND unixepoch(session.absolute_expires_at) > unixepoch('now')
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'refresh token state is one-way with exact CAS versioning');
END;

CREATE TRIGGER refresh_tokens_no_delete
BEFORE DELETE ON refresh_tokens
BEGIN
  SELECT RAISE(ABORT, 'refresh token rotation and reuse evidence is append-only');
END;

CREATE TRIGGER auth_secret_replays_no_update
BEFORE UPDATE ON auth_secret_replays
BEGIN
  SELECT RAISE(ABORT, 'auth secret replay effects are immutable');
END;

CREATE TRIGGER auth_secret_replays_no_delete
BEFORE DELETE ON auth_secret_replays
BEGIN
  SELECT RAISE(ABORT, 'auth secret replay effects are append-only');
END;

CREATE TRIGGER idempotency_records_initial_guard
BEFORE INSERT ON idempotency_records
WHEN new.status <> 'reserved'
  OR new.version <> 1
  OR new.operation_id IN ('createNativeSession', 'refreshNativeSession')
  OR abs(unixepoch(new.created_at) - unixepoch('now')) > 600
  OR unixepoch(new.expires_at) <= unixepoch('now')
  OR unixepoch(new.expires_at) > unixepoch('now') + 2592000
BEGIN
  SELECT RAISE(ABORT, 'idempotency record must begin as an effect-free non-secret reservation');
END;

CREATE TRIGGER idempotency_records_response_privacy_insert
BEFORE INSERT ON idempotency_records
WHEN (new.response_json IS NOT NULL AND length(CAST(new.response_json AS BLOB)) > 65536)
  OR EXISTS (
    SELECT 1 FROM json_tree(new.response_json)
    WHERE typeof(key) = 'text'
      AND lower(replace(replace(CAST(key AS TEXT), '_', ''), '-', '')) IN (
        'token', 'accesstoken', 'refreshtoken', 'authtoken', 'bearertoken',
        'idtoken', 'tokenhash', 'tokendigest', 'authorization', 'password',
        'passwd', 'passwordhash', 'secret', 'clientsecret', 'credential',
        'clientcredential', 'cookie', 'setcookie', 'email', 'phone', 'session',
        'sessionid', 'sessiontoken', 'apikey', 'xapikey', 'privatekey'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'generic idempotency response must not persist authentication secrets');
END;

CREATE TRIGGER idempotency_records_scope_privacy_insert
BEFORE INSERT ON idempotency_records
WHEN length(CAST(new.scope_json AS BLOB)) > 16384
  OR EXISTS (
    SELECT 1 FROM json_tree(new.scope_json)
    WHERE typeof(key) = 'text'
      AND lower(replace(replace(CAST(key AS TEXT), '_', ''), '-', '')) IN (
        'token', 'accesstoken', 'refreshtoken', 'authtoken', 'bearertoken',
        'idtoken', 'tokenhash', 'tokendigest', 'authorization', 'password',
        'passwd', 'passwordhash', 'secret', 'clientsecret', 'credential',
        'clientcredential', 'cookie', 'setcookie', 'email', 'phone', 'session',
        'sessionid', 'sessiontoken', 'apikey', 'xapikey', 'privatekey'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'generic idempotency scope must not persist authentication secrets');
END;

CREATE TRIGGER idempotency_records_response_privacy_update
BEFORE UPDATE OF response_json ON idempotency_records
WHEN (new.response_json IS NOT NULL AND length(CAST(new.response_json AS BLOB)) > 65536)
  OR EXISTS (
    SELECT 1 FROM json_tree(new.response_json)
    WHERE typeof(key) = 'text'
      AND lower(replace(replace(CAST(key AS TEXT), '_', ''), '-', '')) IN (
        'token', 'accesstoken', 'refreshtoken', 'authtoken', 'bearertoken',
        'idtoken', 'tokenhash', 'tokendigest', 'authorization', 'password',
        'passwd', 'passwordhash', 'secret', 'clientsecret', 'credential',
        'clientcredential', 'cookie', 'setcookie', 'email', 'phone', 'session',
        'sessionid', 'sessiontoken', 'apikey', 'xapikey', 'privatekey'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'generic idempotency response must not persist authentication secrets');
END;

CREATE TRIGGER idempotency_records_transition_guard
BEFORE UPDATE ON idempotency_records
WHEN NOT (
  old.status = 'reserved'
  AND new.status IN ('committed', 'failed')
  AND new.id IS old.id
  AND new.account_id IS old.account_id
  AND new.project_id IS old.project_id
  AND new.actor_id IS old.actor_id
  AND new.operation_id IS old.operation_id
  AND new.idempotency_key IS old.idempotency_key
  AND new.scope_digest IS old.scope_digest
  AND new.scope_json IS old.scope_json
  AND new.request_digest IS old.request_digest
  AND new.created_at IS old.created_at
  AND new.expires_at IS old.expires_at
  AND new.version = old.version + 1
  AND (
    new.status <> 'committed'
    OR EXISTS (
      SELECT 1 FROM events AS event
      WHERE event.id = new.audit_event_id
        AND event.account_id = new.account_id
        AND event.project_id = new.project_id
        AND event.actor_type = 'user'
        AND event.actor_user_id = new.actor_id
        AND event.request_digest = new.request_digest
    )
  )
  AND (
    new.status <> 'committed'
    OR new.operation_id NOT IN (
      'createBug', 'addOccurrence', 'addBugComment',
      'recordVerificationResult', 'createCaptureBundle'
    )
    OR EXISTS (
      SELECT 1 FROM submissions AS submission
      WHERE submission.account_id = new.account_id
        AND submission.project_id = new.project_id
        AND submission.actor_id = new.actor_id
        AND submission.payload_digest = new.request_digest
        AND submission.response_json IS new.response_json
        AND submission.intent = CASE new.operation_id
          WHEN 'createBug' THEN 'bug_create'
          WHEN 'addOccurrence' THEN 'occurrence_append'
          WHEN 'addBugComment' THEN 'comment_append'
          WHEN 'recordVerificationResult' THEN 'verification_result'
          WHEN 'createCaptureBundle' THEN 'capture_create'
        END
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'idempotency terminal response requires its exact immutable typed effect and audit');
END;

CREATE TRIGGER idempotency_records_no_delete
BEFORE DELETE ON idempotency_records
BEGIN
  SELECT RAISE(ABORT, 'idempotency effects are append-only until controlled archival');
END;

CREATE TRIGGER submissions_response_exact_effect
BEFORE INSERT ON submissions
WHEN json_type(new.response_json) <> 'object'
  OR json_extract(new.response_json, '$.clientSubmissionId') IS NOT new.client_submission_id
  OR json_extract(new.response_json, '$.projectId') IS NOT new.project_id
  OR json_extract(new.response_json, '$.bugId') IS NOT new.bug_id
  OR json_extract(new.response_json, '$.occurrenceId') IS NOT new.occurrence_id
  OR json_extract(new.response_json, '$.commentId') IS NOT new.comment_id
  OR json_extract(new.response_json, '$.verificationId') IS NOT new.verification_id
  OR json_extract(new.response_json, '$.captureBundleId') IS NOT new.capture_bundle_id
BEGIN
  SELECT RAISE(ABORT, 'submission response snapshot must match every typed committed effect');
END;

CREATE TRIGGER events_payload_privacy_guard
BEFORE INSERT ON events
WHEN json_type(new.payload_json) <> 'object'
  OR length(CAST(new.payload_json AS BLOB)) > 4096
  OR EXISTS (
    SELECT 1 FROM json_each(new.payload_json)
    WHERE key NOT IN (
      'summary', 'reason', 'status', 'relatedBugId', 'repairAttemptId', 'buildId',
      'verificationId', 'attachmentId', 'captureId', 'handoffId', 'commentId',
      'occurrenceId', 'commitSha', 'attachmentCount', 'fromVersion', 'toVersion',
      'actorId', 'atomicWithDelivery', 'atomicWithLink',
      'authorizedNoBuildExemptionAtDelivery', 'buildRequirementId', 'committed',
      'decisionBasis', 'decisionReason', 'deliveredCommitSha', 'deliveryRequestDigest',
      'evidenceDecision', 'evidenceType', 'linkId', 'manifestVerifiedAtLink',
      'noCodeDecisionValidatedAtDelivery', 'overrideReason', 'policyVersion',
      'releaseManagerAuthorizedAtLink', 'requirement',
      'serverPolicyEvaluatedAtDelivery', 'sourceDeliveryVersion'
    )
    OR type IN ('array', 'object', 'blob')
  )
BEGIN
  SELECT RAISE(ABORT, 'event payload violates bounded redacted audit policy');
END;

CREATE TRIGGER events_external_principal_authority
BEFORE INSERT ON events
WHEN new.source IN ('relay', 'build') AND (
  NOT EXISTS (
    SELECT 1
    FROM service_principals AS principal
    JOIN accounts AS account ON account.id = principal.account_id
    WHERE principal.account_id = new.account_id
      AND principal.id = new.actor_service_principal_id
      AND principal.status = 'active'
      AND account.status = 'active'
      AND (
        (new.source = 'relay' AND principal.principal_type = 'relay')
        OR (new.source = 'build' AND principal.principal_type = 'build_provider')
      )
  )
  OR (
    new.source = 'relay'
    AND NOT EXISTS (
      SELECT 1 FROM repair_attempts AS attempt
      WHERE attempt.account_id = new.account_id
        AND attempt.project_id = new.project_id
        AND attempt.id = new.aggregate_id
        AND attempt.id = new.resource_id
        AND attempt.bug_id = new.bug_id
        AND new.aggregate_type = 'repair_attempt'
        AND new.resource_type = 'repair_attempt'
    )
  )
  OR (
    new.source = 'build'
    AND NOT EXISTS (
      SELECT 1 FROM builds AS build
      WHERE build.account_id = new.account_id
        AND build.project_id = new.project_id
        AND build.id = new.aggregate_id
        AND build.id = new.resource_id
        AND new.aggregate_type = 'build'
        AND new.resource_type = 'build'
        AND new.bug_id IS NULL
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'external event source requires its exact active principal and typed resource');
END;

CREATE TRIGGER integration_links_transition_guard
BEFORE UPDATE ON integration_links
WHEN NOT (
  old.state = 'active'
  AND new.state IN ('superseded', 'disabled')
  AND new.id IS old.id
  AND new.account_id IS old.account_id
  AND new.project_id IS old.project_id
  AND new.integration_type IS old.integration_type
  AND new.local_resource_type IS old.local_resource_type
  AND new.local_resource_id IS old.local_resource_id
  AND new.external_resource_type IS old.external_resource_type
  AND new.external_resource_id IS old.external_resource_id
  AND new.metadata_json IS old.metadata_json
  AND new.created_at IS old.created_at
  AND new.updated_at > old.updated_at
  AND new.version = old.version + 1
)
BEGIN
  SELECT RAISE(ABORT, 'integration link tuple is immutable and lifecycle is one-way');
END;

CREATE TRIGGER integration_links_no_delete
BEFORE DELETE ON integration_links
BEGIN
  SELECT RAISE(ABORT, 'integration link history is append-only');
END;

CREATE TRIGGER relay_receipts_exact_handoff_update
BEFORE UPDATE ON relay_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM repair_attempts AS attempt
  JOIN integration_links AS integration
    ON integration.account_id = attempt.account_id
   AND integration.project_id = attempt.project_id
   AND integration.id = new.integration_link_id
  WHERE attempt.account_id = new.account_id
    AND attempt.project_id = new.project_id
    AND attempt.id = new.repair_attempt_id
    AND attempt.bug_id = new.bug_id
    AND attempt.mode = 'relay'
    AND integration.integration_type = 'relay'
    AND integration.local_resource_type = 'repair_attempt'
    AND integration.local_resource_id = new.repair_attempt_id
    AND integration.external_resource_type = 'relay_handoff'
    AND integration.external_resource_id = new.handoff_id
    AND integration.state = 'active'
    AND json_extract(integration.metadata_json, '$.relayInstanceId') = new.relay_instance_id
)
BEGIN
  SELECT RAISE(ABORT, 'Relay receipt revision lost its exact active handoff tuple');
END;

CREATE TRIGGER relay_receipts_build_authority_insert
BEFORE INSERT ON relay_receipts
WHEN new.handoff_status = 'awaiting_verification' AND NOT EXISTS (
  SELECT 1 FROM build_requirements AS requirement
  WHERE requirement.account_id = new.account_id
    AND requirement.project_id = new.project_id
    AND requirement.bug_id = new.bug_id
    AND requirement.repair_attempt_id = new.repair_attempt_id
    AND (
      (new.build_requirement = 'not_required'
        AND requirement.requirement = 'not_required'
        AND requirement.version = 1
        AND new.build_evidence_status = 'not_required'
        AND new.build_id IS NULL)
      OR (new.build_requirement = 'required'
        AND requirement.requirement = 'required'
        AND requirement.version = 2
        AND requirement.delivered_commit_sha = new.delivered_commit_sha
        AND requirement.linked_build_id = new.build_id
        AND new.build_evidence_status = 'exact_commit_eligible'
        AND EXISTS (
          SELECT 1 FROM build_repair_links AS link
          WHERE link.account_id = requirement.account_id
            AND link.project_id = requirement.project_id
            AND link.id = requirement.link_id
            AND link.build_id = new.build_id
            AND link.delivered_commit_sha = new.delivered_commit_sha
        ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Relay awaiting-verification projection requires exact QA Hub Build authority');
END;

CREATE TRIGGER relay_receipts_build_authority_update
BEFORE UPDATE ON relay_receipts
WHEN new.handoff_status = 'awaiting_verification' AND NOT EXISTS (
  SELECT 1 FROM build_requirements AS requirement
  WHERE requirement.account_id = new.account_id
    AND requirement.project_id = new.project_id
    AND requirement.bug_id = new.bug_id
    AND requirement.repair_attempt_id = new.repair_attempt_id
    AND (
      (new.build_requirement = 'not_required'
        AND requirement.requirement = 'not_required'
        AND requirement.version = 1
        AND new.build_evidence_status = 'not_required'
        AND new.build_id IS NULL)
      OR (new.build_requirement = 'required'
        AND requirement.requirement = 'required'
        AND requirement.version = 2
        AND requirement.delivered_commit_sha = new.delivered_commit_sha
        AND requirement.linked_build_id = new.build_id
        AND new.build_evidence_status = 'exact_commit_eligible'
        AND EXISTS (
          SELECT 1 FROM build_repair_links AS link
          WHERE link.account_id = requirement.account_id
            AND link.project_id = requirement.project_id
            AND link.id = requirement.link_id
            AND link.build_id = new.build_id
            AND link.delivered_commit_sha = new.delivered_commit_sha
        ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Relay awaiting-verification projection requires exact QA Hub Build authority');
END;

CREATE TRIGGER relay_receipts_no_delete
BEFORE DELETE ON relay_receipts
BEGIN
  SELECT RAISE(ABORT, 'Relay receipt history is append-only');
END;

CREATE INDEX bugs_list_state_idx
  ON bugs(account_id, project_id, state, updated_at DESC, id);
CREATE INDEX bugs_owner_idx
  ON bugs(account_id, project_id, owner_id, state, updated_at DESC);
CREATE INDEX bugs_verification_owner_idx
  ON bugs(account_id, project_id, verification_owner_id, state, updated_at DESC);
CREATE INDEX bugs_module_idx
  ON bugs(account_id, project_id, module_id, state, updated_at DESC);
CREATE INDEX bugs_severity_priority_idx
  ON bugs(account_id, project_id, severity, priority, updated_at DESC);
CREATE INDEX occurrences_bug_idx
  ON occurrences(account_id, project_id, bug_id, observed_at DESC, id);
CREATE INDEX comments_bug_idx
  ON comments(account_id, project_id, bug_id, created_at, id);
CREATE INDEX repair_attempts_bug_idx
  ON repair_attempts(account_id, project_id, bug_id, sequence DESC);
CREATE UNIQUE INDEX repair_attempts_one_active_idx
  ON repair_attempts(account_id, project_id, bug_id)
  WHERE status IN ('planned', 'queued', 'running', 'needs_input', 'blocked', 'delivered');
CREATE INDEX repair_attempts_assignee_idx
  ON repair_attempts(account_id, project_id, assignee_id, status, updated_at DESC);
CREATE INDEX builds_commit_idx
  ON builds(account_id, project_id, source_commit_sha, status, updated_at DESC);
CREATE INDEX builds_status_idx
  ON builds(account_id, project_id, status, updated_at DESC, id);
CREATE INDEX build_requirements_state_idx
  ON build_requirements(account_id, project_id, requirement, version, updated_at DESC);
CREATE INDEX build_repair_links_build_idx
  ON build_repair_links(account_id, project_id, build_id, linked_at DESC);
CREATE UNIQUE INDEX verifications_one_active_idx
  ON verifications(account_id, project_id, bug_id)
  WHERE status IN ('requested', 'in_progress');
CREATE INDEX verifications_bug_idx
  ON verifications(account_id, project_id, bug_id, updated_at DESC);
CREATE INDEX upload_sessions_status_idx
  ON upload_sessions(account_id, project_id, status, expires_at);
CREATE INDEX upload_sessions_client_idx
  ON upload_sessions(account_id, project_id, actor_id, client_submission_id, client_attachment_id, generation);
CREATE INDEX attachments_state_idx
  ON attachments(account_id, project_id, status, scan_state, created_at DESC);
CREATE INDEX attachment_bindings_target_idx
  ON attachment_bindings(account_id, project_id, target_bug_id, intent, state, bound_at);
CREATE INDEX capture_bundles_status_idx
  ON capture_bundles(account_id, project_id, actor_id, status, created_at DESC);
CREATE INDEX capture_artifacts_bundle_idx
  ON capture_artifacts(account_id, project_id, capture_bundle_id, status, artifact_type);
CREATE INDEX capture_poco_methods_status_idx
  ON capture_poco_methods(account_id, project_id, capture_bundle_id, status, method);
CREATE INDEX poco_snapshots_capture_idx
  ON poco_snapshots(account_id, project_id, capture_id, created_at DESC);
CREATE INDEX events_aggregate_idx
  ON events(account_id, aggregate_type, aggregate_id, aggregate_sequence, event_position);
CREATE INDEX events_bug_idx
  ON events(account_id, project_id, bug_id, event_position);
CREATE INDEX outbox_delivery_idx
  ON outbox(status, next_attempt_at, lease_expires_at, account_id, id);
CREATE INDEX outbox_aggregate_order_idx
  ON outbox(account_id, aggregate_type, aggregate_id, aggregate_version, id);
CREATE INDEX inbox_aggregate_idx
  ON inbox(account_id, source, aggregate_id, aggregate_sequence);
CREATE INDEX notifications_unread_idx
  ON notifications(account_id, user_id, read_at, created_at DESC, id);
CREATE INDEX native_sessions_user_idx
  ON native_sessions(account_id, user_id, revoked_at, idle_expires_at, absolute_expires_at);
CREATE INDEX refresh_token_families_session_idx
  ON refresh_token_families(account_id, session_id, status);
CREATE INDEX refresh_tokens_expiry_idx
  ON refresh_tokens(account_id, family_id, status, expires_at);
CREATE UNIQUE INDEX refresh_tokens_one_active_idx
  ON refresh_tokens(account_id, family_id)
  WHERE status = 'active';
CREATE INDEX auth_secret_replays_expiry_idx
  ON auth_secret_replays(account_id, actor_id, action, expires_at);
CREATE INDEX idempotency_expiry_idx
  ON idempotency_records(status, expires_at);
CREATE INDEX notification_devices_user_idx
  ON notification_devices(account_id, user_id, status, updated_at DESC);
`;

const FTS_SCHEMA_SQL = String.raw`
CREATE VIRTUAL TABLE bugs_fts USING fts5(
  account_id UNINDEXED,
  project_id UNINDEXED,
  bug_id UNINDEXED,
  title,
  description,
  expected_behavior,
  tokenize = 'unicode61'
);

CREATE TRIGGER bugs_fts_insert
AFTER INSERT ON bugs
BEGIN
  INSERT INTO bugs_fts(rowid, account_id, project_id, bug_id, title, description, expected_behavior)
  VALUES (new.rowid, new.account_id, new.project_id, new.id, new.title, new.description, new.expected_behavior);
END;

CREATE TRIGGER bugs_fts_update
AFTER UPDATE ON bugs
BEGIN
  DELETE FROM bugs_fts WHERE rowid = old.rowid;
  INSERT INTO bugs_fts(rowid, account_id, project_id, bug_id, title, description, expected_behavior)
  VALUES (new.rowid, new.account_id, new.project_id, new.id, new.title, new.description, new.expected_behavior);
END;

CREATE TRIGGER bugs_fts_delete
AFTER DELETE ON bugs
BEGIN
  DELETE FROM bugs_fts WHERE rowid = old.rowid;
END;

INSERT INTO bugs_fts(rowid, account_id, project_id, bug_id, title, description, expected_behavior)
SELECT rowid, account_id, project_id, id, title, description, expected_behavior
FROM bugs;
`;

const DOMAIN_AUDIT_ALIGNMENT_SQL = String.raw`
ALTER TABLE repair_attempts
  ADD COLUMN failure_reason TEXT
  CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 5000);

DROP TRIGGER build_requirements_typed_decision_audit;
CREATE TRIGGER build_requirements_typed_decision_audit
BEFORE INSERT ON build_requirements
WHEN NOT EXISTS (
  SELECT 1
  FROM events AS event
  JOIN repair_attempts AS attempt
    ON attempt.account_id = new.account_id
   AND attempt.project_id = new.project_id
   AND attempt.bug_id = new.bug_id
   AND attempt.id = new.repair_attempt_id
  JOIN accounts AS account
    ON account.id = new.account_id
   AND account.status = 'active'
  JOIN projects AS project
    ON project.account_id = new.account_id
   AND project.id = new.project_id
   AND project.status = 'active'
  JOIN users AS actor
    ON actor.account_id = new.account_id
   AND actor.id = new.decision_actor_id
   AND actor.status = 'active'
  JOIN memberships AS membership
    ON membership.account_id = new.account_id
   AND membership.project_id = new.project_id
   AND membership.user_id = new.decision_actor_id
   AND membership.status = 'active'
  JOIN membership_roles AS role
    ON role.account_id = membership.account_id
   AND role.project_id = membership.project_id
   AND role.membership_id = membership.id
   AND role.role = 'developer'
  WHERE event.id = new.decision_audit_event_id
    AND event.account_id = new.account_id
    AND event.project_id = new.project_id
    AND event.bug_id = new.bug_id
    AND event.source = 'qa_hub'
    AND event.actor_type = 'user'
    AND event.actor_user_id = new.decision_actor_id
    AND event.type = 'repair_attempt.delivered'
    AND event.aggregate_type = 'repair_attempt'
    AND event.aggregate_id = new.repair_attempt_id
    AND event.resource_type = 'build_requirement'
    AND event.resource_id = new.id
    AND event.resource_version_after = 1
    AND event.request_digest = new.delivery_request_digest
    AND event.created_at = new.created_at
    AND attempt.status = 'delivered'
    AND attempt.version = new.source_delivery_version
    AND json_extract(event.payload_json, '$.repairAttemptId') = new.repair_attempt_id
    AND json_extract(event.payload_json, '$.status') = 'delivered'
    AND json_extract(event.payload_json, '$.commitSha') IS new.delivered_commit_sha
    AND (
      (new.decision_reason IS NULL AND json_extract(event.payload_json, '$.reason') IS NULL)
      OR (
        new.decision_reason IS NOT NULL
        AND json_type(event.payload_json, '$.reason') = 'text'
        AND (
          json_extract(event.payload_json, '$.reason') = new.decision_reason
          OR (
            length(CAST(json_extract(event.payload_json, '$.reason') AS BLOB)) <= 2000
            AND length(CAST(json_extract(event.payload_json, '$.reason') AS BLOB))
              < length(CAST(new.decision_reason AS BLOB))
            AND substr(json_extract(event.payload_json, '$.reason'), -1, 1) = '…'
            AND substr(
              new.decision_reason,
              1,
              length(json_extract(event.payload_json, '$.reason')) - 1
            ) = substr(
              json_extract(event.payload_json, '$.reason'),
              1,
              length(json_extract(event.payload_json, '$.reason')) - 1
            )
          )
          OR (
            json_extract(event.payload_json, '$.reason') = '[REDACTED]'
            AND (
              lower(new.decision_reason) GLOB '*authorization*[:=]*'
              OR lower(new.decision_reason) LIKE '%bearer %'
              OR lower(new.decision_reason) GLOB '*password*[:=]*'
              OR lower(new.decision_reason) GLOB '*passwd*[:=]*'
              OR lower(new.decision_reason) GLOB '*pwd*[:=]*'
              OR lower(new.decision_reason) GLOB '*secret*[:=]*'
              OR lower(new.decision_reason) GLOB '*token*[:=]*'
              OR lower(new.decision_reason) GLOB '*cookie*[:=]*'
              OR lower(new.decision_reason) GLOB '*credential*[:=]*'
              OR lower(new.decision_reason) GLOB '*apikey*[:=]*'
              OR lower(new.decision_reason) GLOB '*api_key*[:=]*'
              OR lower(new.decision_reason) GLOB '*api-key*[:=]*'
              OR lower(new.decision_reason) GLOB '*api key*[:=]*'
              OR lower(new.decision_reason) GLOB '*private*key*[:=]*'
              OR lower(new.decision_reason) GLOB '*://*:*@*'
              OR lower(new.decision_reason) GLOB '*eyj????????*.*.*'
              OR instr(new.decision_reason, char(92)) > 0
            )
          )
        )
      )
    )
    AND json_extract(event.payload_json, '$.fromVersion') = new.source_delivery_version - 1
    AND json_extract(event.payload_json, '$.toVersion') = new.source_delivery_version
    AND new.policy_version = '1.0.0'
    AND (
      (
        new.requirement = 'required'
        AND new.decision_basis = 'code_requires_build'
        AND new.decision_reason IS NULL
        AND new.delivered_commit_sha IS NOT NULL
        AND attempt.commit_sha = new.delivered_commit_sha
        AND attempt.branch IS NOT NULL
      )
      OR (
        new.requirement = 'not_required'
        AND new.decision_basis = 'no_code_delivery'
        AND new.decision_reason IS NOT NULL
        AND new.delivered_commit_sha IS NULL
        AND attempt.commit_sha IS NULL
        AND attempt.branch IS NULL
        AND attempt.no_code_reason = new.decision_reason
      )
      OR (
        new.requirement = 'not_required'
        AND new.decision_basis = 'authorized_no_build_exemption'
        AND new.decision_reason IS NOT NULL
        AND new.delivered_commit_sha IS NOT NULL
        AND attempt.commit_sha = new.delivered_commit_sha
        AND attempt.branch IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM membership_roles AS release_role
          WHERE release_role.account_id = membership.account_id
            AND release_role.project_id = membership.project_id
            AND release_role.membership_id = membership.id
            AND release_role.role = 'release_manager'
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'BuildRequirement requires its exact typed delivery audit');
END;

DROP TRIGGER build_repair_links_typed_evidence_audit;
CREATE TRIGGER build_repair_links_typed_evidence_audit
BEFORE INSERT ON build_repair_links
WHEN NOT EXISTS (
  SELECT 1
  FROM events AS event
  JOIN repair_attempts AS attempt
    ON attempt.account_id = new.account_id
   AND attempt.project_id = new.project_id
   AND attempt.bug_id = new.bug_id
   AND attempt.id = new.repair_attempt_id
  JOIN build_requirements AS requirement
    ON requirement.account_id = new.account_id
   AND requirement.project_id = new.project_id
   AND requirement.bug_id = new.bug_id
   AND requirement.repair_attempt_id = new.repair_attempt_id
   AND requirement.id = new.build_requirement_id
  JOIN builds AS build
    ON build.account_id = new.account_id
   AND build.project_id = new.project_id
   AND build.id = new.build_id
  JOIN accounts AS account
    ON account.id = new.account_id
   AND account.status = 'active'
  JOIN projects AS project
    ON project.account_id = new.account_id
   AND project.id = new.project_id
   AND project.status = 'active'
  JOIN users AS actor
    ON actor.account_id = new.account_id
   AND actor.id = new.evidence_actor_id
   AND actor.status = 'active'
  JOIN memberships AS membership
    ON membership.account_id = new.account_id
   AND membership.project_id = new.project_id
   AND membership.user_id = new.evidence_actor_id
   AND membership.status = 'active'
  JOIN membership_roles AS role
    ON role.account_id = membership.account_id
   AND role.project_id = membership.project_id
   AND role.membership_id = membership.id
   AND role.role = 'release_manager'
  WHERE event.id = new.evidence_audit_event_id
    AND event.account_id = new.account_id
    AND event.project_id = new.project_id
    AND event.bug_id = new.bug_id
    AND event.source = 'qa_hub'
    AND event.actor_type = 'user'
    AND event.actor_user_id = new.evidence_actor_id
    AND event.type = 'build.repair_linked'
    AND event.aggregate_type = 'repair_attempt'
    AND event.aggregate_id = new.repair_attempt_id
    AND event.resource_type = 'build_repair_link'
    AND event.resource_id = new.id
    AND event.resource_version_after = new.version
    AND event.request_digest IS NOT NULL
    AND event.created_at = new.linked_at
    AND json_extract(event.payload_json, '$.repairAttemptId') = new.repair_attempt_id
    AND json_extract(event.payload_json, '$.buildId') = new.build_id
    AND json_extract(event.payload_json, '$.status') = 'ready_for_verification'
    AND json_extract(event.payload_json, '$.commitSha') = new.delivered_commit_sha
    AND (
      (new.override_reason IS NULL AND json_extract(event.payload_json, '$.reason') IS NULL)
      OR (
        new.override_reason IS NOT NULL
        AND json_type(event.payload_json, '$.reason') = 'text'
        AND (
          json_extract(event.payload_json, '$.reason') = new.override_reason
          OR (
            length(CAST(json_extract(event.payload_json, '$.reason') AS BLOB)) <= 2000
            AND length(CAST(json_extract(event.payload_json, '$.reason') AS BLOB))
              < length(CAST(new.override_reason AS BLOB))
            AND substr(json_extract(event.payload_json, '$.reason'), -1, 1) = '…'
            AND substr(
              new.override_reason,
              1,
              length(json_extract(event.payload_json, '$.reason')) - 1
            ) = substr(
              json_extract(event.payload_json, '$.reason'),
              1,
              length(json_extract(event.payload_json, '$.reason')) - 1
            )
          )
          OR (
            json_extract(event.payload_json, '$.reason') = '[REDACTED]'
            AND (
              lower(new.override_reason) GLOB '*authorization*[:=]*'
              OR lower(new.override_reason) LIKE '%bearer %'
              OR lower(new.override_reason) GLOB '*password*[:=]*'
              OR lower(new.override_reason) GLOB '*passwd*[:=]*'
              OR lower(new.override_reason) GLOB '*pwd*[:=]*'
              OR lower(new.override_reason) GLOB '*secret*[:=]*'
              OR lower(new.override_reason) GLOB '*token*[:=]*'
              OR lower(new.override_reason) GLOB '*cookie*[:=]*'
              OR lower(new.override_reason) GLOB '*credential*[:=]*'
              OR lower(new.override_reason) GLOB '*apikey*[:=]*'
              OR lower(new.override_reason) GLOB '*api_key*[:=]*'
              OR lower(new.override_reason) GLOB '*api-key*[:=]*'
              OR lower(new.override_reason) GLOB '*api key*[:=]*'
              OR lower(new.override_reason) GLOB '*private*key*[:=]*'
              OR lower(new.override_reason) GLOB '*://*:*@*'
              OR lower(new.override_reason) GLOB '*eyj????????*.*.*'
              OR instr(new.override_reason, char(92)) > 0
            )
          )
        )
      )
    )
    AND json_extract(event.payload_json, '$.fromVersion') = build.version
    AND json_extract(event.payload_json, '$.toVersion') = build.version + 1
    AND new.evidence_policy_version = '1.0.0'
    AND requirement.version = new.build_requirement_version
    AND requirement.requirement = 'required'
    AND requirement.decision_basis = 'code_requires_build'
    AND requirement.linked_build_id = new.build_id
    AND requirement.link_id = new.id
    AND requirement.delivered_commit_sha = new.delivered_commit_sha
    AND attempt.status = 'delivered'
    AND attempt.commit_sha = new.delivered_commit_sha
    AND build.status = 'ready'
    AND (
      (
        new.evidence_type = 'manifest'
        AND new.evidence_decision = 'manifest_verified'
        AND new.override_reason IS NULL
        AND EXISTS (
          SELECT 1
          FROM build_manifest_commits AS manifest_commit
          WHERE manifest_commit.account_id = new.account_id
            AND manifest_commit.project_id = new.project_id
            AND manifest_commit.build_id = new.build_id
            AND manifest_commit.commit_sha = new.delivered_commit_sha
        )
      )
      OR (
        new.evidence_type = 'release_manager_override'
        AND new.evidence_decision = 'release_manager_authorized'
        AND new.override_reason IS NOT NULL
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'build repair link requires its exact typed evidence audit');
END;

DROP INDEX repair_attempts_one_active_idx;
CREATE UNIQUE INDEX repair_attempts_one_active_idx
  ON repair_attempts(account_id, project_id, bug_id)
  WHERE status IN ('planned', 'queued', 'running', 'needs_input', 'blocked');

CREATE TRIGGER repair_attempts_initial_typed_guard
BEFORE INSERT ON repair_attempts
WHEN NOT (
  new.status = 'planned'
  AND new.version = 1
  AND new.created_at = new.updated_at
  AND new.branch IS NULL
  AND new.commit_sha IS NULL
  AND new.merge_request_url IS NULL
  AND new.patch_url IS NULL
  AND new.no_code_reason IS NULL
  AND new.target_build_id IS NULL
  AND new.failure_reason IS NULL
  AND new.sequence = COALESCE((
    SELECT max(candidate.sequence) + 1
    FROM repair_attempts AS candidate
    WHERE candidate.account_id = new.account_id
      AND candidate.project_id = new.project_id
      AND candidate.bug_id = new.bug_id
  ), 1)
  AND EXISTS (
    SELECT 1
    FROM users AS assignee_user
    JOIN accounts AS assignee_account
      ON assignee_account.id = assignee_user.account_id
     AND assignee_account.status = 'active'
    JOIN projects AS assignee_project
      ON assignee_project.account_id = assignee_user.account_id
     AND assignee_project.id = new.project_id
     AND assignee_project.status = 'active'
    JOIN memberships AS assignee_membership
      ON assignee_membership.account_id = assignee_user.account_id
     AND assignee_membership.project_id = new.project_id
     AND assignee_membership.user_id = assignee_user.id
     AND assignee_membership.status = 'active'
    JOIN membership_roles AS assignee_role
      ON assignee_role.account_id = assignee_membership.account_id
     AND assignee_role.project_id = assignee_membership.project_id
     AND assignee_role.membership_id = assignee_membership.id
     AND assignee_role.role = 'developer'
    WHERE assignee_user.account_id = new.account_id
      AND assignee_user.id = new.assignee_id
      AND assignee_user.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM events AS event
    JOIN users AS actor_user
      ON actor_user.account_id = event.account_id
     AND actor_user.id = event.actor_user_id
     AND actor_user.status = 'active'
    JOIN accounts AS actor_account
      ON actor_account.id = event.account_id
     AND actor_account.status = 'active'
    JOIN projects AS actor_project
      ON actor_project.account_id = event.account_id
     AND actor_project.id = event.project_id
     AND actor_project.status = 'active'
    JOIN memberships AS membership
      ON membership.account_id = event.account_id
     AND membership.project_id = event.project_id
     AND membership.user_id = event.actor_user_id
     AND membership.status = 'active'
    JOIN membership_roles AS role
      ON role.account_id = membership.account_id
     AND role.project_id = membership.project_id
     AND role.membership_id = membership.id
    WHERE event.account_id = new.account_id
      AND event.project_id = new.project_id
      AND event.bug_id = new.bug_id
      AND event.source = 'qa_hub'
      AND event.actor_type = 'user'
      AND event.request_digest IS NOT NULL
      AND event.created_at = new.created_at
      AND (
        (
          event.type = 'repair_attempt.created'
          AND role.role IN ('developer', 'triager')
          AND event.aggregate_type = 'repair_attempt'
          AND event.aggregate_id = new.id
          AND event.resource_type = 'repair_attempt'
          AND event.resource_id = new.id
          AND event.resource_version_after = 1
          AND event.from_state = 'ready'
          AND event.to_state = 'in_progress'
          AND json_extract(event.payload_json, '$.status') = 'planned'
          AND json_extract(event.payload_json, '$.repairAttemptId') = new.id
        )
        OR (
          new.parent_attempt_id IS NOT NULL
          AND role.role = 'developer'
          AND event.type = 'repair_attempt.superseded'
          AND event.aggregate_type = 'repair_attempt'
          AND event.aggregate_id = new.parent_attempt_id
          AND event.resource_type = 'repair_attempt'
          AND event.resource_id = new.parent_attempt_id
          AND event.from_state IS NULL
          AND event.to_state IS NULL
          AND json_extract(event.payload_json, '$.status') = 'superseded'
          AND json_extract(event.payload_json, '$.repairAttemptId') = new.parent_attempt_id
          AND json_type(event.payload_json, '$.reason') = 'text'
          AND length(trim(json_extract(event.payload_json, '$.reason'))) > 0
          AND EXISTS (
            SELECT 1 FROM repair_attempts AS parent
            WHERE parent.account_id = new.account_id
              AND parent.project_id = new.project_id
              AND parent.bug_id = new.bug_id
              AND parent.id = new.parent_attempt_id
              AND parent.status = 'superseded'
              AND parent.version = event.resource_version_after
              AND parent.updated_at = new.created_at
              AND json_extract(event.payload_json, '$.fromVersion') = parent.version - 1
              AND json_extract(event.payload_json, '$.toVersion') = parent.version
          )
        )
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'RepairAttempt must begin as one neutral planned version-one fact with its exact typed audit Event');
END;

CREATE TRIGGER repair_attempts_active_after_delivered_insert
BEFORE INSERT ON repair_attempts
WHEN new.status IN ('planned', 'queued', 'running', 'needs_input', 'blocked')
  AND EXISTS (
    SELECT 1
    FROM bugs AS bug
    JOIN repair_attempts AS pointed
      ON pointed.account_id = bug.account_id
     AND pointed.project_id = bug.project_id
     AND pointed.bug_id = bug.id
     AND pointed.id = bug.active_repair_attempt_id
    WHERE bug.account_id = new.account_id
      AND bug.project_id = new.project_id
      AND bug.id = new.bug_id
      AND pointed.status = 'delivered'
  )
BEGIN
  SELECT RAISE(ABORT, 'new planned RepairAttempt requires the Bug active delivered pointer to be cleared');
END;

CREATE TRIGGER repair_attempts_active_after_delivered_update
BEFORE UPDATE OF status ON repair_attempts
WHEN new.status IN ('planned', 'queued', 'running', 'needs_input', 'blocked')
  AND old.status NOT IN ('planned', 'queued', 'running', 'needs_input', 'blocked')
  AND EXISTS (
    SELECT 1
    FROM bugs AS bug
    JOIN repair_attempts AS pointed
      ON pointed.account_id = bug.account_id
     AND pointed.project_id = bug.project_id
     AND pointed.bug_id = bug.id
     AND pointed.id = bug.active_repair_attempt_id
    WHERE bug.account_id = new.account_id
      AND bug.project_id = new.project_id
      AND bug.id = new.bug_id
      AND pointed.status = 'delivered'
  )
BEGIN
  SELECT RAISE(ABORT, 'new planned RepairAttempt requires the Bug active delivered pointer to be cleared');
END;

CREATE TRIGGER repair_attempts_parent_insert_guard
BEFORE INSERT ON repair_attempts
WHEN (
  new.parent_attempt_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM repair_attempts AS parent
    WHERE parent.account_id = new.account_id
      AND parent.project_id = new.project_id
      AND parent.bug_id = new.bug_id
      AND parent.id = new.parent_attempt_id
      AND parent.sequence < new.sequence
      AND parent.sequence = (
        SELECT max(latest.sequence)
        FROM repair_attempts AS latest
        WHERE latest.account_id = new.account_id
          AND latest.project_id = new.project_id
          AND latest.bug_id = new.bug_id
      )
      AND parent.status IN ('delivered', 'failed', 'verification_failed', 'cancelled', 'superseded')
      AND NOT EXISTS (
        SELECT 1 FROM repair_attempts AS child
        WHERE child.account_id = parent.account_id
          AND child.project_id = parent.project_id
          AND child.bug_id = parent.bug_id
          AND child.parent_attempt_id = parent.id
      )
  )
)
OR (
  new.parent_attempt_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM repair_attempts AS latest
    WHERE latest.account_id = new.account_id
      AND latest.project_id = new.project_id
      AND latest.bug_id = new.bug_id
      AND latest.status = 'superseded'
      AND latest.sequence = (
        SELECT max(candidate.sequence)
        FROM repair_attempts AS candidate
        WHERE candidate.account_id = new.account_id
          AND candidate.project_id = new.project_id
          AND candidate.bug_id = new.bug_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM repair_attempts AS child
        WHERE child.account_id = latest.account_id
          AND child.project_id = latest.project_id
          AND child.bug_id = latest.bug_id
          AND child.parent_attempt_id = latest.id
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'RepairAttempt parent must be the latest eligible history leaf; legacy supersede requires its exact child');
END;

CREATE TRIGGER bugs_duplicate_identity_insert_guard
BEFORE INSERT ON bugs
WHEN (new.state = 'duplicate') <> (new.duplicate_of_bug_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'duplicate Bug state and canonical Bug identity must agree');
END;

CREATE TRIGGER bugs_duplicate_identity_update_guard
BEFORE UPDATE OF state, duplicate_of_bug_id ON bugs
WHEN (new.state = 'duplicate') <> (new.duplicate_of_bug_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'duplicate Bug state and canonical Bug identity must agree');
END;

CREATE TRIGGER bugs_duplicate_no_cycle_guard
BEFORE UPDATE OF duplicate_of_bug_id ON bugs
WHEN new.duplicate_of_bug_id IS NOT NULL AND EXISTS (
  WITH RECURSIVE canonical_chain(id, duplicate_of_bug_id) AS (
    SELECT candidate.id, candidate.duplicate_of_bug_id
    FROM bugs AS candidate
    WHERE candidate.account_id = new.account_id
      AND candidate.project_id = new.project_id
      AND candidate.id = new.duplicate_of_bug_id
    UNION ALL
    SELECT candidate.id, candidate.duplicate_of_bug_id
    FROM bugs AS candidate
    JOIN canonical_chain AS prior
      ON candidate.account_id = new.account_id
     AND candidate.project_id = new.project_id
     AND candidate.id = prior.duplicate_of_bug_id
    WHERE prior.duplicate_of_bug_id IS NOT NULL
  )
  SELECT 1 FROM canonical_chain WHERE id = new.id
)
BEGIN
  SELECT RAISE(ABORT, 'duplicate Bug canonical chain must remain acyclic');
END;

CREATE TRIGGER bugs_initial_workflow_guard
BEFORE INSERT ON bugs
WHEN new.state <> 'reported'
  OR new.version <> 1
  OR new.active_repair_attempt_id IS NOT NULL
  OR new.active_verification_id IS NOT NULL
  OR new.duplicate_of_bug_id IS NOT NULL
  OR new.closed_at IS NOT NULL
  OR new.reopen_count <> 0
BEGIN
  SELECT RAISE(ABORT, 'Bug workflow must begin as one reported version-one fact');
END;

CREATE TRIGGER bugs_typed_state_transition_guard
BEFORE UPDATE OF state ON bugs
WHEN new.state <> old.state AND NOT (
  new.version = old.version + 1
  AND new.updated_at > old.updated_at
  AND new.title IS old.title
  AND new.description IS old.description
  AND new.expected_behavior IS old.expected_behavior
  AND new.module_id IS old.module_id
  AND new.severity IS old.severity
  AND new.priority IS old.priority
  AND new.owner_id IS old.owner_id
  AND new.verification_owner_id IS old.verification_owner_id
  AND new.occurrence_count = old.occurrence_count
  AND EXISTS (
    SELECT 1
    FROM events AS event
    JOIN memberships AS membership
      ON membership.account_id = event.account_id
     AND membership.project_id = event.project_id
     AND membership.user_id = event.actor_user_id
     AND membership.status = 'active'
    JOIN users AS actor_user
      ON actor_user.account_id = event.account_id
     AND actor_user.id = event.actor_user_id
     AND actor_user.status = 'active'
    JOIN accounts AS actor_account
      ON actor_account.id = event.account_id
     AND actor_account.status = 'active'
    JOIN projects AS actor_project
      ON actor_project.account_id = event.account_id
     AND actor_project.id = event.project_id
     AND actor_project.status = 'active'
    JOIN membership_roles AS role
      ON role.account_id = membership.account_id
     AND role.project_id = membership.project_id
     AND role.membership_id = membership.id
    WHERE event.account_id = old.account_id
      AND event.project_id = old.project_id
      AND event.bug_id = old.id
      AND event.source = 'qa_hub'
      AND event.actor_type = 'user'
      AND event.request_digest IS NOT NULL
      AND event.from_state = old.state
      AND event.to_state = new.state
      AND event.created_at = new.updated_at
      AND (
        (
          (
            (old.state IN ('reported', 'needs_info') AND new.state = 'ready' AND event.type = 'bug.triage.ready')
            OR (old.state IN ('reported', 'ready') AND new.state = 'needs_info' AND event.type = 'bug.triage.needs_info')
            OR (old.state IN ('reported', 'needs_info', 'ready') AND new.state = 'deferred' AND event.type = 'bug.defer')
            OR (old.state IN ('reported', 'needs_info', 'ready') AND new.state = 'rejected' AND event.type = 'bug.reject')
          )
          AND role.role = 'triager'
          AND event.aggregate_type = 'bug'
          AND event.aggregate_id = old.id
          AND event.resource_type = 'bug'
          AND event.resource_id = old.id
          AND event.resource_version_after = new.version
          AND json_extract(event.payload_json, '$.status') = new.state
          AND json_extract(event.payload_json, '$.fromVersion') = old.version
          AND json_extract(event.payload_json, '$.toVersion') = new.version
          AND (event.type = 'bug.triage.ready' OR (
            json_type(event.payload_json, '$.reason') = 'text'
            AND length(json_extract(event.payload_json, '$.reason')) > 0
          ))
          AND new.active_repair_attempt_id IS old.active_repair_attempt_id
          AND new.active_verification_id IS old.active_verification_id
          AND new.duplicate_of_bug_id IS old.duplicate_of_bug_id
          AND new.closed_at IS old.closed_at
          AND new.reopen_count = old.reopen_count
        )
        OR (
          old.state IN ('reported', 'ready')
          AND new.state = 'duplicate'
          AND role.role = 'triager'
          AND event.type = 'bug.mark_duplicate'
          AND event.aggregate_type = 'bug'
          AND event.aggregate_id = old.id
          AND event.resource_type = 'bug'
          AND event.resource_id = old.id
          AND event.resource_version_after = new.version
          AND json_extract(event.payload_json, '$.status') = 'duplicate'
          AND json_extract(event.payload_json, '$.relatedBugId') = new.duplicate_of_bug_id
          AND json_type(event.payload_json, '$.reason') = 'text'
          AND length(json_extract(event.payload_json, '$.reason')) > 0
          AND json_extract(event.payload_json, '$.fromVersion') = old.version
          AND json_extract(event.payload_json, '$.toVersion') = new.version
          AND old.duplicate_of_bug_id IS NULL
          AND new.duplicate_of_bug_id IS NOT NULL
          AND new.active_repair_attempt_id IS old.active_repair_attempt_id
          AND new.active_verification_id IS old.active_verification_id
          AND new.closed_at IS old.closed_at
          AND new.reopen_count = old.reopen_count
        )
        OR (
          old.state = 'ready'
          AND new.state = 'in_progress'
          AND role.role IN ('developer', 'triager')
          AND event.type = 'repair_attempt.created'
          AND event.aggregate_type = 'repair_attempt'
          AND event.aggregate_id = new.active_repair_attempt_id
          AND event.resource_type = 'repair_attempt'
          AND event.resource_id = new.active_repair_attempt_id
          AND event.resource_version_after = 1
          AND json_extract(event.payload_json, '$.status') = 'planned'
          AND json_extract(event.payload_json, '$.repairAttemptId') = new.active_repair_attempt_id
          AND json_extract(event.payload_json, '$.fromVersion') = old.version
          AND json_extract(event.payload_json, '$.toVersion') = new.version
          AND old.active_repair_attempt_id IS NULL
          AND new.active_repair_attempt_id IS NOT NULL
          AND new.active_verification_id IS old.active_verification_id
          AND new.duplicate_of_bug_id IS old.duplicate_of_bug_id
          AND new.closed_at IS old.closed_at
          AND new.reopen_count = old.reopen_count
          AND EXISTS (
            SELECT 1
            FROM repair_attempts AS attempt
            JOIN memberships AS assignee_membership
              ON assignee_membership.account_id = attempt.account_id
             AND assignee_membership.project_id = attempt.project_id
             AND assignee_membership.user_id = attempt.assignee_id
             AND assignee_membership.status = 'active'
            JOIN users AS assignee_user
              ON assignee_user.account_id = attempt.account_id
             AND assignee_user.id = attempt.assignee_id
             AND assignee_user.status = 'active'
            WHERE attempt.account_id = old.account_id
              AND attempt.project_id = old.project_id
              AND attempt.bug_id = old.id
              AND attempt.id = new.active_repair_attempt_id
              AND attempt.status = 'planned'
              AND attempt.version = 1
              AND attempt.created_at = new.updated_at
          )
        )
        OR (
          old.state = 'in_progress'
          AND new.state = 'ready'
          AND role.role = 'developer'
          AND event.type IN ('repair_attempt.failed', 'repair_attempt.superseded')
          AND event.aggregate_type = 'repair_attempt'
          AND event.aggregate_id = old.active_repair_attempt_id
          AND event.resource_type = 'repair_attempt'
          AND event.resource_id = old.active_repair_attempt_id
          AND json_extract(event.payload_json, '$.repairAttemptId') = old.active_repair_attempt_id
          AND json_extract(event.payload_json, '$.fromVersion') = event.resource_version_after - 1
          AND json_extract(event.payload_json, '$.toVersion') = event.resource_version_after
          AND json_type(event.payload_json, '$.reason') = 'text'
          AND length(trim(json_extract(event.payload_json, '$.reason'))) > 0
          AND old.active_repair_attempt_id IS NOT NULL
          AND new.active_repair_attempt_id IS NULL
          AND old.active_verification_id IS NULL
          AND new.active_verification_id IS NULL
          AND new.duplicate_of_bug_id IS old.duplicate_of_bug_id
          AND new.closed_at IS old.closed_at
          AND new.reopen_count = old.reopen_count
          AND EXISTS (
            SELECT 1 FROM repair_attempts AS attempt
            WHERE attempt.account_id = old.account_id
              AND attempt.project_id = old.project_id
              AND attempt.bug_id = old.id
              AND attempt.id = old.active_repair_attempt_id
              AND attempt.status = CASE event.type
                WHEN 'repair_attempt.failed' THEN 'failed'
                ELSE 'superseded'
              END
              AND attempt.version = event.resource_version_after
              AND attempt.updated_at = new.updated_at
              AND json_extract(event.payload_json, '$.status') = attempt.status
          )
        )
        OR (
          old.state = 'in_progress'
          AND new.state IN ('awaiting_build', 'ready_for_verification')
          AND role.role = 'developer'
          AND event.type = 'repair_attempt.delivered'
          AND event.aggregate_type = 'repair_attempt'
          AND event.aggregate_id = old.active_repair_attempt_id
          AND event.resource_type = 'build_requirement'
          AND event.resource_version_after = 1
          AND json_extract(event.payload_json, '$.status') = 'delivered'
          AND json_extract(event.payload_json, '$.repairAttemptId') = old.active_repair_attempt_id
          AND old.active_repair_attempt_id IS NOT NULL
          AND new.active_repair_attempt_id IS old.active_repair_attempt_id
          AND new.active_verification_id IS old.active_verification_id
          AND new.duplicate_of_bug_id IS old.duplicate_of_bug_id
          AND new.closed_at IS old.closed_at
          AND new.reopen_count = old.reopen_count
          AND EXISTS (
            SELECT 1
            FROM repair_attempts AS attempt
            JOIN build_requirements AS requirement
              ON requirement.account_id = attempt.account_id
             AND requirement.project_id = attempt.project_id
             AND requirement.bug_id = attempt.bug_id
             AND requirement.repair_attempt_id = attempt.id
             AND requirement.id = event.resource_id
            WHERE attempt.account_id = old.account_id
              AND attempt.project_id = old.project_id
              AND attempt.bug_id = old.id
              AND attempt.id = old.active_repair_attempt_id
              AND attempt.status = 'delivered'
              AND attempt.version = requirement.source_delivery_version
              AND attempt.updated_at = new.updated_at
              AND requirement.version = 1
              AND requirement.created_at = new.updated_at
              AND requirement.bug_version_at_delivery = new.version
              AND json_extract(event.payload_json, '$.commitSha') IS requirement.delivered_commit_sha
              AND json_extract(event.payload_json, '$.fromVersion') = attempt.version - 1
              AND json_extract(event.payload_json, '$.toVersion') = attempt.version
              AND new.state = CASE requirement.requirement
                WHEN 'required' THEN 'awaiting_build'
                ELSE 'ready_for_verification'
              END
          )
        )
        OR (
          old.state = 'awaiting_build'
          AND new.state = 'ready_for_verification'
          AND role.role = 'release_manager'
          AND event.type = 'build.repair_linked'
          AND event.aggregate_type = 'repair_attempt'
          AND event.aggregate_id = old.active_repair_attempt_id
          AND event.resource_type = 'build_repair_link'
          AND event.resource_version_after = 1
          AND json_extract(event.payload_json, '$.status') = 'ready_for_verification'
          AND json_extract(event.payload_json, '$.repairAttemptId') = old.active_repair_attempt_id
          AND old.active_repair_attempt_id IS NOT NULL
          AND new.active_repair_attempt_id IS old.active_repair_attempt_id
          AND new.active_verification_id IS old.active_verification_id
          AND new.duplicate_of_bug_id IS old.duplicate_of_bug_id
          AND new.closed_at IS old.closed_at
          AND new.reopen_count = old.reopen_count
          AND EXISTS (
            SELECT 1
            FROM build_repair_links AS link
            JOIN build_requirements AS requirement
              ON requirement.account_id = link.account_id
             AND requirement.project_id = link.project_id
             AND requirement.bug_id = link.bug_id
             AND requirement.repair_attempt_id = link.repair_attempt_id
             AND requirement.id = link.build_requirement_id
            JOIN builds AS build
              ON build.account_id = link.account_id
             AND build.project_id = link.project_id
             AND build.id = link.build_id
            WHERE link.account_id = old.account_id
              AND link.project_id = old.project_id
              AND link.bug_id = old.id
              AND link.repair_attempt_id = old.active_repair_attempt_id
              AND link.id = event.resource_id
              AND link.evidence_audit_event_id = event.id
              AND requirement.version = 2
              AND requirement.link_id = link.id
              AND requirement.linked_build_id = link.build_id
              AND build.status = 'ready'
              AND json_extract(event.payload_json, '$.buildId') = build.id
              AND json_extract(event.payload_json, '$.commitSha') = link.delivered_commit_sha
              AND json_extract(event.payload_json, '$.fromVersion') = build.version - 1
              AND json_extract(event.payload_json, '$.toVersion') = build.version
          )
        )
        OR (
          old.state = 'ready_for_verification'
          AND new.state = 'ready'
          AND role.role = 'verifier'
          AND event.type = 'verification.result_recorded'
          AND event.aggregate_type = 'verification'
          AND event.aggregate_id = old.active_verification_id
          AND event.resource_type = 'verification'
          AND event.resource_id = old.active_verification_id
          AND json_extract(event.payload_json, '$.status') = 'failed'
          AND old.active_repair_attempt_id IS NOT NULL
          AND old.active_verification_id IS NOT NULL
          AND new.active_repair_attempt_id IS NULL
          AND new.active_verification_id IS NULL
          AND new.duplicate_of_bug_id IS old.duplicate_of_bug_id
          AND new.closed_at IS old.closed_at
          AND new.reopen_count = old.reopen_count
          AND EXISTS (
            SELECT 1
            FROM verifications AS verification
            JOIN repair_attempts AS attempt
              ON attempt.account_id = verification.account_id
             AND attempt.project_id = verification.project_id
             AND attempt.bug_id = verification.bug_id
             AND attempt.id = verification.repair_attempt_id
            WHERE verification.account_id = old.account_id
              AND verification.project_id = old.project_id
              AND verification.bug_id = old.id
              AND verification.id = old.active_verification_id
              AND verification.status = 'failed'
              AND verification.verifier_id = event.actor_user_id
              AND verification.version = event.resource_version_after
              AND verification.updated_at = new.updated_at
              AND attempt.id = old.active_repair_attempt_id
              AND attempt.status = 'verification_failed'
              AND attempt.updated_at = new.updated_at
          )
        )
        OR (
          old.state = 'ready_for_verification'
          AND new.state = 'closed'
          AND role.role = 'verifier'
          AND event.type IN ('verification.result_recorded', 'bug.verification.passed')
          AND json_extract(event.payload_json, '$.status') = 'passed'
          AND old.active_repair_attempt_id IS NOT NULL
          AND old.active_verification_id IS NOT NULL
          AND new.active_repair_attempt_id IS NULL
          AND new.active_verification_id IS NULL
          AND new.duplicate_of_bug_id IS old.duplicate_of_bug_id
          AND new.closed_at = new.updated_at
          AND new.reopen_count = old.reopen_count
        )
        OR (
          old.state = 'closed'
          AND new.state = 'ready'
          AND role.role = 'triager'
          AND event.type = 'bug.reopen.newer_occurrence'
          AND event.aggregate_type = 'bug'
          AND event.aggregate_id = old.id
          AND event.resource_type = 'bug'
          AND event.resource_id = old.id
          AND event.resource_version_after = new.version
          AND json_extract(event.payload_json, '$.status') = 'ready'
          AND json_extract(event.payload_json, '$.fromVersion') = old.version
          AND json_extract(event.payload_json, '$.toVersion') = new.version
          AND old.active_repair_attempt_id IS new.active_repair_attempt_id
          AND old.active_verification_id IS new.active_verification_id
          AND new.duplicate_of_bug_id IS old.duplicate_of_bug_id
          AND new.closed_at IS NULL
          AND new.reopen_count = old.reopen_count + 1
        )
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Bug state transition requires its exact typed human audit and relation facts');
END;

CREATE TRIGGER bugs_typed_same_state_pointer_guard
BEFORE UPDATE OF active_repair_attempt_id, active_verification_id, duplicate_of_bug_id, closed_at, reopen_count ON bugs
WHEN new.state = old.state
  AND (
    new.active_repair_attempt_id IS NOT old.active_repair_attempt_id
    OR new.active_verification_id IS NOT old.active_verification_id
    OR new.duplicate_of_bug_id IS NOT old.duplicate_of_bug_id
    OR new.closed_at IS NOT old.closed_at
    OR new.reopen_count <> old.reopen_count
  )
  AND NOT (
    new.version = old.version + 1
    AND new.updated_at > old.updated_at
    AND new.title IS old.title
    AND new.description IS old.description
    AND new.expected_behavior IS old.expected_behavior
    AND new.module_id IS old.module_id
    AND new.severity IS old.severity
    AND new.priority IS old.priority
    AND new.owner_id IS old.owner_id
    AND new.verification_owner_id IS old.verification_owner_id
    AND new.occurrence_count = old.occurrence_count
    AND new.duplicate_of_bug_id IS old.duplicate_of_bug_id
    AND new.closed_at IS old.closed_at
    AND new.reopen_count = old.reopen_count
    AND EXISTS (
      SELECT 1
      FROM events AS event
      JOIN memberships AS membership
        ON membership.account_id = event.account_id
       AND membership.project_id = event.project_id
       AND membership.user_id = event.actor_user_id
       AND membership.status = 'active'
      JOIN membership_roles AS role
        ON role.account_id = membership.account_id
       AND role.project_id = membership.project_id
       AND role.membership_id = membership.id
      JOIN users AS actor_user
        ON actor_user.account_id = event.account_id
       AND actor_user.id = event.actor_user_id
       AND actor_user.status = 'active'
      JOIN accounts AS actor_account
        ON actor_account.id = event.account_id
       AND actor_account.status = 'active'
      JOIN projects AS actor_project
        ON actor_project.account_id = event.account_id
       AND actor_project.id = event.project_id
       AND actor_project.status = 'active'
      WHERE event.account_id = old.account_id
        AND event.project_id = old.project_id
        AND event.bug_id = old.id
        AND event.source = 'qa_hub'
        AND event.actor_type = 'user'
        AND event.request_digest IS NOT NULL
        AND event.created_at = new.updated_at
        AND (
          (
            old.state = 'in_progress'
            AND new.state = 'in_progress'
            AND old.active_repair_attempt_id IS NOT NULL
            AND new.active_repair_attempt_id IS NOT NULL
            AND new.active_repair_attempt_id <> old.active_repair_attempt_id
            AND old.active_verification_id IS NULL
            AND new.active_verification_id IS NULL
            AND role.role = 'developer'
            AND event.type = 'repair_attempt.superseded'
            AND event.aggregate_type = 'repair_attempt'
            AND event.aggregate_id = old.active_repair_attempt_id
            AND event.resource_type = 'repair_attempt'
            AND event.resource_id = old.active_repair_attempt_id
            AND event.from_state IS NULL
            AND event.to_state IS NULL
            AND json_extract(event.payload_json, '$.status') = 'superseded'
            AND json_extract(event.payload_json, '$.repairAttemptId') = old.active_repair_attempt_id
            AND json_type(event.payload_json, '$.reason') = 'text'
            AND length(trim(json_extract(event.payload_json, '$.reason'))) > 0
            AND json_extract(event.payload_json, '$.fromVersion') = event.resource_version_after - 1
            AND json_extract(event.payload_json, '$.toVersion') = event.resource_version_after
            AND EXISTS (
              SELECT 1
              FROM repair_attempts AS replaced
              JOIN repair_attempts AS successor
                ON successor.account_id = replaced.account_id
               AND successor.project_id = replaced.project_id
               AND successor.bug_id = replaced.bug_id
               AND successor.parent_attempt_id = replaced.id
               AND successor.id = new.active_repair_attempt_id
              JOIN memberships AS assignee_membership
                ON assignee_membership.account_id = successor.account_id
               AND assignee_membership.project_id = successor.project_id
               AND assignee_membership.user_id = successor.assignee_id
               AND assignee_membership.status = 'active'
              JOIN users AS assignee_user
                ON assignee_user.account_id = successor.account_id
               AND assignee_user.id = successor.assignee_id
               AND assignee_user.status = 'active'
              WHERE replaced.account_id = old.account_id
                AND replaced.project_id = old.project_id
                AND replaced.bug_id = old.id
                AND replaced.id = old.active_repair_attempt_id
                AND replaced.status = 'superseded'
                AND replaced.version = event.resource_version_after
                AND replaced.updated_at = new.updated_at
                AND successor.status = 'planned'
                AND successor.version = 1
                AND successor.created_at = new.updated_at
                AND successor.updated_at = successor.created_at
                AND successor.sequence = (
                  SELECT max(candidate.sequence)
                  FROM repair_attempts AS candidate
                  WHERE candidate.account_id = successor.account_id
                    AND candidate.project_id = successor.project_id
                    AND candidate.bug_id = successor.bug_id
                )
                AND successor.branch IS NULL
                AND successor.commit_sha IS NULL
                AND successor.merge_request_url IS NULL
                AND successor.patch_url IS NULL
                AND successor.no_code_reason IS NULL
                AND successor.target_build_id IS NULL
            )
          )
          OR (
            old.state = 'ready_for_verification'
            AND new.state = 'ready_for_verification'
            AND old.active_repair_attempt_id IS NOT NULL
            AND new.active_repair_attempt_id IS old.active_repair_attempt_id
            AND old.active_verification_id IS NULL
            AND new.active_verification_id IS NOT NULL
            AND role.role = 'verifier'
            AND event.type = 'verification.created'
            AND event.aggregate_type = 'verification'
            AND event.aggregate_id = new.active_verification_id
            AND event.resource_type = 'verification'
            AND event.resource_id = new.active_verification_id
            AND event.resource_version_after = 1
            AND event.from_state IS NULL
            AND event.to_state IS NULL
            AND json_extract(event.payload_json, '$.status') = 'requested'
            AND json_extract(event.payload_json, '$.verificationId') = new.active_verification_id
            AND json_extract(event.payload_json, '$.repairAttemptId') = old.active_repair_attempt_id
            AND json_extract(event.payload_json, '$.toVersion') = 1
            AND EXISTS (
              SELECT 1
              FROM verifications AS verification
              JOIN users AS assigned_verifier_user
                ON assigned_verifier_user.account_id = verification.account_id
               AND assigned_verifier_user.id = verification.verifier_id
               AND assigned_verifier_user.status = 'active'
              JOIN memberships AS assigned_membership
                ON assigned_membership.account_id = verification.account_id
               AND assigned_membership.project_id = verification.project_id
               AND assigned_membership.user_id = verification.verifier_id
               AND assigned_membership.status = 'active'
              JOIN membership_roles AS assigned_role
                ON assigned_role.account_id = assigned_membership.account_id
               AND assigned_role.project_id = assigned_membership.project_id
               AND assigned_role.membership_id = assigned_membership.id
               AND assigned_role.role = 'verifier'
              JOIN repair_attempts AS attempt
                ON attempt.account_id = verification.account_id
               AND attempt.project_id = verification.project_id
               AND attempt.bug_id = verification.bug_id
               AND attempt.id = verification.repair_attempt_id
              WHERE verification.account_id = old.account_id
                AND verification.project_id = old.project_id
                AND verification.bug_id = old.id
                AND verification.id = new.active_verification_id
                AND verification.repair_attempt_id = old.active_repair_attempt_id
                AND verification.status = 'requested'
                AND verification.version = 1
                AND verification.created_at = new.updated_at
                AND verification.updated_at = verification.created_at
                AND verification.result_summary IS NULL
                AND verification.failure_reason IS NULL
                AND verification.blocked_reason IS NULL
                AND json_extract(event.payload_json, '$.buildId') IS verification.build_id
                AND attempt.status = 'delivered'
                AND (old.severity NOT IN ('S0', 'S1') OR attempt.assignee_id <> verification.verifier_id)
            )
          )
          OR (
            old.state = 'ready_for_verification'
            AND new.state = 'ready_for_verification'
            AND old.active_repair_attempt_id IS NOT NULL
            AND new.active_repair_attempt_id IS old.active_repair_attempt_id
            AND old.active_verification_id IS NOT NULL
            AND new.active_verification_id IS NULL
            AND role.role = 'verifier'
            AND event.type = 'verification.result_recorded'
            AND event.aggregate_type = 'verification'
            AND event.aggregate_id = old.active_verification_id
            AND event.resource_type = 'verification'
            AND event.resource_id = old.active_verification_id
            AND event.from_state = 'ready_for_verification'
            AND event.to_state = 'ready_for_verification'
            AND json_extract(event.payload_json, '$.status') = 'blocked'
            AND json_extract(event.payload_json, '$.verificationId') = old.active_verification_id
            AND json_extract(event.payload_json, '$.repairAttemptId') = old.active_repair_attempt_id
            AND json_type(event.payload_json, '$.reason') = 'text'
            AND length(trim(json_extract(event.payload_json, '$.reason'))) > 0
            AND json_extract(event.payload_json, '$.fromVersion') = event.resource_version_after - 1
            AND json_extract(event.payload_json, '$.toVersion') = event.resource_version_after
            AND EXISTS (
              SELECT 1
              FROM verifications AS verification
              JOIN repair_attempts AS attempt
                ON attempt.account_id = verification.account_id
               AND attempt.project_id = verification.project_id
               AND attempt.bug_id = verification.bug_id
               AND attempt.id = verification.repair_attempt_id
              WHERE verification.account_id = old.account_id
                AND verification.project_id = old.project_id
                AND verification.bug_id = old.id
                AND verification.id = old.active_verification_id
                AND verification.repair_attempt_id = old.active_repair_attempt_id
                AND verification.verifier_id = event.actor_user_id
                AND verification.status = 'blocked'
                AND verification.version = event.resource_version_after
                AND verification.updated_at = new.updated_at
                AND verification.blocked_reason IS NOT NULL
                AND json_extract(event.payload_json, '$.buildId') IS verification.build_id
                AND attempt.status = 'delivered'
            )
          )
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Bug same-state workflow pointers require their exact typed human audit and relation facts');
END;

CREATE TRIGGER repair_attempts_history_identity_immutable
BEFORE UPDATE ON repair_attempts
WHEN new.id IS NOT old.id
  OR new.account_id IS NOT old.account_id
  OR new.project_id IS NOT old.project_id
  OR new.bug_id IS NOT old.bug_id
  OR new.sequence IS NOT old.sequence
  OR new.mode IS NOT old.mode
  OR new.assignee_id IS NOT old.assignee_id
  OR new.parent_attempt_id IS NOT old.parent_attempt_id
  OR new.created_at IS NOT old.created_at
BEGIN
  SELECT RAISE(ABORT, 'RepairAttempt identity, sequence, mode, assignee, and parent history are immutable');
END;

CREATE TRIGGER repair_attempts_lifecycle_typed_guard
BEFORE UPDATE ON repair_attempts
WHEN NOT (
  new.version = old.version + 1
  AND new.updated_at > old.updated_at
  AND EXISTS (
    SELECT 1
    FROM events AS event
    JOIN users AS actor_user
      ON actor_user.account_id = event.account_id
     AND actor_user.id = event.actor_user_id
     AND actor_user.status = 'active'
    JOIN accounts AS actor_account
      ON actor_account.id = event.account_id
     AND actor_account.status = 'active'
    JOIN projects AS actor_project
      ON actor_project.account_id = event.account_id
     AND actor_project.id = event.project_id
     AND actor_project.status = 'active'
    JOIN memberships AS membership
      ON membership.account_id = event.account_id
     AND membership.project_id = event.project_id
     AND membership.user_id = event.actor_user_id
     AND membership.status = 'active'
    JOIN membership_roles AS role
      ON role.account_id = membership.account_id
     AND role.project_id = membership.project_id
     AND role.membership_id = membership.id
    WHERE event.account_id = new.account_id
      AND event.project_id = new.project_id
      AND event.bug_id = new.bug_id
      AND event.source = 'qa_hub'
      AND event.actor_type = 'user'
      AND event.request_digest IS NOT NULL
      AND event.created_at = new.updated_at
      AND (
        (
          old.status = 'planned'
          AND new.status = 'running'
          AND role.role = 'developer'
          AND event.type = 'repair_attempt.started'
          AND event.aggregate_type = 'repair_attempt'
          AND event.aggregate_id = new.id
          AND event.resource_type = 'repair_attempt'
          AND event.resource_id = new.id
          AND event.resource_version_after = new.version
          AND event.from_state IS NULL
          AND event.to_state IS NULL
          AND json_extract(event.payload_json, '$.status') = 'running'
          AND json_extract(event.payload_json, '$.repairAttemptId') = new.id
          AND json_extract(event.payload_json, '$.fromVersion') = old.version
          AND json_extract(event.payload_json, '$.toVersion') = new.version
          AND new.summary IS old.summary
          AND new.branch IS old.branch
          AND new.commit_sha IS old.commit_sha
          AND new.merge_request_url IS old.merge_request_url
          AND new.patch_url IS old.patch_url
          AND new.no_code_reason IS old.no_code_reason
          AND new.target_build_id IS old.target_build_id
          AND new.failure_reason IS old.failure_reason
        )
        OR (
          old.status IN ('planned', 'queued', 'running', 'needs_input', 'blocked')
          AND new.status IN ('failed', 'superseded')
          AND role.role = 'developer'
          AND event.type = CASE new.status
            WHEN 'failed' THEN 'repair_attempt.failed'
            ELSE 'repair_attempt.superseded'
          END
          AND event.aggregate_type = 'repair_attempt'
          AND event.aggregate_id = new.id
          AND event.resource_type = 'repair_attempt'
          AND event.resource_id = new.id
          AND event.resource_version_after = new.version
          AND json_extract(event.payload_json, '$.status') = new.status
          AND json_extract(event.payload_json, '$.repairAttemptId') = new.id
          AND json_type(event.payload_json, '$.reason') = 'text'
          AND length(trim(json_extract(event.payload_json, '$.reason'))) > 0
          AND json_extract(event.payload_json, '$.fromVersion') = old.version
          AND json_extract(event.payload_json, '$.toVersion') = new.version
          AND new.summary IS old.summary
          AND new.branch IS old.branch
          AND new.commit_sha IS old.commit_sha
          AND new.merge_request_url IS old.merge_request_url
          AND new.patch_url IS old.patch_url
          AND new.no_code_reason IS old.no_code_reason
          AND new.target_build_id IS old.target_build_id
          AND (
            (
              new.status = 'failed'
              AND old.failure_reason IS NULL
              AND new.failure_reason IS NOT NULL
              AND length(trim(new.failure_reason)) > 0
              AND (
                json_extract(event.payload_json, '$.reason') = new.failure_reason
                OR (
                  length(CAST(json_extract(event.payload_json, '$.reason') AS BLOB)) <= 2000
                  AND length(CAST(json_extract(event.payload_json, '$.reason') AS BLOB))
                    < length(CAST(new.failure_reason AS BLOB))
                  AND substr(json_extract(event.payload_json, '$.reason'), -1, 1) = '…'
                  AND substr(
                    new.failure_reason,
                    1,
                    length(json_extract(event.payload_json, '$.reason')) - 1
                  ) = substr(
                    json_extract(event.payload_json, '$.reason'),
                    1,
                    length(json_extract(event.payload_json, '$.reason')) - 1
                  )
                )
                OR (
                  json_extract(event.payload_json, '$.reason') = '[REDACTED]'
                  AND (
                    lower(new.failure_reason) GLOB '*authorization*[:=]*'
                    OR lower(new.failure_reason) LIKE '%bearer %'
                    OR lower(new.failure_reason) GLOB '*password*[:=]*'
                    OR lower(new.failure_reason) GLOB '*passwd*[:=]*'
                    OR lower(new.failure_reason) GLOB '*pwd*[:=]*'
                    OR lower(new.failure_reason) GLOB '*secret*[:=]*'
                    OR lower(new.failure_reason) GLOB '*token*[:=]*'
                    OR lower(new.failure_reason) GLOB '*cookie*[:=]*'
                    OR lower(new.failure_reason) GLOB '*credential*[:=]*'
                    OR lower(new.failure_reason) GLOB '*apikey*[:=]*'
                    OR lower(new.failure_reason) GLOB '*api_key*[:=]*'
                    OR lower(new.failure_reason) GLOB '*api-key*[:=]*'
                    OR lower(new.failure_reason) GLOB '*api key*[:=]*'
                    OR lower(new.failure_reason) GLOB '*private*key*[:=]*'
                    OR lower(new.failure_reason) GLOB '*://*:*@*'
                    OR lower(new.failure_reason) GLOB '*eyj????????*.*.*'
                    OR instr(new.failure_reason, char(92)) > 0
                  )
                )
              )
            )
            OR (
              new.status = 'superseded'
              AND new.failure_reason IS old.failure_reason
            )
          )
        )
        OR (
          old.status = 'running'
          AND new.status = 'delivered'
          AND role.role = 'developer'
          AND event.type = 'repair_attempt.delivered'
          AND event.aggregate_type = 'repair_attempt'
          AND event.aggregate_id = new.id
          AND event.resource_type = 'build_requirement'
          AND event.resource_version_after = 1
          AND event.from_state = 'in_progress'
          AND event.to_state IN ('awaiting_build', 'ready_for_verification')
          AND json_extract(event.payload_json, '$.status') = 'delivered'
          AND json_extract(event.payload_json, '$.repairAttemptId') = new.id
          AND json_extract(event.payload_json, '$.commitSha') IS new.commit_sha
          AND json_extract(event.payload_json, '$.fromVersion') = old.version
          AND json_extract(event.payload_json, '$.toVersion') = new.version
          AND new.summary IS NOT NULL
          AND length(trim(new.summary)) > 0
          AND new.target_build_id IS NULL
          AND new.failure_reason IS old.failure_reason
          AND (
            (
              new.no_code_reason IS NOT NULL
              AND length(trim(new.no_code_reason)) > 0
              AND new.branch IS NULL
              AND new.commit_sha IS NULL
              AND new.merge_request_url IS NULL
              AND new.patch_url IS NULL
              AND event.to_state = 'ready_for_verification'
              AND json_type(event.payload_json, '$.reason') = 'text'
            )
            OR (
              new.no_code_reason IS NULL
              AND new.branch IS NOT NULL
              AND length(trim(new.branch)) > 0
              AND new.commit_sha IS NOT NULL
              AND event.to_state IN ('awaiting_build', 'ready_for_verification')
            )
          )
        )
        OR (
          old.status = 'delivered'
          AND new.status = 'verification_failed'
          AND role.role = 'verifier'
          AND event.type = 'verification.result_recorded'
          AND event.aggregate_type = 'verification'
          AND event.resource_type = 'verification'
          AND event.aggregate_id = event.resource_id
          AND event.resource_version_after >= 2
          AND event.from_state = 'ready_for_verification'
          AND event.to_state = 'ready'
          AND json_extract(event.payload_json, '$.status') = 'failed'
          AND json_extract(event.payload_json, '$.repairAttemptId') = new.id
          AND json_type(event.payload_json, '$.reason') = 'text'
          AND length(trim(json_extract(event.payload_json, '$.reason'))) > 0
          AND new.summary IS old.summary
          AND new.branch IS old.branch
          AND new.commit_sha IS old.commit_sha
          AND new.merge_request_url IS old.merge_request_url
          AND new.patch_url IS old.patch_url
          AND new.no_code_reason IS old.no_code_reason
          AND new.target_build_id IS old.target_build_id
          AND new.failure_reason IS old.failure_reason
          AND EXISTS (
            SELECT 1 FROM verifications AS verification
            WHERE verification.account_id = new.account_id
              AND verification.project_id = new.project_id
              AND verification.bug_id = new.bug_id
              AND verification.id = event.resource_id
              AND verification.repair_attempt_id = new.id
              AND verification.verifier_id = event.actor_user_id
              AND verification.status = 'failed'
              AND verification.version = event.resource_version_after
              AND verification.updated_at = new.updated_at
          )
        )
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'RepairAttempt lifecycle requires a forward exact-CAS typed audit Event and immutable delivery evidence');
END;

CREATE TRIGGER repair_attempts_no_delete
BEFORE DELETE ON repair_attempts
BEGIN
  SELECT RAISE(ABORT, 'RepairAttempt history is append-only');
END;

CREATE TRIGGER occurrences_evidence_no_update
BEFORE UPDATE ON occurrences
BEGIN
  SELECT RAISE(ABORT, 'Occurrence evidence is immutable');
END;

CREATE TRIGGER occurrences_evidence_no_delete
BEFORE DELETE ON occurrences
BEGIN
  SELECT RAISE(ABORT, 'Occurrence evidence is append-only');
END;

CREATE TRIGGER verifications_lifecycle_guard
BEFORE UPDATE ON verifications
WHEN NOT (
  new.version = old.version + 1
  AND new.updated_at > old.updated_at
  AND new.criteria_snapshot IS old.criteria_snapshot
  AND (
    (
      old.status = 'requested'
      AND new.status = 'in_progress'
      AND new.result_summary IS NULL
      AND new.failure_reason IS NULL
      AND new.blocked_reason IS NULL
    )
    OR (
      old.status = 'in_progress'
      AND new.status = 'passed'
      AND new.result_summary IS NOT NULL
      AND length(trim(new.result_summary)) > 0
      AND new.failure_reason IS NULL
      AND new.blocked_reason IS NULL
    )
    OR (
      old.status = 'in_progress'
      AND new.status = 'failed'
      AND new.result_summary IS NOT NULL
      AND length(trim(new.result_summary)) > 0
      AND new.failure_reason IS NOT NULL
      AND new.blocked_reason IS NULL
    )
    OR (
      old.status = 'in_progress'
      AND new.status = 'blocked'
      AND new.result_summary IS NOT NULL
      AND length(trim(new.result_summary)) > 0
      AND new.failure_reason IS NULL
      AND new.blocked_reason IS NOT NULL
    )
    OR (
      old.status IN ('requested', 'in_progress')
      AND new.status = 'cancelled'
      AND new.result_summary IS NULL
      AND new.failure_reason IS NULL
      AND new.blocked_reason IS NULL
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Verification lifecycle requires a forward exact version CAS');
END;

CREATE TRIGGER verifications_initial_typed_guard
BEFORE INSERT ON verifications
WHEN NOT (
  new.status = 'requested'
  AND new.version = 1
  AND new.created_at = new.updated_at
  AND new.result_summary IS NULL
  AND new.failure_reason IS NULL
  AND new.blocked_reason IS NULL
  AND EXISTS (
    SELECT 1
    FROM events AS event
    JOIN users AS verifier_user
      ON verifier_user.account_id = event.account_id
     AND verifier_user.id = event.actor_user_id
     AND verifier_user.status = 'active'
    JOIN accounts AS verifier_account
      ON verifier_account.id = event.account_id
     AND verifier_account.status = 'active'
    JOIN projects AS verifier_project
      ON verifier_project.account_id = event.account_id
     AND verifier_project.id = event.project_id
     AND verifier_project.status = 'active'
    JOIN memberships AS membership
      ON membership.account_id = event.account_id
     AND membership.project_id = event.project_id
     AND membership.user_id = event.actor_user_id
     AND membership.status = 'active'
    JOIN membership_roles AS role
      ON role.account_id = membership.account_id
     AND role.project_id = membership.project_id
     AND role.membership_id = membership.id
     AND role.role = 'verifier'
    JOIN users AS assigned_verifier_user
      ON assigned_verifier_user.account_id = new.account_id
     AND assigned_verifier_user.id = new.verifier_id
     AND assigned_verifier_user.status = 'active'
    JOIN memberships AS assigned_membership
      ON assigned_membership.account_id = new.account_id
     AND assigned_membership.project_id = new.project_id
     AND assigned_membership.user_id = new.verifier_id
     AND assigned_membership.status = 'active'
    JOIN membership_roles AS assigned_role
      ON assigned_role.account_id = assigned_membership.account_id
     AND assigned_role.project_id = assigned_membership.project_id
     AND assigned_role.membership_id = assigned_membership.id
     AND assigned_role.role = 'verifier'
    JOIN repair_attempts AS attempt
      ON attempt.account_id = new.account_id
     AND attempt.project_id = new.project_id
     AND attempt.bug_id = new.bug_id
     AND attempt.id = new.repair_attempt_id
     AND attempt.status = 'delivered'
    JOIN bugs AS bug
      ON bug.account_id = new.account_id
     AND bug.project_id = new.project_id
     AND bug.id = new.bug_id
    WHERE event.account_id = new.account_id
      AND event.project_id = new.project_id
      AND event.bug_id = new.bug_id
      AND event.source = 'qa_hub'
      AND event.actor_type = 'user'
      AND event.type = 'verification.created'
      AND event.aggregate_type = 'verification'
      AND event.aggregate_id = new.id
      AND event.resource_type = 'verification'
      AND event.resource_id = new.id
      AND event.resource_version_after = 1
      AND event.request_digest IS NOT NULL
      AND event.from_state IS NULL
      AND event.to_state IS NULL
      AND event.created_at = new.created_at
      AND json_extract(event.payload_json, '$.status') = 'requested'
      AND json_extract(event.payload_json, '$.verificationId') = new.id
      AND json_extract(event.payload_json, '$.repairAttemptId') = new.repair_attempt_id
      AND json_extract(event.payload_json, '$.buildId') IS new.build_id
      AND json_extract(event.payload_json, '$.toVersion') = 1
      AND (bug.severity NOT IN ('S0', 'S1') OR attempt.assignee_id <> new.verifier_id)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Verification must begin as one requested version-one fact with current creator and assigned-verifier authority');
END;

CREATE TRIGGER verifications_typed_audit_guard
BEFORE UPDATE OF status ON verifications
WHEN new.status <> old.status AND NOT EXISTS (
  SELECT 1
  FROM events AS event
  JOIN users AS verifier_user
    ON verifier_user.account_id = event.account_id
   AND verifier_user.id = event.actor_user_id
   AND verifier_user.status = 'active'
  JOIN accounts AS verifier_account
    ON verifier_account.id = event.account_id
   AND verifier_account.status = 'active'
  JOIN projects AS verifier_project
    ON verifier_project.account_id = event.account_id
   AND verifier_project.id = event.project_id
   AND verifier_project.status = 'active'
  JOIN memberships AS membership
    ON membership.account_id = new.account_id
   AND membership.project_id = new.project_id
   AND membership.user_id = new.verifier_id
   AND membership.status = 'active'
  JOIN membership_roles AS role
    ON role.account_id = membership.account_id
   AND role.project_id = membership.project_id
   AND role.membership_id = membership.id
   AND role.role = 'verifier'
  WHERE event.account_id = new.account_id
    AND event.project_id = new.project_id
    AND event.bug_id = new.bug_id
    AND event.source = 'qa_hub'
    AND event.actor_type = 'user'
    AND event.actor_user_id = new.verifier_id
    AND event.aggregate_type = 'verification'
    AND event.aggregate_id = new.id
    AND event.resource_type = 'verification'
    AND event.resource_id = new.id
    AND event.resource_version_after = new.version
    AND event.request_digest IS NOT NULL
    AND event.created_at = new.updated_at
    AND json_extract(event.payload_json, '$.verificationId') = new.id
    AND json_extract(event.payload_json, '$.fromVersion') = old.version
    AND json_extract(event.payload_json, '$.toVersion') = new.version
    AND (
      (
        old.status = 'requested'
        AND new.status = 'in_progress'
        AND event.type = 'verification.started'
        AND event.from_state IS NULL
        AND event.to_state IS NULL
        AND json_extract(event.payload_json, '$.status') = 'in_progress'
      )
      OR (
        old.status = 'in_progress'
        AND new.status IN ('passed', 'failed', 'blocked')
        AND event.type = 'verification.result_recorded'
        AND event.from_state = 'ready_for_verification'
        AND event.to_state = CASE new.status
          WHEN 'passed' THEN 'closed'
          WHEN 'failed' THEN 'ready'
          ELSE 'ready_for_verification'
        END
        AND json_extract(event.payload_json, '$.status') = new.status
        AND json_extract(event.payload_json, '$.repairAttemptId') = new.repair_attempt_id
        AND json_extract(event.payload_json, '$.buildId') IS new.build_id
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Verification transition requires its exact assigned-human typed audit Event');
END;

CREATE TRIGGER verifications_no_delete
BEFORE DELETE ON verifications
BEGIN
  SELECT RAISE(ABORT, 'Verification history is append-only');
END;

CREATE TABLE build_lineages (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  lineage_key TEXT NOT NULL CHECK (length(lineage_key) BETWEEN 1 AND 100),
  channel TEXT NOT NULL CHECK (length(channel) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  version INTEGER NOT NULL CHECK (version = 1),
  FOREIGN KEY (account_id, project_id)
    REFERENCES projects(account_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, id),
  UNIQUE (account_id, project_id, lineage_key)
) STRICT;

CREATE TRIGGER build_lineages_no_update
BEFORE UPDATE ON build_lineages
BEGIN
  SELECT RAISE(ABORT, 'Build lineage identity is immutable');
END;

CREATE TRIGGER build_lineages_no_delete
BEFORE DELETE ON build_lineages
BEGIN
  SELECT RAISE(ABORT, 'Build lineage identity is append-only');
END;

CREATE TABLE build_lineage_entries (
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  lineage_id TEXT NOT NULL CHECK (length(lineage_id) = 36),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  build_id TEXT NOT NULL CHECK (length(build_id) = 36),
  predecessor_build_id TEXT,
  evidence_actor_id TEXT NOT NULL CHECK (length(evidence_actor_id) = 36),
  evidence_event_id TEXT NOT NULL CHECK (length(evidence_event_id) = 36),
  policy_version TEXT NOT NULL CHECK (policy_version = '1.0.0'),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  version INTEGER NOT NULL CHECK (version = 1),
  PRIMARY KEY (account_id, project_id, lineage_id, ordinal),
  FOREIGN KEY (account_id, project_id, lineage_id)
    REFERENCES build_lineages(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, build_id)
    REFERENCES builds(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, predecessor_build_id)
    REFERENCES builds(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, evidence_actor_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, evidence_event_id)
    REFERENCES events(account_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, build_id),
  UNIQUE (account_id, project_id, lineage_id, build_id),
  UNIQUE (account_id, project_id, lineage_id, ordinal, build_id)
) STRICT;

CREATE TRIGGER build_lineage_entries_typed_guard
BEFORE INSERT ON build_lineage_entries
WHEN NOT EXISTS (
  SELECT 1
  FROM builds AS build
  WHERE build.account_id = new.account_id
    AND build.project_id = new.project_id
    AND build.id = new.build_id
    AND build.status = 'ready'
)
OR NOT (
  (
    new.ordinal = 1
    AND new.predecessor_build_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM build_lineage_entries AS existing
      WHERE existing.account_id = new.account_id
        AND existing.project_id = new.project_id
        AND existing.lineage_id = new.lineage_id
    )
  )
  OR (
    new.ordinal > 1
    AND EXISTS (
      SELECT 1 FROM build_lineage_entries AS predecessor
      WHERE predecessor.account_id = new.account_id
        AND predecessor.project_id = new.project_id
        AND predecessor.lineage_id = new.lineage_id
        AND predecessor.ordinal = new.ordinal - 1
        AND predecessor.build_id = new.predecessor_build_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM build_lineage_entries AS later
      WHERE later.account_id = new.account_id
        AND later.project_id = new.project_id
        AND later.lineage_id = new.lineage_id
        AND later.ordinal >= new.ordinal
    )
  )
)
OR NOT EXISTS (
  SELECT 1
  FROM events AS event
  JOIN builds AS build
    ON build.account_id = new.account_id
   AND build.project_id = new.project_id
   AND build.id = new.build_id
  JOIN accounts AS account
    ON account.id = new.account_id
   AND account.status = 'active'
  JOIN projects AS project
    ON project.account_id = new.account_id
   AND project.id = new.project_id
   AND project.status = 'active'
  JOIN users AS actor
    ON actor.account_id = new.account_id
   AND actor.id = new.evidence_actor_id
   AND actor.status = 'active'
  JOIN memberships AS membership
    ON membership.account_id = new.account_id
   AND membership.project_id = new.project_id
   AND membership.user_id = new.evidence_actor_id
   AND membership.status = 'active'
  JOIN membership_roles AS role
    ON role.account_id = membership.account_id
   AND role.project_id = membership.project_id
   AND role.membership_id = membership.id
   AND role.role = 'release_manager'
  WHERE event.id = new.evidence_event_id
    AND event.account_id = new.account_id
    AND event.project_id = new.project_id
    AND event.bug_id IS NULL
    AND event.type = 'build.lineage_entry_recorded'
    AND event.source = 'qa_hub'
    AND event.actor_type = 'user'
    AND event.actor_user_id = new.evidence_actor_id
    AND event.aggregate_type = 'build'
    AND event.aggregate_id = new.lineage_id
    AND event.aggregate_sequence = new.ordinal
    AND event.resource_type = 'build'
    AND event.resource_id = new.build_id
    AND event.resource_version_after = build.version
    AND event.request_digest IS NOT NULL
    AND event.created_at = new.created_at
    AND json_extract(event.payload_json, '$.status') = 'ranked'
    AND json_extract(event.payload_json, '$.buildId') = new.build_id
    AND (
      (
        new.ordinal = 1
        AND json_type(event.payload_json, '$.fromVersion') IS NULL
      )
      OR (
        new.ordinal > 1
        AND json_type(event.payload_json, '$.fromVersion') = 'integer'
        AND json_extract(event.payload_json, '$.fromVersion') = new.ordinal - 1
      )
    )
    AND json_type(event.payload_json, '$.toVersion') = 'integer'
    AND json_extract(event.payload_json, '$.toVersion') = new.ordinal
)
BEGIN
  SELECT RAISE(ABORT, 'Build lineage entry requires a contiguous server-ranked release fact');
END;

CREATE TRIGGER build_lineage_entries_no_update
BEFORE UPDATE ON build_lineage_entries
BEGIN
  SELECT RAISE(ABORT, 'Build lineage entries are immutable');
END;

CREATE TRIGGER build_lineage_entries_no_delete
BEFORE DELETE ON build_lineage_entries
BEGIN
  SELECT RAISE(ABORT, 'Build lineage entries are append-only');
END;

CREATE TABLE occurrence_build_lineage_facts (
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  bug_id TEXT NOT NULL CHECK (length(bug_id) = 36),
  occurrence_id TEXT NOT NULL CHECK (length(occurrence_id) = 36),
  build_id TEXT NOT NULL CHECK (length(build_id) = 36),
  lineage_id TEXT NOT NULL CHECK (length(lineage_id) = 36),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  append_event_id TEXT NOT NULL CHECK (length(append_event_id) = 36),
  append_event_position INTEGER NOT NULL CHECK (append_event_position >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  PRIMARY KEY (account_id, project_id, occurrence_id),
  FOREIGN KEY (account_id, project_id, occurrence_id, bug_id)
    REFERENCES occurrences(account_id, project_id, id, bug_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, lineage_id, ordinal, build_id)
    REFERENCES build_lineage_entries(account_id, project_id, lineage_id, ordinal, build_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, append_event_id)
    REFERENCES events(account_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, append_event_id)
) STRICT;

CREATE UNIQUE INDEX events_one_occurrence_append
  ON events(account_id, project_id, resource_type, resource_id)
  WHERE type = 'occurrence.appended' AND resource_type = 'occurrence';

CREATE TRIGGER events_occurrence_append_typed_guard
BEFORE INSERT ON events
WHEN new.type = 'occurrence.appended' AND NOT EXISTS (
  SELECT 1
  FROM occurrences AS occurrence
  JOIN accounts AS account
    ON account.id = occurrence.account_id
   AND account.status = 'active'
  JOIN projects AS project
    ON project.account_id = occurrence.account_id
   AND project.id = occurrence.project_id
   AND project.status = 'active'
  JOIN users AS actor
    ON actor.account_id = occurrence.account_id
   AND actor.id = new.actor_user_id
   AND actor.status = 'active'
  JOIN memberships AS membership
    ON membership.account_id = occurrence.account_id
   AND membership.project_id = occurrence.project_id
   AND membership.user_id = new.actor_user_id
   AND membership.status = 'active'
  JOIN membership_roles AS role
    ON role.account_id = membership.account_id
   AND role.project_id = membership.project_id
   AND role.membership_id = membership.id
   AND role.role = 'reporter'
  WHERE occurrence.account_id = new.account_id
    AND occurrence.project_id = new.project_id
    AND occurrence.bug_id = new.bug_id
    AND occurrence.id = new.resource_id
    AND occurrence.reporter_id = new.actor_user_id
    AND new.source = 'qa_hub'
    AND new.actor_type = 'user'
    AND new.aggregate_type = 'bug'
    AND new.aggregate_id = occurrence.bug_id
    AND new.resource_type = 'occurrence'
    AND new.resource_version_after = occurrence.version
    AND new.request_digest IS NOT NULL
    AND new.from_state IS NULL
    AND new.to_state IS NULL
    AND new.created_at = occurrence.created_at
    AND json_extract(new.payload_json, '$.occurrenceId') = occurrence.id
    AND json_type(new.payload_json, '$.fromVersion') = 'integer'
    AND json_type(new.payload_json, '$.toVersion') = 'integer'
    AND json_extract(new.payload_json, '$.toVersion') = json_extract(new.payload_json, '$.fromVersion') + 1
)
BEGIN
  SELECT RAISE(ABORT, 'occurrence.appended Event requires one same-scope persisted Occurrence');
END;

CREATE TRIGGER events_occurrence_lineage_fact
AFTER INSERT ON events
WHEN new.type = 'occurrence.appended'
BEGIN
  INSERT INTO occurrence_build_lineage_facts(
    account_id, project_id, bug_id, occurrence_id, build_id, lineage_id,
    ordinal, append_event_id, append_event_position, created_at
  )
  SELECT occurrence.account_id, occurrence.project_id, occurrence.bug_id, occurrence.id,
         occurrence.build_id, entry.lineage_id, entry.ordinal,
         new.id, new.event_position, new.created_at
  FROM occurrences AS occurrence
  JOIN build_lineage_entries AS entry
    ON entry.account_id = occurrence.account_id
   AND entry.project_id = occurrence.project_id
   AND entry.build_id = occurrence.build_id
  WHERE occurrence.account_id = new.account_id
    AND occurrence.project_id = new.project_id
    AND occurrence.bug_id = new.bug_id
    AND occurrence.id = new.resource_id;
END;

CREATE TRIGGER build_lineage_entries_backfill_occurrence_facts
AFTER INSERT ON build_lineage_entries
BEGIN
  INSERT INTO occurrence_build_lineage_facts(
    account_id, project_id, bug_id, occurrence_id, build_id, lineage_id,
    ordinal, append_event_id, append_event_position, created_at
  )
  SELECT occurrence.account_id, occurrence.project_id, occurrence.bug_id, occurrence.id,
         occurrence.build_id, new.lineage_id, new.ordinal,
         event.id, event.event_position, event.created_at
  FROM occurrences AS occurrence
  JOIN events AS event
    ON event.account_id = occurrence.account_id
   AND event.project_id = occurrence.project_id
   AND event.bug_id = occurrence.bug_id
   AND event.type = 'occurrence.appended'
   AND event.source = 'qa_hub'
   AND event.actor_type = 'user'
   AND event.actor_user_id = occurrence.reporter_id
   AND event.aggregate_type = 'bug'
   AND event.aggregate_id = occurrence.bug_id
   AND event.resource_type = 'occurrence'
   AND event.resource_id = occurrence.id
   AND event.resource_version_after = occurrence.version
   AND event.request_digest IS NOT NULL
   AND event.from_state IS NULL
   AND event.to_state IS NULL
   AND event.created_at = occurrence.created_at
   AND json_extract(event.payload_json, '$.occurrenceId') = occurrence.id
   AND json_type(event.payload_json, '$.fromVersion') = 'integer'
   AND json_type(event.payload_json, '$.toVersion') = 'integer'
   AND json_extract(event.payload_json, '$.toVersion') = json_extract(event.payload_json, '$.fromVersion') + 1
  WHERE occurrence.account_id = new.account_id
    AND occurrence.project_id = new.project_id
    AND occurrence.build_id = new.build_id;
END;

CREATE TRIGGER occurrence_build_lineage_facts_no_update
BEFORE UPDATE ON occurrence_build_lineage_facts
BEGIN
  SELECT RAISE(ABORT, 'Occurrence Build lineage facts are immutable');
END;

CREATE TRIGGER occurrence_build_lineage_facts_no_delete
BEFORE DELETE ON occurrence_build_lineage_facts
BEGIN
  SELECT RAISE(ABORT, 'Occurrence Build lineage facts are append-only');
END;

CREATE VIEW valid_human_bug_closures AS
SELECT event.account_id,
       event.project_id,
       event.bug_id,
       event.id AS close_event_id,
       event.type AS close_event_type,
       event.event_position AS close_event_position,
       event.created_at AS closed_at,
       event.actor_user_id,
       verification.id AS verification_id,
       verification.version AS verification_version,
       verification.build_id AS verified_build_id,
       attempt.id AS repair_attempt_id,
       lineage_entry.lineage_id AS baseline_lineage_id,
       lineage_entry.ordinal AS baseline_ordinal
FROM events AS event
JOIN bugs AS current_bug
  ON current_bug.account_id = event.account_id
 AND current_bug.project_id = event.project_id
 AND current_bug.id = event.bug_id
JOIN verifications AS verification
  ON verification.account_id = event.account_id
 AND verification.project_id = event.project_id
 AND verification.bug_id = event.bug_id
 AND verification.id = json_extract(event.payload_json, '$.verificationId')
JOIN repair_attempts AS attempt
  ON attempt.account_id = verification.account_id
 AND attempt.project_id = verification.project_id
 AND attempt.bug_id = verification.bug_id
 AND attempt.id = verification.repair_attempt_id
JOIN build_requirements AS requirement
  ON requirement.account_id = attempt.account_id
 AND requirement.project_id = attempt.project_id
 AND requirement.bug_id = attempt.bug_id
 AND requirement.repair_attempt_id = attempt.id
JOIN accounts AS current_account
  ON current_account.id = event.account_id
 AND current_account.status = 'active'
JOIN projects AS current_project
  ON current_project.account_id = event.account_id
 AND current_project.id = event.project_id
 AND current_project.status = 'active'
JOIN users AS current_actor
  ON current_actor.account_id = event.account_id
 AND current_actor.id = event.actor_user_id
 AND current_actor.status = 'active'
JOIN memberships AS membership
  ON membership.account_id = event.account_id
 AND membership.project_id = event.project_id
 AND membership.user_id = event.actor_user_id
 AND membership.status = 'active'
JOIN membership_roles AS role
  ON role.account_id = membership.account_id
 AND role.project_id = membership.project_id
 AND role.membership_id = membership.id
 AND role.role = 'verifier'
LEFT JOIN build_repair_links AS link
  ON link.account_id = requirement.account_id
 AND link.project_id = requirement.project_id
 AND link.bug_id = requirement.bug_id
 AND link.repair_attempt_id = requirement.repair_attempt_id
 AND link.build_requirement_id = requirement.id
LEFT JOIN builds AS build
  ON build.account_id = verification.account_id
 AND build.project_id = verification.project_id
 AND build.id = verification.build_id
LEFT JOIN build_lineage_entries AS lineage_entry
  ON lineage_entry.account_id = verification.account_id
 AND lineage_entry.project_id = verification.project_id
 AND lineage_entry.build_id = verification.build_id
WHERE event.source = 'qa_hub'
  AND event.actor_type = 'user'
  AND event.request_digest IS NOT NULL
  AND event.actor_user_id = verification.verifier_id
  AND event.from_state = 'ready_for_verification'
  AND event.to_state = 'closed'
  AND verification.status = 'passed'
  AND attempt.status = 'delivered'
  AND (current_bug.severity NOT IN ('S0', 'S1') OR attempt.assignee_id <> verification.verifier_id)
  AND json_extract(event.payload_json, '$.status') = 'passed'
  AND json_extract(event.payload_json, '$.repairAttemptId') = attempt.id
  AND (
    (
      event.type = 'verification.result_recorded'
      AND event.aggregate_type = 'verification'
      AND event.aggregate_id = verification.id
      AND event.resource_type = 'verification'
      AND event.resource_id = verification.id
      AND event.resource_version_after = verification.version
      AND json_extract(event.payload_json, '$.fromVersion') = verification.version - 1
      AND json_extract(event.payload_json, '$.toVersion') = verification.version
    )
    OR (
      event.type = 'bug.verification.passed'
      AND event.aggregate_type = 'bug'
      AND event.aggregate_id = event.bug_id
      AND event.resource_type = 'bug'
      AND event.resource_id = event.bug_id
    )
  )
  AND (
    (
      requirement.requirement = 'not_required'
      AND requirement.version = 1
      AND requirement.linked_build_id IS NULL
      AND requirement.link_id IS NULL
      AND verification.build_id IS NULL
      AND requirement.decision_basis IN ('no_code_delivery', 'authorized_no_build_exemption')
    )
    OR (
      requirement.requirement = 'required'
      AND requirement.decision_basis = 'code_requires_build'
      AND requirement.version = 2
      AND requirement.linked_build_id = verification.build_id
      AND requirement.link_id = link.id
      AND build.status = 'ready'
      AND link.version = 1
      AND link.build_id = build.id
      AND link.delivered_commit_sha = requirement.delivered_commit_sha
      AND requirement.delivered_commit_sha = attempt.commit_sha
      AND (
        (
          link.evidence_type = 'manifest'
          AND link.evidence_decision = 'manifest_verified'
          AND EXISTS (
            SELECT 1 FROM build_manifest_commits AS manifest_commit
            WHERE manifest_commit.account_id = build.account_id
              AND manifest_commit.project_id = build.project_id
              AND manifest_commit.build_id = build.id
              AND manifest_commit.commit_sha = requirement.delivered_commit_sha
          )
        )
        OR (
          link.evidence_type = 'release_manager_override'
          AND link.evidence_decision = 'release_manager_authorized'
          AND link.override_reason IS NOT NULL
        )
      )
    )
  );

CREATE TABLE bug_closure_acceptances (
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  bug_id TEXT NOT NULL CHECK (length(bug_id) = 36),
  closure_generation INTEGER NOT NULL CHECK (closure_generation >= 0),
  verification_id TEXT NOT NULL CHECK (length(verification_id) = 36),
  close_event_id TEXT NOT NULL CHECK (length(close_event_id) = 36),
  close_event_position INTEGER NOT NULL CHECK (close_event_position >= 1),
  actor_user_id TEXT NOT NULL CHECK (length(actor_user_id) = 36),
  closed_bug_version INTEGER NOT NULL CHECK (closed_bug_version >= 1),
  closed_at TEXT NOT NULL CHECK (length(closed_at) >= 20),
  baseline_kind TEXT NOT NULL CHECK (baseline_kind IN ('verified_build', 'unranked_build', 'no_build')),
  baseline_build_id TEXT,
  baseline_lineage_id TEXT,
  baseline_ordinal INTEGER,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  CHECK (
    (baseline_kind = 'verified_build' AND baseline_build_id IS NOT NULL AND baseline_lineage_id IS NOT NULL AND baseline_ordinal IS NOT NULL)
    OR (baseline_kind = 'unranked_build' AND baseline_build_id IS NOT NULL AND baseline_lineage_id IS NULL AND baseline_ordinal IS NULL)
    OR (baseline_kind = 'no_build' AND baseline_build_id IS NULL AND baseline_lineage_id IS NULL AND baseline_ordinal IS NULL)
  ),
  PRIMARY KEY (account_id, project_id, bug_id, closure_generation),
  FOREIGN KEY (account_id, project_id, bug_id)
    REFERENCES bugs(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, verification_id, bug_id)
    REFERENCES verifications(account_id, project_id, id, bug_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, close_event_id)
    REFERENCES events(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, baseline_build_id)
    REFERENCES builds(account_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, project_id, baseline_lineage_id, baseline_ordinal, baseline_build_id)
    REFERENCES build_lineage_entries(account_id, project_id, lineage_id, ordinal, build_id)
    ON DELETE RESTRICT,
  UNIQUE (account_id, project_id, close_event_id)
) STRICT;

CREATE TRIGGER bug_closure_acceptances_typed_insert_guard
BEFORE INSERT ON bug_closure_acceptances
WHEN NOT EXISTS (
  SELECT 1
  FROM bugs AS bug
  JOIN valid_human_bug_closures AS proof
    ON proof.account_id = bug.account_id
   AND proof.project_id = bug.project_id
   AND proof.bug_id = bug.id
  WHERE bug.account_id = new.account_id
    AND bug.project_id = new.project_id
    AND bug.id = new.bug_id
    AND bug.state = 'closed'
    AND bug.closed_at = new.closed_at
    AND bug.updated_at = new.created_at
    AND bug.version = new.closed_bug_version
    AND bug.reopen_count = new.closure_generation
    AND proof.verification_id = new.verification_id
    AND proof.close_event_id = new.close_event_id
    AND proof.close_event_position = new.close_event_position
    AND proof.actor_user_id = new.actor_user_id
    AND proof.closed_at = new.closed_at
    AND new.baseline_kind = CASE
      WHEN proof.verified_build_id IS NULL THEN 'no_build'
      WHEN proof.baseline_lineage_id IS NULL THEN 'unranked_build'
      ELSE 'verified_build'
    END
    AND new.baseline_build_id IS proof.verified_build_id
    AND new.baseline_lineage_id IS proof.baseline_lineage_id
    AND new.baseline_ordinal IS proof.baseline_ordinal
)
BEGIN
  SELECT RAISE(ABORT, 'Bug closure acceptance requires the exact current human closure proof');
END;

CREATE TRIGGER bugs_human_close_proof_guard
BEFORE UPDATE ON bugs
WHEN old.state <> 'closed' AND new.state = 'closed' AND NOT EXISTS (
  SELECT 1
  FROM valid_human_bug_closures AS proof
  WHERE proof.account_id = old.account_id
    AND proof.project_id = old.project_id
    AND proof.bug_id = old.id
    AND old.state = 'ready_for_verification'
    AND old.active_repair_attempt_id = proof.repair_attempt_id
    AND old.active_verification_id = proof.verification_id
    AND new.active_repair_attempt_id IS NULL
    AND new.active_verification_id IS NULL
    AND new.closed_at = proof.closed_at
    AND new.updated_at = proof.closed_at
    AND new.version = old.version + 1
    AND new.reopen_count = old.reopen_count
    AND proof.close_event_position > coalesce((
      SELECT max(previous.event_position)
      FROM events AS previous
      WHERE previous.account_id = old.account_id
        AND previous.project_id = old.project_id
        AND previous.bug_id = old.id
        AND previous.type = 'bug.reopen.newer_occurrence'
    ), 0)
    AND (
      proof.close_event_type <> 'bug.verification.passed'
      OR EXISTS (
        SELECT 1 FROM events AS generic_close
        WHERE generic_close.id = proof.close_event_id
          AND generic_close.resource_version_after = new.version
          AND json_extract(generic_close.payload_json, '$.fromVersion') = old.version
          AND json_extract(generic_close.payload_json, '$.toVersion') = new.version
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Bug closure requires current passed human Verification and typed audit proof');
END;

CREATE TRIGGER bugs_capture_closure_acceptance
AFTER UPDATE ON bugs
WHEN old.state <> 'closed' AND new.state = 'closed'
BEGIN
  INSERT INTO bug_closure_acceptances(
    account_id, project_id, bug_id, closure_generation, verification_id,
    close_event_id, close_event_position, actor_user_id, closed_bug_version,
    closed_at, baseline_kind, baseline_build_id, baseline_lineage_id,
    baseline_ordinal, created_at
  )
  SELECT proof.account_id, proof.project_id, proof.bug_id, new.reopen_count,
         proof.verification_id, proof.close_event_id, proof.close_event_position,
         proof.actor_user_id, new.version, new.closed_at,
         CASE
           WHEN proof.verified_build_id IS NULL THEN 'no_build'
           WHEN proof.baseline_lineage_id IS NULL THEN 'unranked_build'
           ELSE 'verified_build'
         END,
         proof.verified_build_id, proof.baseline_lineage_id, proof.baseline_ordinal,
         new.updated_at
  FROM valid_human_bug_closures AS proof
  WHERE proof.account_id = new.account_id
    AND proof.project_id = new.project_id
    AND proof.bug_id = new.id
    AND proof.verification_id = old.active_verification_id
    AND proof.repair_attempt_id = old.active_repair_attempt_id
    AND proof.closed_at = new.closed_at
  ORDER BY proof.close_event_position DESC
  LIMIT 1;
END;

CREATE TRIGGER bug_closure_acceptances_no_update
BEFORE UPDATE ON bug_closure_acceptances
BEGIN
  SELECT RAISE(ABORT, 'Bug closure acceptance facts are immutable');
END;

CREATE TRIGGER bug_closure_acceptances_no_delete
BEFORE DELETE ON bug_closure_acceptances
BEGIN
  SELECT RAISE(ABORT, 'Bug closure acceptance facts are append-only');
END;

CREATE TRIGGER bugs_newer_build_reopen_guard
BEFORE UPDATE ON bugs
WHEN old.state = 'closed' AND new.state = 'ready' AND NOT EXISTS (
  SELECT 1
  FROM bug_closure_acceptances AS closure
  JOIN occurrence_build_lineage_facts AS occurrence_fact
    ON occurrence_fact.account_id = closure.account_id
   AND occurrence_fact.project_id = closure.project_id
   AND occurrence_fact.bug_id = closure.bug_id
   AND occurrence_fact.lineage_id = closure.baseline_lineage_id
   AND occurrence_fact.ordinal > closure.baseline_ordinal
  JOIN occurrences AS occurrence
    ON occurrence.account_id = occurrence_fact.account_id
   AND occurrence.project_id = occurrence_fact.project_id
   AND occurrence.bug_id = occurrence_fact.bug_id
   AND occurrence.id = occurrence_fact.occurrence_id
   AND occurrence.build_id = occurrence_fact.build_id
  JOIN events AS append_event
    ON append_event.account_id = occurrence_fact.account_id
   AND append_event.project_id = occurrence_fact.project_id
   AND append_event.id = occurrence_fact.append_event_id
   AND append_event.event_position = occurrence_fact.append_event_position
  JOIN events AS reopen_event
    ON reopen_event.account_id = closure.account_id
   AND reopen_event.project_id = closure.project_id
   AND reopen_event.bug_id = closure.bug_id
  JOIN accounts AS current_account
    ON current_account.id = reopen_event.account_id
   AND current_account.status = 'active'
  JOIN projects AS current_project
    ON current_project.account_id = reopen_event.account_id
   AND current_project.id = reopen_event.project_id
   AND current_project.status = 'active'
  JOIN users AS current_actor
    ON current_actor.account_id = reopen_event.account_id
   AND current_actor.id = reopen_event.actor_user_id
   AND current_actor.status = 'active'
  JOIN memberships AS membership
    ON membership.account_id = reopen_event.account_id
   AND membership.project_id = reopen_event.project_id
   AND membership.user_id = reopen_event.actor_user_id
   AND membership.status = 'active'
  JOIN membership_roles AS role
    ON role.account_id = membership.account_id
   AND role.project_id = membership.project_id
   AND role.membership_id = membership.id
   AND role.role = 'triager'
  WHERE closure.account_id = old.account_id
    AND closure.project_id = old.project_id
    AND closure.bug_id = old.id
    AND closure.closure_generation = old.reopen_count
    AND closure.closed_at = old.closed_at
    AND closure.closed_bug_version <= old.version
    AND closure.baseline_kind = 'verified_build'
    AND occurrence_fact.append_event_position > closure.close_event_position
    AND occurrence.created_at > closure.closed_at
    AND append_event.type = 'occurrence.appended'
    AND append_event.resource_type = 'occurrence'
    AND append_event.resource_id = occurrence.id
    AND json_extract(append_event.payload_json, '$.occurrenceId') = occurrence.id
    AND reopen_event.type = 'bug.reopen.newer_occurrence'
    AND reopen_event.source = 'qa_hub'
    AND reopen_event.actor_type = 'user'
    AND reopen_event.request_digest IS NOT NULL
    AND reopen_event.aggregate_type = 'bug'
    AND reopen_event.aggregate_id = old.id
    AND reopen_event.resource_type = 'bug'
    AND reopen_event.resource_id = old.id
    AND reopen_event.resource_version_after = new.version
    AND reopen_event.from_state = 'closed'
    AND reopen_event.to_state = 'ready'
    AND reopen_event.event_position > occurrence_fact.append_event_position
    AND reopen_event.created_at = new.updated_at
    AND json_extract(reopen_event.payload_json, '$.status') = 'ready'
    AND json_extract(reopen_event.payload_json, '$.occurrenceId') = occurrence.id
    AND json_extract(reopen_event.payload_json, '$.fromVersion') = old.version
    AND json_extract(reopen_event.payload_json, '$.toVersion') = new.version
    AND new.version = old.version + 1
    AND new.reopen_count = old.reopen_count + 1
    AND new.closed_at IS NULL
    AND new.active_repair_attempt_id IS old.active_repair_attempt_id
    AND new.active_verification_id IS old.active_verification_id
    AND new.title IS old.title
    AND new.description IS old.description
    AND new.expected_behavior IS old.expected_behavior
    AND new.module_id IS old.module_id
    AND new.severity IS old.severity
    AND new.priority IS old.priority
    AND new.owner_id IS old.owner_id
    AND new.verification_owner_id IS old.verification_owner_id
    AND new.duplicate_of_bug_id IS old.duplicate_of_bug_id
    AND new.occurrence_count = old.occurrence_count
)
BEGIN
  SELECT RAISE(ABORT, 'Bug reopen requires a later same-lineage server-ranked Build occurrence');
END;

DROP TRIGGER events_payload_privacy_guard;
CREATE TRIGGER events_payload_privacy_guard
BEFORE INSERT ON events
WHEN json_type(new.payload_json) <> 'object'
  OR length(CAST(new.payload_json AS BLOB)) > 4096
  OR (
    SELECT count(*)
    FROM json_each(new.payload_json)
  ) <> (
    SELECT count(DISTINCT key)
    FROM json_each(new.payload_json)
  )
  OR EXISTS (
    SELECT 1 FROM json_each(new.payload_json)
    WHERE NOT (
      (
        key IN ('summary', 'reason')
        AND type = 'text'
        AND length(value) BETWEEN 1 AND 2000
      )
      OR (
        key = 'status'
        AND type = 'text'
        AND length(value) BETWEEN 1 AND 100
        AND value = lower(value)
        AND substr(value, 1, 1) GLOB '[a-z]'
        AND value NOT GLOB '*[^a-z0-9_]*'
      )
      OR (
        key IN (
          'relatedBugId', 'repairAttemptId', 'buildId', 'verificationId',
          'attachmentId', 'captureId', 'handoffId', 'commentId', 'occurrenceId'
        )
        AND type = 'text'
        AND length(value) = 36
        AND substr(value, 9, 1) = '-'
        AND substr(value, 14, 1) = '-'
        AND substr(value, 19, 1) = '-'
        AND substr(value, 24, 1) = '-'
        AND length(replace(value, '-', '')) = 32
        AND lower(replace(value, '-', '')) NOT GLOB '*[^0-9a-f]*'
        AND substr(value, 15, 1) GLOB '[1-8]'
        AND lower(substr(value, 20, 1)) GLOB '[89ab]'
      )
      OR (
        key = 'commitSha'
        AND type = 'text'
        AND length(value) = 40
        AND value = lower(value)
        AND value NOT GLOB '*[^0-9a-f]*'
      )
      OR (
        key = 'attachmentCount'
        AND type IN ('integer', 'real')
        AND value = CAST(value AS INTEGER)
        AND value BETWEEN 0 AND 20
      )
      OR (
        key IN ('fromVersion', 'toVersion')
        AND type IN ('integer', 'real')
        AND value = CAST(value AS INTEGER)
        AND value >= 1
      )
    )
  )
  OR EXISTS (
    SELECT 1 FROM json_each(new.payload_json)
    WHERE type = 'text'
      AND value <> '[REDACTED]'
      AND (
        lower(value) GLOB '*authorization*[:=]*'
        OR lower(value) LIKE '%bearer %'
        OR lower(value) GLOB '*password*[:=]*'
        OR lower(value) GLOB '*passwd*[:=]*'
        OR lower(value) GLOB '*pwd*[:=]*'
        OR lower(value) GLOB '*secret*[:=]*'
        OR lower(value) GLOB '*token*[:=]*'
        OR lower(value) GLOB '*cookie*[:=]*'
        OR lower(value) GLOB '*credential*[:=]*'
        OR lower(value) GLOB '*apikey*[:=]*'
        OR lower(value) GLOB '*api_key*[:=]*'
        OR lower(value) GLOB '*api-key*[:=]*'
        OR lower(value) GLOB '*api key*[:=]*'
        OR lower(value) GLOB '*private*key*[:=]*'
        OR lower(value) GLOB '*://*:*@*'
        OR lower(value) GLOB '*eyj????????*.*.*'
        OR instr(value, char(92)) > 0
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'event payload violates bounded redacted audit policy');
END;

DROP TRIGGER builds_lifecycle_guard;
CREATE TRIGGER builds_lifecycle_guard
BEFORE UPDATE ON builds
WHEN NOT (
  (
    old.status NOT IN ('ready', 'failed')
    AND new.version = old.version + 1
    AND new.updated_at > old.updated_at
    AND (
      new.status = old.status
      OR new.status = 'failed'
      OR (
        CASE new.status
          WHEN 'registered' THEN 0
          WHEN 'queued' THEN 1
          WHEN 'building' THEN 2
          WHEN 'validating' THEN 3
          WHEN 'publishing' THEN 4
          WHEN 'ready' THEN 5
          ELSE -1
        END
        >
        CASE old.status
          WHEN 'registered' THEN 0
          WHEN 'queued' THEN 1
          WHEN 'building' THEN 2
          WHEN 'validating' THEN 3
          WHEN 'publishing' THEN 4
          ELSE 99
        END
      )
    )
  )
  OR (
    old.status = 'ready'
    AND new.status = old.status
    AND new.artifact_sha256 IS old.artifact_sha256
    AND new.download_url IS old.download_url
    AND new.version = old.version + 1
    AND new.updated_at > old.updated_at
    AND EXISTS (
      SELECT 1
      FROM build_repair_links AS link
      JOIN events AS event
        ON event.account_id = link.account_id
       AND event.project_id = link.project_id
       AND event.id = link.evidence_audit_event_id
      WHERE link.account_id = old.account_id
        AND link.project_id = old.project_id
        AND link.build_id = old.id
        AND event.type = 'build.repair_linked'
        AND event.source = 'qa_hub'
        AND event.actor_type = 'user'
        AND event.actor_user_id = link.evidence_actor_id
        AND event.aggregate_type = 'repair_attempt'
        AND event.aggregate_id = link.repair_attempt_id
        AND event.resource_type = 'build_repair_link'
        AND event.resource_id = link.id
        AND json_extract(event.payload_json, '$.buildId') = old.id
        AND json_extract(event.payload_json, '$.repairAttemptId') = link.repair_attempt_id
        AND json_extract(event.payload_json, '$.status') = 'ready_for_verification'
        AND json_extract(event.payload_json, '$.commitSha') = link.delivered_commit_sha
        AND json_extract(event.payload_json, '$.fromVersion') = old.version
        AND json_extract(event.payload_json, '$.toVersion') = new.version
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Build lifecycle requires a forward CAS transition');
END;

DROP TRIGGER builds_linked_no_update;
CREATE TRIGGER builds_linked_no_update
BEFORE UPDATE ON builds
WHEN EXISTS (
  SELECT 1 FROM build_repair_links AS link
  WHERE link.account_id = old.account_id
    AND link.project_id = old.project_id
    AND link.build_id = old.id
)
AND NOT (
  old.status = 'ready'
  AND new.status = old.status
  AND new.artifact_sha256 IS old.artifact_sha256
  AND new.download_url IS old.download_url
  AND new.version = old.version + 1
  AND new.updated_at > old.updated_at
  AND EXISTS (
    SELECT 1
    FROM build_repair_links AS link
    JOIN events AS event
      ON event.account_id = link.account_id
     AND event.project_id = link.project_id
     AND event.id = link.evidence_audit_event_id
    WHERE link.account_id = old.account_id
      AND link.project_id = old.project_id
      AND link.build_id = old.id
      AND event.type = 'build.repair_linked'
      AND event.source = 'qa_hub'
      AND event.actor_type = 'user'
      AND event.actor_user_id = link.evidence_actor_id
      AND event.aggregate_type = 'repair_attempt'
      AND event.aggregate_id = link.repair_attempt_id
      AND event.resource_type = 'build_repair_link'
      AND event.resource_id = link.id
      AND json_extract(event.payload_json, '$.buildId') = old.id
      AND json_extract(event.payload_json, '$.repairAttemptId') = link.repair_attempt_id
      AND json_extract(event.payload_json, '$.status') = 'ready_for_verification'
      AND json_extract(event.payload_json, '$.commitSha') = link.delivered_commit_sha
      AND json_extract(event.payload_json, '$.fromVersion') = old.version
      AND json_extract(event.payload_json, '$.toVersion') = new.version
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Build facts referenced by a repair link are immutable');
END;
`;

const BROWSER_SESSION_SCHEMA_SQL = String.raw`
CREATE TABLE browser_sessions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  user_id TEXT NOT NULL CHECK (length(user_id) = 36),
  token_digest TEXT NOT NULL UNIQUE
    CHECK (length(token_digest) = 64 AND token_digest = lower(token_digest)),
  issued_at TEXT NOT NULL CHECK (length(issued_at) >= 20),
  expires_at TEXT NOT NULL
    CHECK (length(expires_at) >= 20 AND unixepoch(expires_at) > unixepoch(issued_at)),
  last_seen_at TEXT NOT NULL
    CHECK (
      length(last_seen_at) >= 20
      AND unixepoch(last_seen_at) >= unixepoch(issued_at)
      AND unixepoch(last_seen_at) <= unixepoch(expires_at)
    ),
  revoked_at TEXT,
  revoked_reason TEXT CHECK (revoked_reason IS NULL OR length(revoked_reason) BETWEEN 1 AND 200),
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  FOREIGN KEY (account_id, user_id)
    REFERENCES users(account_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, id),
  UNIQUE (account_id, id, user_id)
) STRICT;

CREATE INDEX browser_sessions_principal_active_idx
  ON browser_sessions(account_id, user_id, revoked_at, expires_at);

CREATE TRIGGER browser_sessions_initial_guard
BEFORE INSERT ON browser_sessions
WHEN new.version <> 1
  OR new.revoked_at IS NOT NULL
  OR new.revoked_reason IS NOT NULL
  OR new.last_seen_at IS NOT new.issued_at
  OR NOT EXISTS (
    SELECT 1
    FROM users AS user
    JOIN accounts AS account ON account.id = user.account_id
    WHERE user.account_id = new.account_id
      AND user.id = new.user_id
      AND user.status = 'active'
      AND account.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'browser session must start active and at version one');
END;

CREATE TRIGGER browser_sessions_transition_guard
BEFORE UPDATE ON browser_sessions
WHEN NOT (
  old.revoked_at IS NULL
  AND new.id IS old.id
  AND new.account_id IS old.account_id
  AND new.user_id IS old.user_id
  AND new.token_digest IS old.token_digest
  AND new.issued_at IS old.issued_at
  AND new.expires_at IS old.expires_at
  AND unixepoch(new.last_seen_at) >= unixepoch(old.last_seen_at)
  AND new.version = old.version + 1
  AND (
    (
      new.revoked_at IS NULL
      AND new.revoked_reason IS NULL
      AND unixepoch(new.last_seen_at) > unixepoch(old.last_seen_at)
    )
    OR (
      unixepoch(new.revoked_at) IS NOT NULL
      AND new.revoked_reason IS NOT NULL
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid browser session CAS transition or revoked-session resurrection');
END;

CREATE TRIGGER browser_sessions_no_delete
BEFORE DELETE ON browser_sessions
BEGIN
  SELECT RAISE(ABORT, 'browser session security history is append-only');
END;
`;

function extractSchemaBlock(source: string, start: string, next: string): string {
  const startIndex = source.indexOf(start);
  const nextIndex = source.indexOf(next, startIndex + start.length);
  if (startIndex < 0 || nextIndex < 0) {
    throw new Error(`SQLite migration source block is missing: ${start}`);
  }
  return source.slice(startIndex, nextIndex).trim();
}

function replaceSchemaFragment(
  source: string,
  search: string,
  replacement: string,
  label: string,
): string {
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`SQLite migration fragment must occur exactly once: ${label}`);
  }
  return source.replace(search, replacement);
}

function multiActorHumanWorkflowSql(): string {
  let submissionReceipt = extractSchemaBlock(
    CORE_SCHEMA_SQL,
    "CREATE TRIGGER submissions_exact_effect_insert",
    "CREATE TRIGGER submissions_no_update",
  );
  submissionReceipt = replaceSchemaFragment(
    submissionReceipt,
    "AND verification.verifier_id = new.actor_id",
    `AND (
          verification.verifier_id = new.actor_id
          OR EXISTS (
            SELECT 1 FROM bugs AS reporter_bug
            WHERE reporter_bug.account_id = verification.account_id
              AND reporter_bug.project_id = verification.project_id
              AND reporter_bug.id = verification.bug_id
              AND reporter_bug.reporter_id = new.actor_id
          )
        )`,
    "Verification result submission actor",
  );

  let bugState = extractSchemaBlock(
    DOMAIN_AUDIT_ALIGNMENT_SQL,
    "CREATE TRIGGER bugs_typed_state_transition_guard",
    "CREATE TRIGGER bugs_typed_same_state_pointer_guard",
  );
  bugState = replaceSchemaFragment(
    bugState,
    "old.state = 'ready_for_verification'\n          AND new.state = 'ready'\n          AND role.role = 'verifier'",
    "old.state = 'ready_for_verification'\n          AND new.state = 'ready'\n          AND role.role IN ('verifier', 'reporter')",
    "failed Verification Bug transition actor",
  );
  bugState = replaceSchemaFragment(
    bugState,
    "old.state = 'ready_for_verification'\n          AND new.state = 'closed'\n          AND role.role = 'verifier'",
    "old.state = 'ready_for_verification'\n          AND new.state = 'closed'\n          AND role.role IN ('verifier', 'reporter')",
    "passed Verification Bug transition actor",
  );
  bugState = replaceSchemaFragment(
    bugState,
    "AND verification.verifier_id = event.actor_user_id",
    "AND event.actor_user_id IN (verification.verifier_id, old.reporter_id)",
    "failed Verification Bug actor identity",
  );

  let bugPointers = extractSchemaBlock(
    DOMAIN_AUDIT_ALIGNMENT_SQL,
    "CREATE TRIGGER bugs_typed_same_state_pointer_guard",
    "CREATE TRIGGER repair_attempts_history_identity_immutable",
  );
  bugPointers = replaceSchemaFragment(
    bugPointers,
    "AND role.role = 'verifier'\n            AND event.type = 'verification.created'",
    "AND role.role IN ('verifier', 'triager')\n            AND event.type = 'verification.created'",
    "Verification creator pointer authority",
  );

  let attemptLifecycle = extractSchemaBlock(
    DOMAIN_AUDIT_ALIGNMENT_SQL,
    "CREATE TRIGGER repair_attempts_lifecycle_typed_guard",
    "CREATE TRIGGER repair_attempts_no_delete",
  );
  attemptLifecycle = replaceSchemaFragment(
    attemptLifecycle,
    "old.status = 'delivered'\n          AND new.status = 'verification_failed'\n          AND role.role = 'verifier'",
    "old.status = 'delivered'\n          AND new.status = 'verification_failed'\n          AND role.role IN ('verifier', 'reporter')",
    "verification-failed RepairAttempt actor",
  );
  attemptLifecycle = replaceSchemaFragment(
    attemptLifecycle,
    "AND verification.verifier_id = event.actor_user_id",
    `AND event.actor_user_id IN (
                verification.verifier_id,
                (SELECT reporter_id FROM bugs
                 WHERE account_id = new.account_id
                   AND project_id = new.project_id
                   AND id = new.bug_id)
              )`,
    "verification-failed RepairAttempt actor identity",
  );

  let verificationInitial = extractSchemaBlock(
    DOMAIN_AUDIT_ALIGNMENT_SQL,
    "CREATE TRIGGER verifications_initial_typed_guard",
    "CREATE TRIGGER verifications_typed_audit_guard",
  );
  verificationInitial = replaceSchemaFragment(
    verificationInitial,
    "AND role.role = 'verifier'",
    "AND role.role IN ('verifier', 'triager')",
    "Verification creator role",
  );

  let verificationAudit = extractSchemaBlock(
    DOMAIN_AUDIT_ALIGNMENT_SQL,
    "CREATE TRIGGER verifications_typed_audit_guard",
    "CREATE TRIGGER verifications_no_delete",
  );
  verificationAudit = replaceSchemaFragment(
    verificationAudit,
    "AND membership.user_id = new.verifier_id",
    "AND membership.user_id = event.actor_user_id",
    "Verification transition actor membership",
  );
  verificationAudit = replaceSchemaFragment(
    verificationAudit,
    "AND role.role = 'verifier'",
    "AND role.role IN ('verifier', 'reporter')",
    "Verification transition actor role",
  );
  verificationAudit = replaceSchemaFragment(
    verificationAudit,
    "    AND event.actor_user_id = new.verifier_id\n",
    "",
    "Verification transition assigned actor global guard",
  );
  verificationAudit = replaceSchemaFragment(
    verificationAudit,
    "AND event.type = 'verification.started'",
    "AND event.type = 'verification.started'\n        AND event.actor_user_id = new.verifier_id\n        AND role.role = 'verifier'",
    "Verification start assigned actor guard",
  );
  verificationAudit = replaceSchemaFragment(
    verificationAudit,
    "AND new.status IN ('passed', 'failed', 'blocked')\n        AND event.type = 'verification.result_recorded'",
    `AND new.status IN ('passed', 'failed', 'blocked')
        AND (
          (event.actor_user_id = new.verifier_id AND role.role = 'verifier')
          OR (
            role.role = 'reporter'
            AND event.actor_user_id = (
              SELECT reporter_id FROM bugs
              WHERE account_id = new.account_id
                AND project_id = new.project_id
                AND id = new.bug_id
            )
          )
        )
        AND event.type = 'verification.result_recorded'`,
    "Verification result actor guard",
  );

  let closureView = extractSchemaBlock(
    DOMAIN_AUDIT_ALIGNMENT_SQL,
    "CREATE VIEW valid_human_bug_closures AS",
    "CREATE TABLE bug_closure_acceptances",
  );
  closureView = replaceSchemaFragment(
    closureView,
    "AND role.role = 'verifier'",
    "AND role.role IN ('verifier', 'reporter')",
    "human closure actor role",
  );
  closureView = replaceSchemaFragment(
    closureView,
    "AND event.actor_user_id = verification.verifier_id",
    "AND event.actor_user_id IN (verification.verifier_id, current_bug.reporter_id)",
    "human closure actor identity",
  );

  return [
    "DROP TRIGGER submissions_exact_effect_insert;",
    "DROP TRIGGER bugs_typed_state_transition_guard;",
    "DROP TRIGGER bugs_typed_same_state_pointer_guard;",
    "DROP TRIGGER repair_attempts_lifecycle_typed_guard;",
    "DROP TRIGGER verifications_initial_typed_guard;",
    "DROP TRIGGER verifications_typed_audit_guard;",
    "DROP VIEW valid_human_bug_closures;",
    submissionReceipt,
    bugState,
    bugPointers,
    attemptLifecycle,
    verificationInitial,
    verificationAudit,
    closureView,
  ].join("\n\n");
}

const MULTI_ACTOR_HUMAN_WORKFLOW_SQL = multiActorHumanWorkflowSql();

function migration(version: number, name: string, sql: string): SqliteMigration {
  const normalizedSql = `${sql.trim()}\n`;
  return Object.freeze({
    version,
    name,
    sql: normalizedSql,
    checksum: createHash("sha256").update(normalizedSql).digest("hex"),
  });
}

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = Object.freeze([
  migration(1, "app_first_core", CORE_SCHEMA_SQL),
  migration(2, "bug_full_text_search", FTS_SCHEMA_SQL),
  migration(3, "domain_audit_alignment", DOMAIN_AUDIT_ALIGNMENT_SQL),
  migration(4, "browser_sessions", BROWSER_SESSION_SCHEMA_SQL),
  migration(5, "multi_actor_human_workflow", MULTI_ACTOR_HUMAN_WORKFLOW_SQL),
]);

export const SQLITE_SCHEMA_VERSION = SQLITE_MIGRATIONS.at(-1)?.version ?? 0;
