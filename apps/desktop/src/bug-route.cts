import type { DesktopBugRoute } from "./bridge-types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ROUTE_KEYS = new Set(["projectId", "userId", "bugId"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableUuid(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return undefined;
  return value.toLowerCase();
}

function parseDesktopBugRoute(value: unknown): DesktopBugRoute | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !ROUTE_KEYS.has(key))) return null;
  const bugId = value["bugId"];
  const projectId = nullableUuid(value["projectId"]);
  const userId = nullableUuid(value["userId"]);
  if (
    typeof bugId !== "string" ||
    !UUID_PATTERN.test(bugId) ||
    projectId === undefined ||
    userId === undefined ||
    (projectId === null) !== (userId === null)
  ) {
    return null;
  }
  return {
    projectId,
    userId,
    bugId: bugId.toLowerCase(),
  };
}

export = { parseDesktopBugRoute };
