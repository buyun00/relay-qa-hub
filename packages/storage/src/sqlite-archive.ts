import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  restoreReferencedAttachmentsToIsolatedRoot,
  validateReferencedAttachmentRoot,
} from "./attachment-restore.js";
import { backupFileSha256, type SqliteBackupManifest } from "./sqlite-backup.js";
import { validateSqliteBackupBundle } from "./sqlite-restore.js";

const ARCHIVE_COPY_BUFFER_BYTES = 1024 * 1024;

function copyFileCreateOnlyBuffered(sourcePath: string, targetPath: string): void {
  const source = openSync(sourcePath, "r");
  let target: number | undefined;
  try {
    target = openSync(targetPath, "wx");
    const buffer = Buffer.allocUnsafe(ARCHIVE_COPY_BUFFER_BYTES);
    for (;;) {
      const bytesRead = readSync(source, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        const bytesWritten = writeSync(target, buffer, offset, bytesRead - offset, null);
        if (bytesWritten < 1) throw new Error("archive copy made no forward progress");
        offset += bytesWritten;
      }
    }
  } finally {
    if (target !== undefined) closeSync(target);
    closeSync(source);
  }
}

export type SqliteArchiveErrorCode =
  | "SQLITE_ARCHIVE_CONFIGURATION_INVALID"
  | "SQLITE_ARCHIVE_SOURCE_INVALID"
  | "SQLITE_ARCHIVE_TARGET_PARTIAL"
  | "SQLITE_ARCHIVE_TARGET_MISMATCH"
  | "SQLITE_ARCHIVE_COPY_FAILED";

export class SqliteArchiveError extends Error {
  constructor(
    readonly code: SqliteArchiveErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SqliteArchiveError";
  }
}

export interface ArchiveSqliteBackupBundleOptions {
  readonly backupPath: string;
  readonly manifestPath?: string;
  readonly archiveRoot: string;
}

export interface SqliteBackupArchiveResult {
  readonly disposition: "created" | "existing";
  readonly archiveRoot: string;
  readonly backupPath: string;
  readonly manifestPath: string;
  readonly manifest: SqliteBackupManifest;
  readonly backupSha256: string;
  readonly manifestSha256: string;
}

function requireAbsolutePath(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_CONFIGURATION_INVALID",
      `${field} must be an absolute path`,
    );
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
      throw new SqliteArchiveError(
        "SQLITE_ARCHIVE_CONFIGURATION_INVALID",
        `${field} has no resolvable existing ancestor`,
      );
    }
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  try {
    return resolve(realpathSync.native(existingAncestor), ...missingSegments);
  } catch (error) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_CONFIGURATION_INVALID",
      `${field} could not be resolved`,
      { cause: error },
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

function requireOrdinaryFile(filePath: string, field: string): string {
  const absolutePath = requireAbsolutePath(filePath, field);
  try {
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new SqliteArchiveError(
        "SQLITE_ARCHIVE_SOURCE_INVALID",
        `${field} must be an ordinary file`,
      );
    }
    return realpathSync.native(absolutePath);
  } catch (error) {
    if (error instanceof SqliteArchiveError) throw error;
    throw new SqliteArchiveError("SQLITE_ARCHIVE_SOURCE_INVALID", `${field} is unavailable`, {
      cause: error,
    });
  }
}

