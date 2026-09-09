import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DroppedReceiptRun,
  createValidators,
  runtimeRoot,
  sha256,
  validateConfig,
  vendor,
} from "./android-recovery-proxy.mjs";

// No HTTP server, fetch, adb, subprocess, production DB, socket or runtime directory is used here.
const token = "synthetic-native-token-only-for-memory-tests";
const runId = "a0000000-0000-4000-8000-000000000001";
const projectId = "a0000000-0000-4000-8000-000000000002";
const actorId = "a0000000-0000-4000-8000-000000000003";
const otherId = "a0000000-0000-4000-8000-000000000004";
const config = {
  schemaVersion: 1,
  mode: "drop-create-201",
  runId,
  projectId,
  actorId,
  bearerTokenSha256: sha256(token),
  bootstrapName: null,
  listenHost: "127.0.0.1",
  listenPort: 4559,
  apiOrigin: "http://127.0.0.1:4419",
  privateRunDirectory: resolve(runtimeRoot, `android-recovery-proxy-${runId}`),
  scriptSha256: "f".repeat(64),
  requestTimeoutMs: 1000,
  maxRunMs: 600000,
  maxRequests: 100,
};
const example = JSON.parse(
  readFileSync(
    new URL(
      "../../packages/contracts/versions/1.1.0/examples/openapi-examples.json",
      import.meta.url,
    ),
  ),
).operations.createBug;
const validators = createValidators();
function sample() {
  const request = structuredClone(example.request);
  request.projectId = projectId;
  request.attachmentIds = [];
  delete request.captureBundleId;
  const receipt = structuredClone(example.response);
  receipt.bug.projectId = projectId;
  receipt.bug.reporterId = actorId;
  receipt.attachmentIds = [];
  receipt.captureBundleId = null;
  return { request, receipt };
}
function createInput(request = sample().request) {
  return {
    method: "POST",
    target: "/api/v1/bugs",
    body: Buffer.from(JSON.stringify(request)),
    headers: {
      authorization: `Bearer ${token}`,
      accept: vendor,
      "content-type": vendor,
      "x-qa-actor-id": actorId,
      "idempotency-key": `submission:${request.clientSubmissionId}:commit`,
    },
  };
}
function getInput(target) {
  return {
    method: "GET",
    target,
    body: Buffer.alloc(0),
    headers: { authorization: `Bearer ${token}`, accept: vendor },
  };
}
function response(body, status = 200) {
  return { status, headers: { "content-type": vendor }, body: Buffer.from(JSON.stringify(body)) };
}
function fixture(overrides = {}) {
  const records = [],
    files = new Map(),
    forwarded = [],
    effects = new Map();
  let marker = null;
  const run = new DroppedReceiptRun(overrides.config ?? config, {
    validators,
    forward: async (input) => {
      forwarded.push(input);
      if (overrides.forward) return overrides.forward(input);
      if (input.method === "POST") {
        const key = input.headers["idempotency-key"];
        const prior = effects.get(key);
        if (prior) assert.deepEqual(input.body, prior);
        effects.set(key, Buffer.from(input.body));
        const receipt = sample().receipt;
        receipt.replayed =
          effects.size === 1 && forwarded.filter((x) => x.method === "POST").length > 1;
        return response(receipt, 201);
      }
      if (input.target.endsWith("/components"))
        return response({
          projectId,
          items: Array.from({ length: 5 }, (_, i) => ({ key: `component-${i}`, enabled: false })),
        });
      if (input.target.startsWith("/api/v1/bugs?"))
        return response({ items: [], nextCursor: null });
      return response({});
    },
    savePrivate: (name, bytes) => {
      if (overrides.savePrivate) overrides.savePrivate(name, bytes);
      assert.equal(files.has(name), false);
      files.set(name, Buffer.from(bytes));
    },
    record: (value) => records.push(value),
    confirmation: () => marker,
  });
  return {
    run,
    records,
    files,
    forwarded,
    effects,
    setConfirmation(value) {
      marker = value;
    },
    arm() {
      const target = run.status().target;
      marker = {
        runId,
        keySha256: target.keySha256,
        bodySha256: target.bodySha256,
        explicitNativeAction: true,
      };
    },
  };
}
async function prepare(f) {
  assert.equal(
    (await f.run.handle(getInput(`/api/v1/bugs?projectId=${projectId}&limit=100`))).action,
    "forward",
  );
  assert.equal(
    (await f.run.handle(getInput(`/api/v1/projects/${projectId}/components`))).action,
    "forward",
  );
}

