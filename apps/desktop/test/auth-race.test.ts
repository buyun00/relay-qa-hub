import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopQaHubApiClient, QaHubMcpTools } from "../src/mcp-api.js";
import { DesktopBrowserSessionCookieStore, proxyRendererApiRequest } from "../src/network.js";
import { parseDesktopConfig } from "../src/config.js";

const config = parseDesktopConfig({
  QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
  QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
  QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
});
const first = {
  accountId: "10000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000001",
  projectId: "30000000-0000-4000-8000-000000000001",
  displayName: "First employee",
  identity: "employee",
  isGm: false,
  csrfToken: "fixture-csrf",
};
const second = {
  ...first,
  userId: "20000000-0000-4000-8000-000000000002",
  projectId: "30000000-0000-4000-8000-000000000002",
  displayName: "Second employee",
};
const gm = { ...second, displayName: "Fixture GM", identity: "gm", isGm: true };
const cookie = (value: string) => `qa_hub_browser_session=${value.repeat(43)}; Path=/; HttpOnly`;
function json(value: unknown, status = 200, setCookie?: string): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      ...(setCookie ? { "set-cookie": setCookie } : {}),
    },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function seededSession() {
  const store = new DesktopBrowserSessionCookieStore();
  store.rememberPrincipal(first);
  store.captureSetCookie(cookie("A"));
  return store;
}
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("stale operation unexpectedly succeeded");
    },
    (error: { code?: string }) => error,
  );

