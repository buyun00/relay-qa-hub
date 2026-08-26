import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { MobileRelayOutboxClaim, SqliteStorageWorker } from "@relay-qa-hub/storage";

export const REAL_RELAY_HANDOFF_PATH = "/api/integrations/qa/v1/handoffs" as const;

const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const MAX_QA_INSTANCE_ID_LENGTH = 64;
const MAX_SAFE_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 20_000;
const MAX_CRITERIA_LENGTH = 10_000;
const MAX_ATTACHMENT_COUNT = 8;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 255;
const MAX_MEDIA_TYPE_LENGTH = 100;
const RELAY_RETRY_BASE_MS = 5_000;
const RELAY_RETRY_MAX_MS = 5 * 60_000;
const RELAY_RETRY_AFTER_MAX_MS = 24 * 60 * 60_000;
const RELAY_MAX_DELIVERY_ATTEMPTS = 8;

const QA_INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const DEFECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]*$/u;
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,15}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const INLINE_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;
const ALLOWED_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "application/json",
  "application/zip",
]);

/** Facts needed to construct the Relay defect portion of a handoff. */
export interface RealRelayDefectFacts {
  readonly id: string;
  readonly key: string;
  readonly revision: number;
  readonly projectKey: string;
  readonly title: string;
  readonly description: string;
  readonly severity: "S0" | "S1" | "S2" | "S3" | "S4";
  readonly verificationCriteria: string;
}

/**
 * A selected attachment is a QA Hub storage fact, never a path or URL to send
 * to Relay. The client reads `storageKey` through the configured narrow
 * reader/evidence root and sends only verified metadata plus inline bytes.
 */
export interface RealRelayAttachmentFact {
  readonly attachmentId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly storageKey: string;
}

export interface RealRelayAttachment {
  readonly attachmentId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentBase64: string;
}

export interface RealRelayHandoffBody {
  readonly qaInstanceId: string;
  readonly handoffId: string;
  readonly attemptId: string;
  readonly defect: RealRelayDefectFacts;
  readonly selectedAttachments: readonly RealRelayAttachment[];
}

export interface RealRelayContinueBody {
  readonly qaInstanceId: string;
  readonly actionId: string;
  readonly attemptId: string;
  readonly prompt: string;
  readonly selectedAttachments: readonly RealRelayAttachment[];
}

export interface RealRelayWorkspaceReceipt {
  readonly projectId: string;
  readonly branchName: string | null;
  readonly threadId: string | null;
}

export interface RealRelayHandoffReceipt {
  readonly relayInstanceId: string;
  readonly handoffId: string;
  readonly attemptId: string;
  readonly actionId?: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly status?: string;
  readonly branchName: string | null;
  readonly threadId: string | null;
  readonly workspace: RealRelayWorkspaceReceipt;
  readonly requestHash: string;
  readonly replayed: boolean;
}

export type RealRelayAttachmentReader = (
  fact: RealRelayAttachmentFact,
) => Uint8Array | Promise<Uint8Array>;

/**
 * The storage claim is deliberately projected here instead of coupling this
 * HTTP client to storage's SQL representation. The storage worker supplies
 * these facts when the real Relay outbox lane is enabled.
 */
type RealRelayClaimProjection = MobileRelayOutboxClaim & {
  readonly kind?: "create" | "continue";
  readonly defectFacts?: unknown;
  readonly selectedAttachmentFacts?: unknown;
};

export interface MobileRelayOutboxPump {
  stop(): Promise<void>;
}

export interface MobileRelayOutboxPumpOptions {
  readonly worker: SqliteStorageWorker;
  readonly endpoint: URL;
  /** A scoped M2M token supplied by the caller; it is never logged or persisted. */
  readonly bearerToken: string;
  /** Fallback for claims produced before qaInstanceId was added to the claim. */
  readonly qaInstanceId?: string;
  /** Root of QA Hub's evidence store. Only ordinary contained files are read. */
  readonly evidenceRoot?: string;
  /** Preferred narrow attachment reader. It receives facts, not paths or URLs. */
  readonly readAttachment?: RealRelayAttachmentReader;
  readonly onDelivery?: (
    claim: MobileRelayOutboxClaim,
    status: "submitted",
    receipt: RealRelayHandoffReceipt,
  ) => void;
  readonly onRetry?: (
    claim: MobileRelayOutboxClaim,
    errorCode: string,
    schedule: { readonly deadLetter: boolean; readonly nextAttemptAt: string },
  ) => void;
}

class RealRelayClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RealRelayClientError";
    this.code = code;
  }
}

class RealRelayHttpError extends RealRelayClientError {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, retryAfterMs: number | null) {
    super(`REAL_RELAY_HTTP_${status}`);
    this.name = "RealRelayHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function clientError(code: string): never {
  throw new RealRelayClientError(code);
}

function requireString(
  value: unknown,
  code: string,
  maximumLength: number,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    clientError(code);
  }
  return value;
}

function requirePositiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) clientError(code);
  return value as number;
}

function requireObject(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) clientError(code);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, code: string): readonly unknown[] {
  if (!Array.isArray(value)) clientError(code);
  return value;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  code: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) clientError(code);
  }
}

function requireSha256(value: unknown, code: string): string {
  return requireString(value, code, 64, SHA256_PATTERN);
}

function canonicalize(value: unknown, parentKey: string | null = null): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) clientError("REAL_RELAY_PAYLOAD_INVALID");
    return value;
  }
  if (value === undefined) clientError("REAL_RELAY_PAYLOAD_INVALID");
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, parentKey));
  if (typeof value !== "object") clientError("REAL_RELAY_PAYLOAD_INVALID");
  const object = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) {
    // Relay intentionally excludes rotating signed URLs from its hash.
    if (parentKey === "selectedAttachments" && key === "downloadUrl") continue;
    result[key] = canonicalize(object[key], key);
  }
  return result;
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function isContainedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

async function readContainedEvidenceFile(evidenceRoot: string, storageKey: string): Promise<Buffer> {
  if (storageKey.length < 1 || storageKey.includes("\0") || isAbsolute(storageKey)) {
    clientError("REAL_RELAY_ATTACHMENT_PATH_INVALID");
  }
  try {
    const rootPath = await realpath(evidenceRoot);
    let candidatePath = resolve(rootPath, storageKey);
    if (!isContainedPath(rootPath, candidatePath)) {
      clientError("REAL_RELAY_ATTACHMENT_PATH_INVALID");
    }
    candidatePath = await realpath(candidatePath);
    if (!isContainedPath(rootPath, candidatePath)) {
      clientError("REAL_RELAY_ATTACHMENT_PATH_INVALID");
    }
    const metadata = await stat(candidatePath);
    if (!metadata.isFile()) clientError("REAL_RELAY_ATTACHMENT_NOT_REGULAR_FILE");
    return await readFile(candidatePath);
  } catch (error: unknown) {
    if (error instanceof RealRelayClientError) throw error;
    clientError("REAL_RELAY_ATTACHMENT_READ_FAILED");
  }
}

function normalizeDefect(value: unknown): RealRelayDefectFacts {
  const defect = requireObject(value, "REAL_RELAY_DEFECT_INVALID");
  requireExactKeys(
    defect,
    new Set([
      "id",
      "key",
      "revision",
      "projectKey",
      "title",
      "description",
      "severity",
      "verificationCriteria",
      "expectedBehavior",
      "projectId",
      "number",
      "moduleId",
      "priority",
      "state",
      "version",
    ]),
    "REAL_RELAY_DEFECT_INVALID",
  );
  const verificationCriteria = defect["verificationCriteria"] ?? defect["expectedBehavior"];
  return Object.freeze({
    id: requireString(defect["id"], "REAL_RELAY_DEFECT_ID_INVALID", MAX_SAFE_ID_LENGTH, SAFE_ID_PATTERN),
    key: requireString(defect["key"], "REAL_RELAY_DEFECT_KEY_INVALID", 32, DEFECT_KEY_PATTERN),
    revision: requirePositiveInteger(defect["revision"], "REAL_RELAY_DEFECT_REVISION_INVALID"),
    projectKey: requireString(
      defect["projectKey"],
      "REAL_RELAY_DEFECT_PROJECT_INVALID",
      16,
      PROJECT_KEY_PATTERN,
    ),
    title: requireString(defect["title"], "REAL_RELAY_DEFECT_TITLE_INVALID", MAX_TITLE_LENGTH),
    description: requireString(
      defect["description"],
      "REAL_RELAY_DEFECT_DESCRIPTION_INVALID",
      MAX_DESCRIPTION_LENGTH,
    ),
    severity: requireString(defect["severity"], "REAL_RELAY_DEFECT_SEVERITY_INVALID", 2, /^S[0-4]$/u) as
      | "S0"
      | "S1"
      | "S2"
      | "S3"
      | "S4",
    verificationCriteria: requireString(
      verificationCriteria,
      "REAL_RELAY_DEFECT_CRITERIA_INVALID",
      MAX_CRITERIA_LENGTH,
    ),
  });
}

