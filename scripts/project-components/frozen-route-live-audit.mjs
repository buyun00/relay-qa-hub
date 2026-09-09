import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = resolve(SCRIPT_ROOT, "../..");
const PRODUCTION_PORTS = new Set([4174, 4319, 4320]);
const PROBE_CONTENT_TYPE = "application/x-qa-hub-route-probe";
const MUTATING_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);
const UUID_PLACEHOLDER = "00000000-0000-4000-8000-000000000001";
const HISTORICAL_UNUSED_OPERATIONS = new Map([
  ["createNativeSession", "legacy password-native session outside the project-name login scope"],
  ["refreshNativeSession", "legacy password-native session outside the project-name login scope"],
  ["getNativeSession", "legacy password-native session outside the project-name login scope"],
  ["revokeNativeSession", "legacy password-native session outside the project-name login scope"],
  ["addOccurrence", "historical route unused by the current clients"],
  ["continueRelayRepairAttempt", "historical route unused by the current clients"],
  ["streamEvents", "historical route unused by the current clients"],
  ["markNotificationRead", "historical route unused by the current clients"],
  ["createPushSubscription", "historical route unused by the current clients"],
  ["receiveBuildWebhook", "historical route unused by the current clients"],
  ["getUploadSession", "historical route unused by the current clients"],
  ["getAttachmentMetadata", "historical route unused by the current clients"],
  ["registerAndroidNotificationDevice", "historical route unused by the current clients"],
  ["revokeAndroidNotificationDevice", "historical route unused by the current clients"],
]);

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function within(parent, child) {
  const candidate = relative(realpathSync(parent), realpathSync(child));
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

function normalizeManifestPath(path) {
  return `/api/v1${path.replaceAll(/\{[^}]+\}/gu, UUID_PLACEHOLDER)}`;
}

function defaultRouteMissing(method, path, status, body) {
  if (status !== 404) return false;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const message = body.message;
  return (
    body.error === "Not Found" &&
    typeof message === "string" &&
    message.includes(`Route ${method}:${path} not found`)
  );
}

async function createProbeSession(origin, name, projectId) {
  const response = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name, projectId, client: "android" }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (
    response.status !== 200 ||
    !body ||
    typeof body !== "object" ||
    typeof body.accessToken !== "string" ||
    typeof body.userId !== "string" ||
    body.projectId !== projectId
  ) {
    fail(`ROUTE_PROBE_LOGIN_FAILED:${response.status}`);
  }
  return { accessToken: body.accessToken, actorId: body.userId, projectId };
}

async function revokeProbeSession(origin, session) {
  const response = await fetch(`${origin}/api/v1/auth/logout`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${session.accessToken}`,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) fail(`ROUTE_PROBE_LOGOUT_FAILED:${response.status}`);
}

async function probe(origin, operation, session) {
  const method = operation.method.toUpperCase();
  const path = normalizeManifestPath(operation.path);
  const request = {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${session.accessToken}`,
      "cache-control": "no-store",
      "x-qa-hub-route-probe": "registration-only",
      "x-qa-actor-id": session.actorId,
      "x-qa-project-id": session.projectId,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  };
  if (MUTATING_METHODS.has(method)) {
    request.headers["content-type"] = PROBE_CONTENT_TYPE;
    request.body = "route-probe";
  }

  const response = await fetch(`${origin}${path}`, request);
  const isEventStream = response.headers
    .get("content-type")
    ?.toLowerCase()
    .startsWith("text/event-stream");
  const responseText = isEventStream
    ? (await response.body?.cancel(), "")
    : (await response.text()).slice(0, 2_000);
  const responseBody = (() => {
    try {
      return responseText.length === 0 ? null : JSON.parse(responseText);
    } catch {
      return null;
    }
  })();
  const missing = defaultRouteMissing(method, path, response.status, responseBody);
  return {
    contractVersion: operation.contractVersion,
    operationId: operation.operationId,
    method,
    path: operation.path,
    probePath: path,
    security: operation.security,
    status: response.status,
    contentType: response.headers.get("content-type"),
    errorCode:
      responseBody &&
      typeof responseBody === "object" &&
      !Array.isArray(responseBody) &&
      typeof responseBody.code === "string"
        ? responseBody.code
        : null,
    registered: !missing,
  };
}

const [instanceConfigPath, expectedInstanceId, loginName, projectId] = process.argv.slice(2);
if (!instanceConfigPath || !expectedInstanceId || !loginName || !projectId) {
  fail(
    "Usage: node frozen-route-live-audit.mjs <instance.json> <expected-instance-id> <login-name> <project-id>",
  );
}
if (loginName.length > 200 || !/^[0-9a-f-]{36}$/iu.test(projectId)) fail("PROBE_IDENTITY_INVALID");

