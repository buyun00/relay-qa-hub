import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DesktopBrowserSessionCookieStore } from "../src/network.js";
import {
  bootstrapBearerNotificationScope,
  exactNotificationScope,
  notificationScopeMissingReason,
  parseBearerNotificationPrincipal,
} from "../src/notification-scope.js";

const OLD_USER_ID = "10000000-0000-4000-8000-000000000001";
const OLD_PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const USER_ID = "30000000-0000-4000-8000-000000000001";
const PROJECT_ID = "40000000-0000-4000-8000-000000000001";

function principal(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "50000000-0000-4000-8000-000000000001",
    userId: USER_ID,
    email: "fixture@example.test",
    displayName: "Bearer Fixture",
    csrfToken: "fixture-csrf",
    projectId: PROJECT_ID,
    isGm: false,
    ...overrides,
  };
}

test("exact notification scope requires normalized UUIDs and an authoritative identity", () => {
  assert.deepEqual(
    exactNotificationScope(PROJECT_ID.toUpperCase(), USER_ID.toUpperCase(), "employee"),
    {
      projectId: PROJECT_ID,
      userId: USER_ID,
    },
  );
  assert.deepEqual(exactNotificationScope(PROJECT_ID, USER_ID, "gm"), {
    projectId: PROJECT_ID,
    userId: USER_ID,
  });
  assert.equal(exactNotificationScope(null, USER_ID, "employee"), null);
  assert.equal(exactNotificationScope(PROJECT_ID, null, "employee"), null);
  assert.equal(exactNotificationScope("not-a-project", USER_ID, "employee"), null);
  assert.equal(exactNotificationScope(PROJECT_ID, USER_ID, null), null);
  assert.equal(exactNotificationScope(PROJECT_ID, USER_ID, "administrator"), null);
  assert.equal(
    notificationScopeMissingReason(null, null, null),
    "NOTIFICATION_PROJECT_SCOPE_MISSING",
  );
  assert.equal(
    notificationScopeMissingReason(PROJECT_ID, null, "employee"),
    "NOTIFICATION_USER_SCOPE_MISSING",
  );
  assert.equal(
    notificationScopeMissingReason(PROJECT_ID, USER_ID, null),
    "NOTIFICATION_USER_SCOPE_MISSING",
  );
  assert.equal(notificationScopeMissingReason(PROJECT_ID, USER_ID, "employee"), null);
});

test("authoritative principals cannot inherit an earlier user, project, identity, or project request", () => {
  const session = new DesktopBrowserSessionCookieStore();
  session.rememberPrincipal({
    displayName: "Employee",
    userId: OLD_USER_ID,
    projectId: OLD_PROJECT_ID,
    isGm: false,
  });
  const staleProjectRequest = session.beginProjectRequest(PROJECT_ID);
  const employeeEpoch = session.scopeEpoch();

  session.rememberPrincipal({
    displayName: "GM",
    userId: USER_ID,
    isGm: true,
  });
  assert.equal(session.rememberedUserId(), USER_ID);
  assert.equal(session.rememberedProjectId(), null);
  assert.equal(session.rememberedIdentity(), "gm");
  assert.equal(
    exactNotificationScope(
      session.rememberedProjectId(),
      session.rememberedUserId(),
      session.rememberedIdentity(),
    ),
    null,
  );
  assert.ok(session.scopeEpoch() > employeeEpoch);
  session.completeProjectRequest(PROJECT_ID, staleProjectRequest);
  assert.equal(session.rememberedProjectId(), null);

  const nextProjectRequest = session.beginProjectRequest(PROJECT_ID);
  assert.ok(nextProjectRequest > staleProjectRequest);
  session.completeProjectRequest(PROJECT_ID, nextProjectRequest);
  assert.equal(session.rememberedProjectId(), PROJECT_ID);

  session.rememberPrincipal({
    displayName: "Incomplete",
    projectId: OLD_PROJECT_ID,
    isGm: false,
  });
  assert.equal(session.rememberedUserId(), null);
  assert.equal(session.rememberedProjectId(), null);
  assert.equal(session.rememberedIdentity(), null);
  assert.equal(
    exactNotificationScope(
      session.rememberedProjectId(),
      session.rememberedUserId(),
      session.rememberedIdentity(),
    ),
    null,
  );

  session.rememberPrincipal({
    displayName: "Missing identity",
    userId: USER_ID,
    projectId: PROJECT_ID,
  });
  assert.equal(session.rememberedUserId(), null);
  assert.equal(session.rememberedProjectId(), null);
  assert.equal(session.rememberedIdentity(), null);

  for (const invalid of [
    { identity: undefined },
    { identity: "owner" },
    { isGm: "false" },
    { isGm: false, identity: "gm" },
  ]) {
    session.rememberPrincipal({
      displayName: "Invalid identity",
      userId: USER_ID,
      projectId: PROJECT_ID,
      ...invalid,
    });
    assert.equal(session.rememberedUserId(), null);
    assert.equal(session.rememberedProjectId(), null);
    assert.equal(session.rememberedIdentity(), null);
    assert.equal(
      exactNotificationScope(
        session.rememberedProjectId(),
        session.rememberedUserId(),
        session.rememberedIdentity(),
      ),
      null,
    );
  }
});

