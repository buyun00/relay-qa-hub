import { queueRelayRework, queueRelayAcceptance } from "./relay-lifecycle-store.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { toBoundedAuditText } from "./audit-text.js";
import type { MobileBugRecord } from "./mobile-bug-store.js";
import {
  insertBugNotificationOutbox,
  MobileRelayStorageError,
  type MobileManualRepairAttemptRecord,
  type MobileRelayScope,
} from "./mobile-relay-store.js";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type MobileVerificationStatus =
  "requested" | "in_progress" | "passed" | "failed" | "blocked" | "cancelled";

export interface MobileVerificationRecord {
  readonly id: string;
  readonly bugId: string;
  readonly repairAttemptId: string;
  readonly buildId: string | null;
  readonly status: MobileVerificationStatus;
  readonly verifierId: string;
  readonly criteriaSnapshot: string;
  readonly resultSummary: string | null;
  readonly failureReason: string | null;
  readonly blockedReason: string | null;
  readonly version: number;
}

export interface CreateMobileVerificationInput extends MobileRelayScope {
  readonly bugId: string;
  readonly expectedVersion: number;
  readonly repairAttemptId: string;
  readonly buildId: string | null;
  readonly verifierId: string;
  readonly criteria: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export interface GetMobileVerificationInput extends MobileRelayScope {
  readonly verificationId: string;
}

export interface StartMobileVerificationInput extends MobileRelayScope {
  readonly verificationId: string;
  readonly expectedVersion: number;
  readonly reason: string | null;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

interface RecordMobileVerificationResultBase extends MobileRelayScope {
  readonly verificationId: string;
  readonly expectedVersion: number;
  readonly resultSummary: string;
  readonly clientSubmissionId: string;
  readonly attachmentIds: readonly string[];
  readonly captureBundleId: string | null;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export type RecordMobileVerificationResultInput = RecordMobileVerificationResultBase &
  (
    | { readonly status: "passed"; readonly failureReason: null }
    | { readonly status: "failed"; readonly failureReason: string }
  );

export interface MobileVerificationResultResponse {
  readonly clientSubmissionId: string;
  readonly qaItem: { readonly type: "bug"; readonly id: string; readonly key: string };
  readonly verification: MobileVerificationRecord;
  readonly repairAttempt: MobileManualRepairAttemptRecord;
  readonly bug: MobileBugRecord;
  readonly attachmentIds: readonly string[];
  readonly captureBundleId: string | null;
  readonly eventId: string;
  readonly replayed: boolean;
}

interface VerificationRow {
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
  readonly created_at: string;
  readonly updated_at: string;
}

interface BugRow {
  readonly id: string;
  readonly project_id: string;
  readonly number: number;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly expected_behavior: string;
  readonly module_id: string | null;
  readonly state: MobileBugRecord["state"];
  readonly severity: MobileBugRecord["severity"];
  readonly priority: MobileBugRecord["priority"];
  readonly reporter_id: string;
  readonly owner_id: string | null;
  readonly verification_owner_id: string | null;
  readonly duplicate_of_bug_id: string | null;
  readonly occurrence_count: number;
  readonly reopen_count: number;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
  readonly active_verification_id: string | null;
}

interface AttemptRow {
  readonly id: string;
  readonly bug_id: string;
  readonly sequence: number;
  readonly mode: string;
  readonly status: string;
  readonly assignee_id: string;
  readonly parent_attempt_id: string | null;
  readonly summary: string | null;
  readonly branch: string | null;
  readonly commit_sha: string | null;
  readonly merge_request_url: string | null;
  readonly patch_url: string | null;
  readonly no_code_reason: string | null;
  readonly failure_reason: string | null;
  readonly target_build_id: string | null;
  readonly version: number;
}

interface EligibleWorkflowRow extends BugRow {
  readonly active_verification_id: string | null;
  readonly attempt_id: string;
  readonly attempt_mode: string;
  readonly attempt_status: string;
  readonly attempt_assignee_id: string;
  readonly attempt_sequence: number;
  readonly attempt_summary: string | null;
  readonly attempt_branch: string | null;
  readonly attempt_commit_sha: string | null;
  readonly attempt_merge_request_url: string | null;
  readonly attempt_target_build_id: string | null;
  readonly attempt_version: number;
  readonly attempt_updated_at: string;
  readonly build_id: string | null;
  readonly build_status: string | null;
  readonly build_version: number | null;
  readonly build_source_commit_sha: string | null;
  readonly requirement_requirement: "required" | "not_required";
  readonly requirement_decision_basis:
    "code_requires_build" | "no_code_delivery" | "authorized_no_build_exemption";
  readonly requirement_commit_sha: string | null;
  readonly requirement_version: number;
  readonly requirement_linked_build_id: string | null;
  readonly requirement_link_id: string | null;
  readonly link_id: string | null;
  readonly completion_event_id: string | null;
  readonly relay_delivery: number;
}

function requireTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "mobile Verification storage requires the caller's write transaction",
    );
  }
}

function requireUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} is invalid`);
  }
}

function requireDigest(value: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "requestDigest is invalid");
  }
}

function requireText(value: string, field: string, maximum: number): void {
  if (value.trim().length === 0 || value.length > maximum) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} is invalid`);
  }
}

function requireTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "createdAt is invalid");
  }
}

function nextTimestamp(candidate: string, floor: string): string {
  requireTimestamp(candidate);
  requireTimestamp(floor);
  return new Date(Math.max(Date.parse(candidate), Date.parse(floor) + 1)).toISOString();
}

function requireVerificationIdentity(input: MobileRelayScope, verifierId: string): void {
  requireUuid(input.accountId, "accountId");
  requireUuid(input.projectId, "projectId");
  requireUuid(input.actorId, "actorId");
  requireUuid(verifierId, "verifierId");
}

function hasProjectMembership(
  database: DatabaseSync,
  input: MobileRelayScope,
  userId: string,
): boolean {
  const row = database
    .prepare(
      `SELECT 1 AS present
       FROM accounts AS account
       JOIN projects AS project
         ON project.account_id = account.id
        AND project.id = ? AND project.status = 'active'
       JOIN users AS actor
         ON actor.account_id = account.id
        AND actor.id = ? AND actor.status = 'active'
       JOIN memberships AS membership
         ON membership.account_id = account.id
        AND membership.project_id = project.id
        AND membership.user_id = actor.id
        AND membership.status = 'active'
       WHERE account.id = ? AND account.status = 'active'`,
    )
    .get(input.projectId, userId, input.accountId) as { readonly present: number } | undefined;
  return row !== undefined;
}

function requireVerificationCreatorRole(database: DatabaseSync, input: MobileRelayScope): void {
  if (!hasProjectMembership(database, input, input.actorId)) {
    throw new MobileRelayStorageError(
      "FORBIDDEN",
      "Verification creation requires active project membership",
    );
  }
}

function requireVerifierRole(
  database: DatabaseSync,
  input: MobileRelayScope,
  verifierId = input.actorId,
): void {
  if (!hasProjectMembership(database, input, verifierId)) {
    throw new MobileRelayStorageError("FORBIDDEN", "assigned user is not an active project member");
  }
}

function toBug(row: BugRow): MobileBugRecord {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    key: row.key,
    title: row.title,
    description: row.description,
    expectedBehavior: row.expected_behavior,
    moduleId: row.module_id,
    state: row.state,
    severity: row.severity,
    priority: row.priority,
    reporterId: row.reporter_id,
    ownerId: row.owner_id,
    verificationOwnerId: row.verification_owner_id,
    duplicateOfBugId: row.duplicate_of_bug_id,
    occurrenceCount: row.occurrence_count,
    reopenCount: row.reopen_count,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  });
}

function toVerification(row: VerificationRow): MobileVerificationRecord {
  return Object.freeze({
    id: row.id,
    bugId: row.bug_id,
    repairAttemptId: row.repair_attempt_id,
    buildId: row.build_id,
    status: row.status,
    verifierId: row.verifier_id,
    criteriaSnapshot: row.criteria_snapshot,
    resultSummary: row.result_summary,
    failureReason: row.failure_reason,
    blockedReason: row.blocked_reason,
    version: row.version,
  });
}

