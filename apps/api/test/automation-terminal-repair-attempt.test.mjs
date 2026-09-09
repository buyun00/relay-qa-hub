import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { AUTOMATION_TOOLS, registerAutomationRoutes } from "../dist/automation.js";
import { registerTerminalRepairAttemptRoutes } from "../dist/repair-attempt-terminal.js";

const VENDOR_MEDIA_TYPE = "application/vnd.relay-qa-hub.v1.1+json";
const PROJECT_ID = "30000000-0000-4000-8000-000000000001";
const ACTOR_ID = "10000000-0000-4000-8000-000000000003";
const ATTEMPT_ID = "40000000-0000-4000-8000-000000000001";
const SUCCESSOR_ID = "40000000-0000-4000-8000-000000000002";
const BUG_ID = "20000000-0000-4000-8000-000000000001";
const VERIFICATION_ID = "70000000-0000-4000-8000-000000000001";

function repairAttempt(id, status, command, parentAttemptId = null) {
  return {
    id,
    bugId: BUG_ID,
    sequence: parentAttemptId ? 2 : 1,
    mode: command.successor?.mode ?? "human",
    status,
    assigneeId: command.successor?.assigneeId ?? ACTOR_ID,
    parentAttemptId,
    summary: command.successor?.summary ?? null,
    branch: null,
    commitSha: null,
    mergeRequestUrl: null,
    targetBuildId: null,
    version: status === "planned" ? 1 : command.expectedVersion + 1,
  };
}

async function fixture(t) {
  const app = Fastify({ logger: false });
  const commands = [];
  const terminalRequests = [];
  const verificationRequests = [];
  app.addContentTypeParser(VENDOR_MEDIA_TYPE, { parseAs: "string" }, (_request, body, done) => {
    try {
      done(null, JSON.parse(String(body)));
    } catch (error) {
      done(error);
    }
  });
  app.addHook("onRequest", (request, _reply, done) => {
    if (/^\/api\/v1\/repair-attempts\/.+\/(?:fail|supersede)$/u.test(request.url)) {
      terminalRequests.push({
        path: request.url,
        contentType: request.headers["content-type"],
        accept: request.headers.accept,
        projectId: request.headers["x-qa-project-id"],
        idempotencyKey: request.headers["idempotency-key"],
      });
    }
    done();
  });
  app.addHook("preHandler", (request, _reply, done) => {
    request.browserPrincipal = {
      accountId: "10000000-0000-4000-8000-000000000001",
      actorId: ACTOR_ID,
      userId: ACTOR_ID,
      projectId: PROJECT_ID,
      displayName: "Terminal MCP fixture",
      isGm: false,
    };
    done();
  });
  registerTerminalRepairAttemptRoutes(app, {
    execute(command) {
      commands.push(command);
      const status = command.operation === "failRepairAttempt" ? "failed" : "superseded";
      return {
        representation: command.representation,
        responseMedia: command.responseMedia,
        reason: command.reason,
        attempt: repairAttempt(command.attemptId, status, command),
        successor: command.successor
          ? repairAttempt(command.successor.id, "planned", command, command.attemptId)
          : null,
        bug: { id: BUG_ID, projectId: PROJECT_ID, state: "in_progress", version: 4 },
        eventId: randomUUID(),
        replayed: false,
      };
    },
  });
  app.post("/api/v1/verifications/:verificationId/result", async (request) => {
    verificationRequests.push({ headers: request.headers, body: request.body });
    return { verificationId: request.params.verificationId, ...request.body };
  });
  registerAutomationRoutes(app, "https://api.fixture.invalid");
  t.after(() => app.close());
  const rpc = async (name, argumentsValue) => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json", authorization: "Bearer fixture" },
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
  const shared = async (name, argumentsValue) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/call",
      headers: { "content-type": "application/json", authorization: "Bearer fixture" },
      payload: { name, arguments: argumentsValue },
    });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  return { app, rpc, shared, commands, terminalRequests, verificationRequests };
}

test("shared catalogs expose closed terminal schemas and retain Verification capture evidence bounds", async (t) => {
  const f = await fixture(t);
  const rpcCatalog = (
    await f.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    })
  ).json().result.tools;
  const httpCatalog = (await f.app.inject({ method: "GET", url: "/api/v1/mcp/tools" })).json()
    .tools;
  assert.deepEqual(rpcCatalog, AUTOMATION_TOOLS);
  assert.deepEqual(httpCatalog, rpcCatalog);
  assert.equal(rpcCatalog.length, 96);
  const fail = rpcCatalog.find((tool) => tool.name === "qa_fail_repair_attempt");
  const supersede = rpcCatalog.find((tool) => tool.name === "qa_supersede_repair_attempt");
  assert.deepEqual(fail.inputSchema.required, [
    "projectId",
    "attemptId",
    "expectedVersion",
    "reason",
  ]);
  assert.deepEqual(
    Object.keys(fail.inputSchema.properties).sort(),
    ["attemptId", "expectedVersion", "idempotencyKey", "projectId", "reason"].sort(),
  );
  assert.equal(fail.inputSchema.additionalProperties, false);
  assert.equal(fail.annotations.idempotentHint, true);
  assert.deepEqual(supersede.inputSchema.required, [
    "projectId",
    "attemptId",
    "expectedVersion",
    "reason",
    "successor",
  ]);
  assert.equal(supersede.inputSchema.additionalProperties, false);
  assert.deepEqual(supersede.inputSchema.properties.successor.required, [
    "id",
    "mode",
    "assigneeId",
  ]);
  assert.equal(supersede.inputSchema.properties.successor.additionalProperties, false);
  assert.equal(supersede.annotations.idempotentHint, true);
  const verification = rpcCatalog.find((tool) => tool.name === "qa_record_verification_result");
  assert.equal(verification.inputSchema.properties.request.properties.attachmentIds.maxItems, 20);
  assert.deepEqual(
    verification.inputSchema.properties.request.properties.captureBundleId.anyOf.map(
      (entry) => entry.type,
    ),
    ["string", "null"],
  );
});

