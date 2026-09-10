import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const [, , phase, configFile, runId, outputRoot] = process.argv;
assert.ok(phase === "before" || phase === "after", "PHASE_REQUIRED");
assert.match(runId ?? "", /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
assert.ok(path.isAbsolute(configFile ?? ""), "ABSOLUTE_CONFIG_REQUIRED");
assert.ok(path.isAbsolute(outputRoot ?? ""), "ABSOLUTE_OUTPUT_REQUIRED");

const hash = (value) => createHash("sha256").update(value).digest("hex");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
const configPath = realpathSync.native(configFile);
const config = readJson(configPath);
assert.equal(config.instanceId, "qa-hub-preview-v21-e2e-fresh-0910");
assert.equal(config.apiHost, "127.0.0.1");
assert.equal(config.apiPort, 4639);
assert.equal(config.webPort, 4640);
assert.equal(config.mcpPort, 4641);
assert.equal(realpathSync.native(config.sourceRoot), process.cwd());
assert.equal(realpathSync.native(path.dirname(configPath)), realpathSync.native(config.runtimeRoot));

const evidenceRoot = path.resolve(outputRoot);
assert.ok(evidenceRoot.startsWith(path.resolve(config.sourceRoot) + path.sep));
mkdirSync(evidenceRoot, { recursive: true });
const outputFile = path.join(evidenceRoot, `${phase}.json`);
assert.equal(existsSync(outputFile), false, "EVIDENCE_OVERWRITE_REFUSED");

function fileHash(file) {
  const bytes = readFileSync(file);
  return { bytes: bytes.length, sha256: hash(bytes) };
}

function processSnapshot(pid) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$targetPid = [int]$env:QA_SNAPSHOT_PID
$ports = @($env:QA_SNAPSHOT_PORTS.Split(',') | ForEach-Object { [int]$_ })
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue
$processValue = if ($process) {
  [ordered]@{
    pid = [int]$process.ProcessId
    createdAt = $process.CreationDate.ToUniversalTime().ToString('o')
    executable = [string]$process.ExecutablePath
    commandLine = [string]$process.CommandLine
  }
} else { $null }
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $ports -contains [int]$_.LocalPort } |
  Sort-Object LocalPort, OwningProcess |
  ForEach-Object {
    [ordered]@{
      address = [string]$_.LocalAddress
      port = [int]$_.LocalPort
      pid = [int]$_.OwningProcess
    }
  })