function ensurePlainDirectory(directory: string, field: string, recursive: boolean): string {
  try {
    mkdirSync(directory, { recursive });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new SqliteArchiveError(
        "SQLITE_ARCHIVE_CONFIGURATION_INVALID",
        `${field} could not be created`,
        { cause: error },
      );
    }
  }
  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new SqliteArchiveError(
        "SQLITE_ARCHIVE_CONFIGURATION_INVALID",
        `${field} must be an ordinary directory`,
      );
    }
    return realpathSync.native(directory);
  } catch (error) {
    if (error instanceof SqliteArchiveError) throw error;
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_CONFIGURATION_INVALID",
      `${field} could not be verified`,
      { cause: error },
    );
  }
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function validateArchivedPair(
  backupPath: string,
  manifestPath: string,
  sourceManifest: SqliteBackupManifest,
  sourceManifestSha256: string,
): { readonly backupSha256: string; readonly manifestSha256: string } {
  const canonicalBackupPath = requireOrdinaryFile(backupPath, "archive backup");
  const canonicalManifestPath = requireOrdinaryFile(manifestPath, "archive manifest");
  if (!pathsEqual(dirname(canonicalBackupPath), dirname(canonicalManifestPath))) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "archive database and manifest must share one directory",
    );
  }

  let archived;
  try {
    archived = validateSqliteBackupBundle({
      backupPath: canonicalBackupPath,
      manifestPath: canonicalManifestPath,
    });
  } catch (error) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "archive database and manifest failed strict validation",
      { cause: error },
    );
  }
  const backupSha256 = backupFileSha256(canonicalBackupPath);
  const manifestSha256 = sha256File(canonicalManifestPath);
  if (
    backupSha256 !== sourceManifest.backup.sha256 ||
    manifestSha256 !== sourceManifestSha256 ||
    archived.manifest.createdAt !== sourceManifest.createdAt
  ) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "archive database or manifest does not match its source recovery point",
    );
  }
  return Object.freeze({ backupSha256, manifestSha256 });
}

/**
 * Copy one strictly validated recovery point into a create-only archive root.
 * The manifest is published last; this helper never deletes or overwrites files.
 */
export function archiveSqliteBackupBundle(
  options: ArchiveSqliteBackupBundleOptions,
): SqliteBackupArchiveResult {
  const sourceBackupPath = requireOrdinaryFile(options.backupPath, "backupPath");
  const sourceManifestPath = requireOrdinaryFile(
    options.manifestPath ?? `${sourceBackupPath}.manifest.json`,
    "manifestPath",
  );
  if (!pathsEqual(dirname(sourceBackupPath), dirname(sourceManifestPath))) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_SOURCE_INVALID",
      "source database and manifest must share one directory",
    );
  }

  const backupName = basename(sourceBackupPath);
  if (
    !backupName.endsWith(".sqlite") ||
    basename(sourceManifestPath) !== `${backupName}.manifest.json`
  ) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_SOURCE_INVALID",
      "source manifest must be the exact sidecar for its SQLite database",
    );
  }

  let source;
  try {
    source = validateSqliteBackupBundle({
      backupPath: sourceBackupPath,
      manifestPath: sourceManifestPath,
    });
  } catch (error) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_SOURCE_INVALID",
      "source recovery point failed strict validation",
      { cause: error },
    );
  }
  const sourceManifestSha256 = sha256File(sourceManifestPath);

  const requestedArchiveRoot = requireAbsolutePath(options.archiveRoot, "archiveRoot");
  const resolvedArchiveRoot = canonicalizePotentialPath(requestedArchiveRoot, "archiveRoot");
  if (!pathsEqual(resolvedArchiveRoot, requestedArchiveRoot)) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_CONFIGURATION_INVALID",
      "archiveRoot must not resolve through a junction or symbolic link",
    );
  }
  if (pathsOverlap(resolvedArchiveRoot, dirname(sourceBackupPath))) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_CONFIGURATION_INVALID",
      "archiveRoot must not overlap the source recovery point directory",
    );
  }
  const canonicalArchiveRoot = ensurePlainDirectory(requestedArchiveRoot, "archiveRoot", true);
  if (!pathsEqual(canonicalArchiveRoot, requestedArchiveRoot)) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_CONFIGURATION_INVALID",
      "archiveRoot must not resolve through a junction or symbolic link",
    );
  }
  const archiveRpoRoot = ensurePlainDirectory(
    join(canonicalArchiveRoot, "rpo"),
    "archive rpo root",
    false,
  );
  if (
    !isWithinOrEqual(archiveRpoRoot, canonicalArchiveRoot) ||
    !pathsEqual(dirname(archiveRpoRoot), canonicalArchiveRoot)
  ) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_CONFIGURATION_INVALID",
      "archive rpo root must remain a direct ordinary child of archiveRoot",
    );
  }

  const targetBackupPath = join(archiveRpoRoot, backupName);
  const targetManifestPath = `${targetBackupPath}.manifest.json`;
  const targetBackupExists = existsSync(targetBackupPath);
  const targetManifestExists = existsSync(targetManifestPath);
  if (targetBackupExists !== targetManifestExists) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_PARTIAL",
      "archive target contains an incomplete recovery point",
    );
  }
  if (targetBackupExists && targetManifestExists) {
    const hashes = validateArchivedPair(
      targetBackupPath,
      targetManifestPath,
      source.manifest,
      sourceManifestSha256,
    );
    return Object.freeze({
      disposition: "existing",
      archiveRoot: canonicalArchiveRoot,
      backupPath: targetBackupPath,
      manifestPath: targetManifestPath,
      manifest: source.manifest,
      ...hashes,
    });
  }

  try {
    copyFileCreateOnlyBuffered(sourceBackupPath, targetBackupPath);
    const targetStat = statSync(targetBackupPath);
    if (
      !targetStat.isFile() ||
      targetStat.size !== source.manifest.backup.sizeBytes ||
      backupFileSha256(targetBackupPath) !== source.manifest.backup.sha256
    ) {
      throw new SqliteArchiveError(
        "SQLITE_ARCHIVE_TARGET_MISMATCH",
        "copied archive database failed size or hash validation",
      );
    }
    copyFileCreateOnlyBuffered(sourceManifestPath, targetManifestPath);
    const hashes = validateArchivedPair(
      targetBackupPath,
      targetManifestPath,
      source.manifest,
      sourceManifestSha256,
    );
    return Object.freeze({
      disposition: "created",
      archiveRoot: canonicalArchiveRoot,
      backupPath: targetBackupPath,
      manifestPath: targetManifestPath,
      manifest: source.manifest,
      ...hashes,
    });
  } catch (error) {
    if (error instanceof SqliteArchiveError) throw error;
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_COPY_FAILED",
      "SQLite recovery point could not be copied to archive",
      { cause: error },
    );
  }
}

