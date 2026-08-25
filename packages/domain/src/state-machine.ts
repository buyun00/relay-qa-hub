import type {
  ActorType,
  BugState,
  RepairMode,
  RepairStatus,
  Severity,
  VerificationStatus,
} from "./statuses.js";

export const DOMAIN_EVENT_PAYLOAD_MAX_BYTES = 4_096;
export const DOMAIN_EVENT_PAYLOAD_KEYS = Object.freeze([
  "summary",
  "reason",
  "status",
  "relatedBugId",
  "repairAttemptId",
  "buildId",
  "verificationId",
  "attachmentId",
  "captureId",
  "handoffId",
  "commentId",
  "occurrenceId",
  "commitSha",
  "attachmentCount",
  "fromVersion",
  "toVersion",
] as const);

export type DomainEventPayloadKey = (typeof DOMAIN_EVENT_PAYLOAD_KEYS)[number];
export type DomainEventPayload = Readonly<
  Partial<Record<DomainEventPayloadKey, string | number | boolean | null>>
>;

const DOMAIN_EVENT_PAYLOAD_KEY_SET = new Set<string>(DOMAIN_EVENT_PAYLOAD_KEYS);
export const DOMAIN_EVENT_UUID_PAYLOAD_KEYS = Object.freeze([
  "relatedBugId",
  "repairAttemptId",
  "buildId",
  "verificationId",
  "attachmentId",
  "captureId",
  "handoffId",
  "commentId",
  "occurrenceId",
] as const satisfies readonly DomainEventPayloadKey[]);
const DOMAIN_EVENT_UUID_PAYLOAD_KEY_SET = new Set<DomainEventPayloadKey>(
  DOMAIN_EVENT_UUID_PAYLOAD_KEYS,
);
const DOMAIN_EVENT_HUMAN_TEXT_KEYS = new Set<DomainEventPayloadKey>(["summary", "reason"]);
const DOMAIN_EVENT_HUMAN_TEXT_MAX_BYTES = 2_000;

export const DOMAIN_DECISION_ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
  "NOT_FOUND",
  "FORBIDDEN",
  "INTEGRATION_AUTOMATION_FORBIDDEN",
  "INVALID_TRANSITION",
  "ACTIVE_REPAIR_EXISTS",
  "VERSION_CONFLICT",
  "GUARD_FAILED",
  "BUILD_IDENTITY_MISMATCH",
] as const);

export type DomainDecisionErrorCode = (typeof DOMAIN_DECISION_ERROR_CODES)[number];

export class DomainDecisionError extends Error {
  readonly code: DomainDecisionErrorCode;

  constructor(code: DomainDecisionErrorCode, message: string) {
    super(message);
    this.name = "DomainDecisionError";
    this.code = code;
  }
}

export interface BugAggregate {
  id: string;
  projectId: string;
  severity: Severity;
  state: BugState;
  version: number;
  reopenCount: number;
  activeRepairAttemptId: string | null;
  activeVerificationId?: string | null;
  duplicateOfBugId: string | null;
  closedAt?: string | null;
}

export interface RepairAttemptAggregate {
  id: string;
  bugId: string;
  sequence: number;
  mode: RepairMode;
  status: RepairStatus;
  assigneeId: string;
  parentAttemptId: string | null;
  summary: string | null;
  branch: string | null;
  commitSha: string | null;
  mergeRequestUrl: string | null;
  patchUrl: string | null;
  noCodeReason: string | null;
  targetBuildId: string | null;
  version: number;
  failureReason?: string;
  supersedeReason?: string;
}

export interface BuildRequirementAggregate {
  id: string;
  projectId: string;
  bugId: string;
  repairAttemptId: string;
  sourceDeliveryVersion: number;
  deliveredCommitSha: string | null;
  requirement: "required" | "not_required";
  decisionBasis: "code_requires_build" | "no_code_delivery" | "authorized_no_build_exemption";
  decisionReason: string | null;
  decisionActorId: string;
  decisionAuditEventId: string;
  deliveryRequestDigest: string;
  linkedBuildId: string | null;
  linkId: string | null;
  policyVersion: "1.0.0";
  bugVersionAtDelivery: number;
  version: number;
}

export interface BuildAggregate {
  id: string;
  projectId: string;
  provider: string;
  externalId: string;
  status: string;
  branch: string;
  sourceCommitSha: string;
  manifestCommitShas: string[];
  version: number;
}

export interface BuildRepairLink {
  id: string;
  projectId: string;
  bugId: string;
  buildId: string;
  repairAttemptId: string;
  buildRequirementId: string;
  buildRequirementVersion: number;
  deliveredCommitSha: string;
  evidenceType: "manifest" | "release_manager_override";
  evidenceDecision: "manifest_verified" | "release_manager_authorized";
  overrideReason: string | null;
  evidenceActorId: string;
  evidenceAuditEventId: string;
  evidencePolicyVersion: "1.0.0";
  linkedAt: string;
  version: number;
}

export interface VerificationAggregate {
  id: string;
  bugId: string;
  repairAttemptId: string;
  buildId: string | null;
  status: VerificationStatus;
  verifierId: string;
  criteriaSnapshot: string;
  resultSummary: string | null;
  version: number;
  failureReason?: string;
  blockedReason?: string;
}

export interface DuplicateFact {
  id: string;
  projectId: string;
  duplicateOfBugId: string | null;
}

export interface ClosureAcceptanceFact {
  accountId: string;
  projectId: string;
  bugId: string;
  verificationId: string;
  closeEventId: string;
  closeEventType: "verification.result_recorded" | "bug.verification.passed";
  closeEventPosition: number;
  actorUserId: string;
  closedAt: string;
  closureGeneration: number;
  closedBugVersion: number;
  baselineKind: "verified_build" | "unranked_build" | "no_build";
  baselineBuildId: string | null;
  baselineLineageId: string | null;
  baselineOrdinal: number | null;
}

export interface OccurrenceFact {
  id: string;
  accountId: string;
  projectId: string;
  bugId: string;
  appendEventId: string;
  appendEventType: "occurrence.appended";
  appendEventPosition: number;
  buildId: string | null;
  createdAt: string;
}

export interface BuildLineageEntryFact {
  accountId: string;
  projectId: string;
  lineageId: string;
  buildId: string;
  ordinal: number;
  predecessorBuildId: string | null;
  evidenceEventId: string;
  evidenceEventType: "build.lineage_entry_recorded";
  evidenceEventPosition: number;
  policyVersion: "1.0.0";
}

export interface OccurrenceBuildLineageFact {
  accountId: string;
  projectId: string;
  bugId: string;
  occurrenceId: string;
  buildId: string;
  lineageId: string;
  ordinal: number;
  appendEventId: string;
  appendEventPosition: number;
}

export interface DomainSnapshot {
  accountId: string;
  projectId: string;
  bug: BugAggregate;
  repairAttempts: RepairAttemptAggregate[];
  buildRequirements: BuildRequirementAggregate[];
  builds: BuildAggregate[];
  buildLinks?: BuildRepairLink[];
  verifications: VerificationAggregate[];
  duplicateFacts: DuplicateFact[];
  closureAcceptanceFact: ClosureAcceptanceFact | null;
  occurrenceFacts: OccurrenceFact[];
  occurrenceBuildLineageFacts: OccurrenceBuildLineageFact[];
  buildLineageEntries: BuildLineageEntryFact[];
  eventSequence: number;
}

export interface DomainActor {
  type: ActorType;
  id: string;
  roles: string[];
}

export interface DomainProjectPolicy {
  separationRequiredSeverities: Severity[];
  codeDeliveryRequiresBuild: boolean;
  noBuildExemption?: {
    authorized: boolean;
    reason: string;
    policyVersion: "1.0.0";
  };
}

export interface DomainProjectActorFact {
  accountId: string;
  projectId: string;
  userId: string;
  currentActive: boolean;
  assignable: boolean;
  canVerify: boolean;
  authorizedRoles: string[];
}

export interface DomainBuildEvidenceOverrideAuthorityFact {
  accountId: string;
  projectId: string;
  actorId: string;
  canOverrideBuildEvidence: boolean;
  reason: string;
}

export interface DomainResolvedDeliveryEvidence {
  branch: string;
  commitSha: string;
  mergeRequestUrl: string | null;
  patchUrl: string | null;
}

export interface DomainDecisionContext {
  actor: DomainActor;
  now: string;
  eventId: string;
  outboxMessageId: string;
  requestDigest: string;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string | null;
  projectPolicy: DomainProjectPolicy;
  projectActorFacts: readonly DomainProjectActorFact[];
  overrideAuthorityFact?: DomainBuildEvidenceOverrideAuthorityFact;
  resolvedDeliveryEvidence?: DomainResolvedDeliveryEvidence;
}

interface VersionedCommand {
  expectedVersion: number;
}

export interface TransitionBugCommand extends VersionedCommand {
  type: "transitionBug";
  toState: BugState;
  triage?: { requiredFieldsComplete: boolean };
  reason?: string;
  verificationId?: string;
  responsibleUserId?: string;
}

export interface MarkBugDuplicateCommand extends VersionedCommand {
  type: "markBugDuplicate";
  canonicalBugId: string;
  reason: string;
}

export interface ReopenBugCommand extends VersionedCommand {
  type: "reopenBug";
  occurrenceId: string;
}

export interface CreateRepairAttemptCommand extends VersionedCommand {
  type: "createRepairAttempt";
  attemptId: string;
  mode: RepairMode;
  assigneeId: string;
  parentAttemptId: string | null;
  summary: string | null;
}

export interface StartRepairAttemptCommand extends VersionedCommand {
  type: "startRepairAttempt";
  attemptId: string;
}

export interface FailRepairAttemptCommand extends VersionedCommand {
  type: "failRepairAttempt";
  attemptId: string;
  reason: string;
}

interface SupersedeRepairAttemptCommandBase extends VersionedCommand {
  type: "supersedeRepairAttempt";
  attemptId: string;
  reason: string;
}

export interface LegacySupersedeRepairAttemptCommand extends SupersedeRepairAttemptCommandBase {
  representation: "legacy-1.0";
}

export interface VendorSupersedeRepairAttemptCommand extends SupersedeRepairAttemptCommandBase {
  representation: "vendor-1.1";
  successor: {
    id: string;
    mode: RepairMode;
    assigneeId: string;
    summary?: string;
  };
}

export type SupersedeRepairAttemptCommand =
  LegacySupersedeRepairAttemptCommand | VendorSupersedeRepairAttemptCommand;

interface DeliveryCommandBase extends VersionedCommand {
  type: "deliverRepairAttempt";
  attemptId: string;
  summary: string;
  buildRequirementId: string;
}

export interface CodeDeliveryCommand extends DeliveryCommandBase {
  deliveryKind: "code";
  branch?: string;
  commitSha?: string;
  mergeRequestUrl?: string;
  patchUrl?: string;
}

export interface NoCodeDeliveryCommand extends DeliveryCommandBase {
  deliveryKind: "no_code";
  noCodeReason: string;
}

