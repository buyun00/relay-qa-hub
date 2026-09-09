import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants, copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteStorageWorker } from "../src/sqlite-worker.ts";
import { SQLITE_MIGRATIONS } from "../src/sqlite-migrations.ts";
import { currentSqliteSchemaVersion, verifySqliteIntegrity } from "../src/sqlite.ts";

const at = () => new Date().toISOString();
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => sha(JSON.stringify(value));

test("registered worker freezes pages across reopen and binds GM authority to each message", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qa-workflow-worker-"));
  t.diagnostic(`retained isolated worker fixture ${directory}`);
  const databaseFile = join(directory, "workflow.sqlite");
  const options = { databaseFile, busyTimeoutMs: 5000, backupRoot: join(directory, "backups") };
  let worker = new SqliteStorageWorker(options);
  const accountId = randomUUID();
  const a = { accountId, projectId: randomUUID(), actorId: randomUUID() };
  const b = { accountId, projectId: randomUUID(), actorId: randomUUID() };
  const gm = { accountId, projectId: randomUUID(), actorId: randomUUID() };
  try {
    assert.equal((await worker.initialization).migration.toVersion, 19);
    for (const [index, scope] of [a, b, gm].entries()) {
      await worker.ensureMobileScope({
        ...scope,
        projectKey: `WFD${index}`,
        membershipId: randomUUID(),
        createdAt: at(),
      });
    }
    const makeBug = async (scope: typeof a) =>
      worker.createMobileBug({
        ...scope,
        clientSubmissionId: randomUUID(),
        payloadDigest: digest(scope),
        title: "Local worker workflow",
        description: "Retain all facts",
        expectedBehavior: "Frozen",
        severity: "S2",
        priority: "P2",
        ownerId: scope.actorId,
        verificationOwnerId: scope.actorId,
        occurrence: {
          observedAt: at(),
          platform: "web",
          steps: ["Inspect"],
          actualBehavior: "Recorded",
        },
        attachmentIds: [],
        captureBundleId: null,
        createdAt: at(),
      });
    const [bugA, bugB] = await Promise.all([makeBug(a), makeBug(b)]);
    // Add local typed occurrence facts before requesting any snapshot; no live database is used.
    const seed = new DatabaseSync(databaseFile);
    try {
      seed.exec("BEGIN IMMEDIATE");
      const columns = seed
        .prepare("PRAGMA table_xinfo(occurrences)")
        .all()
        .filter((r) => r["hidden"] === 0)
        .map((r) => String(r["name"]));
      const row = seed.prepare("SELECT * FROM occurrences WHERE id=?").get(bugA.occurrenceId)!;
      const insert = seed.prepare(
        `INSERT INTO occurrences(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      );
      for (let i = 0; i < 2; i++) {
        const copy = { ...row, id: randomUUID(), client_submission_id: randomUUID() };
        insert.run(...columns.map((c) => copy[c as keyof typeof copy]!));
      }
      seed.exec("COMMIT");
    } finally {
      seed.close();
    }
    const query = { ...a, bugId: bugA.bug.id, limitPerCollection: 1 };
    const first = await worker.getBugWorkflowProjection(query);
    assert.equal(first.occurrences.length, 1);
    assert.ok(first.nextCursor);
    const pageQuery = { ...query, cursor: first.nextCursor };
    const second = await worker.getBugWorkflowProjection(pageQuery);
    await worker.close();
    worker = new SqliteStorageWorker(options);
    await worker.initialization;
    assert.deepEqual(await worker.getBugWorkflowProjection(pageQuery), second);
    const gmA = { ...a, actorId: gm.actorId };
    const authorized = <T>(work: () => T) => worker.runWithRequestAuthorization({ gm: gmA }, work);
    const messages = await Promise.allSettled([
      authorized(() => worker.getBugWorkflowProjection({ ...query, actorId: gm.actorId })),
      worker.getBugWorkflowProjection({ ...query, actorId: gm.actorId }),
      worker.getBugWorkflowProjection({ ...b, bugId: bugB.bug.id }),
      authorized(() =>
        worker.getBugWorkflowProjection({ ...b, actorId: gm.actorId, bugId: bugB.bug.id }),
      ),
      worker.getBugWorkflowProjection({ ...query, actorId: b.actorId }),
    ]);
    assert.deepEqual(
      messages.map((r) => r.status),
      ["fulfilled", "rejected", "fulfilled", "rejected", "rejected"],
    );
    for (const i of [1, 3, 4])
      assert.equal((messages[i] as PromiseRejectedResult).reason.code, "FORBIDDEN");
    const gmFirst = (messages[0] as PromiseFulfilledResult<typeof first>).value;
    assert.ok(gmFirst.nextCursor);
    const gmSecond = await authorized(() =>
      worker.getBugWorkflowProjection({
        ...query,
        actorId: gm.actorId,
        cursor: gmFirst.nextCursor!,
      }),
    );
    assert.equal(gmSecond.occurrences.length, 1);
    const counts = () => {
      const db = new DatabaseSync(databaseFile, { readOnly: true });
      try {
        return {
          auth: db.prepare("SELECT count(*) AS n FROM storage_command_authorizations").get()!["n"],
          gmMembers: db
            .prepare("SELECT count(*) AS n FROM memberships WHERE project_id=? AND user_id=?")
            .get(a.projectId, gm.actorId)!["n"],
          snapshots: db.prepare("SELECT count(*) AS n FROM workflow_projection_snapshots").get()![
            "n"
          ],
          cursors: db.prepare("SELECT count(*) AS n FROM workflow_projection_cursors").get()!["n"],
        };
      } finally {
        db.close();
      }
    };
    const beforeError = counts();
    assert.equal(beforeError.auth, 0);
    assert.equal(beforeError.gmMembers, 0);
    await assert.rejects(
      authorized(() =>
        worker.getBugWorkflowProjection({ ...query, actorId: gm.actorId, cursor: "invalid" }),
      ),
      { code: "INVALID_REQUEST" },
    );
    assert.deepEqual(counts(), beforeError);
    await worker.projectManagement({
      accountId,
      actorId: gm.actorId,
      isGm: true,
      projectId: a.projectId,
      operation: "membership",
      userId: a.actorId,
      active: false,
      expectedVersion: 1,
      now: at(),
    });
    await assert.rejects(worker.getBugWorkflowProjection(pageQuery), { code: "FORBIDDEN" });
    await worker.projectManagement({
      accountId,
      actorId: gm.actorId,
      isGm: true,
      projectId: a.projectId,
      operation: "membership",
      userId: a.actorId,
      active: true,
      expectedVersion: 2,
      now: at(),
    });
    await assert.rejects(worker.getBugWorkflowProjection(pageQuery), { code: "INVALID_REQUEST" });
    await worker.deleteMobileBug({
      ...a,
      bugId: bugA.bug.id,
      expectedVersion: bugA.bug.version,
      idempotencyKey: randomUUID(),
      requestDigest: digest("delete"),
      createdAt: at(),
    });
    await assert.rejects(
      authorized(() =>
        worker.getBugWorkflowProjection({
          ...query,
          actorId: gm.actorId,
          cursor: gmFirst.nextCursor!,
        }),
      ),
      { code: "NOT_FOUND" },
    );
    assert.deepEqual(counts(), beforeError);
    t.diagnostic(
      "current-schema real worker: reopen, concurrent GM/member scope, rollback, revocation, restoration and soft deletion verified; auth rows and GM membership remain zero",
    );
  } finally {
    await worker.close();
  }
});

test(
  "retained Phase B schema16 archive migrates only its new copy to17 with all prior tables unchanged",
  { skip: !process.env["QA_WORKFLOW_PHASE_B_ARCHIVE"] },
  async (t) => {
    const original = process.env["QA_WORKFLOW_PHASE_B_ARCHIVE"]!;
    const expected = "b1380cee2f8fa55732cdef74a171ec9af356b0b517c9495886bdf8ed4fb02d19";
    assert.equal(sha(readFileSync(original)), expected);
    const directory = mkdtempSync(join(tmpdir(), "qa-workflow-migration17-"));
    t.diagnostic(`retained isolated migration copy ${directory}`);
    const databaseFile = join(directory, "phase-b-copy.sqlite");
    copyFileSync(original, databaseFile, constants.COPYFILE_EXCL);
    const read = new DatabaseSync(databaseFile, { readOnly: true });
    const tables = read
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name",
      )
      .all()
      .map((r) => String(r["name"]));
    const fingerprints = (db: DatabaseSync) =>
      Object.fromEntries(
        tables.map((name) => {
          const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
          return [
            name,
            { count: rows.length, sha256: digest(rows.map((row) => JSON.stringify(row)).sort()) },
          ];
        }),
      );
    assert.equal(currentSqliteSchemaVersion(read), 16);
    const before = fingerprints(read);
    const oldMigrations = read.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    assert.equal(before["verification_result_snapshots"]!.count, 7);
    read.close();
    const worker = new SqliteStorageWorker({
      databaseFile,
      busyTimeoutMs: 5000,
      backupRoot: join(directory, "before17"),
    });
    try {
      const init = await worker.initialization;
      assert.deepEqual(init.migration.appliedVersions, [17]);
      assert.ok(init.migration.backupPath);
      for (const [path, version] of [
        [databaseFile, 17],
        [init.migration.backupPath, 16],
      ] as const) {
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          assert.equal(currentSqliteSchemaVersion(db), version);
          assert.deepEqual(fingerprints(db), before);
          assert.deepEqual(
            db.prepare("SELECT * FROM schema_migrations WHERE version<=16 ORDER BY version").all(),
            oldMigrations,
          );
          assert.equal(verifySqliteIntegrity(db).ok, true);
        } finally {
          db.close();
        }
      }
      for (const migration of SQLITE_MIGRATIONS.filter((x) => [15, 16].includes(x.version))) {
        assert.equal(
          oldMigrations.find((x) => x["version"] === migration.version)!["checksum"],
          migration.checksum,
        );
      }
      assert.equal(sha(readFileSync(original)), expected);
      t.diagnostic(
        JSON.stringify({
          originalSha256: expected,
          tables: tables.length,
          oldFingerprintsSha256: digest(before),
          resultSnapshots: 7,
          migration: init.migration,
          originalUnchanged: true,
        }),
      );
    } finally {
      await worker.close();
    }
  },
);
