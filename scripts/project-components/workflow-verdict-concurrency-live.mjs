import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";

// Inert unless explicitly run. Every mutation targets a project created by this run.
if (process.argv[2] !== "--run") {
  console.log(
    "Usage: node scripts/project-components/workflow-verdict-concurrency-live.mjs --run <preview-instance.json>",
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
  "scripts/project-components/workflow-verdict-concurrency-live.mjs",
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
        clientInfo: { name: "workflow-verdict-concurrency-live", version: "1.0" },
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

  const act = async (label, lane, id, action, version, request, key, identifiers = {}) => {
    const input = { action, expectedVersion: version, request, ...identifiers };
    return lane === "HTTP"
      ? http(
          label,
          "/api/v1/projects/" + projectId + "/bugs/" + id + "/actions",
          "POST",
          input,
          key,
        )
      : tool("qa_bug_action", { bugId: id, ...input, idempotencyKey: key });
  };
  for (const [passAction, failAction] of [
    ["verify_pass", "verify_fail"],
    ["close", "reject"],
  ]) {
    const label = passAction + " versus " + failAction;
    const clientSubmissionId = randomUUID();
    const request = {
      submissionContractVersion: "1.1.0",
      clientSubmissionId,
      projectId,
      title: "Opposite verdict CAS " + label + " " + runId,
      description: "Fresh local concurrency fixture; no external execution.",
      expectedBehavior: "Exactly one result wins the same verification version.",
      severity: "S3",
      priority: "P3",
      occurrence: {
        observedAt: startedAt,
        platform: "web",
        steps: ["Bounded two-client opposite verdict race"],
        actualBehavior: "Local storage race acceptance",
      },
    };
    let current = must(
      await http(
        label + " create fixture",
        "/api/v1/bugs",
        "POST",
        request,
        "submission:" + clientSubmissionId + ":commit",
      ),
    ).bug;
    const id = current.id;
    const fixture = { label, bugId: id, clientSubmissionId };
    fixtures.push(fixture);
    const manualVersion = current.version;
    const manualKey = "workflow:manualCompleteBug:bug:" + id + ":v" + manualVersion;
    const manualRequest = { reason: "Isolated human no-code test record, no external task." };
    const manual = await race(label + " same manual completion intent", [
      () =>
        act(
          label + " manual HTTP",
          "HTTP",
          id,
          "manual_complete",
          manualVersion,
          manualRequest,
          manualKey,
        ),
      () =>
        act(
          label + " manual MCP",
          "MCP",
          id,
          "manual_complete",
          manualVersion,
          manualRequest,
          manualKey,
        ),
    ]);
    check(
      label + ": manual completion both success",
      [true, true],
      manual.map((x) => x.ok),
    );
    assert.ok(manual.every((x) => x.ok));
    current = await bug(id);
    check(label + ": manual completion target state", "ready_for_verification", current.state);
    check(
      label + ": manual completion same resource",
      manual[0].value.result,
      manual[1].value.result,
    );
    const beforeRetry = await events(id);
    for (const lane of ["HTTP", "MCP"]) {
      must(
        await act(
          label + " manual replay " + lane,
          lane,
          id,
          "manual_complete",
          manualVersion,
          manualRequest,
          manualKey,
        ),
      );
    }
    check(label + ": manual replay unchanged Bug", current, await bug(id));
    check(label + ": manual replay unchanged events", beforeRetry, await events(id));
    const workflow = must(
      await http(label + " delivered workflow", "/api/v1/bugs/" + id + "/human-workflow"),
    );
    const attemptId = workflow.repairAttempt?.id;
    assert.equal(typeof attemptId, "string", JSON.stringify(workflow));
    fixture.attemptId = attemptId;
    const createVerif = must(
      await act(
        label + " create verification",
        "HTTP",
        id,
        "create_verification",
        current.version,
        {
          repairAttemptId: attemptId,
          buildId: null,
          verifierId: actorId,
          criteria: "One opposite verdict wins without external activity.",
        },
        "verdict:create:" + id,
      ),
    );
    let verification = createVerif.result;
    fixture.verificationId = verification.id;
    verification = must(
      await act(
        label + " start verification",
        "HTTP",
        id,
        "start_verification",
        verification.version,
        { reason: "Start isolated local race" },
        "verdict:start:" + verification.id,
        { verificationId: verification.id },
      ),
    ).result;
    current = await bug(id);
    const beforeEvents = await events(id);
    const verificationId = verification.id;
    const expectedVersion = verification.version;
    const candidates = [
      {
        lane: "HTTP",
        action: passAction,
        status: "passed",
        request: {
          submissionContractVersion: "1.1.0",
          clientSubmissionId: randomUUID(),
          resultSummary: "Pass side of isolated opposite race",
          attachmentIds: [],
        },
        key: "verdict:pass:" + verificationId,
      },
      {
        lane: "MCP",
        action: failAction,
        status: "failed",
        request: {
          submissionContractVersion: "1.1.0",
          clientSubmissionId: randomUUID(),
          resultSummary: "Fail side of isolated opposite race",
          failureReason: "Deliberate competing test verdict",
          attachmentIds: [],
        },
        key: "verdict:fail:" + verificationId,
      },
    ];
    fixture.candidates = candidates.map(({ lane, action, status, request, key }) => ({
      lane,
      action,
      status,
      clientSubmissionId: request.clientSubmissionId,
      key,
    }));
    const invoke = (candidate, lane = candidate.lane, request = candidate.request) =>
      act(
        label + " " + candidate.action + " " + lane,
        lane,
        id,
        candidate.action,
        expectedVersion,
        request,
        candidate.key,
        { verificationId },
      );
    const outcomes = await race(
      label,
      candidates.map((candidate) => () => invoke(candidate)),
    );
    check(label + ": exactly one success", 1, outcomes.filter((x) => x.ok).length);
    check(
      label + ": exactly one VERSION_CONFLICT",
      1,
      outcomes.filter((x) => !x.ok && x.value.code === "VERSION_CONFLICT").length,
    );
    assert.equal(outcomes.filter((x) => x.ok).length, 1);
    const winnerIndex = outcomes.findIndex((x) => x.ok);
    const winner = candidates[winnerIndex];
    const loser = candidates[1 - winnerIndex];
    const winnerResult = outcomes[winnerIndex].value.result;
    fixture.winner = {
      lane: winner.lane,
      action: winner.action,
      clientSubmissionId: winner.request.clientSubmissionId,
    };
    const afterBug = await bug(id);
    const afterEvents = await events(id);
    const afterVerification = must(
      await http(label + " verification readback", "/api/v1/verifications/" + verificationId),
    );
    check(
      label + ": verification version advanced once",
      expectedVersion + 1,
      afterVerification.version,
    );
    check(label + ": verification matches winner", winner.status, afterVerification.status);
    check(label + ": Bug version advanced once", current.version + 1, afterBug.version);
    check(
      label + ": Bug state matches winner",
      winner.status === "passed" ? "closed" : "ready",
      afterBug.state,
    );
    const newEvents = afterEvents.filter((x) => !beforeEvents.some((old) => old.id === x.id));
    check(label + ": exactly one audit event", 1, newEvents.length);
    check(
      label + ": result audit type and actor",
      ["verification.result_recorded", actorId],
      [newEvents[0]?.type, newEvents[0]?.actor?.id],
    );
    check(label + ": winner event matches persisted event", newEvents[0]?.id, winnerResult.eventId);
    for (const lane of ["HTTP", "MCP"]) {
      const replay = await invoke(winner, lane);
      check(label + ": winner replay succeeds " + lane, true, replay.ok);
      if (replay.ok)
        check(
          label + ": winner receipt identity " + lane,
          [winnerResult.eventId, winner.request.clientSubmissionId, verificationId, winner.status],
          [
            replay.value.result.eventId,
            replay.value.result.clientSubmissionId,
            replay.value.result.verification.id,
            replay.value.result.verification.status,
          ],
        );
      const refused = await invoke(loser, lane);
      check(
        label + ": loser stale retry refused " + lane,
        [false, "VERSION_CONFLICT"],
        [refused.ok, refused.value.code],
      );
      const mismatch = await invoke(winner, lane, {
        ...winner.request,
        resultSummary: "Different payload on committed identity",
      });
      check(
        label + ": changed winner intent refused " + lane,
        [false, "IDEMPOTENCY_PAYLOAD_MISMATCH"],
        [mismatch.ok, mismatch.value.code],
      );
    }
    check(label + ": all retries leave Bug unchanged", afterBug, await bug(id));
    check(
      label + ": all retries leave verification unchanged",
      afterVerification,
      must(await http(label + " final verification", "/api/v1/verifications/" + verificationId)),
    );
    check(label + ": all retries leave events unchanged", afterEvents, await events(id));
  }
  const finalList = must(
    await http("final live fixture list", "/api/v1/bugs?projectId=" + projectId + "&limit=100"),
  ).items;
  check(
    "exactly two original fixtures retained",
    fixtures.map((x) => x.bugId).sort(),
    finalList.map((x) => x.id).sort(),
  );
  check(
    "five components remain disabled",
    [false, false, false, false, false],
    must(await http("final components", "/api/v1/projects/" + projectId + "/components")).items.map(
      (x) => x.enabled,
    ),
  );
} catch (error) {
  failure = redact(String(error));
} finally {
  const outputDir = join(
    config.sourceRoot,
    "docs/evidence/project-components/workflow-verdict-concurrency-live",
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
          "Two opposite-verdict races and same-intent manual completion via real HTTP/server MCP on fresh retained fixtures. No UI, other entry, external workflow, or all-state-matrix acceptance.",
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
