import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { QA_HUB_SQLITE_APPLICATION_ID } from "./sqlite.js";

export type AttachmentRestoreErrorCode =
  | "ATTACHMENT_RESTORE_CONFIGURATION_INVALID"
  | "ATTACHMENT_RESTORE_ROOT_EXISTS"
  | "ATTACHMENT_RESTORE_DATABASE_INVALID"
  | "ATTACHMENT_RESTORE_SOURCE_INVALID"
  | "ATTACHMENT_RESTORE_FAILED";

export class AttachmentRestoreError extends Error {
  constructor(
    readonly code: AttachmentRestoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AttachmentRestoreError";
  }
}

export interface AttachmentInventoryEntry {
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface AttachmentInventoryManifest {
  readonly manifestVersion: 1;
  readonly createdAt: string;
  readonly sourceDatabase: {
    readonly applicationId: number;
    readonly schemaVersion: number;
  };
  readonly entries: readonly AttachmentInventoryEntry[];
}

export interface RestoreReferencedAttachmentsOptions {
  /** Read-only QA Hub SQLite database whose ready attachment facts define the inventory. */
  readonly databasePath: string;
  /** Existing content-addressed evidence root. */
  readonly evidenceRoot: string;
  /** New, non-existent directory that will become an isolated evidence root. */
  readonly restoreRoot: string;
  readonly createdAt?: string;
  readonly maxEntries?: number;
}

export interface RestoreReferencedAttachmentsResult {
  readonly restoreRoot: string;
  readonly manifestPath: string;
  readonly completeMarkerPath: string;
  readonly manifestSha256: string;
  readonly manifest: AttachmentInventoryManifest;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_MAX_ENTRIES = 100_000;
const MANIFEST_FILE = ".qa-hub-attachment-inventory.json";
const COMPLETE_MARKER_FILE = ".qa-hub-attachment-restore.complete.json";
const FAILED_MARKER_FILE = ".qa-hub-attachment-restore.failed.json";

function requireAbsolutePath(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || !isAbsolute(value)) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_CONFIGURATION_INVALID",
      `${field} must be a non-empty absolute path`,
    );
  }
  return value;
}

function canonicalCreatedAt(value: string | undefined): string {
  const candidate = value ?? new Date().toISOString();
  let canonical: string;
  try {
    canonical = new Date(candidate).toISOString();
  } catch (error) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_CONFIGURATION_INVALID",
      "createdAt must be a canonical UTC ISO-8601 timestamp",
      { cause: error },
    );
  }
  if (candidate !== canonical) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_CONFIGURATION_INVALID",
      "createdAt must be a canonical UTC ISO-8601 timestamp",
    );
  }
  return canonical;
}

function requireMaxEntries(value: number | undefined): number {
  const candidate = value ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_MAX_ENTRIES) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_CONFIGURATION_INVALID",
      `maxEntries must be an integer between 1 and ${MAX_MAX_ENTRIES}`,
    );
  }
  return candidate;
}

function isContained(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function isSameOrContained(root: string, candidate: string): boolean {
  return relative(root, candidate).length === 0 || isContained(root, candidate);
}

function resolveStorageKey(root: string, storageKey: string): string {
  if (
    storageKey.length < 1 ||
    storageKey.length > 1000 ||
    storageKey.includes("\0") ||
    isAbsolute(storageKey)
  ) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_DATABASE_INVALID",
      "attachment storage key is invalid",
    );
  }
  const resolvedRoot = resolve(root);
  const resolvedFile = resolve(resolvedRoot, storageKey);
  if (!isContained(resolvedRoot, resolvedFile)) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_DATABASE_INVALID",
      "attachment storage key escapes the evidence root",
    );
  }
  return resolvedFile;
}

function safeNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_DATABASE_INVALID",
      `${field} must be a non-negative integer`,
    );
  }
  return value;
}

