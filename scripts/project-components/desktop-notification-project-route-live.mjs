import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const sourcePath = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(sourcePath), "../..");
const BLOCKED_PORTS = new Set([4319, 4174, 4320]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const INSTANCE_ID = /^qa-hub-preview-[a-z0-9](?:[a-z0-9-]{1,54}[a-z0-9])$/u;
const INACCESSIBLE_TEXT = "通知所属项目当前不可访问，已保持当前项目并刷新项目列表。";
const TOAST_TITLE = "QA Hub · 这个单子已创建";
const TIMEOUT = 20_000;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fileSha256 = (file) => sha256(fs.readFileSync(file));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));

function containedBy(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalExisting(candidate, label) {
  assert.ok(path.isAbsolute(candidate), `${label}_MUST_BE_ABSOLUTE`);
  assert.ok(fs.existsSync(candidate), `${label}_MISSING`);
  let cursor = path.parse(path.resolve(candidate)).root;
  for (const part of path.resolve(candidate).slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    assert.ok(!fs.lstatSync(cursor).isSymbolicLink(), `${label}_LINK_REFUSED`);
  }
  return fs.realpathSync.native(candidate);
}

function blockedRoots(env = process.env) {
  return [
    "D:\\Relay-QA-Hub",
    "D:\\Relay-QA-Hub-Data",
    "D:\\Relay-QA-Hub-Config",
    "E:\\Relay-QA-Hub-Archives",
    path.join(env.LOCALAPPDATA ?? "C:\\", "Programs", "RelayQaHub"),
    path.join(env.LOCALAPPDATA ?? "C:\\", "Programs", "RelayQaHubPreview"),
    path.join(env.LOCALAPPDATA ?? "C:\\", "Relay QA Hub"),
    path.join(env.APPDATA ?? "C:\\", "Relay QA Hub"),
  ].map((item) => path.resolve(item));
}

function assertNoProductionOverlap(candidate, label, env = process.env) {
  for (const blocked of blockedRoots(env)) {
    assert.ok(
      !containedBy(blocked, candidate) && !containedBy(candidate, blocked),
      `${label}_PRODUCTION_OVERLAP`,
    );
  }
}

export function parseArguments(argv) {
  if (argv.length === 0) return { usageOnly: true, execute: false };
  const result = { instancePath: "", executablePath: "", execute: false, usageOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--run") {
      assert.equal(result.execute, false, "DUPLICATE_RUN_FLAG");
      result.execute = true;
      continue;
    }
    if (item === "--instance" || item === "--exe") {
      const value = argv[++index];
      assert.ok(value && !value.startsWith("--"), `${item.slice(2).toUpperCase()}_VALUE_REQUIRED`);
      const key = item === "--instance" ? "instancePath" : "executablePath";
      assert.equal(result[key], "", `DUPLICATE_${item.slice(2).toUpperCase()}`);
      result[key] = value;
      continue;
    }
    throw new Error(`UNKNOWN_ARGUMENT_${item}`);
  }
  assert.ok(result.instancePath, "EXPLICIT_INSTANCE_REQUIRED");
  assert.ok(result.executablePath, "EXPLICIT_EXE_REQUIRED");
  assert.ok(path.isAbsolute(result.instancePath), "INSTANCE_MUST_BE_ABSOLUTE");
  assert.ok(path.isAbsolute(result.executablePath), "EXE_MUST_BE_ABSOLUTE");
  return result;
}

function assertLoopbackUrl(value, port, label) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:", `${label}_HTTP_REQUIRED`);
  assert.equal(url.hostname, "127.0.0.1", `${label}_LOOPBACK_REQUIRED`);
  assert.equal(Number(url.port), port, `${label}_PORT_MISMATCH`);
  assert.equal(url.username, "", `${label}_CREDENTIAL_REFUSED`);
  assert.equal(url.password, "", `${label}_CREDENTIAL_REFUSED`);
  assert.ok(!BLOCKED_PORTS.has(port), `${label}_PRODUCTION_PORT_REFUSED`);
  return url;
}

