interface CursorScope {
  readonly kind: "comments" | "attachments";
  readonly accountId: string;
  readonly projectId: string;
  readonly bugId: string;
}
interface Position {
  readonly createdAt: string;
  readonly id: string;
}

function invalid(): never {
  throw Object.assign(new TypeError("Cursor is invalid for this project and Bug"), {
    code: "INVALID_CURSOR",
  });
}

/** Opaque seek position, never an authorization token; every page rechecks its scope. */
export function decodeScopedListCursor(value: unknown, scope: CursorScope): Position | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(value)) invalid();
  let decoded: unknown;
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.toString("base64url") !== value) invalid();
    decoded = JSON.parse(raw.toString("utf8"));
  } catch {
    invalid();
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) invalid();
  const cursor = decoded as Record<string, unknown>;
  if (
    cursor["v"] !== 1 ||
    cursor["kind"] !== scope.kind ||
    cursor["accountId"] !== scope.accountId ||
    cursor["projectId"] !== scope.projectId ||
    cursor["bugId"] !== scope.bugId ||
    typeof cursor["createdAt"] !== "string" ||
    cursor["createdAt"].length > 64 ||
    !Number.isFinite(Date.parse(cursor["createdAt"])) ||
    typeof cursor["id"] !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(cursor["id"])
  )
    invalid();
  return { createdAt: cursor["createdAt"], id: cursor["id"] };
}

export function encodeScopedListCursor(scope: CursorScope, position: Position): string {
  return Buffer.from(
    JSON.stringify({ v: 1, ...scope, createdAt: position.createdAt, id: position.id }),
    "utf8",
  ).toString("base64url");
}
