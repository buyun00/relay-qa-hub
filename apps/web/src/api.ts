import {
  assertProjectRequest,
  getActiveProjectId,
  projectRequestSnapshot,
  projectStorageKey,
} from "./project-context";

export type BugListState =
  | "reported"
  | "needs_info"
  | "ready"
  | "in_progress"
  | "awaiting_build"
  | "ready_for_verification"
  | "closed"
  | "deferred"
  | "rejected"
  | "duplicate";

export interface BrowserSessionPrincipal {
  readonly accountId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly csrfToken: string;
  readonly projectId?: string | null;
  readonly isGm?: boolean;
}

export interface QingyuUser {
  readonly id: string;
  readonly name: string;
  readonly avatar: string | null;
}

export interface QingyuSession {
  readonly authenticated: boolean;
  readonly user: QingyuUser | null;
  readonly login: {
    readonly status: "pending" | "scanned" | "expired" | "cancelled" | "error";
    readonly qrContent: string;
    readonly expiresAt: string;
  } | null;
}

export interface QingyuProject {
  readonly id: string;
  readonly name: string;
}

export interface QingyuDefect {
  readonly id: string;
  readonly code: string | null;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly string[];
  readonly actualBehavior: string;
  readonly expectedBehavior: string;
  readonly status: string | null;
  readonly statusKey: string | null;
  readonly priority: string | null;
  readonly severity: string | null;
  readonly assignee: string | null;
  readonly updatedAt: string | null;
  readonly images: readonly string[];
  readonly url: string;
  readonly actionable: boolean;
  readonly importedBugId: string | null;
}

export interface QingyuBugLink {
  readonly bugId: string;
  readonly externalProjectId: string;
  readonly defectId: string;
  readonly defectCode: string | null;
  readonly defectTitle: string;
  readonly defectUrl: string;
  readonly qingyuUserName: string;
  readonly importedAt: string;
  readonly syncStatus: "not_synced" | "syncing" | "succeeded" | "failed";
  readonly syncAttempts: number;
  readonly syncedAt: string | null;
  readonly externalStatus: string | null;
  readonly lastSyncErrorCode: string | null;
  readonly lastSyncErrorMessage: string | null;
  readonly lastSyncAt: string | null;
}

export interface QingyuImportResult {
  readonly items: readonly {
    readonly defectId: string;
    readonly status: "created" | "already_imported" | "skipped_terminal" | "failed";
    readonly bug: BugDetail | null;
    readonly skippedImages: number;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
  }[];
}

let browserCsrfToken: string | null = null;
export const APP_FIRST_API_MEDIA_TYPE = "application/vnd.relay-qa-hub.v1.1+json";
const RECOVERABLE_SESSION_CODES = new Set(["UNAUTHENTICATED", "NATIVE_SESSION_INVALID"]);
const API_REQUEST_TIMEOUT_MS = 25_000;
const API_TRANSFER_TIMEOUT_MS = 65_000;

export function setBrowserCsrfToken(value: string | null): void {
  browserCsrfToken = value;
}

function rememberLoginName(value: string | null): void {
  try {
    const key = projectStorageKey("login-name", getActiveProjectId(), "");
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // A denied storage API must not make an otherwise valid session unusable.
  }
}

export type BugSeverity = "S0" | "S1" | "S2" | "S3" | "S4";

export interface BugListFilters {
  readonly q?: string;
  readonly ownerId?: string;
  readonly verificationOwnerId?: string;
  readonly ownerState?: "assigned" | "unassigned";
  readonly state?: BugListState;
  readonly severity?: BugSeverity;
  readonly cursor?: string;
}

export type ProjectRole =
  | "viewer"
  | "reporter"
  | "developer"
  | "verifier"
  | "triager"
  | "release_manager"
  | "project_admin";

export interface VisibleProject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly active: true;
  readonly roles: readonly ProjectRole[];
}

export interface VisibleProjectList {
  readonly snapshotSequence: number;
  readonly items: readonly VisibleProject[];
  readonly nextCursor: string | null;
}

export interface ProjectMember {
  readonly userId: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly roles: readonly ProjectRole[];
  readonly active: true;
}

export interface ProjectMemberList {
  readonly projectId: string;
  readonly snapshotSequence: number;
  readonly items: readonly ProjectMember[];
  readonly nextCursor: string | null;
}

