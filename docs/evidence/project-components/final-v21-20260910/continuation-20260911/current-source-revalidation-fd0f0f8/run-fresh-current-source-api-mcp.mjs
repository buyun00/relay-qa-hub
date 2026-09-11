import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../../..");
const node = process.execPath;
const productSourceCommit = "fd0f0f850f907b8a77aac8ec8b6a71b308bdd711";
const productPaths = [
  "apps/api/src",
  "apps/web/src",
  "apps/desktop/src",
  "apps/android/app/src/main",
  "apps/worker/src",
  "packages/domain/src",
  "packages/storage/src",
];
const buildBindingPaths = [
  ...productPaths,
  "packages/upload-contract/index.js",
  "packages/upload-contract/index.d.ts",
  "packages/upload-contract/package.json",
  "apps/api/package.json",
  "apps/api/tsconfig.json",
  "packages/storage/package.json",
  "packages/storage/tsconfig.json",
  "tsconfig.base.json",
  "package-lock.json",
];
const buildTargets = [
  {
    id: "storage",
    compiler: "packages/storage/node_modules/typescript/bin/tsc",
    project: "packages/storage/tsconfig.json",
    dist: "packages/storage/dist",
  },
  {
    id: "api",
    compiler: "apps/api/node_modules/typescript/bin/tsc",
    project: "apps/api/tsconfig.json",
    dist: "apps/api/dist",
  },
];
const runtimeScripts = [
  "scripts/project-components/run-preview-service.mjs",
  "scripts/project-components/preview-mcp.mjs",
  "scripts/project-components/management.smoke.mjs",
  "scripts/project-components/http-core.smoke.mjs",
  "scripts/project-components/mcp-core.smoke.mjs",
  "scripts/project-components/gm-business-loop.mjs",
];
const protectedPorts = [4174, 4319, 4320, 4639, 4640, 4641, 4642, 9333, 9433];
const runId = randomUUID();
const compact = runId.replaceAll("-", "").slice(0, 8);
const instanceId = `qa-hub-preview-fd0f0f8-${compact}`;
const runtimeRoot = resolve(
  "C:\\Users\\lin0\\.codex\\parallel-runtimes\\qa-hub-preview-fd0f0f8-current-source",
  runId,
  instanceId,
);
const evidenceRoot = resolve(here, "fresh-api-mcp", runId);
const proofPath = resolve(evidenceRoot, "proof.json");
mkdirSync(runtimeRoot, { recursive: true });
mkdirSync(evidenceRoot, { recursive: true });

const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const sha256Bytes = (value) => createHash("sha256").update(value).digest("hex");
const sha256 = (path) => sha256Bytes(readFileSync(path));
const git = (...args) =>
  execFileSync("git.exe", args, { cwd: root, encoding: "utf8" }).trim();

function filesWithin(directory) {
  const entries = [];
  const visit = (current) => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const absolute = resolve(current, item.name);
      if (item.isDirectory()) visit(absolute);
      else if (item.isFile()) entries.push(absolute);
      else throw new Error(`Non-regular build output refused: ${absolute}`);
    }
  };
  visit(resolve(root, directory));
  return entries.sort((a, b) => a.localeCompare(b, "en"));
}

function expectedTypeScriptOutputs(sourceDirectory, distDirectory) {
  const sourceRoot = resolve(root, sourceDirectory);
  const outputRoot = resolve(root, distDirectory);
  const sources = filesWithin(sourceDirectory).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".d.ts"),
  );
  const outputs = sources.flatMap((source) => {
    const stem = relative(sourceRoot, source).replace(/\.ts$/u, "");
    return [".js", ".js.map", ".d.ts", ".d.ts.map"].map((extension) =>
      resolve(outputRoot, `${stem}${extension}`),
    );
  });
  return { sources, outputs: outputs.sort((a, b) => a.localeCompare(b, "en")) };
}

function manifestForFiles(files) {
  const items = files.map((absolute) => ({
    file: relative(root, absolute).replaceAll("\\", "/"),
    bytes: statSync(absolute).size,
    sha256: sha256(absolute),
  }));
  return { items, aggregateSha256: sha256Bytes(JSON.stringify(items)) };
}

function trackedManifest(paths) {
  const files = git("ls-files", "--", ...paths)
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((file) => resolve(root, file));
  return manifestForFiles(files);
}

async function allocatePorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      server.unref();
      await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolvePromise);
      });
      servers.push(server);
    }
    const ports = servers.map((server) => {
      const address = server.address();
      assert(address && typeof address !== "string");
      return address.port;
    });
    assert.equal(new Set(ports).size, count);
    return ports;
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolvePromise, reject) =>
            server.close((error) => (error ? reject(error) : resolvePromise())),
          ),
      ),
    );
  }
}

