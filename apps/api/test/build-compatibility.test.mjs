import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { BuildCompatibilityService } from "../dist/build-compatibility.js";
import { JenkinsBuildService, PackagingError } from "../dist/jenkins-builds.js";
import {
  COMPATIBILITY_TARGETS,
  validateCompatibilityReport,
  compatibilitySource,
} from "../dist/jenkins-compatibility.js";
import { createApiApp } from "../dist/app.js";
import { COMPATIBILITY_JOB_NAME } from "@relay-qa-hub/upload-contract";
const jobPath = "/job/" + encodeURIComponent(COMPATIBILITY_JOB_NAME) + "/";
const checkerSource = deflateSync(
  JSON.stringify({
    "BuildCompatibility.py": "# fixture only: validates source transfer; does not execute a build",
    "CheckPlayerRebuildRequired.py": "# fixture only: comparison rules from the original job",
  }),
).toString("base64");
test("checker source contract rejects missing, corrupt and unexpected modules", () => {
  assert.equal(compatibilitySource(`base64.b64decode('${checkerSource}')`), checkerSource);
  for (const config of [
    "missing",
    "base64.b64decode('" + "a".repeat(200) + "')",
    `base64.b64decode('${deflateSync(JSON.stringify({ "arbitrary.py": randomUUID().repeat(10) })).toString("base64")}')`,
  ])
    assert.throws(() => compatibilitySource(config), /CHECK_SOURCE_CHANGED/);
});
function report(t = COMPATIBILITY_TARGETS[0]) {
  const ref = t.platform + "/" + t.configuration + "/2.5.1/12";
  return {
    platform: t.platform,
    configuration: t.configuration,
    selection: "latest",
    result: "HOT_UPDATE_ALLOWED",
    requiresPlayerRebuild: false,
    selectedVersion: ref,
    playerVersion: ref,
    chain: [ref],
    baseRevision: "a".repeat(40),
    targetRevision: "b".repeat(40),
    commits: ["b".repeat(40) + " change"],
    changes: [
      { category: "hot_update", path: "baloot_client/Assets/Hot.cs", reason: "hot assembly" },
    ],
  };
}
async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-compatibility-"));
  t.after(async () => {
    assert.ok(root.startsWith(path.join(os.tmpdir(), "qa-compatibility-")));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
test("report requires the correct platform, actual Player lineage and consistent verdict", () => {
  assert.equal(validateCompatibilityReport(report(), COMPATIBILITY_TARGETS[0]).commitCount, 1);
  for (const changed of [
    { platform: "iOS" },
    { configuration: "Release" },
    { selection: "old" },
    { playerVersion: "iOS/Debug/2.5.1/12" },
    { chain: ["Android/Debug/2.4.0/11"] },
    { targetRevision: "main" },
    { requiresPlayerRebuild: true },
    { result: "SUCCESS" },
    { changes: [{ category: "player" }] },
    { changes: [{ category: "unverified" }] },
  ])
    assert.throws(
      () => validateCompatibilityReport({ ...report(), ...changed }, COMPATIBILITY_TARGETS[0]),
      /CHECK_INVALID_REPORT/,
    );
  assert.equal(
    validateCompatibilityReport(
      {
        ...report(),
        result: "UNKNOWN",
        requiresPlayerRebuild: true,
        reason: "secret transport text",
      },
      COMPATIBILITY_TARGETS[0],
    ).result,
    "UNKNOWN",
  );
  assert.ok(
    !JSON.stringify(
      validateCompatibilityReport(
        { ...report(), reason: "secret transport text" },
        COMPATIBILITY_TARGETS[0],
      ),
    ).includes("secret"),
  );
});
test("four checks dispatch once, survive restart, and a completed page entry requests a fresh batch", async (t) => {
  const root = await temp(t),
    posts = [];
  const jenkins = {
    startCompatibility: async (target) => {
      posts.push(target.id);
      return posts.length;
    },
    compatibilityProgress: async (c) => ({
      ...c,
      state: "complete",
      report: validateCompatibilityReport(report(c.target), c.target),
      checkedAt: new Date().toISOString(),
    }),
  };
  let service = new BuildCompatibilityService(jenkins, root);
  const id = randomUUID(),
    first = await service.start(id);
  assert.equal(first.checks.length, 4);
  await service.close();
  assert.deepEqual(
    posts,
    COMPATIBILITY_TARGETS.map((t) => t.id),
  );
  service = new BuildCompatibilityService(jenkins, root);
  const restored = await service.status(id);
  assert.ok(restored.checks.every((c) => c.state === "complete"));
  assert.equal(posts.length, 4);
  await service.start(id);
  await service.close();
  assert.equal(posts.length, 4);
  await service.start(randomUUID());
  await service.close();
  assert.equal(posts.length, 8);
});
test("overlapping page entries share in-flight checks while an uncertain POST is never replayed", async (t) => {
  const root = await temp(t);
  let unlock;
  const held = new Promise((r) => {
    unlock = r;
  });
  let posts = 0;
  const jenkins = {
    startCompatibility: async () => {
      posts++;
      await held;
      return posts;
    },
    compatibilityProgress: async (c) => c,
  };
  const service = new BuildCompatibilityService(jenkins, root),
    one = await service.start(randomUUID());
  const two = await service.start(randomUUID());
  assert.equal(two.id, one.id);
  unlock();
  await service.close();
  assert.equal(posts, 4);
  const file = path.join(root, "current.json"),
    saved = JSON.parse(await fs.readFile(file, "utf8"));
  saved.checks[0].state = "submitting";
  saved.checks[0].queueId = null;
  await fs.writeFile(file, JSON.stringify(saved));
  const restarted = new BuildCompatibilityService(jenkins, root);
  const result = await restarted.status(one.id);
  await restarted.close();
  assert.equal(result.checks[0].errorCode, "JENKINS_SUBMISSION_UNKNOWN");
  assert.equal(posts, 4);
});
test("temporary Jenkins read failure remains queued and a failed checker never permits incremental output", async () => {
  let offline = true;
  const service = new BuildCompatibilityService({
    startCompatibility: async () => 1,
    compatibilityProgress: async (c) => {
      if (offline) throw new PackagingError("PACKAGING_UNAVAILABLE");
      return {
        ...c,
        state: "complete",
        report: validateCompatibilityReport(
          { ...report(c.target), result: "UNKNOWN", requiresPlayerRebuild: true },
          c.target,
        ),
      };
    },
  });
  const batch = await service.start(randomUUID());
  await service.close();
  assert.ok(
    (await service.status(batch.id)).checks.every((c) => c.state === "queued" && c.report === null),
  );
  offline = false;
  assert.ok((await service.status(batch.id)).checks.every((c) => c.report.result === "UNKNOWN"));
  await service.close();
});
function fixture(overrides = {}) {
  const posts = [];
  const target = COMPATIBILITY_TARGETS[0],
    label = "Android Debug · 快捷检测";
  const fetcher = async (value, init = {}) => {
    const url = new URL(value);
    const headers = new Headers(init.headers);
    assert.equal(url.origin, "http://10.100.5.129:8080");
    assert.ok(headers.has("authorization"));
    assert.equal(init.redirect, "manual");
    if (url.pathname === "/job/" + encodeURIComponent("00-【OZDQP】【快捷打包】") + "/config.xml")
      return new Response(`base64.b64decode('${checkerSource}')`);
    if (url.pathname === jobPath + "api/json")
      return Response.json({
        buildable: true,
        builds: [],
        property: [{ parameterDefinitions: [{ name: "打包用途" }, { name: "参考版本" }] }],
      });
    if (url.pathname === jobPath + "config.xml")
      return new Response(
        COMPATIBILITY_TARGETS.map((t) => t.platform + " " + t.configuration + " · 快捷检测").join(
          "\n",
        ),
      );
    if (url.pathname === "/crumbIssuer/api/json")
      return Response.json({ crumbRequestField: "Jenkins-Crumb", crumb: "test" });
    if (url.pathname === jobPath + "buildWithParameters") {
      posts.push(Object.fromEntries(new URLSearchParams(init.body)));
      return new Response(null, { status: 201, headers: { location: "/queue/item/17/" } });
    }
    if (url.pathname === "/queue/item/17/api/json")
      return Response.json({
        id: 17,
        task: { url: "http://10.100.5.129:8080" + jobPath },
        executable: { number: 14, url: "http://10.100.5.129:8080" + jobPath + "14/" },
        ...overrides.queue,
      });
    if (url.pathname === jobPath + "14/api/json")
      return Response.json({
        number: 14,
        queueId: 17,
        building: false,
        result: "SUCCESS",
        timestamp: Date.now() - 4000,
        duration: 3000,
        actions: [
          {
            parameters: [
              { name: "打包用途", value: label },
              { name: "参考版本", value: "自动：最新成功版本" },
            ],
          },
        ],
        ...overrides.build,
      });
    if (url.pathname === jobPath + "14/artifact/compatibility.json")
      return Response.json({ ...report(), ...overrides.report });
    throw new Error("Unexpected fixture route");
  };
  return { service: new JenkinsBuildService(fetcher), posts, target };
}
test("Jenkins adapter submits only Check purposes and verifies queue, build and archived report identity", async () => {
  const { service, posts, target } = fixture();
  assert.equal(await service.startCompatibility(target), 17);
  assert.deepEqual(posts, [
    {
      打包用途: "Android Debug · 快捷检测",
      参考版本: "自动：最新成功版本",
      CHECK_SOURCE: checkerSource,
    },
  ]);
  const check = {
    target,
    state: "queued",
    queueId: 17,
    buildNumber: null,
    checkedAt: null,
    reportUrl: null,
    errorCode: null,
    report: null,
  };
  assert.equal((await service.compatibilityProgress(check)).report.result, "HOT_UPDATE_ALLOWED");
  for (const options of [
    { queue: { task: { url: "http://evil.invalid/" } } },
    { build: { queueId: 18 } },
    {
      build: {
        actions: [{ parameters: [{ name: "打包用途", value: "Android Debug · APK、完整热更" }] }],
      },
    },
    { report: { platform: "iOS" } },
    { report: { requiresPlayerRebuild: true } },
  ])
    await assert.rejects(
      fixture(options).service.compatibilityProgress(check),
      /CHECK_(?:IDENTITY_MISMATCH|INVALID_REPORT)/,
    );
});
test("refresh endpoint requires authentication and accepts no build choice or arbitrary command", async () => {
  const f = fixture(),
    app = await createApiApp({
      jenkinsBuildService: f.service,
      debugBearerToken: "compatibility-fixture",
    });
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/packaging/compatibility",
          headers: { "idempotency-key": randomUUID() },
        })
      ).statusCode,
      401,
    );
    assert.equal(f.posts.length, 0);
    const headers = {
      authorization: "Bearer compatibility-fixture",
      "idempotency-key": randomUUID(),
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/packaging/compatibility",
          headers,
          payload: { preset: "android-release-app" },
        })
      ).statusCode,
      400,
    );
    assert.equal(f.posts.length, 0);
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/v1/packaging/compatibility", headers }))
        .statusCode,
      202,
    );
  } finally {
    await app.close();
  }
  assert.equal(f.posts.length, 4);
  assert.ok(f.posts.every((p) => p["打包用途"].endsWith(" · 快捷检测")));
});
