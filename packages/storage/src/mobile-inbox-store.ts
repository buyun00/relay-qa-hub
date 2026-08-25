import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { MobileRelayStorageError, type MobileRelayScope } from "./mobile-relay-store.js";

const NOTIFICATION_SOURCE = "qa-hub.notifications";
const NOTIFICATION_SOURCE_INSTANCE = "qa-hub";
const NOTIFICATION_DESTINATION = "qa-hub.notifications";
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export interface MobileNotificationRecord {
  readonly id: string;
  readonly accountId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly type: string;
  readonly title: string;
  readonly bugId: string | null;
  readonly buildId: string | null;
  readonly sourceEventId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly version: number;
}

export interface MobileNotificationList {
  readonly items: readonly MobileNotificationRecord[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
  readonly consumed: number;
  readonly duplicate: number;
}

export interface ListMobileNotificationsInput extends MobileRelayScope {
  readonly limit: number;
  readonly now: string;
}

interface NotificationOutboxRow {
  readonly id: string;
  readonly account_id: string;
  readonly project_id: string;
  readonly event_id: string;
  readonly dedupe_key: string;
  readonly created_at: string;
}

interface EventRow {
  readonly id: string;
  readonly type: string;
  readonly bug_id: string | null;
  readonly aggregate_id: string;
  readonly aggregate_sequence: number;
  readonly payload_json: string;
  readonly created_at: string;
}

interface InboxRow {
  readonly id: string;
}

interface UserRow {
  readonly user_id: string;
}

interface NotificationRow {
  readonly id: string;
  readonly account_id: string;
  readonly project_id: string;
  readonly user_id: string;
  readonly type: string;
  readonly title: string;
  readonly bug_id: string | null;
  readonly source_event_id: string;
  readonly payload_json: string;
  readonly created_at: string;
  readonly read_at: string | null;
  readonly version: number;
}

function requireTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "mobile notification storage requires the caller's write transaction",
    );
  }
}

function requireUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} must be a UUID`);
  }
}

function requireLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "limit must be between 1 and 100");
  }
}

function requireTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "now is invalid");
  }
}

function payloadDigest(payloadJson: string): string {
  return createHash("sha256").update(payloadJson, "utf8").digest("hex");
}

function parsePayload(payloadJson: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(payloadJson);
  } catch {
    throw new MobileRelayStorageError("INVALID_REQUEST", "notification payload is invalid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "notification payload must be an object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function consumeNotificationOutbox(
  database: DatabaseSync,
  input: ListMobileNotificationsInput,
): { readonly consumed: number; readonly duplicate: number } {
  const rows = database
    .prepare(
      `SELECT id, account_id, project_id, event_id, dedupe_key, created_at
       FROM outbox
       WHERE account_id = ? AND project_id = ? AND destination = ?
         AND status IN ('pending', 'retry') AND next_attempt_at <= ?
       ORDER BY next_attempt_at, id`,
    )
    .all(
      input.accountId,
      input.projectId,
      NOTIFICATION_DESTINATION,
      input.now,
    ) as unknown as NotificationOutboxRow[];

  let consumed = 0;
  let duplicate = 0;
  const insertInbox = database.prepare(
    `INSERT INTO inbox(
       id, account_id, project_id, source, source_instance_id,
       external_event_id, delivery_id, event_type, aggregate_id,
       aggregate_sequence, payload_digest, payload_json, status,
       received_at, applied_at, version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?, 1)`,
  );
  const insertNotification = database.prepare(
    `INSERT OR IGNORE INTO notifications(
       id, account_id, project_id, user_id, type, title, bug_id,
       source_event_id, payload_json, created_at, read_at, version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
  );
  const markSent = database.prepare(
    `UPDATE outbox
     SET status = 'sent', sent_at = ?, lease_owner = NULL, lease_expires_at = NULL,
         last_error_code = NULL
     WHERE id = ? AND status IN ('pending', 'retry')`,
  );

  for (const outbox of rows) {
    const event = database
      .prepare(
        `SELECT id, type, bug_id, aggregate_id, aggregate_sequence, payload_json, created_at
         FROM events
         WHERE account_id = ? AND project_id = ? AND id = ?`,
      )
      .get(input.accountId, input.projectId, outbox.event_id) as EventRow | undefined;
    if (!event) {
      throw new MobileRelayStorageError("NOT_FOUND", "notification outbox event is missing");
    }
    const existing = database
      .prepare(
        `SELECT id
         FROM inbox
         WHERE account_id = ? AND source = ? AND source_instance_id = ?
           AND external_event_id = ?`,
      )
      .get(input.accountId, NOTIFICATION_SOURCE, NOTIFICATION_SOURCE_INSTANCE, event.id) as
      InboxRow | undefined;

    if (existing) {
      duplicate += 1;
      markSent.run(input.now, outbox.id);
      continue;
    }

    const receivedAt = input.now;
    insertInbox.run(
      randomUUID(),
      input.accountId,
      input.projectId,
      NOTIFICATION_SOURCE,
      NOTIFICATION_SOURCE_INSTANCE,
      event.id,
      outbox.dedupe_key,
      event.type,
      event.aggregate_id,
      event.aggregate_sequence,
      payloadDigest(event.payload_json),
      event.payload_json,
      receivedAt,
      receivedAt,
    );

    const title = event.type === "build.registered" ? "Build registered" : event.type;
    const users = database
      .prepare(
        `SELECT user_id
         FROM memberships
         WHERE account_id = ? AND project_id = ? AND status = 'active'`,
      )
      .all(input.accountId, input.projectId) as unknown as UserRow[];
    for (const user of users) {
      insertNotification.run(
        randomUUID(),
        input.accountId,
        input.projectId,
        user.user_id,
        event.type,
        title,
        event.bug_id,
        event.id,
        event.payload_json,
        event.created_at,
      );
    }
    markSent.run(input.now, outbox.id);
    consumed += 1;
  }

  return { consumed, duplicate };
}

function toNotification(row: NotificationRow): MobileNotificationRecord {
  const payload = parsePayload(row.payload_json);
  const buildId = typeof payload.buildId === "string" ? payload.buildId : null;
  return Object.freeze({
    id: row.id,
    accountId: row.account_id,
    projectId: row.project_id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    bugId: row.bug_id,
    buildId,
    sourceEventId: row.source_event_id,
    payload,
    createdAt: row.created_at,
    readAt: row.read_at,
    version: row.version,
  });
}

export function syncAndListMobileNotifications(
  database: DatabaseSync,
  input: ListMobileNotificationsInput,
): MobileNotificationList {
  requireTransaction(database);
  requireUuid(input.accountId, "accountId");
  requireUuid(input.projectId, "projectId");
  requireUuid(input.actorId, "actorId");
  requireLimit(input.limit);
  requireTimestamp(input.now);
  const sync = consumeNotificationOutbox(database, input);
  const rows = database
    .prepare(
      `SELECT id, account_id, project_id, user_id, type, title, bug_id,
              source_event_id, payload_json, created_at, read_at, version
       FROM notifications
       WHERE account_id = ? AND project_id = ? AND user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(
      input.accountId,
      input.projectId,
      input.actorId,
      input.limit,
    ) as unknown as NotificationRow[];
  const unread = database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM notifications
       WHERE account_id = ? AND project_id = ? AND user_id = ? AND read_at IS NULL`,
    )
    .get(input.accountId, input.projectId, input.actorId) as { readonly count: number };
  return Object.freeze({
    items: Object.freeze(rows.map(toNotification)),
    nextCursor: null,
    unreadCount: unread.count,
    consumed: sync.consumed,
    duplicate: sync.duplicate,
  });
}
