import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  SqliteStorageWorker,
  projectMembershipId,
  isImportExecutionHeld,
} from "@relay-qa-hub/storage";
import { ProjectManagementService } from "../dist/project-management.js";
import { ProjectRequestContext } from "../dist/project-request-context.js";
import { ProjectComponentsRuntime } from "../dist/project-components-runtime.js";
import { closeApiRuntime, createApiServer } from "../dist/server.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "qa-api-runtime-lifecycle-"));
  const accountId = randomUUID(),
    projectId = randomUUID(),
    actorId = randomUUID();
  const events = [],
    requests = [],
    cleanupFirst = [];
  const closeEntered = deferred(),
    tickCompleted = deferred();
  const holdFile = join(root, ".qa-hub-import-hold.json");
  let runtime,
    server,
    runtimeClosed = false,
    workerClosed = false;
  let startCalls = 0,
    closeCalls = 0,
    workerCloseCalls = 0;
  let transport = async () => {
    throw new Error("Fixture intercepted external request");
  };
  const worker = new SqliteStorageWorker({
    databaseFile: join(root, "qa.sqlite"),
    backupRoot: join(root, "backups"),
    busyTimeoutMs: 1000,
    executionHoldFile: holdFile,
  });
  const closeWorker = worker.close.bind(worker);
  worker.close = async () => {
    workerCloseCalls++;
    events.push("worker.close");
    await closeWorker();
    workerClosed = true;
  };
  t.after(async () => {
    for (const cleanup of cleanupFirst) cleanup();
    await server?.stop().catch(() => undefined);
    if (runtime && !runtimeClosed) await runtime.close();
    if (!workerClosed) await worker.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  await worker.ensureMobileScope({
    accountId,
    projectId,
    projectKey: "LIFECYCLE",
    projectName: "Lifecycle fixture",
    actorId,
    actorDisplayName: "Fixture GM",
    membershipId: projectMembershipId(projectId, actorId),
    createdAt: new Date().toISOString(),
  });
  const management = new ProjectManagementService({ worker, accountId, gmUserId: actorId });
  const principal = { accountId, userId: actorId, isGm: true };
  await mkdir(join(root, "credentials"));
  await writeFile(
    join(root, "credentials", "fixture-build.json"),
    JSON.stringify({ username: "synthetic-lifecycle-user", apiToken: "synthetic-lifecycle-token" }),
  );
  runtime = new ProjectComponentsRuntime({
    root: join(root, "components"),
    credentialRoot: join(root, "credentials"),
    instanceId: "lifecycle-test",
    worker,
    management,
    executionHeld: () => isImportExecutionHeld(holdFile),
    fetch: async (input, init) => {
      requests.push({ path: new URL(input).pathname, method: init?.method ?? "GET" });
      return transport(input, init);
    },
  });
  const startRuntime = runtime.start.bind(runtime),
    closeRuntime = runtime.close.bind(runtime),
    tick = runtime.tick.bind(runtime);
  runtime.start = () => {
    startCalls++;
    events.push("runtime.start");
    assert.equal(server.app.server.listening, true, "runtime starts only after successful bind");
    startRuntime();
  };
  runtime.tick = async () => {
    try {
      await tick();
    } finally {
      tickCompleted.resolve();
    }
  };
  runtime.close = async () => {
    closeCalls++;
    events.push("runtime.close.begin");
    closeEntered.resolve();
    await closeRuntime();
    runtimeClosed = true;
    events.push("runtime.close.end");
  };
  return {
    root,
    runtime,
    worker,
    projectId,
    actorId,
    events,
    requests,
    cleanupFirst,
    closeEntered,
    tickCompleted,
    counts: () => ({ startCalls, closeCalls, workerCloseCalls }),
    setTransport(value) {
      transport = value;
    },
    makeServer(extra = {}) {
      server = createApiServer({
        logger: false,
        isolateLegacyComponents: true,
        projectComponentsRuntime: runtime,
        projectRequestContext: new ProjectRequestContext(),
        ...extra,
      });
      return server;
    },
    close: () => closeApiRuntime({ server, componentsRuntime: runtime, worker }),
    hold: () => writeFile(holdFile, JSON.stringify({ markerVersion: 1, state: "paused" })),
    components: () => management.execute(principal, { operation: "components", projectId }),
    async enqueue() {
      await management.execute(principal, {
        operation: "setComponent",
        projectId,
        componentKey: "build",
        enabled: true,
        expectedVersion: 0,
        config: {
          baseUrl: "http://jenkins-lifecycle.invalid",
          job: "fixture",
          downloadOrigin: "http://artifact-lifecycle.invalid",
          zipPath: "/latest.zip",
          artifactUrlTemplate: "http://artifact-lifecycle.invalid/{buildNumber}.zip",
          credentialRef: "fixture-build",
          presets: { preview: { mode: "preview" } },
        },
      });
      return runtime.enqueueBuild(projectId, actorId, randomUUID(), { preset: "preview" });
    },
  };
}

test(
  "ready alone does not dispatch; successful listen starts once and shutdown waits for real in-flight work before worker close",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      entered = deferred(),
      release = deferred();
    f.cleanupFirst.push(() => release.resolve());
    f.setTransport(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("Fixture transport completed without external network");
    });
    await f.enqueue();
    const server = f.makeServer();
    await server.app.ready();
    assert.deepEqual(f.counts(), { startCalls: 0, closeCalls: 0, workerCloseCalls: 0 });
    assert.equal(f.requests.length, 0);
    const addresses = await Promise.all([server.start({ port: 0 }), server.start({ port: 0 })]);
    assert.equal(addresses[0], addresses[1]);
    await entered.promise;
    assert.equal(f.counts().startCalls, 1);
    assert.equal((await fetch(`${addresses[0]}/api/v1/health/live`)).status, 200);
    let finished = false;
    const closing = f.close().then(() => {
      finished = true;
    });
    await f.closeEntered.promise;
    assert.equal(finished, false);
    assert.equal(f.counts().workerCloseCalls, 0);
    assert.ok(
      (await f.components()).items.length > 0,
      "worker remains usable while component work drains",
    );
    release.resolve();
    await closing;
    await Promise.all([server.stop(), server.stop()]);
    assert.deepEqual(f.counts(), { startCalls: 1, closeCalls: 1, workerCloseCalls: 1 });
    assert.ok(f.events.indexOf("runtime.close.end") < f.events.indexOf("worker.close"));
    assert.equal(server.app.server.listening, false);
  },
);

