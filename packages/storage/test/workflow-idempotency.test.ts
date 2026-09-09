import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { projectManagement } from "../src/project-management-store.ts";
import {
  deleteMobileBug,
  ensureMobileScope,
  createMobileBug,
  getMobileBug,
} from "../src/mobile-bug-store.ts";
import {
  migrateSqliteDatabase,
  openSqliteDatabaseForWorker,
  currentSqliteSchemaVersion,
  verifySqliteIntegrity,
} from "../src/sqlite.ts";

type RecordValue = Record<string, unknown>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();

test("schema14 to15 preserves every old table and retains a restorable pre-migration backup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qa-result-migration15-"));
  t.diagnostic(`retained migration fixture ${directory}`);
  const databaseFile = join(directory, "schema14.sqlite");
  const database = openSqliteDatabaseForWorker({ databaseFile, busyTimeoutMs: 1000 });
  try {
    await migrateSqliteDatabase(database, databaseFile, { targetVersion: 14 });
    const scope = { accountId: randomUUID(), projectId: randomUUID(), actorId: randomUUID() };
    database.exec("BEGIN IMMEDIATE");
    ensureMobileScope(database, {
      ...scope,
      membershipId: randomUUID(),
      projectKey: "MIG15",
      createdAt: now(),
    });
    const created = createMobileBug(database, {
      ...scope,
      clientSubmissionId: randomUUID(),
      payloadDigest: digest("migration fixture"),
      title: "A real schema14 Bug",
      description: "Preserve this immutable pre-migration history",
      expectedBehavior: "Add result snapshots without changing old facts",
      severity: "S2",
      priority: "P2",
      ownerId: scope.actorId,
      verificationOwnerId: scope.actorId,
      occurrence: {
        observedAt: now(),
        platform: "web",
        steps: ["Read after migration"],
        actualBehavior: "Recorded",
      },
      attachmentIds: [],
      captureBundleId: null,
      createdAt: now(),
    });
    database.exec("COMMIT");
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    const contents = (connection: DatabaseSync) =>
      Object.fromEntries(
        tables.map((table) => [
          table,
          connection.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all(),
        ]),
      );
    const before = contents(database);
    const migration = await migrateSqliteDatabase(database, databaseFile, {
      backupRoot: join(directory, "before-backup"),
      targetVersion: 15,
    });
    assert.deepEqual(migration.appliedVersions, [15]);
    assert.equal(currentSqliteSchemaVersion(database), 15);
    assert.deepEqual(contents(database), before);
    assert.equal(getMobileBug(database, scope, created.bug.id)?.id, created.bug.id);
    assert.equal(verifySqliteIntegrity(database).ok, true);
    assert.ok(migration.backupPath);
    const old = new DatabaseSync(migration.backupPath, { readOnly: true });
    try {
      assert.equal(currentSqliteSchemaVersion(old), 14);
      assert.deepEqual(contents(old), before);
      assert.equal(verifySqliteIntegrity(old).ok, true);
    } finally {
      old.close();
    }
    const recoveredFile = join(directory, "recovered-schema15.sqlite");
    await backup(database, recoveredFile);
    const recovered = new DatabaseSync(recoveredFile, { readOnly: true });
    try {
      assert.equal(currentSqliteSchemaVersion(recovered), 15);
      assert.deepEqual(contents(recovered), before);
      assert.equal(getMobileBug(recovered, scope, created.bug.id)?.id, created.bug.id);
      assert.equal(verifySqliteIntegrity(recovered).ok, true);
    } finally {
      recovered.close();
    }
    t.diagnostic(
      `${tables.length} old tables identical; SHA256 ${digest(before)}; original Bug ${created.bug.id}`,
    );
  } finally {
    database.close();
  }
});

/** Real worker entry from source. SqliteStorageWorker itself intentionally selects dist in TS tests. */
class SourceWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    { resolve: (value: RecordValue) => void; reject: (error: Error) => void }
  >();
  private nextId = 0;
  readonly ready: Promise<void>;
  constructor(databaseFile: string, backupRoot: string) {
    const entry = new URL("../src/sqlite-worker-entry.ts", import.meta.url).href;
    const api = import.meta.resolve("tsx/esm/api");
    this.worker = new Worker(
      `(async () => {
      const { tsImport } = await import(${JSON.stringify(api)});
      await tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)});
      require('node:worker_threads').parentPort.postMessage({ booted: true });
    })().catch(error => { throw error; });`,
      {
        eval: true,
        workerData: { databaseFile, backupRoot, busyTimeoutMs: 5000 },
      },
    );
    this.ready = new Promise<void>((resolve, reject) => {
      this.worker.on("error", (error) => {
        reject(error);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      });
      this.worker.on(
        "message",
        (message: {
          booted?: boolean;
          id: number;
          ok: boolean;
          value: RecordValue;
          error: { code: string; message: string };
        }) => {
          if (message.booted) {
            resolve();
            return;
          }
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.ok) pending?.resolve(message.value);
          else
            pending?.reject(
              Object.assign(new Error(message.error.message), { code: message.error.code }),
            );
        },
      );
    }).then(async () => {
      await this.call("initialize");
    });
  }
  call(operation: string, payload?: unknown, authorization?: unknown): Promise<RecordValue> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({
        id,
        operation,
        payload,
        ...(authorization ? { authorization } : {}),
      });
    });
  }
  async close(): Promise<void> {
    try {
      await this.call("close");
    } finally {
      await this.worker.terminate();
    }
  }
}

