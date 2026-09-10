import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readParallelInstanceConfig } from "../../../../../apps/api/src/parallel-instance.ts";

const config = readParallelInstanceConfig(process.argv[2]);
const outputPath = resolve(
  process.argv[3] ??
    join(dirname(fileURLToPath(import.meta.url)), "http-server-local-mcp-attachment-parity.json"),
);
const projectId = process.argv[4] ?? "10000000-0000-4000-8000-000000000004";
const loginName = process.argv[5] ?? "Luna Worker 246";
const apiOrigin = `http://${config.apiHost}:${config.apiPort}`;
const endpoints = {
  server: `http://${config.apiHost}:${config.mcpPort}/mcp`,
  local: `http://${config.apiHost}:${config.desktopMcpPort}/mcp`,
};
const startedAt = new Date().toISOString();
const runSuffix = startedAt.replace(/\D/gu, "").slice(0, 14);
const httpChecks = [];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function request(label, path, options = {}, expectedStatus = 200) {
  const response = await fetch(apiOrigin + path, {
    ...options,
    signal: AbortSignal.timeout(15_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let body = null;
  if (bytes.length > 0 && response.headers.get("content-type")?.includes("json")) {
    body = JSON.parse(bytes.toString("utf8"));
  }
  httpChecks.push({
    label,
    method: options.method ?? "GET",
    path: path.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/giu, ":uuid"),
    expectedStatus,
    status: response.status,
  });
  assert.equal(response.status, expectedStatus, `${label}: ${bytes.toString("utf8")}`);
  return { response, bytes, body };
}

function json(body, token, idempotencyKey) {
  return {
    method: "POST",
    headers: {
      accept: "application/vnd.relay-qa-hub.v1.1+json",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-qa-project-id": projectId,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  };
}

function parseToolValue(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string", "MCP tool result must contain structured data");
  return JSON.parse(text);
}

async function openMcp(label, endpoint) {
  let id = 0;
  let bearer;
  const calls = [];
  async function rpc(method, params) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    const value = await response.json();
    assert.equal(response.status, 200, `${label} ${method} HTTP status`);
    assert.equal(value.error, undefined, `${label} ${method} JSON-RPC error`);
    calls.push({ method, tool: params?.name, status: response.status });
    return value.result;
  }
  async function tool(name, args, expectedErrorCode) {
    const result = await rpc("tools/call", { name, arguments: args });
    const value = parseToolValue(result);
    if (expectedErrorCode) {
      assert.equal(result.isError, true, `${label} ${name} should fail`);
      assert.equal(value.code, expectedErrorCode, `${label} ${name} error code`);
    } else {
      assert.equal(result.isError, false, `${label} ${name}: ${JSON.stringify(value)}`);
    }
    return { protocol: result, value };
  }
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "v21-attachment-parity", version: "1" },
  });
  const catalog = await rpc("tools/list", {});
  for (const required of ["qa_login", "qa_list_attachments", "qa_materialize_attachment"]) {
    assert.ok(catalog.tools.some((entry) => entry.name === required), `${label} missing ${required}`);
  }
  const login = await tool("qa_login", { projectId, name: loginName });
  assert.equal(login.value.projectId, projectId);
  if (label === "server") {
    bearer = login.value.accessToken;
    assert.equal(typeof bearer, "string");
  } else {
    // The local desktop bridge retains its Web session internally and intentionally
    // does not return a bearer token to the loopback MCP client.
    assert.equal(login.value.accessToken, undefined);
  }
  return {
    label,
    endpoint,
    initialized,
    toolCount: catalog.tools.length,
    userId: login.value.userId,
    calls,
    tool,
  };
}

const ready = await request("isolated API readiness", "/api/v1/health/ready");
assert.equal(ready.body.status, "ready");
assert.equal(ready.body.schemaVersion, "20");

const login = await request(
  "HTTP same-name login",
  "/api/v1/auth/login",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, name: loginName, client: "android" }),
  },
);
const token = login.body.accessToken;
assert.equal(typeof token, "string");

