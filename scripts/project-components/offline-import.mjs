import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  restoreReferencedAttachmentsToIsolatedRoot,
  restoreSqliteToIsolatedRoot,
  validateArchivedSqliteRecoveryPointWithAttachments,
  validateReferencedAttachmentRoot,
} from "../../packages/storage/dist/index.js";
import {
  migrateSqliteDatabase,
  openSqliteDatabaseForWorker,
} from "../../packages/storage/dist/sqlite.js";
import { SQLITE_SCHEMA_VERSION } from "../../packages/storage/dist/sqlite-migrations.js";

// This command only handles validated archive copies. It never starts an API,
// worker, queue, outbox pump, connector or migration against a live database.
globalThis.fetch = async () => {
  throw new Error("OFFLINE_IMPORT_NETWORK_FORBIDDEN");
};
const values = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i],
    value = process.argv[i + 1];
  assert.ok(
    ["--archive", "--expected-sha256", "--allowed-root", "--data-root", "--mode"].includes(key),
  );
  assert.ok(value && !values.has(key), "missing or duplicate argument");
  values.set(key, value);
}
assert.equal(values.size, 5, "all five arguments are required");
const mode = values.get("--mode");
assert.ok(["restore", "migrate", "verify"].includes(mode));
const archive = values.get("--archive"),
  dataRoot = values.get("--data-root"),
  allowedRoot = values.get("--allowed-root");
for (const path of [archive, dataRoot, allowedRoot])
  assert.ok(isAbsolute(path), "absolute paths required");
