import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  API_SERVICE_NAME,
  BROWSER_LOGIN_PATH,
  DESKTOP_UPDATE_PATH,
  LIVE_HEALTH_PATH,
  MOBILE_ATTACHMENT_BIND_PATH,
  MOBILE_API_CONTENT_TYPE,
  MOBILE_API_MEDIA_TYPE,
  MOBILE_BUG_COLLECTION_PATH,
  MOBILE_PROJECT_COLLECTION_PATH,
  MOBILE_UPLOAD_CHUNK_PATH,
  MOBILE_UPLOAD_FINALIZE_PATH,
  MOBILE_UPLOAD_INIT_PATH,
  createApiApp,
  createApiServer,
  normalizeQaLoginName,
  qaLoginEmail,
  qaUserId,
  resolveBuildSha,
} from "../dist/index.js";

const fixedTime = new Date("2026-08-24T08:00:00.000Z");
const buildSha = "a".repeat(40);

test("backend account-name normalization is stable and preserves the display spelling", () => {
  const accountId = "10000000-0000-4000-8000-000000000020";
  assert.deepEqual(normalizeQaLoginName("  NewUser  "), {
    displayName: "NewUser",
    key: "newuser",
  });
  assert.equal(qaUserId(accountId, "NewUser"), qaUserId(accountId, " newuser "));
  assert.equal(qaLoginEmail(accountId, "NewUser"), qaLoginEmail(accountId, " newuser "));
  assert.throws(() => normalizeQaLoginName("   "), /name is invalid/u);
});

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

test("desktop update feed serves uncached metadata and bounded installer ranges", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qa-hub-desktop-updates-"));
  const installerName = "Relay-QA-Hub-Setup-1.0.0-x64.exe";
  await writeFile(
    join(root, "latest.yml"),
    `version: 1.0.0\nfiles:\n  - url: ${installerName}\n    sha512: test\n    size: 10\n`,
  );
  await writeFile(join(root, installerName), Buffer.from("0123456789", "utf8"));
  const app = createApiApp({ logger: false, desktopUpdateRoot: root });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const metadata = await app.inject({
    method: "GET",
    url: DESKTOP_UPDATE_PATH.replace(":fileName", "latest.yml"),
  });
  assert.equal(metadata.statusCode, 200);
  assert.equal(metadata.headers["cache-control"], "no-store");
  assert.match(metadata.body, /^version: 1\.0\.0$/mu);

  const range = await app.inject({
    method: "GET",
    url: DESKTOP_UPDATE_PATH.replace(":fileName", installerName),
    headers: { range: "bytes=2-5" },
  });
  assert.equal(range.statusCode, 206);
  assert.equal(range.headers["content-range"], "bytes 2-5/10");
  assert.equal(range.body, "2345");

  const rejected = await app.inject({
    method: "GET",
    url: DESKTOP_UPDATE_PATH.replace(":fileName", "untrusted.exe"),
  });
  assert.equal(rejected.statusCode, 404);
});

