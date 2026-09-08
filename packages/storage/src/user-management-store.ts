import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { MobileRelayStorageError, type MobileRelayScope } from "./mobile-relay-store.js";
import type { MobileProjectRole } from "./mobile-project-directory-store.js";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export interface ManagedUser {
  readonly userId: string;
  readonly displayName: string;
  readonly status: "active" | "disabled";
  readonly membershipStatus: "active" | "revoked";
  readonly membershipVersion: number;
  readonly roles: readonly MobileProjectRole[];
  readonly identity: "employee";
  readonly linkedToUserId: string | null;
  readonly linkedToDisplayName: string | null;
  readonly linkedUserCount: number;
  readonly taskCount: number;
  readonly activeSessionCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedUserList {
  readonly projectId: string;
  readonly items: readonly ManagedUser[];
}

export interface ActiveUserIdentityLink {
  readonly sourceUserId: string;
  readonly sourceDisplayName: string;
  readonly canonicalUserId: string;
  readonly canonicalDisplayName: string;
}

export interface ListManagedUsersInput extends MobileRelayScope {
  readonly limit: number;
}

interface ManagedUserMutationInput extends MobileRelayScope {
  readonly userId: string;
  readonly protectedUserIds: readonly string[];
  readonly createdAt: string;
}

export interface LinkManagedUserInput extends ManagedUserMutationInput {
  readonly canonicalUserId: string;
}

export type UnlinkManagedUserInput = ManagedUserMutationInput;
export type DisableManagedUserInput = ManagedUserMutationInput;

export interface ManagedUserMutationResult {
  readonly userId: string;
  readonly status: "active" | "disabled";
  readonly linkedToUserId: string | null;
}

interface ManagedUserRow {
  readonly user_id: string;
  readonly display_name: string;
  readonly status: "active" | "disabled";
  readonly membership_status: "active" | "revoked";
  readonly membership_version: number;
  readonly membership_id: string;
  readonly linked_to_user_id: string | null;
  readonly linked_to_display_name: string | null;
  readonly linked_user_count: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface IdentityLinkRow {
  readonly source_user_id: string;
  readonly source_display_name: string;
  readonly canonical_user_id: string;
  readonly canonical_display_name: string;
}

function requireUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} must be a UUID`);
  }
}

function requireTimestamp(value: string): void {
  if (value.length < 20 || !Number.isFinite(Date.parse(value))) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "createdAt must be an ISO timestamp");
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

function requireScope(input: MobileRelayScope): void {
  requireUuid(input.accountId, "accountId");
  requireUuid(input.projectId, "projectId");
  requireUuid(input.actorId, "actorId");
}

function requireManager(database: DatabaseSync, input: MobileRelayScope): void {
  requireScope(input);
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
    .get(input.projectId, input.actorId, input.accountId);
  if (!row) {
    throw new MobileRelayStorageError(
      "FORBIDDEN",
      "actor has no active project membership for user management",
    );
  }
}

function rolesForMembership(
  database: DatabaseSync,
  input: Pick<MobileRelayScope, "accountId" | "projectId">,
  membershipId: string,
): readonly MobileProjectRole[] {
  const rows = database
    .prepare(
      `SELECT role
       FROM membership_roles
       WHERE account_id = ? AND project_id = ? AND membership_id = ?
       ORDER BY role ASC`,
    )
    .all(input.accountId, input.projectId, membershipId) as unknown as {
    readonly role: MobileProjectRole;
  }[];
  return Object.freeze(rows.map((row) => row.role));
}

function taskCount(database: DatabaseSync, input: MobileRelayScope, userId: string): number {
  const row = database
    .prepare(
      `SELECT COUNT(DISTINCT reference.bug_id) AS task_count
       FROM (
         SELECT bug.id AS bug_id
         FROM bugs AS bug
         WHERE bug.account_id = ? AND bug.project_id = ?
           AND (bug.reporter_id = ? OR bug.owner_id = ? OR bug.verification_owner_id = ?)
         UNION ALL
         SELECT attempt.bug_id
         FROM repair_attempts AS attempt
         WHERE attempt.account_id = ? AND attempt.project_id = ? AND attempt.assignee_id = ?
         UNION ALL
         SELECT verification.bug_id
         FROM verifications AS verification
         WHERE verification.account_id = ? AND verification.project_id = ? AND verification.verifier_id = ?
       ) AS reference`,
    )
    .get(
      input.accountId,
      input.projectId,
      userId,
      userId,
      userId,
      input.accountId,
      input.projectId,
      userId,
      input.accountId,
      input.projectId,
      userId,
    ) as { readonly task_count: number };
  return row.task_count;
}

function activeSessionCount(database: DatabaseSync, accountId: string, userId: string): number {
  const row = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM browser_sessions
          WHERE account_id = ? AND user_id = ? AND revoked_at IS NULL)
         +
         (SELECT COUNT(*) FROM native_sessions
          WHERE account_id = ? AND user_id = ? AND revoked_at IS NULL)
         AS session_count`,
    )
    .get(accountId, userId, accountId, userId) as { readonly session_count: number };
  return row.session_count;
}

