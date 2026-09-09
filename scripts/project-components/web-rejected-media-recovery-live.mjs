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
    "not_run: node scripts/project-components/web-rejected-media-recovery-live.mjs --run <explicit-preview-instance.json>",
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
const debug = "http://127.0.0.1:9366";
const expectedBundle = {
  url: `${web}/assets/index-Ce9wROrH.js`,
  sizeBytes: 477454,
  sha256: "c6e0392ff28cbb86a27aec2dc1fe1cd4b47bb3eb9e22025c95e58a7187ab367d",
};
const runId = randomUUID();
const projectId = randomUUID();
const employee = `Recovery${runId.replaceAll("-", "")}`;
const runtime = canonicalInstancePath(
  join(config.runtimeRoot, `web-rejected-media-recovery-${runId}`),
);
assert.ok(isInstancePathWithin(runtime, config.runtimeRoot) && runtime !== config.runtimeRoot);
assert.equal(existsSync(runtime), false);
const profile = join(runtime, "edge-profile");
const output = join(
  config.sourceRoot,
  "docs/evidence/project-components/web-rejected-media-recovery-live",
  runId,
);
assert.equal(existsSync(output), false);
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
const runnerBytes = readFileSync(fileURLToPath(import.meta.url));
writeFileSync(join(runtime, "runner.mjs"), runnerBytes, { flag: "wx" });
writeFileSync(join(output, "runner.mjs"), runnerBytes, { flag: "wx" });

const goodPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
const badPng = goodPng.subarray(0, 12);
const media = {
  bad: {
    filename: "rejected-truncated.png",
    bytes: badPng,
    file: join(runtime, "rejected-truncated.png"),
  },
  good: {
    filename: "replacement-valid.png",
    bytes: goodPng,
    file: join(runtime, "replacement-valid.png"),
  },
};
for (const item of Object.values(media)) writeFileSync(item.file, item.bytes, { flag: "wx" });
const originalText = "Rejected media original " + runId;
const correctedText = "Corrected media submission " + runId;

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
  rejections: [],
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
  boundaries: {
    existingBrowserOrExeAttached: false,
    componentTasksCalled: false,
    syntheticResponse: false,
    forcedStop: false,
  },
  fixtureMedia: Object.fromEntries(
    Object.entries(media).map(([kind, item]) => [
      kind,
      { filename: item.filename, sizeBytes: item.bytes.length, sha256: sha(item.bytes) },
    ]),
  ),
};
function record(bucket, value) {
  evidence[bucket].push(redact({ at: new Date().toISOString(), ...value }));
}
function check(label, expected, actual) {
  const passed = isDeepStrictEqual(actual, expected);
  record("checks", { label, expected, actual, passed });
  if (!passed) throw new Error("Check failed: " + label + "; expected/actual retained");
}
let fatal, child, browser, page, pageSession, bugReceipt, actorId, badRejected;
let closing = false,
  replacementArmed = false;
