import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  evidenceFixture,
  fingerprint,
  tx,
  digest,
  stamp,
  PNG,
  paddedPng,
  sha,
} from "./verification-result-evidence-fixture.ts";
import {
  recordMobileVerificationResult,
  type RecordMobileVerificationResultInput,
} from "../src/mobile-verification-store.ts";
import { getMobileCapture } from "../src/mobile-capture-store.ts";
import {
  getMobileAttachment,
  getMobileCaptureArtifact,
  listMobileBugAttachments,
} from "../src/mobile-attachment-store.ts";
import {
  createMobileBug,
  deleteMobileBug,
  ensureMobileScope,
  getMobileBug,
} from "../src/mobile-bug-store.ts";
import { updateMobileBug } from "../src/mobile-relay-store.ts";
import { projectManagement } from "../src/project-management-store.ts";
import { VERIFICATION_RESULT_EVIDENCE_SQL } from "../src/verification-result-evidence-migration.ts";

function rows(database: DatabaseSync, sql: string): readonly Record<string, unknown>[] {
  return database.prepare(sql).all();
}

function captureIdentityValues(
  database: DatabaseSync,
  captureId: string,
  attachmentIds: readonly string[],
): readonly unknown[] {
  const placeholders = attachmentIds.map(() => "?").join(",");
  return database
    .prepare(
      `SELECT capture_id FROM capture_bundles WHERE id=?
       UNION ALL SELECT capture_id FROM capture_artifacts WHERE capture_bundle_id=?
       UNION ALL SELECT capture_id FROM attachments WHERE id IN (${placeholders})
       UNION ALL SELECT capture_id FROM upload_sessions WHERE finalized_attachment_id IN (${placeholders})`,
    )
    .all(captureId, captureId, ...attachmentIds, ...attachmentIds)
    .map((row) => row["capture_id"]);
}

function claimAndInsertVerificationAttachment(
  database: DatabaseSync,
  input: {
    readonly accountId: string;
    readonly projectId: string;
    readonly verificationId: string;
    readonly attachmentId: string;
    readonly bindingId: string;
  },
): void {
  const claimed = database
    .prepare(
      `UPDATE attachment_bindings
       SET state='claimed',expires_at=NULL,claimed_at=?,version=version+1
       WHERE account_id=? AND project_id=? AND id=? AND attachment_id=? AND state='reserved'`,
    )
    .run(stamp(), input.accountId, input.projectId, input.bindingId, input.attachmentId);
  const attachment = database
    .prepare(
      `UPDATE attachments SET version=version+1
       WHERE account_id=? AND project_id=? AND id=?`,
    )
    .run(input.accountId, input.projectId, input.attachmentId);
  assert.equal(claimed.changes, 1);
  assert.equal(attachment.changes, 1);
  database
    .prepare(
      `INSERT INTO verification_attachments(
         account_id,project_id,verification_id,attachment_id,binding_id
       ) VALUES (?,?,?,?,?)`,
    )
    .run(
      input.accountId,
      input.projectId,
      input.verificationId,
      input.attachmentId,
      input.bindingId,
    );
}

