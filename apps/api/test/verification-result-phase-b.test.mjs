import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteStorageWorker, projectMembershipId } from "@relay-qa-hub/storage";
import { createApiApp } from "../dist/app.js";
import { createSqliteBrowserAuthStore } from "../dist/browser-auth.js";
import { ProjectManagementService } from "../dist/project-management.js";
import { ProjectRequestContext } from "../dist/project-request-context.js";
import { createSqliteMobileBugStore } from "../dist/sqlite-mobile-bug-store.js";
import { createSqliteMobileRelayStore } from "../dist/sqlite-mobile-relay-store.js";
import { createSqliteMobileVerificationStore } from "../dist/sqlite-mobile-verification-store.js";
import { createSqliteMobileHumanWorkflowStore } from "../dist/sqlite-mobile-human-workflow-store.js";

const origin = "http://phase-b.fixture.invalid";
const vendor = "application/vnd.relay-qa-hub.v1.1+json";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "qa-result-phase-b-"));
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
      summary: "Phase B human fixture",
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

for (const legacy of [false, true]) {
  test(
    "blocked " +
      (legacy ? "legacy" : "vendor") +
      " retains the delivered Attempt and original receipt across another complete Verification",
    async (t) => {
      const f = await fixture(t),
        r = await round(f);
      const body = {
        ...bodyFor(r, "blocked", legacy),
        blockedReason: "Target device is unavailable",
      };
      const options = {
        body,
        key: legacy ? "blocked-original" : r.key,
        contentType: "application/json",
        accept: legacy ? "application/json" : vendor,
      };
      const before = snapshot(f);
      const original = await f.call(r.path, options);
      const after = snapshot(f);
      assert.equal(original.verification.status, "blocked");
      // The frozen DTO omits reasons. Typed storage and the full immutable
      // receipt retain them without adding forbidden wire properties.
      assert.equal(Object.hasOwn(original.verification, "blockedReason"), false);
      assert.equal(Object.hasOwn(original.verification, "failureReason"), false);
      assert.equal(after.verifications[0].blocked_reason, body.blockedReason);
      assert.equal(after.verifications[0].failure_reason, null);
      assert.equal(
        JSON.parse(after.verification_result_snapshots[0].response_json).verification.blockedReason,
        body.blockedReason,
      );
      assert.equal(original.verification.version, r.verification.version + 1);
      assert.equal(original.bug.state, "ready_for_verification");
      assert.equal(original.bug.version, before.bugs[0].version + 1);
      assert.equal(after.bugs[0].active_repair_attempt_id, r.attempt.id);
      assert.equal(after.bugs[0].active_verification_id, null);
      assert.deepEqual(after.repair_attempts, before.repair_attempts);
      assert.equal(after.events.length, before.events.length + 1);
      assert.equal(after.outbox.length, before.outbox.length + 1);
      assert.equal(after.submissions.length, before.submissions.length + (legacy ? 0 : 1));
      assert.equal(after.idempotency_records.length, before.idempotency_records.length + 1);
      assert.equal(after.verification_result_snapshots.length, 1);
      const event = after.events.at(-1);
      assert.equal(event.actor_user_id, f.actorId);
      assert.equal(event.from_state, "ready_for_verification");
      assert.equal(event.to_state, "ready_for_verification");
      assert.equal(JSON.parse(event.payload_json).status, "blocked");
      assert.equal(JSON.parse(event.payload_json).reason, body.blockedReason);
      assert.deepEqual(
        await f.call(r.path, options),
        legacy ? original : { ...original, replayed: true },
      );
      assert.deepEqual(snapshot(f), after);
      const different = await f.call(r.path, {
        ...options,
        body: { ...body, blockedReason: "Different reason" },
        expected: 409,
      });
      assert.equal(different.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
      assert.deepEqual(snapshot(f), after);
      const laterBug = await f.call("bugs/" + r.bug.id, {
        method: "PATCH",
        body: { expectedVersion: original.bug.version, title: "Later edit retained" },
        key: "web:updateBug:bug:" + r.bug.id + ":v" + original.bug.version,
      });
      let verification = await f.call("bugs/" + r.bug.id + "/verifications", {
        body: {
          expectedVersion: laterBug.version,
          repairAttemptId: r.attempt.id,
          buildId: null,
          verifierId: f.actorId,
          criteria: "Device is now available",
        },
        key:
          "workflow:createVerification:bug:" +
          r.bug.id +
          ":attempt:" +
          r.attempt.id +
          ":v" +
          laterBug.version,
        expected: 201,
      });
      assert.notEqual(verification.id, r.verification.id);
      verification = await f.call("verifications/" + verification.id + "/start", {
        body: { expectedVersion: verification.version },
        key:
          "workflow:startVerification:verification:" +
          verification.id +
          ":v" +
          verification.version,
      });
      const current = snapshot(f);
      const oldVersion = await f.call(r.path, {
        body: {
          expectedVersion: r.verification.version + 1,
          status: "passed",
          resultSummary: "Cannot reuse terminal Verification",
        },
        contentType: "application/json",
        accept: "application/json",
        key: "old-blocked-new-key",
        expected: 412,
      });
      assert.equal(oldVersion.code, "VERSION_CONFLICT");
      assert.deepEqual(snapshot(f), current);
      const passed = await f.call("verifications/" + verification.id + "/result", {
        body: bodyFor({ verification }, "passed"),
        key:
          "workflow:recordVerificationResult:verification:" +
          verification.id +
          ":v" +
          verification.version,
      });
      assert.equal(passed.bug.state, "closed");
      const closed = snapshot(f);
      assert.deepEqual(
        await f.call(r.path, options),
        legacy ? original : { ...original, replayed: true },
      );
      assert.deepEqual(snapshot(f), closed);
      assert.equal((await f.call("verifications/" + r.verification.id)).status, "blocked");
      assert.equal(closed.verification_result_snapshots.length, 2);
      assert.deepEqual(closed.repair_attempts, before.repair_attempts);
      assert.equal(closed.bugs[0].active_repair_attempt_id, null);
      assert.equal(closed.bugs[0].active_verification_id, null);
    },
  );

  test(
    "blocked " +
      (legacy ? "legacy" : "vendor") +
      " reason guards and current authorization leave all transaction facts unchanged",
    async (t) => {
      const f = await fixture(t),
        r = await round(f),
        before = snapshot(f);
      const body = { ...bodyFor(r, "blocked", legacy), blockedReason: "Waiting for device" };
      const options = {
        body,
        key: legacy ? "reason-key" : r.key,
        contentType: "application/json",
        accept: legacy ? "application/json" : vendor,
      };
      for (const patch of [
        { blockedReason: undefined },
        { blockedReason: "" },
        { blockedReason: " " },
        { blockedReason: "x".repeat(5001) },
        { blockedReason: null },
        { blockedReason: false },
        { failureReason: "Not applicable" },
        { status: "failed", failureReason: "Failed but has blocked reason" },
        { status: "passed" },
      ]) {
        await f.call(r.path, { ...options, body: { ...body, ...patch }, expected: 400 });
        assert.deepEqual(snapshot(f), before);
      }
      const peer = await f.request("auth/login", {
        body: { projectId: f.projectId, name: "Different verifier", client: "android" },
      });
      await f.call(r.path, { ...options, token: peer.accessToken, expected: 403 });
      await f.call(r.path, { ...options, token: f.other.accessToken, expected: 403 });
      const wrongVersion = { ...body, expectedVersion: 9 };
      await f.call(r.path, {
        ...options,
        body: wrongVersion,
        key: legacy ? "wrong-version" : r.key.replace(/:v[0-9]+$/u, ":v9"),
        expected: 412,
      });
      assert.deepEqual(snapshot(f), before);
      const first = await f.call(r.path, options);
      assert.equal(first.verification.status, "blocked");
      const committed = snapshot(f);
      await f.call(r.path, { ...options, token: peer.accessToken, expected: 403 });
      assert.deepEqual(snapshot(f), committed);
    },
  );
}

test("blocked result full UTF-16 limits preserve original text while escaping audit payload safely", async (t) => {
  const f = await fixture(t),
    r = await round(f);
  const reason = "中\u0001".repeat(2500),
    summary = "记\u0002".repeat(5000);
  const body = { ...bodyFor(r, "blocked"), resultSummary: summary, blockedReason: reason };
  const first = await f.call(r.path, { body, key: r.key });
  assert.equal(Object.hasOwn(first.verification, "blockedReason"), false);
  assert.equal(first.verification.resultSummary, summary);
  const facts = snapshot(f),
    event = facts.events.at(-1);
  assert.equal(facts.verifications[0].blocked_reason, reason);
  assert.equal(
    JSON.parse(facts.verification_result_snapshots[0].response_json).verification.blockedReason,
    reason,
  );
  assert.ok(Buffer.byteLength(event.payload_json, "utf8") < 4096);
  assert.deepEqual(await f.call(r.path, { body, key: r.key }), { ...first, replayed: true });
  assert.deepEqual(snapshot(f), facts);
});

test("blocked receipt failure rolls back Verification, Bug pointers, Event, outbox and snapshot atomically", async (t) => {
  const f = await fixture(t),
    r = await round(f),
    before = snapshot(f);
  const db = new DatabaseSync(f.databaseFile);
  try {
    db.exec(
      "CREATE TRIGGER phase_b_receipt_fault BEFORE UPDATE ON idempotency_records WHEN new.status='committed' AND new.operation_id='recordVerificationResult' BEGIN SELECT RAISE(ABORT,'injected final receipt fault'); END;",
    );
  } finally {
    db.close();
  }
  const body = { ...bodyFor(r, "blocked"), blockedReason: "Waiting for device" };
  const failed = await f.call(r.path, { body, key: r.key, expected: 503 });
  assert.equal(failed.code, "STORAGE_WRITE_TEMPORARILY_UNAVAILABLE");
  assert.deepEqual(snapshot(f), before);
  const repair = new DatabaseSync(f.databaseFile);
  try {
    repair.exec("DROP TRIGGER phase_b_receipt_fault");
  } finally {
    repair.close();
  }
  const committed = await f.call(r.path, { body, key: r.key });
  assert.equal(committed.verification.status, "blocked");
  assert.equal(snapshot(f).verification_result_snapshots.length, 1);
});
