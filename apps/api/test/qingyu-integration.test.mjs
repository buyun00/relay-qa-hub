import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isActionableQingyuDefect, QingyuClient, QingyuError } from "../dist/qingyu-client.js";
import { createQingyuIntegration } from "../dist/qingyu-integration.js";
import { createApiApp } from "../dist/app.js";

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("QingyuClient uses Relay-proven QR, own-defect, detail, and resolve protocols", async () => {
  const calls = [];
  let transitionPosted = false;
  const client = new QingyuClient({
    baseUrl: "https://qingyu.example.test",
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      const body = init.body === undefined ? null : JSON.parse(init.body);
      calls.push({
        pathname: url.pathname,
        search: url.searchParams,
        method: init.method ?? "GET",
        body,
        authorization: init.headers?.Authorization,
      });
      if (url.pathname === "/api/auth/qr/home-generate") {
        return json({
          code: 0,
          data: { qr_id: "qr-1", poll_token: "poll-1", qr_content: "qingyu://qr-1" },
        });
      }
      if (url.pathname === "/api/auth/qr/home-status") {
        return json({ code: 0, data: { status: 2, ticket: "ticket-1", phone: "13800000000" } });
      }
      if (url.pathname === "/api/auth/qr/exchange") {
        return json({ code: 0, data: { token: "token-1", user: { id: 7, nickname: "测试用户" } } });
      }
      if (url.pathname === "/api/users/me") throw new Error("QR identity must be reused");
      if (url.pathname === "/api/tasks" && url.searchParams.has("page")) {
        return json({
          code: 0,
          data: { list: [{ id: 91, title: "按钮无响应", status_name: "处理中" }], total: 1 },
        });
      }
      if (url.pathname === "/api/tasks/91") {
        return json({
          code: 0,
          data: {
            id: 91,
            title: "按钮无响应",
            description: "点击后没有反应",
            reproduce_steps: "1. 打开页面\n2. 点击按钮",
            expected_result: "按钮正常响应",
            status_name: "处理中",
            version: 3,
          },
        });
      }
      if (url.pathname === "/api/tasks/91/bug-transitions") {
        return transitionPosted
          ? json({
              code: 0,
              data: { current_status: { key: "RESOLVED", name: "已解决" }, list: [] },
            })
          : json({
              code: 0,
              data: {
                current_status: { key: "IN_PROGRESS", name: "处理中" },
                list: [
                  { id: 12, to_status: { key: "RESOLVED", name: "已解决" }, required_fields: "" },
                ],
              },
            });
      }
      if (url.pathname === "/api/tasks/91/bug-transition") {
        transitionPosted = true;
        return json({ code: 0, data: {} });
      }
      throw new Error(`unexpected request ${url}`);
    },
  });

  const challenge = await client.startLogin();
  assert.equal(challenge.qrContent, "qingyu://qr-1");
  const login = await client.pollLogin(challenge);
  assert.equal(login.credentials.user.name, "测试用户");

  const listed = await client.listOwnDefects(login.credentials, "project-3");
  assert.equal(listed.defects.length, 1);
  assert.deepEqual(listed.defects[0].steps, ["打开页面", "点击按钮"]);
  assert.equal(listed.defects[0].expectedBehavior, "按钮正常响应");
  const taskCall = calls.find((call) => call.pathname === "/api/tasks" && call.search.has("page"));
  assert.equal(taskCall.search.get("type"), "bug");
  assert.equal(taskCall.search.get("assignee_id"), "7");
  assert.equal(taskCall.search.get("project_id"), "project-3");
  assert.equal(
    calls.some((call) => call.pathname === "/api/users/me"),
    false,
  );

  const resolved = await client.resolveDefect(login.credentials, {
    defectId: "91",
    externalProjectId: "project-3",
    expectedUserId: "7",
    expectedUserName: "测试用户",
  });
  assert.equal(resolved.status, "已解决");
  const transitionCall = calls.find((call) => call.pathname === "/api/tasks/91/bug-transition");
  assert.deepEqual(transitionCall.body, { transition_id: 12, version: 3 });
  assert.equal(transitionCall.authorization, "Bearer token-1");
});

test("QingyuClient does not invent missing defect details", async () => {
  const client = new QingyuClient({
    baseUrl: "https://qingyu.example.test",
    fetchImpl: async (input) => {
      const url = new URL(input);
      assert.equal(url.pathname, "/api/tasks/92");
      return json({ code: 0, data: { id: 92, title: "棋牌背包预览不对" } });
    },
  });

  const defect = await client.getDefect(
    { token: "token-1", user: { id: "7", name: "测试用户", avatar: null } },
    "92",
  );

  assert.equal(defect.description, "");
  assert.deepEqual(defect.steps, ["棋牌背包预览不对"]);
  assert.equal(defect.actualBehavior, "棋牌背包预览不对");
  assert.equal(JSON.stringify(defect).includes("未填写详细描述"), false);
});