export interface ManagedProjectUser {
  readonly userId: string;
  readonly displayName: string;
  readonly status: "active" | "disabled";
  readonly membershipStatus: "active" | "revoked";
  readonly membershipVersion?: number;
  readonly roles: readonly ProjectRole[];
  readonly linkedToUserId: string | null;
  readonly linkedToDisplayName: string | null;
  readonly linkedUserCount: number;
  readonly taskCount: number;
  readonly activeSessionCount: number;
  readonly protected: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedProjectUserList {
  readonly projectId: string;
  readonly items: readonly ManagedProjectUser[];
}

export interface ProjectModule {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly active: boolean;
}

export interface ProjectModuleList {
  readonly projectId: string;
  readonly items: readonly ProjectModule[];
}

export interface NotificationItem {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
  readonly type: string;
  readonly title: string;
  readonly bugId: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly version: number;
}

export interface NotificationList {
  readonly items: readonly NotificationItem[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
}

export type BugPriority = "P0" | "P1" | "P2" | "P3" | "P4";

export interface BugListItem {
  readonly id: string;
  readonly projectId: string;
  readonly number: number;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly expectedBehavior: string;
  readonly moduleId: string | null;
  readonly state: BugListState;
  readonly severity: BugSeverity;
  readonly priority: BugPriority;
  readonly reporterId: string;
  readonly ownerId: string | null;
  readonly verificationOwnerId: string | null;
  readonly duplicateOfBugId: string | null;
  readonly occurrenceCount: number;
  readonly reopenCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface BugListResponse {
  readonly snapshotSequence: number;
  readonly items: readonly BugListItem[];
  readonly nextCursor: string | null;
}

export interface ProjectMetricsOverview {
  readonly projectId: string;
  readonly window: {
    readonly from: string;
    readonly to: string;
  };
  readonly snapshotSequence: number;
  readonly newBugCount: number;
  readonly currentStateCounts: readonly {
    readonly state: BugListState;
    readonly count: number;
  }[];
}

export type BugDetail = BugListItem;

export interface UpdateBugDetailsInput {
  readonly title?: string;
  readonly description?: string;
  readonly expectedBehavior?: string;
  readonly moduleId?: string | null;
  readonly severity?: BugSeverity;
  readonly priority?: BugPriority;
  readonly attachmentIds?: readonly string[];
}

export interface AttachmentMetadata {
  readonly attachmentId: string;
  readonly projectId: string;
  readonly clientSubmissionId: string;
  readonly clientAttachmentId: string;
  readonly captureId: string | null;
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly scanStatus: "clean";
  readonly readyToBind: true;
  readonly bindingStatus: "claimed";
  readonly version: number;
}

export interface BugAttachmentList {
  readonly bugId: string;
  readonly projectId: string;
  readonly snapshotSequence: number;
  readonly items: readonly AttachmentMetadata[];
  readonly nextCursor: null;
}

export type CaptureEnrichmentStatus = "unavailable" | "partial" | "complete";

export type CapturePocoMethod =
  | "GetSDKVersion"
  | "Screenshot"
  | "Dump"
  | "GetScreenSize"
  | "GetDebugProfilingData"
  | "qa.snapshot";

export type CaptureArtifactKind =
  | "system_screenshot"
  | "system_recording"
  | "poco_screenshot"
  | "poco_hierarchy"
  | "poco_profiling"
  | "poco_snapshot";

export interface CaptureBundleSummary {
  readonly captureId: string;
  readonly enrichmentStatus: CaptureEnrichmentStatus;
  readonly artifacts: readonly {
    readonly captureId: string;
    readonly attachmentId: string | null;
    readonly kind: CaptureArtifactKind;
    readonly status: "succeeded" | "failed" | "skipped";
  }[];
  readonly poco: {
    readonly status: CaptureEnrichmentStatus;
    readonly attempted: boolean;
    readonly connectedPort: number | null;
    readonly sdkVersion: string | null;
    readonly snapshotCapability: "not_probed" | "standard_only" | "qa_snapshot_available";
    readonly negotiatedMethods: readonly CapturePocoMethod[];
    readonly succeededMethods: readonly CapturePocoMethod[];
    readonly failureReason: string | null;
  };
}

export interface CaptureArtifactBinary {
  readonly blob: Blob;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
}

export interface DuplicateCandidate {
  readonly bugId: string;
  readonly bugKey: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface DuplicateCandidateList {
  readonly candidates: readonly DuplicateCandidate[];
}

export interface BugEvent {
  readonly projectionVersion: "1.1.0";
  readonly redactionPolicyVersion: "1.0.0";
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly projectId: string;
  readonly bugId: string;
  readonly aggregate: {
    readonly type: string;
    readonly id: string;
    readonly version: number;
  };
  readonly sequence: number;
  readonly actor: { readonly type: string; readonly id: string | null };
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly occurredAt: string;
  readonly fromState: string | null;
  readonly toState: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface BugEventsResponse {
  readonly projectId: string;
  readonly bugId: string;
  readonly snapshotSequence: number;
  readonly items: readonly BugEvent[];
  readonly nextCursor: null;
}

export interface CommentCreationResponse {
  readonly comment: {
    readonly id: string;
    readonly bugId: string;
    readonly authorId: string;
    readonly body: string;
    readonly clientSubmissionId: string;
    readonly createdAt: string;
    readonly version: number;
  };
  readonly correlationId: string;
}

export interface BugComment {
  readonly id: string;
  readonly bugId: string;
  readonly projectId: string;
  readonly authorId: string;
  readonly body: string;
  readonly attachmentIds: readonly string[];
  readonly createdAt: string;
  readonly version: number;
}

export interface BugCommentsResponse {
  readonly bugId: string;
  readonly projectId: string;
  readonly snapshotSequence: number;
  readonly items: readonly BugComment[];
  readonly nextCursor: null;
}

interface BugTimelinePage<T> {
  readonly bugId: string;
  readonly projectId: string;
  readonly snapshotSequence: number;
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

const BUG_TIMELINE_PAGE_FIELDS = new Set([
  "bugId",
  "projectId",
  "snapshotSequence",
  "items",
  "nextCursor",
]);
const BUG_COMMENT_FIELDS = new Set([
  "id",
  "bugId",
  "projectId",
  "authorId",
  "body",
  "attachmentIds",
  "createdAt",
  "version",
]);
const BUG_EVENT_FIELDS = new Set([
  "projectionVersion",
  "redactionPolicyVersion",
  "id",
  "type",
  "source",
  "projectId",
  "bugId",
  "aggregate",
  "sequence",
  "actor",
  "correlationId",
  "causationId",
  "occurredAt",
  "fromState",
  "toState",
  "payload",
]);
const BUG_TIMELINE_MAX_PAGES = 100;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBugComment(value: unknown, bugId: string, projectId: string): value is BugComment {
  if (!isObjectRecord(value) || !hasExactKeys(value, BUG_COMMENT_FIELDS)) return false;
  return (
    typeof value.id === "string" &&
    UUID_PATTERN.test(value.id) &&
    value.bugId === bugId &&
    value.projectId === projectId &&
    typeof value.authorId === "string" &&
    UUID_PATTERN.test(value.authorId) &&
    typeof value.body === "string" &&
    value.body.length >= 1 &&
    value.body.length <= 20_000 &&
    Array.isArray(value.attachmentIds) &&
    value.attachmentIds.length <= 20 &&
    value.attachmentIds.every(
      (attachmentId) => typeof attachmentId === "string" && UUID_PATTERN.test(attachmentId),
    ) &&
    new Set(value.attachmentIds).size === value.attachmentIds.length &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    Number.isSafeInteger(value.version) &&
    (value.version as number) >= 1
  );
}

function isBugEvent(value: unknown, bugId: string, projectId: string): value is BugEvent {
  if (!isObjectRecord(value) || !hasExactKeys(value, BUG_EVENT_FIELDS)) return false;
  const aggregate = value.aggregate;
  const actor = value.actor;
  return (
    value.projectionVersion === "1.1.0" &&
    value.redactionPolicyVersion === "1.0.0" &&
    typeof value.id === "string" &&
    UUID_PATTERN.test(value.id) &&
    typeof value.type === "string" &&
    value.type.length >= 1 &&
    typeof value.source === "string" &&
    value.source.length >= 1 &&
    value.projectId === projectId &&
    value.bugId === bugId &&
    isObjectRecord(aggregate) &&
    hasExactKeys(aggregate, new Set(["type", "id", "version"])) &&
    typeof aggregate.type === "string" &&
    aggregate.type.length >= 1 &&
    typeof aggregate.id === "string" &&
    UUID_PATTERN.test(aggregate.id) &&
    Number.isSafeInteger(aggregate.version) &&
    (aggregate.version as number) >= 1 &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) >= 1 &&
    isObjectRecord(actor) &&
    hasExactKeys(actor, new Set(["type", "id"])) &&
    typeof actor.type === "string" &&
    actor.type.length >= 1 &&
    (actor.id === null || (typeof actor.id === "string" && actor.id.length >= 1)) &&
    typeof value.correlationId === "string" &&
    value.correlationId.length >= 1 &&
    (value.causationId === null ||
      (typeof value.causationId === "string" && value.causationId.length >= 1)) &&
    typeof value.occurredAt === "string" &&
    Number.isFinite(Date.parse(value.occurredAt)) &&
    (value.fromState === null || typeof value.fromState === "string") &&
    (value.toState === null || typeof value.toState === "string") &&
    isObjectRecord(value.payload)
  );
}

async function listCompleteBugTimeline<T>(options: {
  readonly bugId: string;
  readonly resource: "comments" | "events";
  readonly pageSize: number;
  readonly invalidCode: string;
  readonly cursorCode: string;
  readonly snapshotCode: string;
  readonly tooLargeCode: string;
  readonly validateItem: (value: unknown, bugId: string, projectId: string) => value is T;
}): Promise<BugTimelinePage<T> & { readonly nextCursor: null }> {
  const items = new Map<string, T>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let snapshotSequence: number | undefined;
  let projectId: string | undefined;

  for (let pageNumber = 0; pageNumber < BUG_TIMELINE_MAX_PAGES; pageNumber += 1) {
    const query = new URLSearchParams({ limit: String(options.pageSize) });
    if (cursor !== undefined) query.set("cursor", cursor);
    const body = requireRecord(
      await requestJson(
        `/api/v1/bugs/${encodeURIComponent(options.bugId)}/${options.resource}?${query}`,
      ),
      options.resource.toUpperCase(),
    );
    if (
      !hasExactKeys(body, BUG_TIMELINE_PAGE_FIELDS) ||
      body.bugId !== options.bugId ||
      typeof body.projectId !== "string" ||
      !UUID_PATTERN.test(body.projectId) ||
      !Number.isSafeInteger(body.snapshotSequence) ||
      (body.snapshotSequence as number) < 0 ||
      !Array.isArray(body.items) ||
      body.items.length > options.pageSize ||
      !isCursor(body.nextCursor)
    ) {
      throw new QaHubApiError(200, options.invalidCode);
    }
    if (snapshotSequence === undefined) {
      snapshotSequence = body.snapshotSequence as number;
      projectId = body.projectId;
    } else if (body.snapshotSequence !== snapshotSequence || body.projectId !== projectId) {
      throw new QaHubApiError(200, options.snapshotCode);
    }
    const pageProjectId = projectId;
    if (pageProjectId === undefined) throw new QaHubApiError(200, options.invalidCode);
    for (const item of body.items) {
      if (!options.validateItem(item, options.bugId, pageProjectId)) {
        throw new QaHubApiError(200, options.invalidCode);
      }
      const id = (item as { readonly id: string }).id;
      if (items.has(id)) throw new QaHubApiError(200, options.invalidCode);
      items.set(id, item);
    }
    if (body.nextCursor === null) {
      return {
        bugId: options.bugId,
        projectId: pageProjectId,
        snapshotSequence,
        items: [...items.values()],
        nextCursor: null,
      };
    }
    if (seenCursors.has(body.nextCursor)) {
      throw new QaHubApiError(200, options.cursorCode);
    }
    seenCursors.add(body.nextCursor);
    cursor = body.nextCursor;
  }
  throw new QaHubApiError(200, options.tooLargeCode);
}

export async function listBugComments(bugId: string): Promise<BugCommentsResponse> {
  return listCompleteBugTimeline({
    bugId,
    resource: "comments",
    pageSize: 50,
    invalidCode: "INVALID_COMMENTS",
    cursorCode: "INVALID_COMMENT_CURSOR",
    snapshotCode: "INVALID_COMMENT_SNAPSHOT",
    tooLargeCode: "COMMENT_HISTORY_TOO_LARGE",
    validateItem: isBugComment,
  });
}

export type RepairMode = "human" | "relay" | "external";

export type RepairAttemptStatus =
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

export interface RepairAttempt {
  readonly id: string;
  readonly bugId: string;
  readonly sequence: number;
  readonly mode: RepairMode;
  readonly status: RepairAttemptStatus;
  readonly assigneeId: string;
  readonly parentAttemptId: string | null;
  readonly summary: string | null;
  readonly branch: string | null;
  readonly commitSha: string | null;
  readonly mergeRequestUrl: string | null;
  readonly targetBuildId: string | null;
  readonly version: number;
}

export interface RelayRepairAttempt extends RepairAttempt {
  readonly mode: "relay";
  readonly status: "planned";
}

export interface RelayDispatchAccepted {
  readonly qaItem: { readonly type: "bug"; readonly id: string; readonly key: string };
  readonly repairAttemptId: string;
  readonly handoffId: string;
  readonly relayInstanceId: string;
  readonly outboxMessageId: string;
  readonly requestId: string;
  readonly status: "queued";
  readonly replayed: boolean;
}

export interface RelayReceipt {
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

export interface HumanRepairAttempt extends RepairAttempt {
  readonly mode: "human";
}

export interface SupersedeRepairAttemptResponse {
  readonly supersededAttempt: RepairAttempt;
  readonly successorAttempt: RepairAttempt;
  readonly bug: BugDetail;
  readonly eventId: string;
  readonly replayed: boolean;
}

export interface BuildRecord {
  readonly id: string;
  readonly projectId: string;
  readonly provider: "manual" | "ozdqp" | "custom";
  readonly externalId: string;
  readonly versionName: string;
  readonly channel: string;
  readonly projectKey: string;
  readonly branch: string;
  readonly sourceCommitSha: string;
  readonly mode: string;
  readonly status: string;
  readonly artifactSha256: string | null;
  readonly downloadUrl: string | null;
  readonly version: number;
}

export interface RegisterBuildResponse {
  readonly build: BuildRecord;
  readonly eventId: string;
  readonly outboxMessageId: string;
  readonly replayed: boolean;
}

export interface LinkBuildRepairResponse {
  readonly build: BuildRecord;
  readonly bug: BugDetail;
  readonly buildRequirement: {
    readonly id: string;
    readonly repairAttemptId: string;
    readonly deliveredCommitSha: string;
    readonly linkedBuildId: string;
    readonly version: number;
  };
  readonly repairLink: {
    readonly id: string;
    readonly buildId: string;
    readonly repairAttemptId: string;
    readonly deliveredCommitSha: string;
  };
  readonly eventId: string;
  readonly replayed: boolean;
}

export interface HumanWorkflowSnapshot {
  readonly relayAcceptance?: { readonly status: string; readonly lastError: string | null } | null;
  readonly relayRework?: { readonly status: string; readonly lastError: string | null } | null;
  readonly bugId: string;
  readonly repairAttempt: RepairAttempt | null;
  readonly buildRequirement: {
    readonly id: string;
    readonly repairAttemptId: string;
    readonly deliveredCommitSha: string;
    readonly linkedBuildId: string | null;
    readonly version: number;
  } | null;
  readonly build: BuildRecord | null;
  readonly verification: VerificationRecord | null;
}

export interface VerificationRecord {
  readonly id: string;
  readonly bugId: string;
  readonly repairAttemptId: string;
  readonly buildId: string | null;
  readonly status: "requested" | "in_progress" | "passed" | "failed" | "blocked" | "cancelled";
  readonly verifierId: string;
  readonly criteriaSnapshot: string;
  readonly resultSummary: string | null;
  readonly failureReason: string | null;
  readonly blockedReason: string | null;
  readonly version: number;
}

export interface VerificationOwnershipExpectation {
  readonly bugId: string;
  readonly repairAttemptId: string;
  readonly verifierId: string;
}

export type VerificationIdentityExpectation = VerificationOwnershipExpectation & {
  readonly verificationId: string;
};

export type VerificationResultExpectation = VerificationIdentityExpectation & {
  readonly projectId: string;
};

export interface VerificationResultResponse {
  readonly clientSubmissionId: string;
  readonly qaItem: { readonly type: "bug"; readonly id: string; readonly key: string };
  readonly verification: Omit<VerificationRecord, "failureReason" | "blockedReason">;
  readonly repairAttempt: RepairAttempt;
  readonly bug: BugDetail;
  readonly attachmentIds: readonly string[];
  readonly captureBundleId: string | null;
  readonly eventId: string;
  readonly replayed: boolean;
}

export interface CreateBugInput {
  readonly projectId: string;
  readonly clientSubmissionId: string;
  readonly title: string;
  readonly description: string;
  readonly expectedBehavior: string;
  readonly severity: BugSeverity;
  readonly priority: BugPriority;
  readonly ownerId: string | null;
  readonly verificationOwnerId: string;
  readonly attachmentIds: readonly string[];
  readonly occurrence?: {
    readonly observedAt: string;
    readonly platform: "web";
    readonly deviceModel: string;
    readonly osVersion: string;
    readonly steps: readonly string[];
    readonly actualBehavior: string;
  };
}

export interface CreateBugResponse {
  readonly clientSubmissionId: string;
  readonly qaItem: { readonly type: "bug"; readonly id: string; readonly key: string };
  readonly disposition: "created";
  readonly bug: BugDetail;
  readonly occurrenceId: string;
  readonly attachmentIds: readonly string[];
  readonly captureBundleId: null;
  readonly eventId: string;
  readonly replayed: boolean;
}

export class QaHubApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(code === null ? `QA Hub API returned HTTP ${status}` : code);
    this.name = "QaHubApiError";
    this.status = status;
    this.code = code;
  }
}

function readErrorCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const code = (value as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const BUG_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]*$/u;
const BUG_KEYS = new Set([
  "id",
  "projectId",
  "number",
  "key",
  "title",
  "description",
  "expectedBehavior",
  "moduleId",
  "state",
  "severity",
  "priority",
  "reporterId",
  "ownerId",
  "verificationOwnerId",
  "duplicateOfBugId",
  "occurrenceCount",
  "reopenCount",
  "version",
  "createdAt",
  "updatedAt",
  "closedAt",
]);

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return (
    Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key))
  );
}

function isUuidOrNull(value: unknown): boolean {
  return value === null || (typeof value === "string" && UUID_PATTERN.test(value));
}

function isDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_TIME_PATTERN.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (hour > 23 || minute > 59 || second > 59) return false;
  const calendar = new Date(0);
  calendar.setUTCHours(0, 0, 0, 0);
  calendar.setUTCFullYear(year, month - 1, day);
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day
  );
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && [...value].length >= minimum && [...value].length <= maximum;
}

function isBugListItem(value: unknown, expectedProjectId: string): value is BugListItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    hasExactKeys(item, BUG_KEYS) &&
    typeof item["id"] === "string" &&
    UUID_PATTERN.test(item["id"]) &&
    item["projectId"] === expectedProjectId &&
    Number.isSafeInteger(item["number"]) &&
    (item["number"] as number) >= 1 &&
    typeof item["key"] === "string" &&
    BUG_KEY_PATTERN.test(item["key"]) &&
    isBoundedString(item["title"], 1, 300) &&
    isBoundedString(item["description"], 1, 20_000) &&
    isBoundedString(item["expectedBehavior"], 1, 10_000) &&
    isUuidOrNull(item["moduleId"]) &&
    typeof item["state"] === "string" &&
    BUG_LIST_STATES.has(item["state"] as BugListState) &&
    typeof item["severity"] === "string" &&
    ["S0", "S1", "S2", "S3", "S4"].includes(item["severity"]) &&
    typeof item["priority"] === "string" &&
    ["P0", "P1", "P2", "P3", "P4"].includes(item["priority"]) &&
    typeof item["reporterId"] === "string" &&
    UUID_PATTERN.test(item["reporterId"]) &&
    isUuidOrNull(item["ownerId"]) &&
    isUuidOrNull(item["verificationOwnerId"]) &&
    isUuidOrNull(item["duplicateOfBugId"]) &&
    Number.isSafeInteger(item["occurrenceCount"]) &&
    (item["occurrenceCount"] as number) >= 1 &&
    Number.isSafeInteger(item["reopenCount"]) &&
    (item["reopenCount"] as number) >= 0 &&
    Number.isSafeInteger(item["version"]) &&
    (item["version"] as number) >= 1 &&
    isDateTime(item["createdAt"]) &&
    isDateTime(item["updatedAt"]) &&
    (item["closedAt"] === null || isDateTime(item["closedAt"]))
  );
}

