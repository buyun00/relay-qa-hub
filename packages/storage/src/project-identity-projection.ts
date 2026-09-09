import type { DatabaseSync } from "node:sqlite";

export interface ProjectIdentityScope {
  readonly accountId: string;
  readonly projectId: string;
}

/**
 * Keep stored historical identities immutable while read models name the
 * currently active canonical project member.
 */
export function canonicalProjectUserId(
  database: DatabaseSync,
  scope: ProjectIdentityScope,
  userId: string,
): string {
  const row = database
    .prepare(
      `SELECT link.canonical_user_id
       FROM project_identity_links AS link
       JOIN users AS canonical
         ON canonical.account_id = link.account_id
        AND canonical.id = link.canonical_user_id
        AND canonical.status = 'active'
       JOIN memberships AS membership
         ON membership.account_id = canonical.account_id
        AND membership.project_id = link.project_id
        AND membership.user_id = canonical.id
        AND membership.status = 'active'
       WHERE link.account_id = ? AND link.project_id = ?
         AND link.source_user_id = ? AND link.status = 'active'`,
    )
    .get(scope.accountId, scope.projectId, userId) as
    { readonly canonical_user_id: string } | undefined;
  return row?.canonical_user_id ?? userId;
}

export function canonicalNullableProjectUserId(
  database: DatabaseSync,
  scope: ProjectIdentityScope,
  userId: string | null,
): string | null {
  return userId === null ? null : canonicalProjectUserId(database, scope, userId);
}
