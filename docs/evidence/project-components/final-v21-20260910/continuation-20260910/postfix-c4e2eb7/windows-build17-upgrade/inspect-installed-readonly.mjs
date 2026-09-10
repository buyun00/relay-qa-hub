const port = 9433;
const expectedRuntimeVersion = process.argv[2];
const expectedUpdateStatus = process.argv[3];
const expectedUpdateVersion = process.argv[4];
const expectedUpdateReleaseId = process.argv[5];
const expectedConnectionLastError = process.argv[6] === "__null__" ? null : process.argv[6];
if (!expectedRuntimeVersion || !expectedUpdateStatus || !expectedUpdateVersion || !expectedUpdateReleaseId || process.argv[6] === undefined) {
  throw new Error(
    "usage: node inspect-installed-readonly.mjs <runtimeVersion> <updateStatus> <updateVersion> <updateReleaseId> <lastError|__null__>",
  );
}
const expectedScheme = "qa-hub-preview-v21-e2e-fresh-0910://app/";
const expectedProject = "305b4def-ae7e-4a2d-ae96-a05d616390bf";
const expectedUser = "0ddff48b-536c-4c30-8b42-511741010610";
const primaryHash = "125cf35171bf74f353b590141b55f8b51d8c03f6bf9b7a66bb4da317832ac56c";
const fallbackHash = "4633cd88dc0b379c68827d385575105a4e24f407314a2c4ca3638a62918d0166";
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const pages = targets.filter((item) => item.type === "page" && item.url.startsWith(expectedScheme));
if (pages.length !== 1 || !pages[0].webSocketDebuggerUrl) throw new Error(`EXACT_PAGE_REQUIRED:${pages.length}`);
const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP_CONNECT_FAILED")), { once: true });
});
let sequence = 0;
const pending = new Map();
const events = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (typeof message.id !== "number") {
    if (["Runtime.exceptionThrown", "Log.entryAdded", "Runtime.consoleAPICalled"].includes(message.method)) events.push(message);
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
  else waiter.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await call("Runtime.enable");
await call("Log.enable");
await call("Page.enable");
const expression = String.raw`(async () => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const hash = async text => {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  };
  const databaseName = "qa-hub-preview-project-drafts-v1";
  const databaseInfo = (await indexedDB.databases()).find(item => item.name === databaseName);
  if (!databaseInfo || typeof databaseInfo.version !== "number") throw new Error("DRAFT_DATABASE_NOT_PRESENT");
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseInfo.version);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      reject(new Error("READ_ONLY_VERSION_CHANGED"));
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  let records;
  try {
    if (!database.objectStoreNames.contains("drafts")) throw new Error("DRAFT_STORE_NOT_PRESENT");
    const rows = await new Promise((resolve, reject) => {
      const output = [];
      const request = database.transaction("drafts", "readonly").objectStore("drafts").openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(output);
        output.push({ key: cursor.key, value: cursor.value });
        cursor.continue();
      };
    });
    records = [];
    const prefix = "qa-hub:preview:v2:";
    for (const row of rows) {
      if (typeof row.key !== "string" || !row.key.startsWith(prefix)) continue;
      const scope = JSON.parse(row.key.slice(prefix.length));
      if (!Array.isArray(scope) || scope[3] !== "bug-drafts") continue;
      const content = typeof row.value?.newContent === "string" ? row.value.newContent : "";
      records.push({ serviceIdentity: scope[0], projectId: scope[1], userId: scope[2], kind: scope[3], newContentLength: content.length, newContentSha256: await hash(content) });
    }
  } finally {
    database.close();
  }
  let textarea = document.querySelector(".create-modal textarea");
  if (!textarea) {
    const button = [...document.querySelectorAll("button")].find(item => (item.textContent ?? "").includes("新建 Bug"));
    if (!button) throw new Error("CREATE_BUTTON_MISSING");
    button.click();
    for (let index = 0; index < 50 && !textarea; index += 1) {
      await delay(100);
      textarea = document.querySelector(".create-modal textarea");
    }
  }
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("DRAFT_TEXTAREA_MISSING");
  const runtime = typeof window.qaHubDesktop?.getRuntimeInfo === "function" ? await window.qaHubDesktop.getRuntimeInfo() : null;
  const update = typeof window.qaHubDesktop?.getUpdateState === "function" ? await window.qaHubDesktop.getUpdateState() : null;
  const connection = typeof window.qaHubDesktop?.getConnectionStatus === "function" ? await window.qaHubDesktop.getConnectionStatus() : null;
  return {
    readOnlyStorage: true,
    url: location.href,
    readyState: document.readyState,
    bridgeType: typeof window.qaHubDesktop,
    bridgeMethods: window.qaHubDesktop ? Object.keys(window.qaHubDesktop).sort() : [],
    appReady: document.querySelector(".app-shell") !== null,
    loginVisible: document.querySelector(".auth-form") !== null,
    loginNameVisible: (document.body?.innerText ?? "").includes("Luna Worker 246"),
    projectId: document.querySelector('select[aria-label="切换项目"]')?.value ?? null,
    runtime,
    update,
    connection,
    uiDraft: { length: textarea.value.length, sha256: await hash(textarea.value) },
    database: { name: databaseName, version: databaseInfo.version, store: "drafts", records }
  };
})()`;
async function inspect() {
  const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(`EVALUATION_FAILED:${JSON.stringify(response.exceptionDetails)}`);
  return response.result?.value;
}
const beforeReload = await inspect();
const eventStart = events.length;
await call("Page.reload", { ignoreCache: false });
let afterReload = null;
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  await delay(250);
  try {
    const probe = await call("Runtime.evaluate", { expression: "({readyState:document.readyState,appReady:document.querySelector('.app-shell')!==null,bridge:typeof window.qaHubDesktop})", returnByValue: true });
    if (probe.result?.value?.readyState === "complete" && probe.result?.value?.appReady && probe.result?.value?.bridge === "object") {
      afterReload = await inspect();
      break;
    }
  } catch {}
}
if (!afterReload) throw new Error("RELOAD_READINESS_TIMEOUT");
await delay(1000);
const reloadEvents = events.slice(eventStart).map((event) => ({ method: event.method, params: event.params }));
const serializedEvents = JSON.stringify(reloadEvents);
const primary = afterReload.database.records.find((record) => record.serviceIdentity === "http://127.0.0.1:4639" && record.projectId === expectedProject && record.userId === expectedUser);
const fallback = afterReload.database.records.find((record) => record.serviceIdentity === "qa-hub-preview-v21-e2e-fresh-0910://app" && record.projectId === expectedProject && record.userId === expectedUser);
const requiredMethods = ["getRuntimeInfo", "getUpdateState", "getConnectionStatus", "notifyPackaging", "onOpenPackaging"];
const checks = {
  exactTarget: pages.length === 1,
  bridgeAvailableBeforeReload: beforeReload.bridgeType === "object",
  bridgeAvailableAfterReload: afterReload.bridgeType === "object",
  requiredBridgeMethodsAfterReload: requiredMethods.every((name) => afterReload.bridgeMethods.includes(name)),
  appReadyAfterReload: afterReload.appReady === true,
  signedInAfterReload: afterReload.loginVisible === false && afterReload.loginNameVisible === true,
  projectExactAfterReload: afterReload.projectId === expectedProject,
  runtimeExpectedAfterReload: afterReload.runtime?.version === expectedRuntimeVersion && afterReload.runtime?.apiBaseUrl === "http://127.0.0.1:4639",
  mcp4642AfterReload: afterReload.runtime?.mcp?.state === "listening" && afterReload.runtime?.mcp?.port === 4642,
  updateExpectedAfterReload: afterReload.update?.status === expectedUpdateStatus && afterReload.update?.version === expectedUpdateVersion &&
    (expectedUpdateStatus !== "up-to-date" || afterReload.update?.currentReleaseId === expectedUpdateReleaseId) &&
    (expectedUpdateStatus !== "ready" || afterReload.update?.releaseId === expectedUpdateReleaseId),
  connectionExpectedAfterReload: afterReload.connection?.state === "connected" && afterReload.connection?.lastError === expectedConnectionLastError,
  primaryDraftVisibleAfterReload: afterReload.uiDraft?.length === 21 && afterReload.uiDraft?.sha256 === primaryHash,
  primaryRecordRetained: primary?.newContentLength === 21 && primary?.newContentSha256 === primaryHash,
  fallbackRecordRetained: fallback?.newContentLength === 25 && fallback?.newContentSha256 === fallbackHash,
  noPreloadOrModuleErrorOnReload: !/(unable to load preload|preload script|module not found|bug-route\.cjs)/iu.test(serializedEvents)
};
const result = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  expected: {
    runtimeVersion: expectedRuntimeVersion,
    updateStatus: expectedUpdateStatus,
    updateVersion: expectedUpdateVersion,
    updateReleaseId: expectedUpdateReleaseId,
    connectionLastError: expectedConnectionLastError
  },
  target: { id: pages[0].id, url: pages[0].url },
  beforeReload,
  afterReload,
  reloadEvents,
  checks,
  passed: Object.values(checks).every(Boolean)
};
socket.close();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;