function isBugListResponse(value: unknown, expectedProjectId: string): value is BugListResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (
    !hasExactKeys(response, new Set(["snapshotSequence", "items", "nextCursor"])) ||
    !Number.isSafeInteger(response["snapshotSequence"]) ||
    (response["snapshotSequence"] as number) < 0 ||
    !Array.isArray(response["items"]) ||
    response["items"].length > 100 ||
    !(
      response["nextCursor"] === null ||
      (typeof response["nextCursor"] === "string" &&
        response["nextCursor"].length >= 1 &&
        response["nextCursor"].length <= 500)
    )
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const item of response["items"]) {
    if (!isBugListItem(item, expectedProjectId) || ids.has(item.id)) return false;
    ids.add(item.id);
  }
  return true;
}

const BUG_LIST_STATES = new Set<BugListState>([
  "reported",
  "needs_info",
  "ready",
  "in_progress",
  "awaiting_build",
  "ready_for_verification",
  "closed",
  "deferred",
  "rejected",
  "duplicate",
]);

function isProjectMetricsOverview(
  value: unknown,
  projectId: string,
  from: string,
  to: string,
): value is ProjectMetricsOverview {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const overview = value as Record<string, unknown>;
  const windowValue = overview["window"];
  if (typeof windowValue !== "object" || windowValue === null || Array.isArray(windowValue)) {
    return false;
  }
  const windowRecord = windowValue as Record<string, unknown>;
  if (
    overview["projectId"] !== projectId ||
    windowRecord["from"] !== from ||
    windowRecord["to"] !== to ||
    !Number.isSafeInteger(overview["snapshotSequence"]) ||
    (overview["snapshotSequence"] as number) < 0 ||
    !Number.isSafeInteger(overview["newBugCount"]) ||
    (overview["newBugCount"] as number) < 0 ||
    !Array.isArray(overview["currentStateCounts"]) ||
    overview["currentStateCounts"].length !== BUG_LIST_STATES.size
  ) {
    return false;
  }
  const seenStates = new Set<BugListState>();
  for (const item of overview["currentStateCounts"]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    if (
      typeof row["state"] !== "string" ||
      !BUG_LIST_STATES.has(row["state"] as BugListState) ||
      seenStates.has(row["state"] as BugListState) ||
      !Number.isSafeInteger(row["count"]) ||
      (row["count"] as number) < 0
    ) {
      return false;
    }
    seenStates.add(row["state"] as BugListState);
  }
  return seenStates.size === BUG_LIST_STATES.size;
}

const PROJECT_ROLES = new Set<ProjectRole>([
  "viewer",
  "reporter",
  "developer",
  "verifier",
  "triager",
  "release_manager",
  "project_admin",
]);
const VISIBLE_PROJECT_KEYS = new Set(["id", "key", "name", "active", "roles"]);
const PROJECT_MEMBER_KEYS = new Set(["userId", "projectId", "displayName", "roles", "active"]);

function isRoleList(value: unknown): value is readonly ProjectRole[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.every((role) => typeof role === "string" && PROJECT_ROLES.has(role as ProjectRole)) &&
    new Set(value).size === value.length
  );
}

function isCursor(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length >= 1 && value.length <= 500);
}

function isVisibleProject(value: unknown): value is VisibleProject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    hasExactKeys(item, VISIBLE_PROJECT_KEYS) &&
    typeof item["id"] === "string" &&
    UUID_PATTERN.test(item["id"]) &&
    typeof item["key"] === "string" &&
    /^[A-Z][A-Z0-9]{1,15}$/u.test(item["key"]) &&
    isBoundedString(item["name"], 1, 200) &&
    item["active"] === true &&
    isRoleList(item["roles"])
  );
}

function isVisibleProjectList(value: unknown): value is VisibleProjectList {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (
    !hasExactKeys(response, new Set(["snapshotSequence", "items", "nextCursor"])) ||
    !Number.isSafeInteger(response["snapshotSequence"]) ||
    (response["snapshotSequence"] as number) < 0 ||
    !Array.isArray(response["items"]) ||
    response["items"].length > 100 ||
    !isCursor(response["nextCursor"])
  ) {
    return false;
  }
  const ids = new Set<string>();
  return response["items"].every((item) => {
    if (!isVisibleProject(item) || ids.has(item.id)) return false;
    ids.add(item.id);
    return true;
  });
}

function isProjectMember(value: unknown, projectId: string): value is ProjectMember {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    hasExactKeys(item, PROJECT_MEMBER_KEYS) &&
    typeof item["userId"] === "string" &&
    UUID_PATTERN.test(item["userId"]) &&
    item["projectId"] === projectId &&
    isBoundedString(item["displayName"], 1, 200) &&
    isRoleList(item["roles"]) &&
    item["active"] === true
  );
}

function isProjectMemberList(value: unknown, projectId: string): value is ProjectMemberList {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (
    !hasExactKeys(response, new Set(["projectId", "snapshotSequence", "items", "nextCursor"])) ||
    response["projectId"] !== projectId ||
    !Number.isSafeInteger(response["snapshotSequence"]) ||
    (response["snapshotSequence"] as number) < 0 ||
    !Array.isArray(response["items"]) ||
    response["items"].length > 100 ||
    !isCursor(response["nextCursor"])
  ) {
    return false;
  }
  const ids = new Set<string>();
  return response["items"].every((item) => {
    if (!isProjectMember(item, projectId) || ids.has(item.userId)) return false;
    ids.add(item.userId);
    return true;
  });
}

function isProjectScopedList(value: unknown, projectId: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as { readonly projectId?: unknown; readonly items?: unknown };
  return response.projectId === projectId && Array.isArray(response.items);
}

function isNotificationList(value: unknown): value is NotificationList {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (
    !Array.isArray(response["items"]) ||
    !(response["nextCursor"] === null || typeof response["nextCursor"] === "string") ||
    !Number.isSafeInteger(response["unreadCount"]) ||
    (response["unreadCount"] as number) < 0
  ) {
    return false;
  }
  return response["items"].every((value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return (
      typeof item["id"] === "string" &&
      typeof item["projectId"] === "string" &&
      typeof item["userId"] === "string" &&
      typeof item["type"] === "string" &&
      typeof item["title"] === "string" &&
      (item["bugId"] === null || typeof item["bugId"] === "string") &&
      typeof item["createdAt"] === "string" &&
      (item["readAt"] === null || typeof item["readAt"] === "string") &&
      Number.isSafeInteger(item["version"]) &&
      (item["version"] as number) > 0
    );
  });
}

function isAttachmentMetadata(value: unknown): value is AttachmentMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<AttachmentMetadata>;
  return (
    typeof item.attachmentId === "string" &&
    typeof item.projectId === "string" &&
    typeof item.clientSubmissionId === "string" &&
    typeof item.clientAttachmentId === "string" &&
    (item.captureId === null || typeof item.captureId === "string") &&
    typeof item.filename === "string" &&
    typeof item.mediaType === "string" &&
    typeof item.size === "number" &&
    Number.isSafeInteger(item.size) &&
    item.size > 0 &&
    typeof item.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(item.sha256) &&
    item.scanStatus === "clean" &&
    item.readyToBind === true &&
    item.bindingStatus === "claimed"
  );
}

const CAPTURE_ENRICHMENT_STATUSES = new Set<CaptureEnrichmentStatus>([
  "unavailable",
  "partial",
  "complete",
]);

const CAPTURE_POCO_METHODS = new Set<CapturePocoMethod>([
  "GetSDKVersion",
  "Screenshot",
  "Dump",
  "GetScreenSize",
  "GetDebugProfilingData",
  "qa.snapshot",
]);

const CAPTURE_ARTIFACT_KINDS = new Set<CaptureArtifactKind>([
  "system_screenshot",
  "system_recording",
  "poco_screenshot",
  "poco_hierarchy",
  "poco_profiling",
  "poco_snapshot",
]);

const CAPTURE_ARTIFACT_MEDIA_TYPES: Readonly<Record<CaptureArtifactKind, readonly string[]>> = {
  system_screenshot: ["image/png", "image/jpeg", "image/webp"],
  system_recording: ["video/mp4", "video/webm"],
  poco_screenshot: ["image/png", "image/jpeg", "image/webp"],
  poco_hierarchy: ["application/json"],
  poco_profiling: ["application/json"],
  poco_snapshot: ["application/json"],
};

function isCaptureEnrichmentStatus(value: unknown): value is CaptureEnrichmentStatus {
  return (
    typeof value === "string" && CAPTURE_ENRICHMENT_STATUSES.has(value as CaptureEnrichmentStatus)
  );
}

function isCapturePocoMethodList(value: unknown): value is readonly CapturePocoMethod[] {
  return (
    Array.isArray(value) &&
    value.every(
      (method) =>
        typeof method === "string" && CAPTURE_POCO_METHODS.has(method as CapturePocoMethod),
    )
  );
}

function isCaptureArtifactKind(value: unknown): value is CaptureArtifactKind {
  return typeof value === "string" && CAPTURE_ARTIFACT_KINDS.has(value as CaptureArtifactKind);
}

function isCaptureBundleSummary(value: unknown, captureId: string): value is CaptureBundleSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const bundle = value as Record<string, unknown>;
  if (
    bundle.captureId !== captureId ||
    !isCaptureEnrichmentStatus(bundle.enrichmentStatus) ||
    !Array.isArray(bundle.artifacts) ||
    typeof bundle.poco !== "object" ||
    bundle.poco === null ||
    Array.isArray(bundle.poco)
  ) {
    return false;
  }

  const artifactsAreValid = bundle.artifacts.every((artifact: unknown) => {
    if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) return false;
    const item = artifact as Record<string, unknown>;
    return (
      item.captureId === captureId &&
      (item.attachmentId === null || typeof item.attachmentId === "string") &&
      isCaptureArtifactKind(item.kind) &&
      (item.status === "succeeded" || item.status === "failed" || item.status === "skipped")
    );
  });
  if (!artifactsAreValid) return false;

  const poco = bundle.poco as Record<string, unknown>;
  return (
    poco.status === bundle.enrichmentStatus &&
    typeof poco.attempted === "boolean" &&
    (poco.connectedPort === null ||
      (Number.isSafeInteger(poco.connectedPort) &&
        (poco.connectedPort as number) > 0 &&
        (poco.connectedPort as number) <= 65_535)) &&
    (poco.sdkVersion === null || typeof poco.sdkVersion === "string") &&
    (poco.snapshotCapability === "not_probed" ||
      poco.snapshotCapability === "standard_only" ||
      poco.snapshotCapability === "qa_snapshot_available") &&
    isCapturePocoMethodList(poco.negotiatedMethods) &&
    isCapturePocoMethodList(poco.succeededMethods) &&
    (poco.failureReason === null || typeof poco.failureReason === "string")
  );
}

async function fetchWithTimeout(
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  init = projectRequestSnapshot(init);
  assertProjectRequest(init);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  try {
    const response = await fetch(path, { ...init, signal });
    assertProjectRequest(init);
    return response;
  } catch (cause) {
    if (timeoutSignal.aborted) throw new QaHubApiError(504, "REQUEST_TIMEOUT");
    throw cause;
  }
}

async function fetchJson(
  path: string,
  init?: RequestInit,
): Promise<{
  readonly response: Response;
  readonly body: unknown;
}> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/vnd.relay-qa-hub.v1.1+json");
  if (browserCsrfToken !== null && !["GET", "HEAD", "OPTIONS"].includes(method))
    headers.set("X-CSRF-Token", browserCsrfToken);
  try {
    const response = await fetchWithTimeout(
      path,
      {
        ...init,
        credentials: "same-origin",
        headers,
      },
      API_REQUEST_TIMEOUT_MS,
    );
    const body: unknown = await response.json().catch(() => null);
    if (init) assertProjectRequest(init);
    return { response, body };
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
      throw new QaHubApiError(504, "REQUEST_TIMEOUT");
    }
    throw cause;
  }
}

async function establishBrowserSession(
  name: string,
  projectName: string,
  code: string,
): Promise<BrowserSessionPrincipal> {
  setBrowserCsrfToken(null);
  const init = projectRequestSnapshot(
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, projectName, code, client: "web" }),
    },
    "",
  );
  const { response, body } = await fetchJson("/api/v1/auth/login", init);
  if (!response.ok) throw new QaHubApiError(response.status, readErrorCode(body));
  if (!isBrowserSessionPrincipal(body)) {
    throw new QaHubApiError(200, "INVALID_AUTH_RESPONSE");
  }
  setBrowserCsrfToken(body.csrfToken);
  rememberLoginName(body.displayName);
  return body;
}

