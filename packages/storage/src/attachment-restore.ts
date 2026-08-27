import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

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

export interface ValidateReferencedAttachmentRootOptions {
  /** Read-only QA Hub SQLite backup whose ready attachment facts define the inventory. */
  readonly databasePath: string;
  /** Existing evidence root produced by an isolated attachment restore. */
  readonly evidenceRoot: string;
  /** Timestamp that must match the inventory manifest exactly. */
  readonly createdAt: string;
  readonly maxEntries?: number;
}

export interface ReferencedAttachmentRootValidation {
  readonly evidenceRoot: string;
  readonly manifestPath: string;
  readonly completeMarkerPath: string;
  readonly manifestSha256: string;
  readonly completeMarkerSha256: string;
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
    const immutableLocation = pathToFileURL(databasePath);
    immutableLocation.searchParams.set("immutable", "1");
    database = new DatabaseSync(immutableLocation, { readOnly: true });
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
      const canonicalStorageKey = `sha256/${sha256.slice(0, 2)}/${sha256}`;
      if (storageKey.replaceAll("\\", "/") !== canonicalStorageKey) {
        throw new AttachmentRestoreError(
          "ATTACHMENT_RESTORE_DATABASE_INVALID",
          "attachment inventory contains a non-canonical content-addressed storage key",
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

function bytesSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
  const realSourcePath = await verifyBlobAtRoot(
    sourceRoot,
    entry,
    "ATTACHMENT_RESTORE_SOURCE_INVALID",
    "attachment source is missing or does not match inventory",
  );
  const targetPath = resolveStorageKey(restoreRoot, entry.storageKey);
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    // Stream the payload with create-only destination semantics. Windows can
    // route CopyFile through an offload/block-clone path on ReFS; on the live
    // archive disk that path can stall for minutes even for small attachments.
    // A bounded userspace stream retains the same fail-closed verification
    // below without depending on the volume's copy-offload implementation.
    await pipeline(
      createReadStream(realSourcePath),
      createWriteStream(targetPath, { flags: "wx" }),
    );
  } catch (error) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_FAILED",
      `attachment could not be copied into the isolated root: ${entry.storageKey}`,
      { cause: error },
    );
  }
  try {
    await verifyBlobAtRoot(
      restoreRoot,
      entry,
      "ATTACHMENT_RESTORE_FAILED",
      "restored attachment failed verification",
    );
  } catch (error) {
    if (error instanceof AttachmentRestoreError && error.code === "ATTACHMENT_RESTORE_FAILED") {
      throw error;
    }
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_FAILED",
      `restored attachment failed verification: ${entry.storageKey}`,
      { cause: error },
    );
  }
}

async function verifyBlobAtRoot(
  root: string,
  entry: AttachmentInventoryEntry,
  errorCode: "ATTACHMENT_RESTORE_SOURCE_INVALID" | "ATTACHMENT_RESTORE_FAILED",
  message: string,
): Promise<string> {
  try {
    const candidatePath = resolveStorageKey(root, entry.storageKey);
    const resolvedRoot = resolve(root);
    const resolvedCandidate = resolve(candidatePath);
    if (!isContained(resolvedRoot, resolvedCandidate)) {
      throw new Error("blob path escapes evidence root");
    }
    const candidateLstat = lstatSync(resolvedCandidate);
    if (candidateLstat.isSymbolicLink() || !candidateLstat.isFile()) {
      throw new Error("blob is not an ordinary file");
    }
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(resolvedCandidate);
    if (!isContained(realRoot, realCandidate)) {
      throw new Error("blob resolves outside evidence root");
    }
    const realCandidateLstat = lstatSync(realCandidate);
    if (realCandidateLstat.isSymbolicLink() || !realCandidateLstat.isFile()) {
      throw new Error("blob is not an ordinary file");
    }
    if (
      realCandidateLstat.size !== entry.sizeBytes ||
      (await fileSha256(realCandidate)) !== entry.sha256
    ) {
      throw new Error("blob size or hash mismatch");
    }
    return realCandidate;
  } catch (error) {
    throw new AttachmentRestoreError(errorCode, `${message}: ${entry.storageKey}`, {
      cause: error,
    });
  }
}

function readValidatedTargetFile(evidenceRoot: string, filePath: string, label: string): Buffer {
  try {
    const realFilePath = verifyOrdinaryContainedFile(evidenceRoot, filePath);
    return readFileSync(realFilePath);
  } catch (error) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_SOURCE_INVALID",
      `${label} is missing or is not an ordinary file`,
      { cause: error },
    );
  }
}