const expectedSha256 = values.get("--expected-sha256");
assert.match(expectedSha256, /^[a-f0-9]{64}$/);
function ordinaryAncestors(path) {
  for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
    if (existsSync(cursor))
      assert.ok(!lstatSync(cursor).isSymbolicLink(), "linked paths forbidden");
    if (dirname(cursor) === cursor) break;
  }
}
function contained(base, target) {
  const rel = relative(resolve(base), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
assert.ok(
  contained(allowedRoot, dataRoot),
  "data root must be a child of the explicit allowed root",
);
assert.ok(!contained(dataRoot, archive), "source cannot be inside the target");
assert.ok(!contained(dirname(archive), dataRoot), "target cannot be inside the source archive");
for (const path of [archive, dataRoot, allowedRoot]) ordinaryAncestors(path);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (path) => sha(readFileSync(path));
assert.equal(hashFile(archive), expectedSha256);
const validated = await validateArchivedSqliteRecoveryPointWithAttachments({ backupPath: archive });
assert.equal(validated.backupSha256, expectedSha256);
const source = {
  archiveId: archive.replaceAll("\\", "/").split("/").at(-1),
  createdAt: validated.manifest.createdAt,
  databaseSha256: expectedSha256,
  attachmentInventorySha256: validated.attachmentManifestSha256,
};
const holdPath = join(dataRoot, ".qa-hub-import-hold.json");
function requireHold() {
  const hold = JSON.parse(readFileSync(holdPath, "utf8"));
  assert.equal(hold.markerVersion, 1);
  assert.equal(hold.operation, "project-components-offline-import");
  assert.equal(hold.state, "paused", "offline command cannot consume a released import");
  assert.deepEqual(hold.source, source, "different source cannot reuse a destination");
  assert.equal(hold.requiresExplicitRelease, true);
  assert.equal(hold.release, null);
  return hold;
}
function createHold() {
  writeFileSync(
    holdPath,
    JSON.stringify(
      {
        markerVersion: 1,
        operation: "project-components-offline-import",
        state: "paused",
        source,
        heldExecutors: ["relay-outbox", "upload", "build", "qingyu-sync", "scheduled-jobs"],
        requiresExplicitRelease: true,
        createdAt: new Date().toISOString(),
        release: null,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
}
function openImmutable(path) {
  assert.ok(
    !existsSync(path + "-wal") || lstatSync(path + "-wal").size === 0,
    "offline read refuses an uncheckpointed WAL",
  );
  const url = pathToFileURL(path);
  url.searchParams.set("immutable", "1");
  return new DatabaseSync(url, { readOnly: true });
}
function inspect(path, projectedColumns) {
  const database = openImmutable(path);
  try {
    const integrity = database.prepare("PRAGMA integrity_check").all();
    assert.deepEqual(
      integrity.map((row) => row.integrity_check),
      ["ok"],
    );
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'bugs_fts%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    const states = {},
      columns = {},
      counts = {},
      digests = {},
      rowDigests = {};
    for (const table of tables) {
      assert.match(table, /^[a-zA-Z0-9_]+$/);
      columns[table] = database
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => row.name);
      const selected = projectedColumns?.[table] ?? columns[table];
      for (const column of selected) assert.match(column, /^[a-zA-Z0-9_]+$/);
      const rows = database
        .prepare(`SELECT ${selected.map((column) => `"${column}"`).join(",")} FROM "${table}"`)
        .all();
      counts[table] = rows.length;
      const hashes = rows
        .map((row) =>
          sha(
            JSON.stringify(row, (_key, value) =>
              typeof value === "bigint" ? String(value) : value,
            ),
          ),
        )
        .sort();
      rowDigests[table] = hashes;
      digests[table] = sha(hashes.join("\n"));
      if (
        ["outbox", "repair_attempts", "build_requirements", "verifications"].includes(table) &&
        columns[table].includes("status")
      ) {
        states[table] = database
          .prepare(
            `SELECT status, count(*) AS count FROM "${table}" GROUP BY status ORDER BY status`,
          )
          .all();
      }
    }
    return {
      schema: database.prepare("PRAGMA user_version").get().user_version,
      columns,
      counts,
      digests,
      rowDigests,
      states,
    };
  } finally {
    database.close();
  }
}
const baseline = inspect(archive);
const dbPath = join(dataRoot, "db", "qa-hub.sqlite");
const restoreEvidencePath = join(dataRoot, ".qa-hub-offline-import.json");
if (mode === "restore" && !existsSync(dataRoot)) {
  mkdirSync(dirname(dataRoot), { recursive: true });
  const restored = await restoreSqliteToIsolatedRoot({
    backupPath: archive,
    restoreRoot: dataRoot,
  });
  createHold(); // Before any migration or service can consume this data root.
  await restoreReferencedAttachmentsToIsolatedRoot({
    databasePath: restored.databasePath,
    evidenceRoot: validated.attachmentRoot,
    restoreRoot: join(dataRoot, "evidence"),
    createdAt: source.createdAt,
  });
  mkdirSync(join(dataRoot, "quarantine"));
} else {
  assert.ok(existsSync(dataRoot), "restore must run before migration or verification");
  requireHold();
}
requireHold();
let migration = null;
if (mode === "migrate") {
  const database = openSqliteDatabaseForWorker({ databaseFile: dbPath, busyTimeoutMs: 5000 });
  try {
    migration = await migrateSqliteDatabase(database, dbPath, {
      backupRoot: join(dataRoot, "migration-backups"),
    });
    assert.equal(migration.toVersion, SQLITE_SCHEMA_VERSION);
    if (
      database
        .prepare(
          "SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name='project_components'",
        )
        .get().n
    ) {
      assert.equal(
        database
          .prepare(
            "SELECT count(*) AS n FROM project_components WHERE enabled <> 0 OR config_json <> '{}'",
          )
          .get().n,
        0,
        "restored components must remain disabled and unconfigured",
      );
    }
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
  const migrationReportRoot = join(dataRoot, "offline-import-reports");
  mkdirSync(migrationReportRoot, { recursive: true });
  writeFileSync(
    join(
      migrationReportRoot,
      `${new Date().toISOString().replaceAll(":", "-")}.migration-stage.${randomUUID()}.json`,
    ),
    JSON.stringify(
      { checkedAt: new Date().toISOString(), source, migration, importState: requireHold().state },
      null,
      2,
    ),
    { flag: "wx" },
  );
}
const evidence = await validateReferencedAttachmentRoot({
  // The restored inventory preserves its schema-12 archive provenance. The
  // helper compares inventory bytes including that schema, so validate its
  // files against the pinned archive; the table comparison below independently
  // proves that the migrated database retains every attachment reference.
  databasePath: archive,
  evidenceRoot: join(dataRoot, "evidence"),
  createdAt: source.createdAt,
});
const current = inspect(dbPath, baseline.columns);
const additions = {};
for (const table of Object.keys(baseline.counts)) {
  if (["membership_roles", "schema_migrations"].includes(table)) {
    const remaining = new Map();
    for (const digest of current.rowDigests[table])
      remaining.set(digest, (remaining.get(digest) ?? 0) + 1);
    for (const digest of baseline.rowDigests[table]) {
      assert.ok(remaining.get(digest) > 0, `existing ${table} row changed`);
      remaining.set(digest, remaining.get(digest) - 1);
    }
    additions[table] = current.counts[table] - baseline.counts[table];
  } else {
    assert.equal(current.digests[table], baseline.digests[table], `existing ${table} rows changed`);
  }
}
assert.equal(hashFile(archive), expectedSha256, "source changed during restore/migration");
const result = {
  checkedAt: new Date().toISOString(),
  source,
  dataRoot: resolve(dataRoot),
  mode,
  sourceSchema: baseline.schema,
  schema: current.schema,
  migration,
  integrity: "ok",
  foreignKeyViolations: 0,
  attachmentCount: evidence.manifest.entries.length,
  attachmentInventorySha256: evidence.manifestSha256,
  attachmentValidationBasis: "pinned-source-inventory-and-preserved-database-reference-tables",
  preservedOriginalTables: Object.keys(baseline.counts).filter(
    (table) => !["membership_roles", "schema_migrations"].includes(table),
  ),
  counts: current.counts,
  states: current.states,
  digests: current.digests,
  additiveOriginalTables: additions,
  importState: requireHold().state,
  executorsStarted: false,
  originalBusinessStatesChanged: false,
};
if (existsSync(restoreEvidencePath)) {
  const previous = JSON.parse(readFileSync(restoreEvidencePath, "utf8"));
  assert.deepEqual(previous.source, source);
}
writeFileSync(restoreEvidencePath, JSON.stringify(result, null, 2));
const reportRoot = join(dataRoot, "offline-import-reports");
mkdirSync(reportRoot, { recursive: true });
writeFileSync(
  join(reportRoot, `${new Date().toISOString().replaceAll(":", "-")}.${mode}.${randomUUID()}.json`),
  JSON.stringify(result, null, 2),
  { flag: "wx" },
);
console.log(
  JSON.stringify(
    {
      ...result,
      digests: undefined,
      preservedOriginalTables: result.preservedOriginalTables.length,
    },
    null,
    2,
  ),
);
