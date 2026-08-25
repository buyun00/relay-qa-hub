import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { MobileBugRecord, MobileScopeBootstrap } from "./mobile-bug-store.js";
import type { MobileBuildRecord } from "./mobile-build-store.js";

export const MOBILE_FAKE_RELAY_INSTANCE_ID = "fake-relay-local" as const;
export const MOBILE_FAKE_RELAY_PRINCIPAL_ID = "10000000-0000-4000-8000-000000000007" as const;

const RELAY_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
const NOTIFICATION_DESTINATION = "qa-hub.notifications";
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const RELAY_INSTANCE_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export class MobileRelayStorageError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "NOT_FOUND"
      | "VERSION_CONFLICT"
      | "IDEMPOTENCY_PAYLOAD_MISMATCH"
      | "INTEGRATION_EVENT_CONFLICT"
      | "INTEGRATION_AUTOMATION_FORBIDDEN"
      | "RELAY_DELIVERY_EVIDENCE_INVALID"
      | "BUILD_IDENTITY_MISMATCH"
      | "GUARD_FAILED"
      | "FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "MobileRelayStorageError";
  }
}

export interface MobileRelayScope {
  readonly accountId: string;
  readonly projectId: string;
  readonly actorId: string;
}

export interface TransitionMobileBugInput extends MobileRelayScope {
  readonly bugId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export interface UpdateMobileBugInput extends MobileRelayScope {
  readonly bugId: string;
  readonly expectedVersion: number;
  readonly title?: string;
  readonly description?: string;
  readonly expectedBehavior?: string;
  readonly moduleId?: string | null;
  readonly severity?: MobileBugRecord["severity"];
  readonly priority?: MobileBugRecord["priority"];
  readonly ownerId?: string | null;
  readonly verificationOwnerId?: string | null;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export interface CreateMobileRelayAttemptInput extends MobileRelayScope {
  readonly bugId: string;
  readonly expectedVersion: number;
  readonly assigneeId: string;
  readonly summary: string | null;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

/** The QA Hub manual/offline lane uses the frozen human repair mode. */
export interface CreateMobileManualRepairAttemptInput extends MobileRelayScope {
  readonly bugId: string;
  readonly expectedVersion: number;
  readonly assigneeId: string;
  readonly summary: string | null;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export interface StartMobileRepairAttemptInput extends MobileRelayScope {
  readonly attemptId: string;
  readonly expectedVersion: number;
  readonly reason: string | null;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export interface DeliverMobileRepairAttemptInput extends MobileRelayScope {
  readonly attemptId: string;
  readonly expectedVersion: number;
  readonly summary: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly mergeRequestUrl: string | null;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export interface MobileRepairAttemptRecord {
  readonly id: string;
  readonly bugId: string;
  readonly sequence: number;
  readonly mode: "relay";
  readonly status: "planned";
  readonly assigneeId: string;
  readonly parentAttemptId: null;
  readonly summary: string | null;
  readonly branch: null;
  readonly commitSha: null;
  readonly mergeRequestUrl: null;
  readonly targetBuildId: null;
  readonly version: 1;
}

export interface MobileManualRepairAttemptRecord {
  readonly id: string;
  readonly bugId: string;
  readonly sequence: number;
  readonly mode: "human";
  readonly status: "planned" | "running" | "delivered";
  readonly assigneeId: string;
  readonly parentAttemptId: null;
  readonly summary: string | null;
  readonly branch: string | null;
  readonly commitSha: string | null;
  readonly mergeRequestUrl: string | null;
  readonly targetBuildId: null;
  readonly version: number;
}

export interface MobileBuildRequirementRecord {
  readonly id: string;
  readonly projectId: string;
  readonly bugId: string;
  readonly repairAttemptId: string;
  readonly sourceDeliveryVersion: number;
  readonly deliveredCommitSha: string | null;
  readonly requirement: "required" | "not_required";
  readonly decisionBasis:
    "code_requires_build" | "no_code_delivery" | "authorized_no_build_exemption";
  readonly decisionReason: string | null;
  readonly decisionActorId: string;
  readonly decisionAuditEventId: string;
  readonly linkedBuildId: string | null;
  readonly linkId: string | null;
  readonly policyVersion: "1.0.0";
  readonly bugVersionAtDelivery: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: 1 | 2;
}

export interface MobileBuildRepairLinkRecord {
  readonly id: string;
  readonly buildId: string;
  readonly repairAttemptId: string;
  readonly bugId: string;
  readonly projectId: string;
  readonly buildRequirementId: string;
  readonly buildRequirementVersion: 2;
  readonly deliveredCommitSha: string;
  readonly evidenceType: "manifest" | "release_manager_override";
  readonly evidenceDecision: "manifest_verified" | "release_manager_authorized";
  readonly overrideReason: string | null;
  readonly evidenceActorId: string;
  readonly evidenceAuditEventId: string;
  readonly evidencePolicyVersion: "1.0.0";
  readonly linkedAt: string;
  readonly version: 1;
}

export interface LinkMobileBuildRepairInput extends MobileRelayScope {
  readonly buildId: string;
  readonly expectedVersion: number;
  readonly expectedBugVersion?: number;
  readonly expectedBuildRequirementVersion?: number;
  readonly repairAttemptId: string;
  readonly deliveredCommitSha: string;
  readonly evidenceType: "manifest";
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export interface LinkMobileBuildRepairResult {
  readonly build: MobileBuildRecord;
  readonly bug: MobileBugRecord;
  readonly buildRequirement: MobileBuildRequirementRecord;
  readonly repairLink: MobileBuildRepairLinkRecord;
  readonly eventId: string;
  readonly replayed: boolean;
}

export interface GetMobileManualRepairAttemptInput extends MobileRelayScope {
  readonly attemptId: string;
}

export interface DispatchMobileRelayInput extends MobileRelayScope {
  readonly attemptId: string;
  readonly expectedVersion: number;
  readonly handoffId: string;
  readonly selectedAttachmentIds: readonly string[];
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export interface MobileRelayDispatchAccepted {
  readonly qaItem: { readonly type: "bug"; readonly id: string; readonly key: string };
  readonly repairAttemptId: string;
  readonly handoffId: string;
  readonly relayInstanceId: typeof MOBILE_FAKE_RELAY_INSTANCE_ID;
  readonly outboxMessageId: string;
  readonly requestId: string;
  readonly status: "queued";
  readonly replayed: boolean;
}

export interface MobileRelayReceipt {
  readonly qaItem: { readonly type: "bug"; readonly id: string; readonly key: string };
  readonly repairAttemptId: string;
  readonly handoffId: string;
  readonly relayInstanceId: string;
  readonly relayTaskId: string | null;
  readonly handoffStatus:
    | "queued"
    | "submitted"
    | "running"
    | "needs_input"
    | "blocked"
    | "failed"
    | "fix_delivered"
    | "awaiting_build"
    | "awaiting_verification";
  readonly buildRequirement: "not_required" | "required";
  readonly buildEvidenceStatus: "not_required" | "pending" | "exact_commit_eligible";
  readonly deliveredCommitSha: string | null;
  readonly buildId: string | null;
  readonly externalRevision: number;
  readonly requiresHumanVerification: true;
  readonly automationAuthority: "delivery_build_projection_only";
  readonly lastEventAt: string;
  readonly failureSummary: string | null;
  readonly version: number;
}

export interface MobileRelayOutboxClaim {
  readonly outboxMessageId: string;
  readonly bugId: string;
  readonly repairAttemptId: string;
  readonly handoffId: string;
  readonly relayInstanceId: typeof MOBILE_FAKE_RELAY_INSTANCE_ID;
  readonly idempotencyKey: string;
  readonly payloadDigest: string;
  readonly selectedAttachmentIds: readonly string[];
  readonly leaseOwner: string;
  readonly attemptCount: number;
}

export interface CompleteMobileRelayOutboxInput {
  readonly outboxMessageId: string;
  readonly leaseOwner: string;
  readonly relayTaskId: string;
  readonly handoffStatus: "submitted";
  readonly externalRevision: number;
  readonly lastEventAt: string;
  readonly payloadDigest: string;
  readonly receivedAt: string;
}

export interface RetryMobileRelayOutboxInput {
  readonly outboxMessageId: string;
  readonly leaseOwner: string;
  readonly errorCode: string;
  readonly nextAttemptAt: string;
}

/**
 * The webhook parser owns authentication and wire-shape validation.  Storage
 * still receives the raw envelope and rechecks its identity before it can
 * touch an integration projection.  Keeping the raw JSON here is intentional:
 * it is the durable replay/conflict evidence in inbox.payload_json.
 */
export interface ReceiveMobileRelayWebhookInput {
  readonly accountId: string;
  readonly projectId: string;
  readonly relayInstanceId: string;
  readonly eventId: string;
  readonly deliveryId: string;
  readonly eventType: "turn.delivered";
  readonly handoffId: string;
  readonly attemptId: string;
  readonly externalRevision: number;
  readonly occurredAt: string;
  readonly taskId: number;
  readonly turnId: number;
  readonly statusReason?: string | null;
  readonly commitSha: string;
  readonly remoteSha: string;
  readonly branch: string;
  readonly mergeRequestUrl?: string | null;
  readonly payloadDigest: string;
  readonly rawPayloadJson: string;
  readonly receivedAt: string;
}

export interface MobileRelayWebhookProjectionResult {
  readonly inboxMessageId: string;
  readonly replayed: boolean;
  readonly projectionStatus: "applied" | "ignored" | "replayed";
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
  readonly target_build_id: string | null;
  readonly patch_url?: string | null;
  readonly no_code_reason?: string | null;
  readonly failure_reason?: string | null;
  readonly updated_at?: string;
  readonly version: number;
  readonly bug_key?: string;
  readonly bug_version?: number;
}

interface ReceiptRow {
  readonly bug_id: string;
  readonly bug_key: string;
  readonly repair_attempt_id: string;
  readonly handoff_id: string;
  readonly relay_instance_id: string;
  readonly relay_task_id: string | null;
  readonly handoff_status: MobileRelayReceipt["handoffStatus"];
  readonly build_requirement: MobileRelayReceipt["buildRequirement"];
  readonly build_evidence_status: MobileRelayReceipt["buildEvidenceStatus"];
  readonly delivered_commit_sha: string | null;
  readonly build_id: string | null;
  readonly external_revision: number;
  readonly last_event_at: string;
  readonly failure_summary: string | null;
  readonly version: number;
}

interface RelayWebhookReceiptRow extends ReceiptRow {
  readonly receipt_id: string;
  readonly integration_link_id: string;
  readonly payload_digest: string;
  readonly bug_id: string;
}

interface InboxRow {
  readonly id: string;
  readonly external_event_id: string;
  readonly delivery_id: string;
  readonly payload_digest: string;
  readonly status: string;
}

function requireTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "mobile Relay storage requires the caller's write transaction",
    );
  }
}

function nextTimestamp(candidate: string, floor: string): string {
  const candidateMs = Date.parse(candidate);
  const floorMs = Date.parse(floor);
  if (!Number.isFinite(candidateMs) || !Number.isFinite(floorMs)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "workflow timestamp is invalid");
  }
  return new Date(Math.max(candidateMs, floorMs + 1)).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRelayString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `Relay webhook ${field} is invalid`);
  }
  return value;
}

function requireRelayUuid(value: unknown, field: string): string {
  const parsed = requireRelayString(value, field, 36, 36);
  if (!UUID_PATTERN.test(parsed)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `Relay webhook ${field} is invalid`);
  }
  return parsed;
}

function requireRelayTimestamp(value: unknown, field: string): string {
  const parsed = requireRelayString(value, field, 20, 100);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `Relay webhook ${field} is invalid`);
  }
  return parsed;
}

function requireRelayPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `Relay webhook ${field} is invalid`);
  }
  return value as number;
}

function requireRelayKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new MobileRelayStorageError(
        "INVALID_REQUEST",
        `Relay webhook ${field} has unknown data`,
      );
    }
  }
}

function validateRawRelayWebhook(input: ReceiveMobileRelayWebhookInput): void {
  if (input.eventType !== "turn.delivered") {
    throw new MobileRelayStorageError("INVALID_REQUEST", "Relay webhook event type is unsupported");
  }
  const relayInstanceId = requireRelayString(input.relayInstanceId, "relayInstanceId", 3, 64);
  if (!RELAY_INSTANCE_PATTERN.test(relayInstanceId)) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "Relay webhook relayInstanceId is invalid",
    );
  }
  const eventId = requireRelayUuid(input.eventId, "eventId");
  const handoffId = requireRelayUuid(input.handoffId, "handoffId");
  const attemptId = requireRelayUuid(input.attemptId, "attemptId");
  const deliveryId = requireRelayString(input.deliveryId, "deliveryId", 1, 300);
  const externalRevision = requireRelayPositiveInteger(input.externalRevision, "externalRevision");
  const occurredAt = requireRelayTimestamp(input.occurredAt, "occurredAt");
  requireRelayTimestamp(input.receivedAt, "receivedAt");
  const taskId = requireRelayPositiveInteger(input.taskId, "taskId");
  const turnId = requireRelayPositiveInteger(input.turnId, "turnId");
  const branch = requireRelayString(input.branch, "branch", 1, 300);
  const commitSha = requireRelayString(input.commitSha, "commitSha", 40, 40);
  const remoteSha = requireRelayString(input.remoteSha, "remoteSha", 40, 40);
  if (
    !COMMIT_PATTERN.test(commitSha) ||
    !COMMIT_PATTERN.test(remoteSha) ||
    commitSha !== remoteSha
  ) {
    throw new MobileRelayStorageError(
      "RELAY_DELIVERY_EVIDENCE_INVALID",
      "Relay delivery evidence must contain matching verified commit SHAs",
    );
  }
  if (
    input.statusReason !== undefined &&
    input.statusReason !== null &&
    (typeof input.statusReason !== "string" || input.statusReason.length > 5_000)
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "Relay webhook statusReason is invalid");
  }
  if (
    input.mergeRequestUrl !== undefined &&
    input.mergeRequestUrl !== null &&
    (typeof input.mergeRequestUrl !== "string" || input.mergeRequestUrl.length > 2_048)
  ) {
    throw new MobileRelayStorageError(
      "RELAY_DELIVERY_EVIDENCE_INVALID",
      "Relay merge request URL is invalid",
    );
  }
  const payloadDigest = requireRelayString(input.payloadDigest, "payloadDigest", 64, 64);
  if (!SHA256_PATTERN.test(payloadDigest)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "Relay webhook payloadDigest is invalid");
  }
  if (
    typeof input.rawPayloadJson !== "string" ||
    input.rawPayloadJson.length === 0 ||
    Buffer.byteLength(input.rawPayloadJson, "utf8") > RELAY_WEBHOOK_MAX_BODY_BYTES
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "Relay webhook raw payload is invalid");
  }
  const computedDigest = createHash("sha256").update(input.rawPayloadJson, "utf8").digest("hex");
  if (computedDigest !== payloadDigest) {
    throw new MobileRelayStorageError(
      "INTEGRATION_EVENT_CONFLICT",
      "Relay webhook payload digest does not match its raw JSON",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(input.rawPayloadJson) as unknown;
  } catch {
    throw new MobileRelayStorageError("INVALID_REQUEST", "Relay webhook raw payload is not JSON");
  }
  if (!isRecord(decoded)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "Relay webhook envelope is invalid");
  }
  requireRelayKeys(
    decoded,
    new Set([
      "schemaVersion",
      "relayInstanceId",
      "eventId",
      "deliveryId",
      "eventType",
      "handoffId",
      "attemptId",
      "externalRevision",
      "occurredAt",
      "payload",
    ]),
    "envelope",
  );
  if (
    decoded.schemaVersion !== "1.0" ||
    decoded.relayInstanceId !== relayInstanceId ||
    decoded.eventId !== eventId ||
    decoded.deliveryId !== deliveryId ||
    decoded.eventType !== "turn.delivered" ||
    decoded.handoffId !== handoffId ||
    decoded.attemptId !== attemptId ||
    decoded.externalRevision !== externalRevision ||
    decoded.occurredAt !== occurredAt
  ) {
    throw new MobileRelayStorageError(
      "INTEGRATION_EVENT_CONFLICT",
      "Relay webhook envelope identity does not match its authenticated request",
    );
  }
  if (!isRecord(decoded.payload)) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "Relay webhook delivery payload is invalid",
    );
  }
  requireRelayKeys(
    decoded.payload,
    new Set(["taskId", "turnId", "statusReason", "deliveryEvidence"]),
    "payload",
  );
  if (decoded.payload.taskId !== taskId || decoded.payload.turnId !== turnId) {
    throw new MobileRelayStorageError(
      "INTEGRATION_EVENT_CONFLICT",
      "Relay webhook delivery payload does not match its authenticated request",
    );
  }
  if (!isRecord(decoded.payload.deliveryEvidence)) {
    throw new MobileRelayStorageError(
      "RELAY_DELIVERY_EVIDENCE_INVALID",
      "Relay delivery evidence is invalid",
    );
  }
  requireRelayKeys(
    decoded.payload.deliveryEvidence,
    new Set(["pushed", "verified", "commitSha", "remoteSha", "branch", "mergeRequestUrl"]),
    "deliveryEvidence",
  );
  if (
    decoded.payload.deliveryEvidence.pushed !== true ||
    decoded.payload.deliveryEvidence.verified !== true ||
    decoded.payload.deliveryEvidence.commitSha !== commitSha ||
    decoded.payload.deliveryEvidence.remoteSha !== remoteSha ||
    decoded.payload.deliveryEvidence.branch !== branch
  ) {
    throw new MobileRelayStorageError(
      "RELAY_DELIVERY_EVIDENCE_INVALID",
      "Relay delivery evidence does not match its authenticated request",
    );
  }
}

function readBugRow(
  database: DatabaseSync,
  scope: MobileRelayScope,
  bugId: string,
): BugRow | undefined {
  return database
    .prepare(
      `SELECT id, project_id, number, key, title, description, expected_behavior,
              module_id, state, severity, priority, reporter_id, owner_id,
              verification_owner_id, duplicate_of_bug_id, occurrence_count,
              reopen_count, version, created_at, updated_at, closed_at
       FROM bugs
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(scope.accountId, scope.projectId, bugId) as BugRow | undefined;
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

function insertUserEvent(
  database: DatabaseSync,
  input: MobileRelayScope & {
    readonly id: string;
    readonly bugId: string;
    readonly type: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly aggregateSequence: number;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly resourceVersionAfter: number;
    readonly requestDigest: string;
    readonly correlationId: string;
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
      ) VALUES (?, ?, ?, ?, ?, 'qa_hub', 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.accountId,
      input.projectId,
      input.bugId,
      input.type,
      input.actorId,
      input.aggregateType,
      input.aggregateId,
      input.aggregateSequence,
      input.resourceType,
      input.resourceId,
      input.resourceVersionAfter,
      input.requestDigest,
      input.correlationId,
      input.fromState,
      input.toState,
      JSON.stringify(input.payload),
      input.createdAt,
    );
}

function nextBugAggregateSequence(
  database: DatabaseSync,
  input: MobileRelayScope,
  bugId: string,
): number {
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(aggregate_sequence), 0) + 1 AS next_sequence
       FROM events
       WHERE account_id = ? AND project_id = ?
         AND aggregate_type = 'bug' AND aggregate_id = ?`,
    )
    .get(input.accountId, input.projectId, bugId) as { readonly next_sequence: number };
  return row.next_sequence;
}

