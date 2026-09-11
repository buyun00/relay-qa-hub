import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensureMobileScope } from "../src/mobile-bug-store.ts";
import { SQLITE_MIGRATIONS } from "../src/sqlite-migrations.ts";
import {
  projectManagement,
  projectMembershipId,
  type ProjectManagementInput,
  type ProjectOnboardingRecord,
} from "../src/project-management-store.ts";

const accountId = "99000000-0000-4000-8000-000000000001";
const gmId = "99000000-0000-4000-8000-000000000002";
const legacyProjectId = "99000000-0000-4000-8000-000000000003";
const timestamp = "2026-09-11T01:00:00.000Z";

const projectIds = {
  pending: "99000000-0000-4000-8000-000000000004",
  atomic: "99000000-0000-4000-8000-000000000005",
  second: "99000000-0000-4000-8000-000000000006",
  reset: "99000000-0000-4000-8000-000000000007",
} as const;

const userIds = {
  first: "99000000-0000-4000-8000-000000000011",
  second: "99000000-0000-4000-8000-000000000012",
  atomic: "99000000-0000-4000-8000-000000000013",
  invalid: "99000000-0000-4000-8000-000000000014",
} as const;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

type ExecuteInput = Omit<ProjectManagementInput, "accountId" | "actorId" | "now"> & {
  actorId?: string;
};

function databaseWithCurrentSchema(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of SQLITE_MIGRATIONS) database.exec(migration.sql);
  transaction(database, () =>
    ensureMobileScope(database, {
      accountId,
      actorId: gmId,
      projectId: legacyProjectId,
      projectKey: "LEGACY",
      projectName: "Legacy project",
      membershipId: projectMembershipId(legacyProjectId, gmId),
      actorDisplayName: "GM",
      createdAt: timestamp,
    }),
  );
  return database;
}

function historicalDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of SQLITE_MIGRATIONS.filter(({ version }) => version <= 20))
    database.exec(migration.sql);
  transaction(database, () =>
    ensureMobileScope(database, {
      accountId,
      actorId: gmId,
      projectId: legacyProjectId,
      projectKey: "LEGACY",
      projectName: "Legacy project",
      membershipId: projectMembershipId(legacyProjectId, gmId),
      actorDisplayName: "GM",
      createdAt: timestamp,
    }),
  );
  database.exec(SQLITE_MIGRATIONS.find(({ version }) => version === 21)!.sql);
  return database;
}

function executor(database: DatabaseSync) {
  return <T = unknown>(input: ExecuteInput): T =>
    transaction(
      database,
      () =>
        projectManagement(database, {
          accountId,
          actorId: input.actorId ?? gmId,
          now: timestamp,
          ...input,
        }) as T,
    );
}

function createPending(
  execute: ReturnType<typeof executor>,
  projectId: string,
  projectKey: string,
  tokenLabel: string,
  codeLabel: string,
): ProjectOnboardingRecord {
  return execute<ProjectOnboardingRecord>({
    operation: "createOnboarding",
    projectId,
    key: projectKey,
    name: `待初始化 ${projectKey}`,
    joinCodeDigest: digest(codeLabel),
    joinCodeCiphertext: `${codeLabel}-v1-opaque-ciphertext`,
    initializationTokenDigest: digest(tokenLabel),
    initializationTokenCiphertext: `${tokenLabel}-v1-opaque-ciphertext`,
    isGm: true,
  });
}

function initialize(
  execute: ReturnType<typeof executor>,
  tokenLabel: string,
  submissionLabel: string,
  name: string,
  nameKey: string,
  initialMembers: ProjectManagementInput["initialMembers"] = [],
): ProjectOnboardingRecord {
  return execute<ProjectOnboardingRecord>({
    operation: "initializeProject",
    initializationTokenDigest: digest(tokenLabel),
    submissionDigest: digest(submissionLabel),
    name,
    nameKey,
    initialMembers,
  });
}

test("v21 migration keeps historical projects pending without a default code", () => {
  const database = historicalDatabase();
  try {
    const row = database
      .prepare(
        `SELECT initialization_status, join_name, join_code_digest,
                join_code_ciphertext, join_code_version,
                initialization_token_status, initialization_token_digest
           FROM project_onboarding
          WHERE account_id = ? AND project_id = ?`,
      )
      .get(accountId, legacyProjectId) as Record<string, unknown>;
    assert.deepEqual(
      { ...row },
      {
        initialization_status: "pending",
        join_name: null,
        join_code_digest: null,
        join_code_ciphertext: null,
        join_code_version: 0,
        initialization_token_status: "absent",
        initialization_token_digest: null,
      },
    );
  } finally {
    database.close();
  }
});