async function recoverBrowserSession(): Promise<BrowserSessionPrincipal> {
  // The project code is deliberately never persisted, so an expired session
  // cannot silently bypass the three-field project join form.
  throw new QaHubApiError(401, "UNAUTHENTICATED");
}

export async function requestJson(
  path: string,
  init?: RequestInit,
  allowSessionRecovery = true,
): Promise<unknown> {
  const pathProject = path.match(/^\/api\/v1\/(?:gm\/)?projects\/([^/?]+)/u)?.[1];
  const queryProject = new URL(path, "http://qa.local").searchParams.get("projectId");
  init = projectRequestSnapshot(
    init,
    pathProject ? decodeURIComponent(pathProject) : (queryProject ?? getActiveProjectId()),
  );
  let { response, body } = await fetchJson(path, init);
  const errorCode = readErrorCode(body);
  if (
    allowSessionRecovery &&
    response.status === 401 &&
    errorCode !== null &&
    RECOVERABLE_SESSION_CODES.has(errorCode)
  ) {
    await recoverBrowserSession();
    assertProjectRequest(init);
    ({ response, body } = await fetchJson(path, init));
  }
  if (!response.ok) {
    const code = readErrorCode(body);
    if (
      typeof window !== "undefined" &&
      ["PROJECT_NOT_ACCESSIBLE", "PROJECT_MEMBERSHIP_DISABLED"].includes(code ?? "")
    )
      window.dispatchEvent(
        new CustomEvent("qa-hub:project-access-denied", {
          detail: new Headers(init.headers).get("x-qa-project-id"),
        }),
      );
    throw new QaHubApiError(response.status, code);
  }
  return body;
}

function isBrowserSessionPrincipal(value: unknown): value is BrowserSessionPrincipal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.accountId === "string" &&
    typeof record.userId === "string" &&
    typeof record.email === "string" &&
    typeof record.displayName === "string" &&
    typeof record.csrfToken === "string" &&
    record.csrfToken.length > 0
  );
}

export async function getBrowserSession(): Promise<BrowserSessionPrincipal> {
  const body = await requestJson("/api/v1/auth/me");
  if (!isBrowserSessionPrincipal(body)) {
    throw new QaHubApiError(200, "INVALID_AUTH_RESPONSE");
  }
  setBrowserCsrfToken(body.csrfToken);
  return body;
}

export async function loginBrowserSession(
  name: string,
  projectName: string,
  code: string,
): Promise<BrowserSessionPrincipal> {
  return establishBrowserSession(name, projectName, code);
}

export async function loginGmSession(password: string): Promise<BrowserSessionPrincipal> {
  const body = await requestJson(
    "/api/v1/auth/gm/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password, client: "web" }),
    },
    false,
  );
  if (!isBrowserSessionPrincipal(body) || !body.isGm)
    throw new QaHubApiError(403, "GM_LOGIN_REQUIRED");
  setBrowserCsrfToken(body.csrfToken);
  return body;
}

export async function logoutBrowserSession(): Promise<void> {
  await requestJson("/api/v1/auth/logout", { method: "POST" }, false);
  setBrowserCsrfToken(null);
  rememberLoginName(null);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new QaHubApiError(200, `INVALID_${label}`);
  }
  return value as Record<string, unknown>;
}

export async function listBugs(
  projectId: string,
  filters: BugListFilters = {},
  signal?: AbortSignal,
  limit = 100,
): Promise<BugListResponse> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new TypeError("Bug list limit must be an integer between 1 and 500");
  }
  const query = new URLSearchParams({ projectId, limit: String(limit) });
  if (filters.q !== undefined) query.set("q", filters.q);
  if (filters.ownerId !== undefined) query.set("ownerId", filters.ownerId);
  if (filters.verificationOwnerId !== undefined)
    query.set("verificationOwnerId", filters.verificationOwnerId);
  if (filters.ownerState !== undefined) query.set("ownerState", filters.ownerState);
  if (filters.state !== undefined) query.set("state", filters.state);
  if (filters.severity !== undefined) query.set("severity", filters.severity);
  if (filters.cursor !== undefined) query.set("cursor", filters.cursor);
  const body = await requestJson(`/api/v1/bugs?${query.toString()}`, {
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isBugListResponse(body, projectId)) throw new QaHubApiError(200, "INVALID_RESPONSE");
  return body;
}

/**
 * Read a complete stable-filter Bug stream. Freeze the first page's snapshot
 * sequence, reject cross-page drift, and restart once only when the server
 * explicitly invalidates a continuation cursor.
 */
export async function listAllBugs(
  projectId: string,
  filters: Omit<BugListFilters, "cursor"> = {},
  signal?: AbortSignal,
  limit = 500,
): Promise<BugListResponse> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const items = new Map<string, BugListItem>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let snapshotSequence: number | undefined;
    let complete = false;
    try {
      while (!complete) {
        const page = await listBugs(
          projectId,
          { ...filters, ...(cursor === undefined ? {} : { cursor }) },
          signal,
          limit,
        );
        if (snapshotSequence === undefined) {
          snapshotSequence = page.snapshotSequence;
        } else if (page.snapshotSequence !== snapshotSequence) {
          throw new QaHubApiError(200, "INVALID_BUG_LIST_SNAPSHOT");
        }
        for (const item of page.items) {
          if (items.has(item.id)) throw new QaHubApiError(200, "INVALID_RESPONSE");
          items.set(item.id, item);
        }
        if (page.nextCursor === null) {
          complete = true;
        } else {
          if (page.nextCursor.length === 0 || seenCursors.has(page.nextCursor)) {
            throw new QaHubApiError(200, "INVALID_BUG_LIST_CURSOR");
          }
          seenCursors.add(page.nextCursor);
          cursor = page.nextCursor;
        }
      }
      if (snapshotSequence === undefined) {
        throw new QaHubApiError(200, "INVALID_BUG_LIST_SNAPSHOT");
      }
      return {
        snapshotSequence,
        items: [...items.values()],
        nextCursor: null,
      };
    } catch (cause) {
      const invalidatedContinuation =
        cursor !== undefined &&
        cause instanceof QaHubApiError &&
        cause.status === 400 &&
        cause.code === "INVALID_REQUEST";
      if (attempt === 0 && invalidatedContinuation) continue;
      throw cause;
    }
  }
  throw new QaHubApiError(400, "INVALID_REQUEST");
}

export async function getProjectMetricsOverview(
  projectId: string,
  from: string,
  to: string,
): Promise<ProjectMetricsOverview> {
  const query = new URLSearchParams({ from, to });
  const body = await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/metrics/overview?${query.toString()}`,
  );
  if (!isProjectMetricsOverview(body, projectId, from, to)) {
    throw new QaHubApiError(200, "INVALID_METRICS_RESPONSE");
  }
  return body;
}

export async function listVisibleProjects(): Promise<VisibleProjectList> {
  const items = new Map<string, VisibleProject>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let snapshotSequence: number | undefined;
  while (true) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor !== undefined) query.set("cursor", cursor);
    const body = await requestJson(`/api/v1/projects?${query.toString()}`);
    if (!isVisibleProjectList(body)) throw new QaHubApiError(200, "INVALID_PROJECT_LIST");
    if (snapshotSequence === undefined) snapshotSequence = body.snapshotSequence;
    else if (body.snapshotSequence !== snapshotSequence) {
      throw new QaHubApiError(200, "INVALID_PROJECT_LIST_SNAPSHOT");
    }
    for (const item of body.items) {
      if (items.has(item.id)) throw new QaHubApiError(200, "INVALID_PROJECT_LIST");
      items.set(item.id, item);
    }
    if (body.nextCursor === null) {
      return { snapshotSequence, items: [...items.values()], nextCursor: null };
    }
    if (seenCursors.has(body.nextCursor)) {
      throw new QaHubApiError(200, "INVALID_PROJECT_LIST_CURSOR");
    }
    seenCursors.add(body.nextCursor);
    cursor = body.nextCursor;
  }
}

export async function listProjectMembers(projectId: string): Promise<ProjectMemberList> {
  const items = new Map<string, ProjectMember>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let snapshotSequence: number | undefined;
  while (true) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor !== undefined) query.set("cursor", cursor);
    const body = await requestJson(
      `/api/v1/projects/${encodeURIComponent(projectId)}/members?${query.toString()}`,
    );
    if (!isProjectMemberList(body, projectId)) {
      throw new QaHubApiError(200, "INVALID_PROJECT_MEMBER_LIST");
    }
    if (snapshotSequence === undefined) snapshotSequence = body.snapshotSequence;
    else if (body.snapshotSequence !== snapshotSequence) {
      throw new QaHubApiError(200, "INVALID_PROJECT_MEMBER_LIST_SNAPSHOT");
    }
    for (const item of body.items) {
      if (items.has(item.userId)) {
        throw new QaHubApiError(200, "INVALID_PROJECT_MEMBER_LIST");
      }
      items.set(item.userId, item);
    }
    if (body.nextCursor === null) {
      return { projectId, snapshotSequence, items: [...items.values()], nextCursor: null };
    }
    if (seenCursors.has(body.nextCursor)) {
      throw new QaHubApiError(200, "INVALID_PROJECT_MEMBER_LIST_CURSOR");
    }
    seenCursors.add(body.nextCursor);
    cursor = body.nextCursor;
  }
}

export async function listManagedProjectUsers(projectId: string): Promise<ManagedProjectUserList> {
  const body = await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/users?limit=500`,
  );
  if (!isProjectScopedList(body, projectId)) {
    throw new QaHubApiError(200, "INVALID_MANAGED_USER_LIST");
  }
  return body as unknown as ManagedProjectUserList;
}

export async function linkManagedProjectUser(
  projectId: string,
  userId: string,
  canonicalUserId: string,
): Promise<void> {
  await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/users/${encodeURIComponent(userId)}/identity-link`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ canonicalUserId }),
    },
  );
}

export async function unlinkManagedProjectUser(projectId: string, userId: string): Promise<void> {
  await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/users/${encodeURIComponent(userId)}/identity-link`,
    { method: "DELETE" },
  );
}

export async function disableManagedProjectUser(projectId: string, userId: string): Promise<void> {
  await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/users/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
}

export async function listProjectModules(projectId: string): Promise<ProjectModuleList> {
  const body = await requestJson(`/api/v1/projects/${encodeURIComponent(projectId)}/modules`);
  if (!isProjectScopedList(body, projectId)) {
    throw new QaHubApiError(200, "INVALID_PROJECT_MODULE_LIST");
  }
  return body as unknown as ProjectModuleList;
}

export async function listNotifications(limit = 20): Promise<NotificationList> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("notification limit must be an integer between 1 and 100");
  }
  const body = await requestJson(`/api/v1/notifications?limit=${limit}`);
  if (!isNotificationList(body)) {
    throw new QaHubApiError(200, "INVALID_NOTIFICATION_LIST");
  }
  return body;
}

export async function getBug(bugId: string): Promise<BugDetail> {
  const body = requireRecord(await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}`), "BUG");
  return body as unknown as BugDetail;
}

export async function listBugAttachments(bugId: string): Promise<BugAttachmentList> {
  const body = requireRecord(
    await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}/attachments?limit=50`),
    "BUG_ATTACHMENTS",
  );
  if (
    body.bugId !== bugId ||
    typeof body.projectId !== "string" ||
    !Number.isSafeInteger(body.snapshotSequence) ||
    !Array.isArray(body.items) ||
    !body.items.every(isAttachmentMetadata) ||
    body.nextCursor !== null
  ) {
    throw new QaHubApiError(200, "INVALID_BUG_ATTACHMENTS");
  }
  return body as unknown as BugAttachmentList;
}

export async function downloadAttachment(metadata: AttachmentMetadata): Promise<Blob> {
  const response = await fetchWithTimeout(
    `/api/v1/attachments/${encodeURIComponent(metadata.attachmentId)}`,
    {
      credentials: "same-origin",
      headers: { Accept: "application/octet-stream" },
    },
    API_TRANSFER_TIMEOUT_MS,
  );
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new QaHubApiError(response.status, readErrorCode(body));
  }
  const blob = await response.blob();
  const responseMediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const responseSha256 = response.headers.get("x-content-sha256");
  if (
    blob.size !== metadata.size ||
    responseMediaType !== metadata.mediaType ||
    responseSha256 !== metadata.sha256
  ) {
    throw new QaHubApiError(200, "INVALID_ATTACHMENT_BYTES");
  }
  return blob;
}

