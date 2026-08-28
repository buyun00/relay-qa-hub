import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  insertBugWithNextNumber,
  migrateSqliteDatabase,
  openSqliteDatabaseForWorker,
  verifySqliteIntegrity,
} from "../src/sqlite.ts";
import { createMobileBug, deleteMobileBug, getMobileBug } from "../src/mobile-bug-store.ts";
import { listMobileBugs } from "../src/mobile-bug-list-store.ts";
import { syncAndListMobileNotifications } from "../src/mobile-inbox-store.ts";
import {
  createMobileManualRepairAttempt,
  createMobileRelayAttempt,
  deliverMobileRepairAttempt,
  startMobileRepairAttempt,
  transitionMobileBugReady,
} from "../src/mobile-relay-store.ts";
import {
  createMobileVerification,
  recordMobileVerificationResult,
  startMobileVerification,
} from "../src/mobile-verification-store.ts";

const CREATED_AT = "2026-08-25T00:00:00.000Z";
const UPDATED_AT = "2026-08-25T00:01:00.000Z";
const FINALIZED_AT = "2026-08-25T00:02:00.000Z";

interface TenantFixture {
  readonly accountId: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly secondaryUserId: string;
  readonly userId: string;
}

interface UploadFixture {
  readonly actorId: string;
  readonly attachmentId: string;
  readonly blobId: string;
  readonly captureId: string | null;
  readonly clientAttachmentId: string;
  readonly clientSubmissionId: string;
  readonly digest: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly uploadId: string;
}

function identifier(sequence: number): string {
  return `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function digest(sequence: number): string {
  return sequence.toString(16).padStart(64, "0");
}

function closeDatabase(database: DatabaseSync): void {
  try {
    database.close();
  } catch {
    // The connection may already be closed after an assertion path.
  }
}

async function withDatabase(work: (database: DatabaseSync) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "relay-qa-hub-invariants-"));
  const databaseFile = join(root, "db", "qa-hub.sqlite");
  const database = openSqliteDatabaseForWorker({ databaseFile, busyTimeoutMs: 2_000 });
  try {
    await migrateSqliteDatabase(database, databaseFile);
    await work(database);
  } finally {
    closeDatabase(database);
    rmSync(root, { recursive: true, force: true });
  }
}

function assertIntegrity(database: DatabaseSync): void {
  assert.deepEqual(verifySqliteIntegrity(database), {
    foreignKeyViolations: [],
    integrityMessages: ["ok"],
    ok: true,
  });
}

function databaseTime(database: DatabaseSync, modifier = "+0 seconds"): string {
  const value = database
    .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) AS value")
    .get(modifier)?.value;
  if (typeof value !== "string") throw new TypeError("SQLite did not return a timestamp");
  return value;
}

let rejectionProbeSequence = 0;

function probeSqlRejection(database: DatabaseSync, action: () => void): unknown | undefined {
  rejectionProbeSequence += 1;
  const savepoint = `invariant_rejection_probe_${rejectionProbeSequence}`;
  database.exec(`SAVEPOINT ${savepoint}`);
  let rejection: unknown | undefined;
  try {
    action();
  } catch (error) {
    rejection = error;
  } finally {
    database.exec(`ROLLBACK TO ${savepoint}`);
    database.exec(`RELEASE ${savepoint}`);
  }
  return rejection;
}

function insertCurrentNativeSession(
  database: DatabaseSync,
  tenant: TenantFixture,
  installationId: string,
  sequence: number,
): void {
  const issuedAt = databaseTime(database);
  database
    .prepare(
      `INSERT INTO native_sessions(
        id, account_id, user_id, installation_id, access_token_digest,
        shared_device, push_allowed, issued_at, access_expires_at,
        idle_expires_at, absolute_expires_at, last_seen_at, version
      ) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      identifier(sequence),
      tenant.accountId,
      tenant.userId,
      installationId,
      digest(sequence),
      issuedAt,
      databaseTime(database, "+15 minutes"),
      databaseTime(database, "+1 hour"),
      databaseTime(database, "+1 day"),
      issuedAt,
    );
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

interface PersonalAuthFixture {
  readonly absoluteExpiresAt: string;
  readonly familyCreatedAt: string;
  readonly familyId: string;
  readonly installationId: string;
  readonly now: string;
  readonly sessionId: string;
  readonly tokenId: string;
}

function insertPersonalAuthFixture(
  database: DatabaseSync,
  tenant: TenantFixture,
  base: number,
  options: { readonly insertToken?: boolean } = {},
): PersonalAuthFixture {
  const now = databaseTime(database);
  const nowMs = Date.parse(now);
  const at = (offsetSeconds: number): string =>
    new Date(nowMs + offsetSeconds * 1_000).toISOString();
  const installationId = identifier(base);
  const sessionId = identifier(base + 1);
  const familyId = identifier(base + 2);
  const tokenId = identifier(base + 3);
  const issuedAt = at(-60);
  const familyCreatedAt = at(-1);
  const absoluteExpiresAt = at(31 * 24 * 60 * 60);

  database
    .prepare(
      `INSERT INTO device_installations(
        id, account_id, installation_id, platform, app_version,
        device_metadata_json, shared_device, first_seen_at, last_seen_at, version
      ) VALUES (?, ?, ?, 'android', '0.1.0-debug', '{}', 0, ?, ?, 1)`,
    )
    .run(installationId, tenant.accountId, identifier(base + 4), issuedAt, issuedAt);
  database
    .prepare(
      `INSERT INTO native_sessions(
        id, account_id, user_id, installation_id, access_token_digest,
        shared_device, push_allowed, issued_at, access_expires_at,
        idle_expires_at, absolute_expires_at, last_seen_at, version
      ) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      sessionId,
      tenant.accountId,
      tenant.userId,
      installationId,
      digest(base),
      issuedAt,
      at(14 * 60),
      at(24 * 60 * 60),
      absoluteExpiresAt,
      issuedAt,
    );
  database
    .prepare(
      `INSERT INTO refresh_token_families(
        id, account_id, user_id, session_id, installation_id, status,
        created_at, version
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, 1)`,
    )
    .run(familyId, tenant.accountId, tenant.userId, sessionId, installationId, familyCreatedAt);
  if (options.insertToken !== false) {
    database
      .prepare(
        `INSERT INTO refresh_tokens(
          id, account_id, family_id, generation, token_digest, status,
          issued_at, expires_at, version
        ) VALUES (?, ?, ?, 1, ?, 'active', ?, ?, 1)`,
      )
      .run(tokenId, tenant.accountId, familyId, digest(base + 3), now, at(24 * 60 * 60));
  }

  return {
    absoluteExpiresAt,
    familyCreatedAt,
    familyId,
    installationId,
    now,
    sessionId,
    tokenId,
  };
}

function seedTenant(database: DatabaseSync, base: number, projectKey: string): TenantFixture {
  const accountId = identifier(base);
  const userId = identifier(base + 1);
  const secondaryUserId = identifier(base + 2);
  const projectId = identifier(base + 3);
  database
    .prepare(
      `INSERT INTO accounts(
        id, slug, display_name, status, created_at, updated_at, version
      ) VALUES (?, ?, ?, 'active', ?, ?, 1)`,
    )
    .run(accountId, `tenant-${base}`, `Tenant ${base}`, CREATED_AT, CREATED_AT);
  const insertUser = database.prepare(
    `INSERT INTO users(
      id, account_id, email, display_name, status, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
  );
  insertUser.run(
    userId,
    accountId,
    `primary-${base}@example.invalid`,
    "Primary QA",
    CREATED_AT,
    CREATED_AT,
  );
  insertUser.run(
    secondaryUserId,
    accountId,
    `secondary-${base}@example.invalid`,
    "Secondary QA",
    CREATED_AT,
    CREATED_AT,
  );
  database
    .prepare(
      `INSERT INTO projects(
        id, account_id, project_key, name, status, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
    )
    .run(projectId, accountId, projectKey, `Project ${projectKey}`, CREATED_AT, CREATED_AT);
  return { accountId, projectId, projectKey, secondaryUserId, userId };
}

function createBug(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  title: string,
  assignments: {
    readonly ownerId?: string | null;
    readonly verificationOwnerId?: string | null;
  } = {},
): void {
  transaction(database, () => {
    insertBugWithNextNumber(database, {
      id: bugId,
      accountId: tenant.accountId,
      projectId: tenant.projectId,
      title,
      description: "Invariant regression record",
      expectedBehavior: "Cross-entity identities remain in the same QA Bug scope",
      severity: "S2",
      priority: "P2",
      reporterId: tenant.userId,
      ownerId: assignments.ownerId,
      verificationOwnerId: assignments.verificationOwnerId,
      createdAt: CREATED_AT,
    });
  });
}

function insertRepairAttempt(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  sequence = 1,
  status: "running" | "delivered" = "delivered",
  mode: "human" | "relay" = "human",
  noCodeReason = "No executable change",
  deliveryCommitSha: string | null = null,
  auditNoCodeReasonOverride?: string,
): void {
  const attemptSequence = Number(attemptId.slice(-12));
  const createdAt = "2026-08-24T23:58:00.000Z";
  const startedAt = "2026-08-24T23:59:00.000Z";
  insertActiveMembershipRole(
    database,
    tenant,
    identifier(8_000_000 + attemptSequence),
    "developer",
  );
  insertBugWorkflowEvent(database, tenant, {
    aggregateId: attemptId,
    aggregateSequence: 80_000_000 + attemptSequence * 10 + 1,
    aggregateType: "repair_attempt",
    bugId,
    createdAt,
    eventId: identifier(8_100_000 + attemptSequence * 10 + 1),
    eventType: "repair_attempt.created",
    fromState: "ready",
    payload: { status: "planned", repairAttemptId: attemptId, fromVersion: 1, toVersion: 2 },
    resourceId: attemptId,
    resourceType: "repair_attempt",
    resourceVersionAfter: 1,
    toState: "in_progress",
  });
  database
    .prepare(
      `INSERT INTO repair_attempts(
        id, account_id, project_id, bug_id, sequence, mode, status,
        assignee_id, summary, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, 'Fixture repair', ?, ?, 1)`,
    )
    .run(
      attemptId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      sequence,
      mode,
      tenant.userId,
      createdAt,
      createdAt,
    );
  insertBugWorkflowEvent(database, tenant, {
    aggregateId: attemptId,
    aggregateSequence: 80_000_000 + attemptSequence * 10 + 2,
    aggregateType: "repair_attempt",
    bugId,
    createdAt: startedAt,
    eventId: identifier(8_100_000 + attemptSequence * 10 + 2),
    eventType: "repair_attempt.started",
    fromState: null,
    payload: { status: "running", repairAttemptId: attemptId, fromVersion: 1, toVersion: 2 },
    resourceId: attemptId,
    resourceType: "repair_attempt",
    resourceVersionAfter: 2,
    toState: null,
  });
  database
    .prepare(
      `UPDATE repair_attempts
       SET status = 'running', updated_at = ?, version = 2
       WHERE id = ? AND version = 1`,
    )
    .run(startedAt, attemptId);
  if (status === "delivered") {
    const auditNoCodeReason =
      auditNoCodeReasonOverride ??
      (noCodeReason.length <= 2_000 ? noCodeReason : `${noCodeReason.slice(0, 1_997)}…`);
    insertBugWorkflowEvent(database, tenant, {
      aggregateId: attemptId,
      aggregateSequence: 80_000_000 + attemptSequence * 10 + 3,
      aggregateType: "repair_attempt",
      bugId,
      createdAt: CREATED_AT,
      eventId: identifier(8_100_000 + attemptSequence * 10 + 3),
      eventType: "repair_attempt.delivered",
      fromState: "in_progress",
      payload: {
        status: "delivered",
        repairAttemptId: attemptId,
        ...(deliveryCommitSha === null
          ? { reason: auditNoCodeReason }
          : { commitSha: deliveryCommitSha }),
        fromVersion: 2,
        toVersion: 3,
      },
      resourceId: identifier(8_900_000 + attemptSequence),
      resourceType: "build_requirement",
      resourceVersionAfter: 1,
      toState: deliveryCommitSha === null ? "ready_for_verification" : "awaiting_build",
    });
    if (deliveryCommitSha === null) {
      database
        .prepare(
          `UPDATE repair_attempts
           SET status = 'delivered', summary = 'Fixture delivery', no_code_reason = ?,
               updated_at = ?, version = 3
           WHERE id = ? AND version = 2`,
        )
        .run(noCodeReason, CREATED_AT, attemptId);
    } else {
      database
        .prepare(
          `UPDATE repair_attempts
           SET status = 'delivered', summary = 'Fixture delivery', branch = 'main', commit_sha = ?,
               updated_at = ?, version = 3
           WHERE id = ? AND version = 2`,
        )
        .run(deliveryCommitSha, CREATED_AT, attemptId);
    }
  }
}

function insertForwardNoBuildDeliveryAudit(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  requirementId: string,
  eventId: string,
  eventType: "repair_attempt.delivered" | "repair.delivered",
  decisionReason: string,
  auditDecisionReason = decisionReason,
): string {
  const requestDigest = digest(Number(requirementId.slice(-12)));
  const payloadJson = JSON.stringify({
    status: "delivered",
    repairAttemptId: attemptId,
    reason: auditDecisionReason,
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
        ?, ?, ?, ?, ?, 'qa_hub', 'user', ?, 'repair_attempt', ?, 3,
        'build_requirement', ?, 1, ?, ?, ?, ?
      )`,
    )
    .run(
      eventId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      eventType,
      tenant.userId,
      attemptId,
      requirementId,
      requestDigest,
      identifier(Number(eventId.slice(-12)) + 200_000),
      payloadJson,
      CREATED_AT,
    );
  return payloadJson;
}

function insertForwardNoBuildRequirement(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  requirementId: string,
  auditEventId: string,
  decisionReason: string,
): void {
  insertActiveMembershipRole(
    database,
    tenant,
    identifier(Number(requirementId.slice(-12)) + 700_000),
    "developer",
  );
  database
    .prepare(
      `INSERT INTO build_requirements(
        id, account_id, project_id, bug_id, repair_attempt_id,
        source_delivery_version, delivered_commit_sha, requirement, decision_basis,
        decision_reason, decision_actor_id, decision_audit_event_id,
        delivery_request_digest, policy_version, bug_version_at_delivery,
        created_at, updated_at, version
      ) VALUES (
        ?, ?, ?, ?, ?, 3, NULL, 'not_required', 'no_code_delivery',
        ?, ?, ?, ?, '1.0.0', 1, ?, ?, 1
      )`,
    )
    .run(
      requirementId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      attemptId,
      decisionReason,
      tenant.userId,
      auditEventId,
      digest(Number(requirementId.slice(-12))),
      CREATED_AT,
      CREATED_AT,
    );
}

function insertQaAuditEvent(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  eventId: string,
  attemptId: string,
  requirementId: string,
  aggregateSequence = 3,
): void {
  const requestDigest = digest(Number(requirementId.slice(-12)));
  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
        resource_type, resource_id, resource_version_after, request_digest,
        correlation_id, payload_json, created_at
      ) VALUES (
        ?, ?, ?, ?, 'repair_attempt.delivered', 'qa_hub', 'user', ?,
        'repair_attempt', ?, ?, 'build_requirement', ?, 1, ?, ?, ?, ?
      )`,
    )
    .run(
      eventId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      tenant.userId,
      attemptId,
      aggregateSequence,
      requirementId,
      requestDigest,
      identifier(Number(eventId.slice(-12)) + 100_000),
      JSON.stringify({
        status: "delivered",
        repairAttemptId: attemptId,
        reason: "No executable change",
        fromVersion: 2,
        toVersion: 3,
      }),
      CREATED_AT,
    );
}

function insertBuildRequirement(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  auditEventId: string,
  requirementId: string,
): void {
  insertActiveMembershipRole(
    database,
    tenant,
    identifier(Number(requirementId.slice(-12)) + 700_000),
    "developer",
  );
  database
    .prepare(
      `INSERT INTO build_requirements(
        id, account_id, project_id, bug_id, repair_attempt_id,
        source_delivery_version, delivered_commit_sha, requirement, decision_basis,
        decision_reason, decision_actor_id, decision_audit_event_id,
        delivery_request_digest, policy_version, bug_version_at_delivery,
        created_at, updated_at, version
      ) VALUES (
        ?, ?, ?, ?, ?, 3, NULL, 'not_required', 'no_code_delivery',
        'No executable change', ?, ?, ?, '1.0.0', 1, ?, ?, 1
      )`,
    )
    .run(
      requirementId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      attemptId,
      tenant.userId,
      auditEventId,
      digest(Number(requirementId.slice(-12))),
      CREATED_AT,
      CREATED_AT,
    );
}

function insertVerification(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  verificationId: string,
  verifierId = tenant.userId,
  buildId: string | null = null,
  createdAt = CREATED_AT,
  auditEventId = identifier(8_300_000 + Number(verificationId.slice(-12))),
  criteria = "Reproduce and verify",
  creatorId = verifierId,
): void {
  insertActiveMembershipRole(
    database,
    tenant,
    identifier(8_400_000 + Number(verificationId.slice(-12))),
    "verifier",
    verifierId,
  );
  insertActiveMembershipRole(
    database,
    tenant,
    identifier(8_500_000 + Number(verificationId.slice(-12))),
    "verifier",
    creatorId,
  );
  insertBugWorkflowEvent(database, tenant, {
    actorUserId: creatorId,
    aggregateId: verificationId,
    aggregateSequence: 83_000_000 + Number(verificationId.slice(-12)),
    aggregateType: "verification",
    bugId,
    createdAt,
    eventId: auditEventId,
    eventType: "verification.created",
    fromState: null,
    payload: {
      status: "requested",
      verificationId,
      repairAttemptId: attemptId,
      ...(buildId === null ? {} : { buildId }),
      toVersion: 1,
    },
    resourceId: verificationId,
    resourceType: "verification",
    resourceVersionAfter: 1,
    toState: null,
  });
  database
    .prepare(
      `INSERT INTO verifications(
        id, account_id, project_id, bug_id, repair_attempt_id, status,
        verifier_id, build_id, criteria_snapshot, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      verificationId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      attemptId,
      verifierId,
      buildId,
      criteria,
      createdAt,
      createdAt,
    );
}

function insertActiveMembershipRole(
  database: DatabaseSync,
  tenant: TenantFixture,
  membershipId: string,
  role: "viewer" | "reporter" | "developer" | "triager" | "verifier" | "release_manager",
  userId = tenant.userId,
): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO memberships(
        id, account_id, project_id, user_id, status, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
    )
    .run(membershipId, tenant.accountId, tenant.projectId, userId, CREATED_AT, CREATED_AT);
  const effectiveMembershipId = String(
    database
      .prepare(
        `SELECT id FROM memberships
         WHERE account_id = ? AND project_id = ? AND user_id = ?`,
      )
      .get(tenant.accountId, tenant.projectId, userId)?.id ?? membershipId,
  );
  database
    .prepare(
      `INSERT OR IGNORE INTO membership_roles(account_id, project_id, membership_id, role, granted_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(tenant.accountId, tenant.projectId, effectiveMembershipId, role, CREATED_AT);
}

test("new Bug notifications include content and route unassigned versus assigned work", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 930, "NOTIFY");
    insertActiveMembershipRole(database, tenant, identifier(934), "reporter");
    insertActiveMembershipRole(
      database,
      tenant,
      identifier(935),
      "developer",
      tenant.secondaryUserId,
    );
    const input = {
      accountId: tenant.accountId,
      projectId: tenant.projectId,
      actorId: tenant.userId,
      clientSubmissionId: identifier(936),
      payloadDigest: digest(937),
      title: "New notification Bug",
      description: "New notification Bug content",
      expectedBehavior: "The issue no longer reproduces",
      severity: "S2" as const,
      priority: "P2" as const,
      ownerId: null,
      verificationOwnerId: null,
      occurrence: {
        observedAt: CREATED_AT,
        platform: "web" as const,
        steps: ["Open the affected screen"] as const,
        actualBehavior: "The issue is visible",
      },
      attachmentIds: [] as const,
      captureBundleId: null,
      createdAt: CREATED_AT,
    };

    const created = transaction(database, () => createMobileBug(database, input));
    assert.equal(created.replayed, false);
    const primaryInbox = transaction(database, () =>
      syncAndListMobileNotifications(database, {
        accountId: tenant.accountId,
        projectId: tenant.projectId,
        actorId: tenant.userId,
        limit: 100,
        now: UPDATED_AT,
      }),
    );
    assert.equal(primaryInbox.consumed, 1);
    assert.equal(primaryInbox.items.length, 1);
    assert.equal(primaryInbox.items[0]?.title, "有一个新单子");
    assert.equal(primaryInbox.items[0]?.body, "NOTIFY-1 · New notification Bug content");
    assert.equal(primaryInbox.items[0]?.bugId, created.bug.id);
    assert.equal(primaryInbox.items[0]?.sourceEventId, created.eventId);

    const secondaryInbox = transaction(database, () =>
      syncAndListMobileNotifications(database, {
        accountId: tenant.accountId,
        projectId: tenant.projectId,
        actorId: tenant.secondaryUserId,
        limit: 100,
        now: UPDATED_AT,
      }),
    );
    assert.equal(secondaryInbox.items.length, 1);
    assert.equal(secondaryInbox.items[0]?.sourceEventId, created.eventId);

    const assignedInput = {
      ...input,
      clientSubmissionId: identifier(938),
      payloadDigest: digest(939),
      title: "Assigned notification Bug",
      description: "Assigned notification Bug content",
      ownerId: tenant.secondaryUserId,
    };
    const assigned = transaction(database, () => createMobileBug(database, assignedInput));
    const primaryAfterAssigned = transaction(database, () =>
      syncAndListMobileNotifications(database, {
        accountId: tenant.accountId,
        projectId: tenant.projectId,
        actorId: tenant.userId,
        limit: 100,
        now: FINALIZED_AT,
      }),
    );
    assert.equal(primaryAfterAssigned.consumed, 1);
    assert.equal(
      primaryAfterAssigned.items.some((item) => item.sourceEventId === assigned.eventId),
      false,
    );
    const secondaryAfterAssigned = transaction(database, () =>
      syncAndListMobileNotifications(database, {
        accountId: tenant.accountId,
        projectId: tenant.projectId,
        actorId: tenant.secondaryUserId,
        limit: 100,
        now: FINALIZED_AT,
      }),
    );
    const assignedNotification = secondaryAfterAssigned.items.find(
      (item) => item.sourceEventId === assigned.eventId,
    );
    assert.equal(assignedNotification?.title, "有一个新单子");
    assert.equal(assignedNotification?.body, "NOTIFY-2 · Assigned notification Bug content");

    const replayed = transaction(database, () => createMobileBug(database, input));
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.eventId, created.eventId);
    const afterReplay = transaction(database, () =>
      syncAndListMobileNotifications(database, {
        accountId: tenant.accountId,
        projectId: tenant.projectId,
        actorId: tenant.userId,
        limit: 100,
        now: FINALIZED_AT,
      }),
    );
    assert.equal(afterReplay.consumed, 0);
    assert.equal(afterReplay.items.length, 1);
    const outbox = database
      .prepare(
        `SELECT COUNT(*) AS count, MIN(status) AS status
         FROM outbox
         WHERE account_id = ? AND project_id = ? AND destination = 'qa-hub.notifications'
           AND event_id = ?`,
      )
      .get(tenant.accountId, tenant.projectId, created.eventId) as {
      readonly count: number;
      readonly status: string;
    };
    assert.equal(outbox.count, 1);
    assert.equal(outbox.status, "sent");
    assertIntegrity(database);
  });
});

function insertVerificationClosureEvent(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  verificationId: string,
  eventId: string,
  closedAt: string,
  buildId: string | null,
  aggregateSequence = 2,
  reason: string | null = null,
): void {
  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
        resource_type, resource_id, resource_version_after, request_digest,
        correlation_id, from_state, to_state, payload_json, created_at
      ) VALUES (
        ?, ?, ?, ?, 'verification.result_recorded', 'qa_hub', 'user', ?,
        'verification', ?, ?, 'verification', ?, 3, ?, ?,
        'ready_for_verification', 'closed', ?, ?
      )`,
    )
    .run(
      eventId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      tenant.userId,
      verificationId,
      aggregateSequence,
      verificationId,
      digest(Number(eventId.slice(-12))),
      identifier(Number(eventId.slice(-12)) + 100_000),
      JSON.stringify({
        status: "passed",
        summary: "Human verification passed",
        ...(reason === null ? {} : { reason }),
        verificationId,
        repairAttemptId: attemptId,
        ...(buildId === null ? {} : { buildId }),
        fromVersion: 2,
        toVersion: 3,
      }),
      closedAt,
    );
}

function insertVerificationStartEvent(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  verificationId: string,
  eventId: string,
  startedAt: string,
  aggregateSequence = 1,
): void {
  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
        resource_type, resource_id, resource_version_after, request_digest,
        correlation_id, payload_json, created_at
      ) VALUES (
        ?, ?, ?, ?, 'verification.started', 'qa_hub', 'user', ?,
        'verification', ?, ?, 'verification', ?, 2, ?, ?, ?, ?
      )`,
    )
    .run(
      eventId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      tenant.userId,
      verificationId,
      aggregateSequence,
      verificationId,
      digest(Number(eventId.slice(-12))),
      identifier(Number(eventId.slice(-12)) + 100_000),
      JSON.stringify({
        status: "in_progress",
        verificationId,
        fromVersion: 1,
        toVersion: 2,
      }),
      startedAt,
    );
}

function insertOccurrenceAppendEvent(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  occurrenceId: string,
  eventId: string,
  createdAt: string,
  fromBugVersion: number,
  toBugVersion: number,
  aggregateSequence = 1,
): void {
  insertActiveMembershipRole(
    database,
    tenant,
    identifier(Number(eventId.slice(-12)) + 9_000_000),
    "reporter",
  );
  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
        resource_type, resource_id, resource_version_after, request_digest,
        correlation_id, payload_json, created_at
      ) VALUES (
        ?, ?, ?, ?, 'occurrence.appended', 'qa_hub', 'user', ?,
        'bug', ?, ?, 'occurrence', ?, 1, ?, ?, ?, ?
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
      occurrenceId,
      digest(Number(eventId.slice(-12))),
      identifier(Number(eventId.slice(-12)) + 100_000),
      JSON.stringify({ occurrenceId, fromVersion: fromBugVersion, toVersion: toBugVersion }),
      createdAt,
    );
}

function appendOccurrenceEvidence(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  occurrenceId: string,
  submissionId: string,
  eventId: string,
  createdAt: string,
  fromBugVersion: number,
  toBugVersion: number,
  buildId: string | null,
  aggregateSequence = 1,
): void {
  database
    .prepare(
      `INSERT INTO occurrences(
        id, account_id, project_id, bug_id, reporter_id, client_submission_id,
        observed_at, platform, steps_json, actual_behavior, environment_json,
        created_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'android', ?, ?, ?, ?, 1)`,
    )
    .run(
      occurrenceId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      tenant.userId,
      submissionId,
      createdAt,
      JSON.stringify(["Observe the regression again"]),
      "The verified regression occurred again",
      buildId === null ? null : JSON.stringify({ buildId }),
      createdAt,
    );
  insertOccurrenceAppendEvent(
    database,
    tenant,
    bugId,
    occurrenceId,
    eventId,
    createdAt,
    fromBugVersion,
    toBugVersion,
    aggregateSequence,
  );
  const update = database
    .prepare(
      `UPDATE bugs
       SET occurrence_count = occurrence_count + 1, updated_at = ?, version = ?
       WHERE id = ? AND version = ?`,
    )
    .run(createdAt, toBugVersion, bugId, fromBugVersion);
  assert.equal(update.changes, 1);
}

function insertBuildLineage(
  database: DatabaseSync,
  tenant: TenantFixture,
  lineageId: string,
  createdAt: string,
): void {
  database
    .prepare(
      `INSERT INTO build_lineages(
        id, account_id, project_id, lineage_key, channel, created_at, version
      ) VALUES (?, ?, ?, ?, 'qa', ?, 1)`,
    )
    .run(lineageId, tenant.accountId, tenant.projectId, `qa-${lineageId}`, createdAt);
}

function insertBuildLineageEntry(
  database: DatabaseSync,
  tenant: TenantFixture,
  lineageId: string,
  buildId: string,
  predecessorBuildId: string | null,
  ordinal: number,
  eventId: string,
  createdAt: string,
  requestDigest: string | null = digest(Number(eventId.slice(-12))),
): void {
  const buildVersion = database
    .prepare("SELECT version FROM builds WHERE id = ?")
    .get(buildId)?.version;
  if (typeof buildVersion !== "number") throw new TypeError("Build fixture must exist");
  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
        resource_type, resource_id, resource_version_after, request_digest,
        correlation_id, payload_json, created_at
      ) VALUES (
        ?, ?, ?, NULL, 'build.lineage_entry_recorded', 'qa_hub', 'user', ?,
        'build', ?, ?, 'build', ?, ?, ?, ?, ?, ?
      )`,
    )
    .run(
      eventId,
      tenant.accountId,
      tenant.projectId,
      tenant.userId,
      lineageId,
      ordinal,
      buildId,
      buildVersion,
      requestDigest,
      identifier(Number(eventId.slice(-12)) + 100_000),
      JSON.stringify({
        status: "ranked",
        buildId,
        ...(ordinal === 1 ? {} : { fromVersion: ordinal - 1 }),
        toVersion: ordinal,
      }),
      createdAt,
    );
  database
    .prepare(
      `INSERT INTO build_lineage_entries(
        account_id, project_id, lineage_id, ordinal, build_id,
        predecessor_build_id, evidence_actor_id, evidence_event_id,
        policy_version, created_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '1.0.0', ?, 1)`,
    )
    .run(
      tenant.accountId,
      tenant.projectId,
      lineageId,
      ordinal,
      buildId,
      predecessorBuildId,
      tenant.userId,
      eventId,
      createdAt,
    );
}

function insertReopenEvent(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  occurrenceId: string,
  eventId: string,
  reopenedAt: string,
  fromBugVersion: number,
  toBugVersion: number,
  aggregateSequence = 2,
): void {
  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
        resource_type, resource_id, resource_version_after, request_digest,
        correlation_id, from_state, to_state, payload_json, created_at
      ) VALUES (
        ?, ?, ?, ?, 'bug.reopen.newer_occurrence', 'qa_hub', 'user', ?,
        'bug', ?, ?, 'bug', ?, ?, ?, ?, 'closed', 'ready', ?, ?
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
      toBugVersion,
      digest(Number(eventId.slice(-12))),
      identifier(Number(eventId.slice(-12)) + 100_000),
      JSON.stringify({
        status: "ready",
        occurrenceId,
        fromVersion: fromBugVersion,
        toVersion: toBugVersion,
      }),
      reopenedAt,
    );
}

function insertBugWorkflowEvent(
  database: DatabaseSync,
  tenant: TenantFixture,
  options: {
    readonly actorUserId?: string;
    readonly aggregateId: string;
    readonly aggregateSequence: number;
    readonly aggregateType: "bug" | "repair_attempt" | "verification";
    readonly bugId: string;
    readonly createdAt: string;
    readonly eventId: string;
    readonly eventType: string;
    readonly fromState: string | null;
    readonly payload: Readonly<Record<string, string | number | boolean | null>>;
    readonly resourceId: string;
    readonly resourceType: "bug" | "build_requirement" | "repair_attempt" | "verification";
    readonly resourceVersionAfter: number;
    readonly toState: string | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
        resource_type, resource_id, resource_version_after, request_digest,
        correlation_id, from_state, to_state, payload_json, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, 'qa_hub', 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`,
    )
    .run(
      options.eventId,
      tenant.accountId,
      tenant.projectId,
      options.bugId,
      options.eventType,
      options.actorUserId ?? tenant.userId,
      options.aggregateType,
      options.aggregateId,
      options.aggregateSequence,
      options.resourceType,
      options.resourceId,
      options.resourceVersionAfter,
      digest(Number(options.eventId.slice(-12))),
      identifier(Number(options.eventId.slice(-12)) + 100_000),
      options.fromState,
      options.toState,
      JSON.stringify(options.payload),
      options.createdAt,
    );
}

interface TypedWorkflowFixture {
  readonly attemptCreatedAt: string;
  readonly attemptStartedAt: string;
  readonly readyAt: string;
}

function seedTypedRunningWorkflow(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  eventBase: number,
): TypedWorkflowFixture {
  const readyAt = "2026-08-25T00:10:00.000Z";
  const attemptCreatedAt = "2026-08-25T00:20:00.000Z";
  const attemptStartedAt = "2026-08-25T00:30:00.000Z";
  insertActiveMembershipRole(database, tenant, identifier(eventBase + 1), "triager");
  insertActiveMembershipRole(database, tenant, identifier(eventBase + 2), "developer");
  insertActiveMembershipRole(
    database,
    tenant,
    identifier(eventBase + 7),
    "developer",
    tenant.secondaryUserId,
  );
  insertBugWorkflowEvent(database, tenant, {
    aggregateId: bugId,
    aggregateSequence: 1,
    aggregateType: "bug",
    bugId,
    createdAt: readyAt,
    eventId: identifier(eventBase + 3),
    eventType: "bug.triage.ready",
    fromState: "reported",
    payload: { status: "ready", fromVersion: 1, toVersion: 2 },
    resourceId: bugId,
    resourceType: "bug",
    resourceVersionAfter: 2,
    toState: "ready",
  });
  database
    .prepare(
      `UPDATE bugs SET state = 'ready', updated_at = ?, version = 2
       WHERE id = ? AND version = 1`,
    )
    .run(readyAt, bugId);
  insertBugWorkflowEvent(database, tenant, {
    aggregateId: attemptId,
    aggregateSequence: 1,
    aggregateType: "repair_attempt",
    bugId,
    createdAt: attemptCreatedAt,
    eventId: identifier(eventBase + 4),
    eventType: "repair_attempt.created",
    fromState: "ready",
    payload: { status: "planned", repairAttemptId: attemptId, fromVersion: 2, toVersion: 3 },
    resourceId: attemptId,
    resourceType: "repair_attempt",
    resourceVersionAfter: 1,
    toState: "in_progress",
  });
  database
    .prepare(
      `INSERT INTO repair_attempts(
        id, account_id, project_id, bug_id, sequence, mode, status,
        assignee_id, summary, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, 1, 'human', 'planned', ?, 'Typed fixture', ?, ?, 1)`,
    )
    .run(
      attemptId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      tenant.secondaryUserId,
      attemptCreatedAt,
      attemptCreatedAt,
    );
  database
    .prepare(
      `UPDATE bugs
       SET state = 'in_progress', active_repair_attempt_id = ?, updated_at = ?, version = 3
       WHERE id = ? AND version = 2`,
    )
    .run(attemptId, attemptCreatedAt, bugId);
  insertBugWorkflowEvent(database, tenant, {
    aggregateId: attemptId,
    aggregateSequence: 2,
    aggregateType: "repair_attempt",
    bugId,
    createdAt: attemptStartedAt,
    eventId: identifier(eventBase + 5),
    eventType: "repair_attempt.started",
    fromState: null,
    payload: { status: "running", repairAttemptId: attemptId, fromVersion: 1, toVersion: 2 },
    resourceId: attemptId,
    resourceType: "repair_attempt",
    resourceVersionAfter: 2,
    toState: null,
  });
  database
    .prepare(
      `UPDATE repair_attempts
       SET status = 'running', updated_at = ?, version = 2
       WHERE id = ? AND version = 1`,
    )
    .run(attemptStartedAt, attemptId);
  return { attemptCreatedAt, attemptStartedAt, readyAt };
}

function seedTypedNoBuildRfvWorkflow(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  requirementId: string,
  eventBase: number,
): void {
  seedTypedRunningWorkflow(database, tenant, bugId, attemptId, eventBase);
  const deliveredAt = "2026-08-25T00:40:00.000Z";
  const deliveryEventId = identifier(eventBase + 6);
  const reason = "No executable change";
  insertBugWorkflowEvent(database, tenant, {
    aggregateId: attemptId,
    aggregateSequence: 3,
    aggregateType: "repair_attempt",
    bugId,
    createdAt: deliveredAt,
    eventId: deliveryEventId,
    eventType: "repair_attempt.delivered",
    fromState: "in_progress",
    payload: {
      status: "delivered",
      repairAttemptId: attemptId,
      reason,
      fromVersion: 2,
      toVersion: 3,
    },
    resourceId: requirementId,
    resourceType: "build_requirement",
    resourceVersionAfter: 1,
    toState: "ready_for_verification",
  });
  database
    .prepare(
      `UPDATE repair_attempts
       SET status = 'delivered', summary = 'No-code delivery', no_code_reason = ?,
           updated_at = ?, version = 3
       WHERE id = ? AND version = 2`,
    )
    .run(reason, deliveredAt, attemptId);
  database
    .prepare(
      `INSERT INTO build_requirements(
        id, account_id, project_id, bug_id, repair_attempt_id,
        source_delivery_version, delivered_commit_sha, requirement, decision_basis,
        decision_reason, decision_actor_id, decision_audit_event_id,
        delivery_request_digest, policy_version, bug_version_at_delivery,
        created_at, updated_at, version
      ) VALUES (
        ?, ?, ?, ?, ?, 3, NULL, 'not_required', 'no_code_delivery',
        ?, ?, ?, ?, '1.0.0', 4, ?, ?, 1
      )`,
    )
    .run(
      requirementId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      attemptId,
      reason,
      tenant.userId,
      deliveryEventId,
      digest(Number(deliveryEventId.slice(-12))),
      deliveredAt,
      deliveredAt,
    );
  database
    .prepare(
      `UPDATE bugs SET state = 'ready_for_verification', updated_at = ?, version = 4
       WHERE id = ? AND version = 3`,
    )
    .run(deliveredAt, bugId);
}

function insertRequiredRepairAttempt(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  commitSha: string,
  assigneeId = tenant.userId,
): void {
  assert.equal(assigneeId, tenant.userId);
  insertRepairAttempt(
    database,
    tenant,
    bugId,
    attemptId,
    1,
    "delivered",
    "human",
    "No executable change",
    commitSha,
  );
}

function insertRequiredDeliveryAudit(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  requirementId: string,
  eventId: string,
  commitSha: string,
  aggregateSequence: number,
  eventType: "repair_attempt.delivered" | "repair.delivered" = "repair_attempt.delivered",
  createdAt = CREATED_AT,
  fromState: string | null = null,
  toState: string | null = null,
): void {
  const requestDigest = digest(Number(requirementId.slice(-12)));
  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
        resource_type, resource_id, resource_version_after, request_digest,
        correlation_id, from_state, to_state, payload_json, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, 'qa_hub', 'user', ?,
        'repair_attempt', ?, ?, 'build_requirement', ?, 1, ?, ?, ?, ?, ?, ?
      )`,
    )
    .run(
      eventId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      eventType,
      tenant.userId,
      attemptId,
      aggregateSequence,
      requirementId,
      requestDigest,
      identifier(Number(eventId.slice(-12)) + 100_000),
      fromState,
      toState,
      JSON.stringify({
        status: "delivered",
        repairAttemptId: attemptId,
        commitSha,
        fromVersion: 2,
        toVersion: 3,
      }),
      createdAt,
    );
}

