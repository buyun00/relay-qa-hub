import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteStorageWorker, projectMembershipId } from "@relay-qa-hub/storage";
import { createApiApp } from "../dist/app.js";
import { ProjectManagementService } from "../dist/project-management.js";
import { ProjectRequestContext } from "../dist/project-request-context.js";
import { createSqliteBrowserAuthStore } from "../dist/browser-auth.js";
import { createSqliteWorkflowProjectionStore } from "../dist/sqlite-workflow-projection-store.js";
import { createSqliteMobileHumanWorkflowStore } from "../dist/sqlite-mobile-human-workflow-store.js";
import { MOBILE_API_MEDIA_TYPE } from "../dist/mobile-bugs.js";

const now = () => new Date().toISOString();
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("createApiApp requires authenticated project wiring for the new workflow endpoint", () => {
  assert.throws(
    () =>
      createApiApp({
        logger: false,
        isolateLegacyComponents: true,
        workflowProjectionStore: { getPage: async () => ({}) },
      }),
    /requires browser authentication and project context/,
  );
});

test("registered workflow HTTP uses real worker GM scope, durable pagination and current authorization", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qa-workflow-api-integration-"));
  t.diagnostic(`retained isolated createApiApp fixture ${directory}`);
  const databaseFile = join(directory, "workflow.sqlite");
  const worker = new SqliteStorageWorker({
    databaseFile,
    backupRoot: join(directory, "backups"),
    busyTimeoutMs: 5000,
  });
  const accountId = randomUUID(),
    gmUserId = randomUUID(),
    aId = randomUUID(),
    bId = randomUUID();
  const bootstrap = {
    accountId,
    projectId: aId,
    actorId: gmUserId,
    membershipId: projectMembershipId(aId, gmUserId),
    projectKey: "DWIREA",
    createdAt: now(),
  };
  let app;
  const ledger = [];
  try {
    await worker.ensureMobileScope(bootstrap);
    assert.equal((await worker.initialization).migration.toVersion, 17);
    const bCreatorId = randomUUID();
    await worker.ensureMobileScope({
      ...bootstrap,
      projectId: bId,
      actorId: bCreatorId,
      membershipId: projectMembershipId(bId, bCreatorId),
      projectKey: "DWIREB",
      createdAt: now(),
    });
    const service = new ProjectManagementService({ worker, accountId, gmUserId });
    const context = new ProjectRequestContext();
    const scope = context.scope(bootstrap);
    app = createApiApp({
      logger: false,
      isolateLegacyComponents: true,
      projectManagementService: service,
      projectRequestContext: context,
      workflowProjectionStore: createSqliteWorkflowProjectionStore({ worker, scope }),
      mobileHumanWorkflowStore: createSqliteMobileHumanWorkflowStore({ worker, scope }),
      browserAuth: {
        store: createSqliteBrowserAuthStore({ worker }),
        accountId,
        userId: gmUserId,
        actorId: gmUserId,
        adminEmail: "unused@example.invalid",
        passwordlessLogin: async () => {
          throw Error("Project required");
        },
        projectLogin: (name, projectId, stamp) => service.login(name, projectId, stamp),
        sessionSecret: "workflow-integration-only",
        webOrigins: [],
        gm: { userId: gmUserId, password: "workflow-integration-gm-only" },
      },
    });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    assert(
      ![4174, 4274, 4319, 4320, 4419, 4420, 4421, 4459, 4461].includes(
        Number(new URL(origin).port),
      ),
    );
    const request = async (path, { token, projectId, body, headers = {} } = {}) => {
      const response = await fetch(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          accept: MOBILE_API_MEDIA_TYPE,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(projectId ? { "x-qa-project-id": projectId } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await response.json();
      ledger.push({
        method: body === undefined ? "GET" : "POST",
        path: path.split("?")[0],
        status: response.status,
        media: response.headers.get("content-type"),
      });
      return { status: response.status, data, headers: response.headers };
    };
    const login = (name, projectId) =>
      request("/api/v1/auth/login", { body: { name, projectId, client: "android" } });
    const alice = await login("Workflow Alice", aId),
      bob = await login("Workflow Bob", bId);
    const gm = await request("/api/v1/auth/gm/login", {
      body: { password: "workflow-integration-gm-only", client: "android" },
    });
    for (const result of [alice, bob, gm]) assert.equal(result.status, 200);
    const a = { accountId, projectId: aId, actorId: alice.data.userId };
    const b = { accountId, projectId: bId, actorId: bob.data.userId };
    const create = (input) =>
      worker.createMobileBug({
        ...input,
        clientSubmissionId: randomUUID(),
        payloadDigest: digest(input),
        title: "Registered workflow",
        description: "Local fixture",
        expectedBehavior: "Scope persists",
        severity: "S2",
        priority: "P2",
        ownerId: input.actorId,
        verificationOwnerId: input.actorId,
        occurrence: {
          observedAt: now(),
          platform: "web",
          steps: ["Read"],
          actualBehavior: "Created",
        },
        attachmentIds: [],
        captureBundleId: null,
        createdAt: now(),
      });
    const bugA = await create(a),
      bugB = await create(b);
    const db = new DatabaseSync(databaseFile);
    try {
      db.exec("BEGIN IMMEDIATE");
      const columns = db
        .prepare("PRAGMA table_xinfo(occurrences)")
        .all()
        .filter((r) => r.hidden === 0)
        .map((r) => r.name);
      const row = db.prepare("SELECT * FROM occurrences WHERE id=?").get(bugA.occurrenceId);
      const insert = db.prepare(
        `INSERT INTO occurrences(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      );
      for (let i = 0; i < 2; i++) {
        const copy = { ...row, id: randomUUID(), client_submission_id: randomUUID() };
        insert.run(...columns.map((c) => copy[c]));
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    const pathA = `/api/v1/bugs/${bugA.bug.id}/workflow`;
    const pathB = `/api/v1/bugs/${bugB.bug.id}/workflow`;
    const getA = (extra = {}) =>
      request(pathA, { token: alice.data.accessToken, projectId: aId, ...extra });
    assert.equal((await request(pathA)).status, 401);
    assert.equal((await getA({ headers: { "x-qa-project-id": bId } })).status, 404);
    const first = await request(pathA + "?limitPerCollection=1", {
      token: alice.data.accessToken,
      projectId: aId,
    });
    assert.equal(first.status, 200);
    assert.equal(first.data.occurrences.length, 1);
    assert.ok(first.data.nextCursor);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const page =
      pathA + `?limitPerCollection=1&cursor=${encodeURIComponent(first.data.nextCursor)}`;
    const second = await request(page, { token: alice.data.accessToken, projectId: aId });
    assert.equal(second.status, 200);
    assert.deepEqual(
      (await request(page, { token: alice.data.accessToken, projectId: aId })).data,
      second.data,
    );
    const parallel = await Promise.all([
      request(pathB, { token: gm.data.accessToken, projectId: bId }),
      request(pathB, { token: alice.data.accessToken, projectId: bId }),
      request(pathB, { token: bob.data.accessToken, projectId: bId }),
      getA(),
      getA({
        headers: { "x-qa-actor-id": gmUserId, "x-qa-is-gm": "true" },
        token: bob.data.accessToken,
      }),
    ]);
    assert.deepEqual(
      parallel.map((r) => r.status),
      [200, 403, 200, 200, 403],
    );
    assert.equal(parallel[0].data.bugId, bugB.bug.id);
    assert.equal((await getA({ headers: { accept: "application/*;q=0, */*;q=1" } })).status, 406);
    assert.equal(
      (await request(pathA + "?cursor=invalid", { token: gm.data.accessToken, projectId: aId }))
        .status,
      400,
    );
    assert.equal(
      (
        await request(`/api/v1/bugs/${bugA.bug.id}/human-workflow`, {
          token: alice.data.accessToken,
          projectId: aId,
        })
      ).status,
      200,
    );
    await worker.projectManagement({
      accountId,
      actorId: gmUserId,
      isGm: true,
      projectId: aId,
      operation: "membership",
      userId: a.actorId,
      active: false,
      expectedVersion: 1,
      now: now(),
    });
    assert.equal(
      (await request(page, { token: alice.data.accessToken, projectId: aId })).status,
      403,
    );
    await worker.projectManagement({
      accountId,
      actorId: gmUserId,
      isGm: true,
      projectId: aId,
      operation: "membership",
      userId: a.actorId,
      active: true,
      expectedVersion: 2,
      now: now(),
    });
    assert.equal(
      (await request(page, { token: alice.data.accessToken, projectId: aId })).status,
      400,
    );
    await worker.deleteMobileBug({
      ...a,
      bugId: bugA.bug.id,
      expectedVersion: bugA.bug.version,
      idempotencyKey: randomUUID(),
      requestDigest: digest("delete"),
      createdAt: now(),
    });
    assert.equal((await request(page, { token: gm.data.accessToken, projectId: aId })).status, 404);
    const readback = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      assert.equal(
        readback.prepare("SELECT count(*) AS n FROM storage_command_authorizations").get().n,
        0,
      );
      assert.equal(
        readback
          .prepare("SELECT count(*) AS n FROM memberships WHERE project_id=? AND user_id=?")
          .get(bId, gmUserId).n,
        0,
      );
      const keys = readback.prepare("SELECT signing_key FROM workflow_projection_snapshots").all();
      for (const { signing_key: key } of keys) {
        assert(
          !JSON.stringify([first, second, ...parallel]).includes(Buffer.from(key).toString("hex")),
        );
        assert(
          !JSON.stringify([first, second, ...parallel]).includes(
            Buffer.from(key).toString("base64"),
          ),
        );
      }
    } finally {
      readback.close();
    }
    t.diagnostic(
      JSON.stringify({
        actualHttpRequests: ledger.length,
        ledger,
        realWorker: true,
        schema: 17,
        externalRequests: 0,
      }),
    );
  } finally {
    await app?.close();
    await worker.close();
  }
});
