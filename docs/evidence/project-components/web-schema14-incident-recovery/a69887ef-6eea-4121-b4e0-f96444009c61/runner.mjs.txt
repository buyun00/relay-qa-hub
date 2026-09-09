import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installAssets, mergedInventory, switchIndex } from "./publish-preview-web-detail-fix.mjs";
import {
  copyTreeCreateOnly,
  fileFact,
  hash,
  treeFacts,
} from "./retain-preview-android-update-state.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(scriptFile), "../..");
const instanceId = "qa-hub-preview-7c86";
const runtimeRoot = join(homedir(), ".codex", "parallel-runtimes", instanceId);
const instanceFile = join(runtimeRoot, "instance.json");
const servedRoot = join(sourceRoot, "apps", "web", "dist");
const baselineRoot = join(runtimeRoot, "packages", "20260909T011704801Z", "stage", "web");
const proofRoot = join(
  sourceRoot,
  "docs",
  "evidence",
  "project-components",
  "web-schema14-incident-recovery",
);
const expected = {
  configSha256: "2b8e97ce9b62d072b74eaf00015fb04f5b818d318203f2a91e59d15873da349b",
  currentTreeSha256: "66dc6d536b2a0ee8090f74238cdc1f10a78000b38f7df504ccfa7e34152a077e",
  currentIndexSha256: "fd4c17ac45cd033dd1c9bd3833da3f90553da0402bf23b367d31f41edb75433e",
  baselineTreeSha256: "627aadb2d6ac087b80e7929eb3b1d31f3555d85babcd147c0bd074a508dfc2c0",
  baselineIndexSha256: "22203c14cade9462e21d31b42beb2103c6c1ecabb1ebc2af00aa316968ff7367",
};
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const shaPattern = /^[a-f0-9]{64}$/u;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function need(condition, code) {
  if (!condition) throw new Error(code);
}

