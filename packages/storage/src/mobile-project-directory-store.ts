import type { DatabaseSync } from "node:sqlite";

import { digestMobileReadBinding } from "./mobile-read-cursor.js";
import {
  requireMobileReadLimit,
  resolveMobileReadAuthorization,
} from "./mobile-read-authorization.js";
import { readMobileSnapshotPage } from "./mobile-read-snapshot-store.js";
import { MobileRelayStorageError } from "./mobile-relay-store.js";
import { canonicalProjectUserId } from "./project-identity-projection.js";

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
  /** Optional trusted server anchor; when absent storage selects one current actor membership. */
  readonly authorizationProjectId?: string;
  /** Account-wide GM authority asserted only by the authenticated API adapter. */
  readonly isGm?: true;
  readonly cursor?: string;
  readonly limit: number;
}

export interface ListMobileProjectMembersInput extends MobileProjectDirectoryScope {
  readonly authorizationProjectId: string;
  readonly projectId: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface ListMobileProjectModulesInput extends MobileProjectDirectoryScope {
  readonly projectId: string;
}

export interface GetMobileProjectAccessInput extends MobileProjectDirectoryScope {
  readonly projectId: string;
}

export interface MobileProjectAccess {
  readonly projectId: string;
  readonly projectKey: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly roles: readonly MobileProjectRole[];
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
  readonly nextCursor: string | null;
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
  readonly nextCursor: string | null;
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
       JOIN command_project_memberships AS membership
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

/** Resolve one current actor/project capability without relying on a directory page. */
export function getMobileProjectAccess(
  database: DatabaseSync,
  input: GetMobileProjectAccessInput,
): MobileProjectAccess | null {
  requireDirectoryScope(input);
  requireUuid(input.projectId, "projectId");
  const rows = database
    .prepare(
      `SELECT DISTINCT project.project_key, actor.display_name, role.role
       FROM accounts AS account
       JOIN projects AS project ON project.account_id = account.id
         AND project.id = ? AND project.status = 'active'
       JOIN users AS actor ON actor.account_id = account.id
         AND actor.id = ? AND actor.status = 'active'
       JOIN command_project_memberships AS membership
         ON membership.account_id = account.id AND membership.project_id = project.id
         AND membership.user_id = actor.id AND membership.status = 'active'
       JOIN command_project_roles AS role
         ON role.account_id = membership.account_id AND role.project_id = membership.project_id
         AND role.membership_id = membership.id
       WHERE account.id = ? AND account.status = 'active'
       ORDER BY role.role`,
    )
    .all(input.projectId, input.actorId, input.accountId) as unknown as {
    readonly project_key: string;
    readonly display_name: string;
    readonly role: MobileProjectRole;
  }[];
  if (!rows.length) return null;
  return Object.freeze({
    projectId: input.projectId,
    projectKey: rows[0]!.project_key,
    actorId: input.actorId,
    actorName: rows[0]!.display_name,
    roles: Object.freeze(rows.map((row) => row.role)),
  });
}

export function listMobileVisibleProjects(
  database: DatabaseSync,
  input: ListMobileVisibleProjectsInput,
  cursorSigningKey: Uint8Array,
): MobileVisibleProjectList {
  requireDirectoryScope(input);
  requireMobileReadLimit(input.limit);
  const authorizationProjectId =
    input.isGm === true
      ? null
      : (input.authorizationProjectId ??
        (
          database
            .prepare(
              `SELECT project.id
               FROM accounts AS account
               JOIN users AS actor
                 ON actor.account_id = account.id AND actor.id = ? AND actor.status = 'active'
               JOIN command_project_memberships AS membership
                 ON membership.account_id = account.id
                AND membership.user_id = actor.id AND membership.status = 'active'
               JOIN projects AS project
                 ON project.account_id = membership.account_id
                AND project.id = membership.project_id AND project.status = 'active'
               WHERE account.id = ? AND account.status = 'active'
               ORDER BY project.id ASC
               LIMIT 1`,
            )
            .get(input.actorId, input.accountId) as { readonly id: string } | undefined
        )?.id);
  if (authorizationProjectId === undefined) {
    throw new MobileRelayStorageError("FORBIDDEN", "actor has no active project membership");
  }
  let authorization: ReturnType<typeof resolveMobileReadAuthorization> | undefined;
  const resolveAuthorization = (): ReturnType<typeof resolveMobileReadAuthorization> => {
    if (input.isGm !== true) {
      return resolveMobileReadAuthorization(database, {
        accountId: input.accountId,
        actorId: input.actorId,
        authorizationProjectId: authorizationProjectId!,
      });
    }
    const principal = database
      .prepare(
        `SELECT account.id AS account_id, account.status AS account_status,
                account.version AS account_version,
                actor.id AS actor_id, actor.status AS actor_status,
                actor.version AS actor_version
         FROM accounts AS account
         JOIN users AS actor
           ON actor.account_id = account.id AND actor.id = ? AND actor.status = 'active'
         WHERE account.id = ? AND account.status = 'active'`,
      )
      .get(input.actorId, input.accountId);
    if (principal === undefined) {
      throw new MobileRelayStorageError("FORBIDDEN", "GM principal is not active");
    }
    const gmProjects = database
      .prepare(
        `SELECT id, status, version FROM projects
         WHERE account_id = ?
         ORDER BY id`,
      )
      .all(input.accountId);
    const authorizedProjectIds = Object.freeze(
      gmProjects.filter((row) => row.status === "active").map((row) => String(row.id)),
    );
    return Object.freeze({
      digest: digestMobileReadBinding({ principal, isGm: true, gmProjects }),
      authorizedProjectIds,
      isGm: true,
    });
  };
  const page = readMobileSnapshotPage(database, {
    kind: "visible-projects",
    accountId: input.accountId,
    actorId: input.actorId,
    authorizationProjectId,
    authorizationDigest: () => {
      authorization = resolveAuthorization();
      return authorization.digest;
    },
    filterDigest: digestMobileReadBinding({ limit: input.limit }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    limit: input.limit,
    signingKey: cursorSigningKey,
    materialize: () => {
      if (authorization === undefined) throw new Error("mobile project authorization is missing");
      const rows = (authorization.isGm
        ? database
            .prepare(
              `SELECT project.id, project.project_key, project.name,
                      'project_admin' AS role
               FROM projects AS project
               WHERE project.account_id = ? AND project.status = 'active'
               ORDER BY project.project_key ASC, project.id ASC`,
            )
            .all(input.accountId)
        : database
            .prepare(
              `SELECT project.id, project.project_key, project.name, role.role
               FROM projects AS project
               JOIN command_project_memberships AS membership
                 ON membership.account_id = project.account_id
                AND membership.project_id = project.id
                AND membership.user_id = ?
                AND membership.status = 'active'
               JOIN command_project_roles AS role
                 ON role.account_id = membership.account_id
                AND role.project_id = membership.project_id
                AND role.membership_id = membership.id
               WHERE project.account_id = ? AND project.status = 'active'
               ORDER BY project.project_key ASC, project.id ASC, role.role ASC`,
            )
            .all(input.actorId, input.accountId)) as unknown as {
        readonly id: string;
        readonly project_key: string;
        readonly name: string;
        readonly role: MobileProjectRole;
      }[];
      const grouped = new Map<
        string,
        {
          readonly id: string;
          readonly key: string;
          readonly name: string;
          readonly roles: Set<MobileProjectRole>;
        }
      >();
      for (const row of rows) {
        const current = grouped.get(row.id) ?? {
          id: row.id,
          key: row.project_key,
          name: row.name,
          roles: new Set<MobileProjectRole>(),
        };
        current.roles.add(row.role);
        grouped.set(row.id, current);
      }
      const items = [...grouped.values()]
        .map((row) =>
          Object.freeze({
            id: row.id,
            key: row.key,
            name: row.name,
            active: true as const,
            roles: Object.freeze([...row.roles].sort()),
          }),
        )
        .sort(
          (left, right) => left.key.localeCompare(right.key) || left.id.localeCompare(right.id),
        );
      return Object.freeze({ items: Object.freeze(items), metadata: Object.freeze({}) });
    },
  });
  return Object.freeze({
    snapshotSequence: page.snapshotSequence,
    items: page.items,
    nextCursor: page.nextCursor,
  });
}

export function listMobileProjectMembers(
  database: DatabaseSync,
  input: ListMobileProjectMembersInput,
  cursorSigningKey: Uint8Array,
): MobileProjectMemberList {
  requireDirectoryScope(input);
  requireMobileReadLimit(input.limit);
  let authorization: ReturnType<typeof resolveMobileReadAuthorization> | undefined;
  const page = readMobileSnapshotPage(database, {
    kind: "project-members",
    accountId: input.accountId,
    actorId: input.actorId,
    authorizationProjectId: input.authorizationProjectId,
    authorizationDigest: () => {
      authorization = resolveMobileReadAuthorization(database, input, input.projectId);
      return authorization.digest;
    },
    filterDigest: digestMobileReadBinding({ limit: input.limit, projectId: input.projectId }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    limit: input.limit,
    signingKey: cursorSigningKey,
    materialize: () => {
      if (authorization === undefined) throw new Error("mobile project authorization is missing");
      const rows = database
        .prepare(
          `SELECT member.id AS user_id, member.display_name, role.role
           FROM memberships AS membership
           JOIN users AS member
             ON member.account_id = membership.account_id
            AND member.id = membership.user_id
            AND member.status = 'active'
           JOIN membership_roles AS role
             ON role.account_id = membership.account_id
            AND role.project_id = membership.project_id
            AND role.membership_id = membership.id
           WHERE membership.account_id = ? AND membership.project_id = ?
             AND membership.status = 'active'
           ORDER BY member.id, role.role`,
        )
        .all(input.accountId, input.projectId) as unknown as {
        readonly user_id: string;
        readonly display_name: string;
        readonly role: MobileProjectRole;
      }[];
      const canonicalIds = new Map<string, string>();
      const canonicalId = (userId: string): string => {
        const cached = canonicalIds.get(userId);
        if (cached !== undefined) return cached;
        const canonical = canonicalProjectUserId(database, input, userId);
        canonicalIds.set(userId, canonical);
        return canonical;
      };
      const displayRows = database
        .prepare(
          `SELECT id, display_name FROM users WHERE account_id = ? AND status = 'active' ORDER BY id`,
        )
        .all(input.accountId) as unknown as {
        readonly id: string;
        readonly display_name: string;
      }[];
      const displayNames = new Map(displayRows.map((row) => [row.id, row.display_name]));
      const grouped = new Map<
        string,
        {
          readonly userId: string;
          readonly displayName: string;
          readonly roles: Set<MobileProjectRole>;
        }
      >();
      for (const row of rows) {
        const userId = canonicalId(row.user_id);
        const current = grouped.get(userId) ?? {
          userId,
          displayName: displayNames.get(userId) ?? row.display_name,
          roles: new Set<MobileProjectRole>(),
        };
        current.roles.add(row.role);
        grouped.set(userId, current);
      }
      const items = [...grouped.values()]
        .map((member) =>
          Object.freeze({
            userId: member.userId,
            projectId: input.projectId,
            displayName: member.displayName,
            roles: Object.freeze([...member.roles].sort()),
            active: true as const,
          }),
        )
        .sort(
          (left, right) =>
            left.displayName.toLowerCase().localeCompare(right.displayName.toLowerCase()) ||
            left.userId.localeCompare(right.userId),
        );
      return Object.freeze({ items: Object.freeze(items), metadata: Object.freeze({}) });
    },
  });
  return Object.freeze({
    projectId: input.projectId,
    snapshotSequence: page.snapshotSequence,
    items: page.items,
    nextCursor: page.nextCursor,
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
