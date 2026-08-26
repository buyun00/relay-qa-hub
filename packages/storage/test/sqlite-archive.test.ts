import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  archiveSqliteRecoveryPointWithAttachments,
  SqliteArchiveError,
  validateArchivedSqliteRecoveryPointWithAttachments,
} from "../src/sqlite-archive.js";
import { createSqliteOnlineBackup } from "../src/sqlite-backup.js";

const APPLICATION_ID = 0x51414842;
const CREATED_AT = "2026-08-26T10:00:00.000Z";

function createFixture(
  root: string,
  includeBlob: boolean,
): {
  readonly database: DatabaseSync;
  readonly databasePath: string;
  readonly evidenceRoot: string;
} {
  const databasePath = join(root, "source", "qa-hub.sqlite");
  const evidenceRoot = join(root, "evidence");
  mkdirSync(dirname(databasePath), { recursive: true });
  mkdirSync(evidenceRoot, { recursive: true });

  const bytes = Buffer.from("one archived attachment");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storageKey = `sha256/${sha256.slice(0, 2)}/${sha256}`;
  if (includeBlob) {
    const blobPath = join(evidenceRoot, storageKey);
    mkdirSync(dirname(blobPath), { recursive: true });
    writeFileSync(blobPath, bytes);
  }

  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA application_id = ${APPLICATION_ID};
    PRAGMA user_version = 4;
    PRAGMA foreign_keys = ON;
    CREATE TABLE blobs (
      account_id TEXT NOT NULL,
      id TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY (account_id, id)
    );
    CREATE TABLE attachments (
      account_id TEXT NOT NULL,
      blob_id TEXT NOT NULL,
      status TEXT NOT NULL,
      scan_state TEXT NOT NULL,
      FOREIGN KEY (account_id, blob_id) REFERENCES blobs(account_id, id)
    );
  `);
  database
    .prepare(
      "INSERT INTO blobs(account_id, id, storage_key, size_bytes, sha256, state) VALUES (?, ?, ?, ?, ?, 'ready')",
    )
    .run("account-1", "blob-1", storageKey, bytes.byteLength, sha256);
  database
    .prepare(
      "INSERT INTO attachments(account_id, blob_id, status, scan_state) VALUES (?, ?, 'ready', 'clean')",
    )
    .run("account-1", "blob-1");

  return { database, databasePath, evidenceRoot };
}

async function createBackup(root: string, database: DatabaseSync): Promise<string> {
  const backupPath = join(root, "local", "qa-hub.sqlite");
  await createSqliteOnlineBackup({
    source: database,
    targetPath: backupPath,
    createdAt: CREATED_AT,
  });
  return backupPath;
}

test("archives a recovery point with its attachment companion and is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-qa-hub-sqlite-archive-"));
  const { database, evidenceRoot } = createFixture(root, true);
  try {
    const backupPath = await createBackup(root, database);
    database.close();

    const first = await archiveSqliteRecoveryPointWithAttachments({
      backupPath,
      evidenceRoot,
      archiveRoot: join(root, "archive"),
    });
    assert.equal(first.disposition, "created");
    assert.equal(first.entryCount, 1);
    assert.ok(existsSync(first.attachmentRoot));
    assert.ok(existsSync(first.attachmentBindingMarkerPath));

    const validated = await validateArchivedSqliteRecoveryPointWithAttachments({
      backupPath: first.backupPath,
    });
    assert.equal(validated.disposition, "existing");
    assert.equal(validated.attachmentManifestSha256, first.attachmentManifestSha256);
    assert.equal(validated.attachmentCompleteMarkerSha256, first.attachmentCompleteMarkerSha256);

    const repeated = await archiveSqliteRecoveryPointWithAttachments({
      backupPath,
      evidenceRoot,
      archiveRoot: join(root, "archive"),
    });
    assert.equal(repeated.disposition, "existing");
    assert.equal(repeated.attachmentRoot, first.attachmentRoot);
    assert.equal(repeated.attachmentBindingMarkerSha256, first.attachmentBindingMarkerSha256);
  } finally {
    if (database.isOpen) database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed on a missing attachment and retains only DB pair plus failed staging", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-qa-hub-sqlite-archive-missing-"));
  const { database, evidenceRoot } = createFixture(root, false);
  try {
    const backupPath = await createBackup(root, database);
    database.close();
    const archiveRoot = join(root, "archive");
    const expectedAttachmentRoot = join(archiveRoot, "rpo", "qa-hub.sqlite.attachments");

    await assert.rejects(
      archiveSqliteRecoveryPointWithAttachments({
        backupPath,
        evidenceRoot,
        archiveRoot,
      }),
      (error: unknown) =>
        error instanceof SqliteArchiveError && error.code === "SQLITE_ARCHIVE_SOURCE_INVALID",
    );

    assert.ok(existsSync(join(archiveRoot, "rpo", "qa-hub.sqlite")));
    assert.ok(existsSync(join(archiveRoot, "rpo", "qa-hub.sqlite.manifest.json")));
    assert.equal(existsSync(expectedAttachmentRoot), false);
    const stagingRoots = readdirSync(archiveRoot).filter(
      (name) => name.startsWith(".qa-hub.sqlite.attachments.") && name.endsWith(".staging"),
    );
    assert.equal(stagingRoots.length, 1);
    assert.ok(
      existsSync(join(archiveRoot, stagingRoots[0]!, ".qa-hub-attachment-restore.failed.json")),
    );
    assert.equal(readFileSync(join(archiveRoot, "rpo", "qa-hub.sqlite")).byteLength > 0, true);
  } finally {
    if (database.isOpen) database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
