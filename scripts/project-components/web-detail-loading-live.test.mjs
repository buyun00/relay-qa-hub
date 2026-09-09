import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  WEB,
  EXPECTED_WEB,
  classifyRequest,
  DetailFaultPlan,
  RealResponseLedger,
  releaseRealResponses,
  redact,
} from "./web-detail-loading-live.mjs";

const scope = {
  projectId: "d932e3b5-6a62-4899-9505-b9e9c9aac335",
  actorId: "d4949237-f549-443d-bdce-1633bbcb8dc3",
  bugId: "2aaea095-2790-41c6-b807-0c10ac3cf487",
  employee: "SyntheticDetailFixture",
};
const request = (path, overrides = {}) => ({
  url: WEB + path,
  method: "GET",
  headers: { "x-qa-project-id": scope.projectId },
  ...overrides,
});
const project = `/api/v1/projects/${scope.projectId}`;
const bug = `/api/v1/bugs/${scope.bugId}`;

test("default CLI is inert without even valid configuration arguments", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./web-detail-loading-live.mjs", import.meta.url)), "missing.json"],
    { encoding: "utf8", timeout: 10000, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^not_run: --run /u);
  assert.match(result.stdout, /no default I\/O/u);
  assert.equal(result.stderr, "");
});

test("allowlist accepts exact published assets and fixture reads only", () => {
  const reads = [
    [`/?projectId=${scope.projectId}`, "document"],
    ["/api/v1/auth/me", "session"],
    [`/api/v1/project-entry/${scope.projectId}`, "entry"],
    ["/api/v1/projects?limit=50", "projects"],
    [`${project}/components`, "components"],
    [`${project}/members?limit=100`, "members"],
    [`${project}/modules`, "modules"],
    [`/api/v1/bugs?projectId=${scope.projectId}&limit=100`, "bugs"],
    [`/api/v1/bugs?limit=100&ownerId=${scope.actorId}&projectId=${scope.projectId}`, "bugs"],
    [bug, "detail"],
    [`${bug}/events?limit=20`, "events"],
    [`${bug}/attachments?limit=50`, "attachments"],
    [`${bug}/human-workflow`, "detail-read"],
    [`${bug}/comments`, "detail-read"],
    ...EXPECTED_WEB.map(([path]) => ["/" + path, "static"]),
  ];
  for (const [path, expected] of reads)
    assert.equal(classifyRequest(request(path), scope), expected);
  assert.equal(classifyRequest(request("/api/v1/auth/me", { headers: {} }), scope), "session");
  assert.equal(
    classifyRequest(request(`/api/v1/project-entry/${scope.projectId}`, { headers: {} }), scope),
    "entry",
  );
});

test("browser login permits only exact fresh employee/project and web client", () => {
  const body = { name: scope.employee, projectId: scope.projectId, client: "web" };
  const login = (value) =>
    request("/api/v1/auth/login", { method: "POST", postData: JSON.stringify(value) });
  assert.equal(classifyRequest(login(body), scope), "login");
  for (const value of [
    { ...body, name: "ExistingEmployee" },
    { ...body, projectId: "another-project" },
    { ...body, client: "android" },
    { ...body, password: "synthetic-only" },
  ])
    assert.throws(() => classifyRequest(login(value), scope));
  assert.throws(
    () =>
      classifyRequest(
        request("/api/v1/auth/login", {
          method: "POST",
          headers: {},
          postData: JSON.stringify(body),
        }),
        scope,
      ),
    /BROWSER_PROJECT_REFUSED/u,
  );
});

