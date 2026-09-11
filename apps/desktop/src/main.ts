import { promises as fs, mkdirSync } from "node:fs";
import { applyWindowAction } from "./window-actions.js";
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
import { isCompatibilityReportUrl, isPackageDownloadUrl } from "./package-downloads.js";
import { parsePackagingNotice } from "./packaging-notifications.js";
import type { DesktopBugChange, DesktopConnectionStatus } from "./bridge-types.js";
import { NotificationHistory } from "./notification-history.js";
import {
  boundedNotificationFailure,
  buildUpdateNotificationId,
  buildWindowsUpdateNotificationToastXml,
  buildWindowsNotificationToastXml,
  notificationRouteMatchesScope,
  PendingNotificationActivationQueue,
  MAX_PENDING_UPDATE_ACTIVATIONS,
  NotificationActivationGuard,
  parseWindowsNotificationActivation,
  parseWindowsUpdateNotificationActivation,
  shouldRetainClosedScopedNotification,
  UpdateActivationGuard,
} from "./notification-activation.js";
import {
  MAX_PENDING_NOTIFICATIONS,
  NotificationTransport,
  type DesktopNotification,
  type TransportStatus,
} from "./notification-transport.js";
import {
  bootstrapBearerNotificationScope,
  exactNotificationScope,
  notificationScopeMissingReason,
} from "./notification-scope.js";
import {
  DesktopBrowserSessionCookieStore,
  fetchDurableInbox,
  proxyRendererApiRequest,
} from "./network.js";
import { DesktopQaHubApiClient, QaHubMcpError, QaHubMcpTools } from "./mcp-api.js";
import { QaHubMcpHttpServer, type QaHubMcpServerStatus } from "./mcp-server.js";
import { resolveDesktopRuntimePaths } from "./runtime-config.js";
import { loadPreviewDesktopIdentity } from "./preview-config.js";
import {
  RememberedIdentityStore,
  persistRendererAuthenticationResponse,
} from "./remembered-identity.js";
import { createAuthenticatedWssClient, createBrowserSessionWssClient } from "./wss-client.js";
import { PortableUpdater, type DesktopUpdateState } from "./portable-updater.js";
import { acknowledgeUpdateRelaunch } from "./update-relaunch.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const FALLBACK_TRAY_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAMYSURBVFhHzZdrSBVBFMf92De7SmCf8lP1JfqS2O6mV9EsNB8INwQNboQZhhaE9tYLEdotKiG0h5VIJIFBVGRED+lBaVT0gF7QA8u8lN180ccT/6WdZs/o7kputPDjcmfOnPOfM2d2dhIS/rdnXjA4K9kwsgKGFplp4DcxGJzNY4onYGjbArr2M8nQyVd0vQkT5cEjiqGPBAzttAg+J5iW8k9mzkjWtIWmgGRNK+Gdk5GzLkx7Wlvo8s0eev/hJQ0OvqPrd2+YbeEd9Yq9O0s3e0p/at5y6jjfReMjQ45AzIJVBcr4qUBcVwEZa8rp1ZtnSrCpQFa8ZsNVAGbOgyP1R7s6qS7aRFWNO6mls52evnhksxn+OkBpZSHFH8dVAE87/kMUtwPR9lab7Z2+2zQ3O6jYyTgKKK3dqATnNpzavREaG3pN8XsnaPTjQ9p1+IBiI+MoAKm1gmMZ3GYD5ucso08dFRQ7XkTfLtSZRcltZBwFYLAlAGJ4PyclU6fe5nwzOEAWUJDcTsZRAAZbAlBsvJ/THVkpgg9faRRjF5eWKLYWUwpAulHJlpP19TXUUJ1LRmGm4gS0bMkTwXujxTT2/c9YbGNu7yoA9D15IJxcO1ZjOh9oK6LiUJbNbmtVrgj++GABra3fJMZhEtyvZwHY65ajvqunRBBZREVFtmh/e6SQFq3IsBUvJsH9ehaALWU5Am37qm0isCT4tf5nl2SaZ4U8BpPgfj0LQB3IbzikM9oYFiJkQmVZtP9kG8WHP9P4aMy0RxG7nQuOAgAKSC5GcOtcsy34od3lZtonJJvxkRhVNmxX/HFcBQC+FODH80vmiybef0a0TfyeuQWObLeXlycBAGuLQ4gL4YzEv0xLhGcBAIcQikrenhaolbMXu2nJ6pDS7yRiWgI4yEr+hkqlHUK9ivgrAU54FeGbADCZCCyTbOOrADCZCPlwEgKSdD3MB88UEIGvIwTHd4Xch4uQKQDf53zgTIOi5W24qpkCzCwYehc38JOArt0XwfHg0pik6z3c0A8QPDE9PdUmwHr8uhlb4BYmx/sF0/EiUq73hb4AAAAASUVORK5CYII=";
const PACKAGED_TRAY_ICON_FILE = "RelayQaHub.ico";
const AUTO_START_DEFAULT_MARKER = "auto-start-default-v1";
const MAX_ACTIVE_NATIVE_NOTIFICATIONS = MAX_PENDING_NOTIFICATIONS;
const NATIVE_NOTIFICATION_EVENT_TIMEOUT_MS = 15_000;
const NATIVE_NOTIFICATION_REFERENCE_LIFETIME_MS = 5 * 60_000;

