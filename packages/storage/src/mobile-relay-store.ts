import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { toBoundedAuditText } from "./audit-text.js";
import type { MobileBugRecord, MobileScopeBootstrap } from "./mobile-bug-store.js";
import type { MobileBuildRecord } from "./mobile-build-store.js";

export const MOBILE_FAKE_RELAY_INSTANCE_ID = "fake-relay-local" as const;
export const MOBILE_FAKE_RELAY_PRINCIPAL_ID = "10000000-0000-4000-8000-000000000007" as const;

/**
 * The fake executor is kept as a compatibility fixture only.  Real Relay
 * instance/QA-instance identifiers are supplied by the integration worker and
 * are persisted on the handoff; storage deliberately does not choose one.
 */
export interface MobileRelayWorkspace {
  readonly projectId: string;
  readonly branchName: string | null;
  readonly threadId: string | null;
}

export interface MobileRelayAttachmentClaim {
  readonly attachmentId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  /** Opaque content-addressed key; never a host filesystem path. */
  readonly storageKey: string;
}

export type MobileRelayOutboxOperation = "create" | "continue";

export type MobileRelayWebhookStatus =
  "submitted" | "running" | "needs_input" | "blocked" | "failed" | "fix_delivered";

export interface MobileRelayRuntimeConfig {
  readonly relayInstanceId: string;
  readonly qaInstanceId?: string;
  readonly relayPrincipalId?: string;
}

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
  readonly attachmentIds?: readonly string[];
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

interface DeliverMobileRepairAttemptBase extends MobileRelayScope {
  readonly attemptId: string;
  readonly expectedVersion: number;
  readonly summary: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export type DeliverMobileRepairAttemptInput = DeliverMobileRepairAttemptBase &
  (
    | {
        readonly deliveryKind: "code";
        readonly branch: string;
        readonly commitSha: string;
        readonly mergeRequestUrl: string | null;
        readonly patchUrl: string | null;
        readonly noCodeReason: null;
      }
    | {
        readonly deliveryKind: "no_code";
        readonly branch: null;
        readonly commitSha: null;
        readonly mergeRequestUrl: null;
        readonly patchUrl: null;
        readonly noCodeReason: string;
      }
  );

export interface CompleteMobileBugForVerificationInput extends MobileRelayScope {
  readonly bugId: string;
  readonly repairAttemptId: string;
  readonly expectedVersion: number;
  readonly reason: string;
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
  readonly status: "planned" | "running" | "delivered" | "verification_failed";
  readonly assigneeId: string;
  readonly parentAttemptId: null;
  readonly summary: string | null;
  readonly branch: string | null;
  readonly commitSha: string | null;
  readonly mergeRequestUrl: string | null;
  readonly patchUrl: string | null;
  readonly noCodeReason: string | null;
  readonly failureReason: string | null;
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
  /** Supplied by the configured integration worker; fake is accepted for history only. */
  readonly relayInstanceId?: string;
  readonly qaInstanceId?: string;
  readonly relayPrincipalId?: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export interface ContinueMobileRelayInput extends MobileRelayScope {
  readonly attemptId: string;
  readonly handoffId: string;
  readonly actionId: string;
  readonly prompt: string;
  readonly selectedAttachmentIds: readonly string[];
  readonly relayInstanceId?: string;
  readonly qaInstanceId?: string;
  readonly relayPrincipalId?: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export interface MobileRelayDispatchAccepted {
  readonly qaItem: { readonly type: "bug"; readonly id: string; readonly key: string };
  readonly repairAttemptId: string;
  readonly handoffId: string;
  readonly relayInstanceId: string;
  readonly qaInstanceId: string | null;
  readonly outboxMessageId: string;
  readonly requestId: string;
  readonly status: "queued";
  readonly operation: "create";
  readonly replayed: boolean;
}

export interface MobileRelayContinueAccepted {
  readonly repairAttemptId: string;
  readonly handoffId: string;
  readonly relayInstanceId: string;
  readonly qaInstanceId: string | null;
  readonly actionId: string;
  readonly outboxMessageId: string;
  readonly requestId: string;
  readonly status: "queued";
  readonly operation: "continue";
  readonly replayed: boolean;
}

export interface MobileRelayReceipt {
  readonly qaItem: { readonly type: "bug"; readonly id: string; readonly key: string };
  readonly repairAttemptId: string;
  readonly handoffId: string;
  readonly relayInstanceId: string;
  readonly qaInstanceId: string | null;
  readonly relayTaskId: string | null;
  readonly relayTurnId: string | null;
  readonly branch: string | null;
  readonly threadId: string | null;
  readonly workspace: MobileRelayWorkspace | null;
  readonly requestHash: string | null;
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
  readonly relayInstanceId: string;
  readonly qaInstanceId: string | null;
  readonly projectKey: string;
  readonly defect: {
    readonly id: string;
    readonly key: string;
    readonly revision: number;
    readonly projectKey: string;
    readonly title: string;
    readonly description: string;
    readonly severity: MobileBugRecord["severity"];
    readonly verificationCriteria: string;
  };
  readonly selectedAttachments: readonly MobileRelayAttachmentClaim[];
  readonly operation: MobileRelayOutboxOperation;
  readonly actionId: string | null;
  readonly prompt: string | null;
  readonly idempotencyKey: string;
  readonly payloadDigest: string;
  readonly selectedAttachmentIds: readonly string[];
  readonly leaseOwner: string;
  readonly attemptCount: number;
}

export interface CompleteMobileRelayOutboxInput {
  readonly outboxMessageId: string;
  readonly leaseOwner: string;
  readonly relayInstanceId?: string;
  readonly qaInstanceId?: string;
  readonly relayTaskId: string;
  readonly relayTurnId?: string | number | null;
  readonly taskId?: string | number | null;
  readonly turnId?: string | number | null;
  readonly branch?: string | null;
  readonly threadId?: string | null;
  readonly workspace?: MobileRelayWorkspace | null;
  readonly requestHash?: string | null;
  readonly handoffStatus: "submitted";
  readonly externalRevision: number;
  readonly lastEventAt: string;
  readonly payloadDigest: string;
  readonly receivedAt: string;
}

export interface RetryMobileRelayOutboxInput {
  readonly outboxMessageId: string;
  readonly leaseOwner: string;
  readonly relayInstanceId?: string;
  readonly deadLetter?: boolean;
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
  readonly eventType:
    | MobileRelayWebhookStatus
    | "turn.queued"
    | "turn.started"
    | "turn.prepare"
    | "turn.resume"
    | "turn.needs_input"
    | "turn.blocked"
    | "turn.failed"
    | "turn.cancelled"
    | "turn.delivered";
  readonly handoffId: string;
  readonly attemptId: string;
  readonly externalRevision: number;
  readonly occurredAt: string;
  readonly taskId?: string | number | null;
  readonly turnId?: string | number | null;
  readonly threadId?: string | null;
  readonly workspace?: MobileRelayWorkspace | null;
  readonly requestHash?: string | null;
  readonly statusReason?: string | null;
  readonly commitSha?: string | null;
  readonly remoteSha?: string | null;
  readonly branch?: string | null;
  readonly mergeRequestUrl?: string | null;
  readonly buildRequirement?:
    | "required"
    | "not_required"
    | { readonly required: boolean; readonly projectKey?: string | null }
    | null;
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
  readonly qa_instance_id?: string | null;
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
  readonly metadata_json: string;
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

function requireRelayIdentity(
  value: unknown,
  field: string,
  options: { readonly required?: boolean } = {},
): string | null {
  if (value === undefined || value === null) {
    if (options.required === true) {
      throw new MobileRelayStorageError("INVALID_REQUEST", `Relay webhook ${field} is invalid`);
    }
    return null;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new MobileRelayStorageError("INVALID_REQUEST", `Relay webhook ${field} is invalid`);
    }
    return String(value);
  }
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 300 ||
    value.trim() !== value
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `Relay webhook ${field} is invalid`);
  }
  return value;
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

function relayWebhookStatus(
  eventType: ReceiveMobileRelayWebhookInput["eventType"],
): MobileRelayWebhookStatus {
  switch (eventType) {
    case "submitted":
    case "turn.queued":
      return "submitted";
    case "running":
    case "turn.started":
    case "turn.prepare":
    case "turn.resume":
      return "running";
    case "needs_input":
    case "turn.needs_input":
      return "needs_input";
    case "blocked":
    case "turn.blocked":
      return "blocked";
    case "failed":
    case "turn.failed":
    case "turn.cancelled":
      return "failed";
    case "fix_delivered":
    case "turn.delivered":
      return "fix_delivered";
    default:
      throw new MobileRelayStorageError(
        "INVALID_REQUEST",
        "Relay webhook event type is unsupported",
      );
  }
}

function validateRelayWorkspace(value: unknown, field: string): MobileRelayWorkspace | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `Relay webhook ${field} is invalid`);
  }
  requireRelayKeys(value, new Set(["projectId", "branchName", "threadId"]), field);
  const projectId = requireRelayString(value.projectId, `${field}.projectId`, 1, 200);
  const branchName =
    value.branchName === null || value.branchName === undefined
      ? null
      : requireRelayString(value.branchName, `${field}.branchName`, 1, 300);
  const threadId =
    value.threadId === null || value.threadId === undefined
      ? null
      : requireRelayString(value.threadId, `${field}.threadId`, 1, 300);
  return Object.freeze({ projectId, branchName, threadId });
}

