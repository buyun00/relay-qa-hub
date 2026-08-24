import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const versionRoot = fileURLToPath(new URL("..", import.meta.url));
const contractRoot = path.resolve(versionRoot, "..", "..");

async function readJson(absolutePath) {
  return JSON.parse(await readFile(absolutePath, "utf8"));
}

const [
  manifest,
  baseManifest,
  nextOpenApi,
  baseOpenApi,
  baseBaseline,
  baseErrors,
  deltaErrors,
] = await Promise.all([
  readJson(path.join(versionRoot, "src", "api-manifest.json")),
  readJson(path.join(contractRoot, "src", "api-manifest.json")),
  readJson(path.join(versionRoot, "openapi", "openapi.json")),
  readJson(path.join(contractRoot, "openapi", "openapi.json")),
  readJson(path.join(contractRoot, "baselines", "contract-baseline.json")),
  readJson(path.join(contractRoot, "errors", "error-codes.json")),
  readJson(path.join(versionRoot, "errors", "error-codes.json")),
]);

const errorByCode = new Map(
  [...baseErrors.errors, ...deltaErrors.errors].map((entry) => [entry.code, entry]),
);

const failures = [];

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return match.slice(1).map(Number);
}

try {
  const [baseMajor, baseMinor] = parseSemver(manifest.baseContractVersion);
  const [nextMajor, nextMinor] = parseSemver(manifest.contractVersion);
  if (nextMajor !== baseMajor || nextMinor <= baseMinor) {
    failures.push("1.1 contract must keep the 1.0 major and increase its minor version.");
  }
} catch (error) {
  failures.push(error.message);
}
if (manifest.baseContractVersion !== baseManifest.contractVersion) {
  failures.push("Manifest base version does not match the frozen 1.0 API manifest.");
}
if (manifest.baseContractVersion !== baseBaseline.contractVersion) {
  failures.push("Manifest base version does not match the immutable 1.0 hash baseline.");
}

function normalizeBaseRefs(value) {
  if (Array.isArray(value)) return value.map(normalizeBaseRefs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === "$ref" && typeof child === "string") {
        return [key, child.replace("../../../schemas/", "../schemas/")];
      }
      return [key, normalizeBaseRefs(child)];
    }),
  );
}

const patchByOperationId = new Map(
  manifest.operationPatches.map((patch) => [patch.operationId, patch]),
);

