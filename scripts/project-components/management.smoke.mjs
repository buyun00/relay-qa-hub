import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";
import { exerciseGmBusinessLoop } from "./gm-business-loop.mjs";

const config = readParallelInstanceConfig(process.argv[2]);
const api = `http://${config.apiHost}:${config.apiPort}`;
const secrets = JSON.parse(readFileSync(config.secretsFile, "utf8"));
const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const checks = [],
  outbound = [];
const witness = createServer((request, response) => {
  outbound.push({
    method: request.method,
    path: new URL(request.url, "http://localhost").pathname,
    at: new Date().toISOString(),
  });
  response.writeHead(503, { "content-type": "application/json" });
  response.end('{"code":"MANAGEMENT_TEST_NO_EXECUTION"}');
});
await new Promise((resolve) => witness.listen(0, "127.0.0.1", resolve));
const target = `http://127.0.0.1:${witness.address().port}`;
const scrub = (value) =>
  Array.isArray(value)
    ? value.map(scrub)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !/token|password|secret|cookie|authorization/iu.test(key))
            .map(([key, item]) => [key, scrub(item)]),
        )
      : value;
function verify(label, condition, detail) {
  checks.push({
    label,
    kind: "assertion",
    passed: Boolean(condition),
    detail: scrub(detail),
    at: new Date().toISOString(),
  });
}
async function call(label, method, path, { token, body, projectId, expected = 200, key } = {}) {
  const response = await fetch(api + path, {
    method,
    headers: {
      accept: "application/vnd.relay-qa-hub.v1.1+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(projectId ? { "x-qa-project-id": projectId } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.json().catch(() => ({ code: "NON_JSON_RESPONSE" }));
  checks.push({
    label,
    kind: "http",
    method,
    path,
    projectId,
    expectedStatus: expected,
    status: response.status,
    passed: response.status === expected,
    response: scrub(value),
    at: new Date().toISOString(),
  });
  return value;
}
const names = Object.fromEntries(
  ["operator", "both", "alias"].map((key) => [key, `管理验收-${key}-${runId}`]),
);
let a, b;
try {
  await call("independent API readiness", "GET", "/api/v1/health/ready");
  await call("incorrect GM password rejected", "POST", "/api/v1/auth/gm/login", {
    body: { password: randomUUID(), client: "android" },
    expected: 401,
  });
  const gm = await call("configured GM password login", "POST", "/api/v1/auth/gm/login", {
    body: { password: secrets.gmPassword, client: "android" },
  });
  if (!gm.accessToken || !gm.isGm) throw new Error("Configured GM login did not succeed");
  a = await call("GM create isolated project A", "POST", "/api/v1/gm/projects", {
    token: gm.accessToken,
    body: { id: randomUUID(), key: `MA${Date.now()}`, name: `管理验收A ${runId}` },
  });
  b = await call("GM create isolated project B", "POST", "/api/v1/gm/projects", {
    token: gm.accessToken,
    body: { id: randomUUID(), key: `MB${Date.now()}`, name: `管理验收B ${runId}` },
  });
  if (!a.id || !b.id) throw new Error("Isolated test project creation failed");
  const entry = await call(
    "project shortcode resolves stable ID",
    "GET",
    `/api/v1/project-entry/${a.key}`,
  );
  verify("shortcode returns project A", entry.id === a.id, { expected: a.id, actual: entry.id });
  const login = (label, name, projectId, expected = 200) =>
    call(label, "POST", "/api/v1/auth/login", {
      body: { name, projectId, client: "android" },
      expected,
    });
  const operator = await login("ordinary operator joins A", names.operator, a.id);
  const bothA = await login("shared employee joins A", names.both, a.id);
  const bothB = await login("shared employee joins B", names.both, b.id);
  const aliasA = await login("alias joins A", names.alias, a.id);
  const aliasB = await login("alias joins B", names.alias, b.id);
  verify(
    "same name keeps stable user across projects",
    bothA.userId === bothB.userId && aliasA.userId === aliasB.userId,
    { shared: bothA.userId, alias: aliasA.userId },
  );
  const namedGm = await login("ordinary name gm logs in without privilege", "gm", a.id);
  verify("name gm cannot grant GM", namedGm.isGm === false, {
    userId: namedGm.userId,
    isGm: namedGm.isGm,
  });
  await call("ordinary gm name denied project management", "GET", "/api/v1/gm/projects", {
    token: namedGm.accessToken,
    expected: 403,
  });
  const visible = await call("single-project employee directory", "GET", "/api/v1/projects", {
    token: operator.accessToken,
  });
  verify(
    "only effective membership visible",
    visible.items?.length === 1 && visible.items[0].id === a.id,
    visible,
  );
  await call("non-member project Bug list denied", "GET", `/api/v1/bugs?projectId=${b.id}`, {
    token: operator.accessToken,
    projectId: b.id,
    expected: 403,
  });
  await call("non-member personnel directory denied", "GET", `/api/v1/projects/${b.id}/users`, {
    token: operator.accessToken,
    expected: 403,
  });
  const initial = await call(
    "new project has five disabled components",
    "GET",
    `/api/v1/projects/${a.id}/components`,
    { token: gm.accessToken },
  );
  verify(
    "Bug-only default",
    initial.items?.length === 5 && initial.items.every((item) => !item.enabled),
    initial,
  );
  const component = async (key, enabled, settings, expectedVersion, expected = 200) =>
    call(
      `GM ${enabled ? "enable" : "disable"} ${key}`,
      "PUT",
      `/api/v1/projects/${a.id}/components/${key}`,
      { token: gm.accessToken, body: { enabled, config: settings, expectedVersion }, expected },
    );
  await call(
    "employee cannot configure components",
    "PUT",
    `/api/v1/projects/${a.id}/components/build`,
    {
      token: operator.accessToken,
      body: { enabled: true, config: {}, expectedVersion: 0 },
      expected: 403,
    },
  );
  await component("build_upload.single", true, { buildPreset: "fixture" }, 0, 409);
  await component("build", true, {}, 0);
  const incomplete = await call(
    "missing configuration remains visible",
    "GET",
    `/api/v1/projects/${a.id}/components`,
    { token: operator.accessToken },
  );
  verify(
    "enabled build without target needs configuration",
    incomplete.items.find((item) => item.key === "build")?.status === "needs_configuration",
    incomplete,
  );
  const buildConfig = {
    baseUrl: target,
    job: "management-only",
    downloadOrigin: target,
    zipPath: "/preview.zip",
    artifactUrlTemplate: `${target}/artifacts/{buildNumber}.zip`,
    credentialRef: "fixture-credential-not-a-secret",
    presets: { fixture: { preview: "true" } },
  };
  const uploadConfig = {
    sourceUrl: `${target}/preview.zip`,
    apiBase: target,
    loginBase: target,
    defaults: { productId: "999", channelId: "998", belongName: "Management test", testerId: 73 },
    credentialRef: "fixture-credential-not-a-secret",
    targetPrefix: `isolated/${a.id}/`,
    testDirectoryPrefix: `isolated/${a.id}/test/`,
    releaseDirectoryPrefix: `isolated/${a.id}/release/`,
  };
  await component("build", true, buildConfig, 1);
  await component("upload.incremental", true, uploadConfig, 0);
  await component("build_upload.single", true, { buildPreset: "fixture" }, 0);
  const publicComponents = await call(
    "employee receives public configuration only",
    "GET",
    `/api/v1/projects/${a.id}/components`,
    { token: operator.accessToken },
  );
  verify(
    "employee configuration hides targets and credential references",
    !JSON.stringify(publicComponents).includes(target) &&
      !JSON.stringify(publicComponents).includes("fixture-credential-not-a-secret") &&
      !JSON.stringify(publicComponents).includes('"preview":"true"'),
    publicComponents,
  );
  const gmComponents = await call(
    "GM can edit existing private connection configuration",
    "GET",
    `/api/v1/projects/${a.id}/components`,
    { token: gm.accessToken },
  );
  verify(
    "GM receives named target and presets",
    gmComponents.items.find((item) => item.key === "build")?.config?.baseUrl === target,
    { build: gmComponents.items.find((item) => item.key === "build") },
  );
  const untouchedB = await call(
    "project B component configuration remains off",
    "GET",
    `/api/v1/projects/${b.id}/components`,
    { token: bothB.accessToken },
  );
  verify(
    "component switch is project-scoped",
    untouchedB.items.every((item) => !item.enabled),
    untouchedB,
  );
  await component("build", false, buildConfig, 2);
  const dependent = await call(
    "dependency disable closes combined entry",
    "GET",
    `/api/v1/projects/${a.id}/components`,
    { token: operator.accessToken },
  );
  verify(
    "combined component is disabled with build dependency",
    dependent.items.find((item) => item.key === "build_upload.single")?.enabled === false,
    dependent,
  );
  await component("upload.incremental", false, uploadConfig, 1);
  await component("build", true, {}, 1, 409);
  verify("management operations do not contact configured targets", outbound.length === 0, {
    outbound,
  });
  const users = (token) =>
    call("read current project A personnel", "GET", `/api/v1/projects/${a.id}/users`, { token });
  const membership = (
    label,
    userId,
    active,
    expectedVersion,
    token = operator.accessToken,
    expected = 200,
    gmOnly = false,
  ) =>
    call(
      label,
      gmOnly ? "PUT" : "PATCH",
      `/api/v1/${gmOnly ? "gm/" : ""}projects/${a.id}/members/${userId}`,
      { token, body: { active, expectedVersion }, expected },
    );
  const before = await users(operator.accessToken);
  await membership(
    "employee disables shared employee only in A",
    bothA.userId,
    false,
    before.items.find((item) => item.userId === bothA.userId).membershipVersion,
  );
  await login("same-name login cannot restore revoked A membership", names.both, a.id, 403);
  const stillB = await login("same-name employee still enters B", names.both, b.id);
  verify("B identity survives A disable", stillB.userId === bothA.userId, {
    userId: stillB.userId,
  });
  await call("old shared session cannot read revoked A", "GET", `/api/v1/bugs?projectId=${a.id}`, {
    token: bothB.accessToken,
    expected: 403,
  });
  await call("old shared session can still read B", "GET", `/api/v1/bugs?projectId=${b.id}`, {
    token: bothA.accessToken,
  });
  await membership(
    "stale member restoration is refused",
    bothA.userId,
    true,
    1,
    operator.accessToken,
    409,
  );
  const revoked = await users(operator.accessToken);
  await membership(
    "employee restores A membership with current version",
    bothA.userId,
    true,
    revoked.items.find((item) => item.userId === bothA.userId).membershipVersion,
  );
  const restored = await login("restored employee can enter A with original ID", names.both, a.id);
  verify("restoration preserves stable user", restored.userId === bothA.userId, {
    userId: restored.userId,
  });
  await call(
    "employee links duplicate name only in A",
    "POST",
    `/api/v1/projects/${a.id}/users/${aliasA.userId}/identity-link`,
    { token: operator.accessToken, body: { canonicalUserId: bothA.userId } },
  );
  const linkedA = await login("A linked name resolves canonical user", names.alias, a.id);
  const separateB = await login("B same alias remains independent", names.alias, b.id);
  verify(
    "identity links do not cross projects",
    linkedA.userId === bothA.userId && separateB.userId === aliasB.userId,
    { canonical: bothA.userId, linked: linkedA.userId, bAlias: separateB.userId },
  );
  await call(
    "employee unlinks duplicate name in A",
    "DELETE",
    `/api/v1/projects/${a.id}/users/${aliasA.userId}/identity-link`,
    { token: operator.accessToken },
  );
  const unlinked = await login("unlinked name returns original user", names.alias, a.id);
  verify("unlink preserves original identity", unlinked.userId === aliasA.userId, {
    userId: unlinked.userId,
  });
  const gmMember = (await users(gm.accessToken)).items.find((item) => item.userId === gm.userId);
  await membership(
    "GM removes own ordinary A membership for non-member test",
    gm.userId,
    false,
    gmMember.membershipVersion,
    gm.accessToken,
    200,
    true,
  );
  await call(
    "GM without A membership still reads components",
    "GET",
    `/api/v1/projects/${a.id}/components`,
    { token: gm.accessToken },
  );
  await call(
    "GM without A membership still lists personnel",
    "GET",
    `/api/v1/projects/${a.id}/users`,
    { token: gm.accessToken },
  );
  await call(
    "GM without A membership still reads Bug list",
    "GET",
    `/api/v1/bugs?projectId=${a.id}`,
    { token: gm.accessToken, projectId: a.id },
  );
  const gmBug = await exerciseGmBusinessLoop(call, {
    token: gm.accessToken,
    projectId: a.id,
    userId: gm.userId,
  });
  verify("GM non-member complete manual loop closes", gmBug.state === "closed", gmBug);
  const afterGmLoop = (await users(gm.accessToken)).items.find((item) => item.userId === gm.userId);
  verify(
    "GM business loop never restores membership",
    afterGmLoop.membershipStatus === "revoked" &&
      afterGmLoop.membershipVersion === gmMember.membershipVersion + 1,
    afterGmLoop,
  );
  await call("GM without A membership can rename project", "PATCH", `/api/v1/gm/projects/${a.id}`, {
    token: gm.accessToken,
    body: { expectedVersion: 1, name: `管理验收A 已改名 ${runId}` },
  });
  await call("stale project update rejected", "PATCH", `/api/v1/gm/projects/${a.id}`, {
    token: gm.accessToken,
    body: { expectedVersion: 1, name: "stale" },
    expected: 409,
  });
  await membership(
    "GM restores own ordinary membership after proof",
    gm.userId,
    true,
    gmMember.membershipVersion + 1,
    gm.accessToken,
    200,
    true,
  );
  await call("GM disables project with version", "PATCH", `/api/v1/gm/projects/${a.id}`, {
    token: gm.accessToken,
    body: { expectedVersion: 2, active: false },
  });
  await call("disabled project entrance is unavailable", "GET", `/api/v1/project-entry/${a.id}`, {
    expected: 403,
  });
  await call(
    "disabled A no longer serves employee Bug list",
    "GET",
    `/api/v1/bugs?projectId=${a.id}`,
    { token: operator.accessToken, expected: 403 },
  );
  await call("other project remains available", "GET", `/api/v1/bugs?projectId=${b.id}`, {
    token: bothB.accessToken,
  });
  await call("GM restores project with version", "PATCH", `/api/v1/gm/projects/${a.id}`, {
    token: gm.accessToken,
    body: { expectedVersion: 3, active: true },
  });
  const audit = await call(
    "management events readable with stable actor attribution",
    "GET",
    `/api/v1/projects/${a.id}/management-events`,
    { token: gm.accessToken },
  );
  verify(
    "management events are recorded",
    Array.isArray(audit.items) ? audit.items.length > 0 : Array.isArray(audit) && audit.length > 0,
    audit,
  );
  verify("no execution was dispatched by all configuration changes", outbound.length === 0, {
    outbound,
  });
} catch (error) {
  checks.push({
    label: "unexpected script interruption",
    passed: false,
    error: String(error?.message ?? error),
  });
} finally {
  await new Promise((resolve) => witness.close(resolve));
  const dir = join(config.sourceRoot, "docs/evidence/project-components/runs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `management-${runId}.json`);
  const failed = checks.filter((check) => !check.passed);
  writeFileSync(
    path,
    JSON.stringify(
      {
        runId,
        instanceId: config.instanceId,
        api,
        projects: { a, b },
        names,
        passed: failed.length === 0,
        note: "Real isolated HTTP management/membership subset. No task execution or live external service used. GM password and access tokens stayed in process memory and are omitted from evidence.",
        outbound,
        checks,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      passed: failed.length === 0,
      checkCount: checks.length,
      failed: failed.map(({ label, status, expectedStatus }) => ({
        label,
        status,
        expectedStatus,
      })),
      evidence: path,
    }),
  );
  if (failed.length) process.exitCode = 1;
}