const fixture = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const fixtureSha256 = sha256(fixture);
const clientSubmissionId = randomUUID();
const clientAttachmentId = randomUUID();
const uploadAttempt = 1;
const initBody = {
  submissionContractVersion: "1.1.0",
  projectId,
  clientSubmissionId,
  clientAttachmentId,
  uploadAttempt,
  filename: `v21-http-mcp-parity-${runSuffix}.png`,
  mediaType: "image/png",
  expectedSize: fixture.length,
  sha256: fixtureSha256,
};
const keys = {
  init: `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:upload:${uploadAttempt}:init`,
  chunk: `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:upload:${uploadAttempt}:chunk:0`,
  finalize: `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:upload:${uploadAttempt}:finalize`,
  bind: `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:bind:1`,
  commit: `submission:${clientSubmissionId}:commit`,
};
const rejectedKey = `invalid:${randomUUID()}`;

const rejectedInit = await request(
  "wrong idempotency key rejected without durable mutation",
  "/api/v1/uploads/init",
  json(initBody, token, rejectedKey),
  400,
);
assert.equal(rejectedInit.body.code, "INVALID_REQUEST");

const init = await request("upload init", "/api/v1/uploads/init", json(initBody, token, keys.init), 201);
const initReplay = await request(
  "upload init replay",
  "/api/v1/uploads/init",
  json(initBody, token, keys.init),
  201,
);
assert.equal(initReplay.body.sessionId, init.body.sessionId);
assert.equal(initReplay.body.version, init.body.version);
assert.equal(initReplay.body.replayed, true);
assert.equal(init.body.status, "open");

function chunkOptions(expectedVersion) {
  return {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "x-qa-project-id": projectId,
      "content-type": "application/octet-stream",
      "content-length": String(fixture.length),
      "if-match": `"${expectedVersion}"`,
      "x-chunk-sha256": fixtureSha256,
      "x-client-submission-id": clientSubmissionId,
      "x-client-attachment-id": clientAttachmentId,
      "idempotency-key": keys.chunk,
    },
    body: fixture,
  };
}
const chunk = await request(
  "upload chunk",
  `/api/v1/uploads/${init.body.sessionId}/chunks/0`,
  chunkOptions(init.body.version),
  204,
);
const chunkVersion = Number(chunk.response.headers.get("x-upload-version"));
assert.ok(Number.isInteger(chunkVersion));
const chunkReplay = await request(
  "upload chunk replay",
  `/api/v1/uploads/${init.body.sessionId}/chunks/0`,
  chunkOptions(init.body.version),
  204,
);
assert.equal(Number(chunkReplay.response.headers.get("x-upload-version")), chunkVersion);

const finalizeBody = {
  submissionContractVersion: "1.1.0",
  expectedVersion: chunkVersion,
  clientSubmissionId,
  clientAttachmentId,
  uploadAttempt,
  sha256: fixtureSha256,
  expectedSize: fixture.length,
};
const finalized = await request(
  "upload finalize",
  `/api/v1/uploads/${init.body.sessionId}/finalize`,
  json(finalizeBody, token, keys.finalize),
);
const finalizeReplay = await request(
  "upload finalize replay",
  `/api/v1/uploads/${init.body.sessionId}/finalize`,
  json(finalizeBody, token, keys.finalize),
);
assert.equal(finalizeReplay.body.attachmentId, finalized.body.attachmentId);
assert.equal(finalizeReplay.body.version, finalized.body.version);
assert.equal(finalizeReplay.body.replayed, true);
assert.equal(finalized.body.sha256, fixtureSha256);
assert.equal(finalized.body.readyToBind, true);

const bindBody = {
  submissionContractVersion: "1.1.0",
  expectedVersion: finalized.body.version,
  projectId,
  clientSubmissionId,
  clientAttachmentId,
  leaseGeneration: 1,
  intent: "bug_create",
};
const bind = await request(
  "attachment bind",
  `/api/v1/attachments/${finalized.body.attachmentId}/bind`,
  json(bindBody, token, keys.bind),
);
const bindReplay = await request(
  "attachment bind replay",
  `/api/v1/attachments/${finalized.body.attachmentId}/bind`,
  json(bindBody, token, keys.bind),
);
assert.equal(bindReplay.body.bindingId, bind.body.bindingId);
assert.equal(bindReplay.body.version, bind.body.version);
assert.equal(bindReplay.body.replayed, true);

