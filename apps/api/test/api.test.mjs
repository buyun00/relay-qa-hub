import assert from "node:assert/strict";
import test from "node:test";

import {
  API_SERVICE_NAME,
  LIVE_HEALTH_PATH,
  MOBILE_API_CONTENT_TYPE,
  MOBILE_API_MEDIA_TYPE,
  MOBILE_BUG_COLLECTION_PATH,
  createApiApp,
  createApiServer,
  resolveBuildSha,
} from "../dist/index.js";

const fixedTime = new Date("2026-08-24T08:00:00.000Z");
const buildSha = "a".repeat(40);

test("GET /api/v1/health/live returns the frozen liveness shape", async (t) => {
  const app = createApiApp({
    logger: false,
    version: "0.1.0-test",
    buildSha,
    now: () => fixedTime,
  });
  t.after(async () => app.close());

  const response = await app.inject({ method: "GET", url: LIVE_HEALTH_PATH });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    service: API_SERVICE_NAME,
    version: "0.1.0-test",
    buildSha,
    time: fixedTime.toISOString(),
  });
});

test("Android createBug persists an exact receipt, supports GET, and rejects a wrong token", async (t) => {
  const token = "fixed-api-smoke-token";
  const actorId = "10000000-0000-4000-8000-000000000003";
  const projectId = "10000000-0000-4000-8000-000000000004";
  const clientSubmissionId = "20000000-0000-4000-8000-000000000001";
  const bugId = "70000000-0000-4000-8000-000000000001";
  const occurrenceId = "70000000-0000-4000-8000-000000000002";
  const eventId = "70000000-0000-4000-8000-000000000003";
  const persisted = new Map();
  const store = {
    async createBug(command) {
      assert.equal(command.actorId, actorId);
      assert.equal(command.idempotencyKey, `submission:${clientSubmissionId}:commit`);
      const bug = {
        id: bugId,
        projectId,
        number: 1,
        key: "QA-1",
        title: command.request.title,
        description: command.request.description,
        expectedBehavior: command.request.expectedBehavior,
        moduleId: null,
        state: "reported",
        severity: command.request.severity,
        priority: command.request.priority,
        reporterId: command.actorId,
        ownerId: null,
        verificationOwnerId: null,
        duplicateOfBugId: null,
        occurrenceCount: 1,
        reopenCount: 0,
        version: 1,
        createdAt: fixedTime.toISOString(),
        updatedAt: fixedTime.toISOString(),
        closedAt: null,
      };
      persisted.set(bug.id, bug);
      return {
        clientSubmissionId: command.request.clientSubmissionId,
        qaItem: { type: "bug", id: bug.id, key: bug.key },
        disposition: "created",
        bug,
        occurrenceId,
        attachmentIds: [...(command.request.attachmentIds ?? [])],
        captureBundleId: command.request.captureBundleId ?? null,
        eventId,
        replayed: false,
      };
    },
    async getBug(query) {
      assert.equal(query.actorId, actorId);
      return persisted.get(query.bugId) ?? null;
    },
  };
  const app = createApiApp({
    logger: false,
    mobileBugStore: store,
    debugBearerToken: token,
    debugActorId: actorId,
  });
  t.after(async () => app.close());

  const requestBody = {
    submissionContractVersion: "1.1.0",
    projectId,
    clientSubmissionId,
    title: "Native createBug reaches the API",
    description: "The Android offline queue submits a real contract-shaped request.",
    expectedBehavior: "The server persists one Bug and returns its exact receipt.",
    severity: "S2",
    priority: "P2",
    occurrence: {
      observedAt: fixedTime.toISOString(),
      platform: "android",
      appVersion: "0.1.0-debug",
      steps: ["Queue the draft", "Run constrained sync"],
      actualBehavior: "The smoke request reached Fastify.",
      environment: {
        qaAppVersion: "0.1.0-debug",
        networkType: "wifi",
        networkMetered: false,
        orientation: "portrait",
      },
    },
    attachmentIds: [],
  };
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": MOBILE_API_MEDIA_TYPE,
    "idempotency-key": `submission:${clientSubmissionId}:commit`,
  };

  const unauthorized = await app.inject({
    method: "POST",
    url: MOBILE_BUG_COLLECTION_PATH,
    headers: { ...headers, authorization: "Bearer wrong-token" },
    payload: JSON.stringify(requestBody),
  });
  assert.equal(unauthorized.statusCode, 401);

  const created = await app.inject({
    method: "POST",
    url: MOBILE_BUG_COLLECTION_PATH,
    headers,
    payload: JSON.stringify(requestBody),
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.headers["content-type"], MOBILE_API_CONTENT_TYPE);
  const receipt = created.json();
  assert.deepEqual(Object.keys(receipt).sort(), [
    "attachmentIds",
    "bug",
    "captureBundleId",
    "clientSubmissionId",
    "disposition",
    "eventId",
    "occurrenceId",
    "qaItem",
    "replayed",
  ]);
  assert.equal(receipt.clientSubmissionId, clientSubmissionId);
  assert.deepEqual(receipt.qaItem, { type: "bug", id: bugId, key: "QA-1" });
  assert.equal(receipt.bug.reporterId, actorId);

  const loaded = await app.inject({
    method: "GET",
    url: `${MOBILE_BUG_COLLECTION_PATH}/${bugId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(loaded.statusCode, 200);
  assert.equal(loaded.headers["content-type"], MOBILE_API_CONTENT_TYPE);
  assert.deepEqual(loaded.json(), receipt.bug);
});

test("server defaults to loopback and supports graceful stop plus restart", async () => {
  const first = createApiServer({ logger: false });
  const firstAddress = await first.start({ port: 0 });
  assert.match(firstAddress, /^http:\/\/127\.0\.0\.1:\d+$/u);

  const liveResponse = await fetch(`${firstAddress}${LIVE_HEALTH_PATH}`);
  assert.equal(liveResponse.status, 200);
  await first.stop();
  await first.stop();

  const second = createApiServer({ logger: false });
  const secondAddress = await second.start({ port: 0 });
  assert.match(secondAddress, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.equal((await fetch(`${secondAddress}${LIVE_HEALTH_PATH}`)).status, 200);
  await second.stop();
});

test("rejects ambiguous build provenance", () => {
  assert.equal(resolveBuildSha(undefined), "dev");
  assert.throws(() => resolveBuildSha("ABC123"), /40-character lowercase Git SHA/u);
});
