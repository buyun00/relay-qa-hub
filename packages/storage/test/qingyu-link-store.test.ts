import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getQingyuLink,
  getQingyuLinkByExternal,
  putQingyuLink,
  updateQingyuLinkSync,
} from "../src/qingyu-link-store.ts";
import {
  insertBugWithNextNumber,
  migrateSqliteDatabase,
  openSqliteDatabaseForWorker,
} from "../src/sqlite.ts";

test("Qingyu Bug links survive in the migrated SQLite source of truth", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-qingyu-link-"));
  const databaseFile = join(root, "db", "qa-hub.sqlite");
  const database = openSqliteDatabaseForWorker({ databaseFile, busyTimeoutMs: 2_000 });
  const accountId = "10000000-0000-4000-8000-000000000020";
  const projectId = "10000000-0000-4000-8000-000000000004";
  const actorId = "10000000-0000-4000-8000-000000000003";
  const bugId = "20000000-0000-4000-8000-000000000001";
  const at = "2026-08-28T01:00:00.000Z";
  try {
    const migration = await migrateSqliteDatabase(database, databaseFile);
    assert.ok(migration.appliedVersions.includes(6));
    database
      .prepare(
        "INSERT INTO accounts(id, slug, display_name, status, created_at, updated_at, version) VALUES (?, 'local', 'Local', 'active', ?, ?, 1)",
      )
      .run(accountId, at, at);
    database
      .prepare(
        "INSERT INTO users(id, account_id, email, display_name, status, created_at, updated_at, version) VALUES (?, ?, 'qa@local.invalid', '测试用户', 'active', ?, ?, 1)",
      )
      .run(actorId, accountId, at, at);
    database
      .prepare(
        "INSERT INTO projects(id, account_id, project_key, name, status, created_at, updated_at, version) VALUES (?, ?, 'LOCAL', 'Local', 'active', ?, ?, 1)",
      )
      .run(projectId, accountId, at, at);
    database.exec("BEGIN IMMEDIATE");
    insertBugWithNextNumber(database, {
      id: bugId,
      accountId,
      projectId,
      title: "按钮无响应",
      description: "点击后无响应",
      expectedBehavior: "正常响应",
      severity: "S1",
      priority: "P1",
      reporterId: actorId,
      ownerId: actorId,
      verificationOwnerId: actorId,
      createdAt: at,
    });
    database.exec("COMMIT");

    const created = putQingyuLink(database, {
      accountId,
      projectId,
      updatedAt: at,
      link: {
        bugId,
        qaProjectId: projectId,
        externalProjectId: "project-3",
        defectId: "91",
        defectCode: "BUG-91",
        defectTitle: "按钮无响应",
        defectUrl: "https://qingyu.example.test/tasks/91",
        importedByActorId: actorId,
        qingyuUserId: "7",
        qingyuUserName: "测试用户",
        importedAt: at,
        syncStatus: "not_synced",
        syncAttempts: 0,
        syncedAt: null,
        externalStatus: "处理中",
        lastSyncErrorCode: null,
        lastSyncErrorMessage: null,
        lastSyncAt: null,
      },
    });
    assert.equal(created.version, 1);
    assert.equal(
      getQingyuLinkByExternal(database, {
        accountId,
        projectId,
        externalProjectId: "project-3",
        defectId: "91",
      })?.bugId,
      bugId,
    );

    const syncing = updateQingyuLinkSync(database, {
      accountId,
      projectId,
      bugId,
      expectedVersion: 1,
      syncStatus: "syncing",
      syncAttempts: 1,
      syncedAt: null,
      externalStatus: "处理中",
      lastSyncErrorCode: null,
      lastSyncErrorMessage: null,
      lastSyncAt: at,
      updatedAt: at,
    });
    const succeeded = updateQingyuLinkSync(database, {
      accountId,
      projectId,
      bugId,
      expectedVersion: syncing.version,
      syncStatus: "succeeded",
      syncAttempts: 1,
      syncedAt: at,
      externalStatus: "已解决",
      lastSyncErrorCode: null,
      lastSyncErrorMessage: null,
      lastSyncAt: at,
      updatedAt: at,
    });
    assert.equal(succeeded.syncStatus, "succeeded");
    assert.equal(
      getQingyuLink(database, { accountId, projectId, bugId })?.externalStatus,
      "已解决",
    );
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
