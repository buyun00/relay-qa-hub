import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const contractRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = path.join(contractRoot, "src", "api-manifest.json");
const outputPath = path.join(contractRoot, "openapi", "openapi.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const errorCatalog = JSON.parse(
  await readFile(path.join(contractRoot, "errors", "error-codes.json"), "utf8"),
);
const errorsByStatus = new Map();
for (const error of errorCatalog.errors) {
  const codes = errorsByStatus.get(error.status) ?? [];
  codes.push(error.code);
  errorsByStatus.set(error.status, codes);
}

const securityByMode = {
  none: [],
  "session-read": [{ sessionCookie: [] }],
  "session-write": [{ sessionCookie: [], csrfHeader: [] }],
  "relay-webhook": [{ relayWebhookSignature: [] }],
  "build-webhook": [{ buildWebhookSignature: [] }],
};

const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Relay QA Hub API",
    version: "0.1.0-debug",
    description:
      "Independent QA source-of-truth API. Relay is an optional executor and cannot verify or close a QA Bug.",
  },
  "x-contract-version": manifest.contractVersion,
  servers: [{ url: "/api/v1", description: "Same-origin QA Hub API" }],
  tags: [...new Set(manifest.operations.map((operation) => operation.tag))].map(
    (name) => ({ name }),
  ),
  paths: {},
  components: {
    securitySchemes: {
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "qa_hub_session",
        description: "HttpOnly, Secure, SameSite=Lax QA Hub session cookie.",
      },
      csrfHeader: {
        type: "apiKey",
        in: "header",
        name: "X-CSRF-Token",
      },
      relayWebhookSignature: {
        type: "apiKey",
        in: "header",
        name: "X-Relay-Signature",
      },
      buildWebhookSignature: {
        type: "apiKey",
        in: "header",
        name: "X-Build-Signature",
      },
    },
    schemas: {
      Error: {
        $ref: "../schemas/common.schema.json#/$defs/error",
      },
    },
  },
};

const writeMethods = new Set(["post", "put", "patch", "delete"]);

for (const definition of manifest.operations) {
  const {
    method,
    path: route,
    operationId,
    summary,
    tag,
    security,
    status,
    requestRef,
    responseRef,
    requestContent,
    responseContent,
    versionControl,
  } = definition;

  if (openapi.paths[route]?.[method]) {
    throw new Error(`Duplicate operation: ${method.toUpperCase()} ${route}`);
  }

  if (
    writeMethods.has(method) &&
    !["none", "body", "header"].includes(versionControl)
  ) {
    throw new Error(`${operationId}: write operation must declare versionControl`);
  }
  if (versionControl === "body" && !requestRef) {
    throw new Error(`${operationId}: body version control requires an explicit request schema`);
  }

  const parameters = [];
  for (const match of route.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1];
    parameters.push({
      name,
      in: "path",
      required: true,
      schema:
        name === "chunkNumber"
          ? { type: "integer", minimum: 0 }
          : { type: "string", format: "uuid" },
    });
  }

  if (writeMethods.has(method)) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: { type: "string", minLength: 1, maxLength: 200 },
      description:
        "Stable client action key. Reuse with a different canonical payload returns IDEMPOTENCY_PAYLOAD_MISMATCH.",
    });
  }

  if (versionControl === "header") {
    parameters.push({
      name: "If-Match",
      in: "header",
      required: true,
      schema: { type: "string", pattern: '^"[1-9][0-9]*"$' },
      description: "Required quoted aggregate version for a bodyless existing-aggregate mutation.",
    });
  }

  if (security === "relay-webhook") {
    for (const name of [
      "X-Relay-Delivery-Id",
      "X-Relay-Event-Id",
      "X-Relay-Timestamp",
    ]) {
      parameters.push({
        name,
        in: "header",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 200 },
      });
    }
  }

  if (security === "build-webhook") {
    for (const name of ["X-Build-Delivery-Id", "X-Build-Event-Id", "X-Build-Timestamp"]) {
      parameters.push({
        name,
        in: "header",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 200 },
      });
    }
  }

  const successResponse = {
    description: status === 202 ? "Durably accepted for asynchronous processing." : "Success.",
  };

  if (status !== 204) {
    if (!responseRef && !responseContent) {
      throw new Error(`${operationId}: JSON success response requires an explicit responseRef`);
    }
    const mediaType = responseContent ?? "application/json";
    successResponse.content = {
      [mediaType]: {
        schema: responseRef
          ? { $ref: responseRef }
          : responseContent === "application/octet-stream"
            ? { type: "string", format: "binary" }
            : { type: "string" },
      },
    };
  }

  const errorStatuses = new Set([400, 500]);
  if (security !== "none") {
    for (const errorStatus of [401, 403, 404, 429]) errorStatuses.add(errorStatus);
  }
  if (writeMethods.has(method)) {
    for (const errorStatus of [409, 412, 422, 429]) errorStatuses.add(errorStatus);
  }
  if (tag === "uploads") errorStatuses.add(413);
  if (operationId === "getReadyHealth" || operationId === "getDependencyHealth") {
    errorStatuses.add(503);
  }

  const responses = {
    [String(status)]: successResponse,
  };
  for (const errorStatus of [...errorStatuses].sort((left, right) => left - right)) {
    const codes = errorsByStatus.get(errorStatus);
    if (!codes) continue;
    responses[String(errorStatus)] = {
      description: `Structured ${errorStatus} error.`,
      "x-error-codes": codes,
      content: {
        "application/json": {
          schema: {
            allOf: [
              { $ref: "../schemas/common.schema.json#/$defs/error" },
              {
                type: "object",
                properties: { code: { enum: codes } },
                required: ["code"],
              },
            ],
          },
        },
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

  if (requestRef || requestContent) {
    const mediaType = requestContent ?? "application/json";
    operation.requestBody = {
      required: true,
      content: {
        [mediaType]: {
          schema: requestRef
            ? { $ref: requestRef }
            : { type: "string", format: "binary" },
        },
      },
    };
  }

  openapi.paths[route] ??= {};
  openapi.paths[route][method] = operation;
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(openapi, null, 2)}\n`, "utf8");
console.log(
  `Generated OpenAPI ${openapi.openapi} contract ${manifest.contractVersion}: ${manifest.operations.length} operations -> ${outputPath}`,
);
