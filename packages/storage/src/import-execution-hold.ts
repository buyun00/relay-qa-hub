import { existsSync, readFileSync } from "node:fs";

/** Restore markers fail closed, including unreadable, partial and malformed files. */
export function isImportExecutionHeld(file: string | undefined): boolean {
  if (!file || !existsSync(file)) return false;
  try {
    const raw = readFileSync(file, "utf8");
    if (Buffer.byteLength(raw) > 65536) return true;
    const value = JSON.parse(raw) as Record<string, unknown>;
    const release = value["release"] as Record<string, unknown> | undefined;
    return !(
      value["markerVersion"] === 1 &&
      value["state"] === "released" &&
      release &&
      typeof release["actorId"] === "string" &&
      release["actorId"].trim() &&
      typeof release["releasedAt"] === "string" &&
      Number.isFinite(Date.parse(release["releasedAt"])) &&
      typeof release["reason"] === "string" &&
      release["reason"].trim()
    );
  } catch {
    return true;
  }
}
