import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const allowedArguments = new Set([
  "--source-db",
  "--target-db",
  "--source-upload-db",
  "--target-upload-db",
  "--backup-root",
  "--project-id",
  "--component-version",
]);
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  assert.ok(allowedArguments.has(key), `unsupported argument: ${key}`);
  assert.ok(value && !args.has(key), `missing or duplicate argument: ${key}`);
  args.set(key, value);
}
for (const key of allowedArguments) assert.ok(args.has(key), `required argument: ${key}`);

const sourceDbPath = resolve(args.get("--source-db"));
const targetDbPath = resolve(args.get("--target-db"));
const sourceUploadDbPath = resolve(args.get("--source-upload-db"));
const targetUploadDbPath = resolve(args.get("--target-upload-db"));
const backupRoot = resolve(args.get("--backup-root"));
const projectId = args.get("--project-id");
const componentVersion = Number(args.get("--component-version"));
assert.match(
  projectId,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
);
assert.ok(Number.isSafeInteger(componentVersion) && componentVersion > 0);
for (const path of [
  sourceDbPath,
  targetDbPath,
  sourceUploadDbPath,
  targetUploadDbPath,
  backupRoot,
]) {
  assert.ok(isAbsolute(path), "absolute paths are required");
}
for (const path of [sourceDbPath, targetDbPath, sourceUploadDbPath, targetUploadDbPath]) {
  assert.ok(existsSync(path) && lstatSync(path).isFile(), `database file is missing: ${path}`);
  assert.ok(!lstatSync(path).isSymbolicLink(), `linked database path is forbidden: ${path}`);
}

function overlaps(left, right) {
  const delta = relative(resolve(left), resolve(right));
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}
assert.ok(
  !overlaps(dirname(sourceDbPath), dirname(targetDbPath)),
  "source and target DB roots overlap",
);
assert.ok(
  !overlaps(dirname(sourceUploadDbPath), dirname(targetUploadDbPath)),
  "source and target upload DB roots overlap",
);

const runId = `${new Date().toISOString().replaceAll(/[-:.]/gu, "")}-${randomUUID()}`;
const runRoot = join(backupRoot, "production-team-sync", runId);
mkdirSync(runRoot, { recursive: true });

const sourceSnapshotPath = join(runRoot, "production-source.sqlite");
const targetBackupPath = join(runRoot, "team-target-before.sqlite");
const sourceUploadSnapshotPath = join(runRoot, "production-upload-source.sqlite");
const targetUploadBackupPath = join(runRoot, "team-upload-target-before.sqlite");

function checkpoint(path) {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout=5000");
    const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    assert.equal(Number(result.busy), 0, `database checkpoint is busy: ${path}`);
  } finally {
    database.close();
  }
}

async function snapshot(source, destination) {
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(database, destination, { rate: 256 });
  } finally {
    database.close();
  }
  assert.ok(existsSync(destination) && lstatSync(destination).size > 0);
}

function quoted(identifier) {
  assert.match(identifier, /^[A-Za-z_][A-Za-z0-9_]*$/u);
  return `"${identifier}"`;
}

function tableNames(database) {
  return database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE ? AND name NOT LIKE ? ORDER BY name",
    )
    .all("table", "sqlite_%", "bugs_fts%")
    .map((row) => row.name);
}

function columns(database, table) {
  return database.prepare(`PRAGMA table_info(${quoted(table)})`).all();
}

function countRows(database, table) {
  return Number(database.prepare(`SELECT count(*) AS count FROM ${quoted(table)}`).get().count);
}