function insertRequiredBuildRequirement(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  requirementId: string,
  auditEventId: string,
  commitSha: string,
  createdAt = CREATED_AT,
  bugVersionAtDelivery = 1,
): void {
  insertActiveMembershipRole(
    database,
    tenant,
    identifier(Number(requirementId.slice(-12)) + 700_000),
    "developer",
  );
  database
    .prepare(
      `INSERT INTO build_requirements(
        id, account_id, project_id, bug_id, repair_attempt_id,
        source_delivery_version, delivered_commit_sha, requirement, decision_basis,
        decision_reason, decision_actor_id, decision_audit_event_id,
        delivery_request_digest, policy_version, bug_version_at_delivery,
        created_at, updated_at, version
      ) VALUES (
        ?, ?, ?, ?, ?, 3, ?, 'required', 'code_requires_build',
        NULL, ?, ?, ?, '1.0.0', ?, ?, ?, 1
      )`,
    )
    .run(
      requirementId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      attemptId,
      commitSha,
      tenant.userId,
      auditEventId,
      digest(Number(requirementId.slice(-12))),
      bugVersionAtDelivery,
      createdAt,
      createdAt,
    );
}

function insertReadyBuild(
  database: DatabaseSync,
  tenant: TenantFixture,
  buildId: string,
  sourceCommitSha: string,
  manifestCommits: readonly string[],
): void {
  const buildSequence = Number(buildId.slice(-12));
  database
    .prepare(
      `INSERT INTO builds(
        id, account_id, project_id, provider, external_id, version_name, channel,
        project_key, branch, source_commit_sha, mode, status, manifest_json,
        manifest_digest, artifact_sha256, download_url, created_at, updated_at, version
      ) VALUES (
        ?, ?, ?, 'manual', ?, ?, 'qa', ?, 'main', ?, 'debug', 'validating', ?, ?, ?, ?, ?, ?, 1
      )`,
    )
    .run(
      buildId,
      tenant.accountId,
      tenant.projectId,
      `manual-${buildSequence}`,
      `build-${buildSequence}`,
      tenant.projectKey,
      sourceCommitSha,
      JSON.stringify({ commits: manifestCommits }),
      digest(buildSequence + 200_000),
      digest(buildSequence + 300_000),
      `https://example.invalid/builds/${buildSequence}.apk`,
      CREATED_AT,
      CREATED_AT,
    );
  const insertManifestCommit = database.prepare(
    `INSERT INTO build_manifest_commits(
      account_id, project_id, build_id, commit_sha, ordinal
    ) VALUES (?, ?, ?, ?, ?)`,
  );
  manifestCommits.forEach((commitSha, ordinal) => {
    insertManifestCommit.run(tenant.accountId, tenant.projectId, buildId, commitSha, ordinal);
  });
  database
    .prepare(
      `UPDATE builds
       SET status = 'ready', updated_at = ?, version = 2
       WHERE id = ?`,
    )
    .run(UPDATED_AT, buildId);
}

function insertBuildLinkAudit(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  buildId: string,
  linkId: string,
  eventId: string,
  commitSha: string,
  aggregateSequence: number,
  createdAt = UPDATED_AT,
  fromState: string | null = null,
  toState: string | null = null,
): void {
  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
        resource_type, resource_id, resource_version_after, request_digest, correlation_id,
        from_state, to_state, payload_json, created_at
      ) VALUES (
        ?, ?, ?, ?, 'build.repair_linked', 'qa_hub', 'user', ?,
        'repair_attempt', ?, ?, 'build_repair_link', ?, 1, ?, ?, ?, ?, ?, ?
      )`,
    )
    .run(
      eventId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      tenant.userId,
      attemptId,
      aggregateSequence,
      linkId,
      digest(Number(linkId.slice(-12))),
      identifier(Number(eventId.slice(-12)) + 100_000),
      fromState,
      toState,
      JSON.stringify({
        status: "ready_for_verification",
        repairAttemptId: attemptId,
        buildId,
        commitSha,
        fromVersion: 2,
        toVersion: 3,
      }),
      createdAt,
    );
}

function linkRequiredBuild(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  requirementId: string,
  buildId: string,
  linkId: string,
  auditEventId: string,
  commitSha: string,
): void {
  insertActiveMembershipRole(
    database,
    tenant,
    identifier(Number(linkId.slice(-12)) + 800_000),
    "release_manager",
  );
  transaction(database, () => {
    const update = database
      .prepare(
        `UPDATE build_requirements
         SET linked_build_id = ?, link_id = ?, updated_at = ?, version = 2
         WHERE id = ? AND version = 1`,
      )
      .run(buildId, linkId, UPDATED_AT, requirementId);
    assert.equal(update.changes, 1);
    database
      .prepare(
        `INSERT INTO build_repair_links(
          id, account_id, project_id, bug_id, repair_attempt_id, build_id,
          build_requirement_id, build_requirement_version, delivered_commit_sha,
          evidence_type, evidence_decision, override_reason, evidence_actor_id,
          evidence_audit_event_id, evidence_policy_version, linked_at, version
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, 2, ?, 'manifest', 'manifest_verified', NULL, ?, ?,
          '1.0.0', ?, 1
        )`,
      )
      .run(
        linkId,
        tenant.accountId,
        tenant.projectId,
        bugId,
        attemptId,
        buildId,
        requirementId,
        commitSha,
        tenant.userId,
        auditEventId,
        UPDATED_AT,
      );
    const buildUpdate = database
      .prepare(
        `UPDATE builds
         SET updated_at = ?, version = 3
         WHERE id = ? AND version = 2`,
      )
      .run(FINALIZED_AT, buildId);
    assert.equal(buildUpdate.changes, 1);
  });
}

function insertReleaseManagerMembership(
  database: DatabaseSync,
  tenant: TenantFixture,
  membershipId: string,
): void {
  insertActiveMembershipRole(database, tenant, membershipId, "release_manager");
}

function insertOverrideBuildLinkAudit(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  buildId: string,
  linkId: string,
  eventId: string,
  commitSha: string,
  overrideReason: string,
  auditOverrideReason: string,
): string {
  const payloadJson = JSON.stringify({
    status: "ready_for_verification",
    repairAttemptId: attemptId,
    buildId,
    commitSha,
    reason: auditOverrideReason,
    fromVersion: 2,
    toVersion: 3,
  });
  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
        resource_type, resource_id, resource_version_after, request_digest, correlation_id,
        payload_json, created_at
      ) VALUES (
        ?, ?, ?, ?, 'build.repair_linked', 'qa_hub', 'user', ?,
        'repair_attempt', ?, 2, 'build_repair_link', ?, 1, ?, ?, ?, ?
      )`,
    )
    .run(
      eventId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      tenant.userId,
      attemptId,
      linkId,
      digest(Number(linkId.slice(-12))),
      identifier(Number(eventId.slice(-12)) + 200_000),
      payloadJson,
      UPDATED_AT,
    );
  return payloadJson;
}

function linkRequiredBuildWithOverride(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  requirementId: string,
  buildId: string,
  linkId: string,
  auditEventId: string,
  commitSha: string,
  overrideReason: string,
): void {
  insertActiveMembershipRole(
    database,
    tenant,
    identifier(Number(linkId.slice(-12)) + 800_000),
    "release_manager",
  );
  transaction(database, () => {
    const update = database
      .prepare(
        `UPDATE build_requirements
         SET linked_build_id = ?, link_id = ?, updated_at = ?, version = 2
         WHERE id = ? AND version = 1`,
      )
      .run(buildId, linkId, UPDATED_AT, requirementId);
    assert.equal(update.changes, 1);
    database
      .prepare(
        `INSERT INTO build_repair_links(
          id, account_id, project_id, bug_id, repair_attempt_id, build_id,
          build_requirement_id, build_requirement_version, delivered_commit_sha,
          evidence_type, evidence_decision, override_reason, evidence_actor_id,
          evidence_audit_event_id, evidence_policy_version, linked_at, version
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, 2, ?, 'release_manager_override',
          'release_manager_authorized', ?, ?, ?, '1.0.0', ?, 1
        )`,
      )
      .run(
        linkId,
        tenant.accountId,
        tenant.projectId,
        bugId,
        attemptId,
        buildId,
        requirementId,
        commitSha,
        overrideReason,
        tenant.userId,
        auditEventId,
        UPDATED_AT,
      );
    const buildUpdate = database
      .prepare(
        `UPDATE builds
         SET updated_at = ?, version = 3
         WHERE id = ? AND version = 2`,
      )
      .run(FINALIZED_AT, buildId);
    assert.equal(buildUpdate.changes, 1);
  });
}

function insertVerificationForBuild(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  attemptId: string,
  verificationId: string,
  buildId: string | null,
): void {
  insertVerification(
    database,
    tenant,
    bugId,
    attemptId,
    verificationId,
    tenant.userId,
    buildId,
    CREATED_AT,
    undefined,
    "Verify the exact delivered build",
  );
}

function insertServicePrincipal(
  database: DatabaseSync,
  tenant: TenantFixture,
  principalId: string,
): void {
  database
    .prepare(
      `INSERT INTO service_principals(
        id, account_id, name, principal_type, credential_digest,
        status, created_at, version
      ) VALUES (?, ?, 'Relay adapter', 'relay', ?, 'active', ?, 1)`,
    )
    .run(principalId, tenant.accountId, digest(Number(principalId.slice(-12))), CREATED_AT);
}

function insertCaptureBundle(
  database: DatabaseSync,
  tenant: TenantFixture,
  bundleId: string,
  captureId: string,
  clientSubmissionId: string,
  actorId = tenant.userId,
): UploadFixture {
  const primaryBase = 100_000 + Number(bundleId.slice(-12)) * 10;
  const primary = uploadFixture(tenant, primaryBase, {
    actorId,
    captureId,
    clientSubmissionId,
  });
  insertUpload(database, tenant, primary);
  insertBlob(database, tenant, primary);
  insertAttachment(database, tenant, primary);
  finalizeUpload(database, primary.uploadId, primary.attachmentId);
  database
    .prepare(
      `INSERT INTO capture_bundles(
        id, account_id, project_id, actor_id, capture_id, client_submission_id,
        source, primary_client_attachment_id, primary_attachment_id,
        started_at, ended_at, captured_at, device_metadata_json,
        enrichment_status, status, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, 'overlay_single_tap', ?, ?, ?, ?, ?, '{}',
        'unavailable', 'draft', ?, ?, 1)`,
    )
    .run(
      bundleId,
      tenant.accountId,
      tenant.projectId,
      actorId,
      captureId,
      clientSubmissionId,
      primary.clientAttachmentId,
      primary.attachmentId,
      CREATED_AT,
      UPDATED_AT,
      UPDATED_AT,
      CREATED_AT,
      UPDATED_AT,
    );
  return primary;
}

function insertOccurrence(
  database: DatabaseSync,
  tenant: TenantFixture,
  bugId: string,
  occurrenceId: string,
  clientSubmissionId: string,
  reporterId = tenant.userId,
): void {
  database
    .prepare(
      `INSERT INTO occurrences(
        id, account_id, project_id, bug_id, reporter_id, client_submission_id,
        observed_at, platform, steps_json, actual_behavior, environment_json,
        created_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'android', '["Open the screen"]',
        'The result differs from the expected state', '{}', ?, 1)`,
    )
    .run(
      occurrenceId,
      tenant.accountId,
      tenant.projectId,
      bugId,
      reporterId,
      clientSubmissionId,
      CREATED_AT,
      CREATED_AT,
    );
}

function uploadFixture(
  tenant: TenantFixture,
  base: number,
  options: {
    readonly actorId?: string;
    readonly captureId?: string;
    readonly clientAttachmentId?: string;
    readonly clientSubmissionId?: string;
    readonly mediaType?: string;
  } = {},
): UploadFixture {
  return {
    actorId: options.actorId ?? tenant.userId,
    uploadId: identifier(base),
    blobId: identifier(base + 1),
    attachmentId: identifier(base + 2),
    clientSubmissionId: options.clientSubmissionId ?? identifier(base + 3),
    clientAttachmentId: options.clientAttachmentId ?? identifier(base + 4),
    captureId: options.captureId ?? null,
    digest: digest(base),
    fileName: `evidence-${base}.png`,
    mediaType: options.mediaType ?? "image/png",
    sizeBytes: 1_024 + base,
  };
}

function insertUpload(
  database: DatabaseSync,
  tenant: TenantFixture,
  upload: UploadFixture,
  receivedSizeBytes = upload.sizeBytes,
): void {
  const uploadCreatedAt = databaseTime(database, "-5 minutes");
  const uploadUpdatedAt = databaseTime(database, "-4 minutes");
  const uploadExpiresAt = databaseTime(database, "+55 minutes");
  database
    .prepare(
      `INSERT INTO upload_sessions(
        id, account_id, project_id, actor_id, client_submission_id,
        client_attachment_id, capture_id, upload_attempt, file_name, media_type,
        expected_size_bytes, expected_sha256, received_size_bytes,
        chunk_size_bytes, expected_chunk_count, generation, status,
        expires_at, created_at, updated_at, version
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 262144, 1, 1,
        'open', ?, ?, ?, 1
      )`,
    )
    .run(
      upload.uploadId,
      tenant.accountId,
      tenant.projectId,
      upload.actorId,
      upload.clientSubmissionId,
      upload.clientAttachmentId,
      upload.captureId,
      upload.fileName,
      upload.mediaType,
      upload.sizeBytes,
      upload.digest,
      0,
      uploadExpiresAt,
      uploadCreatedAt,
      uploadCreatedAt,
    );
  if (receivedSizeBytes === upload.sizeBytes) {
    database
      .prepare(
        `INSERT INTO upload_chunks(
          account_id, project_id, upload_session_id, generation, chunk_index,
          offset_bytes, size_bytes, sha256, storage_key, received_at
        ) VALUES (?, ?, ?, 1, 0, 0, ?, ?, ?, ?)`,
      )
      .run(
        tenant.accountId,
        tenant.projectId,
        upload.uploadId,
        upload.sizeBytes,
        upload.digest,
        `chunks/${upload.uploadId}/0`,
        uploadCreatedAt,
      );
    database
      .prepare(
        `UPDATE upload_sessions
         SET received_size_bytes = expected_size_bytes, status = 'finalizing',
             updated_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(uploadUpdatedAt, upload.uploadId);
  } else if (receivedSizeBytes > 0) {
    database
      .prepare(
        `UPDATE upload_sessions
         SET received_size_bytes = ?, updated_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(receivedSizeBytes, uploadUpdatedAt, upload.uploadId);
  }
}

function insertBlob(
  database: DatabaseSync,
  tenant: TenantFixture,
  upload: UploadFixture,
  options: {
    readonly digest?: string;
    readonly state?: "ready" | "quarantined";
  } = {},
): void {
  database
    .prepare(
      `INSERT INTO blobs(
        id, account_id, sha256, size_bytes, storage_key, encryption_json,
        state, created_at, version
      ) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, 1)`,
    )
    .run(
      upload.blobId,
      tenant.accountId,
      options.digest ?? upload.digest,
      upload.sizeBytes,
      `blobs/${upload.blobId}`,
      options.state ?? "ready",
      CREATED_AT,
    );
}

function insertAttachment(
  database: DatabaseSync,
  tenant: TenantFixture,
  upload: UploadFixture,
  options: {
    readonly fileName?: string;
    readonly scanState?: "clean" | "pending" | "rejected";
    readonly sha256?: string;
    readonly status?: "ready" | "quarantined";
  } = {},
): void {
  const status = options.status ?? "ready";
  database
    .prepare(
      `INSERT INTO attachments(
        id, account_id, project_id, actor_id, client_submission_id,
        client_attachment_id, capture_id, blob_id, upload_session_id, file_name,
        media_type, size_bytes, sha256, status, scan_state, quarantine_key,
        created_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      upload.attachmentId,
      tenant.accountId,
      tenant.projectId,
      upload.actorId,
      upload.clientSubmissionId,
      upload.clientAttachmentId,
      upload.captureId,
      upload.blobId,
      upload.uploadId,
      options.fileName ?? upload.fileName,
      upload.mediaType,
      upload.sizeBytes,
      options.sha256 ?? upload.digest,
      status,
      options.scanState ?? "clean",
      status === "quarantined" ? `quarantine/${upload.attachmentId}` : null,
      CREATED_AT,
    );
}

function finalizeUpload(database: DatabaseSync, uploadId: string, attachmentId: string): void {
  database
    .prepare(
      `UPDATE upload_sessions
       SET finalized_attachment_id = ?, status = 'finalized', updated_at = ?,
           version = version + 1
       WHERE id = ?`,
    )
    .run(attachmentId, databaseTime(database), uploadId);
}

function createAttachment(
  database: DatabaseSync,
  tenant: TenantFixture,
  base: number,
  options: {
    readonly finalize?: boolean;
    readonly scanState?: "clean" | "pending" | "rejected";
    readonly status?: "ready" | "quarantined";
  } = {},
): UploadFixture {
  const upload = uploadFixture(tenant, base);
  insertUpload(database, tenant, upload);
  insertBlob(database, tenant, upload, {
    state: options.status === "quarantined" ? "quarantined" : "ready",
  });
  insertAttachment(database, tenant, upload, {
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.scanState === undefined ? {} : { scanState: options.scanState }),
  });
  if (options.finalize !== false) finalizeUpload(database, upload.uploadId, upload.attachmentId);
  return upload;
}

function insertClaimedBinding(
  database: DatabaseSync,
  tenant: TenantFixture,
  attachmentId: string,
  bindingId: string,
  intent: "bug_create" | "occurrence_append" | "comment_append" | "verification_result",
  targetBugId: string,
  actorId = tenant.userId,
): void {
  const boundAt = databaseTime(database);
  const expiresAt = databaseTime(database, "+1 hour");
  database
    .prepare(
      `INSERT INTO attachment_bindings(
        id, account_id, project_id, attachment_id, intent, target_bug_id,
        lease_generation, state, expires_at, claimed_at, bound_by_actor_id,
        bound_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'reserved', ?, NULL, ?, ?, 1)`,
    )
    .run(
      bindingId,
      tenant.accountId,
      tenant.projectId,
      attachmentId,
      intent,
      intent === "bug_create" ? null : targetBugId,
      expiresAt,
      actorId,
      boundAt,
    );
  database
    .prepare(
      `UPDATE attachment_bindings
       SET target_bug_id = ?, state = 'claimed', expires_at = NULL,
           claimed_at = ?, version = 2
       WHERE id = ?`,
    )
    .run(targetBugId, databaseTime(database), bindingId);
}

test("a Bug cannot point at another Bug's active RepairAttempt", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 100, "ACT");
    const bugA = identifier(110);
    const bugB = identifier(111);
    const attemptB = identifier(112);
    createBug(database, tenant, bugA, "Bug A");
    createBug(database, tenant, bugB, "Bug B");
    insertRepairAttempt(database, tenant, bugB, attemptB, 1, "running");

    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE bugs
             SET active_repair_attempt_id = ?, updated_at = ?, version = 2
             WHERE id = ?`,
          )
          .run(attemptB, UPDATED_AT, bugA),
      /FOREIGN KEY constraint failed|Bug same-state workflow pointers require their exact typed human audit/i,
    );
    assert.equal(
      database.prepare("SELECT active_repair_attempt_id FROM bugs WHERE id = ?").get(bugA)
        ?.active_repair_attempt_id,
      null,
    );
    assert.equal(
      database.prepare("SELECT bug_id FROM repair_attempts WHERE id = ?").get(attemptB)?.bug_id,
      bugB,
    );
    assertIntegrity(database);
  });
});

test("BuildRequirement, Verification, and RelayReceipt preserve Attempt-to-Bug identity", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 200, "IDN");
    const bugA = identifier(210);
    const bugB = identifier(211);
    const attemptB = identifier(212);
    const auditA = identifier(213);
    const auditB = identifier(214);
    const invalidRequirementId = identifier(217);
    const validRequirementId = identifier(218);
    createBug(database, tenant, bugA, "Identity Bug A");
    createBug(database, tenant, bugB, "Identity Bug B");
    insertRepairAttempt(database, tenant, bugB, attemptB, 1, "delivered", "relay");
    insertQaAuditEvent(database, tenant, bugA, auditA, attemptB, invalidRequirementId);
    insertQaAuditEvent(database, tenant, bugB, auditB, attemptB, validRequirementId, 2);

    assert.throws(
      () => insertBuildRequirement(database, tenant, bugA, attemptB, auditA, invalidRequirementId),
      /FOREIGN KEY constraint failed|exact typed delivery audit/i,
    );
    insertBuildRequirement(database, tenant, bugB, attemptB, auditB, validRequirementId);

    assert.throws(
      () => insertVerification(database, tenant, bugA, attemptB, identifier(219)),
      /FOREIGN KEY constraint failed|exact immutable BuildRequirement|Verification must begin as one requested version-one fact/i,
    );
    insertVerification(database, tenant, bugB, attemptB, identifier(220));

    const integrationLinkId = identifier(221);
    database
      .prepare(
        `INSERT INTO integration_links(
          id, account_id, project_id, integration_type, local_resource_type,
          local_resource_id, external_resource_type, external_resource_id,
          state, metadata_json, created_at, updated_at, version
        ) VALUES (?, ?, ?, 'relay', 'repair_attempt', ?, 'relay_handoff', ?,
          'active', ?, ?, ?, 1)`,
      )
      .run(
        integrationLinkId,
        tenant.accountId,
        tenant.projectId,
        attemptB,
        identifier(225),
        JSON.stringify({ relayInstanceId: "relay-test" }),
        CREATED_AT,
        CREATED_AT,
      );
    const receiptStatement = database.prepare(
      `INSERT INTO relay_receipts(
        id, account_id, project_id, integration_link_id, bug_id,
        repair_attempt_id, handoff_id, relay_instance_id, relay_task_id,
        handoff_status, external_revision, build_requirement,
        build_evidence_status, last_event_at, payload_digest, received_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'relay-test', ?, 'running', 1,
        'not_required', 'not_required', ?, ?, ?, 1)`,
    );
    assert.throws(
      () =>
        receiptStatement.run(
          identifier(222),
          tenant.accountId,
          tenant.projectId,
          integrationLinkId,
          bugA,
          attemptB,
          identifier(224),
          "relay-task-invalid",
          CREATED_AT,
          digest(222),
          CREATED_AT,
        ),
      /FOREIGN KEY constraint failed|exact Relay attempt and handoff/i,
    );
    receiptStatement.run(
      identifier(223),
      tenant.accountId,
      tenant.projectId,
      integrationLinkId,
      bugB,
      attemptB,
      identifier(225),
      "relay-task-valid",
      CREATED_AT,
      digest(223),
      CREATED_AT,
    );
    assertIntegrity(database);
  });
});

test("Relay service projection is repair-only and cannot author QA Bugs or Verification", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 300, "RLY");
    const relayId = identifier(310);
    const bugId = identifier(311);
    const attemptId = identifier(312);
    insertServicePrincipal(database, tenant, relayId);
    createBug(database, tenant, bugId, "Human-authored QA Bug");
    insertRepairAttempt(database, tenant, bugId, attemptId);
    const deliveryAuditId = identifier(320);
    const requirementId = identifier(321);
    insertQaAuditEvent(database, tenant, bugId, deliveryAuditId, attemptId, requirementId);
    insertBuildRequirement(database, tenant, bugId, attemptId, deliveryAuditId, requirementId);

    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO bugs(
              id, account_id, project_id, number, key, title, description,
              expected_behavior, state, severity, priority, reporter_id,
              occurrence_count, reopen_count, created_at, updated_at, version
            ) VALUES (
              ?, ?, ?, 99, 'RLY-99', 'Relay forged Bug', 'Forbidden',
              'A human creates the Bug', 'reported', 'S2', 'P2', ?, 1, 0, ?, ?, 1
            )`,
          )
          .run(
            identifier(313),
            tenant.accountId,
            tenant.projectId,
            relayId,
            CREATED_AT,
            CREATED_AT,
          ),
      /FOREIGN KEY constraint failed/i,
    );
    assert.throws(
      () => insertVerification(database, tenant, bugId, attemptId, identifier(314), relayId),
      /FOREIGN KEY constraint failed/i,
    );

    const relayEvent = database.prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_service_principal_id, aggregate_type, aggregate_id,
        aggregate_sequence, resource_type, resource_id, correlation_id,
        payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, 'relay', 'service', ?, 'repair_attempt', ?, ?,
        'repair_attempt', ?, ?, ?, ?)`,
    );
    assert.throws(
      () =>
        relayEvent.run(
          identifier(315),
          tenant.accountId,
          tenant.projectId,
          bugId,
          "bug.closed",
          relayId,
          attemptId,
          1,
          attemptId,
          identifier(316),
          JSON.stringify({ status: "closed", verificationId: identifier(317) }),
          CREATED_AT,
        ),
      /CHECK constraint failed|Bug closure requires current passed human Verification|Bug state transition requires its exact typed human audit/i,
    );
    relayEvent.run(
      identifier(318),
      tenant.accountId,
      tenant.projectId,
      bugId,
      "repair.running",
      relayId,
      attemptId,
      2,
      attemptId,
      identifier(319),
      JSON.stringify({ status: "running", summary: "Relay is working" }),
      CREATED_AT,
    );
    assert.equal(
      database.prepare("SELECT type FROM events WHERE source = 'relay'").get()?.type,
      "repair.running",
    );
    assertIntegrity(database);
  });
});

test("external events and Relay receipt revisions preserve principal, handoff, and Build facts", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 1_400, "EXT");
    const relayPrincipalId = identifier(1_410);
    const buildPrincipalId = identifier(1_411);
    const revokedRelayPrincipalId = identifier(1_412);
    insertServicePrincipal(database, tenant, relayPrincipalId);
    const insertPrincipal = database.prepare(
      `INSERT INTO service_principals(
        id, account_id, name, principal_type, credential_digest,
        status, created_at, revoked_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    insertPrincipal.run(
      buildPrincipalId,
      tenant.accountId,
      "Build provider",
      "build_provider",
      digest(1_411),
      "active",
      CREATED_AT,
      null,
    );
    insertPrincipal.run(
      revokedRelayPrincipalId,
      tenant.accountId,
      "Revoked Relay",
      "relay",
      digest(1_412),
      "active",
      CREATED_AT,
      null,
    );
    database
      .prepare(
        `UPDATE service_principals
         SET status = 'revoked', revoked_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(databaseTime(database), revokedRelayPrincipalId);

    const bugId = identifier(1_420);
    const attemptId = identifier(1_421);
    const integrationLinkId = identifier(1_422);
    const handoffId = identifier(1_423);
    const receiptId = identifier(1_424);
    createBug(database, tenant, bugId, "Relay fact Bug");
    insertRepairAttempt(database, tenant, bugId, attemptId, 1, "running", "relay");
    database
      .prepare(
        `INSERT INTO integration_links(
          id, account_id, project_id, integration_type, local_resource_type,
          local_resource_id, external_resource_type, external_resource_id,
          state, metadata_json, created_at, updated_at, version
        ) VALUES (?, ?, ?, 'relay', 'repair_attempt', ?, 'relay_handoff', ?,
          'active', ?, ?, ?, 1)`,
      )
      .run(
        integrationLinkId,
        tenant.accountId,
        tenant.projectId,
        attemptId,
        handoffId,
        JSON.stringify({ relayInstanceId: "relay-exact" }),
        CREATED_AT,
        CREATED_AT,
      );
    database
      .prepare(
        `INSERT INTO relay_receipts(
          id, account_id, project_id, integration_link_id, bug_id,
          repair_attempt_id, handoff_id, relay_instance_id, relay_task_id,
          handoff_status, external_revision, build_requirement,
          build_evidence_status, last_event_at, payload_digest, received_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'relay-exact', 'relay-task-1',
          'running', 1, 'not_required', 'not_required', ?, ?, ?, 1)`,
      )
      .run(
        receiptId,
        tenant.accountId,
        tenant.projectId,
        integrationLinkId,
        bugId,
        attemptId,
        handoffId,
        CREATED_AT,
        digest(1_424),
        CREATED_AT,
      );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE integration_links
             SET local_resource_id = ?, updated_at = ?, version = 2
             WHERE id = ?`,
          )
          .run(identifier(1_425), UPDATED_AT, integrationLinkId),
      /integration link.*(?:tuple|identity|retarget|immutable)/i,
    );

    const arbitraryBuildId = identifier(1_430);
    const arbitraryCommitSha = "c".repeat(40);
    insertReadyBuild(database, tenant, arbitraryBuildId, arbitraryCommitSha, [arbitraryCommitSha]);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE relay_receipts
             SET handoff_status = 'awaiting_verification', external_revision = 2,
                 build_requirement = 'required',
                 build_evidence_status = 'exact_commit_eligible',
                 delivered_commit_sha = ?, build_id = ?,
                 last_event_at = ?, payload_digest = ?, version = 2
             WHERE id = ?`,
          )
          .run(arbitraryCommitSha, arbitraryBuildId, UPDATED_AT, digest(1_431), receiptId),
      /Relay.*(?:exact|BuildRequirement|repair link|build evidence|Build authority)/i,
    );
    database
      .prepare(
        `UPDATE relay_receipts
         SET handoff_status = 'needs_input', external_revision = 2,
             last_event_at = ?, payload_digest = ?, version = 2
         WHERE id = ?`,
      )
      .run(UPDATED_AT, digest(1_432), receiptId);
    database
      .prepare(
        `UPDATE integration_links
         SET state = 'disabled', updated_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(UPDATED_AT, integrationLinkId);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE relay_receipts
             SET handoff_status = 'blocked', external_revision = 3,
                 payload_digest = ?, version = 3
             WHERE id = ?`,
          )
          .run(digest(1_433), receiptId),
      /Relay receipt.*(?:exact|handoff|integration)/i,
    );

    const insertExternalEvent = database.prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_service_principal_id, aggregate_type, aggregate_id,
        aggregate_sequence, resource_type, resource_id, correlation_id,
        payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'service', ?, 'repair_attempt', ?, ?,
        'repair_attempt', ?, ?, ?, ?)`,
    );
    const externalPrincipalError = /external event.*principal|principal.*(?:source|active|type)/i;
    assert.throws(
      () =>
        insertExternalEvent.run(
          identifier(1_440),
          tenant.accountId,
          tenant.projectId,
          bugId,
          "repair.running",
          "relay",
          buildPrincipalId,
          attemptId,
          1,
          attemptId,
          identifier(1_450),
          JSON.stringify({ status: "running" }),
          CREATED_AT,
        ),
      externalPrincipalError,
    );
    assert.throws(
      () =>
        insertExternalEvent.run(
          identifier(1_441),
          tenant.accountId,
          tenant.projectId,
          bugId,
          "build.pending",
          "build",
          relayPrincipalId,
          attemptId,
          2,
          attemptId,
          identifier(1_451),
          JSON.stringify({ status: "pending" }),
          CREATED_AT,
        ),
      externalPrincipalError,
    );
    assert.throws(
      () =>
        insertExternalEvent.run(
          identifier(1_442),
          tenant.accountId,
          tenant.projectId,
          bugId,
          "repair.running",
          "relay",
          revokedRelayPrincipalId,
          attemptId,
          3,
          attemptId,
          identifier(1_452),
          JSON.stringify({ status: "running" }),
          CREATED_AT,
        ),
      externalPrincipalError,
    );
    assert.throws(
      () =>
        insertExternalEvent.run(
          identifier(1_443),
          tenant.accountId,
          tenant.projectId,
          bugId,
          "repair.running",
          "relay",
          relayPrincipalId,
          attemptId,
          4,
          attemptId,
          identifier(1_453),
          JSON.stringify({ status: "blocked" }),
          CREATED_AT,
        ),
      /CHECK constraint failed/i,
    );
    insertExternalEvent.run(
      identifier(1_444),
      tenant.accountId,
      tenant.projectId,
      bugId,
      "repair.running",
      "relay",
      relayPrincipalId,
      attemptId,
      5,
      attemptId,
      identifier(1_454),
      JSON.stringify({ status: "running" }),
      CREATED_AT,
    );
    database
      .prepare(
        `INSERT INTO events(
          id, account_id, project_id, bug_id, type, source, actor_type,
          actor_service_principal_id, aggregate_type, aggregate_id,
          aggregate_sequence, resource_type, resource_id, correlation_id,
          payload_json, created_at
        ) VALUES (?, ?, ?, NULL, 'build.pending', 'build', 'service', ?,
          'build', ?, 1, 'build', ?, ?, ?, ?)`,
      )
      .run(
        identifier(1_445),
        tenant.accountId,
        tenant.projectId,
        buildPrincipalId,
        arbitraryBuildId,
        arbitraryBuildId,
        identifier(1_455),
        JSON.stringify({ status: "pending", buildId: arbitraryBuildId }),
        CREATED_AT,
      );
    assertIntegrity(database);
  });
});

test("native sessions and active push devices cannot lie about shared installations", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 400, "DEV");
    const now = databaseTime(database);
    const nowMs = Date.parse(now);
    const at = (offsetSeconds: number): string =>
      new Date(nowMs + offsetSeconds * 1_000).toISOString();
    const sharedInstallationId = identifier(410);
    const privateInstallationId = identifier(411);
    const insertInstallation = database.prepare(
      `INSERT INTO device_installations(
        id, account_id, installation_id, platform, app_version,
        device_metadata_json, shared_device, first_seen_at, last_seen_at, version
      ) VALUES (?, ?, ?, 'android', '0.1.0-debug', '{}', ?, ?, ?, 1)`,
    );
    insertInstallation.run(sharedInstallationId, tenant.accountId, identifier(412), 1, now, now);
    insertInstallation.run(privateInstallationId, tenant.accountId, identifier(413), 0, now, now);

    const insertSession = database.prepare(
      `INSERT INTO native_sessions(
        id, account_id, user_id, installation_id, access_token_digest,
        shared_device, push_allowed, issued_at, access_expires_at, idle_expires_at,
        absolute_expires_at, last_seen_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    assert.throws(
      () =>
        insertSession.run(
          identifier(414),
          tenant.accountId,
          tenant.userId,
          sharedInstallationId,
          digest(414),
          0,
          1,
          now,
          at(900),
          at(1_800),
          at(28_800),
          now,
        ),
      /native session must start current, active, and at version one/i,
    );

    const sharedSessionId = identifier(415);
    insertSession.run(
      sharedSessionId,
      tenant.accountId,
      tenant.userId,
      sharedInstallationId,
      digest(415),
      1,
      0,
      now,
      at(900),
      at(1_800),
      at(28_800),
      now,
    );
    const insertNotificationDevice = database.prepare(
      `INSERT INTO notification_devices(
        id, account_id, user_id, session_id, installation_id, shared_device,
        device_id_hash, platform, provider, push_token_hmac,
        push_token_ciphertext, token_issued_at, server_received_at,
        qa_app_version, status, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'android', 'fcm', ?, ?, ?, ?,
        '0.1.0-debug', 'active', ?, ?, 1)`,
    );
    assert.throws(
      () =>
        insertNotificationDevice.run(
          identifier(416),
          tenant.accountId,
          tenant.userId,
          sharedSessionId,
          sharedInstallationId,
          0,
          digest(416),
          digest(417),
          "encrypted-shared-token",
          now,
          at(1),
          now,
          at(1),
        ),
      /FOREIGN KEY constraint failed/i,
    );

    const privateSessionId = identifier(418);
    insertSession.run(
      privateSessionId,
      tenant.accountId,
      tenant.userId,
      privateInstallationId,
      digest(418),
      0,
      1,
      now,
      at(900),
      at(3_600),
      at(86_400),
      now,
    );
    insertNotificationDevice.run(
      identifier(419),
      tenant.accountId,
      tenant.userId,
      privateSessionId,
      privateInstallationId,
      0,
      digest(419),
      digest(420),
      "encrypted-private-token",
      now,
      at(1),
      now,
      at(1),
    );
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM notification_devices WHERE status = 'active'")
        .get()?.count,
      1,
    );
    assertIntegrity(database);
  });
});

test("auth TTLs accept exact frozen maxima and reject one-second overflow or invalid dates", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 1_500, "TTL");
    const now = databaseTime(database);
    const after = (seconds: number): string =>
      new Date(Date.parse(now) + seconds * 1_000).toISOString();
    const sharedInstallationId = identifier(1_510);
    const personalInstallationId = identifier(1_511);
    const insertInstallation = database.prepare(
      `INSERT INTO device_installations(
        id, account_id, installation_id, platform, app_version,
        device_metadata_json, shared_device, first_seen_at, last_seen_at, version
      ) VALUES (?, ?, ?, 'android', '0.1.0-debug', '{}', ?, ?, ?, 1)`,
    );
    insertInstallation.run(sharedInstallationId, tenant.accountId, identifier(1_512), 1, now, now);
    insertInstallation.run(
      personalInstallationId,
      tenant.accountId,
      identifier(1_513),
      0,
      now,
      now,
    );
    const insertSession = database.prepare(
      `INSERT INTO native_sessions(
        id, account_id, user_id, installation_id, access_token_digest,
        shared_device, push_allowed, issued_at, access_expires_at,
        idle_expires_at, absolute_expires_at, last_seen_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    const insertSharedSession = (
      id: string,
      accessExpiresAt: string,
      idleExpiresAt: string,
      absoluteExpiresAt: string,
    ): void => {
      insertSession.run(
        id,
        tenant.accountId,
        tenant.userId,
        sharedInstallationId,
        digest(Number(id.slice(-12))),
        1,
        0,
        now,
        accessExpiresAt,
        idleExpiresAt,
        absoluteExpiresAt,
        now,
      );
    };
    insertSharedSession(identifier(1_514), after(900), after(1_800), after(28_800));
    assert.throws(
      () => insertSharedSession(identifier(1_515), after(901), after(1_800), after(28_800)),
      /CHECK constraint failed/i,
    );
    assert.throws(
      () => insertSharedSession(identifier(1_516), after(900), after(1_801), after(28_800)),
      /CHECK constraint failed/i,
    );
    assert.throws(
      () => insertSharedSession(identifier(1_517), after(900), after(1_800), after(28_801)),
      /CHECK constraint failed/i,
    );
    assert.throws(
      () =>
        insertSharedSession(
          identifier(1_518),
          "not-a-valid-date-value",
          after(1_800),
          after(28_800),
        ),
      /CHECK constraint failed/i,
    );

    const personalSessionId = identifier(1_519);
    insertSession.run(
      personalSessionId,
      tenant.accountId,
      tenant.userId,
      personalInstallationId,
      digest(1_519),
      0,
      1,
      now,
      after(900),
      after(86_400),
      after(2_592_100),
      now,
    );
    const familyId = identifier(1_520);
    database
      .prepare(
        `INSERT INTO refresh_token_families(
          id, account_id, user_id, session_id, installation_id, status,
          created_at, version
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, 1)`,
      )
      .run(
        familyId,
        tenant.accountId,
        tenant.userId,
        personalSessionId,
        personalInstallationId,
        now,
      );
    const insertToken = database.prepare(
      `INSERT INTO refresh_tokens(
        id, account_id, family_id, generation, token_digest, status,
        issued_at, expires_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    insertToken.run(
      identifier(1_521),
      tenant.accountId,
      familyId,
      1,
      digest(1_521),
      "active",
      now,
      after(2_592_000),
    );
    assert.throws(
      () =>
        insertToken.run(
          identifier(1_522),
          tenant.accountId,
          familyId,
          2,
          digest(1_522),
          "pending",
          now,
          after(2_592_001),
        ),
      /refresh token must be the exact next generation of an active current family/i,
    );
    assert.throws(
      () =>
        insertToken.run(
          identifier(1_523),
          tenant.accountId,
          familyId,
          2,
          digest(1_523),
          "pending",
          now,
          "not-a-valid-date-value",
        ),
      /CHECK constraint failed|exact next generation of an active current family/i,
    );
    assertIntegrity(database);
  });
});

