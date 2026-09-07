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
  readonly body: string;
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
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_sequence: number;
  readonly from_state: string | null;
  readonly to_state: string | null;
  readonly payload_json: string;
  readonly created_at: string;
}

interface InboxRow {
  readonly id: string;
}

interface UserRow {
  readonly user_id: string;
}

interface BugNotificationRow {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly state: string;
  readonly reporter_id: string;
  readonly owner_id: string | null;
  readonly verification_owner_id: string | null;
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
  readonly event_type: string;
  readonly event_to_state: string | null;
  readonly event_aggregate_sequence: number;
  readonly event_payload_json: string;
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

function boundedNotificationText(value: string, maxLength: number): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function readNotificationBug(
  database: DatabaseSync,
  input: ListMobileNotificationsInput,
  bugId: string | null,
): BugNotificationRow | null {
  if (bugId === null) return null;
  return (
    (database
      .prepare(
        `SELECT id, key, title, description, state, reporter_id, owner_id,
                verification_owner_id
         FROM bugs
         WHERE account_id = ? AND project_id = ? AND id = ?`,
      )
      .get(input.accountId, input.projectId, bugId) as BugNotificationRow | undefined) ?? null
  );
}

function activeProjectUsers(
  database: DatabaseSync,
  input: ListMobileNotificationsInput,
): readonly string[] {
  return (
    database
      .prepare(
        `SELECT DISTINCT membership.user_id
         FROM memberships AS membership
         JOIN users AS user
           ON user.account_id = membership.account_id
          AND user.id = membership.user_id
          AND user.status = 'active'
         WHERE membership.account_id = ? AND membership.project_id = ?
           AND membership.status = 'active'
         ORDER BY membership.user_id`,
      )
      .all(input.accountId, input.projectId) as unknown as UserRow[]
  ).map((row) => row.user_id);
}

function relatedRepairAssignee(
  database: DatabaseSync,
  input: ListMobileNotificationsInput,
  event: EventRow,
): string | null {
  if (event.aggregate_type !== "repair_attempt") return null;
  const row = database
    .prepare(
      `SELECT assignee_id
       FROM repair_attempts
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, event.aggregate_id) as
    { readonly assignee_id: string } | undefined;
  return row?.assignee_id ?? null;
}

function relatedVerifier(
  database: DatabaseSync,
  input: ListMobileNotificationsInput,
  event: EventRow,
): string | null {
  if (event.aggregate_type !== "verification") return null;
  const row = database
    .prepare(
      `SELECT verifier_id
       FROM verifications
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, event.aggregate_id) as
    { readonly verifier_id: string } | undefined;
  return row?.verifier_id ?? null;
}

function notificationRecipients(
  database: DatabaseSync,
  input: ListMobileNotificationsInput,
  event: EventRow,
  bug: BugNotificationRow | null,
  allUsers: readonly string[],
): readonly string[] {
  if (bug === null) return allUsers;
  const repairAssignee = relatedRepairAssignee(database, input, event);
  const owner = bug.owner_id ?? repairAssignee;
  const verifier = relatedVerifier(database, input, event) ?? bug.verification_owner_id;
  let requested: readonly (string | null)[];

  if (event.type === "occurrence.appended") {
    requested = bug.owner_id === null ? allUsers : [bug.owner_id];
  } else if (event.type === "bug.updated") {
    const payload = parsePayload(event.payload_json);
    const changedFields = typeof payload.summary === "string" ? payload.summary : "";
    requested =
      bug.state === "ready_for_verification" && changedFields.includes("verification_owner_id")
        ? [verifier ?? bug.reporter_id]
        : owner === null
          ? allUsers
          : [owner];
  } else if (event.to_state === "ready_for_verification" || event.type === "verification.created") {
    requested = [verifier ?? bug.reporter_id];
  } else if (event.type === "verification.result_recorded") {
    const payload = parsePayload(event.payload_json);
    requested = payload.status === "passed" ? [owner, verifier] : [owner];
  } else {
    requested = owner === null ? allUsers : [owner];
  }

  const activeUsers = new Set(allUsers);
  return [...new Set(requested.filter((userId): userId is string => userId !== null))].filter(
    (userId) => activeUsers.has(userId),
  );
}

function notificationTitle(
  event: Pick<EventRow, "type" | "to_state" | "aggregate_sequence" | "payload_json">,
): string {
  const payload = parsePayload(event.payload_json);
  if (event.type === "bug.verification.passed") return "这个单子已验收";
  if (event.type === "verification.result_recorded") {
    return payload.status === "passed" ? "这个单子已验收" : "这个单子验收未通过，已退回";
  }
  if (event.type === "bug.mark_duplicate") return "这个单子已关闭";
  if (["closed", "deferred", "rejected", "duplicate"].includes(event.to_state ?? "")) {
    return "这个单子已关闭";
  }
  if (
    event.to_state === "awaiting_build" ||
    event.to_state === "ready_for_verification" ||
    event.type === "repair_attempt.delivered"
  ) {
    return "这个单子已完成，待验收";
  }
  if (event.type === "verification.created") return "这个单子待验收";
  if (event.type === "verification.started") return "这个单子开始验收";
  if (event.type === "bug.reopen.newer_occurrence") return "这个单子已重新打开";
  if (event.to_state === "in_progress" || event.type === "repair_attempt.started") {
    return "这个单子正在处理";
  }
  if (["reported", "needs_info", "ready"].includes(event.to_state ?? "")) {
    return "这个单子待处理";
  }
  if (event.type === "occurrence.appended") {
    return event.aggregate_sequence === 1 ? "这个单子已创建" : "这个单子有新的反馈";
  }
  if (event.type === "bug.updated") return "这个单子信息已更新";
  if (event.type === "repair_attempt.created") return "这个单子已创建修复轮次";
  if (event.type === "build.registered") return "Build 已登记";
  return "这个单子状态已改变";
}

function notificationPresentation(
  event: EventRow,
  bug: BugNotificationRow | null,
): { readonly title: string; readonly body: string } {
  const payload = parsePayload(event.payload_json);
  const body =
    bug === null
      ? boundedNotificationText(
          typeof payload.summary === "string" ? payload.summary : event.type,
          500,
        )
      : boundedNotificationText(`${bug.key} · ${bug.description.trim() || bug.title}`, 500);

  return { title: notificationTitle(event), body };
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
        `SELECT id, type, bug_id, aggregate_type, aggregate_id, aggregate_sequence,
                from_state, to_state, payload_json, created_at
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

    const bug = readNotificationBug(database, input, event.bug_id);
    const allUsers = activeProjectUsers(database, input);
    const recipients = notificationRecipients(database, input, event, bug, allUsers);
    const presentation = notificationPresentation(event, bug);
    const payload = {
      ...parsePayload(event.payload_json),
      notificationBody: presentation.body,
    };
    for (const userId of recipients) {
      insertNotification.run(
        randomUUID(),
        input.accountId,
        input.projectId,
        userId,
        event.type,
        presentation.title,
        event.bug_id,
        event.id,
        JSON.stringify(payload),
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
  const body =
    typeof payload.notificationBody === "string"
      ? boundedNotificationText(payload.notificationBody, 500)
      : row.title;
  return Object.freeze({
    id: row.id,
    accountId: row.account_id,
    projectId: row.project_id,
    userId: row.user_id,
    type: row.type,
    // Re-project legacy wording from the immutable event without changing IDs,
    // read status or delivery history (and without replaying notifications).
    title: notificationTitle({
      type: row.event_type,
      to_state: row.event_to_state,
      aggregate_sequence: row.event_aggregate_sequence,
      payload_json: row.event_payload_json,
    }),
    body,
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
      `SELECT notification.id, notification.account_id, notification.project_id,
              notification.user_id, notification.type, notification.title, notification.bug_id,
              notification.source_event_id, notification.payload_json, notification.created_at,
              notification.read_at, notification.version, event.type AS event_type,
              event.to_state AS event_to_state, event.aggregate_sequence AS event_aggregate_sequence,
              event.payload_json AS event_payload_json
       FROM notifications AS notification
       JOIN events AS event ON event.account_id = notification.account_id
         AND event.project_id = notification.project_id AND event.id = notification.source_event_id
       WHERE notification.account_id = ? AND notification.project_id = ? AND notification.user_id = ?
       ORDER BY notification.created_at DESC, notification.id DESC
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