const previewIdentity = loadPreviewDesktopIdentity(process.env);
const runtimeEnvironment = previewIdentity.environment;
app.setName("QA Hub Preview");
if (process.platform === "win32") {
  app.setAppUserModelId(previewIdentity.appUserModelId);
  app.setToastActivatorCLSID(previewIdentity.toastActivatorClsid);
}
mkdirSync(previewIdentity.profileDirectory, { recursive: true });
app.setPath("userData", previewIdentity.profileDirectory);
const runtimePaths = resolveDesktopRuntimePaths(runtimeEnvironment);
const notificationHistory = new NotificationHistory(runtimePaths.notificationHistoryFile);
const browserSession = new DesktopBrowserSessionCookieStore(previewIdentity.cookieName);
const rememberedLoginNameFile =
  runtimePaths.directory === null
    ? null
    : path.join(runtimePaths.directory, "remembered-login-name.json");
const config = parseDesktopConfig(runtimeEnvironment, {
  webAssetsDirectory: path.resolve(currentDirectory, "../../../apps/web/dist"),
});
const rememberedIdentity = new RememberedIdentityStore(
  rememberedLoginNameFile,
  config.apiBaseUrl.origin,
  browserSession,
);

let mainWindow: BrowserWindow | null = null;
const packagingNotices = new Set<string>();
type NativeNotificationReleaseReason =
  | "capacity"
  | "clicked"
  | "closed"
  | "expired"
  | "failed"
  | "replaced"
  | "scope-changed"
  | "timeout";

type NativeNotificationKind = "bug" | "packaging" | "update";

interface ActiveNativeNotification {
  readonly kind: NativeNotificationKind;
  readonly notification: Notification;
  readonly onRelease: (reason: NativeNotificationReleaseReason) => void;
  readonly lifetimeTimer: ReturnType<typeof setTimeout>;
}

