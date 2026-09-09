import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { redactSchema19Evidence } from "./schema19-main-live.mjs";

const sourcePath = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(sourcePath), "../..");
const expectedInstancePath = resolve(
  "C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-schema19-sol-0909/instance.json",
);
const evidenceRoot = resolve(sourceRoot, "docs/evidence/project-components/schema19-main-live");
const sensitiveKey =
  /token|secret|password|cookie|authorization|csrf|private.?key|api.?key|credential/iu;
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

function processIdentities(ports) {
  const command = [
    `$ports=@(${ports.join(",")})`,
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

function requestByLabel(prior, label) {
  const value = prior.requests.find((request) => request.label === label);
  assert.ok(value, `Prior request is missing: ${label}`);
  return value;
}

function structured(request) {
  const value = request.response?.result?.structuredContent;
  assert.ok(
    value && typeof value === "object",
    `Prior structured response is missing: ${request.label}`,
  );
  return value;
}

function validateInputs(configFile, config, priorProofFile, prior) {
  assert.equal(resolve(configFile), expectedInstancePath);
  assert.equal(resolve(process.cwd()), sourceRoot);
  assert.equal(config.instanceId, "qa-hub-preview-schema19-sol-0909");
  assert.equal(resolve(config.sourceRoot), sourceRoot);
  assert.equal(resolve(config.runtimeRoot), dirname(expectedInstancePath));
  assert.equal(config.apiHost, "127.0.0.1");
  assert.equal(config.apiPort, 4519);
  assert.equal(config.mcpPort, 4521);
  assert.ok(relative(config.runtimeRoot, config.dataRoot).startsWith("data"));
  assert.ok(!resolve(config.runtimeRoot).toLowerCase().startsWith("d:\\relay-qa-hub"));
  assert.equal(prior.status, "failed_retained");
  assert.equal(prior.instanceId, config.instanceId);
  assert.match(prior.failure, /capture enrichment[\s\S]*partial[\s\S]*complete/u);
  const relativeProof = relative(evidenceRoot, resolve(priorProofFile));
  assert.ok(!relativeProof.startsWith("..") && !resolve(relativeProof).startsWith(".."));
  assert.equal(relativeProof, join(prior.runId, "proof.json"));
}

async function resume(configFile, priorProofFile) {
  const configBytes = readFileSync(configFile);
  const config = JSON.parse(configBytes);
  const priorBytes = readFileSync(priorProofFile);
  const prior = JSON.parse(priorBytes);
  validateInputs(configFile, config, priorProofFile, prior);

  const resumeId = randomUUID();
  const output = dirname(resolve(priorProofFile));
  const projectId = prior.projectId;
  const secrets = new Set();
  const loginRequest = requestByLabel(prior, "project name login");
  const employeeName = loginRequest.request.params.arguments.name;
  const employeeId = structured(loginRequest).userId;
  const directFailRequest = requestByLabel(prior, "direct HTTP vendor fail");
  const directAttemptId = directFailRequest.path.match(
    /^\/api\/v1\/repair-attempts\/([0-9a-f-]{36})\/fail$/u,
  )?.[1];
  assert.ok(directAttemptId);
  const supersedeRequest = requestByLabel(
    prior,
    "GM atomically supersedes through actual server MCP",
  );
  const supersedeArguments = supersedeRequest.request.params.arguments;
  const successorId = supersedeArguments.successor.id;
  const successorFailRequest = requestByLabel(prior, "direct HTTP ends external successor");
  assert.ok(successorFailRequest.path.includes(successorId));
  const passedRequest = requestByLabel(prior, "record captured passed result");
  const passedArguments = passedRequest.request.params.arguments;
  const passedResponse = structured(passedRequest);
  const captureId = passedArguments.request.captureBundleId;
  const attachmentIds = passedArguments.request.attachmentIds;
  const attachmentFacts = prior.requests
    .filter((request) => request.label.startsWith("read retained attachment "))
    .map((request) => structured(request));
  assert.equal(attachmentFacts.length, 2);

  const proof = {
    schemaVersion: 1,
    status: "running",
    resumeId,
    resumedFromRunId: prior.runId,
    resumedFromProofSha256: sha256(priorBytes),
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
      resumedAtExactFailedStage: true,
      priorProjectAndRecordsReused: true,
      priorRequestsNotReplayed: true,
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

  async function tool(label, name, args, accessToken) {
    const result = await mcpRpc(label, "tools/call", { name, arguments: args }, accessToken);
    const value = result.structuredContent ?? JSON.parse(result.content[0].text);
    rememberSecrets(value, secrets);
    assert.equal(result.isError, false, `${label}: ${safeJson(value)}`);
    return value;
  }

  try {
    const hostBefore = processIdentities([config.apiPort, config.mcpPort]);
    proof.hostBefore = hostBefore;
    check("same processes survived the failed assertion", hostBefore, prior.hostBefore);
    const apiHealth = await fetch(`http://127.0.0.1:${config.apiPort}/api/v1/health/ready`, {
      signal: AbortSignal.timeout(10_000),
    }).then((response) => response.json());
    const mcpHealth = await fetch(`http://127.0.0.1:${config.mcpPort}/health`, {
      signal: AbortSignal.timeout(10_000),
    }).then((response) => response.json());
    proof.healthBefore = { api: apiHealth, serverMcp: mcpHealth };
    check("resumed API ready", apiHealth.status, "ready");
    check("resumed API schema", String(apiHealth.schemaVersion), "19");
    check("resumed MCP ready", mcpHealth.status, "ready");
    check("resumed MCP schema", String(mcpHealth.schemaVersion), "19");
    await mcpRpc("resume server MCP initialization", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "schema19-main-live-resume", version: "1" },
    });
    const employee = await tool(
      "resume same employee login",
      "qa_login",
      { projectId, name: employeeName },
      undefined,
    );
    check("resume keeps employee identity", employee.userId, employeeId);

    const capture = await tool(
      "resume at failed capture read",
      "qa_get_capture",
      { projectId, captureId },
      employee.accessToken,
    );
    check("capture remains bound to prior identity", capture.captureId, captureId);
    check(
      "partial enrichment is correct for the synthetic fixture",
      capture.enrichmentStatus,
      "partial",
    );
    check("synthetic fixture attempted Poco", capture.poco.attempted, true);
    check("synthetic fixture negotiated two methods", capture.poco.negotiatedMethods, [
      "GetSDKVersion",
      "Screenshot",
    ]);
    check("full allowlist remains visible", capture.poco.allowedReadOnlyMethods.length, 6);
    const priorVerification = await tool(
      "read prior passed verification",
      "qa_get_verification",
      { projectId, verificationId: passedArguments.verificationId },
      employee.accessToken,
    );
    check("prior passed verification persisted", priorVerification.status, "passed");
    const priorContext = await tool(
      "read prior closed Bug context",
      "qa_get_bug_context",
      { projectId, bugId: passedResponse.bug.id },
      employee.accessToken,
    );
    check("prior passed Bug remains closed", priorContext.bug.state, "closed");
    check(
      "prior passed result remains latest",
      priorContext.humanWorkflow.latestVerification.status,
      "passed",
    );
    for (const expected of attachmentFacts) {
      const read = await tool(
        `resume retained attachment ${expected.attachmentId}`,
        "qa_read_attachment",
        { projectId, bugId: passedResponse.bug.id, attachmentId: expected.attachmentId },
        employee.accessToken,
      );
      check(`resumed attachment ${expected.attachmentId} hash`, read.sha256, expected.sha256);
      check(`resumed attachment ${expected.attachmentId} bytes`, read.blob, expected.blob);
    }

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
            description: `${title} resumed after the retained assertion`,
            expectedBehavior: "The result status persists through the actual main service",
            severity: "S2",
            priority: "P2",
            attachmentIds: [],
            ownerId: employee.userId,
            verificationOwnerId: employee.userId,
            occurrence: {
              observedAt: new Date().toISOString(),
              platform: "web",
              steps: ["Resume from the exact retained evidence stage"],
              actualBehavior: "The result status is pending",
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
          idempotencyKey: `schema19-resume:${name}:${randomUUID()}`,
          ...extra,
        },
        employee.accessToken,
      );
    }

    async function startVerificationFixture(title) {
      const bug = await createBug(title);
      const ready = await action(`${title}: ready`, bug.id, "ready", bug.version);
      const planned = await action(`${title}: plan`, bug.id, "plan_fix", ready.bug.version, {
        request: { assigneeId: employee.userId, summary: `${title} planned work` },
      });
      const running = await action(`${title}: start`, bug.id, "begin_fix", planned.result.version, {
        attemptId: planned.result.id,
      });
      const delivered = await action(
        `${title}: deliver`,
        bug.id,
        "submit_fix",
        running.result.version,
        {
          attemptId: running.result.id,
          request: {
            deliveryKind: "no_code",
            noCodeReason: "This resumed main acceptance exercises result persistence",
            summary: `${title} ready for verification`,
          },
        },
      );
      const created = await action(
        `${title}: create verification`,
        bug.id,
        "create_verification",
        delivered.bug.version,
        {
          request: {
            repairAttemptId: delivered.result.id,
            buildId: null,
            verifierId: employee.userId,
            criteria: `${title} exact acceptance criteria`,
          },
        },
      );
      const started = await action(
        `${title}: start verification`,
        bug.id,
        "start_verification",
        created.result.version,
        { verificationId: created.result.id },
      );
      return { bug: started.bug, attempt: delivered.result, verification: started.result };
    }

    async function submitOutcome(status) {
      const title = `${status} verification resumed main path`;
      const fixture = await startVerificationFixture(title);
      const clientSubmissionId = randomUUID();
      const reason = `${status} was recorded after resuming at the exact failed stage`;
      const request = {
        submissionContractVersion: "1.1.0",
        clientSubmissionId,
        expectedVersion: fixture.verification.version,
        status,
        resultSummary: reason,
        attachmentIds: [],
        ...(status === "blocked" ? { blockedReason: reason } : { failureReason: reason }),
      };
      const args = { projectId, verificationId: fixture.verification.id, request };
      const result = await tool(
        `record resumed ${status} result`,
        "qa_record_verification_result",
        args,
        employee.accessToken,
      );
      check(`${status} result first write`, result.replayed, false);
      check(`${status} Verification status`, result.verification.status, status);
      check(
        `${status} Bug state`,
        result.bug.state,
        status === "blocked" ? "ready_for_verification" : "ready",
      );
      check(
        `${status} RepairAttempt state`,
        result.repairAttempt.status,
        status === "blocked" ? "delivered" : "verification_failed",
      );
      const replay = await tool(
        `replay resumed ${status} result`,
        "qa_record_verification_result",
        args,
        employee.accessToken,
      );
      check(`${status} result replay`, replay.replayed, true);
      check(`${status} result replay event`, replay.eventId, result.eventId);
      const read = await tool(
        `read resumed ${status} verification`,
        "qa_get_verification",
        { projectId, verificationId: fixture.verification.id },
        employee.accessToken,
      );
      check(`${status} Verification readback`, read.status, status);
      return {
        bugId: fixture.bug.id,
        attemptId: fixture.attempt.id,
        verificationId: fixture.verification.id,
        clientSubmissionId,
      };
    }
    const blockedFixture = await submitOutcome("blocked");
    const failedFixture = await submitOutcome("failed");

    const databaseFile = join(config.dataRoot, "db", "qa-hub.sqlite");
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
        "three exact terminal snapshots despite prior replays",
        readback
          .prepare(
            "SELECT count(*) AS count FROM repair_attempt_terminal_snapshots WHERE attempt_id IN (?,?,?)",
          )
          .get(directAttemptId, supersedeArguments.attemptId, successorId).count,
        3,
      );
      check(
        "original superseded row retained",
        readback
          .prepare("SELECT status FROM repair_attempts WHERE id=?")
          .get(supersedeArguments.attemptId).status,
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
        supersedeArguments.attemptId,
      );
      check(
        "three exact result snapshots despite replays",
        readback
          .prepare(
            "SELECT count(*) AS count FROM verification_result_snapshots WHERE verification_id IN (?,?,?)",
          )
          .get(
            passedArguments.verificationId,
            blockedFixture.verificationId,
            failedFixture.verificationId,
          ).count,
        3,
      );
      check(
        "two exact passed-result attachments",
        readback
          .prepare("SELECT count(*) AS count FROM verification_attachments WHERE verification_id=?")
          .get(passedArguments.verificationId).count,
        2,
      );
      check(
        "capture bundle remains bound",
        readback.prepare("SELECT status FROM capture_bundles WHERE id=?").get(captureId).status,
        "bound",
      );
    } finally {
      readback.close();
    }

    proof.fixtures = {
      employeeId,
      prior: {
        directAttemptId,
        supersededAttemptId: supersedeArguments.attemptId,
        successorId,
        passedBugId: passedResponse.bug.id,
        passedVerificationId: passedArguments.verificationId,
        captureId,
        attachmentIds,
      },
      blocked: blockedFixture,
      failedVerification: failedFixture,
    };
    const hostAfter = processIdentities([config.apiPort, config.mcpPort]);
    proof.hostAfter = hostAfter;
    check("process identities unchanged throughout resume", hostAfter, hostBefore);
    const healthAfter = await fetch(`http://127.0.0.1:${config.mcpPort}/health`, {
      signal: AbortSignal.timeout(10_000),
    }).then((response) => response.json());
    proof.healthAfter = healthAfter;
    check("server MCP remains ready", healthAfter.status, "ready");
    check("server MCP remains schema 19", String(healthAfter.schemaVersion), "19");
    proof.status = "passed_resumed_schema19_actual_main_http_and_server_mcp";
  } catch (error) {
    proof.status = "failed_retained";
    proof.failure = String(error?.stack ?? error);
    process.exitCode = 1;
  } finally {
    proof.finishedAt = new Date().toISOString();
    const prefix = `resume-${resumeId}`;
    writeFileSync(join(output, `${prefix}.runner.mjs.txt`), readFileSync(sourcePath), {
      flag: "wx",
    });
    writeFileSync(join(output, `${prefix}.proof.json`), safeJson(proof), { flag: "wx" });
    console.log(
      JSON.stringify({
        status: proof.status,
        resumedFromRunId: prior.runId,
        resumeId,
        checks: proof.checks.length,
        requests: proof.requests.length,
        proof: join(output, `${prefix}.proof.json`),
      }),
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === sourcePath) {
  if (process.argv[2] === "--resume") {
    assert.equal(process.argv.length, 5);
    await resume(process.argv[3], process.argv[4]);
  } else {
    console.log(
      JSON.stringify({
        status: "not_run",
        command:
          "node scripts/project-components/schema19-main-live-resume.mjs --resume <instance.json> <failed-proof.json>",
      }),
    );
  }
}