test("configuration is explicit, pinned to preview and a unique outside-Git private run", () => {
  assert.deepEqual(validateConfig(config), config);
  for (const patch of [
    { listenHost: "0.0.0.0" },
    { listenPort: 4419 },
    { listenPort: 4319 },
    { apiOrigin: "http://127.0.0.1:4319" },
    { apiOrigin: "https://example.invalid" },
    { mode: "corrupt-protocol" },
    { projectId: "not-a-project" },
    { privateRunDirectory: process.cwd() },
    { privateRunDirectory: resolve(runtimeRoot, "../other") },
    { bearerTokenSha256: token },
    { scriptSha256: "missing" },
    { maxRunMs: 0 },
    { requestTimeoutMs: 60000 },
    { maxRequests: 10000 },
    { extraFallback: "forbidden" },
  ])
    assert.throws(() => validateConfig({ ...config, ...patch }));
});

test("four real-function matching 201 decisions, then explicit native request, keep one effect/key/body", async () => {
  const f = fixture();
  await prepare(f);
  const input = createInput();
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(await f.run.handle(input), { action: "drop" });
    assert.equal(f.run.status().dropped, i + 1);
    assert.equal(f.files.has(`upstream-create-${i + 1}.body`), true);
  }
  assert.equal(f.run.status().phase, "awaiting_explicit_native_confirmation");
  const callsBefore = f.forwarded.length;
  f.arm();
  await Promise.resolve(); // Arming and observing status do not initiate outbound traffic.
  f.run.status();
  f.run.status();
  assert.equal(f.forwarded.length, callsBefore);
  const final = await f.run.handle(input);
  assert.equal(final.action, "forward");
  assert.equal(final.status, 201);
  assert.equal(f.run.status().phase, "confirmed");
  assert.equal(f.effects.size, 1);
  assert.equal(f.files.size, 6);
  assert.deepEqual(f.files.get("original-request.json"), input.body);
  assert.equal(f.forwarded.filter((x) => x.method === "POST").length, 5);
  assert.ok(
    f.forwarded
      .filter((x) => x.method === "POST")
      .every(
        (x) =>
          x.headers["idempotency-key"] === input.headers["idempotency-key"] &&
          x.body.equals(input.body),
      ),
  );
  assert.equal(f.records.filter((x) => x.action === "drop_before_headers").length, 4);
  assert.equal(f.records.filter((x) => x.action === "forward_valid_201").length, 1);
  assert.equal(JSON.stringify(f.records).includes(token), false);
  assert.equal(JSON.stringify(f.records).includes(sample().request.description), false);
});

test("fifth request without the explicit matching marker is refused and never forwarded", async () => {
  for (const marker of [
    null,
    {},
    { runId: otherId, explicitNativeAction: true },
    { runId, keySha256: "0".repeat(64), bodySha256: "0".repeat(64), explicitNativeAction: true },
  ]) {
    const f = fixture();
    await prepare(f);
    for (let i = 0; i < 4; i++) await f.run.handle(createInput());
    f.setConfirmation(marker);
    assert.equal((await f.run.handle(createInput())).code, "EXPLICIT_NATIVE_CONFIRMATION_REQUIRED");
    assert.equal(f.forwarded.filter((x) => x.method === "POST").length, 4);
    assert.equal(f.run.status().phase, "failed");
  }
});

