import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  migrateSqliteDatabase,
  openSqliteDatabaseForWorker,
  verifySqliteIntegrity,
} from "../src/sqlite.ts";
import {
  createMobileBug,
  deleteMobileBug,
  ensureMobileScope,
  getMobileBug,
} from "../src/mobile-bug-store.ts";
import {
  createMobileManualRepairAttempt,
  createMobileRelayAttempt,
  dispatchMobileRelay,
  ensureMobileRelayRoles,
  manuallyCompleteMobileBug,
  startMobileRepairAttempt,
  transitionMobileBugReady,
} from "../src/mobile-relay-store.ts";
import { getMobileHumanWorkflowForBug } from "../src/mobile-human-workflow-store.ts";
import {
  createMobileVerification,
  startMobileVerification,
  recordMobileVerificationResult,
} from "../src/mobile-verification-store.ts";
import { projectManagement } from "../src/project-management-store.ts";
import { WORKFLOW_PROJECTION_SNAPSHOT_SQL } from "../src/workflow-projection-migration.ts";
import { getBugWorkflowProjection } from "../src/workflow-projection-store.ts";
import {
  WORKFLOW_COLLECTIONS,
  type GetBugWorkflowProjectionInput,
  type WorkflowProjectionOptions,
} from "../src/workflow-projection-types.ts";

const digest = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const stamp = () => new Date().toISOString();
const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020.js").default;
const ajv = new Ajv({
  allErrors: true,
  strict: true,
  strictRequired: false,
  allowUnionTypes: true,
});
require("ajv-formats").default(ajv);
ajv.addKeyword({ keyword: "x-max-utf8-bytes", schemaType: "number" });
ajv.addKeyword({ keyword: "x-sensitive-key-policy", schemaType: "string" });
for (const name of [
  "common",
  "bug",
  "event-envelope",
  "relay",
  "upload",
  "workflow",
  "build",
  "notification",
  "api",
])
  ajv.addSchema(
    JSON.parse(
      readFileSync(new URL(`../../contracts/schemas/${name}.schema.json`, import.meta.url), "utf8"),
    ),
  );
