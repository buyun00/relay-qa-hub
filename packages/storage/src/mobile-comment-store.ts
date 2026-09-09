import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  decodeMobileReadCursor,
  digestMobileReadBinding,
  encodeMobileReadCursor,
  requireMobileReadPosition,
} from "./mobile-read-cursor.js";
import {
  readMobileProjectSnapshotSequence,
  requireMobileReadLimit,
  requireMobileReadUuid,
  resolveMobileReadAuthorization,
} from "./mobile-read-authorization.js";
import { MobileRelayStorageError, type MobileRelayScope } from "./mobile-relay-store.js";
import { canonicalProjectUserId } from "./project-identity-projection.js";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export interface MobileCommentRecord {
  readonly id: string;
  readonly bugId: string;
  readonly projectId: string;
  readonly authorId: string;
  readonly clientSubmissionId: string;
  readonly body: string;
  readonly attachmentIds: readonly string[];
  readonly createdAt: string;
  readonly version: 1;
}

export type MobileCommentListItem = Omit<MobileCommentRecord, "clientSubmissionId">;

export interface CreateMobileCommentInput extends MobileRelayScope {
  readonly bugId: string;
  readonly clientSubmissionId: string;
  readonly body: string;
  readonly payloadDigest: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface MobileCommentCreation {
  readonly clientSubmissionId: string;
  readonly comment: MobileCommentRecord;
  readonly eventId: string;
  readonly correlationId: string;
  readonly replayed: boolean;
}

export interface ListMobileBugEventsInput extends MobileRelayScope {
  readonly authorizationProjectId?: string;
  readonly bugId: string;
  readonly afterSequence?: number;
  readonly cursor?: string;
  readonly limit: number;
}

export interface ListMobileBugCommentsInput extends MobileRelayScope {
  readonly authorizationProjectId?: string;
  readonly bugId: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface MobileCommentList {
  readonly bugId: string;
  readonly projectId: string;
  readonly snapshotSequence: number;
  readonly items: readonly MobileCommentListItem[];
  readonly nextCursor: string | null;
}

export interface MobileBugEvent {
  readonly projectionVersion: "1.1.0";
  readonly redactionPolicyVersion: "1.0.0";
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly projectId: string;
  readonly bugId: string;
  readonly aggregate: {
    readonly type:
      | "bug"
      | "repair_attempt"
      | "build"
      | "verification"
      | "upload"
      | "notification"
      | "integration";
    readonly id: string;
    readonly version: number;
  };
  readonly sequence: number;
  readonly actor: {
    readonly type: "user" | "service" | "system";
    readonly id: string | null;
  };
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly occurredAt: string;
  readonly fromState: string | null;
  readonly toState: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface MobileBugEvents {
  readonly projectId: string;
  readonly bugId: string;
  readonly snapshotSequence: number;
  readonly items: readonly MobileBugEvent[];
  readonly nextCursor: string | null;
}

interface CommentRow {
  readonly id: string;
  readonly bug_id: string;
  readonly project_id: string;
  readonly author_id: string;
  readonly client_submission_id: string;
  readonly body: string;
  readonly created_at: string;
  readonly version: 1;
}

interface EventRow {
  readonly id: string;
  readonly event_type: string;
  readonly source: string;
  readonly project_id: string;
  readonly bug_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly sequence: number;
  readonly actor_type: "user" | "service" | "system";
  readonly actor_id: string | null;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly from_state: string | null;
  readonly to_state: string | null;
  readonly created_at: string;
  readonly payload_json: string;
}

function requireUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} must be a UUID`);
  }
}

function requireDigest(value: string): void {
  if (!DIGEST_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "payloadDigest must be a SHA-256 digest");
  }
}

function requireBody(value: string): void {
  if (value.length < 1 || value.length > 20_000) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "body must contain from 1 through 20000 characters",
    );
  }
}

function requireTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "createdAt is invalid");
  }
}

function requireProjectMembership(database: DatabaseSync, input: MobileRelayScope): void {
  const row = database
    .prepare(
      `SELECT 1 AS present
       FROM accounts AS account
       JOIN projects AS project
         ON project.account_id = account.id
        AND project.id = ?
        AND project.status = 'active'
       JOIN users AS actor
         ON actor.account_id = account.id
        AND actor.id = ?
        AND actor.status = 'active'
       JOIN command_project_memberships AS membership
         ON membership.account_id = account.id
        AND membership.project_id = project.id
        AND membership.user_id = actor.id
        AND membership.status = 'active'
       WHERE account.id = ? AND account.status = 'active'`,
    )
    .get(input.projectId, input.actorId, input.accountId) as
    { readonly present: number } | undefined;
  if (!row) {
    throw new MobileRelayStorageError("FORBIDDEN", "actor has no active project membership");
  }
}

function readComment(
  database: DatabaseSync,
  input: MobileRelayScope,
  commentId: string,
): MobileCommentRecord | null {
  const row = database
    .prepare(
      `SELECT id, bug_id, project_id, author_id, client_submission_id, body, created_at, version
       FROM comments
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, commentId) as CommentRow | undefined;
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    bugId: row.bug_id,
    projectId: row.project_id,
    authorId: canonicalProjectUserId(database, input, row.author_id),
    clientSubmissionId: row.client_submission_id,
    body: row.body,
    attachmentIds: Object.freeze([]),
    createdAt: row.created_at,
    version: row.version,
  });
}

