import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  restoreReferencedAttachmentsToIsolatedRoot,
  restoreSqliteToIsolatedRoot,
  validateArchivedSqliteRecoveryPointWithAttachments,
  validateReferencedAttachmentRoot,
} from "../packages/storage/dist/index.js";

function usage() {
  throw new Error(
    "Usage: node scripts/Verify-QAHubRecoveryPoint.mjs --archive-root <absolute path> [--restore-root <new absolute path> | --verify-restore-root <existing absolute path>]",
  );
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) usage();
    if (
      name !== "--archive-root" &&
      name !== "--restore-root" &&
      name !== "--verify-restore-root"
    ) {
      usage();
    }
    if (values.has(name)) usage();
    values.set(name, value);
  }
  const archiveRoot = values.get("--archive-root");
  const restoreRoot = values.get("--restore-root");
  const verifyRestoreRoot = values.get("--verify-restore-root");
  if (!archiveRoot) usage();
  if (restoreRoot !== undefined && verifyRestoreRoot !== undefined) usage();
  for (const [name, value] of [
    ["archive root", archiveRoot],
    ["restore root", restoreRoot],
    ["verify restore root", verifyRestoreRoot],
  ]) {
    if (value !== undefined && (!isAbsolute(value) || value.trim().length === 0)) {
      throw new Error(`${name} must be an absolute path`);
    }
  }
  return {
    archiveRoot: resolve(archiveRoot),
    restoreRoot: restoreRoot && resolve(restoreRoot),
    verifyRestoreRoot: verifyRestoreRoot && resolve(verifyRestoreRoot),
  };
}