test("schema 15/16/17 history and an existing result receipt remain byte-for-byte unchanged", async (t) => {
  const f = await evidenceFixture(t, { applyEvidenceMigration: false });
  let closed = false;
  try {
    const draft = f.stage(8);
    const result = f.submit(draft.input);
    const historyBefore = rows(
      f.database,
      "SELECT * FROM schema_migrations WHERE version BETWEEN 15 AND 17 ORDER BY version",
    );
    const receiptBefore = rows(
      f.database,
      "SELECT * FROM idempotency_records WHERE operation_id='recordVerificationResult' ORDER BY id",
    );
    const snapshotBefore = rows(
      f.database,
      "SELECT * FROM verification_result_snapshots ORDER BY id",
    );
    const submissionBefore = rows(
      f.database,
      "SELECT * FROM submissions WHERE intent='verification_result' ORDER BY id",
    );
    const dataBefore = fingerprint(f.database);
    assert.equal(f.database.prepare("PRAGMA user_version").get()!["user_version"], 17);
    tx(f.database, () => f.database.exec(VERIFICATION_RESULT_EVIDENCE_SQL));
    assert.equal(f.database.prepare("PRAGMA user_version").get()!["user_version"], 17);
    assert.deepEqual(
      rows(
        f.database,
        "SELECT * FROM schema_migrations WHERE version BETWEEN 15 AND 17 ORDER BY version",
      ),
      historyBefore,
    );
    assert.deepEqual(
      rows(
        f.database,
        "SELECT * FROM idempotency_records WHERE operation_id='recordVerificationResult' ORDER BY id",
      ),
      receiptBefore,
    );
    assert.deepEqual(
      rows(f.database, "SELECT * FROM verification_result_snapshots ORDER BY id"),
      snapshotBefore,
    );
    assert.deepEqual(
      rows(f.database, "SELECT * FROM submissions WHERE intent='verification_result' ORDER BY id"),
      submissionBefore,
    );
    assert.deepEqual(fingerprint(f.database), dataBefore);
    const receiptId = String(receiptBefore[0]!["id"]),
      snapshotId = String(snapshotBefore[0]!["id"]);
    assert.throws(() =>
      f.database
        .prepare("UPDATE verification_result_snapshots SET response_json='{}' WHERE id=?")
        .run(snapshotId),
    );
    assert.throws(() =>
      f.database.prepare("DELETE FROM verification_result_snapshots WHERE id=?").run(snapshotId),
    );
    assert.throws(() =>
      f.database
        .prepare("UPDATE idempotency_records SET response_json='{}' WHERE id=?")
        .run(receiptId),
    );
    assert.deepEqual(fingerprint(f.database), dataBefore);
    assert.deepEqual(f.submit(draft.input), { ...result, replayed: true });
    f.database.close();
    closed = true;
    const reopened = new DatabaseSync(f.databaseFile);
    try {
      assert.deepEqual(
        tx(reopened, () => recordMobileVerificationResult(reopened, draft.input)),
        { ...result, replayed: true },
      );
      assert.deepEqual(fingerprint(reopened), dataBefore);
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) f.database.close();
  }
});

test("every attachment count from 9 through 20 commits actual PNG reservations once", async (t) => {
  const f = await evidenceFixture(t);
  let closed = false;
  try {
    for (const count of Array.from({ length: 12 }, (_, index) => index + 9)) {
      const draft = f.stage(count);
      const result = f.submit(draft.input);
      assert.equal(result.attachmentIds.length, count);
      assert.equal(result.captureBundleId, null);
      assert.deepEqual([...result.attachmentIds].sort(), draft.input.attachmentIds.slice().sort());
      const before = fingerprint(f.database);
      assert.deepEqual(f.submit(draft.input), { ...result, replayed: true });
      assert.deepEqual(fingerprint(f.database), before);
      for (const item of draft.attachments)
        assert.equal(
          sha(
            getMobileAttachment(f.database, f.roots, {
              ...f.scope,
              attachmentId: item.attachmentId,
            })!.bytes,
          ),
          sha(PNG),
        );
      if (count === 20) {
        f.database.close();
        closed = true;
        const reopened = new DatabaseSync(f.databaseFile);
        try {
          assert.deepEqual(
            tx(reopened, () => recordMobileVerificationResult(reopened, draft.input)),
            { ...result, replayed: true },
          );
          assert.deepEqual(fingerprint(reopened), before);
        } finally {
          reopened.close();
        }
      }
    }
  } finally {
    if (!closed) f.database.close();
  }
});

