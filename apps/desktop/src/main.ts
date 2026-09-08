import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  type NativeImage,
  Notification,
  ipcMain,
  protocol,
  shell,
  Tray,
} from "electron";

import { APP_HOST, APP_SCHEME, appUrl, isAppUrl, parseDesktopConfig } from "./config.js";
import { isPackageDownloadUrl } from "./package-downloads.js";
import { parsePackagingNotice } from "./packaging-notifications.js";
import { UploaderHost } from "./uploader-host.js";
import type { DesktopBugChange, DesktopConnectionStatus } from "./bridge-types.js";
import { NotificationHistory } from "./notification-history.js";
import {
  NotificationTransport,
  type DesktopNotification,
  type TransportStatus,
} from "./notification-transport.js";
import {
  DesktopBrowserSessionCookieStore,
  fetchDurableInbox,
  proxyRendererApiRequest,
} from "./network.js";
import { DesktopQaHubApiClient, QaHubMcpTools } from "./mcp-api.js";
import { QaHubMcpHttpServer, type QaHubMcpServerStatus } from "./mcp-server.js";
import { loadDesktopRuntimeEnvironment, resolveDesktopRuntimePaths } from "./runtime-config.js";
import { createAuthenticatedWssClient, createBrowserSessionWssClient } from "./wss-client.js";
import { PortableUpdater, type DesktopUpdateState } from "./portable-updater.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const APP_PROTOCOL = `${APP_SCHEME}:`;
const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const FALLBACK_TRAY_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAMYSURBVFhHzZdrSBVBFMf92De7SmCf8lP1JfqS2O6mV9EsNB8INwQNboQZhhaE9tYLEdotKiG0h5VIJIFBVGRED+lBaVT0gF7QA8u8lN180ccT/6WdZs/o7kputPDjcmfOnPOfM2d2dhIS/rdnXjA4K9kwsgKGFplp4DcxGJzNY4onYGjbArr2M8nQyVd0vQkT5cEjiqGPBAzttAg+J5iW8k9mzkjWtIWmgGRNK+Gdk5GzLkx7Wlvo8s0eev/hJQ0OvqPrd2+YbeEd9Yq9O0s3e0p/at5y6jjfReMjQ45AzIJVBcr4qUBcVwEZa8rp1ZtnSrCpQFa8ZsNVAGbOgyP1R7s6qS7aRFWNO6mls52evnhksxn+OkBpZSHFH8dVAE87/kMUtwPR9lab7Z2+2zQ3O6jYyTgKKK3dqATnNpzavREaG3pN8XsnaPTjQ9p1+IBiI+MoAKm1gmMZ3GYD5ucso08dFRQ7XkTfLtSZRcltZBwFYLAlAGJ4PyclU6fe5nwzOEAWUJDcTsZRAAZbAlBsvJ/THVkpgg9faRRjF5eWKLYWUwpAulHJlpP19TXUUJ1LRmGm4gS0bMkTwXujxTT2/c9YbGNu7yoA9D15IJxcO1ZjOh9oK6LiUJbNbmtVrgj++GABra3fJMZhEtyvZwHY65ajvqunRBBZREVFtmh/e6SQFq3IsBUvJsH9ehaALWU5Am37qm0isCT4tf5nl2SaZ4U8BpPgfj0LQB3IbzikM9oYFiJkQmVZtP9kG8WHP9P4aMy0RxG7nQuOAgAKSC5GcOtcsy34od3lZtonJJvxkRhVNmxX/HFcBQC+FODH80vmiybef0a0TfyeuQWObLeXlycBAGuLQ4gL4YzEv0xLhGcBAIcQikrenhaolbMXu2nJ6pDS7yRiWgI4yEr+hkqlHUK9ivgrAU54FeGbADCZCCyTbOOrADCZCPlwEgKSdD3MB88UEIGvIwTHd4Xch4uQKQDf53zgTIOi5W24qpkCzCwYehc38JOArt0XwfHg0pik6z3c0A8QPDE9PdUmwHr8uhlb4BYmx/sF0/EiUq73hb4AAAAASUVORK5CYII=";
const PACKAGED_TRAY_ICON_FILE = "RelayQaHub.ico";
const AUTO_START_DEFAULT_MARKER = "auto-start-default-v1";

const runtimeEnvironment = loadDesktopRuntimeEnvironment(process.env);
const runtimePaths = resolveDesktopRuntimePaths(runtimeEnvironment);
const notificationHistory = new NotificationHistory(runtimePaths.notificationHistoryFile);
const browserSession = new DesktopBrowserSessionCookieStore();
const rememberedLoginNameFile =
  runtimePaths.directory === null
    ? null
    : path.join(runtimePaths.directory, "remembered-login-name.json");