function ordinaryDirectory(directory, label) {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be an ordinary directory`);
  }
  return realpathSync.native(directory);
}

function recoveryCandidates(archiveRoot) {
  const canonicalArchiveRoot = ordinaryDirectory(archiveRoot, "archive root");
  const rpoRoot = ordinaryDirectory(join(canonicalArchiveRoot, "rpo"), "archive rpo root");
  if (dirname(rpoRoot) !== canonicalArchiveRoot || basename(rpoRoot) !== "rpo") {
    throw new Error("archive rpo root must be a direct child of archive root");
  }

  const candidates = [];
  const rejected = [];
  for (const entry of readdirSync(rpoRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".sqlite.manifest.json")) continue;
    try {
      const manifestPath = join(rpoRoot, entry.name);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const createdAtMs = Date.parse(manifest.createdAt);
      if (!Number.isFinite(createdAtMs)) throw new Error("invalid createdAt");
      const backupPath = manifestPath.slice(0, -".manifest.json".length);
      candidates.push({ backupPath, manifestPath, createdAtMs });
    } catch {
      rejected.push(entry.name);
    }
  }
  candidates.sort(
    (left, right) =>
      right.createdAtMs - left.createdAtMs || right.manifestPath.localeCompare(left.manifestPath),
  );
  if (candidates.length === 0) throw new Error("archive contains no manifest-bound recovery point");
  return { candidates, rejected };
}

function scalar(database, sql) {
  const row = database.prepare(sql).get();
  return Number(Object.values(row)[0]);
}

function inspectRestoredDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrityRows = database.prepare("PRAGMA integrity_check").all();
    const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
    const latestBug = database
      .prepare(
        "SELECT key AS bugKey, updated_at AS updatedAt FROM bugs ORDER BY updated_at DESC, id DESC LIMIT 1",
      )
      .get();
    return {
      integrity:
        integrityRows.length === 1 && integrityRows[0].integrity_check === "ok"
          ? "ok"
          : integrityRows,
      foreignKeyViolations: foreignKeyRows.length,
      schemaVersion: scalar(database, "PRAGMA user_version"),
      bugCount: scalar(database, "SELECT COUNT(*) FROM bugs"),
      attachmentCount: scalar(database, "SELECT COUNT(*) FROM attachments"),
      bugAttachmentCount: scalar(database, "SELECT COUNT(*) FROM bug_attachments"),
      latestBug: latestBug ?? null,
    };
  } finally {
    database.close();
  }
}

const { archiveRoot, restoreRoot, verifyRestoreRoot } = parseArgs(process.argv.slice(2));
const discovered = recoveryCandidates(archiveRoot);
let validated;
for (const candidate of discovered.candidates) {
  try {
    validated = await validateArchivedSqliteRecoveryPointWithAttachments({
      backupPath: candidate.backupPath,
      manifestPath: candidate.manifestPath,
    });
    break;
  } catch {
    discovered.rejected.push(basename(candidate.manifestPath));
  }
}
if (validated === undefined) {
  throw new Error("archive contains no complete database-and-attachment recovery point");
}

const result = {
  status: "validated",
  archiveRoot: realpathSync.native(archiveRoot),
  backupPath: validated.backupPath,
  manifestPath: validated.manifestPath,
  createdAt: validated.manifest.createdAt,
  databaseSha256: validated.backupSha256,
  attachmentEntryCount: validated.entryCount,
  attachmentManifestSha256: validated.attachmentManifestSha256,
  rejectedRecoveryPointCount: discovered.rejected.length,
};

if (restoreRoot !== undefined) {
  if (existsSync(restoreRoot)) throw new Error("restore root must not already exist");
  const restoredDatabase = await restoreSqliteToIsolatedRoot({
    backupPath: validated.backupPath,
    manifestPath: validated.manifestPath,
    restoreRoot,
  });
  const restoredEvidence = await restoreReferencedAttachmentsToIsolatedRoot({
    databasePath: restoredDatabase.databasePath,
    evidenceRoot: validated.attachmentRoot,
    restoreRoot: join(restoreRoot, "evidence"),
    createdAt: validated.manifest.createdAt,
  });
  await validateReferencedAttachmentRoot({
    databasePath: restoredDatabase.databasePath,
    evidenceRoot: restoredEvidence.restoreRoot,
    createdAt: validated.manifest.createdAt,
  });
  mkdirSync(join(restoreRoot, "quarantine"));
  Object.assign(result, {
    status: "restored",
    restoreRoot: restoredDatabase.restoreRoot,
    restoredDatabasePath: restoredDatabase.databasePath,
    restoredEvidenceRoot: restoredEvidence.restoreRoot,
    restoredAttachmentEntryCount: restoredEvidence.manifest.entries.length,
    database: inspectRestoredDatabase(restoredDatabase.databasePath),
  });
} else if (verifyRestoreRoot !== undefined) {
  const canonicalRestoreRoot = ordinaryDirectory(verifyRestoreRoot, "restored data root");
  const restoreMarker = JSON.parse(
    readFileSync(join(canonicalRestoreRoot, ".qa-hub-isolated-restore.json"), "utf8"),
  );
  if (
    restoreMarker.markerVersion !== 1 ||
    restoreMarker.operation !== "isolated-sqlite-restore" ||
    restoreMarker.state !== "complete"
  ) {
    throw new Error("restored data root does not have a complete SQLite restore marker");
  }
  const restoredDatabasePath = join(canonicalRestoreRoot, "db", "qa-hub.sqlite");
  const restoredEvidenceRoot = join(canonicalRestoreRoot, "evidence");
  const restoredEvidence = await validateReferencedAttachmentRoot({
    databasePath: restoredDatabasePath,
    evidenceRoot: restoredEvidenceRoot,
    createdAt: validated.manifest.createdAt,
  });
  Object.assign(result, {
    status: "restored-verified",
    restoreRoot: canonicalRestoreRoot,
    restoredDatabasePath,
    restoredEvidenceRoot,
    restoredAttachmentEntryCount: restoredEvidence.manifest.entries.length,
    database: inspectRestoredDatabase(restoredDatabasePath),
  });
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
