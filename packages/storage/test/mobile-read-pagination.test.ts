import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { listMobileProjectBuilds } from "../src/mobile-build-store.js";
import { createMobileBug, ensureMobileScope } from "../src/mobile-bug-store.js";
import {
  createMobileComment,
  listMobileBugComments,
  listMobileBugEvents,
} from "../src/mobile-comment-store.js";
import { syncAndListMobileNotifications } from "../src/mobile-inbox-store.js";
import {
  listMobileProjectMembers,
  listMobileVisibleProjects,
} from "../src/mobile-project-directory-store.js";
import { SQLITE_MIGRATIONS, SQLITE_SCHEMA_VERSION } from "../src/sqlite-migrations.js";
import {
  currentSqliteSchemaVersion,
  migrateSqliteDatabase,
  openSqliteDatabaseForWorker,
  verifySqliteIntegrity,
} from "../src/sqlite.js";
import { SqliteStorageWorker } from "../src/sqlite-worker.js";

const createdAt = "2026-09-09T00:00:00.000Z";
const key = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const accountId = "81000000-0000-4000-8000-000000000001";
const projectId = "81000000-0000-4000-8000-000000000002";
const actorId = "81000000-0000-4000-8000-000000000003";
const otherProjectId = "81000000-0000-4000-8000-000000000005";

function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function hasStorageCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code: unknown }).code === code;
}

function readVisibleProjectPage(database: DatabaseSync, cursor?: string, isGm = false) {
  return listMobileVisibleProjects(
    database,
    {
      accountId,
      actorId,
      ...(isGm ? { isGm: true as const } : { authorizationProjectId: projectId }),
      ...(cursor === undefined ? {} : { cursor }),
      limit: 1,
    },
    key,
  );
}

function assertFreshVisibleProjectCursorWorks(database: DatabaseSync, isGm = false): void {
  const first = readVisibleProjectPage(database, undefined, isGm);
  assert.ok(first.nextCursor);
  const second = readVisibleProjectPage(database, first.nextCursor, isGm);
  assert.equal(second.snapshotSequence, first.snapshotSequence);
  assert.deepEqual(
    [...first.items, ...second.items].map((project) => project.id),
    [projectId, otherProjectId],
  );
}

function databaseFixture(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const migration of SQLITE_MIGRATIONS) database.exec(migration.sql);
  transaction(database, () => {
    ensureMobileScope(database, {
      accountId,
      projectId,
      actorId,
      membershipId: "81000000-0000-4000-8000-000000000004",
      projectKey: "AAA",
      projectName: "Alpha",
      actorDisplayName: "Canonical actor",
      createdAt,
    });
    ensureMobileScope(database, {
      accountId,
      projectId: otherProjectId,
      actorId,
      membershipId: "81000000-0000-4000-8000-000000000006",
      projectKey: "BBB",
      projectName: "Beta",
      actorDisplayName: "Canonical actor",
      createdAt,
    });
  });
  for (const user of [
    {
      id: "81000000-0000-4000-8000-000000000007",
      membership: "81000000-0000-4000-8000-000000000008",
      email: "alias@local.invalid",
      name: "Alias actor",
      role: "developer",
    },
    {
      id: "81000000-0000-4000-8000-000000000010",
      membership: "81000000-0000-4000-8000-000000000011",
      email: "other@local.invalid",
      name: "Other member",
      role: "viewer",
    },
  ]) {
    database
      .prepare(
        `INSERT INTO users(id,account_id,email,display_name,status,created_at,updated_at,version)
         VALUES (?,?,?,?,'active',?,?,1)`,
      )
      .run(user.id, accountId, user.email, user.name, createdAt, createdAt);
    database
      .prepare(
        `INSERT INTO memberships(id,account_id,project_id,user_id,status,created_at,updated_at,version)
         VALUES (?,?,?,?,'active',?,?,1)`,
      )
      .run(user.membership, accountId, projectId, user.id, createdAt, createdAt);
    database
      .prepare(
        `INSERT INTO membership_roles(account_id,project_id,membership_id,role,granted_at)
         VALUES (?,?,?,?,?)`,
      )
      .run(accountId, projectId, user.membership, user.role, createdAt);
  }
  database
    .prepare(
      `INSERT INTO project_identity_links(
         id,account_id,project_id,source_user_id,canonical_user_id,status,
         created_by_user_id,created_at,revoked_by_user_id,revoked_at,version
       ) VALUES (?,?,?,?,?,'active',?,?,NULL,NULL,1)`,
    )
    .run(
      "81000000-0000-4000-8000-000000000009",
      accountId,
      projectId,
      "81000000-0000-4000-8000-000000000007",
      actorId,
      actorId,
      createdAt,
    );
  return database;
}

function insertBuild(database: DatabaseSync, ordinal: number): string {
  const buildId = `81000000-0000-4000-8000-00000000004${ordinal}`;
  const commitSha = `${ordinal + 3}`.repeat(40);
  database
    .prepare(
      `INSERT INTO builds(
         id,account_id,project_id,provider,external_id,version_name,channel,project_key,
         branch,source_commit_sha,mode,status,manifest_json,manifest_digest,
         artifact_sha256,download_url,created_at,updated_at,version
       ) VALUES (?,?,?,'manual',?,?,?,?,?,?,'debug','registered',?,?,NULL,NULL,?,?,1)`,
    )
    .run(
      buildId,
      accountId,
      projectId,
      `build-${ordinal}`,
      `1.0.${ordinal}`,
      "debug",
      "AAA",
      "main",
      commitSha,
      JSON.stringify({ commitShas: [commitSha] }),
      `${ordinal + 3}`.repeat(64),
      `2026-09-09T00:00:1${ordinal}.000Z`,
      `2026-09-09T00:00:1${ordinal}.000Z`,
    );
  return buildId;
}