const config = parseDesktopConfig(runtimeEnvironment, {
  webAssetsDirectory: path.resolve(currentDirectory, "../../../apps/web/dist"),
});

let mainWindow: BrowserWindow | null = null;
const packagingNotices = new Set<string>();
let tray: Tray | null = null;
let transport: NotificationTransport;
let updater: PortableUpdater | null = null;
let mcpServer: QaHubMcpHttpServer | null = null;
let quitting = false;
let pendingBugId: string | null = null;
let assetsDirectory = config.webAssetsDirectory;
let uploader: UploaderHost | null = null;

function getUploader(): UploaderHost {
  const local = process.env["LOCALAPPDATA"];
  if (!local) throw new Error("LOCAL_STORAGE_FAILED");
  uploader ??= new UploaderHost({
    root: path.join(local, "OZDQP-Uploader", "qa-hub-jobs"),
    authFile: path.join(local, "OZDQP-Uploader", "auth", "fq2ivi.ipwana.com-443.json"),
    executable: app.isPackaged
      ? path.join(process.resourcesPath, "uploader", "ozdqp-uploader.exe")
      : path.join(app.getAppPath(), "vendor", "ozdqp-uploader", "ozdqp-uploader.exe"),
    runner: path.join(currentDirectory, "uploader-runner.js"),
    nodeExecutable: process.execPath,
  });
  return uploader;
}

async function loadRememberedLoginName(): Promise<void> {
  if (rememberedLoginNameFile === null) return;
  try {
    const raw = await fs.readFile(rememberedLoginNameFile, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 4_096) throw new Error("IDENTITY_FILE_TOO_LARGE");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("IDENTITY_FILE_INVALID");
    }
    const record = parsed as { readonly schemaVersion?: unknown; readonly loginName?: unknown };
    if (record.schemaVersion !== 1 || typeof record.loginName !== "string") {
      throw new Error("IDENTITY_FILE_INVALID");
    }
    browserSession.restoreLoginName(record.loginName);
    if (browserSession.rememberedLoginName() === null) throw new Error("IDENTITY_FILE_INVALID");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    process.stderr.write(
      `${JSON.stringify({
        event: "desktop.identity.load.failed",
        code: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      })}\n`,
    );
  }
}

async function persistRememberedLoginName(): Promise<void> {
  if (rememberedLoginNameFile === null) return;
  const loginName = browserSession.rememberedLoginName();
  if (loginName === null) {
    await fs.rm(rememberedLoginNameFile, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(rememberedLoginNameFile), { recursive: true });
  await fs.writeFile(
    rememberedLoginNameFile,
    `${JSON.stringify({ schemaVersion: 1, loginName })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function persistRememberedLoginNameSafely(): Promise<void> {
  try {
    await persistRememberedLoginName();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: "desktop.identity.persist.failed",
        code: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      })}\n`,
    );
  }
}

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

function notificationCredential(): string | null {
  return config.accessToken ?? browserSession.cookieHeader(null);
}

function syncNotificationCredential(): void {
  transport?.updateAccessToken(notificationCredential());
}

function sendUpdateState(state: DesktopUpdateState): void {
  if (mainWindow !== null && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("desktop:update-state", state);
  }
  rebuildTrayMenu();
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

function handleSecondInstanceArguments(args: readonly unknown[]): void {
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
  process.stdout.write(
    `${JSON.stringify({ event: "desktop.second-instance.open", argumentCount: args.length })}\n`,
  );
  openMainWindow();
}

function loadTrayImage(filePath: string): NativeImage | null {
  const image = nativeImage.createFromPath(filePath);
  return image.isEmpty() ? null : image;
}

async function trayIcon(): Promise<NativeImage> {
  const configured = process.env["QA_HUB_DESKTOP_TRAY_ICON"]?.trim();
  if (configured !== undefined && configured.length > 0) {
    const image = loadTrayImage(path.resolve(configured));
    if (image !== null) return image;
  }

  const packagedImage = loadTrayImage(
    path.join(app.getAppPath(), "assets", PACKAGED_TRAY_ICON_FILE),
  );
  if (packagedImage !== null) return packagedImage;

  try {
    const executableImage = await app.getFileIcon(process.execPath, { size: "small" });
    if (!executableImage.isEmpty()) return executableImage;
  } catch {
    // The branded PNG below keeps the tray visible if Windows cannot read the EXE icon.
  }

  return nativeImage.createFromDataURL(FALLBACK_TRAY_ICON);
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

function mcpStatusLabel(status: QaHubMcpServerStatus | null): string {
  if (!config.mcpEnabled) return "MCP：已禁用";
  if (status === null || status.state === "stopped") return "MCP：未启动";
  if (status.state === "starting") return "MCP：启动中";
  if (status.state === "failed") return `MCP：不可用（${status.lastError ?? "启动失败"}）`;
  return `MCP：127.0.0.1:${status.port}`;
}

function setAutoStartAtLogin(enabled: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, args: enabled ? ["--hidden"] : [] });
  } catch {
    // Unsupported platforms keep the menu action harmless and reversible.
  }
  rebuildTrayMenu();
}

