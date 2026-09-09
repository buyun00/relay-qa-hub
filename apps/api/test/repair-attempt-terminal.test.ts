import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import Fastify from "fastify";
import { createRequire } from "node:module";
import {
  migrateSqliteDatabase,
  openSqliteDatabaseForWorker,
  verifySqliteIntegrity,
} from "../../../packages/storage/src/sqlite.ts";
import {
  ensureMobileScope,
  createMobileBug,
  deleteMobileBug,
  getMobileBug,
} from "../../../packages/storage/src/mobile-bug-store.ts";
import {
  ensureMobileRelayRoles,
  transitionMobileBugReady,
  createMobileManualRepairAttempt,
  startMobileRepairAttempt,
  deliverMobileRepairAttempt,
} from "../../../packages/storage/src/mobile-relay-store.ts";
import { projectManagement } from "../../../packages/storage/src/project-management-store.ts";
import * as sessions from "../../../packages/storage/src/browser-auth-store.ts";
import { REPAIR_ATTEMPT_TERMINAL_SNAPSHOT_SQL } from "../../../packages/storage/src/repair-attempt-terminal-migration.ts";
import {
  terminateRepairAttempt,
  getTerminalRepairAttemptHistory,
  createRepairAttemptAfterLegacySupersede,
} from "../../../packages/storage/src/repair-attempt-terminal-store.ts";
import { canonicalWorkflowRequestDigest } from "../../../packages/storage/src/workflow-idempotency.ts";
import { registerTerminalRepairAttemptRoutes } from "../src/repair-attempt-terminal.ts";
import {
  authenticateBrowserRequest,
  authenticateBrowserBearerRequest,
  createSqliteBrowserAuthStore,
  registerBrowserAuthRoutes,
} from "../src/browser-auth.ts";
import { MOBILE_API_MEDIA_TYPE } from "../src/mobile-bugs.ts";
import { normalizeQaLoginName, qaUserId, qaLoginEmail } from "../src/people-config.ts";

