import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { insertBugWithNextNumber, SqliteStorageError } from "./sqlite.js";
import { MobileRelayStorageError } from "./mobile-relay-store.js";

const NOTIFICATION_DESTINATION = "qa-hub.notifications";

export interface MobileScopeBootstrap {
  readonly accountId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly membershipId: string;
  readonly projectKey: string;
  readonly createdAt: string;
  readonly actorDisplayName?: string;
  readonly actorEmail?: string;
}

export interface MobileOccurrenceInput {
  readonly observedAt: string;
  readonly platform: "android" | "ios" | "windows" | "macos" | "linux" | "web" | "other";
  readonly appVersion?: string;
  readonly resourceVersion?: string;
  readonly gitSha?: string;
  readonly deviceModel?: string;
  readonly osVersion?: string;
  readonly steps: readonly string[];
  readonly actualBehavior: string;
  readonly frequency?: string;
  readonly errorSignature?: string;
  readonly environment?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CreateMobileBugInput {
  readonly accountId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly clientSubmissionId: string;
  readonly payloadDigest: string;
  readonly title: string;
  readonly description: string;
  readonly expectedBehavior: string;
  readonly severity: "S0" | "S1" | "S2" | "S3" | "S4";
  readonly priority: "P0" | "P1" | "P2" | "P3" | "P4";
  readonly ownerId: string | null;
  readonly verificationOwnerId: string | null;
  readonly occurrence: MobileOccurrenceInput;
  readonly attachmentIds: readonly string[];
  readonly captureBundleId: string | null;
  readonly createdAt: string;
}

export interface MobileBugRecord {
  readonly id: string;
  readonly projectId: string;
  readonly number: number;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly expectedBehavior: string;
  readonly moduleId: string | null;
  readonly state:
    | "reported"
    | "needs_info"
    | "ready"
    | "in_progress"
    | "awaiting_build"
    | "ready_for_verification"
    | "closed"
    | "deferred"
    | "rejected"
    | "duplicate";
  readonly severity: "S0" | "S1" | "S2" | "S3" | "S4";
  readonly priority: "P0" | "P1" | "P2" | "P3" | "P4";
  readonly reporterId: string;
  readonly ownerId: string | null;
  readonly verificationOwnerId: string | null;
  readonly duplicateOfBugId: string | null;
  readonly occurrenceCount: number;
  readonly reopenCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface MobileBugCreation {
  readonly clientSubmissionId: string;
  readonly bug: MobileBugRecord;
  readonly occurrenceId: string;
  readonly eventId: string;
  readonly attachmentIds: readonly string[];
  readonly captureBundleId: string | null;
  readonly replayed: boolean;
}

export interface DeleteMobileBugInput {
  readonly accountId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly bugId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export interface MobileBugDeletion {
  readonly bugId: string;
  readonly deletedAt: string;
  readonly replayed: boolean;
}

interface MobileBugRow {
  readonly id: string;
  readonly project_id: string;
  readonly number: number;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly expected_behavior: string;
  readonly module_id: string | null;
  readonly state: MobileBugRecord["state"];
  readonly severity: MobileBugRecord["severity"];
  readonly priority: MobileBugRecord["priority"];
  readonly reporter_id: string;
  readonly owner_id: string | null;
  readonly verification_owner_id: string | null;
  readonly duplicate_of_bug_id: string | null;
  readonly occurrence_count: number;
  readonly reopen_count: number;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
}

function requireTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) {
    throw new SqliteStorageError(
      "SQLITE_TRANSACTION_REQUIRED",
      "mobile Bug storage requires the caller's write transaction",
    );
  }
}

function readBug(
  database: DatabaseSync,
  accountId: string,
  projectId: string,
  bugId: string,
): MobileBugRecord | null {
  const row = database
    .prepare(
      `SELECT id, project_id, number, key, title, description, expected_behavior,
              module_id, state, severity, priority, reporter_id, owner_id,
              verification_owner_id, duplicate_of_bug_id, occurrence_count,
              reopen_count, version, created_at, updated_at, closed_at
       FROM bugs
       WHERE account_id = ? AND project_id = ? AND id = ?
         AND NOT EXISTS (
           SELECT 1 FROM bug_deletions AS deletion
           WHERE deletion.account_id = bugs.account_id
             AND deletion.project_id = bugs.project_id
             AND deletion.bug_id = bugs.id
         )`,
    )
    .get(accountId, projectId, bugId) as MobileBugRow | undefined;
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    key: row.key,
    title: row.title,
    description: row.description,
    expectedBehavior: row.expected_behavior,
    moduleId: row.module_id,
    state: row.state,
    severity: row.severity,
    priority: row.priority,
    reporterId: row.reporter_id,
    ownerId: row.owner_id,
    verificationOwnerId: row.verification_owner_id,
    duplicateOfBugId: row.duplicate_of_bug_id,
    occurrenceCount: row.occurrence_count,
    reopenCount: row.reopen_count,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  });
}

