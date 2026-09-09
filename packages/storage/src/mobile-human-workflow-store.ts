import type { DatabaseSync } from "node:sqlite";

import type { MobileBugRecord } from "./mobile-bug-store.js";
import type { MobileBuildRecord } from "./mobile-build-store.js";
import {
  MobileRelayStorageError,
  type MobileBuildRequirementRecord,
  type MobileManualRepairAttemptRecord,
  type MobileRelayScope,
} from "./mobile-relay-store.js";
import type {
  MobileVerificationRecord,
  MobileVerificationStatus,
} from "./mobile-verification-store.js";
import { canonicalProjectUserId } from "./project-identity-projection.js";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export interface GetMobileHumanWorkflowForBugInput extends MobileRelayScope {
  readonly bugId: string;
}

export interface MobileHumanWorkflowForBugProjection {
  readonly bugId: string;
  readonly repairAttempt: MobileManualRepairAttemptRecord | null;
  readonly buildRequirement: MobileBuildRequirementRecord | null;
  /** The Build reached through the exact immutable build_repair_links row. */
  readonly build: MobileBuildRecord | null;
  readonly verification: MobileVerificationRecord | null;
  /** Most recent verification, including a completed round after closure. */
  readonly latestVerification: MobileVerificationRecord | null;
  readonly relayRework?: { readonly status: string; readonly lastError: string | null } | null;
  readonly relayAcceptance?: { readonly status: string; readonly lastError: string | null } | null;
}

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
       JOIN command_project_memberships AS membership
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

interface HumanWorkflowBugPointerRow {
  readonly active_repair_attempt_id: string | null;
  readonly active_verification_id: string | null;
}

interface HumanWorkflowAttemptRow {
  readonly id: string;
  readonly bug_id: string;
  readonly sequence: number;
  readonly mode: string;
  readonly status: string;
  readonly assignee_id: string;
  readonly summary: string | null;
  readonly branch: string | null;
  readonly commit_sha: string | null;
  readonly merge_request_url: string | null;
  readonly patch_url: string | null;
  readonly no_code_reason: string | null;
  readonly failure_reason: string | null;
  readonly version: number;
}

interface HumanWorkflowRequirementRow {
  readonly id: string;
  readonly project_id: string;
  readonly bug_id: string;
  readonly repair_attempt_id: string;
  readonly source_delivery_version: number;
  readonly delivered_commit_sha: string | null;
  readonly requirement: MobileBuildRequirementRecord["requirement"];
  readonly decision_basis: MobileBuildRequirementRecord["decisionBasis"];
  readonly decision_reason: string | null;
  readonly decision_actor_id: string;
  readonly decision_audit_event_id: string;
  readonly linked_build_id: string | null;
  readonly link_id: string | null;
  readonly policy_version: "1.0.0";
  readonly bug_version_at_delivery: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: 1 | 2;
}

interface HumanWorkflowBuildRow {
  readonly id: string;
  readonly project_id: string;
  readonly provider: MobileBuildRecord["provider"];
  readonly external_id: string;
  readonly version_name: string;
  readonly channel: string;
  readonly project_key: string;
  readonly branch: string;
  readonly source_commit_sha: string;
  readonly mode: MobileBuildRecord["mode"];
  readonly status: MobileBuildRecord["status"];
  readonly manifest_json: string;
  readonly artifact_sha256: string | null;
  readonly download_url: string | null;
  readonly version: number;
}

interface HumanWorkflowVerificationRow {
  readonly id: string;
  readonly bug_id: string;
  readonly repair_attempt_id: string;
  readonly build_id: string | null;
  readonly status: MobileVerificationStatus;
  readonly verifier_id: string;
  readonly criteria_snapshot: string;
  readonly result_summary: string | null;
  readonly failure_reason: string | null;
  readonly blocked_reason: string | null;
  readonly version: number;
}

function requireWorkflowUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} must be a UUID`);
  }
}

function readAuthorizedBugPointers(
  database: DatabaseSync,
  input: GetMobileHumanWorkflowForBugInput,
): HumanWorkflowBugPointerRow {
  const bug = database
    .prepare(
      `SELECT active_repair_attempt_id, active_verification_id
       FROM bugs
       WHERE account_id = ? AND project_id = ? AND id = ?
         AND NOT EXISTS (
           SELECT 1 FROM bug_deletions AS deletion
           WHERE deletion.account_id = bugs.account_id
             AND deletion.project_id = bugs.project_id
             AND deletion.bug_id = bugs.id
         )`,
    )
    .get(input.accountId, input.projectId, input.bugId) as HumanWorkflowBugPointerRow | undefined;
  if (!bug) throw new MobileRelayStorageError("NOT_FOUND", "Bug was not found");

  const authorized = database
    .prepare(
      `SELECT 1 AS present
       FROM accounts AS account
       JOIN projects AS project
         ON project.account_id = account.id
        AND project.id = ?
        AND project.status = 'active'
       JOIN users AS actor
         ON actor.account_id = account.id
        AND actor.id = ?
        AND actor.status = 'active'
       JOIN command_project_memberships AS membership
         ON membership.account_id = account.id
        AND membership.project_id = project.id
        AND membership.user_id = actor.id
        AND membership.status = 'active'
       WHERE account.id = ? AND account.status = 'active'`,
    )
    .get(input.projectId, input.actorId, input.accountId) as
    { readonly present: number } | undefined;
  if (!authorized) {
    throw new MobileRelayStorageError(
      "FORBIDDEN",
      "actor is not an active member of the requested project",
    );
  }
  return bug;
}

function readHumanRepairAttempt(
  database: DatabaseSync,
  input: GetMobileHumanWorkflowForBugInput,
  attemptId: string | null,
): MobileManualRepairAttemptRecord | null {
  if (attemptId === null) return null;
  const row = database
    .prepare(
      `SELECT id, bug_id, sequence, mode, status, assignee_id,
              summary, branch, commit_sha, merge_request_url, patch_url,
              no_code_reason, failure_reason, version
       FROM repair_attempts
       WHERE account_id = ? AND project_id = ? AND bug_id = ?
         AND id = ? AND mode IN ('human','relay')`,
    )
    .get(input.accountId, input.projectId, input.bugId, attemptId) as
    HumanWorkflowAttemptRow | undefined;
  if (!row) return null;
  if (row.status !== "planned" && row.status !== "running" && row.status !== "delivered") {
    return null;
  }
  return Object.freeze({
    id: row.id,
    bugId: row.bug_id,
    sequence: row.sequence,
    mode: row.mode as "human" | "relay",
    status: row.status,
    assigneeId: canonicalProjectUserId(database, input, row.assignee_id),
    parentAttemptId: null,
    summary: row.summary,
    branch: row.branch,
    commitSha: row.commit_sha,
    mergeRequestUrl: row.merge_request_url,
    patchUrl: row.patch_url,
    noCodeReason: row.no_code_reason,
    failureReason: row.failure_reason,
    targetBuildId: null,
    version: row.version,
  });
}

function readBuildRequirement(
  database: DatabaseSync,
  input: GetMobileHumanWorkflowForBugInput,
  repairAttemptId: string | null,
): MobileBuildRequirementRecord | null {
  if (repairAttemptId === null) return null;
  const row = database
    .prepare(
      `SELECT id, project_id, bug_id, repair_attempt_id,
              source_delivery_version, delivered_commit_sha, requirement,
              decision_basis, decision_reason, decision_actor_id,
              decision_audit_event_id, linked_build_id, link_id,
              policy_version, bug_version_at_delivery, created_at,
              updated_at, version
       FROM build_requirements
       WHERE account_id = ? AND project_id = ? AND bug_id = ?
         AND repair_attempt_id = ?`,
    )
    .get(input.accountId, input.projectId, input.bugId, repairAttemptId) as
    HumanWorkflowRequirementRow | undefined;
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    bugId: row.bug_id,
    repairAttemptId: row.repair_attempt_id,
    sourceDeliveryVersion: row.source_delivery_version,
    deliveredCommitSha: row.delivered_commit_sha,
    requirement: row.requirement,
    decisionBasis: row.decision_basis,
    decisionReason: row.decision_reason,
    decisionActorId: row.decision_actor_id,
    decisionAuditEventId: row.decision_audit_event_id,
    linkedBuildId: row.linked_build_id,
    linkId: row.link_id,
    policyVersion: row.policy_version,
    bugVersionAtDelivery: row.bug_version_at_delivery,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

function readExactLinkedBuild(
  database: DatabaseSync,
  input: GetMobileHumanWorkflowForBugInput,
  requirement: MobileBuildRequirementRecord | null,
): MobileBuildRecord | null {
  if (requirement?.linkedBuildId === null || requirement?.linkId === null) return null;
  if (!requirement) return null;
  const link = database
    .prepare(
      `SELECT build_id
       FROM build_repair_links
       WHERE account_id = ? AND project_id = ? AND id = ?
         AND bug_id = ? AND repair_attempt_id = ?
         AND build_requirement_id = ?
         AND build_requirement_version = ? AND build_id = ?`,
    )
    .get(
      input.accountId,
      input.projectId,
      requirement.linkId,
      requirement.bugId,
      requirement.repairAttemptId,
      requirement.id,
      requirement.version,
      requirement.linkedBuildId,
    ) as { readonly build_id: string } | undefined;
  if (!link) return null;

  const row = database
    .prepare(
      `SELECT id, project_id, provider, external_id, version_name, channel,
              project_key, branch, source_commit_sha, mode, status,
              manifest_json, artifact_sha256, download_url, version
       FROM builds
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, link.build_id) as HumanWorkflowBuildRow | undefined;
  if (!row) return null;

  let manifest: { readonly commitShas: readonly string[]; readonly artifactSha256: string | null };
  try {
    const decoded = JSON.parse(row.manifest_json) as {
      readonly commitShas?: unknown;
      readonly artifactSha256?: unknown;
    };
    if (
      !Array.isArray(decoded.commitShas) ||
      decoded.commitShas.some((value) => typeof value !== "string") ||
      (decoded.artifactSha256 !== undefined &&
        decoded.artifactSha256 !== null &&
        typeof decoded.artifactSha256 !== "string")
    ) {
      throw new Error("invalid manifest");
    }
    manifest = {
      commitShas: Object.freeze(decoded.commitShas as string[]),
      artifactSha256: (decoded.artifactSha256 as string | null | undefined) ?? null,
    };
  } catch {
    throw new MobileRelayStorageError("BUILD_IDENTITY_MISMATCH", "Build manifest JSON is invalid");
  }
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    externalId: row.external_id,
    versionName: row.version_name,
    channel: row.channel,
    projectKey: row.project_key,
    branch: row.branch,
    sourceCommitSha: row.source_commit_sha,
    mode: row.mode,
    status: row.status,
    manifest: Object.freeze(manifest),
    artifactSha256: row.artifact_sha256,
    downloadUrl: row.download_url,
    version: row.version,
  });
}