test("Qingyu integration persists encrypted sessions, imports idempotently, and resolves linked Bug", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-hub-qingyu-"));
  const statePath = join(root, "qingyu.enc.json");
  const actorId = "10000000-0000-4000-8000-000000000003";
  const projectId = "10000000-0000-4000-8000-000000000004";
  const bugId = "20000000-0000-4000-8000-000000000001";
  const defect = {
    id: "91",
    code: "BUG-91",
    title: "按钮无响应",
    description: "点击后没有反应",
    steps: ["打开页面", "点击按钮"],
    actualBehavior: "没有反应",
    expectedBehavior: "按钮正常响应",
    status: "处理中",
    statusKey: "IN_PROGRESS",
    priority: "P1",
    severity: "S1",
    assignee: "测试用户",
    updatedAt: "2026-08-28T01:00:00.000Z",
    images: [],
    url: "https://qingyu.example.test/tasks/91",
  };
  let creationCalls = 0;
  let creationRequest = null;
  let resolveCalls = 0;
  let links = [];
  const fakeClient = {
    async startLogin() {
      return {
        qrId: "qr-1",
        pollToken: "poll-1",
        qrContent: "qingyu://qr-1",
        status: "pending",
        expiresAt: "2026-08-28T02:00:00.000Z",
      };
    },
    async pollLogin() {
      return {
        challenge: null,
        credentials: {
          token: "token-that-must-stay-encrypted",
          user: { id: "7", name: "测试用户", avatar: null },
        },
      };
    },
    async listProjects() {
      return [{ id: "project-3", name: "项目三" }];
    },
    async listOwnDefects() {
      return { defects: [defect], total: 1, user: { id: "7", name: "测试用户", avatar: null } };
    },
    async getDefect() {
      return defect;
    },
    async downloadImages() {
      return { images: [], skipped: 0 };
    },
    async resolveDefect(credentials, input) {
      resolveCalls += 1;
      assert.equal(credentials.user.id, input.expectedUserId);
      return { defectId: input.defectId, status: "已解决", alreadyResolved: resolveCalls > 1 };
    },
  };
  const mobileBugStore = {
    async createBug(command) {
      creationCalls += 1;
      creationRequest = command.request;
      return {
        clientSubmissionId: command.request.clientSubmissionId,
        qaItem: { type: "bug", id: bugId, key: "LOCAL-1" },
        disposition: "created",
        bug: {
          id: bugId,
          projectId,
          number: 1,
          key: "LOCAL-1",
          title: command.request.title,
          description: command.request.description,
          expectedBehavior: command.request.expectedBehavior,
          moduleId: null,
          state: "reported",
          severity: command.request.severity,
          priority: command.request.priority,
          reporterId: actorId,
          ownerId: actorId,
          verificationOwnerId: actorId,
          duplicateOfBugId: null,
          occurrenceCount: 1,
          reopenCount: 0,
          version: 1,
          createdAt: "2026-08-28T01:00:00.000Z",
          updatedAt: "2026-08-28T01:00:00.000Z",
          closedAt: null,
        },
        occurrenceId: "30000000-0000-4000-8000-000000000001",
        attachmentIds: [],
        captureBundleId: null,
        eventId: "40000000-0000-4000-8000-000000000001",
        replayed: creationCalls > 1,
      };
    },
    async getBug() {
      return null;
    },
    async listBugs() {
      throw new Error("not used");
    },
    async updateBug() {
      throw new Error("not used");
    },
  };
  const unusedAttachmentStore = new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error("attachment store must not be used");
        };
      },
    },
  );
  const linkStore = {
    async getBugLink(requestedBugId) {
      return links.find((item) => item.bugId === requestedBugId) ?? null;
    },
    async getByExternal(externalProjectId, defectId) {
      return (
        links.find(
          (item) => item.externalProjectId === externalProjectId && item.defectId === defectId,
        ) ?? null
      );
    },
    async put(link) {
      const stored = { ...link, version: 1 };
      links = [...links, stored];
      return stored;
    },
    async updateSync(link, values) {
      const updated = { ...link, ...values, version: link.version + 1 };
      links = links.map((item) => (item.bugId === link.bugId ? updated : item));
      return updated;
    },
  };
  const create = () =>
    createQingyuIntegration({
      statePath,
      secret: "0123456789abcdef0123456789abcdef",
      qaProjectId: projectId,
      mobileBugStore,
      mobileAttachmentStore: unusedAttachmentStore,
      linkStore,
      client: fakeClient,
      now: () => new Date("2026-08-28T01:00:00.000Z"),
    });

  let integration = await create();
  await integration.startLogin(actorId);
  const session = await integration.pollLogin(actorId);
  assert.equal(session.authenticated, true);
  const imported = await integration.importOwnDefects(actorId, "project-3");
  assert.equal(imported.items[0].status, "created");
  assert.equal(creationCalls, 1);
  assert.equal(creationRequest.title, "[轻语] 按钮无响应 点击后没有反应");
  assert.equal(creationRequest.description, "[轻语] 按钮无响应 点击后没有反应");
  assert.equal(creationRequest.description.includes("qingyu.example.test"), false);
  assert.equal(creationRequest.description.includes("轻语编号"), false);
  assert.equal(creationRequest.description.includes("导入时状态"), false);
  assert.equal((await integration.getBugLink(bugId)).defectId, "91");

  const encrypted = await readFile(statePath, "utf8");
  assert.equal(encrypted.includes("token-that-must-stay-encrypted"), false);
  assert.equal(encrypted.includes("按钮无响应"), false);

  integration = await create();
  assert.equal(integration.session(actorId).authenticated, true);
  const replay = await integration.importOwnDefects(actorId, "project-3", ["91"]);
  assert.equal(replay.items[0].status, "already_imported");
  assert.equal(creationCalls, 1);

  const sync = await integration.beforeHumanClose(actorId, bugId);
  assert.equal(sync.link.syncStatus, "succeeded");
  assert.equal(resolveCalls, 1);
  assert.equal((await integration.getBugLink(bugId)).externalStatus, "已解决");
  assert.equal(isActionableQingyuDefect({ status: "已解决", statusKey: "RESOLVED" }), false);
});