function normalizeBuildRequirement(
  value: ReceiveMobileRelayWebhookInput["buildRequirement"],
): "required" | "not_required" | null {
  if (value === undefined || value === null) return null;
  if (value === "required" || value === "not_required") return value;
  if (!isRecord(value) || typeof value.required !== "boolean") {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "Relay webhook buildRequirement is invalid",
    );
  }
  return value.required ? "required" : "not_required";
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
  const status = relayWebhookStatus(input.eventType);
  const relayInstanceId = requireRelayString(input.relayInstanceId, "relayInstanceId", 3, 64);
  if (!RELAY_INSTANCE_PATTERN.test(relayInstanceId)) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "Relay webhook relayInstanceId is invalid",
    );
  }
  const eventId = requireRelayIdentity(input.eventId, "eventId", { required: true });
  const handoffId = requireRelayIdentity(input.handoffId, "handoffId", { required: true });
  const attemptId = requireRelayIdentity(input.attemptId, "attemptId", { required: true });
  const deliveryId = requireRelayString(input.deliveryId, "deliveryId", 1, 300);
  const externalRevision = requireRelayPositiveInteger(input.externalRevision, "externalRevision");
  const occurredAt = requireRelayTimestamp(input.occurredAt, "occurredAt");
  requireRelayTimestamp(input.receivedAt, "receivedAt");
  const taskId = requireRelayIdentity(input.taskId, "taskId");
  const turnId = requireRelayIdentity(input.turnId, "turnId");
  if (input.threadId !== undefined && input.threadId !== null) {
    requireRelayString(input.threadId, "threadId", 1, 300);
  }
  validateRelayWorkspace(input.workspace, "workspace");
  const branch =
    input.branch === undefined || input.branch === null
      ? null
      : requireRelayString(input.branch, "branch", 1, 300);
  const commitSha =
    input.commitSha === undefined || input.commitSha === null
      ? null
      : requireRelayString(input.commitSha, "commitSha", 40, 40);
  const remoteSha =
    input.remoteSha === undefined || input.remoteSha === null
      ? null
      : requireRelayString(input.remoteSha, "remoteSha", 40, 40);
  if (status === "fix_delivered") {
    if (
      taskId === null ||
      turnId === null ||
      branch === null ||
      commitSha === null ||
      remoteSha === null ||
      !COMMIT_PATTERN.test(commitSha) ||
      !COMMIT_PATTERN.test(remoteSha) ||
      commitSha !== remoteSha
    ) {
      throw new MobileRelayStorageError(
        "RELAY_DELIVERY_EVIDENCE_INVALID",
        "Relay fix_delivered evidence must contain matching verified commit SHAs",
      );
    }
  } else if (commitSha !== null || remoteSha !== null || branch !== null) {
    throw new MobileRelayStorageError(
      "RELAY_DELIVERY_EVIDENCE_INVALID",
      "Only fix_delivered may carry delivery evidence",
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
  const requestHash = input.requestHash;
  if (requestHash !== undefined && requestHash !== null && !SHA256_PATTERN.test(requestHash)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "Relay webhook requestHash is invalid");
  }
  normalizeBuildRequirement(input.buildRequirement);
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
    relayWebhookStatus(decoded.eventType as ReceiveMobileRelayWebhookInput["eventType"]) !==
      status ||
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
    new Set([
      "taskId",
      "turnId",
      "threadId",
      "workspace",
      "requestHash",
      "statusReason",
      "deliveryEvidence",
      "buildRequirement",
    ]),
    "payload",
  );
  const decodedTaskId = requireRelayIdentity(decoded.payload.taskId, "payload.taskId");
  const decodedTurnId = requireRelayIdentity(decoded.payload.turnId, "payload.turnId");
  if (
    (taskId !== null && decodedTaskId !== taskId) ||
    (turnId !== null && decodedTurnId !== turnId)
  ) {
    throw new MobileRelayStorageError(
      "INTEGRATION_EVENT_CONFLICT",
      "Relay webhook payload identity does not match its authenticated request",
    );
  }
  if (status === "fix_delivered") {
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
  } else if (decoded.payload.deliveryEvidence !== undefined) {
    throw new MobileRelayStorageError(
      "RELAY_DELIVERY_EVIDENCE_INVALID",
      "Only fix_delivered may carry delivery evidence",
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

export function insertBugNotificationOutbox(
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
       WHERE account_row.id = ?`,
    )
    .get(input.projectId, input.actorId, input.accountId);
  if (!authorized) {
    throw new MobileRelayStorageError(
      "FORBIDDEN",
      "Bug updates require an active project membership",
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
  if (input.attachmentIds !== undefined) {
    if (
      input.attachmentIds.length > 20 ||
      new Set(input.attachmentIds).size !== input.attachmentIds.length ||
      input.attachmentIds.some((attachmentId) => !UUID_PATTERN.test(attachmentId))
    ) {
      throw new MobileRelayStorageError(
        "INVALID_REQUEST",
        "attachmentIds must be a unique list of at most 20 UUIDs",
      );
    }
  }
}

function activeBugAttachmentIds(
  database: DatabaseSync,
  input: UpdateMobileBugInput,
): readonly string[] {
  return database
    .prepare(
      `SELECT bug_attachment.attachment_id
       FROM bug_attachments AS bug_attachment
       WHERE bug_attachment.account_id = ?
         AND bug_attachment.project_id = ?
         AND bug_attachment.bug_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM bug_attachment_removals AS removal
           WHERE removal.account_id = bug_attachment.account_id
             AND removal.project_id = bug_attachment.project_id
             AND removal.bug_id = bug_attachment.bug_id
             AND removal.attachment_id = bug_attachment.attachment_id
         )
       ORDER BY bug_attachment.attachment_id`,
    )
    .all(input.accountId, input.projectId, input.bugId)
    .map((row) => String(row.attachment_id));
}

function claimBugUpdateAttachment(
  database: DatabaseSync,
  input: UpdateMobileBugInput,
  attachmentId: string,
): void {
  const reservation = database
    .prepare(
      `SELECT binding.id AS binding_id, binding.version AS binding_version,
              attachment.version AS attachment_version
       FROM attachments AS attachment
       JOIN attachment_bindings AS binding
         ON binding.account_id = attachment.account_id
        AND binding.project_id = attachment.project_id
        AND binding.attachment_id = attachment.id
       JOIN blobs AS blob
         ON blob.account_id = attachment.account_id
        AND blob.id = attachment.blob_id
        AND blob.size_bytes = attachment.size_bytes
        AND blob.sha256 = attachment.sha256
        AND blob.state = 'ready'
       JOIN upload_sessions AS upload
         ON upload.account_id = attachment.account_id
        AND upload.project_id = attachment.project_id
        AND upload.id = attachment.upload_session_id
        AND upload.status = 'finalized'
        AND upload.finalized_attachment_id = attachment.id
       WHERE attachment.account_id = ?
         AND attachment.project_id = ?
         AND attachment.id = ?
         AND attachment.actor_id = ?
         AND attachment.status = 'ready'
         AND attachment.scan_state = 'clean'
         AND binding.intent = 'bug_create'
         AND binding.target_bug_id IS NULL
         AND binding.state = 'reserved'
         AND unixepoch(binding.expires_at) > unixepoch('now')`,
    )
    .get(input.accountId, input.projectId, attachmentId, input.actorId) as
    | {
        readonly binding_id: string;
        readonly binding_version: number;
        readonly attachment_version: number;
      }
    | undefined;
  if (!reservation) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "new Bug attachment has no active reservation owned by the editing actor",
    );
  }
  const bindingUpdate = database
    .prepare(
      `UPDATE attachment_bindings
       SET target_bug_id = ?, state = 'claimed', expires_at = NULL,
           claimed_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND id = ? AND version = ?`,
    )
    .run(
      input.bugId,
      input.createdAt,
      input.accountId,
      input.projectId,
      reservation.binding_id,
      reservation.binding_version,
    );
  const attachmentUpdate = database
    .prepare(
      `UPDATE attachments SET version = version + 1
       WHERE account_id = ? AND project_id = ? AND id = ? AND version = ?`,
    )
    .run(input.accountId, input.projectId, attachmentId, reservation.attachment_version);
  if (bindingUpdate.changes !== 1 || attachmentUpdate.changes !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Bug attachment reservation changed before it could be claimed",
    );
  }
  database
    .prepare(
      `INSERT INTO bug_attachments(
        account_id, project_id, bug_id, attachment_id, binding_id
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.accountId, input.projectId, input.bugId, attachmentId, reservation.binding_id);
}

function reconcileBugUpdateAttachments(
  database: DatabaseSync,
  input: UpdateMobileBugInput,
  bugVersionAfter: number,
): { readonly added: number; readonly removed: number } {
  if (input.attachmentIds === undefined) return { added: 0, removed: 0 };
  const currentIds = activeBugAttachmentIds(database, input);
  const current = new Set(currentIds);
  const requested = new Set(input.attachmentIds);
  const added = input.attachmentIds.filter((attachmentId) => !current.has(attachmentId));
  const removed = currentIds.filter((attachmentId) => !requested.has(attachmentId));

  for (const attachmentId of added) {
    claimBugUpdateAttachment(database, input, attachmentId);
  }
  for (const attachmentId of removed) {
    database
      .prepare(
        `INSERT INTO bug_attachment_removals(
          account_id, project_id, bug_id, attachment_id, bug_version_after,
          removed_by_actor_id, removed_at, idempotency_key, request_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.accountId,
        input.projectId,
        input.bugId,
        attachmentId,
        bugVersionAfter,
        input.actorId,
        input.createdAt,
        input.idempotencyKey,
        input.requestDigest,
      );
  }
  return { added: added.length, removed: removed.length };
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

  const attachmentChanges = reconcileBugUpdateAttachments(database, input, bug.version + 1);

  const eventId = randomUUID();
  const changedFields = mutableColumns
    .filter(([inputKey]) => input[inputKey] !== undefined)
    .map(([, column]) => column);
  if (input.attachmentIds !== undefined) changedFields.push("attachment_ids");
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
      summary:
        `Bug fields updated; changedFields=${changedFields.join(",")}; ` +
        `ownerId=${resultingOwnerId ?? "null"}; attachmentsAdded=${attachmentChanges.added}; ` +
        `attachmentsRemoved=${attachmentChanges.removed}`,
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

export function ensureMobileRelayRoles(
  database: DatabaseSync,
  scope: MobileScopeBootstrap,
  runtime?: MobileRelayRuntimeConfig,
): void {
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
  const principalId = runtime?.relayPrincipalId;
  if (principalId !== undefined && principalId !== MOBILE_FAKE_RELAY_PRINCIPAL_ID) {
    if (!UUID_PATTERN.test(principalId)) {
      throw new MobileRelayStorageError("INVALID_REQUEST", "relayPrincipalId must be a UUID");
    }
    database
      .prepare(
        `INSERT OR IGNORE INTO service_principals(
          id, account_id, name, principal_type, credential_digest, status,
          created_at, revoked_at, version
        ) VALUES (?, ?, 'Configured Relay executor', 'relay', ?, 'active', ?, NULL, 1)`,
      )
      .run(
        principalId,
        scope.accountId,
        createHash("sha256").update(`relay-qa-hub-configured:${principalId}`).digest("hex"),
        scope.createdAt,
      );
  }
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
    (row.status !== "planned" &&
      row.status !== "running" &&
      row.status !== "delivered" &&
      row.status !== "verification_failed")
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
    patchUrl: row.patch_url ?? null,
    noCodeReason: row.no_code_reason ?? null,
    failureReason: row.failure_reason ?? null,
    targetBuildId: null,
    version: row.version,
  });
}

function assertRepairAttemptAssignee(
  database: DatabaseSync,
  input: MobileRelayScope & { readonly assigneeId: string },
): void {
  if (!UUID_PATTERN.test(input.assigneeId)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "assigneeId is invalid");
  }
  const assignable = database
    .prepare(
      `SELECT 1 AS present
       FROM accounts AS account
       JOIN projects AS project
         ON project.account_id = account.id
        AND project.id = ?
        AND project.status = 'active'
       JOIN users AS assignee
         ON assignee.account_id = account.id
        AND assignee.id = ?
        AND assignee.status = 'active'
       JOIN memberships AS membership
         ON membership.account_id = account.id
        AND membership.project_id = project.id
        AND membership.user_id = assignee.id
        AND membership.status = 'active'
       JOIN membership_roles AS role
         ON role.account_id = membership.account_id
        AND role.project_id = membership.project_id
        AND role.membership_id = membership.id
        AND role.role = 'developer'
       WHERE account.id = ? AND account.status = 'active'`,
    )
    .get(input.projectId, input.assigneeId, input.accountId);
  if (!assignable) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "assigneeId must be an active developer in the requested project",
    );
  }
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
  assertRepairAttemptAssignee(database, input);
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
  insertBugNotificationOutbox(database, {
    ...input,
    eventId,
    eventType: "repair_attempt.created",
    bugVersion: bug.version + 1,
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
  assertRepairAttemptAssignee(database, input);
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
  insertBugNotificationOutbox(database, {
    ...input,
    eventId,
    eventType: "repair_attempt.created",
    bugVersion: bug.version + 1,
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
              summary, branch, commit_sha, merge_request_url, patch_url,
              no_code_reason, target_build_id, failure_reason, version
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
  if (input.deliveryKind === "code") {
    requireWorkflowText(input.branch, "branch", 300);
    requireWorkflowCommit(input.commitSha);
    if (input.mergeRequestUrl !== null) {
      requireWorkflowText(input.mergeRequestUrl, "mergeRequestUrl", 4_000);
    }
    if (input.patchUrl !== null) requireWorkflowText(input.patchUrl, "patchUrl", 4_000);
  } else {
    requireWorkflowText(input.noCodeReason, "noCodeReason", 5_000);
  }
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
    toState: input.deliveryKind === "code" ? "awaiting_build" : "ready_for_verification",
    payload: {
      status: "delivered",
      repairAttemptId: attempt.id,
      ...(input.deliveryKind === "code" ? { commitSha: input.commitSha } : {}),
      ...(input.deliveryKind === "no_code"
        ? { reason: toBoundedAuditText(input.noCodeReason) }
        : {}),
      fromVersion: attempt.version,
      toVersion: attempt.version + 1,
    },
    createdAt: at,
  });
  insertBugNotificationOutbox(database, {
    ...input,
    bugId: attempt.bug_id,
    eventId,
    eventType: "repair_attempt.delivered",
    bugVersion: attempt.bug_version + 1,
    createdAt: at,
  });
  const updatedAttempt = database
    .prepare(
      `UPDATE repair_attempts
       SET status = 'delivered', summary = ?, branch = ?, commit_sha = ?,
           merge_request_url = ?, patch_url = ?, no_code_reason = ?,
           target_build_id = NULL, updated_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND id = ?
         AND status = 'running' AND version = ?`,
    )
    .run(
      input.summary,
      input.branch,
      input.commitSha,
      input.mergeRequestUrl,
      input.patchUrl,
      input.noCodeReason,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, '1.0.0', ?, ?, ?, 1)`,
    )
    .run(
      requirementId,
      input.accountId,
      input.projectId,
      attempt.bug_id,
      attempt.id,
      attempt.version + 1,
      input.commitSha,
      input.deliveryKind === "code" ? "required" : "not_required",
      input.deliveryKind === "code" ? "code_requires_build" : "no_code_delivery",
      input.deliveryKind === "code" ? null : input.noCodeReason,
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
       SET state = ?, updated_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND id = ? AND state = 'in_progress'
         AND version = ? AND active_repair_attempt_id = ?`,
    )
    .run(
      input.deliveryKind === "code" ? "awaiting_build" : "ready_for_verification",
      at,
      input.accountId,
      input.projectId,
      attempt.bug_id,
      attempt.bug_version,
      attempt.id,
    );
  if (updatedBug.changes !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Bug did not enter its delivery state exactly once",
    );
  }
  const row = database
    .prepare(
      `SELECT id, bug_id, sequence, mode, status, assignee_id, parent_attempt_id,
              summary, branch, commit_sha, merge_request_url, patch_url,
              no_code_reason, target_build_id, failure_reason, version
       FROM repair_attempts
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, attempt.id) as AttemptRow | undefined;
  if (!row)
    throw new MobileRelayStorageError("NOT_FOUND", "RepairAttempt disappeared after delivery");
  return toManualAttempt(row);
}

export function completeMobileBugForVerification(
  database: DatabaseSync,
  input: CompleteMobileBugForVerificationInput,
): MobileBugRecord {
  requireTransaction(database);
  requireWorkflowText(input.reason, "reason", 5_000);
  requireWorkflowText(input.idempotencyKey, "idempotencyKey", 200);
  if (!SHA256_PATTERN.test(input.requestDigest)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "requestDigest is invalid");
  }

  const replay = database
    .prepare(
      `SELECT request_digest AS requestDigest
       FROM events
       WHERE account_id = ? AND project_id = ? AND bug_id = ?
         AND type = 'bug.completed_for_verification'
         AND actor_user_id = ? AND request_digest = ?
       ORDER BY event_position DESC
       LIMIT 1`,
    )
    .get(input.accountId, input.projectId, input.bugId, input.actorId, input.requestDigest) as
    { readonly requestDigest: string } | undefined;
  if (replay) {
    if (replay.requestDigest !== input.requestDigest) {
      throw new MobileRelayStorageError(
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
        "task completion idempotency key was already used with another payload",
      );
    }
    const replayedBug = readBugRow(database, input, input.bugId);
    if (!replayedBug || replayedBug.state !== "ready_for_verification") {
      throw new MobileRelayStorageError(
        "VERSION_CONFLICT",
        "task completion replay no longer points to a pending Verification",
      );
    }
    return toBug(replayedBug);
  }

  const attempt = readManualWorkflowAttempt(database, input, input.repairAttemptId);
  if (!attempt || attempt.bug_id !== input.bugId) {
    throw new MobileRelayStorageError("NOT_FOUND", "delivered RepairAttempt was not found");
  }
  if (
    attempt.status !== "delivered" ||
    attempt.bug_state !== "awaiting_build" ||
    attempt.bug_version !== input.expectedVersion
  ) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Bug is not an exact delivered task awaiting completion",
    );
  }
  const requirement = database
    .prepare(
      `SELECT id, requirement, decision_basis AS decisionBasis,
              delivered_commit_sha AS deliveredCommitSha, version,
              linked_build_id AS linkedBuildId, link_id AS linkId
       FROM build_requirements
       WHERE account_id = ? AND project_id = ? AND bug_id = ?
         AND repair_attempt_id = ?`,
    )
    .get(input.accountId, input.projectId, input.bugId, input.repairAttemptId) as
    | {
        readonly id: string;
        readonly requirement: string;
        readonly decisionBasis: string;
        readonly deliveredCommitSha: string | null;
        readonly version: number;
        readonly linkedBuildId: string | null;
        readonly linkId: string | null;
      }
    | undefined;
  if (
    !requirement ||
    requirement.requirement !== "required" ||
    requirement.decisionBasis !== "code_requires_build" ||
    requirement.deliveredCommitSha !== attempt.commit_sha ||
    requirement.version !== 1 ||
    requirement.linkedBuildId !== null ||
    requirement.linkId !== null
  ) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "delivered task is not eligible for manual completion",
    );
  }
  const activeMembership = database
    .prepare(
      `SELECT 1 AS present
       FROM accounts AS account
       JOIN projects AS project
         ON project.account_id = account.id
        AND project.id = ?
        AND project.status = 'active'
       JOIN users AS user
         ON user.account_id = account.id
        AND user.id = ?
        AND user.status = 'active'
       JOIN memberships AS membership
         ON membership.account_id = account.id
        AND membership.project_id = project.id
        AND membership.user_id = user.id
        AND membership.status = 'active'
       WHERE account.id = ? AND account.status = 'active'`,
    )
    .get(input.projectId, input.actorId, input.accountId);
  if (!activeMembership) {
    throw new MobileRelayStorageError("FORBIDDEN", "actor has no active project membership");
  }

  const at = nextTimestamp(input.createdAt, attempt.updated_at);
  const eventId = randomUUID();
  insertUserEvent(database, {
    ...input,
    id: eventId,
    type: "bug.completed_for_verification",
    aggregateType: "bug",
    aggregateId: input.bugId,
    aggregateSequence: nextBugAggregateSequence(database, input, input.bugId),
    resourceType: "bug",
    resourceId: input.bugId,
    resourceVersionAfter: input.expectedVersion + 1,
    correlationId: randomUUID(),
    fromState: "awaiting_build",
    toState: "ready_for_verification",
    payload: {
      status: "ready_for_verification",
      repairAttemptId: input.repairAttemptId,
      reason: toBoundedAuditText(input.reason),
      fromVersion: input.expectedVersion,
      toVersion: input.expectedVersion + 1,
    },
    createdAt: at,
  });
  insertBugNotificationOutbox(database, {
    ...input,
    eventId,
    eventType: "bug.completed_for_verification",
    bugVersion: input.expectedVersion + 1,
    createdAt: at,
  });
  const updated = database
    .prepare(
      `UPDATE bugs
       SET state = 'ready_for_verification', updated_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND id = ?
         AND state = 'awaiting_build' AND version = ?
         AND active_repair_attempt_id = ? AND active_verification_id IS NULL`,
    )
    .run(
      at,
      input.accountId,
      input.projectId,
      input.bugId,
      input.expectedVersion,
      input.repairAttemptId,
    );
  if (updated.changes !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Bug did not enter ready_for_verification exactly once",
    );
  }
  const bug = readBugRow(database, input, input.bugId);
  if (!bug) throw new MobileRelayStorageError("NOT_FOUND", "Bug disappeared after completion");
  return toBug(bug);
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
  insertBugNotificationOutbox(database, {
    ...input,
    bugId: attempt.bug_id,
    eventId,
    eventType: "build.repair_linked",
    bugVersion: attempt.bug_version + 1,
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

function relayInstanceIdFor(input: { readonly relayInstanceId?: string }): string {
  const relayInstanceId = input.relayInstanceId ?? MOBILE_FAKE_RELAY_INSTANCE_ID;
  if (!RELAY_INSTANCE_PATTERN.test(relayInstanceId)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "relayInstanceId is invalid");
  }
  return relayInstanceId;
}

function qaInstanceIdFor(input: { readonly qaInstanceId?: string }): string | null {
  if (input.qaInstanceId === undefined || input.qaInstanceId === null) return null;
  if (
    typeof input.qaInstanceId !== "string" ||
    input.qaInstanceId.length < 1 ||
    input.qaInstanceId.length > 64 ||
    input.qaInstanceId.trim() !== input.qaInstanceId ||
    !RELAY_INSTANCE_PATTERN.test(input.qaInstanceId)
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "qaInstanceId is invalid");
  }
  return input.qaInstanceId;
}