export function validateStaticScope(instancePathInput, executablePathInput, env = process.env) {
  assert.equal(process.platform, "win32", "WINDOWS_INTERACTIVE_DESKTOP_REQUIRED");
  const instancePath = canonicalExisting(instancePathInput, "INSTANCE");
  const executablePath = canonicalExisting(executablePathInput, "EXE");
  const instance = readJson(instancePath);
  assert.equal(instance.schemaVersion, 1, "INSTANCE_SCHEMA_REFUSED");
  assert.ok(INSTANCE_ID.test(instance.instanceId), "PREVIEW_INSTANCE_ID_REQUIRED");
  const runtimeRoot = canonicalExisting(instance.runtimeRoot, "RUNTIME_ROOT");
  assert.equal(
    path.dirname(instancePath).toLowerCase(),
    runtimeRoot.toLowerCase(),
    "INSTANCE_ROOT_MISMATCH",
  );
  assertNoProductionOverlap(runtimeRoot, "RUNTIME_ROOT", env);
  assert.equal(
    canonicalExisting(instance.sourceRoot, "SOURCE_ROOT").toLowerCase(),
    canonicalExisting(sourceRoot, "RUNNER_SOURCE_ROOT").toLowerCase(),
    "INSTANCE_SOURCE_ROOT_MISMATCH",
  );
  for (const key of ["dataRoot", "backupRoot", "downloadsRoot", "logsRoot", "desktopRoot"]) {
    assert.ok(path.isAbsolute(instance[key]), `${key}_MUST_BE_ABSOLUTE`);
    assert.ok(containedBy(runtimeRoot, instance[key]), `${key}_OUTSIDE_RUNTIME`);
    assertNoProductionOverlap(instance[key], key, env);
  }
  assert.equal(instance.apiHost, "127.0.0.1", "API_LOOPBACK_REQUIRED");
  assert.equal(instance.webHost, "127.0.0.1", "WEB_LOOPBACK_REQUIRED");
  const ports = [instance.apiPort, instance.webPort, instance.mcpPort, instance.desktopMcpPort];
  assert.equal(new Set(ports).size, ports.length, "INSTANCE_PORTS_MUST_BE_DISTINCT");
  for (const port of ports) {
    assert.ok(Number.isSafeInteger(port) && port >= 1024 && port <= 65535, "INSTANCE_PORT_INVALID");
    assert.ok(!BLOCKED_PORTS.has(port), "PRODUCTION_PORT_REFUSED");
  }
  assert.equal(instance.cookieName, `${instance.instanceId}-session`, "COOKIE_SCOPE_MISMATCH");
  assert.equal(instance.releaseChannel, instance.instanceId, "RELEASE_CHANNEL_MISMATCH");
  assert.ok(UUID.test(instance.gmUserId), "GM_USER_ID_INVALID");
  for (const key of ["secretsFile", "peopleFile"]) {
    const selected = canonicalExisting(instance[key], key.toUpperCase());
    assert.ok(containedBy(runtimeRoot, selected), `${key}_OUTSIDE_RUNTIME`);
  }
  assert.equal(path.extname(executablePath).toLowerCase(), ".exe", "EXE_EXTENSION_REQUIRED");
  assertNoProductionOverlap(executablePath, "EXE", env);
  assert.ok(
    path.basename(executablePath).toLowerCase().startsWith("relayqahubpreview-"),
    "INSTANCE_NAMED_PREVIEW_EXE_REQUIRED",
  );
  assert.ok(
    path
      .dirname(executablePath)
      .toLowerCase()
      .includes(instance.instanceId.slice("qa-hub-preview-".length)),
    "EXE_INSTANCE_DIRECTORY_MISMATCH",
  );
  const installedRoot = path.dirname(executablePath);
  const asarPath = canonicalExisting(path.join(installedRoot, "resources", "app.asar"), "ASAR");
  const previewConfigPath = canonicalExisting(
    path.join(installedRoot, "preview-instance.json"),
    "PREVIEW_CONFIG",
  );
  const preview = readJson(previewConfigPath);
  assert.equal(preview.schemaVersion, 1, "PREVIEW_CONFIG_SCHEMA_REFUSED");
  assert.equal(preview.instanceId, instance.instanceId, "PREVIEW_INSTANCE_MISMATCH");
  assert.equal(preview.cookieName, instance.cookieName, "PREVIEW_COOKIE_MISMATCH");
  assert.equal(preview.appScheme, instance.instanceId, "PREVIEW_SCHEME_MISMATCH");
  assert.equal(preview.mcpPort, instance.desktopMcpPort, "PREVIEW_MCP_PORT_MISMATCH");
  assertLoopbackUrl(preview.apiBaseUrl, instance.apiPort, "PREVIEW_API");
  const csrf = assertLoopbackUrl(preview.csrfOrigin, instance.webPort, "PREVIEW_CSRF");
  const manifest = assertLoopbackUrl(preview.updateManifestUrl, instance.webPort, "PREVIEW_UPDATE");
  assert.equal(manifest.origin, csrf.origin, "PREVIEW_UPDATE_ORIGIN_MISMATCH");
  assert.ok(manifest.pathname.includes(instance.instanceId), "PREVIEW_UPDATE_CHANNEL_MISMATCH");
  assert.ok(
    containedBy(instance.desktopRoot, preview.profileDirectory),
    "PREVIEW_PROFILE_OUTSIDE_DESKTOP_ROOT",
  );
  assert.ok(
    preview.updatePublicKeyPem?.startsWith("-----BEGIN PUBLIC KEY-----"),
    "PREVIEW_KEY_INVALID",
  );
  return {
    instancePath,
    executablePath,
    installedRoot,
    asarPath,
    previewConfigPath,
    instance,
    preview,
    runtimeRoot,
    apiOrigin: `http://127.0.0.1:${instance.apiPort}`,
  };
}

export function redactEvidence(value, knownSecrets = new Set()) {
  if (typeof value === "string") {
    let result = value.replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [REDACTED]");
    result = result.replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu,
      "[REDACTED_JWT]",
    );
    for (const secret of knownSecrets)
      if (secret.length >= 4) result = result.replaceAll(secret, "[REDACTED]");
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => redactEvidence(item, knownSecrets));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /authorization|cookie|password|secret|token|csrf/iu.test(key)
        ? "[REDACTED]"
        : redactEvidence(item, knownSecrets),
    ]),
  );
}

export function classifyBugDetailRequest(entry, bugId) {
  let parsed;
  try {
    parsed = new URL(entry.url);
  } catch {
    return null;
  }
  if (entry.method !== "GET" || parsed.pathname !== `/api/v1/bugs/${bugId}` || parsed.search)
    return null;
  const headers = Object.fromEntries(
    Object.entries(entry.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
  return { projectId: headers["x-qa-project-id"] ?? null, requestId: entry.requestId ?? null };
}

function writeExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    {
      flag: "wx",
    },
  );
}

function copyTreeExclusive(from, to) {
  const stat = fs.lstatSync(from);
  assert.ok(!stat.isSymbolicLink(), "PACKAGE_LINK_REFUSED");
  if (stat.isDirectory()) {
    fs.mkdirSync(to);
    for (const name of fs.readdirSync(from))
      copyTreeExclusive(path.join(from, name), path.join(to, name));
    return;
  }
  assert.ok(stat.isFile(), "PACKAGE_SPECIAL_FILE_REFUSED");
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
}

async function freePort(forbidden) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    });
    if (!forbidden.has(port) && port >= 1024) return port;
  }
  throw new Error("FREE_LOOPBACK_PORT_UNAVAILABLE");
}

async function allocatePorts(instance) {
  const forbidden = new Set([
    ...BLOCKED_PORTS,
    instance.apiPort,
    instance.webPort,
    instance.mcpPort,
    instance.desktopMcpPort,
  ]);
  const result = {};
  for (const key of ["mcp", "cdp", "inspector"]) {
    result[key] = await freePort(forbidden);
    forbidden.add(result[key]);
  }
  return result;
}

const HOST_SNAPSHOT_PS = String.raw`
param([Parameter(Mandatory=$true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
$inputData = Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'RelayQaHub*.exe' } | ForEach-Object {
  $created = try { ([datetime]$_.CreationDate).ToUniversalTime().ToString('o') } catch { [string]$_.CreationDate }
  [pscustomobject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; name=[string]$_.Name; path=[string]$_.ExecutablePath; commandLine=[string]$_.CommandLine; startedAt=$created }
})
$listeners = @($inputData.ports | ForEach-Object {
  $port = [int]$_
  $rows = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  if ($rows.Count -eq 0) { [pscustomobject]@{ port=$port; listening=$false } }
  else { $rows | ForEach-Object { [pscustomobject]@{ port=$port; listening=$true; address=[string]$_.LocalAddress; pid=[int]$_.OwningProcess } } }
})
[pscustomobject]@{ capturedAt=[datetime]::UtcNow.ToString('o'); sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId; processes=$processes; listeners=$listeners } | ConvertTo-Json -Depth 6 -Compress
`;