test("capture passed/failed/blocked results share exact successful artifacts and retain current read authorization", async (t) => {
  const f = await evidenceFixture(t);
  try {
    const peer = randomUUID();
    tx(f.database, () =>
      ensureMobileScope(f.database, {
        ...f.bootstrap,
        actorId: peer,
        membershipId: randomUUID(),
        createdAt: stamp(),
      }),
    );
    for (const status of ["passed", "failed", "blocked"] as const) {
      const draft = f.stage(2, true);
      const {
        status: initialStatus,
        failureReason: initialFailure,
        blockedReason: initialBlocked,
        ...base
      } = draft.input;
      void initialStatus;
      void initialFailure;
      void initialBlocked;
      const input: RecordMobileVerificationResultInput =
        status === "failed"
          ? { ...base, status, failureReason: "Needs another fix" }
          : status === "blocked"
            ? { ...base, status, failureReason: null, blockedReason: "Environment missing" }
            : { ...base, status, failureReason: null };
      const readInput = { ...f.scope, captureId: input.captureBundleId! };
      assert.ok(getMobileCapture(f.database, readInput));
      assert.equal(getMobileCapture(f.database, { ...readInput, actorId: peer }), null);
      const result = f.submit(input);
      assert.equal(result.captureBundleId, input.captureBundleId);
      assert.deepEqual([...result.attachmentIds].sort(), input.attachmentIds.slice().sort());
      const captureIds = captureIdentityValues(
        f.database,
        input.captureBundleId!,
        input.attachmentIds,
      );
      assert.equal(captureIds.length, 7);
      assert.deepEqual([...new Set(captureIds)], [input.captureBundleId]);
      assert.ok(getMobileCapture(f.database, { ...readInput, actorId: peer }));
      assert.deepEqual(
        listMobileBugAttachments(f.database, {
          ...f.scope,
          actorId: peer,
          bugId: draft.bugId,
          limit: 100,
        })!
          .items.map((item) => item.attachmentId)
          .sort(),
        input.attachmentIds.slice().sort(),
      );
      for (const artifactKind of ["system_screenshot", "poco_screenshot"] as const) {
        const artifact = getMobileCaptureArtifact(f.database, f.roots, {
          ...f.scope,
          actorId: peer,
          bugId: draft.bugId,
          captureId: input.captureBundleId!,
          artifactKind,
        });
        assert.ok(artifact);
        assert.equal(sha(artifact.bytes), sha(PNG));
      }
      const before = fingerprint(f.database);
      assert.deepEqual(f.submit(input), { ...result, replayed: true });
      assert.deepEqual(fingerprint(f.database), before);
      tx(f.database, () =>
        projectManagement(f.database, {
          ...f.scope,
          isGm: true,
          operation: "membership",
          userId: f.scope.actorId,
          active: false,
          expectedVersion: status === "passed" ? 1 : status === "failed" ? 3 : 5,
          now: stamp(),
        }),
      );
      assert.throws(() => f.submit(input), { code: "FORBIDDEN" });
      assert.equal(getMobileCapture(f.database, readInput), null);
      assert.ok(getMobileCapture(f.database, { ...readInput, actorId: peer }));
      tx(f.database, () =>
        projectManagement(f.database, {
          ...f.scope,
          isGm: true,
          operation: "membership",
          userId: f.scope.actorId,
          active: true,
          expectedVersion: status === "passed" ? 2 : status === "failed" ? 4 : 6,
          now: stamp(),
        }),
      );
      assert.deepEqual(f.submit(input), { ...result, replayed: true });
      tx(f.database, () =>
        deleteMobileBug(f.database, {
          ...f.common(),
          bugId: draft.bugId,
          expectedVersion: getMobileBug(f.database, f.scope, draft.bugId)!.version,
        }),
      );
      assert.throws(() => f.submit(input), { code: "NOT_FOUND" });
      assert.equal(getMobileCapture(f.database, { ...readInput, actorId: peer }), null);
      assert.equal(
        getMobileAttachment(f.database, f.roots, {
          ...f.scope,
          attachmentId: input.attachmentIds[0]!,
        }),
        null,
      );
      assert.equal(
        getMobileCaptureArtifact(f.database, f.roots, {
          ...f.scope,
          bugId: draft.bugId,
          captureId: input.captureBundleId!,
          artifactKind: "system_screenshot",
        }),
        null,
      );
    }
  } finally {
    f.database.close();
  }
});

