import { backup, DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  backupFileSha256,
  type SqliteBackupManifest,
  validateSqliteBackup,
} from "./sqlite-backup.js";
import { QA_HUB_SQLITE_APPLICATION_ID } from "./sqlite.js";

export type SqliteRestoreErrorCode =
  | "SQLITE_RESTORE_CONFIGURATION_INVALID"
  | "SQLITE_RESTORE_ROOT_EXISTS"
  | "SQLITE_RESTORE_MANIFEST_INVALID"
  | "SQLITE_RESTORE_BACKUP_INVALID"
  | "SQLITE_RESTORE_FAILED";

export class SqliteRestoreError extends Error {
  constructor(
    readonly code: SqliteRestoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SqliteRestoreError";
  }
}

export interface SqliteIsolatedRestoreOptions {
  /** Existing P8.3 backup database. */
  readonly backupPath: string;
  /** Optional P8.3 sidecar path; defaults to `${backupPath}.manifest.json`. */
  readonly manifestPath?: string;
  /** New, non-existent directory that will receive the isolated database. */
  readonly restoreRoot: string;
}

export interface SqliteIsolatedRestoreResult {
  readonly restoreRoot: string;
  readonly databasePath: string;
  readonly markerPath: string;
  readonly manifest: SqliteBackupManifest;
}

export interface ValidateSqliteBackupBundleOptions {
  /** Existing online-backup database. */
  readonly backupPath: string;
  /** Optional sidecar path; defaults to `${backupPath}.manifest.json`. */
  readonly manifestPath?: string;
}

export interface SqliteBackupBundleValidation {
  readonly backupPath: string;
  readonly manifestPath: string;
  readonly manifest: SqliteBackupManifest;
}

const RESTORE_MARKER = ".qa-hub-isolated-restore.json";

function requireAbsolutePath(value: string, field: string): string {
  if (!isAbsolute(value) || value.trim().length === 0) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_CONFIGURATION_INVALID",
      `${field} must be a non-empty absolute path`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_MANIFEST_INVALID",
      `SQLite backup manifest has an invalid ${field} shape`,
    );
  }
}

function safeNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_MANIFEST_INVALID",
      `SQLite backup manifest ${field} must be a non-negative integer`,
    );
  }
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_MANIFEST_INVALID",
      "SQLite backup manifest createdAt must be a timestamp",
    );
  }
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch (error) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_MANIFEST_INVALID",
      "SQLite backup manifest createdAt must be an ISO-8601 timestamp",
      { cause: error },
    );
  }
  if (canonical !== value) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_MANIFEST_INVALID",
      "SQLite backup manifest createdAt must be canonical UTC ISO-8601",
    );
  }
  return value;
}

function parseManifest(raw: unknown): SqliteBackupManifest {
  if (!isRecord(raw)) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_MANIFEST_INVALID",
      "SQLite backup manifest must be a JSON object",
    );
  }
  exactKeys(
    raw,
    ["manifestVersion", "schemaVersion", "createdAt", "sourceDatabase", "backup", "integrity"],
    "top-level",
  );
  if (raw.manifestVersion !== 1) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_MANIFEST_INVALID",
      "SQLite backup manifest version is unsupported",
    );
  }
  const schemaVersion = safeNonNegativeInteger(raw.schemaVersion, "schemaVersion");
  const createdAt = canonicalTimestamp(raw.createdAt);

  if (!isRecord(raw.sourceDatabase)) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_MANIFEST_INVALID",
      "SQLite backup manifest sourceDatabase must be an object",
    );
  }
  exactKeys(raw.sourceDatabase, ["applicationId", "schemaVersion"], "sourceDatabase");
  const applicationId = safeNonNegativeInteger(
    raw.sourceDatabase.applicationId,
    "sourceDatabase.applicationId",
  );
  const sourceSchemaVersion = safeNonNegativeInteger(
    raw.sourceDatabase.schemaVersion,
    "sourceDatabase.schemaVersion",
  );
  if (applicationId !== QA_HUB_SQLITE_APPLICATION_ID || sourceSchemaVersion !== schemaVersion) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_MANIFEST_INVALID",
      "SQLite backup manifest source identity is not a QA Hub schema identity",
    );
  }

  if (!isRecord(raw.backup)) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_MANIFEST_INVALID",
      "SQLite backup manifest backup must be an object",
    );
  }
  exactKeys(raw.backup, ["sizeBytes", "sha256"], "backup");
  const sizeBytes = safeNonNegativeInteger(raw.backup.sizeBytes, "backup.sizeBytes");
  if (
    sizeBytes < 1 ||
    typeof raw.backup.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.backup.sha256)
  ) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_MANIFEST_INVALID",
      "SQLite backup manifest backup size/hash is invalid",
    );
  }

  if (!isRecord(raw.integrity)) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_MANIFEST_INVALID",
      "SQLite backup manifest integrity must be an object",
    );
  }
  exactKeys(raw.integrity, ["ok", "integrityMessages", "foreignKeyViolations"], "integrity");
  if (
    raw.integrity.ok !== true ||
    !Array.isArray(raw.integrity.integrityMessages) ||
    raw.integrity.integrityMessages.length !== 1 ||
    raw.integrity.integrityMessages[0] !== "ok" ||
    !Array.isArray(raw.integrity.foreignKeyViolations) ||
    raw.integrity.foreignKeyViolations.length !== 0
  ) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_MANIFEST_INVALID",
      "SQLite backup manifest integrity result is not clean",
    );
  }

  return Object.freeze({
    manifestVersion: 1,
    schemaVersion,
    createdAt,
    sourceDatabase: Object.freeze({ applicationId, schemaVersion: sourceSchemaVersion }),
    backup: Object.freeze({ sizeBytes, sha256: raw.backup.sha256 }),
    integrity: Object.freeze({
      ok: true,
      integrityMessages: Object.freeze(["ok"]),
      foreignKeyViolations: Object.freeze([]),
    }),
  });
}

