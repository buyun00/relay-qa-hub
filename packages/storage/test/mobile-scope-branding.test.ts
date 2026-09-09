import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SQLITE_MIGRATIONS } from "../src/sqlite-migrations.ts";
import { ensureMobileScope, type MobileScopeBootstrap } from "../src/mobile-bug-store.ts";
import { listMobileVisibleProjects } from "../src/mobile-project-directory-store.ts";

test("configured names update the exact existing scope once while preserving project identity", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const migration of SQLITE_MIGRATIONS) database.exec(migration.sql);
  const scope: MobileScopeBootstrap = {
    accountId: "70000000-0000-4000-8000-000000000001",
    projectId: "70000000-0000-4000-8000-000000000002",
    actorId: "70000000-0000-4000-8000-000000000003",
    membershipId: "70000000-0000-4000-8000-000000000004",
    projectKey: "LOCAL",
    createdAt: "2026-08-25T00:00:00.000Z",
    projectName: "Previous project name",
    accountDisplayName: "Previous account name",
    actorDisplayName: "Existing person",
  };
  const apply = (value: MobileScopeBootstrap) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      ensureMobileScope(database, value);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };
  try {
    apply(scope);
    const other = {
      ...scope,
      projectId: "70000000-0000-4000-8000-000000000005",
      membershipId: "70000000-0000-4000-8000-000000000006",
      projectKey: "OTHER",
      projectName: "Another project",
    };
    apply(other);
    const renamed = {
      ...scope,
      projectName: "OZDQP",
      accountDisplayName: "OZDQP",
      createdAt: "2026-09-04T10:00:00.000Z",
    };
    apply(renamed);
    const current = database
      .prepare("SELECT id,project_key,name,version FROM projects WHERE id=?")
      .get(scope.projectId);
    assert.deepEqual(
      { ...current },
      { id: scope.projectId, project_key: "LOCAL", name: "OZDQP", version: 2 },
    );
    assert.equal(
      database.prepare("SELECT name FROM projects WHERE id=?").get(other.projectId)?.["name"],
      "Another project",
    );
    assert.equal(
      database.prepare("SELECT display_name FROM users WHERE id=?").get(scope.actorId)?.[
        "display_name"
      ],
      "Existing person",
    );
    assert.equal(
      database.prepare("SELECT display_name FROM accounts WHERE id=?").get(scope.accountId)?.[
        "display_name"
      ],
      "OZDQP",
    );
    const directory = listMobileVisibleProjects(
      database,
      {
        accountId: scope.accountId,
        actorId: scope.actorId,
        authorizationProjectId: scope.projectId,
        limit: 10,
      },
      new Uint8Array(32),
    );
    assert.equal(directory.items.find((p) => p.id === scope.projectId)?.name, "OZDQP");
    apply(renamed);
    assert.deepEqual(
      database
        .prepare("SELECT id,project_key,name,version FROM projects WHERE id=?")
        .get(scope.projectId),
      current,
    );
    assert.throws(
      () => apply({ ...renamed, projectKey: "WRONG", projectName: "Wrong target" }),
      /conflicts with existing tenant identity/u,
    );
    assert.equal(
      database.prepare("SELECT name FROM projects WHERE id=?").get(scope.projectId)?.["name"],
      "OZDQP",
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM memberships").get()?.["n"], 2);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});
