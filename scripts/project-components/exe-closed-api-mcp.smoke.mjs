import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";

// Preparation is inert: only this explicit switch authorizes the live fixture run.
if (process.argv[2] !== "--run") {
  console.log(
    "Usage: node scripts/project-components/exe-closed-api-mcp.smoke.mjs --run <preview-instance.json> <project-A> <project-B-read-denial-only> <installed-preview.exe>",
  );
  process.exit(0);
}
assert.equal(process.platform, "win32", "The installed-process boundary uses Windows CIM");
const [, , , configFile, projectId, otherProjectId, exeArgument, ...extra] = process.argv;
assert.equal(extra.length, 0, "Unexpected arguments");
const config = readParallelInstanceConfig(configFile);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
assert.match(projectId ?? "", uuid);
assert.match(otherProjectId ?? "", uuid);
assert.notEqual(projectId, otherProjectId);
assert.equal(config.apiHost, "127.0.0.1");
assert.equal(config.apiPort, 4419);
assert.equal(config.mcpPort, 4421);
assert.equal(config.desktopMcpPort, 4420);
assert.ok(exeArgument && isAbsolute(exeArgument), "Explicit installed preview EXE is required");
const previewExe = realpathSync.native(exeArgument);
assert.equal(basename(previewExe).toLowerCase(), "relayqahubpreview.exe");
assert.equal(basename(dirname(previewExe)).toLowerCase(), "relayqahubpreview");
const origin = `http://${config.apiHost}:${config.apiPort}`;
const mcpOrigin = `http://${config.apiHost}:${config.mcpPort}`;
const vendor = "application/vnd.relay-qa-hub.v1.1+json";
const runId = randomUUID();
const startedAt = new Date().toISOString();
const outputRoot = join(config.runtimeRoot, "acceptance", `exe-closed-${runId}`);
const checks = [];
const boundaries = [];
const fixtures = [];
const credentials = new Set();
let sequence = 0;
let passed = false;
let failure;

function redact(value, depth = 0) {
  if (depth > 64) return "[REDACTED_NESTING_LIMIT]";
  if (typeof value === "string") {
    try {
      const decoded = JSON.parse(value);
      if (decoded !== null && typeof decoded === "object")
        return JSON.stringify(redact(decoded, depth + 1));
      if (typeof decoded === "string") {
        const cleaned = redact(decoded, depth + 1);
        if (cleaned !== decoded) return JSON.stringify(cleaned);
      }
    } catch {
      // Plain text is preserved; numeric-looking protocol versions must not be normalized.
    }
    let text = value;
    for (const credential of credentials) text = text.replaceAll(credential, "[REDACTED]");
    return text.replace(/Bearer\s+[^\s"<>]+/giu, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/token|secret|password|cookie|authorization|csrf|private.?key|api.?key|service.?key|credential/iu.test(
            key,
          ),
      )
      .map(([key, item]) => [key, redact(item, depth + 1)]),
  );
}

function assertDesktopAbsent(label) {
  const script = `
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($env:QA_CLOSED_TEST_EXE)
$root = [IO.Path]::GetDirectoryName($target).TrimEnd('\\') + '\\'
$imageName = [IO.Path]::GetFileName($target)
$processes = @(Get-CimInstance Win32_Process -Property ProcessId,Name,ExecutablePath -ErrorAction Stop | Where-Object {
  ($_.ExecutablePath -and ($_.ExecutablePath.Equals($target, [StringComparison]::OrdinalIgnoreCase) -or $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase))) -or $_.Name -ieq $imageName
} | Select-Object -ExpandProperty ProcessId)
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq [int]$env:QA_CLOSED_TEST_PORT } | Select-Object -ExpandProperty OwningProcess)
@{ observedAt = [DateTime]::UtcNow.ToString('o'); previewProcessAbsent = ($processes.Count -eq 0); desktopMcpAbsent = ($listeners.Count -eq 0); processIds = $processes; listenerPids = $listeners } | ConvertTo-Json -Depth 5 -Compress
`;
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      env: {
        ...process.env,
        QA_CLOSED_TEST_EXE: previewExe,
        QA_CLOSED_TEST_PORT: String(config.desktopMcpPort),
      },
    },
  );
  assert.equal(result.status, 0, `CIM/listener check failed at ${label}: ${result.stderr}`);
  const observation = JSON.parse(result.stdout.replace(/^\uFEFF/u, ""));
  boundaries.push({ label, ...observation });
  assert.equal(
    observation.previewProcessAbsent,
    true,
    `Preview installed process present at ${label}`,
  );
  assert.equal(observation.desktopMcpAbsent, true, `Desktop MCP listener present at ${label}`);
  assert.deepEqual(observation.processIds, []);
  assert.deepEqual(observation.listenerPids, []);
  return boundaries.length - 1;
}

