import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../../..");
const evidenceRoot = resolve(here, "fresh-api-mcp");
const runtimeBase = "C:\\Users\\lin0\\.codex\\parallel-runtimes\\qa-hub-preview-fd0f0f8-current-source";
const pinnedSource = "fd0f0f850f907b8a77aac8ec8b6a71b308bdd711";
const attempts = {
  slowSnapshot: "7b3c290d-dc55-48ae-b9e6-3416c8de15a2",
  missingWorkerPath: "3f4a482c-69db-40e1-85ce-5f289eb38702",
  inspectorMetadata: "d3b792a6-7837-4c60-ba91-fe78b2d5dbd1",
  pass: "cdd86698-1b45-4b1a-bb64-0a03c42b9b66",
};
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const receipt = (path) => ({
  path,
  bytes: statSync(path).size,
  sha256: sha256(path),
});
const relativeReceipt = (path) => ({ ...receipt(path), path: relative(root, path).replaceAll("\\", "/") });

function runtimePath(runId, instanceId) {
  return resolve(runtimeBase, runId, instanceId);
}

function listenerSnapshot(ports) {
  const script = String.raw`
$ports = @(${ports.join(",")})
$items = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $ports -contains [int]$_.LocalPort } |
  ForEach-Object { [pscustomobject]@{ port=[int]$_.LocalPort; address=$_.LocalAddress; pid=[int]$_.OwningProcess } } |
  Sort-Object port,address,pid)
ConvertTo-Json -Compress -InputObject $items
`;
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", script], {
    encoding: "utf8",
  }).trim();
  return output ? JSON.parse(output) : [];
}

function processSnapshot(pids) {
  const script = String.raw`
$pids = @(${pids.join(",")})
$items = @()
foreach ($pidValue in $pids) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
  if ($process) { $items += [pscustomobject]@{ pid=[int]$pidValue; name=$process.Name; commandLine=[string]$process.CommandLine } }
}
ConvertTo-Json -Compress -InputObject $items
`;
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", script], {
    encoding: "utf8",
  }).trim();
  return output ? JSON.parse(output) : [];
}

const slowRuntime = runtimePath(attempts.slowSnapshot, "qa-hub-preview-fd0f0f8-7b3c290d");
const inspectorRuntime = runtimePath(attempts.inspectorMetadata, "qa-hub-preview-fd0f0f8-d3b792a6");
const missingRuntimeParent = resolve(runtimeBase, attempts.missingWorkerPath);
const passingProofPath = resolve(evidenceRoot, attempts.pass, "proof.json");
const failurePath = resolve(evidenceRoot, attempts.inspectorMetadata, "failed-attempt.json");
const failure = JSON.parse(readFileSync(failurePath, "utf8"));
const passingProof = JSON.parse(readFileSync(passingProofPath, "utf8"));

const slowPorts = [59957, 59958, 59959, 59960, 59961, 59962];
const inspectorPorts = failure.ownedPorts;
const ownedPids = [11576, ...failure.processes.map((item) => item.pid)];
const lingeringListeners = listenerSnapshot([...slowPorts, ...inspectorPorts]);
const lingeringProcesses = processSnapshot(ownedPids);
assert.deepEqual(lingeringListeners, []);
assert.deepEqual(lingeringProcesses, []);

const currentProtectedListeners = listenerSnapshot(passingProof.coexistence.protectedPorts);
const expectedProtectedListeners = passingProof.coexistence.after
  .map(({ port, address, pid }) => ({ port, address, pid }))
  .sort((left, right) => left.port - right.port || left.address.localeCompare(right.address));
assert.deepEqual(currentProtectedListeners, expectedProtectedListeners);

const slowInstance = resolve(slowRuntime, "instance.json");
const slowStdout = resolve(slowRuntime, "logs/api.stdout.log");
const slowStderr = resolve(slowRuntime, "logs/api.stderr.log");
const inspectorInstance = resolve(inspectorRuntime, "instance.json");
const inspectorStdout = resolve(inspectorRuntime, "logs/api.stdout.log");
const inspectorStderr = resolve(inspectorRuntime, "logs/api.stderr.log");
for (const path of [slowInstance, slowStdout, slowStderr, inspectorInstance, inspectorStdout, inspectorStderr])
  assert(existsSync(path), `Retained attempt artifact missing: ${path}`);

const slowLog = readFileSync(slowStdout, "utf8");
const inspectorLog = readFileSync(inspectorStdout, "utf8");
assert(slowLog.includes("Relay QA Hub API started"));
assert(slowLog.includes('"signal":"SIGINT"'));
assert(slowLog.includes("stopping Relay QA Hub API"));
assert(inspectorLog.includes("Relay QA Hub API started"));
assert.equal(inspectorLog.includes("stopping Relay QA Hub API"), false);
assert.equal(failure.error.message, "CDP_-32000_Promise was collected");
assert.equal(failure.smokeRuns.length, 0);

