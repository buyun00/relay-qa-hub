import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
// Match the server's maximum frozen Inbox snapshot so every server-unread
// notification can retain a durable local activation acknowledgement.
export const MAX_NOTIFICATION_HISTORY = 10_000;

export interface NotificationHistoryRoute {
  readonly projectId: string;
  readonly userId: string;
  readonly bugId: string | null;
}

interface NotificationHistoryEntry {
  readonly notificationId: string;
  readonly route: NotificationHistoryRoute | null;
  readonly acknowledged: boolean;
}

interface PersistedHistoryV2Entry {
  readonly notificationId: string;
  readonly acknowledged: boolean;
  readonly projectId?: string;
  readonly userId?: string;
  readonly bugId?: string | null;
}

interface PersistedHistoryV2 {
  readonly schemaVersion: 2;
  readonly entries: readonly PersistedHistoryV2Entry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function normalizeRoute(value: unknown): NotificationHistoryRoute | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.every((key) => key === "projectId" || key === "userId" || key === "bugId")
  ) {
    return null;
  }
  const projectId = normalizeUuid(value["projectId"]);
  const userId = normalizeUuid(value["userId"]);
  const bugId = value["bugId"] === null ? null : normalizeUuid(value["bugId"]);
  if (projectId === null || userId === null || (value["bugId"] !== null && bugId === null)) {
    return null;
  }
  return { projectId, userId, bugId };
}

function addEntry(entries: NotificationHistoryEntry[], entry: NotificationHistoryEntry): void {
  const existing = entries.findIndex(
    (candidate) => candidate.notificationId === entry.notificationId,
  );
  if (existing >= 0) entries.splice(existing, 1);
  entries.push(entry);
}

function parseHistory(raw: string): readonly NotificationHistoryEntry[] {
  if (Buffer.byteLength(raw, "utf8") > MAX_HISTORY_BYTES) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(value)) return [];
  const entries: NotificationHistoryEntry[] = [];
  if (value["schemaVersion"] === 1) {
    if (
      Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "notificationIds") ||
      !Array.isArray(value["notificationIds"]) ||
      value["notificationIds"].length > MAX_NOTIFICATION_HISTORY
    ) {
      return [];
    }
    for (const notificationIdValue of value["notificationIds"]) {
      const notificationId = normalizeUuid(notificationIdValue);
      if (notificationId === null) return [];
      // Schema v1 recorded presentation, not user acknowledgement. Preserve the
      // ID for migration diagnostics while leaving it eligible for Inbox replay.
      addEntry(entries, { notificationId, route: null, acknowledged: false });
    }
    return entries;
  }
  if (
    value["schemaVersion"] !== 2 ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "entries") ||
    !Array.isArray(value["entries"]) ||
    value["entries"].length > MAX_NOTIFICATION_HISTORY
  ) {
    return [];
  }
  for (const entryValue of value["entries"]) {
    if (!isRecord(entryValue)) return [];
    const notificationId = normalizeUuid(entryValue["notificationId"]);
    const keys = Object.keys(entryValue);
    if (notificationId === null) return [];
    if (
      keys.length === 2 &&
      keys.every((key) => key === "notificationId" || key === "acknowledged")
    ) {
      if (typeof entryValue["acknowledged"] !== "boolean") return [];
      addEntry(entries, {
        notificationId,
        route: null,
        acknowledged: entryValue["acknowledged"],
      });
      continue;
    }
    if (
      keys.length !== 5 ||
      !keys.every(
        (key) =>
          key === "notificationId" ||
          key === "acknowledged" ||
          key === "projectId" ||
          key === "userId" ||
          key === "bugId",
      )
    ) {
      return [];
    }
    if (typeof entryValue["acknowledged"] !== "boolean") return [];
    const route = normalizeRoute({
      projectId: entryValue["projectId"],
      userId: entryValue["userId"],
      bugId: entryValue["bugId"],
    });
    if (route === null) return [];
    addEntry(entries, { notificationId, route, acknowledged: entryValue["acknowledged"] });
  }
  return entries;
}

export class NotificationHistory {
  private readonly entries: NotificationHistoryEntry[];

