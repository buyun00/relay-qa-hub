import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { projectManagement } from "./project-management-store.js";

export interface ProjectRelayQueueInput {
  operation: "list" | "pause" | "resume";
  accountId: string;
  projectId: string;
  actorId?: string;
  isGm?: boolean;
  outboxMessageId?: string;
  now: string;
}
export function relayComponentEnabled(
  database: DatabaseSync,
  accountId: string,
  projectId: string,
): boolean {
  return !!database
    .prepare(
      `SELECT 1 FROM project_components AS c JOIN projects AS p
    ON p.account_id=c.account_id AND p.id=c.project_id
    WHERE c.account_id=? AND c.project_id=? AND c.component_key='relay.production' AND c.enabled=1 AND p.status='active'`,
    )
    .get(accountId, projectId);
}
export function projectRelayQueue(database: DatabaseSync, input: ProjectRelayQueueInput): unknown {
  if (!database.isTransaction) throw new Error("Relay queue requires a write transaction");
  if (input.operation !== "pause")
    projectManagement(database, {
      operation: "authorize",
      accountId: input.accountId,
      projectId: input.projectId,
      actorId: input.actorId ?? "",
      isGm: input.isGm === true,
      now: input.now,
    });
  if (input.operation === "pause") {
    if (relayComponentEnabled(database, input.accountId, input.projectId)) return 0;
    return database
      .prepare(
        `UPDATE outbox SET last_error_code='COMPONENT_DISABLED_PAUSED'
      WHERE account_id=? AND project_id=? AND json_extract(payload_json,'$.componentRoute') IS NOT NULL
        AND (status IN ('pending','retry') OR (status='claimed' AND lease_expires_at<=?))`,
      )
      .run(input.accountId, input.projectId, input.now).changes;
  }
  if (input.operation === "resume") {
    if (!relayComponentEnabled(database, input.accountId, input.projectId))
      throw Object.assign(new Error("Relay component is disabled"), { code: "COMPONENT_DISABLED" });
    const changed = database
      .prepare(
        `UPDATE outbox SET last_error_code=NULL, next_attempt_at=?
      WHERE account_id=? AND project_id=? AND id=? AND last_error_code='COMPONENT_DISABLED_PAUSED'
        AND json_extract(payload_json,'$.componentRoute') IS NOT NULL
        AND (status IN ('pending','retry') OR (status='claimed' AND lease_expires_at<=?))`,
      )
      .run(
        input.now,
        input.accountId,
        input.projectId,
        input.outboxMessageId ?? "",
        input.now,
      ).changes;
    if (!changed)
      throw Object.assign(new Error("Relay outbox entry is not paused"), {
        code: "TASK_NOT_PAUSED",
      });
    database
      .prepare(
        "INSERT INTO project_management_events(id,account_id,project_id,actor_id,action,subject_id,summary_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        input.accountId,
        input.projectId,
        input.actorId ?? "",
        "relay.outbox.resumed",
        input.outboxMessageId ?? "",
        "{}",
        input.now,
      );
  }
  return {
    projectId: input.projectId,
    items: database
      .prepare(
        `SELECT id, project_id AS projectId,
    (SELECT relay_task_id FROM relay_receipts AS r WHERE r.account_id=outbox.account_id AND r.project_id=outbox.project_id
      AND r.repair_attempt_id=outbox.aggregate_id AND r.relay_instance_id=outbox.destination) AS relayTaskId,
    json_extract(payload_json,'$.componentRoute.componentVersion') AS componentVersion,
    json_extract(payload_json,'$.handoffId') AS handoffId,
    json_extract(payload_json,'$.bugId') AS bugId,
    CASE WHEN last_error_code='COMPONENT_DISABLED_PAUSED' THEN 'paused'
      WHEN status='sent' THEN 'submitted' WHEN status='dead' THEN 'failed' ELSE status END AS state,
    status, attempt_count AS attemptCount, last_error_code AS errorCode, created_at AS createdAt,
    sent_at AS submittedAt FROM outbox WHERE account_id=? AND project_id=?
      AND json_extract(payload_json,'$.componentRoute') IS NOT NULL ORDER BY created_at DESC,id DESC`,
      )
      .all(input.accountId, input.projectId),
  };
}
