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

export async function listBugs(projectId: string, signal?: AbortSignal): Promise<BugListResponse> {
  const query = new URLSearchParams({ projectId, limit: "20" });
  const response = await fetch(`/api/v1/bugs?${query.toString()}`, {
    headers: { Accept: "application/vnd.relay-qa-hub.v1.1+json" },
    ...(signal === undefined ? {} : { signal }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new QaHubApiError(response.status, readErrorCode(body));
  if (!isBugListResponse(body)) throw new QaHubApiError(response.status, "INVALID_RESPONSE");
  return body;
}
