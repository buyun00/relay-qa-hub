import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SQLITE_MIGRATIONS } from "../src/sqlite-migrations.ts";
import { insertBugWithNextNumber } from "../src/sqlite.ts";
import { ensureMobileScope, createMobileBug } from "../src/mobile-bug-store.ts";
import { createBrowserSession, resolveBrowserSession } from "../src/browser-auth-store.ts";
import {
  projectManagement,
  projectMembershipId,
  type ProjectManagementInput,
  type ProjectRecord,
  type ProjectComponentList,
} from "../src/project-management-store.ts";
import {
  disableManagedUser,
  linkManagedUser,
  listManagedUsers,
} from "../src/user-management-store.ts";
import { listMobileBugs } from "../src/mobile-bug-list-store.ts";
import { createMobileComment } from "../src/mobile-comment-store.ts";

const accountId = "77000000-0000-4000-8000-000000000001";
const gmId = "77000000-0000-4000-8000-000000000002";
const aId = "77000000-0000-4000-8000-000000000003";
const bId = "77000000-0000-4000-8000-000000000004";
const userId = "77000000-0000-4000-8000-000000000005";
const timestamp = "2026-09-09T01:00:00.000Z";
test("GM migration changes only membership reads in existing typed audit guards", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const migration of SQLITE_MIGRATIONS.filter((item) => item.version < 14))
      database.exec(migration.sql);
    const before = database
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type IN ('trigger', 'view') ORDER BY name",
      )
      .all();
    database.exec(SQLITE_MIGRATIONS.find((item) => item.version === 14)!.sql);
    const after = database
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type IN ('trigger', 'view') AND name NOT IN ('command_project_memberships', 'command_project_roles') ORDER BY name",
      )
      .all();
    assert.deepEqual(
      after.map((row) => ({ ...row })),
      before.map((row) => ({
        ...row,
        sql: String(row.sql)
          .replace(/\b(FROM|JOIN) memberships\b/gu, "$1 command_project_memberships")
          .replace(/\b(FROM|JOIN) membership_roles\b/gu, "$1 command_project_roles"),
      })),
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM storage_command_authorizations").get()!.n,
      0,
    );
  } finally {
    database.close();
  }
});
function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = action();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of SQLITE_MIGRATIONS) database.exec(migration.sql);
  transaction(database, () =>
    ensureMobileScope(database, {
      accountId,
      actorId: gmId,
      projectId: aId,
      projectKey: "TESTA",
      membershipId: projectMembershipId(aId, gmId),
      actorDisplayName: "GM",
      createdAt: timestamp,
    }),
  );
  const execute = <T = unknown>(
    input: Omit<ProjectManagementInput, "accountId" | "actorId" | "now"> & { actorId?: string },
  ): T =>
    transaction(
      database,
      () =>
        projectManagement(database, { accountId, actorId: gmId, now: timestamp, ...input }) as T,
    );
  execute({ operation: "create", projectId: bId, key: "TESTB", name: "项目 B", isGm: true });
  return {
    database,
    execute,
    login: (projectId: string, id = userId, displayName = "员工") =>
      execute<{ userId: string; projectId: string }>({
        operation: "login",
        projectId,
        userId: id,
        displayName,
        email: `${id}@test.invalid`,
      }),
  };
}
test("entry login enrolls only selected project, retains stable identity and employee compatibility", () => {
  const { database, execute, login } = fixture();
  try {
    assert.deepEqual(login(aId), { userId, displayName: "员工", projectId: aId });
    const list = execute<{ items: ProjectRecord[] }>({ operation: "list", actorId: userId });
    assert.deepEqual(
      list.items.map((item) => item.id),
      [aId],
    );
    assert.throws(() => execute({ operation: "authorize", actorId: userId, projectId: bId }), {
      code: "PROJECT_NOT_ACCESSIBLE",
    });
    login(bId);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?").get(userId)?.["count"],
      1,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM memberships WHERE user_id = ?").get(userId)?.[
        "count"
      ],
      2,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM membership_roles WHERE membership_id = ?")
        .get(projectMembershipId(bId, userId))?.["count"],
      7,
    );
    assert.throws(
      () =>
        execute({
          operation: "create",
          actorId: userId,
          projectId: randomUUID(),
          key: "BAD",
          name: "bad",
        }),
      { code: "FORBIDDEN" },
    );
  } finally {
    database.close();
  }
});
test("disable and restore are project local; login never restores and B session stays usable", () => {
  const { database, execute, login } = fixture();
  try {
    login(aId);
    login(bId);
    transaction(database, () =>
      createBrowserSession(database, {
        accountId,
        userId,
        projectId: bId,
        sessionId: randomUUID(),
        tokenDigest: "a".repeat(64),
        issuedAt: timestamp,
        expiresAt: "2090-01-01T00:00:00.000Z",
      }),
    );
    transaction(database, () =>
      disableManagedUser(database, {
        accountId,
        actorId: gmId,
        projectId: aId,
        userId,
        protectedUserIds: [],
        createdAt: timestamp,
      }),
    );
    assert.throws(() => login(aId), { code: "PROJECT_MEMBERSHIP_DISABLED" });
    assert.equal(login(bId).userId, userId);
    assert.equal(
      database.prepare("SELECT status FROM users WHERE id = ?").get(userId)?.["status"],
      "active",
    );
    assert.equal(
      resolveBrowserSession(database, { tokenDigest: "a".repeat(64), now: timestamp })?.projectId,
      bId,
    );
    assert.throws(() => execute({ operation: "authorize", actorId: userId, projectId: aId }), {
      code: "PROJECT_NOT_ACCESSIBLE",
    });
    const result = execute<{ version: number }>({
      operation: "membership",
      projectId: aId,
      userId,
      active: true,
      expectedVersion: 2,
      isGm: true,
    });
    assert.equal(result.version, 3);
    assert.equal(login(aId).userId, userId);
    assert.throws(
      () =>
        execute({
          operation: "membership",
          projectId: aId,
          userId,
          active: false,
          expectedVersion: 2,
          isGm: true,
        }),
      { code: "VERSION_CONFLICT" },
    );
  } finally {
    database.close();
  }
});
test("project links affect only matching login, directory and historical owner filters", () => {
  const { database, execute, login } = fixture();
  try {
    const canonicalId = randomUUID();
    login(aId);
    login(bId);
    login(aId, canonicalId, "负责人");
    login(bId, canonicalId, "负责人");
    const createHistoricalComment = (projectId: string, suffix: string) => {
      const bug = transaction(database, () =>
        createMobileBug(database, {
          accountId,
          projectId,
          actorId: userId,
          clientSubmissionId: randomUUID(),
          payloadDigest: suffix.repeat(64),
          title: `Historical comment ${suffix}`,
          description: "Read models project linked identities",
          expectedBehavior: "Canonical author labels remain project-scoped",
          severity: "S2",
          priority: "P2",
          ownerId: userId,
          verificationOwnerId: userId,
          occurrence: {
            observedAt: timestamp,
            platform: "web",
            steps: ["Read project comment"],
            actualBehavior: "Historical author",
          },
          attachmentIds: [],
          captureBundleId: null,
          createdAt: timestamp,
        }),
      );
      const input = {
        accountId,
        projectId,
        actorId: userId,
        bugId: bug.bug.id,
        clientSubmissionId: randomUUID(),
        body: `Historical project ${suffix}`,
        payloadDigest: suffix.repeat(64),
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        createdAt: timestamp,
      };
      transaction(database, () => createMobileComment(database, input));
      return { bugId: bug.bug.id, input };
    };
    const commentA = createHistoricalComment(aId, "a");
    const commentB = createHistoricalComment(bId, "b");
    transaction(database, () =>
      linkManagedUser(database, {
        accountId,
        actorId: gmId,
        projectId: aId,
        userId,
        canonicalUserId: canonicalId,
        protectedUserIds: [],
        createdAt: timestamp,
      }),
    );
    assert.equal(
      transaction(database, () => createMobileComment(database, commentA.input)).comment.authorId,
      canonicalId,
    );
    assert.equal(
      execute<{ items: { authorId: string }[] }>({
        operation: "comments",
        projectId: aId,
        bugId: commentA.bugId,
      }).items[0]?.authorId,
      canonicalId,
    );
    assert.equal(
      execute<{ items: { authorId: string }[] }>({
        operation: "comments",
        projectId: bId,
        bugId: commentB.bugId,
      }).items[0]?.authorId,
      userId,
    );
    assert.ok(
      execute<{ items: { actorId: string }[] }>({
        operation: "audit",
        projectId: aId,
        isGm: true,
      }).items.some((item) => item.actorId === canonicalId),
    );
    assert.ok(
      execute<{ items: { actorId: string }[] }>({
        operation: "audit",
        projectId: bId,
        isGm: true,
      }).items.some((item) => item.actorId === userId),
    );
    assert.equal(login(aId).userId, canonicalId);
    assert.equal(login(bId).userId, userId);
    assert.equal(
      listManagedUsers(database, {
        accountId,
        actorId: gmId,
        projectId: bId,
        limit: 100,
      }).items.find((item) => item.userId === userId)?.linkedToUserId,
      null,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM user_identity_links").get()?.["count"],
      0,
    );
    assert.equal(
      execute<{ items: unknown[] }>({ operation: "audit", projectId: aId, isGm: true }).items
        .length >= 2,
      true,
    );
    transaction(database, () =>
      disableManagedUser(database, {
        accountId,
        actorId: gmId,
        projectId: aId,
        userId: canonicalId,
        protectedUserIds: [],
        createdAt: timestamp,
      }),
    );
    assert.equal(
      execute<{ items: { authorId: string }[] }>({
        operation: "comments",
        projectId: aId,
        bugId: commentA.bugId,
      }).items[0]?.authorId,
      userId,
    );
    assert.ok(
      execute<{ items: { actorId: string }[] }>({
        operation: "audit",
        projectId: aId,
        isGm: true,
      }).items.some((item) => item.actorId === userId),
    );
  } finally {
    database.close();
  }
});
test("components default disabled, redact configuration, enforce versions and dependency cascade", () => {
  const { database, execute, login } = fixture();
  try {
    login(aId);
    login(bId);
    assert.ok(
      execute<ProjectComponentList>({
        operation: "components",
        actorId: userId,
        projectId: aId,
      }).items.every((item) => !item.enabled),
    );
    const set = (
      componentKey: "build" | "upload.incremental" | "build_upload.single",
      enabled: boolean,
      expectedVersion: number,
      config: Record<string, unknown> = {},
    ) =>
      execute<ProjectComponentList>({
        operation: "setComponent",
        projectId: aId,
        isGm: true,
        componentKey,
        enabled,
        expectedVersion,
        config,
      });
    assert.throws(() => set("build_upload.single", true, 0), {
      code: "COMPONENT_DEPENDENCY_REQUIRED",
    });
    set("build", true, 0, {
      baseUrl: "https://test.invalid",
      job: "PREVIEW",
      downloadOrigin: "https://test.invalid",
      zipPath: "/preview.zip",
      artifactUrlTemplate: "https://test.invalid/{buildNumber}.zip",
      credentialRef: "preview-build",
      presets: { preview: { PRIVATE_PARAMETER: "HIDDEN" } },
      password: "TOPSECRET",
      arbitrary: { token: "HIDDEN" },
    });
    set("upload.incremental", true, 0, {
      targetPrefix: "preview/test",
      credentialRef: "preview/uploader",
    });
    set("build_upload.single", true, 0, { buildPreset: "preview", uploadTarget: "preview" });
    const response = execute<ProjectComponentList>({
      operation: "components",
      projectId: aId,
      actorId: userId,
    });
    assert.equal(JSON.stringify(response).includes("TOPSECRET"), false);
    assert.equal(JSON.stringify(response).includes("HIDDEN"), false);
    assert.equal(response.items.find((item) => item.key === "build")?.status, "ready");
    assert.deepEqual(response.items.find((item) => item.key === "build")?.config["presetOptions"], [
      "preview",
    ]);
    assert.equal(
      response.items.find((item) => item.key === "upload.incremental")?.status,
      "needs_configuration",
    );
    assert.ok(
      execute<ProjectComponentList>({
        operation: "components",
        projectId: bId,
        actorId: userId,
      }).items.every((item) => !item.enabled),
    );
    assert.throws(() => set("build", false, 0), { code: "VERSION_CONFLICT" });
    const result = set("build", false, 1);
    assert.equal(result.items.find((item) => item.key === "build_upload.single")?.enabled, false);
    assert.equal(
      JSON.stringify(execute({ operation: "audit", projectId: aId, actorId: userId })).includes(
        "TOPSECRET",
      ),
      false,
    );
  } finally {
    database.close();
  }
});
test("project disable blocks login and reads without deleting history; reactivation uses version CAS", () => {
  const { database, execute, login } = fixture();
  try {
    login(bId);
    const disabled = execute<ProjectRecord>({
      operation: "update",
      projectId: bId,
      isGm: true,
      active: false,
      expectedVersion: 1,
    });
    assert.equal(disabled.active, false);
    assert.equal(disabled.version, 2);
    assert.throws(() => login(bId), { code: "PROJECT_NOT_ACCESSIBLE" });
    assert.throws(() => execute({ operation: "entry", projectId: bId }), {
      code: "PROJECT_NOT_ACCESSIBLE",
    });
    assert.throws(() => execute({ operation: "components", projectId: bId, actorId: userId }), {
      code: "PROJECT_NOT_ACCESSIBLE",
    });
    assert.equal(
      execute<ProjectRecord>({
        operation: "update",
        projectId: bId,
        isGm: true,
        active: true,
        expectedVersion: 2,
      }).version,
      3,
    );
    assert.equal(login(bId).projectId, bId);
  } finally {
    database.close();
  }
});
test("record project guard rejects wrong project while same employee can work in both", () => {
  const { database, execute, login } = fixture();
  try {
    login(aId);
    login(bId);
    const created = transaction(database, () =>
      createMobileBug(database, {
        accountId,
        projectId: bId,
        actorId: userId,
        clientSubmissionId: randomUUID(),
        payloadDigest: "a".repeat(64),
        title: "项目 B Bug",
        description: "description",
        expectedBehavior: "expected",
        severity: "S2",
        priority: "P2",
        ownerId: userId,
        verificationOwnerId: userId,
        occurrence: {
          observedAt: timestamp,
          platform: "web",
          steps: ["step"],
          actualBehavior: "actual",
        },
        attachmentIds: [],
        captureBundleId: null,
        createdAt: timestamp,
      }),
    );
    assert.deepEqual(
      execute({
        operation: "recordProject",
        actorId: userId,
        recordType: "bug",
        recordId: created.bug.id,
      }),
      { projectId: bId },
    );
    assert.throws(
      () =>
        execute({
          operation: "recordProject",
          actorId: userId,
          projectId: aId,
          recordType: "bug",
          recordId: created.bug.id,
        }),
      { code: "NOT_FOUND" },
    );
    assert.equal(
      listMobileBugs(
        database,
        { accountId, projectId: aId, actorId: userId, limit: 20 },
        new Uint8Array(32).fill(7),
      ).items.length,
      0,
    );
  } finally {
    database.close();
  }
});