test("unknown names are created by the backend login boundary and native sessions keep that actor", async (t) => {
  const accountId = "10000000-0000-4000-8000-000000000020";
  const userId = "30000000-0000-4000-8000-000000000021";
  const debugActorId = "10000000-0000-4000-8000-000000000003";
  const debugBearerToken = "fixed-debug-token";
  const resolvedSessions = new Map();
  const rawNames = [];
  const store = {
    async ensureBrowserAdmin() {},
    async loginBrowserSession() {
      return null;
    },
    async createBrowserSession(input) {
      const principal = {
        accountId,
        userId: input.userId,
        actorId: input.userId,
        email: "qa-created@local.invalid",
        displayName: "新账号",
      };
      resolvedSessions.set(input.tokenDigest, principal);
      return principal;
    },
    async resolveBrowserSession(input) {
      return resolvedSessions.get(input.tokenDigest) ?? null;
    },
    async revokeBrowserSession() {
      return true;
    },
  };
  const app = createApiApp({
    logger: false,
    debugActorId,
    debugBearerToken,
    browserAuth: {
      store,
      accountId,
      userId: debugActorId,
      actorId: debugActorId,
      adminEmail: "admin@local.invalid",
      passwordlessLogin: async (name) => {
        rawNames.push(name);
        return { userId };
      },
      sessionSecret: "a".repeat(64),
      webOrigin: "http://127.0.0.1:4174",
      secureCookie: false,
    },
    mobileProjectDirectoryStore: {
      async listProjects(query) {
        assert.equal(query.actorId, userId);
        return { snapshotSequence: 0, items: [], nextCursor: null };
      },
      async listMembers() {
        throw new Error("not used");
      },
      async listModules() {
        throw new Error("not used");
      },
    },
  });
  t.after(async () => app.close());

  const login = await app.inject({
    method: "POST",
    url: BROWSER_LOGIN_PATH,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ name: "  新账号  ", client: "android" }),
  });
  assert.equal(login.statusCode, 200);
  assert.deepEqual(rawNames, ["  新账号  "]);
  assert.equal(login.json().userId, userId);
  assert.equal(login.json().displayName, "新账号");
  assert.match(login.json().accessToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(login.headers["set-cookie"], undefined);

  const projects = await app.inject({
    method: "GET",
    url: MOBILE_PROJECT_COLLECTION_PATH,
    headers: { authorization: `Bearer ${login.json().accessToken}` },
  });
  assert.equal(projects.statusCode, 200);
  assert.deepEqual(projects.json(), { snapshotSequence: 0, items: [], nextCursor: null });
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

test("Android attachment upload follows the frozen init, chunk, finalize, bind wire", async (t) => {
  const token = "fixed-attachment-smoke-token";
  const actorId = "10000000-0000-4000-8000-000000000003";
  const projectId = "10000000-0000-4000-8000-000000000004";
  const clientSubmissionId = "20000000-0000-4000-8000-000000000001";
  const clientAttachmentId = "30000000-0000-4000-8000-000000000001";
  const sessionId = "40000000-0000-4000-8000-000000000001";
  const attachmentId = "50000000-0000-4000-8000-000000000001";
  const bindingId = "50000000-0000-4000-8000-000000000002";
  const bytes = Buffer.from("real mobile attachment bytes", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const initKey = `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:upload:1:init`;
  const chunkKey = `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:upload:1:chunk:0`;
  const finalizeKey = `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:upload:1:finalize`;
  const bindKey = `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:bind:1`;
  const store = {
    async initUpload(command) {
      assert.equal(command.actorId, actorId);
      assert.equal(command.idempotencyKey, initKey);
      assert.equal(command.request.sha256, sha256);
      return {
        sessionId,
        projectId,
        clientSubmissionId,
        clientAttachmentId,
        uploadAttempt: 1,
        status: "open",
        filename: "screen.png",
        mediaType: "image/png",
        captureId: null,
        expectedSize: bytes.length,
        chunkSize: 1_048_576,
        sha256,
        expectedChunkCount: 1,
        receivedBytes: 0,
        attachmentId: null,
        expiresAt: "2026-08-25T12:00:00.000Z",
        confirmedChunks: [],
        version: 1,
        replayed: false,
      };
    },
    async putChunk(command) {
      assert.equal(command.idempotencyKey, chunkKey);
      assert.equal(command.sessionId, sessionId);
      assert.equal(command.chunkNumber, 0);
      assert.equal(command.expectedVersion, 1);
      assert.equal(command.chunkSha256, sha256);
      assert.deepEqual(command.bytes, bytes);
      return { version: 2 };
    },
    async finalizeUpload(command) {
      assert.equal(command.idempotencyKey, finalizeKey);
      assert.equal(command.sessionId, sessionId);
      assert.equal(command.request.expectedVersion, 2);
      return {
        sessionId,
        projectId,
        clientSubmissionId,
        uploadAttempt: 1,
        attachmentId,
        clientAttachmentId,
        filename: "screen.png",
        mediaType: "image/png",
        captureId: null,
        sha256,
        size: bytes.length,
        scanStatus: "clean",
        readyToBind: true,
        bindingStatus: "unbound",
        version: 3,
        replayed: false,
      };
    },
    async bindAttachment(command) {
      assert.equal(command.idempotencyKey, bindKey);
      assert.equal(command.attachmentId, attachmentId);
      assert.equal(command.request.expectedVersion, 3);
      assert.equal(command.request.intent, "bug_create");
      assert.equal(command.request.targetQaItemId, undefined);
      return {
        bindingId,
        attachmentId,
        projectId,
        clientSubmissionId,
        clientAttachmentId,
        leaseGeneration: 1,
        intent: "bug_create",
        targetQaItemId: null,
        status: "reserved",
        expiresAt: "2026-08-25T10:00:00.000Z",
        version: 4,
        replayed: false,
      };
    },
  };
  const app = createApiApp({
    logger: false,
    mobileAttachmentStore: store,
    debugBearerToken: token,
    debugActorId: actorId,
  });
  t.after(async () => app.close());
  const authHeaders = { authorization: `Bearer ${token}` };

  const initialized = await app.inject({
    method: "POST",
    url: MOBILE_UPLOAD_INIT_PATH,
    headers: {
      ...authHeaders,
      "content-type": MOBILE_API_MEDIA_TYPE,
      "idempotency-key": initKey,
    },
    payload: JSON.stringify({
      submissionContractVersion: "1.1.0",
      projectId,
      clientSubmissionId,
      clientAttachmentId,
      uploadAttempt: 1,
      filename: "screen.png",
      mediaType: "image/png",
      expectedSize: bytes.length,
      sha256,
    }),
  });
  assert.equal(initialized.statusCode, 201);
  assert.equal(initialized.headers["content-type"], MOBILE_API_CONTENT_TYPE);
  assert.equal(initialized.json().version, 1);

  const chunked = await app.inject({
    method: "PUT",
    url: MOBILE_UPLOAD_CHUNK_PATH.replace(":sessionId", sessionId).replace(":chunkNumber", "0"),
    headers: {
      ...authHeaders,
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      "idempotency-key": chunkKey,
      "if-match": '"1"',
      "x-chunk-sha256": sha256,
      "x-client-submission-id": clientSubmissionId,
      "x-client-attachment-id": clientAttachmentId,
    },
    payload: bytes,
  });
  assert.equal(chunked.statusCode, 204);
  assert.equal(chunked.body, "");
  assert.equal(chunked.headers.etag, '"2"');
  assert.equal(chunked.headers["x-upload-version"], "2");

  const finalized = await app.inject({
    method: "POST",
    url: MOBILE_UPLOAD_FINALIZE_PATH.replace(":sessionId", sessionId),
    headers: {
      ...authHeaders,
      "content-type": MOBILE_API_MEDIA_TYPE,
      "idempotency-key": finalizeKey,
    },
    payload: JSON.stringify({
      submissionContractVersion: "1.1.0",
      expectedVersion: 2,
      clientSubmissionId,
      clientAttachmentId,
      uploadAttempt: 1,
      sha256,
      expectedSize: bytes.length,
    }),
  });
  assert.equal(finalized.statusCode, 200);
  assert.deepEqual(
    {
      version: finalized.json().version,
      scanStatus: finalized.json().scanStatus,
      readyToBind: finalized.json().readyToBind,
      bindingStatus: finalized.json().bindingStatus,
    },
    { version: 3, scanStatus: "clean", readyToBind: true, bindingStatus: "unbound" },
  );

  const bound = await app.inject({
    method: "POST",
    url: MOBILE_ATTACHMENT_BIND_PATH.replace(":attachmentId", attachmentId),
    headers: {
      ...authHeaders,
      "content-type": MOBILE_API_MEDIA_TYPE,
      "idempotency-key": bindKey,
    },
    payload: JSON.stringify({
      submissionContractVersion: "1.1.0",
      expectedVersion: 3,
      projectId,
      clientSubmissionId,
      clientAttachmentId,
      leaseGeneration: 1,
      intent: "bug_create",
    }),
  });
  assert.equal(bound.statusCode, 200);
  assert.deepEqual(bound.json(), {
    bindingId,
    attachmentId,
    projectId,
    clientSubmissionId,
    clientAttachmentId,
    leaseGeneration: 1,
    intent: "bug_create",
    targetQaItemId: null,
    status: "reserved",
    expiresAt: "2026-08-25T10:00:00.000Z",
    version: 4,
    replayed: false,
  });
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
