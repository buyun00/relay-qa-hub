import { createHash } from "node:crypto";

import type { DesktopPackagingNotice } from "./bridge-types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PACKAGING_NOTICE_ID_PATTERN =
  /^(?:build-\d{1,10}-(?:finished|prepare|unity|apk|publish|zip|finalize)|queue-\d{1,10}-cancelled)$/u;

export interface DesktopPackagingNotificationScope {
  readonly projectId: string;
  readonly userId: string;
}

export function buildPackagingNotificationId(
  noticeId: string,
  scope: DesktopPackagingNotificationScope,
): string {
  if (
    !PACKAGING_NOTICE_ID_PATTERN.test(noticeId) ||
    !UUID_PATTERN.test(scope.projectId) ||
    !UUID_PATTERN.test(scope.userId)
  ) {
    throw new Error("PACKAGING_NOTIFICATION_SCOPE_INVALID");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([scope.projectId.toLowerCase(), scope.userId.toLowerCase(), noticeId]),
      "utf8",
    )
    .digest("hex")
    .slice(0, 40);
  return `qa-hub-packaging-${digest}`;
}

export function parsePackagingNotice(value: unknown): DesktopPackagingNotice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const { id, kind, title, body } = item;
  if (
    typeof id !== "string" ||
    !PACKAGING_NOTICE_ID_PATTERN.test(id) ||
    !["success", "warning", "failure"].includes(String(kind)) ||
    typeof title !== "string" ||
    title.length > 100 ||
    !title ||
    typeof body !== "string" ||
    body.length > 600 ||
    !body
  )
    return null;
  return { id, kind: kind as DesktopPackagingNotice["kind"], title, body };
}