function equal(actual, wanted, code) {
  try {
    assert.deepEqual(actual, wanted);
  } catch {
    throw new Error(code);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
}

function ordinaryDirectory(path) {
  const stat = lstatSync(path);
  need(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      resolve(realpathSync.native(path)).toLowerCase() === resolve(path).toLowerCase(),
    "DIRECTORY_SCOPE_REFUSED",
  );
}

function mkdirNew(path) {
  ordinaryDirectory(dirname(path));
  mkdirSync(path);
  ordinaryDirectory(path);
}

function ensureParent(path) {
  if (existsSync(path)) {
    ordinaryDirectory(path);
    return;
  }
  ensureParent(dirname(path));
  mkdirNew(path);
}

function durableNew(path, bytes) {
  ordinaryDirectory(dirname(path));
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function locations(runId) {
  need(uuidPattern.test(runId), "RUN_ID_REFUSED");
  return {
    privateRun: join(runtimeRoot, "acceptance", `web-schema14-incident-recovery-${runId}`),
    publicRun: join(proofRoot, runId),
  };
}

function scope(configPath) {
  need(process.platform === "win32", "WINDOWS_REQUIRED");
  need(
    resolve(sourceRoot).toLowerCase() ===
      resolve(homedir(), ".codex", "worktrees", "7c86", "Relay-QA-Hub").toLowerCase(),
    "WORKTREE_REFUSED",
  );
  need(resolve(configPath) === resolve(instanceFile), "INSTANCE_PATH_REFUSED");
  need(fileFact(instanceFile).sha256 === expected.configSha256, "INSTANCE_PREIMAGE_CHANGED");
  const config = readJson(instanceFile);
  need(
    config.instanceId === instanceId &&
      config.webHost === "127.0.0.1" &&
      config.webPort === 4274 &&
      config.apiHost === "127.0.0.1" &&
      config.apiPort === 4419 &&
      resolve(config.sourceRoot) === sourceRoot &&
      resolve(config.runtimeRoot) === runtimeRoot,
    "INSTANCE_SCOPE_REFUSED",
  );
  for (const folder of [runtimeRoot, join(runtimeRoot, "acceptance"), servedRoot, baselineRoot])
    ordinaryDirectory(folder);
  return config;
}

function webIdentity() {
  const receiptPath = join(runtimeRoot, "logs", "web-process.json");
  const receipt = readJson(receiptPath);
  need(
    receipt.service === "web" &&
      receipt.instanceId === instanceId &&
      Number.isSafeInteger(receipt.pid) &&
      receipt.pid > 0,
    "WEB_RECEIPT_REFUSED",
  );
  const code = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${receipt.pid}'; if(-not $p){throw 'WEB_PROCESS_MISSING'}; $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 4274 -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique); [ordered]@{pid=[int]$p.ProcessId; createdAt=$p.CreationDate.ToUniversalTime().ToString('o'); executable=$p.ExecutablePath; commandLine=$p.CommandLine; listeners=$listeners} | ConvertTo-Json -Compress`;
  const queried = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
  need(queried.status === 0, "WEB_IDENTITY_QUERY_FAILED");
  const actual = JSON.parse(queried.stdout);
  need(
    actual.pid === receipt.pid &&
      new Date(actual.createdAt).getTime() === new Date(receipt.createdAt).getTime() &&
      actual.executable === receipt.executable &&
      actual.commandLine === receipt.commandLine,
    "WEB_PROCESS_IDENTITY_CHANGED",
  );
  equal(actual.listeners, [receipt.pid], "WEB_LISTENER_OWNER_CHANGED");
  need(actual.commandLine && typeof actual.commandLine === "string", "WEB_COMMAND_MISSING");
  const args = [...actual.commandLine.matchAll(/"([^"]*)"|(\S+)/gu)].map(
    (match) => match[1] ?? match[2],
  );
  equal(
    args.map((value, index) => (index < 3 ? resolve(value).toLowerCase() : value)),
    [
      actual.executable,
      join(sourceRoot, "scripts", "project-components", "run-preview-service.mjs"),
      instanceFile,
    ]
      .map((value) => resolve(value).toLowerCase())
      .concat("web"),
    "WEB_COMMAND_SCOPE_CHANGED",
  );
  return {
    pid: actual.pid,
    createdAt: actual.createdAt,
    executable: actual.executable,
    commandLineSha256: hash(actual.commandLine),
    receipt: fileFact(receiptPath),
    port: 4274,
  };
}

function assertPinnedTrees() {
  const current = treeFacts(servedRoot);
  const baseline = treeFacts(baselineRoot);
  need(
    current.exists &&
      current.count === 8 &&
      current.sha256 === expected.currentTreeSha256 &&
      current.files.find((entry) => entry.path === "index.html")?.sha256 ===
        expected.currentIndexSha256,
    "CURRENT_CANDIDATE_TREE_CHANGED",
  );
  need(
    baseline.exists &&
      baseline.count === 8 &&
      baseline.sha256 === expected.baselineTreeSha256 &&
      baseline.files.find((entry) => entry.path === "index.html")?.sha256 ===
        expected.baselineIndexSha256,
    "BASELINE_TREE_CHANGED",
  );
  return { current, baseline };
}

async function apiReadiness() {
  const response = await fetch("http://127.0.0.1:4419/api/v1/health/ready", {
    headers: { "cache-control": "no-cache" },
  });
  need(response.status === 200, "PREVIEW_API_NOT_READY");
  const body = await response.json();
  need(body.status === "ready" && body.schemaVersion === "14", "PREVIEW_API_SCHEMA_CHANGED");
  return { status: response.status, body };
}

async function verifyHttp(files, phase) {
  const requests = [];
  for (const entry of files) {
    const url = `http://127.0.0.1:4274/${entry.path}`;
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(url, { method, headers: { "cache-control": "no-cache" } });
      const body = Buffer.from(await response.arrayBuffer());
      const observed = {
        phase,
        method,
        path: entry.path,
        status: response.status,
        bytes: body.length,
        sha256: hash(body),
        contentLength: response.headers.get("content-length"),
        instance: response.headers.get("x-qa-hub-instance"),
        observedAt: new Date().toISOString(),
      };
      requests.push(observed);
      need(response.status === 200, "WEB_HTTP_STATUS_CHANGED");
      need(observed.instance === instanceId, "WEB_INSTANCE_HEADER_CHANGED");
      need(Number(observed.contentLength) === entry.bytes, "WEB_CONTENT_LENGTH_CHANGED");
      if (method === "GET") {
        need(
          observed.bytes === entry.bytes && observed.sha256 === entry.sha256,
          "WEB_BODY_CHANGED",
        );
      } else {
        need(
          observed.bytes === 0 && observed.sha256 === hash(Buffer.alloc(0)),
          "WEB_HEAD_BODY_CHANGED",
        );
      }
    }
  }
  return requests;
}