export function listManagedUsers(
  database: DatabaseSync,
  input: ListManagedUsersInput,
): ManagedUserList {
  requireManager(database, input);
  requireLimit(input.limit);
  const rows = database
    .prepare(
      `SELECT user.id AS user_id,
              user.display_name,
              user.status,
              membership.status AS membership_status,
              membership.version AS membership_version,
              membership.id AS membership_id,
              link.canonical_user_id AS linked_to_user_id,
              canonical.display_name AS linked_to_display_name,
              (
                SELECT COUNT(*)
                FROM project_identity_links AS inbound
                WHERE inbound.account_id = user.account_id
                  AND inbound.project_id = membership.project_id
                  AND inbound.canonical_user_id = user.id
                  AND inbound.status = 'active'
              ) AS linked_user_count,
              user.created_at,
              user.updated_at
       FROM memberships AS membership
       JOIN users AS user
         ON user.account_id = membership.account_id
        AND user.id = membership.user_id
       LEFT JOIN project_identity_links AS link
         ON link.account_id = user.account_id
        AND link.project_id = membership.project_id
        AND link.source_user_id = user.id
        AND link.status = 'active'
       LEFT JOIN users AS canonical
         ON canonical.account_id = link.account_id
        AND canonical.id = link.canonical_user_id
       WHERE membership.account_id = ? AND membership.project_id = ?
       ORDER BY user.status ASC, user.display_name COLLATE NOCASE ASC, user.id ASC
       LIMIT ?`,
    )
    .all(input.accountId, input.projectId, input.limit) as unknown as ManagedUserRow[];

  return Object.freeze({
    projectId: input.projectId,
    items: Object.freeze(
      rows.map((row) =>
        Object.freeze({
          userId: row.user_id,
          displayName: row.display_name,
          status: row.membership_status === "revoked" ? "disabled" : row.status,
          membershipStatus: row.membership_status,
          membershipVersion: row.membership_version,
          roles: rolesForMembership(database, input, row.membership_id),
          identity: "employee" as const,
          linkedToUserId: row.linked_to_user_id,
          linkedToDisplayName: row.linked_to_display_name,
          linkedUserCount: row.linked_user_count,
          taskCount: taskCount(database, input, row.user_id),
          activeSessionCount: activeSessionCount(database, input.accountId, row.user_id),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }),
      ),
    ),
  });
}

export function listActiveUserIdentityLinks(
  database: DatabaseSync,
  accountId: string,
  projectId?: string,
): readonly ActiveUserIdentityLink[] {
  requireUuid(accountId, "accountId");
  const rows = database
    .prepare(
      `SELECT source.id AS source_user_id,
              source.display_name AS source_display_name,
              canonical.id AS canonical_user_id,
              canonical.display_name AS canonical_display_name
       FROM ${projectId === undefined ? "user_identity_links" : "project_identity_links"} AS link
       JOIN users AS source
         ON source.account_id = link.account_id AND source.id = link.source_user_id
       JOIN users AS canonical
         ON canonical.account_id = link.account_id AND canonical.id = link.canonical_user_id
       WHERE link.account_id = ? AND link.status = 'active'
         ${projectId === undefined ? "" : "AND link.project_id = ?"}
       ORDER BY source.display_name COLLATE NOCASE ASC, source.id ASC`,
    )
    .all(
      ...(projectId === undefined ? [accountId] : [accountId, projectId]),
    ) as unknown as IdentityLinkRow[];
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        sourceUserId: row.source_user_id,
        sourceDisplayName: row.source_display_name,
        canonicalUserId: row.canonical_user_id,
        canonicalDisplayName: row.canonical_display_name,
      }),
    ),
  );
}

