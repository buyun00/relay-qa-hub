import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const versionRoot = fileURLToPath(new URL("..", import.meta.url));
const contractRoot = path.resolve(versionRoot, "..", "..");

async function readJson(absolutePath) {
  return JSON.parse(await readFile(absolutePath, "utf8"));
}

const [manifest, baseManifest, baseOpenApi, baseErrors, deltaErrors, examples] =
  await Promise.all([
    readJson(path.join(versionRoot, "src", "api-manifest.json")),
    readJson(path.join(contractRoot, "src", "api-manifest.json")),
    readJson(path.join(contractRoot, "openapi", "openapi.json")),
    readJson(path.join(contractRoot, "errors", "error-codes.json")),
    readJson(path.join(versionRoot, "errors", "error-codes.json")),
    readJson(path.join(versionRoot, "examples", "openapi-examples.json")),
  ]);

function rewriteBaseSchemaRefs(value) {
  if (Array.isArray(value)) return value.map(rewriteBaseSchemaRefs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === "$ref" && typeof child === "string" && child.startsWith("../schemas/")) {
        return [key, `../../../schemas/${child.slice("../schemas/".length)}`];
      }
      return [key, rewriteBaseSchemaRefs(child)];
    }),
  );
}

const openapi = rewriteBaseSchemaRefs(structuredClone(baseOpenApi));
openapi.info = {
  ...openapi.info,
  version: "0.1.0-debug+contract.1.1.0",
  description:
    "Independent QA source-of-truth API. Contract 1.1.0 adds the native Android human client while Relay remains an optional delivery/build executor that cannot verify or close a QA Bug.",
};
openapi["x-contract-version"] = manifest.contractVersion;
openapi["x-base-contract-version"] = manifest.baseContractVersion;
openapi["x-versioned-media-type"] = manifest.mediaType;
openapi["x-android-platform"] = manifest.androidPlatform;
openapi["x-content-negotiation"] = manifest.contentNegotiation;
openapi["x-native-session-policy"] = manifest.nativeSessionPolicy;
openapi["x-native-refresh-replay-policy"] = manifest.nativeRefreshReplayPolicy;
openapi["x-offline-lease-policy"] = manifest.offlineLeasePolicy;
openapi["x-occurrence-metadata-policy"] = manifest.occurrenceMetadataPolicy;
openapi["x-audit-projection-policy"] = manifest.auditProjectionPolicy;
openapi["x-stream-projection-policy"] = manifest.streamProjectionPolicy;
openapi["x-attachment-download-policy"] = manifest.attachmentDownloadPolicy;
openapi["x-capture-policy"] = manifest.capturePolicy;
openapi["x-notification-policy"] = manifest.notificationPolicy;
openapi["x-relay-projection-policy"] = manifest.relayProjectionPolicy;
openapi["x-poco-transport-limits"] = manifest.pocoTransport;
openapi["x-poco-privacy-policy"] = manifest.pocoPrivacyPolicy;
openapi["x-poco-snapshot-schema-versions"] = manifest.pocoSnapshotSchemaVersions;
openapi.components.securitySchemes.nativeAccessToken = {
  type: "http",
  scheme: "bearer",
  bearerFormat: "opaque-human-session",
  description:
    "Short-lived human QA Hub App session token. It is never a Relay or Build machine credential and is not accepted by integration webhooks.",
};
openapi.components.schemas.ErrorV110 = {
  $ref: "../schemas/app-first.schema.json#/$defs/error",
};

const baseOperationById = new Map(
  baseManifest.operations.map((definition) => [definition.operationId, definition]),
);
const allErrors = [...baseErrors.errors, ...deltaErrors.errors];
const errorByCode = new Map(allErrors.map((entry) => [entry.code, entry]));
const nativeBaseOperationIds = new Set(manifest.nativeBaseOperationIds);

if (nativeBaseOperationIds.size !== manifest.nativeBaseOperationIds.length) {
  throw new Error("nativeBaseOperationIds contains duplicates");
}
for (const operationId of nativeBaseOperationIds) {
  const definition = baseOperationById.get(operationId);
  if (!definition) throw new Error(`Unknown native-enabled base operation: ${operationId}`);
  if (definition.security !== "session-read" && definition.security !== "session-write") {
    throw new Error(`${operationId}: native bearer can only extend a human session operation`);
  }
}

function findOperation(operationId) {
  for (const [route, pathItem] of Object.entries(openapi.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (operation?.operationId === operationId) return { route, method, operation };
    }
  }
  throw new Error(`OpenAPI operation not found: ${operationId}`);
}

