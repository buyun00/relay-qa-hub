import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteStorageWorker } from "@relay-qa-hub/storage";

import { archiveRecoveryPointOffThread } from "../dist/backup-archive-worker-client.js";

test("blocking archive work runs outside the API event loop", async () => {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 10);

  try {
    const result = await archiveRecoveryPointOffThread(
      {
        backupPath: "D:\\fixture\\backup.sqlite",
        manifestPath: "D:\\fixture\\backup.sqlite.manifest.json",
        evidenceRoot: "D:\\fixture\\evidence",
        archiveRoot: "E:\\fixture\\archive",
      },
      { workerUrl: new URL("./fixtures/blocking-backup-archive-worker.mjs", import.meta.url) },
    );
    assert.equal(result.fixture, true);
    assert.equal(result.archiveRoot, "E:\\fixture\\archive");
    assert.ok(ticks >= 5, `expected the event loop to keep ticking, observed ${ticks} ticks`);
  } finally {
    clearInterval(timer);
  }
});

test("the production archive worker preserves the complete recovery-point contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-qa-hub-api-archive-worker-"));
  const databaseRoot = join(root, "data", "db");
  const evidenceRoot = join(root, "data", "evidence");
  const quarantineRoot = join(root, "data", "quarantine");
  const backupRoot = join(root, "backups");
  const archiveRoot = join(root, "archive");
  const databaseFile = join(databaseRoot, "qa-hub.sqlite");
  const backupPath = join(backupRoot, "worker.sqlite");
  let storageWorker;

  try {
    await Promise.all([
      mkdir(databaseRoot, { recursive: true }),
      mkdir(evidenceRoot, { recursive: true }),
      mkdir(quarantineRoot, { recursive: true }),
      mkdir(backupRoot, { recursive: true }),
    ]);
    storageWorker = new SqliteStorageWorker({
      databaseFile,
      busyTimeoutMs: 5_000,
      backupRoot: join(root, "migration-backups"),
      evidenceRoot,
      quarantineRoot,
    });
    await storageWorker.initialization;
    const backup = await storageWorker.createOnlineBackup({
      targetPath: backupPath,
      createdAt: "2026-09-03T00:00:00.000Z",
    });

    const archived = await archiveRecoveryPointOffThread({
      backupPath: backup.backupPath,
      manifestPath: backup.manifestPath,
      evidenceRoot,
      archiveRoot,
    });

    assert.equal(archived.disposition, "created");
    assert.equal(archived.entryCount, 0);
    assert.equal(archived.manifest.schemaVersion, backup.manifest.schemaVersion);
    assert.equal(existsSync(archived.backupPath), true);
    assert.equal(existsSync(archived.manifestPath), true);
    assert.equal(existsSync(archived.attachmentRoot), true);
    assert.equal(existsSync(archived.attachmentBindingMarkerPath), true);
  } finally {
    if (storageWorker !== undefined) await storageWorker.close();
    await rm(root, { recursive: true, force: true });
  }
});
