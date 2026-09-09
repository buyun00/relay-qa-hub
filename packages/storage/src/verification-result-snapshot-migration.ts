// A dedicated immutable result DTO can exceed the generic receipt's 64 KiB privacy limit.
// Every nested value is compared with its typed effect, not scanned as free-form text.
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
} as const;
const verificationFields = {
  id: "id",
  bugId: "bug_id",
  repairAttemptId: "repair_attempt_id",
  buildId: "build_id",
  status: "status",
  verifierId: "verifier_id",
  criteriaSnapshot: "criteria_snapshot",
  resultSummary: "result_summary",
  failureReason: "failure_reason",
  blockedReason: "blocked_reason",
  version: "version",
} as const;
const attemptFields = {
  parentAttemptId: "parent_attempt_id",
  targetBuildId: "target_build_id",
  id: "id",
  bugId: "bug_id",
  sequence: "sequence",
  mode: "mode",
  status: "status",
  assigneeId: "assignee_id",
  summary: "summary",
  branch: "branch",
  commitSha: "commit_sha",
  mergeRequestUrl: "merge_request_url",
  patchUrl: "patch_url",
  noCodeReason: "no_code_reason",
  failureReason: "failure_reason",
  version: "version",
} as const;
const shape = (path: string, fields: readonly string[]) => `
  json_type(new.response_json, '${path}') IS 'object'
  AND (SELECT count(*) FROM json_each(new.response_json, '${path}')) = ${fields.length}
  AND (SELECT count(DISTINCT key) FROM json_each(new.response_json, '${path}')) = ${fields.length}
  AND NOT EXISTS (SELECT 1 FROM json_each(new.response_json, '${path}')
    WHERE key NOT IN (${fields.map((key) => `'${key}'`).join(",")}))`;
const equalFields = (path: string, alias: string, fields: Record<string, string>) =>
  Object.entries(fields)
    .map(
      ([key, column]) => `json_extract(new.response_json, '${path}.${key}') IS ${alias}.${column}`,
    )
    .join("\n AND ");