test("allowlist refuses different origins, records, project scopes, query widening and writes", () => {
  for (const url of [
    "http://127.0.0.1:4319" + bug,
    "http://127.0.0.1:4419" + bug,
    "https://example.invalid" + bug,
  ])
    assert.throws(() => classifyRequest(request(bug, { url }), scope), /BROWSER_ORIGIN_REFUSED/u);
  for (const path of [`${project}/members?limit=500`, `${project}/components?enabled=true`]) {
    assert.throws(() => classifyRequest(request(path), scope), /BROWSER_ROUTE_REFUSED/u);
  }
  for (const path of [
    `${project}/components?unexpected=`,
    `${bug}?projectId=${scope.projectId}`,
    `${bug}/events?limit=20&limit=20`,
    `/api/v1/bugs/other`,
    `/api/v1/projects/other/components`,
    `/api/v1/bugs?projectId=${scope.projectId}&limit=100&ownerId=other`,
    `${project}/production/outbox`,
    `/api/v1/production/tasks`,
  ])
    assert.throws(() => classifyRequest(request(path), scope), /BROWSER_ROUTE_REFUSED/u);
  for (const headers of [{}, { "X-Qa-Project-Id": "other" }]) {
    assert.throws(
      () => classifyRequest(request(bug, { headers }), scope),
      /BROWSER_PROJECT_REFUSED/u,
    );
  }
  for (const [method, path] of [
    ["POST", "/api/v1/bugs"],
    ["POST", `${bug}/comments`],
    ["PATCH", bug],
    ["DELETE", bug],
    ["POST", "/api/v1/production/batches"],
  ]) {
    assert.throws(
      () => classifyRequest(request(path, { method }), scope),
      /BROWSER_MUTATION_REFUSED/u,
    );
  }
});

test("real fault plan holds genuine 200, injects no successful response, and requires explicit Retry", () => {
  const plan = new DetailFaultPlan();
  plan.armDelay();
  assert.equal(plan.request("real-first"), "delay");
  assert.equal(plan.response("real-first", 200), "hold");
  assert.equal(plan.phase, "held_real_200");
  assert.equal(plan.held, "real-first");
  assert.throws(() => plan.armDisconnect());
  assert.equal(plan.release(), "real-first");
  plan.armDisconnect();
  assert.equal(plan.request("transport-failure"), "disconnect");
  assert.equal(plan.phase, "disconnected");
  assert.deepEqual(plan.responses, ["real-first"]);
  assert.throws(() => plan.response("transport-failure", 200));
  assert.throws(() => plan.request("automatic-retry"), /UNEXPECTED_DETAIL_REQUEST/u);
  plan.armRetry();
  assert.equal(plan.request("real-retry"), "retry");
  assert.equal(plan.response("real-retry", 200), "continue");
  assert.equal(plan.phase, "retry_confirmed");
  assert.deepEqual(plan.responses, ["real-first", "real-retry"]);
  assert.equal(plan.requests.length, 3);
});

test("fault plan refuses non-200, missing request, duplicate responses and extra details", () => {
  const plan = new DetailFaultPlan();
  assert.throws(() => plan.request("unarmed"));
  assert.throws(() => plan.response("unknown", 200));
  plan.armDelay();
  plan.request("first");
  assert.throws(() => plan.response("first", 500), /REAL_DETAIL_200_REQUIRED/u);
  assert.deepEqual(plan.responses, []);
  plan.response("first", 200);
  assert.throws(() => plan.response("first", 200));
  assert.throws(() => plan.request("first"));
  assert.throws(() => plan.request("extra"), /UNEXPECTED_DETAIL_REQUEST/u);
  plan.release();
  assert.throws(() => plan.release());
});

test("release helper attempts every held response, leaves failed entries, never rewrites body or status", async () => {
  const holds = new Map(
    ["one", "two", "three"].map((id) => [id, { requestId: id, sha256: "original-" + id }]),
  );
  const calls = [],
    records = [];
  await assert.rejects(
    releaseRealResponses(
      holds,
      async (method, params) => {
        calls.push([method, params]);
        if (params.requestId === "two") throw new Error("synthetic CDP refusal");
      },
      (row) => records.push(row),
    ),
    /REAL_RESPONSE_RELEASE_FAILED: 1/u,
  );
  assert.deepEqual(
    calls,
    ["one", "two", "three"].map((requestId) => ["Fetch.continueRequest", { requestId }]),
  );
  assert.deepEqual([...holds.keys()], ["two"]);
  assert.deepEqual(
    records.map((x) => x.requestId),
    ["one", "three"],
  );
  await releaseRealResponses(
    holds,
    async (method, params) => {
      assert.equal(method, "Fetch.continueRequest");
      assert.deepEqual(params, { requestId: "two" });
    },
    () => undefined,
  );
  assert.equal(holds.size, 0);
});

