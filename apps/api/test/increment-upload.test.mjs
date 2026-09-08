import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IncrementUploadService } from "../dist/increment-upload.js";
import { createApiApp } from "../dist/app.js";

const input = {
  productId: "2002",
  channelId: "1002",
  belongName: "Fixture",
  version: "",
  summary: "",
  description: "",
  testerId: 11562,
  testResultReference: "",
  mode: "prepare_publish",
};
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "server-upload-test-")),
    owner = randomUUID(),
    other = randomUUID(),
    hosts = new Map(),
    launches = [];
  let failLaunch = false;
  const factory = (id) => {
    if (hosts.has(id)) return hosts.get(id);
    const jobs = [],
      folder = (jobId) => path.join(root, "fixtures", id, jobId);
    const start = async (value, jobId) => {
      if (failLaunch) {
        failLaunch = false;
        throw new Error("UPLOADER_MISSING");
      }
      const runId = randomUUID();
      await mkdir(folder(jobId), { recursive: true });
      await writeFile(path.join(folder(jobId), "desktop.json"), JSON.stringify({ runId }));
      const job = {
        id: jobId,
        input: value,
        createdAt: new Date().toISOString(),
        active: true,
        status: "running",
        stage: "UPLOADING",
        errorCode: "",
        version: "fixture-new",
        versionId: 42,
        done: [],
        size: 100,
        sha256: "fixture",
        testResultLocked: false,
        pendingAction: "",
        published: false,
        publishTime: "",
        remoteStatus: 20,
        events: [],
      };
      const i = jobs.findIndex((j) => j.id === jobId);
      if (i < 0) jobs.push(job);
      else jobs[i] = job;
      launches.push({ owner: id, id: jobId, input: value });
      return jobId;
    };
    const host = {
      jobs,
      folder,
      snapshot: async () => ({
        available: true,
        toolVersion: "fixture",
        sourceUrl: "fixture",
        account: `account-${id}`,
        kind: "email",
        configured: true,
        authError: false,
        jobs: structuredClone(jobs),
        unreadableJobs: 0,
      }),
      login: async () => true,
      logout: async () => true,
      checkAuth: async () => true,
      accountIdentity: async () => `identity-${id}`,
      hasBuildJob: async (jobId) => jobs.some((j) => j.id === jobId),
      startWithId: start,
      startForBuild: start,
      resume: async (v) => start(jobs.find((j) => j.id === v.id).input, v.id),
      confirmPublish: async (jobId) => start(jobs.find((j) => j.id === jobId).input, jobId),
    };
    hosts.set(id, host);
    return host;
  };
  const builds = [],
    jenkins = {
      trigger: async () => {
        builds.push(1);
        return { queueId: 760 };
      },
      progress: async () => ({ queues: [], builds: [] }),
    };
  const options = {
    root,
    jenkins,
    hostFactory: factory,
    fetch: async () => new Response(null, { status: 404 }),
  };
  let service = new IncrementUploadService(options);
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    owner,
    other,
    hosts,
    launches,
    builds,
    jenkins,
    get service() {
      return service;
    },
    fail: () => {
      failLaunch = true;
    },
    restart: async () => {
      await service.close();
      service = new IncrementUploadService(options);
    },
    options,
  };
}
test("submission is durable, idempotent, actor-bound and does not launch in the request", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  assert.equal(await f.service.enqueue(f.owner, id, input), id);
  assert.equal(await f.service.enqueue(f.owner, id, input), id);
  assert.equal(f.launches.length, 0);
  assert.equal((await f.service.snapshot(f.owner)).jobs[0].status, "queued");
  await assert.rejects(f.service.enqueue(f.other, id, input), /UPLOAD_REQUEST_CONFLICT/);
  await assert.rejects(
    f.service.enqueue(f.owner, id, { ...input, version: "different" }),
    /UPLOAD_REQUEST_CONFLICT/,
  );
  assert.equal((await f.service.snapshot(f.other)).jobs.length, 0);
  await assert.rejects(f.service.logs(f.other, id), /JOB_NOT_FOUND/);
  await f.restart();
  await f.service.tick();
  assert.equal(f.launches.length, 1);
  assert.equal((await f.service.snapshot(f.owner)).execution, "server");
});
test("iOS persists channel 2004 through queue restart and cannot use the Android build button", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  const ios = { ...input, channelId: "2004", belongName: "iOS fixture" };
  await f.service.enqueue(f.owner, id, ios);
  await f.restart();
  await f.service.tick();
  assert.equal(f.launches[0].input.channelId, "2004");
  assert.equal(f.launches[0].input.testerId, 11562);
  await assert.rejects(
    f.service.enqueue(f.owner, randomUUID(), ios, "build"),
    /BUILD_PLATFORM_UNSUPPORTED/,
  );
});
test("global queue serializes workers across users; confirmation reserves the channel", async (t) => {
  const f = await fixture(t),
    a = randomUUID(),
    b = randomUUID();
  await f.service.enqueue(f.owner, a, input);
  await f.service.enqueue(f.other, b, input);
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.launches.length, 1);
  Object.assign(f.hosts.get(f.owner).jobs[0], {
    active: false,
    status: "awaiting_publish",
    stage: "AWAITING_PUBLISH_CONFIRMATION",
  });
  await f.service.tick();
  assert.equal(f.launches.length, 1);
  assert.equal((await f.service.snapshot(f.other)).jobs[0].errorCode, "UPLOAD_CHANNEL_HELD");
  await assert.rejects(
    f.service.continue(f.owner, a, randomUUID(), "resume", {}),
    /PUBLISH_NOT_READY/,
  );
  const key = randomUUID();
  await f.service.continue(f.owner, a, key, "confirm", {});
  await f.service.tick();
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[1].id, a);
  await f.service.continue(f.owner, a, key, "confirm", {});
  assert.equal(f.launches.length, 2);
  Object.assign(f.hosts.get(f.owner).jobs[0], {
    active: false,
    status: "succeeded",
    published: true,
  });
  await f.service.tick();
  assert.equal(f.launches.length, 3);
  assert.equal(f.launches[2].id, b);
});
test("unfinished failed task blocks its channel but not other products", async (t) => {
  const f = await fixture(t),
    a = randomUUID(),
    b = randomUUID(),
    c = randomUUID();
  await f.service.enqueue(f.owner, a, input);
  await f.service.tick();
  Object.assign(f.hosts.get(f.owner).jobs[0], {
    active: false,
    status: "failed",
    errorCode: "REMOTE_RESULT_UNKNOWN",
    pendingAction: "BIND_PACKAGE",
  });
  await f.service.enqueue(f.other, b, input);
  await f.service.enqueue(f.other, c, { ...input, productId: "2003" });
  await f.service.tick();
  assert.equal(f.launches[1].id, c);
  assert.equal((await f.service.snapshot(f.other)).jobs.find((j) => j.id === b).status, "queued");
});
test("restart retains active and failed checkpoints without replaying writes", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.service.enqueue(f.owner, id, input);
  await f.service.tick();
  await f.restart();
  await f.service.tick();
  assert.equal(f.launches.length, 1);
  Object.assign(f.hosts.get(f.owner).jobs[0], {
    active: false,
    status: "failed",
    pendingAction: "PASS_TEST",
  });
  await f.restart();
  await f.service.tick();
  assert.equal(f.launches.length, 1);
  const key = randomUUID();
  await f.service.continue(f.owner, id, key, "resume", {});
  await f.service.tick();
  assert.equal(f.launches.length, 2);
  await f.service.continue(f.owner, id, key, "resume", {});
  assert.equal(f.launches.length, 2);
});
test("a second API instance cannot claim the scheduler while the owner lives", async (t) => {
  const f = await fixture(t);
  await f.service.enqueue(f.owner, randomUUID(), input);
  const second = new IncrementUploadService(f.options);
  try {
    await assert.rejects(second.tick(), /UPLOAD_SERVER_STANDBY/);
    assert.equal(f.launches.length, 0);
  } finally {
    await second.close();
  }
  await f.service.tick();
  assert.equal(f.launches.length, 1);
});
test("lost dispatch acknowledgement reconciles the new run receipt", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.service.enqueue(f.owner, id, input);
  await f.service.tick();
  const db = new DatabaseSync(path.join(f.root, "queue.sqlite"));
  db.prepare("UPDATE upload_commands SET state='dispatching' WHERE id=?").run(id);
  db.close();
  Object.assign(f.hosts.get(f.owner).jobs[0], { active: false, status: "interrupted" });
  await f.restart();
  await f.service.tick();
  assert.equal(f.launches.length, 1);
  assert.equal((await f.service.snapshot(f.owner)).jobs[0].status, "interrupted");
});
test("failed preflight retries the same queued identity and original input", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.service.enqueue(f.owner, id, input);
  f.fail();
  await f.service.tick();
  assert.equal(f.launches.length, 0);
  assert.equal((await f.service.snapshot(f.owner)).jobs[0].errorCode, "UPLOADER_MISSING");
  const key = randomUUID();
  await f.service.continue(f.owner, id, key, "resume", {});
  await f.service.continue(f.owner, id, key, "resume", {});
  await f.service.tick();
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].id, id);
});
test("queued tasks can be cancelled; started work and another user's tasks cannot", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.service.enqueue(f.owner, id, input);
  await assert.rejects(f.service.cancel(f.other, id), /JOB_NOT_FOUND/);
  await f.service.cancel(f.owner, id);
  await f.service.tick();
  assert.equal(f.launches.length, 0);
  assert.equal((await f.service.snapshot(f.owner)).jobs[0].status, "cancelled");
  const active = randomUUID();
  await f.service.enqueue(f.owner, active, input);
  await f.service.tick();
  await assert.rejects(f.service.cancel(f.owner, active), /UPLOAD_ALREADY_STARTED/);
});
test("account replacement cannot retarget queued uploads", async (t) => {
  const f = await fixture(t);
  await f.service.enqueue(f.owner, randomUUID(), input);
  await assert.rejects(f.service.account(f.owner, "logout", {}), /UPLOAD_ACCOUNT_IN_USE/);
  await assert.rejects(
    f.service.account(f.owner, "login", { account: "other", kind: "email", password: "never-log" }),
    /UPLOAD_ACCOUNT_IN_USE/,
  );
  assert.equal(
    await f.service.account(f.owner, "login", {
      account: `account-${f.owner}`,
      kind: "email",
      password: "never-log",
    }),
    true,
  );
  const files = await readFile(path.join(f.root, "queue.sqlite"));
  assert.ok(!files.includes(Buffer.from("never-log")));
});
test("combined build is queued without HTTP waiting and server restart does not resubmit", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.service.enqueue(f.owner, id, input, "build");
  assert.equal(f.builds.length, 0);
  assert.equal((await f.service.buildChains(f.owner))[0].status, "queued");
  await f.service.tick();
  assert.equal(f.builds.length, 1);
  await f.restart();
  await f.service.tick();
  assert.equal(f.builds.length, 1);
  assert.equal((await f.service.buildChains(f.owner))[0].queueId, 760);
});
test("authenticated API exposes queue and diagnostics without local bridge or credentials", async (t) => {
  const f = await fixture(t);
  f.service.start = () => {};
  const app = createApiApp({
    incrementUploadService: f.service,
    debugBearerToken: "fixture-token",
    debugActorId: f.owner,
  });
  await app.ready();
  const headers = { authorization: "Bearer fixture-token", "idempotency-key": randomUUID() };
  assert.equal((await app.inject({ url: "/api/v1/increment-upload" })).statusCode, 401);
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/increment-upload/jobs",
    headers,
    payload: input,
  });
  assert.equal(created.statusCode, 200);
  const id = created.json(),
    result = await app.inject({ url: `/api/v1/increment-upload/jobs/${id}/logs`, headers });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().job.status, "queued");
  assert.ok(!result.body.includes("accountIdentity"));
  assert.ok(!result.body.includes("password"));
  // This fixture owns closing the service; avoid closing it twice through the app hook.
  const close = f.service.close.bind(f.service);
  f.service.close = async () => {};
  await app.close();
  f.service.close = close;
});