function normalizeAttachmentFact(value: unknown, index: number): RealRelayAttachmentFact {
  const fact = requireObject(value, "REAL_RELAY_ATTACHMENT_FACT_INVALID");
  requireExactKeys(
    fact,
    new Set([
      "attachmentId",
      "filename",
      "mediaType",
      "contentType",
      "size",
      "sha256",
      "storageKey",
      "projectId",
      "captureId",
      "clientSubmissionId",
      "clientAttachmentId",
      "scanStatus",
      "readyToBind",
      "bindingStatus",
      "version",
    ]),
    "REAL_RELAY_ATTACHMENT_FACT_INVALID",
  );
  const mediaType = fact["mediaType"] ?? fact["contentType"];
  const parsedMediaType = requireString(
    mediaType,
    "REAL_RELAY_ATTACHMENT_MEDIA_TYPE_INVALID",
    MAX_MEDIA_TYPE_LENGTH,
  );
  if (!ALLOWED_MEDIA_TYPES.has(parsedMediaType)) clientError("REAL_RELAY_ATTACHMENT_MEDIA_TYPE_INVALID");
  const size = requirePositiveInteger(fact["size"], "REAL_RELAY_ATTACHMENT_SIZE_INVALID");
  if (size > MAX_ATTACHMENT_BYTES) clientError("REAL_RELAY_ATTACHMENT_TOO_LARGE");
  if (fact["scanStatus"] !== undefined && fact["scanStatus"] !== "clean") {
    clientError("REAL_RELAY_ATTACHMENT_NOT_VERIFIED");
  }
  if (fact["readyToBind"] !== undefined && fact["readyToBind"] !== true) {
    clientError("REAL_RELAY_ATTACHMENT_NOT_VERIFIED");
  }
  if (fact["bindingStatus"] !== undefined && fact["bindingStatus"] !== "claimed") {
    clientError("REAL_RELAY_ATTACHMENT_NOT_VERIFIED");
  }
  const storageKey = requireString(fact["storageKey"], "REAL_RELAY_ATTACHMENT_STORAGE_KEY_INVALID", 4_096);
  if (storageKey.includes("\0") || isAbsolute(storageKey)) {
    clientError("REAL_RELAY_ATTACHMENT_STORAGE_KEY_INVALID");
  }
  return Object.freeze({
    attachmentId: requireString(
      fact["attachmentId"],
      `REAL_RELAY_ATTACHMENT_${index}_ID_INVALID`,
      MAX_SAFE_ID_LENGTH,
      SAFE_ID_PATTERN,
    ),
    filename: requireString(fact["filename"], "REAL_RELAY_ATTACHMENT_FILENAME_INVALID", MAX_FILENAME_LENGTH),
    mediaType: parsedMediaType,
    size,
    sha256: requireSha256(fact["sha256"], "REAL_RELAY_ATTACHMENT_SHA256_INVALID"),
    storageKey,
  });
}

function claimProjection(claim: MobileRelayOutboxClaim): RealRelayClaimProjection {
  return claim as RealRelayClaimProjection;
}

function claimKind(claim: RealRelayClaimProjection): "create" | "continue" {
  const kind = claim.kind ?? claim.operation ?? "create";
  if (kind !== "create" && kind !== "continue") clientError("REAL_RELAY_OUTBOX_KIND_INVALID");
  return kind;
}

function claimQaInstanceId(
  claim: RealRelayClaimProjection,
  options: MobileRelayOutboxPumpOptions,
): string {
  return requireString(
    claim.qaInstanceId ?? options.qaInstanceId,
    "REAL_RELAY_QA_INSTANCE_ID_INVALID",
    MAX_QA_INSTANCE_ID_LENGTH,
    QA_INSTANCE_ID_PATTERN,
  );
}

