import { createHash } from "node:crypto";

export const MOBILE_UPLOAD_INIT_PATH = "/api/v1/uploads/init" as const;
export const MOBILE_UPLOAD_CHUNK_PATH = "/api/v1/uploads/:sessionId/chunks/:chunkNumber" as const;
export const MOBILE_UPLOAD_FINALIZE_PATH = "/api/v1/uploads/:sessionId/finalize" as const;
export const MOBILE_ATTACHMENT_BIND_PATH = "/api/v1/attachments/:attachmentId/bind" as const;
export const MAX_MOBILE_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

export type MobileAttachmentIntent =
  "bug_create" | "occurrence_append" | "comment_append" | "verification_result";

export interface MobileInitUploadRequest {
  readonly submissionContractVersion: "1.1.0";
  readonly projectId: string;
  readonly clientSubmissionId: string;
  readonly clientAttachmentId: string;
  readonly uploadAttempt: number;
  readonly filename: string;
  readonly mediaType: string;
  readonly expectedSize: number;
  readonly sha256: string;
  readonly captureId?: string;
}

export interface MobileInitUploadResponse {
  readonly sessionId: string;
  readonly projectId: string;
  readonly clientSubmissionId: string;
  readonly clientAttachmentId: string;
  readonly uploadAttempt: number;
  readonly status: "open";
  readonly filename: string;
  readonly mediaType: string;
  readonly captureId: string | null;
  readonly expectedSize: number;
  readonly chunkSize: number;
  readonly sha256: string;
  readonly expectedChunkCount: number;
  readonly receivedBytes: 0;
  readonly attachmentId: null;
  readonly expiresAt: string;
  readonly confirmedChunks: readonly number[];
  readonly version: number;
  readonly replayed: boolean;
}

export interface MobileFinalizeUploadRequest {
  readonly submissionContractVersion: "1.1.0";
  readonly expectedVersion: number;
  readonly clientSubmissionId: string;
  readonly clientAttachmentId: string;
  readonly uploadAttempt: number;
  readonly sha256: string;
  readonly expectedSize: number;
}

export interface MobileFinalizeUploadResponse {
  readonly sessionId: string;
  readonly projectId: string;
  readonly clientSubmissionId: string;
  readonly uploadAttempt: number;
  readonly attachmentId: string;
  readonly clientAttachmentId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly captureId: string | null;
  readonly sha256: string;
  readonly size: number;
  readonly scanStatus: "pending" | "clean" | "rejected" | "unavailable";
  readonly readyToBind: boolean;
  readonly bindingStatus: "unbound";
  readonly version: number;
  readonly replayed: boolean;
}

export interface MobileAttachmentBindingRequest {
  readonly submissionContractVersion: "1.1.0";
  readonly expectedVersion: number;
  readonly projectId: string;
  readonly clientSubmissionId: string;
  readonly clientAttachmentId: string;
  readonly leaseGeneration: number;
  readonly intent: MobileAttachmentIntent;
  readonly targetQaItemId?: string;
}

export interface MobileAttachmentReservation {
  readonly bindingId: string;
  readonly attachmentId: string;
  readonly projectId: string;
  readonly clientSubmissionId: string;
  readonly clientAttachmentId: string;
  readonly leaseGeneration: number;
  readonly intent: MobileAttachmentIntent;
  readonly targetQaItemId: string | null;
  readonly status: "reserved";
  readonly expiresAt: string;
  readonly version: number;
  readonly replayed: boolean;
}

export interface InitMobileUploadCommand {
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly request: MobileInitUploadRequest;
}

export interface PutMobileUploadChunkCommand {
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly chunkNumber: number;
  readonly expectedVersion: number;
  readonly clientSubmissionId: string;
  readonly clientAttachmentId: string;
  readonly chunkSha256: string;
  readonly bytes: Buffer;
}

export interface PutMobileUploadChunkResult {
  readonly version: number;
}