test("refresh token replacement stays in one family and advances exactly one generation", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 425, "TOK");
    const now = databaseTime(database);
    const nowMs = Date.parse(now);
    const after = (seconds: number): string => new Date(nowMs + seconds * 1_000).toISOString();
    const insertInstallation = database.prepare(
      `INSERT INTO device_installations(
        id, account_id, installation_id, platform, app_version,
        device_metadata_json, shared_device, first_seen_at, last_seen_at, version
      ) VALUES (?, ?, ?, 'android', '0.1.0-debug', '{}', 0, ?, ?, 1)`,
    );
    const insertSession = database.prepare(
      `INSERT INTO native_sessions(
        id, account_id, user_id, installation_id, access_token_digest,
        shared_device, push_allowed, issued_at, access_expires_at, idle_expires_at,
        absolute_expires_at, last_seen_at, version
      ) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, 1)`,
    );
    const insertFamily = database.prepare(
      `INSERT INTO refresh_token_families(
        id, account_id, user_id, session_id, installation_id, status,
        created_at, version
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, 1)`,
    );
    const createFamily = (base: number): string => {
      const installationId = identifier(base);
      const sessionId = identifier(base + 1);
      const familyId = identifier(base + 2);
      insertInstallation.run(installationId, tenant.accountId, identifier(base + 3), now, now);
      insertSession.run(
        sessionId,
        tenant.accountId,
        tenant.userId,
        installationId,
        digest(base),
        now,
        after(900),
        after(3_600),
        after(86_400),
        now,
      );
      insertFamily.run(familyId, tenant.accountId, tenant.userId, sessionId, installationId, now);
      return familyId;
    };
    const familyA = createFamily(430);
    const familyB = createFamily(440);
    const insertToken = database.prepare(
      `INSERT INTO refresh_tokens(
        id, account_id, family_id, generation, token_digest, status,
        issued_at, expires_at, consumed_at, revoked_at,
        replaced_by_token_id, replaced_by_family_id, replaced_by_generation,
        version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );

    const familyBGeneration1 = identifier(450);
    insertToken.run(
      familyBGeneration1,
      tenant.accountId,
      familyB,
      1,
      digest(450),
      "active",
      now,
      after(86_400),
      null,
      null,
      null,
      null,
      null,
    );
    const familyBGeneration2 = identifier(451);
    insertToken.run(
      familyBGeneration2,
      tenant.accountId,
      familyB,
      2,
      digest(451),
      "pending",
      now,
      after(86_400),
      null,
      null,
      null,
      null,
      null,
    );
    const familyAGeneration1 = identifier(452);
    insertToken.run(
      familyAGeneration1,
      tenant.accountId,
      familyA,
      1,
      digest(452),
      "active",
      now,
      after(86_400),
      null,
      null,
      null,
      null,
      null,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE refresh_tokens
             SET status = 'consumed', consumed_at = ?, replaced_by_token_id = ?,
                 replaced_by_family_id = ?, replaced_by_generation = 2, version = 2
             WHERE id = ?`,
          )
          .run(now, familyBGeneration2, familyA, familyAGeneration1),
      /family|generation|replacement/i,
    );

    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE refresh_tokens
             SET status = 'consumed', consumed_at = ?, replaced_by_token_id = ?,
                 replaced_by_family_id = ?, replaced_by_generation = 3, version = 2
             WHERE id = ?`,
          )
          .run(now, identifier(453), familyA, familyAGeneration1),
      /family|generation|replacement/i,
    );

    const familyAGeneration2 = identifier(454);
    insertToken.run(
      familyAGeneration2,
      tenant.accountId,
      familyA,
      2,
      digest(454),
      "pending",
      now,
      after(86_400),
      null,
      null,
      null,
      null,
      null,
    );
    database
      .prepare(
        `UPDATE refresh_tokens
         SET status = 'consumed', consumed_at = ?, replaced_by_token_id = ?,
             replaced_by_family_id = ?, replaced_by_generation = 2, version = 2
         WHERE id = ?`,
      )
      .run(now, familyAGeneration2, familyA, familyAGeneration1);
    database
      .prepare(
        `UPDATE refresh_tokens
         SET status = 'active', version = 2
         WHERE id = ?`,
      )
      .run(familyAGeneration2);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE refresh_tokens
             SET status = 'active', consumed_at = NULL,
                 replaced_by_token_id = NULL, replaced_by_family_id = NULL,
                 replaced_by_generation = NULL, version = 2
             WHERE id = ?`,
          )
          .run(familyAGeneration1),
      /refresh token.*(?:terminal|resurrect|transition|consumed|one-way)/i,
    );
    assertIntegrity(database);
  });
});

test("revoked auth state cannot resurrect and secret replay snapshots are append-only", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 1_600, "TRM");
    const auth = insertPersonalAuthFixture(database, tenant, 1_610);
    const installationId = auth.installationId;
    const sessionId = auth.sessionId;
    const familyId = auth.familyId;
    const tokenId = auth.tokenId;
    const replayId = identifier(1_614);
    database
      .prepare(
        `INSERT INTO auth_secret_replays(
          id, account_id, actor_id, installation_id, session_id,
          refresh_family_id, action, operation_id, scope_digest,
          idempotency_key_digest, request_hmac, response_ciphertext,
          response_secret_hmac, encryption_key_version, effect_session_version,
          effect_token_generation, effect_committed, mutation_count,
          consumed_at, created_at, expires_at, version
        ) VALUES (
          ?, ?, ?, ?, ?, ?, 'native_login', 'createNativeSession', ?, ?, ?, ?, ?,
          1, 1, 1, 1, 1, NULL, ?, ?, 1
        )`,
      )
      .run(
        replayId,
        tenant.accountId,
        tenant.userId,
        installationId,
        sessionId,
        familyId,
        digest(1_614),
        digest(1_615),
        digest(1_616),
        "encrypted-session-response",
        digest(1_617),
        auth.now,
        new Date(Date.parse(auth.now) + 300 * 1_000).toISOString(),
      );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE auth_secret_replays
             SET response_ciphertext = 'rewritten-response'
             WHERE id = ?`,
          )
          .run(replayId),
      /secret replay.*immutable|replay snapshot.*immutable/i,
    );
    assert.throws(
      () => database.prepare("DELETE FROM auth_secret_replays WHERE id = ?").run(replayId),
      /secret replay.*append-only|replay snapshot.*append-only/i,
    );

    database
      .prepare(
        `UPDATE refresh_tokens
         SET status = 'revoked', revoked_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(databaseTime(database), tokenId);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE refresh_tokens
             SET status = 'active', revoked_at = NULL, version = 3
             WHERE id = ?`,
          )
          .run(tokenId),
      /refresh token.*(?:terminal|resurrect|transition|revoked|one-way)/i,
    );
    database
      .prepare(
        `UPDATE refresh_token_families
         SET status = 'revoked', revoked_at = ?, revoked_reason = 'user logout', version = 2
         WHERE id = ?`,
      )
      .run(databaseTime(database), familyId);
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO refresh_tokens(
              id, account_id, family_id, generation, token_digest, status,
              issued_at, expires_at, version
            ) VALUES (?, ?, ?, 42, ?, 'active', ?, ?, 1)`,
          )
          .run(
            identifier(1_618),
            tenant.accountId,
            familyId,
            digest(1_618),
            auth.now,
            auth.absoluteExpiresAt,
          ),
      /refresh token.*(?:active (?:current )?family|revoked family|terminal)/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE refresh_token_families
             SET status = 'active', revoked_at = NULL, revoked_reason = NULL, version = 3
             WHERE id = ?`,
          )
          .run(familyId),
      /refresh family.*(?:terminal|resurrect|transition|revoked|one-way)/i,
    );
    assert.throws(
      () => database.prepare("DELETE FROM refresh_token_families WHERE id = ?").run(familyId),
      /refresh family.*append-only|auth family.*append-only/i,
    );

    database
      .prepare(
        `UPDATE native_sessions
         SET revoked_at = ?, revoked_reason = 'user logout', version = 2
         WHERE id = ?`,
      )
      .run(databaseTime(database), sessionId);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE native_sessions
             SET revoked_at = NULL, revoked_reason = NULL, version = 3
             WHERE id = ?`,
          )
          .run(sessionId),
      /native session.*(?:terminal|resurrect|revoked|immutable)/i,
    );
    assert.throws(
      () => database.prepare("DELETE FROM native_sessions WHERE id = ?").run(sessionId),
      /native session.*append-only|auth session.*append-only/i,
    );
    assertIntegrity(database);
  });
});

test("expired native sessions cannot mint, activate, or consume refresh generations", async () => {
  await withDatabase(async (database) => {
    const tenant = seedTenant(database, 2_000, "EXP");
    const insertInstallation = database.prepare(
      `INSERT INTO device_installations(
        id, account_id, installation_id, platform, app_version,
        device_metadata_json, shared_device, first_seen_at, last_seen_at, version
      ) VALUES (?, ?, ?, 'android', '0.1.0-debug', '{}', 0, ?, ?, 1)`,
    );
    const insertSession = database.prepare(
      `INSERT INTO native_sessions(
        id, account_id, user_id, installation_id, access_token_digest,
        shared_device, push_allowed, issued_at, access_expires_at,
        idle_expires_at, absolute_expires_at, last_seen_at, version
      ) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, 1)`,
    );
    const insertFamily = database.prepare(
      `INSERT INTO refresh_token_families(
        id, account_id, user_id, session_id, installation_id, status,
        created_at, version
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, 1)`,
    );
    const createShortFamily = (
      base: number,
    ): {
      readonly expiresAt: string;
      readonly familyId: string;
      readonly issuedAt: string;
    } => {
      const installationId = identifier(base);
      const sessionId = identifier(base + 1);
      const familyId = identifier(base + 2);
      const issuedAt = databaseTime(database);
      const expiresAt = new Date(Date.parse(issuedAt) + 2_000).toISOString();
      insertInstallation.run(
        installationId,
        tenant.accountId,
        identifier(base + 3),
        issuedAt,
        issuedAt,
      );
      insertSession.run(
        sessionId,
        tenant.accountId,
        tenant.userId,
        installationId,
        digest(base),
        issuedAt,
        expiresAt,
        expiresAt,
        expiresAt,
        issuedAt,
      );
      insertFamily.run(
        familyId,
        tenant.accountId,
        tenant.userId,
        sessionId,
        installationId,
        issuedAt,
      );
      return { expiresAt, familyId, issuedAt };
    };
    const lateInsertFamily = createShortFamily(2_010);
    const rotationFamily = createShortFamily(2_020);
    const insertToken = database.prepare(
      `INSERT INTO refresh_tokens(
        id, account_id, family_id, generation, token_digest, status,
        issued_at, expires_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    const activeTokenId = identifier(2_030);
    const pendingTokenId = identifier(2_031);
    insertToken.run(
      activeTokenId,
      tenant.accountId,
      rotationFamily.familyId,
      1,
      digest(2_030),
      "active",
      rotationFamily.issuedAt,
      rotationFamily.expiresAt,
    );
    insertToken.run(
      pendingTokenId,
      tenant.accountId,
      rotationFamily.familyId,
      2,
      digest(2_031),
      "pending",
      rotationFamily.issuedAt,
      rotationFamily.expiresAt,
    );

    const expiresAtMs = Math.max(
      Date.parse(lateInsertFamily.expiresAt),
      Date.parse(rotationFamily.expiresAt),
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, expiresAtMs - Date.now() + 1_100));
    });
    const expiredTokenError = /refresh token.*(?:expired|current|one-way|CAS|generation|family)/i;
    assert.throws(
      () =>
        insertToken.run(
          identifier(2_032),
          tenant.accountId,
          lateInsertFamily.familyId,
          1,
          digest(2_032),
          "active",
          lateInsertFamily.issuedAt,
          lateInsertFamily.expiresAt,
        ),
      expiredTokenError,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE refresh_tokens
             SET status = 'active', version = 2
             WHERE id = ?`,
          )
          .run(pendingTokenId),
      expiredTokenError,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE refresh_tokens
             SET status = 'consumed', consumed_at = ?,
                 replaced_by_token_id = ?, replaced_by_family_id = ?,
                 replaced_by_generation = 2, version = 2
             WHERE id = ?`,
          )
          .run(databaseTime(database), pendingTokenId, rotationFamily.familyId, activeTokenId),
      expiredTokenError,
    );
    assertIntegrity(database);
  });
});

test("capture completion requires core Poco capabilities and snapshots stay bounded to captureId", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 450, "POC");
    const bundleA = identifier(460);
    const captureA = identifier(461);
    const bundleB = identifier(462);
    const captureB = identifier(463);
    const captureAClientSubmission = identifier(464);
    const primaryA = insertCaptureBundle(
      database,
      tenant,
      bundleA,
      captureA,
      captureAClientSubmission,
    );
    insertCaptureBundle(database, tenant, bundleB, captureB, identifier(465));

    const insertArtifact = database.prepare(
      `INSERT INTO capture_artifacts(
        id, account_id, project_id, capture_bundle_id, capture_id,
        client_attachment_id, attachment_id, artifact_type, status, skew_ms,
        truncated, metadata_json, started_at, ended_at, created_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', 0, 0, '{}', ?, ?, ?, 1)`,
    );
    insertArtifact.run(
      identifier(471),
      tenant.accountId,
      tenant.projectId,
      bundleA,
      captureA,
      primaryA.clientAttachmentId,
      primaryA.attachmentId,
      "system_screenshot",
      CREATED_AT,
      UPDATED_AT,
      UPDATED_AT,
    );
    database
      .prepare(
        `INSERT INTO poco_enrichments(
          id, account_id, project_id, capture_bundle_id, capture_id, nonce_hash,
          schema_version, attempted, connected_port, sdk_version,
          snapshot_capability, screen_width, screen_height, status,
          collected_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, '1.0.0', 0, NULL, NULL,
          'not_probed', NULL, NULL, 'unavailable', ?, 1)`,
      )
      .run(
        identifier(466),
        tenant.accountId,
        tenant.projectId,
        bundleA,
        captureA,
        digest(466),
        CREATED_AT,
      );
    database
      .prepare(
        `UPDATE poco_enrichments
         SET attempted = 1, connected_port = 5001, sdk_version = '6',
             snapshot_capability = 'standard_only', screen_width = 1440,
             screen_height = 2560, status = 'complete', collected_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(UPDATED_AT, identifier(466));

    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE capture_bundles
             SET enrichment_status = 'complete', updated_at = ?, version = 2
             WHERE id = ?`,
          )
          .run(FINALIZED_AT, bundleA),
      /complete|GetSDKVersion|Screenshot|Dump|capabilit|Poco status/i,
    );

    const createCaptureAttachment = (base: number, mediaType: string): UploadFixture => {
      const upload = uploadFixture(tenant, base, {
        captureId: captureA,
        clientSubmissionId: captureAClientSubmission,
        mediaType,
      });
      insertUpload(database, tenant, upload);
      insertBlob(database, tenant, upload);
      insertAttachment(database, tenant, upload);
      finalizeUpload(database, upload.uploadId, upload.attachmentId);
      return upload;
    };
    const pocoScreenshot = createCaptureAttachment(106_000, "image/png");
    const pocoHierarchy = createCaptureAttachment(106_010, "application/json");
    insertArtifact.run(
      identifier(472),
      tenant.accountId,
      tenant.projectId,
      bundleA,
      captureA,
      pocoScreenshot.clientAttachmentId,
      pocoScreenshot.attachmentId,
      "poco_screenshot",
      CREATED_AT,
      UPDATED_AT,
      UPDATED_AT,
    );
    insertArtifact.run(
      identifier(473),
      tenant.accountId,
      tenant.projectId,
      bundleA,
      captureA,
      pocoHierarchy.clientAttachmentId,
      pocoHierarchy.attachmentId,
      "poco_hierarchy",
      CREATED_AT,
      UPDATED_AT,
      UPDATED_AT,
    );

    const insertMethod = database.prepare(
      `INSERT INTO capture_poco_methods(
        account_id, project_id, capture_bundle_id, method, negotiated, status,
        latency_ms, response_bytes, collected_at
      ) VALUES (?, ?, ?, ?, 1, 'succeeded', 10, ?, ?)`,
    );
    for (const [method, responseBytes] of [
      ["GetSDKVersion", 16],
      ["Screenshot", 2_048],
      ["Dump", 4_096],
    ] as const) {
      insertMethod.run(
        tenant.accountId,
        tenant.projectId,
        bundleA,
        method,
        responseBytes,
        UPDATED_AT,
      );
    }
    database
      .prepare(
        `UPDATE capture_bundles
         SET enrichment_status = 'complete', updated_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(FINALIZED_AT, bundleA);

    const insertSnapshot = database.prepare(
      `INSERT INTO poco_snapshots(
        id, account_id, project_id, capture_bundle_id, capture_id,
        schema_version, compression, uncompressed_bytes, payload_json,
        limited_error_count, created_at, version
      ) VALUES (?, ?, ?, ?, ?, '1.0.0', 'none', ?, ?, ?, ?, 1)`,
    );
    assert.throws(
      () =>
        insertSnapshot.run(
          identifier(467),
          tenant.accountId,
          tenant.projectId,
          bundleA,
          captureB,
          2,
          "{}",
          0,
          UPDATED_AT,
        ),
      /FOREIGN KEY constraint failed/i,
    );

    const oversizedPayload = JSON.stringify({ data: "x".repeat(262_145) });
    assert.throws(
      () =>
        insertSnapshot.run(
          identifier(468),
          tenant.accountId,
          tenant.projectId,
          bundleB,
          captureB,
          Buffer.byteLength(oversizedPayload),
          oversizedPayload,
          0,
          UPDATED_AT,
        ),
      /CHECK constraint failed/i,
    );
    assert.throws(
      () =>
        insertSnapshot.run(
          identifier(469),
          tenant.accountId,
          tenant.projectId,
          bundleB,
          captureB,
          2,
          "{}",
          21,
          UPDATED_AT,
        ),
      /CHECK constraint failed/i,
    );
    insertSnapshot.run(
      identifier(470),
      tenant.accountId,
      tenant.projectId,
      bundleB,
      captureB,
      2,
      "{}",
      0,
      UPDATED_AT,
    );
    assertIntegrity(database);
  });
});

test("draft Poco method outcomes and snapshots are immutable append-only facts", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_300, "PCI");
    const bundleId = identifier(5_310);
    const captureId = identifier(5_311);
    insertCaptureBundle(database, tenant, bundleId, captureId, identifier(5_312));
    database
      .prepare(
        `INSERT INTO capture_poco_methods(
          account_id, project_id, capture_bundle_id, method, negotiated, status,
          latency_ms, response_bytes, error_code, collected_at
        ) VALUES (?, ?, ?, 'GetSDKVersion', 0, 'unavailable', NULL, NULL,
          'connection_refused', ?)`,
      )
      .run(tenant.accountId, tenant.projectId, bundleId, UPDATED_AT);
    const snapshotId = identifier(5_313);
    database
      .prepare(
        `INSERT INTO poco_snapshots(
          id, account_id, project_id, capture_bundle_id, capture_id,
          schema_version, compression, uncompressed_bytes, payload_json,
          limited_error_count, created_at, version
        ) VALUES (?, ?, ?, ?, ?, '1.0.0', 'none', 2, '{}', 0, ?, 1)`,
      )
      .run(snapshotId, tenant.accountId, tenant.projectId, bundleId, captureId, UPDATED_AT);

    const accepted: string[] = [];
    const expectRejected = (label: string, action: () => void, pattern: RegExp): void => {
      const rejection = probeSqlRejection(database, action);
      if (rejection === undefined) {
        accepted.push(label);
      } else {
        assert.match(String(rejection), pattern);
      }
    };
    expectRejected(
      "draft Poco method outcome update",
      () => {
        database
          .prepare(
            `UPDATE capture_poco_methods
             SET status = 'failed', error_code = 'changed_after_collection'
             WHERE capture_bundle_id = ? AND method = 'GetSDKVersion'`,
          )
          .run(bundleId);
      },
      /Poco (?:method )?outcomes?.*(?:immutable|sealed)/i,
    );
    expectRejected(
      "draft Poco method outcome delete",
      () => {
        database
          .prepare(
            "DELETE FROM capture_poco_methods WHERE capture_bundle_id = ? AND method = 'GetSDKVersion'",
          )
          .run(bundleId);
      },
      /Poco (?:method )?outcomes?.*(?:append-only|delete|immutable)/i,
    );
    const replacementPayload = JSON.stringify({ ok: true });
    expectRejected(
      "draft Poco snapshot update",
      () => {
        database
          .prepare(
            `UPDATE poco_snapshots
             SET payload_json = ?, uncompressed_bytes = ?, limited_error_count = 1
             WHERE id = ?`,
          )
          .run(replacementPayload, Buffer.byteLength(replacementPayload), snapshotId);
      },
      /Poco snapshots?.*(?:immutable|sealed)/i,
    );
    expectRejected(
      "draft Poco snapshot delete",
      () => {
        database.prepare("DELETE FROM poco_snapshots WHERE id = ?").run(snapshotId);
      },
      /Poco snapshots?.*(?:append-only|delete|immutable)/i,
    );
    assert.deepEqual(accepted, []);
    assertIntegrity(database);
  });
});

test("Poco enrichment starts effect-free unavailable and advances once to a terminal exact-CAS fact", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_400, "PEL");
    const bundleId = identifier(5_410);
    const captureId = identifier(5_411);
    insertCaptureBundle(database, tenant, bundleId, captureId, identifier(5_412));
    const insertEnrichment = database.prepare(
      `INSERT INTO poco_enrichments(
        id, account_id, project_id, capture_bundle_id, capture_id, nonce_hash,
        schema_version, attempted, connected_port, sdk_version,
        snapshot_capability, screen_width, screen_height, status, error_code,
        failure_reason, collected_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, '1.0.0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const enrichmentId = identifier(5_413);
    insertEnrichment.run(
      enrichmentId,
      tenant.accountId,
      tenant.projectId,
      bundleId,
      captureId,
      digest(5_413),
      0,
      null,
      null,
      "not_probed",
      null,
      null,
      "unavailable",
      null,
      null,
      CREATED_AT,
      1,
    );
    const lifecycleError =
      /Poco enrichment.*(?:initial|coherent|effect-free|terminal|transition|CAS|version)/i;
    const wrongVersionBundle = identifier(5_415);
    const wrongVersionCapture = identifier(5_416);
    insertCaptureBundle(
      database,
      tenant,
      wrongVersionBundle,
      wrongVersionCapture,
      identifier(5_417),
    );
    assert.throws(
      () =>
        insertEnrichment.run(
          identifier(5_414),
          tenant.accountId,
          tenant.projectId,
          wrongVersionBundle,
          wrongVersionCapture,
          digest(5_414),
          0,
          null,
          null,
          "not_probed",
          null,
          null,
          "unavailable",
          null,
          null,
          CREATED_AT,
          2,
        ),
      /Poco enrichment.*(?:initial|version)/i,
    );
    const terminalInsertBundle = identifier(5_418);
    const terminalInsertCapture = identifier(5_419);
    insertCaptureBundle(
      database,
      tenant,
      terminalInsertBundle,
      terminalInsertCapture,
      identifier(5_420),
    );
    assert.throws(
      () =>
        insertEnrichment.run(
          identifier(5_421),
          tenant.accountId,
          tenant.projectId,
          terminalInsertBundle,
          terminalInsertCapture,
          digest(5_421),
          1,
          null,
          null,
          "not_probed",
          null,
          null,
          "unavailable",
          "connection_refused",
          "connection_refused",
          CREATED_AT,
          1,
        ),
      lifecycleError,
    );
    const effectfulTerminalBundle = identifier(5_422);
    const effectfulTerminalCapture = identifier(5_423);
    insertCaptureBundle(
      database,
      tenant,
      effectfulTerminalBundle,
      effectfulTerminalCapture,
      identifier(5_424),
    );
    assert.throws(
      () =>
        insertEnrichment.run(
          identifier(5_425),
          tenant.accountId,
          tenant.projectId,
          effectfulTerminalBundle,
          effectfulTerminalCapture,
          digest(5_425),
          1,
          5001,
          "6",
          "standard_only",
          null,
          null,
          "partial",
          null,
          null,
          CREATED_AT,
          1,
        ),
      lifecycleError,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE poco_enrichments
             SET attempted = 1, status = 'unavailable', error_code = 'connection_refused',
                 failure_reason = 'connection_refused', collected_at = ?, version = 3
             WHERE id = ?`,
          )
          .run(UPDATED_AT, enrichmentId),
      lifecycleError,
    );
    database
      .prepare(
        `UPDATE poco_enrichments
         SET attempted = 1, status = 'unavailable', error_code = 'connection_refused',
             failure_reason = 'connection_refused', collected_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(UPDATED_AT, enrichmentId);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE poco_enrichments
             SET attempted = 0, connected_port = NULL, sdk_version = NULL,
                 snapshot_capability = 'not_probed', screen_width = NULL,
                 screen_height = NULL, status = 'unavailable', error_code = NULL,
                 failure_reason = NULL, collected_at = ?, version = 3
             WHERE id = ?`,
          )
          .run(FINALIZED_AT, enrichmentId),
      lifecycleError,
    );
    assert.throws(
      () => database.prepare("DELETE FROM poco_enrichments WHERE id = ?").run(enrichmentId),
      /Poco enrichment.*(?:append-only|delete|immutable)/i,
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT attempted, status, error_code AS errorCode, version FROM poco_enrichments WHERE id = ?",
          )
          .get(enrichmentId),
      },
      { attempted: 1, status: "unavailable", errorCode: "connection_refused", version: 2 },
    );
    assertIntegrity(database);
  });
});

test("capture finalization rejects orphan or incomplete qa.snapshot evidence while accepting the exact triple", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_500, "PCS");
    const insertPrimaryArtifact = (
      bundleId: string,
      captureId: string,
      primary: UploadFixture,
      sequence: number,
    ): void => {
      database
        .prepare(
          `INSERT INTO capture_artifacts(
            id, account_id, project_id, capture_bundle_id, capture_id,
            client_attachment_id, attachment_id, artifact_type, status, skew_ms,
            truncated, metadata_json, started_at, ended_at, created_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'system_screenshot', 'succeeded', 0,
            0, '{}', ?, ?, ?, 1)`,
        )
        .run(
          identifier(sequence),
          tenant.accountId,
          tenant.projectId,
          bundleId,
          captureId,
          primary.clientAttachmentId,
          primary.attachmentId,
          CREATED_AT,
          UPDATED_AT,
          UPDATED_AT,
        );
    };
    const insertTerminalEnrichment = (
      bundleId: string,
      captureId: string,
      sequence: number,
      status: "partial" | "unavailable",
    ): void => {
      database
        .prepare(
          `INSERT INTO poco_enrichments(
            id, account_id, project_id, capture_bundle_id, capture_id, nonce_hash,
            schema_version, attempted, connected_port, sdk_version,
            snapshot_capability, screen_width, screen_height, status,
            collected_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, '1.0.0', 0, NULL, NULL,
            'not_probed', NULL, NULL, 'unavailable', ?, 1)`,
        )
        .run(
          identifier(sequence),
          tenant.accountId,
          tenant.projectId,
          bundleId,
          captureId,
          digest(sequence),
          CREATED_AT,
        );
      if (status === "partial") {
        database
          .prepare(
            `UPDATE poco_enrichments
             SET attempted = 1, connected_port = 5001, sdk_version = '6',
                 snapshot_capability = 'qa_snapshot_available', status = 'partial',
                 collected_at = ?, version = 2
             WHERE id = ?`,
          )
          .run(UPDATED_AT, identifier(sequence));
      }
    };
    const insertSnapshot = (bundleId: string, captureId: string, sequence: number): void => {
      database
        .prepare(
          `INSERT INTO poco_snapshots(
            id, account_id, project_id, capture_bundle_id, capture_id,
            schema_version, compression, uncompressed_bytes, payload_json,
            limited_error_count, created_at, version
          ) VALUES (?, ?, ?, ?, ?, '1.0.0', 'none', 2, '{}', 0, ?, 1)`,
        )
        .run(
          identifier(sequence),
          tenant.accountId,
          tenant.projectId,
          bundleId,
          captureId,
          UPDATED_AT,
        );
    };
    const insertSuccessfulMethod = (
      bundleId: string,
      method: string,
      responseBytes: number,
    ): void => {
      database
        .prepare(
          `INSERT INTO capture_poco_methods(
            account_id, project_id, capture_bundle_id, method, negotiated, status,
            latency_ms, response_bytes, collected_at
          ) VALUES (?, ?, ?, ?, 1, 'succeeded', 10, ?, ?)`,
        )
        .run(tenant.accountId, tenant.projectId, bundleId, method, responseBytes, UPDATED_AT);
    };
    const insertSnapshotArtifact = (
      bundleId: string,
      captureId: string,
      clientSubmissionId: string,
      base: number,
    ): void => {
      const upload = uploadFixture(tenant, base, {
        captureId,
        clientSubmissionId,
        mediaType: "application/json",
      });
      insertUpload(database, tenant, upload);
      insertBlob(database, tenant, upload);
      insertAttachment(database, tenant, upload);
      finalizeUpload(database, upload.uploadId, upload.attachmentId);
      database
        .prepare(
          `INSERT INTO capture_artifacts(
            id, account_id, project_id, capture_bundle_id, capture_id,
            client_attachment_id, attachment_id, artifact_type, status, skew_ms,
            truncated, metadata_json, started_at, ended_at, created_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'poco_snapshot', 'succeeded', 0,
            0, '{}', ?, ?, ?, 1)`,
        )
        .run(
          identifier(base + 5),
          tenant.accountId,
          tenant.projectId,
          bundleId,
          captureId,
          upload.clientAttachmentId,
          upload.attachmentId,
          CREATED_AT,
          UPDATED_AT,
          UPDATED_AT,
        );
    };

    const orphanBundle = identifier(5_510);
    const orphanCapture = identifier(5_511);
    const orphanClientSubmission = identifier(5_512);
    const orphanPrimary = insertCaptureBundle(
      database,
      tenant,
      orphanBundle,
      orphanCapture,
      orphanClientSubmission,
    );
    insertPrimaryArtifact(orphanBundle, orphanCapture, orphanPrimary, 5_513);
    insertTerminalEnrichment(orphanBundle, orphanCapture, 5_514, "unavailable");
    insertSnapshot(orphanBundle, orphanCapture, 5_515);
    const orphanRejection = probeSqlRejection(database, () => {
      database
        .prepare(
          `UPDATE capture_bundles
           SET status = 'uploaded', updated_at = ?, version = 2
           WHERE id = ?`,
        )
        .run(FINALIZED_AT, orphanBundle);
    });
    assert.notEqual(orphanRejection, undefined, "orphan Poco snapshot finalized a capture");
    assert.match(
      String(orphanRejection),
      /Poco.*(?:snapshot|outcome|artifact|orphan)|final capture.*evidence/i,
    );

    const incompleteBundle = identifier(5_520);
    const incompleteCapture = identifier(5_521);
    const incompleteClientSubmission = identifier(5_522);
    const incompletePrimary = insertCaptureBundle(
      database,
      tenant,
      incompleteBundle,
      incompleteCapture,
      incompleteClientSubmission,
    );
    insertPrimaryArtifact(incompleteBundle, incompleteCapture, incompletePrimary, 5_523);
    insertTerminalEnrichment(incompleteBundle, incompleteCapture, 5_524, "partial");
    insertSuccessfulMethod(incompleteBundle, "GetSDKVersion", 16);
    insertSuccessfulMethod(incompleteBundle, "qa.snapshot", 128);
    insertSnapshotArtifact(
      incompleteBundle,
      incompleteCapture,
      incompleteClientSubmission,
      150_000,
    );
    const incompleteRejection = probeSqlRejection(database, () => {
      database
        .prepare(
          `UPDATE capture_bundles
           SET enrichment_status = 'partial', status = 'uploaded', updated_at = ?, version = 2
           WHERE id = ?`,
        )
        .run(FINALIZED_AT, incompleteBundle);
    });
    assert.notEqual(
      incompleteRejection,
      undefined,
      "qa.snapshot method and artifact finalized without its snapshot fact",
    );
    assert.match(
      String(incompleteRejection),
      /Poco.*(?:snapshot|outcome|artifact)|final capture.*evidence/i,
    );

    const exactBundle = identifier(5_530);
    const exactCapture = identifier(5_531);
    const exactClientSubmission = identifier(5_532);
    const exactPrimary = insertCaptureBundle(
      database,
      tenant,
      exactBundle,
      exactCapture,
      exactClientSubmission,
    );
    insertPrimaryArtifact(exactBundle, exactCapture, exactPrimary, 5_533);
    insertTerminalEnrichment(exactBundle, exactCapture, 5_534, "partial");
    insertSuccessfulMethod(exactBundle, "GetSDKVersion", 16);
    insertSuccessfulMethod(exactBundle, "qa.snapshot", 128);
    insertSnapshotArtifact(exactBundle, exactCapture, exactClientSubmission, 160_000);
    insertSnapshot(exactBundle, exactCapture, 5_535);
    database
      .prepare(
        `UPDATE capture_bundles
         SET enrichment_status = 'partial', status = 'uploaded', updated_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(FINALIZED_AT, exactBundle);
    assert.equal(
      database.prepare("SELECT status FROM capture_bundles WHERE id = ?").get(exactBundle)?.status,
      "uploaded",
    );
    assertIntegrity(database);
  });
});

test("uploaded capture provenance and its artifact and Poco facts are immutable", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 1_000, "CAP");
    const bundleId = identifier(1_010);
    const captureId = identifier(1_011);
    const clientSubmissionId = identifier(1_012);
    const primary = insertCaptureBundle(database, tenant, bundleId, captureId, clientSubmissionId);
    const artifactId = identifier(1_013);
    const enrichmentId = identifier(1_014);
    database
      .prepare(
        `INSERT INTO capture_artifacts(
          id, account_id, project_id, capture_bundle_id, capture_id,
          client_attachment_id, attachment_id, artifact_type, status, skew_ms,
          truncated, metadata_json, started_at, ended_at, created_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'system_screenshot', 'succeeded', 0,
          0, '{}', ?, ?, ?, 1)`,
      )
      .run(
        artifactId,
        tenant.accountId,
        tenant.projectId,
        bundleId,
        captureId,
        primary.clientAttachmentId,
        primary.attachmentId,
        CREATED_AT,
        UPDATED_AT,
        UPDATED_AT,
      );
    database
      .prepare(
        `INSERT INTO poco_enrichments(
          id, account_id, project_id, capture_bundle_id, capture_id, nonce_hash,
          schema_version, attempted, connected_port, sdk_version,
          snapshot_capability, screen_width, screen_height, status,
          collected_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, '1.0.0', 0, NULL, NULL,
          'not_probed', NULL, NULL, 'unavailable', ?, 1)`,
      )
      .run(
        enrichmentId,
        tenant.accountId,
        tenant.projectId,
        bundleId,
        captureId,
        digest(1_014),
        UPDATED_AT,
      );
    database
      .prepare(
        `UPDATE capture_bundles
         SET status = 'uploaded', updated_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(FINALIZED_AT, bundleId);

    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE capture_bundles
             SET source = 'photo_picker', version = 3
             WHERE id = ?`,
          )
          .run(bundleId),
      /capture.*(?:provenance|identity|immutable|transition)|finalized (?:capture|evidence) mutation/i,
    );
    assert.throws(
      () => database.prepare("DELETE FROM capture_artifacts WHERE id = ?").run(artifactId),
      /capture artifact.*(?:append-only|delete|immutable)|finalized capture/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE poco_enrichments
             SET nonce_hash = ?, version = 2
             WHERE id = ?`,
          )
          .run(digest(1_015), enrichmentId),
      /Poco enrichment.*(?:immutable|sealed|transition|CAS)|finalized (?:capture|Poco enrichment)/i,
    );
    assert.equal(
      database.prepare("SELECT status FROM capture_bundles WHERE id = ?").get(bundleId)?.status,
      "uploaded",
    );
    assertIntegrity(database);
  });
});

test("attachments match both Blob identity and completed Upload metadata", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 500, "UPL");

    const blobMismatch = uploadFixture(tenant, 510);
    insertUpload(database, tenant, blobMismatch);
    insertBlob(database, tenant, blobMismatch, { digest: digest(9_510) });
    assert.throws(
      () => insertAttachment(database, tenant, blobMismatch),
      /FOREIGN KEY constraint failed/i,
    );

    const metadataMismatch = uploadFixture(tenant, 520);
    insertUpload(database, tenant, metadataMismatch);
    insertBlob(database, tenant, metadataMismatch);
    assert.throws(
      () =>
        insertAttachment(database, tenant, metadataMismatch, {
          fileName: "renamed-after-upload.png",
        }),
      /attachment metadata does not match completed upload session/i,
    );

    const incomplete = uploadFixture(tenant, 530);
    insertUpload(database, tenant, incomplete, 0);
    insertBlob(database, tenant, incomplete);
    assert.throws(
      () => insertAttachment(database, tenant, incomplete),
      /attachment metadata does not match completed upload session/i,
    );

    const first = createAttachment(database, tenant, 540, { finalize: false });
    const second = createAttachment(database, tenant, 550, { finalize: false });
    assert.throws(
      () => finalizeUpload(database, first.uploadId, second.attachmentId),
      /finalized upload does not match its attachment/i,
    );
    finalizeUpload(database, first.uploadId, first.attachmentId);
    finalizeUpload(database, second.uploadId, second.attachmentId);
    assert.equal(
      database
        .prepare("SELECT finalized_attachment_id FROM upload_sessions WHERE id = ?")
        .get(first.uploadId)?.finalized_attachment_id,
      first.attachmentId,
    );
    assertIntegrity(database);
  });
});

test("upload chunks and leases remain immutable through exact completion", async () => {
  await withDatabase(async (database) => {
    const tenant = seedTenant(database, 1_100, "CHK");
    const upload = uploadFixture(tenant, 1_110);
    insertUpload(database, tenant, upload);
    const chunkError = /upload chunk.*(?:immutable|append-only)|chunk geometry/i;
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE upload_chunks
             SET chunk_index = 1, offset_bytes = 1
             WHERE upload_session_id = ?`,
          )
          .run(upload.uploadId),
      chunkError,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE upload_chunks
             SET sha256 = ?
             WHERE upload_session_id = ?`,
          )
          .run(digest(1_111), upload.uploadId),
      chunkError,
    );
    assert.throws(
      () =>
        database
          .prepare("DELETE FROM upload_chunks WHERE upload_session_id = ?")
          .run(upload.uploadId),
      /upload chunk.*(?:append-only|delete|immutable)/i,
    );
    insertBlob(database, tenant, upload);
    insertAttachment(database, tenant, upload);
    finalizeUpload(database, upload.uploadId, upload.attachmentId);
    assert.throws(
      () => database.prepare("DELETE FROM upload_sessions WHERE id = ?").run(upload.uploadId),
      /upload lease and submission history.*append-only/i,
    );

    const insertRawSession = database.prepare(
      `INSERT INTO upload_sessions(
          id, account_id, project_id, actor_id, client_submission_id,
          client_attachment_id, capture_id, upload_attempt, file_name, media_type,
          expected_size_bytes, expected_sha256, received_size_bytes,
          chunk_size_bytes, expected_chunk_count, generation, status,
          expires_at, created_at, updated_at, version
        ) VALUES (
          ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, 0,
          262144, 1, 1, ?, ?, ?, ?, 1
        )`,
    );
    const insertRaw = (
      fixture: UploadFixture,
      status: "expired" | "open",
      expiresAt: string,
      createdAt: string,
    ): void => {
      insertRawSession.run(
        fixture.uploadId,
        tenant.accountId,
        tenant.projectId,
        tenant.userId,
        fixture.clientSubmissionId,
        fixture.clientAttachmentId,
        fixture.fileName,
        fixture.mediaType,
        fixture.sizeBytes,
        fixture.digest,
        status,
        expiresAt,
        createdAt,
        createdAt,
      );
    };

    const initiallyExpired = uploadFixture(tenant, 1_120);
    assert.throws(
      () =>
        insertRaw(initiallyExpired, "open", "2020-01-01T00:30:00.000Z", "2020-01-01T00:00:00.000Z"),
      /upload session must start as the exact next unexpired empty lease attempt/i,
    );
    const directTerminal = uploadFixture(tenant, 1_130);
    assert.throws(
      () =>
        insertRaw(
          directTerminal,
          "expired",
          databaseTime(database, "+1 hour"),
          databaseTime(database),
        ),
      /upload session must start as the exact next unexpired empty lease attempt/i,
    );

    const expiredLease = uploadFixture(tenant, 1_140);
    const shortCreatedAt = databaseTime(database);
    const shortExpiresAt = new Date(Date.parse(shortCreatedAt) + 1_000).toISOString();
    insertRaw(expiredLease, "open", shortExpiresAt, shortCreatedAt);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, Date.parse(shortExpiresAt) - Date.now() + 1_100));
    });
    database
      .prepare(
        `UPDATE upload_sessions
         SET status = 'expired', updated_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(databaseTime(database), expiredLease.uploadId);
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO upload_chunks(
              account_id, project_id, upload_session_id, generation, chunk_index,
              offset_bytes, size_bytes, sha256, storage_key, received_at
            ) VALUES (?, ?, ?, 1, 0, 0, ?, ?, ?, ?)`,
          )
          .run(
            tenant.accountId,
            tenant.projectId,
            expiredLease.uploadId,
            expiredLease.sizeBytes,
            expiredLease.digest,
            `chunks/${expiredLease.uploadId}/0`,
            databaseTime(database),
          ),
      /expired|lease|chunk geometry/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE upload_sessions
             SET status = 'open', updated_at = ?, version = 3
             WHERE id = ?`,
          )
          .run(databaseTime(database, "+1 second"), expiredLease.uploadId),
      /upload.*(?:terminal|transition|reopen|expired)/i,
    );
    assertIntegrity(database);
  });
});

