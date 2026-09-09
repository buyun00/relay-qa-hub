import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteStorageWorker, projectMembershipId } from "@relay-qa-hub/storage";
import { createApiApp } from "../dist/app.js";
import { ProjectManagementService } from "../dist/project-management.js";
import { ProjectRequestContext } from "../dist/project-request-context.js";
import { createSqliteBrowserAuthStore } from "../dist/browser-auth.js";
import { createSqliteWorkflowProjectionStore } from "../dist/sqlite-workflow-projection-store.js";

test("workflow MCP preserves actual HTTP pages and current project authority", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qa-mcp-workflow-"));
  const databaseFile = join(directory, "fixture.sqlite");
  const worker = new SqliteStorageWorker({
    databaseFile,
    backupRoot: join(directory, "backups"),
    busyTimeoutMs: 5000,
  });
  const accountId = randomUUID(),
    projectId = randomUUID(),
    otherProjectId = randomUUID(),
    gmId = randomUUID();
  const now = () => new Date().toISOString();
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const scope = {
    accountId,
    projectId,
    actorId: gmId,
    projectKey: "MCPWFA",
    membershipId: projectMembershipId(projectId, gmId),
    createdAt: now(),
  };
  await worker.ensureMobileScope(scope);
  const otherCreator = randomUUID();
  await worker.ensureMobileScope({
    ...scope,
    projectId: otherProjectId,
    actorId: otherCreator,
    projectKey: "MCPWFB",
    membershipId: projectMembershipId(otherProjectId, otherCreator),
  });
  const service = new ProjectManagementService({ worker, accountId, gmUserId: gmId });
  const context = new ProjectRequestContext();
  const app = createApiApp({
    logger: false,
    automationPublicApiOrigin: "http://127.0.0.1",
    isolateLegacyComponents: true,
    projectManagementService: service,
    projectRequestContext: context,
    workflowProjectionStore: createSqliteWorkflowProjectionStore({
      worker,
      scope: context.scope(scope),
    }),
    browserAuth: {
      store: createSqliteBrowserAuthStore({ worker }),
      accountId,
      userId: gmId,
      actorId: gmId,
      adminEmail: "fixture@example.invalid",
      sessionSecret: "mcp-workflow-fixture-only",
      webOrigins: [],
      passwordlessLogin: async () => {
        throw new Error("Explicit project required");
      },
      projectLogin: (name, project, at) => service.login(name, project, at),
      gm: { userId: gmId, password: "mcp-workflow-gm-fixture" },
    },
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const ledger: { path: string; method: string; status: number }[] = [];
  let rpcId = 0;
  t.after(async () => {
    await app.close();
    await worker.close();
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    const schema = db.prepare("PRAGMA user_version").get()!.user_version;
    assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    db.close();
    writeFileSync(
      join(directory, "retained.json"),
      JSON.stringify({ directory, schema, requests: ledger.length, ledger }, null, 2),
      { flag: "wx" },
    );
    t.diagnostic(
      `retained ${directory}; schema ${schema}; ${ledger.length} real loopback HTTP requests; registered compiled MCP, app and worker`,
    );
  });
  async function request(
    path: string,
    options: { body?: unknown; token?: string; project?: string; expected?: number } = {},
  ) {
    const response = await fetch(origin + path, {
      method: options.body === undefined ? "GET" : "POST",
      headers: {
        accept: "application/vnd.relay-qa-hub.v1.1+json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.project ? { "x-qa-project-id": options.project } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(5000),
    });
    ledger.push({
      path: path.split("?")[0]!,
      method: options.body === undefined ? "GET" : "POST",
      status: response.status,
    });
    const body = await response.json();
    assert.equal(response.status, options.expected ?? 200, path);
    return body;
  }
  const alice = await request("/api/v1/auth/login", {
    body: { projectId, name: "Workflow MCP Alice", client: "android" },
  });
  const bob = await request("/api/v1/auth/login", {
    body: { projectId: otherProjectId, name: "Workflow MCP Bob", client: "android" },
  });
  const gm = await request("/api/v1/auth/gm/login", {
    body: { password: "mcp-workflow-gm-fixture", client: "android" },
  });
  const create = (project: string, actorId: string) =>
    worker.createMobileBug({
      accountId,
      projectId: project,
      actorId,
      clientSubmissionId: randomUUID(),
      payloadDigest: digest([project, actorId]),
      title: "Frozen workflow MCP",
      description: "Retain local fixture history",
      expectedBehavior: "Same authorized page",
      severity: "S2",
      priority: "P2",
      ownerId: actorId,
      verificationOwnerId: actorId,
      occurrence: {
        observedAt: now(),
        platform: "web",
        steps: ["Read"],
        actualBehavior: "Recorded",
      },
      attachmentIds: [],
      captureBundleId: null,
      createdAt: now(),
    });
  const a = await create(projectId, alice.userId),
    otherA = await create(projectId, alice.userId),
    b = await create(otherProjectId, bob.userId);
  // Two extra typed local facts create real independent pages; no production SQL or external task.
  const seed = new DatabaseSync(databaseFile);
  seed.exec("BEGIN IMMEDIATE");
  const columns = seed
    .prepare("PRAGMA table_xinfo(occurrences)")
    .all()
    .filter((r) => r.hidden === 0)
    .map((r) => String(r.name));
  const row = seed.prepare("SELECT * FROM occurrences WHERE id=?").get(a.occurrenceId)!;
  const insert = seed.prepare(
    `INSERT INTO occurrences(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
  );
  for (let i = 0; i < 2; i++) {
    const copy = { ...row, id: randomUUID(), client_submission_id: randomUUID() };
    insert.run(...columns.map((c) => copy[c]!));
  }
  seed.exec("COMMIT");
  seed.close();
  async function rpc(method: string, params: unknown, token?: string) {
    const response = await request("/mcp", {
      body: { jsonrpc: "2.0", id: ++rpcId, method, params },
      ...(token ? { token } : {}),
    });
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.error, undefined);
    return response.result;
  }
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "isolated-workflow", version: "1" },
  });
  const catalog = (await rpc("tools/list", {})).tools;
  const sharedCatalog = await request("/api/v1/mcp/tools", { token: alice.accessToken });
  assert.equal(catalog.length, 96);
  assert.deepEqual(sharedCatalog.tools, catalog);
  const tool = catalog.find((entry: { name: string }) => entry.name === "qa_get_bug_workflow");
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(
    catalog.filter(
      (entry: { name: string }) =>
        ![
          "qa_get_bug_workflow",
          "qa_record_verification_result",
          "qa_fail_repair_attempt",
          "qa_supersede_repair_attempt",
          "qa_begin_fix",
          "qa_submit_fix",
        ].includes(entry.name),
    ).length,
    90,
  );
  const args = { projectId, bugId: a.bug.id, query: { limitPerCollection: 1 } };
  async function page(
    input: Record<string, unknown> = args,
    token = alice.accessToken,
    expected = 200,
  ) {
    const result = await rpc(
      "tools/call",
      { name: "qa_get_bug_workflow", arguments: input },
      token,
    );
    assert.equal(result.isError === true, expected !== 200);
    const value = JSON.parse(
      result.content.find((item: { type: string }) => item.type === "text").text,
    );
    if (expected === 200) assert.deepEqual(value, result.structuredContent);
    else assert.equal(result.structuredContent, undefined);
    if (expected !== 200) assert.equal(value.status, expected);
    if (expected === 400) assert.equal(value.code, "INVALID_REQUEST");
    return value;
  }
  const first = await page();
  assert.equal(first.occurrences.length, 1);
  assert.equal(first.truncated, true);
  assert.ok(first.nextCursor);
  const nextArgs = { ...args, query: { ...args.query, cursor: first.nextCursor } };
  const second = await page(nextArgs);
  const direct = await request(
    `/api/v1/bugs/${a.bug.id}/workflow?limitPerCollection=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    { token: alice.accessToken, project: projectId },
  );
  assert.deepEqual(second, direct);
  assert.deepEqual(await page(nextArgs), second);
  const last = await page({ ...args, query: { ...args.query, cursor: second.nextCursor } });
  assert.equal(last.truncated, false);
  assert.equal(last.nextCursor, null);
  assert.equal(
    new Set([first, second, last].flatMap((p) => p.occurrences.map((o: { id: string }) => o.id)))
      .size,
    3,
  );
  for (const p of [first, second, last]) {
    assert.equal(p.snapshotSequence, first.snapshotSequence);
    assert.equal(p.bugVersion, first.bugVersion);
    for (const key of ["repairAttempts", "verifications", "builds", "relayReceipts"])
      assert.deepEqual(p[key], []);
  }
  const fingerprint = () => {
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      return [
        "bugs",
        "events",
        "workflow_projection_snapshots",
        "workflow_projection_items",
        "workflow_projection_cursors",
        "storage_command_authorizations",
      ].map((name) =>
        digest(
          db
            .prepare(`SELECT * FROM ${name}`)
            .all()
            .map((r) => JSON.stringify(r))
            .sort(),
        ),
      );
    } finally {
      db.close();
    }
  };
  for (const invalidProject of [null, 123, false, ""]) {
    const before = fingerprint();
    await page({ ...args, projectId: invalidProject }, alice.accessToken, 400);
    assert.deepEqual(fingerprint(), before);
  }
  for (const bad of [
    { limitPerCollection: 0 },
    { limitPerCollection: 101 },
    { limitPerCollection: true },
    { cursor: "bad" },
    { cursor: "x".repeat(501) },
    { unknown: 1 },
    { limitPerCollection: 2, cursor: first.nextCursor },
  ]) {
    const before = fingerprint();
    await page({ ...args, query: bad }, alice.accessToken, 400);
    assert.deepEqual(fingerprint(), before);
  }
  for (const [input, token, expected] of [
    [{ ...nextArgs, bugId: otherA.bug.id }, alice.accessToken, 400],
    [{ ...nextArgs, projectId: otherProjectId }, alice.accessToken, 404],
    [nextArgs, bob.accessToken, 403],
    [{ ...args, actorId: gmId }, alice.accessToken, 400],
  ] as const) {
    const before = fingerprint();
    await page(input, token, expected);
    assert.deepEqual(fingerprint(), before);
  }
  const other = await page({ projectId: otherProjectId, bugId: b.bug.id }, gm.accessToken);
  assert.equal(other.bugId, b.bug.id);
  for (const [active, version, expected] of [
    [false, 1, 403],
    [true, 2, 400],
  ] as const) {
    await worker.projectManagement({
      accountId,
      projectId,
      actorId: gmId,
      isGm: true,
      operation: "membership",
      userId: alice.userId,
      active,
      expectedVersion: version,
      now: now(),
    });
    const before = fingerprint();
    await page(nextArgs, alice.accessToken, expected);
    assert.deepEqual(fingerprint(), before);
  }
  const fresh = await page();
  assert.notEqual(fresh.nextCursor, first.nextCursor);
  await worker.deleteMobileBug({
    accountId,
    projectId,
    actorId: alice.userId,
    bugId: a.bug.id,
    expectedVersion: a.bug.version,
    idempotencyKey: randomUUID(),
    requestDigest: digest("delete"),
    createdAt: now(),
  });
  const beforeDeleteRead = fingerprint();
  await page(nextArgs, gm.accessToken, 404);
  assert.deepEqual(fingerprint(), beforeDeleteRead);
});
