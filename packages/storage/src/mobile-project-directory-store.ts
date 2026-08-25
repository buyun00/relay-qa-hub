import type { DatabaseSync } from "node:sqlite";

import { MobileRelayStorageError } from "./mobile-relay-store.js";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export type MobileProjectRole =
  | "viewer"
  | "reporter"
  | "developer"
  | "verifier"
  | "triager"
  | "release_manager"
  | "project_admin";

export interface MobileProjectDirectoryScope {
  readonly accountId: string;
  readonly actorId: string;
}

export interface ListMobileVisibleProjectsInput extends MobileProjectDirectoryScope {
  readonly limit: number;
}

export interface ListMobileProjectMembersInput extends MobileProjectDirectoryScope {
  readonly projectId: string;
  readonly limit: number;
}

export interface ListMobileProjectModulesInput extends MobileProjectDirectoryScope {
  readonly projectId: string;
}

export interface MobileVisibleProject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly active: true;
  readonly roles: readonly MobileProjectRole[];
}

export interface MobileVisibleProjectList {
  readonly snapshotSequence: number;
  readonly items: readonly MobileVisibleProject[];
  readonly nextCursor: null;
}

export interface MobileProjectMember {
  readonly userId: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly roles: readonly MobileProjectRole[];
  readonly active: true;
}

export interface MobileProjectMemberList {
  readonly projectId: string;
  readonly snapshotSequence: number;
  readonly items: readonly MobileProjectMember[];
  readonly nextCursor: null;
}

export interface MobileProjectModule {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly active: boolean;
}

export interface MobileProjectModuleList {
  readonly projectId: string;
  readonly items: readonly MobileProjectModule[];
}

interface VisibleProjectRow {
  readonly id: string;
  readonly project_key: string;
  readonly name: string;
  readonly membership_id: string;
}

interface ProjectMemberRow {
  readonly user_id: string;
  readonly display_name: string;
  readonly membership_id: string;
}

interface ProjectModuleRow {
  readonly id: string;
  readonly name: string;
  readonly active: number;
}

function requireUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} must be a UUID`);
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

function requireDirectoryScope(input: MobileProjectDirectoryScope): void {
  requireUuid(input.accountId, "accountId");
  requireUuid(input.actorId, "actorId");
}

function requireActiveProjectMembership(
  database: DatabaseSync,
  input: MobileProjectDirectoryScope,
  projectId: string,
): void {
  requireUuid(projectId, "projectId");
  const membership = database
    .prepare(
      `SELECT 1 AS present
       FROM accounts AS account
       JOIN users AS actor
         ON actor.account_id = account.id
        AND actor.id = ?
        AND actor.status = 'active'
       JOIN projects AS project
         ON project.account_id = account.id
        AND project.id = ?
        AND project.status = 'active'
       JOIN memberships AS membership
         ON membership.account_id = account.id
        AND membership.project_id = project.id
        AND membership.user_id = actor.id
        AND membership.status = 'active'
       WHERE account.id = ? AND account.status = 'active'`,
    )
    .get(input.actorId, projectId, input.accountId);
  if (!membership) {
    throw new MobileRelayStorageError("FORBIDDEN", "actor has no active project membership");
  }
}

function listRoles(
  database: DatabaseSync,
  accountId: string,
  projectId: string,
  membershipId: string,
): readonly MobileProjectRole[] {
  const rows = database
    .prepare(
      `SELECT role
       FROM membership_roles
       WHERE account_id = ? AND project_id = ? AND membership_id = ?
       ORDER BY role ASC`,
    )
    .all(accountId, projectId, membershipId) as unknown as {
    readonly role: MobileProjectRole;
  }[];
  return Object.freeze(rows.map((row) => row.role));
}

function readVisibleSnapshotSequence(
  database: DatabaseSync,
  input: MobileProjectDirectoryScope,
  projectId?: string,
): number {
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(event.event_position), 0) AS snapshot_sequence
       FROM events AS event
       JOIN memberships AS membership
         ON membership.account_id = event.account_id
        AND membership.project_id = event.project_id
        AND membership.user_id = ?
        AND membership.status = 'active'
       WHERE event.account_id = ?
         AND (? IS NULL OR event.project_id = ?)`,
    )
    .get(input.actorId, input.accountId, projectId ?? null, projectId ?? null) as {
    readonly snapshot_sequence: number;
  };
  return row.snapshot_sequence;
}

