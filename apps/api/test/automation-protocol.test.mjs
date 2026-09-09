import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorageWorker, projectMembershipId } from "@relay-qa-hub/storage";
import { createSqliteBrowserAuthStore, registerBrowserAuthRoutes } from "../dist/browser-auth.js";
import { AUTOMATION_TOOLS, registerAutomationRoutes } from "../dist/automation.js";

const protocol = "2025-06-18";
const initializeParams = {
  protocolVersion: protocol,
  capabilities: {},
  clientInfo: { name: "isolated-http-protocol-fixture", version: "1" },
};

async function fixture(t, configure = () => {}) {
  const app = Fastify({ logger: false });
  const calls = [];
  app.post("/api/v1/auth/login", async (request, reply) => {
    calls.push({ body: request.body, authorization: request.headers.authorization });
    if (request.body.name === "business-conflict")
      return reply.code(409).send({ code: "TEST_BUSINESS_CONFLICT", version: 3 });
    return { userId: "fixture-user", projectId: request.body.projectId };
  });
  app.post("/ordinary-json", async (request) => request.body);
  configure(app);
  registerAutomationRoutes(app, "https://api.fixture.invalid", ["https://web.fixture.invalid"]);
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const post = (payload, headers = {}) =>
    fetch(url + "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": protocol,
        ...headers,
      },
      body: JSON.stringify(payload),
    });
  const rpc = async (method, params, id = 1, headers = {}) => {
    const response = await post(
      { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) },
      headers,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^application\/json\b/u);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, id);
    assert.notEqual("result" in body, "error" in body);
    return body;
  };
  return { app, url, post, rpc, calls };
}

test("actual MCP HTTP negotiates supported versions and validates initialize params", async (t) => {
  const f = await fixture(t);
  for (const version of [protocol, "2025-03-26", "2099-01-01"]) {
    const response = await f.rpc("initialize", { ...initializeParams, protocolVersion: version });
    assert.equal(response.result.protocolVersion, protocol);
    assert.deepEqual(response.result.capabilities, {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
    });
  }
  for (const params of [
    undefined,
    null,
    [],
    {},
    { ...initializeParams, protocolVersion: 42 },
    { ...initializeParams, protocolVersion: "" },
    { protocolVersion: protocol, clientInfo: initializeParams.clientInfo },
    { ...initializeParams, capabilities: [] },
    { protocolVersion: protocol, capabilities: {} },
    { ...initializeParams, clientInfo: null },
    { ...initializeParams, clientInfo: { name: "fixture" } },
    { ...initializeParams, clientInfo: { name: "", version: "1" } },
    { ...initializeParams, clientInfo: { name: "fixture", version: 1 } },
  ])
    assert.equal((await f.rpc("initialize", params)).error.code, -32602);
  const response = await f.post({
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: initializeParams,
  });
  assert.equal(response.headers.get("mcp-session-id"), null);
  await response.json();
  assert.equal(f.calls.length, 0);
});

test("actual MCP HTTP distinguishes parse errors, invalid envelopes and valid request IDs", async (t) => {
  const f = await fixture(t);
  for (const raw of ["", "{", '{"jsonrpc":"2.0","id":1,}']) {
    const response = await fetch(f.url + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }
  for (const payload of [
    null,
    true,
    42,
    "text",
    [],
    [{ jsonrpc: "2.0", id: 1, method: "ping" }],
    {},
    { jsonrpc: "1.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", id: 1, method: 42 },
    ...[null, true, {}, [], 1.5, Number.MAX_SAFE_INTEGER + 1].map((id) => ({
      jsonrpc: "2.0",
      id,
      method: "ping",
    })),
    { jsonrpc: "2.0", id: 1, method: "ping", result: {} },
  ]) {
    const response = await f.post(payload);
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.deepEqual(await response.json(), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
  }
  for (const id of [0, -1, Number.MAX_SAFE_INTEGER, "", "request-a"])
    assert.deepEqual((await f.rpc("ping", undefined, id)).result, {});
  const ordinary = await fetch(f.url + "/ordinary-json", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(ordinary.status, 400);
  assert.equal((await ordinary.json()).code, "FST_ERR_CTP_INVALID_JSON_BODY");
  assert.equal(f.calls.length, 0);
});

test("actual MCP HTTP accepts notifications and responses without executing tools or replying", async (t) => {
  const f = await fixture(t);
  for (const payload of [
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "earlier" } },
    { jsonrpc: "2.0", method: "unknown/notification", params: {} },
    {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "qa_login", arguments: { projectId: "a", name: "never-execute" } },
    },
    { jsonrpc: "2.0", id: 0, result: {} },
    { jsonrpc: "2.0", id: "server-request", error: { code: -32601, message: "No method" } },
  ]) {
    const response = await f.post(payload);
    assert.equal(response.status, 202);
    assert.equal(await response.text(), "");
  }
  const invalidNotification = await f.post({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: [],
  });
  assert.equal(invalidNotification.status, 400);
  assert.equal(await invalidNotification.text(), "");
  for (const payload of [
    { jsonrpc: "2.0", id: 1, result: {}, error: { code: -1, message: "both" } },
    { jsonrpc: "2.0", id: 1, result: null },
    { jsonrpc: "2.0", result: {} },
    { jsonrpc: "2.0", id: 1, error: { code: "wrong", message: "wrong" } },
  ]) {
    const response = await f.post(payload);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, -32600);
  }
  assert.equal(f.calls.length, 0);
});

