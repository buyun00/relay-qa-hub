import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  createSqliteOnlineBackup,
  archiveSqliteRecoveryPointWithAttachments,
  validateArchivedSqliteRecoveryPointWithAttachments,
} from "@relay-qa-hub/storage";
import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";

const sourceFile = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(sourceFile), "../..");
const previewId = "qa-hub-preview-7c86";
const previewRuntime = join(homedir(), ".codex", "parallel-runtimes", previewId);
const proofFolder = "docs/evidence/project-components/android-update-deployment-retention";
const previewPackage = "com.relayqahub.android.preview.debug";
const dailyPackage = "com.relayqahub.android.debug";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export const baseTables = [
  "projects",
  "users",
  "memberships",
  "membership_roles",
  "modules",
  "bugs",
  "repair_attempts",
  "verifications",
  "events",
  "comments",
  "attachments",
  "bug_attachments",
  "bug_deletions",
  "submissions",
  "idempotency_records",
  "manual_completion_requests",
  "user_identity_links",
];
const requiredTransferTables = [
  "upload_sessions",
  "upload_chunks",
  "attachment_bindings",
  "capture_bundles",
  "capture_artifacts",
];
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) =>
  JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? { sqliteInteger: item.toString() } : item,
  );
const within = (path, root) => {
  const suffix = relative(root, path);
  return (
    suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
};
function check(condition, code) {
  if (!condition) throw new Error(code);
}
function ordinary(path, directory = false) {
  const stat = lstatSync(path);
  check(
    !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()),
    "ORDINARY_PATH_REQUIRED",
  );
  check(
    resolve(realpathSync.native(path)).toLowerCase() === resolve(path).toLowerCase(),
    "CANONICAL_PATH_REQUIRED",
  );
  return stat;
}
export function fileFact(path) {
  const before = ordinary(path);
  const digest = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      digest.update(buffer.subarray(0, count));
  } finally {
    closeSync(fd);
  }
  const after = ordinary(path);
  check(before.size === after.size && before.mtimeMs === after.mtimeMs, "FILE_CHANGED_DURING_HASH");
  return { bytes: before.size, sha256: digest.digest("hex") };
}
export function treeFacts(root) {
  if (!existsSync(root))
    return { exists: false, count: 0, bytes: 0, files: [], sha256: hash("[]") };
  ordinary(root, true);
  const files = [];
  const pending = [root];
  while (pending.length) {
    const folder = pending.pop();
    ordinary(folder, true);
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      check(
        !entry.isSymbolicLink() && within(realpathSync.native(path), root),
        "TREE_LINK_REFUSED",
      );
      if (entry.isDirectory()) pending.push(path);
      else {
        check(entry.isFile(), "TREE_SPECIAL_FILE_REFUSED");
        files.push({ path: relative(root, path).replaceAll("\\", "/"), ...fileFact(path) });
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return {
    exists: true,
    count: files.length,
    bytes: files.reduce((n, x) => n + x.bytes, 0),
    files,
    sha256: hash(json(files)),
  };
}
export function copyTreeCreateOnly(root, target, expected = treeFacts(root)) {
  check(!existsSync(target), "COPY_TARGET_EXISTS");
  check(!within(target, root) && !within(root, target), "COPY_ROOTS_OVERLAP");
  ordinary(dirname(target), true);
  mkdirSync(target);
  if (expected.exists) {
    for (const entry of expected.files) {
      const input = resolve(root, entry.path);
      const output = resolve(target, entry.path);
      check(within(input, root) && within(output, target), "COPY_PATH_ESCAPE");
      check(!/-(?:wal|shm)$/iu.test(entry.path), "LIVE_SQLITE_SIDECAR_COPY_REFUSED");
      ordinary(input);
      mkdirSync(dirname(output), { recursive: true });
      ordinary(dirname(output), true);
      copyFileSync(input, output, constants.COPYFILE_EXCL);
      assert.deepEqual(
        fileFact(output),
        { bytes: entry.bytes, sha256: entry.sha256 },
        "COPIED_FILE_MISMATCH",
      );
    }
  }
  assert.deepEqual(treeFacts(root), expected, "COPY_SOURCE_CHANGED");
  const copied = treeFacts(target);
  assert.deepEqual(copied.files, expected.files, "COPY_INVENTORY_MISMATCH");
  return { sourceExisted: expected.exists, ...copied };
}
export function databaseFacts(path, { immutable = false } = {}) {
  ordinary(path);
  const location = pathToFileURL(path);
  if (immutable) location.searchParams.set("immutable", "1");
  const db = new DatabaseSync(immutable ? location : path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN");
    const schema = db
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    const names = schema.map((x) => x.name);
    for (const name of [...baseTables, ...requiredTransferTables, "project_components"])
      check(names.includes(name), "REQUIRED_SCHEMA_TABLE_MISSING");
    // All discovered tables are fingerprinted: upload/capture rows are not silently
    // omitted, and operational/session changes remain visible rather than discarded.
    const tables = Object.fromEntries(
      names.map((name) => {
        const quoted = '"' + name.replaceAll('"', '""') + '"';
        const statement = db.prepare(`SELECT * FROM ${quoted}`);
        statement.setReadBigInts(true);
        const rows = statement
          .all()
          .map((row) => json(row))
          .sort();
        return [name, { count: rows.length, sha256: hash(json(rows)) }];
      }),
    );
    const groups = {
      business: [...baseTables],
      uploadAndCapture: names.filter((name) => /upload|capture|attachment_bindings/iu.test(name)),
      remaining: names.filter(
        (name) => !baseTables.includes(name) && !/upload|capture|attachment_bindings/iu.test(name),
      ),
    };
    return {
      schemaVersion: Number(db.prepare("PRAGMA user_version").get().user_version),
      componentGate: {
        configuredRows: Number(
          db.prepare("SELECT COUNT(*) AS count FROM project_components").get().count,
        ),
        enabledRows: Number(
          db.prepare("SELECT COUNT(*) AS count FROM project_components WHERE enabled <> 0").get()
            .count,
        ),
        missingRowsDefaultDisabled: true,
      },
      schema: schema.map((x) => ({ name: x.name, definitionSha256: hash(x.sql ?? "") })),
      groups,
      tables,
    };
  } finally {
    try {
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  }
}
export async function retainData({ dataRoot, outputRoot }) {
  ordinary(dataRoot, true);
  check(
    !existsSync(outputRoot) && !within(outputRoot, dataRoot) && !within(dataRoot, outputRoot),
    "RETENTION_ROOT_INVALID",
  );
  ordinary(dirname(outputRoot), true);
  mkdirSync(outputRoot);
  const sourcePath = join(dataRoot, "db", "qa-hub.sqlite");
  const evidenceRoot = join(dataRoot, "evidence");
  const quarantineRoot = join(dataRoot, "quarantine");
  const before = {
    database: databaseFacts(sourcePath),
    evidence: treeFacts(evidenceRoot),
    quarantine: treeFacts(quarantineRoot),
  };
  check(before.evidence.exists, "EVIDENCE_ROOT_REQUIRED");
  check(
    before.database.schemaVersion === 14 && before.database.componentGate.enabledRows === 0,
    "SCHEMA14_AND_COMPONENTS_OFF_REQUIRED",
  );
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let backup;
  try {
    backup = await createSqliteOnlineBackup({
      source,
      targetPath: join(outputRoot, "online", "qa-hub.sqlite"),
    });
  } finally {
    source.close();
  }
  assert.deepEqual(
    databaseFacts(backup.backupPath, { immutable: true }),
    before.database,
    "SOURCE_CHANGED_BEFORE_BACKUP",
  );
  const archive = await archiveSqliteRecoveryPointWithAttachments({
    backupPath: backup.backupPath,
    manifestPath: backup.manifestPath,
    evidenceRoot,
    archiveRoot: join(outputRoot, "archive"),
  });
  check(archive.disposition === "created", "ARCHIVE_MUST_BE_NEW");
  await validateArchivedSqliteRecoveryPointWithAttachments({ backupPath: archive.backupPath });
  const quarantine = copyTreeCreateOnly(
    quarantineRoot,
    join(outputRoot, "quarantine"),
    before.quarantine,
  );
  const after = {
    database: databaseFacts(sourcePath),
    evidence: treeFacts(evidenceRoot),
    quarantine: treeFacts(quarantineRoot),
  };
  assert.deepEqual(after, before, "LIVE_DATA_CHANGED_DURING_RETENTION");
  return { source: before, backup, archive, quarantine, retainedFiles: treeFacts(outputRoot) };
}

// Raw ADB protocol only connects to an already-running server. No adb.exe is
// spawned, so unavailable port 5037 cannot start a server or emulator implicitly.
export async function adbRead(command, { socketFactory } = {}) {
  const allowed = androidCommands();
  check(allowed.includes(command), "ADB_COMMAND_REFUSED");
  return new Promise((resolveResult, reject) => {
    const socket = (socketFactory ?? connect)({ host: "127.0.0.1", port: 5037 });
    let stage = "transport",
      data = Buffer.alloc(0),
      failed = false,
      completed = false;
    const send = (value) =>
      socket.write(Buffer.from(Buffer.byteLength(value).toString(16).padStart(4, "0") + value));
    const fail = () => {
      failed = true;
      socket.destroy();
      reject(new Error("ADB_READ_FAILED"));
    };
    socket.setTimeout(15000, fail);
    socket.on("error", fail);
    socket.on("connect", () => send("host:transport:127.0.0.1:16384"));
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 4 * 1024 * 1024) return fail();
      if (stage !== "body" && data.length >= 4) {
        if (data.subarray(0, 4).toString() !== "OKAY") return fail();
        data = data.subarray(4);
        if (stage === "transport") {
          stage = "shell";
          send("shell:" + command);
        } else stage = "body";
      }
    });
    socket.on("end", () => {
      if (!failed && stage === "body") {
        completed = true;
        resolveResult(data.toString("utf8").replaceAll("\r", "").trim());
      } else if (!failed) fail();
    });
    socket.on("close", () => {
      if (!failed && !completed) fail();
    });
  });
}
export function androidCommands() {
  return [
    ...[previewPackage, dailyPackage].flatMap((pkg) => ["pidof " + pkg, "dumpsys package " + pkg]),
    `sha256sum /sdcard/Android/media/${previewPackage}/qa-hub/config/qa-runtime.json`,
    String.raw`run-as ${previewPackage} sh -c 'find shared_prefs files/capture-drafts -type f -exec sha256sum {} \;'`,
    String.raw`run-as ${dailyPackage} sh -c 'find shared_prefs -type f -exec sha256sum {} \;'`,
  ];
}
export function parseAndroidVersion(text) {
  const code = /^\s*versionCode=(\d+)\b/mu.exec(text);
  const name = /^\s*versionName=(\S+)/mu.exec(text);
  check(code && name, "ANDROID_VERSION_UNAVAILABLE");
  return { versionCode: Number(code[1]), versionName: name[1] };
}
export function parseAndroidHashes(text) {
  const rows = text
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^([0-9a-f]{64})\s+(.+)$/iu.exec(line.trim());
      check(match, "ANDROID_HASH_READ_FAILED");
      return { path: match[2], sha256: match[1].toLowerCase() };
    })
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  check(
    rows.length > 0 && new Set(rows.map((x) => x.path)).size === rows.length,
    "ANDROID_HASH_SET_INVALID",
  );
  return rows;
}
async function androidSnapshot() {
  const result = {};
  for (const [label, pkg] of [
    ["preview", previewPackage],
    ["daily", dailyPackage],
  ]) {
    const pids = await adbRead("pidof " + pkg);
    check(/^\d+(?: \d+)*$/u.test(pids), "ANDROID_APP_NOT_RUNNING");
    result[label] = {
      packageName: pkg,
      pids: pids.split(" ").map(Number),
      ...parseAndroidVersion(await adbRead("dumpsys package " + pkg)),
    };
  }
  check(
    result.preview.versionCode === 23 && result.daily.versionCode === 14,
    "ANDROID_VERSION_BOUNDARY_CHANGED",
  );
  const commands = androidCommands();
  result.preview.runtimeConfig = parseAndroidHashes(await adbRead(commands[4]));
  result.preview.draftsAndPreferences = parseAndroidHashes(await adbRead(commands[5]));
  result.daily.preferences = parseAndroidHashes(await adbRead(commands[6]));
  return result;
}
function hostSnapshot(config) {
  const script = String.raw`
$ErrorActionPreference='Stop'
$taskSpec=$env:QA_RETENTION_HOST_SPEC | ConvertFrom-Json
$taskPorts=@(4419,4274,4421,4420,4319,4174)
$taskListeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -in $taskPorts} | Sort-Object LocalPort,LocalAddress | Select-Object LocalPort,LocalAddress,OwningProcess)
$taskAll=@(Get-CimInstance Win32_Process)
$taskPaths=@($taskSpec.previewExe,$taskSpec.dailyExe)
$taskIds=@(@($taskListeners | ForEach-Object {$_.OwningProcess})+@($taskAll | Where-Object {$_.ExecutablePath -in $taskPaths} | ForEach-Object {$_.ProcessId}) | Sort-Object -Unique)
$taskProcesses=@(foreach($taskId in $taskIds){$taskProcess=$taskAll | Where-Object {$_.ProcessId -eq $taskId};if(-not $taskProcess){throw 'LISTENER_PROCESS_MISSING'};[pscustomobject]@{pid=$taskId;createdAt=$taskProcess.CreationDate.ToUniversalTime().ToString('o');executable=$taskProcess.ExecutablePath}})
$taskServices=@(foreach($taskName in @('api','web','mcp')){
 $taskReceipt=Get-Content -LiteralPath (Join-Path $taskSpec.logsRoot ($taskName+'-process.json')) -Raw | ConvertFrom-Json
 $taskActual=$taskAll | Where-Object {$_.ProcessId -eq $taskReceipt.pid}
 if(-not $taskActual -or $taskReceipt.instanceId -ne 'qa-hub-preview-7c86' -or $taskReceipt.service -ne $taskName -or $taskActual.ExecutablePath -ne $taskReceipt.executable -or $taskActual.CommandLine -ne $taskReceipt.commandLine -or $taskActual.CreationDate.ToUniversalTime() -ne ([DateTime]$taskReceipt.createdAt).ToUniversalTime()){throw 'PREVIEW_RECEIPT_IDENTITY_MISMATCH'}
 [pscustomobject]@{service=$taskName;pid=$taskActual.ProcessId;createdAt=$taskActual.CreationDate.ToUniversalTime().ToString('o');executable=$taskActual.ExecutablePath;commandLineMatchesReceipt=$true}
})
$taskInstalled=[pscustomobject]@{path=$taskSpec.previewExe;productVersion=(Get-Item -LiteralPath $taskSpec.previewExe).VersionInfo.ProductVersion;fileVersion=(Get-Item -LiteralPath $taskSpec.previewExe).VersionInfo.FileVersion}
[pscustomobject]@{services=$taskServices;processes=$taskProcesses;listeners=$taskListeners;installed=$taskInstalled}|ConvertTo-Json -Depth 8 -Compress
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      env: {
        ...process.env,
        QA_RETENTION_HOST_SPEC: json({
          logsRoot: config.logsRoot,
          previewExe: join(
            homedir(),
            "AppData/Local/Programs/RelayQaHubPreview/RelayQaHubPreview.exe",
          ),
          dailyExe: join(homedir(), "AppData/Local/Programs/RelayQaHub/RelayQaHub.exe"),
        }),
      },
    },
  );
  check(result.status === 0, "READONLY_HOST_SNAPSHOT_FAILED");
  const host = JSON.parse(result.stdout);
  for (const port of [4419, 4274, 4421, 4420, 4319, 4174]) {
    const listeners = host.listeners.filter((x) => x.LocalPort === port);
    check(
      listeners.length > 0 && new Set(listeners.map((x) => x.OwningProcess)).size === 1,
      "REQUIRED_LISTENER_MISSING_OR_AMBIGUOUS",
    );
  }
  for (const [service, port] of [
    ["api", 4419],
    ["web", 4274],
    ["mcp", 4421],
  ]) {
    check(
      host.listeners
        .filter((x) => x.LocalPort === port)
        .every((x) => x.OwningProcess === host.services.find((x) => x.service === service)?.pid),
      "SERVICE_PORT_OWNER_MISMATCH",
    );
  }
  const exePid = host.listeners.find((x) => x.LocalPort === 4420).OwningProcess;
  check(
    host.processes.find((x) => x.pid === exePid)?.executable === host.installed.path,
    "LOCAL_MCP_PREVIEW_OWNER_MISMATCH",
  );
  check(host.installed.productVersion === "0.2.0-preview.8", "PREVIEW_EXE_VERSION_MISMATCH");
  check(
    host.processes.some((x) => x.executable?.endsWith("\\RelayQaHub\\RelayQaHub.exe")),
    "DAILY_EXE_MISSING",
  );
  return host;
}
async function readiness() {
  const result = {};
  for (const [label, port, path] of [
    ["httpApi", 4419, "/api/v1/health/ready"],
    ["web", 4274, "/"],
    ["serverMcp", 4421, "/health"],
    ["localMcp", 4420, "/health"],
    ["productionApi", 4319, "/api/v1/health/ready"],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    check(response.status === 200, "READINESS_NOT_200");
    result[label] = {
      port,
      path,
      statusCode: response.status,
      bytes: bytes.length,
      sha256: hash(bytes),
    };
    if (label !== "web") {
      const body = JSON.parse(bytes.toString());
      check(body.status === "ready", "SERVICE_NOT_READY");
      result[label].status = body.status;
      if (body.schemaVersion !== undefined) result[label].schemaVersion = body.schemaVersion;
      if (label === "localMcp") {
        check(
          body.service === "relay-qa-hub-desktop-mcp" &&
            body.endpoint === "/mcp" &&
            body.transport === "streamable-http",
          "LOCAL_MCP_HEALTH_CONTRACT_CHANGED",
        );
        result[label].service = body.service;
        result[label].endpoint = body.endpoint;
        result[label].transport = body.transport;
      }
    }
  }
  check(
    result.httpApi.schemaVersion === "14" && result.productionApi.schemaVersion === "12",
    "API_SCHEMA_BOUNDARY_CHANGED",
  );
  return result;
}
function configurationFacts(config, configPath) {
  const installedRoot = join(homedir(), "AppData/Local/Programs/RelayQaHubPreview");
  const installedConfigPath = join(installedRoot, "preview-instance.json");
  const installed = JSON.parse(readFileSync(installedConfigPath, "utf8").replace(/^\uFEFF/u, ""));
  check(
    installed.instanceId === previewId &&
      installed.apiBaseUrl === "http://127.0.0.1:4419" &&
      installed.csrfOrigin === "http://127.0.0.1:4274" &&
      installed.cookieName === `${previewId}-session` &&
      installed.mcpPort === 4420 &&
      resolve(installed.profileDirectory) === join(config.desktopRoot, "profile") &&
      installed.updateManifestUrl ===
        `http://127.0.0.1:4274/downloads/${previewId}-windows-latest.json`,
    "INSTALLED_PREVIEW_CONFIG_BOUNDARY_CHANGED",
  );
  const files = [
    configPath,
    config.peopleFile,
    config.secretsFile,
    join(installedRoot, "preview-instance.json"),
    join(installedRoot, ".preview-instance-id"),
  ];
  return [
    ...files.map((path) => ({ path, exists: true, ...fileFact(path) })),
    ...[
      join(config.desktopRoot, "profile", "desktop-runtime.json"),
      join(installedRoot, "desktop-runtime.json"),
    ].map((path) => ({
      path,
      exists: existsSync(path),
      ...(existsSync(path) ? fileFact(path) : {}),
    })),
  ];
}
const productionFiles = () => [
  "D:/Relay-QA-Hub-Data/mvp-e2e-current.json",
  "D:/Relay-QA-Hub-Config/qa-people.json",
  "D:/Relay-QA-Hub/apps/desktop/release/installer/Relay-QA-Hub-Windows-x64-latest.json",
  "D:/Relay-QA-Hub/apps/desktop/release/installer/Relay-QA-Hub-Setup-x64.exe",
  join(homedir(), "AppData/Local/Programs/RelayQaHub/desktop-runtime.json"),
  join(homedir(), "AppData/Local/Relay QA Hub/desktop-runtime.json"),
];
function distributionFacts(config) {
  const androidRoot = join(config.downloadsRoot, "android", previewId);
  const files = [
    join(config.downloadsRoot, `${previewId}-windows-latest.json`),
    join(config.downloadsRoot, `${previewId}-android-0.2.0-preview.8-code22.apk`),
    join(config.downloadsRoot, `${previewId}-android-0.2.0-preview.8-code22.apk.receipt.json`),
    join(
      config.runtimeRoot,
      "android-code23-recovery-65ee5dc8-3f23-4f28-ad97-daa1de8b0ece",
      "qa-hub-preview-code23.apk",
    ),
  ];
  const result = {
    androidRoot,
    androidFeed: treeFacts(androidRoot),
    files: files.map((path) => ({ path, ...fileFact(path) })),
  };
  check(
    result.files[1].sha256 === "733088b8f876c41ce767627c6de8dfe12e00803c0b61ff13c6facd3b8982d777" &&
      result.files[3].sha256 === "9cfa87eb36b5be80f218e104fb4c6338fda3e96e5dcc694d897c5907df768548",
    "PINNED_ANDROID_ARTIFACT_CHANGED",
  );
  return result;
}
export function withoutApi(host) {
  const apiPid = host.services.find((x) => x.service === "api").pid;
  return {
    ...host,
    services: host.services.filter((x) => x.service !== "api"),
    processes: host.processes.filter((x) => x.pid !== apiPid),
    listeners: host.listeners.filter((x) => x.LocalPort !== 4419),
  };
}
async function observe(config, configPath, result = {}) {
  result.host = hostSnapshot(config);
  result.android = await androidSnapshot();
  result.readiness = await readiness();
  result.configuration = configurationFacts(config, configPath);
  result.distribution = distributionFacts(config);
  result.productionFiles = productionFiles().map((path) => ({ path, ...fileFact(path) }));
  return result;
}
function stableObservation(value) {
  // Ready payloads may include timing; retain their raw hashes as facts but compare
  // only stable status/schema. Web index bytes must remain exactly the same.
  return {
    ...value,
    readiness: Object.fromEntries(
      Object.entries(value.readiness).map(([key, row]) => [
        key,
        key === "web"
          ? row
          : {
              port: row.port,
              path: row.path,
              statusCode: row.statusCode,
              status: row.status,
              schemaVersion: row.schemaVersion,
              ...(key === "localMcp"
                ? { service: row.service, endpoint: row.endpoint, transport: row.transport }
                : {}),
            },
      ]),
    ),
  };
}
export async function main(args = process.argv.slice(2)) {
  if (args[0] !== "--run") {
    console.log(
      json({
        status: "not_run",
        usage: "--run before|after <explicit preview instance.json> <same run UUID>",
        reads: 0,
        writes: 0,
      }),
    );
    return;
  }
  const [, phase, configFile, runId, ...extra] = args;
  check(
    process.platform === "win32" &&
      ["before", "after"].includes(phase) &&
      uuid.test(runId ?? "") &&
      extra.length === 0,
    "EXPLICIT_ARGUMENTS_REQUIRED",
  );
  check(
    resolve(configFile ?? "").toLowerCase() === join(previewRuntime, "instance.json").toLowerCase(),
    "EXACT_PREVIEW_CONFIG_REQUIRED",
  );
  const config = readParallelInstanceConfig(configFile);
  check(
    config.instanceId === previewId &&
      resolve(config.sourceRoot).toLowerCase() === sourceRoot.toLowerCase() &&
      resolve(config.runtimeRoot).toLowerCase() === previewRuntime.toLowerCase(),
    "INSTANCE_ROOT_MISMATCH",
  );
  check(
    config.apiPort === 4419 &&
      config.webPort === 4274 &&
      config.mcpPort === 4421 &&
      config.desktopMcpPort === 4420,
    "INSTANCE_PORT_MISMATCH",
  );
  const privateRoot = join(config.backupRoot, `android-update-${runId}`);
  const publicRoot = join(sourceRoot, proofFolder, runId);
  const output = join(publicRoot, `${phase}.json`);
  check(!existsSync(output), "PUBLIC_PROOF_EXISTS");
  if (phase === "before")
    check(!existsSync(privateRoot) && !existsSync(publicRoot), "RETENTION_RUN_EXISTS");
  else check(existsSync(join(publicRoot, "before.json")), "BEFORE_PROOF_REQUIRED");
  mkdirSync(publicRoot, { recursive: true });
  if (phase === "before") {
    ordinary(config.backupRoot, true);
    mkdirSync(privateRoot);
  }
  const proof = {
    schemaVersion: 1,
    runId,
    phase,
    status: "running",
    startedAt: new Date().toISOString(),
    runnerSha256: fileFact(sourceFile).sha256,
    privateRoot,
    checks: [],
    boundaries: {
      serviceControl: false,
      feedPublication: false,
      adbExecutableStarted: false,
      copiedLiveWal: false,
      businessRequests: false,
      rawCredentialsPersisted: false,
    },
  };
  const verify = (label, expected, actual) => {
    const passed = isDeepStrictEqual(expected, actual);
    proof.checks.push({ label, expected, actual, passed });
    check(passed, label);
  };
  try {
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    check(
      head.status === 0 && /^[0-9a-f]{40}$/u.test(head.stdout.trim()),
      "SOURCE_HEAD_UNAVAILABLE",
    );
    proof.sourceHead = head.stdout.trim();
    proof.nodeVersion = process.version;
    if (phase === "before")
      copyFileSync(sourceFile, join(privateRoot, "runner.mjs"), constants.COPYFILE_EXCL);
    proof.stage = "initial-observation";
    const start = {};
    proof.observed = start;
    await observe(config, configFile, start);
    if (phase === "before") {
      proof.stage = "consistent-data-retention";
      proof.retention = await retainData({
        dataRoot: config.dataRoot,
        outputRoot: join(privateRoot, "data"),
      });
      proof.retention.feed = copyTreeCreateOnly(
        start.distribution.androidRoot,
        join(privateRoot, "android-feed"),
        start.distribution.androidFeed,
      );
      mkdirSync(join(privateRoot, "distribution"));
      for (const [index, fact] of start.distribution.files.entries()) {
        const target = join(
          privateRoot,
          "distribution",
          `${index}-${fact.path.split(/[\\/]/u).at(-1)}`,
        );
        copyFileSync(fact.path, target, constants.COPYFILE_EXCL);
        verify(
          "DISTRIBUTION_COPY_MATCH_" + index,
          { bytes: fact.bytes, sha256: fact.sha256 },
          fileFact(target),
        );
      }
      proof.retainedFiles = treeFacts(privateRoot);
      proof.stage = "final-boundary-observation";
      verify(
        "BOUNDARIES_STABLE_DURING_BEFORE",
        stableObservation(start),
        stableObservation(await observe(config, configFile)),
      );
    } else {
      proof.stage = "retained-archive-validation";
      const beforePath = join(publicRoot, "before.json");
      const before = JSON.parse(readFileSync(beforePath, "utf8"));
      proof.beforeProof = { path: beforePath, ...fileFact(beforePath) };
      verify("BEFORE_PASSED", "passed", before.status);
      verify("RUNNER_UNCHANGED", before.runnerSha256, proof.runnerSha256);
      verify("RETAINED_FILES_UNCHANGED", before.retainedFiles, treeFacts(privateRoot));
      await validateArchivedSqliteRecoveryPointWithAttachments({
        backupPath: before.retention.archive.backupPath,
      });
      proof.currentData = {
        database: databaseFacts(join(config.dataRoot, "db", "qa-hub.sqlite")),
        evidence: treeFacts(join(config.dataRoot, "evidence")),
        quarantine: treeFacts(join(config.dataRoot, "quarantine")),
      };
      verify("DATABASE_AND_FILES_UNCHANGED", before.retention.source, proof.currentData);
      proof.stage = "post-restart-comparison";
      const expected = stableObservation(before.observed);
      const actual = stableObservation(start);
      expected.host = withoutApi(expected.host);
      actual.host = withoutApi(actual.host);
      verify("FIVE_OTHER_ENTRIES_PRODUCTION_CONFIG_FEED_UNCHANGED", expected, actual);
      const oldApi = before.observed.host.services.find((x) => x.service === "api");
      const newApi = start.host.services.find((x) => x.service === "api");
      verify("API_PROCESS_REPLACED", true, oldApi.createdAt !== newApi.createdAt);
      verify("API_EXECUTABLE_UNCHANGED", oldApi.executable, newApi.executable);
      verify(
        "BOUNDARIES_STABLE_DURING_AFTER",
        stableObservation(start),
        stableObservation(await observe(config, configFile)),
      );
    }
    proof.status = "passed";
  } catch (error) {
    proof.status = "failed";
    // Do not serialize arbitrary error objects/messages containing response or config data.
    proof.failure = {
      code: /^[A-Z0-9_]+$/u.test(error.message ?? "")
        ? error.message
        : "RETENTION_ASSERTION_OR_IO_FAILED",
      name: error.name,
    };
  } finally {
    proof.completedAt = new Date().toISOString();
    writeFileSync(output, JSON.stringify(proof, null, 2) + "\n", { flag: "wx" });
    console.log(
      json({
        status: proof.status,
        phase,
        runId,
        proof: output,
        sha256: fileFact(output).sha256,
        failedChecks: proof.checks.filter((x) => !x.passed).map((x) => x.label),
      }),
    );
    if (proof.status !== "passed") process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === sourceFile) {
  main().catch(() => {
    console.error("RETENTION_ARGUMENT_OR_SETUP_REFUSED");
    process.exitCode = 1;
  });
}