export function listMobileVisibleProjects(
  database: DatabaseSync,
  input: ListMobileVisibleProjectsInput,
): MobileVisibleProjectList {
  requireDirectoryScope(input);
  requireLimit(input.limit);
  const rows = database
    .prepare(
      `SELECT project.id, project.project_key, project.name, membership.id AS membership_id
       FROM accounts AS account
       JOIN users AS actor
         ON actor.account_id = account.id
        AND actor.id = ?
        AND actor.status = 'active'
       JOIN memberships AS membership
         ON membership.account_id = account.id
        AND membership.user_id = actor.id
        AND membership.status = 'active'
       JOIN projects AS project
         ON project.account_id = membership.account_id
        AND project.id = membership.project_id
        AND project.status = 'active'
       WHERE account.id = ? AND account.status = 'active'
         AND EXISTS (
           SELECT 1 FROM membership_roles AS role
           WHERE role.account_id = membership.account_id
             AND role.project_id = membership.project_id
             AND role.membership_id = membership.id
         )
       ORDER BY project.project_key ASC, project.id ASC
       LIMIT ?`,
    )
    .all(input.actorId, input.accountId, input.limit) as unknown as VisibleProjectRow[];

  return Object.freeze({
    snapshotSequence: readVisibleSnapshotSequence(database, input),
    items: Object.freeze(
      rows.map((row) =>
        Object.freeze({
          id: row.id,
          key: row.project_key,
          name: row.name,
          active: true as const,
          roles: listRoles(database, input.accountId, row.id, row.membership_id),
        }),
      ),
    ),
    nextCursor: null,
  });
}

export function listMobileProjectMembers(
  database: DatabaseSync,
  input: ListMobileProjectMembersInput,
): MobileProjectMemberList {
  requireDirectoryScope(input);
  requireLimit(input.limit);
  requireActiveProjectMembership(database, input, input.projectId);
  const rows = database
    .prepare(
      `SELECT member.id AS user_id, member.display_name, membership.id AS membership_id
       FROM memberships AS membership
       JOIN users AS member
         ON member.account_id = membership.account_id
        AND member.id = membership.user_id
        AND member.status = 'active'
       WHERE membership.account_id = ? AND membership.project_id = ?
         AND membership.status = 'active'
         AND EXISTS (
           SELECT 1 FROM membership_roles AS role
           WHERE role.account_id = membership.account_id
             AND role.project_id = membership.project_id
             AND role.membership_id = membership.id
         )
       ORDER BY member.display_name COLLATE NOCASE ASC, member.id ASC
       LIMIT ?`,
    )
    .all(input.accountId, input.projectId, input.limit) as unknown as ProjectMemberRow[];

  return Object.freeze({
    projectId: input.projectId,
    snapshotSequence: readVisibleSnapshotSequence(database, input, input.projectId),
    items: Object.freeze(
      rows.map((row) =>
        Object.freeze({
          userId: row.user_id,
          projectId: input.projectId,
          displayName: row.display_name,
          roles: listRoles(database, input.accountId, input.projectId, row.membership_id),
          active: true as const,
        }),
      ),
    ),
    nextCursor: null,
  });
}

export function listMobileProjectModules(
  database: DatabaseSync,
  input: ListMobileProjectModulesInput,
): MobileProjectModuleList {
  requireDirectoryScope(input);
  requireActiveProjectMembership(database, input, input.projectId);
  const rows = database
    .prepare(
      `SELECT id, name, active
       FROM modules
       WHERE account_id = ? AND project_id = ?
       ORDER BY active DESC, name COLLATE NOCASE ASC, id ASC`,
    )
    .all(input.accountId, input.projectId) as unknown as ProjectModuleRow[];

  return Object.freeze({
    projectId: input.projectId,
    items: Object.freeze(
      rows.map((row) =>
        Object.freeze({
          id: row.id,
          projectId: input.projectId,
          name: row.name,
          active: row.active === 1,
        }),
      ),
    ),
  });
}