async function ensureDefaultAutoStart(): Promise<void> {
  const marker = path.join(app.getPath("userData"), AUTO_START_DEFAULT_MARKER);
  try {
    await fs.access(marker);
    return;
  } catch {
    // The first run of this release enables the requested default once. Later
    // tray changes remain authoritative and are not overwritten on restart.
  }
  try {
    app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, "enabled\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    // Startup remains usable when Windows or the install location disallows it.
  }
}

function rebuildTrayMenu(): void {
  if (tray === null) return;
  const status = transport?.status ?? { state: "stopped", reconnectAttempt: 0, lastError: null };
  const paused = status.state === "paused";
  let autoStart = config.autoStartAtLogin;
  try {
    autoStart = app.getLoginItemSettings().openAtLogin;
  } catch {
    // Keep the configured default when the platform does not expose login settings.
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 QA Hub", click: openMainWindow },
      { label: statusLabel(status), enabled: false },
      { label: mcpStatusLabel(mcpServer?.status ?? null), enabled: false },
      ...(updater === null
        ? []
        : updater.state.status === "ready"
          ? [
              {
                label: `安装更新 ${updater.state.version}`,
                click: () => void updater?.install(),
              },
            ]
          : [
              {
                label:
                  updater.state.status === "downloading"
                    ? `正在下载更新 ${updater.state.progressPercent}%`
                    : updater.state.status === "checking"
                      ? "正在检查更新"
                      : "检查更新",
                enabled:
                  updater.state.status !== "downloading" && updater.state.status !== "checking",
                click: () => void updater?.check(),
              },
            ]),
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
      { type: "separator" },
      { label: "退出 QA Hub", click: quitApplication },
    ]),
  );
}

function showNativeNotification(notification: DesktopNotification): void {
  const change: DesktopBugChange = {
    notificationId: notification.notificationId,
    eventId: notification.eventId,
    bugId: notification.bugId,
  };
  if (mainWindow !== null && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("desktop:bug-changed", change);
  }
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
  notificationHistory.record(notification.notificationId);
}

function quitApplication(): void {
  if (quitting) return;
  quitting = true;
  transport.stop();
  void mcpServer?.stop();
  tray?.destroy();
  tray = null;
  app.quit();
}

function showUpdateReadyNotification(
  state: Extract<DesktopUpdateState, { status: "ready" }>,
): void {
  const notification = new Notification({
    title: "QA Hub 更新已就绪",
    body: `版本 ${state.version} 已下载，点击即可安装并重启。`,
    silent: false,
  });
  notification.once("click", () => void updater?.install());
  notification.show();
}

function installNavigationGuards(window: BrowserWindow): void {
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isPackageDownloadUrl(url)) void shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#192f25",
    title: "Relay QA Hub",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#192f25", symbolColor: "#e8f0e8", height: 60 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  installNavigationGuards(window);
  const sendWindowState = () => {
    window.webContents.send("desktop:window-state", {
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    });
  };
  window.on("maximize", sendWindowState);
  window.on("unmaximize", sendWindowState);
  window.on("enter-full-screen", sendWindowState);
  window.on("leave-full-screen", sendWindowState);
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.webContents.once("did-finish-load", () => {
    if (pendingBugId !== null) {
      const bugId = pendingBugId;
      pendingBugId = null;
      window.webContents.send("desktop:open-bug", { bugId });
    }
  });
  return window;
}