test("Bug listing spans the exact authorized project set and caps vendor pages at 100", () => {
  const { database, login } = fixture();
  const signingKey = new Uint8Array(32).fill(13);
  try {
    login(aId);
    login(bId);
    const bugIds: string[] = [];
    transaction(database, () => {
      for (let index = 0; index < 102; index += 1) {
        const id = randomUUID();
        bugIds.push(id);
        insertBugWithNextNumber(database, {
          id,
          accountId,
          projectId: index === 101 ? bId : aId,
          title: `Paged Bug ${index}`,
          description: "Authorized project pagination",
          expectedBehavior: "Every authorized row is returned exactly once",
          severity: "S2",
          priority: (["P4", "P0", "P2", "P1", "P3"] as const)[index % 5]!,
          reporterId: userId,
          ownerId: userId,
          verificationOwnerId: userId,
          createdAt: timestamp,
        });
      }
    });

    const query = {
      accountId,
      authorizationProjectId: aId,
      actorId: userId,
      sort: "priority_desc" as const,
      limit: 500,
    };
    const first = listMobileBugs(database, query, signingKey);
    assert.equal(first.items.length, 100);
    assert.ok(first.nextCursor);
    const second = listMobileBugs(database, { ...query, cursor: first.nextCursor! }, signingKey);
    assert.equal(second.items.length, 2);
    assert.equal(second.nextCursor, null);
    const all = [...first.items, ...second.items];
    assert.deepEqual(new Set(all.map((bug) => bug.id)), new Set(bugIds));
    assert.deepEqual(new Set(all.map((bug) => bug.projectId)), new Set([aId, bId]));
    assert.deepEqual(
      all.map((bug) => bug.priority),
      [...all.map((bug) => bug.priority)].sort(),
    );
    assert.equal(
      listMobileBugs(database, { ...query, projectId: aId }, signingKey).items.length,
      100,
    );

    const gmItems = transaction(database, () => {
      database
        .prepare(
          "INSERT INTO storage_command_authorizations(account_id, project_id, actor_id) VALUES (?, ?, ?)",
        )
        .run(accountId, aId, gmId);
      try {
        const firstPage = listMobileBugs(
          database,
          { accountId, authorizationProjectId: aId, actorId: gmId, limit: 500 },
          signingKey,
        );
        const secondPage = listMobileBugs(
          database,
          {
            accountId,
            authorizationProjectId: aId,
            actorId: gmId,
            limit: 500,
            cursor: firstPage.nextCursor!,
          },
          signingKey,
        );
        return [...firstPage.items, ...secondPage.items];
      } finally {
        database
          .prepare(
            "DELETE FROM storage_command_authorizations WHERE account_id = ? AND project_id = ? AND actor_id = ?",
          )
          .run(accountId, aId, gmId);
      }
    });
    assert.equal(gmItems.length, 102);
    assert.ok(gmItems.some((bug) => bug.projectId === bId));
  } finally {
    database.close();
  }
});