function inventory(database) {
  const counts = {};
  for (const table of tableNames(database)) counts[table] = countRows(database, table);
  const states = {};
  for (const table of ["bugs", "repair_attempts", "verifications", "outbox"]) {
    if (!Object.hasOwn(counts, table)) continue;
    const names = columns(database, table).map((column) => column.name);
    const stateColumn = names.includes("state")
      ? "state"
      : names.includes("status")
        ? "status"
        : null;
    if (stateColumn) {
      states[table] = database
        .prepare(
          `SELECT ${quoted(stateColumn)} AS value, count(*) AS count FROM ${quoted(table)} GROUP BY ${quoted(stateColumn)} ORDER BY ${quoted(stateColumn)}`,
        )
        .all()
        .map((row) => ({ value: row.value, count: Number(row.count) }));
    }
  }
  return {
    schema: Number(database.prepare("PRAGMA user_version").get().user_version),
    counts,
    states,
  };
}

function assertIntegrity(database, label) {
  assert.deepEqual(
    database
      .prepare("PRAGMA integrity_check")
      .all()
      .map((row) => row.integrity_check),
    ["ok"],
    `${label} integrity check failed`,
  );
}

function bindable(value) {
  return typeof value === "bigint" ? Number(value) : value;
}

const preserveTargetOnConflict = new Set([
  "accounts",
  "auth_secret_replays",
  "browser_sessions",
  "device_installations",
  "local_credentials",
  "native_sessions",
  "notification_devices",
  "projects",
  "push_subscriptions",
  "refresh_token_families",
  "refresh_tokens",
  "service_principals",
]);

function mergeMainDatabase(sourcePath, targetPath) {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const target = new DatabaseSync(targetPath);
  try {
    const sourceInventory = inventory(source);
    const before = inventory(target);
    assert.ok(sourceInventory.schema > 0 && before.schema >= sourceInventory.schema);
    assertIntegrity(source, "source main database");
    assertIntegrity(target, "target main database");
    assert.equal(source.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(target.prepare("PRAGMA foreign_key_check").all().length, 0);

    const targetTables = new Set(tableNames(target));
    const sourceTables = tableNames(source);
    const hasBugSearchIndex =
      Number(
        target
          .prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = ? AND name = ?")
          .get("table", "bugs_fts").count,
      ) === 1;
    const triggers = target
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type = ? AND sql IS NOT NULL ORDER BY name",
      )
      .all("trigger");
    const plans = [];
    for (const table of sourceTables) {
      assert.ok(targetTables.has(table), `target is missing source table: ${table}`);
      const sourceColumns = columns(source, table);
      const targetColumnNames = new Set(columns(target, table).map((column) => column.name));
      for (const column of sourceColumns)
        assert.ok(targetColumnNames.has(column.name), `target is missing ${table}.${column.name}`);
      const primaryKey = sourceColumns
        .filter((column) => Number(column.pk) > 0)
        .sort((left, right) => Number(left.pk) - Number(right.pk))
        .map((column) => column.name);
      assert.ok(primaryKey.length > 0, `source table has no primary key: ${table}`);
      plans.push({
        table,
        columns: sourceColumns.map((column) => column.name),
        primaryKey,
        rows: source.prepare(`SELECT * FROM ${quoted(table)}`).all(),
      });
    }

    const changed = {};
    target.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    try {
      for (const trigger of triggers) target.exec(`DROP TRIGGER ${quoted(trigger.name)}`);
      for (const plan of plans) {
        const mutableColumns = plan.columns.filter((column) => !plan.primaryKey.includes(column));
        const where = plan.primaryKey.map((column) => `${quoted(column)} IS ?`).join(" AND ");
        let updated = 0;
        if (mutableColumns.length > 0 && !preserveTargetOnConflict.has(plan.table)) {
          const differs = mutableColumns
            .map((column) => `NOT (${quoted(column)} IS ?)`)
            .join(" OR ");
          const statement = target.prepare(
            `UPDATE ${quoted(plan.table)} SET ${mutableColumns.map((column) => `${quoted(column)} = ?`).join(", ")} WHERE ${where} AND (${differs})`,
          );
          for (const row of plan.rows) {
            const result = statement.run(
              ...mutableColumns.map((column) => bindable(row[column])),
              ...plan.primaryKey.map((column) => bindable(row[column])),
              ...mutableColumns.map((column) => bindable(row[column])),
            );
            updated += Number(result.changes);
          }
        }
        const insert = target.prepare(
          `INSERT OR IGNORE INTO ${quoted(plan.table)} (${plan.columns.map(quoted).join(", ")}) VALUES (${plan.columns.map(() => "?").join(", ")})`,
        );
        const exists = target.prepare(`SELECT 1 FROM ${quoted(plan.table)} WHERE ${where}`);
        let inserted = 0;
        for (const row of plan.rows) {
          const key = plan.primaryKey.map((column) => bindable(row[column]));
          if (!exists.get(...key)) {
            const result = insert.run(...plan.columns.map((column) => bindable(row[column])));
            inserted += Number(result.changes);
          }
          assert.ok(exists.get(...key), `source row was not admitted: ${plan.table}`);
        }
        changed[plan.table] = {
          source: plan.rows.length,
          updated,
          inserted,
          conflictPolicy: preserveTargetOnConflict.has(plan.table)
            ? "target-preserved-source-missing-added"
            : "source-refresh-target-missing-added",
        };
      }
      if (hasBugSearchIndex) target.exec("INSERT INTO bugs_fts(bugs_fts) VALUES('rebuild')");
      for (const trigger of triggers) target.exec(trigger.sql);
      target.exec("COMMIT");
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    } finally {
      target.exec("PRAGMA foreign_keys=ON");
    }
    const after = inventory(target);
    assertIntegrity(target, "merged main database");
    const foreignKeyViolations = target.prepare("PRAGMA foreign_key_check").all();
    assert.equal(foreignKeyViolations.length, 0, "merged database has foreign-key violations");
    for (const [table, count] of Object.entries(sourceInventory.counts)) {
      assert.ok(after.counts[table] >= count, `merged table lost source rows: ${table}`);
    }
    return { source: sourceInventory, before, after, changed, foreignKeyViolations: 0 };
  } finally {
    source.close();
    target.close();
  }
}

