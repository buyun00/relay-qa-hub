import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SQLITE_MIGRATIONS } from "../src/sqlite-migrations.ts";
import { createMobileBug } from "../src/mobile-bug-store.ts";
import { listMobileBugs } from "../src/mobile-bug-list-store.ts";
import {
  disableManagedUser,
  linkManagedUser,
  listActiveUserIdentityLinks,
  listManagedUsers,
  unlinkManagedUser,
} from "../src/user-management-store.ts";

const ACCOUNT_ID = "70000000-0000-4000-8000-000000000001";
const PROJECT_ID = "70000000-0000-4000-8000-000000000002";
const ACTOR_ID = "70000000-0000-4000-8000-000000000003";
const DUPLICATE_ID = "70000000-0000-4000-8000-000000000004";
const CANONICAL_ID = "70000000-0000-4000-8000-000000000005";
const STAMP = "2026-08-24T00:00:00.000Z";
const ACTION_AT = "2026-09-03T08:00:00.000Z";

function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function fixture(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of SQLITE_MIGRATIONS) database.exec(migration.sql);
  database
    .prepare(
      `INSERT INTO accounts(id, slug, display_name, status, created_at, updated_at, version)
       VALUES (?, 'user-management', 'User Management', 'active', ?, ?, 1)`,
    )
    .run(ACCOUNT_ID, STAMP, STAMP);
  database
    .prepare(
      `INSERT INTO projects(
        id, account_id, project_key, name, status, created_at, updated_at, version
      ) VALUES (?, ?, 'USERS', 'Users', 'active', ?, ?, 1)`,
    )
    .run(PROJECT_ID, ACCOUNT_ID, STAMP, STAMP);
  const insertUser = database.prepare(
    `INSERT INTO users(
      id, account_id, email, display_name, status, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
  );
  insertUser.run(ACTOR_ID, ACCOUNT_ID, "actor@example.invalid", "管理员", STAMP, STAMP);
  insertUser.run(DUPLICATE_ID, ACCOUNT_ID, "duplicate@example.invalid", "AKKKKK", STAMP, STAMP);
  insertUser.run(CANONICAL_ID, ACCOUNT_ID, "canonical@example.invalid", "AKKKK", STAMP, STAMP);
  const insertMembership = database.prepare(
    `INSERT INTO memberships(
      id, account_id, project_id, user_id, status, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
  );
  for (const [index, userId] of [ACTOR_ID, DUPLICATE_ID, CANONICAL_ID].entries()) {
    const membershipId = `70000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`;
    insertMembership.run(membershipId, ACCOUNT_ID, PROJECT_ID, userId, STAMP, STAMP);
    database
      .prepare(
        `INSERT INTO membership_roles(
          account_id, project_id, membership_id, role, granted_at
        ) VALUES (?, ?, ?, 'developer', ?)`,
      )
      .run(ACCOUNT_ID, PROJECT_ID, membershipId, STAMP);
    if (userId === ACTOR_ID) {
      database
        .prepare(
          `INSERT INTO membership_roles(
            account_id, project_id, membership_id, role, granted_at
          ) VALUES (?, ?, ?, 'reporter', ?)`,
        )
        .run(ACCOUNT_ID, PROJECT_ID, membershipId, STAMP);
    }
  }
  return database;
}

const scope = { accountId: ACCOUNT_ID, projectId: PROJECT_ID, actorId: ACTOR_ID } as const;

test("explicit user links are reversible and retained as append-only history", () => {
  const database = fixture();
  try {
    transaction(database, () =>
      linkManagedUser(database, {
        ...scope,
        userId: DUPLICATE_ID,
        canonicalUserId: CANONICAL_ID,
        protectedUserIds: [],
        createdAt: ACTION_AT,
      }),
    );
    assert.deepEqual(listActiveUserIdentityLinks(database, ACCOUNT_ID), [
      {
        sourceUserId: DUPLICATE_ID,
        sourceDisplayName: "AKKKKK",
        canonicalUserId: CANONICAL_ID,
        canonicalDisplayName: "AKKKK",
      },
    ]);
    assert.equal(
      listManagedUsers(database, { ...scope, limit: 20 }).items.find(
        (user) => user.userId === DUPLICATE_ID,
      )?.linkedToUserId,
      CANONICAL_ID,
    );

    transaction(database, () =>
      unlinkManagedUser(database, {
        ...scope,
        userId: DUPLICATE_ID,
        protectedUserIds: [],
        createdAt: "2026-09-03T08:01:00.000Z",
      }),
    );
    assert.deepEqual(listActiveUserIdentityLinks(database, ACCOUNT_ID), []);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM user_identity_links").get()?.["count"],
      1,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM user_management_events").get()?.["count"],
      2,
    );
  } finally {
    database.close();
  }
});

test("disabling removes a duplicate from active membership without deleting its history", () => {
  const database = fixture();
  try {
    transaction(database, () =>
      disableManagedUser(database, {
        ...scope,
        userId: DUPLICATE_ID,
        protectedUserIds: [],
        createdAt: ACTION_AT,
      }),
    );
    const user = listManagedUsers(database, { ...scope, limit: 20 }).items.find(
      (item) => item.userId === DUPLICATE_ID,
    );
    assert.equal(user?.status, "disabled");
    assert.equal(user?.membershipStatus, "revoked");
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?").get(DUPLICATE_ID)?.[
        "count"
      ],
      1,
    );
    assert.throws(
      () =>
        transaction(database, () =>
          disableManagedUser(database, {
            ...scope,
            userId: CANONICAL_ID,
            protectedUserIds: [CANONICAL_ID],
            createdAt: "2026-09-03T08:02:00.000Z",
          }),
        ),
      /configured users/u,
    );
  } finally {
    database.close();
  }
});

test("canonical owner filters include tasks still assigned to a linked historical ID", () => {
  const database = fixture();
  try {
    const created = transaction(database, () =>
      createMobileBug(database, {
        ...scope,
        clientSubmissionId: "70000000-0000-4000-8002-000000000001",
        payloadDigest: "a".repeat(64),
        title: "Linked owner task",
        description: "Task assigned before identities were linked",
        expectedBehavior: "The canonical owner can still find it",
        severity: "S2",
        priority: "P2",
        ownerId: DUPLICATE_ID,
        verificationOwnerId: null,
        occurrence: {
          observedAt: "2026-08-25T00:00:00.000Z",
          platform: "windows",
          steps: ["Open QA Hub"],
          actualBehavior: "Duplicate owner is visible",
        },
        attachmentIds: [],
        captureBundleId: null,
        createdAt: "2026-08-25T00:00:00.000Z",
      }),
    );
    transaction(database, () =>
      linkManagedUser(database, {
        ...scope,
        userId: DUPLICATE_ID,
        canonicalUserId: CANONICAL_ID,
        protectedUserIds: [],
        createdAt: ACTION_AT,
      }),
    );

    const result = listMobileBugs(database, {
      ...scope,
      ownerId: CANONICAL_ID,
      limit: 20,
    });
    assert.deepEqual(
      result.items.map((bug) => bug.id),
      [created.bug.id],
    );
  } finally {
    database.close();
  }
});
