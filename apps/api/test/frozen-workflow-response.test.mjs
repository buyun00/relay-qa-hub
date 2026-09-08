import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { createApiApp } from "../dist/app.js";
import { MOBILE_API_MEDIA_TYPE } from "../dist/mobile-bugs.js";

// These tests exercise registered HTTP handlers with immutable, rich store DTOs.
// They test response compatibility, not legacy request support or SQLite persistence.
const contractRoot = new URL("../../../packages/contracts/", import.meta.url);
const readJson = (url) => JSON.parse(readFileSync(url, "utf8"));
const examples = readJson(
  new URL("versions/1.1.0/examples/openapi-examples.json", contractRoot),
).operations;
const openapis = ["openapi/openapi.json", "versions/1.1.0/openapi/openapi.json"].map((path) => {
  const url = new URL(path, contractRoot);
  return { url, document: readJson(url) };
});
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  allowUnionTypes: true,
});
addFormats(ajv);
ajv.addKeyword({ keyword: "x-max-utf8-bytes", schemaType: "number" });
ajv.addKeyword({ keyword: "x-sensitive-key-policy", schemaType: "string" });
for (const name of [
  "common",
  "bug",
  "event-envelope",
  "relay",
  "upload",
  "workflow",
  "build",
  "notification",
  "api",
]) {
  ajv.addSchema(readJson(new URL(`schemas/${name}.schema.json`, contractRoot)));
}
ajv.addSchema(readJson(new URL("versions/1.1.0/schemas/app-first.schema.json", contractRoot)));

function operationIn(contract, operationId) {
  for (const [path, item] of Object.entries(contract.document.paths)) {
    if (item.post?.operationId === operationId) return { path, operation: item.post };
  }
  assert.fail(`Missing registered contract operation ${operationId}`);
}

function responseValidator(contract, operationId, media) {
  const { operation } = operationIn(contract, operationId);
  const success = operation.responses[String(examples[operationId].status)];
  const ref = success.content[media].schema.$ref;
  const schemaUrl = new URL(ref, contract.url);
  const fragment = schemaUrl.hash;
  schemaUrl.hash = "";
  return ajv.compile({ $ref: `${readJson(schemaUrl).$id}${fragment}` });
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const attemptFacts = {
  patchUrl: "https://fixture.invalid/repair.patch",
  noCodeReason: "Historical repair required only a configuration change.",
  failureReason: "Historical delivery failed its first validation.",
};
const verificationFacts = {
  failureReason: "The original obscured action remains reproducible.",
  blockedReason: "Historical verification waited for an independent test device.",
};
const operations = [
  {
    id: "createRepairAttempt",
    store: "relay",
    method: "createManualAttempt",
    target: "bugId",
    scope: "bug",
    facts: attemptFacts,
  },
  {
    id: "startRepairAttempt",
    store: "relay",
    method: "startManualAttempt",
    target: "attemptId",
    scope: "attempt",
    facts: attemptFacts,
  },
  {
    id: "deliverRepairAttempt",
    store: "relay",
    method: "deliverManualAttempt",
    target: "attemptId",
    scope: "attempt",
    facts: attemptFacts,
  },
  {
    id: "createVerification",
    store: "verification",
    method: "createVerification",
    target: "bugId",
    scope: "bug",
    facts: verificationFacts,
  },
  {
    id: "startVerification",
    store: "verification",
    method: "startVerification",
    target: "verificationId",
    scope: "verification",
    facts: verificationFacts,
  },
  {
    id: "recordVerificationResult",
    store: "verification",
    method: "recordResult",
    target: "verificationId",
    scope: "verification",
  },
];
const richResponses = Object.fromEntries(
  operations.map(({ id, facts }) => {
    const response = structuredClone(examples[id].response);
    if (facts) Object.assign(response, facts);
    else {
      Object.assign(response.repairAttempt, attemptFacts);
      Object.assign(response.verification, verificationFacts);
    }
    return [id, deepFreeze(response)];
  }),
);
const resultFixture = richResponses.recordVerificationResult;
const actorId = resultFixture.verification.verifierId;
const projectId = resultFixture.bug.projectId;
const token = "frozen-workflow-response-fixture-only";
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": MOBILE_API_MEDIA_TYPE,
  "x-qa-actor-id": actorId,
  "x-qa-project-id": projectId,
};
const richWorkflow = deepFreeze({
  bugId: resultFixture.bug.id,
  repairAttempt: resultFixture.repairAttempt,
  buildRequirement: null,
  build: null,
  verification: resultFixture.verification,
  latestVerification: resultFixture.verification,
  relayRework: null,
  relayAcceptance: null,
});

function createFixture(t) {
  const calls = [];
  const stores = { relay: {}, verification: {} };
  for (const entry of operations) {
    stores[entry.store][entry.method] = async (command) => {
      calls.push({ operationId: entry.id, command });
      return richResponses[entry.id];
    };
  }
  stores.relay.getRepairAttempt = async () => resultFixture.repairAttempt;
  stores.verification.getVerification = async () => resultFixture.verification;
  const app = createApiApp({
    logger: false,
    debugBearerToken: token,
    debugActorId: actorId,
    mobileRelayStore: stores.relay,
    mobileVerificationStore: stores.verification,
    mobileHumanWorkflowStore: { getForBug: async () => richWorkflow },
  });
  t.after(() => app.close());
  return { app, calls };
}

function assertSchema(validate, body, context) {
  assert.equal(validate(body), true, `${context}: ${JSON.stringify(validate.errors)}`);
}

