import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import SwaggerParser from "@apidevtools/swagger-parser";
import { validateIntegrationSemantics } from "../src/validate-integration-semantics.mjs";
import { evaluateContractBehavior } from "../src/evaluate-contract-behavior.mjs";

const contractRoot = fileURLToPath(new URL("..", import.meta.url));

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(contractRoot, relativePath), "utf8"));
}

const schemaPaths = [
  "schemas/common.schema.json",
  "schemas/bug.schema.json",
  "schemas/event-envelope.schema.json",
  "schemas/relay.schema.json",
  "schemas/upload.schema.json",
  "schemas/workflow.schema.json",
  "schemas/build.schema.json",
  "schemas/notification.schema.json",
  "schemas/api.schema.json",
];

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  allowUnionTypes: true,
});
addFormats(ajv);

for (const schemaPath of schemaPaths) {
  ajv.addSchema(await readJson(schemaPath));
}

const failures = [];
const examples = await readJson("examples/critical-scenarios.json");
if (examples.scenarios.length !== 12) {
  failures.push(`Expected exactly 12 critical scenarios, found ${examples.scenarios.length}`);
}

const scenarioIds = new Set();
for (const scenario of examples.scenarios) {
  if (scenarioIds.has(scenario.id)) {
    failures.push(`Duplicate scenario id: ${scenario.id}`);
  }
  scenarioIds.add(scenario.id);

  const validate = ajv.getSchema(scenario.schema);
  if (!validate) {
    failures.push(`${scenario.id}: schema not found: ${scenario.schema}`);
    continue;
  }

  const valid = validate(scenario.payload);
  if (valid !== scenario.expectedValid) {
    failures.push(
      `${scenario.id}: expected valid=${scenario.expectedValid}, got ${valid}: ${ajv.errorsText(validate.errors)}`,
    );
  }
}

const behaviorMatrix = await readJson("semantics/behavior-scenarios.json");
if (behaviorMatrix.scenarios.length !== 12) {
  failures.push(
    `Expected exactly 12 executable behavior scenarios, found ${behaviorMatrix.scenarios.length}`,
  );
}
for (const scenario of behaviorMatrix.scenarios) {
  const actual = evaluateContractBehavior(scenario.kind, scenario.input);
  if (actual !== scenario.expected) {
    failures.push(
      `${scenario.id}: expected behavior ${scenario.expected}, got ${actual}`,
    );
  }
}

const invalidClose = examples.scenarios.find(
  (scenario) => scenario.id === "close-without-verification-is-rejected",
);
if (!invalidClose || invalidClose.expectedValid !== false) {
  failures.push("The no-verification closure rejection scenario is missing.");
}

const deliveredScenario = examples.scenarios.find(
  (scenario) => scenario.id === "relay-delivered-with-remote-proof",
);
const deliveredEvidence = deliveredScenario?.payload?.payload?.deliveryEvidence;
const integrationInvariants = await readJson("semantics/integration-invariants.json");
if (
  !deliveredEvidence ||
  deliveredEvidence.pushed !== true ||
  deliveredEvidence.verified !== true ||
  deliveredEvidence.commitSha !== deliveredEvidence.remoteSha
) {
  failures.push("The Relay delivered scenario lacks eligible remote delivery evidence.");
}

