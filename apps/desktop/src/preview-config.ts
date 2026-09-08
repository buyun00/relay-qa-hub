import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface PreviewDesktopIdentity {
  readonly instanceId: string;
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
  if (value["schemaVersion"] !== 1) throw new Error("PREVIEW_CONFIG_SCHEMA_INVALID");
  const instanceId = text("instanceId");
  if (!/^qa-hub-preview-[a-z0-9-]+$/u.test(instanceId)) throw new Error("PREVIEW_ID_INVALID");
  const profile = text("profileDirectory");
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
    profileDirectory,
    cookieName,
    updateManifestUrl: manifest.toString(),
    updatePublicKeyPem: publicKey,
    environment,
  };
}