test("Bug creation accepts only an active module from the same account and project", () => {
  const { database, login } = fixture();
  try {
    login(aId);
    const activeModuleId = randomUUID();
    const inactiveModuleId = randomUUID();
    const otherProjectModuleId = randomUUID();
    database
      .prepare(
        `INSERT INTO modules(id, account_id, project_id, name, active, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(activeModuleId, accountId, aId, "Active module", 1, timestamp, timestamp);
    database
      .prepare(
        `INSERT INTO modules(id, account_id, project_id, name, active, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(inactiveModuleId, accountId, aId, "Inactive module", 0, timestamp, timestamp);
    database
      .prepare(
        `INSERT INTO modules(id, account_id, project_id, name, active, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(otherProjectModuleId, accountId, bId, "Other module", 1, timestamp, timestamp);
    const create = (moduleId: string, suffix: string) =>
      transaction(database, () =>
        createMobileBug(database, {
          accountId,
          projectId: aId,
          actorId: userId,
          clientSubmissionId: suffix,
          payloadDigest: suffix.replaceAll("-", "").padEnd(64, "a").slice(0, 64),
          title: "Categorized Bug",
          description: "Module scope is validated",
          expectedBehavior: "Only a current module is accepted",
          moduleId,
          severity: "S2",
          priority: "P2",
          ownerId: userId,
          verificationOwnerId: userId,
          occurrence: {
            observedAt: timestamp,
            platform: "web",
            steps: ["Create the Bug"],
            actualBehavior: "Module is selected",
          },
          attachmentIds: [],
          captureBundleId: null,
          createdAt: timestamp,
        }),
      );
    const created = create(activeModuleId, "77000000-0000-4000-8000-000000000101");
    assert.equal(created.bug.moduleId, activeModuleId);
    assert.throws(
      () => create(inactiveModuleId, "77000000-0000-4000-8000-000000000102"),
      /active project module/u,
    );
    assert.throws(
      () => create(otherProjectModuleId, "77000000-0000-4000-8000-000000000103"),
      /active project module/u,
    );
  } finally {
    database.close();
  }
});
