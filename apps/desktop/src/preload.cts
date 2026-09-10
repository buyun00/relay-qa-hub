import electron = require("electron");

import type {
  DesktopBugChange,
  DesktopBugRoute,
  DesktopConnectionStatus,
  DesktopRuntimeInfo,
  DesktopUpdateState,
  DesktopWindowState,
  QaHubDesktopBridge,
} from "./bridge-types.js";

const { contextBridge, ipcRenderer } = electron;
type IpcRendererEvent = import("electron").IpcRendererEvent;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const BUG_ROUTE_KEYS = new Set(["projectId", "userId", "bugId"]);
const STATES = new Set([
  "disabled",
  "stopped",
  "connecting",
  "connected",
  "reconnecting",
  "paused",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableUuid(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return undefined;
  return value.toLowerCase();
}

// Sandboxed Electron preloads cannot require local modules, so this parser must stay
// self-contained. The sandbox preload smoke compares it with the main-process parser.
function parseDesktopBugRoute(value: unknown): DesktopBugRoute | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !BUG_ROUTE_KEYS.has(key))) return null;
  const bugId = value["bugId"];
  const projectId = nullableUuid(value["projectId"]);
  const userId = nullableUuid(value["userId"]);
  if (
    typeof bugId !== "string" ||
    !UUID_PATTERN.test(bugId) ||
    projectId === undefined ||
    userId === undefined ||
    (projectId === null) !== (userId === null)
  ) {
    return null;
  }
  return {
    projectId,
    userId,
    bugId: bugId.toLowerCase(),
  };
}

function parseWindowState(value: unknown): DesktopWindowState {
  return {
    maximized: isRecord(value) && value["maximized"] === true,
    fullScreen: isRecord(value) && value["fullScreen"] === true,
  };
}

function parseStatus(value: unknown): DesktopConnectionStatus {
  if (!isRecord(value)) return { state: "stopped", reconnectAttempt: 0, lastError: null };
  const state = value["state"];
  const reconnectAttempt = value["reconnectAttempt"];
  const lastError = value["lastError"];
  return {
    state:
      typeof state === "string" && STATES.has(state)
        ? (state as DesktopConnectionStatus["state"])
        : "stopped",
    reconnectAttempt:
      Number.isSafeInteger(reconnectAttempt) && (reconnectAttempt as number) >= 0
        ? (reconnectAttempt as number)
        : 0,
    lastError: typeof lastError === "string" && lastError.length <= 100 ? lastError : null,
  };
}

function parseRuntimeInfo(value: unknown): DesktopRuntimeInfo {
  if (!isRecord(value)) value = {};
  const record = value as Record<string, unknown>;
  const apiBaseUrl = record["apiBaseUrl"];
  let safeApiBaseUrl = "";
  if (typeof apiBaseUrl === "string" && apiBaseUrl.length <= 2_048) {
    try {
      const parsed = new URL(apiBaseUrl);
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.origin === apiBaseUrl
      ) {
        safeApiBaseUrl = parsed.origin;
      }
    } catch {
      // Invalid main-process data is reduced to the empty safe fallback.
    }
  }
  const mcp = isRecord(record["mcp"]) ? record["mcp"] : {};
  const port =
    Number.isSafeInteger(mcp["port"]) &&
    (mcp["port"] as number) > 0 &&
    (mcp["port"] as number) <= 65535
      ? (mcp["port"] as number)
      : 4420;
  const state = mcp["state"];
  return {
    apiBaseUrl: safeApiBaseUrl,
    notificationsEnabled: record["notificationsEnabled"] === true,
    version: shortText(record["version"], "unknown"),
    mcp: {
      state:
        typeof state === "string" &&
        ["disabled", "stopped", "starting", "listening", "failed"].includes(state)
          ? (state as DesktopRuntimeInfo["mcp"]["state"])
          : "stopped",
      port,
      url: `http://127.0.0.1:${port}/mcp`,
      lastError: typeof mcp["lastError"] === "string" ? mcp["lastError"].slice(0, 200) : null,
    },
  };
}

