import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorageWorker, projectMembershipId } from "@relay-qa-hub/storage";
import { startMobileRelayOutboxPump } from "../dist/mobile-relay-outbox.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "qa-project-relay-outbox-"));
  const accountId = randomUUID(),
    actorId = randomUUID(),
    a = randomUUID(),
    b = randomUUID();
  const marker = join(root, ".qa-hub-import-hold.json");
  const relayInstanceId = "relay-fixture",
    qaInstanceId = "qa-fixture";
  const worker = new SqliteStorageWorker({
    databaseFile: join(root, "qa.sqlite"),
    busyTimeoutMs: 1000,
    backupRoot: join(root, "backups"),
    executionHoldFile: marker,
    relayInstanceId,
    qaInstanceId,
    relayPrincipalId: randomUUID(),
  });
  const pumps = [];
  t.after(async () => {
    for (const pump of pumps) await pump.stop();
    await worker.close();
    await rm(root, { recursive: true, force: true });
  });
  const versions = new Map();
  const set = async (projectId, enabled) => {
    const previous = versions.get(projectId) ?? 0;
    await worker.projectManagement({
      operation: "setComponent",
      accountId,
      actorId,
      isGm: true,
      projectId,
      componentKey: "relay.production",
      enabled,
      expectedVersion: previous,
      now: new Date().toISOString(),
      config: {
        baseUrl: "https://relay.fixture.invalid",
        externalProjectId: "REMOTE",
        relayInstanceId,
        credentialRef: "fixture",
      },
    });
    versions.set(projectId, previous + 1);
  };
  for (const [projectId, projectKey] of [
    [a, "OUTA"],
    [b, "OUTB"],
  ]) {
    const scope = {
      accountId,
      projectId,
      projectKey,
      actorId,
      actorDisplayName: "Fixture",
      membershipId: projectMembershipId(projectId, actorId),
      createdAt: new Date().toISOString(),
    };
    await worker.ensureMobileScope(scope);
    await worker.ensureMobileRelayRoles(scope);
    await set(projectId, true);
  }
  const route = (version) => ({
    componentVersion: version,
    snapshotDigest: digest(`snapshot-${version}`),
    externalProjectKey: "REMOTE",
  });
  const enqueue = async (projectId, version) => {
    const at = new Date().toISOString();
    const scope = { accountId, actorId, projectId, createdAt: at };
    const created = await worker.createMobileBug({
      ...scope,
      clientSubmissionId: randomUUID(),
      payloadDigest: digest(randomUUID()),
      title: "Fixture relay queue",
      description: "Isolated queue contract",
      expectedBehavior: "Correct project only",
      severity: "S2",
      priority: "P2",
      ownerId: actorId,
      verificationOwnerId: null,
      occurrence: { observedAt: at, platform: "web", steps: ["Check"], actualBehavior: "Fixture" },
      attachmentIds: [],
      captureBundleId: null,
    });
    const ready = await worker.transitionMobileBugReady({
      ...scope,
      bugId: created.bug.id,
      expectedVersion: created.bug.version,
      idempotencyKey: randomUUID(),
      requestDigest: digest(randomUUID()),
    });
    const attempt = await worker.createMobileRelayAttempt({
      ...scope,
      bugId: created.bug.id,
      expectedVersion: ready.version,
      assigneeId: actorId,
      summary: null,
      idempotencyKey: randomUUID(),
      requestDigest: digest(randomUUID()),
    });
    const accepted = await worker.dispatchMobileRelay({
      ...scope,
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      handoffId: randomUUID(),
      selectedAttachmentIds: [],
      idempotencyKey: randomUUID(),
      requestDigest: digest(randomUUID()),
      relayInstanceId,
      qaInstanceId,
      ...(version ? { componentRoute: route(version) } : {}),
    });
    return { ...accepted, bugId: created.bug.id };
  };
  const claim = async (projectId, version, extra = {}) => {
    const now = new Date();
    return worker.claimMobileRelayOutbox({
      leaseOwner: randomUUID(),
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + 5000).toISOString(),
      relayInstanceId,
      ...(projectId
        ? {
            accountId,
            projectId,
            componentVersion: version,
            snapshotDigest: route(version).snapshotDigest,
          }
        : {}),
      ...extra,
    });
  };
  const queue = (projectId, operation = "list", outboxMessageId) =>
    worker.projectRelayQueue({
      operation,
      accountId,
      projectId,
      actorId,
      isGm: true,
      now: new Date().toISOString(),
      ...(outboxMessageId ? { outboxMessageId } : {}),
    });
  return {
    worker,
    root,
    marker,
    accountId,
    actorId,
    a,
    b,
    route,
    enqueue,
    claim,
    set,
    queue,
    pumps,
    relayInstanceId,
    qaInstanceId,
  };
}

