import type { DatabaseSync } from "node:sqlite";

import type { MobileBugRecord } from "./mobile-bug-store.js";
import type { MobileBuildRecord } from "./mobile-build-store.js";
import type { MobileRelayScope } from "./mobile-relay-store.js";
import type { MobileVerificationStatus } from "./mobile-verification-store.js";

export interface MobileHumanWorkflowProjection {
  readonly projectId: string;
  readonly bug: {
    readonly id: string;
    readonly key: string;
    readonly state: MobileBugRecord["state"];
    readonly version: number;
  };
  readonly repairAttempt: {
    readonly id: string;
    readonly mode: "human";
    readonly status: "delivered";
    readonly deliveredCommitSha: string;
  };
  readonly build: {
    readonly id: string;
    readonly status: MobileBuildRecord["status"];
    readonly sourceCommitSha: string;
  };
  readonly verification: {
    readonly id: string;
    readonly status: MobileVerificationStatus;
    readonly version: number;
    readonly resultSummary: string;
  };
  readonly closure: {
    readonly verificationId: string;
    readonly closeEventId: string;
    readonly acceptedBugVersion: number;
    readonly acceptedState: "closed";
  };
}

interface HumanWorkflowProjectionRow {
  readonly project_id: string;
  readonly bug_id: string;
  readonly bug_key: string;
  readonly bug_state: MobileBugRecord["state"];
  readonly bug_version: number;
  readonly repair_attempt_id: string;
  readonly repair_attempt_mode: "human";
  readonly repair_attempt_status: "delivered";
  readonly delivered_commit_sha: string;
  readonly build_id: string;
  readonly build_status: MobileBuildRecord["status"];
  readonly source_commit_sha: string;
  readonly verification_id: string;
  readonly verification_status: MobileVerificationStatus;
  readonly verification_version: number;
  readonly result_summary: string;
  readonly close_event_id: string;
  readonly accepted_bug_version: number;
}

/**
 * Read the latest complete human closure from durable facts. The query does
 * not create or refresh any projection row, so the result remains restart-safe
 * and deterministic for the same SQLite contents.
 */
export function getLatestMobileHumanWorkflow(
  database: DatabaseSync,
  input: MobileRelayScope,
): MobileHumanWorkflowProjection | null {
  const row = database
    .prepare(
      `SELECT closure.project_id,
              bug.id AS bug_id, bug.key AS bug_key, bug.state AS bug_state,
              bug.version AS bug_version,
              attempt.id AS repair_attempt_id,
              attempt.mode AS repair_attempt_mode,
              attempt.status AS repair_attempt_status,
              attempt.commit_sha AS delivered_commit_sha,
              build.id AS build_id, build.status AS build_status,
              build.source_commit_sha,
              verification.id AS verification_id,
              verification.status AS verification_status,
              verification.version AS verification_version,
              verification.result_summary,
              closure.close_event_id,
              closure.closed_bug_version AS accepted_bug_version
       FROM bug_closure_acceptances AS closure
       JOIN accounts AS account
         ON account.id = closure.account_id
        AND account.status = 'active'
       JOIN projects AS project
         ON project.account_id = closure.account_id
        AND project.id = closure.project_id
        AND project.status = 'active'
       JOIN users AS actor
         ON actor.account_id = closure.account_id
        AND actor.id = ?
        AND actor.status = 'active'
       JOIN memberships AS membership
         ON membership.account_id = project.account_id
        AND membership.project_id = project.id
        AND membership.user_id = actor.id
        AND membership.status = 'active'
       JOIN bugs AS bug
         ON bug.account_id = closure.account_id
        AND bug.project_id = closure.project_id
        AND bug.id = closure.bug_id
       JOIN verifications AS verification
         ON verification.account_id = closure.account_id
        AND verification.project_id = closure.project_id
        AND verification.id = closure.verification_id
        AND verification.bug_id = closure.bug_id
       JOIN repair_attempts AS attempt
         ON attempt.account_id = verification.account_id
        AND attempt.project_id = verification.project_id
        AND attempt.id = verification.repair_attempt_id
        AND attempt.bug_id = verification.bug_id
       JOIN builds AS build
         ON build.account_id = closure.account_id
        AND build.project_id = closure.project_id
        AND build.id = closure.baseline_build_id
        AND build.id = verification.build_id
        AND build.source_commit_sha = attempt.commit_sha
       JOIN build_repair_links AS link
         ON link.account_id = attempt.account_id
        AND link.project_id = attempt.project_id
        AND link.bug_id = attempt.bug_id
        AND link.repair_attempt_id = attempt.id
        AND link.build_id = build.id
       WHERE closure.account_id = ?
         AND closure.project_id = ?
         AND closure.baseline_build_id IS NOT NULL
         AND bug.state = 'closed'
         AND bug.version = closure.closed_bug_version
         AND attempt.mode = 'human'
         AND attempt.status = 'delivered'
         AND attempt.commit_sha IS NOT NULL
         AND build.status = 'ready'
         AND verification.status = 'passed'
         AND verification.result_summary IS NOT NULL
       ORDER BY closure.closed_at DESC,
                closure.close_event_position DESC,
                closure.closure_generation DESC,
                closure.close_event_id DESC
       LIMIT 1`,
    )
    .get(input.actorId, input.accountId, input.projectId) as HumanWorkflowProjectionRow | undefined;

  if (!row) return null;

  return Object.freeze({
    projectId: row.project_id,
    bug: Object.freeze({
      id: row.bug_id,
      key: row.bug_key,
      state: row.bug_state,
      version: row.bug_version,
    }),
    repairAttempt: Object.freeze({
      id: row.repair_attempt_id,
      mode: row.repair_attempt_mode,
      status: row.repair_attempt_status,
      deliveredCommitSha: row.delivered_commit_sha,
    }),
    build: Object.freeze({
      id: row.build_id,
      status: row.build_status,
      sourceCommitSha: row.source_commit_sha,
    }),
    verification: Object.freeze({
      id: row.verification_id,
      status: row.verification_status,
      version: row.verification_version,
      resultSummary: row.result_summary,
    }),
    closure: Object.freeze({
      verificationId: row.verification_id,
      closeEventId: row.close_event_id,
      acceptedBugVersion: row.accepted_bug_version,
      acceptedState: "closed" as const,
    }),
  });
}