export interface FinalizeMobileUploadCommand {
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly request: MobileFinalizeUploadRequest;
}

export interface BindMobileAttachmentCommand {
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly attachmentId: string;
  readonly request: MobileAttachmentBindingRequest;
}

export interface MobileAttachmentStore {
  readonly initUpload: (
    command: InitMobileUploadCommand,
  ) => MobileInitUploadResponse | Promise<MobileInitUploadResponse>;
  readonly putChunk: (
    command: PutMobileUploadChunkCommand,
  ) => PutMobileUploadChunkResult | Promise<PutMobileUploadChunkResult>;
  readonly finalizeUpload: (
    command: FinalizeMobileUploadCommand,
  ) => MobileFinalizeUploadResponse | Promise<MobileFinalizeUploadResponse>;
  readonly bindAttachment: (
    command: BindMobileAttachmentCommand,
  ) => MobileAttachmentReservation | Promise<MobileAttachmentReservation>;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const INIT_KEYS = new Set([
  "submissionContractVersion",
  "projectId",
  "clientSubmissionId",
  "clientAttachmentId",
  "uploadAttempt",
  "filename",
  "mediaType",
  "expectedSize",
  "sha256",
  "captureId",
]);
const FINALIZE_KEYS = new Set([
  "submissionContractVersion",
  "expectedVersion",
  "clientSubmissionId",
  "clientAttachmentId",
  "uploadAttempt",
  "sha256",
  "expectedSize",
]);
const BIND_KEYS = new Set([
  "submissionContractVersion",
  "expectedVersion",
  "projectId",
  "clientSubmissionId",
  "clientAttachmentId",
  "leaseGeneration",
  "intent",
  "targetQaItemId",
]);
const ATTACHMENT_INTENTS = new Set<MobileAttachmentIntent>([
  "bug_create",
  "occurrence_append",
  "comment_append",
  "verification_result",
]);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`unexpected property: ${key}`);
  }
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length < minimum || candidate.length > maximum) {
    throw new TypeError(`${key} must be a bounded string`);
  }
  return candidate;
}

function requireInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const candidate = value[key];
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new TypeError(`${key} must be a bounded integer`);
  }
  return candidate;
}

