import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ANDROID_UPDATE_PATH,
  API_SERVICE_NAME,
  BROWSER_LOGIN_PATH,
  LIVE_HEALTH_PATH,
  MOBILE_ATTACHMENT_BIND_PATH,
  MOBILE_API_CONTENT_TYPE,
  MOBILE_API_MEDIA_TYPE,
  MOBILE_BUG_COLLECTION_PATH,
  MOBILE_PROJECT_COLLECTION_PATH,
  MOBILE_REPAIR_ATTEMPT_DELIVER_PATH,
  MOBILE_UPLOAD_CHUNK_PATH,
  MOBILE_UPLOAD_FINALIZE_PATH,
  MOBILE_UPLOAD_INIT_PATH,
  MOBILE_VERIFICATION_COLLECTION_PATH,
  MOBILE_VERIFICATION_RESULT_PATH,
  MobileCaptureRequestError,
  QaLoginDirectory,
  canonicalizeMobileProjectMembers,
  createApiApp,
  createApiServer,
  loadQaPeopleConfig,
  normalizeQaLoginName,
  parseMobileBugListQuery,
  parseMobileCreateCaptureRequest,
  qaLoginEmail,
  qaPinyinLoginAlias,
  qaUserId,
  resolveBuildSha,
  resolveWebOrigins,
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

test("existing Chinese people are the unique canonical identity for full-pinyin login", () => {
  const directory = new QaLoginDirectory([
    { id: "10000000-0000-4000-8000-000000000101", displayName: "林步云" },
    { id: "10000000-0000-4000-8000-000000000102", displayName: "饶小春" },
    { id: "10000000-0000-4000-8000-000000000103", displayName: "raoxiaochun" },
  ]);

  assert.equal(qaPinyinLoginAlias("林步云"), "linbuyun");
  assert.deepEqual(directory.resolveLogin(" LIN BU YUN "), {
    id: "10000000-0000-4000-8000-000000000101",
    displayName: "林步云",
  });
  assert.deepEqual(
    directory.canonicalize({
      id: "10000000-0000-4000-8000-000000000103",
      displayName: "raoxiaochun",
    }),
    { id: "10000000-0000-4000-8000-000000000102", displayName: "饶小春" },
  );
  const ambiguous = new QaLoginDirectory([
    { id: "10000000-0000-4000-8000-000000000104", displayName: "王月" },
    { id: "10000000-0000-4000-8000-000000000105", displayName: "王悦" },
  ]);
  assert.equal(ambiguous.resolveLogin("wangyue"), undefined);
  assert.equal(qaPinyinLoginAlias("Windows安装包验收账号"), undefined);
});

test("project people directory merges pinyin duplicates into one Chinese member", () => {
  const projectId = "10000000-0000-4000-8000-000000000004";
  const chineseId = "10000000-0000-4000-8000-000000000101";
  const pinyinId = "10000000-0000-4000-8000-000000000102";
  const directory = new QaLoginDirectory([
    { id: chineseId, displayName: "林步云" },
    { id: pinyinId, displayName: "linbuyun" },
  ]);
  const result = canonicalizeMobileProjectMembers(
    {
      projectId,
      snapshotSequence: 9,
      items: [
        {
          userId: pinyinId,
          projectId,
          displayName: "linbuyun",
          roles: ["developer"],
          active: true,
        },
        {
          userId: chineseId,
          projectId,
          displayName: "林步云",
          roles: ["reporter", "verifier"],
          active: true,
        },
      ],
      nextCursor: null,
    },
    directory,
  );

  assert.deepEqual(result.items, [
    {
      userId: chineseId,
      projectId,
      displayName: "林步云",
      roles: ["developer", "reporter", "verifier"],
      active: true,
    },
  ]);
});