function assertInitialAssignment(
  database: DatabaseSync,
  input: CreateMobileBugInput,
  userId: string | null,
  roles: readonly string[],
  label: string,
): void {
  if (userId === null) return;
  const placeholders = roles.map(() => "?").join(", ");
  const row = database
    .prepare(
      `SELECT 1 AS assignable
       FROM users AS user
       JOIN memberships AS membership
         ON membership.account_id = user.account_id
        AND membership.user_id = user.id
        AND membership.project_id = ?
        AND membership.status = 'active'
       JOIN membership_roles AS role
         ON role.account_id = membership.account_id
        AND role.project_id = membership.project_id
        AND role.membership_id = membership.id
        AND role.role IN (${placeholders})
       WHERE user.account_id = ? AND user.id = ? AND user.status = 'active'
       LIMIT 1`,
    )
    .get(input.projectId, ...roles, input.accountId, userId);
  if (!row) {
    throw Object.assign(new Error(`${label} is not an assignable project member`), {
      code: "INVALID_REQUEST",
    });
  }
}

export function ensureMobileScope(database: DatabaseSync, scope: MobileScopeBootstrap): void {
  requireTransaction(database);
  const suffix = scope.accountId.replaceAll("-", "").slice(-12).toLowerCase();
  const actorDisplayName = scope.actorDisplayName ?? "MuMu MVP reporter";
  const actorEmail = scope.actorEmail ?? `mvp-${scope.actorId.replaceAll("-", "")}@local.invalid`;
  database
    .prepare(
      `INSERT OR IGNORE INTO accounts(
        id, slug, display_name, status, created_at, updated_at, version
      ) VALUES (?, ?, 'MuMu MVP account', 'active', ?, ?, 1)`,
    )
    .run(scope.accountId, `mvp-${suffix}`, scope.createdAt, scope.createdAt);
  database
    .prepare(
      `INSERT OR IGNORE INTO users(
        id, account_id, email, display_name, status, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
    )
    .run(
      scope.actorId,
      scope.accountId,
      actorEmail,
      actorDisplayName,
      scope.createdAt,
      scope.createdAt,
    );
  database
    .prepare(
      `UPDATE users
       SET email = ?, display_name = ?, updated_at = ?, version = version + 1
       WHERE account_id = ? AND id = ? AND status = 'active'
         AND (email <> ? OR display_name <> ?)`,
    )
    .run(
      actorEmail,
      actorDisplayName,
      scope.createdAt,
      scope.accountId,
      scope.actorId,
      actorEmail,
      actorDisplayName,
    );
  database
    .prepare(
      `INSERT OR IGNORE INTO projects(
        id, account_id, project_key, name, status, created_at, updated_at, version
      ) VALUES (?, ?, ?, 'MuMu MVP project', 'active', ?, ?, 1)`,
    )
    .run(scope.projectId, scope.accountId, scope.projectKey, scope.createdAt, scope.createdAt);
  database
    .prepare(
      `INSERT OR IGNORE INTO memberships(
        id, account_id, project_id, user_id, status, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
    )
    .run(
      scope.membershipId,
      scope.accountId,
      scope.projectId,
      scope.actorId,
      scope.createdAt,
      scope.createdAt,
    );
  database
    .prepare(
      `INSERT OR IGNORE INTO membership_roles(
        account_id, project_id, membership_id, role, granted_at
      ) VALUES (?, ?, ?, 'reporter', ?)`,
    )
    .run(scope.accountId, scope.projectId, scope.membershipId, scope.createdAt);

  const exact = database
    .prepare(
      `SELECT 1 AS present
       FROM accounts AS account
       JOIN projects AS project ON project.account_id = account.id AND project.id = ?
       JOIN users AS actor ON actor.account_id = account.id AND actor.id = ?
       JOIN memberships AS membership
         ON membership.account_id = account.id
        AND membership.project_id = project.id
        AND membership.user_id = actor.id
        AND membership.status = 'active'
       JOIN membership_roles AS role
         ON role.account_id = account.id
        AND role.project_id = project.id
        AND role.membership_id = membership.id
        AND role.role = 'reporter'
       WHERE account.id = ? AND account.status = 'active'
         AND project.project_key = ? AND project.status = 'active'
         AND actor.status = 'active'`,
    )
    .get(scope.projectId, scope.actorId, scope.accountId, scope.projectKey);
  if (!exact) {
    throw new SqliteStorageError(
      "SQLITE_MOBILE_SCOPE_CONFLICT",
      "mobile scope conflicts with existing tenant identity",
    );
  }
}

function loadCreation(
  database: DatabaseSync,
  input: Pick<CreateMobileBugInput, "accountId" | "projectId" | "actorId" | "clientSubmissionId">,
  replayed: boolean,
): MobileBugCreation | null {
  const effect = database
    .prepare(
      `SELECT submission.bug_id AS bug_id,
              occurrence.id AS occurrence_id,
              event.id AS event_id,
              occurrence.capture_bundle_id AS capture_bundle_id
       FROM submissions AS submission
       JOIN occurrences AS occurrence
         ON occurrence.account_id = submission.account_id
        AND occurrence.project_id = submission.project_id
        AND occurrence.bug_id = submission.bug_id
        AND occurrence.client_submission_id = submission.client_submission_id
       JOIN events AS event
         ON event.account_id = occurrence.account_id
        AND event.project_id = occurrence.project_id
        AND event.type = 'occurrence.appended'
        AND event.resource_type = 'occurrence'
        AND event.resource_id = occurrence.id
       WHERE submission.account_id = ?
         AND submission.project_id = ?
         AND submission.actor_id = ?
         AND submission.client_submission_id = ?
         AND submission.intent = 'bug_create'`,
    )
    .get(input.accountId, input.projectId, input.actorId, input.clientSubmissionId) as
    | {
        readonly bug_id: string;
        readonly occurrence_id: string;
        readonly event_id: string;
        readonly capture_bundle_id: string | null;
      }
    | undefined;
  if (!effect) return null;
  const bug = readBug(database, input.accountId, input.projectId, effect.bug_id);
  if (!bug)
    throw new SqliteStorageError("SQLITE_EFFECT_MISSING", "mobile Bug effect is incomplete");
  const attachmentIds = database
    .prepare(
      `SELECT attachment_id
       FROM bug_attachments
       WHERE account_id = ? AND project_id = ? AND bug_id = ?
       ORDER BY attachment_id`,
    )
    .all(input.accountId, input.projectId, bug.id)
    .map((row) => String(row.attachment_id));
  return Object.freeze({
    clientSubmissionId: input.clientSubmissionId,
    bug,
    occurrenceId: effect.occurrence_id,
    eventId: effect.event_id,
    attachmentIds: Object.freeze(attachmentIds),
    captureBundleId: effect.capture_bundle_id,
    replayed,
  });
}

function claimBugAttachments(
  database: DatabaseSync,
  input: CreateMobileBugInput,
  bugId: string,
): void {
  if (new Set(input.attachmentIds).size !== input.attachmentIds.length) {
    throw new SqliteStorageError(
      "SQLITE_ATTACHMENT_RESERVATION_INVALID",
      "Bug attachments must be unique",
    );
  }
  for (const attachmentId of input.attachmentIds) {
    const reservation = database
      .prepare(
        `SELECT binding.id AS binding_id, binding.version AS binding_version,
                attachment.version AS attachment_version
         FROM attachments AS attachment
         JOIN attachment_bindings AS binding
           ON binding.account_id = attachment.account_id
          AND binding.project_id = attachment.project_id
          AND binding.attachment_id = attachment.id
         JOIN blobs AS blob
           ON blob.account_id = attachment.account_id
          AND blob.id = attachment.blob_id
          AND blob.size_bytes = attachment.size_bytes
          AND blob.sha256 = attachment.sha256
          AND blob.state = 'ready'
         JOIN upload_sessions AS upload
           ON upload.account_id = attachment.account_id
          AND upload.project_id = attachment.project_id
          AND upload.id = attachment.upload_session_id
          AND upload.status = 'finalized'
          AND upload.finalized_attachment_id = attachment.id
         WHERE attachment.account_id = ?
           AND attachment.project_id = ?
           AND attachment.id = ?
           AND attachment.actor_id = ?
           AND attachment.client_submission_id = ?
           AND attachment.status = 'ready'
           AND attachment.scan_state = 'clean'
           AND binding.intent = 'bug_create'
           AND binding.target_bug_id IS NULL
           AND binding.state = 'reserved'
           AND unixepoch(binding.expires_at) > unixepoch('now')`,
      )
      .get(
        input.accountId,
        input.projectId,
        attachmentId,
        input.actorId,
        input.clientSubmissionId,
      ) as
      | {
          readonly binding_id: string;
          readonly binding_version: number;
          readonly attachment_version: number;
        }
      | undefined;
    if (!reservation) {
      throw new SqliteStorageError(
        "SQLITE_ATTACHMENT_RESERVATION_INVALID",
        "Bug attachment has no matching active reservation",
      );
    }
    database
      .prepare(
        `UPDATE attachment_bindings
         SET target_bug_id = ?, state = 'claimed', expires_at = NULL,
             claimed_at = ?, version = version + 1
         WHERE account_id = ? AND project_id = ? AND id = ? AND version = ?`,
      )
      .run(
        bugId,
        input.createdAt,
        input.accountId,
        input.projectId,
        reservation.binding_id,
        reservation.binding_version,
      );
    database
      .prepare(
        `UPDATE attachments SET version = version + 1
         WHERE account_id = ? AND project_id = ? AND id = ? AND version = ?`,
      )
      .run(input.accountId, input.projectId, attachmentId, reservation.attachment_version);
    database
      .prepare(
        `INSERT INTO bug_attachments(
          account_id, project_id, bug_id, attachment_id, binding_id
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.accountId, input.projectId, bugId, attachmentId, reservation.binding_id);
  }
}

function insertBugCreatedNotificationOutbox(
  database: DatabaseSync,
  input: Pick<CreateMobileBugInput, "accountId" | "projectId" | "createdAt"> & {
    readonly bugId: string;
    readonly eventId: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO outbox(
        id, account_id, project_id, aggregate_type, aggregate_id, aggregate_version,
        destination, dedupe_key, event_id, payload_json, status, attempt_count,
        next_attempt_at, lease_owner, lease_expires_at, last_error_code, created_at, sent_at
      ) VALUES (?, ?, ?, 'bug', ?, 1, ?, ?, ?, ?, 'pending', 0, ?,
                NULL, NULL, NULL, ?, NULL)`,
    )
    .run(
      randomUUID(),
      input.accountId,
      input.projectId,
      input.bugId,
      NOTIFICATION_DESTINATION,
      `notification:${input.eventId}`,
      input.eventId,
      JSON.stringify({
        eventId: input.eventId,
        eventType: "occurrence.appended",
        bugId: input.bugId,
      }),
      input.createdAt,
      input.createdAt,
    );
}

export function createMobileBug(
  database: DatabaseSync,
  input: CreateMobileBugInput,
): MobileBugCreation {
  requireTransaction(database);
  const capture = input.captureBundleId
    ? (database
        .prepare(
          `SELECT id, actor_id, client_submission_id, status, version
           FROM capture_bundles
           WHERE account_id = ? AND project_id = ? AND id = ?`,
        )
        .get(input.accountId, input.projectId, input.captureBundleId) as
        | {
            readonly id: string;
            readonly actor_id: string;
            readonly client_submission_id: string;
            readonly status: string;
            readonly version: number;
          }
        | undefined)
    : undefined;
  if (
    input.captureBundleId !== null &&
    (!capture ||
      capture.actor_id !== input.actorId ||
      capture.client_submission_id !== input.clientSubmissionId ||
      !["uploaded", "bound"].includes(capture.status))
  ) {
    throw new SqliteStorageError(
      "SQLITE_UPLOAD_INVALID",
      "capture bundle is not an exact same-scope uploaded capture",
    );
  }
  const prior = database
    .prepare(
      `SELECT payload_digest
       FROM submissions
       WHERE account_id = ? AND project_id = ? AND actor_id = ? AND client_submission_id = ?`,
    )
    .get(input.accountId, input.projectId, input.actorId, input.clientSubmissionId);
  if (prior) {
    if (prior.payload_digest !== input.payloadDigest) {
      throw new SqliteStorageError(
        "SQLITE_IDEMPOTENCY_MISMATCH",
        "client submission was already committed with another payload",
      );
    }
    const replay = loadCreation(database, input, true);
    if (!replay)
      throw new SqliteStorageError("SQLITE_EFFECT_MISSING", "submission effect is missing");
    return replay;
  }

  assertInitialAssignment(
    database,
    input,
    input.ownerId,
    ["developer", "triager", "project_admin"],
    "ownerId",
  );
  assertInitialAssignment(
    database,
    input,
    input.verificationOwnerId,
    ["verifier", "project_admin"],
    "verificationOwnerId",
  );

  const bugId = randomUUID();
  const occurrenceId = randomUUID();
  const eventId = randomUUID();
  insertBugWithNextNumber(database, {
    id: bugId,
    accountId: input.accountId,
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    expectedBehavior: input.expectedBehavior,
    severity: input.severity,
    priority: input.priority,
    reporterId: input.actorId,
    ownerId: input.ownerId,
    verificationOwnerId: input.verificationOwnerId,
    createdAt: input.createdAt,
  });
  database
    .prepare(
      `INSERT INTO occurrences(
        id, account_id, project_id, bug_id, reporter_id, client_submission_id,
        observed_at, platform, app_version, resource_version, git_sha,
        device_model, os_version, steps_json, actual_behavior, frequency,
        error_signature, environment_json, capture_bundle_id, created_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      occurrenceId,
      input.accountId,
      input.projectId,
      bugId,
      input.actorId,
      input.clientSubmissionId,
      input.occurrence.observedAt,
      input.occurrence.platform,
      input.occurrence.appVersion ?? null,
      input.occurrence.resourceVersion ?? null,
      input.occurrence.gitSha ?? null,
      input.occurrence.deviceModel ?? null,
      input.occurrence.osVersion ?? null,
      JSON.stringify(input.occurrence.steps),
      input.occurrence.actualBehavior,
      input.occurrence.frequency ?? null,
      input.occurrence.errorSignature ?? null,
      input.occurrence.environment === undefined
        ? null
        : JSON.stringify(input.occurrence.environment),
      input.captureBundleId,
      input.createdAt,
    );
  claimBugAttachments(database, input, bugId);
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
      input.accountId,
      input.projectId,
      bugId,
      input.actorId,
      bugId,
      occurrenceId,
      input.payloadDigest,
      randomUUID(),
      JSON.stringify({ occurrenceId, fromVersion: 1, toVersion: 2 }),
      input.createdAt,
    );
  insertBugCreatedNotificationOutbox(database, {
    accountId: input.accountId,
    projectId: input.projectId,
    bugId,
    eventId,
    createdAt: input.createdAt,
  });
  if (capture && capture.status === "uploaded") {
    const createdAtMs = Date.parse(input.createdAt);
    const updatedAt = new Date(Math.max(createdAtMs, createdAtMs + 1)).toISOString();
    database
      .prepare(
        `UPDATE capture_bundles
         SET status = 'bound', updated_at = ?, version = version + 1
         WHERE account_id = ? AND project_id = ? AND actor_id = ? AND id = ?
           AND status = 'uploaded' AND version = ?`,
      )
      .run(
        updatedAt,
        input.accountId,
        input.projectId,
        input.actorId,
        input.captureBundleId,
        capture.version,
      );
  }
  database
    .prepare(
      `INSERT INTO submissions(
        id, account_id, project_id, actor_id, client_submission_id, intent,
        payload_digest, bug_id, occurrence_id, comment_id, verification_id,
        capture_bundle_id, response_json, committed_at, version
      ) VALUES (?, ?, ?, ?, ?, 'bug_create', ?, ?, NULL, NULL, NULL, ?, ?, ?, 1)`,
    )
    .run(
      randomUUID(),
      input.accountId,
      input.projectId,
      input.actorId,
      input.clientSubmissionId,
      input.payloadDigest,
      bugId,
      input.captureBundleId,
      JSON.stringify({
        clientSubmissionId: input.clientSubmissionId,
        projectId: input.projectId,
        bugId,
        occurrenceId: null,
        commentId: null,
        verificationId: null,
        captureBundleId: input.captureBundleId,
      }),
      input.createdAt,
    );

  const created = loadCreation(database, input, false);
  if (!created)
    throw new SqliteStorageError("SQLITE_EFFECT_MISSING", "mobile Bug effect is missing");
  return created;
}

export function getMobileBug(
  database: DatabaseSync,
  scope: Pick<CreateMobileBugInput, "accountId" | "projectId">,
  bugId: string,
): MobileBugRecord | null {
  return readBug(database, scope.accountId, scope.projectId, bugId);
}

export function deleteMobileBug(
  database: DatabaseSync,
  input: DeleteMobileBugInput,
): MobileBugDeletion {
  requireTransaction(database);
  const uuidPattern =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
  if (
    !uuidPattern.test(input.accountId) ||
    !uuidPattern.test(input.projectId) ||
    !uuidPattern.test(input.actorId) ||
    !uuidPattern.test(input.bugId) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 200 ||
    !/^[0-9a-f]{64}$/u.test(input.requestDigest) ||
    !Number.isFinite(Date.parse(input.createdAt))
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "Bug deletion input is invalid");
  }
  const membership = database
    .prepare(
      `SELECT 1 AS present
       FROM accounts AS account
       JOIN projects AS project
         ON project.account_id = account.id
        AND project.id = ? AND project.status = 'active'
       JOIN users AS actor
         ON actor.account_id = account.id
        AND actor.id = ? AND actor.status = 'active'
       JOIN memberships AS member
         ON member.account_id = account.id
        AND member.project_id = project.id
        AND member.user_id = actor.id
        AND member.status = 'active'
       WHERE account.id = ? AND account.status = 'active'`,
    )
    .get(input.projectId, input.actorId, input.accountId);
  if (!membership) {
    throw new MobileRelayStorageError("FORBIDDEN", "actor has no active project membership");
  }

  const prior = database
    .prepare(
      `SELECT deleted_at, idempotency_key, request_digest
       FROM bug_deletions
       WHERE account_id = ? AND project_id = ? AND bug_id = ?`,
    )
    .get(input.accountId, input.projectId, input.bugId) as
    | {
        readonly deleted_at: string;
        readonly idempotency_key: string;
        readonly request_digest: string;
      }
    | undefined;
  if (prior) {
    if (
      prior.idempotency_key !== input.idempotencyKey ||
      prior.request_digest !== input.requestDigest
    ) {
      throw new MobileRelayStorageError("NOT_FOUND", "Bug was not found");
    }
    return Object.freeze({ bugId: input.bugId, deletedAt: prior.deleted_at, replayed: true });
  }

  const bug = database
    .prepare(
      `SELECT version FROM bugs
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, input.bugId) as { readonly version: number } | undefined;
  if (!bug) throw new MobileRelayStorageError("NOT_FOUND", "Bug was not found");
  if (bug.version !== input.expectedVersion) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "Bug version changed before deletion");
  }

  database
    .prepare(
      `INSERT INTO bug_deletions(
        account_id, project_id, bug_id, bug_version, deleted_by_actor_id,
        deleted_at, idempotency_key, request_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.accountId,
      input.projectId,
      input.bugId,
      bug.version,
      input.actorId,
      input.createdAt,
      input.idempotencyKey,
      input.requestDigest,
    );
  return Object.freeze({ bugId: input.bugId, deletedAt: input.createdAt, replayed: false });
}
