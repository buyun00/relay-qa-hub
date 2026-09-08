import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { MobileRelayStorageError, type MobileRelayScope } from "./mobile-relay-store.js";
import type { MobileBugRecord } from "./mobile-bug-store.js";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const BUG_STATES = [
  "reported",
  "needs_info",
  "ready",
  "in_progress",
  "awaiting_build",
  "ready_for_verification",
  "closed",
  "deferred",
  "rejected",
  "duplicate",
] as const;

export type MobileBugListState = (typeof BUG_STATES)[number];

export interface ListMobileBugsInput extends MobileRelayScope {
  readonly ownerId?: string;
  readonly ownerState?: "assigned" | "unassigned";
  readonly q?: string;
  readonly state?: MobileBugListState;
  readonly severity?: MobileBugRecord["severity"];
  readonly limit: number;
}

export interface MobileBugList {
  readonly snapshotSequence: number;
  readonly items: readonly MobileBugRecord[];
  readonly nextCursor: null;
}

interface MobileBugListRow {
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

function requireUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} must be a UUID`);
  }
}

function requireLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "limit must be an integer from 1 through 500",
    );
  }
}

function requireState(value: MobileBugListState | undefined): void {
  if (value !== undefined && !(BUG_STATES as readonly string[]).includes(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "state is invalid");
  }
}

function requireQuery(value: string | undefined): void {
  if (value !== undefined && (value.length < 1 || value.length > 200 || value !== value.trim())) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "q is invalid");
  }
}

function requireSeverity(value: MobileBugRecord["severity"] | undefined): void {
  if (value !== undefined && !["S0", "S1", "S2", "S3", "S4"].includes(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "severity is invalid");
  }
}

function requireProjectMembership(database: DatabaseSync, input: ListMobileBugsInput): void {
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

function toMobileBug(row: MobileBugListRow): MobileBugRecord {
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

export function listMobileBugs(database: DatabaseSync, input: ListMobileBugsInput): MobileBugList {
  requireUuid(input.accountId, "accountId");
  requireUuid(input.projectId, "projectId");
  requireUuid(input.actorId, "actorId");
  if (input.ownerId !== undefined) requireUuid(input.ownerId, "ownerId");
  if (input.ownerId !== undefined && input.ownerState !== undefined) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "ownerId and ownerState cannot be combined",
    );
  }
  requireLimit(input.limit);
  requireQuery(input.q);
  requireState(input.state);
  requireSeverity(input.severity);
  requireProjectMembership(database, input);

  const snapshot = database
    .prepare(
      `SELECT COALESCE(MAX(event_position), 0) AS snapshot_sequence
       FROM events
       WHERE account_id = ? AND project_id = ?`,
    )
    .get(input.accountId, input.projectId) as { readonly snapshot_sequence: number };

  const conditions = [
    "account_id = ?",
    "project_id = ?",
    `NOT EXISTS (
      SELECT 1 FROM bug_deletions AS deletion
      WHERE deletion.account_id = bugs.account_id
        AND deletion.project_id = bugs.project_id
        AND deletion.bug_id = bugs.id
    )`,
  ];
  const parameters: SQLInputValue[] = [input.accountId, input.projectId];
  if (input.ownerId !== undefined) {
    conditions.push(
      `(owner_id = ? OR owner_id IN (
        SELECT source_user_id
        FROM project_identity_links
        WHERE account_id = bugs.account_id
          AND project_id = bugs.project_id
          AND canonical_user_id = ?
          AND status = 'active'
      ))`,
    );
    parameters.push(input.ownerId, input.ownerId);
  }
  if (input.ownerState === "assigned") conditions.push("owner_id IS NOT NULL");
  if (input.ownerState === "unassigned") conditions.push("owner_id IS NULL");
  if (input.q !== undefined) {
    conditions.push(
      "(instr(lower(key), lower(?)) > 0 OR instr(lower(title), lower(?)) > 0 OR instr(lower(description), lower(?)) > 0 OR instr(lower(expected_behavior), lower(?)) > 0)",
    );
    parameters.push(input.q, input.q, input.q, input.q);
  }
  if (input.state !== undefined) {
    conditions.push("state = ?");
    parameters.push(input.state);
  }
  if (input.severity !== undefined) {
    conditions.push("severity = ?");
    parameters.push(input.severity);
  }
  parameters.push(input.limit);

  const rows = database
    .prepare(
      `SELECT id, project_id, number, key, title, description, expected_behavior,
              module_id, state, severity, priority, reporter_id, owner_id,
              verification_owner_id, duplicate_of_bug_id, occurrence_count,
              reopen_count, version, created_at, updated_at, closed_at
       FROM bugs
       WHERE ${conditions.join(" AND ")}
       ORDER BY updated_at DESC, number DESC, id DESC
       LIMIT ?`,
    )
    .all(...parameters) as unknown as MobileBugListRow[];

  return Object.freeze({
    snapshotSequence: snapshot.snapshot_sequence,
    items: Object.freeze(rows.map(toMobileBug)),
    nextCursor: null,
  });
}