test("pending onboarding preserves ciphertext and initialization consumes its write token", () => {
  const database = databaseWithCurrentSchema();
  const execute = executor(database);
  try {
    const pending = createPending(execute, projectIds.pending, "PENDING", "token-pending", "0007");
    assert.equal(pending.initializationStatus, "pending");
    assert.equal(pending.joinCodeVersion, 1);
    assert.equal(pending.joinCodeCiphertext, "0007-v1-opaque-ciphertext");
    assert.equal(typeof pending.joinCodeCiphertext, "string");
    assert.equal(typeof pending.initializationTokenCiphertext, "string");

    const atomic = createPending(execute, projectIds.atomic, "ATOMIC", "token-atomic", "0042");
    assert.equal(atomic.initializationStatus, "pending");
    assert.throws(
      () =>
        initialize(
          execute,
          "token-atomic",
          "atomic-submission",
          "Atomic project",
          "atomic-project",
          [
            {
              userId: userIds.atomic,
              nameKey: "负责人",
              displayName: "负责人",
              email: "atomic-owner@test.invalid",
            },
            {
              userId: userIds.invalid,
              nameKey: "坏成员",
              displayName: "",
              email: "invalid-member@test.invalid",
            },
          ],
        ),
      { code: "INVALID_REQUEST" },
    );
    const afterFailure = execute<ProjectOnboardingRecord>({
      operation: "onboardingAdmin",
      projectId: projectIds.atomic,
      isGm: true,
    });
    assert.equal(afterFailure.initializationStatus, "pending");
    assert.equal(afterFailure.joinName, null);
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM project_member_names WHERE account_id = ? AND project_id = ?",
        )
        .get(accountId, projectIds.atomic)?.["count"],
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM memberships WHERE account_id = ? AND project_id = ?",
        )
        .get(accountId, projectIds.atomic)?.["count"],
      1,
    );

    const initialized = initialize(
      execute,
      "token-pending",
      "pending-submission",
      "Alpha project",
      "alpha-project",
    );
    assert.equal(initialized.initializationStatus, "ready");
    assert.equal(initialized.joinName, "Alpha project");
    assert.equal(initialized.joinCodeVersion, 1);
    assert.throws(
      () =>
        initialize(
          execute,
          "token-pending",
          "pending-submission",
          "Alpha project",
          "alpha-project",
        ),
      { code: "INITIALIZATION_ALREADY_COMPLETED" },
    );
    assert.throws(
      () =>
        execute({
          operation: "inspectInitialization",
          initializationTokenDigest: digest("token-pending"),
        }),
      { code: "INITIALIZATION_LINK_INVALID" },
    );
    assert.throws(
      () =>
        initialize(
          execute,
          "token-pending",
          "different-submission",
          "Changed project",
          "changed-project",
        ),
      { code: "INITIALIZATION_ALREADY_COMPLETED" },
    );
    assert.equal(
      execute<ProjectOnboardingRecord>({
        operation: "onboardingAdmin",
        projectId: projectIds.pending,
        isGm: true,
      }).joinName,
      "Alpha project",
    );

    createPending(execute, projectIds.second, "SECOND", "token-second", "0008");
    assert.throws(
      () =>
        initialize(execute, "token-second", "second-submission", "Alpha project", "alpha-project"),
      { code: "PROJECT_NAME_CONFLICT" },
    );
    assert.equal(
      execute<ProjectOnboardingRecord>({
        operation: "onboardingAdmin",
        projectId: projectIds.second,
        isGm: true,
      }).initializationStatus,
      "pending",
    );
  } finally {
    database.close();
  }
});

