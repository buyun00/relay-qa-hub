import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../../..");
const summary = JSON.parse(readFileSync(resolve(here, "summary.json"), "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

assert(summary.schemaVersion === 1, "Unexpected schema version");
assert(
  summary.kind === "preexisting-isolated-runtime-behavior-with-current-worktree-coexistence",
  "Unexpected kind",
);
assert(summary.passed === true, "Revalidation batch did not pass");
assert(summary.scope.isolatedBehaviorBatchStatus === "pass", "Batch status is not pass");
assert(summary.scope.currentSourceRevalidationStatus === "not_proven");
assert(summary.scope.overallAcceptanceStatus === "not_complete", "Overall status drifted");
assert(summary.scope.completionAllowed === false, "Completion must remain blocked");
assert(summary.scope.clearsWholeCoverageMatrix === false, "Evidence must remain scoped");
assert(summary.scope.externalComponentsExecuted === false, "External execution claim drifted");
assert(summary.scope.userOnlyGatesExecuted === false, "User-only execution claim drifted");
assert(summary.sourceBinding.runtimeBytesBoundToPinnedSource === false);
assert(
  summary.sourceBinding.runtimeBindingStatus ===
    "insufficient_preexisting_process_started_before_latest_dist_build",
);
assert(summary.runEvidence.length === 3, "Expected exactly three smoke runs");
for (const run of summary.runEvidence) {
  const absolute = resolve(root, run.file);
  const body = JSON.parse(readFileSync(absolute, "utf8"));
  assert(body.passed === true, `${run.id} source evidence is not passed`);
  assert(body.runId === run.runId, `${run.id} run ID changed`);
  assert(body.instanceId === run.instanceId, `${run.id} instance ID changed`);
  assert(body.checks.length === run.checks, `${run.id} check count changed`);
  assert(readFileSync(absolute).length === run.bytes, `${run.id} byte count changed`);
  assert(sha256(absolute) === run.sha256, `${run.id} hash changed`);
}
const baseline = resolve(root, summary.coexistence.baseline.file);
assert(readFileSync(baseline).length === summary.coexistence.baseline.bytes, "Baseline bytes changed");
assert(sha256(baseline) === summary.coexistence.baseline.sha256, "Baseline hash changed");
assert(summary.checks.allRunsPassed === true, "Run check aggregate failed");
assert(summary.checks.exactRunHashes === true, "Run hash aggregate failed");
assert(summary.checks.localRemoteEvidenceHeadExact === true, "Capture had unsynchronized evidence head");
assert(summary.checks.currentWorktreeProductSourceExact === true, "Worktree source did not match");
assert(summary.checks.runtimeSourceBindingProven === false, "Runtime binding must remain unproven");
assert(summary.checks.productionListenerPidsUnchanged === true, "Production listeners changed");
assert(summary.checks.foreignDailyClientUnchanged === true, "Foreign daily client changed");
assert(summary.checks.allHealthProbesHttp200 === true, "Health aggregate failed");
assert(summary.checks.allDeclaredHealthReady === true, "Declared readiness aggregate failed");

const currentHead = execFileSync("git.exe", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const committedProductDiff = execFileSync(
  "git.exe",
  [
    "diff",
    "--name-only",
    summary.worktreeProductSourceCommit,
    currentHead,
    "--",
    ...summary.sourceBinding.productPaths,
  ],
  { cwd: root, encoding: "utf8" },
).trim();
assert(committedProductDiff === "", "Current committed product source no longer matches the evidence");

console.log(
  JSON.stringify({
    passed: true,
    worktreeProductSourceCommit: summary.worktreeProductSourceCommit,
    capturedEvidenceHead: summary.evidenceHead,
    currentHead,
    runs: summary.runEvidence.map(({ id, checks, sha256 }) => ({ id, checks, sha256 })),
    overallAcceptanceStatus: summary.scope.overallAcceptanceStatus,
  }),
);
