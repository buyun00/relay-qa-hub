import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseDesktopConfig } from "../src/config.js";
import { DesktopQaHubApiClient } from "../src/mcp-api.js";
import { DesktopBrowserSessionCookieStore, proxyRendererApiRequest } from "../src/network.js";
import {
  RememberedIdentityStore,
  persistRendererAuthenticationResponse,
  type RememberedIdentityFileSystem,
} from "../src/remembered-identity.js";

const config = parseDesktopConfig({
  QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
  QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
  QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
});
const first = {
  displayName: "First employee",
  projectId: "10000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000001",
  identity: "employee",
  isGm: false,
  csrfToken: "fixture-csrf",
};
const second = {
  ...first,
  displayName: "Second employee",
  projectId: "10000000-0000-4000-8000-000000000002",
  userId: "20000000-0000-4000-8000-000000000002",
};
const gm = { ...second, displayName: "Fixture GM", identity: "gm", isGm: true };
type Surface = "renderer" | "mcp";
type Action = "logout" | "employee" | "gm";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function observe<T>(promise: Promise<T>) {
  let settled = false;
  const outcome = promise.then(
    (value) => {
      settled = true;
      return { value, error: undefined };
    },
    (error: { code?: string; status?: number; message?: string }) => {
      settled = true;
      return { value: undefined, error };
    },
  );
  return { outcome, settled: () => settled };
}
async function fixture(overrides: Partial<RememberedIdentityFileSystem> = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "qa-auth-durability-"));
  const filePath = path.join(directory, "remembered-login-name.json");
  const session = new DesktopBrowserSessionCookieStore();
  session.rememberPrincipal(first);
  session.captureSetCookie(`qa_hub_browser_session=${"A".repeat(43)}`);
  await new RememberedIdentityStore(filePath, config.apiBaseUrl.origin, session).persist();
  const remembered = new RememberedIdentityStore(filePath, config.apiBaseUrl.origin, session, {
    ...fs,
    ...overrides,
  });
  const commitStarted = deferred();
  const persist = () => {
    commitStarted.resolve();
    return remembered.persist();
  };
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const pathname = new URL(input.toString()).pathname;
    requests.push(pathname);
    const principal = pathname.endsWith("/gm/login") ? gm : second;
    return new Response(
      JSON.stringify(
        pathname.endsWith("/logout") ? { ok: true } : pathname.endsWith("/me") ? first : principal,
      ),
      {
        headers: {
          "content-type": "application/json",
          ...(pathname.endsWith("/login")
            ? { "set-cookie": `qa_hub_browser_session=${"B".repeat(43)}` }
            : {}),
        },
      },
    );
  };
  const client = new DesktopQaHubApiClient(config, session, fetchImpl, persist);
  const run = async (surface: Surface, action: Action) => {
    const pathname = `/api/v1/auth/${action === "gm" ? "gm/login" : action === "employee" ? "login" : "logout"}`;
    if (surface === "mcp") return client.json(pathname, { method: "POST", body: {} });
    const response = await proxyRendererApiRequest(
      new Request(`qa-hub-preview://app${pathname}`, { method: "POST", body: "{}" }),
      config,
      session,
      { fetchImpl },
    );
    const committed = await persistRendererAuthenticationResponse(response, session, persist);
    const value = (await committed.json()) as { code?: string; message?: string };
    if (!committed.ok) throw { ...value, status: committed.status };
    return value;
  };
  return {
    directory,
    filePath,
    session,
    remembered,
    commitStarted,
    client,
    run,
    requests,
    fetchImpl,
  };
}

