import { existsSync, readFileSync, realpathSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

export interface ParallelInstanceConfig {
  readonly schemaVersion: 1 | 2;
  readonly deploymentMode: "preview" | "lan";
  readonly instanceId: string;
  readonly sourceRoot: string;
  readonly runtimeRoot: string;
  readonly dataRoot: string;
  readonly backupRoot: string;
  readonly backupArchiveRoot: string | null;
  readonly backupIntervalMinutes: number | null;
  readonly backupRetentionEnabled: boolean;
  readonly downloadsRoot: string;
  readonly logsRoot: string;
  readonly desktopRoot: string;
  readonly apiHost: string;
  readonly apiPort: number;
  readonly webHost: string;
  readonly webPort: number;
  readonly mcpPort: number;
  readonly mcpHost: string;
  readonly desktopMcpPort: number;
  readonly cookieName: string;
  readonly gmUserId: string;
  readonly secretsFile: string;
  readonly peopleFile: string;
  readonly releaseChannel: string;
  readonly publicWebBaseUrl: string;
  readonly backupEnabled: boolean;
  readonly lanCidr: string | null;
}

// This preview branch must never inherit a production connection from the shell.
// Canonical path checks cover existing parents, junctions, and paths not created yet.
export function canonicalInstancePath(value: string): string {
  if (!isAbsolute(value)) throw new Error("INSTANCE_PATH_MUST_BE_ABSOLUTE");
  let ancestor = resolve(value);
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    // A dangling link must not become a future escape after startup.
    try {
      if (lstatSync(ancestor).isSymbolicLink()) throw new Error("INSTANCE_DANGLING_LINK");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("INSTANCE_PATH_HAS_NO_EXISTING_PARENT");
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync.native(ancestor), ...missing);
}

export function isInstancePathWithin(candidate: string, root: string): boolean {
  const suffix = relative(root, candidate);
  return (
    suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}

function instancePathsEqual(first: string, second: string): boolean {
  const left = resolve(first);
  const right = resolve(second);
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function canonicalConfiguredPath(value: string, field: string): string {
  const requested = resolve(value);
  const canonical = canonicalInstancePath(value);
  let info;
  try {
    info = lstatSync(requested);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (info?.isSymbolicLink() || !instancePathsEqual(requested, canonical)) {
    throw new Error(`INSTANCE_CONFIGURED_PATH_LINK_REFUSED: ${field}`);
  }
  return canonical;
}

function rejectRuntimeLinks(root: string, backupRoot: string): void {
  if (!existsSync(root)) return;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink() || !isInstancePathWithin(canonicalInstancePath(target), root)) {
        throw new Error("INSTANCE_RUNTIME_LINK_REFUSED");
      }
      if (entry.isDirectory() && !instancePathsEqual(target, backupRoot)) pending.push(target);
    }
  }
}

const PROTECTED_ROOTS = [
  "D:\\Relay-QA-Hub",
  "D:\\Relay-QA-Hub-Data",
  "D:\\Relay-QA-Hub-Config",
  "E:\\Relay-QA-Hub-Archives",
  "C:\\ProgramData\\Relay",
];

function textField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`INSTANCE_CONFIG_REQUIRED: ${key}`);
  }
  return value.trim();
}

