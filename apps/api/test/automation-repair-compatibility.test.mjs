import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteStorageWorker, projectMembershipId } from "@relay-qa-hub/storage";
import Fastify from "fastify";

import { createApiApp } from "../dist/app.js";
import { AUTOMATION_TOOLS, registerAutomationRoutes } from "../dist/automation.js";
import { createSqliteBrowserAuthStore } from "../dist/browser-auth.js";
import { ProjectManagementService } from "../dist/project-management.js";
import { ProjectRequestContext } from "../dist/project-request-context.js";
import { createSqliteMobileBugStore } from "../dist/sqlite-mobile-bug-store.js";
import { createSqliteMobileHumanWorkflowStore } from "../dist/sqlite-mobile-human-workflow-store.js";
import { createSqliteMobileProjectDirectoryStore } from "../dist/sqlite-mobile-project-directory-store.js";
import { createSqliteMobileRelayStore } from "../dist/sqlite-mobile-relay-store.js";
import { createSqliteRepairAttemptTerminalStore } from "../dist/sqlite-repair-attempt-terminal-store.js";

const PROJECT_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_PROJECT_ID = "30000000-0000-4000-8000-000000000002";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
const BUG_ID = "20000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "40000000-0000-4000-8000-000000000001";
const COMMIT_SHA = "a".repeat(40);

function runningAttempt(overrides = {}) {
  return {
    id: ATTEMPT_ID,
    bugId: BUG_ID,
    sequence: 1,
    mode: "human",
    status: "running",
    assigneeId: USER_ID,
    parentAttemptId: null,
    summary: "[MCP] Repair the compatibility flow",
    branch: null,
    commitSha: null,
    mergeRequestUrl: null,
    patchUrl: null,
    targetBuildId: null,
    version: 2,
    ...overrides,
  };
}

