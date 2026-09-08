import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";

const config = readParallelInstanceConfig(process.argv[2]);
const [projectId, otherProjectId] = process.argv.slice(3);
assert.ok(projectId && otherProjectId && projectId !== otherProjectId);
const origin = `http://${config.apiHost}:${config.apiPort}`;
const vendor = "application/vnd.relay-qa-hub.v1.1+json";
const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const checks = [];
const records = [];
let token;
let passed = false;
const contractRoot = join(config.sourceRoot, "packages/contracts");
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
for (const name of readdirSync(join(contractRoot, "schemas"))) {
  if (name.endsWith(".schema.json"))
    ajv.addSchema(JSON.parse(readFileSync(join(contractRoot, "schemas", name), "utf8")));
}
const appSchema = JSON.parse(
  readFileSync(join(contractRoot, "versions/1.1.0/schemas/app-first.schema.json"), "utf8"),
);
ajv.addSchema(appSchema);
function validate(value, definition, appFirst = false) {
  const prefix = appFirst ? appSchema.$id : "https://qa-hub.local/contracts/workflow.schema.json";
  const check = ajv.getSchema(`${prefix}#/$defs/${definition}`);
  assert.ok(check, definition);
  assert.equal(check(value), true, JSON.stringify(check.errors));
}
function clean(value, depth = 0) {
  if (depth > 64) return "[REDACTED_NESTING_LIMIT]";
  if (typeof value === "string") {
    try {
      return JSON.stringify(clean(JSON.parse(value), depth + 1));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/token|secret|password|cookie|authorization|private.?key|api.?key|credential/iu.test(
            key,
          ),
      )
      .map(([key, item]) => [key, clean(item, depth + 1)]),
  );
}
async function call(label, method, path, body, options = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      accept: options.accept ?? vendor,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(token ? { "x-qa-project-id": options.projectId ?? projectId } : {}),
      ...(options.key ? { "idempotency-key": options.key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.json();
  checks.push({
    label,
    method,
    path,
    accept: options.accept ?? vendor,
    projectId: options.projectId ?? projectId,
    status: response.status,
    contentType: response.headers.get("content-type"),
    response: clean(value),
    recordedAt: new Date().toISOString(),
  });
  assert.equal(response.status, options.status ?? 200, `${label}: ${JSON.stringify(clean(value))}`);
  if (options.accept && response.ok)
    assert.ok(response.headers.get("content-type")?.startsWith(options.accept), label);
  return value;
}
function requestKey(path, body) {
  if (path === "/api/v1/bugs") return `submission:${body.clientSubmissionId}:commit`;
  const bugRoute = /^\/api\/v1\/bugs\/([^/]+)\/(transitions|repair-attempts|verifications)$/u.exec(
    path,
  );
  if (bugRoute) {
    const [, id, action] = bugRoute;
    if (action === "transitions")
      return `workflow:transitionBug:bug:${id}:v${body.expectedVersion}:ready`;
    if (action === "repair-attempts")
      return `workflow:createRepairAttempt:bug:${id}:v${body.expectedVersion}`;
    return `workflow:createVerification:bug:${id}:attempt:${body.repairAttemptId}:v${body.expectedVersion}`;
  }
  const attemptRoute = /^\/api\/v1\/repair-attempts\/([^/]+)\/(start|deliver)$/u.exec(path);
  if (attemptRoute)
    return `workflow:${attemptRoute[2] === "start" ? "start" : "deliver"}RepairAttempt:attempt:${attemptRoute[1]}:v${body.expectedVersion}`;
  const verificationRoute = /^\/api\/v1\/verifications\/([^/]+)\/(start|result)$/u.exec(path);
  if (verificationRoute)
    return `workflow:${verificationRoute[2] === "start" ? "startVerification" : "recordVerificationResult"}:verification:${verificationRoute[1]}:v${body.expectedVersion}`;
  return undefined;
}
const post = (label, path, body, options = {}) =>
  call(label, "POST", path, body, { key: requestKey(path, body), ...options });
try {
  const ready = await call("ready", "GET", "/api/v1/health/ready");
  assert.equal(ready.status, "ready");
  assert.equal(String(ready.schemaVersion), "14");
  const login = await post("separate test employee login", "/api/v1/auth/login", {
    projectId,
    name: `契约实测${runId}`,
    client: "android",
  });
  token = login.accessToken;
  assert.ok(token);
  assert.equal(login.projectId, projectId);
  const components = await call(
    "components remain off",
    "GET",
    `/api/v1/projects/${projectId}/components`,
  );
  assert.equal(components.items.length, 5);
  assert.ok(components.items.every((item) => !item.enabled));
  for (const accept of [vendor, "application/json"]) {
    const label = accept === vendor ? "vendor" : "legacy-response";
    const requestId = randomUUID();
    const created = await post(
      `${label} create Bug`,
      "/api/v1/bugs",
      {
        submissionContractVersion: "1.1.0",
        clientSubmissionId: requestId,
        projectId,
        title: `${label} 实际响应合同验收 ${runId}`,
        description: "独立预览中的人工流程测试，不涉及代码交付或外部任务。",
        expectedBehavior: "冻结响应符合原定义，丰富历史保留可读",
        severity: "S3",
        priority: "P3",
        occurrence: {
          observedAt: new Date().toISOString(),
          platform: "web",
          steps: ["真实 HTTP 人工流程"],
          actualBehavior: "核对响应与持久状态",
        },
      },
      { status: 201 },
    );
    let bug = await post(`${label} ready`, `/api/v1/bugs/${created.bug.id}/transitions`, {
      expectedVersion: created.bug.version,
      toState: "ready",
    });
    let attempt = await post(
      `${label} create repair`,
      `/api/v1/bugs/${bug.id}/repair-attempts`,
      {
        expectedVersion: bug.version,
        mode: "human",
        assigneeId: login.userId,
        summary: label,
      },
      { accept, status: 201 },
    );
    validate(attempt, "repairAttempt");
    attempt = await post(
      `${label} start repair`,
      `/api/v1/repair-attempts/${attempt.id}/start`,
      {
        expectedVersion: attempt.version,
        reason: "人工测试流程开始",
      },
      { accept },
    );
    validate(attempt, "repairAttempt");
    const reason = `${label} 测试无需代码交付，保留此原因供详情读取`;
    attempt = await post(
      `${label} no-code delivery`,
      `/api/v1/repair-attempts/${attempt.id}/deliver`,
      {
        expectedVersion: attempt.version,
        summary: "人工测试提交验收",
        deliveryKind: "no_code",
        noCodeReason: reason,
      },
      { accept },
    );
    validate(attempt, "repairAttempt");
    const rich = await call(`${label} rich repair`, "GET", `/api/v1/repair-attempts/${attempt.id}`);
    assert.equal(rich.noCodeReason, reason);
    bug = await call(`${label} delivery state`, "GET", `/api/v1/bugs/${bug.id}`);
    assert.equal(bug.state, "ready_for_verification");
    let verification = await post(
      `${label} create verification`,
      `/api/v1/bugs/${bug.id}/verifications`,
      {
        expectedVersion: bug.version,
        repairAttemptId: attempt.id,
        buildId: null,
        verifierId: login.userId,
        criteria: "人工核对响应和历史",
      },
      { accept, status: 201 },
    );
    validate(verification, "verification");
    verification = await post(
      `${label} start verification`,
      `/api/v1/verifications/${verification.id}/start`,
      {
        expectedVersion: verification.version,
        reason: "实际人工验收测试",
      },
      { accept },
    );
    validate(verification, "verification");
    const status = accept === vendor ? "failed" : "passed";
    const resultBody = {
      submissionContractVersion: "1.1.0",
      clientSubmissionId: randomUUID(),
      expectedVersion: verification.version,
      status,
      resultSummary: `${label} 响应核对`,
      attachmentIds: [],
      ...(status === "failed" ? { failureReason: "测试验收退回原因必须仍可读取" } : {}),
    };
    const resultKey = `workflow:recordVerificationResult:verification:${verification.id}:v${verification.version}`;
    const result = await post(
      `${label} result`,
      `/api/v1/verifications/${verification.id}/result`,
      resultBody,
      { accept, key: resultKey },
    );
    validate(
      result,
      accept === vendor ? "recordVerificationResultResponse" : "verificationResultResponse",
      accept === vendor,
    );
    assert.equal(result.verification.status, status);
    const otherMedia = accept === vendor ? "application/json" : vendor;
    const replay = await post(
      `${label} same request other response media`,
      `/api/v1/verifications/${verification.id}/result`,
      resultBody,
      { accept: otherMedia, key: resultKey },
    );
    validate(
      replay,
      otherMedia === vendor ? "recordVerificationResultResponse" : "verificationResultResponse",
      otherMedia === vendor,
    );
    assert.equal(replay.verification.version, result.verification.version);
    assert.equal(replay.bug.version, result.bug.version);
    const historical = await call(
      `${label} historical repair readback`,
      "GET",
      `/api/v1/repair-attempts/${attempt.id}`,
    );
    assert.equal(historical.noCodeReason, reason);
    const verificationDetail = await call(
      `${label} verification detail`,
      "GET",
      `/api/v1/verifications/${verification.id}`,
    );
    if (status === "failed")
      assert.equal(verificationDetail.failureReason, resultBody.failureReason);
    await call(
      `${label} wrong project history refused`,
      "GET",
      `/api/v1/repair-attempts/${attempt.id}`,
      undefined,
      { projectId: otherProjectId, status: 404 },
    );
    records.push({
      bugId: bug.id,
      bugState: result.bug.state,
      bugVersion: result.bug.version,
      attemptId: attempt.id,
      verificationId: verification.id,
      verificationStatus: status,
    });
  }
  passed = true;
} finally {
  const output = join(
    config.sourceRoot,
    "docs/evidence/project-components/runs",
    `frozen-workflow-live-${runId}.json`,
  );
  mkdirSync(join(config.sourceRoot, "docs/evidence/project-components/runs"), { recursive: true });
  const files = [
    "apps/api/dist/app.js",
    "apps/api/dist/frozen-workflow-response.js",
    "packages/storage/dist/repair-attempt-detail-store.js",
  ];
  const sourceHashes = Object.fromEntries(
    files.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(join(config.sourceRoot, file)))
        .digest("hex"),
    ]),
  );
  writeFileSync(
    output,
    JSON.stringify(
      {
        runId,
        instanceId: config.instanceId,
        origin,
        passed,
        scope:
          "Real isolated API HTTP responses for the six registered frozen mutation routes, explicit legacy response selection, vendor nesting, replay and rich authorized history. Requests use 1.1; not full 1.0 request compatibility or external-task acceptance.",
        sourceHashes,
        records,
        checks,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(JSON.stringify({ passed, checkCount: checks.length, evidence: output }));
}