function hostSnapshot(ports) {
  const script = String.raw`
$listeners = @()
$selectedPorts = @(${ports.join(",")})
$connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $selectedPorts -contains [int]$_.LocalPort })
$processes = @{}
foreach ($pidValue in @($connections | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)) {
  $processes[$pidValue] = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
}
foreach ($connection in $connections) {
  $process = $processes[[int]$connection.OwningProcess]
  $commandLine = if ($process) { [string]$process.CommandLine } else { $null }
  $listeners += [pscustomobject]@{
    port = [int]$connection.LocalPort
    address = $connection.LocalAddress
    pid = [int]$connection.OwningProcess
    sessionId = if ($process) { [int]$process.SessionId } else { $null }
    name = if ($process) { $process.Name } else { $null }
    executablePath = if ($process) { $process.ExecutablePath } else { $null }
    startedAt = if ($process) { $process.CreationDate.ToUniversalTime().ToString('o') } else { $null }
    commandLine = $commandLine
    commandLineSha256 = if ($commandLine) {
      $bytes = [Text.Encoding]::UTF8.GetBytes($commandLine)
      $sha = [Security.Cryptography.SHA256]::Create()
      try { [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
      finally { $sha.Dispose() }
    } else { $null }
  }
}
[pscustomobject]@{ listeners = @($listeners | Sort-Object port, pid) } | ConvertTo-Json -Depth 5 -Compress
`;
  const text = execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" },
  ).trim();
  if (!text) return [];
  const parsed = JSON.parse(text).listeners ?? [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function processIdentity(pid) {
  const script = String.raw`
$process = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop
[pscustomobject]@{
  pid = [int]$process.ProcessId
  parentPid = [int]$process.ParentProcessId
  sessionId = [int]$process.SessionId
  name = $process.Name
  executablePath = $process.ExecutablePath
  startedAt = $process.CreationDate.ToUniversalTime().ToString('o')
  commandLine = [string]$process.CommandLine
} | ConvertTo-Json -Depth 3 -Compress
`;
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8" },
    ),
  );
}

function sqliteReceipt(file, countTables) {
  assert(existsSync(file), `SQLite evidence missing: ${file}`);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    const applicationId = Object.values(db.prepare("PRAGMA application_id").get())[0];
    const userVersion = Object.values(db.prepare("PRAGMA user_version").get())[0];
    const tableCounts = Object.fromEntries(
      countTables.map((table) => [
        table,
        Number(db.prepare(`SELECT count(*) AS count FROM "${table}"`).get().count),
      ]),
    );
    const outboxByDestination = countTables.includes("outbox")
      ? db
          .prepare(
            "SELECT destination,status,count(*) AS count,sum(attempt_count) AS attempts FROM outbox GROUP BY destination,status ORDER BY destination,status",
          )
          .all()
          .map((row) => ({
            destination: row.destination,
            status: row.status,
            count: Number(row.count),
            attempts: Number(row.attempts),
          }))
      : [];
    assert.deepEqual(integrity, ["ok"]);
    assert.deepEqual(foreignKeys, []);
    const companions = ["-wal", "-shm"].map((suffix) => {
      const path = `${file}${suffix}`;
      return existsSync(path)
        ? { suffix, exists: true, bytes: statSync(path).size, sha256: sha256(path) }
        : { suffix, exists: false, bytes: 0, sha256: null };
    });
    return {
      path: file,
      bytes: statSync(file).size,
      sha256: sha256(file),
      applicationId,
      userVersion,
      integrity,
      foreignKeyViolations: foreignKeys,
      tableCounts,
      outboxByDestination,
      companions,
    };
  } finally {
    db.close();
  }
}

async function existingHealthSnapshot() {
  const targets = [
    ["production-api", "http://127.0.0.1:4319/api/v1/health/ready"],
    ["canonical-isolated-api", "http://127.0.0.1:4639/api/v1/health/ready"],
    ["canonical-isolated-web", "http://127.0.0.1:4640/"],
    ["canonical-server-mcp", "http://127.0.0.1:4641/health"],
    ["canonical-local-mcp", "http://127.0.0.1:4642/health"],
  ];
  const results = [];
  for (const [id, url] of targets) {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const text = await response.text();
    let declaredStatus = null;
    try {
      declaredStatus = JSON.parse(text).status ?? null;
    } catch {
      // Web root is HTML.
    }
    results.push({ id, url, httpStatus: response.status, declaredStatus });
  }
  return results;
}