test("lost launch acknowledgement still reserves the actual worker's channel", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.service.enqueue(f.owner, id, input);
  const host = f.hosts.get(f.owner),
    start = host.startWithId;
  host.startWithId = async (...args) => {
    await start(...args);
    throw new Error("LOCAL_STATE_INVALID");
  };
  await f.service.tick();
  Object.assign(host.jobs[0], { active: false, status: "awaiting_publish" });
  await f.service.enqueue(f.other, randomUUID(), input);
  await f.service.tick();
  assert.equal(f.launches.length, 1);
});

test("completed build hands off to upload before the next queued build can overwrite its ZIP", async (t) => {
  const f = await fixture(t),
    first = randomUUID(),
    second = randomUUID();
  let reads = 0;
  const modified = new Date().toUTCString();
  f.options.fetch = async () =>
    ++reads === 1
      ? new Response(null, { status: 404 })
      : new Response(null, { headers: { "content-length": "100", "last-modified": modified } });
  f.jenkins.progress = async () => ({
    queues: [],
    builds: [
      {
        number: 10159,
        queueId: 760,
        preset: "external",
        status: "SUCCESS",
        startedAt: new Date(Date.parse(modified) - 1000).toISOString(),
        elapsedMs: 2000,
        includesZip: true,
        stages: [{ id: "zip", state: "complete" }],
      },
    ],
  });
  await f.service.enqueue(f.owner, first, input, "build");
  await f.service.enqueue(f.other, second, input, "build");
  await f.service.tick();
  assert.equal(f.builds.length, 1);
  await f.service.tick();
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].id, first);
  assert.equal(f.builds.length, 1);
  assert.equal((await f.service.buildChains(f.owner))[0].uploadJobId, first);
});