/**
 * An attachment companion is intentionally a sibling of the archived database,
 * rather than a child of the archive root itself.  Keeping this path derived
 * from the database basename makes it impossible to accidentally pair a
 * recovery point with an attachment root from another cadence.
 */
const ATTACHMENT_ROOT_SUFFIX = ".attachments";
const ATTACHMENT_INVENTORY_FILE = ".qa-hub-attachment-inventory.json";
const ATTACHMENT_COMPLETE_MARKER_FILE = ".qa-hub-attachment-restore.complete.json";
const ATTACHMENT_BINDING_MARKER_FILE = ".qa-hub-sqlite-archive-binding.json";

export interface ArchiveSqliteRecoveryPointWithAttachmentsOptions {
  readonly backupPath: string;
  readonly manifestPath?: string;
  readonly evidenceRoot: string;
  readonly archiveRoot: string;
  readonly maxEntries?: number;
}

export interface ValidateArchivedSqliteRecoveryPointWithAttachmentsOptions {
  readonly backupPath: string;
  readonly manifestPath?: string;
  readonly attachmentRoot?: string;
  readonly maxEntries?: number;
}

export interface SqliteRecoveryPointWithAttachmentsResult {
  readonly disposition: "created" | "existing";
  readonly archiveRoot: string;
  readonly backupPath: string;
  readonly manifestPath: string;
  readonly manifest: SqliteBackupManifest;
  readonly backupSha256: string;
  readonly manifestSha256: string;
  readonly attachmentRoot: string;
  readonly attachmentManifestPath: string;
  readonly attachmentManifestSha256: string;
  readonly attachmentCompleteMarkerPath: string;
  readonly attachmentCompleteMarkerSha256: string;
  readonly attachmentBindingMarkerPath: string;
  readonly attachmentBindingMarkerSha256: string;
  readonly entryCount: number;
}

interface ArchiveAttachmentBinding {
  readonly markerVersion: 1;
  readonly operation: "sqlite-recovery-point-archive-with-attachments";
  readonly state: "complete";
  readonly database: {
    readonly createdAt: string;
    readonly applicationId: number;
    readonly schemaVersion: number;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly manifestSha256: string;
  };
  readonly attachments: {
    readonly inventorySha256: string;
    readonly completeMarkerSha256: string;
    readonly entryCount: number;
  };
}

interface ArchiveAttachmentCompleteMarker {
  readonly markerVersion: 1;
  readonly operation: "isolated-attachment-restore";
  readonly state: "complete";
  readonly manifestSha256: string;
  readonly entryCount: number;
}