export interface LinkBuildRepairCommand extends VersionedCommand {
  type: "linkBuildRepair";
  buildId: string;
  repairAttemptId: string;
  deliveredCommitSha: string;
  expectedBugVersion: number;
  expectedBuildRequirementVersion: number;
  evidenceType: "manifest" | "release_manager_override";
  overrideReason?: string;
  linkId: string;
}

export interface CreateVerificationCommand extends VersionedCommand {
  type: "createVerification";
  verificationId: string;
  repairAttemptId: string;
  buildId: string | null;
  verifierId: string;
  criteria: string;
}

export interface StartVerificationCommand extends VersionedCommand {
  type: "startVerification";
  verificationId: string;
}

export interface RecordVerificationResultCommand extends VersionedCommand {
  type: "recordVerificationResult";
  verificationId: string;
  status: "passed" | "failed" | "blocked";
  resultSummary: string;
  failureReason?: string;
  blockedReason?: string;
}

export type DomainCommand =
  | TransitionBugCommand
  | MarkBugDuplicateCommand
  | ReopenBugCommand
  | CreateRepairAttemptCommand
  | StartRepairAttemptCommand
  | FailRepairAttemptCommand
  | SupersedeRepairAttemptCommand
  | CodeDeliveryCommand
  | NoCodeDeliveryCommand
  | LinkBuildRepairCommand
  | CreateVerificationCommand
  | StartVerificationCommand
  | RecordVerificationResultCommand;

export interface DomainEventPlan {
  operation: "append";
  schemaVersion: "1.0";
  projectionVersion: "1.1.0";
  redactionPolicyVersion: "1.0.0";
  id: string;
  source: "qa_hub";
  accountId: string;
  projectId: string;
  bugId: string;
  sequence: number;
  type: string;
  aggregateType: "bug" | "repair_attempt" | "build" | "verification";
  aggregateId: string;
  aggregateVersion: number;
  resourceType:
    "bug" | "build" | "repair_attempt" | "build_requirement" | "build_repair_link" | "verification";
  resourceId: string;
  resourceVersionAfter: number;
  actorType: ActorType;
  actorId: string;
  requestDigest: string;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string | null;
  fromState: BugState | null;
  toState: BugState | null;
  occurredAt: string;
  payload: DomainEventPayload;
}

export interface DomainOutboxPlan {
  operation: "append";
  id: string;
  type: "notification.requested";
  aggregateType: "bug";
  aggregateId: string;
  aggregateVersion: number;
  causationEventId: string;
  recipientUserIds: readonly string[];
}

export interface DomainDecision {
  nextSnapshot: DomainSnapshot;
  event: DomainEventPlan;
  outbox: DomainOutboxPlan[];
  closureAcceptanceFactAppend: ClosureAcceptanceFact | null;
}

const EXECUTING_REPAIR_STATUSES = new Set<RepairStatus>([
  "planned",
  "queued",
  "running",
  "needs_input",
  "blocked",
]);

function reject(code: DomainDecisionErrorCode, message: string): never {
  throw new DomainDecisionError(code, message);
}

function cloneSnapshot(snapshot: DomainSnapshot): DomainSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as DomainSnapshot;
}

function requireNonEmpty(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    reject("INVALID_REQUEST", `${field} must be non-empty`);
  }
  return value;
}

function requireRuntimeLiteral(
  value: unknown,
  allowed: readonly string[],
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    reject("INVALID_REQUEST", `${field} is not a supported contract value`);
  }
}

function isSafeIntegerAtLeast(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum;
}

function requireRequestDigest(context: DomainDecisionContext): string {
  if (!/^[0-9a-f]{64}$/.test(context.requestDigest)) {
    reject("INVALID_REQUEST", "requestDigest must be a lowercase SHA-256 digest");
  }
  return context.requestDigest;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RFC3339_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isRfc3339DateTime(value: string): boolean {
  const match = RFC3339_DATE_TIME_PATTERN.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) {
    return false;
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (daysInMonth[month - 1] ?? 0);
}

function validateDecisionContextEnvelope(context: DomainDecisionContext): void {
  if (!UUID_PATTERN.test(context.eventId)) {
    reject("INVALID_REQUEST", "eventId must be a UUID");
  }
  if (!UUID_PATTERN.test(context.outboxMessageId)) {
    reject("INVALID_REQUEST", "outboxMessageId must be a UUID");
  }
  if (!UUID_PATTERN.test(context.correlationId)) {
    reject("INVALID_REQUEST", "correlationId must be a UUID");
  }
  if (context.causationId !== null && !UUID_PATTERN.test(context.causationId)) {
    reject("INVALID_REQUEST", "causationId must be null or a UUID");
  }
  if (!isRfc3339DateTime(context.now)) {
    reject("INVALID_REQUEST", "now must be an RFC 3339 date-time");
  }
  if (
    context.idempotencyKey !== null &&
    (typeof context.idempotencyKey !== "string" ||
      context.idempotencyKey.length < 1 ||
      context.idempotencyKey.length > 200)
  ) {
    reject("INVALID_REQUEST", "idempotencyKey must be null or between 1 and 200 characters");
  }
}

function requireRole(context: DomainDecisionContext, role: string): void {
  if (!context.actor.roles.includes(role)) {
    reject("FORBIDDEN", `actor lacks ${role} authority`);
  }
}

function requireAnyRole(context: DomainDecisionContext, roles: readonly string[]): void {
  if (!roles.some((role) => context.actor.roles.includes(role))) {
    reject("FORBIDDEN", `actor lacks ${roles.join(" or ")} authority`);
  }
}

function requireCurrentProjectActor(
  snapshot: DomainSnapshot,
  context: DomainDecisionContext,
  userId: string,
): DomainProjectActorFact {
  const facts = context.projectActorFacts.filter(
    (candidate) =>
      candidate.accountId === snapshot.accountId &&
      candidate.projectId === snapshot.projectId &&
      candidate.userId === userId,
  );
  if (facts.length !== 1 || facts[0]?.currentActive !== true) {
    reject(
      "GUARD_FAILED",
      "referenced user must be one current active member in the resolved account and project",
    );
  }
  return facts[0];
}

function requireScopedActorRoles(
  snapshot: DomainSnapshot,
  context: DomainDecisionContext,
): DomainProjectActorFact {
  const fact = requireCurrentProjectActor(snapshot, context, context.actor.id);
  if (context.actor.roles.some((role) => !fact.authorizedRoles.includes(role))) {
    reject(
      "FORBIDDEN",
      "actor roles must be server-resolved from the current account and project membership",
    );
  }
  return fact;
}

function requireProjectActorCapability(
  snapshot: DomainSnapshot,
  context: DomainDecisionContext,
  userId: string,
  capability: "assignable" | "canVerify",
): DomainProjectActorFact {
  const fact = requireCurrentProjectActor(snapshot, context, userId);
  const requiredRole = capability === "assignable" ? "developer" : "verifier";
  if (
    fact[capability] !== true ||
    !Array.isArray(fact.authorizedRoles) ||
    !fact.authorizedRoles.includes(requiredRole)
  ) {
    reject(
      "GUARD_FAILED",
      `${capability === "assignable" ? "assignee" : "verifier"} lacks current ${capability} authority`,
    );
  }
  return fact;
}

function requiresSeparationOfDuties(
  snapshot: DomainSnapshot,
  context: DomainDecisionContext,
): boolean {
  return (
    snapshot.bug.severity === "S0" ||
    snapshot.bug.severity === "S1" ||
    context.projectPolicy.separationRequiredSeverities.includes(snapshot.bug.severity)
  );
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const symbol of value) {
    const codePoint = symbol.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  const suffix = "…";
  const contentBudget = Math.max(0, maxBytes - utf8ByteLength(suffix));
  let result = "";
  let bytes = 0;
  for (const symbol of value) {
    const symbolBytes = utf8ByteLength(symbol);
    if (bytes + symbolBytes > contentBudget) break;
    result += symbol;
    bytes += symbolBytes;
  }
  return `${result}${suffix}`;
}

function redactEventHumanText(value: string): string {
  const scanValue = value
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase();
  const containsCredential =
    scanValue.includes("\\") ||
    [
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]/u,
      /\bbearer\s+[a-z0-9._~+/=-]{4,}/u,
      /\b(?:password|passwd|pwd|secret|credential|private[ _-]?key|client[ _-]?secret|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|token)\s*[:=]\s*\S+/u,
      /https?:\/\/[^/\s:@]+:[^/\s@]+@/u,
      /\beyj[a-z0-9_-]{8,}\.[a-z0-9_-]+\.[a-z0-9_-]+/u,
    ].some((pattern) => pattern.test(scanValue));
  return containsCredential ? "[REDACTED]" : value;
}

function boundEventPayload(payload: DomainEventPayload): DomainEventPayload {
  for (let textBudget = DOMAIN_EVENT_HUMAN_TEXT_MAX_BYTES; textBudget >= 128; textBudget -= 128) {
    const bounded: Partial<Record<DomainEventPayloadKey, string | number | boolean | null>> = {};
    for (const [rawKey, rawValue] of Object.entries(payload)) {
      const key = rawKey as DomainEventPayloadKey;
      if (rawValue === null || rawValue === undefined) {
        continue;
      }
      bounded[key] =
        typeof rawValue === "string" && DOMAIN_EVENT_HUMAN_TEXT_KEYS.has(key)
          ? truncateUtf8(redactEventHumanText(rawValue), textBudget)
          : rawValue;
    }
    if (utf8ByteLength(JSON.stringify(bounded)) <= DOMAIN_EVENT_PAYLOAD_MAX_BYTES) {
      return bounded;
    }
  }
  reject("INVALID_REQUEST", "typed Event facts exceed the frozen 4 KiB durable limit");
}

function validateEventPayload(payload: DomainEventPayload): void {
  for (const [key, value] of Object.entries(payload)) {
    if (
      !DOMAIN_EVENT_PAYLOAD_KEY_SET.has(key) ||
      value === null ||
      !["string", "number", "boolean"].includes(typeof value)
    ) {
      reject("INVALID_REQUEST", "Event payload violates the frozen flat primitive key policy");
    }
  }
  for (const key of DOMAIN_EVENT_HUMAN_TEXT_KEYS) {
    const value = payload[key];
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length < 1 || value.length > 2_000)
    ) {
      reject("INVALID_REQUEST", `${key} violates the frozen audit text limit`);
    }
  }
  const status = payload.status;
  if (
    status !== undefined &&
    (typeof status !== "string" || status.length > 100 || !/^[a-z][a-z0-9_]*$/.test(status))
  ) {
    reject("INVALID_REQUEST", "status violates the frozen lower-snake audit value policy");
  }
  for (const key of DOMAIN_EVENT_UUID_PAYLOAD_KEY_SET) {
    const value = payload[key];
    if (value !== undefined && (typeof value !== "string" || !UUID_PATTERN.test(value))) {
      reject("INVALID_REQUEST", `${key} must be a UUID in the frozen audit payload`);
    }
  }
  if (
    payload.commitSha !== undefined &&
    (typeof payload.commitSha !== "string" || !/^[0-9a-f]{40}$/.test(payload.commitSha))
  ) {
    reject("INVALID_REQUEST", "commitSha must be one lowercase 40-character SHA-1 value");
  }
  if (
    payload.attachmentCount !== undefined &&
    (typeof payload.attachmentCount !== "number" ||
      !Number.isInteger(payload.attachmentCount) ||
      payload.attachmentCount < 0 ||
      payload.attachmentCount > 20)
  ) {
    reject("INVALID_REQUEST", "attachmentCount violates the frozen audit bound");
  }
  for (const key of ["fromVersion", "toVersion"] as const) {
    const value = payload[key];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    ) {
      reject("INVALID_REQUEST", `${key} must be a positive integer`);
    }
  }
  if (utf8ByteLength(JSON.stringify(payload)) > DOMAIN_EVENT_PAYLOAD_MAX_BYTES) {
    reject("INVALID_REQUEST", "Event payload exceeds the frozen 4 KiB durable limit");
  }
}