function installIpcHandlers(): void {
  const uploadActions: Record<string, (value: unknown) => Promise<unknown>> = {
    snapshot: () => getUploader().snapshot(),
    login: (value) => getUploader().login(value),
    "check-auth": () => getUploader().checkAuth(),
    logout: () => getUploader().logout(),
    start: (value) => getUploader().start(value),
    resume: (value) => getUploader().resume(value),
    "confirm-publish": (value) => getUploader().confirmPublish(value),
    "open-folder": async (value) => {
      const directory = getUploader().folder(value);
      await fs.access(path.join(directory, "desktop.json"));
      if (await shell.openPath(directory)) throw new Error("OPEN_FOLDER_FAILED");
      return true;
    },
  };
  for (const [action, handler] of Object.entries(uploadActions)) {
    ipcMain.handle(`desktop:uploader:${action}`, async (event, value: unknown) => {
      if (
        !isTrustedRendererUrl(event.senderFrame?.url ?? "") ||
        event.senderFrame !== event.sender.mainFrame
      )
        return { ok: false, code: "UNTRUSTED_SENDER" };
      try {
        return { ok: true, value: await handler(value) };
      } catch (error) {
        // Never transport exception details, credentials or remote responses to the renderer/logs.
        const code =
          error instanceof Error && /^[A-Z_]{3,80}$/.test(error.message)
            ? error.message
            : "UPLOADER_FAILED";
        return { ok: false, code };
      }
    });
  }
  ipcMain.handle("desktop:get-window-state", (event) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url ?? "")) return null;
    const window = BrowserWindow.fromWebContents(event.sender);
    return {
      maximized: window?.isMaximized() ?? false,
      fullScreen: window?.isFullScreen() ?? false,
    };
  });
  ipcMain.removeHandler("desktop:notify-packaging");
  ipcMain.handle("desktop:notify-packaging", (event, value: unknown) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url ?? "") || !Notification.isSupported())
      return false;
    const notice = parsePackagingNotice(value);
    if (!notice || packagingNotices.has(notice.id)) return false;
    const notification = new Notification({
      title: `OZDQP · ${notice.title}`,
      body: notice.body,
      silent: false,
    });
    notification.once("show", () => {
      process.stdout.write(
        `${JSON.stringify({ event: "desktop.packaging.notification.shown", id: notice.id, kind: notice.kind })}\n`,
      );
    });
    notification.once("failed", (_event, error: string) => {
      process.stderr.write(
        `${JSON.stringify({ event: "desktop.packaging.notification.failed", id: notice.id, error })}\n`,
      );
    });
    notification.once("click", () => {
      process.stdout.write(
        `${JSON.stringify({ event: "desktop.packaging.notification.clicked", id: notice.id })}\n`,
      );
      openMainWindow();
      mainWindow?.webContents.send("desktop:open-packaging");
    });
    notification.show();
    packagingNotices.add(notice.id);
    while (packagingNotices.size > 200)
      packagingNotices.delete(packagingNotices.values().next().value!);
    return true;
  });
  ipcMain.removeHandler("desktop:get-connection-status");
  ipcMain.removeHandler("desktop:get-runtime-info");
  ipcMain.removeHandler("desktop:get-notifications-paused");
  ipcMain.removeHandler("desktop:get-update-state");
  ipcMain.removeHandler("desktop:check-update");
  ipcMain.removeHandler("desktop:install-update");
  ipcMain.handle("desktop:get-connection-status", (event) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url ?? "")) {
      return { state: "stopped", reconnectAttempt: 0, lastError: "UNTRUSTED_SENDER" };
    }
    return transport.status;
  });
  ipcMain.handle("desktop:get-runtime-info", (event) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url ?? "")) {
      return { apiBaseUrl: "", notificationsEnabled: false };
    }
    return {
      apiBaseUrl: config.apiBaseUrl.origin,
      notificationsEnabled: notificationCredential() !== null,
      version: app.getVersion(),
      mcp: {
        state: config.mcpEnabled ? (mcpServer?.status.state ?? "stopped") : "disabled",
        port: config.mcpPort,
        url: `http://127.0.0.1:${config.mcpPort}/mcp`,
        lastError: mcpServer?.status.lastError ?? null,
      },
    };
  });
  ipcMain.handle("desktop:get-notifications-paused", (event) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url ?? "")) return false;
    return transport.status.state === "paused";
  });
  ipcMain.handle("desktop:get-update-state", (event) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url ?? "")) {
      return { status: "disabled", message: "UNTRUSTED_SENDER" };
    }
    return updater?.state ?? { status: "disabled", message: "UPDATE_NOT_INITIALIZED" };
  });
  ipcMain.handle("desktop:check-update", async (event) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url ?? "")) return false;
    await updater?.check();
    return updater !== null;
  });
  ipcMain.handle("desktop:install-update", async (event) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url ?? "")) return false;
    return (await updater?.install()) ?? false;
  });
}

