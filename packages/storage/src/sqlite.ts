import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  backup,
  constants as sqliteConstants,
  DatabaseSync,
  type StatementSync,
} from "node:sqlite";

import {
  SQLITE_MIGRATIONS,
  SQLITE_SCHEMA_VERSION,
  type SqliteMigration,
} from "./sqlite-migrations.js";

export const QA_HUB_SQLITE_APPLICATION_ID = 0x51414842;

export class SqliteStorageError extends Error {
  constructor(
    readonly code:
      | "SQLITE_APPLICATION_ID_MISMATCH"
      | "SQLITE_ATTACHMENT_RESERVATION_INVALID"
      | "SQLITE_CONFIGURATION_INVALID"
      | "SQLITE_FTS5_UNAVAILABLE"
      | "SQLITE_INTEGRITY_FAILED"
      | "SQLITE_MIGRATION_CHECKSUM_MISMATCH"
      | "SQLITE_MIGRATION_HISTORY_INVALID"
      | "SQLITE_MOBILE_SCOPE_CONFLICT"
      | "SQLITE_EFFECT_MISSING"
      | "SQLITE_IDEMPOTENCY_MISMATCH"
      | "SQLITE_MVP_ATTACHMENT_UNSUPPORTED"
      | "SQLITE_SCHEMA_DOWNGRADE_REJECTED"
      | "SQLITE_SCHEMA_FUTURE_VERSION"
      | "SQLITE_TRANSACTION_REQUIRED"
      | "SQLITE_UPLOAD_INVALID"
      | "SQLITE_UPLOAD_NOT_FOUND"
      | "SQLITE_UPLOAD_VERSION_CONFLICT"
      | "SQLITE_PROJECT_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "SqliteStorageError";
  }
}

export interface OpenSqliteOptions {
  readonly databaseFile: string;
  readonly busyTimeoutMs: number;
}

export interface MigrationOptions {
  readonly targetVersion?: number;
  readonly backupRoot?: string;
}

export interface MigrationReport {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly appliedVersions: readonly number[];
  readonly backupPath: string | null;
}

export interface SqliteIntegrityReport {
  readonly foreignKeyViolations: readonly Record<string, unknown>[];
  readonly integrityMessages: readonly string[];
  readonly ok: boolean;
}

interface MigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

interface NumberRow {
  readonly value: number;
}

const MIGRATION_BOOTSTRAP_SQL = String.raw`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 120),
  checksum TEXT NOT NULL UNIQUE CHECK (length(checksum) = 64 AND checksum = lower(checksum)),
  applied_at TEXT NOT NULL CHECK (length(applied_at) >= 20),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0)
) STRICT;

CREATE TRIGGER IF NOT EXISTS schema_migrations_no_update
BEFORE UPDATE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'schema migration history is append-only');
END;

CREATE TRIGGER IF NOT EXISTS schema_migrations_no_delete
BEFORE DELETE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'schema migration history is append-only');
END;
`;

function numberFromRow(row: Record<string, unknown> | undefined, field: string): number {
  const value = row?.[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SqliteStorageError(
      "SQLITE_MIGRATION_HISTORY_INVALID",
      `SQLite did not return an integer ${field}`,
    );
  }
  return value;
}

function readPragmaInteger(database: DatabaseSync, pragma: string, field: string): number {
  return numberFromRow(database.prepare(`PRAGMA ${pragma}`).get(), field);
}