test("project and member pages use signed endpoint-bound cursors after canonical member folding", () => {
  const database = databaseFixture();
  try {
    const projectPage = listMobileVisibleProjects(
      database,
      { accountId, actorId, authorizationProjectId: projectId, limit: 1 },
      key,
    );
    assert.equal(projectPage.items.length, 1);
    assert.ok(projectPage.nextCursor);
    const projectPage2 = listMobileVisibleProjects(
      database,
      {
        accountId,
        actorId,
        authorizationProjectId: projectId,
        cursor: projectPage.nextCursor!,
        limit: 1,
      },
      key,
    );
    assert.equal(projectPage2.snapshotSequence, projectPage.snapshotSequence);
    assert.deepEqual(
      [...projectPage.items, ...projectPage2.items].map((item) => item.id),
      [projectId, otherProjectId],
    );

    const members = listMobileProjectMembers(
      database,
      { accountId, actorId, authorizationProjectId: projectId, projectId, limit: 1 },
      key,
    );
    assert.equal(Object.hasOwn(members.items[0]!, "identity"), false);
    assert.equal(Object.hasOwn(members.items[0]!, "linkedUserIds"), false);
    const actor = members.items.find((item) => item.userId === actorId);
    assert.ok(actor);
    assert.ok(actor.roles.includes("developer"));
    assert.ok(members.nextCursor);
    assert.throws(
      () =>
        listMobileProjectMembers(
          database,
          {
            accountId,
            actorId,
            authorizationProjectId: projectId,
            projectId,
            cursor: projectPage.nextCursor!,
            limit: 1,
          },
          key,
        ),
      /cursor is invalid/u,
    );
  } finally {
    database.close();
  }
});

test("project listing derives its authorization anchor from the authenticated actor", () => {
  const database = databaseFixture();
  try {
    const first = listMobileVisibleProjects(database, { accountId, actorId, limit: 1 }, key);
    assert.ok(first.nextCursor);
    const second = listMobileVisibleProjects(
      database,
      { accountId, actorId, cursor: first.nextCursor!, limit: 1 },
      key,
    );
    assert.equal(second.snapshotSequence, first.snapshotSequence);
    assert.deepEqual(
      [...first.items, ...second.items].map((project) => project.id),
      [projectId, otherProjectId],
    );
    assert.throws(
      () =>
        listMobileVisibleProjects(
          database,
          {
            accountId,
            actorId: "81000000-0000-4000-8000-000000000099",
            limit: 1,
          },
          key,
        ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { readonly code: unknown }).code === "FORBIDDEN",
    );
  } finally {
    database.close();
  }
});