function claimAttachments(claim: RealRelayClaimProjection): readonly RealRelayAttachmentFact[] {
  const raw = claim.selectedAttachments ?? claim.selectedAttachmentFacts;
  if (raw === undefined) {
    if (claim.selectedAttachmentIds.length !== 0) clientError("REAL_RELAY_ATTACHMENT_FACTS_MISSING");
    return Object.freeze([]);
  }
  const entries = requireArray(raw, "REAL_RELAY_ATTACHMENT_FACTS_INVALID");
  if (entries.length > MAX_ATTACHMENT_COUNT) clientError("REAL_RELAY_ATTACHMENT_COUNT_INVALID");
  return Object.freeze(entries.map((entry, index) => normalizeAttachmentFact(entry, index)));
}

async function materializeAttachments(
  facts: readonly RealRelayAttachmentFact[],
  options: MobileRelayOutboxPumpOptions,
): Promise<readonly RealRelayAttachment[]> {
  let totalBytes = 0;
  const result: RealRelayAttachment[] = [];
  for (const fact of facts) {
    totalBytes += fact.size;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) clientError("REAL_RELAY_ATTACHMENTS_TOO_LARGE");
    let bytes: Uint8Array;
    try {
      bytes = options.readAttachment
        ? await options.readAttachment(fact)
        : options.evidenceRoot
          ? await readContainedEvidenceFile(options.evidenceRoot, fact.storageKey)
          : clientError("REAL_RELAY_ATTACHMENT_READER_NOT_CONFIGURED");
    } catch (error: unknown) {
      if (error instanceof RealRelayClientError) throw error;
      clientError("REAL_RELAY_ATTACHMENT_READ_FAILED");
    }
    if (!(bytes instanceof Uint8Array)) clientError("REAL_RELAY_ATTACHMENT_READ_FAILED");
    const buffer = Buffer.from(bytes);
    if (buffer.length !== fact.size) clientError("REAL_RELAY_ATTACHMENT_SIZE_MISMATCH");
    if (createHash("sha256").update(buffer).digest("hex") !== fact.sha256) {
      clientError("REAL_RELAY_ATTACHMENT_HASH_MISMATCH");
    }
    result.push({
      attachmentId: fact.attachmentId,
      filename: fact.filename,
      mediaType: fact.mediaType,
      size: fact.size,
      sha256: fact.sha256,
      contentBase64: buffer.toString("base64"),
    });
  }
  return Object.freeze(result);
}

async function buildCreateBody(
  claim: RealRelayClaimProjection,
  options: MobileRelayOutboxPumpOptions,
): Promise<{ readonly body: RealRelayHandoffBody; readonly requestHash: string }> {
  const body: RealRelayHandoffBody = Object.freeze({
    qaInstanceId: claimQaInstanceId(claim, options),
    handoffId: requireString(claim.handoffId, "REAL_RELAY_HANDOFF_ID_INVALID", MAX_SAFE_ID_LENGTH, SAFE_ID_PATTERN),
    attemptId: requireString(claim.repairAttemptId, "REAL_RELAY_ATTEMPT_ID_INVALID", MAX_SAFE_ID_LENGTH, SAFE_ID_PATTERN),
    defect: normalizeDefect(claim.defect ?? claim.defectFacts),
    selectedAttachments: await materializeAttachments(claimAttachments(claim), options),
  });
  return { body, requestHash: requestHash(body) };
}

async function buildContinueBody(
  claim: RealRelayClaimProjection,
  options: MobileRelayOutboxPumpOptions,
): Promise<{ readonly body: RealRelayContinueBody; readonly requestHash: string }> {
  const body: RealRelayContinueBody = Object.freeze({
    qaInstanceId: claimQaInstanceId(claim, options),
    actionId: requireString(claim.actionId, "REAL_RELAY_ACTION_ID_INVALID", MAX_SAFE_ID_LENGTH, SAFE_ID_PATTERN),
    attemptId: requireString(claim.repairAttemptId, "REAL_RELAY_ATTEMPT_ID_INVALID", MAX_SAFE_ID_LENGTH, SAFE_ID_PATTERN),
    prompt: requireString(claim.prompt, "REAL_RELAY_PROMPT_INVALID", MAX_DESCRIPTION_LENGTH),
    selectedAttachments: await materializeAttachments(claimAttachments(claim), options),
  });
  return { body, requestHash: requestHash(body) };
}