interface WorkflowPayload {
  code?: string;
  id?: string;
  summary?: string | null;
  parentAttemptId?: string | null;
  mode?: string;
  sequence?: number;
  version?: number;
  replayed?: boolean;
  successorAttempt?: import("../../../packages/storage/src/repair-attempt-detail-store.ts").RepairAttemptDetail;
  supersededAttempt?: import("../../../packages/storage/src/repair-attempt-detail-store.ts").RepairAttemptDetail;
  bug?: import("../../../packages/storage/src/mobile-bug-store.ts").MobileBugRecord;
}
const now = () => new Date().toISOString();
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020.js").default;
const formats = require("ajv-formats").default;
async function validators() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  formats(ajv);
  for (const name of ["common", "bug", "workflow", "build", "relay"]) {
    const file = new URL(
      `../../../packages/contracts/schemas/${name}.schema.json`,
      import.meta.url,
    );
    try {
      ajv.addSchema(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
  const native = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/contracts/versions/1.1.0/schemas/app-first.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  ajv.addSchema(native);
  const attempt = ajv.compile({
    $ref: "https://qa-hub.local/contracts/workflow.schema.json#/$defs/repairAttempt",
  });
  const successor = ajv.compile({ $ref: `${native.$id}#/$defs/supersedeRepairAttemptResponse` });
  return { attempt, successor };
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qa-terminal-c-"));
  t.diagnostic(`retained isolated fixture ${directory}`);
  const file = join(directory, "main.sqlite");
  const db = openSqliteDatabaseForWorker({ databaseFile: file, busyTimeoutMs: 5000 });
  await migrateSqliteDatabase(db, file);
  db.exec(REPAIR_ATTEMPT_TERMINAL_SNAPSHOT_SQL);
  const scope = { accountId: randomUUID(), projectId: randomUUID(), actorId: randomUUID() };
  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  };
  tx(() => {
    const bootstrap = {
      ...scope,
      membershipId: randomUUID(),
      projectKey: "TERM",
      createdAt: now(),
    };
    ensureMobileScope(db, bootstrap);
    ensureMobileRelayRoles(db, bootstrap);
  });
  const app = Fastify({ logger: false, bodyLimit: 1048576 });
  const httpEvidence: object[] = [];
  app.addContentTypeParser(MOBILE_API_MEDIA_TYPE, { parseAs: "string" }, (_, body, done) => {
    try {
      done(null, JSON.parse(String(body)));
    } catch (error) {
      done(error as Error);
    }
  });
  const worker = {
    ensureBrowserAdmin: async (input: sessions.EnsureBrowserAdminInput) =>
      tx(() => sessions.ensureBrowserAdmin(db, input)),
    loginBrowserSession: async (input: sessions.LoginBrowserSessionInput) =>
      tx(() => sessions.loginBrowserSession(db, input)),
    createBrowserSession: async (input: sessions.CreateBrowserSessionInput) =>
      tx(() => sessions.createBrowserSession(db, input)),
    resolveBrowserSession: async (input: sessions.ResolveBrowserSessionInput) =>
      sessions.resolveBrowserSession(db, input),
    revokeBrowserSession: async (input: sessions.RevokeBrowserSessionInput) =>
      tx(() => sessions.revokeBrowserSession(db, input)),
  };
  const auth = {
    store: createSqliteBrowserAuthStore({ worker }),
    ...scope,
    userId: scope.actorId,
    adminEmail: "terminal-fixture@local.invalid",
    sessionSecret: randomUUID() + randomUUID(),
    webOrigins: ["http://terminal-fixture.local"],
    gm: { userId: scope.actorId, password: randomUUID() },
    passwordlessLogin: async () => {
      throw Error("Explicit project required");
    },
    projectLogin: async (name: string, projectId: string, at: string) => {
      const normalized = normalizeQaLoginName(name);
      const userId = qaUserId(scope.accountId, normalized.displayName);
      return tx(() =>
        projectManagement(db, {
          ...scope,
          actorId: userId,
          userId,
          operation: "login",
          projectId,
          displayName: normalized.displayName,
          email: qaLoginEmail(scope.accountId, normalized.displayName),
          now: at,
        }),
      ) as { userId: string; projectId: string };
    },
  };
  registerBrowserAuthRoutes(app, auth);
  app.addHook("preHandler", async (request, reply) => {
    if (request.url.startsWith("/api/v1/auth/")) return;
    if (await authenticateBrowserBearerRequest(request, auth)) return;
    await authenticateBrowserRequest(request, reply, auth);
  });
  const authorized = <T>(
    command: { accountId: string; projectId: string; actorId: string; isGm: boolean },
    fn: () => T,
  ) =>
    tx(() => {
      // The real session principal and configured GM identity grant one transaction, as in the worker.
      const gm =
        command.isGm && command.actorId === scope.actorId && command.accountId === scope.accountId;
      if (gm)
        db.prepare(
          "INSERT INTO storage_command_authorizations(account_id,project_id,actor_id) VALUES(?,?,?)",
        ).run(command.accountId, command.projectId, command.actorId);
      const result = fn();
      if (gm)
        db.prepare(
          "DELETE FROM storage_command_authorizations WHERE account_id=? AND project_id=? AND actor_id=?",
        ).run(command.accountId, command.projectId, command.actorId);
      return result;
    });
  registerTerminalRepairAttemptRoutes(app, {
    execute: (command) => authorized(command, () => terminateRepairAttempt(db, command)),
    createAfterLegacy: (command) =>
      authorized(command, () => createRepairAttemptAfterLegacySupersede(db, command)),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
    const integrity = verifySqliteIntegrity(db);
    try {
      assert.equal(integrity.ok, true);
      assert.equal(app.server.listening, false);
    } finally {
      db.close();
    }
    const evidenceFile = join(directory, "candidate-http-evidence.json");
    await writeFile(
      evidenceFile,
      JSON.stringify(
        {
          kind: "source candidate routes over actual random loopback HTTP",
          origin,
          originalApplicationRegistered: false,
          candidateMigrationOnly: true,
          closed: true,
          integrity,
          requests: httpEvidence,
          exclusions:
            "Auth/CSRF setup requests are exercised but their credential-bearing bodies and headers are not retained in this ledger.",
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    t.diagnostic(
      `retained ${httpEvidence.length} candidate HTTP request/response records; SHA256 ${createHash(
        "sha256",
      )
        .update(await readFile(evidenceFile))
        .digest("hex")}`,
    );
  });
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const loginResponse = await fetch(origin + "/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `TerminalActor${randomUUID()}`,
      projectId: scope.projectId,
      client: "android",
    }),
  });
  assert.equal(loginResponse.status, 200);
  const login = (await loginResponse.json()) as { accessToken: string; userId: string };
  const actor = { ...scope, actorId: login.userId };
  const snapshot = () =>
    Object.fromEntries(
      [
        "bugs",
        "repair_attempts",
        "events",
        "outbox",
        "idempotency_records",
        "repair_attempt_terminal_snapshots",
        "repair_attempt_parent_plan_snapshots",
      ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    );
  const plan = (running = false, maximum = false) =>
    tx(() => {
      const created = createMobileBug(db, {
        ...actor,
        clientSubmissionId: randomUUID(),
        payloadDigest: digest(randomUUID()),
        title: "Terminal candidate",
        description: "Preserved description",
        expectedBehavior: "One immutable result",
        severity: "S2",
        priority: "P2",
        ownerId: actor.actorId,
        verificationOwnerId: actor.actorId,
        occurrence: {
          observedAt: now(),
          platform: "web",
          steps: ["Verify terminal command"],
          actualBehavior: "Fixture",
        },
        attachmentIds: [],
        captureBundleId: null,
        createdAt: now(),
      });
      const base = {
        ...actor,
        idempotencyKey: randomUUID(),
        requestDigest: digest(randomUUID()),
        createdAt: now(),
      };
      const ready = transitionMobileBugReady(db, {
        ...base,
        bugId: created.bug.id,
        expectedVersion: 1,
      });
      const attempt = createMobileManualRepairAttempt(db, {
        ...base,
        idempotencyKey: randomUUID(),
        bugId: created.bug.id,
        expectedVersion: ready.version,
        assigneeId: actor.actorId,
        summary: maximum ? "原".repeat(10000) : "Original human plan",
      });
      return running
        ? startMobileRepairAttempt(db, {
            ...base,
            idempotencyKey: randomUUID(),
            attemptId: attempt.id,
            expectedVersion: attempt.version,
            reason: "Begin",
          })
        : attempt;
    });
  const send = async (
    attempt: { id: string; version: number },
    suffix: "fail" | "supersede",
    body: object,
    options: {
      vendor?: boolean;
      accept?: string;
      token?: string;
      projectId?: string;
      key?: string;
    } = {},
  ) => {
    const operation = suffix === "fail" ? "failRepairAttempt" : "supersedeRepairAttempt";
    const response = await fetch(`${origin}/api/v1/repair-attempts/${attempt.id}/${suffix}`, {
      method: "POST",
      headers: {
        "content-type": options.vendor ? MOBILE_API_MEDIA_TYPE : "application/json",
        authorization: `Bearer ${options.token ?? login.accessToken}`,
        "x-qa-project-id": options.projectId ?? actor.projectId,
        "idempotency-key":
          options.key ?? `workflow:${operation}:attempt:${attempt.id}:v${attempt.version}`,
        ...(options.accept === undefined ? {} : { accept: options.accept }),
      },
      body: JSON.stringify(body),
    });
    const result = {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: (await response.json()) as WorkflowPayload,
    };
    httpEvidence.push({
      method: "POST",
      path: `/api/v1/repair-attempts/${attempt.id}/${suffix}`,
      projectId: options.projectId ?? actor.projectId,
      media: options.vendor ? MOBILE_API_MEDIA_TYPE : "application/json",
      accept: options.accept ?? null,
      idempotencyKey:
        options.key ?? `workflow:${operation}:attempt:${attempt.id}:v${attempt.version}`,
      request: body,
      response: result,
    });
    return result;
  };
  const createAfter = async (
    bugId: string,
    body: Record<string, unknown>,
    key = `workflow:createRepairAttempt:bug:${bugId}:v${body.expectedVersion}`,
  ) => {
    const response = await fetch(`${origin}/api/v1/bugs/${bugId}/repair-attempts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${login.accessToken}`,
        "x-qa-project-id": actor.projectId,
        "idempotency-key": key,
      },
      body: JSON.stringify(body),
    });
    const result = { status: response.status, body: (await response.json()) as WorkflowPayload };
    httpEvidence.push({
      method: "POST",
      path: `/api/v1/bugs/${bugId}/repair-attempts`,
      projectId: actor.projectId,
      media: "application/json",
      idempotencyKey: key,
      request: body,
      response: result,
    });
    return result;
  };
  return {
    db,
    file,
    app,
    origin,
    tx,
    scope,
    actor,
    login,
    snapshot,
    plan,
    send,
    createAfter,
    auth,
  };
}

