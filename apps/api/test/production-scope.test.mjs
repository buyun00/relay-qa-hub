import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { SqliteStorageWorker, projectMembershipId } from "@relay-qa-hub/storage";
import { ProductionTasks, registerProductionRoutes } from "../dist/production-tasks.js";
import { ProjectManagementService } from "../dist/project-management.js";
import { createSqliteMobileProjectDirectoryStore } from "../dist/sqlite-mobile-project-directory-store.js";

test("actual HTTP and SQLite authorize the 101st Relay member/project and recheck revocation, GM and disabled scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qa-production-scope-"));
  const worker = new SqliteStorageWorker({
    databaseFile: join(root, "qa.sqlite"),
    backupRoot: join(root, "backups"),
    busyTimeoutMs: 1000,
  });
  const accountId = randomUUID(),
    gmUserId = randomUUID(),
    actorId = randomUUID();
  const projectIds = Array.from({ length: 101 }, () => randomUUID());
  const projectId = projectIds.at(-1);
  const at = new Date().toISOString();
  const scope = (id, userId, projectKey, actorDisplayName) => ({
    accountId,
    projectId: id,
    actorId: userId,
    projectKey,
    actorDisplayName,
    membershipId: projectMembershipId(id, userId),
    createdAt: at,
  });
  const app = Fastify();
  let service;
  t.after(async () => {
    await app.close();
    await service?.close();
    await worker.close();
    await rm(root, { recursive: true, force: true });
  });
  await worker.ensureMobileScope(scope(randomUUID(), gmUserId, "GMROOT", "GM"));
  for (const [index, id] of projectIds.entries())
    await worker.ensureMobileScope(
      scope(id, actorId, `P${String(index).padStart(3, "0")}`, "Z last member"),
    );
  for (let index = 0; index < 100; index++)
    await worker.ensureMobileScope(
      scope(projectId, randomUUID(), "P100", `A${String(index).padStart(3, "0")}`),
    );

  const management = new ProjectManagementService({ worker, accountId, gmUserId });
  const gm = { accountId, userId: gmUserId, isGm: true };
  const directory = createSqliteMobileProjectDirectoryStore({
    worker,
    scope: scope(projectId, actorId, "P100", "Z last member"),
  });
  assert.equal(
    (await directory.listProjects({ actorId, limit: 100 })).items.some((p) => p.id === projectId),
    false,
  );
  assert.equal(
    (await directory.listMembers({ actorId, projectId, limit: 100 })).items.some(
      (member) => member.userId === actorId,
    ),
    false,
  );
  const access = await directory.getProjectAccess({ actorId, projectId });
  assert.equal(access.actorName, "Z last member");
  assert.equal(access.projectKey, "P100");
  assert.equal(await directory.getProjectAccess({ actorId: gmUserId, projectId }), null);

  // The main runtime uses this same per-command GM capability; it must never
  // become a durable membership or authorize the following employee request.
  const projects = {
    ...directory,
    getProjectAccess: (query) =>
      worker.runWithRequestAuthorization(
        query.actorId === gmUserId ? { gm: { accountId, projectId, actorId: gmUserId } } : {},
        () => directory.getProjectAccess(query),
      ),
  };
  let enabled = true,
    externalCalls = 0;
  service = new ProductionTasks(
    {
      projectId,
      componentVersion: 1,
      externalProjectKey: "FIXTURE",
      gmUserId,
      stateRoot: join(root, "production"),
      endpoint: "https://relay.fixture.invalid",
      bearerToken: "fixture-only",
      qaInstanceId: "qa-fixture",
      canStart: async () => enabled,
    },
    { projects, bugs: {}, relay: {}, attachments: {} },
    async () => {
      externalCalls++;
      throw new Error("No external calls are allowed in this fixture");
    },
  );
  registerProductionRoutes(app, service, (request) => {
    const auth = request.headers.authorization;
    return auth === "Bearer employee" ? actorId : auth === "Bearer gm" ? gmUserId : null;
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const history = async (selected = projectId, token = "employee") => {
    const response = await fetch(`${base}/api/v1/production/batches?projectId=${selected}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await history()).status, 200);
  assert.equal((await history(projectId, "gm")).status, 200);
  assert.equal(
    await directory.getProjectAccess({ actorId: gmUserId, projectId }),
    null,
    "GM authorization remains transient",
  );
  assert.equal(
    (await history(projectIds[0])).status,
    403,
    "another accessible project cannot use this component instance",
  );
  assert.equal((await history(projectId, "invalid")).status, 401);

  enabled = false;
  const blocked = await fetch(`${base}/api/v1/production/tasks?projectId=${projectId}`, {
    headers: { authorization: "Bearer employee" },
  });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, "COMPONENT_DISABLED");
  assert.equal((await history()).status, 200, "disabled components retain local history");
  enabled = true;
  await management.execute(gm, {
    operation: "membership",
    projectId,
    userId: actorId,
    active: false,
    expectedVersion: 1,
  });
  const revoked = await history();
  assert.equal(revoked.status, 403);
  assert.equal(revoked.body.code, "PROJECT_FORBIDDEN");
  assert.equal((await history(projectId, "gm")).status, 200);
  assert.equal(
    (await directory.getProjectAccess({ actorId, projectId: projectIds[0] })).projectId,
    projectIds[0],
    "another active membership is preserved",
  );
  const selected = (await management.execute(gm, { operation: "list" })).items.find(
    (p) => p.id === projectId,
  );
  await management.execute(gm, {
    operation: "update",
    projectId,
    active: false,
    expectedVersion: selected.version,
  });
  assert.equal(
    (await history(projectId, "gm")).status,
    403,
    "GM also requires an active project for execution access",
  );
  assert.equal(externalCalls, 0);
});