function insertBugNotificationOutbox(
  database: DatabaseSync,
  input: MobileRelayScope & {
    readonly bugId: string;
    readonly eventId: string;
    readonly eventType: string;
    readonly bugVersion: number;
    readonly createdAt: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO outbox(
        id, account_id, project_id, aggregate_type, aggregate_id, aggregate_version,
        destination, dedupe_key, event_id, payload_json, status, attempt_count,
        next_attempt_at, lease_owner, lease_expires_at, last_error_code, created_at, sent_at
      ) VALUES (?, ?, ?, 'bug', ?, ?, ?, ?, ?, ?, 'pending', 0, ?,
                NULL, NULL, NULL, ?, NULL)`,
    )
    .run(
      randomUUID(),
      input.accountId,
      input.projectId,
      input.bugId,
      input.bugVersion,
      NOTIFICATION_DESTINATION,
      `notification:${input.eventId}`,
      input.eventId,
      JSON.stringify({
        eventId: input.eventId,
        eventType: input.eventType,
        bugId: input.bugId,
      }),
      input.createdAt,
      input.createdAt,
    );
}

function updateBugScopeDigest(input: UpdateMobileBugInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        accountId: input.accountId,
        actorId: input.actorId,
        projectId: input.projectId,
        operationId: "updateBug",
      }),
    )
    .digest("hex");
}

function assertBugUpdateActor(database: DatabaseSync, input: UpdateMobileBugInput): void {
  const authorized = database
    .prepare(
      `SELECT 1 AS present
       FROM accounts AS account_row
       JOIN projects AS project
         ON project.account_id = account_row.id
        AND project.id = ?
        AND project.status = 'active'
       JOIN users AS actor
         ON actor.account_id = account_row.id
        AND actor.id = ?
        AND actor.status = 'active'
       JOIN memberships AS membership
         ON membership.account_id = account_row.id
        AND membership.project_id = project.id
        AND membership.user_id = actor.id
        AND membership.status = 'active'
       JOIN membership_roles AS role
         ON role.account_id = membership.account_id
        AND role.project_id = membership.project_id
        AND role.membership_id = membership.id
        AND role.role IN ('triager', 'project_admin')
       WHERE account_row.id = ?`,
    )
    .get(input.projectId, input.actorId, input.accountId);
  if (!authorized) {
    throw new MobileRelayStorageError(
      "FORBIDDEN",
      "Bug updates require an active triager or project admin membership",
    );
  }
}

function assertAssignableMember(
  database: DatabaseSync,
  input: UpdateMobileBugInput,
  userId: string,
  rolePredicate: string,
  label: string,
): void {
  const assignable = database
    .prepare(
      `SELECT 1 AS present
       FROM accounts AS account_row
       JOIN projects AS project
         ON project.account_id = account_row.id
        AND project.id = ?
        AND project.status = 'active'
       JOIN users AS assigned_user
         ON assigned_user.account_id = account_row.id
        AND assigned_user.id = ?
        AND assigned_user.status = 'active'
       JOIN memberships AS membership
         ON membership.account_id = account_row.id
        AND membership.project_id = project.id
        AND membership.user_id = assigned_user.id
        AND membership.status = 'active'
       JOIN membership_roles AS role
         ON role.account_id = membership.account_id
        AND role.project_id = membership.project_id
        AND role.membership_id = membership.id
        AND ${rolePredicate}
       WHERE account_row.id = ?`,
    )
    .get(input.projectId, userId, input.accountId);
  if (!assignable) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      `${label} is not an assignable project member`,
    );
  }
}

function assertUpdateReferences(database: DatabaseSync, input: UpdateMobileBugInput): void {
  if (input.moduleId !== undefined && input.moduleId !== null) {
    const moduleRow = database
      .prepare(
        `SELECT 1 AS present
         FROM modules
         WHERE account_id = ? AND project_id = ? AND id = ? AND active = 1`,
      )
      .get(input.accountId, input.projectId, input.moduleId);
    if (!moduleRow) {
      throw new MobileRelayStorageError(
        "INVALID_REQUEST",
        "moduleId is not an active project module",
      );
    }
  }
  if (input.ownerId !== undefined && input.ownerId !== null) {
    assertAssignableMember(
      database,
      input,
      input.ownerId,
      "role.role IN ('developer', 'triager', 'project_admin')",
      "ownerId",
    );
  }
  if (input.verificationOwnerId !== undefined && input.verificationOwnerId !== null) {
    assertAssignableMember(
      database,
      input,
      input.verificationOwnerId,
      "role.role IN ('verifier', 'project_admin')",
      "verificationOwnerId",
    );
  }
}

function readMobileBugUpdateReplay(
  database: DatabaseSync,
  input: UpdateMobileBugInput,
): MobileBugRecord | null {
  const row = database
    .prepare(
      `SELECT request_digest, status, response_json
       FROM idempotency_records
       WHERE account_id = ? AND actor_id = ? AND operation_id = 'updateBug'
         AND scope_digest = ? AND idempotency_key = ?`,
    )
    .get(input.accountId, input.actorId, updateBugScopeDigest(input), input.idempotencyKey) as
    | {
        readonly request_digest: string;
        readonly status: string;
        readonly response_json: string | null;
      }
    | undefined;
  if (!row) return null;
  if (row.request_digest !== input.requestDigest) {
    throw new MobileRelayStorageError(
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
      "Idempotency-Key was already used with a different Bug update payload",
    );
  }
  if (row.status !== "committed" || row.response_json === null) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "idempotent Bug update is not committed");
  }
  return Object.freeze(JSON.parse(row.response_json) as MobileBugRecord);
}

export function updateMobileBug(
  database: DatabaseSync,
  input: UpdateMobileBugInput,
): MobileBugRecord {
  requireTransaction(database);
  const bug = readBugRow(database, input, input.bugId);
  if (!bug) throw new MobileRelayStorageError("NOT_FOUND", "Bug was not found");
  assertBugUpdateActor(database, input);
  assertUpdateReferences(database, input);
  const replay = readMobileBugUpdateReplay(database, input);
  if (replay) return replay;
  if (bug.version !== input.expectedVersion) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "Bug is stale at the expected version");
  }

  const scopeDigest = updateBugScopeDigest(input);
  const at = nextTimestamp(input.createdAt, bug.updated_at);
  const idempotencyId = randomUUID();
  const expiresAt = new Date(Date.parse(at) + 7 * 24 * 60 * 60 * 1_000).toISOString();
  database
    .prepare(
      `INSERT INTO idempotency_records(
        id, account_id, project_id, actor_id, operation_id, idempotency_key,
        scope_digest, scope_json, request_digest, status, created_at, expires_at, version
      ) VALUES (?, ?, ?, ?, 'updateBug', ?, ?, ?, ?, 'reserved', ?, ?, 1)`,
    )
    .run(
      idempotencyId,
      input.accountId,
      input.projectId,
      input.actorId,
      input.idempotencyKey,
      scopeDigest,
      JSON.stringify({
        operationId: "updateBug",
        accountId: input.accountId,
        actorId: input.actorId,
        projectId: input.projectId,
        bugId: input.bugId,
      }),
      input.requestDigest,
      at,
      expiresAt,
    );

  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  const mutableColumns: ReadonlyArray<readonly [keyof UpdateMobileBugInput, string]> = [
    ["title", "title"],
    ["description", "description"],
    ["expectedBehavior", "expected_behavior"],
    ["moduleId", "module_id"],
    ["severity", "severity"],
    ["priority", "priority"],
    ["ownerId", "owner_id"],
    ["verificationOwnerId", "verification_owner_id"],
  ];
  for (const [inputKey, column] of mutableColumns) {
    if (input[inputKey] !== undefined) {
      assignments.push(`${column} = ?`);
      values.push(input[inputKey] as string | null);
    }
  }
  assignments.push("version = version + 1", "updated_at = ?");
  values.push(at, input.accountId, input.projectId, input.bugId, bug.version);

  const eventId = randomUUID();
  const changedFields = mutableColumns
    .filter(([inputKey]) => input[inputKey] !== undefined)
    .map(([, column]) => column)
    .join(",");
  const resultingOwnerId = input.ownerId !== undefined ? input.ownerId : bug.owner_id;
  insertUserEvent(database, {
    ...input,
    id: eventId,
    bugId: bug.id,
    type: "bug.updated",
    aggregateType: "bug",
    aggregateId: bug.id,
    aggregateSequence: nextBugAggregateSequence(database, input, bug.id),
    resourceType: "bug",
    resourceId: bug.id,
    resourceVersionAfter: bug.version + 1,
    correlationId: randomUUID(),
    fromState: null,
    toState: null,
    payload: {
      summary: `Bug fields updated; changedFields=${changedFields}; ownerId=${resultingOwnerId ?? "null"}`,
      fromVersion: bug.version,
      toVersion: bug.version + 1,
    },
    createdAt: at,
  });
  insertBugNotificationOutbox(database, {
    ...input,
    eventId,
    eventType: "bug.updated",
    bugVersion: bug.version + 1,
    createdAt: at,
  });
  const result = database
    .prepare(
      `UPDATE bugs
       SET ${assignments.join(", ")}
       WHERE account_id = ? AND project_id = ? AND id = ? AND version = ?`,
    )
    .run(...values);
  if (result.changes !== 1) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "Bug update did not apply exactly once");
  }
  const updated = readBugRow(database, input, bug.id);
  if (!updated) throw new MobileRelayStorageError("NOT_FOUND", "Bug disappeared after update");
  const response = toBug(updated);
  const committed = database
    .prepare(
      `UPDATE idempotency_records
       SET status = 'committed', http_status = 200, response_json = ?,
           audit_event_id = ?, version = 2
       WHERE id = ? AND status = 'reserved' AND version = 1`,
    )
    .run(JSON.stringify(response), eventId, idempotencyId);
  if (committed.changes !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "idempotent Bug update did not commit exactly once",
    );
  }
  return response;
}

export function ensureMobileRelayRoles(database: DatabaseSync, scope: MobileScopeBootstrap): void {
  requireTransaction(database);
  for (const role of ["triager", "developer", "release_manager", "verifier"] as const) {
    database
      .prepare(
        `INSERT OR IGNORE INTO membership_roles(
          account_id, project_id, membership_id, role, granted_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(scope.accountId, scope.projectId, scope.membershipId, role, scope.createdAt);
  }
  database
    .prepare(
      `INSERT OR IGNORE INTO service_principals(
        id, account_id, name, principal_type, credential_digest, status,
        created_at, revoked_at, version
      ) VALUES (?, ?, 'Local fake Relay executor', 'relay', ?, 'active', ?, NULL, 1)`,
    )
    .run(
      MOBILE_FAKE_RELAY_PRINCIPAL_ID,
      scope.accountId,
      createHash("sha256").update("relay-qa-hub-local-fake-relay-no-credential").digest("hex"),
      scope.createdAt,
    );
}

export function transitionMobileBugReady(
  database: DatabaseSync,
  input: TransitionMobileBugInput,
): MobileBugRecord {
  requireTransaction(database);
  const bug = readBugRow(database, input, input.bugId);
  if (!bug) throw new MobileRelayStorageError("NOT_FOUND", "Bug was not found");
  if (bug.version !== input.expectedVersion || bug.state !== "reported") {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Bug is not reported at the expected version",
    );
  }
  const at = nextTimestamp(input.createdAt, bug.updated_at);
  const eventId = randomUUID();
  insertUserEvent(database, {
    ...input,
    id: eventId,
    bugId: bug.id,
    type: "bug.triage.ready",
    aggregateType: "bug",
    aggregateId: bug.id,
    aggregateSequence: nextBugAggregateSequence(database, input, bug.id),
    resourceType: "bug",
    resourceId: bug.id,
    resourceVersionAfter: bug.version + 1,
    correlationId: randomUUID(),
    fromState: bug.state,
    toState: "ready",
    payload: { status: "ready", fromVersion: bug.version, toVersion: bug.version + 1 },
    createdAt: at,
  });
  insertBugNotificationOutbox(database, {
    ...input,
    eventId,
    eventType: "bug.triage.ready",
    bugVersion: bug.version + 1,
    createdAt: at,
  });
  database
    .prepare(
      `UPDATE bugs
       SET state = 'ready', version = version + 1, updated_at = ?
       WHERE account_id = ? AND project_id = ? AND id = ? AND version = ?`,
    )
    .run(at, input.accountId, input.projectId, bug.id, bug.version);
  const updated = readBugRow(database, input, bug.id);
  if (!updated) throw new MobileRelayStorageError("NOT_FOUND", "Bug disappeared after transition");
  return toBug(updated);
}

function toAttempt(row: AttemptRow): MobileRepairAttemptRecord {
  if (row.mode !== "relay" || row.status !== "planned" || row.version !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "RepairAttempt is not a planned Relay attempt",
    );
  }
  return Object.freeze({
    id: row.id,
    bugId: row.bug_id,
    sequence: row.sequence,
    mode: "relay",
    status: "planned",
    assigneeId: row.assignee_id,
    parentAttemptId: null,
    summary: row.summary,
    branch: null,
    commitSha: null,
    mergeRequestUrl: null,
    targetBuildId: null,
    version: 1,
  });
}