test("candidate real HTTP: planned/running fail retains summary/reason and immutable replay", async (t) => {
  const f = await fixture(t),
    schemas = await validators();
  for (const running of [false, true]) {
    const attempt = f.plan(running),
      before = getMobileBug(f.db, f.actor, attempt.bugId)!;
    const body = {
      expectedVersion: attempt.version,
      reason: running ? "Stop this attempt with full reason" : "token=synthetic-terminal-secret",
    };
    const result = await f.send(attempt, "fail", body, { vendor: running });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(schemas.attempt(result.body), true, JSON.stringify(schemas.attempt.errors));
    assert.equal(result.body.summary, body.reason);
    const historical = getTerminalRepairAttemptHistory(f.db, {
      ...f.actor,
      attemptId: attempt.id,
    })!;
    assert.equal(historical.summary, "Original human plan");
    assert.equal(historical.failureReason, body.reason);
    assert.equal(getMobileBug(f.db, f.actor, attempt.bugId)!.version, before.version + 1);
    const event = f.db
      .prepare(
        "SELECT from_state,to_state,payload_json FROM events WHERE aggregate_id=? AND type='repair_attempt.failed'",
      )
      .get(attempt.id)!;
    assert.equal(event.from_state, "in_progress");
    assert.equal(event.to_state, "ready");
    assert.deepEqual(JSON.parse(String(event.payload_json)), {
      status: "failed",
      repairAttemptId: attempt.id,
      reason: running ? body.reason : "[REDACTED]",
      fromVersion: attempt.version,
      toVersion: attempt.version + 1,
    });
    const once = f.snapshot();
    const replay = await f.send(attempt, "fail", body, { vendor: running });
    assert.deepEqual(replay.body, result.body);
    assert.deepEqual(f.snapshot(), once);
    const changed = await f.send(
      attempt,
      "fail",
      { ...body, reason: "Changed intent" },
      { vendor: running },
    );
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
    assert.deepEqual(f.snapshot(), once);
  }
});