export const TOAST_UIA_PS = String.raw`
param([Parameter(Mandatory=$true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$inputData = Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json
$root = [System.Windows.Automation.AutomationElement]::RootElement
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
function Ancestors($element) {
  $items = New-Object System.Collections.ArrayList
  $cursor = $element
  for ($i=0; $i -lt 16 -and $null -ne $cursor; $i++) { [void]$items.Add($cursor); $cursor=$walker.GetParent($cursor) }
  return $items
}
function Same($a,$b) { return [System.Windows.Automation.Automation]::Compare($a,$b) }
$deadline = [datetime]::UtcNow.AddMilliseconds([int]$inputData.timeoutMs)
do {
  $titles = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,[string]$inputData.title))))
  $bodies = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,[string]$inputData.body))))
  $matches = @()
  foreach($title in $titles) { foreach($body in $bodies) {
    $ta = @(Ancestors $title); $ba = @(Ancestors $body); $common = $null
    foreach($left in $ta) { if (@($ba | Where-Object { Same $left $_ }).Count -gt 0) { $common=$left; break } }
    if ($null -eq $common) { continue }
    $invokeElement=$common; $pattern=$null
    for($i=0; $i -lt 10 -and $null -ne $invokeElement; $i++) {
      if($invokeElement.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){ break }
      $pattern=$null; $invokeElement=$walker.GetParent($invokeElement)
    }
    if($null -ne $pattern){ $matches += [pscustomobject]@{title=$title;body=$body;invoke=$invokeElement;pattern=$pattern} }
  }}
  if($matches.Count -eq 1){
    $match=$matches[0]
    $evidence=[ordered]@{ observedAt=[datetime]::UtcNow.ToString('o'); title=$match.title.Current.Name; body=$match.body.Current.Name; titleOffscreen=$match.title.Current.IsOffscreen; bodyOffscreen=$match.body.Current.IsOffscreen; invokeName=$match.invoke.Current.Name; invokeControlType=$match.invoke.Current.ControlType.ProgrammaticName; invoked=$false }
    if($inputData.mode -eq 'observe-wait-invoke'){
      $evidence | ConvertTo-Json -Compress | Set-Content -LiteralPath $inputData.observedPath -Encoding utf8 -NoNewline
      $signalDeadline=[datetime]::UtcNow.AddMilliseconds([int]$inputData.signalTimeoutMs)
      while(-not (Test-Path -LiteralPath $inputData.signalPath) -and [datetime]::UtcNow -lt $signalDeadline){ Start-Sleep -Milliseconds 50 }
      if(-not (Test-Path -LiteralPath $inputData.signalPath)){ throw 'TOAST_INVOKE_SIGNAL_TIMEOUT' }
      $match.pattern.Invoke(); $evidence.invoked=$true; $evidence.invokedAt=[datetime]::UtcNow.ToString('o')
    }
    $evidence | ConvertTo-Json -Compress
    exit 0
  }
  if($matches.Count -gt 1){ throw 'AMBIGUOUS_EXACT_TOAST' }
  Start-Sleep -Milliseconds 100
} while([datetime]::UtcNow -lt $deadline)
throw 'EXACT_TOAST_NOT_FOUND'
`;

function sanitizeHostSnapshot(value, secrets) {
  return {
    capturedAt: value.capturedAt,
    sessionId: value.sessionId,
    processes: (value.processes ?? []).map((item) => ({
      pid: item.pid,
      parentPid: item.parentPid,
      name: item.name,
      path: item.path,
      startedAt: item.startedAt,
      commandLineSha256: sha256(String(item.commandLine ?? "")),
      commandLine: redactEvidence(
        String(item.commandLine ?? "").replace(/--[^ =]+(?:=|\s+)(?:"[^"]*"|\S+)/gu, (match) =>
          match.startsWith("--user-data-dir") ? match : match.split(/[=\s]/u)[0],
        ),
        secrets,
      ),
    })),
    listeners: value.listeners ?? [],
  };
}

function foreignFingerprint(snapshot, ownedRoot) {
  return snapshot.processes
    .filter((item) => !item.path || !containedBy(ownedRoot, item.path))
    .map(({ pid, parentPid, name, path: exe, startedAt, commandLineSha256 }) => ({
      pid,
      parentPid,
      name,
      path: exe,
      startedAt,
      commandLineSha256,
    }))
    .sort((a, b) => a.pid - b.pid);
}

function listenerFingerprint(snapshot, ownPorts) {
  return snapshot.listeners
    .filter((item) => !ownPorts.has(item.port))
    .map(({ port, listening, address = null, pid = null }) => ({
      port,
      listening,
      address,
      pid,
    }))
    .sort((a, b) => a.port - b.port || Number(a.pid ?? 0) - Number(b.pid ?? 0));
}

class CdpClient {
  constructor(socket, expectedPort) {
    this.socket = socket;
    this.expectedPort = expectedPort;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error)
          waiter.reject(new Error(`CDP_${message.error.code}_${message.error.message}`));
        else waiter.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? [])
        listener(message.params ?? {});
    });
  }
  static async connect(url, expectedPort) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "ws:", "CDP_WS_REQUIRED");
    assert.equal(parsed.hostname, "127.0.0.1", "CDP_LOOPBACK_REQUIRED");
    assert.equal(Number(parsed.port), expectedPort, "CDP_PORT_MISMATCH");
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP_CONNECT_TIMEOUT")), TIMEOUT);
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
          reject(new Error("CDP_CONNECT_FAILED"));
        },
        { once: true },
      );
    });
    return new CdpClient(socket, expectedPort);
  }
  on(method, listener) {
    const list = this.listeners.get(method) ?? [];
    list.push(listener);
    this.listeners.set(method, list);
  }
  call(method, params = {}, timeoutMs = TIMEOUT) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP_TIMEOUT_${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(result.exceptionDetails, undefined, "CDP_EXPRESSION_FAILED");
    return result.result?.value;
  }
  close() {
    this.socket.close();
  }
}

function snapshotExpression() {
  return `(async()=>{const text=(document.body?.innerText??'').slice(0,12000);const runtime=await window.qaHubDesktop?.getRuntimeInfo?.();const connection=await window.qaHubDesktop?.getConnectionStatus?.();const project=document.querySelector('select[aria-label="切换项目"]');const alert=document.querySelector('div.banner.error-banner[role="alert"]');return {url:location.href,ready:!!document.querySelector('.app-shell'),login:!!document.querySelector('.auth-form'),projectId:project?.value??null,projects:[...(project?.options??[])].map(o=>({id:o.value,name:o.textContent?.trim()??''})),createOpen:!!document.querySelector('.create-modal'),draft:document.querySelector('.create-modal textarea')?.value??null,detailOpen:!!document.querySelector('.detail-modal'),detailKey:document.querySelector('.detail-key')?.textContent?.trim()??null,detailError:document.querySelector('.detail-load-error,.detail-inline-warning')?.textContent?.trim()??null,alert:alert?.textContent?.trim()??null,inaccessibleExact:alert?.textContent?.trim()===${JSON.stringify(INACCESSIBLE_TEXT)},bodyText:text,runtime,connection};})()`;
}

async function waitFor(client, predicate, label, timeoutMs = TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await client.evaluate(snapshotExpression());
    if (predicate(value)) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`${label}_TIMEOUT_${JSON.stringify(redactEvidence(value))}`);
}

