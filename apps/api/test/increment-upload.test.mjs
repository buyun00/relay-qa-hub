import assert from "node:assert/strict";
import test from "node:test";
import { buildInfo, QUICK_BUILD_PRESETS } from "./quick-build-fixture.mjs";
import { validateBuildResult } from "../dist/build-artifacts.js";
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
async function fixture(t, projectOverrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "server-upload-test-")),
    owner = randomUUID(),
    other = randomUUID(),
    hosts = new Map(),
    launches = [];
  let failLaunch = false;
  let enabled = true;
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
      reconcilePublications: async () => {},
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
    project: {
      projectId: randomUUID(),
      componentVersion: 3,
      apiBase: "https://upload.fixture.invalid",
      loginBase: "https://login.fixture.invalid",
      sourceUrl: "https://artifacts.fixture.invalid/test.zip",
      sourceKind: "file",
      targetPrefix: "fixture-only",
      defaults: input,
      credentialRef: "fixture-only",
      ...projectOverrides,
    },
    buildPreset: "external",
    canStart: async () => enabled,
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
    setEnabled: (value) => {
      enabled = value;
    },
  };
}
test("submission is durable, idempotent, actor-bound and does not launch in the request", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  assert.equal(await f.service.enqueue(f.owner, id, input), id);
  assert.equal(await f.service.enqueue(f.owner, id, input), id);
  assert.equal(f.launches.length, 0);
  assert.equal((await f.service.snapshot(f.owner)).jobs[0].status, "queued");
  assert.equal((await f.service.snapshot(f.owner)).jobs[0].projectId, f.options.project.projectId);
  assert.equal(
    (await f.service.snapshot(f.owner)).jobs[0].componentVersion,
    f.options.project.componentVersion,
  );
  await assert.rejects(f.service.enqueue(f.other, id, input), /UPLOAD_REQUEST_CONFLICT/);
  await assert.rejects(
    f.service.enqueue(f.owner, id, { ...input, version: "different" }),
    /UPLOAD_REQUEST_CONFLICT/,
  );
  assert.equal((await f.service.snapshot(f.other)).jobs[0].id, id);
  assert.equal((await f.service.logs(f.other, id)).job.canManage, false);
  await f.restart();
  await f.service.tick();
  assert.equal(f.launches.length, 1);
  assert.equal((await f.service.snapshot(f.owner)).execution, "server");
});
test("iOS persists channel 2004 through queue restart and supports its explicit quick-build preset", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  delete f.options.project;
  delete f.options.buildPreset;
  delete f.options.canStart;
  await f.restart();
  const ios = { ...input, channelId: "2004", belongName: "iOS fixture" };
  await f.service.enqueue(f.owner, id, ios);
  await f.restart();
  await f.service.tick();
  assert.equal(f.launches[0].input.channelId, "2004");
  assert.equal(f.launches[0].input.testerId, 11562);
  const chainId = randomUUID();
  await f.service.enqueue(f.owner, chainId, ios, "build", "ios-debug-res");
  const chain = (await f.service.buildChains(f.owner)).find((c) => c.id === chainId);
  assert.equal(chain.preset, "ios-debug-res");
  assert.equal(chain.input.productId, "2001");
  assert.equal(chain.input.channelId, "2004");
});

test("project iOS source cannot use a configured Android build button", async (t) => {
  const f = await fixture(t, {
    sourceKind: "ios_directory",
    sourceUrl: "https://artifacts.fixture.invalid/ios/",
    defaults: { ...input, channelId: "2004" },
  });
  await assert.rejects(
    f.service.enqueue(
      f.owner,
      randomUUID(),
      { ...input, channelId: "2004", belongName: "iOS fixture" },
      "build",
    ),
    /BUILD_PLATFORM_UNSUPPORTED/,
  );
});

test("all users see existing upload progress and diagnostics without sharing account configuration", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.service.enqueue(f.owner, id, input);
  await f.restart();
  let shared = await f.service.snapshot(f.other);
  assert.equal(shared.jobs[0].id, id);
  assert.equal(shared.jobs[0].status, "queued");
  assert.equal(shared.jobs[0].queuePosition, 1);
  assert.equal(shared.jobs[0].canManage, false);
  assert.equal(shared.account, `account-${f.other}`);
  assert.ok(!JSON.stringify(shared).includes(`account-${f.owner}`));
  await f.service.tick();
  for (const status of ["running", "failed", "awaiting_publish", "succeeded"]) {
    Object.assign(f.hosts.get(f.owner).jobs[0], {
      status,
      active: status === "running",
      published: status === "succeeded",
      stage: status === "succeeded" ? "PUBLISHED" : status.toUpperCase(),
      events: [{ stage: "UPLOADING", completedParts: 8, totalParts: 10 }],
    });
    shared = await f.service.snapshot(f.other);
    assert.equal(shared.jobs[0].status, status);
    assert.equal(shared.jobs[0].events[0].completedParts, 8);
    const log = await f.service.logs(f.other, id);
    assert.equal(log.job.status, status);
    assert.equal(log.audit[0].actor, f.owner);
    assert.equal(log.audit[0].action, "enqueue_upload");
    assert.equal((await f.service.snapshot(f.owner)).jobs[0].canManage, true);
  }
  await assert.rejects(
    f.service.continue(f.other, id, randomUUID(), "resume", {}),
    /JOB_NOT_FOUND/,
  );
  await assert.rejects(
    f.service.continue(f.other, id, randomUUID(), "confirm", {}),
    /JOB_NOT_FOUND/,
  );
  await assert.rejects(f.service.cancel(f.other, id), /JOB_NOT_FOUND/);
});