for (const surface of ["mcp", "renderer"] as const) {
  test(`${surface} logout success waits for a prior rename and durable deletion`, async () => {
    const renameStarted = deferred(),
      releaseRename = deferred();
    const state = await fixture({
      async rename(...args) {
        renameStarted.resolve();
        await releaseRename.promise;
        await fs.rename(...args);
      },
    });
    const oldWrite = state.remembered.persist();
    await renameStarted.promise;
    const logout = observe(state.run(surface, "logout"));
    await state.commitStarted.promise;
    assert.equal(logout.settled(), false);
    assert.equal(state.session.rememberedLoginName(), null);
    assert.equal(
      JSON.parse(await fs.readFile(state.filePath, "utf8")).loginName,
      first.displayName,
    );
    releaseRename.resolve();
    const result = await logout.outcome;
    await oldWrite;
    assert.equal(result.error, undefined);
    assert.deepEqual(result.value, { ok: true });
    assert.deepEqual(await fs.readdir(state.directory), []);
    const restarted = new DesktopBrowserSessionCookieStore();
    await assert.rejects(
      new RememberedIdentityStore(state.filePath, config.apiBaseUrl.origin, restarted).load(),
      { code: "ENOENT" },
    );
    assert.equal(restarted.rememberedLoginName(), null);
  });

  for (const action of ["employee", "gm"] as const) {
    test(`${surface} ${action} login success waits for the new identity rename`, async () => {
      const renameStarted = deferred(),
        releaseRename = deferred();
      const state = await fixture({
        async rename(...args) {
          renameStarted.resolve();
          await releaseRename.promise;
          await fs.rename(...args);
        },
      });
      const login = observe(state.run(surface, action));
      await renameStarted.promise;
      assert.equal(login.settled(), false);
      assert.equal(
        JSON.parse(await fs.readFile(state.filePath, "utf8")).loginName,
        first.displayName,
      );
      releaseRename.resolve();
      assert.equal((await login.outcome).error, undefined);
      const restarted = new DesktopBrowserSessionCookieStore();
      await new RememberedIdentityStore(state.filePath, config.apiBaseUrl.origin, restarted).load();
      assert.equal(restarted.rememberedIdentity(), action);
      assert.equal(restarted.rememberedLoginName(), (action === "gm" ? gm : second).displayName);
    });
  }

  for (const action of ["logout", "gm"] as const) {
    test(`${surface} ${action} reports persistence failure without undoing the new in-memory identity`, async () => {
      const state = await fixture({
        async rm(filePath, options) {
          if (!filePath.includes(".pending-"))
            throw new Error("synthetic private path must not leak");
          await fs.rm(filePath, options);
        },
        async rename() {
          throw new Error("synthetic private path must not leak");
        },
      });
      const result = await observe(state.run(surface, action)).outcome;
      assert.equal(result.error?.code, "QA_HUB_IDENTITY_PERSIST_FAILED");
      assert.equal(result.error?.status, 503);
      assert.match(result.error?.message ?? "", /not durably complete/u);
      assert.doesNotMatch(result.error?.message ?? "", /private path/u);
      assert.equal(state.session.rememberedIdentity(), action === "gm" ? "gm" : null);
      assert.equal(state.session.rememberedLoginName(), action === "gm" ? gm.displayName : null);
      assert.equal(
        JSON.parse(await fs.readFile(state.filePath, "utf8")).loginName,
        first.displayName,
      );
    });
  }
}

test("MCP login waits for a newer duplicate save of the same identity", async () => {
  const renameStarted = deferred(),
    releaseRename = deferred();
  const state = await fixture({
    async rename(...args) {
      renameStarted.resolve();
      await releaseRename.promise;
      await fs.rename(...args);
    },
  });
  let duplicate: Promise<void> | undefined;
  const client = new DesktopQaHubApiClient(config, state.session, state.fetchImpl, () => {
    const firstSave = state.remembered.persist();
    duplicate = state.remembered.persist();
    return firstSave;
  });
  const login = observe(client.json("/api/v1/auth/login", { method: "POST", body: {} }));
  await renameStarted.promise;
  assert.equal(login.settled(), false);
  releaseRename.resolve();
  assert.equal((await login.outcome).error, undefined);
  await duplicate;
  assert.equal(JSON.parse(await fs.readFile(state.filePath, "utf8")).loginName, second.displayName);
});

test("MCP employee recovery waits for durable identity before retrying the original read", async () => {
  const renameStarted = deferred(),
    releaseRename = deferred();
  const state = await fixture({
    async rename(...args) {
      renameStarted.resolve();
      await releaseRename.promise;
      await fs.rename(...args);
    },
  });
  state.session.captureSetCookie("qa_hub_browser_session=; Max-Age=0");
  const recovery = observe(state.client.json("/api/v1/auth/me"));
  await renameStarted.promise;
  assert.equal(recovery.settled(), false);
  assert.deepEqual(state.requests, ["/api/v1/auth/login"]);
  releaseRename.resolve();
  assert.equal((await recovery.outcome).error, undefined);
  assert.deepEqual(state.requests, ["/api/v1/auth/login", "/api/v1/auth/me"]);
});

test("an old auth persistence completion cannot return success in a newer session", async () => {
  const renameStarted = deferred(),
    releaseRename = deferred();
  let calls = 0;
  const state = await fixture({
    async rename(...args) {
      if (++calls === 1) {
        renameStarted.resolve();
        await releaseRename.promise;
      }
      await fs.rename(...args);
    },
  });
  const firstLogin = observe(state.run("mcp", "employee"));
  await renameStarted.promise;
  const gmLogin = observe(state.run("mcp", "gm"));
  while (state.session.rememberedIdentity() !== "gm")
    await new Promise<void>((resolve) => setImmediate(resolve));
  releaseRename.resolve();
  assert.equal((await firstLogin.outcome).error?.code, "QA_HUB_SESSION_CHANGED");
  assert.equal((await gmLogin.outcome).error, undefined);
  assert.equal(state.session.rememberedIdentity(), "gm");
  assert.equal(JSON.parse(await fs.readFile(state.filePath, "utf8")).identity, "gm");
});