test("Bearer principals require an exact user and an employee project", () => {
  assert.deepEqual(parseBearerNotificationPrincipal(principal()), {
    displayName: "Bearer Fixture",
    userId: USER_ID,
    projectId: PROJECT_ID,
    isGm: false,
  });
  assert.deepEqual(
    parseBearerNotificationPrincipal(principal({ isGm: true, projectId: undefined })),
    {
      displayName: "Bearer Fixture",
      userId: USER_ID,
      isGm: true,
    },
  );
  for (const invalid of [
    null,
    principal({ userId: undefined }),
    principal({ projectId: undefined }),
    principal({ projectId: "wrong" }),
    principal({ isGm: undefined }),
    principal({ displayName: "\u0000" }),
  ]) {
    assert.throws(() => parseBearerNotificationPrincipal(invalid), {
      message: "NOTIFICATION_PRINCIPAL_INVALID",
    });
  }
});

test("Bearer bootstrap discards an old persisted principal before reading and persists only the new one", async () => {
  const session = new DesktopBrowserSessionCookieStore();
  session.rememberPrincipal({
    displayName: "Old Principal",
    userId: OLD_USER_ID,
    projectId: OLD_PROJECT_ID,
    isGm: false,
  });
  let persistedSnapshot: string | null = null;
  const scope = await bootstrapBearerNotificationScope(
    {
      json: async (pathname) => {
        assert.equal(pathname, "/api/v1/auth/me");
        assert.equal(session.rememberedUserId(), null);
        assert.equal(session.rememberedProjectId(), null);
        return principal();
      },
    },
    session,
    async () => {
      persistedSnapshot = session.snapshot();
    },
  );
  assert.deepEqual(scope, { projectId: PROJECT_ID, userId: USER_ID });
  assert.equal(session.rememberedUserId(), USER_ID);
  assert.equal(session.rememberedProjectId(), PROJECT_ID);
  assert.equal(persistedSnapshot, session.snapshot());
});

test("Bearer bootstrap leaves no live scope after read or persistence failure", async () => {
  for (const failure of ["read", "persist"] as const) {
    const session = new DesktopBrowserSessionCookieStore();
    session.rememberPrincipal({
      displayName: "Old Principal",
      userId: OLD_USER_ID,
      projectId: OLD_PROJECT_ID,
      isGm: false,
    });
    await assert.rejects(
      bootstrapBearerNotificationScope(
        {
          json: async () => {
            if (failure === "read") throw new Error("READ_FAILED");
            return principal();
          },
        },
        session,
        async () => {
          if (failure === "persist") throw new Error("PERSIST_FAILED");
        },
      ),
      { message: failure === "read" ? "READ_FAILED" : "PERSIST_FAILED" },
    );
    assert.equal(session.rememberedUserId(), null);
    assert.equal(session.rememberedProjectId(), null);
  }
});

test("a GM without a selected project is persisted but returns no notification scope", async () => {
  const session = new DesktopBrowserSessionCookieStore();
  let persisted = false;
  const scope = await bootstrapBearerNotificationScope(
    { json: async () => principal({ isGm: true, projectId: undefined }) },
    session,
    async () => {
      persisted = true;
    },
  );
  assert.equal(scope, null);
  assert.equal(persisted, true);
  assert.equal(session.rememberedUserId(), USER_ID);
  assert.equal(session.rememberedProjectId(), null);
  assert.equal(session.rememberedIdentity(), "gm");
});

