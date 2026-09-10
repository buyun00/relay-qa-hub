import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createMobileNotificationReadRequestDigest, deriveMobileReplayDigestKey } from "../../../../apps/api/dist/mobile-replay-digest.js";

const summaryPath = new URL("./live-http-e2e.json", import.meta.url);
const outputPath = new URL("./live-http-db-receipt.json", import.meta.url);
const instancePath =
  "C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-v21-e2e-fresh-0910/instance.json";
const databasePath =
  "C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-v21-e2e-fresh-0910/data/db/qa-hub.sqlite";

const summary = JSON.parse(await readFile(summaryPath, "utf8"));
const instance = JSON.parse(await readFile(instancePath, "utf8"));
const secrets = JSON.parse(await readFile(instance.secretsFile, "utf8"));
assert.equal(typeof secrets.debugToken, "string");
assert.ok(secrets.debugToken.length > 0);

const database = new DatabaseSync(databasePath, { readOnly: true });
database.exec("PRAGMA query_only = ON");
try {
  const integrity = database.prepare("PRAGMA integrity_check").all();
  assert.equal(integrity.length, 1);
  assert.equal(integrity[0].integrity_check, "ok");
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  assert.equal(foreignKeyViolations.length, 0);

  const notificationId = summary.notification.id;
  const projectId = summary.projects.a.id;
  const actorId = summary.projects.a.userId;
  const receipts = database
    .prepare(
      `SELECT id, account_id, project_id, actor_id, operation_id, idempotency_key,
              scope_digest, scope_json, request_digest, status, http_status,
              response_json, audit_event_id, created_at, expires_at, version
       FROM idempotency_records
       WHERE project_id = ? AND actor_id = ? AND operation_id = 'markNotificationRead'
         AND idempotency_key LIKE ?`,
    )
    .all(projectId, actorId, `notification:${notificationId}:read:%`);
  assert.equal(receipts.length, 1);
  const receipt = receipts[0];
  const prefix = `notification:${notificationId}:read:`;
  assert.ok(receipt.idempotency_key.startsWith(prefix));
  const rawIdempotencyKey = receipt.idempotency_key.slice(prefix.length);
  assert.ok(rawIdempotencyKey.length > 0);

  const expectedDigest = createMobileNotificationReadRequestDigest({
    key: deriveMobileReplayDigestKey(secrets.debugToken),
    accountId: receipt.account_id,
    projectId,
    actorId,
    notificationId,
    idempotencyKey: rawIdempotencyKey,
    request: { expectedVersion: summary.notification.versionBefore },
  });
  assert.equal(receipt.request_digest, expectedDigest);
  assert.equal(receipt.status, "committed");
  assert.equal(receipt.http_status, 200);
  assert.equal(receipt.version, 2);

  const scope = JSON.parse(receipt.scope_json);
  assert.deepEqual(scope, {
    operationId: "markNotificationRead",
    accountId: receipt.account_id,
    projectId,
    actorId,
    notificationId,
  });
  assert.equal(createHash("sha256").update(receipt.scope_json).digest("hex"), receipt.scope_digest);

  const notification = database
    .prepare(
      `SELECT id, account_id, project_id, user_id, read_at, version
       FROM notifications WHERE id = ? AND project_id = ? AND user_id = ?`,
    )
    .get(notificationId, projectId, actorId);
  assert.ok(notification);
  assert.equal(notification.read_at, summary.notification.readAt);
  assert.equal(notification.version, summary.notification.versionAfter);

  const events = database
    .prepare(
      `SELECT id, account_id, project_id, actor_user_id, aggregate_type, aggregate_id,
              aggregate_sequence, resource_type, resource_id, resource_version_after,
              request_digest, payload_json, created_at
       FROM events
       WHERE project_id = ? AND type = 'notification.read' AND resource_id = ?`,
    )
    .all(projectId, notificationId);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.id, receipt.audit_event_id);
  assert.equal(event.account_id, receipt.account_id);
  assert.equal(event.actor_user_id, actorId);
  assert.equal(event.aggregate_type, "notification");
  assert.equal(event.aggregate_id, notificationId);
  assert.equal(event.aggregate_sequence, summary.notification.versionAfter);
  assert.equal(event.resource_type, "notification");
  assert.equal(event.resource_version_after, summary.notification.versionAfter);
  assert.equal(event.request_digest, expectedDigest);
  assert.deepEqual(JSON.parse(event.payload_json), {
    fromVersion: summary.notification.versionBefore,
    toVersion: summary.notification.versionAfter,
  });

  const response = JSON.parse(receipt.response_json);
  assert.equal(response.id, notificationId);
  assert.equal(response.accountId, receipt.account_id);
  assert.equal(response.projectId, projectId);
  assert.equal(response.userId, actorId);
  assert.equal(response.readAt, summary.notification.readAt);
  assert.equal(response.version, summary.notification.versionAfter);

  const evidence = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    sourceCommit: summary.sourceCommit,
    database: {
      openedReadOnly: true,
      queryOnly: true,
      integrity: "ok",
      foreignKeyViolationCount: foreignKeyViolations.length,
      journalMode: database.prepare("PRAGMA journal_mode").get().journal_mode,
    },
    notification: {
      id: notificationId,
      projectId,
      actorId,
      persistedReadAtMatchesHttp: true,
      persistedVersion: notification.version,
    },
    receipt: {
      count: receipts.length,
      id: receipt.id,
      operationId: receipt.operation_id,
      status: receipt.status,
      httpStatus: receipt.http_status,
      version: receipt.version,
      requestDigest: receipt.request_digest,
      digestAlgorithm: "HMAC-SHA-256",
      digestMatchesCanonicalRequestAndProtectedServerKey: true,
      scopeDigestMatchesStoredCanonicalScope: true,
      responseMatchesPersistedNotification: true,
      rawIdempotencyKeyPersistedInEvidence: false,
      serverDigestKeyPersistedInEvidence: false,
    },
    auditEvent: {
      count: events.length,
      id: event.id,
      type: "notification.read",
      receiptPointsToExactEvent: true,
      digestMatchesReceipt: true,
      versionTransition: JSON.parse(event.payload_json),
    },
    passed: true,
  };
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  database.close();
}