function toManualAttempt(row: AttemptRow): MobileManualRepairAttemptRecord {
  if (
    row.mode !== "human" ||
    (row.status !== "planned" && row.status !== "running" && row.status !== "delivered")
  ) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "RepairAttempt is not a supported human attempt",
    );
  }
  return Object.freeze({
    id: row.id,
    bugId: row.bug_id,
    sequence: row.sequence,
    mode: "human",
    status: row.status,
    assigneeId: row.assignee_id,
    parentAttemptId: null,
    summary: row.summary,
    branch: row.branch,
    commitSha: row.commit_sha,
    mergeRequestUrl: row.merge_request_url,
    targetBuildId: null,
    version: row.version,
  });
}

export function createMobileRelayAttempt(
  database: DatabaseSync,
  input: CreateMobileRelayAttemptInput,
): MobileRepairAttemptRecord {
  requireTransaction(database);
  const bug = readBugRow(database, input, input.bugId);
  if (!bug) throw new MobileRelayStorageError("NOT_FOUND", "Bug was not found");
  if (bug.version !== input.expectedVersion || bug.state !== "ready") {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Bug is not ready at the expected version",
    );
  }
  if (input.assigneeId !== input.actorId) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "debug Relay assignee must be the actor");
  }
  const at = nextTimestamp(input.createdAt, bug.updated_at);
  const attemptId = randomUUID();
  const eventId = randomUUID();
  insertUserEvent(database, {
    ...input,
    id: eventId,
    bugId: bug.id,
    type: "repair_attempt.created",
    aggregateType: "repair_attempt",
    aggregateId: attemptId,
    aggregateSequence: 1,
    resourceType: "repair_attempt",
    resourceId: attemptId,
    resourceVersionAfter: 1,
    correlationId: randomUUID(),
    fromState: "ready",
    toState: "in_progress",
    payload: {
      status: "planned",
      repairAttemptId: attemptId,
      fromVersion: bug.version,
      toVersion: bug.version + 1,
    },
    createdAt: at,
  });
  database
    .prepare(
      `INSERT INTO repair_attempts(
        id, account_id, project_id, bug_id, sequence, mode, status, assignee_id,
        parent_attempt_id, summary, branch, commit_sha, merge_request_url, patch_url,
        no_code_reason, target_build_id, created_at, updated_at, version, failure_reason
      ) VALUES (?, ?, ?, ?, 1, 'relay', 'planned', ?, NULL, ?, NULL, NULL, NULL,
                NULL, NULL, NULL, ?, ?, 1, NULL)`,
    )
    .run(
      attemptId,
      input.accountId,
      input.projectId,
      bug.id,
      input.assigneeId,
      input.summary,
      at,
      at,
    );
  database
    .prepare(
      `UPDATE bugs
       SET state = 'in_progress', active_repair_attempt_id = ?, version = version + 1,
           updated_at = ?
       WHERE account_id = ? AND project_id = ? AND id = ? AND version = ?`,
    )
    .run(attemptId, at, input.accountId, input.projectId, bug.id, bug.version);
  const row = database
    .prepare(
      `SELECT id, bug_id, sequence, mode, status, assignee_id, parent_attempt_id,
              summary, branch, commit_sha, merge_request_url, target_build_id, version
       FROM repair_attempts
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, attemptId) as AttemptRow | undefined;
  if (!row) throw new MobileRelayStorageError("NOT_FOUND", "RepairAttempt was not created");
  return toAttempt(row);
}

export function createMobileManualRepairAttempt(
  database: DatabaseSync,
  input: CreateMobileManualRepairAttemptInput,
): MobileManualRepairAttemptRecord {
  requireTransaction(database);
  const bug = readBugRow(database, input, input.bugId);
  if (!bug) throw new MobileRelayStorageError("NOT_FOUND", "Bug was not found");
  if (bug.version !== input.expectedVersion || bug.state !== "ready") {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Bug is not ready at the expected version",
    );
  }
  if (input.assigneeId !== input.actorId) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "manual assignee must be the actor");
  }
  const sequenceRow = database
    .prepare(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM repair_attempts
       WHERE account_id = ? AND project_id = ? AND bug_id = ?`,
    )
    .get(input.accountId, input.projectId, bug.id) as { readonly next_sequence: number };
  const sequence = sequenceRow.next_sequence;
  const at = nextTimestamp(input.createdAt, bug.updated_at);
  const attemptId = randomUUID();
  const eventId = randomUUID();
  insertUserEvent(database, {
    ...input,
    id: eventId,
    bugId: bug.id,
    type: "repair_attempt.created",
    aggregateType: "repair_attempt",
    aggregateId: attemptId,
    aggregateSequence: 1,
    resourceType: "repair_attempt",
    resourceId: attemptId,
    resourceVersionAfter: 1,
    correlationId: randomUUID(),
    fromState: "ready",
    toState: "in_progress",
    payload: {
      status: "planned",
      repairAttemptId: attemptId,
      fromVersion: bug.version,
      toVersion: bug.version + 1,
    },
    createdAt: at,
  });
  database
    .prepare(
      `INSERT INTO repair_attempts(
        id, account_id, project_id, bug_id, sequence, mode, status, assignee_id,
        parent_attempt_id, summary, branch, commit_sha, merge_request_url, patch_url,
        no_code_reason, target_build_id, created_at, updated_at, version, failure_reason
      ) VALUES (?, ?, ?, ?, ?, 'human', 'planned', ?, NULL, ?, NULL, NULL, NULL,
                NULL, NULL, NULL, ?, ?, 1, NULL)`,
    )
    .run(
      attemptId,
      input.accountId,
      input.projectId,
      bug.id,
      sequence,
      input.assigneeId,
      input.summary,
      at,
      at,
    );
  database
    .prepare(
      `UPDATE bugs
       SET state = 'in_progress', active_repair_attempt_id = ?, version = version + 1,
           updated_at = ?
       WHERE account_id = ? AND project_id = ? AND id = ? AND version = ?`,
    )
    .run(attemptId, at, input.accountId, input.projectId, bug.id, bug.version);
  const row = database
    .prepare(
      `SELECT id, bug_id, sequence, mode, status, assignee_id, parent_attempt_id,
              summary, branch, commit_sha, merge_request_url, target_build_id, version
       FROM repair_attempts
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, attemptId) as AttemptRow | undefined;
  if (!row) throw new MobileRelayStorageError("NOT_FOUND", "RepairAttempt was not created");
  return toManualAttempt(row);
}

export function getMobileManualRepairAttempt(
  database: DatabaseSync,
  input: GetMobileManualRepairAttemptInput,
): MobileManualRepairAttemptRecord | null {
  const row = database
    .prepare(
      `SELECT id, bug_id, sequence, mode, status, assignee_id, parent_attempt_id,
              summary, branch, commit_sha, merge_request_url, target_build_id, version
       FROM repair_attempts
       WHERE account_id = ? AND project_id = ? AND id = ? AND mode = 'human'`,
    )
    .get(input.accountId, input.projectId, input.attemptId) as AttemptRow | undefined;
  return row ? toManualAttempt(row) : null;
}

function readManualWorkflowAttempt(
  database: DatabaseSync,
  input: MobileRelayScope,
  attemptId: string,
):
  | (AttemptRow & {
      readonly updated_at: string;
      readonly bug_version: number;
      readonly bug_state: string;
    })
  | null {
  const row = database
    .prepare(
      `SELECT attempt.id, attempt.bug_id, attempt.sequence, attempt.mode, attempt.status,
              attempt.assignee_id, attempt.parent_attempt_id, attempt.summary, attempt.branch,
              attempt.commit_sha, attempt.merge_request_url, attempt.patch_url,
              attempt.no_code_reason, attempt.target_build_id, attempt.failure_reason,
              attempt.updated_at, attempt.version, bug.version AS bug_version,
              bug.state AS bug_state
       FROM repair_attempts AS attempt
       JOIN bugs AS bug
         ON bug.account_id = attempt.account_id
        AND bug.project_id = attempt.project_id
        AND bug.id = attempt.bug_id
        AND bug.active_repair_attempt_id = attempt.id
       WHERE attempt.account_id = ? AND attempt.project_id = ?
         AND attempt.id = ? AND attempt.mode = 'human'`,
    )
    .get(input.accountId, input.projectId, attemptId) as
    | (AttemptRow & {
        readonly updated_at: string;
        readonly bug_version: number;
        readonly bug_state: string;
      })
    | undefined;
  return row ?? null;
}

function nextAttemptAggregateSequence(
  database: DatabaseSync,
  input: MobileRelayScope,
  attemptId: string,
): number {
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(aggregate_sequence), 0) + 1 AS next_sequence
       FROM events
       WHERE account_id = ? AND project_id = ?
         AND aggregate_type = 'repair_attempt' AND aggregate_id = ?`,
    )
    .get(input.accountId, input.projectId, attemptId) as { readonly next_sequence: number };
  return row.next_sequence;
}

function requireWorkflowText(value: string, field: string, max: number): void {
  if (value.trim().length === 0 || value.length > max) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} is invalid`);
  }
}

function requireWorkflowCommit(value: string): void {
  if (!COMMIT_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "commitSha is invalid");
  }
}

export function startMobileRepairAttempt(
  database: DatabaseSync,
  input: StartMobileRepairAttemptInput,
): MobileManualRepairAttemptRecord {
  requireTransaction(database);
  const attempt = readManualWorkflowAttempt(database, input, input.attemptId);
  if (!attempt) throw new MobileRelayStorageError("NOT_FOUND", "RepairAttempt was not found");
  if (attempt.version !== input.expectedVersion || attempt.status !== "planned") {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "RepairAttempt is not planned at the expected version",
    );
  }
  if (input.reason !== null) requireWorkflowText(input.reason, "reason", 5_000);
  const at = nextTimestamp(input.createdAt, attempt.updated_at);
  const eventId = randomUUID();
  const payload: Record<string, unknown> = {
    status: "running",
    repairAttemptId: attempt.id,
    fromVersion: attempt.version,
    toVersion: attempt.version + 1,
  };
  if (input.reason !== null) payload.reason = input.reason;
  insertUserEvent(database, {
    ...input,
    id: eventId,
    bugId: attempt.bug_id,
    type: "repair_attempt.started",
    aggregateType: "repair_attempt",
    aggregateId: attempt.id,
    aggregateSequence: nextAttemptAggregateSequence(database, input, attempt.id),
    resourceType: "repair_attempt",
    resourceId: attempt.id,
    resourceVersionAfter: attempt.version + 1,
    correlationId: randomUUID(),
    fromState: null,
    toState: null,
    payload,
    createdAt: at,
  });
  const updated = database
    .prepare(
      `UPDATE repair_attempts
       SET status = 'running', updated_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND id = ?
         AND status = 'planned' AND version = ?`,
    )
    .run(at, input.accountId, input.projectId, attempt.id, input.expectedVersion);
  if (updated.changes !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "RepairAttempt did not start exactly once",
    );
  }
  const row = database
    .prepare(
      `SELECT id, bug_id, sequence, mode, status, assignee_id, parent_attempt_id,
              summary, branch, commit_sha, merge_request_url, target_build_id, version
       FROM repair_attempts
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, attempt.id) as AttemptRow | undefined;
  if (!row) throw new MobileRelayStorageError("NOT_FOUND", "RepairAttempt disappeared after start");
  return toManualAttempt(row);
}

