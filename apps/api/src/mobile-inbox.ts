import type { MobileNotificationList } from "@relay-qa-hub/storage";

export const MOBILE_NOTIFICATION_LIST_PATH = "/api/v1/notifications" as const;

export interface MobileNotificationStore {
  readonly listNotifications: (query: {
    readonly actorId: string;
    readonly projectId?: string;
    readonly unreadOnly?: boolean;
    readonly cursor?: string;
    readonly limit: number;
    readonly now: string;
  }) => MobileNotificationList | Promise<MobileNotificationList>;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("notification list query must be an object");
  }
  return value as Record<string, unknown>;
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

export function parseMobileNotificationListQuery(value: unknown): {
  readonly projectId?: string;
  readonly unreadOnly: boolean;
  readonly cursor?: string;
  readonly limit: number;
} {
  const query = record(value);
  const allowed = new Set(["projectId", "unreadOnly", "cursor", "limit"]);
  if (Object.keys(query).some((key) => !allowed.has(key))) {
    throw new TypeError("notification list query contains an unexpected property");
  }
  const projectId = queryString(query, "projectId");
  if (projectId !== undefined && !UUID_PATTERN.test(projectId)) {
    throw new TypeError("projectId must be a UUID");
  }
  const rawUnreadOnly = queryString(query, "unreadOnly");
  if (rawUnreadOnly !== undefined && rawUnreadOnly !== "true" && rawUnreadOnly !== "false") {
    throw new TypeError("unreadOnly must be true or false");
  }
  const cursor = queryString(query, "cursor");
  if (cursor !== undefined && (cursor.length < 1 || cursor.length > 500)) {
    throw new TypeError("cursor is invalid");
  }
  const rawLimit = queryString(query, "limit");
  let limit = 50;
  if (rawLimit !== undefined) {
    if (!/^[1-9][0-9]{0,2}$/u.test(rawLimit)) throw new TypeError("limit is invalid");
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit > 100) throw new TypeError("limit is invalid");
  }
  return {
    ...(projectId === undefined ? {} : { projectId: projectId.toLowerCase() }),
    unreadOnly: rawUnreadOnly === "true",
    ...(cursor === undefined ? {} : { cursor }),
    limit,
  };
}

export function parseMobileNotificationLimit(value: unknown): number {
  if (value === undefined) return 50;
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string" || !/^\d+$/u.test(candidate)) {
    throw new TypeError("limit must be an integer");
  }
  const limit = Number(candidate);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("limit must be between 1 and 100");
  }
  return limit;
}
