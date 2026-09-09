import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { redactMembershipEvidence, guardMembershipTool } from "./server-mcp-membership-live.mjs";

const sourcePath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(sourcePath), "../..");
const instancePath = "C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/instance.json";
const runtimeRoot = path.dirname(instancePath);
const installedRoot = "C:/Users/lin0/AppData/Local/Programs/RelayQaHubPreview";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fileSha = (file) => sha(fs.readFileSync(file));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const identity = (value) => ({
  userId: value.userId,
  projectId: value.projectId ?? null,
  isGm: value.isGm,
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const packageProof = "docs/evidence/project-components/exe-preview9-package-only/result.json";
const buildProof = "docs/evidence/project-components/exe-preview9-package-only/build-result.json";
const originalAsarSha = "6bc9f7508f663bd34c3896894369a7f9cafc6cc8c57542465315373a77790636";

export function inspectedFuse(bytes) {
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
  const offset = bytes.indexOf(sentinel);
  assert.ok(offset >= 0 && bytes.indexOf(sentinel, offset + 1) === -1, "EXACT_ONE_FUSE_WIRE");
  const base = offset + sentinel.length;
  assert.equal(bytes[base], 1, "FUSE_V1_REQUIRED");
  assert.ok(bytes[base + 1] >= 4, "INSPECT_FUSE_MISSING");
  assert.equal(bytes[base + 5], 0x31, "NODE_CLI_INSPECT_DISABLED");
  return {
    offset,
    version: bytes[base],
    length: bytes[base + 1],
    wire: bytes.subarray(base + 2, base + 2 + bytes[base + 1]).toString("ascii"),
    nodeCliInspectEnabled: true,
  };
}
export function makeCopyConfig(original, experiment, profileName) {
  assert.equal(original.instanceId, "qa-hub-preview-7c86");
  assert.equal(original.cookieName, "qa-hub-preview-7c86-session");
  assert.equal(new URL(original.apiBaseUrl).origin, "http://127.0.0.1:4419");
  assert.equal(new URL(original.csrfOrigin).origin, "http://127.0.0.1:4274");
  assert.ok(["quit-probe", "membership"].includes(profileName));
  const contained = path.relative(path.join(runtimeRoot, "acceptance"), path.resolve(experiment));
  assert.ok(contained && !contained.startsWith("..") && !path.isAbsolute(contained));
  assert.ok(path.basename(experiment).startsWith("local-mcp-membership-copy-"));
  const profileDirectory = path.join(experiment, original.instanceId, profileName);
  assert.notEqual(path.resolve(profileDirectory), path.resolve(original.profileDirectory));
  return {
    ...original,
    profileDirectory,
    mcpPort: 4470,
    updateManifestUrl: `${new URL(original.csrfOrigin).origin}/downloads/${original.instanceId}-local-membership-${path.basename(experiment)}-not-published.json`,
  };
}
export function guardLocalCall(name, args, scope) {
  guardMembershipTool(name, args, scope);
  assert.ok(
    !Object.keys(args).some((key) => /token|cookie|authorization/iu.test(key)),
    "NO_PER_CALL_TOKEN_PRETENCE",
  );
  assert.notEqual(name, "qa_set_membership", "REVOKE_ONLY_VIA_EXPLICIT_GM_AUXILIARY_HTTP");
}
export function guardAuxiliary(method, pathname, body, scope) {
  if (method === "POST" && pathname === "/api/v1/auth/gm/login") {
    assert.deepEqual(Object.keys(body).sort(), ["client", "password"]);
    assert.equal(body.client, "android");
    return;
  }
  assert.ok(scope.sharedId, "SHARED_ID_REQUIRED");
  assert.equal(method, "PATCH");
  assert.equal(pathname, `/api/v1/projects/${scope.projects[0]}/members/${scope.sharedId}`);
  assert.deepEqual(Object.keys(body).sort(), ["active", "expectedVersion"]);
  assert.ok(
    (body.active === false && body.expectedVersion === 1) ||
      (body.active === true && body.expectedVersion === 2),
    "EXACT_REVOKE_RESTORE_SEQUENCE",
  );
}
function hostSnapshot() {
  const command =
    "$ErrorActionPreference='Stop'; $ports=@(4419,4274,4420,4470,4471); @($ports | ForEach-Object { $port=$_; $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue); if($listeners.Count -eq 0){[pscustomobject]@{port=$port;listening=$false}} else {foreach($entry in $listeners){$owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$entry.OwningProcess); [pscustomobject]@{port=$port;listening=$true;address=$entry.LocalAddress;pid=[int]$owner.ProcessId;startedAt=$owner.CreationDate.ToUniversalTime().ToString('o');path=$owner.ExecutablePath}}}}) | ConvertTo-Json -Compress";
  return JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
    }),
  );
}
function inventory(directory) {
  const result = [];
  const walk = (folder) => {
    assert.ok(!fs.lstatSync(folder).isSymbolicLink(), "LINK_REFUSED");
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      assert.ok(!fs.lstatSync(file).isSymbolicLink(), "LINK_REFUSED");
      if (entry.isDirectory()) walk(file);
      else {
        assert.ok(entry.isFile());
        assert.ok(
          !/token|remembered|vault|cookies|desktop-runtime/iu.test(entry.name),
          "PRIVATE_PROFILE_FILE_REFUSED_IN_PACKAGE",
        );
        result.push({
          relative: path.relative(directory, file),
          bytes: fs.statSync(file).size,
          sha256: fileSha(file),
        });
      }
    }
  };
  walk(directory);
  assert.ok(result.length > 20 && result.length < 400);
  return result.sort((a, b) => a.relative.localeCompare(b.relative));
}
class Inspector {
  sequence = 0;
  pending = new Map();
  constructor(socket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const value = JSON.parse(String(event.data));
      const item = this.pending.get(value.id);
      if (!item) return;
      this.pending.delete(value.id);
      clearTimeout(item.timer);
      if (value.error) item.reject(new Error(`INSPECTOR_${value.error.code}`));
      else item.resolve(value.result);
    });
  }
  static async connect(url) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "ws:");
    assert.equal(parsed.hostname, "127.0.0.1");
    assert.equal(parsed.port, "4471");
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("INSPECTOR_CONNECT_TIMEOUT")), 10000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
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
    return new Inspector(socket);
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("INSPECTOR_TIMEOUT"));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const response = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(response.exceptionDetails, undefined, "INSPECTOR_EXPRESSION_FAILED");
    return response.result.value;
  }
  close() {
    this.socket.close();
  }
}