test("backend people seed accepts only schema 4 without client-side aliases", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qa-hub-people-v4-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const configFile = join(directory, "qa-people.json");
  await writeFile(
    configFile,
    JSON.stringify({
      schemaVersion: 4,
      projectKey: "LOCAL",
      people: [
        {
          id: "10000000-0000-4000-8000-000000000003",
          displayName: "罗东乐",
          roles: ["fixer", "verifier"],
          active: true,
        },
      ],
    }),
  );
  assert.equal(loadQaPeopleConfig(configFile).people[0].displayName, "罗东乐");

  await writeFile(
    configFile,
    JSON.stringify({
      schemaVersion: 4,
      projectKey: "LOCAL",
      people: [],
    }),
  );
  assert.deepEqual(loadQaPeopleConfig(configFile).people, []);

  await writeFile(
    configFile,
    JSON.stringify({
      schemaVersion: 3,
      projectKey: "LOCAL",
      people: [
        {
          id: "10000000-0000-4000-8000-000000000003",
          pinyin: "luodongle",
          displayName: "罗东乐",
          roles: ["fixer", "verifier"],
          active: true,
        },
      ],
    }),
  );
  assert.throws(() => loadQaPeopleConfig(configFile), /schemaVersion is unsupported/u);
});

test("checked-in backend people seed contains the default QA team", () => {
  const people = loadQaPeopleConfig().people;
  const expectedPeople = [
    ["饶小春", "85a49b10-c467-4800-8dd8-e33818544904"],
    ["王永永", "eac8012e-2108-4b1c-801e-7bce354f6af7"],
    ["吴鹏生", "90f58d33-e690-4ae7-8674-93aea1e2cf92"],
    ["王月", "fb0e471b-d111-4d4c-88d3-9a011c6741b6"],
    ["汤万鹏", "f6e9fd6a-50f0-4e02-8583-046ca8e08c86"],
    ["谭一林", "dc623a28-26bc-413c-8d52-6196bc1f3718"],
    ["何坤", "811dc02f-c582-4e87-8de7-a26e4139d515"],
    ["郑志航", "92fa07cd-21b0-4d6e-87ae-3c6cd4fb87dc"],
    ["谭雪平", "de4be22c-a154-4f1f-8352-6d4a61d811c3"],
    ["黄燕吟", "be7bcfd4-8f08-4701-868a-e07b95c93911"],
    ["王江", "a74b4e82-8390-4b79-8cff-57aa83aef78c"],
    ["彭江雨", "736d1cf4-85dc-4a20-8f4b-e54e830dc577"],
    ["肖飞侠", "67113e99-62d2-49a0-8127-dda31348fce6"],
    ["王蕊", "3807ffeb-910b-428a-8890-810be9102b7c"],
  ];

  assert.deepEqual(
    people.map((person) => [person.displayName, person.id]),
    expectedPeople,
  );
  assert.ok(people.every((person) => person.active));
  assert.ok(people.every((person) => person.roles.join(",") === "fixer,verifier"));
  assert.ok(
    people.every(
      (person) =>
        person.id === qaUserId("10000000-0000-4000-8000-000000000020", person.displayName),
    ),
  );
});