test("first create requires observed empty scoped project and all-disabled components", async () => {
  const f = fixture();
  assert.equal((await f.run.handle(createInput())).code, "READINESS_OBSERVATIONS_REQUIRED");
  assert.equal(f.forwarded.length, 0);
  for (const body of [
    { projectId, items: [{ enabled: true }] },
    { projectId: otherId, items: Array(5).fill({ enabled: false }) },
  ]) {
    const bad = fixture({ forward: async () => response(body) });
    assert.equal(
      (await bad.run.handle(getInput(`/api/v1/projects/${projectId}/components`))).code,
      "COMPONENTS_MUST_STAY_DISABLED",
    );
    assert.equal(bad.run.status().phase, "failed");
  }
  const bad = fixture({
    forward: async () => response({ items: [{ projectId, id: otherId }], nextCursor: null }),
  });
  assert.equal(
    (await bad.run.handle(getInput(`/api/v1/bugs?projectId=${projectId}`))).code,
    "FRESH_EMPTY_PROJECT_REQUIRED",
  );
});

test("unrelated mutations, project/actor/auth changes, encoded paths and binary uploads have zero forwarding", async () => {
  const original = createInput();
  const inputs = [
    { ...original, target: "/api/v1/production/batches" },
    { ...original, target: "/api/v1/uploads/init" },
    { ...original, target: "/api/v1/auth/login" },
    { ...original, target: "/api/v1/bugs?extra=1" },
    { ...original, target: "http://127.0.0.1:4319/api/v1/bugs" },
    { ...original, target: "/api/v1/%62ugs" },
    {
      ...original,
      headers: { ...original.headers, authorization: "Bearer other-synthetic-token" },
    },
    { ...original, headers: { ...original.headers, "x-qa-actor-id": otherId } },
    { ...original, headers: { ...original.headers, "x-qa-project-id": otherId } },
    { ...original, headers: { ...original.headers, cookie: "synthetic-private-cookie" } },
    createInput({ ...sample().request, projectId: otherId }),
    createInput({ ...sample().request, attachmentIds: [otherId] }),
    getInput(`/api/v1/bugs?projectId=${projectId}&projectId=${otherId}`),
    getInput(`/api/v1/bugs?projectId=${otherId}`),
    getInput(`/api/v1/projects/${otherId}/users`),
    getInput(`/api/v1/bugs/${otherId}`),
  ];
  for (const input of inputs) {
    const f = fixture();
    const out = await f.run.handle(input);
    assert.equal(out.action, "reject");
    assert.equal(f.forwarded.length, 0);
  }
});

test("once captured, another key, whitespace or changed form cannot replace the original intent", async () => {
  for (const change of [
    (input) => ({ ...input, body: Buffer.from(input.body.toString() + " ") }),
    () => createInput({ ...sample().request, description: "new unsubmitted edit" }),
    () => createInput({ ...sample().request, clientSubmissionId: otherId }),
  ]) {
    const f = fixture();
    await prepare(f);
    const original = createInput();
    await f.run.handle(original);
    assert.equal((await f.run.handle(change(original))).code, "ORIGINAL_INTENT_CHANGED");
    assert.equal(f.forwarded.filter((x) => x.method === "POST").length, 1);
    assert.deepEqual(f.files.get("original-request.json"), original.body);
  }
});

test("every malformed or foreign real-function receipt is retained privately but never counted as a drop", async () => {
  const valid = sample().receipt;
  const cases = [
    response(valid, 200),
    response(valid, 302),
    response({ ...valid, clientSubmissionId: otherId }, 201),
    response({ ...valid, bug: { ...valid.bug, projectId: otherId } }, 201),
    response({ ...valid, bug: { ...valid.bug, reporterId: otherId } }, 201),
    response({ ...valid, qaItem: { ...valid.qaItem, id: otherId } }, 201),
    response({ ...valid, attachmentIds: [otherId] }, 201),
    response({ ...valid, bug: { ...valid.bug, ownerId: otherId } }, 201),
    response({ ...valid, extra: "not in frozen schema" }, 201),
    { ...response(valid, 201), headers: { "content-type": "application/json" } },
    { ...response(valid, 201), body: Buffer.from("invalid") },
  ];
  for (const upstream of cases) {
    const f = fixture();
    await prepare(f);
    f.run.io.forward = async () => upstream;
    assert.equal((await f.run.handle(createInput())).action, "reject");
    assert.equal(f.run.status().dropped, 0);
    assert.equal(f.run.status().phase, "failed");
    assert.deepEqual(f.files.get("upstream-create-1.body"), upstream.body);
  }
});