function expectedIdempotencyKey(
  claim: RealRelayClaimProjection,
  body: RealRelayHandoffBody | RealRelayContinueBody,
): string {
  const key = requireString(claim.idempotencyKey, "REAL_RELAY_IDEMPOTENCY_KEY_INVALID", MAX_IDEMPOTENCY_KEY_LENGTH);
  const expected = "actionId" in body
    ? `qa:${body.qaInstanceId}:action:${body.actionId}`
    : `qa:${body.qaInstanceId}:handoff:${body.handoffId}`;
  if (key !== expected) clientError("REAL_RELAY_IDEMPOTENCY_KEY_MISMATCH");
  return key;
}

function endpointForOperation(endpoint: URL, claim: RealRelayClaimProjection, kind: "create" | "continue"): URL {
  if (kind === "create") return endpoint;
  const target = new URL(endpoint.href);
  target.pathname = `${endpoint.pathname}/${encodeURIComponent(claim.handoffId)}/turns`;
  return target;
}

function requireReceiptString(value: unknown, code: string, maximumLength: number): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return String(value);
  return requireString(value, code, maximumLength);
}

function parseWorkspace(value: unknown): RealRelayWorkspaceReceipt {
  const workspace = requireObject(value, "REAL_RELAY_RECEIPT_WORKSPACE_INVALID");
  requireExactKeys(workspace, new Set(["projectId", "branchName", "threadId"]), "REAL_RELAY_RECEIPT_WORKSPACE_INVALID");
  const branchName = workspace["branchName"];
  const threadId = workspace["threadId"];
  if (branchName !== null && typeof branchName !== "string") clientError("REAL_RELAY_RECEIPT_WORKSPACE_INVALID");
  if (threadId !== null && typeof threadId !== "string") clientError("REAL_RELAY_RECEIPT_WORKSPACE_INVALID");
  return Object.freeze({
    projectId: requireString(workspace["projectId"], "REAL_RELAY_RECEIPT_WORKSPACE_INVALID", MAX_SAFE_ID_LENGTH),
    branchName: branchName === null ? null : requireString(branchName, "REAL_RELAY_RECEIPT_WORKSPACE_INVALID", 300),
    threadId: threadId === null ? null : requireString(threadId, "REAL_RELAY_RECEIPT_WORKSPACE_INVALID", MAX_SAFE_ID_LENGTH),
  });
}