async function fixture(t, options = {}) {
  const app = Fastify({ logger: false });
  const state = {
    revoked: false,
    principalProjectId: options.principalProjectId ?? PROJECT_ID,
    loseAfterClaim: options.loseAfterClaim,
    loseAfterAction: options.loseAfterAction,
    conflictAction: options.conflictAction,
    bug: {
      id: BUG_ID,
      projectId: PROJECT_ID,
      key: "COMPAT-1",
      state: options.bugState ?? "reported",
      ownerId: options.ownerId ?? null,
      version: options.bugVersion ?? 1,
    },
    attempt: options.attempt ?? null,
  };
  const writes = [];
  const reads = [];

  const authorized = (request, reply) => {
    if (state.revoked || request.headers.authorization !== "Bearer active-session") {
      reply.code(401).send({ code: "UNAUTHENTICATED" });
      return false;
    }
    return true;
  };
  const projectAuthorized = (request, reply) => {
    if (!authorized(request, reply)) return false;
    if (request.headers["x-qa-project-id"] !== PROJECT_ID) {
      reply.code(403).send({ code: "FORBIDDEN" });
      return false;
    }
    return true;
  };

  app.get("/api/v1/auth/me", async (request, reply) => {
    reads.push("me");
    if (!authorized(request, reply)) return reply;
    const principal = {
      accountId: randomUUID(),
      userId: USER_ID,
      displayName: "Compatibility fixer",
      email: "compatibility@example.invalid",
      projectId: state.principalProjectId,
      isGm: false,
      csrfToken: "fixture",
    };
    if (options.omitPrincipalProjectId) delete principal.projectId;
    return principal;
  });
  app.get("/api/v1/bugs/:bugId/human-workflow", async (request, reply) => {
    reads.push("workflow");
    if (!projectAuthorized(request, reply)) return reply;
    if (request.params.bugId !== BUG_ID) return reply.code(404).send({ code: "NOT_FOUND" });
    return {
      bugId: BUG_ID,
      repairAttempt: state.attempt,
      buildRequirement: null,
      build: null,
      verification: null,
      latestVerification: null,
    };
  });
  app.get("/api/v1/bugs/:bugId", async (request, reply) => {
    reads.push("bug");
    if (!projectAuthorized(request, reply)) return reply;
    if (request.params.bugId !== BUG_ID) return reply.code(404).send({ code: "NOT_FOUND" });
    return state.bug;
  });
  app.get("/api/v1/repair-attempts/:attemptId", async (request, reply) => {
    reads.push("attempt");
    if (!projectAuthorized(request, reply)) return reply;
    if (!state.attempt || request.params.attemptId !== state.attempt.id)
      return reply.code(404).send({ code: "NOT_FOUND" });
    return state.attempt;
  });
  app.patch("/api/v1/bugs/:bugId", async (request, reply) => {
    if (!projectAuthorized(request, reply)) return reply;
    writes.push({ kind: "claim", key: request.headers["idempotency-key"], body: request.body });
    if (request.body.expectedVersion !== state.bug.version)
      return reply.code(412).send({ code: "VERSION_CONFLICT" });
    state.bug = { ...state.bug, ownerId: request.body.ownerId, version: state.bug.version + 1 };
    if (state.loseAfterClaim) {
      state.loseAfterClaim = false;
      return reply.code(503).send({ code: "TEMPORARY_FAILURE" });
    }
    return state.bug;
  });
  app.post("/api/v1/projects/:projectId/bugs/:bugId/actions", async (request, reply) => {
    if (!projectAuthorized(request, reply)) return reply;
    if (request.params.projectId !== PROJECT_ID || request.params.bugId !== BUG_ID)
      return reply.code(404).send({ code: "NOT_FOUND" });
    const { action, expectedVersion, request: payload = {}, attemptId } = request.body;
    writes.push({ kind: action, key: request.headers["idempotency-key"], body: request.body });
    if (state.conflictAction === action) return reply.code(409).send({ code: "VERSION_CONFLICT" });
    let result;
    if (action === "ready") {
      if (expectedVersion !== state.bug.version || state.bug.state !== "reported")
        return reply.code(409).send({ code: "VERSION_CONFLICT" });
      state.bug = { ...state.bug, state: "ready", version: state.bug.version + 1 };
      result = state.bug;
    } else if (action === "plan_fix") {
      if (expectedVersion !== state.bug.version || state.bug.state !== "ready")
        return reply.code(409).send({ code: "VERSION_CONFLICT" });
      state.attempt = {
        ...runningAttempt(),
        status: "planned",
        assigneeId: payload.assigneeId,
        summary: payload.summary,
        version: 1,
      };
      state.bug = { ...state.bug, state: "in_progress", version: state.bug.version + 1 };
      result = state.attempt;
    } else if (action === "begin_fix") {
      if (
        !state.attempt ||
        attemptId !== state.attempt.id ||
        expectedVersion !== state.attempt.version ||
        state.attempt.status !== "planned"
      )
        return reply.code(409).send({ code: "VERSION_CONFLICT" });
      state.attempt = { ...state.attempt, status: "running", version: state.attempt.version + 1 };
      result = state.attempt;
    } else if (action === "submit_fix") {
      if (
        !state.attempt ||
        attemptId !== state.attempt.id ||
        expectedVersion !== state.attempt.version ||
        state.attempt.status !== "running"
      )
        return reply.code(409).send({ code: "VERSION_CONFLICT" });
      state.attempt = {
        ...state.attempt,
        status: "delivered",
        summary: payload.summary,
        branch: payload.branch,
        commitSha: payload.commitSha,
        mergeRequestUrl: payload.mergeRequestUrl ?? null,
        patchUrl: payload.patchUrl ?? null,
        version: state.attempt.version + 1,
      };
      state.bug = { ...state.bug, state: "awaiting_build", version: state.bug.version + 1 };
      result = state.attempt;
    } else {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    if (state.loseAfterAction === action) {
      state.loseAfterAction = undefined;
      return reply.code(503).send({ code: "TEMPORARY_FAILURE" });
    }
    return { action, projectId: PROJECT_ID, bugId: BUG_ID, result, bug: state.bug };
  });

  registerAutomationRoutes(app, "https://api.fixture.invalid");
  t.after(() => app.close());
  const rpc = async (name, argumentsValue, authorization = "Bearer active-session") => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json", authorization },
      payload: {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name, arguments: argumentsValue },
      },
    });
    assert.equal(response.statusCode, 200);
    return response.json().result;
  };
  const value = (result) => result.structuredContent ?? JSON.parse(result.content[0].text);
  return { app, state, writes, reads, rpc, value };
}

