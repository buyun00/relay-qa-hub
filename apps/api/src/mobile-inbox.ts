import type { MobileNotificationList } from "@relay-qa-hub/storage";

export const MOBILE_NOTIFICATION_LIST_PATH = "/api/v1/notifications" as const;

export interface MobileNotificationStore {
  readonly listNotifications: (query: {
    readonly actorId: string;
    readonly limit: number;
    readonly now: string;
  }) => MobileNotificationList | Promise<MobileNotificationList>;
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
