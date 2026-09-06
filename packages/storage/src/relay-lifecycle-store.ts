import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  createMobileRelayAttempt,
  continueMobileRelay,
  dispatchMobileRelay,
  insertBugNotificationOutbox,
} from "./mobile-relay-store.js";

interface Delivery {
  account_id: string;
  project_id: string;
  bug_id: string;
  attempt_id: string;
  principal_id: string;
  payload_digest: string;
  inbox_id: string;
  handoff_id: string;
  branch: string;
  commit_sha: string;
  merge_request_url: string | null;
  version: number;
  updated_at: string;
  bug_version: number;
  bug_updated_at: string;
}

/** Only authenticated, applied, exact-task delivery evidence can advance an active round. */
export function projectRelayDeliveries(
  database: DatabaseSync,
  now: string,
  attemptId: string | null = null,
): number {
  if (!database.isTransaction) throw new Error("Relay lifecycle requires a write transaction");
  const deliveries = database
    .prepare(
      `
    SELECT delivery.*, attempt.version, attempt.updated_at, bug.version AS bug_version,
      bug.updated_at AS bug_updated_at
    FROM valid_relay_deliveries AS delivery
    JOIN repair_attempts AS attempt ON attempt.id = delivery.attempt_id
    JOIN bugs AS bug ON bug.id = delivery.bug_id AND bug.active_repair_attempt_id = attempt.id
    WHERE attempt.mode = 'relay' AND ((attempt.status = 'planned' AND attempt.version = 1)
      OR (attempt.status = 'running' AND attempt.version = 2))
      AND bug.state = 'in_progress' AND (? IS NULL OR attempt.id = ?)
      AND EXISTS (SELECT 1 FROM service_principals WHERE id=delivery.principal_id AND status='active')
      AND NOT EXISTS (SELECT 1 FROM bug_deletions WHERE bug_id = bug.id)
    GROUP BY attempt.id
    ORDER BY delivery.received_at LIMIT 20
  `,
    )
    .all(attemptId, attemptId) as unknown as Delivery[];
  for (const delivery of deliveries) {
    let timestamp = Math.max(
      Date.parse(now),
      Date.parse(delivery.updated_at),
      Date.parse(delivery.bug_updated_at),
    );
    for (let version = delivery.version; version < 3; version++) {
      const delivered = version === 2;
      const at = new Date(++timestamp).toISOString();
      const eventId = randomUUID();
      const type = delivered ? "repair_attempt.delivered" : "repair_attempt.started";
      const status = delivered ? "delivered" : "running";
      database
        .prepare(
          `INSERT INTO events (
        id, account_id, project_id, bug_id, type, source, actor_type, actor_service_principal_id,
        aggregate_type, aggregate_id, aggregate_sequence, resource_type, resource_id,
        resource_version_after, request_digest, correlation_id, causation_id, from_state, to_state,
        payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, 'qa_hub', 'service', ?, 'repair_attempt', ?,
        (SELECT COALESCE(MAX(aggregate_sequence),0)+1 FROM events WHERE aggregate_type='repair_attempt' AND aggregate_id=?),
        'repair_attempt', ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          delivery.account_id,
          delivery.project_id,
          delivery.bug_id,
          type,
          delivery.principal_id,
          delivery.attempt_id,
          delivery.attempt_id,
          delivery.attempt_id,
          version + 1,
          delivery.payload_digest,
          randomUUID(),
          null,
          null,
          JSON.stringify({
            status,
            repairAttemptId: delivery.attempt_id,
            ...(delivered ? { commitSha: delivery.commit_sha } : {}),
            fromVersion: version,
            toVersion: version + 1,
          }),
          at,
        );
      if (!delivered) {
        database
          .prepare(
            "UPDATE repair_attempts SET status='running', version=2, updated_at=? WHERE id=? AND version=1",
          )
          .run(at, delivery.attempt_id);
      } else {
        database
          .prepare(
            `UPDATE repair_attempts SET status='delivered', version=3, updated_at=?,
          summary='Relay 已完成制作，等待人工验收', branch=?, commit_sha=?, merge_request_url=?
          WHERE id=? AND version=2`,
          )
          .run(
            at,
            delivery.branch,
            delivery.commit_sha,
            delivery.merge_request_url,
            delivery.attempt_id,
          );
        database
          .prepare(
            "UPDATE bugs SET state='ready_for_verification', version=version+1, updated_at=? WHERE id=? AND version=?",
          )
          .run(at, delivery.bug_id, delivery.bug_version);
        insertBugNotificationOutbox(database, {
          accountId: delivery.account_id,
          projectId: delivery.project_id,
          actorId: delivery.principal_id,
          bugId: delivery.bug_id,
          eventId,
          eventType: type,
          bugVersion: delivery.bug_version + 1,
          createdAt: at,
        });
      }
    }
  }
  return deliveries.length;
}

/** Persisted with the human failure; network delivery happens separately through the outbox. */
export function queueRelayRework(
  database: DatabaseSync,
  input: {
    accountId: string;
    projectId: string;
    actorId: string;
    bugId: string;
    verificationId: string;
    previousAttemptId: string;
    expectedBugVersion: number;
    createdAt: string;
  },
): void {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  database
    .prepare(
      `INSERT INTO relay_rework_requests (
    verification_id,account_id,project_id,bug_id,actor_id,previous_attempt_id,expected_bug_version,
    request_digest,status,next_attempt_at,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)`,
    )
    .run(
      input.verificationId,
      input.accountId,
      input.projectId,
      input.bugId,
      input.actorId,
      input.previousAttemptId,
      input.expectedBugVersion,
      digest,
      input.createdAt,
      input.createdAt,
      input.createdAt,
    );
}

interface Rework {
  verification_id: string;
  account_id: string;
  project_id: string;
  bug_id: string;
  actor_id: string;
  previous_attempt_id: string;
  expected_bug_version: number;
  request_digest: string;
  failure_reason: string;
  assignee_id: string;
  handoff_id: string;
  relay_instance_id: string;
  metadata_json: string;
  execution_json: string | null;
}

export function queueRelayAcceptance(
  database: DatabaseSync,
  input: {
    accountId: string;
    projectId: string;
    actorId: string;
    attemptId: string;
    verificationId: string;
    requestDigest: string;
    createdAt: string;
  },
): void {
  const receipt = database
    .prepare(
      `SELECT receipt.handoff_id, receipt.relay_instance_id, link.metadata_json
    FROM relay_receipts AS receipt JOIN integration_links AS link ON link.id=receipt.integration_link_id
    WHERE receipt.account_id=? AND receipt.project_id=? AND receipt.repair_attempt_id=?`,
    )
    .get(input.accountId, input.projectId, input.attemptId) as {
    handoff_id: string;
    relay_instance_id: string;
    metadata_json: string;
  };
  const metadata = JSON.parse(receipt.metadata_json) as {
    qaInstanceId: string;
    relayPrincipalId: string;
  };
  continueMobileRelay(database, {
    ...input,
    operation: "accept",
    handoffId: receipt.handoff_id,
    actionId: input.verificationId,
    prompt: "QA Hub 人工验收已通过，同步关闭本轮对应的 Relay 任务。",
    selectedAttachmentIds: [],
    relayInstanceId: receipt.relay_instance_id,
    qaInstanceId: metadata.qaInstanceId,
    relayPrincipalId: metadata.relayPrincipalId,
    idempotencyKey: `relay-accept:${input.verificationId}`,
  });
}

export function processRelayReworkRequests(database: DatabaseSync, now: string): void {
  if (!database.isTransaction) throw new Error("Relay rework requires a write transaction");
  const requests = database
    .prepare(
      `SELECT rework.*, verification.failure_reason, attempt.assignee_id,
    receipt.handoff_id, receipt.relay_instance_id, link.metadata_json,
    (SELECT json_extract(payload_json,'$.execution') FROM outbox WHERE aggregate_id=attempt.id
      AND json_extract(payload_json,'$.operation')='create' ORDER BY created_at LIMIT 1) AS execution_json
    FROM relay_rework_requests AS rework
    JOIN verifications AS verification ON verification.id=rework.verification_id
    JOIN repair_attempts AS attempt ON attempt.id=rework.previous_attempt_id
    JOIN relay_receipts AS receipt ON receipt.repair_attempt_id=attempt.id
    JOIN integration_links AS link ON link.id=receipt.integration_link_id
    WHERE rework.status='pending' AND rework.next_attempt_at<=? ORDER BY rework.created_at LIMIT 5
  `,
    )
    .all(now) as unknown as Rework[];
  for (const request of requests) {
    database.exec("SAVEPOINT relay_rework");
    try {
      const metadata = JSON.parse(request.metadata_json) as {
        qaInstanceId: string;
        relayPrincipalId: string;
      };
      if (!metadata.qaInstanceId || !metadata.relayPrincipalId)
        throw new Error("RELAY_BINDING_UNAVAILABLE");
      const input = {
        accountId: request.account_id,
        projectId: request.project_id,
        actorId: request.actor_id,
        requestDigest: request.request_digest,
        createdAt: now,
      };
      const target = database
        .prepare(
          `SELECT bug.version, bug.owner_id FROM bugs AS bug WHERE bug.id=?
        AND bug.state='ready' AND bug.active_repair_attempt_id IS NULL AND bug.active_verification_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM bug_deletions WHERE bug_id=bug.id)
        AND NOT EXISTS(SELECT 1 FROM repair_attempts WHERE bug_id=bug.id
          AND sequence>(SELECT sequence FROM repair_attempts WHERE id=?))`,
        )
        .get(request.bug_id, request.previous_attempt_id) as
        { version: number; owner_id: string | null } | undefined;
      if (!target) {
        database
          .prepare(
            "UPDATE relay_rework_requests SET status='blocked',last_error='BUG_WORKFLOW_CHANGED',updated_at=? WHERE verification_id=?",
          )
          .run(now, request.verification_id);
        database.exec("RELEASE relay_rework");
        continue;
      }
      const attempt = createMobileRelayAttempt(database, {
        ...input,
        bugId: request.bug_id,
        expectedVersion: target.version,
        assigneeId: target.owner_id ?? request.assignee_id,
        summary: null,
        idempotencyKey: `relay-rework:${request.verification_id}`,
      });
      const priorExecution = request.execution_json
        ? (JSON.parse(request.execution_json) as Record<string, unknown>)
        : {};
      const handoffId = randomUUID();
      dispatchMobileRelay(database, {
        ...input,
        attemptId: attempt.id,
        expectedVersion: 1,
        handoffId,
        previousHandoffId: request.handoff_id,
        selectedAttachmentIds: database
          .prepare(
            `SELECT attachment_id FROM verification_attachments
          WHERE account_id=? AND project_id=? AND verification_id=? ORDER BY attachment_id`,
          )
          .all(request.account_id, request.project_id, request.verification_id)
          .map((row) => String(row.attachment_id)),
        relayInstanceId: request.relay_instance_id,
        qaInstanceId: metadata.qaInstanceId,
        relayPrincipalId: metadata.relayPrincipalId,
        idempotencyKey: `relay-rework-dispatch:${request.verification_id}`,
        execution: {
          ...priorExecution,
          extraPrompt: `QA 验收打回，请沿用当前任务开始下一轮修复。\n\n打回理由：\n${request.failure_reason}`,
        },
      });
      database
        .prepare(
          `UPDATE relay_rework_requests SET status='queued', attempt_id=?, handoff_id=?,
        last_error=NULL, updated_at=? WHERE verification_id=? AND status='pending'`,
        )
        .run(attempt.id, handoffId, now, request.verification_id);
      database.exec("RELEASE relay_rework");
    } catch (error) {
      database.exec("ROLLBACK TO relay_rework; RELEASE relay_rework");
      const code =
        error instanceof Error && "code" in error ? String(error.code) : "RELAY_REWORK_PENDING";
      database
        .prepare(
          `UPDATE relay_rework_requests SET next_attempt_at=?, last_error=?, updated_at=?
        WHERE verification_id=? AND status='pending'`,
        )
        .run(new Date(Date.parse(now) + 30_000).toISOString(), code, now, request.verification_id);
    }
  }
}
