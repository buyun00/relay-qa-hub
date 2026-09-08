import assert from "node:assert/strict";
import test from "node:test";

import { QA_HUB_MCP_INSTRUCTIONS, QaHubMcpHttpServer } from "../src/mcp-server.js";

async function post(
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("loopback Streamable HTTP MCP initializes, lists tools, and calls a tool", async (t) => {
  const server = new QaHubMcpHttpServer({
    port: 0,
    serverVersion: "test-version",
    tools: {
      definitions: [
        {
          name: "qa_test",
          title: "test",
          description: "test",
          inputSchema: { type: "object" },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
      ],
      call: async (name, argumentsValue) => ({ name, argumentsValue }),
    },
  });
  await server.start();
  t.after(async () => server.stop());
  const port = server.status.port;
  assert.equal(server.status.state, "listening");

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { status: string }).status, "ready");

  const initialized = await post(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1" },
    },
  });
  const initializeBody = (await initialized.json()) as {
    result: { protocolVersion: string; instructions: string; serverInfo: { version: string } };
  };
  assert.equal(initializeBody.result.protocolVersion, "2025-06-18");
  assert.equal(initializeBody.result.serverInfo.version, "test-version");
  assert.equal(initializeBody.result.instructions, QA_HUB_MCP_INSTRUCTIONS);

  const listed = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listBody = (await listed.json()) as { result: { tools: readonly { name: string }[] } };
  assert.deepEqual(
    listBody.result.tools.map((tool) => tool.name),
    ["qa_test"],
  );

  const called = await post(port, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "qa_test", arguments: { bug: "LOCAL-4" } },
  });
  const callBody = (await called.json()) as {
    result: { isError: boolean; structuredContent: { name: string; argumentsValue: unknown } };
  };
  assert.equal(callBody.result.isError, false);
  assert.equal(callBody.result.structuredContent.name, "qa_test");
  assert.deepEqual(callBody.result.structuredContent.argumentsValue, { bug: "LOCAL-4" });

  const notification = await post(port, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
});

test("MCP rejects browser origins that are not loopback", async (t) => {
  const server = new QaHubMcpHttpServer({
    port: 0,
    serverVersion: "test-version",
    tools: { definitions: [], call: async () => ({}) },
  });
  await server.start();
  t.after(async () => server.stop());
  const response = await post(
    server.status.port,
    { jsonrpc: "2.0", id: 1, method: "ping", params: {} },
    { Origin: "https://evil.example.test" },
  );
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as { code: string }).code, "MCP_ORIGIN_NOT_ALLOWED");
});

test("MCP validates initialization and advertises only its implemented protocol", async (t) => {
  const server = new QaHubMcpHttpServer({
    port: 0,
    serverVersion: "test",
    tools: { definitions: [], call: async () => ({}) },
  });
  await server.start();
  t.after(() => server.stop());
  const port = server.status.port;
  const invalid = await post(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  assert.equal(((await invalid.json()) as { error: { code: number } }).error.code, -32602);
  const negotiated = await post(port, {
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  assert.equal(
    ((await negotiated.json()) as { result: { protocolVersion: string } }).result.protocolVersion,
    "2025-06-18",
  );
  const unsupported = await post(
    port,
    { jsonrpc: "2.0", id: 3, method: "ping" },
    { "MCP-Protocol-Version": "2025-03-26" },
  );
  assert.equal(unsupported.status, 400);
  const fractional = await post(port, { jsonrpc: "2.0", id: 1.5, method: "ping" });
  assert.equal(fractional.status, 400);
  assert.equal(((await fractional.json()) as { error: { code: number } }).error.code, -32600);
});
