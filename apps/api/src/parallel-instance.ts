import { existsSync, readFileSync, realpathSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ParallelInstanceConfig {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly sourceRoot: string;
  readonly runtimeRoot: string;
  readonly dataRoot: string;
  readonly backupRoot: string;
  readonly downloadsRoot: string;
  readonly logsRoot: string;
  readonly desktopRoot: string;
  readonly apiHost: string;
  readonly apiPort: number;
  readonly webHost: string;
  readonly webPort: number;
  readonly mcpPort: number;
  readonly desktopMcpPort: number;
  readonly cookieName: string;
  readonly gmUserId: string;
  readonly secretsFile: string;
  readonly peopleFile: string;
  readonly releaseChannel: string;
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
  if (record["schemaVersion"] !== 1) throw new Error("INSTANCE_CONFIG_SCHEMA_INVALID");
  const instanceId = textField(record, "instanceId");
  if (!/^qa-hub-preview-[a-z0-9-]{3,40}$/u.test(instanceId))
    throw new Error("INSTANCE_ID_MUST_BE_PREVIEW");
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
  if (apiHost !== "127.0.0.1" || webHost !== "127.0.0.1")
    throw new Error("INSTANCE_INITIAL_BIND_MUST_BE_LOOPBACK");
  return {
    schemaVersion: 1,
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
  return {
    QA_HUB_INSTANCE_ID: config.instanceId,
    QA_HUB_SOURCE_ROOT: config.sourceRoot,
    QA_HUB_DATA_ROOT: config.dataRoot,
    QA_HUB_BACKUP_ROOT: config.backupRoot,
    QA_HUB_BACKUP_ENABLED: "false",
    QA_HUB_API_HOST: config.apiHost,
    QA_HUB_API_PORT: String(config.apiPort),
    QA_HUB_API_BASE_URL: `http://${config.apiHost}:${config.apiPort}`,
    QA_HUB_WEB_HOST: config.webHost,
    QA_HUB_WEB_PORT: String(config.webPort),
    QA_HUB_WEB_ORIGINS: `http://${config.webHost}:${config.webPort}`,
    QA_HUB_WEB_AUTH_MODE: "session",
    QA_HUB_WEB_SECURE_COOKIE: "false",
    QA_HUB_WEB_SESSION_COOKIE_NAME: config.cookieName,
    QA_HUB_WEB_SESSION_SECRET: secret("sessionSecret"),
    QA_HUB_MVP_ACCESS_TOKEN: secret("debugToken"),
    QA_HUB_GM_USER_ID: config.gmUserId,
    QA_HUB_GM_PASSWORD: secret("gmPassword"),
    QA_HUB_PEOPLE_CONFIG_FILE: config.peopleFile,
    QA_HUB_ANDROID_UPDATE_ROOT: join(config.downloadsRoot, "android", config.releaseChannel),
    QA_HUB_ANDROID_UPDATE_CHANNEL: "preview",
    QA_HUB_QINGYU_STATE_FILE: join(config.dataRoot, "integrations", "qingyu-state.enc.json"),
    QA_HUB_RELEASE_CHANNEL: config.releaseChannel,
    QA_HUB_MCP_PORT: String(config.mcpPort),
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