function requireHuman(context: DomainDecisionContext): void {
  if (context.actor.type !== "user") {
    reject(
      "INTEGRATION_AUTOMATION_FORBIDDEN",
      "App-first workflow decisions are human-owned; integrations project receipts only",
    );
  }
}

function requireExactVersion(actual: number, expected: number): void {
  if (actual !== expected) {
    reject("VERSION_CONFLICT", `expected version ${expected}, observed ${actual}`);
  }
}

function activeAttempts(snapshot: DomainSnapshot): RepairAttemptAggregate[] {
  return snapshot.repairAttempts.filter(
    (attempt) =>
      EXECUTING_REPAIR_STATUSES.has(attempt.status) ||
      (attempt.status === "delivered" && snapshot.bug.activeRepairAttemptId === attempt.id),
  );
}

function validateSnapshot(snapshot: DomainSnapshot): void {
  if (snapshot.bug.projectId !== snapshot.projectId) {
    reject("NOT_FOUND", "Bug is outside the resolved project");
  }
  if ((snapshot.bug.state === "duplicate") !== (snapshot.bug.duplicateOfBugId !== null)) {
    reject("GUARD_FAILED", "duplicate Bug state and canonical Bug identity must agree");
  }
  if (
    !isSafeIntegerAtLeast(snapshot.bug.version, 1) ||
    !isSafeIntegerAtLeast(snapshot.bug.reopenCount, 0) ||
    !isSafeIntegerAtLeast(snapshot.eventSequence, 0)
  ) {
    reject("GUARD_FAILED", "Bug and Event versions must be safe persisted integers");
  }
  const attemptIds = new Set<string>();
  const attemptSequences = new Set<number>();
  for (const attempt of snapshot.repairAttempts) {
    if (
      attempt.bugId !== snapshot.bug.id ||
      attemptIds.has(attempt.id) ||
      !isSafeIntegerAtLeast(attempt.sequence, 1) ||
      attemptSequences.has(attempt.sequence) ||
      !isSafeIntegerAtLeast(attempt.version, 1)
    ) {
      reject("GUARD_FAILED", "RepairAttempt identities and sequences must be unique in one Bug");
    }
    attemptIds.add(attempt.id);
    attemptSequences.add(attempt.sequence);
  }
  const persistedPositiveIntegers = [
    ...snapshot.buildRequirements.flatMap((requirement) => [
      requirement.sourceDeliveryVersion,
      requirement.bugVersionAtDelivery,
      requirement.version,
    ]),
    ...snapshot.builds.map((build) => build.version),
    ...(snapshot.buildLinks ?? []).flatMap((link) => [link.buildRequirementVersion, link.version]),
    ...snapshot.verifications.map((verification) => verification.version),
    ...snapshot.occurrenceFacts.map((occurrence) => occurrence.appendEventPosition),
    ...snapshot.buildLineageEntries.flatMap((entry) => [
      entry.ordinal,
      entry.evidenceEventPosition,
    ]),
    ...snapshot.occurrenceBuildLineageFacts.flatMap((fact) => [
      fact.ordinal,
      fact.appendEventPosition,
    ]),
  ];
  if (persistedPositiveIntegers.some((value) => !isSafeIntegerAtLeast(value, 1))) {
    reject("GUARD_FAILED", "persisted versions, ordinals, and positions must be safe integers");
  }
  if (
    snapshot.closureAcceptanceFact !== null &&
    (!isSafeIntegerAtLeast(snapshot.closureAcceptanceFact.closureGeneration, 0) ||
      !isSafeIntegerAtLeast(snapshot.closureAcceptanceFact.closedBugVersion, 1) ||
      !isSafeIntegerAtLeast(snapshot.closureAcceptanceFact.closeEventPosition, 1) ||
      (snapshot.closureAcceptanceFact.baselineOrdinal !== null &&
        !isSafeIntegerAtLeast(snapshot.closureAcceptanceFact.baselineOrdinal, 1)))
  ) {
    reject("GUARD_FAILED", "closure acceptance versions and positions must be safe integers");
  }
  const attemptsById = new Map(
    snapshot.repairAttempts.map((attempt) => [attempt.id, attempt] as const),
  );
  for (const attempt of snapshot.repairAttempts) {
    const visited = new Set<string>();
    let child = attempt;
    while (child.parentAttemptId !== null) {
      if (visited.has(child.id)) {
        reject("GUARD_FAILED", "RepairAttempt parent history must be acyclic");
      }
      visited.add(child.id);
      const parent = attemptsById.get(child.parentAttemptId);
      if (
        parent === undefined ||
        parent.bugId !== snapshot.bug.id ||
        parent.sequence >= child.sequence
      ) {
        reject(
          "GUARD_FAILED",
          "RepairAttempt parent history must be complete and strictly sequence-ordered",
        );
      }
      child = parent;
    }
  }
  const active = activeAttempts(snapshot);
  if (active.length > 1) {
    reject("ACTIVE_REPAIR_EXISTS", "snapshot contains multiple active RepairAttempts");
  }
  if (snapshot.bug.activeRepairAttemptId !== null) {
    if (active.length !== 1 || active[0]?.id !== snapshot.bug.activeRepairAttemptId) {
      reject("GUARD_FAILED", "active RepairAttempt pointer is inconsistent");
    }
    const pointed = snapshot.repairAttempts.find(
      (attempt) => attempt.id === snapshot.bug.activeRepairAttemptId,
    );
    const highestSequence = snapshot.repairAttempts.reduce(
      (highest, attempt) => Math.max(highest, attempt.sequence),
      0,
    );
    if (pointed === undefined || pointed.sequence !== highestSequence) {
      reject("GUARD_FAILED", "the active RepairAttempt must have the highest Bug sequence");
    }
  } else if (active.length !== 0) {
    reject("GUARD_FAILED", "an active RepairAttempt is missing from the Bug pointer");
  }

  const pointedAttempt =
    snapshot.bug.activeRepairAttemptId === null
      ? undefined
      : snapshot.repairAttempts.find(
          (attempt) => attempt.id === snapshot.bug.activeRepairAttemptId,
        );
  if (snapshot.bug.state === "in_progress") {
    if (pointedAttempt === undefined || !EXECUTING_REPAIR_STATUSES.has(pointedAttempt.status)) {
      reject("GUARD_FAILED", "in_progress Bug must point to one executing RepairAttempt");
    }
  } else if (
    snapshot.bug.state === "awaiting_build" ||
    snapshot.bug.state === "ready_for_verification"
  ) {
    if (pointedAttempt?.status !== "delivered") {
      reject("GUARD_FAILED", "build and verification states must point to delivered work");
    }
  } else if (pointedAttempt !== undefined) {
    reject("GUARD_FAILED", "non-work Bug states cannot retain an active RepairAttempt pointer");
  }

  const hasClosedAt = typeof snapshot.bug.closedAt === "string";
  if ((snapshot.bug.state === "closed") !== hasClosedAt) {
    reject("GUARD_FAILED", "only a closed Bug may carry one closedAt fact");
  }

  const activeVerifications = snapshot.verifications.filter(
    (verification) => verification.status === "requested" || verification.status === "in_progress",
  );
  if (activeVerifications.length > 1) {
    reject("GUARD_FAILED", "snapshot contains multiple active Verifications");
  }
  const activeVerificationId = snapshot.bug.activeVerificationId ?? null;
  if (activeVerificationId === null) {
    if (activeVerifications.length !== 0) {
      reject("GUARD_FAILED", "an active Verification is missing from the Bug pointer");
    }
  } else {
    const pointed = snapshot.verifications.find(
      (verification) => verification.id === activeVerificationId,
    );
    if (
      pointed === undefined ||
      pointed.bugId !== snapshot.bug.id ||
      (pointed.status !== "requested" &&
        pointed.status !== "in_progress" &&
        pointed.status !== "passed") ||
      (activeVerifications.length === 1 && activeVerifications[0]?.id !== pointed.id)
    ) {
      reject("GUARD_FAILED", "active Verification pointer is inconsistent");
    }
    if (
      snapshot.bug.state !== "ready_for_verification" ||
      pointedAttempt?.status !== "delivered" ||
      pointed.repairAttemptId !== pointedAttempt.id
    ) {
      reject(
        "GUARD_FAILED",
        "active Verification must bind the delivered Attempt of a ready_for_verification Bug",
      );
    }
  }
}

function findAttempt(snapshot: DomainSnapshot, attemptId: string): RepairAttemptAggregate {
  const attempt = snapshot.repairAttempts.find((candidate) => candidate.id === attemptId);
  if (attempt === undefined || attempt.bugId !== snapshot.bug.id) {
    reject("NOT_FOUND", "RepairAttempt was not found in the resolved Bug");
  }
  return attempt;
}

function findVerification(snapshot: DomainSnapshot, verificationId: string): VerificationAggregate {
  const verification = snapshot.verifications.find((candidate) => candidate.id === verificationId);
  if (verification === undefined || verification.bugId !== snapshot.bug.id) {
    reject("NOT_FOUND", "Verification was not found in the resolved Bug");
  }
  return verification;
}

function findSingleBuildRequirement(
  snapshot: DomainSnapshot,
  repairAttemptId: string,
): BuildRequirementAggregate {
  const requirements = snapshot.buildRequirements.filter(
    (candidate) => candidate.repairAttemptId === repairAttemptId,
  );
  const requirement = requirements[0];
  if (requirements.length !== 1 || requirement === undefined) {
    reject(
      "BUILD_IDENTITY_MISMATCH",
      "the RepairAttempt must resolve exactly one frozen BuildRequirement",
    );
  }
  return requirement;
}