function readCommentBySubmission(
  database: DatabaseSync,
  input: MobileRelayScope,
  clientSubmissionId: string,
): MobileCommentRecord | null {
  const row = database
    .prepare(
      `SELECT id
       FROM comments
       WHERE account_id = ? AND project_id = ?
         AND author_id = ? AND client_submission_id = ?`,
    )
    .get(input.accountId, input.projectId, input.actorId, clientSubmissionId) as
    { readonly id: string } | undefined;
  return row ? readComment(database, input, row.id) : null;
}

function readCommentEventIdentity(
  database: DatabaseSync,
  input: MobileRelayScope & { readonly bugId: string },
  commentId: string,
): { readonly eventId: string; readonly correlationId: string } | null {
  const row = database
    .prepare(
      `SELECT id, correlation_id
       FROM events
       WHERE account_id = ? AND project_id = ? AND bug_id = ?
         AND type = 'comment.created'
         AND resource_type = 'comment' AND resource_id = ?
       ORDER BY event_position DESC
       LIMIT 1`,
    )
    .get(input.accountId, input.projectId, input.bugId, commentId) as
    { readonly id: string; readonly correlation_id: string } | undefined;
  return row ? { eventId: row.id, correlationId: row.correlation_id } : null;
}

function nextBugEventSequence(
  database: DatabaseSync,
  input: MobileRelayScope & { readonly bugId: string },
): number {
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(aggregate_sequence), 0) + 1 AS next_sequence
       FROM events
       WHERE account_id = ? AND project_id = ?
         AND aggregate_type = 'bug' AND aggregate_id = ?`,
    )
    .get(input.accountId, input.projectId, input.bugId) as {
    readonly next_sequence: number;
  };
  return row.next_sequence;
}

function loadCommentCreation(
  database: DatabaseSync,
  input: CreateMobileCommentInput,
  replayed: boolean,
): MobileCommentCreation {
  const comment = readCommentBySubmission(database, input, input.clientSubmissionId);
  if (!comment || comment.bugId !== input.bugId) {
    throw new MobileRelayStorageError("NOT_FOUND", "comment effect is incomplete");
  }
  const event = readCommentEventIdentity(database, input, comment.id);
  if (event === null) {
    throw new MobileRelayStorageError("NOT_FOUND", "comment audit effect is incomplete");
  }
  return Object.freeze({
    clientSubmissionId: input.clientSubmissionId,
    comment,
    eventId: event.eventId,
    correlationId: event.correlationId,
    replayed,
  });
}

export function createMobileComment(
  database: DatabaseSync,
  input: CreateMobileCommentInput,
): MobileCommentCreation {
  requireUuid(input.accountId, "accountId");
  requireUuid(input.projectId, "projectId");
  requireUuid(input.actorId, "actorId");
  requireUuid(input.bugId, "bugId");
  requireUuid(input.clientSubmissionId, "clientSubmissionId");
  requireBody(input.body);
  requireDigest(input.payloadDigest);
  requireUuid(input.correlationId, "correlationId");
  requireTimestamp(input.createdAt);
  requireProjectMembership(database, input);

  const bug = database
    .prepare(
      `SELECT id
       FROM bugs
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, input.bugId) as { readonly id: string } | undefined;
  if (!bug) throw new MobileRelayStorageError("NOT_FOUND", "Bug was not found");

  const prior = database
    .prepare(
      `SELECT payload_digest, intent, bug_id
       FROM submissions
       WHERE account_id = ? AND project_id = ? AND actor_id = ?
         AND client_submission_id = ?`,
    )
    .get(input.accountId, input.projectId, input.actorId, input.clientSubmissionId) as
    | { readonly payload_digest: string; readonly intent: string; readonly bug_id: string }
    | undefined;
  if (prior) {
    if (
      prior.payload_digest !== input.payloadDigest ||
      prior.intent !== "comment_append" ||
      prior.bug_id !== input.bugId
    ) {
      throw new MobileRelayStorageError(
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
        "client submission was already used with another comment",
      );
    }
    return loadCommentCreation(database, input, true);
  }

  const commentId = randomUUID();
  const eventId = randomUUID();
  database
    .prepare(
      `INSERT INTO comments(
         id, account_id, project_id, bug_id, author_id, body,
         client_submission_id, created_at, version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      commentId,
      input.accountId,
      input.projectId,
      input.bugId,
      input.actorId,
      input.body,
      input.clientSubmissionId,
      input.createdAt,
    );

  database
    .prepare(
      `INSERT INTO events(
         id, account_id, project_id, bug_id, type, source, actor_type,
         actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
         resource_type, resource_id, resource_version_after, request_digest,
         correlation_id, payload_json, created_at
       ) VALUES (?, ?, ?, ?, 'comment.created', 'qa_hub', 'user', ?,
                 'bug', ?, ?, 'comment', ?, 1, ?, ?, ?, ?)`,
    )
    .run(
      eventId,
      input.accountId,
      input.projectId,
      input.bugId,
      input.actorId,
      input.bugId,
      nextBugEventSequence(database, input),
      commentId,
      input.payloadDigest,
      input.correlationId,
      JSON.stringify({ commentId }),
      input.createdAt,
    );

  database
    .prepare(
      `INSERT INTO submissions(
         id, account_id, project_id, actor_id, client_submission_id, intent,
         payload_digest, bug_id, occurrence_id, comment_id, verification_id,
         capture_bundle_id, response_json, committed_at, version
       ) VALUES (?, ?, ?, ?, ?, 'comment_append', ?, ?, NULL, ?, NULL, NULL, ?, ?, 1)`,
    )
    .run(
      randomUUID(),
      input.accountId,
      input.projectId,
      input.actorId,
      input.clientSubmissionId,
      input.payloadDigest,
      input.bugId,
      commentId,
      JSON.stringify({
        clientSubmissionId: input.clientSubmissionId,
        projectId: input.projectId,
        bugId: input.bugId,
        occurrenceId: null,
        commentId,
        verificationId: null,
        captureBundleId: null,
      }),
      input.createdAt,
    );

  return loadCommentCreation(database, input, false);
}

function requireReadableBug(
  database: DatabaseSync,
  input: MobileRelayScope & { readonly bugId: string },
): void {
  const bug = database
    .prepare(
      `SELECT 1 AS present FROM bugs
       WHERE account_id = ? AND project_id = ? AND id = ?
         AND NOT EXISTS (
           SELECT 1 FROM bug_deletions AS deletion
           WHERE deletion.account_id = bugs.account_id
             AND deletion.project_id = bugs.project_id AND deletion.bug_id = bugs.id
         )`,
    )
    .get(input.accountId, input.projectId, input.bugId);
  if (!bug) throw new MobileRelayStorageError("NOT_FOUND", "Bug was not found");
}

function commentAttachments(
  database: DatabaseSync,
  input: MobileRelayScope,
  commentId: string,
): readonly string[] {
  const rows = database
    .prepare(
      `SELECT attachment_id FROM comment_attachments
       WHERE account_id = ? AND project_id = ? AND comment_id = ?
       ORDER BY attachment_id`,
    )
    .all(input.accountId, input.projectId, commentId) as unknown as {
    readonly attachment_id: string;
  }[];
  if (rows.length > 20 || rows.some((row) => !UUID_PATTERN.test(row.attachment_id))) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "comment attachments are invalid");
  }
  return Object.freeze(rows.map((row) => row.attachment_id));
}

function projectIdentityProjectionBinding(
  database: DatabaseSync,
  input: MobileRelayScope,
): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze(
    database
      .prepare(
        `SELECT link.source_user_id, link.canonical_user_id,
                EXISTS (
                  SELECT 1 FROM users AS canonical
                  WHERE canonical.account_id = link.account_id
                    AND canonical.id = link.canonical_user_id
                    AND canonical.status = 'active'
                ) AS canonical_user_active,
                EXISTS (
                  SELECT 1 FROM command_project_memberships AS membership
                  WHERE membership.account_id = link.account_id
                    AND membership.project_id = link.project_id
                    AND membership.user_id = link.canonical_user_id
                    AND membership.status = 'active'
                ) AS canonical_membership_active
         FROM project_identity_links AS link
         WHERE link.account_id = ? AND link.project_id = ? AND link.status = 'active'
         ORDER BY link.source_user_id, link.canonical_user_id`,
      )
      .all(input.accountId, input.projectId)
      .map((row) => Object.freeze({ ...row })),
  );
}

export function listMobileBugComments(
  database: DatabaseSync,
  input: ListMobileBugCommentsInput,
  cursorSigningKey: Uint8Array,
): MobileCommentList {
  requireMobileReadUuid(input.accountId, "accountId");
  requireMobileReadUuid(input.projectId, "projectId");
  requireMobileReadUuid(input.actorId, "actorId");
  requireMobileReadUuid(input.bugId, "bugId");
  requireMobileReadLimit(input.limit);
  const authorization = resolveMobileReadAuthorization(
    database,
    { ...input, authorizationProjectId: input.authorizationProjectId ?? input.projectId },
    input.projectId,
  );
  requireReadableBug(database, input);
  const authorizationDigest = authorization.digest;
  const filterDigest = digestMobileReadBinding({
    projectId: input.projectId,
    bugId: input.bugId,
    identityProjection: projectIdentityProjectionBinding(database, input),
  });
  const decoded = decodeMobileReadCursor(input.cursor, {
    kind: "bug-comments",
    authorizationDigest,
    filterDigest,
    signingKey: cursorSigningKey,
  });
  const snapshotSequence =
    decoded?.snapshotSequence ??
    readMobileProjectSnapshotSequence(database, input.accountId, [input.projectId]);
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  if (decoded !== null) {
    const position = requireMobileReadPosition(decoded.position, ["createdAt", "id"]);
    if (
      typeof position["createdAt"] !== "string" ||
      !Number.isFinite(Date.parse(position["createdAt"])) ||
      typeof position["id"] !== "string" ||
      !UUID_PATTERN.test(position["id"])
    ) {
      throw new MobileRelayStorageError("INVALID_REQUEST", "cursor is invalid for this list");
    }
    cursorCreatedAt = position["createdAt"];
    cursorId = position["id"];
  }
  const rows = database
    .prepare(
      `SELECT comment.id, comment.bug_id, comment.project_id, comment.author_id,
              comment.client_submission_id, comment.body, comment.created_at, comment.version
       FROM comments AS comment
       WHERE comment.account_id = ? AND comment.project_id = ? AND comment.bug_id = ?
         AND EXISTS (
           SELECT 1 FROM events AS creation
           WHERE creation.account_id = comment.account_id
             AND creation.project_id = comment.project_id
             AND creation.bug_id = comment.bug_id
             AND creation.resource_type = 'comment' AND creation.resource_id = comment.id
             AND creation.event_position <= ?
         )
         AND (? IS NULL OR comment.created_at > ? OR
              (comment.created_at = ? AND comment.id > ?))
       ORDER BY comment.created_at ASC, comment.id ASC
       LIMIT ?`,
    )
    .all(
      input.accountId,
      input.projectId,
      input.bugId,
      snapshotSequence,
      cursorCreatedAt,
      cursorCreatedAt,
      cursorCreatedAt,
      cursorId,
      input.limit + 1,
    ) as unknown as CommentRow[];
  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const items = Object.freeze(
    pageRows.map((row) =>
      Object.freeze({
        id: row.id,
        bugId: row.bug_id,
        projectId: row.project_id,
        authorId: canonicalProjectUserId(database, input, row.author_id),
        body: row.body,
        attachmentIds: commentAttachments(database, input, row.id),
        createdAt: row.created_at,
        version: row.version,
      }),
    ),
  );
  const last = items.at(-1);
  return Object.freeze({
    bugId: input.bugId,
    projectId: input.projectId,
    snapshotSequence,
    items,
    nextCursor:
      hasMore && last !== undefined
        ? encodeMobileReadCursor(
            {
              kind: "bug-comments",
              authorizationDigest,
              filterDigest,
              snapshotSequence,
              position: { createdAt: last.createdAt, id: last.id },
            },
            cursorSigningKey,
          )
        : null,
  });
}

const AUDIT_UUID_FIELDS = new Set([
  "relatedBugId",
  "repairAttemptId",
  "buildId",
  "verificationId",
  "attachmentId",
  "captureId",
  "handoffId",
  "commentId",
  "occurrenceId",
]);

function projectAuditPayload(payloadJson: string): Readonly<Record<string, unknown>> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadJson);
  } catch {
    throw new MobileRelayStorageError("INVALID_REQUEST", "event payload is invalid");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "event payload is invalid");
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(decoded as Record<string, unknown>)) {
    if (AUDIT_UUID_FIELDS.has(key)) {
      if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
        throw new MobileRelayStorageError("INVALID_REQUEST", "event payload is invalid");
      }
      result[key] = value;
    } else if (key === "summary" || key === "reason") {
      if (typeof value !== "string" || value.length < 1 || value.length > 2_000) {
        throw new MobileRelayStorageError("INVALID_REQUEST", "event payload is invalid");
      }
      result[key] = value;
    } else if (key === "status") {
      if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,99}$/u.test(value)) {
        throw new MobileRelayStorageError("INVALID_REQUEST", "event payload is invalid");
      }
      result[key] = value;
    } else if (key === "commitSha") {
      if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
        throw new MobileRelayStorageError("INVALID_REQUEST", "event payload is invalid");
      }
      result[key] = value;
    } else if (key === "attachmentCount") {
      if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 20) {
        throw new MobileRelayStorageError("INVALID_REQUEST", "event payload is invalid");
      }
      result[key] = value;
    } else if (key === "fromVersion" || key === "toVersion") {
      if (!Number.isSafeInteger(value) || (value as number) < 1) {
        throw new MobileRelayStorageError("INVALID_REQUEST", "event payload is invalid");
      }
      result[key] = value;
    }
  }
  return Object.freeze(result);
}

function auditAggregate(row: EventRow): MobileBugEvent["aggregate"] {
  const allowed = new Set([
    "bug",
    "repair_attempt",
    "build",
    "verification",
    "upload",
    "notification",
    "integration",
  ]);
  const type = allowed.has(row.aggregate_type) ? row.aggregate_type : "bug";
  const id = type === "bug" && row.aggregate_type !== "bug" ? row.bug_id : row.aggregate_id;
  if (
    !UUID_PATTERN.test(id) ||
    !Number.isSafeInteger(row.aggregate_version) ||
    row.aggregate_version < 1
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "event aggregate is invalid");
  }
  return Object.freeze({
    type: type as MobileBugEvent["aggregate"]["type"],
    id,
    version: row.aggregate_version,
  });
}

function toAuditEvent(
  database: DatabaseSync,
  input: MobileRelayScope,
  row: EventRow,
): MobileBugEvent {
  if (
    !UUID_PATTERN.test(row.id) ||
    !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u.test(row.event_type) ||
    !["qa_hub", "relay", "build"].includes(row.source) ||
    !UUID_PATTERN.test(row.project_id) ||
    !UUID_PATTERN.test(row.bug_id) ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    !UUID_PATTERN.test(row.correlation_id) ||
    (row.causation_id !== null && !UUID_PATTERN.test(row.causation_id)) ||
    !Number.isFinite(Date.parse(row.created_at))
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "event projection is invalid");
  }
  const actorId =
    row.actor_type === "user" && row.actor_id !== null
      ? canonicalProjectUserId(database, input, row.actor_id)
      : row.actor_id;
  if (
    (row.actor_type === "system" && actorId !== null) ||
    (row.actor_type !== "system" && (actorId === null || !UUID_PATTERN.test(actorId)))
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "event actor is invalid");
  }
  const payload = projectAuditPayload(row.payload_json);
  if (
    (row.event_type === "bug.closed" || row.to_state === "closed") &&
    typeof payload["verificationId"] !== "string"
  ) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "closed event lacks verification identity",
    );
  }
  if (
    (row.source === "relay" || row.source === "build") &&
    (row.event_type.startsWith("bug.") ||
      row.event_type.startsWith("verification.") ||
      row.from_state !== null ||
      row.to_state !== null ||
      ["accepted", "verified", "closed", "passed", "rejected"].includes(
        String(payload["status"] ?? ""),
      ))
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "external event projection is invalid");
  }
  return Object.freeze({
    projectionVersion: "1.1.0",
    redactionPolicyVersion: "1.0.0",
    id: row.id,
    type: row.event_type,
    source: row.source,
    projectId: row.project_id,
    bugId: row.bug_id,
    aggregate: auditAggregate(row),
    sequence: row.sequence,
    actor: Object.freeze({ type: row.actor_type, id: actorId }),
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    occurredAt: row.created_at,
    fromState: row.from_state,
    toState: row.to_state,
    payload,
  });
}

export function listMobileBugEvents(
  database: DatabaseSync,
  input: ListMobileBugEventsInput,
  cursorSigningKey: Uint8Array,
): MobileBugEvents {
  requireMobileReadUuid(input.accountId, "accountId");
  requireMobileReadUuid(input.projectId, "projectId");
  requireMobileReadUuid(input.actorId, "actorId");
  requireMobileReadUuid(input.bugId, "bugId");
  requireMobileReadLimit(input.limit);
  const requestedAfterSequence = input.afterSequence;
  if (
    requestedAfterSequence !== undefined &&
    (!Number.isSafeInteger(requestedAfterSequence) || requestedAfterSequence < 0)
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "afterSequence is invalid");
  }
  const authorization = resolveMobileReadAuthorization(
    database,
    { ...input, authorizationProjectId: input.authorizationProjectId ?? input.projectId },
    input.projectId,
  );
  requireReadableBug(database, input);
  const filterDigest = digestMobileReadBinding({
    projectId: input.projectId,
    bugId: input.bugId,
    identityProjection: projectIdentityProjectionBinding(database, input),
  });
  const decoded = decodeMobileReadCursor(input.cursor, {
    kind: "bug-events",
    authorizationDigest: authorization.digest,
    filterDigest,
    signingKey: cursorSigningKey,
  });
  let anchor = requestedAfterSequence ?? 0;
  let lastSequence = anchor;
  if (decoded !== null) {
    const position = requireMobileReadPosition(decoded.position, ["anchor", "id", "sequence"]);
    if (
      !Number.isSafeInteger(position["anchor"]) ||
      (position["anchor"] as number) < 0 ||
      !Number.isSafeInteger(position["sequence"]) ||
      (position["sequence"] as number) < (position["anchor"] as number) ||
      typeof position["id"] !== "string" ||
      !UUID_PATTERN.test(position["id"])
    ) {
      throw new MobileRelayStorageError("INVALID_REQUEST", "cursor is invalid for this list");
    }
    if (
      requestedAfterSequence !== undefined &&
      requestedAfterSequence !== (position["anchor"] as number)
    ) {
      throw new MobileRelayStorageError(
        "INVALID_REQUEST",
        "afterSequence does not match the cursor anchor",
      );
    }
    anchor = position["anchor"] as number;
    lastSequence = position["sequence"] as number;
  }
  const count = database
    .prepare(
      `SELECT COUNT(*) AS count FROM events
       WHERE account_id = ? AND project_id = ? AND bug_id = ?`,
    )
    .get(input.accountId, input.projectId, input.bugId) as { readonly count: number };
  const snapshotSequence = decoded?.snapshotSequence ?? count.count;
  if (
    !Number.isSafeInteger(snapshotSequence) ||
    snapshotSequence < 0 ||
    lastSequence > snapshotSequence
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "cursor is invalid for this list");
  }
  const rows = database
    .prepare(
      `WITH bug_events AS (
         SELECT event.id, event.type AS event_type, event.source, event.project_id,
                event.bug_id, event.aggregate_type, event.aggregate_id,
                COALESCE(event.resource_version_after, event.aggregate_sequence) AS aggregate_version,
                ROW_NUMBER() OVER (ORDER BY event.event_position ASC) AS sequence,
                event.actor_type,
                COALESCE(event.actor_user_id, event.actor_service_principal_id) AS actor_id,
                event.correlation_id, event.causation_id, event.from_state, event.to_state,
                event.created_at, event.payload_json
         FROM events AS event
         WHERE event.account_id = ? AND event.project_id = ? AND event.bug_id = ?
       )
       SELECT * FROM bug_events
       WHERE sequence > ? AND sequence <= ?
       ORDER BY sequence ASC, id ASC
       LIMIT ?`,
    )
    .all(
      input.accountId,
      input.projectId,
      input.bugId,
      Math.max(anchor, lastSequence),
      snapshotSequence,
      input.limit + 1,
    ) as unknown as EventRow[];
  const hasMore = rows.length > input.limit;
  const items = Object.freeze(
    (hasMore ? rows.slice(0, input.limit) : rows).map((row) => toAuditEvent(database, input, row)),
  );
  const last = items.at(-1);
  return Object.freeze({
    projectId: input.projectId,
    bugId: input.bugId,
    snapshotSequence,
    items,
    nextCursor:
      hasMore && last !== undefined
        ? encodeMobileReadCursor(
            {
              kind: "bug-events",
              authorizationDigest: authorization.digest,
              filterDigest,
              snapshotSequence,
              position: { anchor, id: last.id, sequence: last.sequence },
            },
            cursorSigningKey,
          )
        : null,
  });
}
