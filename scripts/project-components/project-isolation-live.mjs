import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";

const credentials = new Set();
const sensitiveKey =
  /token|secret|password|cookie|authorization|csrf|private.?key|api.?key|service.?key|credential/iu;
function redact(value, depth = 0) {
  if (depth > 64) return "[REDACTED_NESTING_LIMIT]";
  if (typeof value === "string") {
    try {
      const decoded = JSON.parse(value);
      if (decoded !== null && typeof decoded === "object")
        return JSON.stringify(redact(decoded, depth + 1));
      if (typeof decoded === "string") {
        const cleaned = redact(decoded, depth + 1);
        if (cleaned !== decoded) return JSON.stringify(cleaned);
      }
    } catch {
      /* Ordinary strings preserve protocol and version spelling. */
    }
    let text = value;
    for (const credential of credentials) text = text.replaceAll(credential, "[REDACTED]");
    return text.replace(/Bearer\s+[^\s"<>]+/giu, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !sensitiveKey.test(key))
      .map(([key, child]) => [key, redact(child, depth + 1)]),
  );
}
function remember(value) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") remember(parsed);
    } catch {
      /* Plain text. */
    }
  } else if (Array.isArray(value)) value.forEach(remember);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (sensitiveKey.test(key) && typeof child === "string" && child.length > 8)
        credentials.add(child);
      else remember(child);
    }
  }
}
if (process.argv[2] === "--selftest") {
  credentials.add("fixture-secret-123");
  const result = redact({
    jsonrpc: "2.0",
    version: "1.0",
    text: JSON.stringify({
      accessToken: "fixture-secret-123",
      jsonrpc: "2.0",
      nested: JSON.stringify({ password: "fixture-secret-123", text: "Bearer fixture-secret-123" }),
    }),
    authorization: "fixture-secret-123",
  });
  assert.equal(result.jsonrpc, "2.0");
  assert.equal(result.version, "1.0");
  assert.equal(JSON.parse(result.text).jsonrpc, "2.0");
  assert.ok(!JSON.stringify(result).includes("fixture-secret-123"));
  assert.equal(redact('"2.0"'), '"2.0"');
  console.log("PASS inert recursive redaction and protocol primitive preservation");
  process.exit(0);
}
if (process.argv[2] !== "--run") {
  console.log(
    "Usage: node scripts/project-components/project-isolation-live.mjs --run <explicit-preview-instance.json> | --selftest",
  );
  process.exit(0);
}
assert.equal(process.argv.length, 4);
const config = readParallelInstanceConfig(process.argv[3]);
assert.equal(config.instanceId, "qa-hub-preview-7c86");
assert.equal(config.apiHost, "127.0.0.1");
assert.equal(config.apiPort, 4419);
assert.equal(config.mcpPort, 4421);
assert.equal(resolve(config.sourceRoot), process.cwd());
const api = "http://127.0.0.1:4419",
  mcp = "http://127.0.0.1:4421";
const runId = randomUUID(),
  startedAt = new Date().toISOString();
const output = join(
  config.sourceRoot,
  "docs/evidence/project-components/project-isolation-live",
  runId,
);
mkdirSync(output, { recursive: true });
const records = [],
  assertions = [],
  fixtures = [],
  people = {},
  projects = [];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const window = {
  from: new Date(Date.now() - 60_000).toISOString(),
  to: new Date(Date.now() + 3_600_000).toISOString(),
};
let rpcId = 0,
  passed = false,
  failure;
const expected = (status, code) => ({ status, code });
const forbidden = expected(403, "PROJECT_NOT_ACCESSIBLE"),
  mismatch = expected(404, "NOT_FOUND");