export function deliverMobileRepairAttempt(
  database: DatabaseSync,
  input: DeliverMobileRepairAttemptInput,
): MobileManualRepairAttemptRecord {
  requireTransaction(database);
  requireWorkflowText(input.summary, "summary", 10_000);
  requireWorkflowText(input.branch, "branch", 300);
  requireWorkflowCommit(input.commitSha);
  if (input.mergeRequestUrl !== null)
    requireWorkflowText(input.mergeRequestUrl, "mergeRequestUrl", 4_000);
  const attempt = readManualWorkflowAttempt(database, input, input.attemptId);
  if (!attempt) throw new MobileRelayStorageError("NOT_FOUND", "RepairAttempt was not found");
  if (attempt.version !== input.expectedVersion || attempt.status !== "running") {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "RepairAttempt is not running at the expected version",
    );
  }
  if (attempt.bug_state !== "in_progress") {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "Bug is not in progress for delivery");
  }
  const at = nextTimestamp(input.createdAt, attempt.updated_at);
  const requirementId = randomUUID();
  const eventId = randomUUID();
  insertUserEvent(database, {
    ...input,
    id: eventId,
    bugId: attempt.bug_id,
    type: "repair_attempt.delivered",
    aggregateType: "repair_attempt",
    aggregateId: attempt.id,
    aggregateSequence: nextAttemptAggregateSequence(database, input, attempt.id),
    resourceType: "build_requirement",
    resourceId: requirementId,
    resourceVersionAfter: 1,
    correlationId: randomUUID(),
    fromState: "in_progress",
    toState: "awaiting_build",
    payload: {
      status: "delivered",
      repairAttemptId: attempt.id,
      commitSha: input.commitSha,
      fromVersion: attempt.version,
      toVersion: attempt.version + 1,
    },
    createdAt: at,
  });
  const updatedAttempt = database
    .prepare(
      `UPDATE repair_attempts
       SET status = 'delivered', summary = ?, branch = ?, commit_sha = ?,
           merge_request_url = ?, patch_url = NULL, no_code_reason = NULL,
           target_build_id = NULL, updated_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND id = ?
         AND status = 'running' AND version = ?`,
    )
    .run(
      input.summary,
      input.branch,
      input.commitSha,
      input.mergeRequestUrl,
      at,
      input.accountId,
      input.projectId,
      attempt.id,
      input.expectedVersion,
    );
  if (updatedAttempt.changes !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "RepairAttempt did not deliver exactly once",
    );
  }
  database
    .prepare(
      `INSERT INTO build_requirements(
        id, account_id, project_id, bug_id, repair_attempt_id,
        source_delivery_version, delivered_commit_sha, requirement, decision_basis,
        decision_reason, decision_actor_id, decision_audit_event_id,
        delivery_request_digest, policy_version, bug_version_at_delivery,
        created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'required', 'code_requires_build',
                NULL, ?, ?, ?, '1.0.0', ?, ?, ?, 1)`,
    )
    .run(
      requirementId,
      input.accountId,
      input.projectId,
      attempt.bug_id,
      attempt.id,
      attempt.version + 1,
      input.commitSha,
      input.actorId,
      eventId,
      input.requestDigest,
      attempt.bug_version + 1,
      at,
      at,
    );
  const updatedBug = database
    .prepare(
      `UPDATE bugs
       SET state = 'awaiting_build', updated_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND id = ? AND state = 'in_progress'
         AND version = ? AND active_repair_attempt_id = ?`,
    )
    .run(at, input.accountId, input.projectId, attempt.bug_id, attempt.bug_version, attempt.id);
  if (updatedBug.changes !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Bug did not enter awaiting_build exactly once",
    );
  }
  const row = database
    .prepare(
      `SELECT id, bug_id, sequence, mode, status, assignee_id, parent_attempt_id,
              summary, branch, commit_sha, merge_request_url, target_build_id, version
       FROM repair_attempts
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, attempt.id) as AttemptRow | undefined;
  if (!row)
    throw new MobileRelayStorageError("NOT_FOUND", "RepairAttempt disappeared after delivery");
  return toManualAttempt(row);
}

interface LinkBuildRow {
  readonly id: string;
  readonly project_id: string;
  readonly provider: "manual" | "ozdqp" | "custom";
  readonly external_id: string;
  readonly version_name: string;
  readonly channel: string;
  readonly project_key: string;
  readonly branch: string;
  readonly source_commit_sha: string;
  readonly mode: "full" | "hot_update" | "cdn" | "debug" | "other";
  readonly status:
    "registered" | "queued" | "building" | "validating" | "publishing" | "ready" | "failed";
  readonly manifest_json: string;
  readonly artifact_sha256: string | null;
  readonly download_url: string | null;
  readonly version: number;
  readonly updated_at: string;
}

function toLinkedBuild(row: LinkBuildRow): MobileBuildRecord {
  let manifest: { readonly commitShas: readonly string[]; readonly artifactSha256: string | null };
  try {
    const decoded = JSON.parse(row.manifest_json) as {
      readonly commitShas?: unknown;
      readonly artifactSha256?: unknown;
    };
    if (
      !Array.isArray(decoded.commitShas) ||
      decoded.commitShas.some((value) => typeof value !== "string") ||
      (decoded.artifactSha256 !== undefined && typeof decoded.artifactSha256 !== "string")
    ) {
      throw new Error("invalid manifest");
    }
    manifest = {
      commitShas: decoded.commitShas as readonly string[],
      artifactSha256: (decoded.artifactSha256 as string | undefined) ?? null,
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
    manifest: Object.freeze({
      commitShas: Object.freeze([...manifest.commitShas]),
      artifactSha256: manifest.artifactSha256,
    }),
    artifactSha256: row.artifact_sha256,
    downloadUrl: row.download_url,
    version: row.version,
  });
}

function latestWorkflowFloor(values: readonly string[]): string {
  const timestamps = values.map((value) => Date.parse(value));
  if (timestamps.some((value) => !Number.isFinite(value))) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "workflow timestamp is invalid");
  }
  return new Date(Math.max(...timestamps)).toISOString();
}

function readBuildRequirement(
  database: DatabaseSync,
  input: MobileRelayScope,
  attemptId: string,
):
  | (MobileBuildRequirementRecord & { readonly created_at: string; readonly updated_at: string })
  | null {
  const row = database
    .prepare(
      `SELECT id, project_id AS projectId, bug_id AS bugId,
              repair_attempt_id AS repairAttemptId,
              source_delivery_version AS sourceDeliveryVersion,
              delivered_commit_sha AS deliveredCommitSha, requirement,
              decision_basis AS decisionBasis, decision_reason AS decisionReason,
              decision_actor_id AS decisionActorId,
              decision_audit_event_id AS decisionAuditEventId,
              linked_build_id AS linkedBuildId, link_id AS linkId,
              policy_version AS policyVersion,
              bug_version_at_delivery AS bugVersionAtDelivery,
              created_at, updated_at, version
       FROM build_requirements
       WHERE account_id = ? AND project_id = ? AND repair_attempt_id = ?`,
    )
    .get(input.accountId, input.projectId, attemptId) as
    | (MobileBuildRequirementRecord & { readonly created_at: string; readonly updated_at: string })
    | undefined;
  return row ?? null;
}

function toBuildRequirement(
  row: MobileBuildRequirementRecord & { readonly created_at: string; readonly updated_at: string },
): MobileBuildRequirementRecord {
  return Object.freeze({
    id: row.id,
    projectId: row.projectId,
    bugId: row.bugId,
    repairAttemptId: row.repairAttemptId,
    sourceDeliveryVersion: row.sourceDeliveryVersion,
    deliveredCommitSha: row.deliveredCommitSha,
    requirement: row.requirement,
    decisionBasis: row.decisionBasis,
    decisionReason: row.decisionReason,
    decisionActorId: row.decisionActorId,
    decisionAuditEventId: row.decisionAuditEventId,
    linkedBuildId: row.linkedBuildId,
    linkId: row.linkId,
    policyVersion: "1.0.0",
    bugVersionAtDelivery: row.bugVersionAtDelivery,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

export function linkMobileBuildRepair(
  database: DatabaseSync,
  input: LinkMobileBuildRepairInput,
): LinkMobileBuildRepairResult {
  requireTransaction(database);
  requireWorkflowCommit(input.deliveredCommitSha);
  if (input.evidenceType !== "manifest") {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "the mobile link slice requires manifest evidence",
    );
  }
  const build = database
    .prepare(
      `SELECT id, project_id, provider, external_id, version_name, channel,
              project_key, branch, source_commit_sha, mode, status, manifest_json,
              artifact_sha256, download_url, version, updated_at
       FROM builds
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, input.buildId) as LinkBuildRow | undefined;
  if (!build) throw new MobileRelayStorageError("NOT_FOUND", "Build was not found");
  if (build.status !== "ready" || build.version !== input.expectedVersion) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Build is not ready at the expected version",
    );
  }
  if (build.source_commit_sha !== input.deliveredCommitSha) {
    throw new MobileRelayStorageError(
      "BUILD_IDENTITY_MISMATCH",
      "Build source commit does not match the delivered RepairAttempt commit",
    );
  }
  const attempt = readManualWorkflowAttempt(database, input, input.repairAttemptId);
  if (!attempt) throw new MobileRelayStorageError("NOT_FOUND", "RepairAttempt was not found");
  if (attempt.status !== "delivered" || attempt.version !== 3) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "RepairAttempt is not delivered at version three",
    );
  }
  if (attempt.commit_sha !== input.deliveredCommitSha) {
    throw new MobileRelayStorageError(
      "BUILD_IDENTITY_MISMATCH",
      "Build link commit does not match the delivered RepairAttempt commit",
    );
  }
  if (input.expectedBugVersion !== undefined && input.expectedBugVersion !== attempt.bug_version) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "Bug version is stale");
  }
  const requirement = readBuildRequirement(database, input, attempt.id);
  if (!requirement)
    throw new MobileRelayStorageError("NOT_FOUND", "BuildRequirement was not found");
  if (
    requirement.version !== 1 ||
    requirement.requirement !== "required" ||
    requirement.decisionBasis !== "code_requires_build" ||
    requirement.deliveredCommitSha !== input.deliveredCommitSha
  ) {
    throw new MobileRelayStorageError(
      "BUILD_IDENTITY_MISMATCH",
      "BuildRequirement commit is not exact",
    );
  }
  if (
    input.expectedBuildRequirementVersion !== undefined &&
    input.expectedBuildRequirementVersion !== requirement.version
  ) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "BuildRequirement version is stale");
  }
  if (attempt.bug_state !== "awaiting_build") {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "Bug is not awaiting a Build");
  }
  const manifestCommit = database
    .prepare(
      `SELECT 1 AS present
       FROM build_manifest_commits
       WHERE account_id = ? AND project_id = ? AND build_id = ? AND commit_sha = ?`,
    )
    .get(input.accountId, input.projectId, build.id, input.deliveredCommitSha) as
    { readonly present: number } | undefined;
  if (!manifestCommit) {
    throw new MobileRelayStorageError(
      "BUILD_IDENTITY_MISMATCH",
      "Build manifest does not contain the delivered commit",
    );
  }
  const at = nextTimestamp(
    input.createdAt,
    latestWorkflowFloor([attempt.updated_at, requirement.updated_at, build.updated_at]),
  );
  const buildAt = nextTimestamp(at, build.updated_at);
  const linkId = randomUUID();
  const eventId = randomUUID();
  database
    .prepare(
      `UPDATE build_requirements
       SET linked_build_id = ?, link_id = ?, updated_at = ?, version = 2
       WHERE account_id = ? AND project_id = ? AND id = ? AND version = 1`,
    )
    .run(build.id, linkId, at, input.accountId, input.projectId, requirement.id);
  insertUserEvent(database, {
    ...input,
    id: eventId,
    bugId: attempt.bug_id,
    type: "build.repair_linked",
    aggregateType: "repair_attempt",
    aggregateId: attempt.id,
    aggregateSequence: nextAttemptAggregateSequence(database, input, attempt.id),
    resourceType: "build_repair_link",
    resourceId: linkId,
    resourceVersionAfter: 1,
    correlationId: randomUUID(),
    fromState: "awaiting_build",
    toState: "ready_for_verification",
    payload: {
      status: "ready_for_verification",
      repairAttemptId: attempt.id,
      buildId: build.id,
      commitSha: input.deliveredCommitSha,
      fromVersion: build.version,
      toVersion: build.version + 1,
    },
    createdAt: at,
  });
  database
    .prepare(
      `INSERT INTO build_repair_links(
        id, account_id, project_id, bug_id, repair_attempt_id, build_id,
        build_requirement_id, build_requirement_version, delivered_commit_sha,
        evidence_type, evidence_decision, override_reason, evidence_actor_id,
        evidence_audit_event_id, evidence_policy_version, linked_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 2, ?, 'manifest', 'manifest_verified', NULL,
                ?, ?, '1.0.0', ?, 1)`,
    )
    .run(
      linkId,
      input.accountId,
      input.projectId,
      attempt.bug_id,
      attempt.id,
      build.id,
      requirement.id,
      input.deliveredCommitSha,
      input.actorId,
      eventId,
      at,
    );
  const updatedBuild = database
    .prepare(
      `UPDATE builds
       SET updated_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND id = ?
         AND status = 'ready' AND version = ?`,
    )
    .run(buildAt, input.accountId, input.projectId, build.id, input.expectedVersion);
  if (updatedBuild.changes !== 1) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "Build did not link exactly once");
  }
  const updatedBug = database
    .prepare(
      `UPDATE bugs
       SET state = 'ready_for_verification', updated_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND id = ? AND state = 'awaiting_build'
         AND version = ? AND active_repair_attempt_id = ?`,
    )
    .run(at, input.accountId, input.projectId, attempt.bug_id, attempt.bug_version, attempt.id);
  if (updatedBug.changes !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Bug did not enter ready_for_verification exactly once",
    );
  }
  const linkedBuild = database
    .prepare(
      `SELECT id, project_id, provider, external_id, version_name, channel,
              project_key, branch, source_commit_sha, mode, status, manifest_json,
              artifact_sha256, download_url, version, updated_at
       FROM builds WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, build.id) as LinkBuildRow | undefined;
  const linkedRequirement = database
    .prepare(
      `SELECT id, project_id AS projectId, bug_id AS bugId,
              repair_attempt_id AS repairAttemptId,
              source_delivery_version AS sourceDeliveryVersion,
              delivered_commit_sha AS deliveredCommitSha, requirement,
              decision_basis AS decisionBasis, decision_reason AS decisionReason,
              decision_actor_id AS decisionActorId,
              decision_audit_event_id AS decisionAuditEventId,
              linked_build_id AS linkedBuildId, link_id AS linkId,
              policy_version AS policyVersion,
              bug_version_at_delivery AS bugVersionAtDelivery,
              created_at, updated_at, version
       FROM build_requirements WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, requirement.id) as
    | (MobileBuildRequirementRecord & { readonly created_at: string; readonly updated_at: string })
    | undefined;
  const linkedLink = database
    .prepare(
      `SELECT id, build_id AS buildId, repair_attempt_id AS repairAttemptId,
              bug_id AS bugId, project_id AS projectId,
              build_requirement_id AS buildRequirementId,
              build_requirement_version AS buildRequirementVersion,
              delivered_commit_sha AS deliveredCommitSha,
              evidence_type AS evidenceType, evidence_decision AS evidenceDecision,
              override_reason AS overrideReason, evidence_actor_id AS evidenceActorId,
              evidence_audit_event_id AS evidenceAuditEventId,
              evidence_policy_version AS evidencePolicyVersion,
              linked_at AS linkedAt, version
       FROM build_repair_links WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, linkId) as MobileBuildRepairLinkRecord | undefined;
  const linkedBug = readBugRow(database, input, attempt.bug_id);
  if (!linkedBuild || !linkedRequirement || !linkedLink || !linkedBug) {
    throw new MobileRelayStorageError("NOT_FOUND", "Build link projection is incomplete");
  }
  return Object.freeze({
    build: toLinkedBuild(linkedBuild),
    bug: toBug(linkedBug),
    buildRequirement: toBuildRequirement(linkedRequirement),
    repairLink: Object.freeze({ ...linkedLink }),
    eventId,
    replayed: false,
  });
}

function scopeDigest(input: MobileRelayScope): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        accountId: input.accountId,
        actorId: input.actorId,
        projectId: input.projectId,
        operationId: "dispatchRepairAttemptToRelay",
      }),
    )
    .digest("hex");
}

function readDispatchReplay(
  database: DatabaseSync,
  input: DispatchMobileRelayInput,
): MobileRelayDispatchAccepted | null {
  const row = database
    .prepare(
      `SELECT request_digest, status, response_json
       FROM idempotency_records
       WHERE account_id = ? AND actor_id = ? AND operation_id = 'dispatchRepairAttemptToRelay'
         AND scope_digest = ? AND idempotency_key = ?`,
    )
    .get(input.accountId, input.actorId, scopeDigest(input), input.idempotencyKey) as
    | {
        readonly request_digest: string;
        readonly status: string;
        readonly response_json: string | null;
      }
    | undefined;
  if (!row) return null;
  if (row.request_digest !== input.requestDigest) {
    throw new MobileRelayStorageError(
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
      "Idempotency-Key was already used with a different Relay handoff payload",
    );
  }
  if (row.status !== "committed" || row.response_json === null) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "Relay handoff is not committed");
  }
  return Object.freeze({
    ...(JSON.parse(row.response_json) as MobileRelayDispatchAccepted),
    replayed: true,
  });
}

export function dispatchMobileRelay(
  database: DatabaseSync,
  input: DispatchMobileRelayInput,
): MobileRelayDispatchAccepted {
  requireTransaction(database);
  const replay = readDispatchReplay(database, input);
  if (replay) return replay;
  if (input.selectedAttachmentIds.length !== 0) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "the first fake Relay slice accepts only an empty attachment selection",
    );
  }
  const attempt = database
    .prepare(
      `SELECT attempt.id, attempt.bug_id, attempt.sequence, attempt.mode, attempt.status,
              attempt.assignee_id, attempt.parent_attempt_id, attempt.summary, attempt.branch,
              attempt.commit_sha, attempt.merge_request_url, attempt.target_build_id,
              attempt.version, bug.key AS bug_key, bug.version AS bug_version,
              attempt.updated_at
       FROM repair_attempts AS attempt
       JOIN bugs AS bug
         ON bug.account_id = attempt.account_id AND bug.project_id = attempt.project_id
        AND bug.id = attempt.bug_id AND bug.active_repair_attempt_id = attempt.id
       WHERE attempt.account_id = ? AND attempt.project_id = ? AND attempt.id = ?`,
    )
    .get(input.accountId, input.projectId, input.attemptId) as
    (AttemptRow & { readonly updated_at: string }) | undefined;
  if (!attempt) throw new MobileRelayStorageError("NOT_FOUND", "RepairAttempt was not found");
  if (
    attempt.mode !== "relay" ||
    attempt.status !== "planned" ||
    attempt.version !== input.expectedVersion
  ) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "RepairAttempt is not a planned Relay attempt at the expected version",
    );
  }
  const at = nextTimestamp(input.createdAt, attempt.updated_at);
  const idempotencyId = randomUUID();
  const expiresAt = new Date(Date.parse(at) + 7 * 24 * 60 * 60 * 1_000).toISOString();
  database
    .prepare(
      `INSERT INTO idempotency_records(
        id, account_id, project_id, actor_id, operation_id, idempotency_key,
        scope_digest, scope_json, request_digest, status, http_status, response_json,
        audit_event_id, created_at, expires_at, version
      ) VALUES (?, ?, ?, ?, 'dispatchRepairAttemptToRelay', ?, ?, ?, ?, 'reserved',
                NULL, NULL, NULL, ?, ?, 1)`,
    )
    .run(
      idempotencyId,
      input.accountId,
      input.projectId,
      input.actorId,
      input.idempotencyKey,
      scopeDigest(input),
      JSON.stringify({
        accountId: input.accountId,
        actorId: input.actorId,
        projectId: input.projectId,
        operationId: "dispatchRepairAttemptToRelay",
      }),
      input.requestDigest,
      at,
      expiresAt,
    );
  const eventId = randomUUID();
  const requestId = randomUUID();
  const integrationLinkId = randomUUID();
  const relayReceiptId = randomUUID();
  const outboxMessageId = randomUUID();
  insertUserEvent(database, {
    ...input,
    id: eventId,
    bugId: attempt.bug_id,
    type: "repair.handoff_queued",
    aggregateType: "repair_attempt",
    aggregateId: attempt.id,
    aggregateSequence: 2,
    resourceType: "relay_handoff",
    resourceId: input.handoffId,
    resourceVersionAfter: 1,
    correlationId: requestId,
    fromState: null,
    toState: null,
    payload: {
      status: "queued",
      repairAttemptId: attempt.id,
      handoffId: input.handoffId,
      attachmentCount: 0,
    },
    createdAt: at,
  });
  database
    .prepare(
      `INSERT INTO integration_links(
        id, account_id, project_id, integration_type, local_resource_type,
        local_resource_id, external_resource_type, external_resource_id, state,
        metadata_json, created_at, updated_at, version
      ) VALUES (?, ?, ?, 'relay', 'repair_attempt', ?, 'relay_handoff', ?, 'active',
                ?, ?, ?, 1)`,
    )
    .run(
      integrationLinkId,
      input.accountId,
      input.projectId,
      attempt.id,
      input.handoffId,
      JSON.stringify({ relayInstanceId: MOBILE_FAKE_RELAY_INSTANCE_ID }),
      at,
      at,
    );
  database
    .prepare(
      `INSERT INTO relay_receipts(
        id, account_id, project_id, integration_link_id, bug_id, repair_attempt_id,
        handoff_id, relay_instance_id, relay_task_id, handoff_status, external_revision,
        build_requirement, build_evidence_status, delivered_commit_sha, build_id,
        requires_human_verification, automation_authority, last_event_at, failure_summary,
        payload_digest, received_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', 0, 'not_required',
                'not_required', NULL, NULL, 1, 'delivery_build_projection_only', ?, NULL,
                ?, ?, 1)`,
    )
    .run(
      relayReceiptId,
      input.accountId,
      input.projectId,
      integrationLinkId,
      attempt.bug_id,
      attempt.id,
      input.handoffId,
      MOBILE_FAKE_RELAY_INSTANCE_ID,
      at,
      input.requestDigest,
      at,
    );
  database
    .prepare(
      `INSERT INTO outbox(
        id, account_id, project_id, aggregate_type, aggregate_id, aggregate_version,
        destination, dedupe_key, event_id, payload_json, status, attempt_count,
        next_attempt_at, lease_owner, lease_expires_at, last_error_code, created_at, sent_at
      ) VALUES (?, ?, ?, 'repair_attempt', ?, 1, ?, ?, ?, ?, 'pending', 0, ?,
                NULL, NULL, NULL, ?, NULL)`,
    )
    .run(
      outboxMessageId,
      input.accountId,
      input.projectId,
      attempt.id,
      MOBILE_FAKE_RELAY_INSTANCE_ID,
      `relay:${input.handoffId}`,
      eventId,
      JSON.stringify({
        bugId: attempt.bug_id,
        repairAttemptId: attempt.id,
        handoffId: input.handoffId,
        selectedAttachmentIds: input.selectedAttachmentIds,
      }),
      at,
      at,
    );
  const accepted: MobileRelayDispatchAccepted = Object.freeze({
    qaItem: { type: "bug" as const, id: attempt.bug_id, key: attempt.bug_key ?? "" },
    repairAttemptId: attempt.id,
    handoffId: input.handoffId,
    relayInstanceId: MOBILE_FAKE_RELAY_INSTANCE_ID,
    outboxMessageId,
    requestId,
    status: "queued",
    replayed: false,
  });
  database
    .prepare(
      `UPDATE idempotency_records
       SET status = 'committed', http_status = 202, response_json = ?,
           audit_event_id = ?, version = 2
       WHERE id = ? AND status = 'reserved' AND version = 1`,
    )
    .run(JSON.stringify(accepted), eventId, idempotencyId);
  return accepted;
}

export function getMobileRelayReceipt(
  database: DatabaseSync,
  input: MobileRelayScope & { readonly attemptId: string },
): MobileRelayReceipt | null {
  const row = database
    .prepare(
      `SELECT receipt.bug_id, bug.key AS bug_key, receipt.repair_attempt_id,
              receipt.handoff_id, receipt.relay_instance_id, receipt.relay_task_id,
              receipt.handoff_status, receipt.build_requirement,
              receipt.build_evidence_status, receipt.delivered_commit_sha,
              receipt.build_id, receipt.external_revision, receipt.last_event_at,
              receipt.failure_summary, receipt.version
       FROM relay_receipts AS receipt
       JOIN bugs AS bug
         ON bug.account_id = receipt.account_id AND bug.project_id = receipt.project_id
        AND bug.id = receipt.bug_id
       WHERE receipt.account_id = ? AND receipt.project_id = ?
         AND receipt.repair_attempt_id = ?`,
    )
    .get(input.accountId, input.projectId, input.attemptId) as ReceiptRow | undefined;
  if (!row) return null;
  return Object.freeze({
    qaItem: { type: "bug" as const, id: row.bug_id, key: row.bug_key },
    repairAttemptId: row.repair_attempt_id,
    handoffId: row.handoff_id,
    relayInstanceId: row.relay_instance_id,
    relayTaskId: row.relay_task_id,
    handoffStatus: row.handoff_status,
    buildRequirement: row.build_requirement,
    buildEvidenceStatus: row.build_evidence_status,
    deliveredCommitSha: row.delivered_commit_sha,
    buildId: row.build_id,
    externalRevision: row.external_revision,
    requiresHumanVerification: true,
    automationAuthority: "delivery_build_projection_only",
    lastEventAt: row.last_event_at,
    failureSummary: row.failure_summary,
    version: row.version,
  });
}

function requireRelayWebhookPrincipal(database: DatabaseSync, accountId: string): void {
  const principal = database
    .prepare(
      `SELECT principal.id
       FROM service_principals AS principal
       JOIN accounts AS account ON account.id = principal.account_id
       WHERE principal.account_id = ? AND principal.id = ?
         AND principal.principal_type = 'relay'
         AND principal.status = 'active' AND account.status = 'active'`,
    )
    .get(accountId, MOBILE_FAKE_RELAY_PRINCIPAL_ID) as { readonly id: string } | undefined;
  if (!principal) {
    throw new MobileRelayStorageError(
      "INTEGRATION_AUTOMATION_FORBIDDEN",
      "Relay webhook service principal is not active for this account",
    );
  }
}

function readRelayWebhookReceipt(
  database: DatabaseSync,
  input: ReceiveMobileRelayWebhookInput,
): RelayWebhookReceiptRow | undefined {
  return database
    .prepare(
      `SELECT receipt.id AS receipt_id, receipt.bug_id, bug.key AS bug_key,
              receipt.repair_attempt_id, receipt.handoff_id, receipt.relay_instance_id,
              receipt.relay_task_id, receipt.handoff_status, receipt.build_requirement,
              receipt.build_evidence_status, receipt.delivered_commit_sha, receipt.build_id,
              receipt.external_revision, receipt.last_event_at, receipt.failure_summary,
              receipt.payload_digest, receipt.version, integration.id AS integration_link_id
       FROM relay_receipts AS receipt
       JOIN integration_links AS integration
         ON integration.account_id = receipt.account_id
        AND integration.project_id = receipt.project_id
        AND integration.id = receipt.integration_link_id
       JOIN repair_attempts AS attempt
         ON attempt.account_id = receipt.account_id
        AND attempt.project_id = receipt.project_id
        AND attempt.id = receipt.repair_attempt_id
        AND attempt.bug_id = receipt.bug_id
       JOIN bugs AS bug
         ON bug.account_id = receipt.account_id
        AND bug.project_id = receipt.project_id
        AND bug.id = receipt.bug_id
       WHERE receipt.account_id = ? AND receipt.project_id = ?
         AND receipt.repair_attempt_id = ? AND receipt.handoff_id = ?
         AND receipt.relay_instance_id = ?
         AND attempt.mode = 'relay'
         AND integration.integration_type = 'relay'
         AND integration.local_resource_type = 'repair_attempt'
         AND integration.local_resource_id = receipt.repair_attempt_id
         AND integration.external_resource_type = 'relay_handoff'
         AND integration.external_resource_id = receipt.handoff_id
         AND integration.state = 'active'
         AND json_extract(integration.metadata_json, '$.relayInstanceId') = receipt.relay_instance_id`,
    )
    .get(
      input.accountId,
      input.projectId,
      input.attemptId,
      input.handoffId,
      input.relayInstanceId,
    ) as RelayWebhookReceiptRow | undefined;
}

function readRelayWebhookInbox(
  database: DatabaseSync,
  input: ReceiveMobileRelayWebhookInput,
): InboxRow[] {
  return database
    .prepare(
      `SELECT id, external_event_id, delivery_id, payload_digest, status
       FROM inbox
       WHERE account_id = ? AND project_id = ? AND source = 'relay'
         AND source_instance_id = ?
         AND (external_event_id = ? OR delivery_id = ?)`,
    )
    .all(
      input.accountId,
      input.projectId,
      input.relayInstanceId,
      input.eventId,
      input.deliveryId,
    ) as unknown as InboxRow[];
}

function insertRelayWebhookInbox(
  database: DatabaseSync,
  input: ReceiveMobileRelayWebhookInput,
  status: "applied" | "ignored",
  appliedAt: string | null,
): string {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO inbox(
        id, account_id, project_id, source, source_instance_id,
        external_event_id, delivery_id, event_type, aggregate_id,
        aggregate_sequence, payload_digest, payload_json, status,
        received_at, applied_at, version
      ) VALUES (?, ?, ?, 'relay', ?, ?, ?, 'turn.delivered', ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      id,
      input.accountId,
      input.projectId,
      input.relayInstanceId,
      input.eventId,
      input.deliveryId,
      input.attemptId,
      input.externalRevision,
      input.payloadDigest,
      input.rawPayloadJson,
      status,
      input.receivedAt,
      appliedAt,
    );
  return id;
}

function nextRelayAggregateSequence(
  database: DatabaseSync,
  accountId: string,
  projectId: string,
  attemptId: string,
): number {
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(aggregate_sequence), 0) + 1 AS next_sequence
       FROM events
       WHERE account_id = ? AND project_id = ?
         AND aggregate_type = 'repair_attempt' AND aggregate_id = ?`,
    )
    .get(accountId, projectId, attemptId) as { readonly next_sequence: number };
  return row.next_sequence;
}