test("frozen response schemas reject every nonempty rich DTO extension", () => {
  for (const entry of operations.filter((item) => item.facts)) {
    for (const contract of openapis) {
      const validate = responseValidator(contract, entry.id, "application/json");
      assertSchema(validate, examples[entry.id].response, entry.id);
      for (const [key, value] of Object.entries(entry.facts)) {
        assert.equal(typeof value, "string");
        assert.ok(value.length > 0);
        assert.equal(
          validate({ ...examples[entry.id].response, [key]: value }),
          false,
          `${entry.id}: ${key} must be rejected`,
        );
        assert.ok(
          validate.errors.some(
            (error) =>
              error.keyword === "additionalProperties" && error.params.additionalProperty === key,
          ),
        );
      }
    }
  }
});

const acceptCases = [
  { label: "default", accept: undefined, media: MOBILE_API_MEDIA_TYPE },
  { label: "wildcard keeps current default", accept: "*/*", media: MOBILE_API_MEDIA_TYPE },
  { label: "explicit vendor", accept: MOBILE_API_MEDIA_TYPE, media: MOBILE_API_MEDIA_TYPE },
  { label: "legacy JSON", accept: "application/json", media: "application/json" },
  {
    label: "vendor preferred over JSON",
    accept: `${MOBILE_API_MEDIA_TYPE},application/json;q=.9`,
    media: MOBILE_API_MEDIA_TYPE,
  },
  {
    label: "JSON has higher quality",
    accept: `${MOBILE_API_MEDIA_TYPE};q=.5,application/json;q=.9`,
    media: "application/json",
  },
  {
    label: "equal quality puts JSON first",
    accept: `application/json;q=.8,${MOBILE_API_MEDIA_TYPE};q=.8`,
    media: "application/json",
  },
  {
    label: "equal quality puts vendor first",
    accept: `${MOBILE_API_MEDIA_TYPE};q=.8,application/json;q=.8`,
    media: MOBILE_API_MEDIA_TYPE,
  },
];

for (const entry of operations) {
  for (const acceptCase of acceptCases) {
    test(`${entry.id}: ${acceptCase.label} returns its frozen wire response without modifying history`, async (t) => {
      const { app, calls } = createFixture(t);
      const example = examples[entry.id];
      const { path } = operationIn(openapis[1], entry.id);
      const url = `/api/v1${path.replace(/\{([^}]+)\}/gu, (_, key) => example.pathParameters[key])}`;
      const targetId = example.pathParameters[entry.target];
      const attemptSegment =
        entry.id === "createVerification" ? `:attempt:${example.request.repairAttemptId}` : "";
      const idempotencyKey = `workflow:${entry.id}:${entry.scope}:${targetId}${attemptSegment}:v${example.request.expectedVersion}`;
      const response = await app.inject({
        method: "POST",
        url,
        headers: {
          ...headers,
          "idempotency-key": idempotencyKey,
          ...(acceptCase.accept ? { accept: acceptCase.accept } : {}),
        },
        payload: structuredClone(example.request),
      });
      assert.equal(response.statusCode, example.status, response.body);
      assert.equal(response.headers["content-type"].split(";")[0], acceptCase.media);
      const body = response.json();
      assertSchema(
        responseValidator(openapis[1], entry.id, acceptCase.media),
        body,
        `1.1 ${entry.id}`,
      );
      if (acceptCase.media === "application/json" || entry.id !== "recordVerificationResult") {
        assertSchema(
          responseValidator(openapis[0], entry.id, "application/json"),
          body,
          `1.0 ${entry.id}`,
        );
      }
      if (entry.id === "recordVerificationResult" && acceptCase.media === "application/json") {
        const legacyBug = structuredClone(example.response.bug);
        assert.ok(legacyBug.moduleId);
        assert.ok(Object.hasOwn(example.response.bug, "duplicateOfBugId"));
        delete legacyBug.moduleId;
        delete legacyBug.duplicateOfBugId;
        assert.deepEqual(body, { verification: example.response.verification, bug: legacyBug });
        assert.equal(Object.hasOwn(body.bug, "moduleId"), false);
        assert.equal(Object.hasOwn(body.bug, "duplicateOfBugId"), false);
      } else {
        // The current vendor envelope, IDs, event/replay fields and native Bug remain intact.
        assert.deepEqual(body, example.response);
      }
      assert.equal(calls.length, 1);
      assert.equal(calls[0].operationId, entry.id);
      assert.equal(calls[0].command.actorId, actorId);
      assert.equal(calls[0].command[entry.target], targetId);
      assert.equal(calls[0].command.idempotencyKey, idempotencyKey);
      const unchanged = richResponses[entry.id];
      if (entry.facts) {
        for (const [key, value] of Object.entries(entry.facts)) assert.equal(unchanged[key], value);
      } else {
        for (const [key, value] of Object.entries(attemptFacts))
          assert.equal(unchanged.repairAttempt[key], value);
        for (const [key, value] of Object.entries(verificationFacts))
          assert.equal(unchanged.verification[key], value);
      }
    });
  }
}

for (const [name, path, expected] of [
  [
    "RepairAttempt detail",
    `/repair-attempts/${resultFixture.repairAttempt.id}`,
    resultFixture.repairAttempt,
  ],
  [
    "Verification detail",
    `/verifications/${resultFixture.verification.id}`,
    resultFixture.verification,
  ],
  ["Bug human-workflow history", `/bugs/${resultFixture.bug.id}/human-workflow`, richWorkflow],
]) {
  test(`${name} keeps complete rich facts on its unfrozen GET`, async (t) => {
    const { app, calls } = createFixture(t);
    const response = await app.inject({ method: "GET", url: `/api/v1${path}`, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), expected);
    assert.equal(calls.length, 0, "historical reads must not invoke any workflow mutation");
  });
}
