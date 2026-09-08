import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";

// Inert unless explicitly run. Every mutation targets a project created by this run.
if (process.argv[2] !== "--run") {
  console.log(
    "Usage: node scripts/project-components/workflow-concurrency-live.mjs --run <preview-instance.json>",
  );
  process.exit(0);
}
const [, , , configFile, ...extra] = process.argv;
assert.equal(extra.length, 0);
const config = readParallelInstanceConfig(configFile);
assert.equal(config.instanceId, "qa-hub-preview-7c86");
assert.equal(config.apiHost, "127.0.0.1");
assert.equal(config.apiPort, 4419);
assert.equal(config.mcpPort, 4421);
const api = "http://127.0.0.1:4419";
const mcp = "http://127.0.0.1:4421";
const runId = randomUUID();
const projectId = randomUUID();
const startedAt = new Date().toISOString();
const credentials = new Set();
const exchanges = [];
const checks = [];
const fixtures = [];
const races = [];
let token;
let actorId;
let sequence = 0;
let failure;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = [
  "scripts/project-components/workflow-concurrency-live.mjs",
  "apps/api/dist/bug-actions.js",
  "apps/api/dist/sqlite-mobile-relay-store.js",
  "apps/api/dist/sqlite-mobile-verification-store.js",
  "packages/storage/dist/mobile-relay-store.js",
  "packages/storage/dist/mobile-verification-store.js",
  "packages/storage/dist/sqlite-worker-entry.js",
];
const sourceHashes = Object.fromEntries(
  sources.map((file) => [file, sha(readFileSync(join(config.sourceRoot, file)))]),
);

function redact(value, depth = 0) {
  if (depth > 64) return "[REDACTED_NESTING_LIMIT]";
  if (typeof value === "string") {
    try {
      const decoded = JSON.parse(value);
      if (decoded && typeof decoded === "object") return JSON.stringify(redact(decoded, depth + 1));
      if (typeof decoded === "string") {
        const clean = redact(decoded, depth + 1);
        if (clean !== decoded) return JSON.stringify(clean);
      }
    } catch {
      /* preserve primitive version strings */
    }
    let clean = value;
    for (const secret of credentials) clean = clean.replaceAll(secret, "[REDACTED]");
    return clean.replace(/Bearer\s+[^\s"<>]+/giu, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/token|secret|password|cookie|authorization|csrf|private.?key|api.?key|credential/iu.test(
            key,
          ),
      )
      .map(([key, child]) => [key, redact(child, depth + 1)]),
  );
}

function remember(value) {
  if (typeof value === "string") {
    try {
      const nested = JSON.parse(value);
      if (nested && typeof nested === "object") remember(nested);
    } catch {
      /* plain text */
    }
  } else if (Array.isArray(value)) value.forEach(remember);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/accessToken|refreshToken|csrfToken/iu.test(key) && typeof item === "string")
        credentials.add(item);
      else remember(item);
    }
  }
}

function check(label, expected, actual) {
  let passed = true;
  try {
    assert.deepEqual(actual, expected);
  } catch {
    passed = false;
  }
  checks.push({ label, passed, expected: redact(expected), actual: redact(actual) });
  return passed;
}

