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
import { createSqliteMobileBugStore } from "../dist/sqlite-mobile-bug-store.js";
import { createSqliteMobileRelayStore } from "../dist/sqlite-mobile-relay-store.js";
import { createSqliteRepairAttemptTerminalStore } from "../dist/sqlite-repair-attempt-terminal-store.js";
import { createSqliteMobileProjectDirectoryStore } from "../dist/sqlite-mobile-project-directory-store.js";
import { MOBILE_API_MEDIA_TYPE } from "../dist/mobile-bugs.js";

const now = () => new Date().toISOString();
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("createApiApp requires authenticated project wiring for workflow and terminal endpoints", () => {
  assert.throws(
    () =>
      createApiApp({
        logger: false,
        isolateLegacyComponents: true,
        workflowProjectionStore: { getPage: async () => ({}) },
      }),
    /requires browser authentication and project context/,
  );
  const identity = randomUUID();
  assert.throws(
    () =>
      createApiApp({
        logger: false,
        isolateLegacyComponents: true,
        terminalAttemptStore: {
          execute: async () => {
            throw new Error("unused");
          },
        },
        projectRequestContext: new ProjectRequestContext(),
        browserAuth: {
          store: {
            ensureBrowserAdmin: async () => {},
            loginBrowserSession: async () => null,
            createBrowserSession: async () => null,
            resolveBrowserSession: async () => null,
            revokeBrowserSession: async () => false,
          },
          accountId: identity,
          userId: identity,
          actorId: identity,
          adminEmail: "unused@example.invalid",
          passwordlessLogin: async () => ({ userId: identity }),
          sessionSecret: "terminal-config-test-only",
          webOrigins: [],
        },
      }),
    /require authenticated project context/,
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
    bId = randomUUID(),
    historicalUserId = randomUUID();
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
    assert.equal((await worker.initialization).migration.toVersion, 20);
    const bCreatorId = randomUUID();
    await worker.ensureMobileScope({
      ...bootstrap,
      projectId: bId,
      actorId: bCreatorId,
      membershipId: projectMembershipId(bId, bCreatorId),
      projectKey: "DWIREB",
      createdAt: now(),
    });
    await worker.ensureMobileScope({
      ...bootstrap,
      actorId: historicalUserId,
      membershipId: projectMembershipId(aId, historicalUserId),
      actorDisplayName: "Historical Workflow Alias",
      createdAt: now(),
    });
    const historicalScope = { accountId, projectId: aId, actorId: gmUserId };
    const historicalBug = await worker.createMobileBug({
      ...historicalScope,
      clientSubmissionId: randomUUID(),
      payloadDigest: digest("historical-assignment"),
      title: "Historical identity projection",
      description: "Assignments were recorded before the project identity link",
      expectedBehavior: "Read DTOs name the active canonical member",
      severity: "S2",
      priority: "P2",
      ownerId: historicalUserId,
      verificationOwnerId: historicalUserId,
      occurrence: {
        observedAt: now(),
        platform: "web",
        steps: ["Link the assigned historical identity"],
        actualBehavior: "The stored assignment keeps the historical ID",
      },
      attachmentIds: [],
      captureBundleId: null,
      createdAt: now(),
    });
    const historicalReady = await worker.transitionMobileBugReady({
      ...historicalScope,
      bugId: historicalBug.bug.id,
      expectedVersion: historicalBug.bug.version,
      idempotencyKey: randomUUID(),
      requestDigest: digest("historical-ready"),
      createdAt: now(),
    });
    const historicalAttempt = await worker.createMobileManualRepairAttempt({
      ...historicalScope,
      bugId: historicalBug.bug.id,
      expectedVersion: historicalReady.version,
      assigneeId: historicalUserId,
      summary: "Historical alias assignment",
      idempotencyKey: randomUUID(),
      requestDigest: digest("historical-attempt"),
      createdAt: now(),
    });
    const activeModuleId = randomUUID();
    const inactiveModuleId = randomUUID();
    const otherProjectModuleId = randomUUID();
    const moduleDatabase = new DatabaseSync(databaseFile);
    try {
      const insertModule = moduleDatabase.prepare(
        `INSERT INTO modules(id, account_id, project_id, name, active, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      );
      const moduleAt = now();
      insertModule.run(activeModuleId, accountId, aId, "Active API module", 1, moduleAt, moduleAt);
      insertModule.run(
        inactiveModuleId,
        accountId,
        aId,
        "Inactive API module",
        0,
        moduleAt,
        moduleAt,
      );
      insertModule.run(
        otherProjectModuleId,
        accountId,
        bId,
        "Other API module",
        1,
        moduleAt,
        moduleAt,
      );
    } finally {
      moduleDatabase.close();
    }
    const service = new ProjectManagementService({ worker, accountId, gmUserId });
    const context = new ProjectRequestContext();
    const scope = context.scope(bootstrap);
    app = createApiApp({
      logger: false,
      isolateLegacyComponents: true,
      projectManagementService: service,
      projectRequestContext: context,
      workflowProjectionStore: createSqliteWorkflowProjectionStore({ worker, scope }),
      mobileBugStore: createSqliteMobileBugStore({ worker, scope }),
      mobileHumanWorkflowStore: createSqliteMobileHumanWorkflowStore({ worker, scope }),
      mobileProjectDirectoryStore: createSqliteMobileProjectDirectoryStore({
        worker,
        scope,
        gmUserId,
      }),
      mobileRelayStore: createSqliteMobileRelayStore({
        worker,
        scope,
        relayDispatchEnabled: false,
      }),
      terminalAttemptStore: createSqliteRepairAttemptTerminalStore({ worker }),
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
      bob = await login("Workflow Bob", bId),
      historicalLogin = await login("Historical Workflow Alias", aId);
    const gm = await request("/api/v1/auth/gm/login", {
      body: { password: "workflow-integration-gm-only", client: "android" },
    });
    for (const result of [alice, bob, historicalLogin, gm]) assert.equal(result.status, 200);
    const gmProjects = await request("/api/v1/projects?limit=100", {
      token: gm.data.accessToken,
    });
    assert.equal(gmProjects.status, 200, JSON.stringify(gmProjects.data));
    assert.deepEqual(gmProjects.data.items.map((project) => project.id).sort(), [aId, bId].sort());
    assert.ok(gmProjects.data.items.every((project) => project.roles.includes("project_admin")));
    const employeeProjects = await request("/api/v1/projects?limit=100", {
      token: alice.data.accessToken,
      headers: { "x-qa-is-gm": "true" },
    });
    assert.equal(employeeProjects.status, 200, JSON.stringify(employeeProjects.data));
    assert.deepEqual(
      employeeProjects.data.items.map((project) => project.id),
      [aId],
    );
    assert.equal(historicalLogin.data.userId, historicalUserId);
    await worker.linkManagedUser({
      ...historicalScope,
      userId: historicalUserId,
      canonicalUserId: gmUserId,
      protectedUserIds: [],
      createdAt: now(),
    });
    const canonicalSession = await request("/api/v1/auth/me", {
      token: historicalLogin.data.accessToken,
      projectId: aId,
    });
    assert.equal(canonicalSession.status, 200, JSON.stringify(canonicalSession.data));
    assert.equal(canonicalSession.data.userId, gmUserId);
    const canonicalOwnerList = await request(
      `/api/v1/bugs?projectId=${aId}&ownerId=${gmUserId}&limit=50`,
      { token: historicalLogin.data.accessToken, projectId: aId },
    );
    assert.equal(canonicalOwnerList.status, 200, JSON.stringify(canonicalOwnerList.data));
    const canonicalListBug = canonicalOwnerList.data.items.find(
      (bug) => bug.id === historicalBug.bug.id,
    );
    assert.equal(canonicalListBug.ownerId, gmUserId);
    assert.equal(canonicalListBug.verificationOwnerId, gmUserId);
    const canonicalDetail = await request(`/api/v1/bugs/${historicalBug.bug.id}`, {
      token: historicalLogin.data.accessToken,
      projectId: aId,
    });
    assert.equal(canonicalDetail.status, 200, JSON.stringify(canonicalDetail.data));
    assert.equal(canonicalDetail.data.ownerId, gmUserId);
    assert.equal(canonicalDetail.data.verificationOwnerId, gmUserId);
    const canonicalWorkflow = await request(`/api/v1/bugs/${historicalBug.bug.id}/human-workflow`, {
      token: historicalLogin.data.accessToken,
      projectId: aId,
    });
    assert.equal(canonicalWorkflow.status, 200, JSON.stringify(canonicalWorkflow.data));
    assert.equal(canonicalWorkflow.data.repairAttempt.id, historicalAttempt.id);
    assert.equal(canonicalWorkflow.data.repairAttempt.assigneeId, gmUserId);
    const a = { accountId, projectId: aId, actorId: alice.data.userId };
    const b = { accountId, projectId: bId, actorId: bob.data.userId };
    const postCategorizedBug = (moduleId, clientSubmissionId) =>
      request("/api/v1/bugs", {
        token: alice.data.accessToken,
        projectId: aId,
        body: {
          submissionContractVersion: "1.1.0",
          projectId: aId,
          clientSubmissionId,
          title: "Categorized API Bug",
          description: "The module survives the public API and worker boundary",
          expectedBehavior: "Only an active same-project module is accepted",
          moduleId,
          severity: "S2",
          priority: "P2",
          occurrence: {
            observedAt: now(),
            platform: "web",
            steps: ["Submit the categorized Bug"],
            actualBehavior: "The request reaches storage",
          },
        },
        headers: {
          "content-type": MOBILE_API_MEDIA_TYPE,
          "idempotency-key": `submission:${clientSubmissionId}:commit`,
        },
      });
    const categorized = await postCategorizedBug(activeModuleId, randomUUID());
    assert.equal(categorized.status, 201, JSON.stringify(categorized.data));
    assert.equal(categorized.data.bug.moduleId, activeModuleId);
    for (const moduleId of [inactiveModuleId, otherProjectModuleId]) {
      const rejected = await postCategorizedBug(moduleId, randomUUID());
      assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
      assert.equal(rejected.data.code, "INVALID_REQUEST");
    }
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
      bugB = await create(b),
      listBugA = await create(a);
    const listPath = `/api/v1/bugs?projectId=${aId}&verificationOwnerId=${a.actorId}&limit=1`;
    const listFirst = await request(listPath, {
      token: alice.data.accessToken,
      projectId: aId,
    });
    assert.equal(listFirst.status, 200, JSON.stringify(listFirst.data));
    assert.equal(listFirst.data.items.length, 1);
    assert.match(listFirst.data.nextCursor, /^b1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
    const listSecond = await request(
      `${listPath}&cursor=${encodeURIComponent(listFirst.data.nextCursor)}`,
      { token: alice.data.accessToken, projectId: aId },
    );
    assert.equal(listSecond.status, 200, JSON.stringify(listSecond.data));
    assert.equal(listSecond.data.items.length, 1);
    assert.equal(listSecond.data.nextCursor, null);
    assert.equal(listSecond.data.snapshotSequence, listFirst.data.snapshotSequence);
    assert.deepEqual(
      new Set([...listFirst.data.items, ...listSecond.data.items].map((bug) => bug.id)),
      new Set([bugA.bug.id, listBugA.bug.id]),
    );
    const gmSelectedProject = await request("/api/v1/bugs?limit=500&sort=created_desc", {
      token: gm.data.accessToken,
      projectId: aId,
    });
    assert.equal(gmSelectedProject.status, 200, JSON.stringify(gmSelectedProject.data));
    assert.ok(gmSelectedProject.data.items.length <= 100);
    assert.ok(gmSelectedProject.data.items.every((bug) => bug.projectId === aId));
    assert.ok(gmSelectedProject.data.items.some((bug) => bug.id === bugA.bug.id));
    assert.ok(gmSelectedProject.data.items.every((bug) => bug.id !== bugB.bug.id));
    const gmProjectB = await request("/api/v1/bugs?limit=500&sort=created_desc", {
      token: gm.data.accessToken,
      projectId: bId,
    });
    assert.equal(gmProjectB.status, 200, JSON.stringify(gmProjectB.data));
    assert.ok(gmProjectB.data.items.every((bug) => bug.projectId === bId));
    assert.ok(gmProjectB.data.items.some((bug) => bug.id === bugB.bug.id));
    assert.ok(gmProjectB.data.items.every((bug) => bug.id !== bugA.bug.id));
    const tamperedCursor = `${listFirst.data.nextCursor.slice(0, -1)}${
      listFirst.data.nextCursor.endsWith("a") ? "b" : "a"
    }`;
    const rejectedCursor = await request(
      `${listPath}&cursor=${encodeURIComponent(tamperedCursor)}`,
      { token: alice.data.accessToken, projectId: aId },
    );
    assert.equal(rejectedCursor.status, 400);
    assert.equal(rejectedCursor.data.code, "INVALID_REQUEST");

    const runningAttempt = async (scope, token) => {
      const created = await create(scope);
      const ready = await request(`/api/v1/bugs/${created.bug.id}/transitions`, {
        token,
        projectId: scope.projectId,
        body: { expectedVersion: created.bug.version, toState: "ready" },
        headers: {
          "idempotency-key": `workflow:transitionBug:bug:${created.bug.id}:v${created.bug.version}:ready`,
        },
      });
      assert.equal(ready.status, 200, JSON.stringify(ready.data));
      const planned = await request(`/api/v1/bugs/${created.bug.id}/repair-attempts`, {
        token,
        projectId: scope.projectId,
        body: {
          expectedVersion: ready.data.version,
          mode: "human",
          assigneeId: scope.actorId,
          summary: "Integrated terminal fixture",
        },
        headers: {
          "idempotency-key": `workflow:createRepairAttempt:bug:${created.bug.id}:v${ready.data.version}`,
        },
      });
      assert.equal(planned.status, 201);
      const running = await request(`/api/v1/repair-attempts/${planned.data.id}/start`, {
        token,
        projectId: scope.projectId,
        body: { expectedVersion: planned.data.version },
        headers: {
          "idempotency-key": `workflow:startRepairAttempt:attempt:${planned.data.id}:v${planned.data.version}`,
        },
      });
      assert.equal(running.status, 200);
      return { bug: created.bug, attempt: running.data };
    };

    const failedFixture = await runningAttempt(a, alice.data.accessToken);
    const failed = await request(`/api/v1/repair-attempts/${failedFixture.attempt.id}/fail`, {
      token: alice.data.accessToken,
      projectId: aId,
      body: { expectedVersion: failedFixture.attempt.version, reason: "Local worker failure" },
      headers: { accept: "application/json", "idempotency-key": randomUUID() },
    });
    assert.equal(failed.status, 200);
    assert.equal(failed.data.status, "failed");
    assert.equal(failed.data.summary, "Local worker failure");

    const legacyFixture = await runningAttempt(a, alice.data.accessToken);
    const legacySupersede = await request(
      `/api/v1/repair-attempts/${legacyFixture.attempt.id}/supersede`,
      {
        token: alice.data.accessToken,
        projectId: aId,
        body: {
          expectedVersion: legacyFixture.attempt.version,
          reason: "Finish legacy attempt before planning its successor",
        },
        headers: { accept: "application/json", "idempotency-key": randomUUID() },
      },
    );
    assert.equal(legacySupersede.status, 200);
    assert.equal(legacySupersede.data.status, "superseded");
    const legacyBug = await request(`/api/v1/bugs/${legacyFixture.bug.id}`, {
      token: alice.data.accessToken,
      projectId: aId,
    });
    assert.equal(legacyBug.status, 200);
    assert.equal(legacyBug.data.state, "ready");
    const parentKey = randomUUID();
    const parentBody = {
      parentAttemptId: legacyFixture.attempt.id,
      expectedVersion: legacyBug.data.version,
      mode: "relay",
      assigneeId: a.actorId,
      summary: "Legacy two-step successor",
    };
    const parented = await request(`/api/v1/bugs/${legacyFixture.bug.id}/repair-attempts`, {
      token: alice.data.accessToken,
      projectId: aId,
      body: parentBody,
      headers: { accept: "application/json", "idempotency-key": parentKey },
    });
    assert.equal(parented.status, 201);
    assert.equal(parented.data.parentAttemptId, legacyFixture.attempt.id);
    assert.equal(parented.data.mode, "relay");
    const parentReplay = await request(`/api/v1/bugs/${legacyFixture.bug.id}/repair-attempts`, {
      token: alice.data.accessToken,
      projectId: aId,
      body: parentBody,
      headers: { "idempotency-key": parentKey },
    });
    assert.equal(parentReplay.status, 201);
    assert.deepEqual(parentReplay.data, parented.data);

    const supersedeFixture = await runningAttempt(b, bob.data.accessToken);
    const successorId = randomUUID();
    const supersedeBody = {
      expectedVersion: supersedeFixture.attempt.version,
      reason: "Replace atomically",
      successor: {
        id: successorId,
        mode: "external",
        assigneeId: b.actorId,
        summary: "External successor",
      },
    };
    const supersedeKey = `workflow:supersedeRepairAttempt:attempt:${supersedeFixture.attempt.id}:v${supersedeFixture.attempt.version}`;
    const superseded = await request(
      `/api/v1/repair-attempts/${supersedeFixture.attempt.id}/supersede`,
      {
        token: gm.data.accessToken,
        projectId: bId,
        body: supersedeBody,
        headers: {
          "content-type": MOBILE_API_MEDIA_TYPE,
          "idempotency-key": supersedeKey,
        },
      },
    );
    assert.equal(superseded.status, 200);
    assert.equal(superseded.data.supersededAttempt.status, "superseded");
    assert.equal(superseded.data.successorAttempt.id, successorId);
    assert.equal(superseded.data.successorAttempt.mode, "external");
    assert.equal(superseded.data.bug.state, "in_progress");
    assert.equal(superseded.data.replayed, false);
    const replayed = await request(
      `/api/v1/repair-attempts/${supersedeFixture.attempt.id}/supersede`,
      {
        token: gm.data.accessToken,
        projectId: bId,
        body: supersedeBody,
        headers: {
          accept: "application/json",
          "content-type": MOBILE_API_MEDIA_TYPE,
          "idempotency-key": supersedeKey,
        },
      },
    );
    assert.equal(replayed.status, 200);
    assert.equal(replayed.headers.get("content-type"), `${MOBILE_API_MEDIA_TYPE}; charset=utf-8`);
    assert.equal(replayed.data.eventId, superseded.data.eventId);
    assert.equal(replayed.data.replayed, true);
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
        readback.prepare("SELECT count(*) AS n FROM repair_attempt_terminal_snapshots").get().n,
        3,
      );
      assert.equal(
        readback.prepare("SELECT count(*) AS n FROM repair_attempt_parent_plan_snapshots").get().n,
        1,
      );
      assert.deepEqual(
        readback
          .prepare("SELECT id,status FROM repair_attempts WHERE id IN (?,?) ORDER BY id")
          .all(failedFixture.attempt.id, supersedeFixture.attempt.id)
          .map((row) => ({ id: String(row.id), status: String(row.status) })),
        [
          { id: failedFixture.attempt.id, status: "failed" },
          { id: supersedeFixture.attempt.id, status: "superseded" },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
      assert.equal(
        readback
          .prepare("SELECT active_repair_attempt_id FROM bugs WHERE id=?")
          .get(supersedeFixture.bug.id).active_repair_attempt_id,
        successorId,
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
        schema: 20,
        externalRequests: 0,
      }),
    );
  } finally {
    await app?.close();
    await worker.close();
  }
});