export function receiveMobileRelayWebhook(
  database: DatabaseSync,
  input: ReceiveMobileRelayWebhookInput,
): MobileRelayWebhookProjectionResult {
  requireTransaction(database);
  validateRawRelayWebhook(input);

  // Authorization and exact aggregate/resource binding happen before inbox
  // dedupe.  A foreign event must not be able to learn whether a delivery key
  // exists in another account, project, handoff, or attempt.
  requireRelayWebhookPrincipal(database, input.accountId);
  const receipt = readRelayWebhookReceipt(database, input);
  if (!receipt) {
    throw new MobileRelayStorageError(
      "NOT_FOUND",
      "Relay webhook does not match an active exact handoff tuple",
    );
  }

  const inboxRows = readRelayWebhookInbox(database, input);
  const eventRow = inboxRows.find((row) => row.external_event_id === input.eventId);
  const deliveryRow = inboxRows.find((row) => row.delivery_id === input.deliveryId);
  if (eventRow) {
    if (eventRow.payload_digest !== input.payloadDigest) {
      throw new MobileRelayStorageError(
        "INTEGRATION_EVENT_CONFLICT",
        "Relay event was already received with a different payload",
      );
    }
    if (deliveryRow && deliveryRow.external_event_id !== input.eventId) {
      throw new MobileRelayStorageError(
        "INTEGRATION_EVENT_CONFLICT",
        "Relay delivery id is already bound to another event",
      );
    }
    return Object.freeze({
      inboxMessageId: eventRow.id,
      replayed: true,
      projectionStatus: "replayed" as const,
    });
  }
  if (deliveryRow) {
    throw new MobileRelayStorageError(
      "INTEGRATION_EVENT_CONFLICT",
      "Relay delivery id is already bound to another event",
    );
  }

  if (input.externalRevision < receipt.external_revision) {
    const inboxMessageId = insertRelayWebhookInbox(database, input, "ignored", null);
    return Object.freeze({
      inboxMessageId,
      replayed: false,
      projectionStatus: "ignored" as const,
    });
  }
  if (input.externalRevision === receipt.external_revision) {
    if (input.payloadDigest !== receipt.payload_digest) {
      throw new MobileRelayStorageError(
        "INTEGRATION_EVENT_CONFLICT",
        "Relay event revision was already projected with a different payload",
      );
    }
    const inboxMessageId = insertRelayWebhookInbox(database, input, "applied", input.receivedAt);
    return Object.freeze({
      inboxMessageId,
      replayed: true,
      projectionStatus: "replayed" as const,
    });
  }

  const relayTaskId = String(input.taskId);
  // The handoff acknowledgement may carry a Relay task label while the
  // delivery webhook carries the authoritative numeric task id.  Permit that
  // one pre-delivery reconciliation, then keep the task identity immutable
  // for later revisions.
  if (
    receipt.relay_task_id !== null &&
    receipt.relay_task_id !== relayTaskId &&
    receipt.handoff_status !== "queued" &&
    receipt.handoff_status !== "submitted"
  ) {
    throw new MobileRelayStorageError(
      "INTEGRATION_EVENT_CONFLICT",
      "Relay task identity changed within one handoff",
    );
  }
  const eventAt = nextTimestamp(input.occurredAt, receipt.last_event_at);
  const receiptVersionAfter = receipt.version + 1;
  const receiptUpdate = database
    .prepare(
      `UPDATE relay_receipts
       SET relay_task_id = ?, handoff_status = 'fix_delivered', external_revision = ?,
           delivered_commit_sha = ?, last_event_at = ?, failure_summary = NULL,
           payload_digest = ?, received_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND repair_attempt_id = ?
         AND handoff_id = ? AND relay_instance_id = ?
         AND version = ? AND external_revision < ?`,
    )
    .run(
      relayTaskId,
      input.externalRevision,
      input.commitSha,
      eventAt,
      input.payloadDigest,
      input.receivedAt,
      input.accountId,
      input.projectId,
      input.attemptId,
      input.handoffId,
      input.relayInstanceId,
      receipt.version,
      input.externalRevision,
    );
  if (receiptUpdate.changes !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Relay receipt revision changed while projecting the webhook",
    );
  }

  const eventId = randomUUID();
  const aggregateSequence = nextRelayAggregateSequence(
    database,
    input.accountId,
    input.projectId,
    input.attemptId,
  );
  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_service_principal_id, aggregate_type, aggregate_id,
        aggregate_sequence, resource_type, resource_id, resource_version_after,
        request_digest, correlation_id, causation_id, from_state, to_state,
        payload_json, created_at
      ) VALUES (?, ?, ?, ?, 'repair.fix_delivered', 'relay', 'service', ?,
                'repair_attempt', ?, ?, 'repair_attempt', ?, ?, ?, ?, ?, NULL,
                NULL, ?, ?)`,
    )
    .run(
      eventId,
      input.accountId,
      input.projectId,
      receipt.bug_id,
      MOBILE_FAKE_RELAY_PRINCIPAL_ID,
      input.attemptId,
      aggregateSequence,
      input.attemptId,
      receiptVersionAfter,
      input.payloadDigest,
      randomUUID(),
      input.eventId,
      JSON.stringify({
        status: "fix_delivered",
        repairAttemptId: input.attemptId,
        handoffId: input.handoffId,
        commitSha: input.commitSha,
      }),
      eventAt,
    );

  const inboxMessageId = insertRelayWebhookInbox(database, input, "applied", eventAt);
  return Object.freeze({
    inboxMessageId,
    replayed: false,
    projectionStatus: "applied" as const,
  });
}

interface MobileRelayOutboxRow {
  readonly id: string;
  readonly payload_json: string;
  readonly dedupe_key: string;
  readonly attempt_count: number;
  readonly payload_digest: string;
}

export function claimMobileRelayOutbox(
  database: DatabaseSync,
  input: {
    readonly leaseOwner: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  },
): MobileRelayOutboxClaim | null {
  requireTransaction(database);
  const row = database
    .prepare(
      `SELECT outbox.id, outbox.payload_json, outbox.dedupe_key,
              outbox.attempt_count, receipt.payload_digest
       FROM outbox
       JOIN relay_receipts AS receipt
         ON receipt.account_id = outbox.account_id
        AND receipt.project_id = outbox.project_id
        AND receipt.repair_attempt_id = outbox.aggregate_id
        AND receipt.relay_instance_id = outbox.destination
       WHERE outbox.destination = ?
         AND outbox.status IN ('pending', 'retry')
         AND outbox.next_attempt_at <= ?
         AND receipt.handoff_status = 'queued'
       ORDER BY outbox.next_attempt_at, outbox.id
       LIMIT 1`,
    )
    .get(MOBILE_FAKE_RELAY_INSTANCE_ID, input.now) as MobileRelayOutboxRow | undefined;
  if (!row) return null;

  const claimed = database
    .prepare(
      `UPDATE outbox
       SET status = 'claimed', attempt_count = attempt_count + 1,
           lease_owner = ?, lease_expires_at = ?, last_error_code = NULL
       WHERE id = ? AND status IN ('pending', 'retry') AND next_attempt_at <= ?`,
    )
    .run(input.leaseOwner, input.leaseExpiresAt, row.id, input.now);
  if (claimed.changes !== 1) return null;

  const payload = JSON.parse(row.payload_json) as {
    readonly bugId?: unknown;
    readonly repairAttemptId?: unknown;
    readonly handoffId?: unknown;
    readonly selectedAttachmentIds?: unknown;
  };
  if (
    typeof payload.bugId !== "string" ||
    typeof payload.repairAttemptId !== "string" ||
    typeof payload.handoffId !== "string" ||
    !Array.isArray(payload.selectedAttachmentIds) ||
    payload.selectedAttachmentIds.some((value) => typeof value !== "string")
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "fake Relay outbox payload is invalid");
  }
  return Object.freeze({
    outboxMessageId: row.id,
    bugId: payload.bugId,
    repairAttemptId: payload.repairAttemptId,
    handoffId: payload.handoffId,
    relayInstanceId: MOBILE_FAKE_RELAY_INSTANCE_ID,
    idempotencyKey: row.dedupe_key,
    payloadDigest: row.payload_digest,
    selectedAttachmentIds: Object.freeze([...payload.selectedAttachmentIds]),
    leaseOwner: input.leaseOwner,
    attemptCount: row.attempt_count + 1,
  });
}

export function completeMobileRelayOutbox(
  database: DatabaseSync,
  input: CompleteMobileRelayOutboxInput,
): MobileRelayReceipt {
  requireTransaction(database);
  const row = database
    .prepare(
      `SELECT outbox.account_id, outbox.project_id, outbox.aggregate_id,
              outbox.event_id, receipt.bug_id, receipt.handoff_id,
              receipt.external_revision, receipt.last_event_at
       FROM outbox
       JOIN relay_receipts AS receipt
         ON receipt.account_id = outbox.account_id
        AND receipt.project_id = outbox.project_id
        AND receipt.repair_attempt_id = outbox.aggregate_id
        AND receipt.relay_instance_id = outbox.destination
       WHERE outbox.id = ? AND outbox.destination = ? AND outbox.status = 'claimed'
         AND outbox.lease_owner = ? AND receipt.handoff_status = 'queued'`,
    )
    .get(input.outboxMessageId, MOBILE_FAKE_RELAY_INSTANCE_ID, input.leaseOwner) as
    | {
        readonly account_id: string;
        readonly project_id: string;
        readonly aggregate_id: string;
        readonly event_id: string;
        readonly bug_id: string;
        readonly handoff_id: string;
        readonly external_revision: number;
        readonly last_event_at: string;
      }
    | undefined;
  if (!row) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "fake Relay outbox lease is no longer active",
    );
  }
  if (input.externalRevision <= row.external_revision) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "fake Relay receipt revision did not advance",
    );
  }
  const at = nextTimestamp(input.receivedAt, row.last_event_at);
  const externalAt = nextTimestamp(input.lastEventAt, row.last_event_at);
  const eventAt = externalAt > at ? externalAt : at;
  const eventId = randomUUID();
  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_service_principal_id, aggregate_type, aggregate_id,
        aggregate_sequence, resource_type, resource_id, resource_version_after,
        request_digest, correlation_id, causation_id, from_state, to_state,
        payload_json, created_at
      ) VALUES (?, ?, ?, ?, 'repair.submitted', 'relay', 'service', ?,
                'repair_attempt', ?, 3, 'repair_attempt', ?, 1, ?, ?, ?, NULL,
                NULL, ?, ?)`,
    )
    .run(
      eventId,
      row.account_id,
      row.project_id,
      row.bug_id,
      MOBILE_FAKE_RELAY_PRINCIPAL_ID,
      row.aggregate_id,
      row.aggregate_id,
      input.payloadDigest,
      randomUUID(),
      row.event_id,
      JSON.stringify({
        status: "submitted",
        repairAttemptId: row.aggregate_id,
        handoffId: row.handoff_id,
      }),
      eventAt,
    );
  const receiptUpdate = database
    .prepare(
      `UPDATE relay_receipts
       SET relay_task_id = ?, handoff_status = 'submitted', external_revision = ?,
           last_event_at = ?, payload_digest = ?, received_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND repair_attempt_id = ?
         AND handoff_id = ? AND handoff_status = 'queued'`,
    )
    .run(
      input.relayTaskId,
      input.externalRevision,
      eventAt,
      input.payloadDigest,
      at,
      row.account_id,
      row.project_id,
      row.aggregate_id,
      row.handoff_id,
    );
  const outboxUpdate = database
    .prepare(
      `UPDATE outbox
       SET status = 'sent', lease_owner = NULL, lease_expires_at = NULL,
           last_error_code = NULL, sent_at = ?
       WHERE id = ? AND status = 'claimed' AND lease_owner = ?`,
    )
    .run(at, input.outboxMessageId, input.leaseOwner);
  if (receiptUpdate.changes !== 1 || outboxUpdate.changes !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "fake Relay receipt was not applied exactly once",
    );
  }
  const receipt = getMobileRelayReceipt(database, {
    accountId: row.account_id,
    projectId: row.project_id,
    actorId: MOBILE_FAKE_RELAY_PRINCIPAL_ID,
    attemptId: row.aggregate_id,
  });
  if (!receipt) throw new MobileRelayStorageError("NOT_FOUND", "fake Relay receipt disappeared");
  return receipt;
}

export function retryMobileRelayOutbox(
  database: DatabaseSync,
  input: RetryMobileRelayOutboxInput,
): boolean {
  requireTransaction(database);
  const result = database
    .prepare(
      `UPDATE outbox
       SET status = 'retry', lease_owner = NULL, lease_expires_at = NULL,
           last_error_code = ?, next_attempt_at = ?
       WHERE id = ? AND destination = ? AND status = 'claimed' AND lease_owner = ?`,
    )
    .run(
      input.errorCode,
      input.nextAttemptAt,
      input.outboxMessageId,
      MOBILE_FAKE_RELAY_INSTANCE_ID,
      input.leaseOwner,
    );
  return result.changes === 1;
}