test("Blob and Attachment evidence is one-way CAS and only exact finalized uploads can bind", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_800, "UED");
    const accepted: string[] = [];
    const expectRejected = (label: string, action: () => void, pattern: RegExp): void => {
      const rejection = probeSqlRejection(database, action);
      if (rejection === undefined) {
        accepted.push(label);
      } else {
        assert.match(String(rejection), pattern);
      }
    };
    const evidenceLifecycleError =
      /(?:blob|attachment).*(?:initial|one-way|CAS|transition|terminal|version)|evidence.*(?:one-way|CAS)/i;

    expectRejected(
      "Blob initial version skipped one",
      () => {
        database
          .prepare(
            `INSERT INTO blobs(
              id, account_id, sha256, size_bytes, storage_key, encryption_json,
              state, created_at, version
            ) VALUES (?, ?, ?, 1024, ?, '{}', 'ready', ?, 2)`,
          )
          .run(
            identifier(5_810),
            tenant.accountId,
            digest(5_810),
            "blobs/initial-version-two",
            CREATED_AT,
          );
      },
      evidenceLifecycleError,
    );

    const invalidAttachment = uploadFixture(tenant, 170_000);
    insertUpload(database, tenant, invalidAttachment);
    insertBlob(database, tenant, invalidAttachment);
    expectRejected(
      "Attachment initial version skipped one",
      () => {
        database
          .prepare(
            `INSERT INTO attachments(
              id, account_id, project_id, actor_id, client_submission_id,
              client_attachment_id, capture_id, blob_id, upload_session_id,
              file_name, media_type, size_bytes, sha256, status, scan_state,
              quarantine_key, created_at, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              'ready', 'clean', NULL, ?, 2)`,
          )
          .run(
            invalidAttachment.attachmentId,
            tenant.accountId,
            tenant.projectId,
            invalidAttachment.actorId,
            invalidAttachment.clientSubmissionId,
            invalidAttachment.clientAttachmentId,
            invalidAttachment.captureId,
            invalidAttachment.blobId,
            invalidAttachment.uploadId,
            invalidAttachment.fileName,
            invalidAttachment.mediaType,
            invalidAttachment.sizeBytes,
            invalidAttachment.digest,
            CREATED_AT,
          );
      },
      evidenceLifecycleError,
    );

    const deletable = uploadFixture(tenant, 171_000);
    insertUpload(database, tenant, deletable);
    insertBlob(database, tenant, deletable);
    insertAttachment(database, tenant, deletable);
    finalizeUpload(database, deletable.uploadId, deletable.attachmentId);
    const transitionEvidence = (version: number): void => {
      database
        .prepare("UPDATE blobs SET state = 'deleted', version = ? WHERE id = ?")
        .run(version, deletable.blobId);
      database
        .prepare(
          `UPDATE attachments
           SET status = 'deleted', scan_state = 'clean', quarantine_key = NULL, version = ?
           WHERE id = ?`,
        )
        .run(version, deletable.attachmentId);
    };
    expectRejected(
      "Blob and Attachment terminal transition omitted version bump",
      () => transitionEvidence(1),
      evidenceLifecycleError,
    );
    expectRejected(
      "Blob and Attachment terminal transition skipped a version",
      () => transitionEvidence(3),
      evidenceLifecycleError,
    );
    transaction(database, () => transitionEvidence(2));
    expectRejected(
      "deleted Blob and Attachment returned to ready clean",
      () => {
        database
          .prepare("UPDATE blobs SET state = 'ready', version = 3 WHERE id = ?")
          .run(deletable.blobId);
        database
          .prepare(
            `UPDATE attachments
             SET status = 'ready', scan_state = 'clean', quarantine_key = NULL, version = 3
             WHERE id = ?`,
          )
          .run(deletable.attachmentId);
      },
      evidenceLifecycleError,
    );

    const rejected = uploadFixture(tenant, 172_000);
    insertUpload(database, tenant, rejected);
    insertBlob(database, tenant, rejected, { state: "quarantined" });
    insertAttachment(database, tenant, rejected, {
      status: "quarantined",
      scanState: "rejected",
    });
    database
      .prepare(
        `UPDATE upload_sessions
         SET finalized_attachment_id = ?, status = 'rejected', updated_at = ?, version = 3
         WHERE id = ?`,
      )
      .run(rejected.attachmentId, databaseTime(database), rejected.uploadId);
    expectRejected(
      "rejected upload evidence resurrected without a version bump",
      () => {
        database.prepare("UPDATE blobs SET state = 'ready' WHERE id = ?").run(rejected.blobId);
        database
          .prepare(
            `UPDATE attachments
             SET status = 'ready', scan_state = 'clean', quarantine_key = NULL
             WHERE id = ?`,
          )
          .run(rejected.attachmentId);
      },
      evidenceLifecycleError,
    );
    const insertBinding = (bindingId: string, attachmentId: string, actorId: string): void => {
      const boundAt = databaseTime(database);
      database
        .prepare(
          `INSERT INTO attachment_bindings(
            id, account_id, project_id, attachment_id, intent, target_bug_id,
            lease_generation, state, expires_at, claimed_at, bound_by_actor_id,
            bound_at, version
          ) VALUES (?, ?, ?, ?, 'bug_create', NULL, 1, 'reserved', ?, NULL, ?, ?, 1)`,
        )
        .run(
          bindingId,
          tenant.accountId,
          tenant.projectId,
          attachmentId,
          databaseTime(database, "+1 hour"),
          actorId,
          boundAt,
        );
    };
    expectRejected(
      "rejected upload evidence resurrected with exact CAS and bound",
      () => {
        database
          .prepare("UPDATE blobs SET state = 'ready', version = 2 WHERE id = ?")
          .run(rejected.blobId);
        database
          .prepare(
            `UPDATE attachments
             SET status = 'ready', scan_state = 'clean', quarantine_key = NULL, version = 2
             WHERE id = ?`,
          )
          .run(rejected.attachmentId);
        insertBinding(identifier(5_820), rejected.attachmentId, tenant.userId);
      },
      /(?:blob|attachment|binding|upload).*(?:rejected|finalized|one-way|CAS|terminal|ready)/i,
    );
    assert.throws(
      () => insertBinding(identifier(5_821), rejected.attachmentId, tenant.userId),
      /only the owning actor can bind a ready clean attachment|binding.*(?:upload|ready|rejected)/i,
    );

    const incompleteUpload = uploadFixture(tenant, 173_000);
    insertUpload(database, tenant, incompleteUpload);
    insertBlob(database, tenant, incompleteUpload);
    insertAttachment(database, tenant, incompleteUpload);
    expectRejected(
      "finalizing upload attachment reserved a binding",
      () => insertBinding(identifier(5_822), incompleteUpload.attachmentId, tenant.userId),
      /attachment.*(?:binding|bind).*(?:finalized|upload)|bind.*attachment.*finalized.*upload|binding.*exact.*upload/i,
    );

    const bindable = uploadFixture(tenant, 174_000);
    insertUpload(database, tenant, bindable);
    insertBlob(database, tenant, bindable);
    insertAttachment(database, tenant, bindable);
    finalizeUpload(database, bindable.uploadId, bindable.attachmentId);
    const bugId = identifier(5_823);
    createBug(database, tenant, bugId, "Exact finalized binding Bug");
    const validBindingId = identifier(5_824);
    insertClaimedBinding(
      database,
      tenant,
      bindable.attachmentId,
      validBindingId,
      "bug_create",
      bugId,
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT binding.state, upload.status AS uploadStatus,
                    upload.finalized_attachment_id AS finalizedAttachmentId
             FROM attachment_bindings AS binding
             JOIN attachments AS attachment ON attachment.id = binding.attachment_id
             JOIN upload_sessions AS upload ON upload.id = attachment.upload_session_id
             WHERE binding.id = ?`,
          )
          .get(validBindingId),
      },
      {
        state: "claimed",
        uploadStatus: "finalized",
        finalizedAttachmentId: bindable.attachmentId,
      },
    );
    assert.deepEqual(accepted, []);
    assertIntegrity(database);
  });
});

test("attachment claims preserve the unexpired reservation identity and generation", async () => {
  await withDatabase(async (database) => {
    const tenant = seedTenant(database, 560, "RSV");
    const bugId = identifier(570);
    createBug(database, tenant, bugId, "Reservation Bug");
    const expiredAttachment = createAttachment(database, tenant, 580);
    const reservedAttachment = createAttachment(database, tenant, 590);
    const replacementAttachment = createAttachment(database, tenant, 600);
    const insertReservation = database.prepare(
      `INSERT INTO attachment_bindings(
        id, account_id, project_id, attachment_id, intent, target_bug_id,
        lease_generation, state, expires_at, claimed_at, bound_by_actor_id,
        bound_at, version
      ) VALUES (?, ?, ?, ?, 'bug_create', NULL, 1, 'reserved', ?, NULL, ?, ?, 1)`,
    );

    const expiredBindingId = identifier(610);
    const expiredBoundAt = databaseTime(database);
    const expiredExpiresAt = new Date(Date.parse(expiredBoundAt) + 1_000).toISOString();
    insertReservation.run(
      expiredBindingId,
      tenant.accountId,
      tenant.projectId,
      expiredAttachment.attachmentId,
      expiredExpiresAt,
      tenant.userId,
      expiredBoundAt,
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1_500);
    });
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE attachment_bindings
             SET target_bug_id = ?, state = 'claimed', expires_at = NULL,
                 claimed_at = ?, version = 2
             WHERE id = ?`,
          )
          .run(bugId, databaseTime(database), expiredBindingId),
      /expired|reservation|lease/i,
    );

    const bindingId = identifier(611);
    insertReservation.run(
      bindingId,
      tenant.accountId,
      tenant.projectId,
      reservedAttachment.attachmentId,
      databaseTime(database, "+1 hour"),
      tenant.userId,
      databaseTime(database),
    );
    const claimWithMutation = (
      assignment: string,
      parameters: readonly (number | string | null)[],
    ): void => {
      database
        .prepare(
          `UPDATE attachment_bindings
           SET ${assignment}, target_bug_id = ?, state = 'claimed',
               expires_at = NULL, claimed_at = ?, version = 2
           WHERE id = ?`,
        )
        .run(...parameters, bugId, databaseTime(database), bindingId);
    };
    assert.throws(
      () => claimWithMutation("id = ?", [identifier(612)]),
      /reservation|lease|immutable/i,
    );
    assert.throws(
      () => claimWithMutation("attachment_id = ?", [replacementAttachment.attachmentId]),
      /reservation|lease|immutable/i,
    );
    assert.throws(
      () => claimWithMutation("lease_generation = ?", [2]),
      /reservation|lease|immutable/i,
    );
    assert.throws(
      () => claimWithMutation("intent = ?", ["comment_append"]),
      /reservation|lease|immutable/i,
    );
    assert.throws(
      () => claimWithMutation("bound_at = ?", [UPDATED_AT]),
      /reservation|lease|immutable/i,
    );

    database
      .prepare(
        `UPDATE attachment_bindings
         SET target_bug_id = ?, state = 'claimed', expires_at = NULL,
             claimed_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(bugId, databaseTime(database), bindingId);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(
          database
            .prepare(
              `SELECT id, attachment_id, intent, lease_generation,
                      bound_by_actor_id, state, target_bug_id
               FROM attachment_bindings WHERE id = ?`,
            )
            .get(bindingId) ?? {},
        ),
      ),
      {
        id: bindingId,
        attachment_id: reservedAttachment.attachmentId,
        intent: "bug_create",
        lease_generation: 1,
        bound_by_actor_id: tenant.userId,
        state: "claimed",
        target_bug_id: bugId,
      },
    );

    const releasedAttachment = createAttachment(database, tenant, 10_600);
    const releasedBindingId = identifier(616);
    insertReservation.run(
      releasedBindingId,
      tenant.accountId,
      tenant.projectId,
      releasedAttachment.attachmentId,
      databaseTime(database, "+1 hour"),
      tenant.userId,
      databaseTime(database),
    );
    database
      .prepare(
        `UPDATE attachment_bindings
         SET state = 'released', expires_at = NULL, version = 2
         WHERE id = ?`,
      )
      .run(releasedBindingId);
    assert.throws(
      () => database.prepare("DELETE FROM attachment_bindings WHERE id = ?").run(releasedBindingId),
      /attachment binding lease history.*append-only/i,
    );
    assert.throws(
      () =>
        insertReservation.run(
          identifier(617),
          tenant.accountId,
          tenant.projectId,
          releasedAttachment.attachmentId,
          databaseTime(database, "+1 hour"),
          tenant.userId,
          databaseTime(database),
        ),
      /generation one.*server-clock lease|binding.*history/i,
    );
    assertIntegrity(database);
  });
});

test("only ready clean owner attachments bind, and claimed typed evidence is immutable", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 600, "BND");
    const bugA = identifier(610);
    const bugB = identifier(611);
    createBug(database, tenant, bugA, "Binding Bug A");
    createBug(database, tenant, bugB, "Binding Bug B");

    const quarantined = createAttachment(database, tenant, 620, {
      status: "quarantined",
      scanState: "rejected",
    });
    assert.throws(
      () =>
        insertClaimedBinding(
          database,
          tenant,
          quarantined.attachmentId,
          identifier(625),
          "bug_create",
          bugA,
        ),
      /only the owning actor can bind a ready clean attachment/i,
    );

    const wrongOwner = createAttachment(database, tenant, 630);
    assert.throws(
      () =>
        insertClaimedBinding(
          database,
          tenant,
          wrongOwner.attachmentId,
          identifier(635),
          "bug_create",
          bugA,
          tenant.secondaryUserId,
        ),
      /only the owning actor can bind a ready clean attachment/i,
    );

    const positive = createAttachment(database, tenant, 640);
    const positiveBindingId = identifier(645);
    const positiveBoundAt = databaseTime(database);
    database
      .prepare(
        `INSERT INTO attachment_bindings(
          id, account_id, project_id, attachment_id, intent, target_bug_id,
          lease_generation, state, expires_at, claimed_at, bound_by_actor_id,
          bound_at, version
        ) VALUES (?, ?, ?, ?, 'bug_create', NULL, 1, 'reserved', ?, NULL, ?, ?, 1)`,
      )
      .run(
        positiveBindingId,
        tenant.accountId,
        tenant.projectId,
        positive.attachmentId,
        databaseTime(database, "+1 hour"),
        tenant.userId,
        positiveBoundAt,
      );
    database
      .prepare(
        `UPDATE attachment_bindings
         SET target_bug_id = ?, state = 'claimed', expires_at = NULL,
             claimed_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(bugA, databaseTime(database), positiveBindingId);
    database
      .prepare(
        `INSERT INTO bug_attachments(
          account_id, project_id, bug_id, attachment_id, binding_id
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(tenant.accountId, tenant.projectId, bugA, positive.attachmentId, positiveBindingId);
    assert.throws(
      () =>
        database
          .prepare("UPDATE attachment_bindings SET version = version + 1 WHERE id = ?")
          .run(positiveBindingId),
      /claimed attachment bindings are immutable/i,
    );
    assert.throws(
      () => database.prepare("DELETE FROM attachment_bindings WHERE id = ?").run(positiveBindingId),
      /(?:claimed attachment bindings|attachment binding lease history).*append-only/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE bug_attachments SET binding_id = binding_id
             WHERE attachment_id = ?`,
          )
          .run(positive.attachmentId),
      /bug attachment links are immutable/i,
    );
    assert.throws(
      () =>
        database
          .prepare("DELETE FROM bug_attachments WHERE attachment_id = ?")
          .run(positive.attachmentId),
      /bug attachment links are append-only/i,
    );
    const evidenceStateError =
      /referenced.*(?:attachment|blob)|(?:claimed|typed|linked).*(?:attachment|blob)|evidence.*(?:immutable|removed)/i;
    assert.throws(
      () =>
        transaction(database, () => {
          database
            .prepare(
              `UPDATE attachments
               SET status = 'deleted', version = version + 1
               WHERE id = ?`,
            )
            .run(positive.attachmentId);
          database
            .prepare(
              `UPDATE blobs
               SET state = 'deleted', version = version + 1
               WHERE id = ?`,
            )
            .run(positive.blobId);
        }),
      evidenceStateError,
    );
    assert.throws(
      () =>
        transaction(database, () => {
          database
            .prepare(
              `UPDATE blobs
               SET state = 'quarantined', version = version + 1
               WHERE id = ?`,
            )
            .run(positive.blobId);
          database
            .prepare(
              `UPDATE attachments
               SET status = 'quarantined', scan_state = 'rejected',
                   quarantine_key = ?, version = version + 1
               WHERE id = ?`,
            )
            .run(`quarantine/${positive.attachmentId}`, positive.attachmentId);
        }),
      evidenceStateError,
    );
    assert.equal(
      database.prepare("SELECT status FROM attachments WHERE id = ?").get(positive.attachmentId)
        ?.status,
      "ready",
    );

    const wrongBugIntent = createAttachment(database, tenant, 650);
    const wrongBugIntentBinding = identifier(655);
    insertClaimedBinding(
      database,
      tenant,
      wrongBugIntent.attachmentId,
      wrongBugIntentBinding,
      "comment_append",
      bugA,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO bug_attachments(
              account_id, project_id, bug_id, attachment_id, binding_id
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            tenant.accountId,
            tenant.projectId,
            bugA,
            wrongBugIntent.attachmentId,
            wrongBugIntentBinding,
          ),
      /bug attachment requires its claimed Bug binding/i,
    );

    const occurrenceId = identifier(660);
    database
      .prepare(
        `INSERT INTO occurrences(
          id, account_id, project_id, bug_id, reporter_id, client_submission_id,
          observed_at, platform, steps_json, actual_behavior, environment_json,
          created_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'android', '["Open the screen"]',
          'The result differs from the expected state', '{}', ?, 1)`,
      )
      .run(
        occurrenceId,
        tenant.accountId,
        tenant.projectId,
        bugA,
        tenant.userId,
        identifier(661),
        CREATED_AT,
        CREATED_AT,
      );
    const occurrenceAttachment = createAttachment(database, tenant, 670);
    const occurrenceBinding = identifier(675);
    insertClaimedBinding(
      database,
      tenant,
      occurrenceAttachment.attachmentId,
      occurrenceBinding,
      "occurrence_append",
      bugB,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO occurrence_attachments(
              account_id, project_id, occurrence_id, attachment_id, binding_id
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            tenant.accountId,
            tenant.projectId,
            occurrenceId,
            occurrenceAttachment.attachmentId,
            occurrenceBinding,
          ),
      /occurrence attachment requires its claimed Bug binding/i,
    );

    const commentId = identifier(680);
    database
      .prepare(
        `INSERT INTO comments(
          id, account_id, project_id, bug_id, author_id, body,
          client_submission_id, created_at, version
        ) VALUES (?, ?, ?, ?, ?, 'Comment evidence', ?, ?, 1)`,
      )
      .run(
        commentId,
        tenant.accountId,
        tenant.projectId,
        bugA,
        tenant.userId,
        identifier(681),
        CREATED_AT,
      );
    const commentAttachment = createAttachment(database, tenant, 690);
    const commentBinding = identifier(695);
    insertClaimedBinding(
      database,
      tenant,
      commentAttachment.attachmentId,
      commentBinding,
      "occurrence_append",
      bugA,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO comment_attachments(
              account_id, project_id, comment_id, attachment_id, binding_id
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            tenant.accountId,
            tenant.projectId,
            commentId,
            commentAttachment.attachmentId,
            commentBinding,
          ),
      /comment attachment requires its claimed Bug binding/i,
    );

    const verificationAttemptId = identifier(700);
    const verificationId = identifier(701);
    const verificationAuditId = identifier(702);
    const verificationRequirementId = identifier(703);
    insertRepairAttempt(database, tenant, bugA, verificationAttemptId);
    insertQaAuditEvent(
      database,
      tenant,
      bugA,
      verificationAuditId,
      verificationAttemptId,
      verificationRequirementId,
    );
    insertBuildRequirement(
      database,
      tenant,
      bugA,
      verificationAttemptId,
      verificationAuditId,
      verificationRequirementId,
    );
    insertVerification(database, tenant, bugA, verificationAttemptId, verificationId);
    const verificationAttachment = createAttachment(database, tenant, 710);
    const verificationBinding = identifier(715);
    insertClaimedBinding(
      database,
      tenant,
      verificationAttachment.attachmentId,
      verificationBinding,
      "verification_result",
      bugB,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO verification_attachments(
              account_id, project_id, verification_id, attachment_id, binding_id
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            tenant.accountId,
            tenant.projectId,
            verificationId,
            verificationAttachment.attachmentId,
            verificationBinding,
          ),
      /verification attachment requires its claimed Bug binding/i,
    );
    assertIntegrity(database);
  });
});

test("submission intent targets preserve Bug, actor, and clientSubmission identity", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 720, "SUB");
    const bugA = identifier(730);
    const bugB = identifier(731);
    createBug(database, tenant, bugA, "Submission Bug A");
    createBug(database, tenant, bugB, "Submission Bug B");
    const insertSubmission = database.prepare(
      `INSERT INTO submissions(
        id, account_id, project_id, actor_id, client_submission_id, intent,
        payload_digest, bug_id, occurrence_id, comment_id, verification_id,
        capture_bundle_id, response_json, committed_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    const submit = (options: {
      readonly actorId: string;
      readonly bugId?: string;
      readonly captureBundleId?: string;
      readonly clientSubmissionId: string;
      readonly commentId?: string;
      readonly id: string;
      readonly intent:
        | "bug_create"
        | "occurrence_append"
        | "comment_append"
        | "verification_result"
        | "capture_create";
      readonly occurrenceId?: string;
      readonly verificationId?: string;
    }): void => {
      insertSubmission.run(
        options.id,
        tenant.accountId,
        tenant.projectId,
        options.actorId,
        options.clientSubmissionId,
        options.intent,
        digest(Number(options.id.slice(-12))),
        options.bugId ?? null,
        options.occurrenceId ?? null,
        options.commentId ?? null,
        options.verificationId ?? null,
        options.captureBundleId ?? null,
        JSON.stringify({
          clientSubmissionId: options.clientSubmissionId,
          projectId: tenant.projectId,
          bugId: options.bugId ?? null,
          occurrenceId: options.occurrenceId ?? null,
          commentId: options.commentId ?? null,
          verificationId: options.verificationId ?? null,
          captureBundleId: options.captureBundleId ?? null,
        }),
        CREATED_AT,
      );
    };
    const scopeError = /submission|intent|scope|target|actor|client/i;

    const occurrenceId = identifier(732);
    const occurrenceClientId = identifier(733);
    insertOccurrence(database, tenant, bugB, occurrenceId, occurrenceClientId);
    assert.throws(
      () =>
        submit({
          id: identifier(734),
          actorId: tenant.userId,
          clientSubmissionId: occurrenceClientId,
          intent: "occurrence_append",
          bugId: bugA,
          occurrenceId,
        }),
      scopeError,
    );
    submit({
      id: identifier(735),
      actorId: tenant.userId,
      clientSubmissionId: occurrenceClientId,
      intent: "occurrence_append",
      bugId: bugB,
      occurrenceId,
    });

    const commentId = identifier(736);
    const commentClientId = identifier(737);
    database
      .prepare(
        `INSERT INTO comments(
          id, account_id, project_id, bug_id, author_id, body,
          client_submission_id, created_at, version
        ) VALUES (?, ?, ?, ?, ?, 'Scoped comment', ?, ?, 1)`,
      )
      .run(
        commentId,
        tenant.accountId,
        tenant.projectId,
        bugB,
        tenant.secondaryUserId,
        commentClientId,
        CREATED_AT,
      );
    assert.throws(
      () =>
        submit({
          id: identifier(738),
          actorId: tenant.userId,
          clientSubmissionId: commentClientId,
          intent: "comment_append",
          bugId: bugB,
          commentId,
        }),
      scopeError,
    );
    assert.throws(
      () =>
        submit({
          id: identifier(739),
          actorId: tenant.secondaryUserId,
          clientSubmissionId: identifier(740),
          intent: "comment_append",
          bugId: bugB,
          commentId,
        }),
      scopeError,
    );
    submit({
      id: identifier(741),
      actorId: tenant.secondaryUserId,
      clientSubmissionId: commentClientId,
      intent: "comment_append",
      bugId: bugB,
      commentId,
    });

    const attemptId = identifier(742);
    const verificationId = identifier(743);
    const verificationAuditId = identifier(755);
    const verificationRequirementId = identifier(756);
    insertRepairAttempt(database, tenant, bugB, attemptId);
    insertQaAuditEvent(
      database,
      tenant,
      bugB,
      verificationAuditId,
      attemptId,
      verificationRequirementId,
    );
    insertBuildRequirement(
      database,
      tenant,
      bugB,
      attemptId,
      verificationAuditId,
      verificationRequirementId,
    );
    insertVerification(database, tenant, bugB, attemptId, verificationId);
    assert.throws(
      () =>
        submit({
          id: identifier(744),
          actorId: tenant.userId,
          clientSubmissionId: identifier(745),
          intent: "verification_result",
          bugId: bugA,
          verificationId,
        }),
      scopeError,
    );
    submit({
      id: identifier(746),
      actorId: tenant.userId,
      clientSubmissionId: identifier(747),
      intent: "verification_result",
      bugId: bugB,
      verificationId,
    });

    const captureBundleId = identifier(748);
    const captureId = identifier(749);
    const captureClientId = identifier(750);
    insertCaptureBundle(database, tenant, captureBundleId, captureId, captureClientId);
    assert.throws(
      () =>
        submit({
          id: identifier(751),
          actorId: tenant.secondaryUserId,
          clientSubmissionId: captureClientId,
          intent: "capture_create",
          captureBundleId,
        }),
      scopeError,
    );
    assert.throws(
      () =>
        submit({
          id: identifier(752),
          actorId: tenant.userId,
          clientSubmissionId: identifier(753),
          intent: "capture_create",
          captureBundleId,
        }),
      scopeError,
    );
    submit({
      id: identifier(754),
      actorId: tenant.userId,
      clientSubmissionId: captureClientId,
      intent: "capture_create",
      captureBundleId,
    });
    assertIntegrity(database);
  });
});

test("idempotency reservations require complete audited terminal effects and remain immutable", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 1_700, "IDM");
    const bugId = identifier(1_710);
    createBug(database, tenant, bugId, "Idempotency effect Bug");
    const reservationCreatedAt = databaseTime(database);
    const reservationExpiresAt = databaseTime(database, "+1 day");
    const insertReservation = database.prepare(
      `INSERT INTO idempotency_records(
        id, account_id, project_id, actor_id, operation_id, idempotency_key,
        scope_digest, scope_json, request_digest, status, http_status,
        response_json, audit_event_id, created_at, expires_at, version
      ) VALUES (?, ?, ?, ?, 'readBugList', ?, ?, ?, ?, 'reserved',
        NULL, NULL, NULL, ?, ?, 1)`,
    );
    const reserve = (recordId: string): string => {
      const requestDigest = digest(Number(recordId.slice(-12)));
      insertReservation.run(
        recordId,
        tenant.accountId,
        tenant.projectId,
        tenant.userId,
        `idempotency-${recordId}`,
        digest(Number(recordId.slice(-12)) + 10_000),
        JSON.stringify({ projectId: tenant.projectId, bugId }),
        requestDigest,
        reservationCreatedAt,
        reservationExpiresAt,
      );
      return requestDigest;
    };
    const insertAudit = (recordId: string, eventId: string, requestDigest: string): void => {
      database
        .prepare(
          `INSERT INTO events(
            id, account_id, project_id, bug_id, type, source, actor_type,
            actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
            resource_type, resource_id, resource_version_after, request_digest,
            correlation_id, payload_json, created_at
          ) VALUES (
            ?, ?, ?, ?, 'idempotency.committed', 'qa_hub', 'user', ?,
            'idempotency_record', ?, 1, 'idempotency_record', ?, 2, ?, ?, ?, ?
          )`,
        )
        .run(
          eventId,
          tenant.accountId,
          tenant.projectId,
          bugId,
          tenant.userId,
          recordId,
          recordId,
          requestDigest,
          identifier(Number(eventId.slice(-12)) + 100_000),
          JSON.stringify({
            status: "committed",
            relatedBugId: bugId,
          }),
          UPDATED_AT,
        );
    };
    const transition = database.prepare(
      `UPDATE idempotency_records
       SET status = 'committed', http_status = ?, response_json = ?,
           audit_event_id = ?, version = 2
       WHERE id = ?`,
    );

    const missingStatusId = identifier(1_711);
    const missingStatusDigest = reserve(missingStatusId);
    const missingStatusAudit = identifier(1_712);
    insertAudit(missingStatusId, missingStatusAudit, missingStatusDigest);
    assert.throws(
      () => transition.run(null, JSON.stringify({ bugId }), missingStatusAudit, missingStatusId),
      /CHECK constraint failed|terminal.*effect/i,
    );

    const missingResponseId = identifier(1_713);
    const missingResponseDigest = reserve(missingResponseId);
    const missingResponseAudit = identifier(1_714);
    insertAudit(missingResponseId, missingResponseAudit, missingResponseDigest);
    assert.throws(
      () => transition.run(201, null, missingResponseAudit, missingResponseId),
      /CHECK constraint failed|terminal.*effect/i,
    );

    const missingAuditId = identifier(1_715);
    reserve(missingAuditId);
    assert.throws(
      () => transition.run(201, JSON.stringify({ bugId }), null, missingAuditId),
      /CHECK constraint failed|terminal.*effect/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE idempotency_records
             SET idempotency_key = 'rewritten-reservation', version = 2
             WHERE id = ?`,
          )
          .run(missingAuditId),
      /idempotency identity.*immutable|idempotency record.*reservation|terminal.*effect/i,
    );

    const failedId = identifier(1_718);
    const failedDigest = reserve(failedId);
    const failedAudit = identifier(1_719);
    insertAudit(failedId, failedAudit, failedDigest);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE idempotency_records
             SET status = 'failed', http_status = 500,
                 response_json = '{"error":"upstream"}', audit_event_id = ?, version = 2
             WHERE id = ?`,
          )
          .run(failedAudit, failedId),
      /CHECK constraint failed|terminal.*effect/i,
    );
    database
      .prepare(
        `UPDATE idempotency_records
         SET status = 'failed', http_status = 500,
             response_json = '{"error":"upstream"}', version = 2
         WHERE id = ?`,
      )
      .run(failedId);

    const committedId = identifier(1_716);
    const committedDigest = reserve(committedId);
    const committedAudit = identifier(1_717);
    insertAudit(committedId, committedAudit, committedDigest);
    const response = JSON.stringify({
      operationId: "readBugList",
      projectId: tenant.projectId,
      bugId,
    });
    transition.run(201, response, committedAudit, committedId);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE idempotency_records
             SET response_json = '{"bugId":"rewritten"}', version = 3
             WHERE id = ?`,
          )
          .run(committedId),
      /idempotency identity.*immutable|terminal.*effect/i,
    );
    assert.throws(
      () => database.prepare("DELETE FROM idempotency_records WHERE id = ?").run(committedId),
      /idempotency effects.*append-only/i,
    );
    assert.equal(
      database
        .prepare("SELECT response_json FROM idempotency_records WHERE id = ?")
        .get(committedId)?.response_json,
      response,
    );
    assertIntegrity(database);
  });
});

test("Build lifecycle begins at version one, advances by CAS, and seals terminal facts", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 2_100, "BLD");
    const insertBuild = database.prepare(
      `INSERT INTO builds(
        id, account_id, project_id, provider, external_id, version_name, channel,
        project_key, branch, source_commit_sha, mode, status, manifest_json,
        manifest_digest, artifact_sha256, download_url, created_at, updated_at, version
      ) VALUES (
        ?, ?, ?, 'manual', ?, ?, 'qa', ?, 'main', ?, 'debug', 'validating', ?, ?, ?, ?, ?, ?, ?
      )`,
    );
    const insertValidatingBuild = (buildId: string, version: number): void => {
      const sequence = Number(buildId.slice(-12));
      insertBuild.run(
        buildId,
        tenant.accountId,
        tenant.projectId,
        `lifecycle-${sequence}`,
        `build-${sequence}`,
        tenant.projectKey,
        "a".repeat(40),
        JSON.stringify({ commits: ["a".repeat(40)] }),
        digest(sequence + 210_000),
        digest(sequence + 310_000),
        `https://example.invalid/builds/lifecycle-${sequence}.apk`,
        CREATED_AT,
        CREATED_AT,
        version,
      );
    };

    assert.throws(
      () => insertValidatingBuild(identifier(2_110), 2),
      /Build lifecycle must begin at version one/i,
    );

    const readyBuildId = identifier(2_111);
    insertValidatingBuild(readyBuildId, 1);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE builds
             SET status = 'building', updated_at = ?, version = 2
             WHERE id = ?`,
          )
          .run(UPDATED_AT, readyBuildId),
      /Build lifecycle requires a forward CAS transition/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE builds
             SET status = 'publishing', updated_at = ?, version = 1
             WHERE id = ?`,
          )
          .run(UPDATED_AT, readyBuildId),
      /Build lifecycle requires a forward CAS transition/i,
    );
    database
      .prepare(
        `UPDATE builds
         SET status = 'validating', updated_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(UPDATED_AT, readyBuildId);
    database
      .prepare(
        `UPDATE builds
         SET status = 'publishing', updated_at = ?, version = 3
         WHERE id = ?`,
      )
      .run(FINALIZED_AT, readyBuildId);
    database
      .prepare(
        `UPDATE builds
         SET status = 'ready', updated_at = '2026-08-25T00:03:00.000Z', version = 4
         WHERE id = ?`,
      )
      .run(readyBuildId);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE builds
             SET status = 'failed', updated_at = '2026-08-25T00:04:00.000Z', version = 5
             WHERE id = ?`,
          )
          .run(readyBuildId),
      /Build lifecycle requires a forward CAS transition/i,
    );

    const failedBuildId = identifier(2_112);
    insertValidatingBuild(failedBuildId, 1);
    database
      .prepare(
        `UPDATE builds
         SET status = 'failed', updated_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(UPDATED_AT, failedBuildId);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE builds
             SET status = 'failed', updated_at = ?, version = 3
             WHERE id = ?`,
          )
          .run(FINALIZED_AT, failedBuildId),
      /Build lifecycle requires a forward CAS transition/i,
    );
    assert.deepEqual(
      database
        .prepare("SELECT status, version FROM builds WHERE id IN (?, ?) ORDER BY id")
        .all(readyBuildId, failedBuildId)
        .map((row) => ({ ...row })),
      [
        { status: "ready", version: 4 },
        { status: "failed", version: 2 },
      ],
    );
    assertIntegrity(database);
  });
});

