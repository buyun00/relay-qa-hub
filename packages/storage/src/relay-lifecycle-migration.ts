/** Forward-only extensions: Relay proves delivery; people still decide acceptance. */
export function relayLifecycleMigration(schema: string): string {
  const block = (name: string, kind = "TRIGGER") => {
    const start = schema.lastIndexOf(`CREATE ${kind} ${name}`);
    if (start < 0) throw new Error(`Missing lifecycle schema ${name}`);
    const end = schema.indexOf(kind === "TRIGGER" ? "\nEND;" : ";", start);
    return schema.slice(start, end + (kind === "TRIGGER" ? 5 : 1));
  };
  const replace = (sql: string, from: string, to: string) => {
    if (!sql.includes(from)) throw new Error(`Missing lifecycle fragment: ${from}`);
    return sql.replace(from, to);
  };
  const extraGuard = (name: string, proof: string) =>
    `DROP TRIGGER ${name};\n` + replace(block(name), "\nBEGIN\n", `\nAND NOT (${proof})\nBEGIN\n`);
  const deliveryMatch = (attempt: string) => `EXISTS (
    SELECT 1 FROM valid_relay_deliveries AS delivery
    WHERE delivery.account_id = ${attempt}.account_id
      AND delivery.project_id = ${attempt}.project_id
      AND delivery.bug_id = ${attempt}.bug_id
      AND delivery.attempt_id = ${attempt}.id
      AND delivery.commit_sha = ${attempt}.commit_sha
      AND delivery.branch = ${attempt}.branch
  )`;
  const serviceEvent = (type: string, version: string) => `EXISTS (
    SELECT 1 FROM events AS event JOIN valid_relay_deliveries AS delivery
      ON delivery.account_id = event.account_id AND delivery.project_id = event.project_id
     AND delivery.attempt_id = event.aggregate_id AND delivery.bug_id = event.bug_id
    WHERE event.account_id = new.account_id AND event.project_id = new.project_id
      AND event.aggregate_type = 'repair_attempt' AND event.aggregate_id = new.id
      AND event.source = 'qa_hub' AND event.actor_type = 'service'
      AND event.actor_service_principal_id = delivery.principal_id
      AND event.type = '${type}' AND event.resource_type = 'repair_attempt'
      AND event.resource_id = new.id AND event.resource_version_after = ${version}
      AND event.created_at = new.updated_at AND event.request_digest = delivery.payload_digest
      AND json_extract(event.payload_json, '$.repairAttemptId') = new.id
      AND json_extract(event.payload_json, '$.status') = new.status
      AND json_extract(event.payload_json, '$.fromVersion') = old.version
      AND json_extract(event.payload_json, '$.toVersion') = new.version
      AND event.from_state IS NULL AND event.to_state IS NULL
      AND (${version} = 2 OR json_extract(event.payload_json, '$.commitSha') = new.commit_sha)
  )`;
  const immutableDelivery = [
    "summary",
    "branch",
    "commit_sha",
    "merge_request_url",
    "patch_url",
    "no_code_reason",
    "target_build_id",
    "failure_reason",
  ]
    .map((field) => `new.${field} IS old.${field}`)
    .join(" AND ");
  const retryAuthority = `EXISTS (
    SELECT 1 FROM relay_rework_requests AS rework
    JOIN verifications AS verification ON verification.id = rework.verification_id
      AND verification.account_id = rework.account_id AND verification.project_id = rework.project_id
    WHERE rework.account_id = event.account_id AND rework.project_id = event.project_id
      AND rework.bug_id = event.bug_id AND rework.actor_id = event.actor_user_id
      AND rework.status = 'pending' AND verification.status = 'failed'
      AND verification.bug_id = rework.bug_id
      AND verification.repair_attempt_id = rework.previous_attempt_id
      AND event.request_digest = rework.request_digest
  )`;
  let initial = block("repair_attempts_initial_typed_guard");
  initial = replace(
    initial,
    "AND role.role IN ('developer', 'triager')",
    `AND (role.role IN ('developer', 'triager') OR (new.mode = 'relay' AND ${retryAuthority}))`,
  );
  let state = block("bugs_typed_state_transition_guard");
  state = replace(
    state,
    "AND role.role IN ('developer', 'triager')",
    `AND (role.role IN ('developer', 'triager') OR ${retryAuthority})`,
  );
  state = replace(
    state,
    "\nBEGIN\n",
    `
AND NOT (
  old.state = 'in_progress' AND new.state = 'ready_for_verification'
  AND new.version = old.version + 1 AND new.updated_at > old.updated_at
  AND new.active_repair_attempt_id IS old.active_repair_attempt_id
  AND new.active_verification_id IS old.active_verification_id
  AND new.duplicate_of_bug_id IS old.duplicate_of_bug_id
  AND new.closed_at IS old.closed_at AND new.reopen_count = old.reopen_count
  AND ${["title", "description", "expected_behavior", "module_id", "severity", "priority", "owner_id", "verification_owner_id", "occurrence_count"].map((field) => `new.${field} IS old.${field}`).join(" AND ")}
  AND EXISTS (
    SELECT 1 FROM repair_attempts AS attempt JOIN events AS event
      ON event.account_id = attempt.account_id AND event.project_id = attempt.project_id
     AND event.aggregate_type = 'repair_attempt' AND event.aggregate_id = attempt.id
    JOIN valid_relay_deliveries AS delivery ON delivery.account_id = attempt.account_id
      AND delivery.project_id = attempt.project_id AND delivery.attempt_id = attempt.id
    WHERE attempt.account_id = new.account_id AND attempt.project_id = new.project_id
      AND attempt.bug_id = new.id AND attempt.id = old.active_repair_attempt_id
      AND attempt.mode = 'relay' AND attempt.status = 'delivered' AND attempt.version = 3
      AND attempt.commit_sha = delivery.commit_sha AND attempt.branch = delivery.branch
      AND event.source = 'qa_hub' AND event.actor_type = 'service'
      AND event.actor_service_principal_id = delivery.principal_id
      AND event.type = 'repair_attempt.delivered' AND event.resource_type = 'repair_attempt'
      AND event.resource_id = attempt.id AND event.resource_version_after = 3
      AND event.from_state IS NULL AND event.to_state IS NULL
      AND event.request_digest = delivery.payload_digest AND event.created_at = new.updated_at
      AND attempt.updated_at = new.updated_at
  )
)
BEGIN
`,
  );
  let closure = block("valid_human_bug_closures", "VIEW");
  closure = replace(
    closure,
    "JOIN build_requirements AS requirement",
    "LEFT JOIN build_requirements AS requirement",
  );
  closure = replace(
    closure,
    "      requirement.requirement = 'not_required'",
    `      (attempt.mode = 'relay' AND verification.build_id IS NULL AND ${deliveryMatch("attempt")})
    ) OR (
      requirement.requirement = 'not_required'`,
  );
  const verificationProof = `new.build_id IS NULL AND EXISTS (
    SELECT 1 FROM repair_attempts AS attempt
    WHERE attempt.account_id = new.account_id AND attempt.project_id = new.project_id
      AND attempt.bug_id = new.bug_id AND attempt.id = new.repair_attempt_id
      AND attempt.mode = 'relay' AND attempt.status = 'delivered' AND attempt.version = 3
      AND ${deliveryMatch("attempt")}
  )`;
  return [
    String.raw`
CREATE VIEW valid_relay_deliveries AS
SELECT receipt.account_id, receipt.project_id, receipt.bug_id,
       receipt.repair_attempt_id AS attempt_id, receipt.handoff_id, receipt.relay_instance_id,
       receipt.relay_task_id, inbox.id AS inbox_id, inbox.payload_digest, inbox.received_at,
       principal.id AS principal_id,
       json_extract(inbox.payload_json, '$.payload.deliveryEvidence.branch') AS branch,
       json_extract(inbox.payload_json, '$.payload.deliveryEvidence.commitSha') AS commit_sha,
       json_extract(inbox.payload_json, '$.payload.deliveryEvidence.mergeRequestUrl') AS merge_request_url
FROM relay_receipts AS receipt
JOIN integration_links AS link ON link.id = receipt.integration_link_id
 AND link.account_id = receipt.account_id AND link.project_id = receipt.project_id
 AND link.integration_type = 'relay'
 AND link.local_resource_type = 'repair_attempt' AND link.local_resource_id = receipt.repair_attempt_id
 AND link.external_resource_type = 'relay_handoff' AND link.external_resource_id = receipt.handoff_id
 AND json_extract(link.metadata_json, '$.relayInstanceId') = receipt.relay_instance_id
JOIN service_principals AS principal ON principal.account_id = receipt.account_id
 AND principal.id = json_extract(link.metadata_json, '$.relayPrincipalId')
 AND principal.principal_type = 'relay'
JOIN accounts AS account ON account.id = receipt.account_id AND account.status = 'active'
JOIN projects AS project ON project.account_id = receipt.account_id
 AND project.id = receipt.project_id AND project.status = 'active'
JOIN inbox ON inbox.account_id = receipt.account_id AND inbox.project_id = receipt.project_id
 AND inbox.aggregate_id = receipt.repair_attempt_id AND inbox.source = 'relay'
 AND inbox.source_instance_id = receipt.relay_instance_id AND inbox.status = 'applied'
 AND inbox.event_type = 'fix_delivered'
WHERE json_extract(inbox.payload_json, '$.attemptId') = receipt.repair_attempt_id
 AND json_extract(inbox.payload_json, '$.handoffId') = receipt.handoff_id
 AND json_extract(inbox.payload_json, '$.relayInstanceId') = receipt.relay_instance_id
 AND json_extract(inbox.payload_json, '$.payload.taskId') = receipt.relay_task_id
 AND json_extract(inbox.payload_json, '$.payload.deliveryEvidence.pushed') = 1
 AND json_extract(inbox.payload_json, '$.payload.deliveryEvidence.verified') = 1
 AND length(json_extract(inbox.payload_json, '$.payload.deliveryEvidence.branch')) > 0
 AND length(json_extract(inbox.payload_json, '$.payload.deliveryEvidence.commitSha')) = 40
 AND json_extract(inbox.payload_json, '$.payload.deliveryEvidence.commitSha') NOT GLOB '*[^0-9a-f]*'
 AND json_extract(inbox.payload_json, '$.payload.deliveryEvidence.commitSha')
   = json_extract(inbox.payload_json, '$.payload.deliveryEvidence.remoteSha');

CREATE TABLE relay_rework_requests (
  verification_id TEXT PRIMARY KEY REFERENCES verifications(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL, project_id TEXT NOT NULL, bug_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, previous_attempt_id TEXT NOT NULL,
  expected_bug_version INTEGER NOT NULL, request_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','queued','blocked')),
  next_attempt_at TEXT NOT NULL, attempt_id TEXT, handoff_id TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(account_id,project_id,bug_id) REFERENCES bugs(account_id,project_id,id),
  FOREIGN KEY(account_id,actor_id) REFERENCES users(account_id,id),
  FOREIGN KEY(account_id,project_id,previous_attempt_id) REFERENCES repair_attempts(account_id,project_id,id)
) STRICT;
CREATE INDEX relay_rework_requests_due ON relay_rework_requests(status,next_attempt_at);
CREATE INDEX relay_rework_requests_bug ON relay_rework_requests(account_id,project_id,bug_id,created_at);
CREATE TRIGGER relay_projection_event_guard BEFORE INSERT ON events
WHEN new.source='qa_hub' AND new.actor_type='service'
 AND new.type IN ('repair_attempt.started','repair_attempt.delivered') AND NOT EXISTS (
   SELECT 1 FROM valid_relay_deliveries AS delivery JOIN repair_attempts AS attempt ON attempt.id=delivery.attempt_id
   JOIN bugs AS bug ON bug.id=delivery.bug_id AND bug.active_repair_attempt_id=attempt.id
   WHERE delivery.account_id=new.account_id AND delivery.project_id=new.project_id
     AND EXISTS (SELECT 1 FROM service_principals WHERE id=delivery.principal_id AND status='active')
     AND delivery.attempt_id=new.aggregate_id AND new.aggregate_type='repair_attempt'
     AND new.resource_type='repair_attempt' AND new.resource_id=attempt.id AND new.bug_id=bug.id
     AND new.actor_service_principal_id=delivery.principal_id AND new.request_digest=delivery.payload_digest
     AND attempt.mode='relay' AND bug.state='in_progress'
     AND new.resource_version_after=attempt.version+1
     AND json_extract(new.payload_json,'$.repairAttemptId')=attempt.id
     AND json_extract(new.payload_json,'$.fromVersion')=attempt.version
     AND json_extract(new.payload_json,'$.toVersion')=attempt.version+1
     AND (new.type='repair_attempt.started' AND attempt.status='planned' AND attempt.version=1
       AND json_extract(new.payload_json,'$.status')='running'
       OR new.type='repair_attempt.delivered' AND attempt.status='running' AND attempt.version=2
         AND json_extract(new.payload_json,'$.status')='delivered'
         AND json_extract(new.payload_json,'$.commitSha')=delivery.commit_sha)
 )
BEGIN SELECT RAISE(ABORT, 'Relay lifecycle projection requires exact authenticated delivery evidence'); END;
CREATE TRIGGER relay_rework_requests_no_delete BEFORE DELETE ON relay_rework_requests
BEGIN SELECT RAISE(ABORT, 'Relay rework history is retained'); END;
CREATE TRIGGER relay_rework_requests_initial_guard BEFORE INSERT ON relay_rework_requests
WHEN new.status <> 'pending' OR new.attempt_id IS NOT NULL OR new.handoff_id IS NOT NULL
 OR NOT EXISTS (
   SELECT 1 FROM verifications AS verification
   JOIN repair_attempts AS attempt ON attempt.id=verification.repair_attempt_id
   JOIN bugs AS bug ON bug.id=verification.bug_id
   JOIN events AS event ON event.aggregate_id=verification.id AND event.type='verification.result_recorded'
     AND event.account_id=verification.account_id AND event.project_id=verification.project_id
     AND event.resource_id=verification.id AND event.resource_version_after=verification.version
     AND json_extract(event.payload_json,'$.status')='failed'
   WHERE verification.id=new.verification_id AND verification.account_id=new.account_id
     AND verification.project_id=new.project_id AND verification.bug_id=new.bug_id
     AND verification.status='failed' AND attempt.id=new.previous_attempt_id
     AND attempt.mode='relay' AND attempt.status='verification_failed'
     AND bug.state='ready' AND bug.version=new.expected_bug_version
     AND event.actor_type='user' AND event.source='qa_hub' AND event.actor_user_id=new.actor_id
     AND event.created_at=verification.updated_at AND new.created_at=verification.updated_at
 )
BEGIN SELECT RAISE(ABORT, 'Relay rework requires the exact human rejection'); END;
CREATE TRIGGER relay_rework_requests_identity BEFORE UPDATE ON relay_rework_requests
WHEN new.verification_id IS NOT old.verification_id OR new.account_id IS NOT old.account_id
 OR new.project_id IS NOT old.project_id OR new.bug_id IS NOT old.bug_id
 OR new.actor_id IS NOT old.actor_id OR new.previous_attempt_id IS NOT old.previous_attempt_id
 OR new.expected_bug_version IS NOT old.expected_bug_version OR new.request_digest IS NOT old.request_digest
 OR new.created_at IS NOT old.created_at OR old.status='queued'
BEGIN SELECT RAISE(ABORT, 'Relay rework identity and queued history are immutable'); END;
`,
    `DROP TRIGGER repair_attempts_initial_typed_guard;\n${initial}`,
    `DROP TRIGGER bugs_typed_state_transition_guard;\n${state}`,
    extraGuard(
      "repair_attempts_lifecycle_typed_guard",
      `
      new.mode = 'relay' AND new.version = old.version + 1 AND new.updated_at > old.updated_at
      AND (
        (old.status = 'planned' AND old.version = 1 AND new.status = 'running'
          AND ${immutableDelivery} AND ${serviceEvent("repair_attempt.started", "2")})
        OR (old.status = 'running' AND old.version = 2 AND new.status = 'delivered'
          AND new.no_code_reason IS NULL AND new.target_build_id IS NULL
          AND new.patch_url IS NULL AND new.failure_reason IS old.failure_reason
          AND length(trim(new.summary)) > 0 AND ${deliveryMatch("new")}
          AND ${serviceEvent("repair_attempt.delivered", "3")})
      )`,
    ),
    extraGuard("verifications_exact_build_requirement", verificationProof),
    `DROP VIEW valid_human_bug_closures;\n${closure}`,
  ].join("\n\n");
}
