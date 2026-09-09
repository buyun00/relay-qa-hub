import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { MOBILE_CAPTURE_ALLOWED_METHODS } from "@relay-qa-hub/storage";

const sourcePath = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(sourcePath), "../..");
const reviewedInstances = new Map(
  [
    {
      instanceId: "qa-hub-preview-final-sol-0909",
      instancePath:
        "C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-final-sol-0909/instance.json",
      configSha256: "1e36dd0cebe27457e04505ca86c87e92335415dc2a970f2338004f778f759503",
      ports: [4539, 4540, 4541, 4542],
    },
  ].map((entry) => [resolve(entry.instancePath).toLowerCase(), entry]),
);
const acceptanceScope = Object.freeze({
  coveredWhenRun: Object.freeze([
    "exact final preview instance, source root, loopback ports, and stable API/MCP processes",
    "unique GM plus project-and-name employee login",
    "visible-project and project-member signed pagination",
    "Bug create, edit, assign, comment, human start/deliver/manual-complete, Verification start/result, and close",
    "attachment init/chunk/finalize/capture/bind/read integrity",
    "detail, comments, events, workflow, idempotent replay, cross-project denial, stale-version denial, and signed Bug pagination",
    "schema 20 database integrity and retained terminal snapshots",
  ]),
  requiredSeparately: Object.freeze([
    "Web browser UI",
    "installed EXE upgrade/restart and desktop local MCP",
    "Android APK install and MuMu UI",
    "physical Android device",
    "enabled packaging, upload, Relay, and third-party integrations with isolated external resources",
    "migration rollback drill",
  ]),
});
const vendorMedia = "application/vnd.relay-qa-hub.v1.1+json";
const expectedSchemaVersion = 20;
const sensitiveKey =
  /token|secret|password|cookie|authorization|csrf|private.?key|api.?key|credential/iu;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const normalizeWindowsText = (value) => value.replaceAll("\\", "/").toLowerCase();

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