function validateRepairParentChain(
  snapshot: DomainSnapshot,
  newAttemptId: string,
  parentAttemptId: string | null,
): void {
  if (parentAttemptId === null) return;
  const attemptsById = new Map(
    snapshot.repairAttempts.map((attempt) => [attempt.id, attempt] as const),
  );
  if (attemptsById.size !== snapshot.repairAttempts.length) {
    reject("GUARD_FAILED", "RepairAttempt identities must be unique within the Bug snapshot");
  }
  const visited = new Set<string>([newAttemptId]);
  const parent = attemptsById.get(parentAttemptId);
  const highestSequence = snapshot.repairAttempts.reduce(
    (highest, attempt) => Math.max(highest, attempt.sequence),
    0,
  );
  if (
    parent === undefined ||
    parent.sequence !== highestSequence ||
    EXECUTING_REPAIR_STATUSES.has(parent.status) ||
    snapshot.repairAttempts.some((attempt) => attempt.parentAttemptId === parent.id)
  ) {
    reject(
      "GUARD_FAILED",
      "RepairAttempt parent must be the latest terminal history leaf and accept exactly one child",
    );
  }
  let currentId: string | null = parentAttemptId;
  while (currentId !== null) {
    if (visited.has(currentId)) {
      reject("GUARD_FAILED", "RepairAttempt parent relation would create or inherit a cycle");
    }
    visited.add(currentId);
    const current = attemptsById.get(currentId);
    if (current === undefined || current.bugId !== snapshot.bug.id) {
      reject("GUARD_FAILED", "RepairAttempt parent chain must be complete inside the same Bug");
    }
    currentId = current.parentAttemptId;
  }
}

function captureClosureAcceptanceFact(
  snapshot: DomainSnapshot,
  next: DomainSnapshot,
  verification: VerificationAggregate,
  context: DomainDecisionContext,
  closeEventType: ClosureAcceptanceFact["closeEventType"],
): void {
  const rankedEntries =
    verification.buildId === null
      ? []
      : snapshot.buildLineageEntries.filter(
          (entry) =>
            entry.accountId === snapshot.accountId &&
            entry.projectId === snapshot.projectId &&
            entry.buildId === verification.buildId &&
            entry.evidenceEventType === "build.lineage_entry_recorded" &&
            entry.policyVersion === "1.0.0" &&
            UUID_PATTERN.test(entry.evidenceEventId) &&
            isSafeIntegerAtLeast(entry.ordinal, 1) &&
            isSafeIntegerAtLeast(entry.evidenceEventPosition, 1),
        );
  const rankedEntry = rankedEntries.length === 1 ? rankedEntries[0] : undefined;
  next.closureAcceptanceFact = {
    accountId: next.accountId,
    projectId: next.projectId,
    bugId: next.bug.id,
    verificationId: verification.id,
    closeEventId: context.eventId,
    closeEventType,
    closeEventPosition: snapshot.eventSequence + 1,
    actorUserId: context.actor.id,
    closedAt: context.now,
    closureGeneration: next.bug.reopenCount,
    closedBugVersion: next.bug.version,
    baselineKind:
      verification.buildId === null
        ? "no_build"
        : rankedEntry === undefined
          ? "unranked_build"
          : "verified_build",
    baselineBuildId: verification.buildId,
    baselineLineageId: rankedEntry?.lineageId ?? null,
    baselineOrdinal: rankedEntry?.ordinal ?? null,
  };
}

function makeDecision(
  nextSnapshot: DomainSnapshot,
  context: DomainDecisionContext,
  event: Omit<
    DomainEventPlan,
    | "operation"
    | "schemaVersion"
    | "projectionVersion"
    | "redactionPolicyVersion"
    | "id"
    | "source"
    | "accountId"
    | "projectId"
    | "bugId"
    | "sequence"
    | "actorType"
    | "actorId"
    | "requestDigest"
    | "correlationId"
    | "causationId"
    | "idempotencyKey"
    | "occurredAt"
    | "payload"
    | "resourceType"
    | "resourceId"
    | "resourceVersionAfter"
  > & { payload?: DomainEventPlan["payload"] },
  recipientUserIds: readonly string[] = [],
  eventResource?: Pick<DomainEventPlan, "resourceType" | "resourceId" | "resourceVersionAfter">,
): DomainDecision {
  const sequence = nextSnapshot.eventSequence + 1;
  nextSnapshot.eventSequence = sequence;
  const payload = boundEventPayload({ ...(event.payload ?? {}) });
  validateEventPayload(payload);
  const plannedEvent: DomainEventPlan = {
    operation: "append",
    schemaVersion: "1.0",
    projectionVersion: "1.1.0",
    redactionPolicyVersion: "1.0.0",
    id: context.eventId,
    source: "qa_hub",
    accountId: nextSnapshot.accountId,
    projectId: nextSnapshot.projectId,
    bugId: nextSnapshot.bug.id,
    sequence,
    type: event.type,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion,
    resourceType: eventResource?.resourceType ?? event.aggregateType,
    resourceId: eventResource?.resourceId ?? event.aggregateId,
    resourceVersionAfter: eventResource?.resourceVersionAfter ?? event.aggregateVersion,
    actorType: context.actor.type,
    actorId: context.actor.id,
    requestDigest: context.requestDigest,
    correlationId: context.correlationId,
    causationId: context.causationId,
    idempotencyKey: context.idempotencyKey,
    fromState: event.fromState,
    toState: event.toState,
    occurredAt: context.now,
    payload,
  };
  return {
    nextSnapshot,
    event: plannedEvent,
    outbox: [
      {
        operation: "append",
        id: context.outboxMessageId,
        type: "notification.requested",
        aggregateType: "bug",
        aggregateId: nextSnapshot.bug.id,
        aggregateVersion: nextSnapshot.bug.version,
        causationEventId: plannedEvent.id,
        recipientUserIds: [...new Set(recipientUserIds)],
      },
    ],
    closureAcceptanceFactAppend:
      nextSnapshot.closureAcceptanceFact?.closeEventId === context.eventId
        ? { ...nextSnapshot.closureAcceptanceFact }
        : null,
  };
}

function decideTransitionBug(
  snapshot: DomainSnapshot,
  command: TransitionBugCommand,
  context: DomainDecisionContext,
): DomainDecision {
  requireExactVersion(snapshot.bug.version, command.expectedVersion);
  const fromState = snapshot.bug.state;
  let recipientUserIds: readonly string[] = [];

  if (command.toState === "closed") {
    requireRole(context, "verifier");
    requireProjectActorCapability(snapshot, context, context.actor.id, "canVerify");
    const verificationId = requireNonEmpty(command.verificationId, "verificationId");
    const verification = findVerification(snapshot, verificationId);
    if (
      fromState !== "ready_for_verification" ||
      verification.status !== "passed" ||
      snapshot.bug.activeVerificationId !== verification.id ||
      verification.repairAttemptId !== snapshot.bug.activeRepairAttemptId
    ) {
      reject("GUARD_FAILED", "closure requires the active passed Verification");
    }
    if (context.actor.id !== verification.verifierId) {
      reject("FORBIDDEN", "only the assigned verifier can close the Bug");
    }
    const attempt = findAttempt(snapshot, verification.repairAttemptId);
    if (
      attempt.status !== "delivered" ||
      attempt.id !== snapshot.bug.activeRepairAttemptId ||
      (requiresSeparationOfDuties(snapshot, context) &&
        attempt.assigneeId === verification.verifierId)
    ) {
      reject("GUARD_FAILED", "closure no longer binds a separated delivered Attempt");
    }
    assertVerificationBuildEligibility(snapshot, attempt, verification.buildId);
    const next = cloneSnapshot(snapshot);
    next.bug.state = "closed";
    next.bug.version += 1;
    next.bug.activeRepairAttemptId = null;
    next.bug.activeVerificationId = null;
    next.bug.closedAt = context.now;
    captureClosureAcceptanceFact(snapshot, next, verification, context, "bug.verification.passed");
    return makeDecision(next, context, {
      type: "bug.verification.passed",
      aggregateType: "bug",
      aggregateId: next.bug.id,
      aggregateVersion: next.bug.version,
      fromState,
      toState: next.bug.state,
      payload: {
        status: "passed",
        verificationId: verification.id,
        repairAttemptId: attempt.id,
        buildId: verification.buildId,
        fromVersion: snapshot.bug.version,
        toVersion: next.bug.version,
      },
    });
  }

  requireRole(context, "triager");
  let eventType: string;
  if (command.toState === "ready" && (fromState === "reported" || fromState === "needs_info")) {
    if (command.triage?.requiredFieldsComplete !== true) {
      reject("GUARD_FAILED", "triage fields are incomplete");
    }
    eventType = "bug.triage.ready";
  } else if (
    command.toState === "needs_info" &&
    (fromState === "reported" || fromState === "ready")
  ) {
    requireNonEmpty(command.reason, "reason");
    const responsibleUserId = requireNonEmpty(command.responsibleUserId, "responsibleUserId");
    requireCurrentProjectActor(snapshot, context, responsibleUserId);
    recipientUserIds = [responsibleUserId];
    eventType = "bug.triage.needs_info";
  } else if (
    (command.toState === "deferred" || command.toState === "rejected") &&
    (fromState === "reported" || fromState === "needs_info" || fromState === "ready")
  ) {
    requireNonEmpty(command.reason, "reason");
    eventType = command.toState === "deferred" ? "bug.defer" : "bug.reject";
  } else {
    reject("INVALID_TRANSITION", `Bug cannot transition from ${fromState} to ${command.toState}`);
  }

  const next = cloneSnapshot(snapshot);
  next.bug.state = command.toState;
  next.bug.version += 1;
  return makeDecision(
    next,
    context,
    {
      type: eventType,
      aggregateType: "bug",
      aggregateId: next.bug.id,
      aggregateVersion: next.bug.version,
      fromState,
      toState: next.bug.state,
      payload: {
        status: next.bug.state,
        reason: command.reason ?? null,
        fromVersion: snapshot.bug.version,
        toVersion: next.bug.version,
      },
    },
    recipientUserIds,
  );
}