test("same project and submission but different replay effect IDs stops the experiment", async () => {
  const f = fixture();
  await prepare(f);
  await f.run.handle(createInput());
  const receipt = sample().receipt;
  receipt.occurrenceId = otherId;
  f.run.io.forward = async () => response(receipt, 201);
  assert.equal((await f.run.handle(createInput())).code, "REPLAY_IDENTITY_CHANGED");
  assert.equal(f.run.status().dropped, 1);
});

test("private request persistence failure causes no outbound call; receipt failure causes no intentional drop", async () => {
  for (const failureName of ["original-request.json", "upstream-create-1.body"]) {
    const f = fixture({
      savePrivate: (name) => {
        if (name === failureName) throw new Error("synthetic disk error; no credential");
      },
    });
    await prepare(f);
    assert.equal((await f.run.handle(createInput())).action, "reject");
    assert.equal(f.run.status().dropped, 0);
    assert.equal(
      f.forwarded.filter((x) => x.method === "POST").length,
      failureName === "original-request.json" ? 0 : 1,
    );
  }
});

test("concurrent old native POST is never forwarded twice and cannot overwrite a failed experiment", async () => {
  const f = fixture();
  await prepare(f);
  let resolveForward;
  f.run.io.forward = () =>
    new Promise((resolvePromise) => {
      resolveForward = resolvePromise;
    });
  const first = f.run.handle(createInput());
  assert.equal((await f.run.handle(createInput())).code, "CONCURRENT_CREATE_REFUSED");
  resolveForward(response(sample().receipt, 201));
  assert.equal((await first).code, "RUN_FAILED_DURING_REQUEST");
  assert.equal(f.run.status().phase, "failed");
  assert.equal(f.run.status().dropped, 0);
  assert.equal(f.run.status().forwardedCreates, 1);
});

test("a disconnected client is not reported as the proxy successfully suppressing its receipt", async () => {
  const f = fixture();
  await prepare(f);
  const result = await f.run.handle({ ...createInput(), canDeliver: () => false });
  assert.equal(result.code, "CLIENT_ALREADY_DISCONNECTED");
  assert.equal(f.run.status().dropped, 0);
  assert.equal(f.files.has("upstream-create-1.body"), true);
});

test("known Bug reads stay bound to recorded receipt and status inspection never sends requests", async () => {
  const f = fixture();
  await prepare(f);
  await f.run.handle(createInput());
  const total = f.forwarded.length;
  const state = f.run.status();
  assert.equal(state.target.keySha256, sha256(createInput().headers["idempotency-key"]));
  assert.equal(state.proxyRetries, 0);
  assert.equal(state.apkUiGestureProven, false);
  assert.equal(f.forwarded.length, total);
  assert.equal((await f.run.handle(getInput(`/api/v1/bugs/${otherId}/comments`))).action, "reject");
  assert.equal(f.forwarded.length, total);
});

const bootstrapConfig = {
  ...config,
  bearerTokenSha256: null,
  bootstrapName: "SyntheticNativePerson",
};
const bootstrapInput = (patch = {}) => ({
  method: "POST",
  target: "/api/v1/auth/login",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: Buffer.from(
    JSON.stringify({ name: bootstrapConfig.bootstrapName, projectId, client: "android", ...patch }),
  ),
});
const session = (accessToken = "s".repeat(43)) => ({
  accountId: otherId,
  userId: actorId,
  displayName: bootstrapConfig.bootstrapName,
  projectId,
  isGm: false,
  accessToken,
  expiresAt: "2099-01-01T00:00:00Z",
});

