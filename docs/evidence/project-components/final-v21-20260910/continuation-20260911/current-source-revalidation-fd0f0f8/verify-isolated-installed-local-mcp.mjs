import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../../..");
const candidates = readdirSync(resolve(here, "desktop-local-mcp"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(here, "desktop-local-mcp", entry.name, "proof.json"));
assert.equal(candidates.length, 1, "Expected exactly one installed local MCP proof");
const proof = JSON.parse(readFileSync(candidates[0], "utf8"));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

assert.equal(proof.schemaVersion, 1);
assert.equal(proof.kind, "installed-preview-isolated-profile-local-mcp-current-source");
assert.equal(proof.productSourceCommit, "fd0f0f850f907b8a77aac8ec8b6a71b308bdd711");
assert.equal(proof.installed.version, "0.2.0-preview.20");
assert.equal(sha256(proof.installed.executable), proof.installed.sha256);
assert.equal(readFileSync(proof.installed.executable).length, proof.installed.bytes);
assert.equal(proof.isolation.canonicalProfileUntouched, true);
assert.equal(proof.isolation.canonicalMcpPortUntouched, true);
assert.equal(proof.isolation.externalComponentsDisabledProof.allOptionalComponentsDisabled, true);
const componentProof = resolve(
  root,
  proof.isolation.externalComponentsDisabledProof.file,
);
assert.equal(
  sha256(componentProof),
  proof.isolation.externalComponentsDisabledProof.sha256,
  "Component-disable proof changed",
);
const executionEvidence = resolve(root, proof.execution.evidence);
const execution = JSON.parse(readFileSync(executionEvidence, "utf8"));
assert.equal(execution.passed, true);
assert.equal(execution.checks.length, 13);
assert.equal(execution.projectId, proof.isolation.externalComponentsDisabledProof.projectId);
assert.equal(execution.url, proof.execution.transport);
assert.equal(readFileSync(executionEvidence).length, proof.execution.evidenceBytes);
assert.equal(sha256(executionEvidence), proof.execution.evidenceSha256);
assert.equal(proof.process.cleanup.requested, "electron.app.quit");
assert.equal(proof.process.cleanup.exitCode, 0);
assert.deepEqual(proof.process.preexistingProcessesAfter, proof.process.preexistingProcessesBefore);
assert.deepEqual(proof.process.preexistingListenersAfter, proof.process.preexistingListenersBefore);
assert.equal(proof.process.ownedPortsReleased, true);
for (const key of [
  "productionPortsUsed",
  "productionBusinessRequestsSent",
  "externalComponentsExecuted",
  "userOnlyGatesExecuted",
  "canonicalInstalledProfileMutated",
  "canonicalInstalledProcessSignaled",
  "foreignProcessesSignaled",
  "forceKillUsed",
])
  assert.equal(proof.safety[key], false, `${key} must be false`);
assert.equal(proof.scope.localMcpCurrentSourceStatus, "pass");
assert.equal(proof.scope.overallAcceptanceStatus, "not_complete");
assert.equal(proof.scope.completionAllowed, false);
assert.equal(proof.passed, true);

const currentHead = execFileSync("git.exe", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const productDiff = execFileSync(
  "git.exe",
  [
    "diff",
    "--name-only",
    proof.productSourceCommit,
    currentHead,
    "--",
    "apps/api/src",
    "apps/web/src",
    "apps/desktop/src",
    "apps/android/app/src/main",
    "apps/worker/src",
    "packages/domain/src",
  ],
  { cwd: root, encoding: "utf8" },
).trim();
assert.equal(productDiff, "", "Committed product source changed");

console.log(
  JSON.stringify({
    passed: true,
    runId: proof.runId,
    installedVersion: proof.installed.version,
    localMcpChecks: execution.checks.length,
    evidence: proof.execution.evidence,
    evidenceSha256: proof.execution.evidenceSha256,
    cleanup: proof.process.cleanup,
    overallAcceptanceStatus: proof.scope.overallAcceptanceStatus,
  }),
);
