import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProductionTasks, registerProductionRoutes } from "../dist/production-tasks.js";
import Fastify from "fastify";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-production-"));
  const bugs = new Map(
    Array.from({ length: 8 }, (_, i) => [
      `bug-${i}`,
      {
        id: `bug-${i}`,
        projectId: "project-1",
        key: `LOCAL-${i + 1}`,
        title: `Bug ${i}`,
        state: "reported",
        ownerId: "user-1",
        version: 1,
      },
    ]),
  );
  const calls = [],
    mutations = new Map(),
    tasks = [],
    attempts = new Map();
  let failBug = "bug-3",
    failCreate = true;
  const once = (operation, input, effect) => {
    const key = input.idempotencyKey;
    calls.push({ operation, input });
    const previous = mutations.get(key);
    if (previous) {
      assert.deepEqual(input, previous.input);
      return previous.result;
    }
    const result = effect();
    mutations.set(key, { input: structuredClone(input), result: structuredClone(result) });
    return result;
  };
  const stores = {
    projects: {
      listProjects: async ({ actorId }) => ({
        items:
          actorId === "outsider"
            ? []
            : [
                {
                  id: "project-1",
                  key: "LOCAL",
                  roles: actorId === "viewer" ? ["viewer"] : ["developer"],
                },
              ],
      }),
      listMembers: async () => ({
        items: [
          { userId: "user-1", displayName: "开发" },
          { userId: "viewer", displayName: "观察" },
        ],
      }),
    },
    attachments: { listBugAttachments: async () => ({ items: [{ attachmentId: "proof" }] }) },
    bugs: {
      getBug: async ({ bugId }) => structuredClone(bugs.get(bugId) ?? null),
      updateBug: async (input) =>
        once("owner", input, () => {
          const bug = bugs.get(input.bugId);
          Object.assign(bug, { ownerId: input.request.ownerId, version: bug.version + 1 });
          return structuredClone(bug);
        }),
    },
    relay: {
      transitionBugReady: async (input) =>
        once("ready", input, () => {
          const bug = bugs.get(input.bugId);
          assert.equal(bug.version, input.request.expectedVersion);
          bug.state = "ready";
          bug.version++;
          return structuredClone(bug);
        }),
      createRelayAttempt: async (input) =>
        once("attempt", input, () => {
          if (input.bugId === failBug)
            throw Object.assign(new Error("fixture rejected this bug"), {
              code: "FIXTURE_REJECTED",
            });
          const attempt = { id: `attempt-${input.bugId}`, version: 1 };
          attempts.set(attempt.id, input.bugId);
          return attempt;
        }),
      dispatchRelay: async (input) =>
        once("dispatch", input, () => ({
          repairAttemptId: input.attemptId,
          handoffId: input.request.handoffId,
          status: "queued",
        })),
      getRelayReceipt: async () => null,
      continueRelay: async (input) =>
        once("continue", input, () => ({ status: "queued", repairAttemptId: input.attemptId })),
    },
  };
  const fetcher = async (value, options) => {
    const url = new URL(value);
    assert.equal(url.origin, "http://127.0.0.1:4317");
    assert.ok(options.signal);
    if (url.pathname.endsWith("/project"))
      return Response.json({ project: { enabled: true }, models: { "gpt-5.6-sol": ["xhigh"] } });
    if (options.method === "GET" && url.pathname.endsWith("/tasks"))
      return Response.json({ items: tasks });
    if (options.method === "GET")
      return Response.json({ task: tasks.find((t) => url.pathname.endsWith(t.id)) });
    const input = JSON.parse(options.body);
    const key = input.requestId;
    calls.push({ operation: "remote", input });
    if (mutations.has(key)) return Response.json(mutations.get(key).result);
    const result = { taskId: `task-${tasks.length + 1}`, turnId: "turn-1" };
    tasks.push({
      id: result.taskId,
      status: "queued",
      bugId: null,
      updatedAt: "2026-09-04T00:00:00Z",
    });
    mutations.set(key, { input, result });
    if (failCreate) {
      failCreate = false;
      throw new Error("response lost after server created task");
    }
    return Response.json(result);
  };
  const config = {
    stateRoot: root,
    endpoint: "http://127.0.0.1:4317",
    bearerToken: "fixture-only",
    qaInstanceId: "qa-local",
  };
  const services = [];
  const create = () => {
    const s = new ProductionTasks(config, stores, fetcher);
    services.push(s);
    return s;
  };
  t.after(async () => {
    for (const s of services) await s.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    service: create(),
    create,
    calls,
    tasks,
    mutations,
    bugs,
    resolveFailure: () => {
      failBug = null;
    },
  };
}
async function settled(service, id) {
  for (let i = 0; i < 200; i++) {
    const result = await service.batch("user-1", "project-1", id);
    if (result.status !== "running") return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Batch did not settle");
}
test("eight bugs keep independent results, resume failed steps, and never resubmit successes", async (t) => {
  const f = await fixture(t),
    input = {
      projectId: "project-1",
      requestId: "eight-bugs",
      kind: "bugs",
      items: [...f.bugs.keys()].map((bugId) => ({ bugId })),
    };
  const queued = await f.service.submit("user-1", input);
  const first = await settled(f.service, queued.id);
  assert.equal(first.items.filter((i) => i.status === "accepted").length, 7);
  assert.equal(first.items[3].error.code, "FIXTURE_REJECTED");
  assert.equal(f.calls.filter((c) => c.operation === "dispatch").length, 7);
  assert.deepEqual(
    f.calls.find((c) => c.operation === "dispatch").input.request.selectedAttachmentIds,
    ["proof"],
  );
  assert.equal(
    f.calls.find((c) => c.operation === "dispatch").input.request.execution.codexModel,
    "gpt-5.6-sol",
  );
  const replay = await f.service.submit("user-1", input);
  assert.equal(replay.id, queued.id);
  await assert.rejects(f.service.submit("user-1", { ...input, items: input.items.slice(0, 7) }), {
    code: "IDEMPOTENCY_PAYLOAD_MISMATCH",
  });
  await f.service.close();
  f.resolveFailure();
  const restarted = f.create();
  await restarted.batch("user-1", "project-1", queued.id, true);
  const second = await settled(restarted, queued.id);
  assert.equal(second.status, "completed");
  assert.equal(f.calls.filter((c) => c.operation === "dispatch").length, 8);
});
test("lost creation response replays the durable request after restart without duplicate task", async (t) => {
  const f = await fixture(t);
  const input = {
    projectId: "project-1",
    requestId: "new",
    kind: "create",
    items: [{ title: "Create", message: "Implement requirement" }],
  };
  const queued = await f.service.submit("user-1", input);
  const first = await settled(f.service, queued.id);
  assert.equal(first.items[0].error.code, "RELAY_UNAVAILABLE");
  assert.equal(f.tasks.length, 1);
  await f.service.close();
  const restarted = f.create();
  await restarted.batch("user-1", "project-1", queued.id, true);
  const result = await settled(restarted, queued.id);
  assert.equal(result.items[0].result.taskId, "task-1");
  assert.equal(f.tasks.length, 1);
});
test("existing linked task is reused and continuation follows its original QA receipt", async (t) => {
  const f = await fixture(t);
  f.tasks.push({
    id: "task-existing",
    bugId: "bug-0",
    attemptId: "original-attempt",
    handoffId: "original-handoff",
    updatedAt: "2026-09-04T00:00:00Z",
  });
  const batch = await f.service.submit("user-1", {
    projectId: "project-1",
    requestId: "existing",
    kind: "bugs",
    items: [{ bugId: "bug-0" }],
  });
  assert.equal((await settled(f.service, batch.id)).items[0].status, "existing");
  assert.equal(f.calls.length, 0);
  const continued = await f.service.submit("user-1", {
    projectId: "project-1",
    requestId: "continue",
    kind: "action",
    items: [
      {
        taskId: "task-existing",
        expectedUpdatedAt: "2026-09-04T00:00:00Z",
        action: "continue",
        message: "Fix more",
        selectedAttachmentIds: ["proof"],
      },
    ],
  });
  assert.equal((await settled(f.service, continued.id)).status, "completed");
  const call = f.calls.find((c) => c.operation === "continue");
  assert.equal(call.input.attemptId, "original-attempt");
  assert.equal(call.input.request.handoffId, "original-handoff");
});
test("project authorization and attachment integrity are checked before submission", async (t) => {
  const f = await fixture(t),
    input = {
      projectId: "project-1",
      requestId: "auth",
      kind: "bugs",
      items: [{ bugId: "bug-0" }],
    };
  await assert.rejects(f.service.submit("outsider", input), { code: "PROJECT_FORBIDDEN" });
  await assert.rejects(f.service.submit("viewer", input), { code: "PROJECT_FORBIDDEN" });
  assert.equal(f.calls.length, 0);
  const bytes = Buffer.from("proof"),
    file = {
      projectId: "project-1",
      filename: "proof.txt",
      mediaType: "text/plain",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      contentBase64: bytes.toString("base64"),
    };
  const first = await f.service.upload("user-1", file),
    second = await f.service.upload("user-1", file);
  assert.equal(first.id, second.id);
  await assert.rejects(f.service.upload("user-1", { ...file, sha256: "0".repeat(64) }), {
    code: "ATTACHMENT_HASH_MISMATCH",
  });
  await assert.rejects(f.service.upload("user-1", { ...file, filename: "../proof.txt" }), {
    code: "INVALID_ATTACHMENT",
  });
});
test("HTTP routes require authentication and a merge confirmation before any mutation", async (t) => {
  const f = await fixture(t),
    app = Fastify();
  registerProductionRoutes(app, f.service, (req) =>
    req.headers.authorization === "Bearer fixture" ? "user-1" : null,
  );
  t.after(() => app.close());
  assert.equal(
    (await app.inject({ url: "/api/v1/production/tasks?projectId=project-1" })).statusCode,
    401,
  );
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/production/batches",
    headers: { authorization: "Bearer fixture" },
    payload: {
      projectId: "project-1",
      requestId: "merge",
      kind: "action",
      items: [{ taskId: "task-1", expectedUpdatedAt: "2026-09-04T00:00:00Z", action: "merge" }],
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "MERGE_CONFIRMATION_REQUIRED");
  assert.equal(f.calls.length, 0);
});