test("21 attachments and wrong capture/actor/project/submission/target reject without any committed mutation", async (t) => {
  const f = await evidenceFixture(t);
  try {
    const overflow = f.stage(21);
    let before = fingerprint(f.database);
    assert.throws(() => f.submit(overflow.input), { code: "INVALID_REQUEST" });
    assert.deepEqual(fingerprint(f.database), before);
    const target = f.prepareVerification();
    const wrongTarget = f.stage(1, false, target.bugId);
    before = fingerprint(f.database);
    assert.throws(() => f.submit(wrongTarget.input), { code: "INVALID_REQUEST" });
    assert.deepEqual(fingerprint(f.database), before);
    const wrongIntent = f.stage(1, false, undefined, PNG, "bug_create");
    before = fingerprint(f.database);
    assert.throws(() => f.submit(wrongIntent.input), { code: "INVALID_REQUEST" });
    assert.deepEqual(fingerprint(f.database), before);
    const draft = f.stage(2, true);
    const invalids = [
      { attachmentIds: [] },
      { attachmentIds: [draft.input.attachmentIds[1]!] },
      { attachmentIds: [draft.input.attachmentIds[0]!, draft.input.attachmentIds[0]!] },
      { captureBundleId: null },
      { captureBundleId: randomUUID() },
      { clientSubmissionId: randomUUID() },
      { actorId: randomUUID() },
      { projectId: randomUUID() },
      { attachmentIds: [draft.input.attachmentIds[0]!, overflow.input.attachmentIds[0]!] },
    ];
    for (const changes of invalids) {
      before = fingerprint(f.database);
      assert.throws(() => f.submit({ ...draft.input, ...changes }));
      assert.deepEqual(fingerprint(f.database), before);
    }
    const result = f.submit(draft.input);
    assert.equal(result.captureBundleId, draft.input.captureBundleId);
    before = fingerprint(f.database);
    assert.throws(
      () =>
        f.submit({ ...draft.input, resultSummary: "Changed", requestDigest: digest("changed") }),
      { code: "IDEMPOTENCY_PAYLOAD_MISMATCH" },
    );
    assert.deepEqual(fingerprint(f.database), before);
  } finally {
    f.database.close();
  }
});

test("database trigger rejects a direct 21st Verification attachment and rolls back its claim", async (t) => {
  const f = await evidenceFixture(t);
  try {
    const draft = f.stage(20);
    const extra = f.upload(draft.input.clientSubmissionId!);
    const { bindMobileAttachment } = await import("../src/mobile-attachment-store.ts");
    const extraBinding = tx(f.database, () =>
      bindMobileAttachment(f.database, {
        ...f.scope,
        attachmentId: extra.attachmentId,
        expectedVersion: extra.version,
        clientSubmissionId: draft.input.clientSubmissionId!,
        clientAttachmentId: extra.clientAttachmentId,
        leaseGeneration: 1,
        intent: "verification_result",
        targetQaItemId: draft.bugId,
        boundAt: stamp(),
      }),
    );
    assert.equal(f.submit(draft.input).attachmentIds.length, 20);
    const boundary = f.database
      .prepare(
        `SELECT count(*) AS count, sum(attachment.size_bytes) AS bytes
         FROM verification_attachments AS link
         JOIN attachments AS attachment
           ON attachment.account_id=link.account_id
          AND attachment.project_id=link.project_id
          AND attachment.id=link.attachment_id
         WHERE link.account_id=? AND link.project_id=? AND link.verification_id=?`,
      )
      .get(f.scope.accountId, f.scope.projectId, draft.verification.id)!;
    assert.equal(boundary["count"], 20);
    assert.ok(Number(boundary["bytes"]) + extra.size < 100 * 1024 * 1024);
    const before = fingerprint(f.database);
    assert.throws(
      () =>
        tx(f.database, () =>
          claimAndInsertVerificationAttachment(f.database, {
            ...f.scope,
            verificationId: draft.verification.id,
            attachmentId: extra.attachmentId,
            bindingId: extraBinding.bindingId,
          }),
        ),
      /Verification evidence permits at most twenty attachments totaling 100 MiB/,
    );
    assert.deepEqual(fingerprint(f.database), before);
    assert.equal(
      f.database
        .prepare(
          `SELECT count(*) AS count FROM verification_attachments
           WHERE account_id=? AND project_id=? AND verification_id=?`,
        )
        .get(f.scope.accountId, f.scope.projectId, draft.verification.id)!["count"],
      20,
    );
    t.diagnostic(
      "Raw verification_attachments insert hit the 20-item trigger branch; claim rolled back",
    );
  } finally {
    f.database.close();
  }
});

