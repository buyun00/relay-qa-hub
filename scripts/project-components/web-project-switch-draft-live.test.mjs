import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  classifyRequest,
  ProjectSwitchResponseLedger,
  solidPng,
  draftSignature,
  validateExecutionGate,
  fixtureMemberIds,
  EXPECTED_WEB,
  WEB,
} from "./web-project-switch-draft-live.mjs";

test("member expectation includes only authenticated project creator and exact fresh employees", () => {
  assert.deepEqual(fixtureMemberIds("gm-id", "shared-id", "only-A-id"), [
    "gm-id",
    "only-A-id",
    "shared-id",
  ]);
  assert.notDeepEqual(
    fixtureMemberIds("gm-id", "shared-id", "only-A-id"),
    fixtureMemberIds("gm-id", "shared-id", "only-B-id"),
  );
  assert.throws(() => fixtureMemberIds(undefined, "shared-id", "only-id"));
  assert.throws(() => fixtureMemberIds("shared-id", "shared-id", "only-id"));
});

const A = "9758686d-90ed-47c0-9d9f-7835a7d8ff2c",
  B = "eb61a4ca-5168-4fa5-aeeb-edb1794b4a18",
  actor = "988dc35a-c197-4d4f-99ad-d400271c6814";
const scope = { projectIds: [A, B], actorId: actor, employee: "SyntheticSharedFixture" };
const req = (path, id = A, extra = {}) => ({
  url: WEB + path,
  method: "GET",
  headers: { "X-Qa-Project-Id": id },
  ...extra,
});

test("default command does not require config or open operational resources", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./web-project-switch-draft-live.mjs", import.meta.url)),
      "missing-config.json",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^not_run:/u);
  assert.equal(result.stderr, "");
});
test("exact A and B read queries and scoped header are accepted", () => {
  for (const id of [A, B]) {
    assert.deepEqual(classifyRequest(req(`/api/v1/projects/${id}/members?limit=100`, id), scope), {
      kind: "members",
      projectId: id,
    });
    assert.deepEqual(classifyRequest(req(`/api/v1/projects/${id}/components`, id), scope), {
      kind: "components",
      projectId: id,
    });
    assert.deepEqual(
      classifyRequest(req(`/api/v1/bugs?projectId=${id}&limit=100&ownerId=${actor}`, id), scope),
      { kind: "bugs", projectId: id },
    );
    assert.equal(classifyRequest(req(`/?projectId=${id}`, id), scope).kind, "document");
  }
  assert.equal(classifyRequest(req("/api/v1/auth/me", A, { headers: {} }), scope).kind, "session");
  for (const [path] of EXPECTED_WEB)
    assert.equal(classifyRequest(req("/" + path), scope).kind, "static");
  assert.equal(
    classifyRequest(
      { url: WEB.replace("http:", "blob:http:") + "/synthetic", method: "GET" },
      scope,
    ).kind,
    "local",
  );
});
test("project/header mismatch, extra query, other origin and writes are refused", () => {
  assert.throws(
    () => classifyRequest(req(`/api/v1/projects/${A}/members?limit=100`, B), scope),
    /BROWSER_PROJECT_REFUSED/u,
  );
  for (const path of [
    `/api/v1/projects/${A}/members?limit=500`,
    `/api/v1/projects/${A}/members?limit=100&limit=100`,
    `/api/v1/projects/other/members?limit=100`,
    `/api/v1/bugs?projectId=${B}&limit=100&ownerId=other`,
    `/api/v1/bugs/another`,
    `/api/v1/projects/${B}/production/outbox`,
  ])
    assert.throws(() => classifyRequest(req(path, B), scope));
  assert.throws(
    () => classifyRequest(req("/", A, { url: "http://127.0.0.1:4319/" }), scope),
    /BROWSER_ORIGIN_REFUSED/u,
  );
  for (const path of [
    "/api/v1/bugs",
    "/api/v1/uploads",
    `/api/v1/bugs/id/comments`,
    `/api/v1/projects/${A}/components`,
    `/api/v1/production/batches`,
  ])
    assert.throws(
      () => classifyRequest(req(path, A, { method: "POST", postData: "{}" }), scope),
      /BROWSER_MUTATION_REFUSED/u,
    );
});
test("browser permits only initial shared A login, never B recovery or sentinel login", () => {
  const body = { name: scope.employee, projectId: A, client: "web" };
  assert.equal(
    classifyRequest(
      req("/api/v1/auth/login", A, { method: "POST", postData: JSON.stringify(body) }),
      scope,
    ).kind,
    "login",
  );
  for (const changed of [
    { ...body, projectId: B },
    { ...body, name: "OnlyA" },
    { ...body, client: "android" },
    { ...body, extra: true },
  ])
    assert.throws(() =>
      classifyRequest(
        req("/api/v1/auth/login", A, { method: "POST", postData: JSON.stringify(changed) }),
        scope,
      ),
    );
});

