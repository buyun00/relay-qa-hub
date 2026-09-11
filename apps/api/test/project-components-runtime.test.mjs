import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { SqliteStorageWorker, projectMembershipId } from "@relay-qa-hub/storage";
import { ProjectManagementService } from "../dist/project-management.js";
import {
  ProjectComponentsRuntime,
  registerProjectComponentRoutes,
} from "../dist/project-components-runtime.js";

// Contract and persistence tests with an injected HTTP transport. These do not
// claim a real Jenkins build, uploader binary execution, or deployed integration.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "qa-component-contract-"));
  const accountId = randomUUID(),
    gmUserId = randomUUID(),
    a = randomUUID(),
    b = randomUUID();
  const worker = new SqliteStorageWorker({
    databaseFile: join(root, "qa.sqlite"),
    backupRoot: join(root, "backups"),
    busyTimeoutMs: 1000,
  });
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await worker.close();
    await rm(root, { recursive: true, force: true });
  });
  const at = new Date().toISOString();
  await worker.ensureMobileScope({
    accountId,
    projectId: a,
    projectKey: "TESTA",
    projectName: "A",
    actorId: gmUserId,
    actorDisplayName: "GM",
    membershipId: projectMembershipId(a, gmUserId),
    createdAt: at,
  });
  const management = new ProjectManagementService({ worker, accountId, gmUserId });
  const gm = { accountId, userId: gmUserId, isGm: true };
  await management.execute(gm, { operation: "create", projectId: b, key: "TESTB", name: "B" });
  const actualB = (await management.execute(gm, { operation: "list" })).items.find(
    (p) => p.key === "TESTB",
  ).id;
  const credentials = join(root, "credentials");
  await mkdir(credentials);
  await writeFile(
    join(credentials, "test-build.json"),
    JSON.stringify({ username: "contract-user", apiToken: "contract-token" }),
  );
  const calls = [],
    posted = new Set();
  const response = (value) => new Response(JSON.stringify(value));
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ origin: url.origin, path: url.pathname, method: init.method ?? "GET" });
    if (url.hostname.startsWith("artifact-")) {
      assert.equal(new Headers(init.headers).has("authorization"), false);
      return new Response("verified fixture artifact bytes");
    }
    if (url.pathname === "/crumbIssuer/api/json")
      return response({ crumbRequestField: "Jenkins-Crumb", crumb: "fixture" });
    if (url.pathname === "/job/test/api/json")
      return response({
        buildable: true,
        property: [{ parameterDefinitions: [{ name: "mode", choices: ["preview"] }] }],
        builds: posted.has(url.origin)
          ? [
              {
                number: 21,
                queueId: 12,
                timestamp: Date.now(),
                duration: 1000,
                estimatedDuration: 1000,
                building: false,
                result: "SUCCESS",
                actions: [],
              },
            ]
          : [],
      });
    if (url.pathname === "/job/test/buildWithParameters") {
      posted.add(url.origin);
      return new Response(null, {
        status: 201,
        headers: { location: `${url.origin}/queue/item/12/` },
      });
    }
    if (url.pathname.endsWith("/consoleText"))
      return new Response("00:00:01.000 Finished: SUCCESS");
    throw new Error(`Unexpected contract request ${url.pathname}`);
  };
  const options = {
    root: join(root, "runtime"),
    credentialRoot: credentials,
    instanceId: "contract-test",
    worker,
    management,
    fetch: fetcher,
    uploaderExecutable: join(root, "never-run.exe"),
    executionHeld: () => held,
  };
  let held = false;
  runtime = new ProjectComponentsRuntime(options);
  const config = (label) => ({
    baseUrl: `http://jenkins-${label}.invalid`,
    job: "test",
    downloadOrigin: `http://artifact-${label}.invalid`,
    zipPath: "/latest.zip",
    artifactUrlTemplate: `http://artifact-${label}.invalid/{buildNumber}.zip`,
    credentialRef: "test-build",
    presets: { preview: { mode: "preview" } },
  });
  const set = async (projectId, enabled, version, value) =>
    management.execute(gm, {
      operation: "setComponent",
      projectId,
      componentKey: "build",
      enabled,
      expectedVersion: version,
      config: value,
    });
  return {
    a,
    b: actualB,
    gmUserId,
    calls,
    config,
    set,
    options,
    setHeld(value) {
      held = value;
    },
    get runtime() {
      return runtime;
    },
    async restartWithoutCredentials() {
      await runtime.close();
      await rm(join(credentials, "test-build.json"));
      runtime = new ProjectComponentsRuntime(options);
    },
  };
}