const bugBody = {
  submissionContractVersion: "1.1.0",
  projectId,
  clientSubmissionId,
  title: `V21_HTTP_SERVER_LOCAL_MCP_ATTACHMENT_PARITY_${runSuffix}`,
  description: "同一隔离附件由 HTTP、server MCP 与 local MCP 读取并校验",
  expectedBehavior: "三个入口读取同一项目、Bug、附件、大小与 SHA-256",
  severity: "S3",
  priority: "P3",
  attachmentIds: [finalized.body.attachmentId],
  occurrence: {
    observedAt: new Date().toISOString(),
    platform: "web",
    steps: ["HTTP 上传并创建", "server MCP 读取", "local MCP 下载"],
    actualBehavior: "隔离验收记录",
  },
};
const created = await request("create attachment Bug", "/api/v1/bugs", json(bugBody, token, keys.commit), 201);
const createReplay = await request(
  "create attachment Bug replay",
  "/api/v1/bugs",
  json(bugBody, token, keys.commit),
  201,
);
assert.equal(createReplay.body.bug.id, created.body.bug.id);
assert.equal(createReplay.body.bug.key, created.body.bug.key);
const bugId = created.body.bug.id;

const controlSubmissionId = randomUUID();
const control = await request(
  "create no-attachment control Bug",
  "/api/v1/bugs",
  json(
    {
      ...bugBody,
      clientSubmissionId: controlSubmissionId,
      title: `V21_ATTACHMENT_NEGATIVE_CONTROL_${runSuffix}`,
      attachmentIds: [],
    },
    token,
    `submission:${controlSubmissionId}:commit`,
  ),
  201,
);
const controlBugId = control.body.bug.id;

const httpList = await request(
  "HTTP attachment readback",
  `/api/v1/bugs/${bugId}/attachments?limit=50`,
  { headers: { authorization: `Bearer ${token}`, "x-qa-project-id": projectId } },
);
assert.equal(httpList.body.items.length, 1);
assert.equal(httpList.body.items[0].attachmentId, finalized.body.attachmentId);
assert.equal(httpList.body.items[0].sha256, fixtureSha256);
const httpControlList = await request(
  "HTTP wrong Bug has no attachment",
  `/api/v1/bugs/${controlBugId}/attachments?limit=50`,
  { headers: { authorization: `Bearer ${token}`, "x-qa-project-id": projectId } },
);
assert.equal(httpControlList.body.items.length, 0);
const download = await request(
  "HTTP attachment bytes",
  `/api/v1/attachments/${finalized.body.attachmentId}`,
  { headers: { authorization: `Bearer ${token}`, "x-qa-project-id": projectId } },
);
assert.equal(download.bytes.length, fixture.length);
assert.equal(sha256(download.bytes), fixtureSha256);

const mcpEvidence = {};
for (const [surface, endpoint] of Object.entries(endpoints)) {
  const mcp = await openMcp(surface, endpoint);
  assert.equal(mcp.userId, login.body.userId, `${surface} same-name identity must be stable`);
  const listed = await mcp.tool("qa_list_attachments", { projectId, bugId });
  assert.equal(listed.value.items.length, 1);
  assert.equal(listed.value.items[0].attachmentId, finalized.body.attachmentId);
  assert.equal(listed.value.items[0].sha256, fixtureSha256);
  const materialized = await mcp.tool("qa_materialize_attachment", {
    projectId,
    bugId,
    attachmentId: finalized.body.attachmentId,
  });
  const materializedReplay = await mcp.tool("qa_materialize_attachment", {
    projectId,
    bugId,
    attachmentId: finalized.body.attachmentId,
  });
  const expectedError = "ATTACHMENT_NOT_BOUND_TO_BUG";
  const denied = await mcp.tool(
    "qa_materialize_attachment",
    { projectId, bugId: controlBugId, attachmentId: finalized.body.attachmentId },
    expectedError,
  );
  const common = {
    endpoint,
    serverName: mcp.initialized.serverInfo.name,
    serverVersion: mcp.initialized.serverInfo.version,
    toolCount: mcp.toolCount,
    sameUserIdAsHttp: true,
    listedItemCount: listed.value.items.length,
    attachmentId: listed.value.items[0].attachmentId,
    size: listed.value.items[0].size,
    sha256: listed.value.items[0].sha256,
    errorBoundary: { code: denied.value.code, isError: denied.protocol.isError },
    calls: mcp.calls,
  };
  if (surface === "server") {
    assert.equal(materialized.value.projectId, projectId);
    assert.equal(materialized.value.bugId, bugId);
    assert.equal(materialized.value.attachment.attachmentId, finalized.body.attachmentId);
    assert.equal(materialized.value.attachment.sha256, fixtureSha256);
    assert.equal(materializedReplay.value.downloadUrl, materialized.value.downloadUrl);
    assert.equal(materializedReplay.value.resource.uri, materialized.value.resource.uri);
    mcpEvidence[surface] = {
      ...common,
      materialized: {
        downloadPath: new URL(materialized.value.downloadUrl).pathname.replace(
          finalized.body.attachmentId,
          ":attachmentId",
        ),
        resourceUriStableOnReplay: true,
      },
    };
  } else {
    assert.equal(materialized.value.bugId, bugId);
    assert.equal(materialized.value.attachmentId, finalized.body.attachmentId);
    assert.equal(materialized.value.sha256, fixtureSha256);
    assert.equal(materialized.value.size, fixture.length);
    assert.equal(materializedReplay.value.localPath, materialized.value.localPath);
    assert.equal(materializedReplay.value.cached, true);
    const localPath = resolve(materialized.value.localPath);
    const runtimeRelativePath = relative(config.runtimeRoot, localPath);
    assert.ok(runtimeRelativePath && !runtimeRelativePath.startsWith(".."));
    const localBytes = await readFile(localPath);
    assert.equal(localBytes.length, fixture.length);
    assert.equal(sha256(localBytes), fixtureSha256);
    assert.equal((await stat(localPath)).isFile(), true);
    mcpEvidence[surface] = {
      ...common,
      materialized: {
        runtimeRelativePath: runtimeRelativePath.replaceAll("\\", "/"),
        bytes: localBytes.length,
        sha256: sha256(localBytes),
        replayUsedVerifiedCache: true,
      },
    };
  }
}

