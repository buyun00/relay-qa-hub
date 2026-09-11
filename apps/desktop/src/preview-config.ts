import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { APP_SCHEME } from "./config.js";
import { deriveToastActivatorClsid } from "./notification-activation.js";

const INSTANCE_PATTERN = /^qa-hub-(preview|lan)-([a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9]))$/u;
const LEGACY_INSTANCE_ID = "qa-hub-preview-7c86";

export interface PreviewDesktopIdentity {
  readonly instanceId: string;
  readonly appScheme: string;
  readonly appUserModelId: string;
  readonly toastActivatorClsid: string;
  readonly profileDirectory: string;
  readonly cookieName: string;
  readonly updateManifestUrl: string;
  readonly updatePublicKeyPem: string;
  readonly environment: NodeJS.ProcessEnv;
}

function canonical(value: string): string {
  let cursor = path.resolve(value);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error("PREVIEW_PATH_LINK_REFUSED");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("PREVIEW_PATH_INVALID");
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(realpathSync.native(cursor), ...suffix);
}

/** Preview executables require an explicit identity before Electron acquires its single-instance lock. */
export function loadPreviewDesktopIdentity(
  source: NodeJS.ProcessEnv,
  executablePath = process.execPath,
): PreviewDesktopIdentity {
  const configPath =
    source["QA_HUB_PREVIEW_DESKTOP_CONFIG"]?.trim() ||
    path.join(path.dirname(executablePath), "preview-instance.json");
  const raw = readFileSync(configPath, "utf8");
  if (Buffer.byteLength(raw) > 65536) throw new Error("PREVIEW_CONFIG_TOO_LARGE");
  const value = JSON.parse(raw) as Record<string, unknown>;
  const text = (key: string): string => {
    const result = value[key];
    if (typeof result !== "string" || !result.trim() || /[\u0000-\u001f]/u.test(result)) {
      throw new Error(`PREVIEW_CONFIG_${key}_INVALID`);
    }
    return result;
  };
  if (value["schemaVersion"] !== 1 && value["schemaVersion"] !== 2)
    throw new Error("PREVIEW_CONFIG_SCHEMA_INVALID");
  const instanceId = text("instanceId");
  const instanceMatch = INSTANCE_PATTERN.exec(instanceId);
  if (instanceMatch === null || instanceId.includes("--")) throw new Error("PREVIEW_ID_INVALID");
  const mode = instanceMatch[1];
  const suffix = instanceMatch[2];
  if (suffix === undefined) throw new Error("PREVIEW_ID_INVALID");
  const expectedAppScheme = instanceId === LEGACY_INSTANCE_ID ? APP_SCHEME : instanceId;
  const appScheme =
    value["appScheme"] === undefined && instanceId === LEGACY_INSTANCE_ID
      ? APP_SCHEME
      : text("appScheme");
  if (appScheme !== expectedAppScheme) throw new Error("PREVIEW_APP_SCHEME_MISMATCH");
  const identitySegment = mode === "lan" ? "lan" : "preview";
  const expectedAppUserModelId =
    instanceId === LEGACY_INSTANCE_ID
      ? "com.relayqahub.desktop.preview"
      : `com.relayqahub.desktop.${identitySegment}.${suffix.replaceAll("-", ".")}`;
  const appUserModelId =
    value["appUserModelId"] === undefined && instanceId === LEGACY_INSTANCE_ID
      ? expectedAppUserModelId
      : text("appUserModelId");
  if (appUserModelId !== expectedAppUserModelId)
    throw new Error("PREVIEW_APP_USER_MODEL_ID_MISMATCH");
  const expectedToastActivatorClsid = deriveToastActivatorClsid(appUserModelId);
  const toastActivatorClsid =
    value["toastActivatorClsid"] === undefined
      ? expectedToastActivatorClsid
      : text("toastActivatorClsid");
  if (toastActivatorClsid !== expectedToastActivatorClsid)
    throw new Error("PREVIEW_TOAST_ACTIVATOR_CLSID_MISMATCH");
  const profile =
    value["schemaVersion"] === 2
      ? (() => {
          const profileDirectoryName = text("profileDirectoryName");
          if (profileDirectoryName !== instanceId) throw new Error("PREVIEW_PROFILE_ID_MISMATCH");
          const localAppData = source["LOCALAPPDATA"]?.trim();
          if (!localAppData || !path.isAbsolute(localAppData))
            throw new Error("PREVIEW_LOCAL_APP_DATA_INVALID");
          return path.join(localAppData, "Relay QA Hub LAN", profileDirectoryName, "profile");
        })()
      : text("profileDirectory");
  if (!path.isAbsolute(profile)) throw new Error("PREVIEW_PROFILE_MUST_BE_ABSOLUTE");
  const profileDirectory = canonical(profile);
  if (!profileDirectory.split(/[\\/]/u).includes(instanceId))
    throw new Error("PREVIEW_PROFILE_ID_MISMATCH");
  const blocked = [
    "D:\\Relay-QA-Hub",
    "D:\\Relay-QA-Hub-Data",
    "D:\\Relay-QA-Hub-Config",
    "E:\\Relay-QA-Hub-Archives",
    path.join(source["LOCALAPPDATA"] ?? "C:\\", "Relay QA Hub"),
    path.join(source["APPDATA"] ?? "C:\\", "Relay QA Hub"),
  ];
  for (const root of blocked) {
    const candidate = canonical(root).toLowerCase();
    const selected = profileDirectory.toLowerCase();
    if (
      selected === candidate ||
      selected.startsWith(candidate + path.sep) ||
      candidate.startsWith(selected + path.sep)
    ) {
      throw new Error("PREVIEW_PROFILE_PRODUCTION_OVERLAP");
    }
  }
  const api = new URL(text("apiBaseUrl"));
  const csrf = new URL(text("csrfOrigin"));
  const manifest = new URL(text("updateManifestUrl"));
  for (const url of [api, csrf, manifest]) {
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      ["4319", "4174", "4320"].includes(url.port)
    )
      throw new Error("PREVIEW_ENDPOINT_INVALID");
  }
  if (value["schemaVersion"] === 2 && api.origin !== csrf.origin)
    throw new Error("PREVIEW_ENDPOINT_ORIGIN_MISMATCH");
  if (manifest.origin !== csrf.origin || !manifest.pathname.includes(instanceId))
    throw new Error("PREVIEW_UPDATE_CHANNEL_MISMATCH");
  const mcpPort = value["mcpPort"];
  if (
    !Number.isSafeInteger(mcpPort) ||
    Number(mcpPort) < 1024 ||
    Number(mcpPort) > 65535 ||
    [4319, 4174, 4320].includes(Number(mcpPort))
  )
    throw new Error("PREVIEW_MCP_PORT_INVALID");
  const cookieName = text("cookieName");
  if (cookieName !== `${instanceId}-session`) throw new Error("PREVIEW_COOKIE_ID_MISMATCH");
  const publicKey = value["updatePublicKeyPem"];
  if (typeof publicKey !== "string" || !publicKey.startsWith("-----BEGIN PUBLIC KEY-----"))
    throw new Error("PREVIEW_UPDATE_KEY_INVALID");
  const environment = { ...source };
  for (const key of Object.keys(environment))
    if (key.startsWith("QA_HUB_")) delete environment[key];
  Object.assign(environment, {
    QA_HUB_DESKTOP_APP_SCHEME: appScheme,
    QA_HUB_DESKTOP_API_BASE_URL: api.toString(),
    QA_HUB_DESKTOP_CSRF_ORIGIN: csrf.origin,
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
    QA_HUB_DESKTOP_ALLOW_PRIVATE_LAN_HTTP: "1",
    QA_HUB_DESKTOP_MCP_PORT: String(mcpPort),
    QA_HUB_DESKTOP_MCP_ENABLED: "1",
    QA_HUB_DESKTOP_AUTO_START: "0",
    QA_HUB_DESKTOP_PROFILE_DIRECTORY: profileDirectory,
    QA_HUB_DESKTOP_NOTIFICATION_HISTORY_FILE: path.join(
      profileDirectory,
      "notification-history.json",
    ),
  });
  return {
    instanceId,
    appScheme,
    appUserModelId,
    toastActivatorClsid,
    profileDirectory,
    cookieName,
    updateManifestUrl: manifest.toString(),
    updatePublicKeyPem: publicKey,
    environment,
  };
}
