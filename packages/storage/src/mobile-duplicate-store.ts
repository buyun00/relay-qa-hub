import type { DatabaseSync } from "node:sqlite";

import {
  MobileRelayStorageError,
  type MobileRelayScope,
} from "./mobile-relay-store.js";

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

interface BugIdentityRow {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly description: string;
}

function requireUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} must be a UUID`);
  }
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
    | BugIdentityRow
    | undefined;
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
    if (normalize(row.title) !== normalizedTitle || normalize(row.description) !== normalizedDescription) {
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