function decideMarkDuplicate(
  snapshot: DomainSnapshot,
  command: MarkBugDuplicateCommand,
  context: DomainDecisionContext,
): DomainDecision {
  requireRole(context, "triager");
  requireExactVersion(snapshot.bug.version, command.expectedVersion);
  requireNonEmpty(command.reason, "reason");
  if (snapshot.bug.state !== "reported" && snapshot.bug.state !== "ready") {
    reject("INVALID_TRANSITION", "only reported or ready Bugs can be marked duplicate");
  }
  if (command.canonicalBugId === snapshot.bug.id) {
    reject("GUARD_FAILED", "a Bug cannot duplicate itself");
  }
  const facts = new Map(snapshot.duplicateFacts.map((fact) => [fact.id, fact]));
  const canonical = facts.get(command.canonicalBugId);
  if (canonical === undefined || canonical.projectId !== snapshot.projectId) {
    reject("GUARD_FAILED", "canonical Bug must exist in the same project");
  }
  const visited = new Set<string>();
  let current: DuplicateFact | undefined = canonical;
  while (current !== undefined) {
    if (current.projectId !== snapshot.projectId) {
      reject("GUARD_FAILED", "the canonical duplicate chain leaves the resolved project");
    }
    if (current.id === snapshot.bug.id || current.duplicateOfBugId === snapshot.bug.id) {
      reject("GUARD_FAILED", "duplicate relation would create a cycle");
    }
    if (visited.has(current.id)) {
      reject("GUARD_FAILED", "canonical chain already contains a cycle");
    }
    visited.add(current.id);
    if (current.duplicateOfBugId === null) {
      current = undefined;
    } else {
      const nextFact = facts.get(current.duplicateOfBugId);
      if (nextFact === undefined) {
        reject("GUARD_FAILED", "the complete canonical duplicate chain is required");
      }
      current = nextFact;
    }
  }

  const next = cloneSnapshot(snapshot);
  const fromState = next.bug.state;
  next.bug.state = "duplicate";
  next.bug.duplicateOfBugId = command.canonicalBugId;
  next.bug.version += 1;
  return makeDecision(next, context, {
    type: "bug.mark_duplicate",
    aggregateType: "bug",
    aggregateId: next.bug.id,
    aggregateVersion: next.bug.version,
    fromState,
    toState: next.bug.state,
    payload: {
      status: "duplicate",
      relatedBugId: command.canonicalBugId,
      reason: command.reason ?? null,
      fromVersion: snapshot.bug.version,
      toVersion: next.bug.version,
    },
  });
}

function hasCompleteServerBuildLineage(
  snapshot: DomainSnapshot,
  verification: VerificationAggregate,
  closure: ClosureAcceptanceFact,
  occurrence: OccurrenceFact,
): boolean {
  if (
    closure.baselineKind !== "verified_build" ||
    closure.baselineBuildId === null ||
    closure.baselineLineageId === null ||
    closure.baselineOrdinal === null ||
    verification.buildId !== closure.baselineBuildId ||
    occurrence.buildId === null ||
    !UUID_PATTERN.test(closure.baselineLineageId) ||
    !Number.isSafeInteger(closure.baselineOrdinal) ||
    closure.baselineOrdinal < 1
  ) {
    return false;
  }

  const occurrenceFacts = snapshot.occurrenceBuildLineageFacts.filter(
    (candidate) => candidate.occurrenceId === occurrence.id,
  );
  const occurrenceLineage = occurrenceFacts[0];
  if (
    occurrenceFacts.length !== 1 ||
    occurrenceLineage === undefined ||
    occurrenceLineage.accountId !== snapshot.accountId ||
    occurrenceLineage.projectId !== snapshot.projectId ||
    occurrenceLineage.bugId !== snapshot.bug.id ||
    occurrenceLineage.buildId !== occurrence.buildId ||
    occurrenceLineage.lineageId !== closure.baselineLineageId ||
    !Number.isSafeInteger(occurrenceLineage.ordinal) ||
    occurrenceLineage.ordinal <= closure.baselineOrdinal ||
    occurrenceLineage.appendEventId !== occurrence.appendEventId ||
    occurrenceLineage.appendEventPosition !== occurrence.appendEventPosition
  ) {
    return false;
  }

  const baselineBuild = snapshot.builds.find(
    (candidate) => candidate.id === closure.baselineBuildId,
  );
  const occurrenceBuild = snapshot.builds.find(
    (candidate) => candidate.id === occurrenceLineage.buildId,
  );
  if (
    baselineBuild?.projectId !== snapshot.projectId ||
    baselineBuild.status !== "ready" ||
    occurrenceBuild?.projectId !== snapshot.projectId ||
    occurrenceBuild.status !== "ready"
  ) {
    return false;
  }

  const relevantEntries = snapshot.buildLineageEntries.filter(
    (entry) =>
      entry.accountId === snapshot.accountId &&
      entry.projectId === snapshot.projectId &&
      entry.lineageId === closure.baselineLineageId,
  );
  const entriesByOrdinal = new Map<number, BuildLineageEntryFact>();
  const rankedBuildIds = new Set<string>();
  for (const entry of relevantEntries) {
    if (
      !Number.isSafeInteger(entry.ordinal) ||
      entry.ordinal < 1 ||
      entriesByOrdinal.has(entry.ordinal) ||
      rankedBuildIds.has(entry.buildId) ||
      !UUID_PATTERN.test(entry.evidenceEventId) ||
      entry.evidenceEventType !== "build.lineage_entry_recorded" ||
      !Number.isSafeInteger(entry.evidenceEventPosition) ||
      entry.evidenceEventPosition < 1 ||
      entry.policyVersion !== "1.0.0"
    ) {
      return false;
    }
    entriesByOrdinal.set(entry.ordinal, entry);
    rankedBuildIds.add(entry.buildId);
  }

  const baselineEntry = entriesByOrdinal.get(closure.baselineOrdinal);
  if (baselineEntry?.buildId !== closure.baselineBuildId) {
    return false;
  }
  let predecessorBuildId = baselineEntry.buildId;
  for (
    let ordinal = closure.baselineOrdinal + 1;
    ordinal <= occurrenceLineage.ordinal;
    ordinal += 1
  ) {
    const entry = entriesByOrdinal.get(ordinal);
    if (entry === undefined || entry.predecessorBuildId !== predecessorBuildId) {
      return false;
    }
    predecessorBuildId = entry.buildId;
  }
  return predecessorBuildId === occurrenceLineage.buildId;
}

function decideReopen(
  snapshot: DomainSnapshot,
  command: ReopenBugCommand,
  context: DomainDecisionContext,
): DomainDecision {
  requireRole(context, "triager");
  requireExactVersion(snapshot.bug.version, command.expectedVersion);
  if (snapshot.bug.state !== "closed") {
    reject("INVALID_TRANSITION", "only a closed Bug can reopen");
  }
  const closure = snapshot.closureAcceptanceFact;
  const occurrenceMatches = snapshot.occurrenceFacts.filter(
    (candidate) => candidate.id === command.occurrenceId,
  );
  const occurrence = occurrenceMatches[0];
  const verification =
    closure === null
      ? undefined
      : snapshot.verifications.find((candidate) => candidate.id === closure.verificationId);
  if (
    closure === null ||
    occurrenceMatches.length !== 1 ||
    occurrence === undefined ||
    snapshot.bug.closedAt === null ||
    snapshot.bug.closedAt === undefined ||
    closure.accountId !== snapshot.accountId ||
    closure.projectId !== snapshot.projectId ||
    closure.bugId !== snapshot.bug.id ||
    closure.closedAt !== snapshot.bug.closedAt ||
    closure.closureGeneration !== snapshot.bug.reopenCount ||
    !Number.isSafeInteger(closure.closedBugVersion) ||
    closure.closedBugVersion < 1 ||
    closure.closedBugVersion > snapshot.bug.version ||
    (closure.closeEventType !== "verification.result_recorded" &&
      closure.closeEventType !== "bug.verification.passed") ||
    !UUID_PATTERN.test(closure.closeEventId) ||
    !Number.isSafeInteger(closure.closeEventPosition) ||
    closure.closeEventPosition < 1 ||
    !isRfc3339DateTime(closure.closedAt) ||
    verification === undefined ||
    verification.bugId !== snapshot.bug.id ||
    verification.status !== "passed" ||
    verification.verifierId !== closure.actorUserId ||
    occurrence.accountId !== snapshot.accountId ||
    occurrence.projectId !== snapshot.projectId ||
    occurrence.bugId !== snapshot.bug.id ||
    occurrence.appendEventType !== "occurrence.appended" ||
    !UUID_PATTERN.test(occurrence.appendEventId) ||
    !Number.isSafeInteger(occurrence.appendEventPosition) ||
    occurrence.appendEventPosition <= closure.closeEventPosition ||
    !isRfc3339DateTime(occurrence.createdAt) ||
    Date.parse(occurrence.createdAt) <= Date.parse(closure.closedAt) ||
    !hasCompleteServerBuildLineage(snapshot, verification, closure, occurrence)
  ) {
    reject(
      "GUARD_FAILED",
      "reopen requires one later same-scope persisted occurrence after the current human closure",
    );
  }
  const next = cloneSnapshot(snapshot);
  next.bug.state = "ready";
  next.bug.version += 1;
  next.bug.reopenCount += 1;
  next.bug.closedAt = null;
  return makeDecision(next, context, {
    type: "bug.reopen.newer_occurrence",
    aggregateType: "bug",
    aggregateId: next.bug.id,
    aggregateVersion: next.bug.version,
    fromState: "closed",
    toState: "ready",
    payload: {
      status: "ready",
      occurrenceId: occurrence.id,
      fromVersion: snapshot.bug.version,
      toVersion: next.bug.version,
    },
  });
}

function decideCreateAttempt(
  snapshot: DomainSnapshot,
  command: CreateRepairAttemptCommand,
  context: DomainDecisionContext,
): DomainDecision {
  requireAnyRole(context, ["developer", "triager"]);
  requireRuntimeLiteral(command.mode, ["human", "relay", "external"], "mode");
  requireExactVersion(snapshot.bug.version, command.expectedVersion);
  if (activeAttempts(snapshot).length !== 0) {
    reject("ACTIVE_REPAIR_EXISTS", "only one RepairAttempt can be active");
  }
  if (snapshot.bug.state !== "ready") {
    reject("INVALID_TRANSITION", "a RepairAttempt can start only from ready");
  }
  if (snapshot.repairAttempts.some((attempt) => attempt.id === command.attemptId)) {
    reject("GUARD_FAILED", "RepairAttempt identity is already used");
  }
  const latestAttempt = snapshot.repairAttempts.reduce<RepairAttemptAggregate | null>(
    (latest, attempt) => (latest === null || attempt.sequence > latest.sequence ? attempt : latest),
    null,
  );
  if (
    latestAttempt?.status === "superseded" &&
    !snapshot.repairAttempts.some((attempt) => attempt.parentAttemptId === latestAttempt.id) &&
    command.parentAttemptId !== latestAttempt.id
  ) {
    reject(
      "GUARD_FAILED",
      "the first successor after a legacy supersede must inherit the superseded Attempt",
    );
  }
  validateRepairParentChain(snapshot, command.attemptId, command.parentAttemptId);
  requireProjectActorCapability(snapshot, context, command.assigneeId, "assignable");
  const next = cloneSnapshot(snapshot);
  const sequence =
    next.repairAttempts.reduce((max, attempt) => Math.max(max, attempt.sequence), 0) + 1;
  next.repairAttempts.push({
    id: command.attemptId,
    bugId: next.bug.id,
    sequence,
    mode: command.mode,
    status: "planned",
    assigneeId: command.assigneeId,
    parentAttemptId: command.parentAttemptId,
    summary: command.summary,
    branch: null,
    commitSha: null,
    mergeRequestUrl: null,
    patchUrl: null,
    noCodeReason: null,
    targetBuildId: null,
    version: 1,
  });
  next.bug.state = "in_progress";
  next.bug.activeRepairAttemptId = command.attemptId;
  next.bug.version += 1;
  const createdAttempt = findAttempt(next, command.attemptId);
  return makeDecision(next, context, {
    type: "repair_attempt.created",
    aggregateType: "repair_attempt",
    aggregateId: createdAttempt.id,
    aggregateVersion: createdAttempt.version,
    fromState: "ready",
    toState: "in_progress",
    payload: {
      status: "planned",
      repairAttemptId: command.attemptId,
      summary: command.summary,
      fromVersion: snapshot.bug.version,
      toVersion: next.bug.version,
    },
  });
}

