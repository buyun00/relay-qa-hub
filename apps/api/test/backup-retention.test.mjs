import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  SqliteStorageWorker,
  archiveSqliteRecoveryPointWithAttachments,
} from "@relay-qa-hub/storage";
import { archiveRecoveryPointOffThread } from "../dist/backup-archive-worker-client.js";
import {
  nextBackupDelay,
  pruneRecoveryPoints,
  retainedRecoveryPoints,
} from "../dist/backup-retention.js";
import { parseApiBackupEnvironment } from "../dist/backup-runner.js";

const point = (createdAt) => ({ createdAt, backupPath: createdAt });
test("keeps two newest and only the current 09:00 Shanghai anchor", () => {
  const points = [
    "2026-09-07T01:00:00.010Z",
    "2026-09-08T00:55:00.000Z",
    "2026-09-08T01:10:00.000Z",
    "2026-09-08T01:25:00.000Z",
    "2026-09-08T05:00:00.000Z",
    "2026-09-08T05:15:00.000Z",
  ].map(point);
  assert.deepEqual(
    retainedRecoveryPoints(points).map((p) => p.createdAt),
    ["2026-09-08T05:15:00.000Z", "2026-09-08T05:00:00.000Z", "2026-09-08T01:10:00.000Z"],
  );
  assert.equal(retainedRecoveryPoints(points.slice(0, 2)).length, 2);
  const beforeNine = [
    ...points,
    point("2026-09-09T00:45:00.000Z"),
    point("2026-09-09T00:59:00.000Z"),
  ];
  assert.equal(retainedRecoveryPoints(beforeNine).at(-1).createdAt, "2026-09-08T01:10:00.000Z");
  const nextDay = [...beforeNine, point("2026-09-09T01:00:00.003Z")];
  assert.equal(retainedRecoveryPoints(nextDay).length, 2);
  assert.ok(!retainedRecoveryPoints(nextDay).includes(points[2]));
  assert.deepEqual(retainedRecoveryPoints([]), []);
});

test("schedules 09:00 precisely and catches a boundary crossed during a backup", () => {
  const at = Date.parse("2026-09-08T00:59:30.000Z");
  assert.equal(nextBackupDelay(900_000, at, at), 30_000);
  assert.equal(nextBackupDelay(900_000, at + 40_000, at), 1);
  assert.equal(nextBackupDelay(900_000, at + 40_000, at + 30_001), 900_000);
});

test("retention configuration requires both archive and cadence", () => {
  assert.throws(
    () => parseApiBackupEnvironment({ QA_HUB_BACKUP_RETENTION_ENABLED: "true" }, {}),
    /requires off-disk archive and cadence/,
  );
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "qa-backup-retention-"));
  const backupRoot = join(root, "backups"),
    archiveRoot = join(root, "archive");
  const evidenceRoot = join(root, "data", "evidence"),
    quarantineRoot = join(root, "data", "quarantine");
  await Promise.all(
    [join(backupRoot, "rpo"), evidenceRoot, quarantineRoot].map((p) =>
      mkdir(p, { recursive: true }),
    ),
  );
  const worker = new SqliteStorageWorker({
    databaseFile: join(root, "data", "db", "qa.sqlite"),
    backupRoot: join(root, "migration"),
    evidenceRoot,
    quarantineRoot,
    busyTimeoutMs: 5000,
  });
  await worker.initialization;
  t.after(async () => {
    await worker.close();
    // mkdtemp returns a fresh test-only absolute root; never remove a supplied path.
    assert.ok(root.startsWith(join(tmpdir(), "qa-backup-retention-")));
    await rm(root, { recursive: true, force: true });
  });
  const backups = [];
  for (const createdAt of [
    "2026-09-07T01:00:00.000Z",
    "2026-09-08T01:10:00.000Z",
    "2026-09-08T01:25:00.000Z",
    "2026-09-08T05:00:00.000Z",
    "2026-09-08T05:15:00.000Z",
  ]) {
    const targetPath = join(
      backupRoot,
      "rpo",
      `${createdAt.replaceAll(":", "-")}.${randomUUID()}.sqlite`,
    );
    const backup = await worker.createOnlineBackup({ targetPath, createdAt });
    await archiveSqliteRecoveryPointWithAttachments({ ...backup, evidenceRoot, archiveRoot });
    backups.push(backup);
  }
  const options = {
    backupRoot,
    archiveRoot,
    successfulBackupName: basename(backups.at(-1).backupPath),
    now: new Date("2026-09-08T06:00:00.000Z"),
  };
  return { root, backupRoot, archiveRoot, evidenceRoot, backups, options };
}