test("required BuildRequirement uses typed audits, manifest commit evidence, and its exact Verification Build", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 900, "BLD");
    const bugId = identifier(910);
    const attemptId = identifier(911);
    const deliveredCommitSha = "a".repeat(40);
    const unrelatedCommitSha = "b".repeat(40);
    createBug(database, tenant, bugId, "Exact build evidence Bug");
    insertRequiredRepairAttempt(database, tenant, bugId, attemptId, deliveredCommitSha);

    const unrelatedAuditEventId = identifier(912);
    const unrelatedRequirementId = identifier(913);
    database
      .prepare(
        `INSERT INTO events(
          id, account_id, project_id, bug_id, type, source, actor_type,
          aggregate_type, aggregate_id, aggregate_sequence, resource_type,
          resource_id, resource_version_after, correlation_id, payload_json, created_at
        ) VALUES (
          ?, ?, ?, ?, 'system.note', 'system', 'system', 'repair_attempt', ?, 1,
          'build_requirement', ?, 1, ?, '{"summary":"unrelated audit"}', ?
        )`,
      )
      .run(
        unrelatedAuditEventId,
        tenant.accountId,
        tenant.projectId,
        bugId,
        attemptId,
        unrelatedRequirementId,
        identifier(100_912),
        CREATED_AT,
      );
    assert.throws(
      () =>
        insertRequiredBuildRequirement(
          database,
          tenant,
          bugId,
          attemptId,
          unrelatedRequirementId,
          unrelatedAuditEventId,
          deliveredCommitSha,
        ),
      /exact typed delivery audit/i,
    );

    const deliveryAuditEventId = identifier(914);
    const requirementId = identifier(915);
    insertRequiredDeliveryAudit(
      database,
      tenant,
      bugId,
      attemptId,
      requirementId,
      deliveryAuditEventId,
      deliveredCommitSha,
      2,
    );
    insertRequiredBuildRequirement(
      database,
      tenant,
      bugId,
      attemptId,
      requirementId,
      deliveryAuditEventId,
      deliveredCommitSha,
    );

    const buildWithoutCommitId = identifier(916);
    const rejectedLinkId = identifier(917);
    const rejectedLinkAuditEventId = identifier(918);
    insertReadyBuild(database, tenant, buildWithoutCommitId, unrelatedCommitSha, [
      unrelatedCommitSha,
    ]);
    insertBuildLinkAudit(
      database,
      tenant,
      bugId,
      attemptId,
      buildWithoutCommitId,
      rejectedLinkId,
      rejectedLinkAuditEventId,
      deliveredCommitSha,
      3,
    );
    assert.throws(
      () =>
        linkRequiredBuild(
          database,
          tenant,
          bugId,
          attemptId,
          requirementId,
          buildWithoutCommitId,
          rejectedLinkId,
          rejectedLinkAuditEventId,
          deliveredCommitSha,
        ),
      /manifest evidence must contain the exact delivered commit|exact typed evidence audit/i,
    );
    const rolledBackRequirement = database
      .prepare(
        `SELECT version, linked_build_id AS linkedBuildId, link_id AS linkId
         FROM build_requirements WHERE id = ?`,
      )
      .get(requirementId);
    assert.equal(rolledBackRequirement?.version, 1);
    assert.equal(rolledBackRequirement?.linkedBuildId, null);
    assert.equal(rolledBackRequirement?.linkId, null);

    const exactBuildId = identifier(919);
    const exactLinkId = identifier(920);
    const exactLinkAuditEventId = identifier(921);
    insertReadyBuild(database, tenant, exactBuildId, deliveredCommitSha, [
      unrelatedCommitSha,
      deliveredCommitSha,
    ]);
    insertBuildLinkAudit(
      database,
      tenant,
      bugId,
      attemptId,
      exactBuildId,
      exactLinkId,
      exactLinkAuditEventId,
      deliveredCommitSha,
      4,
    );
    linkRequiredBuild(
      database,
      tenant,
      bugId,
      attemptId,
      requirementId,
      exactBuildId,
      exactLinkId,
      exactLinkAuditEventId,
      deliveredCommitSha,
    );

    const verificationError = /exact immutable BuildRequirement and repair link/i;
    assert.throws(
      () => insertVerificationForBuild(database, tenant, bugId, attemptId, identifier(922), null),
      verificationError,
    );
    assert.throws(
      () =>
        insertVerificationForBuild(
          database,
          tenant,
          bugId,
          attemptId,
          identifier(923),
          buildWithoutCommitId,
        ),
      verificationError,
    );
    insertVerificationForBuild(database, tenant, bugId, attemptId, identifier(924), exactBuildId);
    const exactVerification = database
      .prepare(
        `SELECT build_id AS buildId, repair_attempt_id AS repairAttemptId
         FROM verifications WHERE id = ?`,
      )
      .get(identifier(924));
    assert.equal(exactVerification?.buildId, exactBuildId);
    assert.equal(exactVerification?.repairAttemptId, attemptId);
    assert.throws(
      () =>
        database
          .prepare(
            `DELETE FROM build_manifest_commits
             WHERE build_id = ? AND commit_sha = ?`,
          )
          .run(exactBuildId, deliveredCommitSha),
      /linked build manifest.*(?:append-only|immutable|sealed)|Build manifest is sealed|exact commit evidence/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE builds
             SET status = 'failed', version = 2
             WHERE id = ?`,
          )
          .run(exactBuildId),
      /linked build.*immutable|Build (?:evidence.*append-only|facts referenced.*immutable)|exact commit evidence/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE builds
             SET status = 'failed', updated_at = ?, version = 3
             WHERE id = ?`,
          )
          .run(FINALIZED_AT, buildWithoutCommitId),
      /Build lifecycle requires a forward CAS transition/i,
    );
    assert.equal(
      database.prepare("SELECT status FROM builds WHERE id = ?").get(buildWithoutCommitId)?.status,
      "ready",
    );
    assertIntegrity(database);
  });
});

test("comments accept the frozen 20k contract limit without truncating 15k bodies", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 800, "CMT");
    const bugId = identifier(810);
    createBug(database, tenant, bugId, "Long comment Bug");
    const insertComment = database.prepare(
      `INSERT INTO comments(
        id, account_id, project_id, bug_id, author_id, body,
        client_submission_id, created_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    insertComment.run(
      identifier(811),
      tenant.accountId,
      tenant.projectId,
      bugId,
      tenant.userId,
      "x".repeat(15_000),
      identifier(812),
      CREATED_AT,
    );
    assert.equal(
      database
        .prepare("SELECT length(body) AS length FROM comments WHERE id = ?")
        .get(identifier(811))?.length,
      15_000,
    );
    assert.throws(
      () =>
        insertComment.run(
          identifier(813),
          tenant.accountId,
          tenant.projectId,
          bugId,
          tenant.userId,
          "y".repeat(20_001),
          identifier(814),
          CREATED_AT,
        ),
      /CHECK constraint failed/i,
    );
    assertIntegrity(database);
  });
});

test("Bug tenant, key, and reporter identity stay fixed while allowed content keeps FTS exact", async () => {
  await withDatabase((database) => {
    const tenantA = seedTenant(database, 1_200, "FTA");
    const tenantB = seedTenant(database, 1_300, "FTB");
    const bugId = identifier(1_210);
    createBug(database, tenantA, bugId, "Original searchable title");
    const casError = /Bug mutations require an exact optimistic-lock version CAS/i;
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE bugs
             SET title = 'Missing version bump', updated_at = ?
             WHERE id = ?`,
          )
          .run(UPDATED_AT, bugId),
      casError,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE bugs
             SET title = 'Skipped version', updated_at = ?, version = 3
             WHERE id = ?`,
          )
          .run(UPDATED_AT, bugId),
      casError,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE bugs
             SET title = 'Stale update timestamp', updated_at = created_at, version = 2
             WHERE id = ?`,
          )
          .run(bugId),
      casError,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE bugs
             SET state = 'invalid_state', updated_at = ?, version = 2
             WHERE id = ?`,
          )
          .run(UPDATED_AT, bugId),
      /CHECK constraint failed|Bug closure requires current passed human Verification|Bug state transition requires its exact typed human audit/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE bugs
             SET state = 'closed', closed_at = NULL, updated_at = ?, version = 2
             WHERE id = ?`,
          )
          .run(UPDATED_AT, bugId),
      /CHECK constraint failed|Bug closure requires current passed human Verification|Bug state transition requires its exact typed human audit/i,
    );
    const identityError = /Bug.*(?:tenant|identity|key|reporter).*immutable/i;
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE bugs
             SET account_id = ?, project_id = ?, key = 'FTB-99', reporter_id = ?,
                 updated_at = ?, version = 2
             WHERE id = ?`,
          )
          .run(tenantB.accountId, tenantB.projectId, tenantB.userId, UPDATED_AT, bugId),
      identityError,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE bugs SET id = ?, updated_at = ?, version = 2 WHERE id = ?")
          .run(identifier(1_211), UPDATED_AT, bugId),
      identityError,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE bugs SET number = 99, updated_at = ?, version = 2 WHERE id = ?")
          .run(UPDATED_AT, bugId),
      identityError,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE bugs SET key = 'FTA-999', updated_at = ?, version = 2 WHERE id = ?")
          .run(UPDATED_AT, bugId),
      identityError,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE bugs SET created_at = ?, updated_at = ?, version = 2 WHERE id = ?")
          .run(UPDATED_AT, UPDATED_AT, bugId),
      identityError,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE bugs SET reporter_id = ?, updated_at = ?, version = 2 WHERE id = ?")
          .run(tenantA.secondaryUserId, UPDATED_AT, bugId),
      identityError,
    );

    const ftsWriteBypasses: string[] = [];
    const expectFtsWriteRejected = (label: string, action: () => void): void => {
      const rejection = probeSqlRejection(database, action);
      if (rejection === undefined) {
        ftsWriteBypasses.push(label);
      } else {
        assert.match(String(rejection), /FTS|bugs_fts|not authorized|read-only/i);
      }
    };
    expectFtsWriteRejected("fabricated FTS row insert", () => {
      database
        .prepare(
          `INSERT INTO bugs_fts(
            rowid, account_id, project_id, bug_id, title, description, expected_behavior
          ) VALUES (999999, ?, ?, ?, 'Fabricated index row', 'not a Bug', 'not authoritative')`,
        )
        .run(tenantB.accountId, tenantB.projectId, identifier(1_399));
    });
    expectFtsWriteRejected("direct FTS row update", () => {
      database.prepare("UPDATE bugs_fts SET title = 'Forged title' WHERE bug_id = ?").run(bugId);
    });
    expectFtsWriteRejected("direct FTS row delete", () => {
      database.prepare("DELETE FROM bugs_fts WHERE bug_id = ?").run(bugId);
    });

    database
      .prepare(
        `UPDATE bugs
         SET title = 'Replacement searchable phrase',
             description = 'FTS follows allowed mutable Bug content',
             expected_behavior = 'The tenant projection remains exact',
             updated_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(UPDATED_AT, bugId);
    const bug = database
      .prepare(
        `SELECT account_id AS accountId, project_id AS projectId, key, reporter_id AS reporterId
         FROM bugs WHERE id = ?`,
      )
      .get(bugId);
    assert.equal(bug?.accountId, tenantA.accountId);
    assert.equal(bug?.projectId, tenantA.projectId);
    assert.equal(bug?.key, "FTA-1");
    assert.equal(bug?.reporterId, tenantA.userId);
    const fts = database
      .prepare(
        `SELECT account_id AS accountId, project_id AS projectId, bug_id AS bugId,
                title, description, expected_behavior AS expectedBehavior
         FROM bugs_fts
         WHERE bugs_fts MATCH 'Replacement' AND bug_id = ?`,
      )
      .get(bugId);
    assert.equal(fts?.accountId, tenantA.accountId);
    assert.equal(fts?.projectId, tenantA.projectId);
    assert.equal(fts?.bugId, bugId);
    assert.equal(fts?.title, "Replacement searchable phrase");
    assert.equal(fts?.description, "FTS follows allowed mutable Bug content");
    assert.equal(fts?.expectedBehavior, "The tenant projection remains exact");
    assert.deepEqual(ftsWriteBypasses, []);
    assertIntegrity(database);
  });
});

test("Occurrence environment Build references are generated, project-scoped, and optional", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 1_800, "OCA");
    const foreignTenant = seedTenant(database, 1_900, "OCB");
    const secondProjectId = identifier(1_810);
    const secondProject: TenantFixture = {
      ...tenant,
      projectId: secondProjectId,
      projectKey: "OC2",
    };
    database
      .prepare(
        `INSERT INTO projects(
          id, account_id, project_key, name, status, created_at, updated_at, version
        ) VALUES (?, ?, 'OC2', 'Other project', 'active', ?, ?, 1)`,
      )
      .run(secondProjectId, tenant.accountId, CREATED_AT, CREATED_AT);

    const exactBuildId = identifier(1_820);
    const foreignProjectBuildId = identifier(1_821);
    const foreignAccountBuildId = identifier(1_920);
    insertReadyBuild(database, tenant, exactBuildId, "d".repeat(40), ["d".repeat(40)]);
    insertReadyBuild(database, secondProject, foreignProjectBuildId, "e".repeat(40), [
      "e".repeat(40),
    ]);
    insertReadyBuild(database, foreignTenant, foreignAccountBuildId, "f".repeat(40), [
      "f".repeat(40),
    ]);
    const bugId = identifier(1_830);
    createBug(database, tenant, bugId, "Occurrence Build scope Bug");
    const insertOccurrenceWithEnvironment = database.prepare(
      `INSERT INTO occurrences(
        id, account_id, project_id, bug_id, reporter_id, client_submission_id,
        observed_at, platform, steps_json, actual_behavior, environment_json,
        created_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'android', '["Open the result"]',
        'The captured result differs', ?, ?, 1)`,
    );
    const insertOccurrenceEnvironment = (
      id: string,
      environment: Record<string, unknown> | null,
    ): void => {
      insertOccurrenceWithEnvironment.run(
        id,
        tenant.accountId,
        tenant.projectId,
        bugId,
        tenant.userId,
        identifier(Number(id.slice(-12)) + 10_000),
        CREATED_AT,
        environment === null ? null : JSON.stringify(environment),
        CREATED_AT,
      );
    };

    assert.throws(
      () => insertOccurrenceEnvironment(identifier(1_840), { buildId: identifier(9_999) }),
      /FOREIGN KEY constraint failed/i,
    );
    assert.throws(
      () => insertOccurrenceEnvironment(identifier(1_841), { buildId: foreignAccountBuildId }),
      /FOREIGN KEY constraint failed/i,
    );
    assert.throws(
      () => insertOccurrenceEnvironment(identifier(1_842), { buildId: foreignProjectBuildId }),
      /FOREIGN KEY constraint failed/i,
    );

    const exactOccurrenceId = identifier(1_843);
    const omittedOccurrenceId = identifier(1_844);
    const nullOccurrenceId = identifier(1_845);
    insertOccurrenceEnvironment(exactOccurrenceId, { buildId: exactBuildId });
    insertOccurrenceEnvironment(omittedOccurrenceId, {});
    insertOccurrenceEnvironment(nullOccurrenceId, { buildId: null });
    assert.equal(
      database.prepare("SELECT build_id FROM occurrences WHERE id = ?").get(exactOccurrenceId)
        ?.build_id,
      exactBuildId,
    );
    assert.equal(
      database.prepare("SELECT build_id FROM occurrences WHERE id = ?").get(omittedOccurrenceId)
        ?.build_id,
      null,
    );
    assert.equal(
      database.prepare("SELECT build_id FROM occurrences WHERE id = ?").get(nullOccurrenceId)
        ?.build_id,
      null,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE occurrences
             SET environment_json = ?, version = 2
             WHERE id = ?`,
          )
          .run(JSON.stringify({ buildId: null }), exactOccurrenceId),
      /Occurrence (?:Build lineage facts|evidence).*immutable/i,
    );
    assertIntegrity(database);
  });
});

test("disabled accounts are one-way exact-CAS principals and cannot mint native sessions", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_000, "ACA");
    const now = databaseTime(database);
    const installationId = identifier(5_010);
    database
      .prepare(
        `INSERT INTO device_installations(
          id, account_id, installation_id, platform, app_version,
          device_metadata_json, shared_device, first_seen_at, last_seen_at, version
        ) VALUES (?, ?, ?, 'android', '0.1.0-debug', '{}', 0, ?, ?, 1)`,
      )
      .run(installationId, tenant.accountId, identifier(5_011), now, now);

    database
      .prepare(
        `UPDATE accounts
         SET display_name = 'Renamed active account', updated_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(UPDATED_AT, tenant.accountId);
    assert.deepEqual(
      {
        ...database
          .prepare("SELECT display_name AS displayName, status, version FROM accounts WHERE id = ?")
          .get(tenant.accountId),
      },
      { displayName: "Renamed active account", status: "active", version: 2 },
    );

    const accepted: string[] = [];
    const expectRejected = (label: string, action: () => void): void => {
      const rejection = probeSqlRejection(database, action);
      if (rejection === undefined) {
        accepted.push(label);
      } else {
        assert.match(String(rejection), /account.*(?:CAS|disabled|one-way|transition|version)/i);
      }
    };
    expectRejected("account update omitted the successor version", () => {
      database
        .prepare("UPDATE accounts SET display_name = 'missing CAS', updated_at = ? WHERE id = ?")
        .run(FINALIZED_AT, tenant.accountId);
    });
    expectRejected("account update skipped a version", () => {
      database
        .prepare(
          "UPDATE accounts SET display_name = 'skipped CAS', updated_at = ?, version = 4 WHERE id = ?",
        )
        .run(FINALIZED_AT, tenant.accountId);
    });
    expectRejected("account update used a stale version", () => {
      database
        .prepare(
          "UPDATE accounts SET display_name = 'stale CAS', updated_at = ?, version = 1 WHERE id = ?",
        )
        .run(FINALIZED_AT, tenant.accountId);
    });

    database
      .prepare(
        `UPDATE accounts
         SET status = 'disabled', updated_at = ?, version = 3
         WHERE id = ?`,
      )
      .run(FINALIZED_AT, tenant.accountId);
    assert.throws(
      () => insertCurrentNativeSession(database, tenant, installationId, 5_020),
      /native session must start current, active, and at version one/i,
    );
    expectRejected("disabled account was reactivated", () => {
      database
        .prepare(
          `UPDATE accounts
           SET status = 'active', updated_at = '2026-08-25T00:03:00.000Z', version = 4
           WHERE id = ?`,
        )
        .run(tenant.accountId);
    });
    expectRejected("reactivated account minted a native session", () => {
      database
        .prepare(
          `UPDATE accounts
           SET status = 'active', updated_at = '2026-08-25T00:03:00.000Z', version = 4
           WHERE id = ?`,
        )
        .run(tenant.accountId);
      insertCurrentNativeSession(database, tenant, installationId, 5_021);
    });
    assert.deepEqual(accepted, []);
    assert.deepEqual(
      {
        ...database
          .prepare("SELECT status, version FROM accounts WHERE id = ?")
          .get(tenant.accountId),
      },
      { status: "disabled", version: 3 },
    );
    assertIntegrity(database);
  });
});

test("disabled users are one-way exact-CAS principals and cannot mint native sessions", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_100, "UCA");
    const now = databaseTime(database);
    const installationId = identifier(5_110);
    database
      .prepare(
        `INSERT INTO device_installations(
          id, account_id, installation_id, platform, app_version,
          device_metadata_json, shared_device, first_seen_at, last_seen_at, version
        ) VALUES (?, ?, ?, 'android', '0.1.0-debug', '{}', 0, ?, ?, 1)`,
      )
      .run(installationId, tenant.accountId, identifier(5_111), now, now);

    database
      .prepare(
        `UPDATE users
         SET display_name = 'Renamed active user', updated_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(UPDATED_AT, tenant.userId);
    assert.deepEqual(
      {
        ...database
          .prepare("SELECT display_name AS displayName, status, version FROM users WHERE id = ?")
          .get(tenant.userId),
      },
      { displayName: "Renamed active user", status: "active", version: 2 },
    );

    const accepted: string[] = [];
    const expectRejected = (label: string, action: () => void): void => {
      const rejection = probeSqlRejection(database, action);
      if (rejection === undefined) {
        accepted.push(label);
      } else {
        assert.match(String(rejection), /user.*(?:CAS|disabled|one-way|transition|version)/i);
      }
    };
    expectRejected("user update omitted the successor version", () => {
      database
        .prepare("UPDATE users SET display_name = 'missing CAS', updated_at = ? WHERE id = ?")
        .run(FINALIZED_AT, tenant.userId);
    });
    expectRejected("user update skipped a version", () => {
      database
        .prepare(
          "UPDATE users SET display_name = 'skipped CAS', updated_at = ?, version = 4 WHERE id = ?",
        )
        .run(FINALIZED_AT, tenant.userId);
    });
    expectRejected("user update used a stale version", () => {
      database
        .prepare(
          "UPDATE users SET display_name = 'stale CAS', updated_at = ?, version = 1 WHERE id = ?",
        )
        .run(FINALIZED_AT, tenant.userId);
    });

    database
      .prepare(
        `UPDATE users
         SET status = 'disabled', updated_at = ?, version = 3
         WHERE id = ?`,
      )
      .run(FINALIZED_AT, tenant.userId);
    assert.throws(
      () => insertCurrentNativeSession(database, tenant, installationId, 5_120),
      /native session must start current, active, and at version one/i,
    );
    expectRejected("disabled user was reactivated", () => {
      database
        .prepare(
          `UPDATE users
           SET status = 'active', updated_at = '2026-08-25T00:03:00.000Z', version = 4
           WHERE id = ?`,
        )
        .run(tenant.userId);
    });
    expectRejected("reactivated user minted a native session", () => {
      database
        .prepare(
          `UPDATE users
           SET status = 'active', updated_at = '2026-08-25T00:03:00.000Z', version = 4
           WHERE id = ?`,
        )
        .run(tenant.userId);
      insertCurrentNativeSession(database, tenant, installationId, 5_121);
    });
    assert.deepEqual(accepted, []);
    assert.deepEqual(
      { ...database.prepare("SELECT status, version FROM users WHERE id = ?").get(tenant.userId) },
      { status: "disabled", version: 3 },
    );
    assertIntegrity(database);
  });
});

test("revoked device installations are one-way exact-CAS facts and cannot mint native sessions", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_200, "DCA");
    const now = databaseTime(database);
    const installationId = identifier(5_210);
    database
      .prepare(
        `INSERT INTO device_installations(
          id, account_id, installation_id, platform, app_version,
          device_metadata_json, shared_device, first_seen_at, last_seen_at, version
        ) VALUES (?, ?, ?, 'android', '0.1.0-debug', '{}', 0, ?, ?, 1)`,
      )
      .run(installationId, tenant.accountId, identifier(5_211), now, now);

    database
      .prepare(
        `UPDATE device_installations
         SET app_version = '0.1.1-debug', last_seen_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(databaseTime(database, "+1 second"), installationId);
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT app_version AS appVersion, revoked_at AS revokedAt, version FROM device_installations WHERE id = ?",
          )
          .get(installationId),
      },
      { appVersion: "0.1.1-debug", revokedAt: null, version: 2 },
    );

    const accepted: string[] = [];
    const expectRejected = (label: string, action: () => void): void => {
      const rejection = probeSqlRejection(database, action);
      if (rejection === undefined) {
        accepted.push(label);
      } else {
        assert.match(
          String(rejection),
          /device installation.*(?:CAS|revok|one-way|transition|version)/i,
        );
      }
    };
    expectRejected("device update omitted the successor version", () => {
      database
        .prepare("UPDATE device_installations SET app_version = 'missing CAS' WHERE id = ?")
        .run(installationId);
    });
    expectRejected("device update skipped a version", () => {
      database
        .prepare(
          "UPDATE device_installations SET app_version = 'skipped CAS', version = 4 WHERE id = ?",
        )
        .run(installationId);
    });
    expectRejected("device update used a stale version", () => {
      database
        .prepare(
          "UPDATE device_installations SET app_version = 'stale CAS', version = 1 WHERE id = ?",
        )
        .run(installationId);
    });

    database
      .prepare(
        `UPDATE device_installations
         SET revoked_at = ?, version = 3
         WHERE id = ?`,
      )
      .run(databaseTime(database, "+2 seconds"), installationId);
    assert.throws(
      () => insertCurrentNativeSession(database, tenant, installationId, 5_220),
      /native session must start current, active, and at version one/i,
    );
    expectRejected("revoked installation cleared revoked_at", () => {
      database
        .prepare("UPDATE device_installations SET revoked_at = NULL, version = 4 WHERE id = ?")
        .run(installationId);
    });
    expectRejected("revived installation minted a native session", () => {
      database
        .prepare("UPDATE device_installations SET revoked_at = NULL, version = 4 WHERE id = ?")
        .run(installationId);
      insertCurrentNativeSession(database, tenant, installationId, 5_221);
    });
    assert.deepEqual(accepted, []);
    const revokedInstallation = database
      .prepare("SELECT revoked_at AS revokedAt, version FROM device_installations WHERE id = ?")
      .get(installationId);
    assert.equal(revokedInstallation?.version, 3);
    assert.equal(typeof revokedInstallation?.revokedAt, "string");
    assertIntegrity(database);
  });
});

test("native sessions require an active user and a non-revoked installation", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 3_000, "AUS");
    const now = databaseTime(database);
    const nowMs = Date.parse(now);
    const at = (offsetSeconds: number): string =>
      new Date(nowMs + offsetSeconds * 1_000).toISOString();
    const activeInstallationId = identifier(3_010);
    const revokedInstallationId = identifier(3_011);
    const insertInstallation = database.prepare(
      `INSERT INTO device_installations(
        id, account_id, installation_id, platform, app_version,
        device_metadata_json, shared_device, first_seen_at, last_seen_at,
        revoked_at, version
      ) VALUES (?, ?, ?, 'android', '0.1.0-debug', '{}', 0, ?, ?, ?, 1)`,
    );
    insertInstallation.run(
      activeInstallationId,
      tenant.accountId,
      identifier(3_012),
      now,
      now,
      null,
    );
    insertInstallation.run(
      revokedInstallationId,
      tenant.accountId,
      identifier(3_013),
      now,
      now,
      now,
    );
    database
      .prepare(
        `UPDATE users
         SET status = 'disabled', updated_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(UPDATED_AT, tenant.userId);

    const insertSession = database.prepare(
      `INSERT INTO native_sessions(
        id, account_id, user_id, installation_id, access_token_digest,
        shared_device, push_allowed, issued_at, access_expires_at,
        idle_expires_at, absolute_expires_at, last_seen_at, version
      ) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, 1)`,
    );
    const authSubjectError = /native session must start current, active, and at version one/i;
    assert.throws(
      () =>
        insertSession.run(
          identifier(3_014),
          tenant.accountId,
          tenant.userId,
          activeInstallationId,
          digest(3_014),
          now,
          at(900),
          at(3_600),
          at(86_400),
          now,
        ),
      authSubjectError,
    );
    assert.throws(
      () =>
        insertSession.run(
          identifier(3_015),
          tenant.accountId,
          tenant.secondaryUserId,
          revokedInstallationId,
          digest(3_015),
          now,
          at(900),
          at(3_600),
          at(86_400),
          now,
        ),
      authSubjectError,
    );
    assert.equal(database.prepare("SELECT count(*) AS count FROM native_sessions").get()?.count, 0);
    assertIntegrity(database);
  });
});

test("a refresh family cannot extend personal refresh lifetime beyond thirty days", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 3_100, "RFL");
    const auth = insertPersonalAuthFixture(database, tenant, 3_110);
    const familyMaxPlusOne = new Date(
      Date.parse(auth.familyCreatedAt) + 2_592_001 * 1_000,
    ).toISOString();
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO refresh_tokens(
              id, account_id, family_id, generation, token_digest, status,
              issued_at, expires_at, version
            ) VALUES (?, ?, ?, 2, ?, 'pending', ?, ?, 1)`,
          )
          .run(
            identifier(3_120),
            tenant.accountId,
            auth.familyId,
            digest(3_120),
            auth.now,
            familyMaxPlusOne,
          ),
      /refresh token must be the exact next generation of an active current family/i,
    );
    assert.equal(
      database
        .prepare("SELECT max(generation) AS generation FROM refresh_tokens WHERE family_id = ?")
        .get(auth.familyId)?.generation,
      1,
    );
    assertIntegrity(database);
  });
});

test("future-issued refresh tokens cannot be inserted", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 3_200, "FTI");
    const auth = insertPersonalAuthFixture(database, tenant, 3_210);
    const issuedInFiveMinutes = new Date(Date.parse(auth.now) + 5 * 60 * 1_000).toISOString();
    const expiresTomorrow = new Date(Date.parse(auth.now) + 24 * 60 * 60 * 1_000).toISOString();
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO refresh_tokens(
              id, account_id, family_id, generation, token_digest, status,
              issued_at, expires_at, version
            ) VALUES (?, ?, ?, 2, ?, 'pending', ?, ?, 1)`,
          )
          .run(
            identifier(3_220),
            tenant.accountId,
            auth.familyId,
            digest(3_220),
            issuedInFiveMinutes,
            expiresTomorrow,
          ),
      /refresh token must be the exact next generation of an active current family/i,
    );
    assertIntegrity(database);
  });
});

test("legacy future-issued refresh tokens cannot activate or consume early", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 3_300, "FTR");
    const activation = insertPersonalAuthFixture(database, tenant, 3_310);
    const consumption = insertPersonalAuthFixture(database, tenant, 3_320, {
      insertToken: false,
    });
    const futureIssuedAt = new Date(Date.parse(activation.now) + 5 * 60 * 1_000).toISOString();
    const futureExpiresAt = new Date(
      Date.parse(activation.now) + 24 * 60 * 60 * 1_000,
    ).toISOString();

    // Simulate rows written by a pre-hardening migration so transition guards remain
    // defense-in-depth even after new inserts reject future-issued credentials.
    database.exec("DROP TRIGGER refresh_tokens_initial_guard");
    const insertToken = database.prepare(
      `INSERT INTO refresh_tokens(
        id, account_id, family_id, generation, token_digest, status,
        issued_at, expires_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    const activationTokenId = identifier(3_330);
    insertToken.run(
      activationTokenId,
      tenant.accountId,
      activation.familyId,
      2,
      digest(3_330),
      "pending",
      futureIssuedAt,
      futureExpiresAt,
    );
    database
      .prepare(
        `UPDATE refresh_tokens
         SET status = 'consumed', consumed_at = ?, replaced_by_token_id = ?,
             replaced_by_family_id = ?, replaced_by_generation = 2, version = 2
         WHERE id = ?`,
      )
      .run(activation.now, activationTokenId, activation.familyId, activation.tokenId);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE refresh_tokens
             SET status = 'active', version = 2
             WHERE id = ?`,
          )
          .run(activationTokenId),
      /refresh token state is one-way with exact CAS versioning/i,
    );

    insertToken.run(
      consumption.tokenId,
      tenant.accountId,
      consumption.familyId,
      1,
      digest(3_323),
      "active",
      futureIssuedAt,
      futureExpiresAt,
    );
    const replacementId = identifier(3_331);
    insertToken.run(
      replacementId,
      tenant.accountId,
      consumption.familyId,
      2,
      digest(3_331),
      "pending",
      futureIssuedAt,
      futureExpiresAt,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE refresh_tokens
             SET status = 'consumed', consumed_at = ?, replaced_by_token_id = ?,
                 replaced_by_family_id = ?, replaced_by_generation = 2, version = 2
             WHERE id = ?`,
          )
          .run(consumption.now, replacementId, consumption.familyId, consumption.tokenId),
      /refresh token state is one-way with exact CAS versioning/i,
    );
    assertIntegrity(database);
  });
});

test("auth secret replay versions match the committed session and active effect token", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 3_400, "ASR");
    const auth = insertPersonalAuthFixture(database, tenant, 3_410);
    const expiresAt = new Date(Date.parse(auth.now) + 300 * 1_000).toISOString();
    const insertReplay = database.prepare(
      `INSERT INTO auth_secret_replays(
        id, account_id, actor_id, installation_id, session_id,
        refresh_family_id, action, operation_id, scope_digest,
        idempotency_key_digest, request_hmac, response_ciphertext,
        response_secret_hmac, encryption_key_version, effect_session_version,
        effect_token_generation, effect_committed, mutation_count,
        consumed_at, created_at, expires_at, version
      ) VALUES (
        ?, ?, ?, ?, ?, ?, 'native_login', 'createNativeSession', ?, ?, ?, ?, ?,
        1, ?, ?, 1, 1, NULL, ?, ?, 1
      )`,
    );
    const runReplay = (id: string, sessionVersion: number, tokenGeneration: number): void => {
      const sequence = Number(id.slice(-12));
      insertReplay.run(
        id,
        tenant.accountId,
        tenant.userId,
        auth.installationId,
        auth.sessionId,
        auth.familyId,
        digest(sequence + 1),
        digest(sequence + 2),
        digest(sequence + 3),
        `encrypted-auth-response-${sequence}`,
        digest(sequence + 4),
        sessionVersion,
        tokenGeneration,
        auth.now,
        expiresAt,
      );
    };
    const effectError =
      /auth replay snapshot must bind the exact current session and refresh effect/i;
    assert.throws(() => runReplay(identifier(3_420), 2, 1), effectError);
    assert.throws(() => runReplay(identifier(3_421), 1, 2), effectError);
    runReplay(identifier(3_422), 1, 1);
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM auth_secret_replays").get()?.count,
      1,
    );
    assertIntegrity(database);
  });
});

test("generic idempotency rejects native auth operations and recursively nested secrets", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 3_500, "GID");
    const now = databaseTime(database);
    const expiresAt = new Date(Date.parse(now) + 24 * 60 * 60 * 1_000).toISOString();
    const insertReservation = database.prepare(
      `INSERT INTO idempotency_records(
        id, account_id, project_id, actor_id, operation_id, idempotency_key,
        scope_digest, scope_json, request_digest, status, http_status,
        response_json, audit_event_id, created_at, expires_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, NULL, NULL, ?, ?, 1)`,
    );
    const reserve = (id: string, operationId: string, scope: unknown): void => {
      const sequence = Number(id.slice(-12));
      insertReservation.run(
        id,
        tenant.accountId,
        tenant.projectId,
        tenant.userId,
        operationId,
        `generic-idempotency-${sequence}`,
        digest(sequence + 10_000),
        JSON.stringify(scope),
        digest(sequence + 20_000),
        now,
        expiresAt,
      );
    };
    const authOperationError =
      /idempotency record must begin as an effect-free non-secret reservation/i;
    assert.throws(
      () => reserve(identifier(3_510), "createNativeSession", { projectId: tenant.projectId }),
      authOperationError,
    );
    assert.throws(
      () => reserve(identifier(3_511), "refreshNativeSession", { projectId: tenant.projectId }),
      authOperationError,
    );
    const sensitiveKeys = [
      "accessToken",
      "refreshToken",
      "token",
      "passwd",
      "password",
      "secret",
      "authorization",
      "cookie",
      "credential",
      "email",
      "phone",
      "session",
      "apiKey",
      "api_key",
      "x-api-key",
    ] as const;
    const privacyBypasses: string[] = [];
    const scopeSecretError = /generic idempotency scope must not persist authentication secrets/i;
    sensitiveKeys.forEach((key, offset) => {
      const rejection = probeSqlRejection(database, () => {
        reserve(identifier(30_000 + offset), "createBug", {
          projectId: tenant.projectId,
          nested: { collection: [{ inner: { [key]: "must-not-persist" } }] },
        });
      });
      if (rejection === undefined) {
        privacyBypasses.push(`scope:${key}`);
      } else {
        assert.match(String(rejection), scopeSecretError);
      }
    });

    const committedId = identifier(3_530);
    const requestDigest = digest(23_530);
    insertReservation.run(
      committedId,
      tenant.accountId,
      tenant.projectId,
      tenant.userId,
      "readBugList",
      "safe-reservation",
      digest(13_530),
      JSON.stringify({
        projectId: tenant.projectId,
        nested: { collection: [{ severity: "S2", metadata: { build: "qa" } }] },
      }),
      requestDigest,
      now,
      expiresAt,
    );
    const auditEventId = identifier(3_531);
    database
      .prepare(
        `INSERT INTO events(
          id, account_id, project_id, type, source, actor_type, actor_user_id,
          aggregate_type, aggregate_id, aggregate_sequence, resource_type,
          resource_id, resource_version_after, request_digest, correlation_id,
          payload_json, created_at
        ) VALUES (
          ?, ?, ?, 'idempotency.committed', 'qa_hub', 'user', ?,
          'idempotency_record', ?, 1, 'idempotency_record', ?, 2, ?, ?,
          '{"status":"committed"}', ?
        )`,
      )
      .run(
        auditEventId,
        tenant.accountId,
        tenant.projectId,
        tenant.userId,
        committedId,
        committedId,
        requestDigest,
        identifier(103_531),
        now,
      );
    const commit = database.prepare(
      `UPDATE idempotency_records
       SET status = 'committed', http_status = 201,
           response_json = ?, audit_event_id = ?, version = 2
       WHERE id = ?`,
    );
    const responseSecretError =
      /generic idempotency response must not persist authentication secrets/i;
    sensitiveKeys.forEach((key) => {
      const rejection = probeSqlRejection(database, () => {
        commit.run(
          JSON.stringify({ result: { nested: [{ inner: { [key]: "must-not-persist" } }] } }),
          auditEventId,
          committedId,
        );
      });
      if (rejection === undefined) {
        privacyBypasses.push(`response:${key}`);
      } else {
        assert.match(String(rejection), responseSecretError);
      }
    });
    const safeResponse = JSON.stringify({
      result: { nested: [{ qaItemId: identifier(3_532), state: "reported" }] },
    });
    commit.run(safeResponse, auditEventId, committedId);
    assert.equal(
      database
        .prepare("SELECT response_json FROM idempotency_records WHERE id = ?")
        .get(committedId)?.response_json,
      safeResponse,
    );
    assert.deepEqual(privacyBypasses, []);
    assertIntegrity(database);
  });
});

test("committed generic idempotency replays the exact immutable typed submission effect", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_600, "IGE");
    const bugId = identifier(5_610);
    const nonexistentBugId = identifier(5_611);
    const submissionId = identifier(5_612);
    const clientSubmissionId = identifier(5_613);
    const recordId = identifier(5_614);
    const eventId = identifier(5_615);
    const requestDigest = digest(5_614);
    createBug(database, tenant, bugId, "Exact idempotency effect Bug");
    const exactResponse = JSON.stringify({
      clientSubmissionId,
      projectId: tenant.projectId,
      bugId,
      occurrenceId: null,
      commentId: null,
      verificationId: null,
      captureBundleId: null,
    });
    database
      .prepare(
        `INSERT INTO submissions(
          id, account_id, project_id, actor_id, client_submission_id, intent,
          payload_digest, bug_id, occurrence_id, comment_id, verification_id,
          capture_bundle_id, response_json, committed_at, version
        ) VALUES (?, ?, ?, ?, ?, 'bug_create', ?, ?, NULL, NULL, NULL, NULL, ?, ?, 1)`,
      )
      .run(
        submissionId,
        tenant.accountId,
        tenant.projectId,
        tenant.userId,
        clientSubmissionId,
        requestDigest,
        bugId,
        exactResponse,
        CREATED_AT,
      );
    const now = databaseTime(database);
    const expiresAt = databaseTime(database, "+1 day");
    const insertReservation = database.prepare(
      `INSERT INTO idempotency_records(
        id, account_id, project_id, actor_id, operation_id, idempotency_key,
        scope_digest, scope_json, request_digest, status, http_status,
        response_json, audit_event_id, created_at, expires_at, version
      ) VALUES (?, ?, ?, ?, 'createBug', ?, ?, ?, ?, 'reserved',
        NULL, NULL, NULL, ?, ?, 1)`,
    );
    insertReservation.run(
      recordId,
      tenant.accountId,
      tenant.projectId,
      tenant.userId,
      "exact-create-bug-effect",
      digest(15_614),
      JSON.stringify({ projectId: tenant.projectId, clientSubmissionId }),
      requestDigest,
      now,
      expiresAt,
    );
    database
      .prepare(
        `INSERT INTO events(
          id, account_id, project_id, bug_id, type, source, actor_type,
          actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
          resource_type, resource_id, resource_version_after, request_digest,
          correlation_id, payload_json, created_at
        ) VALUES (
          ?, ?, ?, ?, 'idempotency.committed', 'qa_hub', 'user', ?,
          'idempotency_record', ?, 1, 'idempotency_record', ?, 2, ?, ?, ?, ?
        )`,
      )
      .run(
        eventId,
        tenant.accountId,
        tenant.projectId,
        bugId,
        tenant.userId,
        recordId,
        recordId,
        requestDigest,
        identifier(105_615),
        JSON.stringify({
          status: "committed",
          relatedBugId: bugId,
        }),
        now,
      );
    const commit = database.prepare(
      `UPDATE idempotency_records
       SET status = 'committed', http_status = 201, response_json = ?,
           audit_event_id = ?, version = 2
       WHERE id = ?`,
    );
    const wrongEffectResponse = JSON.stringify({
      clientSubmissionId,
      projectId: tenant.projectId,
      bugId: nonexistentBugId,
      occurrenceId: null,
      commentId: null,
      verificationId: null,
      captureBundleId: null,
    });
    const wrongEffect = probeSqlRejection(database, () => {
      commit.run(wrongEffectResponse, eventId, recordId);
    });
    assert.notEqual(wrongEffect, undefined, "committed replay named a nonexistent Bug effect");
    assert.match(String(wrongEffect), /idempotency.*(?:submission|effect|response|receipt|exact)/i);
    const reorderedExactResponse = JSON.stringify({
      bugId,
      projectId: tenant.projectId,
      clientSubmissionId,
      occurrenceId: null,
      commentId: null,
      verificationId: null,
      captureBundleId: null,
    });
    const reorderedEffect = probeSqlRejection(database, () => {
      commit.run(reorderedExactResponse, eventId, recordId);
    });
    assert.notEqual(
      reorderedEffect,
      undefined,
      "committed replay did not preserve the immutable submission response bytes",
    );
    assert.match(
      String(reorderedEffect),
      /idempotency.*(?:submission|effect|response|receipt|exact)/i,
    );
    commit.run(exactResponse, eventId, recordId);
    assert.equal(
      database.prepare("SELECT response_json FROM idempotency_records WHERE id = ?").get(recordId)
        ?.response_json,
      exactResponse,
    );

    const failedRecordId = identifier(5_620);
    insertReservation.run(
      failedRecordId,
      tenant.accountId,
      tenant.projectId,
      tenant.userId,
      "failed-without-submission",
      digest(15_620),
      JSON.stringify({ projectId: tenant.projectId, operation: "validation" }),
      digest(5_620),
      now,
      expiresAt,
    );
    const fail = database.prepare(
      `UPDATE idempotency_records
       SET status = 'failed', http_status = 422, response_json = ?, version = 2
       WHERE id = ?`,
    );
    assert.throws(
      () => fail.run(JSON.stringify(["response-must-be-an-object"]), failedRecordId),
      /CHECK constraint failed|terminal.*effect/i,
    );
    assert.throws(
      () => fail.run(JSON.stringify({ error: { token: "must-not-persist" } }), failedRecordId),
      /generic idempotency response must not persist authentication secrets/i,
    );
    const safeFailureResponse = JSON.stringify({
      error: { code: "VALIDATION_FAILED", details: [{ field: "title", issue: "required" }] },
    });
    fail.run(safeFailureResponse, failedRecordId);
    assert.equal(
      database
        .prepare("SELECT response_json FROM idempotency_records WHERE id = ?")
        .get(failedRecordId)?.response_json,
      safeFailureResponse,
    );
    assertIntegrity(database);
  });
});