const activeNativeNotifications = new Map<string, ActiveNativeNotification>();
const retainedScopedNotifications = new Map<string, Notification>();
const notificationActivationGuard = new NotificationActivationGuard();
const pendingNotificationActivations = new PendingNotificationActivationQueue();
const updateActivationGuard = new UpdateActivationGuard();
const updateReadyNotificationGuard = new UpdateActivationGuard();
const pendingUpdateActivations = new Set<string>();
let updateActivationDrain: Promise<void> | null = null;
let notificationIdentityReady = false;
let tray: Tray | null = null;
let transport: NotificationTransport;
let updater: PortableUpdater | null = null;
let mcpServer: QaHubMcpHttpServer | null = null;
let apiClient: DesktopQaHubApiClient | null = null;
let quitting = false;
const bugRouteDelivery = new RendererDeliveryGate<DesktopBugRoute>();
let assetsDirectory = config.webAssetsDirectory;
async function loadRememberedLoginName(): Promise<void> {
  try {
    await rememberedIdentity.load();
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

function persistRememberedLoginName(): Promise<void> {
  return rememberedIdentity.persist();
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
  if (isAppUrl(value, config.appScheme)) return true;
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

function currentNotificationScope() {
  return exactNotificationScope(
    browserSession.rememberedProjectId(),
    browserSession.rememberedUserId(),
    browserSession.rememberedIdentity(),
  );
}

function scopedNotificationCredential(): string | null {
  return currentNotificationScope() === null ? null : notificationCredential();
}

function syncNotificationActivationReadiness(): void {
  if (currentNotificationScope() === null) {
    notificationIdentityReady = false;
    return;
  }
  drainPendingNotificationActivations();
}

function syncNotificationCredential(): void {
  const nextScope = browserSession.snapshot();
  if (notificationScope !== nextScope && transport !== undefined) {
    transport.stop();
    closeScopedNotificationsForScopeChange();
    transport = createTransport();
    transport.start();
  } else transport?.updateAccessToken(scopedNotificationCredential());
  syncNotificationActivationReadiness();
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

function deliverPendingBugRoute(): void {
  bugRouteDelivery.tryDeliver((route) => {
    if (mainWindow === null || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
      return false;
    }
    try {
      mainWindow.webContents.send("desktop:open-bug", route);
      process.stdout.write(`${JSON.stringify({ event: "desktop.bug-route.sent", ...route })}\n`);
      return true;
    } catch {
      return false;
    }
  });
}

function routeToBug(route: DesktopBugRoute): void {
  const normalized = bugRoutes.parseDesktopBugRoute(route);
  if (normalized === null) return;
  bugRouteDelivery.enqueue(normalized);
  openMainWindow();
  deliverPendingBugRoute();
}

function activateNativeNotification(
  notificationId: string,
  source: "global" | "instance",
  fallbackRoute?: NotificationHistoryRoute,
  eventId: string | null = null,
): void {
  const route = notificationHistory.routeFor(notificationId) ?? fallbackRoute ?? null;
  if (route === null) {
    process.stderr.write(
      `${JSON.stringify({
        event: "desktop.notification.activation.ignored",
        notificationId,
        source,
        reason: "NOTIFICATION_ROUTE_UNKNOWN",
      })}\n`,
    );
    return;
  }
  if (
    !notificationRouteMatchesScope(route, {
      projectId: browserSession.rememberedProjectId(),
      userId: browserSession.rememberedUserId(),
    })
  ) {
    releaseActiveNativeNotification(notificationId, "scope-changed");
    releaseRetainedScopedNotification(notificationId, true);
    process.stderr.write(
      `${JSON.stringify({
        event: "desktop.notification.activation.ignored",
        notificationId,
        source,
        reason: "NOTIFICATION_SCOPE_MISMATCH",
      })}\n`,
    );
    return;
  }
  if (!notificationActivationGuard.claim(notificationId)) return;
  if (!notificationHistory.acknowledge(notificationId, route)) {
    process.stderr.write(
      `${JSON.stringify({
        event: "desktop.notification.history.persistence.failed",
        notificationId,
        stage: "activation-acknowledgement",
      })}\n`,
    );
  }
  transport?.acknowledge(notificationId);
  releaseActiveNativeNotification(notificationId, "clicked");
  releaseRetainedScopedNotification(notificationId, false);
  process.stdout.write(
    `${JSON.stringify({
      event: "desktop.notification.clicked",
      notificationId,
      eventId,
      projectId: route.projectId,
      userId: route.userId,
      bugId: route.bugId,
      source,
    })}\n`,
  );
  if (route.bugId !== null) {
    routeToBug({ projectId: route.projectId, userId: route.userId, bugId: route.bugId });
  } else {
    openMainWindow();
  }
}

function queueOrActivateGlobalNotification(notificationId: string): void {
  if (notificationIdentityReady && currentNotificationScope() !== null) {
    activateNativeNotification(notificationId, "global");
    return;
  }
  notificationIdentityReady = false;
  const queued = pendingNotificationActivations.enqueue(notificationId);
  if (queued.evicted === null) return;
  process.stderr.write(
    `${JSON.stringify({
      event: "desktop.notification.activation.ignored",
      notificationId: queued.evicted,
      source: "global",
      reason: "PENDING_ACTIVATION_CAPACITY",
    })}\n`,
  );
}

function drainPendingNotificationActivations(): void {
  if (currentNotificationScope() === null) {
    notificationIdentityReady = false;
    return;
  }
  notificationIdentityReady = true;
  for (const notificationId of pendingNotificationActivations.drain()) {
    activateNativeNotification(notificationId, "global");
  }
}

function releaseActiveNativeNotification(
  notificationId: string,
  reason: NativeNotificationReleaseReason,
  expected?: Notification,
): boolean {
  const active = activeNativeNotifications.get(notificationId);
  if (active === undefined || (expected !== undefined && active.notification !== expected)) {
    return false;
  }
  activeNativeNotifications.delete(notificationId);
  clearTimeout(active.lifetimeTimer);
  active.onRelease(reason);
  if (active.kind !== "bug") transport?.requestReconcile();
  return true;
}

function nativeNotificationReferenceCount(): number {
  return activeNativeNotifications.size + retainedScopedNotifications.size;
}

function canRetainNativeNotification(notificationId: string): boolean {
  const alreadyHeld =
    activeNativeNotifications.has(notificationId) ||
    retainedScopedNotifications.has(notificationId);
  return alreadyHeld || nativeNotificationReferenceCount() < MAX_ACTIVE_NATIVE_NOTIFICATIONS;
}

function maxPendingBugNotifications(): number {
  let nonBugActive = 0;
  for (const active of activeNativeNotifications.values()) {
    if (active.kind !== "bug") nonBugActive += 1;
  }
  return Math.max(
    0,
    MAX_ACTIVE_NATIVE_NOTIFICATIONS - nonBugActive - retainedScopedNotifications.size,
  );
}

function retainActiveNativeNotification(
  notificationId: string,
  notification: Notification,
  kind: NativeNotificationKind,
  onRelease: (reason: NativeNotificationReleaseReason) => void,
): boolean {
  if (!canRetainNativeNotification(notificationId)) return false;
  releaseActiveNativeNotification(notificationId, "replaced");
  if (kind !== "update") releaseRetainedScopedNotification(notificationId, true);
  if (nativeNotificationReferenceCount() >= MAX_ACTIVE_NATIVE_NOTIFICATIONS) return false;
  const lifetimeTimer = setTimeout(() => {
    releaseActiveNativeNotification(notificationId, "expired", notification);
  }, NATIVE_NOTIFICATION_REFERENCE_LIFETIME_MS);
  lifetimeTimer.unref();
  activeNativeNotifications.set(notificationId, { kind, notification, onRelease, lifetimeTimer });
  return true;
}

function releaseRetainedScopedNotification(
  notificationId: string,
  close: boolean,
  expected?: Notification,
): boolean {
  const notification = retainedScopedNotifications.get(notificationId);
  if (notification === undefined || (expected !== undefined && notification !== expected)) {
    return false;
  }
  retainedScopedNotifications.delete(notificationId);
  if (close) {
    try {
      notification.close();
    } catch {
      // Scope validation remains authoritative even if the platform cannot dismiss the toast.
    }
  }
  transport?.requestReconcile();
  return true;
}

function retainExpiredScopedNotification(
  notificationId: string,
  notification: Notification,
): boolean {
  releaseRetainedScopedNotification(notificationId, true);
  if (nativeNotificationReferenceCount() >= MAX_ACTIVE_NATIVE_NOTIFICATIONS) {
    try {
      notification.close();
    } catch {
      // The shared reference budget remains fail closed even if dismissal fails.
    }
    return false;
  }
  retainedScopedNotifications.set(notificationId, notification);
  return true;
}

function closeScopedNotificationsForScopeChange(): void {
  for (const [notificationId, active] of [...activeNativeNotifications]) {
    if (active.kind !== "update") {
      releaseActiveNativeNotification(notificationId, "scope-changed", active.notification);
    }
  }
  for (const notificationId of [...retainedScopedNotifications.keys()]) {
    releaseRetainedScopedNotification(notificationId, true);
  }
}

function handleSecondInstanceArguments(args: readonly unknown[]): void {
  for (const value of args) {
    if (typeof value !== "string") continue;
    const bugId = parseBugDeepLink(value, config.appScheme);
    if (bugId !== null) {
      process.stdout.write(
        `${JSON.stringify({ event: "desktop.second-instance.deep-link", bugId })}\n`,
      );
      routeToBug({ projectId: null, userId: null, bugId });
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
  if (!config.autoStartAtLogin) return;
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

function reportNativeNotificationFailure(
  notification: DesktopNotification,
  error: unknown,
  fallback: string,
): void {
  process.stderr.write(
    `${JSON.stringify({
      event: "desktop.notification.failed",
      notificationId: notification.notificationId,
      eventId: notification.eventId,
      projectId: notification.projectId,
      userId: notification.userId,
      bugId: notification.bugId,
      error: boundedNotificationFailure(error, fallback),
    })}\n`,
  );
}

function showNativeNotification(
  notification: DesktopNotification,
  routeWasPersisted = false,
): Promise<boolean> {
  const change: DesktopBugChange = {
    notificationId: notification.notificationId,
    eventId: notification.eventId,
    projectId: notification.projectId,
    userId: notification.userId,
    bugId: notification.bugId,
  };
  if (mainWindow !== null && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("desktop:bug-changed", change);
  }
  if (!Notification.isSupported()) {
    reportNativeNotificationFailure(
      notification,
      "NOTIFICATION_UNSUPPORTED",
      "NOTIFICATION_UNSUPPORTED",
    );
    return Promise.resolve(false);
  }
  if (!canRetainNativeNotification(notification.notificationId)) {
    reportNativeNotificationFailure(
      notification,
      "NOTIFICATION_REFERENCE_CAPACITY",
      "NOTIFICATION_REFERENCE_CAPACITY",
    );
    return Promise.resolve(false);
  }
  const title = `QA Hub · ${notification.title}`;
  const route: NotificationHistoryRoute = {
    projectId: notification.projectId,
    userId: notification.userId,
    bugId: notification.bugId,
  };
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let shown = false;
    let ignoreLateEvents = false;
    let eventTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (shown: boolean): void => {
      if (settled) return;
      settled = true;
      if (eventTimer !== null) clearTimeout(eventTimer);
      resolve(shown);
    };
    let nativeNotification: Notification;
    try {
      nativeNotification = new Notification({
        id: notification.notificationId,
        title,
        body: notification.body,
        silent: false,
        ...(process.platform === "win32"
          ? {
              toastXml: buildWindowsNotificationToastXml({
                notificationId: notification.notificationId,
                title,
                body: notification.body,
              }),
            }
          : {}),
      });
    } catch (error) {
      reportNativeNotificationFailure(notification, error, "NOTIFICATION_CREATE_FAILED");
      finish(false);
      return;
    }
    // Persist the cold-activation route before Windows can accept or activate
    // the toast. Presentation remains unacknowledged until an actual click.
    if (
      !routeWasPersisted &&
      !notificationHistory.recordRoute(notification.notificationId, route)
    ) {
      process.stderr.write(
        `${JSON.stringify({
          event: "desktop.notification.history.persistence.failed",
          notificationId: notification.notificationId,
          stage: "activation-route",
        })}\n`,
      );
      finish(false);
      return;
    }
    if (
      !retainActiveNativeNotification(
        notification.notificationId,
        nativeNotification,
        "bug",
        (reason) => {
          if (reason === "clicked") {
            ignoreLateEvents = true;
            finish(true);
            return;
          }
          if (
            reason !== "capacity" &&
            reason !== "expired" &&
            reason !== "replaced" &&
            reason !== "scope-changed"
          ) {
            return;
          }
          ignoreLateEvents = true;
          if (settled) return;
          reportNativeNotificationFailure(
            notification,
            `NOTIFICATION_REFERENCE_${reason.toUpperCase()}`,
            "NOTIFICATION_REFERENCE_RELEASED",
          );
          finish(false);
          if (reason === "expired") {
            retainExpiredScopedNotification(notification.notificationId, nativeNotification);
            return;
          }
          try {
            nativeNotification.close();
          } catch {
            // The bounded reference has already been released and late events are ignored.
          }
        },
      )
    ) {
      reportNativeNotificationFailure(
        notification,
        "NOTIFICATION_REFERENCE_CAPACITY",
        "NOTIFICATION_REFERENCE_CAPACITY",
      );
      finish(false);
      return;
    }
    nativeNotification.once("show", () => {
      if (ignoreLateEvents || settled || shown) return;
      shown = true;
      if (eventTimer !== null) {
        clearTimeout(eventTimer);
        eventTimer = null;
      }
      process.stdout.write(
        `${JSON.stringify({
          event: "desktop.notification.shown",
          notificationId: notification.notificationId,
          eventId: notification.eventId,
          projectId: notification.projectId,
          userId: notification.userId,
          bugId: notification.bugId,
        })}\n`,
      );
    });
    nativeNotification.once("failed", (_event, error: string) => {
      if (ignoreLateEvents) return;
      const deliveryWasPending = !settled;
      ignoreLateEvents = true;
      releaseActiveNativeNotification(notification.notificationId, "failed", nativeNotification);
      if (!deliveryWasPending) return;
      reportNativeNotificationFailure(notification, error, "NOTIFICATION_SHOW_FAILED");
      finish(false);
    });
    nativeNotification.once("close", (details) => {
      if (ignoreLateEvents) return;
      const deliveryWasPending = !settled;
      ignoreLateEvents = true;
      const released = releaseActiveNativeNotification(
        notification.notificationId,
        "closed",
        nativeNotification,
      );
      if (deliveryWasPending) finish(false);
      // Windows may emit close for a system timeout while the toast remains in
      // Action Center. Keep a bounded reference so a later scope change can
      // remove every Bug toast without treating close as a user click.
      if (released && shouldRetainClosedScopedNotification(process.platform, details.reason)) {
        retainExpiredScopedNotification(notification.notificationId, nativeNotification);
      }
    });
    if (process.platform !== "win32") {
      nativeNotification.once("click", () => {
        if (ignoreLateEvents) return;
        activateNativeNotification(
          notification.notificationId,
          "instance",
          route,
          notification.eventId,
        );
      });
    }
    eventTimer = setTimeout(() => {
      if (settled || shown) return;
      ignoreLateEvents = true;
      reportNativeNotificationFailure(
        notification,
        "NOTIFICATION_PLATFORM_EVENT_TIMEOUT",
        "NOTIFICATION_PLATFORM_EVENT_TIMEOUT",
      );
      finish(false);
      releaseActiveNativeNotification(notification.notificationId, "timeout", nativeNotification);
      try {
        nativeNotification.close();
      } catch {
        // No presenter may exist; settling the transport must still succeed.
      }
    }, NATIVE_NOTIFICATION_EVENT_TIMEOUT_MS);
    eventTimer.unref();
    try {
      nativeNotification.show();
    } catch (error) {
      if (settled) return;
      ignoreLateEvents = true;
      releaseActiveNativeNotification(notification.notificationId, "failed", nativeNotification);
      reportNativeNotificationFailure(notification, error, "NOTIFICATION_SHOW_FAILED");
      finish(false);
    }
  });
}

function quitApplication(): void {
  if (quitting) return;
  quitting = true;
  transport.stop();
  closeScopedNotificationsForScopeChange();
  void mcpServer?.stop();
  tray?.destroy();
  tray = null;
  app.quit();
}

function showUpdateReadyNotification(
  state: Extract<DesktopUpdateState, { status: "ready" }>,
): void {
  if (!Notification.isSupported()) {
    updateReadyNotificationGuard.release(state.releaseId);
    return;
  }
  const notificationId = buildUpdateNotificationId(state.releaseId);
  if (!canRetainNativeNotification(notificationId)) {
    updateReadyNotificationGuard.release(state.releaseId);
    return;
  }
  const title = "QA Hub 更新已就绪";
  const body = `版本 ${state.version} 已下载，点击即可安装并重启。`;
  let notification: Notification;
  try {
    notification = new Notification({
      id: notificationId,
      title,
      body,
      silent: false,
      ...(process.platform === "win32"
        ? {
            toastXml: buildWindowsUpdateNotificationToastXml({
              releaseId: state.releaseId,
              title,
              body,
            }),
          }
        : {}),
    });
  } catch {
    updateReadyNotificationGuard.release(state.releaseId);
    return;
  }
  let shown = false;
  let ignoreLateEvents = false;
  let eventTimer: ReturnType<typeof setTimeout> | null = null;
  const clearEventTimer = (): void => {
    if (eventTimer === null) return;
    clearTimeout(eventTimer);
    eventTimer = null;
  };
  if (
    !retainActiveNativeNotification(notificationId, notification, "update", (reason) => {
      if (reason === "clicked" || reason === "expired") {
        ignoreLateEvents = true;
        clearEventTimer();
        return;
      }
      if (reason !== "capacity" && reason !== "replaced") return;
      ignoreLateEvents = true;
      clearEventTimer();
      updateReadyNotificationGuard.release(state.releaseId);
      try {
        notification.close();
      } catch {
        // Global activation remains available after the bounded live reference ends.
      }
    })
  ) {
    updateReadyNotificationGuard.release(state.releaseId);
    return;
  }
  notification.once("show", () => {
    if (ignoreLateEvents || shown) return;
    shown = true;
    clearEventTimer();
    process.stdout.write(
      `${JSON.stringify({
        event: "desktop.update.notification.shown",
        releaseId: state.releaseId,
        version: state.version,
      })}\n`,
    );
  });
  notification.once("failed", () => {
    if (ignoreLateEvents) return;
    ignoreLateEvents = true;
    clearEventTimer();
    if (releaseActiveNativeNotification(notificationId, "failed", notification)) {
      updateReadyNotificationGuard.release(state.releaseId);
    }
  });
  notification.once("close", () => {
    if (ignoreLateEvents) return;
    ignoreLateEvents = true;
    clearEventTimer();
    if (releaseActiveNativeNotification(notificationId, "closed", notification) && !shown) {
      updateReadyNotificationGuard.release(state.releaseId);
    }
  });
  if (process.platform !== "win32") {
    notification.once("click", () => queueUpdateActivation(state.releaseId, "instance"));
  }
  eventTimer = setTimeout(() => {
    if (ignoreLateEvents || shown) return;
    ignoreLateEvents = true;
    process.stderr.write(
      `${JSON.stringify({
        event: "desktop.update.notification.failed",
        releaseId: state.releaseId,
        error: "NOTIFICATION_PLATFORM_EVENT_TIMEOUT",
      })}\n`,
    );
    if (releaseActiveNativeNotification(notificationId, "timeout", notification)) {
      updateReadyNotificationGuard.release(state.releaseId);
    }
    try {
      notification.close();
    } catch {
      // The ready guard is already retryable after a missing platform event.
    }
  }, NATIVE_NOTIFICATION_EVENT_TIMEOUT_MS);
  eventTimer.unref();
  try {
    notification.show();
  } catch {
    if (ignoreLateEvents) return;
    ignoreLateEvents = true;
    clearEventTimer();
    if (releaseActiveNativeNotification(notificationId, "failed", notification)) {
      updateReadyNotificationGuard.release(state.releaseId);
    }
  }
}

type UpdateActivationSource = "global" | "instance";

function queueUpdateActivation(releaseId: string, source: UpdateActivationSource): void {
  if (!updateActivationGuard.claim(releaseId)) return;
  updateReadyNotificationGuard.claim(releaseId);
  releaseActiveNativeNotification(buildUpdateNotificationId(releaseId), "clicked");
  pendingUpdateActivations.add(releaseId);
  while (pendingUpdateActivations.size > MAX_PENDING_UPDATE_ACTIVATIONS) {
    const oldest = pendingUpdateActivations.values().next().value as string | undefined;
    if (oldest === undefined) break;
    pendingUpdateActivations.delete(oldest);
    updateActivationGuard.release(oldest);
    updateReadyNotificationGuard.release(oldest);
  }
  process.stdout.write(
    `${JSON.stringify({ event: "desktop.update.notification.clicked", releaseId, source })}\n`,
  );
  drainPendingUpdateActivations();
}

function drainPendingUpdateActivations(): void {
  if (updater === null || updateActivationDrain !== null) return;
  const activeUpdater = updater;
  updateActivationDrain = (async () => {
    while (updater === activeUpdater) {
      const releaseId = pendingUpdateActivations.values().next().value as string | undefined;
      if (releaseId === undefined) return;
      pendingUpdateActivations.delete(releaseId);
      let handoffAccepted = false;
      let error: string | null = null;
      try {
        handoffAccepted = await activeUpdater.installRelease(releaseId);
      } catch (cause) {
        error = boundedNotificationFailure(cause, "UPDATE_ACTIVATION_FAILED");
      }
      process.stdout.write(
        `${JSON.stringify({
          event: "desktop.update.notification.activation.handoff.completed",
          releaseId,
          handoffAccepted,
          error,
        })}\n`,
      );
      // The native helper has only acknowledged the handoff at this point. The
      // next process proves installation from release.json and its durable result.
      if (handoffAccepted) return;
      // A transient verification or native handoff failure must leave the same
      // signed release eligible for another explicit click and ready notice.
      updateActivationGuard.release(releaseId);
      updateReadyNotificationGuard.release(releaseId);
    }
  })().finally(() => {
    updateActivationDrain = null;
    if (updater !== null && pendingUpdateActivations.size > 0) {
      queueMicrotask(drainPendingUpdateActivations);
    }
  });
}

function installNavigationGuards(window: BrowserWindow): void {
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isPackageDownloadUrl(url) || isCompatibilityReportUrl(url))
      void shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });
}

function createWindow(): BrowserWindow {
  bugRouteDelivery.startLoading();
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#192f25",
    title: "QA Hub 项目预览",
    titleBarStyle: "hidden",
    titleBarOverlay: false,
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
  window.webContents.on("did-start-loading", () => bugRouteDelivery.startLoading());
  window.webContents.on("render-process-gone", () => bugRouteDelivery.startLoading());
  window.webContents.on("did-finish-load", () => {
    bugRouteDelivery.finishLoading();
    deliverPendingBugRoute();
  });
  return window;
}

function installIpcHandlers(): void {
  // Older rendered assets fail closed; no local execution fallback.
  for (const action of [
    "snapshot",
    "login",
    "check-auth",
    "logout",
    "start",
    "resume",
    "confirm-publish",
    "build-chains",
    "build-and-upload",
    "cancel-build-upload",
    "open-folder",
  ]) {
    ipcMain.handle(`desktop:uploader:${action}`, () => ({
      ok: false,
      code: "UPLOAD_MOVED_TO_SERVER",
    }));
  }
  ipcMain.handle("desktop:window-action", (event, action: unknown) => {
    if (
      event.senderFrame !== event.sender.mainFrame ||
      !isTrustedRendererUrl(event.senderFrame?.url ?? "")
    )
      return false;
    return applyWindowAction(BrowserWindow.fromWebContents(event.sender), action);
  });
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
    const scope = currentNotificationScope();
    if (!notice || scope === null) return false;
    let notificationId: string;
    let notification: Notification;
    try {
      notificationId = buildPackagingNotificationId(notice.id, scope);
      if (packagingNotices.has(notificationId)) return false;
      if (!canRetainNativeNotification(notificationId)) return false;
      notification = new Notification({
        id: notificationId,
        title: `OZDQP · ${notice.title}`,
        body: notice.body,
        silent: false,
      });
    } catch {
      return false;
    }
    if (
      !retainActiveNativeNotification(notificationId, notification, "packaging", (reason) => {
        if (reason === "expired") {
          retainExpiredScopedNotification(notificationId, notification);
          return;
        }
        if (reason !== "capacity" && reason !== "replaced" && reason !== "scope-changed") return;
        try {
          notification.close();
        } catch {
          // The scope gate below remains authoritative if Windows cannot dismiss the toast.
        }
      })
    ) {
      return false;
    }
    notification.once("show", () => {
      process.stdout.write(
        `${JSON.stringify({
          event: "desktop.packaging.notification.shown",
          id: notice.id,
          notificationId,
          kind: notice.kind,
          projectId: scope.projectId,
          userId: scope.userId,
        })}\n`,
      );
    });
    notification.once("failed", (_event, error: string) => {
      if (!releaseActiveNativeNotification(notificationId, "failed", notification)) return;
      process.stderr.write(
        `${JSON.stringify({
          event: "desktop.packaging.notification.failed",
          id: notice.id,
          notificationId,
          projectId: scope.projectId,
          userId: scope.userId,
          error: boundedNotificationFailure(error, "NOTIFICATION_SHOW_FAILED"),
        })}\n`,
      );
    });
    notification.once("close", (details) => {
      const released = releaseActiveNativeNotification(notificationId, "closed", notification);
      if (released && shouldRetainClosedScopedNotification(process.platform, details.reason)) {
        retainExpiredScopedNotification(notificationId, notification);
      }
    });
    notification.once("click", () => {
      const matchesCurrentScope = notificationRouteMatchesScope(scope, {
        projectId: browserSession.rememberedProjectId(),
        userId: browserSession.rememberedUserId(),
      });
      if (!matchesCurrentScope) {
        const released = releaseActiveNativeNotification(
          notificationId,
          "scope-changed",
          notification,
        );
        const retained = releaseRetainedScopedNotification(notificationId, true, notification);
        if (!released && !retained) return;
        process.stderr.write(
          `${JSON.stringify({
            event: "desktop.packaging.notification.activation.ignored",
            id: notice.id,
            notificationId,
            reason: "NOTIFICATION_SCOPE_MISMATCH",
          })}\n`,
        );
        return;
      }
      const released = releaseActiveNativeNotification(notificationId, "clicked", notification);
      const retained = releaseRetainedScopedNotification(notificationId, false, notification);
      if (!released && !retained) return;
      process.stdout.write(
        `${JSON.stringify({
          event: "desktop.packaging.notification.clicked",
          id: notice.id,
          notificationId,
          projectId: scope.projectId,
          userId: scope.userId,
        })}\n`,
      );
      openMainWindow();
      mainWindow?.webContents.send("desktop:open-packaging");
    });
    try {
      notification.show();
    } catch {
      releaseActiveNativeNotification(notificationId, "failed", notification);
      return false;
    }
    packagingNotices.add(notificationId);
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
      notificationsEnabled: scopedNotificationCredential() !== null,
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
  const updateManifestUrl = new URL(previewIdentity.updateManifestUrl);
  const instance = new PortableUpdater({
    currentReleaseFile: path.join(app.getAppPath(), "release.json"),
    updatesDirectory: path.join(app.getPath("userData"), "updates"),
    userDataDirectory: app.getPath("userData"),
    installDirectory: path.dirname(process.execPath),
    executableName: path.basename(process.execPath),
    manifestUrl: updateManifestUrl,
    publicKeyPem: previewIdentity.updatePublicKeyPem,
    requestQuit: quitApplication,
    onState: (state) => {
      sendUpdateState(state);
      if (state.status === "ready" && updateReadyNotificationGuard.claim(state.releaseId)) {
        showUpdateReadyNotification(state);
      }
    },
  });
  await instance.initialize();
  return instance;
}

async function registerAppProtocol(): Promise<void> {
  await chooseAssetsDirectory();
  protocol.handle(config.appScheme, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return responseJson({ code: "APP_URL_INVALID" }, 400);
    }
    if (url.protocol !== `${config.appScheme}:` || url.hostname !== APP_HOST) {
      return responseJson({ code: "APP_ORIGIN_NOT_ALLOWED" }, 403);
    }
    if (url.pathname.startsWith("/api/")) {
      const previousLoginName = browserSession.snapshot();
      if (
        url.pathname === "/api/v1/auth/me" &&
        request.method === "GET" &&
        browserSession.cookieHeader(null) === null &&
        browserSession.rememberedLoginName() !== null &&
        browserSession.rememberedIdentity() === "employee"
      ) {
        try {
          await apiClient?.json("/api/v1/auth/me");
        } catch {
          /* Preserve the identity and drafts; normal authentication response stays visible. */
        }
      }
      const response = await proxyRendererApiRequest(request, config, browserSession);
      const explicitAuthentication =
        request.method === "POST" &&
        ["/api/v1/auth/login", "/api/v1/auth/gm/login", "/api/v1/auth/logout"].includes(
          url.pathname,
        );
      if (response.ok && explicitAuthentication) {
        syncNotificationCredential();
        return persistRendererAuthenticationResponse(
          response,
          browserSession,
          persistRememberedLoginName,
        );
      }
      if (previousLoginName !== browserSession.snapshot()) {
        await persistRememberedLoginNameSafely();
      }
      syncNotificationCredential();
      return response;
    }
    return serveAsset(request);
  });
}

