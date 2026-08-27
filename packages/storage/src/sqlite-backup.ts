import { createHash } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { verifySqliteIntegrity, type SqliteIntegrityReport } from "./sqlite.js";

export type SqliteBackupErrorCode =
  | "SQLITE_BACKUP_CONFIGURATION_INVALID"
  | "SQLITE_BACKUP_TARGET_EXISTS"
  | "SQLITE_BACKUP_SOURCE_INVALID"
  | "SQLITE_BACKUP_INVALID";

export class SqliteBackupError extends Error {
  constructor(
    readonly code: SqliteBackupErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SqliteBackupError";
  }
}

export interface SqliteBackupDatabaseIdentity {
  readonly applicationId: number;
  readonly schemaVersion: number;
}

export interface SqliteBackupManifest {
  readonly manifestVersion: 1;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly sourceDatabase: SqliteBackupDatabaseIdentity;
  readonly backup: {
    readonly sizeBytes: number;
    readonly sha256: string;
  };
  readonly integrity: {
    readonly ok: boolean;
    readonly integrityMessages: readonly string[];
    readonly foreignKeyViolations: readonly Record<string, unknown>[];
  };
}

export interface SqliteOnlineBackupOptions {
  /** The already-open worker-owned SQLite connection to snapshot. */
  readonly source: DatabaseSync;
  /** Absolute destination path for the new backup database. */
  readonly targetPath: string;
  /** Timestamp supplied by the caller for deterministic evidence; defaults to now. */
  readonly createdAt?: string;
}

export type CreateSqliteOnlineBackupInput = Omit<SqliteOnlineBackupOptions, "source">;

export interface SqliteBackupValidation {
  readonly databaseIdentity: SqliteBackupDatabaseIdentity;
  readonly integrity: SqliteIntegrityReport;
}

export interface SqliteOnlineBackupResult {
  readonly backupPath: string;
  readonly manifestPath: string;
  readonly manifest: SqliteBackupManifest;
}

function requireAbsolutePath(value: string, field: string): string {
  if (!isAbsolute(value) || value.trim().length === 0) {
    throw new SqliteBackupError(
      "SQLITE_BACKUP_CONFIGURATION_INVALID",
      `${field} must be a non-empty absolute path`,
    );
  }
  return value;
}

function integerPragma(database: DatabaseSync, pragma: string, field: string): number {
  const value = database.prepare(`PRAGMA ${pragma}`).get()?.[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SqliteBackupError("SQLITE_BACKUP_INVALID", `SQLite did not return a valid ${field}`);
  }
  return value;
}

function readDatabaseIdentity(database: DatabaseSync): SqliteBackupDatabaseIdentity {
  return Object.freeze({
    applicationId: integerPragma(database, "application_id", "application_id"),
    schemaVersion: integerPragma(database, "user_version", "user_version"),
  });
}

function readIntegrity(database: DatabaseSync): SqliteIntegrityReport {
  try {
    return verifySqliteIntegrity(database);
  } catch (error) {
    throw new SqliteBackupError(
      "SQLITE_BACKUP_INVALID",
      "SQLite backup integrity validation failed",
      { cause: error },
    );
  }
}

function assertIntegrity(
  integrity: SqliteIntegrityReport,
  code: "SQLITE_BACKUP_SOURCE_INVALID" | "SQLITE_BACKUP_INVALID",
): void {
  if (!integrity.ok) {
    throw new SqliteBackupError(code, "SQLite integrity_check or foreign_key_check did not pass");
  }
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function reserveNewFile(filePath: string): void {
  try {
    const handle = openSync(filePath, "wx");
    closeSync(handle);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SqliteBackupError(
        "SQLITE_BACKUP_TARGET_EXISTS",
        "SQLite backup target already exists",
        { cause: error },
      );
    }
    throw new SqliteBackupError(
      "SQLITE_BACKUP_CONFIGURATION_INVALID",
      "SQLite backup target could not be created",
      { cause: error },
    );
  }
}

function cloneIntegrity(integrity: SqliteIntegrityReport): SqliteBackupManifest["integrity"] {
  return Object.freeze({
    ok: integrity.ok,
    integrityMessages: Object.freeze([...integrity.integrityMessages]),
    foreignKeyViolations: Object.freeze(
      integrity.foreignKeyViolations.map((violation) => Object.freeze({ ...violation })),
    ),
  });
}

/**
 * Validate an existing SQLite backup without mutating it.
 *
 * Opening and checking the database is deliberately the restore admission gate: a
 * malformed or foreign-key-invalid file is rejected before any restore operation
 * can consume it.
 */
