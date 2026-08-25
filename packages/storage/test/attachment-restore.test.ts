import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  AttachmentRestoreError,
  restoreReferencedAttachmentsToIsolatedRoot,
} from "../src/attachment-restore.js";

const APPLICATION_ID = 0x51414842;
const ATTACHMENT_ID = "10000000-0000-4000-8000-000000000001";
const BLOB_ID = "10000000-0000-4000-8000-000000000002";
const ACCOUNT_ID = "10000000-0000-4000-8000-000000000003";

function createFixture(
  root: string,
  bytes: Buffer,
  writeEvidence: boolean,
): {
  readonly databasePath: string;
  readonly evidenceRoot: string;
  readonly storageKey: string;
} {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storageKey = join("sha256", sha256.slice(0, 2), sha256);
  const databasePath = join(root, "db", "qa-hub.sqlite");
  const evidenceRoot = join(root, "evidence");
  mkdirSync(join(root, "db"));
  mkdirSync(evidenceRoot);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA application_id = ${APPLICATION_ID};
      PRAGMA user_version = 4;
      CREATE TABLE blobs (
        id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE attachments (
        id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        blob_id TEXT NOT NULL,
        status TEXT NOT NULL,
        scan_state TEXT NOT NULL
      );
    `);
    database
      .prepare(
        "INSERT INTO blobs(id, account_id, size_bytes, sha256, storage_key, state) VALUES (?, ?, ?, ?, ?, 'ready')",
      )
      .run(BLOB_ID, ACCOUNT_ID, bytes.length, sha256, storageKey);
    database
      .prepare(
        "INSERT INTO attachments(id, account_id, blob_id, status, scan_state) VALUES (?, ?, ?, 'ready', 'clean')",
      )
      .run(ATTACHMENT_ID, ACCOUNT_ID, BLOB_ID);
  } finally {
    database.close();
  }
  if (writeEvidence) {
    const evidencePath = join(evidenceRoot, storageKey);
    mkdirSync(join(evidenceRoot, "sha256", sha256.slice(0, 2)), { recursive: true });
    writeFileSync(evidencePath, bytes, { flag: "wx" });
  }
  return { databasePath, evidenceRoot, storageKey };
}

test("inventories and restores one real referenced attachment", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-qa-hub-attachment-restore-"));
  try {
    const bytes = Buffer.from("real attachment bytes");
    const fixture = createFixture(root, bytes, true);
    const restoreRoot = join(root, "isolated-evidence");
    const result = await restoreReferencedAttachmentsToIsolatedRoot({
      databasePath: fixture.databasePath,
      evidenceRoot: fixture.evidenceRoot,
      restoreRoot,
      createdAt: "2026-08-26T00:00:00.000Z",
    });

    assert.equal(result.manifest.entries.length, 1);
    assert.deepEqual(readFileSync(join(restoreRoot, fixture.storageKey)), bytes);
    assert.equal(JSON.parse(readFileSync(result.completeMarkerPath, "utf8")).state, "complete");
    assert.equal(readFileSync(result.manifestPath, "utf8").includes(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains a failed marker when an inventoried attachment is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-qa-hub-attachment-restore-missing-"));
  try {
    const fixture = createFixture(root, Buffer.from("missing attachment bytes"), false);
    const restoreRoot = join(root, "isolated-evidence");
    await assert.rejects(
      restoreReferencedAttachmentsToIsolatedRoot({
        databasePath: fixture.databasePath,
        evidenceRoot: fixture.evidenceRoot,
        restoreRoot,
      }),
      (error: unknown) =>
        error instanceof AttachmentRestoreError &&
        error.code === "ATTACHMENT_RESTORE_SOURCE_INVALID",
    );
    assert.equal(
      JSON.parse(readFileSync(join(restoreRoot, ".qa-hub-attachment-restore.failed.json"), "utf8"))
        .state,
      "failed",
    );
    assert.equal(
      readFileSync(join(restoreRoot, ".qa-hub-attachment-inventory.json"), "utf8").includes(root),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a non-canonical storage key before writing a manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-qa-hub-attachment-key-"));
  try {
    const fixture = createFixture(root, Buffer.from("malicious path bytes"), true);
    const database = new DatabaseSync(fixture.databasePath);
    try {
      database.prepare("UPDATE blobs SET storage_key = ?").run(join(root, "source-secret"));
    } finally {
      database.close();
    }
    const restoreRoot = join(root, "isolated-evidence");
    await assert.rejects(
      restoreReferencedAttachmentsToIsolatedRoot({
        databasePath: fixture.databasePath,
        evidenceRoot: fixture.evidenceRoot,
        restoreRoot,
      }),
      (error: unknown) =>
        error instanceof AttachmentRestoreError &&
        error.code === "ATTACHMENT_RESTORE_DATABASE_INVALID",
    );
    assert.equal(existsSync(restoreRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a restore parent that resolves into the source evidence root", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-qa-hub-attachment-junction-"));
  try {
    const fixture = createFixture(root, Buffer.from("junction bytes"), true);
    const linkedParent = join(root, "evidence-link");
    symlinkSync(
      fixture.evidenceRoot,
      linkedParent,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      restoreReferencedAttachmentsToIsolatedRoot({
        databasePath: fixture.databasePath,
        evidenceRoot: fixture.evidenceRoot,
        restoreRoot: join(linkedParent, "nested-restore"),
      }),
      (error: unknown) =>
        error instanceof AttachmentRestoreError &&
        error.code === "ATTACHMENT_RESTORE_CONFIGURATION_INVALID",
    );
    assert.equal(existsSync(join(fixture.evidenceRoot, "nested-restore")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
