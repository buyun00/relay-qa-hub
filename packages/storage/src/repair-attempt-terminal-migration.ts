/** Candidate additive migration; registration/version assignment belongs to the integrator. */
const bugFields = {
  id: "id",
  projectId: "project_id",
  number: "number",
  key: "key",
  title: "title",
  description: "description",
  expectedBehavior: "expected_behavior",
  moduleId: "module_id",
  state: "state",
  severity: "severity",
  priority: "priority",
  reporterId: "reporter_id",
  ownerId: "owner_id",
  verificationOwnerId: "verification_owner_id",
  duplicateOfBugId: "duplicate_of_bug_id",
  occurrenceCount: "occurrence_count",
  reopenCount: "reopen_count",
  version: "version",
  createdAt: "created_at",
  updatedAt: "updated_at",
  closedAt: "closed_at",
};
const attemptFields = {
  id: "id",
  bugId: "bug_id",
  sequence: "sequence",
  mode: "mode",
  status: "status",
  assigneeId: "assignee_id",
  parentAttemptId: "parent_attempt_id",
  summary: "summary",
  branch: "branch",
  commitSha: "commit_sha",
  mergeRequestUrl: "merge_request_url",
  patchUrl: "patch_url",
  noCodeReason: "no_code_reason",
  failureReason: "failure_reason",
  targetBuildId: "target_build_id",
  version: "version",
};
const shape = (jsonPath: string, fields: readonly string[], document = "new.response_json") => `
  json_type(${document},'${jsonPath}') IS 'object'
  AND (SELECT count(*) FROM json_each(${document},'${jsonPath}'))=${fields.length}
  AND (SELECT count(DISTINCT key) FROM json_each(${document},'${jsonPath}'))=${fields.length}
  AND NOT EXISTS(SELECT 1 FROM json_each(${document},'${jsonPath}')
    WHERE key NOT IN (${fields.map((field) => `'${field}'`).join(",")}))`;
const fieldsEqual = (jsonPath: string, alias: string, fields: Record<string, string>) =>
  Object.entries(fields)
    .map(
      ([field, column]) =>
        `json_extract(new.response_json,'${jsonPath}.${field}') IS ${alias}.${column}`,
    )
    .join("\n AND ");
const reasonMatches = `(json_extract(event.payload_json,'$.reason') IS new.reason
  OR (length(CAST(new.reason AS BLOB))>2000
    AND length(CAST(json_extract(event.payload_json,'$.reason') AS BLOB))<=2000
    AND substr(json_extract(event.payload_json,'$.reason'),-1,1)='…'
    AND json_extract(event.payload_json,'$.reason')
      =substr(new.reason,1,length(json_extract(event.payload_json,'$.reason'))-1)||'…'
    AND length(CAST(substr(new.reason,1,length(json_extract(event.payload_json,'$.reason')))||'…' AS BLOB))>2000)
  OR (json_extract(event.payload_json,'$.reason')='[REDACTED]' AND (
    ${["authorization", "password", "passwd", "pwd", "secret", "token", "cookie", "credential", "apikey", "api_key", "api-key", "api key", "private*key"].map((word) => `lower(new.reason) GLOB '*${word}*[:=]*'`).join(" OR ")}
    OR lower(new.reason) LIKE '%bearer %' OR lower(new.reason) GLOB '*://*:*@*'
    OR lower(new.reason) GLOB '*eyj????????*.*.*' OR instr(new.reason,char(92))>0)))`;

