import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { getMobileBug, type MobileBugRecord } from "./mobile-bug-store.js";
import { MobileRelayStorageError, type MobileRelayScope } from "./mobile-relay-store.js";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const MAX_DUPLICATE_CANDIDATES = 5;
const DUPLICATE_REASON = "same normalized title and description" as const;

export interface MobileDuplicateCandidate {
  readonly bugId: string;
  readonly bugKey: string;
  readonly score: 1;
  readonly reasons: readonly [typeof DUPLICATE_REASON];
}

export interface MobileDuplicateCandidateList {
  readonly candidates: readonly MobileDuplicateCandidate[];
}

export interface ListMobileDuplicateCandidatesInput extends MobileRelayScope {
  readonly bugId: string;
}

export interface MarkMobileBugDuplicateInput extends MobileRelayScope {
  readonly bugId: string;
  readonly expectedVersion: number;
  readonly canonicalBugId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

interface BugIdentityRow {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly description: string;
}

interface DuplicateSourceRow extends BugIdentityRow {
  readonly state: MobileBugRecord["state"];
  readonly version: number;
  readonly updated_at: string;
}

interface DuplicateReplayRow {
  readonly request_digest: string;
  readonly status: string;
  readonly response_json: string | null;
}

function requireUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} must be a UUID`);
  }
}

function requireWriteTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "mark duplicate requires the caller's write transaction",
    );
  }
}

function requireMarkInput(input: MarkMobileBugDuplicateInput): void {
  requireUuid(input.accountId, "accountId");
  requireUuid(input.projectId, "projectId");
  requireUuid(input.actorId, "actorId");
  requireUuid(input.bugId, "bugId");
  requireUuid(input.canonicalBugId, "canonicalBugId");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "expectedVersion is invalid");
  }
  if (
    input.reason.trim() !== input.reason ||
    input.reason.length < 1 ||
    input.reason.length > 2_000
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "reason is invalid");
  }
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "Idempotency-Key is invalid");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.requestDigest)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "requestDigest is invalid");
  }
  if (!Number.isFinite(Date.parse(input.createdAt))) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "createdAt is invalid");
  }
}

function markScopeDigest(input: MarkMobileBugDuplicateInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        accountId: input.accountId,
        actorId: input.actorId,
        projectId: input.projectId,
        operationId: "markBugDuplicate",
      }),
    )
    .digest("hex");
}

function nextTimestamp(candidate: string, floor: string): string {
  return new Date(Math.max(Date.parse(candidate), Date.parse(floor) + 1)).toISOString();
}

function requireTriager(database: DatabaseSync, input: MarkMobileBugDuplicateInput): void {
  const allowed = database
    .prepare(
      `SELECT 1 AS allowed
       FROM accounts AS account
       JOIN projects AS project
         ON project.account_id = account.id AND project.id = ? AND project.status = 'active'
       JOIN users AS actor
         ON actor.account_id = account.id AND actor.id = ? AND actor.status = 'active'
       JOIN memberships AS membership
         ON membership.account_id = account.id
        AND membership.project_id = project.id
        AND membership.user_id = actor.id
        AND membership.status = 'active'
       JOIN membership_roles AS role
         ON role.account_id = membership.account_id
        AND role.project_id = membership.project_id
        AND role.membership_id = membership.id
        AND role.role = 'triager'
       WHERE account.id = ? AND account.status = 'active'
       LIMIT 1`,
    )
    .get(input.projectId, input.actorId, input.accountId);
  if (!allowed) {
    throw new MobileRelayStorageError("FORBIDDEN", "actor is not an active project triager");
  }
}

function readMarkReplay(
  database: DatabaseSync,
  input: MarkMobileBugDuplicateInput,
): MobileBugRecord | null {
  const row = database
    .prepare(
      `SELECT request_digest, status, response_json
       FROM idempotency_records
       WHERE account_id = ? AND actor_id = ? AND operation_id = 'markBugDuplicate'
         AND scope_digest = ? AND idempotency_key = ?`,
    )
    .get(input.accountId, input.actorId, markScopeDigest(input), input.idempotencyKey) as
    DuplicateReplayRow | undefined;
  if (!row) return null;
  if (row.request_digest !== input.requestDigest) {
    throw new MobileRelayStorageError(
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
      "Idempotency-Key was already used with a different duplicate payload",
    );
  }
  if (row.status !== "committed" || row.response_json === null) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "duplicate action is not committed");
  }
  return Object.freeze(JSON.parse(row.response_json) as MobileBugRecord);
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function requireReadableSourceBug(
  database: DatabaseSync,
  input: ListMobileDuplicateCandidatesInput,
): BugIdentityRow {
  const source = database
    .prepare(
      `SELECT bug.id, bug.key, bug.title, bug.description
       FROM bugs AS bug
       JOIN accounts AS account
         ON account.id = bug.account_id AND account.status = 'active'
       JOIN projects AS project
         ON project.account_id = bug.account_id
        AND project.id = bug.project_id
        AND project.status = 'active'
       JOIN users AS actor
         ON actor.account_id = bug.account_id
        AND actor.id = ?
        AND actor.status = 'active'
       JOIN memberships AS membership
         ON membership.account_id = bug.account_id
        AND membership.project_id = bug.project_id
        AND membership.user_id = actor.id
        AND membership.status = 'active'
       WHERE bug.account_id = ? AND bug.project_id = ? AND bug.id = ?`,
    )
    .get(input.actorId, input.accountId, input.projectId, input.bugId) as
    BugIdentityRow | undefined;
  if (!source) {
    throw new MobileRelayStorageError("NOT_FOUND", "Bug was not found");
  }
  return source;
}

export function listMobileDuplicateCandidates(
  database: DatabaseSync,
  input: ListMobileDuplicateCandidatesInput,
): MobileDuplicateCandidateList {
  requireUuid(input.accountId, "accountId");
  requireUuid(input.projectId, "projectId");
  requireUuid(input.actorId, "actorId");
  requireUuid(input.bugId, "bugId");

  const source = requireReadableSourceBug(database, input);
  const normalizedTitle = normalize(source.title);
  const normalizedDescription = normalize(source.description);
  const rows = database
    .prepare(
      `SELECT id, key, title, description
       FROM bugs
       WHERE account_id = ? AND project_id = ?
         AND id <> ?
         AND state <> 'duplicate'
         AND duplicate_of_bug_id IS NULL
       ORDER BY number ASC, id ASC`,
    )
    .all(input.accountId, input.projectId, source.id) as unknown as BugIdentityRow[];

  const candidates: MobileDuplicateCandidate[] = [];
  for (const row of rows) {
    if (
      normalize(row.title) !== normalizedTitle ||
      normalize(row.description) !== normalizedDescription
    ) {
      continue;
    }
    candidates.push(
      Object.freeze({
        bugId: row.id,
        bugKey: row.key,
        score: 1 as const,
        reasons: Object.freeze([DUPLICATE_REASON] as const),
      }),
    );
    if (candidates.length === MAX_DUPLICATE_CANDIDATES) break;
  }

  return Object.freeze({ candidates: Object.freeze(candidates) });
}

export function markMobileBugDuplicate(
  database: DatabaseSync,
  input: MarkMobileBugDuplicateInput,
): MobileBugRecord {
  requireWriteTransaction(database);
  requireMarkInput(input);
  requireTriager(database, input);
  const replay = readMarkReplay(database, input);
  if (replay) return replay;

  const source = database
    .prepare(
      `SELECT id, key, title, description, state, version, updated_at
       FROM bugs
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, input.bugId) as DuplicateSourceRow | undefined;
  if (!source) throw new MobileRelayStorageError("NOT_FOUND", "source Bug was not found");
  if (source.version !== input.expectedVersion) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "source Bug version is stale");
  }
  if (source.state !== "reported" && source.state !== "ready") {
    throw new MobileRelayStorageError(
      "GUARD_FAILED",
      "only reported or ready Bugs can be marked duplicate",
    );
  }
  if (input.canonicalBugId === input.bugId) {
    throw new MobileRelayStorageError("GUARD_FAILED", "a Bug cannot duplicate itself");
  }
  const canonical = database
    .prepare(
      `SELECT id
       FROM bugs
       WHERE account_id = ? AND project_id = ? AND id = ?
         AND state <> 'duplicate' AND duplicate_of_bug_id IS NULL`,
    )
    .get(input.accountId, input.projectId, input.canonicalBugId);
  if (!canonical) {
    throw new MobileRelayStorageError(
      "GUARD_FAILED",
      "canonical Bug must be a root Bug in the same project",
    );
  }

  const at = nextTimestamp(input.createdAt, source.updated_at);
  const scopeDigest = markScopeDigest(input);
  const idempotencyId = randomUUID();
  const eventId = randomUUID();
  const expiresAt = new Date(Date.parse(at) + 7 * 24 * 60 * 60 * 1_000).toISOString();
  database
    .prepare(
      `INSERT INTO idempotency_records(
        id, account_id, project_id, actor_id, operation_id, idempotency_key,
        scope_digest, scope_json, request_digest, status, created_at, expires_at, version
      ) VALUES (?, ?, ?, ?, 'markBugDuplicate', ?, ?, ?, ?, 'reserved', ?, ?, 1)`,
    )
    .run(
      idempotencyId,
      input.accountId,
      input.projectId,
      input.actorId,
      input.idempotencyKey,
      scopeDigest,
      JSON.stringify({
        operationId: "markBugDuplicate",
        accountId: input.accountId,
        actorId: input.actorId,
        projectId: input.projectId,
        bugId: input.bugId,
      }),
      input.requestDigest,
      at,
      expiresAt,
    );
  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
        resource_type, resource_id, resource_version_after, request_digest,
        correlation_id, from_state, to_state, payload_json, created_at
      ) VALUES (?, ?, ?, ?, 'bug.mark_duplicate', 'qa_hub', 'user', ?,
                'bug', ?, ?, 'bug', ?, ?, ?, ?, ?, 'duplicate', ?, ?)`,
    )
    .run(
      eventId,
      input.accountId,
      input.projectId,
      input.bugId,
      input.actorId,
      input.bugId,
      source.version + 1,
      input.bugId,
      source.version + 1,
      input.requestDigest,
      randomUUID(),
      source.state,
      JSON.stringify({
        status: "duplicate",
        relatedBugId: input.canonicalBugId,
        reason: input.reason,
        fromVersion: source.version,
        toVersion: source.version + 1,
      }),
      at,
    );
  database
    .prepare(
      `INSERT INTO outbox(
        id, account_id, project_id, aggregate_type, aggregate_id, aggregate_version,
        destination, dedupe_key, event_id, payload_json, status, attempt_count,
        next_attempt_at, lease_owner, lease_expires_at, last_error_code, created_at, sent_at
      ) VALUES (?, ?, ?, 'bug', ?, ?, 'qa-hub.notifications', ?, ?, ?, 'pending', 0,
                ?, NULL, NULL, NULL, ?, NULL)`,
    )
    .run(
      randomUUID(),
      input.accountId,
      input.projectId,
      input.bugId,
      source.version + 1,
      `notification:${eventId}`,
      eventId,
      JSON.stringify({
        eventId,
        eventType: "bug.mark_duplicate",
        bugId: input.bugId,
      }),
      at,
      at,
    );
  const updated = database
    .prepare(
      `UPDATE bugs
       SET state = 'duplicate', duplicate_of_bug_id = ?, version = version + 1, updated_at = ?
       WHERE account_id = ? AND project_id = ? AND id = ?
         AND version = ? AND state IN ('reported', 'ready') AND duplicate_of_bug_id IS NULL`,
    )
    .run(input.canonicalBugId, at, input.accountId, input.projectId, input.bugId, source.version);
  if (updated.changes !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "Bug was not marked duplicate exactly once",
    );
  }
  const response = getMobileBug(database, input, input.bugId);
  if (!response) throw new MobileRelayStorageError("NOT_FOUND", "Bug disappeared after merge");
  const committed = database
    .prepare(
      `UPDATE idempotency_records
       SET status = 'committed', http_status = 200, response_json = ?,
           audit_event_id = ?, version = 2
       WHERE id = ? AND status = 'reserved' AND version = 1`,
    )
    .run(JSON.stringify(response), eventId, idempotencyId);
  if (committed.changes !== 1) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "duplicate action did not commit exactly once",
    );
  }
  return response;
}
