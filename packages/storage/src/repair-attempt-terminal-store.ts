import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { toBoundedAuditText } from "./audit-text.js";
import { getMobileBug, type MobileBugRecord } from "./mobile-bug-store.js";
import { insertBugNotificationOutbox, type MobileRelayScope } from "./mobile-relay-store.js";
import { getRepairAttemptDetail, type RepairAttemptDetail } from "./repair-attempt-detail-store.js";
import { canonicalWorkflowRequestDigest, workflowReceipt } from "./workflow-idempotency.js";

export interface TerminalRepairAttemptInput extends MobileRelayScope {
  readonly attemptId: string;
  readonly operation: "failRepairAttempt" | "supersedeRepairAttempt";
  readonly representation: "legacy-1.0" | "vendor-1.1";
  readonly responseMedia: "application/json" | "application/vnd.relay-qa-hub.v1.1+json";
  readonly expectedVersion: number;
  readonly reason: string;
  readonly successor?: {
    readonly id: string;
    readonly mode: "human" | "relay" | "external";
    readonly assigneeId: string;
    readonly summary?: string;
  };
  readonly idempotencyKey: string;
  readonly createdAt: string;
}
/** Internal durable facts, projected separately at the frozen HTTP boundary. */
export interface TerminalRepairAttemptResult {
  readonly representation: TerminalRepairAttemptInput["representation"];
  readonly responseMedia: TerminalRepairAttemptInput["responseMedia"];
  readonly reason: string;
  readonly attempt: RepairAttemptDetail;
  readonly successor: RepairAttemptDetail | null;
  readonly bug: MobileBugRecord;
  readonly eventId: string;
  readonly replayed: boolean;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function reject(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function requireText(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || [...value].length > maximum)
    reject("INVALID_REQUEST", "Text is outside the frozen contract bounds");
}
function validate(input: TerminalRepairAttemptInput): void {
  for (const value of [input.accountId, input.projectId, input.actorId, input.attemptId])
    if (!uuid.test(value)) reject("INVALID_REQUEST", "Invalid workflow identity");
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    !Number.isFinite(Date.parse(input.createdAt)) ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 200
  )
    reject("INVALID_REQUEST", "Invalid workflow command");
  requireText(input.reason, 5000);
  if (
    !["failRepairAttempt", "supersedeRepairAttempt"].includes(input.operation) ||
    !["legacy-1.0", "vendor-1.1"].includes(input.representation) ||
    !["application/json", "application/vnd.relay-qa-hub.v1.1+json"].includes(input.responseMedia) ||
    (input.operation === "supersedeRepairAttempt" &&
      input.representation === "legacy-1.0" &&
      input.responseMedia !== "application/json")
  )
    reject("INVALID_REQUEST", "Invalid terminal operation");
  const needsSuccessor =
    input.operation === "supersedeRepairAttempt" && input.representation === "vendor-1.1";
  if (Boolean(input.successor) !== needsSuccessor)
    reject("INVALID_REQUEST", "Successor must be explicit for vendor supersede only");
  if (input.successor) {
    if (
      !uuid.test(input.successor.id) ||
      !uuid.test(input.successor.assigneeId) ||
      !["human", "relay", "external"].includes(input.successor.mode)
    )
      reject("INVALID_REQUEST", "Invalid successor");
    if (input.successor.summary !== undefined) requireText(input.successor.summary, 10000);
  }
}
function requireDeveloper(
  database: DatabaseSync,
  input: MobileRelayScope,
  actorId = input.actorId,
): void {
  const authorized = database
    .prepare(
      `SELECT 1 FROM accounts AS account
    JOIN projects AS project ON project.account_id=account.id AND project.id=? AND project.status='active'
    JOIN users AS actor ON actor.account_id=account.id AND actor.id=? AND actor.status='active'
    JOIN command_project_memberships AS membership ON membership.account_id=account.id
      AND membership.project_id=project.id AND membership.user_id=actor.id AND membership.status='active'
    JOIN command_project_roles AS role ON role.account_id=account.id AND role.project_id=project.id
      AND role.membership_id=membership.id AND role.role='developer'
    WHERE account.id=? AND account.status='active'`,
    )
    .get(input.projectId, actorId, input.accountId);
  if (!authorized)
    reject(
      actorId === input.actorId ? "FORBIDDEN" : "GUARD_FAILED",
      "Active project capability is required",
    );
}