test("optional exact native bootstrap forwards raw 200 but stores only an in-memory token digest", async () => {
  const f = fixture({ config: bootstrapConfig });
  f.run.io.forward = async () => response(session(), 200);
  const output = await f.run.handle(bootstrapInput());
  assert.equal(output.action, "forward");
  assert.deepEqual(JSON.parse(output.body), session());
  assert.equal(f.run.status().authenticationBound, true);
  assert.equal(f.run.status().bootstrapCount, 1);
  assert.equal(f.files.size, 0);
  assert.equal(JSON.stringify([f.records, f.run.status()]).includes(session().accessToken), false);
  assert.equal(
    JSON.stringify([f.records, f.run.status()]).includes(sha256(session().accessToken)),
    false,
  );
  f.run.io.forward = async () => response({ projectId, items: [] });
  assert.equal(
    (
      await f.run.handle({
        ...getInput(`/api/v1/projects/${projectId}/members?limit=100`),
        headers: { authorization: `Bearer ${session().accessToken}` },
      })
    ).action,
    "forward",
  );
  assert.equal((await f.run.handle(createInput())).code, "AUTH_FINGERPRINT_REFUSED");
});

test("bootstrap rejects altered login fields, GM, actor/project/account swaps and invalid tokens", async () => {
  for (const patch of [
    { name: "other" },
    { projectId: otherId },
    { client: "web" },
    { password: "synthetic-only" },
  ]) {
    const f = fixture({ config: bootstrapConfig });
    assert.equal((await f.run.handle(bootstrapInput(patch))).action, "reject");
    assert.equal(f.forwarded.length, 0);
  }
  for (const patch of [
    { isGm: true },
    { userId: otherId },
    { projectId: otherId },
    { displayName: "other" },
    { accountId: "bad" },
    { accessToken: "bad" },
    { expiresAt: "2000-01-01T00:00:00Z" },
  ]) {
    const f = fixture({
      config: bootstrapConfig,
      forward: async () => response({ ...session(), ...patch }),
    });
    assert.equal((await f.run.handle(bootstrapInput())).action, "reject");
    assert.equal(f.run.status().authenticationBound, false);
    assert.equal(f.files.size, 0);
    assert.equal(JSON.stringify(f.records).includes(session().accessToken), false);
  }
  const f = fixture({ config: bootstrapConfig, forward: async () => response(session()) });
  await f.run.handle(bootstrapInput());
  f.run.io.forward = async () => response({ ...session("r".repeat(43)), accountId: projectId });
  assert.equal((await f.run.handle(bootstrapInput())).code, "BOOTSTRAP_IDENTITY_REFUSED");
});

test("code22 to code23 same-identity relogin rotates only the token binding and keeps original request", async () => {
  const f = fixture({ config: bootstrapConfig });
  const originalForward = f.run.io.forward;
  let nextToken = "s".repeat(43);
  f.run.io.forward = (input) =>
    input.target.endsWith("/auth/login")
      ? Promise.resolve(response(session(nextToken)))
      : originalForward(input);
  await f.run.handle(bootstrapInput());
  const nativeHeaders = () => ({ authorization: `Bearer ${nextToken}` });
  await f.run.handle({
    ...getInput(`/api/v1/bugs?projectId=${projectId}&limit=100`),
    headers: nativeHeaders(),
  });
  await f.run.handle({
    ...getInput(`/api/v1/projects/${projectId}/components`),
    headers: nativeHeaders(),
  });
  const input = createInput();
  input.headers.authorization = `Bearer ${nextToken}`;
  for (let i = 0; i < 4; i++) assert.equal((await f.run.handle(input)).action, "drop");
  const originalTarget = f.run.status().target;
  nextToken = "r".repeat(43);
  assert.equal((await f.run.handle(bootstrapInput())).action, "forward");
  assert.deepEqual(f.run.status().target, originalTarget);
  assert.equal((await f.run.handle(input)).code, "AUTH_FINGERPRINT_REFUSED");
  input.headers.authorization = `Bearer ${nextToken}`;
  f.arm();
  assert.equal((await f.run.handle(input)).action, "forward");
  assert.equal(f.run.status().phase, "confirmed");
  assert.equal(f.effects.size, 1);
  await f.run.handle(bootstrapInput());
  assert.equal((await f.run.handle(bootstrapInput())).code, "BOOTSTRAP_LIMIT_OR_BUSY");
});