export async function getCaptureBundle(captureId: string): Promise<CaptureBundleSummary> {
  const body = await requestJson(`/api/v1/capture-bundles/${encodeURIComponent(captureId)}`);
  if (!isCaptureBundleSummary(body, captureId)) {
    throw new QaHubApiError(200, "INVALID_CAPTURE_BUNDLE");
  }
  return body;
}

export async function downloadCaptureArtifact(
  bugId: string,
  captureId: string,
  artifactKind: CaptureArtifactKind,
): Promise<CaptureArtifactBinary> {
  const response = await fetchWithTimeout(
    `/api/v1/bugs/${encodeURIComponent(bugId)}/capture-bundles/${encodeURIComponent(
      captureId,
    )}/artifacts/${encodeURIComponent(artifactKind)}`,
    { credentials: "same-origin", headers: { Accept: "application/octet-stream" } },
    API_TRANSFER_TIMEOUT_MS,
  );
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new QaHubApiError(response.status, readErrorCode(body));
  }

  const blob = await response.blob();
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
  const sha256 = response.headers.get("x-content-sha256") ?? "";
  const contentLength = Number(response.headers.get("content-length"));
  if (
    !CAPTURE_ARTIFACT_MEDIA_TYPES[artifactKind].includes(mediaType) ||
    !Number.isSafeInteger(contentLength) ||
    contentLength < 1 ||
    blob.size !== contentLength ||
    !/^[0-9a-f]{64}$/u.test(sha256)
  ) {
    throw new QaHubApiError(200, "INVALID_CAPTURE_ARTIFACT_BYTES");
  }
  return { blob, mediaType, size: contentLength, sha256 };
}

export async function getHumanWorkflow(bugId: string): Promise<HumanWorkflowSnapshot> {
  const body = requireRecord(
    await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}/human-workflow`),
    "HUMAN_WORKFLOW",
  );
  if (body.bugId !== bugId) {
    throw new QaHubApiError(200, "INVALID_HUMAN_WORKFLOW");
  }
  return body as unknown as HumanWorkflowSnapshot;
}

interface BugWorkflowProjectionPage {
  readonly bugId: string;
  readonly repairAttempts: readonly RepairAttempt[];
  readonly nextCursor: string | null;
}

/** Read every repair round from one frozen projection so terminal modes and statuses survive refresh. */
export async function listBugRepairAttempts(bugId: string): Promise<readonly RepairAttempt[]> {
  const attempts = new Map<string, RepairAttempt>();
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const query = new URLSearchParams({ limitPerCollection: "100" });
    if (cursor !== null) query.set("cursor", cursor);
    const body = requireRecord(
      await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}/workflow?${query}`),
      "BUG_WORKFLOW",
    );
    if (
      body.bugId !== bugId ||
      !Array.isArray(body.repairAttempts) ||
      (body.nextCursor !== null && typeof body.nextCursor !== "string")
    ) {
      throw new QaHubApiError(200, "INVALID_BUG_WORKFLOW");
    }
    const projection = body as unknown as BugWorkflowProjectionPage;
    for (const attempt of projection.repairAttempts) attempts.set(attempt.id, attempt);
    cursor = projection.nextCursor;
    if (cursor === null) return [...attempts.values()];
    if (seenCursors.has(cursor)) throw new QaHubApiError(200, "INVALID_BUG_WORKFLOW_CURSOR");
    seenCursors.add(cursor);
  }
  throw new QaHubApiError(200, "BUG_WORKFLOW_TOO_LARGE");
}

