import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MAX_NOTIFICATION_HISTORY, NotificationHistory } from "../src/notification-history.js";

function notificationId(sequence: number): string {
  return `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

test("notification history persists bounded delivered IDs and recovers from malformed input", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qa-hub-notification-history-"));
  const filePath = path.join(root, "notification-history.json");
  try {
    writeFileSync(filePath, "not-json", "utf8");
    const history = new NotificationHistory(filePath);
    assert.deepEqual(history.notificationIds, []);
    for (let sequence = 1; sequence <= MAX_NOTIFICATION_HISTORY + 1; sequence += 1) {
      history.record(notificationId(sequence));
    }
    const reloaded = new NotificationHistory(filePath);
    assert.equal(reloaded.notificationIds.length, MAX_NOTIFICATION_HISTORY);
    assert.equal(reloaded.notificationIds.includes(notificationId(1)), false);
    assert.equal(reloaded.notificationIds.at(-1), notificationId(MAX_NOTIFICATION_HISTORY + 1));
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as {
      readonly schemaVersion: number;
    };
    assert.equal(persisted.schemaVersion, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
