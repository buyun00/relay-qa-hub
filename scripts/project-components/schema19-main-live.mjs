import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { MOBILE_CAPTURE_ALLOWED_METHODS } from "@relay-qa-hub/storage";

const sourcePath = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(sourcePath), "../..");
const expectedInstancePath = resolve(
  "C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-schema19-sol-0909/instance.json",
);
const vendorMedia = "application/vnd.relay-qa-hub.v1.1+json";
const sensitiveKey =
  /token|secret|password|cookie|authorization|csrf|private.?key|api.?key|credential/iu;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function rememberSecrets(value, secrets) {
  if (Array.isArray(value)) {
    for (const item of value) rememberSecrets(item, secrets);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKey.test(key) && typeof item === "string" && item.length > 8) {
      secrets.add(item);
      continue;
    }
    if (typeof item === "string") {
      try {
        const decoded = JSON.parse(item);
        if (decoded && typeof decoded === "object") rememberSecrets(decoded, secrets);
      } catch {
        // Plain text is retained unless it equals a collected secret.
      }
    } else {
      rememberSecrets(item, secrets);
    }
  }
}

export function redactSchema19Evidence(value, secrets = new Set(), depth = 0) {
  if (depth > 64) return "[REDACTED_NESTING_LIMIT]";
  if (typeof value === "string") {
    try {
      const decoded = JSON.parse(value);
      if (decoded !== null && typeof decoded === "object") {
        return JSON.stringify(redactSchema19Evidence(decoded, secrets, depth + 1));
      }
    } catch {
      // Plain text follows the exact-secret replacement below.
    }
    let text = value;
    for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
    return text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSchema19Evidence(item, secrets, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !sensitiveKey.test(key))
        .map(([key, item]) => [key, redactSchema19Evidence(item, secrets, depth + 1)]),
    );
  }
  return value;
}

function processIdentities(ports) {
  const portList = ports.join(",");
  const command = [
    `$ports=@(${portList})`,
    "$items=@($ports|ForEach-Object{$port=$_;$listeners=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop)",
    "if($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1'){throw ('Unexpected listener '+$port)}",
    "$owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listeners[0].OwningProcess)",
    "[pscustomobject]@{port=$port;pid=[int]$owner.ProcessId;startedAt=$owner.CreationDate.ToUniversalTime().ToString('o');path=$owner.ExecutablePath;commandLine=$owner.CommandLine}})",
    "$items|ConvertTo-Json -Compress",
  ].join(";");
  const parsed = JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  return Array.isArray(parsed) ? parsed : [parsed];
}

function assertSafeConfig(configFile, config) {
  assert.equal(resolve(configFile), expectedInstancePath);
  assert.equal(resolve(process.cwd()), sourceRoot);
  assert.equal(config.instanceId, "qa-hub-preview-schema19-sol-0909");
  assert.equal(resolve(config.sourceRoot), sourceRoot);
  assert.equal(resolve(config.runtimeRoot), dirname(expectedInstancePath));
  assert.equal(config.apiHost, "127.0.0.1");
  assert.equal(config.webHost, "127.0.0.1");
  assert.equal(config.apiPort, 4519);
  assert.equal(config.webPort, 4520);
  assert.equal(config.mcpPort, 4521);
  assert.equal(config.desktopMcpPort, 4522);
  assert.ok(relative(config.runtimeRoot, config.dataRoot).startsWith("data"));
  assert.ok(!resolve(config.runtimeRoot).toLowerCase().startsWith("d:\\relay-qa-hub"));
  for (const port of [config.apiPort, config.webPort, config.mcpPort, config.desktopMcpPort]) {
    assert.ok(![4174, 4274, 4319, 4320, 4419, 4420, 4421].includes(port));
  }
}

