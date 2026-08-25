export interface BugListItem {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly state: string;
  readonly severity: string;
  readonly priority: string;
  readonly updatedAt: string;
}

export interface BugListResponse {
  readonly snapshotSequence: number;
  readonly items: readonly BugListItem[];
  readonly nextCursor: null;
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

export async function listBugs(projectId: string, signal?: AbortSignal): Promise<BugListResponse> {
  const query = new URLSearchParams({ projectId, limit: "20" });
  const body = await requestJson(`/api/v1/bugs?${query.toString()}`, {
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isBugListResponse(body)) throw new QaHubApiError(200, "INVALID_RESPONSE");
  return body;
}

export async function getBug(bugId: string): Promise<BugDetail> {
  const body = requireRecord(await requestJson(`/api/v1/bugs/${encodeURIComponent(bugId)}`), "BUG");
  return body as unknown as BugDetail;
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
