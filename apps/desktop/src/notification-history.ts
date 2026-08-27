import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_HISTORY_BYTES = 64 * 1024;
export const MAX_NOTIFICATION_HISTORY = 512;

interface PersistedHistory {
  readonly schemaVersion: 1;
  readonly notificationIds: readonly string[];
}

function parseHistory(raw: string): readonly string[] {
  if (Buffer.byteLength(raw, "utf8") > MAX_HISTORY_BYTES) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "schemaVersion" && key !== "notificationIds") ||
    record["schemaVersion"] !== 1 ||
    !Array.isArray(record["notificationIds"]) ||
    record["notificationIds"].length > MAX_NOTIFICATION_HISTORY
  ) {
    return [];
  }
  const ids: string[] = [];
  for (const value of record["notificationIds"]) {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) return [];
    const normalized = value.toLowerCase();
    if (!ids.includes(normalized)) ids.push(normalized);
  }
  return ids;
}

export class NotificationHistory {
  private readonly ids: string[];

  constructor(private readonly filePath: string | null) {
    if (filePath === null) {
      this.ids = [];
      return;
    }
    try {
      this.ids = [...parseHistory(readFileSync(filePath, "utf8"))];
    } catch {
      this.ids = [];
    }
  }

  get notificationIds(): readonly string[] {
    return [...this.ids];
  }

  record(notificationId: string): void {
    if (!UUID_PATTERN.test(notificationId)) return;
    const normalized = notificationId.toLowerCase();
    const existing = this.ids.indexOf(normalized);
    if (existing >= 0) this.ids.splice(existing, 1);
    this.ids.push(normalized);
    if (this.ids.length > MAX_NOTIFICATION_HISTORY) {
      this.ids.splice(0, this.ids.length - MAX_NOTIFICATION_HISTORY);
    }
    if (this.filePath === null) return;
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    const payload: PersistedHistory = {
      schemaVersion: 1,
      notificationIds: this.ids,
    };
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.filePath);
    } catch {
      // Persistence is a replay guard only; notification delivery must stay live.
    }
  }
}