async function wire(label, origin, path, method, body, options = {}) {
  assert.ok(origin === api || origin === mcp);
  assert.ok(path.startsWith("/api/v1/") || path === "/mcp" || path === "/health");
  assert.ok(
    !/increment-upload|relay\/dispatch|production\/|qingyu\/|builds\/|gm\/projects\//u.test(path),
  );
  const record = {
    id: ++sequence,
    label,
    origin,
    path,
    method,
    startedAt: new Date().toISOString(),
    request: redact(body),
    ...(options.key ? { idempotencyKey: options.key } : {}),
  };
  exchanges.push(record);
  try {
    const response = await fetch(origin + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        accept:
          origin === mcp
            ? "application/json, text/event-stream"
            : "application/vnd.relay-qa-hub.v1.1+json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...((options.token ?? token) ? { authorization: `Bearer ${options.token ?? token}` } : {}),
        ...(origin === api && token ? { "x-qa-project-id": projectId } : {}),
        ...(origin === mcp ? { "MCP-Protocol-Version": "2025-06-18" } : {}),
        ...(options.key ? { "idempotency-key": options.key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const value = text ? JSON.parse(text) : null;
    remember(value);
    record.status = response.status;
    record.response = redact(value);
    record.finishedAt = new Date().toISOString();
    return { status: response.status, value, exchangeId: record.id };
  } catch (error) {
    record.failure = redact(String(error));
    record.finishedAt = new Date().toISOString();
    throw error;
  }
}

async function http(label, path, method = "GET", body, key) {
  const result = await wire(label, api, path, method, body, { key });
  return { ...result, ok: result.status >= 200 && result.status < 300, lane: "HTTP" };
}
async function rpc(method, params) {
  const id = randomUUID();
  const result = await wire(method, mcp, "/mcp", "POST", { jsonrpc: "2.0", id, method, params });
  assert.equal(result.status, 200);
  assert.equal(result.value.jsonrpc, "2.0");
  assert.equal(result.value.id, id);
  assert.equal(result.value.error, undefined);
  return { ...result, value: result.value.result };
}
async function tool(name, args) {
  const result = await rpc("tools/call", { name, arguments: { projectId, ...args } });
  return {
    ...result,
    ok: result.value.isError === false,
    value: result.value.structuredContent ?? JSON.parse(result.value.content[0].text),
    lane: "server_mcp",
  };
}
const must = (response) => {
  assert.equal(response.ok, true, JSON.stringify(redact(response.value)));
  return response.value;
};
const bug = async (id) => must(await http("read Bug", `/api/v1/bugs/${id}`));
const events = async (id) =>
  must(await http("read events", `/api/v1/bugs/${id}/events?limit=100`)).items;
const project = (value, keys) =>
  Object.fromEntries(
    keys.map((key) => [
      key,
      key === "verification"
        ? project(value?.[key], [
            "id",
            "bugId",
            "repairAttemptId",
            "status",
            "version",
            "verifierId",
            "criteriaSnapshot",
            "resultSummary",
          ])
        : key === "bug"
          ? project(value?.[key], bugFields)
          : value?.[key],
    ]),
  );
const bugFields = ["id", "projectId", "state", "version", "reporterId"];

async function race(label, actions) {
  const entry = { label, launchedAt: new Date().toISOString() };
  races.push(entry);
  // Both requests are issued before awaiting either response. This is bounded to two.
  const startIndex = exchanges.length;
  const settled = await Promise.allSettled(actions.map((action) => action()));
  entry.finishedAt = new Date().toISOString();
  entry.exchangeIds = exchanges.slice(startIndex).map((item) => item.id);
  const errors = settled.filter((item) => item.status === "rejected");
  if (errors.length > 0) {
    entry.failures = errors.map((item) => redact(String(item.reason)));
    throw new Error(`${label}: ${entry.failures.join("; ")}`);
  }
  const responses = settled.map((item) => item.value);
  check(
    `${label}: both clients dispatched before either response finished`,
    true,
    Math.max(
      ...responses.map((item) =>
        Date.parse(exchanges.find((record) => record.id === item.exchangeId).startedAt),
      ),
    ) <=
      Math.min(
        ...responses.map((item) =>
          Date.parse(exchanges.find((record) => record.id === item.exchangeId).finishedAt),
        ),
      ),
  );
  return responses;
}

async function replayAction(
  label,
  id,
  action,
  expectedVersion,
  legacyPath,
  request,
  key,
  resourceFields,
  identifiers = {},
) {
  const before = await events(id);
  const calls = [
    () => http(`${label} HTTP`, legacyPath, "POST", { ...request, expectedVersion }, key),
    () =>
      tool("qa_bug_action", {
        bugId: id,
        action,
        expectedVersion,
        idempotencyKey: key,
        request,
        ...identifiers,
      }),
  ];
  const responses = await race(label, calls);
  check(
    `${label}: identical concurrent intent returns success to both entries`,
    [true, true],
    responses.map((item) => item.ok),
  );
  const successful = responses.filter((item) => item.ok);
  assert.ok(successful.length > 0, `${label}: neither request succeeded`);
  const unwrap = (item) => (item.lane === "HTTP" ? item.value : item.value.result);
  const result = unwrap(successful[0]);
  if (successful.length === 2)
    check(
      `${label}: same committed resource`,
      project(result, resourceFields),
      project(unwrap(successful[1]), resourceFields),
    );
  const committed = await bug(id);
  const after = await events(id);
  check(`${label}: one event`, before.length + 1, after.length);
  check(
    `${label}: new event actor`,
    [actorId],
    after
      .filter((item) => !before.some((prior) => prior.id === item.id))
      .map((item) => item.actor.id),
  );
  for (const invoke of calls) {
    const response = await invoke();
    check(`${label}: sequential retry ${response.lane} returns success`, true, response.ok);
    if (response.ok)
      check(
        `${label}: sequential retry ${response.lane} same resource`,
        project(result, resourceFields),
        project(unwrap(response), resourceFields),
      );
  }
  check(`${label}: retry leaves Bug unchanged`, committed, await bug(id));
  check(`${label}: retry leaves events unchanged`, after, await events(id));
  return result;
}

try {
  assert.equal(must(await http("API readiness", "/api/v1/health/ready")).status, "ready");
  const health = await wire("server MCP readiness", mcp, "/health", "GET");
  assert.equal(health.value.status, "ready");
  const privateConfig = JSON.parse(
    readFileSync(config.secretsFile, "utf8").replace(/^\uFEFF/u, ""),
  );
  credentials.add(privateConfig.gmPassword);
  const gm = await wire(
    "GM login to create fresh test project",
    api,
    "/api/v1/auth/gm/login",
    "POST",
    { password: privateConfig.gmPassword, client: "android" },
  );
  assert.equal(gm.status, 200);
  assert.equal(gm.value.isGm, true);
  const created = await wire(
    "create isolated concurrency project",
    api,
    "/api/v1/gm/projects",
    "POST",
    {
      id: projectId,
      key: `CC${runId.replaceAll("-", "").slice(0, 14).toUpperCase()}`,
      name: `Concurrency ${runId}`,
    },
    { token: gm.value.accessToken },
  );
  assert.equal(created.status, 200);
  const login = await wire("new test employee login", api, "/api/v1/auth/login", "POST", {
    name: `Concurrent${runId.replaceAll("-", "")}`,
    projectId,
    client: "android",
  });
  assert.equal(login.status, 200);
  token = login.value.accessToken;
  actorId = login.value.userId;
  assert.equal(login.value.projectId, projectId);
  const components = must(
    await http("new project all components disabled", `/api/v1/projects/${projectId}/components`),
  ).items;
  assert.equal(components.length, 5);
  assert.ok(components.every((item) => item.enabled === false));
  assert.equal(
    (
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "workflow-concurrency-live", version: "1.0" },
      })
    ).value.protocolVersion,
    "2025-06-18",
  );
  assert.equal(
    (
      await wire("initialized", mcp, "/mcp", "POST", {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })
    ).status,
    202,
  );
  const submissionId = randomUUID();
  const request = {
    submissionContractVersion: "1.1.0",
    clientSubmissionId: submissionId,
    projectId,
    title: `并发幂等验收 ${runId}`,
    description: "隔离并发测试记录",
    expectedBehavior: "同请求仅提交一次，旧版本被拒绝",
    severity: "S3",
    priority: "P3",
    occurrence: {
      observedAt: startedAt,
      platform: "web",
      steps: ["并发发送相同业务意图"],
      actualBehavior: "测试服务端持久幂等",
    },
  };
  const createKey = `submission:${submissionId}:commit`;
  const createCalls = [
    () => http("create HTTP", "/api/v1/bugs", "POST", request, createKey),
    () => tool("qa_create_bug", { request }),
  ];
  const creates = await race("create same key across HTTP/server MCP", createCalls);
  check(
    "create: both success",
    [true, true],
    creates.map((item) => item.ok),
  );
  const initial = must(creates.find((item) => item.ok)).bug;
  fixtures.push({ bugId: initial.id, clientSubmissionId: submissionId });
  const id = initial.id;
  check(
    "create: one resource ID",
    [id, id],
    creates.map((item) => item.value.bug?.id),
  );
  check("create: one Bug event", 1, (await events(id)).length);
  const changedCreate = await http(
    "same creation key changed title refused",
    "/api/v1/bugs",
    "POST",
    { ...request, title: `${request.title} changed` },
    createKey,
  );
  check("create changed payload denied", false, changedCreate.ok);
  check("create changed payload HTTP status", 409, changedCreate.status);
  check("create changed payload code", "IDEMPOTENCY_PAYLOAD_MISMATCH", changedCreate.value.code);
  check("create rejection unchanged", initial, await bug(id));

  const editBefore = await events(id);
  const different = await race("different edit keys same old version", [
    () =>
      http(
        "edit contender HTTP",
        `/api/v1/bugs/${id}`,
        "PATCH",
        { expectedVersion: 1, title: "HTTP CAS winner candidate" },
        `edit:${randomUUID()}`,
      ),
    () =>
      tool("qa_update_bug", {
        bugId: id,
        request: { expectedVersion: 1, title: "MCP CAS winner candidate" },
        idempotencyKey: `edit:${randomUUID()}`,
      }),
  ]);
  check("different edit keys: exactly one winner", 1, different.filter((item) => item.ok).length);
  check(
    "different edit keys: loser gets version conflict",
    ["VERSION_CONFLICT"],
    different.filter((item) => !item.ok).map((item) => item.value.code),
  );
  check("different edit keys: one version increment", 2, (await bug(id)).version);
  check("different edit keys: one event", editBefore.length + 1, (await events(id)).length);

  const updateKey = `edit:${randomUUID()}`;
  const updateRequest = { expectedVersion: 2, title: "同一编辑请求并发重放" };
  const updates = await race("same edit key", [
    () => http("same edit HTTP", `/api/v1/bugs/${id}`, "PATCH", updateRequest, updateKey),
    () => tool("qa_update_bug", { bugId: id, request: updateRequest, idempotencyKey: updateKey }),
  ]);
  check(
    "same edit: both success",
    [true, true],
    updates.map((item) => item.ok),
  );
  if (updates.every((item) => item.ok))
    check("same edit: same result", updates[0].value, updates[1].value);
  check("same edit: one version increment", 3, (await bug(id)).version);

  const commentId = randomUUID();
  const commentRequest = { clientSubmissionId: commentId, body: "同一评论并发，仅记录一次" };
  const commentKey = `comment:${id}:${commentId}`;
  const commentBefore = await events(id);
  const comments = await race("same comment key", [
    () => http("comment HTTP", `/api/v1/bugs/${id}/comments`, "POST", commentRequest, commentKey),
    () => tool("qa_add_comment", { bugId: id, request: commentRequest }),
  ]);
  check(
    "comment: both success",
    [true, true],
    comments.map((item) => item.ok),
  );
  check("comment: same comment ID", comments[0].value.comment?.id, comments[1].value.comment?.id);
  check(
    "comment: one stored comment",
    1,
    must(await http("comment readback", `/api/v1/bugs/${id}/comments?limit=100`)).items.length,
  );
  check("comment: one event", commentBefore.length + 1, (await events(id)).length);

  let current = await bug(id);
  await replayAction(
    "ready",
    id,
    "ready",
    current.version,
    `/api/v1/bugs/${id}/transitions`,
    { toState: "ready" },
    `workflow:transitionBug:bug:${id}:v${current.version}:ready`,
    bugFields,
  );
  current = await bug(id);
  const attemptFields = [
    "id",
    "bugId",
    "sequence",
    "mode",
    "status",
    "assigneeId",
    "summary",
    "version",
  ];
  let attempt = await replayAction(
    "plan human fix",
    id,
    "plan_fix",
    current.version,
    `/api/v1/bugs/${id}/repair-attempts`,
    { mode: "human", assigneeId: actorId, summary: "并发创建一次人工修复轮次" },
    `workflow:createRepairAttempt:bug:${id}:v${current.version}`,
    attemptFields,
  );
  fixtures[0].attemptId = attempt.id;
  attempt = await replayAction(
    "begin human fix",
    id,
    "begin_fix",
    attempt.version,
    `/api/v1/repair-attempts/${attempt.id}/start`,
    { reason: "并发开始同一人工修复" },
    `workflow:startRepairAttempt:attempt:${attempt.id}:v${attempt.version}`,
    attemptFields,
    { attemptId: attempt.id },
  );
  attempt = await replayAction(
    "submit no-code fix",
    id,
    "submit_fix",
    attempt.version,
    `/api/v1/repair-attempts/${attempt.id}/deliver`,
    {
      summary: "并发交付一次",
      deliveryKind: "no_code",
      noCodeReason: "这是隔离验收记录，无代码修改",
    },
    `workflow:deliverRepairAttempt:attempt:${attempt.id}:v${attempt.version}`,
    attemptFields,
    { attemptId: attempt.id },
  );
  current = await bug(id);
  const verificationFields = [
    "id",
    "bugId",
    "repairAttemptId",
    "verifierId",
    "status",
    "criteriaSnapshot",
    "version",
  ];
  let verification = await replayAction(
    "create verification",
    id,
    "create_verification",
    current.version,
    `/api/v1/bugs/${id}/verifications`,
    {
      repairAttemptId: attempt.id,
      buildId: null,
      verifierId: actorId,
      criteria: "同意图仅创建一条验证记录",
    },
    `workflow:createVerification:bug:${id}:attempt:${attempt.id}:v${current.version}`,
    verificationFields,
  );
  fixtures[0].verificationId = verification.id;
  verification = await replayAction(
    "start verification",
    id,
    "start_verification",
    verification.version,
    `/api/v1/verifications/${verification.id}/start`,
    { reason: "并发开始一次验证" },
    `workflow:startVerification:verification:${verification.id}:v${verification.version}`,
    verificationFields,
    { verificationId: verification.id },
  );
  const resultRequest = {
    submissionContractVersion: "1.1.0",
    clientSubmissionId: randomUUID(),
    resultSummary: "仅验收该独立测试数据的本地生命周期",
    attachmentIds: [],
  };
  await replayAction(
    "record verification pass",
    id,
    "verify_pass",
    verification.version,
    `/api/v1/verifications/${verification.id}/result`,
    { ...resultRequest, status: "passed" },
    `workflow:recordVerificationResult:verification:${verification.id}:v${verification.version}`,
    ["verification", "bug"],
    { verificationId: verification.id },
  );
  current = await bug(id);
  check("final fixture closed", "closed", current.state);
  const deleteKey = `web:deleteBug:bug:${id}:v${current.version}`;
  const deletes = await race("same soft-delete key", [
    () =>
      http(
        "soft-delete HTTP",
        `/api/v1/bugs/${id}?expectedVersion=${current.version}`,
        "DELETE",
        undefined,
        deleteKey,
      ),
    () => tool("qa_delete_bug", { bugId: id, expectedVersion: current.version }),
  ]);
  check(
    "soft-delete: both success",
    [true, true],
    deletes.map((item) => item.ok),
  );
  const deleted = await http("soft-deleted fixture unavailable", `/api/v1/bugs/${id}`);
  check("soft-delete readback", [404, "NOT_FOUND"], [deleted.status, deleted.value.code]);
  check(
    "final project list contains no live fixture",
    0,
    must(await http("final test project list", `/api/v1/bugs?projectId=${projectId}&limit=100`))
      .items.length,
  );
  check(
    "components still all off",
    true,
    must(await http("final components", `/api/v1/projects/${projectId}/components`)).items.every(
      (item) => item.enabled === false,
    ),
  );
} catch (error) {
  failure = redact(String(error));
} finally {
  const outputDir = join(
    config.sourceRoot,
    "docs/evidence/project-components/workflow-concurrency-live",
  );
  mkdirSync(outputDir, { recursive: true });
  const passed = !failure && checks.every((item) => item.passed);
  const output = join(outputDir, `${runId}.json`);
  writeFileSync(
    output,
    JSON.stringify(
      {
        runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        instanceId: config.instanceId,
        projectId,
        actorId,
        scope:
          "Bounded two-client HTTP/server-MCP requests against fresh test data, no component/external task execution. Does not prove UI timeout recovery or all six entries.",
        sourceHashes,
        passed,
        failure,
        fixtures,
        races,
        checks,
        exchanges,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      passed,
      checkCount: checks.length,
      failedChecks: checks.filter((item) => !item.passed).map((item) => item.label),
      failure,
      requestCount: exchanges.length,
      evidence: output,
    }),
  );
  process.exitCode = passed ? 0 : 1;
}