test("new Web and Android name login creates backend accounts and rejects the legacy pinyin body field", async (t) => {
  const accountId = "10000000-0000-4000-8000-000000000020";
  const userId = "30000000-0000-4000-8000-000000000021";
  const debugActorId = "10000000-0000-4000-8000-000000000003";
  const debugBearerToken = "fixed-debug-token";
  const resolvedSessions = new Map();
  const rawNames = [];
  const store = {
    async ensureBrowserAdmin() {},
    async loginBrowserSession() {
      throw new Error("legacy password login must not be used");
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
        if (name === "已停用账号") {
          throw Object.assign(new Error("mobile scope conflicts with existing tenant identity"), {
            code: "SQLITE_MOBILE_SCOPE_CONFLICT",
          });
        }
        return { userId };
      },
      sessionSecret: "a".repeat(64),
      webOrigins: ["http://127.0.0.1:4174"],
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

  const legacy = await app.inject({
    method: "POST",
    url: BROWSER_LOGIN_PATH,
    headers: { origin: "http://127.0.0.1:4174", "content-type": "application/json" },
    payload: JSON.stringify({ pinyin: "oldclient" }),
  });
  assert.equal(legacy.statusCode, 400);

  const disabled = await app.inject({
    method: "POST",
    url: BROWSER_LOGIN_PATH,
    headers: { origin: "http://127.0.0.1:4174", "content-type": "application/json" },
    payload: JSON.stringify({ name: "已停用账号", client: "web" }),
  });
  assert.equal(disabled.statusCode, 401);
  assert.deepEqual(disabled.json(), { code: "AUTHENTICATION_FAILED" });
  assert.equal(disabled.headers["set-cookie"], undefined);

  const webLogin = await app.inject({
    method: "POST",
    url: BROWSER_LOGIN_PATH,
    headers: { origin: "http://127.0.0.1:4174", "content-type": "application/json" },
    payload: JSON.stringify({ name: "  新账号  ", client: "web" }),
  });
  assert.equal(webLogin.statusCode, 200);
  assert.match(webLogin.headers["set-cookie"], /^qa_hub_browser_session=/u);

  const androidLogin = await app.inject({
    method: "POST",
    url: BROWSER_LOGIN_PATH,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ name: "  新账号  ", client: "android" }),
  });
  assert.equal(androidLogin.statusCode, 200);
  assert.deepEqual(rawNames, ["已停用账号", "  新账号  ", "  新账号  "]);
  assert.match(androidLogin.json().accessToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(androidLogin.json().expiresAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(androidLogin.headers["set-cookie"], undefined);

  const projects = await app.inject({
    method: "GET",
    url: MOBILE_PROJECT_COLLECTION_PATH,
    headers: {
      authorization: `Bearer ${androidLogin.json().accessToken}`,
      "x-qa-actor-id": userId,
    },
  });
  assert.equal(projects.statusCode, 200);
  assert.deepEqual(projects.json(), { snapshotSequence: 0, items: [], nextCursor: null });

  const actorMismatch = await app.inject({
    method: "GET",
    url: MOBILE_PROJECT_COLLECTION_PATH,
    headers: {
      authorization: `Bearer ${androidLogin.json().accessToken}`,
      "x-qa-actor-id": debugActorId,
    },
  });
  assert.equal(actorMismatch.statusCode, 403);
  assert.deepEqual(actorMismatch.json(), { code: "NATIVE_ACTOR_MISMATCH" });
});

test("Bug overview query supports unassigned ownership and a 500-row window", () => {
  const projectId = "10000000-0000-4000-8000-000000000004";

  assert.deepEqual(
    parseMobileBugListQuery({
      projectId,
      ownerState: "unassigned",
      limit: "500",
    }),
    {
      projectId,
      ownerState: "unassigned",
      limit: 500,
    },
  );
  assert.throws(
    () =>
      parseMobileBugListQuery({
        projectId,
        ownerId: "20000000-0000-4000-8000-000000000003",
        ownerState: "assigned",
      }),
    /ownerId and ownerState cannot be combined/,
  );
  assert.throws(() => parseMobileBugListQuery({ projectId, limit: "501" }), /1 through 500/);
});

test("Android 12 capture metadata is accepted while API 30 remains rejected", () => {
  const examples = JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/contracts/versions/1.1.0/examples/openapi-examples.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const request = structuredClone(examples.operations.createCaptureBundle.request);
  request.capture.deviceMetadata.androidApi = 31;
  request.capture.deviceMetadata.androidRelease = "12";
  request.capture.deviceMetadata.qaAppVersion = "0.1.1-debug";

  assert.equal(parseMobileCreateCaptureRequest(request).capture.deviceMetadata.androidApi, 31);

  request.capture.deviceMetadata.androidApi = 30;
  assert.throws(
    () => parseMobileCreateCaptureRequest(request),
    (error) =>
      error instanceof MobileCaptureRequestError && error.code === "CAPTURE_BUNDLE_INVALID",
  );
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

test("android update feed serves uncached metadata and immutable APK ranges", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qa-hub-android-updates-"));
  const apkName = "Relay-QA-Hub-Android-7-0.1.6-debug.apk";
  const apkBytes = Buffer.from("0123456789", "utf8");
  await writeFile(
    join(root, "latest.json"),
    JSON.stringify({
      schemaVersion: 1,
      versionCode: 7,
      versionName: "0.1.6-debug",
      packageName: "com.relayqahub.android.debug",
      fileName: apkName,
      size: apkBytes.length,
      sha256: createHash("sha256").update(apkBytes).digest("hex"),
    }),
  );
  await writeFile(join(root, apkName), apkBytes);
  const app = createApiApp({ logger: false, androidUpdateRoot: root });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const metadata = await app.inject({
    method: "GET",
    url: ANDROID_UPDATE_PATH.replace(":fileName", "latest.json"),
  });
  assert.equal(metadata.statusCode, 200);
  assert.equal(metadata.headers["cache-control"], "no-store");
  assert.equal(metadata.json().versionCode, 7);

  const range = await app.inject({
    method: "GET",
    url: ANDROID_UPDATE_PATH.replace(":fileName", apkName),
    headers: { range: "bytes=4-7" },
  });
  assert.equal(range.statusCode, 206);
  assert.equal(range.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(range.headers["content-range"], "bytes 4-7/10");
  assert.equal(range.body, "4567");

  const rejected = await app.inject({
    method: "GET",
    url: ANDROID_UPDATE_PATH.replace(":fileName", "other.apk"),
  });
  assert.equal(rejected.statusCode, 404);
});

test("human workflow routes preserve no-code and failed Verification contracts", async (t) => {
  const token = "human-workflow-route-token";
  const actorId = "10000000-0000-4000-8000-000000000031";
  const fallbackActorId = "10000000-0000-4000-8000-000000000030";
  const bugId = "10000000-0000-4000-8000-000000000032";
  const attemptId = "10000000-0000-4000-8000-000000000033";
  const verificationId = "10000000-0000-4000-8000-000000000034";
  const verifierId = "10000000-0000-4000-8000-000000000035";
  const clientSubmissionId = "10000000-0000-4000-8000-000000000036";
  const calls = [];
  const app = createApiApp({
    logger: false,
    debugBearerToken: token,
    debugActorId: fallbackActorId,
    mobileRelayStore: {
      async deliverManualAttempt(command) {
        calls.push(["deliver", command]);
        return { id: attemptId, deliveryKind: command.request.deliveryKind };
      },
    },
    mobileVerificationStore: {
      async createVerification(command) {
        calls.push(["create-verification", command]);
        return { id: verificationId, buildId: command.request.buildId };
      },
      async recordResult(command) {
        calls.push(["result", command]);
        return { verificationId, status: command.request.status };
      },
    },
  });
  t.after(async () => app.close());
  const commonHeaders = {
    authorization: `Bearer ${token}`,
    "content-type": MOBILE_API_MEDIA_TYPE,
    "x-qa-actor-id": actorId,
  };

  const missingBearer = await app.inject({
    method: "GET",
    url: LIVE_HEALTH_PATH,
    headers: { "x-qa-actor-id": actorId },
  });
  assert.equal(missingBearer.statusCode, 401);
  const invalidActor = await app.inject({
    method: "GET",
    url: LIVE_HEALTH_PATH,
    headers: { authorization: `Bearer ${token}`, "x-qa-actor-id": "not-a-uuid" },
  });
  assert.equal(invalidActor.statusCode, 400);

  const delivered = await app.inject({
    method: "POST",
    url: MOBILE_REPAIR_ATTEMPT_DELIVER_PATH.replace(":attemptId", attemptId),
    headers: {
      ...commonHeaders,
      "idempotency-key": `workflow:deliverRepairAttempt:attempt:${attemptId}:v2`,
    },
    payload: JSON.stringify({
      expectedVersion: 2,
      summary: "Configuration corrected",
      deliveryKind: "no_code",
      noCodeReason: "No source change was required",
    }),
  });
  assert.equal(delivered.statusCode, 200);
  assert.deepEqual(calls[0], [
    "deliver",
    {
      actorId,
      attemptId,
      idempotencyKey: `workflow:deliverRepairAttempt:attempt:${attemptId}:v2`,
      request: {
        expectedVersion: 2,
        summary: "Configuration corrected",
        deliveryKind: "no_code",
        noCodeReason: "No source change was required",
      },
    },
  ]);

  const created = await app.inject({
    method: "POST",
    url: MOBILE_VERIFICATION_COLLECTION_PATH.replace(":bugId", bugId),
    headers: {
      ...commonHeaders,
      "idempotency-key": `workflow:createVerification:bug:${bugId}:attempt:${attemptId}:v4`,
    },
    payload: JSON.stringify({
      expectedVersion: 4,
      repairAttemptId: attemptId,
      buildId: null,
      verifierId,
      criteria: "Reporter acceptance check",
    }),
  });
  assert.equal(created.statusCode, 201);
  assert.equal(calls[1][1].request.buildId, null);
  assert.equal(calls[1][1].request.verifierId, verifierId);

  const failed = await app.inject({
    method: "POST",
    url: MOBILE_VERIFICATION_RESULT_PATH.replace(":verificationId", verificationId),
    headers: {
      ...commonHeaders,
      "idempotency-key": `workflow:recordVerificationResult:verification:${verificationId}:v2`,
    },
    payload: JSON.stringify({
      submissionContractVersion: "1.1.0",
      clientSubmissionId,
      expectedVersion: 2,
      status: "failed",
      resultSummary: "Issue remains reproducible",
      failureReason: "Acceptance behavior still differs",
      attachmentIds: [],
      captureBundleId: null,
    }),
  });
  assert.equal(failed.statusCode, 200);
  assert.equal(calls[2][1].actorId, actorId);
  assert.deepEqual(calls[2][1].request, {
    submissionContractVersion: "1.1.0",
    clientSubmissionId,
    expectedVersion: 2,
    status: "failed",
    resultSummary: "Issue remains reproducible",
    failureReason: "Acceptance behavior still differs",
    attachmentIds: [],
    captureBundleId: null,
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
    async deleteBug(command) {
      assert.equal(command.actorId, actorId);
      assert.equal(command.bugId, bugId);
      assert.equal(command.expectedVersion, 1);
      assert.equal(command.idempotencyKey, `web:deleteBug:bug:${bugId}:v1`);
      persisted.delete(command.bugId);
      return { bugId: command.bugId, deletedAt: fixedTime.toISOString(), replayed: false };
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

  const deleted = await app.inject({
    method: "DELETE",
    url: `${MOBILE_BUG_COLLECTION_PATH}/${bugId}?expectedVersion=1`,
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": `web:deleteBug:bug:${bugId}:v1`,
    },
  });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().bugId, bugId);
  const deletedRead = await app.inject({
    method: "GET",
    url: `${MOBILE_BUG_COLLECTION_PATH}/${bugId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(deletedRead.statusCode, 404);
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

test("normalizes an explicit set of exact browser origins", () => {
  assert.deepEqual(resolveWebOrigins(undefined, undefined), ["http://127.0.0.1:4174"]);
  assert.deepEqual(
    resolveWebOrigins(
      "http://127.0.0.1:4174, http://10.100.5.157:4174/,http://10.100.5.157:4174",
      undefined,
    ),
    ["http://127.0.0.1:4174", "http://10.100.5.157:4174"],
  );
  assert.throws(
    () => resolveWebOrigins("http://10.100.5.157:4174/path", undefined),
    /without paths/u,
  );
  assert.throws(
    () => resolveWebOrigins("http://10.100.5.157:4174", "http://127.0.0.1:4174"),
    /not both/u,
  );
});
