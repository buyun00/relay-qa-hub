import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { SqliteStorageWorker, projectMembershipId } from "@relay-qa-hub/storage";
import {
  registerBrowserAuthRoutes,
  createSqliteBrowserAuthStore,
  authenticateBrowserRequest,
  authenticateBrowserBearerRequest,
} from "../dist/browser-auth.js";
import {
  ProjectManagementService,
  registerProjectManagementRoutes,
} from "../dist/project-management.js";
import { createApiApp } from "../dist/app.js";
import { ProjectRequestContext } from "../dist/project-request-context.js";
import { createSqliteMobileBugStore } from "../dist/sqlite-mobile-bug-store.js";
import { createSqliteMobileProjectDirectoryStore } from "../dist/sqlite-mobile-project-directory-store.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createSqliteMobileRelayStore } from "../dist/sqlite-mobile-relay-store.js";
import { createSqliteMobileVerificationStore } from "../dist/sqlite-mobile-verification-store.js";
import { createSqliteMobileCommentStore } from "../dist/sqlite-mobile-comment-store.js";
import { createSqliteMobileHumanWorkflowStore } from "../dist/sqlite-mobile-human-workflow-store.js";
import { exerciseGmBusinessLoop } from "../../../scripts/project-components/gm-business-loop.mjs";