function inputExpression(selector, value) {
  return `(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!(input instanceof HTMLInputElement||input instanceof HTMLTextAreaElement||input instanceof HTMLSelectElement))return false;const proto=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:input instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value')?.set?.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event(input instanceof HTMLSelectElement?'change':'input',{bubbles:true}));return true})()`;
}

async function rendererLogin(client, projectId, name) {
  await waitFor(client, (s) => s.login, "LOGIN_FORM");
  assert.equal(
    await client.evaluate(inputExpression("#login-project", projectId)),
    true,
    "PROJECT_INPUT_MISSING",
  );
  assert.equal(
    await client.evaluate(inputExpression("#login-name", name)),
    true,
    "NAME_INPUT_MISSING",
  );
  assert.equal(
    await client.evaluate(
      "(()=>{const f=document.querySelector('.auth-form');if(!(f instanceof HTMLFormElement))return false;f.requestSubmit();return true})()",
    ),
    true,
  );
  return waitFor(
    client,
    (s) => s.ready && s.projectId === projectId && s.connection?.state === "connected",
    "DESKTOP_LOGIN",
  );
}

async function switchProject(client, projectId) {
  assert.equal(
    await client.evaluate(inputExpression('select[aria-label="切换项目"]', projectId)),
    true,
    "PROJECT_SWITCH_MISSING",
  );
  return waitFor(client, (s) => s.ready && s.projectId === projectId, "PROJECT_SWITCH");
}

async function putDraft(client, value) {
  assert.equal(
    await client.evaluate(
      `(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent??'').includes('新建 Bug'));if(!b)return false;b.click();return true})()`,
    ),
    true,
    "CREATE_BUTTON_MISSING",
  );
  await waitFor(client, (s) => s.createOpen, "CREATE_MODAL");
  assert.equal(
    await client.evaluate(inputExpression(".create-modal textarea", value)),
    true,
    "DRAFT_INPUT_MISSING",
  );
  await delay(400);
  return waitFor(client, (s) => s.createOpen && s.draft === value, "DRAFT_WRITE");
}

async function closeDetail(client) {
  await client.evaluate(
    "(()=>{const b=document.querySelector('.detail-close');if(!b)return false;b.click();return true})()",
  );
  await waitFor(client, (s) => !s.detailOpen, "DETAIL_CLOSE");
}

async function signOut(client) {
  assert.equal(
    await client.evaluate(
      "(()=>{const b=document.querySelector('button.profile');if(!b)return false;b.click();return true})()",
    ),
    true,
    "SIGN_OUT_MISSING",
  );
  await waitFor(client, (s) => s.login, "SIGN_OUT");
}

function makeBugBody(projectId, targetId, description) {
  const submission = randomUUID();
  return {
    submission,
    body: {
      submissionContractVersion: "1.1.0",
      projectId,
      clientSubmissionId: submission,
      title: description,
      description,
      expectedBehavior: "点击通知后进入正确项目与精确 Bug 详情",
      severity: "S2",
      priority: "P2",
      ownerId: targetId,
      verificationOwnerId: targetId,
      occurrence: {
        observedAt: new Date().toISOString(),
        platform: "windows",
        steps: ["由独立 actor 创建并分配给目标员工"],
        actualBehavior: description,
      },
      attachmentIds: [],
    },
  };
}

function criticalFiles(scope) {
  return [
    scope.instancePath,
    scope.executablePath,
    scope.asarPath,
    scope.previewConfigPath,
    scope.instance.secretsFile,
  ].map((file) => ({ path: file, bytes: fs.statSync(file).size, sha256: fileSha256(file) }));
}