function decideStartAttempt(
  snapshot: DomainSnapshot,
  command: StartRepairAttemptCommand,
  context: DomainDecisionContext,
): DomainDecision {
  requireRole(context, "developer");
  const attempt = findAttempt(snapshot, command.attemptId);
  requireExactVersion(attempt.version, command.expectedVersion);
  if (
    attempt.status !== "planned" ||
    snapshot.bug.state !== "in_progress" ||
    snapshot.bug.activeRepairAttemptId !== attempt.id
  ) {
    reject("INVALID_TRANSITION", "only the active planned RepairAttempt can start");
  }
  const next = cloneSnapshot(snapshot);
  const mutable = findAttempt(next, attempt.id);
  mutable.status = "running";
  mutable.version += 1;
  return makeDecision(next, context, {
    type: "repair_attempt.started",
    aggregateType: "repair_attempt",
    aggregateId: mutable.id,
    aggregateVersion: mutable.version,
    fromState: null,
    toState: null,
    payload: {
      status: "running",
      repairAttemptId: mutable.id,
      fromVersion: attempt.version,
      toVersion: mutable.version,
    },
  });
}

function decideFailAttempt(
  snapshot: DomainSnapshot,
  command: FailRepairAttemptCommand,
  context: DomainDecisionContext,
): DomainDecision {
  requireRole(context, "developer");
  const failureReason = requireNonEmpty(command.reason, "reason");
  if ([...failureReason].length > 5_000) {
    reject("INVALID_REQUEST", "reason exceeds the frozen 5000-character limit");
  }
  const attempt = findAttempt(snapshot, command.attemptId);
  requireExactVersion(attempt.version, command.expectedVersion);
  if (
    !EXECUTING_REPAIR_STATUSES.has(attempt.status) ||
    snapshot.bug.activeRepairAttemptId !== attempt.id ||
    snapshot.bug.state !== "in_progress"
  ) {
    reject("INVALID_TRANSITION", "RepairAttempt cannot fail from its current state");
  }
  const next = cloneSnapshot(snapshot);
  const mutable = findAttempt(next, attempt.id);
  mutable.status = "failed";
  mutable.failureReason = failureReason;
  mutable.version += 1;
  next.bug.state = "ready";
  next.bug.activeRepairAttemptId = null;
  next.bug.version += 1;
  return makeDecision(next, context, {
    type: "repair_attempt.failed",
    aggregateType: "repair_attempt",
    aggregateId: mutable.id,
    aggregateVersion: mutable.version,
    fromState: "in_progress",
    toState: "ready",
    payload: {
      status: mutable.status,
      repairAttemptId: mutable.id,
      reason: failureReason,
      fromVersion: attempt.version,
      toVersion: mutable.version,
    },
  });
}

function decideSupersedeAttempt(
  snapshot: DomainSnapshot,
  command: SupersedeRepairAttemptCommand,
  context: DomainDecisionContext,
): DomainDecision {
  requireRole(context, "developer");
  requireNonEmpty(command.reason, "reason");
  requireRuntimeLiteral(command.representation, ["legacy-1.0", "vendor-1.1"], "representation");
  const attempt = findAttempt(snapshot, command.attemptId);
  requireExactVersion(attempt.version, command.expectedVersion);
  if (
    !EXECUTING_REPAIR_STATUSES.has(attempt.status) ||
    snapshot.bug.activeRepairAttemptId !== attempt.id ||
    snapshot.bug.state !== "in_progress"
  ) {
    reject("INVALID_TRANSITION", "RepairAttempt cannot be superseded from its current state");
  }
  const next = cloneSnapshot(snapshot);
  const mutable = findAttempt(next, attempt.id);
  mutable.status = "superseded";
  mutable.supersedeReason = command.reason;
  mutable.version += 1;
  if (command.representation === "legacy-1.0") {
    next.bug.state = "ready";
    next.bug.activeRepairAttemptId = null;
    next.bug.version += 1;
    return makeDecision(next, context, {
      type: "repair_attempt.superseded",
      aggregateType: "repair_attempt",
      aggregateId: mutable.id,
      aggregateVersion: mutable.version,
      fromState: "in_progress",
      toState: "ready",
      payload: {
        status: mutable.status,
        repairAttemptId: mutable.id,
        reason: command.reason,
        fromVersion: attempt.version,
        toVersion: mutable.version,
      },
    });
  }
  requireRuntimeLiteral(command.successor.mode, ["human", "relay", "external"], "successor.mode");
  if (
    command.successor.id === attempt.id ||
    snapshot.repairAttempts.some((candidate) => candidate.id === command.successor.id)
  ) {
    reject("GUARD_FAILED", "successor RepairAttempt identity must be new");
  }
  requireProjectActorCapability(snapshot, context, command.successor.assigneeId, "assignable");
  const sequence =
    next.repairAttempts.reduce((max, candidate) => Math.max(max, candidate.sequence), 0) + 1;
  next.repairAttempts.push({
    id: command.successor.id,
    bugId: next.bug.id,
    sequence,
    mode: command.successor.mode,
    status: "planned",
    assigneeId: command.successor.assigneeId,
    parentAttemptId: attempt.id,
    summary: command.successor.summary ?? null,
    branch: null,
    commitSha: null,
    mergeRequestUrl: null,
    patchUrl: null,
    noCodeReason: null,
    targetBuildId: null,
    version: 1,
  });
  next.bug.activeRepairAttemptId = command.successor.id;
  next.bug.version += 1;
  return makeDecision(next, context, {
    type: "repair_attempt.superseded",
    aggregateType: "repair_attempt",
    aggregateId: mutable.id,
    aggregateVersion: mutable.version,
    fromState: null,
    toState: null,
    payload: {
      status: mutable.status,
      repairAttemptId: mutable.id,
      reason: command.reason,
      fromVersion: attempt.version,
      toVersion: mutable.version,
    },
  });
}

function decideDeliverAttempt(
  snapshot: DomainSnapshot,
  command: CodeDeliveryCommand | NoCodeDeliveryCommand,
  context: DomainDecisionContext,
): DomainDecision {
  requireRole(context, "developer");
  requireRuntimeLiteral(command.deliveryKind, ["code", "no_code"], "deliveryKind");
  requireNonEmpty(command.summary, "summary");
  const attempt = findAttempt(snapshot, command.attemptId);
  requireExactVersion(attempt.version, command.expectedVersion);
  if (
    attempt.status !== "running" ||
    snapshot.bug.state !== "in_progress" ||
    snapshot.bug.activeRepairAttemptId !== attempt.id
  ) {
    reject("INVALID_TRANSITION", "only the active running RepairAttempt can be delivered");
  }
  if (
    snapshot.buildRequirements.some(
      (requirement) =>
        requirement.id === command.buildRequirementId || requirement.repairAttemptId === attempt.id,
    )
  ) {
    reject("GUARD_FAILED", "BuildRequirement is immutable and already exists");
  }

  let deliveredCommitSha: string | null;
  let deliveredBranch: string | null;
  let deliveredMergeRequestUrl: string | null;
  let deliveredPatchUrl: string | null;
  let deliveredNoCodeReason: string | null;
  let requirement: "required" | "not_required";
  let decisionBasis: BuildRequirementAggregate["decisionBasis"];
  let decisionReason: string | null;
  if (command.deliveryKind === "no_code") {
    requireNonEmpty(command.noCodeReason, "noCodeReason");
    const untrusted = command as NoCodeDeliveryCommand & {
      branch?: unknown;
      commitSha?: unknown;
      mergeRequestUrl?: unknown;
      patchUrl?: unknown;
    };
    if (
      untrusted.branch !== undefined ||
      untrusted.commitSha !== undefined ||
      untrusted.mergeRequestUrl !== undefined ||
      untrusted.patchUrl !== undefined
    ) {
      reject("INVALID_REQUEST", "no_code delivery cannot include code evidence");
    }
    deliveredCommitSha = null;
    deliveredBranch = null;
    deliveredMergeRequestUrl = null;
    deliveredPatchUrl = null;
    deliveredNoCodeReason = command.noCodeReason;
    requirement = "not_required";
    decisionBasis = "no_code_delivery";
    decisionReason = command.noCodeReason;
  } else {
    const directEvidence =
      typeof command.branch === "string" && typeof command.commitSha === "string";
    const referencedEvidence =
      typeof command.mergeRequestUrl === "string" || typeof command.patchUrl === "string";
    if (!directEvidence && !referencedEvidence) {
      reject("INVALID_REQUEST", "code delivery requires commit or resolvable MR/patch evidence");
    }
    const resolved =
      context.resolvedDeliveryEvidence ??
      (directEvidence && !referencedEvidence
        ? {
            branch: command.branch as string,
            commitSha: command.commitSha as string,
            mergeRequestUrl: null,
            patchUrl: null,
          }
        : undefined);
    if (
      resolved === undefined ||
      requireNonEmpty(resolved.branch, "resolvedDeliveryEvidence.branch") !== resolved.branch ||
      !/^[0-9a-f]{40}$/.test(resolved.commitSha) ||
      (command.branch !== undefined && command.branch !== resolved.branch) ||
      (command.commitSha !== undefined && command.commitSha !== resolved.commitSha) ||
      (command.mergeRequestUrl ?? null) !== resolved.mergeRequestUrl ||
      (command.patchUrl ?? null) !== resolved.patchUrl
    ) {
      reject("GUARD_FAILED", "code delivery evidence did not resolve to one exact commit");
    }
    for (const [field, value] of [
      ["mergeRequestUrl", resolved.mergeRequestUrl],
      ["patchUrl", resolved.patchUrl],
    ] as const) {
      if (value !== null && !/^[a-z][a-z0-9+.-]*:\S+$/iu.test(value)) {
        reject("INVALID_REQUEST", `${field} must be an absolute URI`);
      }
    }
    if (!/^[0-9a-f]{40}$/.test(resolved.commitSha)) {
      reject("INVALID_REQUEST", "commitSha must be a lowercase full SHA-1");
    }
    deliveredCommitSha = resolved.commitSha;
    deliveredBranch = resolved.branch;
    deliveredMergeRequestUrl = resolved.mergeRequestUrl;
    deliveredPatchUrl = resolved.patchUrl;
    deliveredNoCodeReason = null;
    const exemption = context.projectPolicy.noBuildExemption;
    if (exemption !== undefined) {
      if (exemption.authorized !== true) {
        reject("GUARD_FAILED", "the no-Build exemption was not authorized");
      }
      if (exemption.policyVersion !== "1.0.0") {
        reject("GUARD_FAILED", "the no-Build exemption policy version is unsupported");
      }
      requireRole(context, "release_manager");
      decisionReason = requireNonEmpty(exemption.reason, "noBuildExemption.reason");
      requirement = "not_required";
      decisionBasis = "authorized_no_build_exemption";
    } else {
      if (context.projectPolicy.codeDeliveryRequiresBuild !== true) {
        reject("GUARD_FAILED", "code delivery needs an explicit audited no-Build decision");
      }
      requirement = "required";
      decisionBasis = "code_requires_build";
      decisionReason = null;
    }
  }

  const next = cloneSnapshot(snapshot);
  const mutable = findAttempt(next, attempt.id);
  mutable.status = "delivered";
  mutable.summary = command.summary;
  mutable.branch = deliveredBranch;
  mutable.commitSha = deliveredCommitSha;
  mutable.mergeRequestUrl = deliveredMergeRequestUrl;
  mutable.patchUrl = deliveredPatchUrl;
  mutable.noCodeReason = deliveredNoCodeReason;
  mutable.targetBuildId = null;
  mutable.version += 1;
  next.bug.state = requirement === "required" ? "awaiting_build" : "ready_for_verification";
  next.bug.version += 1;
  next.buildRequirements.push({
    id: command.buildRequirementId,
    projectId: next.projectId,
    bugId: next.bug.id,
    repairAttemptId: mutable.id,
    sourceDeliveryVersion: mutable.version,
    deliveredCommitSha,
    requirement,
    decisionBasis,
    decisionReason,
    decisionActorId: context.actor.id,
    decisionAuditEventId: context.eventId,
    deliveryRequestDigest: context.requestDigest,
    linkedBuildId: null,
    linkId: null,
    policyVersion: "1.0.0",
    bugVersionAtDelivery: next.bug.version,
    version: 1,
  });
  return makeDecision(
    next,
    context,
    {
      type: "repair_attempt.delivered",
      aggregateType: "repair_attempt",
      aggregateId: mutable.id,
      aggregateVersion: mutable.version,
      fromState: "in_progress",
      toState: next.bug.state,
      payload: {
        status: "delivered",
        summary: command.summary,
        repairAttemptId: mutable.id,
        commitSha: deliveredCommitSha,
        reason: decisionReason,
        fromVersion: attempt.version,
        toVersion: mutable.version,
      },
    },
    [],
    {
      resourceType: "build_requirement",
      resourceId: command.buildRequirementId,
      resourceVersionAfter: 1,
    },
  );
}

