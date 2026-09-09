import path from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export const APP_SCHEME = "qa-hub-preview";
export const APP_HOST = "app";
export const API_PATH = "/api/";
export const NOTIFICATIONS_PATH = "/api/v1/notifications";
export const EVENTS_PATH = "/api/v1/notifications/stream";
const APP_SCHEME_PATTERN = /^qa-hub-preview(?:-[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9]))?$/u;
const BUG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface DesktopConfig {
  readonly appScheme: string;
  readonly apiBaseUrl: URL;
  readonly wssUrl: URL;
  readonly csrfOrigin: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly webAssetsDirectory: string;
  readonly developmentUrl: URL | null;
  readonly accessToken: string | null;
  readonly autoStartAtLogin: boolean;
  readonly allowLoopbackHttp: boolean;
  readonly allowPrivateLanHttp: boolean;
  readonly startupHidden: boolean;
  readonly mcpEnabled: boolean;
  readonly mcpPort: number;
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

function parsePort(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = envValue(env, name);
  if (value === null) return fallback;
  if (!/^\d+$/u.test(value)) {
    throw new DesktopConfigError(`${name} must be an integer from 1 through 65535`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new DesktopConfigError(`${name} must be an integer from 1 through 65535`);
  }
  return port;
}

function parseUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new DesktopConfigError(`${name} must be an absolute URL`);
  }
}

export function isPrivateLanIpv4(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/u.test(octet))) {
    return false;
  }
  const values = octets.map(Number);
  if (values.some((octet) => octet < 0 || octet > 255)) return false;
  return (
    values[0] === 10 ||
    (values[0] === 172 && values[1] !== undefined && values[1] >= 16 && values[1] <= 31) ||
    (values[0] === 192 && values[1] === 168)
  );
}

