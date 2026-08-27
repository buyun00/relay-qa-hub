import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Notification,
  ipcMain,
  protocol,
  Tray,
} from "electron";
import log from "electron-log/main";
import electronUpdater from "electron-updater";

import { APP_HOST, APP_SCHEME, appUrl, isAppUrl, parseDesktopConfig } from "./config.js";
import type { DesktopConnectionStatus } from "./bridge-types.js";
import type { DesktopUpdateStatus } from "./bridge-types.js";
import {
  NotificationTransport,
  type DesktopNotification,
  type TransportStatus,
} from "./notification-transport.js";
import { fetchDurableInbox, proxyRendererApiRequest } from "./network.js";
import { createAuthenticatedWssClient } from "./wss-client.js";
import { DesktopUpdateController } from "./update-controller.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const APP_PROTOCOL = `${APP_SCHEME}:`;
const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const FALLBACK_TRAY_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const AUTO_UPDATE_INITIAL_DELAY_MS = 15_000;
const AUTO_UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const MAX_RENDERER_RECOVERY_ATTEMPTS = 3;
const AUTO_START_REGISTRY_NAME = "Relay QA Hub";

const config = parseDesktopConfig(process.env, {
  webAssetsDirectory: path.resolve(currentDirectory, "../../../apps/web/dist"),
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let transport: NotificationTransport;
let quitting = false;
let pendingBugId: string | null = null;
let assetsDirectory = config.webAssetsDirectory;
let updateController: DesktopUpdateController | null = null;
let updateCheckTimer: NodeJS.Timeout | null = null;
let updateCheckInterval: NodeJS.Timeout | null = null;
let rendererRecoveryAttempts = 0;

function responseJson(value: Record<string, string>, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function mimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function resolveAssetPath(rootDirectory: string, pathname: string): string | null {
  const rawSegments = pathname.split("/").filter((segment) => segment.length > 0);
  const segments: string[] = [];
  for (const rawSegment of rawSegments) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes("\\") ||
      segment.includes("\u0000") ||
      segment.includes("/")
    ) {
      return null;
    }
    segments.push(segment);
  }
  const root = path.resolve(rootDirectory);
  const candidate = path.resolve(root, ...segments);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  return candidate;
}

async function serveAsset(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== APP_HOST) return responseJson({ code: "APP_HOST_NOT_ALLOWED" }, 403);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return responseJson({ code: "ASSET_METHOD_NOT_ALLOWED" }, 405);
  }
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = resolveAssetPath(assetsDirectory, requestedPath);
  if (filePath === null) return responseJson({ code: "ASSET_PATH_NOT_ALLOWED" }, 403);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return responseJson({ code: "ASSET_NOT_FOUND" }, 404);
  }
  if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) {
    return responseJson({ code: "ASSET_NOT_AVAILABLE" }, 404);
  }
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: { "content-type": mimeType(filePath) } });
  }
  try {
    const content = await fs.readFile(filePath);
    return new Response(content, { status: 200, headers: { "content-type": mimeType(filePath) } });
  } catch {
    return responseJson({ code: "ASSET_READ_FAILED" }, 500);
  }
}

async function chooseAssetsDirectory(): Promise<void> {
  const resourcePath = (process as NodeJS.Process & { readonly resourcesPath?: string })
    .resourcesPath;
  const candidates = [
    config.webAssetsDirectory,
    resourcePath === undefined ? null : path.join(resourcePath, "web"),
    path.resolve(app.getAppPath(), "web"),
    path.resolve(app.getAppPath(), "../web/dist"),
    path.resolve(app.getAppPath(), "../../web/dist"),
    path.resolve(currentDirectory, "../../../apps/web/dist"),
  ].filter((candidate): candidate is string => candidate !== null);
  for (const candidate of candidates) {
    try {
      const result = await fs.stat(candidate);
      if (result.isDirectory()) {
        assetsDirectory = candidate;
        return;
      }
    } catch {
      // Continue to the next bounded candidate.
    }
  }
  assetsDirectory = config.webAssetsDirectory;
}

function isTrustedRendererUrl(value: string): boolean {
  if (isAppUrl(value)) return true;
  if (config.developmentUrl === null) return false;
  try {
    return new URL(value).origin === config.developmentUrl.origin;
  } catch {
    return false;
  }
}

function sendConnectionStatus(status: TransportStatus): void {
  const safeStatus: DesktopConnectionStatus = {
    state: status.state,
    reconnectAttempt: status.reconnectAttempt,
    lastError: status.lastError,
  };
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:connection-status", safeStatus);
  }
  rebuildTrayMenu();
}

