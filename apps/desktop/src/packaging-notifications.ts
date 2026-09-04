import type { DesktopPackagingNotice } from "./bridge-types.js";

export function parsePackagingNotice(value: unknown): DesktopPackagingNotice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const { id, kind, title, body } = item;
  if (
    typeof id !== "string" ||
    !/^(?:build-\d{1,10}-(?:finished|prepare|unity|apk|publish|zip|finalize)|queue-\d{1,10}-cancelled)$/u.test(
      id,
    ) ||
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