export async function listDuplicateCandidates(bugId: string): Promise<DuplicateCandidateList> {
  const body = requireRecord(
    await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}/duplicate-candidates`),
    "DUPLICATE_CANDIDATES",
  );
  if (!Array.isArray(body.candidates)) {
    throw new QaHubApiError(200, "INVALID_DUPLICATE_CANDIDATES");
  }
  return body as unknown as DuplicateCandidateList;
}

export async function markBugDuplicate(
  bugId: string,
  expectedVersion: number,
  canonicalBugId: string,
  reason: string,
): Promise<BugDetail> {
  const body = await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}/mark-duplicate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `workflow:markBugDuplicate:bug:${bugId}:v${expectedVersion}:canonical:${canonicalBugId}`,
    },
    body: JSON.stringify({ expectedVersion, toState: "duplicate", canonicalBugId, reason }),
  });
  return requireRecord(body, "BUG") as unknown as BugDetail;
}

export async function updateBugOwner(
  bugId: string,
  expectedVersion: number,
  ownerId: string | null,
): Promise<BugDetail> {
  const body = await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `web:updateBug:bug:${bugId}:v${expectedVersion}:owner:${ownerId ?? "null"}`,
    },
    body: JSON.stringify({ expectedVersion, ownerId }),
  });
  return requireRecord(body, "BUG") as unknown as BugDetail;
}

export async function updateBugVerificationOwner(
  bugId: string,
  expectedVersion: number,
  verificationOwnerId: string,
): Promise<BugDetail> {
  const body = await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `web:updateBug:bug:${bugId}:v${expectedVersion}:verifier:${verificationOwnerId}`,
    },
    body: JSON.stringify({ expectedVersion, verificationOwnerId }),
  });
  return requireRecord(body, "BUG") as unknown as BugDetail;
}

export async function updateBugPriority(
  bugId: string,
  expectedVersion: number,
  priority: BugPriority,
): Promise<BugDetail> {
  const body = await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `web:updateBug:bug:${bugId}:v${expectedVersion}:priority:${priority}`,
    },
    body: JSON.stringify({ expectedVersion, priority }),
  });
  return requireRecord(body, "BUG") as unknown as BugDetail;
}

export async function updateBugAssignments(
  bugId: string,
  expectedVersion: number,
  ownerId: string,
  verificationOwnerId: string,
): Promise<BugDetail> {
  const body = await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `web:updateBug:bug:${bugId}:v${expectedVersion}:assign:${ownerId}:${verificationOwnerId}`,
    },
    body: JSON.stringify({ expectedVersion, ownerId, verificationOwnerId }),
  });
  return requireRecord(body, "BUG") as unknown as BugDetail;
}

export async function updateBugDetails(
  bugId: string,
  expectedVersion: number,
  input: UpdateBugDetailsInput,
  clientMutationId: string,
): Promise<BugDetail> {
  const body = await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `web:updateBugDetails:bug:${bugId}:v${expectedVersion}:${clientMutationId}`,
    },
    body: JSON.stringify({ expectedVersion, ...input }),
  });
  return requireRecord(body, "BUG") as unknown as BugDetail;
}

export async function deleteBug(
  bugId: string,
  expectedVersion: number,
): Promise<{ readonly bugId: string; readonly deletedAt: string; readonly replayed: boolean }> {
  const body = await requestJson(
    `/api/v1/bugs/${encodeURIComponent(bugId)}?expectedVersion=${expectedVersion}`,
    {
      method: "DELETE",
      headers: {
        "Idempotency-Key": `web:deleteBug:bug:${bugId}:v${expectedVersion}`,
      },
    },
  );
  return requireRecord(body, "BUG_DELETION") as unknown as {
    readonly bugId: string;
    readonly deletedAt: string;
    readonly replayed: boolean;
  };
}

function submissionRequest(
  init: RequestInit,
  scope?: RequestInit,
  projectId?: string,
): RequestInit {
  if (scope) assertProjectRequest(scope);
  const headers = new Headers(scope?.headers);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return projectRequestSnapshot(
    { ...init, ...(scope?.signal ? { signal: scope.signal } : {}), headers },
    projectId,
  );
}

export async function createBug(
  input: CreateBugInput,
  scope?: RequestInit,
  frozenBody?: string,
): Promise<CreateBugResponse> {
  const body = await requestJson(
    "/api/v1/bugs",
    submissionRequest(
      {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.relay-qa-hub.v1.1+json",
          "Idempotency-Key": `submission:${input.clientSubmissionId}:commit`,
        },
        body:
          frozenBody ??
          JSON.stringify({
            submissionContractVersion: "1.1.0",
            projectId: input.projectId,
            clientSubmissionId: input.clientSubmissionId,
            title: input.title,
            description: input.description,
            expectedBehavior: input.expectedBehavior,
            severity: input.severity,
            priority: input.priority,
            ownerId: input.ownerId,
            verificationOwnerId: input.verificationOwnerId,
            occurrence: input.occurrence ?? {
              observedAt: new Date().toISOString(),
              platform: "web",
              deviceModel: navigator.userAgent.slice(0, 200),
              osVersion: navigator.platform.slice(0, 100),
              steps: ["从 Relay QA Hub Web 管理台提交"],
              actualBehavior: input.description,
            },
            attachmentIds: input.attachmentIds,
            captureBundleId: null,
          }),
      },
      scope,
      input.projectId,
    ),
    scope === undefined,
  );
  return requireRecord(body, "BUG_CREATION") as unknown as CreateBugResponse;
}

export interface UploadInitResponse {
  readonly sessionId: string;
  readonly chunkSize: number;
  readonly version: number;
}

export interface UploadFinalizeResponse {
  readonly attachmentId: string;
  readonly readyToBind: boolean;
  readonly version: number;
}

export interface AttachmentBindingResponse {
  readonly bindingId: string;
  readonly attachmentId: string;
  readonly projectId: string;
  readonly clientSubmissionId: string;
  readonly clientAttachmentId: string;
  readonly leaseGeneration: number;
  readonly intent: "bug_create" | "verification_result";
  readonly targetQaItemId: string | null;
  readonly status: "reserved";
  readonly expiresAt: string;
  readonly version: number;
  readonly replayed: boolean;
}

function csrfHeadersForMutation(): Record<string, string> {
  return browserCsrfToken === null ? {} : { "X-CSRF-Token": browserCsrfToken };
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export interface UploadCheckpoint {
  readonly clientAttachmentId: string;
  readonly sha256: string;
  readonly init?: UploadInitResponse | undefined;
  readonly nextChunk: number;
  readonly version?: number | undefined;
  readonly finalized?: UploadFinalizeResponse | undefined;
  readonly binding?: AttachmentBindingResponse | undefined;
  /** Legacy draft marker. A missing binding receipt cannot prove an active lease. */
  readonly bound?: boolean | undefined;
}
interface DurableUploadOptions {
  readonly checkpoint?: UploadCheckpoint;
  readonly saveCheckpoint?: (checkpoint: UploadCheckpoint) => Promise<void>;
  readonly scope?: RequestInit;
  readonly deferBinding?: boolean;
  readonly minimumBindingRunwayMs?: number;
  readonly now?: () => number;
}

export function verificationAttachmentBindingHasRunway(
  checkpoint: UploadCheckpoint,
  now: number,
  minimumRunwayMs = 0,
  expectedScope?: {
    readonly projectId: string;
    readonly clientSubmissionId: string;
    readonly targetQaItemId: string;
  },
): boolean {
  const binding = checkpoint.binding;
  const finalized = checkpoint.finalized;
  const expiresAt = binding === undefined ? Number.NaN : Date.parse(binding.expiresAt);
  return (
    binding !== undefined &&
    finalized !== undefined &&
    binding.status === "reserved" &&
    binding.intent === "verification_result" &&
    binding.attachmentId === finalized.attachmentId &&
    binding.clientAttachmentId === checkpoint.clientAttachmentId &&
    (expectedScope === undefined ||
      (binding.projectId === expectedScope.projectId &&
        binding.clientSubmissionId === expectedScope.clientSubmissionId &&
        binding.targetQaItemId === expectedScope.targetQaItemId)) &&
    Number.isSafeInteger(binding.leaseGeneration) &&
    binding.leaseGeneration >= 1 &&
    Number.isFinite(expiresAt) &&
    expiresAt > now &&
    expiresAt - now >= minimumRunwayMs
  );
}

function parseAttachmentBindingResponse(
  value: unknown,
  expected: {
    readonly bindingId?: string;
    readonly attachmentId: string;
    readonly projectId: string;
    readonly clientSubmissionId: string;
    readonly clientAttachmentId: string;
    readonly leaseGeneration: number;
    readonly intent: "bug_create" | "verification_result";
    readonly targetQaItemId: string | null;
    readonly expectedVersion: number;
  },
): AttachmentBindingResponse {
  const binding = requireRecord(value, "ATTACHMENT_BINDING");
  if (
    typeof binding.bindingId !== "string" ||
    binding.bindingId.length === 0 ||
    (expected.bindingId !== undefined && binding.bindingId !== expected.bindingId) ||
    binding.attachmentId !== expected.attachmentId ||
    binding.projectId !== expected.projectId ||
    binding.clientSubmissionId !== expected.clientSubmissionId ||
    binding.clientAttachmentId !== expected.clientAttachmentId ||
    binding.leaseGeneration !== expected.leaseGeneration ||
    binding.intent !== expected.intent ||
    binding.targetQaItemId !== expected.targetQaItemId ||
    binding.status !== "reserved" ||
    typeof binding.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(binding.expiresAt)) ||
    binding.version !== expected.expectedVersion + 1 ||
    typeof binding.replayed !== "boolean"
  ) {
    throw new QaHubApiError(200, "INVALID_ATTACHMENT_BINDING");
  }
  return binding as unknown as AttachmentBindingResponse;
}

/**
 * Keep a frozen Verification attachment identity alive without changing the
 * frozen result body. The server permits generation N+1 only after generation
 * N has expired; an active reservation is returned unchanged.
 */
export async function refreshVerificationAttachmentBinding(input: {
  readonly projectId: string;
  readonly bugId: string;
  readonly clientSubmissionId: string;
  readonly checkpoint: UploadCheckpoint;
  readonly saveCheckpoint?: (checkpoint: UploadCheckpoint) => Promise<void>;
  readonly scope?: RequestInit;
  readonly now?: () => number;
}): Promise<UploadCheckpoint> {
  const scope = input.scope ?? projectRequestSnapshot({}, input.projectId);
  const now = input.now ?? Date.now;
  const checkpoint = input.checkpoint;
  const finalized = checkpoint.finalized;
  const binding = checkpoint.binding;
  const expectedScope = {
    projectId: input.projectId,
    clientSubmissionId: input.clientSubmissionId,
    targetQaItemId: input.bugId,
  } as const;
  if (
    finalized === undefined ||
    binding === undefined ||
    binding.bindingId.length === 0 ||
    binding.attachmentId !== finalized.attachmentId ||
    binding.projectId !== expectedScope.projectId ||
    binding.clientSubmissionId !== expectedScope.clientSubmissionId ||
    binding.clientAttachmentId !== checkpoint.clientAttachmentId ||
    binding.intent !== "verification_result" ||
    binding.targetQaItemId !== expectedScope.targetQaItemId ||
    binding.status !== "reserved" ||
    !Number.isSafeInteger(binding.leaseGeneration) ||
    binding.leaseGeneration < 1 ||
    !Number.isSafeInteger(binding.version) ||
    binding.version !== finalized.version + binding.leaseGeneration ||
    !Number.isFinite(Date.parse(binding.expiresAt))
  ) {
    throw new QaHubApiError(409, "FROZEN_VERIFICATION_ATTACHMENT_CHECKPOINT_INVALID");
  }
  if (verificationAttachmentBindingHasRunway(checkpoint, now(), 0, expectedScope)) {
    return checkpoint;
  }

  const leaseGeneration = binding.leaseGeneration + 1;
  assertProjectRequest(scope);
  const rawBinding = await requestJson(
    `/api/v1/attachments/${encodeURIComponent(finalized.attachmentId)}/bind`,
    submissionRequest(
      {
        method: "POST",
        headers: {
          "Content-Type": APP_FIRST_API_MEDIA_TYPE,
          "Idempotency-Key": `submission:${input.clientSubmissionId}:attachment:${checkpoint.clientAttachmentId}:bind:${leaseGeneration}`,
        },
        body: JSON.stringify({
          submissionContractVersion: "1.1.0",
          expectedVersion: binding.version,
          projectId: input.projectId,
          clientSubmissionId: input.clientSubmissionId,
          clientAttachmentId: checkpoint.clientAttachmentId,
          leaseGeneration,
          intent: "verification_result",
          targetQaItemId: input.bugId,
        }),
      },
      scope,
      input.projectId,
    ),
    input.scope === undefined,
  );
  const refreshedBinding = parseAttachmentBindingResponse(rawBinding, {
    bindingId: binding.bindingId,
    attachmentId: finalized.attachmentId,
    projectId: input.projectId,
    clientSubmissionId: input.clientSubmissionId,
    clientAttachmentId: checkpoint.clientAttachmentId,
    leaseGeneration,
    intent: "verification_result",
    targetQaItemId: input.bugId,
    expectedVersion: binding.version,
  });
  const refreshed = { ...checkpoint, binding: refreshedBinding, bound: true };
  await input.saveCheckpoint?.(refreshed);
  assertProjectRequest(scope);
  if (!verificationAttachmentBindingHasRunway(refreshed, now(), 0, expectedScope)) {
    throw new QaHubApiError(409, "ATTACHMENT_BINDING_LEASE_TOO_SHORT");
  }
  return refreshed;
}

export async function uploadBugCreateAttachment(
  input: {
    readonly projectId: string;
    readonly clientSubmissionId: string;
    readonly file: File;
  } & DurableUploadOptions,
): Promise<string> {
  return uploadSubmissionAttachment({ ...input, intent: "bug_create" });
}

export async function uploadVerificationAttachment(
  input: {
    readonly projectId: string;
    readonly bugId: string;
    readonly clientSubmissionId: string;
    readonly file: File;
  } & DurableUploadOptions,
): Promise<string> {
  return uploadSubmissionAttachment({
    ...input,
    intent: "verification_result",
    targetQaItemId: input.bugId,
  });
}

async function uploadSubmissionAttachment(
  input: {
    readonly projectId: string;
    readonly clientSubmissionId: string;
    readonly file: File;
    readonly intent: "bug_create" | "verification_result";
    readonly targetQaItemId?: string;
  } & DurableUploadOptions,
  remainingFreshIdentityFallbacks = 1,
  forceFreshIdentity = false,
): Promise<string> {
  const scope = input.scope ?? projectRequestSnapshot({}, input.projectId);
  const now = input.now ?? Date.now;
  const minimumBindingRunwayMs = input.minimumBindingRunwayMs ?? 0;
  if (
    !Number.isSafeInteger(minimumBindingRunwayMs) ||
    minimumBindingRunwayMs < 0 ||
    minimumBindingRunwayMs > 10 * 60_000
  ) {
    throw new TypeError("minimumBindingRunwayMs must be an integer from 0 through 600000");
  }
  const currentSha256 = await sha256Hex(input.file);
  let retainedCheckpoint =
    !forceFreshIdentity && input.checkpoint?.sha256 === currentSha256
      ? input.checkpoint
      : undefined;
  let leaseFallbacksRemaining = remainingFreshIdentityFallbacks;
  if (
    input.intent === "verification_result" &&
    retainedCheckpoint !== undefined &&
    (retainedCheckpoint.binding !== undefined || retainedCheckpoint.bound === true) &&
    !verificationAttachmentBindingHasRunway(retainedCheckpoint, now(), minimumBindingRunwayMs, {
      projectId: input.projectId,
      clientSubmissionId: input.clientSubmissionId,
      targetQaItemId: input.targetQaItemId ?? "",
    })
  ) {
    // The server rejects renewal before expiry. Before the result is frozen we
    // can safely re-upload under a fresh identity to obtain enough lease runway.
    retainedCheckpoint = undefined;
    leaseFallbacksRemaining -= 1;
  }
  let checkpoint: UploadCheckpoint = retainedCheckpoint ?? {
    clientAttachmentId: crypto.randomUUID(),
    sha256: currentSha256,
    nextChunk: 0,
  };
  const save = async (patch: Partial<UploadCheckpoint>) => {
    checkpoint = { ...checkpoint, ...patch };
    await input.saveCheckpoint?.(checkpoint);
    assertProjectRequest(scope);
  };
  // Persist identity before the first request. This also replaces a same-metadata
  // file's stale checkpoint after its bytes produce a different digest.
  if (input.intent === "verification_result" && retainedCheckpoint === undefined) await save({});
  const clientAttachmentId = checkpoint.clientAttachmentId;
  const uploadAttempt = 1;
  const sha256 = currentSha256;
  assertProjectRequest(scope);
  const initBody =
    checkpoint.init ??
    ((await requestJson(
      "/api/v1/uploads/init",
      submissionRequest(
        {
          method: "POST",
          headers: {
            "Content-Type": "application/vnd.relay-qa-hub.v1.1+json",
            "Idempotency-Key": `submission:${input.clientSubmissionId}:attachment:${clientAttachmentId}:upload:${uploadAttempt}:init`,
          },
          body: JSON.stringify({
            submissionContractVersion: "1.1.0",
            projectId: input.projectId,
            clientSubmissionId: input.clientSubmissionId,
            clientAttachmentId,
            uploadAttempt,
            filename: input.file.name,
            mediaType: input.file.type || "application/octet-stream",
            expectedSize: input.file.size,
            sha256,
          }),
        },
        scope,
        input.projectId,
      ),
      input.scope === undefined,
    )) as UploadInitResponse);
  if (
    !initBody.sessionId ||
    !Number.isSafeInteger(initBody.chunkSize) ||
    initBody.chunkSize <= 0 ||
    !Number.isSafeInteger(initBody.version) ||
    initBody.version < 1
  )
    throw new QaHubApiError(200, "INVALID_UPLOAD_INIT");
  if (!checkpoint.init) await save({ init: initBody, version: initBody.version });

  let version = checkpoint.version ?? initBody.version;
  let chunkNumber = checkpoint.nextChunk;
  for (
    let offset = chunkNumber * initBody.chunkSize;
    offset < input.file.size;
    offset += initBody.chunkSize
  ) {
    const chunk = input.file.slice(offset, Math.min(input.file.size, offset + initBody.chunkSize));
    const chunkSha256 = await sha256Hex(chunk);
    assertProjectRequest(scope);
    const response = await fetchWithTimeout(
      `/api/v1/uploads/${encodeURIComponent(initBody.sessionId)}/chunks/${chunkNumber}`,
      submissionRequest(
        {
          method: "PUT",
          credentials: "same-origin",
          headers: {
            Accept: "application/vnd.relay-qa-hub.v1.1+json",
            "Content-Type": "application/octet-stream",
            "Idempotency-Key": `submission:${input.clientSubmissionId}:attachment:${clientAttachmentId}:upload:${uploadAttempt}:chunk:${chunkNumber}`,
            "If-Match": `"${version}"`,
            "X-Chunk-SHA256": chunkSha256,
            "X-Client-Submission-Id": input.clientSubmissionId,
            "X-Client-Attachment-Id": clientAttachmentId,
            ...csrfHeadersForMutation(),
          },
          body: chunk,
        },
        scope,
        input.projectId,
      ),
      API_TRANSFER_TIMEOUT_MS,
    );
    if (!response.ok) {
      const errorBody: unknown = await response.json().catch(() => null);
      throw new QaHubApiError(response.status, readErrorCode(errorBody));
    }
    const nextVersion = Number(response.headers.get("x-upload-version"));
    // A duplicate chunk returns the session's current version, which may already
    // include other chunks from a second window. Equal is a valid replay; older is not.
    if (!Number.isSafeInteger(nextVersion) || nextVersion < version) {
      throw new QaHubApiError(200, "INVALID_UPLOAD_VERSION");
    }
    version = nextVersion;
    chunkNumber += 1;
    await save({ nextChunk: chunkNumber, version });
  }

  const finalized =
    checkpoint.finalized ??
    ((await requestJson(
      `/api/v1/uploads/${encodeURIComponent(initBody.sessionId)}/finalize`,
      submissionRequest(
        {
          method: "POST",
          headers: {
            "Content-Type": "application/vnd.relay-qa-hub.v1.1+json",
            "Idempotency-Key": `submission:${input.clientSubmissionId}:attachment:${clientAttachmentId}:upload:${uploadAttempt}:finalize`,
          },
          body: JSON.stringify({
            submissionContractVersion: "1.1.0",
            expectedVersion: version,
            clientSubmissionId: input.clientSubmissionId,
            clientAttachmentId,
            uploadAttempt,
            sha256,
            expectedSize: input.file.size,
          }),
        },
        scope,
        input.projectId,
      ),
      input.scope === undefined,
    )) as UploadFinalizeResponse);
  if (!finalized.readyToBind) throw new QaHubApiError(409, "ATTACHMENT_NOT_READY");
  if (!finalized.attachmentId || !Number.isSafeInteger(finalized.version) || finalized.version < 1)
    throw new QaHubApiError(200, "INVALID_UPLOAD_FINALIZE");
  if (!checkpoint.finalized) await save({ finalized });

  const hasActiveBinding =
    input.intent === "verification_result"
      ? verificationAttachmentBindingHasRunway(checkpoint, now(), minimumBindingRunwayMs, {
          projectId: input.projectId,
          clientSubmissionId: input.clientSubmissionId,
          targetQaItemId: input.targetQaItemId ?? "",
        })
      : checkpoint.binding !== undefined || checkpoint.bound === true;
  if (!hasActiveBinding && input.deferBinding !== true) {
    const rawBinding = await requestJson(
      `/api/v1/attachments/${encodeURIComponent(finalized.attachmentId)}/bind`,
      submissionRequest(
        {
          method: "POST",
          headers: {
            "Content-Type": "application/vnd.relay-qa-hub.v1.1+json",
            "Idempotency-Key": `submission:${input.clientSubmissionId}:attachment:${clientAttachmentId}:bind:1`,
          },
          body: JSON.stringify({
            submissionContractVersion: "1.1.0",
            expectedVersion: finalized.version,
            projectId: input.projectId,
            clientSubmissionId: input.clientSubmissionId,
            clientAttachmentId,
            leaseGeneration: 1,
            intent: input.intent,
            ...(input.targetQaItemId ? { targetQaItemId: input.targetQaItemId } : {}),
          }),
        },
        scope,
        input.projectId,
      ),
      input.scope === undefined,
    );
    if (input.intent === "bug_create") {
      await save({ bound: true });
      return finalized.attachmentId;
    }
    const expectedTarget = input.targetQaItemId ?? null;
    const typedBinding = parseAttachmentBindingResponse(rawBinding, {
      attachmentId: finalized.attachmentId,
      projectId: input.projectId,
      clientSubmissionId: input.clientSubmissionId,
      clientAttachmentId,
      leaseGeneration: 1,
      intent: input.intent,
      targetQaItemId: expectedTarget,
      expectedVersion: finalized.version,
    });
    await save({ binding: typedBinding, bound: true });
    if (
      input.intent === "verification_result" &&
      !verificationAttachmentBindingHasRunway(
        { ...checkpoint, binding: typedBinding },
        now(),
        minimumBindingRunwayMs,
      )
    ) {
      if (leaseFallbacksRemaining > 0) {
        return uploadSubmissionAttachment(input, leaseFallbacksRemaining - 1, true);
      }
      throw new QaHubApiError(409, "ATTACHMENT_BINDING_LEASE_TOO_SHORT");
    }
  }
  return finalized.attachmentId;
}

export async function updateBugModule(
  bugId: string,
  expectedVersion: number,
  moduleId: string | null,
): Promise<BugDetail> {
  const body = await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `web:updateBug:bug:${bugId}:v${expectedVersion}:module:${moduleId ?? "null"}`,
    },
    body: JSON.stringify({ expectedVersion, moduleId }),
  });
  return requireRecord(body, "BUG") as unknown as BugDetail;
}

export async function transitionBugReady(
  bugId: string,
  expectedVersion: number,
): Promise<BugDetail> {
  const body = await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}/transitions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `workflow:transitionBug:bug:${bugId}:v${expectedVersion}:ready`,
    },
    body: JSON.stringify({ expectedVersion, toState: "ready" }),
  });
  return requireRecord(body, "BUG") as unknown as BugDetail;
}

export async function manuallyCompleteBug(
  bugId: string,
  expectedVersion: number,
): Promise<BugDetail> {
  const body = await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}/manual-complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `workflow:manualCompleteBug:bug:${bugId}:v${expectedVersion}`,
    },
    body: JSON.stringify({ expectedVersion, reason: "人工确认修复完成，提交原验收人验收" }),
  });
  return requireRecord(body, "BUG") as unknown as BugDetail;
}

export async function completeBugForVerification(
  bugId: string,
  expectedVersion: number,
  repairAttemptId: string,
): Promise<BugDetail> {
  const body = await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `workflow:completeBug:bug:${bugId}:v${expectedVersion}`,
    },
    body: JSON.stringify({
      expectedVersion,
      repairAttemptId,
      reason: "任务已完成，进入人工验收；构建仅保留为可选进度记录",
    }),
  });
  return requireRecord(body, "BUG") as unknown as BugDetail;
}

export async function listBugEvents(bugId: string): Promise<BugEventsResponse> {
  return listCompleteBugTimeline({
    bugId,
    resource: "events",
    pageSize: 20,
    invalidCode: "INVALID_EVENTS",
    cursorCode: "INVALID_EVENT_CURSOR",
    snapshotCode: "INVALID_EVENT_SNAPSHOT",
    tooLargeCode: "EVENT_HISTORY_TOO_LARGE",
    validateItem: isBugEvent,
  });
}

export async function addBugComment(
  bugId: string,
  body: string,
  clientSubmissionId: string,
  scope?: RequestInit,
  frozenBody?: string,
): Promise<CommentCreationResponse> {
  const response = await requestJson(
    `/api/v1/bugs/${encodeURIComponent(bugId)}/comments`,
    submissionRequest(
      {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.relay-qa-hub.v1.1+json",
          "Idempotency-Key": `comment:${bugId}:${clientSubmissionId}`,
          "X-Correlation-ID": clientSubmissionId,
        },
        body: frozenBody ?? JSON.stringify({ clientSubmissionId, body }),
      },
      scope,
    ),
    scope === undefined,
  );
  const record = requireRecord(response, "COMMENT");
  if (typeof record.comment !== "object" || record.comment === null) {
    throw new QaHubApiError(201, "INVALID_COMMENT");
  }
  if (record.correlationId !== clientSubmissionId) {
    throw new QaHubApiError(201, "INVALID_COMMENT_CORRELATION");
  }
  return response as CommentCreationResponse;
}

export async function createRelayAttempt(
  bugId: string,
  expectedVersion: number,
  assigneeId: string,
): Promise<RelayRepairAttempt> {
  const body = await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}/repair-attempts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `workflow:createRepairAttempt:bug:${bugId}:v${expectedVersion}`,
    },
    body: JSON.stringify({
      expectedVersion,
      mode: "relay",
      assigneeId,
      summary: "Desktop QA Hub Relay handoff",
    }),
  });
  return requireRecord(body, "RELAY_ATTEMPT") as unknown as RelayRepairAttempt;
}

export async function dispatchRelay(
  attemptId: string,
  expectedVersion: number,
  handoffId: string,
  selectedAttachmentIds: readonly string[] = [],
): Promise<RelayDispatchAccepted> {
  const body = await requestJson(
    `/api/v1/repair-attempts/${encodeURIComponent(attemptId)}/dispatch/relay`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `relay:dispatch:${handoffId}`,
      },
      body: JSON.stringify({ expectedVersion, handoffId, selectedAttachmentIds }),
    },
  );
  return requireRecord(body, "RELAY_DISPATCH") as unknown as RelayDispatchAccepted;
}

export async function getRelayReceipt(attemptId: string): Promise<RelayReceipt> {
  const body = await requestJson(
    `/api/v1/repair-attempts/${encodeURIComponent(attemptId)}/relay-receipt`,
  );
  return requireRecord(body, "RELAY_RECEIPT") as unknown as RelayReceipt;
}

export async function createHumanRepairAttempt(
  bugId: string,
  expectedVersion: number,
  assigneeId: string,
  summary: string,
): Promise<HumanRepairAttempt> {
  const body = await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}/repair-attempts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `workflow:createRepairAttempt:bug:${bugId}:v${expectedVersion}`,
    },
    body: JSON.stringify({ expectedVersion, mode: "human", assigneeId, summary }),
  });
  return requireRecord(body, "HUMAN_ATTEMPT") as unknown as HumanRepairAttempt;
}

export async function getHumanRepairAttempt(attemptId: string): Promise<HumanRepairAttempt> {
  const body = await requestJson(`/api/v1/repair-attempts/${encodeURIComponent(attemptId)}`);
  return requireRecord(body, "HUMAN_ATTEMPT") as unknown as HumanRepairAttempt;
}

export async function startHumanRepairAttempt(
  attemptId: string,
  expectedVersion: number,
): Promise<HumanRepairAttempt> {
  const body = await requestJson(`/api/v1/repair-attempts/${encodeURIComponent(attemptId)}/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `workflow:startRepairAttempt:attempt:${attemptId}:v${expectedVersion}`,
    },
    body: JSON.stringify({ expectedVersion, reason: "Developer started the Web-managed repair" }),
  });
  return requireRecord(body, "HUMAN_ATTEMPT") as unknown as HumanRepairAttempt;
}