function requireExistingOrdinaryDirectory(directoryPath: string, field: string): string {
  const absolutePath = requireAbsolutePath(directoryPath, field);
  try {
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new SqliteArchiveError(
        "SQLITE_ARCHIVE_SOURCE_INVALID",
        `${field} must be an ordinary directory`,
      );
    }
    return realpathSync.native(absolutePath);
  } catch (error) {
    if (error instanceof SqliteArchiveError) throw error;
    throw new SqliteArchiveError("SQLITE_ARCHIVE_SOURCE_INVALID", `${field} is unavailable`, {
      cause: error,
    });
  }
}

function attachmentRootForBackup(backupPath: string): string {
  return join(dirname(backupPath), `${basename(backupPath)}${ATTACHMENT_ROOT_SUFFIX}`);
}

function assertDirectAttachmentSibling(
  backupPath: string,
  attachmentRoot: string,
  code: SqliteArchiveErrorCode,
): string {
  const requestedBackupPath = requireAbsolutePath(backupPath, "backupPath");
  const requestedAttachmentRoot = requireAbsolutePath(attachmentRoot, "attachmentRoot");
  const expected = attachmentRootForBackup(requestedBackupPath);
  if (!pathsEqual(requestedAttachmentRoot, expected)) {
    throw new SqliteArchiveError(
      code,
      "attachment root must be the exact direct sibling derived from the archived database",
    );
  }
  return requestedAttachmentRoot;
}

function assertArchiveRpoLayout(backupPath: string): string {
  const rpoRoot = dirname(backupPath);
  if (basename(rpoRoot) !== "rpo") {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "archived recovery point must be a direct child of the archive rpo directory",
    );
  }
  return dirname(rpoRoot);
}

function exactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const expectedKeys = new Set(expected);
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== expectedKeys.size || actualKeys.some((key) => !expectedKeys.has(key))) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      `attachment binding marker has an invalid ${field} shape`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      `attachment binding marker ${field} must be a lowercase SHA-256`,
    );
  }
  return value;
}

function requireSafeNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      `attachment marker ${field} must be a non-negative integer`,
    );
  }
  return value;
}

function requireCanonicalTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      `attachment marker ${field} must be a timestamp`,
    );
  }
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch (error) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      `attachment marker ${field} must be a canonical UTC timestamp`,
      { cause: error },
    );
  }
  if (canonical !== value) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      `attachment marker ${field} must be a canonical UTC timestamp`,
    );
  }
  return value;
}

function readArchiveAttachmentBinding(markerPath: string): ArchiveAttachmentBinding {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch (error) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "attachment binding marker could not be read",
      { cause: error },
    );
  }
  if (!isRecord(raw)) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "attachment binding marker must be a JSON object",
    );
  }
  exactObjectKeys(
    raw,
    ["markerVersion", "operation", "state", "database", "attachments"],
    "top-level",
  );
  if (
    raw.markerVersion !== 1 ||
    raw.operation !== "sqlite-recovery-point-archive-with-attachments" ||
    raw.state !== "complete"
  ) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "attachment binding marker has an unsupported operation or state",
    );
  }
  if (!isRecord(raw.database)) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "attachment binding marker database binding must be an object",
    );
  }
  exactObjectKeys(
    raw.database,
    ["createdAt", "applicationId", "schemaVersion", "sizeBytes", "sha256", "manifestSha256"],
    "database",
  );
  const database = Object.freeze({
    createdAt: requireCanonicalTimestamp(raw.database.createdAt, "database.createdAt"),
    applicationId: requireSafeNonNegativeInteger(
      raw.database.applicationId,
      "database.applicationId",
    ),
    schemaVersion: requireSafeNonNegativeInteger(
      raw.database.schemaVersion,
      "database.schemaVersion",
    ),
    sizeBytes: requireSafeNonNegativeInteger(raw.database.sizeBytes, "database.sizeBytes"),
    sha256: requireSha256(raw.database.sha256, "database.sha256"),
    manifestSha256: requireSha256(raw.database.manifestSha256, "database.manifestSha256"),
  });
  if (!isRecord(raw.attachments)) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "attachment binding marker attachments binding must be an object",
    );
  }
  exactObjectKeys(
    raw.attachments,
    ["inventorySha256", "completeMarkerSha256", "entryCount"],
    "attachments",
  );
  const attachments = Object.freeze({
    inventorySha256: requireSha256(raw.attachments.inventorySha256, "attachments.inventorySha256"),
    completeMarkerSha256: requireSha256(
      raw.attachments.completeMarkerSha256,
      "attachments.completeMarkerSha256",
    ),
    entryCount: requireSafeNonNegativeInteger(raw.attachments.entryCount, "attachments.entryCount"),
  });
  return Object.freeze({
    markerVersion: 1,
    operation: "sqlite-recovery-point-archive-with-attachments",
    state: "complete",
    database,
    attachments,
  });
}