test("idempotency and upload leases anchor initial TTLs to the server clock", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_700, "TTL");
    const insertReservation = database.prepare(
      `INSERT INTO idempotency_records(
        id, account_id, project_id, actor_id, operation_id, idempotency_key,
        scope_digest, scope_json, request_digest, status, http_status,
        response_json, audit_event_id, created_at, expires_at, version
      ) VALUES (?, ?, ?, ?, 'readBugList', ?, ?, ?, ?, 'reserved',
        NULL, NULL, NULL, ?, ?, 1)`,
    );
    const reserve = (sequence: number, createdAt: string, expiresAt: string): void => {
      insertReservation.run(
        identifier(sequence),
        tenant.accountId,
        tenant.projectId,
        tenant.userId,
        `ttl-${sequence}`,
        digest(sequence + 10_000),
        JSON.stringify({ projectId: tenant.projectId, page: sequence }),
        digest(sequence + 20_000),
        createdAt,
        expiresAt,
      );
    };
    const reservationNow = databaseTime(database);
    reserve(5_710, reservationNow, databaseTime(database, "+30 days"));
    assert.throws(
      () =>
        reserve(
          5_711,
          databaseTime(database),
          new Date(Date.now() + 2_592_001 * 1_000).toISOString(),
        ),
      /idempotency.*(?:server|clock|TTL|lease|expiry|effect-free|reservation)|CHECK constraint failed/i,
    );
    const futureReservation = probeSqlRejection(database, () => {
      reserve(5_712, "2100-01-01T00:00:00.000Z", "2100-01-02T00:00:00.000Z");
    });
    assert.notEqual(futureReservation, undefined, "future-anchored idempotency lease was accepted");
    assert.match(
      String(futureReservation),
      /idempotency.*(?:server|clock|TTL|lease|initial|reservation)/i,
    );

    const insertUploadLease = database.prepare(
      `INSERT INTO upload_sessions(
        id, account_id, project_id, actor_id, client_submission_id,
        client_attachment_id, capture_id, upload_attempt, file_name, media_type,
        expected_size_bytes, expected_sha256, received_size_bytes,
        chunk_size_bytes, expected_chunk_count, generation, status,
        expires_at, created_at, updated_at, version
      ) VALUES (
        ?, ?, ?, ?, ?, ?, NULL, 1, ?, 'image/png', ?, ?, 0,
        262144, 1, 1, 'open', ?, ?, ?, 1
      )`,
    );
    const insertUpload = (sequence: number, createdAt: string, expiresAt: string): void => {
      const sizeBytes = 1_024 + sequence;
      insertUploadLease.run(
        identifier(sequence),
        tenant.accountId,
        tenant.projectId,
        tenant.userId,
        identifier(sequence + 100_000),
        identifier(sequence + 200_000),
        `ttl-${sequence}.png`,
        sizeBytes,
        digest(sequence),
        expiresAt,
        createdAt,
        createdAt,
      );
    };
    const uploadNow = databaseTime(database);
    insertUpload(5_720, uploadNow, databaseTime(database, "+1 hour"));
    assert.throws(
      () =>
        insertUpload(
          5_721,
          databaseTime(database),
          new Date(Date.now() + 3_601 * 1_000).toISOString(),
        ),
      /upload session must start as the exact next unexpired empty lease attempt/i,
    );
    assert.throws(
      () => insertUpload(5_722, "2100-01-01T00:00:00.000Z", "2100-01-01T00:30:00.000Z"),
      /upload session must start as the exact next unexpired empty lease attempt/i,
    );
    assertIntegrity(database);
  });
});

test("service principals are one-way CAS facts and external events name their exact resources", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 3_600, "SPR");
    const bugId = identifier(3_610);
    const attemptId = identifier(3_611);
    const buildId = identifier(3_612);
    createBug(database, tenant, bugId, "Principal authority Bug");
    insertRepairAttempt(database, tenant, bugId, attemptId, 1, "running", "relay");
    insertReadyBuild(database, tenant, buildId, "a".repeat(40), ["a".repeat(40)]);
    const lifecyclePrincipalId = identifier(3_620);
    const relayPrincipalId = identifier(3_621);
    const buildPrincipalId = identifier(3_622);
    const insertPrincipal = database.prepare(
      `INSERT INTO service_principals(
        id, account_id, name, principal_type, credential_digest,
        status, created_at, version
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, 1)`,
    );
    insertPrincipal.run(
      lifecyclePrincipalId,
      tenant.accountId,
      "Lifecycle principal",
      "worker",
      digest(3_620),
      CREATED_AT,
    );
    insertPrincipal.run(
      relayPrincipalId,
      tenant.accountId,
      "Relay exact resource",
      "relay",
      digest(3_621),
      CREATED_AT,
    );
    insertPrincipal.run(
      buildPrincipalId,
      tenant.accountId,
      "Build exact resource",
      "build_provider",
      digest(3_622),
      CREATED_AT,
    );
    const lifecycleError = /service principal revocation is a one-way CAS transition/i;
    database
      .prepare(
        `UPDATE service_principals
         SET status = 'revoked', revoked_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(databaseTime(database), lifecyclePrincipalId);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE service_principals
             SET status = 'active', revoked_at = NULL, version = 3
             WHERE id = ?`,
          )
          .run(lifecyclePrincipalId),
      lifecycleError,
    );
    assert.throws(
      () =>
        database.prepare("DELETE FROM service_principals WHERE id = ?").run(lifecyclePrincipalId),
      /service principal credential history is append-only/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE service_principals
             SET status = 'revoked', revoked_at = ?, version = 3
             WHERE id = ?`,
          )
          .run(databaseTime(database), relayPrincipalId),
      lifecycleError,
    );

    const insertExternalEvent = database.prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_service_principal_id, aggregate_type, aggregate_id,
        aggregate_sequence, resource_type, resource_id, resource_version_after,
        correlation_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'service', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    );
    const exactResourceError =
      /external event source requires its exact active principal and typed resource/i;
    assert.throws(
      () =>
        insertExternalEvent.run(
          identifier(3_630),
          tenant.accountId,
          tenant.projectId,
          bugId,
          "repair.running",
          "relay",
          relayPrincipalId,
          "repair_attempt",
          attemptId,
          1,
          "bug",
          bugId,
          identifier(103_630),
          JSON.stringify({ status: "running", repairAttemptId: attemptId }),
          CREATED_AT,
        ),
      exactResourceError,
    );
    insertExternalEvent.run(
      identifier(3_631),
      tenant.accountId,
      tenant.projectId,
      bugId,
      "repair.running",
      "relay",
      relayPrincipalId,
      "repair_attempt",
      attemptId,
      1,
      "repair_attempt",
      attemptId,
      identifier(103_631),
      JSON.stringify({ status: "running", repairAttemptId: attemptId }),
      CREATED_AT,
    );
    assert.throws(
      () =>
        insertExternalEvent.run(
          identifier(3_632),
          tenant.accountId,
          tenant.projectId,
          bugId,
          "build.pending",
          "build",
          buildPrincipalId,
          "build",
          buildId,
          1,
          "repair_attempt",
          attemptId,
          identifier(103_632),
          JSON.stringify({ status: "pending", buildId }),
          CREATED_AT,
        ),
      exactResourceError,
    );
    insertExternalEvent.run(
      identifier(3_633),
      tenant.accountId,
      tenant.projectId,
      null,
      "build.pending",
      "build",
      buildPrincipalId,
      "build",
      buildId,
      1,
      "build",
      buildId,
      identifier(103_633),
      JSON.stringify({ status: "pending", buildId }),
      CREATED_AT,
    );
    database
      .prepare(
        `UPDATE accounts
         SET status = 'disabled', updated_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(UPDATED_AT, tenant.accountId);
    assert.throws(
      () =>
        insertExternalEvent.run(
          identifier(3_634),
          tenant.accountId,
          tenant.projectId,
          bugId,
          "repair.running",
          "relay",
          relayPrincipalId,
          "repair_attempt",
          attemptId,
          2,
          "repair_attempt",
          attemptId,
          identifier(103_634),
          JSON.stringify({ status: "running", repairAttemptId: attemptId }),
          UPDATED_AT,
        ),
      /external event.*(?:active account|authority|principal)/i,
    );
    assertIntegrity(database);
  });
});

test("comments are append-only identity facts and cannot bypass version CAS", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 3_700, "CIM");
    const otherTenant = seedTenant(database, 3_800, "CI2");
    const bugId = identifier(3_710);
    const siblingBugId = identifier(3_711);
    const otherBugId = identifier(3_810);
    createBug(database, tenant, bugId, "Immutable comment Bug");
    createBug(database, tenant, siblingBugId, "Sibling comment Bug");
    createBug(database, otherTenant, otherBugId, "Foreign comment Bug");
    const commentId = identifier(3_720);
    const clientSubmissionId = identifier(3_721);
    database
      .prepare(
        `INSERT INTO comments(
          id, account_id, project_id, bug_id, author_id, body,
          client_submission_id, created_at, version
        ) VALUES (?, ?, ?, ?, ?, 'Original immutable comment', ?, ?, 1)`,
      )
      .run(
        commentId,
        tenant.accountId,
        tenant.projectId,
        bugId,
        tenant.userId,
        clientSubmissionId,
        CREATED_AT,
      );
    const immutableError = /comments are immutable; corrections require an appended comment/i;
    assert.throws(
      () =>
        database
          .prepare("UPDATE comments SET id = ? WHERE id = ?")
          .run(identifier(3_722), commentId),
      immutableError,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE comments
             SET account_id = ?, project_id = ?, bug_id = ?, author_id = ?
             WHERE id = ?`,
          )
          .run(
            otherTenant.accountId,
            otherTenant.projectId,
            otherBugId,
            otherTenant.userId,
            commentId,
          ),
      immutableError,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE comments SET bug_id = ? WHERE id = ?")
          .run(siblingBugId, commentId),
      immutableError,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE comments SET author_id = ? WHERE id = ?")
          .run(tenant.secondaryUserId, commentId),
      immutableError,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE comments SET client_submission_id = ? WHERE id = ?")
          .run(identifier(3_723), commentId),
      immutableError,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE comments SET created_at = ? WHERE id = ?")
          .run(UPDATED_AT, commentId),
      immutableError,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE comments SET body = 'Edited body', version = 2 WHERE id = ?")
          .run(commentId),
      immutableError,
    );
    assert.throws(
      () => database.prepare("UPDATE comments SET version = 3 WHERE id = ?").run(commentId),
      immutableError,
    );
    assert.throws(
      () => database.prepare("DELETE FROM comments WHERE id = ?").run(commentId),
      /comments are append-only/i,
    );
    assert.deepEqual(
      { ...database.prepare("SELECT body, version FROM comments WHERE id = ?").get(commentId) },
      { body: "Original immutable comment", version: 1 },
    );
    assertIntegrity(database);
  });
});

test("upload attempts serialize one current tuple and advance by exactly one after terminal", async () => {
  await withDatabase(async (database) => {
    const tenant = seedTenant(database, 3_900, "UAT");
    const fixture = uploadFixture(tenant, 3_910);
    const insertAttempt = database.prepare(
      `INSERT INTO upload_sessions(
        id, account_id, project_id, actor_id, client_submission_id,
        client_attachment_id, capture_id, upload_attempt, file_name, media_type,
        expected_size_bytes, expected_sha256, received_size_bytes,
        chunk_size_bytes, expected_chunk_count, generation, status,
        expires_at, created_at, updated_at, version
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
        262144, 1, 1, 'open', ?, ?, ?, 1
      )`,
    );
    const insert = (id: string, attempt: number, createdAt: string, expiresAt: string): void => {
      insertAttempt.run(
        id,
        tenant.accountId,
        tenant.projectId,
        fixture.actorId,
        fixture.clientSubmissionId,
        fixture.clientAttachmentId,
        fixture.captureId,
        attempt,
        fixture.fileName,
        fixture.mediaType,
        fixture.sizeBytes,
        fixture.digest,
        expiresAt,
        createdAt,
        createdAt,
      );
    };
    const firstCreatedAt = databaseTime(database);
    const firstExpiresAt = new Date(Date.parse(firstCreatedAt) + 1_000).toISOString();
    insert(fixture.uploadId, 1, firstCreatedAt, firstExpiresAt);
    const attemptError =
      /upload session must start as the exact next unexpired empty lease attempt/i;
    const concurrentCreatedAt = databaseTime(database);
    assert.throws(
      () =>
        insert(
          identifier(3_920),
          2,
          concurrentCreatedAt,
          new Date(Date.parse(concurrentCreatedAt) + 60 * 60 * 1_000).toISOString(),
        ),
      attemptError,
    );

    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, Date.parse(firstExpiresAt) - Date.now() + 1_100));
    });
    database
      .prepare(
        `UPDATE upload_sessions
         SET status = 'expired', updated_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(databaseTime(database), fixture.uploadId);
    const retryCreatedAt = databaseTime(database);
    const retryExpiresAt = new Date(Date.parse(retryCreatedAt) + 60 * 60 * 1_000).toISOString();
    assert.throws(() => insert(identifier(3_921), 3, retryCreatedAt, retryExpiresAt), attemptError);
    const secondAttemptId = identifier(3_922);
    insert(secondAttemptId, 2, retryCreatedAt, retryExpiresAt);
    assert.throws(
      () => insert(identifier(3_923), 3, databaseTime(database), databaseTime(database, "+1 hour")),
      attemptError,
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT upload_attempt AS uploadAttempt, status
           FROM upload_sessions
           WHERE actor_id = ? AND client_submission_id = ? AND client_attachment_id = ?
           ORDER BY upload_attempt`,
        )
        .all(fixture.actorId, fixture.clientSubmissionId, fixture.clientAttachmentId)
        .map((row) => ({ ...row })),
      [
        { uploadAttempt: 1, status: "expired" },
        { uploadAttempt: 2, status: "open" },
      ],
    );
    assertIntegrity(database);
  });
});

test("capture artifacts transition from pending through exact attachment CAS and then seal", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 4_000, "CAT");
    const bundleId = identifier(4_010);
    const captureId = identifier(4_011);
    const clientSubmissionId = identifier(4_012);
    const primary = insertCaptureBundle(database, tenant, bundleId, captureId, clientSubmissionId);
    const secondary = uploadFixture(tenant, 140_000, {
      captureId,
      clientSubmissionId,
      mediaType: "image/png",
    });
    insertUpload(database, tenant, secondary);
    insertBlob(database, tenant, secondary);
    insertAttachment(database, tenant, secondary);
    finalizeUpload(database, secondary.uploadId, secondary.attachmentId);

    const artifactId = identifier(4_013);
    database
      .prepare(
        `INSERT INTO capture_artifacts(
          id, account_id, project_id, capture_bundle_id, capture_id,
          client_attachment_id, attachment_id, artifact_type, status, skew_ms,
          truncated, failure_reason, metadata_json, started_at, ended_at,
          created_at, version
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'system_screenshot', 'pending', 0,
          0, NULL, '{}', ?, NULL, ?, 1)`,
      )
      .run(
        artifactId,
        tenant.accountId,
        tenant.projectId,
        bundleId,
        captureId,
        CREATED_AT,
        CREATED_AT,
      );
    const transitionError =
      /capture artifact pending transition requires exact attachment identity and CAS/i;
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE capture_artifacts
             SET client_attachment_id = ?, attachment_id = ?, status = 'succeeded',
                 ended_at = ?, version = 2
             WHERE id = ?`,
          )
          .run(primary.clientAttachmentId, secondary.attachmentId, UPDATED_AT, artifactId),
      transitionError,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE capture_artifacts
             SET client_attachment_id = ?, attachment_id = ?, status = 'succeeded',
                 ended_at = ?, version = 3
             WHERE id = ?`,
          )
          .run(primary.clientAttachmentId, primary.attachmentId, UPDATED_AT, artifactId),
      transitionError,
    );
    database
      .prepare(
        `UPDATE capture_artifacts
         SET client_attachment_id = ?, attachment_id = ?, status = 'succeeded',
             ended_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(primary.clientAttachmentId, primary.attachmentId, UPDATED_AT, artifactId);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE capture_artifacts
             SET metadata_json = '{"rewritten":true}', version = 3
             WHERE id = ?`,
          )
          .run(artifactId),
      /capture artifact pending transition requires exact attachment identity and CAS/i,
    );
    assert.throws(
      () => database.prepare("DELETE FROM capture_artifacts WHERE id = ?").run(artifactId),
      /capture artifact attempt history is append-only/i,
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT client_attachment_id AS clientAttachmentId,
                    attachment_id AS attachmentId, status, version
             FROM capture_artifacts WHERE id = ?`,
          )
          .get(artifactId),
      },
      {
        clientAttachmentId: primary.clientAttachmentId,
        attachmentId: primary.attachmentId,
        status: "succeeded",
        version: 2,
      },
    );
    assertIntegrity(database);
  });
});

test("forward v3 rejects typed Build facts from disabled or archived principals", async () => {
  const inactivePrincipalCases: readonly {
    readonly label: string;
    readonly mutate: (database: DatabaseSync, tenant: TenantFixture, updatedAt: string) => void;
  }[] = [
    {
      label: "disabled User",
      mutate: (database, tenant, updatedAt) => {
        const result = database
          .prepare(
            `UPDATE users SET status = 'disabled', updated_at = ?, version = 2
             WHERE id = ? AND version = 1`,
          )
          .run(updatedAt, tenant.userId);
        assert.equal(result.changes, 1);
      },
    },
    {
      label: "disabled Account",
      mutate: (database, tenant, updatedAt) => {
        const result = database
          .prepare(
            `UPDATE accounts SET status = 'disabled', updated_at = ?, version = 2
             WHERE id = ? AND version = 1`,
          )
          .run(updatedAt, tenant.accountId);
        assert.equal(result.changes, 1);
      },
    },
    {
      label: "archived Project",
      mutate: (database, tenant, updatedAt) => {
        const result = database
          .prepare(
            `UPDATE projects SET status = 'archived', updated_at = ?, version = 2
             WHERE id = ? AND version = 1`,
          )
          .run(updatedAt, tenant.projectId);
        assert.equal(result.changes, 1);
      },
    },
  ];

  for (const [index, scenario] of inactivePrincipalCases.entries()) {
    await withDatabase((database) => {
      const base = 5_200 + index * 100;
      const tenant = seedTenant(database, base, `CUR${index}`);
      const bugId = identifier(base + 10);
      const attemptId = identifier(base + 11);
      const attemptSequence = Number(attemptId.slice(-12));
      const requirementId = identifier(8_900_000 + attemptSequence);
      const deliveryEventId = identifier(8_100_000 + attemptSequence * 10 + 3);
      const buildId = identifier(base + 12);
      const linkId = identifier(base + 13);
      const linkEventId = identifier(base + 14);
      const commitSha = String(index + 1).repeat(40);
      const disabledAt = `2026-08-25T02:10:0${index}.000Z`;

      createBug(database, tenant, bugId, `${scenario.label} typed Build facts`);
      insertRepairAttempt(database, tenant, bugId, attemptId, 1, "running", "human");
      insertRequiredDeliveryAudit(
        database,
        tenant,
        bugId,
        attemptId,
        requirementId,
        deliveryEventId,
        commitSha,
        3,
        "repair_attempt.delivered",
        CREATED_AT,
        "in_progress",
        "awaiting_build",
      );
      const deliveryUpdate = database
        .prepare(
          `UPDATE repair_attempts
           SET status = 'delivered', summary = 'Fix delivered', branch = 'main',
               commit_sha = ?, updated_at = ?, version = 3
           WHERE id = ? AND version = 2`,
        )
        .run(commitSha, CREATED_AT, attemptId);
      assert.equal(deliveryUpdate.changes, 1);

      const requirementRejection = probeSqlRejection(database, () => {
        scenario.mutate(database, tenant, disabledAt);
        insertRequiredBuildRequirement(
          database,
          tenant,
          bugId,
          attemptId,
          requirementId,
          deliveryEventId,
          commitSha,
        );
      });
      assert.match(
        String(requirementRejection),
        /BuildRequirement requires its exact typed delivery audit/i,
        `${scenario.label} recorded a BuildRequirement fact`,
      );

      insertRequiredBuildRequirement(
        database,
        tenant,
        bugId,
        attemptId,
        requirementId,
        deliveryEventId,
        commitSha,
      );
      insertReadyBuild(database, tenant, buildId, commitSha, [commitSha]);
      insertBuildLinkAudit(
        database,
        tenant,
        bugId,
        attemptId,
        buildId,
        linkId,
        linkEventId,
        commitSha,
        4,
      );

      const linkRejection = probeSqlRejection(database, () => {
        scenario.mutate(database, tenant, disabledAt);
        const requirementUpdate = database
          .prepare(
            `UPDATE build_requirements
             SET linked_build_id = ?, link_id = ?, updated_at = ?, version = 2
             WHERE id = ? AND version = 1`,
          )
          .run(buildId, linkId, UPDATED_AT, requirementId);
        assert.equal(requirementUpdate.changes, 1);
        database
          .prepare(
            `INSERT INTO build_repair_links(
              id, account_id, project_id, bug_id, repair_attempt_id, build_id,
              build_requirement_id, build_requirement_version, delivered_commit_sha,
              evidence_type, evidence_decision, override_reason, evidence_actor_id,
              evidence_audit_event_id, evidence_policy_version, linked_at, version
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, 2, ?, 'manifest', 'manifest_verified', NULL, ?, ?,
              '1.0.0', ?, 1
            )`,
          )
          .run(
            linkId,
            tenant.accountId,
            tenant.projectId,
            bugId,
            attemptId,
            buildId,
            requirementId,
            commitSha,
            tenant.userId,
            linkEventId,
            UPDATED_AT,
          );
      });
      assert.match(
        String(linkRejection),
        /build repair link requires its exact typed evidence audit/i,
        `${scenario.label} recorded a BuildRepairLink fact`,
      );

      linkRequiredBuild(
        database,
        tenant,
        bugId,
        attemptId,
        requirementId,
        buildId,
        linkId,
        linkEventId,
        commitSha,
      );
      assertIntegrity(database);
    });
  }
});

test("forward v3 accepts the frozen human repair_attempt.delivered BuildRequirement audit", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 4_100, "FDT");
    const bugId = identifier(4_110);
    const attemptId = identifier(4_111);
    const requirementId = identifier(4_112);
    const eventId = identifier(4_113);
    const decisionReason = "No executable change";
    createBug(database, tenant, bugId, "Forward typed delivery audit Bug");
    insertRepairAttempt(database, tenant, bugId, attemptId);
    insertForwardNoBuildDeliveryAudit(
      database,
      tenant,
      bugId,
      attemptId,
      requirementId,
      eventId,
      "repair_attempt.delivered",
      decisionReason,
    );

    insertForwardNoBuildRequirement(
      database,
      tenant,
      bugId,
      attemptId,
      requirementId,
      eventId,
      decisionReason,
    );

    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT requirement, decision_reason AS decisionReason
             FROM build_requirements WHERE id = ?`,
          )
          .get(requirementId),
      },
      { decisionReason, requirement: "not_required" },
    );
    assert.equal(
      database.prepare("SELECT type FROM events WHERE id = ?").get(eventId)?.type,
      "repair_attempt.delivered",
    );
    assertIntegrity(database);
  });
});

test("forward v3 rejects the legacy repair.delivered BuildRequirement audit spelling", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 4_200, "FLG");
    const bugId = identifier(4_210);
    const attemptId = identifier(4_211);
    const requirementId = identifier(4_212);
    const eventId = identifier(4_213);
    const decisionReason = "No executable change";
    createBug(database, tenant, bugId, "Legacy delivery audit Bug");
    insertRepairAttempt(database, tenant, bugId, attemptId);
    insertForwardNoBuildDeliveryAudit(
      database,
      tenant,
      bugId,
      attemptId,
      requirementId,
      eventId,
      "repair.delivered",
      decisionReason,
    );

    const rejection = probeSqlRejection(database, () => {
      insertForwardNoBuildRequirement(
        database,
        tenant,
        bugId,
        attemptId,
        requirementId,
        eventId,
        decisionReason,
      );
    });
    assert.match(String(rejection), /BuildRequirement requires its exact typed delivery audit/i);
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM build_requirements").get()?.count,
      0,
    );
    assertIntegrity(database);
  });
});

test("forward v3 stores a 5000-character decisionReason while its typed Event keeps a bounded truncation", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 4_300, "FDR");
    const bugId = identifier(4_310);
    const attemptId = identifier(4_311);
    const requirementId = identifier(4_312);
    const eventId = identifier(4_313);
    const decisionReason = "D".repeat(5_000);
    const auditDecisionReason = `${"D".repeat(1_997)}…`;
    createBug(database, tenant, bugId, "Long BuildRequirement decision Bug");
    insertRepairAttempt(
      database,
      tenant,
      bugId,
      attemptId,
      1,
      "delivered",
      "human",
      decisionReason,
    );
    const payloadJson = insertForwardNoBuildDeliveryAudit(
      database,
      tenant,
      bugId,
      attemptId,
      requirementId,
      eventId,
      "repair_attempt.delivered",
      decisionReason,
      auditDecisionReason,
    );
    assert.ok(Buffer.byteLength(payloadJson, "utf8") <= 4_096);
    assert.equal((JSON.parse(payloadJson) as { reason: string }).reason, auditDecisionReason);
    assert.notEqual(auditDecisionReason, decisionReason);

    insertForwardNoBuildRequirement(
      database,
      tenant,
      bugId,
      attemptId,
      requirementId,
      eventId,
      decisionReason,
    );

    const stored = database
      .prepare(
        `SELECT decision_reason AS decisionReason, length(decision_reason) AS reasonLength
         FROM build_requirements WHERE id = ?`,
      )
      .get(requirementId);
    assert.equal(stored?.decisionReason, decisionReason);
    assert.equal(stored?.reasonLength, 5_000);
    assertIntegrity(database);
  });
});

test("forward v3 stores a 5000-character overrideReason while its typed Event keeps a bounded truncation", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 4_400, "FOR");
    const bugId = identifier(4_410);
    const attemptId = identifier(4_411);
    const requirementId = identifier(4_412);
    const deliveryEventId = identifier(4_413);
    const buildId = identifier(4_414);
    const linkId = identifier(4_415);
    const linkEventId = identifier(4_416);
    const membershipId = identifier(4_417);
    const commitSha = "c".repeat(40);
    const overrideReason = "O".repeat(5_000);
    const auditOverrideReason = `${"O".repeat(1_997)}…`;
    createBug(database, tenant, bugId, "Long Build override Bug");
    insertRequiredRepairAttempt(database, tenant, bugId, attemptId, commitSha);
    insertRequiredDeliveryAudit(
      database,
      tenant,
      bugId,
      attemptId,
      requirementId,
      deliveryEventId,
      commitSha,
      1,
      "repair_attempt.delivered",
    );
    insertRequiredBuildRequirement(
      database,
      tenant,
      bugId,
      attemptId,
      requirementId,
      deliveryEventId,
      commitSha,
    );
    insertReleaseManagerMembership(database, tenant, membershipId);
    insertReadyBuild(database, tenant, buildId, commitSha, [commitSha]);
    const payloadJson = insertOverrideBuildLinkAudit(
      database,
      tenant,
      bugId,
      attemptId,
      buildId,
      linkId,
      linkEventId,
      commitSha,
      overrideReason,
      auditOverrideReason,
    );
    assert.ok(Buffer.byteLength(payloadJson, "utf8") <= 4_096);
    assert.equal((JSON.parse(payloadJson) as { reason: string }).reason, auditOverrideReason);
    assert.notEqual(auditOverrideReason, overrideReason);

    linkRequiredBuildWithOverride(
      database,
      tenant,
      bugId,
      attemptId,
      requirementId,
      buildId,
      linkId,
      linkEventId,
      commitSha,
      overrideReason,
    );

    const stored = database
      .prepare(
        `SELECT override_reason AS overrideReason, length(override_reason) AS reasonLength
         FROM build_repair_links WHERE id = ?`,
      )
      .get(linkId);
    assert.equal(stored?.overrideReason, overrideReason);
    assert.equal(stored?.reasonLength, 5_000);
    assert.equal(
      database.prepare("SELECT version FROM builds WHERE id = ?").get(buildId)?.version,
      3,
    );
    assertIntegrity(database);
  });
});

test("forward v3 preserves Windows-path decisions only through redacted typed Events", async () => {
  await withDatabase((database) => {
    const decisionTenant = seedTenant(database, 5_400, "WPD");
    const decisionBugId = identifier(5_410);
    const decisionAttemptId = identifier(5_411);
    const decisionRequirementId = identifier(5_412);
    const decisionEventId = identifier(5_413);
    const decisionReason = "Evidence retained at C:\\Users\\qa\\private-decision.txt";
    createBug(database, decisionTenant, decisionBugId, "Redacted Windows-path decision");
    insertRepairAttempt(
      database,
      decisionTenant,
      decisionBugId,
      decisionAttemptId,
      1,
      "delivered",
      "human",
      decisionReason,
      null,
      "[REDACTED]",
    );
    insertForwardNoBuildDeliveryAudit(
      database,
      decisionTenant,
      decisionBugId,
      decisionAttemptId,
      decisionRequirementId,
      decisionEventId,
      "repair_attempt.delivered",
      decisionReason,
      "[REDACTED]",
    );
    insertForwardNoBuildRequirement(
      database,
      decisionTenant,
      decisionBugId,
      decisionAttemptId,
      decisionRequirementId,
      decisionEventId,
      decisionReason,
    );
    assert.equal(
      database
        .prepare("SELECT decision_reason FROM build_requirements WHERE id = ?")
        .get(decisionRequirementId)?.decision_reason,
      decisionReason,
    );

    const overrideTenant = seedTenant(database, 5_500, "WPO");
    const overrideBugId = identifier(5_510);
    const overrideAttemptId = identifier(5_511);
    const overrideRequirementId = identifier(5_512);
    const deliveryEventId = identifier(5_513);
    const buildId = identifier(5_514);
    const linkId = identifier(5_515);
    const linkEventId = identifier(5_516);
    const commitSha = "5".repeat(40);
    const overrideReason = "Approval retained at C:\\Users\\release\\private-override.txt";
    createBug(database, overrideTenant, overrideBugId, "Redacted Windows-path override");
    insertRequiredRepairAttempt(
      database,
      overrideTenant,
      overrideBugId,
      overrideAttemptId,
      commitSha,
    );
    insertRequiredDeliveryAudit(
      database,
      overrideTenant,
      overrideBugId,
      overrideAttemptId,
      overrideRequirementId,
      deliveryEventId,
      commitSha,
      1,
      "repair_attempt.delivered",
    );
    insertRequiredBuildRequirement(
      database,
      overrideTenant,
      overrideBugId,
      overrideAttemptId,
      overrideRequirementId,
      deliveryEventId,
      commitSha,
    );
    insertReleaseManagerMembership(database, overrideTenant, identifier(5_517));
    insertReadyBuild(database, overrideTenant, buildId, commitSha, [commitSha]);
    insertOverrideBuildLinkAudit(
      database,
      overrideTenant,
      overrideBugId,
      overrideAttemptId,
      buildId,
      linkId,
      linkEventId,
      commitSha,
      overrideReason,
      "[REDACTED]",
    );
    linkRequiredBuildWithOverride(
      database,
      overrideTenant,
      overrideBugId,
      overrideAttemptId,
      overrideRequirementId,
      buildId,
      linkId,
      linkEventId,
      commitSha,
      overrideReason,
    );
    assert.equal(
      database.prepare("SELECT override_reason FROM build_repair_links WHERE id = ?").get(linkId)
        ?.override_reason,
      overrideReason,
    );
    assertIntegrity(database);
  });
});

test("forward v3 persists redacted cookie and API-key reasons without exposing Event text", async () => {
  await withDatabase((database) => {
    const decisionTenant = seedTenant(database, 5_800, "RDC");
    const decisionBugId = identifier(5_810);
    const decisionAttemptId = identifier(5_811);
    const decisionRequirementId = identifier(5_812);
    const decisionEventId = identifier(5_813);
    const decisionReason = "cookie=session-secret";
    createBug(database, decisionTenant, decisionBugId, "Redacted cookie decision");
    insertRepairAttempt(
      database,
      decisionTenant,
      decisionBugId,
      decisionAttemptId,
      1,
      "delivered",
      "human",
      decisionReason,
      null,
      "[REDACTED]",
    );
    insertForwardNoBuildDeliveryAudit(
      database,
      decisionTenant,
      decisionBugId,
      decisionAttemptId,
      decisionRequirementId,
      decisionEventId,
      "repair_attempt.delivered",
      decisionReason,
      "[REDACTED]",
    );
    insertForwardNoBuildRequirement(
      database,
      decisionTenant,
      decisionBugId,
      decisionAttemptId,
      decisionRequirementId,
      decisionEventId,
      decisionReason,
    );
    assert.equal(
      database
        .prepare("SELECT decision_reason FROM build_requirements WHERE id = ?")
        .get(decisionRequirementId)?.decision_reason,
      decisionReason,
    );

    const overrideTenant = seedTenant(database, 5_900, "RDA");
    const overrideBugId = identifier(5_910);
    const overrideAttemptId = identifier(5_911);
    const overrideRequirementId = identifier(5_912);
    const deliveryEventId = identifier(5_913);
    const buildId = identifier(5_914);
    const linkId = identifier(5_915);
    const linkEventId = identifier(5_916);
    const commitSha = "6".repeat(40);
    const overrideReason = "x-api-key: release-secret";
    createBug(database, overrideTenant, overrideBugId, "Redacted API-key override");
    insertRequiredRepairAttempt(
      database,
      overrideTenant,
      overrideBugId,
      overrideAttemptId,
      commitSha,
    );
    insertRequiredDeliveryAudit(
      database,
      overrideTenant,
      overrideBugId,
      overrideAttemptId,
      overrideRequirementId,
      deliveryEventId,
      commitSha,
      1,
      "repair_attempt.delivered",
    );
    insertRequiredBuildRequirement(
      database,
      overrideTenant,
      overrideBugId,
      overrideAttemptId,
      overrideRequirementId,
      deliveryEventId,
      commitSha,
    );
    insertReleaseManagerMembership(database, overrideTenant, identifier(5_917));
    insertReadyBuild(database, overrideTenant, buildId, commitSha, [commitSha]);
    insertOverrideBuildLinkAudit(
      database,
      overrideTenant,
      overrideBugId,
      overrideAttemptId,
      buildId,
      linkId,
      linkEventId,
      commitSha,
      overrideReason,
      "[REDACTED]",
    );
    linkRequiredBuildWithOverride(
      database,
      overrideTenant,
      overrideBugId,
      overrideAttemptId,
      overrideRequirementId,
      buildId,
      linkId,
      linkEventId,
      commitSha,
      overrideReason,
    );
    assert.equal(
      database.prepare("SELECT override_reason FROM build_repair_links WHERE id = ?").get(linkId)
        ?.override_reason,
      overrideReason,
    );
    assertIntegrity(database);
  });
});

test("forward v3 durably preserves raw RepairAttempt failure truth behind bounded audit text", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_700, "FAR");
    const scenarios = [
      {
        auditReason: `${"F".repeat(1_997)}…`,
        rawReason: "F".repeat(5_000),
      },
      {
        auditReason: "[REDACTED]",
        rawReason: "cookie=session-secret",
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const bugId = identifier(5_710 + index * 10);
      const attemptId = identifier(5_711 + index * 10);
      const eventId = identifier(5_712 + index * 10);
      const eventBase = 5_720 + index * 20;
      const failedAt = `2026-08-25T03:0${index}:00.000Z`;
      createBug(database, tenant, bugId, `Durable failure truth ${index}`);
      seedTypedRunningWorkflow(database, tenant, bugId, attemptId, eventBase);

      const missingEvent = probeSqlRejection(database, () => {
        database
          .prepare(
            `UPDATE repair_attempts
             SET status = 'failed', failure_reason = ?, updated_at = ?, version = 3
             WHERE id = ? AND version = 2`,
          )
          .run(scenario.rawReason, failedAt, attemptId);
      });
      assert.match(String(missingEvent), /RepairAttempt lifecycle requires a forward exact-CAS/i);

      database.exec("BEGIN IMMEDIATE");
      try {
        insertBugWorkflowEvent(database, tenant, {
          aggregateId: attemptId,
          aggregateSequence: 3,
          aggregateType: "repair_attempt",
          bugId,
          createdAt: failedAt,
          eventId,
          eventType: "repair_attempt.failed",
          fromState: "in_progress",
          payload: {
            status: "failed",
            repairAttemptId: attemptId,
            reason: scenario.auditReason,
            fromVersion: 2,
            toVersion: 3,
          },
          resourceId: attemptId,
          resourceType: "repair_attempt",
          resourceVersionAfter: 3,
          toState: "ready",
        });

        const mismatchedTruth = probeSqlRejection(database, () => {
          database
            .prepare(
              `UPDATE repair_attempts
               SET status = 'failed', failure_reason = 'unrelated failure',
                   updated_at = ?, version = 3
               WHERE id = ? AND version = 2`,
            )
            .run(failedAt, attemptId);
        });
        assert.match(
          String(mismatchedTruth),
          /RepairAttempt lifecycle requires a forward exact-CAS/i,
        );

        const attemptUpdate = database
          .prepare(
            `UPDATE repair_attempts
             SET status = 'failed', failure_reason = ?, updated_at = ?, version = 3
             WHERE id = ? AND version = 2`,
          )
          .run(scenario.rawReason, failedAt, attemptId);
        assert.equal(attemptUpdate.changes, 1);
        const bugUpdate = database
          .prepare(
            `UPDATE bugs
             SET state = 'ready', active_repair_attempt_id = NULL,
                 updated_at = ?, version = 4
             WHERE id = ? AND version = 3`,
          )
          .run(failedAt, bugId);
        assert.equal(bugUpdate.changes, 1);
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }

      assert.deepEqual(
        {
          ...database
            .prepare(
              `SELECT status, failure_reason AS failureReason, version
               FROM repair_attempts WHERE id = ?`,
            )
            .get(attemptId),
        },
        { failureReason: scenario.rawReason, status: "failed", version: 3 },
      );
      assert.equal(
        database
          .prepare(
            "SELECT json_extract(payload_json, '$.reason') AS reason FROM events WHERE id = ?",
          )
          .get(eventId)?.reason,
        scenario.auditReason,
      );
    }
    assertIntegrity(database);
  });
});

test("forward v3 preserves a distinct current Verification creator and assigned verifier", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_600, "CVF");
    const bugId = identifier(5_610);
    const attemptId = identifier(5_611);
    const requirementId = identifier(5_612);
    const verificationId = identifier(5_613);
    const verificationEventId = identifier(5_614);
    const createdAt = "2026-08-25T02:20:00.000Z";
    createBug(database, tenant, bugId, "Assigned verifier differs from current creator");
    seedTypedNoBuildRfvWorkflow(database, tenant, bugId, attemptId, requirementId, 5_620);

    const disabledTarget = probeSqlRejection(database, () => {
      const disabled = database
        .prepare(
          `UPDATE users SET status = 'disabled', updated_at = ?, version = 2
           WHERE id = ? AND version = 1`,
        )
        .run(createdAt, tenant.secondaryUserId);
      assert.equal(disabled.changes, 1);
      insertVerification(
        database,
        tenant,
        bugId,
        attemptId,
        verificationId,
        tenant.secondaryUserId,
        null,
        createdAt,
        verificationEventId,
        "Verify another user's assigned run",
        tenant.userId,
      );
    });
    assert.match(String(disabledTarget), /current creator and assigned-verifier authority/i);

    insertVerification(
      database,
      tenant,
      bugId,
      attemptId,
      verificationId,
      tenant.secondaryUserId,
      null,
      createdAt,
      verificationEventId,
      "Verify another user's assigned run",
      tenant.userId,
    );
    const pointerUpdate = database
      .prepare(
        `UPDATE bugs
         SET active_verification_id = ?, updated_at = ?, version = 5
         WHERE id = ? AND version = 4`,
      )
      .run(verificationId, createdAt, bugId);
    assert.equal(pointerUpdate.changes, 1);
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT verification.verifier_id AS verifierId, event.actor_user_id AS creatorId,
                    bug.active_verification_id AS activeVerificationId
             FROM verifications AS verification
             JOIN events AS event ON event.id = ?
             JOIN bugs AS bug ON bug.id = verification.bug_id
             WHERE verification.id = ?`,
          )
          .get(verificationEventId, verificationId),
      },
      {
        activeVerificationId: verificationId,
        creatorId: tenant.userId,
        verifierId: tenant.secondaryUserId,
      },
    );

    const hijackStartedAt = "2026-08-25T02:21:00.000Z";
    const verifierRewrite = probeSqlRejection(database, () => {
      insertVerificationStartEvent(
        database,
        tenant,
        bugId,
        verificationId,
        identifier(5_615),
        hijackStartedAt,
      );
      database
        .prepare(
          `UPDATE verifications
           SET verifier_id = ?, status = 'in_progress', updated_at = ?, version = 2
           WHERE id = ? AND version = 1`,
        )
        .run(tenant.userId, hijackStartedAt, verificationId);
    });
    assert.match(
      String(verifierRewrite),
      /verification identity and exact Build evidence are immutable/i,
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT verifier_id AS verifierId, status, version FROM verifications WHERE id = ?",
          )
          .get(verificationId),
      },
      { status: "requested", verifierId: tenant.secondaryUserId, version: 1 },
    );
    assertIntegrity(database);
  });
});