test("actual MCP HTTP reports protocol errors separately and retains 90 tools plus the frozen result tool", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.rpc("unknown/method", {})).error.code, -32601);
  assert.equal((await f.rpc("notifications/initialized", {})).error.code, -32601);
  for (const [method, params] of [
    ["ping", []],
    ["tools/call", undefined],
    ["tools/call", {}],
    ["tools/call", { name: "qa_login", arguments: null }],
    ["tools/call", { name: "qa_login", arguments: [] }],
    ["tools/call", { name: "does_not_exist", arguments: {} }],
    ["resources/read", {}],
    ["resources/read", { uri: 1 }],
    ["resources/read", { uri: "file:///not-a-project-resource" }],
    ["tools/list", { cursor: "unissued-cursor" }],
    ["resources/list", { cursor: 1 }],
  ])
    assert.equal((await f.rpc(method, params)).error.code, -32602);
  assert.equal(f.calls.length, 0);
  const catalog = (await f.rpc("tools/list")).result.tools;
  assert.equal(catalog.length, 91);
  assert.equal(catalog.filter((tool) => tool.name !== "qa_record_verification_result").length, 90);
  assert.equal(catalog.filter((tool) => tool.name === "qa_record_verification_result").length, 1);
  assert.deepEqual(catalog, AUTOMATION_TOOLS);
  assert.deepEqual((await f.rpc("resources/list")).result, { resources: [] });
  assert.equal((await f.rpc("resources/templates/list")).result.resourceTemplates.length, 1);
  const args = { projectId: "explicit-fixture-project", name: "fixture-employee" };
  const good = (
    await f.rpc("tools/call", { name: "qa_login", arguments: args }, 10, {
      authorization: "Bearer fixture-token",
    })
  ).result;
  assert.equal(good.isError, false);
  assert.deepEqual(good.structuredContent, { userId: "fixture-user", projectId: args.projectId });
  assert.deepEqual(JSON.parse(good.content[0].text), good.structuredContent);
  assert.deepEqual(f.calls[0], {
    body: { ...args, client: "android" },
    authorization: "Bearer fixture-token",
  });
  const failure = (
    await f.rpc("tools/call", {
      name: "qa_login",
      arguments: { ...args, name: "business-conflict" },
    })
  ).result;
  assert.equal(failure.isError, true);
  assert.deepEqual(JSON.parse(failure.content[0].text), {
    code: "TEST_BUSINESS_CONFLICT",
    status: 409,
    details: { code: "TEST_BUSINESS_CONFLICT", version: 3 },
  });
});

test("actual MCP HTTP rejects unsupported transport methods, origins and protocol headers", async (t) => {
  const f = await fixture(t);
  for (const method of ["GET", "DELETE"]) {
    const response = await fetch(f.url + "/mcp", {
      method,
      headers: { accept: "text/event-stream", "mcp-session-id": "not-a-business-session" },
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "");
  }
  for (const method of ["GET", "POST", "DELETE"]) {
    for (const origin of [
      "https://untrusted.fixture.invalid",
      "null",
      "https://api.fixture.invalid/path",
      "https://api.fixture.invalid.evil.invalid",
    ]) {
      const response = await fetch(f.url + "/mcp", { method, headers: { origin } });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, "MCP_ORIGIN_INVALID");
    }
    for (const version of ["2024-11-05", "2025-03-26", "2025-11-25", "", "invalid"]) {
      const response = await fetch(f.url + "/mcp", {
        method,
        headers: { "mcp-protocol-version": version },
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "MCP_PROTOCOL_VERSION_UNSUPPORTED");
    }
  }
  for (const origin of ["https://api.fixture.invalid", "https://web.fixture.invalid"])
    assert.deepEqual((await f.rpc("ping", {}, 1, { origin })).result, {});
  const legacy = await fetch(f.url + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
  });
  assert.equal(legacy.status, 200);
  assert.deepEqual((await legacy.json()).result, {});
  assert.equal(f.calls.length, 0);
});

