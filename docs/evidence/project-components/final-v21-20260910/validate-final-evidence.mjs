import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const sourceCommit = "88a6d0f9c31106f6cd3fc9edbadca0db6bf6397b";
const userLabel = "用户自测／已移交，代理未执行";
const delegatedIds = [
  "android-physical-device",
  "external-build-terminal",
  "external-single-build-upload-terminal",
  "external-incremental-publication-terminal",
  "external-relay-delivery-terminal",
  "external-qingyu-order-terminal",
];
const productSourceRoots = [
  "apps/api/src",
  "apps/web/src",
  "apps/desktop/src",
  "apps/android/app/src/main",
  "apps/worker/src",
  "packages/domain/src",
];

async function json(relative) {
  return JSON.parse((await readFile(path.join(root, relative), "utf8")).replace(/^\uFEFF/u, ""));
}

async function visit(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const stat = await lstat(absolute);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) files.push(...(await visit(absolute)));
    else if (stat.isFile()) files.push(absolute);
  }
  return files;
}

const acceptance = await json("acceptance-matrix.json");
assert.equal(acceptance.productSourceCommit, sourceCommit);
assert.equal(acceptance.overallStatus, "not_complete");
assert.equal(acceptance.completionAllowed, false);
assert.equal(acceptance.agentScopeStatus, "complete_user_acceptance_pending");
assert.deepEqual(acceptance.agentBlocking, []);
assert.equal(acceptance.userAcceptancePending.length, 6);
for (const id of delegatedIds) {
  const item = acceptance.cases.find((candidate) => candidate.id === id);
  assert.ok(item);
  assert.equal(item.status, "not_run");
  assert.equal(item.owner, "user");
  assert.equal(item.handoffStatus, "delegated_to_user");
  assert.equal(item.agentExecuted, false);
  assert.equal(item.resultLabel, userLabel);
}

for (const item of acceptance.cases) {
  for (const evidence of item.evidence ?? []) {
    assert.equal((await lstat(path.resolve(root, evidence))).isFile(), true, `${item.id}: ${evidence}`);
  }
}

const coverage = JSON.parse(
  (await readFile(path.resolve(root, "../coverage-matrix.json"), "utf8")).replace(/^\uFEFF/u, ""),
);
assert.match(coverage.sourceHead, /^[a-f0-9]{40}$/u);
execFileSync(
  "git",
  ["diff", "--quiet", sourceCommit, coverage.sourceHead, "--", ...productSourceRoots],
  { cwd: path.resolve(root, "../../../.."), stdio: "ignore" },
);
assert.equal(coverage.summary.itemCount, 1030);
assert.equal(coverage.retiredItems.length, 47);
assert.ok(coverage.items.filter((item) => item.needsRevalidation).length > 0);

const artifact = await json(
  "android/acceptance/android-code28-self-update/artifact-verification.json",
);
assert.equal(artifact.sourceCommit, sourceCommit);
assert.equal(artifact.versionCode, 28);
assert.equal(artifact.sha256, "61a885f22b9a62383d923bf36ca0f9ade9f987c22bb30c7323bd8acbd7536e7a");
assert.equal(artifact.signatureVerified, true);
const liveHttp = await json("live-http-e2e.json");
const dbReceipt = await json("live-http-db-receipt.json");
const mcp = await json("post-restart-mcp-check.json");
const source = await json("source-verification-88a6d0f/summary.json");
const secretScan = await json("secret-scan.json");
assert.equal(liveHttp.assertionsPassed, true);
for (const proof of [dbReceipt, mcp, source, secretScan]) assert.equal(proof.passed, true);
assert.equal(dbReceipt.receipt.digestAlgorithm, "HMAC-SHA-256");
assert.equal(dbReceipt.receipt.count, 1);
assert.equal(dbReceipt.auditEvent.count, 1);
assert.deepEqual(mcp.results.map((item) => item.toolCount), [96, 96]);

const files = await visit(root);
let parsedJsonFiles = 0;
for (const file of files.filter((candidate) => path.extname(candidate).toLowerCase() === ".json")) {
  JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
  parsedJsonFiles += 1;
}

const index = await json("evidence-index.json");
for (const entry of index.entries) {
  const bytes = await readFile(path.join(root, entry.path));
  assert.equal(bytes.byteLength, entry.bytes, entry.path);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, entry.path);
}

const result = {
  schemaVersion: 1,
  validatedAt: new Date().toISOString(),
  sourceCommit,
  acceptanceOverallStatus: acceptance.overallStatus,
  agentScopeStatus: acceptance.agentScopeStatus,
  completionAllowed: acceptance.completionAllowed,
  delegatedUserCases: delegatedIds.length,
  delegatedCasesAllNotRun: true,
  fineGrainedCoverage: {
    items: coverage.summary.itemCount,
    retiredItems: coverage.retiredItems.length,
    needsRevalidation: coverage.items.filter((item) => item.needsRevalidation).length,
  },
  coverageSourceHead: coverage.sourceHead,
  coverageProductSourceMatches: true,
  parsedJsonFiles,
  preValidationIndexEntriesVerified: index.entries.length,
  credentialsPersisted: false,
  passed: true,
};
await writeFile(path.join(root, "final-validation.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
