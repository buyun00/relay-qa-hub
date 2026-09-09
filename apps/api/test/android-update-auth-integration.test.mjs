import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { SqliteStorageWorker, projectMembershipId } from "@relay-qa-hub/storage";
import { createApiApp } from "../dist/app.js";
import { createSqliteBrowserAuthStore } from "../dist/browser-auth.js";
import { ProjectManagementService } from "../dist/project-management.js";
import { ProjectRequestContext } from "../dist/project-request-context.js";
import { createSqliteMobileBugStore } from "../dist/sqlite-mobile-bug-store.js";

// Synthetic transport bytes: this fixture does not claim APK signing or installation.
const apkName = "Relay-QA-Hub-Android-23-0.2.0-preview.9.apk";
const apkBytes = Buffer.from("anonymous-distribution-fixture\u0000\u0001", "utf8");

async function fixture(t, channel) {
  const directory = await mkdtemp(join(tmpdir(), "qa-android-auth-"));
  const feedRoot = join(directory, "feed");
  await mkdir(feedRoot);
  const worker = new SqliteStorageWorker({
    databaseFile: join(directory, "test.sqlite"),
    backupRoot: join(directory, "backups"),
    evidenceRoot: join(directory, "evidence"),
    quarantineRoot: join(directory, "quarantine"),
    busyTimeoutMs: 1000,
  });
  let app;
  t.after(async () => {
    await app?.close();
    await worker.close();
    const suffix = relative(tmpdir(), directory);
    assert(!isAbsolute(suffix) && !suffix.startsWith(".."));
    await rm(directory, { recursive: true, force: true });
  });
  const accountId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const bootstrap = {
    accountId,
    actorId,
    projectId,
    projectKey: "UPDATEA",
    actorDisplayName: "Isolated update GM",
    membershipId: projectMembershipId(projectId, actorId),
    createdAt: new Date().toISOString(),
  };
  await worker.ensureMobileScope(bootstrap);
  await worker.projectManagement({
    accountId,
    actorId,
    isGm: true,
    operation: "create",
    projectId: otherProjectId,
    key: "UPDATEB",
    name: "Update scope B",
    now: new Date().toISOString(),
  });
  const service = new ProjectManagementService({ accountId, gmUserId: actorId, worker });
  const context = new ProjectRequestContext();
  const scope = context.scope(bootstrap);
  const manifest = {
    schemaVersion: 1,
    ...(channel === "preview" ? { channel } : {}),
    versionCode: 23,
    versionName: "0.2.0-preview.9",
    packageName:
      channel === "preview"
        ? "com.relayqahub.android.preview.debug"
        : "com.relayqahub.android.debug",
    fileName: apkName,
    size: apkBytes.length,
    sha256: createHash("sha256").update(apkBytes).digest("hex"),
  };
  await writeFile(join(feedRoot, "latest.json"), JSON.stringify(manifest));
  await writeFile(join(feedRoot, apkName), apkBytes);
  app = createApiApp({
    logger: false,
    isolateLegacyComponents: true,
    androidUpdateRoot: feedRoot,
    ...(channel === "preview" ? { androidUpdateChannel: channel } : {}),
    projectManagementService: service,
    projectRequestContext: context,
    mobileBugStore: createSqliteMobileBugStore({ worker, scope }),
    browserAuth: {
      store: createSqliteBrowserAuthStore({ worker }),
      accountId,
      userId: actorId,
      actorId,
      adminEmail: "update-fixture@example.invalid",
      passwordlessLogin: async () => {
        throw new Error("Unscoped login refused");
      },
      projectLogin: (name, selected, stamp) => service.login(name, selected, stamp),
      sessionSecret: "isolated-android-distribution-test",
      cookieName: "qa-isolated-android-session",
      webOrigins: [],
      gm: { userId: actorId, password: "fixture-only-gm" },
    },
  });
  let guardedHandlerCalls = 0;
  const guardedHandler = () => {
    guardedHandlerCalls++;
    return { mustRemainProtected: true };
  };
  // Registered neighbors and the exact read template under a write method prove that
  // a URL prefix (or template alone without the method) cannot bypass the hook.
  app.get(`/api/v1/android-updates/${channel}/admin/:fileName`, guardedHandler);
  app.post(`/api/v1/android-updates/${channel}/:fileName`, guardedHandler);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  assert.equal(new URL(origin).hostname, "127.0.0.1");
  assert(![4174, 4274, 4319, 4320, 4419, 4420, 4421].includes(Number(new URL(origin).port)));
  return {
    get: (path, options) => fetch(origin + path, options),
    manifest,
    projectId,
    otherProjectId,
    guardedHandlerCalls: () => guardedHandlerCalls,
    writeManifest: (value) => writeFile(join(feedRoot, "latest.json"), JSON.stringify(value)),
  };
}