export const REPAIR_ATTEMPT_TERMINAL_SNAPSHOT_SQL = `
CREATE TABLE repair_attempt_terminal_snapshots (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  account_id TEXT NOT NULL, project_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  bug_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK(operation_id IN ('failRepairAttempt','supersedeRepairAttempt')),
  representation TEXT NOT NULL CHECK(representation IN ('legacy-1.0','vendor-1.1')),
  response_media TEXT NOT NULL CHECK(response_media IN ('application/json','application/vnd.relay-qa-hub.v1.1+json')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 5000 AND length(trim(reason))>0),
  event_id TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json) AND length(CAST(response_json AS BLOB))<=1048576),
  created_at TEXT NOT NULL CHECK(unixepoch(created_at) IS NOT NULL),
  UNIQUE(account_id,project_id,attempt_id),
  FOREIGN KEY(account_id,project_id,attempt_id,bug_id) REFERENCES repair_attempts(account_id,project_id,id,bug_id) ON DELETE RESTRICT,
  FOREIGN KEY(account_id,actor_id) REFERENCES users(account_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(account_id,project_id,event_id) REFERENCES events(account_id,project_id,id) ON DELETE RESTRICT
) STRICT;
CREATE TRIGGER repair_attempt_terminal_snapshot_exact BEFORE INSERT ON repair_attempt_terminal_snapshots
WHEN NOT (
  ${shape("$", ["representation", "responseMedia", "reason", "attempt", "successor", "bug", "eventId", "replayed"])}
  AND ${shape("$.attempt", Object.keys(attemptFields))}
  AND ${shape("$.bug", Object.keys(bugFields))}
  AND json_extract(new.response_json,'$.representation') IS new.representation
  AND json_extract(new.response_json,'$.responseMedia') IS new.response_media
  AND json_extract(new.response_json,'$.reason') IS new.reason
  AND json_extract(new.response_json,'$.eventId') IS new.event_id
  AND json_type(new.response_json,'$.replayed') IS 'false'
  AND EXISTS (
    SELECT 1 FROM repair_attempts AS attempt
    JOIN bugs AS bug ON bug.account_id=attempt.account_id AND bug.project_id=attempt.project_id AND bug.id=attempt.bug_id
    JOIN events AS event ON event.account_id=bug.account_id AND event.project_id=bug.project_id AND event.id=new.event_id
    WHERE attempt.account_id=new.account_id AND attempt.project_id=new.project_id AND attempt.id=new.attempt_id
      AND attempt.bug_id=new.bug_id AND attempt.updated_at=new.created_at AND bug.updated_at=new.created_at
      AND event.actor_type='user' AND event.actor_user_id=new.actor_id AND event.source='qa_hub'
      AND event.request_digest=new.request_digest AND event.created_at=new.created_at
      AND event.aggregate_type='repair_attempt' AND event.aggregate_id=attempt.id
      AND event.resource_type='repair_attempt' AND event.resource_id=attempt.id
      AND event.resource_version_after=attempt.version AND event.bug_id=bug.id
      AND event.type=CASE new.operation_id WHEN 'failRepairAttempt' THEN 'repair_attempt.failed' ELSE 'repair_attempt.superseded' END
      AND event.from_state IS CASE
        WHEN new.operation_id='failRepairAttempt' OR new.representation='legacy-1.0' THEN 'in_progress'
        ELSE NULL END
      AND event.to_state IS CASE
        WHEN new.operation_id='failRepairAttempt' OR new.representation='legacy-1.0' THEN 'ready'
        ELSE NULL END
      AND ${shape(
        "$",
        ["status", "repairAttemptId", "reason", "fromVersion", "toVersion"],
        "event.payload_json",
      )}
      AND json_extract(event.payload_json,'$.status')=attempt.status
      AND json_extract(event.payload_json,'$.repairAttemptId')=attempt.id
      AND ${reasonMatches}
      AND json_extract(event.payload_json,'$.fromVersion')=attempt.version-1
      AND json_extract(event.payload_json,'$.toVersion')=attempt.version
      AND attempt.status=CASE new.operation_id WHEN 'failRepairAttempt' THEN 'failed' ELSE 'superseded' END
      AND ${fieldsEqual("$.attempt", "attempt", attemptFields)}
      AND ${fieldsEqual("$.bug", "bug", bugFields)}
      AND (new.operation_id<>'failRepairAttempt' OR attempt.failure_reason IS new.reason)
      AND (
        (json_type(new.response_json,'$.successor') IS 'null' AND bug.state='ready'
          AND bug.active_repair_attempt_id IS NULL AND bug.active_verification_id IS NULL
          AND (new.operation_id='failRepairAttempt' OR new.representation='legacy-1.0'))
        OR (new.operation_id='supersedeRepairAttempt' AND new.representation='vendor-1.1'
          AND bug.state='in_progress' AND bug.active_verification_id IS NULL
          AND ${shape("$.successor", Object.keys(attemptFields))}
          AND EXISTS (SELECT 1 FROM repair_attempts AS successor
            WHERE successor.account_id=attempt.account_id AND successor.project_id=attempt.project_id
              AND successor.bug_id=bug.id AND successor.id=bug.active_repair_attempt_id
              AND successor.parent_attempt_id=attempt.id AND successor.status='planned' AND successor.version=1
              AND successor.created_at=new.created_at AND ${fieldsEqual("$.successor", "successor", attemptFields)}))
      )
  )
  AND EXISTS (SELECT 1 FROM idempotency_records AS receipt
    WHERE receipt.account_id=new.account_id AND receipt.project_id=new.project_id AND receipt.actor_id=new.actor_id
      AND receipt.operation_id=new.operation_id AND receipt.idempotency_key=new.idempotency_key
      AND receipt.request_digest=new.request_digest AND receipt.status='reserved'
      AND json_extract(receipt.scope_json,'$.targetType')='repair_attempt'
      AND json_extract(receipt.scope_json,'$.targetId')=new.attempt_id)
)
BEGIN SELECT RAISE(ABORT,'Terminal RepairAttempt snapshot must match its typed effect and reserved receipt'); END;
CREATE TRIGGER repair_attempt_terminal_receipt_exact BEFORE UPDATE ON idempotency_records
WHEN new.operation_id IN ('failRepairAttempt','supersedeRepairAttempt') AND new.status='committed'
  AND NOT (
    ${shape("$", ["snapshotId"])}
    AND EXISTS (SELECT 1 FROM repair_attempt_terminal_snapshots AS snapshot
      WHERE snapshot.id=json_extract(new.response_json,'$.snapshotId')
        AND snapshot.account_id=new.account_id AND snapshot.project_id=new.project_id
        AND snapshot.actor_id=new.actor_id AND snapshot.operation_id=new.operation_id
        AND snapshot.idempotency_key=new.idempotency_key AND snapshot.request_digest=new.request_digest
        AND snapshot.event_id=new.audit_event_id
        AND snapshot.attempt_id=json_extract(new.scope_json,'$.targetId')
        AND json_extract(new.scope_json,'$.targetType')='repair_attempt')
  )
BEGIN SELECT RAISE(ABORT,'Terminal RepairAttempt receipt must reference its immutable snapshot'); END;
CREATE TRIGGER repair_attempt_terminal_snapshot_no_update BEFORE UPDATE ON repair_attempt_terminal_snapshots
BEGIN SELECT RAISE(ABORT,'Terminal RepairAttempt snapshots are immutable'); END;
CREATE TRIGGER repair_attempt_terminal_snapshot_no_delete BEFORE DELETE ON repair_attempt_terminal_snapshots
BEGIN SELECT RAISE(ABORT,'Terminal RepairAttempt snapshots are retained'); END;

CREATE TABLE repair_attempt_parent_plan_snapshots (
  id TEXT PRIMARY KEY CHECK(length(id)=36), account_id TEXT NOT NULL, project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, bug_id TEXT NOT NULL, attempt_id TEXT NOT NULL, parent_attempt_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL, event_id TEXT NOT NULL,
  response_media TEXT NOT NULL CHECK(response_media IN ('application/json','application/vnd.relay-qa-hub.v1.1+json')),
  response_json TEXT NOT NULL CHECK(json_valid(response_json) AND length(CAST(response_json AS BLOB))<=262144),
  UNIQUE(account_id,project_id,attempt_id),
  FOREIGN KEY(account_id,project_id,attempt_id,bug_id) REFERENCES repair_attempts(account_id,project_id,id,bug_id),
  FOREIGN KEY(account_id,project_id,parent_attempt_id,bug_id) REFERENCES repair_attempts(account_id,project_id,id,bug_id),
  FOREIGN KEY(account_id,actor_id) REFERENCES users(account_id,id),
  FOREIGN KEY(account_id,project_id,event_id) REFERENCES events(account_id,project_id,id)
) STRICT;
CREATE TRIGGER repair_attempt_parent_plan_exact BEFORE INSERT ON repair_attempt_parent_plan_snapshots
WHEN NOT (
  ${shape("$", Object.keys(attemptFields))}
  AND EXISTS (SELECT 1 FROM repair_attempts AS attempt
    JOIN bugs AS bug ON bug.account_id=attempt.account_id AND bug.project_id=attempt.project_id AND bug.id=attempt.bug_id
    JOIN events AS event ON event.account_id=bug.account_id AND event.project_id=bug.project_id AND event.id=new.event_id
    JOIN repair_attempts AS parent_attempt ON parent_attempt.account_id=attempt.account_id
      AND parent_attempt.project_id=attempt.project_id AND parent_attempt.id=attempt.parent_attempt_id
      AND parent_attempt.bug_id=attempt.bug_id
    JOIN repair_attempt_terminal_snapshots AS parent ON parent.account_id=attempt.account_id
      AND parent.project_id=attempt.project_id AND parent.attempt_id=attempt.parent_attempt_id AND parent.bug_id=attempt.bug_id
    WHERE attempt.account_id=new.account_id AND attempt.project_id=new.project_id AND attempt.id=new.attempt_id
      AND attempt.parent_attempt_id=new.parent_attempt_id AND attempt.bug_id=new.bug_id
      AND parent.operation_id='supersedeRepairAttempt' AND parent.representation='legacy-1.0'
      AND parent_attempt.status='superseded' AND attempt.sequence=parent_attempt.sequence+1
      AND attempt.sequence=(SELECT MAX(sequence) FROM repair_attempts
        WHERE account_id=attempt.account_id AND project_id=attempt.project_id AND bug_id=attempt.bug_id)
      AND attempt.status='planned' AND attempt.version=1 AND bug.state='in_progress' AND bug.active_repair_attempt_id=attempt.id
      AND event.type='repair_attempt.created' AND event.source='qa_hub'
      AND event.actor_user_id=new.actor_id AND event.actor_type='user' AND event.bug_id=bug.id
      AND event.aggregate_type='repair_attempt' AND event.aggregate_id=attempt.id AND event.aggregate_sequence=1
      AND event.resource_type='repair_attempt' AND event.resource_id=attempt.id AND event.resource_version_after=1
      AND event.from_state='ready' AND event.to_state='in_progress'
      AND event.request_digest=new.request_digest AND event.aggregate_id=attempt.id AND event.resource_id=attempt.id
      AND event.resource_version_after=1 AND event.created_at=attempt.created_at AND event.created_at=bug.updated_at
      AND ${shape(
        "$",
        ["status", "repairAttemptId", "fromVersion", "toVersion"],
        "event.payload_json",
      )}
      AND json_extract(event.payload_json,'$.status')='planned'
      AND json_extract(event.payload_json,'$.repairAttemptId')=attempt.id
      AND json_extract(event.payload_json,'$.fromVersion')=bug.version-1
      AND json_extract(event.payload_json,'$.toVersion')=bug.version
      AND ${fieldsEqual("$", "attempt", attemptFields)})
  AND EXISTS (SELECT 1 FROM idempotency_records AS receipt WHERE receipt.account_id=new.account_id
    AND receipt.project_id=new.project_id AND receipt.actor_id=new.actor_id AND receipt.operation_id='createManualRepairAttempt'
    AND receipt.idempotency_key=new.idempotency_key AND receipt.request_digest=new.request_digest AND receipt.status='reserved'
    AND json_extract(receipt.scope_json,'$.targetType')='bug' AND json_extract(receipt.scope_json,'$.targetId')=new.bug_id)
)
BEGIN SELECT RAISE(ABORT,'Parented plan snapshot must match its typed creation'); END;
CREATE TRIGGER repair_attempt_parent_plan_receipt BEFORE UPDATE ON idempotency_records
WHEN new.operation_id='createManualRepairAttempt' AND new.status='committed'
  AND json_type(new.response_json,'$.snapshotId') IS NOT NULL AND NOT (
    ${shape("$", ["snapshotId"])} AND EXISTS (SELECT 1 FROM repair_attempt_parent_plan_snapshots AS snapshot
      WHERE snapshot.id=json_extract(new.response_json,'$.snapshotId') AND snapshot.account_id=new.account_id
        AND snapshot.project_id=new.project_id AND snapshot.actor_id=new.actor_id
        AND snapshot.idempotency_key=new.idempotency_key AND snapshot.request_digest=new.request_digest
        AND snapshot.event_id=new.audit_event_id AND snapshot.bug_id=json_extract(new.scope_json,'$.targetId')))
BEGIN SELECT RAISE(ABORT,'Parented plan receipt must match its immutable snapshot'); END;
CREATE TRIGGER repair_attempt_parent_plan_no_update BEFORE UPDATE ON repair_attempt_parent_plan_snapshots
BEGIN SELECT RAISE(ABORT,'Parented plan snapshots are immutable'); END;
CREATE TRIGGER repair_attempt_parent_plan_no_delete BEFORE DELETE ON repair_attempt_parent_plan_snapshots
BEGIN SELECT RAISE(ABORT,'Parented plan snapshots are retained'); END;
`;
