import type { MobileBugRecord } from "@relay-qa-hub/storage";

export const MOBILE_BUG_DUPLICATE_CANDIDATES_PATH =
  "/api/v1/bugs/:bugId/duplicate-candidates" as const;
export const MOBILE_BUG_MARK_DUPLICATE_PATH = "/api/v1/bugs/:bugId/mark-duplicate" as const;

export interface MobileDuplicateCandidate {
  readonly bugId: string;
  readonly bugKey: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface MobileDuplicateCandidateList {
  readonly candidates: readonly MobileDuplicateCandidate[];
}

export interface MobileMarkDuplicateRequest {
  readonly expectedVersion: number;
  readonly toState: "duplicate";
  readonly canonicalBugId: string;
  readonly reason: string;
}

export interface MobileDuplicateStore {
  readonly listCandidates: (query: {
    readonly actorId: string;
    readonly bugId: string;
  }) => MobileDuplicateCandidateList | Promise<MobileDuplicateCandidateList>;
  readonly markDuplicate: (command: {
    readonly actorId: string;
    readonly bugId: string;
    readonly idempotencyKey: string;
    readonly request: MobileMarkDuplicateRequest;
  }) => MobileBugRecord | Promise<MobileBugRecord>;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export function requireDuplicateBugUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
  return value;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("mark duplicate body must be an object");
  }
  return value as Record<string, unknown>;
}

export function parseMobileMarkDuplicateRequest(value: unknown): MobileMarkDuplicateRequest {
  const body = requireObject(value);
  const allowed = new Set(["expectedVersion", "toState", "canonicalBugId", "reason"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new TypeError("mark duplicate body contains unsupported fields");
  }
  const expectedVersion = body["expectedVersion"];
  if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1) {
    throw new TypeError("expectedVersion must be a positive integer");
  }
  if (body["toState"] !== "duplicate") throw new TypeError("toState must be duplicate");
  const canonicalBugId = requireDuplicateBugUuid(body["canonicalBugId"], "canonicalBugId");
  if (typeof body["reason"] !== "string") throw new TypeError("reason must be a string");
  const reason = body["reason"].trim();
  if (reason.length < 1 || reason.length > 2_000) {
    throw new TypeError("reason must contain 1 to 2000 characters");
  }
  return Object.freeze({
    expectedVersion: expectedVersion as number,
    toState: "duplicate",
    canonicalBugId,
    reason,
  });
}
