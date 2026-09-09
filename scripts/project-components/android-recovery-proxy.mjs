import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const scriptPath = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(scriptPath), "../..");
export const runtimeRoot = "C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86";
export const vendor = "application/vnd.relay-qa-hub.v1.1+json";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const digest = /^[0-9a-f]{64}$/u;
const maxBody = 256 * 1024;
const queryLimits = new Set(["projectId", "state", "limit"]);
const configKeys = [
  "schemaVersion",
  "mode",
  "runId",
  "projectId",
  "actorId",
  "bearerTokenSha256",
  "bootstrapName",
  "listenHost",
  "listenPort",
  "apiOrigin",
  "privateRunDirectory",
  "scriptSha256",
  "requestTimeoutMs",
  "maxRunMs",
  "maxRequests",
];

class ProxyGuardError extends Error {}
function requireThat(condition, code) {
  if (!condition) throw new ProxyGuardError(code); // Codes are fixed literals, never request/header/body values.
}
function object(bytes) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ProxyGuardError("INVALID_JSON");
  }
  requireThat(value && typeof value === "object" && !Array.isArray(value), "INVALID_JSON_OBJECT");
  return value;
}
function beneath(path, root) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
export function validateConfig(config) {
  requireThat(
    config && typeof config === "object" && !Array.isArray(config),
    "CONFIG_OBJECT_REQUIRED",
  );
  requireThat(
    Object.keys(config).sort().join() === [...configKeys].sort().join(),
    "CONFIG_KEYS_REFUSED",
  );
  requireThat(
    config.schemaVersion === 1 && config.mode === "drop-create-201",
    "CONFIG_MODE_REFUSED",
  );
  for (const field of ["runId", "projectId", "actorId"])
    requireThat(uuid.test(config[field]), "CONFIG_UUID_REQUIRED");
  requireThat(digest.test(config.scriptSha256), "CONFIG_HASH_REQUIRED");
  requireThat(
    (digest.test(config.bearerTokenSha256) && config.bootstrapName === null) ||
      (config.bearerTokenSha256 === null &&
        typeof config.bootstrapName === "string" &&
        config.bootstrapName.length > 0 &&
        config.bootstrapName.length <= 100 &&
        config.bootstrapName.trim() === config.bootstrapName),
    "CONFIG_AUTH_MODE_REQUIRED",
  );
  requireThat(
    config.listenHost === "127.0.0.1" && config.apiOrigin === "http://127.0.0.1:4419",
    "CONFIG_ORIGIN_REFUSED",
  );
  requireThat(
    Number.isInteger(config.listenPort) &&
      config.listenPort >= 1024 &&
      config.listenPort <= 65535 &&
      ![4174, 4274, 4319, 4419, 4420, 4421, 5001, 9364, 16384].includes(config.listenPort),
    "CONFIG_PORT_REFUSED",
  );
  requireThat(
    Number.isInteger(config.requestTimeoutMs) &&
      config.requestTimeoutMs >= 1000 &&
      config.requestTimeoutMs <= 30000,
    "CONFIG_TIMEOUT_REFUSED",
  );
  requireThat(
    Number.isInteger(config.maxRunMs) && config.maxRunMs >= 60000 && config.maxRunMs <= 3600000,
    "CONFIG_DEADLINE_REFUSED",
  );
  requireThat(
    Number.isInteger(config.maxRequests) && config.maxRequests >= 5 && config.maxRequests <= 500,
    "CONFIG_REQUEST_LIMIT_REFUSED",
  );
  requireThat(
    typeof config.privateRunDirectory === "string" &&
      isAbsolute(config.privateRunDirectory) &&
      resolve(config.privateRunDirectory) ===
        resolve(runtimeRoot, `android-recovery-proxy-${config.runId}`),
    "CONFIG_PRIVATE_PATH_REFUSED",
  );
  return Object.freeze({ ...config });
}

/** Compile the actual frozen schemas locally; no network resolution or relaxed response schema. */
export function createValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const contracts = join(sourceRoot, "packages/contracts");
  for (const file of readdirSync(join(contracts, "schemas"))) {
    if (file.endsWith(".schema.json"))
      ajv.addSchema(JSON.parse(readFileSync(join(contracts, "schemas", file), "utf8")));
  }
  const app = JSON.parse(
    readFileSync(join(contracts, "versions/1.1.0/schemas/app-first.schema.json"), "utf8"),
  );
  ajv.addSchema(app);
  return {
    request: ajv.getSchema(`${app.$id}#/$defs/createBugRequest`),
    response: ajv.getSchema(`${app.$id}#/$defs/createBugResponse`),
  };
}