function readActiveVerification(
  database: DatabaseSync,
  input: GetMobileHumanWorkflowForBugInput,
  verificationId: string | null,
): MobileVerificationRecord | null {
  if (verificationId === null) return null;
  const row = database
    .prepare(
      `SELECT id, bug_id, repair_attempt_id, build_id, status, verifier_id,
              criteria_snapshot, result_summary, failure_reason, blocked_reason,
              version
       FROM verifications
       WHERE account_id = ? AND project_id = ? AND bug_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, input.bugId, verificationId) as
    HumanWorkflowVerificationRow | undefined;
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    bugId: row.bug_id,
    repairAttemptId: row.repair_attempt_id,
    buildId: row.build_id,
    status: row.status,
    verifierId: canonicalProjectUserId(database, input, row.verifier_id),
    criteriaSnapshot: row.criteria_snapshot,
    resultSummary: row.result_summary,
    failureReason: row.failure_reason,
    blockedReason: row.blocked_reason,
    version: row.version,
  });
}

/**
 * Read the current human workflow pointers for one Bug. The Build is only
 * returned through the exact immutable BuildRepairLink named by the active
 * BuildRequirement; no commit SHA is used to infer a relationship.
 */
export function getMobileHumanWorkflowForBug(
  database: DatabaseSync,
  input: GetMobileHumanWorkflowForBugInput,
): MobileHumanWorkflowForBugProjection {
  requireWorkflowUuid(input.accountId, "accountId");
  requireWorkflowUuid(input.projectId, "projectId");
  requireWorkflowUuid(input.actorId, "actorId");
  requireWorkflowUuid(input.bugId, "bugId");

  const pointers = readAuthorizedBugPointers(database, input);
  const repairAttempt = readHumanRepairAttempt(database, input, pointers.active_repair_attempt_id);
  const buildRequirement = readBuildRequirement(database, input, repairAttempt?.id ?? null);
  const verification = readActiveVerification(database, input, pointers.active_verification_id);
  const latestVerificationRow = database
    .prepare(
      `SELECT id FROM verifications
     WHERE account_id = ? AND project_id = ? AND bug_id = ?
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(input.accountId, input.projectId, input.bugId) as { id: string } | undefined;
  const latestVerification = readActiveVerification(
    database,
    input,
    latestVerificationRow?.id ?? null,
  );
  const rework = database
    .prepare(
      `SELECT status, last_error AS lastError FROM relay_rework_requests
    WHERE account_id=? AND project_id=? AND bug_id=? AND status IN ('pending','blocked')
    ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.accountId, input.projectId, input.bugId) as
    { status: string; lastError: string | null } | undefined;
  const acceptance = database
    .prepare(
      `SELECT status,last_error_code AS lastError FROM outbox
    WHERE account_id=? AND project_id=? AND json_extract(payload_json,'$.bugId')=?
      AND json_extract(payload_json,'$.operation')='accept' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.accountId, input.projectId, input.bugId) as
    { status: string; lastError: string | null } | undefined;
  return Object.freeze({
    bugId: input.bugId,
    repairAttempt,
    buildRequirement,
    build: readExactLinkedBuild(database, input, buildRequirement),
    verification,
    latestVerification,
    ...(rework ? { relayRework: rework } : {}),
    ...(acceptance ? { relayAcceptance: acceptance } : {}),
  });
}
