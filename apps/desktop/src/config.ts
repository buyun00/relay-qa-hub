import path from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export const APP_SCHEME = "qa-hub";
export const APP_HOST = "app";
export const API_PATH = "/api/";
export const NOTIFICATIONS_PATH = "/api/v1/notifications";
export const EVENTS_PATH = "/api/v1/notifications/stream";

export interface DesktopConfig {
  readonly apiBaseUrl: URL;
  readonly wssUrl: URL;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly webAssetsDirectory: string;
  readonly developmentUrl: URL | null;
  readonly accessToken: string | null;
  readonly autoStartAtLogin: boolean;
  readonly allowLoopbackHttp: boolean;
  readonly startupHidden: boolean;
}

export class DesktopConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopConfigError";
  }
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

function parseBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = envValue(env, name);
  if (value === null) return fallback;
  return TRUE_VALUES.has(value.toLowerCase());
}

function parseUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new DesktopConfigError(`${name} must be an absolute URL`);
  }
}

function validateNetworkUrl(
  value: URL,
  name: string,
  secureProtocol: "https:" | "wss:",
  allowLoopbackHttp: boolean,
): URL {
  if (value.username.length > 0 || value.password.length > 0) {
    throw new DesktopConfigError(`${name} must not contain URL credentials`);
  }
  if (value.search.length > 0 || value.hash.length > 0) {
    throw new DesktopConfigError(`${name} must not contain a query or fragment`);
  }
  if (value.protocol !== secureProtocol) {
    const loopbackProtocol = secureProtocol === "https:" ? "http:" : "ws:";
    if (!(
      allowLoopbackHttp &&
      value.protocol === loopbackProtocol &&
      LOOPBACK_HOSTS.has(value.hostname)
    )) {
      throw new DesktopConfigError(`${name} must use ${secureProtocol}`);
    }
  }
  return value;
}

function deriveWssUrl(apiBaseUrl: URL): URL {
  const protocol = apiBaseUrl.protocol === "https:" ? "wss:" : "ws:";
  return new URL(`${protocol}//${apiBaseUrl.host}${EVENTS_PATH}`);
}

function normalizeDirectory(value: string | null, fallback: string): string {
  return path.resolve(value ?? fallback);
}

export function isAllowedNetworkUrl(url: URL, config: DesktopConfig): boolean {
  return config.allowedOrigins.has(url.origin);
}

export function isAppUrl(value: string | URL): boolean {
  try {
    const url = typeof value === "string" ? new URL(value) : value;
    return url.protocol === `${APP_SCHEME}:` && url.hostname === APP_HOST;
  } catch {
    return false;
  }
}

export function parseDesktopConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaults: { readonly webAssetsDirectory?: string } = {},
): DesktopConfig {
  const allowLoopbackHttp = parseBoolean(env, "QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP", false);
  const apiRaw = envValue(env, "QA_HUB_DESKTOP_API_BASE_URL") ?? "https://qa-hub.local";
  const apiBaseUrl = validateNetworkUrl(
    parseUrl(apiRaw, "QA_HUB_DESKTOP_API_BASE_URL"),
    "QA_HUB_DESKTOP_API_BASE_URL",
    "https:",
    allowLoopbackHttp,
  );
  const wssRaw = envValue(env, "QA_HUB_DESKTOP_WSS_URL");
  const wssUrl = validateNetworkUrl(
    wssRaw === null ? deriveWssUrl(apiBaseUrl) : parseUrl(wssRaw, "QA_HUB_DESKTOP_WSS_URL"),
    "QA_HUB_DESKTOP_WSS_URL",
    "wss:",
    allowLoopbackHttp,
  );
  const developmentRaw = envValue(env, "QA_HUB_DESKTOP_DEV_URL");
  const developmentUrl =
    developmentRaw === null ? null : parseUrl(developmentRaw, "QA_HUB_DESKTOP_DEV_URL");
  if (developmentUrl !== null) {
    const allowedDevProtocol =
      developmentUrl.protocol === "https:" ||
      (allowLoopbackHttp &&
        developmentUrl.protocol === "http:" &&
        LOOPBACK_HOSTS.has(developmentUrl.hostname));
    if (!allowedDevProtocol || developmentUrl.username || developmentUrl.password) {
      throw new DesktopConfigError(
        "QA_HUB_DESKTOP_DEV_URL must be HTTPS or explicitly allowed loopback HTTP",
      );
    }
  }
  const accessToken = envValue(env, "QA_HUB_DESKTOP_ACCESS_TOKEN");
  return {
    apiBaseUrl,
    wssUrl,
    allowedOrigins: new Set([
      apiBaseUrl.origin,
      wssUrl.origin,
      ...(developmentUrl === null ? [] : [developmentUrl.origin]),
    ]),
    webAssetsDirectory: normalizeDirectory(
      envValue(env, "QA_HUB_DESKTOP_WEB_ASSETS_DIR"),
      defaults.webAssetsDirectory ?? path.resolve(process.cwd(), "apps/web/dist"),
    ),
    developmentUrl,
    accessToken,
    autoStartAtLogin:
      parseBoolean(env, "QA_HUB_DESKTOP_AUTO_START", false) ||
      parseBoolean(env, "QA_HUB_DESKTOP_AUTO_START_LOGIN", false),
    allowLoopbackHttp,
    startupHidden: parseBoolean(env, "QA_HUB_DESKTOP_START_HIDDEN", false),
  };
}

export function appUrl(pathname = "/index.html", hash = ""): string {
  const url = new URL(
    `${APP_SCHEME}://${APP_HOST}${pathname.startsWith("/") ? pathname : `/${pathname}`}`,
  );
  url.hash = hash;
  return url.toString();
}