class CdpClient {
  constructor(socket, expectedPort) {
    this.socket = socket;
    this.expectedPort = expectedPort;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== "number") return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`CDP_${message.error.code}_${message.error.message}`));
      else waiter.resolve(message.result);
    });
  }

  static async connect(url, expectedPort) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "ws:");
    assert.equal(parsed.hostname, "127.0.0.1");
    assert.equal(Number(parsed.port), expectedPort);
    const socket = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("INSPECTOR_CONNECT_TIMEOUT")), 10_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolvePromise();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("INSPECTOR_CONNECT_FAILED"));
        },
        { once: true },
      );
    });
    return new CdpClient(socket, expectedPort);
  }

  call(method, params = {}) {
    return new Promise((resolvePromise, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`INSPECTOR_TIMEOUT_${method}`));
      }, 10_000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
    assert.equal(result.exceptionDetails, undefined);
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function connectInspector(port, child) {
  let target;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    assert.equal(child.exitCode, null, "Owned process exited before inspector connection");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(500),
      });
      const items = response.ok ? await response.json() : [];
      target = items[0];
      if (target?.webSocketDebuggerUrl) break;
    } catch {
      // Bounded startup probe.
    }
    await delay(100);
  }
  assert(target?.webSocketDebuggerUrl, "Owned process inspector unavailable");
  const client = await CdpClient.connect(target.webSocketDebuggerUrl, port);
  await client.call("Runtime.enable");
  return client;
}

async function waitHealth(url, child) {
  let result;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    assert.equal(child.exitCode, null, `Owned process exited before ${url} became ready`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      result = response.ok ? await response.json() : null;
      if (result?.status === "ready")
        return {
          body: result,
          httpStatus: response.status,
          instanceHeader: response.headers.get("x-qa-hub-instance"),
          recordedAt: new Date().toISOString(),
        };
    } catch {
      // Bounded readiness probe.
    }
    await delay(100);
  }
  throw new Error(`Readiness timeout: ${url} / ${JSON.stringify(result)}`);
}

async function stopOwn(record) {
  assert(record.child && record.inspector);
  let signalListeners = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    signalListeners = await record.inspector.evaluate("process.listenerCount('SIGTERM')");
    if (signalListeners > 0) break;
    await delay(100);
  }
  assert(signalListeners > 0, `${record.id} did not install its graceful SIGTERM handler`);
  const requestedAt = new Date().toISOString();
  const scheduled = await record.inspector.evaluate(
    "setTimeout(()=>process.emit('SIGTERM'),50).unref();'OWN_SIGTERM_SCHEDULED'",
  );
  assert.equal(scheduled, "OWN_SIGTERM_SCHEDULED", `${record.id} shutdown was not scheduled`);
  record.inspector.close();
  record.inspector = undefined;
  for (let attempt = 0; attempt < 300 && record.child.exitCode === null; attempt += 1)
    await delay(100);
  assert.notEqual(record.child.exitCode, null, `${record.id} did not exit after graceful shutdown`);
  assert.equal(record.child.exitCode, 0, `${record.id} returned nonzero exit code`);
  record.cleanup = {
    method: "inspector process.emit(SIGTERM)",
    pid: record.child.pid,
    signalListeners,
    requestedAt,
    exitedAt: new Date().toISOString(),
    exitCode: record.child.exitCode,
  };
}

function runSmoke(id, args) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(node, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, `${id}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${id}: ${result.stderr || result.stdout}`);
  const line = result.stdout
    .trim()
    .split(/\r?\n/u)
    .findLast((candidate) => candidate.trim().startsWith("{"));
  assert(line, `${id}: JSON result missing`);
  const output = JSON.parse(line);
  assert.equal(output.passed, true, `${id}: output did not pass`);
  const evidence = resolve(output.evidence);
  const body = JSON.parse(readFileSync(evidence, "utf8"));
  assert.equal(body.passed, true, `${id}: evidence did not pass`);
  const observationTimes = body.checks
    .map((check) => check.recordedAt ?? check.at)
    .filter(Boolean)
    .sort();
  assert.equal(observationTimes.length, body.checks.length, `${id}: check timestamp missing`);
  assert(observationTimes.every((at) => new Date(at) >= new Date(startedAt)));
  const finishedAt = new Date().toISOString();
  assert(observationTimes.every((at) => new Date(at) <= new Date(finishedAt)));
  return {
    id,
    startedAt,
    finishedAt,
    evidence: relative(root, evidence).replaceAll("\\", "/"),
    evidenceBytes: statSync(evidence).size,
    evidenceSha256: sha256(evidence),
    runId: body.runId,
    instanceId: body.instanceId,
    checks: body.checks.length,
    firstObservationAt: observationTimes[0],
    lastObservationAt: observationTimes.at(-1),
  };
}