[ordered]@{ process = $processValue; listeners = $listeners } | ConvertTo-Json -Depth 6 -Compress
`;
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          QA_SNAPSHOT_PID: String(pid),
          QA_SNAPSHOT_PORTS: "4174,4319,4320,4639,4640,4641,9333",
        },
      },
    ),
  );
}

function databaseFingerprint(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON; BEGIN");
    const quickCheck = database.prepare("PRAGMA quick_check").all();
    const tableNames = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    const tables = {};
    for (const table of tableNames) {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      const rows = database
        .prepare(`SELECT * FROM ${quoted}`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort();
      tables[table] = { count: rows.length, sha256: hash(JSON.stringify(rows)) };
    }
    database.exec("ROLLBACK");
    return { quickCheck, tables, sha256: hash(JSON.stringify(tables)) };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The original read failure is the actionable error.
    }
    throw error;
  } finally {
    database.close();
  }
}

async function health() {
  const response = await fetch("http://127.0.0.1:4639/api/v1/health/ready", {
    signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, body: await response.json() };
}

const receiptPath = path.join(config.logsRoot, "api-process.json");
const receipt = readJson(receiptPath);
assert.equal(receipt.instanceId, config.instanceId);
assert.equal(receipt.service, "api");
const host = processSnapshot(receipt.pid);
assert.ok(host.process, "RECEIPT_PROCESS_MISSING");
assert.equal(host.process.pid, receipt.pid);
assert.equal(Date.parse(host.process.createdAt), Date.parse(receipt.createdAt));
assert.equal(host.process.executable, receipt.executable);
assert.equal(host.process.commandLine, receipt.commandLine);

const databaseFile = path.join(config.dataRoot, "db", "qa-hub.sqlite");
const configuration = Object.fromEntries(
  [configPath, config.peopleFile, config.secretsFile].map((file) => [
    path.relative(config.runtimeRoot, file).replaceAll("\\", "/"),
    fileHash(file),
  ]),
);
const source = Object.fromEntries(
  [
    "apps/api/src/app.ts",
    "apps/api/dist/app.js",
    "apps/desktop/src/network.ts",
    "apps/desktop/src/notification-transport.ts",
  ].map((relative) => [relative, fileHash(path.join(config.sourceRoot, relative))]),
);
const gitDiff = execFileSync("git", ["diff", "--binary", "--no-ext-diff"], {
  cwd: config.sourceRoot,
});
const snapshot = {
  schemaVersion: 1,
  phase,
  runId,
  observedAt: new Date().toISOString(),
  instanceId: config.instanceId,
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: config.sourceRoot,
    encoding: "utf8",
  }).trim(),
  trackedDiffSha256: hash(gitDiff),
  receipt,
  host,
  health: await health(),
  configuration,
  source,
  database: databaseFingerprint(databaseFile),
};

const backupFile = path.join(
  config.backupRoot,
  `notification-content-negotiation-${runId}`,
  "qa-hub.sqlite",
);
if (phase === "before") {
  const { createSqliteOnlineBackup } = await import(
    pathToFileURL(path.join(config.sourceRoot, "packages/storage/dist/index.js")).href
  );
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const manifest = (
      await createSqliteOnlineBackup({ source: database, targetPath: backupFile })
    ).manifest;
    snapshot.backup = { ...manifest, file: fileHash(backupFile) };
  } finally {
    database.close();
  }
} else {
  const before = readJson(path.join(evidenceRoot, "before.json"));
  assert.equal(before.runId, runId);
  snapshot.backup = { path: backupFile, file: fileHash(backupFile) };
  const listener = host.listeners.find((item) => item.port === config.apiPort);
  const tables = Object.keys(before.database.tables);
  const tableCountsNotReduced = tables.every(
    (table) => snapshot.database.tables[table]?.count >= before.database.tables[table].count,
  );
  snapshot.observations = {
    databaseChanged: snapshot.database.sha256 !== before.database.sha256,
    changedTables: tables.filter(
      (table) =>
        JSON.stringify(snapshot.database.tables[table]) !==
        JSON.stringify(before.database.tables[table]),
    ),
    productionListenerFingerprintChanged:
      JSON.stringify(
        before.host.listeners.filter((item) => [4174, 4319, 4320, 9333].includes(item.port)),
      ) !==
      JSON.stringify(
        host.listeners.filter((item) => [4174, 4319, 4320, 9333].includes(item.port)),
      ),
  };
  snapshot.checks = {
    apiPidChanged: receipt.pid !== before.receipt.pid,
    apiReceiptMatchesProcess: host.process.pid === receipt.pid,
    apiLoopbackListenerOwned: listener?.address === "127.0.0.1" && listener.pid === receipt.pid,
    apiReady:
      snapshot.health.status === 200 &&
      snapshot.health.body?.status === "ready" &&
      snapshot.health.body?.schemaVersion === "20",
    consistentBackupRetained:
      snapshot.backup.file.sha256 === before.backup.file.sha256 &&
      snapshot.backup.file.bytes === before.backup.file.bytes,
    configurationUnchanged: JSON.stringify(snapshot.configuration) === JSON.stringify(before.configuration),
    sourceInputsUnchanged: JSON.stringify(snapshot.source) === JSON.stringify(before.source),
    trackedDiffUnchanged: snapshot.trackedDiffSha256 === before.trackedDiffSha256,
    databaseQuickCheck: snapshot.database.quickCheck.every((row) => row.quick_check === "ok"),
    tableCountsNotReduced,
    databaseFactsUnchanged: snapshot.database.sha256 === before.database.sha256,
    webAndMcpListenersUnchanged:
      JSON.stringify(before.host.listeners.filter((item) => [4640, 4641].includes(item.port))) ===
      JSON.stringify(host.listeners.filter((item) => [4640, 4641].includes(item.port))),
    managerCannotTargetProduction:
      ![4174, 4319, 4320, 9333]
        .map((port) => host.listeners.find((item) => item.port === port)?.pid)
        .filter(Boolean)
        .includes(receipt.pid),
  };
  snapshot.passed = Object.values(snapshot.checks).every(Boolean);
}

writeFileSync(outputFile, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" });
process.stdout.write(
  `${JSON.stringify({ phase, passed: snapshot.passed, outputFile, receiptPid: receipt.pid })}\n`,
);
if (snapshot.passed === false) process.exitCode = 1;