const configPath = resolve(instanceConfigPath);
const config = readJson(configPath);
if (config.schemaVersion !== 1 || config.instanceId !== expectedInstanceId) {
  fail("PREVIEW_INSTANCE_IDENTITY_MISMATCH");
}
if (
  realpathSync(config.sourceRoot) !== realpathSync(SOURCE_ROOT) ||
  config.apiHost !== "127.0.0.1" ||
  !Number.isSafeInteger(config.apiPort) ||
  PRODUCTION_PORTS.has(config.apiPort) ||
  !within(config.runtimeRoot, config.logsRoot)
) {
  fail("PREVIEW_INSTANCE_BOUNDARY_INVALID");
}

const manifestPaths = [
  join(SOURCE_ROOT, "packages/contracts/src/api-manifest.json"),
  join(SOURCE_ROOT, "packages/contracts/versions/1.1.0/src/api-manifest.json"),
];
const operations = manifestPaths.flatMap((manifestPath, index) => {
  const manifest = readJson(manifestPath);
  if (!Array.isArray(manifest.operations)) fail("CONTRACT_MANIFEST_INVALID");
  return manifest.operations.map((operation) => ({
    ...operation,
    contractVersion: index === 0 ? "1.0.0" : "1.1.0",
  }));
});
const identities = operations.map(
  (operation) => `${operation.method.toUpperCase()} ${operation.path}`,
);
if (new Set(identities).size !== identities.length) fail("DUPLICATE_CONTRACT_ROUTE");

const origin = `http://${config.apiHost}:${config.apiPort}`;
const startedAt = new Date().toISOString();
const results = [];
const session = await createProbeSession(origin, loginName, projectId);
let sessionRevokeError = null;
try {
  for (const operation of operations) {
    try {
      results.push(await probe(origin, operation, session));
    } catch (error) {
      results.push({
        contractVersion: operation.contractVersion,
        operationId: operation.operationId,
        method: operation.method.toUpperCase(),
        path: operation.path,
        probePath: normalizeManifestPath(operation.path),
        security: operation.security,
        status: null,
        contentType: null,
        errorCode: null,
        registered: false,
        networkError: error instanceof Error ? error.message : String(error),
      });
    }
  }
} finally {
  try {
    await revokeProbeSession(origin, session);
  } catch (error) {
    sessionRevokeError = error instanceof Error ? error.name : "UNKNOWN_ERROR";
  }
}

const runId = randomUUID();
const outputRoot = join(SOURCE_ROOT, "docs/evidence/project-components/frozen-route-live", runId);
mkdirSync(outputRoot, { recursive: true });
const missing = results.filter((result) => !result.registered);
const requiredOperations = operations.filter(
  (operation) => !HISTORICAL_UNUSED_OPERATIONS.has(operation.operationId),
);
const requiredMissing = missing.filter(
  (result) => !HISTORICAL_UNUSED_OPERATIONS.has(result.operationId),
);
const historicalUnusedMissing = missing
  .map((result) => ({
    ...result,
    reason: HISTORICAL_UNUSED_OPERATIONS.get(result.operationId),
  }))
  .filter((result) => result.reason !== undefined);
const proof = {
  schemaVersion: 1,
  kind: "frozen_contract_live_route_registration",
  runId,
  startedAt,
  completedAt: new Date().toISOString(),
  instance: {
    instanceId: config.instanceId,
    origin,
    configPath,
    configSha256: sha256(configPath),
  },
  source: {
    root: SOURCE_ROOT,
    head: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: SOURCE_ROOT,
      encoding: "utf8",
    }).trim(),
    dirty: Boolean(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: SOURCE_ROOT,
        encoding: "utf8",
      }).trim(),
    ),
    manifests: manifestPaths.map((path) => ({ path, sha256: sha256(path) })),
  },
  probeSafety: {
    authorizationSupplied: true,
    cookieSupplied: false,
    ephemeralPasswordlessPreviewSessionCreated: true,
    ephemeralPasswordlessPreviewSessionRevoked: sessionRevokeError === null,
    sessionRevokeError,
    authenticatedActorId: session.actorId,
    projectId: session.projectId,
    mutationBodyMediaType: PROBE_CONTENT_TYPE,
    purpose:
      "Resolve routing only. Mutating methods carry an unsupported media type so handlers cannot execute.",
  },
  summary: {
    manifestOperations: operations.length,
    currentRequiredOperations: requiredOperations.length,
    currentRequiredRegistered: requiredOperations.length - requiredMissing.length,
    currentRequiredMissing: requiredMissing.length,
    historicalUnusedMissing: historicalUnusedMissing.length,
    pass: requiredMissing.length === 0 && sessionRevokeError === null,
  },
  scopeClassification: {
    historicalUnusedOperations: Object.fromEntries(HISTORICAL_UNUSED_OPERATIONS),
    historicalUnusedMissing,
    currentRequiredMissing: requiredMissing,
  },
  results,
};
const proofPath = join(outputRoot, "proof.json");
writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx" });
console.log(
  JSON.stringify({
    proofPath,
    ...proof.summary,
    currentRequiredMissing: requiredMissing.map((result) => `${result.method} ${result.path}`),
    historicalUnusedMissing: historicalUnusedMissing.map(
      (result) => `${result.method} ${result.path}`,
    ),
  }),
);
if (!proof.summary.pass) process.exitCode = 2;