test("desktop startup validates a static Bearer principal before draining cold activations", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const start = source.slice(
    source.indexOf("async function startApplication()"),
    source.indexOf("const hasLock = app.requestSingleInstanceLock()"),
  );
  const load = start.indexOf("await loadRememberedLoginName()");
  const client = start.indexOf("apiClient = new DesktopQaHubApiClient");
  const bearerBranch = start.indexOf("if (config.accessToken !== null)");
  const bootstrap = start.indexOf("await bootstrapBearerNotificationScope(");
  const protocol = start.indexOf("await registerAppProtocol()");
  const transport = start.indexOf("transport = createTransport()");
  const createWindow = start.indexOf("mainWindow = createWindow()");
  const loadWindow = start.indexOf("await mainWindow.loadURL(target)");
  const exactDrain = start.indexOf(
    "if (currentNotificationScope() !== null) drainPendingNotificationActivations()",
  );
  const startTransport = start.indexOf("transport.start()");
  assert.ok(
    load >= 0 &&
      client > load &&
      bearerBranch > client &&
      bootstrap > bearerBranch &&
      protocol > bootstrap &&
      transport > protocol &&
      createWindow > transport &&
      loadWindow > createWindow &&
      exactDrain > loadWindow &&
      startTransport > exactDrain,
  );
  assert.equal(source.match(/new DesktopQaHubApiClient\(/gu)?.length, 1);

  const bootstrapFailure = start.slice(start.indexOf("} catch (error)", bootstrap), exactDrain);
  assert.match(bootstrapFailure, /desktop\.notification\.scope\.bootstrap\.failed/u);
  assert.match(
    bootstrapFailure,
    /boundedNotificationFailure\(code, "NOTIFICATION_SCOPE_BOOTSTRAP_FAILED"\)/u,
  );
  assert.doesNotMatch(bootstrapFailure, /Authorization|credential|accessToken/u);

  const clientCallback = start.slice(client, bearerBranch);
  assert.ok(
    clientCallback.indexOf("await persistRememberedLoginName()") <
      clientCallback.indexOf("syncNotificationCredential()"),
  );

  const route = source.slice(
    source.indexOf("function routeToBug("),
    source.indexOf("function activateNativeNotification("),
  );
  assert.match(
    route,
    /bugRouteDelivery\.enqueue\(normalized\);\s+openMainWindow\(\)/u,
    "a cold click must show even a startup-hidden window once loading has completed",
  );
});

test("desktop notification transport and cold activations stay closed without an exact scope", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const transport = source.slice(
    source.indexOf("function createTransport()"),
    source.indexOf("async function startApplication()"),
  );
  assert.match(
    transport,
    /const exactScope = exactNotificationScope\([\s\S]+rememberedProjectId,[\s\S]+rememberedUserId,[\s\S]+rememberedPrincipalIdentity/u,
  );
  assert.match(transport, /desktop\.notification\.transport\.disabled/u);
  assert.match(
    transport,
    /reason: notificationScopeMissingReason\([\s\S]+rememberedProjectId,[\s\S]+rememberedUserId,[\s\S]+rememberedPrincipalIdentity/u,
  );
  assert.match(
    transport,
    /if \(exactScope !== null\) socketUrl\.searchParams\.set\("projectId", exactScope\.projectId\)/u,
  );
  assert.match(
    transport,
    /accessToken: exactScope === null \? null : scopedNotificationCredential\(\)/u,
  );
  const fetchGuard = transport.indexOf(
    'if (exactScope === null) throw new Error("NOTIFICATION_SCOPE_MISSING")',
  );
  const fetch = transport.indexOf("const items = await fetchDurableInbox(");
  assert.ok(fetchGuard >= 0 && fetch > fetchGuard);
  assert.match(
    transport,
    /fetchDurableInbox\([\s\S]+exactScope\.projectId,[\s\S]+exactScope\.userId/u,
  );
  assert.match(
    transport,
    /prepareNotifications:[\s\S]+notices\.some\(\(notice\) => !notificationRouteMatchesScope\(notice, exactScope\)\)/u,
  );
  assert.match(
    transport,
    /showNotification:[\s\S]+!notificationRouteMatchesScope\(notice, exactScope\)[\s\S]+return showNativeNotification\(notice, true\)/u,
  );

  const queue = source.slice(
    source.indexOf("function queueOrActivateGlobalNotification("),
    source.indexOf("function drainPendingNotificationActivations()"),
  );
  assert.match(
    queue,
    /notificationIdentityReady && currentNotificationScope\(\) !== null[\s\S]+pendingNotificationActivations\.enqueue/u,
  );
  const drain = source.slice(
    source.indexOf("function drainPendingNotificationActivations()"),
    source.indexOf("function releaseActiveNativeNotification("),
  );
  assert.match(
    drain,
    /if \(currentNotificationScope\(\) === null\) \{[\s\S]+return;[\s\S]+pendingNotificationActivations\.drain\(\)/u,
  );
  const sync = source.slice(
    source.indexOf("function syncNotificationCredential()"),
    source.indexOf("function sendUpdateState("),
  );
  assert.match(sync, /transport\?\.updateAccessToken\(scopedNotificationCredential\(\)\)/u);
  assert.match(sync, /syncNotificationActivationReadiness\(\)/u);
});