export async function deliverHumanRepairAttempt(
  attemptId: string,
  expectedVersion: number,
  summary: string,
  branch: string,
  commitSha: string,
): Promise<HumanRepairAttempt> {
  const body = await requestJson(
    `/api/v1/repair-attempts/${encodeURIComponent(attemptId)}/deliver`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `workflow:deliverRepairAttempt:attempt:${attemptId}:v${expectedVersion}`,
      },
      body: JSON.stringify({ expectedVersion, summary, deliveryKind: "code", branch, commitSha }),
    },
  );
  return requireRecord(body, "HUMAN_ATTEMPT") as unknown as HumanRepairAttempt;
}

export async function deliverHumanRepairAttemptNoCode(
  attemptId: string,
  expectedVersion: number,
  summary: string,
  noCodeReason: string,
): Promise<HumanRepairAttempt> {
  const body = await requestJson(
    `/api/v1/repair-attempts/${encodeURIComponent(attemptId)}/deliver`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `workflow:deliverRepairAttempt:attempt:${attemptId}:v${expectedVersion}`,
      },
      body: JSON.stringify({ expectedVersion, summary, deliveryKind: "no_code", noCodeReason }),
    },
  );
  return requireRecord(body, "HUMAN_ATTEMPT") as unknown as HumanRepairAttempt;
}

export async function failRepairAttempt(
  attemptId: string,
  expectedVersion: number,
  reason: string,
): Promise<RepairAttempt> {
  const body = await requestJson(`/api/v1/repair-attempts/${encodeURIComponent(attemptId)}/fail`, {
    method: "POST",
    headers: {
      Accept: APP_FIRST_API_MEDIA_TYPE,
      "Content-Type": APP_FIRST_API_MEDIA_TYPE,
      "Idempotency-Key": `workflow:failRepairAttempt:attempt:${attemptId}:v${expectedVersion}`,
    },
    body: JSON.stringify({ expectedVersion, reason }),
  });
  return requireRecord(body, "REPAIR_ATTEMPT") as unknown as RepairAttempt;
}

export async function supersedeRepairAttempt(input: {
  readonly attemptId: string;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly successor: {
    readonly id: string;
    readonly mode: RepairMode;
    readonly assigneeId: string;
    readonly summary?: string;
  };
}): Promise<SupersedeRepairAttemptResponse> {
  const body = await requestJson(
    `/api/v1/repair-attempts/${encodeURIComponent(input.attemptId)}/supersede`,
    {
      method: "POST",
      headers: {
        Accept: APP_FIRST_API_MEDIA_TYPE,
        "Content-Type": APP_FIRST_API_MEDIA_TYPE,
        "Idempotency-Key": `workflow:supersedeRepairAttempt:attempt:${input.attemptId}:v${input.expectedVersion}`,
      },
      body: JSON.stringify({
        expectedVersion: input.expectedVersion,
        reason: input.reason,
        successor: input.successor,
      }),
    },
  );
  const record = requireRecord(body, "REPAIR_ATTEMPT_SUPERSEDE");
  if (
    typeof record.supersededAttempt !== "object" ||
    record.supersededAttempt === null ||
    typeof record.successorAttempt !== "object" ||
    record.successorAttempt === null ||
    typeof record.bug !== "object" ||
    record.bug === null ||
    typeof record.eventId !== "string" ||
    typeof record.replayed !== "boolean"
  ) {
    throw new QaHubApiError(200, "INVALID_REPAIR_ATTEMPT_SUPERSEDE");
  }
  return record as unknown as SupersedeRepairAttemptResponse;
}

export async function registerManualBuild(input: {
  readonly projectId: string;
  readonly externalId: string;
  readonly version: string;
  readonly branch: string;
  readonly sourceCommitSha: string;
  readonly downloadUrl: string;
  readonly artifactSha256: string;
  readonly repairAttemptId: string;
}): Promise<RegisterBuildResponse> {
  const body = await requestJson(`/api/v1/projects/${encodeURIComponent(input.projectId)}/builds`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `build:register:project:${input.projectId}:provider:manual:external:${input.externalId}`,
    },
    body: JSON.stringify({
      provider: "manual",
      externalId: input.externalId,
      version: input.version,
      channel: "qa",
      projectKey: "LOCAL",
      branch: input.branch,
      sourceCommitSha: input.sourceCommitSha,
      mode: "debug",
      status: "ready",
      downloadUrl: input.downloadUrl,
      manifest: {
        commitShas: [input.sourceCommitSha],
        artifactSha256: input.artifactSha256,
      },
      repairAttemptId: input.repairAttemptId,
    }),
  });
  return requireRecord(body, "BUILD_REGISTRATION") as unknown as RegisterBuildResponse;
}

export async function getBuild(buildId: string): Promise<BuildRecord> {
  const body = await requestJson(`/api/v1/builds/${encodeURIComponent(buildId)}`);
  return requireRecord(body, "BUILD") as unknown as BuildRecord;
}