test("two active project memberships isolate real attachment and capture decoys", async (t) => {
  const f = await evidenceFixture(t);
  try {
    const decoyProject = f.addProjectScope("VREVIDENCEDECOY");
    const primary = f.stage(1, true);
    const decoy = f.stageForScope(decoyProject.scope, 1, true);
    assert.equal(
      f.database
        .prepare(
          `SELECT count(*) AS count FROM projects
           WHERE account_id=? AND status='active' AND id IN (?,?)`,
        )
        .get(f.scope.accountId, f.scope.projectId, decoyProject.scope.projectId)!["count"],
      2,
    );
    assert.equal(
      f.database
        .prepare(
          `SELECT count(*) AS count FROM memberships
           WHERE account_id=? AND user_id=? AND status='active' AND project_id IN (?,?)`,
        )
        .get(f.scope.accountId, f.scope.actorId, f.scope.projectId, decoyProject.scope.projectId)![
        "count"
      ],
      2,
    );
    const decoyFacts = f.database
      .prepare(
        `SELECT attachment.status AS attachment_status,
                attachment.scan_state AS scan_state,
                upload.status AS upload_status,
                binding.state AS binding_state,
                capture.status AS capture_status
         FROM attachments AS attachment
         JOIN upload_sessions AS upload
           ON upload.account_id=attachment.account_id
          AND upload.project_id=attachment.project_id
          AND upload.id=attachment.upload_session_id
          AND upload.finalized_attachment_id=attachment.id
         JOIN attachment_bindings AS binding
           ON binding.account_id=attachment.account_id
          AND binding.project_id=attachment.project_id
          AND binding.attachment_id=attachment.id
         JOIN capture_bundles AS capture
           ON capture.account_id=attachment.account_id
          AND capture.project_id=attachment.project_id
          AND capture.id=attachment.capture_id
         WHERE attachment.account_id=? AND attachment.project_id=?
           AND attachment.id=? AND capture.id=?`,
      )
      .get(
        decoyProject.scope.accountId,
        decoyProject.scope.projectId,
        decoy.input.attachmentIds[0]!,
        decoy.input.captureBundleId!,
      )!;
    assert.deepEqual(
      { ...decoyFacts },
      {
        attachment_status: "ready",
        scan_state: "clean",
        upload_status: "finalized",
        binding_state: "reserved",
        capture_status: "uploaded",
      },
    );
    assert.equal(
      getMobileCapture(f.database, {
        ...f.scope,
        captureId: decoy.input.captureBundleId!,
      }),
      null,
    );
    assert.ok(
      getMobileCapture(f.database, {
        ...decoyProject.scope,
        captureId: decoy.input.captureBundleId!,
      }),
    );
    for (const changes of [
      { attachmentIds: decoy.input.attachmentIds },
      { captureBundleId: decoy.input.captureBundleId },
      {
        attachmentIds: decoy.input.attachmentIds,
        captureBundleId: decoy.input.captureBundleId,
      },
    ]) {
      const before = fingerprint(f.database);
      assert.throws(() => f.submit({ ...primary.input, ...changes }), {
        code: "INVALID_REQUEST",
      });
      assert.deepEqual(fingerprint(f.database), before);
    }
    let before = fingerprint(f.database);
    assert.throws(
      () =>
        f.submit({
          ...primary.input,
          projectId: decoyProject.scope.projectId,
          attachmentIds: decoy.input.attachmentIds,
          captureBundleId: decoy.input.captureBundleId,
        }),
      { code: "NOT_FOUND" },
    );
    assert.deepEqual(fingerprint(f.database), before);
    const primaryResult = f.submit(primary.input);
    const decoyResult = f.submit(decoy.input);
    assert.equal(primaryResult.captureBundleId, primary.input.captureBundleId);
    assert.equal(decoyResult.captureBundleId, decoy.input.captureBundleId);
    assert.ok(
      getMobileAttachment(f.database, f.roots, {
        ...decoyProject.scope,
        attachmentId: decoy.input.attachmentIds[0]!,
      }),
    );
    assert.equal(
      getMobileAttachment(f.database, f.roots, {
        ...f.scope,
        attachmentId: decoy.input.attachmentIds[0]!,
      }),
      null,
    );
    assert.equal(
      getMobileAttachment(f.database, f.roots, {
        ...decoyProject.scope,
        attachmentId: primary.input.attachmentIds[0]!,
      }),
      null,
    );
    const links = f.database
      .prepare(
        `SELECT project_id,verification_id,attachment_id FROM verification_attachments
         WHERE account_id=? AND verification_id IN (?,?) ORDER BY project_id`,
      )
      .all(f.scope.accountId, primary.verification.id, decoy.verification.id);
    assert.deepEqual(
      links.map((row) => [row["project_id"], row["verification_id"], row["attachment_id"]]),
      [
        [f.scope.projectId, primary.verification.id, primary.input.attachmentIds[0]!],
        [decoyProject.scope.projectId, decoy.verification.id, decoy.input.attachmentIds[0]!],
      ].sort(([left], [right]) => String(left).localeCompare(String(right))),
    );
    before = fingerprint(f.database);
    assert.deepEqual(f.submit(primary.input), { ...primaryResult, replayed: true });
    assert.deepEqual(fingerprint(f.database), before);
    t.diagnostic(
      "Same actor had two active project memberships; real neighboring attachment/capture identities stayed project-scoped",
    );
  } finally {
    f.database.close();
  }
});

