import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  canonicalInstancePath,
  isInstancePathWithin,
  readParallelInstanceConfig,
} from "../../apps/api/src/parallel-instance.ts";

// Preparation only unless the owner explicitly supplies --run and the preview config.
if (process.argv[2] !== "--run") {
  console.log(
    "not_run: node scripts/project-components/web-submission-recovery-live.mjs --run <explicit-preview-instance.json>",
  );
  process.exit(0);
}
assert.equal(process.argv.length, 4);
const expectedRuntime = "C:\\Users\\lin0\\.codex\\parallel-runtimes\\qa-hub-preview-7c86";
assert.equal(
  canonicalInstancePath(process.argv[3]).toLowerCase(),
  canonicalInstancePath(join(expectedRuntime, "instance.json")).toLowerCase(),
);
const config = readParallelInstanceConfig(process.argv[3]);
const sourceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
assert.equal(config.instanceId, "qa-hub-preview-7c86");
assert.equal(config.apiHost, "127.0.0.1");
assert.equal(config.webHost, "127.0.0.1");
assert.equal(config.apiPort, 4419);
assert.equal(config.webPort, 4274);
assert.equal(
  config.runtimeRoot.toLowerCase(),
  canonicalInstancePath(expectedRuntime).toLowerCase(),
);
assert.equal(canonicalInstancePath(sourceRoot).toLowerCase(), config.sourceRoot.toLowerCase());
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
assert.ok(existsSync(edgePath), "The reviewed Edge executable must exist; no discovery fallback");
const api = "http://127.0.0.1:4419";
const web = "http://127.0.0.1:4274";
const debug = "http://127.0.0.1:9364";
const expectedBundle = {
  url: `${web}/assets/index-Ce9wROrH.js`,
  sizeBytes: 477454,
  sha256: "c6e0392ff28cbb86a27aec2dc1fe1cd4b47bb3eb9e22025c95e58a7187ab367d",
};
const runId = randomUUID();
const projectId = randomUUID();
const employee = `Recovery${runId.replaceAll("-", "")}`;
const runtime = canonicalInstancePath(join(config.runtimeRoot, `web-submission-recovery-${runId}`));
assert.ok(isInstancePathWithin(runtime, config.runtimeRoot) && runtime !== config.runtimeRoot);
assert.equal(existsSync(runtime), false);
const profile = join(runtime, "edge-profile");
const output = join(
  config.sourceRoot,
  "docs/evidence/project-components/web-submission-recovery-live",
  runId,
);
for (const directory of [
  runtime,
  profile,
  output,
  join(runtime, "temp"),
  join(runtime, "appdata"),
  join(runtime, "localappdata"),
])
  mkdirSync(directory, { recursive: true });
const sha = (value) => createHash("sha256").update(value).digest("hex");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
const pngFile = join(runtime, "fixture.png");
writeFileSync(pngFile, png, { flag: "wx" });
const originalText = `Recovery original ${runId}`;
const editedText = `UNSUBMITTED EDIT AFTER LOST RECEIPT ${runId}`;
const commentText = `Recovery comment ${runId}`;
const editedComment = `UNSUBMITTED COMMENT EDIT ${runId}`;
const secrets = new Set();
const sensitive =
  /token|secret|password|cookie|authorization|csrf|private.?key|api.?key|service.?key|credential/iu;
