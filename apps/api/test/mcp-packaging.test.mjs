import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApiApp } from "../dist/app.js";
import { IncrementUploadService } from "../dist/increment-upload.js";
import { DesktopQaHubApiClient, QaHubMcpTools } from "../../desktop/dist/mcp-api.js";
import { QaHubMcpHttpServer } from "../../desktop/dist/mcp-server.js";
import { parseDesktopConfig } from "../../desktop/dist/config.js";
import { DesktopBrowserSessionCookieStore } from "../../desktop/dist/network.js";

// Exercise real MCP HTTP, desktop authentication transport, API routes, SQLite
// queue and build-to-upload handoff. Only Jenkins and the platform worker are fixtures.
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-mcp-upload-"));
  const owner = randomUUID(),
    other = randomUUID(),
    hosts = new Map(),
    builds = [],
    launches = [];
  let buildReady = false,
    configured = true,
    api,
    service,
    mcp;
  const startedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 10000).toISOString();
  const source = { size: 1234, lastModified: new Date(Date.parse(startedAt) + 5000).toUTCString() };
  const hostFactory = (actor) => {
    if (hosts.has(actor)) return hosts.get(actor);
    const jobs = [],
      folder = (id) => path.join(root, "workers", actor, id);
    const launch = async (input, id, pinned) => {
      await mkdir(folder(id), { recursive: true });
      await writeFile(
        path.join(folder(id), "desktop.json"),
        JSON.stringify({ runId: randomUUID() }),
      );
      const job = {
        id,
        input,
        createdAt: new Date().toISOString(),
        active: true,
        status: "running",
        stage: "UPLOADING",
        errorCode: "",
        version: "fixture-2.4.36",
        versionId: 999,
        size: 1234,
        sha256: "fixture-sha",
        done: [],
        testResultLocked: false,
        pendingAction: "",
        published: false,
        publishTime: "",
        remoteStatus: 20,
        events: [],
      };
      const index = jobs.findIndex((j) => j.id === id);
      if (index < 0) jobs.push(job);
      else jobs[index] = job;
      launches.push({ actor, id, input, pinned });
      return id;
    };
    const host = {
      jobs,
      folder,
      snapshot: async () => ({
        available: true,
        configured,
        toolVersion: "fixture",
        account: "private-platform-account",
        kind: "email",
        authError: false,
        unreadableJobs: 0,
        jobs: structuredClone(jobs),
      }),
      checkAuth: async () => true,
      accountIdentity: async () => "private-platform-binding",
      hasBuildJob: async (id) => jobs.some((j) => j.id === id),
      startWithId: launch,
      startForBuild: launch,
      resume: async ({ id }) => launch(jobs.find((j) => j.id === id).input, id),
      confirmPublish: async (id) => {
        Object.assign(
          jobs.find((j) => j.id === id),
          {
            active: false,
            status: "succeeded",
            stage: "PUBLISHED",
            published: true,
            remoteStatus: 100,
          },
        );
        return id;
      },
    };
    hosts.set(actor, host);
    return host;
  };
  const jenkins = {
    trigger: async (preset, key) => {
      builds.push({ preset, key });
      return { queueId: 760, preset };
    },
    status: async () => ({
      queue: [{ id: 760, reason: "等待执行器", preset: "external" }],
      builds: [],
    }),
    progress: async () => ({
      queues: buildReady ? [] : [{ id: 760, status: "QUEUED", reason: "等待执行器" }],
      builds: buildReady
        ? [
            {
              number: 10170,
              queueId: 760,
              preset: "external",
              status: "SUCCESS",
              includesZip: true,
              stages: [{ id: "zip", state: "complete" }],
              startedAt,
              elapsedMs: 10000,
              logError: false,
            },
          ]
        : [],
    }),
  };
  const openApi = async () => {
    service = new IncrementUploadService({
      root,
      jenkins,
      hostFactory,
      fetch: async () =>
        buildReady
          ? new Response(null, {
              headers: {
                "content-length": String(source.size),
                "last-modified": source.lastModified,
              },
            })
          : new Response(null, { status: 404 }),
    });
    service.start = () => {}; // deterministic scheduler ticks, with real durable storage
    api = createApiApp({
      logger: false,
      incrementUploadService: service,
      jenkinsBuildService: jenkins,
      debugBearerToken: "mcp-fixture-token",
      debugActorId: owner,
    });
    await api.listen({ host: "127.0.0.1", port: 0 });
  };
  const openMcp = async (actor = owner, token = "mcp-fixture-token") => {
    const url = `http://127.0.0.1:${api.server.address().port}`;
    const config = parseDesktopConfig({
      QA_HUB_DESKTOP_API_BASE_URL: url,
      QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "true",
      QA_HUB_DESKTOP_ACCESS_TOKEN: token,
    });
    const client = new DesktopQaHubApiClient(
      config,
      new DesktopBrowserSessionCookieStore(),
      (url, init) =>
        fetch(url, {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init.headers)), "x-qa-actor-id": actor },
        }),
    );
    mcp = new QaHubMcpHttpServer({
      port: 0,
      serverVersion: "fixture",
      tools: new QaHubMcpTools(client, path.join(root, "attachments")),
    });
    await mcp.start();
  };
  const call = async (name, args = {}) => {
    const response = await fetch(mcp.status.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    return body.result;
  };
  const ok = async (name, args) => {
    const result = await call(name, args);
    assert.equal(result.isError, false, result.content[0].text);
    return result.structuredContent;
  };
  await openApi();
  await openMcp();
  t.after(async () => {
    await mcp.stop();
    await api.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    owner,
    other,
    hosts,
    launches,
    builds,
    source,
    call,
    ok,
    get service() {
      return service;
    },
    setReady: () => {
      buildReady = true;
    },
    setConfigured: (value) => {
      configured = value;
    },
    stopMcp: () => mcp.stop(),
    openMcp,
    restart: async () => {
      await mcp.stop();
      await api.close();
      await openApi();
      await openMcp();
    },
    switchActor: async (actor, token) => {
      await mcp.stop();
      await openMcp(actor, token);
    },
  };
}
test("one MCP call persists one build, survives API/MCP restart and hands the exact ZIP to one upload", async (t) => {
  const f = await fixture(t),
    requestId = randomUUID();
  const submitted = await f.ok("qa_build_and_upload", { requestId, mode: "prepare_publish" });
  assert.equal(submitted.chainId, requestId);
  assert.equal(submitted.chain.status, "queued");
  await f.ok("qa_build_and_upload", { requestId, mode: "prepare_publish" });
  assert.equal(f.builds.length, 0);
  await f.stopMcp();
  await f.service.tick(); // worker progress is independent of the client
  assert.equal(f.builds.length, 1);
  assert.equal(f.builds[0].preset, "external");
  await f.restart();
  await f.ok("qa_build_and_upload", { requestId, mode: "prepare_publish" });
  const conflict = await f.call("qa_build_and_upload", { requestId, mode: "publish_workflow" });
  assert.equal(JSON.parse(conflict.content[0].text).code, "UPLOAD_REQUEST_CONFLICT");
  const waiting = await f.ok("qa_get_packaging_status", { queueIds: [760] });
  assert.equal(waiting.queues[0].reason, "等待执行器");
  f.setReady();
  await f.stopMcp();
  await f.service.tick();
  await f.openMcp();
  assert.equal(f.builds.length, 1);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].id, requestId);
  assert.deepEqual(f.launches[0].pinned, f.source);
  const progress = await f.ok("qa_get_increment_upload_status", {
    chainId: requestId,
    includeLogs: true,
  });
  assert.equal(progress.chain.status, "upload_started");
  assert.equal(progress.job.status, "running");
  assert.equal(progress.job.published, false);
  assert.ok(progress.logs.audit.length);
  Object.assign(f.hosts.get(f.owner).jobs[0], {
    active: false,
    status: "failed",
    errorCode: "CHECKPOINT_WRITE_FAILED",
  });
  await f.switchActor(f.other);
  const shared = await f.ok("qa_get_increment_upload_status", { chainId: requestId });
  assert.equal(shared.job.canManage, false);
  assert.equal(shared.job.errorCode, "CHECKPOINT_WRITE_FAILED");
  const denied = await f.call("qa_resume_increment_upload", {
    requestId: randomUUID(),
    jobId: requestId,
  });
  assert.equal(JSON.parse(denied.content[0].text).code, "JOB_NOT_FOUND");
  await f.switchActor(f.owner);
  const resumeId = randomUUID();
  await f.ok("qa_resume_increment_upload", { requestId: resumeId, jobId: requestId });
  await f.ok("qa_resume_increment_upload", { requestId: resumeId, jobId: requestId });
  await f.service.tick();
  assert.equal(f.launches.length, 2);
  assert.deepEqual(f.launches[1].input, f.launches[0].input);
  Object.assign(f.hosts.get(f.owner).jobs[0], { active: false, status: "awaiting_publish" });
  await f.ok("qa_confirm_increment_publish", { requestId: randomUUID(), jobId: requestId });
  await f.service.tick();
  const done = await f.ok("qa_get_increment_upload_status", { chainId: requestId });
  assert.equal(done.job.published, true);
  assert.equal(done.job.remoteStatus, 100);
});
test("MCP authentication, upload account, iOS channel and cancellation use backend enforcement", async (t) => {
  const f = await fixture(t);
  await f.switchActor(f.owner, "invalid-token");
  const auth = await f.call("qa_build_and_upload", { requestId: randomUUID() });
  assert.equal(auth.isError, true);
  assert.equal(f.builds.length, 0);
  await f.switchActor(f.owner);
  f.setConfigured(false);
  const missing = await f.call("qa_start_increment_upload", { requestId: randomUUID() });
  assert.equal(JSON.parse(missing.content[0].text).code, "AUTH_REQUIRED");
  f.setConfigured(true);
  const requestId = randomUUID();
  await f.ok("qa_start_increment_upload", { requestId, platform: "ios", mode: "prepare_publish" });
  const queued = await f.ok("qa_get_increment_upload_status", { jobId: requestId });
  assert.equal(queued.job.input.channelId, "2004");
  assert.equal(queued.job.input.testerId, 11562);
  await f.ok("qa_cancel_increment_upload", { jobId: requestId });
  await f.service.tick();
  assert.equal(f.launches.length, 0);
  const chainId = randomUUID();
  await f.ok("qa_build_and_upload", { requestId: chainId });
  await f.ok("qa_cancel_build_upload", { chainId });
  await f.service.tick();
  assert.equal(f.builds.length, 0);
  for (const preset of ["external", "internal-sdk", "internal-nosdk"]) {
    const build = await f.ok("qa_start_build", { requestId: randomUUID(), preset });
    assert.equal(build.queueId, 760);
  }
  assert.deepEqual(
    f.builds.map((b) => b.preset),
    ["external", "internal-sdk", "internal-nosdk"],
  );
});