let notificationScope = "";
function createTransport(): NotificationTransport {
  const scope = browserSession.snapshot();
  notificationScope = scope;
  const rememberedProjectId = browserSession.rememberedProjectId();
  const rememberedUserId = browserSession.rememberedUserId();
  const rememberedPrincipalIdentity = browserSession.rememberedIdentity();
  const exactScope = exactNotificationScope(
    rememberedProjectId,
    rememberedUserId,
    rememberedPrincipalIdentity,
  );
  if (exactScope === null) {
    process.stderr.write(
      `${JSON.stringify({
        event: "desktop.notification.transport.disabled",
        reason: notificationScopeMissingReason(
          rememberedProjectId,
          rememberedUserId,
          rememberedPrincipalIdentity,
        ),
      })}\n`,
    );
  }
  const socketUrl = new URL(config.wssUrl);
  if (exactScope !== null) socketUrl.searchParams.set("projectId", exactScope.projectId);
  return new NotificationTransport({
    socketUrl,
    accessToken: exactScope === null ? null : scopedNotificationCredential(),
    openSocket: (url, credential) =>
      config.accessToken === null
        ? createBrowserSessionWssClient(url, credential)
        : createAuthenticatedWssClient(url, credential),
    fetchInbox: async () => {
      if (exactScope === null) throw new Error("NOTIFICATION_SCOPE_MISSING");
      const items = await fetchDurableInbox(
        config,
        browserSession.cookieHeader(null),
        exactScope.projectId,
        exactScope.userId,
      );
      if (browserSession.snapshot() !== scope) return [];
      if (!notificationHistory.prioritizeAcknowledged(items.map((item) => item.id))) {
        process.stderr.write(
          `${JSON.stringify({
            event: "desktop.notification.history.persistence.failed",
            stage: "inbox-reconciliation",
            projectId: exactScope.projectId,
          })}\n`,
        );
      }
      return items;
    },
    prepareNotifications: (notices) => {
      if (
        exactScope === null ||
        browserSession.snapshot() !== scope ||
        notices.some((notice) => !notificationRouteMatchesScope(notice, exactScope))
      ) {
        return false;
      }
      const persisted = notificationHistory.recordRoutes(
        notices.map((notice) => ({
          notificationId: notice.notificationId,
          route: {
            projectId: notice.projectId,
            userId: notice.userId,
            bugId: notice.bugId,
          },
        })),
      );
      if (!persisted) {
        process.stderr.write(
          `${JSON.stringify({
            event: "desktop.notification.history.persistence.failed",
            stage: "activation-route-batch",
            notificationIds: notices.map((notice) => notice.notificationId),
          })}\n`,
        );
      }
      return persisted;
    },
    showNotification: (notice) => {
      if (
        exactScope === null ||
        browserSession.snapshot() !== scope ||
        !notificationRouteMatchesScope(notice, exactScope)
      ) {
        return false;
      }
      return showNativeNotification(notice, true);
    },
    maxPendingNotifications: maxPendingBugNotifications,
    seenNotificationIds: notificationHistory.acknowledgedNotificationIds,
    onReconcile: (result) => {
      process.stdout.write(
        `${JSON.stringify({
          event: "desktop.notification.inbox.reconciled",
          projectId: exactScope?.projectId ?? null,
          ...result,
        })}\n`,
      );
    },
    onStatus: sendConnectionStatus,
  });
}