test("unassigned project member resolves Qingyu and closes without identity checks", async () => {
  const actorId = "10000000-0000-4000-8000-000000000003";
  const bugId = "20000000-0000-4000-8000-000000000001";
  const verificationId = "30000000-0000-4000-8000-000000000001";
  const order = [];
  let failExternal = true;
  const verification = {
    id: verificationId,
    bugId,
    repairAttemptId: "40000000-0000-4000-8000-000000000001",
    buildId: null,
    status: "in_progress",
    verifierId: actorId,
    criteriaSnapshot: "确认修复",
    resultSummary: null,
    failureReason: null,
    blockedReason: null,
    version: 2,
  };
  const bug = {
    id: bugId,
    projectId: "10000000-0000-4000-8000-000000000004",
    number: 1,
    key: "LOCAL-1",
    title: "按钮无响应",
    description: "点击后没有反应",
    expectedBehavior: "按钮正常响应",
    moduleId: null,
    state: "ready_for_verification",
    severity: "S1",
    priority: "P1",
    reporterId: "10000000-0000-4000-8000-000000000009",
    ownerId: actorId,
    verificationOwnerId: "10000000-0000-4000-8000-000000000008",
    duplicateOfBugId: null,
    occurrenceCount: 1,
    reopenCount: 0,
    version: 5,
    createdAt: "2026-08-28T01:00:00.000Z",
    updatedAt: "2026-08-28T01:00:00.000Z",
    closedAt: null,
  };
  const app = createApiApp({
    logger: false,
    mobileBugStore: {
      async getBug() {
        return bug;
      },
      async createBug() {
        throw new Error("not used");
      },
      async listBugs() {
        throw new Error("not used");
      },
      async updateBug() {
        throw new Error("not used");
      },
    },
    mobileVerificationStore: {
      async getVerification() {
        return verification;
      },
      async recordResult() {
        order.push("local");
        return {
          bug: { ...bug, state: "closed" },
          verification: { ...verification, status: "passed" },
          repairAttempt: null,
          eventId: "50000000-0000-4000-8000-000000000001",
          replayed: false,
        };
      },
      async createVerification() {
        throw new Error("not used");
      },
      async startVerification() {
        throw new Error("not used");
      },
    },
    qingyuIntegration: {
      async beforeHumanClose() {
        order.push("qingyu");
        if (failExternal)
          throw new QingyuError(409, "QINGYU_RESOLUTION_NOT_VERIFIED", "轻语没有确认已解决");
        return null;
      },
      session() {
        throw new Error("not used");
      },
      startLogin() {
        throw new Error("not used");
      },
      pollLogin() {
        throw new Error("not used");
      },
      logout() {
        throw new Error("not used");
      },
      listProjects() {
        throw new Error("not used");
      },
      listOwnDefects() {
        throw new Error("not used");
      },
      importOwnDefects() {
        throw new Error("not used");
      },
      getBugLink() {
        return null;
      },
    },
  });
  const request = () =>
    app.inject({
      method: "POST",
      url: `/api/v1/verifications/${verificationId}/result`,
      headers: {
        authorization: "Bearer relay-qa-hub-local-debug",
        "content-type": "application/vnd.relay-qa-hub.v1.1+json",
        "idempotency-key": `workflow:recordVerificationResult:verification:${verificationId}:v2`,
      },
      payload: {
        submissionContractVersion: "1.1.0",
        clientSubmissionId: "60000000-0000-4000-8000-000000000001",
        expectedVersion: 2,
        status: "passed",
        resultSummary: "确认修复有效",
        attachmentIds: [],
      },
    });

  const failed = await request();
  assert.equal(failed.statusCode, 409);
  assert.equal(failed.json().code, "QINGYU_RESOLUTION_NOT_VERIFIED");
  assert.deepEqual(order, ["qingyu"]);

  failExternal = false;
  const succeeded = await request();
  assert.equal(succeeded.statusCode, 200);
  assert.deepEqual(order, ["qingyu", "qingyu", "local"]);
  await app.close();
});
