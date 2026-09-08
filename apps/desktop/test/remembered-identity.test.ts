import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopBrowserSessionCookieStore } from "../src/network.js";
import {
  RememberedIdentityStore,
  type RememberedIdentityFileSystem,
} from "../src/remembered-identity.js";

const serviceOrigin = "http://127.0.0.1:4419";
const first = {
  displayName: "First employee",
  projectId: "10000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000001",
  identity: "employee",
};
const second = {
  displayName: "Second employee",
  projectId: "10000000-0000-4000-8000-000000000002",
  userId: "20000000-0000-4000-8000-000000000002",
  identity: "employee",
};
const serialized = (principal = first) => ({
  schemaVersion: 2,
  serviceOrigin,
  loginName: principal.displayName,
  projectId: principal.projectId,
  userId: principal.userId,
  identity: principal.identity,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function fixture(overrides: Partial<RememberedIdentityFileSystem> = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "qa-hub-identity-race-"));
  const filePath = path.join(directory, "remembered-login-name.json");
  const session = new DesktopBrowserSessionCookieStore();
  session.rememberPrincipal(first);
  const store = new RememberedIdentityStore(filePath, serviceOrigin, session, {
    ...fs,
    ...overrides,
  });
  return { directory, filePath, session, store };
}
const read = async (filePath: string) => JSON.parse(await fs.readFile(filePath, "utf8"));

test("logout removes a pending old write and restart cannot restore its identity", async () => {
  const started = deferred(),
    release = deferred();
  const state = await fixture({
    async writeFile(...args) {
      started.resolve();
      await release.promise;
      await fs.writeFile(...args);
    },
  });
  const oldWrite = state.store.persist();
  await started.promise;
  state.session.clearLoginName();
  const logout = state.store.persist();
  release.resolve();
  await Promise.all([oldWrite, logout]);
  assert.deepEqual(await fs.readdir(state.directory), []);
  const restart = new DesktopBrowserSessionCookieStore();
  await assert.rejects(new RememberedIdentityStore(state.filePath, serviceOrigin, restart).load(), {
    code: "ENOENT",
  });
  assert.equal(restart.rememberedLoginName(), null);
});

test("switching identity during mkdir persists one complete new snapshot", async () => {
  const started = deferred(),
    release = deferred();
  let calls = 0;
  const state = await fixture({
    async mkdir(...args) {
      if (++calls === 1) {
        started.resolve();
        await release.promise;
      }
      return fs.mkdir(...args);
    },
  });
  const oldWrite = state.store.persist();
  await started.promise;
  state.session.beginAuthenticationChange();
  state.session.rememberPrincipal(second);
  const newWrite = state.store.persist();
  release.resolve();
  await Promise.all([oldWrite, newWrite]);
  assert.deepEqual(await read(state.filePath), serialized(second));
  assert.deepEqual(await fs.readdir(state.directory), [path.basename(state.filePath)]);
});

test("logout delete is serialized after a rename already in progress", async () => {
  const started = deferred(),
    release = deferred();
  let deleted = false;
  const state = await fixture({
    async rename(...args) {
      started.resolve();
      await release.promise;
      await fs.rename(...args);
    },
    async rm(filePath, options) {
      if (!filePath.includes(".pending-")) deleted = true;
      await fs.rm(filePath, options);
    },
  });
  const oldWrite = state.store.persist();
  await started.promise;
  state.session.clearLoginName();
  const logout = state.store.persist();
  await Promise.resolve();
  assert.equal(deleted, false);
  release.resolve();
  await Promise.all([oldWrite, logout]);
  assert.equal(deleted, true);
  assert.deepEqual(await fs.readdir(state.directory), []);
});

test("scope change invalidates pending write even before a new persist is requested", async () => {
  const started = deferred(),
    release = deferred();
  const state = await fixture({
    async writeFile(...args) {
      started.resolve();
      await release.promise;
      await fs.writeFile(...args);
    },
  });
  const oldWrite = state.store.persist();
  await started.promise;
  state.session.beginProjectRequest(second.projectId);
  release.resolve();
  await oldWrite;
  assert.deepEqual(await fs.readdir(state.directory), []);
});

test("a failed temporary write preserves committed identity and permits the next write", async () => {
  let failWrite = true;
  const state = await fixture({
    async writeFile(filePath, contents, options) {
      if (failWrite) {
        await fs.writeFile(filePath, contents.slice(0, 15), options);
        throw new Error("fixture write failure");
      }
      await fs.writeFile(filePath, contents, options);
    },
  });
  await fs.writeFile(state.filePath, JSON.stringify(serialized(first)));
  state.session.rememberPrincipal(second);
  await assert.rejects(state.store.persist(), /fixture write failure/u);
  assert.deepEqual(await read(state.filePath), serialized(first));
  assert.deepEqual(await fs.readdir(state.directory), [path.basename(state.filePath)]);
  failWrite = false;
  await state.store.persist();
  assert.deepEqual(await read(state.filePath), serialized(second));
});

test("load delayed across logout cannot restore the previously saved employee", async () => {
  const started = deferred(),
    release = deferred();
  const state = await fixture({
    async readFile(...args) {
      const value = await fs.readFile(...args);
      started.resolve();
      await release.promise;
      return value;
    },
  });
  await fs.writeFile(state.filePath, JSON.stringify(serialized(first)));
  const loading = state.store.load();
  await started.promise;
  state.session.clearLoginName();
  await state.store.persist();
  release.resolve();
  await loading;
  assert.equal(state.session.snapshot(), JSON.stringify([null, null, null, null]));
  assert.deepEqual(await fs.readdir(state.directory), []);
});

test("load rejects an unrelated service or incomplete identity without partial mutation", async () => {
  const state = await fixture();
  state.session.rememberPrincipal(second);
  for (const invalid of [
    { ...serialized(), serviceOrigin: "http://127.0.0.1:4319" },
    { ...serialized(), schemaVersion: 1 },
    { ...serialized(), userId: null },
    { ...serialized(), projectId: null },
    { ...serialized(), identity: "unknown" },
    { ...serialized(), loginName: "\u0000" },
  ]) {
    await fs.writeFile(state.filePath, JSON.stringify(invalid));
    await assert.rejects(state.store.load(), /IDENTITY_FILE_INVALID/u);
    assert.equal(state.session.rememberedLoginName(), second.displayName);
    assert.equal(state.session.rememberedUserId(), second.userId);
  }
});

test("load preserves explicit GM identity and ignores extra principal override fields", async () => {
  const state = await fixture();
  await fs.writeFile(
    state.filePath,
    JSON.stringify({
      ...serialized(),
      identity: "gm",
      projectId: null,
      isGm: false,
    }),
  );
  const session = new DesktopBrowserSessionCookieStore();
  const store = new RememberedIdentityStore(state.filePath, serviceOrigin, session);
  await store.load();
  assert.equal(session.rememberedIdentity(), "gm");
  assert.equal(session.rememberedProjectId(), null);
  await store.persist();
  assert.deepEqual(await read(state.filePath), {
    ...serialized(),
    identity: "gm",
    projectId: null,
  });
});