test("shared catalog exposes strict retry-safe repair compatibility aliases", async (t) => {
  const f = await fixture(t);
  const catalog = (await f.app.inject({ method: "GET", url: "/api/v1/mcp/tools" })).json().tools;
  assert.deepEqual(catalog, AUTOMATION_TOOLS);
  assert.equal(catalog.length, 96);
  const begin = catalog.find((tool) => tool.name === "qa_begin_fix");
  const submit = catalog.find((tool) => tool.name === "qa_submit_fix");
  assert.deepEqual(begin.inputSchema.required, ["projectId", "bugId", "summary", "idempotencyKey"]);
  assert.deepEqual(
    Object.keys(begin.inputSchema.properties).sort(),
    begin.inputSchema.required.toSorted(),
  );
  assert.equal(begin.inputSchema.additionalProperties, false);
  assert.equal(begin.annotations.idempotentHint, true);
  assert.deepEqual(submit.inputSchema.required, [
    "projectId",
    "attemptId",
    "summary",
    "validation",
    "branch",
    "commitSha",
    "idempotencyKey",
  ]);
  assert.deepEqual(
    Object.keys(submit.inputSchema.properties).sort(),
    [...submit.inputSchema.required, "mergeRequestUrl", "patchUrl"].sort(),
  );
  assert.equal(submit.inputSchema.additionalProperties, false);
  assert.equal(submit.annotations.idempotentHint, true);
});

test("qa_begin_fix claims, readies, plans and starts once, then resumes the persisted attempt", async (t) => {
  const f = await fixture(t);
  const input = {
    projectId: PROJECT_ID,
    bugId: BUG_ID,
    summary: "Repair the compatibility flow",
    idempotencyKey: "c".repeat(200),
  };
  const first = await f.rpc("qa_begin_fix", input);
  assert.equal(first.isError, false);
  assert.equal(first.structuredContent.repairAttempt.status, "running");
  assert.equal(first.structuredContent.resumed, false);
  assert.deepEqual(
    f.writes.map(({ kind }) => kind),
    ["claim", "ready", "plan_fix", "begin_fix"],
  );
  const digest = createHash("sha256")
    .update(`qa_begin_fix\0${input.idempotencyKey}`, "utf8")
    .digest("hex");
  assert.deepEqual(
    f.writes.map(({ key }) => key),
    ["claim", "ready", "plan", "start"].map((stage) => `mcp:qa_begin_fix:${stage}:${digest}`),
  );
  assert.equal(new Set(f.writes.map(({ key }) => key)).size, 4);
  assert.ok(f.writes.every(({ key }) => key.length <= 255));
  assert.equal(
    f.writes.find(({ kind }) => kind === "plan_fix").body.request.summary,
    `[MCP] ${input.summary}`,
  );
  const replay = await f.rpc("qa_begin_fix", input);
  assert.equal(replay.isError, false);
  assert.equal(replay.structuredContent.resumed, true);
  assert.equal(f.writes.length, 4);
  assert.equal(f.state.attempt.id, ATTEMPT_ID);
});