function fixture(call = async () => undefined) {
  let now = 10;
  const rows = [];
  const ledger = new ProjectSwitchResponseLedger(
    call,
    (row) => rows.push(row),
    () => now,
  );
  ledger.pause({
    requestId: "fetch-A",
    networkId: "network-A",
    projectId: A,
    status: 200,
    sha256: "real-body",
  });
  return {
    ledger,
    rows,
    time: (value) => {
      now = value;
    },
  };
}
test("only correlated canceled=true after switch plus verified B can consume A pause", async () => {
  const calls = [];
  const { ledger, rows, time } = fixture(async (...args) => calls.push(args));
  time(20);
  ledger.beginSwitch(A, B);
  time(30);
  ledger.noteNetworkFailure({
    requestId: "network-A",
    canceled: true,
    errorText: "net::ERR_ABORTED",
  });
  ledger.verifyProject(B);
  assert.equal(await ledger.release("fetch-A", "late-release", true), "canceled");
  assert.equal(calls.length, 0);
  assert.equal(ledger.entries.size, 0);
  assert.equal(rows[0].action, "expected_project_switch_cancellation");
  assert.equal(rows[0].failure.networkId, "network-A");
  assert.equal(rows[0].failure.canceled, true);
});
for (const [label, event] of [
  ["wrong Network id", { requestId: "another", canceled: true }],
  ["canceled false", { requestId: "network-A", canceled: false }],
  ["missing canceled", { requestId: "network-A" }],
]) {
  test(`CDP failure is not hidden by ${label}`, async () => {
    const { ledger, time } = fixture(async () => {
      throw new Error("real CDP refusal");
    });
    time(20);
    ledger.beginSwitch(A, B);
    time(30);
    ledger.noteNetworkFailure(event);
    ledger.verifyProject(B);
    await assert.rejects(ledger.release("fetch-A", "late-release", true), /real CDP refusal/u);
    assert.equal(ledger.entries.size, 1);
  });
}
test("earlier cancellation or unverified B cannot legitimize release failure", async () => {
  for (const earlier of [true, false]) {
    const { ledger, time } = fixture(async () => {
      throw new Error("release failed");
    });
    if (earlier) ledger.noteNetworkFailure({ requestId: "network-A", canceled: true });
    time(20);
    ledger.beginSwitch(A, B);
    time(30);
    if (earlier) ledger.verifyProject(B);
    else ledger.noteNetworkFailure({ requestId: "network-A", canceled: true });
    await assert.rejects(ledger.release("fetch-A", "late", true), /release failed/u);
    assert.equal(ledger.entries.size, 1);
  }
});
test("default cleanup cannot accept even a known cancellation without explicit allowance", async () => {
  const { ledger, time } = fixture(async () => {
    throw new Error("closed interception");
  });
  time(20);
  ledger.beginSwitch(A, B);
  time(30);
  ledger.noteNetworkFailure({ requestId: "network-A", canceled: true });
  ledger.verifyProject(B);
  await assert.rejects(ledger.release("fetch-A"), /closed interception/u);
  assert.equal(ledger.entries.size, 1);
});
test("successful original continuation stays distinct from cancellation", async () => {
  const calls = [];
  const { ledger, rows } = fixture(async (...args) => calls.push(args));
  assert.equal(await ledger.release("fetch-A", "release_unmodified", true), "continued");
  assert.deepEqual(calls, [["Fetch.continueRequest", { requestId: "fetch-A" }]]);
  assert.equal(rows[0].action, "release_unmodified");
});
test("unrelated B cancellation never settles old A response", async () => {
  const { ledger, time } = fixture(async () => {
    throw new Error("unmatched failure");
  });
  time(20);
  ledger.beginSwitch(A, B);
  time(30);
  ledger.noteNetworkFailure({ requestId: "network-B", canceled: true });
  ledger.verifyProject(B);
  await assert.rejects(ledger.releaseAll("cleanup", true), /REAL_RESPONSE_RELEASE_FAILED/u);
  assert.equal(ledger.entries.size, 1);
});
test("concurrent release is deduplicated and failed entries do not prevent other attempts", async () => {
  let finish;
  const calls = [];
  const { ledger } = fixture(async (_method, params) => {
    calls.push(params.requestId);
    if (params.requestId === "fetch-A")
      await new Promise((resolve) => {
        finish = resolve;
      });
    else throw new Error("other failure");
  });
  ledger.pause({ requestId: "fetch-B", networkId: "network-B", projectId: B, status: 200 });
  const first = ledger.release("fetch-A"),
    second = ledger.release("fetch-A");
  await Promise.resolve();
  assert.deepEqual(calls, ["fetch-A"]);
  finish();
  await Promise.all([first, second]);
  await assert.rejects(ledger.releaseAll("finally"));
  assert.deepEqual(calls, ["fetch-A", "fetch-B"]);
  assert.deepEqual([...ledger.entries.keys()], ["fetch-B"]);
});
test("new PNGs decode as deterministic distinct 16x16 RGB data", () => {
  const decode = (bytes) => {
    assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    let at = 8,
      data;
    while (at < bytes.length) {
      const size = bytes.readUInt32BE(at),
        type = bytes.subarray(at + 4, at + 8).toString();
      if (type === "IHDR") {
        assert.equal(bytes.readUInt32BE(at + 8), 16);
        assert.equal(bytes.readUInt32BE(at + 12), 16);
      }
      if (type === "IDAT") data = inflateSync(bytes.subarray(at + 8, at + 8 + size));
      at += 12 + size;
    }
    assert.equal(at, bytes.length);
    return data;
  };
  const red = solidPng(220, 40, 40),
    blue = solidPng(30, 90, 220);
  assert(red.equals(solidPng(220, 40, 40)));
  assert(!red.equals(blue));
  const data = decode(red);
  assert.equal(data.length, 16 * 49);
  assert.deepEqual([...data.subarray(0, 4)], [0, 220, 40, 40]);
  assert.deepEqual([...decode(blue).subarray(0, 4)], [0, 30, 90, 220]);
  assert.throws(() => solidPng(-1, 0, 0));
});
test("draft signature retains text, selected people and actual file hashes", () => {
  const row = {
    newContent: "A draft",
    newOwnerId: "A-only",
    newVerifierId: actor,
    newFiles: [{ name: "A.png", type: "image/png", size: 80, sha256: "A-hash" }],
    createOpen: true,
  };
  const before = JSON.stringify(row),
    signature = draftSignature(row);
  assert.deepEqual(signature, draftSignature({ ...row, createOpen: false }));
  assert.notDeepEqual(signature, draftSignature({ ...row, newContent: "B draft" }));
  assert.notDeepEqual(signature, draftSignature({ ...row, newOwnerId: "B-only" }));
  assert.notDeepEqual(
    signature,
    draftSignature({ ...row, newFiles: [{ ...row.newFiles[0], sha256: "B-hash" }] }),
  );
  assert.equal(JSON.stringify(row), before);
});
test("execution gate requires source/instance/publication pins and explicit process identities", () => {
  const gate = {
    schemaVersion: 1,
    status: "reviewed_web_project_switch_draft",
    runnerSha256: "synthetic-source-hash",
    webBundleSha256: EXPECTED_WEB[0][2],
    instanceSha256: "2b8e97ce9b62d072b74eaf00015fb04f5b818d318203f2a91e59d15873da349b",
    api: { pid: 22852, startedAt: "2026-09-09T01:22:20.2728640Z", schemaVersion: 14 },
    web: { pid: 20284, startedAt: "2026-09-08T17:52:36.5080910Z" },
    publicationProof: {
      sha256: "0ec3abdbdbe85e1d3ab79155a8dcc2f31c21e999e634834ddb488000e90cff63",
    },
  };
  validateExecutionGate(gate, "synthetic-source-hash");
  for (const value of [
    { ...gate, runnerSha256: "changed" },
    { ...gate, instanceSha256: "changed" },
    { ...gate, api: { ...gate.api, pid: 0 } },
    { ...gate, web: { ...gate.web, startedAt: "unknown" } },
    { ...gate, publicationProof: { sha256: "different" } },
  ])
    assert.throws(() => validateExecutionGate(value, "synthetic-source-hash"));
});
