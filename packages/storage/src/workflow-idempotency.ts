import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

interface WorkflowCommand {
  readonly accountId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
}

type WorkflowOperation =
  | "transitionBugReady"
  | "createManualRepairAttempt"
  | "startRepairAttempt"
  | "deliverRepairAttempt"
  | "createVerification"
  | "startVerification"
  | "recordVerificationResult"
  | "recordLegacyVerificationResult";

type WorkflowTarget = Readonly<{ type: "bug" | "repair_attempt" | "verification"; id: string }>;

function reject(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Authorize replays as reads too: replay must not bypass revoked membership or deletion. */
function requireVisibleTarget(
  database: DatabaseSync,
  input: WorkflowCommand,
  target: WorkflowTarget,
): void {
  const authorized = database
    .prepare(
      `SELECT 1 FROM accounts AS account
    JOIN projects AS project ON project.account_id = account.id
      AND project.id = ? AND project.status = 'active'
    JOIN users AS actor ON actor.account_id = account.id
      AND actor.id = ? AND actor.status = 'active'
    JOIN command_project_memberships AS membership ON membership.account_id = account.id
      AND membership.project_id = project.id AND membership.user_id = actor.id
      AND membership.status = 'active'
    WHERE account.id = ? AND account.status = 'active'`,
    )
    .get(input.projectId, input.actorId, input.accountId);
  if (!authorized) reject("FORBIDDEN", "workflow requires active project membership");
  const targetJoin =
    target.type === "bug"
      ? ""
      : `JOIN ${target.type === "repair_attempt" ? "repair_attempts" : "verifications"} AS target
      ON target.account_id = bug.account_id AND target.project_id = bug.project_id
      AND target.bug_id = bug.id`;
  const visible = database
    .prepare(
      `SELECT 1 FROM bugs AS bug ${targetJoin}
    WHERE bug.account_id = ? AND bug.project_id = ?
      AND ${target.type === "bug" ? "bug" : "target"}.id = ?
      AND NOT EXISTS (SELECT 1 FROM bug_deletions AS deletion
        WHERE deletion.account_id = bug.account_id AND deletion.project_id = bug.project_id
          AND deletion.bug_id = bug.id)`,
    )
    .get(input.accountId, input.projectId, target.id);
  if (!visible) reject("NOT_FOUND", "workflow target was not found");
}

/** Caller owns the transaction, including the effect, its original audit event and this receipt. */
export function workflowReceipt<T extends object>(
  database: DatabaseSync,
  input: WorkflowCommand,
  operationId: WorkflowOperation,
  target: WorkflowTarget,
): { readonly replay: T | null; readonly commit: (response: T, eventId: string) => T } {
  if (!database.isTransaction)
    reject("SQLITE_TRANSACTION_REQUIRED", "workflow receipt requires a transaction");
  if (
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 255 ||
    !/^[a-f0-9]{64}$/u.test(input.requestDigest)
  )
    reject("INVALID_REQUEST", "invalid workflow idempotency identity");
  requireVisibleTarget(database, input, target);
  // Version and payload digest are deliberately excluded: changing either must not evade the key.
  const scopeJson = JSON.stringify({
    operationId,
    accountId: input.accountId,
    projectId: input.projectId,
    actorId: input.actorId,
    targetType: target.type,
    targetId: target.id,
  });
  const scopeDigest = createHash("sha256").update(scopeJson).digest("hex");
  const prior = database
    .prepare(
      `SELECT request_digest, status, response_json
    FROM idempotency_records WHERE account_id = ? AND project_id = ? AND actor_id = ?
      AND operation_id = ? AND scope_digest = ? AND idempotency_key = ?`,
    )
    .get(
      input.accountId,
      input.projectId,
      input.actorId,
      operationId,
      scopeDigest,
      input.idempotencyKey,
    );
  if (prior) {
    if (prior.request_digest !== input.requestDigest)
      reject(
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
        "workflow key was already used with a different payload",
      );
    if (prior.status !== "committed" || typeof prior.response_json !== "string")
      reject("VERSION_CONFLICT", "workflow receipt is not committed");
    const replay = JSON.parse(prior.response_json) as T;
    return {
      replay,
      commit: () => reject("VERSION_CONFLICT", "workflow receipt already committed"),
    };
  }
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + 7 * 24 * 60 * 60 * 1000).toISOString();
  database
    .prepare(
      `INSERT INTO idempotency_records (
    id, account_id, project_id, actor_id, operation_id, idempotency_key, scope_digest,
    scope_json, request_digest, status, created_at, expires_at, version
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, 1)`,
    )
    .run(
      id,
      input.accountId,
      input.projectId,
      input.actorId,
      operationId,
      input.idempotencyKey,
      scopeDigest,
      scopeJson,
      input.requestDigest,
      createdAt,
      expiresAt,
    );
  return {
    replay: null,
    commit(response, eventId) {
      const changed = database
        .prepare(
          `UPDATE idempotency_records SET status = 'committed',
      http_status = ?, response_json = ?, audit_event_id = ?, version = 2
      WHERE id = ? AND status = 'reserved' AND version = 1`,
        )
        .run(
          operationId === "createManualRepairAttempt" || operationId === "createVerification"
            ? 201
            : 200,
          JSON.stringify(response),
          eventId,
          id,
        );
      if (changed.changes !== 1)
        reject("VERSION_CONFLICT", "workflow receipt did not commit exactly once");
      return response;
    },
  };
}