test("project build queue pauses without replay; running task retains original version and verified artifact", async (t) => {
  const f = await fixture(t);
  await f.set(f.a, true, 0, f.config("a"));
  await f.set(f.b, true, 0, f.config("b"));
  const a = await f.runtime.enqueueBuild(f.a, f.gmUserId, randomUUID(), { preset: "preview" });
  const b = await f.runtime.enqueueBuild(f.b, f.gmUserId, randomUUID(), { preset: "preview" });
  assert.equal(a.state, "queued");
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.runtime.buildTask(f.a, b.id), { code: "NOT_FOUND" });
  await f.set(f.a, false, 1, f.config("a"));
  assert.equal((await f.runtime.buildTask(f.a, a.id)).state, "paused");
  await f.set(f.a, true, 2, f.config("a-new"));
  await f.runtime.tick();
  assert.equal((await f.runtime.buildTask(f.a, a.id)).state, "paused");
  assert.equal((await f.runtime.buildTask(f.b, b.id)).state, "running");
  await f.set(f.b, false, 1, f.config("b-new"));
  await assert.rejects(
    f.runtime.enqueueBuild(f.b, f.gmUserId, randomUUID(), { preset: "preview" }),
    { code: "COMPONENT_DISABLED" },
  );
  await f.runtime.tick();
  const finished = await f.runtime.buildTask(f.b, b.id);
  assert.equal(finished.state, "succeeded");
  assert.equal(finished.componentVersion, 1);
  assert.equal(
    finished.result.artifact.sha256,
    createHash("sha256").update("verified fixture artifact bytes").digest("hex"),
  );
  assert.ok(
    f.calls.every((call) =>
      ["http://jenkins-b.invalid", "http://artifact-b.invalid"].includes(call.origin),
    ),
  );
  assert.ok(f.calls.every((call) => !call.origin.includes("b-new")));
  const count = f.calls.length;
  assert.equal((await f.runtime.listBuildTasks(f.b)).items.length, 1);
  assert.deepEqual((await f.runtime.productionHistory(f.a)).items, []);
  assert.deepEqual((await f.runtime.qingyuHistory(f.a)).items, []);
  await f.restartWithoutCredentials();
  assert.equal((await f.runtime.buildTask(f.b, b.id)).state, "succeeded");
  assert.equal((await f.runtime.buildTask(f.a, a.id)).state, "paused");
  assert.equal(f.calls.length, count, "local history never connects or requires credential files");
});

test("missing or escaping project configuration refuses execution before network", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.runtime.enqueueBuild(f.a, f.gmUserId, randomUUID(), { preset: "preview" }),
    { code: "COMPONENT_DISABLED" },
  );
  await f.set(f.a, true, 0, { ...f.config("a"), credentialRef: "../outside" });
  await assert.rejects(
    f.runtime.enqueueBuild(f.a, f.gmUserId, randomUUID(), { preset: "preview" }),
    { code: "CREDENTIAL_REFERENCE_INVALID" },
  );
  await f.set(f.a, true, 1, {
    ...f.config("a"),
    artifactUrlTemplate: "http://artifact-a.invalid/latest.zip",
  });
  await assert.rejects(
    f.runtime.enqueueBuild(f.a, f.gmUserId, randomUUID(), { preset: "preview" }),
    { code: "BUILD_ARTIFACT_NOT_BOUND" },
  );
  assert.equal(f.calls.length, 0);
});

test("import execution hold prevents submission, retry and polling while local history remains readable", async (t) => {
  const f = await fixture(t);
  await f.set(f.a, true, 0, f.config("a"));
  const task = await f.runtime.enqueueBuild(f.a, f.gmUserId, randomUUID(), { preset: "preview" });
  await f.runtime.tick();
  assert.equal((await f.runtime.buildTask(f.a, task.id)).state, "running");
  const calls = f.calls.length;
  f.setHeld(true);
  await f.runtime.tick();
  assert.equal(f.calls.length, calls, "held runtime does not poll an imported running job");
  assert.equal((await f.runtime.listBuildTasks(f.a)).items.length, 1);
  assert.deepEqual((await f.runtime.productionHistory(f.a)).items, []);
  assert.deepEqual((await f.runtime.qingyuHistory(f.a)).items, []);
  assert.equal((await f.runtime.packaging(f.a)).jenkins, null);
  for (const attempt of [
    () => f.runtime.enqueueBuild(f.a, f.gmUserId, randomUUID(), { preset: "preview" }),
    () => f.runtime.buildAction(f.a, f.gmUserId, task.id, "resume"),
    () => f.runtime.uploadOperation(f.a, f.gmUserId, "enqueue", {}),
    () => f.runtime.uploadOperation(f.a, f.gmUserId, "confirm", {}, randomUUID(), randomUUID()),
    () => f.runtime.productionOperation(f.a, f.gmUserId, "retry", {}, "a".repeat(64)),
    () => f.runtime.qingyuOperation(f.a, f.gmUserId, "poll"),
  ])
    await assert.rejects(attempt(), { code: "IMPORT_EXECUTION_HELD" });
  assert.equal(f.calls.length, calls);
  f.setHeld(false);
  await f.runtime.tick();
  assert.equal((await f.runtime.buildTask(f.a, task.id)).state, "succeeded");
});

