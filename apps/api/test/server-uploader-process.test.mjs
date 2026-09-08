import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { IncrementUploadService } from "../dist/increment-upload.js";

test("real server supervisor records the worker result after the API closes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "server-uploader-process-"));
  const owner = randomUUID(),
    id = randomUUID(),
    ownerRoot = path.join(root, "owners", owner);
  await mkdir(ownerRoot, { recursive: true });
  // The intentionally wrong origin fails locally in TokenCache.Load before any
  // business/network request. It distinguishes our server cache from a missing cache.
  await writeFile(
    path.join(ownerRoot, "auth.json"),
    JSON.stringify({
      account: "local-process-fixture",
      kind: "email",
      apiBase: "https://wrong-origin.invalid",
      loginBase: "https://54cetx.jiaxiangxm.com",
      accessToken: "fixture-invalid",
      refreshToken: "",
      password: "",
    }),
  );
  const options = {
    root,
    jenkins: {
      trigger: () => {
        throw new Error("NO_BUSINESS_WRITES");
      },
      progress: () => {
        throw new Error("NO_BUSINESS_READS");
      },
    },
  };
  let service = new IncrementUploadService(options);
  let closed = false;
  t.after(async () => {
    if (!closed) await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await service.enqueue(owner, id, {
    productId: "2002",
    channelId: "1002",
    belongName: "Local process fixture",
    version: "fixture-only",
    testerId: 11562,
    mode: "prepare_publish",
  });
  await service.tick();
  await service.close();
  closed = true;
  const jobRoot = path.join(ownerRoot, "jobs", id),
    meta = JSON.parse(await readFile(path.join(jobRoot, "desktop.json"), "utf8"));
  let receipt;
  for (let i = 0; i < 100; i++) {
    try {
      receipt = JSON.parse(await readFile(path.join(jobRoot, `run-${meta.runId}.json`), "utf8"));
      if (receipt.finished) break;
    } catch {
      /* Supervisor has not written yet. */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(receipt?.finished, true);
  assert.equal(receipt.exitCode, 3);
  const output = await readFile(path.join(jobRoot, `run-${meta.runId}.jsonl`), "utf8");
  const event = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((e) => e.data?.code === "AUTH_REQUIRED");
  assert.equal(event.data.message, "登录缓存环境不匹配。");
  service = new IncrementUploadService(options);
  closed = false;
  await service.tick();
  const snapshot = await service.snapshot(owner);
  assert.equal(snapshot.jobs[0].errorCode, "AUTH_REQUIRED");
  assert.equal(snapshot.jobs[0].stage, "AUTHENTICATING");
  assert.equal(
    JSON.parse(await readFile(path.join(jobRoot, "desktop.json"), "utf8")).runId,
    meta.runId,
  );
  assert.equal(snapshot.execution, "server");
});