function requireMutation(database: DatabaseSync, input: ManagedUserMutationInput): Set<string> {
  requireManager(database, input);
  requireUuid(input.userId, "userId");
  requireTimestamp(input.createdAt);
  const protectedUserIds = new Set(input.protectedUserIds);
  for (const userId of protectedUserIds) requireUuid(userId, "protectedUserId");
  if (protectedUserIds.has(input.userId)) {
    throw new MobileRelayStorageError(
      "FORBIDDEN",
      "configured users cannot be changed from user management",
    );
  }
  if (input.userId === input.actorId) {
    throw new MobileRelayStorageError("FORBIDDEN", "the current user cannot manage itself");
  }
  const membership = database
    .prepare(
      `SELECT user.status AS user_status
       FROM users AS user
       JOIN memberships AS membership
         ON membership.account_id = user.account_id
        AND membership.user_id = user.id
        AND membership.project_id = ?
       WHERE user.account_id = ? AND user.id = ?`,
    )
    .get(input.projectId, input.accountId, input.userId) as
    { readonly user_status: "active" | "disabled" } | undefined;
  if (!membership) throw new MobileRelayStorageError("NOT_FOUND", "managed user was not found");
  return protectedUserIds;
}

function insertManagementEvent(
  database: DatabaseSync,
  input: ManagedUserMutationInput,
  action: "identity_linked" | "identity_unlinked" | "user_disabled",
  relatedUserId: string | null,
): void {
  database
    .prepare(
      `INSERT INTO user_management_events(
        id, account_id, project_id, actor_user_id, subject_user_id,
        action, related_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.accountId,
      input.projectId,
      input.actorId,
      input.userId,
      action,
      relatedUserId,
      input.createdAt,
    );
}

export function linkManagedUser(
  database: DatabaseSync,
  input: LinkManagedUserInput,
): ManagedUserMutationResult {
  requireMutation(database, input);
  requireUuid(input.canonicalUserId, "canonicalUserId");
  if (input.canonicalUserId === input.userId) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "a user cannot link to itself");
  }
  const target = database
    .prepare(
      `SELECT 1 AS present
       FROM users AS user
       JOIN memberships AS membership
         ON membership.account_id = user.account_id
        AND membership.user_id = user.id
        AND membership.project_id = ?
        AND membership.status = 'active'
       WHERE user.account_id = ? AND user.id = ? AND user.status = 'active'`,
    )
    .get(input.projectId, input.accountId, input.canonicalUserId);
  if (!target) {
    throw new MobileRelayStorageError(
      "NOT_FOUND",
      "canonical user must be an active project member",
    );
  }
  const existing = database
    .prepare(
      `SELECT canonical_user_id
       FROM project_identity_links
       WHERE account_id = ? AND source_user_id = ? AND project_id = ? AND status = 'active'`,
    )
    .get(input.accountId, input.userId, input.projectId) as
    { readonly canonical_user_id: string } | undefined;
  if (existing?.canonical_user_id === input.canonicalUserId) {
    const user = database
      .prepare("SELECT status FROM users WHERE account_id = ? AND id = ?")
      .get(input.accountId, input.userId) as { readonly status: "active" | "disabled" };
    return Object.freeze({
      userId: input.userId,
      status: user.status,
      linkedToUserId: input.canonicalUserId,
    });
  }
  if (existing) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "remove the existing identity link before choosing another canonical user",
    );
  }
  const targetIsAlias = database
    .prepare(
      `SELECT 1 AS present FROM project_identity_links
       WHERE account_id = ? AND source_user_id = ? AND project_id = ? AND status = 'active'`,
    )
    .get(input.accountId, input.canonicalUserId, input.projectId);
  const sourceIsCanonical = database
    .prepare(
      `SELECT 1 AS present FROM project_identity_links
       WHERE account_id = ? AND canonical_user_id = ? AND project_id = ? AND status = 'active'`,
    )
    .get(input.accountId, input.userId, input.projectId);
  if (targetIsAlias || sourceIsCanonical) {
    throw new MobileRelayStorageError(
      "VERSION_CONFLICT",
      "identity links must point directly to one canonical user",
    );
  }
  database
    .prepare(
      `INSERT INTO project_identity_links(
        id, account_id, source_user_id, canonical_user_id, status, project_id,
        created_by_user_id, created_at, revoked_by_user_id, revoked_at, version
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL, NULL, 1)`,
    )
    .run(
      randomUUID(),
      input.accountId,
      input.userId,
      input.canonicalUserId,
      input.projectId,
      input.actorId,
      input.createdAt,
    );
  insertManagementEvent(database, input, "identity_linked", input.canonicalUserId);
  const user = database
    .prepare("SELECT status FROM users WHERE account_id = ? AND id = ?")
    .get(input.accountId, input.userId) as { readonly status: "active" | "disabled" };
  return Object.freeze({
    userId: input.userId,
    status: user.status,
    linkedToUserId: input.canonicalUserId,
  });
}

export function unlinkManagedUser(
  database: DatabaseSync,
  input: UnlinkManagedUserInput,
): ManagedUserMutationResult {
  requireMutation(database, input);
  const link = database
    .prepare(
      `SELECT id, canonical_user_id, version
       FROM project_identity_links
       WHERE account_id = ? AND source_user_id = ? AND project_id = ? AND status = 'active'`,
    )
    .get(input.accountId, input.userId, input.projectId) as
    | { readonly id: string; readonly canonical_user_id: string; readonly version: number }
    | undefined;
  if (!link) throw new MobileRelayStorageError("NOT_FOUND", "active identity link was not found");
  const updated = database
    .prepare(
      `UPDATE project_identity_links
       SET status = 'revoked', revoked_by_user_id = ?, revoked_at = ?, version = version + 1
       WHERE id = ? AND account_id = ? AND status = 'active' AND version = ?`,
    )
    .run(input.actorId, input.createdAt, link.id, input.accountId, link.version);
  if (updated.changes !== 1) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "identity link changed concurrently");
  }
  insertManagementEvent(database, input, "identity_unlinked", link.canonical_user_id);
  const user = database
    .prepare("SELECT status FROM users WHERE account_id = ? AND id = ?")
    .get(input.accountId, input.userId) as { readonly status: "active" | "disabled" };
  return Object.freeze({ userId: input.userId, status: user.status, linkedToUserId: null });
}

export function disableManagedUser(
  database: DatabaseSync,
  input: DisableManagedUserInput,
): ManagedUserMutationResult {
  requireMutation(database, input);
  const membership = database
    .prepare(
      "SELECT status FROM memberships WHERE account_id = ? AND project_id = ? AND user_id = ?",
    )
    .get(input.accountId, input.projectId, input.userId) as { status: string };
  const link = database
    .prepare(
      "SELECT canonical_user_id FROM project_identity_links WHERE account_id = ? AND project_id = ? AND source_user_id = ? AND status = 'active'",
    )
    .get(input.accountId, input.projectId, input.userId) as
    { canonical_user_id: string } | undefined;
  if (membership.status !== "revoked") {
    database
      .prepare(
        "UPDATE memberships SET status = 'revoked', updated_at = ?, version = version + 1 WHERE account_id = ? AND project_id = ? AND user_id = ? AND status = 'active'",
      )
      .run(input.createdAt, input.accountId, input.projectId, input.userId);
    insertManagementEvent(database, input, "user_disabled", null);
  }
  // Sessions identify a person, not a globally selected project. The access
  // boundary checks membership on each request, retaining access to project B.
  return Object.freeze({
    userId: input.userId,
    status: "disabled",
    linkedToUserId: link?.canonical_user_id ?? null,
  });
}
