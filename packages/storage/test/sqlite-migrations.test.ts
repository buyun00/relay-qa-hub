import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import {
  createBrowserSession,
  resolveBrowserSession,
  revokeBrowserSession,
} from "../src/browser-auth-store.ts";
import { SQLITE_MIGRATIONS, SQLITE_SCHEMA_VERSION } from "../src/sqlite-migrations.ts";
import {
  QA_HUB_SQLITE_APPLICATION_ID,
  SqliteStorageError,
  currentSqliteSchemaVersion,
  insertBugWithNextNumber,
  migrateSqliteDatabase,
  openSqliteDatabaseForWorker,
  verifySqliteIntegrity,
  type InsertedBugIdentity,
  type NewBugStorageRecord,
} from "../src/sqlite.ts";
import { SqliteStorageWorker } from "../src/sqlite-worker.ts";

const STAMP = "2026-08-25T00:00:00.000Z";

interface DatabaseFixture {
  readonly database: DatabaseSync;
  readonly databaseFile: string;
  readonly root: string;
}

interface TenantFixture {
  readonly accountId: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly userId: string;
}

function identifier(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function closeDatabase(database: DatabaseSync): void {
  try {
    database.close();
  } catch {
    // Tests may deliberately close a connection before inspecting a backup.
  }
}

async function withDatabase(
  work: (fixture: DatabaseFixture) => Promise<void> | void,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "relay-qa-hub-sqlite-"));
  const databaseFile = join(root, "db", "qa-hub.sqlite");
  const database = openSqliteDatabaseForWorker({ databaseFile, busyTimeoutMs: 2_000 });
  try {
    await work({ database, databaseFile, root });
  } finally {
    closeDatabase(database);
    rmSync(root, { recursive: true, force: true });
  }
}

