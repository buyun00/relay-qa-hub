import { readFileSync } from "node:fs";
import path from "node:path";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 4 * 1024;
const ALLOWED_CONFIG_KEYS = new Set([
  "schemaVersion",
  "apiBaseUrl",
  "wssUrl",
  "csrfOrigin",
  "accessTokenFile",
  "allowLoopbackHttp",
  "allowPrivateLanHttp",
  "autoStartAtLogin",
  "startupHidden",
  "mcpEnabled",
  "mcpPort",
]);

interface DesktopRuntimeFile {
  readonly schemaVersion: 1;
  readonly apiBaseUrl?: string;
  readonly wssUrl?: string;
  readonly csrfOrigin?: string;
  readonly accessTokenFile?: string;
  readonly allowLoopbackHttp?: boolean;
  readonly allowPrivateLanHttp?: boolean;
  readonly autoStartAtLogin?: boolean;
  readonly startupHidden?: boolean;
  readonly mcpEnabled?: boolean;
  readonly mcpPort?: number;
}

export interface DesktopRuntimePaths {
  readonly directory: string | null;
  readonly configFile: string | null;
  readonly portableConfigFile: string | null;
  readonly tokenFile: string | null;
  readonly notificationHistoryFile: string | null;
}

export class DesktopRuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopRuntimeConfigError";
  }
}

function textValue(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new DesktopRuntimeConfigError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new DesktopRuntimeConfigError(`${field} is invalid`);
  }
  return normalized;
}

function booleanValue(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new DesktopRuntimeConfigError(`${field} must be a boolean`);
  }
  return value;
}

function portValue(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new DesktopRuntimeConfigError(`${field} must be an integer from 1 through 65535`);
  }
  return value as number;
}

function parseRuntimeFile(filePath: string): DesktopRuntimeFile {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    throw new DesktopRuntimeConfigError("desktop runtime config could not be read");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
    throw new DesktopRuntimeConfigError("desktop runtime config is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new DesktopRuntimeConfigError("desktop runtime config is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DesktopRuntimeConfigError("desktop runtime config must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (!Object.keys(record).every((key) => ALLOWED_CONFIG_KEYS.has(key))) {
    throw new DesktopRuntimeConfigError("desktop runtime config contains unsupported fields");
  }
  if (record["schemaVersion"] !== 1) {
    throw new DesktopRuntimeConfigError("desktop runtime config schemaVersion must be 1");
  }
  const accessTokenFile = textValue(record["accessTokenFile"], "accessTokenFile");
  if (accessTokenFile !== undefined && !path.isAbsolute(accessTokenFile)) {
    throw new DesktopRuntimeConfigError("accessTokenFile must be an absolute path");
  }
  return {
    schemaVersion: 1,
    ...(textValue(record["apiBaseUrl"], "apiBaseUrl") === undefined
      ? {}
      : { apiBaseUrl: textValue(record["apiBaseUrl"], "apiBaseUrl") }),
    ...(textValue(record["wssUrl"], "wssUrl") === undefined
      ? {}
      : { wssUrl: textValue(record["wssUrl"], "wssUrl") }),
    ...(textValue(record["csrfOrigin"], "csrfOrigin") === undefined
      ? {}
      : { csrfOrigin: textValue(record["csrfOrigin"], "csrfOrigin") }),
    ...(accessTokenFile === undefined ? {} : { accessTokenFile }),
    ...(booleanValue(record["allowLoopbackHttp"], "allowLoopbackHttp") === undefined
      ? {}
      : { allowLoopbackHttp: booleanValue(record["allowLoopbackHttp"], "allowLoopbackHttp") }),
    ...(booleanValue(record["allowPrivateLanHttp"], "allowPrivateLanHttp") === undefined
      ? {}
      : {
          allowPrivateLanHttp: booleanValue(record["allowPrivateLanHttp"], "allowPrivateLanHttp"),
        }),
    ...(booleanValue(record["autoStartAtLogin"], "autoStartAtLogin") === undefined
      ? {}
      : { autoStartAtLogin: booleanValue(record["autoStartAtLogin"], "autoStartAtLogin") }),
    ...(booleanValue(record["startupHidden"], "startupHidden") === undefined
      ? {}
      : { startupHidden: booleanValue(record["startupHidden"], "startupHidden") }),
    ...(booleanValue(record["mcpEnabled"], "mcpEnabled") === undefined
      ? {}
      : { mcpEnabled: booleanValue(record["mcpEnabled"], "mcpEnabled") }),
    ...(portValue(record["mcpPort"], "mcpPort") === undefined
      ? {}
      : { mcpPort: portValue(record["mcpPort"], "mcpPort") }),
  } as DesktopRuntimeFile;
}

function envText(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

export function resolveDesktopRuntimePaths(
  env: NodeJS.ProcessEnv = process.env,
  defaults: { readonly executablePath?: string } = {},
): DesktopRuntimePaths {
  const localAppData = envText(env, "LOCALAPPDATA");
  const directory =
    envText(env, "QA_HUB_DESKTOP_PROFILE_DIRECTORY") ??
    (localAppData === null ? null : path.join(localAppData, "Relay QA Hub Preview"));
  const explicitConfig = envText(env, "QA_HUB_DESKTOP_CONFIG_FILE");
  const explicitPortableConfig = envText(env, "QA_HUB_DESKTOP_PORTABLE_CONFIG_FILE");
  const explicitToken = envText(env, "QA_HUB_DESKTOP_ACCESS_TOKEN_FILE");
  const explicitHistory = envText(env, "QA_HUB_DESKTOP_NOTIFICATION_HISTORY_FILE");
  return {
    directory,
    configFile:
      explicitConfig ?? (directory === null ? null : path.join(directory, "desktop-runtime.json")),
    portableConfigFile:
      explicitPortableConfig ??
      path.join(path.dirname(defaults.executablePath ?? process.execPath), "desktop-runtime.json"),
    tokenFile:
      explicitToken ?? (directory === null ? null : path.join(directory, "desktop-access.token")),
    notificationHistoryFile:
      explicitHistory ??
      (directory === null ? null : path.join(directory, "notification-history.json")),
  };
}

function readAccessToken(filePath: string, required: boolean): string | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    if (!required) return null;
    throw new DesktopRuntimeConfigError("desktop access token file could not be read");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_TOKEN_BYTES) {
    throw new DesktopRuntimeConfigError("desktop access token file is too large");
  }
  const token = raw.trim();
  if (token.length === 0 || /[\u0000-\u0020\u007f]/u.test(token)) {
    throw new DesktopRuntimeConfigError("desktop access token file is invalid");
  }
  return token;
}