for (const definition of baseManifest.operations) {
  if (!nativeBaseOperationIds.has(definition.operationId)) continue;
  const { operation } = findOperation(definition.operationId);
  const nativeAlternative = { nativeAccessToken: [] };
  operation.security = [...operation.security, nativeAlternative];
  operation["x-human-auth"] =
    definition.security === "session-write"
      ? "browser-cookie-plus-csrf OR native-human-bearer"
      : "browser-cookie OR native-human-bearer";
}

function groupErrorCodes(errorCodes, operationId) {
  const groups = new Map();
  for (const code of errorCodes ?? []) {
    const entry = errorByCode.get(code);
    if (!entry) throw new Error(`${operationId}: unknown error code ${code}`);
    const codes = groups.get(entry.status) ?? [];
    codes.push(code);
    groups.set(entry.status, codes);
  }
  return groups;
}

function versionedErrorMedia(codes) {
  return {
    "x-error-codes": codes,
    schema: {
      allOf: [
        { $ref: "../schemas/app-first.schema.json#/$defs/error" },
        { type: "object", properties: { code: { enum: codes } }, required: ["code"] },
      ],
    },
  };
}

function addParameters(operation, descriptors, location) {
  operation.parameters ??= [];
  for (const descriptor of descriptors ?? []) {
    if (
      operation.parameters.some(
        (parameter) => parameter.in === location && parameter.name === descriptor.name,
      )
    ) {
      throw new Error(`${operation.operationId}: duplicate ${location} parameter ${descriptor.name}`);
    }
    operation.parameters.push({
      name: descriptor.name,
      in: location,
      required: descriptor.required,
      ...(descriptor.style ? { style: descriptor.style } : {}),
      ...(descriptor.explode !== undefined ? { explode: descriptor.explode } : {}),
      ...(descriptor.requiredForContractVersion
        ? { "x-required-for-contract-version": descriptor.requiredForContractVersion }
        : {}),
      schema: descriptor.schema,
    });
  }
}

function attachExample(operationId, operation, mediaType, direction) {
  const example = examples.operations?.[operationId]?.[direction];
  if (!example) return;
  const container =
    direction === "request"
      ? operation.requestBody?.content?.[mediaType]
      : operation.responses?.[String(examples.operations[operationId].status)]?.content?.[
          mediaType
        ];
  if (container) container.example = example;
}

for (const patch of manifest.operationPatches) {
  const definition = baseOperationById.get(patch.operationId);
  if (!definition) throw new Error(`Unknown base operation patch: ${patch.operationId}`);
  const { operation } = findOperation(patch.operationId);
  addParameters(operation, patch.queryParameters, "query");
  addParameters(operation, patch.headerParameters, "header");
  for (const [field, extension] of [
    ["authorizationPolicy", "x-authorization-policy"],
    ["createOrRotatePolicy", "x-create-or-rotate-policy"],
    ["paginationPolicy", "x-pagination-policy"],
  ]) {
    if (patch[field] !== undefined) operation[extension] = patch[field];
  }

  if (patch.requestRef || patch.requestMediaType) {
    const requestSchema = patch.requestRef
      ? { $ref: patch.requestRef }
      : structuredClone(operation.requestBody?.content?.["application/json"]?.schema);
    if (!requestSchema) {
      throw new Error(`${patch.operationId}: patched request media type has no schema`);
    }
    const mediaType = patch.requestMediaType ?? manifest.mediaType;
    operation.requestBody ??= { required: true, content: {} };
    operation.requestBody.content[mediaType] = { schema: requestSchema };
    attachExample(patch.operationId, operation, mediaType, "request");
  }
  if (patch.responseRef || patch.responseMediaType) {
    const mediaType = patch.responseMediaType ?? manifest.mediaType;
    const response = operation.responses[String(definition.status)];
    const responseSchema = patch.responseRef
      ? { $ref: patch.responseRef }
      : structuredClone(response?.content?.["application/json"]?.schema);
    if (!responseSchema) {
      throw new Error(`${patch.operationId}: patched response media type has no schema`);
    }
    response.content ??= {};
    response.content[mediaType] = { schema: responseSchema };
    attachExample(patch.operationId, operation, mediaType, "response");
  }
  if (patch.eventDataRef) {
    operation["x-event-data-schema"] = { $ref: patch.eventDataRef };
  }
  if (patch.eventProjectionPolicy) {
    operation["x-event-projection-policy"] = patch.eventProjectionPolicy;
  }
  if (patch.successResponseHeaders) {
    const response = operation.responses[String(definition.status)];
    response.headers = { ...(response.headers ?? {}), ...patch.successResponseHeaders };
  }
  for (const descriptor of patch.additionalResponses ?? []) {
    const status = String(descriptor.status);
    if (operation.responses[status]) {
      throw new Error(`${patch.operationId}: additional response ${status} already exists`);
    }
    const response = structuredClone(descriptor);
    delete response.status;
    operation.responses[status] = structuredClone(response);
  }
  if (patch.idempotencyKeySource) {
    operation["x-idempotency-key-source"] = patch.idempotencyKeySource;
    operation["x-idempotency-scope"] = manifest.idempotency.scope;
    const header = operation.parameters?.find(
      (parameter) => parameter.in === "header" && parameter.name === "Idempotency-Key",
    );
    if (!header) throw new Error(`${patch.operationId}: Idempotency-Key header missing`);
    header.description = `Canonical key: ${patch.idempotencyKeySource}. Same scoped key and canonical payload replays the original response; a different payload returns IDEMPOTENCY_PAYLOAD_MISMATCH.`;
  }
  if (patch.operationId === "putUploadChunk") {
    operation["x-canonical-binary-payload"] = manifest.idempotency.binaryChunkHash;
    operation["x-upload-version-semantics"] = patch.versionSemantics;
  }
  for (const [status, codes] of groupErrorCodes(patch.errorCodes, patch.operationId)) {
    const response = (operation.responses[String(status)] ??= {
      description: `Structured ${status} error for contract ${manifest.contractVersion}.`,
      content: {},
    });
    response.content ??= {};
    response.content[manifest.mediaType] = versionedErrorMedia(codes);
  }
}

