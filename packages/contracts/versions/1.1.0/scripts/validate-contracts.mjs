import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import SwaggerParser from "@apidevtools/swagger-parser";
import { evaluateContractBehavior } from "../../../src/evaluate-contract-behavior.mjs";
import {
  ALLOWED_MACHINE_PROJECTION_ACTIONS,
  APP_FIRST_LIMITS,
  ARTIFACT_MEDIA_TYPES,
  canonicalChunkRequestEnvelope,
  canonicalNonSecretRequestDigest,
  canonicalString,
  canonicalReplayDigest,
  deriveEnrichmentStatus,
  evaluateAppFirstBehavior,
} from "../src/evaluate-app-first-behavior.mjs";

const versionRoot = fileURLToPath(new URL("..", import.meta.url));
const contractRoot = path.resolve(versionRoot, "..", "..");

async function readJson(absolutePath) {
  return JSON.parse(await readFile(absolutePath, "utf8"));
}

const baseSchemaNames = [
  "common.schema.json",
  "bug.schema.json",
  "event-envelope.schema.json",
  "relay.schema.json",
  "upload.schema.json",
  "workflow.schema.json",
  "build.schema.json",
  "notification.schema.json",
  "api.schema.json",
];

const [
  manifest,
  appSchema,
  criticalScenarios,
  behaviorMatrix,
  openApiExamples,
  baseCriticalScenarios,
  baseBehaviorMatrix,
  baseManifest,
  baseOpenapi,
  baseErrors,
  deltaErrors,
] = await Promise.all([
  readJson(path.join(versionRoot, "src", "api-manifest.json")),
  readJson(path.join(versionRoot, "schemas", "app-first.schema.json")),
  readJson(path.join(versionRoot, "examples", "critical-scenarios.json")),
  readJson(path.join(versionRoot, "semantics", "behavior-scenarios.json")),
  readJson(path.join(versionRoot, "examples", "openapi-examples.json")),
  readJson(path.join(contractRoot, "examples", "critical-scenarios.json")),
  readJson(path.join(contractRoot, "semantics", "behavior-scenarios.json")),
  readJson(path.join(contractRoot, "src", "api-manifest.json")),
  readJson(path.join(contractRoot, "openapi", "openapi.json")),
  readJson(path.join(contractRoot, "errors", "error-codes.json")),
  readJson(path.join(versionRoot, "errors", "error-codes.json")),
]);

const baseSchemas = await Promise.all(
  baseSchemaNames.map((name) => readJson(path.join(contractRoot, "schemas", name))),
);

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  allowUnionTypes: true,
});
addFormats(ajv);
ajv.addKeyword({ keyword: "x-max-utf8-bytes", schemaType: "number" });
ajv.addKeyword({ keyword: "x-sensitive-key-policy", schemaType: "string" });
for (const schema of baseSchemas) ajv.addSchema(schema);
ajv.addSchema(appSchema);

const failures = [];
const testServerPepper = "contract-test-only-server-pepper-000000000001";

function attachSignedPageFacts(
  input,
  {
    operationId,
    query,
    response,
    normalizedFilters,
    orderedItemIds,
    orderedSortKeys,
    scope,
    limit,
    membershipRevision,
    cursorLastSortKey = "!",
  },
) {
  input.membershipRevision = membershipRevision;
  const authorizedProjectIds = [...input.authorizedProjectIds].sort();
  input.pageAuthorizationFacts = authorizedProjectIds.map((projectId) => ({
    accountId: input.accountId,
    actorId: input.actorId,
    projectId,
    membershipRevision,
    currentActive: true,
  }));
  const membershipSetDigest = canonicalNonSecretRequestDigest(
    `${operationId}:membership-set`,
    {
      accountId: input.accountId,
      actorId: input.actorId,
      membershipRevision,
    },
    authorizedProjectIds,
    "membership",
  );
  const filterDigest = canonicalNonSecretRequestDigest(
    `${operationId}:filters`,
    { accountId: input.accountId, actorId: input.actorId, ...scope },
    normalizedFilters,
    "filters",
  );
  const cursorScopeDigest = canonicalNonSecretRequestDigest(
    `${operationId}:cursor-scope`,
    {
      accountId: input.accountId,
      actorId: input.actorId,
      membershipRevision,
      membershipSetDigest,
      filterDigest,
      snapshotSequence: response.snapshotSequence,
      ...scope,
    },
    { limit },
    "cursor",
  );
  const queryDigest = canonicalNonSecretRequestDigest(
    operationId,
    {
      accountId: input.accountId,
      actorId: input.actorId,
      membershipRevision,
      membershipSetDigest,
      ...scope,
    },
    query,
    "query",
  );
  const lastSortKey = orderedSortKeys.length === 0 ? null : orderedSortKeys.at(-1);
  input.cursorFact =
    query.cursor == null
      ? null
      : {
          token: query.cursor,
          signatureValid: true,
          accountId: input.accountId,
          actorId: input.actorId,
          membershipRevision,
          membershipSetDigest,
          filterDigest,
          snapshotSequence: response.snapshotSequence,
          cursorScopeDigest,
          lastSortKey: cursorLastSortKey,
          applied: true,
        };
  input.nextCursorFact =
    response.nextCursor == null
      ? null
      : {
          token: response.nextCursor,
          signatureValid: true,
          accountId: input.accountId,
          actorId: input.actorId,
          membershipRevision,
          membershipSetDigest,
          filterDigest,
          snapshotSequence: response.snapshotSequence,
          cursorScopeDigest,
          lastSortKey,
          progress: true,
        };
  input.pageFact = {
    operationId,
    accountId: input.accountId,
    actorId: input.actorId,
    membershipRevision,
    membershipSetDigest,
    filterDigest,
    cursorScopeDigest,
    queryDigest,
    snapshotSequence: response.snapshotSequence,
    limit,
    cursor: query.cursor ?? null,
    nextCursor: response.nextCursor ?? null,
    cursorApplied: query.cursor != null,
    orderedItemIds: structuredClone(orderedItemIds),
    orderedSortKeys: structuredClone(orderedSortKeys),
    lastSortKey,
  };
  return input;
}

const contractMaximumDateEpoch = 8_640_000_000_000_000;

function contractAscendingDateSortKey(value) {
  return String(Date.parse(value)).padStart(16, "0");
}

function contractDescendingDateSortKey(value) {
  return String(contractMaximumDateEpoch - Date.parse(value)).padStart(16, "0");
}

function contractBugSortKey(bug, sort) {
  if (sort === "updated_desc") {
    return `${contractDescendingDateSortKey(bug.updatedAt)}:${bug.id}`;
  }
  if (sort === "created_desc") {
    return `${contractDescendingDateSortKey(bug.createdAt)}:${bug.id}`;
  }
  const priorityRank = { P0: "0", P1: "1", P2: "2", P3: "3", P4: "4" }[bug.priority];
  return `${priorityRank}:${contractDescendingDateSortKey(bug.updatedAt)}:${bug.id}`;
}

function attachWorkflowPageFacts(
  input,
  {
    query,
    response,
    collections,
    scope,
    limit,
    membershipRevision,
    previousWatermarks = null,
    previousHasMore = null,
    hasMore = null,
  },
) {
  const operationId = "getBugWorkflowProjection";
  input.membershipRevision = membershipRevision;
  const authorizedProjectIds = [...input.authorizedProjectIds].sort();
  input.pageAuthorizationFacts = authorizedProjectIds.map((projectId) => ({
    accountId: input.accountId,
    actorId: input.actorId,
    projectId,
    membershipRevision,
    currentActive: true,
  }));
  const membershipSetDigest = canonicalNonSecretRequestDigest(
    `${operationId}:membership-set`,
    { accountId: input.accountId, actorId: input.actorId, membershipRevision },
    authorizedProjectIds,
    "membership",
  );
  const filterDigest = canonicalNonSecretRequestDigest(
    `${operationId}:filters`,
    { accountId: input.accountId, actorId: input.actorId, ...scope },
    {},
    "filters",
  );
  const collectionNames = Object.keys(collections);
  const cursorScopeDigest = canonicalNonSecretRequestDigest(
    `${operationId}:cursor-scope`,
    {
      accountId: input.accountId,
      actorId: input.actorId,
      membershipRevision,
      membershipSetDigest,
      filterDigest,
      snapshotSequence: response.snapshotSequence,
      ...scope,
    },
    { collectionNames, limit },
    "cursor",
  );
  const queryDigest = canonicalNonSecretRequestDigest(
    operationId,
    {
      accountId: input.accountId,
      actorId: input.actorId,
      membershipRevision,
      membershipSetDigest,
      ...scope,
    },
    query,
    "query",
  );
  const prior =
    previousWatermarks ?? Object.fromEntries(collectionNames.map((name) => [name, null]));
  const priorHasMore =
    previousHasMore ?? Object.fromEntries(collectionNames.map((name) => [name, true]));
  const next = Object.fromEntries(
    collectionNames.map((name) => [name, collections[name].at(-1) ?? prior[name]]),
  );
  input.collectionHasMoreFact =
    hasMore ?? Object.fromEntries(collectionNames.map((name) => [name, false]));
  input.collectionPageFacts = Object.fromEntries(
    collectionNames.map((name) => [
      name,
      {
        accountId: input.accountId,
        actorId: input.actorId,
        projectId: scope.projectId,
        bugId: scope.bugId,
        snapshotSequence: response.snapshotSequence,
        afterSortKey: prior[name],
        returnedItemIds: structuredClone(collections[name]),
        hasMore: input.collectionHasMoreFact[name],
        queryExecuted: true,
      },
    ]),
  );
  input.cursorFact =
    query.cursor == null
      ? null
      : {
          token: query.cursor,
          signatureValid: true,
          accountId: input.accountId,
          actorId: input.actorId,
          membershipRevision,
          membershipSetDigest,
          filterDigest,
          snapshotSequence: response.snapshotSequence,
          cursorScopeDigest,
          lastSortKeys: structuredClone(prior),
          hasMore: structuredClone(priorHasMore),
          applied: true,
        };
  input.nextCursorFact =
    response.nextCursor == null
      ? null
      : {
          token: response.nextCursor,
          signatureValid: true,
          accountId: input.accountId,
          actorId: input.actorId,
          membershipRevision,
          membershipSetDigest,
          filterDigest,
          snapshotSequence: response.snapshotSequence,
          cursorScopeDigest,
          lastSortKeys: structuredClone(next),
          hasMore: structuredClone(input.collectionHasMoreFact),
          progress: true,
        };
  input.pageFact = {
    operationId,
    accountId: input.accountId,
    actorId: input.actorId,
    membershipRevision,
    membershipSetDigest,
    filterDigest,
    cursorScopeDigest,
    queryDigest,
    snapshotSequence: response.snapshotSequence,
    limitPerCollection: limit,
    cursor: query.cursor ?? null,
    nextCursor: response.nextCursor ?? null,
    cursorApplied: query.cursor != null,
    orderedItemIdsByCollection: structuredClone(collections),
    orderedSortKeysByCollection: structuredClone(collections),
    lastSortKeys: structuredClone(next),
    hasMore: structuredClone(input.collectionHasMoreFact),
  };
  return input;
}

function makeWorkflowRelationFacts(response, { accountId, projectId, bugId }) {
  const references = [
    ...response.occurrences.flatMap((item) => [
      ["occurrence", item.id, "reporter_user", item.reporterId],
      ...item.attachmentIds.map((id) => ["occurrence", item.id, "attachment", id]),
      ...(item.captureBundleId == null
        ? []
        : [["occurrence", item.id, "capture_bundle", item.captureBundleId]]),
    ]),
    ...response.repairAttempts.flatMap((item) => [
      ["repair_attempt", item.id, "assignee_user", item.assigneeId],
      ...(item.parentAttemptId == null
        ? []
        : [["repair_attempt", item.id, "parent_repair_attempt", item.parentAttemptId]]),
    ]),
    ...response.verifications.flatMap((item) => [
      ["verification", item.id, "repair_attempt", item.repairAttemptId],
      ["verification", item.id, "verifier_user", item.verifierId],
    ]),
    ...response.relayReceipts.map((item) => [
      "relay_receipt",
      `${item.repairAttemptId}:${item.handoffId}`,
      "repair_attempt",
      item.repairAttemptId,
    ]),
  ];
  return references.map(([referrerType, referrerId, relationType, entityId]) => ({
    accountId,
    projectId,
    bugId,
    referrerType,
    referrerId,
    relationType,
    entityId,
    relationValidated: true,
    ...(relationType.endsWith("_user")
      ? { sameAccountUser: true, projectIdentityValidated: true }
      : {}),
    ...(relationType === "attachment"
      ? { claimedByBug: true, visibleToActor: true }
      : {}),
    ...(relationType === "capture_bundle"
      ? { ownedByBug: true, visibleToActor: true }
      : {}),
    ...(["parent_repair_attempt", "repair_attempt"].includes(relationType)
      ? { sameBug: true }
      : {}),
  }));
}

function makeWorkflowBuildReferenceFacts(response, { accountId, projectId, bugId }) {
  return [
    ...response.occurrences
      .filter((item) => item.environment?.buildId != null)
      .map((item) => ["occurrence", item.id, null, item.environment.buildId]),
    ...response.repairAttempts
      .filter((item) => item.targetBuildId != null)
      .map((item) => ["repair_attempt", item.id, item.id, item.targetBuildId]),
    ...response.verifications
      .filter((item) => item.buildId != null)
      .map((item) => ["verification", item.id, item.repairAttemptId, item.buildId]),
    ...response.relayReceipts
      .filter((item) => item.buildId != null)
      .map((item) => [
        "relay_receipt",
        `${item.repairAttemptId}:${item.handoffId}`,
        item.repairAttemptId,
        item.buildId,
      ]),
  ].map(([referrerType, referrerId, repairAttemptId, buildId]) => ({
    accountId,
    projectId,
    bugId,
    referrerType,
    referrerId,
    repairAttemptId,
    buildId,
    relationValidated: true,
  }));
}

const criticalById = new Map(criticalScenarios.scenarios.map((scenario) => [scenario.id, scenario]));
const baseCriticalById = new Map(
  baseCriticalScenarios.scenarios.map((scenario) => [scenario.id, scenario]),
);

function decodePointer(pointer) {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`Invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function applyMutation(payload, mutation) {
  const segments = decodePointer(mutation.path);
  if (segments.length === 0) throw new Error("Root mutation is not supported");
  const key = segments.at(-1);
  const parent = segments.slice(0, -1).reduce((current, segment) => current[segment], payload);
  if (mutation.op === "remove") {
    delete parent[key];
  } else if (mutation.op === "replace" || mutation.op === "add") {
    parent[key] = structuredClone(mutation.value);
  } else {
    throw new Error(`Unsupported mutation: ${mutation.op}`);
  }
}

function resolveScenarioPayload(scenario, resolving = new Set()) {
  if (resolving.has(scenario.id)) throw new Error(`Scenario source cycle: ${scenario.id}`);
  resolving.add(scenario.id);
  let payload;
  if (scenario.payload !== undefined) {
    payload = structuredClone(scenario.payload);
  } else if (scenario.source?.operationId) {
    payload = structuredClone(
      openApiExamples.operations?.[scenario.source.operationId]?.[scenario.source.direction],
    );
  } else if (scenario.source?.baseScenarioId) {
    payload = structuredClone(baseCriticalById.get(scenario.source.baseScenarioId)?.payload);
  } else if (scenario.source?.scenarioId) {
    const sourceScenario = criticalById.get(scenario.source.scenarioId);
    if (!sourceScenario) throw new Error(`Unknown source scenario: ${scenario.source.scenarioId}`);
    payload = resolveScenarioPayload(sourceScenario, resolving);
  }
  resolving.delete(scenario.id);
  if (payload === undefined) throw new Error(`${scenario.id}: payload source did not resolve`);
  for (const mutation of scenario.mutations ?? []) applyMutation(payload, mutation);
  return payload;
}

const scenarioIds = new Set();
for (const scenario of criticalScenarios.scenarios) {
  if (scenarioIds.has(scenario.id)) failures.push(`Duplicate critical scenario: ${scenario.id}`);
  scenarioIds.add(scenario.id);
  let payload;
  try {
    payload = resolveScenarioPayload(scenario);
  } catch (error) {
    failures.push(`${scenario.id}: ${error.message}`);
    continue;
  }
  const validate = ajv.getSchema(scenario.schema);
  if (!validate) {
    failures.push(`${scenario.id}: schema not found: ${scenario.schema}`);
    continue;
  }
  const valid = validate(payload);
  if (valid !== scenario.expectedValid) {
    failures.push(
      `${scenario.id}: expected valid=${scenario.expectedValid}, got ${valid}: ${ajv.errorsText(validate.errors)}`,
    );
  }
}

const baseBehaviorById = new Map(
  baseBehaviorMatrix.scenarios.map((scenario) => [scenario.id, scenario]),
);
for (const id of behaviorMatrix.requiredBaseScenarioIds) {
  const scenario = baseBehaviorById.get(id);
  if (!scenario) {
    failures.push(`Required 1.0.0 behavior scenario missing: ${id}`);
    continue;
  }
  try {
    assert.deepStrictEqual(
      evaluateContractBehavior(scenario.kind, scenario.input),
      scenario.expected,
    );
  } catch (error) {
    failures.push(`${id}: inherited behavior changed: ${error.message}`);
  }
}

const behaviorIds = new Set();
for (const scenario of behaviorMatrix.scenarios) {
  if (behaviorIds.has(scenario.id)) failures.push(`Duplicate behavior scenario: ${scenario.id}`);
  behaviorIds.add(scenario.id);
  try {
    assert.deepStrictEqual(
      evaluateAppFirstBehavior(scenario.kind, scenario.input),
      scenario.expected,
    );
  } catch (error) {
    failures.push(`${scenario.id}: ${error.message}`);
  }
}

const combinedErrors = [...baseErrors.errors, ...deltaErrors.errors];
const errorByCode = new Map(combinedErrors.map((entry) => [entry.code, entry]));
const nativeBaseOperationIds = new Set(manifest.nativeBaseOperationIds);

let openapi;
try {
  const openApiPath = path.join(versionRoot, "openapi", "openapi.json");
  await SwaggerParser.validate(openApiPath, {
    resolve: {
      http: false,
      qaHubContractId: {
        order: 1,
        canRead: (file) => file.url.startsWith("https://qa-hub.local/contracts/"),
        read: async (file) => {
          const contractUrl = new URL(file.url);
          if (contractUrl.pathname === "/contracts/1.1.0/app-first.schema.json") {
            return readFile(path.join(versionRoot, "schemas", "app-first.schema.json"), "utf8");
          }
          const filename = path.posix.basename(contractUrl.pathname);
          if (!baseSchemaNames.includes(filename)) {
            throw new Error(`Unknown stable contract schema URL: ${file.url}`);
          }
          return readFile(path.join(contractRoot, "schemas", filename), "utf8");
        },
      },
    },
  });
  openapi = await readJson(openApiPath);
} catch (error) {
  failures.push(`OpenAPI validation failed: ${error.message}`);
}

function securityHasExactRequirement(security, names) {
  return security.some((requirement) => {
    const actual = Object.keys(requirement).sort();
    return actual.join("|") === [...names].sort().join("|");
  });
}

function resolveAppSchemaRef(reference) {
  const prefix = "../schemas/app-first.schema.json#";
  if (!reference?.startsWith(prefix)) return undefined;
  const pointer = reference.slice(prefix.length);
  return decodePointer(pointer).reduce((current, segment) => current?.[segment], appSchema);
}

function validateAppExample(reference, payload, label) {
  const prefix = "../schemas/app-first.schema.json#";
  const fragment = reference?.startsWith(prefix) ? reference.slice(prefix.length) : undefined;
  const validate = fragment ? ajv.getSchema(`${appSchema.$id}#${fragment}`) : undefined;
  if (!validate) {
    failures.push(`${label}: app schema ref did not resolve: ${reference}`);
    return;
  }
  if (!validate(payload)) {
    failures.push(`${label}: example is invalid: ${ajv.errorsText(validate.errors)}`);
  }
}

function validateStableExample(reference, payload, label) {
  const match = /^\.\.\/schemas\/([^#]+)(#.*)?$/.exec(reference ?? "");
  const schema = match ? baseSchemas.find((candidate) => candidate.$id.endsWith(`/${match[1]}`)) : null;
  const validate = schema ? ajv.getSchema(`${schema.$id}${match[2] ?? ""}`) : undefined;
  if (!validate) {
    failures.push(`${label}: stable schema ref did not resolve: ${reference}`);
    return;
  }
  if (!validate(payload)) {
    failures.push(`${label}: example is invalid: ${ajv.errorsText(validate.errors)}`);
  }
}

function groupedErrorCodes(errorCodes) {
  const grouped = new Map();
  for (const code of errorCodes ?? []) {
    const entry = errorByCode.get(code);
    if (!entry) continue;
    const codes = grouped.get(String(entry.status)) ?? [];
    codes.push(code);
    grouped.set(String(entry.status), codes);
  }
  return grouped;
}

function operationErrorCodes(errorCodes, operation) {
  return [
    ...(errorCodes ?? []),
    manifest.contentNegotiation.unsupportedAcceptErrorCode,
    ...(operation.requestBody
      ? [manifest.contentNegotiation.unsupportedContentTypeErrorCode]
      : []),
  ];
}

const expectedSecurityByMode = {
  none: [],
  "native-read": [{ nativeAccessToken: [] }],
  "native-write": [{ nativeAccessToken: [] }],
  "session-or-native-read": [{ sessionCookie: [] }, { nativeAccessToken: [] }],
  "session-or-native-write": [
    { sessionCookie: [], csrfHeader: [] },
    { nativeAccessToken: [] },
  ],
};

if (openapi) {
  if (openapi.openapi !== "3.1.0") failures.push(`Expected OpenAPI 3.1.0, got ${openapi.openapi}`);
  if (openapi["x-contract-version"] !== manifest.contractVersion) {
    failures.push("OpenAPI contract version does not match the 1.1.0 manifest.");
  }
  if (openapi["x-base-contract-version"] !== manifest.baseContractVersion) {
    failures.push("OpenAPI base contract version does not match 1.0.0.");
  }
  if (openapi.servers?.[0]?.url !== manifest.apiPrefix) {
    failures.push(`OpenAPI server prefix must be ${manifest.apiPrefix}.`);
  }
  if (openapi.components.securitySchemes.nativeAccessToken?.scheme !== "bearer") {
    failures.push("Native human bearer security scheme is missing.");
  }
  if (
    /relay|machine/i.test(
      openapi.components.securitySchemes.nativeAccessToken?.bearerFormat ?? "",
    )
  ) {
    failures.push("Native human bearer format is ambiguous with a machine credential.");
  }
  try {
    assert.deepStrictEqual(openapi["x-poco-transport-limits"], manifest.pocoTransport);
  } catch (error) {
    failures.push(`OpenAPI Poco transport limits drifted: ${error.message}`);
  }
  if (
    manifest.pocoTransport.host !== "127.0.0.1" ||
    JSON.stringify(manifest.pocoTransport.orderedFallbackPorts) !==
      JSON.stringify([5001, 5002, 5003, 5004, 5005]) ||
    !/configured.*first/i.test(manifest.pocoTransport.configuredPortPolicy) ||
    !/do not scan arbitrary ports/i.test(manifest.pocoTransport.configuredPortPolicy)
  ) {
    failures.push("Poco loopback/configured-port/5001..5005 probe order is not frozen.");
  }
  for (const [extension, expected] of [
    ["x-versioned-media-type", manifest.mediaType],
    ["x-android-platform", manifest.androidPlatform],
    ["x-content-negotiation", manifest.contentNegotiation],
    ["x-native-session-policy", manifest.nativeSessionPolicy],
    ["x-native-refresh-replay-policy", manifest.nativeRefreshReplayPolicy],
    ["x-offline-lease-policy", manifest.offlineLeasePolicy],
    ["x-occurrence-metadata-policy", manifest.occurrenceMetadataPolicy],
    ["x-audit-projection-policy", manifest.auditProjectionPolicy],
    ["x-stream-projection-policy", manifest.streamProjectionPolicy],
    ["x-attachment-download-policy", manifest.attachmentDownloadPolicy],
    ["x-capture-policy", manifest.capturePolicy],
    ["x-notification-policy", manifest.notificationPolicy],
    ["x-relay-projection-policy", manifest.relayProjectionPolicy],
    ["x-poco-snapshot-schema-versions", manifest.pocoSnapshotSchemaVersions],
    ["x-poco-privacy-policy", manifest.pocoPrivacyPolicy],
  ]) {
    try {
      assert.deepStrictEqual(openapi[extension], expected);
    } catch (error) {
      failures.push(`OpenAPI ${extension} drifted: ${error.message}`);
    }
  }
  try {
    assert.deepStrictEqual(manifest.androidPlatform, {
      minSdk: 35,
      compileSdk: 37,
      targetSdk: 37,
      pocoEndpoint: "127.0.0.1 in the same Android profile",
      accessLocalNetworkPermission:
        "must not be declared or requested solely for same-profile Poco loopback",
    });
    if (
      manifest.androidPlatform.minSdk > manifest.androidPlatform.targetSdk ||
      manifest.androidPlatform.targetSdk > manifest.androidPlatform.compileSdk
    ) {
      throw new Error("Android SDK ordering must satisfy minSdk <= targetSdk <= compileSdk");
    }
  } catch (error) {
    failures.push(`Android 35/37/37 platform baseline drifted: ${error.message}`);
  }
  for (const [schemaName, actualMinimum] of [
    ["nativeDeviceMetadata", appSchema.$defs.nativeDeviceMetadata.properties.androidApi.minimum],
    ["captureDeviceMetadata", appSchema.$defs.captureDeviceMetadata.properties.androidApi.minimum],
  ]) {
    if (actualMinimum !== manifest.androidPlatform.minSdk) {
      failures.push(
        `${schemaName}.androidApi minimum ${actualMinimum} does not equal manifest minSdk ${manifest.androidPlatform.minSdk}`,
      );
    }
  }
  for (const [limitName, manifestName] of [
    ["maxFrameBytes", "maxFrameBytes"],
    ["maxDecodedArtifactBytes", "maxDecodedArtifactBytes"],
    ["maxDecodedHierarchyBytes", "maxDecodedHierarchyBytes"],
    ["maxSnapshotSerializedBytes", "maxSnapshotSerializedBytes"],
    ["minPocoDeadlineMs", "minDeadlineMs"],
    ["maxPocoDeadlineMs", "maxDeadlineMs"],
  ]) {
    if (APP_FIRST_LIMITS[limitName] !== manifest.pocoTransport[manifestName]) {
      failures.push(
        `Executable Poco limit ${limitName} drifted from manifest.pocoTransport.${manifestName}`,
      );
    }
  }
  if (
    manifest.pocoPrivacyPolicy.version !== "1.0.0" ||
    manifest.pocoPrivacyPolicy.maxRecentErrorUtf8Bytes !==
      APP_FIRST_LIMITS.maxRecentErrorUtf8Bytes ||
    appSchema.$defs.pocoSnapshotData.properties.recentErrors["x-max-utf8-bytes"] !==
      APP_FIRST_LIMITS.maxRecentErrorUtf8Bytes
  ) {
    failures.push("Poco privacy version or recent-error UTF-8 byte ceiling drifted");
  }
  if (
    manifest.occurrenceMetadataPolicy.maxSerializedUtf8Bytes !==
      APP_FIRST_LIMITS.maxOccurrenceEnvironmentUtf8Bytes ||
    appSchema.$defs.nativeOccurrenceEnvironment["x-max-utf8-bytes"] !==
      APP_FIRST_LIMITS.maxOccurrenceEnvironmentUtf8Bytes ||
    JSON.stringify(manifest.occurrenceMetadataPolicy.allowedEnvironmentFields) !==
      JSON.stringify(Object.keys(appSchema.$defs.nativeOccurrenceEnvironment.properties))
  ) {
    failures.push("Occurrence metadata allowlist or executable UTF-8 byte ceiling drifted");
  }
  if (
    manifest.auditProjectionPolicy.maxPayloadSerializedUtf8Bytes !==
      APP_FIRST_LIMITS.maxAuditPayloadUtf8Bytes ||
    appSchema.$defs.nativeAuditPayload["x-max-utf8-bytes"] !==
      APP_FIRST_LIMITS.maxAuditPayloadUtf8Bytes ||
    JSON.stringify(manifest.auditProjectionPolicy.allowedPayloadFields) !==
      JSON.stringify(Object.keys(appSchema.$defs.nativeAuditPayload.properties))
  ) {
    failures.push("Native audit projection allowlist or executable UTF-8 byte ceiling drifted");
  }
  if (
    APP_FIRST_LIMITS.refreshReplayRetentionMs !==
    manifest.nativeRefreshReplayPolicy.retentionSeconds * 1000
  ) {
    failures.push("Executable refresh replay retention drifted from the manifest policy.");
  }
  for (const [limitName, manifestName] of [
    ["uploadSessionMaxTtlMs", "uploadSessionMaxTtlSeconds"],
    ["bindingLeaseMaxTtlMs", "bindingLeaseMaxTtlSeconds"],
  ]) {
    if (APP_FIRST_LIMITS[limitName] !== manifest.offlineLeasePolicy[manifestName] * 1000) {
      failures.push(`Executable lease limit ${limitName} drifted from manifest.offlineLeasePolicy`);
    }
  }
  try {
    assert.deepStrictEqual(ARTIFACT_MEDIA_TYPES, manifest.capturePolicy.allowedMediaTypesByKind);
  } catch (error) {
    failures.push(`Executable artifact media allowlist drifted: ${error.message}`);
  }
  for (const [limitName, manifestName] of [
    ["maxCaptureStartSkewMs", "maxStartSkewMs"],
    ["captureTimestampToleranceMs", "timestampToleranceMs"],
    ["maxScreenshotDurationMs", "maxScreenshotDurationMs"],
    ["maxRecordingDurationMs", "maxRecordingDurationMs"],
  ]) {
    if (APP_FIRST_LIMITS[limitName] !== manifest.capturePolicy[manifestName]) {
      failures.push(`Executable capture limit ${limitName} drifted from manifest.capturePolicy`);
    }
  }
  if (
    APP_FIRST_LIMITS.notificationTokenMaxFutureSkewMs !==
    manifest.notificationPolicy.tokenIssuedAtMaxFutureSkewSeconds * 1000
  ) {
    failures.push("Executable notification future-skew limit drifted from the manifest policy.");
  }
  try {
    assert.deepStrictEqual(
      [...APP_FIRST_LIMITS.supportedPocoSnapshotSchemaVersions],
      manifest.pocoSnapshotSchemaVersions,
    );
  } catch (error) {
    failures.push(`Executable Poco schema-version allowlist drifted: ${error.message}`);
  }
  try {
    assert.deepStrictEqual(
      [...ALLOWED_MACHINE_PROJECTION_ACTIONS],
      manifest.relayProjectionPolicy.allowedActions,
    );
  } catch (error) {
    failures.push(`Executable Relay action allowlist drifted: ${error.message}`);
  }
  const snapshotRequest = appSchema.$defs.pocoSnapshotRequest.properties;
  if (
    snapshotRequest.deadlineMs.minimum !== APP_FIRST_LIMITS.minPocoDeadlineMs ||
    snapshotRequest.deadlineMs.maximum !== APP_FIRST_LIMITS.maxPocoDeadlineMs ||
    !APP_FIRST_LIMITS.supportedPocoSnapshotSchemaVersions.includes(
      snapshotRequest.schemaVersion.const,
    ) ||
    appSchema.$defs.captureArtifact.properties.skewMs.maximum !==
      APP_FIRST_LIMITS.maxCaptureStartSkewMs
  ) {
    failures.push("Poco request/capture artifact schema limits drifted from executable limits.");
  }

  for (const definition of baseManifest.operations) {
    const operation = openapi.paths?.[definition.path]?.[definition.method];
    if (!operation || operation.operationId !== definition.operationId) {
      failures.push(`Base operation removed or changed: ${definition.operationId}`);
      continue;
    }
    if (!operation.responses?.[String(definition.status)]) {
      failures.push(`${definition.operationId}: base success status changed`);
    }
    for (const [status, code] of [
      ["406", manifest.contentNegotiation.unsupportedAcceptErrorCode],
      ...(operation.requestBody
        ? [["415", manifest.contentNegotiation.unsupportedContentTypeErrorCode]]
        : []),
    ]) {
      const response = operation.responses?.[status];
      if (
        JSON.stringify(response?.["x-error-codes"]) !== JSON.stringify([code]) ||
        JSON.stringify(response?.content?.[manifest.mediaType]?.["x-error-codes"]) !==
          JSON.stringify([code])
      ) {
        failures.push(`${definition.operationId}: typed ${status} negotiation error is missing`);
      }
    }
    const nativeEnabled = nativeBaseOperationIds.has(definition.operationId);
    const nativePolicy = manifest.nativeAuthorizationPolicies[definition.operationId];
    if (nativeEnabled) {
      if (!nativePolicy || operation["x-authorization-policy"] !== nativePolicy.authorizationPolicy) {
        failures.push(`${definition.operationId}: native authorization policy is missing or drifted`);
      }
      if (
        nativePolicy?.paginationPolicy &&
        operation["x-pagination-policy"] !== nativePolicy.paginationPolicy
      ) {
        failures.push(`${definition.operationId}: native pagination/cursor policy is missing or drifted`);
      }
    } else if (nativePolicy) {
      failures.push(`${definition.operationId}: native authorization policy exists outside the allowlist`);
    }
    if (definition.security === "session-read") {
      if (!securityHasExactRequirement(operation.security, ["sessionCookie"])) {
        failures.push(`${definition.operationId}: browser read authentication was removed`);
      }
      if (
        nativeEnabled &&
        !securityHasExactRequirement(operation.security, ["nativeAccessToken"])
      ) {
        failures.push(`${definition.operationId}: native human bearer alternative missing`);
      }
    }
    if (definition.security === "session-write") {
      if (!securityHasExactRequirement(operation.security, ["sessionCookie", "csrfHeader"])) {
        failures.push(`${definition.operationId}: browser Cookie+CSRF authentication was removed`);
      }
      if (
        nativeEnabled &&
        !securityHasExactRequirement(operation.security, ["nativeAccessToken"])
      ) {
        failures.push(`${definition.operationId}: native bearer write alternative missing`);
      }
    }
    if (
      !nativeEnabled &&
      securityHasExactRequirement(operation.security ?? [], ["nativeAccessToken"])
    ) {
      failures.push(`${definition.operationId}: native bearer was added outside the explicit allowlist`);
    }
    if (
      operation.security?.some(
        (requirement) =>
          "nativeAccessToken" in requirement &&
          ("sessionCookie" in requirement || "csrfHeader" in requirement),
      )
    ) {
      failures.push(`${definition.operationId}: native bearer was incorrectly ANDed with browser security`);
    }
  }
  try {
    assert.deepStrictEqual(
      Object.keys(manifest.nativeAuthorizationPolicies).sort(),
      [...nativeBaseOperationIds].sort(),
    );
  } catch (error) {
    failures.push(`Native authorization coverage is not exact: ${error.message}`);
  }

  for (const definition of manifest.operations) {
    const operation = openapi.paths?.[definition.path]?.[definition.method];
    if (!operation || operation.operationId !== definition.operationId) {
      failures.push(`New operation missing: ${definition.operationId}`);
      continue;
    }
    try {
      assert.deepStrictEqual(operation.security, expectedSecurityByMode[definition.security]);
    } catch (error) {
      failures.push(`${definition.operationId}: security mode drifted: ${error.message}`);
    }
    if (definition.security !== "none" && !definition.authorizationPolicy) {
      failures.push(`${definition.operationId}: authenticated operation lacks an authorization policy`);
    }
    for (const [definitionField, extension] of [
      ["authorizationPolicy", "x-authorization-policy"],
      ["createOrRotatePolicy", "x-create-or-rotate-policy"],
      ["paginationPolicy", "x-pagination-policy"],
    ]) {
      if (
        definition[definitionField] !== undefined &&
        operation[extension] !== definition[definitionField]
      ) {
        failures.push(`${definition.operationId}: ${extension} drifted`);
      }
    }
    if (definition.refreshReplayPolicy) {
      try {
        assert.deepStrictEqual(
          operation["x-refresh-replay-policy"],
          manifest.nativeRefreshReplayPolicy,
        );
      } catch (error) {
        failures.push(`${definition.operationId}: refresh replay policy drifted: ${error.message}`);
      }
    }
    if (
      operation.security?.some(
        (requirement) =>
          "relayWebhookSignature" in requirement || "buildWebhookSignature" in requirement,
      )
    ) {
      failures.push(`${definition.operationId}: native workflow operation accepts machine webhook security`);
    }
    if (["post", "put", "patch", "delete"].includes(definition.method)) {
      const keyHeader = operation.parameters?.find(
        (parameter) => parameter.in === "header" && parameter.name === "Idempotency-Key",
      );
      if (!keyHeader?.required) failures.push(`${definition.operationId}: Idempotency-Key missing`);
      if (!definition.idempotencyKeySource) {
        failures.push(`${definition.operationId}: manifest write idempotency source is missing`);
      } else {
        if (operation["x-idempotency-key-source"] !== definition.idempotencyKeySource) {
          failures.push(`${definition.operationId}: executable idempotency source drifted`);
        }
        if (
          operation["x-idempotency-scope"] !==
          (definition.idempotencyScope ?? manifest.idempotency.scope)
        ) {
          failures.push(`${definition.operationId}: executable idempotency scope drifted`);
        }
      }
    }
    if (definition.versionControl === "body") {
      const requestSchema = resolveAppSchemaRef(definition.requestRef);
      if (!requestSchema?.required?.includes("expectedVersion")) {
        failures.push(`${definition.operationId}: body version control lacks required expectedVersion`);
      }
    }
    if (
      definition.status !== 204 &&
      !operation.responses?.[String(definition.status)]?.content?.[manifest.mediaType]
    ) {
      failures.push(`${definition.operationId}: versioned typed success response missing`);
    }
    const example = openApiExamples.operations?.[definition.operationId];
    if (!example || example.status !== definition.status) {
      failures.push(`${definition.operationId}: example/status coverage is missing or drifted`);
    }
    if (definition.requestRef) {
      const requestMedia = operation.requestBody?.content?.[manifest.mediaType];
      if (requestMedia?.schema?.$ref !== definition.requestRef) {
        failures.push(`${definition.operationId}: request schema ref drifted`);
      }
      if (!example?.request) {
        failures.push(`${definition.operationId}: request example missing`);
      } else {
        validateAppExample(definition.requestRef, example.request, `${definition.operationId} request`);
        try {
          assert.deepStrictEqual(requestMedia?.example, example.request);
        } catch (error) {
          failures.push(`${definition.operationId}: generated request example drifted: ${error.message}`);
        }
      }
    }
    if (definition.status !== 204 && definition.responseRef) {
      const responseMedia =
        operation.responses?.[String(definition.status)]?.content?.[manifest.mediaType];
      if (responseMedia?.schema?.$ref !== definition.responseRef) {
        failures.push(`${definition.operationId}: response schema ref drifted`);
      }
      if (!example?.response) {
        failures.push(`${definition.operationId}: response example missing`);
      } else {
        validateAppExample(
          definition.responseRef,
          example.response,
          `${definition.operationId} response`,
        );
        try {
          assert.deepStrictEqual(responseMedia?.example, example.response);
        } catch (error) {
          failures.push(`${definition.operationId}: generated response example drifted: ${error.message}`);
        }
      }
    }
    const expectedErrors = groupedErrorCodes(operationErrorCodes(definition.errorCodes, operation));
    for (const [status, expectedCodes] of expectedErrors) {
      const response = operation.responses?.[status];
      try {
        assert.deepStrictEqual(response?.["x-error-codes"], expectedCodes);
        assert.deepStrictEqual(
          response?.content?.[manifest.mediaType]?.["x-error-codes"],
          expectedCodes,
        );
      } catch (error) {
        failures.push(`${definition.operationId}: ${status} error contract drifted: ${error.message}`);
      }
    }
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      if (Number(status) === definition.status) continue;
      const actualCodes = response["x-error-codes"] ?? [];
      const expectedCodes = expectedErrors.get(status) ?? [];
      if (JSON.stringify(actualCodes) !== JSON.stringify(expectedCodes)) {
        failures.push(`${definition.operationId}: ${status} has extra or missing declared errors`);
      }
    }
  }

  const patchedById = new Map(
    manifest.operationPatches.map((patch) => [patch.operationId, patch]),
  );
  for (const [operationId, patch] of patchedById) {
    const definition = baseManifest.operations.find((entry) => entry.operationId === operationId);
    const operation = openapi.paths[definition.path][definition.method];
    const example = openApiExamples.operations?.[operationId];
    for (const [field, extension] of [
      ["authorizationPolicy", "x-authorization-policy"],
      ["createOrRotatePolicy", "x-create-or-rotate-policy"],
      ["paginationPolicy", "x-pagination-policy"],
    ]) {
      if (patch[field] !== undefined && operation[extension] !== patch[field]) {
        failures.push(`${operationId}: patched ${extension} drifted`);
      }
    }
    if (
      (patch.requestRef ||
        patch.responseRef ||
        patch.requestMediaType ||
        patch.responseMediaType) &&
      (!example || example.status !== definition.status)
    ) {
      failures.push(`${operationId}: patched example/status coverage is missing or drifted`);
    }
    if (patch.requestRef || patch.requestMediaType) {
      const expectedRequestRef =
        patch.requestRef ?? operation.requestBody?.content?.["application/json"]?.schema?.$ref;
      const validationRequestRef = patch.requestRef ?? definition.requestRef;
      if (!operation.requestBody?.content?.["application/json"]) {
        failures.push(`${operationId}: 1.0 application/json request contract was removed`);
      }
      if (!operation.requestBody?.content?.[patch.requestMediaType ?? manifest.mediaType]) {
        failures.push(`${operationId}: 1.1 versioned request media type missing`);
      }
      const requestMedia =
        operation.requestBody?.content?.[patch.requestMediaType ?? manifest.mediaType];
      if (requestMedia?.schema?.$ref !== expectedRequestRef) {
        failures.push(`${operationId}: patched request schema ref drifted`);
      }
      if (!example?.request) {
        failures.push(`${operationId}: patched request example missing`);
      } else {
        if (validationRequestRef?.startsWith("../schemas/app-first.schema.json#")) {
          validateAppExample(
            validationRequestRef,
            example.request,
            `${operationId} patched request`,
          );
        } else {
          validateStableExample(
            validationRequestRef,
            example.request,
            `${operationId} patched request`,
          );
        }
        try {
          assert.deepStrictEqual(requestMedia?.example, example.request);
        } catch (error) {
          failures.push(`${operationId}: generated patched request example drifted: ${error.message}`);
        }
      }
    }
    if (patch.responseRef || patch.responseMediaType) {
      const content = operation.responses[String(definition.status)].content;
      const expectedResponseRef =
        patch.responseRef ?? content?.["application/json"]?.schema?.$ref;
      const validationResponseRef = patch.responseRef ?? definition.responseRef;
      if (!content?.["application/json"]) {
        failures.push(`${operationId}: 1.0 application/json response contract was removed`);
      }
      if (!content?.[patch.responseMediaType ?? manifest.mediaType]) {
        failures.push(`${operationId}: 1.1 versioned response media type missing`);
      }
      const responseMedia = content?.[patch.responseMediaType ?? manifest.mediaType];
      if (responseMedia?.schema?.$ref !== expectedResponseRef) {
        failures.push(`${operationId}: patched response schema ref drifted`);
      }
      if (!example?.response) {
        failures.push(`${operationId}: patched response example missing`);
      } else {
        if (validationResponseRef?.startsWith("../schemas/app-first.schema.json#")) {
          validateAppExample(
            validationResponseRef,
            example.response,
            `${operationId} patched response`,
          );
        } else {
          validateStableExample(
            validationResponseRef,
            example.response,
            `${operationId} patched response`,
          );
        }
        try {
          assert.deepStrictEqual(responseMedia?.example, example.response);
        } catch (error) {
          failures.push(`${operationId}: generated patched response example drifted: ${error.message}`);
        }
      }
    }
    if (patch.idempotencyKeySource) {
      if (operation["x-idempotency-key-source"] !== patch.idempotencyKeySource) {
        failures.push(`${operationId}: executable idempotency source drifted`);
      }
      if (operation["x-idempotency-scope"] !== manifest.idempotency.scope) {
        failures.push(`${operationId}: executable idempotency scope drifted`);
      }
    }
    for (const [headerName, headerContract] of Object.entries(
      patch.successResponseHeaders ?? {},
    )) {
      const header = operation.responses[String(definition.status)].headers?.[headerName];
      try {
        assert.deepStrictEqual(header, headerContract);
      } catch (error) {
        failures.push(`${operationId}: success header ${headerName} drifted: ${error.message}`);
      }
    }
    const groupedPatchErrors = new Map();
    for (const code of operationErrorCodes(patch.errorCodes, operation)) {
      const entry = errorByCode.get(code);
      if (!entry) {
        failures.push(`${operationId}: unknown patched error ${code}`);
        continue;
      }
      const codes = groupedPatchErrors.get(entry.status) ?? [];
      codes.push(code);
      groupedPatchErrors.set(entry.status, codes);
    }
    for (const [status, expectedCodes] of groupedPatchErrors) {
      const response = operation.responses[String(status)];
      const media = response?.content?.[manifest.mediaType];
      if (!media) {
        failures.push(`${operationId}: ${status} versioned error media is missing`);
        continue;
      }
      try {
        assert.deepStrictEqual(media["x-error-codes"], expectedCodes);
      } catch (error) {
        failures.push(`${operationId}: ${status} versioned error codes drifted: ${error.message}`);
      }
      const baseHadStatus = groupedErrorCodes(definition.errorCodes).has(String(status));
      if (baseHadStatus && !response.content?.["application/json"]) {
        failures.push(`${operationId}: ${status} 1.0 application/json error media was removed`);
      }
    }
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      if (Number(status) === definition.status) continue;
      const vendorCodes = response?.content?.[manifest.mediaType]?.["x-error-codes"];
      if (vendorCodes === undefined) continue;
      const expectedCodes = groupedPatchErrors.get(Number(status)) ?? [];
      if (JSON.stringify(vendorCodes) !== JSON.stringify(expectedCodes)) {
        failures.push(`${operationId}: ${status} patched errors have extra or missing codes`);
      }
    }
  }

  const listBugParameters = openapi.paths["/bugs"].get.parameters;
  for (const requiredFilter of [
    "projectId",
    "state",
    "moduleId",
    "q",
    "cursor",
    "limit",
    "sort",
  ]) {
    if (!listBugParameters.some((parameter) => parameter.in === "query" && parameter.name === requiredFilter)) {
      failures.push(`listBugs: query parameter ${requiredFilter} missing`);
    }
  }
  for (const [operationId, requiredParameters] of [
    ["listBugEvents", ["afterSequence", "cursor", "limit"]],
    ["listNotifications", ["projectId", "unreadOnly", "cursor", "limit"]],
    ["listProjectBuilds", ["status", "cursor", "limit"]],
    ["listProjectMembers", ["cursor", "limit"]],
    ["listBugComments", ["cursor", "limit"]],
    ["listBugAttachments", ["cursor", "limit"]],
  ]) {
    const { operation } = (() => {
      for (const pathItem of Object.values(openapi.paths)) {
        for (const candidate of Object.values(pathItem)) {
          if (candidate?.operationId === operationId) return { operation: candidate };
        }
      }
      return { operation: undefined };
    })();
    for (const parameterName of requiredParameters) {
      if (
        !operation?.parameters?.some(
          (parameter) => parameter.in === "query" && parameter.name === parameterName,
        )
      ) {
        failures.push(`${operationId}: query parameter ${parameterName} missing`);
      }
    }
  }
  const auditOperation = openapi.paths["/bugs/{bugId}/events"].get;
  const auditSuccessContent = auditOperation.responses["200"]?.content ?? {};
  if (
    auditSuccessContent[manifest.mediaType]?.schema?.$ref !==
      "../schemas/app-first.schema.json#/$defs/nativeAuditEventList" ||
    JSON.stringify(auditSuccessContent[manifest.mediaType]?.example) !==
      JSON.stringify(openApiExamples.operations.listBugEvents.response) ||
    auditSuccessContent["application/json"]?.schema?.$ref !==
      "../../../schemas/api.schema.json#/$defs/eventList"
  ) {
    failures.push(
      "listBugEvents must expose the bounded native audit projection on vendor media while preserving the frozen 1.0 JSON representation",
    );
  }
  const streamOperation = openapi.paths["/events/stream"].get;
  const streamPatch = manifest.operationPatches.find(
    (patch) => patch.operationId === "streamEvents",
  );
  if (
    streamOperation["x-event-data-schema"]?.$ref !==
      "../schemas/app-first.schema.json#/$defs/nativeAuditEvent" ||
    streamOperation["x-event-projection-policy"] !==
      streamPatch?.eventProjectionPolicy ||
    !["projectId", "eventType", "afterDeliverySequence", "cursor"].every((name) =>
      streamOperation.parameters?.some(
        (parameter) => parameter.in === "query" && parameter.name === name,
      ),
    ) ||
    !streamOperation.parameters?.some(
      (parameter) => parameter.in === "header" && parameter.name === "Last-Event-ID",
    )
  ) {
    failures.push("streamEvents native audit data schema/projection policy is not frozen");
  }
  const attachmentDownloadOperation = openapi.paths["/attachments/{attachmentId}"].get;
  if (
    !attachmentDownloadOperation.parameters?.some(
      (parameter) => parameter.in === "header" && parameter.name === "Range",
    ) ||
    attachmentDownloadOperation.responses["200"]?.content?.["application/octet-stream"]
      ?.schema?.format !== "binary" ||
    attachmentDownloadOperation.responses["206"]?.content?.["application/octet-stream"]
      ?.schema?.format !== "binary" ||
    attachmentDownloadOperation.responses["206"]?.headers?.["Content-Range"] == null ||
    attachmentDownloadOperation.responses["416"]?.headers?.["Content-Range"] == null ||
    attachmentDownloadOperation.responses["302"] != null ||
    attachmentDownloadOperation.responses["200"]?.headers?.["Cache-Control"]?.schema?.const !==
      "private, no-store" ||
    attachmentDownloadOperation.responses["206"]?.headers?.["Content-Type"]?.schema?.const !==
      "application/octet-stream"
  ) {
    failures.push("getAttachment proxy-only full/range/416 wire contract is not frozen");
  }

  const chunkOperation = openapi.paths["/uploads/{sessionId}/chunks/{chunkNumber}"].put;
  for (const requiredHeader of [
    "Content-Length",
    "X-Chunk-SHA256",
    "X-Client-Submission-Id",
    "X-Client-Attachment-Id",
  ]) {
    const parameter = chunkOperation.parameters.find(
      (candidate) => candidate.name === requiredHeader,
    );
    if (!parameter) {
      failures.push(`putUploadChunk: ${requiredHeader} missing`);
    } else if (
      parameter.required ||
      parameter["x-required-for-contract-version"] !== manifest.contractVersion
    ) {
      failures.push(
        `putUploadChunk: ${requiredHeader} must stay optional for 1.0 and required only for ${manifest.contractVersion}`,
      );
    }
  }
  const chunkDefinition = baseManifest.operations.find(
    (definition) => definition.operationId === "putUploadChunk",
  );
  const ifMatchSchema = chunkOperation.parameters.find(
    (parameter) => parameter.in === "header" && parameter.name === "If-Match",
  )?.schema;
  const etagSchema =
    chunkOperation.responses[String(chunkDefinition.status)]?.headers?.ETag?.schema;
  const uploadVersionSchema =
    chunkOperation.responses[String(chunkDefinition.status)]?.headers?.["X-Upload-Version"]
      ?.schema;
  if (
    ifMatchSchema?.pattern !== etagSchema?.pattern ||
    etagSchema?.pattern !== '^"[1-9][0-9]*"$' ||
    uploadVersionSchema?.type !== "integer" ||
    uploadVersionSchema?.minimum !== 1
  ) {
    failures.push(
      "putUploadChunk: returned ETag/X-Upload-Version cannot round-trip into the next If-Match version",
    );
  }
  if (
    !/canonical JSON/i.test(chunkOperation["x-canonical-binary-payload"] ?? "") ||
    !/exact request bytes/i.test(chunkOperation["x-canonical-binary-payload"] ?? "") ||
    !/bodySha256/i.test(chunkOperation["x-canonical-binary-payload"] ?? "") ||
    !/xClientSubmissionId/i.test(chunkOperation["x-canonical-binary-payload"] ?? "") ||
    !/xClientAttachmentId/i.test(chunkOperation["x-canonical-binary-payload"] ?? "") ||
    !/uploadAttempt/i.test(chunkOperation["x-canonical-binary-payload"] ?? "")
  ) {
    failures.push("putUploadChunk: raw-body canonicalization is not frozen");
  }
  if (
    !/advances.*version.*response loss.*GETs the upload session/i.test(
      chunkOperation["x-upload-version-semantics"] ?? "",
    )
  ) {
    failures.push("putUploadChunk: version advancement/reconcile semantics are not frozen");
  }
  for (const authOperationId of ["createNativeSession", "refreshNativeSession"]) {
    let authOperation;
    for (const pathItem of Object.values(openapi.paths)) {
      authOperation = Object.values(pathItem).find(
        (candidate) => candidate?.operationId === authOperationId,
      );
      if (authOperation) break;
    }
    const definition = manifest.operations.find(
      (candidate) => candidate.operationId === authOperationId,
    );
    if (
      !authOperation ||
      authOperation.security.length !== 0 ||
      !authOperation["x-idempotency-key-source"] ||
      !authOperation["x-idempotency-scope"] ||
      authOperation["x-idempotency-replay-after-authentication"] !== true ||
      authOperation["x-secret-response"] !== true ||
      !/HMAC-SHA-256|server-only/i.test(
        authOperation["x-sensitive-request-digest"] ?? "",
      ) ||
      !definition.errorCodes.includes("IDEMPOTENCY_PAYLOAD_MISMATCH")
    ) {
      failures.push(`${authOperationId}: unauthenticated secret idempotency boundary is incomplete`);
    }
    const cacheHeader =
      authOperation?.responses?.[String(definition.status)]?.headers?.["Cache-Control"];
    if (cacheHeader?.schema?.const !== "no-store") {
      failures.push(`${authOperationId}: Cache-Control no-store response contract missing`);
    }
    if (authOperationId === "refreshNativeSession") {
      try {
        assert.deepStrictEqual(
          authOperation["x-refresh-replay-policy"],
          manifest.nativeRefreshReplayPolicy,
        );
      } catch (error) {
        failures.push(`refreshNativeSession: endpoint replay policy drifted: ${error.message}`);
      }
      if (
        authOperation["x-idempotency-retention-seconds"] !==
        manifest.nativeRefreshReplayPolicy.retentionSeconds
      ) {
        failures.push("refreshNativeSession: replay retention seconds drifted");
      }
    } else if (authOperation["x-refresh-replay-policy"] !== undefined) {
      failures.push("createNativeSession: refresh replay policy is attached to the wrong endpoint");
    }
  }

  const loginExample = openApiExamples.operations.createNativeSession;
  const refreshExample = openApiExamples.operations.refreshNativeSession;
  const getSessionExample = openApiExamples.operations.getNativeSession.response;
  const nativePrincipal = {
    accountId: "10000000-0000-4000-8000-000000000020",
    userId: "10000000-0000-4000-8000-000000000003",
    installationId: "10000000-0000-4000-8000-000000000001",
    sessionId: "10000000-0000-4000-8000-000000000002",
    sharedDevice: false,
    sessionCreatedAt: "2026-08-24T11:00:00Z",
    originalAbsoluteExpiresAt: "2026-09-23T11:00:00Z",
    refreshFamilyIssuedAt: "2026-08-24T11:00:00Z",
    refreshFamilyExpiresAt: "2026-09-23T11:00:00Z",
    sessionVersion: 1,
    authorizedProjects: [
      {
        id: "10000000-0000-4000-8000-000000000004",
        key: "OZDQP",
        name: "OZDQP",
        roles: ["viewer", "reporter", "verifier"],
      },
    ],
  };
  function encryptedSecretSnapshotFacts(operation, example, principal, mutationCount) {
    const operationId = operation === "login" ? "createNativeSession" : "refreshNativeSession";
    const idempotencyKey = `native-${operation}-action-key`;
    const scope = {
      accountId: principal.accountId,
      actorId: principal.userId,
      installationId: principal.installationId,
    };
    const canonicalRequestDigest = canonicalReplayDigest(
      operationId,
      scope,
      example.request,
      idempotencyKey,
      testServerPepper,
    );
    const snapshotCreatedAt = example.response.issuedAt;
    const snapshotExpiresAt = new Date(
      Date.parse(snapshotCreatedAt) + APP_FIRST_LIMITS.refreshReplayRetentionMs,
    ).toISOString();
    return {
      idempotencyKey,
      persistedIdempotencyKey: idempotencyKey,
      canonicalRequestDigest,
      persistedRequestDigest: canonicalRequestDigest,
      requestDigestAlgorithm: "HMAC-SHA-256",
      serverPepper: testServerPepper,
      serverPepperProtected: true,
      encryptedSnapshotPersisted: true,
      encryptionKeyVersion: 1,
      rawSecretAbsent: true,
      originalEffectCommitted: true,
      mutationCount,
      snapshotCreatedAt,
      snapshotExpiresAt,
      serverNow: snapshotCreatedAt,
      persistedResponse: structuredClone(example.response),
      responseSecretDigest: `${operation}-response-secret-digest-00000001`,
      persistedResponseSecretDigest: `${operation}-response-secret-digest-00000001`,
    };
  }
  const activeRefreshReceiptFacts = {
    refreshState: "active",
    requestRefreshTokenHmac: "active-refresh-token-hmac-000001",
    activeRefreshTokenHmac: "active-refresh-token-hmac-000001",
    priorRefreshTokenDisabled: true,
    persistedNewRefreshTokenHmac: "rotated-refresh-token-hmac-00001",
    responseRefreshTokenHmac: "rotated-refresh-token-hmac-00001",
    tokenFamilyGenerationBefore: 1,
    tokenFamilyGenerationAfter: 2,
  };
  for (const [operation, example] of [
    ["login", loginExample],
    ["refresh", refreshExample],
  ]) {
    const result = evaluateAppFirstBehavior("native-session-receipt", {
      operation,
      request: example.request,
      response: example.response,
      principal: nativePrincipal,
      ...encryptedSecretSnapshotFacts(operation, example, nativePrincipal, 1),
      ...(operation === "login"
        ? { credentialsVerified: true }
        : activeRefreshReceiptFacts),
    });
    if (result !== "valid") {
      failures.push(`${operation}: native session principal/account/timing receipt is ${result}`);
    }
  }
  if (
    loginExample.response.session.accountId !== refreshExample.response.session.accountId ||
    refreshExample.response.session.accountId !== getSessionExample.accountId
  ) {
    failures.push("native session accountId is not stable across login/refresh/get");
  }
  if (
    evaluateAppFirstBehavior("native-session-resource", {
      session: getSessionExample,
      principal: nativePrincipal,
    }) !== "valid"
  ) {
    failures.push("getNativeSession response is not bound to the authenticated session principal");
  }
  for (const [label, mutate] of [
    ["foreign account", (input) => (input.response.session.accountId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
    ["foreign session", (input) => (input.response.session.id = "ffffffff-ffff-4fff-8fff-fffffffffff6")],
    ["foreign user", (input) => (input.response.session.user.id = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
    ["foreign project", (input) => (input.response.session.projects[0].id = "ffffffff-ffff-4fff-8fff-fffffffffff3")],
    ["foreign installation", (input) => (input.response.session.installationId = "ffffffff-ffff-4fff-8fff-fffffffffff4")],
    ["year-long access token", (input) => (input.response.accessExpiresAt = "2027-08-24T11:00:00Z")],
    ["idle before access expiry", (input) => (input.response.session.idleExpiresAt = "2026-08-24T11:14:59Z")],
    ["refresh beyond absolute session", (input) => (input.response.refreshExpiresAt = "2026-09-23T11:00:01Z")],
  ]) {
    const input = {
      operation: "login",
      request: structuredClone(loginExample.request),
      response: structuredClone(loginExample.response),
      principal: structuredClone(nativePrincipal),
      credentialsVerified: true,
      ...encryptedSecretSnapshotFacts("login", loginExample, nativePrincipal, 1),
    };
    mutate(input);
    if (evaluateAppFirstBehavior("native-session-receipt", input) !== "invalid") {
      failures.push(`native session mutation ${label} was accepted`);
    }
  }
  {
    const input = {
      operation: "login",
      request: structuredClone(loginExample.request),
      response: structuredClone(loginExample.response),
      principal: structuredClone(nativePrincipal),
      credentialsVerified: true,
      ...encryptedSecretSnapshotFacts("login", loginExample, nativePrincipal, 1),
    };
    input.request.sharedDevice = true;
    input.principal.sharedDevice = true;
    input.principal.originalAbsoluteExpiresAt = "2026-08-24T19:00:00Z";
    input.principal.refreshFamilyExpiresAt = "2026-08-24T19:00:00Z";
    input.response.session.sharedDevice = true;
    input.response.session.pushAllowed = false;
    input.response.session.idleExpiresAt = "2026-08-24T11:30:01Z";
    input.response.session.absoluteExpiresAt = "2026-08-24T19:00:00Z";
    input.response.refreshExpiresAt = "2026-08-24T19:00:00Z";
    if (evaluateAppFirstBehavior("native-session-receipt", input) !== "invalid") {
      failures.push("shared-device idle TTL beyond 30 minutes was accepted");
    }
  }
  {
    const input = {
      operation: "login",
      request: structuredClone(loginExample.request),
      response: structuredClone(loginExample.response),
      principal: structuredClone(nativePrincipal),
      loginState: "exact_replay",
      replayAuthorized: true,
      ...encryptedSecretSnapshotFacts("login", loginExample, nativePrincipal, 0),
    };
    input.response.replayed = true;
    if (evaluateAppFirstBehavior("native-session-receipt", input) !== "valid") {
      failures.push("native login exact replay did not return its persisted secret response");
    }
    input.response.refreshToken = "different-login-replay-refresh-token";
    if (evaluateAppFirstBehavior("native-session-receipt", input) !== "invalid") {
      failures.push("native login replay was allowed to mint different credentials");
    }
  }
  {
    const input = {
      operation: "refresh",
      request: structuredClone(refreshExample.request),
      response: structuredClone(refreshExample.response),
      principal: structuredClone(nativePrincipal),
      ...structuredClone(activeRefreshReceiptFacts),
      ...encryptedSecretSnapshotFacts("refresh", refreshExample, nativePrincipal, 1),
    };
    input.response.session.absoluteExpiresAt = "2026-09-23T11:10:00Z";
    input.response.refreshExpiresAt = "2026-09-23T11:10:00Z";
    if (evaluateAppFirstBehavior("native-session-receipt", input) !== "invalid") {
      failures.push("refresh was allowed to slide the original absolute/family expiry");
    }
  }
  {
    const input = {
      operation: "refresh",
      request: structuredClone(refreshExample.request),
      response: structuredClone(refreshExample.response),
      principal: structuredClone(nativePrincipal),
      refreshState: "consumed_exact_replay",
      replayAuthorized: true,
      ...encryptedSecretSnapshotFacts("refresh", refreshExample, nativePrincipal, 0),
      consumedAt: refreshExample.response.issuedAt,
      tokenFamilyGenerationBefore: 2,
      tokenFamilyGenerationAfter: 2,
    };
    input.response.replayed = true;
    if (evaluateAppFirstBehavior("native-session-receipt", input) !== "valid") {
      failures.push("consumed refresh exact replay did not return the persisted token response");
    }
    input.response.accessToken = "fresh-but-not-persisted-access-token";
    if (evaluateAppFirstBehavior("native-session-receipt", input) !== "invalid") {
      failures.push("consumed refresh replay was allowed to mint different credentials");
    }
  }
  try {
    assert.deepStrictEqual(manifest.rbacRoles, [
      "viewer",
      "reporter",
      "developer",
      "verifier",
      "triager",
      "release_manager",
      "project_admin",
    ]);
    assert.deepStrictEqual(
      appSchema.$defs.sessionProject.properties.roles.items.enum,
      manifest.rbacRoles,
    );
  } catch (error) {
    failures.push(`native RBAC role allowlist drifted: ${error.message}`);
  }
  const validateNativeSession = ajv.compile({
    $ref: "https://qa-hub.local/contracts/1.1.0/app-first.schema.json#/$defs/nativeSession",
  });
  const viewerSession = structuredClone(getSessionExample);
  viewerSession.projects[0].roles = ["viewer"];
  if (!validateNativeSession(viewerSession)) {
    failures.push("viewer-only native session is not schema-valid");
  }
  const auditorSession = structuredClone(getSessionExample);
  auditorSession.projects[0].roles = ["auditor"];
  if (validateNativeSession(auditorSession)) {
    failures.push("undeclared auditor role is accepted by the native session schema");
  }
  if (
    manifest.nativeSessionPolicy.accessTokenMaxTtlSeconds * 1000 !==
      APP_FIRST_LIMITS.accessTokenMaxTtlMs ||
    manifest.nativeSessionPolicy.sharedDeviceIdleTimeoutSeconds * 1000 !==
      APP_FIRST_LIMITS.sharedDeviceIdleMaxTtlMs ||
    manifest.nativeSessionPolicy.sharedDeviceAbsoluteSessionSeconds * 1000 !==
      APP_FIRST_LIMITS.sharedDeviceAbsoluteMaxTtlMs ||
    manifest.nativeSessionPolicy.personalRefreshMaxLifetimeSeconds * 1000 !==
      APP_FIRST_LIMITS.personalRefreshMaxTtlMs
  ) {
    failures.push("native session executable TTL limits drifted from manifest");
  }

  const expectedActorScope =
    "authenticated account + authenticated actor + project + operationId + Idempotency-Key";
  if (manifest.idempotency.scope !== expectedActorScope) {
    failures.push("generic idempotency scope must bind authenticated actor and project");
  }
  for (const pathItem of Object.values(openapi.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!["post", "put", "patch", "delete"].includes(method) || !operation?.operationId) {
        continue;
      }
      const actorAuthenticated = operation.security?.some(
        (requirement) => "sessionCookie" in requirement || "nativeAccessToken" in requirement,
      );
      if (!actorAuthenticated) continue;
      const keyHeader = operation.parameters?.find(
        (parameter) => parameter.in === "header" && parameter.name === "Idempotency-Key",
      );
      if (!keyHeader?.required) {
        failures.push(`${operation.operationId}: actor write lacks required Idempotency-Key`);
      }
      if (!/authenticated actor/.test(operation["x-idempotency-scope"] ?? "")) {
        failures.push(`${operation.operationId}: idempotency scope is not actor-bound`);
      }
      if (
        operation["x-idempotency-replay-authorization"] !==
        manifest.idempotency.replayAuthorizationRule
      ) {
        failures.push(`${operation.operationId}: authz-before-idempotency rule drifted`);
      }
    }
  }

  const legacyPush = openapi.paths["/push/subscriptions"].post;
  if (
    legacyPush["x-idempotency-scope"] !==
      manifest.idempotency.operationScopes.createPushSubscription ||
    legacyPush["x-sensitive-request-digest"] !== manifest.idempotency.sensitiveRequestDigest
  ) {
    failures.push("createPushSubscription: projectless actor/endpoint scope or secret digest missing");
  }
  if (securityHasExactRequirement(legacyPush.security ?? [], ["nativeAccessToken"])) {
    failures.push("createPushSubscription: legacy Web Push endpoint must not accept native bearer");
  }
  const androidPush = openapi.paths["/notification-devices"].post;
  if (
    !/derive sharedDevice.*pushAllowed.*authenticated native session/i.test(
      androidPush["x-authorization-policy"] ?? "",
    )
  ) {
    failures.push("registerAndroidNotificationDevice: session-derived shared-device guard missing");
  }
  if (
    androidPush["x-sensitive-request-digest"] !== manifest.idempotency.sensitiveRequestDigest ||
    !/encrypted at rest|raw values never/i.test(manifest.notificationPolicy.secretStorageRule)
  ) {
    failures.push("registerAndroidNotificationDevice: notification secret handling is incomplete");
  }
  try {
    assert.deepStrictEqual(manifest.contentNegotiation.responseAcceptByOperation, {
      getAttachment:
        "application/octet-stream, application/vnd.relay-qa-hub.v1.1+json;q=0.9, application/json;q=0.8",
      streamEvents:
        "text/event-stream, application/vnd.relay-qa-hub.v1.1+json;q=0.9, application/json;q=0.8",
    });
    assert.deepStrictEqual(manifest.contentNegotiation.requestContentTypeByOperation, {
      putUploadChunk: "application/octet-stream",
    });
  } catch (error) {
    failures.push(`binary/SSE operation-specific media policy drifted: ${error.message}`);
  }
  for (const operationId of ["getAttachment", "streamEvents"]) {
    const definition = baseManifest.operations.find((entry) => entry.operationId === operationId);
    const operation = openapi.paths?.[definition.path]?.[definition.method];
    const accepted = new Set(
      manifest.contentNegotiation.responseAcceptByOperation[operationId]
        .split(",")
        .map((entry) => entry.trim().split(";")[0]),
    );
    const advertisedAcrossStatuses = new Set(
      Object.values(operation.responses ?? {}).flatMap((response) =>
        Object.keys(response.content ?? {}),
      ),
    );
    for (const mediaType of advertisedAcrossStatuses) {
      if (!accepted.has(mediaType)) {
        failures.push(`${operationId}: Android Accept omits advertised ${mediaType}`);
      }
    }
  }
  const patchByOperationId = new Map(
    manifest.operationPatches.map((patch) => [patch.operationId, patch]),
  );
  for (const definition of baseManifest.operations) {
    const generated = openapi.paths?.[definition.path]?.[definition.method];
    const base = baseOpenapi.paths?.[definition.path]?.[definition.method];
    const patch = patchByOperationId.get(definition.operationId);
    const expectedResponseMedia = new Set(
      Object.keys(base?.responses?.[String(definition.status)]?.content ?? {}),
    );
    if (patch?.responseRef || patch?.responseMediaType) {
      expectedResponseMedia.add(patch.responseMediaType ?? manifest.mediaType);
    }
    const actualResponseMedia = Object.keys(
      generated?.responses?.[String(definition.status)]?.content ?? {},
    ).sort();
    const expectedRequestMedia = new Set(Object.keys(base?.requestBody?.content ?? {}));
    if (patch?.requestRef || patch?.requestMediaType) {
      expectedRequestMedia.add(patch.requestMediaType ?? manifest.mediaType);
    }
    const actualRequestMedia = Object.keys(generated?.requestBody?.content ?? {}).sort();
    try {
      assert.deepStrictEqual(actualResponseMedia, [...expectedResponseMedia].sort());
      assert.deepStrictEqual(actualRequestMedia, [...expectedRequestMedia].sort());
    } catch (error) {
      failures.push(`${definition.operationId}: success/request media set drifted: ${error.message}`);
    }
  }
  for (const definition of manifest.operations) {
    const generated = openapi.paths?.[definition.path]?.[definition.method];
    const expectedResponseMedia = definition.status === 204 ? [] : [manifest.mediaType];
    const expectedRequestMedia = definition.requestRef ? [manifest.mediaType] : [];
    try {
      assert.deepStrictEqual(
        Object.keys(generated?.responses?.[String(definition.status)]?.content ?? {}).sort(),
        expectedResponseMedia,
      );
      assert.deepStrictEqual(
        Object.keys(generated?.requestBody?.content ?? {}).sort(),
        expectedRequestMedia,
      );
    } catch (error) {
      failures.push(`${definition.operationId}: versioned success/request media set drifted: ${error.message}`);
    }
  }
  for (const definition of [...baseManifest.operations, ...manifest.operations]) {
    const operation = openapi.paths?.[definition.path]?.[definition.method];
    const responseMedia = Object.keys(operation?.responses?.[String(definition.status)]?.content ?? {});
    for (const mediaType of responseMedia) {
      if (
        evaluateAppFirstBehavior("content-negotiation", {
          direction: "response",
          advertisedMediaTypes: responseMedia,
          requestedMediaTypes: [mediaType],
        }) !== mediaType
      ) {
        failures.push(`${definition.operationId}: advertised response media ${mediaType} was rejected`);
      }
    }
    if (
      responseMedia.length > 0 &&
      evaluateAppFirstBehavior("content-negotiation", {
        direction: "response",
        advertisedMediaTypes: responseMedia,
        requestedMediaTypes: ["application/x-not-advertised"],
      }) !== "NOT_ACCEPTABLE"
    ) {
      failures.push(`${definition.operationId}: invented response media was accepted`);
    }
    const requestMedia = Object.keys(operation?.requestBody?.content ?? {});
    for (const mediaType of requestMedia) {
      if (
        evaluateAppFirstBehavior("content-negotiation", {
          direction: "request",
          advertisedMediaTypes: requestMedia,
          requestedMediaTypes: [mediaType],
        }) !== mediaType
      ) {
        failures.push(`${definition.operationId}: advertised request media ${mediaType} was rejected`);
      }
    }
    if (
      requestMedia.length > 0 &&
      evaluateAppFirstBehavior("content-negotiation", {
        direction: "request",
        advertisedMediaTypes: requestMedia,
        requestedMediaTypes: ["application/x-not-advertised"],
      }) !== "UNSUPPORTED_MEDIA_TYPE"
    ) {
      failures.push(`${definition.operationId}: invented request media was accepted`);
    }
  }
}

const errorCodes = combinedErrors.map((entry) => entry.code);
if (new Set(errorCodes).size !== errorCodes.length) failures.push("Duplicate 1.0/1.1 error code");
for (const entry of deltaErrors.errors) {
  if (entry.status < 400 || entry.status > 599) failures.push(`${entry.code}: invalid status`);
}
const schemaErrorCodes = appSchema.$defs.error.properties.code.enum;
if ([...errorCodes].sort().join("|") !== [...schemaErrorCodes].sort().join("|")) {
  failures.push("App-first error schema does not exactly match the combined error catalogs.");
}

const receipt = appSchema.$defs.relayReceipt;
const receiptStates = receipt.properties.handoffStatus.enum;
for (const forbidden of ["accepted", "verified", "closed", "passed"]) {
  if (receiptStates.includes(forbidden)) failures.push(`Relay receipt exposes forbidden state ${forbidden}`);
}
if (receipt.properties.requiresHumanVerification.const !== true) {
  failures.push("Relay receipt does not require human verification.");
}

const operationExamples = openApiExamples.operations;
const writeReceiptOperationIds = [
  "createRepairAttempt",
  "startRepairAttempt",
  "deliverRepairAttempt",
  "failRepairAttempt",
  "supersedeRepairAttempt",
  "createVerification",
  "startVerification",
  "registerBuild",
  "linkBuildRepair",
];
for (const operationId of writeReceiptOperationIds) {
  const definition = baseManifest.operations.find((entry) => entry.operationId === operationId);
  const operation = definition && openapi.paths?.[definition.path]?.[definition.method];
  const requestContent = operation?.requestBody?.content ?? {};
  const responseContent = operation?.responses?.[String(definition?.status)]?.content ?? {};
  for (const mediaType of ["application/json", manifest.mediaType]) {
    if (!requestContent[mediaType]?.schema?.$ref) {
      failures.push(`${operationId}: ${mediaType} request wire is unreachable`);
    }
    if (!responseContent[mediaType]?.schema?.$ref) {
      failures.push(`${operationId}: ${mediaType} success wire is unreachable`);
    }
  }
}
const expectedExampleOperationIds = new Set([
  ...manifest.operations.map((definition) => definition.operationId),
  ...manifest.operationPatches
    .filter(
      (patch) =>
        patch.requestRef ||
        patch.responseRef ||
        patch.requestMediaType ||
        patch.responseMediaType,
    )
    .map((patch) => patch.operationId),
  ...writeReceiptOperationIds,
]);
try {
  assert.deepStrictEqual(
    [...Object.keys(operationExamples)].sort(),
    [...expectedExampleOperationIds].sort(),
  );
} catch (error) {
  failures.push(`Operation example coverage set drifted: ${error.message}`);
}
for (const operationId of writeReceiptOperationIds) {
  const definition = baseManifest.operations.find((entry) => entry.operationId === operationId);
  const patch = manifest.operationPatches.find((entry) => entry.operationId === operationId);
  const example = operationExamples[operationId];
  if (!definition || !example || example.status !== definition.status) {
    failures.push(`${operationId}: executable write-receipt example/status is missing`);
    continue;
  }
  const requestRef = patch?.requestRef ?? definition.requestRef;
  const responseRef = patch?.responseRef ?? definition.responseRef;
  if (requestRef?.startsWith("../schemas/app-first.schema.json#")) {
    validateAppExample(requestRef, example.request, `${operationId} write request`);
  } else {
    validateStableExample(definition.requestRef, example.request, `${operationId} write request`);
  }
  if (responseRef?.startsWith("../schemas/app-first.schema.json#")) {
    validateAppExample(responseRef, example.response, `${operationId} write response`);
  } else {
    validateStableExample(definition.responseRef, example.response, `${operationId} write response`);
  }
}
const createRequest = operationExamples.createBug.request;
const createResponse = operationExamples.createBug.response;
const appendResponse = operationExamples.addOccurrence.response;
const authorizedProjectId = createResponse.bug.projectId;
const receiptActorId = operationExamples.createNativeSession.response.session.user.id;
const submissionAccountId = operationExamples.createNativeSession.response.session.accountId;

function linkedBuildRequirementRecord() {
  return structuredClone(operationExamples.linkBuildRepair.response.buildRequirement);
}

function deliveryBuildRequirementRecord(requirement = "required") {
  const linked = linkedBuildRequirementRecord();
  return {
    ...linked,
    deliveredCommitSha: requirement === "required" ? linked.deliveredCommitSha : null,
    requirement,
    decisionBasis: requirement === "required" ? "code_requires_build" : "no_code_delivery",
    decisionReason:
      requirement === "required" ? null : "No code change is required for this delivery.",
    decisionActorId: receiptActorId,
    decisionAuditEventId: "90000000-0000-4000-8000-000000000007",
    linkedBuildId: null,
    linkId: null,
    updatedAt: linked.createdAt,
    version: 1,
  };
}

function buildRequirementFact(record, overrides = {}) {
  const deliveryRequestDigest =
    Object.hasOwn(overrides, "deliveryRequestDigest")
      ? overrides.deliveryRequestDigest
      : "pending-delivery-request-digest";
  return {
    accountId: submissionAccountId,
    projectId: record.projectId,
    bugId: record.bugId,
    buildRequirement: structuredClone(record),
    deliveryRequestDigest,
    deliveryDecisionAuditFact: {
      id: record.decisionAuditEventId,
      accountId: submissionAccountId,
      projectId: record.projectId,
      bugId: record.bugId,
      repairAttemptId: record.repairAttemptId,
      buildRequirementId: record.id,
      sourceDeliveryVersion: record.sourceDeliveryVersion,
      deliveredCommitSha: record.deliveredCommitSha,
      requirement: record.requirement,
      decisionBasis: record.decisionBasis,
      decisionReason: record.decisionReason,
      actorId: record.decisionActorId,
      deliveryRequestDigest,
      policyVersion: record.policyVersion,
      serverPolicyEvaluatedAtDelivery: true,
      authorizedNoBuildExemptionAtDelivery:
        record.decisionBasis === "authorized_no_build_exemption",
      noCodeDecisionValidatedAtDelivery: record.decisionBasis === "no_code_delivery",
      committed: true,
      atomicWithDelivery: true,
    },
    evaluatedFromServerPolicy: true,
    committedWithDelivery: true,
    current: true,
    ...overrides,
  };
}

function buildRepairLinkFact(link, overrides = {}) {
  return {
    accountId: submissionAccountId,
    projectId: link.projectId,
    link: structuredClone(link),
    evidenceAuditFact: {
      id: link.evidenceAuditEventId,
      accountId: submissionAccountId,
      projectId: link.projectId,
      bugId: link.bugId,
      repairAttemptId: link.repairAttemptId,
      buildId: link.buildId,
      linkId: link.id,
      actorId: link.evidenceActorId,
      deliveredCommitSha: link.deliveredCommitSha,
      evidenceType: link.evidenceType,
      evidenceDecision: link.evidenceDecision,
      overrideReason: link.overrideReason,
      policyVersion: link.evidencePolicyVersion,
      manifestVerifiedAtLink: link.evidenceType === "manifest",
      releaseManagerAuthorizedAtLink: link.evidenceType === "release_manager_override",
      committed: true,
      atomicWithLink: true,
    },
    relationCommitted: true,
    atomicWithBuildRequirement: true,
    atomicWithBugTransition: true,
    ...overrides,
  };
}
const submissionReceiptCases = [
  [
    "createBug",
    {
      operation: "create",
      accountId: submissionAccountId,
      authenticatedActorId: receiptActorId,
      authorizedProjectId,
      request: createRequest,
      response: createResponse,
      moduleFact: { id: createRequest.moduleId, projectId: authorizedProjectId, active: true },
      createdBugFact: {
        accountId: submissionAccountId,
        projectId: authorizedProjectId,
        bugId: createResponse.bug.id,
        bug: structuredClone(createResponse.bug),
      },
      occurrenceFact: {
        id: createResponse.occurrenceId,
        bugId: createResponse.bug.id,
        projectId: authorizedProjectId,
        clientSubmissionId: createRequest.clientSubmissionId,
        occurrence: structuredClone(createRequest.occurrence),
      },
      eventFact: {
        id: createResponse.eventId,
        accountId: submissionAccountId,
        projectId: authorizedProjectId,
        bugId: createResponse.bug.id,
        actorId: receiptActorId,
        clientSubmissionId: createRequest.clientSubmissionId,
        type: "bug.created",
      },
    },
  ],
  [
    "addOccurrence",
    {
      operation: "append",
      accountId: submissionAccountId,
      authenticatedActorId: receiptActorId,
      authorizedProjectId,
      targetQaItemId: operationExamples.addOccurrence.pathParameters?.bugId,
      targetQaItemKey: createResponse.qaItem.key,
      request: operationExamples.addOccurrence.request,
      response: appendResponse,
      bugResource: { accountId: submissionAccountId, projectId: authorizedProjectId, bugId: appendResponse.bugId, version: operationExamples.addOccurrence.request.expectedVersion },
      occurrenceFact: { id: appendResponse.occurrenceId, bugId: appendResponse.bugId, projectId: authorizedProjectId, clientSubmissionId: operationExamples.addOccurrence.request.clientSubmissionId, occurrence: structuredClone(operationExamples.addOccurrence.request.occurrence) },
      eventFact: { id: appendResponse.eventId, accountId: submissionAccountId, projectId: authorizedProjectId, bugId: appendResponse.bugId, actorId: receiptActorId, clientSubmissionId: operationExamples.addOccurrence.request.clientSubmissionId, type: "occurrence.appended" },
    },
  ],
  [
    "addBugComment",
    {
      operation: "comment",
      accountId: submissionAccountId,
      authenticatedActorId: receiptActorId,
      authorizedProjectId,
      targetQaItemId: operationExamples.addBugComment.pathParameters?.bugId,
      targetQaItemKey: createResponse.qaItem.key,
      request: operationExamples.addBugComment.request,
      response: operationExamples.addBugComment.response,
      bugResource: { accountId: submissionAccountId, projectId: authorizedProjectId, bugId: operationExamples.addBugComment.pathParameters.bugId, version: operationExamples.addBugComment.request.expectedVersion },
      commentFact: { accountId: submissionAccountId, comment: structuredClone(operationExamples.addBugComment.response.comment) },
      eventFact: { id: operationExamples.addBugComment.response.eventId, accountId: submissionAccountId, projectId: authorizedProjectId, bugId: operationExamples.addBugComment.pathParameters.bugId, actorId: receiptActorId, clientSubmissionId: operationExamples.addBugComment.request.clientSubmissionId, type: "comment.added" },
    },
  ],
  [
    "recordVerificationResult",
    {
      operation: "verification",
      accountId: submissionAccountId,
      authenticatedActorId: receiptActorId,
      authorizedProjectId,
      targetQaItemId: createResponse.qaItem.id,
      targetQaItemKey: createResponse.qaItem.key,
      targetVerificationId:
        operationExamples.recordVerificationResult.pathParameters?.verificationId,
      request: operationExamples.recordVerificationResult.request,
      response: operationExamples.recordVerificationResult.response,
      bugResource: {
        accountId: submissionAccountId,
        projectId: authorizedProjectId,
        bugId: createResponse.qaItem.id,
        state: "ready_for_verification",
        version: operationExamples.recordVerificationResult.response.bug.version - 1,
        activeAttemptId: operationExamples.recordVerificationResult.response.verification.repairAttemptId,
        activeVerificationId: operationExamples.recordVerificationResult.pathParameters.verificationId,
        bug: {
          ...structuredClone(operationExamples.recordVerificationResult.response.bug),
          state: "ready_for_verification",
          reopenCount: operationExamples.recordVerificationResult.response.bug.reopenCount,
          version: operationExamples.recordVerificationResult.response.bug.version - 1,
          updatedAt: "2026-08-24T10:59:00Z",
          closedAt: null,
        },
      },
      membershipFact: { accountId: submissionAccountId, actorId: receiptActorId, projectId: authorizedProjectId, currentActive: true },
      authorizationFact: { operationId: "recordVerificationResult", accountId: submissionAccountId, actorId: receiptActorId, projectId: authorizedProjectId, authorizedHuman: true, capabilityGranted: true, resolvedCurrentResourceBeforeIdempotency: true },
      verificationResource: {
        accountId: submissionAccountId,
        projectId: authorizedProjectId,
        bugId: createResponse.qaItem.id,
        verification: {
          ...structuredClone(operationExamples.recordVerificationResult.response.verification),
          status: "in_progress",
          resultSummary: null,
          version: operationExamples.recordVerificationResult.request.expectedVersion,
        },
      },
      repairAttemptResource: {
        accountId: submissionAccountId,
        projectId: authorizedProjectId,
        bugId: createResponse.qaItem.id,
        latestNonSuperseded: true,
        attempt: {
          ...structuredClone(operationExamples.recordVerificationResult.response.repairAttempt),
          status: "delivered",
          version: operationExamples.recordVerificationResult.response.repairAttempt.version - 1,
        },
      },
      buildResource: {
        accountId: submissionAccountId,
        projectId: authorizedProjectId,
        exactDeliveredCommitEligible: true,
        build: structuredClone(operationExamples.linkBuildRepair.response.build),
      },
      buildRequirementFact: buildRequirementFact(linkedBuildRequirementRecord()),
      linkRelationFact: buildRepairLinkFact(
        operationExamples.linkBuildRepair.response.repairLink,
      ),
      separationOfDutiesFact: {
        repairAssigneeId: operationExamples.recordVerificationResult.response.repairAttempt.assigneeId,
        verifierId: receiptActorId,
        passed: true,
      },
      verificationFact: { accountId: submissionAccountId, projectId: authorizedProjectId, verificationId: operationExamples.recordVerificationResult.pathParameters.verificationId, version: operationExamples.recordVerificationResult.request.expectedVersion, response: structuredClone(operationExamples.recordVerificationResult.response.verification) },
      multiAggregateEffectFact: {
        operationId: "recordVerificationResult",
        accountId: submissionAccountId,
        actorId: receiptActorId,
        projectId: authorizedProjectId,
        bugId: createResponse.qaItem.id,
        changedVersions: {
          bug: [operationExamples.recordVerificationResult.response.bug.version - 1, operationExamples.recordVerificationResult.response.bug.version],
          verification: [operationExamples.recordVerificationResult.request.expectedVersion, operationExamples.recordVerificationResult.response.verification.version],
          repairAttempt: [operationExamples.recordVerificationResult.response.repairAttempt.version - 1, operationExamples.recordVerificationResult.response.repairAttempt.version],
        },
        domainMutationCommitted: true,
        auditEventId: operationExamples.recordVerificationResult.response.eventId,
        auditEventCommitted: true,
        auditEventCount: 1,
        notificationOutboxCommitted: true,
        notificationMessageIds: ["notification:recordVerificationResult:1"],
        idempotencyRecordCommitted: true,
        atomicWithReceipt: true,
        humanResultAuthority: true,
        machineAcceptanceMutationCount: 0,
        activeVerificationIdBefore: operationExamples.recordVerificationResult.pathParameters.verificationId,
        activeVerificationIdAfter: null,
        activeAttemptIdBefore: operationExamples.recordVerificationResult.response.verification.repairAttemptId,
        activeAttemptIdAfter: null,
      },
      eventFact: {
        id: operationExamples.recordVerificationResult.response.eventId,
        accountId: submissionAccountId,
        projectId: authorizedProjectId,
        bugId: createResponse.qaItem.id,
        actorId: receiptActorId,
        clientSubmissionId: operationExamples.recordVerificationResult.request.clientSubmissionId,
        type: "verification.result_recorded",
        verificationId: operationExamples.recordVerificationResult.pathParameters.verificationId,
        repairAttemptId: operationExamples.recordVerificationResult.response.verification.repairAttemptId,
        buildId: operationExamples.recordVerificationResult.response.verification.buildId,
        status: operationExamples.recordVerificationResult.request.status,
        failureReason: operationExamples.recordVerificationResult.request.failureReason,
      },
    },
  ],
];
for (const [, input] of submissionReceiptCases) {
  const intent = {
    create: "bug_create",
    append: "occurrence_append",
    comment: "comment_append",
    verification: "verification_result",
  }[input.operation];
  const reservationTargetQaItemId =
    input.operation === "create" ? null : input.targetQaItemId;
  const claimedQaItemId =
    input.response.bug?.id ??
    input.response.bugId ??
    input.response.comment?.bugId ??
    input.response.verification?.bugId;
  const operationId = {
    create: "createBug",
    append: "addOccurrence",
    comment: "addBugComment",
    verification: "recordVerificationResult",
  }[input.operation];
  input.exactReplay = false;
  input.authorizationCheckedBeforeIdempotency = true;
  input.idempotencyKey =
    input.operation === "verification"
      ? `workflow:recordVerificationResult:verification:${input.targetVerificationId}:v${input.request.expectedVersion}`
      : `submission:${input.request.clientSubmissionId}:commit`;
  input.persistedIdempotencyKey = input.idempotencyKey;
  input.canonicalRequestDigest = canonicalNonSecretRequestDigest(
    operationId,
    {
      accountId: input.accountId,
      actorId: input.authenticatedActorId,
      projectId: input.authorizedProjectId,
      targetQaItemId: reservationTargetQaItemId,
      targetVerificationId:
        input.operation === "verification" ? input.targetVerificationId : null,
    },
    input.request,
    input.idempotencyKey,
  );
  input.persistedRequestDigest = input.canonicalRequestDigest;
  input.idempotencyRecordCommitted = true;
  input.originalEffectCommitted = true;
  input.atomicReceiptAndEffectCommitted = true;
  input.mutationCount = 1;
  input.httpStatus = {
    create: 201,
    append: 201,
    comment: 201,
    verification: 200,
  }[input.operation];
  const persistedBody = structuredClone(input.response);
  delete persistedBody.replayed;
  input.persistedHttpReceipt = {
    status: input.httpStatus,
    headers: {},
    body: persistedBody,
  };
  input.submissionEffectFact = {
    operationId,
    accountId: input.accountId,
    actorId: input.authenticatedActorId,
    projectId: input.authorizedProjectId,
    clientSubmissionId: input.request.clientSubmissionId,
    bugId: claimedQaItemId,
    eventId: input.response.eventId,
    attachmentIds: structuredClone(input.request.attachmentIds ?? []),
    captureId: input.request.captureBundleId ?? null,
    businessEntitiesCommitted: true,
    attachmentClaimsCommitted: true,
    auditEventCommitted: true,
  };
  input.notificationOutboxFact = {
    accountId: input.accountId,
    projectId: input.authorizedProjectId,
    bugId: claimedQaItemId,
    eventId: input.response.eventId,
    sourceOperationId: operationId,
    recipientsEvaluated: true,
    messagesCommitted: true,
    atomicWithSubmission: true,
    messageIds: [`notification:${operationId}:${input.request.clientSubmissionId}`],
  };
  input.persistedResponse = structuredClone(input.response);
  input.captureFact = input.request.captureBundleId
    ? {
        captureId: input.request.captureBundleId,
        accountId: input.accountId,
        actorId: input.authenticatedActorId,
        projectId: input.authorizedProjectId,
        clientSubmissionId: input.request.clientSubmissionId,
        attachmentIds: structuredClone(input.request.attachmentIds ?? []),
        durablyPersisted: true,
      }
    : null;
  input.claimedAttachmentFacts = (input.request.attachmentIds ?? []).map((attachmentId) => ({
    attachmentId,
    accountId: input.accountId,
    actorId: input.authenticatedActorId,
    projectId: input.authorizedProjectId,
    clientSubmissionId: input.request.clientSubmissionId,
    captureId: input.request.captureBundleId ?? null,
    scanStatus: "clean",
    bindingStatus: "claimed",
    durablyReadable: true,
    claimIntent: intent,
    reservationTargetQaItemId,
    claimedQaItemId,
  }));
  if (input.operation === "verification") refreshVerificationTypedFacts(input, "vendor");
}
for (const [label, input] of submissionReceiptCases) {
  if (evaluateAppFirstBehavior("submission-receipt", input) !== "unambiguous") {
    failures.push(`${label} example does not reconcile request/path/project/evidence to one receipt.`);
  }
}

const receiptMutationCases = [];
function addReceiptMutation(label, sourceIndex, mutate) {
  const input = structuredClone(submissionReceiptCases[sourceIndex][1]);
  mutate(input);
  receiptMutationCases.push([label, input]);
}
addReceiptMutation("createBug foreign project", 0, (input) => {
  input.response.bug.projectId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
});
addReceiptMutation("createBug foreign attachment", 0, (input) => {
  input.response.attachmentIds = ["ffffffff-ffff-4fff-8fff-fffffffffff2"];
});
addReceiptMutation("createBug foreign capture", 0, (input) => {
  input.response.captureBundleId = "ffffffff-ffff-4fff-8fff-fffffffffff3";
});
addReceiptMutation("createBug internally-consistent foreign capture", 0, (input) => {
  const foreignCaptureId = "ffffffff-ffff-4fff-8fff-fffffffffff3";
  input.request.captureBundleId = foreignCaptureId;
  input.response.captureBundleId = foreignCaptureId;
});
addReceiptMutation("createBug internally-consistent foreign attachment", 0, (input) => {
  const foreignAttachmentId = "ffffffff-ffff-4fff-8fff-fffffffffff2";
  input.request.attachmentIds = [foreignAttachmentId];
  input.response.attachmentIds = [foreignAttachmentId];
  input.occurrenceFact.occurrence.attachmentIds = [foreignAttachmentId];
});
addReceiptMutation("createBug attachment claimed by another target", 0, (input) => {
  input.claimedAttachmentFacts[0].claimedQaItemId = "ffffffff-ffff-4fff-8fff-fffffffffff8";
});
addReceiptMutation("createBug reservation targets an existing item", 0, (input) => {
  input.claimedAttachmentFacts[0].reservationTargetQaItemId =
    "ffffffff-ffff-4fff-8fff-fffffffffff8";
});
addReceiptMutation("createBug foreign reporter", 0, (input) => {
  input.response.bug.reporterId = "ffffffff-ffff-4fff-8fff-fffffffffff4";
});
addReceiptMutation("createBug module mismatch", 0, (input) => {
  input.response.bug.moduleId = "ffffffff-ffff-4fff-8fff-fffffffffff5";
});
addReceiptMutation("addOccurrence foreign project", 1, (input) => {
  input.response.projectId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
});
addReceiptMutation("addOccurrence foreign evidence", 1, (input) => {
  input.response.attachmentIds = ["ffffffff-ffff-4fff-8fff-fffffffffff2"];
});
addReceiptMutation("addBugComment foreign submission", 2, (input) => {
  input.response.clientSubmissionId = "ffffffff-ffff-4fff-8fff-fffffffffff4";
});
addReceiptMutation("addBugComment foreign comment evidence", 2, (input) => {
  input.response.comment.attachmentIds = ["ffffffff-ffff-4fff-8fff-fffffffffff2"];
});
addReceiptMutation("addBugComment foreign author", 2, (input) => {
  input.response.comment.authorId = "ffffffff-ffff-4fff-8fff-fffffffffff4";
});
addReceiptMutation("recordVerificationResult foreign project", 3, (input) => {
  input.response.bug.projectId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
});
addReceiptMutation("recordVerificationResult foreign evidence", 3, (input) => {
  input.response.captureBundleId = "ffffffff-ffff-4fff-8fff-fffffffffff3";
});
addReceiptMutation("recordVerificationResult foreign verifier", 3, (input) => {
  input.response.verification.verifierId = "ffffffff-ffff-4fff-8fff-fffffffffff4";
});
for (const [label, input] of receiptMutationCases) {
  if (evaluateAppFirstBehavior("submission-receipt", input) !== "ambiguous") {
    failures.push(`${label}: request/response receipt mutation was accepted`);
  }
}

for (const [label, source] of submissionReceiptCases) {
  const input =
    source.operation === "verification"
      ? makeVerificationReplayReceipt(source, "vendor")
      : structuredClone(source);
  if (source.operation !== "verification") {
    input.exactReplay = true;
    input.replayAuthorized = true;
    input.response.replayed = true;
    input.mutationCount = 0;
  }
  if (evaluateAppFirstBehavior("submission-receipt", input) !== "unambiguous") {
    failures.push(`${label}: exact replay did not return the persisted committed response`);
  }
}

for (const [label, source] of submissionReceiptCases) {
  const operationId = {
    create: "createBug",
    append: "addOccurrence",
    comment: "addBugComment",
    verification: "recordVerificationResult",
  }[source.operation];
  const reservationTargetQaItemId = source.operation === "create" ? null : source.targetQaItemId;
  const scope = {
    accountId: source.accountId,
    actorId: source.authenticatedActorId,
    projectId: source.authorizedProjectId,
    targetQaItemId: reservationTargetQaItemId,
    targetVerificationId:
      source.operation === "verification" ? source.targetVerificationId : null,
  };
  {
    const input = structuredClone(source);
    input.idempotencyKey = "totally-noncanonical-key";
    input.persistedIdempotencyKey = input.idempotencyKey;
    input.canonicalRequestDigest = canonicalNonSecretRequestDigest(
      operationId,
      scope,
      input.request,
      input.idempotencyKey,
    );
    input.persistedRequestDigest = input.canonicalRequestDigest;
    if (evaluateAppFirstBehavior("submission-receipt", input) !== "ambiguous") {
      failures.push(`${label}: noncanonical but internally rehashed commit key was accepted`);
    }
  }
  for (const [suffix, mutate] of [
    ["authorization after lookup", (input) => (input.authorizationCheckedBeforeIdempotency = false)],
    ["missing idempotency row", (input) => (input.idempotencyRecordCommitted = false)],
    ["missing atomic effect", (input) => (input.originalEffectCommitted = false)],
    ["non-atomic HTTP receipt", (input) => (input.atomicReceiptAndEffectCommitted = false)],
    ["wrong fresh mutation count", (input) => (input.mutationCount = 0)],
    ["wrong HTTP status", (input) => (input.httpStatus = 202)],
    ["missing business effect", (input) => (input.submissionEffectFact.businessEntitiesCommitted = false)],
    ["missing notification outbox", (input) => (input.notificationOutboxFact.messagesCommitted = false)],
  ]) {
    const input = structuredClone(source);
    mutate(input);
    if (evaluateAppFirstBehavior("submission-receipt", input) !== "ambiguous") {
      failures.push(`${label}: ${suffix} was accepted`);
    }
  }
}

{
  const input = structuredClone(submissionReceiptCases[0][1]);
  input.exactReplay = true;
  input.replayAuthorized = true;
  input.response.replayed = true;
  input.mutationCount = 0;
  input.request.occurrence.environment.networkMetered = true;
  input.occurrenceFact.occurrence.environment.networkMetered = true;
  if (evaluateAppFirstBehavior("submission-receipt", input) !== "ambiguous") {
    failures.push("createBug exact replay accepted an internally consistent changed request payload");
  }
}
for (const [label, sourceIndex, operationId] of [
  ["createBug", 0, "createBug"],
  ["addOccurrence", 1, "addOccurrence"],
]) {
  const input = structuredClone(submissionReceiptCases[sourceIndex][1]);
  const buildId = "b0000000-0000-4000-8000-0000000000f1";
  const bugId =
    input.response.bug?.id ?? input.response.bugId ?? input.targetQaItemId;
  input.request.occurrence.environment.buildId = buildId;
  input.occurrenceFact.occurrence.environment.buildId = buildId;
  input.occurrenceBuildFact = {
    accountId: input.accountId,
    projectId: input.authorizedProjectId,
    bugId,
    buildId,
    relationValidated: true,
  };
  const targetQaItemId = input.operation === "create" ? null : input.targetQaItemId;
  input.canonicalRequestDigest = canonicalNonSecretRequestDigest(
    operationId,
    {
      accountId: input.accountId,
      actorId: input.authenticatedActorId,
      projectId: input.authorizedProjectId,
      targetQaItemId,
      targetVerificationId: null,
    },
    input.request,
    input.idempotencyKey,
  );
  input.persistedRequestDigest = input.canonicalRequestDigest;
  if (evaluateAppFirstBehavior("submission-receipt", input) !== "unambiguous") {
    failures.push(`${label}: same-project Build occurrence reference was rejected`);
  }
  for (const [suffix, mutate] of [
    ["missing Build fact", (candidate) => (candidate.occurrenceBuildFact = null)],
    ["foreign Build account", (candidate) => (candidate.occurrenceBuildFact.accountId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
    ["foreign Build project", (candidate) => (candidate.occurrenceBuildFact.projectId = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
    ["foreign Build Bug", (candidate) => (candidate.occurrenceBuildFact.bugId = "ffffffff-ffff-4fff-8fff-fffffffffff3")],
    ["unvalidated Build relation", (candidate) => (candidate.occurrenceBuildFact.relationValidated = false)],
  ]) {
    const candidate = structuredClone(input);
    mutate(candidate);
    if (evaluateAppFirstBehavior("submission-receipt", candidate) !== "ambiguous") {
      failures.push(`${label}: ${suffix} was accepted`);
    }
  }
}
{
  const input = structuredClone(submissionReceiptCases[3][1]);
  input.claimedAttachmentFacts[0].claimedQaItemId =
    "ffffffff-ffff-4fff-8fff-fffffffffff8";
  if (evaluateAppFirstBehavior("submission-receipt", input) !== "ambiguous") {
    failures.push("recordVerificationResult accepted an attachment claimed by a foreign item");
  }
}

function attachPlainWriteReceipt(input, { operationId, scope, idempotencyKey, status, response }) {
  input.exactReplay = false;
  input.authorizationCheckedBeforeIdempotency = true;
  input.idempotencyKey = idempotencyKey;
  input.persistedIdempotencyKey = idempotencyKey;
  input.canonicalRequestDigest = canonicalNonSecretRequestDigest(
    operationId,
    scope,
    input.request,
    idempotencyKey,
  );
  input.persistedRequestDigest = input.canonicalRequestDigest;
  input.idempotencyRecordCommitted = true;
  input.originalEffectCommitted = true;
  input.atomicReceiptAndEffectCommitted = true;
  input.mutationCount = 1;
  input.httpStatus = status;
  input.responseHeaders = {};
  const persistedBody = structuredClone(response);
  if (persistedBody && typeof persistedBody === "object" && !Array.isArray(persistedBody)) {
    delete persistedBody.replayed;
  }
  input.persistedHttpReceipt = { status, headers: {}, body: persistedBody };
  return input;
}

function workflowWriteKey(input) {
  const expectedVersion = input.request.expectedVersion;
  switch (input.operationId) {
    case "createRepairAttempt":
      return `workflow:createRepairAttempt:bug:${input.pathBugId}:v${expectedVersion}`;
    case "startRepairAttempt":
    case "deliverRepairAttempt":
    case "failRepairAttempt":
      return `workflow:${input.operationId}:attempt:${input.pathAttemptId}:v${expectedVersion}`;
    case "supersedeRepairAttempt":
      return `workflow:supersedeRepairAttempt:attempt:${input.pathAttemptId}:v${expectedVersion}`;
    case "createVerification":
      return `workflow:createVerification:bug:${input.pathBugId}:attempt:${input.request.repairAttemptId}:v${expectedVersion}`;
    case "startVerification":
      return `workflow:startVerification:verification:${input.pathVerificationId}:v${expectedVersion}`;
    default:
      throw new Error(`Unknown workflow write operation ${input.operationId}`);
  }
}

function writeAuditDetailsForTest(input) {
  const request = input.request;
  const response =
    input.operationId === "supersedeRepairAttempt" && input.representation !== "legacy"
      ? input.response.supersededAttempt
      : input.response;
  const build = input.operationId === "linkBuildRepair" && input.representation !== "legacy"
    ? response.build
    : response;
  return {
    createRepairAttempt: {
      bugId: input.pathBugId,
      repairAttemptId: response.id,
      mode: request.mode,
      assigneeId: request.assigneeId,
      parentAttemptId: request.parentAttemptId ?? null,
    },
    startRepairAttempt: {
      repairAttemptId: response.id,
      fromStatus: "planned",
      toStatus: "running",
    },
    deliverRepairAttempt: {
      repairAttemptId: response.id,
      deliveryKind: request.deliveryKind,
      commitSha: response.commitSha ?? null,
      buildRequirement: input.effectFact.buildRequirement,
    },
    failRepairAttempt: { repairAttemptId: response.id, reason: request.reason },
    supersedeRepairAttempt: {
      repairAttemptId: response.id,
      successorAttemptId:
        request.successor?.id ?? input.successorAttemptFact?.attempt?.id ?? null,
      replacementMode: input.representation === "legacy" ? "legacy_two_step" : "atomic_successor",
      reason: request.reason,
    },
    createVerification: {
      bugId: input.pathBugId,
      verificationId: response.id,
      repairAttemptId: request.repairAttemptId,
      buildId: request.buildId ?? null,
      verifierId: request.verifierId,
    },
    startVerification: {
      verificationId: response.id,
      fromStatus: "requested",
      toStatus: "in_progress",
    },
    registerBuild: {
      buildId: build.id,
      provider: request.provider,
      externalId: request.externalId,
      sourceCommitSha: request.sourceCommitSha,
      status: request.status,
    },
    linkBuildRepair: {
      buildId: build.id,
      repairAttemptId: request.repairAttemptId,
      bugId: input.repairAttemptFact?.attempt?.bugId ?? null,
      linkId: input.linkRelationFact?.link?.id ?? null,
      buildRequirementId:
        input.committedBuildRequirementFact?.buildRequirement?.id ?? null,
      buildRequirementVersion:
        input.committedBuildRequirementFact?.buildRequirement?.version ?? null,
      bugVersionBefore: input.effectFact?.bugVersionBefore ?? null,
      bugVersionAfter: input.effectFact?.bugVersionAfter ?? null,
      deliveredCommitSha: request.deliveredCommitSha,
      evidenceType: request.evidenceType,
      overrideReason: request.overrideReason ?? null,
    },
  }[input.operationId];
}

function refreshTypedWriteEffects(input) {
  const eventType = {
    createRepairAttempt: "repair_attempt.created",
    startRepairAttempt: "repair_attempt.started",
    deliverRepairAttempt: "repair_attempt.delivered",
    failRepairAttempt: "repair_attempt.failed",
    supersedeRepairAttempt: "repair_attempt.superseded",
    createVerification: "verification.created",
    startVerification: "verification.started",
    registerBuild: "build.registered",
    linkBuildRepair: "build.repair_linked",
  }[input.operationId];
  input.effectFact.auditEventCount = 1;
  input.auditEventFact = {
    id: input.effectFact.auditEventId,
    type: eventType,
    source: "qa_hub",
    actorType: "user",
    accountId: input.accountId,
    actorId: input.actorId,
    projectId: input.effectFact.projectId,
    bugId: input.effectFact.bugId,
    resourceType: input.effectFact.resourceType,
    resourceId: input.effectFact.resourceId,
    resourceVersionAfter: input.effectFact.resourceVersionAfter,
    fromStatus: input.effectFact.fromStatus ?? null,
    toStatus: input.effectFact.toStatus ?? null,
    requestDigest: input.persistedRequestDigest,
    details: writeAuditDetailsForTest(input),
    typedRelationsValidated: true,
    committed: true,
  };
  input.notificationOutboxFact = {
    accountId: input.accountId,
    projectId: input.effectFact.projectId,
    bugId: input.effectFact.bugId,
    sourceOperationId: input.operationId,
    eventId: input.auditEventFact.id,
    messageIds: structuredClone(input.effectFact.notificationMessageIds),
    recipientsEvaluatedFromCurrentMembership: true,
    committed: true,
    atomicWithEffect: true,
  };
  return input;
}

function refreshWorkflowWriteReceipt(input) {
  const resourceResponse =
    input.operationId === "supersedeRepairAttempt" && input.representation !== "legacy"
      ? input.response.supersededAttempt
      : input.response;
  const bugId =
    input.pathBugId ??
    input.attemptResource?.bugId ??
    input.verificationResource?.bugId ??
    resourceResponse.bugId;
  const scope = {
    accountId: input.accountId,
    actorId: input.actorId,
    projectId: input.projectId,
    bugId,
    attemptId: input.pathAttemptId ?? null,
    verificationId: input.pathVerificationId ?? null,
  };
  attachPlainWriteReceipt(input, {
    operationId: input.operationId,
    scope,
    idempotencyKey: workflowWriteKey(input),
    status: ["createRepairAttempt", "createVerification"].includes(input.operationId)
      ? 201
      : 200,
    response: input.response,
  });
  input.committedResourceFact.resource = structuredClone(resourceResponse);
  input.committedResourceFact.resourceId = resourceResponse.id;
  input.effectFact.resourceId = resourceResponse.id;
  if (input.operationId === "deliverRepairAttempt") {
    input.deliveryFact.requestDigest = input.persistedRequestDigest;
    input.committedBuildRequirementFact.deliveryRequestDigest = input.persistedRequestDigest;
    input.committedBuildRequirementFact.deliveryDecisionAuditFact.deliveryRequestDigest =
      input.persistedRequestDigest;
  }
  return refreshTypedWriteEffects(input);
}

function makeWorkflowReplayReceipt(source) {
  const replay = structuredClone(source);
  const resourceResponse =
    source.operationId === "supersedeRepairAttempt" && source.representation !== "legacy"
      ? source.response.supersededAttempt
      : source.response;
  const bugId =
    source.pathBugId ??
    source.attemptResource?.bugId ??
    source.verificationResource?.bugId ??
    resourceResponse.bugId;
  const resourceType = ["createVerification", "startVerification"].includes(source.operationId)
    ? "verification"
    : "repair_attempt";
  replay.persistedPreconditionFact = {
    operationId: source.operationId,
    accountId: source.accountId,
    actorId: source.actorId,
    projectId: source.projectId,
    bugId,
    resourceType,
    resourceId: resourceResponse.id,
    requestDigest: source.persistedRequestDigest,
    auditEventId: source.effectFact.auditEventId,
    snapshotCommitted: true,
    atomicWithReceipt: true,
  };
  for (const field of [
    "bugResource",
    "attemptResource",
    "verificationResource",
    "repairAttemptFact",
    "buildFact",
    "verifierFact",
    "separationOfDutiesFact",
    "assigneeFact",
    "parentAttemptFact",
    "successorAttemptFact",
    "successorAssigneeFact",
    "deliveryFact",
    "buildRequirementFact",
    "linkRelationFact",
  ]) {
    if (Object.hasOwn(source, field)) {
      replay.persistedPreconditionFact[field] = structuredClone(source[field]);
    }
  }
  replay.replayCurrentResourceFact = {
    operationId: source.operationId,
    accountId: source.accountId,
    actorId: source.actorId,
    projectId: source.projectId,
    bugId,
    resourceType,
    resourceId: resourceResponse.id,
    currentVersion: resourceResponse.version,
    currentlyVisible: true,
    currentMembershipActive: true,
    authorizationRecheckedBeforeReplay: true,
  };
  if (replay.attemptResource) replay.attemptResource.attempt = structuredClone(resourceResponse);
  if (replay.verificationResource) {
    replay.verificationResource.verification = structuredClone(source.response);
  }
  if (source.operationId === "createRepairAttempt") {
    replay.bugResource.state = "in_progress";
    replay.bugResource.version += 1;
    replay.bugResource.activeAttemptId = source.response.id;
    replay.bugResource.noActiveRepairAttempt = false;
  }
  if (source.operationId === "createVerification") {
    replay.bugResource.version += 1;
    replay.bugResource.activeVerificationId = source.response.id;
    replay.bugResource.noActiveVerification = false;
  }
  if (["deliverRepairAttempt", "failRepairAttempt", "supersedeRepairAttempt"].includes(source.operationId)) {
    replay.bugResource.state = source.effectFact.bugStateAfter ?? replay.bugResource.state;
    replay.bugResource.version += 1;
    replay.bugResource.activeAttemptId = source.effectFact.activeAttemptIdAfter;
  }
  replay.exactReplay = true;
  replay.replayAuthorized = true;
  replay.mutationCount = 0;
  if (source.operationId === "supersedeRepairAttempt" && source.representation !== "legacy") {
    replay.response.replayed = true;
  }
  return replay;
}

function attachWorkflowBugFacts(input) {
  const bugId =
    input.pathBugId ??
    input.attemptResource?.bugId ??
    input.verificationResource?.bugId ??
    input.response.bugId;
  input.bugResource.activeAttemptId ??= null;
  input.bugResource.activeVerificationId ??= null;
  input.bugResource.bug = {
    ...structuredClone(createResponse.bug),
    id: bugId,
    projectId: input.projectId,
    state: input.bugResource.state,
    version: input.bugResource.version,
    updatedAt: "2026-08-24T10:40:00Z",
    closedAt: null,
  };
  const mutatesBug = !["startRepairAttempt", "startVerification"].includes(input.operationId);
  const stateAfter = input.effectFact.bugStateAfter ?? input.bugResource.state;
  const versionAfter = input.bugResource.version + (mutatesBug ? 1 : 0);
  Object.assign(input.effectFact, {
    bugStateBefore: input.bugResource.state,
    bugStateAfter: stateAfter,
    bugVersionBefore: input.bugResource.version,
    bugVersionAfter: versionAfter,
    bugMutationCount: mutatesBug ? 1 : 0,
  });
  input.committedBugFact = {
    accountId: input.accountId,
    projectId: input.projectId,
    bugId,
    bug: {
      ...structuredClone(input.bugResource.bug),
      state: stateAfter,
      version: versionAfter,
      updatedAt: mutatesBug ? "2026-08-24T10:41:00Z" : input.bugResource.bug.updatedAt,
    },
    activeAttemptId: Object.hasOwn(input.effectFact, "activeAttemptIdAfter")
      ? input.effectFact.activeAttemptIdAfter
      : input.bugResource.activeAttemptId,
    activeVerificationId: Object.hasOwn(input.effectFact, "activeVerificationIdAfter")
      ? input.effectFact.activeVerificationIdAfter
      : input.bugResource.activeVerificationId,
    committed: true,
    atomicWithWrite: true,
  };
  return input;
}

function makeWorkflowWriteReceipt(operationId, representation = "vendor") {
  const example = operationExamples[operationId];
  const request = structuredClone(example.request);
  let httpResponse = structuredClone(example.response);
  if (operationId === "supersedeRepairAttempt" && representation === "legacy") {
    delete request.successor;
    httpResponse = structuredClone(example.response.supersededAttempt);
  }
  const response =
    operationId === "supersedeRepairAttempt" && representation === "vendor"
      ? httpResponse.supersededAttempt
      : httpResponse;
  const isVerification = ["createVerification", "startVerification"].includes(operationId);
  const bugId = example.pathParameters.bugId ?? response.bugId;
  const input = {
    operationId,
    representation,
    accountId: submissionAccountId,
    actorId: receiptActorId,
    authorizedProjectIds: [authorizedProjectId],
    projectId: authorizedProjectId,
    pathBugId: example.pathParameters.bugId,
    pathAttemptId: example.pathParameters.attemptId,
    pathVerificationId: example.pathParameters.verificationId,
    request,
    response: httpResponse,
    membershipFact: {
      accountId: submissionAccountId,
      actorId: receiptActorId,
      projectId: authorizedProjectId,
      currentActive: true,
    },
    authorizationFact: {
      operationId,
      accountId: submissionAccountId,
      actorId: receiptActorId,
      projectId: authorizedProjectId,
      authorizedHuman: true,
      capabilityGranted: true,
      resolvedCurrentResourceBeforeIdempotency: true,
    },
    committedResourceFact: {
      accountId: submissionAccountId,
      projectId: authorizedProjectId,
      resourceType: isVerification ? "verification" : "repair_attempt",
      resourceId: response.id,
      resource: structuredClone(response),
    },
    effectFact: {
      operationId,
      accountId: submissionAccountId,
      actorId: receiptActorId,
      projectId: authorizedProjectId,
      bugId,
      resourceType: isVerification ? "verification" : "repair_attempt",
      resourceId: response.id,
      domainMutationCommitted: true,
      auditEventCommitted: true,
      notificationOutboxCommitted: true,
      idempotencyRecordCommitted: true,
      atomicWithReceipt: true,
      auditEventId: `audit:${operationId}:1`,
      notificationMessageIds: [`notification:${operationId}:1`],
      bugMutationCount: 0,
      buildRequirementMutationCount: 0,
      verificationMutationCount: 0,
      bugClosureMutationCount: 0,
      humanAcceptanceMutationCount: 0,
    },
  };

  if (operationId === "createRepairAttempt") {
    Object.assign(input, {
      bugResource: {
        accountId: submissionAccountId,
        projectId: authorizedProjectId,
        bugId,
        state: "ready",
        version: input.request.expectedVersion,
        activeAttemptId: null,
        noActiveRepairAttempt: true,
        nextAttemptSequence: response.sequence,
      },
      assigneeFact: {
        accountId: submissionAccountId,
        projectId: authorizedProjectId,
        userId: input.request.assigneeId,
        currentActive: true,
        assignable: true,
      },
    });
    Object.assign(input.effectFact, {
      fromStatus: "ready",
      toStatus: "in_progress",
      bugVersionBefore: input.request.expectedVersion,
      bugVersionAfter: input.request.expectedVersion + 1,
      activeAttemptIdBefore: null,
      activeAttemptIdAfter: response.id,
      resourceVersionBefore: 0,
      resourceVersionAfter: 1,
    });
  } else if (["startRepairAttempt", "deliverRepairAttempt", "failRepairAttempt", "supersedeRepairAttempt"].includes(operationId)) {
    const current = structuredClone(response);
    current.status = operationId === "startRepairAttempt" ? "planned" : "running";
    current.version = input.request.expectedVersion;
    if (operationId !== "startRepairAttempt") current.summary = "Correct the rotated login layout.";
    if (operationId === "deliverRepairAttempt") {
      current.branch = null;
      current.commitSha = null;
    }
    input.attemptResource = {
      accountId: submissionAccountId,
      projectId: authorizedProjectId,
      bugId,
      attempt: current,
    };
    input.bugResource = {
      accountId: submissionAccountId,
      projectId: authorizedProjectId,
      bugId,
      state: "in_progress",
      version: 3,
      activeAttemptId: current.id,
    };
    Object.assign(input.effectFact, {
      fromStatus: current.status,
      toStatus: response.status,
      resourceVersionBefore: current.version,
      resourceVersionAfter: response.version,
      bugVersionBefore: input.bugResource.version,
      bugVersionAfter: input.bugResource.version,
      activeAttemptIdBefore: current.id,
      activeAttemptIdAfter: current.id,
    });
    if (operationId === "deliverRepairAttempt") {
      input.deliveryFact = {
        accountId: submissionAccountId,
        projectId: authorizedProjectId,
        bugId,
        attemptId: response.id,
        request: structuredClone(input.request),
        commitEvidenceValidated: true,
        resolvedEvidenceCommitted: true,
        resolvedEvidence: {
          branch: input.request.branch ?? null,
          commitSha: input.request.commitSha ?? null,
          mergeRequestUrl: input.request.mergeRequestUrl ?? null,
          patchUrl: input.request.patchUrl ?? null,
          noCodeReason: null,
        },
      };
      const requirementRecord = deliveryBuildRequirementRecord("required");
      input.effectFact.auditEventId = requirementRecord.decisionAuditEventId;
      input.buildRequirementFact = {
        accountId: submissionAccountId,
        projectId: authorizedProjectId,
        bugId,
        requirementId: requirementRecord.id,
        didNotExistBefore: true,
      };
      input.committedBuildRequirementFact = buildRequirementFact(requirementRecord, {
        deliveryRequestDigest: null,
        current: false,
        committedWithDelivery: true,
        atomicWithReceipt: true,
      });
      Object.assign(input.effectFact, {
        buildRequirement: "required",
        buildRequirementId: requirementRecord.id,
        buildRequirementVersionBefore: 0,
        buildRequirementVersionAfter: 1,
        buildRequirementMutationCount: 1,
        bugStateAfter: "awaiting_build",
        bugVersionAfter: input.bugResource.version + 1,
      });
    } else if (operationId === "failRepairAttempt") {
      Object.assign(input.effectFact, {
        bugStateAfter: "ready",
        bugVersionAfter: input.bugResource.version + 1,
        activeAttemptIdAfter: null,
      });
    } else if (operationId === "supersedeRepairAttempt") {
      if (representation === "vendor") {
        const successor = structuredClone(httpResponse.successorAttempt);
      input.successorAttemptFact = {
          accountId: submissionAccountId,
          projectId: authorizedProjectId,
          bugId,
          attempt: successor,
        identityUnusedBefore: true,
        sequenceUniqueWithinBug: true,
        createdAtomically: true,
          atomicWithReceipt: true,
          onlyActiveAttemptAfter: true,
        };
        input.successorAssigneeFact = {
          accountId: submissionAccountId,
          projectId: authorizedProjectId,
          userId: input.request.successor.assigneeId,
          currentActive: true,
          assignable: true,
        };
      Object.assign(input.effectFact, {
        supersededAttemptMutationCount: 1,
        successorAttemptId: successor.id,
        successorVersionAfter: 1,
        successorAttemptMutationCount: 1,
          bugStateAfter: "in_progress",
          bugVersionAfter: input.bugResource.version + 1,
          activeAttemptIdAfter: successor.id,
          auditEventId: httpResponse.eventId,
        });
      } else {
        Object.assign(input.effectFact, {
          supersededAttemptMutationCount: 1,
          successorAttemptId: null,
          successorVersionAfter: 0,
          successorAttemptMutationCount: 0,
          bugStateAfter: "ready",
          bugVersionAfter: input.bugResource.version + 1,
          activeAttemptIdAfter: null,
        });
      }
      if (representation === "vendor") {
        input.bugResource.nextAttemptSequence = input.successorAttemptFact.attempt.sequence;
      }
    }
  } else if (operationId === "createVerification") {
    const attempt = structuredClone(operationExamples.deliverRepairAttempt.response);
    input.bugResource = {
      accountId: submissionAccountId,
      projectId: authorizedProjectId,
      bugId,
      state: "ready_for_verification",
      version: input.request.expectedVersion,
      activeAttemptId: attempt.id,
      activeVerificationId: null,
      noActiveVerification: true,
    };
    input.repairAttemptFact = {
      accountId: submissionAccountId,
      projectId: authorizedProjectId,
      bugId,
      attempt,
      latestNonSuperseded: true,
      eligibleForVerification: true,
    };
    input.buildFact = {
      accountId: submissionAccountId,
      projectId: authorizedProjectId,
      build: structuredClone(operationExamples.linkBuildRepair.response.build),
      exactDeliveredCommitEligible: true,
    };
    input.buildRequirementFact = buildRequirementFact(linkedBuildRequirementRecord());
    input.linkRelationFact = buildRepairLinkFact(
      operationExamples.linkBuildRepair.response.repairLink,
    );
    input.verifierFact = {
      accountId: submissionAccountId,
      projectId: authorizedProjectId,
      userId: input.request.verifierId,
      currentActive: true,
      canVerify: true,
    };
    input.separationOfDutiesFact = {
      repairAssigneeId: attempt.assigneeId,
      verifierId: input.request.verifierId,
      passed: true,
    };
    Object.assign(input.effectFact, {
      fromStatus: "ready_for_verification",
      toStatus: "ready_for_verification",
      bugVersionBefore: input.request.expectedVersion,
      bugVersionAfter: input.request.expectedVersion + 1,
      resourceVersionBefore: 0,
      resourceVersionAfter: 1,
      activeVerificationIdAfter: response.id,
    });
  } else {
    const current = {
      ...structuredClone(response),
      status: "requested",
      version: input.request.expectedVersion,
    };
    input.verificationResource = {
      accountId: submissionAccountId,
      projectId: authorizedProjectId,
      bugId,
      verification: current,
    };
    input.bugResource = {
      accountId: submissionAccountId,
      projectId: authorizedProjectId,
      bugId,
      state: "ready_for_verification",
      version: 6,
      activeAttemptId: current.repairAttemptId,
      activeVerificationId: current.id,
    };
    Object.assign(input.effectFact, {
      fromStatus: "requested",
      toStatus: "in_progress",
      resourceVersionBefore: input.request.expectedVersion,
      resourceVersionAfter: response.version,
      bugVersionBefore: input.bugResource.version,
      bugVersionAfter: input.bugResource.version,
      activeVerificationIdAfter: current.id,
    });
  }
  attachWorkflowBugFacts(input);
  return refreshWorkflowWriteReceipt(input);
}

const workflowWriteReceiptCases = writeReceiptOperationIds
  .filter((operationId) => !["registerBuild", "linkBuildRepair"].includes(operationId))
  .map((operationId) => [operationId, makeWorkflowWriteReceipt(operationId)]);
for (const [operationId, source] of workflowWriteReceiptCases) {
  if (evaluateAppFirstBehavior("workflow-write-receipt", source) !== "unambiguous") {
    failures.push(`${operationId}: fresh atomic workflow receipt is ambiguous`);
  }
  {
    const replay = makeWorkflowReplayReceipt(source);
    if (evaluateAppFirstBehavior("workflow-write-receipt", replay) !== "unambiguous") {
      failures.push(`${operationId}: exact authorized workflow replay was rejected`);
    }
    replay.replayCurrentResourceFact.currentVersion += 2;
    if (evaluateAppFirstBehavior("workflow-write-receipt", replay) !== "unambiguous") {
      failures.push(`${operationId}: authorized replay after a later visible version was rejected`);
    }
  }
  {
    const stalePrestateReplay = structuredClone(source);
    stalePrestateReplay.exactReplay = true;
    stalePrestateReplay.replayAuthorized = true;
    stalePrestateReplay.mutationCount = 0;
    if (
      evaluateAppFirstBehavior("workflow-write-receipt", stalePrestateReplay) !== "ambiguous"
    ) {
      failures.push(`${operationId}: replay without a current authorization snapshot was accepted`);
    }
  }
  for (const [label, mutate] of [
    ["revoked membership", (input) => (input.membershipFact.currentActive = false)],
    ["authorization after idempotency", (input) => (input.authorizationFact.resolvedCurrentResourceBeforeIdempotency = false)],
    ["missing audit event", (input) => (input.effectFact.auditEventCommitted = false)],
    ["missing notification outbox", (input) => (input.effectFact.notificationOutboxCommitted = false)],
    ["non-atomic effect", (input) => (input.effectFact.atomicWithReceipt = false)],
    ["forged audit payload", (input) => (input.auditEventFact.payload = { accepted: true })],
    ["mismatched notification event", (input) => (input.notificationOutboxFact.eventId = "other")],
    ["unrelated committed Bug mutation", (input) => (input.committedBugFact.bug.title += " forged")],
  ]) {
    const candidate = structuredClone(source);
    mutate(candidate);
    if (evaluateAppFirstBehavior("workflow-write-receipt", candidate) !== "ambiguous") {
      failures.push(`${operationId}: ${label} was accepted`);
    }
  }
  {
    const candidate = structuredClone(source);
    if (candidate.pathBugId) candidate.pathBugId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
    else if (candidate.pathAttemptId) candidate.pathAttemptId = "ffffffff-ffff-4fff-8fff-fffffffffff2";
    else candidate.pathVerificationId = "ffffffff-ffff-4fff-8fff-fffffffffff3";
    refreshWorkflowWriteReceipt(candidate);
    if (evaluateAppFirstBehavior("workflow-write-receipt", candidate) !== "ambiguous") {
      failures.push(`${operationId}: internally re-signed foreign path was accepted`);
    }
  }
  {
    const candidate = structuredClone(source);
    if (candidate.attemptResource) candidate.attemptResource.attempt.version += 1;
    else if (candidate.verificationResource) candidate.verificationResource.verification.version += 1;
    else candidate.bugResource.version += 1;
    if (evaluateAppFirstBehavior("workflow-write-receipt", candidate) !== "ambiguous") {
      failures.push(`${operationId}: stale or mismatched current version was accepted`);
    }
  }
  {
    const wrongStatusByOperation = {
      createRepairAttempt: "running",
      startRepairAttempt: "planned",
      deliverRepairAttempt: "running",
      failRepairAttempt: "delivered",
      supersedeRepairAttempt: "failed",
      createVerification: "in_progress",
      startVerification: "passed",
    };
    const candidate = structuredClone(source);
    candidate.response.status = wrongStatusByOperation[operationId];
    candidate.effectFact.toStatus = candidate.response.status;
    refreshWorkflowWriteReceipt(candidate);
    if (evaluateAppFirstBehavior("workflow-write-receipt", candidate) !== "ambiguous") {
      failures.push(`${operationId}: internally persisted wrong transition status was accepted`);
    }
  }
  {
    const candidate = structuredClone(source);
    candidate.response.version += 1;
    candidate.effectFact.resourceVersionAfter = candidate.response.version;
    refreshWorkflowWriteReceipt(candidate);
    if (evaluateAppFirstBehavior("workflow-write-receipt", candidate) !== "ambiguous") {
      failures.push(`${operationId}: internally persisted wrong response version was accepted`);
    }
  }
}

{
  const policyAllowedSelfVerification = makeWorkflowWriteReceipt("createVerification");
  const verifierId = policyAllowedSelfVerification.request.verifierId;
  policyAllowedSelfVerification.repairAttemptFact.attempt.assigneeId = verifierId;
  policyAllowedSelfVerification.separationOfDutiesFact = {
    repairAssigneeId: verifierId,
    verifierId,
    passed: true,
  };
  refreshWorkflowWriteReceipt(policyAllowedSelfVerification);
  if (
    evaluateAppFirstBehavior("workflow-write-receipt", policyAllowedSelfVerification) !==
    "unambiguous"
  ) {
    failures.push("createVerification rejected a policy-approved same-assignee verifier fact");
  }
  const policyRejectedSelfVerification = structuredClone(policyAllowedSelfVerification);
  policyRejectedSelfVerification.separationOfDutiesFact.passed = false;
  if (
    evaluateAppFirstBehavior("workflow-write-receipt", policyRejectedSelfVerification) !==
    "ambiguous"
  ) {
    failures.push("createVerification accepted a policy-rejected same-assignee verifier fact");
  }
}

function makeNotRequiredDeliveryReceipt({ deliveryKind, withExemption = false }) {
  const input = makeWorkflowWriteReceipt("deliverRepairAttempt");
  const noCode = deliveryKind === "no_code";
  input.request.deliveryKind = deliveryKind;
  input.request.summary = noCode
    ? "No code change is required for this QA correction."
    : "Delivered code under an authorized no-Build exemption.";
  input.response.summary = input.request.summary;
  if (noCode) {
    delete input.request.branch;
    delete input.request.commitSha;
    delete input.request.mergeRequestUrl;
    delete input.request.patchUrl;
    input.request.noCodeReason = "The issue is corrected by server-side test data.";
    input.response.branch = null;
    input.response.commitSha = null;
    input.response.mergeRequestUrl = null;
    input.deliveryFact.noCodeEvidenceValidated = true;
    delete input.deliveryFact.commitEvidenceValidated;
    input.deliveryFact.resolvedEvidence = {
      branch: null,
      commitSha: null,
      mergeRequestUrl: null,
      patchUrl: null,
      noCodeReason: input.request.noCodeReason,
    };
  }
  input.deliveryFact.request = structuredClone(input.request);
  const record = deliveryBuildRequirementRecord("not_required");
  const exemptionReason = "This internal-only code path does not produce an installable Build.";
  if (noCode) {
    record.decisionReason = input.request.noCodeReason;
  } else {
    record.deliveredCommitSha = input.response.commitSha;
    record.decisionBasis = "authorized_no_build_exemption";
    record.decisionReason = exemptionReason;
  }
  record.decisionActorId = input.actorId;
  input.buildRequirementFact.requirementId = record.id;
  input.committedBuildRequirementFact = buildRequirementFact(record, {
    deliveryRequestDigest: null,
    current: false,
    committedWithDelivery: true,
    atomicWithReceipt: true,
  });
  Object.assign(input.effectFact, {
    buildRequirement: "not_required",
    buildRequirementId: record.id,
    buildRequirementVersionBefore: 0,
    buildRequirementVersionAfter: 1,
    buildRequirementMutationCount: 1,
    bugStateAfter: "ready_for_verification",
    activeAttemptIdAfter: input.response.id,
  });
  if (withExemption) {
    input.buildExemptionFact = {
      accountId: input.accountId,
      actorId: input.actorId,
      projectId: input.projectId,
      bugId: input.response.bugId,
      repairAttemptId: input.response.id,
      authorizedReleaseOverride: true,
      reason: exemptionReason,
    };
  }
  attachWorkflowBugFacts(input);
  return refreshWorkflowWriteReceipt(input);
}

{
  const noCode = makeNotRequiredDeliveryReceipt({ deliveryKind: "no_code" });
  validateAppExample(
    "../schemas/app-first.schema.json#/$defs/deliverRepairAttemptRequest",
    noCode.request,
    "deliverRepairAttempt no-code request",
  );
  if (evaluateAppFirstBehavior("workflow-write-receipt", noCode) !== "unambiguous") {
    failures.push("deliverRepairAttempt no-code delivery was rejected");
  }
  const injected = structuredClone(noCode);
  injected.response.branch = "forged-branch";
  refreshWorkflowWriteReceipt(injected);
  if (evaluateAppFirstBehavior("workflow-write-receipt", injected) !== "ambiguous") {
    failures.push("deliverRepairAttempt no-code delivery accepted injected code evidence");
  }
  const validateDeliver = ajv.getSchema(
    `${appSchema.$id}#/$defs/deliverRepairAttemptRequest`,
  );
  const invalidWire = structuredClone(noCode.request);
  invalidWire.branch = "forged-branch";
  if (validateDeliver?.(invalidWire)) {
    failures.push("deliverRepairAttempt vendor schema accepted mixed no-code and code evidence");
  }
}

{
  const missingExemption = makeNotRequiredDeliveryReceipt({ deliveryKind: "code" });
  if (evaluateAppFirstBehavior("workflow-write-receipt", missingExemption) !== "ambiguous") {
    failures.push("deliverRepairAttempt code delivery skipped Build without an exemption");
  }
  const exempt = makeNotRequiredDeliveryReceipt({ deliveryKind: "code", withExemption: true });
  if (evaluateAppFirstBehavior("workflow-write-receipt", exempt) !== "unambiguous") {
    failures.push("deliverRepairAttempt authorized code no-Build exemption was rejected");
  }
}

{
  const validateRequirement = ajv.getSchema(`${appSchema.$id}#/$defs/buildRequirement`);
  const requiredUnlinked = deliveryBuildRequirementRecord("required");
  const requiredLinked = linkedBuildRequirementRecord();
  const noCode = makeNotRequiredDeliveryReceipt({ deliveryKind: "no_code" })
    .committedBuildRequirementFact.buildRequirement;
  const exempt = makeNotRequiredDeliveryReceipt({ deliveryKind: "code", withExemption: true })
    .committedBuildRequirementFact.buildRequirement;
  for (const [label, record] of [
    ["required-unlinked v1", requiredUnlinked],
    ["required-linked v2", requiredLinked],
    ["no-code v1", noCode],
    ["authorized no-Build exemption v1", exempt],
  ]) {
    if (!validateRequirement?.(record)) {
      failures.push(`BuildRequirement wire rejected reachable ${label}`);
    }
  }
  for (const [label, mutate] of [
    ["linked version 99", (record) => (record.version = 99)],
    ["linked Build without link id", (record) => (record.linkId = null)],
    ["required-unlinked with stray link", (record) => {
      record.linkedBuildId = null;
      record.linkId = "b1000000-0000-4000-8000-000000000001";
      record.version = 1;
    }],
    ["required without delivered commit", (record) => (record.deliveredCommitSha = null)],
    ["no-code mislabeled as exemption", (record) => {
      record.requirement = "not_required";
      record.deliveredCommitSha = null;
      record.decisionBasis = "authorized_no_build_exemption";
      record.decisionReason = "forged";
      record.decisionActorId = receiptActorId;
      record.linkedBuildId = null;
      record.linkId = null;
      record.version = 1;
    }],
  ]) {
    const candidate = structuredClone(requiredLinked);
    mutate(candidate);
    if (validateRequirement?.(candidate)) {
      failures.push(`BuildRequirement wire accepted impossible state: ${label}`);
    }
  }
}

{
  const legacy = makeWorkflowWriteReceipt("supersedeRepairAttempt", "legacy");
  const legacyDefinition = baseManifest.operations.find(
    (entry) => entry.operationId === "supersedeRepairAttempt",
  );
  validateStableExample(
    legacyDefinition.requestRef,
    legacy.request,
    "supersedeRepairAttempt legacy two-step request",
  );
  validateStableExample(
    legacyDefinition.responseRef,
    legacy.response,
    "supersedeRepairAttempt legacy two-step response",
  );
  if (evaluateAppFirstBehavior("workflow-write-receipt", legacy) !== "unambiguous") {
    failures.push("supersedeRepairAttempt legacy two-step receipt was rejected");
  }
  const replay = makeWorkflowReplayReceipt(legacy);
  if (evaluateAppFirstBehavior("workflow-write-receipt", replay) !== "unambiguous") {
    failures.push("supersedeRepairAttempt legacy two-step exact replay was rejected");
  }
  for (const [label, mutate] of [
    ["silently created successor", (input) => {
      input.successorAttemptFact = structuredClone(
        makeWorkflowWriteReceipt("supersedeRepairAttempt").successorAttemptFact,
      );
    }],
    ["kept Bug in progress", (input) => {
      input.effectFact.bugStateAfter = "in_progress";
      input.committedBugFact.bug.state = "in_progress";
    }],
    ["kept an active Attempt", (input) => {
      input.effectFact.activeAttemptIdAfter = input.pathAttemptId;
      input.committedBugFact.activeAttemptId = input.pathAttemptId;
    }],
  ]) {
    const candidate = structuredClone(legacy);
    mutate(candidate);
    refreshWorkflowWriteReceipt(candidate);
    if (evaluateAppFirstBehavior("workflow-write-receipt", candidate) !== "ambiguous") {
      failures.push(`supersedeRepairAttempt legacy: ${label} was accepted`);
    }
  }
}

{
  const candidate = makeWorkflowWriteReceipt("supersedeRepairAttempt");
  candidate.request.successor.id = candidate.pathAttemptId;
  candidate.response.successorAttempt.id = candidate.pathAttemptId;
  candidate.successorAttemptFact.attempt.id = candidate.pathAttemptId;
  candidate.effectFact.successorAttemptId = candidate.pathAttemptId;
  refreshWorkflowWriteReceipt(candidate);
  if (evaluateAppFirstBehavior("workflow-write-receipt", candidate) !== "ambiguous") {
    failures.push("supersedeRepairAttempt vendor accepted a self-successor");
  }
}

{
  const candidate = makeWorkflowWriteReceipt("supersedeRepairAttempt");
  candidate.successorAttemptFact.identityUnusedBefore = false;
  if (evaluateAppFirstBehavior("workflow-write-receipt", candidate) !== "ambiguous") {
    failures.push("supersedeRepairAttempt vendor accepted a pre-existing successor id");
  }
}

for (const [label, mutate] of [
  ["non-server-derived sequence", (input) => (input.bugResource.nextAttemptSequence = 99)],
  ["non-unique sequence", (input) => (input.successorAttemptFact.sequenceUniqueWithinBug = false)],
  ["multiple successor mutations", (input) => (input.effectFact.successorAttemptMutationCount = 2)],
  ["multiple superseded mutations", (input) => (input.effectFact.supersededAttemptMutationCount = 2)],
]) {
  const candidate = makeWorkflowWriteReceipt("supersedeRepairAttempt");
  mutate(candidate);
  if (evaluateAppFirstBehavior("workflow-write-receipt", candidate) !== "ambiguous") {
    failures.push(`supersedeRepairAttempt vendor accepted ${label}`);
  }
}

{
  const candidate = makeWorkflowWriteReceipt("createRepairAttempt");
  candidate.request.parentAttemptId = candidate.response.id;
  candidate.response.parentAttemptId = candidate.response.id;
  candidate.parentAttemptFact = {
    accountId: candidate.accountId,
    projectId: candidate.projectId,
    bugId: candidate.pathBugId,
    attemptId: candidate.response.id,
    ancestryExcludesNewAttempt: true,
    parentCanAcceptChild: true,
  };
  refreshWorkflowWriteReceipt(candidate);
  if (evaluateAppFirstBehavior("workflow-write-receipt", candidate) !== "ambiguous") {
    failures.push("createRepairAttempt accepted a self-parent relation");
  }
}

function refreshBuildWriteReceipt(input) {
  const build = input.operationId === "linkBuildRepair" && input.representation === "vendor"
    ? input.response.build
    : input.response;
  const projectId = input.pathProjectId ?? input.buildResource?.projectId ?? build.projectId;
  const idempotencyKey = input.operationId === "registerBuild"
    ? `build:register:project:${input.pathProjectId}:provider:${input.request.provider}:external:${input.request.externalId}`
    : `build:link:${input.pathBuildId}:attempt:${input.request.repairAttemptId}:v${input.request.expectedVersion}`;
  attachPlainWriteReceipt(input, {
    operationId: input.operationId,
    scope: {
      accountId: input.accountId,
      actorId: input.actorId,
      projectId,
      buildId: input.pathBuildId ?? null,
    },
    idempotencyKey,
    status: input.operationId === "registerBuild" ? 201 : 200,
    response: input.response,
  });
  input.committedBuildFact.build = structuredClone(build);
  input.effectFact.resourceId = build.id;
  return refreshTypedWriteEffects(input);
}

function makeBuildWriteReceipt(operationId, representation = "vendor") {
  const example = operationExamples[operationId];
  const input = {
    operationId,
    representation,
    accountId: submissionAccountId,
    actorId: receiptActorId,
    authorizedProjectIds: [authorizedProjectId],
    pathProjectId: example.pathParameters.projectId,
    pathBuildId: example.pathParameters.buildId,
    request: structuredClone(example.request),
    response:
      operationId === "linkBuildRepair" && representation === "legacy"
        ? structuredClone(example.response.build)
        : structuredClone(example.response),
    membershipFact: {
      accountId: submissionAccountId,
      actorId: receiptActorId,
      projectId: authorizedProjectId,
      currentActive: true,
    },
    authorizationFact: {
      operationId,
      accountId: submissionAccountId,
      actorId: receiptActorId,
      projectId: authorizedProjectId,
      authorizedHuman: true,
      capabilityGranted: true,
      resolvedCurrentResourceBeforeIdempotency: true,
    },
    effectFact: {
      operationId,
      accountId: submissionAccountId,
      actorId: receiptActorId,
      projectId: authorizedProjectId,
      bugId: null,
      resourceType: "build",
      resourceId: null,
      domainMutationCommitted: true,
      auditEventCommitted: true,
      notificationOutboxCommitted: true,
      idempotencyRecordCommitted: true,
      atomicWithReceipt: true,
      auditEventId: `audit:${operationId}:1`,
      notificationMessageIds: [`notification:${operationId}:1`],
      bugMutationCount: 0,
      buildRequirementMutationCount: 0,
      verificationMutationCount: 0,
      bugClosureMutationCount: 0,
      humanAcceptanceMutationCount: 0,
    },
    committedBuildFact: {
      accountId: submissionAccountId,
      projectId: authorizedProjectId,
      build: null,
    },
  };
  if (operationId === "linkBuildRepair" && representation === "legacy") {
    delete input.request.expectedBugVersion;
    delete input.request.expectedBuildRequirementVersion;
  }
  if (operationId === "registerBuild") {
    Object.assign(input, {
      projectFact: {
        accountId: submissionAccountId,
        projectId: authorizedProjectId,
        projectKey: input.request.projectKey,
        currentActive: true,
      },
      releaseAuthorityFact: {
        accountId: submissionAccountId,
        actorId: receiptActorId,
        projectId: authorizedProjectId,
        canRegisterBuild: true,
      },
      providerIdentityFact: {
        accountId: submissionAccountId,
        projectId: authorizedProjectId,
        provider: input.request.provider,
        externalId: input.request.externalId,
        globallyUniqueWithinProject: true,
        convergesOnBuildId: input.response.id,
      },
      artifactFact: {
        accountId: submissionAccountId,
        projectId: authorizedProjectId,
        buildId: input.response.id,
        provider: input.request.provider,
        externalId: input.request.externalId,
        sourceCommitSha: input.request.sourceCommitSha,
        manifestDigest: createHash("sha256")
          .update(canonicalString(input.request.manifest))
          .digest("hex"),
        sha256: input.request.manifest.artifactSha256,
        downloadUrl: input.request.downloadUrl,
        durablyReadable: true,
        verified: true,
      },
    });
    Object.assign(input.effectFact, { resourceVersionBefore: 0, resourceVersionAfter: 1 });
  } else {
    const build = representation === "vendor" ? input.response.build : input.response;
    const currentBuild = { ...structuredClone(build), version: input.request.expectedVersion };
    const attempt = structuredClone(operationExamples.deliverRepairAttempt.response);
    const currentRequirement = deliveryBuildRequirementRecord("required");
    const committedRequirement = linkedBuildRequirementRecord();
    const committedBug = structuredClone(example.response.bug);
    const currentBug = {
      ...structuredClone(committedBug),
      state: "awaiting_build",
      version: currentRequirement.bugVersionAtDelivery,
      updatedAt: currentRequirement.createdAt,
    };
    input.buildResource = {
      accountId: submissionAccountId,
      projectId: authorizedProjectId,
      build: currentBuild,
    };
    input.repairAttemptFact = {
      accountId: submissionAccountId,
      projectId: authorizedProjectId,
      bugId: attempt.bugId,
      attempt,
      latestNonSuperseded: true,
    };
    input.bugResource = {
      accountId: submissionAccountId,
      projectId: authorizedProjectId,
      bugId: attempt.bugId,
      activeAttemptId: attempt.id,
      bug: currentBug,
    };
    input.committedBugFact = {
      accountId: submissionAccountId,
      projectId: authorizedProjectId,
      bugId: attempt.bugId,
      activeAttemptId: attempt.id,
      bug: committedBug,
      committed: true,
      atomicWithBuildLink: true,
    };
    input.buildRequirementFact = buildRequirementFact(currentRequirement);
    input.committedBuildRequirementFact = buildRequirementFact(committedRequirement, {
      current: false,
      committed: true,
      atomicWithLink: true,
    });
    if (representation === "legacy") {
      input.legacyLinkCasFact = {
        accountId: submissionAccountId,
        projectId: authorizedProjectId,
        bugId: attempt.bugId,
        repairAttemptId: attempt.id,
        expectedBugVersion: currentRequirement.bugVersionAtDelivery,
        expectedBuildRequirementVersion: currentRequirement.version,
        derivedFromStoredBuildRequirement: true,
        exactCompareAndSwap: true,
      };
    }
    input.manifestEvidenceFact = {
      accountId: submissionAccountId,
      projectId: authorizedProjectId,
      buildId: currentBuild.id,
      repairAttemptId: attempt.id,
      deliveredCommitSha: input.request.deliveredCommitSha,
      manifestDigest: createHash("sha256")
        .update(canonicalString(currentBuild.manifest))
        .digest("hex"),
      manifestVerified: true,
    };
    const link = structuredClone(example.response.repairLink);
    input.linkRelationFact = buildRepairLinkFact(link, { didNotExistBefore: true });
    Object.assign(input.effectFact, {
      bugId: attempt.bugId,
      auditEventId: example.response.eventId,
      resourceVersionBefore: input.request.expectedVersion,
      resourceVersionAfter: build.version,
      bugVersionBefore: currentBug.version,
      bugVersionAfter: committedBug.version,
      bugStateBefore: "awaiting_build",
      bugStateAfter: "ready_for_verification",
      bugMutationCount: 1,
      buildRequirementId: currentRequirement.id,
      buildRequirementVersionBefore: currentRequirement.version,
      buildRequirementVersionAfter: committedRequirement.version,
      buildRequirementMutationCount: 1,
      verificationMutationCount: 0,
      bugClosureMutationCount: 0,
      humanAcceptanceMutationCount: 0,
    });
  }
  return refreshBuildWriteReceipt(input);
}

function makeOverrideBuildLinkReceipt(representation = "vendor") {
  const input = makeBuildWriteReceipt("linkBuildRepair", representation);
  const build = representation === "vendor" ? input.response.build : input.response;
  const overrideReason = "The release manager verified an equivalent rebuilt artifact.";
  input.request.evidenceType = "release_manager_override";
  input.request.overrideReason = overrideReason;
  input.overrideAuthorityFact = {
    accountId: input.accountId,
    actorId: input.actorId,
    projectId: input.buildResource.projectId,
    canOverrideBuildEvidence: true,
    reason: overrideReason,
  };
  delete input.manifestEvidenceFact;
  build.manifest.commitShas = ["dddddddddddddddddddddddddddddddddddddddd"];
  input.buildResource.build.manifest.commitShas = structuredClone(build.manifest.commitShas);
  const link = structuredClone(input.linkRelationFact.link);
  Object.assign(link, {
    evidenceType: "release_manager_override",
    evidenceDecision: "release_manager_authorized",
    overrideReason,
  });
  input.linkRelationFact = buildRepairLinkFact(link, { didNotExistBefore: true });
  if (representation === "vendor") {
    input.response.repairLink = structuredClone(link);
  }
  return refreshBuildWriteReceipt(input);
}

function makeBuildReplayReceipt(source) {
  const replay = structuredClone(source);
  const build = source.operationId === "linkBuildRepair" && source.representation === "vendor"
    ? source.response.build
    : source.response;
  const projectId = source.pathProjectId ?? source.buildResource?.projectId ?? build.projectId;
  replay.persistedPreconditionFact = {
    operationId: source.operationId,
    accountId: source.accountId,
    actorId: source.actorId,
    projectId,
    bugId: source.effectFact.bugId,
    resourceType: "build",
    resourceId: build.id,
    requestDigest: source.persistedRequestDigest,
    auditEventId: source.effectFact.auditEventId,
    snapshotCommitted: true,
    atomicWithReceipt: true,
  };
  for (const field of [
    "projectFact",
    "releaseAuthorityFact",
    "providerIdentityFact",
    "artifactFact",
    "buildResource",
    "bugResource",
    "repairAttemptFact",
    "buildRequirementFact",
    "legacyLinkCasFact",
    "manifestEvidenceFact",
    "overrideAuthorityFact",
    "linkRelationFact",
  ]) {
    if (Object.hasOwn(source, field)) {
      replay.persistedPreconditionFact[field] = structuredClone(source[field]);
    }
  }
  replay.replayCurrentResourceFact = {
    operationId: source.operationId,
    accountId: source.accountId,
    actorId: source.actorId,
    projectId,
    bugId: source.effectFact.bugId,
    resourceType: "build",
    resourceId: build.id,
    currentVersion: build.version,
    currentlyVisible: true,
    currentMembershipActive: true,
    authorizationRecheckedBeforeReplay: true,
  };
  if (replay.buildResource) replay.buildResource.build = structuredClone(build);
  replay.exactReplay = true;
  replay.replayAuthorized = true;
  replay.mutationCount = 0;
  if (replay.operationId === "linkBuildRepair" && replay.representation === "vendor") {
    replay.response.replayed = true;
  }
  return replay;
}

const buildWriteReceiptCases = [
  ["registerBuild vendor", makeBuildWriteReceipt("registerBuild")],
  ["linkBuildRepair vendor", makeBuildWriteReceipt("linkBuildRepair", "vendor")],
  ["linkBuildRepair vendor release-manager override", makeOverrideBuildLinkReceipt("vendor")],
  ["linkBuildRepair legacy", makeBuildWriteReceipt("linkBuildRepair", "legacy")],
];
for (const [label, source] of buildWriteReceiptCases) {
  if (evaluateAppFirstBehavior("build-write-receipt", source) !== "unambiguous") {
    failures.push(`${label}: fresh atomic Build receipt is ambiguous`);
  }
  {
    const replay = makeBuildReplayReceipt(source);
    if (evaluateAppFirstBehavior("build-write-receipt", replay) !== "unambiguous") {
      failures.push(`${label}: exact authorized Build replay was rejected`);
    }
    replay.replayCurrentResourceFact.currentVersion += 3;
    if (evaluateAppFirstBehavior("build-write-receipt", replay) !== "unambiguous") {
      failures.push(`${label}: authorized replay after a later visible version was rejected`);
    }
  }
  {
    const stalePrestateReplay = structuredClone(source);
    stalePrestateReplay.exactReplay = true;
    stalePrestateReplay.replayAuthorized = true;
    stalePrestateReplay.mutationCount = 0;
    if (stalePrestateReplay.operationId === "linkBuildRepair" && stalePrestateReplay.representation === "vendor") {
      stalePrestateReplay.response.replayed = true;
    }
    if (evaluateAppFirstBehavior("build-write-receipt", stalePrestateReplay) !== "ambiguous") {
      failures.push(`${label}: replay without a current authorization snapshot was accepted`);
    }
  }
  for (const [suffix, mutate] of [
    ["revoked membership", (input) => (input.membershipFact.currentActive = false)],
    ["missing audit event", (input) => (input.effectFact.auditEventCommitted = false)],
    ["missing notification outbox", (input) => (input.effectFact.notificationOutboxCommitted = false)],
    ["non-atomic effect", (input) => (input.effectFact.atomicWithReceipt = false)],
  ]) {
    const candidate = structuredClone(source);
    mutate(candidate);
    if (evaluateAppFirstBehavior("build-write-receipt", candidate) !== "ambiguous") {
      failures.push(`${label}: ${suffix} was accepted`);
    }
  }
}
for (const field of [
  "verificationMutationCount",
  "bugClosureMutationCount",
  "humanAcceptanceMutationCount",
]) {
  const candidate = makeBuildWriteReceipt("registerBuild");
  candidate.effectFact[field] = 1;
  if (evaluateAppFirstBehavior("build-write-receipt", candidate) !== "ambiguous") {
    failures.push(`registerBuild: ${field}=1 was accepted`);
  }
}
{
  const candidate = makeBuildWriteReceipt("registerBuild");
  candidate.pathProjectId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
  refreshBuildWriteReceipt(candidate);
  if (evaluateAppFirstBehavior("build-write-receipt", candidate) !== "ambiguous") {
    failures.push("registerBuild: internally re-signed foreign project path was accepted");
  }
}
{
  const candidate = makeBuildWriteReceipt("registerBuild");
  candidate.providerIdentityFact.globallyUniqueWithinProject = false;
  if (evaluateAppFirstBehavior("build-write-receipt", candidate) !== "ambiguous") {
    failures.push("registerBuild: duplicate provider/external identity was accepted");
  }
}
{
  const candidate = makeBuildWriteReceipt("registerBuild");
  candidate.artifactFact.verified = false;
  if (evaluateAppFirstBehavior("build-write-receipt", candidate) !== "ambiguous") {
    failures.push("registerBuild: ready Build without verified artifact evidence was accepted");
  }
}
for (const [label, mutate] of [
  ["foreign artifact account", (input) => (input.artifactFact.accountId = "foreign-account")],
  ["foreign artifact project", (input) => (input.artifactFact.projectId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
  ["foreign artifact Build", (input) => (input.artifactFact.buildId = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
  ["foreign provider job", (input) => (input.artifactFact.externalId = "foreign-job")],
  ["foreign source commit", (input) => (input.artifactFact.sourceCommitSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")],
  ["forged manifest digest", (input) => (input.artifactFact.manifestDigest = "0".repeat(64))],
]) {
  const candidate = makeBuildWriteReceipt("registerBuild");
  mutate(candidate);
  if (evaluateAppFirstBehavior("build-write-receipt", candidate) !== "ambiguous") {
    failures.push(`registerBuild: ${label} evidence was accepted`);
  }
}
{
  const candidate = makeBuildWriteReceipt("registerBuild");
  candidate.response.version = 2;
  candidate.effectFact.resourceVersionAfter = 2;
  refreshBuildWriteReceipt(candidate);
  if (evaluateAppFirstBehavior("build-write-receipt", candidate) !== "ambiguous") {
    failures.push("registerBuild: non-initial committed version was accepted");
  }
}
for (const representation of ["vendor", "legacy"]) {
  const candidate = makeBuildWriteReceipt("linkBuildRepair", representation);
  candidate.buildResource.build.status = "building";
  if (evaluateAppFirstBehavior("build-write-receipt", candidate) !== "ambiguous") {
    failures.push(`linkBuildRepair ${representation}: non-ready Build was accepted`);
  }
  const foreignPath = makeBuildWriteReceipt("linkBuildRepair", representation);
  foreignPath.pathBuildId = "ffffffff-ffff-4fff-8fff-fffffffffff4";
  refreshBuildWriteReceipt(foreignPath);
  if (evaluateAppFirstBehavior("build-write-receipt", foreignPath) !== "ambiguous") {
    failures.push(`linkBuildRepair ${representation}: internally re-signed foreign Build path was accepted`);
  }
  const automation = makeBuildWriteReceipt("linkBuildRepair", representation);
  automation.effectFact.humanAcceptanceMutationCount = 1;
  if (evaluateAppFirstBehavior("build-write-receipt", automation) !== "ambiguous") {
    failures.push(`linkBuildRepair ${representation}: automatic human acceptance was accepted`);
  }
  for (const [label, mutate] of [
    ["foreign manifest account", (input) => (input.manifestEvidenceFact.accountId = "foreign-account")],
    ["foreign manifest project", (input) => (input.manifestEvidenceFact.projectId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
    ["foreign manifest Build", (input) => (input.manifestEvidenceFact.buildId = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
    ["foreign manifest Attempt", (input) => (input.manifestEvidenceFact.repairAttemptId = "ffffffff-ffff-4fff-8fff-fffffffffff3")],
    ["foreign manifest commit", (input) => (input.manifestEvidenceFact.deliveredCommitSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")],
    ["forged manifest digest", (input) => (input.manifestEvidenceFact.manifestDigest = "0".repeat(64))],
  ]) {
    const scopedEvidence = makeBuildWriteReceipt("linkBuildRepair", representation);
    mutate(scopedEvidence);
    if (evaluateAppFirstBehavior("build-write-receipt", scopedEvidence) !== "ambiguous") {
      failures.push(`linkBuildRepair ${representation}: ${label} evidence was accepted`);
    }
  }
  const wrongVersion = makeBuildWriteReceipt("linkBuildRepair", representation);
  const wrongVersionBuild =
    representation === "vendor" ? wrongVersion.response.build : wrongVersion.response;
  wrongVersionBuild.version += 1;
  wrongVersion.effectFact.resourceVersionAfter = wrongVersionBuild.version;
  refreshBuildWriteReceipt(wrongVersion);
  if (evaluateAppFirstBehavior("build-write-receipt", wrongVersion) !== "ambiguous") {
    failures.push(`linkBuildRepair ${representation}: wrong Build version advance was accepted`);
  }
  const wrongCommit = makeBuildWriteReceipt("linkBuildRepair", representation);
  wrongCommit.request.deliveredCommitSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  wrongCommit.repairAttemptFact.attempt.commitSha = wrongCommit.request.deliveredCommitSha;
  wrongCommit.linkRelationFact.link.deliveredCommitSha = wrongCommit.request.deliveredCommitSha;
  if (representation === "vendor") {
    wrongCommit.response.repairLink.deliveredCommitSha = wrongCommit.request.deliveredCommitSha;
  }
  refreshBuildWriteReceipt(wrongCommit);
  if (evaluateAppFirstBehavior("build-write-receipt", wrongCommit) !== "ambiguous") {
    failures.push(`linkBuildRepair ${representation}: commit absent from the verified manifest was accepted`);
  }

  const staleBug = makeBuildWriteReceipt("linkBuildRepair", representation);
  staleBug.bugResource.bug.version += 1;
  staleBug.committedBugFact.bug.version += 1;
  staleBug.effectFact.bugVersionBefore += 1;
  staleBug.effectFact.bugVersionAfter += 1;
  if (representation === "vendor") {
    staleBug.request.expectedBugVersion += 1;
    staleBug.response.bug.version += 1;
  } else {
    staleBug.legacyLinkCasFact.expectedBugVersion += 1;
  }
  refreshBuildWriteReceipt(staleBug);
  if (evaluateAppFirstBehavior("build-write-receipt", staleBug) !== "ambiguous") {
    failures.push(
      `linkBuildRepair ${representation}: a Bug version newer than the delivery requirement was accepted`,
    );
  }

  const wrongRequirementVersion = makeBuildWriteReceipt("linkBuildRepair", representation);
  wrongRequirementVersion.buildRequirementFact.buildRequirement.version = 2;
  wrongRequirementVersion.committedBuildRequirementFact.buildRequirement.version = 3;
  wrongRequirementVersion.linkRelationFact.link.buildRequirementVersion = 3;
  wrongRequirementVersion.effectFact.buildRequirementVersionBefore = 2;
  wrongRequirementVersion.effectFact.buildRequirementVersionAfter = 3;
  if (representation === "vendor") {
    wrongRequirementVersion.request.expectedBuildRequirementVersion = 2;
    wrongRequirementVersion.response.buildRequirement.version = 3;
    wrongRequirementVersion.response.repairLink.buildRequirementVersion = 3;
  } else {
    wrongRequirementVersion.legacyLinkCasFact.expectedBuildRequirementVersion = 2;
  }
  refreshBuildWriteReceipt(wrongRequirementVersion);
  if (
    evaluateAppFirstBehavior("build-write-receipt", wrongRequirementVersion) !== "ambiguous"
  ) {
    failures.push(`linkBuildRepair ${representation}: a non-v1 delivery requirement was accepted`);
  }

  for (const [suffix, mutate] of [
    ["duplicate relation", (input) => (input.linkRelationFact.didNotExistBefore = false)],
    ["null relation id", (input) => (input.linkRelationFact.link.id = null)],
    ["invalid relation timestamp", (input) => (input.linkRelationFact.link.linkedAt = "not-a-date")],
    ["missing requirement", (input) => delete input.buildRequirementFact],
    ["forged audit payload", (input) => (input.auditEventFact.payload = { accepted: true })],
    ["missing durable evidence audit", (input) => delete input.linkRelationFact.evidenceAuditFact],
    ["forged durable evidence authority", (input) => {
      input.linkRelationFact.evidenceAuditFact.manifestVerifiedAtLink = false;
    }],
    ["mismatched notification event", (input) => (input.notificationOutboxFact.eventId = "other")],
  ]) {
    const adversarial = makeBuildWriteReceipt("linkBuildRepair", representation);
    mutate(adversarial);
    if (evaluateAppFirstBehavior("build-write-receipt", adversarial) !== "ambiguous") {
      failures.push(`linkBuildRepair ${representation}: ${suffix} was accepted`);
    }
  }
}

function refreshVerificationTypedFacts(input, representation) {
  const verification = input.response.verification;
  const currentVerification = input.verificationResource.verification;
  const currentAttempt = input.repairAttemptResource.attempt;
  const committedAttempt =
    representation === "vendor"
      ? input.response.repairAttempt
      : input.committedRepairAttemptFact.attempt;
  const changedVersions = {
    bug: [input.bugResource.version, input.response.bug.version],
    verification: [currentVerification.version, verification.version],
    repairAttempt: [currentAttempt.version, committedAttempt.version],
  };
  if (representation === "vendor") {
    input.committedBugFact = {
      accountId: input.accountId,
      projectId: input.authorizedProjectId,
      bugId: input.targetQaItemId,
      bug: structuredClone(input.response.bug),
      committed: true,
      atomicWithResult: true,
    };
  }
  input.multiAggregateEffectFact.changedVersions = structuredClone(changedVersions);
  input.multiAggregateEffectFact.notificationMessageIds = structuredClone(
    input.notificationOutboxFact.messageIds,
  );
  Object.assign(input.eventFact, {
    source: "qa_hub",
    actorType: "user",
    resourceType: "verification",
    resourceId: verification.id,
    resourceVersionAfter: verification.version,
    fromStatus: "in_progress",
    toStatus: input.request.status,
    resultSummary: input.request.resultSummary,
    requestDigest: input.persistedRequestDigest,
    changedVersions: structuredClone(changedVersions),
    payload: {
      status: input.request.status,
      resultSummary: input.request.resultSummary,
      failureReason: input.request.failureReason ?? null,
      blockedReason: input.request.blockedReason ?? null,
      verificationId: verification.id,
      repairAttemptId: verification.repairAttemptId,
      buildId: verification.buildId ?? null,
    },
    typedRelationsValidated: true,
    committed: true,
  });
  return input;
}

function refreshVerificationResultReceipt(input, representation) {
  input.representation = representation;
  input.idempotencyKey =
    `workflow:recordVerificationResult:verification:${input.targetVerificationId}` +
    `:v${input.request.expectedVersion}`;
  input.persistedIdempotencyKey = input.idempotencyKey;
  input.canonicalRequestDigest = canonicalNonSecretRequestDigest(
    "recordVerificationResult",
    {
      accountId: input.accountId,
      actorId: input.authenticatedActorId,
      projectId: input.authorizedProjectId,
      targetQaItemId: input.targetQaItemId,
      targetVerificationId: input.targetVerificationId,
    },
    input.request,
    input.idempotencyKey,
  );
  input.persistedRequestDigest = input.canonicalRequestDigest;
  const persistedBody = structuredClone(input.response);
  delete persistedBody.replayed;
  input.persistedHttpReceipt = { status: 200, headers: {}, body: persistedBody };
  input.verificationFact.response = structuredClone(input.response.verification);
  return refreshVerificationTypedFacts(input, representation);
}

function makeVerificationReplayReceipt(source, representation) {
  const replay = structuredClone(source);
  replay.representation = representation;
  const responseAttempt =
    representation === "vendor"
      ? source.response.repairAttempt
      : source.committedRepairAttemptFact.attempt;
  replay.persistedPreconditionFact = {
    operationId: "recordVerificationResult",
    accountId: source.accountId,
    actorId: source.authenticatedActorId,
    projectId: source.authorizedProjectId,
    bugId: source.targetQaItemId,
    resourceType: "verification",
    resourceId: source.targetVerificationId,
    requestDigest: source.persistedRequestDigest,
    auditEventId: source.multiAggregateEffectFact.auditEventId,
    snapshotCommitted: true,
    atomicWithReceipt: true,
  };
  for (const field of [
    "verificationResource",
    "repairAttemptResource",
    "bugResource",
    "buildResource",
    "buildRequirementFact",
    "linkRelationFact",
    "separationOfDutiesFact",
    "verificationFact",
    "committedRepairAttemptFact",
  ]) {
    if (Object.hasOwn(source, field)) {
      replay.persistedPreconditionFact[field] = structuredClone(source[field]);
    }
  }
  replay.replayCurrentResourceFact = {
    operationId: "recordVerificationResult",
    accountId: source.accountId,
    actorId: source.authenticatedActorId,
    projectId: source.authorizedProjectId,
    bugId: source.targetQaItemId,
    resourceType: "verification",
    resourceId: source.targetVerificationId,
    currentVersion: source.response.verification.version,
    currentlyVisible: true,
    currentMembershipActive: true,
    authorizationRecheckedBeforeReplay: true,
  };
  replay.verificationResource.verification = structuredClone(source.response.verification);
  replay.repairAttemptResource.attempt = structuredClone(responseAttempt);
  replay.bugResource.state = source.response.bug.state;
  replay.bugResource.version = source.response.bug.version;
  replay.bugResource.activeVerificationId = null;
  replay.bugResource.bug = {
    ...structuredClone(replay.bugResource.bug),
    ...structuredClone(source.response.bug),
  };
  replay.exactReplay = true;
  replay.replayAuthorized = true;
  replay.mutationCount = 0;
  if (representation === "vendor") replay.response.replayed = true;
  return replay;
}

for (const status of ["passed", "failed", "blocked"]) {
  const input = structuredClone(submissionReceiptCases[3][1]);
  input.request.status = status;
  input.request.resultSummary = `Human verification result: ${status}.`;
  delete input.request.failureReason;
  delete input.request.blockedReason;
  delete input.eventFact.failureReason;
  delete input.eventFact.blockedReason;
  if (status === "failed") {
    input.request.failureReason = "The defect remains reproducible.";
    input.eventFact.failureReason = input.request.failureReason;
  } else if (status === "blocked") {
    input.request.blockedReason = "The required test account is unavailable.";
    input.eventFact.blockedReason = input.request.blockedReason;
  }
  input.response.verification.status = status;
  input.response.verification.resultSummary = input.request.resultSummary;
  input.eventFact.status = status;
  input.response.bug.state = {
    passed: "closed",
    failed: "ready",
    blocked: "ready_for_verification",
  }[status];
  input.response.bug.closedAt = status === "passed" ? "2026-08-24T11:01:00Z" : null;
  input.response.bug.reopenCount =
    input.bugResource.bug.reopenCount;
  input.response.repairAttempt.status = status === "failed" ? "verification_failed" : "delivered";
  input.response.repairAttempt.version =
    status === "failed"
      ? input.repairAttemptResource.attempt.version + 1
      : input.repairAttemptResource.attempt.version;
  input.multiAggregateEffectFact.changedVersions = {
    bug: [input.bugResource.version, input.response.bug.version],
    verification: [input.verificationResource.verification.version, input.response.verification.version],
    repairAttempt: [
      input.repairAttemptResource.attempt.version,
      input.response.repairAttempt.version,
    ],
  };
  input.multiAggregateEffectFact.activeAttemptIdAfter =
    status === "blocked" ? input.repairAttemptResource.attempt.id : null;
  input.persistedResponse = structuredClone(input.response);
  refreshVerificationResultReceipt(input, "vendor");
  if (evaluateAppFirstBehavior("submission-receipt", input) !== "unambiguous") {
    failures.push(`recordVerificationResult ${status}: vendor state map was rejected`);
  }
  if (
    evaluateAppFirstBehavior("verification-result-write-receipt", input) !== "unambiguous"
  ) {
    failures.push(`recordVerificationResult ${status}: direct vendor invariant was rejected`);
  }
}
{
  const policyAllowedSelfVerification = structuredClone(submissionReceiptCases[3][1]);
  const verifierId = policyAllowedSelfVerification.authenticatedActorId;
  policyAllowedSelfVerification.repairAttemptResource.attempt.assigneeId = verifierId;
  policyAllowedSelfVerification.response.repairAttempt.assigneeId = verifierId;
  policyAllowedSelfVerification.separationOfDutiesFact = {
    repairAssigneeId: verifierId,
    verifierId,
    passed: true,
  };
  refreshVerificationResultReceipt(policyAllowedSelfVerification, "vendor");
  if (
    evaluateAppFirstBehavior(
      "verification-result-write-receipt",
      policyAllowedSelfVerification,
    ) !== "unambiguous"
  ) {
    failures.push("recordVerificationResult rejected a policy-approved same-assignee verifier fact");
  }
  const policyRejectedSelfVerification = structuredClone(policyAllowedSelfVerification);
  policyRejectedSelfVerification.separationOfDutiesFact.passed = false;
  if (
    evaluateAppFirstBehavior(
      "verification-result-write-receipt",
      policyRejectedSelfVerification,
    ) !== "ambiguous"
  ) {
    failures.push("recordVerificationResult accepted a policy-rejected same-assignee verifier fact");
  }
}
{
  const candidate = structuredClone(submissionReceiptCases[3][1]);
  candidate.response.bug.title = "Forged title hidden behind a vendor verification result";
  candidate.persistedResponse = structuredClone(candidate.response);
  refreshVerificationResultReceipt(candidate, "vendor");
  if (evaluateAppFirstBehavior("submission-receipt", candidate) !== "ambiguous") {
    failures.push("recordVerificationResult vendor accepted an unrelated immutable Bug mutation");
  }
}

{
  const vendor = structuredClone(submissionReceiptCases[3][1]);
  const legacy = structuredClone(vendor);
  legacy.request = {
    expectedVersion: vendor.request.expectedVersion,
    status: vendor.request.status,
    resultSummary: vendor.request.resultSummary,
    failureReason: vendor.request.failureReason,
  };
  legacy.response = {
    verification: structuredClone(vendor.response.verification),
    bug: structuredClone(vendor.response.bug),
  };
  delete legacy.response.bug.moduleId;
  delete legacy.response.bug.duplicateOfBugId;
  legacy.committedRepairAttemptFact = {
    accountId: legacy.accountId,
    projectId: legacy.authorizedProjectId,
    bugId: legacy.targetQaItemId,
    attempt: structuredClone(vendor.response.repairAttempt),
  };
  const legacyDefinition = baseManifest.operations.find(
    (entry) => entry.operationId === "recordVerificationResult",
  );
  validateStableExample(
    legacyDefinition.requestRef,
    legacy.request,
    "recordVerificationResult legacy write request",
  );
  validateStableExample(
    legacyDefinition.responseRef,
    legacy.response,
    "recordVerificationResult legacy write response",
  );
  refreshVerificationResultReceipt(legacy, "legacy");
  if (
    evaluateAppFirstBehavior("verification-result-write-receipt", legacy) !== "unambiguous"
  ) {
    failures.push("recordVerificationResult legacy JSON did not enforce the vendor state invariant");
  }
  const replay = makeVerificationReplayReceipt(legacy, "legacy");
  if (
    evaluateAppFirstBehavior("verification-result-write-receipt", replay) !== "unambiguous"
  ) {
    failures.push("recordVerificationResult legacy exact replay was rejected");
  }
  const stalePrestateReplay = structuredClone(legacy);
  stalePrestateReplay.exactReplay = true;
  stalePrestateReplay.replayAuthorized = true;
  stalePrestateReplay.mutationCount = 0;
  if (
    evaluateAppFirstBehavior("verification-result-write-receipt", stalePrestateReplay) !==
    "ambiguous"
  ) {
    failures.push(
      "recordVerificationResult legacy replay without current authorization was accepted",
    );
  }
  for (const [label, mutate] of [
    ["non-running verification", (input) => (input.verificationResource.verification.status = "requested")],
    ["repair assignee mismatches SOD fact", (input) => (input.repairAttemptResource.attempt.assigneeId = input.authenticatedActorId)],
    ["ineligible Build commit", (input) => (input.buildResource.build.manifest.commitShas = ["eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"])],
    ["missing atomic audit", (input) => (input.multiAggregateEffectFact.auditEventCommitted = false)],
    ["machine acceptance mutation", (input) => (input.multiAggregateEffectFact.machineAcceptanceMutationCount = 1)],
    ["forged immutable Bug field", (input) => {
      input.response.bug.title = "Forged title hidden behind a verification result";
      refreshVerificationResultReceipt(input, "legacy");
    }],
    ["mismatched typed audit result", (input) => (input.eventFact.status = "passed")],
  ]) {
    const candidate = structuredClone(legacy);
    mutate(candidate);
    if (
      evaluateAppFirstBehavior("verification-result-write-receipt", candidate) !== "ambiguous"
    ) {
      failures.push(`recordVerificationResult legacy: ${label} was accepted`);
    }
  }
}

{
  const createAttempt = makeWorkflowWriteReceipt("createRepairAttempt");
  const startAttempt = makeWorkflowWriteReceipt("startRepairAttempt");
  const deliver = makeWorkflowWriteReceipt("deliverRepairAttempt");
  const register = makeBuildWriteReceipt("registerBuild");
  const link = makeBuildWriteReceipt("linkBuildRepair", "vendor");
  const createVerification = makeWorkflowWriteReceipt("createVerification");
  const startVerification = makeWorkflowWriteReceipt("startVerification");
  const result = structuredClone(submissionReceiptCases[3][1]);
  const chainAuditIds = [
    createAttempt.auditEventFact.id,
    startAttempt.auditEventFact.id,
    deliver.auditEventFact.id,
    register.auditEventFact.id,
    link.auditEventFact.id,
    createVerification.auditEventFact.id,
    startVerification.auditEventFact.id,
    result.eventFact.id,
  ];
  const traceValid =
    new Set(chainAuditIds).size === chainAuditIds.length &&
    deliver.auditEventFact.id ===
      deliver.committedBuildRequirementFact.buildRequirement.decisionAuditEventId &&
    deliver.auditEventFact.type === "repair_attempt.delivered" &&
    deliver.auditEventFact.resourceId === deliver.response.id &&
    link.auditEventFact.id === link.response.eventId &&
    link.auditEventFact.type === "build.repair_linked" &&
    link.auditEventFact.resourceId === link.response.build.id &&
    link.linkRelationFact.evidenceAuditFact.id === link.auditEventFact.id &&
    result.eventFact.id === result.response.eventId &&
    result.eventFact.type === "verification.result_recorded" &&
    result.eventFact.resourceId === result.response.verification.id &&
    createAttempt.bugResource.version === 2 &&
    createAttempt.committedBugFact.bug.version === 3 &&
    startAttempt.attemptResource.attempt.version === createAttempt.response.version &&
    startAttempt.response.version === deliver.attemptResource.attempt.version &&
    startAttempt.bugResource.version === 3 &&
    deliver.bugResource.version === 3 &&
    deliver.committedBugFact.bug.version === 4 &&
    deliver.committedBuildRequirementFact.buildRequirement.version === 1 &&
    link.bugResource.bug.version === deliver.committedBugFact.bug.version &&
    link.buildRequirementFact.buildRequirement.id ===
      deliver.committedBuildRequirementFact.buildRequirement.id &&
    link.buildRequirementFact.buildRequirement.version === 1 &&
    register.response.version === link.buildResource.build.version &&
    link.response.build.version === 2 &&
    link.committedBugFact.bug.version === 5 &&
    link.committedBuildRequirementFact.buildRequirement.version === 2 &&
    createVerification.bugResource.version === link.committedBugFact.bug.version &&
    createVerification.buildRequirementFact.buildRequirement.id ===
      link.committedBuildRequirementFact.buildRequirement.id &&
    createVerification.buildRequirementFact.buildRequirement.version === 2 &&
    createVerification.response.version === startVerification.verificationResource.verification.version &&
    createVerification.committedBugFact.bug.version === 6 &&
    startVerification.bugResource.version === 6 &&
    startVerification.response.version === result.verificationResource.verification.version &&
    result.bugResource.version === 6 &&
    result.response.bug.version === 7 &&
    result.repairAttemptResource.attempt.id === deliver.response.id &&
    result.repairAttemptResource.attempt.version === deliver.response.version &&
    result.buildRequirementFact.buildRequirement.id ===
      link.committedBuildRequirementFact.buildRequirement.id &&
    result.linkRelationFact.link.id === link.linkRelationFact.link.id;
  if (!traceValid) {
    failures.push(
      "workflow trace drifted: create/start/deliver/register/link/create/start/result is not one reachable version chain",
    );
  }
}

{
  const link = makeOverrideBuildLinkReceipt("vendor");
  const createVerification = makeWorkflowWriteReceipt("createVerification");
  createVerification.buildFact.build = structuredClone(link.response.build);
  createVerification.buildFact.exactDeliveredCommitEligible = false;
  createVerification.buildRequirementFact = structuredClone(
    link.committedBuildRequirementFact,
  );
  createVerification.buildRequirementFact.current = true;
  createVerification.linkRelationFact = structuredClone(link.linkRelationFact);
  refreshWorkflowWriteReceipt(createVerification);

  const startVerification = makeWorkflowWriteReceipt("startVerification");
  const result = structuredClone(submissionReceiptCases[3][1]);
  result.buildResource.build = structuredClone(link.response.build);
  result.buildResource.exactDeliveredCommitEligible = false;
  result.buildRequirementFact = structuredClone(link.committedBuildRequirementFact);
  result.buildRequirementFact.current = true;
  result.linkRelationFact = structuredClone(link.linkRelationFact);
  refreshVerificationResultReceipt(result, "vendor");

  for (const [label, mode, input] of [
    ["link", "build-write-receipt", link],
    ["create", "workflow-write-receipt", createVerification],
    ["start", "workflow-write-receipt", startVerification],
    ["result", "verification-result-write-receipt", result],
  ]) {
    if (evaluateAppFirstBehavior(mode, input) !== "unambiguous") {
      failures.push(`release-manager override full chain: ${label} was unreachable`);
    }
  }
  if (
    createVerification.linkRelationFact.link.id !== link.linkRelationFact.link.id ||
    result.linkRelationFact.link.id !== link.linkRelationFact.link.id
  ) {
    failures.push("release-manager override full chain drifted from the committed relation");
  }

  const forgedAuthority = makeOverrideBuildLinkReceipt("vendor");
  forgedAuthority.overrideAuthorityFact.canOverrideBuildEvidence = false;
  if (evaluateAppFirstBehavior("build-write-receipt", forgedAuthority) !== "ambiguous") {
    failures.push("release-manager override link accepted forged current authority");
  }
  const forgedAudit = structuredClone(createVerification);
  forgedAudit.linkRelationFact.evidenceAuditFact.releaseManagerAuthorizedAtLink = false;
  if (evaluateAppFirstBehavior("workflow-write-receipt", forgedAudit) !== "ambiguous") {
    failures.push("createVerification accepted a forged durable override audit");
  }
  const forgedResultAudit = structuredClone(result);
  forgedResultAudit.linkRelationFact.evidenceAuditFact.id =
    "ffffffff-ffff-4fff-8fff-fffffffffff7";
  if (
    evaluateAppFirstBehavior("verification-result-write-receipt", forgedResultAudit) !==
    "ambiguous"
  ) {
    failures.push("recordVerificationResult accepted a forged durable override audit id");
  }
}

{
  const delivery = makeNotRequiredDeliveryReceipt({
    deliveryKind: "code",
    withExemption: true,
  });
  const createVerification = makeWorkflowWriteReceipt("createVerification");
  const deliveredBugVersion = delivery.committedBugFact.bug.version;
  createVerification.request.expectedVersion = deliveredBugVersion;
  createVerification.request.buildId = null;
  createVerification.response.buildId = null;
  createVerification.bugResource.version = deliveredBugVersion;
  createVerification.bugResource.bug.version = deliveredBugVersion;
  createVerification.effectFact.bugVersionBefore = deliveredBugVersion;
  createVerification.effectFact.bugVersionAfter = deliveredBugVersion + 1;
  createVerification.committedBugFact.bug.version = deliveredBugVersion + 1;
  createVerification.repairAttemptFact.attempt = structuredClone(delivery.response);
  delete createVerification.buildFact;
  createVerification.linkRelationFact = null;
  createVerification.buildRequirementFact = structuredClone(
    delivery.committedBuildRequirementFact,
  );
  createVerification.buildRequirementFact.current = true;
  refreshWorkflowWriteReceipt(createVerification);

  const startVerification = makeWorkflowWriteReceipt("startVerification");
  startVerification.bugResource.version = deliveredBugVersion + 1;
  startVerification.bugResource.bug.version = deliveredBugVersion + 1;
  startVerification.effectFact.bugVersionBefore = deliveredBugVersion + 1;
  startVerification.effectFact.bugVersionAfter = deliveredBugVersion + 1;
  startVerification.committedBugFact.bug.version = deliveredBugVersion + 1;
  refreshWorkflowWriteReceipt(startVerification);

  const result = structuredClone(submissionReceiptCases[3][1]);
  result.verificationResource.verification.buildId = null;
  result.response.verification.buildId = null;
  result.repairAttemptResource.attempt = structuredClone(delivery.response);
  result.response.repairAttempt = {
    ...structuredClone(delivery.response),
    status: "verification_failed",
    version: delivery.response.version + 1,
  };
  result.buildResource = null;
  result.linkRelationFact = null;
  result.buildRequirementFact = structuredClone(delivery.committedBuildRequirementFact);
  result.buildRequirementFact.current = true;
  result.bugResource.version = deliveredBugVersion + 1;
  result.bugResource.bug.version = deliveredBugVersion + 1;
  result.response.bug.version = deliveredBugVersion + 2;
  result.eventFact.buildId = null;
  result.multiAggregateEffectFact.changedVersions = {
    bug: [deliveredBugVersion + 1, deliveredBugVersion + 2],
    verification: [
      result.verificationResource.verification.version,
      result.response.verification.version,
    ],
    repairAttempt: [delivery.response.version, result.response.repairAttempt.version],
  };
  result.persistedResponse = structuredClone(result.response);
  refreshVerificationResultReceipt(result, "vendor");

  for (const [label, mode, input] of [
    ["delivery", "workflow-write-receipt", delivery],
    ["create", "workflow-write-receipt", createVerification],
    ["start", "workflow-write-receipt", startVerification],
    ["result", "verification-result-write-receipt", result],
  ]) {
    if (evaluateAppFirstBehavior(mode, input) !== "unambiguous") {
      failures.push(`authorized code no-Build exemption full chain: ${label} was unreachable`);
    }
  }
  if (
    createVerification.buildRequirementFact.buildRequirement.id !==
      delivery.committedBuildRequirementFact.buildRequirement.id ||
    result.buildRequirementFact.buildRequirement.id !==
      delivery.committedBuildRequirementFact.buildRequirement.id
  ) {
    failures.push("authorized code no-Build exemption chain drifted from its decision record");
  }
  const forgedDecision = structuredClone(createVerification);
  forgedDecision.buildRequirementFact.buildRequirement.decisionActorId =
    "ffffffff-ffff-4fff-8fff-fffffffffff8";
  if (evaluateAppFirstBehavior("workflow-write-receipt", forgedDecision) !== "ambiguous") {
    failures.push("createVerification accepted a forged no-Build exemption decision actor");
  }
}

{
  const candidate = makeWorkflowWriteReceipt("createVerification");
  const unlinkedBuildId = "ffffffff-ffff-4fff-8fff-fffffffffff5";
  candidate.request.buildId = unlinkedBuildId;
  candidate.response.buildId = unlinkedBuildId;
  candidate.buildFact.build.id = unlinkedBuildId;
  candidate.buildRequirementFact.buildRequirement.linkedBuildId = unlinkedBuildId;
  candidate.buildRequirementFact.buildRequirement.linkId = null;
  candidate.linkRelationFact = null;
  refreshWorkflowWriteReceipt(candidate);
  if (evaluateAppFirstBehavior("workflow-write-receipt", candidate) !== "ambiguous") {
    failures.push("createVerification accepted a same-commit Build with no committed repair link");
  }
}

{
  const candidate = structuredClone(submissionReceiptCases[3][1]);
  const unlinkedBuildId = "ffffffff-ffff-4fff-8fff-fffffffffff5";
  candidate.verificationResource.verification.buildId = unlinkedBuildId;
  candidate.response.verification.buildId = unlinkedBuildId;
  candidate.buildResource.build.id = unlinkedBuildId;
  candidate.buildRequirementFact.buildRequirement.linkedBuildId = unlinkedBuildId;
  candidate.buildRequirementFact.buildRequirement.linkId = null;
  candidate.linkRelationFact = null;
  refreshVerificationResultReceipt(candidate, "vendor");
  if (evaluateAppFirstBehavior("submission-receipt", candidate) !== "ambiguous") {
    failures.push("recordVerificationResult accepted a same-commit Build with no committed repair link");
  }
}

{
  const allowedEnvironment = structuredClone(createRequest.occurrence.environment);
  if (
    evaluateAppFirstBehavior("occurrence-environment", {
      environment: allowedEnvironment,
    }) !== "valid"
  ) {
    failures.push("Allowed native occurrence environment was rejected by executable policy");
  }
  const schemaValidButOversized = {
    qaAppVersion: "1".repeat(100),
    testSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    buildId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    networkType: "cellular",
    networkMetered: false,
    orientation: "landscape",
  };
  const validateEnvironment = ajv.getSchema(
    "https://qa-hub.local/contracts/1.1.0/app-first.schema.json#/$defs/nativeOccurrenceEnvironment",
  );
  if (!validateEnvironment?.(schemaValidButOversized)) {
    failures.push("Occurrence UTF-8 adversary must remain schema-valid to exercise the byte cap");
  }
  if (
    evaluateAppFirstBehavior("occurrence-environment", {
      environment: schemaValidButOversized,
    }) !== "invalid"
  ) {
    failures.push("Schema-valid occurrence environment above the actual UTF-8 cap was accepted");
  }
  for (const environment of [
    { password: "secret" },
    { accessToken: "token" },
    { playerCoordinates: "10,20" },
    { networkType: { raw: "wifi" } },
    { qaAppVersion: "password=secret" },
    { qaAppVersion: "Authorization: Bearer abc" },
    { qaAppVersion: "refreshToken=abc" },
  ]) {
    if (evaluateAppFirstBehavior("occurrence-environment", { environment }) !== "invalid") {
      failures.push(`Forbidden occurrence environment was accepted: ${JSON.stringify(environment)}`);
    }
  }
}

for (const [label, input] of [
  [
    "createBug",
    { operation: "create", response: createResponse },
  ],
  [
    "addOccurrence",
    {
      operation: "append",
      targetQaItemId: operationExamples.addOccurrence.pathParameters?.bugId,
      targetQaItemKey: createResponse.qaItem.key,
      response: appendResponse,
    },
  ],
  [
    "addBugComment",
    {
      operation: "comment",
      targetQaItemId: operationExamples.addBugComment.pathParameters?.bugId,
      targetQaItemKey: createResponse.qaItem.key,
      response: operationExamples.addBugComment.response,
    },
  ],
  [
    "recordVerificationResult",
    {
      operation: "verification",
      targetQaItemId: createResponse.qaItem.id,
      targetQaItemKey: createResponse.qaItem.key,
      targetVerificationId:
        operationExamples.recordVerificationResult.pathParameters?.verificationId,
      response: operationExamples.recordVerificationResult.response,
    },
  ],
]) {
  if (evaluateAppFirstBehavior("qa-item-identity", input) !== "unambiguous") {
    failures.push(`${label} example has an ambiguous or foreign QA item identity.`);
  }
}
const initRequest = operationExamples.initUpload.request;
const initResponse = operationExamples.initUpload.response;
const finalizeRequest = operationExamples.finalizeUpload.request;
const finalizeResponse = operationExamples.finalizeUpload.response;
const receiptAccountId = operationExamples.createNativeSession.response.session.accountId;
const uploadScope = {
  accountId: receiptAccountId,
  actorId: receiptActorId,
  authorizedProjectIds: [authorizedProjectId],
};
const uploadReceiptCases = [
  [
    "initUpload",
    {
      ...uploadScope,
      mode: "init",
      serverNow: "2026-08-24T11:00:00Z",
      exactReplay: false,
      request: initRequest,
      response: initResponse,
      resource: {
        ...uploadScope,
        projectId: initRequest.projectId,
        sessionId: initResponse.sessionId,
        clientSubmissionId: initRequest.clientSubmissionId,
        clientAttachmentId: initRequest.clientAttachmentId,
        uploadAttempt: initRequest.uploadAttempt,
        filename: initRequest.filename,
        mediaType: initRequest.mediaType,
        captureId: initRequest.captureId ?? null,
        expectedSize: initRequest.expectedSize,
        chunkSize: initResponse.chunkSize,
        sha256: initRequest.sha256,
        expiresAt: initResponse.expiresAt,
        version: 1,
      },
    },
  ],
  [
    "finalizeUpload",
    {
      ...uploadScope,
      mode: "finalize",
      exactReplay: false,
      pathSessionId: operationExamples.finalizeUpload.pathParameters.sessionId,
      request: finalizeRequest,
      response: finalizeResponse,
      resource: {
        ...uploadScope,
        projectId: finalizeResponse.projectId,
        sessionId: initResponse.sessionId,
        attachmentId: finalizeResponse.attachmentId,
        clientSubmissionId: initRequest.clientSubmissionId,
        clientAttachmentId: initRequest.clientAttachmentId,
        uploadAttempt: initRequest.uploadAttempt,
        filename: initRequest.filename,
        mediaType: initRequest.mediaType,
        captureId: initRequest.captureId ?? null,
        expectedSize: initRequest.expectedSize,
        sha256: initRequest.sha256,
        versionBefore: finalizeRequest.expectedVersion,
        persistedSha256: initRequest.sha256,
        persistedSize: initRequest.expectedSize,
        durablyReadable: true,
      },
    },
  ],
  [
    "getUploadSession",
    {
      ...uploadScope,
      mode: "session",
      pathSessionId: operationExamples.getUploadSession.pathParameters.sessionId,
      response: operationExamples.getUploadSession.response,
      resource: {
        ...uploadScope,
        ...structuredClone(operationExamples.getUploadSession.response),
      },
    },
  ],
  [
    "getAttachmentMetadata",
    {
      ...uploadScope,
      mode: "metadata",
      pathAttachmentId: operationExamples.getAttachmentMetadata.pathParameters.attachmentId,
      response: operationExamples.getAttachmentMetadata.response,
      resource: {
        ...uploadScope,
        ...structuredClone(operationExamples.getAttachmentMetadata.response),
      },
    },
  ],
  [
    "bindAttachmentReservation",
    {
      ...uploadScope,
      mode: "bind",
      serverNow: "2026-08-24T10:00:00Z",
      exactReplay: false,
      pathAttachmentId: operationExamples.bindAttachmentReservation.pathParameters.attachmentId,
      request: operationExamples.bindAttachmentReservation.request,
      response: operationExamples.bindAttachmentReservation.response,
      resource: {
        ...uploadScope,
        projectId: operationExamples.bindAttachmentReservation.request.projectId,
        attachmentId: operationExamples.bindAttachmentReservation.pathParameters.attachmentId,
        clientSubmissionId:
          operationExamples.bindAttachmentReservation.request.clientSubmissionId,
        clientAttachmentId:
          operationExamples.bindAttachmentReservation.request.clientAttachmentId,
        leaseGeneration: operationExamples.bindAttachmentReservation.request.leaseGeneration,
        intent: operationExamples.bindAttachmentReservation.request.intent,
        targetQaItemId:
          operationExamples.bindAttachmentReservation.request.targetQaItemId ?? null,
        bindingId: operationExamples.bindAttachmentReservation.response.bindingId,
        expiresAt: operationExamples.bindAttachmentReservation.response.expiresAt,
        versionBefore: operationExamples.bindAttachmentReservation.request.expectedVersion,
        priorBindingStatus: "unbound",
        priorLeaseGeneration: 0,
        priorBindingId: null,
        priorExpiresAt: null,
        scanStatus: "clean",
        readyToBind: true,
        durablyReadable: true,
      },
    },
  ],
  [
    "putUploadChunk",
    (() => {
      const contentBytes = Buffer.from("chunk-payload-01", "utf8");
      const contentBytesBase64 = contentBytes.toString("base64");
      const chunkSha256 = createHash("sha256").update(contentBytes).digest("hex");
      return {
        ...uploadScope,
        mode: "chunk",
        exactReplay: false,
        pathSessionId: initResponse.sessionId,
        pathChunkNumber: 0,
        ifMatch: '"1"',
        contentLength: contentBytes.length,
        xChunkSha256: chunkSha256,
        xClientSubmissionId: initRequest.clientSubmissionId,
        xClientAttachmentId: initRequest.clientAttachmentId,
        contentBytesBase64,
        responseHeaders: { ETag: '"2"', "X-Upload-Version": 2 },
        resource: {
          ...uploadScope,
          projectId: authorizedProjectId,
          sessionId: initResponse.sessionId,
          clientSubmissionId: initRequest.clientSubmissionId,
          clientAttachmentId: initRequest.clientAttachmentId,
          uploadAttempt: initRequest.uploadAttempt,
          status: "open",
          expectedSize: contentBytes.length,
          chunkSize: contentBytes.length,
          versionBefore: 1,
          receivedBytesBefore: 0,
          confirmedChunksBefore: [],
        },
        chunkFact: {
          accountId: receiptAccountId,
          actorId: receiptActorId,
          projectId: authorizedProjectId,
          sessionId: initResponse.sessionId,
          chunkNumber: 0,
          contentBytesBase64,
          contentLength: contentBytes.length,
          sha256: chunkSha256,
          durablyPersisted: true,
        },
        aggregateFact: {
          sessionId: initResponse.sessionId,
          version: 2,
          receivedBytes: contentBytes.length,
          confirmedChunks: [0],
        },
      };
    })(),
  ],
];
function configureUploadWriteReceipt(input) {
  if (!["init", "finalize", "bind", "chunk"].includes(input.mode)) return;
  const operationId = {
    init: "initUpload",
    finalize: "finalizeUpload",
    bind: "bindAttachmentReservation",
    chunk: "putUploadChunk",
  }[input.mode];
  const expectedStatus = { init: 201, finalize: 200, bind: 200, chunk: 204 }[input.mode];
  const idempotencyKey = {
    init:
      `submission:${input.request?.clientSubmissionId}:attachment:${input.request?.clientAttachmentId}` +
      `:upload:${input.request?.uploadAttempt}:init`,
    finalize:
      `submission:${input.request?.clientSubmissionId}:attachment:${input.request?.clientAttachmentId}` +
      `:upload:${input.request?.uploadAttempt}:finalize`,
    bind:
      `submission:${input.request?.clientSubmissionId}:attachment:${input.request?.clientAttachmentId}` +
      `:bind:${input.request?.leaseGeneration}`,
    chunk:
      `submission:${input.resource?.clientSubmissionId}:attachment:${input.resource?.clientAttachmentId}` +
      `:upload:${input.resource?.uploadAttempt}:chunk:${input.pathChunkNumber}`,
  }[input.mode];
  const scope = {
    init: {
      accountId: input.accountId,
      actorId: input.actorId,
      projectId: input.resource.projectId,
    },
    finalize: {
      accountId: input.accountId,
      actorId: input.actorId,
      projectId: input.resource.projectId,
      sessionId: input.resource.sessionId,
    },
    bind: {
      accountId: input.accountId,
      actorId: input.actorId,
      attachmentId: input.resource.attachmentId,
      projectId: input.resource.projectId,
    },
    chunk: {
      accountId: input.accountId,
      actorId: input.actorId,
      projectId: input.resource.projectId,
      sessionId: input.resource.sessionId,
      chunkNumber: input.pathChunkNumber,
    },
  }[input.mode];
  const requestForDigest =
    input.mode === "chunk" ? canonicalChunkRequestEnvelope(input) : input.request;
  input.idempotencyKey = idempotencyKey;
  input.persistedIdempotencyKey = idempotencyKey;
  input.canonicalRequestDigest = canonicalNonSecretRequestDigest(
    operationId,
    scope,
    requestForDigest,
    idempotencyKey,
  );
  input.persistedRequestDigest = input.canonicalRequestDigest;
  input.authorizationCheckedBeforeIdempotency = true;
  input.idempotencyRecordCommitted = true;
  input.originalEffectCommitted = true;
  input.atomicReceiptAndEffectCommitted = true;
  input.mutationCount = 1;
  input.httpStatus = expectedStatus;
  const body = input.response == null ? null : structuredClone(input.response);
  if (body && typeof body === "object") delete body.replayed;
  input.persistedHttpReceipt = {
    status: expectedStatus,
    headers: structuredClone(input.responseHeaders ?? {}),
    body,
  };
  if (input.mode === "init") {
    input.effectFact = {
      operationId,
      accountId: input.accountId,
      actorId: input.actorId,
      projectId: input.resource.projectId,
      sessionId: input.resource.sessionId,
      clientSubmissionId: input.resource.clientSubmissionId,
      clientAttachmentId: input.resource.clientAttachmentId,
      uploadAttempt: input.resource.uploadAttempt,
      version: 1,
      uploadSessionCommitted: true,
    };
  } else if (input.mode === "finalize") {
    input.effectFact = {
      operationId,
      accountId: input.accountId,
      actorId: input.actorId,
      projectId: input.resource.projectId,
      sessionId: input.resource.sessionId,
      attachmentId: input.resource.attachmentId,
      persistedObjectSha256: input.resource.persistedSha256,
      persistedObjectSize: input.resource.persistedSize,
      uploadSessionFinalized: true,
      attachmentCreated: true,
      scanOutboxCommitted: true,
    };
  } else if (input.mode === "bind") {
    input.effectFact = {
      operationId,
      accountId: input.accountId,
      actorId: input.actorId,
      projectId: input.resource.projectId,
      attachmentId: input.resource.attachmentId,
      bindingId: input.resource.bindingId,
      leaseGeneration: input.resource.leaseGeneration,
      version: input.response.version,
      expiresAt: input.response.expiresAt,
      reservationCommitted: true,
    };
  }
}
for (const [, input] of uploadReceiptCases) configureUploadWriteReceipt(input);
for (const [label, input] of uploadReceiptCases) {
  if (evaluateAppFirstBehavior("upload-receipt", input) !== "unambiguous") {
    failures.push(`${label}: upload path/request/response/resource receipt is ambiguous`);
  }
}
for (const [label, caseIndex, mutate] of [
  ["init foreign project", 0, (input) => (input.response.projectId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
  ["init swapped upload attempt", 0, (input) => (input.response.uploadAttempt = 2)],
  ["init oversized lease", 0, (input) => (input.response.expiresAt = "2026-08-24T12:00:01Z")],
  ["finalize foreign session", 1, (input) => (input.response.sessionId = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
  ["finalize foreign attachment", 1, (input) => (input.response.attachmentId = "ffffffff-ffff-4fff-8fff-fffffffffff3")],
  ["finalize changed hash", 1, (input) => (input.response.sha256 = "b".repeat(64))],
  ["finalize changed size", 1, (input) => (input.response.size += 1)],
  ["session out-of-range chunk", 2, (input) => (input.response.confirmedChunks = [1])],
  ["session incomplete terminal bytes", 2, (input) => (input.response.receivedBytes = 0)],
  ["metadata foreign path", 3, (input) => (input.pathAttachmentId = "ffffffff-ffff-4fff-8fff-fffffffffff4")],
  ["metadata foreign submission", 3, (input) => (input.response.clientSubmissionId = "ffffffff-ffff-4fff-8fff-fffffffffff5")],
  ["bind claimed response", 4, (input) => (input.response.status = "claimed")],
  ["bind foreign attachment", 4, (input) => (input.response.attachmentId = "ffffffff-ffff-4fff-8fff-fffffffffff6")],
  ["bind oversized lease", 4, (input) => (input.response.expiresAt = "2026-08-25T10:00:01Z")],
  ["chunk changed content length", 5, (input) => (input.contentLength += 1)],
  ["chunk forged hash", 5, (input) => (input.xChunkSha256 = "b".repeat(64))],
  ["chunk foreign submission header", 5, (input) => (input.xClientSubmissionId = "ffffffff-ffff-4fff-8fff-fffffffffff7")],
  ["chunk wrong ETag", 5, (input) => (input.responseHeaders.ETag = '"3"')],
  ["chunk not durable", 5, (input) => (input.chunkFact.durablyPersisted = false)],
]) {
  const input = structuredClone(uploadReceiptCases[caseIndex][1]);
  mutate(input);
  if (evaluateAppFirstBehavior("upload-receipt", input) !== "ambiguous") {
    failures.push(`upload receipt mutation ${label} was accepted`);
  }
}

function uploadDigestDescriptor(input) {
  const operationId = {
    init: "initUpload",
    finalize: "finalizeUpload",
    bind: "bindAttachmentReservation",
    chunk: "putUploadChunk",
  }[input.mode];
  const scope = {
    init: { accountId: input.accountId, actorId: input.actorId, projectId: input.resource.projectId },
    finalize: { accountId: input.accountId, actorId: input.actorId, projectId: input.resource.projectId, sessionId: input.resource.sessionId },
    bind: { accountId: input.accountId, actorId: input.actorId, attachmentId: input.resource.attachmentId, projectId: input.resource.projectId },
    chunk: { accountId: input.accountId, actorId: input.actorId, projectId: input.resource.projectId, sessionId: input.resource.sessionId, chunkNumber: input.pathChunkNumber },
  }[input.mode];
  return {
    operationId,
    scope,
    request: input.mode === "chunk" ? canonicalChunkRequestEnvelope(input) : input.request,
  };
}

for (const [label, sourceIndex] of [
  ["initUpload", 0],
  ["finalizeUpload", 1],
  ["bindAttachmentReservation", 4],
  ["putUploadChunk", 5],
]) {
  const source = uploadReceiptCases[sourceIndex][1];
  {
    const input = structuredClone(source);
    input.exactReplay = true;
    input.replayAuthorized = true;
    input.mutationCount = 0;
    if (input.response) input.response.replayed = true;
    if (evaluateAppFirstBehavior("upload-receipt", input) !== "unambiguous") {
      failures.push(`${label}: exact replay did not return the persisted HTTP receipt`);
    }
    input.replayAuthorized = false;
    if (evaluateAppFirstBehavior("upload-receipt", input) !== "ambiguous") {
      failures.push(`${label}: unauthorized exact replay was accepted`);
    }
  }
  {
    const input = structuredClone(source);
    input.idempotencyKey = "totally-noncanonical-key";
    input.persistedIdempotencyKey = input.idempotencyKey;
    const descriptor = uploadDigestDescriptor(input);
    input.canonicalRequestDigest = canonicalNonSecretRequestDigest(
      descriptor.operationId,
      descriptor.scope,
      descriptor.request,
      input.idempotencyKey,
    );
    input.persistedRequestDigest = input.canonicalRequestDigest;
    if (evaluateAppFirstBehavior("upload-receipt", input) !== "ambiguous") {
      failures.push(`${label}: noncanonical but internally rehashed idempotency key was accepted`);
    }
  }
  for (const [suffix, mutate] of [
    ["authorization after lookup", (input) => (input.authorizationCheckedBeforeIdempotency = false)],
    ["missing idempotency row", (input) => (input.idempotencyRecordCommitted = false)],
    ["non-atomic receipt", (input) => (input.atomicReceiptAndEffectCommitted = false)],
    ["missing original effect", (input) => (input.originalEffectCommitted = false)],
    ["wrong HTTP status", (input) => (input.httpStatus = 202)],
    ["wrong fresh mutation count", (input) => (input.mutationCount = 0)],
  ]) {
    const input = structuredClone(source);
    mutate(input);
    if (evaluateAppFirstBehavior("upload-receipt", input) !== "ambiguous") {
      failures.push(`${label}: ${suffix} was accepted`);
    }
  }
}

{
  const input = structuredClone(uploadReceiptCases[5][1]);
  input.exactReplay = true;
  input.replayAuthorized = true;
  input.mutationCount = 0;
  const changedBytes = Buffer.from("chunk-payload-02", "utf8");
  input.contentBytesBase64 = changedBytes.toString("base64");
  input.contentLength = changedBytes.length;
  input.xChunkSha256 = createHash("sha256").update(changedBytes).digest("hex");
  input.chunkFact.contentBytesBase64 = input.contentBytesBase64;
  input.chunkFact.contentLength = input.contentLength;
  input.chunkFact.sha256 = input.xChunkSha256;
  if (evaluateAppFirstBehavior("upload-receipt", input) !== "ambiguous") {
    failures.push("putUploadChunk exact replay accepted changed raw bytes");
  }
}

const nativeSessionForReceipts = operationExamples.createNativeSession.response.session;
const notificationRegistrationInput = {
  session: nativeSessionForReceipts,
  request: operationExamples.registerAndroidNotificationDevice.request,
  response: operationExamples.registerAndroidNotificationDevice.response,
  existing: null,
  exactReplay: false,
  requestTokenHmac: "request-token-hmac-v1-00000001",
  persistedEncryptedTokenHmac: "request-token-hmac-v1-00000001",
  existingTokenHmac: null,
  oldTokenReplaced: false,
  encryptedTokenPersisted: true,
  encryptionKeyVersion: 1,
  rawTokenAbsent: true,
  tokenUniqueLookupPerformed: true,
  tokenOwnerFact: null,
  now: operationExamples.registerAndroidNotificationDevice.response.serverReceivedAt,
};
notificationRegistrationInput.idempotencyKey = "notification-register-action-key";
notificationRegistrationInput.persistedIdempotencyKey =
  notificationRegistrationInput.idempotencyKey;
notificationRegistrationInput.serverPepper = testServerPepper;
notificationRegistrationInput.serverPepperProtected = true;
notificationRegistrationInput.requestDigestAlgorithm = "HMAC-SHA-256";
notificationRegistrationInput.canonicalRequestDigest = canonicalReplayDigest(
  "registerAndroidNotificationDevice",
  {
    accountId: notificationRegistrationInput.session.accountId,
    actorId: notificationRegistrationInput.session.user.id,
    installationId: notificationRegistrationInput.session.installationId,
  },
  notificationRegistrationInput.request,
  notificationRegistrationInput.idempotencyKey,
  notificationRegistrationInput.serverPepper,
);
notificationRegistrationInput.persistedRequestDigest =
  notificationRegistrationInput.canonicalRequestDigest;
notificationRegistrationInput.idempotencyRecordCommitted = true;
notificationRegistrationInput.encryptedReceiptSnapshotPersisted = true;
notificationRegistrationInput.receiptEncryptionKeyVersion = 1;
notificationRegistrationInput.rawReceiptSecretsAbsent = true;
notificationRegistrationInput.originalEffectCommitted = true;
notificationRegistrationInput.mutationCount = 1;
notificationRegistrationInput.persistedResponse = structuredClone(
  notificationRegistrationInput.response,
);
if (
  evaluateAppFirstBehavior(
    "notification-registration-receipt",
    notificationRegistrationInput,
  ) !== "unambiguous"
) {
  failures.push("Android notification registration receipt is ambiguous");
}
for (const [label, mutate] of [
  ["account", (input) => (input.response.accountId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
  ["user", (input) => (input.response.userId = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
  ["installation", (input) => (input.response.installationId = "ffffffff-ffff-4fff-8fff-fffffffffff3")],
  ["provider", (input) => (input.response.provider = "other")],
  ["version", (input) => (input.response.version = 2)],
  ["replay flag", (input) => (input.response.replayed = true)],
  ["server timestamp", (input) => (input.response.serverReceivedAt = "2026-08-24T10:50:02Z")],
  ["persisted token", (input) => (input.persistedEncryptedTokenHmac = "different-token-hmac-00000001")],
  ["plaintext retained", (input) => (input.rawTokenAbsent = false)],
  ["foreign token owner", (input) => (input.tokenOwnerFact = { accountId: input.session.accountId, userId: "foreign-user", installationId: input.session.installationId })],
]) {
  const input = structuredClone(notificationRegistrationInput);
  mutate(input);
  if (
    evaluateAppFirstBehavior("notification-registration-receipt", input) !== "ambiguous"
  ) {
    failures.push(`notification registration receipt mutation ${label} was accepted`);
  }
}
{
  const input = structuredClone(notificationRegistrationInput);
  input.existing = {
    id: input.response.id,
    accountId: input.session.accountId,
    userId: input.session.user.id,
    installationId: input.session.installationId,
    createdAt: input.response.createdAt,
    version: 3,
  };
  input.request.expectedVersion = 3;
  input.response.version = 4;
  input.existingTokenHmac = "prior-token-hmac-v1-0000000001";
  input.oldTokenReplaced = true;
  input.tokenOwnerFact = {
    deviceId: input.existing.id,
    accountId: input.session.accountId,
    userId: input.session.user.id,
    installationId: input.session.installationId,
  };
  input.canonicalRequestDigest = canonicalReplayDigest(
    "registerAndroidNotificationDevice",
    {
      accountId: input.session.accountId,
      actorId: input.session.user.id,
      installationId: input.session.installationId,
    },
    input.request,
    input.idempotencyKey,
    input.serverPepper,
  );
  input.persistedRequestDigest = input.canonicalRequestDigest;
  input.persistedResponse = structuredClone(input.response);
  if (
    evaluateAppFirstBehavior("notification-registration-receipt", input) !== "unambiguous"
  ) {
    failures.push("notification rotation after version 3 is not supported dynamically");
  }
}
{
  const input = structuredClone(notificationRegistrationInput);
  input.existing = {
    id: input.response.id,
    accountId: input.session.accountId,
    userId: input.session.user.id,
    installationId: input.session.installationId,
    createdAt: input.response.createdAt,
    version: 1,
  };
  input.existingTokenHmac = input.persistedEncryptedTokenHmac;
  input.tokenOwnerFact = {
    deviceId: input.existing.id,
    accountId: input.session.accountId,
    userId: input.session.user.id,
    installationId: input.session.installationId,
  };
  input.exactReplay = true;
  input.response.replayed = true;
  input.persistedResponse = structuredClone(input.response);
  input.replayAuthorized = true;
  input.idempotencyKey = "notification-register-action-key";
  input.persistedIdempotencyKey = input.idempotencyKey;
  input.serverPepper = testServerPepper;
  input.serverPepperProtected = true;
  input.requestDigestAlgorithm = "HMAC-SHA-256";
  input.canonicalRequestDigest = canonicalReplayDigest(
    "registerAndroidNotificationDevice",
    {
      accountId: input.session.accountId,
      actorId: input.session.user.id,
      installationId: input.session.installationId,
    },
    input.request,
    input.idempotencyKey,
    input.serverPepper,
  );
  input.persistedRequestDigest = input.canonicalRequestDigest;
  input.originalEffectCommitted = true;
  input.mutationCount = 0;
  input.encryptedReceiptSnapshotPersisted = true;
  input.receiptEncryptionKeyVersion = 1;
  input.rawReceiptSecretsAbsent = true;
  input.now = "2026-08-24T10:51:00Z";
  if (
    evaluateAppFirstBehavior("notification-registration-receipt", input) !== "unambiguous"
  ) {
    failures.push("exact notification registration replay did not return its persisted receipt");
  }
  const changedAction = structuredClone(input);
  changedAction.request.clientActionId = "ffffffff-ffff-4fff-8fff-fffffffffff7";
  if (
    evaluateAppFirstBehavior("notification-registration-receipt", changedAction) !== "ambiguous"
  ) {
    failures.push("notification registration replay accepted a changed clientActionId");
  }
  const changedToken = structuredClone(input);
  changedToken.request.token = "different-notification-token-value";
  changedToken.requestTokenHmac = "different-token-hmac-000000000001";
  changedToken.persistedEncryptedTokenHmac = changedToken.requestTokenHmac;
  changedToken.existingTokenHmac = changedToken.requestTokenHmac;
  if (
    evaluateAppFirstBehavior("notification-registration-receipt", changedToken) !== "ambiguous"
  ) {
    failures.push("notification registration replay accepted a changed token payload");
  }
  input.response.version = 2;
  if (evaluateAppFirstBehavior("notification-registration-receipt", input) !== "ambiguous") {
    failures.push("mutated exact notification registration replay was accepted");
  }
}

const notificationListInput = {
  mode: "list",
  session: nativeSessionForReceipts,
  accountId: nativeSessionForReceipts.accountId,
  actorId: nativeSessionForReceipts.user.id,
  authorizedProjectIds: nativeSessionForReceipts.projects
    .filter((project) => project.active === true)
    .map((project) => project.id),
  queryProjectId: authorizedProjectId,
  queryUnreadOnly: true,
  queryCursor: null,
  queryLimit: 50,
  authorizedUnreadCount: 1,
  response: operationExamples.listNotifications.response,
  notificationFacts: structuredClone(operationExamples.listNotifications.response.items),
};
{
  const query = {
    cursor: notificationListInput.queryCursor,
    limit: notificationListInput.queryLimit,
    projectId: notificationListInput.queryProjectId,
    unreadOnly: notificationListInput.queryUnreadOnly,
  };
  attachSignedPageFacts(notificationListInput, {
    operationId: "listNotifications",
    query,
    response: notificationListInput.response,
    normalizedFilters: { projectId: query.projectId, unreadOnly: query.unreadOnly },
    orderedItemIds: notificationListInput.response.items.map((item) => item.id),
    orderedSortKeys: notificationListInput.response.items.map(
      (item) => `${contractDescendingDateSortKey(item.createdAt)}:${item.id}`,
    ),
    scope: { userId: notificationListInput.actorId },
    limit: query.limit,
    membershipRevision: "membership-revision:notifications:1",
  });
  notificationListInput.pageFact.authorizedUnreadCount =
    notificationListInput.response.unreadCount;
}
if (evaluateAppFirstBehavior("notification-inbox", notificationListInput) !== "unambiguous") {
  failures.push("native notification list is not bound to account/user/project scope");
}
{
  const input = structuredClone(notificationListInput);
  input.queryCursor = "signed-notification-page-cursor";
  const query = {
    cursor: input.queryCursor,
    limit: input.queryLimit,
    projectId: input.queryProjectId,
    unreadOnly: input.queryUnreadOnly,
  };
  attachSignedPageFacts(input, {
    operationId: "listNotifications",
    query,
    response: input.response,
    normalizedFilters: { projectId: query.projectId, unreadOnly: query.unreadOnly },
    orderedItemIds: input.response.items.map((item) => item.id),
    orderedSortKeys: input.response.items.map(
      (item) => `${contractDescendingDateSortKey(item.createdAt)}:${item.id}`,
    ),
    scope: { userId: input.actorId },
    limit: query.limit,
    membershipRevision: "membership-revision:notifications:cursor",
  });
  input.pageFact.authorizedUnreadCount = input.response.unreadCount;
  if (evaluateAppFirstBehavior("notification-inbox", input) !== "unambiguous") {
    failures.push("native notification list rejected a valid signed continuation");
  }
  for (const [label, mutate] of [
    ["unsigned cursor", (candidate) => (candidate.cursorFact.signatureValid = false)],
    ["foreign cursor actor", (candidate) =>
      (candidate.cursorFact.actorId = "ffffffff-ffff-4fff-8fff-fffffffffff8")],
    ["foreign filter", (candidate) => (candidate.cursorFact.filterDigest = "forged-filter")],
    ["non-progressing cursor", (candidate) =>
      (candidate.cursorFact.lastSortKey = candidate.pageFact.orderedSortKeys[0])],
  ]) {
    const candidate = structuredClone(input);
    mutate(candidate);
    if (evaluateAppFirstBehavior("notification-inbox", candidate) !== "ambiguous") {
      failures.push(`native notification list ${label} was accepted`);
    }
  }
}
const notificationResource = structuredClone(operationExamples.listNotifications.response.items[0]);
const notificationReadInput = {
  mode: "read",
  session: nativeSessionForReceipts,
  membershipRevision: "membership-revision:notifications:1",
  membershipFact: {
    accountId: nativeSessionForReceipts.accountId,
    actorId: nativeSessionForReceipts.user.id,
    projectId: notificationResource.projectId,
    membershipRevision: "membership-revision:notifications:1",
    currentActive: true,
  },
  pathNotificationId: operationExamples.markNotificationRead.pathParameters.notificationId,
  request: operationExamples.markNotificationRead.request,
  response: operationExamples.markNotificationRead.response,
  resource: notificationResource,
  serverNow: operationExamples.markNotificationRead.response.readAt,
};
if (evaluateAppFirstBehavior("notification-inbox", notificationReadInput) !== "unambiguous") {
  failures.push("markNotificationRead path/CAS/response receipt is ambiguous");
}
{
  const input = structuredClone(notificationListInput);
  input.response.items[0].readAt = "2026-08-24T10:46:00Z";
  input.notificationFacts[0].readAt = input.response.items[0].readAt;
  if (evaluateAppFirstBehavior("notification-inbox", input) !== "ambiguous") {
    failures.push("notification unreadOnly filter accepted a read item");
  }
}
{
  const input = structuredClone(notificationListInput);
  input.queryLimit = 1;
  const duplicate = structuredClone(input.response.items[0]);
  duplicate.id = "13000000-0000-4000-8000-000000000002";
  input.response.items.push(duplicate);
  input.notificationFacts.push(structuredClone(duplicate));
  input.pageFact.orderedItemIds.push(duplicate.id);
  if (evaluateAppFirstBehavior("notification-inbox", input) !== "ambiguous") {
    failures.push("notification list returned more rows than the requested limit");
  }
}
{
  const input = structuredClone(notificationReadInput);
  input.exactReplay = true;
  input.replayAuthorized = true;
  input.idempotencyKey = "notification-read-action-key";
  input.persistedIdempotencyKey = input.idempotencyKey;
  input.serverPepper = testServerPepper;
  input.serverPepperProtected = true;
  input.requestDigestAlgorithm = "HMAC-SHA-256";
  input.canonicalRequestDigest = canonicalReplayDigest(
    "markNotificationRead",
    {
      accountId: input.session.accountId,
      actorId: input.session.user.id,
      notificationId: input.resource.id,
      projectId: input.resource.projectId,
    },
    input.request,
    input.idempotencyKey,
    input.serverPepper,
  );
  input.persistedRequestDigest = input.canonicalRequestDigest;
  input.originalEffectCommitted = true;
  input.mutationCount = 0;
  input.persistedResponse = structuredClone(input.response);
  if (evaluateAppFirstBehavior("notification-inbox", input) !== "unambiguous") {
    failures.push("markNotificationRead exact replay did not return its persisted response");
  }
  const changedRequest = structuredClone(input);
  changedRequest.request.expectedVersion = 999;
  if (evaluateAppFirstBehavior("notification-inbox", changedRequest) !== "ambiguous") {
    failures.push("markNotificationRead exact replay accepted a changed request version");
  }
  const changedKey = structuredClone(input);
  changedKey.idempotencyKey = "different-notification-read-key";
  if (evaluateAppFirstBehavior("notification-inbox", changedKey) !== "ambiguous") {
    failures.push("markNotificationRead exact replay accepted a different idempotency key");
  }
}
for (const [label, source, mutate] of [
  ["list foreign account", notificationListInput, (input) => (input.response.items[0].accountId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
  ["list foreign user", notificationListInput, (input) => (input.response.items[0].userId = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
  ["list foreign project", notificationListInput, (input) => (input.response.items[0].projectId = "ffffffff-ffff-4fff-8fff-fffffffffff3")],
  ["list false unread count", notificationListInput, (input) => (input.response.unreadCount = 0)],
  ["list revoked page membership", notificationListInput, (input) => (input.pageAuthorizationFacts[0].currentActive = false)],
  ["list inactive session project", notificationListInput, (input) => (input.session.projects[0].active = false)],
  ["read foreign path", notificationReadInput, (input) => (input.pathNotificationId = "ffffffff-ffff-4fff-8fff-fffffffffff4")],
  ["read revoked membership", notificationReadInput, (input) => (input.membershipFact.currentActive = false)],
  ["read inactive session project", notificationReadInput, (input) => (input.session.projects[0].active = false)],
  ["read stale version", notificationReadInput, (input) => (input.request.expectedVersion = 2)],
  ["read null timestamp", notificationReadInput, (input) => (input.response.readAt = null)],
  ["read version not advanced", notificationReadInput, (input) => (input.response.version = 1)],
]) {
  const input = structuredClone(source);
  mutate(input);
  if (evaluateAppFirstBehavior("notification-inbox", input) !== "ambiguous") {
    failures.push(`notification Inbox mutation ${label} was accepted`);
  }
}
const captureRequest = operationExamples.createCaptureBundle.request;
const captureResponse = operationExamples.createCaptureBundle.response.captureBundle;
const derivedCaptureStatus = deriveEnrichmentStatus(captureResponse.poco);
if (
  captureRequest.projectId !== captureRequest.capture.projectId ||
  captureRequest.clientSubmissionId !== captureRequest.capture.clientSubmissionId ||
  captureResponse.enrichmentStatus !== derivedCaptureStatus ||
  captureResponse.poco.status !== derivedCaptureStatus
) {
  failures.push("Capture example IDs or server-derived enrichment status are inconsistent.");
}
const captureActorId = operationExamples.createNativeSession.response.session.user.id;
function buildAttachmentFacts(capture) {
  return capture.artifacts
    .filter((artifact) => artifact.status === "succeeded")
    .map((artifact) => ({
      accountId: "account-example",
      actorId: captureActorId,
      projectId: capture.projectId,
      clientSubmissionId: capture.clientSubmissionId,
      clientAttachmentId: artifact.clientAttachmentId,
      attachmentId: artifact.attachmentId,
      captureId: capture.captureId,
      validatedArtifactKind: artifact.kind,
      mediaType: artifact.kind === "system_recording" ? "video/mp4" : "image/png",
      scanStatus: "clean",
      readyToBind: true,
      bindingStatus: "reserved",
      durablyReadable: true,
      storedBytes: 1_048_576,
      decodedBytes: 1_048_576,
    }));
}
const validCaptureSemanticInputs = [];
for (const [label, capture] of [
  ["createCaptureBundle request", captureRequest.capture],
  ["createCaptureBundle response", captureResponse],
  ["getCaptureBundle response", operationExamples.getCaptureBundle.response],
]) {
  const input = {
    accountId: "account-example",
    actorId: captureActorId,
    projectId: capture.projectId,
    clientSubmissionId: capture.clientSubmissionId,
    attachmentFacts: buildAttachmentFacts(capture),
    capture,
  };
  validCaptureSemanticInputs.push([label, input]);
  const result = evaluateAppFirstBehavior("capture-consistency", input);
  if (!result.startsWith("accepted:")) {
    failures.push(`${label} violates executable capture semantics: ${result}`);
  }
}
const createCaptureReceiptInput = {
  accountId: uploadScope.accountId,
  actorId: uploadScope.actorId,
  mode: "create",
  authorizedProjectId,
  request: operationExamples.createCaptureBundle.request,
  response: operationExamples.createCaptureBundle.response,
  captureFact: {
    accountId: uploadScope.accountId,
    actorId: uploadScope.actorId,
    projectId: authorizedProjectId,
    captureId: operationExamples.createCaptureBundle.response.captureBundle.captureId,
    clientSubmissionId:
      operationExamples.createCaptureBundle.response.captureBundle.clientSubmissionId,
    capture: structuredClone(operationExamples.createCaptureBundle.response.captureBundle),
  },
  exactReplay: false,
  idempotencyKey: "create-capture-bundle-action-key",
  idempotencyRecordCommitted: true,
  originalEffectCommitted: true,
  mutationCount: 1,
};
createCaptureReceiptInput.persistedIdempotencyKey = createCaptureReceiptInput.idempotencyKey;
createCaptureReceiptInput.canonicalRequestDigest = canonicalNonSecretRequestDigest(
  "createCaptureBundle",
  {
    accountId: createCaptureReceiptInput.accountId,
    actorId: createCaptureReceiptInput.actorId,
    captureId: createCaptureReceiptInput.request.capture.captureId,
    projectId: createCaptureReceiptInput.authorizedProjectId,
  },
  createCaptureReceiptInput.request,
  createCaptureReceiptInput.idempotencyKey,
);
createCaptureReceiptInput.persistedRequestDigest =
  createCaptureReceiptInput.canonicalRequestDigest;
createCaptureReceiptInput.persistedResponse = structuredClone(createCaptureReceiptInput.response);
if (
  evaluateAppFirstBehavior("capture-receipt", createCaptureReceiptInput) !== "unambiguous"
) {
  failures.push("createCaptureBundle request/response receipt is ambiguous");
}
{
  const input = structuredClone(createCaptureReceiptInput);
  input.exactReplay = true;
  input.replayAuthorized = true;
  input.response.replayed = true;
  input.persistedResponse = structuredClone(input.response);
  input.mutationCount = 0;
  if (evaluateAppFirstBehavior("capture-receipt", input) !== "unambiguous") {
    failures.push("createCaptureBundle exact replay did not return its persisted response");
  }
  input.idempotencyKey = "different-capture-action-key";
  if (evaluateAppFirstBehavior("capture-receipt", input) !== "ambiguous") {
    failures.push("createCaptureBundle exact replay accepted a different idempotency key");
  }
}
{
  const input = structuredClone(createCaptureReceiptInput);
  const buildId = "b0000000-0000-4000-8000-0000000000f2";
  input.request.capture.deviceMetadata.buildId = buildId;
  input.response.captureBundle.deviceMetadata.buildId = buildId;
  input.captureFact.capture.deviceMetadata.buildId = buildId;
  input.captureBuildFact = {
    accountId: input.accountId,
    projectId: input.authorizedProjectId,
    buildId,
    relationValidated: true,
  };
  input.canonicalRequestDigest = canonicalNonSecretRequestDigest(
    "createCaptureBundle",
    {
      accountId: input.accountId,
      actorId: input.actorId,
      captureId: input.request.capture.captureId,
      projectId: input.authorizedProjectId,
    },
    input.request,
    input.idempotencyKey,
  );
  input.persistedRequestDigest = input.canonicalRequestDigest;
  input.persistedResponse = structuredClone(input.response);
  if (evaluateAppFirstBehavior("capture-receipt", input) !== "unambiguous") {
    failures.push("createCaptureBundle same-project device Build reference was rejected");
  }
  for (const [label, mutate] of [
    ["missing Build fact", (candidate) => (candidate.captureBuildFact = null)],
    ["foreign Build account", (candidate) => (candidate.captureBuildFact.accountId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
    ["foreign Build project", (candidate) => (candidate.captureBuildFact.projectId = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
    ["unvalidated Build relation", (candidate) => (candidate.captureBuildFact.relationValidated = false)],
  ]) {
    const candidate = structuredClone(input);
    mutate(candidate);
    if (evaluateAppFirstBehavior("capture-receipt", candidate) !== "ambiguous") {
      failures.push(`createCaptureBundle ${label} was accepted`);
    }
  }
}
const getCaptureReceiptInput = {
  ...uploadScope,
  mode: "get",
  pathCaptureId: operationExamples.getCaptureBundle.pathParameters.captureId,
  response: operationExamples.getCaptureBundle.response,
  resource: {
    ...uploadScope,
    captureId: operationExamples.getCaptureBundle.response.captureId,
    projectId: operationExamples.getCaptureBundle.response.projectId,
    clientSubmissionId: operationExamples.getCaptureBundle.response.clientSubmissionId,
    capture: structuredClone(operationExamples.getCaptureBundle.response),
  },
};
if (evaluateAppFirstBehavior("capture-receipt", getCaptureReceiptInput) !== "unambiguous") {
  failures.push("getCaptureBundle path/resource/response receipt is ambiguous");
}
for (const [label, source, mutate] of [
  ["create captureId", createCaptureReceiptInput, (input) => (input.response.captureBundle.captureId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
  ["create project", createCaptureReceiptInput, (input) => (input.response.captureBundle.projectId = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
  ["create submission", createCaptureReceiptInput, (input) => (input.response.captureBundle.clientSubmissionId = "ffffffff-ffff-4fff-8fff-fffffffffff3")],
  ["create primary evidence", createCaptureReceiptInput, (input) => (input.response.captureBundle.primaryEvidenceAttachmentId = "ffffffff-ffff-4fff-8fff-fffffffffff4")],
  ["create artifact identity", createCaptureReceiptInput, (input) => (input.response.captureBundle.artifacts[0].attachmentId = "ffffffff-ffff-4fff-8fff-fffffffffff5")],
  ["create foreign account", createCaptureReceiptInput, (input) => (input.accountId = "foreign-account")],
  ["create foreign actor", createCaptureReceiptInput, (input) => (input.actorId = "foreign-actor")],
  ["create missing fact", createCaptureReceiptInput, (input) => (input.captureFact = null)],
  ["create missing idempotency commit", createCaptureReceiptInput, (input) => (input.idempotencyRecordCommitted = false)],
  ["get path", getCaptureReceiptInput, (input) => (input.pathCaptureId = "ffffffff-ffff-4fff-8fff-fffffffffff6")],
  ["get swapped artifact", getCaptureReceiptInput, (input) => (input.response.artifacts[0].attachmentId = "ffffffff-ffff-4fff-8fff-fffffffffff7")],
  ["get changed device", getCaptureReceiptInput, (input) => (input.response.deviceMetadata.model = "Foreign Device")],
]) {
  const input = structuredClone(source);
  mutate(input);
  if (evaluateAppFirstBehavior("capture-receipt", input) !== "ambiguous") {
    failures.push(`capture receipt mutation ${label} was accepted`);
  }
}
{
  const bytes = Buffer.from("0123456789", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const attachmentId = "50000000-0000-4000-8000-0000000000f1";
  const projectId = authorizedProjectId;
  const commonHeaders = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": 'attachment; filename="evidence.bin"',
    "Content-Type": "application/octet-stream",
    ETag: `"sha256-${sha256}"`,
    "X-Content-Type-Options": "nosniff",
  };
  const makeResponse = (range) => {
    if (range == null) {
      return {
        statusCode: 200,
        headers: { ...commonHeaders, "Content-Length": bytes.length },
        bodyBytesBase64: bytes.toString("base64"),
      };
    }
    const valid = {
      "bytes=0-0": [0, 0],
      "bytes=0-": [0, 9],
      "bytes=-1": [9, 9],
      "bytes=-20": [0, 9],
      "bytes=2-5": [2, 5],
      "bytes=8-99": [8, 9],
    }[range];
    if (!valid) {
      return {
        statusCode: 416,
        headers: {
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store",
          "Content-Range": `bytes */${bytes.length}`,
          "X-Content-Type-Options": "nosniff",
        },
        bodyBytesBase64: null,
      };
    }
    const [start, end] = valid;
    const slice = bytes.subarray(start, end + 1);
    return {
      statusCode: 206,
      headers: {
        ...commonHeaders,
        "Content-Length": slice.length,
        "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
      },
      bodyBytesBase64: slice.toString("base64"),
    };
  };
  const claimedDownload = {
    accountId: submissionAccountId,
    actorId: receiptActorId,
    currentMembershipRevision: "membership-revision:attachment:3",
    authorizedProjectIds: [projectId],
    serverNow: "2026-08-24T12:00:00Z",
    pathAttachmentId: attachmentId,
    request: { delivery: "proxy", range: null },
    redirectFact: null,
    attachmentFact: {
      accountId: submissionAccountId,
      projectId,
      attachmentId,
      version: 3,
      immutableBlobVersion: "blob-v1",
      safeFilename: "evidence.bin",
      mediaType: "text/html",
      size: bytes.length,
      sha256,
      scanStatus: "clean",
      readyToBind: true,
      bindingStatus: "claimed",
      durablyReadable: true,
      uploaderActorId: "ffffffff-ffff-4fff-8fff-fffffffffff9",
    },
    authorizationFact: {
      decisionId: "download-decision-1",
      accountId: submissionAccountId,
      actorId: receiptActorId,
      projectId,
      attachmentId,
      attachmentVersion: 3,
      currentReadMembershipActive: true,
      membershipRevision: "membership-revision:attachment:3",
      readSnapshotId: "attachment-read-snapshot:1",
      decidedAt: "2026-08-24T11:59:59Z",
    },
    claimFact: {
      accountId: submissionAccountId,
      projectId,
      attachmentId,
      attachmentVersion: 3,
      owningBugId: createResponse.bug.id,
      bugVisibleToActor: true,
      currentClaim: true,
      relationValidated: true,
    },
    reservationFact: null,
    blobFact: {
      decisionId: "download-decision-1",
      accountId: submissionAccountId,
      projectId,
      attachmentId,
      attachmentVersion: 3,
      immutableBlobVersion: "blob-v1",
      readSnapshotId: "attachment-read-snapshot:1",
      authorizationBeforeBlobOpen: true,
      openedAt: "2026-08-24T11:59:59.500Z",
      size: bytes.length,
      sha256,
      validatedMediaType: "text/html",
      magicValidated: true,
      scanStatus: "clean",
      bytesBase64: bytes.toString("base64"),
      durablyReadable: true,
    },
    response: makeResponse(null),
  };
  if (
    evaluateAppFirstBehavior("attachment-download-receipt", claimedDownload) !==
    "unambiguous"
  ) {
    failures.push("getAttachment: current reader could not download visible claimed evidence");
  }
  for (const range of ["bytes=0-0", "bytes=0-", "bytes=-1", "bytes=-20", "bytes=2-5", "bytes=8-99"]) {
    const candidate = structuredClone(claimedDownload);
    candidate.request.range = range;
    candidate.response = makeResponse(range);
    if (evaluateAppFirstBehavior("attachment-download-receipt", candidate) !== "unambiguous") {
      failures.push(`getAttachment: valid single range ${range} was rejected`);
    }
  }
  for (const range of [
    "bytes=10-",
    "bytes=5-4",
    "bytes=-0",
    "bytes=999999999999999999999999-",
    "bytes=0-1,4-5",
    "bytes=",
    "items=0-1",
  ]) {
    const candidate = structuredClone(claimedDownload);
    candidate.request.range = range;
    candidate.response = makeResponse(range);
    if (evaluateAppFirstBehavior("attachment-download-receipt", candidate) !== "unambiguous") {
      failures.push(`getAttachment: authorized unsatisfiable range ${range} did not produce bounded 416`);
    }
  }
  for (const [label, mutate] of [
    ["foreign path", (candidate) => (candidate.pathAttachmentId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
    ["revoked membership", (candidate) => (candidate.authorizationFact.currentReadMembershipActive = false)],
    ["stale membership revision", (candidate) => (candidate.authorizationFact.membershipRevision = "membership-revision:stale")],
    ["stale authorization decision", (candidate) => (candidate.authorizationFact.decidedAt = "2026-08-24T11:00:00Z")],
    ["unauthorized project", (candidate) => (candidate.authorizedProjectIds = [])],
    ["foreign claim project", (candidate) => (candidate.claimFact.projectId = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
    ["foreign claim attachment", (candidate) => (candidate.claimFact.attachmentId = "ffffffff-ffff-4fff-8fff-fffffffffff3")],
    ["hidden owning Bug", (candidate) => (candidate.claimFact.bugVisibleToActor = false)],
    ["stale claim", (candidate) => (candidate.claimFact.currentClaim = false)],
    ["scan pending", (candidate) => (candidate.attachmentFact.scanStatus = "pending")],
    ["scan rejected", (candidate) => (candidate.attachmentFact.scanStatus = "rejected")],
    ["not ready", (candidate) => (candidate.attachmentFact.readyToBind = false)],
    ["unreadable attachment", (candidate) => (candidate.attachmentFact.durablyReadable = false)],
    ["blob decision TOCTOU", (candidate) => (candidate.blobFact.decisionId = "download-decision-foreign")],
    ["blob opened before authorization", (candidate) => (candidate.blobFact.openedAt = "2026-08-24T11:59:58Z")],
    ["blob read snapshot mismatch", (candidate) => (candidate.blobFact.readSnapshotId = "attachment-read-snapshot:foreign")],
    ["blob version mismatch", (candidate) => (candidate.blobFact.immutableBlobVersion = "blob-v2")],
    ["blob hash mismatch", (candidate) => (candidate.blobFact.sha256 = "f".repeat(64))],
    ["blob size mismatch", (candidate) => (candidate.blobFact.size += 1)],
    ["unvalidated media type", (candidate) => (candidate.blobFact.magicValidated = false)],
    ["blob scan drift", (candidate) => (candidate.blobFact.scanStatus = "pending")],
    ["response byte swap", (candidate) => (candidate.response.bodyBytesBase64 = Buffer.from("abcdefghij").toString("base64"))],
    ["unsafe filename CRLF", (candidate) => (candidate.attachmentFact.safeFilename = "x\r\nSet-Cookie.txt")],
    ["unsafe filename traversal", (candidate) => (candidate.attachmentFact.safeFilename = "../secret.txt")],
    ["redirect response", (candidate) => {
      candidate.response = { statusCode: 302, headers: { Location: "https://example.invalid/signed" }, bodyBytesBase64: null };
      candidate.redirectFact = { minted: true };
    }],
  ]) {
    const candidate = structuredClone(claimedDownload);
    mutate(candidate);
    if (evaluateAppFirstBehavior("attachment-download-receipt", candidate) !== "ambiguous") {
      failures.push(`getAttachment: ${label} was accepted`);
    }
  }
  const reservedDownload = structuredClone(claimedDownload);
  reservedDownload.attachmentFact.bindingStatus = "reserved";
  reservedDownload.attachmentFact.bindingId = "50000000-0000-4000-8000-0000000000b1";
  reservedDownload.attachmentFact.leaseGeneration = 2;
  reservedDownload.attachmentFact.clientSubmissionId = createRequest.clientSubmissionId;
  reservedDownload.attachmentFact.clientAttachmentId = createRequest.attachmentIds[0];
  reservedDownload.attachmentFact.claimIntent = "bug_create";
  reservedDownload.attachmentFact.reservationTargetQaItemId = null;
  reservedDownload.claimFact = null;
  reservedDownload.reservationFact = {
    accountId: submissionAccountId,
    projectId,
    attachmentId,
    attachmentVersion: 3,
    ownerActorId: receiptActorId,
    status: "reserved",
    bindingId: reservedDownload.attachmentFact.bindingId,
    leaseGeneration: 2,
    clientSubmissionId: reservedDownload.attachmentFact.clientSubmissionId,
    clientAttachmentId: reservedDownload.attachmentFact.clientAttachmentId,
    claimIntent: "bug_create",
    reservationTargetQaItemId: null,
    currentReservation: true,
    relationValidated: true,
    reservedAt: "2026-08-24T11:55:00Z",
    expiresAt: "2026-08-24T12:05:00Z",
  };
  if (evaluateAppFirstBehavior("attachment-download-receipt", reservedDownload) !== "unambiguous") {
    failures.push("getAttachment: current reservation owner could not download clean evidence");
  }
  for (const [label, mutate] of [
    ["foreign reservation owner", (candidate) => (candidate.reservationFact.ownerActorId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
    ["expired reservation", (candidate) => (candidate.reservationFact.expiresAt = "2026-08-24T11:59:59Z")],
    ["reservation not started", (candidate) => (candidate.reservationFact.reservedAt = "2026-08-24T12:00:01Z")],
    ["reservation version mismatch", (candidate) => (candidate.reservationFact.attachmentVersion = 2)],
    ["stale binding identity", (candidate) => (candidate.reservationFact.bindingId = "50000000-0000-4000-8000-0000000000b2")],
    ["stale client submission", (candidate) => (candidate.reservationFact.clientSubmissionId = "ffffffff-ffff-4fff-8fff-fffffffffff3")],
    ["not current reservation", (candidate) => (candidate.reservationFact.currentReservation = false)],
    ["paired binding tuple omission", (candidate) => {
      for (const field of ["bindingId", "clientSubmissionId", "clientAttachmentId", "claimIntent"]) {
        delete candidate.attachmentFact[field];
        delete candidate.reservationFact[field];
      }
    }],
    ["invalid lease generation", (candidate) => (candidate.reservationFact.leaseGeneration = 0)],
    ["claim and reservation both present", (candidate) => (candidate.claimFact = structuredClone(claimedDownload.claimFact))],
  ]) {
    const candidate = structuredClone(reservedDownload);
    mutate(candidate);
    if (evaluateAppFirstBehavior("attachment-download-receipt", candidate) !== "ambiguous") {
      failures.push(`getAttachment reserved branch: ${label} was accepted`);
    }
  }
}
for (const [label, mutate] of [
  ["foreign actor", (input) => (input.attachmentFacts[0].actorId = "actor-foreign")],
  ["unscanned", (input) => (input.attachmentFacts[0].scanStatus = "pending")],
  ["unreserved", (input) => (input.attachmentFacts[0].bindingStatus = "unbound")],
  ["unreadable", (input) => (input.attachmentFacts[0].durablyReadable = false)],
  [
    "oversized system evidence",
    (input) =>
      (input.attachmentFacts[0].storedBytes = APP_FIRST_LIMITS.maxDecodedArtifactBytes + 1),
  ],
]) {
  const input = structuredClone(validCaptureSemanticInputs[0][1]);
  mutate(input);
  if (evaluateAppFirstBehavior("capture-consistency", input) !== "CAPTURE_BUNDLE_INVALID") {
    failures.push(`capture attachment fact ${label} was accepted`);
  }
}
const persistedPocoScenario = behaviorMatrix.scenarios.find(
  (scenario) => scenario.id === "poco-persisted-enrichment-is-complete",
);
for (const [kind, mediaType, method] of [
  ["system_screenshot", "image/png", null],
  ["system_recording", "video/mp4", null],
  ["poco_screenshot", "image/png", "Screenshot"],
  ["poco_hierarchy", "application/json", "Dump"],
  ["poco_profiling", "application/json", "GetDebugProfilingData"],
  ["poco_snapshot", "application/json", "qa.snapshot"],
]) {
  const input = structuredClone(persistedPocoScenario.input);
  let artifactIndex = input.capture.artifacts.findIndex((artifact) => artifact.kind === kind);
  if (kind === "system_recording") {
    artifactIndex = 0;
    input.capture.artifacts[0].kind = kind;
    input.attachmentFacts[0].validatedArtifactKind = kind;
  } else if (artifactIndex < 0) {
    const artifact = structuredClone(input.capture.artifacts[2]);
    const fact = structuredClone(input.attachmentFacts[2]);
    artifactIndex = input.capture.artifacts.length;
    artifact.kind = kind;
    artifact.attachmentId = `${kind}-attachment`;
    artifact.clientAttachmentId = `${kind}-client`;
    fact.validatedArtifactKind = kind;
    fact.attachmentId = artifact.attachmentId;
    fact.clientAttachmentId = artifact.clientAttachmentId;
    fact.storedBytes = 1024;
    fact.decodedBytes = 1024;
    input.capture.artifacts.push(artifact);
    input.attachmentFacts.push(fact);
    input.capture.poco.negotiatedMethods.push(method);
    input.capture.poco.succeededMethods.push(method);
    if (method === "qa.snapshot") input.capture.poco.snapshotCapability = "qa_snapshot_available";
  }
  input.attachmentFacts[artifactIndex].mediaType = mediaType;
  if (evaluateAppFirstBehavior("capture-consistency", input) !== "accepted:complete") {
    failures.push(`${kind}: allowed media type was not accepted`);
    continue;
  }
  input.attachmentFacts[artifactIndex].mediaType = "application/octet-stream";
  if (evaluateAppFirstBehavior("capture-consistency", input) !== "CAPTURE_BUNDLE_INVALID") {
    failures.push(`${kind}: disallowed media type was accepted`);
  }
}
for (const [kind, method, limit, snapshotCapability] of [
  ["poco_hierarchy", "Dump", APP_FIRST_LIMITS.maxDecodedHierarchyBytes, "standard_only"],
  ["poco_snapshot", "qa.snapshot", APP_FIRST_LIMITS.maxSnapshotSerializedBytes, "qa_snapshot_available"],
]) {
  const input = structuredClone(persistedPocoScenario.input);
  input.capture.artifacts[1].kind = kind;
  input.capture.poco.negotiatedMethods = ["GetSDKVersion", method];
  input.capture.poco.succeededMethods = ["GetSDKVersion", method];
  input.capture.poco.snapshotCapability = snapshotCapability;
  input.attachmentFacts[1].validatedArtifactKind = kind;
  input.attachmentFacts[1].mediaType = "application/json";
  input.attachmentFacts[1].decodedBytes = limit + 1;
  if (evaluateAppFirstBehavior("capture-consistency", input) !== "CAPTURE_BUNDLE_INVALID") {
    failures.push(`${kind}: oversized durably persisted attachment was accepted`);
  }
}
try {
  assert.deepStrictEqual(manifest.capturePolicy.decodedSizeLimitsByKind, {
    poco_hierarchy: APP_FIRST_LIMITS.maxDecodedHierarchyBytes,
    poco_snapshot: APP_FIRST_LIMITS.maxSnapshotSerializedBytes,
    default: APP_FIRST_LIMITS.maxDecodedArtifactBytes,
  });
} catch (error) {
  failures.push(`capture attachment size ceilings drifted: ${error.message}`);
}
const allowedPocoMethods = appSchema.$defs.pocoEnrichmentDraft.properties.allowedReadOnlyMethods.const;
for (const forbiddenMethod of ["SetText", "touch", "SendMessage", "RotateObject"]) {
  if (allowedPocoMethods.includes(forbiddenMethod)) {
    failures.push(`Poco operational method leaked into the read-only contract: ${forbiddenMethod}`);
  }
}

function makeSnapshotCorrelationInput(decodedPayload) {
  const serializedBytes = Buffer.byteLength(JSON.stringify(decodedPayload), "utf8");
  const recentErrors = decodedPayload.snapshot.recentErrors ?? [];
  return {
    request: {
      captureId: decodedPayload.captureId,
      nonce: decodedPayload.nonce,
      schemaVersion: decodedPayload.schemaVersion,
      deadlineMs: 1000,
      rpcRequestId: "rpc-privacy-1",
      method: "qa.snapshot",
    },
    response: {
      captureId: decodedPayload.captureId,
      nonce: decodedPayload.nonce,
      schemaVersion: decodedPayload.schemaVersion,
      rpcResponseId: "rpc-privacy-1",
      method: "qa.snapshot",
    },
    responseKind: "snapshot",
    elapsedMs: 100,
    cancelled: false,
    frameLength: Math.min(serializedBytes, APP_FIRST_LIMITS.maxFrameBytes),
    frameBytesReceived: Math.min(serializedBytes, APP_FIRST_LIMITS.maxFrameBytes),
    decodedBytes: serializedBytes,
    snapshotSerializedBytes: serializedBytes,
    recentErrorCount: recentErrors.length,
    recentErrorUtf8Bytes: recentErrors.reduce(
      (total, entry) => total + Buffer.byteLength(entry, "utf8"),
      0,
    ),
    customFieldCount: Object.keys(decodedPayload.snapshot.customFields ?? {}).length,
    redactionApplied: true,
    sensitiveValueScanPassed: true,
    decodedPayload,
  };
}
const oversizedSnapshotPayload = {
  captureId: "10000000-0000-4000-8000-000000000091",
  nonce: "privacy-nonce-00000001",
  schemaVersion: "1.0.0",
  generatedAt: "2026-08-24T10:00:00Z",
  redactionPolicyVersion: "1.0.0",
  sensitiveFieldsOmitted: true,
  snapshot: {
    recentErrors: Array.from({ length: 20 }, () => "\u0000".repeat(1000)),
    customFields: Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`safeField${index}`, "\u0000".repeat(1000)]),
    ),
  },
};
validateAppExample(
  "../schemas/app-first.schema.json#/$defs/pocoSnapshotResponse",
  oversizedSnapshotPayload,
  "schema-valid oversized Poco snapshot adversary",
);
{
  const input = makeSnapshotCorrelationInput(oversizedSnapshotPayload);
  input.frameLength = 1;
  input.frameBytesReceived = 1;
  input.decodedBytes = 1;
  input.snapshotSerializedBytes = 1;
  input.recentErrorCount = 1;
  input.recentErrorUtf8Bytes = 1;
  input.customFieldCount = 1;
  if (evaluateAppFirstBehavior("poco-correlation", input) !== "CAPTURE_BUNDLE_INVALID") {
    failures.push("Poco snapshot accepted client-underreported payload byte/count facts");
  }
}
for (const [label, mutate] of [
  ["sensitive custom key", (payload) => (payload.snapshot.customFields = { accessToken: "redacted?" })],
  ["secret assignment in errors", (payload) => (payload.snapshot.recentErrors = ["accessToken=not-allowed"])],
  [
    "recent error UTF-8 overflow",
    (payload) => (payload.snapshot.recentErrors = Array.from({ length: 20 }, () => "😀".repeat(500))),
  ],
  ["email-like test user", (payload) => (payload.snapshot.pseudonymousTestUserId = "qa@example.invalid")],
]) {
  const payload = {
    captureId: "10000000-0000-4000-8000-000000000092",
    nonce: "privacy-nonce-00000002",
    schemaVersion: "1.0.0",
    generatedAt: "2026-08-24T10:00:00Z",
    redactionPolicyVersion: "1.0.0",
    sensitiveFieldsOmitted: true,
    snapshot: { recentErrors: [], customFields: {} },
  };
  mutate(payload);
  validateAppExample(
    "../schemas/app-first.schema.json#/$defs/pocoSnapshotResponse",
    payload,
    `schema-valid Poco privacy adversary ${label}`,
  );
  if (
    evaluateAppFirstBehavior("poco-correlation", makeSnapshotCorrelationInput(payload)) !==
    "CAPTURE_BUNDLE_INVALID"
  ) {
    failures.push(`Poco snapshot privacy mutation ${label} was accepted`);
  }
}

const bugReceiptScope = {
  accountId: receiptAccountId,
  actorId: receiptActorId,
  authorizedProjectIds: [authorizedProjectId],
};
const baseBugFact = structuredClone(operationExamples.getBug.response);
const bugListInput = {
  ...bugReceiptScope,
  mode: "list",
  query: {
    projectId: authorizedProjectId,
    state: ["reported"],
    q: "login",
    cursor: null,
    limit: 50,
    sort: "updated_desc",
  },
  response: structuredClone(operationExamples.listBugs.response),
  itemFacts: operationExamples.listBugs.response.items.map((bug) => ({
    accountId: receiptAccountId,
    actorId: receiptActorId,
    projectId: bug.projectId,
    bug: structuredClone(bug),
  })),
};
attachSignedPageFacts(bugListInput, {
  operationId: "listBugs",
  query: bugListInput.query,
  response: bugListInput.response,
  normalizedFilters: {
    projectId: bugListInput.query.projectId,
    state: [...bugListInput.query.state].sort(),
    ownerId: null,
    verificationOwnerId: null,
    reporterId: null,
    moduleId: null,
    severity: null,
    priority: null,
    q: bugListInput.query.q,
    updatedAfter: null,
    sort: bugListInput.query.sort,
  },
  orderedItemIds: bugListInput.response.items.map((bug) => bug.id),
  orderedSortKeys: bugListInput.response.items.map((bug) =>
    contractBugSortKey(bug, bugListInput.query.sort),
  ),
  scope: {},
  limit: bugListInput.query.limit,
  membershipRevision: "membership-revision:bugs:1",
});
bugListInput.pageFact.filtersApplied = true;
bugListInput.pageFact.sortApplied = true;
bugListInput.pageFact.fullTextSearchApplied = true;
if (evaluateAppFirstBehavior("bug-operation-receipt", bugListInput) !== "unambiguous") {
  failures.push("listBugs response is not bound to scoped filter/page/item facts");
}
const bugResource = {
  ...bugReceiptScope,
  projectId: baseBugFact.projectId,
  bugId: baseBugFact.id,
  bug: structuredClone(baseBugFact),
};
const bugGetInput = {
  ...bugReceiptScope,
  mode: "get",
  pathBugId: operationExamples.getBug.pathParameters.bugId,
  response: structuredClone(baseBugFact),
  resource: structuredClone(bugResource),
  committedBugFact: {
    accountId: receiptAccountId,
    projectId: baseBugFact.projectId,
    bug: structuredClone(baseBugFact),
  },
};
if (evaluateAppFirstBehavior("bug-operation-receipt", bugGetInput) !== "unambiguous") {
  failures.push("getBug response is not bound to the path and canonical Bug fact");
}
function makeBugWriteReceipt(mode, request, response, additions = {}) {
  const operationId = {
    update: "updateBug",
    transition: "transitionBug",
    duplicate: "markBugDuplicate",
  }[mode];
  const idempotencyKey = `${operationId}-action-key`;
  const input = {
    ...bugReceiptScope,
    mode,
    pathBugId: baseBugFact.id,
    request: structuredClone(request),
    response: structuredClone(response),
    resource: structuredClone(bugResource),
    committedBugFact: {
      accountId: receiptAccountId,
      projectId: baseBugFact.projectId,
      bug: structuredClone(response),
    },
    exactReplay: false,
    idempotencyKey,
    persistedIdempotencyKey: idempotencyKey,
    idempotencyRecordCommitted: true,
    mutationCount: 1,
    ...structuredClone(additions),
  };
  input.canonicalRequestDigest = canonicalNonSecretRequestDigest(
    operationId,
    {
      accountId: receiptAccountId,
      actorId: receiptActorId,
      bugId: baseBugFact.id,
      projectId: baseBugFact.projectId,
    },
    input.request,
    input.idempotencyKey,
  );
  input.persistedRequestDigest = input.canonicalRequestDigest;
  return input;
}
const updatedBug = structuredClone(operationExamples.updateBug.response);
updatedBug.title = "Login button remains obscured after rotation";
updatedBug.ownerId = receiptActorId;
const bugUpdateInput = makeBugWriteReceipt(
  "update",
  {
    expectedVersion: baseBugFact.version,
    title: updatedBug.title,
    moduleId: updatedBug.moduleId,
    ownerId: updatedBug.ownerId,
  },
  updatedBug,
  {
    moduleFact: { id: updatedBug.moduleId, projectId: authorizedProjectId, active: true },
    ownerMemberFact: {
      userId: updatedBug.ownerId,
      projectId: authorizedProjectId,
      assignable: true,
    },
    auditCommitted: true,
  },
);
const bugTransitionInput = makeBugWriteReceipt(
  "transition",
  { expectedVersion: baseBugFact.version, toState: "ready", reason: "Triage complete" },
  operationExamples.transitionBug.response,
  {
    transitionFact: {
      transitionId: "bug.triage.ready",
      accountId: receiptAccountId,
      projectId: authorizedProjectId,
      bugId: baseBugFact.id,
      actorId: receiptActorId,
      actorType: "user",
      fromState: "reported",
      toState: "ready",
      versionBefore: 1,
      versionAfter: 2,
      allGuardsPassed: true,
      eventCommitted: true,
    },
  },
);
const canonicalBugId = "70000000-0000-4000-8000-000000000099";
const bugDuplicateInput = makeBugWriteReceipt(
  "duplicate",
  {
    expectedVersion: baseBugFact.version,
    toState: "duplicate",
    canonicalBugId,
    reason: "Same root cause and evidence",
  },
  operationExamples.markBugDuplicate.response,
  {
    transitionFact: {
      transitionId: "bug.mark_duplicate",
      accountId: receiptAccountId,
      projectId: authorizedProjectId,
      bugId: baseBugFact.id,
      actorId: receiptActorId,
      actorType: "user",
      fromState: "reported",
      toState: "duplicate",
      versionBefore: 1,
      versionAfter: 2,
      allGuardsPassed: true,
      eventCommitted: true,
    },
    canonicalBugFact: {
      accountId: receiptAccountId,
      projectId: authorizedProjectId,
      bugId: canonicalBugId,
      exists: true,
    },
    duplicateCycleCheckPassed: true,
  },
);
for (const [label, input] of [
  ["updateBug", bugUpdateInput],
  ["transitionBug", bugTransitionInput],
  ["markBugDuplicate", bugDuplicateInput],
]) {
  if (evaluateAppFirstBehavior("bug-operation-receipt", input) !== "unambiguous") {
    failures.push(`${label} write/CAS/response/audit receipt is ambiguous`);
  }
}
{
  const linked = makeBuildWriteReceipt("linkBuildRepair", "vendor");
  const request = {
    expectedVersion: linked.bugResource.bug.version,
    toState: "ready_for_verification",
    reason: "Exact delivered commit is present in the ready Build.",
  };
  const input = makeBugWriteReceipt(
    "transition",
    request,
    linked.committedBugFact.bug,
    {
      transitionFact: {
        transitionId: "bug.build_ready",
        accountId: receiptAccountId,
        projectId: authorizedProjectId,
        bugId: baseBugFact.id,
        actorId: receiptActorId,
        actorType: "user",
        fromState: "awaiting_build",
        toState: "ready_for_verification",
        versionBefore: linked.bugResource.bug.version,
        versionAfter: linked.committedBugFact.bug.version,
        allGuardsPassed: true,
        eventCommitted: true,
        sourceOperationId: "linkBuildRepair",
        buildLinkEffectCommittedAtomically: true,
      },
      repairAttemptFact: {
        ...structuredClone(linked.repairAttemptFact),
        activeForBug: true,
      },
      buildFact: {
        accountId: receiptAccountId,
        projectId: authorizedProjectId,
        build: structuredClone(linked.response.build),
        exactDeliveredCommitEligible: true,
      },
      buildRequirementFact: {
        ...structuredClone(linked.committedBuildRequirementFact),
        current: true,
      },
      linkRelationFact: structuredClone(linked.linkRelationFact),
    },
  );
  input.resource = {
    accountId: receiptAccountId,
    actorId: receiptActorId,
    projectId: authorizedProjectId,
    bugId: baseBugFact.id,
    bug: structuredClone(linked.bugResource.bug),
  };
  if (evaluateAppFirstBehavior("bug-operation-receipt", input) !== "unambiguous") {
    failures.push("bug.build_ready rejected the exact committed Build-link proof");
  }
  for (const [label, mutate] of [
    ["missing Build", (candidate) => delete candidate.buildFact],
    ["missing link", (candidate) => delete candidate.linkRelationFact],
    ["foreign Build", (candidate) => (candidate.buildFact.projectId = "foreign")],
    [
      "wrong commit",
      (candidate) =>
        (candidate.buildFact.build.manifest.commitShas = [
          "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        ]),
    ],
    [
      "wrong relation version",
      (candidate) => (candidate.linkRelationFact.link.buildRequirementVersion += 1),
    ],
  ]) {
    const candidate = structuredClone(input);
    mutate(candidate);
    if (evaluateAppFirstBehavior("bug-operation-receipt", candidate) !== "ambiguous") {
      failures.push(`bug.build_ready accepted ${label}`);
    }
  }
}
for (const [label, source, mutate] of [
  ["list forged item", bugListInput, (input) => (input.response.items[0].title = "Forged")],
  ["list ignored state filter", bugListInput, (input) => {
    input.query.state = ["ready"];
    input.pageFact.queryDigest = canonicalNonSecretRequestDigest("bug-list-query", {}, input.query, "query");
  }],
  ["get foreign path", bugGetInput, (input) => (input.pathBugId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
  ["update foreign module", bugUpdateInput, (input) => (input.moduleFact.projectId = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
  ["update unassignable owner", bugUpdateInput, (input) => (input.ownerMemberFact.assignable = false)],
  ["transition service actor", bugTransitionInput, (input) => (input.transitionFact.actorType = "service")],
  ["transition hidden title mutation", bugTransitionInput, (input) => {
    input.response.title = "Hidden mutation";
    input.committedBugFact.bug.title = input.response.title;
  }],
  ["duplicate self target", bugDuplicateInput, (input) => {
    input.request.canonicalBugId = input.resource.bugId;
    input.canonicalBugFact.bugId = input.resource.bugId;
    input.canonicalRequestDigest = canonicalNonSecretRequestDigest(
      "markBugDuplicate",
      { accountId: input.accountId, actorId: input.actorId, bugId: input.resource.bugId, projectId: input.resource.projectId },
      input.request,
      input.idempotencyKey,
    );
    input.persistedRequestDigest = input.canonicalRequestDigest;
  }],
  ["duplicate cycle", bugDuplicateInput, (input) => (input.duplicateCycleCheckPassed = false)],
]) {
  const input = structuredClone(source);
  mutate(input);
  if (evaluateAppFirstBehavior("bug-operation-receipt", input) !== "ambiguous") {
    failures.push(`Bug operation receipt mutation ${label} was accepted`);
  }
}
{
  const input = structuredClone(bugUpdateInput);
  input.exactReplay = true;
  input.replayAuthorized = true;
  input.originalEffectCommitted = true;
  input.mutationCount = 0;
  input.persistedResponse = structuredClone(input.response);
  if (evaluateAppFirstBehavior("bug-operation-receipt", input) !== "unambiguous") {
    failures.push("updateBug exact replay did not return its persisted response");
  }
  input.request.title = "Changed replay payload";
  if (evaluateAppFirstBehavior("bug-operation-receipt", input) !== "ambiguous") {
    failures.push("updateBug exact replay accepted a changed request payload");
  }
}
{
  const verificationId = "c0000000-0000-4000-8000-000000000099";
  const closedResource = structuredClone(bugResource);
  closedResource.bug.state = "ready_for_verification";
  const closedResponse = structuredClone(operationExamples.transitionBug.response);
  closedResponse.state = "closed";
  closedResponse.closedAt = closedResponse.updatedAt;
  const input = makeBugWriteReceipt(
    "transition",
    { expectedVersion: 1, toState: "closed", verificationId },
    closedResponse,
    {
      transitionFact: {
        transitionId: "bug.verification.passed",
        accountId: receiptAccountId,
        projectId: authorizedProjectId,
        bugId: baseBugFact.id,
        actorId: receiptActorId,
        actorType: "user",
        fromState: "ready_for_verification",
        toState: "closed",
        versionBefore: 1,
        versionAfter: 2,
        allGuardsPassed: true,
        eventCommitted: true,
      },
      verificationFact: {
        id: verificationId,
        accountId: receiptAccountId,
        projectId: authorizedProjectId,
        bugId: baseBugFact.id,
        status: "passed",
        verifierId: receiptActorId,
        humanVerified: true,
        latestNonSupersededAttempt: true,
        eligibleBuildEvidence: true,
        separationOfDutiesPassed: true,
      },
    },
  );
  input.resource = closedResource;
  if (evaluateAppFirstBehavior("bug-operation-receipt", input) !== "unambiguous") {
    failures.push("Bug close transition is not bound to a passed human Verification fact");
  }
  input.verificationFact.status = "failed";
  if (evaluateAppFirstBehavior("bug-operation-receipt", input) !== "ambiguous") {
    failures.push("Bug close transition accepted a failed Verification fact");
  }
}
const duplicateCandidatesInput = {
  ...bugReceiptScope,
  pathBugId: baseBugFact.id,
  sourceBug: {
    ...bugReceiptScope,
    projectId: authorizedProjectId,
    bugId: baseBugFact.id,
  },
  response: {
    candidates: [
      {
        bugId: "70000000-0000-4000-8000-000000000081",
        bugKey: "OZDQP-1081",
        score: 0.92,
        reasons: ["same module", "similar title"],
      },
      {
        bugId: "70000000-0000-4000-8000-000000000082",
        bugKey: "OZDQP-1082",
        score: 0.74,
        reasons: ["same build"],
      },
    ],
  },
};
duplicateCandidatesInput.candidateFacts = duplicateCandidatesInput.response.candidates.map(
  (candidate) => ({
    accountId: receiptAccountId,
    projectId: authorizedProjectId,
    visibleToActor: true,
    eligible: true,
    ...structuredClone(candidate),
  }),
);
duplicateCandidatesInput.corpusFact = {
  accountId: receiptAccountId,
  actorId: receiptActorId,
  projectId: authorizedProjectId,
  sourceBugId: baseBugFact.id,
  corpusVersion: "corpus-2026-08-24-1",
  snapshotSequence: 42,
  scoringCompleted: true,
  orderedCandidateIds: duplicateCandidatesInput.response.candidates.map(
    (candidate) => candidate.bugId,
  ),
};
if (
  evaluateAppFirstBehavior("duplicate-candidates-receipt", duplicateCandidatesInput) !==
  "unambiguous"
) {
  failures.push("duplicate candidates are not bound to same-project server scoring facts");
}
for (const [label, mutate] of [
  ["foreign project", (input) => (input.candidateFacts[0].projectId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
  ["self candidate", (input) => {
    input.response.candidates[0].bugId = input.sourceBug.bugId;
    input.candidateFacts[0].bugId = input.sourceBug.bugId;
    input.corpusFact.orderedCandidateIds[0] = input.sourceBug.bugId;
  }],
  ["duplicate id", (input) => {
    input.response.candidates[1].bugId = input.response.candidates[0].bugId;
    input.candidateFacts[1].bugId = input.candidateFacts[0].bugId;
    input.corpusFact.orderedCandidateIds[1] = input.corpusFact.orderedCandidateIds[0];
  }],
  ["forged score", (input) => (input.response.candidates[0].score = 0.99)],
  ["forged reason", (input) => (input.response.candidates[0].reasons = ["invented"] )],
  ["invisible candidate", (input) => (input.candidateFacts[0].visibleToActor = false)],
]) {
  const input = structuredClone(duplicateCandidatesInput);
  mutate(input);
  if (
    evaluateAppFirstBehavior("duplicate-candidates-receipt", input) !== "ambiguous"
  ) {
    failures.push(`duplicate candidate receipt mutation ${label} was accepted`);
  }
}
{
  const definition = baseManifest.operations.find(
    (entry) => entry.operationId === "listDuplicateCandidates",
  );
  const operation = openapi.paths[definition.path][definition.method];
  if (
    operation["x-pagination-policy"] !== undefined ||
    operation.parameters.some((parameter) => ["cursor", "limit"].includes(parameter.name))
  ) {
    failures.push("listDuplicateCandidates must remain bounded top-five and non-paginated");
  }
}

const relayDispatchExample = operationExamples.dispatchRepairAttemptToRelay;
const relayDispatchResource = {
  accountId: receiptAccountId,
  actorId: receiptActorId,
  projectId: relayDispatchExample.response.qaItem.id === createResponse.qaItem.id
    ? authorizedProjectId
    : authorizedProjectId,
  bugId: relayDispatchExample.response.qaItem.id,
  bugKey: relayDispatchExample.response.qaItem.key,
  attemptId: relayDispatchExample.response.repairAttemptId,
  handoffId: relayDispatchExample.response.handoffId,
  relayInstanceId: relayDispatchExample.response.relayInstanceId,
  attemptVersion: relayDispatchExample.request.expectedVersion,
  outboxMessageId: relayDispatchExample.response.outboxMessageId,
  requestId: relayDispatchExample.response.requestId,
  selectedAttachmentIds: structuredClone(relayDispatchExample.request.selectedAttachmentIds),
  selectedAttachmentFacts: relayDispatchExample.request.selectedAttachmentIds.map((attachmentId) => ({
    attachmentId,
    accountId: receiptAccountId,
    projectId: authorizedProjectId,
    bugId: relayDispatchExample.response.qaItem.id,
    scanStatus: "clean",
    bindingStatus: "claimed",
    durablyReadable: true,
  })),
};
const relayDispatchInput = {
  accountId: receiptAccountId,
  actorId: receiptActorId,
  authorizedProjectIds: [authorizedProjectId],
  mode: "dispatch",
  pathAttemptId: relayDispatchExample.pathParameters.attemptId,
  request: structuredClone(relayDispatchExample.request),
  response: structuredClone(relayDispatchExample.response),
  receiptFact: structuredClone(relayDispatchExample.response),
  resource: structuredClone(relayDispatchResource),
  exactReplay: false,
  outboxCommitted: true,
  idempotencyRecordCommitted: true,
  mutationCount: 1,
  idempotencyKey: "relay-dispatch-action-key",
};
relayDispatchInput.persistedIdempotencyKey = relayDispatchInput.idempotencyKey;
relayDispatchInput.canonicalRequestDigest = canonicalNonSecretRequestDigest(
  "dispatchRepairAttemptToRelay",
  {
    accountId: relayDispatchInput.accountId,
    actorId: relayDispatchInput.actorId,
    attemptId: relayDispatchResource.attemptId,
    projectId: relayDispatchResource.projectId,
  },
  relayDispatchInput.request,
  relayDispatchInput.idempotencyKey,
);
relayDispatchInput.persistedRequestDigest = relayDispatchInput.canonicalRequestDigest;
if (evaluateAppFirstBehavior("relay-receipt-identity", relayDispatchInput) !== "unambiguous") {
  failures.push("Relay dispatch response is not bound to its outbox/request/idempotency facts");
}
for (const [label, mutate] of [
  ["outbox id", (input) => (input.response.outboxMessageId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
  ["request id", (input) => (input.response.requestId = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
  ["status", (input) => (input.response.status = "submitted")],
  ["replay flag", (input) => (input.response.replayed = true)],
  ["idempotency key", (input) => (input.idempotencyKey = "different-relay-dispatch-key")],
]) {
  const input = structuredClone(relayDispatchInput);
  mutate(input);
  if (evaluateAppFirstBehavior("relay-receipt-identity", input) !== "ambiguous") {
    failures.push(`Relay dispatch receipt mutation ${label} was accepted`);
  }
}
{
  const input = structuredClone(relayDispatchInput);
  input.exactReplay = true;
  input.response.replayed = true;
  input.receiptFact = structuredClone(input.response);
  input.persistedResponse = structuredClone(input.response);
  input.originalEffectCommitted = true;
  input.mutationCount = 0;
  if (evaluateAppFirstBehavior("relay-receipt-identity", input) !== "unambiguous") {
    failures.push("Relay dispatch exact replay did not return its persisted receipt");
  }
  input.request.selectedAttachmentIds = [];
  if (evaluateAppFirstBehavior("relay-receipt-identity", input) !== "ambiguous") {
    failures.push("Relay dispatch exact replay accepted a changed canonical request");
  }
}

const relayReceiptExample = operationExamples.getRelayReceipt;
const relayReceiptResource = {
  accountId: receiptAccountId,
  actorId: receiptActorId,
  projectId: authorizedProjectId,
  bugId: relayReceiptExample.response.qaItem.id,
  bugKey: relayReceiptExample.response.qaItem.key,
  attemptId: relayReceiptExample.response.repairAttemptId,
  handoffId: relayReceiptExample.response.handoffId,
  relayInstanceId: relayReceiptExample.response.relayInstanceId,
  handoffStatus: relayReceiptExample.response.handoffStatus,
  buildRequirement: relayReceiptExample.response.buildRequirement,
  buildEvidenceStatus: relayReceiptExample.response.buildEvidenceStatus,
  externalRevision: relayReceiptExample.response.externalRevision,
  deliveredCommitSha: relayReceiptExample.response.deliveredCommitSha,
  buildId: relayReceiptExample.response.buildId,
  relayTaskId: relayReceiptExample.response.relayTaskId,
  lastEventAt: relayReceiptExample.response.lastEventAt,
  failureSummary: relayReceiptExample.response.failureSummary,
  receiptVersion: relayReceiptExample.response.version,
};
const relayReceiptInput = {
  accountId: receiptAccountId,
  actorId: receiptActorId,
  authorizedProjectIds: [authorizedProjectId],
  mode: "receipt",
  pathAttemptId: relayReceiptExample.pathParameters.attemptId,
  response: structuredClone(relayReceiptExample.response),
  receiptFact: structuredClone(relayReceiptExample.response),
  resource: relayReceiptResource,
  buildFact: {
    buildId: relayReceiptExample.response.buildId,
    attemptId: relayReceiptExample.response.repairAttemptId,
    bugId: relayReceiptExample.response.qaItem.id,
    projectId: authorizedProjectId,
    status: "ready",
    sourceCommitSha: relayReceiptExample.response.deliveredCommitSha,
    manifestCommitShas: [relayReceiptExample.response.deliveredCommitSha],
  },
};
if (evaluateAppFirstBehavior("relay-receipt-identity", relayReceiptInput) !== "unambiguous") {
  failures.push("Relay GET receipt is not bound to canonical projection/build facts");
}
for (const [label, mutate] of [
  ["handoff status", (input) => (input.response.handoffStatus = "failed")],
  ["build evidence", (input) => (input.response.buildEvidenceStatus = "pending")],
  ["build id", (input) => (input.response.buildId = "ffffffff-ffff-4fff-8fff-fffffffffff3")],
  ["external revision", (input) => (input.response.externalRevision += 1)],
  ["commit", (input) => (input.response.deliveredCommitSha = "c".repeat(40))],
  ["version", (input) => (input.response.version += 1)],
  ["build manifest", (input) => (input.buildFact.manifestCommitShas = [])],
]) {
  const input = structuredClone(relayReceiptInput);
  mutate(input);
  if (evaluateAppFirstBehavior("relay-receipt-identity", input) !== "ambiguous") {
    failures.push(`Relay GET receipt mutation ${label} was accepted`);
  }
}

const readModelReceiptAccountId = "10000000-0000-4000-8000-000000000020";
const readModelReceiptActorId = "10000000-0000-4000-8000-000000000003";
{
  const example = operationExamples.listVisibleProjects;
  const session = structuredClone(operationExamples.getNativeSession.response);
  const query = structuredClone(example.query);
  const input = {
    operation: "projects",
    accountId: readModelReceiptAccountId,
    actorId: readModelReceiptActorId,
    session,
    query,
    authorizedProjectIds: session.projects
      .filter((project) => project.active === true)
      .map((project) => project.id),
    response: structuredClone(example.response),
    membershipFacts: example.response.items.map((project) => ({
      accountId: readModelReceiptAccountId,
      userId: readModelReceiptActorId,
      projectId: project.id,
      active: true,
      currentMembership: true,
      project: structuredClone(project),
    })),
  };
  attachSignedPageFacts(input, {
    operationId: "listVisibleProjects",
    query,
    response: input.response,
    normalizedFilters: {},
    orderedItemIds: input.response.items.map((project) => project.id),
    orderedSortKeys: input.response.items.map((project) => `${project.key}:${project.id}`),
    scope: { userId: input.actorId },
    limit: query.limit,
    membershipRevision: "membership-revision:projects:7",
  });
  if (evaluateAppFirstBehavior("read-model-receipt", input) !== "unambiguous") {
    failures.push("listVisibleProjects: current active membership page is ambiguous");
  }
  for (const [label, mutate] of [
    ["foreign account", (candidate) => (candidate.membershipFacts[0].accountId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
    ["foreign actor", (candidate) => (candidate.membershipFacts[0].userId = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
    ["inactive membership", (candidate) => (candidate.membershipFacts[0].active = false)],
    ["retired project", (candidate) => (candidate.response.items[0].active = false)],
    ["forged role", (candidate) => (candidate.response.items[0].roles = ["project_admin"])],
    ["foreign membership revision", (candidate) => (candidate.pageFact.membershipRevision = "membership-revision:foreign")],
    ["duplicate project id", (candidate) => {
      const duplicate = structuredClone(candidate.response.items[0]);
      duplicate.name = "Forged duplicate";
      candidate.response.items.push(duplicate);
      candidate.membershipFacts.push({
        ...structuredClone(candidate.membershipFacts[0]),
        project: structuredClone(duplicate),
      });
      candidate.pageFact.orderedItemIds.push(duplicate.id);
      candidate.pageFact.orderedSortKeys.push(`${duplicate.key}:${duplicate.id}`);
    }],
  ]) {
    const candidate = structuredClone(input);
    mutate(candidate);
    if (evaluateAppFirstBehavior("read-model-receipt", candidate) !== "ambiguous") {
      failures.push(`listVisibleProjects: ${label} was accepted`);
    }
  }
}
for (const [operation, operationId] of [
  ["members", "listProjectMembers"],
  ["modules", "listProjectModules"],
]) {
  const example = operationExamples[operationId];
  const input = {
    operation,
    accountId: readModelReceiptAccountId,
    actorId: readModelReceiptActorId,
    authorizedProjectIds: [example.pathParameters.projectId],
    pathProjectId: example.pathParameters.projectId,
    authorizedProjectId: example.pathParameters.projectId,
    query: structuredClone(example.query),
    response: structuredClone(example.response),
    itemFacts: example.response.items.map((item) => ({
      accountId: readModelReceiptAccountId,
      projectId: example.pathParameters.projectId,
      ...(operation === "members"
        ? {
            userId: item.userId,
            currentMembership: true,
            active: true,
            sameAccountUser: true,
            displayNameProjection: item.displayName,
            currentRoles: structuredClone(item.roles),
          }
        : { moduleId: item.id, currentActive: item.active }),
      item: structuredClone(item),
    })),
  };
  if (operation === "members") {
    attachSignedPageFacts(input, {
      operationId,
      query: input.query,
      response: input.response,
      normalizedFilters: {},
      orderedItemIds: input.response.items.map((item) => item.userId),
      orderedSortKeys: input.response.items.map(
        (item) => `${item.displayName.toLowerCase()}:${item.userId}`,
      ),
      scope: { projectId: input.pathProjectId },
      limit: input.query.limit,
      membershipRevision: "membership-revision:members:7",
    });
  } else {
    input.membershipRevision = "membership-revision:modules:7";
  }
  input.projectAuthorizationFact = {
    accountId: input.accountId,
    actorId: input.actorId,
    projectId: input.pathProjectId,
    membershipRevision: input.membershipRevision,
    currentActive: true,
  };
  if (evaluateAppFirstBehavior("read-model-receipt", input) !== "unambiguous") {
    failures.push(`${operationId}: server-owned item receipt is ambiguous`);
  }
  const forged = structuredClone(input);
  if (operation === "members") forged.response.items[0].roles = ["project_admin"];
  else forged.response.items[0].name = "Forged module";
  if (evaluateAppFirstBehavior("read-model-receipt", forged) !== "ambiguous") {
    failures.push(`${operationId}: forged server-owned item was accepted`);
  }
  for (const [label, mutate] of
    operation === "members"
      ? [
          ["foreign member", (candidate) => {
            const foreignUserId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
            candidate.response.items[0].userId = foreignUserId;
            candidate.itemFacts[0].userId = foreignUserId;
            candidate.itemFacts[0].item.userId = foreignUserId;
            candidate.itemFacts[0].sameAccountUser = false;
            candidate.pageFact.orderedItemIds[0] = foreignUserId;
            candidate.pageFact.orderedSortKeys[0] =
              `${candidate.response.items[0].displayName.toLowerCase()}:${foreignUserId}`;
          }],
          ["inactive member", (candidate) => {
            candidate.response.items[0].active = false;
            candidate.itemFacts[0].item.active = false;
            candidate.itemFacts[0].active = false;
          }],
          ["missing member fact", (candidate) => (candidate.itemFacts = [])],
          ["revoked page membership", (candidate) =>
            (candidate.pageAuthorizationFacts[0].currentActive = false)],
        ]
      : [
          ["foreign module authorization", (candidate) =>
            (candidate.projectAuthorizationFact.currentActive = false)],
          ["missing module fact", (candidate) => (candidate.itemFacts = [])],
          ["foreign module fact", (candidate) =>
            (candidate.itemFacts[0].accountId = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
        ]) {
    const candidate = structuredClone(input);
    mutate(candidate);
    if (evaluateAppFirstBehavior("read-model-receipt", candidate) !== "ambiguous") {
      failures.push(`${operationId}: ${label} was accepted`);
    }
  }
}
{
  const example = operationExamples.listProjectBuilds;
  const input = {
    operation: "builds",
    accountId: readModelReceiptAccountId,
    actorId: readModelReceiptActorId,
    authorizedProjectIds: [example.pathParameters.projectId],
    pathProjectId: example.pathParameters.projectId,
    authorizedProjectId: example.pathParameters.projectId,
    query: structuredClone(example.query),
    response: structuredClone(example.response),
    itemFacts: example.response.items.map((build) => ({
      accountId: readModelReceiptAccountId,
      projectId: example.pathParameters.projectId,
      buildId: build.id,
      build: structuredClone(build),
    })),
  };
  const attachBuildPage = (candidate, membershipRevision = "membership-revision:builds:12") =>
    attachSignedPageFacts(candidate, {
      operationId: "listProjectBuilds",
      query: candidate.query,
      response: candidate.response,
      normalizedFilters: { status: candidate.query.status ?? null },
      orderedItemIds: candidate.response.items.map((build) => build.id),
      orderedSortKeys: candidate.response.items.map((build) => build.id),
      scope: { projectId: candidate.pathProjectId },
      limit: candidate.query.limit,
      membershipRevision,
    });
  attachBuildPage(input);
  if (evaluateAppFirstBehavior("read-model-receipt", input) !== "unambiguous") {
    failures.push("listProjectBuilds: current project Build page is ambiguous");
  }
  {
    const cursorPage = structuredClone(input);
    cursorPage.query.cursor = "signed-build-page-cursor";
    attachBuildPage(cursorPage);
    if (evaluateAppFirstBehavior("read-model-receipt", cursorPage) !== "unambiguous") {
      failures.push("listProjectBuilds: valid signed continuation cursor was rejected");
    }
    for (const [label, mutate] of [
      ["unsigned cursor", (candidate) => (candidate.cursorFact.signatureValid = false)],
      ["foreign cursor actor", (candidate) => (candidate.cursorFact.actorId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
      ["foreign cursor snapshot", (candidate) => (candidate.cursorFact.snapshotSequence += 1)],
      ["non-progressing cursor", (candidate) => (candidate.cursorFact.lastSortKey = candidate.response.items[0].id)],
    ]) {
      const candidate = structuredClone(cursorPage);
      mutate(candidate);
      if (evaluateAppFirstBehavior("read-model-receipt", candidate) !== "ambiguous") {
        failures.push(`listProjectBuilds: ${label} was accepted`);
      }
    }
  }
  for (const [label, mutate] of [
    ["foreign Build project", (candidate) => {
      candidate.response.items[0].projectId = "ffffffff-ffff-4fff-8fff-fffffffffff2";
      candidate.itemFacts[0].projectId = candidate.response.items[0].projectId;
      candidate.itemFacts[0].build.projectId = candidate.response.items[0].projectId;
    }],
    ["forged Build", (candidate) => (candidate.response.items[0].sourceCommitSha = "b".repeat(40))],
    ["inactive membership", (candidate) => (candidate.pageAuthorizationFacts[0].currentActive = false)],
    ["duplicate Build", (candidate) => {
      candidate.response.items.push(structuredClone(candidate.response.items[0]));
      candidate.itemFacts.push(structuredClone(candidate.itemFacts[0]));
    }],
    ["ignored status filter", (candidate) => (candidate.query.status = "failed")],
  ]) {
    const candidate = structuredClone(input);
    mutate(candidate);
    if (evaluateAppFirstBehavior("read-model-receipt", candidate) !== "ambiguous") {
      failures.push(`listProjectBuilds: ${label} was accepted`);
    }
  }
}
const receiptBugResource = {
  accountId: readModelReceiptAccountId,
  actorId: readModelReceiptActorId,
  projectId: operationExamples.getBug.response.projectId,
  bugId: operationExamples.getBug.response.id,
};
{
  const example = operationExamples.listBugComments;
  const input = {
    operation: "comments",
    accountId: readModelReceiptAccountId,
    actorId: readModelReceiptActorId,
    authorizedProjectIds: [receiptBugResource.projectId],
    query: structuredClone(example.query),
    pathBugId: example.pathParameters.bugId,
    bugResource: structuredClone(receiptBugResource),
    response: structuredClone(example.response),
    commentFacts: example.response.items.map((item) => ({
      accountId: readModelReceiptAccountId,
      projectId: example.response.projectId,
      bugId: example.response.bugId,
      commentId: item.id,
      relationValidated: true,
      authorFact: {
        accountId: readModelReceiptAccountId,
        projectId: example.response.projectId,
        userId: item.authorId,
        sameAccountUser: true,
        identityValidated: true,
      },
      attachmentFacts: item.attachmentIds.map((attachmentId) => ({
        accountId: readModelReceiptAccountId,
        projectId: example.response.projectId,
        bugId: example.response.bugId,
        attachmentId,
        claimedByBug: true,
        visibleToActor: true,
        relationValidated: true,
      })),
      item: structuredClone(item),
    })),
  };
  attachSignedPageFacts(input, {
    operationId: "listBugComments",
    query: input.query,
    response: input.response,
    normalizedFilters: {},
    orderedItemIds: input.response.items.map((item) => item.id),
    orderedSortKeys: input.response.items.map(
      (item) => `${contractAscendingDateSortKey(item.createdAt)}:${item.id}`,
    ),
    scope: { bugId: input.bugResource.bugId, projectId: input.bugResource.projectId },
    limit: input.query.limit,
    membershipRevision: "membership-revision:comments:12",
  });
  if (evaluateAppFirstBehavior("read-model-receipt", input) !== "unambiguous") {
    failures.push("listBugComments: server-owned comment receipt is ambiguous");
  }
  const forged = structuredClone(input);
  forged.response.items[0].body = "Forged comment";
  if (evaluateAppFirstBehavior("read-model-receipt", forged) !== "ambiguous") {
    failures.push("listBugComments: forged comment was accepted");
  }
  for (const [label, mutate] of [
    ["foreign author", (candidate) => {
      const foreignUserId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
      candidate.response.items[0].authorId = foreignUserId;
      candidate.commentFacts[0].item.authorId = foreignUserId;
      candidate.commentFacts[0].authorFact.userId = foreignUserId;
      candidate.commentFacts[0].authorFact.sameAccountUser = false;
    }],
    ["foreign attachment", (candidate) => {
      const attachmentId = "ffffffff-ffff-4fff-8fff-fffffffffff2";
      candidate.response.items[0].attachmentIds.push(attachmentId);
      candidate.commentFacts[0].item.attachmentIds.push(attachmentId);
      candidate.commentFacts[0].attachmentFacts.push({
        accountId: candidate.accountId,
        projectId: candidate.bugResource.projectId,
        bugId: candidate.bugResource.bugId,
        attachmentId,
        claimedByBug: false,
        visibleToActor: false,
        relationValidated: false,
      });
    }],
    ["missing comment fact", (candidate) => (candidate.commentFacts = [])],
    ["revoked page membership", (candidate) =>
      (candidate.pageAuthorizationFacts[0].currentActive = false)],
  ]) {
    const candidate = structuredClone(input);
    mutate(candidate);
    if (evaluateAppFirstBehavior("read-model-receipt", candidate) !== "ambiguous") {
      failures.push(`listBugComments: ${label} was accepted`);
    }
  }
}
{
  const example = operationExamples.listBugAttachments;
  const input = {
    operation: "attachments",
    accountId: readModelReceiptAccountId,
    actorId: readModelReceiptActorId,
    authorizedProjectIds: [receiptBugResource.projectId],
    query: structuredClone(example.query),
    pathBugId: example.pathParameters.bugId,
    bugResource: structuredClone(receiptBugResource),
    response: structuredClone(example.response),
    attachmentFacts: example.response.items.map((item) => ({
      accountId: readModelReceiptAccountId,
      attachmentId: item.attachmentId,
      bugId: example.response.bugId,
      projectId: example.response.projectId,
      claimId: "50000000-0000-4000-8000-000000000099",
      claimRelationValidated: true,
      currentVisible: true,
      durablyReadable: true,
      item: structuredClone(item),
    })),
  };
  attachSignedPageFacts(input, {
    operationId: "listBugAttachments",
    query: input.query,
    response: input.response,
    normalizedFilters: {},
    orderedItemIds: input.response.items.map((item) => item.attachmentId),
    orderedSortKeys: input.response.items.map((item) => item.attachmentId),
    scope: { bugId: input.bugResource.bugId, projectId: input.bugResource.projectId },
    limit: input.query.limit,
    membershipRevision: "membership-revision:attachments:12",
  });
  if (evaluateAppFirstBehavior("read-model-receipt", input) !== "unambiguous") {
    failures.push("listBugAttachments: server-owned attachment receipt is ambiguous");
  }
  const forged = structuredClone(input);
  forged.response.items[0].filename = "forged.exe";
  if (evaluateAppFirstBehavior("read-model-receipt", forged) !== "ambiguous") {
    failures.push("listBugAttachments: forged attachment metadata was accepted");
  }
  for (const [label, mutate] of [
    ["unclaimed attachment", (candidate) => {
      candidate.response.items[0].bindingStatus = "unbound";
      candidate.attachmentFacts[0].item.bindingStatus = "unbound";
    }],
    ["rejected attachment", (candidate) => {
      candidate.response.items[0].scanStatus = "rejected";
      candidate.response.items[0].readyToBind = false;
      candidate.attachmentFacts[0].item.scanStatus = "rejected";
      candidate.attachmentFacts[0].item.readyToBind = false;
    }],
    ["foreign attachment account", (candidate) =>
      (candidate.attachmentFacts[0].accountId = "ffffffff-ffff-4fff-8fff-fffffffffff3")],
    ["unvalidated claim", (candidate) =>
      (candidate.attachmentFacts[0].claimRelationValidated = false)],
    ["unreadable attachment", (candidate) =>
      (candidate.attachmentFacts[0].durablyReadable = false)],
    ["revoked page membership", (candidate) =>
      (candidate.pageAuthorizationFacts[0].currentActive = false)],
  ]) {
    const candidate = structuredClone(input);
    mutate(candidate);
    if (evaluateAppFirstBehavior("read-model-receipt", candidate) !== "ambiguous") {
      failures.push(`listBugAttachments: ${label} was accepted`);
    }
  }
}
{
  const example = operationExamples.getBugWorkflowProjection;
  const input = {
    operation: "workflow",
    accountId: readModelReceiptAccountId,
    actorId: readModelReceiptActorId,
    authorizedProjectIds: [receiptBugResource.projectId],
    query: structuredClone(example.query),
    pathBugId: example.pathParameters.bugId,
    bugResource: structuredClone(receiptBugResource),
    response: structuredClone(example.response),
    workflowFact: structuredClone(example.response),
    buildFacts: [],
    buildReferenceFacts: [],
  };
  input.workflowRelationFacts = makeWorkflowRelationFacts(input.response, {
    accountId: input.accountId,
    projectId: input.bugResource.projectId,
    bugId: input.bugResource.bugId,
  });
  attachWorkflowPageFacts(input, {
    query: input.query,
    response: input.response,
    collections: {
      occurrences: input.response.occurrences.map((item) => item.id),
      repairAttempts: input.response.repairAttempts.map((item) => item.id),
      verifications: input.response.verifications.map((item) => item.id),
      builds: input.response.builds.map((item) => item.id),
      relayReceipts: input.response.relayReceipts.map(
        (item) => `${item.repairAttemptId}:${item.handoffId}`,
      ),
    },
    scope: { bugId: input.bugResource.bugId, projectId: input.bugResource.projectId },
    limit: input.query.limitPerCollection,
    membershipRevision: "membership-revision:workflow:12",
  });
  if (evaluateAppFirstBehavior("read-model-receipt", input) !== "unambiguous") {
    failures.push("getBugWorkflowProjection: server-owned workflow receipt is ambiguous");
  }
  {
    const build = structuredClone(operationExamples.listProjectBuilds.response.items[0]);
    const repairAttempt = {
      id: "a0000000-0000-4000-8000-000000000001",
      bugId: input.response.bugId,
      sequence: 1,
      mode: "human",
      status: "planned",
      assigneeId: input.actorId,
      parentAttemptId: null,
      summary: null,
      branch: null,
      commitSha: null,
      mergeRequestUrl: null,
      targetBuildId: build.id,
      version: 1,
    };
    const verification = {
      id: "c0000000-0000-4000-8000-000000000001",
      bugId: input.response.bugId,
      repairAttemptId: repairAttempt.id,
      buildId: build.id,
      status: "requested",
      verifierId: input.actorId,
      criteriaSnapshot: "Verify the exact eligible Build on Android.",
      resultSummary: null,
      version: 1,
    };
    const relayReceipt = structuredClone(operationExamples.getRelayReceipt.response);
    const pageOne = structuredClone(input);
    pageOne.query = { cursor: null, limitPerCollection: 1 };
    pageOne.response.repairAttempts = [repairAttempt];
    pageOne.response.verifications = [verification];
    pageOne.response.builds = [build];
    pageOne.response.relayReceipts = [relayReceipt];
    pageOne.response.truncated = true;
    pageOne.response.nextCursor = "signed-workflow-page-2";
    pageOne.workflowFact = structuredClone(pageOne.response);
    pageOne.workflowRelationFacts = makeWorkflowRelationFacts(pageOne.response, {
      accountId: pageOne.accountId,
      projectId: pageOne.bugResource.projectId,
      bugId: pageOne.bugResource.bugId,
    });
    pageOne.buildReferenceFacts = makeWorkflowBuildReferenceFacts(pageOne.response, {
      accountId: pageOne.accountId,
      projectId: pageOne.bugResource.projectId,
      bugId: pageOne.bugResource.bugId,
    });
    pageOne.buildFacts = [{
      accountId: pageOne.accountId,
      projectId: pageOne.bugResource.projectId,
      bugId: pageOne.bugResource.bugId,
      buildId: build.id,
      build: structuredClone(build),
      relationValidated: true,
    }];
    const pageOneCollections = {
      occurrences: pageOne.response.occurrences.map((item) => item.id),
      repairAttempts: pageOne.response.repairAttempts.map((item) => item.id),
      verifications: pageOne.response.verifications.map((item) => item.id),
      builds: pageOne.response.builds.map((item) => item.id),
      relayReceipts: pageOne.response.relayReceipts.map(
        (item) => `${item.repairAttemptId}:${item.handoffId}`,
      ),
    };
    attachWorkflowPageFacts(pageOne, {
      query: pageOne.query,
      response: pageOne.response,
      collections: pageOneCollections,
      scope: { bugId: pageOne.bugResource.bugId, projectId: pageOne.bugResource.projectId },
      limit: 1,
      membershipRevision: "membership-revision:workflow:two-page",
      hasMore: {
        occurrences: true,
        repairAttempts: false,
        verifications: false,
        builds: false,
        relayReceipts: false,
      },
    });
    if (evaluateAppFirstBehavior("read-model-receipt", pageOne) !== "unambiguous") {
      failures.push("getBugWorkflowProjection: first multi-collection continuation page was rejected");
    }

    const pageTwo = structuredClone(pageOne);
    pageTwo.query = { cursor: pageOne.response.nextCursor, limitPerCollection: 1 };
    const continuedOccurrence = structuredClone(pageOne.response.occurrences[0]);
    continuedOccurrence.id = "80000000-0000-4000-8000-000000000002";
    continuedOccurrence.captureBundleId = "60000000-0000-4000-8000-000000000002";
    pageTwo.response.occurrences = [continuedOccurrence];
    pageTwo.response.repairAttempts = [];
    pageTwo.response.verifications = [];
    pageTwo.response.builds = [];
    pageTwo.response.relayReceipts = [];
    pageTwo.response.truncated = false;
    pageTwo.response.nextCursor = null;
    pageTwo.workflowFact = structuredClone(pageTwo.response);
    pageTwo.workflowRelationFacts = makeWorkflowRelationFacts(pageTwo.response, {
      accountId: pageTwo.accountId,
      projectId: pageTwo.bugResource.projectId,
      bugId: pageTwo.bugResource.bugId,
    });
    pageTwo.buildReferenceFacts = [];
    pageTwo.buildFacts = [];
    const pageTwoCollections = {
      occurrences: pageTwo.response.occurrences.map((item) => item.id),
      repairAttempts: [],
      verifications: [],
      builds: [],
      relayReceipts: [],
    };
    attachWorkflowPageFacts(pageTwo, {
      query: pageTwo.query,
      response: pageTwo.response,
      collections: pageTwoCollections,
      scope: { bugId: pageTwo.bugResource.bugId, projectId: pageTwo.bugResource.projectId },
      limit: 1,
      membershipRevision: "membership-revision:workflow:two-page",
      previousWatermarks: pageOne.nextCursorFact.lastSortKeys,
      previousHasMore: pageOne.nextCursorFact.hasMore,
      hasMore: {
        occurrences: false,
        repairAttempts: false,
        verifications: false,
        builds: false,
        relayReceipts: false,
      },
    });
    if (evaluateAppFirstBehavior("read-model-receipt", pageTwo) !== "unambiguous") {
      failures.push("getBugWorkflowProjection: occurrence continuation after a Relay row was rejected");
    }
    for (const [label, mutate] of [
      ["closed collection injection", (candidate) =>
        (candidate.cursorFact.hasMore.occurrences = false)],
      ["swapped collection watermark", (candidate) => {
        const occurrenceWatermark = candidate.cursorFact.lastSortKeys.occurrences;
        candidate.cursorFact.lastSortKeys.occurrences =
          candidate.cursorFact.lastSortKeys.relayReceipts;
        candidate.cursorFact.lastSortKeys.relayReceipts = occurrenceWatermark;
      }],
      ["unsigned workflow cursor", (candidate) =>
        (candidate.cursorFact.signatureValid = false)],
      ["non-authoritative collection page", (candidate) =>
        (candidate.collectionPageFacts.occurrences.queryExecuted = false)],
    ]) {
      const candidate = structuredClone(pageTwo);
      mutate(candidate);
      if (evaluateAppFirstBehavior("read-model-receipt", candidate) !== "ambiguous") {
        failures.push(`getBugWorkflowProjection: ${label} was accepted`);
      }
    }
    for (const [label, mutate] of [
      ["foreign repair assignee", (candidate) => {
        const fact = candidate.workflowRelationFacts.find(
          (entry) => entry.relationType === "assignee_user",
        );
        fact.sameAccountUser = false;
      }],
      ["foreign verification actor", (candidate) => {
        const fact = candidate.workflowRelationFacts.find(
          (entry) => entry.relationType === "verifier_user",
        );
        fact.projectIdentityValidated = false;
      }],
      ["foreign verification attempt", (candidate) => {
        const fact = candidate.workflowRelationFacts.find(
          (entry) =>
            entry.referrerType === "verification" && entry.relationType === "repair_attempt",
        );
        fact.sameBug = false;
      }],
      ["foreign Build reference", (candidate) =>
        (candidate.buildReferenceFacts[0].projectId =
          "ffffffff-ffff-4fff-8fff-fffffffffff4")],
    ]) {
      const candidate = structuredClone(pageOne);
      mutate(candidate);
      if (evaluateAppFirstBehavior("read-model-receipt", candidate) !== "ambiguous") {
        failures.push(`getBugWorkflowProjection: ${label} relation was accepted`);
      }
    }
  }
  for (const [label, mutate] of [
    ["duplicate occurrence id", (candidate) => {
      const duplicate = structuredClone(candidate.response.occurrences[0]);
      duplicate.actualBehavior = "Different body with the same durable identity";
      candidate.response.occurrences.push(duplicate);
    }],
    ["duplicate repair attempt id", (candidate) => {
      const id = "a0000000-0000-4000-8000-0000000000d1";
      candidate.response.repairAttempts.push(
        { id, bugId: candidate.response.bugId, status: "queued" },
        { id, bugId: candidate.response.bugId, status: "running" },
      );
    }],
    ["duplicate verification id", (candidate) => {
      const id = "a0000000-0000-4000-8000-0000000000d2";
      candidate.response.verifications.push(
        { id, bugId: candidate.response.bugId, repairAttemptId: "a0000000-0000-4000-8000-0000000000e1", status: "pending" },
        { id, bugId: candidate.response.bugId, repairAttemptId: "a0000000-0000-4000-8000-0000000000e1", status: "running" },
      );
    }],
    ["duplicate build id", (candidate) => {
      const id = "b0000000-0000-4000-8000-0000000000d3";
      candidate.response.builds.push({ id, status: "pending" }, { id, status: "ready" });
    }],
    ["duplicate relay receipt identity", (candidate) => {
      const repairAttemptId = "a0000000-0000-4000-8000-0000000000d4";
      const handoffId = "a0000000-0000-4000-8000-0000000000d5";
      candidate.response.relayReceipts.push(
        { repairAttemptId, handoffId, qaItem: { id: candidate.response.bugId }, handoffStatus: "running" },
        { repairAttemptId, handoffId, qaItem: { id: candidate.response.bugId }, handoffStatus: "failed" },
      );
    }],
  ]) {
    const candidate = structuredClone(input);
    mutate(candidate);
    candidate.workflowFact = structuredClone(candidate.response);
    if (evaluateAppFirstBehavior("read-model-receipt", candidate) !== "ambiguous") {
      failures.push(`getBugWorkflowProjection: ${label} was accepted`);
    }
  }
  for (const [label, relationType, field, invalidate] of [
    ["reporter", "reporter_user", "reporterId", (fact) => (fact.sameAccountUser = false)],
    ["capture", "capture_bundle", "captureBundleId", (fact) => (fact.ownedByBug = false)],
    ["attachment", "attachment", "attachmentIds", (fact) => (fact.claimedByBug = false)],
  ]) {
    const candidate = structuredClone(input);
    const foreignId = `ffffffff-ffff-4fff-8fff-fffffffffff${
      relationType === "reporter_user" ? "1" : relationType === "capture_bundle" ? "2" : "3"
    }`;
    if (field === "attachmentIds") candidate.response.occurrences[0].attachmentIds[0] = foreignId;
    else candidate.response.occurrences[0][field] = foreignId;
    candidate.workflowFact = structuredClone(candidate.response);
    const fact = candidate.workflowRelationFacts.find(
      (entry) => entry.relationType === relationType,
    );
    fact.entityId = foreignId;
    invalidate(fact);
    if (evaluateAppFirstBehavior("read-model-receipt", candidate) !== "ambiguous") {
      failures.push(`getBugWorkflowProjection: foreign occurrence ${label} relation was accepted`);
    }
  }
  {
    const candidate = structuredClone(input);
    const occurrence = candidate.response.occurrences[0];
    const buildId = "b0000000-0000-4000-8000-0000000000f3";
    occurrence.environment.buildId = buildId;
    const build = structuredClone(operationExamples.listProjectBuilds.response.items[0]);
    build.id = buildId;
    candidate.response.builds = [build];
    candidate.workflowFact = structuredClone(candidate.response);
    candidate.buildFacts = [{
      accountId: candidate.accountId,
      projectId: candidate.bugResource.projectId,
      bugId: candidate.bugResource.bugId,
      buildId,
      build: structuredClone(build),
      relationValidated: true,
    }];
    candidate.buildReferenceFacts = makeWorkflowBuildReferenceFacts(candidate.response, {
      accountId: candidate.accountId,
      projectId: candidate.bugResource.projectId,
      bugId: candidate.bugResource.bugId,
    });
    attachWorkflowPageFacts(candidate, {
      query: candidate.query,
      response: candidate.response,
      collections: {
        occurrences: candidate.response.occurrences.map((item) => item.id),
        repairAttempts: candidate.response.repairAttempts.map((item) => item.id),
        verifications: candidate.response.verifications.map((item) => item.id),
        builds: candidate.response.builds.map((item) => item.id),
        relayReceipts: candidate.response.relayReceipts.map(
          (item) => `${item.repairAttemptId}:${item.handoffId}`,
        ),
      },
      scope: {
        bugId: candidate.bugResource.bugId,
        projectId: candidate.bugResource.projectId,
      },
      limit: candidate.query.limitPerCollection,
      membershipRevision: "membership-revision:workflow:build",
    });
    if (evaluateAppFirstBehavior("read-model-receipt", candidate) !== "unambiguous") {
      failures.push("getBugWorkflowProjection: same-project occurrence Build relation was rejected");
    }
    for (const [label, mutate] of [
      ["missing occurrence Build fact", (receipt) => (receipt.buildReferenceFacts = [])],
      ["foreign occurrence Build account", (receipt) => (receipt.buildReferenceFacts[0].accountId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
      ["foreign occurrence Build project", (receipt) => (receipt.buildReferenceFacts[0].projectId = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
      ["foreign occurrence Build Bug", (receipt) => (receipt.buildReferenceFacts[0].bugId = "ffffffff-ffff-4fff-8fff-fffffffffff3")],
      ["swapped occurrence Build relation", (receipt) => (receipt.buildReferenceFacts[0].referrerId = "ffffffff-ffff-4fff-8fff-fffffffffff4")],
      ["unvalidated occurrence Build relation", (receipt) => (receipt.buildReferenceFacts[0].relationValidated = false)],
      ["extra occurrence Build fact", (receipt) => receipt.buildReferenceFacts.push({ ...structuredClone(receipt.buildReferenceFacts[0]), referrerId: "ffffffff-ffff-4fff-8fff-fffffffffff5" })],
    ]) {
      const receipt = structuredClone(candidate);
      mutate(receipt);
      if (evaluateAppFirstBehavior("read-model-receipt", receipt) !== "ambiguous") {
        failures.push(`getBugWorkflowProjection: ${label} was accepted`);
      }
    }
  }
}

{
  const example = operationExamples.listBugEvents;
  const query = structuredClone(example.query);
  const auditEntityTypeByField = {
    relatedBugId: "bug",
    repairAttemptId: "repair_attempt",
    buildId: "build",
    verificationId: "verification",
    attachmentId: "attachment",
    captureId: "capture",
    handoffId: "handoff",
    commentId: "comment",
    occurrenceId: "occurrence",
  };
  const makeAuditEventFact = (event) => ({
    accountId: readModelReceiptAccountId,
    projectId: example.response.projectId,
    bugId: example.response.bugId,
    eventId: event.id,
    projectionSource: "typed_facts",
    projectionRuleVersion: "1.0.0",
    rawDurablePayloadUsed: false,
    payloadRedactionApplied: true,
    sensitiveValueScanPassed: true,
    aggregateFact: {
      accountId: readModelReceiptAccountId,
      projectId: example.response.projectId,
      bugId: example.response.bugId,
      aggregateType: event.aggregate.type,
      aggregateId: event.aggregate.id,
      aggregateVersion: event.aggregate.version,
      relationValidated: true,
    },
    actorFact: {
      accountId: readModelReceiptAccountId,
      projectId: example.response.projectId,
      actorType: event.actor.type,
      actorId: event.actor.id,
      relationValidated: true,
    },
    payloadReferenceFacts: Object.entries(auditEntityTypeByField)
      .filter(([field]) => Object.hasOwn(event.payload, field))
      .map(([payloadField, entityType]) => ({
        payloadField,
        entityType,
        entityId: event.payload[payloadField],
        accountId: readModelReceiptAccountId,
        projectId: example.response.projectId,
        ownerBugId: example.response.bugId,
        relationValidated: true,
      })),
    authorityKind: "human_qa_action",
    humanActionAuthorized: true,
    humanVerificationAuthorityProof: null,
    event: structuredClone(event),
  });
  const input = {
    accountId: readModelReceiptAccountId,
    actorId: readModelReceiptActorId,
    authorizedProjectIds: [receiptBugResource.projectId],
    pathBugId: example.pathParameters.bugId,
    query,
    bugResource: structuredClone(receiptBugResource),
    response: structuredClone(example.response),
    eventFacts: example.response.items.map(makeAuditEventFact),
  };
  attachSignedPageFacts(input, {
    operationId: "listBugEvents",
    query,
    response: input.response,
    normalizedFilters: { afterSequence: query.afterSequence },
    orderedItemIds: input.response.items.map((event) => event.id),
    orderedSortKeys: input.response.items.map(
      (event) => `${String(event.sequence).padStart(16, "0")}:${event.id}`,
    ),
    scope: { bugId: input.response.bugId, projectId: input.response.projectId },
    limit: query.limit,
    membershipRevision: "membership-revision:audit-list:12",
  });
  input.pageFact.anchorAfterSequence = query.afterSequence;
  if (input.cursorFact) input.cursorFact.anchorAfterSequence = query.afterSequence;
  if (input.nextCursorFact) input.nextCursorFact.anchorAfterSequence = query.afterSequence;
  if (evaluateAppFirstBehavior("audit-list-receipt", input) !== "unambiguous") {
    failures.push("listBugEvents: native audit page is not bound to typed redacted server facts");
  }
  for (const [label, mutate] of [
    ["foreign project", (candidate) => (candidate.response.projectId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
    ["raw durable payload source", (candidate) => (candidate.eventFacts[0].rawDurablePayloadUsed = true)],
    ["wrong projection rule", (candidate) => (candidate.eventFacts[0].projectionRuleVersion = "0.9.0")],
    ["redaction not applied", (candidate) => (candidate.eventFacts[0].payloadRedactionApplied = false)],
    ["sensitive scan not passed", (candidate) => (candidate.eventFacts[0].sensitiveValueScanPassed = false)],
    ["cursor fact mismatch", (candidate) => (candidate.pageFact.cursor = "foreign-cursor")],
    ["sensitive projected text", (candidate) => {
      candidate.response.items[0].payload.summary = "Authorization: Bearer secret-token";
      candidate.eventFacts[0].event.payload.summary = candidate.response.items[0].payload.summary;
    }],
    ["duplicate event", (candidate) => {
      candidate.response.items.push(structuredClone(candidate.response.items[0]));
      candidate.eventFacts.push(structuredClone(candidate.eventFacts[0]));
      candidate.pageFact.orderedItemIds.push(candidate.response.items[0].id);
      candidate.pageFact.orderedSortKeys.push(
        `${String(candidate.response.items[0].sequence).padStart(16, "0")}:${candidate.response.items[0].id}`,
      );
    }],
  ]) {
    const candidate = structuredClone(input);
    mutate(candidate);
    if (evaluateAppFirstBehavior("audit-list-receipt", candidate) !== "ambiguous") {
      failures.push(`listBugEvents: audit receipt mutation ${label} was accepted`);
    }
  }
  {
    const pageOne = structuredClone(input);
    pageOne.query = { afterSequence: 5, cursor: null, limit: 1 };
    pageOne.response.items[0].sequence = 6;
    pageOne.response.nextCursor = "signed-audit-page-2";
    pageOne.eventFacts = [makeAuditEventFact(pageOne.response.items[0])];
    attachSignedPageFacts(pageOne, {
      operationId: "listBugEvents",
      query: pageOne.query,
      response: pageOne.response,
      normalizedFilters: { afterSequence: 5 },
      orderedItemIds: pageOne.response.items.map((event) => event.id),
      orderedSortKeys: pageOne.response.items.map(
        (event) => `${String(event.sequence).padStart(16, "0")}:${event.id}`,
      ),
      scope: { bugId: pageOne.response.bugId, projectId: pageOne.response.projectId },
      limit: 1,
      membershipRevision: "membership-revision:audit:two-page",
    });
    pageOne.pageFact.anchorAfterSequence = 5;
    pageOne.nextCursorFact.anchorAfterSequence = 5;
    if (evaluateAppFirstBehavior("audit-list-receipt", pageOne) !== "unambiguous") {
      failures.push("listBugEvents: non-zero anchor first page was rejected");
    }

    const pageTwo = structuredClone(pageOne);
    pageTwo.query = { afterSequence: 0, cursor: pageOne.response.nextCursor, limit: 1 };
    pageTwo.response.items[0].id = "90000000-0000-4000-8000-000000000002";
    pageTwo.response.items[0].sequence = 7;
    pageTwo.response.nextCursor = null;
    pageTwo.eventFacts = [makeAuditEventFact(pageTwo.response.items[0])];
    attachSignedPageFacts(pageTwo, {
      operationId: "listBugEvents",
      query: pageTwo.query,
      response: pageTwo.response,
      normalizedFilters: { afterSequence: 5 },
      orderedItemIds: pageTwo.response.items.map((event) => event.id),
      orderedSortKeys: pageTwo.response.items.map(
        (event) => `${String(event.sequence).padStart(16, "0")}:${event.id}`,
      ),
      scope: { bugId: pageTwo.response.bugId, projectId: pageTwo.response.projectId },
      limit: 1,
      membershipRevision: "membership-revision:audit:two-page",
      cursorLastSortKey: pageOne.nextCursorFact.lastSortKey,
    });
    pageTwo.pageFact.anchorAfterSequence = 5;
    pageTwo.cursorFact.anchorAfterSequence = 5;
    if (evaluateAppFirstBehavior("audit-list-receipt", pageTwo) !== "unambiguous") {
      failures.push("listBugEvents: signed continuation lost its non-zero anchor");
    }
    for (const [label, mutate] of [
      ["anchor tamper", (candidate) => (candidate.cursorFact.anchorAfterSequence = 4)],
      ["cursor signature", (candidate) => (candidate.cursorFact.signatureValid = false)],
      ["cursor membership", (candidate) =>
        (candidate.cursorFact.membershipRevision = "membership-revision:foreign")],
      ["cursor watermark", (candidate) =>
        (candidate.cursorFact.lastSortKey = candidate.pageFact.orderedSortKeys[0])],
    ]) {
      const candidate = structuredClone(pageTwo);
      mutate(candidate);
      if (evaluateAppFirstBehavior("audit-list-receipt", candidate) !== "ambiguous") {
        failures.push(`listBugEvents: ${label} was accepted`);
      }
    }
  }
  const validateNativeAuditEvent = ajv.getSchema(
    "https://qa-hub.local/contracts/1.1.0/app-first.schema.json#/$defs/nativeAuditEvent",
  );
  {
    const candidate = structuredClone(input);
    const event = candidate.response.items[0];
    event.type = "bug.closed";
    event.source = "qa_hub";
    event.fromState = "ready_for_verification";
    event.toState = "closed";
    event.payload.status = "closed";
    event.payload.verificationId = "12000000-0000-4000-8000-000000000001";
    candidate.eventFacts[0] = makeAuditEventFact(event);
    candidate.eventFacts[0].humanVerificationAuthorityProof = {
      accountId: input.accountId,
      projectId: input.response.projectId,
      bugId: input.response.bugId,
      verificationId: event.payload.verificationId,
      projectedStatus: "closed",
      verificationStatus: "passed",
      verifierActorType: "user",
      verifierActorId: event.actor.id,
      assignedVerifierId: event.actor.id,
      resultRecordedByHuman: true,
      relationValidated: true,
      closeAuthorized: true,
    };
    if (!validateNativeAuditEvent?.(event)) {
      failures.push("listBugEvents: valid human close event failed native audit schema");
    }
    if (evaluateAppFirstBehavior("audit-list-receipt", candidate) !== "unambiguous") {
      failures.push("listBugEvents: valid passed human Verification close proof was rejected");
    }
    {
      const noStatusProof = structuredClone(candidate);
      delete noStatusProof.response.items[0].payload.status;
      noStatusProof.eventFacts[0] = makeAuditEventFact(noStatusProof.response.items[0]);
      if (!validateNativeAuditEvent?.(noStatusProof.response.items[0])) {
        failures.push("listBugEvents: status-less human close adversary must remain schema-valid");
      }
      if (evaluateAppFirstBehavior("audit-list-receipt", noStatusProof) !== "ambiguous") {
        failures.push("listBugEvents: close without passed human Verification proof was accepted");
      }
    }
    candidate.eventFacts[0].humanVerificationAuthorityProof.verifierActorId =
      "ffffffff-ffff-4fff-8fff-fffffffffff2";
    if (evaluateAppFirstBehavior("audit-list-receipt", candidate) !== "ambiguous") {
      failures.push("listBugEvents: close proof from a different verifier was accepted");
    }
  }
  {
    const candidate = structuredClone(input);
    const event = candidate.response.items[0];
    event.type = "verification.result_recorded";
    event.source = "qa_hub";
    event.aggregate = {
      type: "verification",
      id: "12000000-0000-4000-8000-000000000001",
      version: 2,
    };
    event.fromState = null;
    event.toState = null;
    event.payload = {
      status: "passed",
      verificationId: event.aggregate.id,
      summary: "Human verification passed.",
    };
    candidate.eventFacts[0] = makeAuditEventFact(event);
    candidate.eventFacts[0].humanVerificationAuthorityProof = {
      accountId: input.accountId,
      projectId: input.response.projectId,
      bugId: input.response.bugId,
      verificationId: event.payload.verificationId,
      projectedStatus: "passed",
      verificationStatus: "passed",
      verifierActorType: "user",
      verifierActorId: event.actor.id,
      assignedVerifierId: event.actor.id,
      resultRecordedByHuman: true,
      relationValidated: true,
      closeAuthorized: false,
    };
    if (evaluateAppFirstBehavior("audit-list-receipt", candidate) !== "unambiguous") {
      failures.push("listBugEvents: canonical human Verification result proof was rejected");
    }
    {
      const missingResultIdentity = structuredClone(candidate);
      missingResultIdentity.response.items[0].payload = {
        summary: "Result omitted its typed identity and outcome.",
      };
      missingResultIdentity.eventFacts[0] = makeAuditEventFact(
        missingResultIdentity.response.items[0],
      );
      missingResultIdentity.eventFacts[0].humanVerificationAuthorityProof = {
        accountId: input.accountId,
        projectId: input.response.projectId,
        bugId: input.response.bugId,
        verifierActorType: "user",
        verifierActorId: missingResultIdentity.response.items[0].actor.id,
        assignedVerifierId: missingResultIdentity.response.items[0].actor.id,
        resultRecordedByHuman: true,
        relationValidated: true,
        closeAuthorized: false,
      };
      if (!validateNativeAuditEvent?.(missingResultIdentity.response.items[0])) {
        failures.push("listBugEvents: incomplete Verification result adversary must remain schema-valid");
      }
      if (evaluateAppFirstBehavior("audit-list-receipt", missingResultIdentity) !== "ambiguous") {
        failures.push("listBugEvents: Verification result without id/status was accepted");
      }
    }
    for (const [label, mutate] of [
      ["missing Verification proof", (receipt) => (receipt.eventFacts[0].humanVerificationAuthorityProof = null)],
      ["foreign Verification account", (receipt) => (receipt.eventFacts[0].humanVerificationAuthorityProof.accountId = "ffffffff-ffff-4fff-8fff-fffffffffff1")],
      ["unassigned verifier", (receipt) => (receipt.eventFacts[0].humanVerificationAuthorityProof.assignedVerifierId = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
      ["Verification status mismatch", (receipt) => (receipt.eventFacts[0].humanVerificationAuthorityProof.verificationStatus = "failed")],
      ["non-human result", (receipt) => (receipt.eventFacts[0].humanVerificationAuthorityProof.resultRecordedByHuman = false)],
    ]) {
      const receipt = structuredClone(candidate);
      mutate(receipt);
      if (evaluateAppFirstBehavior("audit-list-receipt", receipt) !== "ambiguous") {
        failures.push(`listBugEvents: ${label} was accepted`);
      }
    }
    {
      const alias = structuredClone(candidate);
      alias.response.items[0].type = "verification.passed";
      delete alias.response.items[0].payload.status;
      alias.eventFacts[0] = makeAuditEventFact(alias.response.items[0]);
      if (evaluateAppFirstBehavior("audit-list-receipt", alias) !== "ambiguous") {
        failures.push("listBugEvents: unknown verification.passed alias without proof was accepted");
      }
    }
  }
  {
    const candidate = structuredClone(input);
    const event = candidate.response.items[0];
    event.type = "bug.closed";
    event.source = "relay";
    event.actor = { type: "service", id: "10000000-0000-4000-8000-000000000099" };
    event.fromState = "ready_for_verification";
    event.toState = "closed";
    event.payload.status = "closed";
    event.payload.verificationId = "12000000-0000-4000-8000-000000000001";
    candidate.eventFacts[0] = makeAuditEventFact(event);
    if (validateNativeAuditEvent?.(event)) {
      failures.push("listBugEvents: Relay-authored Bug close remained schema-valid");
    }
    if (evaluateAppFirstBehavior("audit-list-receipt", candidate) !== "ambiguous") {
      failures.push("listBugEvents: Relay-authored Bug close passed executable authority policy");
    }
  }
  {
    const allowedMachine = structuredClone(input);
    const event = allowedMachine.response.items[0];
    event.type = "repair.running";
    event.source = "relay";
    event.actor = { type: "service", id: "10000000-0000-4000-8000-000000000099" };
    event.fromState = null;
    event.toState = null;
    event.payload = {
      summary: "Relay reports delivery progress only.",
      status: "running",
      repairAttemptId: "a0000000-0000-4000-8000-000000000001",
    };
    allowedMachine.eventFacts[0] = makeAuditEventFact(event);
    allowedMachine.eventFacts[0].authorityKind = "non_bug_projection";
    allowedMachine.eventFacts[0].humanActionAuthorized = false;
    if (evaluateAppFirstBehavior("audit-list-receipt", allowedMachine) !== "unambiguous") {
      failures.push("listBugEvents: allowlisted Relay delivery projection was rejected");
    }
    for (const [label, mutate] of [
      ["unknown machine action", (candidate) => {
        candidate.response.items[0].type = "qa.accepted";
        candidate.response.items[0].payload.status = "approved";
      }],
      ["misleading machine status", (candidate) =>
        (candidate.response.items[0].payload.status = "approved")],
      ["wrong source namespace", (candidate) => (candidate.response.items[0].source = "build")],
    ]) {
      const candidate = structuredClone(allowedMachine);
      mutate(candidate);
      candidate.eventFacts[0] = makeAuditEventFact(candidate.response.items[0]);
      candidate.eventFacts[0].authorityKind = "non_bug_projection";
      candidate.eventFacts[0].humanActionAuthorized = false;
      if (evaluateAppFirstBehavior("audit-list-receipt", candidate) !== "ambiguous") {
        failures.push(`listBugEvents: ${label} bypassed the machine action allowlist`);
      }
    }
  }
  {
    const candidate = structuredClone(input);
    candidate.response.items[0].actor.id = null;
    candidate.eventFacts[0] = makeAuditEventFact(candidate.response.items[0]);
    if (validateNativeAuditEvent?.(candidate.response.items[0])) {
      failures.push("listBugEvents: attributable user audit actor accepted a null id");
    }
    if (evaluateAppFirstBehavior("audit-list-receipt", candidate) !== "ambiguous") {
      failures.push("listBugEvents: null user actor passed executable receipt policy");
    }
  }
  for (const [payloadField, entityType] of Object.entries(auditEntityTypeByField)) {
    const candidate = structuredClone(input);
    const event = candidate.response.items[0];
    event.payload[payloadField] = "f0000000-0000-4000-8000-000000000001";
    candidate.eventFacts[0] = makeAuditEventFact(event);
    const relation = candidate.eventFacts[0].payloadReferenceFacts.find(
      (fact) => fact.payloadField === payloadField && fact.entityType === entityType,
    );
    relation.projectId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
    if (evaluateAppFirstBehavior("audit-list-receipt", candidate) !== "ambiguous") {
      failures.push(`listBugEvents: foreign ${payloadField} typed relation was accepted`);
    }
  }
  {
    const candidate = structuredClone(input);
    candidate.eventFacts[0].aggregateFact.projectId =
      "ffffffff-ffff-4fff-8fff-fffffffffff1";
    if (evaluateAppFirstBehavior("audit-list-receipt", candidate) !== "ambiguous") {
      failures.push("listBugEvents: foreign aggregate relation was accepted");
    }
  }
  {
    const subscription = {
      projectId: example.response.projectId,
      eventTypes: [example.response.items[0].type],
      afterDeliverySequence: 0,
      cursor: null,
      lastEventId: null,
    };
    const membershipRevision = "membership-revision:stream:12";
    const authorizedProjectIds = [example.response.projectId];
    const filterDigest = canonicalNonSecretRequestDigest(
      "streamEvents:filters",
      {
        accountId: readModelReceiptAccountId,
        actorId: readModelReceiptActorId,
      },
      { projectId: subscription.projectId, eventTypes: subscription.eventTypes },
      "filters",
    );
    const membershipSetDigest = canonicalNonSecretRequestDigest(
      "streamEvents:membership-set",
      {
        accountId: readModelReceiptAccountId,
        actorId: readModelReceiptActorId,
        membershipRevision,
      },
      [...authorizedProjectIds].sort(),
      "membership",
    );
    const streamInput = {
      accountId: readModelReceiptAccountId,
      actorId: readModelReceiptActorId,
      membershipRevision,
      authorizedProjectIds,
      subscription,
      frames: example.response.items.map((event, index) => ({
        id: `signed-sse-cursor-${index + 1}`,
        deliverySequence: index + 1,
        eventName: "qa.audit",
        serializedData: canonicalString(event),
        data: structuredClone(event),
      })),
      heartbeatFrames: [{ type: "comment", id: null, deliverySequence: null, comment: "keepalive" }],
      eventFacts: example.response.items.map(makeAuditEventFact),
      frameAuthorizationFacts: example.response.items.map((event, index) => ({
        accountId: readModelReceiptAccountId,
        actorId: readModelReceiptActorId,
        projectId: event.projectId,
        bugId: event.bugId,
        eventId: event.id,
        frameToken: `signed-sse-cursor-${index + 1}`,
        frameCursorSignatureValid: true,
        deliverySequence: index + 1,
        membershipRevision,
        membershipSetDigest,
        filterDigest,
        currentMembershipActive: true,
        visibleToActor: true,
        membershipCheckedAtEmit: true,
      })),
      resumeFact: {
        accountId: readModelReceiptAccountId,
        actorId: readModelReceiptActorId,
        membershipRevision,
        membershipSetDigest,
        cursor: null,
        lastEventId: null,
        lastDeliverySequence: 0,
        retentionFloorDeliverySequence: 0,
        currentHighWaterDeliverySequence: 100,
        filterDigest,
        signatureValid: true,
      },
      streamFact: {
        accountId: readModelReceiptAccountId,
        actorId: readModelReceiptActorId,
        membershipRevision,
        membershipSetDigest,
        filterDigest,
        retentionFloorDeliverySequence: 0,
        currentHighWaterDeliverySequence: 100,
        authorizationCheckedAtOpen: true,
        membershipRecheckedPerFrame: true,
        orderedEventIds: example.response.items.map((event) => event.id),
        orderedFrameTokens: example.response.items.map(
          (_event, index) => `signed-sse-cursor-${index + 1}`,
        ),
        deliverySequences: example.response.items.map((_event, index) => index + 1),
      },
    };
    if (evaluateAppFirstBehavior("audit-stream-receipt", streamInput) !== "unambiguous") {
      failures.push("streamEvents: authorized Bug-owned SSE receipt is ambiguous");
    }
    {
      const candidate = structuredClone(streamInput);
      const secondEvent = structuredClone(candidate.frames[0].data);
      secondEvent.id = "90000000-0000-4000-8000-000000000002";
      secondEvent.bugId = "70000000-0000-4000-8000-000000000002";
      secondEvent.aggregate.id = secondEvent.bugId;
      secondEvent.sequence = 1;
      secondEvent.payload.occurrenceId = "80000000-0000-4000-8000-000000000002";
      const secondFact = makeAuditEventFact(secondEvent);
      secondFact.bugId = secondEvent.bugId;
      secondFact.aggregateFact.bugId = secondEvent.bugId;
      secondFact.aggregateFact.aggregateId = secondEvent.aggregate.id;
      secondFact.payloadReferenceFacts.forEach((fact) => {
        fact.ownerBugId = secondEvent.bugId;
      });
      candidate.frames.push({
        id: "signed-sse-cursor-2",
        deliverySequence: 2,
        eventName: "qa.audit",
        serializedData: canonicalString(secondEvent),
        data: secondEvent,
      });
      candidate.eventFacts.push(secondFact);
      candidate.frameAuthorizationFacts.push({
        accountId: candidate.accountId,
        actorId: candidate.actorId,
        projectId: secondEvent.projectId,
        bugId: secondEvent.bugId,
        eventId: secondEvent.id,
        frameToken: "signed-sse-cursor-2",
        frameCursorSignatureValid: true,
        deliverySequence: 2,
        membershipRevision,
        membershipSetDigest,
        filterDigest,
        currentMembershipActive: true,
        visibleToActor: true,
        membershipCheckedAtEmit: true,
      });
      candidate.streamFact.orderedEventIds.push(secondEvent.id);
      candidate.streamFact.orderedFrameTokens.push("signed-sse-cursor-2");
      candidate.streamFact.deliverySequences.push(2);
      if (evaluateAppFirstBehavior("audit-stream-receipt", candidate) !== "unambiguous") {
        failures.push("streamEvents: two Bugs with local sequence 1 did not use independent deliverySequence ordering");
      }
    }
    for (const [label, mutate] of [
      ["foreign project event", (candidate) => {
        candidate.frames[0].data.projectId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
        candidate.frameAuthorizationFacts[0].projectId = candidate.frames[0].data.projectId;
        candidate.eventFacts[0].projectId = candidate.frames[0].data.projectId;
        candidate.eventFacts[0].event = structuredClone(candidate.frames[0].data);
      }],
      ["membership revoked at emit", (candidate) => (candidate.frameAuthorizationFacts[0].currentMembershipActive = false)],
      ["cursor actor mismatch", (candidate) => (candidate.resumeFact.actorId = "ffffffff-ffff-4fff-8fff-fffffffffff2")],
      ["membership revision mismatch", (candidate) => (candidate.frameAuthorizationFacts[0].membershipRevision = "membership-revision:foreign")],
      ["membership set mismatch", (candidate) => (candidate.streamFact.membershipSetDigest = "foreign-membership-digest")],
      ["event id used as frame cursor", (candidate) => (candidate.frames[0].id = candidate.frames[0].data.id)],
      ["frame filter scope mismatch", (candidate) => (candidate.frameAuthorizationFacts[0].filterDigest = "foreign-filter-digest")],
      ["heartbeat SSE injection", (candidate) => {
        candidate.heartbeatFrames[0].comment = "ok\nid: forged";
        candidate.heartbeatFrames[0].data = candidate.frames[0].data;
      }],
      ["delivery above high-water", (candidate) => (candidate.frames[0].deliverySequence = 101)],
      ["filter mismatch", (candidate) => (candidate.frames[0].data.type = "comment.added")],
      ["Relay-authored close", (candidate) => {
        const event = candidate.frames[0].data;
        event.type = "bug.closed";
        event.source = "relay";
        event.actor = { type: "service", id: "10000000-0000-4000-8000-000000000099" };
        event.fromState = "ready_for_verification";
        event.toState = "closed";
        event.payload.status = "closed";
        event.payload.verificationId = "12000000-0000-4000-8000-000000000001";
        candidate.eventFacts[0] = makeAuditEventFact(event);
      }],
    ]) {
      const candidate = structuredClone(streamInput);
      mutate(candidate);
      if (evaluateAppFirstBehavior("audit-stream-receipt", candidate) !== "ambiguous") {
        failures.push(`streamEvents: ${label} was accepted`);
      }
    }
    for (const resumeField of ["cursor", "lastEventId"]) {
      const candidate = structuredClone(streamInput);
      candidate.subscription.afterDeliverySequence = null;
      candidate.subscription[resumeField] = "signed-resume-token";
      candidate.resumeFact[resumeField] = "signed-resume-token";
      candidate.resumeFact.lastDeliverySequence = 41;
      candidate.frames[0].deliverySequence = 42;
      candidate.frameAuthorizationFacts[0].deliverySequence = 42;
      candidate.streamFact.deliverySequences = [42];
      if (evaluateAppFirstBehavior("audit-stream-receipt", candidate) !== "unambiguous") {
        failures.push(`streamEvents: ${resumeField} resume token was rejected`);
      }
    }
    {
      const candidate = structuredClone(streamInput);
      candidate.subscription.cursor = "cursor-token";
      if (evaluateAppFirstBehavior("audit-stream-receipt", candidate) !== "ambiguous") {
        failures.push("streamEvents: resume token and direct delivery sequence were accepted together");
      }
    }
    {
      const candidate = structuredClone(streamInput);
      candidate.subscription.cursor = "cursor-token";
      candidate.subscription.lastEventId = "last-event-token";
      if (evaluateAppFirstBehavior("audit-stream-receipt", candidate) !== "ambiguous") {
        failures.push("streamEvents: cursor and Last-Event-ID were accepted together");
      }
    }
    {
      const candidate = structuredClone(streamInput);
      candidate.resumeFact.retentionFloorDeliverySequence = 10;
      candidate.streamFact.retentionFloorDeliverySequence = 10;
      if (evaluateAppFirstBehavior("audit-stream-receipt", candidate) !== "ambiguous") {
        failures.push("streamEvents: resume below the retention floor was accepted");
      }
    }
    {
      const candidate = structuredClone(streamInput);
      candidate.authorizedProjectIds.push("ffffffff-ffff-4fff-8fff-fffffffffff1");
      if (evaluateAppFirstBehavior("audit-stream-receipt", candidate) !== "ambiguous") {
        failures.push("streamEvents: changed membership set reused an old bound receipt");
      }
    }
    {
      const candidate = structuredClone(streamInput);
      candidate.accountId = undefined;
      candidate.resumeFact.accountId = undefined;
      candidate.streamFact.accountId = undefined;
      candidate.frameAuthorizationFacts[0].accountId = undefined;
      if (evaluateAppFirstBehavior("audit-stream-receipt", candidate) !== "ambiguous") {
        failures.push("streamEvents: missing authenticated account was accepted");
      }
    }
    {
      const candidate = structuredClone(streamInput);
      candidate.actorId = undefined;
      candidate.resumeFact.actorId = undefined;
      candidate.streamFact.actorId = undefined;
      candidate.frameAuthorizationFacts[0].actorId = undefined;
      if (evaluateAppFirstBehavior("audit-stream-receipt", candidate) !== "ambiguous") {
        failures.push("streamEvents: missing authenticated actor was accepted");
      }
    }
    {
      const emptyAuthorizedStream = {
        accountId: readModelReceiptAccountId,
        actorId: readModelReceiptActorId,
        membershipRevision: "membership-revision:empty",
        authorizedProjectIds: [],
        subscription: {
          projectId: null,
          eventTypes: [],
          afterDeliverySequence: 0,
          cursor: null,
          lastEventId: null,
        },
        frames: [],
        heartbeatFrames: [],
        eventFacts: [],
        frameAuthorizationFacts: [],
      };
      const emptyFilterDigest = canonicalNonSecretRequestDigest(
        "streamEvents:filters",
        { accountId: emptyAuthorizedStream.accountId, actorId: emptyAuthorizedStream.actorId },
        { projectId: null, eventTypes: [] },
        "filters",
      );
      const emptyMembershipSetDigest = canonicalNonSecretRequestDigest(
        "streamEvents:membership-set",
        {
          accountId: emptyAuthorizedStream.accountId,
          actorId: emptyAuthorizedStream.actorId,
          membershipRevision: emptyAuthorizedStream.membershipRevision,
        },
        [],
        "membership",
      );
      emptyAuthorizedStream.resumeFact = {
        accountId: emptyAuthorizedStream.accountId,
        actorId: emptyAuthorizedStream.actorId,
        membershipRevision: emptyAuthorizedStream.membershipRevision,
        membershipSetDigest: emptyMembershipSetDigest,
        cursor: null,
        lastEventId: null,
        lastDeliverySequence: 0,
        retentionFloorDeliverySequence: 0,
        currentHighWaterDeliverySequence: 0,
        filterDigest: emptyFilterDigest,
        signatureValid: true,
      };
      emptyAuthorizedStream.streamFact = {
        accountId: emptyAuthorizedStream.accountId,
        actorId: emptyAuthorizedStream.actorId,
        membershipRevision: emptyAuthorizedStream.membershipRevision,
        membershipSetDigest: emptyMembershipSetDigest,
        filterDigest: emptyFilterDigest,
        retentionFloorDeliverySequence: 0,
        currentHighWaterDeliverySequence: 0,
        authorizationCheckedAtOpen: true,
        membershipRecheckedPerFrame: true,
        orderedEventIds: [],
        orderedFrameTokens: [],
        deliverySequences: [],
      };
      if (evaluateAppFirstBehavior("audit-stream-receipt", emptyAuthorizedStream) !== "unambiguous") {
        failures.push("streamEvents: authenticated empty-membership stream was rejected");
      }
    }
  }
  const schemaValidButOversizedPayload = {
    summary: "\0".repeat(2_000),
    reason: "bounded reason",
  };
  const validateAuditPayload = ajv.getSchema(
    "https://qa-hub.local/contracts/1.1.0/app-first.schema.json#/$defs/nativeAuditPayload",
  );
  if (!validateAuditPayload?.(schemaValidButOversizedPayload)) {
    failures.push("Audit UTF-8 adversary must remain schema-valid to exercise the byte cap");
  }
  if (
    evaluateAppFirstBehavior("audit-payload", {
      payload: schemaValidButOversizedPayload,
    }) !== "invalid"
  ) {
    failures.push("Schema-valid audit payload above the actual UTF-8 cap was accepted");
  }
  for (const summary of [
    "apiKey=supersecret",
    "x-api-key: abc123",
    '{"password":"secret"}',
    "client_secret=abc123",
    "private-key: abc123",
  ]) {
    if (
      evaluateAppFirstBehavior("audit-payload", { payload: { summary } }) !== "invalid"
    ) {
      failures.push(`Sensitive audit summary was accepted: ${summary}`);
    }
  }
  const uuidV7 = "11111111-1111-7111-8111-111111111111";
  if (
    evaluateAppFirstBehavior("audit-payload", {
      payload: { relatedBugId: uuidV7 },
    }) !== "valid"
  ) {
    failures.push("Audit payload rejected the plan-mandated RFC 9562 UUIDv7 identity");
  }
  for (const invalidUuid of [
    "11111111-1111-0111-8111-111111111111",
    "11111111-1111-9111-8111-111111111111",
    "11111111-1111-7111-7111-111111111111",
    "not-a-uuid",
  ]) {
    if (
      evaluateAppFirstBehavior("audit-payload", {
        payload: { relatedBugId: invalidUuid },
      }) !== "invalid"
    ) {
      failures.push(`Audit payload accepted a non-RFC9562 UUID identity: ${invalidUuid}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `App-first contract check passed: ${baseSchemaNames.length} frozen base schemas + 1 versioned schema, ${criticalScenarios.scenarios.length} payload scenarios, ${behaviorMatrix.requiredBaseScenarioIds.length} inherited + ${behaviorMatrix.scenarios.length} new behavior scenarios, ${baseManifest.operations.length} base + ${manifest.operations.length} new OpenAPI operations, ${combinedErrors.length} error codes.`,
  );
}
