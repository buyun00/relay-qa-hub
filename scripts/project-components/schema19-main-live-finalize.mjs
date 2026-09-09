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

function requestByLabel(proof, label) {
  const value = proof.requests.find((request) => request.label === label);
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

function validateInputs(configFile, config, initialFile, initial, resumeFile, resume) {
  assert.equal(resolve(configFile), expectedInstancePath);
  assert.equal(resolve(process.cwd()), sourceRoot);
  assert.equal(config.instanceId, "qa-hub-preview-schema19-sol-0909");
  assert.equal(resolve(config.sourceRoot), sourceRoot);
  assert.equal(resolve(config.runtimeRoot), dirname(expectedInstancePath));
  assert.equal(config.apiHost, "127.0.0.1");
  assert.equal(config.apiPort, 4519);
  assert.equal(config.mcpPort, 4521);
  assert.ok(relative(config.runtimeRoot, config.dataRoot).startsWith("data"));
  assert.equal(initial.status, "failed_retained");
  assert.match(initial.failure, /capture enrichment[\s\S]*partial[\s\S]*complete/u);
  assert.equal(relative(evidenceRoot, resolve(initialFile)), join(initial.runId, "proof.json"));
  assert.equal(resume.status, "failed_retained");
  assert.equal(resume.instanceId, config.instanceId);
  assert.equal(resume.projectId, initial.projectId);
  assert.equal(resume.resumedFromRunId, initial.runId);
  assert.equal(resume.resumedFromProofSha256, sha256(readFileSync(initialFile)));
  assert.match(resume.failure, /failed Bug state[\s\S]*ready[\s\S]*in_progress/u);
  assert.equal(
    relative(dirname(resolve(initialFile)), resolve(resumeFile)),
    `resume-${resume.resumeId}.proof.json`,
  );
}

async function finalize(configFile, initialFile, resumeFile) {
  const configBytes = readFileSync(configFile);
  const config = JSON.parse(configBytes);
  const initialBytes = readFileSync(initialFile);
  const initial = JSON.parse(initialBytes);
  const resumeBytes = readFileSync(resumeFile);
  const resume = JSON.parse(resumeBytes);
  validateInputs(configFile, config, initialFile, initial, resumeFile, resume);

  const finalizeId = randomUUID();
  const output = dirname(resolve(initialFile));
  const projectId = initial.projectId;
  const secrets = new Set();
  const loginRequest = requestByLabel(initial, "project name login");
  const employeeName = loginRequest.request.params.arguments.name;
  const employeeId = structured(loginRequest).userId;

  const directFail = requestByLabel(initial, "direct HTTP vendor fail");
  const directAttemptId = directFail.path.match(
    /^\/api\/v1\/repair-attempts\/([0-9a-f-]{36})\/fail$/u,
  )?.[1];
  assert.ok(directAttemptId);
  const supersedeRequest = requestByLabel(
    initial,
    "GM atomically supersedes through actual server MCP",
  );
  const supersedeArguments = supersedeRequest.request.params.arguments;
  const successorId = supersedeArguments.successor.id;
  const passedRequest = requestByLabel(initial, "record captured passed result");
  const passedArguments = passedRequest.request.params.arguments;
  const passedResponse = structured(passedRequest);
  const captureId = passedArguments.request.captureBundleId;
  const attachmentIds = passedArguments.request.attachmentIds;

  const blockedRequest = requestByLabel(resume, "record resumed blocked result");
  const blockedArguments = blockedRequest.request.params.arguments;
  const blockedResponse = structured(blockedRequest);
  const failedRequest = requestByLabel(resume, "record resumed failed result");
  const failedArguments = failedRequest.request.params.arguments;
  const failedResponse = structured(failedRequest);

  const proof = {
    schemaVersion: 1,
    status: "running",
    finalizeId,
    resumedFromRunId: initial.runId,
    resumedFromResumeId: resume.resumeId,
    initialProofSha256: sha256(initialBytes),
    resumeProofSha256: sha256(resumeBytes),
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
      resumedAtExactSecondFailedStage: true,
      priorProjectAndRecordsReused: true,
      noPriorBugOrUploadRecreated: true,
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

  async function httpGet(label, path, accessToken) {
    const entry = {
      transport: "direct_http",
      label,
      method: "GET",
      path,
      startedAt: new Date().toISOString(),
    };
    proof.requests.push(entry);
    try {
      const response = await fetch(`http://127.0.0.1:${config.apiPort}${path}`, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: "application/vnd.relay-qa-hub.v1.1+json",
          authorization: `Bearer ${accessToken}`,
          "x-qa-project-id": projectId,
        },
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      const body = JSON.parse(bytes.toString("utf8"));
      rememberSecrets(body, secrets);
      Object.assign(entry, {
        httpStatus: response.status,
        responseMedia: response.headers.get("content-type"),
        responseSizeBytes: bytes.length,
        responseSha256: sha256(bytes),
        response: redactSchema19Evidence(body, secrets),
      });
      assert.ok(response.ok, `${label}: ${response.status} ${safeJson(body)}`);
      return body;
    } finally {
      entry.finishedAt = new Date().toISOString();
    }
  }

  try {
    const hostBefore = processIdentities([config.apiPort, config.mcpPort]);
    proof.hostBefore = hostBefore;
    check(
      "same processes survived both retained assertion failures",
      hostBefore,
      initial.hostBefore,
    );
    const apiHealth = await fetch(`http://127.0.0.1:${config.apiPort}/api/v1/health/ready`, {
      signal: AbortSignal.timeout(10_000),
    }).then((response) => response.json());
    const mcpHealth = await fetch(`http://127.0.0.1:${config.mcpPort}/health`, {
      signal: AbortSignal.timeout(10_000),
    }).then((response) => response.json());
    proof.healthBefore = { api: apiHealth, serverMcp: mcpHealth };
    check("finalize API ready", apiHealth.status, "ready");
    check("finalize API schema", String(apiHealth.schemaVersion), "19");
    check("finalize MCP ready", mcpHealth.status, "ready");
    check("finalize MCP schema", String(mcpHealth.schemaVersion), "19");
    await mcpRpc("finalize server MCP initialization", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "schema19-main-live-finalize", version: "1" },
    });
    const employee = await tool(
      "finalize same employee login",
      "qa_login",
      { projectId, name: employeeName },
      undefined,
    );
    check("finalize keeps employee identity", employee.userId, employeeId);

    check("committed failed result correctly released Bug", failedResponse.bug.state, "ready");
    check(
      "committed failed result marked attempt verification_failed",
      failedResponse.repairAttempt.status,
      "verification_failed",
    );
    const failedReplay = await tool(
      "resume exact failed result replay",
      "qa_record_verification_result",
      failedArguments,
      employee.accessToken,
    );
    check("failed result replay marker", failedReplay.replayed, true);
    check("failed result replay event", failedReplay.eventId, failedResponse.eventId);
    check("failed replay retains ready Bug", failedReplay.bug.state, "ready");
    check(
      "failed replay retains attempt state",
      failedReplay.repairAttempt.status,
      "verification_failed",
    );

    for (const [label, args, expectedStatus] of [
      ["passed", passedArguments, "passed"],
      ["blocked", blockedArguments, "blocked"],
      ["failed", failedArguments, "failed"],
    ]) {
      const verification = await tool(
        `final ${label} verification readback`,
        "qa_get_verification",
        { projectId, verificationId: args.verificationId },
        employee.accessToken,
      );
      check(`final ${label} verification status`, verification.status, expectedStatus);
    }
    const failedBug = await httpGet(
      "direct HTTP reads released failed-verification Bug",
      `/api/v1/bugs/${failedResponse.bug.id}`,
      employee.accessToken,
    );
    check("direct HTTP failed-verification Bug state", failedBug.state, "ready");
    const blockedBug = await httpGet(
      "direct HTTP reads blocked-verification Bug",
      `/api/v1/bugs/${blockedResponse.bug.id}`,
      employee.accessToken,
    );
    check("direct HTTP blocked-verification Bug state", blockedBug.state, "ready_for_verification");

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
        "three terminal snapshots despite exact replays",
        readback
          .prepare(
            "SELECT count(*) AS count FROM repair_attempt_terminal_snapshots WHERE attempt_id IN (?,?,?)",
          )
          .get(directAttemptId, supersedeArguments.attemptId, successorId).count,
        3,
      );
      check(
        "original superseded attempt retained",
        readback
          .prepare("SELECT status FROM repair_attempts WHERE id=?")
          .get(supersedeArguments.attemptId).status,
        "superseded",
      );
      const successor = readback
        .prepare("SELECT status,mode,parent_attempt_id FROM repair_attempts WHERE id=?")
        .get(successorId);
      check("external successor raw status", successor.status, "failed");
      check("external successor raw mode", successor.mode, "external");
      check(
        "external successor raw parent",
        successor.parent_attempt_id,
        supersedeArguments.attemptId,
      );
      check(
        "three Verification result snapshots despite exact replays",
        readback
          .prepare(
            "SELECT count(*) AS count FROM verification_result_snapshots WHERE verification_id IN (?,?,?)",
          )
          .get(
            passedArguments.verificationId,
            blockedArguments.verificationId,
            failedArguments.verificationId,
          ).count,
        3,
      );
      check(
        "raw Verification status matrix",
        readback
          .prepare("SELECT id,status FROM verifications WHERE id IN (?,?,?) ORDER BY status")
          .all(
            passedArguments.verificationId,
            blockedArguments.verificationId,
            failedArguments.verificationId,
          )
          .map(({ id, status }) => ({ id, status })),
        [
          { id: blockedArguments.verificationId, status: "blocked" },
          { id: failedArguments.verificationId, status: "failed" },
          { id: passedArguments.verificationId, status: "passed" },
        ],
      );
      check(
        "raw Bug state matrix",
        readback
          .prepare("SELECT id,state FROM bugs WHERE id IN (?,?,?) ORDER BY state")
          .all(passedResponse.bug.id, blockedResponse.bug.id, failedResponse.bug.id)
          .map(({ id, state }) => ({ id, state })),
        [
          { id: passedResponse.bug.id, state: "closed" },
          { id: failedResponse.bug.id, state: "ready" },
          { id: blockedResponse.bug.id, state: "ready_for_verification" },
        ],
      );
      check(
        "two exact passed-result attachments",
        readback
          .prepare(
            "SELECT attachment_id FROM verification_attachments WHERE verification_id=? ORDER BY attachment_id",
          )
          .all(passedArguments.verificationId)
          .map(({ attachment_id: id }) => id),
        [...attachmentIds].sort(),
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
      directAttemptId,
      supersededAttemptId: supersedeArguments.attemptId,
      successorId,
      passed: {
        bugId: passedResponse.bug.id,
        attemptId: passedResponse.repairAttempt.id,
        verificationId: passedArguments.verificationId,
        captureId,
        attachmentIds,
      },
      blocked: {
        bugId: blockedResponse.bug.id,
        attemptId: blockedResponse.repairAttempt.id,
        verificationId: blockedArguments.verificationId,
      },
      failed: {
        bugId: failedResponse.bug.id,
        attemptId: failedResponse.repairAttempt.id,
        verificationId: failedArguments.verificationId,
      },
    };
    const hostAfter = processIdentities([config.apiPort, config.mcpPort]);
    proof.hostAfter = hostAfter;
    check("process identities unchanged through exact-stage finalization", hostAfter, hostBefore);
    const healthAfter = await fetch(`http://127.0.0.1:${config.mcpPort}/health`, {
      signal: AbortSignal.timeout(10_000),
    }).then((response) => response.json());
    proof.healthAfter = healthAfter;
    check("server MCP remains ready", healthAfter.status, "ready");
    check("server MCP remains schema 19", String(healthAfter.schemaVersion), "19");
    proof.status = "passed_finalized_schema19_actual_main_http_and_server_mcp";
  } catch (error) {
    proof.status = "failed_retained";
    proof.failure = String(error?.stack ?? error);
    process.exitCode = 1;
  } finally {
    proof.finishedAt = new Date().toISOString();
    const prefix = `finalize-${finalizeId}`;
    writeFileSync(join(output, `${prefix}.runner.mjs.txt`), readFileSync(sourcePath), {
      flag: "wx",
    });
    writeFileSync(join(output, `${prefix}.proof.json`), safeJson(proof), { flag: "wx" });
    console.log(
      JSON.stringify({
        status: proof.status,
        resumedFromRunId: initial.runId,
        resumedFromResumeId: resume.resumeId,
        finalizeId,
        checks: proof.checks.length,
        requests: proof.requests.length,
        proof: join(output, `${prefix}.proof.json`),
      }),
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === sourcePath) {
  if (process.argv[2] === "--finalize") {
    assert.equal(process.argv.length, 6);
    await finalize(process.argv[3], process.argv[4], process.argv[5]);
  } else {
    console.log(
      JSON.stringify({
        status: "not_run",
        command:
          "node scripts/project-components/schema19-main-live-finalize.mjs --finalize <instance.json> <initial-proof.json> <resume-proof.json>",
      }),
    );
  }
}