test("actual MCP HTTP stops attachment materialization when an upstream page repeats its cursor", async (t) => {
  let pages = 0;
  const f = await fixture(t, (app) => {
    app.get("/api/v1/bugs/:bugId/attachments", async () => {
      pages++;
      return { items: [], nextCursor: "repeated-upstream-cursor" };
    });
  });
  const result = (
    await f.rpc("tools/call", {
      name: "qa_materialize_attachment",
      arguments: { projectId: randomUUID(), bugId: randomUUID(), attachmentId: randomUUID() },
    })
  ).result;
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).code, "INVALID_RESPONSE");
  assert.equal(pages, 2);
});

test("actual MCP HTTP and SQLite GM login persists the selected project and rejects conflicting scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-mcp-protocol-gm-"));
  const worker = new SqliteStorageWorker({
    databaseFile: join(root, "test.sqlite"),
    backupRoot: join(root, "backups"),
    busyTimeoutMs: 1000,
  });
  const app = Fastify({ logger: false });
  const accountId = randomUUID(),
    actorId = randomUUID(),
    projectId = randomUUID(),
    otherProjectId = randomUUID();
  try {
    await worker.ensureMobileScope({
      accountId,
      actorId,
      projectId,
      membershipId: projectMembershipId(projectId, actorId),
      projectKey: "GMCP",
      actorDisplayName: "Protocol GM fixture",
      createdAt: new Date().toISOString(),
    });
    await worker.projectManagement({
      accountId,
      actorId,
      isGm: true,
      operation: "create",
      projectId: otherProjectId,
      key: "GMCPB",
      name: "Protocol GM fixture B",
      now: new Date().toISOString(),
    });
    registerBrowserAuthRoutes(app, {
      store: createSqliteBrowserAuthStore({ worker }),
      accountId,
      userId: actorId,
      actorId,
      adminEmail: "gm-protocol@fixture.invalid",
      cookieName: "qa-protocol-gm-test",
      passwordlessLogin: async () => {
        throw Error("unused in GM fixture");
      },
      sessionSecret: "isolated-gm-protocol-test-secret",
      webOrigins: [],
      gm: { userId: actorId, password: "isolated-gm-fixture-password" },
    });
    registerAutomationRoutes(app, "https://gm-protocol.fixture.invalid");
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const call = (args, rpc = true) =>
      fetch(url + (rpc ? "/mcp" : "/api/v1/mcp/call"), {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": protocol },
        body: JSON.stringify(
          rpc
            ? {
                jsonrpc: "2.0",
                id: randomUUID(),
                method: "tools/call",
                params: { name: "qa_login_gm", arguments: args },
              }
            : { name: "qa_login_gm", arguments: args },
        ),
      });
    for (const [selected, args] of [
      [
        otherProjectId,
        { projectId: otherProjectId, request: { password: "isolated-gm-fixture-password" } },
      ],
      [projectId, { request: { projectId, password: "isolated-gm-fixture-password" } }],
      [
        otherProjectId,
        {
          projectId: otherProjectId,
          request: { projectId: otherProjectId, password: "isolated-gm-fixture-password" },
        },
      ],
    ]) {
      const response = await call(args);
      assert.equal(response.status, 200);
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      const principal = result.structuredContent;
      assert.equal(principal.userId, actorId);
      assert.equal(principal.projectId, selected);
      assert.equal(principal.isGm, true);
      const me = await fetch(url + "/api/v1/auth/me", {
        headers: { authorization: `Bearer ${principal.accessToken}` },
      });
      assert.equal(me.status, 200);
      assert.equal((await me.json()).projectId, selected);
    }
    const conflict = {
      projectId,
      request: { projectId: otherProjectId, password: "isolated-gm-fixture-password" },
    };
    const rpcResult = (await (await call(conflict)).json()).result;
    assert.equal(rpcResult.isError, true);
    assert.equal(JSON.parse(rpcResult.content[0].text).code, "PROJECT_MISMATCH");
    const httpConflict = await call(conflict, false);
    assert.equal(httpConflict.status, 400);
    assert.equal((await httpConflict.json()).code, "PROJECT_MISMATCH");
    const httpGood = await call(
      { projectId: otherProjectId, request: { password: "isolated-gm-fixture-password" } },
      false,
    );
    assert.equal(httpGood.status, 200);
    assert.equal((await httpGood.json()).projectId, otherProjectId);
  } finally {
    await app.close();
    await worker.close();
  }
});