function ipv4Number(value: string): { normalized: string; number: number } {
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/u.test(part) || Number(part) > 255)
  )
    throw new Error("INSTANCE_LAN_ADDRESS_INVALID");
  const octets = parts.map(Number);
  return {
    normalized: octets.join("."),
    number: (((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 + octets[3]!) >>> 0,
  };
}

function isPrivateIpv4(value: number): boolean {
  return (
    (value >= 0x0a000000 && value <= 0x0affffff) ||
    (value >= 0xac100000 && value <= 0xac1fffff) ||
    (value >= 0xc0a80000 && value <= 0xc0a8ffff)
  );
}

export function validateLanNetwork(
  addressValue: string,
  cidrValue: string,
): { address: string; cidr: string } {
  const address = ipv4Number(addressValue.trim());
  if (!isPrivateIpv4(address.number)) throw new Error("INSTANCE_LAN_ADDRESS_NOT_PRIVATE");
  const [networkValue, prefixValue, ...extra] = cidrValue.trim().split("/");
  if (
    !networkValue ||
    !prefixValue ||
    extra.length > 0 ||
    !/^(?:[89]|[12]\d|30)$/u.test(prefixValue)
  )
    throw new Error("INSTANCE_LAN_CIDR_INVALID");
  const network = ipv4Number(networkValue);
  const prefix = Number(prefixValue);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const canonicalNetwork = (network.number & mask) >>> 0;
  if (!isPrivateIpv4(canonicalNetwork) || network.number !== canonicalNetwork)
    throw new Error("INSTANCE_LAN_CIDR_INVALID");
  if ((address.number & mask) >>> 0 !== canonicalNetwork)
    throw new Error("INSTANCE_LAN_ADDRESS_OUTSIDE_CIDR");
  const hostBits = address.number & (~mask >>> 0);
  const broadcastBits = ~mask >>> 0;
  if (hostBits === 0 || hostBits === broadcastBits)
    throw new Error("INSTANCE_LAN_ADDRESS_NOT_HOST");
  const normalizedNetwork = [24, 16, 8, 0]
    .map((shift) => (canonicalNetwork >>> shift) & 255)
    .join(".");
  return { address: address.normalized, cidr: `${normalizedNetwork}/${prefix}` };
}

export function readParallelInstanceConfig(configFile: string | undefined): ParallelInstanceConfig {
  if (!configFile)
    throw new Error("QA_HUB_INSTANCE_CONFIG_FILE is required; production defaults are disabled");
  const configPath = canonicalConfiguredPath(configFile, "configFile");
  const raw: unknown = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/u, ""));
  return validateParallelInstanceConfig(raw, configPath);
}

