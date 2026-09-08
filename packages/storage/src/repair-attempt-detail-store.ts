import type { DatabaseSync } from "node:sqlite";
import type { MobileRelayScope } from "./mobile-relay-store.js";

/** Read-only history, deliberately separate from the human action preconditions. */
export interface RepairAttemptDetail {
  readonly id: string;
  readonly bugId: string;
  readonly sequence: number;
  readonly mode: "human" | "relay" | "external";
  readonly status:
    | "planned"
    | "queued"
    | "running"
    | "needs_input"
    | "blocked"
    | "delivered"
    | "failed"
    | "verification_failed"
    | "cancelled"
    | "superseded";
  readonly assigneeId: string;
  readonly parentAttemptId: string | null;
  readonly summary: string | null;
  readonly branch: string | null;
  readonly commitSha: string | null;
  readonly mergeRequestUrl: string | null;
  readonly patchUrl: string | null;
  readonly noCodeReason: string | null;
  readonly failureReason: string | null;
  readonly targetBuildId: string | null;
  readonly version: number;
}

export interface GetRepairAttemptDetailInput extends MobileRelayScope {
  readonly attemptId: string;
}

export function getRepairAttemptDetail(
  database: DatabaseSync,
  input: GetRepairAttemptDetailInput,
): RepairAttemptDetail | null {
  const row = database
    .prepare(
      `
    SELECT attempt.id, attempt.bug_id AS bugId, attempt.sequence, attempt.mode,
           attempt.status, attempt.assignee_id AS assigneeId,
           attempt.parent_attempt_id AS parentAttemptId, attempt.summary, attempt.branch,
           attempt.commit_sha AS commitSha, attempt.merge_request_url AS mergeRequestUrl,
           attempt.patch_url AS patchUrl, attempt.no_code_reason AS noCodeReason,
           attempt.failure_reason AS failureReason, attempt.target_build_id AS targetBuildId,
           attempt.version
    FROM repair_attempts AS attempt
    JOIN bugs AS bug ON bug.account_id=attempt.account_id AND bug.project_id=attempt.project_id AND bug.id=attempt.bug_id
    JOIN accounts AS account ON account.id=attempt.account_id AND account.status='active'
    JOIN projects AS project ON project.account_id=account.id AND project.id=attempt.project_id AND project.status='active'
    JOIN users AS actor ON actor.account_id=account.id AND actor.id=? AND actor.status='active'
    JOIN command_project_memberships AS membership ON membership.account_id=account.id AND membership.project_id=project.id AND membership.user_id=actor.id AND membership.status='active'
    WHERE attempt.account_id=? AND attempt.project_id=? AND attempt.id=?
      AND NOT EXISTS (SELECT 1 FROM bug_deletions AS deletion WHERE deletion.account_id=bug.account_id AND deletion.project_id=bug.project_id AND deletion.bug_id=bug.id)
  `,
    )
    .get(input.actorId, input.accountId, input.projectId, input.attemptId) as unknown as
    RepairAttemptDetail | undefined;
  return row ? Object.freeze({ ...row }) : null;
}
