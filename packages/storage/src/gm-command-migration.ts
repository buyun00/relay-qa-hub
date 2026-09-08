/** A GM command can satisfy legacy role guards without creating a membership. */
export function gmCommandMigration(schema: string): string {
  const latest = new Map<string, string>();
  for (const match of schema.matchAll(
    /DROP TRIGGER(?: IF EXISTS)?\s+(\w+);|CREATE TRIGGER\s+(\w+)[\s\S]*?(?:\nEND;|BEGIN SELECT [^\n]*? END;)/gu,
  )) {
    if (match[1]) latest.delete(match[1]);
    else latest.set(match[2]!, match[0]);
  }
  const views = new Map<string, string>();
  for (const match of schema.matchAll(
    /DROP VIEW(?: IF EXISTS)?\s+(\w+);|CREATE VIEW\s+(\w+)[\s\S]*?;/gu,
  )) {
    if (match[1]) views.delete(match[1]);
    else views.set(match[2]!, match[0]);
  }
  const guards = [...latest].flatMap(([name, sql]) => {
    const updated = sql
      .replace(/\b(FROM|JOIN) memberships\b/gu, "$1 command_project_memberships")
      .replace(/\b(FROM|JOIN) membership_roles\b/gu, "$1 command_project_roles");
    return updated === sql ? [] : [`DROP TRIGGER ${name};\n${updated}`];
  });
  const proofs = [...views].flatMap(([name, sql]) => {
    const updated = sql
      .replace(/\b(FROM|JOIN) memberships\b/gu, "$1 command_project_memberships")
      .replace(/\b(FROM|JOIN) membership_roles\b/gu, "$1 command_project_roles");
    return updated === sql ? [] : [`DROP VIEW ${name};\n${updated}`];
  });
  return `
CREATE TABLE storage_command_authorizations (
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  PRIMARY KEY (account_id, project_id, actor_id),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id),
  FOREIGN KEY (account_id, actor_id) REFERENCES users(account_id, id)
) STRICT;
CREATE VIEW command_project_memberships AS
  SELECT * FROM memberships
  UNION ALL
  SELECT 'command-gm:' || authorization.project_id || ':' || authorization.actor_id AS id,
    authorization.account_id, authorization.project_id, authorization.actor_id AS user_id,
    'active' AS status, project.created_at, project.updated_at, 1 AS version
  FROM storage_command_authorizations AS authorization
  JOIN accounts AS account ON account.id = authorization.account_id AND account.status = 'active'
  JOIN projects AS project ON project.account_id = authorization.account_id
    AND project.id = authorization.project_id AND project.status = 'active'
  JOIN users AS actor ON actor.account_id = authorization.account_id
    AND actor.id = authorization.actor_id AND actor.status = 'active';
CREATE VIEW command_project_roles AS
  SELECT * FROM membership_roles
  UNION ALL
  SELECT membership.account_id, membership.project_id, membership.id AS membership_id,
    capability.role, membership.created_at AS granted_at
  FROM command_project_memberships AS membership
  CROSS JOIN (SELECT 'viewer' AS role UNION ALL SELECT 'reporter' UNION ALL SELECT 'developer'
    UNION ALL SELECT 'verifier' UNION ALL SELECT 'triager' UNION ALL SELECT 'release_manager'
    UNION ALL SELECT 'project_admin') AS capability
  WHERE membership.id LIKE 'command-gm:%';
${proofs.join("\n")}
${guards.join("\n")}
`;
}