function readAttachmentCompleteMarker(markerPath: string): ArchiveAttachmentCompleteMarker {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch (error) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "attachment complete marker could not be read",
      { cause: error },
    );
  }
  if (!isRecord(raw)) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "attachment complete marker must be a JSON object",
    );
  }
  exactObjectKeys(
    raw,
    ["markerVersion", "operation", "state", "manifestSha256", "entryCount"],
    "complete marker",
  );
  if (
    raw.markerVersion !== 1 ||
    raw.operation !== "isolated-attachment-restore" ||
    raw.state !== "complete"
  ) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "attachment complete marker is not complete",
    );
  }
  return Object.freeze({
    markerVersion: 1,
    operation: "isolated-attachment-restore",
    state: "complete",
    manifestSha256: requireSha256(raw.manifestSha256, "manifestSha256"),
    entryCount: requireSafeNonNegativeInteger(raw.entryCount, "entryCount"),
  });
}

function archiveTargetOrdinaryFile(filePath: string, field: string): string {
  try {
    return requireOrdinaryFile(filePath, field);
  } catch (error) {
    if (error instanceof SqliteArchiveError) {
      throw new SqliteArchiveError("SQLITE_ARCHIVE_TARGET_MISMATCH", error.message, {
        cause: error,
      });
    }
    throw error;
  }
}