test("deletes whole obsolete groups on both volumes, audits, and is idempotent", async (t) => {
  const f = await fixture(t);
  const manualPath = join(f.archiveRoot, "rpo", "manual.sqlite");
  await writeFile(manualPath, "manual rollback");
  const preview = await pruneRecoveryPoints({ ...f.options, dryRun: true });
  assert.equal(preview.deletedGroups, 0);
  assert.ok(existsSync(f.backups[0].backupPath));
  const result = await pruneRecoveryPoints(f.options);
  assert.equal(result.deletedGroups, 4);
  assert.equal(result.kept.length, 6);
  assert.equal(result.skipped.length, 0);
  for (const root of [f.backupRoot, f.archiveRoot]) {
    assert.equal(
      readdirSync(join(root, "rpo")).filter((p) => p.endsWith(".manifest.json")).length,
      3,
    );
    const old = join(root, "rpo", basename(f.backups[0].backupPath));
    for (const suffix of ["", ".manifest.json", ".attachments"])
      assert.equal(existsSync(`${old}${suffix}`), false);
  }
  assert.equal(readFileSync(manualPath, "utf8"), "manual rollback");
  assert.match(readFileSync(result.auditPath, "utf8"), /"event":"complete"/);
  assert.equal((await pruneRecoveryPoints(f.options)).deletedGroups, 0);
});

test("corrupt retained archive prevents every deletion, including local backups", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(
      f.archiveRoot,
      "rpo",
      `${f.options.successfulBackupName}.attachments`,
      ".qa-hub-sqlite-archive-binding.json",
    ),
    "{}",
  );
  await assert.rejects(pruneRecoveryPoints(f.options));
  for (const backup of f.backups) assert.ok(existsSync(backup.backupPath));
});

test("a live cleanup lock refuses overlap and a dead owner's lock is recovered", async (t) => {
  const f = await fixture(t);
  const lockPath = join(f.backupRoot, "retention.lock.json");
  await writeFile(lockPath, JSON.stringify({ pids: [process.pid] }));
  await assert.rejects(pruneRecoveryPoints(f.options), /already running/);
  assert.ok(existsSync(f.backups[0].backupPath));
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(exited.status, 0);
  await writeFile(lockPath, JSON.stringify({ pids: [exited.pid] }));
  assert.equal((await pruneRecoveryPoints(f.options)).deletedGroups, 4);
  assert.equal(existsSync(lockPath), false);
});

test("a junction inside an obsolete attachment group is preserved and never traversed for deletion", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "protected");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "keep");
  const companion = join(f.archiveRoot, "rpo", `${basename(f.backups[0].backupPath)}.attachments`);
  const link = join(companion, "redirect");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  const result = await pruneRecoveryPoints(f.options);
  assert.ok(result.skipped.some((p) => p.backupPath.endsWith(basename(f.backups[0].backupPath))));
  assert.ok(existsSync(companion));
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
  await rm(link);
});

test("production worker applies retention and reports cleanup failures without losing backup success", async (t) => {
  const f = await fixture(t);
  const input = {
    ...f.backups.at(-1),
    evidenceRoot: f.evidenceRoot,
    archiveRoot: f.archiveRoot,
    retentionBackupRoot: f.backupRoot,
  };
  await writeFile(join(f.backupRoot, "retention-audit"), "obstruction");
  const failed = await archiveRecoveryPointOffThread(input);
  assert.ok(failed.retentionError);
  assert.equal(failed.disposition, "existing");
  assert.ok(existsSync(f.backups[0].backupPath));
  await rm(join(f.backupRoot, "retention-audit"));
  const success = await archiveRecoveryPointOffThread(input);
  assert.equal(success.retention.deletedGroups, 4);
  assert.equal(success.retentionError, undefined);
});