async function startApplication(): Promise<void> {
  Menu.setApplicationMenu(null);
  await loadRememberedLoginName();
  apiClient = new DesktopQaHubApiClient(config, browserSession, fetch, async () => {
    await persistRememberedLoginName();
    syncNotificationCredential();
  });
  if (config.accessToken !== null) {
    try {
      await bootstrapBearerNotificationScope(apiClient, browserSession, persistRememberedLoginName);
    } catch (error) {
      const code =
        error instanceof QaHubMcpError
          ? error.code
          : error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.message)
            ? error.message
            : "NOTIFICATION_SCOPE_BOOTSTRAP_FAILED";
      process.stderr.write(
        `${JSON.stringify({
          event: "desktop.notification.scope.bootstrap.failed",
          code: boundedNotificationFailure(code, "NOTIFICATION_SCOPE_BOOTSTRAP_FAILED"),
        })}\n`,
      );
    }
  }
  await registerAppProtocol();
  transport = createTransport();
  updater = await createUpdater();
  drainPendingUpdateActivations();
  if (config.mcpEnabled) {
    const mcpTools = new QaHubMcpTools(
      apiClient,
      path.join(app.getPath("userData"), "mcp-attachments"),
      { sharedApi: true, serviceOrigin: config.apiBaseUrl.origin },
    );
    try {
      await mcpTools.refreshDefinitions();
    } catch {
      process.stderr.write('{"event":"desktop.mcp.catalog.unavailable"}\n');
    }
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
  tray.setToolTip("QA Hub 项目预览");
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
      : appUrl("/index.html", "", config.appScheme);
  await mainWindow.loadURL(target);
  if (currentNotificationScope() !== null) drainPendingNotificationActivations();
  if (!(config.startupHidden || process.argv.includes("--hidden"))) openMainWindow();
  transport.start();
  try {
    await acknowledgeUpdateRelaunch({
      argv: process.argv,
      updatesDirectory: path.join(app.getPath("userData"), "updates"),
      version: app.getVersion(),
    });
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: "desktop.update.relaunch-acknowledgement.failed",
        code: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      })}\n`,
    );
  }
  const initialUpdateTimer = setTimeout(() => void updater?.check(), 5_000);
  initialUpdateTimer.unref();
  const recurringUpdateTimer = setInterval(() => void updater?.check(), 30 * 60 * 1_000);
  recurringUpdateTimer.unref();
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  if (process.platform === "win32") {
    Notification.handleActivation((details) => {
      const updateReleaseId = parseWindowsUpdateNotificationActivation(details);
      if (updateReleaseId !== null) {
        queueUpdateActivation(updateReleaseId, "global");
        return;
      }
      const notificationId = parseWindowsNotificationActivation(details);
      if (notificationId === null) {
        process.stderr.write(
          `${JSON.stringify({
            event: "desktop.notification.activation.ignored",
            type: details.type,
            reason: "ACTIVATION_ARGUMENTS_INVALID",
          })}\n`,
        );
        return;
      }
      queueOrActivateGlobalNotification(notificationId);
    });
  }
  protocol.registerSchemesAsPrivileged([
    {
      scheme: config.appScheme,
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
    closeScopedNotificationsForScopeChange();
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
      closeScopedNotificationsForScopeChange();
      void mcpServer?.stop();
      app.quit();
    });
}