test("Bug attachment edits cannot remove immutable Verification evidence", async (t) => {
  const f = await evidenceFixture(t);
  try {
    const draft = f.stage(2, true);
    const {
      status: initialStatus,
      failureReason: initialFailure,
      blockedReason: initialBlocked,
      ...base
    } = draft.input;
    void initialStatus;
    void initialFailure;
    void initialBlocked;
    const input: RecordMobileVerificationResultInput = {
      ...base,
      status: "failed",
      failureReason: "Retain evidence",
    };
    f.submit(input);
    const beforeRemovals = Number(
      f.database
        .prepare(
          "SELECT count(*) AS n FROM bug_attachment_removals WHERE account_id=? AND project_id=? AND bug_id=?",
        )
        .get(f.scope.accountId, f.scope.projectId, draft.bugId)!["n"],
    );
    const bug = getMobileBug(f.database, f.scope, draft.bugId)!;
    tx(f.database, () =>
      updateMobileBug(f.database, {
        ...f.common(),
        bugId: draft.bugId,
        expectedVersion: bug.version,
        attachmentIds: [],
      }),
    );
    assert.equal(
      Number(
        f.database
          .prepare(
            "SELECT count(*) AS n FROM bug_attachment_removals WHERE account_id=? AND project_id=? AND bug_id=?",
          )
          .get(f.scope.accountId, f.scope.projectId, draft.bugId)!["n"],
      ),
      beforeRemovals,
    );
    assert.deepEqual(
      listMobileBugAttachments(f.database, {
        ...f.scope,
        bugId: draft.bugId,
        limit: 100,
      })!
        .items.map((item) => item.attachmentId)
        .sort(),
      input.attachmentIds.slice().sort(),
    );
    assert.ok(getMobileCapture(f.database, { ...f.scope, captureId: input.captureBundleId! }));
    assert.ok(
      getMobileCaptureArtifact(f.database, f.roots, {
        ...f.scope,
        bugId: draft.bugId,
        captureId: input.captureBundleId!,
        artifactKind: "system_screenshot",
      }),
    );
  } finally {
    f.database.close();
  }
});