test("Relay actions retain the task's original component endpoint after configuration changes", async (t) => {
  const f = await fixture(t);
  const taskId = randomUUID(),
    requests = [];
  await writeFile(
    join(f.options.credentialRoot, "test-relay.json"),
    JSON.stringify({ bearerToken: "fixture-only" }),
  );
  f.options.storesForProject = (projectId) => ({
    bugs: {},
    relay: {},
    attachments: {},
    qingyuLinks: {},
    projects: {
      getProjectAccess: async ({ actorId }) => ({
        projectId,
        projectKey: "LOCAL",
        actorId,
        actorName: "GM",
        roles: ["developer"],
      }),
      listProjects: async () => ({
        items: [{ id: projectId, key: "LOCAL", roles: ["developer"] }],
      }),
      listMembers: async () => ({ items: [] }), // The configured GM is allowed without an ordinary membership.
    },
  });
  f.options.fetch = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ origin: url.origin, path: url.pathname, method: init.method });
    const body = url.pathname.endsWith("/project")
      ? { models: { "gpt-5.6-sol": ["xhigh"] } }
      : init.method === "GET"
        ? { task: { id: taskId, updatedAt: "2026-09-09T00:00:00.000Z" } }
        : { taskId, status: "queued" };
    return new Response(JSON.stringify(body));
  };
  const configure = (baseUrl, expectedVersion) =>
    f.options.management.execute(
      { userId: f.gmUserId, accountId: f.options.management.options.accountId, isGm: true },
      {
        operation: "setComponent",
        projectId: f.a,
        componentKey: "relay.production",
        enabled: true,
        expectedVersion,
        config: {
          baseUrl,
          externalProjectId: "REMOTE",
          relayInstanceId: "relay-fixture",
          credentialRef: "test-relay",
        },
      },
    );
  const finished = async (id) => {
    for (let i = 0; i < 100; i++) {
      const batch = (await f.runtime.productionHistory(f.a)).items.find((item) => item.id === id);
      if (["completed", "failed"].includes(batch.state)) {
        assert.equal(batch.state, "completed", JSON.stringify(batch));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Fixture batch did not finish");
  };
  await configure("https://relay-old.invalid", 0);
  const created = await f.runtime.productionOperation(f.a, f.gmUserId, "submit", {
    requestId: randomUUID(),
    kind: "create",
    items: [{ title: "Fixture", message: "Fixture task", uploadIds: [] }],
  });
  await finished(created.id);
  const listed = await f.runtime.productionOperation(f.a, f.gmUserId, "batches");
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].id, created.id);
  assert.equal(listed.items[0].kind, "create");
  assert.equal(listed.items[0].items.length, 1);
  assert.equal("result" in listed.items[0], false);
  assert.equal(
    (await f.runtime.productionOperation(f.a, f.gmUserId, "batch", undefined, created.id)).id,
    created.id,
  );
  const otherActorId = randomUUID();
  const other = await f.runtime.productionOperation(f.a, otherActorId, "submit", {
    requestId: randomUUID(),
    kind: "create",
    items: [{ title: "Other fixture", message: "Other actor task", uploadIds: [] }],
  });
  await finished(other.id);
  assert.deepEqual(
    (await f.runtime.productionOperation(f.a, f.gmUserId, "batches")).items.map((item) => item.id),
    [created.id],
  );
  assert.deepEqual(
    (await f.runtime.productionOperation(f.a, otherActorId, "batches")).items.map(
      (item) => item.id,
    ),
    [other.id],
  );
  await assert.rejects(
    f.runtime.productionOperation(f.a, f.gmUserId, "batch", undefined, other.id),
    { code: "NOT_FOUND" },
  );
  await configure("https://relay-new.invalid", 1);
  const boundary = requests.length;
  const continued = await f.runtime.productionOperation(f.a, f.gmUserId, "submit", {
    requestId: randomUUID(),
    kind: "action",
    items: [
      {
        taskId,
        action: "continue",
        expectedUpdatedAt: "2026-09-09T00:00:00.000Z",
        message: "Continue fixture",
        uploadIds: [],
        selectedAttachmentIds: [],
      },
    ],
  });
  await finished(continued.id);
  assert.equal(continued.componentVersion, 1);
  assert.ok(requests.slice(boundary).length > 0);
  assert.ok(
    requests.slice(boundary).every((request) => request.origin === "https://relay-old.invalid"),
  );
});

