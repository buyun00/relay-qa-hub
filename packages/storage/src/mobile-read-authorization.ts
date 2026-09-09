import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { digestMobileReadBinding } from "./mobile-read-cursor.js";
import { MobileRelayStorageError } from "./mobile-relay-store.js";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export interface MobileReadAuthorizationInput {
  readonly accountId: string;
  readonly actorId: string;
  readonly authorizationProjectId: string;
}

export interface MobileReadAuthorizationSnapshot {
  readonly digest: string;
  readonly authorizedProjectIds: readonly string[];
  readonly isGm: boolean;
}

export function requireMobileReadUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} must be a UUID`);
  }
}

export function requireMobileReadLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "limit must be an integer from 1 through 100",
    );
  }
}

export function resolveMobileReadAuthorization(
  database: DatabaseSync,
  input: MobileReadAuthorizationInput,
  requestedProjectId?: string,
): MobileReadAuthorizationSnapshot {
  requireMobileReadUuid(input.accountId, "accountId");
  requireMobileReadUuid(input.actorId, "actorId");
  requireMobileReadUuid(input.authorizationProjectId, "authorizationProjectId");
  if (requestedProjectId !== undefined) requireMobileReadUuid(requestedProjectId, "projectId");

  const principal = database
    .prepare(
      `SELECT account.id AS account_id, account.status AS account_status,
              account.version AS account_version,
              actor.id AS actor_id, actor.status AS actor_status,
              actor.version AS actor_version
       FROM accounts AS account
       JOIN users AS actor
         ON actor.account_id = account.id AND actor.id = ? AND actor.status = 'active'
       JOIN projects AS project
         ON project.account_id = account.id AND project.id = ? AND project.status = 'active'
       WHERE account.id = ? AND account.status = 'active'
         AND EXISTS (
           SELECT 1 FROM command_project_memberships AS membership
           WHERE membership.account_id = account.id
             AND membership.project_id = project.id
             AND membership.user_id = actor.id
             AND membership.status = 'active'
         )`,
    )
    .get(input.actorId, input.authorizationProjectId, input.accountId) as
    Readonly<Record<string, SQLInputValue>> | undefined;
  if (!principal) {
    throw new MobileRelayStorageError("FORBIDDEN", "actor has no active project membership");
  }

  const isGm =
    database
      .prepare(
        `SELECT 1 AS present FROM storage_command_authorizations
         WHERE account_id = ? AND project_id = ? AND actor_id = ?`,
      )
      .get(input.accountId, input.authorizationProjectId, input.actorId) !== undefined;
  const memberships = database
    .prepare(
      `SELECT membership.id, membership.project_id, membership.status, membership.version,
              project.status AS project_status, project.version AS project_version
       FROM memberships AS membership
       JOIN projects AS project
         ON project.account_id = membership.account_id AND project.id = membership.project_id
       WHERE membership.account_id = ? AND membership.user_id = ?
       ORDER BY membership.project_id, membership.id`,
    )
    .all(input.accountId, input.actorId);
  const gmProjects = isGm
    ? database
        .prepare(
          `SELECT id, status, version FROM projects
           WHERE account_id = ? ORDER BY id`,
        )
        .all(input.accountId)
    : [];
  const authorizedProjectIds = Object.freeze(
    (isGm ? gmProjects : memberships)
      .filter((row) => {
        if (isGm) return row.status === "active";
        return row.status === "active" && row.project_status === "active";
      })
      .map((row) => String(isGm ? row.id : row.project_id))
      .filter((id, index, rows) => rows.indexOf(id) === index)
      .sort(),
  );
  if (
    authorizedProjectIds.length === 0 ||
    (requestedProjectId !== undefined && !authorizedProjectIds.includes(requestedProjectId))
  ) {
    throw new MobileRelayStorageError("FORBIDDEN", "actor has no active project membership");
  }

  const placeholders = authorizedProjectIds.map(() => "?").join(", ");
  const roles = database
    .prepare(
      `SELECT membership.project_id, role.role
       FROM command_project_memberships AS membership
       JOIN command_project_roles AS role
         ON role.account_id = membership.account_id
        AND role.project_id = membership.project_id
        AND role.membership_id = membership.id
       WHERE membership.account_id = ? AND membership.user_id = ?
         AND membership.project_id IN (${placeholders})
       ORDER BY membership.project_id, role.role`,
    )
    .all(input.accountId, input.actorId, ...authorizedProjectIds);
  return Object.freeze({
    digest: digestMobileReadBinding({
      principal,
      isGm,
      gmProjects,
      memberships: isGm
        ? []
        : memberships.filter((row) => row.status === "active" && row.project_status === "active"),
      roles,
    }),
    authorizedProjectIds,
    isGm,
  });
}

export function readMobileProjectSnapshotSequence(
  database: DatabaseSync,
  accountId: string,
  projectIds: readonly string[],
): number {
  if (projectIds.length === 0) return 0;
  const placeholders = projectIds.map(() => "?").join(", ");
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(event_position), 0) AS snapshot_sequence
       FROM events WHERE account_id = ? AND project_id IN (${placeholders})`,
    )
    .get(accountId, ...projectIds) as { readonly snapshot_sequence: number };
  if (!Number.isSafeInteger(row.snapshot_sequence) || row.snapshot_sequence < 0) {
    throw new Error("mobile read snapshot sequence is invalid");
  }
  return row.snapshot_sequence;
}