  constructor(private readonly filePath: string | null) {
    if (filePath === null) {
      this.entries = [];
      return;
    }
    try {
      this.entries = [...parseHistory(readFileSync(filePath, "utf8"))];
    } catch {
      this.entries = [];
    }
  }

  get acknowledgedNotificationIds(): readonly string[] {
    return this.entries.filter((entry) => entry.acknowledged).map((entry) => entry.notificationId);
  }

  has(notificationId: string): boolean {
    const normalized = normalizeUuid(notificationId);
    return normalized !== null && this.entries.some((entry) => entry.notificationId === normalized);
  }

  routeFor(notificationId: string): NotificationHistoryRoute | null {
    const normalized = normalizeUuid(notificationId);
    if (normalized === null) return null;
    const route = this.entries.find((entry) => entry.notificationId === normalized)?.route ?? null;
    return route === null ? null : { ...route };
  }

  recordRoute(notificationId: string, route: NotificationHistoryRoute): boolean {
    return this.recordRoutes([{ notificationId, route }]);
  }

  recordRoutes(
    values: readonly {
      readonly notificationId: string;
      readonly route: NotificationHistoryRoute;
    }[],
  ): boolean {
    if (values.length === 0) return true;
    const normalizedValues: {
      readonly notificationId: string;
      readonly route: NotificationHistoryRoute;
    }[] = [];
    const notificationIds = new Set<string>();
    for (const value of values) {
      const notificationId = normalizeUuid(value.notificationId);
      const route = normalizeRoute(value.route);
      if (notificationId === null || route === null || notificationIds.has(notificationId)) {
        return false;
      }
      notificationIds.add(notificationId);
      normalizedValues.push({ notificationId, route });
    }
    for (const value of normalizedValues) {
      const existing = this.entries.find((entry) => entry.notificationId === value.notificationId);
      addEntry(this.entries, {
        notificationId: value.notificationId,
        route: value.route,
        acknowledged: existing?.acknowledged ?? false,
      });
    }
    return this.persist();
  }

  acknowledge(notificationId: string, fallbackRoute?: NotificationHistoryRoute): boolean {
    const normalized = normalizeUuid(notificationId);
    const normalizedFallback =
      fallbackRoute === undefined ? undefined : normalizeRoute(fallbackRoute);
    if (normalized === null || (fallbackRoute !== undefined && normalizedFallback === null))
      return false;
    const existing = this.entries.find((entry) => entry.notificationId === normalized);
    addEntry(this.entries, {
      notificationId: normalized,
      route: existing?.route ?? normalizedFallback ?? null,
      acknowledged: true,
    });
    return this.persist();
  }

  prioritizeAcknowledged(notificationIds: readonly string[]): boolean {
    const currentUnread = new Set<string>();
    for (const notificationId of notificationIds) {
      const normalized = normalizeUuid(notificationId);
      if (normalized === null) return false;
      currentUnread.add(normalized);
    }
    const retained: NotificationHistoryEntry[] = [];
    const prioritized: NotificationHistoryEntry[] = [];
    for (const entry of this.entries) {
      if (entry.acknowledged && currentUnread.has(entry.notificationId)) prioritized.push(entry);
      else retained.push(entry);
    }
    if (prioritized.length === 0) return true;
    const next = [...retained, ...prioritized];
    if (next.every((entry, index) => entry === this.entries[index])) return true;
    this.entries.splice(0, this.entries.length, ...next);
    return this.persist();
  }

  private persist(): boolean {
    if (this.entries.length > MAX_NOTIFICATION_HISTORY) {
      this.entries.splice(0, this.entries.length - MAX_NOTIFICATION_HISTORY);
    }
    if (this.filePath === null) return false;
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    const payload: PersistedHistoryV2 = {
      schemaVersion: 2,
      entries: this.entries.map((entry): PersistedHistoryV2Entry =>
        entry.route === null
          ? { notificationId: entry.notificationId, acknowledged: entry.acknowledged }
          : {
              notificationId: entry.notificationId,
              acknowledged: entry.acknowledged,
              ...entry.route,
            },
      ),
    };
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.filePath);
      return true;
    } catch {
      return false;
    }
  }
}
