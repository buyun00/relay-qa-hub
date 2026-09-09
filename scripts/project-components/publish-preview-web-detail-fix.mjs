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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyTreeCreateOnly,
  fileFact,
  hash,
  treeFacts,
} from "./retain-preview-android-update-state.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(scriptFile), "../..");
const instanceId = "qa-hub-preview-7c86";
const runtimeRoot = join(homedir(), ".codex/parallel-runtimes", instanceId);
const instanceFile = join(runtimeRoot, "instance.json");
const servedRoot = join(sourceRoot, "apps/web/dist");
const packageRunId = "7ed02aa0-3669-4f85-932a-2cf3ed0eadaf";
const packageRoot = join(runtimeRoot, "acceptance", `exe-preview9-package-only-${packageRunId}`);
const inputRoot = join(packageRoot, "web-dist");
const proofRelative = "docs/evidence/project-components/web-detail-fix-publication";
const packageProof = "docs/evidence/project-components/exe-preview9-package-only";
export const sourceCommit = "bc2b347dae282212a9119e5411b17fe144ca758c";
const pins = {
  [`${packageProof}/prepared.json`]:
    "ae86788cfa46d11ffd8ff37674ad2b558782caec809437ab1ef642bf45dda220",
  [`${packageProof}/build-result.json`]:
    "d7804189e974ee3dad2fa3864a9d60220ef54cfa7a977959220197e7db809fe0",
  [`${packageProof}/result.json`]:
    "48b9ca590887cc76339677ea86f7e326d5cadb4abcace677c81c707c18849837",
  "docs/evidence/project-components/web-detail-loading-fix.json":
    "1e2cc70ef1797eed139521a9ba36af8303695cf19abf1917bad168276f4d3042",
  "scripts/project-components/preview-web.mjs":
    "5b4f19b93fdd515c529f45ecee3091e50d08929ea1981963e4774d93ce4ba982",
  "scripts/project-components/run-preview-service.mjs":
    "02f2bc79611c6e8a13c60b35e03d1e75ad87686a81e67f7a3ef81bc13072b833",
  "scripts/project-components/retain-preview-android-update-state.mjs":
    "669042c8c82307d02bd291e9de99b1ddc5af86694a83425158bd55ee35c000f3",
};
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const shaPattern = /^[a-f0-9]{64}$/u;
const json = (value) => JSON.stringify(value, null, 2) + "\n";
function need(condition, code) {
  if (!condition) throw new Error(code);
}
function equal(actual, expected, code) {
  need(JSON.stringify(actual) === JSON.stringify(expected), code);
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
    "DIRECTORY_LINK_REFUSED",
  );
}
function mkdirNew(path) {
  ordinaryDirectory(dirname(path));
  mkdirSync(path);
  ordinaryDirectory(path);
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
function factOnly(entry) {
  return { bytes: entry.bytes, sha256: entry.sha256 };
}
export function safeFile(root, path) {
  need(
    typeof path === "string" &&
      /^[a-zA-Z0-9_./-]+$/u.test(path) &&
      !isAbsolute(path) &&
      !path.includes("\\") &&
      path.split("/").every((part) => part && part !== "." && part !== ".."),
    "FILE_PATH_REFUSED",
  );
  const result = resolve(root, path);
  need(!relative(root, result).startsWith("..") && result !== resolve(root), "FILE_PATH_ESCAPE");
  return result;
}
export function validateInventory(files, count) {
  need(Array.isArray(files) && files.length === count && count > 0, "INVENTORY_COUNT_MISMATCH");
  const seen = new Set();
  for (const entry of files) {
    safeFile(process.cwd(), entry.path);
    need(!seen.has(entry.path.toLowerCase()), "INVENTORY_DUPLICATE");
    seen.add(entry.path.toLowerCase());
    need(
      Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && shaPattern.test(entry.sha256),
      "INVENTORY_FACT_INVALID",
    );
  }
  need(seen.has("index.html"), "INDEX_REQUIRED");
}
function assertTree(root, files) {
  equal(treeFacts(root).files, files, "TREE_PREIMAGE_CHANGED");
}
export function mergedInventory(oldFiles, newFiles, restore = false) {
  validateInventory(oldFiles, oldFiles.length);
  validateInventory(newFiles, newFiles.length);
  const combined = new Map(oldFiles.map((entry) => [entry.path, entry]));
  for (const entry of newFiles) {
    const previous = combined.get(entry.path);
    if (previous && entry.path !== "index.html") equal(previous, entry, "MUTABLE_ASSET_COLLISION");
    if (!(restore && entry.path === "index.html")) combined.set(entry.path, entry);
  }
  return [...combined.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
}
// Immutable assets are installed without overwriting. Retained pending files are outside servedRoot.
export function installAssets(candidate, target, scratch, files) {
  ordinaryDirectory(target);
  ordinaryDirectory(scratch);
  for (const entry of files.filter((item) => item.path !== "index.html")) {
    const from = safeFile(candidate, entry.path);
    equal(fileFact(from), factOnly(entry), "CANDIDATE_FILE_CHANGED");
    const destination = safeFile(target, entry.path);
    if (existsSync(destination)) {
      equal(fileFact(destination), factOnly(entry), "EXISTING_ASSET_DIFFERENT");
      continue;
    }
    // Pinned candidate only uses existing assets/icons folders; no new directory writes to servedRoot.
    ordinaryDirectory(dirname(destination));
    const temporary = join(scratch, `asset-${randomUUID()}.pending`);
    durableNew(temporary, readFileSync(from));
    equal(fileFact(temporary), factOnly(entry), "ASSET_COPY_CHANGED");
    linkSync(temporary, destination); // EEXIST is an error, never replace an unrelated writer's file.
    equal(fileFact(destination), factOnly(entry), "INSTALLED_ASSET_CHANGED");
  }
}
export function switchIndex(candidateIndex, target, scratch, before, after) {
  ordinaryDirectory(target);
  ordinaryDirectory(scratch);
  const destination = join(target, "index.html");
  equal(fileFact(candidateIndex), after, "INDEX_CANDIDATE_CHANGED");
  equal(fileFact(destination), before, "INDEX_PREIMAGE_CHANGED");
  const temporary = join(scratch, `index-${randomUUID()}.pending`);
  durableNew(temporary, readFileSync(candidateIndex));
  equal(fileFact(temporary), after, "INDEX_COPY_CHANGED");
  equal(fileFact(destination), before, "INDEX_PREIMAGE_CHANGED");
  // Same C: volume, atomic file replacement; no copy fallback or automatic retry.
  renameSync(temporary, destination);
  equal(fileFact(destination), after, "INDEX_READBACK_CHANGED");
}
function git(args) {
  const result = spawnSync("git", args, {
    cwd: sourceRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
  need(result.status === 0, "SOURCE_GIT_CHECK_FAILED");
  return result.stdout.trim();
}
function sourceSnapshot() {
  const checkedPins = Object.entries(pins).map(([path, sha256]) => {
    const actual = fileFact(join(sourceRoot, path));
    need(actual.sha256 === sha256, "PINNED_SOURCE_OR_PROOF_CHANGED");
    return { path, ...actual };
  });
  const fix = readJson(
    join(sourceRoot, "docs/evidence/project-components/web-detail-loading-fix.json"),
  );
  for (const source of fix.sources)
    need(fileFact(join(sourceRoot, source.path)).sha256 === source.sha256, "FIX_SOURCE_CHANGED");
  git([
    "diff",
    "--exit-code",
    sourceCommit,
    "--",
    "apps/web/src",
    "apps/web/package.json",
    "apps/web/vite.config.ts",
    "package-lock.json",
    "packages/shared/src",
  ]);
  return {
    checkedPins,
    webSource: treeFacts(join(sourceRoot, "apps/web/src")),
    sharedSource: treeFacts(join(sourceRoot, "packages/shared/src")),
    fixSources: fix.sources,
    config: fileFact(instanceFile),
    script: fileFact(scriptFile),
  };
}
function packageInventory() {
  const prepared = readJson(join(sourceRoot, packageProof, "prepared.json"));
  const built = readJson(join(sourceRoot, packageProof, "build-result.json"));
  const result = readJson(join(sourceRoot, packageProof, "result.json"));
  need(
    [prepared, built, result].every(
      (value) => value.sourceCommit === sourceCommit && value.runId === packageRunId,
    ),
    "PACKAGE_LINEAGE_CHANGED",
  );
  need(
    built.status === "packaged_verified_not_published" &&
      result.checks.passed === 29 &&
      result.checks.total === 29,
    "PACKAGE_GATE_FAILED",
  );
  need(built.preparedSha256 === pins[`${packageProof}/prepared.json`], "PACKAGE_CHAIN_CHANGED");
  need(resolve(prepared.webDist) === resolve(inputRoot), "PACKAGE_INPUT_PATH_CHANGED");
  const oldFiles = built.before.webDist;
  const newFiles = built.webDist;
  validateInventory(oldFiles, 10);
  validateInventory(newFiles, 8);
  equal(oldFiles, built.after.webDist, "PACKAGE_CHANGED_SERVED_WEB");
  equal(oldFiles, prepared.before.webDist, "PACKAGE_PREIMAGE_CHANGED");
  mergedInventory(oldFiles, newFiles);
  return { oldFiles, newFiles };
}
function scope(configPath) {
  need(
    process.platform === "win32" &&
      resolve(sourceRoot).toLowerCase() ===
        resolve(homedir(), ".codex/worktrees/7c86/Relay-QA-Hub").toLowerCase(),
    "WORKTREE_REFUSED",
  );
  need(resolve(configPath) === resolve(instanceFile), "INSTANCE_PATH_REFUSED");
  const fact = fileFact(instanceFile);
  need(
    fact.sha256 === "2b8e97ce9b62d072b74eaf00015fb04f5b818d318203f2a91e59d15873da349b",
    "INSTANCE_PREIMAGE_CHANGED",
  );
  const config = readJson(instanceFile);
  need(
    config.instanceId === instanceId &&
      config.webHost === "127.0.0.1" &&
      config.webPort === 4274 &&
      config.apiPort === 4419 &&
      resolve(config.sourceRoot) === sourceRoot &&
      resolve(config.runtimeRoot) === runtimeRoot &&
      resolve(config.logsRoot) === join(runtimeRoot, "logs"),
    "INSTANCE_SCOPE_REFUSED",
  );
  for (const folder of [runtimeRoot, join(runtimeRoot, "acceptance"), servedRoot, inputRoot])
    ordinaryDirectory(folder);
  return config;
}
function webIdentity() {
  const receipt = readJson(join(runtimeRoot, "logs/web-process.json"));
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
  const args = [...actual.commandLine.matchAll(/"([^"]*)"|(\S+)/gu)].map(
    (match) => match[1] ?? match[2],
  );
  equal(
    args.map((value, index) => (index < 3 ? resolve(value).toLowerCase() : value)),
    [
      actual.executable,
      join(sourceRoot, "scripts/project-components/run-preview-service.mjs"),
      instanceFile,
    ]
      .map((value) => resolve(value).toLowerCase())
      .concat("web"),
    "WEB_COMMAND_SCOPE_CHANGED",
  );
  // Raw command line is never persisted; equality to the manager receipt is verified in memory.
  return {
    pid: actual.pid,
    createdAt: actual.createdAt,
    executable: actual.executable,
    commandLineSha256: hash(actual.commandLine),
    port: 4274,
    receiptSha256: fileFact(join(runtimeRoot, "logs/web-process.json")).sha256,
  };
}
async function verifyHttp(files, ledger) {
  for (const entry of files)
    for (const method of ["GET", "HEAD"]) {
      const url = `http://127.0.0.1:4274/${entry.path}`;
      const record = { method, path: `/${entry.path}`, startedAt: new Date().toISOString() };
      ledger.push(record);
      const response = await fetch(url, {
        method,
        redirect: "error",
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(15000),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      Object.assign(record, {
        status: response.status,
        completedAt: new Date().toISOString(),
        headers: Object.fromEntries(
          ["content-length", "content-type", "cache-control", "x-qa-hub-instance"].map((key) => [
            key,
            response.headers.get(key),
          ]),
        ),
        receivedBytes: bytes.length,
        ...(method === "GET" ? { sha256: hash(bytes) } : {}),
      });
      need(
        response.status === 200 &&
          response.headers.get("x-qa-hub-instance") === instanceId &&
          response.headers.get("cache-control") === "no-store" &&
          Number(response.headers.get("content-length")) === entry.bytes,
        "STATIC_HTTP_HEADERS_CHANGED",
      );
      if (method === "GET")
        equal(
          { bytes: bytes.length, sha256: hash(bytes) },
          factOnly(entry),
          "STATIC_HTTP_BYTES_CHANGED",
        );
      else need(bytes.length === 0, "HEAD_BODY_REFUSED");
    }
}
function locations(runId) {
  need(uuidPattern.test(runId), "RUN_ID_REFUSED");
  return {
    acceptance: join(runtimeRoot, "acceptance", `web-detail-fix-publication-${runId}`),
    proof: join(sourceRoot, proofRelative, runId),
  };
}
function createProofFolder(path) {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirNew(parent);
  mkdirNew(path);
}
async function cli(args) {
  if (!args.length) {
    console.log(
      json({
        status: "not_run",
        reads: 0,
        writes: 0,
        http: 0,
        builds: 0,
        serviceOperations: 0,
        usage:
          "--prepare INSTANCE UUID | --deploy INSTANCE UUID RUNNER_SHA PLAN_SHA | --restore-index INSTANCE UUID RUNNER_SHA PLAN_SHA DEPLOY_PROOF_SHA",
      }).trim(),
    );
    return;
  }
  const [mode, configPath, runId, runnerSha, planSha, deploymentSha] = args;
  need(["--prepare", "--deploy", "--restore-index"].includes(mode), "MODE_REFUSED");
  need(
    args.length === (mode === "--prepare" ? 3 : mode === "--deploy" ? 5 : 6),
    "ARGUMENTS_REFUSED",
  );
  scope(configPath);
  const roots = locations(runId);
  const before = sourceSnapshot();
  const inventory = packageInventory();
  const oldSnapshot = join(roots.acceptance, "old-web-dist-cold-restore");
  const candidate = join(roots.acceptance, "candidate-web-dist");
  if (mode === "--prepare") {
    need(!existsSync(roots.acceptance) && !existsSync(roots.proof), "RUN_ALREADY_EXISTS");
    mkdirNew(roots.acceptance);
    createProofFolder(roots.proof);
    const prepared = {
      schemaVersion: 1,
      runId,
      status: "preparing",
      sourceCommit,
      startedAt: new Date().toISOString(),
      boundaries: { builds: 0, http: 0, serviceOperations: 0, servedWrites: 0 },
      roots,
      sourceBefore: before,
      oldFiles: inventory.oldFiles,
      newFiles: inventory.newFiles,
    };
    try {
      prepared.webBefore = webIdentity();
      assertTree(servedRoot, inventory.oldFiles);
      assertTree(inputRoot, inventory.newFiles);
      prepared.oldRetention = copyTreeCreateOnly(servedRoot, oldSnapshot);
      prepared.candidateRetention = copyTreeCreateOnly(inputRoot, candidate);
      copyFileSync(scriptFile, join(roots.acceptance, "runner.mjs.txt"), constants.COPYFILE_EXCL);
      prepared.sourceAfter = sourceSnapshot();
      equal(prepared.sourceAfter, before, "SOURCE_CHANGED_DURING_PREPARE");
      prepared.webAfter = webIdentity();
      equal(prepared.webAfter, prepared.webBefore, "WEB_CHANGED_DURING_PREPARE");
      prepared.git = { head: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain=v1"]) };
      prepared.status = "prepared_not_deployed";
      prepared.completedAt = new Date().toISOString();
      durableNew(join(roots.acceptance, "plan.json"), json(prepared));
      prepared.planSha256 = fileFact(join(roots.acceptance, "plan.json")).sha256;
    } catch (error) {
      prepared.status = "failed_retained";
      prepared.error = error instanceof Error ? error.message.slice(0, 160) : "PREPARE_FAILED";
      throw error;
    } finally {
      durableNew(join(roots.proof, "prepare.json"), json(prepared));
    }
    console.log(
      json({
        status: prepared.status,
        runId,
        planSha256: prepared.planSha256,
        acceptance: roots.acceptance,
      }).trim(),
    );
    return;
  }
  need(
    shaPattern.test(runnerSha ?? "") &&
      shaPattern.test(planSha ?? "") &&
      before.script.sha256 === runnerSha,
    "APPROVED_RUNNER_SHA_REQUIRED",
  );
  const planPath = join(roots.acceptance, "plan.json");
  need(fileFact(planPath).sha256 === planSha, "APPROVED_PLAN_SHA_REQUIRED");
  const plan = readJson(planPath);
  need(plan.runId === runId && plan.status === "prepared_not_deployed", "PREPARED_PLAN_REQUIRED");
  equal(plan.roots, roots, "PLAN_SCOPE_CHANGED");
  equal(plan.sourceBefore, before, "SOURCE_CHANGED_SINCE_PREPARE");
  equal(plan.oldFiles, inventory.oldFiles, "PLAN_OLD_FILES_CHANGED");
  equal(plan.newFiles, inventory.newFiles, "PLAN_NEW_FILES_CHANGED");
  assertTree(oldSnapshot, inventory.oldFiles);
  assertTree(candidate, inventory.newFiles);
  assertTree(inputRoot, inventory.newFiles);
  const restoring = mode === "--restore-index";
  const proofName = restoring ? "restore-index.json" : "deploy.json";
  need(!existsSync(join(roots.proof, proofName)), "ACTION_ALREADY_RECORDED");
  if (restoring) {
    need(
      shaPattern.test(deploymentSha ?? "") &&
        fileFact(join(roots.proof, "deploy.json")).sha256 === deploymentSha,
      "APPROVED_DEPLOY_PROOF_REQUIRED",
    );
    need(
      readJson(join(roots.proof, "deploy.json")).status === "published_verified",
      "SUCCESSFUL_DEPLOY_REQUIRED_FOR_RESTORE",
    );
  }
  // The permanent publication lock rejects all later runs. Restore has its own retained one-shot lock.
  const lock = join(
    runtimeRoot,
    "acceptance",
    restoring ? `.web-detail-fix-restore-${runId}.lock` : ".web-detail-fix-publication.lock",
  );
  durableNew(lock, json({ runId, mode, runnerSha, planSha, createdAt: new Date().toISOString() }));
  const scratch = join(roots.acceptance, restoring ? "restore-pending" : "deploy-pending");
  mkdirNew(scratch);
  const record = {
    schemaVersion: 1,
    runId,
    mode,
    status: "started",
    sourceCommit,
    runnerSha,
    planSha,
    startedAt: new Date().toISOString(),
    requests: [],
    sourceBefore: before,
    retainedLock: lock,
    boundaries: {
      builds: 0,
      serviceOperations: 0,
      apiRequests: 0,
      uiValidation: "not_run",
      oldFilesDeleted: 0,
    },
  };
  try {
    record.webBefore = webIdentity();
    equal(record.webBefore, plan.webBefore, "WEB_CHANGED_SINCE_PREPARE");
    const expectedBefore = restoring
      ? mergedInventory(inventory.oldFiles, inventory.newFiles)
      : inventory.oldFiles;
    assertTree(servedRoot, expectedBefore);
    await verifyHttp(
      [expectedBefore.find((entry) => entry.path === "index.html")],
      record.requests,
    );
    if (!restoring) installAssets(candidate, servedRoot, scratch, inventory.newFiles);
    // Assert every old file and installed asset, including the old HTML, before the sole replacement.
    assertTree(servedRoot, mergedInventory(inventory.oldFiles, inventory.newFiles, !restoring));
    equal(sourceSnapshot(), before, "SOURCE_CHANGED_BEFORE_INDEX_SWITCH");
    equal(webIdentity(), record.webBefore, "WEB_CHANGED_BEFORE_INDEX_SWITCH");
    const fromFiles = restoring ? inventory.newFiles : inventory.oldFiles;
    const toFiles = restoring ? inventory.oldFiles : inventory.newFiles;
    switchIndex(
      join(restoring ? oldSnapshot : candidate, "index.html"),
      servedRoot,
      scratch,
      factOnly(fromFiles.find((entry) => entry.path === "index.html")),
      factOnly(toFiles.find((entry) => entry.path === "index.html")),
    );
    record.indexSwitched = true;
    const expectedAfter = mergedInventory(inventory.oldFiles, inventory.newFiles, restoring);
    assertTree(servedRoot, expectedAfter);
    record.servedAfter = treeFacts(servedRoot);
    await verifyHttp(toFiles, record.requests);
    record.sourceAfter = sourceSnapshot();
    equal(record.sourceAfter, before, "SOURCE_CHANGED_DURING_PUBLICATION");
    record.webAfter = webIdentity();
    equal(record.webAfter, record.webBefore, "WEB_CHANGED_DURING_PUBLICATION");
    assertTree(oldSnapshot, inventory.oldFiles);
    assertTree(inputRoot, inventory.newFiles);
    assertTree(candidate, inventory.newFiles);
    record.status = restoring
      ? "old_index_restored_verified_assets_retained"
      : "published_verified";
  } catch (error) {
    record.status = "failed_retained";
    record.error = error instanceof Error ? error.message.slice(0, 160) : "PUBLICATION_FAILED";
    // A failed post-check can follow a successful index switch. Never auto-revert or erase this state.
    throw error;
  } finally {
    record.completedAt = new Date().toISOString();
    durableNew(join(roots.proof, proofName), json(record));
  }
  console.log(
    json({
      status: record.status,
      runId,
      requests: record.requests.length,
      proof: join(roots.proof, proofName),
    }).trim(),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptFile)) {
  cli(process.argv.slice(2)).catch((error) => {
    // Do not print assertion payloads, command lines or response bodies.
    console.error(
      json({
        status: "failed_retained",
        code: error instanceof Error ? error.message.split("\n")[0].slice(0, 160) : "FAILED",
      }).trim(),
    );
    process.exitCode = 1;
  });
}