async function recoveryRace(
  action: "logout" | "gm" | "employee",
  surface: "renderer" | "mcp",
  lateResult: "success" | "rejected" | "network" = "success",
) {
  const store = seededSession();
  const recovery = deferred<Response>();
  const recoveryStarted = deferred<void>();
  const old401 = deferred<Response>();
  const old401Started = deferred<void>();
  let readCount = 0,
    recoveryCount = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const pathname = url.pathname;
    if (pathname === "/api/v1/auth/me") return json(first);
    if (pathname === "/api/v1/auth/login") {
      const body = JSON.parse(String(init?.body));
      if (body.name === first.displayName) {
        recoveryCount += 1;
        recoveryStarted.resolve();
        return recovery.promise;
      }
      return json(second, 200, cookie("C"));
    }
    if (pathname === "/api/v1/auth/gm/login") return json(gm, 200, cookie("G"));
    if (pathname === "/api/v1/auth/logout")
      return json({}, 200, "qa_hub_browser_session=; Max-Age=0");
    if (pathname === "/api/v1/bugs") {
      readCount += 1;
      if (url.searchParams.get("old") === "2") {
        old401Started.resolve();
        return old401.promise;
      }
      return json({ code: "NATIVE_SESSION_INVALID" }, 401);
    }
    throw new Error("Unexpected fixture URL");
  };
  const client = new DesktopQaHubApiClient(config, store, fetchImpl);
  const staleFirst = rejection(client.json("/api/v1/bugs?old=1"));
  const staleSecond = rejection(client.json("/api/v1/bugs?old=2"));
  await Promise.all([recoveryStarted.promise, old401Started.promise]);
  const authPath =
    action === "gm"
      ? "/api/v1/auth/gm/login"
      : `/api/v1/auth/${action === "logout" ? "logout" : "login"}`;
  const body =
    action === "employee"
      ? { name: second.displayName, projectId: second.projectId, client: "web" }
      : {};
  if (surface === "mcp") await client.json(authPath, { method: "POST", body });
  else {
    const response = await proxyRendererApiRequest(
      new Request(`qa-hub-preview://app${authPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      config,
      store,
      { fetchImpl },
    );
    assert.equal(response.status, 200);
  }
  const expectedSnapshot = store.snapshot();
  const expectedCookie = store.cookieHeader(null);
  if (action === "logout") assert.equal(expectedSnapshot, "[null,null,null,null]");
  else assert.equal(store.rememberedUserId(), second.userId);
  old401.resolve(
    json({ code: "NATIVE_SESSION_INVALID" }, 401, "qa_hub_browser_session=; Max-Age=0"),
  );
  assert.equal((await staleSecond).code, "QA_HUB_SESSION_CHANGED");
  if (lateResult === "network") recovery.reject(new Error("fixture network failure"));
  else
    recovery.resolve(
      lateResult === "rejected"
        ? json({ code: "UNAUTHENTICATED" }, 401, "qa_hub_browser_session=; Max-Age=0")
        : json(first, 200, cookie("R")),
    );
  assert.equal((await staleFirst).code, "QA_HUB_SESSION_CHANGED");
  assert.equal(store.snapshot(), expectedSnapshot);
  assert.equal(store.cookieHeader(null), expectedCookie);
  assert.equal(recoveryCount, 1, "late 401 must not create another recovery");
  assert.equal(readCount, 2, "old API operations must not replay with the new identity");
  if (action === "logout")
    await assert.rejects(client.json("/api/v1/auth/me"), { code: "QA_HUB_LOGIN_REQUIRED" });
}

for (const surface of ["renderer", "mcp"] as const) {
  for (const action of ["logout", "gm", "employee"] as const) {
    test(`${surface} ${action} invalidates late employee recovery and concurrent old 401`, () =>
      recoveryRace(action, surface));
  }
}
for (const result of ["rejected", "network"] as const) {
  test(`late ${result} recovery preserves the newer GM identity`, () =>
    recoveryRace("gm", "mcp", result));
}

test("a pending explicit login cannot start another passwordless recovery", async () => {
  const store = seededSession();
  const login = deferred<Response>();
  const started = deferred<void>();
  let recoveryRequests = 0;
  const client = new DesktopQaHubApiClient(config, store, async (input) => {
    if (new URL(input.toString()).pathname === "/api/v1/auth/gm/login") {
      started.resolve();
      return login.promise;
    }
    if (new URL(input.toString()).pathname === "/api/v1/auth/login") recoveryRequests += 1;
    return json({ code: "NATIVE_SESSION_INVALID" }, 401);
  });
  const changing = client.json("/api/v1/auth/gm/login", { method: "POST", body: {} });
  await started.promise;
  await assert.rejects(client.json("/api/v1/bugs"), { code: "QA_HUB_LOGIN_REQUIRED" });
  login.resolve(json(gm, 200, cookie("G")));
  await changing;
  assert.equal(recoveryRequests, 0);
  assert.equal(store.rememberedIdentity(), "gm");
});

test("a late renderer login cannot replace a newer explicit GM login", async () => {
  const store = seededSession();
  const late = deferred<Response>();
  const started = deferred<void>();
  const old = proxyRendererApiRequest(
    new Request("qa-hub-preview://app/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ name: first.displayName, projectId: first.projectId }),
    }),
    config,
    store,
    {
      fetchImpl: async () => {
        started.resolve();
        return late.promise;
      },
    },
  );
  await started.promise;
  const client = new DesktopQaHubApiClient(config, store, async () => json(gm, 200, cookie("G")));
  await client.json("/api/v1/auth/gm/login", { method: "POST", body: {} });
  late.resolve(json(first, 200, cookie("R")));
  assert.equal((await old).status, 409);
  assert.equal(store.rememberedIdentity(), "gm");
  assert.equal(store.cookieHeader(null), cookie("G").split(";")[0]);
});

test("renderer cookies cannot overwrite a main-process login or revive explicit logout", async () => {
  const store = seededSession();
  const client = new DesktopQaHubApiClient(config, store, async () => json(gm, 200, cookie("G")));
  await client.json("/api/v1/auth/gm/login", { method: "POST", body: {} });
  let forwarded: string | null = null;
  const rendererRead = () =>
    proxyRendererApiRequest(
      new Request("qa-hub-preview://app/api/v1/auth/me", {
        headers: { cookie: cookie("A").split(";")[0]! },
      }),
      config,
      store,
      {
        fetchImpl: async (_url, init) => {
          forwarded = new Headers(init?.headers).get("cookie");
          return json({});
        },
      },
    );
  await rendererRead();
  assert.equal(forwarded, cookie("G").split(";")[0]);
  await proxyRendererApiRequest(
    new Request("qa-hub-preview://app/api/v1/auth/logout", { method: "POST", body: "{}" }),
    config,
    store,
    {
      fetchImpl: async () => json({}, 200, "qa_hub_browser_session=; Max-Age=0"),
    },
  );
  await rendererRead();
  assert.equal(forwarded, null);
  assert.equal(store.cookieHeader(null), null);
  assert.equal(store.rememberedLoginName(), null);
});

async function materializeFixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "qa-preview-cache-epoch-"));
  const store = seededSession();
  const download = deferred<Response>();
  const started = deferred<void>();
  const bugId = "40000000-0000-4000-8000-000000000001",
    attachmentId = "50000000-0000-4000-8000-000000000001";
  const bytes = Buffer.from("project A fixture evidence");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const client = new DesktopQaHubApiClient(config, store, async (input, init) => {
    const pathname = new URL(input.toString()).pathname;
    if (pathname === "/api/v1/mcp/tools")
      return json({ tools: [{ name: "qa_materialize_attachment" }] });
    if (pathname === "/api/v1/auth/login") return json(second, 200, cookie("B"));
    if (pathname === "/api/v1/auth/me")
      return json(store.rememberedUserId() === first.userId ? first : second);
    assert.equal(new Headers(init?.headers).get("cookie"), cookie("A").split(";")[0]);
    if (pathname === `/api/v1/bugs/${bugId}`)
      return json({
        id: bugId,
        projectId: first.projectId,
        number: 1,
        key: "A-1",
        title: "A fixture",
        description: "A",
        expectedBehavior: "A",
        state: "reported",
        version: 1,
        ownerId: null,
      });
    if (pathname === `/api/v1/bugs/${bugId}/attachments`)
      return json({
        items: [
          {
            attachmentId,
            filename: "proof.txt",
            mediaType: "text/plain",
            size: bytes.length,
            sha256,
          },
        ],
      });
    if (pathname === `/api/v1/attachments/${attachmentId}`) {
      started.resolve();
      return download.promise;
    }
    throw new Error("Unexpected fixture URL");
  });
  const tools = new QaHubMcpTools(client, root, {
    sharedApi: true,
    serviceOrigin: config.apiBaseUrl.origin,
  });
  await tools.refreshDefinitions();
  const run = () =>
    tools.call("qa_materialize_attachment", { projectId: first.projectId, bugId, attachmentId });
  const release = () =>
    download.resolve(
      new Response(bytes, {
        headers: { "content-type": "text/plain", "x-content-sha256": sha256 },
      }),
    );
  const changeProject = async () => {
    const response = await proxyRendererApiRequest(
      new Request(`qa-hub-preview://app/api/v1/projects/${second.projectId}/modules`, {
        headers: { "x-qa-project-id": second.projectId },
      }),
      config,
      store,
      { fetchImpl: async () => json({ items: [] }) },
    );
    assert.equal(response.status, 200);
  };
  return { root, store, client, bytes, started, run, release, changeProject };
}

