import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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

const vendor = "application/vnd.relay-qa-hub.v1.1+json";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "qa-frozen-workflow-sqlite-"));
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
      webOrigins: [],
      gm: { userId: gmId, password: "fixture-gm-password" },
    },
  });
  t.after(async () => {
    await app.close();
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function request(
    path,
    {
      body,
      token,
      project = projectId,
      accept = vendor,
      key,
      method = body ? "POST" : "GET",
      expected = 200,
    } = {},
  ) {
    const response = await app.inject({
      method,
      url: `/api/v1/${path}`,
      headers: {
        accept,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "x-qa-project-id": project,
        ...(body ? { "content-type": vendor } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body ? { payload: body } : {}),
    });
    assert.equal(response.statusCode, expected, response.body);
    return response.json();
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

test("SQLite human lifecycle preserves delivery/rejection facts while frozen responses and replay omit them", async (t) => {
  const f = await fixture(t);
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
      summary: "Manual fixture",
    },
    key: `workflow:createRepairAttempt:bug:${bug.id}:v${bug.version}`,
    expected: 201,
  });
  attempt = await f.call(`repair-attempts/${attempt.id}/start`, {
    body: { expectedVersion: attempt.version, reason: "Start" },
    key: `workflow:startRepairAttempt:attempt:${attempt.id}:v${attempt.version}`,
  });
  attempt = await f.call(`repair-attempts/${attempt.id}/deliver`, {
    body: {
      expectedVersion: attempt.version,
      deliveryKind: "no_code",
      noCodeReason: "Configuration restored without code",
      summary: "Delivered configuration",
    },
    key: `workflow:deliverRepairAttempt:attempt:${attempt.id}:v${attempt.version}`,
  });
  assert.equal(Object.hasOwn(attempt, "noCodeReason"), false);
  const rich = await f.call(`repair-attempts/${attempt.id}`);
  assert.equal(rich.noCodeReason, "Configuration restored without code");
  bug = await f.call(`bugs/${bug.id}`);
  assert.equal(bug.state, "ready_for_verification");
  let verification = await f.call(`bugs/${bug.id}/verifications`, {
    body: {
      expectedVersion: bug.version,
      repairAttemptId: attempt.id,
      buildId: null,
      verifierId: f.actorId,
      criteria: "Configuration works",
    },
    key: `workflow:createVerification:bug:${bug.id}:attempt:${attempt.id}:v${bug.version}`,
    expected: 201,
  });
  verification = await f.call(`verifications/${verification.id}/start`, {
    body: { expectedVersion: verification.version, reason: "Inspect" },
    key: `workflow:startVerification:verification:${verification.id}:v${verification.version}`,
  });
  const body = {
    submissionContractVersion: "1.1.0",
    clientSubmissionId: randomUUID(),
    expectedVersion: verification.version,
    status: "failed",
    resultSummary: "Still reproducible",
    failureReason: "Acceptance failed with real recorded reason",
    attachmentIds: [],
  };
  const key = `workflow:recordVerificationResult:verification:${verification.id}:v${verification.version}`;
  const result = await f.call(`verifications/${verification.id}/result`, { body, key });
  assert.equal(result.repairAttempt.status, "verification_failed");
  assert.equal(Object.hasOwn(result.repairAttempt, "noCodeReason"), false);
  assert.equal(Object.hasOwn(result.verification, "failureReason"), false);
  assert.equal((await f.call(`repair-attempts/${attempt.id}`)).noCodeReason, rich.noCodeReason);
  assert.equal(
    (await f.call(`verifications/${verification.id}`)).failureReason,
    body.failureReason,
  );
  const workflow = await f.call(`bugs/${bug.id}/human-workflow`);
  assert.equal(workflow.latestVerification.failureReason, body.failureReason);
  const legacy = await f.call(`verifications/${verification.id}/result`, {
    body,
    key,
    accept: "application/json",
  });
  assert.deepEqual(Object.keys(legacy).sort(), ["bug", "verification"]);
  assert.equal(Object.hasOwn(legacy.bug, "moduleId"), false);
  assert.equal(Object.hasOwn(legacy.bug, "duplicateOfBugId"), false);
  assert.deepEqual(legacy.verification, result.verification);
  const replay = await f.call(`verifications/${verification.id}/result`, { body, key });
  assert.equal(replay.replayed, true);
  assert.equal(replay.eventId, result.eventId);
  assert.equal(replay.bug.version, result.bug.version);
});

test("historical GET reads all persisted modes without widening action permissions and hides forbidden/deleted Bugs", async (t) => {
  const f = await fixture(t);
  const histories = [];
  for (const mode of ["human", "relay", "external"]) {
    for (const status of ["failed", "verification_failed", "superseded", "cancelled"])
      histories.push({ bug: await f.bug(`${mode} ${status}`), id: randomUUID(), mode, status });
  }
  // Import a synthetic historical snapshot. Restore every trigger before the API can
  // read it; this does not pretend the missing legacy mutations are implemented.
  const db = new DatabaseSync(f.databaseFile);
  const blockedVerificationId = randomUUID();
  try {
    const triggerSql =
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('repair_attempts','verifications') ORDER BY name";
    const triggers = db.prepare(triggerSql).all();
    db.exec("BEGIN IMMEDIATE");
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    for (const item of histories) {
      db.prepare(
        `INSERT INTO repair_attempts(id,account_id,project_id,bug_id,sequence,mode,status,assignee_id,summary,patch_url,no_code_reason,failure_reason,created_at,updated_at,version) VALUES(?,?,?,?,1,?,?,?,?,?,?,?,?,?,3)`,
      ).run(
        item.id,
        f.accountId,
        f.projectId,
        item.bug.id,
        item.mode,
        item.status,
        f.actorId,
        "Imported synthetic history",
        "https://example.invalid/history.patch",
        "Historical no-code detail",
        "Historical failure detail",
        new Date().toISOString(),
        new Date().toISOString(),
      );
    }
    const blockedAttempt = histories[1];
    db.prepare(
      `INSERT INTO verifications(id,account_id,project_id,bug_id,repair_attempt_id,build_id,status,verifier_id,criteria_snapshot,result_summary,blocked_reason,created_at,updated_at,version) VALUES(?,?,?,?,?,NULL,'blocked',?,'Imported acceptance','Awaiting test resource','Historical blocked detail',?,?,3)`,
    ).run(
      blockedVerificationId,
      f.accountId,
      f.projectId,
      blockedAttempt.bug.id,
      blockedAttempt.id,
      f.actorId,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    for (const trigger of triggers) db.exec(trigger.sql);
    db.exec("COMMIT");
    assert.deepEqual(db.prepare(triggerSql).all(), triggers);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
  for (const item of histories) {
    const read = await f.call(`repair-attempts/${item.id}`);
    assert.equal(read.mode, item.mode);
    assert.equal(read.status, item.status);
    assert.equal(read.patchUrl, "https://example.invalid/history.patch");
    assert.equal(read.noCodeReason, "Historical no-code detail");
    assert.equal(read.failureReason, "Historical failure detail");
    await f.call(`repair-attempts/${item.id}/start`, {
      body: { expectedVersion: 3, reason: "Cannot act on historical record" },
      key: `workflow:startRepairAttempt:attempt:${item.id}:v3`,
      expected: 404,
    });
  }
  assert.equal(
    (await f.call(`verifications/${blockedVerificationId}`)).blockedReason,
    "Historical blocked detail",
  );
  const gm = await f.request("auth/gm/login", {
    body: { password: "fixture-gm-password", client: "android" },
  });
  assert.equal(
    (await f.call(`repair-attempts/${histories[4].id}`, { token: gm.accessToken })).mode,
    "relay",
  );
  const item = histories[0];
  await f.call(`repair-attempts/${item.id}`, { project: f.otherProject, expected: 404 });
  await f.call(`repair-attempts/${item.id}`, { token: f.other.accessToken, expected: 403 });
  await f.call(`bugs/${item.bug.id}?expectedVersion=${item.bug.version}`, {
    method: "DELETE",
    key: `web:deleteBug:bug:${item.bug.id}:v${item.bug.version}`,
  });
  await f.call(`repair-attempts/${item.id}`, { expected: 404 });
  const member = {
    accountId: f.accountId,
    projectId: f.projectId,
    actorId: f.actorId,
    attemptId: item.id,
  };
  assert.equal(await f.worker.getRepairAttemptDetail(member), null);
  assert.equal(
    await f.worker.getRepairAttemptDetail({
      ...member,
      attemptId: histories[1].id,
      actorId: f.other.userId,
    }),
    null,
  );
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
  await f.call(`repair-attempts/${histories[1].id}`, { expected: 403 });
});