test("shared build records retain creator, queue and handoff across restart without exposing account binding", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.service.enqueue(f.owner, id, input, "build");
  let chains = await f.service.buildChains(f.other);
  assert.equal(chains[0].id, id);
  assert.equal(chains[0].status, "queued");
  assert.equal(chains[0].ownerId, f.owner);
  assert.equal(chains[0].canManage, false);
  assert.equal(chains[0].accountIdentity, "");
  await f.service.tick();
  await f.restart();
  chains = await f.service.buildChains(f.other);
  assert.equal(chains[0].queueId, 760);
  assert.equal(chains[0].status, "building");
  assert.equal(chains[0].accountIdentity, "");
  assert.equal((await f.service.buildChains(f.owner))[0].canManage, true);
  await assert.rejects(f.service.cancel(f.other, id, true), /JOB_NOT_FOUND/);
  assert.equal(f.builds.length, 1);
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
  assert.equal(
    (await f.service.snapshot(f.other)).jobs.find((j) => j.id === b).errorCode,
    "UPLOAD_CHANNEL_HELD",
  );
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

test("reconciling a manual publication releases the original queued build without a publish write", async (t) => {
  const f = await fixture(t),
    original = randomUUID(),
    queued = randomUUID();
  await f.service.enqueue(f.owner, original, input);
  await f.service.tick();
  const host = f.hosts.get(f.owner);
  Object.assign(host.jobs[0], { active: false, status: "awaiting_publish", remoteStatus: 60 });
  await f.service.enqueue(f.other, queued, input, "build");
  await f.service.tick();
  assert.equal(f.builds.length, 0);
  assert.equal(
    (await f.service.buildChains(f.other)).find((c) => c.id === queued).errorCode,
    "UPLOAD_CHANNEL_HELD",
  );
  host.reconcilePublications = async () => {
    Object.assign(host.jobs[0], { status: "succeeded", published: true, remoteStatus: 100 });
  };
  await f.service.tick();
  assert.equal(f.launches.length, 1, "No upload/recovery/confirmation was launched");
  assert.equal(f.builds.length, 1);
  const chain = (await f.service.buildChains(f.other)).find((c) => c.id === queued);
  assert.equal(chain.status, "building");
  assert.equal(chain.queueId, 760);
  await f.restart();
  await f.service.tick();
  assert.equal(f.builds.length, 1, "Restart cannot resubmit the released build");
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
  const otherHeaders = { ...headers, "x-qa-actor-id": f.other };
  const shared = await app.inject({ url: "/api/v1/increment-upload", headers: otherHeaders });
  assert.equal(shared.statusCode, 200);
  assert.equal(shared.json().jobs[0].id, id);
  assert.equal(shared.json().jobs[0].canManage, false);
  const sharedLogs = await app.inject({
    url: `/api/v1/increment-upload/jobs/${id}/logs`,
    headers: otherHeaders,
  });
  assert.equal(sharedLogs.statusCode, 200);
  assert.equal(sharedLogs.json().audit[0].actor, f.owner);
  assert.equal(
    (await app.inject({ url: `/api/v1/increment-upload/jobs/${id}/logs` })).statusCode,
    401,
  );
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
  delete f.options.project;
  delete f.options.buildPreset;
  delete f.options.canStart;
  await f.restart();
  const modified = new Date().toUTCString();
  f.jenkins.buildResult = async () => validateBuildResult(buildInfo(), QUICK_BUILD_PRESETS[2]);
  f.options.fetch = async () =>
    new Response(null, { headers: { "content-length": "1234", "last-modified": modified } });
  f.jenkins.progress = async () => ({
    queues: [],
    builds: [
      {
        number: 10159,
        queueId: 760,
        preset: "android-release-app",
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
  assert.equal(
    (await f.service.buildChains(f.owner)).find((c) => c.id === first).uploadJobId,
    first,
  );
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
  assert.equal((await f.service.snapshot(f.owner)).jobs.find((j) => j.id === id).status, "failed");
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

test("disabled queued work stays paused after re-enable until its owner explicitly resumes", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.service.enqueue(f.owner, id, input);
  f.setEnabled(false);
  await f.service.pausePending();
  assert.equal((await f.service.snapshot(f.owner)).jobs[0].status, "paused");
  await assert.rejects(f.service.resumeQueued(f.owner, id), /COMPONENT_DISABLED/);
  f.setEnabled(true);
  await f.restart();
  await f.service.tick();
  assert.equal(f.launches.length, 0);
  assert.equal((await f.service.snapshot(f.owner)).jobs[0].status, "paused");
  await assert.rejects(f.service.resumeQueued(f.other, id), /JOB_NOT_FOUND/);
  await f.service.resumeQueued(f.owner, id);
  await f.service.tick();
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].id, id);
});

test("disabling preserves a started build's source handoff while pausing the next build", async (t) => {
  const f = await fixture(t),
    first = randomUUID(),
    second = randomUUID();
  let reads = 0,
    polls = 0;
  const modified = new Date().toUTCString();
  f.options.fetch = async () =>
    ++reads === 1
      ? new Response(null, { status: 404 })
      : new Response(null, { headers: { "content-length": "100", "last-modified": modified } });
  f.jenkins.progress = async () => {
    polls++;
    return {
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
    };
  };
  await f.service.enqueue(f.owner, first, input, "build");
  await f.service.enqueue(f.other, second, input, "build");
  await f.service.tick();
  assert.equal(f.builds.length, 1);
  f.setEnabled(false);
  await f.service.pausePending();
  await f.service.tick();
  assert.ok(polls > 0);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].id, first);
  assert.equal(f.builds.length, 1);
  const chains = await f.service.buildChains(f.owner);
  assert.equal(chains.find((item) => item.id === first).uploadJobId, first);
  assert.equal(chains.find((item) => item.id === second).status, "paused");
});