function mergeUploadDatabase(sourcePath, targetPath) {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const target = new DatabaseSync(targetPath);
  const tableResults = {};
  try {
    assertIntegrity(source, "source upload database");
    assertIntegrity(target, "target upload database");
    target.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["upload_commands", "upload_audit"]) {
        const sourceColumns = columns(source, table).map((column) => column.name);
        const targetColumns = columns(target, table).map((column) => column.name);
        const primaryKey = columns(source, table)
          .filter((column) => Number(column.pk) > 0)
          .sort((left, right) => Number(left.pk) - Number(right.pk))
          .map((column) => column.name);
        assert.ok(primaryKey.length > 0);
        for (const column of sourceColumns) assert.ok(targetColumns.includes(column));
        const rows = source.prepare(`SELECT * FROM ${quoted(table)}`).all();
        const mutable = sourceColumns.filter((column) => !primaryKey.includes(column));
        const where = primaryKey.map((column) => `${quoted(column)} IS ?`).join(" AND ");
        const update = target.prepare(
          `UPDATE ${quoted(table)} SET ${mutable.map((column) => `${quoted(column)} = ?`).join(", ")} WHERE ${where}`,
        );
        const insertColumns = [...sourceColumns];
        if (table === "upload_commands") {
          for (const column of ["projectId", "componentVersion"])
            if (targetColumns.includes(column)) insertColumns.push(column);
        }
        const insert = target.prepare(
          `INSERT OR IGNORE INTO ${quoted(table)} (${insertColumns.map(quoted).join(", ")}) VALUES (${insertColumns.map(() => "?").join(", ")})`,
        );
        const exists = target.prepare(`SELECT 1 FROM ${quoted(table)} WHERE ${where}`);
        let updated = 0;
        let inserted = 0;
        for (const row of rows) {
          const key = primaryKey.map((column) => bindable(row[column]));
          if (exists.get(...key)) {
            updated += Number(
              update.run(...mutable.map((column) => bindable(row[column])), ...key).changes,
            );
          } else {
            const values = insertColumns.map((column) => {
              if (column === "projectId") return projectId;
              if (column === "componentVersion") return componentVersion;
              return bindable(row[column]);
            });
            inserted += Number(insert.run(...values).changes);
          }
          assert.ok(exists.get(...key), `source upload row was not admitted: ${table}`);
        }
        tableResults[table] = {
          source: rows.length,
          before: countRows(target, table) - inserted,
          after: countRows(target, table),
          updated,
          inserted,
        };
      }
      target.exec("COMMIT");
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    }
    assertIntegrity(target, "merged upload database");
    return { tables: tableResults, integrity: "ok", schedulerStateCopied: false };
  } finally {
    source.close();
    target.close();
  }
}

