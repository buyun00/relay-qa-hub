import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { SqliteOnlineBackupResult, SqliteStorageWorker } from "@relay-qa-hub/storage";

const MINIMUM_BACKUP_INTERVAL_MINUTES = 15;
const MAXIMUM_BACKUP_INTERVAL_MINUTES = 7 * 24 * 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class ApiBackupConfigurationError extends Error {
  readonly code = "API_BACKUP_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ApiBackupConfigurationError";
  }
}

export type ApiBackupRunnerConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      backupRoot: string;
      onStart: boolean;
      intervalMs?: number;
    }>;

export interface ApiBackupEnvironmentOptions {
  readonly dataRoot: string;
  readonly databaseFile: string;
  readonly evidenceRoot: string;
  readonly quarantineRoot: string;
  readonly sourceRoot?: string;
}

export interface ApiBackupRunnerLogger {
  info(details: Readonly<Record<string, unknown>>, message: string): void;
  error(details: Readonly<Record<string, unknown>>, message: string): void;
}

export interface ApiBackupRunner {
  start(): Promise<SqliteOnlineBackupResult | undefined>;
  stop(): Promise<void>;
}

export interface CreateApiBackupRunnerOptions {
  readonly config: ApiBackupRunnerConfig;
  readonly worker: SqliteStorageWorker;
  readonly logger: ApiBackupRunnerLogger;
  readonly now?: () => Date;
  readonly operationId?: () => string;
}

function parseBoolean(value: string | undefined, field: string): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new ApiBackupConfigurationError(`${field} must be true or false`);
}

function parseIntervalMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  if (!/^\d+$/u.test(value.trim())) {
    throw new ApiBackupConfigurationError("QA_HUB_BACKUP_INTERVAL_MINUTES must be an integer");
  }

  const minutes = Number(value.trim());
  if (
    !Number.isSafeInteger(minutes) ||
    minutes < MINIMUM_BACKUP_INTERVAL_MINUTES ||
    minutes > MAXIMUM_BACKUP_INTERVAL_MINUTES
  ) {
    throw new ApiBackupConfigurationError(
      `QA_HUB_BACKUP_INTERVAL_MINUTES must be between ${MINIMUM_BACKUP_INTERVAL_MINUTES} and ${MAXIMUM_BACKUP_INTERVAL_MINUTES}`,
    );
  }
  return minutes * 60_000;
}

function requireAbsolutePath(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) {
    throw new ApiBackupConfigurationError(`${field} must be an absolute path`);
  }
  return resolve(trimmed);
}

