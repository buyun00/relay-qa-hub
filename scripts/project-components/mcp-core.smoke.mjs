import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import assert from "node:assert/strict";
import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";

const config = readParallelInstanceConfig(process.argv[2]);
const projectId = process.argv[3];
if (!projectId) throw new Error("Explicit test project ID is required");
const desktop = process.argv[4] === "--desktop";
const url = `http://${config.apiHost}:${desktop ? config.desktopMcpPort : config.mcpPort}/mcp`;
const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const checks = [];
let token;
let passed = false;
let counter = 0;
function redact(value, depth = 0) {
  if (depth > 64) return "[REDACTED_NESTING_LIMIT]";
  if (typeof value === "string") {
    try {
      // MCP mirrors structured results inside content[].text. Decode containers
      // and repeated string encoding without normalizing primitive text such as "2.0".
      const decoded = JSON.parse(value);
      if (decoded !== null && typeof decoded === "object")
        return JSON.stringify(redact(decoded, depth + 1));
      if (typeof decoded === "string") {
        const cleaned = redact(decoded, depth + 1);
        return cleaned === decoded ? value : JSON.stringify(cleaned);
      }
      return value;
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/token|secret|password|cookie|authorization|private.?key|api.?key|credential/iu.test(
              key,
            ),
        )
        .map(([key, item]) => [key, redact(item, depth + 1)]),
    );
  }
  return value;
}
async function rpc(method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++counter, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.json();
  checks.push({
    method,
    tool: params?.name,
    httpStatus: response.status,
    result: redact(value),
    recordedAt: new Date().toISOString(),
  });
  assert.equal(response.status, 200);
  assert.equal(value.error, undefined);
  return value.result;
}
async function tool(name, args, errorCode) {
  const result = await rpc("tools/call", { name, arguments: args });
  const value = result.structuredContent ?? JSON.parse(result.content[0].text);
  if (errorCode) {
    assert.equal(result.isError, true);
    assert.equal(value.code, errorCode);
  } else assert.equal(result.isError, false, JSON.stringify(value));
  return value;
}
try {
  const ready = await fetch(
    desktop
      ? `http://${config.apiHost}:${config.apiPort}/api/v1/health/ready`
      : `http://${config.apiHost}:${config.mcpPort}/health`,
  ).then((r) => r.json());
  assert.equal(ready.status, "ready");
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "real-preview-acceptance", version: "1" },
  });
  const catalog = await rpc("tools/list", {});
  assert.ok(catalog.tools.some((t) => t.name === "qa_bug_action"));
  const principal = await tool("qa_login", {
    projectId,
    name: process.argv[5] ?? `MCP真实验收${Date.now()}`,
  });
  token = principal.accessToken;
  if (!desktop) assert.ok(token);
  const own = await tool("qa_list_projects", {});
  assert.deepEqual(
    own.items.map((p) => p.id),
    [projectId],
  );
  const submission = randomUUID();
  const creation = await tool("qa_create_bug", {
    projectId,
    request: {
      submissionContractVersion: "1.1.0",
      clientSubmissionId: submission,
      title: "服务端MCP真实人工闭环",
      description: "不依赖新版EXE进程的真实MCP验收",
      expectedBehavior: "完整人工作业",
      severity: "S3",
      priority: "P3",
      occurrence: {
        observedAt: new Date().toISOString(),
        platform: "web",
        steps: ["通过独立MCP创建"],
        actualBehavior: "验证每个真实状态",
      },
    },
  });
  let bug = creation.bug;
  const commentId = randomUUID();
  await tool("qa_add_comment", {
    projectId,
    bugId: bug.id,
    request: { clientSubmissionId: commentId, body: "真实MCP评论正文" },
  });
  const comments = await tool("qa_list_comments", { projectId, bugId: bug.id });
  assert.ok(comments.items.some((c) => c.body === "真实MCP评论正文"));
  const done = await tool("qa_bug_action", {
    projectId,
    bugId: bug.id,
    action: "manual_complete",
    expectedVersion: bug.version,
    note: "人工修复已交付，等待验收",
    idempotencyKey: `mcp-test:${randomUUID()}`,
  });
  bug = done.bug;
  assert.equal(bug.state, "ready_for_verification");
  let context = await tool("qa_get_bug_context", { projectId, bugId: bug.id });
  const attempt = context.humanWorkflow.repairAttempt;
  assert.ok(attempt?.id);
  const verification = await tool("qa_bug_action", {
    projectId,
    bugId: bug.id,
    action: "create_verification",
    expectedVersion: bug.version,
    idempotencyKey: `mcp-test:${randomUUID()}`,
    request: {
      repairAttemptId: attempt.id,
      buildId: null,
      verifierId: principal.userId,
      criteria: "在无可选组件下实际验收",
    },
  });
  const started = await tool("qa_bug_action", {
    projectId,
    bugId: bug.id,
    action: "start_verification",
    verificationId: verification.result.id,
    expectedVersion: verification.result.version,
    idempotencyKey: `mcp-test:${randomUUID()}`,
  });
  const accepted = await tool("qa_bug_action", {
    projectId,
    bugId: bug.id,
    action: "close",
    verificationId: started.result.id,
    expectedVersion: started.result.version,
    idempotencyKey: `mcp-test:${randomUUID()}`,
    request: {
      submissionContractVersion: "1.1.0",
      clientSubmissionId: randomUUID(),
      resultSummary: "已真实核验通过",
      attachmentIds: [],
    },
  });
  bug = accepted.bug;
  assert.equal(bug.state, "closed");
  context = await tool("qa_get_bug_context", { projectId, bugId: bug.id });
  assert.equal(context.bug.state, "closed");
  assert.equal(context.humanWorkflow.verification, null);
  assert.equal(context.humanWorkflow.latestVerification.status, "passed");
  passed = true;
} finally {
  const root = join(config.sourceRoot, "docs/evidence/project-components/runs");
  mkdirSync(root, { recursive: true });
  const evidence = join(root, `${desktop ? "desktop" : "server"}-mcp-core-${runId}.json`);
  writeFileSync(
    evidence,
    JSON.stringify(
      {
        runId,
        instanceId: config.instanceId,
        projectId,
        url,
        passed,
        checks,
        note: "Real MCP transport and isolated API/SQLite. Remaining tools and platform acceptance are not implied.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(JSON.stringify({ passed, checks: checks.length, evidence }));
}