test("real HTTP project name login, protected GM identity, scoped membership and isolated cookie", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qa-project-management-http-"));
  const worker = new SqliteStorageWorker({
    databaseFile: join(directory, "test.sqlite"),
    busyTimeoutMs: 1000,
    backupRoot: join(directory, "backups"),
  });
  const app = Fastify();
  const accountId = "78000000-0000-4000-8000-000000000001";
  const gmUserId = "78000000-0000-4000-8000-000000000002";
  const projectId = "78000000-0000-4000-8000-000000000003";
  const now = "2026-09-09T02:00:00.000Z";
  try {
    await worker.ensureMobileScope({
      accountId,
      projectId,
      projectKey: "HTTPA",
      projectName: "HTTP 项目 A",
      actorId: gmUserId,
      actorDisplayName: "唯一管理者",
      membershipId: projectMembershipId(projectId, gmUserId),
      createdAt: now,
    });
    const service = new ProjectManagementService({ accountId, gmUserId, worker });
    const origins = [];
    const auth = {
      store: createSqliteBrowserAuthStore({ worker }),
      accountId,
      userId: gmUserId,
      actorId: gmUserId,
      adminEmail: "unused@example.invalid",
      passwordlessLogin: async () => {
        throw new Error("unscoped login must not be called");
      },
      projectLogin: (name, selected, stamp) => service.login(name, selected, stamp),
      sessionSecret: "test-independent-session-secret",
      cookieName: "qa-hub-project-preview-session",
      webOrigins: origins,
      secureCookie: false,
      gm: { userId: gmUserId, password: "independent-test-gm-password" },
    };
    registerBrowserAuthRoutes(app, auth);
    registerProjectManagementRoutes(
      app,
      service,
      async (request, reply) =>
        (await authenticateBrowserBearerRequest(request, auth)) ??
        (await authenticateBrowserRequest(request, reply, auth)),
    );
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    origins.push(baseUrl);
    const request = async (path, options = {}) => {
      const response = await fetch(`${baseUrl}${path}`, options);
      const data = await response.json();
      return { response, data };
    };
    const json = (body, token, method = "POST") => ({
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    assert.equal((await request(`/api/v1/project-entry/${projectId}`)).data.name, "HTTP 项目 A");
    assert.equal((await request("/api/v1/project-entry/httpa")).data.id, projectId);
    assert.equal((await request("/api/v1/gm/projects")).response.status, 401);
    assert.equal(
      (await request("/api/v1/auth/login", json({ name: "王测试", client: "android" }))).data.code,
      "PROJECT_REQUIRED",
    );
    assert.equal(
      (
        await request(
          "/api/v1/auth/login",
          json({ projectId, name: "唯一管理者", client: "android" }),
        )
      ).data.code,
      "GM_PASSWORD_REQUIRED",
    );
    const employee = await request(
      "/api/v1/auth/login",
      json({ projectId, name: "王测试", client: "android" }),
    );
    assert.equal(employee.response.status, 200);
    assert.equal(employee.data.projectId, projectId);
    assert.equal(employee.data.isGm, false);
    assert.equal(
      (
        await request("/api/v1/gm/projects", {
          headers: { authorization: `Bearer ${employee.data.accessToken}` },
        })
      ).response.status,
      403,
    );
    const gm = await request(
      "/api/v1/auth/gm/login",
      json({ password: "independent-test-gm-password", client: "android" }),
    );
    assert.equal(gm.response.status, 200);
    assert.equal(gm.data.userId, gmUserId);
    assert.equal(gm.data.isGm, true);
    const created = await request(
      "/api/v1/gm/projects",
      json({ key: "HTTPB", name: "HTTP 项目 B" }, gm.data.accessToken),
    );
    assert.equal(created.response.status, 200);
    const bId = created.data.id;
    const assign = await request(
      `/api/v1/gm/projects/${bId}/members/${employee.data.userId}`,
      json({ active: true, expectedVersion: 0 }, gm.data.accessToken, "PUT"),
    );
    assert.equal(assign.response.status, 200);
    const disabled = await request(
      `/api/v1/gm/projects/${projectId}/members/${employee.data.userId}`,
      json({ active: false, expectedVersion: 1 }, gm.data.accessToken, "PUT"),
    );
    assert.equal(disabled.response.status, 200);
    assert.equal(
      (
        await request(
          "/api/v1/auth/login",
          json({ projectId, name: "wangceshi", client: "android" }),
        )
      ).data.code,
      "PROJECT_MEMBERSHIP_DISABLED",
    );
    const bLogin = await request(
      "/api/v1/auth/login",
      json({ projectId: bId, name: "wangceshi", client: "android" }),
    );
    assert.equal(bLogin.data.userId, employee.data.userId);
    assert.equal(
      (
        await request(`/api/v1/projects/${projectId}/components`, {
          headers: { authorization: `Bearer ${employee.data.accessToken}` },
        })
      ).response.status,
      403,
    );
    const settings = await request(
      `/api/v1/projects/${bId}/components/build`,
      json(
        {
          enabled: true,
          expectedVersion: 0,
          config: { baseUrl: "https://example.invalid", job: "PREVIEW", password: "DO-NOT-RETURN" },
        },
        gm.data.accessToken,
        "PUT",
      ),
    );
    assert.equal(settings.response.status, 200);
    assert.equal(JSON.stringify(settings.data).includes("DO-NOT-RETURN"), false);
    const webLogin = await request("/api/v1/auth/login", {
      ...json({ projectId: bId, name: "王测试", client: "web" }),
      headers: { "content-type": "application/json", origin: baseUrl },
    });
    const cookie = webLogin.response.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, /^qa-hub-project-preview-session=/u);
    assert.equal(
      (
        await request("/api/v1/auth/me", {
          headers: { cookie: "qa_hub_browser_session=" + cookie.split("=")[1] },
        })
      ).response.status,
      401,
    );
    assert.equal((await request("/api/v1/auth/me", { headers: { cookie } })).data.projectId, bId);
    assert.equal(
      (
        await request("/api/v1/auth/logout", {
          method: "POST",
          headers: { cookie, origin: baseUrl, "x-csrf-token": webLogin.data.csrfToken },
        })
      ).response.status,
      200,
    );
    assert.equal((await request("/api/v1/auth/me", { headers: { cookie } })).response.status, 401);
    assert.equal(
      (
        await request("/api/v1/auth/me", {
          headers: { authorization: `Bearer ${bLogin.data.accessToken}` },
        })
      ).data.projectId,
      bId,
    );
  } finally {
    await app.close();
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual API isolates concurrent users, explicit project headers and record-derived project context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qa-project-concurrent-http-"));
  const worker = new SqliteStorageWorker({
    databaseFile: join(directory, "test.sqlite"),
    busyTimeoutMs: 1000,
    backupRoot: join(directory, "backups"),
  });
  let app;
  const accountId = "79000000-0000-4000-8000-000000000001";
  const gmUserId = "79000000-0000-4000-8000-000000000002";
  const aId = "79000000-0000-4000-8000-000000000003";
  const bId = "79000000-0000-4000-8000-000000000004";
  const now = "2026-09-09T02:00:00.000Z";
  try {
    const bootstrap = {
      accountId,
      projectId: aId,
      projectKey: "CONA",
      actorId: gmUserId,
      actorDisplayName: "GM",
      membershipId: projectMembershipId(aId, gmUserId),
      createdAt: now,
    };
    await worker.ensureMobileScope(bootstrap);
    await worker.projectManagement({
      accountId,
      actorId: gmUserId,
      isGm: true,
      operation: "create",
      projectId: bId,
      key: "CONB",
      name: "并发项目 B",
      now,
    });
    const service = new ProjectManagementService({ accountId, gmUserId, worker });
    const context = new ProjectRequestContext();
    const scope = context.scope(bootstrap);
    app = createApiApp({
      logger: false,
      isolateLegacyComponents: true,
      projectManagementService: service,
      projectRequestContext: context,
      mobileBugStore: createSqliteMobileBugStore({ worker, scope }),
      mobileProjectDirectoryStore: createSqliteMobileProjectDirectoryStore({ worker, scope }),
      mobileRelayStore: createSqliteMobileRelayStore({
        worker,
        scope,
        relayDispatchEnabled: false,
      }),
      mobileVerificationStore: createSqliteMobileVerificationStore({ worker, scope }),
      mobileCommentStore: createSqliteMobileCommentStore({ worker, scope }),
      mobileHumanWorkflowStore: createSqliteMobileHumanWorkflowStore({ worker, scope }),
      browserAuth: {
        store: createSqliteBrowserAuthStore({ worker }),
        accountId,
        userId: gmUserId,
        actorId: gmUserId,
        adminEmail: "unused@example.invalid",
        passwordlessLogin: async () => {
          throw new Error("unscoped login is forbidden");
        },
        projectLogin: (name, selected, stamp) => service.login(name, selected, stamp),
        sessionSecret: "concurrent-test-session-secret",
        cookieName: "qa_hub_concurrent_preview_session",
        webOrigins: [],
        gm: { userId: gmUserId, password: "concurrent-gm-test-password" },
      },
    });
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = async (path, token, body, extraHeaders = {}) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...extraHeaders,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, data: await response.json() };
    };
    const [alice, bob] = await Promise.all([
      request("/api/v1/auth/login", null, { projectId: aId, name: "并发甲", client: "android" }),
      request("/api/v1/auth/login", null, { projectId: bId, name: "并发乙", client: "android" }),
    ]);
    assert.equal(alice.status, 200);
    assert.equal(bob.status, 200);
    const a = alice.data.accessToken;
    const b = bob.data.accessToken;
    const draft = (projectId, index) => ({
      submissionContractVersion: "1.1.0",
      projectId,
      clientSubmissionId: randomUUID(),
      title: `并发测试 ${index}`,
      description: "独立项目并发",
      expectedBehavior: "请求正确归属",
      severity: "S2",
      priority: "P2",
      occurrence: { observedAt: now, platform: "web", steps: ["提交"], actualBehavior: "pending" },
      attachmentIds: [],
    });
    const creations = await Promise.all(
      Array.from({ length: 16 }, async (_, index) => {
        const projectId = index % 2 ? bId : aId;
        const token = index % 2 ? b : a;
        const body = draft(projectId, index);
        const result = await request("/api/v1/bugs", token, body, {
          "idempotency-key": `submission:${body.clientSubmissionId}:commit`,
        });
        assert.equal(result.status, 201, JSON.stringify(result.data));
        assert.equal(result.data.bug.projectId, projectId);
        return result.data.bug;
      }),
    );
    const [aBugs, bBugs] = await Promise.all([
      request("/api/v1/bugs", a),
      request("/api/v1/bugs", b),
    ]);
    assert.equal(aBugs.data.items.length, 8);
    assert.equal(bBugs.data.items.length, 8);
    assert.ok(aBugs.data.items.every((item) => item.projectId === aId));
    assert.ok(bBugs.data.items.every((item) => item.projectId === bId));
    assert.equal((await request(`/api/v1/bugs/${creations[1].id}`, a)).status, 403);
    assert.equal(
      (await request(`/api/v1/bugs/${creations[1].id}`, b, undefined, { "x-qa-project-id": aId }))
        .status,
      404,
    );
    assert.equal(
      (await request(`/api/v1/bugs?projectId=${aId}`, a, undefined, { "x-qa-project-id": bId }))
        .status,
      400,
    );
    // The same old A login may access a B record after explicit membership assignment;
    // no global session project is switched or rewritten.
    await worker.projectManagement({
      operation: "membership",
      accountId,
      actorId: gmUserId,
      isGm: true,
      projectId: bId,
      userId: alice.data.userId,
      active: true,
      expectedVersion: 0,
      now: new Date().toISOString(),
    });
    const derived = await request(`/api/v1/bugs/${creations[1].id}`, a);
    assert.equal(derived.status, 200);
    assert.equal(derived.data.projectId, bId);
    const [fromA, fromB] = await Promise.all([
      request("/api/v1/bugs", a, undefined, { "x-qa-project-id": aId }),
      request("/api/v1/bugs", a, undefined, { "x-qa-project-id": bId }),
    ]);
    assert.ok(fromA.data.items.every((item) => item.projectId === aId));
    assert.ok(fromB.data.items.every((item) => item.projectId === bId));
    const gmLogin = await request("/api/v1/auth/gm/login", null, {
      password: "concurrent-gm-test-password",
      client: "android",
    });
    assert.equal(gmLogin.status, 200);
    for (const projectId of [aId, bId])
      await worker.projectManagement({
        operation: "membership",
        accountId,
        actorId: gmUserId,
        isGm: true,
        projectId,
        userId: gmUserId,
        active: false,
        expectedVersion: 1,
        now,
      });
    const gmToken = gmLogin.data.accessToken;
    await exerciseGmBusinessLoop(
      async (label, method, path, options = {}) => {
        const response = await fetch(baseUrl + path, {
          method,
          headers: {
            authorization: `Bearer ${options.token}`,
            "x-qa-project-id": options.projectId,
            accept: "application/vnd.relay-qa-hub.v1.1+json",
            ...(options.body ? { "content-type": "application/json" } : {}),
            ...(options.key ? { "idempotency-key": options.key } : {}),
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        });
        const result = await response.json();
        assert.equal(
          response.status,
          options.expected ?? 200,
          `${label}: ${JSON.stringify(result)}`,
        );
        return result;
      },
      { token: gmToken, projectId: aId, userId: gmUserId },
    );
    const mixed = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const projectId = index % 2 ? bId : aId;
        if (index % 3 === 0) return request(`/api/v1/bugs?projectId=${aId}`, b);
        const body = {
          ...draft(projectId, `gm-${index}`),
          ownerId: gmUserId,
          verificationOwnerId: gmUserId,
        };
        return request("/api/v1/bugs", gmToken, body, {
          "idempotency-key": `submission:${body.clientSubmissionId}:commit`,
        });
      }),
    );
    mixed.forEach((result, index) =>
      assert.equal(result.status, index % 3 === 0 ? 403 : 201, JSON.stringify(result.data)),
    );
    assert.equal((await request(`/api/v1/bugs?projectId=${aId}`, gmToken)).status, 200);
    const members = await request(`/api/v1/projects/${aId}/members`, gmToken);
    assert.equal(members.status, 200);
    assert.ok(members.data.items.every((item) => item.userId !== gmUserId));
    const broken = { ...draft(aId, "gm-rollback"), ownerId: randomUUID() };
    assert.equal(
      (
        await request("/api/v1/bugs", gmToken, broken, {
          "idempotency-key": `submission:${broken.clientSubmissionId}:commit`,
        })
      ).status,
      400,
    );
    const gmContext = { gm: { accountId, projectId: aId, actorId: gmUserId } };
    const pending = worker.runWithRequestAuthorization(gmContext, () =>
      worker.listMobileBugs({ accountId, projectId: aId, actorId: gmUserId, limit: 100 }),
    );
    await Promise.resolve();
    gmContext.gm = { accountId, projectId: bId, actorId: gmUserId };
    assert.ok((await pending).items.every((item) => item.projectId === aId));
    await assert.rejects(
      worker.runWithRequestAuthorization(gmContext, () =>
        worker.listMobileBugs({ accountId, projectId: aId, actorId: gmUserId, limit: 100 }),
      ),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      worker.listMobileBugs({ accountId, projectId: aId, actorId: gmUserId, limit: 100 }),
      { code: "FORBIDDEN" },
    );
    const inspect = new DatabaseSync(join(directory, "test.sqlite"), { readOnly: true });
    try {
      assert.equal(
        inspect.prepare("SELECT COUNT(*) AS n FROM storage_command_authorizations").get().n,
        0,
      );
      assert.equal(
        inspect
          .prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND status = 'active'")
          .get(gmUserId).n,
        0,
      );
    } finally {
      inspect.close();
    }
    assert.throws(() => scope.projectId, { code: "PROJECT_REQUIRED" });
  } finally {
    if (app) await app.close();
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