function toAttempt(row: AttemptRow): MobileManualRepairAttemptRecord {
  if (
    (row.mode !== "human" && row.mode !== "relay") ||
    (row.status !== "delivered" && row.status !== "verification_failed")
  ) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "RepairAttempt is not a delivered or verification-failed human attempt",
    );
  }
  return Object.freeze({
    id: row.id,
    bugId: row.bug_id,
    sequence: row.sequence,
    mode: row.mode,
    status: row.status,
    assigneeId: row.assignee_id,
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

function readVerification(
  database: DatabaseSync,
  input: MobileRelayScope,
  verificationId: string,
): VerificationRow | null {
  const row = database
    .prepare(
      `SELECT id, bug_id, repair_attempt_id, build_id, status, verifier_id,
              criteria_snapshot, result_summary, failure_reason, blocked_reason,
              version, created_at, updated_at
       FROM verifications
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, verificationId) as VerificationRow | undefined;
  return row ?? null;
}

function readBug(database: DatabaseSync, input: MobileRelayScope, bugId: string): BugRow | null {
  const row = database
    .prepare(
      `SELECT id, project_id, number, key, title, description, expected_behavior,
              module_id, state, severity, priority, reporter_id, owner_id,
              verification_owner_id, duplicate_of_bug_id, occurrence_count,
              reopen_count, version, created_at, updated_at, closed_at,
              active_verification_id
       FROM bugs
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, bugId) as BugRow | undefined;
  return row ?? null;
}

function readAttempt(
  database: DatabaseSync,
  input: MobileRelayScope,
  attemptId: string,
): AttemptRow | null {
  const row = database
    .prepare(
      `SELECT id, bug_id, sequence, mode, status, assignee_id, parent_attempt_id,
              summary, branch, commit_sha, merge_request_url, patch_url,
              no_code_reason, failure_reason, target_build_id, version
       FROM repair_attempts
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, attemptId) as AttemptRow | undefined;
  return row ?? null;
}

function readEligibleWorkflow(
  database: DatabaseSync,
  input: CreateMobileVerificationInput,
): EligibleWorkflowRow | null {
  const row = database
    .prepare(
      `SELECT bug.id, bug.project_id, bug.number, bug.key, bug.title, bug.description,
              bug.expected_behavior, bug.module_id, bug.state, bug.severity, bug.priority,
              bug.reporter_id, bug.owner_id, bug.verification_owner_id,
              bug.duplicate_of_bug_id, bug.occurrence_count, bug.reopen_count,
              bug.version, bug.created_at, bug.updated_at, bug.closed_at,
              bug.active_verification_id AS active_verification_id,
              attempt.id AS attempt_id, attempt.mode AS attempt_mode,
              attempt.status AS attempt_status,
              attempt.assignee_id AS attempt_assignee_id, attempt.sequence AS attempt_sequence,
              attempt.summary AS attempt_summary, attempt.branch AS attempt_branch,
              attempt.commit_sha AS attempt_commit_sha,
              attempt.merge_request_url AS attempt_merge_request_url,
              attempt.target_build_id AS attempt_target_build_id,
              attempt.version AS attempt_version, attempt.updated_at AS attempt_updated_at,
              build.id AS build_id, build.status AS build_status, build.version AS build_version,
              build.source_commit_sha AS build_source_commit_sha,
              requirement.requirement AS requirement_requirement,
              requirement.decision_basis AS requirement_decision_basis,
              requirement.delivered_commit_sha AS requirement_commit_sha,
              requirement.version AS requirement_version,
              requirement.linked_build_id AS requirement_linked_build_id,
              requirement.link_id AS requirement_link_id,
              link.id AS link_id,
              EXISTS (SELECT 1 FROM valid_relay_deliveries AS delivery
                WHERE delivery.attempt_id=attempt.id AND delivery.commit_sha=attempt.commit_sha
                  AND delivery.branch=attempt.branch) AS relay_delivery,
              (
                SELECT completion.id
                FROM events AS completion
                WHERE completion.account_id = requirement.account_id
                  AND completion.project_id = requirement.project_id
                  AND completion.bug_id = requirement.bug_id
                  AND completion.source = 'qa_hub'
                  AND completion.actor_type = 'user'
                  AND completion.type = 'bug.completed_for_verification'
                  AND completion.aggregate_type = 'bug'
                  AND completion.aggregate_id = requirement.bug_id
                  AND completion.resource_type = 'bug'
                  AND completion.resource_id = requirement.bug_id
                  AND completion.from_state = 'awaiting_build'
                  AND completion.to_state = 'ready_for_verification'
                  AND json_extract(completion.payload_json, '$.repairAttemptId') = attempt.id
                  AND json_type(completion.payload_json, '$.reason') = 'text'
                  AND length(trim(json_extract(completion.payload_json, '$.reason'))) > 0
                ORDER BY completion.event_position DESC
                LIMIT 1
              ) AS completion_event_id
       FROM bugs AS bug
       JOIN repair_attempts AS attempt
         ON attempt.account_id = bug.account_id
        AND attempt.project_id = bug.project_id
        AND attempt.bug_id = bug.id
        AND attempt.id = bug.active_repair_attempt_id
       LEFT JOIN build_requirements AS requirement
         ON requirement.account_id = attempt.account_id
        AND requirement.project_id = attempt.project_id
        AND requirement.bug_id = attempt.bug_id
        AND requirement.repair_attempt_id = attempt.id
       LEFT JOIN build_repair_links AS link
         ON link.account_id = requirement.account_id
        AND link.project_id = requirement.project_id
        AND link.bug_id = requirement.bug_id
        AND link.repair_attempt_id = requirement.repair_attempt_id
        AND link.id = requirement.link_id
       LEFT JOIN builds AS build
         ON build.account_id = link.account_id
        AND build.project_id = link.project_id
        AND build.id = link.build_id
       WHERE bug.account_id = ? AND bug.project_id = ? AND bug.id = ?
         AND attempt.id = ?`,
    )
    .get(input.accountId, input.projectId, input.bugId, input.repairAttemptId) as
    EligibleWorkflowRow | undefined;
  return row ?? null;
}

function nextAggregateSequence(
  database: DatabaseSync,
  input: MobileRelayScope,
  verificationId: string,
): number {
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(aggregate_sequence), 0) + 1 AS next_sequence
       FROM events
       WHERE account_id = ? AND project_id = ?
         AND aggregate_type = 'verification' AND aggregate_id = ?`,
    )
    .get(input.accountId, input.projectId, verificationId) as { readonly next_sequence: number };
  return row.next_sequence;
}

function insertVerificationEvent(
  database: DatabaseSync,
  input: MobileRelayScope,
  values: {
    readonly id: string;
    readonly bugId: string;
    readonly type: "verification.created" | "verification.started" | "verification.result_recorded";
    readonly verificationId: string;
    readonly aggregateSequence: number;
    readonly resourceVersionAfter: number;
    readonly requestDigest: string;
    readonly fromState: string | null;
    readonly toState: string | null;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
        resource_type, resource_id, resource_version_after, request_digest,
        correlation_id, from_state, to_state, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, 'qa_hub', 'user', ?, 'verification', ?, ?,
                'verification', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      values.id,
      input.accountId,
      input.projectId,
      values.bugId,
      values.type,
      input.actorId,
      values.verificationId,
      values.aggregateSequence,
      values.verificationId,
      values.resourceVersionAfter,
      values.requestDigest,
      randomUUID(),
      values.fromState,
      values.toState,
      JSON.stringify(values.payload),
      values.createdAt,
    );
}

function readResultEventId(
  database: DatabaseSync,
  input: MobileRelayScope,
  bugId: string,
  verificationId: string,
): string | null {
  const row = database
    .prepare(
      `SELECT id
       FROM events
       WHERE account_id = ? AND project_id = ? AND bug_id = ?
         AND type = 'verification.result_recorded'
         AND aggregate_type = 'verification' AND aggregate_id = ?
       ORDER BY aggregate_sequence DESC
       LIMIT 1`,
    )
    .get(input.accountId, input.projectId, bugId, verificationId) as
    { readonly id: string } | undefined;
  return row?.id ?? null;
}

function readVerificationSubmission(
  database: DatabaseSync,
  input: RecordMobileVerificationResultInput,
): {
  readonly payload_digest: string;
  readonly intent: string;
  readonly capture_bundle_id: string | null;
} | null {
  const row = database
    .prepare(
      `SELECT payload_digest, intent, capture_bundle_id
       FROM submissions
       WHERE account_id = ? AND project_id = ? AND actor_id = ?
         AND client_submission_id = ?`,
    )
    .get(input.accountId, input.projectId, input.actorId, input.clientSubmissionId) as
    | {
        readonly payload_digest: string;
        readonly intent: string;
        readonly capture_bundle_id: string | null;
      }
    | undefined;
  return row ?? null;
}

function loadResultResponse(
  database: DatabaseSync,
  input: RecordMobileVerificationResultInput,
  replayed: boolean,
): MobileVerificationResultResponse {
  const verification = readVerification(database, input, input.verificationId);
  if (!verification) throw new MobileRelayStorageError("NOT_FOUND", "Verification was not found");
  const bug = readBug(database, input, verification.bug_id);
  const attempt = readAttempt(database, input, verification.repair_attempt_id);
  if (!bug || !attempt) {
    throw new MobileRelayStorageError("NOT_FOUND", "Verification result effect is incomplete");
  }
  const eventId = readResultEventId(database, input, bug.id, verification.id);
  if (!eventId) {
    throw new MobileRelayStorageError("NOT_FOUND", "Verification result effect is incomplete");
  }
  const submission = database
    .prepare(
      `SELECT capture_bundle_id
       FROM submissions
       WHERE account_id = ? AND project_id = ? AND actor_id = ?
         AND client_submission_id = ? AND intent = 'verification_result'`,
    )
    .get(input.accountId, input.projectId, input.actorId, input.clientSubmissionId) as
    { readonly capture_bundle_id: string | null } | undefined;
  return Object.freeze({
    clientSubmissionId: input.clientSubmissionId,
    qaItem: Object.freeze({ type: "bug" as const, id: bug.id, key: bug.key }),
    verification: toVerification(verification),
    repairAttempt: toAttempt(attempt),
    bug: toBug(bug),
    attachmentIds: Object.freeze(
      database
        .prepare(
          `SELECT attachment_id
           FROM verification_attachments
           WHERE account_id = ? AND project_id = ? AND verification_id = ?
           ORDER BY attachment_id`,
        )
        .all(input.accountId, input.projectId, verification.id)
        .map((row) => String(row.attachment_id)),
    ),
    captureBundleId: submission?.capture_bundle_id ?? input.captureBundleId,
    eventId,
    replayed,
  });
}

export function createMobileVerification(
  database: DatabaseSync,
  input: CreateMobileVerificationInput,
): MobileVerificationRecord {
  requireTransaction(database);
  requireUuid(input.bugId, "bugId");
  requireUuid(input.repairAttemptId, "repairAttemptId");
  if (input.buildId !== null) requireUuid(input.buildId, "buildId");
  requireVerificationIdentity(input, input.verifierId);
  requireText(input.criteria, "criteria", 10_000);
  requireDigest(input.requestDigest);
  requireTimestamp(input.createdAt);
  requireVerificationCreatorRole(database, input);
  requireVerifierRole(database, input, input.verifierId);
  const workflow = readEligibleWorkflow(database, input);
  if (!workflow)
    throw new MobileRelayStorageError("NOT_FOUND", "eligible delivered workflow was not found");
  const noBuildEligible =
    input.buildId === null &&
    workflow.requirement_requirement === "not_required" &&
    workflow.requirement_decision_basis === "no_code_delivery" &&
    workflow.requirement_version === 1 &&
    workflow.requirement_commit_sha === null &&
    workflow.requirement_linked_build_id === null &&
    workflow.requirement_link_id === null &&
    workflow.link_id === null &&
    workflow.build_id === null &&
    workflow.attempt_commit_sha === null;
  const completedWithoutBuildEligible =
    input.buildId === null &&
    workflow.requirement_requirement === "required" &&
    workflow.requirement_decision_basis === "code_requires_build" &&
    workflow.requirement_version === 1 &&
    workflow.requirement_linked_build_id === null &&
    workflow.requirement_link_id === null &&
    workflow.link_id === null &&
    workflow.build_id === null &&
    workflow.requirement_commit_sha !== null &&
    workflow.requirement_commit_sha === workflow.attempt_commit_sha &&
    workflow.completion_event_id !== null;
  const requiredBuildEligible =
    input.buildId !== null &&
    workflow.requirement_requirement === "required" &&
    workflow.requirement_decision_basis === "code_requires_build" &&
    workflow.requirement_version === 2 &&
    workflow.requirement_linked_build_id === input.buildId &&
    workflow.requirement_link_id === workflow.link_id &&
    workflow.link_id !== null &&
    workflow.build_status === "ready" &&
    workflow.build_id === input.buildId &&
    workflow.requirement_commit_sha === workflow.attempt_commit_sha &&
    workflow.build_source_commit_sha === workflow.attempt_commit_sha;
  if (
    workflow.version !== input.expectedVersion ||
    workflow.state !== "ready_for_verification" ||
    (workflow.attempt_mode !== "human" && workflow.attempt_mode !== "relay") ||
    workflow.attempt_status !== "delivered" ||
    workflow.attempt_version !== 3 ||
    (!noBuildEligible &&
      !completedWithoutBuildEligible &&
      !requiredBuildEligible &&
      !(
        workflow.attempt_mode === "relay" &&
        workflow.relay_delivery === 1 &&
        input.buildId === null
      ))
  ) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "workflow is not an exact eligible Verification target",
    );
  }
  if (workflow.active_verification_id !== null) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "Bug already has an active Verification");
  }
  const verificationId = randomUUID();
  const at = nextTimestamp(input.createdAt, workflow.updated_at);
  const eventId = randomUUID();
  insertVerificationEvent(database, input, {
    id: eventId,
    bugId: workflow.id,
    type: "verification.created",
    verificationId,
    aggregateSequence: 1,
    resourceVersionAfter: 1,
    requestDigest: input.requestDigest,
    fromState: null,
    toState: null,
    payload: {
      status: "requested",
      verificationId,
      repairAttemptId: input.repairAttemptId,
      ...(input.buildId === null ? {} : { buildId: input.buildId }),
      toVersion: 1,
    },
    createdAt: at,
  });
  database
    .prepare(
      `INSERT INTO verifications(
        id, account_id, project_id, bug_id, repair_attempt_id, status,
        verifier_id, build_id, criteria_snapshot, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      verificationId,
      input.accountId,
      input.projectId,
      workflow.id,
      input.repairAttemptId,
      input.verifierId,
      input.buildId,
      input.criteria,
      at,
      at,
    );
  const updatedBug = database
    .prepare(
      `UPDATE bugs
       SET active_verification_id = ?, updated_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND id = ?
         AND state = 'ready_for_verification' AND version = ?
         AND active_repair_attempt_id = ? AND active_verification_id IS NULL`,
    )
    .run(
      verificationId,
      at,
      input.accountId,
      input.projectId,
      workflow.id,
      input.expectedVersion,
      input.repairAttemptId,
    );
  if (updatedBug.changes !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Bug did not bind Verification exactly once",
    );
  }
  const row = readVerification(database, input, verificationId);
  if (!row) throw new MobileRelayStorageError("NOT_FOUND", "Verification was not created");
  return toVerification(row);
}

export function getMobileVerification(
  database: DatabaseSync,
  input: GetMobileVerificationInput,
): MobileVerificationRecord | null {
  requireUuid(input.verificationId, "verificationId");
  const row = readVerification(database, input, input.verificationId);
  return row ? toVerification(row) : null;
}

export function startMobileVerification(
  database: DatabaseSync,
  input: StartMobileVerificationInput,
): MobileVerificationRecord {
  requireTransaction(database);
  requireUuid(input.verificationId, "verificationId");
  requireVerificationIdentity(input, input.actorId);
  requireDigest(input.requestDigest);
  requireTimestamp(input.createdAt);
  requireVerifierRole(database, input);
  const current = readVerification(database, input, input.verificationId);
  if (!current) throw new MobileRelayStorageError("NOT_FOUND", "Verification was not found");
  if (current.status !== "requested" || current.version !== input.expectedVersion) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Verification is not requested at the expected version",
    );
  }
  const at = nextTimestamp(input.createdAt, current.updated_at);
  const eventId = randomUUID();
  const payload: Record<string, unknown> = {
    status: "in_progress",
    verificationId: current.id,
    fromVersion: current.version,
    toVersion: current.version + 1,
  };
  if (input.reason !== null) {
    requireText(input.reason, "reason", 2_000);
    payload.reason = input.reason;
  }
  insertVerificationEvent(database, input, {
    id: eventId,
    bugId: current.bug_id,
    type: "verification.started",
    verificationId: current.id,
    aggregateSequence: nextAggregateSequence(database, input, current.id),
    resourceVersionAfter: current.version + 1,
    requestDigest: input.requestDigest,
    fromState: null,
    toState: null,
    payload,
    createdAt: at,
  });
  const updated = database
    .prepare(
      `UPDATE verifications
       SET status = 'in_progress', updated_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND id = ?
         AND status = 'requested' AND version = ?`,
    )
    .run(at, input.accountId, input.projectId, current.id, input.expectedVersion);
  if (updated.changes !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Verification did not start exactly once",
    );
  }
  const row = readVerification(database, input, current.id);
  if (!row) throw new MobileRelayStorageError("NOT_FOUND", "Verification disappeared after start");
  return toVerification(row);
}

function claimVerificationAttachments(
  database: DatabaseSync,
  input: RecordMobileVerificationResultInput,
  bugId: string,
): void {
  let totalBytes = 0;
  for (const attachmentId of input.attachmentIds) {
    const reservation = database
      .prepare(
        `
      SELECT binding.id, binding.version, attachment.size_bytes
      FROM attachment_bindings AS binding
      JOIN attachments AS attachment ON attachment.account_id=binding.account_id
        AND attachment.project_id=binding.project_id AND attachment.id=binding.attachment_id
      JOIN blobs AS blob ON blob.account_id=attachment.account_id AND blob.id=attachment.blob_id
        AND blob.sha256=attachment.sha256 AND blob.size_bytes=attachment.size_bytes AND blob.state='ready'
      JOIN upload_sessions AS upload ON upload.account_id=attachment.account_id
        AND upload.project_id=attachment.project_id AND upload.id=attachment.upload_session_id
        AND upload.status='finalized' AND upload.finalized_attachment_id=attachment.id
      WHERE binding.account_id=? AND binding.project_id=? AND binding.attachment_id=?
        AND binding.intent='verification_result' AND binding.target_bug_id=?
        AND binding.state='reserved' AND unixepoch(binding.expires_at)>unixepoch('now')
        AND binding.bound_by_actor_id=? AND attachment.actor_id=?
        AND attachment.client_submission_id=? AND attachment.status='ready' AND attachment.scan_state='clean'
    `,
      )
      .get(
        input.accountId,
        input.projectId,
        attachmentId,
        bugId,
        input.actorId,
        input.actorId,
        input.clientSubmissionId,
      ) as { id: string; version: number; size_bytes: number } | undefined;
    if (!reservation)
      throw new MobileRelayStorageError(
        "INVALID_REQUEST",
        "Verification attachment requires its exact active reservation",
      );
    totalBytes += reservation.size_bytes;
    if (totalBytes > 100 * 1024 * 1024)
      throw new MobileRelayStorageError(
        "INVALID_REQUEST",
        "Verification attachments must total at most 100 MB",
      );
    database
      .prepare(
        `UPDATE attachment_bindings SET state='claimed', expires_at=NULL,
      claimed_at=?, version=version+1 WHERE id=? AND version=? AND state='reserved'`,
      )
      .run(input.createdAt, reservation.id, reservation.version);
    database
      .prepare(
        `UPDATE attachments SET version=version+1 WHERE account_id=? AND project_id=? AND id=?`,
      )
      .run(input.accountId, input.projectId, attachmentId);
    database
      .prepare(
        `INSERT INTO verification_attachments(account_id,project_id,verification_id,attachment_id,binding_id)
      VALUES (?,?,?,?,?)`,
      )
      .run(input.accountId, input.projectId, input.verificationId, attachmentId, reservation.id);
  }
}

export function recordMobileVerificationResult(
  database: DatabaseSync,
  input: RecordMobileVerificationResultInput,
): MobileVerificationResultResponse {
  requireTransaction(database);
  requireUuid(input.verificationId, "verificationId");
  requireUuid(input.clientSubmissionId, "clientSubmissionId");
  requireVerificationIdentity(input, input.actorId);
  requireText(input.resultSummary, "resultSummary", 10_000);
  if (input.status === "failed") {
    requireText(input.failureReason, "failureReason", 5_000);
  }
  requireDigest(input.requestDigest);
  requireTimestamp(input.createdAt);
  if (
    input.attachmentIds.length > 8 ||
    new Set(input.attachmentIds).size !== input.attachmentIds.length ||
    input.captureBundleId !== null
  ) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "Verification accepts at most 8 unique attachments and no capture bundle",
    );
  }
  for (const attachmentId of input.attachmentIds) requireUuid(attachmentId, "attachmentId");
  const prior = readVerificationSubmission(database, input);
  if (prior) {
    if (prior.intent !== "verification_result" || prior.payload_digest !== input.requestDigest) {
      throw new MobileRelayStorageError(
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
        "client submission was already used with another Verification result",
      );
    }
    return loadResultResponse(database, input, true);
  }
  const current = readVerification(database, input, input.verificationId);
  if (!current) throw new MobileRelayStorageError("NOT_FOUND", "Verification was not found");
  const bug = readBug(database, input, current.bug_id);
  if (!bug) throw new MobileRelayStorageError("NOT_FOUND", "Verification Bug was not found");
  if (!hasProjectMembership(database, input, input.actorId))
    throw new MobileRelayStorageError("FORBIDDEN", "actor has no active project membership");
  if (
    current.status !== "in_progress" ||
    current.version !== input.expectedVersion ||
    bug.state !== "ready_for_verification" ||
    bug.active_verification_id !== current.id
  ) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Verification is not active at the expected version",
    );
  }
  const attempt = readAttempt(database, input, current.repair_attempt_id);
  if (!attempt || attempt.status !== "delivered" || attempt.version !== 3) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Verification attempt is not an exact delivered Attempt",
    );
  }
  // Starting a Verification advances the Verification clock without mutating the Bug.
  // The result writes both facts, so its timestamp must advance from the newer Verification.
  const at = nextTimestamp(input.createdAt, current.updated_at);
  claimVerificationAttachments(database, input, bug.id);
  const eventId = randomUUID();
  const nextBugState = input.status === "passed" ? "closed" : "ready";
  insertVerificationEvent(database, input, {
    id: eventId,
    bugId: bug.id,
    type: "verification.result_recorded",
    verificationId: current.id,
    aggregateSequence: nextAggregateSequence(database, input, current.id),
    resourceVersionAfter: current.version + 1,
    requestDigest: input.requestDigest,
    fromState: "ready_for_verification",
    toState: nextBugState,
    payload: {
      status: input.status,
      summary: toBoundedAuditText(input.resultSummary, input.status === "failed" ? 1_500 : 2_000),
      ...(input.status === "failed"
        ? { reason: toBoundedAuditText(input.failureReason, 1_500) }
        : {}),
      verificationId: current.id,
      repairAttemptId: current.repair_attempt_id,
      ...(current.build_id === null ? {} : { buildId: current.build_id }),
      fromVersion: current.version,
      toVersion: current.version + 1,
    },
    createdAt: at,
  });
  insertBugNotificationOutbox(database, {
    ...input,
    bugId: bug.id,
    eventId,
    eventType: "verification.result_recorded",
    bugVersion: bug.version + 1,
    createdAt: at,
  });
  const updatedVerification = database
    .prepare(
      `UPDATE verifications
       SET status = ?, result_summary = ?, failure_reason = ?, blocked_reason = NULL,
           updated_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND id = ?
         AND status = 'in_progress' AND version = ?`,
    )
    .run(
      input.status,
      input.resultSummary,
      input.failureReason,
      at,
      input.accountId,
      input.projectId,
      current.id,
      input.expectedVersion,
    );
  if (updatedVerification.changes !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Verification result was not recorded exactly once",
    );
  }
  if (input.status === "failed") {
    const updatedAttempt = database
      .prepare(
        `UPDATE repair_attempts
         SET status = 'verification_failed', updated_at = ?, version = version + 1
         WHERE account_id = ? AND project_id = ? AND id = ?
           AND status = 'delivered' AND version = ?`,
      )
      .run(at, input.accountId, input.projectId, attempt.id, attempt.version);
    if (updatedAttempt.changes !== 1) {
      throw new MobileRelayStorageError(
        "VERSION_CONFLICT",
        "RepairAttempt did not enter verification_failed exactly once",
      );
    }
  }
  const updatedBug =
    input.status === "passed"
      ? database
          .prepare(
            `UPDATE bugs
             SET state = 'closed', active_repair_attempt_id = NULL,
                 active_verification_id = NULL, closed_at = ?, updated_at = ?,
                 version = version + 1
             WHERE account_id = ? AND project_id = ? AND id = ?
               AND state = 'ready_for_verification' AND version = ?
               AND active_repair_attempt_id = ? AND active_verification_id = ?`,
          )
          .run(
            at,
            at,
            input.accountId,
            input.projectId,
            bug.id,
            bug.version,
            attempt.id,
            current.id,
          )
      : database
          .prepare(
            `UPDATE bugs
             SET state = 'ready', active_repair_attempt_id = NULL,
                 active_verification_id = NULL, updated_at = ?, version = version + 1
             WHERE account_id = ? AND project_id = ? AND id = ?
               AND state = 'ready_for_verification' AND version = ?
               AND active_repair_attempt_id = ? AND active_verification_id = ?`,
          )
          .run(at, input.accountId, input.projectId, bug.id, bug.version, attempt.id, current.id);
  if (updatedBug.changes !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      `Bug did not enter ${nextBugState} exactly once`,
    );
  }
  database
    .prepare(
      `INSERT INTO submissions(
        id, account_id, project_id, actor_id, client_submission_id, intent,
        payload_digest, bug_id, occurrence_id, comment_id, verification_id,
        capture_bundle_id, response_json, committed_at, version
      ) VALUES (?, ?, ?, ?, ?, 'verification_result', ?, ?, NULL, NULL, ?, NULL, ?, ?, 1)`,
    )
    .run(
      randomUUID(),
      input.accountId,
      input.projectId,
      input.actorId,
      input.clientSubmissionId,
      input.requestDigest,
      bug.id,
      current.id,
      JSON.stringify({
        clientSubmissionId: input.clientSubmissionId,
        projectId: input.projectId,
        bugId: bug.id,
        occurrenceId: null,
        commentId: null,
        verificationId: current.id,
        captureBundleId: null,
      }),
      at,
    );
  if (input.status === "failed" && attempt.mode === "relay") {
    queueRelayRework(database, {
      accountId: input.accountId,
      projectId: input.projectId,
      actorId: input.actorId,
      bugId: bug.id,
      verificationId: current.id,
      previousAttemptId: attempt.id,
      expectedBugVersion: bug.version + 1,
      createdAt: at,
    });
  } else if (input.status === "passed" && attempt.mode === "relay") {
    queueRelayAcceptance(database, {
      ...input,
      attemptId: attempt.id,
      verificationId: current.id,
      createdAt: at,
    });
  }
  return loadResultResponse(database, input, false);
}