test(
  "a real occupied port never starts the queued runtime and closes it exactly once",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      task = await f.enqueue(),
      occupied = createServer();
    await new Promise((resolve, reject) =>
      occupied.listen(0, "127.0.0.1", resolve).once("error", reject),
    );
    t.after(() => new Promise((resolve) => occupied.close(resolve)));
    const server = f.makeServer();
    await assert.rejects(server.start({ port: occupied.address().port }), { code: "EADDRINUSE" });
    assert.deepEqual(f.counts(), { startCalls: 0, closeCalls: 1, workerCloseCalls: 0 });
    assert.equal(f.requests.length, 0);
    const persisted = new DatabaseSync(join(f.root, "components", "runtime.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        persisted.prepare("SELECT state FROM build_tasks WHERE id=?").get(task.id).state,
        "queued",
      );
    } finally {
      persisted.close();
    }
    await f.close();
    await server.stop();
    assert.deepEqual(f.counts(), { startCalls: 0, closeCalls: 1, workerCloseCalls: 1 });
  },
);

test(
  "stop during pending startup never starts or double-closes the runtime",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      readyEntered = deferred(),
      releaseReady = deferred();
    f.cleanupFirst.push(() => releaseReady.resolve());
    const server = f.makeServer();
    server.app.addHook("onReady", async () => {
      readyEntered.resolve();
      await releaseReady.promise;
    });
    const starting = server.start({ port: 0 });
    const rejected = assert.rejects(starting, /stopped during startup/u);
    await readyEntered.promise;
    const stopping = server.stop();
    releaseReady.resolve();
    await Promise.all([rejected, stopping]);
    await f.close();
    assert.equal(server.app.server.listening, false);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.counts(), { startCalls: 0, closeCalls: 1, workerCloseCalls: 1 });
  },
);