test("terminal MCP adapters derive canonical keys and use vendor atomic successor semantics", async (t) => {
  const f = await fixture(t);
  const failReason = "The active implementation failed its focused check";
  const fail = await f.rpc("qa_fail_repair_attempt", {
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    expectedVersion: 2,
    reason: failReason,
  });
  assert.equal(fail.isError, false);
  assert.equal(fail.structuredContent.id, ATTEMPT_ID);
  assert.equal(fail.structuredContent.status, "failed");
  const successor = {
    id: SUCCESSOR_ID,
    mode: "human",
    assigneeId: ACTOR_ID,
    summary: "Continue with the corrected implementation",
  };
  const supersedeKey = `workflow:supersedeRepairAttempt:attempt:${ATTEMPT_ID}:v3`;
  const supersede = await f.shared("qa_supersede_repair_attempt", {
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    expectedVersion: 3,
    reason: "Replace the stale execution plan",
    successor,
    idempotencyKey: supersedeKey,
  });
  assert.equal(supersede.supersededAttempt.id, ATTEMPT_ID);
  assert.equal(supersede.successorAttempt.id, SUCCESSOR_ID);
  assert.deepEqual(
    f.commands.map(({ operation, representation, responseMedia, idempotencyKey, successor }) => ({
      operation,
      representation,
      responseMedia,
      idempotencyKey,
      successor,
    })),
    [
      {
        operation: "failRepairAttempt",
        representation: "vendor-1.1",
        responseMedia: VENDOR_MEDIA_TYPE,
        idempotencyKey: `workflow:failRepairAttempt:attempt:${ATTEMPT_ID}:v2`,
        successor: undefined,
      },
      {
        operation: "supersedeRepairAttempt",
        representation: "vendor-1.1",
        responseMedia: VENDOR_MEDIA_TYPE,
        idempotencyKey: supersedeKey,
        successor,
      },
    ],
  );
  assert.deepEqual(
    f.terminalRequests.map(({ contentType, accept, projectId, idempotencyKey }) => ({
      contentType,
      accept,
      projectId,
      idempotencyKey,
    })),
    [
      {
        contentType: VENDOR_MEDIA_TYPE,
        accept: VENDOR_MEDIA_TYPE,
        projectId: PROJECT_ID,
        idempotencyKey: `workflow:failRepairAttempt:attempt:${ATTEMPT_ID}:v2`,
      },
      {
        contentType: VENDOR_MEDIA_TYPE,
        accept: VENDOR_MEDIA_TYPE,
        projectId: PROJECT_ID,
        idempotencyKey: supersedeKey,
      },
    ],
  );
});

test("terminal MCP tools reject non-closed or non-canonical commands before HTTP dispatch", async (t) => {
  const f = await fixture(t);
  const base = {
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    expectedVersion: 2,
    reason: "Explicit terminal reason",
  };
  const successor = { id: SUCCESSOR_ID, mode: "relay", assigneeId: ACTOR_ID };
  for (const [name, argumentsValue] of [
    ["qa_fail_repair_attempt", { ...base, successor }],
    ["qa_fail_repair_attempt", { ...base, idempotencyKey: "not-canonical" }],
    ["qa_fail_repair_attempt", { ...base, projectId: "not-a-uuid" }],
    ["qa_fail_repair_attempt", { ...base, reason: "" }],
    ["qa_supersede_repair_attempt", base],
    ["qa_supersede_repair_attempt", { ...base, successor: { ...successor, extra: true } }],
    ["qa_supersede_repair_attempt", { ...base, successor: { ...successor, mode: "other" } }],
  ]) {
    const result = await f.rpc(name, argumentsValue);
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      code: "INVALID_REQUEST",
      status: 400,
    });
  }
  assert.equal(f.commands.length, 0);
  assert.equal(f.terminalRequests.length, 0);
});

test("Verification result still forwards twenty attachment IDs and a capture bundle with its canonical key", async (t) => {
  const f = await fixture(t);
  const attachmentIds = Array.from({ length: 20 }, () => randomUUID());
  const captureBundleId = randomUUID();
  const request = {
    submissionContractVersion: "1.1.0",
    clientSubmissionId: randomUUID(),
    expectedVersion: 7,
    status: "passed",
    resultSummary: "Verified with the complete retained evidence set",
    attachmentIds,
    captureBundleId,
  };
  const result = await f.rpc("qa_record_verification_result", {
    projectId: PROJECT_ID,
    verificationId: VERIFICATION_ID,
    request,
  });
  assert.equal(result.isError, false);
  assert.deepEqual(f.verificationRequests[0].body, request);
  assert.equal(
    f.verificationRequests[0].headers["idempotency-key"],
    `workflow:recordVerificationResult:verification:${VERIFICATION_ID}:v7`,
  );
  assert.equal(f.verificationRequests[0].headers["x-qa-project-id"], PROJECT_ID);
});