const head = git("rev-parse", "HEAD");
const remoteHead = git("rev-parse", "origin/codex/project-components-v2-1");
assert.equal(head, remoteHead, "Evidence branch is not synchronized before execution");
assert.equal(
  git(
    "diff",
    "--name-only",
    productSourceCommit,
    head,
    "--",
    ...buildBindingPaths,
    ...runtimeScripts,
  ),
  "",
  "Committed product paths differ from pinned source",
);
assert.equal(
  git("status", "--porcelain=v1", "--", ...buildBindingPaths, ...runtimeScripts),
  "",
  "Build/runtime inputs are dirty",
);
const sourceManifest = trackedManifest([...buildBindingPaths, ...runtimeScripts]);
const nodeReceipt = {
  path: node,
  version: process.version,
  bytes: statSync(node).size,
  sha256: sha256(node),
};

const buildReceipts = [];
for (const target of buildTargets) {
  const compiler = resolve(root, target.compiler);
  const beforeDistManifest = manifestForFiles(filesWithin(target.dist));
  const expected = expectedTypeScriptOutputs(
    target.project.replace(/\/tsconfig\.json$/u, "/src"),
    target.dist,
  );
  const startedAt = new Date().toISOString();
  const result = spawnSync(
    node,
    [compiler, "-p", resolve(root, target.project), "--pretty", "false", "--listEmittedFiles"],
    { cwd: root, encoding: "utf8", timeout: 180_000, windowsHide: true },
  );
  const finishedAt = new Date().toISOString();
  assert.equal(result.error, undefined, `${target.id} build: ${result.error?.message}`);
  assert.equal(result.status, 0, `${target.id} build failed: ${result.stderr || result.stdout}`);
  const emitted = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("TSFILE:"))
    .map((line) => line.slice("TSFILE:".length).trim())
    .map((file) => relative(root, resolve(file)).replaceAll("\\", "/"));
  assert(emitted.length > 0, `${target.id} build emitted no files`);
  const expectedRelative = expected.outputs.map((file) =>
    relative(root, file).replaceAll("\\", "/"),
  );
  assert.deepEqual([...emitted].sort((a, b) => a.localeCompare(b, "en")), expectedRelative);
  const distManifest = manifestForFiles(filesWithin(target.dist));
  assert.deepEqual(
    distManifest.items.map((item) => item.file),
    expectedRelative,
    `${target.id} dist contains missing or extra output files`,
  );
  buildReceipts.push({
    id: target.id,
    startedAt,
    finishedAt,
    compiler: {
      file: target.compiler,
      bytes: statSync(compiler).size,
      sha256: sha256(compiler),
    },
    project: target.project,
    compilerVersion: spawnSync(node, [compiler, "--version"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim(),
    sourceFileCount: expected.sources.length,
    expectedOutputFileCount: expected.outputs.length,
    beforeDistManifest,
    emitted,
    dist: target.dist,
    distManifest,
    exitCode: result.status,
  });
}
const buildFinishedAt = buildReceipts.at(-1).finishedAt;
assert.equal(realpathSync(resolve(root, "node_modules/@relay-qa-hub/storage")), resolve(root, "packages/storage"));
const apiRequire = createRequire(resolve(root, "apps/api/dist/main.js"));
const resolvedStorageEntry = realpathSync(apiRequire.resolve("@relay-qa-hub/storage"));
const expectedStorageEntry = realpathSync(resolve(root, "packages/storage/dist/index.js"));
const resolvedStorageWorkerEntry = realpathSync(
  resolve(root, "packages/storage/dist/sqlite-worker-entry.js"),
);
assert.equal(resolvedStorageEntry, expectedStorageEntry);
assert(
  readFileSync(resolve(root, "packages/storage/dist/sqlite-worker.js"), "utf8").includes(
    "sqlite-worker-entry.js",
  ),
  "Storage worker client does not resolve the hashed worker entry",
);
const [apiPort, webPort, mcpPort, desktopMcpPort, apiInspectorPort, mcpInspectorPort] =
  await allocatePorts(6);
const allOwnedPorts = [apiPort, webPort, mcpPort, desktopMcpPort, apiInspectorPort, mcpInspectorPort];
assert(allOwnedPorts.every((port) => !protectedPorts.includes(port)));

const config = {
  schemaVersion: 1,
  instanceId,
  sourceRoot: root,
  runtimeRoot,
  dataRoot: resolve(runtimeRoot, "data"),
  backupRoot: resolve(runtimeRoot, "backups"),
  downloadsRoot: resolve(runtimeRoot, "downloads"),
  logsRoot: resolve(runtimeRoot, "logs"),
  desktopRoot: resolve(runtimeRoot, "desktop"),
  apiHost: "127.0.0.1",
  apiPort,
  webHost: "127.0.0.1",
  webPort,
  mcpPort,
  desktopMcpPort,
  cookieName: `${instanceId}-session`,
  releaseChannel: instanceId,
  gmUserId: randomUUID(),
  secretsFile: resolve(runtimeRoot, "secrets.json"),
  peopleFile: resolve(runtimeRoot, "people.json"),
};
for (const directory of [
  config.dataRoot,
  config.backupRoot,
  config.downloadsRoot,
  config.logsRoot,
  config.desktopRoot,
])
  mkdirSync(directory, { recursive: true });
writeFileSync(
  config.secretsFile,
  `${JSON.stringify(
    {
      sessionSecret: randomBytes(48).toString("base64url"),
      debugToken: randomBytes(48).toString("base64url"),
      gmPassword: randomBytes(32).toString("base64url"),
    },
    null,
    2,
  )}\n`,
  { flag: "wx", mode: 0o600 },
);
writeFileSync(
  config.peopleFile,
  `${JSON.stringify({ schemaVersion: 4, projectKey: "LOCAL", people: [] }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
const instancePath = resolve(runtimeRoot, "instance.json");
writeFileSync(instancePath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
const { readParallelInstanceConfig } = await import(
  pathToFileURL(resolve(root, "apps/api/src/parallel-instance.ts")).href
);
const validatedConfig = readParallelInstanceConfig(instancePath);
assert.equal(validatedConfig.instanceId, instanceId);
assert.equal(validatedConfig.runtimeRoot, runtimeRoot);
const mainDatabasePath = resolve(config.dataRoot, "db/qa-hub.sqlite");
const componentDatabasePath = resolve(runtimeRoot, "components/runtime.sqlite");
const initialRuntimeState = {
  mainDatabaseExists: existsSync(mainDatabasePath),
  componentDatabaseExists: existsSync(componentDatabasePath),
  dataFiles: filesWithin(relative(root, config.dataRoot)).map((file) => relative(config.dataRoot, file)),
};
assert.equal(initialRuntimeState.mainDatabaseExists, false);
assert.equal(initialRuntimeState.componentDatabaseExists, false);
assert.deepEqual(initialRuntimeState.dataFiles, []);

const before = hostSnapshot([...protectedPorts, ...allOwnedPorts]);
const existingHealthBefore = await existingHealthSnapshot();
for (const port of allOwnedPorts)
  assert.equal(before.some((item) => item.port === port), false, `Owned port ${port} was occupied`);
const sanitizedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^QA_HUB_|^NODE_OPTIONS$|^ELECTRON_|PROXY$|^NODE_EXTRA_CA_CERTS$/iu.test(key),
  ),
);
const integrationEnvironmentVariableNames = Object.keys(sanitizedEnv).filter((name) =>
  /RELAY|QINGYU|JENKINS|CLOUDFLARE|UPLOAD/iu.test(name),
);
assert.deepEqual(integrationEnvironmentVariableNames, []);
const processRecords = [];
const startService = async (id, service, inspectorPort) => {
  const stdoutPath = resolve(config.logsRoot, `${id}.stdout.log`);
  const stderrPath = resolve(config.logsRoot, `${id}.stderr.log`);
  const stdout = openSync(stdoutPath, "wx");
  const stderr = openSync(stderrPath, "wx");
  const child = spawn(
    node,
    [
      `--inspect=${inspectorPort}`,
      resolve(root, "scripts/project-components/run-preview-service.mjs"),
      instancePath,
      service,
    ],
    {
      cwd: root,
      env: sanitizedEnv,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
    },
  );
  closeSync(stdout);
  closeSync(stderr);
  const record = {
    id,
    service,
    child,
    inspector: undefined,
    metadata: undefined,
    startedAt: undefined,
    inspectorPort,
    stdoutPath,
    stderrPath,
  };
  processRecords.push(record);
  const inspector = await connectInspector(inspectorPort, child);
  record.inspector = inspector;
  const metadata = await inspector.evaluate(
    "({pid:process.pid,execPath:process.execPath,argv:process.argv,versions:{node:process.versions.node}})",
  );
  assert.equal(metadata.pid, child.pid);
  assert.equal(resolve(metadata.execPath), resolve(node));
  assert.equal(resolve(metadata.argv[1]), resolve(root, "scripts/project-components/run-preview-service.mjs"));
  assert.equal(resolve(metadata.argv[2]), instancePath);
  assert.equal(metadata.argv[3], service);
  const identity = processIdentity(child.pid);
  assert.equal(identity.pid, child.pid);
  assert.equal(resolve(identity.executablePath), resolve(node));
  assert(identity.commandLine.includes(`--inspect=${inspectorPort}`));
  assert(identity.commandLine.includes(instancePath));
  assert(identity.commandLine.endsWith(` ${service}`));
  assert(new Date(identity.startedAt) > new Date(buildFinishedAt), `${id} started before build finished`);
  record.metadata = metadata;
  record.identity = identity;
  record.startedAt = identity.startedAt;
  return record;
};

let api;
let mcp;
let caught;
let apiHealth;
let mcpHealth;
const smokeRuns = [];
try {
  api = await startService("api", "api", apiInspectorPort);
  apiHealth = await waitHealth(
    `http://127.0.0.1:${apiPort}/api/v1/health/ready`,
    api.child,
  );
  mcp = await startService("mcp", "mcp", mcpInspectorPort);
  mcpHealth = await waitHealth(`http://127.0.0.1:${mcpPort}/health`, mcp.child);
  assert.equal(mcpHealth.instanceHeader, instanceId);

  smokeRuns.push(
    runSmoke("management", [
      resolve(root, "scripts/project-components/management.smoke.mjs"),
      instancePath,
    ]),
  );
  smokeRuns.push(
    runSmoke("http-core", [
      resolve(root, "scripts/project-components/http-core.smoke.mjs"),
      instancePath,
    ]),
  );
  const httpEvidence = JSON.parse(readFileSync(resolve(root, smokeRuns.at(-1).evidence), "utf8"));
  const project = httpEvidence.checks.find((item) => item.label === "GM create A")?.response;
  assert(project?.id, "Fresh HTTP project A missing");
  const disabled = httpEvidence.checks.find(
    (item) => item.label === "all optional components disabled",
  )?.response;
  assert.equal(disabled?.projectId, project.id);
  assert(disabled.items.every((item) => item.enabled === false));
  smokeRuns.push(
    runSmoke("server-mcp-core", [
      resolve(root, "scripts/project-components/mcp-core.smoke.mjs"),
      instancePath,
      project.id,
    ]),
  );
} catch (error) {
  caught = error;
} finally {
  for (const record of [...processRecords].reverse()) {
    try {
      if (record.child.exitCode === null && !record.inspector)
        record.inspector = await connectInspector(record.inspectorPort, record.child);
      await stopOwn(record);
    } catch (error) {
      caught ??= error;
    }
  }
}

