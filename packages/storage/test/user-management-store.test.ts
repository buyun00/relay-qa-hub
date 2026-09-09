import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createBrowserSession, resolveBrowserSession } from "../src/browser-auth-store.ts";
import { SQLITE_MIGRATIONS } from "../src/sqlite-migrations.ts";
import { createMobileBug, getMobileBug } from "../src/mobile-bug-store.ts";
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
const SECOND_DUPLICATE_ID = "70000000-0000-4000-8000-000000000006";
const STAMP = "2026-08-24T00:00:00.000Z";
const ACTION_AT = "2026-09-03T08:00:00.000Z";
const CURSOR_SIGNING_KEY = new Uint8Array(32).fill(7);

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
  insertUser.run(
    SECOND_DUPLICATE_ID,
    ACCOUNT_ID,
    "second-duplicate@example.invalid",
    "AKKKKK2",
    STAMP,
    STAMP,
  );
  const insertMembership = database.prepare(
    `INSERT INTO memberships(
      id, account_id, project_id, user_id, status, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
  );
  for (const [index, userId] of [
    ACTOR_ID,
    DUPLICATE_ID,
    CANONICAL_ID,
    SECOND_DUPLICATE_ID,
  ].entries()) {
    const membershipId = `70000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`;
    insertMembership.run(membershipId, ACCOUNT_ID, PROJECT_ID, userId, STAMP, STAMP);
    database
      .prepare(
        `INSERT INTO membership_roles(
          account_id, project_id, membership_id, role, granted_at
        ) VALUES (?, ?, ?, 'developer', ?)`,
      )
      .run(ACCOUNT_ID, PROJECT_ID, membershipId, STAMP);
    if (userId === DUPLICATE_ID || userId === CANONICAL_ID || userId === SECOND_DUPLICATE_ID) {
      database
        .prepare(
          `INSERT INTO membership_roles(
            account_id, project_id, membership_id, role, granted_at
          ) VALUES (?, ?, ?, 'verifier', ?)`,
        )
        .run(ACCOUNT_ID, PROJECT_ID, membershipId, STAMP);
    }
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
    assert.deepEqual(listActiveUserIdentityLinks(database, ACCOUNT_ID, PROJECT_ID), [
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
    assert.throws(
      () =>
        transaction(database, () =>
          linkManagedUser(database, {
            ...scope,
            userId: SECOND_DUPLICATE_ID,
            canonicalUserId: DUPLICATE_ID,
            protectedUserIds: [],
            createdAt: "2026-09-03T08:00:30.000Z",
          }),
        ),
      /identity links must point directly to one canonical user/u,
    );

    transaction(database, () =>
      unlinkManagedUser(database, {
        ...scope,
        userId: DUPLICATE_ID,
        protectedUserIds: [],
        createdAt: "2026-09-03T08:01:00.000Z",
      }),
    );
    assert.deepEqual(listActiveUserIdentityLinks(database, ACCOUNT_ID, PROJECT_ID), []);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM project_identity_links").get()?.["count"],
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
    const tokenDigest = "b".repeat(64);
    transaction(database, () =>
      createBrowserSession(database, {
        accountId: ACCOUNT_ID,
        userId: DUPLICATE_ID,
        projectId: PROJECT_ID,
        sessionId: "70000000-0000-4000-8002-000000000099",
        tokenDigest,
        issuedAt: "2026-09-03T07:59:00.000Z",
        expiresAt: "2026-09-04T07:59:00.000Z",
      }),
    );
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
        verificationOwnerId: DUPLICATE_ID,
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
    const secondCreated = transaction(database, () =>
      createMobileBug(database, {
        ...scope,
        clientSubmissionId: "70000000-0000-4000-8002-000000000002",
        payloadDigest: "c".repeat(64),
        title: "Second linked owner task",
        description: "Task assigned to another alias before identities were linked",
        expectedBehavior: "Every active alias projects to the same canonical owner",
        severity: "S2",
        priority: "P2",
        ownerId: SECOND_DUPLICATE_ID,
        verificationOwnerId: SECOND_DUPLICATE_ID,
        occurrence: {
          observedAt: "2026-08-26T00:00:00.000Z",
          platform: "windows",
          steps: ["Open QA Hub"],
          actualBehavior: "Second duplicate owner is visible",
        },
        attachmentIds: [],
        captureBundleId: null,
        createdAt: "2026-08-26T00:00:00.000Z",
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
    transaction(database, () =>
      linkManagedUser(database, {
        ...scope,
        userId: SECOND_DUPLICATE_ID,
        canonicalUserId: CANONICAL_ID,
        protectedUserIds: [],
        createdAt: "2026-09-03T08:01:00.000Z",
      }),
    );
    transaction(database, () =>
      disableManagedUser(database, {
        ...scope,
        userId: DUPLICATE_ID,
        protectedUserIds: [],
        createdAt: "2026-09-03T08:02:00.000Z",
      }),
    );
    const resolvedSession = resolveBrowserSession(database, {
      tokenDigest,
      now: ACTION_AT,
    });
    assert.equal(resolvedSession?.userId, CANONICAL_ID);
    assert.equal(resolvedSession?.actorId, CANONICAL_ID);
    assert.equal(resolvedSession?.displayName, "AKKKK");

    const result = listMobileBugs(
      database,
      {
        ...scope,
        ownerId: CANONICAL_ID,
        limit: 20,
      },
      CURSOR_SIGNING_KEY,
    );
    assert.deepEqual(
      result.items.map((bug) => bug.id),
      [secondCreated.bug.id, created.bug.id],
    );
    assert.ok(result.items.every((bug) => bug.ownerId === CANONICAL_ID));
    assert.ok(result.items.every((bug) => bug.verificationOwnerId === CANONICAL_ID));
    assert.equal(getMobileBug(database, scope, created.bug.id)?.ownerId, CANONICAL_ID);
    assert.equal(getMobileBug(database, scope, created.bug.id)?.verificationOwnerId, CANONICAL_ID);
    assert.equal(getMobileBug(database, scope, secondCreated.bug.id)?.ownerId, CANONICAL_ID);
    assert.equal(
      getMobileBug(database, scope, secondCreated.bug.id)?.verificationOwnerId,
      CANONICAL_ID,
    );
  } finally {
    database.close();
  }
});

test("verification-owner filters and opaque cursors return every canonical assignment", () => {
  const database = fixture();
  try {
    const createAssigned = (index: number) =>
      transaction(database, () =>
        createMobileBug(database, {
          ...scope,
          clientSubmissionId: `70000000-0000-4000-8003-${String(index).padStart(12, "0")}`,
          payloadDigest: String(index).repeat(64),
          title: `Verification task ${index}`,
          description: "Task assigned before identities were linked",
          expectedBehavior: "The canonical verifier can find every page",
          severity: "S2",
          priority: "P2",
          ownerId: null,
          verificationOwnerId: DUPLICATE_ID,
          occurrence: {
            observedAt: `2026-08-2${index}T00:00:00.000Z`,
            platform: "windows",
            steps: ["Open QA Hub"],
            actualBehavior: `Verification assignment ${index} is visible`,
          },
          attachmentIds: [],
          captureBundleId: null,
          createdAt: `2026-08-2${index}T00:00:00.000Z`,
        }),
      );
    const created = [createAssigned(5), createAssigned(6), createAssigned(7)];
    transaction(database, () =>
      linkManagedUser(database, {
        ...scope,
        userId: DUPLICATE_ID,
        canonicalUserId: CANONICAL_ID,
        protectedUserIds: [],
        createdAt: ACTION_AT,
      }),
    );

    const query = { ...scope, verificationOwnerId: CANONICAL_ID, limit: 1 } as const;
    const first = listMobileBugs(database, query, CURSOR_SIGNING_KEY);
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0]?.verificationOwnerId, CANONICAL_ID);
    const firstCursor = first.nextCursor;
    if (firstCursor === null) assert.fail("first page must have a cursor");
    assert.ok(firstCursor.length <= 500);
    assert.match(firstCursor, /^b1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
    const signCursorPayload = (payload: Record<string, unknown>) => {
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const signature = createHmac("sha256", CURSOR_SIGNING_KEY)
        .update(`b1.${encoded}`)
        .digest("base64url");
      return `b1.${encoded}.${signature}`;
    };
    const cursorPayload = JSON.parse(
      Buffer.from(firstCursor.split(".")[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    assert.throws(
      () =>
        listMobileBugs(
          database,
          { ...query, cursor: signCursorPayload({ ...cursorPayload, extra: true }) },
          CURSOR_SIGNING_KEY,
        ),
      /cursor is invalid/u,
    );
    const reorderedPayload = Object.fromEntries(Object.entries(cursorPayload).reverse());
    assert.throws(
      () =>
        listMobileBugs(
          database,
          { ...query, cursor: signCursorPayload(reorderedPayload) },
          CURSOR_SIGNING_KEY,
        ),
      /cursor is invalid/u,
    );
    const second = listMobileBugs(database, { ...query, cursor: firstCursor }, CURSOR_SIGNING_KEY);
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0]?.verificationOwnerId, CANONICAL_ID);
    assert.deepEqual(
      listMobileBugs(database, { ...query, cursor: firstCursor }, CURSOR_SIGNING_KEY),
      second,
    );
    const secondCursor = second.nextCursor;
    if (secondCursor === null) assert.fail("second page must have a cursor");
    const third = listMobileBugs(database, { ...query, cursor: secondCursor }, CURSOR_SIGNING_KEY);
    assert.equal(third.items.length, 1);
    assert.equal(third.items[0]?.verificationOwnerId, CANONICAL_ID);
    assert.equal(third.nextCursor, null);
    assert.deepEqual(
      [first, second, third].flatMap((page) => page.items.map((bug) => bug.id)),
      created.map((entry) => entry.bug.id).reverse(),
    );
    assert.throws(
      () =>
        listMobileBugs(
          database,
          { ...query, ownerState: "unassigned", cursor: firstCursor },
          CURSOR_SIGNING_KEY,
        ),
      /cursor is invalid/u,
    );
    assert.throws(
      () =>
        listMobileBugs(
          database,
          {
            ...query,
            cursor: `${firstCursor.slice(0, -1)}${firstCursor.endsWith("a") ? "b" : "a"}`,
          },
          CURSOR_SIGNING_KEY,
        ),
      /cursor is invalid/u,
    );
    assert.throws(
      () => listMobileBugs(database, { ...query, cursor: firstCursor }, new Uint8Array(32).fill(9)),
      /cursor is invalid/u,
    );

    createAssigned(8);
    assert.throws(
      () => listMobileBugs(database, { ...query, cursor: firstCursor }, CURSOR_SIGNING_KEY),
      /cursor is invalid/u,
    );

    const beforeUnlink = listMobileBugs(database, query, CURSOR_SIGNING_KEY);
    if (beforeUnlink.nextCursor === null) assert.fail("identity-link test requires a cursor");
    transaction(database, () =>
      unlinkManagedUser(database, {
        ...scope,
        userId: DUPLICATE_ID,
        protectedUserIds: [],
        createdAt: "2026-09-03T08:01:00.000Z",
      }),
    );
    assert.throws(
      () =>
        listMobileBugs(
          database,
          { ...query, cursor: beforeUnlink.nextCursor! },
          CURSOR_SIGNING_KEY,
        ),
      /cursor is invalid/u,
    );

    const unfiltered = { ...scope, limit: 1 } as const;
    const beforeMembershipCycle = listMobileBugs(database, unfiltered, CURSOR_SIGNING_KEY);
    if (beforeMembershipCycle.nextCursor === null) assert.fail("membership test requires a cursor");
    database
      .prepare(
        `UPDATE memberships
         SET status = 'revoked', updated_at = ?, version = version + 1
         WHERE account_id = ? AND project_id = ? AND user_id = ?`,
      )
      .run("2026-09-03T08:02:00.000Z", ACCOUNT_ID, PROJECT_ID, ACTOR_ID);
    database
      .prepare(
        `UPDATE memberships
         SET status = 'active', updated_at = ?, version = version + 1
         WHERE account_id = ? AND project_id = ? AND user_id = ?`,
      )
      .run("2026-09-03T08:03:00.000Z", ACCOUNT_ID, PROJECT_ID, ACTOR_ID);
    assert.throws(
      () =>
        listMobileBugs(
          database,
          { ...unfiltered, cursor: beforeMembershipCycle.nextCursor! },
          CURSOR_SIGNING_KEY,
        ),
      /cursor is invalid/u,
    );
  } finally {
    database.close();
  }
});