test("qa_begin_fix resumes after every persisted stage without creating another RepairAttempt", async (t) => {
  for (const [stage, options] of [
    ["claim", { loseAfterClaim: true }],
    ["ready", { loseAfterAction: "ready" }],
    ["plan", { loseAfterAction: "plan_fix" }],
    ["start", { loseAfterAction: "begin_fix" }],
  ]) {
    const f = await fixture(t, options);
    const input = {
      projectId: PROJECT_ID,
      bugId: BUG_ID,
      summary: "Repair the compatibility flow",
      idempotencyKey: `caller-begin-fix-lost-${stage}`,
    };
    const lost = await f.rpc("qa_begin_fix", input);
    assert.equal(lost.isError, true, stage);
    assert.equal(f.value(lost).code, "TEMPORARY_FAILURE", stage);
    const resumed = await f.rpc("qa_begin_fix", input);
    assert.equal(resumed.isError, false, stage);
    assert.equal(f.writes.filter(({ kind }) => kind === "claim").length, 1, stage);
    assert.equal(f.writes.filter(({ kind }) => kind === "ready").length, 1, stage);
    assert.equal(f.writes.filter(({ kind }) => kind === "plan_fix").length, 1, stage);
    assert.equal(f.writes.filter(({ kind }) => kind === "begin_fix").length, 1, stage);
    assert.equal(f.state.attempt.id, ATTEMPT_ID, stage);
    assert.equal(f.state.attempt.status, "running", stage);
  }
});