export function validateSqliteBackup(backupPath: string): SqliteBackupValidation {
  const absolutePath = requireAbsolutePath(backupPath, "backupPath");
  if (!existsSync(absolutePath)) {
    throw new SqliteBackupError("SQLITE_BACKUP_INVALID", "SQLite backup file does not exist");
  }

  let database: DatabaseSync | undefined;
  try {
    const immutableLocation = pathToFileURL(absolutePath);
    immutableLocation.searchParams.set("immutable", "1");
    database = new DatabaseSync(immutableLocation, { readOnly: true });
    const databaseIdentity = readDatabaseIdentity(database);
    const integrity = readIntegrity(database);
    assertIntegrity(integrity, "SQLITE_BACKUP_INVALID");
    return Object.freeze({ databaseIdentity, integrity });
  } catch (error) {
    if (error instanceof SqliteBackupError) throw error;
    throw new SqliteBackupError(
      "SQLITE_BACKUP_INVALID",
      "SQLite backup could not be opened or validated",
      { cause: error },
    );
  } finally {
    database?.close();
  }
}

/**
 * Take an online SQLite backup from the worker-owned connection and emit a
 * sidecar manifest. The target and manifest are both create-only; no existing
 * file is ever overwritten by this helper.
 */
export async function createSqliteOnlineBackup(
  options: SqliteOnlineBackupOptions,
): Promise<SqliteOnlineBackupResult> {
  const targetPath = requireAbsolutePath(options.targetPath, "targetPath");
  const manifestPath = `${targetPath}.manifest.json`;
  const createdAt = options.createdAt ?? new Date().toISOString();
  let canonicalCreatedAt: string;
  try {
    canonicalCreatedAt = new Date(createdAt).toISOString();
  } catch {
    throw new SqliteBackupError(
      "SQLITE_BACKUP_CONFIGURATION_INVALID",
      "createdAt must be a canonical UTC ISO-8601 timestamp",
    );
  }
  if (createdAt !== canonicalCreatedAt) {
    throw new SqliteBackupError(
      "SQLITE_BACKUP_CONFIGURATION_INVALID",
      "createdAt must be a canonical UTC ISO-8601 timestamp",
    );
  }
  if (existsSync(targetPath) || existsSync(manifestPath)) {
    throw new SqliteBackupError(
      "SQLITE_BACKUP_TARGET_EXISTS",
      "SQLite backup target or manifest already exists",
    );
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  const sourceDatabase = readDatabaseIdentity(options.source);
  const sourceIntegrity = readIntegrity(options.source);
  assertIntegrity(sourceIntegrity, "SQLITE_BACKUP_SOURCE_INVALID");

  reserveNewFile(targetPath);
  let manifestReserved = false;
  let completed = false;
  try {
    await backup(options.source, targetPath);
    const validation = validateSqliteBackup(targetPath);
    if (
      validation.databaseIdentity.applicationId !== sourceDatabase.applicationId ||
      validation.databaseIdentity.schemaVersion !== sourceDatabase.schemaVersion
    ) {
      throw new SqliteBackupError(
        "SQLITE_BACKUP_INVALID",
        "SQLite backup identity does not match the source database",
      );
    }

    const stat = statSync(targetPath);
    const manifest: SqliteBackupManifest = Object.freeze({
      manifestVersion: 1,
      schemaVersion: sourceDatabase.schemaVersion,
      createdAt,
      sourceDatabase,
      backup: Object.freeze({
        sizeBytes: stat.size,
        sha256: sha256File(targetPath),
      }),
      integrity: cloneIntegrity(validation.integrity),
    });

    reserveNewFile(manifestPath);
    manifestReserved = true;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
    });
    completed = true;
    return Object.freeze({ backupPath: targetPath, manifestPath, manifest });
  } catch (error) {
    if (error instanceof SqliteBackupError) throw error;
    throw new SqliteBackupError("SQLITE_BACKUP_INVALID", "SQLite online backup failed", {
      cause: error,
    });
  } finally {
    if (!completed) {
      rmSync(targetPath, { force: true });
      if (manifestReserved) rmSync(manifestPath, { force: true });
    }
  }
}

export function backupManifestFileName(backupPath: string): string {
  return `${basename(requireAbsolutePath(backupPath, "backupPath"))}.manifest.json`;
}

export function backupFileSha256(backupPath: string): string {
  return sha256File(requireAbsolutePath(backupPath, "backupPath"));
}
