import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import {
  createSqliteOnlineBackup,
  SqliteBackupError,
  validateSqliteBackup,
} from "../src/sqlite-backup.js";

const APPLICATION_ID = 0x51414842;

function createFixture(root: string): { database: DatabaseSync; databasePath: string } {
  const databasePath = join(root, "source", "qa-hub.sqlite");
  mkdirSync(join(root, "source"), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA application_id = ${APPLICATION_ID};
    PRAGMA user_version = 4;
    PRAGMA foreign_keys = ON;
    CREATE TABLE bugs (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE);
    INSERT INTO bugs(id, key) VALUES ('bug-1', 'LOCAL-1');
  `);
  return { database, databasePath };
}

test("creates a real online backup and manifest without leaking the source path", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-qa-hub-sqlite-backup-"));
  const { database, databasePath } = createFixture(root);
  try {
    const targetPath = join(root, "backups", "qa-hub.sqlite");
    const result = await createSqliteOnlineBackup({
      source: database,
      targetPath,
      createdAt: "2026-08-26T08:30:00.000Z",
    });

    assert.equal(result.backupPath, targetPath);
    assert.equal(result.manifest.manifestVersion, 1);
    assert.equal(result.manifest.schemaVersion, 4);
    assert.deepEqual(result.manifest.sourceDatabase, {
      applicationId: APPLICATION_ID,
      schemaVersion: 4,
    });
    assert.equal(result.manifest.integrity.ok, true);
    assert.deepEqual(result.manifest.integrity.foreignKeyViolations, []);
    assert.equal(result.manifest.backup.sizeBytes, readFileSync(targetPath).byteLength);
    assert.equal(
      result.manifest.backup.sha256,
      createHash("sha256").update(readFileSync(targetPath)).digest("hex"),
    );
    const manifestJson = readFileSync(result.manifestPath, "utf8");
    assert.equal(manifestJson.includes(databasePath), false);
    assert.equal(manifestJson.includes("sourceDatabaseFile"), false);
    assert.deepEqual(validateSqliteBackup(targetPath).databaseIdentity, {
      applicationId: APPLICATION_ID,
      schemaVersion: 4,
    });
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a damaged backup before restore admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-qa-hub-sqlite-backup-corrupt-"));
  const { database } = createFixture(root);
  let databaseClosed = false;
  try {
    const targetPath = join(root, "backups", "qa-hub.sqlite");
    await createSqliteOnlineBackup({ source: database, targetPath });
    database.close();
    databaseClosed = true;

    const corruptPath = join(root, "backups", "corrupt.sqlite");
    copyFileSync(targetPath, corruptPath);
    const bytes = readFileSync(corruptPath);
    const originalByte = bytes[4096];
    if (originalByte === undefined) throw new Error("backup fixture is unexpectedly short");
    bytes[4096] = originalByte ^ 0xff;
    writeFileSync(corruptPath, bytes);

    assert.throws(
      () => validateSqliteBackup(corruptPath),
      (error: unknown) =>
        error instanceof SqliteBackupError && error.code === "SQLITE_BACKUP_INVALID",
    );
  } finally {
    if (!databaseClosed) database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