test("new submissions are accepted while server build polling is waiting on Jenkins", async (t) => {
  const f = await fixture(t);
  await f.service.enqueue(f.owner, randomUUID(), input, "build");
  await f.service.tick();
  let release, entered;
  const ready = new Promise((r) => {
    entered = r;
  });
  f.jenkins.progress = async () => {
    entered();
    await new Promise((r) => {
      release = r;
    });
    return { queues: [], builds: [] };
  };
  const tick = f.service.tick();
  await ready;
  const id = randomUUID();
  assert.equal(await f.service.enqueue(f.other, id, input), id);
  assert.equal((await f.service.snapshot(f.other)).jobs[0].status, "queued");
  release();
  await tick;
});

test("cancelling a queued recovery preserves the original failed task and its channel reservation", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.service.enqueue(f.owner, id, input);
  await f.service.tick();
  Object.assign(f.hosts.get(f.owner).jobs[0], {
    active: false,
    status: "failed",
    errorCode: "AUTH_REQUIRED",
  });
  await f.service.enqueue(f.other, randomUUID(), input);
  await f.service.continue(f.owner, id, randomUUID(), "resume", {});
  await f.service.cancel(f.owner, id);
  assert.equal((await f.service.snapshot(f.owner)).jobs[0].status, "failed");
  await f.service.tick();
  assert.equal(f.launches.length, 1);
  await f.service.account(f.owner, "login", {
    account: `account-${f.owner}`,
    kind: "email",
    password: "fixture",
  });
  await f.service.continue(f.owner, id, randomUUID(), "resume", {});
  await f.service.tick();
  assert.equal(f.launches.length, 2);
});