test("forward v3 preserves delivered history and reopens only for a later ranked Build occurrence", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 4_500, "FRP");
    const bugId = identifier(4_510);
    const deliveredAttemptId = identifier(4_511);
    const requirementId = identifier(4_512);
    const deliveryEventId = identifier(4_513);
    const verifiedBuildId = identifier(4_514);
    const newerBuildId = identifier(4_515);
    const olderBuildId = identifier(4_538);
    const linkId = identifier(4_516);
    const linkEventId = identifier(4_517);
    const lineageId = identifier(4_518);
    const firstLineageEventId = identifier(4_519);
    const secondLineageEventId = identifier(4_520);
    const thirdLineageEventId = identifier(4_540);
    const verificationId = identifier(4_521);
    const membershipId = identifier(4_522);
    const startEventId = identifier(4_523);
    const closeEventId = identifier(4_524);
    const occurrenceId = identifier(4_525);
    const occurrenceSubmissionId = identifier(4_526);
    const occurrenceEventId = identifier(4_527);
    const reopenEventId = identifier(4_528);
    const equalOccurrenceId = identifier(4_541);
    const equalOccurrenceSubmissionId = identifier(4_542);
    const equalOccurrenceEventId = identifier(4_543);
    const equalReopenEventId = identifier(4_544);
    const olderOccurrenceId = identifier(4_545);
    const olderOccurrenceSubmissionId = identifier(4_546);
    const olderOccurrenceEventId = identifier(4_547);
    const olderReopenEventId = identifier(4_548);
    const duplicateOccurrenceEventId = identifier(4_549);
    const splitCloseEventId = identifier(4_550);
    const splitReopenEventId = identifier(4_551);
    const plannedAttemptId = identifier(4_529);
    const triageEventId = identifier(4_530);
    const attemptCreatedEventId = identifier(4_531);
    const attemptStartedEventId = identifier(4_532);
    const verificationCreatedEventId = identifier(4_533);
    const rejectedPlannedAttemptId = identifier(4_534);
    const secondaryMembershipId = identifier(4_535);
    const commitSha = "a".repeat(40);
    const triagedAt = "2026-08-25T00:00:10.000Z";
    const attemptCreatedAt = "2026-08-25T00:00:20.000Z";
    const attemptStartedAt = "2026-08-25T00:00:30.000Z";
    const deliveredAt = "2026-08-25T00:00:40.000Z";
    const firstLineageAt = "2026-08-25T00:03:00.000Z";
    const secondLineageAt = "2026-08-25T00:04:00.000Z";
    const thirdLineageAt = "2026-08-25T00:04:05.000Z";
    const verificationCreatedAt = "2026-08-25T00:04:10.000Z";
    const verificationStartedAt = "2026-08-25T00:04:20.000Z";
    const closedAt = "2026-08-25T00:05:00.000Z";
    const equalOccurredAt = "2026-08-25T00:06:00.000Z";
    const equalReopenAt = "2026-08-25T00:06:10.000Z";
    const olderOccurredAt = "2026-08-25T00:06:20.000Z";
    const olderReopenAt = "2026-08-25T00:06:30.000Z";
    const occurredAt = "2026-08-25T00:06:40.000Z";
    const reopenedAt = "2026-08-25T00:07:00.000Z";
    const replannedAt = "2026-08-25T00:08:00.000Z";

    createBug(database, tenant, bugId, "Reopen after a later ranked Build occurrence");
    insertActiveMembershipRole(database, tenant, membershipId, "verifier");
    insertActiveMembershipRole(database, tenant, membershipId, "triager");
    insertActiveMembershipRole(database, tenant, membershipId, "release_manager");
    insertActiveMembershipRole(database, tenant, membershipId, "developer");
    insertActiveMembershipRole(
      database,
      tenant,
      secondaryMembershipId,
      "developer",
      tenant.secondaryUserId,
    );
    insertActiveMembershipRole(
      database,
      tenant,
      secondaryMembershipId,
      "verifier",
      tenant.secondaryUserId,
    );
    insertActiveMembershipRole(
      database,
      tenant,
      secondaryMembershipId,
      "triager",
      tenant.secondaryUserId,
    );
    insertBugWorkflowEvent(database, tenant, {
      aggregateId: bugId,
      aggregateSequence: 1,
      aggregateType: "bug",
      bugId,
      createdAt: triagedAt,
      eventId: triageEventId,
      eventType: "bug.triage.ready",
      fromState: "reported",
      payload: { status: "ready", fromVersion: 1, toVersion: 2 },
      resourceId: bugId,
      resourceType: "bug",
      resourceVersionAfter: 2,
      toState: "ready",
    });
    database
      .prepare(
        `UPDATE bugs
         SET state = 'ready', updated_at = ?, version = 2
         WHERE id = ? AND version = 1`,
      )
      .run(triagedAt, bugId);
    insertBugWorkflowEvent(database, tenant, {
      aggregateId: deliveredAttemptId,
      aggregateSequence: 1,
      aggregateType: "repair_attempt",
      bugId,
      createdAt: attemptCreatedAt,
      eventId: attemptCreatedEventId,
      eventType: "repair_attempt.created",
      fromState: "ready",
      payload: {
        status: "planned",
        repairAttemptId: deliveredAttemptId,
        fromVersion: 2,
        toVersion: 3,
      },
      resourceId: deliveredAttemptId,
      resourceType: "repair_attempt",
      resourceVersionAfter: 1,
      toState: "in_progress",
    });
    database
      .prepare(
        `INSERT INTO repair_attempts(
          id, account_id, project_id, bug_id, sequence, mode, status,
          assignee_id, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, 1, 'human', 'planned', ?, ?, ?, 1)`,
      )
      .run(
        deliveredAttemptId,
        tenant.accountId,
        tenant.projectId,
        bugId,
        tenant.secondaryUserId,
        attemptCreatedAt,
        attemptCreatedAt,
      );
    database
      .prepare(
        `UPDATE bugs
         SET state = 'in_progress', active_repair_attempt_id = ?,
             updated_at = ?, version = 3
         WHERE id = ? AND version = 2`,
      )
      .run(deliveredAttemptId, attemptCreatedAt, bugId);
    insertBugWorkflowEvent(database, tenant, {
      aggregateId: deliveredAttemptId,
      aggregateSequence: 2,
      aggregateType: "repair_attempt",
      bugId,
      createdAt: attemptStartedAt,
      eventId: attemptStartedEventId,
      eventType: "repair_attempt.started",
      fromState: null,
      payload: {
        status: "running",
        repairAttemptId: deliveredAttemptId,
        fromVersion: 1,
        toVersion: 2,
      },
      resourceId: deliveredAttemptId,
      resourceType: "repair_attempt",
      resourceVersionAfter: 2,
      toState: null,
    });
    database
      .prepare(
        `UPDATE repair_attempts
         SET status = 'running', updated_at = ?, version = 2
         WHERE id = ? AND version = 1`,
      )
      .run(attemptStartedAt, deliveredAttemptId);
    insertRequiredDeliveryAudit(
      database,
      tenant,
      bugId,
      deliveredAttemptId,
      requirementId,
      deliveryEventId,
      commitSha,
      3,
      "repair_attempt.delivered",
      deliveredAt,
      "in_progress",
      "awaiting_build",
    );
    database
      .prepare(
        `UPDATE repair_attempts
         SET status = 'delivered', summary = 'Fix delivered', branch = 'main',
             commit_sha = ?, updated_at = ?, version = 3
         WHERE id = ? AND version = 2`,
      )
      .run(commitSha, deliveredAt, deliveredAttemptId);
    insertRequiredBuildRequirement(
      database,
      tenant,
      bugId,
      deliveredAttemptId,
      requirementId,
      deliveryEventId,
      commitSha,
      deliveredAt,
      4,
    );
    database
      .prepare(
        `UPDATE bugs
         SET state = 'awaiting_build', updated_at = ?, version = 4
         WHERE id = ? AND version = 3`,
      )
      .run(deliveredAt, bugId);
    insertReadyBuild(database, tenant, olderBuildId, "9".repeat(40), ["9".repeat(40)]);
    insertReadyBuild(database, tenant, verifiedBuildId, commitSha, [commitSha]);
    insertReadyBuild(database, tenant, newerBuildId, "b".repeat(40), ["b".repeat(40)]);
    insertBuildLinkAudit(
      database,
      tenant,
      bugId,
      deliveredAttemptId,
      verifiedBuildId,
      linkId,
      linkEventId,
      commitSha,
      4,
      UPDATED_AT,
      "awaiting_build",
      "ready_for_verification",
    );
    linkRequiredBuild(
      database,
      tenant,
      bugId,
      deliveredAttemptId,
      requirementId,
      verifiedBuildId,
      linkId,
      linkEventId,
      commitSha,
    );
    database
      .prepare(
        `UPDATE bugs
         SET state = 'ready_for_verification', updated_at = ?, version = 5
         WHERE id = ? AND version = 4`,
      )
      .run(UPDATED_AT, bugId);
    const rejectedPlanning = probeSqlRejection(database, () => {
      insertBugWorkflowEvent(database, tenant, {
        aggregateId: rejectedPlannedAttemptId,
        aggregateSequence: 1,
        aggregateType: "repair_attempt",
        bugId,
        createdAt: UPDATED_AT,
        eventId: identifier(4_537),
        eventType: "repair_attempt.created",
        fromState: "ready",
        payload: {
          status: "planned",
          repairAttemptId: rejectedPlannedAttemptId,
          fromVersion: 5,
          toVersion: 6,
        },
        resourceId: rejectedPlannedAttemptId,
        resourceType: "repair_attempt",
        resourceVersionAfter: 1,
        toState: "in_progress",
      });
      database
        .prepare(
          `INSERT INTO repair_attempts(
              id, account_id, project_id, bug_id, sequence, mode, status,
              assignee_id, created_at, updated_at, version
            ) VALUES (?, ?, ?, ?, 2, 'human', 'planned', ?, ?, ?, 1)`,
        )
        .run(
          rejectedPlannedAttemptId,
          tenant.accountId,
          tenant.projectId,
          bugId,
          tenant.userId,
          UPDATED_AT,
          UPDATED_AT,
        );
    });
    assert.match(
      String(rejectedPlanning),
      /new planned RepairAttempt requires the Bug active delivered pointer to be cleared/i,
    );
    insertBuildLineage(database, tenant, lineageId, firstLineageAt);
    insertBuildLineageEntry(
      database,
      tenant,
      lineageId,
      olderBuildId,
      null,
      1,
      firstLineageEventId,
      firstLineageAt,
    );
    insertBuildLineageEntry(
      database,
      tenant,
      lineageId,
      verifiedBuildId,
      olderBuildId,
      2,
      secondLineageEventId,
      secondLineageAt,
    );
    insertBuildLineageEntry(
      database,
      tenant,
      lineageId,
      newerBuildId,
      verifiedBuildId,
      3,
      thirdLineageEventId,
      thirdLineageAt,
    );
    insertVerification(
      database,
      tenant,
      bugId,
      deliveredAttemptId,
      verificationId,
      tenant.userId,
      verifiedBuildId,
      verificationCreatedAt,
      verificationCreatedEventId,
    );
    database
      .prepare(
        `UPDATE bugs
         SET active_verification_id = ?, updated_at = ?, version = 6
         WHERE id = ? AND version = 5`,
      )
      .run(verificationId, verificationCreatedAt, bugId);
    insertVerificationStartEvent(
      database,
      tenant,
      bugId,
      verificationId,
      startEventId,
      verificationStartedAt,
      2,
    );
    database
      .prepare(
        `UPDATE verifications
         SET status = 'in_progress', updated_at = ?, version = 2
         WHERE id = ?`,
      )
      .run(verificationStartedAt, verificationId);

    const nakedPass = probeSqlRejection(database, () => {
      database
        .prepare(
          `UPDATE verifications
           SET status = 'passed', result_summary = 'Naked result',
               updated_at = ?, version = 3
           WHERE id = ?`,
        )
        .run(closedAt, verificationId);
    });
    assert.match(String(nakedPass), /exact assigned-human typed audit Event/i);

    transaction(database, () => {
      insertVerificationClosureEvent(
        database,
        tenant,
        bugId,
        deliveredAttemptId,
        verificationId,
        closeEventId,
        closedAt,
        verifiedBuildId,
        3,
      );
      database
        .prepare(
          `UPDATE verifications
           SET status = 'passed', result_summary = 'Human verification passed',
               updated_at = ?, version = 3
           WHERE id = ?`,
        )
        .run(closedAt, verificationId);
      insertBugWorkflowEvent(database, tenant, {
        actorUserId: tenant.secondaryUserId,
        aggregateId: bugId,
        aggregateSequence: 9_000_001,
        aggregateType: "bug",
        bugId,
        createdAt: closedAt,
        eventId: splitCloseEventId,
        eventType: "bug.verification.passed",
        fromState: "ready_for_verification",
        payload: { status: "passed", fromVersion: 6, toVersion: 7 },
        resourceId: bugId,
        resourceType: "bug",
        resourceVersionAfter: 7,
        toState: "closed",
      });
      const disabledExactVerifier = probeSqlRejection(database, () => {
        const disabled = database
          .prepare(
            `UPDATE users SET status = 'disabled', updated_at = ?, version = 2
             WHERE id = ? AND version = 1`,
          )
          .run(closedAt, tenant.userId);
        assert.equal(disabled.changes, 1);
        database
          .prepare(
            `UPDATE bugs
             SET state = 'closed', active_repair_attempt_id = NULL,
                 active_verification_id = NULL, closed_at = ?, updated_at = ?, version = 7
             WHERE id = ? AND version = 6`,
          )
          .run(closedAt, closedAt, bugId);
      });
      assert.match(
        String(disabledExactVerifier),
        /Bug closure requires current passed human Verification and typed audit proof/i,
      );
      const forgedClosure = probeSqlRejection(database, () => {
        database
          .prepare(
            `INSERT INTO bug_closure_acceptances(
              account_id, project_id, bug_id, closure_generation, verification_id,
              close_event_id, close_event_position, actor_user_id, closed_bug_version,
              closed_at, baseline_kind, baseline_build_id, baseline_lineage_id,
              baseline_ordinal, created_at
            ) VALUES (
              ?, ?, ?, 0, ?, ?, (SELECT event_position FROM events WHERE id = ?), ?, 7,
              ?, 'verified_build', ?, ?, 2, ?
            )`,
          )
          .run(
            tenant.accountId,
            tenant.projectId,
            bugId,
            verificationId,
            closeEventId,
            closeEventId,
            tenant.userId,
            closedAt,
            verifiedBuildId,
            lineageId,
            closedAt,
          );
      });
      assert.match(
        String(forgedClosure),
        /Bug closure acceptance requires the exact current human closure proof/i,
      );
      database
        .prepare(
          `UPDATE bugs
           SET state = 'closed', active_repair_attempt_id = NULL,
               active_verification_id = NULL, closed_at = ?, updated_at = ?, version = 7
           WHERE id = ?`,
        )
        .run(closedAt, closedAt, bugId);
    });
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT baseline_kind AS baselineKind, baseline_build_id AS baselineBuildId,
                    baseline_lineage_id AS baselineLineageId, baseline_ordinal AS baselineOrdinal,
                    closure_generation AS closureGeneration, closed_bug_version AS closedBugVersion
             FROM bug_closure_acceptances WHERE bug_id = ?`,
          )
          .get(bugId),
      },
      {
        baselineBuildId: verifiedBuildId,
        baselineKind: "verified_build",
        baselineLineageId: lineageId,
        baselineOrdinal: 2,
        closedBugVersion: 7,
        closureGeneration: 0,
      },
    );
    const closedTimestampRewrite = probeSqlRejection(database, () => {
      database
        .prepare(
          `UPDATE bugs
           SET closed_at = ?, updated_at = ?, version = 8
           WHERE id = ? AND version = 7`,
        )
        .run("2026-08-25T00:05:30.000Z", "2026-08-25T00:05:30.000Z", bugId);
    });
    assert.match(
      String(closedTimestampRewrite),
      /same-state workflow pointers require their exact typed/i,
    );
    const nakedReopen = probeSqlRejection(database, () => {
      database
        .prepare(
          `UPDATE bugs
           SET state = 'ready', closed_at = NULL, reopen_count = 1,
               updated_at = ?, version = 8
           WHERE id = ?`,
        )
        .run(occurredAt, bugId);
    });
    assert.match(
      String(nakedReopen),
      /later same-lineage server-ranked Build occurrence|Bug state transition requires its exact typed human audit/i,
    );

    const equalBuildReopen = probeSqlRejection(database, () => {
      appendOccurrenceEvidence(
        database,
        tenant,
        bugId,
        equalOccurrenceId,
        equalOccurrenceSubmissionId,
        equalOccurrenceEventId,
        equalOccurredAt,
        7,
        8,
        verifiedBuildId,
        2,
      );
      insertReopenEvent(
        database,
        tenant,
        bugId,
        equalOccurrenceId,
        equalReopenEventId,
        equalReopenAt,
        8,
        9,
        3,
      );
      database
        .prepare(
          `UPDATE bugs
           SET state = 'ready', closed_at = NULL, reopen_count = 1,
               updated_at = ?, version = 9
           WHERE id = ? AND version = 8`,
        )
        .run(equalReopenAt, bugId);
    });
    assert.match(String(equalBuildReopen), /later same-lineage server-ranked Build occurrence/i);

    const olderBuildReopen = probeSqlRejection(database, () => {
      appendOccurrenceEvidence(
        database,
        tenant,
        bugId,
        olderOccurrenceId,
        olderOccurrenceSubmissionId,
        olderOccurrenceEventId,
        olderOccurredAt,
        7,
        8,
        olderBuildId,
        2,
      );
      insertReopenEvent(
        database,
        tenant,
        bugId,
        olderOccurrenceId,
        olderReopenEventId,
        olderReopenAt,
        8,
        9,
        3,
      );
      database
        .prepare(
          `UPDATE bugs
           SET state = 'ready', closed_at = NULL, reopen_count = 1,
               updated_at = ?, version = 9
           WHERE id = ? AND version = 8`,
        )
        .run(olderReopenAt, bugId);
    });
    assert.match(String(olderBuildReopen), /later same-lineage server-ranked Build occurrence/i);

    appendOccurrenceEvidence(
      database,
      tenant,
      bugId,
      occurrenceId,
      occurrenceSubmissionId,
      occurrenceEventId,
      occurredAt,
      7,
      8,
      newerBuildId,
      2,
    );
    const duplicateOccurrenceEvent = probeSqlRejection(database, () => {
      insertOccurrenceAppendEvent(
        database,
        tenant,
        bugId,
        occurrenceId,
        duplicateOccurrenceEventId,
        occurredAt,
        7,
        8,
        3,
      );
    });
    assert.match(
      String(duplicateOccurrenceEvent),
      /UNIQUE constraint failed: events\.account_id, events\.project_id, events\.resource_type, events\.resource_id/i,
    );
    insertReopenEvent(database, tenant, bugId, occurrenceId, reopenEventId, reopenedAt, 8, 9, 3);
    insertBugWorkflowEvent(database, tenant, {
      actorUserId: tenant.secondaryUserId,
      aggregateId: bugId,
      aggregateSequence: 9_000_002,
      aggregateType: "bug",
      bugId,
      createdAt: reopenedAt,
      eventId: splitReopenEventId,
      eventType: "bug.reopen.newer_occurrence",
      fromState: "closed",
      payload: { status: "ready", fromVersion: 8, toVersion: 9 },
      resourceId: bugId,
      resourceType: "bug",
      resourceVersionAfter: 9,
      toState: "ready",
    });
    const disabledExactTriager = probeSqlRejection(database, () => {
      const disabled = database
        .prepare(
          `UPDATE users SET status = 'disabled', updated_at = ?, version = 2
           WHERE id = ? AND version = 1`,
        )
        .run(reopenedAt, tenant.userId);
      assert.equal(disabled.changes, 1);
      database
        .prepare(
          `UPDATE bugs
           SET state = 'ready', closed_at = NULL, reopen_count = 1,
               updated_at = ?, version = 9
           WHERE id = ? AND version = 8`,
        )
        .run(reopenedAt, bugId);
    });
    assert.match(
      String(disabledExactTriager),
      /later same-lineage server-ranked Build occurrence/i,
    );
    database
      .prepare(
        `UPDATE bugs
         SET state = 'ready', closed_at = NULL, reopen_count = 1,
             updated_at = ?, version = 9
         WHERE id = ?`,
      )
      .run(reopenedAt, bugId);

    transaction(database, () => {
      insertBugWorkflowEvent(database, tenant, {
        aggregateId: plannedAttemptId,
        aggregateSequence: 1,
        aggregateType: "repair_attempt",
        bugId,
        createdAt: replannedAt,
        eventId: identifier(4_536),
        eventType: "repair_attempt.created",
        fromState: "ready",
        payload: {
          status: "planned",
          repairAttemptId: plannedAttemptId,
          fromVersion: 9,
          toVersion: 10,
        },
        resourceId: plannedAttemptId,
        resourceType: "repair_attempt",
        resourceVersionAfter: 1,
        toState: "in_progress",
      });
      database
        .prepare(
          `INSERT INTO repair_attempts(
            id, account_id, project_id, bug_id, sequence, mode, status,
            assignee_id, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, 2, 'human', 'planned', ?, ?, ?, 1)`,
        )
        .run(
          plannedAttemptId,
          tenant.accountId,
          tenant.projectId,
          bugId,
          tenant.userId,
          replannedAt,
          replannedAt,
        );
      database
        .prepare(
          `UPDATE bugs
           SET state = 'in_progress', active_repair_attempt_id = ?,
               updated_at = ?, version = 10
           WHERE id = ?`,
        )
        .run(plannedAttemptId, replannedAt, bugId);
    });

    assert.deepEqual(
      database
        .prepare(
          `SELECT id, status FROM repair_attempts
           WHERE bug_id = ? ORDER BY sequence`,
        )
        .all(bugId)
        .map((row) => ({ ...row })),
      [
        { id: deliveredAttemptId, status: "delivered" },
        { id: plannedAttemptId, status: "planned" },
      ],
    );
    assert.equal(
      database
        .prepare("SELECT ordinal FROM occurrence_build_lineage_facts WHERE occurrence_id = ?")
        .get(occurrenceId)?.ordinal,
      3,
    );
    assert.equal(
      database.prepare("SELECT active_repair_attempt_id FROM bugs WHERE id = ?").get(bugId)
        ?.active_repair_attempt_id,
      plannedAttemptId,
    );
    assertIntegrity(database);
  });
});

test("forward v3 keeps Build lineage scoped, contiguous, immutable, and occurrence Events singular", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_100, "LIN");
    const foreignTenant = seedTenant(database, 5_200, "LIX");
    const firstBuildId = identifier(5_110);
    const secondBuildId = identifier(5_111);
    const foreignBuildId = identifier(5_210);
    const lineageId = identifier(5_112);
    const firstEventId = identifier(5_113);
    const gapEventId = identifier(5_114);
    const crossScopeEventId = identifier(5_115);
    const secondEventId = identifier(5_116);
    const bugId = identifier(5_117);
    const occurrenceId = identifier(5_118);
    const submissionId = identifier(5_119);
    const occurrenceEventId = identifier(5_120);
    const duplicateEventId = identifier(5_121);
    const nullDigestEventId = identifier(5_126);
    insertReleaseManagerMembership(database, tenant, identifier(5_122));
    insertReadyBuild(database, tenant, firstBuildId, "1".repeat(40), ["1".repeat(40)]);
    insertReadyBuild(database, tenant, secondBuildId, "2".repeat(40), ["2".repeat(40)]);
    insertReadyBuild(database, foreignTenant, foreignBuildId, "3".repeat(40), ["3".repeat(40)]);
    insertBuildLineage(database, tenant, lineageId, "2026-08-25T02:00:00.000Z");
    insertBuildLineageEntry(
      database,
      tenant,
      lineageId,
      firstBuildId,
      null,
      1,
      firstEventId,
      "2026-08-25T02:01:00.000Z",
    );

    const missingDigest = probeSqlRejection(database, () => {
      insertBuildLineageEntry(
        database,
        tenant,
        lineageId,
        secondBuildId,
        firstBuildId,
        2,
        nullDigestEventId,
        "2026-08-25T02:01:05.000Z",
        null,
      );
    });
    assert.match(String(missingDigest), /contiguous server-ranked release fact/i);

    const inactivePrincipalCases = [
      {
        label: "disabled User",
        mutate: () => {
          const result = database
            .prepare(
              `UPDATE users SET status = 'disabled', updated_at = ?, version = 2
               WHERE id = ? AND version = 1`,
            )
            .run("2026-08-25T02:01:10.000Z", tenant.userId);
          assert.equal(result.changes, 1);
        },
      },
      {
        label: "disabled Account",
        mutate: () => {
          const result = database
            .prepare(
              `UPDATE accounts SET status = 'disabled', updated_at = ?, version = 2
               WHERE id = ? AND version = 1`,
            )
            .run("2026-08-25T02:01:20.000Z", tenant.accountId);
          assert.equal(result.changes, 1);
        },
      },
      {
        label: "archived Project",
        mutate: () => {
          const result = database
            .prepare(
              `UPDATE projects SET status = 'archived', updated_at = ?, version = 2
               WHERE id = ? AND version = 1`,
            )
            .run("2026-08-25T02:01:30.000Z", tenant.projectId);
          assert.equal(result.changes, 1);
        },
      },
    ];
    for (const [index, scenario] of inactivePrincipalCases.entries()) {
      const rejection = probeSqlRejection(database, () => {
        scenario.mutate();
        insertBuildLineageEntry(
          database,
          tenant,
          lineageId,
          secondBuildId,
          firstBuildId,
          2,
          identifier(5_123 + index),
          `2026-08-25T02:01:${40 + index}.000Z`,
        );
      });
      assert.match(
        String(rejection),
        /contiguous server-ranked release fact/i,
        `${scenario.label} recorded a Build lineage fact`,
      );
    }

    const gap = probeSqlRejection(database, () => {
      insertBuildLineageEntry(
        database,
        tenant,
        lineageId,
        secondBuildId,
        firstBuildId,
        3,
        gapEventId,
        "2026-08-25T02:02:00.000Z",
      );
    });
    assert.match(String(gap), /contiguous server-ranked release fact/i);

    const crossScope = probeSqlRejection(database, () => {
      insertBuildLineageEntry(
        database,
        tenant,
        lineageId,
        foreignBuildId,
        firstBuildId,
        2,
        crossScopeEventId,
        "2026-08-25T02:03:00.000Z",
      );
    });
    assert.match(String(crossScope), /contiguous server-ranked release fact/i);

    insertBuildLineageEntry(
      database,
      tenant,
      lineageId,
      secondBuildId,
      firstBuildId,
      2,
      secondEventId,
      "2026-08-25T02:04:00.000Z",
    );
    assert.match(
      String(
        probeSqlRejection(database, () => {
          database
            .prepare(
              `UPDATE build_lineage_entries SET created_at = ?
               WHERE account_id = ? AND project_id = ? AND lineage_id = ? AND ordinal = 2`,
            )
            .run("2026-08-25T02:05:00.000Z", tenant.accountId, tenant.projectId, lineageId);
        }),
      ),
      /Build lineage entries are immutable/i,
    );
    assert.match(
      String(
        probeSqlRejection(database, () => {
          database
            .prepare(
              `DELETE FROM build_lineage_entries
               WHERE account_id = ? AND project_id = ? AND lineage_id = ? AND ordinal = 2`,
            )
            .run(tenant.accountId, tenant.projectId, lineageId);
        }),
      ),
      /Build lineage entries are append-only/i,
    );

    createBug(database, tenant, bugId, "One occurrence append Event");
    for (const [index, scenario] of inactivePrincipalCases.entries()) {
      const rejection = probeSqlRejection(database, () => {
        scenario.mutate();
        appendOccurrenceEvidence(
          database,
          tenant,
          bugId,
          identifier(5_130 + index * 3),
          identifier(5_131 + index * 3),
          identifier(5_132 + index * 3),
          `2026-08-25T02:05:${10 + index}.000Z`,
          1,
          2,
          secondBuildId,
          10 + index,
        );
      });
      assert.match(
        String(rejection),
        /occurrence\.appended Event requires one same-scope persisted Occurrence/i,
        `${scenario.label} appended occurrence evidence`,
      );
    }
    appendOccurrenceEvidence(
      database,
      tenant,
      bugId,
      occurrenceId,
      submissionId,
      occurrenceEventId,
      "2026-08-25T02:06:00.000Z",
      1,
      2,
      secondBuildId,
      1,
    );
    const duplicateOccurrence = probeSqlRejection(database, () => {
      insertOccurrenceAppendEvent(
        database,
        tenant,
        bugId,
        occurrenceId,
        duplicateEventId,
        "2026-08-25T02:06:00.000Z",
        1,
        2,
        2,
      );
    });
    assert.match(
      String(duplicateOccurrence),
      /UNIQUE constraint failed: events\.account_id, events\.project_id, events\.resource_type, events\.resource_id/i,
    );
    assertIntegrity(database);
  });
});

test("forward v3 never reopens a no-Build closure from a later ranked Build occurrence", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_300, "NBR");
    const bugId = identifier(5_310);
    const attemptId = identifier(5_311);
    const requirementId = identifier(5_312);
    const verificationId = identifier(5_313);
    const startEventId = identifier(5_314);
    const closeEventId = identifier(5_315);
    const buildId = identifier(5_316);
    const lineageId = identifier(5_317);
    const lineageEventId = identifier(5_318);
    const occurrenceId = identifier(5_319);
    const submissionId = identifier(5_320);
    const occurrenceEventId = identifier(5_321);
    const reopenEventId = identifier(5_322);
    const verificationCreatedAt = "2026-08-25T01:00:00.000Z";
    const verificationStartedAt = "2026-08-25T01:10:00.000Z";
    const closedAt = "2026-08-25T01:20:00.000Z";
    const occurredAt = "2026-08-25T01:40:00.000Z";
    const reopenedAt = "2026-08-25T01:50:00.000Z";
    createBug(database, tenant, bugId, "No-Build closure cannot gain a Build baseline");
    seedTypedNoBuildRfvWorkflow(database, tenant, bugId, attemptId, requirementId, 5_330);
    insertVerification(
      database,
      tenant,
      bugId,
      attemptId,
      verificationId,
      tenant.userId,
      null,
      verificationCreatedAt,
      identifier(5_339),
    );
    database
      .prepare(
        `UPDATE bugs SET active_verification_id = ?, updated_at = ?, version = 5
         WHERE id = ? AND version = 4`,
      )
      .run(verificationId, verificationCreatedAt, bugId);
    insertVerificationStartEvent(
      database,
      tenant,
      bugId,
      verificationId,
      startEventId,
      verificationStartedAt,
      2,
    );
    database
      .prepare(
        `UPDATE verifications SET status = 'in_progress', updated_at = ?, version = 2
         WHERE id = ? AND version = 1`,
      )
      .run(verificationStartedAt, verificationId);
    transaction(database, () => {
      insertVerificationClosureEvent(
        database,
        tenant,
        bugId,
        attemptId,
        verificationId,
        closeEventId,
        closedAt,
        null,
        3,
      );
      database
        .prepare(
          `UPDATE verifications
           SET status = 'passed', result_summary = 'Human verification passed',
               updated_at = ?, version = 3
           WHERE id = ? AND version = 2`,
        )
        .run(closedAt, verificationId);
      database
        .prepare(
          `UPDATE bugs
           SET state = 'closed', active_repair_attempt_id = NULL,
               active_verification_id = NULL, closed_at = ?, updated_at = ?, version = 6
           WHERE id = ? AND version = 5`,
        )
        .run(closedAt, closedAt, bugId);
    });
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT baseline_kind AS baselineKind, baseline_build_id AS baselineBuildId
             FROM bug_closure_acceptances WHERE bug_id = ?`,
          )
          .get(bugId),
      },
      { baselineBuildId: null, baselineKind: "no_build" },
    );

    insertReleaseManagerMembership(database, tenant, identifier(5_323));
    insertReadyBuild(database, tenant, buildId, "4".repeat(40), ["4".repeat(40)]);
    insertBuildLineage(database, tenant, lineageId, "2026-08-25T01:30:00.000Z");
    insertBuildLineageEntry(
      database,
      tenant,
      lineageId,
      buildId,
      null,
      1,
      lineageEventId,
      "2026-08-25T01:31:00.000Z",
    );
    appendOccurrenceEvidence(
      database,
      tenant,
      bugId,
      occurrenceId,
      submissionId,
      occurrenceEventId,
      occurredAt,
      6,
      7,
      buildId,
      2,
    );
    const rejection = probeSqlRejection(database, () => {
      insertReopenEvent(database, tenant, bugId, occurrenceId, reopenEventId, reopenedAt, 7, 8, 3);
      database
        .prepare(
          `UPDATE bugs
           SET state = 'ready', closed_at = NULL, reopen_count = 1,
               updated_at = ?, version = 8
           WHERE id = ? AND version = 7`,
        )
        .run(reopenedAt, bugId);
    });
    assert.match(String(rejection), /later same-lineage server-ranked Build occurrence/i);
    assert.deepEqual(
      { ...database.prepare("SELECT state, version FROM bugs WHERE id = ?").get(bugId) },
      { state: "closed", version: 7 },
    );
    assertIntegrity(database);
  });
});

test("forward v3 rejects a naked Bug workflow jump without its typed audit Event", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 4_600, "FAP");
    const bugId = identifier(4_610);
    createBug(database, tenant, bugId, "Typed workflow defense Bug");

    const rejection = probeSqlRejection(database, () => {
      database
        .prepare(
          `UPDATE bugs
           SET state = 'deferred', updated_at = ?, version = 2
           WHERE id = ? AND version = 1`,
        )
        .run(UPDATED_AT, bugId);
    });
    assert.match(String(rejection), /Bug state transition requires its exact typed human audit/i);
    assert.deepEqual(
      { ...database.prepare("SELECT state, version FROM bugs WHERE id = ?").get(bugId) },
      { state: "reported", version: 1 },
    );
    assertIntegrity(database);
  });
});

