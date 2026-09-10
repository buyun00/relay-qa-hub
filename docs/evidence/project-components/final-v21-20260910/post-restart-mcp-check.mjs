import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const outputPath = process.env.QA_V21_MCP_OUTPUT_PATH;
if (!outputPath) throw new Error("QA_V21_MCP_OUTPUT_PATH is required");

function structured(result) {
  return result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "null");
}

async function check(label, port) {
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  let id = 0;
  let token;
  let serverLoginPerformed = false;
  const calls = [];
  async function rpc(method, params) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const envelope = await response.json();
    assert.equal(response.status, 200, `${label} ${method} HTTP status`);
    assert.equal(envelope.error, undefined, `${label} ${method}: ${JSON.stringify(envelope.error)}`);
    calls.push({
      method,
      ...(method === "tools/call" && typeof params?.name === "string"
        ? { toolName: params.name }
        : {}),
      status: response.status,
    });
    return envelope.result;
  }
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "v21-post-api-restart", version: "1" },
  });
  const catalog = await rpc("tools/list", {});
  assert.equal(catalog.tools.length, 96);
  assert.ok(catalog.tools.some((tool) => tool.name === "qa_list_projects"));
  const listBugsTool = catalog.tools.find((tool) => tool.name === "qa_list_bugs");
  assert.ok(listBugsTool);
  const listBugsProperties = Object.keys(listBugsTool.inputSchema?.properties ?? {});
  if (label === "server") {
    const loginCall = await rpc("tools/call", {
      name: "qa_login",
      arguments: {
        projectId: "10000000-0000-4000-8000-000000000004",
        name: "LunaV21E2E_0910_1038",
      },
    });
    assert.equal(loginCall.isError, false, "server qa_login returned an MCP error");
    const login = structured(loginCall);
    assert.equal(typeof login.accessToken, "string");
    token = login.accessToken;
    serverLoginPerformed = true;
  }
  const projectCall = await rpc("tools/call", { name: "qa_list_projects", arguments: {} });
  assert.equal(projectCall.isError, false, `${label} qa_list_projects returned an MCP error`);
  const projects = structured(projectCall);
  const projectItems = projects.items;
  assert.ok(Array.isArray(projectItems));
  const project = projectItems.find((item) => item.key === "OZDQP") ?? projectItems[0];
  assert.ok(project?.id);
  const bugCall = await rpc("tools/call", {
    name: "qa_list_bugs",
    arguments:
      listBugsProperties.includes("filters")
        ? { projectId: project.id, filters: { limit: 10 } }
        : { projectId: project.id, limit: 10 },
  });
  assert.equal(
    bugCall.isError,
    false,
    `${label} qa_list_bugs returned an MCP error (${listBugsProperties.join(",")}): ${bugCall.content?.[0]?.text ?? "unknown"}`,
  );
  const bugs = structured(bugCall);
  assert.ok(Array.isArray(bugs.items));
  return {
    label,
    endpoint,
    initialize: {
      protocolVersion: initialized.protocolVersion,
      serverName: initialized.serverInfo?.name,
      serverVersion: initialized.serverInfo?.version,
    },
    toolCount: catalog.tools.length,
    listBugsInputProperties: listBugsProperties,
    serverLoginPerformed,
    readChecks: {
      listProjects: "passed",
      visibleProjectCount: projectItems.length,
      selectedProjectId: project.id,
      listBugs: "passed",
      returnedBugCount: bugs.items.length,
    },
    calls,
  };
}

const apiReady = await fetch("http://127.0.0.1:4639/api/v1/health/ready").then((response) =>
  response.json(),
);
assert.equal(apiReady.status, "ready");
const results = [];
for (const [label, port] of [
  ["server", 4641],
  ["local", 4642],
]) {
  results.push(await check(label, port));
}
const output = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  sourceCommit: "88a6d0f9c31106f6cd3fc9edbadca0db6bf6397b",
  apiReady,
  authenticationSessionIssuedForServerMcp: true,
  businessMutationsPerformed: false,
  results,
  passed: true,
};
await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(JSON.stringify(output, null, 2));