function redact(value) {
  if (typeof value === "string") {
    try {
      const decoded = JSON.parse(value);
      if (decoded && typeof decoded === "object") return JSON.stringify(redact(decoded));
    } catch {
      /* Protocol primitive strings retain their exact spelling. */
    }
    let clean = value;
    for (const secret of secrets) clean = clean.replaceAll(secret, "[REDACTED]");
    return clean.replace(/Bearer\s+[^\s"<>]+/giu, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !sensitive.test(key))
      .map(([key, child]) => [key, redact(child)]),
  );
}
function remember(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (sensitive.test(key) && typeof child === "string" && child.length > 8) secrets.add(child);
    else if (child && typeof child === "object") remember(child);
  }
}
const evidence = {
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  status: "running",
  projectId,
  runtime,
  profile,
  checks: [],
  processes: [],
  requests: [],
  checkpoints: [],
  faults: [],
  bundles: [],
  expectedBundle,
  publishedSourceCommit: "7904e2c2d7285003884a5788a83300fbf521dbf1",
  sourceHashes: Object.fromEntries(
    [
      "apps/web/src/pending-submission.ts",
      "apps/web/src/api.ts",
      "apps/web/src/project-drafts.ts",
      "apps/web/src/App.tsx",
    ].map((file) => [file, sha(readFileSync(join(config.sourceRoot, file)))]),
  ),
  boundaries: { existingBrowserOrExeAttached: false, componentTasksCalled: false },
};
function record(bucket, value) {
  evidence[bucket].push(redact({ at: new Date().toISOString(), ...value }));
}
function check(label, expected, actual) {
  const passed = isDeepStrictEqual(actual, expected);
  record("checks", { label, expected, actual, passed });
  if (!passed) throw new Error(`Check failed: ${label}; expected/actual retained in proof`);
}
let fatal;
let closing = false;
let child;
let browser;
let page;
let pageSession;
let bugReceipt;
let commentReceipt;
let actorId;
let bugSubmissionId;
let commentSubmissionId;
const uploadSessionIds = new Set();
const uploadedAttachmentIds = new Set();
const lost = { bug: false, comment: false };
const armed = { bug: false, comment: false };
const pause = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function until(label, fn, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fatal) throw fatal;
    const value = await fn();
    if (value) return value;
    await pause(150);
  }
  throw new Error(`Timed out: ${label}`);
}
class Cdp {
  constructor(url) {
    assert.ok(url.startsWith("ws://127.0.0.1:9364/"));
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.open = new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", rejectOpen, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (waiter) {
          this.pending.delete(message.id);
          clearTimeout(waiter.timer);
          message.error
            ? waiter.reject(new Error(message.error.message))
            : waiter.resolve(message.result);
        }
      } else
        for (const listener of this.listeners.get(message.method) ?? [])
          Promise.resolve(listener(message.params, message.sessionId)).catch((cause) => {
            if (!closing) fatal ??= cause;
          });
    });
    this.socket.addEventListener("close", () => {
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Owned browser CDP closed"));
      }
      this.pending.clear();
    });
  }
  on(method, listener) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }
  async call(method, params = {}, sessionId) {
    await this.open;
    const id = ++this.sequence;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`CDP timeout: ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}
async function evaluate(expression) {
  const result = await page.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function portFree() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(9364, "127.0.0.1", resolveListen);
  });
  await new Promise((resolveClose) => server.close(resolveClose));
}
function processIdentity(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const command = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($null -ne $p) { [pscustomobject]@{pid=[int]$p.ProcessId;path=$p.ExecutablePath;startedAt=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress }`;
  const text = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  return text ? JSON.parse(text) : null;
}
function safeHeaders(headers) {
  const allowed = new Set([
    "content-type",
    "content-length",
    "idempotency-key",
    "if-match",
    "x-qa-project-id",
    "x-client-submission-id",
    "x-client-attachment-id",
    "x-chunk-sha256",
    "etag",
    "x-upload-version",
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => allowed.has(key.toLowerCase())),
  );
}
async function intercept(event) {
  const url = new URL(event.request.url);
  const allowed =
    [web, api].includes(url.origin) || ["about:", "data:", "blob:"].includes(url.protocol);
  if (!allowed) {
    record("requests", { kind: "blocked_origin", origin: url.origin });
    await page.call("Fetch.failRequest", {
      requestId: event.requestId,
      errorReason: "BlockedByClient",
    });
    throw new Error(`Unexpected page origin refused: ${url.origin}`);
  }
  let body;
  if (event.request.postData && !url.pathname.includes("/chunks/")) {
    try {
      body = JSON.parse(event.request.postData);
    } catch {
      throw new Error("Unexpected non-JSON application mutation");
    }
  }
  const method = event.request.method;
  if (
    /\/production(?:\/|$)|\/qingyu(?:\/|$)|\/packaging(?:\/|$)|increment-upload|build-upload|\/builds(?:\/|$)/u.test(
      url.pathname,
    )
  ) {
    await page.call("Fetch.failRequest", {
      requestId: event.requestId,
      errorReason: "BlockedByClient",
    });
    throw new Error(`Component route refused: ${url.pathname}`);
  }
  if (url.pathname.startsWith("/api/v1/") && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    const header = (name) =>
      Object.entries(event.request.headers).find(([key]) => key.toLowerCase() === name)?.[1];
    if (url.pathname !== "/api/v1/auth/login") assert.equal(header("x-qa-project-id"), projectId);
    if (url.pathname === "/api/v1/uploads/init") {
      assert.equal(body?.filename, "fixture.png");
      assert.equal(body?.sha256, sha(png));
      assert.equal(body?.expectedSize, png.length);
      bugSubmissionId ??= body.clientSubmissionId;
      assert.equal(body.clientSubmissionId, bugSubmissionId);
    }
    const chunk = url.pathname.match(/^\/api\/v1\/uploads\/([a-f0-9-]+)\/chunks\/\d+$/u);
    const finalize = url.pathname.match(/^\/api\/v1\/uploads\/([a-f0-9-]+)\/finalize$/u);
    const binding = url.pathname.match(/^\/api\/v1\/attachments\/([a-f0-9-]+)\/bind$/u);
    const valid =
      (method === "POST" &&
        url.pathname === "/api/v1/auth/login" &&
        body?.name === employee &&
        body?.projectId === projectId) ||
      (method === "POST" &&
        url.pathname === "/api/v1/bugs" &&
        body?.projectId === projectId &&
        body?.description === originalText &&
        body?.clientSubmissionId === bugSubmissionId) ||
      (method === "POST" &&
        url.pathname === "/api/v1/uploads/init" &&
        body?.projectId === projectId) ||
      (method === "PUT" &&
        chunk &&
        uploadSessionIds.has(chunk[1]) &&
        header("x-client-submission-id") === bugSubmissionId) ||
      (method === "POST" &&
        finalize &&
        uploadSessionIds.has(finalize[1]) &&
        body?.clientSubmissionId === bugSubmissionId) ||
      (method === "POST" &&
        binding &&
        uploadedAttachmentIds.has(binding[1]) &&
        body?.clientSubmissionId === bugSubmissionId &&
        body?.projectId === projectId) ||
      (method === "POST" &&
        bugReceipt &&
        url.pathname === `/api/v1/bugs/${bugReceipt.bug.id}/comments` &&
        body?.body === commentText);
    if (!valid) {
      await page.call("Fetch.failRequest", {
        requestId: event.requestId,
        errorReason: "BlockedByClient",
      });
      throw new Error(`Unexpected mutation refused: ${method} ${url.pathname}`);
    }
    if (url.pathname === "/api/v1/bugs")
      assert.equal(header("idempotency-key"), `submission:${bugSubmissionId}:commit`);
    if (bugReceipt && url.pathname === `/api/v1/bugs/${bugReceipt.bug.id}/comments`) {
      commentSubmissionId ??= body.clientSubmissionId;
      assert.equal(body.clientSubmissionId, commentSubmissionId);
      assert.equal(
        header("idempotency-key"),
        `comment:${bugReceipt.bug.id}:${commentSubmissionId}`,
      );
    }
  }
  if (
    event.responseStatusCode !== undefined &&
    method === "POST" &&
    (url.pathname === "/api/v1/uploads/init" || url.pathname.endsWith("/finalize"))
  ) {
    assert.ok(
      event.responseStatusCode >= 200 && event.responseStatusCode < 300,
      "Successful PNG upload fixture is required",
    );
    const payload = await page.call("Fetch.getResponseBody", { requestId: event.requestId });
    const response = JSON.parse(
      Buffer.from(payload.body, payload.base64Encoded ? "base64" : "utf8").toString("utf8"),
    );
    if (url.pathname.endsWith("/init")) uploadSessionIds.add(response.sessionId);
    else uploadedAttachmentIds.add(response.attachmentId);
    record("requests", {
      kind: "page_upload_response",
      path: url.pathname,
      status: event.responseStatusCode,
      response,
    });
  }
  if (event.responseStatusCode === undefined) {
    if (url.pathname.startsWith("/api/v1/"))
      record("requests", {
        kind: "page_request",
        method,
        path: url.pathname,
        headers: safeHeaders(event.request.headers),
        body,
      });
    await page.call("Fetch.continueRequest", { requestId: event.requestId });
    return;
  }
  const kind =
    url.pathname === "/api/v1/bugs" && method === "POST"
      ? "bug"
      : bugReceipt &&
          url.pathname === `/api/v1/bugs/${bugReceipt.bug.id}/comments` &&
          method === "POST"
        ? "comment"
        : null;
  if (kind) {
    const result = await page.call("Fetch.getResponseBody", { requestId: event.requestId });
    const bytes = Buffer.from(result.body, result.base64Encoded ? "base64" : "utf8");
    const response = JSON.parse(bytes.toString("utf8"));
    remember(response);
    record("requests", {
      kind: "page_commit_response",
      method,
      path: url.pathname,
      status: event.responseStatusCode,
      response,
      headers: safeHeaders(
        Object.fromEntries((event.responseHeaders ?? []).map(({ name, value }) => [name, value])),
      ),
    });
  }
  if (kind && armed[kind] && !lost[kind]) {
    assert.equal(
      event.responseStatusCode,
      201,
      "Fault injection requires an actual successful commit response",
    );
    const result = await page.call("Fetch.getResponseBody", { requestId: event.requestId });
    const raw = Buffer.from(result.body, result.base64Encoded ? "base64" : "utf8");
    const response = JSON.parse(raw.toString("utf8"));
    remember(response);
    if (kind === "bug") {
      assert.equal(response.bug.projectId, projectId);
      assert.equal(response.clientSubmissionId, body.clientSubmissionId);
      actorId = response.bug.reporterId;
      bugReceipt = response;
    } else {
      assert.equal(response.comment.bugId, bugReceipt.bug.id);
      assert.equal(response.comment.authorId, actorId);
      assert.equal(response.comment.clientSubmissionId, body.clientSubmissionId);
      commentReceipt = response;
    }
    // Persist the observed real 201 BEFORE causing the loss. No synthetic success is returned.
    lost[kind] = true;
    record("faults", {
      kind,
      phase: "server_response_201_before_browser_delivery",
      path: url.pathname,
      request: body,
      response,
      responseSha256: sha(raw),
      action: "Fetch.failRequest/Failed",
    });
    writeFileSync(
      join(output, `${kind}-observed-201.json`),
      JSON.stringify(redact({ request: body, response }), null, 2) + "\n",
      { flag: "wx" },
    );
    await page.call("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" });
  } else await page.call("Fetch.continueRequest", { requestId: event.requestId });
}
async function openBrowser() {
  await portFree(); // Never connect to an occupied debugging port.
  const launchedAt = new Date().toISOString();
  child = spawn(
    edgePath,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-quic",
      "--no-proxy-server",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9364",
      `--user-data-dir=${profile}`,
      `--disk-cache-dir=${join(runtime, "cache")}`,
      `--crash-dumps-dir=${join(runtime, "crashes")}`,
      "about:blank",
    ],
    {
      cwd: runtime,
      windowsHide: true,
      stdio: "ignore",
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: join(runtime, "temp"),
        TMP: join(runtime, "temp"),
        APPDATA: join(runtime, "appdata"),
        LOCALAPPDATA: join(runtime, "localappdata"),
      },
    },
  );
  child.on("error", (cause) => {
    fatal ??= cause;
  });
  const identity = await until("owned browser process identity", async () =>
    processIdentity(child.pid),
  );
  assert.equal(identity.path.toLowerCase(), edgePath.toLowerCase());
  assert.ok(Date.parse(identity.startedAt) >= Date.parse(launchedAt) - 1000);
  record("processes", { phase: "launched", ...identity, profile });
  const version = await until("owned CDP listener", async () => {
    try {
      const result = await fetch(`${debug}/json/version`, { signal: AbortSignal.timeout(1000) });
      return result.ok ? result.json() : null;
    } catch {
      return null;
    }
  });
  browser = new Cdp(version.webSocketDebuggerUrl);
  const processInfo = await browser.call("SystemInfo.getProcessInfo");
  check(
    "CDP browser PID matches spawned process",
    child.pid,
    processInfo.processInfo.find((entry) => entry.type === "browser")?.id,
  );
  const target = await browser.call("Target.createTarget", { url: "about:blank" });
  const attached = await browser.call("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  pageSession = attached.sessionId;
  page = { call: (method, params = {}) => browser.call(method, params, pageSession) };
  browser.on("Fetch.requestPaused", (event, sessionId) =>
    sessionId === pageSession ? intercept(event) : undefined,
  );
  const scriptResponses = new Map();
  let observedBundle;
  browser.on("Network.responseReceived", (event, sessionId) => {
    if (
      sessionId === pageSession &&
      event.type === "Script" &&
      new URL(event.response.url).origin === web
    )
      scriptResponses.set(event.requestId, {
        url: event.response.url,
        status: event.response.status,
      });
  });
  browser.on("Network.loadingFinished", async (event, sessionId) => {
    const response = scriptResponses.get(event.requestId);
    if (sessionId !== pageSession || !response) return;
    const result = await page.call("Network.getResponseBody", { requestId: event.requestId });
    const bytes = Buffer.from(result.body, result.base64Encoded ? "base64" : "utf8");
    const summary = { ...response, sizeBytes: bytes.length, sha256: sha(bytes) };
    record("bundles", summary);
    if (response.url === expectedBundle.url) observedBundle = summary;
    scriptResponses.delete(event.requestId);
  });
  await page.call("Page.enable");
  await page.call("Runtime.enable");
  await page.call("DOM.getDocument");
  await page.call("Network.enable");
  await page.call("Network.setBypassServiceWorker", { bypass: true });
  await page.call("Fetch.enable", {
    patterns: [
      { urlPattern: "*", requestStage: "Request" },
      { urlPattern: "*api/v1/bugs*", requestStage: "Response" },
      { urlPattern: "*api/v1/uploads*", requestStage: "Response" },
    ],
  });
  await page.call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.call("Page.navigate", { url: `${web}/?projectId=${projectId}` });
  await until("published recovery bundle loaded in owned page", async () => observedBundle);
  check(
    "actual browser bundle matches reviewed publication",
    { ...expectedBundle, status: 200 },
    observedBundle,
  );
}
async function closeBrowser() {
  if (!child) return;
  closing = true;
  const pid = child.pid;
  if (browser) await browser.call("Browser.close").catch(() => undefined);
  // No taskkill/kill fallback. An unclosed owned process is a retained failure requiring review.
  const end = Date.now() + 15_000;
  while (Date.now() < end && processIdentity(pid)) await pause(200);
  const remaining = processIdentity(pid);
  record("processes", { phase: "normal_close", pid, exited: remaining === null });
  assert.equal(
    remaining,
    null,
    "Owned browser did not exit via Browser.close; never kill another process",
  );
  child = browser = page = undefined;
  await portFree();
  closing = false;
}
const domFingerprints = new Map();
async function observe(label) {
  const state = await evaluate(
    `(() => { const nodes=[...document.querySelectorAll('button,input,textarea,select,summary,[role="button"]')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'); window.__qaRecoveryNodes=nodes; return {url:location.href,text:document.body.innerText.slice(0,14000),nodes:nodes.map((e,index)=>({index,tag:e.tagName.toLowerCase(),type:e.type||'',text:(e.innerText||'').trim(),label:e.getAttribute('aria-label')||'',placeholder:e.getAttribute('placeholder')||'',value:e.type==='password'?'':e.value||'',disabled:!!e.disabled}))}; })()`,
  );
  assert.equal(new URL(state.url).origin, web);
  const digest = sha(JSON.stringify(state));
  if (domFingerprints.get(label) !== digest) {
    record("checkpoints", { label, kind: "observed_dom", ...state });
    domFingerprints.set(label, digest);
  }
  return state;
}
async function control(label, predicate) {
  return until(label, async () => {
    const state = await observe(label);
    const matches = state.nodes.filter((node) => !node.disabled && predicate(node));
    assert.ok(matches.length <= 1, `Ambiguous observed control: ${label}`);
    return matches[0];
  });
}
async function click(label, predicate) {
  const node = await control(label, predicate);
  const rect = await evaluate(
    `(() => { const e=window.__qaRecoveryNodes[${node.index}]; if(!e||!e.isConnected||e.disabled)throw Error('Observed control changed'); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
  );
  await page.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...rect,
    button: "left",
    clickCount: 1,
  });
  await page.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...rect,
    button: "left",
    clickCount: 1,
  });
}
const button = (text) => (node) => node.tag === "button" && node.text === text;
const content = (node) =>
  node.tag === "textarea" && node.placeholder === "描述你看到的问题、复现位置和需要修复的表现";
const comment = (node) => node.tag === "input" && node.placeholder === "补充评论或处理记录";
async function fill(label, predicate, text) {
  const node = await control(label, predicate);
  await evaluate(`window.__qaRecoveryNodes[${node.index}].focus()`);
  await page.call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: 2,
  });
  await page.call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: 2,
  });
  await page.call("Input.insertText", { text });
}
async function screenshot(label) {
  const shot = await page.call("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(shot.data, "base64");
  const file = join(runtime, `${label}.png`);
  writeFileSync(file, bytes, { flag: "wx" });
  record("checkpoints", {
    kind: "screenshot",
    label,
    path: file,
    sizeBytes: bytes.length,
    sha256: sha(bytes),
  });
}
async function readApi(path, binary = false) {
  assert.ok(path.startsWith("/api/v1/"));
  const result = await evaluate(
    `(async()=>{ const r=await fetch(${JSON.stringify(path)},{credentials:'same-origin',headers:{'x-qa-project-id':${JSON.stringify(projectId)},Accept:'application/vnd.relay-qa-hub.v1.1+json'}}); const bytes=new Uint8Array(await r.arrayBuffer());return {status:r.status,body:${binary ? "btoa(String.fromCharCode(...bytes))" : "JSON.parse(new TextDecoder().decode(bytes))"}}; })()`,
  );
  check(`read-only ${path}`, 200, result.status);
  record("requests", { kind: "read_only_api", method: "GET", path, response: result });
  return result.body;
}
async function storageSnapshot() {
  // Read-only inspection of only this fresh profile's project draft/journal. No auth stores.
  return evaluate(
    `(async()=>{const names=await indexedDB.databases();if(!names.some(x=>x.name==='qa-hub-preview-project-drafts-v1'))return null;const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('qa-hub-preview-project-drafts-v1');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});const rows=await new Promise((resolve,reject)=>{const t=db.transaction('drafts','readonly'),s=t.objectStore('drafts'),rows=[];const q=s.openCursor();q.onsuccess=()=>{const c=q.result;if(!c){resolve(rows);return;}if(String(c.key).includes(${JSON.stringify(projectId)}))rows.push(c.value);c.continue();};q.onerror=()=>reject(q.error);});db.close();return rows.map(v=>v.entries?{entries:v.entries.map(e=>({id:e.id,kind:e.kind,scope:e.scope,hasResponse:!!e.response,responseId:e.response?.bug?.id||e.response?.comment?.id,body:e.body,description:e.input?.description,uploadCount:e.uploads?.length,allBound:e.uploads?.every(x=>x.bound)}))}:{newContent:v.newContent,comment:v.comment,createReceiptId:v.createReceiptId,commentReceiptIds:v.commentReceiptIds,newFiles:v.newFiles?.map(f=>({name:f.name,size:f.size}))});})()`,
  );
}
async function persisted(label, predicate) {
  const value = await until(label, async () => {
    const rows = await storageSnapshot();
    return rows && predicate(rows) ? rows : null;
  });
  record("checkpoints", { label, kind: "durable_profile_readback", rows: value });
  return value;
}
async function readback(label, expectedComments) {
  const id = bugReceipt.bug.id;
  const bugs = await readApi(`/api/v1/bugs?projectId=${projectId}&limit=100`);
  check(
    `${label}: one Bug`,
    [id],
    bugs.items.map((item) => item.id),
  );
  const bug = await readApi(`/api/v1/bugs/${id}`);
  check(`${label}: original content`, originalText, bug.description);
  check(`${label}: original actor`, actorId, bug.reporterId);
  check(`${label}: one occurrence`, 1, bug.occurrenceCount);
  const events = await readApi(`/api/v1/bugs/${id}/events?limit=100`);
  check(
    `${label}: one occurrence event`,
    1,
    events.items.filter((item) => item.type === "occurrence.appended").length,
  );
  const comments = await readApi(`/api/v1/bugs/${id}/comments?limit=100`);
  check(`${label}: comment count`, expectedComments, comments.items.length);
  if (expectedComments) {
    check(`${label}: original comment ID`, commentReceipt.comment.id, comments.items[0].id);
    check(`${label}: original comment text`, commentText, comments.items[0].body);
    check(`${label}: comment actor`, actorId, comments.items[0].authorId);
  }
  const attachments = await readApi(`/api/v1/bugs/${id}/attachments?limit=50`);
  check(`${label}: one attachment`, 1, attachments.items.length);
  const attachmentId = attachments.items[0].attachmentId ?? attachments.items[0].id;
  const bytes = Buffer.from(await readApi(`/api/v1/attachments/${attachmentId}`, true), "base64");
  check(`${label}: real PNG SHA`, sha(png), sha(bytes));
  check(`${label}: real PNG bytes`, png.length, bytes.length);
  return {
    bug,
    events: events.items,
    comments: comments.items,
    attachmentId,
    attachmentSha256: sha(bytes),
  };
}
async function ensureCommentVisible() {
  const state = await observe("find comment form");
  if (!state.nodes.some(comment))
    await click(
      "expand processing history",
      (node) => node.tag === "summary" && node.text.includes("状态轨迹与处理记录"),
    );
  await control("comment input visible", comment);
}
try {
  await portFree();
  const readyResponse = await fetch(`${api}/api/v1/health/ready`, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(readyResponse.status, 200);
  const ready = await readyResponse.json();
  assert.equal(ready.status, "ready");
  assert.equal(String(ready.schemaVersion), "14");
  record("requests", {
    kind: "readiness",
    method: "GET",
    path: "/api/v1/health/ready",
    response: ready,
  });
  const privateConfig = JSON.parse(
    readFileSync(config.secretsFile, "utf8").replace(/^\uFEFF/u, ""),
  );
  secrets.add(privateConfig.gmPassword);
  const gm = await fetch(`${api}/api/v1/auth/gm/login`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: privateConfig.gmPassword, client: "android" }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(gm.status, 200);
  const principal = await gm.json();
  remember(principal);
  assert.equal(principal.isGm, true);
  record("requests", {
    kind: "setup_gm_login",
    method: "POST",
    path: "/api/v1/auth/gm/login",
    status: gm.status,
    response: { isGm: principal.isGm, userId: principal.userId },
  });
  const created = await fetch(`${api}/api/v1/gm/projects`, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${principal.accessToken}`,
    },
    body: JSON.stringify({
      id: projectId,
      key: `WR${runId.replaceAll("-", "").slice(0, 14).toUpperCase()}`,
      name: `Web recovery ${runId}`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(created.status, 200);
  record("requests", {
    kind: "setup_project",
    method: "POST",
    path: "/api/v1/gm/projects",
    response: await created.json(),
  });
  await openBrowser();
  await fill(
    "observed employee name",
    (node) => node.tag === "input" && node.placeholder === "输入姓名",
    employee,
  );
  await click("observed login button", button("登录"));
  await control("logged in create button", button("新建 Bug"));
  const components = await readApi(`/api/v1/projects/${projectId}/components`);
  check(
    "five components disabled before mutation",
    [false, false, false, false, false],
    components.items.map((item) => item.enabled),
  );
  await click("open new Bug", button("新建 Bug"));
  await fill("original Bug text", content, originalText);
  const fileControl = await control(
    "observed PNG file input",
    (node) => node.tag === "input" && node.type === "file",
  );
  const object = await page.call("Runtime.evaluate", {
    expression: `window.__qaRecoveryNodes[${fileControl.index}]`,
    returnByValue: false,
  });
  const node = await page.call("DOM.describeNode", { objectId: object.result.objectId });
  await page.call("DOM.setFileInputFiles", {
    files: [pngFile],
    backendNodeId: node.node.backendNodeId,
  });
  await screenshot("01-original-with-png");
  armed.bug = true;
  await click("create Bug once", button("创建 Bug"));
  await until("real Bug 201 discarded", async () => lost.bug);
  await control("unknown Bug receipt action", button("确认上次提交"));
  await fill("edit after unknown Bug receipt", content, editedText);
  await persisted(
    "edited Bug durable before restart",
    (rows) =>
      rows.some((row) => row.newContent === editedText && row.newFiles?.length === 1) &&
      rows.some((row) => row.entries?.some((entry) => entry.kind === "bug" && !entry.hasResponse)),
  );
  const committedBug = await readback("after discarded create response", 0);
  await screenshot("02-unknown-create-edited");
  await closeBrowser();
  await openBrowser();
  const restored = await control("restored edited Bug", content);
  check("Bug edit survives normal browser restart", editedText, restored.value);
  await click("confirm original Bug submission", button("确认上次提交"));
  await persisted(
    "original Bug receipt acknowledged",
    (rows) =>
      rows.some(
        (row) =>
          row.createReceiptId === bugReceipt.clientSubmissionId && row.newContent === editedText,
      ) &&
      rows.some((row) =>
        row.entries?.some(
          (entry) => entry.id === bugReceipt.clientSubmissionId && entry.hasResponse,
        ),
      ),
  );
  check(
    "Bug recovery changes no original record",
    committedBug,
    await readback("after create recovery", 0),
  );
  await screenshot("03-confirmed-create-new-draft-retained");
  const modal = await observe("hide preserved create form to access Bug detail");
  if (modal.nodes.some(content))
    await click("cancel only create dialog, retain draft", button("取消"));
  await ensureCommentVisible();
  await fill("original comment", comment, commentText);
  armed.comment = true;
  await click("post comment once", button("记录"));
  await until("real comment 201 discarded", async () => lost.comment);
  await control("unknown comment receipt action", button("确认上次记录"));
  await fill("edit after unknown comment receipt", comment, editedComment);
  await persisted(
    "edited comment durable before restart",
    (rows) =>
      rows.some((row) => row.comment === editedComment) &&
      rows.some((row) =>
        row.entries?.some((entry) => entry.kind === "comment" && !entry.hasResponse),
      ),
  );
  const committedComment = await readback("after discarded comment response", 1);
  await screenshot("04-unknown-comment-edited");
  await closeBrowser();
  await openBrowser();
  await ensureCommentVisible();
  check(
    "comment edit survives restart",
    editedComment,
    (await control("restored comment input", comment)).value,
  );
  await click("confirm original comment", button("确认上次记录"));
  await persisted("comment receipt acknowledged without erasing edit", (rows) =>
    rows.some(
      (row) =>
        row.comment === editedComment &&
        row.commentReceiptIds?.[bugReceipt.bug.id] === commentReceipt.comment.clientSubmissionId,
    ),
  );
  check(
    "comment recovery changes no committed record",
    committedComment,
    await readback("after comment recovery", 1),
  );
  await screenshot("05-confirmed-comment-new-draft-retained");
  await closeBrowser();
  await openBrowser();
  await ensureCommentVisible();
  check(
    "confirmed comment edit retained on final restart",
    editedComment,
    (await control("final restored comment", comment)).value,
  );
  await persisted("both confirmed receipts and both new drafts survive", (rows) =>
    rows.some(
      (row) =>
        row.newContent === editedText &&
        row.comment === editedComment &&
        row.createReceiptId === bugReceipt.clientSubmissionId &&
        row.commentReceiptIds?.[bugReceipt.bug.id] === commentReceipt.comment.clientSubmissionId,
    ),
  );
  await screenshot("06-final-restored-profile");
  check(
    "final restart changes no committed record",
    committedComment,
    await readback("final profile restart", 1),
  );
  check("exactly one injected loss per write", { bug: true, comment: true }, lost);
  evidence.status = "passed";
} catch (cause) {
  evidence.status = "failed";
  evidence.failure = redact(String(cause));
  process.exitCode = 1;
} finally {
  try {
    await closeBrowser();
  } catch (cause) {
    evidence.status = "failed";
    evidence.closeFailure = redact(String(cause));
    process.exitCode = 1;
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.scriptSha256 = sha(readFileSync(fileURLToPath(import.meta.url)));
  writeFileSync(join(output, "proof.json"), JSON.stringify(redact(evidence), null, 2) + "\n", {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      status: evidence.status,
      runId,
      proof: join(output, "proof.json"),
      runtimeRetained: runtime,
      checks: evidence.checks.length,
    }),
  );
}
