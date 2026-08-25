import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { createSqliteOnlineBackup } from "../src/sqlite-backup.js";
import { restoreSqliteToIsolatedRoot, SqliteRestoreError } from "../src/sqlite-restore.js";

const APPLICATION_ID = 0x51414842;

function createFixture(root: string): DatabaseSync {
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
  return database;
}

test("restores a verified backup into a new fixed database root", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-qa-hub-sqlite-restore-"));
  const database = createFixture(root);
  try {
    const backupPath = join(root, "backups", "qa-hub.sqlite");
    await createSqliteOnlineBackup({ source: database, targetPath: backupPath });
    const restoreRoot = join(root, "isolated-restore");

    const result = await restoreSqliteToIsolatedRoot({ backupPath, restoreRoot });

    assert.equal(result.databasePath, join(restoreRoot, "db", "qa-hub.sqlite"));
    assert.equal(readFileSync(result.markerPath, "utf8").includes('"state": "complete"'), true);
    const restored = new DatabaseSync(result.databasePath, { readOnly: true });
    try {
      assert.equal(
        restored.prepare("SELECT key FROM bugs WHERE id = 'bug-1'").get()?.key,
        "LOCAL-1",
      );
      assert.equal(restored.prepare("PRAGMA application_id").get()?.application_id, APPLICATION_ID);
      assert.equal(restored.prepare("PRAGMA user_version").get()?.user_version, 4);
    } finally {
      restored.close();
    }
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an existing restore root without changing it", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-qa-hub-sqlite-restore-existing-"));
  const database = createFixture(root);
  try {
    const backupPath = join(root, "backups", "qa-hub.sqlite");
    await createSqliteOnlineBackup({ source: database, targetPath: backupPath });
    const restoreRoot = join(root, "existing-restore");
    mkdirSync(restoreRoot);
    const sentinelPath = join(restoreRoot, "keep.txt");
    writeFileSync(sentinelPath, "keep", { encoding: "utf8" });

    await assert.rejects(
      restoreSqliteToIsolatedRoot({ backupPath, restoreRoot }),
      (error: unknown) =>
        error instanceof SqliteRestoreError && error.code === "SQLITE_RESTORE_ROOT_EXISTS",
    );
    assert.equal(readFileSync(sentinelPath, "utf8"), "keep");
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