async function prepare(configPath, runId) {
  scope(configPath);
  const roots = locations(runId);
  need(!existsSync(roots.privateRun) && !existsSync(roots.publicRun), "RUN_ALREADY_EXISTS");
  ensureParent(proofRoot);
  mkdirNew(roots.privateRun);
  mkdirNew(roots.publicRun);
  const record = {
    schemaVersion: 1,
    runId,
    status: "preparing",
    startedAt: new Date().toISOString(),
    scope: {
      instanceId,
      sourceRoot,
      runtimeRoot,
      servedRoot,
      baselineRoot,
      productionReads: 0,
      serviceOperations: 0,
      servedWrites: 0,
      builds: 0,
    },
  };
  try {
    const trees = assertPinnedTrees();
    record.webBefore = webIdentity();
    record.apiBefore = await apiReadiness();
    record.currentHttp = await verifyHttp(trees.current.files, "candidate_preimage");
    record.current = trees.current;
    record.baseline = trees.baseline;
    record.currentRetention = copyTreeCreateOnly(
      servedRoot,
      join(roots.privateRun, "candidate-dist-before-recovery"),
      trees.current,
    );
    record.baselineRetention = copyTreeCreateOnly(
      baselineRoot,
      join(roots.privateRun, "verified-schema14-baseline"),
      trees.baseline,
    );
    copyFileSync(scriptFile, join(roots.privateRun, "runner.mjs.txt"), constants.COPYFILE_EXCL);
    copyFileSync(scriptFile, join(roots.publicRun, "runner.mjs.txt"), constants.COPYFILE_EXCL);
    equal(webIdentity(), record.webBefore, "WEB_CHANGED_DURING_PREPARE");
    equal(treeFacts(servedRoot), trees.current, "SERVED_TREE_CHANGED_DURING_PREPARE");
    record.runner = fileFact(scriptFile);
    record.status = "prepared_candidate_retained_not_recovered";
    record.completedAt = new Date().toISOString();
    durableNew(join(roots.privateRun, "plan.json"), json(record));
    record.plan = fileFact(join(roots.privateRun, "plan.json"));
  } catch (error) {
    record.status = "failed_retained";
    record.error = error instanceof Error ? error.message.slice(0, 160) : "PREPARE_FAILED";
    record.completedAt = new Date().toISOString();
    throw error;
  } finally {
    durableNew(join(roots.publicRun, "prepare.json"), json(record));
  }
  console.log(
    json({
      status: record.status,
      runId,
      runnerSha256: record.runner.sha256,
      planSha256: record.plan.sha256,
      privateRun: roots.privateRun,
      publicRun: roots.publicRun,
    }).trim(),
  );
}