function readDatabaseIdentity(database: DatabaseSync): {
  readonly applicationId: number;
  readonly schemaVersion: number;
} {
  const applicationId = safeNonNegativeInteger(
    database.prepare("PRAGMA application_id").get()?.["application_id"],
    "application ID",
  );
  const schemaVersion = safeNonNegativeInteger(
    database.prepare("PRAGMA user_version").get()?.["user_version"],
    "schema version",
  );
  if (applicationId !== QA_HUB_SQLITE_APPLICATION_ID || schemaVersion < 1) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_DATABASE_INVALID",
      "attachment inventory source is not a QA Hub database",
    );
  }
  return Object.freeze({ applicationId, schemaVersion });
}

function readInventory(
  databasePath: string,
  createdAt: string,
  maxEntries: number,
): AttachmentInventoryManifest {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
  } catch (error) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_DATABASE_INVALID",
      "attachment inventory database could not be opened read-only",
      { cause: error },
    );
  }
  try {
    const sourceDatabase = readDatabaseIdentity(database);
    const rows = database
      .prepare(
        `SELECT DISTINCT blob.storage_key, blob.size_bytes, blob.sha256
         FROM attachments AS attachment
         JOIN blobs AS blob
           ON blob.account_id = attachment.account_id
          AND blob.id = attachment.blob_id
         WHERE attachment.status = 'ready'
           AND attachment.scan_state = 'clean'
           AND blob.state = 'ready'
         ORDER BY blob.storage_key
         LIMIT ?`,
      )
      .all(maxEntries + 1);
    if (rows.length > maxEntries) {
      throw new AttachmentRestoreError(
        "ATTACHMENT_RESTORE_DATABASE_INVALID",
        `attachment inventory exceeds the configured ${maxEntries}-entry limit`,
      );
    }
    const entries = rows.map((row): AttachmentInventoryEntry => {
      const storageKey = row["storage_key"];
      const sha256 = row["sha256"];
      if (
        typeof storageKey !== "string" ||
        typeof sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(sha256)
      ) {
        throw new AttachmentRestoreError(
          "ATTACHMENT_RESTORE_DATABASE_INVALID",
          "attachment inventory contains invalid storage metadata",
        );
      }
      const sizeBytes = safeNonNegativeInteger(row["size_bytes"], "attachment size");
      if (sizeBytes < 1) {
        throw new AttachmentRestoreError(
          "ATTACHMENT_RESTORE_DATABASE_INVALID",
          "attachment inventory contains an empty blob",
        );
      }
      return Object.freeze({ storageKey, sizeBytes, sha256 });
    });
    return Object.freeze({
      manifestVersion: 1,
      createdAt,
      sourceDatabase,
      entries: Object.freeze(entries),
    });
  } catch (error) {
    if (error instanceof AttachmentRestoreError) throw error;
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_DATABASE_INVALID",
      "attachment inventory could not be read from the QA Hub database",
      { cause: error },
    );
  } finally {
    database.close();
  }
}

async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeFailedMarker(restoreRoot: string, error: unknown): void {
  try {
    writeFileSync(
      join(restoreRoot, FAILED_MARKER_FILE),
      jsonFile({
        markerVersion: 1,
        operation: "isolated-attachment-restore",
        state: "failed",
        errorCode:
          error instanceof AttachmentRestoreError ? error.code : "ATTACHMENT_RESTORE_FAILED",
      }),
      { encoding: "utf8", flag: "wx" },
    );
  } catch {
    // Preserve the original failure and never recursively remove the partial restore root.
  }
}