function transaction(database: DatabaseSync, work: () => void): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    work();
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function bootstrapMigrationHistory(database: DatabaseSync): void {
  transaction(database, () => {
    const applicationId = readPragmaInteger(database, "application_id", "application_id");
    const existingApplicationTables = numberFromRow(
      database
        .prepare(
          `SELECT count(*) AS value
           FROM sqlite_schema
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
        .get(),
      "value",
    );
    const hasMigrationHistory =
      numberFromRow(
        database
          .prepare(
            `SELECT count(*) AS value
             FROM sqlite_schema
             WHERE type = 'table' AND name = 'schema_migrations'`,
          )
          .get(),
        "value",
      ) === 1;
    if (applicationId === 0) {
      if (existingApplicationTables > 0) {
        throw new SqliteStorageError(
          "SQLITE_APPLICATION_ID_MISMATCH",
          "refusing to adopt a non-empty SQLite database without the QA Hub application_id",
        );
      }
      database.exec(`PRAGMA application_id = ${QA_HUB_SQLITE_APPLICATION_ID}`);
    } else if (applicationId !== QA_HUB_SQLITE_APPLICATION_ID) {
      throw new SqliteStorageError(
        "SQLITE_APPLICATION_ID_MISMATCH",
        `database application_id ${applicationId} does not belong to QA Hub`,
      );
    } else if (!hasMigrationHistory && existingApplicationTables > 0) {
      throw new SqliteStorageError(
        "SQLITE_MIGRATION_HISTORY_INVALID",
        "QA Hub database contains application tables but no migration history",
      );
    }
    database.exec(MIGRATION_BOOTSTRAP_SQL);
  });
}

function readMigrationHistory(database: DatabaseSync): readonly MigrationRow[] {
  return database
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => ({
      version: numberFromRow(row, "version"),
      name: String(row.name),
      checksum: String(row.checksum),
    }));
}

function validateMigrationHistory(
  database: DatabaseSync,
  migrations: readonly SqliteMigration[],
): number {
  const rows = readMigrationHistory(database);
  const userVersion = readPragmaInteger(database, "user_version", "user_version");

  if (
    userVersion > SQLITE_SCHEMA_VERSION ||
    rows.some(({ version }) => version > SQLITE_SCHEMA_VERSION)
  ) {
    throw new SqliteStorageError(
      "SQLITE_SCHEMA_FUTURE_VERSION",
      `database schema is newer than supported ${SQLITE_SCHEMA_VERSION}`,
    );
  }

  for (const [index, row] of rows.entries()) {
    const expected = migrations[index];
    if (!expected || row.version !== expected.version || row.name !== expected.name) {
      throw new SqliteStorageError(
        "SQLITE_MIGRATION_HISTORY_INVALID",
        `migration history diverges at version ${row.version}`,
      );
    }
    if (row.checksum !== expected.checksum) {
      throw new SqliteStorageError(
        "SQLITE_MIGRATION_CHECKSUM_MISMATCH",
        `migration ${row.version} checksum does not match the frozen source`,
      );
    }
  }

  const historyVersion = rows.at(-1)?.version ?? 0;
  if (userVersion !== historyVersion) {
    throw new SqliteStorageError(
      "SQLITE_MIGRATION_HISTORY_INVALID",
      `PRAGMA user_version ${userVersion} does not match migration history ${historyVersion}`,
    );
  }
  return historyVersion;
}

function assertTargetVersion(currentVersion: number, targetVersion: number): void {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0) {
    throw new SqliteStorageError(
      "SQLITE_MIGRATION_HISTORY_INVALID",
      `invalid target schema version ${targetVersion}`,
    );
  }
  if (currentVersion > SQLITE_SCHEMA_VERSION) {
    throw new SqliteStorageError(
      "SQLITE_SCHEMA_FUTURE_VERSION",
      `database schema ${currentVersion} is newer than supported ${SQLITE_SCHEMA_VERSION}`,
    );
  }
  if (targetVersion > SQLITE_SCHEMA_VERSION) {
    throw new SqliteStorageError(
      "SQLITE_SCHEMA_FUTURE_VERSION",
      `target schema ${targetVersion} is newer than supported ${SQLITE_SCHEMA_VERSION}`,
    );
  }
  if (targetVersion < currentVersion) {
    throw new SqliteStorageError(
      "SQLITE_SCHEMA_DOWNGRADE_REJECTED",
      `schema downgrade ${currentVersion} -> ${targetVersion} is not supported`,
    );
  }
}

function applyMigration(database: DatabaseSync, migration: SqliteMigration): boolean {
  let applied = false;
  transaction(database, () => {
    const lockedVersion = validateMigrationHistory(database, SQLITE_MIGRATIONS);
    if (lockedVersion >= migration.version) return;
    if (lockedVersion !== migration.version - 1) {
      throw new SqliteStorageError(
        "SQLITE_MIGRATION_HISTORY_INVALID",
        `migration ${migration.version} cannot follow locked schema ${lockedVersion}`,
      );
    }

    const startedAt = performance.now();
    database.exec("PRAGMA defer_foreign_keys = ON");
    database.exec(migration.sql);
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length > 0) {
      throw new SqliteStorageError(
        "SQLITE_INTEGRITY_FAILED",
        `migration ${migration.version} produced foreign-key violations`,
      );
    }
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    database
      .prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at, duration_ms)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)`,
      )
      .run(migration.version, migration.name, migration.checksum, durationMs);
    database.exec(`PRAGMA user_version = ${migration.version}`);
    applied = true;
  });
  return applied;
}

function compileOptions(database: DatabaseSync): ReadonlySet<string> {
  return new Set(
    database
      .prepare("PRAGMA compile_options")
      .all()
      .map((row) => String(row.compile_options)),
  );
}

const BUG_FTS_MAINTENANCE_TRIGGERS = new Set([
  "bugs_fts_insert",
  "bugs_fts_update",
  "bugs_fts_delete",
]);

function installApplicationAuthorizer(database: DatabaseSync): void {
  database.setAuthorizer((actionCode, tableName, _columnName, _databaseName, triggerOrView) => {
    const isWrite =
      actionCode === sqliteConstants.SQLITE_INSERT ||
      actionCode === sqliteConstants.SQLITE_UPDATE ||
      actionCode === sqliteConstants.SQLITE_DELETE;
    const isFtsStorage = tableName === "bugs_fts";
    if (
      isWrite &&
      isFtsStorage &&
      (triggerOrView === null || !BUG_FTS_MAINTENANCE_TRIGGERS.has(triggerOrView))
    ) {
      return sqliteConstants.SQLITE_DENY;
    }
    return sqliteConstants.SQLITE_OK;
  });
}

export function openSqliteDatabaseForWorker(options: OpenSqliteOptions): DatabaseSync {
  if (!isAbsolute(options.databaseFile) || options.databaseFile.trim().length === 0) {
    throw new SqliteStorageError(
      "SQLITE_CONFIGURATION_INVALID",
      "databaseFile must be a non-empty absolute path",
    );
  }
  if (
    !Number.isSafeInteger(options.busyTimeoutMs) ||
    options.busyTimeoutMs < 1 ||
    options.busyTimeoutMs > 60_000
  ) {
    throw new SqliteStorageError(
      "SQLITE_CONFIGURATION_INVALID",
      "busyTimeoutMs must be an integer between 1 and 60000",
    );
  }
  mkdirSync(dirname(options.databaseFile), { recursive: true });
  const database = new DatabaseSync(options.databaseFile, {
    allowExtension: false,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readBigInts: false,
    returnArrays: false,
    timeout: options.busyTimeoutMs,
  });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA trusted_schema = OFF");
  database.exec("PRAGMA recursive_triggers = ON");
  database.exec("PRAGMA temp_store = MEMORY");

  if (!compileOptions(database).has("ENABLE_FTS5")) {
    database.close();
    throw new SqliteStorageError(
      "SQLITE_FTS5_UNAVAILABLE",
      "the pinned SQLite runtime does not include FTS5",
    );
  }
  return database;
}

export function currentSqliteSchemaVersion(database: DatabaseSync): number {
  return readPragmaInteger(database, "user_version", "user_version");
}

export async function backupBeforeMigration(
  database: DatabaseSync,
  databaseFile: string,
  fromVersion: number,
  toVersion: number,
  backupRoot = join(dirname(databaseFile), "migration-backups"),
): Promise<string> {
  if (!isAbsolute(backupRoot)) {
    throw new SqliteStorageError(
      "SQLITE_CONFIGURATION_INVALID",
      "migration backupRoot must be an absolute path",
    );
  }
  mkdirSync(backupRoot, { recursive: true });
  const backupPath = join(
    backupRoot,
    `${basename(databaseFile)}.v${fromVersion}-to-v${toVersion}.${randomUUID()}.sqlite`,
  );
  await backup(database, backupPath);
  return backupPath;
}

export async function migrateSqliteDatabase(
  database: DatabaseSync,
  databaseFile: string,
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  bootstrapMigrationHistory(database);
  const fromVersion = validateMigrationHistory(database, SQLITE_MIGRATIONS);
  const targetVersion = options.targetVersion ?? SQLITE_SCHEMA_VERSION;
  assertTargetVersion(fromVersion, targetVersion);

  const backupPath =
    fromVersion > 0 && fromVersion < targetVersion
      ? await backupBeforeMigration(
          database,
          databaseFile,
          fromVersion,
          targetVersion,
          options.backupRoot,
        )
      : null;
  const appliedVersions: number[] = [];
  for (const migration of SQLITE_MIGRATIONS) {
    if (migration.version <= fromVersion || migration.version > targetVersion) continue;
    if (applyMigration(database, migration)) appliedVersions.push(migration.version);
  }

  const finalVersion = validateMigrationHistory(database, SQLITE_MIGRATIONS);
  if (finalVersion > targetVersion) {
    throw new SqliteStorageError(
      "SQLITE_SCHEMA_DOWNGRADE_REJECTED",
      `concurrent migration advanced schema to ${finalVersion} beyond target ${targetVersion}`,
    );
  }
  const integrity = verifySqliteIntegrity(database);
  if (!integrity.ok) {
    throw new SqliteStorageError(
      "SQLITE_INTEGRITY_FAILED",
      `post-migration integrity failed: ${integrity.integrityMessages.join(", ")}`,
    );
  }
  if (finalVersion === SQLITE_SCHEMA_VERSION) installApplicationAuthorizer(database);
  return Object.freeze({
    fromVersion,
    toVersion: finalVersion,
    appliedVersions: Object.freeze(appliedVersions),
    backupPath,
  });
}

export function verifySqliteIntegrity(database: DatabaseSync): SqliteIntegrityReport {
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  const integrityMessages = database
    .prepare("PRAGMA integrity_check")
    .all()
    .map((row) => String(row.integrity_check));
  return Object.freeze({
    foreignKeyViolations: Object.freeze(
      foreignKeyViolations.map((row) => Object.freeze({ ...row })),
    ),
    integrityMessages: Object.freeze(integrityMessages),
    ok:
      foreignKeyViolations.length === 0 &&
      integrityMessages.length === 1 &&
      integrityMessages[0] === "ok",
  });
}

export function reserveNextBugNumber(
  database: DatabaseSync,
  accountId: string,
  projectId: string,
): number {
  if (!database.isTransaction) {
    throw new SqliteStorageError(
      "SQLITE_TRANSACTION_REQUIRED",
      "bug number allocation must run inside the caller's write transaction",
    );
  }
  const row = database
    .prepare(
      `INSERT INTO project_bug_counters(account_id, project_id, last_number, updated_at)
       VALUES (?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(account_id, project_id) DO UPDATE SET
         last_number = project_bug_counters.last_number + 1,
         updated_at = excluded.updated_at
       RETURNING last_number AS value`,
    )
    .get(accountId, projectId) as NumberRow | undefined;
  if (!row || !Number.isSafeInteger(row.value) || row.value < 1) {
    throw new SqliteStorageError(
      "SQLITE_PROJECT_NOT_FOUND",
      "project bug counter could not be allocated",
    );
  }
  return row.value;
}

export interface NewBugStorageRecord {
  readonly id: string;
  readonly accountId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly expectedBehavior: string;
  readonly severity: "S0" | "S1" | "S2" | "S3" | "S4";
  readonly priority: "P0" | "P1" | "P2" | "P3" | "P4";
  readonly reporterId: string;
  readonly createdAt: string;
}

export interface InsertedBugIdentity {
  readonly id: string;
  readonly number: number;
  readonly key: string;
  readonly version: 1;
}

function projectKeyStatement(database: DatabaseSync): StatementSync {
  return database.prepare(
    "SELECT project_key FROM projects WHERE account_id = ? AND id = ? AND status = 'active'",
  );
}

export function insertBugWithNextNumber(
  database: DatabaseSync,
  record: NewBugStorageRecord,
): InsertedBugIdentity {
  if (!database.isTransaction) {
    throw new SqliteStorageError(
      "SQLITE_TRANSACTION_REQUIRED",
      "bug insertion must run inside the caller's write transaction",
    );
  }
  const project = projectKeyStatement(database).get(record.accountId, record.projectId);
  const projectKey = project?.project_key;
  if (typeof projectKey !== "string") {
    throw new SqliteStorageError("SQLITE_PROJECT_NOT_FOUND", "active project was not found");
  }
  const number = reserveNextBugNumber(database, record.accountId, record.projectId);
  const key = `${projectKey}-${number}`;
  database
    .prepare(
      `INSERT INTO bugs(
        id, account_id, project_id, number, key, title, description,
        expected_behavior, state, severity, priority, reporter_id,
        occurrence_count, reopen_count, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reported', ?, ?, ?, 1, 0, ?, ?, 1)`,
    )
    .run(
      record.id,
      record.accountId,
      record.projectId,
      number,
      key,
      record.title,
      record.description,
      record.expectedBehavior,
      record.severity,
      record.priority,
      record.reporterId,
      record.createdAt,
      record.createdAt,
    );
  return Object.freeze({ id: record.id, number, key, version: 1 });
}

export function canonicalMigrationDigest(): string {
  return createHash("sha256")
    .update(
      SQLITE_MIGRATIONS.map(({ version, name, checksum }) => `${version}:${name}:${checksum}`).join(
        "\n",
      ),
    )
    .digest("hex");
}