let after;
for (let attempt = 0; attempt < 20; attempt += 1) {
  after = hostSnapshot([...protectedPorts, ...allOwnedPorts]);
  if (allOwnedPorts.every((port) => !after.some((entry) => entry.port === port))) break;
  await delay(250);
}
const ownedPortsRemaining = allOwnedPorts.filter((port) =>
  after.some((entry) => entry.port === port),
);
const protectedListenersUnchanged = protectedPorts.every(
  (port) =>
    JSON.stringify(after.filter((item) => item.port === port)) ===
    JSON.stringify(before.filter((item) => item.port === port)),
);
const existingHealthAfter = await existingHealthSnapshot();
const existingHealthUnchanged =
  JSON.stringify(existingHealthAfter) === JSON.stringify(existingHealthBefore);
if (!caught && ownedPortsRemaining.length > 0)
  caught = new Error(`Owned ports remain: ${ownedPortsRemaining.join(",")}`);
if (!caught && !protectedListenersUnchanged)
  caught = new Error("Protected listeners changed during fresh runtime attempt");
if (!caught && !existingHealthUnchanged)
  caught = new Error("Existing health probes changed during fresh runtime attempt");
if (caught) {
  writeFileSync(
    resolve(evidenceRoot, "failed-attempt.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "fresh-current-source-api-mcp-failed-attempt",
        runId,
        recordedAt: new Date().toISOString(),
        productSourceCommit,
        evidenceHead: head,
        instanceId,
        runtimeRoot,
        ownedPorts: allOwnedPorts,
        error: { name: caught.name ?? "Error", message: caught.message ?? String(caught) },
        processes: processRecords.map((record) => ({
          id: record.id,
          pid: record.child.pid,
          startedAt: record.startedAt ?? null,
          identity: record.identity ?? null,
          cleanup: record.cleanup ?? null,
          processPresentAfterCleanup: after.some((entry) => entry.pid === record.child.pid),
        })),
        smokeRuns,
        ownedPortsRemaining,
        protectedListenersUnchanged,
        existingHealthUnchanged,
        externalComponentsExecuted: false,
        userOnlyGatesExecuted: false,
        completionAllowed: false,
        runtimeRetained: true,
        passed: false,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  throw caught;
}
assert.equal(smokeRuns.length, 3);
assert.deepEqual(
  smokeRuns.map((run) => run.checks),
  [96, 15, 13],
);
const managementEvidence = JSON.parse(readFileSync(resolve(root, smokeRuns[0].evidence), "utf8"));
assert.deepEqual(managementEvidence.outbound, []);
assert.equal(
  git("status", "--porcelain=v1", "--", ...buildBindingPaths, ...runtimeScripts),
  "",
);
assert.equal(
  git(
    "diff",
    "--name-only",
    productSourceCommit,
    "HEAD",
    "--",
    ...buildBindingPaths,
    ...runtimeScripts,
  ),
  "",
);
assert.deepEqual(
  trackedManifest([...buildBindingPaths, ...runtimeScripts]),
  sourceManifest,
  "Tracked build/runtime inputs changed during execution",
);
for (const receipt of buildReceipts) {
  assert.deepEqual(
    manifestForFiles(filesWithin(receipt.dist)),
    receipt.distManifest,
    `${receipt.id} dist changed during execution`,
  );
}

const databaseReceipts = {
  main: sqliteReceipt(mainDatabasePath, [
    "outbox",
    "relay_receipts",
    "qingyu_bug_links",
    "integration_links",
    "builds",
  ]),
  components: sqliteReceipt(componentDatabasePath, ["build_tasks", "sync_tasks"]),
};
assert.equal(databaseReceipts.main.tableCounts.relay_receipts, 0);
assert.equal(databaseReceipts.main.tableCounts.qingyu_bug_links, 0);
assert.equal(databaseReceipts.main.tableCounts.integration_links, 0);
assert.equal(databaseReceipts.main.tableCounts.builds, 0);
assert.equal(databaseReceipts.components.tableCounts.build_tasks, 0);
assert.equal(databaseReceipts.components.tableCounts.sync_tasks, 0);
assert(
  databaseReceipts.main.outboxByDestination.every(
    (row) => !/relay|qingyu|jenkins|upload|build/iu.test(row.destination),
  ),
  "External destination appeared in fresh outbox",
);

const apiRecord = processRecords.find((record) => record.id === "api");
const mcpRecord = processRecords.find((record) => record.id === "mcp");
assert(apiRecord?.cleanup?.exitedAt && mcpRecord?.cleanup?.exitedAt);
for (const run of smokeRuns) {
  assert(new Date(run.firstObservationAt) >= new Date(apiRecord.startedAt));
  assert(new Date(run.lastObservationAt) <= new Date(apiRecord.cleanup.exitedAt));
  if (run.id === "server-mcp-core") {
    assert(new Date(run.firstObservationAt) >= new Date(mcpRecord.startedAt));
    assert(new Date(run.lastObservationAt) <= new Date(mcpRecord.cleanup.exitedAt));
  }
}

const processEvidence = processRecords.map((record) => ({
  id: record.id,
  service: record.service,
  pid: record.child.pid,
  startedAt: record.startedAt,
  buildFinishedAt,
  startedAfterBuild: new Date(record.startedAt) > new Date(buildFinishedAt),
  executable: record.metadata.execPath,
  argv: record.metadata.argv,
  identity: record.identity,
  nodeVersion: record.metadata.versions.node,
  inspectorPort: record.inspectorPort,
  cleanup: record.cleanup,
  stdout: {
    path: record.stdoutPath,
    bytes: statSync(record.stdoutPath).size,
    sha256: sha256(record.stdoutPath),
  },
  stderr: {
    path: record.stderrPath,
    bytes: statSync(record.stderrPath).size,
    sha256: sha256(record.stderrPath),
  },
  selectedLogEvents: readFileSync(record.stdoutPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(
      (entry) =>
        entry &&
        (entry.event === "parallel-instance.validated" ||
          entry.event === "preview-mcp.started" ||
          entry.msg === "Relay QA Hub API started" ||
          entry.msg === "stopping Relay QA Hub API"),
    ),
}));
const validationEvent = processEvidence
  .find((record) => record.id === "api")
  .selectedLogEvents.find((event) => event.event === "parallel-instance.validated");
assert.equal(validationEvent.instanceId, instanceId);
assert.equal(resolve(validationEvent.sourceRoot), root);
assert.equal(resolve(validationEvent.dataRoot), config.dataRoot);
assert.equal(validationEvent.apiPort, apiPort);
assert(
  processEvidence
    .find((record) => record.id === "api")
    .selectedLogEvents.some((event) => event.msg === "stopping Relay QA Hub API"),
);
assert(
  processEvidence
    .find((record) => record.id === "mcp")
    .selectedLogEvents.some(
      (event) =>
        event.event === "preview-mcp.started" &&
        event.instanceId === instanceId &&
        event.address === `http://127.0.0.1:${mcpPort}/mcp`,
    ),
);
const proof = {
  schemaVersion: 1,
  kind: "fresh-built-current-source-isolated-api-server-mcp-revalidation",
  runId,
  recordedAt: new Date().toISOString(),
  source: {
    productSourceCommit,
    evidenceHead: head,
    remoteHead,
    productPaths,
    buildBindingPaths,
    productPathsMatchPinnedCommit: true,
    buildAndRuntimeInputsMatchPinnedCommit: true,
    buildAndRuntimeInputsCleanBeforeAndAfter: true,
    trackedSourceManifest: sourceManifest,
    runtimeScriptHashes: runtimeScripts.map((file) => ({
      file,
      bytes: statSync(resolve(root, file)).size,
      sha256: sha256(resolve(root, file)),
    })),
  },
  build: {
    finishedAt: buildFinishedAt,
    node: nodeReceipt,
    receipts: buildReceipts,
    storageWorkspaceResolution: {
      requested: "node_modules/@relay-qa-hub/storage",
      resolved: relative(root, realpathSync(resolve(root, "node_modules/@relay-qa-hub/storage"))).replaceAll(
        "\\",
        "/",
      ),
      apiResolvedEntry: relative(root, resolvedStorageEntry).replaceAll("\\", "/"),
      expectedEntry: relative(root, expectedStorageEntry).replaceAll("\\", "/"),
      sqliteWorkerEntry: relative(root, resolvedStorageWorkerEntry).replaceAll("\\", "/"),
      sqliteWorkerEntrySha256: sha256(resolvedStorageWorkerEntry),
      exact: true,
    },
    distHashesStableThroughExecution: true,
  },
  instance: {
    instanceId,
    configPath: instancePath,
    runtimeRoot,
    ports: { apiPort, webPort, mcpPort, desktopMcpPort, apiInspectorPort, mcpInspectorPort },
    configSha256: sha256(instancePath),
    configValidatedByCurrentSource: true,
    initialRuntimeState,
    secretsFile: {
      path: config.secretsFile,
      bytes: statSync(config.secretsFile).size,
      sha256: sha256(config.secretsFile),
      keys: ["sessionSecret", "debugToken", "gmPassword"],
      valuesRecorded: false,
    },
    peopleFile: {
      path: config.peopleFile,
      bytes: statSync(config.peopleFile).size,
      sha256: sha256(config.peopleFile),
    },
    secretsPersistedOutsideRepository: true,
    secretsRecordedInEvidence: false,
    dataRetained: true,
  },
  processes: processEvidence,
  readiness: {
    api: apiHealth,
    serverMcp: mcpHealth,
    serverMcpInstanceHeaderExact: mcpHealth.instanceHeader === instanceId,
  },
  runs: smokeRuns,
  databases: databaseReceipts,
  coexistence: {
    protectedPorts,
    before,
    after,
    existingHealthBefore,
    existingHealthAfter,
    protectedListenersUnchanged: true,
    existingHealthUnchanged: true,
    ownedPortsReleased: true,
  },
  coverage: {
    exactFlaggedItemsTouchedByTheseHarnesses: 30,
    httpFlaggedItemsTouched: 23,
    serverMcpFlaggedItemsTouched: 7,
    eligibleNeedsRevalidationClears: [],
    eligibleNeedsRevalidationClearCount: 0,
    clearsWholeCoverageMatrix: false,
    reason:
      "The runs now have current runtime provenance, but each inventory item still needs an explicit expected/negative-branch review before its binary revalidation flag can be cleared.",
  },
  safety: {
    productionBusinessRequestsSent: false,
    productionProcessesSignaled: false,
    existingPreviewProcessesSignaled: false,
    externalComponentsExecuted: false,
    userOnlyGatesExecuted: false,
    forceKillUsed: false,
    exactOwnedGracefulShutdownOnly: true,
    integrationEnvironmentVariableNames,
    managementWitnessOutboundRequests: managementEvidence.outbound,
    externalStateTablesRemainEmpty: true,
  },
  scope: {
    currentSourceRuntimeBinding: "pass",
    isolatedBehaviorBatchStatus: "pass",
    overallAcceptanceStatus: "not_complete",
    completionAllowed: false,
    note: "This proves the three scoped API/server-MCP smoke suites executed on a fresh runtime built from the pinned product source. It does not clear inventory flags without item-level branch review and does not validate clients, external components, or user-only gates.",
  },
  passed: true,
};
writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx" });
console.log(
  JSON.stringify({
    passed: true,
    proof: proofPath,
    productSourceCommit,
    instanceId,
    processes: processEvidence.map(({ id, pid, startedAt, cleanup }) => ({ id, pid, startedAt, cleanup })),
    runs: smokeRuns.map(({ id, checks, evidence, evidenceSha256 }) => ({
      id,
      checks,
      evidence,
      evidenceSha256,
    })),
    eligibleNeedsRevalidationClearCount: 0,
    overallAcceptanceStatus: proof.scope.overallAcceptanceStatus,
  }),
);