test("comments, Bug-local events, Builds and notifications retain first-page snapshots", () => {
  const database = databaseFixture();
  try {
    const bug = transaction(database, () =>
      createMobileBug(database, {
        accountId,
        projectId,
        actorId,
        clientSubmissionId: "81000000-0000-4000-8000-000000000020",
        payloadDigest: "1".repeat(64),
        title: "Pagination bug",
        description: "Read every page",
        expectedBehavior: "No duplicate or drift",
        severity: "S2",
        priority: "P2",
        ownerId: actorId,
        verificationOwnerId: actorId,
        occurrence: {
          observedAt: createdAt,
          platform: "android",
          steps: ["Open"],
          actualBehavior: "Broken",
        },
        attachmentIds: [],
        captureBundleId: null,
        createdAt,
      }),
    );
    for (const [index, body] of ["First", "Second"].entries()) {
      const created = transaction(database, () =>
        createMobileComment(database, {
          accountId,
          projectId,
          actorId: index === 0 ? "81000000-0000-4000-8000-000000000007" : actorId,
          bugId: bug.bug.id,
          clientSubmissionId: `81000000-0000-4000-8000-00000000002${index + 1}`,
          body,
          payloadDigest: `${index + 2}`.repeat(64),
          correlationId: `81000000-0000-4000-8000-00000000003${index + 1}`,
          idempotencyKey: `comment-${index}`,
          createdAt: `2026-09-09T00:00:0${index + 1}.000Z`,
        }),
      );
      assert.equal(created.comment.authorId, actorId);
    }
    for (const index of [0, 1]) insertBuild(database, index);

    const commentPage = listMobileBugComments(
      database,
      { accountId, projectId, actorId, bugId: bug.bug.id, limit: 1 },
      key,
    );
    assert.ok(commentPage.nextCursor);
    const commentPage2 = listMobileBugComments(
      database,
      {
        accountId,
        projectId,
        actorId,
        bugId: bug.bug.id,
        cursor: commentPage.nextCursor!,
        limit: 1,
      },
      key,
    );
    assert.equal(commentPage2.snapshotSequence, commentPage.snapshotSequence);
    assert.deepEqual(
      [...commentPage.items, ...commentPage2.items].map((item) => item.body),
      ["First", "Second"],
    );
    assert.deepEqual(Object.keys(commentPage.items[0]!).sort(), [
      "attachmentIds",
      "authorId",
      "body",
      "bugId",
      "createdAt",
      "id",
      "projectId",
      "version",
    ]);

    const eventPage = listMobileBugEvents(
      database,
      { accountId, projectId, actorId, bugId: bug.bug.id, afterSequence: 1, limit: 1 },
      key,
    );
    assert.equal(eventPage.items[0]?.sequence, 2);
    assert.equal(eventPage.items[0]?.actor.id, actorId);
    assert.ok(eventPage.nextCursor);
    const eventPage2 = listMobileBugEvents(
      database,
      {
        accountId,
        projectId,
        actorId,
        bugId: bug.bug.id,
        cursor: eventPage.nextCursor!,
        limit: 1,
      },
      key,
    );
    assert.equal(eventPage2.snapshotSequence, eventPage.snapshotSequence);
    assert.equal(eventPage2.items[0]?.sequence, 3);
    const eventPage2WithAnchor = listMobileBugEvents(
      database,
      {
        accountId,
        projectId,
        actorId,
        bugId: bug.bug.id,
        afterSequence: 1,
        cursor: eventPage.nextCursor!,
        limit: 1,
      },
      key,
    );
    assert.deepEqual(eventPage2WithAnchor.items, eventPage2.items);
    assert.throws(
      () =>
        listMobileBugEvents(
          database,
          {
            accountId,
            projectId,
            actorId,
            bugId: bug.bug.id,
            afterSequence: 2,
            cursor: eventPage.nextCursor!,
            limit: 1,
          },
          key,
        ),
      /afterSequence does not match the cursor anchor/u,
    );

    const buildPage = listMobileProjectBuilds(
      database,
      {
        accountId,
        projectId,
        actorId,
        authorizationProjectId: projectId,
        status: "registered",
        limit: 1,
      },
      key,
    );
    assert.ok(buildPage.nextCursor);
    assert.deepEqual(Object.keys(buildPage.items[0]!).sort(), [
      "branch",
      "channel",
      "externalId",
      "id",
      "manifest",
      "mode",
      "projectId",
      "projectKey",
      "provider",
      "sourceCommitSha",
      "status",
      "version",
      "versionName",
    ]);

    database
      .prepare(
        `INSERT INTO notifications(
           id,account_id,project_id,user_id,type,title,bug_id,source_event_id,
           payload_json,created_at,read_at,version
         ) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,1)`,
      )
      .run(
        "81000000-0000-4000-8000-000000000050",
        accountId,
        projectId,
        actorId,
        "bug.reminder",
        "Reminder",
        bug.bug.id,
        bug.eventId,
        "{}",
        "2026-09-09T00:00:30.000Z",
      );

    const notifications = transaction(database, () =>
      syncAndListMobileNotifications(
        database,
        { accountId, projectId, actorId, limit: 1, now: "2026-09-09T00:01:00.000Z" },
        key,
      ),
    );
    assert.ok(notifications.nextCursor);
    const notifications2 = transaction(database, () =>
      syncAndListMobileNotifications(
        database,
        {
          accountId,
          projectId,
          actorId,
          cursor: notifications.nextCursor!,
          limit: 1,
          now: "2026-09-09T00:01:01.000Z",
        },
        key,
      ),
    );
    assert.equal(notifications2.snapshotSequence, notifications.snapshotSequence);
    assert.notEqual(notifications2.items[0]?.id, notifications.items[0]?.id);
  } finally {
    database.close();
  }
});

test("comment identities do not fold through a link from another project", () => {
  const database = databaseFixture();
  const sourceId = "81000000-0000-4000-8000-000000000012";
  try {
    transaction(database, () =>
      ensureMobileScope(database, {
        accountId,
        projectId: otherProjectId,
        actorId: sourceId,
        membershipId: "81000000-0000-4000-8000-000000000013",
        projectKey: "BBB",
        projectName: "Beta",
        actorDisplayName: "Other-project source",
        createdAt,
      }),
    );
    transaction(database, () =>
      ensureMobileScope(database, {
        accountId,
        projectId,
        actorId: sourceId,
        membershipId: "81000000-0000-4000-8000-000000000018",
        projectKey: "AAA",
        projectName: "Alpha",
        actorDisplayName: "Other-project source",
        createdAt,
      }),
    );
    database
      .prepare(
        `INSERT INTO project_identity_links(
           id,account_id,project_id,source_user_id,canonical_user_id,status,
           created_by_user_id,created_at,revoked_by_user_id,revoked_at,version
         ) VALUES (?,?,?,?,?,'active',?,?,NULL,NULL,1)`,
      )
      .run(
        "81000000-0000-4000-8000-000000000014",
        accountId,
        projectId,
        sourceId,
        actorId,
        actorId,
        createdAt,
      );
    const bug = transaction(database, () =>
      createMobileBug(database, {
        accountId,
        projectId: otherProjectId,
        actorId,
        clientSubmissionId: "81000000-0000-4000-8000-000000000015",
        payloadDigest: "7".repeat(64),
        title: "Cross-project identity",
        description: "Do not apply a link from another project",
        expectedBehavior: "Historical author remains scoped",
        severity: "S2",
        priority: "P2",
        ownerId: actorId,
        verificationOwnerId: actorId,
        occurrence: {
          observedAt: createdAt,
          platform: "android",
          steps: ["Read comment"],
          actualBehavior: "Author is scoped",
        },
        attachmentIds: [],
        captureBundleId: null,
        createdAt,
      }),
    );
    const created = transaction(database, () =>
      createMobileComment(database, {
        accountId,
        projectId: otherProjectId,
        actorId: sourceId,
        bugId: bug.bug.id,
        clientSubmissionId: "81000000-0000-4000-8000-000000000016",
        body: "Project-scoped author",
        payloadDigest: "8".repeat(64),
        correlationId: "81000000-0000-4000-8000-000000000017",
        idempotencyKey: "cross-project-comment",
        createdAt: "2026-09-09T00:00:10.000Z",
      }),
    );
    assert.equal(created.comment.authorId, sourceId);
    const comments = listMobileBugComments(
      database,
      { accountId, projectId: otherProjectId, actorId, bugId: bug.bug.id, limit: 10 },
      key,
    );
    assert.equal(comments.items[0]?.authorId, sourceId);
    const events = listMobileBugEvents(
      database,
      {
        accountId,
        projectId: otherProjectId,
        actorId,
        bugId: bug.bug.id,
        afterSequence: 1,
        limit: 10,
      },
      key,
    );
    assert.equal(events.items[0]?.actor.id, sourceId);
  } finally {
    database.close();
  }
});

