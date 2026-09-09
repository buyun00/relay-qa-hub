import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Artifact-only review: no fetch, sockets, process inspection, profile reads or writes.
// git show below reads only a committed source blob; the only output is a new review JSON.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const record = (file) => {
  const bytes = fs.readFileSync(file);
  return { path: file, bytes: bytes.length, sha256: sha(bytes) };
};
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const proofFile = path.join(here, "proof.json");
const proof = read(proofFile);
const firstDir = path.resolve(here, "../09b01307-28c0-4d3a-a7d9-49bb4cb1c07c");
const first = read(path.join(firstDir, "proof.json"));
const checks = [];
function check(label, actual, expected) {
  let passed = true;
  try { assert.deepEqual(actual, expected); } catch { passed = false; }
  checks.push({ label, passed });
}
function contained(file, directory) {
  const relative = path.relative(directory, path.resolve(file));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
}
function normalizeJsonText(value) {
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed !== null && typeof parsed === 'object') return JSON.stringify(normalizeJsonText(parsed)); } catch { /* Plain text is preserved. */ }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJsonText);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeJsonText(entry)]));
  return value;
}
function body(entry) {
  if (entry.transport !== "local_copy_4470") return entry.response;
  const result = entry.response.result;
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
const local = proof.requests.filter((r) => r.transport === "local_copy_4470");
const auxiliary = proof.requests.filter((r) => r.transport === "explicit_gm_auxiliary_4419");
const byId = (id) => local.find((r) => r.request.id === id);
const [a, b] = proof.scope.projects;
const shared = proof.scope.sharedId;
const single = proof.singleId;
const data = (id) => body(byId(id));
const listIds = (id) => data(id).items.map((v) => v.id).sort();
const member = (id, userId = shared) => data(id).items.find((v) => v.userId === userId);
const fact = (v) => ({ userId: v.userId, membershipStatus: v.membershipStatus,
  membershipVersion: v.membershipVersion, roles: v.roles, identity: v.identity });
check("pinned successful proof", record(proofFile).sha256, "763e49a4d2cc8edeef42c1448c189641828686d6e221fd366d73a7c4d33a05a3");
check("pinned initial failed proof", record(path.join(firstDir, "proof.json")).sha256, "79819528189391818641f9727dea6e107373fbf6dbd269f2a5c43206e069d403");
check("actual successful status", proof.status, "passed_scoped_independent_copy_local_mcp_membership");
check("actual checks count", proof.checks.length, 99);
for (const [index, item] of proof.checks.entries()) {
  check(`actual check ${index + 1} flag`, item.passed, true);
  check(`actual check ${index + 1} values`, item.actual, item.expected);
}
check("39 recorded requests", proof.requests.length, 39);
check("36 local JSON-RPC requests", local.length, 36);
check("3 auxiliary HTTP requests", auxiliary.length, 3);
check("local sequential IDs", local.map((r) => r.request.id), Array.from({ length: 36 }, (_, i) => i + 1));
check("local method counts", local.reduce((m, r) => ({ ...m, [r.request.method]: (m[r.request.method] ?? 0) + 1 }), {}),
  { initialize: 1, "tools/list": 1, "tools/call": 34 });
const toolCounts = {};
for (const row of local) {
  check(`HTTP status ${row.request.id}`, row.httpStatus, 200);
  check(`JSON-RPC response ID ${row.request.id}`, row.response.id, row.request.id);
  if (row.request.method !== "tools/call") continue;
  const tool = row.request.params.name;
  toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
  const args = row.request.params.arguments;
  check(`local request ${row.request.id} has no credential override`, Object.keys(args).some((k) => /token|cookie|authorization/iu.test(k)), false);
  if (args.projectId) check(`local request ${row.request.id} new project`, [a, b].includes(args.projectId), true);
  if (tool === "qa_login") check(`local login ${row.request.id} fresh name`, proof.scope.names.includes(args.name), true);
}
check("only bounded tools", Object.keys(toolCounts).sort(), ["qa_create_project", "qa_get_components", "qa_list_bugs", "qa_list_management_events", "qa_list_projects", "qa_list_users", "qa_login", "qa_login_gm"].sort());
check("11 local login requests including refused login", (toolCounts.qa_login ?? 0) + (toolCounts.qa_login_gm ?? 0), 11);
check("2 new project writes", toolCounts.qa_create_project, 2);
check("auxiliary login route", { method: auxiliary[0].method, path: auxiliary[0].path, body: auxiliary[0].body },
  { method: "POST", path: "/api/v1/auth/gm/login", body: { client: "android" } });
for (const [index, active] of [false, true].entries()) {
  const row = auxiliary[index + 1];
  check(`auxiliary ${index + 1} exact A relationship`, { method: row.method, path: row.path, body: row.body },
    { method: "PATCH", path: `/api/v1/projects/${a}/members/${shared}`, body: { active, expectedVersion: index + 1 } });
  check(`auxiliary ${index + 1} returned CAS`, row.response,
    { projectId: a, userId: shared, active, version: index + 2 });
}
check("local catalog 90", proof.catalog.count, 90);
check("catalog actual response", byId(2).response.result.tools.map((v) => v.name), proof.catalog.names);
check("initialize protocol primitive preserved", byId(1).response.jsonrpc, "2.0");
check("initialize .9", byId(1).response.result.serverInfo.version, "0.2.0-preview.9");
for (const id of [8, 9, 32]) check(`single identity ${id}`, data(id).userId, single);
for (const id of [11, 13, 17, 20, 24]) check(`shared identity ${id}`, data(id).userId, shared);
check("different employee identities", single === shared, false);
for (const id of [10, 12, 33]) check(`directory only A ${id}`, listIds(id), [a]);
for (const id of [14, 25]) check(`directory A B ${id}`, listIds(id), [a, b].sort());
check("disabled A omitted from directory", listIds(21), [b]);
check("single never member of B", member(16, single), undefined);
for (const id of [15, 16]) check(`initial membership version ${id}`, member(id).membershipVersion, 1);
check("restored A membership 3", member(26).membershipVersion, 3);
check("restored A active", member(26).membershipStatus, "active");
check("B unchanged after disable", fact(member(23)), fact(member(16)));
check("B unchanged after restore", fact(member(27)), fact(member(16)));
for (const [id, code] of [[18, "PROJECT_NOT_ACCESSIBLE"], [19, "PROJECT_MEMBERSHIP_DISABLED"]]) {
  check(`denial ${id} is MCP error`, byId(id).response.result.isError, true);
  check(`denial ${id} precise code/status`, { code: data(id).code, status: data(id).status }, { code, status: 403 });
}
const revocationWindow = [byId(17), auxiliary[1], byId(18), byId(19), byId(20)];
for (let i = 1; i < revocationWindow.length; i++) check(`revocation order ${i}`,
  Date.parse(revocationWindow[i - 1].finishedAt) <= Date.parse(revocationWindow[i].at), true);
check("no intervening local login before old cookie denial", local.filter((r) => r.request.id > 17 && r.request.id < 18).length, 0);
for (const id of [5, 7, 28, 30]) {
  check(`five component records ${id}`, data(id).items.length, 5);
  check(`five all off ${id}`, data(id).items.every((v) => v.enabled === false && v.status === "disabled"), true);
}
for (const id of [22, 29, 31]) check(`empty Bug list ${id}`, data(id).items, []);
for (const [id, count] of [[35, 1], [36, 0]]) {
  for (const action of ["membership.disabled", "membership.activated"])
    check(`audit ${id} ${action}`, data(id).items.filter((v) => v.subjectId === shared && v.action === action).length, count);
}
const source = record(path.join(root, "scripts/project-components/local-mcp-membership-live.mjs"));
const test = record(path.join(root, "scripts/project-components/local-mcp-membership-live.test.mjs"));
check("runner current bytes equal executed", source.sha256, proof.sourceSha256);
check("test frozen SHA", test.sha256, "a1d9d64af7afed4050cccef2a9f3c9f109d472021a709539440cb35636870bc0");
for (const [p, dir] of [[proof, here], [first, firstDir]]) {
  check(`source archive public ${p.runId}`, record(path.join(dir, "runner.mjs.txt")).sha256, p.sourceSha256);
  check(`source archive private ${p.runId}`, record(path.join(p.experiment, "runner.mjs")).sha256, p.sourceSha256);
  check(`private proof ${p.runId}`, record(path.join(p.experiment, "proof.json")).sha256, record(path.join(dir, "proof.json")).sha256);
}
const rawRecords = [];
for (const [index, row] of proof.requests.entries()) {
  if (!row.rawPath) continue;
  contained(row.rawPath, path.join(proof.experiment, "raw"));
  check(`raw hash ${index + 1}`, record(row.rawPath).sha256, row.responseSha256);
  const raw = read(row.rawPath);
  // Catalog schemas are field-redacted, so its parsed object is intentionally different.
  // All other retained bodies contain no auth receipts and are compared directly.
  if (row.request?.id !== 2) check(`raw object ${index + 1}`, normalizeJsonText(raw), normalizeJsonText(row.response));
  rawRecords.push({ label: row.label, ...record(row.rawPath) });
}
check("27 non-auth raw bodies retained", rawRecords.length, 27);
check("raw directory exact inventory", fs.readdirSync(path.join(proof.experiment, "raw")).sort(), rawRecords.map((r) => path.basename(r.path)).sort());
check("12 auth responses deliberately have no raw body", proof.requests.filter((r) => !r.rawPath).length, 12);
const copiedFiles = [];
for (const input of proof.packageInputs) {
  const file = path.join(proof.experiment, "app", input.relative);
  contained(file, path.join(proof.experiment, "app"));
  const actual = record(file);
  check(`copied package ${input.relative}`, { bytes: actual.bytes, sha256: actual.sha256 }, { bytes: input.bytes, sha256: input.sha256 });
  copiedFiles.push(actual);
}
check("78 package files", copiedFiles.length, 78);
check("378180695 package bytes", copiedFiles.reduce((n, r) => n + r.bytes, 0), 378180695);
const privateMetadata = [];
for (const config of proof.copyConfigs) {
  contained(config.path, proof.experiment);
  privateMetadata.push(record(config.path));
  check(`copy config hash ${config.name}`, record(config.path).sha256, config.sha256);
  check(`profile inside experiment ${config.name}`, path.resolve(config.profile).startsWith(path.resolve(proof.experiment) + path.sep), true);
}
for (const file of ["quit-probe-stdout.txt", "quit-probe-stderr.txt", "membership-stdout.txt", "membership-stderr.txt"])
  privateMetadata.push(record(path.join(proof.experiment, file)));
for (const name of ["quit-probe", "membership"]) {
  const launch = proof.processes.find((v) => v.phase === `${name}_launch`);
  const ready = proof.processes.find((v) => v.phase === `${name}_isolated_and_quittable`);
  const quit = proof.processes.find((v) => v.phase === `${name}_normal_quit`);
  check(`normal quit PID ${name}`, quit.pid, launch.pid);
  check(`normal quit exit ${name}`, quit.exitCode, 0);
  check(`inspector PID ${name}`, ready.pid, launch.pid);
  check(`inspector profile ${name}`, ready.profile, launch.profile);
  check(`inspector own exe ${name}`, ready.exe, launch.executable);
  check(`ready before quit ${name}`, Date.parse(ready.at) < Date.parse(quit.at), true);
  check(`quit before four minute watchdog ${name}`, Date.parse(quit.at) - Date.parse(ready.at) < 240000, true);
}
check("quit probe exits before membership launch", Date.parse(proof.processes[2].at) < Date.parse(proof.processes[3].at), true);
check("protected files unchanged in actual before/after", proof.protectedAfter, proof.protectedBefore);
check("host identities unchanged in actual before/after", proof.hostAfter, proof.hostBefore);
check("own ports recorded released", proof.hostAfter.filter((v) => [4470, 4471].includes(v.port)).map((v) => v.listening), [false, false]);
check("no update artifacts", proof.updateArtifacts.map((v) => v.files), [[], []]);
check("nonce manifest genuinely 404", proof.unpublishedUpdateEndpoint.status, 404);
check("original MCP and UI untouched declaration", [proof.boundary.originalMcpCalled, proof.boundary.originalUiOperated, proof.boundary.liveProfileDraftFilesRead], [false, false, false]);
check("first run failed before requests", [first.status, first.requests.length, first.processes.length], ["failed_retained", 0, 0]);
const dependencyPath = "scripts/project-components/server-mcp-membership-live.mjs";
const dependency = record(path.join(root, dependencyPath));
const dependencyBlob = execFileSync("git", ["show", `HEAD:${dependencyPath}`], { cwd: root });
// Git's configured LF normalization can change byte hashes without changing source text.
check("unchanged committed helper normalized text", fs.readFileSync(dependency.path, "utf8").replaceAll("\r\n", "\n"), dependencyBlob.toString("utf8").replaceAll("\r\n", "\n"));
const frozen = [record(proofFile), record(path.join(here, "runner.mjs.txt")), record(path.join(firstDir, "proof.json")), record(path.join(firstDir, "runner.mjs.txt"))];
const output = {
  schemaVersion: 1, status: checks.every((c) => c.passed) ? "passed_artifact_review" : "failed_artifact_review",
  runId: proof.runId, reviewedAt: new Date().toISOString(), reviewKind: "same agent artifact-only verification after actual processes exited; no new network/UI observation",
  proof: record(proofFile), source, test, dependency: { ...dependency, committedBlobSha256: sha(dependencyBlob) },
  requestAccounting: { recordedTotal: 39, local4470: { total: local.length, initialize: 1, catalog: 1, toolsCall: 34, toolCounts },
    auxiliary4419: { total: 3, gmLogin: 1, membershipPatch: 2 },
    separatelyRecordedNonceUpdateGet: 1, healthReadinessPolls: { exactAttempts: null, includedIn39: false },
    inspectorDiscoveryPolls: { exactAttempts: null, includedIn39: false },
    inspectorWebSocketCommands: { includedIn39: false },
    copyAutomaticTraffic: "not a complete network trace; startup notification/renderer API reads and nonce update checks are outside the 39-entry ledger" },
  rawRecords, privateMetadata, packageCopySummary: { files: copiedFiles.length, bytes: copiedFiles.reduce((n, r) => n + r.bytes, 0), inventorySource: "proof.packageInputs; all copied bytes rehashed" },
  protectedSnapshot: { files: 6, source: "proof.protectedBefore/protectedAfter", readAgainDuringReview: false, wholeProfileClaim: false },
  limitations: [...proof.limits, "Login receipts are deliberately absent from raw retention; public redacted identity and recorded raw-response SHA remain, so original login bodies cannot be rehashed.", "B membership comparison covers userId, status, version, roles and identity, not volatile session counts.", "No GUI screenshots are appropriate for this MCP-only task. The review does not establish original GUI session behavior."],
  firstFailure: { runId: first.runId, checks: first.checks.length, requests: 0, processLaunches: 0, proof: record(path.join(firstDir, "proof.json")), source: record(path.join(firstDir, "runner.mjs.txt")) },
  checks, summary: { passed: checks.filter((c) => c.passed).length, failed: checks.filter((c) => !c.passed).length }, frozenInputs: frozen,
};
for (const item of frozen) assert.equal(record(item.path).sha256, item.sha256);
fs.writeFileSync(path.join(here, "artifact-review-r2.json"), JSON.stringify(output, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ status: output.status, ...output.summary, proofSha256: output.proof.sha256, reviewSha256: record(path.join(here, "artifact-review-r2.json")).sha256 }));
if (output.summary.failed) process.exitCode = 1;