const databasePath = join(config.dataRoot, "db", "qa-hub.sqlite");
const database = new DatabaseSync(databasePath, { readOnly: true });
let databaseEvidence;
try {
  const bug = database
    .prepare("SELECT id, project_id, key, title, version FROM bugs WHERE id = ?")
    .get(bugId);
  const attachment = database
    .prepare(
      "SELECT id, project_id, upload_session_id, file_name, media_type, size_bytes, sha256, status, scan_state, version FROM attachments WHERE id = ?",
    )
    .get(finalized.body.attachmentId);
  const binding = database
    .prepare(
      "SELECT attachment_id, project_id, target_bug_id, intent, state, lease_generation, version FROM attachment_bindings WHERE attachment_id = ?",
    )
    .get(finalized.body.attachmentId);
  const relation = database
    .prepare(
      "SELECT project_id, bug_id, attachment_id, binding_id FROM bug_attachments WHERE bug_id = ? AND attachment_id = ?",
    )
    .get(bugId, finalized.body.attachmentId);
  const upload = database
    .prepare(
      "SELECT id, project_id, finalized_attachment_id, status, received_size_bytes, expected_sha256, version FROM upload_sessions WHERE id = ?",
    )
    .get(init.body.sessionId);
  const submission = database
    .prepare(
      "SELECT project_id, actor_id, client_submission_id, intent, bug_id, version FROM submissions WHERE client_submission_id = ?",
    )
    .get(clientSubmissionId);
  assert.equal(bug.project_id, projectId);
  assert.equal(attachment.project_id, projectId);
  assert.equal(attachment.sha256, fixtureSha256);
  assert.equal(Number(attachment.size_bytes), fixture.length);
  assert.equal(attachment.status, "ready");
  assert.equal(attachment.scan_state, "clean");
  assert.equal(binding.target_bug_id, bugId);
  assert.equal(binding.state, "claimed");
  assert.equal(relation.bug_id, bugId);
  assert.equal(upload.status, "finalized");
  assert.equal(upload.finalized_attachment_id, finalized.body.attachmentId);
  assert.equal(submission.project_id, projectId);
  assert.equal(submission.bug_id, bugId);
  const durableCounts = {
    uploadSessions: database
      .prepare(
        "SELECT COUNT(*) AS count FROM upload_sessions WHERE project_id = ? AND client_submission_id = ? AND client_attachment_id = ? AND upload_attempt = ?",
      )
      .get(projectId, clientSubmissionId, clientAttachmentId, uploadAttempt).count,
    uploadChunks: database
      .prepare("SELECT COUNT(*) AS count FROM upload_chunks WHERE upload_session_id = ?")
      .get(init.body.sessionId).count,
    attachments: database
      .prepare(
        "SELECT COUNT(*) AS count FROM attachments WHERE project_id = ? AND client_submission_id = ? AND client_attachment_id = ?",
      )
      .get(projectId, clientSubmissionId, clientAttachmentId).count,
    bindings: database
      .prepare("SELECT COUNT(*) AS count FROM attachment_bindings WHERE attachment_id = ?")
      .get(finalized.body.attachmentId).count,
    bugAttachmentRelations: database
      .prepare("SELECT COUNT(*) AS count FROM bug_attachments WHERE bug_id = ? AND attachment_id = ?")
      .get(bugId, finalized.body.attachmentId).count,
    submissions: database
      .prepare("SELECT COUNT(*) AS count FROM submissions WHERE client_submission_id = ?")
      .get(clientSubmissionId).count,
  };
  assert.deepEqual(durableCounts, {
    uploadSessions: 1,
    uploadChunks: 1,
    attachments: 1,
    bindings: 1,
    bugAttachmentRelations: 1,
    submissions: 1,
  });
  const integrity = database.prepare("PRAGMA integrity_check").get().integrity_check;
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
  assert.equal(integrity, "ok");
  assert.equal(foreignKeyViolations, 0);
  databaseEvidence = {
    openedReadOnlyWithWalVisible: true,
    bug,
    attachment,
    binding,
    relation,
    upload,
    submission,
    durableCountsAfterReplay: durableCounts,
    malformedIdempotencyKeyRejectedWithoutDurableMutation: true,
    integrity,
    foreignKeyViolations,
  };
} finally {
  database.close();
}