function decideLinkBuild(
  snapshot: DomainSnapshot,
  command: LinkBuildRepairCommand,
  context: DomainDecisionContext,
): DomainDecision {
  requireRole(context, "release_manager");
  requireRuntimeLiteral(
    command.evidenceType,
    ["manifest", "release_manager_override"],
    "evidenceType",
  );
  const attempt = findAttempt(snapshot, command.repairAttemptId);
  const build = snapshot.builds.find((candidate) => candidate.id === command.buildId);
  const requirement = findSingleBuildRequirement(snapshot, command.repairAttemptId);
  if (build === undefined) {
    reject("BUILD_IDENTITY_MISMATCH", "Build was not found");
  }
  requireExactVersion(build.version, command.expectedVersion);
  requireExactVersion(snapshot.bug.version, command.expectedBugVersion);
  requireExactVersion(requirement.version, command.expectedBuildRequirementVersion);
  if (
    snapshot.bug.state !== "awaiting_build" ||
    snapshot.bug.activeRepairAttemptId !== attempt.id ||
    attempt.status !== "delivered" ||
    requirement.requirement !== "required" ||
    requirement.projectId !== snapshot.projectId ||
    requirement.bugId !== snapshot.bug.id ||
    requirement.repairAttemptId !== attempt.id ||
    requirement.sourceDeliveryVersion !== attempt.version ||
    requirement.decisionBasis !== "code_requires_build" ||
    requirement.decisionReason !== null ||
    requirement.decisionActorId.trim().length === 0 ||
    requirement.decisionAuditEventId.trim().length === 0 ||
    !/^[0-9a-f]{64}$/.test(requirement.deliveryRequestDigest) ||
    requirement.policyVersion !== "1.0.0" ||
    requirement.version !== 1 ||
    requirement.linkedBuildId !== null ||
    requirement.linkId !== null ||
    requirement.bugVersionAtDelivery !== snapshot.bug.version ||
    requirement.deliveredCommitSha !== command.deliveredCommitSha ||
    attempt.commitSha !== command.deliveredCommitSha ||
    attempt.branch === null ||
    build.projectId !== snapshot.projectId ||
    build.status !== "ready"
  ) {
    reject("BUILD_IDENTITY_MISMATCH", "Build identity does not match the frozen delivery");
  }
  if (command.evidenceType === "manifest") {
    if (command.overrideReason !== undefined) {
      reject("INVALID_REQUEST", "manifest evidence cannot include overrideReason");
    }
    if (!build.manifestCommitShas.includes(command.deliveredCommitSha)) {
      reject("BUILD_IDENTITY_MISMATCH", "Build manifest does not contain the delivered commit");
    }
  } else {
    const overrideReason = requireNonEmpty(command.overrideReason, "overrideReason");
    const authority = context.overrideAuthorityFact;
    if (
      authority === undefined ||
      authority.accountId !== snapshot.accountId ||
      authority.projectId !== snapshot.projectId ||
      authority.actorId !== context.actor.id ||
      authority.canOverrideBuildEvidence !== true ||
      authority.reason !== overrideReason
    ) {
      reject("FORBIDDEN", "Build evidence override requires exact current operation authority");
    }
  }
  if ((snapshot.buildLinks ?? []).some((link) => link.id === command.linkId)) {
    reject("GUARD_FAILED", "Build link identity is already used");
  }

  const next = cloneSnapshot(snapshot);
  const mutableBuild = next.builds.find((candidate) => candidate.id === build.id);
  const mutableRequirement = next.buildRequirements.find(
    (candidate) => candidate.id === requirement.id,
  );
  if (mutableBuild === undefined || mutableRequirement === undefined) {
    reject("NOT_FOUND", "resolved Build relation disappeared from the snapshot");
  }
  mutableBuild.version += 1;
  mutableRequirement.linkedBuildId = mutableBuild.id;
  mutableRequirement.linkId = command.linkId;
  mutableRequirement.version += 1;
  next.buildLinks ??= [];
  const link: BuildRepairLink = {
    id: command.linkId,
    projectId: next.projectId,
    bugId: next.bug.id,
    buildId: mutableBuild.id,
    repairAttemptId: attempt.id,
    buildRequirementId: mutableRequirement.id,
    buildRequirementVersion: mutableRequirement.version,
    deliveredCommitSha: command.deliveredCommitSha,
    evidenceType: command.evidenceType,
    evidenceDecision:
      command.evidenceType === "manifest" ? "manifest_verified" : "release_manager_authorized",
    overrideReason:
      command.evidenceType === "manifest"
        ? null
        : requireNonEmpty(command.overrideReason, "overrideReason"),
    evidenceActorId: context.actor.id,
    evidenceAuditEventId: context.eventId,
    evidencePolicyVersion: "1.0.0",
    linkedAt: context.now,
    version: 1,
  };
  next.buildLinks.push(link);
  next.bug.state = "ready_for_verification";
  next.bug.version += 1;
  return makeDecision(
    next,
    context,
    {
      type: "build.repair_linked",
      aggregateType: "repair_attempt",
      aggregateId: attempt.id,
      aggregateVersion: attempt.version,
      fromState: "awaiting_build",
      toState: "ready_for_verification",
      payload: {
        status: "ready_for_verification",
        buildId: mutableBuild.id,
        repairAttemptId: attempt.id,
        commitSha: command.deliveredCommitSha,
        reason: link.overrideReason,
        fromVersion: build.version,
        toVersion: mutableBuild.version,
      },
    },
    [],
    {
      resourceType: "build_repair_link",
      resourceId: link.id,
      resourceVersionAfter: link.version,
    },
  );
}

function assertVerificationBuildEligibility(
  snapshot: DomainSnapshot,
  attempt: RepairAttemptAggregate,
  buildId: string | null,
): void {
  const latestDelivered = snapshot.repairAttempts
    .filter((candidate) => candidate.status === "delivered")
    .reduce<RepairAttemptAggregate | undefined>(
      (latest, candidate) =>
        latest === undefined || candidate.sequence > latest.sequence ? candidate : latest,
      undefined,
    );
  if (latestDelivered?.id !== attempt.id) {
    reject("GUARD_FAILED", "Verification must bind the highest-sequence eligible delivery");
  }
  const requirement = findSingleBuildRequirement(snapshot, attempt.id);
  if (
    requirement.projectId !== snapshot.projectId ||
    requirement.bugId !== snapshot.bug.id ||
    !Number.isSafeInteger(requirement.bugVersionAtDelivery) ||
    requirement.bugVersionAtDelivery < 1 ||
    requirement.bugVersionAtDelivery > snapshot.bug.version ||
    requirement.sourceDeliveryVersion !== attempt.version ||
    requirement.repairAttemptId !== attempt.id ||
    requirement.decisionActorId.trim().length === 0 ||
    requirement.decisionAuditEventId.trim().length === 0 ||
    !/^[0-9a-f]{64}$/.test(requirement.deliveryRequestDigest) ||
    requirement.policyVersion !== "1.0.0"
  ) {
    reject("BUILD_IDENTITY_MISMATCH", "BuildRequirement identity or decision audit is invalid");
  }
  if (requirement.requirement === "not_required") {
    if (
      requirement.version !== 1 ||
      requirement.linkedBuildId !== null ||
      requirement.linkId !== null ||
      buildId !== null ||
      (requirement.decisionBasis === "no_code_delivery" &&
        (requirement.deliveredCommitSha !== null ||
          attempt.commitSha !== null ||
          attempt.branch !== null ||
          requirement.decisionReason === null ||
          requirement.decisionReason.trim().length === 0)) ||
      (requirement.decisionBasis === "authorized_no_build_exemption" &&
        (requirement.deliveredCommitSha === null ||
          requirement.deliveredCommitSha !== attempt.commitSha ||
          attempt.branch === null ||
          requirement.decisionReason === null ||
          requirement.decisionReason.trim().length === 0)) ||
      (requirement.decisionBasis !== "no_code_delivery" &&
        requirement.decisionBasis !== "authorized_no_build_exemption")
    ) {
      reject("BUILD_IDENTITY_MISMATCH", "no-Build verification relation is inconsistent");
    }
    return;
  }
  if (
    requirement.version !== 2 ||
    requirement.linkedBuildId === null ||
    requirement.linkId === null ||
    buildId !== requirement.linkedBuildId
  ) {
    reject("BUILD_IDENTITY_MISMATCH", "required Build is not linked to the frozen requirement");
  }
  const build = snapshot.builds.find((candidate) => candidate.id === buildId);
  const link = (snapshot.buildLinks ?? []).find((candidate) => candidate.id === requirement.linkId);
  if (
    build === undefined ||
    link === undefined ||
    link.version !== 1 ||
    build.projectId !== snapshot.projectId ||
    build.status !== "ready" ||
    link.projectId !== snapshot.projectId ||
    link.bugId !== snapshot.bug.id ||
    link.repairAttemptId !== attempt.id ||
    link.buildRequirementId !== requirement.id ||
    link.buildRequirementVersion !== requirement.version ||
    link.buildId !== build.id ||
    link.deliveredCommitSha !== requirement.deliveredCommitSha
  ) {
    reject("BUILD_IDENTITY_MISMATCH", "committed Build link is inconsistent");
  }
  if (
    requirement.decisionBasis !== "code_requires_build" ||
    requirement.deliveredCommitSha === null ||
    requirement.deliveredCommitSha !== attempt.commitSha ||
    attempt.branch === null ||
    link.evidenceActorId.trim().length === 0 ||
    link.evidenceAuditEventId.trim().length === 0 ||
    link.evidencePolicyVersion !== "1.0.0" ||
    link.linkedAt.trim().length === 0
  ) {
    reject("BUILD_IDENTITY_MISMATCH", "required Build decision or typed audit is invalid");
  }
  if (link.evidenceType === "manifest") {
    if (
      link.evidenceDecision !== "manifest_verified" ||
      link.overrideReason !== null ||
      !build.manifestCommitShas.includes(requirement.deliveredCommitSha)
    ) {
      reject("BUILD_IDENTITY_MISMATCH", "linked Build manifest evidence is invalid");
    }
  } else if (
    link.evidenceDecision !== "release_manager_authorized" ||
    link.overrideReason === null ||
    link.overrideReason.trim().length === 0
  ) {
    reject("BUILD_IDENTITY_MISMATCH", "release-manager override evidence is invalid");
  }
}