async function runLive(scope) {
  const runId = randomUUID();
  const compact = runId.replaceAll("-", "");
  const experiment = path.join(
    scope.runtimeRoot,
    "acceptance",
    "desktop-notification-project-route-live",
    runId,
  );
  const evidence = path.join(
    sourceRoot,
    "docs",
    "evidence",
    "project-components",
    "desktop-notification-project-route-live",
    runId,
  );
  assert.ok(!fs.existsSync(experiment) && !fs.existsSync(evidence), "RUN_DIRECTORY_EXISTS");
  fs.mkdirSync(path.join(experiment, "raw"), { recursive: true });
  fs.mkdirSync(path.join(evidence, "raw"), { recursive: true });
  const knownSecrets = new Set();
  const proof = {
    schemaVersion: 1,
    runId,
    startedAt: new Date().toISOString(),
    instanceId: scope.instance.instanceId,
    passed: false,
    checks: [],
    fixtures: {},
    requests: [],
    processes: [],
    network: [],
    guarantees: {
      productionRootsRejected: blockedRoots(),
      productionPortsRejected: [...BLOCKED_PORTS],
      foreignProcessesAreNeverSignaled: true,
      noForceKillFallback: true,
      fixturesAreRetained: true,
    },
  };
  const check = (label, actual, expected = true) => {
    const passed =
      typeof expected === "function"
        ? expected(actual)
        : JSON.stringify(actual) === JSON.stringify(expected);
    proof.checks.push({
      label,
      passed,
      actual: redactEvidence(actual, knownSecrets),
      expected: typeof expected === "function" ? "predicate" : expected,
      at: new Date().toISOString(),
    });
    assert.ok(passed, label);
  };
  const ports = await allocatePorts(scope.instance);
  proof.ports = ports;
  const packageCopy = path.join(experiment, "installed-copy");
  const copiedExe = path.join(packageCopy, path.basename(scope.executablePath));
  writeExclusive(path.join(experiment, "host-snapshot.ps1"), HOST_SNAPSHOT_PS);
  writeExclusive(path.join(experiment, "toast-uia.ps1"), TOAST_UIA_PS);
  copyTreeExclusive(scope.installedRoot, packageCopy);
  check("copied EXE hash", fileSha256(copiedExe), fileSha256(scope.executablePath));
  check(
    "copied ASAR hash",
    fileSha256(path.join(packageCopy, "resources", "app.asar")),
    fileSha256(scope.asarPath),
  );
  const configFor = (name) => {
    const profileDirectory = path.join(experiment, "profiles", scope.instance.instanceId, name);
    return {
      ...scope.preview,
      profileDirectory,
      mcpPort: ports.mcp,
      updateManifestUrl: `${new URL(scope.preview.csrfOrigin).origin}/downloads/${scope.instance.instanceId}-notification-route-${runId}-not-published.json`,
    };
  };
  const configs = {};
  for (const name of ["quit-probe", "route"]) {
    configs[name] = configFor(name);
    const file = path.join(experiment, `${name}-preview-instance.json`);
    configs[name].file = file;
    writeExclusive(
      file,
      Object.fromEntries(Object.entries(configs[name]).filter(([key]) => key !== "file")),
    );
  }
  const watchedPorts = [
    ...BLOCKED_PORTS,
    scope.instance.apiPort,
    scope.instance.webPort,
    scope.instance.mcpPort,
    scope.instance.desktopMcpPort,
    ports.mcp,
    ports.cdp,
    ports.inspector,
  ];
  const snapshotHost = async (phase) => {
    const input = path.join(experiment, `host-${phase}-input.json`);
    writeExclusive(input, { ports: watchedPorts });
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(experiment, "host-snapshot.ps1"),
        "-InputPath",
        input,
      ],
      { windowsHide: true, timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024 },
    );
    const value = sanitizeHostSnapshot(JSON.parse(stdout), knownSecrets);
    writeExclusive(path.join(evidence, "raw", `host-${phase}.json`), value);
    return value;
  };
  const criticalBefore = criticalFiles(scope);
  let hostBefore;
  let child = null;
  let mainInspector = null;
  let renderer = null;
  let processEvents = [];
  const launch = async (phase, config) => {
    const stdoutFile = path.join(experiment, `${phase}-stdout.ndjson`);
    const stderrFile = path.join(experiment, `${phase}-stderr.txt`);
    const stdout = fs.createWriteStream(stdoutFile, { flags: "wx" });
    const stderr = fs.createWriteStream(stderrFile, { flags: "wx" });
    processEvents = [];
    let pendingLine = "";
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^QA_HUB_|^NODE_OPTIONS$|^ELECTRON_|PROXY$|^NODE_EXTRA_CA_CERTS$/iu.test(key),
      ),
    );
    env.QA_HUB_PREVIEW_DESKTOP_CONFIG = config.file;
    child = spawn(
      copiedExe,
      [
        `--inspect=${ports.inspector}`,
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${ports.cdp}`,
        `--user-data-dir=${config.profileDirectory}`,
        "--hidden",
      ],
      { cwd: packageCopy, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (chunk) => {
      const safe = redactEvidence(String(chunk), knownSecrets);
      stdout.write(safe);
      pendingLine += safe;
      for (;;) {
        const end = pendingLine.indexOf("\n");
        if (end < 0) break;
        const line = pendingLine.slice(0, end);
        pendingLine = pendingLine.slice(end + 1);
        try {
          processEvents.push(JSON.parse(line));
        } catch {
          /* retained as text */
        }
      }
    });
    child.stdout.on("end", () => stdout.end());
    child.stderr.on("data", (chunk) => stderr.write(redactEvidence(String(chunk), knownSecrets)));
    child.stderr.on("end", () => stderr.end());
    proof.processes.push({
      phase: `${phase}_launch`,
      pid: child.pid,
      executable: copiedExe,
      profile: config.profileDirectory,
      at: new Date().toISOString(),
    });
    let mainTarget;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      assert.equal(child.exitCode, null, `${phase}_EXITED_EARLY`);
      try {
        const response = await fetch(`http://127.0.0.1:${ports.inspector}/json/list`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          const items = await response.json();
          mainTarget = items[0];
          if (mainTarget?.webSocketDebuggerUrl) break;
        }
      } catch {
        /* bounded startup */
      }
      await delay(100);
    }
    assert.ok(mainTarget?.webSocketDebuggerUrl, `${phase}_MAIN_INSPECTOR_UNAVAILABLE`);
    mainInspector = await CdpClient.connect(mainTarget.webSocketDebuggerUrl, ports.inspector);
    await mainInspector.call("Runtime.enable");
    const electron =
      "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
    const metadata = await mainInspector.evaluate(
      `(()=>{const app=${electron}.app;setTimeout(()=>app.quit(),600000).unref();return {pid:process.pid,exe:process.execPath,profile:app.getPath('userData'),ready:app.isReady(),version:app.getVersion()}})()`,
    );
    check(`${phase} exact PID`, metadata.pid, child.pid);
    check(`${phase} exact copied EXE`, path.resolve(metadata.exe), path.resolve(copiedExe));
    check(
      `${phase} exact isolated profile`,
      path.resolve(metadata.profile),
      path.resolve(config.profileDirectory),
    );
    let pageTarget;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${ports.cdp}/json/list`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          const items = await response.json();
          pageTarget = items.find(
            (item) =>
              item.type === "page" && item.url.startsWith(`${scope.instance.instanceId}://app/`),
          );
          if (pageTarget?.webSocketDebuggerUrl) break;
        }
      } catch {
        /* bounded startup */
      }
      await delay(100);
    }
    assert.ok(pageTarget?.webSocketDebuggerUrl, `${phase}_RENDERER_CDP_UNAVAILABLE`);
    renderer = await CdpClient.connect(pageTarget.webSocketDebuggerUrl, ports.cdp);
    await renderer.call("Runtime.enable");
    await renderer.call("Network.enable");
    await renderer.call("Page.enable");
    renderer.on("Network.requestWillBeSent", ({ requestId, request, timestamp, wallTime }) => {
      const headers = Object.fromEntries(
        Object.entries(request.headers ?? {}).filter(([key]) =>
          ["accept", "content-type", "origin", "x-qa-project-id"].includes(key.toLowerCase()),
        ),
      );
      proof.network.push({
        phase,
        requestId,
        method: request.method,
        url: request.url,
        headers,
        timestamp,
        wallTime,
      });
    });
    renderer.on("Network.requestWillBeSentExtraInfo", ({ requestId, headers }) => {
      const entry = [...proof.network].reverse().find((item) => item.requestId === requestId);
      if (!entry) return;
      for (const [key, value] of Object.entries(headers ?? {})) {
        if (["accept", "content-type", "origin", "x-qa-project-id"].includes(key.toLowerCase())) {
          entry.headers[key] = value;
        }
      }
    });
    return metadata;
  };
  const stopOwn = async (phase) => {
    assert.ok(child && mainInspector, `${phase}_NO_GRACEFUL_CHANNEL`);
    const electron =
      "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
    const ack = await mainInspector.evaluate(
      `(()=>{const app=${electron}.app;setTimeout(()=>app.quit(),50);return 'OWN_APP_QUIT_SCHEDULED'})()`,
    );
    check(`${phase} graceful quit acknowledged`, ack, "OWN_APP_QUIT_SCHEDULED");
    renderer?.close();
    renderer = null;
    mainInspector.close();
    mainInspector = null;
    for (let attempt = 0; attempt < 150 && child.exitCode === null; attempt += 1) await delay(100);
    check(`${phase} exact child exited`, child.exitCode !== null, true);
    check(`${phase} exit code`, child.exitCode, 0);
    proof.processes.push({
      phase: `${phase}_quit`,
      pid: child.pid,
      exitCode: child.exitCode,
      at: new Date().toISOString(),
    });
    child = null;
  };
  const eventFor = async (predicate, label, timeoutMs = TIMEOUT) => {
    const deadline = Date.now() + timeoutMs;
    do {
      const item = processEvents.find(predicate);
      if (item) return item;
      await delay(50);
    } while (Date.now() < deadline);
    throw new Error(`${label}_APP_EVENT_TIMEOUT`);
  };
  const api = async (label, method, pathname, options = {}) => {
    const parsedPath = new URL(pathname, "http://local.invalid");
    const permitted =
      (method === "GET" && parsedPath.pathname === "/api/v1/health/ready" && !parsedPath.search) ||
      (method === "POST" &&
        [
          "/api/v1/auth/gm/login",
          "/api/v1/auth/login",
          "/api/v1/gm/projects",
          "/api/v1/bugs",
        ].includes(parsedPath.pathname) &&
        !parsedPath.search) ||
      (method === "GET" &&
        /^\/api\/v1\/projects\/[0-9a-f-]{36}\/users$/u.test(parsedPath.pathname) &&
        !parsedPath.search) ||
      (method === "GET" &&
        parsedPath.pathname === "/api/v1/notifications" &&
        [...parsedPath.searchParams.keys()].every((key) =>
          ["projectId", "unreadOnly", "limit"].includes(key),
        )) ||
      (method === "PUT" &&
        /^\/api\/v1\/gm\/projects\/[0-9a-f-]{36}\/members\/[0-9a-f-]{36}$/u.test(
          parsedPath.pathname,
        ) &&
        !parsedPath.search);
    assert.ok(permitted, `HTTP_ROUTE_REFUSED_${method}_${parsedPath.pathname}`);
    if (parsedPath.pathname === "/api/v1/bugs") {
      assert.ok(UUID.test(options.projectId), "BUG_PROJECT_HEADER_REQUIRED");
      assert.equal(options.body?.projectId, options.projectId, "BUG_PROJECT_SCOPE_MISMATCH");
      assert.equal(
        options.key,
        `submission:${options.body.clientSubmissionId}:commit`,
        "BUG_IDEMPOTENCY_SCOPE_MISMATCH",
      );
    }
    const requestEntry = {
      label,
      method,
      path: pathname,
      projectId: options.projectId ?? null,
      request: redactEvidence(options.body ?? null, knownSecrets),
      at: new Date().toISOString(),
    };
    proof.requests.push(requestEntry);
    const response = await fetch(scope.apiOrigin + pathname, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        accept: "application/vnd.relay-qa-hub.v1.1+json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.projectId ? { "x-qa-project-id": options.projectId } : {}),
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.key ? { "idempotency-key": options.key } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const value = bytes.length ? JSON.parse(bytes.toString("utf8")) : null;
    requestEntry.status = response.status;
    requestEntry.responseSha256 = sha256(bytes);
    requestEntry.response = redactEvidence(value, knownSecrets);
    check(`${label} status`, response.status, options.status ?? 200);
    if (!pathname.startsWith("/api/v1/auth/"))
      writeExclusive(
        path.join(experiment, "raw", `http-${String(proof.requests.length).padStart(3, "0")}.json`),
        redactEvidence(value, knownSecrets),
      );
    return value;
  };
  const toastWatcher = async (label, body) => {
    const input = path.join(experiment, `${label}-toast-input.json`),
      observedPath = path.join(experiment, `${label}-toast-observed.json`),
      signalPath = path.join(experiment, `${label}-toast-invoke.signal`);
    writeExclusive(input, {
      mode: "observe-wait-invoke",
      title: TOAST_TITLE,
      body,
      timeoutMs: 30_000,
      signalTimeoutMs: 20_000,
      observedPath,
      signalPath,
    });
    const promise = execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(experiment, "toast-uia.ps1"),
        "-InputPath",
        input,
      ],
      { windowsHide: true, timeout: 55_000, maxBuffer: 1024 * 1024 },
    );
    for (let attempt = 0; attempt < 300 && !fs.existsSync(observedPath); attempt += 1)
      await delay(100);
    assert.ok(fs.existsSync(observedPath), `${label}_REAL_TOAST_NOT_OBSERVED`);
    const observed = readJson(observedPath);
    check(`${label} exact toast title`, observed.title, TOAST_TITLE);
    check(`${label} exact toast body`, observed.body, body);
    check(`${label} toast title visible`, observed.titleOffscreen, false);
    check(`${label} toast body visible`, observed.bodyOffscreen, false);
    writeExclusive(path.join(evidence, "raw", `${label}-toast-observed.json`), observed);
    return {
      observed,
      invoke: async () => {
        writeExclusive(signalPath, `${new Date().toISOString()}\n`);
        const { stdout } = await promise;
        const result = JSON.parse(stdout);
        check(`${label} UIAutomation Invoke`, result.invoked, true);
        writeExclusive(path.join(evidence, "raw", `${label}-toast-invoked.json`), result);
        return result;
      },
    };
  };
  const observeToast = async (label, body) => {
    const input = path.join(experiment, `${label}-toast-input.json`);
    writeExclusive(input, { mode: "observe", title: TOAST_TITLE, body, timeoutMs: 30_000 });
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(experiment, "toast-uia.ps1"),
        "-InputPath",
        input,
      ],
      { windowsHide: true, timeout: 35_000, maxBuffer: 1024 * 1024 },
    );
    const result = JSON.parse(stdout);
    check(
      `${label} exact native toast visible`,
      result.title === TOAST_TITLE &&
        result.body === body &&
        result.titleOffscreen === false &&
        result.bodyOffscreen === false,
      true,
    );
    writeExclusive(path.join(evidence, "raw", `${label}-toast-observed.json`), result);
    return result;
  };
  try {
    hostBefore = await snapshotHost("before");
    check("interactive desktop session", hostBefore.sessionId > 0, true);
    check(
      "input preview has no running process",
      hostBefore.processes.filter(
        (item) => path.resolve(item.path || "C:\\missing") === path.resolve(scope.executablePath),
      ).length,
      0,
    );
    check(
      "same instance has no running process",
      hostBefore.processes.filter((item) =>
        String(item.path)
          .toLowerCase()
          .includes(scope.instance.instanceId.slice("qa-hub-preview-".length)),
      ).length,
      0,
    );
    for (const port of [ports.mcp, ports.cdp, ports.inspector])
      check(
        `new port ${port} vacant`,
        hostBefore.listeners.filter((item) => item.port === port && item.listening).length,
        0,
      );
    const ready = await api(
      "read-only readiness before any business write",
      "GET",
      "/api/v1/health/ready",
    );
    check("isolated API ready", ready.status, "ready");
    await launch("quit-probe", configs["quit-probe"]);
    await stopOwn("quit-probe");
    const afterProbe = await snapshotHost("after-quit-probe");
    check(
      "foreign processes unchanged by quit probe",
      foreignFingerprint(afterProbe, packageCopy),
      foreignFingerprint(hostBefore, packageCopy),
    );
    for (const port of [ports.mcp, ports.cdp, ports.inspector])
      check(
        `probe port ${port} released`,
        afterProbe.listeners.filter((item) => item.port === port && item.listening).length,
        0,
      );

    // Business writes start only after the copied EXE has proved its exact PID, profile and graceful exit.
    const secrets = readJson(scope.instance.secretsFile);
    knownSecrets.add(secrets.gmPassword);
    const gm = await api("GM login", "POST", "/api/v1/auth/gm/login", {
      body: { password: secrets.gmPassword, client: "android" },
    });
    knownSecrets.add(gm.accessToken);
    check("GM identity", gm.isGm, true);
    const projects = [];
    for (const suffix of ["A", "B"])
      projects.push(
        await api(`create project ${suffix}`, "POST", "/api/v1/gm/projects", {
          token: gm.accessToken,
          body: {
            id: randomUUID(),
            key: `N${compact.slice(0, 10)}${suffix}`,
            name: `通知路由${suffix}-${compact.slice(0, 8)}`,
          },
        }),
      );
    const [projectA, projectB] = projects;
    const targetName = `NotifyTarget${compact.slice(0, 12)}`,
      actorName = `NotifyActor${compact.slice(0, 12)}`;
    const login = (label, name, projectId) =>
      api(label, "POST", "/api/v1/auth/login", { body: { name, projectId, client: "android" } });
    const targetA = await login("target joins A", targetName, projectA.id);
    knownSecrets.add(targetA.accessToken);
    const targetB = await login("same target joins B", targetName, projectB.id);
    knownSecrets.add(targetB.accessToken);
    const actorA = await login("separate actor joins A", actorName, projectA.id);
    knownSecrets.add(actorA.accessToken);
    const actorB = await login("same separate actor joins B", actorName, projectB.id);
    knownSecrets.add(actorB.accessToken);
    check("same target identity A B", targetB.userId, targetA.userId);
    check("same actor identity A B", actorB.userId, actorA.userId);
    check("actor distinct", actorA.userId !== targetA.userId, true);
    proof.fixtures = {
      projectA,
      projectB,
      target: { userId: targetA.userId, name: targetName },
      actorA: { userId: actorA.userId, name: actorName },
    };
    await launch("route-1", configs.route);
    await rendererLogin(renderer, projectA.id, targetName);

    const description1 = `通知路由A1-${compact}`;
    const bug1Input = makeBugBody(projectA.id, targetA.userId, description1);
    const created1 = await api("actor creates assigned A1 Bug", "POST", "/api/v1/bugs", {
      token: actorA.accessToken,
      projectId: projectA.id,
      key: `submission:${bug1Input.submission}:commit`,
      body: bug1Input.body,
      status: 201,
    });
    const body1 = `${created1.bug.key} · ${description1}`;
    const watcher1 = await toastWatcher("a1", body1);
    const notices1 = await api(
      "target reads durable A1 notification",
      "GET",
      `/api/v1/notifications?projectId=${projectA.id}&unreadOnly=true&limit=100`,
      { token: targetA.accessToken, projectId: projectA.id },
    );
    const notice1 = notices1.items.find((item) => item.bugId === created1.bug.id);
    check("durable A1 notification exists", Boolean(notice1), true);
    await eventFor(
      (item) => item.event === "desktop.notification.shown" && item.notificationId === notice1.id,
      "A1_SHOWN",
    );
    await switchProject(renderer, projectB.id);
    const draft = `B项目唯一未提交草稿-${compact}`;
    await putDraft(renderer, draft);
    const requestStart1 = proof.network.length;
    await watcher1.invoke();
    const routed1 = await waitFor(
      renderer,
      (s) => s.projectId === projectA.id && s.detailOpen && s.detailKey === created1.bug.key,
      "A1_ROUTE",
      30_000,
    );
    const details1 = proof.network
      .slice(requestStart1)
      .map((item) => classifyBugDetailRequest(item, created1.bug.id))
      .filter(Boolean);
    check("A1 exact detail requested", details1.length > 0, true);
    check("A1 first detail carries project A", details1[0].projectId, projectA.id);
    writeExclusive(path.join(evidence, "raw", "a1-routed-renderer.json"), routed1);
    await closeDetail(renderer);
    await switchProject(renderer, projectB.id);
    const draftBack = await waitFor(
      renderer,
      (s) => s.createOpen && s.draft === draft,
      "B_DRAFT_ROUNDTRIP",
    );
    check("B draft roundtrip exact", draftBack.draft, draft);
    await renderer.evaluate(
      "(()=>{const b=document.querySelector('.create-modal .modal-head button');if(!b)return false;b.click();return true})()",
    );

    // Re-enter A before creating A2 so the desktop transport's remembered project scope is A.
    // The toast itself is then clicked from B, which is the cross-project route under test.
    await switchProject(renderer, projectA.id);
    const description2 = `通知撤权A2-${compact}`;
    const bug2Input = makeBugBody(projectA.id, targetA.userId, description2);
    const created2 = await api("actor creates assigned A2 Bug", "POST", "/api/v1/bugs", {
      token: actorA.accessToken,
      projectId: projectA.id,
      key: `submission:${bug2Input.submission}:commit`,
      body: bug2Input.body,
      status: 201,
    });
    const watcher2 = await toastWatcher("a2", `${created2.bug.key} · ${description2}`);
    const notices2 = await api(
      "target reads durable A2 notification",
      "GET",
      `/api/v1/notifications?projectId=${projectA.id}&unreadOnly=true&limit=100`,
      { token: targetA.accessToken, projectId: projectA.id },
    );
    const notice2 = notices2.items.find((item) => item.bugId === created2.bug.id);
    check("durable A2 notification exists", Boolean(notice2), true);
    await eventFor(
      (item) => item.event === "desktop.notification.shown" && item.notificationId === notice2.id,
      "A2_SHOWN",
    );
    await switchProject(renderer, projectB.id);
    const usersA = await api(
      "GM reads A membership version",
      "GET",
      `/api/v1/projects/${projectA.id}/users`,
      { token: gm.accessToken, projectId: projectA.id },
    );
    const membership = usersA.items.find((item) => item.userId === targetA.userId);
    check("target A membership found", Boolean(membership), true);
    await api(
      "GM revokes target A membership",
      "PUT",
      `/api/v1/gm/projects/${projectA.id}/members/${targetA.userId}`,
      {
        token: gm.accessToken,
        body: { active: false, expectedVersion: membership.membershipVersion },
      },
    );
    const requestStart2 = proof.network.length;
    await watcher2.invoke();
    const denied = await waitFor(
      renderer,
      (s) =>
        s.projectId === projectB.id &&
        s.inaccessibleExact &&
        !s.projects.some((item) => item.id === projectA.id),
      "A2_REVOKED_ROUTE",
      30_000,
    );
    check("revoked route stays B", denied.projectId, projectB.id);
    check("revoked route exact visible alert", denied.alert, INACCESSIBLE_TEXT);
    check(
      "revoked route sends no A2 detail request",
      proof.network
        .slice(requestStart2)
        .map((item) => classifyBugDetailRequest(item, created2.bug.id))
        .filter(Boolean).length,
      0,
    );
    writeExclusive(path.join(evidence, "raw", "a2-denied-renderer.json"), denied);

    await signOut(renderer);
    await rendererLogin(renderer, projectB.id, targetName);
    const description3 = `通知重启B3-${compact}`;
    const bug3Input = makeBugBody(projectB.id, targetB.userId, description3);
    const created3 = await api("separate actor creates assigned B3 Bug", "POST", "/api/v1/bugs", {
      token: actorB.accessToken,
      projectId: projectB.id,
      key: `submission:${bug3Input.submission}:commit`,
      body: bug3Input.body,
      status: 201,
    });
    await observeToast("b3", `${created3.bug.key} · ${description3}`);
    const notices3 = await api(
      "target reads durable unread B3 notification",
      "GET",
      `/api/v1/notifications?projectId=${projectB.id}&unreadOnly=true&limit=100`,
      { token: targetB.accessToken, projectId: projectB.id },
    );
    const notice3 = notices3.items.find((item) => item.bugId === created3.bug.id);
    check(
      "durable unread B3 notification exists",
      Boolean(notice3) && notice3.readAt === null,
      true,
    );
    await eventFor(
      (item) => item.event === "desktop.notification.shown" && item.notificationId === notice3.id,
      "B3_SHOWN",
    );
    const historyFile = path.join(configs.route.profileDirectory, "notification-history.json");
    const historyBeforeRestart = readJson(historyFile);
    check(
      "B3 history exactly once before restart",
      historyBeforeRestart.notificationIds.filter((id) => id === notice3.id).length,
      1,
    );
    await stopOwn("controlled-restart-stop");
    await launch("route-2-restart", configs.route);
    await waitFor(
      renderer,
      (s) => s.ready && s.projectId === projectB.id && s.connection?.state === "connected",
      "RESTART_REAUTH",
      30_000,
    );
    await delay(10_000);
    check(
      "B3 not shown again after restart",
      processEvents.filter(
        (item) => item.event === "desktop.notification.shown" && item.notificationId === notice3.id,
      ).length,
      0,
    );
    const historyAfterRestart = readJson(historyFile);
    check(
      "B3 history remains exactly once",
      historyAfterRestart.notificationIds.filter((id) => id === notice3.id).length,
      1,
    );
    check("notification history stable across restart", historyAfterRestart, historyBeforeRestart);
    proof.fixtures.bugs = { a1: created1.bug, a2: created2.bug, b3: created3.bug };
    proof.fixtures.notifications = { a1: notice1.id, a2: notice2.id, b3: notice3.id };
    proof.passed = true;
  } catch (error) {
    proof.error = {
      name: error?.name ?? "Error",
      message: redactEvidence(error?.message ?? String(error), knownSecrets),
    };
    throw error;
  } finally {
    if (child && mainInspector) {
      try {
        await stopOwn("final-cleanup");
      } catch (error) {
        proof.cleanupError = redactEvidence(error?.message ?? String(error), knownSecrets);
      }
    }
    try {
      const hostAfter = await snapshotHost("after");
      if (hostBefore) {
        check(
          "daily and foreign QA Hub processes unchanged",
          foreignFingerprint(hostAfter, packageCopy),
          foreignFingerprint(hostBefore, packageCopy),
        );
        check(
          "configured and production listeners unchanged",
          listenerFingerprint(hostAfter, new Set([ports.mcp, ports.cdp, ports.inspector])),
          listenerFingerprint(hostBefore, new Set([ports.mcp, ports.cdp, ports.inspector])),
        );
        for (const port of [ports.mcp, ports.cdp, ports.inspector])
          check(
            `final own port ${port} released`,
            hostAfter.listeners.filter((item) => item.port === port && item.listening).length,
            0,
          );
      }
      check(
        "instance and installed preview inputs unchanged",
        criticalFiles(scope),
        criticalBefore,
      );
      proof.hostAfter = hostAfter;
    } catch (error) {
      proof.finalizationError = redactEvidence(error?.message ?? String(error), knownSecrets);
      proof.passed = false;
    }
    proof.finishedAt = new Date().toISOString();
    proof.network = redactEvidence(proof.network, knownSecrets);
    const safe = redactEvidence(proof, knownSecrets);
    const serialized = `${JSON.stringify(safe, null, 2)}\n`;
    for (const secret of knownSecrets)
      assert.ok(!serialized.includes(secret), "SECRET_LITERAL_IN_EVIDENCE");
    writeExclusive(path.join(evidence, "proof.json"), serialized);
    process.stdout.write(
      `${JSON.stringify({ runId, passed: proof.passed, evidence: path.join(evidence, "proof.json") })}\n`,
    );
  }
  assert.equal(proof.passed, true, "LIVE_NOTIFICATION_ROUTE_FAILED");
}

