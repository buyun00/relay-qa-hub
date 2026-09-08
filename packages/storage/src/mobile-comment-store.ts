import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { MobileRelayStorageError, type MobileRelayScope } from "./mobile-relay-store.js";

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
  readonly bugId: string;
  readonly limit: number;
}

export interface MobileBugEvent {
  readonly schemaVersion: "1.0";
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly projectId: string;
  readonly bugId: string;
  readonly aggregate: {
    readonly type: "bug";
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
  readonly items: readonly MobileBugEvent[];
  readonly nextCursor: null;
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

function requireLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "limit must be an integer from 1 through 100",
    );
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
    authorId: row.author_id,
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

export function listMobileBugEvents(
  database: DatabaseSync,
  input: ListMobileBugEventsInput,
): MobileBugEvents {
  requireUuid(input.accountId, "accountId");
  requireUuid(input.projectId, "projectId");
  requireUuid(input.actorId, "actorId");
  requireUuid(input.bugId, "bugId");
  requireLimit(input.limit);
  requireProjectMembership(database, input);

  const bug = database
    .prepare(
      `SELECT id
       FROM bugs
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, input.bugId) as { readonly id: string } | undefined;
  if (!bug) throw new MobileRelayStorageError("NOT_FOUND", "Bug was not found");

  const rows = database
    .prepare(
      `SELECT event.id, event.type AS event_type, event.source, event.project_id,
              event.bug_id, event.aggregate_id, bug.version AS aggregate_version,
              event.aggregate_sequence AS sequence, event.actor_type,
              COALESCE(event.actor_user_id, event.actor_service_principal_id) AS actor_id,
              event.correlation_id, event.causation_id, event.from_state, event.to_state,
              event.created_at, event.payload_json
       FROM events AS event
       JOIN bugs AS bug
         ON bug.account_id = event.account_id
        AND bug.project_id = event.project_id
        AND bug.id = event.bug_id
       WHERE event.account_id = ? AND event.project_id = ? AND event.bug_id = ?
       ORDER BY event.event_position DESC
       LIMIT ?`,
    )
    .all(input.accountId, input.projectId, input.bugId, input.limit) as unknown as EventRow[];

  return Object.freeze({
    items: Object.freeze(
      rows.map((row) => {
        let payload: Readonly<Record<string, unknown>>;
        try {
          const parsed: unknown = JSON.parse(row.payload_json);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("event payload is not an object");
          }
          payload = Object.freeze(parsed as Record<string, unknown>);
        } catch {
          throw new MobileRelayStorageError("INVALID_REQUEST", "event payload is invalid");
        }
        return Object.freeze({
          schemaVersion: "1.0" as const,
          id: row.id,
          type: row.event_type,
          source: row.source,
          projectId: row.project_id,
          bugId: row.bug_id,
          aggregate: Object.freeze({
            type: "bug" as const,
            id: row.aggregate_id,
            version: row.aggregate_version,
          }),
          sequence: row.sequence,
          actor: Object.freeze({ type: row.actor_type, id: row.actor_id }),
          correlationId: row.correlation_id,
          causationId: row.causation_id,
          occurredAt: row.created_at,
          fromState: row.from_state,
          toState: row.to_state,
          payload,
        });
      }),
    ),
    nextCursor: null,
  });
}