ajv.addSchema(
  JSON.parse(
    readFileSync(
      new URL("../../contracts/versions/1.1.0/schemas/app-first.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);
const validate = ajv.compile({
  $ref: "https://qa-hub.local/contracts/1.1.0/app-first.schema.json#/$defs/workflowProjection",
});
const validatePage = (page: unknown) =>
  assert.equal(validate(page), true, JSON.stringify(validate.errors));
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function fixture(t: { diagnostic(message: string): void }) {
  const directory = mkdtempSync(join(tmpdir(), "qa-workflow-projection-"));
  t.diagnostic(`retained isolated SQLite fixture: ${directory}`);
  const file = join(directory, "state.sqlite");
  const db = openSqliteDatabaseForWorker({ databaseFile: file, busyTimeoutMs: 5000 });
  await migrateSqliteDatabase(db, file, { targetVersion: 15 });
  transaction(db, () => db.exec(WORKFLOW_PROJECTION_SNAPSHOT_SQL));
  const scope = { accountId: randomUUID(), projectId: randomUUID(), actorId: randomUUID() };
  const bootstrap = { ...scope, membershipId: randomUUID(), projectKey: "DWF", createdAt: stamp() };
  transaction(db, () => {
    ensureMobileScope(db, bootstrap);
    ensureMobileRelayRoles(db, bootstrap);
  });
  const common = () => ({
    ...scope,
    createdAt: stamp(),
    idempotencyKey: randomUUID(),
    requestDigest: digest(randomUUID()),
  });
  const created = transaction(db, () =>
    createMobileBug(db, {
      ...scope,
      clientSubmissionId: randomUUID(),
      payloadDigest: digest("fixture"),
      title: "Frozen workflow",
      description: "Local fixture",
      expectedBehavior: "Retain safe immutable pages",
      severity: "S2",
      priority: "P2",
      ownerId: scope.actorId,
      verificationOwnerId: scope.actorId,
      occurrence: {
        observedAt: stamp(),
        platform: "android",
        steps: ["Inspect"],
        actualBehavior: "Observed",
      },
      attachmentIds: [],
      captureBundleId: null,
      createdAt: stamp(),
    }),
  );
  const bugId = created.bug.id;
  const version = () => getMobileBug(db, scope, bugId)!.version;
  transaction(db, () =>
    transitionMobileBugReady(db, { ...common(), bugId, expectedVersion: version() }),
  );
  // Three real local queued Relay receipts and human verification rounds; no executor or fetch.
  for (let i = 0; i < 3; i++) {
    const attempt = transaction(db, () =>
      createMobileRelayAttempt(db, {
        ...common(),
        bugId,
        expectedVersion: version(),
        assigneeId: scope.actorId,
        summary: `Local Relay ${i}`,
      }),
    );
    transaction(db, () =>
      dispatchMobileRelay(db, {
        ...common(),
        attemptId: attempt.id,
        expectedVersion: attempt.version,
        handoffId: randomUUID(),
        selectedAttachmentIds: [],
      }),
    );
    transaction(db, () =>
      manuallyCompleteMobileBug(db, {
        ...common(),
        bugId,
        expectedVersion: version(),
        reason: "Human local fixture",
      }),
    );
    const human = getMobileHumanWorkflowForBug(db, { ...scope, bugId }).repairAttempt!;
    const requested = transaction(db, () =>
      createMobileVerification(db, {
        ...common(),
        bugId,
        expectedVersion: version(),
        repairAttemptId: human.id,
        buildId: null,
        verifierId: scope.actorId,
        criteria: "Confirm local fixture",
      }),
    );
    const verification = transaction(db, () =>
      startMobileVerification(db, {
        ...common(),
        verificationId: requested.id,
        expectedVersion: requested.version,
        reason: null,
      }),
    );
    transaction(db, () =>
      recordMobileVerificationResult(db, {
        ...common(),
        verificationId: verification.id,
        expectedVersion: verification.version,
        status: "failed",
        resultSummary: "Another local round",
        failureReason: "Fixture retry",
        attachmentIds: [],
        captureBundleId: null,
        clientSubmissionId: null,
      }),
    );
  }
  const builds: string[] = [];
  transaction(db, () => {
    for (let i = 0; i < 3; i++) {
      const id = randomUUID(),
        commit = String(i + 1).repeat(40),
        at = stamp();
      builds.push(id);
      // Explicit typed local Build records only, not Jenkins/Relay end-to-end evidence.
      db.prepare(
        `INSERT INTO builds(id,account_id,project_id,provider,external_id,version_name,channel,project_key,branch,source_commit_sha,mode,status,manifest_json,manifest_digest,artifact_sha256,download_url,created_at,updated_at,version)
        VALUES(?,?,?,'manual',?,?,'qa','DWF','main',?,'debug','validating',?,?,?,?,?,?,1)`,
      ).run(
        id,
        scope.accountId,
        scope.projectId,
        `local-${i}`,
        `local-${i}`,
        commit,
        JSON.stringify({ commitShas: [commit], providerSecret: "DO_NOT_PROJECT_LOCAL_SECRET" }),
        digest(i),
        digest(`artifact-${i}`),
        "https://fixture.invalid/private-download",
        at,
        at,
      );
      db.prepare(
        "INSERT INTO build_manifest_commits(account_id,project_id,build_id,commit_sha,ordinal) VALUES(?,?,?,?,0)",
      ).run(scope.accountId, scope.projectId, id, commit);
      db.prepare("UPDATE builds SET status='ready',updated_at=?,version=2 WHERE id=?").run(
        new Date(Date.parse(at) + 1).toISOString(),
        id,
      );
    }
    const columns = db
      .prepare("PRAGMA table_xinfo(occurrences)")
      .all()
      .filter((r) => r.hidden === 0)
      .map((r) => String(r.name));
    const row = db.prepare("SELECT * FROM occurrences WHERE id=?").get(created.occurrenceId)!;
    const insert = db.prepare(
      `INSERT INTO occurrences(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
    );
    for (let i = 0; i < 100; i++) {
      const next = {
        ...row,
        id: randomUUID(),
        client_submission_id: randomUUID(),
        environment_json: JSON.stringify({ buildId: builds[i % 3], networkMetered: false }),
        actual_behavior: `Frozen occurrence ${i}`,
      };
      insert.run(...columns.map((column) => next[column as keyof typeof next]!));
    }
  });
  const input = { ...scope, bugId, limitPerCollection: 1 };
  const page = (
    query: GetBugWorkflowProjectionInput = input,
    options: WorkflowProjectionOptions = {},
  ) => transaction(db, () => getBugWorkflowProjection(db, query, options));
  return { db, directory, file, scope, bugId, input, page, common, version };
}

test("five typed workflow groups: independent cursors, immutable old DTOs, exact final page and reopened DB", async (t) => {
  const f = await fixture(t);
  try {
    const planned = transaction(f.db, () =>
      createMobileManualRepairAttempt(f.db, {
        ...f.common(),
        bugId: f.bugId,
        expectedVersion: f.version(),
        assigneeId: f.scope.actorId,
        summary: "Snapshot this planned attempt",
      }),
    );
    const first = f.page();
    validatePage(first);
    assert.deepEqual(
      WORKFLOW_COLLECTIONS.map((c) => first[c].length),
      [1, 1, 1, 1, 1],
    );
    assert(first.nextCursor && first.nextCursor.length <= 500);
    assert(!JSON.stringify(first).includes("DO_NOT_PROJECT_LOCAL_SECRET"));
    assert(!JSON.stringify(first).includes("private-download"));
    const snapshot = f.db.prepare("SELECT id FROM workflow_projection_snapshots").get()!.id;
    const expected = Object.fromEntries(
      WORKFLOW_COLLECTIONS.map((c) => [
        c,
        f.db
          .prepare(
            "SELECT dto_json FROM workflow_projection_items WHERE snapshot_id=? AND collection=? ORDER BY sort_key",
          )
          .all(snapshot!, c)
          .map((r) => JSON.parse(String(r.dto_json))),
      ]),
    );
    const later = f.db
      .prepare("SELECT id FROM occurrences WHERE bug_id=? ORDER BY id DESC LIMIT 1")
      .get(f.bugId)!.id;
    assert.throws(
      () =>
        transaction(f.db, () =>
          f.db
            .prepare(
              "UPDATE occurrences SET actual_behavior='Changed after snapshot',version=version+1 WHERE id=?",
            )
            .run(later!),
        ),
      /immutable/,
    );
    const running = transaction(f.db, () =>
      startMobileRepairAttempt(f.db, {
        ...f.common(),
        attemptId: planned.id,
        expectedVersion: planned.version,
        reason: null,
      }),
    );
    assert.equal(running.status, "running");
    const gathered = Object.fromEntries(WORKFLOW_COLLECTIONS.map((c) => [c, [...first[c]]]));
    let cursor: string | null = first.nextCursor;
    while (cursor) {
      const query = { ...f.input, cursor };
      const a = f.page(query),
        b = f.page(query);
      validatePage(a);
      assert.deepEqual(a, b, "Same cursor replays original bytes and next cursor");
      for (const c of WORKFLOW_COLLECTIONS) gathered[c]!.push(...a[c]);
      assert.equal(a.bugVersion, first.bugVersion);
      assert.equal(a.snapshotSequence, first.snapshotSequence);
      cursor = a.nextCursor;
    }
    assert.deepEqual(gathered, expected);
    assert.deepEqual(
      WORKFLOW_COLLECTIONS.map((c) => gathered[c]!.length),
      [101, 7, 3, 3, 3],
    );
    assert.equal(gathered.repairAttempts!.find((row) => row.id === planned.id)!.status, "planned");
    const recordCount = f.db
      .prepare("SELECT count(*) AS n FROM workflow_projection_snapshots")
      .get()!.n;
    const other = openSqliteDatabaseForWorker({ databaseFile: f.file, busyTimeoutMs: 5000 });
    try {
      assert.deepEqual(
        transaction(other, () =>
          getBugWorkflowProjection(other, { ...f.input, cursor: first.nextCursor! }),
        ),
        f.page({ ...f.input, cursor: first.nextCursor! }),
      );
    } finally {
      other.close();
    }
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM workflow_projection_snapshots").get()!.n,
      recordCount,
    );
    const hundred = f.page({ ...f.input, limitPerCollection: 100 });
    assert.equal(hundred.occurrences.length, 100);
    assert(hundred.nextCursor);
    const last = f.page({ ...f.input, limitPerCollection: 100, cursor: hundred.nextCursor! });
    assert.equal(last.occurrences.length, 1);
    assert.equal(last.repairAttempts.length, 0);
    assert.equal(last.nextCursor, null);
    assert.equal(last.truncated, false);
    assert.equal(verifySqliteIntegrity(f.db).ok, true);
  } finally {
    f.db.close();
  }
});

test("cursor authentication binds actor/account/project/Bug/filter; revocation, restoration and soft deletion revalidate", async (t) => {
  const f = await fixture(t);
  try {
    const page = f.page(),
      cursor = page.nextCursor!;
    const count = () =>
      f.db.prepare("SELECT count(*) AS n FROM workflow_projection_cursors").get()!.n;
    const before = count();
    for (const patch of [
      { cursor: cursor.slice(0, -1) + (cursor.endsWith("a") ? "b" : "a") },
      { cursor: "x".repeat(501) },
      { actorId: randomUUID() },
      { accountId: randomUUID() },
      { projectId: randomUUID() },
      { bugId: randomUUID() },
      { limitPerCollection: 2 },
    ]) {
      assert.throws(
        () => f.page({ ...f.input, cursor, ...patch }),
        (error) =>
          ["INVALID_REQUEST", "FORBIDDEN", "NOT_FOUND"].includes((error as { code: string }).code),
      );
    }
    assert.equal(count(), before);
    const secondActor = randomUUID();
    transaction(f.db, () =>
      projectManagement(f.db, {
        ...f.scope,
        operation: "login",
        userId: secondActor,
        displayName: "Second authorized actor",
        email: "second-workflow@example.invalid",
        now: stamp(),
      }),
    );
    assert.throws(() => f.page({ ...f.input, actorId: secondActor, cursor }), {
      code: "INVALID_REQUEST",
    });
    assert.equal(f.page({ ...f.input, actorId: secondActor }).bugId, f.bugId);
    transaction(f.db, () =>
      projectManagement(f.db, {
        ...f.scope,
        operation: "membership",
        isGm: true,
        projectId: f.scope.projectId,
        userId: f.scope.actorId,
        active: false,
        expectedVersion: 1,
        now: stamp(),
      }),
    );
    assert.throws(() => f.page({ ...f.input, cursor }), { code: "FORBIDDEN" });
    transaction(f.db, () =>
      projectManagement(f.db, {
        ...f.scope,
        operation: "membership",
        isGm: true,
        projectId: f.scope.projectId,
        userId: f.scope.actorId,
        active: true,
        expectedVersion: 2,
        now: stamp(),
      }),
    );
    assert.throws(() => f.page({ ...f.input, cursor }), { code: "INVALID_REQUEST" });
    const fresh = f.page();
    transaction(f.db, () =>
      deleteMobileBug(f.db, { ...f.common(), bugId: f.bugId, expectedVersion: f.version() }),
    );
    assert.throws(() => f.page({ ...f.input, cursor: fresh.nextCursor! }), { code: "NOT_FOUND" });
    assert(f.db.prepare("SELECT 1 FROM workflow_projection_snapshots LIMIT 1").get());
  } finally {
    f.db.close();
  }
});

test("expiry and capacity reject explicitly, rollback leaves no partial snapshots, retained rows are immutable", async (t) => {
  const f = await fixture(t);
  try {
    const now = new Date();
    const first = f.page(f.input, { now: () => now, ttlMs: 100 });
    assert.throws(
      () =>
        f.page(
          { ...f.input, cursor: first.nextCursor! },
          { now: () => new Date(now.getTime() + 100) },
        ),
      { code: "INVALID_REQUEST" },
    );
    const sizes = () =>
      ["snapshots", "items", "cursors"].map(
        (name) => f.db.prepare(`SELECT count(*) AS n FROM workflow_projection_${name}`).get()!.n,
      );
    const before = sizes();
    for (const options of [
      { maxItemsPerSnapshot: 2 },
      { maxBytesPerSnapshot: 1 },
      { maxActiveSnapshotsPerActor: 1 },
      { maxRetainedSnapshotsPerActor: 1 },
      { maxRetainedBytesPerActor: 1 },
    ]) {
      assert.throws(() => f.page(f.input, { now: () => now, ...options }), {
        code: "RATE_LIMITED",
      });
      assert.deepEqual(sizes(), before);
    }
    assert.throws(
      () =>
        f.page(f.input, {
          now: () => new Date(now.getTime() + 101),
          maxRetainedSnapshotsPerActor: 1,
        }),
      { code: "RATE_LIMITED" },
    );
    assert.throws(() => getBugWorkflowProjection(f.db, f.input), {
      code: "SQLITE_TRANSACTION_REQUIRED",
    });
    for (const table of ["snapshots", "items", "cursors"]) {
      assert.throws(
        () => transaction(f.db, () => f.db.exec(`DELETE FROM workflow_projection_${table}`)),
        /retained/,
      );
    }
    assert.throws(
      () =>
        transaction(f.db, () =>
          f.db.exec("UPDATE workflow_projection_snapshots SET expires_at=expires_at+1"),
        ),
      /immutable/,
    );
    assert.throws(
      () =>
        transaction(f.db, () => f.db.exec("UPDATE workflow_projection_items SET dto_json='{}'")),
      /immutable/,
    );
    const snapshot = f.db.prepare("SELECT id FROM workflow_projection_snapshots").get()!.id;
    assert.throws(
      () =>
        transaction(f.db, () =>
          f.db
            .prepare(
              "INSERT INTO workflow_projection_items(snapshot_id,collection,sort_key,dto_json) VALUES(?,'occurrences',?,'{}')",
            )
            .run(snapshot!, randomUUID()),
        ),
      /sealed/,
    );
    assert.deepEqual(sizes(), before);
    f.db
      .exec(`CREATE TEMP TRIGGER fixture_reject_workflow_item BEFORE INSERT ON workflow_projection_items
      WHEN (SELECT count(*) FROM workflow_projection_items WHERE snapshot_id=new.snapshot_id)=2
      BEGIN SELECT RAISE(ABORT,'fixture mid-snapshot failure'); END;`);
    assert.throws(() => f.page(), /fixture mid-snapshot failure/);
    assert.deepEqual(sizes(), before, "Header and first two DTOs must all roll back");
    f.db.exec("DROP TRIGGER fixture_reject_workflow_item");
  } finally {
    f.db.close();
  }
});
