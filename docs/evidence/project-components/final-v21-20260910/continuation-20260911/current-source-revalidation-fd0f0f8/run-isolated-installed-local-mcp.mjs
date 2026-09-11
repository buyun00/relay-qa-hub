import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../../..");
const node = process.execPath;
const installedRoot =
  "C:\\Users\\lin0\\AppData\\Local\\Programs\\RelayQaHubPreview-v21-e2e-fresh-0910";
const executable = resolve(installedRoot, "RelayQaHubPreview-v21-e2e-fresh-0910.exe");
const canonicalConfigPath = resolve(installedRoot, "preview-instance.json");
const parallelInstancePath =
  "C:\\Users\\lin0\\.codex\\parallel-runtimes\\qa-hub-preview-v21-e2e-fresh-0910\\instance.json";
const productSourceCommit = "fd0f0f850f907b8a77aac8ec8b6a71b308bdd711";
const installedExeSha256 = "47e3d83120f29a6b2e0dc1fa54a2de6327c15c21620999b421b615a346e1fbac";
const projectId = "206eb1ea-7269-42dd-9d40-5a32e062d359";
const projectProof =
  "docs/evidence/project-components/runs/http-core-2026-09-11T00-47-56-276Z.json";
const productPaths = [
  "apps/api/src",
  "apps/web/src",
  "apps/desktop/src",
  "apps/android/app/src/main",
  "apps/worker/src",
  "packages/domain/src",
];
const runId = randomUUID();
const recordedAt = new Date().toISOString();
const runtimeRoot = resolve(
  "C:\\Users\\lin0\\.codex\\parallel-runtimes\\qa-hub-preview-v21-e2e-fresh-0910",
  "desktop-local-mcp-current-source",
  runId,
  "qa-hub-preview-v21-e2e-fresh-0910",
);
const evidenceRoot = resolve(here, "desktop-local-mcp", runId);
mkdirSync(runtimeRoot, { recursive: true });
mkdirSync(evidenceRoot, { recursive: true });

const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const git = (...args) =>
  execFileSync("git.exe", args, { cwd: root, encoding: "utf8" }).trim();

async function freePort() {
  return await new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });
}

function hostSnapshot(ports) {
  const ps = String.raw`
$rows = @()
foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -like 'RelayQaHub*' })) {
  $rows += [pscustomobject]@{
    pid = [int]$process.ProcessId
    parentPid = [int]$process.ParentProcessId
    sessionId = [int]$process.SessionId
    name = $process.Name
    executablePath = $process.ExecutablePath
    startedAt = $process.CreationDate.ToUniversalTime().ToString('o')
  }
}
$listeners = @()
foreach ($port in @(${ports.join(",")})) {
  foreach ($connection in @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
    $listeners += [pscustomobject]@{
      port = [int]$port
      address = $connection.LocalAddress
      pid = [int]$connection.OwningProcess
    }
  }
}
[pscustomobject]@{
  capturedAt = [DateTime]::UtcNow.ToString('o')
  processes = @($rows | Sort-Object pid)
  listeners = @($listeners | Sort-Object port, pid)
} | ConvertTo-Json -Depth 5 -Compress
`;
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8" },
    ),
  );
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
      const timer = setTimeout(() => reject(new Error("CDP_CONNECT_TIMEOUT")), 10_000);
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
          reject(new Error("CDP_CONNECT_FAILED"));
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
        reject(new Error(`CDP_TIMEOUT_${method}`));
      }, 10_000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(result.exceptionDetails, undefined);
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

const ports = {
  mcp: await freePort(),
  cdp: await freePort(),
  inspector: await freePort(),
};
assert.equal(new Set(Object.values(ports)).size, 3, "Allocated ports must be unique");
for (const port of Object.values(ports))
  assert(![4174, 4319, 4320, 4639, 4640, 4641, 4642, 9333, 9433].includes(port));

const watchedPorts = [4174, 4319, 4320, 4639, 4640, 4641, 4642, 9333, 9433, ...Object.values(ports)];
const before = hostSnapshot(watchedPorts);
const canonical = JSON.parse(readFileSync(canonicalConfigPath, "utf8"));
const previewConfig = {
  ...canonical,
  profileDirectory: resolve(runtimeRoot, "profile"),
  mcpPort: ports.mcp,
};
mkdirSync(previewConfig.profileDirectory, { recursive: true });
const previewConfigPath = resolve(runtimeRoot, "preview-instance.json");
writeFileSync(previewConfigPath, `${JSON.stringify(previewConfig, null, 2)}\n`, { flag: "wx" });
const parallel = JSON.parse(readFileSync(parallelInstancePath, "utf8"));
const mcpInstance = { ...parallel, desktopMcpPort: ports.mcp };
const mcpInstancePath = resolve(runtimeRoot, "instance.local-mcp.json");
writeFileSync(mcpInstancePath, `${JSON.stringify(mcpInstance, null, 2)}\n`, { flag: "wx" });