test("comment and event cursors bind the target project's identity projection", () => {
  const database = databaseFixture();
  const aliasId = "81000000-0000-4000-8000-000000000007";
  try {
    const bug = transaction(database, () =>
      createMobileBug(database, {
        accountId,
        projectId,
        actorId,
        clientSubmissionId: "81000000-0000-4000-8000-000000000071",
        payloadDigest: "9".repeat(64),
        title: "Identity cursor binding",
        description: "A continuation cannot mix identity projections",
        expectedBehavior: "Link changes invalidate only the matching project cursor",
        severity: "S2",
        priority: "P2",
        ownerId: actorId,
        verificationOwnerId: actorId,
        occurrence: {
          observedAt: createdAt,
          platform: "android",
          steps: ["Read two pages"],
          actualBehavior: "Identity link changes between pages",
        },
        attachmentIds: [],
        captureBundleId: null,
        createdAt,
      }),
    );
    for (const index of [0, 1]) {
      transaction(database, () =>
        createMobileComment(database, {
          accountId,
          projectId,
          actorId: aliasId,
          bugId: bug.bug.id,
          clientSubmissionId: `81000000-0000-4000-8000-00000000007${index + 2}`,
          body: `Identity page ${index + 1}`,
          payloadDigest: `${index + 1}`.repeat(64),
          correlationId: `81000000-0000-4000-8000-00000000007${index + 4}`,
          idempotencyKey: `identity-page-${index}`,
          createdAt: `2026-09-09T00:00:2${index}.000Z`,
        }),
      );
    }
    const firstComment = listMobileBugComments(
      database,
      { accountId, projectId, actorId, bugId: bug.bug.id, limit: 1 },
      key,
    );
    const firstEvent = listMobileBugEvents(
      database,
      { accountId, projectId, actorId, bugId: bug.bug.id, afterSequence: 1, limit: 1 },
      key,
    );
    assert.ok(firstComment.nextCursor);
    assert.ok(firstEvent.nextCursor);
    database
      .prepare(
        `UPDATE project_identity_links
         SET status = 'revoked', revoked_by_user_id = ?, revoked_at = ?, version = version + 1
         WHERE account_id = ? AND project_id = ? AND source_user_id = ? AND status = 'active'`,
      )
      .run(actorId, "2026-09-09T00:00:30.000Z", accountId, projectId, aliasId);
    assert.throws(
      () =>
        listMobileBugComments(
          database,
          {
            accountId,
            projectId,
            actorId,
            bugId: bug.bug.id,
            cursor: firstComment.nextCursor!,
            limit: 1,
          },
          key,
        ),
      /cursor is invalid/u,
    );
    assert.throws(
      () =>
        listMobileBugEvents(
          database,
          {
            accountId,
            projectId,
            actorId,
            bugId: bug.bug.id,
            cursor: firstEvent.nextCursor!,
            limit: 1,
          },
          key,
        ),
      /cursor is invalid/u,
    );

    const stableComment = listMobileBugComments(
      database,
      { accountId, projectId, actorId, bugId: bug.bug.id, limit: 1 },
      key,
    );
    const stableEvent = listMobileBugEvents(
      database,
      { accountId, projectId, actorId, bugId: bug.bug.id, afterSequence: 1, limit: 1 },
      key,
    );
    transaction(database, () =>
      ensureMobileScope(database, {
        accountId,
        projectId: otherProjectId,
        actorId: aliasId,
        membershipId: "81000000-0000-4000-8000-000000000078",
        projectKey: "BBB",
        projectName: "Beta",
        actorEmail: "alias@local.invalid",
        actorDisplayName: "Alias actor",
        createdAt,
      }),
    );
    database
      .prepare(
        `INSERT INTO project_identity_links(
           id,account_id,project_id,source_user_id,canonical_user_id,status,
           created_by_user_id,created_at,revoked_by_user_id,revoked_at,version
         ) VALUES (?,?,?,?,?,'active',?,?,NULL,NULL,1)`,
      )
      .run(
        "81000000-0000-4000-8000-000000000079",
        accountId,
        otherProjectId,
        aliasId,
        actorId,
        actorId,
        "2026-09-09T00:00:31.000Z",
      );
    const secondComment = listMobileBugComments(
      database,
      {
        accountId,
        projectId,
        actorId,
        bugId: bug.bug.id,
        cursor: stableComment.nextCursor!,
        limit: 1,
      },
      key,
    );
    const secondEvent = listMobileBugEvents(
      database,
      {
        accountId,
        projectId,
        actorId,
        bugId: bug.bug.id,
        cursor: stableEvent.nextCursor!,
        limit: 1,
      },
      key,
    );
    assert.equal(secondComment.items[0]?.authorId, aliasId);
    assert.equal(secondEvent.items[0]?.actor.id, aliasId);

    database
      .prepare(
        `INSERT INTO project_identity_links(
           id,account_id,project_id,source_user_id,canonical_user_id,status,
           created_by_user_id,created_at,revoked_by_user_id,revoked_at,version
         ) VALUES (?,?,?,?,?,'active',?,?,NULL,NULL,1)`,
      )
      .run(
        "81000000-0000-4000-8000-000000000080",
        accountId,
        projectId,
        aliasId,
        actorId,
        actorId,
        "2026-09-09T00:00:32.000Z",
      );
    assert.throws(
      () =>
        listMobileBugComments(
          database,
          {
            accountId,
            projectId,
            actorId,
            bugId: bug.bug.id,
            cursor: stableComment.nextCursor!,
            limit: 1,
          },
          key,
        ),
      /cursor is invalid/u,
    );
    assert.throws(
      () =>
        listMobileBugEvents(
          database,
          {
            accountId,
            projectId,
            actorId,
            bugId: bug.bug.id,
            cursor: stableEvent.nextCursor!,
            limit: 1,
          },
          key,
        ),
      /cursor is invalid/u,
    );

    const beforeRepointComment = listMobileBugComments(
      database,
      { accountId, projectId, actorId, bugId: bug.bug.id, limit: 1 },
      key,
    );
    const beforeRepointEvent = listMobileBugEvents(
      database,
      { accountId, projectId, actorId, bugId: bug.bug.id, afterSequence: 1, limit: 1 },
      key,
    );
    assert.equal(beforeRepointComment.items[0]?.authorId, actorId);
    assert.equal(beforeRepointEvent.items[0]?.actor.id, actorId);
    database
      .prepare(
        `UPDATE project_identity_links
         SET status = 'revoked', revoked_by_user_id = ?, revoked_at = ?, version = version + 1
         WHERE id = ? AND account_id = ? AND status = 'active' AND version = 1`,
      )
      .run(actorId, "2026-09-09T00:00:33.000Z", "81000000-0000-4000-8000-000000000080", accountId);
    database
      .prepare(
        `INSERT INTO project_identity_links(
           id,account_id,project_id,source_user_id,canonical_user_id,status,
           created_by_user_id,created_at,revoked_by_user_id,revoked_at,version
         ) VALUES (?,?,?,?,?,'active',?,?,NULL,NULL,1)`,
      )
      .run(
        "81000000-0000-4000-8000-000000000081",
        accountId,
        projectId,
        aliasId,
        "81000000-0000-4000-8000-000000000010",
        actorId,
        "2026-09-09T00:00:34.000Z",
      );
    assert.throws(
      () =>
        listMobileBugComments(
          database,
          {
            accountId,
            projectId,
            actorId,
            bugId: bug.bug.id,
            cursor: beforeRepointComment.nextCursor!,
            limit: 1,
          },
          key,
        ),
      /cursor is invalid/u,
    );
    assert.throws(
      () =>
        listMobileBugEvents(
          database,
          {
            accountId,
            projectId,
            actorId,
            bugId: bug.bug.id,
            cursor: beforeRepointEvent.nextCursor!,
            limit: 1,
          },
          key,
        ),
      /cursor is invalid/u,
    );
  } finally {
    database.close();
  }
});