for (const channel of ["stable", "preview"]) {
  test(`real HTTP ${channel} distribution remains anonymous with actual browser auth and project context`, async (t) => {
    const f = await fixture(t, channel);
    const base = `/api/v1/android-updates/${channel}/`;
    const metadata = await f.get(base + "latest.json");
    assert.equal(metadata.status, 200, "Anonymous update metadata must pass the composed hooks");
    assert.deepEqual(await metadata.json(), f.manifest);
    assert.equal(metadata.headers.get("cache-control"), "no-store");
    for (const name of ["latest.json", apkName]) {
      const response = await f.get(base + name, { method: "HEAD" });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "");
    }
    const apk = await f.get(base + apkName);
    assert.equal(apk.status, 200);
    assert.deepEqual(Buffer.from(await apk.arrayBuffer()), apkBytes);
    const partial = await f.get(base + apkName, { headers: { range: "bytes=3-8" } });
    assert.equal(partial.status, 206);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), apkBytes.subarray(3, 9));
    const conditional = await f.get(base + "latest.json", {
      headers: { "if-none-match": metadata.headers.get("etag") },
    });
    assert.equal(conditional.status, 304);
    const unpublished = await f.get(base + "unpublished.apk");
    assert.equal(unpublished.status, 404);
    assert.deepEqual(await unpublished.json(), { code: "ANDROID_UPDATE_NOT_FOUND" });

    for (const path of [
      "/api/v1/projects",
      `/api/v1/bugs?projectId=${f.projectId}`,
      base + "admin/latest.json",
    ]) {
      const response = await f.get(path);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { code: "UNAUTHENTICATED" });
    }
    const write = await f.get(base + "latest.json", { method: "POST" });
    assert.equal(write.status, 401);
    assert.deepEqual(await write.json(), { code: "UNAUTHENTICATED" });
    assert.equal(f.guardedHandlerCalls(), 0);
    const otherChannel = channel === "preview" ? "stable" : "preview";
    assert.equal((await f.get(`/api/v1/android-updates/${otherChannel}/latest.json`)).status, 401);

    const login = await f.get("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: "android",
        name: "Update scope employee",
        projectId: f.projectId,
      }),
    });
    assert.equal(login.status, 200);
    const session = await login.json();
    const headers = { authorization: `Bearer ${session.accessToken}` };
    const allowed = await f.get(`/api/v1/bugs?projectId=${f.projectId}`, { headers });
    assert.equal(
      allowed.status,
      200,
      "Browser auth must establish the principal before the project hook",
    );
    assert.deepEqual((await allowed.json()).items, []);
    const denied = await f.get(`/api/v1/bugs?projectId=${f.otherProjectId}`, { headers });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { code: "PROJECT_NOT_ACCESSIBLE" });
    const mismatch = await f.get(`/api/v1/bugs?projectId=${f.projectId}`, {
      headers: { ...headers, "x-qa-project-id": f.otherProjectId },
    });
    assert.equal(mismatch.status, 400);
    assert.deepEqual(await mismatch.json(), { code: "PROJECT_MISMATCH" });
    const missingRoute = await f.get(`/api/v1/android-updates/${otherChannel}/latest.json`, {
      headers,
    });
    assert.equal(missingRoute.status, 404);
    assert.equal(f.guardedHandlerCalls(), 0);
    if (channel === "preview") {
      await f.writeManifest({ ...f.manifest, packageName: "com.relayqahub.android.debug" });
      const invalid = await f.get(base + "latest.json");
      assert.equal(invalid.status, 503);
      assert.deepEqual(await invalid.json(), { code: "ANDROID_UPDATE_METADATA_INVALID" });
    }
  });
}