test("candidate real HTTP: legacy supersede has no successor; vendor successor is atomic and schema-valid", async (t) => {
  const f = await fixture(t),
    schemas = await validators();
  const legacy = f.plan();
  const legacyResult = await f.send(legacy, "supersede", {
    expectedVersion: 1,
    reason: "Legacy supersede reason",
  });
  assert.equal(legacyResult.status, 200, JSON.stringify(legacyResult.body));
  assert.equal(schemas.attempt(legacyResult.body), true);
  assert.equal(getMobileBug(f.db, f.actor, legacy.bugId)!.state, "ready");
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM repair_attempts WHERE bug_id=?").get(legacy.bugId)!.n,
    1,
  );
  assert.equal(
    getTerminalRepairAttemptHistory(f.db, { ...f.actor, attemptId: legacy.id })!.supersedeReason,
    "Legacy supersede reason",
  );
  const legacyEvent = f.db
    .prepare(
      "SELECT from_state,to_state,payload_json FROM events WHERE aggregate_id=? AND type='repair_attempt.superseded'",
    )
    .get(legacy.id)!;
  assert.equal(legacyEvent.from_state, "in_progress");
  assert.equal(legacyEvent.to_state, "ready");
  assert.deepEqual(JSON.parse(String(legacyEvent.payload_json)), {
    status: "superseded",
    repairAttemptId: legacy.id,
    reason: "Legacy supersede reason",
    fromVersion: 1,
    toVersion: 2,
  });
  const attempt = f.plan(true),
    successorId = randomUUID();
  const before = getMobileBug(f.db, f.actor, attempt.bugId)!;
  const body = {
    expectedVersion: 2,
    reason: "Choose a distinct explicit successor",
    successor: {
      id: successorId,
      mode: "human",
      assigneeId: f.actor.actorId,
      summary: "New human plan",
    },
  };
  const result = await f.send(attempt, "supersede", body, { vendor: true });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(schemas.successor(result.body), true, JSON.stringify(schemas.successor.errors));
  assert.equal(result.body.supersededAttempt!.summary, body.reason);
  assert.equal(result.body.successorAttempt!.parentAttemptId, attempt.id);
  assert.equal(result.body.successorAttempt!.sequence, 2);
  assert.equal(result.body.successorAttempt!.version, 1);
  assert.equal(result.body.bug!.version, before.version + 1);
  assert.equal(result.body.bug!.state, "in_progress");
  const vendorEvent = f.db
    .prepare(
      "SELECT from_state,to_state,payload_json FROM events WHERE aggregate_id=? AND type='repair_attempt.superseded'",
    )
    .get(attempt.id)!;
  assert.equal(vendorEvent.from_state, null);
  assert.equal(vendorEvent.to_state, null);
  assert.deepEqual(JSON.parse(String(vendorEvent.payload_json)), {
    status: "superseded",
    repairAttemptId: attempt.id,
    reason: body.reason,
    fromVersion: 2,
    toVersion: 3,
  });
  assert.equal(
    getTerminalRepairAttemptHistory(f.db, { ...f.actor, attemptId: attempt.id })!.summary,
    "Original human plan",
  );
  const state = f.snapshot();
  const replay = await f.send(attempt, "supersede", body, { vendor: true });
  assert.deepEqual(replay.body, { ...result.body, replayed: true });
  assert.deepEqual(f.snapshot(), state);
  const followup = await f.send({ id: successorId, version: 1 }, "fail", {
    expectedVersion: 1,
    reason: "Later state change",
  });
  assert.equal(followup.status, 200);
  const old = await f.send(attempt, "supersede", body, { vendor: true });
  assert.deepEqual(old.body, { ...result.body, replayed: true });
});