function verifyOrdinaryContainedFile(root: string, filePath: string): string {
  const resolvedRoot = resolve(root);
  const resolvedFile = resolve(filePath);
  if (!isContained(resolvedRoot, resolvedFile)) {
    throw new Error("file escapes evidence root");
  }
  const fileLstat = lstatSync(resolvedFile);
  if (fileLstat.isSymbolicLink() || !fileLstat.isFile()) {
    throw new Error("file is not an ordinary file");
  }
  const realRoot = realpathSync(root);
  const realFile = realpathSync(resolvedFile);
  if (!isContained(realRoot, realFile)) {
    throw new Error("file resolves outside evidence root");
  }
  const realFileLstat = lstatSync(realFile);
  if (realFileLstat.isSymbolicLink() || !realFileLstat.isFile()) {
    throw new Error("file is not an ordinary file");
  }
  return realFile;
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
  const requestedDatabasePath = requireAbsolutePath(options.databasePath, "databasePath");
  const requestedEvidenceRoot = requireAbsolutePath(options.evidenceRoot, "evidenceRoot");
  const requestedRestoreRoot = requireAbsolutePath(options.restoreRoot, "restoreRoot");
  const createdAt = canonicalCreatedAt(options.createdAt);
  const maxEntries = requireMaxEntries(options.maxEntries);
  if (existsSync(requestedRestoreRoot)) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_ROOT_EXISTS",
      "isolated attachment restore root must not already exist",
    );
  }
  let databasePath: string;
  let evidenceRoot: string;
  let restoreRoot: string;
  try {
    if (
      !statSync(requestedDatabasePath).isFile() ||
      !statSync(requestedEvidenceRoot).isDirectory()
    ) {
      throw new Error("source database or evidence root has the wrong type");
    }
    databasePath = realpathSync(requestedDatabasePath);
    evidenceRoot = realpathSync(requestedEvidenceRoot);
    const restoreParent = realpathSync(dirname(requestedRestoreRoot));
    restoreRoot = join(restoreParent, basename(requestedRestoreRoot));
  } catch (error) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_CONFIGURATION_INVALID",
      "source database, evidence root, and restore parent must exist",
      { cause: error },
    );
  }
  if (
    isSameOrContained(evidenceRoot, restoreRoot) ||
    isSameOrContained(dirname(databasePath), restoreRoot)
  ) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_CONFIGURATION_INVALID",
      "isolated attachment restore root must be outside canonical source data directories",
    );
  }
  if (existsSync(restoreRoot)) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_ROOT_EXISTS",
      "isolated attachment restore root must not already exist",
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

/**
 * Validate a completed isolated attachment restore without changing any source or target bytes.
 *
 * The inventory is always recomputed from the supplied SQLite backup. A root is accepted only
 * when its manifest bytes and complete marker are the exact create-only outputs expected for that
 * inventory, and every referenced blob is still an ordinary, contained file with the recorded
 * size and SHA-256.
 */
export async function validateReferencedAttachmentRoot(
  options: ValidateReferencedAttachmentRootOptions,
): Promise<ReferencedAttachmentRootValidation> {
  const requestedDatabasePath = requireAbsolutePath(options.databasePath, "databasePath");
  const requestedEvidenceRoot = requireAbsolutePath(options.evidenceRoot, "evidenceRoot");
  const createdAt = canonicalCreatedAt(options.createdAt);
  const maxEntries = requireMaxEntries(options.maxEntries);

  let databasePath: string;
  try {
    if (!statSync(requestedDatabasePath).isFile()) {
      throw new Error("source database is not a file");
    }
    databasePath = realpathSync(requestedDatabasePath);
  } catch (error) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_DATABASE_INVALID",
      "attachment inventory database could not be resolved",
      { cause: error },
    );
  }

  let evidenceRoot: string;
  try {
    if (!statSync(requestedEvidenceRoot).isDirectory()) {
      throw new Error("evidence root is not a directory");
    }
    evidenceRoot = realpathSync(requestedEvidenceRoot);
  } catch (error) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_SOURCE_INVALID",
      "attachment evidence root could not be resolved",
      { cause: error },
    );
  }

  // Keep all database identity and inventory failures in readInventory's DATABASE_INVALID class.
  const manifest = readInventory(databasePath, createdAt, maxEntries);
  const expectedManifestBytes = Buffer.from(jsonFile(manifest), "utf8");
  const manifestPath = join(evidenceRoot, MANIFEST_FILE);
  const completeMarkerPath = join(evidenceRoot, COMPLETE_MARKER_FILE);
  const manifestBytes = readValidatedTargetFile(
    evidenceRoot,
    manifestPath,
    "attachment inventory manifest",
  );
  if (!manifestBytes.equals(expectedManifestBytes)) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_SOURCE_INVALID",
      "attachment inventory manifest bytes do not match the backup database inventory",
    );
  }
  const manifestSha256 = bytesSha256(manifestBytes);

  const expectedCompleteMarker = {
    markerVersion: 1,
    operation: "isolated-attachment-restore",
    state: "complete",
    manifestSha256,
    entryCount: manifest.entries.length,
  };
  const expectedCompleteMarkerBytes = Buffer.from(jsonFile(expectedCompleteMarker), "utf8");
  const completeMarkerBytes = readValidatedTargetFile(
    evidenceRoot,
    completeMarkerPath,
    "attachment restore complete marker",
  );
  if (!completeMarkerBytes.equals(expectedCompleteMarkerBytes)) {
    throw new AttachmentRestoreError(
      "ATTACHMENT_RESTORE_SOURCE_INVALID",
      "attachment restore complete marker is missing, malformed, or does not match its manifest",
    );
  }
  const completeMarkerSha256 = bytesSha256(completeMarkerBytes);

  for (const entry of manifest.entries) {
    await verifyBlobAtRoot(
      evidenceRoot,
      entry,
      "ATTACHMENT_RESTORE_SOURCE_INVALID",
      "attachment evidence blob is missing or does not match inventory",
    );
  }

  return Object.freeze({
    evidenceRoot,
    manifestPath,
    completeMarkerPath,
    manifestSha256,
    completeMarkerSha256,
    manifest,
  });
}