function canonicalizePotentialPath(value: string, field: string): string {
  const absolutePath = requireAbsolutePath(value, field);
  let existingAncestor = absolutePath;
  const missingSegments: string[] = [];

  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new ApiBackupConfigurationError(`${field} has no resolvable existing ancestor`);
    }
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }

  try {
    return resolve(realpathSync.native(existingAncestor), ...missingSegments);
  } catch (error) {
    throw new ApiBackupConfigurationError(
      `${field} could not be resolved: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function isWithinOrEqual(candidate: string, parent: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function pathsOverlap(first: string, second: string): boolean {
  return isWithinOrEqual(first, second) || isWithinOrEqual(second, first);
}

function pathsEqual(first: string, second: string): boolean {
  return relative(first, second) === "" && relative(second, first) === "";
}

function ensurePlainDirectory(directory: string, field: string, recursive: boolean): string {
  try {
    mkdirSync(directory, { recursive });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new ApiBackupConfigurationError(
        `${field} could not be created: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ApiBackupConfigurationError(`${field} must be an ordinary directory`);
    }
    return realpathSync.native(directory);
  } catch (error) {
    if (error instanceof ApiBackupConfigurationError) throw error;
    throw new ApiBackupConfigurationError(
      `${field} could not be verified: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function ensureSafeRpoRoot(backupRoot: string): string {
  const canonicalBackupRoot = ensurePlainDirectory(backupRoot, "QA_HUB_BACKUP_ROOT", true);
  if (!pathsEqual(canonicalBackupRoot, backupRoot)) {
    throw new ApiBackupConfigurationError(
      "QA_HUB_BACKUP_ROOT must not resolve through a junction or symbolic link",
    );
  }

  const requestedRpoRoot = join(backupRoot, "rpo");
  const canonicalRpoRoot = ensurePlainDirectory(requestedRpoRoot, "backup rpo root", false);
  if (
    !isWithinOrEqual(canonicalRpoRoot, canonicalBackupRoot) ||
    !pathsEqual(dirname(canonicalRpoRoot), canonicalBackupRoot)
  ) {
    throw new ApiBackupConfigurationError(
      "backup rpo root must remain a direct ordinary child of QA_HUB_BACKUP_ROOT",
    );
  }
  return canonicalRpoRoot;
}

export function parseApiBackupEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  options: ApiBackupEnvironmentOptions,
): ApiBackupRunnerConfig {
  const onStart = parseBoolean(environment["QA_HUB_BACKUP_ON_START"], "QA_HUB_BACKUP_ON_START");
  const intervalMs = parseIntervalMs(environment["QA_HUB_BACKUP_INTERVAL_MINUTES"]);
  if (!onStart && intervalMs === undefined) return Object.freeze({ enabled: false });

  const configuredRoot = environment["QA_HUB_BACKUP_ROOT"];
  if (configuredRoot === undefined || configuredRoot.trim().length === 0) {
    throw new ApiBackupConfigurationError(
      "QA_HUB_BACKUP_ROOT is required when backup-on-start or cadence is enabled",
    );
  }

  const backupRoot = canonicalizePotentialPath(configuredRoot, "QA_HUB_BACKUP_ROOT");
  const protectedRoots = [
    ["dataRoot", options.dataRoot],
    ["databaseFile", options.databaseFile],
    ["evidenceRoot", options.evidenceRoot],
    ["quarantineRoot", options.quarantineRoot],
    ...(options.sourceRoot === undefined ? [] : ([["sourceRoot", options.sourceRoot]] as const)),
  ] as const;

  for (const [name, protectedPath] of protectedRoots) {
    const canonicalProtectedPath = canonicalizePotentialPath(protectedPath, name);
    if (pathsOverlap(backupRoot, canonicalProtectedPath)) {
      throw new ApiBackupConfigurationError(`QA_HUB_BACKUP_ROOT must not overlap ${name}`);
    }
  }

  return Object.freeze({
    enabled: true,
    backupRoot,
    onStart,
    ...(intervalMs === undefined ? {} : { intervalMs }),
  });
}

function backupTargetPath(rpoRoot: string, createdAt: string, operationId: string): string {
  if (!UUID_PATTERN.test(operationId)) {
    throw new ApiBackupConfigurationError("backup operationId must be a canonical UUID");
  }
  const safeTimestamp = createdAt.replaceAll(":", "-");
  const targetPath = resolve(rpoRoot, `${safeTimestamp}.${operationId}.sqlite`);
  if (!pathsEqual(dirname(targetPath), rpoRoot) || !isWithinOrEqual(targetPath, rpoRoot)) {
    throw new ApiBackupConfigurationError(
      "generated SQLite backup target must remain within the backup rpo root",
    );
  }
  return targetPath;
}

export function createApiBackupRunner(options: CreateApiBackupRunnerOptions): ApiBackupRunner {
  if (!options.config.enabled) {
    return Object.freeze({
      start: async () => undefined,
      stop: async () => undefined,
    });
  }

  const config = options.config;
  const now = options.now ?? (() => new Date());
  const operationId = options.operationId ?? randomUUID;
  let timer: NodeJS.Timeout | undefined;
  let activeBackup: Promise<SqliteOnlineBackupResult> | undefined;
  let started = false;
  let stopped = false;

  const runBackup = async (): Promise<SqliteOnlineBackupResult | undefined> => {
    if (stopped) return undefined;
    if (activeBackup !== undefined) return activeBackup;
    const createdAt = now().toISOString();
    const rpoRoot = ensureSafeRpoRoot(config.backupRoot);
    if (stopped) return undefined;
    const targetPath = backupTargetPath(rpoRoot, createdAt, operationId());
    const current = options.worker.createOnlineBackup({ targetPath, createdAt });
    activeBackup = current;
    try {
      return await current;
    } finally {
      if (activeBackup === current) activeBackup = undefined;
    }
  };

  const recordSuccess = (result: SqliteOnlineBackupResult): void => {
    options.logger.info(
      {
        backupPath: result.backupPath,
        manifestPath: result.manifestPath,
        sizeBytes: result.manifest.backup.sizeBytes,
        sha256: result.manifest.backup.sha256,
      },
      "Relay QA Hub online backup completed",
    );
  };

  return Object.freeze({
    async start(): Promise<SqliteOnlineBackupResult | undefined> {
      if (started) throw new Error("API backup runner has already started");
      started = true;
      if (stopped) return undefined;

      let onStartResult: SqliteOnlineBackupResult | undefined;
      if (config.onStart) {
        onStartResult = await runBackup();
        if (onStartResult !== undefined) recordSuccess(onStartResult);
      }

      if (!stopped && config.intervalMs !== undefined) {
        timer = setInterval(() => {
          if (stopped) return;
          void runBackup()
            .then((result) => {
              if (result !== undefined) recordSuccess(result);
            })
            .catch((error: unknown) => {
              options.logger.error({ error }, "Relay QA Hub scheduled online backup failed");
            });
        }, config.intervalMs);
        timer.unref();
      }
      return onStartResult;
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      await activeBackup;
    },
  });
}