test("forward v3 rejects naked same-state pointers and lifecycle shortcut DML", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 4_700, "DML");
    const runningBugId = identifier(4_710);
    const runningAttemptId = identifier(4_711);
    createBug(database, tenant, runningBugId, "Running DML defense Bug");
    seedTypedRunningWorkflow(database, tenant, runningBugId, runningAttemptId, 4_720);

    const pointerClear = probeSqlRejection(database, () => {
      database
        .prepare(
          `UPDATE bugs
           SET active_repair_attempt_id = NULL, updated_at = ?, version = 4
           WHERE id = ? AND version = 3`,
        )
        .run("2026-08-25T00:35:00.000Z", runningBugId);
    });
    assert.match(String(pointerClear), /same-state workflow pointers require their exact typed/i);

    const skippedAttemptVersion = probeSqlRejection(database, () => {
      database
        .prepare(
          `UPDATE repair_attempts
           SET updated_at = ?, version = 99
           WHERE id = ? AND version = 2`,
        )
        .run("2026-08-25T00:35:00.000Z", runningAttemptId);
    });
    assert.match(
      String(skippedAttemptVersion),
      /RepairAttempt lifecycle requires a forward exact-CAS/i,
    );

    const nakedDelivery = probeSqlRejection(database, () => {
      database
        .prepare(
          `UPDATE repair_attempts
           SET status = 'delivered', summary = 'Naked delivery',
               no_code_reason = 'No executable change', updated_at = ?, version = 3
           WHERE id = ? AND version = 2`,
        )
        .run("2026-08-25T00:35:00.000Z", runningAttemptId);
    });
    assert.match(String(nakedDelivery), /RepairAttempt lifecycle requires a forward exact-CAS/i);

    const terminalBugId = identifier(4_712);
    const terminalAttemptId = identifier(4_713);
    createBug(database, tenant, terminalBugId, "Terminal insert defense Bug");
    const terminalInsert = probeSqlRejection(database, () => {
      database
        .prepare(
          `INSERT INTO repair_attempts(
            id, account_id, project_id, bug_id, sequence, mode, status,
            assignee_id, summary, no_code_reason, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, 1, 'human', 'delivered', ?, 'Forged terminal',
            'No executable change', ?, ?, 3)`,
        )
        .run(
          terminalAttemptId,
          tenant.accountId,
          tenant.projectId,
          terminalBugId,
          tenant.userId,
          UPDATED_AT,
          UPDATED_AT,
        );
    });
    assert.match(
      String(terminalInsert),
      /RepairAttempt must begin as one neutral planned version-one fact/i,
    );

    const rfvBugId = identifier(4_714);
    const deliveredAttemptId = identifier(4_715);
    const requirementId = identifier(4_716);
    const verificationId = identifier(4_717);
    createBug(database, tenant, rfvBugId, "RFV DML defense Bug");
    seedTypedNoBuildRfvWorkflow(
      database,
      tenant,
      rfvBugId,
      deliveredAttemptId,
      requirementId,
      4_730,
    );

    const evidenceRewrite = probeSqlRejection(database, () => {
      database
        .prepare(
          `UPDATE repair_attempts
           SET summary = 'Rewritten delivery evidence', updated_at = ?, version = 4
           WHERE id = ? AND version = 3`,
        )
        .run("2026-08-25T00:45:00.000Z", deliveredAttemptId);
    });
    assert.match(String(evidenceRewrite), /immutable delivery evidence|RepairAttempt lifecycle/i);

    const nakedVerificationPointer = probeSqlRejection(database, () => {
      database
        .prepare(
          `UPDATE bugs
           SET active_verification_id = ?, updated_at = ?, version = 5
           WHERE id = ? AND version = 4`,
        )
        .run(identifier(4_719), "2026-08-25T00:45:00.000Z", rfvBugId);
    });
    assert.match(
      String(nakedVerificationPointer),
      /same-state workflow pointers require their exact typed|FOREIGN KEY constraint/i,
    );

    const directPassedVerification = probeSqlRejection(database, () => {
      database
        .prepare(
          `INSERT INTO verifications(
            id, account_id, project_id, bug_id, repair_attempt_id, status,
            verifier_id, criteria_snapshot, result_summary, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, 'passed', ?, 'Forged criteria', 'Forged pass', ?, ?, 2)`,
        )
        .run(
          identifier(4_718),
          tenant.accountId,
          tenant.projectId,
          rfvBugId,
          deliveredAttemptId,
          tenant.userId,
          "2026-08-25T00:45:00.000Z",
          "2026-08-25T00:45:00.000Z",
        );
    });
    assert.match(
      String(directPassedVerification),
      /Verification must begin as one requested version-one fact/i,
    );

    insertVerification(
      database,
      tenant,
      rfvBugId,
      deliveredAttemptId,
      verificationId,
      tenant.userId,
      null,
      "2026-08-25T00:50:00.000Z",
      identifier(4_739),
    );
    database
      .prepare(
        `UPDATE bugs
         SET active_verification_id = ?, updated_at = ?, version = 5
         WHERE id = ? AND version = 4`,
      )
      .run(verificationId, "2026-08-25T00:50:00.000Z", rfvBugId);
    const nakedVerificationClear = probeSqlRejection(database, () => {
      database
        .prepare(
          `UPDATE bugs
           SET active_verification_id = NULL, updated_at = ?, version = 6
           WHERE id = ? AND version = 5`,
        )
        .run("2026-08-25T00:55:00.000Z", rfvBugId);
    });
    assert.match(
      String(nakedVerificationClear),
      /same-state workflow pointers require their exact typed/i,
    );
    assertIntegrity(database);
  });
});

test("forward v3 allows only exact vendor supersede and blocked Verification pointer changes", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 4_800, "PTR");
    const vendorBugId = identifier(4_810);
    const replacedAttemptId = identifier(4_811);
    const successorAttemptId = identifier(4_812);
    const supersedeEventId = identifier(4_829);
    const supersededAt = "2026-08-25T00:40:00.000Z";
    createBug(database, tenant, vendorBugId, "Vendor successor pointer Bug");
    seedTypedRunningWorkflow(database, tenant, vendorBugId, replacedAttemptId, 4_820);
    insertBugWorkflowEvent(database, tenant, {
      aggregateId: replacedAttemptId,
      aggregateSequence: 3,
      aggregateType: "repair_attempt",
      bugId: vendorBugId,
      createdAt: supersededAt,
      eventId: supersedeEventId,
      eventType: "repair_attempt.superseded",
      fromState: null,
      payload: {
        status: "superseded",
        repairAttemptId: replacedAttemptId,
        reason: "Replace vendor execution",
        fromVersion: 2,
        toVersion: 3,
      },
      resourceId: replacedAttemptId,
      resourceType: "repair_attempt",
      resourceVersionAfter: 3,
      toState: null,
    });
    database
      .prepare(
        `UPDATE repair_attempts SET status = 'superseded', updated_at = ?, version = 3
         WHERE id = ? AND version = 2`,
      )
      .run(supersededAt, replacedAttemptId);
    database
      .prepare(
        `INSERT INTO repair_attempts(
          id, account_id, project_id, bug_id, sequence, mode, status,
          assignee_id, parent_attempt_id, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, 2, 'human', 'planned', ?, ?, ?, ?, 1)`,
      )
      .run(
        successorAttemptId,
        tenant.accountId,
        tenant.projectId,
        vendorBugId,
        tenant.userId,
        replacedAttemptId,
        supersededAt,
        supersededAt,
      );
    database
      .prepare(
        `UPDATE bugs SET active_repair_attempt_id = ?, updated_at = ?, version = 4
         WHERE id = ? AND version = 3`,
      )
      .run(successorAttemptId, supersededAt, vendorBugId);
    assert.equal(
      database.prepare("SELECT active_repair_attempt_id FROM bugs WHERE id = ?").get(vendorBugId)
        ?.active_repair_attempt_id,
      successorAttemptId,
    );

    const blockedBugId = identifier(4_813);
    const deliveredAttemptId = identifier(4_814);
    const requirementId = identifier(4_815);
    const verificationId = identifier(4_816);
    createBug(database, tenant, blockedBugId, "Blocked Verification pointer Bug");
    seedTypedNoBuildRfvWorkflow(
      database,
      tenant,
      blockedBugId,
      deliveredAttemptId,
      requirementId,
      4_840,
    );
    insertVerification(
      database,
      tenant,
      blockedBugId,
      deliveredAttemptId,
      verificationId,
      tenant.userId,
      null,
      "2026-08-25T00:50:00.000Z",
      identifier(4_847),
    );
    database
      .prepare(
        `UPDATE bugs SET active_verification_id = ?, updated_at = ?, version = 5
         WHERE id = ? AND version = 4`,
      )
      .run(verificationId, "2026-08-25T00:50:00.000Z", blockedBugId);
    insertVerificationStartEvent(
      database,
      tenant,
      blockedBugId,
      verificationId,
      identifier(4_848),
      "2026-08-25T01:00:00.000Z",
      2,
    );
    database
      .prepare(
        `UPDATE verifications SET status = 'in_progress', updated_at = ?, version = 2
         WHERE id = ? AND version = 1`,
      )
      .run("2026-08-25T01:00:00.000Z", verificationId);
    const blockedAt = "2026-08-25T01:10:00.000Z";
    insertBugWorkflowEvent(database, tenant, {
      aggregateId: verificationId,
      aggregateSequence: 3,
      aggregateType: "verification",
      bugId: blockedBugId,
      createdAt: blockedAt,
      eventId: identifier(4_849),
      eventType: "verification.result_recorded",
      fromState: "ready_for_verification",
      payload: {
        status: "blocked",
        summary: "Environment unavailable",
        reason: "Test device unavailable",
        verificationId,
        repairAttemptId: deliveredAttemptId,
        fromVersion: 2,
        toVersion: 3,
      },
      resourceId: verificationId,
      resourceType: "verification",
      resourceVersionAfter: 3,
      toState: "ready_for_verification",
    });
    database
      .prepare(
        `UPDATE verifications
         SET status = 'blocked', result_summary = 'Environment unavailable',
             blocked_reason = 'Test device unavailable', updated_at = ?, version = 3
         WHERE id = ? AND version = 2`,
      )
      .run(blockedAt, verificationId);
    database
      .prepare(
        `UPDATE bugs SET active_verification_id = NULL, updated_at = ?, version = 6
         WHERE id = ? AND version = 5`,
      )
      .run(blockedAt, blockedBugId);
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT state, active_repair_attempt_id AS activeRepairAttemptId,
                    active_verification_id AS activeVerificationId, version
             FROM bugs WHERE id = ?`,
          )
          .get(blockedBugId),
      },
      {
        activeRepairAttemptId: deliveredAttemptId,
        activeVerificationId: null,
        state: "ready_for_verification",
        version: 6,
      },
    );
    assertIntegrity(database);
  });
});

test("forward v3 rejects duplicate cycles, canonical repoints, and disabled workflow actors", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 4_900, "DUP");
    const canonicalBugId = identifier(4_910);
    const duplicateBugId = identifier(4_911);
    const alternateBugId = identifier(4_912);
    const actorBugId = identifier(4_913);
    createBug(database, tenant, canonicalBugId, "Canonical Bug");
    createBug(database, tenant, duplicateBugId, "Duplicate Bug");
    createBug(database, tenant, alternateBugId, "Alternate canonical Bug");
    createBug(database, tenant, actorBugId, "Disabled actor Bug");
    insertActiveMembershipRole(database, tenant, identifier(4_920), "triager");

    insertBugWorkflowEvent(database, tenant, {
      aggregateId: duplicateBugId,
      aggregateSequence: 1,
      aggregateType: "bug",
      bugId: duplicateBugId,
      createdAt: "2026-08-25T00:10:00.000Z",
      eventId: identifier(4_921),
      eventType: "bug.mark_duplicate",
      fromState: "reported",
      payload: {
        status: "duplicate",
        relatedBugId: canonicalBugId,
        reason: "Same regression",
        fromVersion: 1,
        toVersion: 2,
      },
      resourceId: duplicateBugId,
      resourceType: "bug",
      resourceVersionAfter: 2,
      toState: "duplicate",
    });
    database
      .prepare(
        `UPDATE bugs SET state = 'duplicate', duplicate_of_bug_id = ?, updated_at = ?, version = 2
         WHERE id = ? AND version = 1`,
      )
      .run(canonicalBugId, "2026-08-25T00:10:00.000Z", duplicateBugId);

    const canonicalRepoint = probeSqlRejection(database, () => {
      database
        .prepare(
          `UPDATE bugs SET duplicate_of_bug_id = ?, updated_at = ?, version = 3
           WHERE id = ? AND version = 2`,
        )
        .run(alternateBugId, "2026-08-25T00:20:00.000Z", duplicateBugId);
    });
    assert.match(
      String(canonicalRepoint),
      /same-state workflow pointers require their exact typed/i,
    );

    const cycle = probeSqlRejection(database, () => {
      insertBugWorkflowEvent(database, tenant, {
        aggregateId: canonicalBugId,
        aggregateSequence: 1,
        aggregateType: "bug",
        bugId: canonicalBugId,
        createdAt: "2026-08-25T00:30:00.000Z",
        eventId: identifier(4_922),
        eventType: "bug.mark_duplicate",
        fromState: "reported",
        payload: {
          status: "duplicate",
          relatedBugId: duplicateBugId,
          reason: "Cycle attempt",
          fromVersion: 1,
          toVersion: 2,
        },
        resourceId: canonicalBugId,
        resourceType: "bug",
        resourceVersionAfter: 2,
        toState: "duplicate",
      });
      database
        .prepare(
          `UPDATE bugs SET state = 'duplicate', duplicate_of_bug_id = ?, updated_at = ?, version = 2
           WHERE id = ? AND version = 1`,
        )
        .run(duplicateBugId, "2026-08-25T00:30:00.000Z", canonicalBugId);
    });
    assert.match(String(cycle), /canonical chain must remain acyclic/i);

    database
      .prepare(
        `UPDATE users SET status = 'disabled', updated_at = ?, version = 2
         WHERE id = ? AND version = 1`,
      )
      .run("2026-08-25T00:40:00.000Z", tenant.userId);
    const disabledActor = probeSqlRejection(database, () => {
      insertBugWorkflowEvent(database, tenant, {
        aggregateId: actorBugId,
        aggregateSequence: 1,
        aggregateType: "bug",
        bugId: actorBugId,
        createdAt: "2026-08-25T00:50:00.000Z",
        eventId: identifier(4_923),
        eventType: "bug.triage.ready",
        fromState: "reported",
        payload: { status: "ready", fromVersion: 1, toVersion: 2 },
        resourceId: actorBugId,
        resourceType: "bug",
        resourceVersionAfter: 2,
        toState: "ready",
      });
      database
        .prepare(
          `UPDATE bugs SET state = 'ready', updated_at = ?, version = 2
           WHERE id = ? AND version = 1`,
        )
        .run("2026-08-25T00:50:00.000Z", actorBugId);
    });
    assert.match(
      String(disabledActor),
      /Bug state transition requires its exact typed human audit/i,
    );
    assert.deepEqual(
      { ...database.prepare("SELECT state, version FROM bugs WHERE id = ?").get(actorBugId) },
      { state: "reported", version: 1 },
    );
    assertIntegrity(database);
  });
});

test("forward v3 rejects raw secrets in Event text while accepting explicit redaction", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 4_950, "PRV");
    const bugId = identifier(4_960);
    const eventId = identifier(4_961);
    const createdAt = "2026-08-25T01:20:00.000Z";
    createBug(database, tenant, bugId, "Event privacy policy Bug");

    for (const [index, rawSensitiveText] of [
      "Authorization: Bearer raw-test-token",
      "passwd=abc",
      "cookie=session",
      "apiKey=abc",
      "x-api-key: abc",
      "pwd=abc",
      "https://user:pass@example.invalid/private",
      "eyJabcdefgh.abcdef.abcdef",
    ].entries()) {
      const rejection = probeSqlRejection(database, () => {
        insertBugWorkflowEvent(database, tenant, {
          aggregateId: bugId,
          aggregateSequence: index + 1,
          aggregateType: "bug",
          bugId,
          createdAt,
          eventId: identifier(4_970 + index),
          eventType: "audit.redaction.checked",
          fromState: null,
          payload: {
            reason: rawSensitiveText,
            fromVersion: 1,
            toVersion: 1,
          },
          resourceId: bugId,
          resourceType: "bug",
          resourceVersionAfter: 1,
          toState: null,
        });
      });
      assert.match(
        String(rejection),
        /event payload violates bounded redacted audit policy/i,
        `${rawSensitiveText} bypassed raw-DML Event privacy`,
      );
    }

    const rawWindowsPath = probeSqlRejection(database, () => {
      insertBugWorkflowEvent(database, tenant, {
        aggregateId: bugId,
        aggregateSequence: 2,
        aggregateType: "bug",
        bugId,
        createdAt,
        eventId: identifier(4_962),
        eventType: "audit.redaction.checked",
        fromState: null,
        payload: {
          reason: "C:\\Users\\qa\\private-capture.png",
          fromVersion: 1,
          toVersion: 1,
        },
        resourceId: bugId,
        resourceType: "bug",
        resourceVersionAfter: 1,
        toState: null,
      });
    });
    assert.match(String(rawWindowsPath), /event payload violates bounded redacted audit policy/i);

    const rawSecretInStructuredKey = probeSqlRejection(database, () => {
      insertBugWorkflowEvent(database, tenant, {
        aggregateId: bugId,
        aggregateSequence: 3,
        aggregateType: "bug",
        bugId,
        createdAt,
        eventId: identifier(4_963),
        eventType: "audit.redaction.checked",
        fromState: null,
        payload: {
          status: "Authorization: Bearer raw-status-token",
          fromVersion: 1,
          toVersion: 1,
        },
        resourceId: bugId,
        resourceType: "bug",
        resourceVersionAfter: 1,
        toState: null,
      });
    });
    assert.match(
      String(rawSecretInStructuredKey),
      /event payload violates bounded redacted audit policy/i,
    );

    insertBugWorkflowEvent(database, tenant, {
      aggregateId: bugId,
      aggregateSequence: 1,
      aggregateType: "bug",
      bugId,
      createdAt,
      eventId,
      eventType: "audit.redaction.checked",
      fromState: null,
      payload: { reason: "[REDACTED]", fromVersion: 1, toVersion: 1 },
      resourceId: bugId,
      resourceType: "bug",
      resourceVersionAfter: 1,
      toState: null,
    });
    assert.equal(
      database
        .prepare("SELECT json_extract(payload_json, '$.reason') AS reason FROM events WHERE id = ?")
        .get(eventId)?.reason,
      "[REDACTED]",
    );
    assertIntegrity(database);
  });
});

test("forward v3 enforces the frozen 16-key Event payload boundary for raw DML", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_000, "EVP");
    const bugId = identifier(5_010);
    const createdAt = "2026-08-25T01:30:00.000Z";
    const validUuidV7 = "11111111-1111-7111-8111-111111111111";
    createBug(database, tenant, bugId, "Frozen Event payload Bug");

    const insertRawEvent = database.prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
        resource_type, resource_id, resource_version_after, correlation_id,
        payload_json, created_at
      ) VALUES (
        ?, ?, ?, ?, 'audit.payload.checked', 'qa_hub', 'user', ?,
        'bug', ?, ?, 'bug', ?, 1, ?, ?, ?
      )`,
    );
    const insertPayload = (
      eventId: string,
      aggregateSequence: number,
      payloadJson: string,
    ): void => {
      insertRawEvent.run(
        eventId,
        tenant.accountId,
        tenant.projectId,
        bugId,
        tenant.userId,
        bugId,
        aggregateSequence,
        bugId,
        identifier(5_999),
        payloadJson,
        createdAt,
      );
    };

    const validPayload = {
      summary: "Frozen payload accepted",
      reason: "All typed fields are valid",
      status: "ready_for_verification",
      relatedBugId: validUuidV7,
      repairAttemptId: validUuidV7,
      buildId: validUuidV7,
      verificationId: validUuidV7,
      attachmentId: validUuidV7,
      captureId: validUuidV7,
      handoffId: validUuidV7,
      commentId: validUuidV7,
      occurrenceId: validUuidV7,
      commitSha: "a".repeat(40),
      attachmentCount: 20,
      fromVersion: 1,
      toVersion: 2,
    };
    const validEventId = identifier(5_120);
    insertPayload(validEventId, 1, JSON.stringify(validPayload));
    assert.deepEqual(
      JSON.parse(
        String(
          database.prepare("SELECT payload_json FROM events WHERE id = ?").get(validEventId)
            ?.payload_json,
        ),
      ),
      validPayload,
    );

    const invalidPayloads: readonly (readonly [string, string])[] = [
      ["extra key", JSON.stringify({ status: "ready", actorId: validUuidV7 })],
      ["duplicate key", '{"status":"ready","status":"closed"}'],
      ["null value", JSON.stringify({ reason: null })],
      ["status type", JSON.stringify({ status: 1 })],
      ["status pattern", JSON.stringify({ status: "ready-for-verification" })],
      ["non-UUID reference", JSON.stringify({ relatedBugId: "not-a-uuid" })],
      [
        "UUID v0 reference",
        JSON.stringify({ relatedBugId: "11111111-1111-0111-8111-111111111111" }),
      ],
      [
        "UUID v9 reference",
        JSON.stringify({ relatedBugId: "11111111-1111-9111-8111-111111111111" }),
      ],
      [
        "UUID bad variant",
        JSON.stringify({ relatedBugId: "11111111-1111-7111-7111-111111111111" }),
      ],
      ["uppercase commit SHA", JSON.stringify({ commitSha: "A".repeat(40) })],
      ["non-hex commit SHA", JSON.stringify({ commitSha: "g".repeat(40) })],
      ["fractional attachment count", JSON.stringify({ attachmentCount: 1.5 })],
      ["negative attachment count", JSON.stringify({ attachmentCount: -1 })],
      ["oversized attachment count", JSON.stringify({ attachmentCount: 21 })],
      ["non-positive fromVersion", JSON.stringify({ fromVersion: 0 })],
      ["fractional fromVersion", JSON.stringify({ fromVersion: 1.5 })],
      ["non-positive toVersion", JSON.stringify({ toVersion: 0 })],
      ["fractional toVersion", JSON.stringify({ toVersion: 1.5 })],
    ];
    const payloadPolicyError = /(?:event payload violates .*audit|event payload.*frozen)/i;
    for (const [index, [label, payloadJson]] of invalidPayloads.entries()) {
      const rejection = probeSqlRejection(database, () => {
        insertPayload(identifier(5_130 + index), index + 2, payloadJson);
      });
      assert.notEqual(rejection, undefined, `${label} bypassed the frozen Event payload boundary`);
      assert.match(String(rejection), payloadPolicyError, label);
    }

    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count FROM events
           WHERE account_id = ? AND aggregate_type = 'bug' AND aggregate_id = ?`,
        )
        .get(tenant.accountId, bugId)?.count,
      1,
    );
    assertIntegrity(database);
  });
});

test("forward v3 requires current reporter authority for an occurrence append Event", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_200, "ORP");
    const bugId = identifier(5_210);
    const occurrenceId = identifier(5_211);
    const submissionId = identifier(5_212);
    const eventId = identifier(5_213);
    const createdAt = "2026-08-25T01:40:00.000Z";
    createBug(database, tenant, bugId, "Viewer cannot append an Occurrence");
    insertActiveMembershipRole(
      database,
      tenant,
      identifier(5_214),
      "viewer",
      tenant.secondaryUserId,
    );
    database
      .prepare(
        `INSERT INTO occurrences(
          id, account_id, project_id, bug_id, reporter_id, client_submission_id,
          observed_at, platform, steps_json, actual_behavior, environment_json,
          created_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'android', ?, ?, NULL, ?, 1)`,
      )
      .run(
        occurrenceId,
        tenant.accountId,
        tenant.projectId,
        bugId,
        tenant.secondaryUserId,
        submissionId,
        createdAt,
        JSON.stringify(["Observe without reporter authority"]),
        "Viewer-only evidence must not become an append Event",
        createdAt,
      );

    const viewerAppend = probeSqlRejection(database, () => {
      database
        .prepare(
          `INSERT INTO events(
            id, account_id, project_id, bug_id, type, source, actor_type,
            actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
            resource_type, resource_id, resource_version_after, request_digest,
            correlation_id, payload_json, created_at
          ) VALUES (
            ?, ?, ?, ?, 'occurrence.appended', 'qa_hub', 'user', ?,
            'bug', ?, 1, 'occurrence', ?, 1, ?, ?, ?, ?
          )`,
        )
        .run(
          eventId,
          tenant.accountId,
          tenant.projectId,
          bugId,
          tenant.secondaryUserId,
          bugId,
          occurrenceId,
          digest(5_213),
          identifier(5_215),
          JSON.stringify({ occurrenceId, fromVersion: 1, toVersion: 2 }),
          createdAt,
        );
    });
    assert.match(
      String(viewerAppend),
      /occurrence\.appended Event requires one same-scope persisted Occurrence/i,
    );
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM events WHERE id = ?").get(eventId)?.count,
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM occurrence_build_lineage_facts WHERE occurrence_id = ?",
        )
        .get(occurrenceId)?.count,
      0,
    );
    assertIntegrity(database);
  });
});

test("forward v3 requires developer authority for a RepairAttempt assignee", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_300, "RDA");
    const bugId = identifier(5_310);
    const attemptId = identifier(5_311);
    const eventId = identifier(5_312);
    const createdAt = "2026-08-25T01:50:00.000Z";
    createBug(database, tenant, bugId, "Verifier-only assignee is not a developer");
    insertActiveMembershipRole(database, tenant, identifier(5_313), "developer");
    insertActiveMembershipRole(
      database,
      tenant,
      identifier(5_314),
      "verifier",
      tenant.secondaryUserId,
    );

    const verifierOnlyAssignee = probeSqlRejection(database, () => {
      insertBugWorkflowEvent(database, tenant, {
        aggregateId: attemptId,
        aggregateSequence: 1,
        aggregateType: "repair_attempt",
        bugId,
        createdAt,
        eventId,
        eventType: "repair_attempt.created",
        fromState: "ready",
        payload: { status: "planned", repairAttemptId: attemptId, fromVersion: 1, toVersion: 2 },
        resourceId: attemptId,
        resourceType: "repair_attempt",
        resourceVersionAfter: 1,
        toState: "in_progress",
      });
      database
        .prepare(
          `INSERT INTO repair_attempts(
            id, account_id, project_id, bug_id, sequence, mode, status,
            assignee_id, summary, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, 1, 'human', 'planned', ?, ?, ?, ?, 1)`,
        )
        .run(
          attemptId,
          tenant.accountId,
          tenant.projectId,
          bugId,
          tenant.secondaryUserId,
          "Verifier-only target",
          createdAt,
          createdAt,
        );
    });
    assert.match(
      String(verifierOnlyAssignee),
      /RepairAttempt must begin as one neutral planned version-one fact/i,
    );
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM repair_attempts WHERE id = ?").get(attemptId)
        ?.count,
      0,
    );
    assertIntegrity(database);
  });
});

test("multi-actor no-code human workflow can be managed by any project member", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_400, "MHW");
    const bugId = identifier(5_410);
    const workflowAt = "2026-08-26T02:00:00.000Z";
    const primaryScope = {
      accountId: tenant.accountId,
      projectId: tenant.projectId,
      actorId: tenant.userId,
    } as const;
    const developerScope = {
      accountId: tenant.accountId,
      projectId: tenant.projectId,
      actorId: tenant.secondaryUserId,
    } as const;
    const observerId = identifier(5_415);
    const observerScope = {
      accountId: tenant.accountId,
      projectId: tenant.projectId,
      actorId: observerId,
    } as const;

    database
      .prepare(
        `INSERT INTO users(
          id, account_id, email, display_name, status, created_at, updated_at, version
        ) VALUES (?, ?, ?, 'Project observer', 'active', ?, ?, 1)`,
      )
      .run(observerId, tenant.accountId, "observer-5400@example.invalid", CREATED_AT, CREATED_AT);
    insertActiveMembershipRole(database, tenant, identifier(5_416), "viewer", observerId);

    insertActiveMembershipRole(database, tenant, identifier(5_411), "triager");
    insertActiveMembershipRole(database, tenant, identifier(5_412), "reporter");
    insertActiveMembershipRole(
      database,
      tenant,
      identifier(5_413),
      "developer",
      tenant.secondaryUserId,
    );
    insertActiveMembershipRole(
      database,
      tenant,
      identifier(5_414),
      "verifier",
      tenant.secondaryUserId,
    );
    createBug(database, tenant, bugId, "No-code reporter verification workflow", {
      ownerId: tenant.userId,
      verificationOwnerId: tenant.secondaryUserId,
    });

    const readyBug = transaction(database, () =>
      transitionMobileBugReady(database, {
        ...primaryScope,
        bugId,
        expectedVersion: 1,
        idempotencyKey: "workflow-ready",
        requestDigest: digest(5_420),
        createdAt: workflowAt,
      }),
    );
    assert.equal(readyBug.state, "ready");

    for (const createAttempt of [createMobileRelayAttempt, createMobileManualRepairAttempt]) {
      assert.throws(
        () =>
          transaction(database, () =>
            createAttempt(database, {
              ...primaryScope,
              bugId,
              expectedVersion: readyBug.version,
              assigneeId: tenant.userId,
              summary: "A non-developer must not be assignable",
              idempotencyKey: "invalid-assignee",
              requestDigest: digest(5_421),
              createdAt: workflowAt,
            }),
          ),
        /assigneeId must be an active developer/i,
      );
    }

    const deliverNoCode = (expectedBugVersion: number, attemptDigestBase: number) => {
      const noCodeReason = "No source change was required; configuration only. ".repeat(70);
      const attempt = transaction(database, () =>
        createMobileManualRepairAttempt(database, {
          ...primaryScope,
          bugId,
          expectedVersion: expectedBugVersion,
          assigneeId: tenant.secondaryUserId,
          summary: "Configuration-only repair",
          idempotencyKey: `create-attempt-${attemptDigestBase}`,
          requestDigest: digest(attemptDigestBase),
          createdAt: workflowAt,
        }),
      );
      assert.equal(attempt.assigneeId, tenant.secondaryUserId);
      const running = transaction(database, () =>
        startMobileRepairAttempt(database, {
          ...developerScope,
          attemptId: attempt.id,
          expectedVersion: attempt.version,
          reason: "Begin the assigned configuration repair",
          idempotencyKey: `start-attempt-${attemptDigestBase}`,
          requestDigest: digest(attemptDigestBase + 1),
          createdAt: workflowAt,
        }),
      );
      const delivered = transaction(database, () =>
        deliverMobileRepairAttempt(database, {
          ...developerScope,
          attemptId: attempt.id,
          expectedVersion: running.version,
          deliveryKind: "no_code",
          branch: null,
          commitSha: null,
          mergeRequestUrl: null,
          patchUrl: null,
          noCodeReason,
          summary: "Feature flag corrected without a code change",
          idempotencyKey: `deliver-attempt-${attemptDigestBase}`,
          requestDigest: digest(attemptDigestBase + 2),
          createdAt: workflowAt,
        }),
      );
      assert.equal(delivered.status, "delivered");
      assert.equal(delivered.commitSha, null);
      assert.equal(delivered.noCodeReason, noCodeReason);
      const deliveryAuditReason = String(
        database
          .prepare(
            `SELECT json_extract(payload_json, '$.reason') AS reason
             FROM events
             WHERE aggregate_type = 'repair_attempt' AND aggregate_id = ?
               AND type = 'repair_attempt.delivered'`,
          )
          .get(attempt.id)?.reason,
      );
      assert.ok(Buffer.byteLength(deliveryAuditReason, "utf8") <= 2_000);
      assert.match(deliveryAuditReason, /…$/u);
      assert.deepEqual(
        {
          ...database
            .prepare(
              `SELECT requirement, decision_basis AS decisionBasis,
                      delivered_commit_sha AS deliveredCommitSha, linked_build_id AS linkedBuildId
               FROM build_requirements WHERE repair_attempt_id = ?`,
            )
            .get(attempt.id),
        },
        {
          requirement: "not_required",
          decisionBasis: "no_code_delivery",
          deliveredCommitSha: null,
          linkedBuildId: null,
        },
      );
      const bug = database
        .prepare(
          `SELECT state, version, active_repair_attempt_id AS activeRepairAttemptId,
                  active_verification_id AS activeVerificationId
           FROM bugs WHERE id = ?`,
        )
        .get(bugId) as {
        readonly state: string;
        readonly version: number;
        readonly activeRepairAttemptId: string | null;
        readonly activeVerificationId: string | null;
      };
      assert.equal(bug.state, "ready_for_verification");
      assert.equal(bug.activeRepairAttemptId, attempt.id);
      assert.equal(bug.activeVerificationId, null);
      return { attempt: delivered, bug };
    };

    const rejectedTarget = deliverNoCode(readyBug.version, 5_430);
    const rejectedVerification = transaction(database, () =>
      createMobileVerification(database, {
        ...primaryScope,
        bugId,
        expectedVersion: rejectedTarget.bug.version,
        repairAttemptId: rejectedTarget.attempt.id,
        buildId: null,
        verifierId: tenant.secondaryUserId,
        criteria: "Reporter confirms the configuration behavior",
        idempotencyKey: "create-rejected-verification",
        requestDigest: digest(5_440),
        createdAt: workflowAt,
      }),
    );
    assert.equal(rejectedVerification.verifierId, tenant.secondaryUserId);
    assert.equal(rejectedVerification.buildId, null);
    const startedRejectedVerification = transaction(database, () =>
      startMobileVerification(database, {
        ...developerScope,
        verificationId: rejectedVerification.id,
        expectedVersion: rejectedVerification.version,
        reason: "Run the reporter's acceptance scenario",
        idempotencyKey: "start-rejected-verification",
        requestDigest: digest(5_441),
        createdAt: workflowAt,
      }),
    );
    const failedSubmissionId = identifier(5_442);
    const failureReason = "Feature flag propagation did not reach the target environment. ".repeat(
      55,
    );
    const failedRequest = {
      ...primaryScope,
      verificationId: rejectedVerification.id,
      expectedVersion: startedRejectedVerification.version,
      status: "failed" as const,
      resultSummary: "The original behavior is still reproducible",
      failureReason,
      clientSubmissionId: failedSubmissionId,
      attachmentIds: [] as const,
      captureBundleId: null,
      idempotencyKey: "reporter-rejects-verification",
      requestDigest: digest(5_443),
      createdAt: workflowAt,
    };
    const failedResult = transaction(database, () =>
      recordMobileVerificationResult(database, failedRequest),
    );
    assert.equal(failedResult.verification.status, "failed");
    assert.equal(failedResult.verification.failureReason, failureReason);
    const failureAuditReason = String(
      database
        .prepare(
          `SELECT json_extract(payload_json, '$.reason') AS reason
           FROM events
           WHERE aggregate_type = 'verification' AND aggregate_id = ?
             AND type = 'verification.result_recorded'`,
        )
        .get(rejectedVerification.id)?.reason,
    );
    assert.ok(Buffer.byteLength(failureAuditReason, "utf8") <= 1_500);
    assert.match(failureAuditReason, /…$/u);
    assert.equal(failedResult.repairAttempt.status, "verification_failed");
    assert.equal(failedResult.bug.state, "ready");
    assert.equal(failedResult.replayed, false);
    const failedReplay = transaction(database, () =>
      recordMobileVerificationResult(database, failedRequest),
    );
    assert.equal(failedReplay.replayed, true);
    assert.equal(failedReplay.eventId, failedResult.eventId);
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT active_repair_attempt_id AS activeRepairAttemptId,
                    active_verification_id AS activeVerificationId
             FROM bugs WHERE id = ?`,
          )
          .get(bugId),
      },
      { activeRepairAttemptId: null, activeVerificationId: null },
    );

    const passedTarget = deliverNoCode(failedResult.bug.version, 5_450);
    const passedVerification = transaction(database, () =>
      createMobileVerification(database, {
        ...primaryScope,
        bugId,
        expectedVersion: passedTarget.bug.version,
        repairAttemptId: passedTarget.attempt.id,
        buildId: null,
        verifierId: tenant.secondaryUserId,
        criteria: "Reporter confirms the corrected configuration behavior",
        idempotencyKey: "create-passed-verification",
        requestDigest: digest(5_460),
        createdAt: workflowAt,
      }),
    );
    const startedPassedVerification = transaction(database, () =>
      startMobileVerification(database, {
        ...observerScope,
        verificationId: passedVerification.id,
        expectedVersion: passedVerification.version,
        reason: null,
        idempotencyKey: "start-passed-verification",
        requestDigest: digest(5_461),
        createdAt: workflowAt,
      }),
    );
    const passedResult = transaction(database, () =>
      recordMobileVerificationResult(database, {
        ...observerScope,
        verificationId: passedVerification.id,
        expectedVersion: startedPassedVerification.version,
        status: "passed",
        resultSummary: "Reporter confirms the Bug is fixed",
        failureReason: null,
        clientSubmissionId: identifier(5_462),
        attachmentIds: [],
        captureBundleId: null,
        idempotencyKey: "reporter-passes-verification",
        requestDigest: digest(5_463),
        createdAt: workflowAt,
      }),
    );
    assert.equal(passedResult.verification.status, "passed");
    assert.equal(passedResult.repairAttempt.status, "delivered");
    assert.equal(passedResult.bug.state, "closed");
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT baseline_kind AS baselineKind, baseline_build_id AS baselineBuildId
             FROM bug_closure_acceptances WHERE bug_id = ?`,
          )
          .get(bugId),
      },
      { baselineBuildId: null, baselineKind: "no_build" },
    );
    const notificationAt = "2026-08-26T02:01:00.000Z";
    const ownerInbox = transaction(database, () =>
      syncAndListMobileNotifications(database, {
        ...primaryScope,
        limit: 100,
        now: notificationAt,
      }),
    );
    const verifierInbox = transaction(database, () =>
      syncAndListMobileNotifications(database, {
        ...developerScope,
        limit: 100,
        now: notificationAt,
      }),
    );
    const ownerCompleted = ownerInbox.items.find(
      (item) => item.type === "verification.result_recorded" && item.title === "单子已完成",
    );
    const verifierCompleted = verifierInbox.items.find(
      (item) => item.type === "verification.result_recorded" && item.title === "单子已完成",
    );
    assert.equal(ownerCompleted?.body, "MHW-1 · Invariant regression record");
    assert.equal(verifierCompleted?.body, "MHW-1 · Invariant regression record");
    assert.equal(
      verifierInbox.items.some(
        (item) => item.type === "repair_attempt.delivered" && item.title === "有一个单子待你验收",
      ),
      true,
    );
    assert.equal(
      ownerInbox.items.some(
        (item) =>
          item.type === "verification.result_recorded" && item.title === "验收未通过，已退回",
      ),
      true,
    );
    assertIntegrity(database);
  });
});

test("any project member can soft-delete a Bug and hide it from reads", async () => {
  await withDatabase((database) => {
    const tenant = seedTenant(database, 5_500, "DELETE");
    const bugId = identifier(5_510);
    insertActiveMembershipRole(
      database,
      tenant,
      identifier(5_511),
      "viewer",
      tenant.secondaryUserId,
    );
    createBug(database, tenant, bugId, "Delete from details", {
      ownerId: tenant.userId,
      verificationOwnerId: tenant.userId,
    });
    const input = {
      accountId: tenant.accountId,
      projectId: tenant.projectId,
      actorId: tenant.secondaryUserId,
      bugId,
      expectedVersion: 1,
      idempotencyKey: `web:deleteBug:bug:${bugId}:v1`,
      requestDigest: digest(5_512),
      createdAt: UPDATED_AT,
    } as const;

    const deleted = transaction(database, () => deleteMobileBug(database, input));
    assert.deepEqual(deleted, { bugId, deletedAt: UPDATED_AT, replayed: false });
    const replay = transaction(database, () => deleteMobileBug(database, input));
    assert.equal(replay.replayed, true);
    assert.equal(
      getMobileBug(database, { accountId: tenant.accountId, projectId: tenant.projectId }, bugId),
      null,
    );
    assert.equal(
      listMobileBugs(database, {
        accountId: tenant.accountId,
        projectId: tenant.projectId,
        actorId: tenant.secondaryUserId,
        limit: 100,
      }).items.length,
      0,
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT bug_version AS bugVersion, deleted_by_actor_id AS actorId
             FROM bug_deletions WHERE bug_id = ?`,
          )
          .get(bugId),
      },
      { actorId: tenant.secondaryUserId, bugVersion: 1 },
    );
    assertIntegrity(database);
  });
});