async function createUpdater(): Promise<PortableUpdater> {
  const notifiedReleases = new Set<string>();
  const updateManifestUrl = new URL(
    "/downloads/Relay-QA-Hub-Windows-x64-latest.json",
    config.csrfOrigin,
  );
  const instance = new PortableUpdater({
    currentReleaseFile: path.join(app.getAppPath(), "release.json"),
    updatesDirectory: path.join(app.getPath("userData"), "updates"),
    userDataDirectory: app.getPath("userData"),
    installDirectory: path.dirname(process.execPath),
    executableName: path.basename(process.execPath),
    manifestUrl: updateManifestUrl,
    requestQuit: quitApplication,
    onState: (state) => {
      sendUpdateState(state);
      if (state.status === "ready" && !notifiedReleases.has(state.releaseId)) {
        notifiedReleases.add(state.releaseId);
        showUpdateReadyNotification(state);
      }
    },
  });
  await instance.initialize();
  return instance;
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
      const previousLoginName = browserSession.rememberedLoginName();
      const response = await proxyRendererApiRequest(request, config, browserSession);
      if (previousLoginName !== browserSession.rememberedLoginName()) {
        await persistRememberedLoginNameSafely();
      }
      syncNotificationCredential();
      return response;
    }
    return serveAsset(request);
  });
}

function createTransport(): NotificationTransport {
  return new NotificationTransport({
    socketUrl: config.wssUrl,
    accessToken: notificationCredential(),
    openSocket: (url, credential) =>
      config.accessToken === null
        ? createBrowserSessionWssClient(url, credential)
        : createAuthenticatedWssClient(url, credential),
    fetchInbox: () => fetchDurableInbox(config, browserSession.cookieHeader(null)),
    showNotification: showNativeNotification,
    seenNotificationIds: notificationHistory.notificationIds,
    onStatus: sendConnectionStatus,
  });
}

async function startApplication(): Promise<void> {
  Menu.setApplicationMenu(null);
  if (process.platform === "win32") app.setAppUserModelId("com.relayqahub.desktop");
  await loadRememberedLoginName();
  await registerAppProtocol();
  transport = createTransport();
  updater = await createUpdater();
  if (config.mcpEnabled) {
    const mcpTools = new QaHubMcpTools(
      new DesktopQaHubApiClient(config, browserSession, fetch, () => {
        void persistRememberedLoginNameSafely();
        syncNotificationCredential();
      }),
      path.join(app.getPath("userData"), "mcp-attachments"),
    );
    mcpServer = new QaHubMcpHttpServer({
      port: config.mcpPort,
      tools: mcpTools,
      serverVersion: app.getVersion(),
      onStatus: (status) => {
        process.stdout.write(`${JSON.stringify({ event: "desktop.mcp.status", ...status })}\n`);
        rebuildTrayMenu();
      },
    });
    try {
      await mcpServer.start();
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          event: "desktop.mcp.start.failed",
          code: error instanceof Error ? error.name : "UNKNOWN_ERROR",
          status: mcpServer.status,
        })}\n`,
      );
    }
  }
  installIpcHandlers();
  await ensureDefaultAutoStart();
  tray = new Tray(await trayIcon());
  tray.setToolTip("Relay QA Hub");
  tray.on("click", openMainWindow);
  tray.on("double-click", openMainWindow);
  rebuildTrayMenu();
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
  if (!(config.startupHidden || process.argv.includes("--hidden"))) openMainWindow();
  transport.start();
  const initialUpdateTimer = setTimeout(() => void updater?.check(), 5_000);
  initialUpdateTimer.unref();
  const recurringUpdateTimer = setInterval(() => void updater?.check(), 30 * 60 * 1_000);
  recurringUpdateTimer.unref();
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
    handleSecondInstanceArguments(commandLine);
  });
  app.on("before-quit", () => {
    if (!quitting) {
      quitting = true;
      transport?.stop();
      void mcpServer?.stop();
    }
  });
  app.on("window-all-closed", () => {
    // The hidden window and notification transport intentionally keep the tray app alive.
  });
  void app
    .whenReady()
    .then(startApplication)
    .catch((error: unknown) => {
      process.stderr.write(
        `${JSON.stringify({
          event: "desktop.startup.failed",
          error: error instanceof Error ? error.name : "UNKNOWN_ERROR",
        })}\n`,
      );
      quitting = true;
      transport?.stop();
      void mcpServer?.stop();
      app.quit();
    });
}