test("real SQLite Relay claims isolate projects, versions and legacy lanes; disabled queue needs explicit audited resume", async (t) => {
  const f = await fixture(t);
  const a1 = await f.enqueue(f.a, 1),
    a2 = await f.enqueue(f.a, 2),
    b1 = await f.enqueue(f.b, 1),
    legacy = await f.enqueue(f.b);
  assert.equal((await f.claim()).outboxMessageId, legacy.outboxMessageId);
  assert.equal(await f.claim(), null, "global legacy pump cannot steal new project routes");
  assert.equal(await f.claim(f.a, 99), null);
  assert.equal(await f.claim(f.a, 1, { snapshotDigest: "0".repeat(64) }), null);
  assert.equal(await f.claim(f.a, 1, { relayInstanceId: "relay-another" }), null);
  const first = await f.claim(f.a, 1);
  assert.equal(first.outboxMessageId, a1.outboxMessageId);
  assert.equal(first.projectId, f.a);
  assert.equal(first.defect.projectKey, "REMOTE");
  assert.equal(first.projectKey, "REMOTE");
  assert.equal(first.componentRoute.componentVersion, 1);
  assert.equal((await f.claim(f.a, 2)).outboxMessageId, a2.outboxMessageId);
  assert.equal((await f.claim(f.b, 1)).outboxMessageId, b1.outboxMessageId);
  await f.worker.retryMobileRelayOutbox({
    outboxMessageId: first.outboxMessageId,
    leaseOwner: first.leaseOwner,
    relayInstanceId: f.relayInstanceId,
    errorCode: "FIXTURE_NOT_SENT",
    nextAttemptAt: new Date().toISOString(),
    deadLetter: false,
  });
  await f.set(f.a, false);
  assert.equal(await f.claim(f.a, 1), null);
  assert.equal(
    (await f.queue(f.a)).items.find((item) => item.id === a1.outboxMessageId).state,
    "paused",
  );
  await f.set(f.a, true);
  assert.equal(await f.claim(f.a, 1), null, "re-enabling cannot replay paused outbox");
  await assert.rejects(f.queue(f.b, "resume", a1.outboxMessageId), { code: "TASK_NOT_PAUSED" });
  await f.queue(f.a, "resume", a1.outboxMessageId);
  assert.equal((await f.claim(f.a, 1)).outboxMessageId, a1.outboxMessageId);
  const audit = await f.worker.projectManagement({
    operation: "audit",
    accountId: f.accountId,
    projectId: f.a,
    actorId: f.actorId,
    isGm: true,
    now: new Date().toISOString(),
  });
  assert.ok(audit.items.some((item) => item.action === "relay.outbox.resumed"));
});

test("worker import hold and transport second gate stop queued work without HTTP while history remains available", async (t) => {
  const f = await fixture(t);
  const task = await f.enqueue(f.a, 1);
  await writeFile(f.marker, "{corrupt");
  assert.equal(await f.claim(f.a, 1), null);
  assert.equal((await f.queue(f.a)).items[0].attemptCount, 0);
  await assert.rejects(
    f.worker.createMobileRelayAttempt({
      accountId: f.accountId,
      projectId: f.a,
      actorId: f.actorId,
      bugId: task.bugId,
      expectedVersion: 1,
      assigneeId: f.actorId,
      idempotencyKey: randomUUID(),
      requestDigest: digest("held"),
      createdAt: new Date().toISOString(),
    }),
    { code: "IMPORT_EXECUTION_HELD" },
  );
  await writeFile(f.marker, JSON.stringify({ markerVersion: 1, state: "released" }));
  assert.equal(await f.claim(f.a, 1), null, "missing release evidence remains held");
  await writeFile(
    f.marker,
    JSON.stringify({
      markerVersion: 1,
      state: "released",
      release: {
        actorId: f.actorId,
        releasedAt: new Date().toISOString(),
        reason: "Fixture reviewed",
      },
    }),
  );
  let checks = 0,
    requests = 0;
  const pump = startMobileRelayOutboxPump({
    worker: f.worker,
    endpoint: new URL("https://relay.fixture.invalid/api/integrations/qa/v1/handoffs"),
    bearerToken: "fixture-token",
    qaInstanceId: f.qaInstanceId,
    scope: {
      accountId: f.accountId,
      projectId: f.a,
      componentVersion: 1,
      snapshotDigest: f.route(1).snapshotDigest,
      relayInstanceId: f.relayInstanceId,
    },
    canStart: async () => ++checks === 1,
    fetch: async () => {
      requests++;
      throw new Error("No fixture HTTP allowed");
    },
  });
  f.pumps.push(pump);
  for (let i = 0; i < 100; i++) {
    if ((await f.queue(f.a)).items[0].state === "paused") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  await pump.stop();
  assert.equal(requests, 0);
  assert.equal((await f.queue(f.a)).items[0].state, "paused");
  assert.equal(
    (await f.queue(f.a)).items[0].attemptCount,
    1,
    "gate closes after claim and before HTTP",
  );
});