async function run() {
  assert.equal(path.resolve(process.cwd()), root);
  assert.equal(
    fileSha(instancePath),
    "2b8e97ce9b62d072b74eaf00015fb04f5b818d318203f2a91e59d15873da349b",
  );
  const instance = readJson(instancePath);
  assert.equal(instance.instanceId, "qa-hub-preview-7c86");
  assert.equal(instance.apiPort, 4419);
  const originalConfigPath = path.join(installedRoot, "preview-instance.json");
  assert.equal(
    fileSha(originalConfigPath),
    "aa98507fd6dbe84c360e845859af69c4f5ed1724975ecc10b7561015cf76ac83",
  );
  const original = readJson(originalConfigPath);
  const runId = randomUUID(),
    compact = runId.replaceAll("-", "");
  const experiment = path.join(runtimeRoot, "acceptance", `local-mcp-membership-copy-${runId}`);
  const output = path.join(
    root,
    "docs/evidence/project-components/local-mcp-membership-live",
    runId,
  );
  assert.ok(!fs.existsSync(experiment) && !fs.existsSync(output));
  fs.mkdirSync(experiment);
  fs.mkdirSync(path.join(experiment, "raw"));
  fs.mkdirSync(output, { recursive: true });
  const scope = {
    runId,
    projects: [randomUUID(), randomUUID()],
    names: [`LocalSingle${compact}`, `LocalShared${compact}`],
    keyPrefix: `LM${compact.slice(0, 10).toUpperCase()}`,
  };
  const secrets = new Set();
  const proof = {
    schemaVersion: 1,
    status: "running",
    runId,
    startedAt: new Date().toISOString(),
    scope,
    experiment,
    sourceSha256: fileSha(sourcePath),
    checks: [],
    requests: [],
    processes: [],
    boundary: {
      originalUiOperated: false,
      originalMcpCalled: false,
      originalProfileCopied: false,
      originalIdentityModified: false,
      liveProfileDraftFilesRead: false,
      sourceChanged: false,
      installedCopyOnly: true,
      gmAuxiliaryHttp: true,
      bugWrites: 0,
      componentWrites: 0,
      forceStop: false,
      installationOrPublication: false,
    },
  };
  const check = (label, actual, expected = true) => {
    const passed = JSON.stringify(actual) === JSON.stringify(expected);
    proof.checks.push({ label, actual, expected, passed });
    assert.ok(passed, label);
  };
  const remember = (value) => {
    if (Array.isArray(value)) return value.forEach(remember);
    if (value && typeof value === "object")
      for (const [key, entry] of Object.entries(value)) {
        if (
          /token|secret|password|cookie|csrf/iu.test(key) &&
          typeof entry === "string" &&
          entry.length > 8
        )
          secrets.add(entry);
        else if (typeof entry === "string") {
          try {
            const inner = JSON.parse(entry);
            if (inner && typeof inner === "object") remember(inner);
          } catch {
            /* plain text */
          }
        } else remember(entry);
      }
  };
  const safe = (value) => {
    const text = JSON.stringify(redactMembershipEvidence(value, secrets), null, 2) + "\n";
    for (const secret of secrets) assert.ok(!text.includes(secret), "SECRET_LITERAL_REFUSED");
    assert.ok(
      !/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(
        text,
      ),
      "SECRET_SHAPE_REFUSED",
    );
    return text;
  };
  const protectedPaths = [
    instancePath,
    originalConfigPath,
    path.join(installedRoot, "RelayQaHubPreview.exe"),
    path.join(installedRoot, "resources/app.asar"),
    path.join(original.profileDirectory, "remembered-login-name.json"),
    path.join(runtimeRoot, "downloads/qa-hub-preview-7c86-windows-latest.json"),
  ];
  const snapshotFiles = () =>
    protectedPaths.map((file) => ({
      path: file,
      bytes: fs.statSync(file).size,
      sha256: fileSha(file),
    }));
  let child = null,
    inspector = null,
    auxiliaryToken = null,
    rpcId = 0;
  async function rpc(label, method, params = {}, denial) {
    assert.ok(["initialize", "tools/list", "tools/call"].includes(method));
    if (method === "tools/call") guardLocalCall(params.name, params.arguments, scope);
    const request = { jsonrpc: "2.0", id: ++rpcId, method, params };
    const entry = {
      label,
      at: new Date().toISOString(),
      transport: "local_copy_4470",
      request: redactMembershipEvidence(request, secrets),
    };
    proof.requests.push(entry);
    const response = await fetch("http://127.0.0.1:4470/mcp", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify(request),
    });
    const bytes = Buffer.from(await response.arrayBuffer()),
      envelope = JSON.parse(bytes);
    remember(envelope);
    Object.assign(entry, {
      httpStatus: response.status,
      responseSha256: sha(bytes),
      response: redactMembershipEvidence(envelope, secrets),
      finishedAt: new Date().toISOString(),
    });
    if (!/(?:login|logout)/u.test(params.name ?? "")) {
      const rawPath = path.join(experiment, "raw", `local-${request.id}.json`);
      fs.writeFileSync(rawPath, bytes, { flag: "wx" });
      entry.rawPath = rawPath;
    }
    assert.equal(response.status, 200);
    assert.equal(envelope.id, request.id);
    assert.equal(envelope.error, undefined);
    if (method !== "tools/call") return envelope.result;
    const result = envelope.result,
      value = result.structuredContent ?? JSON.parse(result.content[0].text);
    assert.equal(result.isError, !!denial, label);
    if (denial) {
      check(label + " code", value.code, denial.code);
      check(label + " status", value.status, denial.status);
    }
    return value;
  }
  const tool = (label, name, args = {}, denial) =>
    rpc(label, "tools/call", { name, arguments: args }, denial);
  async function auxiliary(label, method, pathname, body) {
    guardAuxiliary(method, pathname, body, scope);
    const entry = {
      label,
      at: new Date().toISOString(),
      transport: "explicit_gm_auxiliary_4419",
      method,
      path: pathname,
      body: redactMembershipEvidence(body, secrets),
    };
    proof.requests.push(entry);
    const response = await fetch(`http://127.0.0.1:4419${pathname}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        "content-type": "application/json",
        ...(auxiliaryToken ? { authorization: `Bearer ${auxiliaryToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const bytes = Buffer.from(await response.arrayBuffer()),
      value = JSON.parse(bytes);
    remember(value);
    Object.assign(entry, {
      httpStatus: response.status,
      responseSha256: sha(bytes),
      response: redactMembershipEvidence(value, secrets),
      finishedAt: new Date().toISOString(),
    });
    if (method === "PATCH") {
      const rawPath = path.join(
        experiment,
        "raw",
        `auxiliary-${body.active ? "restore" : "disable"}.json`,
      );
      fs.writeFileSync(rawPath, bytes, { flag: "wx" });
      entry.rawPath = rawPath;
    }
    assert.equal(response.status, 200, label);
    return value;
  }
  const electronExpression =
    "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
  async function stopCopy(phase) {
    if (!child) return;
    if (child.exitCode === null) {
      assert.ok(inspector, "NO_NORMAL_QUIT_CHANNEL_RETAIN_COPY");
      const acknowledgment = await inspector.evaluate(
        `(() => { const app = ${electronExpression}.app; setTimeout(() => app.quit(), 50); return 'OWN_APP_QUIT_SCHEDULED'; })()`,
      );
      check(phase + " normal quit acknowledgment", acknowledgment, "OWN_APP_QUIT_SCHEDULED");
      inspector.close();
      inspector = null;
      for (let i = 0; i < 100 && child.exitCode === null; i++) await delay(100);
      assert.notEqual(child.exitCode, null, "COPY_DID_NOT_QUIT_NO_KILL_FALLBACK");
    }
    proof.processes.push({
      phase: phase + "_normal_quit",
      pid: child.pid,
      exitCode: child.exitCode,
      at: new Date().toISOString(),
    });
    check(phase + " process exit 0", child.exitCode, 0);
    child = null;
    const state = hostSnapshot();
    check(
      phase + " own ports released",
      state.filter((row) => [4470, 4471].includes(row.port)).every((row) => !row.listening),
    );
  }
  async function launchCopy(name, executable, copyConfigPath, copyConfig) {
    const state = hostSnapshot();
    check(
      name + " own ports vacant",
      state.filter((row) => [4470, 4471].includes(row.port)).every((row) => !row.listening),
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^QA_HUB_|^NODE_OPTIONS$|^ELECTRON_|PROXY$|^NODE_EXTRA_CA_CERTS$/iu.test(key),
      ),
    );
    env.QA_HUB_PREVIEW_DESKTOP_CONFIG = copyConfigPath;
    const stdout = fs.openSync(path.join(experiment, `${name}-stdout.txt`), "wx"),
      stderr = fs.openSync(path.join(experiment, `${name}-stderr.txt`), "wx");
    child = spawn(executable, ["--inspect=4471", "--hidden"], {
      cwd: path.dirname(executable),
      env,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
    });
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    child.on("error", () => undefined);
    proof.processes.push({
      phase: name + "_launch",
      pid: child.pid,
      executable,
      profile: copyConfig.profileDirectory,
      at: new Date().toISOString(),
    });
    let targets;
    for (let i = 0; i < 80; i++) {
      assert.equal(child.exitCode, null, "COPY_EXITED_BEFORE_INSPECTOR");
      try {
        const response = await fetch("http://127.0.0.1:4471/json/list", {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          targets = await response.json();
          break;
        }
      } catch {
        /* bounded own startup */
      }
      await delay(100);
    }
    assert.ok(targets?.length === 1, "OWN_INSPECTOR_NOT_AVAILABLE_RETAIN_ONLY");
    const bound = hostSnapshot();
    check(name + " inspector owner", bound.find((row) => row.port === 4471)?.pid, child.pid);
    check(
      name + " inspector loopback",
      bound.find((row) => row.port === 4471)?.address,
      "127.0.0.1",
    );
    inspector = await Inspector.connect(targets[0].webSocketDebuggerUrl);
    await inspector.call("Runtime.enable");
    const metadata = await inspector.evaluate(
      `(() => { const app=${electronExpression}.app; return {pid:process.pid,exe:process.execPath,profile:app.getPath('userData'),version:app.getVersion(),ready:app.isReady()}; })()`,
    );
    check(name + " evaluated own PID", metadata.pid, child.pid);
    check(name + " evaluated own exe", path.resolve(metadata.exe), path.resolve(executable));
    check(
      name + " evaluated isolated profile",
      path.resolve(metadata.profile),
      path.resolve(copyConfig.profileDirectory),
    );
    check(name + " version", metadata.version, "0.2.0-preview.9");
    const deadline = await inspector.evaluate(
      `(() => { const app=${electronExpression}.app; setTimeout(() => app.quit(), 240000).unref(); return 'OWN_NORMAL_QUIT_DEADLINE_ARMED'; })()`,
    );
    check(
      name + " four-minute own normal quit deadline",
      deadline,
      "OWN_NORMAL_QUIT_DEADLINE_ARMED",
    );
    for (let i = 0; i < 80; i++) {
      try {
        const response = await fetch("http://127.0.0.1:4470/health", {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) break;
      } catch {
        /* bounded own MCP startup */
      }
      if (i === 79) throw new Error("COPY_MCP_NOT_READY");
      await delay(100);
    }
    check(
      name + " MCP owned by copy",
      hostSnapshot().find((row) => row.port === 4470)?.pid,
      child.pid,
    );
    proof.processes.push({
      phase: name + "_isolated_and_quittable",
      ...metadata,
      at: new Date().toISOString(),
    });
  }
  try {
    proof.protectedBefore = snapshotFiles();
    proof.hostBefore = hostSnapshot();
    check("original PID", proof.hostBefore.find((row) => row.port === 4420)?.pid, 13564);
    check(
      "original start",
      Date.parse(proof.hostBefore.find((row) => row.port === 4420)?.startedAt),
      Date.parse("2026-09-09T01:44:08.4163170Z"),
    );
    check("API PID", proof.hostBefore.find((row) => row.port === 4419)?.pid, 22852);
    check(
      "API start",
      Date.parse(proof.hostBefore.find((row) => row.port === 4419)?.startedAt),
      Date.parse("2026-09-09T01:22:20.2728640Z"),
    );
    check("Web PID", proof.hostBefore.find((row) => row.port === 4274)?.pid, 20284);
    check(
      "Web start",
      Date.parse(proof.hostBefore.find((row) => row.port === 4274)?.startedAt),
      Date.parse("2026-09-08T17:52:36.5080910Z"),
    );
    for (const port of [4419, 4274, 4420]) {
      check(
        "single original listener " + port,
        proof.hostBefore.filter((row) => row.port === port).length,
        1,
      );
      check(
        "original loopback " + port,
        proof.hostBefore.find((row) => row.port === port)?.address,
        "127.0.0.1",
      );
    }
    check(
      "own ports vacant",
      proof.hostBefore
        .filter((row) => [4470, 4471].includes(row.port))
        .every((row) => !row.listening),
    );
    const packaged = readJson(path.join(root, packageProof)),
      build = readJson(path.join(root, buildProof));
    check("package proof status", packaged.status, "packaged_verified_not_published");
    check("build proof SHA", fileSha(path.join(root, buildProof)), packaged.build.sha256);
    check(
      "installed asar pinned",
      fileSha(path.join(installedRoot, "resources/app.asar")),
      originalAsarSha,
    );
    const packageRoot = build.receipt.packageDirectory;
    assert.ok(path.resolve(packageRoot).startsWith(path.resolve(runtimeRoot) + path.sep));
    proof.packageInputs = inventory(packageRoot);
    const appRoot = path.join(experiment, "app");
    fs.mkdirSync(appRoot);
    for (const entry of proof.packageInputs) {
      const from = path.join(packageRoot, entry.relative),
        to = path.join(appRoot, entry.relative);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      assert.equal(fileSha(to), entry.sha256);
    }
    const executable = path.join(appRoot, "RelayQaHubPreview.exe");
    check(
      "copy EXE exact installed bytes",
      fileSha(executable),
      fileSha(path.join(installedRoot, "RelayQaHubPreview.exe")),
    );
    check(
      "copy ASAR exact installed bytes",
      fileSha(path.join(appRoot, "resources/app.asar")),
      originalAsarSha,
    );
    proof.fuses = inspectedFuse(fs.readFileSync(executable));
    const asar = createRequire(path.join(root, "package.json"))("@electron/asar");
    proof.installedRelease = JSON.parse(
      asar.extractFile(path.join(appRoot, "resources/app.asar"), "release.json"),
    );
    check("copied release", proof.installedRelease.version, "0.2.0-preview.9");
    proof.copyConfigs = [];
    const actualPreviewConfigBytes = asar.extractFile(
      path.join(appRoot, "resources/app.asar"),
      "dist/preview-config.js",
    );
    const actualPreviewConfigModule = await import(
      `data:text/javascript;base64,${actualPreviewConfigBytes.toString("base64")}`
    );
    proof.actualPreviewConfigModuleSha256 = sha(actualPreviewConfigBytes);
    for (const name of ["quit-probe", "membership"]) {
      const config = makeCopyConfig(original, experiment, name),
        file = path.join(experiment, `${name}-preview-instance.json`);
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
      const parsed = actualPreviewConfigModule.loadPreviewDesktopIdentity(
        { ...process.env, QA_HUB_PREVIEW_DESKTOP_CONFIG: file },
        executable,
      );
      check(
        name + " actual installed parser profile",
        parsed.profileDirectory,
        config.profileDirectory,
      );
      check(
        name + " actual installed parser port",
        parsed.environment.QA_HUB_DESKTOP_MCP_PORT,
        "4470",
      );
      proof.copyConfigs.push({
        name,
        path: file,
        sha256: fileSha(file),
        profile: config.profileDirectory,
        mcpPort: config.mcpPort,
        updateManifestUrl: config.updateManifestUrl,
      });
    }
    const probe = readJson(proof.copyConfigs[0].path);
    await launchCopy("quit-probe", executable, proof.copyConfigs[0].path, probe);
    await stopCopy("quit-probe");
    const config = readJson(proof.copyConfigs[1].path);
    await launchCopy("membership", executable, proof.copyConfigs[1].path, config);
    // A real 404 at a fresh nonce endpoint isolates automatic update checks.
    const noFeed = await fetch(config.updateManifestUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    check("copy update endpoint genuinely unpublished", noFeed.status, 404);
    proof.unpublishedUpdateEndpoint = {
      url: config.updateManifestUrl,
      status: noFeed.status,
      bodySha256: sha(Buffer.from(await noFeed.arrayBuffer())),
    };
    const init = await rpc("initialize isolated copied EXE", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "local-copy-membership", version: "1" },
    });
    check("copy MCP .9", init.serverInfo.version, "0.2.0-preview.9");
    const catalog = await rpc("copy catalog", "tools/list");
    proof.catalog = { count: catalog.tools.length, names: catalog.tools.map((item) => item.name) };
    check("shared tools 90", catalog.tools.length, 90);
    const secretConfig = readJson(instance.secretsFile);
    assert.equal(typeof secretConfig.gmPassword, "string");
    secrets.add(secretConfig.gmPassword);
    const gm = await tool("copy GM login", "qa_login_gm", {
      request: { password: secretConfig.gmPassword },
    });
    check("copy GM identity", gm.isGm, true);
    check("GM ID", gm.userId, instance.gmUserId);
    auxiliaryToken = (
      await auxiliary("GM auxiliary session only", "POST", "/api/v1/auth/gm/login", {
        password: secretConfig.gmPassword,
        client: "android",
      })
    ).accessToken;
    assert.equal(typeof auxiliaryToken, "string");
    secrets.add(auxiliaryToken);
    const [a, b] = scope.projects;
    const off = (label, value) => {
      check(label + " keys", value.items.map((entry) => entry.key).sort(), [
        "build",
        "build_upload.single",
        "qingyu.sync",
        "relay.production",
        "upload.incremental",
      ]);
      check(
        label + " disabled",
        value.items.map((entry) => entry.enabled),
        [false, false, false, false, false],
      );
    };
    const projectIds = (value) => value.items.map((entry) => entry.id).sort();
    const fact = (value, userId) => {
      const user = value.items.find((entry) => entry.userId === userId);
      assert.ok(user);
      return {
        userId: user.userId,
        displayName: user.displayName,
        status: user.status,
        membershipStatus: user.membershipStatus,
        membershipVersion: user.membershipVersion,
        roles: [...user.roles].sort(),
      };
    };
    for (const [i, projectId] of scope.projects.entries()) {
      const created = await tool("create only new project " + i, "qa_create_project", {
        request: {
          id: projectId,
          key: scope.keyPrefix + (i ? "B" : "A"),
          name: `Local EXE copy membership ${i ? "B" : "A"} ${runId}`,
        },
      });
      check("project id " + i, created.id, projectId);
      off("initial " + i, await tool("initial five off " + i, "qa_get_components", { projectId }));
    }
    const single = await tool("single first A login", "qa_login", {
      projectId: a,
      name: scope.names[0],
    });
    proof.singleId = single.userId;
    check("single selects A", single.projectId, a);
    check("single employee", single.isGm, false);
    check(
      "single repeat same ID",
      (await tool("single repeated A login", "qa_login", { projectId: a, name: scope.names[0] }))
        .userId,
      single.userId,
    );
    check(
      "single directory A only",
      projectIds(await tool("single directory", "qa_list_projects")),
      [a],
    );
    const sharedA = await tool("shared first A login", "qa_login", {
      projectId: a,
      name: scope.names[1],
    });
    scope.sharedId = sharedA.userId;
    check("shared differs from single", sharedA.userId !== single.userId);
    check(
      "shared initially A only",
      projectIds(await tool("shared initial directory", "qa_list_projects")),
      [a],
    );
    const sharedB = await tool("shared B login same employee", "qa_login", {
      projectId: b,
      name: scope.names[1],
    });
    check("same global employee", sharedB.userId, sharedA.userId);
    check("shared selected B", sharedB.projectId, b);
    check(
      "shared exact directory A B",
      projectIds(await tool("shared A B directory", "qa_list_projects")),
      [a, b].sort(),
    );
    const usersA = await tool("A people before revoke", "qa_list_users", { projectId: a }),
      usersB = await tool("B people before revoke", "qa_list_users", { projectId: b });
    const originalA = fact(usersA, scope.sharedId),
      originalB = fact(usersB, scope.sharedId);
    proof.membershipBefore = { a: originalA, b: originalB };
    check("initial A version 1", originalA.membershipVersion, 1);
    check("initial B version 1", originalB.membershipVersion, 1);
    check(
      "single absent from B",
      usersB.items.some((entry) => entry.userId === single.userId),
      false,
    );
    const activeA = await tool("establish copy A cookie before revoke", "qa_login", {
      projectId: a,
      name: scope.names[1],
    });
    check("copy A session before revoke", identity(activeA), {
      userId: scope.sharedId,
      projectId: a,
      isGm: false,
    });
    const disabled = await auxiliary(
      "GM revokes only fresh shared A",
      "PATCH",
      `/api/v1/projects/${a}/members/${scope.sharedId}`,
      { active: false, expectedVersion: 1 },
    );
    check("A false version2", disabled, {
      projectId: a,
      userId: scope.sharedId,
      active: false,
      version: 2,
    });
    await tool(
      "existing A cookie refuses A read after revoke",
      "qa_list_bugs",
      { projectId: a },
      { status: 403, code: "PROJECT_NOT_ACCESSIBLE" },
    );
    await tool(
      "disabled A same-name login refuses reactivation",
      "qa_login",
      { projectId: a, name: scope.names[1] },
      { status: 403, code: "PROJECT_MEMBERSHIP_DISABLED" },
    );
    const againB = await tool("B login remains usable", "qa_login", {
      projectId: b,
      name: scope.names[1],
    });
    check("B same identity", identity(againB), {
      userId: scope.sharedId,
      projectId: b,
      isGm: false,
    });
    check(
      "only effective B directory",
      projectIds(await tool("B directory excludes disabled A", "qa_list_projects")),
      [b],
    );
    check(
      "B empty Bugs still readable",
      (await tool("B unaffected Bug read", "qa_list_bugs", { projectId: b })).items,
      [],
    );
    check(
      "B exact membership unchanged",
      fact(
        await tool("B exact personnel unchanged", "qa_list_users", { projectId: b }),
        scope.sharedId,
      ),
      originalB,
    );
    const restored = await auxiliary(
      "GM restores same fresh A membership",
      "PATCH",
      `/api/v1/projects/${a}/members/${scope.sharedId}`,
      { active: true, expectedVersion: 2 },
    );
    check("A true version3", restored, {
      projectId: a,
      userId: scope.sharedId,
      active: true,
      version: 3,
    });
    const finalA = await tool("restored A login same employee", "qa_login", {
      projectId: a,
      name: scope.names[1],
    });
    check("restored same ID", finalA.userId, scope.sharedId);
    check(
      "restored A B directory",
      projectIds(await tool("restored directory", "qa_list_projects")),
      [a, b].sort(),
    );
    check(
      "restored membership3",
      fact(await tool("restored A personnel", "qa_list_users", { projectId: a }), scope.sharedId)
        .membershipVersion,
      3,
    );
    check(
      "final B exact original",
      fact(await tool("final B personnel", "qa_list_users", { projectId: b }), scope.sharedId),
      originalB,
    );
    for (const projectId of scope.projects) {
      off("final " + projectId, await tool("final five off", "qa_get_components", { projectId }));
      check(
        "zero Bugs " + projectId,
        (await tool("final no Bug writes", "qa_list_bugs", { projectId })).items,
        [],
      );
    }
    await tool("final single login remains independent", "qa_login", {
      projectId: a,
      name: scope.names[0],
    });
    check(
      "single still only A",
      projectIds(await tool("single final directory", "qa_list_projects")),
      [a],
    );
    await tool("copy GM final audit login", "qa_login_gm", {
      request: { password: secretConfig.gmPassword },
    });
    for (const projectId of scope.projects) {
      const events = await tool("management audit " + projectId, "qa_list_management_events", {
        projectId,
      });
      for (const action of ["membership.disabled", "membership.activated"])
        check(
          `exact audit ${projectId} ${action}`,
          events.items.filter(
            (entry) => entry.subjectId === scope.sharedId && entry.action === action,
          ).length,
          projectId === a ? 1 : 0,
        );
    }
    proof.status = "passed_scoped_independent_copy_local_mcp_membership";
  } catch (error) {
    proof.status = "failed_retained";
    proof.failure = String(error);
    process.exitCode = 1;
  } finally {
    try {
      await stopCopy("membership");
      proof.updateArtifacts = proof.copyConfigs.map((entry) => {
        const directory = path.join(entry.profile, "updates");
        return {
          name: entry.name,
          files: fs.existsSync(directory) ? fs.readdirSync(directory) : [],
        };
      });
      check(
        "no copy installer or update artifacts",
        proof.updateArtifacts.every((entry) => entry.files.length === 0),
      );
    } catch (error) {
      proof.status = "failed_retained";
      proof.shutdownFailure = String(error);
      process.exitCode = 1;
    }
    try {
      proof.hostAfter = hostSnapshot();
      check(
        "original API and original EXE identities unchanged",
        proof.hostAfter.filter((row) => [4419, 4274, 4420].includes(row.port)),
        proof.hostBefore.filter((row) => [4419, 4274, 4420].includes(row.port)),
      );
      proof.protectedAfter = snapshotFiles();
      check(
        "original config identity binary and feed exact hashes unchanged",
        proof.protectedAfter,
        proof.protectedBefore,
      );
    } catch (error) {
      proof.status = "failed_retained";
      proof.preservationFailure = String(error);
      process.exitCode = 1;
    }
    proof.finishedAt = new Date().toISOString();
    proof.limits = [
      "Same installed preview9 executable/asar bytes in an independent copy/profile; not original GUI/profile testing.",
      "Local MCP uses the copy's real shared cookie session. There is no per-request actor-token override; GM revoke/restore are explicitly separate auxiliary HTTP calls.",
      "Original remembered identity is hashed without decoding; original draft databases/WAL/files are not read or copied.",
      "No physical device, whole-profile preservation, external components, update installation or publication is exercised.",
    ];
    fs.copyFileSync(sourcePath, path.join(output, "runner.mjs.txt"), fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(sourcePath, path.join(experiment, "runner.mjs"), fs.constants.COPYFILE_EXCL);
    const text = safe(proof);
    fs.writeFileSync(path.join(output, "proof.json"), text, { flag: "wx" });
    fs.writeFileSync(path.join(experiment, "proof.json"), text, { flag: "wx" });
    console.log(
      JSON.stringify({
        status: proof.status,
        runId,
        checks: proof.checks.length,
        requests: proof.requests.length,
        proof: path.join(output, "proof.json"),
        failure: proof.failure ?? proof.shutdownFailure,
        sha256: sha(text),
      }),
    );
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === sourcePath) {
  if (process.argv[2] === "--run") await run();
  else
    console.log(
      "not_run: explicit --run required; installed original MCP authentication is forbidden; only a new verified copy may run",
    );
}