test(
  "stop rejects new HTTP work and keeps the component database open until an in-flight route finishes",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      entered = deferred(),
      release = deferred(),
      closingEntered = deferred();
    f.cleanupFirst.push(() => release.resolve());
    const server = f.makeServer();
    server.app.addHook("preClose", async () => {
      closingEntered.resolve();
    });
    server.app.get("/fixture-slow-component-read", async () => {
      entered.resolve();
      await release.promise;
      const result = await f.runtime.listBuildTasks(f.projectId);
      f.events.push("http.handler.end");
      return result;
    });
    server.app.get("/fixture-new-work", async () => ({ unexpected: true }));
    const address = await server.start({ port: 0 });
    const response = fetch(`${address}/fixture-slow-component-read`);
    await entered.promise;
    const closing = f.close();
    await closingEntered.promise;
    assert.equal(f.counts().closeCalls, 0);
    assert.equal(f.counts().workerCloseCalls, 0);
    const lateResponsePromise = fetch(`${address}/fixture-new-work`, {
      signal: AbortSignal.timeout(1000),
    }).catch(() => null);
    release.resolve();
    assert.deepEqual(await (await response).json(), { projectId: f.projectId, items: [] });
    const lateResponse = await lateResponsePromise;
    if (lateResponse) assert.equal(lateResponse.status, 503);
    await closing;
    assert.ok(f.events.indexOf("http.handler.end") < f.events.indexOf("runtime.close.begin"));
    assert.ok(f.events.indexOf("runtime.close.end") < f.events.indexOf("worker.close"));
    assert.deepEqual(f.counts(), { startCalls: 1, closeCalls: 1, workerCloseCalls: 1 });
  },
);

test(
  "the real import hold blocks a previously queued enabled component after API startup",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      task = await f.enqueue();
    await f.hold();
    const server = f.makeServer();
    await server.start({ port: 0 });
    await f.tickCompleted.promise;
    assert.equal(f.counts().startCalls, 1);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.runtime.buildTask(f.projectId, task.id)).state, "queued");
    assert.equal((await f.components()).items.find((item) => item.key === "build").enabled, true);
    await f.close();
  },
);

test(
  "default disabled components perform no external requests in a running API",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      server = f.makeServer();
    assert.equal(
      (await f.components()).items.every((item) => item.enabled === false),
      true,
    );
    await server.start({ port: 0 });
    await f.tickCompleted.promise;
    assert.equal(f.requests.length, 0);
    await f.close();
    assert.deepEqual(f.counts(), { startCalls: 1, closeCalls: 1, workerCloseCalls: 1 });
  },
);

test(
  "synchronous application construction failure still closes the constructed runtime before the worker",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    assert.throws(() => f.makeServer({ logger: { level: "invalid-fixture-level" } }), /level/iu);
    await f.close();
    assert.deepEqual(f.counts(), { startCalls: 0, closeCalls: 1, workerCloseCalls: 1 });
    assert.equal(f.requests.length, 0);
    assert.ok(f.events.indexOf("runtime.close.end") < f.events.indexOf("worker.close"));
  },
);

test(
  "component startup failure after bind closes the listener and runtime without duplicate close",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      server = f.makeServer();
    f.runtime.start = () => {
      throw new Error("fixture startup failed");
    };
    await assert.rejects(server.start({ port: 0 }), /fixture startup failed/u);
    assert.equal(server.app.server.listening, false);
    await f.close();
    assert.equal(f.counts().closeCalls, 1);
    assert.equal(f.counts().workerCloseCalls, 1);
    assert.equal(f.requests.length, 0);
  },
);

test(
  "component cleanup errors do not skip HTTP or worker cleanup",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      server = f.makeServer(),
      close = f.runtime.close.bind(f.runtime);
    f.runtime.close = async () => {
      await close();
      throw new Error("fixture cleanup failed");
    };
    await server.start({ port: 0 });
    await assert.rejects(f.close(), /fixture cleanup failed/u);
    assert.equal(server.app.server.listening, false);
    assert.deepEqual(f.counts(), { startCalls: 1, closeCalls: 1, workerCloseCalls: 1 });
  },
);