let corePostCount = 0;
const submissionIds = { bad: null, good: null };
const sessions = new Map();
const attachments = new Set();

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
    assert.ok(url.startsWith("ws://127.0.0.1:9366/"));
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
    server.listen(9366, "127.0.0.1", resolveListen);
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
  const url = new URL(event.request.url),
    method = event.request.method;
  if (![web, api].includes(url.origin) && !["about:", "data:", "blob:"].includes(url.protocol)) {
    await page.call("Fetch.failRequest", {
      requestId: event.requestId,
      errorReason: "BlockedByClient",
    });
    throw new Error("Unexpected origin refused: " + url.origin);
  }
  const header = (name) =>
    Object.entries(event.request.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  let body;
  if (event.request.postData && !url.pathname.includes("/chunks/")) {
    try {
      body = JSON.parse(event.request.postData);
    } catch {
      throw new Error("Unexpected non-JSON mutation");
    }
  }
  const init = url.pathname === "/api/v1/uploads/init";
  const chunk = url.pathname.match(/^\/api\/v1\/uploads\/([a-f0-9-]+)\/chunks\/([0-9]+)$/u);
  const finalize = url.pathname.match(/^\/api\/v1\/uploads\/([a-f0-9-]+)\/finalize$/u);
  const binding = url.pathname.match(/^\/api\/v1\/attachments\/([a-f0-9-]+)\/bind$/u);
  const commit = method === "POST" && url.pathname === "/api/v1/bugs";
  const login = method === "POST" && url.pathname === "/api/v1/auth/login";
  if (event.responseStatusCode === undefined) {
    if (
      /\/production(?:\/|$)|\/qingyu(?:\/|$)|\/packaging(?:\/|$)|increment-upload|build-upload|\/builds(?:\/|$)/u.test(
        url.pathname,
      )
    ) {
      await page.call("Fetch.failRequest", {
        requestId: event.requestId,
        errorReason: "BlockedByClient",
      });
      throw new Error("Component route refused");
    }
    if (url.pathname.startsWith("/api/v1/") && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (!login) assert.equal(header("x-qa-project-id"), projectId);
      if (init) {
        const kind = replacementArmed ? "good" : "bad",
          fixture = media[kind];
        assert.equal(body.filename, fixture.filename);
        assert.equal(body.mediaType, "image/png");
        assert.equal(body.sha256, sha(fixture.bytes));
        assert.equal(body.expectedSize, fixture.bytes.length);
        submissionIds[kind] ??= body.clientSubmissionId;
        assert.equal(body.clientSubmissionId, submissionIds[kind]);
        if (kind === "good") {
          assert.ok(badRejected);
          assert.notEqual(submissionIds.good, submissionIds.bad);
        }
      }
      if (commit) corePostCount++;
      const session = chunk ? sessions.get(chunk[1]) : finalize ? sessions.get(finalize[1]) : null;
      const valid =
        (login && body?.name === employee && body?.projectId === projectId) ||
        (method === "POST" && init && body?.projectId === projectId) ||
        (method === "PUT" &&
          chunk &&
          session &&
          Number(chunk[2]) === 0 &&
          header("x-client-submission-id") === session.submissionId &&
          header("x-client-attachment-id") === session.clientAttachmentId) ||
        (method === "POST" &&
          finalize &&
          session &&
          body?.clientSubmissionId === session.submissionId &&
          body?.clientAttachmentId === session.clientAttachmentId) ||
        (method === "POST" &&
          binding &&
          replacementArmed &&
          attachments.has(binding[1]) &&
          body?.clientSubmissionId === submissionIds.good &&
          body?.projectId === projectId) ||
        (commit &&
          replacementArmed &&
          badRejected &&
          corePostCount === 1 &&
          body?.clientSubmissionId === submissionIds.good &&
          body?.projectId === projectId &&
          body?.description === correctedText &&
          body?.attachmentIds?.length === 1 &&
          attachments.has(body.attachmentIds[0]));
      if (!valid) {
        record("requests", { kind: "blocked_mutation", method, path: url.pathname });
        await page.call("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "BlockedByClient",
        });
        throw new Error("Unexpected mutation refused: " + method + " " + url.pathname);
      }
      if (commit)
        assert.equal(header("idempotency-key"), "submission:" + submissionIds.good + ":commit");
    }
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
  if (method === "POST" && (init || finalize || commit || login)) {
    const payload = await page.call("Fetch.getResponseBody", { requestId: event.requestId });
    const raw = Buffer.from(payload.body, payload.base64Encoded ? "base64" : "utf8"),
      response = JSON.parse(raw.toString("utf8"));
    remember(response);
    if (login) {
      assert.equal(event.responseStatusCode, 200);
      actorId = response.userId;
      assert.ok(actorId);
      assert.equal(response.projectId, projectId);
      record("requests", {
        kind: "employee_login_response",
        status: event.responseStatusCode,
        userId: actorId,
        projectId: response.projectId,
      });
    } else
      record("requests", {
        kind: "observed_response",
        method,
        path: url.pathname,
        status: event.responseStatusCode,
        response,
        responseSha256: sha(raw),
      });
    if (init) {
      assert.equal(event.responseStatusCode, 201);
      const kind = body.filename === media.bad.filename ? "bad" : "good";
      sessions.set(response.sessionId, {
        kind,
        submissionId: body.clientSubmissionId,
        clientAttachmentId: body.clientAttachmentId,
      });
    } else if (finalize) {
      const session = sessions.get(finalize[1]);
      assert.ok(session);
      if (session.kind === "bad") {
        check("real bad finalize HTTP status", 400, event.responseStatusCode);
        check("real bad finalize error code", "UPLOAD_CONTENT_INVALID", response.code);
        check("no Bug POST before rejection", 0, corePostCount);
        badRejected = {
          sessionId: finalize[1],
          submissionId: session.submissionId,
          clientAttachmentId: session.clientAttachmentId,
          status: 400,
          response,
          responseSha256: sha(raw),
        };
        record("rejections", badRejected);
        writeFileSync(
          join(output, "bad-media-finalize-400.json"),
          JSON.stringify(redact(badRejected), null, 2) + "\n",
          { flag: "wx" },
        );
      } else {
        assert.equal(event.responseStatusCode, 200);
        attachments.add(response.attachmentId);
      }
    } else if (commit) {
      check("replacement Bug actual 201", 201, event.responseStatusCode);
      check("replacement Bug scope", projectId, response.bug.projectId);
      check("replacement Bug actor", actorId, response.bug.reporterId);
      check("replacement submission identity", submissionIds.good, response.clientSubmissionId);
      bugReceipt = response;
    }
  }
  await page.call("Fetch.continueRequest", { requestId: event.requestId });
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
      "--remote-debugging-port=9366",
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
      { urlPattern: "*api/v1/auth/login", requestStage: "Response" },
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
    `(() => { const nodes=[...document.querySelectorAll('button,input,textarea,select,summary,[role="button"]')].filter(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && [...document.querySelectorAll('details:not([open])')].every(d=>!d.contains(e)||d.querySelector(':scope > summary')?.contains(e))); window.__qaRecoveryNodes=nodes; return {url:location.href,text:document.body.innerText.slice(0,14000),nodes:nodes.map((e,index)=>({index,tag:e.tagName.toLowerCase(),type:e.type||'',text:(e.innerText||'').trim(),label:e.getAttribute('aria-label')||'',placeholder:e.getAttribute('placeholder')||'',value:e.type==='password'?'':e.value||'',disabled:!!e.disabled}))}; })()`,
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
    `(() => { const e=window.__qaRecoveryNodes[${node.index}]; if(!e||!e.isConnected||e.disabled)throw Error('Observed control changed'); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2; if(!e.contains(document.elementFromPoint(x,y)))throw Error('Observed control is covered or clipped'); return {x,y}; })()`,
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
  writeFileSync(join(output, `${label}.png`), bytes, { flag: "wx" });
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
  return evaluate(
    `(async()=>{const names=await indexedDB.databases();if(!names.some(x=>x.name==='qa-hub-preview-project-drafts-v1'))return null;const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('qa-hub-preview-project-drafts-v1');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});const rows=await new Promise((resolve,reject)=>{const t=db.transaction('drafts','readonly'),q=t.objectStore('drafts').openCursor(),rows=[];q.onsuccess=()=>{const c=q.result;if(!c){resolve(rows);return;}if(String(c.key).includes(${JSON.stringify(projectId)}))rows.push(c.value);c.continue();};q.onerror=()=>reject(q.error);});db.close();const files=async(fs)=>Promise.all((fs||[]).map(async f=>({name:f.name,type:f.type,size:f.size,lastModified:f.lastModified,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await f.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('')})));return Promise.all(rows.map(async v=>v.entries?{entries:await Promise.all(v.entries.map(async e=>({...e,commitAttempts:e.commitAttempts??0,responseId:e.response?.bug?.id,draft:{...e.draft,files:await files(e.draft.files)}})))}:{newContent:v.newContent,createReceiptId:v.createReceiptId,newFiles:await files(v.newFiles)}));})()`,
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
const entries = (rows) => rows.flatMap((row) => row.entries ?? []);
const immutableRejected = (entry) => {
  const copy = structuredClone(entry);
  delete copy.supersededBy;
  return copy;
};
function retainedBadBytes(label) {
  const file = canonicalInstancePath(
    join(config.dataRoot, "quarantine", "uploads", badRejected.sessionId, "1", "0.bin"),
  );
  assert.ok(isInstancePathWithin(file, config.dataRoot));
  const bytes = readFileSync(file);
  check(label + ": backend quarantined chunk hash", sha(badPng), sha(bytes));
  check(label + ": original local file hash", sha(badPng), sha(readFileSync(media.bad.file)));
  record("checkpoints", {
    label,
    kind: "exact_fixture_file_readback",
    path: file,
    sizeBytes: bytes.length,
    sha256: sha(bytes),
  });
}
async function selectFile(label, file) {
  const node = await control(label, (node) => node.tag === "input" && node.type === "file");
  const object = await page.call("Runtime.evaluate", {
    expression: `window.__qaRecoveryNodes[${node.index}]`,
    returnByValue: false,
  });
  const description = await page.call("DOM.describeNode", { objectId: object.result.objectId });
  await page.call("DOM.setFileInputFiles", {
    files: [file],
    backendNodeId: description.node.backendNodeId,
  });
}
async function readback(label) {
  const bugs = await readApi("/api/v1/bugs?projectId=" + projectId + "&limit=100");
  check(
    label + ": exactly one Bug",
    [bugReceipt.bug.id],
    bugs.items.map((x) => x.id),
  );
  const bug = await readApi("/api/v1/bugs/" + bugReceipt.bug.id);
  check(label + ": corrected content", correctedText, bug.description);
  check(label + ": actor", actorId, bug.reporterId);
  check(label + ": project", projectId, bug.projectId);
  check(label + ": version", 1, bug.version);
  check(label + ": occurrence count", 1, bug.occurrenceCount);
  const events = await readApi("/api/v1/bugs/" + bug.id + "/events?limit=100");
  check(
    label + ": one occurrence event",
    1,
    events.items.filter((x) => x.type === "occurrence.appended").length,
  );
  check(label + ": occurrence actor", actorId, events.items[0]?.actor?.id);
  const comments = await readApi("/api/v1/bugs/" + bug.id + "/comments?limit=100");
  check(label + ": no comment", 0, comments.items.length);
  const attached = await readApi("/api/v1/bugs/" + bug.id + "/attachments?limit=50");
  check(label + ": one attachment", 1, attached.items.length);
  const id = attached.items[0].attachmentId ?? attached.items[0].id;
  const bytes = Buffer.from(await readApi("/api/v1/attachments/" + id, true), "base64");
  check(label + ": good PNG hash", sha(goodPng), sha(bytes));
  check(label + ": good PNG size", goodPng.length, bytes.length);
  return { bug, events: events.items, attachments: attached.items, sha256: sha(bytes) };
}

try {
  check(
    "reviewed Web source SHA",
    {
      "apps/web/src/pending-submission.ts":
        "723e2d6a83a7deb48ffa86b4ab3b0723bd5af418f6477339e6e59779ed2429d3",
      "apps/web/src/api.ts": "b5e3c6164332e7e98aac120008315e3cdb93d4fcab2fd142105eccc128f5c2de",
      "apps/web/src/project-drafts.ts":
        "6f0dbbca6f1d5c86e2e1b20c2d1503a93e314bf69ca3dd89c49a5314afbe9f01",
      "apps/web/src/App.tsx": "b1e6b4eeedaf5f62d8bd1c4ce3715113f0069eaebc6ad5a35e178b586b015554",
    },
    evidence.sourceHashes,
  );
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
  let privateConfig;
  try {
    privateConfig = JSON.parse(readFileSync(config.secretsFile, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    throw new Error("Private preview setup configuration could not be read; contents omitted");
  }
  if (typeof privateConfig.gmPassword !== "string" || privateConfig.gmPassword.length < 1)
    throw new Error("Private preview GM credential is missing; contents omitted");
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
      key: `WM${runId.replaceAll("-", "").slice(0, 14).toUpperCase()}`,
      name: `Web rejected media recovery ${runId}`,
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
    "employee name",
    (node) => node.tag === "input" && node.placeholder === "输入姓名",
    employee,
  );
  await click("employee login", button("登录"));
  await control("logged in create", button("新建 Bug"));
  check(
    "five components off",
    [false, false, false, false, false],
    (await readApi("/api/v1/projects/" + projectId + "/components")).items.map((x) => x.enabled),
  );
  check(
    "fresh project empty",
    [],
    (await readApi("/api/v1/bugs?projectId=" + projectId + "&limit=100")).items,
  );
  await click("open new Bug", button("新建 Bug"));
  await fill("original rejected content", content, originalText);
  await selectFile("bad PNG input", media.bad.file);
  await screenshot("01-bad-media-draft");
  await click("submit bad media once", button("创建 Bug"));
  await until("real finalize rejection", async () => badRejected);
  await control("explicit rejected intent recovery button", button("保留失败记录并提交修改稿"));
  const rejectedRows = await persisted("rejection durable before replacement", (rows) =>
    entries(rows).some(
      (e) =>
        e.id === submissionIds.bad &&
        e.rejection?.code === "UPLOAD_CONTENT_INVALID" &&
        e.commitAttempts === 0,
    ),
  );
  const rejectedEntry = entries(rejectedRows).find((e) => e.id === submissionIds.bad);
  check("original bad Blob retained", sha(badPng), rejectedEntry.draft.files[0].sha256);
  check("rejected journal project", projectId, rejectedEntry.scope.projectId);
  check("rejected journal actor", actorId, rejectedEntry.scope.actorId);
  check("no original Bug request body", false, rejectedEntry.requestBody !== undefined);
  check("no Bug POST after persisted rejection", 0, corePostCount);
  check(
    "still no Bug",
    [],
    (await readApi("/api/v1/bugs?projectId=" + projectId + "&limit=100")).items,
  );
  retainedBadBytes("before replacement");
  await screenshot("02-real-400-recovery-button");
  await fill("correct current draft", content, correctedText);
  await click(
    "remove bad image only from current draft",
    (node) => node.tag === "button" && node.label === "移除图片 " + media.bad.filename,
  );
  await selectFile("good PNG input", media.good.file);
  const edited = await persisted("edited draft is separate from rejected intent", (rows) =>
    rows.some(
      (row) =>
        row.newContent === correctedText &&
        row.newFiles?.length === 1 &&
        row.newFiles[0].sha256 === sha(goodPng),
    ),
  );
  check("only original journal before explicit action", 1, entries(edited).length);
  check(
    "original rejection still identical",
    immutableRejected(rejectedEntry),
    immutableRejected(entries(edited)[0]),
  );
  check("still zero Bug POST before explicit action", 0, corePostCount);
  await screenshot("03-corrected-draft-before-explicit-action");
  replacementArmed = true;
  await click(
    "explicit preserve failure and submit corrected draft",
    button("保留失败记录并提交修改稿"),
  );
  await until("one real replacement Bug response", async () => bugReceipt);
  const confirmed = await persisted(
    "old rejection and new receipt both retained",
    (rows) =>
      entries(rows).length === 2 &&
      entries(rows).some(
        (e) => e.id === submissionIds.good && e.responseId === bugReceipt.bug.id,
      ) &&
      rows.some((row) => row.createReceiptId === submissionIds.good),
  );
  const old = entries(confirmed).find((e) => e.id === submissionIds.bad),
    current = entries(confirmed).find((e) => e.id === submissionIds.good);
  check("old intent superseded only by explicit new ID", submissionIds.good, old.supersededBy);
  check(
    "old rejected intent and media otherwise unchanged",
    immutableRejected(rejectedEntry),
    immutableRejected(old),
  );
  check("new intent exactly one commit attempt", 1, current.commitAttempts);
  check("replacement retains exact original scope", old.scope, current.scope);
  check("one replacement upload checkpoint", 1, current.uploads.length);
  check(
    "new uploaded attachment bound",
    true,
    current.uploads.every((x) => x.bound === true),
  );
  check("only one Bug POST in entire scenario", 1, corePostCount);
  const saved = await readback("after explicit recovery");
  retainedBadBytes("after recovery");
  await screenshot("04-one-bug-old-failure-retained");
  await closeBrowser();
  await openBrowser();
  await control("restored employee", button("新建 Bug"));
  const restored = await persisted(
    "both durable entries after normal restart",
    (rows) =>
      entries(rows).length === 2 &&
      entries(rows).some((e) => e.id === submissionIds.good && e.responseId === bugReceipt.bug.id),
  );
  check(
    "restart keeps old rejected entry",
    old,
    entries(restored).find((e) => e.id === submissionIds.bad),
  );
  check(
    "restart keeps confirmed new entry",
    current,
    entries(restored).find((e) => e.id === submissionIds.good),
  );
  check("restart changed no committed records", saved, await readback("after normal restart"));
  retainedBadBytes("after restart");
  check("no automatic new POST on restart", 1, corePostCount);
  check(
    "five components remain off",
    [false, false, false, false, false],
    (await readApi("/api/v1/projects/" + projectId + "/components")).items.map((x) => x.enabled),
  );
  await screenshot("05-final-retained-state");
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
  evidence.scriptSha256 = sha(runnerBytes);
  const proofText = JSON.stringify(redact(evidence), null, 2) + "\n";
  writeFileSync(join(output, "proof.json"), proofText, { flag: "wx" });
  writeFileSync(join(runtime, "proof.json"), proofText, { flag: "wx" });
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