test("qa_begin_fix refuses another owner or assignee and rejects same-key changed intent", async (t) => {
  const owned = await fixture(t, { ownerId: OTHER_USER_ID });
  const input = {
    projectId: PROJECT_ID,
    bugId: BUG_ID,
    summary: "Repair the compatibility flow",
    idempotencyKey: "caller-begin-fix-owner",
  };
  const ownerResult = await owned.rpc("qa_begin_fix", input);
  assert.equal(ownerResult.isError, true);
  assert.equal(owned.value(ownerResult).code, "BUG_ASSIGNED_TO_OTHER_USER");
  assert.equal(owned.writes.length, 0);

  const assigned = await fixture(t, {
    bugState: "in_progress",
    ownerId: USER_ID,
    attempt: runningAttempt({ assigneeId: OTHER_USER_ID }),
  });
  const assigneeResult = await assigned.rpc("qa_begin_fix", input);
  assert.equal(assigneeResult.isError, true);
  assert.equal(assigned.value(assigneeResult).code, "BUG_ASSIGNED_TO_OTHER_USER");
  assert.equal(assigned.writes.length, 0);

  const changed = await fixture(t, {
    bugState: "in_progress",
    ownerId: USER_ID,
    attempt: runningAttempt(),
  });
  const changedResult = await changed.rpc("qa_begin_fix", {
    ...input,
    summary: "A different repair intent",
  });
  assert.equal(changedResult.isError, true);
  assert.equal(changed.value(changedResult).code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
  assert.equal(changed.writes.length, 0);
});

test("qa_submit_fix submits the local-MCP validation audit and replays only an identical delivery", async (t) => {
  const f = await fixture(t, {
    bugState: "in_progress",
    ownerId: USER_ID,
    bugVersion: 4,
    attempt: runningAttempt(),
  });
  const input = {
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    summary: "Fixed the compatibility flow",
    validation: ["node --test focused: passed", "typecheck: passed"],
    branch: "codex/compatibility-flow",
    commitSha: COMMIT_SHA,
    mergeRequestUrl: "https://example.invalid/merge/1",
    patchUrl: "https://example.invalid/patch/1",
    idempotencyKey: "caller-submit-fix-1",
  };
  const result = await f.rpc("qa_submit_fix", input);
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.repairAttempt.status, "delivered");
  assert.equal(result.structuredContent.replayed, false);
  assert.match(
    result.structuredContent.nextAction,
    /active member of the same project.*formal Verification workflow.*attribution, not an authorization role/su,
  );
  assert.doesNotMatch(result.structuredContent.nextAction, /without identity/iu);
  const delivery = f.writes.find(({ kind }) => kind === "submit_fix");
  assert.equal(
    delivery.key,
    `mcp:qa_submit_fix:deliver:${createHash("sha256")
      .update(`qa_submit_fix\0${input.idempotencyKey}`, "utf8")
      .digest("hex")}`,
  );
  assert.ok(delivery.key.length <= 255);
  assert.equal(
    delivery.body.request.summary,
    `${input.summary}\n\n验证（由本地 AI 编辑器报告，QA Hub 未独立复验）：\n- ${input.validation[0]}\n- ${input.validation[1]}`,
  );
  const replay = await f.rpc("qa_submit_fix", input);
  assert.equal(replay.isError, false);
  assert.equal(replay.structuredContent.replayed, true);
  assert.equal(f.writes.filter(({ kind }) => kind === "submit_fix").length, 1);

  const differentCommit = await f.rpc("qa_submit_fix", { ...input, commitSha: "b".repeat(40) });
  assert.equal(differentCommit.isError, true);
  assert.equal(f.value(differentCommit).code, "REPAIR_ALREADY_DELIVERED");
  const differentPayload = await f.rpc("qa_submit_fix", { ...input, summary: "Changed summary" });
  assert.equal(differentPayload.isError, true);
  assert.equal(f.value(differentPayload).code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
});

test("qa_submit_fix recovers an identical committed delivery after its response is lost", async (t) => {
  const f = await fixture(t, {
    bugState: "in_progress",
    ownerId: USER_ID,
    attempt: runningAttempt(),
    loseAfterAction: "submit_fix",
  });
  const input = {
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    summary: "Fixed the compatibility flow",
    validation: ["focused test passed"],
    branch: "codex/compatibility-flow",
    commitSha: COMMIT_SHA,
    idempotencyKey: "caller-submit-fix-lost-response",
  };
  const lost = await f.rpc("qa_submit_fix", input);
  assert.equal(lost.isError, true);
  assert.equal(f.value(lost).code, "TEMPORARY_FAILURE");
  const recovered = await f.rpc("qa_submit_fix", input);
  assert.equal(recovered.isError, false);
  assert.equal(recovered.structuredContent.replayed, true);
  assert.equal(f.writes.filter(({ kind }) => kind === "submit_fix").length, 1);
});

test("repair compatibility aliases enforce strict input, project, auth, revocation and stale writes", async (t) => {
  const invalid = await fixture(t);
  const begin = {
    projectId: PROJECT_ID,
    bugId: BUG_ID,
    summary: "Repair",
    idempotencyKey: "caller-strict",
  };
  const submit = {
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    summary: "Repair",
    validation: ["focused test passed"],
    branch: "codex/repair",
    commitSha: COMMIT_SHA,
    idempotencyKey: "caller-submit-strict",
  };
  for (const [name, value] of [
    ["qa_begin_fix", { ...begin, extra: true }],
    ["qa_begin_fix", { ...begin, bugId: "not-a-uuid" }],
    ["qa_begin_fix", { ...begin, idempotencyKey: "" }],
    ["qa_submit_fix", { ...submit, validation: [] }],
    ["qa_submit_fix", { ...submit, commitSha: COMMIT_SHA.toUpperCase() }],
    ["qa_submit_fix", { ...submit, patchUrl: "file:///tmp/patch" }],
  ]) {
    const result = await invalid.rpc(name, value);
    assert.equal(result.isError, true);
    assert.equal(invalid.value(result).code, "INVALID_REQUEST");
  }
  assert.equal(invalid.writes.length, 0);

  const project = await fixture(t, { principalProjectId: OTHER_PROJECT_ID });
  const mismatch = await project.rpc("qa_begin_fix", begin);
  assert.equal(mismatch.isError, true);
  assert.equal(project.value(mismatch).code, "PROJECT_MISMATCH");
  assert.equal(project.writes.length, 0);

  for (const options of [{ omitPrincipalProjectId: true }, { principalProjectId: "not-a-uuid" }]) {
    const malformedPrincipal = await fixture(t, options);
    const rejected = await malformedPrincipal.rpc("qa_begin_fix", begin);
    assert.equal(rejected.isError, true);
    assert.equal(malformedPrincipal.value(rejected).code, "INVALID_RESPONSE");
    assert.deepEqual(malformedPrincipal.reads, ["me"]);
    assert.equal(malformedPrincipal.writes.length, 0);
  }

  const auth = await fixture(t);
  const unauthenticated = await auth.rpc("qa_begin_fix", begin, "Bearer invalid");
  assert.equal(unauthenticated.isError, true);
  assert.equal(auth.value(unauthenticated).code, "UNAUTHENTICATED");
  auth.state.revoked = true;
  const revoked = await auth.rpc("qa_begin_fix", begin);
  assert.equal(revoked.isError, true);
  assert.equal(auth.value(revoked).code, "UNAUTHENTICATED");
  assert.equal(auth.writes.length, 0);

  const stale = await fixture(t, { conflictAction: "ready" });
  const conflict = await stale.rpc("qa_begin_fix", begin);
  assert.equal(conflict.isError, true);
  assert.equal(stale.value(conflict).code, "VERSION_CONFLICT");
  assert.deepEqual(
    stale.writes.map(({ kind }) => kind),
    ["claim", "ready"],
  );
});

test("actual API and schema20 persist one repair flow and enforce assignee, project and revoked membership", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qa-automation-repair-compatibility-"));
  const worker = new SqliteStorageWorker({
    databaseFile: join(directory, "fixture.sqlite"),
    backupRoot: join(directory, "backups"),
    busyTimeoutMs: 5_000,
  });
  const accountId = randomUUID();
  const gmUserId = randomUUID();
  const projectId = randomUUID();
  const bootstrap = {
    accountId,
    actorId: gmUserId,
    projectId,
    membershipId: projectMembershipId(projectId, gmUserId),
    projectKey: "MCPCOMPAT",
    actorDisplayName: "Compatibility GM",
    createdAt: new Date().toISOString(),
  };
  let app;
  try {
    await worker.ensureMobileScope(bootstrap);
    const service = new ProjectManagementService({ worker, accountId, gmUserId });
    const context = new ProjectRequestContext();
    const scope = context.scope(bootstrap);
    app = createApiApp({
      logger: false,
      isolateLegacyComponents: true,
      projectManagementService: service,
      projectRequestContext: context,
      automationPublicApiOrigin: "https://api.fixture.invalid",
      mobileBugStore: createSqliteMobileBugStore({ worker, scope }),
      mobileHumanWorkflowStore: createSqliteMobileHumanWorkflowStore({ worker, scope }),
      mobileProjectDirectoryStore: createSqliteMobileProjectDirectoryStore({
        worker,
        scope,
        gmUserId,
      }),
      mobileRelayStore: createSqliteMobileRelayStore({
        worker,
        scope,
        relayDispatchEnabled: false,
      }),
      terminalAttemptStore: createSqliteRepairAttemptTerminalStore({ worker }),
      browserAuth: {
        store: createSqliteBrowserAuthStore({ worker }),
        accountId,
        userId: gmUserId,
        actorId: gmUserId,
        adminEmail: "compatibility-gm@example.invalid",
        passwordlessLogin: async () => {
          throw Error("Project required");
        },
        projectLogin: (name, selectedProjectId, stamp) =>
          service.login(name, selectedProjectId, stamp),
        sessionSecret: "isolated-automation-repair-compatibility-secret",
        webOrigins: [],
        gm: { userId: gmUserId, password: "isolated-automation-repair-gm" },
      },
    });
    await app.ready();
    const login = async (name) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { "content-type": "application/json" },
        payload: { projectId, name, client: "android" },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const call = async (token, name, argumentsValue) => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        payload: {
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "tools/call",
          params: { name, arguments: argumentsValue },
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json().result;
      return {
        result,
        value: result.structuredContent ?? JSON.parse(result.content[0].text),
      };
    };
    const employee = await login("Compatibility Employee");
    const otherEmployee = await login("Compatibility Other Employee");
    const createBug = (label) =>
      worker.createMobileBug({
        accountId,
        projectId,
        actorId: employee.userId,
        clientSubmissionId: randomUUID(),
        payloadDigest: createHash("sha256").update(label).digest("hex"),
        title: label,
        description: "Compatibility alias integration fixture",
        expectedBehavior: "One durable human RepairAttempt",
        severity: "S2",
        priority: "P2",
        ownerId: null,
        verificationOwnerId: employee.userId,
        occurrence: {
          observedAt: new Date().toISOString(),
          platform: "web",
          steps: ["Call the compatibility alias"],
          actualBehavior: "The fixture reaches the formal workflow store",
        },
        attachmentIds: [],
        captureBundleId: null,
        createdAt: new Date().toISOString(),
      });
    const created = await createBug("Actual compatibility flow");
    const revokedFixture = await createBug("Revoked compatibility flow");
    const beginInput = {
      projectId,
      bugId: created.bug.id,
      summary: "Repair the actual compatibility flow",
      idempotencyKey: `mcp-compat-begin-${randomUUID()}`,
    };
    const begun = await call(employee.accessToken, "qa_begin_fix", beginInput);
    assert.equal(begun.result.isError, false, JSON.stringify(begun.value));
    assert.equal(begun.value.bug.ownerId, employee.userId);
    assert.equal(begun.value.repairAttempt.status, "running");
    assert.equal(begun.value.repairAttempt.assigneeId, employee.userId);
    const replayedBegin = await call(employee.accessToken, "qa_begin_fix", beginInput);
    assert.equal(replayedBegin.result.isError, false, JSON.stringify(replayedBegin.value));
    assert.equal(replayedBegin.value.resumed, true);
    assert.equal(replayedBegin.value.repairAttempt.id, begun.value.repairAttempt.id);
    const changedBegin = await call(employee.accessToken, "qa_begin_fix", {
      ...beginInput,
      summary: "Changed caller intent",
    });
    assert.equal(changedBegin.result.isError, true);
    assert.equal(changedBegin.value.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");

    const submitInput = {
      projectId,
      attemptId: begun.value.repairAttempt.id,
      summary: "Implemented the actual compatibility flow",
      validation: ["focused API integration: passed"],
      branch: "codex/actual-compatibility-flow",
      commitSha: COMMIT_SHA,
      idempotencyKey: `mcp-compat-submit-${randomUUID()}`,
    };
    const denied = await call(otherEmployee.accessToken, "qa_submit_fix", submitInput);
    assert.equal(denied.result.isError, true);
    assert.equal(denied.value.code, "REPAIR_ASSIGNED_TO_OTHER_USER");
    const submitted = await call(employee.accessToken, "qa_submit_fix", submitInput);
    assert.equal(submitted.result.isError, false, JSON.stringify(submitted.value));
    assert.equal(submitted.value.repairAttempt.status, "delivered");
    assert.equal(submitted.value.bug.state, "awaiting_build");
    assert.match(
      submitted.value.repairAttempt.summary,
      /QA Hub 未独立复验.*focused API integration: passed/su,
    );
    const replayedSubmit = await call(employee.accessToken, "qa_submit_fix", submitInput);
    assert.equal(replayedSubmit.result.isError, false, JSON.stringify(replayedSubmit.value));
    assert.equal(replayedSubmit.value.replayed, true);
    const changedCommit = await call(employee.accessToken, "qa_submit_fix", {
      ...submitInput,
      commitSha: "b".repeat(40),
    });
    assert.equal(changedCommit.result.isError, true);
    assert.equal(changedCommit.value.code, "REPAIR_ALREADY_DELIVERED");

    await service.execute(
      {
        accountId,
        userId: gmUserId,
        actorId: gmUserId,
        email: "compatibility-gm@example.invalid",
        displayName: "Compatibility GM",
        isGm: true,
      },
      {
        operation: "membership",
        projectId,
        userId: employee.userId,
        active: false,
        expectedVersion: 1,
      },
    );
    const revoked = await call(employee.accessToken, "qa_begin_fix", {
      ...beginInput,
      bugId: revokedFixture.bug.id,
      idempotencyKey: `mcp-compat-revoked-${randomUUID()}`,
    });
    assert.equal(revoked.result.isError, true);
    assert.equal(revoked.value.code, "PROJECT_NOT_ACCESSIBLE");
    const revokedBug = await worker.getMobileBug({
      accountId,
      projectId,
      actorId: gmUserId,
      bugId: revokedFixture.bug.id,
    });
    assert.equal(revokedBug.ownerId, null);
    assert.equal(revokedBug.state, "reported");
  } finally {
    await app?.close();
    await worker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
