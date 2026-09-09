import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  auditSnapshot,
  expectedProxySha256,
  optionalUpdateGetSha256,
} from "./android-recovery-proxy-audit.mjs";
import { createValidators, sha256 } from "./android-recovery-proxy.mjs";

// Memory-only fixture: no private runner files, HTTP, device, socket or business operation.
const expected = {
  runId: "a0000000-0000-4000-8000-000000000001",
  projectId: "a0000000-0000-4000-8000-000000000002",
  actorId: "a0000000-0000-4000-8000-000000000003",
};
const other = "a0000000-0000-4000-8000-000000000004";
const example = JSON.parse(
  readFileSync(
    new URL(
      "../../packages/contracts/versions/1.1.0/examples/openapi-examples.json",
      import.meta.url,
    ),
  ),
).operations.createBug;
const validators = createValidators();
const buffer = (value) => Buffer.from(JSON.stringify(value));
const parse = (value) => JSON.parse(value.toString());
function fixture() {
  const request = structuredClone(example.request);
  request.projectId = expected.projectId;
  request.attachmentIds = [];
  delete request.captureBundleId;
  request.description = "SYNTHETIC_PRIVATE_DRAFT_TEXT_NEVER_PUBLISH";
  const files = { "original-request.json": buffer(request) };
  const keySha256 = sha256(`submission:${request.clientSubmissionId}:commit`),
    bodySha256 = sha256(files["original-request.json"]);
  let sequence = 0;
  const events = [];
  const add = (value) =>
    events.push({ sequence: ++sequence, at: "2026-09-09T01:00:00Z", ...value });
  add({ kind: "listening", scriptSha256: expectedProxySha256 });
  add({
    kind: "native_bootstrap",
    status: 200,
    ordinal: 1,
    projectId: expected.projectId,
    actorId: expected.actorId,
  });
  add({ kind: "bug_list", status: 200 });
  add({ kind: "components", status: 200 });
  add({
    kind: "refused",
    code: "AUTH_FINGERPRINT_REFUSED",
    method: "GET",
    targetSha256: optionalUpdateGetSha256,
  });
  let canonicalIds;
  for (let index = 0; index < 5; index++) {
    const receipt = structuredClone(example.response);
    receipt.bug.projectId = expected.projectId;
    receipt.bug.reporterId = expected.actorId;
    receipt.bug.description = request.description;
    receipt.attachmentIds = [];
    receipt.captureBundleId = null;
    receipt.replayed = index > 0;
    canonicalIds = {
      bugId: receipt.bug.id,
      occurrenceId: receipt.occurrenceId,
      eventId: receipt.eventId,
      clientSubmissionId: receipt.clientSubmissionId,
    };
    const name = `upstream-create-${index + 1}.body`;
    files[name] = buffer(receipt);
    add({
      kind: "native_create",
      ordinal: index + 1,
      action: index < 4 ? "drop_before_headers" : "forward_valid_201",
      upstreamStatus: 201,
      keySha256,
      bodySha256,
      responseSha256: sha256(files[name]),
      privateReceipt: name,
      ...canonicalIds,
    });
  }
  files["public-events.jsonl"] = Buffer.from(
    events.map((value) => JSON.stringify(value)).join("\n") + "\n",
  );
  files["status.json"] = buffer({
    ...expected,
    schemaVersion: 1,
    scriptSha256: expectedProxySha256,
    phase: "confirmed",
    inFlightCreate: false,
    inFlightAuthentication: false,
    dropped: 4,
    forwardedCreates: 5,
    proxyRetries: 0,
    emptyProjectObserved: true,
    componentsOffObserved: true,
    authenticationBound: true,
    target: { clientSubmissionId: request.clientSubmissionId, keySha256, bodySha256 },
    receipt: canonicalIds,
    denied: 1,
    bootstrapCount: 1,
    requests: events.length - 1,
  });
  files["confirm-native-action.json"] = buffer({
    runId: expected.runId,
    keySha256,
    bodySha256,
    explicitNativeAction: true,
  });
  return files;
}
function changeJson(files, name, change) {
  const value = parse(files[name]);
  change(value);
  files[name] = buffer(value);
}
function changeEvents(files, change) {
  const rows = files["public-events.jsonl"].toString().trim().split("\n").map(JSON.parse);
  change(rows);
  files["public-events.jsonl"] = Buffer.from(
    rows.map((value) => JSON.stringify(value)).join("\n") + "\n",
  );
}

test("valid artifact lineage audits four drops plus explicit same-request canonical confirmation without exposing text", () => {
  const files = fixture();
  const report = auditSnapshot(files, expected, validators);
  assert.equal(report.status, "passed");
  assert.ok(report.checks.every((check) => check.passed));
  assert.equal(report.actions.length, 5);
  assert.equal(report.sourceArtifacts.length, 9);
  assert.equal(report.refusals.expectedOptionalUpdateGet, 1);
  assert.equal(
    JSON.stringify(report).includes("SYNTHETIC_PRIVATE_DRAFT_TEXT_NEVER_PUBLISH"),
    false,
  );
  assert.equal(report.limits.numberOfAllServerBugsProven, false);
  assert.equal(report.limits.nativeGestureProvenByArtifactsAlone, false);
});