test("project version changes invalidate old project cursors and fresh pages see current DTOs", () => {
  const projectDatabase = databaseFixture();
  try {
    const first = listMobileVisibleProjects(
      projectDatabase,
      { accountId, actorId, authorizationProjectId: projectId, limit: 1 },
      key,
    );
    assert.ok(first.nextCursor);
    projectDatabase
      .prepare("UPDATE projects SET name = ?, updated_at = ?, version = version + 1 WHERE id = ?")
      .run("Renamed after page one", "2026-09-09T00:02:00.000Z", otherProjectId);
    assert.throws(
      () =>
        listMobileVisibleProjects(
          projectDatabase,
          {
            accountId,
            actorId,
            authorizationProjectId: projectId,
            cursor: first.nextCursor!,
            limit: 1,
          },
          key,
        ),
      hasStorageCode("INVALID_REQUEST"),
    );
    const fresh = listMobileVisibleProjects(
      projectDatabase,
      { accountId, actorId, authorizationProjectId: projectId, limit: 2 },
      key,
    );
    assert.equal(
      fresh.items.find((project) => project.id === otherProjectId)?.name,
      "Renamed after page one",
    );
  } finally {
    projectDatabase.close();
  }
});

test("member continuation keeps first-page DTOs across a display-name mutation", () => {
  const memberDatabase = databaseFixture();
  try {
    const first = listMobileProjectMembers(
      memberDatabase,
      { accountId, actorId, authorizationProjectId: projectId, projectId, limit: 1 },
      key,
    );
    assert.ok(first.nextCursor);
    memberDatabase
      .prepare(
        "UPDATE users SET display_name = ?, updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .run(
        "Aardvark after page one",
        "2026-09-09T00:02:00.000Z",
        "81000000-0000-4000-8000-000000000010",
      );
    memberDatabase
      .prepare(
        "UPDATE memberships SET status = 'revoked', updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .run("2026-09-09T00:02:00.000Z", "81000000-0000-4000-8000-000000000011");
    const second = listMobileProjectMembers(
      memberDatabase,
      {
        accountId,
        actorId,
        authorizationProjectId: projectId,
        projectId,
        cursor: first.nextCursor!,
        limit: 1,
      },
      key,
    );
    assert.equal(second.snapshotSequence, first.snapshotSequence);
    assert.equal(second.items[0]?.userId, "81000000-0000-4000-8000-000000000010");
    assert.equal(second.items[0]?.displayName, "Other member");
  } finally {
    memberDatabase.close();
  }
});

test("single-page polling does not retain snapshots or exhaust the active quota", () => {
  const database = databaseFixture();
  try {
    for (let index = 0; index < 45; index += 1) {
      const projects = listMobileVisibleProjects(
        database,
        { accountId, actorId, authorizationProjectId: projectId, limit: 100 },
        key,
      );
      assert.equal(projects.nextCursor, null);
      const notifications = transaction(database, () =>
        syncAndListMobileNotifications(
          database,
          {
            accountId,
            projectId,
            actorId,
            limit: 100,
            now: `2026-09-09T00:03:${String(index).padStart(2, "0")}.000Z`,
          },
          key,
        ),
      );
      assert.equal(notifications.nextCursor, null);
    }
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM mobile_read_snapshots").get()!.count,
      0,
    );
  } finally {
    database.close();
  }
});