async function run(configFile) {
  const configBytes = readFileSync(configFile);
  const config = JSON.parse(configBytes);
  assertSafeConfig(configFile, config);

  const runId = randomUUID();
  const compact = runId.replaceAll("-", "");
  const projectId = randomUUID();
  const output = join(sourceRoot, "docs/evidence/project-components/schema19-main-live", runId);
  mkdirSync(output, { recursive: true });
  const databaseFile = join(config.dataRoot, "db", "qa-hub.sqlite");
  const secrets = new Set();
  const proof = {
    schemaVersion: 1,
    status: "running",
    runId,
    startedAt: new Date().toISOString(),
    instanceId: config.instanceId,
    projectId,
    sourceHead: execFileSync("git.exe", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
    sourceSha256: sha256(readFileSync(sourcePath)),
    instanceConfigSha256: sha256(configBytes),
    checks: [],
    requests: [],
    fixtures: {},
    boundaries: {
      isolatedRuntimeOnly: true,
      actualMainApi: true,
      actualServerMcpProxy: true,
      syntheticCaptureFixture: true,
      physicalDeviceUsed: false,
      localMcpCalled: false,
      browserUiOperated: false,
      externalComponentsEnabled: false,
      externalCalls: 0,
      productionTouched: false,
      existingPreview4419Touched: false,
      cleanupDeletes: false,
    },
  };
  let rpcId = 0;

  const safeJson = (value) => {
    const text = `${JSON.stringify(redactSchema19Evidence(value, secrets), null, 2)}\n`;
    for (const secret of secrets) assert.ok(!text.includes(secret));
    assert.ok(
      !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u.test(
        text,
      ),
    );
    return text;
  };
  const check = (label, actual, expected) => {
    const entry = {
      label,
      actual: redactSchema19Evidence(actual, secrets),
      expected: redactSchema19Evidence(expected, secrets),
      at: new Date().toISOString(),
      passed: false,
    };
    proof.checks.push(entry);
    assert.deepEqual(actual, expected, label);
    entry.passed = true;
  };
  const checkTrue = (label, actual) => check(label, Boolean(actual), true);

  async function mcpRpc(label, method, params = {}, accessToken) {
    assert.ok(["initialize", "tools/list", "tools/call"].includes(method));
    const id = ++rpcId;
    const request = { jsonrpc: "2.0", id, method, params };
    rememberSecrets(request, secrets);
    const entry = {
      transport: "server_mcp",
      label,
      id,
      method,
      request: redactSchema19Evidence(request, secrets),
      startedAt: new Date().toISOString(),
    };
    proof.requests.push(entry);
    try {
      const response = await fetch(`http://127.0.0.1:${config.mcpPort}/mcp`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify(request),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      const envelope = JSON.parse(bytes.toString("utf8"));
      rememberSecrets(envelope, secrets);
      Object.assign(entry, {
        httpStatus: response.status,
        responseMedia: response.headers.get("content-type"),
        responseSizeBytes: bytes.length,
        responseSha256: sha256(bytes),
        response: redactSchema19Evidence(envelope, secrets),
      });
      assert.equal(response.status, 200, label);
      assert.equal(envelope.jsonrpc, "2.0", label);
      assert.equal(envelope.id, id, label);
      assert.equal(envelope.error, undefined, label);
      return envelope.result;
    } finally {
      entry.finishedAt = new Date().toISOString();
    }
  }

  async function tool(label, name, args, accessToken, errorCode) {
    const result = await mcpRpc(label, "tools/call", { name, arguments: args }, accessToken);
    const value = result.structuredContent ?? JSON.parse(result.content[0].text);
    rememberSecrets(value, secrets);
    if (errorCode === undefined) {
      assert.equal(result.isError, false, `${label}: ${safeJson(value)}`);
    } else {
      assert.equal(result.isError, true, label);
      assert.equal(value.code, errorCode, label);
    }
    return value;
  }

  async function httpJson(label, path, init, accessToken) {
    const entry = {
      transport: "direct_http",
      label,
      method: init.method ?? "GET",
      path,
      request: redactSchema19Evidence(
        typeof init.body === "string" ? JSON.parse(init.body) : null,
        secrets,
      ),
      startedAt: new Date().toISOString(),
    };
    proof.requests.push(entry);
    try {
      const response = await fetch(`http://127.0.0.1:${config.apiPort}${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: vendorMedia,
          authorization: `Bearer ${accessToken}`,
          "x-qa-project-id": projectId,
          ...(init.headers ?? {}),
        },
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      const body = JSON.parse(bytes.toString("utf8"));
      rememberSecrets(body, secrets);
      Object.assign(entry, {
        httpStatus: response.status,
        responseMedia: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"),
        responseSizeBytes: bytes.length,
        responseSha256: sha256(bytes),
        response: redactSchema19Evidence(body, secrets),
      });
      assert.ok(response.ok, `${label}: ${response.status} ${safeJson(body)}`);
      return { body, bytes, response };
    } finally {
      entry.finishedAt = new Date().toISOString();
    }
  }

  try {
    const hostBefore = processIdentities([config.apiPort, config.mcpPort]);
    proof.hostBefore = hostBefore;
    check(
      "exact isolated listeners",
      hostBefore.map(({ port }) => port).sort((a, b) => a - b),
      [4519, 4521],
    );
    for (const identity of hostBefore) {
      checkTrue(
        `listener ${identity.port} uses configured runtime`,
        identity.commandLine.includes(configFile),
      );
      checkTrue(
        `listener ${identity.port} uses guarded preview launcher`,
        identity.commandLine.includes("scripts/project-components/run-preview-service.mjs"),
      );
    }
    const apiHealth = await fetch(`http://127.0.0.1:${config.apiPort}/api/v1/health/ready`, {
      signal: AbortSignal.timeout(10_000),
    }).then((response) => response.json());
    const mcpHealth = await fetch(`http://127.0.0.1:${config.mcpPort}/health`, {
      signal: AbortSignal.timeout(10_000),
    }).then((response) => response.json());
    proof.healthBefore = { api: apiHealth, serverMcp: mcpHealth };
    check("main API ready", apiHealth.status, "ready");
    check("main API schema", String(apiHealth.schemaVersion), "19");
    check("server MCP ready", mcpHealth.status, "ready");
    check("server MCP schema", String(mcpHealth.schemaVersion), "19");

    await mcpRpc("initialize actual server MCP", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "schema19-main-live", version: "1" },
    });
    const catalog = await mcpRpc("read actual tool catalog", "tools/list");
    check("server MCP catalog count", catalog.tools.length, 94);
    for (const name of [
      "qa_login_gm",
      "qa_create_project",
      "qa_login",
      "qa_create_bug",
      "qa_bug_action",
      "qa_fail_repair_attempt",
      "qa_supersede_repair_attempt",
      "qa_get_bug_workflow",
      "qa_init_upload",
      "qa_put_upload_chunk",
      "qa_finalize_upload",
      "qa_create_capture",
      "qa_bind_attachment",
      "qa_record_verification_result",
      "qa_read_attachment",
    ]) {
      checkTrue(
        `catalog contains ${name}`,
        catalog.tools.some((candidate) => candidate.name === name),
      );
    }

    const secretConfig = JSON.parse(readFileSync(config.secretsFile, "utf8"));
    assert.equal(typeof secretConfig.gmPassword, "string");
    secrets.add(secretConfig.gmPassword);
    const gm = await tool(
      "GM login",
      "qa_login_gm",
      { request: { password: secretConfig.gmPassword } },
      undefined,
    );
    check("configured unique GM", gm.userId, config.gmUserId);
    check("GM flag", gm.isGm, true);
    const projectKey = `S19${compact.slice(0, 8).toUpperCase()}`;
    const project = await tool(
      "create isolated schema19 project",
      "qa_create_project",
      {
        request: {
          id: projectId,
          key: projectKey,
          name: `Schema 19 main live ${runId}`,
        },
      },
      gm.accessToken,
    );
    check("fresh project id", project.id, projectId);
    const componentState = await tool(
      "read fresh project components",
      "qa_get_components",
      { projectId },
      gm.accessToken,
    );
    check(
      "all optional components start disabled",
      componentState.items.map(({ enabled }) => enabled),
      [false, false, false, false, false],
    );

    const employeeName = `Schema19${compact.slice(0, 12)}`;
    const employee = await tool(
      "project name login",
      "qa_login",
      { projectId, name: employeeName },
      undefined,
    );
    check("employee selected project", employee.projectId, projectId);
    check("employee is not GM", employee.isGm, false);
    const employeeAgain = await tool(
      "repeat project name login",
      "qa_login",
      { projectId, name: employeeName },
      undefined,
    );
    check("same name keeps one employee identity", employeeAgain.userId, employee.userId);

    async function createBug(title) {
      const clientSubmissionId = randomUUID();
      const created = await tool(
        `create ${title}`,
        "qa_create_bug",
        {
          projectId,
          request: {
            submissionContractVersion: "1.1.0",
            clientSubmissionId,
            projectId,
            title,
            description: `${title} through the isolated schema 19 main process`,
            expectedBehavior: "The frozen workflow persists exact state and evidence",
            severity: "S2",
            priority: "P2",
            attachmentIds: [],
            ownerId: employee.userId,
            verificationOwnerId: employee.userId,
            occurrence: {
              observedAt: new Date().toISOString(),
              platform: "web",
              steps: ["Run the retained isolated main acceptance"],
              actualBehavior: "The scenario is pending",
            },
          },
        },
        employee.accessToken,
      );
      checkTrue(`${title} has Bug UUID`, /^[0-9a-f-]{36}$/u.test(created.bug.id));
      return created.bug;
    }

    async function action(label, bugId, name, expectedVersion, extra = {}) {
      return tool(
        label,
        "qa_bug_action",
        {
          projectId,
          bugId,
          action: name,
          expectedVersion,
          idempotencyKey: `schema19:${name}:${randomUUID()}`,
          ...extra,
        },
        employee.accessToken,
      );
    }

    async function runningBug(title) {
      const bug = await createBug(title);
      const ready = await action(`${title}: ready`, bug.id, "ready", bug.version);
      const planned = await action(`${title}: plan`, bug.id, "plan_fix", ready.bug.version, {
        request: { assigneeId: employee.userId, summary: `${title} planned work` },
      });
      const running = await action(`${title}: start`, bug.id, "begin_fix", planned.result.version, {
        attemptId: planned.result.id,
      });
      return { bug: running.bug, attempt: running.result };
    }

    async function deliveredBug(title) {
      const current = await runningBug(title);
      const delivered = await action(
        `${title}: deliver`,
        current.bug.id,
        "submit_fix",
        current.attempt.version,
        {
          attemptId: current.attempt.id,
          request: {
            deliveryKind: "no_code",
            noCodeReason: "This retained main acceptance exercises workflow persistence",
            summary: `${title} ready for verification`,
          },
        },
      );
      return { bug: delivered.bug, attempt: delivered.result };
    }

    const failedFixture = await runningBug("Direct HTTP terminal failure");
    const failReason = "Focused main-process validation ended this repair round";
    const failPath = `/api/v1/repair-attempts/${failedFixture.attempt.id}/fail`;
    const failRequest = {
      expectedVersion: failedFixture.attempt.version,
      reason: failReason,
    };
    const failKey = `workflow:failRepairAttempt:attempt:${failedFixture.attempt.id}:v${failedFixture.attempt.version}`;
    const failed = await httpJson(
      "direct HTTP vendor fail",
      failPath,
      {
        method: "POST",
        headers: { "content-type": vendorMedia, "idempotency-key": failKey },
        body: JSON.stringify(failRequest),
      },
      employee.accessToken,
    );
    checkTrue(
      "fail response uses vendor media",
      failed.response.headers.get("content-type").startsWith(vendorMedia),
    );
    check("failed attempt id", failed.body.id, failedFixture.attempt.id);
    check("failed attempt status", failed.body.status, "failed");
    check("failed attempt reason projection", failed.body.summary, failReason);
    const failedReplay = await httpJson(
      "direct HTTP exact fail replay",
      failPath,
      {
        method: "POST",
        headers: { "content-type": vendorMedia, "idempotency-key": failKey },
        body: JSON.stringify(failRequest),
      },
      employee.accessToken,
    );
    check("fail replay is byte exact", sha256(failedReplay.bytes), sha256(failed.bytes));
    const failedRead = await tool(
      "server MCP reads failed attempt",
      "qa_get_repair_attempt",
      { projectId, attemptId: failedFixture.attempt.id },
      employee.accessToken,
    );
    check("failed attempt persisted", failedRead.status, "failed");

    const supersedeFixture = await runningBug("Server MCP atomic replacement");
    const successorId = randomUUID();
    const supersedeArgs = {
      projectId,
      attemptId: supersedeFixture.attempt.id,
      expectedVersion: supersedeFixture.attempt.version,
      reason: "Move the active work to an explicit external successor",
      successor: {
        id: successorId,
        mode: "external",
        assigneeId: employee.userId,
        summary: "Retained external successor from actual server MCP",
      },
    };
    const superseded = await tool(
      "GM atomically supersedes through actual server MCP",
      "qa_supersede_repair_attempt",
      supersedeArgs,
      gm.accessToken,
    );
    check("original attempt superseded", superseded.supersededAttempt.status, "superseded");
    check("successor exact id", superseded.successorAttempt.id, successorId);
    check("successor mode", superseded.successorAttempt.mode, "external");
    check(
      "successor parent",
      superseded.successorAttempt.parentAttemptId,
      supersedeFixture.attempt.id,
    );
    check("atomic replacement keeps Bug in progress", superseded.bug.state, "in_progress");
    check("first atomic replacement is not replay", superseded.replayed, false);
    const supersededReplay = await tool(
      "exact atomic replacement replay",
      "qa_supersede_repair_attempt",
      supersedeArgs,
      gm.accessToken,
    );
    check("atomic replacement replay marker", supersededReplay.replayed, true);
    check("atomic replacement replay event", supersededReplay.eventId, superseded.eventId);

    const projectedAttempts = new Map();
    let projectionCursor = null;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await tool(
        `read frozen workflow page ${pageNumber + 1}`,
        "qa_get_bug_workflow",
        {
          projectId,
          bugId: supersedeFixture.bug.id,
          query: {
            limitPerCollection: 1,
            ...(projectionCursor === null ? {} : { cursor: projectionCursor }),
          },
        },
        employee.accessToken,
      );
      check("workflow page Bug identity", page.bugId, supersedeFixture.bug.id);
      for (const attempt of page.repairAttempts) projectedAttempts.set(attempt.id, attempt);
      projectionCursor = page.nextCursor;
      if (projectionCursor === null) break;
      checkTrue(
        "workflow cursor is non-empty",
        typeof projectionCursor === "string" && projectionCursor.length > 0,
      );
    }
    check("workflow projection completed", projectionCursor, null);
    check("workflow retained both repair rounds", projectedAttempts.size, 2);
    check(
      "workflow retained original terminal state",
      projectedAttempts.get(supersedeFixture.attempt.id).status,
      "superseded",
    );
    check(
      "workflow retained external successor",
      projectedAttempts.get(successorId).mode,
      "external",
    );
    check(
      "workflow retained parent identity",
      projectedAttempts.get(successorId).parentAttemptId,
      supersedeFixture.attempt.id,
    );

    const successorFailReason = "External successor intentionally ended after projection readback";
    const successorFailPath = `/api/v1/repair-attempts/${successorId}/fail`;
    const successorFailKey = `workflow:failRepairAttempt:attempt:${successorId}:v${superseded.successorAttempt.version}`;
    const successorFailed = await httpJson(
      "direct HTTP ends external successor",
      successorFailPath,
      {
        method: "POST",
        headers: { "content-type": vendorMedia, "idempotency-key": successorFailKey },
        body: JSON.stringify({
          expectedVersion: superseded.successorAttempt.version,
          reason: successorFailReason,
        }),
      },
      employee.accessToken,
    );
    check("external successor can terminate", successorFailed.body.status, "failed");

    async function startVerificationFixture(title) {
      const delivered = await deliveredBug(title);
      const created = await action(
        `${title}: create verification`,
        delivered.bug.id,
        "create_verification",
        delivered.bug.version,
        {
          request: {
            repairAttemptId: delivered.attempt.id,
            buildId: null,
            verifierId: employee.userId,
            criteria: `${title} exact acceptance criteria`,
          },
        },
      );
      const started = await action(
        `${title}: start verification`,
        delivered.bug.id,
        "start_verification",
        created.result.version,
        { verificationId: created.result.id },
      );
      return { bug: started.bug, attempt: delivered.attempt, verification: started.result };
    }

    const evidenceFixture = await startVerificationFixture("Captured passed verification");
    const clientSubmissionId = randomUUID();
    const captureId = randomUUID();
    const uploaded = [];
    for (const [index, bytes] of [png, Buffer.concat([png, Buffer.from([0])])].entries()) {
      const clientAttachmentId = randomUUID();
      const contentSha = sha256(bytes);
      const common = {
        submissionContractVersion: "1.1.0",
        clientSubmissionId,
        clientAttachmentId,
        uploadAttempt: 1,
      };
      const key = (suffix) =>
        `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:upload:1:${suffix}`;
      const session = await tool(
        `init evidence upload ${index + 1}`,
        "qa_init_upload",
        {
          projectId,
          request: {
            ...common,
            projectId,
            filename: `schema19-main-${index + 1}.png`,
            mediaType: "image/png",
            captureId,
            expectedSize: bytes.length,
            sha256: contentSha,
          },
          idempotencyKey: key("init"),
        },
        employee.accessToken,
      );
      const chunk = await tool(
        `upload evidence chunk ${index + 1}`,
        "qa_put_upload_chunk",
        {
          projectId,
          sessionId: session.sessionId,
          chunkNumber: 0,
          expectedVersion: session.version,
          clientSubmissionId,
          clientAttachmentId,
          bytesBase64: bytes.toString("base64"),
          chunkSha256: contentSha,
          idempotencyKey: key("chunk:0"),
        },
        employee.accessToken,
      );
      const attachment = await tool(
        `finalize evidence upload ${index + 1}`,
        "qa_finalize_upload",
        {
          projectId,
          sessionId: session.sessionId,
          request: {
            ...common,
            expectedVersion: chunk.version,
            expectedSize: bytes.length,
            sha256: contentSha,
          },
          idempotencyKey: key("finalize"),
        },
        employee.accessToken,
      );
      uploaded.push({ ...attachment, clientAttachmentId, bytes, sha256: contentSha });
    }
    const capturedAt = new Date().toISOString();
    await tool(
      "create retained capture bundle",
      "qa_create_capture",
      {
        projectId,
        request: {
          submissionContractVersion: "1.1.0",
          projectId,
          clientSubmissionId,
          capture: {
            captureId,
            clientSubmissionId,
            projectId,
            capturedAt,
            source: "overlay_single_tap",
            primaryEvidenceClientAttachmentId: uploaded[0].clientAttachmentId,
            primaryEvidenceAttachmentId: uploaded[0].attachmentId,
            artifacts: uploaded.map((attachment, index) => ({
              captureId,
              clientAttachmentId: attachment.clientAttachmentId,
              attachmentId: attachment.attachmentId,
              kind: index === 0 ? "system_screenshot" : "poco_screenshot",
              status: "succeeded",
              startedAt: capturedAt,
              endedAt: capturedAt,
              skewMs: 0,
              truncated: false,
              failureReason: null,
            })),
            poco: {
              attempted: true,
              connectedPort: 5001,
              sdkVersion: "synthetic-main-fixture",
              snapshotCapability: "standard_only",
              screenSize: null,
              allowedReadOnlyMethods: MOBILE_CAPTURE_ALLOWED_METHODS,
              negotiatedMethods: ["GetSDKVersion", "Screenshot"],
              succeededMethods: ["GetSDKVersion", "Screenshot"],
              failureReason: null,
            },
            deviceMetadata: {
              manufacturer: "Synthetic",
              model: "Retained isolated main fixture",
              androidApi: 35,
              androidRelease: "15",
              qaAppVersion: "schema19-main-live",
              networkType: "offline",
            },
          },
        },
        idempotencyKey: `submission:${clientSubmissionId}:capture:${captureId}`,
      },
      employee.accessToken,
    );
    for (const attachment of uploaded) {
      await tool(
        `bind evidence ${attachment.attachmentId}`,
        "qa_bind_attachment",
        {
          projectId,
          attachmentId: attachment.attachmentId,
          request: {
            submissionContractVersion: "1.1.0",
            projectId,
            clientSubmissionId,
            clientAttachmentId: attachment.clientAttachmentId,
            leaseGeneration: 1,
            expectedVersion: attachment.version,
            intent: "verification_result",
            targetQaItemId: evidenceFixture.bug.id,
          },
          idempotencyKey: `submission:${clientSubmissionId}:attachment:${attachment.clientAttachmentId}:bind:1`,
        },
        employee.accessToken,
      );
    }
    const passedRequest = {
      submissionContractVersion: "1.1.0",
      clientSubmissionId,
      expectedVersion: evidenceFixture.verification.version,
      status: "passed",
      resultSummary: "Actual main process retained the exact evidence chain",
      attachmentIds: uploaded.map(({ attachmentId }) => attachmentId),
      captureBundleId: captureId,
    };
    const passedArgs = {
      projectId,
      verificationId: evidenceFixture.verification.id,
      request: passedRequest,
    };
    const passed = await tool(
      "record captured passed result",
      "qa_record_verification_result",
      passedArgs,
      employee.accessToken,
    );
    check("passed result first write", passed.replayed, false);
    check("passed result capture", passed.captureBundleId, captureId);
    check("passed result closes Bug", passed.bug.state, "closed");
    check(
      "passed result exact attachments",
      [...passed.attachmentIds].sort(),
      uploaded.map(({ attachmentId }) => attachmentId).sort(),
    );
    const passedReplay = await tool(
      "replay captured passed result",
      "qa_record_verification_result",
      passedArgs,
      employee.accessToken,
    );
    check("passed result replay", passedReplay.replayed, true);
    check("passed result replay event", passedReplay.eventId, passed.eventId);
    for (const attachment of uploaded) {
      const read = await tool(
        `read retained attachment ${attachment.attachmentId}`,
        "qa_read_attachment",
        {
          projectId,
          bugId: evidenceFixture.bug.id,
          attachmentId: attachment.attachmentId,
        },
        employee.accessToken,
      );
      check(`attachment ${attachment.attachmentId} hash`, read.sha256, attachment.sha256);
      check(
        `attachment ${attachment.attachmentId} bytes`,
        Buffer.from(read.blob, "base64"),
        attachment.bytes,
      );
    }
    const capture = await tool(
      "read bound capture",
      "qa_get_capture",
      { projectId, captureId },
      employee.accessToken,
    );
    check("capture identity", capture.captureId, captureId);
    check("capture enrichment", capture.enrichmentStatus, "partial");
    check("capture negotiated fixture methods", capture.poco.negotiatedMethods, [
      "GetSDKVersion",
      "Screenshot",
    ]);

    async function submitSimpleOutcome(status) {
      const title = `${status} verification main path`;
      const fixture = await startVerificationFixture(title);
      const resultSubmissionId = randomUUID();
      const reason = `${status} was recorded by the retained main acceptance`;
      const request = {
        submissionContractVersion: "1.1.0",
        clientSubmissionId: resultSubmissionId,
        expectedVersion: fixture.verification.version,
        status,
        resultSummary: reason,
        attachmentIds: [],
        ...(status === "blocked" ? { blockedReason: reason } : { failureReason: reason }),
      };
      const args = { projectId, verificationId: fixture.verification.id, request };
      const result = await tool(
        `record ${status} result`,
        "qa_record_verification_result",
        args,
        employee.accessToken,
      );
      check(`${status} first write`, result.replayed, false);
      check(`${status} status`, result.verification.status, status);
      check(
        `${status} Bug state`,
        result.bug.state,
        status === "blocked" ? "ready_for_verification" : "ready",
      );
      check(
        `${status} attempt state`,
        result.repairAttempt.status,
        status === "blocked" ? "delivered" : "verification_failed",
      );
      const replay = await tool(
        `replay ${status} result`,
        "qa_record_verification_result",
        args,
        employee.accessToken,
      );
      check(`${status} replay`, replay.replayed, true);
      check(`${status} replay event`, replay.eventId, result.eventId);
      const read = await tool(
        `read ${status} verification`,
        "qa_get_verification",
        { projectId, verificationId: fixture.verification.id },
        employee.accessToken,
      );
      check(`${status} persisted verification`, read.status, status);
      return {
        bugId: fixture.bug.id,
        attemptId: fixture.attempt.id,
        verificationId: fixture.verification.id,
        clientSubmissionId: resultSubmissionId,
      };
    }
    const blockedFixture = await submitSimpleOutcome("blocked");
    const verificationFailedFixture = await submitSimpleOutcome("failed");

    const readback = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      check("raw DB schema", readback.prepare("PRAGMA user_version").get().user_version, 19);
      check(
        "raw DB quick check",
        readback
          .prepare("PRAGMA quick_check")
          .all()
          .map((row) => row.quick_check),
        ["ok"],
      );
      check(
        "trusted command authorization rows cleaned",
        readback.prepare("SELECT count(*) AS count FROM storage_command_authorizations").get()
          .count,
        0,
      );
      check(
        "three exact terminal snapshots despite replays",
        readback
          .prepare(
            "SELECT count(*) AS count FROM repair_attempt_terminal_snapshots WHERE attempt_id IN (?,?,?)",
          )
          .get(failedFixture.attempt.id, supersedeFixture.attempt.id, successorId).count,
        3,
      );
      check(
        "original superseded row retained",
        readback
          .prepare("SELECT status FROM repair_attempts WHERE id=?")
          .get(supersedeFixture.attempt.id).status,
        "superseded",
      );
      const successorRow = readback
        .prepare("SELECT status,mode,parent_attempt_id FROM repair_attempts WHERE id=?")
        .get(successorId);
      check("external successor raw status", successorRow.status, "failed");
      check("external successor raw mode", successorRow.mode, "external");
      check(
        "external successor raw parent",
        successorRow.parent_attempt_id,
        supersedeFixture.attempt.id,
      );
      check(
        "three Verification result snapshots despite replays",
        readback
          .prepare(
            "SELECT count(*) AS count FROM verification_result_snapshots WHERE verification_id IN (?,?,?)",
          )
          .get(
            evidenceFixture.verification.id,
            blockedFixture.verificationId,
            verificationFailedFixture.verificationId,
          ).count,
        3,
      );
      check(
        "two exact Verification attachments",
        readback
          .prepare("SELECT count(*) AS count FROM verification_attachments WHERE verification_id=?")
          .get(evidenceFixture.verification.id).count,
        2,
      );
      check(
        "capture bundle bound",
        readback.prepare("SELECT status FROM capture_bundles WHERE id=?").get(captureId).status,
        "bound",
      );
    } finally {
      readback.close();
    }

    proof.fixtures = {
      employeeId: employee.userId,
      directFail: { bugId: failedFixture.bug.id, attemptId: failedFixture.attempt.id },
      atomicSupersede: {
        bugId: supersedeFixture.bug.id,
        attemptId: supersedeFixture.attempt.id,
        successorId,
      },
      passedEvidence: {
        bugId: evidenceFixture.bug.id,
        attemptId: evidenceFixture.attempt.id,
        verificationId: evidenceFixture.verification.id,
        captureId,
        attachmentIds: uploaded.map(({ attachmentId }) => attachmentId),
        evidenceSha256: uploaded.map(({ sha256: value }) => value),
      },
      blocked: blockedFixture,
      failedVerification: verificationFailedFixture,
    };
    const hostAfter = processIdentities([config.apiPort, config.mcpPort]);
    proof.hostAfter = hostAfter;
    check("API and server MCP process identities unchanged", hostAfter, hostBefore);
    const healthAfter = await fetch(`http://127.0.0.1:${config.mcpPort}/health`, {
      signal: AbortSignal.timeout(10_000),
    }).then((response) => response.json());
    proof.healthAfter = healthAfter;
    check("server MCP remains ready", healthAfter.status, "ready");
    check("server MCP remains schema 19", String(healthAfter.schemaVersion), "19");
    proof.status = "passed_schema19_actual_main_http_and_server_mcp";
  } catch (error) {
    proof.status = "failed_retained";
    proof.failure = String(error?.stack ?? error);
    process.exitCode = 1;
  } finally {
    proof.finishedAt = new Date().toISOString();
    writeFileSync(join(output, "runner.mjs.txt"), readFileSync(sourcePath), { flag: "wx" });
    writeFileSync(join(output, "proof.json"), safeJson(proof), { flag: "wx" });
    console.log(
      JSON.stringify({
        status: proof.status,
        runId,
        checks: proof.checks.length,
        requests: proof.requests.length,
        proof: join(output, "proof.json"),
      }),
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === sourcePath) {
  if (process.argv[2] === "--run") {
    assert.equal(process.argv.length, 4);
    await run(process.argv[3]);
  } else {
    console.log(
      JSON.stringify({
        status: "not_run",
        command:
          "node scripts/project-components/schema19-main-live.mjs --run <reviewed-schema19-instance.json>",
      }),
    );
  }
}
