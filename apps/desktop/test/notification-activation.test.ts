import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  boundedNotificationFailure,
  buildUpdateActivationArguments,
  buildUpdateNotificationId,
  buildWindowsUpdateNotificationToastXml,
  buildNotificationActivationArguments,
  buildWindowsNotificationToastXml,
  deriveToastActivatorClsid,
  notificationRouteMatchesScope,
  NotificationActivationGuard,
  PendingNotificationActivationQueue,
  parseNotificationActivationArguments,
  parseWindowsNotificationActivation,
  parseWindowsUpdateNotificationActivation,
  shouldRetainClosedScopedNotification,
  UpdateActivationGuard,
} from "../src/notification-activation.js";

const NOTIFICATION_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const USER_ID = "30000000-0000-4000-8000-000000000001";
const UPDATE_RELEASE_ID = "20260911T123456789Z";

test("renderer Bug refresh precedes the native notification support gate", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("function showNativeNotification(");
  const end = source.indexOf("function quitApplication()", start);
  const implementation = source.slice(start, end);
  const rendererSend = implementation.indexOf(
    'mainWindow.webContents.send("desktop:bug-changed", change)',
  );
  const supportGate = implementation.indexOf("if (!Notification.isSupported())");
  const nativeConstruction = implementation.indexOf("nativeNotification = new Notification(");
  assert.ok(rendererSend >= 0);
  assert.ok(supportGate > rendererSend);
  assert.ok(nativeConstruction > supportGate);
});