function validateNetworkUrl(
  value: URL,
  name: string,
  secureProtocol: "https:" | "wss:",
  allowLoopbackHttp: boolean,
  allowPrivateLanHttp: boolean,
): URL {
  if (value.username.length > 0 || value.password.length > 0) {
    throw new DesktopConfigError(`${name} must not contain URL credentials`);
  }
  if (value.search.length > 0 || value.hash.length > 0) {
    throw new DesktopConfigError(`${name} must not contain a query or fragment`);
  }
  if (value.protocol !== secureProtocol) {
    const insecureProtocol = secureProtocol === "https:" ? "http:" : "ws:";
    const explicitlyAllowedHost =
      (allowLoopbackHttp && LOOPBACK_HOSTS.has(value.hostname)) ||
      (allowPrivateLanHttp && isPrivateLanIpv4(value.hostname));
    if (!(value.protocol === insecureProtocol && explicitlyAllowedHost)) {
      throw new DesktopConfigError(
        `${name} must use ${secureProtocol} unless insecure transport is explicitly limited to loopback or RFC1918 IPv4`,
      );
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

function parseCsrfOrigin(
  value: string,
  allowLoopbackHttp: boolean,
  allowPrivateLanHttp: boolean,
): string {
  const url = validateNetworkUrl(
    parseUrl(value, "QA_HUB_DESKTOP_CSRF_ORIGIN"),
    "QA_HUB_DESKTOP_CSRF_ORIGIN",
    "https:",
    allowLoopbackHttp,
    allowPrivateLanHttp,
  );
  if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
    throw new DesktopConfigError("QA_HUB_DESKTOP_CSRF_ORIGIN must be an origin without a path");
  }
  return url.origin;
}

export function isAllowedNetworkUrl(url: URL, config: DesktopConfig): boolean {
  return config.allowedOrigins.has(url.origin);
}

export function isAppUrl(value: string | URL, appScheme = APP_SCHEME): boolean {
  try {
    const url = typeof value === "string" ? new URL(value) : value;
    return url.protocol === `${appScheme}:` && url.hostname === APP_HOST;
  } catch {
    return false;
  }
}

export function parseBugDeepLink(value: string, appScheme = APP_SCHEME): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== `${appScheme}:` || url.hostname !== "bug") return null;
    const bugId = url.pathname.replace(/^\//u, "");
    return BUG_ID_PATTERN.test(bugId) ? bugId.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function parseDesktopConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaults: { readonly webAssetsDirectory?: string } = {},
): DesktopConfig {
  const appScheme = envValue(env, "QA_HUB_DESKTOP_APP_SCHEME") ?? APP_SCHEME;
  if (!APP_SCHEME_PATTERN.test(appScheme) || appScheme.includes("--")) {
    throw new DesktopConfigError(
      "QA_HUB_DESKTOP_APP_SCHEME must be qa-hub-preview or a lowercase instance-specific qa-hub-preview-* scheme",
    );
  }
  const configuredApiBaseUrl = envValue(env, "QA_HUB_DESKTOP_API_BASE_URL");
  if (configuredApiBaseUrl === null)
    throw new DesktopConfigError("QA_HUB_DESKTOP_API_BASE_URL must be explicitly configured");
  const allowLoopbackHttp = parseBoolean(env, "QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP", false);
  const allowPrivateLanHttp = parseBoolean(env, "QA_HUB_DESKTOP_ALLOW_PRIVATE_LAN_HTTP", false);
  const apiRaw = configuredApiBaseUrl;
  const apiBaseUrl = validateNetworkUrl(
    parseUrl(apiRaw, "QA_HUB_DESKTOP_API_BASE_URL"),
    "QA_HUB_DESKTOP_API_BASE_URL",
    "https:",
    allowLoopbackHttp,
    allowPrivateLanHttp,
  );
  const wssRaw = envValue(env, "QA_HUB_DESKTOP_WSS_URL");
  const wssUrl = validateNetworkUrl(
    wssRaw === null ? deriveWssUrl(apiBaseUrl) : parseUrl(wssRaw, "QA_HUB_DESKTOP_WSS_URL"),
    "QA_HUB_DESKTOP_WSS_URL",
    "wss:",
    allowLoopbackHttp,
    allowPrivateLanHttp,
  );
  const developmentRaw = envValue(env, "QA_HUB_DESKTOP_DEV_URL");
  const developmentUrl =
    developmentRaw === null ? null : parseUrl(developmentRaw, "QA_HUB_DESKTOP_DEV_URL");
  if (developmentUrl !== null) {
    const allowedDevProtocol =
      developmentUrl.protocol === "https:" ||
      (developmentUrl.protocol === "http:" &&
        ((allowLoopbackHttp && LOOPBACK_HOSTS.has(developmentUrl.hostname)) ||
          (allowPrivateLanHttp && isPrivateLanIpv4(developmentUrl.hostname))));
    if (!allowedDevProtocol || developmentUrl.username || developmentUrl.password) {
      throw new DesktopConfigError(
        "QA_HUB_DESKTOP_DEV_URL must be HTTPS or explicitly allowed loopback/private LAN HTTP",
      );
    }
  }
  const accessToken = envValue(env, "QA_HUB_DESKTOP_ACCESS_TOKEN");
  return {
    appScheme,
    apiBaseUrl,
    wssUrl,
    csrfOrigin: parseCsrfOrigin(
      envValue(env, "QA_HUB_DESKTOP_CSRF_ORIGIN") ?? apiBaseUrl.origin,
      allowLoopbackHttp,
      allowPrivateLanHttp,
    ),
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
    allowPrivateLanHttp,
    startupHidden: parseBoolean(env, "QA_HUB_DESKTOP_START_HIDDEN", false),
    mcpEnabled: parseBoolean(env, "QA_HUB_DESKTOP_MCP_ENABLED", true),
    mcpPort: parsePort(env, "QA_HUB_DESKTOP_MCP_PORT", 4_420),
  };
}

export function appUrl(pathname = "/index.html", hash = "", appScheme = APP_SCHEME): string {
  const url = new URL(
    `${appScheme}://${APP_HOST}${pathname.startsWith("/") ? pathname : `/${pathname}`}`,
  );
  url.hash = hash;
  return url.toString();
}