function parseBugChange(value: unknown): DesktopBugChange | null {
  if (!isRecord(value)) return null;
  const notificationId = value["notificationId"];
  const eventId = value["eventId"];
  const projectId = value["projectId"];
  const userId = value["userId"];
  const bugId = value["bugId"];
  if (
    typeof notificationId !== "string" ||
    !UUID_PATTERN.test(notificationId) ||
    (eventId !== null && (typeof eventId !== "string" || !UUID_PATTERN.test(eventId))) ||
    typeof projectId !== "string" ||
    !UUID_PATTERN.test(projectId) ||
    typeof userId !== "string" ||
    !UUID_PATTERN.test(userId) ||
    (bugId !== null && (typeof bugId !== "string" || !UUID_PATTERN.test(bugId)))
  ) {
    return null;
  }
  return {
    notificationId: notificationId.toLowerCase(),
    eventId: eventId === null ? null : eventId.toLowerCase(),
    projectId: projectId.toLowerCase(),
    userId: userId.toLowerCase(),
    bugId: bugId === null ? null : bugId.toLowerCase(),
  };
}

function shortText(value: unknown, fallback = "UPDATE_STATE_INVALID"): string {
  return typeof value === "string" && value.length > 0 && value.length <= 100 ? value : fallback;
}

function parseUpdateState(value: unknown): DesktopUpdateState {
  if (!isRecord(value) || typeof value["status"] !== "string") {
    return { status: "error", message: "UPDATE_STATE_INVALID" };
  }
  const status = value["status"];
  if (status === "disabled" || status === "error") {
    return { status, message: shortText(value["message"]) };
  }
  const version = shortText(value["version"], "unknown");
  if (status === "idle" || status === "checking" || status === "up-to-date") {
    return {
      status,
      currentReleaseId: shortText(value["currentReleaseId"], "unknown"),
      version,
    };
  }
  if (status === "downloading") {
    const progress = value["progressPercent"];
    return {
      status,
      releaseId: shortText(value["releaseId"], "unknown"),
      version,
      progressPercent:
        Number.isSafeInteger(progress) && (progress as number) >= 0 && (progress as number) <= 100
          ? (progress as number)
          : 0,
    };
  }
  if (status === "ready") {
    return {
      status,
      releaseId: shortText(value["releaseId"], "unknown"),
      version,
      publishedAt: shortText(value["publishedAt"], "unknown"),
    };
  }
  if (status === "installing") {
    return {
      status,
      releaseId: shortText(value["releaseId"], "unknown"),
      version,
    };
  }
  return { status: "error", message: "UPDATE_STATE_INVALID" };
}

const connectionStatusListeners = new Set<(status: DesktopConnectionStatus) => void>();
const bugChangeListeners = new Set<(change: DesktopBugChange) => void>();
const openBugListeners = new Set<(route: DesktopBugRoute) => void>();
const updateStateListeners = new Set<(state: DesktopUpdateState) => void>();
let pendingBugChange: DesktopBugChange | null = null;
let pendingOpenBugRoute: DesktopBugRoute | null = null;

ipcRenderer.on("desktop:connection-status", (_event: IpcRendererEvent, value: unknown) => {
  const status = parseStatus(value);
  for (const listener of connectionStatusListeners) listener(status);
});
ipcRenderer.on("desktop:bug-changed", (_event: IpcRendererEvent, value: unknown) => {
  const change = parseBugChange(value);
  if (change === null) return;
  if (bugChangeListeners.size === 0) pendingBugChange = change;
  for (const listener of bugChangeListeners) listener(change);
});
ipcRenderer.on("desktop:open-bug", (_event: IpcRendererEvent, value: unknown) => {
  const route = parseDesktopBugRoute(value);
  if (route === null) return;
  if (openBugListeners.size === 0) pendingOpenBugRoute = route;
  for (const listener of openBugListeners) listener(route);
});
ipcRenderer.on("desktop:update-state", (_event: IpcRendererEvent, value: unknown) => {
  const state = parseUpdateState(value);
  for (const listener of updateStateListeners) listener(state);
});