function numberColumn(
  database: DatabaseSync,
  sql: string,
  field: string,
  ...parameters: SQLInputValue[]
): number {
  const value = database.prepare(sql).get(...parameters)?.[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be returned as a safe integer`);
  }
  return value;
}

function storageErrorWithCode(code: SqliteStorageError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof SqliteStorageError);
    assert.equal(error.code, code);
    return true;
  };
}

function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = work();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function seedTenant(database: DatabaseSync, sequence: number, projectKey: string): TenantFixture {
  const accountId = identifier(sequence);
  const userId = identifier(sequence + 1);
  const projectId = identifier(sequence + 2);

  database
    .prepare(
      `INSERT INTO accounts(
        id, slug, display_name, status, created_at, updated_at, version
      ) VALUES (?, ?, ?, 'active', ?, ?, 1)`,
    )
    .run(accountId, `tenant-${sequence}`, `Tenant ${sequence}`, STAMP, STAMP);
  database
    .prepare(
      `INSERT INTO users(
        id, account_id, email, display_name, status, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
    )
    .run(
      userId,
      accountId,
      `tester-${sequence}@example.invalid`,
      `Tester ${sequence}`,
      STAMP,
      STAMP,
    );
  database
    .prepare(
      `INSERT INTO projects(
        id, account_id, project_key, name, status, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
    )
    .run(projectId, accountId, projectKey, `Project ${projectKey}`, STAMP, STAMP);

  return { accountId, projectId, projectKey, userId };
}

function createBug(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  title = "Preexisting migration bug",
): InsertedBugIdentity {
  return transaction(database, () =>
    insertBugWithNextNumber(database, {
      id: bugId,
      accountId: tenant.accountId,
      projectId: tenant.projectId,
      title,
      description: "Migration and isolation test description",
      expectedBehavior: "The durable record remains valid",
      severity: "S2",
      priority: "P2",
      reporterId: tenant.userId,
      createdAt: STAMP,
    }),
  );
}

test("browser identity ignores time expiry but still honors explicit revocation", async () => {
  await withDatabase(async ({ database, databaseFile }) => {
    await migrateSqliteDatabase(database, databaseFile);
    const tenant = seedTenant(database, 50, "IDENTITY");
    const tokenDigest = "a".repeat(64);
    transaction(database, () =>
      createBrowserSession(database, {
        accountId: tenant.accountId,
        userId: tenant.userId,
        sessionId: identifier(53),
        tokenDigest,
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-02T00:00:00.000Z",
      }),
    );

    assert.equal(
      resolveBrowserSession(database, {
        tokenDigest,
        now: "2036-01-01T00:00:00.000Z",
      })?.userId,
      tenant.userId,
    );

    transaction(database, () =>
      revokeBrowserSession(database, {
        tokenDigest,
        now: "2036-01-01T00:00:00.000Z",
        reason: "logout",
      }),
    );
    assert.equal(
      resolveBrowserSession(database, {
        tokenDigest,
        now: "2036-01-01T00:00:01.000Z",
      }),
      null,
    );
  });
});

function insertSystemEvent(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  eventId: string,
  aggregateSequence = 1,
): void {
  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_user_id,
        aggregate_type, aggregate_id, aggregate_sequence, resource_type,
        resource_id, resource_version_after, correlation_id, payload_json, created_at
      ) VALUES (
        ?, ?, ?, ?, 'bug.reported', 'qa_hub', 'user', ?,
        'bug', ?, ?, 'bug', ?, 1, ?, '{}', ?
      )`,
    )
    .run(
      eventId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      tenant.userId,
      bugId,
      aggregateSequence,
      bugId,
      eventId,
      STAMP,
    );
}

function insertBuildDecisionEvent(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  requirementId: string,
  eventId: string,
): void {
  const requestDigest = "b".repeat(64);
  const deliveredCommitSha = "a".repeat(40);
  const payload = JSON.stringify({
    status: "delivered",
    repairAttemptId: attemptId,
    commitSha: deliveredCommitSha,
    fromVersion: 2,
    toVersion: 3,
  });

  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
        resource_type, resource_id, resource_version_after, request_digest,
        correlation_id, payload_json, created_at
      ) VALUES (
        ?, ?, ?, ?, 'repair_attempt.delivered', 'qa_hub', 'user', ?,
        'repair_attempt', ?, 1, 'build_requirement', ?, 1, ?, ?, ?, ?
      )`,
    )
    .run(
      eventId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      tenant.userId,
      attemptId,
      requirementId,
      requestDigest,
      eventId,
      payload,
      STAMP,
    );
}

function insertRepairAttempt(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
): void {
  const attemptSequence = Number(attemptId.slice(-12));
  const membershipId = identifier(8_000_000 + attemptSequence);
  const createdAt = "2026-08-24T23:58:00.000Z";
  const startedAt = "2026-08-24T23:59:00.000Z";
  database
    .prepare(
      `INSERT INTO memberships(
        id, account_id, project_id, user_id, status, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
    )
    .run(membershipId, tenant.accountId, tenant.projectId, tenant.userId, createdAt, createdAt);
  database
    .prepare(
      `INSERT INTO membership_roles(
        account_id, project_id, membership_id, role, granted_at
      ) VALUES (?, ?, ?, 'developer', ?)`,
    )
    .run(tenant.accountId, tenant.projectId, membershipId, createdAt);
  const insertLifecycleEvent = database.prepare(
    `INSERT INTO events(
      id, account_id, project_id, bug_id, type, source, actor_type,
      actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
      resource_type, resource_id, resource_version_after, request_digest,
      correlation_id, from_state, to_state, payload_json, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, 'qa_hub', 'user', ?, 'repair_attempt', ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`,
  );
  insertLifecycleEvent.run(
    identifier(8_100_000 + attemptSequence * 10 + 1),
    tenant.accountId,
    tenant.projectId,
    bugId,
    "repair_attempt.created",
    tenant.userId,
    attemptId,
    80_000_000 + attemptSequence * 10 + 1,
    "repair_attempt",
    attemptId,
    1,
    "c".repeat(64),
    identifier(8_200_000 + attemptSequence * 10 + 1),
    "ready",
    "in_progress",
    JSON.stringify({ status: "planned", repairAttemptId: attemptId, fromVersion: 1, toVersion: 2 }),
    createdAt,
  );
  database
    .prepare(
      `INSERT INTO repair_attempts(
        id, account_id, project_id, bug_id, sequence, mode, status,
        assignee_id, summary, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, 1, 'human', 'planned', ?, 'Fixture repair', ?, ?, 1)`,
    )
    .run(attemptId, tenant.accountId, tenant.projectId, bugId, tenant.userId, createdAt, createdAt);
  insertLifecycleEvent.run(
    identifier(8_100_000 + attemptSequence * 10 + 2),
    tenant.accountId,
    tenant.projectId,
    bugId,
    "repair_attempt.started",
    tenant.userId,
    attemptId,
    80_000_000 + attemptSequence * 10 + 2,
    "repair_attempt",
    attemptId,
    2,
    "d".repeat(64),
    identifier(8_200_000 + attemptSequence * 10 + 2),
    null,
    null,
    JSON.stringify({ status: "running", repairAttemptId: attemptId, fromVersion: 1, toVersion: 2 }),
    startedAt,
  );
  database
    .prepare(
      `UPDATE repair_attempts
       SET status = 'running', updated_at = ?, version = 2
       WHERE id = ? AND version = 1`,
    )
    .run(startedAt, attemptId);
  insertLifecycleEvent.run(
    identifier(8_100_000 + attemptSequence * 10 + 3),
    tenant.accountId,
    tenant.projectId,
    bugId,
    "repair_attempt.delivered",
    tenant.userId,
    attemptId,
    80_000_000 + attemptSequence * 10 + 3,
    "build_requirement",
    identifier(8_900_000 + attemptSequence),
    1,
    "e".repeat(64),
    identifier(8_200_000 + attemptSequence * 10 + 3),
    "in_progress",
    "awaiting_build",
    JSON.stringify({
      status: "delivered",
      repairAttemptId: attemptId,
      commitSha: "a".repeat(40),
      fromVersion: 2,
      toVersion: 3,
    }),
    STAMP,
  );
  database
    .prepare(
      `UPDATE repair_attempts
       SET status = 'delivered', summary = 'Fixture delivery', branch = 'main', commit_sha = ?,
           updated_at = ?, version = 3
       WHERE id = ? AND version = 2`,
    )
    .run("a".repeat(40), STAMP, attemptId);
}

