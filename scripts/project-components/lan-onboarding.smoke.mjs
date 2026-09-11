import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";

const config = readParallelInstanceConfig(process.argv[2]);
if (config.deploymentMode !== "lan") throw new Error("LAN_CONFIGURATION_REQUIRED");
const secrets = JSON.parse(readFileSync(config.secretsFile, "utf8"));
const api = `${config.publicWebBaseUrl}/api/v1`;
const publicHost = new URL(config.publicWebBaseUrl).hostname;
const mcp = `http://${publicHost}:${config.mcpPort}`;
const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const checks = [];
const createdProjects = [];
let gmToken;
let rpcId = 0;
let passed = false;
let failure = null;

async function http(label, method, path, options = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      accept: "application/vnd.relay-qa-hub.v1.1+json",
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.projectId ? { "x-qa-project-id": options.projectId } : {}),
      ...(options.key ? { "idempotency-key": options.key } : {}),
      ...options.headers,
    },
    ...(options.body === undefined
      ? {}
      : { body: Buffer.isBuffer(options.body) ? options.body : JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let value = bytes;
  if (!options.binary) value = bytes.length ? JSON.parse(bytes.toString("utf8")) : null;
  checks.push({
    label,
    surface: "http",
    method,
    path,
    status: response.status,
    expectedStatus: options.status ?? 200,
    ...(options.binary ? { bytes: bytes.length, sha256: sha256(bytes) } : {}),
  });
  assert.equal(response.status, options.status ?? 200, `${label}: unexpected HTTP status`);
  return { value, headers: response.headers };
}

async function rpc(label, method, params, token) {
  const response = await fetch(`${mcp}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const envelope = await response.json();
  checks.push({
    label,
    surface: "server_mcp",
    method,
    tool: params?.name,
    status: response.status,
  });
  assert.equal(response.status, 200, `${label}: MCP transport failed`);
  assert.equal(envelope.error, undefined, `${label}: MCP protocol error`);
  return envelope.result;
}

async function tool(label, name, args, token, expectedError) {
  const result = await rpc(label, "tools/call", { name, arguments: args }, token);
  const value = result.structuredContent ?? JSON.parse(result.content[0].text);
  assert.equal(Boolean(result.isError), Boolean(expectedError), `${label}: MCP outcome mismatch`);
  if (expectedError) assert.equal(value.code, expectedError, label);
  return value;
}

async function initialize(label, projectName, initialMembers) {
  const created = (
    await http(`GM creates ${label}`, "POST", "/gm/projects", {
      token: gmToken,
      body: {},
    })
  ).value;
  createdProjects.push(created.id);
  const token = decodeURIComponent(created.initializationLink.split("#initialize=")[1]);
  const completed = (
    await http(`${label} initializes`, "POST", "/project-initialization/complete", {
      body: {
        token,
        name: projectName,
        initialMembers,
        logo: { mediaType: "image/png", dataBase64: png.toString("base64") },
      },
    })
  ).value;
  await http(`${label} consumed token rejects replay`, "POST", "/project-initialization/complete", {
    body: {
      token,
      name: projectName,
      initialMembers,
      logo: { mediaType: "image/png", dataBase64: png.toString("base64") },
    },
    status: 409,
  });
  await http(`${label} consumed token rejects inspect`, "POST", "/project-initialization/inspect", {
    body: { token },
    status: 404,
  });
  return { id: completed.id, name: completed.joinName, code: completed.joinCode };
}

async function uploadAttachment(project, principal) {
  const submissionId = randomUUID();
  const clientAttachmentId = randomUUID();
  const base = {
    submissionContractVersion: "1.1.0",
    clientSubmissionId: submissionId,
    clientAttachmentId,
    uploadAttempt: 1,
  };
  const key = (suffix) =>
    `submission:${submissionId}:attachment:${clientAttachmentId}:upload:1:${suffix}`;
  const init = (
    await http("HTTP upload init", "POST", "/uploads/init", {
      token: principal.accessToken,
      projectId: project.id,
      key: key("init"),
      status: 201,
      body: {
        ...base,
        projectId: project.id,
        filename: "lan-acceptance.png",
        mediaType: "image/png",
        expectedSize: png.length,
        sha256: sha256(png),
      },
    })
  ).value;
  const chunk = await http("HTTP upload chunk", "PUT", `/uploads/${init.sessionId}/chunks/0`, {
    token: principal.accessToken,
    projectId: project.id,
    key: key("chunk:0"),
    status: 204,
    body: png,
    headers: {
      "content-type": "application/octet-stream",
      "x-chunk-sha256": sha256(png),
      "if-match": `"${init.version}"`,
      "x-client-submission-id": submissionId,
      "x-client-attachment-id": clientAttachmentId,
    },
  });
  const version = Number(chunk.headers.get("x-upload-version"));
  const finalized = (
    await http("HTTP upload finalize", "POST", `/uploads/${init.sessionId}/finalize`, {
      token: principal.accessToken,
      projectId: project.id,
      key: key("finalize"),
      body: { ...base, expectedVersion: version, expectedSize: png.length, sha256: sha256(png) },
    })
  ).value;
  const bindKey = `submission:${submissionId}:attachment:${clientAttachmentId}:bind:1`;
  await http("HTTP attachment bind", "POST", `/attachments/${finalized.attachmentId}/bind`, {
    token: principal.accessToken,
    projectId: project.id,
    key: bindKey,
    body: {
      ...base,
      projectId: project.id,
      leaseGeneration: 1,
      expectedVersion: finalized.version,
      intent: "bug_create",
    },
  });
  return { submissionId, attachmentId: finalized.attachmentId };
}

try {
  const page = await fetch(config.publicWebBaseUrl, { signal: AbortSignal.timeout(15_000) });
  checks.push({ label: "LAN Web landing", surface: "web", status: page.status });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root"><\/div>/u);
  assert.equal((await http("LAN readiness", "GET", "/health/ready")).value.status, "ready");
  assert.equal((await fetch(`${mcp}/health`)).status, 200);

  const gm = (
    await http("GM login", "POST", "/auth/gm/login", {
      body: { password: secrets.gmPassword, client: "android" },
    })
  ).value;
  assert.equal(gm.isGm, true);
  gmToken = gm.accessToken;
  const suffix = runId.replaceAll("-", "").slice(-12);
  const projectA = await initialize(`acceptance A ${suffix}`, `LAN验收A-${suffix}`, ["同名成员"]);
  const projectB = await initialize(`acceptance B ${suffix}`, `LAN验收B-${suffix}`, ["同名成员"]);

  const wrong = (
    await http("wrong code is indistinguishable", "POST", "/auth/login", {
      status: 401,
      body: { projectName: projectA.name, code: "9999", name: "错误尝试", client: "android" },
    })
  ).value;
  const missing = (
    await http("missing project is indistinguishable", "POST", "/auth/login", {
      status: 401,
      body: { projectName: "不存在项目", code: "9999", name: "错误尝试", client: "android" },
    })
  ).value;
  assert.deepEqual(missing, wrong);
  const employeeName = `LAN验收员工-${suffix}`;
  const aPrincipal = (
    await http("HTTP name and code login", "POST", "/auth/login", {
      body: {
        projectName: projectA.name,
        code: projectA.code,
        name: employeeName,
        client: "android",
      },
    })
  ).value;
  assert.equal(aPrincipal.projectId, projectA.id);
  const visible = (
    await http("HTTP principal sees only A", "GET", "/projects", {
      token: aPrincipal.accessToken,
    })
  ).value;
  assert.deepEqual(
    visible.items.map((item) => item.id),
    [projectA.id],
  );
  const logo = await http("authenticated project logo", "GET", `/projects/${projectA.id}/logo`, {
    token: aPrincipal.accessToken,
    projectId: projectA.id,
    binary: true,
  });
  assert.equal(sha256(logo.value), sha256(png));

  const attachment = await uploadAttachment(projectA, aPrincipal);
  const bug = (
    await http("HTTP Bug with attachment", "POST", "/bugs", {
      token: aPrincipal.accessToken,
      projectId: projectA.id,
      key: `submission:${attachment.submissionId}:commit`,
      status: 201,
      body: {
        submissionContractVersion: "1.1.0",
        projectId: projectA.id,
        clientSubmissionId: attachment.submissionId,
        title: "LAN v2.2 HTTP/MCP 有界验收",
        description: "仅属于停用验收项目的真实记录",
        expectedBehavior: "附件、评论、状态和项目隔离可用",
        severity: "S3",
        priority: "P3",
        attachmentIds: [attachment.attachmentId],
        occurrence: {
          observedAt: new Date().toISOString(),
          platform: "web",
          steps: ["通过 LAN Web 代理调用 HTTP API"],
          actualBehavior: "真实写入新隔离实例",
        },
      },
    })
  ).value.bug;
  const attachmentBytes = await http(
    "HTTP attachment readback",
    "GET",
    `/attachments/${attachment.attachmentId}`,
    { token: aPrincipal.accessToken, projectId: projectA.id, binary: true },
  );
  assert.equal(sha256(attachmentBytes.value), sha256(png));

  await rpc("MCP initialize", "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "lan-onboarding-acceptance", version: "2.2" },
  });
  const catalog = await rpc("MCP tool inventory", "tools/list", {});
  for (const name of [
    "qa_login",
    "qa_list_bugs",
    "qa_add_comment",
    "qa_read_attachment",
    "qa_bug_action",
  ])
    assert.ok(
      catalog.tools.some((item) => item.name === name),
      name,
    );
  const mcpA = await tool("MCP name and code login A", "qa_login", {
    projectName: projectA.name,
    code: projectA.code,
    name: employeeName,
  });
  assert.equal(mcpA.userId, aPrincipal.userId);
  const mcpB = await tool("MCP name and code login B", "qa_login", {
    projectName: projectB.name,
    code: projectB.code,
    name: employeeName,
  });
  assert.notEqual(mcpB.userId, mcpA.userId);
  const list = await tool(
    "MCP lists A Bug",
    "qa_list_bugs",
    { projectId: projectA.id, filters: { limit: 100 } },
    mcpA.accessToken,
  );
  assert.ok(list.items.some((item) => item.id === bug.id));
  await tool(
    "MCP comment",
    "qa_add_comment",
    {
      projectId: projectA.id,
      bugId: bug.id,
      request: { clientSubmissionId: randomUUID(), body: "LAN v2.2 MCP 真实评论" },
    },
    mcpA.accessToken,
  );
  const readAttachment = await tool(
    "MCP reads attachment",
    "qa_read_attachment",
    { projectId: projectA.id, bugId: bug.id, attachmentId: attachment.attachmentId },
    mcpA.accessToken,
  );
  assert.equal(sha256(Buffer.from(readAttachment.blob, "base64")), sha256(png));
  const completed = await tool(
    "MCP advances Bug status",
    "qa_bug_action",
    {
      projectId: projectA.id,
      bugId: bug.id,
      action: "manual_complete",
      expectedVersion: bug.version,
      note: "LAN 有界验收状态变更",
      idempotencyKey: `lan-acceptance:${randomUUID()}`,
    },
    mcpA.accessToken,
  );
  assert.equal(completed.bug.state, "ready_for_verification");
  await tool(
    "MCP B cannot read A",
    "qa_list_bugs",
    { projectId: projectA.id, filters: { limit: 100 } },
    mcpB.accessToken,
    "PROJECT_NOT_ACCESSIBLE",
  );
  await http("notification list remains available", "GET", "/notifications", {
    token: aPrincipal.accessToken,
    projectId: projectA.id,
  });
  passed = true;
} catch (error) {
  failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  if (gmToken && createdProjects.length > 0) {
    try {
      const admin = (
        await http("GM final project readback", "GET", "/gm/projects", { token: gmToken })
      ).value.items;
      for (const projectId of createdProjects) {
        const current = admin.find((item) => item.id === projectId);
        if (current?.active)
          await http("GM disables acceptance project", "PATCH", `/gm/projects/${projectId}`, {
            token: gmToken,
            body: { active: false, expectedVersion: current.version },
          });
      }
    } catch (error) {
      failure ??= { name: error.name, message: "acceptance project cleanup failed" };
      process.exitCode = 1;
    }
  }
  const evidenceRoot = join(config.logsRoot, "acceptance");
  mkdirSync(evidenceRoot, { recursive: true });
  const evidence = join(evidenceRoot, `lan-onboarding-${runId}.json`);
  const safe = {
    runId,
    instanceId: config.instanceId,
    publicWebBaseUrl: config.publicWebBaseUrl,
    serverMcpBaseUrl: mcp,
    passed,
    failure,
    projectIds: createdProjects,
    checks,
    boundaries: {
      publicLanAddressUsed: true,
      testProjectsDisabledAfterRun: passed,
      noInitializationCredentialPersisted: true,
      noJoinCodePersisted: true,
      secondIndependentDeviceTested: false,
    },
  };
  const serialized = `${JSON.stringify(safe, null, 2)}\n`;
  assert.equal(/#initialize=|"joinCode"|"code":\s*"\d{4}"/u.test(serialized), false);
  writeFileSync(evidence, serialized, { flag: "wx" });
  console.log(JSON.stringify({ passed, checks: checks.length, evidence }));
}
