import electron = require("electron");

import type {
  DesktopConnectionStatus,
  DesktopUpdatePhase,
  DesktopUpdateStatus,
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
const UPDATE_PHASES = new Set<DesktopUpdatePhase>([
  "disabled",
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "up-to-date",
  "installing",
  "error",
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

function parseUpdateStatus(value: unknown): DesktopUpdateStatus {
  if (!isRecord(value)) {
    return {
      phase: "disabled",
      currentVersion: "unknown",
      availableVersion: null,
      progressPercent: null,
      checkedAt: null,
      errorCode: null,
    };
  }
  const phase = value["phase"];
  const currentVersion = value["currentVersion"];
  const availableVersion = value["availableVersion"];
  const progressPercent = value["progressPercent"];
  const checkedAt = value["checkedAt"];
  const errorCode = value["errorCode"];
  return {
    phase:
      typeof phase === "string" && UPDATE_PHASES.has(phase as DesktopUpdatePhase)
        ? (phase as DesktopUpdatePhase)
        : "disabled",
    currentVersion:
      typeof currentVersion === "string" && currentVersion.length <= 64
        ? currentVersion
        : "unknown",
    availableVersion:
      typeof availableVersion === "string" && availableVersion.length <= 64
        ? availableVersion
        : null,
    progressPercent:
      typeof progressPercent === "number" &&
      Number.isFinite(progressPercent) &&
      progressPercent >= 0 &&
      progressPercent <= 100
        ? progressPercent
        : null,
    checkedAt:
      typeof checkedAt === "string" && !Number.isNaN(Date.parse(checkedAt)) ? checkedAt : null,
    errorCode: typeof errorCode === "string" && errorCode.length <= 64 ? errorCode : null,
  };
}

function safeBugId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const bugId = value["bugId"];
  return typeof bugId === "string" && UUID_PATTERN.test(bugId) ? bugId.toLowerCase() : null;
}

const bridge: QaHubDesktopBridge = {
  getConnectionStatus: async () =>
    parseStatus(await ipcRenderer.invoke("desktop:get-connection-status")),
  getNotificationsPaused: async () => {
    const value = await ipcRenderer.invoke("desktop:get-notifications-paused");
    return value === true;
  },
  getUpdateStatus: async () =>
    parseUpdateStatus(await ipcRenderer.invoke("desktop:get-update-status")),
  checkForUpdates: async () =>
    parseUpdateStatus(await ipcRenderer.invoke("desktop:check-for-updates")),
  installUpdate: async () => {
    const value = await ipcRenderer.invoke("desktop:install-update");
    return value === true;
  },
  onConnectionStatus: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      listener(parseStatus(value));
    };
    ipcRenderer.on("desktop:connection-status", handler);
    return () => ipcRenderer.removeListener("desktop:connection-status", handler);
  },
  onUpdateStatus: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      listener(parseUpdateStatus(value));
    };
    ipcRenderer.on("desktop:update-status", handler);
    return () => ipcRenderer.removeListener("desktop:update-status", handler);
  },
  onOpenBug: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      const bugId = safeBugId(value);
      if (bugId === null) return;
      listener(bugId);
    };
    ipcRenderer.on("desktop:open-bug", handler);
    return () => ipcRenderer.removeListener("desktop:open-bug", handler);
  },
};

contextBridge.exposeInMainWorld("qaHubDesktop", bridge);