function safeJson(value) {
  const text = JSON.stringify(redact(value));
  for (const credential of credentials)
    assert.ok(!text.includes(credential), "Credential redaction failed");
  return text;
}
function check(label, work, detail = {}) {
  work();
  const item = { label, passed: true, ...detail, at: new Date().toISOString() };
  assertions.push(item);
  appendFileSync(join(output, "assertions.jsonl"), safeJson(item) + "\n");
}
async function wire(label, origin, path, options = {}) {
  assert.ok(origin === api || origin === mcp);
  assert.ok(path.startsWith("/") && !path.startsWith("//"));
  assert.ok(
    !/production|increment-upload|packaging|qingyu|updates|logout/iu.test(path),
    "Component or unrelated route refused",
  );
  assert.ok(origin !== api || !path.includes("/mcp"), "Direct HTTP lane must not use MCP wrapper");
  assert.ok(origin !== mcp || path === "/mcp" || path === "/health");
  const entry = {
    index: records.length,
    label,
    origin,
    path,
    method: options.method ?? "GET",
    projectId: options.projectId,
    startedAt: new Date().toISOString(),
    request: Buffer.isBuffer(options.body)
      ? {
          size: options.body.length,
          sha256: digest(options.body),
          bytesBase64: options.body.toString("base64"),
        }
      : redact(options.body),
    idempotencyKey: options.key,
  };
  records.push(entry);
  try {
    const response = await fetch(origin + path, {
      method: entry.method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        accept:
          origin === mcp
            ? "application/json, text/event-stream"
            : "application/vnd.relay-qa-hub.v1.1+json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.projectId ? { "x-qa-project-id": options.projectId } : {}),
        ...(options.body === undefined
          ? {}
          : {
              "content-type": Buffer.isBuffer(options.body)
                ? "application/octet-stream"
                : "application/json",
            }),
        ...(options.key ? { "idempotency-key": options.key } : {}),
        ...(origin === mcp ? { "MCP-Protocol-Version": "2025-06-18" } : {}),
        ...options.headers,
      },
      ...(options.body === undefined
        ? {}
        : { body: Buffer.isBuffer(options.body) ? options.body : JSON.stringify(options.body) }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let value;
    if (options.binary && response.ok)
      value = { size: bytes.length, sha256: digest(bytes), bytesBase64: bytes.toString("base64") };
    else value = bytes.length ? JSON.parse(bytes.toString("utf8")) : null;
    remember(value);
    entry.status = response.status;
    entry.contentType = response.headers.get("content-type");
    entry.response = redact(value);
    entry.uploadVersion = response.headers.get("x-upload-version");
    assert.equal(
      response.status,
      options.expect?.status ?? 200,
      `${label}: unexpected HTTP status`,
    );
    if (options.expect?.code) assert.equal(value?.code, options.expect.code, label);
    return options.chunk ? { version: Number(entry.uploadVersion) } : value;
  } catch (error) {
    entry.failure = redact(error.message);
    throw error;
  } finally {
    entry.finishedAt = new Date().toISOString();
    appendFileSync(join(output, "requests.jsonl"), safeJson(entry) + "\n");
  }
}
async function rpc(label, method, params, token, errorCode) {
  const envelope = await wire(label, mcp, "/mcp", {
    method: "POST",
    token,
    body: { jsonrpc: "2.0", id: ++rpcId, method, params },
  });
  assert.equal(envelope.jsonrpc, "2.0");
  assert.equal(envelope.id, rpcId);
  if (errorCode) {
    assert.equal(envelope.error?.code, -32002, label);
    assert.equal(envelope.error.message, errorCode, label);
    assert.equal(envelope.result, undefined);
    return envelope.error;
  }
  assert.equal(envelope.error, undefined, label);
  return envelope.result;
}
async function tool(label, name, args, token, denial) {
  const result = await rpc(label, "tools/call", { name, arguments: args }, token);
  const value = result.structuredContent ?? JSON.parse(result.content[0].text);
  assert.equal(result.isError, Boolean(denial), `${label}: unexpected MCP outcome`);
  if (denial) {
    assert.equal(value.code, denial.code, label);
    assert.equal(value.status, denial.status, label);
  }
  return value;
}
async function invoke(lane, label, descriptor, auth, scope, denial) {
  return lane === "HTTP"
    ? wire(`${lane} ${label}`, api, descriptor.path, {
        method: descriptor.method ?? "GET",
        body: descriptor.body,
        token: auth.accessToken,
        projectId: scope,
        key: descriptor.key,
        headers: descriptor.headers,
        chunk: descriptor.chunk,
        binary: descriptor.binary,
        expect: denial ?? expected(descriptor.status ?? 200),
      })
    : tool(
        `${lane} ${label}`,
        descriptor.tool,
        { ...descriptor.args, projectId: scope },
        auth.accessToken,
        denial,
      );
}
const projectPath = (pid) => `/api/v1/projects/${pid}`;
function readDescriptor(f, name, scope = f.projectId) {
  const path = `/api/v1/bugs/${f.bugId}`;
  const args = { bugId: f.bugId };
  const queries = new URLSearchParams(window);
  return {
    list: {
      path: `/api/v1/bugs?projectId=${scope}&limit=100`,
      tool: "qa_list_bugs",
      args: { filters: { limit: 100 } },
    },
    detail: { path, tool: "qa_get_bug_context", args },
    comments: {
      path: path + "/comments?limit=100",
      tool: "qa_list_comments",
      args: { ...args, query: { limit: 100 } },
    },
    events: { path: path + "/events?limit=100", tool: "qa_list_events", args },
    attachments: {
      path: path + "/attachments?limit=50",
      tool: "qa_list_attachments",
      args: { ...args, query: { limit: 50 } },
    },
    bytes: {
      path: `/api/v1/attachments/${f.attachmentId}`,
      tool: "qa_read_attachment",
      args: { ...args, attachmentId: f.attachmentId },
      binary: true,
    },
    metrics: {
      path: projectPath(scope) + "/metrics/overview?" + queries,
      tool: "qa_get_metrics",
      args: { query: window },
    },
    modules: { path: projectPath(scope) + "/modules", tool: "qa_list_modules", args: {} },
    materialize: {
      path: path + "/attachments?limit=50",
      tool: "qa_materialize_attachment",
      args: { ...args, attachmentId: f.attachmentId },
    },
  }[name];
}
async function snapshot(f, label) {
  const result = {};
  for (const key of [
    "detail",
    "list",
    "comments",
    "events",
    "attachments",
    "bytes",
    "metrics",
    "modules",
  ])
    result[key] = await invoke(
      "HTTP",
      `${label} owner readback ${key}`,
      readDescriptor(f, key),
      people.shared,
      f.projectId,
    );
  assert.equal(result.detail.projectId, f.projectId);
  assert.equal(result.bytes.sha256, digest(png));
  assert.ok(result.attachments.items.some((item) => item.attachmentId === f.attachmentId));
  return result;
}
async function rejected(f, label, action) {
  const before = await snapshot(f, label + " before");
  let actionError;
  try {
    await action();
  } catch (error) {
    actionError = error;
  }
  const after = await snapshot(f, label + " after");
  check(
    label + " original record, versions, events, bytes, statistics unchanged",
    () => assert.deepEqual(after, before),
    {
      bugId: f.bugId,
      projectId: f.projectId,
      beforeSha256: digest(JSON.stringify(before)),
      afterSha256: digest(JSON.stringify(after)),
    },
  );
  if (actionError) throw actionError;
  check(label + " authorization rejection", () => {});
}
async function upload(lane, projectId, clientSubmissionId) {
  const clientAttachmentId = randomUUID();
  const common = {
    submissionContractVersion: "1.1.0",
    clientSubmissionId,
    clientAttachmentId,
    uploadAttempt: 1,
  };
  const key = (suffix) =>
    `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:upload:1:${suffix}`;
  const body = {
    ...common,
    projectId,
    filename: `isolation-${lane}.png`,
    mediaType: "image/png",
    expectedSize: png.length,
    sha256: digest(png),
  };
  const init = await invoke(
    lane,
    "valid upload init",
    {
      method: "POST",
      path: "/api/v1/uploads/init",
      body,
      tool: "qa_init_upload",
      args: { request: body, idempotencyKey: key("init") },
      key: key("init"),
      status: 201,
    },
    people.shared,
    projectId,
  );
  const chunk = await invoke(
    lane,
    "valid upload chunk",
    {
      method: "PUT",
      path: `/api/v1/uploads/${init.sessionId}/chunks/0`,
      body: png,
      status: 204,
      chunk: true,
      key: key("chunk:0"),
      headers: {
        "x-chunk-sha256": digest(png),
        "if-match": `"${init.version}"`,
        "x-client-submission-id": clientSubmissionId,
        "x-client-attachment-id": clientAttachmentId,
      },
      tool: "qa_put_upload_chunk",
      args: {
        sessionId: init.sessionId,
        chunkNumber: 0,
        expectedVersion: init.version,
        clientSubmissionId,
        clientAttachmentId,
        bytesBase64: png.toString("base64"),
        chunkSha256: digest(png),
        idempotencyKey: key("chunk:0"),
      },
    },
    people.shared,
    projectId,
  );
  const finishBody = {
    ...common,
    expectedVersion: chunk.version,
    expectedSize: png.length,
    sha256: digest(png),
  };
  const finalized = await invoke(
    lane,
    "valid upload finalize",
    {
      method: "POST",
      path: `/api/v1/uploads/${init.sessionId}/finalize`,
      body: finishBody,
      tool: "qa_finalize_upload",
      args: { sessionId: init.sessionId, request: finishBody, idempotencyKey: key("finalize") },
      key: key("finalize"),
    },
    people.shared,
    projectId,
  );
  return { ...common, ...finalized, sessionId: init.sessionId, sha256: digest(png) };
}
function bindDescriptor(item, projectId) {
  const body = {
    submissionContractVersion: "1.1.0",
    projectId,
    clientSubmissionId: item.clientSubmissionId,
    clientAttachmentId: item.clientAttachmentId,
    leaseGeneration: 1,
    expectedVersion: item.version,
    intent: "bug_create",
  };
  const key = `submission:${item.clientSubmissionId}:attachment:${item.clientAttachmentId}:bind:1`;
  return {
    method: "POST",
    path: `/api/v1/attachments/${item.attachmentId}/bind`,
    body,
    key,
    tool: "qa_bind_attachment",
    args: { attachmentId: item.attachmentId, request: body, idempotencyKey: key },
  };
}
async function createFixture(lane, projectId) {
  const submission = randomUUID(),
    item = await upload(lane, projectId, submission);
  await invoke(
    lane,
    "valid initial binding",
    bindDescriptor(item, projectId),
    people.shared,
    projectId,
  );
  const body = {
    submissionContractVersion: "1.1.0",
    projectId,
    clientSubmissionId: submission,
    title: `Project isolation ${lane} ${runId}`,
    description: "Only new isolated fixture records; no existing user content",
    expectedBehavior: "Foreign project requests must not read or mutate",
    severity: "S3",
    priority: "P3",
    attachmentIds: [item.attachmentId],
    occurrence: {
      observedAt: new Date().toISOString(),
      platform: "web",
      steps: ["Actual HTTP or JSON-RPC fixture submission"],
      actualBehavior: "Verify persisted project isolation",
    },
  };
  const created = await invoke(
    lane,
    "valid Bug create",
    {
      method: "POST",
      path: "/api/v1/bugs",
      body,
      tool: "qa_create_bug",
      args: { request: body },
      key: `submission:${submission}:commit`,
      status: 201,
    },
    people.shared,
    projectId,
  );
  const f = {
    lane,
    projectId,
    bugId: created.bug.id,
    attachmentId: item.attachmentId,
    artifactSha256: item.sha256,
    actorId: people.shared.userId,
  };
  fixtures.push(f);
  check("created record has exact project and actor", () => {
    assert.equal(created.bug.projectId, projectId);
    assert.equal(created.bug.reporterId, people.shared.userId);
  });
  return f;
}
function writeDescriptor(f, name, version, scope = f.projectId) {
  const path = `/api/v1/bugs/${f.bugId}`;
  if (name === "edit") {
    const key = `isolation:${runId}:${f.bugId}:edit`,
      body = { expectedVersion: version, description: `Valid edit ${runId}` };
    return {
      method: "PATCH",
      path,
      body,
      key,
      tool: "qa_update_bug",
      args: { bugId: f.bugId, request: body, idempotencyKey: key },
    };
  }
  if (name === "comment") {
    const body = {
        clientSubmissionId: f.commentSubmissionId,
        body: `Isolated comment ${runId} ${f.lane}`,
      },
      key = `comment:${f.bugId}:${f.commentSubmissionId}`;
    return {
      method: "POST",
      path: path + "/comments",
      body,
      key,
      status: 201,
      tool: "qa_add_comment",
      args: { bugId: f.bugId, request: body },
    };
  }
  if (name === "manual") {
    const reason = "Project isolation valid human completion control",
      key = `workflow:manualCompleteBug:bug:${f.bugId}:v${version}`;
    return {
      method: "POST",
      path: path + "/manual-complete",
      body: { expectedVersion: version, reason },
      key,
      tool: "qa_bug_action",
      args: {
        bugId: f.bugId,
        action: "manual_complete",
        expectedVersion: version,
        note: reason,
        idempotencyKey: key,
      },
    };
  }
  if (name === "bind") return bindDescriptor(f.unbound, scope);
  if (name === "delete")
    return {
      method: "DELETE",
      path: path + `?expectedVersion=${version}`,
      key: `web:deleteBug:bug:${f.bugId}:v${version}`,
      tool: "qa_delete_bug",
      args: { bugId: f.bugId, expectedVersion: version },
    };
  throw new Error("Unknown write case");
}
async function testFixture(f) {
  const foreign = projects.find((p) => p.id !== f.projectId),
    own = projects.find((p) => p.id === f.projectId);
  const outsider = people[foreign.label];
  // Populate a real comment before read denials, so empty lists cannot conceal a leak.
  f.commentSubmissionId = randomUUID();
  await invoke(
    f.lane,
    "valid initial comment",
    writeDescriptor(f, "comment", 1),
    people.shared,
    f.projectId,
  );
  for (const name of [
    "list",
    "detail",
    "comments",
    "events",
    "attachments",
    "bytes",
    "metrics",
    "modules",
    ...(f.lane === "MCP" ? ["materialize"] : []),
  ]) {
    const positive = await invoke(
      f.lane,
      `positive ${name}`,
      readDescriptor(f, name),
      people[own.label],
      f.projectId,
    );
    if (f.lane === "MCP" && name !== "materialize") {
      const reference = await invoke(
        "HTTP",
        `MCP ${name} exact direct read comparison`,
        readDescriptor(f, name),
        people[own.label],
        f.projectId,
      );
      check(
        `MCP positive ${name} matches direct HTTP`,
        () => {
          if (name === "detail") assert.deepEqual(positive.bug, reference);
          else if (name === "bytes")
            assert.equal(digest(Buffer.from(positive.blob, "base64")), reference.sha256);
          else assert.deepEqual(positive, reference);
        },
        { bugId: f.bugId },
      );
    }
    if (name === "materialize")
      check("materialized resource URI has exact project/Bug/attachment", () =>
        assert.equal(
          positive.resource.uri,
          `qa-hub://attachment/${f.projectId}/${f.bugId}/${f.attachmentId}`,
        ),
      );
    await rejected(f, `${f.lane} non-member ${name}`, () =>
      invoke(
        f.lane,
        `non-member ${name}`,
        readDescriptor(f, name),
        outsider,
        f.projectId,
        forbidden,
      ),
    );
    if (!["list", "metrics", "modules"].includes(name))
      await rejected(f, `${f.lane} shared mismatched-project ${name}`, () =>
        invoke(
          f.lane,
          `shared mismatched-project ${name}`,
          readDescriptor(f, name, foreign.id),
          people.shared,
          foreign.id,
          mismatch,
        ),
      );
  }
  if (f.lane === "MCP") {
    const uri = `qa-hub://attachment/${f.projectId}/${f.bugId}/${f.attachmentId}`;
    const result = await rpc(
      "MCP valid resource bytes",
      "resources/read",
      { uri },
      people[own.label].accessToken,
    );
    check(
      "authorized MCP resource exact artifact bytes",
      () => assert.deepEqual(Buffer.from(result.contents[0].blob, "base64"), png),
      { bugId: f.bugId },
    );
    await rejected(f, "MCP non-member resources/read", () =>
      rpc(
        "MCP non-member resources/read",
        "resources/read",
        { uri },
        outsider.accessToken,
        forbidden.code,
      ),
    );
    await rejected(f, "MCP shared forged project URI", () =>
      rpc(
        "MCP shared forged project URI",
        "resources/read",
        { uri: uri.replace(f.projectId, foreign.id) },
        people.shared.accessToken,
        mismatch.code,
      ),
    );
  }
  for (const name of ["list", "metrics", "modules"]) {
    const result = await invoke(
      f.lane,
      `shared valid other-project ${name}`,
      readDescriptor(f, name, foreign.id),
      people.shared,
      foreign.id,
    );
    check(`${f.lane} shared request remains in explicit other project ${name}`, () => {
      if (name === "list")
        assert.ok(
          result.items.every((item) => item.projectId === foreign.id && item.id !== f.bugId),
        );
      else assert.equal(result.projectId, foreign.id);
    });
  }
  f.unbound = await upload(f.lane, f.projectId, randomUUID());
  f.commentSubmissionId = randomUUID();
  for (const name of ["edit", "comment", "bind", "manual", "delete"]) {
    const current = await invoke(
      "HTTP",
      `${name} version`,
      readDescriptor(f, "detail"),
      people.shared,
      f.projectId,
    );
    await rejected(f, `${f.lane} non-member ${name} write`, () =>
      invoke(
        f.lane,
        `non-member ${name} write`,
        writeDescriptor(f, name, current.version),
        outsider,
        f.projectId,
        forbidden,
      ),
    );
    await rejected(f, `${f.lane} shared mismatched-project ${name} write`, () =>
      invoke(
        f.lane,
        `shared mismatched-project ${name} write`,
        writeDescriptor(f, name, current.version, foreign.id),
        people.shared,
        foreign.id,
        mismatch,
      ),
    );
    const result = await invoke(
      f.lane,
      `positive ${name} write`,
      writeDescriptor(f, name, current.version),
      people.shared,
      f.projectId,
    );
    if (name === "bind") {
      const replay = await invoke(
        f.lane,
        "positive binding reservation durable replay",
        writeDescriptor(f, name, current.version),
        people.shared,
        f.projectId,
      );
      check(
        "binding reservation persisted once with the same identity",
        () => {
          assert.equal(result.replayed, false);
          assert.equal(replay.replayed, true);
          assert.deepEqual({ ...replay, replayed: false }, result);
        },
        {
          projectId: f.projectId,
          attachmentId: f.unbound.attachmentId,
          bindingId: result.bindingId,
        },
      );
      f.reservation = {
        bindingId: result.bindingId,
        attachmentId: result.attachmentId,
        status: result.status,
        intent: result.intent,
        version: result.version,
      };
    }
    if (name === "delete") {
      f.deletedAt = result.deletedAt;
      await invoke(
        "HTTP",
        "deleted Bug direct read denied",
        readDescriptor(f, "detail"),
        people.shared,
        f.projectId,
        mismatch,
      );
      const list = await invoke(
        "HTTP",
        "deleted Bug absent from owner list",
        readDescriptor(f, "list"),
        people.shared,
        f.projectId,
      );
      check(
        "positive deletion persisted",
        () => assert.ok(!list.items.some((item) => item.id === f.bugId)),
        { bugId: f.bugId },
      );
    } else {
      const after = await snapshot(f, `positive ${name}`);
      check(
        `positive ${name} persisted`,
        () => {
          if (name === "edit") {
            assert.equal(after.detail.description, `Valid edit ${runId}`);
            assert.equal(after.detail.version, current.version + 1);
          }
          if (name === "comment")
            assert.equal(
              after.comments.items.filter(
                (item) =>
                  item.clientSubmissionId === f.commentSubmissionId ||
                  item.id === result.comment.id,
              ).length,
              1,
            );
          if (name === "manual") {
            assert.equal(after.detail.state, "ready_for_verification");
            assert.ok(after.detail.version > current.version);
          }
          if (name === "bind") {
            assert.equal(result.projectId, f.projectId);
            assert.equal(result.attachmentId, f.unbound.attachmentId);
            assert.equal(result.leaseGeneration, 1);
          }
          assert.ok(after.events.items.every((item) => item.actor.id === people.shared.userId));
        },
        { bugId: f.bugId },
      );
    }
  }
  console.log(
    JSON.stringify({
      phase: "fixture_complete",
      lane: f.lane,
      projectId: f.projectId,
      bugId: f.bugId,
      requests: records.length,
    }),
  );
}
try {
  const ready = await wire("API readiness", api, "/api/v1/health/ready");
  assert.equal(ready.status, "ready");
  assert.equal(String(ready.schemaVersion), "14");
  assert.equal((await wire("server MCP readiness", mcp, "/health")).status, "ready");
  const initialized = await rpc("initialize", "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "project-isolation-live", version: "1.0" },
  });
  assert.equal(initialized.protocolVersion, "2025-06-18");
  assert.equal(
    await wire("initialized notification", mcp, "/mcp", {
      method: "POST",
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
      expect: expected(202),
    }),
    null,
  );
  const catalog = await rpc("tool inventory", "tools/list", {});
  for (const name of [
    "qa_create_bug",
    "qa_update_bug",
    "qa_add_comment",
    "qa_bind_attachment",
    "qa_bug_action",
    "qa_delete_bug",
    "qa_get_metrics",
    "qa_list_modules",
    "qa_read_attachment",
  ])
    assert.ok(catalog.tools.some((item) => item.name === name));
  const privateConfig = JSON.parse(readFileSync(config.secretsFile, "utf8"));
  assert.equal(typeof privateConfig.gmPassword, "string");
  assert.ok(privateConfig.gmPassword.length > 8);
  credentials.add(privateConfig.gmPassword);
  const gm = await wire("configured GM setup login", api, "/api/v1/auth/gm/login", {
    method: "POST",
    body: { password: privateConfig.gmPassword, client: "android" },
  });
  assert.equal(gm.isGm, true);
  for (const label of ["C", "D"]) {
    const id = randomUUID();
    const key = `ISO${label}${runId.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    assert.match(key, /^[A-Z][A-Z0-9]{1,15}$/u);
    const project = await wire(`create fresh project ${label}`, api, "/api/v1/gm/projects", {
      method: "POST",
      token: gm.accessToken,
      body: {
        id,
        key,
        name: `Isolation ${label} ${runId}`,
      },
      expect: expected(200),
    });
    assert.equal(project.id, id);
    projects.push({ ...project, label });
  }
  for (const project of projects) {
    const name = `IsolationOnly${project.label}${runId.replaceAll("-", "")}`;
    people[project.label] = await wire(
      `new ${project.label}-only employee`,
      api,
      "/api/v1/auth/login",
      { method: "POST", body: { name, projectId: project.id, client: "android" } },
    );
    const shared = await tool(`shared employee ${project.label} login`, "qa_login", {
      projectId: project.id,
      name: `IsolationShared${runId.replaceAll("-", "")}`,
    });
    if (people.shared) assert.equal(shared.userId, people.shared.userId);
    people.shared = shared;
    const components = await wire(
      `${project.label} all components off`,
      api,
      projectPath(project.id) + "/components",
      { token: gm.accessToken, projectId: project.id },
    );
    check(`${project.label} exactly five disabled components`, () => {
      assert.equal(components.items.length, 5);
      assert.ok(
        components.items.every((item) => item.enabled === false && item.status === "disabled"),
      );
    });
    const visible = await wire(
      `${project.label}-only membership readback`,
      api,
      "/api/v1/projects?limit=100",
      { token: people[project.label].accessToken },
    );
    assert.deepEqual(
      visible.items.map((item) => item.id),
      [project.id],
    );
  }
  const directory = await tool(
    "shared employee exact C/D membership",
    "qa_list_projects",
    {},
    people.shared.accessToken,
  );
  assert.deepEqual(
    directory.items.map((item) => item.id).sort(),
    projects.map((item) => item.id).sort(),
  );
  // Prepare all records first; every later denial reads a real existing authorized resource.
  for (const lane of ["HTTP", "MCP"])
    for (const project of projects) await createFixture(lane, project.id);
  console.log(
    JSON.stringify({
      phase: "fixtures_ready",
      runId,
      projects: projects.map(({ id, label }) => ({ id, label })),
      fixtures: fixtures.length,
    }),
  );
  for (const fixture of fixtures) await testFixture(fixture);
  passed = true;
} catch (error) {
  failure = redact({ name: error.name, message: error.message, stack: error.stack });
  process.exitCode = 1;
} finally {
  const summary = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    sourceHead: "cb9454b195071e78b006dab5cdac1b8a900a1b9c",
    instanceId: config.instanceId,
    passed,
    failure,
    requestCount: records.length,
    assertionCount: assertions.length,
    projects,
    people: Object.fromEntries(
      Object.entries(people).map(([label, person]) => [
        label,
        { userId: person.userId, projectId: person.projectId },
      ]),
    ),
    fixtures,
    assertions,
    boundaries: {
      api,
      mcp,
      componentsOff:
        projects.length === 2 &&
        assertions.filter((item) => item.label.endsWith("exactly five disabled components"))
          .length === 2,
      noDesktopOrUiCalls: true,
      noComponentExecutionRoutes: true,
      noServiceControl: true,
      noDatabaseWritesOutsideOfficialApi: true,
    },
    unexecuted: [
      "Component task logs: no independent Bug raw-log route exists; events and attachments are not substituted for task logs",
      "APK, EXE, Web UI and local MCP entrypoints",
      "External component execution and callback isolation",
    ],
  };
  writeFileSync(join(output, "summary.json"), safeJson(summary) + "\n", { flag: "wx" });
  console.log(
    JSON.stringify({
      passed,
      requests: records.length,
      assertions: assertions.length,
      evidence: output,
      ...(failure ? { failure } : {}),
    }),
  );
}