test("Windows clicks require the global activator and false terminals reject late instance events", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("function showNativeNotification(");
  const end = source.indexOf("function quitApplication()", start);
  const implementation = source.slice(start, end);
  assert.match(
    implementation,
    /if \(process\.platform !== "win32"\) \{\s+nativeNotification\.once\("click"/u,
  );

  for (const terminal of [
    implementation.slice(
      implementation.indexOf('nativeNotification.once("failed"'),
      implementation.indexOf('nativeNotification.once("close"'),
    ),
    implementation.slice(
      implementation.indexOf('nativeNotification.once("close"'),
      implementation.indexOf('if (process.platform !== "win32")'),
    ),
    implementation.slice(
      implementation.lastIndexOf("} catch (error) {"),
      implementation.lastIndexOf("  });"),
    ),
  ]) {
    const cancel = terminal.indexOf("ignoreLateEvents = true");
    const release = terminal.indexOf("releaseActiveNativeNotification(");
    const failure = terminal.indexOf("finish(false)");
    assert.ok(cancel >= 0 && release > cancel && failure > release);
  }
});

test("cold activation route is durable before presentation but only activation acknowledges", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("function showNativeNotification(");
  const end = source.indexOf("function quitApplication()", start);
  const implementation = source.slice(start, end);
  const routePersistence = implementation.indexOf("notificationHistory.recordRoute(");
  const retain = implementation.indexOf("retainActiveNativeNotification(");
  const showCall = implementation.lastIndexOf("nativeNotification.show()");
  const releaseHandler = implementation.slice(
    retain,
    implementation.indexOf('nativeNotification.once("show"'),
  );
  const showHandler = implementation.slice(
    implementation.indexOf('nativeNotification.once("show"'),
    implementation.indexOf('nativeNotification.once("failed"'),
  );
  assert.match(releaseHandler, /reason === "clicked"[\s\S]+finish\(true\)/u);
  assert.match(
    releaseHandler,
    /finish\(false\);\s+if \(reason === "expired"\) \{\s+retainExpiredScopedNotification/u,
  );
  assert.ok(routePersistence >= 0 && routePersistence < retain && retain < showCall);
  assert.doesNotMatch(showHandler, /notificationHistory\.recordRoute/u);
  assert.doesNotMatch(showHandler, /finish\(true\)/u);

  const transport = source.slice(
    source.indexOf("function createTransport()"),
    source.indexOf("async function startApplication()"),
  );
  const batchPreparation = transport.indexOf("prepareNotifications:");
  const batchPersistence = transport.indexOf("notificationHistory.recordRoutes(");
  const preparedShow = transport.indexOf("showNativeNotification(notice, true)");
  assert.ok(
    batchPreparation >= 0 && batchPersistence > batchPreparation && preparedShow > batchPersistence,
  );
});

test("notification failure details are sanitized and bounded", () => {
  const failure = boundedNotificationFailure(`  presenter\u0000${"x".repeat(400)}  `, "FALLBACK");
  assert.equal(failure.includes("\u0000"), false);
  assert.equal(failure.length, 256);
  assert.equal(boundedNotificationFailure({}, "FALLBACK"), "FALLBACK");
});

test("Windows scoped notification close events retain a bounded cleanup reference", () => {
  for (const reason of ["timedOut", "userCanceled", "applicationHidden", undefined] as const) {
    assert.equal(shouldRetainClosedScopedNotification("win32", reason), true);
  }
  assert.equal(shouldRetainClosedScopedNotification("darwin", "timedOut"), false);
  assert.equal(shouldRetainClosedScopedNotification("linux", "userCanceled"), false);
});

test("toast activator CLSID is stable, per AUMID, and uses the shared UUIDv5 contract", () => {
  assert.equal(
    deriveToastActivatorClsid("com.relayqahub.desktop.preview.unit"),
    "{CF811D77-1C3F-5A20-B2DA-30AA57C3EB86}",
  );
  assert.notEqual(
    deriveToastActivatorClsid("com.relayqahub.desktop.preview.unit"),
    deriveToastActivatorClsid("com.relayqahub.desktop.preview.another"),
  );
  assert.throws(() => deriveToastActivatorClsid(""), /APP_USER_MODEL_ID_INVALID/);
});

test("Windows toast XML carries a strict UUID launch tag and escapes all XML content", () => {
  const xml = buildWindowsNotificationToastXml({
    notificationId: NOTIFICATION_ID.toUpperCase(),
    title: `QA & <Hub> "ready" 'now'`,
    body: "Bug > queue\u0001",
  });
  assert.equal(
    xml,
    '<toast launch="type=click&amp;tag=10000000-0000-4000-8000-000000000001"><visual><binding template="ToastGeneric"><text>QA &amp; &lt;Hub&gt; &quot;ready&quot; &apos;now&apos;</text><text>Bug &gt; queue </text></binding></visual></toast>',
  );
  assert.equal(
    parseNotificationActivationArguments(
      buildNotificationActivationArguments(NOTIFICATION_ID.toUpperCase()),
    ),
    NOTIFICATION_ID,
  );
  assert.throws(
    () => buildWindowsNotificationToastXml({ notificationId: "not-a-uuid", title: "x", body: "y" }),
    /NOTIFICATION_ACTIVATION_ID_INVALID/,
  );
});

test("activation parsing rejects malformed, duplicate, encoded, extra, and non-click arguments", () => {
  assert.equal(
    parseWindowsNotificationActivation({
      type: "click",
      arguments: `tag=${NOTIFICATION_ID.toUpperCase()}&type=click`,
    }),
    NOTIFICATION_ID,
  );
  for (const argumentsValue of [
    `type=click&tag=${NOTIFICATION_ID}&extra=1`,
    `type=click&tag=${NOTIFICATION_ID}&tag=${NOTIFICATION_ID}`,
    `type=click%26tag=${NOTIFICATION_ID}`,
    `type=action&tag=${NOTIFICATION_ID}`,
    "type=click&tag=not-a-uuid",
    "",
  ]) {
    assert.equal(parseNotificationActivationArguments(argumentsValue), null);
  }
  assert.equal(
    parseWindowsNotificationActivation({
      type: "action",
      arguments: `type=click&tag=${NOTIFICATION_ID}`,
    }),
    null,
  );
});

test("activation guard deduplicates global and instance callbacks with bounded retention", () => {
  const guard = new NotificationActivationGuard(2);
  const second = "10000000-0000-4000-8000-000000000002";
  const third = "10000000-0000-4000-8000-000000000003";
  assert.equal(guard.claim(NOTIFICATION_ID.toUpperCase()), true);
  assert.equal(guard.claim(NOTIFICATION_ID), false);
  assert.equal(guard.claim(second), true);
  assert.equal(guard.claim(third), true);
  assert.equal(guard.claim(NOTIFICATION_ID), true, "the oldest claim is evicted at the bound");
  assert.equal(guard.claim("not-a-uuid"), false);
});

test("notification activation requires an exact current project and user scope", () => {
  const route = { projectId: PROJECT_ID.toUpperCase(), userId: USER_ID.toUpperCase() };
  assert.equal(
    notificationRouteMatchesScope(route, { projectId: PROJECT_ID, userId: USER_ID }),
    true,
  );
  for (const scope of [
    { projectId: null, userId: USER_ID },
    { projectId: PROJECT_ID, userId: null },
    { projectId: "20000000-0000-4000-8000-000000000002", userId: USER_ID },
    { projectId: PROJECT_ID, userId: "30000000-0000-4000-8000-000000000002" },
  ]) {
    assert.equal(notificationRouteMatchesScope(route, scope), false);
  }
  assert.equal(
    notificationRouteMatchesScope({ projectId: "invalid", userId: USER_ID }, route),
    false,
  );
});

test("cold notification activations queue once, evict oldest at the bound, and drain once", () => {
  const queue = new PendingNotificationActivationQueue(2);
  const second = "10000000-0000-4000-8000-000000000002";
  const third = "10000000-0000-4000-8000-000000000003";
  assert.deepEqual(queue.enqueue(NOTIFICATION_ID.toUpperCase()), {
    accepted: true,
    evicted: null,
  });
  assert.deepEqual(queue.enqueue(NOTIFICATION_ID), { accepted: false, evicted: null });
  assert.deepEqual(queue.enqueue("invalid"), { accepted: false, evicted: null });
  assert.deepEqual(queue.enqueue(second), { accepted: true, evicted: null });
  assert.deepEqual(queue.enqueue(third), { accepted: true, evicted: NOTIFICATION_ID });
  assert.deepEqual(queue.drain(), [second, third]);
  assert.deepEqual(queue.drain(), []);
});

test("scope changes dismiss scoped toasts and every Bug activation gates before acknowledgement", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const sync = source.slice(
    source.indexOf("function syncNotificationCredential()"),
    source.indexOf(
      "function sendUpdateState",
      source.indexOf("function syncNotificationCredential()"),
    ),
  );
  assert.match(
    sync,
    /transport\.stop\(\);\s+closeScopedNotificationsForScopeChange\(\);\s+transport = createTransport\(\)/u,
  );

  const activation = source.slice(
    source.indexOf("function activateNativeNotification("),
    source.indexOf("function queueOrActivateGlobalNotification("),
  );
  const scopeGate = activation.indexOf("notificationRouteMatchesScope(");
  const claim = activation.indexOf("notificationActivationGuard.claim(");
  const acknowledge = activation.indexOf("notificationHistory.acknowledge(");
  const route = activation.indexOf("routeToBug(");
  assert.ok(scopeGate >= 0 && claim > scopeGate && acknowledge > claim && route > acknowledge);

  const close = source.slice(
    source.indexOf("function closeScopedNotificationsForScopeChange()"),
    source.indexOf(
      "function handleSecondInstanceArguments",
      source.indexOf("function closeScopedNotificationsForScopeChange()"),
    ),
  );
  assert.match(close, /active\.kind !== "update"/u);
  assert.match(close, /"scope-changed"/u);
  assert.match(close, /releaseRetainedScopedNotification\(notificationId, true\)/u);
  assert.doesNotMatch(close, /acknowledge/u);

  const quit = source.slice(
    source.indexOf("function quitApplication()"),
    source.indexOf("function showUpdateReadyNotification("),
  );
  assert.match(
    quit,
    /transport\.stop\(\);\s+closeScopedNotificationsForScopeChange\(\);[\s\S]+app\.quit\(\)/u,
  );
  const beforeQuit = source.slice(
    source.indexOf('app.on("before-quit"'),
    source.indexOf('app.on("window-all-closed"'),
  );
  assert.match(beforeQuit, /closeScopedNotificationsForScopeChange\(\)/u);
  const startupFailure = source.slice(source.indexOf(".catch((error: unknown)"));
  assert.match(
    startupFailure,
    /transport\?\.stop\(\);\s+closeScopedNotificationsForScopeChange\(\);[\s\S]+app\.quit\(\)/u,
  );
  for (const exitPath of [quit, beforeQuit, startupFailure]) {
    assert.doesNotMatch(exitPath, /notificationHistory\.acknowledge/u);
  }

  assert.match(source, /reason === "expired"[\s\S]+retainExpiredScopedNotification/u);
  const closeHandler = source.slice(
    source.indexOf('nativeNotification.once("close"'),
    source.indexOf(
      'if (process.platform !== "win32")',
      source.indexOf('nativeNotification.once("close"'),
    ),
  );
  assert.match(
    closeHandler,
    /if \(deliveryWasPending\) finish\(false\);[\s\S]+shouldRetainClosedScopedNotification\(process\.platform, details\.reason\)[\s\S]+retainExpiredScopedNotification/u,
  );
  assert.doesNotMatch(closeHandler, /acknowledge/u);
  assert.match(
    source,
    /await mainWindow\.loadURL\(target\);\s+if \(currentNotificationScope\(\) !== null\) drainPendingNotificationActivations\(\);[\s\S]+transport\.start\(\)/u,
  );
  const globalHandler = source.slice(
    source.indexOf("Notification.handleActivation"),
    source.indexOf("protocol.registerSchemesAsPrivileged"),
  );
  assert.match(globalHandler, /queueOrActivateGlobalNotification\(notificationId\)/u);
});