function archiveTargetOrdinaryDirectory(directoryPath: string, field: string): string {
  const absolutePath = requireAbsolutePath(directoryPath, field);
  try {
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${field} must be an ordinary directory`);
    }
    return realpathSync.native(absolutePath);
  } catch (error) {
    throw new SqliteArchiveError("SQLITE_ARCHIVE_TARGET_MISMATCH", `${field} is invalid`, {
      cause: error,
    });
  }
}

function sourceAttachmentError(error: unknown): never {
  if (error instanceof SqliteArchiveError && error.code === "SQLITE_ARCHIVE_SOURCE_INVALID") {
    throw error;
  }
  throw new SqliteArchiveError(
    "SQLITE_ARCHIVE_SOURCE_INVALID",
    "referenced attachment source is missing or does not match its inventory",
    { cause: error },
  );
}

function attachmentBindingJson(
  manifest: SqliteBackupManifest,
  manifestSha256: string,
  attachmentManifestSha256: string,
  attachmentCompleteMarkerSha256: string,
  entryCount: number,
): string {
  const binding: ArchiveAttachmentBinding = {
    markerVersion: 1,
    operation: "sqlite-recovery-point-archive-with-attachments",
    state: "complete",
    database: {
      createdAt: manifest.createdAt,
      applicationId: manifest.sourceDatabase.applicationId,
      schemaVersion: manifest.schemaVersion,
      sizeBytes: manifest.backup.sizeBytes,
      sha256: manifest.backup.sha256,
      manifestSha256,
    },
    attachments: {
      inventorySha256: attachmentManifestSha256,
      completeMarkerSha256: attachmentCompleteMarkerSha256,
      entryCount,
    },
  };
  return `${JSON.stringify(binding, null, 2)}\n`;
}

function makeUniqueAttachmentStagingPath(attachmentRoot: string, stagingParent: string): string {
  const parent = stagingParent;
  const name = basename(attachmentRoot);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = join(parent, `.${name}.${randomUUID()}.staging`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new SqliteArchiveError(
    "SQLITE_ARCHIVE_COPY_FAILED",
    "could not reserve a unique attachment staging root",
  );
}

function attachmentResult(
  disposition: "created" | "existing",
  backupValidation: SqliteBackupArchiveResult,
  attachmentRoot: string,
  attachmentManifestPath: string,
  attachmentCompleteMarkerPath: string,
  attachmentBindingMarkerPath: string,
): SqliteRecoveryPointWithAttachmentsResult {
  const canonicalAttachmentRoot = archiveTargetOrdinaryDirectory(
    attachmentRoot,
    "archive attachment root",
  );
  const canonicalAttachmentManifestPath = archiveTargetOrdinaryFile(
    attachmentManifestPath,
    "archive attachment inventory",
  );
  const canonicalAttachmentCompleteMarkerPath = archiveTargetOrdinaryFile(
    attachmentCompleteMarkerPath,
    "archive attachment complete marker",
  );
  const canonicalAttachmentBindingMarkerPath = archiveTargetOrdinaryFile(
    attachmentBindingMarkerPath,
    "archive attachment binding marker",
  );
  const completeMarker = readAttachmentCompleteMarker(canonicalAttachmentCompleteMarkerPath);
  return Object.freeze({
    disposition,
    archiveRoot: backupValidation.archiveRoot,
    backupPath: backupValidation.backupPath,
    manifestPath: backupValidation.manifestPath,
    manifest: backupValidation.manifest,
    backupSha256: backupValidation.backupSha256,
    manifestSha256: backupValidation.manifestSha256,
    attachmentRoot: canonicalAttachmentRoot,
    attachmentManifestPath: canonicalAttachmentManifestPath,
    attachmentManifestSha256: sha256File(canonicalAttachmentManifestPath),
    attachmentCompleteMarkerPath: canonicalAttachmentCompleteMarkerPath,
    attachmentCompleteMarkerSha256: sha256File(canonicalAttachmentCompleteMarkerPath),
    attachmentBindingMarkerPath: canonicalAttachmentBindingMarkerPath,
    attachmentBindingMarkerSha256: sha256File(canonicalAttachmentBindingMarkerPath),
    entryCount: completeMarker.entryCount,
  });
}

/**
 * Validate an archived SQLite database and its marker-bound attachment companion.
 *
 * The attachment root is an ordinary direct sibling of the database.  Its
 * complete marker is admitted by the attachment restore validator before the
 * binding marker is trusted, so a missing or modified blob can never produce a
 * valid combined recovery point.
 */
export async function validateArchivedSqliteRecoveryPointWithAttachments(
  options: ValidateArchivedSqliteRecoveryPointWithAttachmentsOptions,
): Promise<SqliteRecoveryPointWithAttachmentsResult> {
  const requestedBackupPath = requireAbsolutePath(options.backupPath, "backupPath");
  const requestedManifestPath = requireAbsolutePath(
    options.manifestPath ?? `${requestedBackupPath}.manifest.json`,
    "manifestPath",
  );
  const expectedManifestPath = `${requestedBackupPath}.manifest.json`;
  if (
    !pathsEqual(dirname(requestedBackupPath), dirname(requestedManifestPath)) ||
    basename(requestedManifestPath) !== basename(expectedManifestPath)
  ) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "archived database and manifest must be exact direct siblings",
    );
  }
  if (!basename(requestedBackupPath).endsWith(".sqlite")) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "archived recovery point database must use the .sqlite suffix",
    );
  }
  const archiveRoot = assertArchiveRpoLayout(requestedBackupPath);
  const canonicalBackupPath = archiveTargetOrdinaryFile(requestedBackupPath, "archive backup");
  const canonicalManifestPath = archiveTargetOrdinaryFile(
    requestedManifestPath,
    "archive manifest",
  );
  if (!pathsEqual(dirname(canonicalBackupPath), dirname(canonicalManifestPath))) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "archive database and manifest must share one directory",
    );
  }

  let validated;
  try {
    validated = validateSqliteBackupBundle({
      backupPath: canonicalBackupPath,
      manifestPath: canonicalManifestPath,
    });
  } catch (error) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "archive database and manifest failed strict validation",
      { cause: error },
    );
  }
  const backupValidation: SqliteBackupArchiveResult = Object.freeze({
    disposition: "existing",
    archiveRoot,
    backupPath: canonicalBackupPath,
    manifestPath: canonicalManifestPath,
    manifest: validated.manifest,
    backupSha256: backupFileSha256(canonicalBackupPath),
    manifestSha256: sha256File(canonicalManifestPath),
  });

  const requestedAttachmentRoot = assertDirectAttachmentSibling(
    requestedBackupPath,
    options.attachmentRoot ?? attachmentRootForBackup(requestedBackupPath),
    "SQLITE_ARCHIVE_TARGET_MISMATCH",
  );
  const canonicalAttachmentRoot = archiveTargetOrdinaryDirectory(
    requestedAttachmentRoot,
    "archive attachment root",
  );
  if (!pathsEqual(dirname(canonicalAttachmentRoot), dirname(canonicalBackupPath))) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "archive attachment root must share the database directory",
    );
  }
  const attachmentManifestPath = join(canonicalAttachmentRoot, ATTACHMENT_INVENTORY_FILE);
  const attachmentCompleteMarkerPath = join(
    canonicalAttachmentRoot,
    ATTACHMENT_COMPLETE_MARKER_FILE,
  );
  const attachmentBindingMarkerPath = join(canonicalAttachmentRoot, ATTACHMENT_BINDING_MARKER_FILE);
  const canonicalAttachmentManifestPath = archiveTargetOrdinaryFile(
    attachmentManifestPath,
    "archive attachment inventory",
  );
  const canonicalAttachmentCompleteMarkerPath = archiveTargetOrdinaryFile(
    attachmentCompleteMarkerPath,
    "archive attachment complete marker",
  );
  const canonicalAttachmentBindingMarkerPath = archiveTargetOrdinaryFile(
    attachmentBindingMarkerPath,
    "archive attachment binding marker",
  );

  try {
    await validateReferencedAttachmentRoot({
      databasePath: canonicalBackupPath,
      evidenceRoot: canonicalAttachmentRoot,
      createdAt: validated.manifest.createdAt,
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    });
  } catch (error) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "archive attachment root failed strict validation",
      { cause: error },
    );
  }

  const completeMarker = readAttachmentCompleteMarker(canonicalAttachmentCompleteMarkerPath);
  const binding = readArchiveAttachmentBinding(canonicalAttachmentBindingMarkerPath);
  const attachmentManifestSha256 = sha256File(canonicalAttachmentManifestPath);
  const attachmentCompleteMarkerSha256 = sha256File(canonicalAttachmentCompleteMarkerPath);
  if (
    binding.database.createdAt !== validated.manifest.createdAt ||
    binding.database.applicationId !== validated.manifest.sourceDatabase.applicationId ||
    binding.database.schemaVersion !== validated.manifest.schemaVersion ||
    binding.database.sizeBytes !== validated.manifest.backup.sizeBytes ||
    binding.database.sha256 !== validated.manifest.backup.sha256 ||
    binding.database.manifestSha256 !== backupValidation.manifestSha256 ||
    binding.attachments.inventorySha256 !== attachmentManifestSha256 ||
    binding.attachments.completeMarkerSha256 !== attachmentCompleteMarkerSha256 ||
    binding.attachments.entryCount !== completeMarker.entryCount ||
    completeMarker.manifestSha256 !== attachmentManifestSha256
  ) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "archive attachment binding does not match the database and attachment markers",
    );
  }

  return attachmentResult(
    "existing",
    backupValidation,
    canonicalAttachmentRoot,
    canonicalAttachmentManifestPath,
    canonicalAttachmentCompleteMarkerPath,
    canonicalAttachmentBindingMarkerPath,
  );
}

/**
 * Archive one manifest-bound SQLite recovery point together with all of the
 * ready/clean blobs referenced by that exact archived database.
 *
 * The database pair is copied with the existing create-only archive helper.
 * Attachments are restored into a unique hidden sibling, validated, bound by a
 * marker written last, and published with one create-only directory rename.
 * A failed source restore intentionally retains its staging root for evidence
 * and retry; no incomplete companion is ever promoted or overwritten.
 */
export async function archiveSqliteRecoveryPointWithAttachments(
  options: ArchiveSqliteRecoveryPointWithAttachmentsOptions,
): Promise<SqliteRecoveryPointWithAttachmentsResult> {
  const sourceEvidenceRoot = requireExistingOrdinaryDirectory(options.evidenceRoot, "evidenceRoot");
  const requestedArchiveRoot = requireAbsolutePath(options.archiveRoot, "archiveRoot");
  const resolvedArchiveRoot = canonicalizePotentialPath(requestedArchiveRoot, "archiveRoot");
  if (pathsOverlap(resolvedArchiveRoot, sourceEvidenceRoot)) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_CONFIGURATION_INVALID",
      "archiveRoot must not overlap evidenceRoot",
    );
  }

  // Archive the DB first.  If attachment source validation fails, this leaves
  // a durable, strictly validated DB pair which can be retried with a fresh
  // hidden staging root without ever overwriting it.
  const archivedDatabase = archiveSqliteBackupBundle({
    backupPath: options.backupPath,
    ...(options.manifestPath === undefined ? {} : { manifestPath: options.manifestPath }),
    archiveRoot: requestedArchiveRoot,
  });
  const targetAttachmentRoot = attachmentRootForBackup(archivedDatabase.backupPath);
  if (existsSync(targetAttachmentRoot)) {
    return Object.freeze({
      ...(await validateArchivedSqliteRecoveryPointWithAttachments({
        backupPath: archivedDatabase.backupPath,
        manifestPath: archivedDatabase.manifestPath,
        attachmentRoot: targetAttachmentRoot,
        ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
      })),
      disposition: "existing",
    });
  }

  const stagingRoot = makeUniqueAttachmentStagingPath(
    targetAttachmentRoot,
    archivedDatabase.archiveRoot,
  );
  let restored;
  try {
    restored = await restoreReferencedAttachmentsToIsolatedRoot({
      databasePath: archivedDatabase.backupPath,
      evidenceRoot: sourceEvidenceRoot,
      restoreRoot: stagingRoot,
      createdAt: archivedDatabase.manifest.createdAt,
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    });
    await validateReferencedAttachmentRoot({
      databasePath: archivedDatabase.backupPath,
      evidenceRoot: restored.restoreRoot,
      createdAt: archivedDatabase.manifest.createdAt,
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    });
  } catch (error) {
    sourceAttachmentError(error);
  }

  const attachmentManifestPath = join(stagingRoot, ATTACHMENT_INVENTORY_FILE);
  const attachmentCompleteMarkerPath = join(stagingRoot, ATTACHMENT_COMPLETE_MARKER_FILE);
  const attachmentBindingMarkerPath = join(stagingRoot, ATTACHMENT_BINDING_MARKER_FILE);
  let attachmentManifestSha256: string;
  let attachmentCompleteMarkerSha256: string;
  let completeMarker: ArchiveAttachmentCompleteMarker;
  try {
    const canonicalManifestPath = archiveTargetOrdinaryFile(
      attachmentManifestPath,
      "staged attachment inventory",
    );
    const canonicalCompleteMarkerPath = archiveTargetOrdinaryFile(
      attachmentCompleteMarkerPath,
      "staged attachment complete marker",
    );
    attachmentManifestSha256 = sha256File(canonicalManifestPath);
    attachmentCompleteMarkerSha256 = sha256File(canonicalCompleteMarkerPath);
    completeMarker = readAttachmentCompleteMarker(canonicalCompleteMarkerPath);
    if (completeMarker.manifestSha256 !== attachmentManifestSha256) {
      throw new Error("staged attachment complete marker does not bind its inventory");
    }
    writeFileSync(
      attachmentBindingMarkerPath,
      attachmentBindingJson(
        archivedDatabase.manifest,
        archivedDatabase.manifestSha256,
        attachmentManifestSha256,
        attachmentCompleteMarkerSha256,
        completeMarker.entryCount,
      ),
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    sourceAttachmentError(error);
  }

  if (existsSync(targetAttachmentRoot)) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_PARTIAL",
      "archive attachment target appeared before publication",
    );
  }
  try {
    renameSync(stagingRoot, targetAttachmentRoot);
  } catch (error) {
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_PARTIAL",
      "archive attachment companion could not be published create-only",
      { cause: error },
    );
  }

  try {
    const validated = await validateArchivedSqliteRecoveryPointWithAttachments({
      backupPath: archivedDatabase.backupPath,
      manifestPath: archivedDatabase.manifestPath,
      attachmentRoot: targetAttachmentRoot,
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    });
    return Object.freeze({ ...validated, disposition: "created" });
  } catch (error) {
    // The companion has already been atomically published.  Report mismatch
    // without deleting or replacing it; the caller must investigate the
    // retained archive rather than silently falling back to DB-only success.
    if (error instanceof SqliteArchiveError) throw error;
    throw new SqliteArchiveError(
      "SQLITE_ARCHIVE_TARGET_MISMATCH",
      "published archive attachment companion failed strict validation",
      { cause: error },
    );
  }
}
