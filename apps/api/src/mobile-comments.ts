import type {
  MobileBugEvents,
  MobileCommentCreation,
  MobileCommentList,
} from "@relay-qa-hub/storage";

export const MOBILE_BUG_COMMENTS_PATH = "/api/v1/bugs/:bugId/comments" as const;
export const MOBILE_BUG_EVENTS_PATH = "/api/v1/bugs/:bugId/events" as const;

export interface MobileAddBugCommentRequest {
  readonly clientSubmissionId: string;
  readonly body: string;
}

export interface MobileCommentStore {
  readonly listComments: (query: {
    readonly actorId: string;
    readonly bugId: string;
    readonly cursor?: string;
    readonly limit: number;
  }) => MobileCommentList | Promise<MobileCommentList>;
  readonly addComment: (command: {
    readonly actorId: string;
    readonly bugId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly request: MobileAddBugCommentRequest;
  }) => MobileCommentCreation | Promise<MobileCommentCreation>;
  readonly listEvents: (query: {
    readonly actorId: string;
    readonly bugId: string;
    readonly afterSequence?: number;
    readonly cursor?: string;
    readonly limit: number;
  }) => MobileBugEvents | Promise<MobileBugEvents>;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const MAX_COMMENT_LENGTH = 20_000;
const MAX_TIMELINE_ITEMS = 100;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("request body must be an object");
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`unexpected property: ${key}`);
  }
}

function queryString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (Array.isArray(candidate)) {
    if (candidate.length !== 1 || typeof candidate[0] !== "string") {
      throw new TypeError(`${key} must occur at most once`);
    }
    return candidate[0];
  }
  if (typeof candidate !== "string") throw new TypeError(`${key} must be a string`);
  return candidate;
}

function paginationQuery(
  value: unknown,
  includeAfterSequence: boolean,
): { readonly cursor?: string; readonly limit: number; readonly afterSequence?: number } {
  const query = record(value);
  onlyKeys(
    query,
    new Set(includeAfterSequence ? ["afterSequence", "cursor", "limit"] : ["cursor", "limit"]),
  );
  const cursor = queryString(query, "cursor");
  if (cursor !== undefined && (cursor.length < 1 || cursor.length > 500)) {
    throw new TypeError("cursor is invalid");
  }
  const rawLimit = queryString(query, "limit");
  let limit = 50;
  if (rawLimit !== undefined) {
    if (!/^[1-9][0-9]{0,2}$/u.test(rawLimit)) {
      throw new TypeError("limit must be an integer from 1 through 100");
    }
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit > MAX_TIMELINE_ITEMS) {
      throw new TypeError("limit must be an integer from 1 through 100");
    }
  }
  const rawAfter = includeAfterSequence ? queryString(query, "afterSequence") : undefined;
  let afterSequence: number | undefined;
  if (rawAfter !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/u.test(rawAfter)) throw new TypeError("afterSequence is invalid");
    afterSequence = Number(rawAfter);
    if (!Number.isSafeInteger(afterSequence)) throw new TypeError("afterSequence is invalid");
  }
  return {
    ...(cursor === undefined ? {} : { cursor }),
    limit,
    ...(afterSequence === undefined ? {} : { afterSequence }),
  };
}

export function parseMobileBugCommentsQuery(value: unknown): {
  readonly cursor?: string;
  readonly limit: number;
} {
  const query = paginationQuery(value, false);
  return query.cursor === undefined
    ? { limit: query.limit }
    : { cursor: query.cursor, limit: query.limit };
}

export function parseMobileBugEventsQuery(value: unknown): {
  readonly afterSequence?: number;
  readonly cursor?: string;
  readonly limit: number;
} {
  return paginationQuery(value, true);
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a UUID`);
  }
  return value;
}

export function parseMobileAddBugCommentRequest(value: unknown): MobileAddBugCommentRequest {
  const body = record(value);
  onlyKeys(body, new Set(["clientSubmissionId", "body"]));
  const clientSubmissionId = requireUuid(body["clientSubmissionId"], "clientSubmissionId");
  if (
    typeof body["body"] !== "string" ||
    body["body"].length < 1 ||
    body["body"].length > MAX_COMMENT_LENGTH
  ) {
    throw new TypeError("body must contain from 1 through 20000 characters");
  }
  return Object.freeze({ clientSubmissionId, body: body["body"] });
}

export function parseMobileBugEventsLimit(value: unknown): number {
  if (value === undefined) return 20;
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new TypeError("limit must be a single integer");
    value = value[0];
  }
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new TypeError("limit must be an integer from 1 through 100");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TIMELINE_ITEMS) {
    throw new TypeError("limit must be an integer from 1 through 100");
  }
  return limit;
}

export function requireMobileCommentIdempotencyKey(
  value: string | undefined,
  bugId: string,
  clientSubmissionId: string,
): string {
  if (value === undefined || value.length < 1 || value.length > 255) {
    throw new TypeError("Idempotency-Key is required");
  }
  const accepted = new Set([
    `comment:${bugId}:${clientSubmissionId}`,
    `submission:${clientSubmissionId}:commit`,
  ]);
  if (!accepted.has(value)) {
    throw new TypeError("Idempotency-Key does not match the comment submission");
  }
  return value;
}

export function requireMobileCommentCorrelationId(
  value: string | undefined,
  clientSubmissionId: string,
): string {
  if (value !== undefined && value !== clientSubmissionId) {
    throw new TypeError("X-Correlation-ID must match clientSubmissionId");
  }
  return clientSubmissionId;
}