test("candidate real HTTP: rejected successors and old versions rollback every fact", async (t) => {
  const f = await fixture(t),
    attempt = f.plan();
  const base = {
    expectedVersion: 1,
    reason: "Atomic rollback",
    successor: { id: randomUUID(), mode: "human", assigneeId: f.actor.actorId },
  };
  for (const body of [
    { ...base, successor: { ...base.successor, id: attempt.id } },
    { ...base, successor: { ...base.successor, assigneeId: randomUUID() } },
    { ...base, expectedVersion: 9 },
  ]) {
    const before = f.snapshot();
    const result = await f.send({ ...attempt, version: body.expectedVersion }, "supersede", body, {
      vendor: true,
    });
    assert.equal(
      result.status,
      body.expectedVersion === 9 ? 412 : 422,
      JSON.stringify(result.body),
    );
    assert.deepEqual(f.snapshot(), before);
  }
  const before = f.snapshot();
  const cannotRepresent = await f.send(
    attempt,
    "supersede",
    { expectedVersion: 1, reason: "No successor in this representation" },
    { accept: MOBILE_API_MEDIA_TYPE },
  );
  assert.equal(cannotRepresent.status, 406);
  assert.deepEqual(f.snapshot(), before);
  const result = await f.send(attempt, "supersede", base, { vendor: true });
  assert.equal(result.status, 200);
});

test("candidate real HTTP: concurrent same key replays once; opposite actions have one winner", async (t) => {
  const f = await fixture(t),
    attempt = f.plan();
  const body = {
    expectedVersion: 1,
    reason: "Concurrent identical intent",
    successor: { id: randomUUID(), mode: "human", assigneeId: f.actor.actorId },
  };
  const replies = await Promise.all([
    f.send(attempt, "supersede", body, { vendor: true }),
    f.send(attempt, "supersede", body, { vendor: true }),
  ]);
  assert.deepEqual(
    replies.map((v) => v.status),
    [200, 200],
  );
  assert.deepEqual(replies.map((v) => v.body.replayed).sort(), [false, true]);
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE bug_id=? AND type='repair_attempt.superseded'",
      )
      .get(attempt.bugId)!.n,
    1,
  );
  const second = f.plan();
  const competing = await Promise.all([
    f.send(second, "fail", { expectedVersion: 1, reason: "Failed" }),
    f.send(second, "supersede", { expectedVersion: 1, reason: "Superseded" }),
  ]);
  assert.deepEqual(competing.map((v) => v.status).sort(), [200, 412]);
});

test("candidate real HTTP: replay reauthorizes revoked membership, wrong project and deleted Bug", async (t) => {
  const f = await fixture(t),
    attempt = f.plan();
  const body = { expectedVersion: 1, reason: "Current authorization on replay" };
  const result = await f.send(attempt, "fail", body);
  assert.equal(result.status, 200);
  const before = f.snapshot();
  const other = randomUUID();
  f.tx(() =>
    projectManagement(f.db, {
      ...f.scope,
      operation: "create",
      isGm: true,
      projectId: other,
      key: "OTHER",
      name: "Other isolated project",
      now: now(),
    }),
  );
  f.tx(() =>
    projectManagement(f.db, {
      ...f.scope,
      operation: "membership",
      isGm: true,
      projectId: f.actor.projectId,
      userId: f.actor.actorId,
      active: false,
      expectedVersion: 1,
      now: now(),
    }),
  );
  const disabled = await f.send(attempt, "fail", body);
  assert.equal(disabled.status, 403);
  const wrong = await f.send(attempt, "fail", body, { projectId: other });
  assert.equal(wrong.status, 403);
  f.tx(() =>
    projectManagement(f.db, {
      ...f.scope,
      operation: "membership",
      isGm: true,
      projectId: other,
      userId: f.actor.actorId,
      active: true,
      expectedVersion: 0,
      now: now(),
    }),
  );
  const wrongShared = await f.send(attempt, "fail", body, { projectId: other });
  assert.equal(wrongShared.status, 404);
  f.tx(() =>
    projectManagement(f.db, {
      ...f.scope,
      operation: "membership",
      isGm: true,
      projectId: f.actor.projectId,
      userId: f.actor.actorId,
      active: true,
      expectedVersion: 2,
      now: now(),
    }),
  );
  const restored = await f.send(attempt, "fail", body);
  assert.deepEqual(restored.body, result.body);
  const currentBug = getMobileBug(f.db, f.actor, attempt.bugId)!;
  f.tx(() =>
    deleteMobileBug(f.db, {
      ...f.actor,
      bugId: attempt.bugId,
      expectedVersion: currentBug.version,
      idempotencyKey: randomUUID(),
      requestDigest: digest("delete"),
      createdAt: now(),
    }),
  );
  const deleted = await f.send(attempt, "fail", body);
  assert.equal(deleted.status, 404);
  assert.equal(getTerminalRepairAttemptHistory(f.db, { ...f.actor, attemptId: attempt.id }), null);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM repair_attempt_terminal_snapshots").get()!.n,
    1,
  );
  assert.ok(before);
});