const finishedAt = new Date().toISOString();
const runtimeBuildSummary = JSON.parse(
  await readFile(resolve(dirname(outputPath), "..", "api-runtime-restart", "build-summary.json"), "utf8"),
);
assert.match(runtimeBuildSummary.sourceCommit, /^[0-9a-f]{40}$/u);
assert.match(runtimeBuildSummary.aggregateSha256, /^[0-9a-f]{64}$/u);
const evidence = {
  schemaVersion: 1,
  instanceId: config.instanceId,
  repositoryHeadCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: config.sourceRoot,
    encoding: "utf8",
  }).trim(),
  runtimeProductSourceCommit: runtimeBuildSummary.sourceCommit,
  runtimeBuildAggregateSha256: runtimeBuildSummary.aggregateSha256,
  startedAt,
  finishedAt,
  scope: {
    projectId,
    loginName,
    apiOrigin,
    serverMcp: endpoints.server,
    localMcp: endpoints.local,
    productionTouched: false,
    externalCalls: false,
  },
  passed: true,
  assertions: {
    httpUploadAndClaim: "passed",
    fiveMutatingOperationsReplayWithoutDuplicateRows: "passed",
    malformedIdempotencyKeyRejectedWithoutDurableMutation: "passed",
    httpServerLocalSameIdentityAndAttachment: "passed",
    httpAndLocalBytesEqualFixture: "passed",
    wrongBugMaterializationDeniedOnBothMcpSurfaces: "passed",
    sqliteBugAttachmentBindingUploadAndReceiptsPersisted: "passed",
  },
  record: {
    bugId,
    bugKey: created.body.bug.key,
    controlBugId,
    attachmentId: finalized.body.attachmentId,
    uploadSessionId: init.body.sessionId,
    fixture: { filename: initBody.filename, size: fixture.length, sha256: fixtureSha256 },
  },
  http: {
    checks: httpChecks,
    attachmentCount: httpList.body.items.length,
    controlAttachmentCount: httpControlList.body.items.length,
    downloadedBytes: download.bytes.length,
    downloadedSha256: sha256(download.bytes),
  },
  mcp: mcpEvidence,
  database: databaseEvidence,
  limitations: [
    "This proves the attachment metadata/materialization parity subset only; it does not imply parity for all 96 MCP tools.",
    "It uses the isolated preview runtime and deterministic PNG bytes; no production, physical device, real packaging, upload publication, Relay, or third-party system was exercised.",
    "The same wrong-Bug materialization must return ATTACHMENT_NOT_BOUND_TO_BUG on both MCP surfaces; a runtime with the earlier server NOT_FOUND behavior fails this runner.",
  ],
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
console.log(
  JSON.stringify({
    passed: true,
    outputPath,
    bugKey: evidence.record.bugKey,
    attachmentId: evidence.record.attachmentId,
    httpChecks: httpChecks.length,
    serverMcpCalls: mcpEvidence.server.calls.length,
    localMcpCalls: mcpEvidence.local.calls.length,
  }),
);
