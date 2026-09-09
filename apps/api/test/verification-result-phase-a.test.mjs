import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { SqliteStorageWorker, projectMembershipId } from "@relay-qa-hub/storage";
import { createApiApp } from "../dist/app.js";
import { createSqliteBrowserAuthStore } from "../dist/browser-auth.js";
import { ProjectManagementService } from "../dist/project-management.js";
import { ProjectRequestContext } from "../dist/project-request-context.js";
import { createSqliteMobileBugStore } from "../dist/sqlite-mobile-bug-store.js";
import { createSqliteMobileRelayStore } from "../dist/sqlite-mobile-relay-store.js";
import { createSqliteMobileVerificationStore } from "../dist/sqlite-mobile-verification-store.js";
import { createSqliteMobileHumanWorkflowStore } from "../dist/sqlite-mobile-human-workflow-store.js";

import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";
import { parseMobileRecordVerificationResultRequest } from "../dist/mobile-verification.js";

import { workflowReceipt } from "../../../packages/storage/dist/workflow-idempotency.js";

const origin = "http://phase-a.fixture.invalid";
const vendor = "application/vnd.relay-qa-hub.v1.1+json";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "qa-result-phase-a-"));
  const databaseFile = join(directory, "fixture.sqlite");
  const worker = new SqliteStorageWorker({
    databaseFile,
    backupRoot: join(directory, "backups"),
    busyTimeoutMs: 1000,
  });
  const accountId = randomUUID(),
    gmId = randomUUID(),
    projectId = randomUUID(),
    otherProject = randomUUID();
  const bootstrap = {
    accountId,
    actorId: gmId,
    projectId,
    projectKey: "WIRE",
    actorDisplayName: "Fixture GM",
    membershipId: projectMembershipId(projectId, gmId),
    createdAt: new Date().toISOString(),
  };
  await worker.ensureMobileScope(bootstrap);
  await worker.projectManagement({
    accountId,
    actorId: gmId,
    isGm: true,
    operation: "create",
    projectId: otherProject,
    key: "OTHER",
    name: "Other fixture project",
    now: new Date().toISOString(),
  });
  const management = new ProjectManagementService({ accountId, gmUserId: gmId, worker });
  const context = new ProjectRequestContext();
  const scope = context.scope(bootstrap);
  const app = createApiApp({
    logger: false,
    isolateLegacyComponents: true,
    projectManagementService: management,
    projectRequestContext: context,
    mobileBugStore: createSqliteMobileBugStore({ worker, scope }),
    mobileRelayStore: createSqliteMobileRelayStore({ worker, scope, relayDispatchEnabled: false }),
    mobileVerificationStore: createSqliteMobileVerificationStore({ worker, scope }),
    mobileHumanWorkflowStore: createSqliteMobileHumanWorkflowStore({ worker, scope }),
    browserAuth: {
      store: createSqliteBrowserAuthStore({ worker }),
      accountId,
      userId: gmId,
      actorId: gmId,
      adminEmail: "fixture@example.invalid",
      passwordlessLogin: async () => {
        throw new Error("Unscoped login refused");
      },
      projectLogin: (name, selected, at) => management.login(name, selected, at),
      sessionSecret: "isolated-frozen-wire-fixture",
      cookieName: "qa_frozen_fixture",
      webOrigins: [origin],
      secureCookie: false,
      gm: { userId: gmId, password: "fixture-gm-password" },
    },
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  let requestCount = 0;
  t.after(async () => {
    await app.close();
    await worker.close();
    await writeFile(
      join(directory, "retained.json"),
      JSON.stringify({ databaseFile, requestCount, port: new URL(baseUrl).port }),
    );
    t.diagnostic(`retained fixture ${directory}; ${requestCount} real HTTP requests`);
  });
  async function request(
    path,
    {
      body,
      token,
      cookie,
      csrf,
      contentType = vendor,
      project = projectId,
      accept = vendor,
      key,
      method = body ? "POST" : "GET",
      expected = 200,
    } = {},
  ) {
    requestCount++;
    const response = await fetch(`${baseUrl}/api/v1/${path}`, {
      method,
      headers: {
        ...(accept ? { accept } : {}),
        origin,
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "x-qa-project-id": project,
        ...(body ? { "content-type": contentType } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: code=${value.code ?? "response"}`);
    if (path === "auth/login")
      return { ...value, cookie: response.headers.get("set-cookie")?.split(";")[0] };
    return value;
  }
  const employee = await request("auth/login", {
    body: { projectId, name: "History employee", client: "android" },
  });
  const other = await request("auth/login", {
    body: { projectId: otherProject, name: "Other employee", client: "android" },
  });
  const token = employee.accessToken,
    actorId = employee.userId;
  const call = (path, options = {}) => request(path, { token, ...options });
  async function bug(title = "Frozen response regression") {
    const clientSubmissionId = randomUUID();
    const result = await call("bugs", {
      body: {
        submissionContractVersion: "1.1.0",
        clientSubmissionId,
        projectId,
        title,
        description: "Isolated SQLite response fixture",
        expectedBehavior: "Preserve all stored facts",
        severity: "S2",
        priority: "P2",
        attachmentIds: [],
        ownerId: actorId,
        verificationOwnerId: actorId,
        occurrence: {
          observedAt: new Date().toISOString(),
          platform: "web",
          steps: ["Inspect"],
          actualBehavior: "Pending",
        },
      },
      key: `submission:${clientSubmissionId}:commit`,
      expected: 201,
    });
    return result.bug;
  }
  return {
    worker,
    directory,
    employee,
    databaseFile,
    accountId,
    projectId,
    otherProject,
    gmId,
    actorId,
    other,
    call,
    request,
    bug,
  };
}

async function round(f, { criteria = "Check configuration", parent = false } = {}) {
  let bug = await f.bug();
  bug = await f.call(`bugs/${bug.id}/transitions`, {
    body: { expectedVersion: bug.version, toState: "ready" },
    key: `workflow:transitionBug:bug:${bug.id}:v${bug.version}:ready`,
  });
  let attempt = await f.call(`bugs/${bug.id}/repair-attempts`, {
    body: {
      expectedVersion: bug.version,
      mode: "human",
      assigneeId: f.actorId,
      summary: "Phase A human fixture",
    },
    key: `workflow:createRepairAttempt:bug:${bug.id}:v${bug.version}`,
    expected: 201,
  });
  const parentId = parent ? attempt.id : null;
  if (parent) {
    const current = await f.call(`bugs/${bug.id}`);
    await f.call(`bugs/${bug.id}/manual-complete`, {
      body: { expectedVersion: current.version, reason: "Take over the earlier human attempt" },
      key: `workflow:manualCompleteBug:bug:${bug.id}:v${current.version}`,
    });
    attempt = (await f.call(`bugs/${bug.id}/human-workflow`)).repairAttempt;
  } else {
    attempt = await f.call(`repair-attempts/${attempt.id}/start`, {
      body: { expectedVersion: attempt.version },
      key: `workflow:startRepairAttempt:attempt:${attempt.id}:v${attempt.version}`,
    });
    attempt = await f.call(`repair-attempts/${attempt.id}/deliver`, {
      body: {
        expectedVersion: attempt.version,
        deliveryKind: "no_code",
        noCodeReason: "Manual configuration verified",
        summary: "Delivered",
      },
      key: `workflow:deliverRepairAttempt:attempt:${attempt.id}:v${attempt.version}`,
    });
  }
  bug = await f.call(`bugs/${bug.id}`);
  let verification = await f.call(`bugs/${bug.id}/verifications`, {
    body: {
      expectedVersion: bug.version,
      repairAttemptId: attempt.id,
      buildId: null,
      verifierId: f.actorId,
      criteria,
    },
    key: `workflow:createVerification:bug:${bug.id}:attempt:${attempt.id}:v${bug.version}`,
    expected: 201,
  });
  verification = await f.call(`verifications/${verification.id}/start`, {
    body: { expectedVersion: verification.version },
    key: `workflow:startVerification:verification:${verification.id}:v${verification.version}`,
  });
  return {
    bug,
    attempt,
    verification,
    parentId,
    path: `verifications/${verification.id}/result`,
    key: `workflow:recordVerificationResult:verification:${verification.id}:v${verification.version}`,
  };
}
function bodyFor(r, status, legacy = false) {
  return {
    ...(legacy ? {} : { submissionContractVersion: "1.1.0", clientSubmissionId: randomUUID() }),
    expectedVersion: r.verification.version,
    resultSummary: "Original immutable result",
    ...(legacy ? {} : { attachmentIds: [] }),
    status,
    ...(status === "failed" ? { failureReason: "Configuration still fails" } : {}),
  };
}
function snapshot(f) {
  const db = new DatabaseSync(f.databaseFile, { readOnly: true });
  try {
    return Object.fromEntries(
      [
        "bugs",
        "repair_attempts",
        "verifications",
        "events",
        "submissions",
        "idempotency_records",
        "outbox",
        "bug_deletions",
        "verification_result_snapshots",
      ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    );
  } finally {
    db.close();
  }
}
for (const legacy of [false, true])
  for (const status of ["passed", "failed"]) {
    test(`real HTTP ${legacy ? "legacy" : "vendor"} ${status} preserves the exact original receipt after later Bug edits`, async (t) => {
      const f = await fixture(t),
        r = await round(f),
        body = bodyFor(r, status, legacy);
      const key = legacy ? (status === "passed" ? "k" : "k".repeat(200)) : r.key;
      const options = {
        body,
        key,
        contentType: "application/json",
        accept: legacy ? null : vendor,
      };
      const before = snapshot(f);
      const first = await f.call(r.path, options);
      assert.equal(first.verification.status, status);
      assert.equal(first.verification.version, r.verification.version + 1);
      assert.equal(first.bug.version, r.bug.version + 2); // create Verification advances Bug once too
      assert.equal(first.bug.state, status === "passed" ? "closed" : "ready");
      if (legacy) assert.deepEqual(Object.keys(first).sort(), ["bug", "verification"]);
      else {
        assert.equal(first.clientSubmissionId, body.clientSubmissionId);
        assert.equal(first.replayed, false);
      }
      const committed = snapshot(f);
      assert.equal(committed.events.length, before.events.length + 1);
      assert.equal(committed.outbox.length, before.outbox.length + 1);
      assert.equal(committed.idempotency_records.length, before.idempotency_records.length + 1);
      assert.equal(committed.submissions.length, before.submissions.length + (legacy ? 0 : 1));

      assert.equal(
        JSON.parse(committed.verification_result_snapshots.at(-1).response_json).clientSubmissionId,
        legacy ? null : body.clientSubmissionId,
      );
      const replay = await f.call(r.path, options);
      assert.deepEqual(replay, legacy ? first : { ...first, replayed: true });
      assert.deepEqual(snapshot(f), committed);
      const edited = await f.call(`bugs/${r.bug.id}`, {
        method: "PATCH",
        body: { expectedVersion: first.bug.version, title: "Later title must not replace receipt" },
        key: `web:updateBug:bug:${r.bug.id}:v${first.bug.version}`,
      });
      assert.equal(edited.title, "Later title must not replace receipt");
      const afterEdit = snapshot(f);
      assert.deepEqual(
        await f.call(r.path, options),
        legacy ? first : { ...first, replayed: true },
      );
      assert.deepEqual(snapshot(f), afterEdit);
      assert.equal(
        (
          await f.call(r.path, {
            ...options,
            body: { ...body, resultSummary: "Different content" },
            expected: 409,
          })
        ).code,
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
      );
      assert.deepEqual(snapshot(f), afterEdit);
      if (!legacy) {
        const json = await f.call(r.path, { ...options, accept: "application/json" });
        assert.deepEqual(Object.keys(json).sort(), ["bug", "verification"]);
        assert.equal(json.bug.title, first.bug.title);
        assert.deepEqual(json.verification, first.verification);
      }
      const final = snapshot(f);
      const ownEvent = final.events.filter(
        (e) =>
          e.event_type === "verification.result_recorded" ||
          e.type === "verification.result_recorded",
      );
      assert.equal(ownEvent.length, 1);
      assert.equal(ownEvent[0].actor_user_id, f.actorId);
    });
  }

test("legacy Accept q-values and malformed bodies reject before any domain write", async (t) => {
  const f = await fixture(t),
    r = await round(f),
    body = bodyFor(r, "passed", true),
    before = snapshot(f);
  for (const accept of [
    vendor,
    `${vendor};q=1, application/json;q=0`,
    "application/json;q=0, */*;q=1",
    "text/plain",
    "*/*;q=0",
  ]) {
    const response = await f.call(r.path, {
      body,
      key: "accept-test",
      contentType: "application/json",
      accept,
      expected: 406,
    });
    assert.equal(response.code, "NOT_ACCEPTABLE");
    assert.deepEqual(snapshot(f), before);
  }
  for (const options of [
    { body, key: "k".repeat(201), contentType: "application/json" },
    { body, key: "k", contentType: vendor },
    {
      body: { ...body, status: "blocked" },
      key: "k",
      contentType: "application/json",
    },
    { body: { ...body, attachmentIds: [] }, key: "k", contentType: "application/json" },
  ]) {
    await f.call(r.path, { ...options, accept: "application/json", expected: 400 });
    assert.deepEqual(snapshot(f), before);
  }
  assert.equal(
    (await f.call(r.path, { body, key: "media-test", contentType: "text/plain", expected: 415 }))
      .code,
    "UNSUPPORTED_MEDIA_TYPE",
  );
  assert.deepEqual(snapshot(f), before);
  const first = await f.call(r.path, {
    body,
    key: "accept-test",
    contentType: "application/json",
    accept: `${vendor};q=1, application/json;q=0.1`,
  });
  for (const accept of [null, "*/*", "application/*", "application/json;q=0.1,*/*;q=0"])
    assert.deepEqual(
      await f.call(r.path, { body, key: "accept-test", contentType: "application/json", accept }),
      first,
    );
});

test("Cookie CSRF, assigned verifier, target version and cross-project guards precede writes", async (t) => {
  const f = await fixture(t),
    r = await round(f),
    body = bodyFor(r, "failed", true);
  const browser = await f.request("auth/login", {
    body: { projectId: f.projectId, name: "History employee", client: "web" },
  });
  const peer = await f.request("auth/login", {
    body: { projectId: f.projectId, name: "Another active employee", client: "android" },
  });
  const options = {
    body,
    key: "cookie-result",
    contentType: "application/json",
    accept: "application/json",
    token: undefined,
    cookie: browser.cookie,
  };
  const before = snapshot(f);
  await f.call(r.path, { ...options, expected: 403 });
  await f.call(r.path, { ...options, csrf: "wrong", expected: 403 });
  await f.call(r.path, { ...options, cookie: undefined, token: peer.accessToken, expected: 403 });
  await f.call(r.path, {
    ...options,
    cookie: undefined,
    token: f.other.accessToken,
    expected: 403,
  });
  await f.call(r.path, {
    ...options,
    token: f.employee.accessToken,
    cookie: undefined,
    project: f.otherProject,
    expected: 404,
  });
  await f.call(r.path, {
    ...options,
    csrf: browser.csrfToken,
    body: { ...body, expectedVersion: 1 },
    expected: 412,
  });
  assert.deepEqual(snapshot(f), before);
  const first = await f.call(r.path, { ...options, csrf: browser.csrfToken });
  assert.equal(first.bug.state, "ready");
  assert.deepEqual(
    await f.call(r.path, { ...options, cookie: undefined, token: f.employee.accessToken }),
    first,
  );
  await f.call(r.path, { ...options, cookie: undefined, token: peer.accessToken, expected: 403 });
  const direct = {
    accountId: f.accountId,
    projectId: f.projectId,
    actorId: f.actorId,
    verificationId: r.verification.id,
    expectedVersion: body.expectedVersion,
    status: "failed",
    failureReason: body.failureReason,
    resultSummary: body.resultSummary,
    clientSubmissionId: null,
    attachmentIds: [],
    captureBundleId: null,
    idempotencyKey: "cookie-result",
    requestDigest: "1".repeat(64),
    createdAt: new Date().toISOString(),
  };
  await f.worker.projectManagement({
    accountId: f.accountId,
    actorId: f.gmId,
    isGm: true,
    operation: "membership",
    projectId: f.projectId,
    userId: f.actorId,
    active: false,
    expectedVersion: 1,
    now: new Date().toISOString(),
  });
  const revoked = snapshot(f);
  await f.call(r.path, { ...options, csrf: browser.csrfToken, expected: 403 });
  await assert.rejects(
    f.worker.recordMobileVerificationResult(direct),
    (e) => e.code === "FORBIDDEN",
  );
  assert.deepEqual(snapshot(f), revoked);
});

test("same vendor key concurrent calls commit once; deleted targets refuse receipt reads", async (t) => {
  const f = await fixture(t),
    r = await round(f),
    body = bodyFor(r, "passed"),
    options = { body, key: r.key };
  const [a, b] = await Promise.all([f.call(r.path, options), f.call(r.path, options)]);
  assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
  assert.equal(a.eventId, b.eventId);
  assert.deepEqual({ ...a, replayed: false }, { ...b, replayed: false });
  const before = snapshot(f);
  await f.call(r.path, {
    body: bodyFor(r, "passed", true),
    key: r.key,
    contentType: "application/json",
    accept: "application/json",
    expected: 409,
  });
  await f.call(r.path, {
    ...options,
    body: { ...body, clientSubmissionId: randomUUID() },
    expected: 409,
  });
  assert.deepEqual(snapshot(f), before);
  await f.call(`bugs/${r.bug.id}?expectedVersion=${a.bug.version}`, {
    method: "DELETE",
    key: `web:deleteBug:bug:${r.bug.id}:v${a.bug.version}`,
  });
  const deleted = snapshot(f);
  await f.call(r.path, { ...options, expected: 404 });
  await f.call(`verifications/${r.verification.id}`, { expected: 404 });
  assert.deepEqual(snapshot(f), deleted);
});

test("legal long Unicode/control text exceeds generic 64KiB while exact immutable replay and recovery remain valid", async (t) => {
  const f = await fixture(t);
  const criteria = "验".repeat(4990) + "token text" + "\u0001".repeat(5000);
  const r = await round(f, { criteria });
  const body = {
    ...bodyFor(r, "failed"),
    resultSummary: "验".repeat(10000),
    failureReason: "\u0002".repeat(5000),
  };
  const first = await f.call(r.path, { body, key: r.key });
  assert.equal(first.verification.criteriaSnapshot, criteria);
  assert.equal(first.verification.resultSummary, body.resultSummary);
  const committed = snapshot(f),
    stored = committed.verification_result_snapshots.at(-1);
  const bytes = Buffer.byteLength(stored.response_json);
  assert.ok(bytes > 65536 && bytes <= 1048576);
  assert.ok(Buffer.byteLength(committed.idempotency_records.at(-1).response_json) < 65536);
  const original = JSON.parse(stored.response_json);
  assert.equal(original.verification.failureReason, body.failureReason);
  assert.deepEqual(await f.call(r.path, { body, key: r.key }), { ...first, replayed: true });
  assert.deepEqual(snapshot(f), committed);
  const copy = join(f.directory, "recovered.sqlite");
  const source = new DatabaseSync(f.databaseFile, { readOnly: true });
  try {
    await backup(source, copy);
  } finally {
    source.close();
  }
  const restored = new SqliteStorageWorker({
    databaseFile: copy,
    backupRoot: join(f.directory, "recovery-backups"),
    busyTimeoutMs: 1000,
  });
  try {
    const canonical = parseMobileRecordVerificationResultRequest(body);
    const replay = await restored.recordMobileVerificationResult({
      ...canonical,
      accountId: f.accountId,
      projectId: f.projectId,
      actorId: f.actorId,
      verificationId: r.verification.id,
      idempotencyKey: r.key,
      requestDigest: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
      captureBundleId: null,
      createdAt: new Date().toISOString(),
    });
    assert.deepEqual(replay, { ...original, replayed: true });
    assert.deepEqual(snapshot({ databaseFile: copy }), committed);
  } finally {
    await restored.close();
  }
  t.diagnostic(`immutable result bytes=${bytes}; online backup restored without re-execution`);
});

test("manual takeover preserves actual non-null parentAttemptId in frozen result and original replay", async (t) => {
  const f = await fixture(t),
    r = await round(f, { parent: true });
  const body = bodyFor(r, "passed");
  assert.ok(r.parentId);
  const first = await f.call(r.path, { body, key: r.key });
  assert.equal(first.repairAttempt.parentAttemptId, r.parentId);
  assert.equal((await f.call(`repair-attempts/${r.attempt.id}`)).parentAttemptId, r.parentId);
  assert.deepEqual(await f.call(r.path, { body, key: r.key }), { ...first, replayed: true });
});

test("fixed pre-Phase-A writer leaves IDs-only history intact; new replay refuses to reconstruct it", async (t) => {
  const f = await fixture(t),
    r = await round(f),
    body = bodyFor(r, "failed");
  const old = await oldWriter(f);
  const canonical = parseMobileRecordVerificationResultRequest(body);
  const command = {
    ...canonical,
    accountId: f.accountId,
    projectId: f.projectId,
    actorId: f.actorId,
    verificationId: r.verification.id,
    idempotencyKey: r.key,
    requestDigest: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
    captureBundleId: null,
    createdAt: new Date().toISOString(),
  };
  const db = new DatabaseSync(f.databaseFile);
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    old.recordMobileVerificationResult(db, command);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  const original = snapshot(f);
  assert.equal(original.verification_result_snapshots.length, 0);
  assert.equal(
    Object.hasOwn(JSON.parse(original.submissions.at(-1).response_json), "snapshotId"),
    false,
  );
  const unavailable = await f.call(r.path, { body, key: r.key, expected: 412 });
  assert.match(unavailable.message, /original.*receipt.*unavailable/iu);
  assert.match(unavailable.requestId, /^[0-9a-f-]{36}$/u);
  await assert.rejects(
    f.worker.recordMobileVerificationResult(command),
    (e) => e.code === "VERSION_CONFLICT" && /Historical.*receipt/u.test(e.message),
  );
  assert.deepEqual(snapshot(f), original);
  assert.equal((await f.call(`verifications/${r.verification.id}`)).status, "failed");
  assert.equal((await f.call(`bugs/${r.bug.id}`)).state, "ready");
});

async function oldWriter(f) {
  const source = execFileSync(
    "git",
    [
      "show",
      "3baff66d84dd6ad2f9b5f48230ff4375510269ec:packages/storage/src/mobile-verification-store.ts",
    ],
    { cwd: new URL("../../..", import.meta.url), encoding: "utf8", windowsHide: true },
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "b6e77504faeb146078d01e17d6d96a2546ebdf51380f097645198f1c3dad7458",
  );
  const code = stripTypeScriptTypes(source).replace(
    /from "\.\/(.*?)"/gu,
    (_, name) =>
      `from "${new URL(`../../../packages/storage/dist/${name}`, import.meta.url).href}"`,
  );
  const writerPath = join(f.directory, "pinned-pre-phase-a-writer.mjs");
  await writeFile(writerPath, code);
  return import(pathToFileURL(writerPath).href);
}

test("snapshot/pointer exact shape, types, scope and digest cannot be replaced; rejected transactions leave all facts intact", async (t) => {
  const f = await fixture(t),
    r = await round(f),
    body = bodyFor(r, "passed");
  const canonical = parseMobileRecordVerificationResultRequest(body),
    old = await oldWriter(f);
  const command = {
    ...canonical,
    accountId: f.accountId,
    projectId: f.projectId,
    actorId: f.actorId,
    verificationId: r.verification.id,
    idempotencyKey: r.key,
    requestDigest: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
    failureReason: null,
    captureBundleId: null,
    createdAt: new Date().toISOString(),
  };
  const db = new DatabaseSync(f.databaseFile);
  let result;
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    result = old.recordMobileVerificationResult(db, command);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  const before = snapshot(f);
  const dto = { ...result, clientSubmissionId: null };
  // The result is a genuine typed effect from the pinned old writer. Only reservations/snapshots
  // below are speculative, and each whole transaction is rolled back, including the valid control.
  const key = "rolled-back-legacy-snapshot-probe",
    operation = "recordLegacyVerificationResult";
  function probe(change, pointerChange, valid = false) {
    const connection = new DatabaseSync(f.databaseFile);
    connection.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    try {
      const receipt = workflowReceipt(connection, { ...command, idempotencyKey: key }, operation, {
        type: "verification",
        id: r.verification.id,
      });
      const snapshotId = randomUUID();
      const values = {
        id: snapshotId,
        account_id: f.accountId,
        project_id: f.projectId,
        actor_id: f.actorId,
        bug_id: r.bug.id,
        verification_id: r.verification.id,
        client_submission_id: null,
        operation_id: operation,
        idempotency_key: key,
        request_digest: command.requestDigest,
        event_id: result.eventId,
        response_json: JSON.stringify(dto),
        created_at: command.createdAt,
      };
      change?.(values);
      const perform = () => {
        connection
          .prepare(
            `INSERT INTO verification_result_snapshots (${Object.keys(values).join(",")}) VALUES (${Object.keys(
              values,
            )
              .map(() => "?")
              .join(",")})`,
          )
          .run(...Object.values(values));
        const pointer = {
          clientSubmissionId: null,
          projectId: f.projectId,
          bugId: r.bug.id,
          occurrenceId: null,
          commentId: null,
          verificationId: r.verification.id,
          captureBundleId: null,
          snapshotId,
        };
        if (pointerChange) {
          const raw = pointerChange(JSON.stringify(pointer));
          connection
            .prepare(
              "UPDATE idempotency_records SET status='committed',http_status=200,response_json=?,audit_event_id=?,version=2 WHERE operation_id=? AND idempotency_key=? AND status='reserved'",
            )
            .run(raw, result.eventId, operation, key);
        } else receipt.commit(pointer, result.eventId);
        assert.throws(
          () =>
            connection
              .prepare(
                "UPDATE verification_result_snapshots SET response_json=response_json WHERE id=?",
              )
              .run(snapshotId),
          /immutable/u,
        );
        assert.throws(
          () =>
            connection
              .prepare("DELETE FROM verification_result_snapshots WHERE id=?")
              .run(snapshotId),
          /append-only/u,
        );
      };
      if (valid) perform();
      else assert.throws(perform, /snapshot|exact typed effect/u);
    } finally {
      connection.exec("ROLLBACK");
      connection.close();
    }
    assert.deepEqual(snapshot(f), before);
  }
  probe(undefined, undefined, true);
  probe((v) => {
    v.response_json = v.response_json.replace('"captureBundleId":null', '"replayed":true');
  });
  probe((v) => {
    v.response_json = v.response_json.replace('"occurrenceCount":1', '"occurrenceCount":true');
  });
  probe((v) => {
    const value = JSON.parse(v.response_json);
    value.bug.password = "injected structural key";
    v.response_json = JSON.stringify(value);
  });
  probe((v) => {
    const value = JSON.parse(v.response_json);
    delete value.bug.moduleId;
    value.bug.title = "Different title";
    v.response_json = JSON.stringify(value);
  });
  probe((v) => {
    v.project_id = f.otherProject;
  });
  probe((v) => {
    v.actor_id = f.gmId;
  });
  probe((v) => {
    v.request_digest = "e".repeat(64);
  });
  probe((v) => {
    v.event_id = before.events[0].id;
  });
  probe(undefined, (raw) => raw.replace('"captureBundleId":null', '"snapshotId":"bad-duplicate"'));
  probe(undefined, (raw) => raw.replace('"commentId":null', '"commentId":null,"extra":"injected"'));
  probe(undefined, (raw) => {
    const value = JSON.parse(raw);
    value.snapshotId = randomUUID();
    return JSON.stringify(value);
  });
  probe(undefined, (raw) => {
    const value = JSON.parse(raw);
    value.projectId = f.otherProject;
    return JSON.stringify(value);
  });
});

for (const legacy of [false, true])
  test(`${legacy ? "legacy" : "vendor"} result final receipt failure rolls back domain, event, notification, snapshot and submission atomically`, async (t) => {
    const f = await fixture(t),
      r = await round(f),
      body = bodyFor(r, "failed", legacy);
    const options = {
      body,
      key: legacy ? "atomic-legacy" : r.key,
      contentType: "application/json",
      accept: legacy ? "application/json" : vendor,
    };
    const before = snapshot(f),
      db = new DatabaseSync(f.databaseFile);
    try {
      db.exec(
        "CREATE TRIGGER phase_a_fixture_fault BEFORE UPDATE ON idempotency_records WHEN new.operation_id IN ('recordVerificationResult','recordLegacyVerificationResult') AND new.status='committed' BEGIN SELECT RAISE(ABORT,'phase-a final receipt failure'); END",
      );
    } finally {
      db.close();
    }
    assert.equal(
      (await f.call(r.path, { ...options, expected: 503 })).code,
      "STORAGE_WRITE_TEMPORARILY_UNAVAILABLE",
    );
    assert.deepEqual(snapshot(f), before);
    const release = new DatabaseSync(f.databaseFile);
    try {
      release.exec("DROP TRIGGER phase_a_fixture_fault");
    } finally {
      release.close();
    }
    const result = await f.call(r.path, options);
    assert.equal(result.verification.status, "failed");
    assert.equal(snapshot(f).verification_result_snapshots.length, 1);
  });

test("ordinary multi-employee closure remains allowed while the frozen result requires its assigned verifier, including replay", async (t) => {
  const f = await fixture(t),
    r = await round(f),
    body = bodyFor(r, "passed");
  const peer = await f.request("auth/login", {
    body: { projectId: f.projectId, name: "Ordinary closer", client: "android" },
  });
  const before = snapshot(f);
  await f.call(r.path, { body, key: r.key, token: peer.accessToken, expected: 403 });
  await f.call(r.path, {
    body: { ...body, requireAssignedVerifier: false },
    key: r.key,
    token: peer.accessToken,
    expected: 400,
  });
  assert.deepEqual(snapshot(f), before);
  const action = {
    action: "verify_pass",
    verificationId: r.verification.id,
    expectedVersion: body.expectedVersion,
    request: body,
  };
  const path = `projects/${f.projectId}/bugs/${r.bug.id}/actions`;
  const result = await f.call(path, { body: action, key: r.key, token: peer.accessToken });
  assert.equal(result.bug.state, "closed");
  assert.equal(result.result.verification.verifierId, f.actorId);
  assert.equal(result.result.replayed, false);
  const after = snapshot(f);
  assert.equal(after.verification_result_snapshots.at(-1).actor_id, peer.userId);
  assert.equal(after.events.at(-1).actor_user_id, peer.userId);
  await f.call(r.path, { body, key: r.key, token: peer.accessToken, expected: 403 });
  assert.equal(
    (await f.call(path, { body: action, key: r.key, token: peer.accessToken })).result.replayed,
    true,
  );
  assert.deepEqual(snapshot(f), after);
});
