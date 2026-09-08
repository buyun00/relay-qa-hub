import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteStorageWorker } from "@relay-qa-hub/storage";

import { archiveRecoveryPointOffThread } from "../dist/backup-archive-worker-client.js";
import { createApiBackupRunner } from "../dist/backup-runner.js";

test("archive failure preserves local backups, startup and the next backup attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-hub-archive-unavailable-"));
  const evidenceRoot = join(root, "evidence");
  const quarantineRoot = join(root, "quarantine");
  const backupRoot = join(root, "backups");
  const archiveRoot = join(root, "blocked-archive");
  const failures = [];
  let worker, runner;
  try {
    await Promise.all(
      [evidenceRoot, quarantineRoot, backupRoot].map((p) => mkdir(p, { recursive: true })),
    );
    await writeFile(archiveRoot, "retained fixture obstruction");
    worker = new SqliteStorageWorker({
      databaseFile: join(root, "db", "qa.sqlite"),
      busyTimeoutMs: 5000,
      backupRoot: join(root, "migration"),
      evidenceRoot,
      quarantineRoot,
    });
    await worker.initialization;
    runner = createApiBackupRunner({
      config: {
        enabled: true,
        onStart: true,
        intervalMs: 50,
        retentionEnabled: true,
        backupRoot,
        evidenceRoot,
        archiveRoot,
      },
      worker,
      logger: {
        info() {},
        error(details) {
          failures.push(details);
        },
      },
    });
    const backup = await runner.start();
    assert.equal(existsSync(backup.backupPath), true);
    assert.equal(existsSync(backup.manifestPath), true);
    const deadline = Date.now() + 5000;
    while (failures.length < 2 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(failures.length >= 2, "archive failure must not disable scheduled backups");
    assert.match(failures[0].errorCode, /^SQLITE_ARCHIVE_/);
    assert.notEqual(failures[0].backupPath, failures[1].backupPath);
    assert.equal(existsSync(failures[1].backupPath), true);
  } finally {
    await runner?.stop();
    await worker?.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