/** Transport-independent experiment logic. Tests inject memory-only forwarding and persistence. */
export class DroppedReceiptRun {
  constructor(config, { validators, forward, savePrivate, record, confirmation }) {
    this.config = validateConfig(config);
    this.io = { validators, forward, savePrivate, record, confirmation };
    this.phase = "awaiting_native_request";
    this.dropped = 0;
    this.requests = 0;
    this.forwardedCreates = 0;
    this.denied = 0;
    this.busy = false;
    this.createCompletion = null;
    this.authBusy = false;
    this.authHash = config.bearerTokenSha256;
    this.accountId = null;
    this.bootstrapCount = 0;
    this.emptyProjectObserved = false;
    this.componentsOffObserved = false;
    this.target = null;
    this.receipt = null;
  }
  status() {
    return {
      schemaVersion: 1,
      runId: this.config.runId,
      mode: this.config.mode,
      phase: this.phase,
      projectId: this.config.projectId,
      actorId: this.config.actorId,
      dropped: this.dropped,
      requests: this.requests,
      forwardedCreates: this.forwardedCreates,
      denied: this.denied,
      inFlightCreate: this.busy,
      inFlightAuthentication: this.authBusy,
      authenticationBound: this.authHash !== null,
      bootstrapCount: this.bootstrapCount,
      emptyProjectObserved: this.emptyProjectObserved,
      componentsOffObserved: this.componentsOffObserved,
      target: this.target
        ? {
            clientSubmissionId: this.target.submissionId,
            keySha256: this.target.keySha256,
            bodySha256: this.target.bodySha256,
          }
        : null,
      receipt: this.receipt,
      proxyRetries: 0,
      apkUiGestureProven: false,
    };
  }
  classify(input) {
    const { method, target, headers, body } = input;
    requireThat(
      typeof target === "string" &&
        target.startsWith("/api/v1/") &&
        !target.includes("%") &&
        !target.includes("\\") &&
        !target.includes("#") &&
        !target.includes("//"),
      "PATH_REFUSED",
    );
    requireThat(Buffer.isBuffer(body) && body.length <= maxBody, "REQUEST_SIZE_REFUSED");
    const url = new URL(target, this.config.apiOrigin);
    requireThat(headers.cookie === undefined, "COOKIE_REFUSED");
    requireThat(
      headers["x-qa-actor-id"] === undefined || headers["x-qa-actor-id"] === this.config.actorId,
      "ACTOR_REFUSED",
    );
    requireThat(
      headers["x-qa-project-id"] === undefined ||
        headers["x-qa-project-id"] === this.config.projectId,
      "PROJECT_HEADER_REFUSED",
    );
    const params = [...url.searchParams];
    requireThat(
      new Set(params.map(([key]) => key)).size === params.length,
      "DUPLICATE_QUERY_REFUSED",
    );
    if (
      method === "GET" &&
      url.pathname === `/api/v1/project-entry/${this.config.projectId}` &&
      params.length === 0 &&
      body.length === 0
    )
      return { kind: "project_entry" };
    if (method === "POST" && url.pathname === "/api/v1/auth/login" && params.length === 0) {
      requireThat(
        this.config.bootstrapName !== null && headers.authorization === undefined,
        "BOOTSTRAP_NOT_ALLOWED",
      );
      requireThat(
        headers["content-type"]?.split(";")[0].trim().toLowerCase() === "application/json",
        "BOOTSTRAP_MEDIA_REFUSED",
      );
      const login = object(body);
      requireThat(
        Object.keys(login).sort().join() === ["name", "projectId", "client"].sort().join() &&
          login.name === this.config.bootstrapName &&
          login.projectId === this.config.projectId &&
          login.client === "android",
        "BOOTSTRAP_REQUEST_REFUSED",
      );
      return { kind: "bootstrap" };
    }
    const token = headers.authorization;
    requireThat(
      typeof token === "string" &&
        /^Bearer [^\s]+$/u.test(token) &&
        this.authHash !== null &&
        sha256(token.slice(7)) === this.authHash,
      "AUTH_FINGERPRINT_REFUSED",
    );
    if (method === "POST") {
      requireThat(url.pathname === "/api/v1/bugs" && params.length === 0, "MUTATION_REFUSED");
      requireThat(headers["x-qa-actor-id"] === this.config.actorId, "ACTOR_REQUIRED");
      requireThat(
        headers["content-type"]?.split(";")[0].trim().toLowerCase() === vendor,
        "REQUEST_MEDIA_REFUSED",
      );
      const parsed = object(body);
      requireThat(this.io.validators.request(parsed), "REQUEST_SCHEMA_REFUSED");
      requireThat(parsed.projectId === this.config.projectId, "REQUEST_PROJECT_REFUSED");
      requireThat(
        !parsed.captureBundleId && (parsed.attachmentIds ?? []).length === 0,
        "TEXT_ONLY_MODE",
      );
      requireThat(
        headers["idempotency-key"] === `submission:${parsed.clientSubmissionId}:commit`,
        "REQUEST_KEY_REFUSED",
      );
      return { kind: "create", parsed, key: headers["idempotency-key"] };
    }
    requireThat(method === "GET" && body.length === 0, "METHOD_REFUSED");
    if (
      url.pathname === "/api/v1/projects" &&
      params.length === 1 &&
      url.searchParams.get("limit") === "100"
    )
      return { kind: "project_list" };
    if (url.pathname === "/api/v1/bugs") {
      requireThat(
        url.searchParams.get("projectId") === this.config.projectId &&
          params.every(([key, value]) => queryLimits.has(key) && value.length <= 64),
        "LIST_SCOPE_REFUSED",
      );
      return { kind: "bug_list" };
    }
    const projectRoot = `/api/v1/projects/${this.config.projectId}`;
    if (
      [
        `${projectRoot}/components`,
        `${projectRoot}/users`,
        `${projectRoot}/members`,
        `${projectRoot}/modules`,
      ].includes(url.pathname)
    ) {
      requireThat(
        params.length === 0 ||
          (params.length === 1 &&
            url.searchParams.get("limit") === "100" &&
            url.pathname.endsWith("/members")) ||
          (params.length === 1 &&
            url.searchParams.get("limit") === "500" &&
            url.pathname.endsWith("/users")),
        "PROJECT_QUERY_REFUSED",
      );
      return {
        kind: url.pathname.endsWith("/components")
          ? "components"
          : url.pathname.endsWith("/users")
            ? "project_users"
            : "project_read",
      };
    }
    if (
      this.receipt &&
      url.pathname === `/api/v1/bugs/${this.receipt.bugId}` &&
      params.length === 0
    )
      return { kind: "bug_detail" };
    if (
      this.receipt &&
      ["events", "comments", "attachments", "human-workflow"].some(
        (suffix) => url.pathname === `/api/v1/bugs/${this.receipt.bugId}/${suffix}`,
      )
    ) {
      requireThat(
        params.every(([key, value]) => key === "limit" && /^\d{1,3}$/u.test(value)),
        "BUG_QUERY_REFUSED",
      );
      return { kind: "bound_bug_read" };
    }
    throw new ProxyGuardError("READ_ROUTE_REFUSED");
  }
  validateReceipt(response, parsed) {
    requireThat(response.status === 201, "UPSTREAM_CREATE_NOT_201");
    requireThat(
      response.headers["content-type"]?.split(";")[0].trim().toLowerCase() === vendor &&
        !response.headers["content-encoding"],
      "UPSTREAM_MEDIA_REFUSED",
    );
    const receipt = object(response.body);
    requireThat(this.io.validators.response(receipt), "RECEIPT_SCHEMA_REFUSED");
    requireThat(
      receipt.clientSubmissionId === parsed.clientSubmissionId &&
        receipt.bug.projectId === this.config.projectId &&
        receipt.bug.reporterId === this.config.actorId,
      "RECEIPT_SCOPE_REFUSED",
    );
    requireThat(
      receipt.qaItem.type === "bug" &&
        receipt.qaItem.id === receipt.bug.id &&
        receipt.qaItem.key === receipt.bug.key &&
        receipt.attachmentIds.length === 0 &&
        receipt.captureBundleId === null &&
        receipt.bug.ownerId === (parsed.ownerId ?? null) &&
        receipt.bug.verificationOwnerId === (parsed.verificationOwnerId ?? null),
      "RECEIPT_BINDING_REFUSED",
    );
    const identity = {
      bugId: receipt.bug.id,
      occurrenceId: receipt.occurrenceId,
      eventId: receipt.eventId,
      clientSubmissionId: receipt.clientSubmissionId,
    };
    requireThat(
      !this.receipt || JSON.stringify(identity) === JSON.stringify(this.receipt),
      "REPLAY_IDENTITY_CHANGED",
    );
    return identity;
  }
  async handle(input) {
    let type;
    try {
      requireThat(this.phase !== "failed" && this.phase !== "stopped", "RUN_INACTIVE");
      requireThat(++this.requests <= this.config.maxRequests, "REQUEST_LIMIT_REACHED");
      type = this.classify(input);
      if (type.kind === "bootstrap") return await this.bootstrap(input);
      if (type.kind === "create") return await this.create(input, type);
      // A native list refresh can overlap commit. Wait for its receipt identity before reading.
      if (this.busy) await this.createCompletion;
      requireThat(this.phase !== "failed", "RUN_INACTIVE");
      const response = await this.io.forward(input);
      requireThat(response.body.length <= maxBody, "UPSTREAM_RESPONSE_SIZE_REFUSED");
      if (response.status === 200) {
        const value = object(response.body);
        if (type.kind === "project_entry")
          requireThat(
            value.id === this.config.projectId && value.active === true,
            "READ_PROJECT_REFUSED",
          );
        if (type.kind === "project_list")
          requireThat(
            Array.isArray(value.items) &&
              value.items.length === 1 &&
              value.items[0].id === this.config.projectId &&
              !value.nextCursor,
            "READ_PROJECT_REFUSED",
          );
        if (type.kind === "project_users")
          requireThat(
            value.projectId === this.config.projectId &&
              Array.isArray(value.items) &&
              value.items.length <= 500 &&
              value.items.every(
                (item) =>
                  item &&
                  typeof item === "object" &&
                  uuid.test(item.userId) &&
                  (item.projectId === undefined || item.projectId === this.config.projectId) &&
                  (item.accountId === undefined ||
                    (this.accountId !== null && item.accountId === this.accountId)),
              ),
            "READ_PROJECT_REFUSED",
          );
        if (type.kind === "bug_list") {
          requireThat(
            Array.isArray(value.items) &&
              value.items.every((item) => item.projectId === this.config.projectId),
            "READ_PROJECT_REFUSED",
          );
          if (!this.target) {
            requireThat(
              value.items.length === 0 && !value.nextCursor,
              "FRESH_EMPTY_PROJECT_REQUIRED",
            );
            this.emptyProjectObserved = true;
          } else
            requireThat(
              value.items.every((item) => item.id === this.receipt?.bugId),
              "UNEXPECTED_PROJECT_BUG",
            );
        }
        if (type.kind === "components") {
          requireThat(
            value.projectId === this.config.projectId &&
              Array.isArray(value.items) &&
              value.items.length === 5 &&
              value.items.every((item) => item.enabled === false),
            "COMPONENTS_MUST_STAY_DISABLED",
          );
          this.componentsOffObserved = true;
        }
        if (type.kind === "bug_detail")
          requireThat(
            value.projectId === this.config.projectId && value.id === this.receipt.bugId,
            "READ_PROJECT_REFUSED",
          );
      }
      this.io.record({
        kind: type.kind,
        method: input.method,
        targetSha256: sha256(input.target),
        status: response.status,
        bodySha256: sha256(response.body),
      });
      return { action: "forward", ...response };
    } catch (error) {
      this.denied++;
      const code = safeCode(error);
      // A refused unrelated request never broadens routing. A targeted experiment failure stops writes.
      if (
        ["create", "bootstrap"].includes(type?.kind) ||
        [
          "COMPONENTS_MUST_STAY_DISABLED",
          "FRESH_EMPTY_PROJECT_REQUIRED",
          "UNEXPECTED_PROJECT_BUG",
          "REQUEST_LIMIT_REACHED",
          "READ_PROJECT_REFUSED",
        ].includes(code)
      )
        this.phase = "failed";
      this.io.record({
        kind: "refused",
        code,
        method: ["GET", "POST"].includes(input.method) ? input.method : "other",
        targetSha256: sha256(String(input.target)),
      });
      return { action: "reject", status: 409, code };
    }
  }
  async bootstrap(input) {
    requireThat(!this.busy && !this.authBusy && this.bootstrapCount < 3, "BOOTSTRAP_LIMIT_OR_BUSY");
    this.authBusy = true;
    try {
      const response = await this.io.forward(input);
      requireThat(
        response.status === 200 &&
          Buffer.isBuffer(response.body) &&
          response.body.length <= maxBody,
        "BOOTSTRAP_RESPONSE_REFUSED",
      );
      const session = object(response.body);
      requireThat(
        session.userId === this.config.actorId &&
          session.projectId === this.config.projectId &&
          session.displayName === this.config.bootstrapName &&
          session.isGm === false &&
          uuid.test(session.accountId) &&
          (this.accountId === null || session.accountId === this.accountId),
        "BOOTSTRAP_IDENTITY_REFUSED",
      );
      requireThat(
        typeof session.accessToken === "string" &&
          /^[A-Za-z0-9_-]{43}$/u.test(session.accessToken) &&
          Number.isFinite(Date.parse(session.expiresAt)) &&
          Date.parse(session.expiresAt) > Date.now(),
        "BOOTSTRAP_TOKEN_REFUSED",
      );
      requireThat(
        this.phase !== "failed" && (!input.canDeliver || input.canDeliver()),
        "BOOTSTRAP_DELIVERY_REFUSED",
      );
      this.authHash = sha256(session.accessToken);
      this.accountId = session.accountId;
      this.bootstrapCount++;
      // Do not persist the login request, headers, access token or raw login receipt.
      this.io.record({
        kind: "native_bootstrap",
        status: 200,
        ordinal: this.bootstrapCount,
        projectId: this.config.projectId,
        actorId: this.config.actorId,
      });
      return { action: "forward", ...response };
    } finally {
      this.authBusy = false;
    }
  }
  async create(input, type) {
    requireThat(!this.busy && !this.authBusy, "CONCURRENT_CREATE_REFUSED");
    requireThat(this.phase !== "confirmed", "EXPERIMENT_ALREADY_CONFIRMED");
    requireThat(
      this.emptyProjectObserved && this.componentsOffObserved,
      "READINESS_OBSERVATIONS_REQUIRED",
    );
    const keySha256 = sha256(type.key),
      bodySha256 = sha256(input.body);
    if (this.target)
      requireThat(
        this.target.keySha256 === keySha256 && this.target.bodySha256 === bodySha256,
        "ORIGINAL_INTENT_CHANGED",
      );
    if (this.dropped === 4) {
      const confirmation = this.io.confirmation();
      requireThat(
        confirmation &&
          Object.keys(confirmation).sort().join() ===
            ["runId", "keySha256", "bodySha256", "explicitNativeAction"].sort().join() &&
          confirmation.runId === this.config.runId &&
          confirmation.keySha256 === keySha256 &&
          confirmation.bodySha256 === bodySha256 &&
          confirmation.explicitNativeAction === true,
        "EXPLICIT_NATIVE_CONFIRMATION_REQUIRED",
      );
    }
    this.busy = true;
    let finishCreate;
    this.createCompletion = new Promise((resolveCompletion) => {
      finishCreate = resolveCompletion;
    });
    try {
      if (!this.target) {
        this.io.savePrivate("original-request.json", input.body);
        this.target = { submissionId: type.parsed.clientSubmissionId, keySha256, bodySha256 };
      }
      this.phase = "forwarding_native_create";
      this.forwardedCreates++;
      const response = await this.io.forward(input); // Exactly one call, always caused by this inbound request.
      requireThat(
        Buffer.isBuffer(response.body) && response.body.length <= maxBody,
        "UPSTREAM_RESPONSE_SIZE_REFUSED",
      );
      const privateName = `upstream-create-${this.forwardedCreates}.body`;
      this.io.savePrivate(privateName, response.body); // Durable before suppression; raw bytes stay outside Git.
      requireThat(this.phase !== "failed", "RUN_FAILED_DURING_REQUEST");
      requireThat(!input.canDeliver || input.canDeliver(), "CLIENT_ALREADY_DISCONNECTED");
      const receipt = this.validateReceipt(response, type.parsed);
      this.receipt = receipt;
      const drop = this.dropped < 4;
      if (drop) this.dropped++;
      this.phase = drop
        ? this.dropped === 4
          ? "awaiting_explicit_native_confirmation"
          : "awaiting_native_retry"
        : "confirmed";
      this.io.record({
        kind: "native_create",
        ordinal: this.forwardedCreates,
        upstreamStatus: response.status,
        action: drop ? "drop_before_headers" : "forward_valid_201",
        keySha256,
        bodySha256,
        responseSha256: sha256(response.body),
        privateReceipt: privateName,
        ...receipt,
      });
      return drop ? { action: "drop" } : { action: "forward", ...response };
    } finally {
      this.busy = false;
      finishCreate();
    }
  }
}

