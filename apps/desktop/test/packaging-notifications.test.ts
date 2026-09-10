import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildPackagingNotificationId,
  parsePackagingNotice,
} from "../src/packaging-notifications.js";

const PROJECT_A = "20000000-0000-4000-8000-000000000001";
const PROJECT_B = "20000000-0000-4000-8000-000000000002";
const USER_A = "30000000-0000-4000-8000-000000000001";
const USER_B = "30000000-0000-4000-8000-000000000002";

test("packaging IPC accepts bounded notices and rejects unrelated IDs or oversized payloads", () => {
  const notice = {
    id: "build-10140-unity",
    kind: "warning",
    title: "阶段耗时异常",
    body: "请检查 Unity 导出",
  };
  assert.deepEqual(parsePackagingNotice(notice), notice);
  assert.equal(parsePackagingNotice({ ...notice, id: "https://example.com" }), null);
  assert.equal(parsePackagingNotice({ ...notice, body: "x".repeat(601) }), null);
  assert.equal(parsePackagingNotice({ ...notice, kind: "script" }), null);
});

test("packaging notification IDs are stable, bounded, and isolated by exact scope", () => {
  const first = buildPackagingNotificationId("build-10140-unity", {
    projectId: PROJECT_A,
    userId: USER_A,
  });
  assert.equal(
    first,
    buildPackagingNotificationId("build-10140-unity", {
      projectId: PROJECT_A.toUpperCase(),
      userId: USER_A.toUpperCase(),
    }),
  );
  assert.match(first, /^qa-hub-packaging-[0-9a-f]{40}$/u);
  assert.ok(first.length <= 64);
  assert.notEqual(
    first,
    buildPackagingNotificationId("build-10140-unity", {
      projectId: PROJECT_B,
      userId: USER_A,
    }),
  );
  assert.notEqual(
    first,
    buildPackagingNotificationId("build-10140-unity", {
      projectId: PROJECT_A,
      userId: USER_B,
    }),
  );
  assert.notEqual(
    first,
    buildPackagingNotificationId("build-10140-apk", {
      projectId: PROJECT_A,
      userId: USER_A,
    }),
  );
  assert.throws(
    () => buildPackagingNotificationId("build-10140-unity", { projectId: "bad", userId: USER_A }),
    /PACKAGING_NOTIFICATION_SCOPE_INVALID/u,
  );
});

test("packaging IPC captures exact scope and gates every click before opening", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const handler = source.slice(
    source.indexOf('ipcMain.handle("desktop:notify-packaging"'),
    source.indexOf('ipcMain.removeHandler("desktop:get-connection-status"'),
  );
  const capturedScope = handler.indexOf("const scope = currentNotificationScope()");
  const missingScope = handler.indexOf("scope === null");
  const stableId = handler.indexOf("buildPackagingNotificationId(notice.id, scope)");
  const dedupe = handler.indexOf("packagingNotices.has(notificationId)");
  const nativeId = handler.indexOf("id: notificationId");
  const retained = handler.indexOf(
    'retainActiveNativeNotification(notificationId, notification, "packaging"',
  );
  assert.ok(
    capturedScope >= 0 &&
      missingScope > capturedScope &&
      stableId > missingScope &&
      dedupe > stableId &&
      nativeId > dedupe &&
      retained > nativeId,
  );

  const close = handler.slice(
    handler.indexOf('notification.once("close"'),
    handler.indexOf('notification.once("click"'),
  );
  assert.match(
    close,
    /shouldRetainClosedScopedNotification\(process\.platform, details\.reason\)[\s\S]+retainExpiredScopedNotification/u,
  );

  const click = handler.slice(handler.indexOf('notification.once("click"'));
  const scopeGate = click.indexOf("notificationRouteMatchesScope(scope");
  const mismatch = click.indexOf("if (!matchesCurrentScope)");
  const closeMismatch = click.indexOf(
    "releaseRetainedScopedNotification(notificationId, true, notification)",
  );
  const ignoredReturn = click.indexOf("return;", closeMismatch);
  const open = click.indexOf('mainWindow?.webContents.send("desktop:open-packaging")');
  assert.ok(
    scopeGate >= 0 &&
      mismatch > scopeGate &&
      closeMismatch > mismatch &&
      ignoredReturn > closeMismatch &&
      open > ignoredReturn,
  );
  assert.match(click, /releaseRetainedScopedNotification\(notificationId, false, notification\)/u);
  assert.match(handler, /packagingNotices\.add\(notificationId\)/u);
  assert.doesNotMatch(handler, /notificationHistory\.acknowledge/u);
});