test("candidate immutable snapshot exceeds 64KiB with maximum multibyte reason/two summaries and complete Bug", async (t) => {
  const f = await fixture(t),
    attempt = f.plan(false, true);
  const body = {
    expectedVersion: 1,
    reason: "因".repeat(5000),
    successor: {
      id: randomUUID(),
      mode: "human",
      assigneeId: f.actor.actorId,
      summary: "继".repeat(10000),
    },
  };
  const result = await f.send(attempt, "supersede", body, { vendor: true });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const row = f.db
    .prepare(
      "SELECT length(CAST(response_json AS BLOB)) AS bytes FROM repair_attempt_terminal_snapshots",
    )
    .get()!;
  assert.ok(Number(row.bytes) > 65536);
  assert.equal(result.body.supersededAttempt!.summary, body.reason);
  assert.equal(result.body.successorAttempt!.summary, body.successor.summary);
  const eventReason = String(
    JSON.parse(
      String(
        f.db
          .prepare(
            "SELECT payload_json FROM events WHERE aggregate_id=? AND type='repair_attempt.superseded'",
          )
          .get(attempt.id)!.payload_json,
      ),
    ).reason,
  );
  assert.ok(Buffer.byteLength(eventReason, "utf8") <= 2000);
  assert.match(eventReason, /…$/u);
  const replay = await f.send(attempt, "supersede", body, { vendor: true });
  assert.deepEqual(replay.body, { ...result.body, replayed: true });
  assert.throws(
    () => f.db.exec("UPDATE repair_attempt_terminal_snapshots SET reason='overwrite'"),
    /immutable/,
  );
  assert.throws(() => f.db.exec("DELETE FROM repair_attempt_terminal_snapshots"), /retained/);
});

test("candidate legacy two-step HTTP requires latest exact parent, preserves original receipt and never dispatches", async (t) => {
  const f = await fixture(t),
    schemas = await validators();
  for (const mode of ["human", "relay", "external"]) {
    const old = f.plan();
    const terminal = await f.send(old, "supersede", {
      expectedVersion: 1,
      reason: "Legacy terminal reason",
    });
    assert.equal(terminal.status, 200);
    const bug = getMobileBug(f.db, f.actor, old.bugId)!;
    const body = {
      expectedVersion: bug.version,
      mode,
      assigneeId: f.actor.actorId,
      parentAttemptId: old.id,
      summary: "token=synthetic-user-entered-summary-preserved",
    };
    const before = f.snapshot();
    const missing = await f.createAfter(bug.id, { ...body, parentAttemptId: undefined });
    assert.equal(missing.status, 400);
    const wrong = await f.createAfter(bug.id, { ...body, parentAttemptId: randomUUID() });
    assert.equal(wrong.status, 422);
    assert.deepEqual(f.snapshot(), before);
    const created = await f.createAfter(bug.id, body);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(schemas.attempt(created.body), true, JSON.stringify(schemas.attempt.errors));
    assert.equal(created.body.parentAttemptId, old.id);
    assert.equal(created.body.mode, mode);
    assert.equal(created.body.summary, body.summary);
    assert.equal(created.body.sequence, 2);
    assert.equal(created.body.version, 1);
    const createdAttemptId = created.body.id;
    assert.ok(typeof createdAttemptId === "string");
    const createEvent = f.db
      .prepare(
        "SELECT from_state,to_state,payload_json FROM events WHERE aggregate_id=? AND type='repair_attempt.created'",
      )
      .get(createdAttemptId)!;
    assert.equal(createEvent.from_state, "ready");
    assert.equal(createEvent.to_state, "in_progress");
    assert.deepEqual(JSON.parse(String(createEvent.payload_json)), {
      status: "planned",
      repairAttemptId: createdAttemptId,
      fromVersion: bug.version,
      toVersion: bug.version + 1,
    });
    const after = f.snapshot();
    const replay = await f.createAfter(bug.id, body);
    assert.deepEqual(replay, created);
    assert.deepEqual(f.snapshot(), after);
    const oldReplay = await f.send(old, "supersede", {
      expectedVersion: 1,
      reason: "Legacy terminal reason",
    });
    assert.deepEqual(oldReplay.body, terminal.body);
  }
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM relay_receipts").get()!.n, 0);
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM outbox WHERE destination<>'qa-hub.notifications'")
      .get()!.n,
    0,
  );
});