function disabledUpdateStatus(): DesktopUpdateStatus {
  return {
    phase: "disabled",
    currentVersion: app.getVersion(),
    availableVersion: null,
    progressPercent: null,
    checkedAt: null,
    errorCode: null,
  };
}

function currentUpdateStatus(): DesktopUpdateStatus {
  return updateController?.status ?? disabledUpdateStatus();
}

function sendUpdateStatus(status: DesktopUpdateStatus): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:update-status", status);
  }
  rebuildTrayMenu();
  if (status.phase === "downloaded") {
    const version = status.availableVersion ?? "新版本";
    const notification = new Notification({
      title: `Relay QA Hub ${version} 已下载`,
      body: "更新已准备好，请在应用内点击“重启并安装”。",
      silent: false,
    });
    notification.once("click", openMainWindow);
    notification.show();
  }
}

function createDesktopUpdater(): DesktopUpdateController {
  const enabled = process.platform === "win32" && app.isPackaged;
  if (!enabled) {
    return new DesktopUpdateController({
      updater: null,
      currentVersion: app.getVersion(),
      enabled: false,
    });
  }
  log.initialize();
  log.transports.file.level = "info";
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.disableWebInstaller = true;
  const controller = new DesktopUpdateController({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    enabled: true,
  });
  controller.subscribe(sendUpdateStatus);
  return controller;
}

function scheduleAutomaticUpdateChecks(): void {
  if (updateController === null || updateController.status.phase === "disabled") return;
  updateCheckTimer = setTimeout(() => {
    void updateController?.checkForUpdates();
    updateCheckInterval = setInterval(() => {
      void updateController?.checkForUpdates();
    }, AUTO_UPDATE_INTERVAL_MS);
    updateCheckInterval.unref();
  }, AUTO_UPDATE_INITIAL_DELAY_MS);
  updateCheckTimer.unref();
}

function stopAutomaticUpdateChecks(): void {
  if (updateCheckTimer !== null) clearTimeout(updateCheckTimer);
  if (updateCheckInterval !== null) clearInterval(updateCheckInterval);
  updateCheckTimer = null;
  updateCheckInterval = null;
}

function openMainWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function normalizeBugId(value: string): string | null {
  return UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function routeToBug(bugId: string): void {
  const normalized = normalizeBugId(bugId);
  if (normalized === null) return;
  pendingBugId = normalized;
  openMainWindow();
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  if (!mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("desktop:open-bug", { bugId: normalized });
    process.stdout.write(
      `${JSON.stringify({ event: "desktop.bug-route.sent", bugId: normalized })}\n`,
    );
    pendingBugId = null;
  }
}

function parseBugDeepLink(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== APP_PROTOCOL || url.hostname !== "bug") return null;
    return normalizeBugId(url.pathname.replace(/^\//u, ""));
  } catch {
    return null;
  }
}

function handleInstanceArguments(args: readonly unknown[], openWhenNoDeepLink = true): void {
  for (const value of args) {
    if (typeof value !== "string") continue;
    const bugId = parseBugDeepLink(value);
    if (bugId !== null) {
      process.stdout.write(
        `${JSON.stringify({ event: "desktop.second-instance.deep-link", bugId })}\n`,
      );
      routeToBug(bugId);
      return;
    }
  }
  if (!openWhenNoDeepLink) return;
  process.stdout.write(
    `${JSON.stringify({ event: "desktop.second-instance.open", argumentCount: args.length })}\n`,
  );
  openMainWindow();
}

function trayIcon() {
  const configured = process.env["QA_HUB_DESKTOP_TRAY_ICON"]?.trim();
  if (configured !== undefined && configured.length > 0) {
    const image = nativeImage.createFromPath(path.resolve(configured));
    if (!image.isEmpty()) return image;
  }
  const webIcon = path.join(assetsDirectory, "icons", "qa-hub-192.svg");
  const webImage = nativeImage.createFromPath(webIcon);
  return webImage.isEmpty() ? nativeImage.createFromDataURL(FALLBACK_TRAY_ICON) : webImage;
}

function statusLabel(status: TransportStatus): string {
  switch (status.state) {
    case "connected":
      return "连接：已连接";
    case "connecting":
      return "连接：连接中";
    case "reconnecting":
      return `连接：重连中（第 ${status.reconnectAttempt} 次）`;
    case "paused":
      return "连接：通知已暂停";
    case "disabled":
      return "连接：未配置访问凭据";
    case "stopped":
      return "连接：已停止";
  }
}

function setAutoStartAtLogin(enabled: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: ["--autostart"],
      name: AUTO_START_REGISTRY_NAME,
    });
  } catch {
    // Unsupported platforms keep the menu action harmless and reversible.
  }
  rebuildTrayMenu();
}

