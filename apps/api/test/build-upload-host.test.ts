import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildInfo } from "./quick-build-fixture.mjs";
import { validateBuildResult } from "../src/build-artifacts.js";
import { QUICK_BUILD_PRESETS } from "@relay-qa-hub/upload-contract";
import { BuildUploadHost } from "../src/build-upload-host.js";
import { readJson, writeJson } from "../src/uploader-host.js";
import type { UploadInput, UploadSourceIdentity } from "../src/uploader-types.js";
interface QaHubJsonRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
}

const input: UploadInput = {
  productId: "2002",
  channelId: "1002",
  belongName: "fixture",
  testerId: 11562,
  mode: "prepare_publish",
  version: "",
  summary: "",
  description: "",
  testResultReference: "",
};
async function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qahub-build-chain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = Date.now() - 120000;
  const state = {
    owner: randomUUID(),
    posts: 0,
    authChecks: 0,
    starts: [] as { input: UploadInput; id: string; source: UploadSourceIdentity }[],
    heads: 0,
    artifactError: false,
    authError: false,
    lostPost: false,
    lostHandoff: false,
    cancel: false,
    queueOnly: true,
    other: [] as unknown[],
    size: 1234,
    modified: new Date(start - 60000).toUTCString(),
    build: {
      number: 321,
      queueId: 42,
      preset: "android-release-app",
      status: "SUCCESS",
      startedAt: new Date(start).toISOString(),
      elapsedMs: 60000,
      includesZip: true,
      logError: false,
      stages: [{ id: "zip", state: "complete" }],
    },
  };
  let platformAccount = "fixture-account";
  const options = {
    root,
    sourceUrl: "https://artifacts.fixture.invalid/test.zip",
    projectId: randomUUID(),
    componentVersion: 3,
    preset: "external",
    defaults: input,
    api: {
      json: async (url: string, request?: QaHubJsonRequest) => {
        if (url === "/api/v1/auth/me") return { userId: state.owner };
        if (url === "/api/v1/packaging/builds") {
          state.posts++;
          assert.equal(request?.method, "POST");
          assert.deepEqual(request.body, { preset: "android-release-app" });
          assert.ok(request.headers?.["idempotency-key"]);
          if (state.lostPost) throw new Error("REQUEST_TIMEOUT");
          return { queueId: 42 };
        }
        if (url.startsWith("/api/v1/packaging/build-result?")) {
          if (state.artifactError) throw new Error("BUILD_ARTIFACT_MISMATCH");
          return validateBuildResult(buildInfo(), QUICK_BUILD_PRESETS[2]!);
        }
        const query = new URL(url, "http://fixture.local").searchParams;
        assert.equal(query.get("queues"), "42");
        // The existing API rejects empty ID parameters; unresolved builds must be omitted.
        for (const [, value] of query) assert.match(value, /^\d{1,10}(,\d{1,10}){0,9}$/u);
        return {
          builds: state.queueOnly ? state.other : [state.build, ...state.other],
          queues: state.queueOnly
            ? [{ id: 42, status: state.cancel ? "CANCELLED" : "QUEUED" }]
            : [],
        };
      },
    },
    uploader: {
      accountIdentity: async () => platformAccount,
      hasBuildJob: async (id: string) => state.starts.some((x) => x.id === id),
      checkAuth: async () => {
        state.authChecks++;
        if (state.authError) throw new Error("AUTH_REQUIRED");
        return true;
      },
      startForBuild: async (value: UploadInput, id: string, source: UploadSourceIdentity) => {
        if (!state.starts.some((x) => x.id === id)) state.starts.push({ input: value, id, source });
        if (state.lostHandoff) {
          state.lostHandoff = false;
          throw new Error("UPLOADER_START_FAILED");
        }
        return id;
      },
    },
    fetch: (async (url, init) => {
      assert.equal(new URL(String(url)).host, "artifacts.fixture.invalid");
      assert.equal(init?.method, "HEAD");
      assert.equal(init?.headers, undefined);
      state.heads++;
      return new Response(null, {
        headers: { "content-length": String(state.size), "last-modified": state.modified },
      });
    }) as typeof fetch,
  };
  const host = new BuildUploadHost(options);
  const finish = () => {
    state.queueOnly = false;
    state.modified = new Date(start + 30000).toUTCString();
  };
  return {
    root,
    state,
    host,
    options,
    finish,
    switchPlatformAccount: () => {
      platformAccount = "other-account";
    },
    request: { requestId: randomUUID(), upload: input },
  };
}
test("exact queue and completed fresh ZIP hand off once with frozen defaults after restart", async (t) => {
  const f = await fixture(t);
  const chain = await f.host.start(f.request);
  assert.equal(chain.status, "building");
  assert.equal(chain.projectId, f.options.projectId);
  assert.equal(chain.componentVersion, f.options.componentVersion);
  assert.equal(f.state.authChecks, 1);
  f.state.other = [{ ...f.state.build, number: 320, queueId: 41 }];
  await f.host.tick();
  assert.equal(f.state.starts.length, 0);
  f.state.other = [];
  f.finish();
  const restarted = new BuildUploadHost(f.options);
  await restarted.tick();
  await restarted.tick();
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.starts.length, 1);
  assert.equal(f.state.starts[0]?.id, chain.id);
  assert.equal(f.state.starts[0]?.input.version, "2.4.37");
  assert.equal(f.state.starts[0]?.input.summary, "2.4.37");
  assert.equal(f.state.starts[0]?.source.sha256, "a".repeat(64));
  assert.equal(f.state.starts[0]?.input.testerId, 11562);
  assert.equal(f.state.starts[0]?.input.mode, "prepare_publish");
  assert.equal(f.state.starts[0]?.source.lastModified, f.state.modified);
  assert.equal((await restarted.list())[0]?.status, "upload_started");
});
test("preflight failure prevents Jenkins submission and double submission coalesces", async (t) => {
  const f = await fixture(t);
  f.state.authError = true;
  await assert.rejects(f.host.start(f.request), /AUTH_REQUIRED/);
  assert.equal(f.state.posts, 0);
  f.state.authError = false;
  const replies = await Promise.allSettled([f.host.start(f.request), f.host.start(f.request)]);
  assert.equal(replies.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.state.posts, 1);
  await f.host.start(f.request);
  assert.equal(f.state.posts, 1);
  await assert.rejects(
    f.host.start({ ...f.request, requestId: randomUUID() }),
    /BUILD_CHAIN_ACTIVE/,
  );
});
test("lost submission acknowledgement and submitting crash never replay build POST", async (t) => {
  const f = await fixture(t);
  f.state.lostPost = true;
  const chain = await f.host.start(f.request);
  assert.equal(chain.status, "submission_unknown");
  await f.host.tick();
  await new BuildUploadHost(f.options).tick();
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.starts.length, 0);
  chain.status = "submitting";
  await writeJson(path.join(f.root, `${chain.id}.json`), chain);
  await f.host.tick();
  assert.equal((await f.host.list())[0]?.status, "submission_unknown");
  assert.equal(f.state.posts, 1);
});
test("lost upload acknowledgement recovers the same stable job ID", async (t) => {
  const f = await fixture(t);
  await f.host.start(f.request);
  f.finish();
  f.state.lostHandoff = true;
  await f.host.tick();
  assert.equal((await f.host.list())[0]?.status, "starting_upload");
  await new BuildUploadHost(f.options).tick();
  assert.equal(f.state.starts.length, 1);
  assert.equal((await f.host.list())[0]?.status, "upload_started");
});
test("a Jenkins run waiting on the shared lock keeps its automatic upload pending", async (t) => {
  const f = await fixture(t);
  await f.host.start(f.request);
  f.finish();
  f.state.build.status = "BUILDING";
  Object.assign(f.state.build, {
    queueWait: {
      active: true,
      blockingBuild: "iOS_Build #30",
      elapsedMs: 600000,
      timing: "recorded",
    },
  });
  await f.host.tick();
  assert.equal((await f.host.list())[0]?.status, "building");
  assert.equal(f.state.starts.length, 0);
  f.state.build.status = "SUCCESS";
  await f.host.tick();
  assert.equal(f.state.starts.length, 1);
});
for (const scenario of ["failed", "cancelled", "artifact-mismatch", "wrongqueue"]) {
  test(`${scenario} build or ZIP never starts automatic upload`, async (t) => {
    const f = await fixture(t);
    await f.host.start(f.request);
    f.finish();
    if (scenario === "failed") f.state.build.status = "FAILURE";
    if (scenario === "cancelled") {
      f.state.queueOnly = true;
      f.state.cancel = true;
    }
    if (scenario === "artifact-mismatch") f.state.artifactError = true;
    if (scenario === "wrongqueue") {
      await writeJson(path.join(f.root, `${f.request.requestId}.json`), {
        ...(await readJson(path.join(f.root, `${f.request.requestId}.json`))),
        buildNumber: 321,
      });
      f.state.build.queueId = 77;
    }

    await f.host.tick();
    assert.equal(f.state.starts.length, 0);
    assert.ok(["failed", "cancelled"].includes((await f.host.list())[0]!.status));
  });
}
test("owner switch pauses automation and cancellation retains Jenkins build", async (t) => {
  const f = await fixture(t);
  await f.host.start(f.request);
  const owner = f.state.owner;
  f.state.owner = randomUUID();
  f.finish();
  await f.host.tick();
  assert.equal(f.state.starts.length, 0);
  assert.deepEqual(await f.host.list(), []);
  await assert.rejects(f.host.cancel(f.request.requestId), /JOB_NOT_FOUND/);
  f.state.owner = owner;
  await f.host.cancel(f.request.requestId);
  await f.host.tick();
  assert.equal(f.state.starts.length, 0);
  assert.equal(f.state.posts, 1);
  assert.equal((await f.host.list())[0]?.status, "cancelled");
});
test("platform account switch pauses before upload and allows cancelling the pending handoff", async (t) => {
  const f = await fixture(t);
  await f.host.start(f.request);
  f.finish();
  f.switchPlatformAccount();
  await f.host.tick();
  assert.equal(f.state.starts.length, 0);
  assert.equal((await f.host.list())[0]?.errorCode, "UPLOAD_ACCOUNT_CHANGED");
  await f.host.cancel(f.request.requestId);
  await f.host.tick();
  assert.equal((await f.host.list())[0]?.status, "cancelled");
  assert.equal(f.state.starts.length, 0);
});
