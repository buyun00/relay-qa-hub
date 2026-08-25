export const MOBILE_BUG_DUPLICATE_CANDIDATES_PATH =
  "/api/v1/bugs/:bugId/duplicate-candidates" as const;

export interface MobileDuplicateCandidate {
  readonly bugId: string;
  readonly bugKey: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface MobileDuplicateCandidateList {
  readonly candidates: readonly MobileDuplicateCandidate[];
}

export interface MobileDuplicateStore {
  readonly listCandidates: (query: {
    readonly actorId: string;
    readonly bugId: string;
  }) => MobileDuplicateCandidateList | Promise<MobileDuplicateCandidateList>;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export function requireDuplicateBugUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
  return value;
}