/** Caller owns BEGIN/COMMIT/ROLLBACK, including the complete snapshot and notification outbox. */
export function terminateRepairAttempt(
  database: DatabaseSync,
  input: TerminalRepairAttemptInput,
): TerminalRepairAttemptResult {
  if (!database.isTransaction)
    reject("SQLITE_TRANSACTION_REQUIRED", "Terminal workflow requires a transaction");
  validate(input);
  requireDeveloper(database, input);
  const attempt = getRepairAttemptDetail(database, input);
  if (!attempt) reject("NOT_FOUND", "RepairAttempt was not found");
  const command = {
    ...input,
    requestDigest: canonicalWorkflowRequestDigest(
      input.operation,
      {
        accountId: input.accountId,
        actorId: input.actorId,
        projectId: input.projectId,
        bugId: attempt.bugId,
        attemptId: input.attemptId,
        verificationId: null,
      },
      {
        expectedVersion: input.expectedVersion,
        reason: input.reason,
        ...(input.successor ? { successor: input.successor } : {}),
      },
      input.idempotencyKey,
    ),
  };
  const receipt = workflowReceipt<{ readonly snapshotId: string }>(
    database,
    command,
    input.operation,
    { type: "repair_attempt", id: input.attemptId },
  );
  if (receipt.replay) {
    const row = database
      .prepare(
        `SELECT response_json FROM repair_attempt_terminal_snapshots
      WHERE id=? AND account_id=? AND project_id=? AND actor_id=? AND attempt_id=?
        AND operation_id=? AND idempotency_key=? AND request_digest=?`,
      )
      .get(
        receipt.replay.snapshotId,
        input.accountId,
        input.projectId,
        input.actorId,
        input.attemptId,
        input.operation,
        input.idempotencyKey,
        command.requestDigest,
      );
    if (typeof row?.response_json !== "string")
      reject("VERSION_CONFLICT", "The original terminal receipt is unavailable");
    return { ...(JSON.parse(row.response_json) as TerminalRepairAttemptResult), replayed: true };
  }
  if (attempt.version !== input.expectedVersion)
    reject("VERSION_CONFLICT", "RepairAttempt version changed");
  const bug = getMobileBug(database, input, attempt.bugId);
  const pointers = database
    .prepare(
      `SELECT active_repair_attempt_id,active_verification_id,updated_at
    FROM bugs WHERE account_id=? AND project_id=? AND id=?`,
    )
    .get(input.accountId, input.projectId, attempt.bugId);
  if (!bug || !pointers) reject("NOT_FOUND", "Bug was not found");
  if (
    bug.state !== "in_progress" ||
    pointers.active_repair_attempt_id !== attempt.id ||
    pointers.active_verification_id !== null ||
    !["planned", "queued", "running", "needs_input", "blocked"].includes(attempt.status)
  )
    reject("INVALID_TRANSITION", "Only the active executing RepairAttempt can be terminated");
  if (input.successor) {
    requireDeveloper(database, input, input.successor.assigneeId);
    // IDs are globally unique, including another project's history. No information about that row is returned.
    if (database.prepare("SELECT 1 FROM repair_attempts WHERE id=?").get(input.successor.id))
      reject("GUARD_FAILED", "Successor identity must be unused");
  }
  const priorTime = database
    .prepare("SELECT updated_at FROM repair_attempts WHERE id=?")
    .get(attempt.id);
  const at = new Date(
    Math.max(
      Date.parse(input.createdAt),
      Date.parse(String(pointers.updated_at)) + 1,
      Date.parse(String(priorTime?.updated_at)) + 1,
    ),
  ).toISOString();
  const eventId = randomUUID();
  const failed = input.operation === "failRepairAttempt";
  const status = failed ? "failed" : "superseded";
  const releasesBug = failed || input.representation === "legacy-1.0";
  const eventType = `repair_attempt.${status}`;
  const aggregate = database
    .prepare(
      `SELECT COALESCE(MAX(aggregate_sequence),0)+1 AS value FROM events
    WHERE account_id=? AND project_id=? AND aggregate_type='repair_attempt' AND aggregate_id=?`,
    )
    .get(input.accountId, input.projectId, attempt.id);
  database
    .prepare(
      `INSERT INTO events(id,account_id,project_id,bug_id,type,source,actor_type,actor_user_id,
    aggregate_type,aggregate_id,aggregate_sequence,resource_type,resource_id,resource_version_after,
    request_digest,correlation_id,from_state,to_state,payload_json,created_at)
    VALUES(?,?,?,?,?,'qa_hub','user',?,'repair_attempt',?,?,'repair_attempt',?,?,?,?,?,?,?,?)`,
    )
    .run(
      eventId,
      input.accountId,
      input.projectId,
      attempt.bugId,
      eventType,
      input.actorId,
      attempt.id,
      Number(aggregate?.value),
      attempt.id,
      attempt.version + 1,
      command.requestDigest,
      randomUUID(),
      releasesBug ? "in_progress" : null,
      releasesBug ? "ready" : null,
      JSON.stringify({
        status,
        repairAttemptId: attempt.id,
        reason: toBoundedAuditText(input.reason),
        fromVersion: attempt.version,
        toVersion: attempt.version + 1,
      }),
      at,
    );
  const updated = database
    .prepare(
      `UPDATE repair_attempts SET status=?,version=version+1,updated_at=?,
    failure_reason=CASE WHEN ? THEN ? ELSE failure_reason END
    WHERE account_id=? AND project_id=? AND id=? AND version=?`,
    )
    .run(
      status,
      at,
      failed ? 1 : 0,
      input.reason,
      input.accountId,
      input.projectId,
      attempt.id,
      attempt.version,
    );
  if (updated.changes !== 1) reject("VERSION_CONFLICT", "RepairAttempt changed concurrently");
  if (input.successor) {
    const sequence = database
      .prepare(
        `SELECT COALESCE(MAX(sequence),0)+1 AS value FROM repair_attempts
      WHERE account_id=? AND project_id=? AND bug_id=?`,
      )
      .get(input.accountId, input.projectId, attempt.bugId);
    database
      .prepare(
        `INSERT INTO repair_attempts(id,account_id,project_id,bug_id,sequence,mode,status,assignee_id,
      parent_attempt_id,summary,branch,commit_sha,merge_request_url,patch_url,no_code_reason,target_build_id,
      created_at,updated_at,version,failure_reason)
      VALUES(?,?,?,?,?,?,'planned',?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,?,?,1,NULL)`,
      )
      .run(
        input.successor.id,
        input.accountId,
        input.projectId,
        attempt.bugId,
        Number(sequence?.value),
        input.successor.mode,
        input.successor.assigneeId,
        attempt.id,
        input.successor.summary ?? null,
        at,
        at,
      );
  }
  const changed = database
    .prepare(
      `UPDATE bugs SET state=?,active_repair_attempt_id=?,version=version+1,updated_at=?
    WHERE account_id=? AND project_id=? AND id=? AND version=? AND active_repair_attempt_id=?`,
    )
    .run(
      input.successor ? "in_progress" : "ready",
      input.successor?.id ?? null,
      at,
      input.accountId,
      input.projectId,
      attempt.bugId,
      bug.version,
      attempt.id,
    );
  if (changed.changes !== 1) reject("VERSION_CONFLICT", "Bug changed concurrently");
  insertBugNotificationOutbox(database, {
    ...command,
    bugId: attempt.bugId,
    eventId,
    eventType,
    bugVersion: bug.version + 1,
    createdAt: at,
  });
  const result: TerminalRepairAttemptResult = {
    representation: input.representation,
    responseMedia: input.responseMedia,
    reason: input.reason,
    attempt: getRepairAttemptDetail(database, input)!,
    successor: input.successor
      ? getRepairAttemptDetail(database, { ...input, attemptId: input.successor.id })
      : null,
    bug: getMobileBug(database, input, attempt.bugId)!,
    eventId,
    replayed: false,
  };
  const snapshotId = randomUUID();
  database
    .prepare(
      `INSERT INTO repair_attempt_terminal_snapshots(id,account_id,project_id,actor_id,bug_id,
    attempt_id,operation_id,representation,response_media,idempotency_key,request_digest,reason,event_id,response_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      snapshotId,
      input.accountId,
      input.projectId,
      input.actorId,
      attempt.bugId,
      attempt.id,
      input.operation,
      input.representation,
      input.responseMedia,
      input.idempotencyKey,
      command.requestDigest,
      input.reason,
      eventId,
      JSON.stringify(result),
      at,
    );
  receipt.commit({ snapshotId }, eventId);
  return result;
}

/** Candidate read helper only; existing HTTP/history/page adapters are not changed here. */
export function getTerminalRepairAttemptHistory(
  database: DatabaseSync,
  input: MobileRelayScope & { readonly attemptId: string },
) {
  const attempt = getRepairAttemptDetail(database, input);
  if (!attempt) return null;
  const row = database
    .prepare(
      `SELECT reason,operation_id FROM repair_attempt_terminal_snapshots
    WHERE account_id=? AND project_id=? AND attempt_id=?`,
    )
    .get(input.accountId, input.projectId, input.attemptId);
  return {
    ...attempt,
    supersedeReason: row?.operation_id === "supersedeRepairAttempt" ? String(row.reason) : null,
  };
}

export interface CreateAfterLegacySupersedeInput extends MobileRelayScope {
  readonly bugId: string;
  readonly parentAttemptId: string;
  readonly expectedVersion: number;
  readonly mode: "human" | "relay" | "external";
  readonly assigneeId: string;
  readonly summary?: string;
  readonly responseMedia: "application/json" | "application/vnd.relay-qa-hub.v1.1+json";
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface CreateAfterLegacySupersedeResult {
  readonly attempt: RepairAttemptDetail;
  readonly responseMedia: CreateAfterLegacySupersedeInput["responseMedia"];
}

/** Candidate branch of the existing create URI; it never dispatches a planned executor. */
export function createRepairAttemptAfterLegacySupersede(
  database: DatabaseSync,
  input: CreateAfterLegacySupersedeInput,
): CreateAfterLegacySupersedeResult {
  if (!database.isTransaction)
    reject("SQLITE_TRANSACTION_REQUIRED", "Parented creation requires a transaction");
  for (const value of [
    input.accountId,
    input.projectId,
    input.actorId,
    input.bugId,
    input.parentAttemptId,
    input.assigneeId,
  ])
    if (!uuid.test(value)) reject("INVALID_REQUEST", "Invalid parented plan identity");
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    !Number.isFinite(Date.parse(input.createdAt)) ||
    !["human", "relay", "external"].includes(input.mode) ||
    !["application/json", "application/vnd.relay-qa-hub.v1.1+json"].includes(input.responseMedia) ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 200
  )
    reject("INVALID_REQUEST", "Invalid parented plan");
  if (
    input.summary !== undefined &&
    (typeof input.summary !== "string" || [...input.summary].length > 5000)
  )
    reject("INVALID_REQUEST", "Summary exceeds the frozen create limit");
  requireDeveloper(database, input);
  const command = {
    ...input,
    requestDigest: canonicalWorkflowRequestDigest(
      "createRepairAttempt",
      {
        accountId: input.accountId,
        actorId: input.actorId,
        projectId: input.projectId,
        bugId: input.bugId,
        attemptId: null,
        verificationId: null,
      },
      {
        parentAttemptId: input.parentAttemptId,
        expectedVersion: input.expectedVersion,
        mode: input.mode,
        assigneeId: input.assigneeId,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
      },
      input.idempotencyKey,
    ),
  };
  // Preserve the existing create operation's receipt namespace rather than evade a reused key.
  const receipt = workflowReceipt<{ readonly snapshotId: string }>(
    database,
    command,
    "createManualRepairAttempt",
    { type: "bug", id: input.bugId },
  );
  if (receipt.replay) {
    const row = database
      .prepare(
        `SELECT response_json,response_media FROM repair_attempt_parent_plan_snapshots
      WHERE id=? AND account_id=? AND project_id=? AND actor_id=? AND bug_id=? AND parent_attempt_id=?
        AND idempotency_key=? AND request_digest=?`,
      )
      .get(
        receipt.replay.snapshotId,
        input.accountId,
        input.projectId,
        input.actorId,
        input.bugId,
        input.parentAttemptId,
        input.idempotencyKey,
        command.requestDigest,
      );
    if (typeof row?.response_json !== "string")
      reject("VERSION_CONFLICT", "Original parented plan receipt is unavailable");
    return {
      attempt: JSON.parse(row.response_json) as RepairAttemptDetail,
      responseMedia: row.response_media as CreateAfterLegacySupersedeResult["responseMedia"],
    };
  }
  const bug = getMobileBug(database, input, input.bugId);
  if (!bug) reject("NOT_FOUND", "Bug was not found");
  if (bug.version !== input.expectedVersion) reject("VERSION_CONFLICT", "Bug version changed");
  const pointers = database
    .prepare("SELECT active_repair_attempt_id,active_verification_id FROM bugs WHERE id=?")
    .get(bug.id);
  if (
    bug.state !== "ready" ||
    pointers?.active_repair_attempt_id !== null ||
    pointers.active_verification_id !== null
  )
    reject("INVALID_TRANSITION", "Bug is not ready for a new parented plan");
  const parent = database
    .prepare(
      `SELECT attempt.id,attempt.sequence FROM repair_attempts AS attempt
    JOIN repair_attempt_terminal_snapshots AS snapshot ON snapshot.account_id=attempt.account_id
      AND snapshot.project_id=attempt.project_id AND snapshot.attempt_id=attempt.id
    WHERE attempt.account_id=? AND attempt.project_id=? AND attempt.bug_id=? AND attempt.id=?
      AND attempt.status='superseded' AND snapshot.operation_id='supersedeRepairAttempt'
      AND snapshot.representation='legacy-1.0'
      AND attempt.sequence=(SELECT MAX(sequence) FROM repair_attempts WHERE account_id=? AND project_id=? AND bug_id=?)`,
    )
    .get(
      input.accountId,
      input.projectId,
      input.bugId,
      input.parentAttemptId,
      input.accountId,
      input.projectId,
      input.bugId,
    );
  if (!parent) reject("GUARD_FAILED", "Parent must be this Bug's latest legacy-superseded attempt");
  requireDeveloper(database, input, input.assigneeId);
  const at = new Date(
    Math.max(Date.parse(input.createdAt), Date.parse(bug.updatedAt) + 1),
  ).toISOString();
  const attemptId = randomUUID(),
    eventId = randomUUID();
  database
    .prepare(
      `INSERT INTO events(id,account_id,project_id,bug_id,type,source,actor_type,actor_user_id,
    aggregate_type,aggregate_id,aggregate_sequence,resource_type,resource_id,resource_version_after,
    request_digest,correlation_id,from_state,to_state,payload_json,created_at)
    VALUES(?,?,?,?,'repair_attempt.created','qa_hub','user',?,'repair_attempt',?,1,'repair_attempt',?,1,?,?,'ready','in_progress',?,?)`,
    )
    .run(
      eventId,
      input.accountId,
      input.projectId,
      input.bugId,
      input.actorId,
      attemptId,
      attemptId,
      command.requestDigest,
      randomUUID(),
      JSON.stringify({
        status: "planned",
        repairAttemptId: attemptId,
        fromVersion: bug.version,
        toVersion: bug.version + 1,
      }),
      at,
    );
  database
    .prepare(
      `INSERT INTO repair_attempts(id,account_id,project_id,bug_id,sequence,mode,status,assignee_id,
    parent_attempt_id,summary,branch,commit_sha,merge_request_url,patch_url,no_code_reason,target_build_id,created_at,updated_at,version,failure_reason)
    VALUES(?,?,?,?,?,?,'planned',?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,?,?,1,NULL)`,
    )
    .run(
      attemptId,
      input.accountId,
      input.projectId,
      bug.id,
      Number(parent.sequence) + 1,
      input.mode,
      input.assigneeId,
      input.parentAttemptId,
      input.summary ?? null,
      at,
      at,
    );
  const changed = database
    .prepare(
      `UPDATE bugs SET state='in_progress',active_repair_attempt_id=?,version=version+1,updated_at=?
    WHERE account_id=? AND project_id=? AND id=? AND version=? AND active_repair_attempt_id IS NULL`,
    )
    .run(attemptId, at, input.accountId, input.projectId, bug.id, bug.version);
  if (changed.changes !== 1) reject("VERSION_CONFLICT", "Bug changed concurrently");
  insertBugNotificationOutbox(database, {
    ...command,
    eventId,
    eventType: "repair_attempt.created",
    bugVersion: bug.version + 1,
    createdAt: at,
  });
  const result = getRepairAttemptDetail(database, { ...input, attemptId })!;
  const snapshotId = randomUUID();
  database
    .prepare(
      `INSERT INTO repair_attempt_parent_plan_snapshots(id,account_id,project_id,actor_id,bug_id,attempt_id,
      parent_attempt_id,idempotency_key,request_digest,event_id,response_media,response_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      snapshotId,
      input.accountId,
      input.projectId,
      input.actorId,
      bug.id,
      attemptId,
      input.parentAttemptId,
      input.idempotencyKey,
      command.requestDigest,
      eventId,
      input.responseMedia,
      JSON.stringify(result),
    );
  receipt.commit({ snapshotId }, eventId);
  return { attempt: result, responseMedia: input.responseMedia };
}