function setDefault(env: NodeJS.ProcessEnv, name: string, value: string | undefined): void {
  if (value !== undefined && envText(env, name) === null) env[name] = value;
}

export function loadDesktopRuntimeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  defaults: { readonly executablePath?: string } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  const paths = resolveDesktopRuntimePaths(source, defaults);
  const explicitConfig = envText(source, "QA_HUB_DESKTOP_CONFIG_FILE") !== null;
  const explicitPortableConfig = envText(source, "QA_HUB_DESKTOP_PORTABLE_CONFIG_FILE") !== null;
  let runtime: DesktopRuntimeFile | null = null;
  const readRuntime = (filePath: string | null, required: boolean): DesktopRuntimeFile | null => {
    if (filePath === null) return null;
    try {
      return parseRuntimeFile(filePath);
    } catch (error) {
      if (
        required ||
        !(error instanceof DesktopRuntimeConfigError && error.message.includes("could not be read"))
      ) {
        throw error;
      }
      return null;
    }
  };
  if (explicitConfig) {
    runtime = readRuntime(paths.configFile, true);
  } else if (explicitPortableConfig) {
    runtime = readRuntime(paths.portableConfigFile, true);
  } else {
    runtime = readRuntime(paths.configFile, false);
    if (runtime === null && paths.portableConfigFile !== paths.configFile) {
      runtime = readRuntime(paths.portableConfigFile, false);
    }
  }
  if (runtime !== null) {
    setDefault(env, "QA_HUB_DESKTOP_API_BASE_URL", runtime.apiBaseUrl);
    setDefault(env, "QA_HUB_DESKTOP_WSS_URL", runtime.wssUrl);
    setDefault(env, "QA_HUB_DESKTOP_CSRF_ORIGIN", runtime.csrfOrigin);
    setDefault(
      env,
      "QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP",
      runtime.allowLoopbackHttp === undefined ? undefined : runtime.allowLoopbackHttp ? "1" : "0",
    );
    setDefault(
      env,
      "QA_HUB_DESKTOP_ALLOW_PRIVATE_LAN_HTTP",
      runtime.allowPrivateLanHttp === undefined
        ? undefined
        : runtime.allowPrivateLanHttp
          ? "1"
          : "0",
    );
    setDefault(
      env,
      "QA_HUB_DESKTOP_AUTO_START",
      runtime.autoStartAtLogin === undefined ? undefined : runtime.autoStartAtLogin ? "1" : "0",
    );
    setDefault(
      env,
      "QA_HUB_DESKTOP_START_HIDDEN",
      runtime.startupHidden === undefined ? undefined : runtime.startupHidden ? "1" : "0",
    );
    setDefault(
      env,
      "QA_HUB_DESKTOP_MCP_ENABLED",
      runtime.mcpEnabled === undefined ? undefined : runtime.mcpEnabled ? "1" : "0",
    );
    setDefault(
      env,
      "QA_HUB_DESKTOP_MCP_PORT",
      runtime.mcpPort === undefined ? undefined : String(runtime.mcpPort),
    );
  }
  if (envText(env, "QA_HUB_DESKTOP_ACCESS_TOKEN") === null) {
    const explicitToken = envText(source, "QA_HUB_DESKTOP_ACCESS_TOKEN_FILE") !== null;
    const tokenFile = runtime?.accessTokenFile ?? paths.tokenFile;
    if (tokenFile !== null) {
      const token = readAccessToken(
        tokenFile,
        explicitToken || runtime?.accessTokenFile !== undefined,
      );
      if (token !== null) env["QA_HUB_DESKTOP_ACCESS_TOKEN"] = token;
    }
  }
  return env;
}
