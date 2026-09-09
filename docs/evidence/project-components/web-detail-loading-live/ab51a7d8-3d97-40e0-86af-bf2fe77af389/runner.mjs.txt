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

export const WEB = "http://127.0.0.1:4274";
export const EXPECTED_WEB = [
  [
    "assets/index-Br-CEXQI.js",
    477433,
    "813277e9792c91d27b2e153322a0a2bfcad277ec57723df712f7d84ae24ad3ae",
  ],
  [
    "assets/index-Br-CEXQI.js.map",
    1829769,
    "0fe085cf7652afec28a494f30bf6b1dcd46bf1ba8e1793984f8bceef2e298328",
  ],
  [
    "assets/index-CgNw0fhl.css",
    91623,
    "a29d8e6c6129a4b11c3f69ae9d28a76865cd18bbed5db3236588a1b16dbdfcef",
  ],
  ["icon-licenses.txt", 4308, "908f55df09e44dabb1275ec56a8d7313e0dc1460db7d42e3ddc070da7f9c13df"],
  ["icons/qa-hub-192.svg", 506, "79679389893f674b4ed89f2f8cd2a7cb21ae1a7064a45708b953cd6e194aa601"],
  ["icons/qa-hub-512.svg", 506, "e780a52ccb3bef1f9d3f1b7a9fc36a3afab1a53f845f6f9fa757ed420ccb5faf"],
  [
    "icons/qa-hub-maskable-512.svg",
    495,
    "3be5b71b759df34841a1f108911afac151834eed6ea9876081340b516727019c",
  ],
  ["index.html", 709, "22203c14cade9462e21d31b42beb2103c6c1ecabb1ebc2af00aa316968ff7367"],
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
export function redact(value, secrets = new Set(), depth = 0) {
  if (depth > 64) return "[REDACTED_NESTING_LIMIT]";
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object")
        return JSON.stringify(redact(parsed, secrets, depth + 1));
      if (typeof parsed === "string") {
        const clean = redact(parsed, secrets, depth + 1);
        if (clean !== parsed) return JSON.stringify(clean);
      }
    } catch {
      /* Preserve non-JSON primitive text. */
    }
    let clean = value;
    for (const secret of secrets) clean = clean.replaceAll(secret, "[REDACTED]");
    return clean.replace(/Bearer\s+[^\s"<>]+/giu, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) return value.map((x) => redact(x, secrets, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        /token|secret|password|cookie|authorization|csrf|private.?key|credential/iu.test(key)
          ? "[REDACTED]"
          : redact(v, secrets, depth + 1),
      ]),
    );
  return value;
}
export function classifyRequest(request, scope) {
  const url = new URL(request.url),
    method = request.method;
  if (["about:", "data:", "blob:"].includes(url.protocol) && method === "GET") return "local";
  assert.equal(url.origin, WEB, "BROWSER_ORIGIN_REFUSED");
  const headers = new Map(
    Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const query = (expected) =>
    isDeepStrictEqual([...url.searchParams.entries()].sort(), Object.entries(expected).sort());
  if (method === "GET" && url.pathname === "/" && query({ projectId: scope.projectId }))
    return "document";
  if (
    method === "GET" &&
    url.search === "" &&
    (EXPECTED_WEB.some(([path]) => url.pathname === "/" + path) || url.pathname === "/favicon.ico")
  )
    return "static";
  const entry = url.pathname === `/api/v1/project-entry/${scope.projectId}`;
  const auth = url.pathname === "/api/v1/auth/me";
  if (method === "GET" && (entry || auth) && query({})) {
    assert([undefined, scope.projectId].includes(headers.get("x-qa-project-id")));
    return entry ? "entry" : "session";
  }
  assert.equal(headers.get("x-qa-project-id"), scope.projectId, "BROWSER_PROJECT_REFUSED");
  if (method === "POST" && url.pathname === "/api/v1/auth/login" && query({})) {
    assert.deepEqual(JSON.parse(request.postData), {
      name: scope.employee,
      projectId: scope.projectId,
      client: "web",
    });
    return "login";
  }
  assert.equal(method, "GET", "BROWSER_MUTATION_REFUSED");
  if (url.pathname === "/api/v1/projects" && query({ limit: "50" })) return "projects";
  if (url.pathname === `/api/v1/projects/${scope.projectId}/components` && query({}))
    return "components";
  if (url.pathname === `/api/v1/projects/${scope.projectId}/members` && query({ limit: "100" }))
    return "members";
  if (url.pathname === `/api/v1/projects/${scope.projectId}/modules` && query({})) return "modules";
  if (
    url.pathname === "/api/v1/bugs" &&
    (query({ projectId: scope.projectId, limit: "100" }) ||
      query({ projectId: scope.projectId, limit: "100", ownerId: scope.actorId }))
  )
    return "bugs";
  if (scope.bugId) {
    const path = `/api/v1/bugs/${scope.bugId}`;
    if (url.pathname === path && query({})) return "detail";
    if (url.pathname === path + "/events" && query({ limit: "20" })) return "events";
    if (url.pathname === path + "/attachments" && query({ limit: "50" })) return "attachments";
    if ([path + "/human-workflow", path + "/comments"].includes(url.pathname) && query({}))
      return "detail-read";
  }
  throw new Error("BROWSER_ROUTE_REFUSED");
}
export class DetailFaultPlan {
  phase = "idle";
  requests = [];
  responses = [];
  held = null;
  armDelay() {
    assert.equal(this.phase, "idle");
    this.phase = "delay_armed";
  }
  armDisconnect() {
    assert.equal(this.phase, "first_released");
    this.phase = "disconnect_armed";
  }
  armRetry() {
    assert.equal(this.phase, "disconnected");
    this.phase = "retry_armed";
  }
  request(id) {
    assert(!this.requests.some((x) => x.id === id));
    const mode = { delay_armed: "delay", disconnect_armed: "disconnect", retry_armed: "retry" }[
      this.phase
    ];
    assert(mode, "UNEXPECTED_DETAIL_REQUEST");
    this.requests.push({ id, mode });
    this.phase = mode === "disconnect" ? "disconnected" : mode + "_requested";
    return mode;
  }
  response(id, status) {
    const req = this.requests.find((x) => x.id === id);
    assert(req && req.mode !== "disconnect");
    assert.equal(status, 200, "REAL_DETAIL_200_REQUIRED");
    assert(!this.responses.includes(id));
    this.responses.push(id);
    if (req.mode === "delay") {
      assert.equal(this.phase, "delay_requested");
      this.held = id;
      this.phase = "held_real_200";
      return "hold";
    }
    assert.equal(this.phase, "retry_requested");
    this.phase = "retry_confirmed";
    return "continue";
  }
  release() {
    assert.equal(this.phase, "held_real_200");
    const id = this.held;
    this.held = null;
    this.phase = "first_released";
    return id;
  }
}
export async function releaseRealResponses(holds, call, record) {
  const results = await Promise.allSettled(
    [...holds.values()].map(async (item) => {
      await call("Fetch.continueRequest", { requestId: item.requestId });
      record({ action: "release_background_components_unmodified", ...item });
      holds.delete(item.requestId);
    }),
  );
  const failures = results.filter((x) => x.status === "rejected");
  if (failures.length) throw new Error("REAL_RESPONSE_RELEASE_FAILED: " + failures.length);
}
export class RealResponseLedger {
  entries = new Map();
  releases = new Map();
  constructor(call, record) {
    this.call = call;
    this.record = record;
  }
  pause(entry) {
    assert(!this.entries.has(entry.requestId), "DUPLICATE_RESPONSE_PAUSE");
    this.entries.set(entry.requestId, entry);
  }
  release(requestId, action = "release_real_response_unmodified") {
    if (this.releases.has(requestId)) return this.releases.get(requestId);
    const entry = this.entries.get(requestId);
    if (!entry) return Promise.resolve();
    const pending = Promise.resolve()
      .then(async () => {
        await this.call("Fetch.continueRequest", { requestId });
        this.record({ ...entry, action });
        this.entries.delete(requestId);
      })
      .finally(() => this.releases.delete(requestId));
    this.releases.set(requestId, pending);
    return pending;
  }
  async releaseAll(action) {
    await releaseRealResponses(
      this.entries,
      (_method, { requestId }) => this.release(requestId, action),
      () => undefined,
    );
  }
}

async function run(instanceFile, gateFile) {
  const sourceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const expectedRuntime = canonicalInstancePath(
    "C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86",
  );
  assert.equal(canonicalInstancePath(instanceFile), join(expectedRuntime, "instance.json"));
  const config = readParallelInstanceConfig(instanceFile);
  assert.equal(config.runtimeRoot, expectedRuntime);
  assert.equal(config.sourceRoot, canonicalInstancePath(sourceRoot));
  assert.equal(config.instanceId, "qa-hub-preview-7c86");
  assert.deepEqual(
    [config.apiHost, config.apiPort, config.webHost, config.webPort],
    ["127.0.0.1", 4419, "127.0.0.1", 4274],
  );
  const gatePath = canonicalInstancePath(gateFile);
  assert.equal(
    gatePath,
    join(
      config.runtimeRoot,
      "acceptance/web-detail-fix-publication-e2d5cb4b-9068-4f14-9f90-d292ee4af864/browser-gate.json",
    ),
  );
  assert.equal(
    sha(readFileSync(gatePath)),
    "93cf0483a13b02ab8ed31f3799e61f69f2c76368ec51280a6c1388f48159c56c",
  );
  const gate = JSON.parse(readFileSync(gatePath, "utf8"));
  assert.equal(gate.status, "reviewed_published_Br-CEXQI");
  assert.equal(gate.bundleSha256, EXPECTED_WEB[0][2]);
  assert.equal(gate.api.pid, 22852);
  assert.equal(Date.parse(gate.api.startedAt), Date.parse("2026-09-09T01:22:20.2728640Z"));
  assert.equal(gate.web.pid, 20284);
  assert.equal(Date.parse(gate.web.startedAt), Date.parse("2026-09-08T17:52:36.5080910Z"));
  const publicationPath = canonicalInstancePath(gate.publicationProof.path);
  assert.equal(
    publicationPath,
    canonicalInstancePath(
      join(
        sourceRoot,
        "docs/evidence/project-components/web-detail-fix-publication/e2d5cb4b-9068-4f14-9f90-d292ee4af864/deploy.json",
      ),
    ),
  );
  assert.equal(
    gate.publicationProof.sha256,
    "0ec3abdbdbe85e1d3ab79155a8dcc2f31c21e999e634834ddb488000e90cff63",
  );
  assert.equal(sha(readFileSync(publicationPath)), gate.publicationProof.sha256);
  const runId = randomUUID(),
    projectId = randomUUID(),
    employee = "Detail" + runId.replaceAll("-", "");
  const runtime = canonicalInstancePath(join(config.runtimeRoot, "web-detail-loading-" + runId));
  assert(isInstancePathWithin(runtime, config.runtimeRoot) && !existsSync(runtime));
  const profile = join(runtime, "edge-profile"),
    output = join(
      config.sourceRoot,
      "docs/evidence/project-components/web-detail-loading-live",
      runId,
    );
  assert(!existsSync(output));
  for (const path of [
    runtime,
    profile,
    output,
    join(runtime, "raw"),
    join(runtime, "temp"),
    join(runtime, "appdata"),
    join(runtime, "localappdata"),
  ])
    mkdirSync(path, { recursive: true });
  const runnerBytes = readFileSync(fileURLToPath(import.meta.url));
  writeFileSync(join(runtime, "runner.mjs"), runnerBytes, { flag: "wx" });
  writeFileSync(join(output, "runner.mjs.txt"), runnerBytes, { flag: "wx" });
  const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  assert(existsSync(edgePath));
  const api = "http://127.0.0.1:4419",
    web = WEB,
    debug = "http://127.0.0.1:9368";
  const expectedBundle = {
    url: web + "/" + EXPECTED_WEB[0][0],
    sizeBytes: EXPECTED_WEB[0][1],
    sha256: EXPECTED_WEB[0][2],
  };
  const secrets = new Set();
  function remember(v) {
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (
        /token|secret|password|cookie|authorization|csrf/iu.test(k) &&
        typeof x === "string" &&
        x.length > 8
      )
        secrets.add(x);
      else remember(x);
    }
  }
  const evidence = {
    schemaVersion: 1,
    status: "running",
    runId,
    projectId,
    employee,
    runtime,
    profile,
    startedAt: new Date().toISOString(),
    checks: [],
    processes: [],
    requests: [],
    checkpoints: [],
    bundles: [],
    holds: [],
    gate: { ...gate, gatePath, gateSha256: sha(readFileSync(gatePath)) },
    boundaries: {
      existingBrowserAttached: false,
      componentTasksCalled: false,
      syntheticSuccessfulResponses: false,
      appTimersChanged: false,
      commentsWritten: 0,
      attachmentsUploaded: 0,
      forcedStop: false,
      backgroundComponentPollIsolation: true,
      continuousAllFramesProved: false,
    },
  };
  function record(bucket, value) {
    evidence[bucket].push(redact({ at: new Date().toISOString(), ...value }, secrets));
  }
  function check(label, expected, actual) {
    const passed = isDeepStrictEqual(actual, expected);
    record("checks", { label, expected, actual, passed });
    if (!passed) throw new Error("Check failed: " + label);
  }
  let fatal, child, browser, page, pageSession, actorId, bugId, employeeToken, initialBug;
  let closing = false,
    componentIsolation = false,
    componentsVerified = false,
    holdTimer,
    deadlineRelease;
  let seq = 0,
    uiLoginCount = 0;
  const plan = new DetailFaultPlan(),
    componentHolds = new Map(),
    detailBodies = new Map(),
    responsePauses = new RealResponseLedger(
      (...args) => page.call(...args),
      (entry) => record("holds", entry),
    );
  const scope = () => ({ projectId, employee, actorId, bugId });
  const raw = (label, bytes) => {
    const path = join(runtime, "raw", String(++seq).padStart(3, "0") + "-" + label + ".body");
    writeFileSync(path, bytes, { flag: "wx" });
    return { rawPath: path, bytes: bytes.length, sha256: sha(bytes) };
  };
  function components(body) {
    assert.equal(body.projectId, projectId);
    check(
      "exact five component keys",
      ["build", "build_upload.single", "qingyu.sync", "relay.production", "upload.incremental"],
      body.items.map((x) => x.key).sort(),
    );
    check(
      "all five components disabled",
      [false, false, false, false, false],
      body.items.map((x) => x.enabled),
    );
    componentsVerified = true;
  }
  async function apiRequest(
    label,
    path,
    { method = "GET", body, token, expected = 200, key } = {},
  ) {
    assert(path.startsWith("/api/v1/"));
    const headers = {
      Accept: "application/vnd.relay-qa-hub.v1.1+json",
      ...(token ? { authorization: `Bearer ${token}`, "x-qa-project-id": projectId } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    };
    const response = await fetch(api + path, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const bytes = Buffer.from(await response.arrayBuffer()),
      value = JSON.parse(bytes.toString("utf8"));
    remember(value);
    const auth = path.startsWith("/api/v1/auth/");
    record("requests", {
      kind: "fixture_api",
      label,
      method,
      path,
      status: response.status,
      ...(auth ? { bodyStored: false, responseSha256: sha(bytes) } : raw(label, bytes)),
      requestBody: auth ? "[REDACTED]" : body,
    });
    check(label + " status", expected, response.status);
    return value;
  }
  function apiIdentity() {
    const command =
      "$ErrorActionPreference='Stop';$taskRows=@(foreach($taskPort in @(4419,4274)){$taskListener=@(Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction Stop);if($taskListener.Count -ne 1){throw 'EXPECTED_SINGLE_LOOPBACK_LISTENER'};$taskP=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskListener[0].OwningProcess);[pscustomobject]@{port=$taskPort;address=$taskListener[0].LocalAddress;pid=[int]$taskP.ProcessId;path=$taskP.ExecutablePath;startedAt=$taskP.CreationDate.ToUniversalTime().ToString('o')}});$taskRows|ConvertTo-Json -Compress";
    return JSON.parse(
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      }),
    );
  }
  async function intercept(event) {
    let kind;
    try {
      kind = classifyRequest(event.request, scope());
    } catch (error) {
      record("requests", {
        kind: "refused",
        method: event.request.method,
        path: new URL(event.request.url).pathname,
        targetSha256: sha(event.request.url),
      });
      await page.call("Fetch.failRequest", {
        requestId: event.requestId,
        errorReason: "BlockedByClient",
      });
      throw error;
    }
    const responseStage =
      event.responseStatusCode !== undefined || event.responseErrorReason !== undefined;
    if (!responseStage) {
      if (fatal) {
        await page.call("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "BlockedByClient",
        });
        record("requests", {
          kind: "request_cancelled_after_failure",
          category: kind,
          requestId: event.requestId,
        });
        return;
      }
      assert(evidence.requests.length < 200, "REQUEST_BOUND_EXCEEDED");
      record("requests", {
        kind: "browser_request",
        category: kind,
        method: event.request.method,
        path: new URL(event.request.url).pathname,
        requestId: event.requestId,
        bodySha256: sha(event.request.postData ?? ""),
      });
      if (kind === "login") {
        uiLoginCount++;
        assert.equal(uiLoginCount, 1);
      }
      if (kind === "detail") {
        const mode = plan.request(event.requestId);
        record("holds", { action: "detail_request", mode, requestId: event.requestId });
        if (mode === "disconnect") {
          await page.call("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "Failed",
          });
          record("holds", {
            action: "injected_network_failure",
            requestId: event.requestId,
            errorReason: "Failed",
            responseStatus: null,
          });
          return;
        }
      }
      await page.call("Fetch.continueRequest", { requestId: event.requestId });
      return;
    }
    // Track before body reading or validation so exceptions cannot strand a real response.
    responsePauses.pause({
      requestId: event.requestId,
      category: kind,
      status: event.responseStatusCode ?? null,
    });
    if (fatal) {
      await responsePauses.release(event.requestId, "release_response_after_failure_unmodified");
      return;
    }
    assert.equal(event.responseErrorReason, undefined, "UNEXPECTED_UPSTREAM_NETWORK_ERROR");
    const payload = await page.call("Fetch.getResponseBody", { requestId: event.requestId });
    const bytes = Buffer.from(payload.body, payload.base64Encoded ? "base64" : "utf8"),
      body = JSON.parse(bytes.toString("utf8"));
    const tracked = responsePauses.entries.get(event.requestId);
    if (tracked) tracked.sha256 = sha(bytes);
    if (fatal) {
      await responsePauses.release(event.requestId, "release_response_after_failure_unmodified");
      return;
    }
    remember(body);
    record("requests", {
      kind: "browser_real_response",
      category: kind,
      requestId: event.requestId,
      status: event.responseStatusCode,
      ...(kind === "login"
        ? { responseSha256: sha(bytes), bodyStored: false }
        : raw("browser-" + kind, bytes)),
    });
    if (kind === "login") {
      assert.equal(event.responseStatusCode, 200);
      assert.equal(body.userId, actorId);
      assert.equal(body.projectId, projectId);
      assert.equal(body.isGm, false);
    }
    if (kind === "components") {
      assert.equal(event.responseStatusCode, 200);
      components(body);
      if (componentIsolation) {
        componentHolds.set(event.requestId, {
          requestId: event.requestId,
          sha256: sha(bytes),
          status: 200,
          at: new Date().toISOString(),
        });
        record("holds", {
          action: "hold_background_components_real_200",
          ...componentHolds.get(event.requestId),
        });
        return;
      }
    }
    if (kind === "detail") {
      check("real detail body unchanged", initialBug, body);
      detailBodies.set(event.requestId, sha(bytes));
      if (plan.response(event.requestId, event.responseStatusCode) === "hold") {
        record("holds", {
          action: "hold_detail_real_200",
          requestId: event.requestId,
          sha256: sha(bytes),
        });
        return;
      }
    }
    await responsePauses.release(event.requestId);
  }
  async function releaseBackground() {
    componentIsolation = false;
    clearTimeout(holdTimer);
    await releaseRealResponses(
      componentHolds,
      (_method, { requestId }) =>
        responsePauses.release(requestId, "release_background_components_unmodified"),
      () => undefined,
    );
  }
  async function detailState() {
    return evaluate(
      `(()=>{const d=document.querySelector('[role="dialog"][aria-label="Bug 详情"]');const e=d?.querySelector('.detail-load-error');return {present:!!d,loading:!!d?.textContent.includes('正在读取 Bug 详情'),errorTitle:e?.querySelector('strong')?.textContent||'',errorText:e?.querySelector('p')?.textContent||'',loaded:!!d?.querySelector('.detail-modal-scroll'),text:d?.innerText||''}})()`,
    );
  }
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
      assert.ok(url.startsWith("ws://127.0.0.1:9368/"));
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
        this.socket.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
        );
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
      server.listen(9368, "127.0.0.1", resolveListen);
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
        "--remote-debugging-port=9368",
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
        { urlPattern: "*api/v1/auth/login", requestStage: "Response" },
        { urlPattern: "*api/v1/projects/*/components", requestStage: "Response" },
      ],
    });
    await page.call("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.call("Page.navigate", { url: `${web}/?projectId=${projectId}` });
    await until("published detail-loading bundle loaded in owned page", async () => observedBundle);
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
      `(() => { const nodes=[...document.querySelectorAll('button,input,textarea,select,summary,[role="button"]')].filter(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && [...document.querySelectorAll('details:not([open])')].every(d=>!d.contains(e)||d.querySelector(':scope > summary')?.contains(e))); window.__qaDetailNodes=nodes; return {url:location.href,text:document.body.innerText.slice(0,14000),nodes:nodes.map((e,index)=>({index,tag:e.tagName.toLowerCase(),type:e.type||'',text:(e.innerText||'').trim(),label:e.getAttribute('aria-label')||'',placeholder:e.getAttribute('placeholder')||'',value:e.type==='password'?'':e.value||'',disabled:!!e.disabled,classes:e.className||'',inDialog:!!e.closest('[role=dialog]')}))}; })()`,
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
      `(() => { const e=window.__qaDetailNodes[${node.index}]; if(!e||!e.isConnected||e.disabled)throw Error('Observed control changed'); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2; if(!e.contains(document.elementFromPoint(x,y)))throw Error('Observed control is covered or clipped'); return {x,y}; })()`,
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
  async function fill(label, predicate, text) {
    const node = await control(label, predicate);
    await evaluate(`window.__qaDetailNodes[${node.index}].focus()`);
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

  try {
    const hostBefore = apiIdentity();
    evidence.hostBefore = hostBefore;
    const actualApi = hostBefore.find((x) => x.port === 4419);
    check("reviewed API PID", gate.api.pid, actualApi.pid);
    check("reviewed API start", Date.parse(gate.api.startedAt), Date.parse(actualApi.startedAt));
    check("reviewed Web PID", gate.web.pid, hostBefore.find((x) => x.port === 4274).pid);
    check(
      "reviewed Web start",
      Date.parse(gate.web.startedAt),
      Date.parse(hostBefore.find((x) => x.port === 4274).startedAt),
    );
    assert(hostBefore.every((x) => x.address === "127.0.0.1"));
    await portFree();
    const ready = await apiRequest("ready", "/api/v1/health/ready");
    check("ready status", "ready", ready.status);
    check("schema14", "14", String(ready.schemaVersion));
    for (const [path, bytes, expectedHash] of EXPECTED_WEB) {
      const response = await fetch(web + "/" + path, {
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200);
      const buffer = Buffer.from(await response.arrayBuffer());
      check("published asset SHA " + path, expectedHash, sha(buffer));
      check("published asset bytes " + path, bytes, buffer.length);
    }
    let secretConfig;
    try {
      secretConfig = JSON.parse(readFileSync(config.secretsFile, "utf8").replace(/^\uFEFF/u, ""));
    } catch {
      throw new Error("Preview GM configuration unavailable; body omitted");
    }
    assert(typeof secretConfig.gmPassword === "string" && secretConfig.gmPassword.length > 0);
    secrets.add(secretConfig.gmPassword);
    const gm = await apiRequest("gm-login", "/api/v1/auth/gm/login", {
      method: "POST",
      body: { password: secretConfig.gmPassword, client: "android" },
    });
    assert.equal(gm.isGm, true);
    secretConfig = undefined;
    const project = await apiRequest("fresh-project", "/api/v1/gm/projects", {
      method: "POST",
      token: gm.accessToken,
      body: {
        id: projectId,
        key: "DL" + runId.replaceAll("-", "").slice(0, 14).toUpperCase(),
        name: "Detail loading fixture " + runId,
      },
    });
    assert.equal(project.id, projectId);
    const employeeSession = await apiRequest("employee-login", "/api/v1/auth/login", {
      method: "POST",
      body: { name: employee, projectId, client: "android" },
    });
    assert.equal(employeeSession.projectId, projectId);
    assert.equal(employeeSession.isGm, false);
    actorId = employeeSession.userId;
    employeeToken = employeeSession.accessToken;
    evidence.actorId = actorId;
    components(
      await apiRequest("five-off", `/api/v1/projects/${projectId}/components`, {
        token: employeeToken,
      }),
    );
    const submissionId = randomUUID(),
      text = "WEB_DETAIL_LOADING_FIXTURE_" + runId;
    const receipt = await apiRequest("one-bug", "/api/v1/bugs", {
      method: "POST",
      expected: 201,
      token: employeeToken,
      key: `submission:${submissionId}:commit`,
      body: {
        submissionContractVersion: "1.1.0",
        clientSubmissionId: submissionId,
        projectId,
        title: text,
        description: text,
        expectedBehavior: "Loading during pending read; explicit retry after a network failure",
        severity: "S3",
        priority: "P3",
        ownerId: actorId,
        verificationOwnerId: actorId,
        occurrence: {
          observedAt: new Date().toISOString(),
          platform: "web",
          steps: ["Read-only detail loading fixture"],
          actualBehavior: text,
        },
        attachmentIds: [],
        captureBundleId: null,
      },
    });
    bugId = receipt.bug.id;
    evidence.bugId = bugId;
    initialBug = await apiRequest("initial-detail", `/api/v1/bugs/${bugId}`, {
      token: employeeToken,
    });
    assert.equal(initialBug.projectId, projectId);
    assert.equal(initialBug.id, bugId);
    const initialEvents = await apiRequest(
      "initial-events",
      `/api/v1/bugs/${bugId}/events?limit=20`,
      { token: employeeToken },
    );
    await openBrowser();
    await fill("employee name", (n) => n.tag === "input" && n.placeholder === "输入姓名", employee);
    await click("employee login", button("登录"));
    await control(
      "fixture row",
      (n) => n.tag === "button" && n.classes.includes("bug-row") && n.text.includes(text),
    );
    await until(
      "initial browser component response",
      () =>
        componentsVerified &&
        evidence.requests.some(
          (x) => x.kind === "browser_real_response" && x.category === "components",
        ),
    );
    componentIsolation = true;
    holdTimer = setTimeout(() => {
      fatal ??= new Error("COMPONENT_RESPONSE_HOLD_WINDOW_EXCEEDED");
      componentIsolation = false;
      record("holds", { action: "hold_window_expired", maximumMs: 15000 });
      deadlineRelease = responsePauses
        .releaseAll("deadline_release_real_response_unmodified")
        .catch((cause) => {
          record("holds", { action: "deadline_release_failed", error: String(cause) });
        });
    }, 15000);
    record("holds", {
      action: "start_component_poll_isolation",
      maximumMs: 15000,
      initialFiveOffVerified: true,
    });
    plan.armDelay();
    await click(
      "first actual detail click",
      (n) => n.tag === "button" && n.classes.includes("bug-row") && n.text.includes(text),
    );
    await until("real detail 200 held", () => plan.phase === "held_real_200");
    let state = await detailState();
    check("pending detail loading", true, state.loading);
    check("pending detail has no fabricated error", "", state.errorTitle);
    record("checkpoints", { label: "pending-real-200", state });
    await screenshot("01-real-response-held-loading");
    const held = plan.release();
    await responsePauses.release(held, "release_detail_unmodified");
    record("holds", {
      action: "release_detail_unmodified",
      requestId: held,
      sha256: detailBodies.get(held),
    });
    state = await until("first real detail loaded", async () => {
      const s = await detailState();
      return s.loaded && s.text.includes(text) ? s : null;
    });
    check("first load no error", "", state.errorTitle);
    record("checkpoints", { label: "first-real-200-loaded", state });
    await screenshot("02-first-real-detail-loaded");
    await click(
      "close first detail",
      (n) =>
        n.inDialog &&
        n.tag === "button" &&
        n.label === "关闭详情" &&
        n.classes.includes("detail-close"),
    );
    plan.armDisconnect();
    await click(
      "second actual detail click",
      (n) => n.tag === "button" && n.classes.includes("bug-row") && n.text.includes(text),
    );
    state = await until("injected transport failure visible", async () => {
      const s = await detailState();
      return s.errorTitle === "Bug 详情读取失败" && s.errorText ? s : null;
    });
    check("network failure was injected", true, plan.phase === "disconnected");
    record("checkpoints", { label: "actual-catch-error", state });
    await screenshot("03-actual-network-catch-error");
    plan.armRetry();
    await click("actual Retry", (n) => n.inDialog && button("重新读取")(n));
    state = await until("Retry real200 loaded", async () => {
      const s = await detailState();
      return plan.phase === "retry_confirmed" && s.loaded && s.text.includes(text) ? s : null;
    });
    check("retry clears error", "", state.errorTitle);
    check("three controlled detail requests", 3, plan.requests.length);
    check("two genuine detail200 responses", 2, plan.responses.length);
    record("checkpoints", { label: "actual-retry-loaded", state });
    await screenshot("04-actual-retry-real-200");
    await click(
      "close confirmed detail",
      (n) =>
        n.inDialog &&
        n.tag === "button" &&
        n.label === "关闭详情" &&
        n.classes.includes("detail-close"),
    );
    await releaseBackground();
    const finalBug = await apiRequest("final-detail", `/api/v1/bugs/${bugId}`, {
      token: employeeToken,
    });
    check("Bug DTO unchanged", initialBug, finalBug);
    check(
      "Bug events unchanged",
      initialEvents,
      await apiRequest("final-events", `/api/v1/bugs/${bugId}/events?limit=20`, {
        token: employeeToken,
      }),
    );
    const bugs = await apiRequest("final-list", `/api/v1/bugs?projectId=${projectId}&limit=100`, {
      token: employeeToken,
    });
    check(
      "exactly one fixture Bug",
      [bugId],
      bugs.items.map((x) => x.id),
    );
    check(
      "no comments",
      [],
      (
        await apiRequest("final-comments", `/api/v1/bugs/${bugId}/comments`, {
          token: employeeToken,
        })
      ).items,
    );
    check(
      "no attachments",
      [],
      (
        await apiRequest("final-attachments", `/api/v1/bugs/${bugId}/attachments?limit=50`, {
          token: employeeToken,
        })
      ).items,
    );
    components(
      await apiRequest("final-five-off", `/api/v1/projects/${projectId}/components`, {
        token: employeeToken,
      }),
    );
    check("API/Web processes unchanged", hostBefore, apiIdentity());
    if (fatal) throw fatal;
    evidence.status = "passed";
  } catch (cause) {
    evidence.status = "failed_retained";
    evidence.failure = redact(String(cause), secrets);
    process.exitCode = 1;
  } finally {
    try {
      if (page) {
        componentIsolation = false;
        clearTimeout(holdTimer);
        await deadlineRelease;
        await responsePauses.releaseAll("finally_release_real_response_unmodified");
        plan.held = null;
        componentHolds.clear();
      }
    } catch (cause) {
      evidence.releaseFailure = redact(String(cause), secrets);
      evidence.status = "failed_retained";
      process.exitCode = 1;
    }
    clearTimeout(holdTimer);
    try {
      await closeBrowser();
    } catch (cause) {
      evidence.closeFailure = redact(String(cause), secrets);
      evidence.status = "failed_retained";
      process.exitCode = 1;
    }
    if (fatal || responsePauses.entries.size) {
      evidence.failure ??= redact(String(fatal ?? "UNRELEASED_REAL_RESPONSE"), secrets);
      evidence.status = "failed_retained";
      process.exitCode = 1;
    }
    evidence.finishedAt = new Date().toISOString();
    evidence.detailPlan = { phase: plan.phase, requests: plan.requests, responses: plan.responses };
    evidence.unreleasedRealResponses = [...responsePauses.entries.values()];
    evidence.sourceSha256 = sha(runnerBytes);
    const text = JSON.stringify(redact(evidence, secrets), null, 2) + "\n";
    for (const secret of secrets) assert(!text.includes(secret), "PUBLIC_SECRET_LITERAL");
    assert(
      !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u.test(
        text,
      ),
    );
    writeFileSync(join(output, "proof.json"), text, { flag: "wx" });
    writeFileSync(join(runtime, "proof.json"), text, { flag: "wx" });
    console.log(
      JSON.stringify({
        status: evidence.status,
        runId,
        proof: join(output, "proof.json"),
        checks: evidence.checks.length,
        profileRetained: profile,
      }),
    );
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--run")
    console.log(
      "not_run: --run <exact-preview-instance.json> <reviewed-publication-gate.json> required; no default I/O",
    );
  else {
    assert.equal(process.argv.length, 5);
    await run(process.argv[3], process.argv[4]);
  }
}