interface BuildRequirementInput {
  readonly deliveredCommitSha: string | null;
  readonly decisionBasis:
    "code_requires_build" | "no_code_delivery" | "authorized_no_build_exemption";
  readonly decisionReason: string | null;
  readonly linkedBuildId?: string | null;
  readonly linkId?: string | null;
  readonly requirement: "required" | "not_required";
  readonly version: 1 | 2;
}

function insertBuildRequirement(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  eventId: string,
  requirementId: string,
  input: BuildRequirementInput,
): void {
  const membershipId = identifier(Number(requirementId.slice(-12)) + 700_000);
  database
    .prepare(
      `INSERT OR IGNORE INTO memberships(
        id, account_id, project_id, user_id, status, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
    )
    .run(membershipId, tenant.accountId, tenant.projectId, tenant.userId, STAMP, STAMP);
  const effectiveMembershipId = String(
    database
      .prepare(
        `SELECT id FROM memberships
         WHERE account_id = ? AND project_id = ? AND user_id = ?`,
      )
      .get(tenant.accountId, tenant.projectId, tenant.userId)?.id ?? membershipId,
  );
  database
    .prepare(
      `INSERT OR IGNORE INTO membership_roles(
        account_id, project_id, membership_id, role, granted_at
      ) VALUES (?, ?, ?, 'developer', ?)`,
    )
    .run(tenant.accountId, tenant.projectId, effectiveMembershipId, STAMP);
  database
    .prepare(
      `INSERT INTO build_requirements(
        id, account_id, project_id, bug_id, repair_attempt_id,
        source_delivery_version, delivered_commit_sha, requirement, decision_basis,
        decision_reason, decision_actor_id, decision_audit_event_id,
        delivery_request_digest, linked_build_id, link_id, policy_version,
        bug_version_at_delivery, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, 3, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1.0.0', 1, ?, ?, ?)`,
    )
    .run(
      requirementId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      attemptId,
      input.deliveredCommitSha,
      input.requirement,
      input.decisionBasis,
      input.decisionReason,
      tenant.userId,
      eventId,
      "b".repeat(64),
      input.linkedBuildId ?? null,
      input.linkId ?? null,
      STAMP,
      STAMP,
      input.version,
    );
}

test("empty migration is repeatable and enables WAL, foreign keys, and integrity checks", async () => {
  await withDatabase(async ({ database, databaseFile }) => {
    const first = await migrateSqliteDatabase(database, databaseFile);
    assert.deepEqual(first, {
      fromVersion: 0,
      toVersion: SQLITE_SCHEMA_VERSION,
      appliedVersions: SQLITE_MIGRATIONS.map(({ version }) => version),
      backupPath: null,
    });
    assert.equal(currentSqliteSchemaVersion(database), SQLITE_SCHEMA_VERSION);
    assert.equal(
      numberColumn(database, "PRAGMA application_id", "application_id"),
      QA_HUB_SQLITE_APPLICATION_ID,
    );
    assert.equal(numberColumn(database, "PRAGMA foreign_keys", "foreign_keys"), 1);
    assert.equal(
      String(database.prepare("PRAGMA journal_mode").get()?.journal_mode).toLowerCase(),
      "wal",
    );
    assert.deepEqual(verifySqliteIntegrity(database), {
      foreignKeyViolations: [],
      integrityMessages: ["ok"],
      ok: true,
    });

    const second = await migrateSqliteDatabase(database, databaseFile);
    assert.deepEqual(second, {
      fromVersion: SQLITE_SCHEMA_VERSION,
      toVersion: SQLITE_SCHEMA_VERSION,
      appliedVersions: [],
      backupPath: null,
    });
    assert.equal(
      numberColumn(database, "SELECT count(*) AS count FROM schema_migrations", "count"),
      SQLITE_SCHEMA_VERSION,
    );
  });
});

test("v6 through v11 preserves existing Bugs and adds shared management and Relay lifecycle facts", async () => {
  await withDatabase(async ({ database, databaseFile, root }) => {
    const initial = await migrateSqliteDatabase(database, databaseFile, { targetVersion: 6 });
    assert.equal(initial.toVersion, 6);
    const tenant = seedTenant(database, 75, "SHARED");
    const bugId = identifier(78);
    createBug(database, tenant, bugId, "Existing Bug before shared management");

    const upgraded = await migrateSqliteDatabase(database, databaseFile, {
      backupRoot: join(root, "backups"),
      targetVersion: 7,
    });
    assert.deepEqual(upgraded.appliedVersions, [7]);
    assert.equal(upgraded.fromVersion, 6);
    assert.equal(upgraded.toVersion, 7);
    assert.equal(currentSqliteSchemaVersion(database), 7);
    const completed = await migrateSqliteDatabase(database, databaseFile, {
      backupRoot: join(root, "backups"),
    });
    assert.deepEqual(completed.appliedVersions, [8, 9, 10, 11]);
    assert.equal(completed.fromVersion, 7);
    assert.equal(completed.toVersion, SQLITE_SCHEMA_VERSION);
    assert.equal(currentSqliteSchemaVersion(database), SQLITE_SCHEMA_VERSION);
    assert.equal(
      numberColumn(database, "SELECT count(*) AS count FROM bugs WHERE id = ?", "count", bugId),
      1,
    );
    assert.equal(
      numberColumn(
        database,
        "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'bug_deletions'",
        "count",
      ),
      1,
    );
    assert.equal(verifySqliteIntegrity(database).ok, true);
  });
});

test("v1 to v2 migration creates a backup and backfills full-text search", async () => {
  await withDatabase(async ({ database, databaseFile, root }) => {
    const v1 = await migrateSqliteDatabase(database, databaseFile, { targetVersion: 1 });
    assert.deepEqual(v1.appliedVersions, [1]);
    const tenant = seedTenant(database, 100, "MIG");
    const bugId = identifier(110);
    createBug(database, tenant, bugId, "Preexisting searchable migration record");

    const backupRoot = join(root, "verified-backups");
    const upgrade = await migrateSqliteDatabase(database, databaseFile, {
      backupRoot,
      targetVersion: 2,
    });
    assert.deepEqual(upgrade.appliedVersions, [2]);
    assert.equal(upgrade.fromVersion, 1);
    assert.equal(upgrade.toVersion, 2);
    assert.ok(upgrade.backupPath);
    assert.ok(existsSync(upgrade.backupPath));
    assert.equal(
      numberColumn(
        database,
        "SELECT count(*) AS count FROM bugs_fts WHERE bugs_fts MATCH ?",
        "count",
        "searchable",
      ),
      1,
    );

    const backupDatabase = new DatabaseSync(upgrade.backupPath, { readOnly: true });
    try {
      assert.equal(numberColumn(backupDatabase, "PRAGMA user_version", "user_version"), 1);
      assert.equal(numberColumn(backupDatabase, "SELECT count(*) AS count FROM bugs", "count"), 1);
      assert.equal(
        numberColumn(
          backupDatabase,
          "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'bugs_fts'",
          "count",
        ),
        0,
      );
    } finally {
      backupDatabase.close();
    }
  });
});

test("v2 to v3 adds durable RepairAttempt failure truth without rewriting history", async () => {
  await withDatabase(async ({ database, databaseFile, root }) => {
    await migrateSqliteDatabase(database, databaseFile, { targetVersion: 2 });
    const tenant = seedTenant(database, 150, "FWD");
    const bugId = identifier(160);
    const attemptId = identifier(161);
    createBug(database, tenant, bugId, "Forward failure-reason migration record");
    insertRepairAttempt(database, tenant, bugId, attemptId);

    const backupRoot = join(root, "v2-backups");
    const upgrade = await migrateSqliteDatabase(database, databaseFile, {
      backupRoot,
      targetVersion: 3,
    });
    assert.deepEqual(upgrade.appliedVersions, [3]);
    assert.equal(upgrade.fromVersion, 2);
    assert.equal(upgrade.toVersion, 3);
    assert.ok(upgrade.backupPath);
    assert.ok(existsSync(upgrade.backupPath));
    assert.equal(
      numberColumn(
        database,
        "SELECT count(*) AS count FROM pragma_table_info('repair_attempts') WHERE name = 'failure_reason'",
        "count",
      ),
      1,
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT status, failure_reason AS failureReason, version
             FROM repair_attempts WHERE id = ?`,
          )
          .get(attemptId),
      },
      { failureReason: null, status: "delivered", version: 3 },
    );

    const backupDatabase = new DatabaseSync(upgrade.backupPath, { readOnly: true });
    try {
      assert.equal(numberColumn(backupDatabase, "PRAGMA user_version", "user_version"), 2);
      assert.equal(
        numberColumn(
          backupDatabase,
          "SELECT count(*) AS count FROM pragma_table_info('repair_attempts') WHERE name = 'failure_reason'",
          "count",
        ),
        0,
      );
    } finally {
      backupDatabase.close();
    }
    assert.deepEqual(verifySqliteIntegrity(database).integrityMessages, ["ok"]);
  });
});

test("two worker upgraders re-read locked history and apply every pending migration exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-qa-hub-upgrade-race-"));
  const databaseFile = join(root, "db", "qa-hub.sqlite");
  const seedDatabase = openSqliteDatabaseForWorker({
    databaseFile,
    busyTimeoutMs: 5_000,
  });
  let first: SqliteStorageWorker | undefined;
  let second: SqliteStorageWorker | undefined;
  try {
    await migrateSqliteDatabase(seedDatabase, databaseFile, { targetVersion: 1 });
    seedDatabase.close();

    first = new SqliteStorageWorker({
      databaseFile,
      busyTimeoutMs: 5_000,
      backupRoot: join(root, "first-backups"),
    });
    second = new SqliteStorageWorker({
      databaseFile,
      busyTimeoutMs: 5_000,
      backupRoot: join(root, "second-backups"),
    });
    const reports = await Promise.all([first.initialization, second.initialization]);
    assert.equal(
      reports
        .flatMap(({ migration }) => migration.appliedVersions)
        .filter((version) => version === 2).length,
      1,
    );
    assert.equal(
      reports
        .flatMap(({ migration }) => migration.appliedVersions)
        .filter((version) => version === 3).length,
      1,
    );
    assert.ok(reports.every(({ migration }) => migration.toVersion === SQLITE_SCHEMA_VERSION));
    assert.ok(
      reports
        .map(({ migration }) => migration.backupPath)
        .filter((path): path is string => path !== null)
        .every((path) => existsSync(path)),
    );
    assert.deepEqual(await first.integrity(), {
      foreignKeyViolations: [],
      integrityMessages: ["ok"],
      ok: true,
    });
  } finally {
    await Promise.allSettled([first?.close(), second?.close()]);
    closeDatabase(seedDatabase);
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration checksum drift is rejected before application code can continue", async () => {
  await withDatabase(async ({ database, databaseFile }) => {
    await migrateSqliteDatabase(database, databaseFile);
    database.exec("DROP TRIGGER schema_migrations_no_update");
    database
      .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
      .run("f".repeat(64));

    await assert.rejects(
      migrateSqliteDatabase(database, databaseFile),
      storageErrorWithCode("SQLITE_MIGRATION_CHECKSUM_MISMATCH"),
    );
  });
});

test("future on-disk schemas and requested downgrades are rejected explicitly", async () => {
  await withDatabase(async ({ database, databaseFile }) => {
    await migrateSqliteDatabase(database, databaseFile);
    const futureVersion = SQLITE_SCHEMA_VERSION + 1;
    database
      .prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at, duration_ms)
         VALUES (?, 'future_schema', ?, ?, 0)`,
      )
      .run(futureVersion, "e".repeat(64), STAMP);
    database.exec(`PRAGMA user_version = ${futureVersion}`);

    await assert.rejects(
      migrateSqliteDatabase(database, databaseFile),
      storageErrorWithCode("SQLITE_SCHEMA_FUTURE_VERSION"),
    );
  });

  await withDatabase(async ({ database, databaseFile }) => {
    await migrateSqliteDatabase(database, databaseFile);
    await assert.rejects(
      migrateSqliteDatabase(database, databaseFile, { targetVersion: 1 }),
      storageErrorWithCode("SQLITE_SCHEMA_DOWNGRADE_REJECTED"),
    );
  });
});

test("a conflict late in a migration rolls back every object and history change", async () => {
  await withDatabase(async ({ database, databaseFile, root }) => {
    await migrateSqliteDatabase(database, databaseFile, { targetVersion: 1 });
    const tenant = seedTenant(database, 200, "RBK");
    createBug(database, tenant, identifier(210), "Rollback searchable record");
    database.exec(String.raw`
      CREATE TRIGGER bugs_fts_update
      AFTER UPDATE OF title ON bugs
      BEGIN
        SELECT 1;
      END;
    `);

    await assert.rejects(
      migrateSqliteDatabase(database, databaseFile, {
        backupRoot: join(root, "failed-upgrade-backups"),
      }),
      /trigger bugs_fts_update already exists/i,
    );
    assert.equal(currentSqliteSchemaVersion(database), 1);
    assert.deepEqual(
      database
        .prepare(
          `SELECT type, name FROM sqlite_schema
           WHERE name LIKE 'bugs_fts%' ORDER BY type, name`,
        )
        .all()
        .map((row) => ({ type: String(row.type), name: String(row.name) })),
      [{ type: "trigger", name: "bugs_fts_update" }],
    );
    assert.equal(
      numberColumn(database, "SELECT count(*) AS count FROM schema_migrations", "count"),
      1,
    );
    assert.deepEqual(verifySqliteIntegrity(database).integrityMessages, ["ok"]);

    database.exec("DROP TRIGGER bugs_fts_update");
    const recovered = await migrateSqliteDatabase(database, databaseFile, {
      backupRoot: join(root, "recovered-upgrade-backups"),
    });
    assert.deepEqual(
      recovered.appliedVersions,
      SQLITE_MIGRATIONS.filter(({ version }) => version > 1).map(({ version }) => version),
    );
    assert.equal(
      numberColumn(
        database,
        "SELECT count(*) AS count FROM bugs_fts WHERE bugs_fts MATCH 'rollback'",
        "count",
      ),
      1,
    );
  });
});

test("composite foreign keys reject cross-account and cross-project records", async () => {
  await withDatabase(async ({ database, databaseFile }) => {
    await migrateSqliteDatabase(database, databaseFile);
    const tenantA = seedTenant(database, 300, "TENA");
    const tenantB = seedTenant(database, 400, "TENB");

    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO bugs(
              id, account_id, project_id, number, key, title, description,
              expected_behavior, state, severity, priority, reporter_id,
              occurrence_count, reopen_count, created_at, updated_at, version
            ) VALUES (
              ?, ?, ?, 1, 'TENA-1', 'Foreign project bug', 'Must be rejected',
              'No cross-scope row', 'reported', 'S2', 'P2', ?, 1, 0, ?, ?, 1
            )`,
          )
          .run(identifier(310), tenantA.accountId, tenantB.projectId, tenantA.userId, STAMP, STAMP),
      /FOREIGN KEY constraint failed/i,
    );
    assert.equal(numberColumn(database, "SELECT count(*) AS count FROM bugs", "count"), 0);

    const valid = createBug(database, tenantA, identifier(311));
    assert.equal(valid.key, "TENA-1");
    assert.deepEqual(verifySqliteIntegrity(database).foreignKeyViolations, []);
  });
});

test("events are append-only at the database boundary", async () => {
  await withDatabase(async ({ database, databaseFile }) => {
    await migrateSqliteDatabase(database, databaseFile);
    const tenant = seedTenant(database, 500, "EVT");
    const bugId = identifier(510);
    const eventId = identifier(511);
    createBug(database, tenant, bugId);
    insertSystemEvent(database, tenant, bugId, eventId);

    assert.throws(
      () =>
        database
          .prepare("UPDATE events SET payload_json = ? WHERE id = ?")
          .run('{"tampered":true}', eventId),
      /events are append-only/i,
    );
    assert.throws(
      () => database.prepare("DELETE FROM events WHERE id = ?").run(eventId),
      /events are append-only/i,
    );
    assert.equal(
      database.prepare("SELECT payload_json FROM events WHERE id = ?").get(eventId)?.payload_json,
      "{}",
    );
  });
});

test("BuildRequirement rejects impossible states and freezes its decision audit", async () => {
  await withDatabase(async ({ database, databaseFile }) => {
    await migrateSqliteDatabase(database, databaseFile);
    const tenant = seedTenant(database, 600, "BLD");
    const bugId = identifier(610);
    const attemptId = identifier(611);
    const eventId = identifier(612);
    const requirementId = identifier(613);
    createBug(database, tenant, bugId);
    insertRepairAttempt(database, tenant, bugId, attemptId);
    insertBuildDecisionEvent(database, tenant, bugId, attemptId, requirementId, eventId);

    assert.throws(
      () =>
        insertBuildRequirement(database, tenant, bugId, attemptId, eventId, requirementId, {
          deliveredCommitSha: null,
          requirement: "required",
          decisionBasis: "code_requires_build",
          decisionReason: null,
          version: 1,
        }),
      /CHECK constraint failed|typed delivery audit/i,
    );
    assert.throws(
      () =>
        insertBuildRequirement(database, tenant, bugId, attemptId, eventId, requirementId, {
          deliveredCommitSha: "a".repeat(40),
          requirement: "not_required",
          decisionBasis: "no_code_delivery",
          decisionReason: "No executable change",
          version: 1,
        }),
      /CHECK constraint failed|typed delivery audit/i,
    );
    assert.throws(
      () =>
        insertBuildRequirement(database, tenant, bugId, attemptId, eventId, requirementId, {
          deliveredCommitSha: "a".repeat(40),
          requirement: "required",
          decisionBasis: "code_requires_build",
          decisionReason: null,
          version: 2,
        }),
      /CHECK constraint failed|typed delivery audit/i,
    );

    insertBuildRequirement(database, tenant, bugId, attemptId, eventId, requirementId, {
      deliveredCommitSha: "a".repeat(40),
      requirement: "required",
      decisionBasis: "code_requires_build",
      decisionReason: null,
      version: 1,
    });
    assert.throws(
      () =>
        database
          .prepare("UPDATE build_requirements SET delivery_request_digest = ? WHERE id = ?")
          .run("c".repeat(64), requirementId),
      /immutable/i,
    );
    assert.equal(
      database
        .prepare("SELECT delivery_request_digest FROM build_requirements WHERE id = ?")
        .get(requirementId)?.delivery_request_digest,
      "b".repeat(64),
    );
  });
});

test("dedicated worker serializes 50 concurrent bug creates into unique project numbers", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-qa-hub-worker-"));
  const databaseFile = join(root, "db", "qa-hub.sqlite");
  const seedDatabase = openSqliteDatabaseForWorker({
    databaseFile,
    busyTimeoutMs: 5_000,
  });
  let worker: SqliteStorageWorker | undefined;
  let workerClosed = false;
  try {
    await migrateSqliteDatabase(seedDatabase, databaseFile);
    const tenant = seedTenant(seedDatabase, 700, "CON");
    seedDatabase.close();

    worker = new SqliteStorageWorker({
      databaseFile,
      busyTimeoutMs: 5_000,
      backupRoot: join(root, "migration-backups"),
      allowUnsafeTestCommands: true,
    });
    const initialization = await worker.initialization;
    assert.deepEqual(initialization.migration.appliedVersions, []);
    assert.match(initialization.migrationDigest, /^[0-9a-f]{64}$/);

    const requests: readonly NewBugStorageRecord[] = Array.from({ length: 50 }, (_, index) => ({
      id: identifier(800 + index),
      accountId: tenant.accountId,
      projectId: tenant.projectId,
      title: `Concurrent bug ${index + 1}`,
      description: "Concurrent worker allocation test",
      expectedBehavior: "Every request gets exactly one unique project number",
      severity: "S2",
      priority: "P2",
      reporterId: tenant.userId,
      createdAt: STAMP,
    }));
    const identities = await Promise.all(
      requests.map((record) => worker!.createBugForMigrationTest(record)),
    );
    assert.deepEqual(
      identities.map(({ number }) => number).sort((left, right) => left - right),
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    assert.equal(new Set(identities.map(({ key }) => key)).size, 50);
    assert.deepEqual(await worker.integrity(), {
      foreignKeyViolations: [],
      integrityMessages: ["ok"],
      ok: true,
    });

    await worker.close();
    workerClosed = true;

    const verificationDatabase = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      assert.equal(
        numberColumn(
          verificationDatabase,
          "SELECT count(*) AS count FROM bugs WHERE account_id = ? AND project_id = ?",
          "count",
          tenant.accountId,
          tenant.projectId,
        ),
        50,
      );
      const numberSummary = verificationDatabase
        .prepare(
          `SELECT min(number) AS minimum, max(number) AS maximum,
                  count(DISTINCT number) AS distinct_count
           FROM bugs WHERE account_id = ? AND project_id = ?`,
        )
        .get(tenant.accountId, tenant.projectId);
      assert.equal(numberSummary?.minimum, 1);
      assert.equal(numberSummary?.maximum, 50);
      assert.equal(numberSummary?.distinct_count, 50);
      assert.equal(
        numberColumn(
          verificationDatabase,
          `SELECT last_number AS value FROM project_bug_counters
           WHERE account_id = ? AND project_id = ?`,
          "value",
          tenant.accountId,
          tenant.projectId,
        ),
        50,
      );
      assert.equal(
        numberColumn(
          verificationDatabase,
          "SELECT count(*) AS count FROM bugs_fts WHERE bugs_fts MATCH 'concurrent'",
          "count",
        ),
        50,
      );
    } finally {
      verificationDatabase.close();
    }
  } finally {
    closeDatabase(seedDatabase);
    if (worker && !workerClosed) await worker.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unexpected worker exit is terminal and every later request fails promptly", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-qa-hub-worker-terminal-"));
  const databaseFile = join(root, "db", "qa-hub.sqlite");
  const seedDatabase = openSqliteDatabaseForWorker({
    databaseFile,
    busyTimeoutMs: 5_000,
  });
  let worker: SqliteStorageWorker | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await migrateSqliteDatabase(seedDatabase, databaseFile);
    seedDatabase.close();
    worker = new SqliteStorageWorker({
      databaseFile,
      busyTimeoutMs: 5_000,
      allowUnsafeTestCommands: true,
    });
    await worker.initialization;
    await worker.terminateForMigrationTest();

    const promptFailure = Promise.race([
      worker.integrity(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("SQLite worker request hung after terminal exit")),
          500,
        );
      }),
    ]);
    await assert.rejects(
      promptFailure,
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "SQLITE_WORKER_EXITED",
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    closeDatabase(seedDatabase);
    if (worker) await worker.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