assert.equal(hash(executable), installedExeSha256, "Installed EXE hash changed");
assert.equal(git("status", "--porcelain=v1", "--", ...productPaths), "", "Product worktree is dirty");
assert.equal(
  git("diff", "--name-only", productSourceCommit, "HEAD", "--", ...productPaths),
  "",
  "Committed product source changed",
);
const projectEvidence = JSON.parse(readFileSync(resolve(root, projectProof), "utf8"));
const disabledCheck = projectEvidence.checks.find(
  (item) => item.label === "all optional components disabled" && item.response?.projectId === projectId,
);
assert(disabledCheck?.response?.items?.every((item) => item.enabled === false));

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^QA_HUB_|^NODE_OPTIONS$|^ELECTRON_|PROXY$|^NODE_EXTRA_CA_CERTS$/iu.test(key),
  ),
);
env.QA_HUB_PREVIEW_DESKTOP_CONFIG = previewConfigPath;
let child;
let inspector;
let mcpResult;
let mcpEvidence;
let metadata;
let cleanup;
let caught;
let stdout = "";
let stderr = "";
try {
  child = spawn(
    executable,
    [
      `--inspect=${ports.inspector}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${ports.cdp}`,
      `--user-data-dir=${previewConfig.profileDirectory}`,
      "--hidden",
    ],
    { cwd: installedRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (chunk) => {
    stdout = (stdout + String(chunk)).slice(-20_000);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-20_000);
  });
  let target;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    assert.equal(child.exitCode, null, "Temporary installed client exited during startup");
    try {
      const response = await fetch(`http://127.0.0.1:${ports.inspector}/json/list`, {
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
  assert(target?.webSocketDebuggerUrl, "Main inspector unavailable");
  inspector = await CdpClient.connect(target.webSocketDebuggerUrl, ports.inspector);
  await inspector.call("Runtime.enable");
  const electron =
    "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
  metadata = await inspector.evaluate(
    `(()=>{const app=${electron}.app;return {pid:process.pid,exe:process.execPath,profile:app.getPath('userData'),ready:app.isReady(),version:app.getVersion()}})()`,
  );
  assert.equal(metadata.pid, child.pid);
  assert.equal(resolve(metadata.exe), executable);
  assert.equal(resolve(metadata.profile), resolve(previewConfig.profileDirectory));
  assert.equal(metadata.version, "0.2.0-preview.20");
  let health;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${ports.mcp}/health`, {
        signal: AbortSignal.timeout(500),
      });
      health = response.ok ? await response.json() : null;
      if (health?.status === "ready") break;
    } catch {
      // Bounded readiness probe.
    }
    await delay(100);
  }
  assert.equal(health?.status, "ready", "Temporary local MCP did not become ready");
  const smoke = spawnSync(
    node,
    [
      resolve(root, "scripts/project-components/mcp-core.smoke.mjs"),
      mcpInstancePath,
      projectId,
      "--desktop",
      `Local MCP current source ${recordedAt}`,
    ],
    { cwd: root, encoding: "utf8", timeout: 120_000, windowsHide: true },
  );
  assert.equal(smoke.error, undefined, smoke.error?.message);
  assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
  const lines = smoke.stdout.trim().split(/\r?\n/u);
  mcpResult = JSON.parse(lines.at(-1));
  assert.equal(mcpResult.passed, true);
  assert.equal(mcpResult.checks, 13);
  mcpEvidence = resolve(mcpResult.evidence);
  const mcpBody = JSON.parse(readFileSync(mcpEvidence, "utf8"));
  assert.equal(mcpBody.url, `http://127.0.0.1:${ports.mcp}/mcp`);
  assert.equal(mcpBody.projectId, projectId);
  assert.equal(mcpBody.passed, true);
  assert.equal(mcpBody.checks.length, 13);
} catch (error) {
  caught = error;
} finally {
  if (child && child.exitCode === null) {
    try {
      if (!inspector) {
        let cleanupTarget;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            const response = await fetch(`http://127.0.0.1:${ports.inspector}/json/list`, {
              signal: AbortSignal.timeout(500),
            });
            const items = response.ok ? await response.json() : [];
            cleanupTarget = items[0];
            if (cleanupTarget?.webSocketDebuggerUrl) break;
          } catch {
            // Bounded reconnect to the exact owned inspector.
          }
          await delay(100);
        }
        if (cleanupTarget?.webSocketDebuggerUrl) {
          inspector = await CdpClient.connect(cleanupTarget.webSocketDebuggerUrl, ports.inspector);
          await inspector.call("Runtime.enable");
        }
      }
      assert(inspector, "Verified graceful channel unavailable");
      const electron =
        "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
      const ack = await inspector.evaluate(
        `(()=>{const app=${electron}.app;setTimeout(()=>app.quit(),50);return 'OWN_APP_QUIT_SCHEDULED'})()`,
      );
      assert.equal(ack, "OWN_APP_QUIT_SCHEDULED");
      inspector.close();
      inspector = undefined;
      for (let attempt = 0; attempt < 200 && child.exitCode === null; attempt += 1)
        await delay(100);
      assert.notEqual(child.exitCode, null, "Temporary client did not exit after app.quit");
      assert.equal(child.exitCode, 0, "Temporary client returned nonzero exit code");
      cleanup = { requested: "electron.app.quit", pid: child.pid, exitCode: child.exitCode };
    } catch (cleanupError) {
      caught ??= cleanupError;
      cleanup = { requested: "electron.app.quit", pid: child.pid, error: cleanupError.message };
    }
  } else if (child) {
    cleanup = { requested: null, pid: child.pid, exitCode: child.exitCode };
  }
}

let after;
for (let attempt = 0; attempt < 100; attempt += 1) {
  after = hostSnapshot(watchedPorts);
  if (
    JSON.stringify(after.processes) === JSON.stringify(before.processes) &&
    Object.values(ports).every(
      (port) => !after.listeners.some((entry) => entry.port === port),
    )
  )
    break;
  await delay(100);
}
const ownPids = new Set(child ? [child.pid] : []);
assert.deepEqual(after.processes, before.processes, "Pre-existing QA Hub processes changed");
for (const port of Object.values(ports))
  assert.equal(after.listeners.some((entry) => entry.port === port), false, `Owned port ${port} remains`);
for (const port of [4174, 4319, 4320, 4639, 4640, 4641, 4642, 9333, 9433]) {
  assert.deepEqual(
    after.listeners.filter((entry) => entry.port === port),
    before.listeners.filter((entry) => entry.port === port),
    `Pre-existing listener ${port} changed`,
  );
}
if (caught) throw caught;
assert(mcpEvidence, "MCP evidence path missing");

const relativeEvidence = mcpEvidence.slice(root.length + 1).replaceAll("\\", "/");
const proof = {
  schemaVersion: 1,
  kind: "installed-preview-isolated-profile-local-mcp-current-source",
  runId,
  recordedAt,
  productSourceCommit,
  evidenceHead: git("rev-parse", "HEAD"),
  installed: {
    executable,
    version: metadata.version,
    bytes: readFileSync(executable).length,
    sha256: hash(executable),
  },
  isolation: {
    runtimeRoot,
    profileDirectory: previewConfig.profileDirectory,
    configFile: previewConfigPath,
    ports,
    canonicalProfileUntouched:
      resolve(previewConfig.profileDirectory) !== resolve(canonical.profileDirectory),
    canonicalMcpPortUntouched: ports.mcp !== canonical.mcpPort,
    sourceApi: canonical.apiBaseUrl,
    externalComponentsDisabledProof: {
      file: projectProof,
      sha256: hash(resolve(root, projectProof)),
      projectId,
      allOptionalComponentsDisabled: true,
    },
  },
  process: {
    pid: child.pid,
    metadata,
    cleanup,
    preexistingProcessesBefore: before.processes,
    preexistingProcessesAfter: after.processes,
    preexistingProcessesUnchanged: true,
    preexistingListenersBefore: before.listeners,
    preexistingListenersAfter: after.listeners,
    preexistingListenersUnchanged: true,
    ownedPortsReleased: true,
  },
  execution: {
    evidence: relativeEvidence,
    evidenceBytes: readFileSync(mcpEvidence).length,
    evidenceSha256: hash(mcpEvidence),
    checks: mcpResult.checks,
    passed: mcpResult.passed,
    transport: `http://127.0.0.1:${ports.mcp}/mcp`,
    productActions: [
      "qa_login",
      "qa_list_projects",
      "qa_create_bug",
      "qa_add_comment",
      "qa_list_comments",
      "qa_bug_action:manual_complete",
      "qa_get_bug_context",
      "qa_bug_action:create_verification",
      "qa_bug_action:start_verification",
      "qa_bug_action:close",
    ],
  },
  safety: {
    productionPortsUsed: false,
    productionBusinessRequestsSent: false,
    externalComponentsExecuted: false,
    userOnlyGatesExecuted: false,
    canonicalInstalledProfileMutated: false,
    canonicalInstalledProcessSignaled: false,
    foreignProcessesSignaled: false,
    forceKillUsed: false,
    stdoutPersisted: false,
    stderrPersisted: false,
    ownPids: [...ownPids],
    diagnosticTailLengths: { stdout: stdout.length, stderr: stderr.length },
  },
  scope: {
    localMcpCurrentSourceStatus: "pass",
    overallAcceptanceStatus: "not_complete",
    completionAllowed: false,
    note: "This validates the installed preview local MCP through a fresh isolated desktop profile. It does not validate unrelated catalog tools, native toast visibility, Authenticode, external components, or user-only gates.",
  },
  passed: true,
};
const proofPath = resolve(evidenceRoot, "proof.json");
writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx" });
console.log(
  JSON.stringify({
    passed: true,
    proof: proofPath,
    evidence: relativeEvidence,
    checks: mcpResult.checks,
    pid: child.pid,
    cleanup,
  }),
);
