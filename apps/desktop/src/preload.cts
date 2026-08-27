import electron = require("electron");

import type {
  DesktopBugChange,
  DesktopConnectionStatus,
  DesktopRuntimeInfo,
  DesktopUpdateState,
  QaHubDesktopBridge,
} from "./bridge-types.js";

const { contextBridge, ipcRenderer } = electron;
type IpcRendererEvent = import("electron").IpcRendererEvent;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
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
  if (!isRecord(value)) return { apiBaseUrl: "", notificationsEnabled: false };
  const apiBaseUrl = value["apiBaseUrl"];
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
  return {
    apiBaseUrl: safeApiBaseUrl,
    notificationsEnabled: value["notificationsEnabled"] === true,
  };
}

function safeBugId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const bugId = value["bugId"];
  return typeof bugId === "string" && UUID_PATTERN.test(bugId) ? bugId.toLowerCase() : null;
}

function parseBugChange(value: unknown): DesktopBugChange | null {
  if (!isRecord(value)) return null;
  const notificationId = value["notificationId"];
  const eventId = value["eventId"];
  const bugId = value["bugId"];
  if (
    typeof notificationId !== "string" ||
    !UUID_PATTERN.test(notificationId) ||
    (eventId !== null && (typeof eventId !== "string" || !UUID_PATTERN.test(eventId))) ||
    (bugId !== null && (typeof bugId !== "string" || !UUID_PATTERN.test(bugId)))
  ) {
    return null;
  }
  return {
    notificationId: notificationId.toLowerCase(),
    eventId: eventId === null ? null : eventId.toLowerCase(),
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
const openBugListeners = new Set<(bugId: string) => void>();
const updateStateListeners = new Set<(state: DesktopUpdateState) => void>();
let pendingBugChange: DesktopBugChange | null = null;
let pendingOpenBugId: string | null = null;

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
  const bugId = safeBugId(value);
  if (bugId === null) return;
  if (openBugListeners.size === 0) pendingOpenBugId = bugId;
  for (const listener of openBugListeners) listener(bugId);
});
ipcRenderer.on("desktop:update-state", (_event: IpcRendererEvent, value: unknown) => {
  const state = parseUpdateState(value);
  for (const listener of updateStateListeners) listener(state);
});

const bridge: QaHubDesktopBridge = {
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
    if (pendingOpenBugId !== null) {
      const bugId = pendingOpenBugId;
      pendingOpenBugId = null;
      queueMicrotask(() => {
        if (openBugListeners.has(listener)) listener(bugId);
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