function relayPrincipalIdFor(input: { readonly relayPrincipalId?: string }): string {
  const principalId = input.relayPrincipalId ?? MOBILE_FAKE_RELAY_PRINCIPAL_ID;
  if (!UUID_PATTERN.test(principalId)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "relayPrincipalId is invalid");
  }
  return principalId;
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

interface DispatchAttachmentRow {
  readonly id: string;
  readonly file_name: string;
  readonly media_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly storage_key: string;
}

interface RelayAttachmentSelectionScope {
  readonly accountId: string;
  readonly projectId: string;
  readonly selectedAttachmentIds: readonly string[];
}

function readSelectedRelayAttachments(
  database: DatabaseSync,
  input: RelayAttachmentSelectionScope,
  bugId: string,
): MobileRelayAttachmentClaim[] {
  const ids = input.selectedAttachmentIds;
  if (ids.length > 8 || new Set(ids).size !== ids.length) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "selectedAttachmentIds are invalid");
  }
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `SELECT attachment.id, attachment.file_name, attachment.media_type,
              attachment.size_bytes, attachment.sha256, blob.storage_key
       FROM bug_attachments AS bug_attachment
       JOIN attachments AS attachment
         ON attachment.account_id = bug_attachment.account_id
        AND attachment.project_id = bug_attachment.project_id
        AND attachment.id = bug_attachment.attachment_id
        AND attachment.status = 'ready'
        AND attachment.scan_state = 'clean'
       JOIN attachment_bindings AS binding
         ON binding.account_id = bug_attachment.account_id
        AND binding.project_id = bug_attachment.project_id
        AND binding.id = bug_attachment.binding_id
        AND binding.attachment_id = attachment.id
        AND binding.target_bug_id = bug_attachment.bug_id
        AND binding.state = 'claimed'
       JOIN blobs AS blob
         ON blob.account_id = attachment.account_id
        AND blob.id = attachment.blob_id
        AND blob.size_bytes = attachment.size_bytes
        AND blob.sha256 = attachment.sha256
        AND blob.state = 'ready'
       WHERE bug_attachment.account_id = ? AND bug_attachment.project_id = ?
         AND bug_attachment.bug_id = ?
         AND attachment.id IN (${placeholders})
       ORDER BY attachment.created_at, attachment.id`,
    )
    .all(input.accountId, input.projectId, bugId, ...ids) as unknown as DispatchAttachmentRow[];
  if (rows.length !== ids.length) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "selected Relay attachments must belong to the current Bug and be finalized/clean",
    );
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw new MobileRelayStorageError("NOT_FOUND", "Relay attachment was not found");
    return Object.freeze({
      attachmentId: row.id,
      filename: row.file_name,
      mediaType: row.media_type,
      size: row.size_bytes,
      sha256: row.sha256,
      storageKey: row.storage_key,
    });
  });
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
  const relayInstanceId = relayInstanceIdFor(input);
  const qaInstanceId = qaInstanceIdFor(input);
  const relayPrincipalId = relayPrincipalIdFor(input);
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
  const bugFacts = readBugRow(database, input, attempt.bug_id);
  if (!bugFacts) throw new MobileRelayStorageError("NOT_FOUND", "Bug was not found");
  const project = database
    .prepare(`SELECT project_key FROM projects WHERE account_id = ? AND id = ?`)
    .get(input.accountId, input.projectId) as { readonly project_key?: string } | undefined;
  if (!project?.project_key) {
    throw new MobileRelayStorageError("NOT_FOUND", "Relay project facts are missing");
  }
  const attachments = readSelectedRelayAttachments(database, input, attempt.bug_id);
  const defect = Object.freeze({
    id: bugFacts.id,
    key: bugFacts.key,
    revision: bugFacts.version,
    projectKey: project.project_key,
    title: bugFacts.title,
    description: bugFacts.description,
    severity: bugFacts.severity,
    verificationCriteria: bugFacts.expected_behavior,
  });
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
      attachmentCount: attachments.length,
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
      JSON.stringify({
        relayInstanceId,
        qaInstanceId,
        relayPrincipalId,
        projectKey: project.project_key,
      }),
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
      relayInstanceId,
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
      relayInstanceId,
      qaInstanceId === null
        ? `relay:${input.handoffId}`
        : `qa:${qaInstanceId}:handoff:${input.handoffId}`,
      eventId,
      JSON.stringify({
        operation: "create",
        bugId: attempt.bug_id,
        repairAttemptId: attempt.id,
        handoffId: input.handoffId,
        relayInstanceId,
        qaInstanceId,
        projectKey: project.project_key,
        defect,
        selectedAttachments: attachments,
        selectedAttachmentIds: input.selectedAttachmentIds,
      }),
      at,
      at,
    );
  const accepted: MobileRelayDispatchAccepted = Object.freeze({
    qaItem: { type: "bug" as const, id: attempt.bug_id, key: attempt.bug_key ?? "" },
    repairAttemptId: attempt.id,
    handoffId: input.handoffId,
    relayInstanceId,
    qaInstanceId,
    outboxMessageId,
    requestId,
    status: "queued",
    operation: "create",
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

function continueScopeDigest(input: ContinueMobileRelayInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        accountId: input.accountId,
        actorId: input.actorId,
        projectId: input.projectId,
        operationId: "continueRelayHandoff",
      }),
    )
    .digest("hex");
}

