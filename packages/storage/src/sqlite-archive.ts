import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { backupFileSha256, type SqliteBackupManifest } from "./sqlite-backup.js";
import { validateSqliteBackupBundle } from "./sqlite-restore.js";

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
    copyFileSync(sourceBackupPath, targetBackupPath, constants.COPYFILE_EXCL);
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
    copyFileSync(sourceManifestPath, targetManifestPath, constants.COPYFILE_EXCL);
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
