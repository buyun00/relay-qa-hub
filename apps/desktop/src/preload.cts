import electron = require("electron");

import type { DesktopConnectionStatus, QaHubDesktopBridge } from "./bridge-types.js";

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
  onConnectionStatus: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      listener(parseStatus(value));
    };
    ipcRenderer.on("desktop:connection-status", handler);
    return () => ipcRenderer.removeListener("desktop:connection-status", handler);
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
