import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  restoreReferencedAttachmentsToIsolatedRoot,
  restoreSqliteToIsolatedRoot,
  validateArchivedSqliteRecoveryPointWithAttachments,
  validateReferencedAttachmentRoot,
} from "@relay-qa-hub/storage";

import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";

const [configArgument, restoreArgument] = process.argv.slice(2);
if (!configArgument || !restoreArgument)
  throw new Error("Usage: node verify-lan-recovery.mjs CONFIG_FILE NEW_RESTORE_ROOT");
const config = readParallelInstanceConfig(configArgument);
if (config.deploymentMode !== "lan" || config.backupArchiveRoot === null)
  throw new Error("LAN_ARCHIVE_CONFIGURATION_REQUIRED");
const restoreRoot = resolve(restoreArgument);
if (existsSync(restoreRoot)) throw new Error("RESTORE_ROOT_ALREADY_EXISTS");
mkdirSync(dirname(restoreRoot), { recursive: true });
const secureRestoreRoot = () => {
  if (process.platform !== "win32") {
    chmodSync(restoreRoot, 0o700);
    return;
  }
  const principal = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join("\\");
  if (!principal) throw new Error("RESTORE_ACL_PRINCIPAL_UNAVAILABLE");
  const acl = spawnSync(
    "icacls.exe",
    [
      restoreRoot,
      "/inheritance:r",
      "/grant:r",
      `${principal}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (acl.status !== 0) throw new Error(`RESTORE_ACL_FAILED: ${(acl.stderr || acl.stdout).trim()}`);
};
const rpoRoot = join(config.backupArchiveRoot, "rpo");
const backups = readdirSync(rpoRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite"))
  .map((entry) => join(rpoRoot, entry.name));
if (backups.length === 0) throw new Error("ARCHIVED_RECOVERY_POINT_NOT_FOUND");
const newest = backups
  .map((backupPath) => ({
    backupPath,
    manifest: JSON.parse(readFileSync(`${backupPath}.manifest.json`, "utf8")),
  }))
  .sort(
    (left, right) => Date.parse(right.manifest.createdAt) - Date.parse(left.manifest.createdAt),
  )[0];
const archived = await validateArchivedSqliteRecoveryPointWithAttachments({
  backupPath: newest.backupPath,
});
const restored = await restoreSqliteToIsolatedRoot({
  backupPath: archived.backupPath,
  manifestPath: archived.manifestPath,
  restoreRoot,
});
secureRestoreRoot();
const restoredEvidence = await restoreReferencedAttachmentsToIsolatedRoot({
  databasePath: restored.databasePath,
  evidenceRoot: archived.attachmentRoot,
  restoreRoot: join(restoreRoot, "evidence"),
  createdAt: archived.manifest.createdAt,
});
await validateReferencedAttachmentRoot({
  databasePath: restored.databasePath,
  evidenceRoot: restoredEvidence.restoreRoot,
  createdAt: archived.manifest.createdAt,
});
const configRoot = join(restoreRoot, "config");
mkdirSync(configRoot);
for (const file of [configArgument, config.secretsFile, config.peopleFile]) {
  copyFileSync(file, join(configRoot, basename(file)), constants.COPYFILE_EXCL);
}
console.log(
  JSON.stringify({
    sourceBackupPath: archived.backupPath,
    sourceBackupSha256: archived.backupSha256,
    restoredDatabasePath: restored.databasePath,
    restoredEvidenceRoot: restoredEvidence.restoreRoot,
    restoredAttachmentCount: restoredEvidence.manifest.entries.length,
    retainedConfigurationRoot: configRoot,
  }),
);