test("each effect stage rolls back attachment/capture/result/audit/notification/receipt together", async (t) => {
  const f = await evidenceFixture(t);
  try {
    const draft = f.stage(2, true);
    const tables = [
      ["attachment_bindings", "UPDATE"],
      ["attachments", "UPDATE"],
      ["verification_attachments", "INSERT"],
      ["capture_bundles", "UPDATE"],
      ["events", "INSERT"],
      ["outbox", "INSERT"],
      ["verifications", "UPDATE"],
      ["bugs", "UPDATE"],
      ["verification_result_snapshots", "INSERT"],
      ["submissions", "INSERT"],
      ["idempotency_records", "UPDATE"],
    ];
    for (const [table, operation] of tables) {
      f.database.exec(
        `CREATE TEMP TRIGGER fixture_failure BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'INJECTED_EVIDENCE_FAILURE'); END;`,
      );
      const before = fingerprint(f.database);
      assert.throws(() => f.submit(draft.input), /INJECTED_EVIDENCE_FAILURE/);
      assert.deepEqual(fingerprint(f.database), before);
      f.database.exec("DROP TRIGGER fixture_failure");
    }
    const result = f.submit(draft.input);
    assert.equal(result.attachmentIds.length, 2);
    assert.equal(
      f.database.prepare("SELECT count(*) AS n FROM verification_result_snapshots").get()!["n"],
      1,
    );
    t.diagnostic(
      `All ${tables.length} actual SQLite failure points rolled back; retained media SHA ${sha(PNG)}`,
    );
  } finally {
    f.database.close();
  }
});

test("exact result and generic receipt SQL guards reject forged capture facts before commit", async (t) => {
  const f = await evidenceFixture(t);
  try {
    const draft = f.stage(1, true);
    for (const family of ["snapshot", "receipt"] as const) {
      for (const captureBundleId of [null, randomUUID(), 42]) {
        const proxy = new Proxy(f.database, {
          get(target, key) {
            if (key !== "prepare") {
              const v = Reflect.get(target, key, target) as unknown;
              return typeof v === "function" ? v.bind(target) : v;
            }
            return (sql: string) => {
              const statement = target.prepare(sql);
              const match =
                family === "snapshot"
                  ? sql.includes("INSERT INTO verification_result_snapshots")
                  : sql.includes("UPDATE idempotency_records SET status = 'committed'");
              if (!match) return statement;
              return new Proxy(statement, {
                get(original, property) {
                  if (property !== "run") {
                    const value = Reflect.get(original, property, original) as unknown;
                    return typeof value === "function" ? value.bind(original) : value;
                  }
                  return (...args: unknown[]) => {
                    const index = family === "snapshot" ? 11 : 1;
                    const response = JSON.parse(String(args[index]));
                    response.captureBundleId = captureBundleId;
                    args[index] = JSON.stringify(response);
                    return original.run(...(args as Parameters<typeof original.run>));
                  };
                },
              });
            };
          },
        });
        const before = fingerprint(f.database);
        assert.throws(
          () => tx(f.database, () => recordMobileVerificationResult(proxy, draft.input)),
          /Verification (result snapshot|receipt)/,
        );
        assert.deepEqual(fingerprint(f.database), before);
      }
    }
    assert.equal(f.submit(draft.input).captureBundleId, draft.input.captureBundleId);
  } finally {
    f.database.close();
  }
});

test("removing an original Bug primary hides its capture metadata, raw image and artifact without deleting evidence", async (t) => {
  const f = await evidenceFixture(t);
  try {
    const draft = f.stage(1, true, undefined, PNG, "bug_create");
    const created = tx(f.database, () =>
      createMobileBug(f.database, {
        ...f.scope,
        clientSubmissionId: draft.input.clientSubmissionId!,
        payloadDigest: digest("original capture Bug"),
        title: "Original capture",
        description: "Preserve image",
        expectedBehavior: "Removed evidence hidden",
        severity: "S2",
        priority: "P2",
        ownerId: f.scope.actorId,
        verificationOwnerId: f.scope.actorId,
        occurrence: {
          observedAt: stamp(),
          platform: "android",
          steps: ["Read"],
          actualBehavior: "Captured",
        },
        attachmentIds: draft.input.attachmentIds,
        captureBundleId: draft.input.captureBundleId,
        createdAt: stamp(),
      }),
    );
    const attachmentId = draft.input.attachmentIds[0]!,
      captureId = draft.input.captureBundleId!;
    assert.ok(getMobileCapture(f.database, { ...f.scope, captureId }));
    assert.ok(getMobileAttachment(f.database, f.roots, { ...f.scope, attachmentId }));
    assert.ok(
      getMobileCaptureArtifact(f.database, f.roots, {
        ...f.scope,
        bugId: created.bug.id,
        captureId,
        artifactKind: "system_screenshot",
      }),
    );
    tx(f.database, () =>
      updateMobileBug(f.database, {
        ...f.common(),
        bugId: created.bug.id,
        expectedVersion: created.bug.version,
        attachmentIds: [],
      }),
    );
    assert.equal(getMobileCapture(f.database, { ...f.scope, captureId }), null);
    assert.equal(getMobileAttachment(f.database, f.roots, { ...f.scope, attachmentId }), null);
    assert.equal(
      getMobileCaptureArtifact(f.database, f.roots, {
        ...f.scope,
        bugId: created.bug.id,
        captureId,
        artifactKind: "system_screenshot",
      }),
      null,
    );
    assert.equal(
      f.database.prepare("SELECT count(*) AS n FROM attachments WHERE id=?").get(attachmentId)![
        "n"
      ],
      1,
    );
    assert.equal(
      f.database.prepare("SELECT count(*) AS n FROM capture_bundles WHERE id=?").get(captureId)![
        "n"
      ],
      1,
    );
  } finally {
    f.database.close();
  }
});