test("candidate human Cookie+CSRF is required for legacy session writes and GM authorization is transaction-scoped", async (t) => {
  const f = await fixture(t),
    attempt = f.plan();
  const response = await fetch(f.origin + "/api/v1/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://terminal-fixture.local",
    },
    body: JSON.stringify({
      name: `WebTerminal${randomUUID()}`,
      projectId: f.actor.projectId,
      client: "web",
    }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const web = (await response.json()) as { csrfToken: string };
  const before = f.snapshot();
  const write = async (csrf?: string) => {
    const result = await fetch(`${f.origin}/api/v1/repair-attempts/${attempt.id}/fail`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://terminal-fixture.local",
        cookie,
        "x-qa-project-id": f.actor.projectId,
        "idempotency-key": "legacy-stable-arbitrary-key",
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      body: JSON.stringify({ expectedVersion: 1, reason: "Explicit web cookie command" }),
    });
    return { status: result.status, body: (await result.json()) as Record<string, unknown> };
  };
  assert.equal((await write()).status, 403);
  assert.deepEqual(f.snapshot(), before);
  assert.equal((await write(web.csrfToken)).status, 200);
  const gmAttempt = f.plan();
  f.tx(() =>
    projectManagement(f.db, {
      ...f.scope,
      operation: "membership",
      isGm: true,
      userId: f.scope.actorId,
      active: false,
      expectedVersion: 1,
      now: now(),
    }),
  );
  const gmResponse = await fetch(f.origin + "/api/v1/auth/gm/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: f.auth.gm.password, client: "android" }),
  });
  assert.equal(gmResponse.status, 200);
  const gm = (await gmResponse.json()) as { accessToken: string };
  const result = await f.send(
    gmAttempt,
    "fail",
    { expectedVersion: 1, reason: "GM without active project membership" },
    { token: gm.accessToken },
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM storage_command_authorizations").get()!.n,
    0,
  );
  assert.equal(
    f.db
      .prepare("SELECT status FROM memberships WHERE project_id=? AND user_id=?")
      .get(f.scope.projectId, f.scope.actorId)!.status,
    "revoked",
  );
});

test("candidate immutable snapshot rejects insertion with copied metadata and forged facts", async (t) => {
  const f = await fixture(t),
    attempt = f.plan();
  const result = await f.send(attempt, "supersede", {
    expectedVersion: 1,
    reason: "Original exact reason",
  });
  assert.equal(result.status, 200);
  const row = f.db.prepare("SELECT * FROM repair_attempt_terminal_snapshots").get() as Record<
    string,
    unknown
  >;
  // A duplicate immutable record must fail, even if an adversary copies valid receipt/effect metadata.
  for (const field of ["reason", "summary"]) {
    const copied = { ...row, id: randomUUID() } as Record<string, SQLInputValue>;
    const response = JSON.parse(String(row["response_json"])) as {
      reason: string;
      attempt: { summary: string | null };
    };
    if (field === "reason") {
      copied["reason"] = "Another reason";
      response["reason"] = String(copied["reason"]);
    } else response.attempt.summary = "Invented history";
    copied["response_json"] = JSON.stringify(response);
    const before = f.snapshot();
    assert.throws(
      () =>
        f.tx(() =>
          f.db
            .prepare(
              `INSERT INTO repair_attempt_terminal_snapshots(${Object.keys(copied).join(",")}) VALUES(${Object.keys(
                copied,
              )
                .map(() => "?")
                .join(",")})`,
            )
            .run(...Object.values(copied)),
        ),
      /snapshot|UNIQUE/,
    );
    assert.deepEqual(f.snapshot(), before);
  }
});

test("candidate late snapshot failure rolls back Attempt/Bug/successor/audit/outbox/receipt, then original request succeeds", async (t) => {
  const f = await fixture(t),
    attempt = f.plan();
  const body = {
    expectedVersion: 1,
    reason: "Snapshot failure after the typed effect",
    successor: {
      id: randomUUID(),
      mode: "human",
      assigneeId: f.actor.actorId,
      summary: "Preserve intent",
    },
  };
  const before = f.snapshot();
  // Add only a fixture failpoint; every product invariant trigger remains enabled.
  f.db.exec(
    "CREATE TRIGGER fixture_terminal_snapshot_failure BEFORE INSERT ON repair_attempt_terminal_snapshots BEGIN SELECT RAISE(ABORT,'fixture durable snapshot failure'); END;",
  );
  const failed = await f.send(attempt, "supersede", body, { vendor: true });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, "INTERNAL_ERROR");
  assert.deepEqual(f.snapshot(), before);
  f.db.exec("DROP TRIGGER fixture_terminal_snapshot_failure");
  const success = await f.send(attempt, "supersede", body, { vendor: true });
  assert.equal(success.status, 200);
  assert.equal(success.body.successorAttempt!.id, body.successor.id);
});