function replaceRecoverably(candidate, destination, label) {
  const rawBackup = join(
    runRoot,
    `${label}-raw-before${basename(destination).endsWith(".sqlite") ? ".sqlite" : ""}`,
  );
  const sidecars = [];
  for (const suffix of ["-wal", "-shm"]) {
    const path = `${destination}${suffix}`;
    if (existsSync(path)) {
      const moved = join(runRoot, `${label}-raw-before.sqlite${suffix}`);
      renameSync(path, moved);
      sidecars.push([moved, path]);
    }
  }
  renameSync(destination, rawBackup);
  try {
    renameSync(candidate, destination);
    const check = new DatabaseSync(destination, { readOnly: true });
    try {
      assertIntegrity(check, `installed ${label} database`);
    } finally {
      check.close();
    }
  } catch (error) {
    if (existsSync(destination)) renameSync(destination, join(runRoot, `${label}-failed.sqlite`));
    renameSync(rawBackup, destination);
    for (const [stored, original] of sidecars) if (existsSync(stored)) renameSync(stored, original);
    throw error;
  }
  return { rawBackup, movedSidecars: sidecars.map(([stored]) => stored) };
}

checkpoint(targetDbPath);
checkpoint(targetUploadDbPath);
await Promise.all([
  snapshot(sourceDbPath, sourceSnapshotPath),
  snapshot(targetDbPath, targetBackupPath),
  snapshot(sourceUploadDbPath, sourceUploadSnapshotPath),
  snapshot(targetUploadDbPath, targetUploadBackupPath),
]);

const candidateDbPath = join(runRoot, "team-target-candidate.sqlite");
const candidateUploadDbPath = join(runRoot, "team-upload-target-candidate.sqlite");
copyFileSync(targetBackupPath, candidateDbPath);
copyFileSync(targetUploadBackupPath, candidateUploadDbPath);
const mainMerge = mergeMainDatabase(sourceSnapshotPath, candidateDbPath);
const uploadMerge = mergeUploadDatabase(sourceUploadSnapshotPath, candidateUploadDbPath);
const mainReplacement = replaceRecoverably(candidateDbPath, targetDbPath, "main");
const uploadReplacement = replaceRecoverably(candidateUploadDbPath, targetUploadDbPath, "upload");

const report = {
  schemaVersion: 1,
  operation: "production-to-team-incremental-sync",
  runId,
  completedAt: new Date().toISOString(),
  projectId,
  componentVersion,
  sourceDbPath,
  targetDbPath,
  sourceUploadDbPath,
  targetUploadDbPath,
  validationBasis: "table-count-primary-key-admission-integrity-foreign-key-no-per-attachment-hash",
  backups: {
    runRoot,
    sourceSnapshotPath,
    targetBackupPath,
    sourceUploadSnapshotPath,
    targetUploadBackupPath,
    mainReplacement,
    uploadReplacement,
  },
  main: mainMerge,
  upload: uploadMerge,
};
const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
writeFileSync(join(runRoot, "report.json"), reportBytes, { flag: "wx" });
const currentReport = join(dirname(dirname(targetDbPath)), "table-level-migration-report.json");
if (existsSync(currentReport))
  copyFileSync(currentReport, join(runRoot, "previous-table-level-migration-report.json"));
writeFileSync(currentReport, reportBytes);
console.log(reportBytes);