export function validateParallelInstanceConfig(
  raw: unknown,
  configPath: string,
): ParallelInstanceConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("INSTANCE_CONFIG_INVALID");
  const verifiedConfigPath = canonicalConfiguredPath(configPath, "configFile");
  const record = raw as Record<string, unknown>;
  if (record["schemaVersion"] !== 1 && record["schemaVersion"] !== 2)
    throw new Error("INSTANCE_CONFIG_SCHEMA_INVALID");
  const schemaVersion = record["schemaVersion"];
  const deploymentMode = schemaVersion === 1 ? "preview" : textField(record, "deploymentMode");
  if (deploymentMode !== "preview" && deploymentMode !== "lan")
    throw new Error("INSTANCE_DEPLOYMENT_MODE_INVALID");
  const instanceId = textField(record, "instanceId");
  if (
    (deploymentMode === "preview" && !/^qa-hub-preview-[a-z0-9-]{3,40}$/u.test(instanceId)) ||
    (deploymentMode === "lan" && !/^qa-hub-lan-[a-z0-9-]{3,40}$/u.test(instanceId))
  )
    throw new Error("INSTANCE_ID_DOES_NOT_MATCH_DEPLOYMENT_MODE");
  const sourceRoot = canonicalConfiguredPath(textField(record, "sourceRoot"), "sourceRoot");
  const runtimeRoot = canonicalConfiguredPath(textField(record, "runtimeRoot"), "runtimeRoot");
  if (
    isInstancePathWithin(runtimeRoot, sourceRoot) ||
    isInstancePathWithin(sourceRoot, runtimeRoot)
  ) {
    throw new Error("INSTANCE_RUNTIME_AND_SOURCE_MUST_BE_SEPARATE");
  }
  const protectedRoots = process.platform === "win32" ? PROTECTED_ROOTS : [];
  for (const blocked of protectedRoots) {
    const protectedRoot = canonicalInstancePath(blocked);
    for (const candidate of [sourceRoot, runtimeRoot]) {
      if (
        isInstancePathWithin(candidate, protectedRoot) ||
        isInstancePathWithin(protectedRoot, candidate)
      ) {
        throw new Error("INSTANCE_PRODUCTION_PATH_REFUSED");
      }
    }
  }
  if (!isInstancePathWithin(verifiedConfigPath, runtimeRoot))
    throw new Error("INSTANCE_CONFIG_OUTSIDE_RUNTIME");
  const paths: Record<string, string> = {};
  for (const field of [
    "dataRoot",
    "backupRoot",
    "downloadsRoot",
    "logsRoot",
    "desktopRoot",
    "secretsFile",
    "peopleFile",
  ]) {
    const candidate = canonicalConfiguredPath(textField(record, field), field);
    if (candidate === runtimeRoot || !isInstancePathWithin(candidate, runtimeRoot)) {
      throw new Error(`INSTANCE_PATH_OUTSIDE_RUNTIME: ${field}`);
    }
    paths[field] = candidate;
  }
  // A sealed rollback bundle may contain dependency links. The backup root is
  // validated as an ordinary in-runtime directory above, while its retained
  // descendants are outside live service I/O and have their own validators.
  // Every other runtime descendant keeps the original recursive link guard.
  rejectRuntimeLinks(runtimeRoot, paths["backupRoot"]!);
  const dataPaths = ["dataRoot", "backupRoot", "downloadsRoot", "logsRoot", "desktopRoot"];
  for (const [index, first] of dataPaths.entries()) {
    for (const second of dataPaths.slice(index + 1)) {
      if (
        isInstancePathWithin(paths[first]!, paths[second]!) ||
        isInstancePathWithin(paths[second]!, paths[first]!)
      ) {
        throw new Error(`INSTANCE_RESOURCE_PATHS_OVERLAP: ${first}/${second}`);
      }
    }
  }
  const ports: Record<string, number> = {};
  for (const field of ["apiPort", "webPort", "mcpPort", "desktopMcpPort"]) {
    const port = record[field];
    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      [4317, 4319, 4320, 4174, 3000].includes(port)
    ) {
      throw new Error(`INSTANCE_PORT_INVALID_OR_PRODUCTION: ${field}`);
    }
    ports[field] = port;
  }
  if (new Set(Object.values(ports)).size !== 4) throw new Error("INSTANCE_PORTS_MUST_BE_DISTINCT");
  const cookieName = textField(record, "cookieName");
  if (cookieName !== `${instanceId}-session`) throw new Error("INSTANCE_COOKIE_MUST_BE_ISOLATED");
  const releaseChannel = textField(record, "releaseChannel");
  if (releaseChannel !== instanceId) throw new Error("INSTANCE_RELEASE_CHANNEL_MUST_BE_ISOLATED");
  const gmUserId = textField(record, "gmUserId");
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(gmUserId))
    throw new Error("INSTANCE_GM_ID_INVALID");
  const apiHost = textField(record, "apiHost");
  const webHost = textField(record, "webHost");
  const mcpHost = schemaVersion === 1 ? apiHost : textField(record, "mcpHost");
  if (
    deploymentMode === "preview" &&
    (apiHost !== "127.0.0.1" || webHost !== "127.0.0.1" || mcpHost !== "127.0.0.1")
  )
    throw new Error("INSTANCE_INITIAL_BIND_MUST_BE_LOOPBACK");
  if (
    deploymentMode === "lan" &&
    (apiHost !== "127.0.0.1" || webHost !== "0.0.0.0" || mcpHost !== "0.0.0.0")
  )
    throw new Error("INSTANCE_LAN_BIND_INVALID");
  const publicWebBaseUrl =
    schemaVersion === 1
      ? `http://${webHost}:${ports["webPort"]}`
      : textField(record, "publicWebBaseUrl");
  let publicUrl: URL;
  try {
    publicUrl = new URL(publicWebBaseUrl);
  } catch {
    throw new Error("INSTANCE_PUBLIC_BASE_URL_INVALID");
  }
  if (
    !["http:", "https:"].includes(publicUrl.protocol) ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash ||
    Number(publicUrl.port || (publicUrl.protocol === "https:" ? 443 : 80)) !== ports["webPort"]
  )
    throw new Error("INSTANCE_PUBLIC_BASE_URL_INVALID");
  const lanCidr = deploymentMode === "lan" ? textField(record, "lanCidr") : null;
  if (deploymentMode === "lan") {
    const network = validateLanNetwork(publicUrl.hostname, lanCidr!);
    if (network.address !== publicUrl.hostname || network.cidr !== lanCidr)
      throw new Error("INSTANCE_LAN_NETWORK_NOT_CANONICAL");
  }
  const backupEnabled = schemaVersion === 1 ? false : record["backupEnabled"];
  if (typeof backupEnabled !== "boolean" || (deploymentMode === "lan" && !backupEnabled))
    throw new Error("INSTANCE_BACKUP_MODE_INVALID");
  const backupArchiveRoot =
    schemaVersion === 1
      ? null
      : canonicalConfiguredPath(textField(record, "backupArchiveRoot"), "backupArchiveRoot");
  if (backupArchiveRoot !== null) {
    if (
      isInstancePathWithin(backupArchiveRoot, sourceRoot) ||
      isInstancePathWithin(sourceRoot, backupArchiveRoot) ||
      isInstancePathWithin(backupArchiveRoot, runtimeRoot) ||
      isInstancePathWithin(runtimeRoot, backupArchiveRoot)
    ) {
      throw new Error("INSTANCE_BACKUP_ARCHIVE_MUST_BE_SEPARATE");
    }
    for (const blocked of protectedRoots) {
      const protectedRoot = canonicalInstancePath(blocked);
      if (
        isInstancePathWithin(backupArchiveRoot, protectedRoot) ||
        isInstancePathWithin(protectedRoot, backupArchiveRoot)
      ) {
        throw new Error("INSTANCE_PRODUCTION_PATH_REFUSED");
      }
    }
  }
  const backupIntervalMinutes = schemaVersion === 1 ? null : record["backupIntervalMinutes"];
  if (
    backupIntervalMinutes !== null &&
    (!Number.isSafeInteger(backupIntervalMinutes) ||
      Number(backupIntervalMinutes) < 15 ||
      Number(backupIntervalMinutes) > 7 * 24 * 60)
  )
    throw new Error("INSTANCE_BACKUP_INTERVAL_INVALID");
  const backupRetentionEnabled = schemaVersion === 1 ? false : record["backupRetentionEnabled"];
  if (
    typeof backupRetentionEnabled !== "boolean" ||
    (deploymentMode === "lan" &&
      (!backupRetentionEnabled || backupArchiveRoot === null || backupIntervalMinutes === null))
  )
    throw new Error("INSTANCE_BACKUP_RETENTION_INVALID");
  return {
    schemaVersion,
    deploymentMode,
    instanceId,
    sourceRoot,
    runtimeRoot,
    ...paths,
    ...ports,
    cookieName,
    releaseChannel,
    gmUserId,
    apiHost,
    webHost,
    mcpHost,
    publicWebBaseUrl: publicUrl.origin,
    backupEnabled,
    backupArchiveRoot,
    backupIntervalMinutes: backupIntervalMinutes as number | null,
    backupRetentionEnabled,
    lanCidr,
  } as unknown as ParallelInstanceConfig;
}

