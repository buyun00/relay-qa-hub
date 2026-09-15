import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  IosInstallService,
  resolveInstallArtifact,
  parseIosSelection,
  registerIosInstallRoutes,
} from "../dist/ios-install.js";
import {
  JenkinsIosInstallBackend,
  IOS_JOB_PATH,
  validateIosReport,
} from "../dist/jenkins-ios-install.js";
import { PackagingError } from "../dist/jenkins-builds.js";
import { quickBuildPreset, defaultIosDevice, IOS_INSTALL_JOB } from "@relay-qa-hub/upload-contract";
import { buildInfo } from "./quick-build-fixture.mjs";
const deviceId = "23155d04-d2d0-5469-8457-0294b916899e";
const selection = {
  configuration: "Release",
  version: "2.4.37",
  buildNumber: 46,
  filename: "app.ipa",
  deviceId,
};
const artifact = {
  url: "http://10.100.5.129:8000/ozdqp/iOS/Release/2.4.37/46/packages/app.ipa",
  sha256: "a".repeat(64),
  size: 1234,
};
const devices = [
  {
    id: deviceId,
    name: "test",
    model: "iPhone 15",
    osVersion: "26.2",
    online: false,
    developerMode: true,
    connection: "network",
  },
];
const report = (r, extra = {}) => ({
  schemaVersion: 1,
  requestId: r.id,
  action: r.action,
  status: "complete",
  errorCode: null,
  checkedAt: new Date().toISOString(),
  devices,
  ...extra,
});
test("default selects exactly one iPhone 15, never a different phone or ambiguous device", () => {
  assert.equal(defaultIosDevice(devices), deviceId);
  assert.equal(defaultIosDevice([{ ...devices[0], model: "iPhone 14" }]), "");
  assert.equal(defaultIosDevice([...devices, { ...devices[0], id: randomUUID() }]), "");
});
test("only exact manifest IPA is resolved, rejecting client URLs and mismatched version", async () => {
  const raw = buildInfo(quickBuildPreset("ios-release-app"));
  const file = raw.packages[0];
  const input = { ...selection, filename: file.file.split("/").at(-1) };
  const result = await resolveInstallArtifact(input, async (url) => {
    assert.equal(url, "http://10.100.5.129:8000/ozdqp/iOS/Release/2.4.37/46/build-info.json");
    return Response.json(raw);
  });
  assert.equal(result.sha256, file.sha256);
  assert.ok(result.url.endsWith("/" + file.file));
  await assert.rejects(
    resolveInstallArtifact({ ...input, version: "9.9.9" }, async () => Response.json(raw)),
    /IOS_IPA_CHANGED/,
  );
  for (const mutation of [
    { url: "http://elsewhere/a.ipa" },
    { filename: "../app.ipa" },
    { filename: "hot.zip" },
    { deviceId: "iPhone 15" },
    { buildNumber: 0 },
  ])
    assert.throws(() => parseIosSelection({ ...selection, ...mutation }), /INVALID_REQUEST/);
});
test("duplicate install and device lock persist through restart without re-submission", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-ios-"));
  let submitted = 0;
  const backend = {
    submit: async () => {
      submitted++;
      return 41;
    },
    poll: async () => ({ state: "running", buildNumber: 5 }),
  };
  let s = new IosInstallService(backend, root, async () => artifact);
  const id = randomUUID();
  try {
    await s.start(id, "install", selection);
    await s.start(id, "install", selection);
    assert.equal(submitted, 1);
    await assert.rejects(s.start(randomUUID(), "install", selection), /IOS_INSTALL_BUSY/);
    await assert.rejects(
      s.start(id, "install", { ...selection, version: "2.4.38" }),
      /IOS_INSTALL_REQUEST_CONFLICT/,
    );
    await s.close();
    s = new IosInstallService(backend, root, async () => artifact);
    await s.refresh();
    assert.equal((await s.snapshot()).installs[0].buildNumber, 5);
    assert.equal(submitted, 1);
  } finally {
    await s.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("uncertain submission reconciles original request and never retries POST", async () => {
  let submitted = 0;
  const s = new IosInstallService(
    {
      submit: async () => {
        submitted++;
        throw new PackagingError("JENKINS_SUBMISSION_UNKNOWN");
      },
      poll: async () => ({ state: "queued", queueId: 7 }),
    },
    undefined,
    async () => artifact,
  );
  try {
    const id = randomUUID();
    assert.equal((await s.start(id, "install", selection)).state, "submission_unknown");
    await s.refresh();
    await s.start(id, "install", selection);
    assert.equal(submitted, 1);
    assert.equal((await s.snapshot()).installs[0].queueId, 7);
  } finally {
    await s.close();
  }
});
test("failed scan retains previous device inventory; concurrent scan clicks coalesce", async () => {
  let n = 0;
  const s = new IosInstallService({
    submit: async () => ++n,
    poll: async (r) => ({
      state: n === 1 ? "complete" : "failed",
      report: report(
        r,
        n === 1 ? {} : { status: "failed", devices: [], errorCode: "IOS_INSTALL_JOB_UNAVAILABLE" },
      ),
      errorCode: n === 1 ? null : "IOS_INSTALL_JOB_UNAVAILABLE",
    }),
  });
  try {
    await s.start(randomUUID(), "devices");
    await s.start(randomUUID(), "devices");
    assert.equal(n, 1);
    await s.refresh();
    await s.start(randomUUID(), "devices");
    await s.refresh();
    assert.equal((await s.snapshot()).devices[0].id, deviceId);
  } finally {
    await s.close();
  }
});
test("successful receipt requires device identity, IPA hash and reported application versions", () => {
  const request = { id: randomUUID(), action: "install", selection, artifact };
  const good = report(request, {
    deviceId,
    artifactSha256: artifact.sha256,
    bundleId: "com.example.app",
    appVersion: "2.4.37",
    appBuild: "46",
  });
  validateIosReport(good, request);
  for (const bad of [
    { deviceId: randomUUID() },
    { artifactSha256: "f".repeat(64) },
    { appBuild: "" },
    { requestId: randomUUID() },
  ])
    assert.throws(
      () => validateIosReport({ ...good, ...bad }, request),
      /IOS_INSTALL_RESULT_MISMATCH/,
    );
});
test("Jenkins poll rejects wrong job or request, and missing final artifact stays unconfirmed", async () => {
  const request = { id: randomUUID(), action: "install", selection, artifact };
  const parameters = [
    { name: "REQUEST_ID", value: request.id },
    { name: "INSTALL_REQUEST", value: JSON.stringify(request) },
  ];
  const job = { id: request.id, queueId: 7, buildNumber: null };
  let wrong = false,
    missing = false;
  const backend = new JenkinsIosInstallBackend({
    submit: async () => 7,
    request: async (url) => {
      if (url.startsWith("/queue/item/"))
        return Response.json({
          task: { name: wrong ? "another job" : IOS_INSTALL_JOB },
          actions: [{ parameters }],
          executable: { number: 5, url: "http://10.100.5.129:8080" + IOS_JOB_PATH + "5/" },
        });
      if (url.endsWith("/artifact/result.json"))
        return missing
          ? new Response("", { status: 404 })
          : Response.json(
              report(request, {
                deviceId,
                artifactSha256: artifact.sha256,
                bundleId: "com.app",
                appVersion: "1",
                appBuild: "1",
              }),
            );
      return Response.json({ number: 5, building: false, actions: [{ parameters }] });
    },
  });
  assert.equal((await backend.poll(request, job)).state, "complete");
  missing = true;
  assert.equal((await backend.poll(request, job)).state, "unconfirmed");
  wrong = true;
  await assert.rejects(backend.poll(request, job), /IOS_INSTALL_RESULT_MISMATCH/);
});
test("HTTP requires actor, validates inputs and GET does not trigger a scan or install", async () => {
  const app = Fastify();
  let submissions = 0;
  const s = new IosInstallService({ submit: async () => ++submissions, poll: async () => ({}) });
  registerIosInstallRoutes(app, s, (r) => (r.headers["x-test-actor"] === "yes" ? "actor" : null));
  try {
    assert.equal((await app.inject({ url: "/api/v1/packaging/ios-installs" })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          url: "/api/v1/packaging/ios-installs",
          headers: { "x-test-actor": "yes" },
        })
      ).statusCode,
      200,
    );
    assert.equal(submissions, 0);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/packaging/ios-installs",
          headers: { "x-test-actor": "yes", "idempotency-key": randomUUID() },
          payload: { action: "devices", selection },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/packaging/ios-installs",
          headers: { "x-test-actor": "yes", "idempotency-key": randomUUID() },
          payload: { action: "devices" },
        })
      ).statusCode,
      202,
    );
    assert.equal(submissions, 1);
  } finally {
    await app.close();
  }
});