test("join uses the project code digest, deduplicates a new name, scopes same names per project, and rejects revoked members", () => {
  const database = databaseWithCurrentSchema();
  const execute = executor(database);
  try {
    createPending(execute, projectIds.pending, "JOINA", "token-joina", "0011");
    initialize(execute, "token-joina", "join-a-submission", "Join project A", "join-project-a");
    createPending(execute, projectIds.second, "JOINB", "token-joinb", "0012");
    initialize(execute, "token-joinb", "join-b-submission", "Join project B", "join-project-b");

    assert.throws(
      () =>
        execute({
          operation: "joinByCode",
          nameKey: "join-project-a",
          joinCodeDigest: digest("wrong-code"),
          memberNameKey: "same-person",
          userId: userIds.first,
          displayName: "Same Person",
          email: "same-person-a@test.invalid",
        }),
      { code: "AUTHENTICATION_FAILED" },
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM project_member_names WHERE account_id = ? AND project_id = ?",
        )
        .get(accountId, projectIds.pending)?.["count"],
      0,
    );

    const first = execute<{ userId: string; projectId: string }>({
      operation: "joinByCode",
      nameKey: "join-project-a",
      joinCodeDigest: digest("0011"),
      memberNameKey: "same-person",
      userId: userIds.first,
      displayName: "Same Person",
      email: "same-person-a@test.invalid",
    });
    const repeatedWithDifferentRequestedUser = execute<{ userId: string; projectId: string }>({
      operation: "joinByCode",
      nameKey: "join-project-a",
      joinCodeDigest: digest("0011"),
      memberNameKey: "same-person",
      userId: userIds.second,
      displayName: "Same Person",
      email: "same-person-second@test.invalid",
    });
    assert.deepEqual(repeatedWithDifferentRequestedUser, first);
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM project_member_names WHERE account_id = ? AND project_id = ?",
        )
        .get(accountId, projectIds.pending)?.["count"],
      1,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM memberships WHERE account_id = ? AND project_id = ? AND user_id = ?",
        )
        .get(accountId, projectIds.pending, userIds.first)?.["count"],
      1,
    );

    const otherProject = execute<{ userId: string; projectId: string }>({
      operation: "joinByCode",
      nameKey: "join-project-b",
      joinCodeDigest: digest("0012"),
      memberNameKey: "same-person",
      userId: userIds.second,
      displayName: "Same Person",
      email: "same-person-b@test.invalid",
    });
    assert.equal(otherProject.projectId, projectIds.second);
    assert.notEqual(otherProject.userId, first.userId);

    transaction(database, () =>
      database
        .prepare(
          "UPDATE memberships SET status = 'revoked', version = version + 1, updated_at = ? WHERE account_id = ? AND project_id = ? AND user_id = ?",
        )
        .run(timestamp, accountId, projectIds.pending, userIds.first),
    );
    assert.throws(
      () =>
        execute({
          operation: "joinByCode",
          nameKey: "join-project-a",
          joinCodeDigest: digest("0011"),
          memberNameKey: "same-person",
          userId: userIds.second,
          displayName: "Same Person",
          email: "same-person-second@test.invalid",
        }),
      { code: "PROJECT_MEMBERSHIP_DISABLED" },
    );
    assert.equal(
      database
        .prepare(
          "SELECT status FROM memberships WHERE account_id = ? AND project_id = ? AND user_id = ?",
        )
        .get(accountId, projectIds.pending, userIds.first)?.["status"],
      "revoked",
    );
  } finally {
    database.close();
  }
});

test("GM code reset increments the version and invalidates the old digest", () => {
  const database = databaseWithCurrentSchema();
  const execute = executor(database);
  try {
    createPending(execute, projectIds.reset, "RESET", "token-reset", "0021");
    const before = initialize(
      execute,
      "token-reset",
      "reset-submission",
      "Reset project",
      "reset-project",
    );
    const reset = execute<ProjectOnboardingRecord>({
      operation: "resetJoinCode",
      projectId: projectIds.reset,
      joinCodeDigest: digest("0099"),
      joinCodeCiphertext: "0099-v1-opaque-ciphertext",
      isGm: true,
    });
    assert.equal(reset.joinCodeVersion, before.joinCodeVersion + 1);
    assert.equal(reset.joinCodeCiphertext, "0099-v1-opaque-ciphertext");
    assert.equal(typeof reset.joinCodeCiphertext, "string");
    assert.throws(
      () =>
        execute({
          operation: "joinByCode",
          nameKey: "reset-project",
          joinCodeDigest: digest("0021"),
          memberNameKey: "old-code-user",
          userId: userIds.first,
          displayName: "Old Code User",
          email: "old-code-user@test.invalid",
        }),
      { code: "AUTHENTICATION_FAILED" },
    );
    const joined = execute<{ userId: string; projectId: string }>({
      operation: "joinByCode",
      nameKey: "reset-project",
      joinCodeDigest: digest("0099"),
      memberNameKey: "new-code-user",
      userId: userIds.second,
      displayName: "New Code User",
      email: "new-code-user@test.invalid",
    });
    assert.equal(joined.projectId, projectIds.reset);
  } finally {
    database.close();
  }
});
