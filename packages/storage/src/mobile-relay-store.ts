import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { MobileBugRecord, MobileScopeBootstrap } from "./mobile-bug-store.js";

export const MOBILE_FAKE_RELAY_INSTANCE_ID = "fake-relay-local" as const;
export const MOBILE_FAKE_RELAY_PRINCIPAL_ID = "10000000-0000-4000-8000-000000000007" as const;

const RELAY_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
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

export interface CreateMobileRelayAttemptInput extends MobileRelayScope {
  readonly bugId: string;
  readonly expectedVersion: number;
  readonly assigneeId: string;
  readonly summary: string | null;
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
      throw new MobileRelayStorageError("INVALID_REQUEST", `Relay webhook ${field} has unknown data`);
    }
  }
}

function validateRawRelayWebhook(input: ReceiveMobileRelayWebhookInput): void {
  if (input.eventType !== "turn.delivered") {
    throw new MobileRelayStorageError("INVALID_REQUEST", "Relay webhook event type is unsupported");
  }
  const relayInstanceId = requireRelayString(input.relayInstanceId, "relayInstanceId", 3, 64);
  if (!RELAY_INSTANCE_PATTERN.test(relayInstanceId)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "Relay webhook relayInstanceId is invalid");
  }
  const eventId = requireRelayUuid(input.eventId, "eventId");
  const handoffId = requireRelayUuid(input.handoffId, "handoffId");
  const attemptId = requireRelayUuid(input.attemptId, "attemptId");
  const deliveryId = requireRelayString(input.deliveryId, "deliveryId", 1, 300);
  const externalRevision = requireRelayPositiveInteger(input.externalRevision, "externalRevision");
  const occurredAt = requireRelayTimestamp(input.occurredAt, "occurredAt");
  const receivedAt = requireRelayTimestamp(input.receivedAt, "receivedAt");
  const taskId = requireRelayPositiveInteger(input.taskId, "taskId");
  const turnId = requireRelayPositiveInteger(input.turnId, "turnId");
  const branch = requireRelayString(input.branch, "branch", 1, 300);
  const commitSha = requireRelayString(input.commitSha, "commitSha", 40, 40);
  const remoteSha = requireRelayString(input.remoteSha, "remoteSha", 40, 40);
  if (!COMMIT_PATTERN.test(commitSha) || !COMMIT_PATTERN.test(remoteSha) || commitSha !== remoteSha) {
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
    throw new MobileRelayStorageError("RELAY_DELIVERY_EVIDENCE_INVALID", "Relay merge request URL is invalid");
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
    throw new MobileRelayStorageError("INVALID_REQUEST", "Relay webhook delivery payload is invalid");
  }
  requireRelayKeys(decoded.payload, new Set(["taskId", "turnId", "statusReason", "deliveryEvidence"]), "payload");
  if (
    decoded.payload.taskId !== taskId ||
    decoded.payload.turnId !== turnId
  ) {
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

export function ensureMobileRelayRoles(database: DatabaseSync, scope: MobileScopeBootstrap): void {
  requireTransaction(database);
  for (const role of ["triager", "developer", "release_manager"] as const) {
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
    aggregateSequence: 2,
    resourceType: "bug",
    resourceId: bug.id,
    resourceVersionAfter: bug.version + 1,
    correlationId: randomUUID(),
    fromState: bug.state,
    toState: "ready",
    payload: { status: "ready", fromVersion: bug.version, toVersion: bug.version + 1 },
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