function readManifest(manifestPath: string): SqliteBackupManifest {
  try {
    return parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch (error) {
    if (error instanceof SqliteRestoreError) throw error;
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_MANIFEST_INVALID",
      "SQLite backup manifest could not be read",
      { cause: error },
    );
  }
}

function writeMarker(
  markerPath: string,
  state: "in_progress" | "complete" | "failed",
  code?: string,
): void {
  writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        markerVersion: 1,
        operation: "isolated-sqlite-restore",
        state,
        ...(code === undefined ? {} : { errorCode: code }),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8" },
  );
}

function verifyBackupAgainstManifest(backupPath: string, manifest: SqliteBackupManifest): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(backupPath);
  } catch (error) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_BACKUP_INVALID",
      "SQLite backup file could not be inspected",
      { cause: error },
    );
  }
  if (!stat.isFile() || stat.size !== manifest.backup.sizeBytes) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_BACKUP_INVALID",
      "SQLite backup size does not match its manifest",
    );
  }
  if (backupFileSha256(backupPath) !== manifest.backup.sha256) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_BACKUP_INVALID",
      "SQLite backup hash does not match its manifest",
    );
  }

  let validation;
  try {
    validation = validateSqliteBackup(backupPath);
  } catch (error) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_BACKUP_INVALID",
      "SQLite backup failed restore admission validation",
      { cause: error },
    );
  }
  if (
    validation.databaseIdentity.applicationId !== QA_HUB_SQLITE_APPLICATION_ID ||
    validation.databaseIdentity.schemaVersion !== manifest.schemaVersion ||
    !validation.integrity.ok
  ) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_BACKUP_INVALID",
      "SQLite backup identity or integrity does not match its manifest",
    );
  }
}

/**
 * Validate a manifest-bound online backup without restoring or changing its database bytes.
 *
 * Callers may use this to select a recovery point, but must still enforce their
 * own directory/ownership boundary before passing paths into this helper.
 */
export function validateSqliteBackupBundle(
  options: ValidateSqliteBackupBundleOptions,
): SqliteBackupBundleValidation {
  const backupPath = requireAbsolutePath(options.backupPath, "backupPath");
  const manifestPath = requireAbsolutePath(
    options.manifestPath ?? `${backupPath}.manifest.json`,
    "manifestPath",
  );
  if (!existsSync(backupPath) || !existsSync(manifestPath)) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_BACKUP_INVALID",
      "SQLite backup database and manifest are required",
    );
  }

  const manifest = readManifest(manifestPath);
  verifyBackupAgainstManifest(backupPath, manifest);
  return Object.freeze({ backupPath, manifestPath, manifest });
}

/**
 * Restore a verified P8.3 backup into a brand-new isolated directory.
 *
 * This is intentionally not an API operation. A restore root is create-only,
 * and a marker is retained so a failed or partial restore is never mistaken for
 * a clean directory and is never recursively deleted by this helper.
 */
export async function restoreSqliteToIsolatedRoot(
  options: SqliteIsolatedRestoreOptions,
): Promise<SqliteIsolatedRestoreResult> {
  const backupPath = requireAbsolutePath(options.backupPath, "backupPath");
  const manifestPath = requireAbsolutePath(
    options.manifestPath ?? `${backupPath}.manifest.json`,
    "manifestPath",
  );
  const restoreRoot = requireAbsolutePath(options.restoreRoot, "restoreRoot");
  if (existsSync(restoreRoot)) {
    throw new SqliteRestoreError(
      "SQLITE_RESTORE_ROOT_EXISTS",
      "isolated restore root must not already exist",
    );
  }
  const { manifest } = validateSqliteBackupBundle({ backupPath, manifestPath });

  let rootCreated = false;
  const markerPath = join(restoreRoot, RESTORE_MARKER);
  const databasePath = join(restoreRoot, "db", "qa-hub.sqlite");
  try {
    mkdirSync(restoreRoot);
    rootCreated = true;
    writeMarker(markerPath, "in_progress");
    mkdirSync(join(restoreRoot, "db"));

    const immutableLocation = pathToFileURL(backupPath);
    immutableLocation.searchParams.set("immutable", "1");
    const source = new DatabaseSync(immutableLocation, { readOnly: true });
    try {
      await backup(source, databasePath);
    } finally {
      source.close();
    }

    const restored = validateSqliteBackup(databasePath);
    if (
      restored.databaseIdentity.applicationId !== manifest.sourceDatabase.applicationId ||
      restored.databaseIdentity.schemaVersion !== manifest.schemaVersion ||
      !restored.integrity.ok
    ) {
      throw new SqliteRestoreError(
        "SQLITE_RESTORE_FAILED",
        "restored SQLite database failed identity or integrity validation",
      );
    }
    writeMarker(markerPath, "complete");
    return Object.freeze({ restoreRoot, databasePath, markerPath, manifest });
  } catch (error) {
    if (rootCreated) {
      try {
        writeMarker(
          markerPath,
          "failed",
          error instanceof SqliteRestoreError ? error.code : "SQLITE_RESTORE_FAILED",
        );
      } catch {
        // Preserve the original restore error and never recursively remove the root.
      }
    }
    if (error instanceof SqliteRestoreError) throw error;
    throw new SqliteRestoreError("SQLITE_RESTORE_FAILED", "isolated SQLite restore failed", {
      cause: error,
    });
  }
}