test("snapshot cleanup removes only expired rows and preserves live immutable snapshots", () => {
  const database = databaseFixture();
  try {
    const nowMs = database
      .prepare("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms")
      .get()!.now_ms as number;
    const insertSnapshot = database.prepare(
      `INSERT INTO mobile_read_snapshots(
         id,kind,account_id,actor_id,project_id,authorization_digest,filter_digest,
         metadata_json,item_count,byte_count,created_at,expires_at
       ) VALUES (?,'visible-projects',?,?,?,?,?,'{}',0,2,?,?)`,
    );
    const expiredId = "81000000-0000-4000-8000-000000000080";
    const liveId = "81000000-0000-4000-8000-000000000081";
    insertSnapshot.run(
      expiredId,
      accountId,
      actorId,
      projectId,
      "a".repeat(43),
      "b".repeat(43),
      nowMs - 2_000,
      nowMs - 1_000,
    );
    insertSnapshot.run(
      liveId,
      accountId,
      actorId,
      projectId,
      "c".repeat(43),
      "d".repeat(43),
      nowMs,
      nowMs + 60_000,
    );

    const page = listMobileVisibleProjects(
      database,
      { accountId, actorId, authorizationProjectId: projectId, limit: 100 },
      key,
    );
    assert.equal(page.nextCursor, null);
    assert.deepEqual(
      database
        .prepare("SELECT id FROM mobile_read_snapshots ORDER BY id")
        .all()
        .map((row) => row.id),
      [liveId],
    );
    assert.throws(
      () => database.prepare("DELETE FROM mobile_read_snapshots WHERE id = ?").run(liveId),
      /active mobile read snapshots cannot be deleted/u,
    );
  } finally {
    database.close();
  }
});

test("active snapshot count is bounded per actor", () => {
  const database = databaseFixture();
  try {
    for (let index = 0; index < 32; index += 1) {
      const page = listMobileVisibleProjects(
        database,
        { accountId, actorId, authorizationProjectId: projectId, limit: 1 },
        key,
      );
      assert.ok(page.nextCursor, `snapshot ${index + 1} must have a continuation`);
    }
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM mobile_read_snapshots").get()!.count,
      32,
    );
    assert.throws(
      () =>
        listMobileVisibleProjects(
          database,
          { accountId, actorId, authorizationProjectId: projectId, limit: 1 },
          key,
        ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { readonly code: unknown }).code === "RATE_LIMITED",
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM mobile_read_snapshots").get()!.count,
      32,
    );
  } finally {
    database.close();
  }
});

test("a signed project continuation survives a SQLite worker process restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qa-mobile-read-restart-"));
  const databaseFile = join(directory, "qa-hub.sqlite");
  const options = {
    databaseFile,
    backupRoot: join(directory, "backups"),
    busyTimeoutMs: 5_000,
    mobileBugCursorSigningKey: key,
  };
  let worker = new SqliteStorageWorker(options);
  try {
    assert.equal((await worker.initialization).migration.toVersion, SQLITE_SCHEMA_VERSION);
    await worker.ensureMobileScope({
      accountId,
      projectId,
      actorId,
      membershipId: "81000000-0000-4000-8000-000000000004",
      projectKey: "AAA",
      projectName: "Alpha",
      actorDisplayName: "Restart actor",
      createdAt,
    });
    await worker.ensureMobileScope({
      accountId,
      projectId: otherProjectId,
      actorId,
      membershipId: "81000000-0000-4000-8000-000000000006",
      projectKey: "BBB",
      projectName: "Beta",
      actorDisplayName: "Restart actor",
      createdAt,
    });
    const first = await worker.listMobileVisibleProjects({
      accountId,
      actorId,
      authorizationProjectId: projectId,
      limit: 1,
    });
    assert.ok(first.nextCursor);
    await worker.close();
    worker = new SqliteStorageWorker(options);
    await worker.initialization;
    const second = await worker.listMobileVisibleProjects({
      accountId,
      actorId,
      authorizationProjectId: projectId,
      cursor: first.nextCursor!,
      limit: 1,
    });
    assert.equal(second.snapshotSequence, first.snapshotSequence);
    assert.deepEqual(
      [...first.items, ...second.items].map((project) => project.id),
      [projectId, otherProjectId],
    );
  } finally {
    await worker.close().catch(() => undefined);
    rmSync(directory, { force: true, recursive: true });
  }
});