for (const definition of baseManifest.operations) {
  const baseOperation = structuredClone(
    baseOpenApi.paths?.[definition.path]?.[definition.method],
  );
  const nextOperation = structuredClone(
    nextOpenApi.paths?.[definition.path]?.[definition.method],
  );
  if (!baseOperation || !nextOperation) {
    failures.push(`${definition.operationId}: base operation is missing from 1.1`);
    continue;
  }

  if (definition.security === "session-read" || definition.security === "session-write") {
    nextOperation.security = nextOperation.security.filter(
      (requirement) => !("nativeAccessToken" in requirement),
    );
    delete nextOperation["x-human-auth"];
  }

  const patch = patchByOperationId.get(definition.operationId);
  if (patch) {
    for (const [field, extension] of [
      ["authorizationPolicy", "x-authorization-policy"],
      ["createOrRotatePolicy", "x-create-or-rotate-policy"],
      ["paginationPolicy", "x-pagination-policy"],
    ]) {
      if (patch[field] !== undefined) delete nextOperation[extension];
    }
    for (const descriptor of [
      ...(patch.queryParameters ?? []),
      ...(patch.headerParameters ?? []),
    ]) {
      if (descriptor.required) {
        failures.push(
          `${definition.operationId}: added parameter ${descriptor.name} is required and breaks 1.0 callers`,
        );
      }
    }
    const addedParameters = new Set([
      ...(patch.queryParameters ?? []).map((entry) => `query:${entry.name}`),
      ...(patch.headerParameters ?? []).map((entry) => `header:${entry.name}`),
    ]);
    nextOperation.parameters = (nextOperation.parameters ?? []).filter(
      (parameter) => !addedParameters.has(`${parameter.in}:${parameter.name}`),
    );

    if (patch.requestRef || patch.requestMediaType) {
      delete nextOperation.requestBody.content[patch.requestMediaType ?? manifest.mediaType];
    }
    if (patch.responseRef || patch.responseMediaType) {
      delete nextOperation.responses[String(definition.status)].content[
        patch.responseMediaType ?? manifest.mediaType
      ];
    }
    if (patch.eventDataRef) {
      if (nextOperation["x-event-data-schema"]?.$ref !== patch.eventDataRef) {
        failures.push(`${definition.operationId}: declared event data schema drifted`);
      }
      delete nextOperation["x-event-data-schema"];
    }
    if (patch.eventProjectionPolicy) {
      if (
        nextOperation["x-event-projection-policy"] !== patch.eventProjectionPolicy
      ) {
        failures.push(`${definition.operationId}: declared event projection policy drifted`);
      }
      delete nextOperation["x-event-projection-policy"];
    }
    for (const headerName of Object.keys(patch.successResponseHeaders ?? {})) {
      delete nextOperation.responses[String(definition.status)].headers?.[headerName];
    }
    if (
      nextOperation.responses[String(definition.status)].headers &&
      Object.keys(nextOperation.responses[String(definition.status)].headers).length === 0
    ) {
      delete nextOperation.responses[String(definition.status)].headers;
    }
    for (const code of patch.errorCodes ?? []) {
      const error = errorByCode.get(code);
      if (!error) continue;
      const status = String(error.status);
      const nextResponse = nextOperation.responses[status];
      if (!nextResponse) continue;
      delete nextResponse.content?.[manifest.mediaType];
      if (nextResponse.content && Object.keys(nextResponse.content).length === 0) {
        delete nextResponse.content;
      }
      if (!baseOperation.responses[status]) delete nextOperation.responses[status];
    }
    for (const descriptor of patch.additionalResponses ?? []) {
      const status = String(descriptor.status);
      if (baseOperation.responses[status]) {
        failures.push(
          `${definition.operationId}: additional response ${status} overwrites a 1.0 response`,
        );
        continue;
      }
      const expectedResponse = structuredClone(descriptor);
      delete expectedResponse.status;
      try {
        assert.deepStrictEqual(nextOperation.responses[status], expectedResponse);
      } catch (error) {
        failures.push(
          `${definition.operationId}: declared additional response ${status} drifted: ${error.message}`,
        );
      }
      delete nextOperation.responses[status];
    }
    if (patch.idempotencyKeySource) {
      delete nextOperation["x-idempotency-key-source"];
      delete nextOperation["x-idempotency-scope"];
      const baseHeader = baseOperation.parameters?.find(
        (parameter) => parameter.in === "header" && parameter.name === "Idempotency-Key",
      );
      const nextHeader = nextOperation.parameters?.find(
        (parameter) => parameter.in === "header" && parameter.name === "Idempotency-Key",
      );
      if (baseHeader && nextHeader) nextHeader.description = baseHeader.description;
    }
    if (definition.operationId === "putUploadChunk") {
      delete nextOperation["x-canonical-binary-payload"];
      delete nextOperation["x-upload-version-semantics"];
    }
  }

  for (const status of ["406", "415"]) {
    const baseResponse = baseOperation.responses?.[status];
    const nextResponse = nextOperation.responses?.[status];
    if (!nextResponse) continue;
    if (!baseResponse) {
      delete nextOperation.responses[status];
      continue;
    }
    delete nextResponse.content?.[manifest.mediaType];
    if (nextResponse.content && Object.keys(nextResponse.content).length === 0) {
      delete nextResponse.content;
    }
    if (baseResponse["x-error-codes"] === undefined) {
      delete nextResponse["x-error-codes"];
    } else {
      nextResponse["x-error-codes"] = baseResponse["x-error-codes"];
    }
    nextResponse.description = baseResponse.description;
  }

  // Actor-bound replay scoping is a declared 1.1 authorization overlay on
  // every inherited human write. Remove only that metadata when proving the
  // underlying 1.0 wire contract stayed byte-shape compatible.
  if (baseOperation["x-idempotency-scope"] === undefined) {
    delete nextOperation["x-idempotency-scope"];
  } else {
    nextOperation["x-idempotency-scope"] = baseOperation["x-idempotency-scope"];
  }
  if (baseOperation["x-idempotency-replay-authorization"] === undefined) {
    delete nextOperation["x-idempotency-replay-authorization"];
  } else {
    nextOperation["x-idempotency-replay-authorization"] =
      baseOperation["x-idempotency-replay-authorization"];
  }
  if (baseOperation["x-sensitive-request-digest"] === undefined) {
    delete nextOperation["x-sensitive-request-digest"];
  } else {
    nextOperation["x-sensitive-request-digest"] =
      baseOperation["x-sensitive-request-digest"];
  }
  if (manifest.nativeAuthorizationPolicies[definition.operationId]) {
    delete nextOperation["x-authorization-policy"];
    delete nextOperation["x-pagination-policy"];
  }

  try {
    assert.deepStrictEqual(normalizeBaseRefs(nextOperation), baseOperation);
  } catch (error) {
    failures.push(`${definition.operationId}: undeclared wire change: ${error.message}`);
  }
}

const nextOperationIds = new Set();
for (const pathItem of Object.values(nextOpenApi.paths)) {
  for (const operation of Object.values(pathItem)) {
    if (operation?.operationId) nextOperationIds.add(operation.operationId);
  }
}
for (const definition of manifest.operations) {
  if (!nextOperationIds.has(definition.operationId)) {
    failures.push(`Declared 1.1 operation missing: ${definition.operationId}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Additive compatibility passed: all ${baseManifest.operations.length} version 1.0.0 operations are byte-shape equivalent after declared media/security/parameter overlays; ${manifest.operations.length} operations are new in ${manifest.contractVersion}.`,
  );
}