export async function linkBuildRepair(input: {
  readonly buildId: string;
  readonly expectedBuildVersion: number;
  readonly expectedBugVersion: number;
  readonly repairAttemptId: string;
  readonly deliveredCommitSha: string;
}): Promise<LinkBuildRepairResponse> {
  const body = await requestJson(
    `/api/v1/builds/${encodeURIComponent(input.buildId)}/link-repair`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `build:link:${input.buildId}:attempt:${input.repairAttemptId}:v${input.expectedBuildVersion}`,
      },
      body: JSON.stringify({
        expectedVersion: input.expectedBuildVersion,
        expectedBugVersion: input.expectedBugVersion,
        expectedBuildRequirementVersion: 1,
        repairAttemptId: input.repairAttemptId,
        deliveredCommitSha: input.deliveredCommitSha,
        evidenceType: "manifest",
      }),
    },
  );
  return requireRecord(body, "BUILD_LINK") as unknown as LinkBuildRepairResponse;
}

export async function createVerification(input: {
  readonly bugId: string;
  readonly expectedBugVersion: number;
  readonly repairAttemptId: string;
  readonly buildId: string | null;
  readonly verifierId: string;
  readonly criteria: string;
}): Promise<VerificationRecord> {
  const body = await requestJson(`/api/v1/bugs/${encodeURIComponent(input.bugId)}/verifications`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `workflow:createVerification:bug:${input.bugId}:attempt:${input.repairAttemptId}:v${input.expectedBugVersion}`,
    },
    body: JSON.stringify({
      expectedVersion: input.expectedBugVersion,
      repairAttemptId: input.repairAttemptId,
      buildId: input.buildId,
      verifierId: input.verifierId,
      criteria: input.criteria,
    }),
  });
  const verification = requireRecord(body, "VERIFICATION") as unknown as VerificationRecord;
  if (
    !verificationRecordMatchesIdentity(verification, {
      bugId: input.bugId,
      repairAttemptId: input.repairAttemptId,
      verifierId: input.verifierId,
    }) ||
    verification.buildId !== input.buildId ||
    verification.criteriaSnapshot !== input.criteria ||
    verification.status !== "requested" ||
    verification.resultSummary !== null ||
    verification.version !== 1
  ) {
    throw new QaHubApiError(200, "VERIFICATION_CREATE_RESPONSE_MISMATCH");
  }
  return verification;
}

export async function getVerification(
  verificationId: string,
  expected: VerificationOwnershipExpectation,
): Promise<VerificationRecord> {
  const body = await requestJson(`/api/v1/verifications/${encodeURIComponent(verificationId)}`);
  const verification = requireRecord(body, "VERIFICATION") as unknown as VerificationRecord;
  if (!verificationRecordMatchesIdentity(verification, { ...expected, verificationId })) {
    throw new QaHubApiError(200, "VERIFICATION_READBACK_SCOPE_MISMATCH");
  }
  return verification;
}

export async function startVerification(
  verificationId: string,
  expectedVersion: number,
  expected: VerificationOwnershipExpectation,
): Promise<VerificationRecord> {
  const body = await requestJson(
    `/api/v1/verifications/${encodeURIComponent(verificationId)}/start`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `workflow:startVerification:verification:${verificationId}:v${expectedVersion}`,
      },
      body: JSON.stringify({
        expectedVersion,
        reason: "Human verifier started exact-Build acceptance",
      }),
    },
  );
  const verification = requireRecord(body, "VERIFICATION") as unknown as VerificationRecord;
  if (
    !verificationRecordMatchesIdentity(verification, { ...expected, verificationId }) ||
    verification.status !== "in_progress" ||
    verification.version !== expectedVersion + 1
  ) {
    throw new QaHubApiError(200, "VERIFICATION_START_RESPONSE_MISMATCH");
  }
  return verification;
}

export async function recordVerificationPassed(
  verificationId: string,
  expectedVersion: number,
  resultSummary: string,
  clientSubmissionId: string,
  attachmentIds: readonly string[] = [],
  captureBundleId: string | null = null,
): Promise<VerificationResultResponse> {
  return recordVerificationResult({
    verificationId,
    expectedVersion,
    resultSummary,
    clientSubmissionId,
    status: "passed",
    attachmentIds,
    captureBundleId,
  });
}

export async function recordVerificationFailed(
  verificationId: string,
  expectedVersion: number,
  resultSummary: string,
  failureReason: string,
  clientSubmissionId: string,
  attachmentIds: readonly string[] = [],
  captureBundleId: string | null = null,
): Promise<VerificationResultResponse> {
  return recordVerificationResult({
    verificationId,
    expectedVersion,
    resultSummary,
    clientSubmissionId,
    status: "failed",
    failureReason,
    attachmentIds,
    captureBundleId,
  });
}

export async function recordVerificationBlocked(
  verificationId: string,
  expectedVersion: number,
  resultSummary: string,
  blockedReason: string,
  clientSubmissionId: string,
  attachmentIds: readonly string[] = [],
  captureBundleId: string | null = null,
): Promise<VerificationResultResponse> {
  return recordVerificationResult({
    verificationId,
    expectedVersion,
    resultSummary,
    clientSubmissionId,
    status: "blocked",
    blockedReason,
    attachmentIds,
    captureBundleId,
  });
}

export type VerificationOutcome = "passed" | "failed" | "blocked";

export type VerificationResultCommand = {
  readonly verificationId: string;
  readonly expectedVersion: number;
  readonly resultSummary: string;
  readonly clientSubmissionId: string;
  readonly attachmentIds: readonly string[];
  readonly captureBundleId: string | null;
} & (
  | { readonly status: "passed" }
  | { readonly status: "failed"; readonly failureReason: string }
  | { readonly status: "blocked"; readonly blockedReason: string }
);

export type FrozenVerificationResultRequest = VerificationResultCommand & {
  readonly requestBody: string;
};

function verificationResultRequestBody(input: VerificationResultCommand): string {
  return JSON.stringify({
    submissionContractVersion: "1.1.0",
    clientSubmissionId: input.clientSubmissionId,
    expectedVersion: input.expectedVersion,
    status: input.status,
    resultSummary: input.resultSummary,
    ...(input.status === "failed" ? { failureReason: input.failureReason } : {}),
    ...(input.status === "blocked" ? { blockedReason: input.blockedReason } : {}),
    attachmentIds: input.attachmentIds,
    ...(input.captureBundleId === null ? {} : { captureBundleId: input.captureBundleId }),
  });
}

export function freezeVerificationResultRequest(
  input: VerificationResultCommand,
): FrozenVerificationResultRequest {
  const frozenInput = {
    ...input,
    // The receipt projects evidence in attachment-id order. Freeze the request in
    // that same canonical order so a matching committed result can be compared byte-for-byte.
    attachmentIds: Object.freeze([...input.attachmentIds].sort()),
  } as VerificationResultCommand;
  return Object.freeze({
    ...frozenInput,
    requestBody: verificationResultRequestBody(frozenInput),
  });
}

export function verificationRecordMatchesIdentity(
  value: unknown,
  expected: VerificationOwnershipExpectation & { readonly verificationId?: string },
): value is VerificationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const verification = value as Record<string, unknown>;
  return (
    typeof verification["id"] === "string" &&
    UUID_PATTERN.test(verification["id"]) &&
    (expected.verificationId === undefined || verification["id"] === expected.verificationId) &&
    verification["bugId"] === expected.bugId &&
    verification["repairAttemptId"] === expected.repairAttemptId &&
    verification["verifierId"] === expected.verifierId
  );
}

export function verificationResultReceiptMatches(
  frozen: FrozenVerificationResultRequest,
  response: VerificationResultResponse,
  expected: VerificationResultExpectation,
): boolean {
  const terminalProjectionMatches =
    frozen.status === "passed"
      ? response.bug.state === "closed" && response.repairAttempt.status === "delivered"
      : frozen.status === "failed"
        ? response.bug.state === "ready" && response.repairAttempt.status === "verification_failed"
        : response.bug.state === "ready_for_verification" &&
          response.repairAttempt.status === "delivered";
  return (
    expected.verificationId === frozen.verificationId &&
    response.clientSubmissionId === frozen.clientSubmissionId &&
    verificationRecordMatchesIdentity(response.verification, expected) &&
    response.verification.status === frozen.status &&
    response.verification.resultSummary === frozen.resultSummary &&
    response.verification.version === frozen.expectedVersion + 1 &&
    response.qaItem.type === "bug" &&
    response.qaItem.id === expected.bugId &&
    response.qaItem.key === response.bug.key &&
    response.bug.id === expected.bugId &&
    response.bug.projectId === expected.projectId &&
    response.repairAttempt.id === expected.repairAttemptId &&
    response.repairAttempt.bugId === expected.bugId &&
    terminalProjectionMatches &&
    response.attachmentIds.length === frozen.attachmentIds.length &&
    response.attachmentIds.every((id, index) => id === frozen.attachmentIds[index]) &&
    response.captureBundleId === frozen.captureBundleId &&
    typeof response.eventId === "string" &&
    response.eventId.length > 0 &&
    typeof response.replayed === "boolean"
  );
}

export function verificationResultReadbackMatches(
  frozen: FrozenVerificationResultRequest,
  verification: VerificationRecord,
  expected: VerificationIdentityExpectation,
): boolean {
  return (
    expected.verificationId === frozen.verificationId &&
    verificationRecordMatchesIdentity(verification, expected) &&
    verification.status === frozen.status &&
    verification.resultSummary === frozen.resultSummary &&
    verification.failureReason === (frozen.status === "failed" ? frozen.failureReason : null) &&
    verification.blockedReason === (frozen.status === "blocked" ? frozen.blockedReason : null) &&
    verification.version === frozen.expectedVersion + 1
  );
}

export async function recordFrozenVerificationResult(
  frozen: FrozenVerificationResultRequest,
): Promise<VerificationResultResponse> {
  if (frozen.requestBody !== verificationResultRequestBody(frozen)) {
    throw new QaHubApiError(400, "FROZEN_VERIFICATION_RESULT_MISMATCH");
  }
  const body = await requestJson(
    `/api/v1/verifications/${encodeURIComponent(frozen.verificationId)}/result`,
    {
      method: "POST",
      headers: {
        "Content-Type": APP_FIRST_API_MEDIA_TYPE,
        "Idempotency-Key": `workflow:recordVerificationResult:verification:${frozen.verificationId}:v${frozen.expectedVersion}`,
      },
      body: frozen.requestBody,
    },
  );
  return requireRecord(body, "VERIFICATION_RESULT") as unknown as VerificationResultResponse;
}

async function recordVerificationResult(
  input: VerificationResultCommand,
): Promise<VerificationResultResponse> {
  return recordFrozenVerificationResult(freezeVerificationResultRequest(input));
}

export async function getQingyuSession(): Promise<QingyuSession> {
  return (await requestJson("/api/v1/integrations/qingyu/session")) as QingyuSession;
}

export async function startQingyuLogin(): Promise<QingyuSession> {
  return (await requestJson("/api/v1/integrations/qingyu/login/start", {
    method: "POST",
  })) as QingyuSession;
}

export async function pollQingyuLogin(): Promise<QingyuSession> {
  return (await requestJson("/api/v1/integrations/qingyu/login/status")) as QingyuSession;
}

export async function logoutQingyu(): Promise<QingyuSession> {
  return (await requestJson("/api/v1/integrations/qingyu/logout", {
    method: "POST",
  })) as QingyuSession;
}

export async function listQingyuProjects(): Promise<readonly QingyuProject[]> {
  return (await requestJson("/api/v1/integrations/qingyu/projects")) as readonly QingyuProject[];
}

export async function listOwnQingyuDefects(
  externalProjectId: string,
): Promise<{ readonly defects: readonly QingyuDefect[]; readonly total: number }> {
  return (await requestJson(
    `/api/v1/integrations/qingyu/defects?projectId=${encodeURIComponent(externalProjectId)}`,
  )) as { readonly defects: readonly QingyuDefect[]; readonly total: number };
}

export async function importOwnQingyuDefects(
  externalProjectId: string,
  defectIds?: readonly string[],
): Promise<QingyuImportResult> {
  return (await requestJson("/api/v1/integrations/qingyu/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: externalProjectId,
      ...(defectIds === undefined ? {} : { defectIds }),
    }),
  })) as QingyuImportResult;
}

export async function getQingyuBugLink(bugId: string): Promise<QingyuBugLink | null> {
  const body = requireRecord(
    await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}/integrations/qingyu`),
    "QINGYU_BUG_LINK",
  );
  return (body["link"] ?? null) as QingyuBugLink | null;
}