export function parallelInstanceEnvironment(
  config: ParallelInstanceConfig,
): Record<string, string> {
  const secretRecord = JSON.parse(
    readFileSync(config.secretsFile, "utf8").replace(/^\uFEFF/u, ""),
  ) as Record<string, unknown>;
  const secret = (name: string): string => {
    const value = textField(secretRecord, name);
    if (value.length < 32) throw new Error(`INSTANCE_SECRET_TOO_SHORT: ${name}`);
    return value;
  };
  const sessionSecret = secret("sessionSecret");
  const onboardingSecretValue = secretRecord["onboardingSecret"];
  const onboardingSecret =
    typeof onboardingSecretValue === "string" && onboardingSecretValue.length >= 32
      ? onboardingSecretValue
      : createHash("sha256")
          .update(`qa-hub-project-onboarding\0${sessionSecret}`, "utf8")
          .digest("base64url");
  return {
    QA_HUB_INSTANCE_ID: config.instanceId,
    QA_HUB_SOURCE_ROOT: config.sourceRoot,
    QA_HUB_DATA_ROOT: config.dataRoot,
    QA_HUB_BACKUP_ROOT: config.backupRoot,
    QA_HUB_BACKUP_ENABLED: config.backupEnabled ? "true" : "false",
    QA_HUB_BACKUP_ON_START: config.backupEnabled ? "true" : "false",
    ...(config.backupIntervalMinutes === null
      ? {}
      : { QA_HUB_BACKUP_INTERVAL_MINUTES: String(config.backupIntervalMinutes) }),
    QA_HUB_BACKUP_ARCHIVE_ENABLED: config.backupArchiveRoot === null ? "false" : "true",
    ...(config.backupArchiveRoot === null
      ? {}
      : { QA_HUB_BACKUP_ARCHIVE_ROOT: config.backupArchiveRoot }),
    QA_HUB_BACKUP_RETENTION_ENABLED: config.backupRetentionEnabled ? "true" : "false",
    QA_HUB_API_HOST: config.apiHost,
    QA_HUB_API_PORT: String(config.apiPort),
    QA_HUB_API_BASE_URL: `http://${config.apiHost}:${config.apiPort}`,
    QA_HUB_WEB_HOST: config.webHost,
    QA_HUB_WEB_PORT: String(config.webPort),
    QA_HUB_WEB_ORIGINS: config.publicWebBaseUrl,
    QA_HUB_WEB_AUTH_MODE: "session",
    QA_HUB_WEB_SECURE_COOKIE: "false",
    QA_HUB_WEB_SESSION_COOKIE_NAME: config.cookieName,
    QA_HUB_WEB_SESSION_SECRET: sessionSecret,
    QA_HUB_MVP_ACCESS_TOKEN: secret("debugToken"),
    QA_HUB_GM_USER_ID: config.gmUserId,
    QA_HUB_GM_PASSWORD: secret("gmPassword"),
    QA_HUB_PEOPLE_CONFIG_FILE: config.peopleFile,
    QA_HUB_ANDROID_UPDATE_ROOT: join(config.downloadsRoot, "android", config.releaseChannel),
    QA_HUB_ANDROID_UPDATE_CHANNEL: "preview",
    QA_HUB_ANDROID_PACKAGE_NAME:
      config.deploymentMode === "lan"
        ? "com.relayqahub.android.lan.v22.debug"
        : "com.relayqahub.android.preview.debug",
    QA_HUB_QINGYU_STATE_FILE: join(config.dataRoot, "integrations", "qingyu-state.enc.json"),
    QA_HUB_RELEASE_CHANNEL: config.releaseChannel,
    QA_HUB_MCP_PORT: String(config.mcpPort),
    QA_HUB_PROJECT_ONBOARDING_SECRET: onboardingSecret,
    QA_HUB_PUBLIC_WEB_BASE_URL: config.publicWebBaseUrl,
    QA_HUB_DISTRIBUTION_MANIFEST_FILE: join(config.downloadsRoot, "distribution.json"),
  };
}

export function applyParallelInstanceEnvironment(env: NodeJS.ProcessEnv): ParallelInstanceConfig {
  const configFile = env["QA_HUB_INSTANCE_CONFIG_FILE"];
  const config = readParallelInstanceConfig(configFile);
  const isolated = parallelInstanceEnvironment(config);
  // Discard inherited integration, credential, backup, uploader and path overrides.
  for (const key of Object.keys(env)) if (key.startsWith("QA_HUB_")) delete env[key];
  Object.assign(env, isolated, { QA_HUB_INSTANCE_CONFIG_FILE: configFile });
  return config;
}