function decideCreateVerification(
  snapshot: DomainSnapshot,
  command: CreateVerificationCommand,
  context: DomainDecisionContext,
): DomainDecision {
  requireRole(context, "verifier");
  requireProjectActorCapability(snapshot, context, context.actor.id, "canVerify");
  requireExactVersion(snapshot.bug.version, command.expectedVersion);
  requireNonEmpty(command.criteria, "criteria");
  if (
    snapshot.bug.state !== "ready_for_verification" ||
    snapshot.bug.activeVerificationId !== null ||
    snapshot.verifications.some((verification) => verification.id === command.verificationId)
  ) {
    reject("INVALID_TRANSITION", "Verification cannot be created from the current state");
  }
  const attempt = findAttempt(snapshot, command.repairAttemptId);
  if (
    attempt.status !== "delivered" ||
    snapshot.bug.activeRepairAttemptId !== attempt.id ||
    activeAttempts(snapshot)[0]?.id !== attempt.id
  ) {
    reject("GUARD_FAILED", "Verification must bind the latest delivered active Attempt");
  }
  if (requiresSeparationOfDuties(snapshot, context) && attempt.assigneeId === command.verifierId) {
    reject("GUARD_FAILED", "repairer and verifier must be separated");
  }
  requireProjectActorCapability(snapshot, context, command.verifierId, "canVerify");
  assertVerificationBuildEligibility(snapshot, attempt, command.buildId);

  const next = cloneSnapshot(snapshot);
  next.verifications.push({
    id: command.verificationId,
    bugId: next.bug.id,
    repairAttemptId: attempt.id,
    buildId: command.buildId,
    status: "requested",
    verifierId: command.verifierId,
    criteriaSnapshot: command.criteria,
    resultSummary: null,
    version: 1,
  });
  next.bug.activeVerificationId = command.verificationId;
  next.bug.version += 1;
  return makeDecision(next, context, {
    type: "verification.created",
    aggregateType: "verification",
    aggregateId: command.verificationId,
    aggregateVersion: 1,
    fromState: null,
    toState: null,
    payload: {
      status: "requested",
      verificationId: command.verificationId,
      repairAttemptId: attempt.id,
      buildId: command.buildId,
      toVersion: 1,
    },
  });
}

function decideStartVerification(
  snapshot: DomainSnapshot,
  command: StartVerificationCommand,
  context: DomainDecisionContext,
): DomainDecision {
  requireRole(context, "verifier");
  requireProjectActorCapability(snapshot, context, context.actor.id, "canVerify");
  const verification = findVerification(snapshot, command.verificationId);
  requireExactVersion(verification.version, command.expectedVersion);
  if (context.actor.id !== verification.verifierId) {
    reject("FORBIDDEN", "only the assigned verifier can start Verification");
  }
  if (
    verification.status !== "requested" ||
    snapshot.bug.state !== "ready_for_verification" ||
    snapshot.bug.activeVerificationId !== verification.id
  ) {
    reject("INVALID_TRANSITION", "only the active requested Verification can start");
  }
  const next = cloneSnapshot(snapshot);
  const mutable = findVerification(next, verification.id);
  mutable.status = "in_progress";
  mutable.version += 1;
  return makeDecision(next, context, {
    type: "verification.started",
    aggregateType: "verification",
    aggregateId: mutable.id,
    aggregateVersion: mutable.version,
    fromState: null,
    toState: null,
    payload: {
      status: "in_progress",
      verificationId: mutable.id,
      repairAttemptId: mutable.repairAttemptId,
      buildId: mutable.buildId,
      fromVersion: verification.version,
      toVersion: mutable.version,
    },
  });
}

function decideVerificationResult(
  snapshot: DomainSnapshot,
  command: RecordVerificationResultCommand,
  context: DomainDecisionContext,
): DomainDecision {
  requireRole(context, "verifier");
  requireRuntimeLiteral(command.status, ["passed", "failed", "blocked"], "status");
  requireProjectActorCapability(snapshot, context, context.actor.id, "canVerify");
  requireNonEmpty(command.resultSummary, "resultSummary");
  const verification = findVerification(snapshot, command.verificationId);
  requireExactVersion(verification.version, command.expectedVersion);
  if (
    verification.status !== "in_progress" ||
    snapshot.bug.state !== "ready_for_verification" ||
    snapshot.bug.activeVerificationId !== verification.id
  ) {
    reject("INVALID_TRANSITION", "only the active in-progress Verification accepts a result");
  }
  if (context.actor.id !== verification.verifierId) {
    reject("FORBIDDEN", "only the assigned verifier can record a result");
  }
  const attempt = findAttempt(snapshot, verification.repairAttemptId);
  if (
    attempt.status !== "delivered" ||
    snapshot.bug.activeRepairAttemptId !== attempt.id ||
    (requiresSeparationOfDuties(snapshot, context) &&
      attempt.assigneeId === verification.verifierId)
  ) {
    reject("GUARD_FAILED", "Verification no longer binds an eligible delivered Attempt");
  }
  assertVerificationBuildEligibility(snapshot, attempt, verification.buildId);
  if (command.status === "failed") {
    requireNonEmpty(command.failureReason, "failureReason");
    if (command.blockedReason !== undefined) {
      reject("INVALID_REQUEST", "failed result cannot include blockedReason");
    }
  } else if (command.status === "blocked") {
    requireNonEmpty(command.blockedReason, "blockedReason");
    if (command.failureReason !== undefined) {
      reject("INVALID_REQUEST", "blocked result cannot include failureReason");
    }
  } else if (command.failureReason !== undefined || command.blockedReason !== undefined) {
    reject("INVALID_REQUEST", "passed result cannot include failure or blocked reasons");
  }

  const next = cloneSnapshot(snapshot);
  const mutableVerification = findVerification(next, verification.id);
  mutableVerification.status = command.status;
  mutableVerification.resultSummary = command.resultSummary;
  mutableVerification.version += 1;
  if (command.status === "failed") {
    mutableVerification.failureReason = requireNonEmpty(command.failureReason, "failureReason");
  } else if (command.status === "blocked") {
    mutableVerification.blockedReason = requireNonEmpty(command.blockedReason, "blockedReason");
  }
  const mutableAttempt = findAttempt(next, attempt.id);
  if (command.status === "passed") {
    next.bug.state = "closed";
    next.bug.activeRepairAttemptId = null;
    next.bug.closedAt = context.now;
  } else if (command.status === "failed") {
    mutableAttempt.status = "verification_failed";
    mutableAttempt.version += 1;
    next.bug.state = "ready";
    next.bug.activeRepairAttemptId = null;
  }
  next.bug.activeVerificationId = null;
  next.bug.version += 1;
  if (command.status === "passed") {
    captureClosureAcceptanceFact(
      snapshot,
      next,
      mutableVerification,
      context,
      "verification.result_recorded",
    );
  }
  return makeDecision(next, context, {
    type: "verification.result_recorded",
    aggregateType: "verification",
    aggregateId: mutableVerification.id,
    aggregateVersion: mutableVerification.version,
    fromState: snapshot.bug.state,
    toState: next.bug.state,
    payload: {
      status: mutableVerification.status,
      summary: command.resultSummary,
      reason: command.failureReason ?? command.blockedReason ?? null,
      verificationId: mutableVerification.id,
      repairAttemptId: mutableVerification.repairAttemptId,
      buildId: mutableVerification.buildId,
      fromVersion: verification.version,
      toVersion: mutableVerification.version,
    },
  });
}

/**
 * Decide an App-first 1.1 workflow command without I/O, clocks, random IDs, or
 * persistence. The returned aggregate snapshot, Event append, and Outbox
 * append are one atomic intent for the application/storage executor.
 */
export function decideDomainCommand(
  snapshot: DomainSnapshot,
  command: DomainCommand,
  context: DomainDecisionContext,
): DomainDecision {
  validateSnapshot(snapshot);
  requireHuman(context);
  requireRequestDigest(context);
  validateDecisionContextEnvelope(context);
  requireScopedActorRoles(snapshot, context);
  switch (command.type) {
    case "transitionBug":
      return decideTransitionBug(snapshot, command, context);
    case "markBugDuplicate":
      return decideMarkDuplicate(snapshot, command, context);
    case "reopenBug":
      return decideReopen(snapshot, command, context);
    case "createRepairAttempt":
      return decideCreateAttempt(snapshot, command, context);
    case "startRepairAttempt":
      return decideStartAttempt(snapshot, command, context);
    case "failRepairAttempt":
      return decideFailAttempt(snapshot, command, context);
    case "supersedeRepairAttempt":
      return decideSupersedeAttempt(snapshot, command, context);
    case "deliverRepairAttempt":
      return decideDeliverAttempt(snapshot, command, context);
    case "linkBuildRepair":
      return decideLinkBuild(snapshot, command, context);
    case "createVerification":
      return decideCreateVerification(snapshot, command, context);
    case "startVerification":
      return decideStartVerification(snapshot, command, context);
    case "recordVerificationResult":
      return decideVerificationResult(snapshot, command, context);
    default:
      reject("INVALID_REQUEST", "command.type is not a supported contract value");
  }
}