const writeMethods = new Set(["post", "put", "patch", "delete"]);
const securityByMode = {
  none: [],
  "native-read": [{ nativeAccessToken: [] }],
  "native-write": [{ nativeAccessToken: [] }],
  "session-or-native-read": [{ sessionCookie: [] }, { nativeAccessToken: [] }],
  "session-or-native-write": [
    { sessionCookie: [], csrfHeader: [] },
    { nativeAccessToken: [] },
  ],
};

function pathParameter(name) {
  return {
    name,
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
  };
}

for (const definition of manifest.operations) {
  const {
    method,
    path: route,
    operationId,
    summary,
    tag,
    security,
    status,
    versionControl,
    requestRef,
    responseRef,
  } = definition;
  if (!(security in securityByMode)) throw new Error(`${operationId}: unknown security ${security}`);
  if (openapi.paths[route]?.[method]) {
    throw new Error(`Duplicate operation: ${method.toUpperCase()} ${route}`);
  }

  const parameters = [...route.matchAll(/\{([^}]+)\}/g)].map((match) =>
    pathParameter(match[1]),
  );
  if (writeMethods.has(method)) {
    if (!['none', 'body', 'header'].includes(versionControl)) {
      throw new Error(`${operationId}: write operation must declare versionControl`);
    }
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: { type: "string", minLength: 1, maxLength: 200 },
      description: definition.idempotencyKeySource
        ? `Canonical key: ${definition.idempotencyKeySource}.`
        : "Stable actor-scoped action key; a different canonical payload returns IDEMPOTENCY_PAYLOAD_MISMATCH.",
    });
  }

  const successResponse = { description: status === 202 ? "Durably queued." : "Success." };
  if (definition.responseHeaders) successResponse.headers = definition.responseHeaders;
  if (status !== 204) {
    if (!responseRef) throw new Error(`${operationId}: typed responseRef is required`);
    successResponse.content = {
      [manifest.mediaType]: { schema: { $ref: responseRef } },
    };
  }

  const responses = { [String(status)]: successResponse };
  const errorGroups = groupErrorCodes(definition.errorCodes, operationId);
  for (const [errorStatus, codes] of [...errorGroups].sort(([left], [right]) => left - right)) {
    responses[String(errorStatus)] = {
      description: `Structured ${errorStatus} error.`,
      "x-error-codes": codes,
      content: {
        [manifest.mediaType]: versionedErrorMedia(codes),
      },
    };
  }

  const operation = {
    operationId,
    summary,
    tags: [tag],
    security: securityByMode[security],
    parameters,
    responses,
  };
  addParameters(operation, definition.queryParameters, "query");
  addParameters(operation, definition.headerParameters, "header");
  if (requestRef) {
    operation.requestBody = {
      required: true,
      content: { [manifest.mediaType]: { schema: { $ref: requestRef } } },
    };
  }
  if (definition.idempotencyKeySource) {
    operation["x-idempotency-key-source"] = definition.idempotencyKeySource;
    operation["x-idempotency-scope"] =
      definition.idempotencyScope ?? manifest.idempotency.scope;
    if (definition.idempotencyReplayAfterAuthentication) {
      operation["x-idempotency-replay-after-authentication"] = true;
    }
  }
  if (definition.sensitiveRequestDigest) {
    operation["x-sensitive-request-digest"] = manifest.idempotency.sensitiveRequestDigest;
  }
  if (definition.authorizationPolicy) {
    operation["x-authorization-policy"] = definition.authorizationPolicy;
  }
  if (definition.createOrRotatePolicy) {
    operation["x-create-or-rotate-policy"] = definition.createOrRotatePolicy;
  }
  if (definition.paginationPolicy) {
    operation["x-pagination-policy"] = definition.paginationPolicy;
  }
  if (definition.refreshReplayPolicy) {
    operation["x-refresh-replay-policy"] = manifest.nativeRefreshReplayPolicy;
  }
  if (definition.secretResponse) {
    operation["x-secret-response"] = true;
    operation["x-idempotency-retention-seconds"] = definition.idempotencyRetentionSeconds;
  }

  openapi.paths[route] ??= {};
  openapi.paths[route][method] = operation;
  if (!openapi.tags.some((entry) => entry.name === tag)) openapi.tags.push({ name: tag });
  attachExample(operationId, operation, manifest.mediaType, "request");
  attachExample(operationId, operation, manifest.mediaType, "response");
}