test("candidate delivered and already-terminal history refuses fresh mutations", async (t) => {
  const f = await fixture(t),
    attempt = f.plan(true);
  const delivered = f.tx(() =>
    deliverMobileRepairAttempt(f.db, {
      ...f.actor,
      attemptId: attempt.id,
      expectedVersion: 2,
      idempotencyKey: randomUUID(),
      requestDigest: digest("delivery"),
      createdAt: now(),
      summary: "No code needed",
      deliveryKind: "no_code",
      noCodeReason: "Human resolution",
      branch: null,
      commitSha: null,
      mergeRequestUrl: null,
      patchUrl: null,
    }),
  );
  const before = f.snapshot();
  for (const suffix of ["fail", "supersede"] as const) {
    const result = await f.send(delivered, suffix, {
      expectedVersion: delivered.version,
      reason: "Do not mutate delivered history",
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "INVALID_TRANSITION");
    assert.deepEqual(f.snapshot(), before);
  }
  const fresh = f.plan();
  assert.equal(
    (await f.send(fresh, "fail", { expectedVersion: 1, reason: "First terminal outcome" })).status,
    200,
  );
  const ended = f.snapshot();
  assert.equal(
    (
      await f.send({ ...fresh, version: 2 }, "supersede", {
        expectedVersion: 2,
        reason: "Do not overwrite failed history",
      })
    ).status,
    409,
  );
  assert.deepEqual(f.snapshot(), ended);
});

test("candidate explicit JSON/vendor media preference is separate from successor command semantics", async (t) => {
  const f = await fixture(t);
  const cases = [
    { accept: MOBILE_API_MEDIA_TYPE, status: 200, vendorResult: true },
    { accept: "application/json", status: 200, vendorResult: false },
    {
      accept: `application/json;q=0.4,${MOBILE_API_MEDIA_TYPE};q=0.8`,
      status: 200,
      vendorResult: true,
    },
    {
      accept: `${MOBILE_API_MEDIA_TYPE};q=0.4,application/json;q=0.8`,
      status: 200,
      vendorResult: false,
    },
    {
      accept: `${MOBILE_API_MEDIA_TYPE};q=0,application/json;q=0`,
      status: 406,
      vendorResult: false,
    },
    { accept: "text/plain", status: 406, vendorResult: false },
  ];
  for (const item of cases) {
    const attempt = f.plan(),
      before = f.snapshot();
    const body = {
      expectedVersion: 1,
      reason: "Media does not change an explicit successor",
      successor: {
        id: randomUUID(),
        mode: "human",
        assigneeId: f.actor.actorId,
      },
    };
    const result = await f.send(attempt, "supersede", body, { vendor: true, accept: item.accept });
    assert.equal(result.status, item.status);
    if (item.status === 406) assert.deepEqual(f.snapshot(), before);
    else {
      assert.equal(Boolean(result.body.successorAttempt), item.vendorResult);
      assert.equal(
        f.db.prepare("SELECT active_repair_attempt_id FROM bugs WHERE id=?").get(attempt.bugId)!
          .active_repair_attempt_id,
        body.successor.id,
      );
    }
  }
});

test("candidate replay preserves the originally negotiated HTTP receipt across later Accept headers", async (t) => {
  const f = await fixture(t),
    attempt = f.plan();
  const body = {
    expectedVersion: 1,
    reason: "Persist the first negotiated representation",
    successor: {
      id: randomUUID(),
      mode: "human",
      assigneeId: f.actor.actorId,
      summary: "One durable successor",
    },
  };
  const first = await f.send(attempt, "supersede", body, {
    vendor: true,
    accept: "application/json",
  });
  assert.equal(first.status, 200);
  assert.match(first.contentType!, /^application\/json\b/u);
  assert.equal(first.body.id, attempt.id);
  assert.equal(first.body.successorAttempt, undefined);
  const idempotencyKey = `workflow:supersedeRepairAttempt:attempt:${attempt.id}:v1`;
  const snapshot = f.db
    .prepare("SELECT request_digest FROM repair_attempt_terminal_snapshots WHERE attempt_id=?")
    .get(attempt.id)!;
  assert.equal(
    snapshot.request_digest,
    canonicalWorkflowRequestDigest(
      "supersedeRepairAttempt",
      {
        accountId: f.actor.accountId,
        actorId: f.actor.actorId,
        projectId: f.actor.projectId,
        bugId: attempt.bugId,
        attemptId: attempt.id,
        verificationId: null,
      },
      body,
      idempotencyKey,
    ),
  );
  const state = f.snapshot();
  const replay = await f.send(attempt, "supersede", body, {
    vendor: true,
    accept: MOBILE_API_MEDIA_TYPE,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.contentType, first.contentType);
  assert.deepEqual(replay.body, first.body);
  assert.deepEqual(f.snapshot(), state);
});
