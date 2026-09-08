import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import assert from "node:assert/strict";
import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";

const config = readParallelInstanceConfig(process.argv[2]);
const api = `http://${config.apiHost}:${config.apiPort}`;
const secrets = JSON.parse(readFileSync(config.secretsFile, "utf8"));
const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const checks = [];
let passed = false;
const clean = (value) => {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/token|password|secret/iu.test(key))
      .map(([key, item]) => [key, clean(item)]),
  );
};
async function call(label, method, path, { token, body, status = 200, projectId, key } = {}) {
  const response = await fetch(api + path, {
    method,
    headers: {
      accept: "application/vnd.relay-qa-hub.v1.1+json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(projectId ? { "x-qa-project-id": projectId } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = { text };
  }
  checks.push({
    label,
    method,
    path,
    projectId,
    expectedStatus: status,
    status: response.status,
    response: clean(result),
    recordedAt: new Date().toISOString(),
  });
  assert.equal(response.status, status, `${label}: ${JSON.stringify(clean(result))}`);
  return result;
}
try {
  const readiness = await call("new API ready", "GET", "/api/v1/health/ready");
  assert.equal(readiness.status, "ready", "database, evidence and worker must all be ready");
  const gm = await call("GM password login", "POST", "/api/v1/auth/gm/login", {
    body: { password: secrets.gmPassword, client: "android" },
  });
  assert.equal(gm.isGm, true);
  const projects = [];
  for (const suffix of ["A", "B"])
    projects.push(
      await call(`GM create ${suffix}`, "POST", "/api/v1/gm/projects", {
        token: gm.accessToken,
        body: {
          id: randomUUID(),
          key: `T${suffix}${Date.now()}`,
          name: `真实HTTP验收${suffix} ${runId}`,
        },
      }),
    );
  const [a, b] = projects;
  const aOnly = await call("A first name login", "POST", "/api/v1/auth/login", {
    body: { projectId: a.id, name: `仅甲${Date.now()}`, client: "android" },
  });
  assert.equal(aOnly.projectId, a.id);
  const visible = await call("A employee sees only A", "GET", "/api/v1/projects", {
    token: aOnly.accessToken,
  });
  assert.deepEqual(
    visible.items.map((item) => item.id),
    [a.id],
  );
  const components = await call(
    "all optional components disabled",
    "GET",
    `/api/v1/projects/${a.id}/components`,
    { token: aOnly.accessToken },
  );
  assert.equal(components.items.length, 5);
  assert.ok(components.items.every((item) => item.enabled === false));
  await call("unjoined project list refused", "GET", `/api/v1/bugs?projectId=${b.id}`, {
    token: aOnly.accessToken,
    status: 403,
  });
  const submission = randomUUID();
  const createBody = {
    submissionContractVersion: "1.1.0",
    projectId: a.id,
    clientSubmissionId: submission,
    title: "独立预览真实Bug创建",
    description: "本记录只存在新版测试库",
    expectedBehavior: "项目归属准确",
    severity: "S3",
    priority: "P3",
    occurrence: {
      observedAt: new Date().toISOString(),
      platform: "web",
      steps: ["真实HTTP提交"],
      actualBehavior: "验证创建与读回",
    },
  };
  const created = await call("create real Bug with components off", "POST", "/api/v1/bugs", {
    token: aOnly.accessToken,
    body: createBody,
    key: `submission:${submission}:commit`,
    status: 201,
  });
  const bug = created.bug;
  assert.equal(bug.projectId, a.id);
  const detail = await call("read back stable Bug", "GET", `/api/v1/bugs/${bug.id}`, {
    token: aOnly.accessToken,
  });
  assert.equal(detail.id, bug.id);
  await call("conflicting project header refused", "GET", `/api/v1/bugs/${bug.id}`, {
    token: aOnly.accessToken,
    projectId: b.id,
    status: 404,
  });
  const loginName = `双项目${Date.now()}`;
  const bothA = await call("shared user joins A", "POST", "/api/v1/auth/login", {
    body: { projectId: a.id, name: loginName, client: "android" },
  });
  const bothB = await call("shared user joins B", "POST", "/api/v1/auth/login", {
    body: { projectId: b.id, name: loginName, client: "android" },
  });
  assert.equal(bothA.userId, bothB.userId);
  const [aBugs, bBugs] = await Promise.all([
    call("concurrent A query", "GET", `/api/v1/bugs?projectId=${a.id}`, {
      token: bothB.accessToken,
    }),
    call("concurrent B query", "GET", `/api/v1/bugs?projectId=${b.id}`, {
      token: bothA.accessToken,
    }),
  ]);
  assert.equal(aBugs.items.length, 1);
  assert.equal(bBugs.items.length, 0);
  assert.equal(aBugs.items[0].id, bug.id);
  passed = true;
} finally {
  const evidenceRoot = join(config.sourceRoot, "docs/evidence/project-components/runs");
  mkdirSync(evidenceRoot, { recursive: true });
  const path = join(evidenceRoot, `http-core-${runId}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        runId,
        instanceId: config.instanceId,
        api,
        passed,
        note: "Real running API and isolated SQLite. This smoke is a subset, not full E2E acceptance.",
        checks,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(JSON.stringify({ passed, checkCount: checks.length, evidence: path }));
}
