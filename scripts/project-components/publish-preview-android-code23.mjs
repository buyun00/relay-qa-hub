import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";
import {
  databaseFacts,
  fileFact,
  hash,
  treeFacts,
} from "./retain-preview-android-update-state.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(scriptFile), "../..");
const instanceId = "qa-hub-preview-7c86";
const runtimeRoot = join(homedir(), ".codex/parallel-runtimes", instanceId);
const deploymentId = "7a94eb90-63a2-4841-afa5-318612eb06ce";
const shaPattern = /^[a-f0-9]{64}$/u;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const proofRelative = "docs/evidence/project-components/android-code23-feed-publication";
export const artifact = Object.freeze({
  versionCode: 23,
  versionName: "0.2.0-preview.9",
  packageName: "com.relayqahub.android.preview.debug",
  fileName: "Relay-QA-Hub-Android-23-0.2.0-preview.9.apk",
  size: 35536941,
  sha256: "9cfa87eb36b5be80f218e104fb4c6338fda3e96e5dcc694d897c5907df768548",
  sourceCommit: "33514cde1862e448cb56d7082177f34a88e42363",
});
const certificateSha256 = "9bbf6d2a68c27871c00abc3203fb319629aabacdcac03674483262bcf09e2a83";
const oldApkName = `${instanceId}-android-0.2.0-preview.8-code22.apk`;
const sourcePins = {
  "apps/api/src/android-updates.ts":
    "368e4013e58a9f4fb28a128ff5d55de4cd77d3d9176e90c9b9862d08b0e45c5e",
  "apps/api/src/app.ts": "290a44c2d7f73b8d6970e98765590aea6e80853fb4eec105d14cd1155d83db3a",
  "apps/api/src/main.ts": "fc9f8b58eac2f2d89296da95eaf06a404464a2252ff2cd31a15ddccb676650bd",
  "apps/api/src/parallel-instance.ts":
    "272379786a9d8806a90c85c5e5ec6e1b07fc5c01ae50e01aed603a250e597fcf",
  "apps/api/src/project-request-context.ts":
    "070ce75ac44875a8d338dcb927ba1f4cc89fbdedc8cd9753b0e34e909a132bab",
  "apps/api/test/android-update-channels.test.mjs":
    "e4b3829ec05e3ecbf76cdb5ca8196dd0fe0054eaf9cc84878dadc40b9a78f383",
  "apps/api/test/android-update-auth-integration.test.mjs":
    "3e200893eb932f104011240b1a4edd366423ed90b2191d6f8d465cc6240a1b2f",
  "apps/api/test/parallel-instance.test.mjs":
    "ef82f93328e5a00c340d2e49761ba8fc5287e063191f668edb35b1a59bbcefbc",
  "scripts/project-components/retain-preview-android-update-state.mjs":
    "669042c8c82307d02bd291e9de99b1ddc5af86694a83425158bd55ee35c000f3",
};
function requireThat(condition, code) {
  if (!condition) throw new Error(code);
}
function ordinaryDirectory(path) {
  const info = lstatSync(path);
  requireThat(
    !info.isSymbolicLink() &&
      info.isDirectory() &&
      resolve(realpathSync.native(path)).toLowerCase() === resolve(path).toLowerCase(),
    "ORDINARY_DIRECTORY_REQUIRED",
  );
}
export function manifestBytes() {
  return Buffer.from(
    JSON.stringify({ schemaVersion: 1, channel: "preview", ...artifact }, null, 2) + "\n",
  );
}
export function preimage(path) {
  return existsSync(path) ? { exists: true, ...fileFact(path) } : { exists: false };
}
export function assertPreimage(path, expected) {
  assert.deepEqual(preimage(path), expected, "LATEST_PREIMAGE_CHANGED");
}
function writeNewDurable(path, bytes) {
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function installImmutableFile(source, root, fileName, expected) {
  ordinaryDirectory(root);
  requireThat(
    basename(fileName) === fileName && !/[\\/]/u.test(fileName),
    "ARTIFACT_FILENAME_REFUSED",
  );
  assert.deepEqual(fileFact(source), expected, "SOURCE_ARTIFACT_CHANGED");
  const target = join(root, fileName);
  if (existsSync(target)) {
    assert.deepEqual(fileFact(target), expected, "EXISTING_ARTIFACT_DIFFERENT");
    return { disposition: "existing-identical", path: target, ...expected };
  }
  const temp = join(root, `.code23-artifact-${randomUUID()}.pending`);
  copyFileSync(source, temp, constants.COPYFILE_EXCL);
  assert.deepEqual(fileFact(temp), expected, "STAGED_ARTIFACT_CHANGED");
  const stagedFd = openSync(temp, "r+");
  try {
    fsyncSync(stagedFd);
  } finally {
    closeSync(stagedFd);
  }
  // Same-directory hardlink publication is atomic and cannot overwrite an
  // existing destination. The verified temporary name remains as evidence.
  linkSync(temp, target);
  assert.deepEqual(fileFact(target), expected, "PUBLISHED_ARTIFACT_CHANGED");
  return { disposition: "created", path: target, temp, ...expected };
}
export function replaceManifestExact({ root, retainedRoot, bytes, expected }) {
  ordinaryDirectory(root);
  ordinaryDirectory(retainedRoot);
  const latest = join(root, "latest.json");
  assertPreimage(latest, expected);
  let retainedOld;
  if (expected.exists) {
    retainedOld = join(retainedRoot, `old-latest-${randomUUID()}.json`);
    copyFileSync(latest, retainedOld, constants.COPYFILE_EXCL);
    assert.deepEqual(
      fileFact(retainedOld),
      { bytes: expected.bytes, sha256: expected.sha256 },
      "OLD_LATEST_COPY_CHANGED",
    );
  }
  const temp = join(root, `.latest-${randomUUID()}.pending`);
  writeNewDurable(temp, bytes);
  requireThat(fileFact(temp).sha256 === hash(bytes), "MANIFEST_TEMP_CHANGED");
  assertPreimage(latest, expected);
  if (expected.exists) renameSync(temp, latest);
  else linkSync(temp, latest);
  requireThat(fileFact(latest).sha256 === hash(bytes), "LATEST_PUBLICATION_CHANGED");
  return {
    path: latest,
    temp,
    tempRetained: !expected.exists,
    retainedOld,
    before: expected,
    after: fileFact(latest),
  };
}
function oldMetadataAllowed(bytes) {
  requireThat(bytes.length <= 65536, "OLD_MANIFEST_TOO_LARGE");
  const value = JSON.parse(bytes.toString("utf8"));
  requireThat(
    value.schemaVersion === 1 &&
      value.channel === "preview" &&
      value.packageName === artifact.packageName &&
      Number.isSafeInteger(value.versionCode) &&
      value.versionCode > 0 &&
      value.versionCode <= 23,
    "OLD_MANIFEST_IDENTITY_OR_DOWNGRADE_REFUSED",
  );
  if (value.versionCode === 23)
    requireThat(value.sha256 === artifact.sha256, "EXISTING_CODE23_IDENTITY_DIFFERENT");
}
export function pinnedSourceFacts() {
  return Object.entries(sourcePins).map(([path, expected]) => {
    const actual = fileFact(join(sourceRoot, path));
    requireThat(actual.sha256 === expected, "APPROVED_SOURCE_CHANGED");
    return { path, ...actual };
  });
}
function configFromExplicit(path) {
  requireThat(
    process.platform === "win32" &&
      resolve(path ?? "").toLowerCase() === join(runtimeRoot, "instance.json").toLowerCase(),
    "EXACT_INSTANCE_REQUIRED",
  );
  const config = readParallelInstanceConfig(path);
  requireThat(
    config.instanceId === instanceId &&
      resolve(config.sourceRoot).toLowerCase() === sourceRoot.toLowerCase() &&
      resolve(config.runtimeRoot).toLowerCase() === runtimeRoot.toLowerCase() &&
      config.apiHost === "127.0.0.1" &&
      config.apiPort === 4419 &&
      config.webHost === "127.0.0.1" &&
      config.webPort === 4274,
    "PREVIEW_INSTANCE_BOUNDARY_CHANGED",
  );
  return config;
}
function distributionFiles(config) {
  const files = [
    join(config.downloadsRoot, oldApkName),
    join(config.downloadsRoot, oldApkName + ".receipt.json"),
    join(config.downloadsRoot, `${instanceId}-windows-latest.json`),
  ];
  const result = files.map((path) => ({ path, ...fileFact(path) }));
  requireThat(
    result[0].sha256 === "733088b8f876c41ce767627c6de8dfe12e00803c0b61ff13c6facd3b8982d777",
    "CODE22_CHANGED",
  );
  return result;
}
const originalApk = (config) =>
  join(
    config.runtimeRoot,
    "android-code23-recovery-65ee5dc8-3f23-4f28-ad97-daa1de8b0ece",
    "qa-hub-preview-code23.apk",
  );
function validateOriginProof() {
  const path = join(
    sourceRoot,
    "docs/evidence/project-components/android-code23-recovery-live/65ee5dc8-3f23-4f28-ad97-daa1de8b0ece/result.json",
  );
  requireThat(
    fileFact(path).sha256 === "5fe38d5fc111354e57763525b31c5705a04461627a3436e1bcb8580be586bc56",
    "CODE23_ORIGIN_PROOF_CHANGED",
  );
  const proof = JSON.parse(readFileSync(path, "utf8"));
  requireThat(
    proof.artifact.sha256 === artifact.sha256 &&
      proof.artifact.bytes === artifact.size &&
      proof.artifact.certificateSha256 === certificateSha256 &&
      proof.artifact.package === artifact.packageName &&
      proof.artifact.versionCode === artifact.versionCode &&
      proof.artifact.versionName === artifact.versionName,
    "CODE23_ORIGIN_IDENTITY_CHANGED",
  );
  return {
    path,
    ...fileFact(path),
    artifact: { ...artifact, certificateSha256 },
    signingVerification:
      "bound to identical bytes and retained prior apksigner/native proof; no new APK build or install",
  };
}
function gateDeployment(afterSha256) {
  requireThat(shaPattern.test(afterSha256), "EXPLICIT_APPROVED_AFTER_SHA_REQUIRED");
  const folder = join(
    sourceRoot,
    "docs/evidence/project-components/android-update-deployment-retention",
    deploymentId,
  );
  const afterPath = join(folder, "after.json"),
    beforePath = join(folder, "before.json");
  const afterFact = fileFact(afterPath),
    beforeFact = fileFact(beforePath);
  requireThat(afterFact.sha256 === afterSha256, "DEPLOYMENT_AFTER_APPROVAL_CHANGED");
  const after = JSON.parse(readFileSync(afterPath, "utf8")),
    before = JSON.parse(readFileSync(beforePath, "utf8"));
  validateDeploymentProofs({ before, after, beforePath, beforeSha256: beforeFact.sha256 });
  return {
    after,
    evidence: { runId: deploymentId, beforePath, before: beforeFact, afterPath, after: afterFact },
  };
}
export function validateDeploymentProofs({ before, after, beforePath, beforeSha256 }) {
  for (const [phase, value] of [
    ["before", before],
    ["after", after],
  ]) {
    requireThat(
      value.runId === deploymentId &&
        value.phase === phase &&
        value.status === "passed" &&
        value.checks.length > 0 &&
        value.checks.every((x) => x.passed === true),
      "DEPLOYMENT_PROOF_NOT_PASSED",
    );
    requireThat(
      value.runnerSha256 ===
        sourcePins["scripts/project-components/retain-preview-android-update-state.mjs"],
      "DEPLOYMENT_RUNNER_CHANGED",
    );
  }
  requireThat(
    after.beforeProof.sha256 === beforeSha256 && resolve(after.beforeProof.path) === beforePath,
    "DEPLOYMENT_BINDING_CHANGED",
  );
  requireThat(
    after.currentData.database.schemaVersion === 14 &&
      after.currentData.database.componentGate.enabledRows === 0,
    "DEPLOYMENT_COMPONENT_GATE_INVALID",
  );
  requireThat(
    after.checks.some(
      (x) => x.label === "FIVE_OTHER_ENTRIES_PRODUCTION_CONFIG_FEED_UNCHANGED" && x.passed,
    ) && after.checks.some((x) => x.label === "DATABASE_AND_FILES_UNCHANGED" && x.passed),
    "DEPLOYMENT_REQUIRED_CHECK_MISSING",
  );
}
function verifyCurrentApi(config, after) {
  const expected = after.observed.host.services.find((x) => x.service === "api");
  requireThat(expected?.pid > 0, "DEPLOYMENT_API_IDENTITY_MISSING");
  const script = String.raw`$ErrorActionPreference='Stop'
$taskSpec=$env:QA_CODE23_API_SPEC | ConvertFrom-Json
$taskReceipt=Get-Content -LiteralPath (Join-Path $taskSpec.logsRoot 'api-process.json') -Raw | ConvertFrom-Json
$taskProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskSpec.expected.pid)
if(-not $taskProcess -or $taskReceipt.instanceId -ne 'qa-hub-preview-7c86' -or $taskReceipt.service -ne 'api' -or $taskReceipt.pid -ne $taskSpec.expected.pid -or $taskProcess.ExecutablePath -ne $taskSpec.expected.executable -or $taskProcess.ExecutablePath -ne $taskReceipt.executable -or $taskProcess.CommandLine -ne $taskReceipt.commandLine -or $taskProcess.CreationDate.ToUniversalTime() -ne ([DateTime]$taskSpec.expected.createdAt).ToUniversalTime()){throw 'API_IDENTITY_CHANGED'}
$taskListeners=@(Get-NetTCPConnection -LocalPort 4419 -State Listen -ErrorAction Stop)
if($taskListeners.Count -lt 1 -or @($taskListeners | Where-Object {$_.OwningProcess -ne $taskProcess.ProcessId}).Count -gt 0){throw 'API_LISTENER_CHANGED'}
[pscustomobject]@{pid=$taskProcess.ProcessId;createdAt=$taskProcess.CreationDate.ToUniversalTime().ToString('o');executable=$taskProcess.ExecutablePath;receiptMatches=$true}|ConvertTo-Json -Compress`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      env: {
        ...process.env,
        QA_CODE23_API_SPEC: JSON.stringify({ logsRoot: config.logsRoot, expected }),
      },
    },
  );
  requireThat(result.status === 0, "CURRENT_API_IDENTITY_NOT_APPROVED");
  return JSON.parse(result.stdout);
}
const apiBase = "http://127.0.0.1:4419/api/v1/android-updates/preview/";
const webBase = `http://127.0.0.1:4274/downloads/android/${instanceId}/`;
const allowedUrls = new Set([
  ...[apiBase, webBase].flatMap((base) => [base + "latest.json", base + artifact.fileName]),
  `http://127.0.0.1:4274/downloads/${oldApkName}`,
  `http://127.0.0.1:4274/downloads/${instanceId}-windows-latest.json`,
  "http://127.0.0.1:4419/api/v1/android-updates/stable/latest.json",
]);
export async function readDistribution(
  url,
  { method = "GET", range, maxBytes = artifact.size } = {},
  ledger = [],
  fetcher = fetch,
) {
  requireThat(
    allowedUrls.has(url) &&
      ["GET", "HEAD"].includes(method) &&
      (range === undefined || range === "bytes=0-31"),
    "HTTP_DISTRIBUTION_READ_REFUSED",
  );
  const item = { url, method, range, startedAt: new Date().toISOString() };
  ledger.push(item);
  const response = await fetcher(url, {
    method,
    headers: { accept: "*/*", ...(range ? { range } : {}) },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    requireThat(bytes <= maxBytes, "HTTP_RESPONSE_TOO_LARGE");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  Object.assign(item, {
    completedAt: new Date().toISOString(),
    status: response.status,
    bytes: body.length,
    sha256: hash(body),
    headers: Object.fromEntries(
      [
        "content-type",
        "content-length",
        "content-range",
        "etag",
        "cache-control",
        "x-qa-hub-instance",
      ]
        .filter((key) => response.headers.has(key))
        .map((key) => [key, response.headers.get(key)]),
    ),
  });
  return { item, body };
}
async function verifyAnonymousPreimage(expected, ledger) {
  const { item, body } = await readDistribution(
    apiBase + "latest.json",
    { maxBytes: 65536 },
    ledger,
  );
  if (expected.exists) {
    requireThat(
      item.status === 200 && body.length === expected.bytes && hash(body) === expected.sha256,
      "ANONYMOUS_OLD_FEED_MISMATCH",
    );
  } else {
    requireThat(
      item.status === 404 && JSON.parse(body.toString()).code === "ANDROID_UPDATE_NOT_FOUND",
      "ANONYMOUS_PREVIEW_ROUTE_NOT_READY",
    );
  }
}
async function verifyPublication(config, plan, ledger) {
  for (const base of [apiBase, webBase]) {
    const manifest = await readDistribution(base + "latest.json", { maxBytes: 65536 }, ledger);
    requireThat(
      manifest.item.status === 200 && manifest.item.sha256 === plan.candidate.sha256,
      "HTTP_MANIFEST_READBACK_FAILED",
    );
    for (const name of ["latest.json", artifact.fileName]) {
      const head = await readDistribution(base + name, { method: "HEAD" }, ledger);
      requireThat(
        head.item.status === 200 &&
          head.body.length === 0 &&
          Number(head.item.headers["content-length"]) ===
            (name === "latest.json" ? plan.candidate.bytes : artifact.size),
        "HTTP_HEAD_READBACK_FAILED",
      );
    }
    const apk = await readDistribution(base + artifact.fileName, {}, ledger);
    requireThat(
      apk.item.status === 200 &&
        apk.body.length === artifact.size &&
        apk.item.sha256 === artifact.sha256 &&
        apk.item.headers["content-type"] === "application/vnd.android.package-archive",
      "HTTP_APK_READBACK_FAILED",
    );
    if (base === webBase)
      requireThat(apk.item.headers["x-qa-hub-instance"] === instanceId, "WEB_INSTANCE_CHANGED");
  }
  const range = await readDistribution(
    apiBase + artifact.fileName,
    { range: "bytes=0-31", maxBytes: 32 },
    ledger,
  );
  const original = readFileSync(originalApk(config)).subarray(0, 32);
  requireThat(
    range.item.status === 206 &&
      range.item.headers["content-range"] === `bytes 0-31/${artifact.size}` &&
      range.body.equals(original),
    "HTTP_RANGE_READBACK_FAILED",
  );
  const old = await readDistribution(
    `http://127.0.0.1:4274/downloads/${oldApkName}`,
    { maxBytes: 512 * 1024 * 1024 },
    ledger,
  );
  requireThat(
    old.item.status === 200 &&
      old.item.sha256 === plan.preserved[0].sha256 &&
      old.body.length === plan.preserved[0].bytes,
    "OLD_CODE22_HTTP_CHANGED",
  );
  const windows = await readDistribution(
    `http://127.0.0.1:4274/downloads/${instanceId}-windows-latest.json`,
    { maxBytes: 65536 },
    ledger,
  );
  requireThat(
    windows.item.status === 200 && windows.item.sha256 === plan.preserved[2].sha256,
    "WINDOWS_LATEST_HTTP_CHANGED",
  );
  const wrong = await readDistribution(
    "http://127.0.0.1:4419/api/v1/android-updates/stable/latest.json",
    { maxBytes: 65536 },
    ledger,
  );
  requireThat(
    wrong.item.status === 401 && JSON.parse(wrong.body.toString()).code === "UNAUTHENTICATED",
    "UNSELECTED_CHANNEL_AUTH_BOUNDARY_CHANGED",
  );
}
export async function main(args = process.argv.slice(2)) {
  if (!["--prepare", "--publish"].includes(args[0])) {
    console.log(JSON.stringify({ status: "not_run", runtimeReads: 0, writes: 0, httpRequests: 0 }));
    return;
  }
  const [mode, configPath, runId, ...approval] = args;
  requireThat(uuidPattern.test(runId ?? ""), "EXPLICIT_RUN_ID_REQUIRED");
  requireThat(
    (mode === "--prepare" &&
      approval.length === 1 &&
      (approval[0] === "absent" || shaPattern.test(approval[0]))) ||
      (mode === "--publish" && approval.length === 3 && approval.every((x) => shaPattern.test(x))),
    "EXPLICIT_APPROVAL_ARGUMENTS_REQUIRED",
  );
  if (mode === "--publish")
    requireThat(fileFact(scriptFile).sha256 === approval[0], "APPROVED_RUNNER_CHANGED");
  const config = configFromExplicit(configPath);
  const feedRoot = join(config.downloadsRoot, "android", instanceId);
  const acceptanceRoot = join(config.runtimeRoot, "acceptance", `android-code23-feed-${runId}`);
  const publicRoot = join(sourceRoot, proofRelative, runId);
  const planPath = join(acceptanceRoot, "prepare.json");
  const output = join(publicRoot, mode === "--prepare" ? "prepare.json" : "publish.json");
  requireThat(!existsSync(output), "PRIOR_PROOF_MUST_BE_PRESERVED");
  if (mode === "--prepare") {
    requireThat(!existsSync(acceptanceRoot) && !existsSync(publicRoot), "PREPARATION_RUN_EXISTS");
    ordinaryDirectory(join(config.runtimeRoot, "acceptance"));
    mkdirSync(acceptanceRoot);
  } else {
    ordinaryDirectory(acceptanceRoot);
    requireThat(fileFact(planPath).sha256 === approval[1], "APPROVED_PLAN_CHANGED");
  }
  mkdirSync(publicRoot, { recursive: true });
  const proof = {
    schemaVersion: 1,
    runId,
    mode,
    status: "running",
    startedAt: new Date().toISOString(),
    runnerSha256: fileFact(scriptFile).sha256,
    requests: [],
    boundaries: {
      productionPublisherUsed: false,
      servicesControlled: false,
      devicesOperated: false,
      apkRebuilt: false,
      rawCredentialsRead: false,
      nativeUpdateVerified: false,
    },
  };
  try {
    proof.sources = pinnedSourceFacts();
    proof.origin = validateOriginProof();
    const expectedArtifact = { bytes: artifact.size, sha256: artifact.sha256 };
    assert.deepEqual(fileFact(originalApk(config)), expectedArtifact, "ORIGINAL_CODE23_CHANGED");
    if (mode === "--prepare") {
      const latest = preimage(join(feedRoot, "latest.json"));
      requireThat(
        approval[0] === "absent" ? !latest.exists : latest.exists && latest.sha256 === approval[0],
        "APPROVED_OLD_LATEST_MISMATCH",
      );
      if (latest.exists) {
        oldMetadataAllowed(readFileSync(join(feedRoot, "latest.json")));
        copyFileSync(
          join(feedRoot, "latest.json"),
          join(acceptanceRoot, "prepared-old-latest.json"),
          constants.COPYFILE_EXCL,
        );
        assert.deepEqual(fileFact(join(acceptanceRoot, "prepared-old-latest.json")), {
          bytes: latest.bytes,
          sha256: latest.sha256,
        });
      }
      mkdirSync(join(acceptanceRoot, "candidate"));
      copyFileSync(
        originalApk(config),
        join(acceptanceRoot, "candidate", artifact.fileName),
        constants.COPYFILE_EXCL,
      );
      assert.deepEqual(
        fileFact(join(acceptanceRoot, "candidate", artifact.fileName)),
        expectedArtifact,
      );
      writeNewDurable(join(acceptanceRoot, "candidate", "latest.json"), manifestBytes());
      const preserved = distributionFiles(config);
      mkdirSync(join(acceptanceRoot, "preserved"));
      for (const item of preserved) {
        const retained = join(acceptanceRoot, "preserved", basename(item.path));
        copyFileSync(item.path, retained, constants.COPYFILE_EXCL);
        assert.deepEqual(
          fileFact(retained),
          { bytes: item.bytes, sha256: item.sha256 },
          "PRESERVED_DISTRIBUTION_COPY_CHANGED",
        );
      }
      proof.plan = {
        schemaVersion: 1,
        status: "prepared",
        runId,
        instanceId,
        runnerSha256: proof.runnerSha256,
        configuration: { path: configPath, ...fileFact(configPath) },
        sources: proof.sources,
        origin: proof.origin,
        feedRoot,
        acceptanceRoot,
        oldLatest: latest,
        originalFeedInventory: treeFacts(feedRoot),
        preserved,
        candidate: fileFact(join(acceptanceRoot, "candidate", "latest.json")),
        artifact: expectedArtifact,
        requiredDeploymentId: deploymentId,
      };
      assertPreimage(join(feedRoot, "latest.json"), latest);
      assert.deepEqual(distributionFiles(config), preserved);
      writeNewDurable(planPath, Buffer.from(JSON.stringify(proof.plan, null, 2) + "\n"));
      proof.planFile = { path: planPath, ...fileFact(planPath) };
      proof.status = "prepared_not_published";
    } else {
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      requireThat(
        plan.status === "prepared" &&
          plan.runId === runId &&
          plan.instanceId === instanceId &&
          plan.feedRoot === feedRoot &&
          plan.acceptanceRoot === acceptanceRoot &&
          plan.runnerSha256 === proof.runnerSha256,
        "PREPARED_PLAN_SCOPE_CHANGED",
      );
      assert.deepEqual(proof.sources, plan.sources, "SOURCE_PIN_SET_CHANGED");
      assert.deepEqual(
        fileFact(configPath),
        { bytes: plan.configuration.bytes, sha256: plan.configuration.sha256 },
        "INSTANCE_CONFIG_CHANGED",
      );
      assert.deepEqual(distributionFiles(config), plan.preserved, "PRIOR_DISTRIBUTION_CHANGED");
      for (const item of plan.preserved)
        assert.deepEqual(
          fileFact(join(acceptanceRoot, "preserved", basename(item.path))),
          { bytes: item.bytes, sha256: item.sha256 },
          "PRESERVED_DISTRIBUTION_COPY_CHANGED",
        );
      if (plan.oldLatest.exists)
        assert.deepEqual(
          fileFact(join(acceptanceRoot, "prepared-old-latest.json")),
          { bytes: plan.oldLatest.bytes, sha256: plan.oldLatest.sha256 },
          "PREPARED_OLD_MANIFEST_CHANGED",
        );
      assert.deepEqual(
        treeFacts(feedRoot),
        plan.originalFeedInventory,
        "FEED_CHANGED_SINCE_PREPARATION",
      );
      assert.deepEqual(
        fileFact(join(acceptanceRoot, "candidate", "latest.json")),
        plan.candidate,
        "CANDIDATE_MANIFEST_CHANGED",
      );
      requireThat(
        readFileSync(join(acceptanceRoot, "candidate", "latest.json")).equals(manifestBytes()),
        "MANIFEST_NOT_FIXED_CODE23",
      );
      const gate = gateDeployment(approval[2]);
      proof.deployment = gate.evidence;
      proof.apiBefore = verifyCurrentApi(config, gate.after);
      const database = databaseFacts(join(config.dataRoot, "db", "qa-hub.sqlite"));
      requireThat(
        database.schemaVersion === 14 && database.componentGate.enabledRows === 0,
        "CURRENT_COMPONENTS_NOT_OFF",
      );
      proof.componentGate = database.componentGate;
      await verifyAnonymousPreimage(plan.oldLatest, proof.requests);
      assertPreimage(join(feedRoot, "latest.json"), plan.oldLatest);
      mkdirSync(feedRoot, { recursive: true });
      ordinaryDirectory(feedRoot);
      const lock = join(feedRoot, ".code23-publication.lock");
      writeNewDurable(
        lock,
        Buffer.from(
          JSON.stringify({
            runId,
            runnerSha256: proof.runnerSha256,
            approvedPlanSha256: approval[1],
            approvedAfterSha256: approval[2],
            createdAt: new Date().toISOString(),
          }) + "\n",
        ),
      );
      proof.lock = { path: lock, ...fileFact(lock), retained: true };
      proof.apkPublication = installImmutableFile(
        join(acceptanceRoot, "candidate", artifact.fileName),
        feedRoot,
        artifact.fileName,
        expectedArtifact,
      );
      assert.deepEqual(
        distributionFiles(config),
        plan.preserved,
        "PRIOR_DISTRIBUTION_CHANGED_BEFORE_LATEST",
      );
      proof.latestPublication = replaceManifestExact({
        root: feedRoot,
        retainedRoot: acceptanceRoot,
        bytes: manifestBytes(),
        expected: plan.oldLatest,
      });
      await verifyPublication(config, plan, proof.requests);
      assert.deepEqual(
        distributionFiles(config),
        plan.preserved,
        "PRIOR_DISTRIBUTION_CHANGED_AFTER_LATEST",
      );
      proof.apiAfter = verifyCurrentApi(config, gate.after);
      assert.deepEqual(proof.apiAfter, proof.apiBefore, "API_CHANGED_DURING_PUBLICATION");
      proof.status = "published_and_http_readback_verified";
    }
  } catch (error) {
    proof.status = "failed_retained";
    proof.failure = {
      name: error.name,
      code: /^[A-Z0-9_]+$/u.test(error.message ?? "")
        ? error.message
        : "PUBLICATION_IO_OR_ASSERTION_FAILED",
    };
  } finally {
    proof.completedAt = new Date().toISOString();
    writeNewDurable(output, Buffer.from(JSON.stringify(proof, null, 2) + "\n"));
    console.log(
      JSON.stringify({
        status: proof.status,
        proof: output,
        sha256: fileFact(output).sha256,
        requests: proof.requests.length,
      }),
    );
    if (proof.status === "failed_retained") process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === scriptFile)
  main().catch(() => {
    console.error("CODE23_ARGUMENT_OR_SETUP_REFUSED");
    process.exitCode = 1;
  });