async function recover(configPath, runId, runnerSha, planSha) {
  scope(configPath);
  need(shaPattern.test(runnerSha) && shaPattern.test(planSha), "APPROVAL_SHA_REFUSED");
  const roots = locations(runId);
  ordinaryDirectory(roots.privateRun);
  ordinaryDirectory(roots.publicRun);
  const planPath = join(roots.privateRun, "plan.json");
  need(fileFact(scriptFile).sha256 === runnerSha, "RUNNER_CHANGED");
  need(
    fileFact(join(roots.privateRun, "runner.mjs.txt")).sha256 === runnerSha,
    "RUNNER_COPY_CHANGED",
  );
  need(fileFact(planPath).sha256 === planSha, "PLAN_CHANGED");
  const plan = readJson(planPath);
  need(
    plan.runId === runId && plan.status === "prepared_candidate_retained_not_recovered",
    "PREPARED_PLAN_REQUIRED",
  );
  const currentSnapshot = join(roots.privateRun, "candidate-dist-before-recovery");
  const baselineSnapshot = join(roots.privateRun, "verified-schema14-baseline");
  equal(
    { sourceExisted: true, ...treeFacts(currentSnapshot) },
    plan.currentRetention,
    "CURRENT_RETENTION_CHANGED",
  );
  equal(
    { sourceExisted: true, ...treeFacts(baselineSnapshot) },
    plan.baselineRetention,
    "BASELINE_RETENTION_CHANGED",
  );
  equal(treeFacts(servedRoot), plan.current, "SERVED_PREIMAGE_CHANGED");
  equal(treeFacts(baselineRoot), plan.baseline, "BASELINE_SOURCE_CHANGED");
  const lock = join(runtimeRoot, "acceptance", `.web-schema14-incident-recovery-${runId}.lock`);
  need(!existsSync(join(roots.publicRun, "recovery.json")), "RECOVERY_ALREADY_RECORDED");
  durableNew(
    lock,
    json({
      runId,
      mode: "recover",
      runnerSha256: runnerSha,
      planSha256: planSha,
      createdAt: new Date().toISOString(),
    }),
  );
  const scratch = join(roots.privateRun, "recovery-pending");
  mkdirNew(scratch);
  const record = {
    schemaVersion: 1,
    runId,
    status: "recovering",
    startedAt: new Date().toISOString(),
    runnerSha256: runnerSha,
    planSha256: planSha,
    retainedLock: lock,
    boundaries: {
      builds: 0,
      serviceOperations: 0,
      productionReads: 0,
      filesDeleted: 0,
      candidateSnapshotRetained: true,
      mutableServedFile: "index.html",
    },
    requests: [],
  };
  try {
    record.webBefore = webIdentity();
    equal(record.webBefore, plan.webBefore, "WEB_CHANGED_SINCE_PREPARE");
    record.apiBefore = await apiReadiness();
    record.requests.push(...(await verifyHttp(plan.current.files, "candidate_before_recovery")));
    installAssets(baselineSnapshot, servedRoot, scratch, plan.baseline.files);
    const beforeSwitch = mergedInventory(plan.current.files, plan.baseline.files, true);
    equal(treeFacts(servedRoot).files, beforeSwitch, "ASSET_INSTALL_TREE_CHANGED");
    equal(webIdentity(), record.webBefore, "WEB_CHANGED_BEFORE_INDEX_SWITCH");
    switchIndex(
      join(baselineSnapshot, "index.html"),
      servedRoot,
      scratch,
      { bytes: 709, sha256: expected.currentIndexSha256 },
      { bytes: 709, sha256: expected.baselineIndexSha256 },
    );
    record.indexSwitched = true;
    const afterFiles = mergedInventory(plan.current.files, plan.baseline.files);
    equal(treeFacts(servedRoot).files, afterFiles, "RECOVERED_TREE_CHANGED");
    record.requests.push(...(await verifyHttp(afterFiles, "schema14_baseline_after_recovery")));
    record.apiAfter = await apiReadiness();
    record.webAfter = webIdentity();
    equal(record.webAfter, record.webBefore, "WEB_CHANGED_DURING_RECOVERY");
    equal(
      { sourceExisted: true, ...treeFacts(currentSnapshot) },
      plan.currentRetention,
      "CURRENT_RETENTION_CHANGED_AFTER_RECOVERY",
    );
    equal(
      { sourceExisted: true, ...treeFacts(baselineSnapshot) },
      plan.baselineRetention,
      "BASELINE_RETENTION_CHANGED_AFTER_RECOVERY",
    );
    record.servedAfter = treeFacts(servedRoot);
    record.status = "schema14_baseline_restored_candidate_retained_verified";
  } catch (error) {
    record.status = "failed_retained";
    record.error = error instanceof Error ? error.message.slice(0, 160) : "RECOVERY_FAILED";
    throw error;
  } finally {
    record.completedAt = new Date().toISOString();
    durableNew(join(roots.publicRun, "recovery.json"), json(record));
  }
  console.log(
    json({
      status: record.status,
      runId,
      requests: record.requests.length,
      proof: join(roots.publicRun, "recovery.json"),
    }).trim(),
  );
}

async function cli(args) {
  if (!args.length) {
    console.log(
      json({
        status: "not_run",
        reads: 0,
        writes: 0,
        http: 0,
        serviceOperations: 0,
        usage: "--prepare INSTANCE UUID | --recover INSTANCE UUID RUNNER_SHA PLAN_SHA",
      }).trim(),
    );
    return;
  }
  const [mode, configPath, runId, runnerSha, planSha] = args;
  need(mode === "--prepare" || mode === "--recover", "MODE_REFUSED");
  need(args.length === (mode === "--prepare" ? 3 : 5), "ARGUMENTS_REFUSED");
  if (mode === "--prepare") await prepare(configPath, runId);
  else await recover(configPath, runId, runnerSha, planSha);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptFile)) {
  cli(process.argv.slice(2)).catch((error) => {
    console.error(
      json({
        status: "failed_retained",
        error: error instanceof Error ? error.message.slice(0, 160) : "RECOVERY_RUNNER_FAILED",
      }).trim(),
    );
    process.exitCode = 1;
  });
}