async function copyAndVerifyEntry(
  sourceRoot: string,
  restoreRoot: string,
  entry: AttachmentInventoryEntry,
): Promise<void> {
  const sourcePath = resolveStorageKey(sourceRoot, entry.storageKey);
  const targetPath = resolveStorageKey(restoreRoot, entry.storageKey);
  let realSourcePath: string;
  try {
    const realSourceRoot = realpathSync(sourceRoot);
    realSourcePath = realpathSync(sourcePath);
    if (!isContained(realSourceRoot, realSourcePath)) {
      throw new Error("source resolves outside evidence root");
    }
    const sourceStat = statSync(realSourcePath);
    if (
      !sourceStat.isFile() ||
      sourceStat.size !== entry.sizeBytes ||
      (await fileSha256(realSourcePath)) !== entry.sha256
    ) {
      throw new Error("source size or hash mismatch");
    }
  } catch (error) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_SOURCE_INVALID",
      `attachment source is missing or does not match inventory: ${entry.storageKey}`,
      { cause: error },
    );
  }
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(realSourcePath, targetPath, constants.COPYFILE_EXCL);
  } catch (error) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_FAILED",
      `attachment could not be copied into the isolated root: ${entry.storageKey}`,
      { cause: error },
    );
  }
  try {
    const targetStat = statSync(targetPath);
    if (
      !targetStat.isFile() ||
      targetStat.size !== entry.sizeBytes ||
      (await fileSha256(targetPath)) !== entry.sha256
    ) {
      throw new Error("restored size or hash mismatch");
    }
  } catch (error) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_FAILED",
      `restored attachment failed verification: ${entry.storageKey}`,
      { cause: error },
    );
  }
}

/**
 * Restore all ready/clean attachment blobs referenced by a QA Hub SQLite snapshot.
 *
 * This is deliberately an offline operations helper, not an HTTP API. The destination root is
 * create-only. Partial failures retain their manifest and a failed marker and are never deleted.
 */
export async function restoreReferencedAttachmentsToIsolatedRoot(
  options: RestoreReferencedAttachmentsOptions,
): Promise<RestoreReferencedAttachmentsResult> {
  const databasePath = requireAbsolutePath(options.databasePath, "databasePath");
  const evidenceRoot = requireAbsolutePath(options.evidenceRoot, "evidenceRoot");
  const restoreRoot = requireAbsolutePath(options.restoreRoot, "restoreRoot");
  const createdAt = canonicalCreatedAt(options.createdAt);
  const maxEntries = requireMaxEntries(options.maxEntries);
  const resolvedRestoreRoot = resolve(restoreRoot);
  if (
    isSameOrContained(resolve(evidenceRoot), resolvedRestoreRoot) ||
    isSameOrContained(resolve(dirname(databasePath)), resolvedRestoreRoot)
  ) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_CONFIGURATION_INVALID",
      "isolated attachment restore root must be outside source data directories",
    );
  }
  if (existsSync(restoreRoot)) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_ROOT_EXISTS",
      "isolated attachment restore root must not already exist",
    );
  }
  try {
    if (!statSync(databasePath).isFile() || !statSync(evidenceRoot).isDirectory()) {
      throw new Error("source database or evidence root has the wrong type");
    }
  } catch (error) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_CONFIGURATION_INVALID",
      "source database and evidence root must exist",
      { cause: error },
    );
  }

  const manifest = readInventory(databasePath, createdAt, maxEntries);
  const manifestContent = jsonFile(manifest);
  const manifestSha256 = createHash("sha256").update(manifestContent).digest("hex");
  const manifestPath = join(restoreRoot, MANIFEST_FILE);
  const completeMarkerPath = join(restoreRoot, COMPLETE_MARKER_FILE);
  let rootCreated = false;
  try {
    mkdirSync(restoreRoot);
    rootCreated = true;
    writeFileSync(manifestPath, manifestContent, { encoding: "utf8", flag: "wx" });
    for (const entry of manifest.entries) {
      await copyAndVerifyEntry(evidenceRoot, restoreRoot, entry);
    }
    writeFileSync(
      completeMarkerPath,
      jsonFile({
        markerVersion: 1,
        operation: "isolated-attachment-restore",
        state: "complete",
        manifestSha256,
        entryCount: manifest.entries.length,
      }),
      { encoding: "utf8", flag: "wx" },
    );
    return Object.freeze({
      restoreRoot,
      manifestPath,
      completeMarkerPath,
      manifestSha256,
      manifest,
    });
  } catch (error) {
    if (rootCreated) writeFailedMarker(restoreRoot, error);
    if (error instanceof AttachmentRestoreError) throw error;
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_FAILED",
      "isolated attachment restore failed",
      { cause: error },
    );
  }
}