test("continuation rechecks current actor membership before reading a frozen snapshot", () => {
  const database = databaseFixture();
  try {
    const first = listMobileVisibleProjects(
      database,
      { accountId, actorId, authorizationProjectId: projectId, limit: 1 },
      key,
    );
    assert.ok(first.nextCursor);
    database
      .prepare(
        "UPDATE memberships SET status = 'revoked', updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .run("2026-09-09T00:04:00.000Z", "81000000-0000-4000-8000-000000000004");
    assert.throws(
      () =>
        listMobileVisibleProjects(
          database,
          {
            accountId,
            actorId,
            authorizationProjectId: projectId,
            cursor: first.nextCursor!,
            limit: 1,
          },
          key,
        ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { readonly code: unknown }).code === "FORBIDDEN",
    );
  } finally {
    database.close();
  }
});

test("project archive and restore permanently invalidates pre-archive project cursors", () => {
  const database = databaseFixture();
  try {
    const first = readVisibleProjectPage(database);
    assert.ok(first.nextCursor);
    database
      .prepare(
        "UPDATE projects SET status = 'archived', updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .run("2026-09-09T00:05:00.000Z", projectId);
    assert.throws(
      () => readVisibleProjectPage(database, first.nextCursor!),
      hasStorageCode("FORBIDDEN"),
    );

    database
      .prepare(
        "UPDATE projects SET status = 'active', updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .run("2026-09-09T00:06:00.000Z", projectId);
    assert.throws(
      () => readVisibleProjectPage(database, first.nextCursor!),
      hasStorageCode("INVALID_REQUEST"),
    );
    assertFreshVisibleProjectCursorWorks(database);
  } finally {
    database.close();
  }
});

test("membership revoke and restore permanently invalidates pre-revocation cursors", () => {
  const database = databaseFixture();
  const membershipId = "81000000-0000-4000-8000-000000000004";
  try {
    const first = readVisibleProjectPage(database);
    assert.ok(first.nextCursor);
    database
      .prepare(
        "UPDATE memberships SET status = 'revoked', updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .run("2026-09-09T00:05:00.000Z", membershipId);
    assert.throws(
      () => readVisibleProjectPage(database, first.nextCursor!),
      hasStorageCode("FORBIDDEN"),
    );

    database
      .prepare(
        "UPDATE memberships SET status = 'active', updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .run("2026-09-09T00:06:00.000Z", membershipId);
    assert.throws(
      () => readVisibleProjectPage(database, first.nextCursor!),
      hasStorageCode("INVALID_REQUEST"),
    );
    assertFreshVisibleProjectCursorWorks(database);
  } finally {
    database.close();
  }
});

test("user disable and administrative restore permanently invalidates pre-disable cursors", () => {
  const database = databaseFixture();
  try {
    const first = readVisibleProjectPage(database);
    assert.ok(first.nextCursor);
    database
      .prepare(
        "UPDATE users SET status = 'disabled', updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .run("2026-09-09T00:05:00.000Z", actorId);
    assert.throws(
      () => readVisibleProjectPage(database, first.nextCursor!),
      hasStorageCode("FORBIDDEN"),
    );

    // User disable is one-way in the online lifecycle. Simulate an explicit offline
    // administrative recovery to verify that its version epoch still seals old cursors.
    database.exec("DROP TRIGGER users_transition_guard");
    database
      .prepare(
        "UPDATE users SET status = 'active', updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .run("2026-09-09T00:06:00.000Z", actorId);
    assert.throws(
      () => readVisibleProjectPage(database, first.nextCursor!),
      hasStorageCode("INVALID_REQUEST"),
    );
    assertFreshVisibleProjectCursorWorks(database);
  } finally {
    database.close();
  }
});

test("account disable and administrative restore permanently invalidates pre-disable cursors", () => {
  const database = databaseFixture();
  try {
    const first = readVisibleProjectPage(database);
    assert.ok(first.nextCursor);
    database
      .prepare(
        "UPDATE accounts SET status = 'disabled', updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .run("2026-09-09T00:05:00.000Z", accountId);
    assert.throws(
      () => readVisibleProjectPage(database, first.nextCursor!),
      hasStorageCode("FORBIDDEN"),
    );

    // Account disable is one-way in the online lifecycle. Simulate an explicit offline
    // administrative recovery to verify that its version epoch still seals old cursors.
    database.exec("DROP TRIGGER accounts_transition_guard");
    database
      .prepare(
        "UPDATE accounts SET status = 'active', updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .run("2026-09-09T00:06:00.000Z", accountId);
    assert.throws(
      () => readVisibleProjectPage(database, first.nextCursor!),
      hasStorageCode("INVALID_REQUEST"),
    );
    assertFreshVisibleProjectCursorWorks(database);
  } finally {
    database.close();
  }
});

test("GM project directory binds project versions across archive and restore", () => {
  const database = databaseFixture();
  try {
    const first = readVisibleProjectPage(database, undefined, true);
    assert.ok(first.nextCursor);
    database
      .prepare(
        "UPDATE projects SET status = 'archived', updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .run("2026-09-09T00:05:00.000Z", otherProjectId);
    assert.throws(
      () => readVisibleProjectPage(database, first.nextCursor!, true),
      hasStorageCode("INVALID_REQUEST"),
    );

    database
      .prepare(
        "UPDATE projects SET status = 'active', updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .run("2026-09-09T00:06:00.000Z", otherProjectId);
    assert.throws(
      () => readVisibleProjectPage(database, first.nextCursor!, true),
      hasStorageCode("INVALID_REQUEST"),
    );
    assertFreshVisibleProjectCursorWorks(database, true);
  } finally {
    database.close();
  }
});

test("schema 19 to 20 rolls back a partial collision, upgrades with backup, and reopens", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qa-mobile-read-migration-"));
  const databaseFile = join(directory, "qa-hub.sqlite");
  let database = openSqliteDatabaseForWorker({ databaseFile, busyTimeoutMs: 5_000 });
  try {
    const schema19 = await migrateSqliteDatabase(database, databaseFile, {
      targetVersion: 19,
      backupRoot: join(directory, "schema19-backups"),
    });
    assert.equal(schema19.toVersion, 19);
    database.exec("CREATE TABLE mobile_read_snapshot_items(dummy INTEGER) STRICT");
    await assert.rejects(
      migrateSqliteDatabase(database, databaseFile, {
        backupRoot: join(directory, "failed-upgrade-backups"),
      }),
      /already exists/u,
    );
    assert.equal(currentSqliteSchemaVersion(database), 19);
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'mobile_read_snapshots'",
        )
        .get()!.count,
      0,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 20").get()!
        .count,
      0,
    );
    database.exec("DROP TABLE mobile_read_snapshot_items");

    const upgraded = await migrateSqliteDatabase(database, databaseFile, {
      backupRoot: join(directory, "successful-upgrade-backups"),
    });
    assert.deepEqual(upgraded.appliedVersions, [20]);
    assert.equal(upgraded.fromVersion, 19);
    assert.equal(upgraded.toVersion, SQLITE_SCHEMA_VERSION);
    assert.ok(upgraded.backupPath && existsSync(upgraded.backupPath));
    assert.equal(verifySqliteIntegrity(database).ok, true);
    database.close();

    database = openSqliteDatabaseForWorker({ databaseFile, busyTimeoutMs: 5_000 });
    const reopened = await migrateSqliteDatabase(database, databaseFile, {
      backupRoot: join(directory, "reopen-backups"),
    });
    assert.deepEqual(reopened, {
      fromVersion: SQLITE_SCHEMA_VERSION,
      toVersion: SQLITE_SCHEMA_VERSION,
      appliedVersions: [],
      backupPath: null,
    });
    assert.equal(verifySqliteIntegrity(database).ok, true);
  } finally {
    try {
      database.close();
    } catch {
      // The success path closes once before reopening the same file.
    }
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Build continuation keeps first-page rows across insert and status update", () => {
  const database = databaseFixture();
  try {
    insertBuild(database, 0);
    const originalSecondId = insertBuild(database, 1);
    const first = listMobileProjectBuilds(
      database,
      {
        accountId,
        projectId,
        actorId,
        authorizationProjectId: projectId,
        status: "registered",
        limit: 1,
      },
      key,
    );
    assert.ok(first.nextCursor);
    insertBuild(database, 2);
    database
      .prepare(
        "UPDATE builds SET status = 'queued', updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .run("2026-09-09T00:02:00.000Z", originalSecondId);
    const second = listMobileProjectBuilds(
      database,
      {
        accountId,
        projectId,
        actorId,
        authorizationProjectId: projectId,
        status: "registered",
        cursor: first.nextCursor!,
        limit: 1,
      },
      key,
    );
    assert.equal(second.snapshotSequence, first.snapshotSequence);
    assert.equal(second.items[0]?.id, originalSecondId);
    assert.equal(second.items[0]?.status, "registered");
  } finally {
    database.close();
  }
});

test("notification continuation keeps unread rows frozen across read mutation", () => {
  const database = databaseFixture();
  try {
    const bug = transaction(database, () =>
      createMobileBug(database, {
        accountId,
        projectId,
        actorId,
        clientSubmissionId: "81000000-0000-4000-8000-000000000060",
        payloadDigest: "6".repeat(64),
        title: "Notification snapshot",
        description: "Keep unread page stable",
        expectedBehavior: "Continuation is frozen",
        severity: "S2",
        priority: "P2",
        ownerId: actorId,
        verificationOwnerId: actorId,
        occurrence: {
          observedAt: createdAt,
          platform: "android",
          steps: ["Open"],
          actualBehavior: "Broken",
        },
        attachmentIds: [],
        captureBundleId: null,
        createdAt,
      }),
    );
    database
      .prepare(
        `INSERT INTO notifications(
           id,account_id,project_id,user_id,type,title,bug_id,source_event_id,
           payload_json,created_at,read_at,version
         ) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,1)`,
      )
      .run(
        "81000000-0000-4000-8000-000000000061",
        accountId,
        projectId,
        actorId,
        "bug.reminder",
        "Reminder",
        bug.bug.id,
        bug.eventId,
        "{}",
        "2026-09-09T00:00:30.000Z",
      );
    const first = transaction(database, () =>
      syncAndListMobileNotifications(
        database,
        {
          accountId,
          projectId,
          actorId,
          unreadOnly: true,
          limit: 1,
          now: "2026-09-09T00:01:00.000Z",
        },
        key,
      ),
    );
    assert.ok(first.nextCursor);
    const frozenSecondId = database
      .prepare(
        "SELECT id FROM notifications WHERE account_id = ? AND user_id = ? AND id <> ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(accountId, actorId, first.items[0]!.id)!.id as string;
    database
      .prepare("UPDATE notifications SET read_at = ?, version = version + 1 WHERE id = ?")
      .run("2026-09-09T00:01:01.000Z", frozenSecondId);
    const second = transaction(database, () =>
      syncAndListMobileNotifications(
        database,
        {
          accountId,
          projectId,
          actorId,
          unreadOnly: true,
          cursor: first.nextCursor!,
          limit: 1,
          now: "2026-09-09T00:01:02.000Z",
        },
        key,
      ),
    );
    assert.equal(second.snapshotSequence, first.snapshotSequence);
    assert.equal(second.items[0]?.id, frozenSecondId);
    assert.equal(second.items[0]?.readAt, null);
    assert.equal(second.unreadCount, first.unreadCount);
  } finally {
    database.close();
  }
});