function rebuildTrayMenu(): void {
  if (tray === null) return;
  const status = transport?.status ?? { state: "stopped", reconnectAttempt: 0, lastError: null };
  const paused = status.state === "paused";
  let autoStart = config.autoStartAtLogin;
  try {
    autoStart = app.getLoginItemSettings({ args: ["--autostart"] }).openAtLogin;
  } catch {
    // Keep the configured default when the platform does not expose login settings.
  }
  const update = currentUpdateStatus();
  const updateBusy =
    update.phase === "checking" ||
    update.phase === "available" ||
    update.phase === "downloading" ||
    update.phase === "installing";
  const updateLabel =
    update.phase === "downloaded"
      ? `重启并安装 ${update.availableVersion ?? "新版本"}`
      : update.phase === "downloading"
        ? `正在下载更新 ${update.progressPercent ?? 0}%`
        : update.phase === "checking"
          ? "正在检查更新"
          : update.phase === "up-to-date"
            ? `已是最新版本 ${update.currentVersion}`
            : update.phase === "error"
              ? "更新检查失败，点击重试"
              : update.phase === "disabled"
                ? `应用版本 ${update.currentVersion}`
                : `检查更新 · ${update.currentVersion}`;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 QA Hub", click: openMainWindow },
      { label: statusLabel(status), enabled: false },
      { type: "separator" },
      {
        label: paused ? "恢复通知" : "暂停通知",
        click: () => {
          if (paused) transport.resume();
          else transport.pause();
          rebuildTrayMenu();
        },
      },
      {
        label: "登录时启动",
        type: "checkbox",
        checked: autoStart,
        click: () => setAutoStartAtLogin(!autoStart),
      },
      {
        label: updateLabel,
        enabled: update.phase !== "disabled" && !updateBusy,
        click: () => {
          if (update.phase === "downloaded") updateController?.installUpdate();
          else void updateController?.checkForUpdates();
        },
      },
      { type: "separator" },
      { label: "退出 QA Hub", click: quitApplication },
    ]),
  );
}

function showNativeNotification(notification: DesktopNotification): void {
  const nativeNotification = new Notification({
    title: `QA Hub · ${notification.title}`,
    body: notification.body,
    silent: false,
  });
  nativeNotification.once("show", () => {
    process.stdout.write(
      `${JSON.stringify({
        event: "desktop.notification.shown",
        notificationId: notification.notificationId,
        eventId: notification.eventId,
        bugId: notification.bugId,
      })}\n`,
    );
  });
  nativeNotification.once("click", () => {
    process.stdout.write(
      `${JSON.stringify({
        event: "desktop.notification.clicked",
        notificationId: notification.notificationId,
        eventId: notification.eventId,
        bugId: notification.bugId,
      })}\n`,
    );
    if (notification.bugId !== null) routeToBug(notification.bugId);
    else openMainWindow();
  });
  nativeNotification.show();
}

function quitApplication(): void {
  if (quitting) return;
  quitting = true;
  transport.stop();
  tray?.destroy();
  tray = null;
  app.quit();
}

function installNavigationGuards(window: BrowserWindow): void {
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#f4f7f5",
    title: "Relay QA Hub",
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  installNavigationGuards(window);
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.webContents.once("did-finish-load", () => {
    rendererRecoveryAttempts = 0;
    if (pendingBugId !== null) {
      const bugId = pendingBugId;
      pendingBugId = null;
      window.webContents.send("desktop:open-bug", { bugId });
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    if (quitting) return;
    rendererRecoveryAttempts += 1;
    process.stderr.write(
      `${JSON.stringify({
        event: "desktop.renderer.gone",
        reason: details.reason,
        attempt: rendererRecoveryAttempts,
      })}\n`,
    );
    if (rendererRecoveryAttempts > MAX_RENDERER_RECOVERY_ATTEMPTS) {
      const notification = new Notification({
        title: "Relay QA Hub 需要重新打开",
        body: "界面连续恢复失败，请从托盘退出后重新启动应用。",
      });
      notification.show();
      return;
    }
    const recoveryTimer = setTimeout(() => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.reload();
      }
    }, 1_000);
    recoveryTimer.unref();
  });
  return window;
}