export function parseRealRelayReceipt(
  text: string,
  claim: MobileRelayOutboxClaim,
  expectedRequestHash: string,
): RealRelayHandoffReceipt {
  if (Buffer.byteLength(text, "utf8") > MAX_RECEIPT_BYTES) clientError("REAL_RELAY_RECEIPT_TOO_LARGE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    clientError("REAL_RELAY_INVALID_RECEIPT");
  }
  const receipt = requireObject(parsed, "REAL_RELAY_INVALID_RECEIPT");
  requireExactKeys(
    receipt,
    new Set([
      "relayInstanceId",
      "handoffId",
      "attemptId",
      "actionId",
      "taskId",
      "turnId",
      "initialTurnId",
      "status",
      "branchName",
      "threadId",
      "workspace",
      "requestHash",
      "replayed",
    ]),
    "REAL_RELAY_RECEIPT_INVALID",
  );
  const projection = claimProjection(claim);
  const kind = claimKind(projection);
  const parsedHandoffId = requireString(receipt["handoffId"], "REAL_RELAY_RECEIPT_HANDOFF_MISMATCH", MAX_SAFE_ID_LENGTH, SAFE_ID_PATTERN);
  const parsedAttemptId = requireString(receipt["attemptId"], "REAL_RELAY_RECEIPT_ATTEMPT_MISMATCH", MAX_SAFE_ID_LENGTH, SAFE_ID_PATTERN);
  if (parsedHandoffId !== claim.handoffId || parsedAttemptId !== claim.repairAttemptId) {
    clientError("REAL_RELAY_RECEIPT_IDENTITY_MISMATCH");
  }
  const actionId = receipt["actionId"] === undefined
    ? undefined
    : requireString(receipt["actionId"], "REAL_RELAY_RECEIPT_ACTION_MISMATCH", MAX_SAFE_ID_LENGTH, SAFE_ID_PATTERN);
  if (kind === "continue" && actionId !== projection.actionId) clientError("REAL_RELAY_RECEIPT_ACTION_MISMATCH");
  const responseHash = requireSha256(receipt["requestHash"], "REAL_RELAY_RECEIPT_HASH_INVALID");
  if (responseHash !== expectedRequestHash) clientError("REAL_RELAY_RECEIPT_HASH_MISMATCH");
  const replayed = receipt["replayed"];
  if (typeof replayed !== "boolean") clientError("REAL_RELAY_RECEIPT_REPLAYED_INVALID");
  const branchName = receipt["branchName"];
  const threadId = receipt["threadId"];
  if (branchName !== null && typeof branchName !== "string") clientError("REAL_RELAY_RECEIPT_INVALID");
  if (threadId !== null && typeof threadId !== "string") clientError("REAL_RELAY_RECEIPT_INVALID");
  const status = receipt["status"];
  if (status !== undefined && (typeof status !== "string" || status.length < 1 || status.length > 64)) {
    clientError("REAL_RELAY_RECEIPT_INVALID");
  }
  return Object.freeze({
    relayInstanceId: requireString(receipt["relayInstanceId"], "REAL_RELAY_RECEIPT_INSTANCE_INVALID", 64, /^[a-z0-9][a-z0-9_-]{2,63}$/u),
    handoffId: parsedHandoffId,
    attemptId: parsedAttemptId,
    ...(actionId === undefined ? {} : { actionId }),
    taskId: requireReceiptString(receipt["taskId"], "REAL_RELAY_RECEIPT_TASK_INVALID", MAX_SAFE_ID_LENGTH),
    turnId: requireReceiptString(receipt["turnId"], "REAL_RELAY_RECEIPT_TURN_INVALID", MAX_SAFE_ID_LENGTH),
    ...(status === undefined ? {} : { status }),
    branchName: branchName === null ? null : requireString(branchName, "REAL_RELAY_RECEIPT_INVALID", 300),
    threadId: threadId === null ? null : requireString(threadId, "REAL_RELAY_RECEIPT_INVALID", MAX_SAFE_ID_LENGTH),
    workspace: parseWorkspace(receipt["workspace"]),
    requestHash: responseHash,
    replayed,
  });
}

export function parseRelayEndpoint(value: string | undefined): URL | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    clientError("REAL_RELAY_ENDPOINT_INVALID");
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.pathname !== REAL_RELAY_HANDOFF_PATH
  ) {
    clientError("REAL_RELAY_ENDPOINT_INVALID");
  }
  return endpoint;
}

function assertRelayEndpoint(endpoint: URL): void {
  parseRelayEndpoint(endpoint.href);
}

function deliveryErrorCode(error: unknown): string {
  if (error instanceof RealRelayClientError) return error.code;
  if (error instanceof DOMException && error.name === "TimeoutError") return "REAL_RELAY_TIMEOUT";
  if (error instanceof TypeError) return "REAL_RELAY_UNAVAILABLE";
  return "REAL_RELAY_UNAVAILABLE";
}

function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (normalized === "") return null;
  if (/^\d+$/u.test(normalized)) {
    const seconds = Number(normalized);
    if (!Number.isSafeInteger(seconds)) return null;
    return Math.min(seconds * 1_000, RELAY_RETRY_AFTER_MAX_MS);
  }
  const retryAtMs = Date.parse(normalized);
  if (!Number.isFinite(retryAtMs)) return null;
  return Math.min(Math.max(0, retryAtMs - nowMs), RELAY_RETRY_AFTER_MAX_MS);
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function exponentialRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 20));
  return Math.min(RELAY_RETRY_BASE_MS * 2 ** exponent, RELAY_RETRY_MAX_MS);
}