function usage() {
  return [
    "Review/dry-run (read-only):",
    "  node scripts/project-components/desktop-notification-project-route-live.mjs --instance <absolute-instance.json> --exe <absolute-installed-preview.exe>",
    "Authorized live run:",
    "  node scripts/project-components/desktop-notification-project-route-live.mjs --instance <absolute-instance.json> --exe <absolute-installed-preview.exe> --run",
    "The live path refuses production roots/ports and any already-running copy of the selected preview instance.",
  ].join("\n");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.usageOnly) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const scope = validateStaticScope(args.instancePath, args.executablePath);
  const review = {
    mode: args.execute ? "live" : "dry-run",
    instanceId: scope.instance.instanceId,
    instancePath: scope.instancePath,
    executablePath: scope.executablePath,
    executableSha256: fileSha256(scope.executablePath),
    appAsarSha256: fileSha256(scope.asarPath),
    apiOrigin: scope.apiOrigin,
    productionPortsRejected: [...BLOCKED_PORTS],
    liveRequiresEmptySelectedInstance: true,
    gracefulQuitProbeBeforeBusinessWrites: true,
  };
  if (!args.execute) {
    process.stdout.write(`${JSON.stringify(review, null, 2)}\n`);
    return;
  }
  await runLive(scope);
}

if (path.resolve(process.argv[1] ?? "") === sourcePath) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ passed: false, error: redactEvidence(error?.message ?? String(error)) })}\n`,
    );
    process.exitCode = 1;
  });
}
