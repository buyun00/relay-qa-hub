import type { DatabaseSync } from "node:sqlite";

import { MobileRelayStorageError, type MobileRelayScope } from "./mobile-relay-store.js";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const CANONICAL_UTC_MILLISECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_METRICS_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

/** The frozen domain order used by the metrics response. */
export const MOBILE_METRICS_STATES = [
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

export type MobileMetricsState = (typeof MOBILE_METRICS_STATES)[number];

export interface GetMobileMetricsOverviewInput extends MobileRelayScope {
  readonly from: string;
  readonly to: string;
}

export interface MobileMetricsOverview {
  readonly projectId: string;
  readonly window: {
    readonly from: string;
    readonly to: string;
  };
  readonly snapshotSequence: number;
  readonly newBugCount: number;
  readonly currentStateCounts: readonly {
    readonly state: MobileMetricsState;
    readonly count: number;
  }[];
}

interface MobileMetricsRow {
  readonly project_id: string;
  readonly snapshot_sequence: number;
  readonly new_bug_count: number;
  readonly state: MobileMetricsState;
  readonly state_count: number;
}

function requireUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} must be a UUID`);
  }
}

function requireCanonicalUtcMilliseconds(value: string, field: string): void {
  if (!CANONICAL_UTC_MILLISECONDS_PATTERN.test(value)) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      `${field} must be a canonical UTC ISO timestamp with milliseconds`,
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} is invalid`);
  }
}

function requireWindow(input: GetMobileMetricsOverviewInput): void {
  requireCanonicalUtcMilliseconds(input.from, "from");
  requireCanonicalUtcMilliseconds(input.to, "to");
  const from = Date.parse(input.from);
  const to = Date.parse(input.to);
  if (from >= to) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "from must be before to");
  }
  if (to - from > MAX_METRICS_WINDOW_MS) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "metrics window exceeds 366 days");
  }
}

function requireProjectMembership(
  database: DatabaseSync,
  input: GetMobileMetricsOverviewInput,
): void {
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
       JOIN memberships AS membership
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

/**
 * Read all overview facts in one SQLite statement. The single statement keeps
 * snapshotSequence, newBugCount, and the state counts on the same read view.
 */
export function getMobileMetricsOverview(
  database: DatabaseSync,
  input: GetMobileMetricsOverviewInput,
): MobileMetricsOverview {
  requireUuid(input.accountId, "accountId");
  requireUuid(input.projectId, "projectId");
  requireUuid(input.actorId, "actorId");
  requireWindow(input);
  requireProjectMembership(database, input);

  const rows = database
    .prepare(
      `WITH state_order(state, ordinal) AS (
         VALUES
           ('reported', 0),
           ('needs_info', 1),
           ('ready', 2),
           ('in_progress', 3),
           ('awaiting_build', 4),
           ('ready_for_verification', 5),
           ('closed', 6),
           ('deferred', 7),
           ('rejected', 8),
           ('duplicate', 9)
       ),
       state_counts AS (
         SELECT state_order.state, state_order.ordinal, COUNT(bugs.id) AS state_count
         FROM state_order
         LEFT JOIN bugs
           ON bugs.account_id = ?
          AND bugs.project_id = ?
          AND bugs.state = state_order.state
          AND NOT EXISTS (
            SELECT 1 FROM bug_deletions AS deletion
            WHERE deletion.account_id = bugs.account_id
              AND deletion.project_id = bugs.project_id
              AND deletion.bug_id = bugs.id
          )
         GROUP BY state_order.state, state_order.ordinal
       )
       SELECT
         ? AS project_id,
         COALESCE(
           (SELECT MAX(event_position)
            FROM events
            WHERE account_id = ? AND project_id = ?),
           0
         ) AS snapshot_sequence,
         (SELECT COUNT(*)
          FROM bugs
          WHERE account_id = ?
            AND project_id = ?
            AND created_at >= ?
            AND created_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM bug_deletions AS deletion
              WHERE deletion.account_id = bugs.account_id
                AND deletion.project_id = bugs.project_id
                AND deletion.bug_id = bugs.id
            )) AS new_bug_count,
         state,
         state_count
       FROM state_counts
       ORDER BY ordinal`,
    )
    .all(
      input.accountId,
      input.projectId,
      input.projectId,
      input.accountId,
      input.projectId,
      input.accountId,
      input.projectId,
      input.from,
      input.to,
    ) as unknown as MobileMetricsRow[];

  if (rows.length !== MOBILE_METRICS_STATES.length) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "metrics state projection is incomplete");
  }

  const currentStateCounts = rows.map((row, index) => {
    const expectedState = MOBILE_METRICS_STATES[index];
    if (
      row.state !== expectedState ||
      !Number.isSafeInteger(row.state_count) ||
      row.state_count < 0
    ) {
      throw new MobileRelayStorageError("INVALID_REQUEST", "metrics state projection is invalid");
    }
    return Object.freeze({ state: row.state, count: row.state_count });
  });
  const first = rows[0];
  if (
    !first ||
    first.project_id !== input.projectId ||
    !Number.isSafeInteger(first.snapshot_sequence) ||
    first.snapshot_sequence < 0 ||
    !Number.isSafeInteger(first.new_bug_count) ||
    first.new_bug_count < 0 ||
    rows.some(
      (row) =>
        row.project_id !== first.project_id ||
        row.snapshot_sequence !== first.snapshot_sequence ||
        row.new_bug_count !== first.new_bug_count,
    )
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "metrics projection is invalid");
  }

  return Object.freeze({
    projectId: input.projectId,
    window: Object.freeze({ from: input.from, to: input.to }),
    snapshotSequence: first.snapshot_sequence,
    newBugCount: first.new_bug_count,
    currentStateCounts: Object.freeze(currentStateCounts),
  });
}