test("actual PNG bytes total exactly100MiB succeeds and one additional byte is rejected atomically", async (t) => {
  const f = await evidenceFixture(t);
  try {
    const bytes = paddedPng(5 * 1024 * 1024);
    const exact = f.stage(20, false, undefined, bytes);
    assert.equal(
      exact.attachments.reduce((sum, item) => sum + item.size, 0),
      100 * 1024 * 1024,
    );
    assert.equal(f.submit(exact.input).attachmentIds.length, 20);
    const overflow = f.stage(19, false, undefined, bytes),
      extra = f.upload(overflow.input.clientSubmissionId!, null, paddedPng(bytes.length + 1));
    const { bindMobileAttachment } = await import("../src/mobile-attachment-store.ts");
    const extraBinding = tx(f.database, () =>
      bindMobileAttachment(f.database, {
        ...f.scope,
        attachmentId: extra.attachmentId,
        expectedVersion: extra.version,
        clientSubmissionId: overflow.input.clientSubmissionId!,
        clientAttachmentId: extra.clientAttachmentId,
        leaseGeneration: 1,
        intent: "verification_result",
        targetQaItemId: overflow.bugId,
        boundAt: stamp(),
      }),
    );
    const input = {
      ...overflow.input,
      attachmentIds: [...overflow.input.attachmentIds, extra.attachmentId],
      createdAt: stamp(),
    };
    const before = fingerprint(f.database);
    assert.throws(() => f.submit(input), { code: "INVALID_REQUEST" });
    assert.deepEqual(fingerprint(f.database), before);
    assert.equal(f.submit(overflow.input).attachmentIds.length, 19);
    const linked = f.database
      .prepare(
        `SELECT count(*) AS count, sum(attachment.size_bytes) AS bytes
         FROM verification_attachments AS link
         JOIN attachments AS attachment
           ON attachment.account_id=link.account_id
          AND attachment.project_id=link.project_id
          AND attachment.id=link.attachment_id
         WHERE link.account_id=? AND link.project_id=? AND link.verification_id=?`,
      )
      .get(f.scope.accountId, f.scope.projectId, overflow.verification.id)!;
    assert.equal(linked["count"], 19);
    assert.equal(linked["bytes"], 95 * 1024 * 1024);
    const beforeDirectInsert = fingerprint(f.database);
    assert.throws(
      () =>
        tx(f.database, () =>
          claimAndInsertVerificationAttachment(f.database, {
            ...f.scope,
            verificationId: overflow.verification.id,
            attachmentId: extra.attachmentId,
            bindingId: extraBinding.bindingId,
          }),
        ),
      /Verification evidence permits at most twenty attachments totaling 100 MiB/,
    );
    assert.deepEqual(fingerprint(f.database), beforeDirectInsert);
    t.diagnostic(
      "Actual valid ancillary-padded PNG upload/finalize/claim: 104857600 bytes committed; 104857601 bytes rejected by TypeScript and the raw SQLite trigger; direct claim rolled back; all files retained",
    );
  } finally {
    f.database.close();
  }
});