function safeCode(error) {
  return error instanceof ProxyGuardError ? error.message : "PROXY_OPERATION_FAILED";
}
function noLinks(path) {
  let current = resolve(path);
  while (true) {
    if (existsSync(current))
      requireThat(!lstatSync(current).isSymbolicLink(), "PRIVATE_PATH_LINK_REFUSED");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function durableNew(path, bytes) {
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function selectedResponseHeaders(headers) {
  return Object.fromEntries(
    ["content-type", "etag", "x-request-id"]
      .filter((name) => typeof headers[name] === "string")
      .map((name) => [name, headers[name]]),
  );
}
function forwardHttp(config, input) {
  return new Promise((accept, reject) => {
    const headers = Object.fromEntries(
      [
        "authorization",
        "accept",
        "content-type",
        "idempotency-key",
        "x-qa-actor-id",
        "x-qa-project-id",
      ]
        .filter((key) => typeof input.headers[key] === "string")
        .map((key) => [key, input.headers[key]]),
    );
    if (input.method === "POST") headers["content-length"] = input.body.length;
    let upstreamResponse;
    const finish = (error, value) => {
      clearTimeout(deadline);
      if (error) reject(error);
      else accept(value);
    };
    const request = httpRequest(
      new URL(input.target, config.apiOrigin),
      { method: input.method, headers, agent: false },
      (response) => {
        upstreamResponse = response;
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBody)
            response.destroy(new ProxyGuardError("UPSTREAM_RESPONSE_SIZE_REFUSED"));
          else chunks.push(chunk);
        });
        response.on("error", finish);
        response.on("end", () =>
          finish(null, {
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    const deadline = setTimeout(() => {
      const error = new ProxyGuardError("UPSTREAM_TIMEOUT");
      upstreamResponse?.destroy(error);
      request.destroy(error);
    }, config.requestTimeoutMs);
    request.on("error", finish);
    request.end(input.method === "POST" ? input.body : undefined);
  });
}

export async function runConfiguredProxy(configPath) {
  requireThat(
    isAbsolute(configPath) && beneath(configPath, runtimeRoot),
    "CONFIG_FILE_PATH_REFUSED",
  );
  noLinks(configPath);
  const config = validateConfig(object(readFileSync(configPath)));
  requireThat(
    config.scriptSha256 === sha256(readFileSync(scriptPath)),
    "REVIEWED_SCRIPT_HASH_REQUIRED",
  );
  const validators = createValidators();
  noLinks(config.privateRunDirectory);
  requireThat(!existsSync(config.privateRunDirectory), "PRIVATE_RUN_ALREADY_EXISTS");
  mkdirSync(config.privateRunDirectory); // Parent must already exist; no recursive path creation.
  const privateDir = config.privateRunDirectory;
  const publicLog = join(privateDir, "public-events.jsonl");
  const logFd = openSync(publicLog, "wx");
  let sequence = 0,
    stopping = false,
    stopPromise;
  const append = (value) => {
    writeFileSync(
      logFd,
      JSON.stringify({ sequence: ++sequence, at: new Date().toISOString(), ...value }) + "\n",
    );
    fsyncSync(logFd);
  };
  const readControl = (name) => {
    const path = join(privateDir, name);
    if (!existsSync(path)) return null;
    noLinks(path);
    requireThat(lstatSync(path).size <= 2048, "CONTROL_SIZE_REFUSED");
    return object(readFileSync(path));
  };
  const run = new DroppedReceiptRun(config, {
    validators,
    forward: (input) => forwardHttp(config, input),
    savePrivate: (name, bytes) => durableNew(join(privateDir, name), bytes),
    record: append,
    confirmation: () => readControl("confirm-native-action.json"),
  });
  const status = () => ({
    ...run.status(),
    listenHost: config.listenHost,
    listenPort: config.listenPort,
    stopping,
    scriptSha256: config.scriptSha256,
    sourceCommitRecordedSeparately: true,
  });
  const persistStatus = () => {
    const temporary = join(privateDir, `status-${++sequence}.tmp`);
    durableNew(temporary, JSON.stringify(status(), null, 2) + "\n");
    renameSync(temporary, join(privateDir, "status.json"));
  };
  const inFlight = new Set();
  const handleHttp = async (request, response) => {
    if (stopping) {
      response.writeHead(503);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/_qa_proxy/status") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(status()));
      return;
    }
    try {
      for (const name of [
        "authorization",
        "idempotency-key",
        "x-qa-project-id",
        "x-qa-actor-id",
        "content-length",
        "transfer-encoding",
        "host",
      ])
        requireThat(
          request.rawHeaders
            .filter((_, index) => index % 2 === 0)
            .filter((key) => key.toLowerCase() === name).length <= 1,
          "DUPLICATE_HEADER_REFUSED",
        );
      requireThat(request.headers["transfer-encoding"] === undefined, "TRANSFER_ENCODING_REFUSED");
      request.setTimeout(5000, () => request.destroy());
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        requireThat(size <= maxBody, "REQUEST_SIZE_REFUSED");
        chunks.push(chunk);
      }
      const result = await run.handle({
        method: request.method,
        target: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks),
        canDeliver: () => !request.socket.destroyed && !response.destroyed,
      });
      persistStatus();
      if (result.action === "drop") {
        request.socket.destroy();
        return;
      }
      if (result.action === "forward") {
        response.writeHead(result.status, {
          ...selectedResponseHeaders(result.headers),
          "content-length": result.body.length,
        });
        response.end(result.body);
      } else {
        response.writeHead(result.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: result.code }));
      }
    } catch (error) {
      run.phase = "failed";
      append({ kind: "adapter_failure", code: safeCode(error) });
      persistStatus();
      if (!response.destroyed) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "PROXY_OPERATION_FAILED" }));
      }
    }
  };
  const server = createServer((request, response) => {
    const work = handleHttp(request, response);
    inFlight.add(work);
    void work
      .finally(() => inFlight.delete(work))
      .catch(() => {
        request.socket.destroy();
      });
  });
  server.maxConnections = 16;
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 1000;
  server.on("clientError", (_, socket) => socket.destroy());
  let deadline, controlTimer;
  const stop = (reason) =>
    (stopPromise ??= (async () => {
      stopping = true;
      clearTimeout(deadline);
      clearInterval(controlTimer);
      append({ kind: "stop_requested", reason });
      persistStatus();
      const force = setTimeout(() => server.closeAllConnections(), config.requestTimeoutMs + 1000);
      await new Promise((resolveClose) => server.close(resolveClose));
      await Promise.allSettled([...inFlight]);
      clearTimeout(force);
      append({ kind: "stopped", finalPhase: run.phase });
      persistStatus();
      closeSync(logFd);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      return status();
    })());
  const onInterrupt = () => {
    void stop("SIGINT");
  };
  const onTerminate = () => {
    void stop("SIGTERM");
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(config.listenPort, config.listenHost, resolveListen);
    });
    append({
      kind: "listening",
      runId: config.runId,
      port: config.listenPort,
      scriptSha256: config.scriptSha256,
    });
    persistStatus();
    console.log(
      JSON.stringify({
        state: "listening",
        runId: config.runId,
        statusFile: join(privateDir, "status.json"),
        port: config.listenPort,
      }),
    );
    deadline = setTimeout(() => {
      void stop("deadline");
    }, config.maxRunMs);
    controlTimer = setInterval(() => {
      try {
        const control = readControl("stop.json");
        if (control) {
          requireThat(
            control.runId === config.runId && control.stop === true,
            "STOP_CONTROL_REFUSED",
          );
          void stop("operator_file");
        }
      } catch {
        run.phase = "failed";
        void stop("invalid_control");
      }
    }, 250);
  } catch (error) {
    run.phase = "failed";
    await stop(safeCode(error));
    throw new ProxyGuardError("PROXY_START_FAILED", { cause: error });
  }
  return { run, server, stop };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  if (process.argv[2] !== "--run") {
    console.log(
      "not_run: requires --run <absolute private config>; no port opened, no API or device operation",
    );
  } else {
    assert.equal(process.argv.length, 4);
    await runConfiguredProxy(process.argv[3]).catch((error) => {
      console.error(safeCode(error));
      process.exitCode = 1;
    });
  }
}
// No import-time server creation, outbound request, subprocess, device or fixture-directory mutation.
