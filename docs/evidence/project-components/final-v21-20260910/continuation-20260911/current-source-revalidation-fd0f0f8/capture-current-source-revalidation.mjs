import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../../..");
const outputPath = resolve(here, "summary.json");
const productSourceCommit = "fd0f0f850f907b8a77aac8ec8b6a71b308bdd711";
const productPaths = [
  "apps/api/src",
  "apps/web/src",
  "apps/desktop/src",
  "apps/android/app/src/main",
  "apps/worker/src",
  "packages/domain/src",
];
const runs = [
  {
    id: "management",
    file: "docs/evidence/project-components/runs/management-2026-09-11T00-47-48-121Z.json",
    checks: 96,
    sha256: "54a7ef58415dc3e3968fa281a3027da669ec2d91edb86316bddb83c84abd9247",
  },
  {
    id: "http-core",
    file: "docs/evidence/project-components/runs/http-core-2026-09-11T00-47-56-276Z.json",
    checks: 15,
    sha256: "c52e1eafd9c3230080f1d7033868d3d250d4a7a1501803bcbbe82e98145b5d3c",
  },
  {
    id: "server-mcp-core",
    file: "docs/evidence/project-components/runs/server-mcp-core-2026-09-11T00-48-06-698Z.json",
    checks: 13,
    sha256: "762fc4ccd3d2b3be2ffae6553123ef3bdc29f00cfe35b7ffd0e55f493ece5825",
  },
];
const baselineFile =
  "docs/evidence/project-components/desktop-notification-project-route-live/81c44b26-5c6f-47c6-a56a-d4eb27f19d7a/raw/host-before.json";
const expectedPorts = new Map([
  [4174, 7420],
  [4319, 14044],
  [4320, 17160],
  [4639, 19004],
  [4640, 20452],
  [4641, 19112],
  [4642, 22020],
  [9333, 26828],
  [9433, 22020],
]);

