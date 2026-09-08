import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  UploaderHost,
  parseUploadInput,
  parseUploadEvents,
  writeJson,
  readJson,
} from "../src/uploader-host.js";
import type { UploadInput } from "../src/uploader-types.js";

const input: UploadInput = {
  productId: "2002",
  channelId: "1002",
  belongName: "Fixture product and channel",
  version: "",
  summary: "Fixture update",
  description: "Local verification only",
  mode: "publish_workflow",
  testerId: 11562,
  testResultReference: "",
};
const executable = path.resolve("vendor/ozdqp-uploader/ozdqp-uploader.exe");
async function fixture(t: Parameters<Parameters<typeof test>[1]>[0], fetcher?: typeof fetch) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qahub-uploader-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    root: path.join(root, "jobs"),
    authFile: path.join(root, "auth.json"),
    executable,
    runner: path.join(root, "runner.mjs"),
    nodeExecutable: process.execPath,
    ...(fetcher ? { fetch: fetcher } : {}),
  };
  return { root, options, host: new UploaderHost(options) };
}
async function seed(
  options: { root: string },
  state: Record<string, unknown>,
  events = "",
  live = false,
) {
  const id = randomUUID(),
    runId = randomUUID();
  const folder = path.join(options.root, id);
  await writeJson(path.join(folder, "job.json"), { ...input, version: null });
  await writeJson(path.join(folder, "desktop.json"), {
    createdAt: new Date().toISOString(),
    runStartedAt: "2020-01-01T00:00:00Z",
    runId,
  });
  await writeJson(path.join(folder, "state.json"), state);
  await writeJson(path.join(folder, `run-${runId}.json`), {
    pid: process.pid,
    finished: !live,
    updatedAt: new Date().toISOString(),
  });
  await writeFile(path.join(folder, `run-${runId}.jsonl`), events);
  return { id, runId, folder };
}