const operations = [
  "transitionMobileBugReady",
  "createMobileManualRepairAttempt",
  "startMobileRepairAttempt",
  "deliverMobileRepairAttempt",
  "createMobileVerification",
  "startMobileVerification",
] as const;
const tables = [
  "bugs",
  "repair_attempts",
  "verifications",
  "build_requirements",
  "events",
  "outbox",
  "idempotency_records",
];
interface Scope {
  accountId: string;
  projectId: string;
  actorId: string;
}
interface Fixture {
  directory: string;
  databaseFile: string;
  worker: SourceWorker;
  scope: Scope;
  bugId: string;
  commands: RecordValue[];
  results: RecordValue[];
  command(index: number): RecordValue;
}
async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "qa-workflow-idempotency-source-"));
  const databaseFile = join(directory, "fixture.sqlite");
  const worker = new SourceWorker(databaseFile, join(directory, "backups"));
  try {
    await worker.ready;
    const scope = { accountId: randomUUID(), projectId: randomUUID(), actorId: randomUUID() };
    await worker.call("ensureMobileScope", {
      ...scope,
      membershipId: randomUUID(),
      projectKey: "REPLAY",
      createdAt: now(),
    });
    const created = await worker.call("createMobileBug", {
      ...scope,
      clientSubmissionId: randomUUID(),
      payloadDigest: digest(randomUUID()),
      title: "Isolated workflow replay",
      description: "Concurrent source worker fixture",
      expectedBehavior: "One durable effect",
      severity: "S2",
      priority: "P2",
      ownerId: scope.actorId,
      verificationOwnerId: scope.actorId,
      occurrence: {
        observedAt: now(),
        platform: "windows",
        steps: ["Repeat the same request"],
        actualBehavior: "One response",
      },
      attachmentIds: [],
      captureBundleId: null,
      createdAt: now(),
    });
    const bugId = (created.bug as RecordValue).id as string;
    const commands: RecordValue[] = [],
      results: RecordValue[] = [];
    const value: Fixture = {
      directory,
      databaseFile,
      worker,
      scope,
      bugId,
      commands,
      results,
      command(index) {
        const payloads = [
          { bugId, expectedVersion: 1 },
          { bugId, expectedVersion: 2, assigneeId: scope.actorId, summary: "Plan human work" },
          { attemptId: results[1]?.id, expectedVersion: 1, reason: "Start human work" },
          {
            attemptId: results[1]?.id,
            expectedVersion: 2,
            summary: "No code needed",
            deliveryKind: "no_code",
            branch: null,
            commitSha: null,
            mergeRequestUrl: null,
            patchUrl: null,
            noCodeReason: "Manual result",
          },
          {
            bugId,
            expectedVersion: 4,
            repairAttemptId: results[1]?.id,
            buildId: null,
            verifierId: scope.actorId,
            criteria: "Verify once",
          },
          { verificationId: results[4]?.id, expectedVersion: 1, reason: "Start verification" },
        ];
        const payload = payloads[index]!;
        return {
          ...scope,
          ...payload,
          idempotencyKey: `fixture:${index}`,
          requestDigest: digest(payload),
          createdAt: now(),
        };
      },
    };
    return value;
  } catch (error) {
    await worker.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
function snapshot(file: string): RecordValue {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(
      tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]),
    );
  } finally {
    db.close();
  }
}
function transaction<T>(file: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  try {
    const value = work(db);
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}
async function advance(f: Fixture, until: number) {
  for (let index = f.results.length; index < until; index++) {
    const command = f.command(index);
    f.commands.push(command);
    f.results.push(await f.worker.call(operations[index]!, command));
  }
}

for (const [index, operation] of operations.entries()) {
  test(`${operation}: two workers replay one effect, reject changed payload and persist the original DTO`, async () => {
    const f = await fixture();
    let second: SourceWorker | undefined;
    try {
      await advance(f, index);
      const command = f.command(index);
      const before = snapshot(f.databaseFile);
      await assert.rejects(
        f.worker.call(operation, {
          ...command,
          expectedVersion: 999,
          idempotencyKey: "failed-cas",
          requestDigest: digest("invalid version"),
        }),
        { code: "VERSION_CONFLICT" },
      );
      assert.deepEqual(
        snapshot(f.databaseFile),
        before,
        "a failed CAS rolls back its reserved receipt",
      );
      second = new SourceWorker(f.databaseFile, join(f.directory, "backups"));
      await second.ready;
      const [first, replay] = await Promise.all([
        f.worker.call(operation, command),
        second.call(operation, command),
      ]);
      assert.deepEqual(replay, first);
      const after = snapshot(f.databaseFile);
      assert.equal((after.events as unknown[]).length, (before.events as unknown[]).length + 1);
      assert.equal(
        (after.idempotency_records as unknown[]).length,
        (before.idempotency_records as unknown[]).length + 1,
      );
      assert.equal(
        (after.outbox as unknown[]).length - (before.outbox as unknown[]).length,
        [0, 1, 3].includes(index) ? 1 : 0,
      );
      assert.deepEqual(await f.worker.call(operation, command), first);
      await assert.rejects(
        second.call(operation, {
          ...command,
          requestDigest: digest("changed payload"),
          expectedVersion: 99,
        }),
        { code: "IDEMPOTENCY_PAYLOAD_MISMATCH" },
      );
      await assert.rejects(
        second.call(operation, { ...command, idempotencyKey: "different-key" }),
        { code: "VERSION_CONFLICT" },
      );
      assert.deepEqual(
        snapshot(f.databaseFile),
        after,
        "replay and conflicts cannot add events, notifications or domain rows",
      );
      f.commands.push(command);
      f.results.push(first);
      await advance(f, operations.length);
      const progressed = snapshot(f.databaseFile);
      await second.close();
      second = undefined;
      await f.worker.close();
      f.worker = new SourceWorker(f.databaseFile, join(f.directory, "backups"));
      await f.worker.ready;
      assert.deepEqual(
        await f.worker.call(operation, command),
        first,
        "reopen returns the original DTO even after later workflow changes",
      );
      assert.deepEqual(snapshot(f.databaseFile), progressed);
    } finally {
      await second?.close();
      await f.worker.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
}

test("receipt replay rechecks actor/project visibility, membership revocation, GM scope and soft deletion", async () => {
  const f = await fixture();
  try {
    await advance(f, operations.length);
    const before = snapshot(f.databaseFile);
    const outsider = randomUUID();
    const otherProject = randomUUID();
    await f.worker.call("ensureMobileScope", {
      ...f.scope,
      actorId: outsider,
      projectId: otherProject,
      membershipId: randomUUID(),
      projectKey: "OTHER",
      createdAt: now(),
    });
    for (const [index, operation] of operations.entries()) {
      await assert.rejects(f.worker.call(operation, { ...f.commands[index], actorId: outsider }), {
        code: "FORBIDDEN",
      });
      await assert.rejects(
        f.worker.call(operation, { ...f.commands[index], projectId: otherProject }),
        { code: "FORBIDDEN" },
      );
      await assert.rejects(
        f.worker.call(operation, {
          ...f.commands[index],
          actorId: outsider,
          projectId: otherProject,
        }),
        { code: "NOT_FOUND" },
      );
    }
    transaction(f.databaseFile, (db) =>
      projectManagement(db, {
        ...f.scope,
        operation: "membership",
        isGm: true,
        userId: f.scope.actorId,
        active: false,
        expectedVersion: 1,
        now: now(),
      }),
    );
    for (const [index, operation] of operations.entries()) {
      await assert.rejects(f.worker.call(operation, f.commands[index]), { code: "FORBIDDEN" });
      assert.deepEqual(
        await f.worker.call(operation, f.commands[index], f.scope),
        f.results[index],
        "transaction-bound GM capability permits the same actor and project",
      );
      await assert.rejects(
        f.worker.call(operation, f.commands[index], { ...f.scope, projectId: otherProject }),
        { code: "FORBIDDEN" },
      );
    }
    transaction(f.databaseFile, (db) =>
      projectManagement(db, {
        ...f.scope,
        operation: "membership",
        isGm: true,
        userId: f.scope.actorId,
        active: true,
        expectedVersion: 2,
        now: now(),
      }),
    );
    assert.deepEqual(
      snapshot(f.databaseFile),
      before,
      "authorization probes do not mutate workflow effects",
    );
    transaction(f.databaseFile, (db) =>
      deleteMobileBug(db, {
        ...f.scope,
        bugId: f.bugId,
        expectedVersion: 5,
        idempotencyKey: "delete-fixture",
        requestDigest: digest("delete-fixture"),
        createdAt: now(),
      }),
    );
    for (const [index, operation] of operations.entries())
      await assert.rejects(f.worker.call(operation, f.commands[index]), { code: "NOT_FOUND" });
    transaction(f.databaseFile, (db) =>
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM storage_command_authorizations").get()!.n,
        0,
      ),
    );
  } finally {
    await f.worker.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a failure after effect writes rolls back domain, audit, notification and reserved receipt together", async () => {
  const f = await fixture();
  try {
    const command = f.command(0),
      before = snapshot(f.databaseFile);
    transaction(f.databaseFile, (db) =>
      db.exec(`CREATE TRIGGER reject_fixture_receipt BEFORE UPDATE ON idempotency_records
      WHEN new.operation_id = 'transitionBugReady' BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END`),
    );
    await assert.rejects(f.worker.call(operations[0], command), /fixture receipt failure/);
    assert.deepEqual(snapshot(f.databaseFile), before);
    transaction(f.databaseFile, (db) => db.exec("DROP TRIGGER reject_fixture_receipt"));
    assert.equal((await f.worker.call(operations[0], command)).state, "ready");
  } finally {
    await f.worker.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