test("Bug, packaging, update, and retained toasts share one fail-closed native budget", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const capacity = source.slice(
    source.indexOf("function nativeNotificationReferenceCount()"),
    source.indexOf("function closeScopedNotificationsForScopeChange()"),
  );
  assert.match(capacity, /activeNativeNotifications\.size \+ retainedScopedNotifications\.size/u);
  assert.match(
    capacity,
    /MAX_ACTIVE_NATIVE_NOTIFICATIONS - nonBugActive - retainedScopedNotifications\.size/u,
  );
  assert.match(
    capacity,
    /if \(!canRetainNativeNotification\(notificationId\)\) return false;[\s\S]+activeNativeNotifications\.set/u,
  );
  assert.doesNotMatch(capacity, /releaseActiveNativeNotification\(oldest, "capacity"\)/u);
  assert.doesNotMatch(capacity, /releaseRetainedScopedNotification\(oldest/u);
  assert.match(capacity, /transport\?\.requestReconcile\(\)/u);

  const bugShow = source.slice(
    source.indexOf("function showNativeNotification("),
    source.indexOf("function quitApplication()"),
  );
  const bugCapacity = bugShow.indexOf(
    "if (!canRetainNativeNotification(notification.notificationId))",
  );
  const bugConstruct = bugShow.indexOf("nativeNotification = new Notification(");
  const bugPersist = bugShow.indexOf("notificationHistory.recordRoute(");
  const bugRetain = bugShow.indexOf("!retainActiveNativeNotification(");
  const bugShowCall = bugShow.lastIndexOf("nativeNotification.show()");
  assert.ok(
    bugCapacity >= 0 &&
      bugConstruct > bugCapacity &&
      bugPersist > bugConstruct &&
      bugRetain > bugPersist &&
      bugShowCall > bugRetain,
  );

  const updateShow = source.slice(
    source.indexOf("function showUpdateReadyNotification("),
    source.indexOf("type UpdateActivationSource"),
  );
  assert.ok(
    updateShow.indexOf("if (!canRetainNativeNotification(notificationId))") <
      updateShow.indexOf("notification = new Notification("),
  );
  assert.match(
    updateShow,
    /!retainActiveNativeNotification\(notificationId, notification, "update"[\s\S]+updateReadyNotificationGuard\.release\(state\.releaseId\);\s+return;/u,
  );

  const packagingShow = source.slice(
    source.indexOf('ipcMain.handle("desktop:notify-packaging"'),
    source.indexOf('ipcMain.removeHandler("desktop:get-connection-status"'),
  );
  assert.ok(
    packagingShow.indexOf("if (!canRetainNativeNotification(notificationId)) return false") <
      packagingShow.indexOf("notification = new Notification("),
  );
  assert.match(
    packagingShow,
    /!retainActiveNativeNotification\(notificationId, notification, "packaging"[\s\S]+return false;/u,
  );

  const transport = source.slice(
    source.indexOf("function createTransport()"),
    source.indexOf("async function startApplication()"),
  );
  assert.match(transport, /maxPendingNotifications: maxPendingBugNotifications/u);
});

test("update activation uses a stable bounded ID and strict release-only Windows arguments", () => {
  assert.equal(buildUpdateNotificationId(UPDATE_RELEASE_ID), `qa-hub-update-${UPDATE_RELEASE_ID}`);
  assert.equal(
    buildUpdateActivationArguments(UPDATE_RELEASE_ID),
    `type=update&release=${UPDATE_RELEASE_ID}`,
  );
  const xml = buildWindowsUpdateNotificationToastXml({
    releaseId: UPDATE_RELEASE_ID,
    title: "QA & Hub",
    body: "Ready <now>",
  });
  assert.equal(
    xml,
    `<toast launch="type=update&amp;release=${UPDATE_RELEASE_ID}"><visual><binding template="ToastGeneric"><text>QA &amp; Hub</text><text>Ready &lt;now&gt;</text></binding></visual></toast>`,
  );
  assert.equal(
    parseWindowsUpdateNotificationActivation({
      type: "click",
      arguments: buildUpdateActivationArguments(UPDATE_RELEASE_ID),
    }),
    UPDATE_RELEASE_ID,
  );
  for (const value of [
    `type=update&release=${UPDATE_RELEASE_ID}&extra=1`,
    `release=${UPDATE_RELEASE_ID}&type=update`,
    `type=update&release=${UPDATE_RELEASE_ID.toLowerCase()}`,
    "type=update&release=not-a-release",
    "",
  ]) {
    assert.equal(
      parseWindowsUpdateNotificationActivation({ type: "click", arguments: value }),
      null,
    );
  }
  assert.throws(() => buildUpdateNotificationId("not-a-release"), /RELEASE_ID_INVALID/u);
});

test("update activation guard deduplicates callbacks with bounded retention", () => {
  const guard = new UpdateActivationGuard(2);
  const second = "20260912T123456789Z";
  const third = "20260913T123456789Z";
  assert.equal(guard.claim(UPDATE_RELEASE_ID), true);
  assert.equal(guard.claim(UPDATE_RELEASE_ID), false);
  assert.equal(guard.release(UPDATE_RELEASE_ID), true);
  assert.equal(guard.release(UPDATE_RELEASE_ID), false);
  assert.equal(guard.claim(UPDATE_RELEASE_ID), true);
  assert.equal(guard.claim(second), true);
  assert.equal(guard.claim(third), true);
  assert.equal(guard.claim(UPDATE_RELEASE_ID), true);
  assert.equal(guard.claim("not-a-release"), false);
  assert.equal(guard.release("not-a-release"), false);
});

test("update-ready notifications retain a bounded live object and queue cold activation", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const showStart = source.indexOf("function showUpdateReadyNotification(");
  const showEnd = source.indexOf("type UpdateActivationSource", showStart);
  const show = source.slice(showStart, showEnd);
  assert.match(show, /id: notificationId/u);
  assert.match(show, /toastXml: buildWindowsUpdateNotificationToastXml/u);
  assert.match(show, /retainActiveNativeNotification\(notificationId/u);
  assert.match(show, /reason === "clicked" \|\| reason === "expired"/u);
  assert.match(
    show,
    /if \(!Notification\.isSupported\(\)\) \{\s+updateReadyNotificationGuard\.release\(state\.releaseId\)/u,
  );
  assert.match(show, /eventTimer = setTimeout\([\s\S]+NOTIFICATION_PLATFORM_EVENT_TIMEOUT/u);
  assert.match(show, /eventTimer\.unref\(\)/u);
  assert.match(show, /if \(ignoreLateEvents \|\| shown\) return/u);
  assert.match(
    show,
    /if \(releaseActiveNativeNotification\(notificationId, "failed", notification\)\) \{\s+updateReadyNotificationGuard\.release\(state\.releaseId\)/u,
  );
  assert.match(
    show,
    /releaseActiveNativeNotification\(notificationId, "closed", notification\) &&\s+!shown/u,
  );
  assert.match(
    show,
    /releaseActiveNativeNotification\(notificationId, "timeout", notification\)[\s\S]+updateReadyNotificationGuard\.release\(state\.releaseId\)/u,
  );
  assert.match(show, /process\.platform !== "win32"[\s\S]+notification\.once\("click"/u);

  const globalHandler = source.slice(
    source.indexOf("Notification.handleActivation"),
    source.indexOf("protocol.registerSchemesAsPrivileged"),
  );
  assert.ok(
    globalHandler.indexOf("parseWindowsUpdateNotificationActivation") <
      globalHandler.indexOf("parseWindowsNotificationActivation"),
  );
  assert.match(globalHandler, /queueUpdateActivation\(updateReleaseId, "global"\)/u);
  assert.ok(
    source.indexOf("pendingUpdateActivations.add(releaseId)") <
      source.indexOf("updater = await createUpdater()"),
  );
  assert.match(source, /updater = await createUpdater\(\);\s+drainPendingUpdateActivations\(\)/u);
  assert.match(
    source,
    /if \(handoffAccepted\) return;[\s\S]+updateActivationGuard\.release\(releaseId\);[\s\S]+updateReadyNotificationGuard\.release\(releaseId\)/u,
  );
  assert.match(
    source,
    /try \{[\s\S]+handoffAccepted = await activeUpdater\.installRelease\(releaseId\);[\s\S]+catch \(cause\)[\s\S]+boundedNotificationFailure\(cause, "UPDATE_ACTIVATION_FAILED"\)/u,
  );
  assert.match(source, /"desktop\.update\.notification\.activation\.handoff\.completed"/u);
  assert.doesNotMatch(source, /desktop\.update\.notification\.activation\.completed|\binstalled,/u);
  assert.match(
    source,
    /pendingUpdateActivations\.delete\(oldest\);\s+updateActivationGuard\.release\(oldest\);\s+updateReadyNotificationGuard\.release\(oldest\)/u,
  );
});
