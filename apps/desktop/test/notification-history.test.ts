import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MAX_NOTIFICATION_HISTORY, NotificationHistory } from "../src/notification-history.js";

function notificationId(sequence: number): string {
  return `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

const PROJECT_ID = "40000000-0000-4000-8000-000000000001";
const USER_ID = "50000000-0000-4000-8000-000000000001";
const BUG_ID = "30000000-0000-4000-8000-000000000001";

test("notification history persists bounded acknowledged IDs and recovers from malformed input", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qa-hub-notification-history-"));
  const filePath = path.join(root, "notification-history.json");
  try {
    writeFileSync(filePath, "not-json", "utf8");
    const history = new NotificationHistory(filePath);
    assert.deepEqual(history.acknowledgedNotificationIds, []);
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 2,
        entries: Array.from({ length: MAX_NOTIFICATION_HISTORY }, (_, index) => ({
          notificationId: notificationId(index + 1),
          acknowledged: true,
        })),
      }),
      "utf8",
    );
    const fullHistory = new NotificationHistory(filePath);
    assert.equal(fullHistory.acknowledge(notificationId(MAX_NOTIFICATION_HISTORY + 1)), true);
    const reloaded = new NotificationHistory(filePath);
    assert.equal(reloaded.acknowledgedNotificationIds.length, MAX_NOTIFICATION_HISTORY);
    assert.equal(reloaded.acknowledgedNotificationIds.includes(notificationId(1)), false);
    assert.equal(
      reloaded.acknowledgedNotificationIds.at(-1),
      notificationId(MAX_NOTIFICATION_HISTORY + 1),
    );
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as {
      readonly schemaVersion: number;
    };
    assert.equal(persisted.schemaVersion, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("current unread acknowledgements survive rollover by stale notification history", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qa-hub-notification-history-priority-"));
  const filePath = path.join(root, "notification-history.json");
  const currentUnreadId = notificationId(1);
  try {
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 2,
        entries: Array.from({ length: MAX_NOTIFICATION_HISTORY }, (_, index) => ({
          notificationId: notificationId(index + 1),
          acknowledged: true,
        })),
      }),
      "utf8",
    );
    const history = new NotificationHistory(filePath);
    assert.equal(history.prioritizeAcknowledged([currentUnreadId]), true);
    assert.equal(
      history.recordRoutes(
        Array.from({ length: 20 }, (_, index) => ({
          notificationId: notificationId(MAX_NOTIFICATION_HISTORY + index + 1),
          route: { projectId: PROJECT_ID, userId: USER_ID, bugId: BUG_ID },
        })),
      ),
      true,
    );

    const reloaded = new NotificationHistory(filePath);
    assert.equal(reloaded.acknowledgedNotificationIds.includes(currentUnreadId), true);
    assert.equal(
      reloaded.has(notificationId(2)),
      false,
      "the oldest stale entries are evicted first",
    );
    assert.deepEqual(reloaded.routeFor(notificationId(MAX_NOTIFICATION_HISTORY + 1)), {
      projectId: PROJECT_ID,
      userId: USER_ID,
      bugId: BUG_ID,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("notification history migrates v1 replay IDs and persists scoped activation routes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qa-hub-notification-history-migration-"));
  const filePath = path.join(root, "notification-history.json");
  const legacyId = notificationId(1);
  const routedId = notificationId(2);
  try {
    writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 1, notificationIds: [legacyId.toUpperCase()] }),
      "utf8",
    );
    const history = new NotificationHistory(filePath);
    assert.deepEqual(history.acknowledgedNotificationIds, []);
    assert.equal(history.has(legacyId), true);
    assert.equal(history.routeFor(legacyId), null);
    assert.equal(
      history.recordRoute(routedId.toUpperCase(), {
        projectId: PROJECT_ID.toUpperCase(),
        userId: USER_ID.toUpperCase(),
        bugId: BUG_ID.toUpperCase(),
      }),
      true,
    );

    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as {
      readonly schemaVersion: number;
      readonly entries: readonly unknown[];
    };
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.entries.length, 2);

    const reloaded = new NotificationHistory(filePath);
    assert.deepEqual(reloaded.acknowledgedNotificationIds, []);
    assert.deepEqual(reloaded.routeFor(routedId), {
      projectId: PROJECT_ID,
      userId: USER_ID,
      bugId: BUG_ID,
    });
    assert.equal(reloaded.acknowledge(routedId), true);
    assert.deepEqual(new NotificationHistory(filePath).acknowledgedNotificationIds, [routedId]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("notification history rejects route entries with partial or extra scope", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qa-hub-notification-history-invalid-"));
  const filePath = path.join(root, "notification-history.json");
  try {
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 2,
        entries: [
          {
            notificationId: notificationId(1),
            projectId: PROJECT_ID,
            userId: USER_ID,
            bugId: BUG_ID,
            acknowledged: false,
            extra: true,
          },
        ],
      }),
      "utf8",
    );
    assert.deepEqual(new NotificationHistory(filePath).acknowledgedNotificationIds, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history persistence failure is explicit while the in-memory route stays usable", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qa-hub-notification-history-failure-"));
  const blockingFile = path.join(root, "not-a-directory");
  const id = notificationId(1);
  try {
    writeFileSync(blockingFile, "block", "utf8");
    const history = new NotificationHistory(path.join(blockingFile, "notification-history.json"));
    assert.equal(
      history.recordRoute(id, { projectId: PROJECT_ID, userId: USER_ID, bugId: BUG_ID }),
      false,
    );
    assert.deepEqual(history.routeFor(id), {
      projectId: PROJECT_ID,
      userId: USER_ID,
      bugId: BUG_ID,
    });
    assert.equal(history.acknowledge(id), false);
    assert.deepEqual(history.acknowledgedNotificationIds, [id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