async function wire(label, url, body, options = {}) {
  const beforeBoundary = assertDesktopAbsent(`${label}:before`);
  const entry = {
    label,
    url,
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    startedAt: new Date().toISOString(),
    beforeBoundary,
    request: redact(body),
  };
  checks.push(entry);
  try {
    const response = await fetch(url, {
      method: entry.method,
      redirect: "error",
      headers: {
        accept: options.rpc ? "application/json, text/event-stream" : vendor,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.project ? { "x-qa-project-id": options.project } : {}),
        ...(options.key ? { "idempotency-key": options.key } : {}),
        ...(options.rpc ? { "MCP-Protocol-Version": "2025-06-18" } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const responseText = await response.text();
    const value = responseText.length === 0 ? null : JSON.parse(responseText);
    // Register secrets before recording the login envelope, including mirrored JSON text.
    const remember = (item) => {
      if (typeof item === "string") {
        try {
          remember(JSON.parse(item));
        } catch {
          /* Plain text contains no JSON fields. */
        }
      } else if (Array.isArray(item)) item.forEach(remember);
      else if (item && typeof item === "object") {
        for (const [key, child] of Object.entries(item)) {
          if (/accessToken|refreshToken|csrfToken/iu.test(key) && typeof child === "string")
            credentials.add(child);
          else remember(child);
        }
      }
    };
    remember(value);
    entry.status = response.status;
    entry.contentType = response.headers.get("content-type");
    // Listing is required, but unrelated employees' Bug bodies need not enter this proof.
    const summarizeList = (list) => ({
      ...list,
      items: list.items?.map(({ id, projectId: scope, state, version }) => ({
        id,
        projectId: scope,
        state,
        version,
      })),
    });
    let evidenceValue = options.list ? summarizeList(value) : value;
    if (
      body?.method === "tools/call" &&
      body.params?.name === "qa_list_bugs" &&
      value?.result?.isError === false
    ) {
      const source = value.result.structuredContent ?? JSON.parse(value.result.content[0].text);
      const summary = summarizeList(source);
      evidenceValue = {
        ...value,
        result: {
          ...value.result,
          structuredContent: summary,
          content: [{ type: "text", text: JSON.stringify(summary) }],
        },
      };
    }
    entry.response = redact(evidenceValue);
    assert.equal(
      response.status,
      options.status ?? 200,
      `${label}: ${JSON.stringify(redact(value))}`,
    );
    if (options.code) assert.equal(value.code, options.code, label);
    return value;
  } finally {
    entry.finishedAt = new Date().toISOString();
    entry.afterBoundary = assertDesktopAbsent(`${label}:after`);
  }
}

function lane(kind) {
  let token;
  const request = (label, method, path, body, options = {}) => {
    assert.ok(
      path.startsWith("/api/v1/") && !path.includes("/mcp"),
      "HTTP lane must use direct business routes",
    );
    return wire(`HTTP ${label}`, origin + path, body, {
      token,
      project: projectId,
      method,
      ...options,
    });
  };
  const rpc = async (method, params) => {
    const id = ++sequence;
    const envelope = await wire(
      `MCP ${method} ${params?.name ?? ""}`,
      `${mcpOrigin}/mcp`,
      { jsonrpc: "2.0", id, method, params },
      { token, rpc: true },
    );
    assert.equal(envelope.jsonrpc, "2.0");
    assert.equal(envelope.id, id);
    assert.equal(envelope.error, undefined);
    return envelope.result;
  };
  const tool = async (name, args, expectedCode) => {
    const result = await rpc("tools/call", { name, arguments: args });
    const value = result.structuredContent ?? JSON.parse(result.content[0].text);
    assert.equal(
      result.isError,
      Boolean(expectedCode),
      `${name}: ${JSON.stringify(redact(value))}`,
    );
    if (expectedCode) assert.equal(value.code, expectedCode);
    return value;
  };
  const invoke = (label, method, path, body, name, args, options = {}) =>
    kind === "HTTP" ? request(label, method, path, body, options) : tool(name, args, options.code);
  return {
    kind,
    async initialize() {
      if (kind === "MCP") {
        const ready = await wire("MCP health", `${mcpOrigin}/health`);
        assert.equal(ready.status, "ready");
        const result = await rpc("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "exe-closed-real-acceptance", version: "1" },
        });
        assert.equal(result.protocolVersion, "2025-06-18");
        const initialized = await wire(
          "MCP initialized notification",
          `${mcpOrigin}/mcp`,
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { rpc: true, status: 202 },
        );
        assert.equal(initialized, null);
        const catalog = await rpc("tools/list", {});
        for (const name of [
          "qa_login",
          "qa_create_bug",
          "qa_update_bug",
          "qa_add_comment",
          "qa_bug_action",
          "qa_delete_bug",
        ])
          assert.ok(catalog.tools.some((entry) => entry.name === name));
      }
    },
    async login() {
      const name = `Closed${kind}${randomUUID().replaceAll("-", "")}`;
      const result = await invoke(
        "new employee login",
        "POST",
        "/api/v1/auth/login",
        { name, projectId, client: "android" },
        "qa_login",
        { projectId, name },
      );
      assert.equal(result.projectId, projectId);
      assert.match(result.userId, uuid);
      assert.ok(result.accessToken);
      token = result.accessToken;
      credentials.add(token);
      return { userId: result.userId, name };
    },
    projects: () =>
      invoke("projects", "GET", "/api/v1/projects?limit=100", undefined, "qa_list_projects", {}),
    components: () =>
      invoke(
        "components off",
        "GET",
        `/api/v1/projects/${projectId}/components`,
        undefined,
        "qa_get_components",
        { projectId },
      ),
    list: (wrong = false) => {
      const scope = wrong ? otherProjectId : projectId;
      return invoke(
        "list" + (wrong ? " forbidden project" : ""),
        "GET",
        `/api/v1/bugs?projectId=${scope}&limit=100`,
        undefined,
        "qa_list_bugs",
        { projectId: scope, filters: { limit: 100 } },
        {
          project: scope,
          list: !wrong,
          ...(wrong ? { status: 403, code: "PROJECT_NOT_ACCESSIBLE" } : {}),
        },
      );
    },
    create: (body) =>
      invoke(
        "create",
        "POST",
        "/api/v1/bugs",
        { ...body, projectId },
        "qa_create_bug",
        { projectId, request: body },
        { status: 201, key: `submission:${body.clientSubmissionId}:commit` },
      ),
    read: async (id, deleted = false) => {
      const result = await invoke(
        "detail" + (deleted ? " deleted" : ""),
        "GET",
        `/api/v1/bugs/${id}`,
        undefined,
        "qa_get_bug_context",
        { projectId, bugId: id },
        deleted ? { status: 404, code: "NOT_FOUND" } : {},
      );
      return kind === "MCP" && !deleted ? result.bug : result;
    },
    edit: (id, body, stale = false) =>
      invoke(
        "edit" + (stale ? " stale" : ""),
        "PATCH",
        `/api/v1/bugs/${id}`,
        body,
        "qa_update_bug",
        {
          projectId,
          bugId: id,
          request: body,
          idempotencyKey: `closed:${runId}:${kind}:${stale ? "stale" : "edit"}`,
        },
        {
          key: `closed:${runId}:${kind}:${stale ? "stale" : "edit"}`,
          ...(stale ? { status: 412, code: "VERSION_CONFLICT" } : {}),
        },
      ),
    comment: (id, body) =>
      invoke(
        "comment",
        "POST",
        `/api/v1/bugs/${id}/comments`,
        body,
        "qa_add_comment",
        { projectId, bugId: id, request: body },
        { status: 201, key: `comment:${id}:${body.clientSubmissionId}` },
      ),
    comments: (id) =>
      invoke(
        "comments readback",
        "GET",
        `/api/v1/bugs/${id}/comments?limit=100`,
        undefined,
        "qa_list_comments",
        { projectId, bugId: id, request: { limit: 100 } },
      ),
    workflow: async (id) =>
      kind === "HTTP"
        ? request("workflow readback", "GET", `/api/v1/bugs/${id}/human-workflow`)
        : (await tool("qa_get_bug_context", { projectId, bugId: id })).humanWorkflow,
    events: (id) =>
      invoke(
        "events readback",
        "GET",
        `/api/v1/bugs/${id}/events?limit=100`,
        undefined,
        "qa_list_events",
        { projectId, bugId: id, request: { limit: 100 } },
      ),
    async manual(id, version, note) {
      const result = await invoke(
        "manual complete",
        "POST",
        `/api/v1/bugs/${id}/manual-complete`,
        { expectedVersion: version, reason: note },
        "qa_bug_action",
        {
          projectId,
          bugId: id,
          action: "manual_complete",
          expectedVersion: version,
          note,
          idempotencyKey: `workflow:manualCompleteBug:bug:${id}:v${version}`,
        },
        { key: `workflow:manualCompleteBug:bug:${id}:v${version}` },
      );
      return kind === "MCP" ? result.bug : result;
    },
    async verification(id, version, attemptId, actorId) {
      const body = {
        expectedVersion: version,
        repairAttemptId: attemptId,
        buildId: null,
        verifierId: actorId,
        criteria: "Independent human verification while preview EXE is closed",
      };
      const key = `workflow:createVerification:bug:${id}:attempt:${attemptId}:v${version}`;
      const result = await invoke(
        "create verification",
        "POST",
        `/api/v1/bugs/${id}/verifications`,
        body,
        "qa_bug_action",
        {
          projectId,
          bugId: id,
          action: "create_verification",
          expectedVersion: version,
          idempotencyKey: key,
          request: body,
        },
        { status: 201, key },
      );
      return kind === "MCP" ? result.result : result;
    },
    async start(id, verification) {
      const key = `workflow:startVerification:verification:${verification.id}:v${verification.version}`;
      const result = await invoke(
        "start verification",
        "POST",
        `/api/v1/verifications/${verification.id}/start`,
        { expectedVersion: verification.version },
        "qa_bug_action",
        {
          projectId,
          bugId: id,
          action: "start_verification",
          verificationId: verification.id,
          expectedVersion: verification.version,
          idempotencyKey: key,
        },
        { key },
      );
      return kind === "MCP" ? result.result : result;
    },
    async result(id, verification, accepted) {
      const request = {
        submissionContractVersion: "1.1.0",
        clientSubmissionId: randomUUID(),
        resultSummary: accepted
          ? "Independent acceptance passed"
          : "Independent acceptance returned for more work",
        attachmentIds: [],
        ...(!accepted ? { failureReason: "Fixture first verification intentionally fails" } : {}),
      };
      const key = `workflow:recordVerificationResult:verification:${verification.id}:v${verification.version}`;
      const result = await invoke(
        accepted ? "close" : "return",
        "POST",
        `/api/v1/verifications/${verification.id}/result`,
        {
          ...request,
          expectedVersion: verification.version,
          status: accepted ? "passed" : "failed",
        },
        "qa_bug_action",
        {
          projectId,
          bugId: id,
          action: accepted ? "close" : "verify_fail",
          verificationId: verification.id,
          expectedVersion: verification.version,
          idempotencyKey: key,
          request,
        },
        { key },
      );
      return kind === "MCP" ? result.result : result;
    },
    delete: (id, version) =>
      invoke(
        "soft delete",
        "DELETE",
        `/api/v1/bugs/${id}?expectedVersion=${version}`,
        undefined,
        "qa_delete_bug",
        { projectId, bugId: id, expectedVersion: version },
        { key: `web:deleteBug:bug:${id}:v${version}` },
      ),
  };
}

async function exercise(client) {
  const record = { lane: client.kind, startedAt: new Date().toISOString(), states: [] };
  fixtures.push(record);
  await client.initialize();
  const actor = await client.login();
  record.actorId = actor.userId;
  record.newEmployeeName = actor.name;
  assert.deepEqual(
    (await client.projects()).items.map((item) => item.id),
    [projectId],
  );
  const components = (await client.components()).items;
  assert.equal(components.length, 5);
  assert.ok(components.every((item) => !item.enabled));
  await client.list(true);
  await client.list();
  const creation = await client.create({
    submissionContractVersion: "1.1.0",
    clientSubmissionId: randomUUID(),
    title: `EXE closed ${client.kind} ${runId}`,
    description: "Isolated fixture for direct service use with preview EXE closed",
    expectedBehavior: "Comment, return and close without a desktop process",
    severity: "S3",
    priority: "P3",
    occurrence: {
      observedAt: new Date().toISOString(),
      platform: "web",
      steps: ["Independent service operation"],
      actualBehavior: "Preserve real server state and events",
    },
  });
  let bug = creation.bug;
  assert.equal(bug.projectId, projectId);
  assert.equal(bug.reporterId, actor.userId);
  record.bugId = bug.id;
  record.bugKey = bug.key;
  const remember = (state) => {
    assert.equal(bug.id, record.bugId);
    assert.equal(bug.projectId, projectId);
    assert.equal(bug.state, state);
    record.states.push({ state, version: bug.version });
  };
  remember("reported");
  assert.equal((await client.read(bug.id)).id, bug.id);
  const oldVersion = bug.version;
  bug = await client.edit(bug.id, {
    expectedVersion: oldVersion,
    title: `Edited EXE closed ${client.kind} ${runId}`,
  });
  assert.equal(bug.version, oldVersion + 1);
  await client.edit(
    bug.id,
    { expectedVersion: oldVersion, title: "Stale fixture edit must fail" },
    true,
  );
  const commentBody = {
    clientSubmissionId: randomUUID(),
    body: `Real ${client.kind} comment while preview EXE is closed`,
  };
  const comment = await client.comment(bug.id, commentBody);
  const replay = await client.comment(bug.id, commentBody);
  assert.equal(replay.comment.id, comment.comment.id);
  record.commentId = comment.comment.id;
  const comments = (await client.comments(bug.id)).items;
  assert.equal(
    comments.filter(
      (item) =>
        item.id === record.commentId &&
        item.body === commentBody.body &&
        item.authorId === actor.userId,
    ).length,
    1,
  );
  bug = await client.read(bug.id);
  for (const accepted of [false, true]) {
    const beforeVersion = bug.version;
    const note = accepted
      ? "Second human completion for final acceptance"
      : "First human completion before intentional return";
    bug = await client.manual(bug.id, beforeVersion, note);
    remember("ready_for_verification");
    if (!accepted) {
      const repeated = await client.manual(bug.id, beforeVersion, note);
      assert.equal(repeated.version, bug.version);
    }
    const workflow = await client.workflow(bug.id);
    assert.equal(workflow.repairAttempt.mode, "human");
    assert.equal(workflow.repairAttempt.status, "delivered");
    let verification = await client.verification(
      bug.id,
      bug.version,
      workflow.repairAttempt.id,
      actor.userId,
    );
    verification = await client.start(bug.id, verification);
    assert.equal(verification.status, "in_progress");
    const result = await client.result(bug.id, verification, accepted);
    assert.equal(result.verification.status, accepted ? "passed" : "failed");
    assert.equal(result.verification.verifierId, actor.userId);
    bug = await client.read(bug.id);
    remember(accepted ? "closed" : "ready");
    record[accepted ? "acceptedVerificationId" : "returnedVerificationId"] = verification.id;
    record[accepted ? "acceptedAttemptId" : "returnedAttemptId"] = workflow.repairAttempt.id;
  }
  const finalWorkflow = await client.workflow(bug.id);
  assert.equal(finalWorkflow.latestVerification.id, record.acceptedVerificationId);
  assert.equal(finalWorkflow.latestVerification.status, "passed");
  const events = (await client.events(bug.id)).items;
  assert.equal(events.filter((event) => event.type === "verification.result_recorded").length, 2);
  assert.ok(events.every((event) => event.actor?.id === actor.userId));
  record.eventIds = events.map((event) => event.id);
  assert.ok((await client.list()).items.some((item) => item.id === bug.id));
  record.deleteResult = await client.delete(bug.id, bug.version);
  await client.read(bug.id, true);
  assert.ok(!(await client.list()).items.some((item) => item.id === bug.id));
  record.finishedAt = new Date().toISOString();
  record.passed = true;
}

try {
  assertDesktopAbsent("run:start");
  const ready = await wire("HTTP health", `${origin}/api/v1/health/ready`);
  assert.equal(ready.status, "ready");
  assert.equal(String(ready.schemaVersion), "14");
  await exercise(lane("HTTP"));
  await exercise(lane("MCP"));
  assert.notEqual(fixtures[0].actorId, fixtures[1].actorId);
  assert.notEqual(fixtures[0].bugId, fixtures[1].bugId);
  passed = true;
} catch (error) {
  failure = redact(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try {
    assertDesktopAbsent("run:end");
  } catch (error) {
    passed = false;
    failure = redact(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  mkdirSync(outputRoot, { recursive: true });
  const evidence = join(outputRoot, "exe-closed-api-mcp.json");
  const proof = redact({
    runId,
    instanceId: config.instanceId,
    projectId,
    otherProjectId,
    startedAt,
    finishedAt: new Date().toISOString(),
    previewExe,
    apiOrigin: origin,
    serverMcpOrigin: mcpOrigin,
    desktopMcpPort: config.desktopMcpPort,
    passed,
    failure,
    boundaries,
    fixtures,
    checks,
    boundaryMeaning:
      "Installed preview process and desktop MCP listener were absent at every recorded request boundary. This script does not close, kill, start, or restart any application.",
    scope:
      "Baselines 11 and 12: independent login, queries, edit, comment, manual completion, verification return, completion, close and soft deletion through existing direct HTTP routes and server JSON-RPC MCP tools.",
    notClaimed: [
      "All legacy frozen contract actions",
      "External component execution",
      "Physical device acceptance",
    ],
  });
  const text = JSON.stringify(proof, null, 2) + "\n";
  for (const credential of credentials)
    assert.ok(!text.includes(credential), "Secret redaction failed");
  writeFileSync(evidence, text, { flag: "wx" });
  console.log(
    JSON.stringify({
      passed,
      requests: checks.length,
      boundaryChecks: boundaries.length,
      evidence,
      failure,
    }),
  );
}