test("build-upload enqueue returns the persisted queued chain and performs no external execution", async (t) => {
  const f = await fixture(t);
  f.options.uploaderExecutable = fileURLToPath(
    new URL("../../desktop/vendor/ozdqp-uploader/ozdqp-uploader.exe", import.meta.url),
  );
  await writeFile(
    join(f.options.credentialRoot, "test-upload.json"),
    JSON.stringify({
      kind: "email",
      account: "fixture",
      accessToken: "fixture-token",
      refreshToken: "",
      password: "",
    }),
  );
  await f.set(f.a, true, 0, f.config("a"));
  const configure = (componentKey, config) =>
    f.options.management.execute(
      { userId: f.gmUserId, accountId: f.options.management.options.accountId, isGm: true },
      {
        operation: "setComponent",
        projectId: f.a,
        componentKey,
        enabled: true,
        expectedVersion: 0,
        config,
      },
    );
  await configure("upload.incremental", {
    apiBase: "https://upload.fixture.invalid",
    loginBase: "https://login.fixture.invalid",
    sourceUrl: "https://artifact.fixture.invalid/source/increment.zip",
    targetPrefix: "preview/test/pkg/",
    testDirectoryPrefix: "preview/test/dir/",
    releaseDirectoryPrefix: "preview/release/dir/",
    credentialRef: "test-upload",
    defaults: { productId: "2002", channelId: "1002", belongName: "Fixture", testerId: 1 },
  });
  await configure("build_upload.single", { buildPreset: "preview" });
  const id = randomUUID();
  const chain = await f.runtime.uploadOperation(
    f.a,
    f.gmUserId,
    "build",
    { mode: "prepare_publish" },
    id,
  );
  assert.equal(chain.id, id);
  assert.equal(chain.projectId, f.a);
  assert.equal(chain.status, "queued");
  assert.equal((await f.runtime.uploadChains(f.a, f.gmUserId))[0].id, id);
  assert.equal(f.calls.length, 0);
});

test("component HTTP routes preserve JSON string receipts and accept batch and outbox identifiers", async (t) => {
  const app = Fastify(),
    projectId = randomUUID(),
    actorId = randomUUID(),
    jobId = randomUUID(),
    batchId = "a".repeat(64);
  const runtime = {
    options: { management: { execute: async () => ({}) } },
    start() {},
    async close() {},
    uploadOperation: async () => jobId,
    productionOperation: async (_project, _actor, operation, _body, id) => ({ id, operation }),
    relayQueue: async (_project, _actor, _operation, id) => ({ id }),
  };
  registerProjectComponentRoutes(app, {
    runtime,
    projectId: () => projectId,
    actor: () => ({ userId: actorId }),
  });
  t.after(async () => {
    await app.close();
    await runtime.close();
  });
  const created = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/increment-upload/jobs`,
    payload: {},
  });
  assert.match(created.headers["content-type"], /^application\/json/);
  assert.equal(created.json(), jobId);
  const batch = await app.inject({
    url: `/api/v1/projects/${projectId}/production/batches/${batchId}`,
  });
  assert.equal(batch.statusCode, 200);
  assert.equal(batch.json().id, batchId);
  const resumed = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/production/outbox/${jobId}/resume`,
    payload: {},
  });
  assert.equal(resumed.statusCode, 200);
  assert.equal(resumed.json().id, jobId);
});

test("iOS project source keeps its directory separator for scoped listing and ZIP resolution", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.options.credentialRoot, "test-ios.json"),
    JSON.stringify({ kind: "email", account: "fixture", accessToken: "fixture-only" }),
  );
  await f.options.management.execute(
    { userId: f.gmUserId, accountId: f.options.management.options.accountId, isGm: true },
    {
      operation: "setComponent",
      projectId: f.a,
      componentKey: "upload.incremental",
      enabled: true,
      expectedVersion: 0,
      config: {
        apiBase: "https://upload.fixture.invalid",
        loginBase: "https://login.fixture.invalid",
        sourceUrl: "https://artifact.fixture.invalid/project-ios/",
        sourceKind: "ios_directory",
        targetPrefix: "ios/test/pkg/",
        testDirectoryPrefix: "ios/test/dir/",
        releaseDirectoryPrefix: "ios/release/dir/",
        credentialRef: "test-ios",
        defaults: { productId: "9001", channelId: "9002", belongName: "Fixture iOS", testerId: 1 },
      },
    },
  );
  assert.equal(
    (await f.runtime.uploadSnapshot(f.a, f.gmUserId)).sourceUrl,
    "https://artifact.fixture.invalid/project-ios/",
  );
  assert.equal(f.calls.length, 0);
});
