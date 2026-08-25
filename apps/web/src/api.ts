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

export type BugSeverity = "S0" | "S1" | "S2" | "S3" | "S4";

export interface BugListFilters {
  readonly q?: string;
  readonly state?: BugListState;
  readonly severity?: BugSeverity;
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
  readonly nextCursor: null;
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
  readonly nextCursor: null;
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

export interface BugListItem {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly state: BugListState;
  readonly severity: BugSeverity;
  readonly priority: string;
  readonly updatedAt: string;
}

export interface BugListResponse {
  readonly snapshotSequence: number;
  readonly items: readonly BugListItem[];
  readonly nextCursor: null;
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

export interface BugDetail extends BugListItem {
  readonly projectId: string;
  readonly number: number;
  readonly description: string;
  readonly expectedBehavior: string;
  readonly moduleId: string | null;
  readonly ownerId: string | null;
  readonly verificationOwnerId: string | null;
  readonly duplicateOfBugId: string | null;
  readonly occurrenceCount: number;
  readonly reopenCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly closedAt: string | null;
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
  readonly schemaVersion: "1.0";
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
}

export interface RelayRepairAttempt {
  readonly id: string;
  readonly bugId: string;
  readonly sequence: number;
  readonly mode: "relay";
  readonly status: "planned";
  readonly assigneeId: string;
  readonly version: number;
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

export interface HumanRepairAttempt {
  readonly id: string;
  readonly bugId: string;
  readonly sequence: number;
  readonly mode: "human";
  readonly status: "planned" | "running" | "delivered";
  readonly assigneeId: string;
  readonly summary: string | null;
  readonly branch: string | null;
  readonly commitSha: string | null;
  readonly version: number;
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
  readonly bugId: string;
  readonly repairAttempt: HumanRepairAttempt | null;
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
  readonly version: number;
}

export interface VerificationResultResponse {
  readonly clientSubmissionId: string;
  readonly qaItem: { readonly type: "bug"; readonly id: string; readonly key: string };
  readonly verification: VerificationRecord;
  readonly repairAttempt: HumanRepairAttempt;
  readonly bug: BugDetail;
  readonly attachmentIds: readonly string[];
  readonly captureBundleId: string | null;
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

function isBugListResponse(value: unknown): value is BugListResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as { readonly snapshotSequence?: unknown; readonly items?: unknown };
  return Number.isSafeInteger(response.snapshotSequence) && Array.isArray(response.items);
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

function isVisibleProjectList(value: unknown): value is VisibleProjectList {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as { readonly snapshotSequence?: unknown; readonly items?: unknown };
  return Number.isSafeInteger(response.snapshotSequence) && Array.isArray(response.items);
}

function isProjectScopedList(value: unknown, projectId: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as { readonly projectId?: unknown; readonly items?: unknown };
  return response.projectId === projectId && Array.isArray(response.items);
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

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/vnd.relay-qa-hub.v1.1+json",
      ...(init?.headers ?? {}),
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new QaHubApiError(response.status, readErrorCode(body));
  return body;
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
): Promise<BugListResponse> {
  const query = new URLSearchParams({ projectId, limit: "20" });
  if (filters.q !== undefined) query.set("q", filters.q);
  if (filters.state !== undefined) query.set("state", filters.state);
  if (filters.severity !== undefined) query.set("severity", filters.severity);
  const body = await requestJson(`/api/v1/bugs?${query.toString()}`, {
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isBugListResponse(body)) throw new QaHubApiError(200, "INVALID_RESPONSE");
  return body;
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
  const body = await requestJson("/api/v1/projects?limit=50");
  if (!isVisibleProjectList(body)) throw new QaHubApiError(200, "INVALID_PROJECT_LIST");
  return body;
}

export async function listProjectMembers(projectId: string): Promise<ProjectMemberList> {
  const body = await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/members?limit=100`,
  );
  if (!isProjectScopedList(body, projectId)) {
    throw new QaHubApiError(200, "INVALID_PROJECT_MEMBER_LIST");
  }
  return body as unknown as ProjectMemberList;
}

export async function listProjectModules(projectId: string): Promise<ProjectModuleList> {
  const body = await requestJson(`/api/v1/projects/${encodeURIComponent(projectId)}/modules`);
  if (!isProjectScopedList(body, projectId)) {
    throw new QaHubApiError(200, "INVALID_PROJECT_MODULE_LIST");
  }
  return body as unknown as ProjectModuleList;
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
  const response = await fetch(`/api/v1/attachments/${encodeURIComponent(metadata.attachmentId)}`, {
    headers: { Accept: "application/octet-stream" },
  });
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
  const response = await fetch(
    `/api/v1/bugs/${encodeURIComponent(bugId)}/capture-bundles/${encodeURIComponent(
      captureId,
    )}/artifacts/${encodeURIComponent(artifactKind)}`,
    { headers: { Accept: "application/octet-stream" } },
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

export async function listBugEvents(bugId: string): Promise<BugEventsResponse> {
  const body = requireRecord(
    await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}/events?limit=20`),
    "EVENTS",
  );
  if (!Array.isArray(body.items)) throw new QaHubApiError(200, "INVALID_EVENTS");
  return body as unknown as BugEventsResponse;
}

export async function addBugComment(
  bugId: string,
  body: string,
  clientSubmissionId: string,
): Promise<CommentCreationResponse> {
  const response = await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.relay-qa-hub.v1.1+json",
      "Idempotency-Key": `comment:${bugId}:${clientSubmissionId}`,
    },
    body: JSON.stringify({ clientSubmissionId, body }),
  });
  const record = requireRecord(response, "COMMENT");
  if (typeof record.comment !== "object" || record.comment === null) {
    throw new QaHubApiError(201, "INVALID_COMMENT");
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
): Promise<RelayDispatchAccepted> {
  const body = await requestJson(
    `/api/v1/repair-attempts/${encodeURIComponent(attemptId)}/dispatch/relay`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `relay:dispatch:${handoffId}`,
      },
      body: JSON.stringify({ expectedVersion, handoffId, selectedAttachmentIds: [] }),
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
  readonly buildId: string;
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
  return requireRecord(body, "VERIFICATION") as unknown as VerificationRecord;
}

export async function getVerification(verificationId: string): Promise<VerificationRecord> {
  const body = await requestJson(`/api/v1/verifications/${encodeURIComponent(verificationId)}`);
  return requireRecord(body, "VERIFICATION") as unknown as VerificationRecord;
}

export async function startVerification(
  verificationId: string,
  expectedVersion: number,
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
  return requireRecord(body, "VERIFICATION") as unknown as VerificationRecord;
}

export async function recordVerificationPassed(
  verificationId: string,
  expectedVersion: number,
  resultSummary: string,
  clientSubmissionId: string,
): Promise<VerificationResultResponse> {
  const body = await requestJson(
    `/api/v1/verifications/${encodeURIComponent(verificationId)}/result`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.relay-qa-hub.v1.1+json",
        "Idempotency-Key": `workflow:recordVerificationResult:verification:${verificationId}:v${expectedVersion}`,
      },
      body: JSON.stringify({
        submissionContractVersion: "1.1.0",
        clientSubmissionId,
        expectedVersion,
        status: "passed",
        resultSummary,
        attachmentIds: [],
      }),
    },
  );
  return requireRecord(body, "VERIFICATION_RESULT") as unknown as VerificationResultResponse;
}