function git(...args) {
  return execFileSync("git.exe", args, { cwd: root, encoding: "utf8" }).trim();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function gitQuiet(args) {
  const result = spawnSync("git.exe", args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  return result.status === 0;
}

function captureListeners() {
  const ports = [...expectedPorts.keys()].join(",");
  const script = String.raw`
$rows = @()
$ports = ${ports}
foreach ($port in $ports) {
  $connections = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)" -ErrorAction SilentlyContinue
    $rows += [pscustomobject]@{
      port = [int]$port
      address = $connection.LocalAddress
      pid = [int]$connection.OwningProcess
      sessionId = if ($process) { [int]$process.SessionId } else { $null }
      name = if ($process) { $process.Name } else { $null }
      executablePath = if ($process) { $process.ExecutablePath } else { $null }
      startedAt = if ($process) { $process.CreationDate.ToUniversalTime().ToString("o") } else { $null }
    }
  }
}
@($rows | Sort-Object port, pid) | ConvertTo-Json -Depth 4 -Compress
`;
  const body = execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" },
  ).trim();
  return body ? JSON.parse(body) : [];
}

async function captureHealth() {
  const targets = [
    ["production-api", "http://127.0.0.1:4319/api/v1/health/ready"],
    ["isolated-api", "http://127.0.0.1:4639/api/v1/health/ready"],
    ["isolated-web", "http://127.0.0.1:4640/"],
    ["isolated-server-mcp", "http://127.0.0.1:4641/health"],
    ["isolated-local-mcp", "http://127.0.0.1:4642/health"],
  ];
  const results = [];
  for (const [id, url] of targets) {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    let declaredStatus = null;
    try {
      declaredStatus = JSON.parse(await response.text()).status ?? null;
    } catch {
      // The Web root is HTML; only its HTTP status is part of this probe.
    }
    results.push({ id, url, httpStatus: response.status, declaredStatus });
  }
  return results;
}

const evidenceHead = git("rev-parse", "HEAD");
const remoteHead = git("rev-parse", "origin/codex/project-components-v2-1");
const productPathsCommittedMatch = gitQuiet([
  "diff",
  "--quiet",
  productSourceCommit,
  evidenceHead,
  "--",
  ...productPaths,
]);
const productPathsWorktreeClean =
  git("status", "--porcelain=v1", "--", ...productPaths) === "";
assert(productPathsCommittedMatch, "Committed product paths differ from the pinned source");
assert(productPathsWorktreeClean, "Product paths have uncommitted changes");
assert(evidenceHead === remoteHead, "Local and remote evidence heads differ");

const runEvidence = runs.map((expected) => {
  const absolute = resolve(root, expected.file);
  const body = JSON.parse(readFileSync(absolute, "utf8"));
  const observed = {
    id: expected.id,
    file: expected.file,
    runId: body.runId,
    instanceId: body.instanceId,
    passed: body.passed === true,
    checks: Array.isArray(body.checks) ? body.checks.length : 0,
    bytes: readFileSync(absolute).length,
    sha256: sha256(absolute),
  };
  assert(observed.passed, `${expected.id} did not pass`);
  assert(observed.checks === expected.checks, `${expected.id} check count changed`);
  assert(observed.sha256 === expected.sha256, `${expected.id} evidence hash changed`);
  return observed;
});

const baselineAbsolute = resolve(root, baselineFile);
const baseline = JSON.parse(readFileSync(baselineAbsolute, "utf8"));
const listeners = captureListeners();
for (const [port, pid] of expectedPorts) {
  assert(
    listeners.some((entry) => entry.port === port && entry.pid === pid),
    `Expected listener ${port}/PID ${pid} is absent`,
  );
}
const productionPorts = [4174, 4319, 4320];
for (const port of productionPorts) {
  const before = baseline.listeners.find((entry) => entry.port === port);
  const after = listeners.find((entry) => entry.port === port);
  assert(before?.pid === after?.pid, `Production listener ${port} changed PID`);
}
assert(
  baseline.processes.some(
    (entry) =>
      entry.pid === 26828 &&
      entry.path === "D:\\Relay-QA-Hub\\apps\\desktop\\release\\RelayQaHub-win32-x64\\RelayQaHub.exe",
  ),
  "Foreign daily client baseline is absent",
);
assert(
  listeners.some(
    (entry) =>
      entry.port === 9333 &&
      entry.pid === 26828 &&
      entry.executablePath ===
        "D:\\Relay-QA-Hub\\apps\\desktop\\release\\RelayQaHub-win32-x64\\RelayQaHub.exe",
  ),
  "Foreign daily client changed",
);

const health = await captureHealth();
for (const probe of health) {
  assert(probe.httpStatus === 200, `${probe.id} health returned ${probe.httpStatus}`);
}
for (const id of ["production-api", "isolated-api", "isolated-server-mcp", "isolated-local-mcp"]) {
  assert(
    health.find((probe) => probe.id === id)?.declaredStatus === "ready",
    `${id} did not declare ready`,
  );
}

const summary = {
  schemaVersion: 1,
  kind: "preexisting-isolated-runtime-behavior-with-current-worktree-coexistence",
  capturedAt: new Date().toISOString(),
  worktreeProductSourceCommit: productSourceCommit,
  evidenceHead,
  remoteHead,
  sourceBinding: {
    productPaths,
    worktreeCommittedProductPathsMatchPinnedSource: productPathsCommittedMatch,
    productPathsWorktreeClean,
    runtimeBytesBoundToPinnedSource: false,
    runtimeBindingStatus: "insufficient_preexisting_process_started_before_latest_dist_build",
    comparison: `git diff --quiet ${productSourceCommit} ${evidenceHead} -- ${productPaths.join(" ")}`,
  },
  scope: {
    isolatedBehaviorBatchStatus: "pass",
    currentSourceRevalidationStatus: "not_proven",
    overallAcceptanceStatus: "not_complete",
    completionAllowed: false,
    clearsWholeCoverageMatrix: false,
    externalComponentsExecuted: false,
    userOnlyGatesExecuted: false,
    isolatedPreviewBusinessDataMutatedBySmokes: true,
    productionBusinessRequestsSentBySmokes: false,
    note: "This records three executed smoke runs on a pre-existing isolated runtime and verifies coexistence with the current worktree. The runtime process predates the latest dist build, so this record does not bind those runs to the pinned product source and clears zero revalidation flags.",
  },
  runEvidence,
  coexistence: {
    baseline: {
      file: baselineFile,
      capturedAt: baseline.capturedAt,
      bytes: readFileSync(baselineAbsolute).length,
      sha256: sha256(baselineAbsolute),
    },
    productionPortsUnchanged: productionPorts.map((port) => ({
      port,
      pid: expectedPorts.get(port),
    })),
    foreignDailyClientUnchanged: {
      port: 9333,
      pid: 26828,
      executablePath:
        "D:\\Relay-QA-Hub\\apps\\desktop\\release\\RelayQaHub-win32-x64\\RelayQaHub.exe",
    },
    currentListeners: listeners,
    health,
  },
  checks: {
    allRunsPassed: runEvidence.every((run) => run.passed),
    exactRunHashes: runEvidence.every(
      (run) => runs.find((expected) => expected.id === run.id)?.sha256 === run.sha256,
    ),
    localRemoteEvidenceHeadExact: evidenceHead === remoteHead,
    currentWorktreeProductSourceExact: productPathsCommittedMatch && productPathsWorktreeClean,
    runtimeSourceBindingProven: false,
    productionListenerPidsUnchanged: true,
    foreignDailyClientUnchanged: true,
    allHealthProbesHttp200: health.every((probe) => probe.httpStatus === 200),
    allDeclaredHealthReady: health
      .filter((probe) => probe.id !== "isolated-web")
      .every((probe) => probe.declaredStatus === "ready"),
  },
  passed: true,
};

mkdirSync(here, { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  JSON.stringify({
    passed: summary.passed,
    output: relative(root, outputPath).replaceAll("\\", "/"),
    worktreeProductSourceCommit: productSourceCommit,
    evidenceHead,
    runs: runEvidence.map(({ id, checks, sha256 }) => ({ id, checks, sha256 })),
  }),
);