function verifyManagerProcessReceipt(config, service, identity) {
  const receiptPath = join(config.logsRoot, `${service}-process.json`);
  const receiptBytes = readFileSync(receiptPath);
  const receipt = JSON.parse(receiptBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  assert.equal(receipt.instanceId, config.instanceId, `${service}_RECEIPT_INSTANCE_MISMATCH`);
  assert.equal(receipt.service, service, `${service}_RECEIPT_SERVICE_MISMATCH`);
  assert.equal(Number(receipt.pid), identity.pid, `${service}_RECEIPT_PID_MISMATCH`);
  assert.equal(receipt.createdAt, identity.startedAt, `${service}_RECEIPT_START_MISMATCH`);
  assert.equal(
    normalizeWindowsText(receipt.executable),
    normalizeWindowsText(identity.path),
    `${service}_RECEIPT_EXECUTABLE_MISMATCH`,
  );
  assert.equal(
    normalizeWindowsText(receipt.commandLine),
    normalizeWindowsText(identity.commandLine),
    `${service}_RECEIPT_COMMAND_LINE_MISMATCH`,
  );
  return Object.freeze({
    service,
    port: identity.port,
    pid: identity.pid,
    startedAt: identity.startedAt,
    receiptSha256: sha256(receiptBytes),
  });
}

function assertSafeConfig(configFile, configBytes, config) {
  const reviewed = reviewedInstances.get(resolve(configFile).toLowerCase());
  assert.ok(reviewed, "EXACT_REVIEWED_SCHEMA19_INSTANCE_REQUIRED");
  assert.equal(sha256(configBytes), reviewed.configSha256, "REVIEWED_INSTANCE_CONFIG_CHANGED");
  assert.equal(resolve(process.cwd()), sourceRoot);
  assert.equal(config.instanceId, reviewed.instanceId);
  assert.equal(
    realpathSync(config.sourceRoot).toLowerCase(),
    realpathSync(sourceRoot).toLowerCase(),
  );
  const reviewedRuntime = dirname(resolve(reviewed.instancePath));
  assert.equal(
    realpathSync(config.runtimeRoot).toLowerCase(),
    realpathSync(reviewedRuntime).toLowerCase(),
  );
  for (const [field, leaf] of [
    ["dataRoot", "data"],
    ["backupRoot", "backups"],
    ["downloadsRoot", "downloads"],
    ["logsRoot", "logs"],
    ["desktopRoot", "desktop"],
    ["secretsFile", "secrets.json"],
    ["peopleFile", "people.json"],
  ]) {
    assert.equal(
      realpathSync(config[field]).toLowerCase(),
      realpathSync(join(reviewedRuntime, leaf)).toLowerCase(),
      `${field}_OUTSIDE_REVIEWED_RUNTIME`,
    );
  }
  assert.equal(config.apiHost, "127.0.0.1");
  assert.equal(config.webHost, "127.0.0.1");
  assert.deepEqual(
    [config.apiPort, config.webPort, config.mcpPort, config.desktopMcpPort],
    reviewed.ports,
  );
  assert.ok(!resolve(config.runtimeRoot).toLowerCase().startsWith("d:\\relay-qa-hub"));
  for (const port of [config.apiPort, config.webPort, config.mcpPort, config.desktopMcpPort]) {
    assert.ok(![4174, 4274, 4319, 4320, 4419, 4420, 4421].includes(port));
  }
}

async function run(configFile) {
  const configBytes = readFileSync(configFile);
  const config = JSON.parse(configBytes);
  assertSafeConfig(configFile, configBytes, config);

  const runId = randomUUID();
  const compact = runId.replaceAll("-", "");
  const projectId = randomUUID();
  const output = join(sourceRoot, "docs/evidence/project-components/schema19-main-live", runId);
  mkdirSync(output, { recursive: true });
  const databaseFile = join(config.dataRoot, "db", "qa-hub.sqlite");
  const secrets = new Set();
  const sessions = [];
  const proof = {
    schemaVersion: 1,
    status: "running",
    runId,
    startedAt: new Date().toISOString(),
    instanceId: config.instanceId,
    expectedSchemaVersion,
    projectId,
    sourceHead: execFileSync("git.exe", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
    runnerSha256: sha256(readFileSync(sourcePath)),
    instanceConfigSha256: sha256(configBytes),
    checks: [],
    requests: [],
    fixtures: {},
    acceptanceScope,
    runtimeBuildBinding: {
      status: "process_start_bound_source_build_binding_requires_main_flow_verification",
      managerReceiptSchema: {
        stableProcessIdentityFields: [
          "instanceId",
          "service",
          "pid",
          "createdAt",
          "executable",
          "commandLine",
        ],
        sourceHead: false,
        buildHash: false,
      },
      processStartIdentityBound: false,
      sourceHeadBound: false,
      buildHashBound: false,
      separateVerificationOwner: "main_flow",
      claimBoundary:
        "This runner does not attribute the running apps/api/dist/main.js bytes to sourceHead.",
      managerProcessReceipts: [],
    },
    cleanup: { sessions: [], allLoggedOut: false },
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
    if (
      (name === "qa_login" || name === "qa_login_gm") &&
      value &&
      typeof value === "object" &&
      typeof value.accessToken === "string" &&
      !sessions.some((session) => session.accessToken === value.accessToken)
    ) {
      sessions.push({ label, accessToken: value.accessToken });
    }
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
      [config.apiPort, config.mcpPort].sort((a, b) => a - b),
    );
    const normalizedConfigFile = normalizeWindowsText(resolve(configFile));
    for (const identity of hostBefore) {
      checkTrue(
        `listener ${identity.port} uses configured runtime`,
        normalizeWindowsText(identity.commandLine).includes(normalizedConfigFile),
      );
      checkTrue(
        `listener ${identity.port} uses guarded preview launcher`,
        normalizeWindowsText(identity.commandLine).includes(
          "scripts/project-components/run-preview-service.mjs",
        ),
      );
    }
    proof.runtimeBuildBinding.managerProcessReceipts = [
      verifyManagerProcessReceipt(
        config,
        "api",
        hostBefore.find(({ port }) => port === config.apiPort),
      ),
      verifyManagerProcessReceipt(
        config,
        "mcp",
        hostBefore.find(({ port }) => port === config.mcpPort),
      ),
    ];
    proof.runtimeBuildBinding.processStartIdentityBound = true;
    const apiHealth = await fetch(`http://127.0.0.1:${config.apiPort}/api/v1/health/ready`, {
      signal: AbortSignal.timeout(10_000),
    }).then((response) => response.json());
    const mcpHealth = await fetch(`http://127.0.0.1:${config.mcpPort}/health`, {
      signal: AbortSignal.timeout(10_000),
    }).then((response) => response.json());
    proof.healthBefore = { api: apiHealth, serverMcp: mcpHealth };
    check("main API ready", apiHealth.status, "ready");
    check("main API schema", Number(apiHealth.schemaVersion), expectedSchemaVersion);
    check("server MCP ready", mcpHealth.status, "ready");
    check("server MCP schema", Number(mcpHealth.schemaVersion), expectedSchemaVersion);

    await mcpRpc("initialize actual server MCP", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "schema19-main-live", version: "1" },
    });
    const catalog = await mcpRpc("read actual tool catalog", "tools/list");
    check("server MCP catalog count", catalog.tools.length, 96);
    for (const name of [
      "qa_login_gm",
      "qa_logout",
      "qa_create_project",
      "qa_login",
      "qa_list_projects",
      "qa_list_members",
      "qa_create_bug",
      "qa_update_bug",
      "qa_add_comment",
      "qa_list_comments",
      "qa_list_events",
      "qa_get_bug_context",
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
    const projectKey = `S20${compact.slice(0, 8).toUpperCase()}`;
    const project = await tool(
      "create isolated schema20 project",
      "qa_create_project",
      {
        request: {
          id: projectId,
          key: projectKey,
          name: `Schema 20 main live ${runId}`,
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

    const employeeName = `Schema20${compact.slice(0, 12)}`;
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

    const secondaryProjectId = randomUUID();
    const secondaryProject = await tool(
      "create isolated cross-project control",
      "qa_create_project",
      {
        request: {
          id: secondaryProjectId,
          key: `X${compact.slice(0, 12).toUpperCase()}`,
          name: `Schema 20 cross-project control ${runId}`,
        },
      },
      gm.accessToken,
    );
    check("cross-project control identity", secondaryProject.id, secondaryProjectId);
    const crossProjectEmployee = await tool(
      "same employee joins cross-project control",
      "qa_login",
      { projectId: secondaryProjectId, name: employeeName },
      undefined,
    );
    check(
      "same employee identity spans both projects",
      crossProjectEmployee.userId,
      employee.userId,
    );

    const visibleProjectIds = new Set();
    const visibleProjectCursors = new Set();
    let visibleProjectCursor = null;
    let visibleProjectSnapshot = null;
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const page = await tool(
        `read signed visible-project page ${pageNumber + 1}`,
        "qa_list_projects",
        {
          query: {
            limit: 1,
            ...(visibleProjectCursor === null ? {} : { cursor: visibleProjectCursor }),
          },
        },
        crossProjectEmployee.accessToken,
      );
      if (visibleProjectSnapshot === null) visibleProjectSnapshot = page.snapshotSequence;
      check(
        `visible-project page ${pageNumber + 1} retains one snapshot`,
        page.snapshotSequence,
        visibleProjectSnapshot,
      );
      for (const item of page.items) {
        checkTrue(`visible project ${item.id} is active`, item.active);
        checkTrue(`visible project ${item.id} is unique`, !visibleProjectIds.has(item.id));
        visibleProjectIds.add(item.id);
      }
      visibleProjectCursor = page.nextCursor;
      if (visibleProjectCursor === null) break;
      checkTrue(
        `visible-project page ${pageNumber + 1} uses an HMAC cursor`,
        /^r1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(visibleProjectCursor),
      );
      checkTrue(
        `visible-project page ${pageNumber + 1} cursor is unique`,
        !visibleProjectCursors.has(visibleProjectCursor),
      );
      visibleProjectCursors.add(visibleProjectCursor);
    }
    check("visible-project pagination completed", visibleProjectCursor, null);
    check(
      "employee sees exactly both isolated projects",
      [...visibleProjectIds].sort(),
      [projectId, secondaryProjectId].sort(),
    );

    const memberIds = new Set();
    const memberCursors = new Set();
    let memberCursor = null;
    let memberSnapshot = null;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await tool(
        `read signed project-member page ${pageNumber + 1}`,
        "qa_list_members",
        {
          projectId,
          query: { limit: 1, ...(memberCursor === null ? {} : { cursor: memberCursor }) },
        },
        employee.accessToken,
      );
      check("member page project", page.projectId, projectId);
      if (memberSnapshot === null) memberSnapshot = page.snapshotSequence;
      check(
        `project-member page ${pageNumber + 1} retains one snapshot`,
        page.snapshotSequence,
        memberSnapshot,
      );
      for (const item of page.items) {
        check("member row project", item.projectId, projectId);
        checkTrue(`project member ${item.userId} is unique`, !memberIds.has(item.userId));
        memberIds.add(item.userId);
      }
      memberCursor = page.nextCursor;
      if (memberCursor === null) break;
      checkTrue(
        `project-member page ${pageNumber + 1} uses an HMAC cursor`,
        /^r1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(memberCursor),
      );
      checkTrue(
        `project-member page ${pageNumber + 1} cursor is unique`,
        !memberCursors.has(memberCursor),
      );
      memberCursors.add(memberCursor);
    }
    check("project-member pagination completed", memberCursor, null);
    checkTrue("project member list contains employee", memberIds.has(employee.userId));

    async function createBug(title, assigned = true) {
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
            description: `${title} through the isolated schema 20 main process`,
            expectedBehavior: "The frozen workflow persists exact state and evidence",
            severity: "S2",
            priority: "P2",
            attachmentIds: [],
            ...(assigned ? { ownerId: employee.userId, verificationOwnerId: employee.userId } : {}),
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
          idempotencyKey: `schema20:${name}:${randomUUID()}`,
          ...extra,
        },
        employee.accessToken,
      );
    }

    async function runningBug(title, preparedBug) {
      const bug = preparedBug ?? (await createBug(title));
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

    async function manuallyCompletedBug(title) {
      const bug = await createBug(title);
      const completed = await action(
        `${title}: manual complete`,
        bug.id,
        "manual_complete",
        bug.version,
        { note: `${title} was completed manually and is ready for verification` },
      );
      check(`${title} manual completion state`, completed.bug.state, "ready_for_verification");
      const context = await tool(
        `${title}: read manual completion context`,
        "qa_get_bug_context",
        { projectId, bugId: bug.id },
        employee.accessToken,
      );
      checkTrue(
        `${title} created one manual repair attempt`,
        context.humanWorkflow.repairAttempt?.id,
      );
      check(`${title} manual repair mode`, context.humanWorkflow.repairAttempt.mode, "human");
      check(
        `${title} manual repair delivered`,
        context.humanWorkflow.repairAttempt.status,
        "delivered",
      );
      return { bug: completed.bug, attempt: context.humanWorkflow.repairAttempt };
    }

    const editableTitle = "Direct HTTP terminal failure";
    const unassignedBug = await createBug(editableTitle, false);
    check("new editable Bug starts unassigned", unassignedBug.ownerId, null);
    check("new editable Bug starts without verifier", unassignedBug.verificationOwnerId, null);
    const editedTitle = `${editableTitle} assigned`;
    const editKey = `schema20:edit:${randomUUID()}`;
    const editRequest = {
      expectedVersion: unassignedBug.version,
      title: editedTitle,
      description: "Edited and explicitly assigned through the actual server MCP",
      ownerId: employee.userId,
      verificationOwnerId: employee.userId,
    };
    const editArgs = {
      projectId,
      bugId: unassignedBug.id,
      request: editRequest,
      idempotencyKey: editKey,
    };
    const editedBug = await tool(
      "edit and assign Bug",
      "qa_update_bug",
      editArgs,
      employee.accessToken,
    );
    check("edited Bug title", editedBug.title, editedTitle);
    check("edited Bug owner assignment", editedBug.ownerId, employee.userId);
    check("edited Bug verifier assignment", editedBug.verificationOwnerId, employee.userId);
    check("edit increments version once", editedBug.version, unassignedBug.version + 1);
    const editReplay = await tool(
      "replay exact Bug edit",
      "qa_update_bug",
      editArgs,
      employee.accessToken,
    );
    check("exact Bug edit replay returns the committed projection", editReplay, editedBug);
    await tool(
      "changed Bug edit replay is rejected",
      "qa_update_bug",
      {
        ...editArgs,
        request: { ...editRequest, title: `${editedTitle} changed replay` },
      },
      employee.accessToken,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    await tool(
      "stale Bug edit is rejected",
      "qa_update_bug",
      {
        projectId,
        bugId: unassignedBug.id,
        request: { expectedVersion: unassignedBug.version, priority: "P1" },
        idempotencyKey: `schema20:stale-edit:${randomUUID()}`,
      },
      employee.accessToken,
      "VERSION_CONFLICT",
    );
    await tool(
      "cross-project Bug detail is rejected",
      "qa_get_bug_context",
      { projectId: secondaryProjectId, bugId: unassignedBug.id },
      crossProjectEmployee.accessToken,
      "NOT_FOUND",
    );
    await tool(
      "cross-project Bug edit is rejected",
      "qa_update_bug",
      {
        projectId: secondaryProjectId,
        bugId: unassignedBug.id,
        request: { expectedVersion: editedBug.version, title: "must never cross projects" },
        idempotencyKey: `schema20:cross-project-edit:${randomUUID()}`,
      },
      crossProjectEmployee.accessToken,
      "NOT_FOUND",
    );
    const commentRequest = {
      clientSubmissionId: randomUUID(),
      body: "Actual server MCP retained this project-scoped Bug comment",
    };
    const initialComment = await tool(
      "add Bug comment",
      "qa_add_comment",
      { projectId, bugId: unassignedBug.id, request: commentRequest },
      employee.accessToken,
    );
    const commentReplay = await tool(
      "replay exact Bug comment",
      "qa_add_comment",
      { projectId, bugId: unassignedBug.id, request: commentRequest },
      employee.accessToken,
    );
    check("comment replay identity", commentReplay.comment.id, initialComment.comment.id);
    check("comment replay correlation", commentReplay.correlationId, initialComment.correlationId);

    const failedFixture = await runningBug(editableTitle, editedBug);
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

    async function startVerificationFixture(title, manualCompletion = false) {
      const delivered = manualCompletion
        ? await manuallyCompletedBug(title)
        : await deliveredBug(title);
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

    const evidenceFixture = await startVerificationFixture("Captured passed verification", true);
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
            filename: `schema20-main-${index + 1}.png`,
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
              qaAppVersion: "schema20-main-live",
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
      resultSummary: "Actual main process retained the exact evidence chain",
      attachmentIds: uploaded.map(({ attachmentId }) => attachmentId),
      captureBundleId: captureId,
    };
    const passedArgs = {
      projectId,
      bugId: evidenceFixture.bug.id,
      action: "close",
      verificationId: evidenceFixture.verification.id,
      expectedVersion: evidenceFixture.verification.version,
      idempotencyKey: `schema20:close:${evidenceFixture.verification.id}`,
      request: passedRequest,
    };
    const closed = await tool(
      "close with captured passed result",
      "qa_bug_action",
      passedArgs,
      employee.accessToken,
    );
    const passed = closed.result;
    check("explicit close action", closed.action, "close");
    check("passed result first write", passed.replayed, false);
    check("passed result capture", passed.captureBundleId, captureId);
    check("passed result closes Bug", closed.bug.state, "closed");
    check(
      "passed result exact attachments",
      [...passed.attachmentIds].sort(),
      uploaded.map(({ attachmentId }) => attachmentId).sort(),
    );
    const closedReplay = await tool(
      "replay captured close result",
      "qa_bug_action",
      passedArgs,
      employee.accessToken,
    );
    const passedReplay = closedReplay.result;
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

    const failedContext = await tool(
      "read edited/commented/failed Bug detail",
      "qa_get_bug_context",
      { projectId, bugId: failedFixture.bug.id },
      employee.accessToken,
    );
    check("detail retains edited title", failedContext.bug.title, editedTitle);
    check("detail retains owner assignment", failedContext.bug.ownerId, employee.userId);
    checkTrue(
      "detail retains exact comment",
      failedContext.comments.items.some((item) => item.id === initialComment.comment.id),
    );
    const failedComments = await tool(
      "read Bug comments",
      "qa_list_comments",
      { projectId, bugId: failedFixture.bug.id, query: { limit: 100 } },
      employee.accessToken,
    );
    check(
      "comment readback occurs once despite replay",
      failedComments.items.filter((item) => item.id === initialComment.comment.id).length,
      1,
    );
    const failedEvents = await tool(
      "read Bug event history",
      "qa_list_events",
      { projectId, bugId: failedFixture.bug.id },
      employee.accessToken,
    );
    checkTrue(
      "event history remains project scoped",
      failedEvents.items.every(
        (item) => item.projectId === projectId && item.bugId === failedFixture.bug.id,
      ),
    );
    check(
      "comment replay emits one matching event",
      failedEvents.items.filter(
        (item) =>
          item.type === "comment.created" &&
          item.payload?.commentId === initialComment.comment.id &&
          item.correlationId === initialComment.correlationId,
      ).length,
      1,
    );
    check(
      "Bug edit replay emits one matching update event",
      failedEvents.items.filter(
        (item) =>
          item.type === "bug.updated" &&
          item.aggregate?.id === editedBug.id &&
          item.payload?.fromVersion === unassignedBug.version &&
          item.payload?.toVersion === editedBug.version,
      ).length,
      1,
    );
    for (const eventType of [
      "bug.updated",
      "comment.created",
      "repair_attempt.created",
      "repair_attempt.started",
      "repair_attempt.failed",
    ]) {
      checkTrue(
        `event history contains ${eventType}`,
        failedEvents.items.some((item) => item.type === eventType),
      );
    }
    const closedContext = await tool(
      "read closed evidence Bug detail",
      "qa_get_bug_context",
      { projectId, bugId: evidenceFixture.bug.id },
      employee.accessToken,
    );
    check("closed detail state", closedContext.bug.state, "closed");
    check(
      "closed detail latest Verification",
      closedContext.humanWorkflow.latestVerification.id,
      evidenceFixture.verification.id,
    );
    check(
      "closed detail Verification status",
      closedContext.humanWorkflow.latestVerification.status,
      "passed",
    );
    check(
      "closed detail exact attachments",
      closedContext.attachments.items.map(({ attachmentId }) => attachmentId).sort(),
      uploaded.map(({ attachmentId }) => attachmentId).sort(),
    );

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

    const expectedListBugIds = new Set([
      failedFixture.bug.id,
      supersedeFixture.bug.id,
      evidenceFixture.bug.id,
      blockedFixture.bugId,
      verificationFailedFixture.bugId,
    ]);
    const listedBugIds = new Set();
    const seenListCursors = new Set();
    let listCursor = null;
    let listSnapshotSequence = null;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const query = new URLSearchParams({
        projectId,
        verificationOwnerId: employee.userId,
        limit: "2",
      });
      if (listCursor !== null) query.set("cursor", listCursor);
      const page = await httpJson(
        `read signed Bug list page ${pageNumber + 1}`,
        `/api/v1/bugs?${query.toString()}`,
        { method: "GET" },
        employee.accessToken,
      );
      if (listSnapshotSequence === null) listSnapshotSequence = page.body.snapshotSequence;
      check(
        `Bug list page ${pageNumber + 1} retains one snapshot`,
        page.body.snapshotSequence,
        listSnapshotSequence,
      );
      for (const bug of page.body.items) listedBugIds.add(bug.id);
      listCursor = page.body.nextCursor;
      if (listCursor === null) break;
      checkTrue(
        `Bug list page ${pageNumber + 1} uses an HMAC cursor`,
        /^b1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(listCursor),
      );
      checkTrue(
        `Bug list page ${pageNumber + 1} cursor is unique`,
        !seenListCursors.has(listCursor),
      );
      seenListCursors.add(listCursor);
    }
    check("Bug list pagination completed", listCursor, null);
    check(
      "Bug list returned each assigned Bug once",
      [...listedBugIds].sort(),
      [...expectedListBugIds].sort(),
    );

    const readback = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      check(
        "raw DB schema",
        readback.prepare("PRAGMA user_version").get().user_version,
        expectedSchemaVersion,
      );
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
      secondaryProjectId,
      directFail: {
        bugId: failedFixture.bug.id,
        attemptId: failedFixture.attempt.id,
        commentId: initialComment.comment.id,
        editedVersion: editedBug.version,
      },
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
    check(
      "server MCP remains expected schema",
      Number(healthAfter.schemaVersion),
      expectedSchemaVersion,
    );
    proof.status = "passed_expected_schema_actual_main_http_and_server_mcp";
  } catch (error) {
    proof.status = "failed_retained";
    proof.failure = String(error?.stack ?? error);
    process.exitCode = 1;
  } finally {
    const logoutFailures = [];
    for (const session of [...sessions].reverse()) {
      const cleanup = { login: session.label, status: "pending" };
      proof.cleanup.sessions.push(cleanup);
      try {
        await tool(`cleanup logout for ${session.label}`, "qa_logout", {}, session.accessToken);
        cleanup.status = "logged_out";
      } catch (error) {
        cleanup.status = "failed";
        cleanup.failure = "SESSION_LOGOUT_FAILED";
        cleanup.detail = redactSchema19Evidence(String(error?.message ?? error), secrets);
        logoutFailures.push(session.label);
      }
    }
    proof.cleanup.allLoggedOut = logoutFailures.length === 0;
    if (logoutFailures.length > 0) {
      proof.cleanup.failure = "ONE_OR_MORE_SESSION_LOGOUTS_FAILED";
      if (!proof.status.startsWith("failed")) {
        proof.status = "failed_cleanup_retained";
        proof.failure = "SESSION_LOGOUT_FAILED";
      }
      process.exitCode = 1;
    }
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
        expectedSchemaVersion,
        command:
          "node scripts/project-components/schema19-main-live.mjs --run C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-final-sol-0909/instance.json",
        acceptanceScope,
      }),
    );
  }
}