test("actual response ledger retains a pause before JSON validation and releases it on failure", async () => {
  const calls = [],
    rows = [];
  const ledger = new RealResponseLedger(
    async (...args) => calls.push(args),
    (row) => rows.push(row),
  );
  ledger.pause({ requestId: "bad-json", category: "detail", status: 200 });
  assert.throws(() => JSON.parse("synthetic invalid upstream JSON"));
  await ledger.releaseAll("finally_release_real_response_unmodified");
  assert.deepEqual(calls, [["Fetch.continueRequest", { requestId: "bad-json" }]]);
  assert.equal(ledger.entries.size, 0);
  assert.equal(rows[0].action, "finally_release_real_response_unmodified");
  assert.equal(rows[0].status, 200);
});

test("deadline and finally concurrent releases share one real CDP call per response", async () => {
  let resolveRelease;
  const calls = [],
    rows = [];
  const ledger = new RealResponseLedger(
    async (...args) => {
      calls.push(args);
      await new Promise((resolve) => {
        resolveRelease = resolve;
      });
    },
    (row) => rows.push(row),
  );
  ledger.pause({ requestId: "slow-release", status: 200, sha256: "genuine-body-hash" });
  const deadline = ledger.releaseAll("deadline_release_real_response_unmodified");
  const cleanup = ledger.releaseAll("finally_release_real_response_unmodified");
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(ledger.entries.size, 1);
  resolveRelease();
  await Promise.all([deadline, cleanup]);
  assert.equal(ledger.entries.size, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sha256, "genuine-body-hash");
});

test("failed ledger release does not prevent others and can be attempted by final cleanup", async () => {
  let fail = true;
  const calls = [];
  const ledger = new RealResponseLedger(
    async (method, params) => {
      calls.push([method, params]);
      if (params.requestId === "first" && fail) throw new Error("synthetic CDP failure");
    },
    () => undefined,
  );
  ledger.pause({ requestId: "first", status: 200 });
  ledger.pause({ requestId: "second", status: 200 });
  await assert.rejects(ledger.releaseAll("deadline"));
  assert.deepEqual([...ledger.entries.keys()], ["first"]);
  assert.equal(calls.length, 2);
  fail = false;
  await ledger.releaseAll("finally");
  assert.equal(calls.length, 3);
  assert.equal(ledger.entries.size, 0);
});

test("redaction preserves primitive strings while removing synthetic secrets across JSON envelopes", () => {
  const secret = "synthetic-private-value-for-memory-only-test";
  const secrets = new Set([secret]);
  for (const value of [
    "2.0",
    "1e3",
    "-0",
    "9007199254740993123456789",
    "true",
    "null",
    " 2.0 ",
    JSON.stringify("2.0"),
    JSON.stringify(JSON.stringify("2.0")),
  ]) {
    assert.equal(redact(value, secrets), value);
  }
  const source = {
    version: "2.0",
    nested: JSON.stringify(
      JSON.stringify({
        password: "unknown-synthetic-password",
        value: secret,
        list: [{ cookie: "synthetic-cookie" }],
      }),
    ),
  };
  const before = JSON.stringify(source);
  const clean = redact(source, secrets);
  assert.equal(JSON.stringify(source), before);
  assert.equal(clean.version, "2.0");
  const nested = JSON.parse(JSON.parse(clean.nested));
  assert.deepEqual(nested, {
    password: "[REDACTED]",
    value: "[REDACTED]",
    list: [{ cookie: "[REDACTED]" }],
  });
  assert(!JSON.stringify(clean).includes(secret));
  assert.equal(redact("2.0", secrets, 64), "2.0");
  assert.equal(redact(secret, secrets, 65), "[REDACTED_NESTING_LIMIT]");
});