test("an unchanged materialize request caches bytes under its initiating principal", async () => {
  const fixture = await materializeFixture();
  const pending = fixture.run();
  await fixture.started.promise;
  fixture.release();
  const result = (await pending) as { localPath: string };
  const scope = createHash("sha256")
    .update(JSON.stringify([config.apiBaseUrl.origin, first.projectId, first.userId]))
    .digest("hex");
  assert.ok(result.localPath.includes(scope));
  assert.deepEqual(await fs.readFile(result.localPath), fixture.bytes);
});

for (const change of ["employee", "project"] as const) {
  test(`materialize refuses cached output after ${change} changes during download`, async () => {
    const fixture = await materializeFixture();
    const outcome = rejection(fixture.run());
    await fixture.started.promise;
    if (change === "employee")
      await fixture.client.json("/api/v1/auth/login", {
        method: "POST",
        body: { name: second.displayName, projectId: second.projectId },
      });
    else await fixture.changeProject();
    fixture.release();
    assert.equal((await outcome).code, "QA_HUB_SESSION_CHANGED");
    assert.deepEqual(
      await fs.readdir(fixture.root),
      [],
      "stale download must not populate either user's cache",
    );
  });
}

test("a switch during cache write preserves the initiating owner and withholds the old result", async () => {
  const fixture = await materializeFixture();
  const originalWrite = fs.writeFile;
  let writtenPath: string | undefined;
  fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
    await originalWrite(...args);
    if (String(args[0]).startsWith(fixture.root + path.sep)) {
      writtenPath = String(args[0]);
      await fixture.client.json("/api/v1/auth/login", {
        method: "POST",
        body: { name: second.displayName, projectId: second.projectId },
      });
    }
  }) as typeof fs.writeFile;
  try {
    const outcome = rejection(fixture.run());
    await fixture.started.promise;
    fixture.release();
    assert.equal((await outcome).code, "QA_HUB_SESSION_CHANGED");
    assert.ok(writtenPath);
    const initiatingScope = createHash("sha256")
      .update(JSON.stringify([config.apiBaseUrl.origin, first.projectId, first.userId]))
      .digest("hex");
    assert.ok(writtenPath.includes(initiatingScope));
    assert.deepEqual(await fs.readFile(writtenPath), fixture.bytes);
  } finally {
    fs.writeFile = originalWrite;
  }
});