function installIpcHandlers(): void {
  ipcMain.removeHandler("desktop:get-connection-status");
  ipcMain.removeHandler("desktop:get-notifications-paused");
  ipcMain.removeHandler("desktop:get-update-status");
  ipcMain.removeHandler("desktop:check-for-updates");
  ipcMain.removeHandler("desktop:install-update");
  ipcMain.handle("desktop:get-connection-status", (event) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url ?? "")) {
      return { state: "stopped", reconnectAttempt: 0, lastError: "UNTRUSTED_SENDER" };
    }
    return transport.status;
  });
  ipcMain.handle("desktop:get-notifications-paused", (event) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url ?? "")) return false;
    return transport.status.state === "paused";
  });
  ipcMain.handle("desktop:get-update-status", (event) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url ?? "")) return disabledUpdateStatus();
    return currentUpdateStatus();
  });
  ipcMain.handle("desktop:check-for-updates", async (event) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url ?? "")) return disabledUpdateStatus();
    return (await updateController?.checkForUpdates()) ?? disabledUpdateStatus();
  });
  ipcMain.handle("desktop:install-update", (event) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url ?? "")) return false;
    return updateController?.installUpdate() ?? false;
  });
}

async function registerAppProtocol(): Promise<void> {
  await chooseAssetsDirectory();
  protocol.handle(APP_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return responseJson({ code: "APP_URL_INVALID" }, 400);
    }
    if (url.protocol !== APP_PROTOCOL || url.hostname !== APP_HOST) {
      return responseJson({ code: "APP_ORIGIN_NOT_ALLOWED" }, 403);
    }
    if (url.pathname.startsWith("/api/")) {
      return proxyRendererApiRequest(request, config);
    }
    return serveAsset(request);
  });
}

function createTransport(): NotificationTransport {
  return new NotificationTransport({
    socketUrl: config.wssUrl,
    accessToken: config.accessToken,
    openSocket: createAuthenticatedWssClient,
    fetchInbox: () => fetchDurableInbox(config),
    showNotification: showNativeNotification,
    onStatus: sendConnectionStatus,
  });
}

async function startApplication(): Promise<void> {
  if (process.platform === "win32") app.setAppUserModelId("com.relayqahub.desktop");
  await registerAppProtocol();
  updateController = createDesktopUpdater();
  transport = createTransport();
  installIpcHandlers();
  tray = new Tray(trayIcon());
  tray.setToolTip("Relay QA Hub");
  tray.on("click", openMainWindow);
  tray.on("double-click", openMainWindow);
  rebuildTrayMenu();
  if (
    process.env["QA_HUB_DESKTOP_AUTO_START"] !== undefined ||
    process.env["QA_HUB_DESKTOP_AUTO_START_LOGIN"] !== undefined
  ) {
    try {
      app.setLoginItemSettings({
        openAtLogin: config.autoStartAtLogin,
        args: ["--autostart"],
        name: AUTO_START_REGISTRY_NAME,
      });
    } catch {
      // Login startup is best effort and remains explicitly visible in the tray menu.
    }
  }
  mainWindow = createWindow();
  const useDevelopmentUrl =
    !app.isPackaged &&
    config.developmentUrl !== null &&
    process.env["QA_HUB_DESKTOP_USE_DEV_URL"]?.trim() === "1";
  const target =
    useDevelopmentUrl && config.developmentUrl !== null
      ? config.developmentUrl.toString()
      : appUrl();
  await mainWindow.loadURL(target);
  const launchedForAutostart = process.argv.includes("--autostart");
  if (!config.startupHidden && !launchedForAutostart) openMainWindow();
  handleInstanceArguments(process.argv, false);
  transport.start();
  scheduleAutomaticUpdateChecks();
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
  app.on("second-instance", (...args: readonly unknown[]) => {
    const commandLine = Array.isArray(args[1]) ? args[1] : [];
    handleInstanceArguments(commandLine);
  });
  app.on("before-quit", () => {
    if (!quitting) {
      quitting = true;
      transport?.stop();
      stopAutomaticUpdateChecks();
    }
  });
  app.on("window-all-closed", () => {
    // The hidden window and notification transport intentionally keep the tray app alive.
  });
  void app
    .whenReady()
    .then(startApplication)
    .catch(() => {
      quitting = true;
      transport?.stop();
      app.quit();
    });
}