const observedAt = new Date().toISOString();
const supplement = {
  schemaVersion: 1,
  kind: "fresh-current-source-failed-attempt-post-shell-finalization",
  runId: attempts.inspectorMetadata,
  observedAt,
  originalFailure: relativeReceipt(failurePath),
  originalState: {
    processPresentAfterHarnessCleanup: true,
    ownedPortsRemaining: failure.ownedPortsRemaining,
    cleanupReceipt: failure.processes[0].cleanup,
  },
  laterReadOnlyObservation: {
    ownedPid: failure.processes[0].pid,
    processPresent: false,
    ownedPorts: inspectorPorts,
    listenersPresent: [],
    stdout: receipt(inspectorStdout),
    stderr: receipt(inspectorStderr),
    apiStartLogPresent: true,
    gracefulShutdownLogPresent: false,
  },
  finalizationAssessment:
    "The PTY ended after the harness failure and the owned process later disappeared, but no product shutdown log or cleanup receipt exists. Finalization is therefore recorded as abrupt_or_unknown rather than graceful.",
  runtimeRetained: true,
  userOnlyGatesExecuted: false,
  completionAllowed: false,
  passed: false,
};
const supplementPath = resolve(evidenceRoot, attempts.inspectorMetadata, "post-shell-finalization.json");
writeFileSync(supplementPath, `${JSON.stringify(supplement, null, 2)}\n`, { flag: "wx" });

const summary = {
  schemaVersion: 1,
  kind: "fresh-current-source-api-mcp-attempt-history",
  recordedAt: observedAt,
  productSourceCommit: pinnedSource,
  attempts: [
    {
      runId: attempts.slowSnapshot,
      outcome: "interrupted",
      stage: "host-state-snapshot-loop-before-smokes",
      productSuitesExecuted: [],
      evidenceAssessment:
        "The original harness did not write a proof. Retained logs show only the self-owned API started and then handled SIGINT after the PTY was interrupted.",
      ownedProcess: { pid: 11576, presentAtSummaryCapture: false },
      ownedPorts: slowPorts,
      listenersPresentAtSummaryCapture: [],
      runtimeRoot: slowRuntime,
      retainedArtifacts: [receipt(slowInstance), receipt(slowStdout), receipt(slowStderr)],
      apiStartLogPresent: true,
      shutdownLog: { present: true, signal: "SIGINT" },
      runtimeRetained: true,
      acceptedAsPassingEvidence: false,
    },
    {
      runId: attempts.missingWorkerPath,
      outcome: "failed",
      stage: "pre-service-runtime-binding-path-check",
      productSuitesExecuted: [],
      error:
        "The harness referenced the nonexistent packages/storage/dist/sqlite-worker-client.js path and exited before service startup.",
      runtimeParent: missingRuntimeParent,
      runtimeParentExists: existsSync(missingRuntimeParent),
      runtimeParentFileCount: 0,
      serviceStarted: false,
      runtimeRetained: true,
      acceptedAsPassingEvidence: false,
    },
    {
      runId: attempts.inspectorMetadata,
      outcome: "failed",
      stage: "owned-api-inspector-metadata-read-before-smokes",
      productSuitesExecuted: [],
      originalFailure: relativeReceipt(failurePath),
      postShellFinalization: relative(root, supplementPath).replaceAll("\\", "/"),
      runtimeRoot: inspectorRuntime,
      retainedArtifacts: [receipt(inspectorInstance), receipt(inspectorStdout), receipt(inspectorStderr)],
      finalization: "abrupt_or_unknown",
      runtimeRetained: true,
      acceptedAsPassingEvidence: false,
    },
    {
      runId: attempts.pass,
      outcome: "passed",
      stage: "fresh-build-api-server-mcp-scoped-revalidation",
      productSuitesExecuted: passingProof.runs.map((item) => ({ id: item.id, checks: item.checks })),
      proof: relativeReceipt(passingProofPath),
      ownedProcessesGracefullyExited: passingProof.processes.map((item) => ({
        id: item.id,
        pid: item.pid,
        method: item.cleanup.method,
        exitCode: item.cleanup.exitCode,
      })),
      runtimeRoot: passingProof.instance.runtimeRoot,
      runtimeRetained: true,
      acceptedAsPassingEvidence: true,
    },
  ],
  finalReadOnlyObservation: {
    lingeringOwnedProcesses: lingeringProcesses,
    lingeringOwnedListeners: lingeringListeners,
    currentProtectedListeners,
    matchesPassingProofPostState: true,
  },
  safety: {
    noFailedAttemptWasDeleted: true,
    failedRuntimeDataRetained: true,
    productionProcessesChangedByThisCapture: false,
    externalComponentsExecutedByTheseAttempts: false,
    userOnlyGatesExecutedByTheseAttempts: false,
  },
  scope: {
    passingAttemptCount: 1,
    passingAttempt: attempts.pass,
    eligibleNeedsRevalidationClearCount: 0,
    overallAcceptanceStatus: "not_complete",
    completionAllowed: false,
  },
};
const summaryPath = resolve(evidenceRoot, "attempts-summary.json");
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });

console.log(
  JSON.stringify({
    passed: true,
    supplement: relative(root, supplementPath).replaceAll("\\", "/"),
    summary: relative(root, summaryPath).replaceAll("\\", "/"),
    passingAttempt: attempts.pass,
    failedOrInterruptedAttemptsRetained: 3,
    lingeringOwnedProcesses: 0,
    lingeringOwnedListeners: 0,
    overallAcceptanceStatus: "not_complete",
  }),
);