export const VERIFICATION_RESULT_SNAPSHOT_SQL = `
CREATE TABLE verification_result_snapshots (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  bug_id TEXT NOT NULL,
  verification_id TEXT NOT NULL,
  client_submission_id TEXT CHECK(client_submission_id IS NULL OR length(client_submission_id)=36),
  operation_id TEXT NOT NULL CHECK(operation_id IN ('recordVerificationResult','recordLegacyVerificationResult')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 255),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  event_id TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json) AND length(CAST(response_json AS BLOB)) <= 1048576),
  created_at TEXT NOT NULL CHECK(unixepoch(created_at) IS NOT NULL),
  CHECK((operation_id='recordLegacyVerificationResult') = (client_submission_id IS NULL)),
  FOREIGN KEY(account_id,project_id,verification_id,bug_id) REFERENCES verifications(account_id,project_id,id,bug_id) ON DELETE RESTRICT,
  FOREIGN KEY(account_id,actor_id) REFERENCES users(account_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(account_id,project_id,event_id) REFERENCES events(account_id,project_id,id) ON DELETE RESTRICT,
  UNIQUE(account_id,project_id,actor_id,verification_id),
  UNIQUE(account_id,project_id,id)
) STRICT;

CREATE TRIGGER verification_result_snapshot_exact_effect BEFORE INSERT ON verification_result_snapshots
WHEN NOT (
  ${shape("$", ["clientSubmissionId", "qaItem", "verification", "repairAttempt", "bug", "attachmentIds", "captureBundleId", "eventId", "replayed"])}
  AND ${shape("$.qaItem", ["type", "id", "key"])}
  AND ${shape("$.bug", Object.keys(bugFields))}
  AND ${shape("$.verification", Object.keys(verificationFields))}
  AND ${shape("$.repairAttempt", Object.keys(attemptFields))}
  AND ${["bug.number", "bug.occurrenceCount", "bug.reopenCount", "bug.version", "verification.version", "repairAttempt.sequence", "repairAttempt.version"].map((path) => `json_type(new.response_json,'$.${path}') IS 'integer'`).join("\n AND ")}
  AND json_extract(new.response_json, '$.clientSubmissionId') IS new.client_submission_id
  AND json_type(new.response_json, '$.replayed') IS 'false'
  AND json_extract(new.response_json, '$.captureBundleId') IS NULL
  AND json_extract(new.response_json, '$.eventId') IS new.event_id
  AND EXISTS (
    SELECT 1 FROM verifications AS verification
    JOIN bugs AS bug ON bug.account_id=verification.account_id AND bug.project_id=verification.project_id AND bug.id=verification.bug_id
    JOIN repair_attempts AS attempt ON attempt.account_id=bug.account_id AND attempt.project_id=bug.project_id AND attempt.id=verification.repair_attempt_id
    JOIN events AS event ON event.account_id=bug.account_id AND event.project_id=bug.project_id AND event.id=new.event_id
    WHERE verification.account_id=new.account_id AND verification.project_id=new.project_id
      AND verification.id=new.verification_id AND verification.bug_id=new.bug_id
      AND verification.status IN ('passed','failed')
      AND event.type='verification.result_recorded' AND event.actor_type='user'
      AND event.actor_user_id=new.actor_id AND event.request_digest=new.request_digest
      AND event.resource_type='verification' AND event.resource_id=verification.id AND event.bug_id=new.bug_id AND event.resource_version_after=verification.version
      AND json_extract(new.response_json, '$.qaItem.type') IS 'bug'
      AND json_extract(new.response_json, '$.qaItem.id') IS bug.id
      AND json_extract(new.response_json, '$.qaItem.key') IS bug.key
      AND ${equalFields("$.bug", "bug", bugFields)}
      AND ${equalFields("$.verification", "verification", verificationFields)}
      AND ${equalFields("$.repairAttempt", "attempt", attemptFields)}
  )
  AND json_type(new.response_json,'$.attachmentIds') IS 'array'
  AND json_array_length(new.response_json,'$.attachmentIds') <= 8
  AND (SELECT count(DISTINCT value) FROM json_each(new.response_json,'$.attachmentIds')) = json_array_length(new.response_json,'$.attachmentIds')
  AND (SELECT count(*) FROM verification_attachments WHERE account_id=new.account_id AND project_id=new.project_id AND verification_id=new.verification_id) = json_array_length(new.response_json,'$.attachmentIds')
  AND NOT EXISTS (SELECT 1 FROM json_each(new.response_json,'$.attachmentIds') AS item WHERE NOT EXISTS (
    SELECT 1 FROM verification_attachments AS attachment WHERE attachment.account_id=new.account_id AND attachment.project_id=new.project_id AND attachment.verification_id=new.verification_id AND attachment.attachment_id=item.value))
  AND EXISTS (SELECT 1 FROM idempotency_records AS receipt WHERE receipt.account_id=new.account_id
    AND receipt.project_id=new.project_id AND receipt.actor_id=new.actor_id AND receipt.operation_id=new.operation_id
    AND receipt.idempotency_key=new.idempotency_key AND receipt.request_digest=new.request_digest AND receipt.status='reserved'
    AND json_extract(receipt.scope_json,'$.targetType')='verification' AND json_extract(receipt.scope_json,'$.targetId')=new.verification_id)
)
BEGIN SELECT RAISE(ABORT,'Verification result snapshot must match its exact typed effect and reserved receipt'); END;

CREATE TRIGGER verification_result_receipt_exact_snapshot BEFORE UPDATE ON idempotency_records
WHEN new.operation_id IN ('recordVerificationResult','recordLegacyVerificationResult') AND new.status='committed'
  AND NOT (
    ${shape("$", ["snapshotId", "clientSubmissionId", "projectId", "bugId", "occurrenceId", "commentId", "verificationId", "captureBundleId"])}
    AND json_type(new.response_json,'$.snapshotId') IS 'text'
    AND json_extract(new.response_json,'$.occurrenceId') IS NULL
    AND json_extract(new.response_json,'$.commentId') IS NULL
    AND json_extract(new.response_json,'$.captureBundleId') IS NULL
    AND EXISTS (SELECT 1 FROM verification_result_snapshots AS snapshot
    WHERE snapshot.id=json_extract(new.response_json,'$.snapshotId') AND snapshot.account_id=new.account_id
      AND snapshot.project_id=new.project_id AND snapshot.actor_id=new.actor_id AND snapshot.operation_id=new.operation_id
      AND snapshot.idempotency_key=new.idempotency_key AND snapshot.request_digest=new.request_digest
      AND snapshot.event_id=new.audit_event_id AND snapshot.verification_id=json_extract(new.scope_json,'$.targetId')
      AND snapshot.client_submission_id IS json_extract(new.response_json,'$.clientSubmissionId')
      AND snapshot.project_id IS json_extract(new.response_json,'$.projectId')
      AND snapshot.bug_id IS json_extract(new.response_json,'$.bugId')
      AND snapshot.verification_id IS json_extract(new.response_json,'$.verificationId')))
BEGIN SELECT RAISE(ABORT,'Verification receipt must bind its original result snapshot'); END;

CREATE TRIGGER verification_result_snapshots_no_update BEFORE UPDATE ON verification_result_snapshots
BEGIN SELECT RAISE(ABORT,'Verification result snapshots are immutable'); END;
CREATE TRIGGER verification_result_snapshots_no_delete BEFORE DELETE ON verification_result_snapshots
BEGIN SELECT RAISE(ABORT,'Verification result snapshots are append-only'); END;
`;