function deliveryFailurePlan(
  error: unknown,
  attemptCount: number,
  failedAt: Date,
): {
  readonly errorCode: string;
  readonly deadLetter: boolean;
  readonly nextAttemptAt: string;
} {
  const retryable =
    error instanceof RealRelayHttpError
      ? isRetryableHttpStatus(error.status)
      : !(error instanceof RealRelayClientError);
  const deadLetter = !retryable || attemptCount >= RELAY_MAX_DELIVERY_ATTEMPTS;
  const retryAfterMs = error instanceof RealRelayHttpError ? error.retryAfterMs : null;
  const delayMs = deadLetter
    ? 0
    : Math.max(exponentialRetryDelayMs(attemptCount), retryAfterMs ?? 0);
  return Object.freeze({
    errorCode: deliveryErrorCode(error),
    deadLetter,
    nextAttemptAt: new Date(failedAt.getTime() + delayMs).toISOString(),
  });
}

function completionPayload(
  claim: MobileRelayOutboxClaim,
  leaseOwner: string,
  receipt: RealRelayHandoffReceipt,
): Parameters<SqliteStorageWorker["completeMobileRelayOutbox"]>[0] {
  return {
    outboxMessageId: claim.outboxMessageId,
    leaseOwner,
    relayTaskId: receipt.taskId,
    handoffStatus: "submitted",
    externalRevision: 1,
    lastEventAt: new Date().toISOString(),
    payloadDigest: claim.payloadDigest,
    receivedAt: new Date().toISOString(),
    relayInstanceId: receipt.relayInstanceId,
    relayTurnId: receipt.turnId,
    branch: receipt.branchName,
    threadId: receipt.threadId,
    workspace: receipt.workspace,
    requestHash: receipt.requestHash,
  };
}

async function deliverOne(
  options: MobileRelayOutboxPumpOptions,
  leaseOwner: string,
): Promise<boolean> {
  const now = new Date();
  const claim = await options.worker.claimMobileRelayOutbox({
    leaseOwner,
    now: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + 5_000).toISOString(),
  });
  if (claim === null) return false;

  try {
    if (options.bearerToken.length < 1 || /\s/u.test(options.bearerToken)) {
      clientError("REAL_RELAY_AUTH_INVALID");
    }
    const projection = claimProjection(claim);
    const kind = claimKind(projection);
    const built = kind === "create"
      ? await buildCreateBody(projection, options)
      : await buildContinueBody(projection, options);
    const idempotencyKey = expectedIdempotencyKey(projection, built.body);
    const endpoint = endpointForOperation(options.endpoint, projection, kind);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.bearerToken}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(built.body),
      signal: AbortSignal.timeout(1_500),
    });
    if (response.status !== 202) {
      const failedAtMs = Date.now();
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), failedAtMs);
      try {
        await response.body?.cancel();
      } catch {
        // The HTTP status remains the delivery fact even if body cancellation fails.
      }
      throw new RealRelayHttpError(response.status, retryAfterMs);
    }
    const receipt = parseRealRelayReceipt(await response.text(), claim, built.requestHash);
    await options.worker.completeMobileRelayOutbox(completionPayload(claim, leaseOwner, receipt));
    options.onDelivery?.(claim, "submitted", receipt);
  } catch (error: unknown) {
    const failure = deliveryFailurePlan(error, claim.attemptCount, new Date());
    await options.worker.retryMobileRelayOutbox({
      outboxMessageId: claim.outboxMessageId,
      leaseOwner,
      errorCode: failure.errorCode,
      nextAttemptAt: failure.nextAttemptAt,
      deadLetter: failure.deadLetter,
    });
    options.onRetry?.(claim, failure.errorCode, {
      deadLetter: failure.deadLetter,
      nextAttemptAt: failure.nextAttemptAt,
    });
  }
  return true;
}

export function startMobileRelayOutboxPump(
  options: MobileRelayOutboxPumpOptions,
): MobileRelayOutboxPump {
  assertRelayEndpoint(options.endpoint);
  const leaseOwner = `qa-hub-api-${randomUUID()}`;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active = Promise.resolve();

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      active = deliverOne(options, leaseOwner)
        .then((delivered) => schedule(delivered ? 0 : 100))
        .catch(() => schedule(250));
    }, delayMs);
    timer.unref();
  };
  schedule(0);

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      await active;
    },
  };
}