const bridge: QaHubDesktopBridge = {
  uploader: {
    snapshot: () => ipcRenderer.invoke("desktop:uploader:snapshot"),
    login: (input) =>
      ipcRenderer.invoke("desktop:uploader:login", {
        account: input.account,
        password: input.password,
        kind: input.kind,
      }),
    checkAuth: () => ipcRenderer.invoke("desktop:uploader:check-auth"),
    logout: () => ipcRenderer.invoke("desktop:uploader:logout"),
    start: (input) => ipcRenderer.invoke("desktop:uploader:start", input),
    resume: (input) =>
      ipcRenderer.invoke("desktop:uploader:resume", {
        id: input.id,
        testerId: input.testerId,
        testResultReference: input.testResultReference,
      }),
    openFolder: (id) => ipcRenderer.invoke("desktop:uploader:open-folder", id),
    confirmPublish: (id) => ipcRenderer.invoke("desktop:uploader:confirm-publish", id),
    buildChains: () => ipcRenderer.invoke("desktop:uploader:build-chains"),
    buildAndUpload: (input) => ipcRenderer.invoke("desktop:uploader:build-and-upload", input),
    cancelBuildUpload: (id) => ipcRenderer.invoke("desktop:uploader:cancel-build-upload", id),
  },
  windowControlsOverlay: true,
  windowAction: async (action) =>
    (await ipcRenderer.invoke("desktop:window-action", action)) === true,
  getWindowState: async () =>
    parseWindowState(await ipcRenderer.invoke("desktop:get-window-state")),
  onWindowState: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown) => listener(parseWindowState(value));
    ipcRenderer.on("desktop:window-state", handler);
    return () => ipcRenderer.removeListener("desktop:window-state", handler);
  },
  notifyPackaging: async (notice) =>
    (await ipcRenderer.invoke("desktop:notify-packaging", {
      id: notice.id,
      kind: notice.kind,
      title: notice.title,
      body: notice.body,
    })) === true,
  onOpenPackaging: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("desktop:open-packaging", handler);
    return () => ipcRenderer.removeListener("desktop:open-packaging", handler);
  },
  getConnectionStatus: async () =>
    parseStatus(await ipcRenderer.invoke("desktop:get-connection-status")),
  getRuntimeInfo: async () =>
    parseRuntimeInfo(await ipcRenderer.invoke("desktop:get-runtime-info")),
  getNotificationsPaused: async () => {
    const value = await ipcRenderer.invoke("desktop:get-notifications-paused");
    return value === true;
  },
  getUpdateState: async () =>
    parseUpdateState(await ipcRenderer.invoke("desktop:get-update-state")),
  checkForUpdate: async () => (await ipcRenderer.invoke("desktop:check-update")) === true,
  installUpdate: async () => (await ipcRenderer.invoke("desktop:install-update")) === true,
  onConnectionStatus: (listener) => {
    connectionStatusListeners.add(listener);
    return () => connectionStatusListeners.delete(listener);
  },
  onBugChanged: (listener) => {
    bugChangeListeners.add(listener);
    if (pendingBugChange !== null) {
      const change = pendingBugChange;
      pendingBugChange = null;
      queueMicrotask(() => {
        if (bugChangeListeners.has(listener)) listener(change);
      });
    }
    return () => bugChangeListeners.delete(listener);
  },
  onOpenBug: (listener) => {
    openBugListeners.add(listener);
    if (pendingOpenBugRoute !== null) {
      const route = pendingOpenBugRoute;
      pendingOpenBugRoute = null;
      queueMicrotask(() => {
        if (openBugListeners.has(listener)) listener(route);
      });
    }
    return () => openBugListeners.delete(listener);
  },
  onUpdateState: (listener) => {
    updateStateListeners.add(listener);
    return () => updateStateListeners.delete(listener);
  },
};

contextBridge.exposeInMainWorld("qaHubDesktop", bridge);
