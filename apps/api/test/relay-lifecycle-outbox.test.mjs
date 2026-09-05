import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { startMobileRelayOutboxPump } from "../dist/mobile-relay-outbox.js";

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;

test("durable Relay transport carries prior handoff and human acceptance, and retries a transient failure", async (t) => {
  const observed = [],
    completions = [],
    retries = [];
  let failFirstAcceptance = true;
  const server = createServer(async (req, res) => {
    let bytes = "";
    for await (const chunk of req) bytes += chunk;
    const body = JSON.parse(bytes);
    observed.push({ path: req.url, body, key: req.headers["idempotency-key"] });
    if (req.url.endsWith("/accept") && failFirstAcceptance) {
      failFirstAcceptance = false;
      res.writeHead(503).end();
      return;
    }
    res.writeHead(202, { "content-type": "application/json" }).end(
      JSON.stringify({
        relayInstanceId: "relay-main",
        handoffId: body.handoffId ?? "handoff-2",
        attemptId: body.attemptId,
        ...(body.actionId ? { actionId: body.actionId } : {}),
        taskId: "task-original",
        turnId: "turn-second",
        status: body.actionId ? "closed" : "queued",
        branchName: "codex/original",
        threadId: "thread-original",
        workspace: {
          projectId: "project-1",
          branchName: "codex/original",
          threadId: "thread-original",
        },
        requestHash: createHash("sha256")
          .update(JSON.stringify(canonical(body)))
          .digest("hex"),
        replayed: false,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = {
    bugId: "bug-1",
    repairAttemptId: "attempt-2",
    handoffId: "handoff-2",
    relayInstanceId: "relay-main",
    qaInstanceId: "qa-local",
    selectedAttachments: [],
    selectedAttachmentIds: [],
    payloadDigest: "a".repeat(64),
    attemptCount: 1,
    defect: {
      id: "bug-1",
      key: "LOCAL-257",
      revision: 10,
      projectKey: "LOCAL",
      title: "Button alignment",
      description: "Button is misplaced",
      severity: "S2",
      verificationCriteria: "Button aligned",
    },
  };
  const queued = [
    {
      ...base,
      outboxMessageId: "rework",
      operation: "create",
      previousHandoffId: "handoff-1",
      execution: { extraPrompt: "打回理由：仍有偏移，请继续修复" },
      idempotencyKey: "qa:qa-local:handoff:handoff-2",
    },
    {
      ...base,
      outboxMessageId: "accept",
      attemptCount: 9,
      operation: "accept",
      actionId: "verification-2",
      prompt: "QA 人工验收通过",
      idempotencyKey: "qa:qa-local:action:verification-2",
    },
  ];
  let claimed;
  const finished = Promise.withResolvers();
  const worker = {
    async claimMobileRelayOutbox({ leaseOwner }) {
      claimed = queued.shift();
      return claimed ? { ...claimed, leaseOwner } : null;
    },
    async completeMobileRelayOutbox(input) {
      completions.push(input);
      if (completions.length === 2) finished.resolve();
    },
    async retryMobileRelayOutbox(input) {
      retries.push(input);
      queued.push({ ...claimed, attemptCount: claimed.attemptCount + 1 });
    },
  };
  const pump = startMobileRelayOutboxPump({
    worker,
    endpoint: new URL(`http://127.0.0.1:${server.address().port}/api/integrations/qa/v1/handoffs`),
    bearerToken: "test-only-token",
  });
  t.after(() => pump.stop());
  await Promise.race([
    finished.promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Outbox did not drain")), 3000);
      timer.unref();
    }),
  ]);
  await pump.stop();
  assert.equal(observed[0].body.previousHandoffId, "handoff-1");
  assert.match(observed[0].body.execution.extraPrompt, /打回理由/);
  assert.equal(observed[1].path, "/api/integrations/qa/v1/handoffs/handoff-2/accept");
  assert.deepEqual(observed[2], observed[1]);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].deadLetter, false);
  assert.deepEqual(
    completions.map((item) => item.relayTaskId),
    ["task-original", "task-original"],
  );
});