test("optional update classification is one exact observed method/code/path hash", () => {
  assert.equal(
    optionalUpdateGetSha256,
    "3ad87b1ad8b878338b28824a3aa4ef321b346681ad3ac6b2ff72b7e8036f2740",
  );
  for (const patch of [
    { method: "POST" },
    { code: "OTHER_REFUSAL" },
    { targetSha256: "f".repeat(64) },
  ]) {
    const files = fixture();
    changeEvents(files, (rows) =>
      Object.assign(
        rows.find((row) => row.kind === "refused"),
        patch,
      ),
    );
    const report = auditSnapshot(files, expected, validators);
    assert.equal(report.status, "failed");
    assert.equal(report.refusals.unexpected, 1);
  }
});

test("status scope, source, terminal phase, counters and original fingerprints cannot be substituted", () => {
  for (const patch of [
    { projectId: other },
    { actorId: other },
    { runId: other },
    { scriptSha256: "f".repeat(64) },
    { phase: "awaiting_native_retry" },
    { dropped: 3 },
    { forwardedCreates: 6 },
    { proxyRetries: 1 },
    { inFlightCreate: true },
    { emptyProjectObserved: false },
    { target: { bodySha256: "f".repeat(64) } },
  ]) {
    const files = fixture();
    changeJson(files, "status.json", (value) => Object.assign(value, patch));
    assert.equal(auditSnapshot(files, expected, validators).status, "failed");
  }
});

test("canonical IDs, scoped actor, content, frozen schema and raw receipt hash remain independently checked", () => {
  for (const change of [
    (value) => {
      value.bug.id = other;
    },
    (value) => {
      value.occurrenceId = other;
    },
    (value) => {
      value.bug.projectId = other;
    },
    (value) => {
      value.bug.reporterId = other;
    },
    (value) => {
      value.bug.description = "CHANGED_PRIVATE_TEXT";
    },
    (value) => {
      value.extra = "FORBIDDEN";
    },
    (value) => {
      value.replayed = false;
    },
  ]) {
    const files = fixture();
    changeJson(files, "upstream-create-5.body", change);
    // Even updating the public event hash cannot hide a semantically different receipt.
    changeEvents(files, (rows) => {
      rows.find((row) => row.kind === "native_create" && row.ordinal === 5).responseSha256 = sha256(
        files["upstream-create-5.body"],
      );
    });
    assert.equal(auditSnapshot(files, expected, validators).status, "failed");
  }
});

test("changed original request or operator marker fails even with unchanged request identifiers", () => {
  for (const mutate of [
    (files) => {
      files["original-request.json"] = Buffer.from(files["original-request.json"].toString() + " ");
    },
    (files) =>
      changeJson(files, "original-request.json", (value) => {
        value.description = "MODIFIED_DRAFT";
      }),
    (files) =>
      changeJson(files, "confirm-native-action.json", (value) => {
        value.explicitNativeAction = false;
      }),
    (files) =>
      changeJson(files, "confirm-native-action.json", (value) => {
        value.runId = other;
      }),
    (files) =>
      changeJson(files, "confirm-native-action.json", (value) => {
        value.extra = true;
      }),
  ]) {
    const files = fixture();
    mutate(files);
    assert.equal(auditSnapshot(files, expected, validators).status, "failed");
  }
});

test("missing/reordered/extra create events and mismatched action or sequence cannot pass", () => {
  for (const change of [
    (rows) => {
      rows.splice(
        rows.findIndex((row) => row.kind === "native_create"),
        1,
      );
    },
    (rows) => {
      rows.find((row) => row.kind === "native_create").action = "forward_valid_201";
    },
    (rows) => {
      rows[rows.length - 1].sequence = 1;
    },
    (rows) => {
      rows[rows.length - 1].bodySha256 = "f".repeat(64);
    },
    (rows) => {
      rows.push({ ...rows.at(-1), sequence: 50 });
    },
  ]) {
    const files = fixture();
    changeEvents(files, change);
    assert.equal(auditSnapshot(files, expected, validators).status, "failed");
  }
});

test("raw secret-like event additions are never copied into failed public output", () => {
  const files = fixture();
  changeEvents(files, (rows) => {
    rows.push({
      sequence: 99,
      at: "2026-09-09T01:00:00Z",
      kind: "unknown",
      authorization: "Bearer SYNTHETIC_PRIVATE_TOKEN_ONLY",
      body: "SYNTHETIC_RAW_PRIVATE_BODY",
    });
  });
  const report = auditSnapshot(files, expected, validators);
  assert.equal(report.status, "failed");
  assert.equal(JSON.stringify(report).includes("SYNTHETIC_PRIVATE_TOKEN_ONLY"), false);
  assert.equal(JSON.stringify(report).includes("SYNTHETIC_RAW_PRIVATE_BODY"), false);
});