export function requireMobileUuid(value: string, key: string): string {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${key} must be a UUID`);
  return value;
}

function requireUuidProperty(value: Record<string, unknown>, key: string): string {
  return requireMobileUuid(requireString(value, key, 36, 36), key);
}

function requireSha256(value: Record<string, unknown>, key: string): string {
  const sha256 = requireString(value, key, 64, 64);
  if (!SHA256_PATTERN.test(sha256)) throw new TypeError(`${key} must be a lowercase SHA-256`);
  return sha256;
}

function requireContractVersion(value: Record<string, unknown>): void {
  if (requireString(value, "submissionContractVersion", 1, 20) !== "1.1.0") {
    throw new TypeError("submissionContractVersion must be 1.1.0");
  }
}

export function parseMobileInitUploadRequest(value: unknown): MobileInitUploadRequest {
  const request = requireRecord(value, "initUpload request");
  requireOnlyKeys(request, INIT_KEYS);
  requireContractVersion(request);
  const captureIdValue = request["captureId"];
  const captureId =
    captureIdValue === undefined
      ? undefined
      : requireMobileUuid(requireString(request, "captureId", 36, 36), "captureId");
  return {
    submissionContractVersion: "1.1.0",
    projectId: requireUuidProperty(request, "projectId"),
    clientSubmissionId: requireUuidProperty(request, "clientSubmissionId"),
    clientAttachmentId: requireUuidProperty(request, "clientAttachmentId"),
    uploadAttempt: requireInteger(request, "uploadAttempt", 1),
    filename: requireString(request, "filename", 1, 255),
    mediaType: requireString(request, "mediaType", 1, 200),
    expectedSize: requireInteger(request, "expectedSize", 1, 524_288_000),
    sha256: requireSha256(request, "sha256"),
    ...(captureId === undefined ? {} : { captureId }),
  };
}

export function parseMobileFinalizeUploadRequest(value: unknown): MobileFinalizeUploadRequest {
  const request = requireRecord(value, "finalizeUpload request");
  requireOnlyKeys(request, FINALIZE_KEYS);
  requireContractVersion(request);
  return {
    submissionContractVersion: "1.1.0",
    expectedVersion: requireInteger(request, "expectedVersion", 1),
    clientSubmissionId: requireUuidProperty(request, "clientSubmissionId"),
    clientAttachmentId: requireUuidProperty(request, "clientAttachmentId"),
    uploadAttempt: requireInteger(request, "uploadAttempt", 1),
    sha256: requireSha256(request, "sha256"),
    expectedSize: requireInteger(request, "expectedSize", 1, 524_288_000),
  };
}

export function parseMobileAttachmentBindingRequest(
  value: unknown,
): MobileAttachmentBindingRequest {
  const request = requireRecord(value, "attachmentBinding request");
  requireOnlyKeys(request, BIND_KEYS);
  requireContractVersion(request);
  const intent = requireString(request, "intent", 1, 30) as MobileAttachmentIntent;
  if (!ATTACHMENT_INTENTS.has(intent)) throw new TypeError("intent is unsupported");
  const targetValue = request["targetQaItemId"];
  const targetQaItemId =
    targetValue === undefined
      ? undefined
      : requireMobileUuid(requireString(request, "targetQaItemId", 36, 36), "targetQaItemId");
  if (intent === "bug_create" && targetQaItemId !== undefined) {
    throw new TypeError("bug_create must not include targetQaItemId");
  }
  if (intent !== "bug_create" && targetQaItemId === undefined) {
    throw new TypeError(`${intent} requires targetQaItemId`);
  }
  return {
    submissionContractVersion: "1.1.0",
    expectedVersion: requireInteger(request, "expectedVersion", 1),
    projectId: requireUuidProperty(request, "projectId"),
    clientSubmissionId: requireUuidProperty(request, "clientSubmissionId"),
    clientAttachmentId: requireUuidProperty(request, "clientAttachmentId"),
    leaseGeneration: requireInteger(request, "leaseGeneration", 1),
    intent,
    ...(targetQaItemId === undefined ? {} : { targetQaItemId }),
  };
}

export function parseStrongUploadVersion(value: string | undefined): number {
  const match = /^"([1-9][0-9]*)"$/u.exec(value ?? "");
  const version = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(version))
    throw new TypeError("If-Match must be a strong upload version");
  return version;
}

export function parseMobileChunkNumber(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new TypeError("chunkNumber must be non-negative");
  const chunkNumber = Number(value);
  if (!Number.isSafeInteger(chunkNumber)) throw new TypeError("chunkNumber is too large");
  return chunkNumber;
}

export function requireMobileIdempotencyKey(value: string | undefined): string {
  if (value === undefined || value.length < 1 || value.length > 200) {
    throw new TypeError("Idempotency-Key must be a bounded string");
  }
  return value;
}

export function requireMobileChunkSha256(value: string | undefined, bytes: Buffer): string {
  if (value === undefined || !SHA256_PATTERN.test(value)) {
    throw new TypeError("X-Chunk-SHA256 must be a lowercase SHA-256");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== value) {
    throw new TypeError("X-Chunk-SHA256 does not match the request body");
  }
  return value;
}

export function requireMobileContentLength(value: string | undefined, bytes: Buffer): number {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError("Content-Length must be a positive integer");
  }
  const contentLength = Number(value);
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength > MAX_MOBILE_CHUNK_SIZE_BYTES ||
    contentLength !== bytes.byteLength
  ) {
    throw new TypeError("Content-Length must match one bounded chunk");
  }
  return contentLength;
}