test("scoped public entry and project list support native establish without exposing other projects", async () => {
  const f = fixture({
    config: bootstrapConfig,
    forward: async () => response({ id: projectId, active: true }),
  });
  assert.equal(
    (await f.run.handle({ ...getInput(`/api/v1/project-entry/${projectId}`), headers: {} })).action,
    "forward",
  );
  assert.equal(
    (await f.run.handle({ ...getInput(`/api/v1/project-entry/${otherId}`), headers: {} })).action,
    "reject",
  );
  const other = fixture({
    forward: async () =>
      response({ items: [{ id: projectId }, { id: otherId }], nextCursor: null }),
  });
  assert.equal(
    (await other.run.handle(getInput("/api/v1/projects?limit=100"))).code,
    "READ_PROJECT_REFUSED",
  );
});

test("overlapping native refresh waits for committed identity instead of rejecting a legitimate new Bug", async () => {
  const f = fixture();
  await prepare(f);
  let complete;
  let reads = 0;
  f.run.io.forward = (input) =>
    input.method === "POST"
      ? new Promise((resolvePromise) => {
          complete = resolvePromise;
        })
      : (reads++, Promise.resolve(response({ items: [sample().receipt.bug], nextCursor: null })));
  const creating = f.run.handle(createInput());
  const reading = f.run.handle(getInput(`/api/v1/bugs?projectId=${projectId}&limit=100`));
  assert.equal(reads, 0);
  complete(response(sample().receipt, 201));
  assert.equal((await creating).action, "drop");
  assert.equal((await reading).action, "forward");
  assert.equal(reads, 1);
});

test("unknown exception text and token-shaped strings cannot enter public diagnostics", async () => {
  const f = fixture();
  await prepare(f);
  const syntheticSecret = "SYNTHETIC_SECRET_VALUE_NOT_FOR_PUBLIC_LOGS";
  f.run.io.forward = async () => {
    throw new Error(syntheticSecret);
  };
  const output = await f.run.handle(createInput());
  assert.equal(output.code, "PROXY_OPERATION_FAILED");
  assert.equal(
    JSON.stringify([output, f.records, f.run.status()]).includes(syntheticSecret),
    false,
  );
});

test("native component page users limit500 is exact-scoped and cannot admit foreign response scope", async () => {
  const user = {
    userId: actorId,
    displayName: "SyntheticNativePerson",
    status: "active",
    membershipStatus: "active",
    membershipVersion: 1,
    identity: "employee",
  };
  const f = fixture({ forward: async () => response({ projectId, items: [user] }) });
  assert.equal(
    (await f.run.handle(getInput(`/api/v1/projects/${projectId}/users?limit=500`))).action,
    "forward",
  );
  for (const target of [
    `/api/v1/projects/${projectId}/users?limit=100`,
    `/api/v1/projects/${projectId}/users?limit=500&extra=1`,
    `/api/v1/projects/${otherId}/users?limit=500`,
  ]) {
    const bad = fixture();
    assert.equal((await bad.run.handle(getInput(target))).action, "reject");
    assert.equal(bad.forwarded.length, 0);
  }
  for (const body of [
    { projectId: otherId, items: [user] },
    { projectId, items: [{ ...user, projectId: otherId }] },
    { projectId, items: [{ ...user, accountId: otherId }] },
  ]) {
    const bad = fixture({ forward: async () => response(body) });
    assert.equal(
      (await bad.run.handle(getInput(`/api/v1/projects/${projectId}/users?limit=500`))).code,
      "READ_PROJECT_REFUSED",
    );
  }
});