if (deliveredScenario) {
  const missingEvidence = structuredClone(deliveredScenario.payload);
  delete missingEvidence.payload.deliveryEvidence;
  const validateWebhook = ajv.getSchema(
    "https://qa-hub.local/contracts/relay.schema.json#/$defs/webhook",
  );
  if (validateWebhook(missingEvidence)) {
    failures.push("Relay turn.delivered unexpectedly validates without deliveryEvidence.");
  }

  const mismatchedEvidence = structuredClone(deliveredScenario.payload);
  mismatchedEvidence.payload.deliveryEvidence.remoteSha =
    "dddddddddddddddddddddddddddddddddddddddd";
  const mismatchViolations = validateIntegrationSemantics(
    mismatchedEvidence,
    integrationInvariants,
  );
  if (
    !mismatchViolations.some(
      (violation) => violation.errorCode === "RELAY_DELIVERY_EVIDENCE_INVALID",
    )
  ) {
    failures.push("The executable semantic contract accepted mismatched Relay commit evidence.");
  }

  const eligibleViolations = validateIntegrationSemantics(
    deliveredScenario.payload,
    integrationInvariants,
  );
  if (eligibleViolations.length > 0) {
    failures.push(
      `Eligible Relay delivery failed semantic validation: ${JSON.stringify(eligibleViolations)}`,
    );
  }

  const buildCompleted = {
    ...structuredClone(deliveredScenario.payload),
    eventId: "0191f0d0-7b3a-7abc-8def-0123456789ab",
    deliveryId: "relay-main:event:0191f0d0-7b3a-7abc-8def-0123456789ab",
    eventType: "build.completed",
    externalRevision: 10,
    payload: {
      buildExternalId: "20260824-083000-bbbbbbbb",
      buildProjectKey: "OZDQP",
      buildBranch: "codex/qa-ozdqp-1024",
      buildMode: "cdn",
      sourceCommitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  };
  if (!validateWebhook(buildCompleted)) {
    failures.push(
      `Complete Relay build identity failed schema validation: ${ajv.errorsText(validateWebhook.errors)}`,
    );
  }
  const buildViolations = validateIntegrationSemantics(
    buildCompleted,
    integrationInvariants,
    {
      repairAttempt: {
        deliveredCommitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      expectedBuild: {
        externalId: "20260824-083000-bbbbbbbb",
        projectKey: "OZDQP",
        branch: "codex/qa-ozdqp-1024",
        mode: "cdn",
      },
    },
  );
  if (buildViolations.length > 0) {
    failures.push(`Eligible Build identity failed semantics: ${JSON.stringify(buildViolations)}`);
  }
  const missingBuildIdentity = structuredClone(buildCompleted);
  missingBuildIdentity.payload = {};
  if (validateWebhook(missingBuildIdentity)) {
    failures.push("Relay build.completed unexpectedly validates with an empty payload.");
  }
  const mismatchedBuildContext = validateIntegrationSemantics(
    buildCompleted,
    integrationInvariants,
    {
      repairAttempt: {
        deliveredCommitSha: "ffffffffffffffffffffffffffffffffffffffff",
      },
      expectedBuild: {
        externalId: "20260824-083000-bbbbbbbb",
        projectKey: "OZDQP",
        branch: "codex/qa-ozdqp-1024",
        mode: "cdn",
      },
    },
  );
  if (
    !mismatchedBuildContext.some(
      (violation) => violation.errorCode === "BUILD_IDENTITY_MISMATCH",
    )
  ) {
    failures.push("Build exact-SHA mismatch did not fail executable semantic validation.");
  }

  const wrongBuildIdentity = structuredClone(buildCompleted);
  wrongBuildIdentity.payload.buildExternalId = "wrong-job";
  wrongBuildIdentity.payload.buildProjectKey = "WRONG";
  wrongBuildIdentity.payload.buildBranch = "wrong/branch";
  wrongBuildIdentity.payload.buildMode = "full";
  const wrongIdentityViolations = validateIntegrationSemantics(
    wrongBuildIdentity,
    integrationInvariants,
    {
      repairAttempt: {
        deliveredCommitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      expectedBuild: {
        externalId: "20260824-083000-bbbbbbbb",
        projectKey: "OZDQP",
        branch: "codex/qa-ozdqp-1024",
        mode: "cdn",
      },
    },
  );
  if (
    wrongIdentityViolations.filter(
      (violation) => violation.errorCode === "BUILD_IDENTITY_MISMATCH",
    ).length < 4
  ) {
    failures.push(
      "Build Job/project/branch/mode mismatch did not fail all executable identity checks.",
    );
  }
}

const transitions = await readJson("state/bug-transitions.json");
const stateSet = new Set(transitions.states);
const transitionIds = new Set();
for (const transition of transitions.transitions) {
  if (transitionIds.has(transition.id)) {
    failures.push(`Duplicate transition id: ${transition.id}`);
  }
  transitionIds.add(transition.id);
  for (const from of transition.from) {
    if (!stateSet.has(from)) failures.push(`${transition.id}: unknown from state ${from}`);
  }
  if (!stateSet.has(transition.to)) {
    failures.push(`${transition.id}: unknown target state ${transition.to}`);
  }
}

const closedTransitions = transitions.transitions.filter(
  (transition) => transition.to === "closed",
);
if (
  closedTransitions.length !== 1 ||
  closedTransitions[0].id !== "bug.verification.passed" ||
  closedTransitions[0].actorTypes.length !== 1 ||
  closedTransitions[0].actorTypes[0] !== "user" ||
  !closedTransitions[0].guards.includes("verification.latest.status == passed")
) {
  failures.push(
    "Closed must have exactly one user-only transition guarded by a passed latest Verification.",
  );
}

const projections = await readJson("state/integration-projections.json");
for (const rule of projections.rules) {
  if (rule.mayTransitionBugTo.includes("closed")) {
    failures.push(`${rule.eventType}: an integration rule may close a QA Bug`);
  }
}
for (const requiredForbiddenAction of [
  "verification.passed",
  "bug.closed",
  "bug.rejected",
  "bug.duplicate",
]) {
  if (!projections.forbiddenAutomation.includes(requiredForbiddenAction)) {
    failures.push(`Missing forbidden integration action: ${requiredForbiddenAction}`);
  }
}

const taskClosedProjection = projections.rules.find(
  (rule) => rule.eventType === "task.closed",
);
if (!taskClosedProjection || taskClosedProjection.mayTransitionBugTo.length !== 0) {
  failures.push("Relay task.closed must be metadata-only with no Bug transition.");
}
const taskClosedScenario = examples.scenarios.find(
  (scenario) => scenario.id === "relay-task-close-is-metadata-only",
);
if (taskClosedScenario) {
  const forbiddenTaskClose = validateIntegrationSemantics(
    taskClosedScenario.payload,
    integrationInvariants,
    { proposedBugTransition: "closed" },
  );
  if (
    !forbiddenTaskClose.some(
      (violation) => violation.errorCode === "INTEGRATION_AUTOMATION_FORBIDDEN",
    )
  ) {
    failures.push("Executable integration semantics allowed task.closed to close a QA Bug.");
  }
}

const errors = await readJson("errors/error-codes.json");
const errorCodes = new Set();
for (const error of errors.errors) {
  if (errorCodes.has(error.code)) failures.push(`Duplicate error code: ${error.code}`);
  errorCodes.add(error.code);
  if (error.status < 400 || error.status > 599) {
    failures.push(`${error.code}: invalid HTTP error status ${error.status}`);
  }
}
for (const requiredCode of [
  "INVALID_TRANSITION",
  "ACTIVE_REPAIR_EXISTS",
  "IDEMPOTENCY_PAYLOAD_MISMATCH",
  "VERSION_CONFLICT",
  "GUARD_FAILED",
]) {
  if (!errorCodes.has(requiredCode)) failures.push(`Missing required error code: ${requiredCode}`);
}

const commonSchema = await readJson("schemas/common.schema.json");
const schemaErrorCodes = commonSchema.$defs.error.properties.code.enum;
if (
  [...errorCodes].sort().join("|") !== [...schemaErrorCodes].sort().join("|")
) {
  failures.push("common error schema enum and error-codes.json are not identical.");
}

const manifest = await readJson("src/api-manifest.json");
const openapiPath = path.join(contractRoot, "openapi", "openapi.json");
let openapi;
try {
  openapi = await SwaggerParser.validate(openapiPath, {
    resolve: {
      http: false,
      qaHubContractId: {
        order: 1,
        canRead: (file) =>
          file.url.startsWith("https://qa-hub.local/contracts/"),
        read: async (file) => {
          const contractUrl = new URL(file.url);
          const filename = path.posix.basename(contractUrl.pathname);
          return readFile(path.join(contractRoot, "schemas", filename), "utf8");
        },
      },
    },
  });
} catch (error) {
  failures.push(`OpenAPI validation failed: ${error.message}`);
}

if (openapi) {
  if (openapi.openapi !== "3.1.0") failures.push(`Expected OpenAPI 3.1.0, got ${openapi.openapi}`);
  if (openapi["x-contract-version"] !== manifest.contractVersion) {
    failures.push("OpenAPI and API manifest contract versions differ.");
  }
  if (openapi.servers?.[0]?.url !== "/api/v1") {
    failures.push("The OpenAPI server prefix must be /api/v1.");
  }

  const operationIds = new Set();
  const allowedVersionlessWrites = new Set([
    "createBug",
    "initUpload",
    "createPushSubscription",
    "registerBuild",
    "receiveRelayWebhook",
    "receiveBuildWebhook",
  ]);
  for (const definition of manifest.operations) {
    const operation = openapi.paths?.[definition.path]?.[definition.method];
    if (!operation) {
      failures.push(`OpenAPI missing ${definition.method.toUpperCase()} ${definition.path}`);
      continue;
    }
    if (operation.operationId !== definition.operationId) {
      failures.push(`${definition.path}: operationId drift`);
    }
    if (operationIds.has(operation.operationId)) {
      failures.push(`Duplicate OpenAPI operationId: ${operation.operationId}`);
    }
    operationIds.add(operation.operationId);

    if (["post", "put", "patch", "delete"].includes(definition.method)) {
      const idempotencyHeader = operation.parameters?.find(
        (parameter) => parameter.in === "header" && parameter.name === "Idempotency-Key",
      );
      if (!idempotencyHeader?.required) {
        failures.push(`${definition.operationId}: required Idempotency-Key header missing`);
      }

      if (!["none", "body", "header"].includes(definition.versionControl)) {
        failures.push(`${definition.operationId}: versionControl is not declared`);
      }
      if (
        definition.versionControl === "none" &&
        !allowedVersionlessWrites.has(definition.operationId)
      ) {
        failures.push(`${definition.operationId}: existing-aggregate write is versionless`);
      }
      if (definition.versionControl === "header") {
        const ifMatch = operation.parameters?.find(
          (parameter) => parameter.in === "header" && parameter.name === "If-Match",
        );
        if (!ifMatch?.required) {
          failures.push(`${definition.operationId}: required If-Match header missing`);
        }
      }
      if (definition.versionControl === "body") {
        if (!definition.requestRef) {
          failures.push(`${definition.operationId}: body version control has no request schema`);
        } else {
          const [relativeSchemaPath, fragment = ""] = definition.requestRef.split("#");
          const schemaPath = path.resolve(contractRoot, "openapi", relativeSchemaPath);
          const requestSchemaDocument = JSON.parse(await readFile(schemaPath, "utf8"));
          const fragmentSegments = fragment
            .replace(/^\//, "")
            .split("/")
            .filter(Boolean)
            .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
          const requestSchema = fragmentSegments.reduce(
            (current, segment) => current?.[segment],
            requestSchemaDocument,
          );
          if (!requestSchema?.required?.includes("expectedVersion")) {
            failures.push(
              `${definition.operationId}: body schema does not require expectedVersion`,
            );
          }
        }
      }
    }

    if (
      definition.status !== 204 &&
      !definition.responseRef &&
      !definition.responseContent
    ) {
      failures.push(`${definition.operationId}: success response is not explicitly typed`);
    }

    for (const [status, response] of Object.entries(operation.responses)) {
      if (Number(status) === definition.status) continue;
      const declaredCodes = response["x-error-codes"];
      if (!Array.isArray(declaredCodes) || declaredCodes.length === 0) {
        failures.push(`${definition.operationId}: ${status} response lacks x-error-codes`);
        continue;
      }
      for (const code of declaredCodes) {
        const catalogEntry = errors.errors.find((error) => error.code === code);
        if (!catalogEntry || catalogEntry.status !== Number(status)) {
          failures.push(
            `${definition.operationId}: error ${code} is not cataloged for HTTP ${status}`,
          );
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Contract check passed: ${schemaPaths.length} schemas, ${examples.scenarios.length}/12 payload scenarios, ${behaviorMatrix.scenarios.length}/12 executable behavior scenarios, ${transitions.transitions.length} transitions, ${manifest.operations.length} OpenAPI operations, ${errors.errors.length} error codes. Relay automation cannot verify or close Bugs.`,
  );
}
