import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { SqliteStorageWorker, projectMembershipId } from "@relay-qa-hub/storage";
import {
  authenticateBrowserBearerRequest,
  authenticateBrowserRequest,
  createSqliteBrowserAuthStore,
  registerBrowserAuthRoutes,
} from "../dist/browser-auth.js";
import {
  ProjectManagementService,
  registerProjectManagementRoutes,
} from "../dist/project-management.js";
import { ProjectRequestContext } from "../dist/project-request-context.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("project request context permits anonymous initialization routes", async () => {
  const app = Fastify({ logger: false });
  const context = new ProjectRequestContext();
  context.register(app, {
    options: {
      worker: {
        runWithRequestAuthorization: (_authorization, done) => done(),
      },
    },
    execute: async () => {
      throw new Error("public initialization must not resolve a project session");
    },
  });
  app.post("/api/v1/project-initialization/inspect", async () => ({ ok: true }));
  app.post("/api/v1/project-initialization/complete", async () => ({ ok: true }));
  try {
    for (const path of [
      "/api/v1/project-initialization/inspect",
      "/api/v1/project-initialization/complete",
    ]) {
      const response = await app.inject({ method: "POST", url: path, payload: {} });
      assert.equal(response.statusCode, 200);
    }
  } finally {
    await app.close();
  }
});