// Contract 1.1 tightens every human-actor write, including inherited 1.0
// operations, so an idempotency snapshot is never visible across actors or
// resource scopes. This is an authorization hardening extension, not a wire
// shape change.
const explicitActorWriteScopes = new Map(
  [
    ...Object.entries(manifest.idempotency.operationScopes ?? {}),
    ...manifest.operations
      .filter((definition) => definition.idempotencyScope)
      .map((definition) => [definition.operationId, definition.idempotencyScope]),
  ],
);
for (const pathItem of Object.values(openapi.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!writeMethods.has(method) || !operation?.operationId) continue;
    const actorAuthenticated = operation.security?.some(
      (requirement) => "sessionCookie" in requirement || "nativeAccessToken" in requirement,
    );
    if (!actorAuthenticated) continue;
    operation["x-idempotency-scope"] =
      explicitActorWriteScopes.get(operation.operationId) ?? manifest.idempotency.scope;
    operation["x-idempotency-replay-authorization"] =
      manifest.idempotency.replayAuthorizationRule;
    if (manifest.idempotency.sensitiveOperationIds.includes(operation.operationId)) {
      operation["x-sensitive-request-digest"] = manifest.idempotency.sensitiveRequestDigest;
    }
  }
}

for (const [operationId, policy] of Object.entries(manifest.nativeAuthorizationPolicies)) {
  const { operation } = findOperation(operationId);
  operation["x-authorization-policy"] = policy.authorizationPolicy;
  if (policy.paginationPolicy) operation["x-pagination-policy"] = policy.paginationPolicy;
}

const negotiationErrorByStatus = new Map([
  [406, manifest.contentNegotiation.unsupportedAcceptErrorCode],
  [415, manifest.contentNegotiation.unsupportedContentTypeErrorCode],
]);
for (const pathItem of Object.values(openapi.paths)) {
  for (const operation of Object.values(pathItem)) {
    if (!operation?.operationId) continue;
    for (const [status, code] of negotiationErrorByStatus) {
      if (status === 415 && !operation.requestBody) continue;
      const response = (operation.responses[String(status)] ??= {
        description: `Structured ${status} media-negotiation error.`,
        content: {},
      });
      response["x-error-codes"] = [code];
      response.content ??= {};
      response.content[manifest.mediaType] = versionedErrorMedia([code]);
    }
  }
}

const outputPath = path.join(versionRoot, "openapi", "openapi.json");
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(openapi, null, 2)}\n`, "utf8");
console.log(
  `Generated additive OpenAPI ${manifest.contractVersion}: ${baseManifest.operations.length} base + ${manifest.operations.length} new operations -> ${outputPath}`,
);