test("upload inputs exclude arbitrary paths, commands and historical version IDs", () => {
  assert.deepEqual(
    parseUploadInput({
      ...input,
      workDirectory: "C:/",
      apiBase: "https://evil.test",
      existingVersionId: 829,
    }),
    input,
  );
  for (const changed of [
    { productId: "../../x" },
    { channelId: "0" },
    { summary: " " },
    { description: "" },
    { mode: "delete" },
    { testerId: -1 },
    { testerId: 1.5 },
    { version: "../x" },
  ])
    assert.throws(() => parseUploadInput({ ...input, ...changed }), /INVALID_INPUT/);
});
test("event projection tolerates partial JSONL and never returns tokens or raw error text", () => {
  const events = parseUploadEvents(
    'noise\n{"type":"event","event":"progress","stage":"UPLOADING","data":{"completedBytes":50,"totalBytes":100,"accessToken":"secret"}}\n{"type":"error","code":"AUTH_REQUIRED","message":"sensitive response"}\n{"type":',
  );
  assert.equal(events.length, 2);
  assert.equal(events[0]?.completedBytes, 50);
  assert.ok(!JSON.stringify(events).includes("secret"));
  assert.ok(!JSON.stringify(events).includes("sensitive"));
  assert.equal(
    parseUploadEvents('{"type":"event","event":"uploadParallelism","data":{"concurrency":4}}')[0]
      ?.concurrency,
    4,
  );
  assert.equal(
    parseUploadEvents('{"type":"event","event":"uploadParallelism","data":{"concurrency":999}}')[0]
      ?.concurrency,
    undefined,
  );
});
test("email login matches handover contract, validates access, saves compatible cache, keeps secrets out of snapshot", async (t) => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const { host, options } = await fixture(t, async (url, options) => {
    calls.push({ url: String(url), ...(options ? { options } : {}) });
    return Response.json({
      code: 0,
      data:
        calls.length === 1
          ? { access_token: "test-access", refresh_token: "test-refresh" }
          : { provider: "tencent" },
    });
  });
  await host.login({
    account: "example@fixture.test",
    password: "not-a-real-password",
    kind: "email",
  });
  assert.equal(calls[0]?.url, "https://54cetx.jiaxiangxm.com/api/v1/gwapi/login/unified");
  assert.deepEqual(JSON.parse(String(calls[0]?.options?.body)), {
    account: "example@fixture.test",
    password: createHash("md5").update("not-a-real-password").digest("hex").toUpperCase(),
    language: "zh",
    login_type: "password",
    generate_token: true,
  });
  assert.equal(calls[0]?.options?.redirect, "error");
  assert.equal(new Headers(calls[1]?.options?.headers).get("Authorization"), "test-access");
  const cache = await readJson(options.authFile);
  assert.equal(cache?.["password"], "not-a-real-password");
  assert.equal(cache?.["apiBase"], "https://fq2ivi.ipwana.com");
  const snapshot = await host.snapshot();
  assert.equal(snapshot.account, "example@fixture.test");
  for (const secret of ["not-a-real-password", "test-access", "test-refresh"])
    assert.ok(!JSON.stringify(snapshot).includes(secret));
});
test("failed access check preserves previous login and exposes no server text", async (t) => {
  let calls = 0;
  const { host, options } = await fixture(t, async () =>
    ++calls === 1
      ? Response.json({ code: 0, data: { access_token: "new-token" } })
      : new Response("sensitive", { status: 403 }),
  );
  await writeJson(options.authFile, { account: "old", password: "keep" });
  await assert.rejects(
    host.login({ account: "new", password: "bad", kind: "email" }),
    /^Error: FORBIDDEN$/,
  );
  assert.equal((await readJson(options.authFile))?.["password"], "keep");
});
test("subaccount redirects accept only the recorded origins and one token", async (t) => {
  let link = "https://fq2ivi.ipwana.com/#/main?access_token=sub-token";
  const { host } = await fixture(t, async (url) =>
    Response.json({
      code: 0,
      data: String(url).includes("extension") ? { new_skip_url: link } : { provider: "tencent" },
    }),
  );
  assert.equal(await host.login({ account: "sub", password: "fixture", kind: "subaccount" }), true);
  for (const value of [
    "https://evil.test/?access_token=secret",
    "https://fq2ivi.ipwana.com/?access_token=a&access_token=b",
  ]) {
    link = value;
    await assert.rejects(
      host.login({ account: "sub", password: "fixture", kind: "subaccount" }),
      /LOGIN_SCHEMA_CHANGED/,
    );
  }
});
test("bad local auth does not hide job history and can be repaired through login", async (t) => {
  const { host, options } = await fixture(t, async (url) =>
    Response.json({
      code: 0,
      data: String(url).includes("unified") ? { access_token: "fixture" } : {},
    }),
  );
  await writeFile(options.authFile, "broken{");
  await seed(options, { stage: "UPLOADING", runStatus: "RUNNING" });
  const before = await host.snapshot();
  assert.equal(before.authError, true);
  assert.equal(before.jobs.length, 1);
  await host.login({ account: "fixture", password: "fixture", kind: "email" });
  assert.equal((await host.snapshot()).authError, false);
});
test("restart reads progress from disk, and only a verified published state is successful", async (t) => {
  const { options } = await fixture(t);
  const { folder } = await seed(
    options,
    {
      stage: "WAIT_PUBLISHED",
      runStatus: "RUNNING",
      finalRemoteStatus: 99,
      file: { sha256: "a".repeat(64), size: 100 },
      done: ["OBJECT_READY"],
    },
    '{"type":"event","event":"progress","stage":"UPLOADING","data":{"completedBytes":100,"totalBytes":100}}\n',
  );
  let job = (await new UploaderHost(options).snapshot()).jobs[0]!;
  assert.equal(job.published, false);
  assert.equal(job.status, "interrupted");
  await writeJson(path.join(folder, "state.json"), {
    stage: "PUBLISHED",
    runStatus: "SUCCEEDED",
    finalRemoteStatus: 99,
    publishTime: "2026-09-08 12:00:00",
  });
  job = (await new UploaderHost(options).snapshot()).jobs[0]!;
  assert.notEqual(job.status, "succeeded");
  await writeJson(path.join(folder, "state.json"), {
    stage: "PUBLISHED",
    runStatus: "SUCCEEDED",
    finalRemoteStatus: 100,
    publishTime: "2026-09-08 12:00:00",
  });
  job = (await new UploaderHost(options).snapshot()).jobs[0]!;
  assert.equal(job.published, true);
  assert.equal(job.status, "succeeded");
});
test("live jobs prevent changing account and launching duplicate tasks; expired heartbeat is interrupted", async (t) => {
  const { host, options } = await fixture(t);
  const { folder, runId } = await seed(
    options,
    { stage: "UPLOADING", runStatus: "RUNNING" },
    "",
    true,
  );
  assert.equal((await host.snapshot()).jobs[0]?.active, true);
  await assert.rejects(host.start(input), /UPLOADER_BUSY/);
  await assert.rejects(host.logout(), /UPLOADER_BUSY/);
  await writeJson(path.join(folder, `run-${runId}.json`), {
    pid: process.pid,
    finished: false,
    updatedAt: "2020-01-01T00:00:00Z",
  });
  assert.equal((await host.snapshot()).jobs[0]?.active, false);
});
test("recovery locks testing identity once status changes started; arbitrary job paths are rejected", async (t) => {
  const { host, options } = await fixture(t);
  const { id } = await seed(options, {
    stage: "PASS_TEST",
    done: ["START_TEST"],
    pendingAction: "PASS_TEST",
  });
  await assert.rejects(
    host.resume({ id, testerId: 8, testResultReference: "changed" }),
    /TEST_RESULT_LOCKED/,
  );
  assert.throws(() => host.folder("../../outside"), /INVALID_INPUT/);
});
test("supervised start and resume preserve the job target and original work directory", async (t) => {
  const { host, options } = await fixture(t);
  await writeJson(options.authFile, { account: "local fixture" });
  await writeFile(
    options.runner,
    `import fs from 'node:fs/promises'; import path from 'node:path';
const [exe,dir,runId,command]=process.argv.slice(2);
await fs.writeFile(path.join(dir,'fixture-command.json'),JSON.stringify({command,hasOverride:!!process.env.OZDQP_AUTHORIZATION}));
await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({stage:'REQUEST_TEST',runStatus:'FAILED',done:['REQUEST_TEST']}));
await fs.writeFile(path.join(dir,'run-'+runId+'.jsonl'),JSON.stringify({type:'event',event:'failed',data:{code:'TEST_RESULT_REQUIRED'}})+'\\n');
await fs.writeFile(path.join(dir,'run-'+runId+'.json'),JSON.stringify({finished:true,exitCode:6}));`,
  );
  const [first, second] = await Promise.allSettled([host.start(input), host.start(input)]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  if (first.status !== "fulfilled") throw new Error("start failed");
  const id = first.value,
    directory = host.folder(id);
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      if (!(await host.snapshot()).jobs[0]?.active) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error("fixture runner timeout");
  };
  await wait();
  const before = await readJson(path.join(directory, "job.json"));
  assert.equal((await host.snapshot()).jobs[0]?.status, "awaiting_test");
  await host.resume({ id, testerId: 42, testResultReference: "fixture result" });
  await wait();
  const after = await readJson(path.join(directory, "job.json"));
  assert.deepEqual(after, { ...before, testerId: 42, testResultReference: "fixture result" });
  assert.equal(
    (await readJson(path.join(directory, "fixture-command.json")))?.["command"],
    "resume",
  );
  assert.equal(
    (await readJson(path.join(directory, "fixture-command.json")))?.["hasOverride"],
    false,
  );
  assert.equal(after?.["existingVersionId"], null);
  assert.equal(after?.["workDirectory"], directory);
});
test("tampered executable is rejected before creating a task", async (t) => {
  const { options } = await fixture(t);
  const file = path.join(path.dirname(options.root), "altered.exe");
  await writeFile(file, "untrusted");
  await writeJson(options.authFile, { account: "fixture" });
  const host = new UploaderHost({ ...options, executable: file });
  await assert.rejects(host.start(input), /UPLOADER_INTEGRITY_FAILED/);
  assert.equal((await host.snapshot()).jobs.length, 0);
});
test("new jobs default to recorded parameters and persist version-only text behavior", async (t) => {
  const { host, options } = await fixture(t);
  await writeJson(options.authFile, { account: "fixture" });
  await writeFile(
    options.runner,
    `import fs from 'node:fs/promises';import path from 'node:path';const [,dir,runId]=process.argv.slice(2);await fs.writeFile(path.join(dir,'run-'+runId+'.json'),JSON.stringify({finished:true}));`,
  );
  for (const mode of ["upload_only", "prepare_test"])
    await assert.rejects(host.start({ ...input, mode }), /INVALID_INPUT/);
  const id = await host.start({
    mode: "prepare_publish",
    version: "2.4.28",
    summary: "ignore",
    description: "ignore",
  });
  for (let i = 0; i < 100 && (await host.snapshot()).jobs[0]?.active; i++)
    await new Promise((resolve) => setTimeout(resolve, 30));
  const config = await readJson(path.join(host.folder(id), "job.json"));
  assert.equal(config?.["productId"], "2002");
  assert.equal(config?.["channelId"], "1002");
  assert.equal(config?.["testerId"], 11562);
  assert.equal(config?.["summary"], "2.4.28");
  assert.equal(config?.["description"], "2.4.28");
  assert.equal(config?.["useVersionText"], true);
  assert.equal(config?.["recordedTestWorkflow"], true);
  assert.equal(config?.["testResultReference"], "");
  await writeJson(path.join(host.folder(id), "state.json"), { version: "2.4.29" });
  assert.equal((await host.snapshot()).jobs[0]?.input.summary, "2.4.29");
});
test("final confirmation requires the persisted boundary and uses its own command exactly once", async (t) => {
  const { host, options } = await fixture(t);
  const state = {
    stage: "AWAITING_PUBLISH_CONFIRMATION",
    runStatus: "WAITING",
    finalRemoteStatus: 60,
    version: "2.4.28",
    done: ["START_TEST", "PASS_TEST", "PREPARE_PUBLISH"],
  };
  const { id, folder } = await seed(options, state);
  await assert.rejects(host.confirmPublish(id), /PUBLISH_NOT_READY/);
  await writeJson(path.join(folder, "job.json"), {
    ...input,
    mode: "prepare_publish",
    recordedTestWorkflow: true,
    useVersionText: true,
  });
  assert.equal((await host.snapshot()).jobs[0]?.status, "awaiting_publish");
  await assert.rejects(host.confirmPublish(id), /AUTH_REQUIRED/);
  await writeJson(options.authFile, { account: "fixture" });
  await writeFile(
    options.runner,
    `import fs from 'node:fs/promises';import path from 'node:path';const [,dir,runId,command]=process.argv.slice(2);await fs.appendFile(path.join(dir,'commands.txt'),command+'\\n');await fs.writeFile(path.join(dir,'run-'+runId+'.json'),JSON.stringify({finished:true}));`,
  );
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      if (!(await host.snapshot()).jobs[0]?.active) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error("runner timeout");
  };
  const config = await readFile(path.join(folder, "job.json"), "utf8");
  await host.resume({ id, testerId: input.testerId, testResultReference: "" });
  await wait();
  assert.equal((await host.snapshot()).jobs[0]?.status, "awaiting_publish");
  assert.equal(await readFile(path.join(folder, "job.json"), "utf8"), config);
  const replies = await Promise.allSettled([host.confirmPublish(id), host.confirmPublish(id)]);
  await wait();
  assert.deepEqual(
    replies.map((reply) => reply.status),
    ["fulfilled", "rejected"],
  );
  assert.equal(
    await readFile(path.join(folder, "commands.txt"), "utf8"),
    "resume\nconfirm-publish\n",
  );
  for (const change of [
    { finalRemoteStatus: 99 },
    { pendingAction: "REQUEST_PUBLISH" },
    { done: [] },
    { runStatus: "FAILED" },
  ]) {
    await writeJson(path.join(folder, "state.json"), { ...state, ...change });
    await assert.rejects(host.confirmPublish(id), /PUBLISH_NOT_READY/);
  }
});
test("unreadable jobs remain present and are reported rather than silently discarded", async (t) => {
  const { host, options } = await fixture(t);
  const folder = path.join(options.root, randomUUID());
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "desktop.json"), "malformed{");
  assert.equal((await host.snapshot()).unreadableJobs, 1);
  assert.equal(await readFile(path.join(folder, "desktop.json"), "utf8"), "malformed{");
});