export function continueMobileRelay(
  database: DatabaseSync,
  input: ContinueMobileRelayInput,
): MobileRelayContinueAccepted {
  requireTransaction(database);
  const relayInstanceId = relayInstanceIdFor(input);
  const qaInstanceId = qaInstanceIdFor(input);
  if (qaInstanceId === null) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "qaInstanceId is required for continue");
  }
  if (
    input.actionId.length < 1 ||
    input.actionId.length > 200 ||
    input.actionId.trim() !== input.actionId
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "actionId is invalid");
  }
  if (input.prompt.length < 1 || input.prompt.length > 50_000) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "prompt is invalid");
  }
  const replayRow = database
    .prepare(
      `SELECT request_digest, status, response_json
       FROM idempotency_records
       WHERE account_id = ? AND actor_id = ? AND operation_id = 'continueRelayHandoff'
         AND scope_digest = ? AND idempotency_key = ?`,
    )
    .get(input.accountId, input.actorId, continueScopeDigest(input), input.idempotencyKey) as
    | {
        readonly request_digest: string;
        readonly status: string;
        readonly response_json: string | null;
      }
    | undefined;
  if (replayRow) {
    if (replayRow.request_digest !== input.requestDigest) {
      throw new MobileRelayStorageError(
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
        "Idempotency-Key was already used with a different Relay continuation payload",
      );
    }
    if (replayRow.status !== "committed" || replayRow.response_json === null) {
      throw new MobileRelayStorageError("VERSION_CONFLICT", "Relay continuation is not committed");
    }
    return Object.freeze({
      ...(JSON.parse(replayRow.response_json) as MobileRelayContinueAccepted),
      replayed: true,
    });
  }
  const receipt = database
    .prepare(
      `SELECT receipt.bug_id, receipt.relay_instance_id, receipt.handoff_id,
              attempt.mode, attempt.status, attempt.version, attempt.updated_at
       FROM relay_receipts AS receipt
       JOIN repair_attempts AS attempt
         ON attempt.account_id = receipt.account_id
        AND attempt.project_id = receipt.project_id
        AND attempt.id = receipt.repair_attempt_id
        AND attempt.bug_id = receipt.bug_id
       WHERE receipt.account_id = ? AND receipt.project_id = ?
         AND receipt.repair_attempt_id = ? AND receipt.handoff_id = ?
         AND receipt.relay_instance_id = ?
         AND attempt.mode = 'relay'`,
    )
    .get(input.accountId, input.projectId, input.attemptId, input.handoffId, relayInstanceId) as
    | {
        readonly bug_id: string;
        readonly relay_instance_id: string;
        readonly handoff_id: string;
        readonly mode: string;
        readonly status: string;
        readonly version: number;
        readonly updated_at: string;
      }
    | undefined;
  if (!receipt) throw new MobileRelayStorageError("NOT_FOUND", "Relay handoff was not found");
  if (receipt.mode !== "relay" || ["cancelled", "superseded"].includes(receipt.status)) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "Relay handoff cannot be continued");
  }
  const attachments = readSelectedRelayAttachments(database, input, receipt.bug_id);
  const at = nextTimestamp(input.createdAt, receipt.updated_at);
  const idempotencyId = randomUUID();
  const expiresAt = new Date(Date.parse(at) + 7 * 24 * 60 * 60 * 1_000).toISOString();
  database
    .prepare(
      `INSERT INTO idempotency_records(
        id, account_id, project_id, actor_id, operation_id, idempotency_key,
        scope_digest, scope_json, request_digest, status, http_status, response_json,
        audit_event_id, created_at, expires_at, version
      ) VALUES (?, ?, ?, ?, 'continueRelayHandoff', ?, ?, ?, ?, 'reserved',
                NULL, NULL, NULL, ?, ?, 1)`,
    )
    .run(
      idempotencyId,
      input.accountId,
      input.projectId,
      input.actorId,
      input.idempotencyKey,
      continueScopeDigest(input),
      JSON.stringify({
        accountId: input.accountId,
        actorId: input.actorId,
        projectId: input.projectId,
        operationId: "continueRelayHandoff",
      }),
      input.requestDigest,
      at,
      expiresAt,
    );
  const eventId = randomUUID();
  const requestId = randomUUID();
  insertUserEvent(database, {
    ...input,
    id: eventId,
    bugId: receipt.bug_id,
    type: "repair.handoff_queued",
    aggregateType: "repair_attempt",
    aggregateId: input.attemptId,
    aggregateSequence: nextRelayAggregateSequence(
      database,
      input.accountId,
      input.projectId,
      input.attemptId,
    ),
    resourceType: "relay_handoff",
    resourceId: input.handoffId,
    resourceVersionAfter: receipt.version,
    correlationId: requestId,
    fromState: null,
    toState: null,
    payload: {
      status: "queued",
      repairAttemptId: input.attemptId,
      handoffId: input.handoffId,
      attachmentCount: attachments.length,
    },
    createdAt: at,
  });
  const outboxMessageId = randomUUID();
  database
    .prepare(
      `INSERT INTO outbox(
        id, account_id, project_id, aggregate_type, aggregate_id, aggregate_version,
        destination, dedupe_key, event_id, payload_json, status, attempt_count,
        next_attempt_at, lease_owner, lease_expires_at, last_error_code, created_at, sent_at
      ) VALUES (?, ?, ?, 'repair_attempt', ?, ?, ?, ?, ?, ?, 'pending', 0, ?,
                NULL, NULL, NULL, ?, NULL)`,
    )
    .run(
      outboxMessageId,
      input.accountId,
      input.projectId,
      input.attemptId,
      receipt.version,
      relayInstanceId,
      `qa:${qaInstanceId}:action:${input.actionId}`,
      eventId,
      JSON.stringify({
        operation: "continue",
        bugId: receipt.bug_id,
        repairAttemptId: input.attemptId,
        handoffId: input.handoffId,
        qaInstanceId,
        relayInstanceId,
        actionId: input.actionId,
        prompt: input.prompt,
        selectedAttachments: attachments,
        selectedAttachmentIds: input.selectedAttachmentIds,
      }),
      at,
      at,
    );
  const accepted: MobileRelayContinueAccepted = Object.freeze({
    repairAttemptId: input.attemptId,
    handoffId: input.handoffId,
    relayInstanceId,
    qaInstanceId,
    actionId: input.actionId,
    outboxMessageId,
    requestId,
    status: "queued",
    operation: "continue",
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
              receipt.failure_summary, receipt.version,
              integration.metadata_json
       FROM relay_receipts AS receipt
       JOIN bugs AS bug
         ON bug.account_id = receipt.account_id AND bug.project_id = receipt.project_id
        AND bug.id = receipt.bug_id
       JOIN integration_links AS integration
         ON integration.account_id = receipt.account_id
        AND integration.project_id = receipt.project_id
        AND integration.id = receipt.integration_link_id
       WHERE receipt.account_id = ? AND receipt.project_id = ?
         AND receipt.repair_attempt_id = ?`,
    )
    .get(input.accountId, input.projectId, input.attemptId) as
    (ReceiptRow & { readonly metadata_json: string }) | undefined;
  if (!row) return null;
  const metadata = parseRelayMetadata(row.metadata_json);
  const evidence = readLatestRelayReceiptEvidence(
    database,
    input,
    row.repair_attempt_id,
    row.relay_instance_id,
  );
  return Object.freeze({
    qaItem: { type: "bug" as const, id: row.bug_id, key: row.bug_key },
    repairAttemptId: row.repair_attempt_id,
    handoffId: row.handoff_id,
    relayInstanceId: row.relay_instance_id,
    qaInstanceId: metadata.qaInstanceId,
    relayTaskId: row.relay_task_id,
    relayTurnId: evidence.turnId,
    branch: evidence.branch,
    threadId: evidence.threadId,
    workspace: evidence.workspace,
    requestHash: evidence.requestHash,
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

interface RelayReceiptEvidence {
  readonly turnId: string | null;
  readonly branch: string | null;
  readonly threadId: string | null;
  readonly workspace: MobileRelayWorkspace | null;
  readonly requestHash: string | null;
}

function parseRelayMetadata(value: string): {
  readonly qaInstanceId: string | null;
  readonly relayPrincipalId: string | null;
  readonly projectKey: string | null;
} {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return { qaInstanceId: null, relayPrincipalId: null, projectKey: null };
    return {
      qaInstanceId: typeof parsed.qaInstanceId === "string" ? parsed.qaInstanceId : null,
      relayPrincipalId:
        typeof parsed.relayPrincipalId === "string" ? parsed.relayPrincipalId : null,
      projectKey: typeof parsed.projectKey === "string" ? parsed.projectKey : null,
    };
  } catch {
    return { qaInstanceId: null, relayPrincipalId: null, projectKey: null };
  }
}

function readLatestRelayReceiptEvidence(
  database: DatabaseSync,
  input: MobileRelayScope,
  attemptId: string,
  relayInstanceId: string,
): RelayReceiptEvidence {
  const row = database
    .prepare(
      `SELECT payload_json
       FROM outbox
       WHERE account_id = ? AND project_id = ?
         AND aggregate_type = 'repair_attempt' AND aggregate_id = ?
         AND destination = ? AND status = 'sent'
         AND json_type(payload_json, '$.receiptEvidence') = 'object'
       ORDER BY sent_at DESC, id DESC
       LIMIT 1`,
    )
    .get(input.accountId, input.projectId, attemptId, relayInstanceId) as
    { readonly payload_json?: string } | undefined;
  if (!row?.payload_json) {
    return { turnId: null, branch: null, threadId: null, workspace: null, requestHash: null };
  }
  try {
    const payload = JSON.parse(row.payload_json) as unknown;
    if (!isRecord(payload) || !isRecord(payload.receiptEvidence)) {
      return { turnId: null, branch: null, threadId: null, workspace: null, requestHash: null };
    }
    const evidence = payload.receiptEvidence;
    const turnId = requireRelayIdentity(evidence.turnId, "turnId");
    const workspace = validateRelayWorkspace(evidence.workspace, "workspace");
    const branch =
      typeof evidence.branchName === "string"
        ? evidence.branchName
        : (workspace?.branchName ?? null);
    const threadId = typeof evidence.threadId === "string" ? evidence.threadId : null;
    const requestHash =
      typeof evidence.requestHash === "string" && SHA256_PATTERN.test(evidence.requestHash)
        ? evidence.requestHash
        : null;
    return { turnId, branch, threadId, workspace, requestHash };
  } catch {
    return { turnId: null, branch: null, threadId: null, workspace: null, requestHash: null };
  }
}

function requireRelayWebhookPrincipal(
  database: DatabaseSync,
  accountId: string,
  principalId: string,
): void {
  const principal = database
    .prepare(
      `SELECT principal.id
       FROM service_principals AS principal
       JOIN accounts AS account ON account.id = principal.account_id
       WHERE principal.account_id = ? AND principal.id = ?
         AND principal.principal_type = 'relay'
         AND principal.status = 'active' AND account.status = 'active'`,
    )
    .get(accountId, principalId) as { readonly id: string } | undefined;
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
              receipt.payload_digest, receipt.version, integration.id AS integration_link_id,
              integration.metadata_json
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
      ) VALUES (?, ?, ?, 'relay', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      id,
      input.accountId,
      input.projectId,
      input.relayInstanceId,
      input.eventId,
      input.deliveryId,
      input.eventType,
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
  const receipt = readRelayWebhookReceipt(database, input);
  if (!receipt) {
    throw new MobileRelayStorageError(
      "NOT_FOUND",
      "Relay webhook does not match an active exact handoff tuple",
    );
  }
  const metadata = parseRelayMetadata(receipt.metadata_json);
  requireRelayWebhookPrincipal(
    database,
    input.accountId,
    metadata.relayPrincipalId ?? MOBILE_FAKE_RELAY_PRINCIPAL_ID,
  );

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

  const status = relayWebhookStatus(input.eventType);
  const incomingTaskId = requireRelayIdentity(input.taskId, "taskId");
  const relayTaskId = incomingTaskId ?? receipt.relay_task_id;
  if (relayTaskId === null) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "Relay webhook taskId is required");
  }
  // The handoff acknowledgement may carry a Relay task label while the
  // delivery webhook carries the authoritative numeric task id.  Permit that
  // one pre-delivery reconciliation, then keep the task identity immutable
  // for later revisions.
  if (
    receipt.relay_task_id !== null &&
    relayTaskId !== null &&
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
  const currentTerminal =
    receipt.handoff_status === "fix_delivered" ||
    receipt.handoff_status === "awaiting_build" ||
    receipt.handoff_status === "awaiting_verification";
  const projectedStatus: MobileRelayReceipt["handoffStatus"] =
    currentTerminal && status !== "fix_delivered" ? receipt.handoff_status : status;
  const buildRequirement =
    status === "fix_delivered"
      ? (normalizeBuildRequirement(input.buildRequirement) ?? "required")
      : receipt.build_requirement;
  const buildEvidenceStatus =
    status === "fix_delivered"
      ? buildRequirement === "required"
        ? "pending"
        : "not_required"
      : receipt.build_evidence_status;
  const deliveredCommitSha =
    status === "fix_delivered" ? (input.commitSha ?? null) : receipt.delivered_commit_sha;
  if (
    projectedStatus !== "fix_delivered" &&
    projectedStatus !== "awaiting_build" &&
    projectedStatus !== "awaiting_verification" &&
    deliveredCommitSha !== null
  ) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "Relay delivery evidence cannot regress");
  }
  const failureSummary =
    projectedStatus === "failed" ? (input.statusReason ?? "Relay reported failure") : null;
  const receiptUpdateParameters: Array<string | number | null> = [
    relayTaskId,
    projectedStatus,
    input.externalRevision,
    buildRequirement,
    buildEvidenceStatus,
    deliveredCommitSha,
    eventAt,
    failureSummary,
    input.payloadDigest,
    input.receivedAt,
    input.accountId,
    input.projectId,
    input.attemptId,
    input.handoffId,
    input.relayInstanceId,
    receipt.version,
    input.externalRevision,
  ];
  const receiptUpdate = database
    .prepare(
      `UPDATE relay_receipts
       SET relay_task_id = ?, handoff_status = ?, external_revision = ?,
           build_requirement = ?, build_evidence_status = ?, delivered_commit_sha = ?,
           last_event_at = ?, failure_summary = ?,
           payload_digest = ?, received_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND repair_attempt_id = ?
         AND handoff_id = ? AND relay_instance_id = ?
         AND version = ? AND external_revision < ?`,
    )
    .run(...receiptUpdateParameters);
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
      ) VALUES (?, ?, ?, ?, ?, 'relay', 'service', ?,
                'repair_attempt', ?, ?, 'repair_attempt', ?, ?, ?, ?, NULL, NULL,
                NULL, ?, ?)`,
    )
    .run(
      eventId,
      input.accountId,
      input.projectId,
      receipt.bug_id,
      `repair.${status}`,
      metadata.relayPrincipalId ?? MOBILE_FAKE_RELAY_PRINCIPAL_ID,
      input.attemptId,
      aggregateSequence,
      input.attemptId,
      receiptVersionAfter,
      input.payloadDigest,
      randomUUID(),
      JSON.stringify({
        status,
        repairAttemptId: input.attemptId,
        handoffId: input.handoffId,
        ...(status === "fix_delivered" ? { commitSha: input.commitSha } : {}),
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
  readonly account_id: string;
  readonly project_id: string;
  readonly aggregate_id: string;
  readonly destination: string;
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
    readonly relayInstanceId?: string;
  },
): MobileRelayOutboxClaim | null {
  requireTransaction(database);
  const relayInstanceId = relayInstanceIdFor(input);
  const row = database
    .prepare(
      `SELECT outbox.id, outbox.account_id, outbox.project_id, outbox.aggregate_id,
              outbox.destination, outbox.payload_json, outbox.dedupe_key,
              outbox.attempt_count, receipt.payload_digest
       FROM outbox
       JOIN relay_receipts AS receipt
         ON receipt.account_id = outbox.account_id
        AND receipt.project_id = outbox.project_id
        AND receipt.repair_attempt_id = outbox.aggregate_id
        AND receipt.relay_instance_id = outbox.destination
       WHERE outbox.destination = ?
         AND (outbox.status IN ('pending', 'retry')
              OR (outbox.status = 'claimed' AND outbox.lease_expires_at <= ?))
         AND outbox.next_attempt_at <= ?
         AND NOT EXISTS (
           SELECT 1
           FROM outbox AS earlier
           WHERE earlier.account_id = outbox.account_id
             AND earlier.project_id = outbox.project_id
             AND earlier.destination = outbox.destination
             AND earlier.aggregate_type = outbox.aggregate_type
             AND earlier.aggregate_id = outbox.aggregate_id
             AND earlier.aggregate_version < outbox.aggregate_version
             AND earlier.status <> 'sent'
         )
         AND (
           json_extract(outbox.payload_json, '$.operation') = 'continue'
           OR receipt.handoff_status = 'queued'
         )
       ORDER BY outbox.next_attempt_at, outbox.id
       LIMIT 1`,
    )
    .get(relayInstanceId, input.now, input.now) as MobileRelayOutboxRow | undefined;
  if (!row) return null;

  let payload: Record<string, unknown>;
  try {
    const decoded = JSON.parse(row.payload_json) as unknown;
    if (!isRecord(decoded)) throw new Error("payload is not an object");
    payload = decoded;
  } catch {
    database
      .prepare(
        `UPDATE outbox
         SET status = 'dead', lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = 'RELAY_OUTBOX_PAYLOAD_INVALID'
         WHERE id = ?`,
      )
      .run(row.id);
    return null;
  }

  const claimed = database
    .prepare(
      `UPDATE outbox
       SET status = 'claimed', attempt_count = attempt_count + 1,
           lease_owner = ?, lease_expires_at = ?, last_error_code = NULL
       WHERE id = ? AND (status IN ('pending', 'retry')
          OR (status = 'claimed' AND lease_expires_at <= ?)) AND next_attempt_at <= ?`,
    )
    .run(input.leaseOwner, input.leaseExpiresAt, row.id, input.now, input.now);
  if (claimed.changes !== 1) return null;

  const bugId = payload.bugId;
  const repairAttemptId = payload.repairAttemptId;
  const handoffId = payload.handoffId;
  const selectedAttachmentIds = payload.selectedAttachmentIds;
  if (
    typeof bugId !== "string" ||
    typeof repairAttemptId !== "string" ||
    typeof handoffId !== "string" ||
    !Array.isArray(selectedAttachmentIds) ||
    selectedAttachmentIds.some((value) => typeof value !== "string")
  ) {
    database
      .prepare(
        `UPDATE outbox SET status = 'dead', lease_owner = NULL,
         lease_expires_at = NULL, last_error_code = 'RELAY_OUTBOX_PAYLOAD_INVALID'
         WHERE id = ? AND status = 'claimed' AND lease_owner = ?`,
      )
      .run(row.id, input.leaseOwner);
    return null;
  }
  const bug = readBugRow(
    database,
    { accountId: row.account_id, projectId: row.project_id, actorId: "" },
    bugId,
  );
  const project = database
    .prepare(`SELECT project_key FROM projects WHERE account_id = ? AND id = ?`)
    .get(row.account_id, row.project_id) as { readonly project_key?: string } | undefined;
  if (!bug || !project?.project_key) {
    database
      .prepare(
        `UPDATE outbox SET status = 'dead', lease_owner = NULL,
         lease_expires_at = NULL, last_error_code = 'RELAY_OUTBOX_BINDING_INVALID'
         WHERE id = ? AND status = 'claimed' AND lease_owner = ?`,
      )
      .run(row.id, input.leaseOwner);
    return null;
  }
  const attachmentInput: RelayAttachmentSelectionScope = {
    accountId: row.account_id,
    projectId: row.project_id,
    selectedAttachmentIds,
  };
  let selectedAttachments: MobileRelayAttachmentClaim[];
  try {
    selectedAttachments = readSelectedRelayAttachments(database, attachmentInput, bug.id);
  } catch {
    database
      .prepare(
        `UPDATE outbox SET status = 'dead', lease_owner = NULL,
         lease_expires_at = NULL, last_error_code = 'RELAY_ATTACHMENT_NOT_READABLE'
         WHERE id = ? AND status = 'claimed' AND lease_owner = ?`,
      )
      .run(row.id, input.leaseOwner);
    return null;
  }
  const operation = payload.operation === "continue" ? "continue" : "create";
  const qaInstanceId = typeof payload.qaInstanceId === "string" ? payload.qaInstanceId : null;
  const defect = Object.freeze({
    id: bug.id,
    key: bug.key,
    revision: bug.version,
    projectKey: project.project_key,
    title: bug.title,
    description: bug.description,
    severity: bug.severity,
    verificationCriteria: bug.expected_behavior,
  });
  return Object.freeze({
    outboxMessageId: row.id,
    bugId,
    repairAttemptId,
    handoffId,
    relayInstanceId: row.destination,
    qaInstanceId,
    projectKey: project.project_key,
    defect,
    selectedAttachments: Object.freeze(selectedAttachments),
    operation,
    actionId: typeof payload.actionId === "string" ? payload.actionId : null,
    prompt: typeof payload.prompt === "string" ? payload.prompt : null,
    idempotencyKey: row.dedupe_key,
    payloadDigest: row.payload_digest,
    selectedAttachmentIds: Object.freeze([...selectedAttachmentIds]),
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
              outbox.event_id, outbox.destination, outbox.payload_json,
              receipt.bug_id, receipt.handoff_id, receipt.relay_task_id,
              receipt.handoff_status, receipt.external_revision, receipt.last_event_at,
              receipt.version, integration.metadata_json
       FROM outbox
       JOIN relay_receipts AS receipt
         ON receipt.account_id = outbox.account_id
        AND receipt.project_id = outbox.project_id
        AND receipt.repair_attempt_id = outbox.aggregate_id
        AND receipt.relay_instance_id = outbox.destination
       JOIN integration_links AS integration
         ON integration.account_id = receipt.account_id
        AND integration.project_id = receipt.project_id
        AND integration.id = receipt.integration_link_id
       WHERE outbox.id = ? AND outbox.status = 'claimed'
         AND outbox.lease_owner = ?
         AND (? IS NULL OR outbox.destination = ?)`,
    )
    .get(
      input.outboxMessageId,
      input.leaseOwner,
      input.relayInstanceId ?? null,
      input.relayInstanceId ?? null,
    ) as
    | {
        readonly account_id: string;
        readonly project_id: string;
        readonly aggregate_id: string;
        readonly event_id: string;
        readonly destination: string;
        readonly payload_json: string;
        readonly bug_id: string;
        readonly handoff_id: string;
        readonly relay_task_id: string | null;
        readonly handoff_status: MobileRelayReceipt["handoffStatus"];
        readonly external_revision: number;
        readonly last_event_at: string;
        readonly version: number;
        readonly metadata_json: string;
      }
    | undefined;
  if (!row) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "Relay outbox lease is no longer active");
  }
  const relayTaskId = requireRelayIdentity(input.relayTaskId, "relayTaskId", { required: true });
  const relayTurnId = requireRelayIdentity(input.relayTurnId ?? input.turnId, "relayTurnId");
  const branch =
    input.branch === undefined || input.branch === null
      ? null
      : requireRelayString(input.branch, "branch", 1, 300);
  const threadId =
    input.threadId === undefined || input.threadId === null
      ? null
      : requireRelayString(input.threadId, "threadId", 1, 300);
  const workspace = validateRelayWorkspace(input.workspace, "workspace");
  const requestHash =
    input.requestHash === undefined || input.requestHash === null
      ? null
      : requireRelayString(input.requestHash, "requestHash", 64, 64);
  if (
    row.relay_task_id !== null &&
    row.relay_task_id !== relayTaskId &&
    !["queued", "submitted"].includes(row.handoff_status)
  ) {
    throw new MobileRelayStorageError("INTEGRATION_EVENT_CONFLICT", "Relay task identity changed");
  }
  const acknowledgementAdvancesReceipt = input.externalRevision > row.external_revision;
  if (!acknowledgementAdvancesReceipt && row.relay_task_id !== relayTaskId) {
    throw new MobileRelayStorageError(
      "INTEGRATION_EVENT_CONFLICT",
      "Relay acknowledgement task identity conflicts with the newer webhook projection",
    );
  }
  const at = nextTimestamp(input.receivedAt, row.last_event_at);
  const externalAt = nextTimestamp(input.lastEventAt, row.last_event_at);
  const eventAt = externalAt > at ? externalAt : at;
  const metadata = parseRelayMetadata(row.metadata_json);
  requireRelayWebhookPrincipal(
    database,
    row.account_id,
    metadata.relayPrincipalId ?? MOBILE_FAKE_RELAY_PRINCIPAL_ID,
  );
  const projectedStatus: MobileRelayReceipt["handoffStatus"] =
    row.handoff_status === "fix_delivered" ||
    row.handoff_status === "awaiting_build" ||
    row.handoff_status === "awaiting_verification"
      ? row.handoff_status
      : "submitted";
  let receiptUpdateChanges: number | bigint = 0;
  if (acknowledgementAdvancesReceipt) {
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
                'repair_attempt', ?, ?, 'repair_attempt', ?, ?, ?, ?, ?, NULL,
                NULL, ?, ?)`,
      )
      .run(
        eventId,
        row.account_id,
        row.project_id,
        row.bug_id,
        metadata.relayPrincipalId ?? MOBILE_FAKE_RELAY_PRINCIPAL_ID,
        row.aggregate_id,
        nextRelayAggregateSequence(database, row.account_id, row.project_id, row.aggregate_id),
        row.aggregate_id,
        row.version + 1,
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
    receiptUpdateChanges = database
      .prepare(
        `UPDATE relay_receipts
       SET relay_task_id = ?, handoff_status = ?, external_revision = ?,
           last_event_at = ?, payload_digest = ?, received_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND repair_attempt_id = ?
         AND handoff_id = ? AND version = ? AND external_revision < ?`,
      )
      .run(
        relayTaskId,
        projectedStatus,
        input.externalRevision,
        eventAt,
        input.payloadDigest,
        at,
        row.account_id,
        row.project_id,
        row.aggregate_id,
        row.handoff_id,
        row.version,
        input.externalRevision,
      ).changes;
  }
  let completedOutboxPayload: Record<string, unknown> = {};
  try {
    const decoded = JSON.parse(row.payload_json) as unknown;
    if (isRecord(decoded)) completedOutboxPayload = decoded;
  } catch {
    // Existing rows are JSON-constrained; retaining this guard keeps old data non-fatal.
  }
  const outboxUpdate = database
    .prepare(
      `UPDATE outbox
       SET payload_json = ?, status = 'sent', lease_owner = NULL, lease_expires_at = NULL,
           last_error_code = NULL, sent_at = ?
       WHERE id = ? AND status = 'claimed' AND lease_owner = ?`,
    )
    .run(
      JSON.stringify({
        ...completedOutboxPayload,
        receiptEvidence: {
          turnId: relayTurnId,
          branchName: branch,
          threadId,
          workspace,
          requestHash,
        },
      }),
      at,
      input.outboxMessageId,
      input.leaseOwner,
    );
  if (
    outboxUpdate.changes !== 1 ||
    (acknowledgementAdvancesReceipt && receiptUpdateChanges !== 1)
  ) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Relay receipt was not applied exactly once",
    );
  }
  const receipt = getMobileRelayReceipt(database, {
    accountId: row.account_id,
    projectId: row.project_id,
    actorId: metadata.relayPrincipalId ?? MOBILE_FAKE_RELAY_PRINCIPAL_ID,
    attemptId: row.aggregate_id,
  });
  if (!receipt) throw new MobileRelayStorageError("NOT_FOUND", "Relay receipt disappeared");
  return receipt;
}

export function retryMobileRelayOutbox(
  database: DatabaseSync,
  input: RetryMobileRelayOutboxInput,
): boolean {
  requireTransaction(database);
  const relayInstanceId = input.relayInstanceId;
  if (relayInstanceId !== undefined && !RELAY_INSTANCE_PATTERN.test(relayInstanceId)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "relayInstanceId is invalid");
  }
  const result = database
    .prepare(
      `UPDATE outbox
       SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
           last_error_code = ?, next_attempt_at = ?
       WHERE id = ? AND status = 'claimed' AND lease_owner = ?
         AND (? IS NULL OR destination = ?)`,
    )
    .run(
      input.deadLetter === true ? "dead" : "retry",
      input.errorCode,
      input.nextAttemptAt,
      input.outboxMessageId,
      input.leaseOwner,
      relayInstanceId ?? null,
      relayInstanceId ?? null,
    );
  return result.changes === 1;
}