test("LAN onboarding keeps secrets scoped and name-code join is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qa-project-onboarding-http-"));
  const worker = new SqliteStorageWorker({
    databaseFile: join(directory, "test.sqlite"),
    busyTimeoutMs: 1_000,
    backupRoot: join(directory, "backups"),
  });
  const app = Fastify({ logger: false });
  const accountId = "7a000000-0000-4000-8000-000000000001";
  const gmUserId = "7a000000-0000-4000-8000-000000000002";
  const legacyProjectId = "7a000000-0000-4000-8000-000000000003";
  const now = "2026-09-11T06:00:00.000Z";
  try {
    await worker.ensureMobileScope({
      accountId,
      projectId: legacyProjectId,
      projectKey: "LEGACY",
      projectName: "历史项目",
      actorId: gmUserId,
      actorDisplayName: "唯一 GM",
      membershipId: projectMembershipId(legacyProjectId, gmUserId),
      createdAt: now,
    });
    const service = new ProjectManagementService({
      accountId,
      gmUserId,
      worker,
      onboardingSecret: "onboarding-test-secret-that-is-long-enough",
      publicWebBaseUrl: "http://10.100.5.157:4774",
    });
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
      projectCodeLogin: (name, projectName, code, stamp, clientKey) =>
        service.joinWithCode(name, projectName, code, stamp, clientKey),
      sessionSecret: "independent-browser-session-secret",
      cookieName: "qa-hub-lan-test-session",
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
      return { response, data: await response.json() };
    };
    const json = (value, token) => ({
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(value),
    });

    const gm = await request(
      "/api/v1/auth/gm/login",
      json({ password: "independent-test-gm-password", client: "android" }),
    );
    assert.equal(gm.response.status, 200);
    assert.equal((await request(`/api/v1/project-entry/${legacyProjectId}`)).response.status, 404);

    const created = await request("/api/v1/gm/projects", json({}, gm.data.accessToken));
    assert.equal(created.response.status, 200);
    assert.equal(created.data.initializationStatus, "pending");
    assert.match(created.data.joinCode, /^\d{4}$/u);
    assert.match(created.data.initializationLink, /\/#initialize=/u);
    assert.equal(JSON.stringify(created.data).includes("Ciphertext"), false);
    assert.equal(JSON.stringify(created.data).includes("Digest"), false);
    const token = decodeURIComponent(created.data.initializationLink.split("#initialize=")[1]);

    const inspected = await request("/api/v1/project-initialization/inspect", json({ token }));
    assert.equal(inspected.data.id, created.data.id);
    assert.equal(inspected.data.joinCode, created.data.joinCode);
    const initialization = {
      token,
      name: "  项目　Alpha  ",
      initialMembers: [" 王小明 ", "王小明", "李四"],
      logo: { mediaType: "image/png", dataBase64: PNG_1X1 },
    };
    const completed = await request(
      "/api/v1/project-initialization/complete",
      json(initialization),
    );
    assert.equal(completed.response.status, 200);
    assert.equal(completed.data.joinName, "项目 Alpha");
    assert.equal(completed.data.initializationStatus, "ready");
    assert.equal(completed.data.logo.mediaType, "image/png");
    const rotateCompleted = await request(
      `/api/v1/gm/projects/${created.data.id}/initialization-link/rotate`,
      json({}, gm.data.accessToken),
    );
    assert.equal(rotateCompleted.response.status, 409);
    const replay = await request("/api/v1/project-initialization/complete", json(initialization));
    assert.equal(replay.response.status, 409);
    assert.equal(
      (await request("/api/v1/project-initialization/inspect", json({ token }))).response.status,
      404,
    );
    const gmAfterInitialization = await request("/api/v1/gm/projects", {
      headers: { authorization: `Bearer ${gm.data.accessToken}` },
    });
    const completedAdminRecord = gmAfterInitialization.data.items.find(
      (item) => item.id === created.data.id,
    );
    assert.equal(completedAdminRecord.initializationLink, null);
    assert.equal(completedAdminRecord.joinCode, created.data.joinCode);
    assert.equal(
      (
        await request(
          "/api/v1/project-initialization/complete",
          json({ ...initialization, name: "另一个名称" }),
        )
      ).response.status,
      409,
    );

    const failed = await request(
      "/api/v1/auth/login",
      json({ projectName: "项目 Alpha", code: "9999", name: "新员工", client: "android" }),
    );
    assert.equal(failed.response.status, 401);
    assert.deepEqual(failed.data, { code: "AUTHENTICATION_FAILED" });
    const missing = await request(
      "/api/v1/auth/login",
      json({ projectName: "不存在", code: "9999", name: "新员工", client: "android" }),
    );
    assert.equal(missing.response.status, 401);
    assert.deepEqual(missing.data, failed.data);
    const joined = await request(
      "/api/v1/auth/login",
      json({
        projectName: "项目 alpha",
        code: created.data.joinCode,
        name: "新员工",
        client: "android",
      }),
    );
    assert.equal(joined.response.status, 200);
    assert.equal(joined.data.projectId, created.data.id);
    const logo = await fetch(`${baseUrl}/api/v1/projects/${created.data.id}/logo`, {
      headers: {
        authorization: `Bearer ${joined.data.accessToken}`,
        "x-qa-project-id": created.data.id,
      },
    });
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await logo.arrayBuffer()), Buffer.from(PNG_1X1, "base64"));
    const repeated = await request(
      "/api/v1/auth/login",
      json({
        projectName: " 项目 Alpha ",
        code: created.data.joinCode,
        name: " 新员工 ",
        client: "android",
      }),
    );
    assert.equal(repeated.data.userId, joined.data.userId);
    assert.equal(
      (
        await request(
          "/api/v1/auth/login",
          json({ projectId: created.data.id, name: "绕过", client: "android" }),
        )
      ).response.status,
      400,
    );

    const reset = await request(
      `/api/v1/gm/projects/${created.data.id}/join-code/reset`,
      json({}, gm.data.accessToken),
    );
    assert.equal(reset.response.status, 200);
    assert.match(reset.data.joinCode, /^\d{4}$/u);
    assert.notEqual(reset.data.joinCodeVersion, created.data.joinCodeVersion);
    assert.equal(
      (
        await request(
          "/api/v1/auth/login",
          json({
            projectName: "项目 Alpha",
            code: created.data.joinCode,
            name: "重置后员工",
            client: "android",
          }),
        )
      ).response.status,
      401,
    );
    assert.equal(
      (
        await request(
          "/api/v1/auth/login",
          json({
            projectName: "项目 Alpha",
            code: reset.data.joinCode,
            name: "重置后员工",
            client: "android",
          }),
        )
      ).response.status,
      200,
    );
    const listed = await request("/api/v1/gm/projects", {
      headers: { authorization: `Bearer ${gm.data.accessToken}` },
    });
    assert.equal(listed.response.status, 200);
    assert.equal(
      listed.data.items.find((item) => item.id === created.data.id).joinCode,
      reset.data.joinCode,
    );
    assert.equal(JSON.stringify(listed.data).includes("joinCodeDigest"), false);
    assert.equal(JSON.stringify(listed.data).includes("initializationTokenCiphertext"), false);
  } finally {
    await app.close();
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
