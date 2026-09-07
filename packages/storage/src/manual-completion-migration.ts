/** Human completion is an explicit local decision, independent of executor evidence. */
export function manualCompletionMigration(schema: string): string {
  const block = (name: string) => {
    const start = schema.lastIndexOf(`CREATE TRIGGER ${name}\n`);
    const end = schema.indexOf("\nEND;", start);
    if (start < 0 || end < 0) throw new Error(`Missing manual completion guard: ${name}`);
    return schema.slice(start, end + 5);
  };
  const authority = `EXISTS (
    SELECT 1 FROM manual_completion_requests AS manual
    WHERE manual.account_id = event.account_id AND manual.project_id = event.project_id
      AND manual.bug_id = event.bug_id AND manual.actor_id = event.actor_user_id
      AND manual.request_digest = event.request_digest
      AND (manual.attempt_id = json_extract(event.payload_json, '$.repairAttemptId')
        OR (event.type = 'repair_attempt.superseded'
          AND manual.previous_attempt_id = event.aggregate_id))
  )`;
  const resetProof = `
    new.state = 'ready' AND old.state IN ('reported','needs_info','ready','in_progress','awaiting_build')
    AND new.version = old.version + 1 AND new.updated_at > old.updated_at
    AND new.active_repair_attempt_id IS NULL AND new.active_verification_id IS NULL
    AND old.active_verification_id IS NULL
    AND ${["title", "description", "expected_behavior", "module_id", "severity", "priority", "owner_id", "verification_owner_id", "occurrence_count", "duplicate_of_bug_id", "closed_at", "reopen_count"].map((field) => `new.${field} IS old.${field}`).join(" AND ")}
    AND EXISTS (
      SELECT 1 FROM manual_completion_requests AS manual JOIN events AS event ON event.id=manual.event_id
      WHERE manual.account_id=old.account_id AND manual.project_id=old.project_id AND manual.bug_id=old.id
        AND manual.expected_bug_version=old.version AND manual.previous_attempt_id IS old.active_repair_attempt_id
        AND manual.created_at=new.updated_at AND event.from_state=old.state
    )`;
  const guards = [
    "repair_attempts_initial_typed_guard",
    "repair_attempts_lifecycle_typed_guard",
    "bugs_typed_state_transition_guard",
    "build_requirements_typed_decision_audit",
  ].map((name) => {
    let sql = block(name);
    sql = sql.replaceAll(
      "AND role.role = 'developer'",
      `AND (role.role = 'developer' OR ${authority})`,
    );
    sql = sql.replaceAll(
      "role.role IN ('developer', 'triager')",
      `(role.role IN ('developer', 'triager') OR ${authority})`,
    );
    // A manual completion is attributed to the active human who performed it.
    if (name === "repair_attempts_initial_typed_guard") {
      // The assignee join precedes the event alias; use the exact new attempt instead.
      sql = sql.replace(
        "assignee_role.role = 'developer'",
        `(assignee_role.role = 'developer' OR EXISTS (
        SELECT 1 FROM manual_completion_requests AS manual
        WHERE manual.account_id=new.account_id AND manual.project_id=new.project_id
          AND manual.bug_id=new.bug_id AND manual.attempt_id=new.id
          AND manual.actor_id=new.assignee_id AND new.mode='human'
      ))`,
      );
    }
    if (name === "bugs_typed_state_transition_guard") {
      sql = sql.replace("\nBEGIN\n", `\nAND NOT (${resetProof})\nBEGIN\n`);
    }
    return `DROP TRIGGER ${name};\n${sql}`;
  });
  return [
    String.raw`
CREATE TABLE manual_completion_requests (
  account_id TEXT NOT NULL, project_id TEXT NOT NULL, bug_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL,
  expected_bug_version INTEGER NOT NULL CHECK(expected_bug_version > 0),
  previous_attempt_id TEXT, attempt_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(account_id,project_id,bug_id,actor_id,idempotency_key),
  UNIQUE(account_id,project_id,attempt_id),
  FOREIGN KEY(account_id,project_id,bug_id) REFERENCES bugs(account_id,project_id,id),
  FOREIGN KEY(account_id,actor_id) REFERENCES users(account_id,id),
  FOREIGN KEY(account_id,project_id,previous_attempt_id) REFERENCES repair_attempts(account_id,project_id,id),
  FOREIGN KEY(account_id,project_id,attempt_id) REFERENCES repair_attempts(account_id,project_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(event_id) REFERENCES events(id)
) STRICT;
CREATE TRIGGER manual_completion_requests_initial BEFORE INSERT ON manual_completion_requests
WHEN NOT EXISTS (
  SELECT 1 FROM bugs AS bug JOIN events AS event ON event.id=new.event_id
  JOIN users AS actor ON actor.account_id=bug.account_id AND actor.id=new.actor_id AND actor.status='active'
  JOIN accounts AS account ON account.id=bug.account_id AND account.status='active'
  JOIN projects AS project ON project.id=bug.project_id AND project.account_id=bug.account_id AND project.status='active'
  JOIN memberships AS membership ON membership.account_id=bug.account_id AND membership.project_id=bug.project_id
    AND membership.user_id=new.actor_id AND membership.status='active'
  WHERE bug.account_id=new.account_id AND bug.project_id=new.project_id AND bug.id=new.bug_id
    AND bug.state IN ('reported','needs_info','ready','in_progress','awaiting_build')
    AND bug.version=new.expected_bug_version AND bug.active_verification_id IS NULL
    AND bug.active_repair_attempt_id IS new.previous_attempt_id
    AND NOT EXISTS(SELECT 1 FROM bug_deletions WHERE bug_id=bug.id)
    AND event.account_id=bug.account_id AND event.project_id=bug.project_id AND event.bug_id=bug.id
    AND event.type='bug.manual_completion_started' AND event.source='qa_hub' AND event.actor_type='user'
    AND event.actor_user_id=new.actor_id AND event.request_digest=new.request_digest
    AND event.aggregate_type='bug' AND event.aggregate_id=bug.id
    AND event.resource_type='bug' AND event.resource_id=bug.id AND event.resource_version_after=bug.version+1
    AND event.created_at=new.created_at AND event.created_at>bug.updated_at
    AND event.from_state=bug.state AND event.to_state='ready'
    AND json_extract(event.payload_json,'$.repairAttemptId')=new.attempt_id
    AND json_extract(event.payload_json,'$.fromVersion')=bug.version
    AND json_extract(event.payload_json,'$.toVersion')=bug.version+1
    AND length(trim(json_extract(event.payload_json,'$.reason')))>0
)
BEGIN SELECT RAISE(ABORT,'Manual completion requires an exact human decision and active project membership'); END;
CREATE TRIGGER manual_completion_requests_no_update BEFORE UPDATE ON manual_completion_requests
BEGIN SELECT RAISE(ABORT,'Manual completion decisions are immutable'); END;
CREATE TRIGGER manual_completion_requests_no_delete BEFORE DELETE ON manual_completion_requests
BEGIN SELECT RAISE(ABORT,'Manual completion history is retained'); END;
`,
    ...guards,
    `DROP TRIGGER bugs_typed_same_state_pointer_guard;\n${block("bugs_typed_same_state_pointer_guard").replace("\nBEGIN\n", `\nAND NOT (${resetProof})\nBEGIN\n`)}`,
  ].join("\n");
}
