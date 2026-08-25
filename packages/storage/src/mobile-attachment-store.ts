import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  type PathLike,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { MobileCaptureArtifactKind } from "./mobile-capture-store.js";
import { SqliteStorageError } from "./sqlite.js";

const MOBILE_MIN_CHUNK_SIZE_BYTES = 256 * 1024;
const MOBILE_MAX_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
const MOBILE_UPLOAD_TTL_MS = 60 * 60 * 1000;
const MOBILE_BINDING_TTL_MS = 15 * 60 * 1000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export interface MobileAttachmentRoots {
  readonly evidenceRoot: string;
  readonly quarantineRoot: string;
}

export interface MobileAttachmentScope {
  readonly accountId: string;
  readonly projectId: string;
  readonly actorId: string;
}

export interface InitMobileUploadInput extends MobileAttachmentScope {
  readonly clientSubmissionId: string;
  readonly clientAttachmentId: string;
  readonly uploadAttempt: number;
  readonly filename: string;
  readonly mediaType: string;
  readonly captureId: string | null;
  readonly expectedSize: number;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface MobileUploadSession {
  readonly sessionId: string;
  readonly projectId: string;
  readonly clientSubmissionId: string;
  readonly clientAttachmentId: string;
  readonly uploadAttempt: number;
  readonly status: "open" | "finalizing" | "finalized" | "expired" | "rejected";
  readonly filename: string;
  readonly mediaType: string;
  readonly captureId: string | null;
  readonly expectedSize: number;
  readonly chunkSize: number;
  readonly sha256: string;
  readonly expectedChunkCount: number;
  readonly receivedBytes: number;
  readonly confirmedChunks: readonly number[];
  readonly attachmentId: string | null;
  readonly expiresAt: string;
  readonly version: number;
  readonly replayed: boolean;
}

export interface PutMobileUploadChunkInput extends MobileAttachmentScope {
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly chunkNumber: number;
  readonly expectedVersion: number;
  readonly clientSubmissionId: string;
  readonly clientAttachmentId: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly receivedAt: string;
}

export interface MobileUploadChunkReceipt {
  readonly version: number;
  readonly replayed: boolean;
}

export interface FinalizeMobileUploadInput extends MobileAttachmentScope {
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly clientSubmissionId: string;
  readonly clientAttachmentId: string;
  readonly uploadAttempt: number;
  readonly sha256: string;
  readonly expectedSize: number;
  readonly finalizedAt: string;
}

export interface MobileFinalizedAttachment {
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
  readonly scanStatus: "clean";
  readonly readyToBind: true;
  readonly bindingStatus: "unbound";
  readonly version: number;
  readonly replayed: boolean;
}

export interface BindMobileAttachmentInput extends MobileAttachmentScope {
  readonly attachmentId: string;
  readonly expectedVersion: number;
  readonly clientSubmissionId: string;
  readonly clientAttachmentId: string;
  readonly leaseGeneration: number;
  readonly intent: "bug_create";
  readonly boundAt: string;
}

export interface MobileAttachmentReservation {
  readonly bindingId: string;
  readonly attachmentId: string;
  readonly projectId: string;
  readonly clientSubmissionId: string;
  readonly clientAttachmentId: string;
  readonly leaseGeneration: number;
  readonly intent: "bug_create";
  readonly targetQaItemId: null;
  readonly status: "reserved";
  readonly expiresAt: string;
  readonly version: number;
  readonly replayed: boolean;
}

export interface ListMobileBugAttachmentsInput extends MobileAttachmentScope {
  readonly bugId: string;
  readonly limit: number;
}

export interface GetMobileAttachmentInput extends MobileAttachmentScope {
  readonly attachmentId: string;
}

export interface GetMobileCaptureArtifactInput extends MobileAttachmentScope {
  readonly bugId: string;
  readonly captureId: string;
  readonly artifactKind: MobileCaptureArtifactKind;
}

export interface MobileAttachmentMetadata {
  readonly attachmentId: string;
  readonly projectId: string;
  readonly clientSubmissionId: string;
  readonly clientAttachmentId: string;
  readonly captureId: string | null;
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly scanStatus: "clean";
  readonly readyToBind: true;
  readonly bindingStatus: "claimed";
  readonly version: number;
}

export interface MobileBugAttachmentList {
  readonly bugId: string;
  readonly projectId: string;
  readonly snapshotSequence: number;
  readonly items: readonly MobileAttachmentMetadata[];
  readonly nextCursor: null;
}

export interface MobileAttachmentDownload {
  readonly metadata: MobileAttachmentMetadata;
  readonly bytes: Uint8Array;
}

export interface MobileCaptureArtifactMetadata {
  readonly bugId: string;
  readonly projectId: string;
  readonly captureId: string;
  readonly artifactKind: MobileCaptureArtifactKind;
  readonly attachmentId: string;
  readonly clientAttachmentId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly scanStatus: "clean";
  readonly ready: true;
  readonly version: number;
}

export interface MobileCaptureArtifactDownload {
  readonly metadata: MobileCaptureArtifactMetadata;
  readonly bytes: Uint8Array;
}

interface UploadChunkRow {
  readonly chunk_index: number;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly storage_key: string;
}

interface UploadRow {
  readonly id: string;
  readonly account_id: string;
  readonly project_id: string;
  readonly actor_id: string;
  readonly client_submission_id: string;
  readonly client_attachment_id: string;
  readonly capture_id: string | null;
  readonly upload_attempt: number;
  readonly file_name: string;
  readonly media_type: string;
  readonly expected_size_bytes: number;
  readonly expected_sha256: string;
  readonly received_size_bytes: number;
  readonly chunk_size_bytes: number;
  readonly expected_chunk_count: number;
  readonly generation: number;
  readonly finalized_attachment_id: string | null;
  readonly status: MobileUploadSession["status"];
  readonly expires_at: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: number;
}

interface AttachmentRow {
  readonly id: string;
  readonly account_id: string;
  readonly project_id: string;
  readonly actor_id: string;
  readonly client_submission_id: string;
  readonly client_attachment_id: string;
  readonly capture_id: string | null;
  readonly file_name: string;
  readonly media_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly status: string;
  readonly scan_state: string;
  readonly version: number;
}

interface ClaimedAttachmentRow extends AttachmentRow {
  readonly storage_key: string;
}

interface CaptureArtifactAttachmentRow extends AttachmentRow {
  readonly storage_key: string;
  readonly bug_id: string;
  readonly artifact_capture_id: string;
  readonly artifact_type: MobileCaptureArtifactKind;
}

function requireTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) {
    throw new SqliteStorageError(
      "SQLITE_TRANSACTION_REQUIRED",
      "mobile attachment writes require the caller's transaction",
    );
  }
}

function requireRoots(roots: MobileAttachmentRoots): void {
  if (!isAbsolute(roots.evidenceRoot) || !isAbsolute(roots.quarantineRoot)) {
    throw new SqliteStorageError(
      "SQLITE_CONFIGURATION_INVALID",
      "mobile attachment roots must be absolute",
    );
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function nextTimestamp(prior: string, candidate: string): string {
  const priorMs = Date.parse(prior);
  const candidateMs = Date.parse(candidate);
  if (!Number.isFinite(priorMs) || !Number.isFinite(candidateMs)) {
    throw new SqliteStorageError("SQLITE_UPLOAD_INVALID", "upload timestamp is invalid");
  }
  return new Date(Math.max(candidateMs, priorMs + 1)).toISOString();
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) {
    throw new SqliteStorageError("SQLITE_UPLOAD_INVALID", "upload timestamp is invalid");
  }
  return new Date(value + milliseconds).toISOString();
}

function readUpload(
  database: DatabaseSync,
  scope: MobileAttachmentScope,
  sessionId: string,
): UploadRow | null {
  return (
    (database
      .prepare(
        `SELECT id, account_id, project_id, actor_id, client_submission_id,
                client_attachment_id, capture_id, upload_attempt, file_name, media_type,
                expected_size_bytes, expected_sha256, received_size_bytes,
                chunk_size_bytes, expected_chunk_count, generation,
                finalized_attachment_id, status, expires_at, created_at, updated_at, version
         FROM upload_sessions
         WHERE id = ? AND account_id = ? AND project_id = ? AND actor_id = ?`,
      )
      .get(sessionId, scope.accountId, scope.projectId, scope.actorId) as UploadRow | undefined) ??
    null
  );
}

function confirmedChunks(database: DatabaseSync, upload: UploadRow): readonly number[] {
  return Object.freeze(
    database
      .prepare(
        `SELECT chunk_index
         FROM upload_chunks
         WHERE account_id = ? AND project_id = ? AND upload_session_id = ? AND generation = ?
         ORDER BY chunk_index`,
      )
      .all(upload.account_id, upload.project_id, upload.id, upload.generation)
      .map((row) => Number(row.chunk_index)),
  );
}

function sessionRecord(
  database: DatabaseSync,
  upload: UploadRow,
  replayed: boolean,
): MobileUploadSession {
  return Object.freeze({
    sessionId: upload.id,
    projectId: upload.project_id,
    clientSubmissionId: upload.client_submission_id,
    clientAttachmentId: upload.client_attachment_id,
    uploadAttempt: upload.upload_attempt,
    status: upload.status,
    filename: upload.file_name,
    mediaType: upload.media_type,
    captureId: upload.capture_id,
    expectedSize: upload.expected_size_bytes,
    chunkSize: upload.chunk_size_bytes,
    sha256: upload.expected_sha256,
    expectedChunkCount: upload.expected_chunk_count,
    receivedBytes: upload.received_size_bytes,
    confirmedChunks: confirmedChunks(database, upload),
    attachmentId: upload.finalized_attachment_id,
    expiresAt: upload.expires_at,
    version: upload.version,
    replayed,
  });
}

function exactUploadIdentity(upload: UploadRow, input: InitMobileUploadInput): boolean {
  return (
    upload.client_submission_id === input.clientSubmissionId &&
    upload.client_attachment_id === input.clientAttachmentId &&
    upload.capture_id === input.captureId &&
    upload.upload_attempt === input.uploadAttempt &&
    upload.file_name === input.filename &&
    upload.media_type === input.mediaType &&
    upload.expected_size_bytes === input.expectedSize &&
    upload.expected_sha256 === input.sha256
  );
}

export function initMobileUpload(
  database: DatabaseSync,
  input: InitMobileUploadInput,
): MobileUploadSession {
  requireTransaction(database);
  const existing = database
    .prepare(
      `SELECT id
       FROM upload_sessions
       WHERE account_id = ? AND project_id = ? AND actor_id = ?
         AND client_submission_id = ? AND client_attachment_id = ? AND upload_attempt = ?`,
    )
    .get(
      input.accountId,
      input.projectId,
      input.actorId,
      input.clientSubmissionId,
      input.clientAttachmentId,
      input.uploadAttempt,
    ) as { readonly id: string } | undefined;
  if (existing) {
    const upload = readUpload(database, input, existing.id);
    if (!upload || !exactUploadIdentity(upload, input)) {
      throw new SqliteStorageError(
        "SQLITE_IDEMPOTENCY_MISMATCH",
        "upload session identity was already committed with another payload",
      );
    }
    return sessionRecord(database, upload, true);
  }

  const sessionId = randomUUID();
  const chunkSize = Math.min(
    MOBILE_MAX_CHUNK_SIZE_BYTES,
    Math.max(MOBILE_MIN_CHUNK_SIZE_BYTES, input.expectedSize),
  );
  const expectedChunkCount = Math.ceil(input.expectedSize / chunkSize);
  const expiresAt = addMilliseconds(input.createdAt, MOBILE_UPLOAD_TTL_MS);
  database
    .prepare(
      `INSERT INTO upload_sessions(
        id, account_id, project_id, actor_id, client_submission_id,
        client_attachment_id, capture_id, upload_attempt, file_name, media_type,
        expected_size_bytes, expected_sha256, received_size_bytes, chunk_size_bytes,
        expected_chunk_count, generation, finalized_attachment_id, status,
        expires_at, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, NULL, 'open', ?, ?, ?, 1)`,
    )
    .run(
      sessionId,
      input.accountId,
      input.projectId,
      input.actorId,
      input.clientSubmissionId,
      input.clientAttachmentId,
      input.captureId,
      input.uploadAttempt,
      input.filename,
      input.mediaType,
      input.expectedSize,
      input.sha256,
      chunkSize,
      expectedChunkCount,
      expiresAt,
      input.createdAt,
      input.createdAt,
    );
  const upload = readUpload(database, input, sessionId);
  if (!upload) throw new SqliteStorageError("SQLITE_EFFECT_MISSING", "upload session is missing");
  return sessionRecord(database, upload, false);
}

function writeExactFile(path: PathLike, bytes: Uint8Array): boolean {
  try {
    writeFileSync(path, bytes, { flag: "wx" });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    const existing = readFileSync(path);
    if (existing.length !== bytes.byteLength || sha256(existing) !== sha256(bytes)) {
      throw new SqliteStorageError(
        "SQLITE_UPLOAD_INVALID",
        "existing attachment bytes do not match their storage identity",
      );
    }
    return false;
  }
}

export function putMobileUploadChunk(
  database: DatabaseSync,
  roots: MobileAttachmentRoots,
  input: PutMobileUploadChunkInput,
): MobileUploadChunkReceipt {
  requireTransaction(database);
  requireRoots(roots);
  const upload = readUpload(database, input, input.sessionId);
  if (!upload) throw new SqliteStorageError("SQLITE_UPLOAD_NOT_FOUND", "upload session not found");
  if (
    upload.client_submission_id !== input.clientSubmissionId ||
    upload.client_attachment_id !== input.clientAttachmentId
  ) {
    throw new SqliteStorageError("SQLITE_UPLOAD_INVALID", "upload chunk scope is invalid");
  }
  const expectedIdempotencyKey =
    `submission:${upload.client_submission_id}:attachment:${upload.client_attachment_id}:` +
    `upload:${upload.upload_attempt}:chunk:${input.chunkNumber}`;
  if (input.idempotencyKey !== expectedIdempotencyKey) {
    throw new SqliteStorageError(
      "SQLITE_IDEMPOTENCY_MISMATCH",
      "upload chunk idempotency key does not match its session identity",
    );
  }
  const bytes = Buffer.from(input.bytes);
  const digest = sha256(bytes);
  if (digest !== input.sha256) {
    throw new SqliteStorageError("SQLITE_UPLOAD_INVALID", "upload chunk digest does not match");
  }
  const existing = database
    .prepare(
      `SELECT size_bytes, sha256
       FROM upload_chunks
       WHERE account_id = ? AND project_id = ? AND upload_session_id = ?
         AND generation = ? AND chunk_index = ?`,
    )
    .get(upload.account_id, upload.project_id, upload.id, upload.generation, input.chunkNumber) as
    { readonly size_bytes: number; readonly sha256: string } | undefined;
  if (existing) {
    if (existing.size_bytes !== bytes.length || existing.sha256 !== digest) {
      throw new SqliteStorageError(
        "SQLITE_IDEMPOTENCY_MISMATCH",
        "upload chunk was already committed with other bytes",
      );
    }
    return Object.freeze({ version: upload.version, replayed: true });
  }
  if (upload.status !== "open" || upload.version !== input.expectedVersion) {
    throw new SqliteStorageError("SQLITE_UPLOAD_VERSION_CONFLICT", "upload version conflict");
  }

  const storageKey = join(
    "uploads",
    upload.id,
    String(upload.generation),
    `${input.chunkNumber}.bin`,
  );
  const storagePath = join(roots.quarantineRoot, storageKey);
  mkdirSync(join(roots.quarantineRoot, "uploads", upload.id, String(upload.generation)), {
    recursive: true,
  });
  const createdFile = writeExactFile(storagePath, bytes);
  try {
    database
      .prepare(
        `INSERT INTO upload_chunks(
          account_id, project_id, upload_session_id, generation, chunk_index,
          offset_bytes, size_bytes, sha256, storage_key, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        upload.account_id,
        upload.project_id,
        upload.id,
        upload.generation,
        input.chunkNumber,
        input.chunkNumber * upload.chunk_size_bytes,
        bytes.length,
        digest,
        storageKey,
        input.receivedAt,
      );
    const updatedAt = nextTimestamp(upload.updated_at, input.receivedAt);
    database
      .prepare(
        `UPDATE upload_sessions
         SET received_size_bytes = received_size_bytes + ?,
             status = CASE
               WHEN received_size_bytes + ? = expected_size_bytes THEN 'finalizing'
               ELSE 'open'
             END,
             updated_at = ?, version = version + 1
         WHERE account_id = ? AND project_id = ? AND id = ? AND actor_id = ? AND version = ?`,
      )
      .run(
        bytes.length,
        bytes.length,
        updatedAt,
        upload.account_id,
        upload.project_id,
        upload.id,
        upload.actor_id,
        upload.version,
      );
    return Object.freeze({ version: upload.version + 1, replayed: false });
  } catch (error) {
    if (createdFile && existsSync(storagePath)) unlinkSync(storagePath);
    throw error;
  }
}

function readAttachment(
  database: DatabaseSync,
  scope: MobileAttachmentScope,
  attachmentId: string,
): AttachmentRow | null {
  return (
    (database
      .prepare(
        `SELECT id, account_id, project_id, actor_id, client_submission_id,
                client_attachment_id, capture_id, file_name, media_type,
                size_bytes, sha256, status, scan_state, version
         FROM attachments
         WHERE id = ? AND account_id = ? AND project_id = ? AND actor_id = ?`,
      )
      .get(attachmentId, scope.accountId, scope.projectId, scope.actorId) as
      AttachmentRow | undefined) ?? null
  );
}

function finalizedRecord(
  upload: UploadRow,
  attachment: AttachmentRow,
  replayed: boolean,
): MobileFinalizedAttachment {
  return Object.freeze({
    sessionId: upload.id,
    projectId: upload.project_id,
    clientSubmissionId: upload.client_submission_id,
    uploadAttempt: upload.upload_attempt,
    attachmentId: attachment.id,
    clientAttachmentId: upload.client_attachment_id,
    filename: upload.file_name,
    mediaType: upload.media_type,
    captureId: upload.capture_id,
    sha256: attachment.sha256,
    size: attachment.size_bytes,
    scanStatus: "clean",
    readyToBind: true,
    bindingStatus: "unbound",
    version: upload.version,
    replayed,
  });
}

function isPng(bytes: Buffer): boolean {
  if (
    bytes.length < PNG_SIGNATURE.length ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return false;
  }
  // A bounded structural check catches arbitrary signature-only payloads while
  // avoiding a general-purpose media scanner in the mobile upload path.
  if (bytes.length < 33) return false;
  const chunkLength = bytes.readUInt32BE(8);
  return chunkLength >= 13 && bytes.subarray(12, 16).toString("ascii") === "IHDR";
}

function isJpeg(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE) &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  );
}

function isWebp(bytes: Buffer): boolean {
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function requireSupportedContent(upload: UploadRow, bytes: Buffer): void {
  const valid =
    (upload.media_type === "image/png" && isPng(bytes)) ||
    (upload.media_type === "image/jpeg" && isJpeg(bytes)) ||
    (upload.media_type === "image/webp" && isWebp(bytes));
  if (valid) return;
  if (upload.media_type === "application/json") {
    if (bytes.length > 20_971_520) {
      throw new SqliteStorageError(
        "SQLITE_UPLOAD_INVALID",
        "JSON attachment exceeds its bounded size",
      );
    }
    try {
      const text = bytes.toString("utf8");
      if (Buffer.from(text, "utf8").length !== bytes.length) throw new Error("invalid UTF-8");
      JSON.parse(text);
      return;
    } catch {
      throw new SqliteStorageError(
        "SQLITE_UPLOAD_INVALID",
        "application/json attachment is invalid JSON",
      );
    }
  }
  throw new SqliteStorageError(
    "SQLITE_UPLOAD_INVALID",
    "mobile attachment content does not match its declared media type",
  );
}

export function finalizeMobileUpload(
  database: DatabaseSync,
  roots: MobileAttachmentRoots,
  input: FinalizeMobileUploadInput,
): MobileFinalizedAttachment {
  requireTransaction(database);
  requireRoots(roots);
  const upload = readUpload(database, input, input.sessionId);
  if (!upload) throw new SqliteStorageError("SQLITE_UPLOAD_NOT_FOUND", "upload session not found");
  if (
    upload.client_submission_id !== input.clientSubmissionId ||
    upload.client_attachment_id !== input.clientAttachmentId ||
    upload.upload_attempt !== input.uploadAttempt ||
    upload.expected_sha256 !== input.sha256 ||
    upload.expected_size_bytes !== input.expectedSize
  ) {
    throw new SqliteStorageError("SQLITE_UPLOAD_INVALID", "finalize identity is invalid");
  }
  if (upload.status === "finalized" && upload.finalized_attachment_id) {
    const attachment = readAttachment(database, input, upload.finalized_attachment_id);
    if (!attachment) {
      throw new SqliteStorageError("SQLITE_EFFECT_MISSING", "finalized attachment is missing");
    }
    return finalizedRecord(upload, attachment, true);
  }
  if (upload.status !== "finalizing" || upload.version !== input.expectedVersion) {
    throw new SqliteStorageError("SQLITE_UPLOAD_VERSION_CONFLICT", "upload version conflict");
  }

  const chunks = database
    .prepare(
      `SELECT chunk_index, size_bytes, sha256, storage_key
       FROM upload_chunks
       WHERE account_id = ? AND project_id = ? AND upload_session_id = ? AND generation = ?
       ORDER BY chunk_index`,
    )
    .all(upload.account_id, upload.project_id, upload.id, upload.generation)
    .map((row): UploadChunkRow => {
      const chunkIndex = row["chunk_index"];
      const sizeBytes = row["size_bytes"];
      const digest = row["sha256"];
      const storageKey = row["storage_key"];
      if (
        typeof chunkIndex !== "number" ||
        typeof sizeBytes !== "number" ||
        typeof digest !== "string" ||
        typeof storageKey !== "string"
      ) {
        throw new SqliteStorageError("SQLITE_UPLOAD_INVALID", "upload chunk metadata is invalid");
      }
      return {
        chunk_index: chunkIndex,
        size_bytes: sizeBytes,
        sha256: digest,
        storage_key: storageKey,
      };
    });
  const buffers = chunks.map((chunk, index) => {
    if (chunk.chunk_index !== index) {
      throw new SqliteStorageError("SQLITE_UPLOAD_INVALID", "upload chunk sequence is incomplete");
    }
    const bytes = readFileSync(join(roots.quarantineRoot, chunk.storage_key));
    if (bytes.length !== chunk.size_bytes || sha256(bytes) !== chunk.sha256) {
      throw new SqliteStorageError("SQLITE_UPLOAD_INVALID", "durable upload chunk is corrupt");
    }
    return bytes;
  });
  const bytes = Buffer.concat(buffers);
  if (bytes.length !== input.expectedSize || sha256(bytes) !== input.sha256) {
    throw new SqliteStorageError("SQLITE_UPLOAD_INVALID", "final upload content is invalid");
  }
  requireSupportedContent(upload, bytes);

  const storageKey = join("sha256", input.sha256.slice(0, 2), input.sha256);
  const storagePath = join(roots.evidenceRoot, storageKey);
  mkdirSync(join(roots.evidenceRoot, "sha256", input.sha256.slice(0, 2)), { recursive: true });
  const createdFile = writeExactFile(storagePath, bytes);
  try {
    const finalizedAt = nextTimestamp(upload.updated_at, input.finalizedAt);

    const existingBlob = database
      .prepare(
        `SELECT id, size_bytes, state
         FROM blobs WHERE account_id = ? AND sha256 = ?`,
      )
      .get(upload.account_id, input.sha256) as
      { readonly id: string; readonly size_bytes: number; readonly state: string } | undefined;
    let blobId: string;
    if (existingBlob) {
      if (existingBlob.size_bytes !== bytes.length || existingBlob.state !== "ready") {
        throw new SqliteStorageError("SQLITE_UPLOAD_INVALID", "content-addressed blob conflicts");
      }
      blobId = existingBlob.id;
    } else {
      blobId = randomUUID();
      database
        .prepare(
          `INSERT INTO blobs(
            id, account_id, sha256, size_bytes, storage_key, encryption_json,
            state, created_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, 1)`,
        )
        .run(
          blobId,
          upload.account_id,
          input.sha256,
          bytes.length,
          storageKey,
          JSON.stringify({ mode: "local-debug-plaintext", version: 1 }),
          finalizedAt,
        );
    }

    const attachmentId = randomUUID();
    database
      .prepare(
        `INSERT INTO attachments(
          id, account_id, project_id, actor_id, client_submission_id,
          client_attachment_id, capture_id, blob_id, upload_session_id,
          file_name, media_type, size_bytes, sha256, status, scan_state,
          quarantine_key, retention_until, created_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'clean', NULL, NULL, ?, 1)`,
      )
      .run(
        attachmentId,
        upload.account_id,
        upload.project_id,
        upload.actor_id,
        upload.client_submission_id,
        upload.client_attachment_id,
        upload.capture_id,
        blobId,
        upload.id,
        upload.file_name,
        upload.media_type,
        bytes.length,
        input.sha256,
        finalizedAt,
      );
    database
      .prepare(
        `UPDATE upload_sessions
         SET status = 'finalized', finalized_attachment_id = ?, updated_at = ?, version = version + 1
         WHERE account_id = ? AND project_id = ? AND id = ? AND actor_id = ?
           AND status = 'finalizing' AND version = ?`,
      )
      .run(
        attachmentId,
        finalizedAt,
        upload.account_id,
        upload.project_id,
        upload.id,
        upload.actor_id,
        upload.version,
      );
    const finalizedUpload = readUpload(database, input, upload.id);
    const attachment = readAttachment(database, input, attachmentId);
    if (!finalizedUpload || !attachment) {
      throw new SqliteStorageError("SQLITE_EFFECT_MISSING", "finalized upload effect is missing");
    }
    return finalizedRecord(finalizedUpload, attachment, false);
  } catch (error) {
    if (createdFile && existsSync(storagePath)) unlinkSync(storagePath);
    throw error;
  }
}

export function bindMobileAttachment(
  database: DatabaseSync,
  input: BindMobileAttachmentInput,
): MobileAttachmentReservation {
  requireTransaction(database);
  const attachment = readAttachment(database, input, input.attachmentId);
  if (!attachment) throw new SqliteStorageError("SQLITE_UPLOAD_NOT_FOUND", "attachment not found");
  if (
    attachment.client_submission_id !== input.clientSubmissionId ||
    attachment.client_attachment_id !== input.clientAttachmentId ||
    attachment.status !== "ready" ||
    attachment.scan_state !== "clean"
  ) {
    throw new SqliteStorageError("SQLITE_UPLOAD_INVALID", "attachment is not ready to bind");
  }
  const finalizedUpload = database
    .prepare(
      `SELECT version
       FROM upload_sessions
       WHERE account_id = ? AND project_id = ? AND actor_id = ?
         AND finalized_attachment_id = ? AND status = 'finalized'`,
    )
    .get(input.accountId, input.projectId, input.actorId, input.attachmentId) as
    { readonly version: number } | undefined;
  if (!finalizedUpload) {
    throw new SqliteStorageError("SQLITE_UPLOAD_INVALID", "finalized upload is missing");
  }
  const existing = database
    .prepare(
      `SELECT id, lease_generation, intent, target_bug_id, state, expires_at
       FROM attachment_bindings
       WHERE account_id = ? AND project_id = ? AND attachment_id = ?
       ORDER BY lease_generation DESC LIMIT 1`,
    )
    .get(input.accountId, input.projectId, input.attachmentId) as
    | {
        readonly id: string;
        readonly lease_generation: number;
        readonly intent: string;
        readonly target_bug_id: string | null;
        readonly state: string;
        readonly expires_at: string | null;
      }
    | undefined;
  if (existing) {
    if (
      existing.lease_generation !== input.leaseGeneration ||
      existing.intent !== input.intent ||
      existing.target_bug_id !== null ||
      existing.state !== "reserved" ||
      existing.expires_at === null
    ) {
      throw new SqliteStorageError(
        "SQLITE_IDEMPOTENCY_MISMATCH",
        "attachment reservation conflicts with its committed identity",
      );
    }
    return Object.freeze({
      bindingId: existing.id,
      attachmentId: attachment.id,
      projectId: attachment.project_id,
      clientSubmissionId: attachment.client_submission_id,
      clientAttachmentId: attachment.client_attachment_id,
      leaseGeneration: existing.lease_generation,
      intent: "bug_create",
      targetQaItemId: null,
      status: "reserved",
      expiresAt: existing.expires_at,
      version: finalizedUpload.version + existing.lease_generation,
      replayed: true,
    });
  }
  if (input.leaseGeneration !== 1 || finalizedUpload.version !== input.expectedVersion) {
    throw new SqliteStorageError("SQLITE_UPLOAD_VERSION_CONFLICT", "attachment version conflict");
  }
  const bindingId = randomUUID();
  const expiresAt = addMilliseconds(input.boundAt, MOBILE_BINDING_TTL_MS);
  database
    .prepare(
      `INSERT INTO attachment_bindings(
        id, account_id, project_id, attachment_id, intent, target_bug_id,
        lease_generation, state, expires_at, claimed_at, bound_by_actor_id,
        bound_at, version
      ) VALUES (?, ?, ?, ?, 'bug_create', NULL, 1, 'reserved', ?, NULL, ?, ?, 1)`,
    )
    .run(
      bindingId,
      input.accountId,
      input.projectId,
      attachment.id,
      expiresAt,
      input.actorId,
      input.boundAt,
    );
  return Object.freeze({
    bindingId,
    attachmentId: attachment.id,
    projectId: attachment.project_id,
    clientSubmissionId: attachment.client_submission_id,
    clientAttachmentId: attachment.client_attachment_id,
    leaseGeneration: 1,
    intent: "bug_create",
    targetQaItemId: null,
    status: "reserved",
    expiresAt,
    version: finalizedUpload.version + 1,
    replayed: false,
  });
}

function hasActiveAttachmentReadMembership(
  database: DatabaseSync,
  input: MobileAttachmentScope,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS present
         FROM accounts AS account
         JOIN projects AS project
           ON project.account_id = account.id
          AND project.id = ?
          AND project.status = 'active'
         JOIN users AS actor
           ON actor.account_id = account.id
          AND actor.id = ?
          AND actor.status = 'active'
         JOIN memberships AS membership
           ON membership.account_id = account.id
          AND membership.project_id = project.id
          AND membership.user_id = actor.id
          AND membership.status = 'active'
         WHERE account.id = ? AND account.status = 'active'`,
      )
      .get(input.projectId, input.actorId, input.accountId) !== undefined
  );
}

function claimedAttachmentMetadata(row: ClaimedAttachmentRow): MobileAttachmentMetadata {
  return Object.freeze({
    attachmentId: row.id,
    projectId: row.project_id,
    clientSubmissionId: row.client_submission_id,
    clientAttachmentId: row.client_attachment_id,
    captureId: row.capture_id,
    filename: row.file_name,
    mediaType: row.media_type,
    size: row.size_bytes,
    sha256: row.sha256,
    scanStatus: "clean",
    readyToBind: true,
    bindingStatus: "claimed",
    version: row.version,
  });
}

function selectClaimedAttachment(
  database: DatabaseSync,
  input: MobileAttachmentScope,
  attachmentId: string,
): ClaimedAttachmentRow | null {
  return (
    (database
      .prepare(
        `SELECT attachment.id, attachment.account_id, attachment.project_id,
                attachment.actor_id, attachment.client_submission_id,
                attachment.client_attachment_id, attachment.capture_id,
                attachment.file_name, attachment.media_type, attachment.size_bytes,
                attachment.sha256, attachment.status, attachment.scan_state,
                attachment.version, blob.storage_key
         FROM attachments AS attachment
         JOIN blobs AS blob
           ON blob.account_id = attachment.account_id
          AND blob.id = attachment.blob_id
          AND blob.size_bytes = attachment.size_bytes
          AND blob.sha256 = attachment.sha256
          AND blob.state = 'ready'
         JOIN attachment_bindings AS binding
           ON binding.account_id = attachment.account_id
          AND binding.project_id = attachment.project_id
          AND binding.attachment_id = attachment.id
          AND binding.state = 'claimed'
          AND binding.target_bug_id IS NOT NULL
         JOIN bug_attachments AS bug_attachment
           ON bug_attachment.account_id = binding.account_id
          AND bug_attachment.project_id = binding.project_id
          AND bug_attachment.bug_id = binding.target_bug_id
          AND bug_attachment.attachment_id = binding.attachment_id
          AND bug_attachment.binding_id = binding.id
         WHERE attachment.account_id = ? AND attachment.project_id = ?
           AND attachment.id = ? AND attachment.status = 'ready'
           AND attachment.scan_state = 'clean'`,
      )
      .get(input.accountId, input.projectId, attachmentId) as ClaimedAttachmentRow | undefined) ??
    null
  );
}

export function listMobileBugAttachments(
  database: DatabaseSync,
  input: ListMobileBugAttachmentsInput,
): MobileBugAttachmentList | null {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new SqliteStorageError("SQLITE_UPLOAD_INVALID", "attachment list limit is invalid");
  }
  if (!hasActiveAttachmentReadMembership(database, input)) return null;
  const bug = database
    .prepare(
      `SELECT id
       FROM bugs
       WHERE account_id = ? AND project_id = ? AND id = ?`,
    )
    .get(input.accountId, input.projectId, input.bugId);
  if (bug === undefined) return null;

  const snapshot = database
    .prepare(
      `SELECT COALESCE(MAX(event_position), 0) AS snapshot_sequence
       FROM events
       WHERE account_id = ? AND project_id = ? AND bug_id = ?`,
    )
    .get(input.accountId, input.projectId, input.bugId) as {
    readonly snapshot_sequence: number;
  };
  const rows = database
    .prepare(
      `SELECT attachment.id, attachment.account_id, attachment.project_id,
              attachment.actor_id, attachment.client_submission_id,
              attachment.client_attachment_id, attachment.capture_id,
              attachment.file_name, attachment.media_type, attachment.size_bytes,
              attachment.sha256, attachment.status, attachment.scan_state,
              attachment.version, blob.storage_key
       FROM bug_attachments AS bug_attachment
       JOIN attachments AS attachment
         ON attachment.account_id = bug_attachment.account_id
        AND attachment.project_id = bug_attachment.project_id
        AND attachment.id = bug_attachment.attachment_id
        AND attachment.status = 'ready'
        AND attachment.scan_state = 'clean'
       JOIN attachment_bindings AS binding
         ON binding.account_id = bug_attachment.account_id
        AND binding.project_id = bug_attachment.project_id
        AND binding.id = bug_attachment.binding_id
        AND binding.attachment_id = attachment.id
        AND binding.target_bug_id = bug_attachment.bug_id
        AND binding.state = 'claimed'
       JOIN blobs AS blob
         ON blob.account_id = attachment.account_id
        AND blob.id = attachment.blob_id
        AND blob.size_bytes = attachment.size_bytes
        AND blob.sha256 = attachment.sha256
        AND blob.state = 'ready'
       WHERE bug_attachment.account_id = ? AND bug_attachment.project_id = ?
         AND bug_attachment.bug_id = ?
       ORDER BY attachment.created_at, attachment.id
       LIMIT ?`,
    )
    .all(
      input.accountId,
      input.projectId,
      input.bugId,
      input.limit,
    ) as unknown as ClaimedAttachmentRow[];

  return Object.freeze({
    bugId: input.bugId,
    projectId: input.projectId,
    snapshotSequence: snapshot.snapshot_sequence,
    items: Object.freeze(rows.map(claimedAttachmentMetadata)),
    nextCursor: null,
  });
}

function resolveEvidenceFile(root: string, storageKey: string): string | null {
  const resolvedRoot = resolve(root);
  const resolvedFile = resolve(resolvedRoot, storageKey);
  const relativePath = relative(resolvedRoot, resolvedFile);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return resolvedFile;
}

export function getMobileAttachment(
  database: DatabaseSync,
  roots: MobileAttachmentRoots,
  input: GetMobileAttachmentInput,
): MobileAttachmentDownload | null {
  requireRoots(roots);
  if (!hasActiveAttachmentReadMembership(database, input)) return null;
  const attachment = selectClaimedAttachment(database, input, input.attachmentId);
  if (attachment === null) return null;
  const evidencePath = resolveEvidenceFile(roots.evidenceRoot, attachment.storage_key);
  if (evidencePath === null) return null;
  try {
    const bytes = readFileSync(evidencePath);
    if (bytes.length !== attachment.size_bytes || sha256(bytes) !== attachment.sha256) return null;
    return Object.freeze({
      metadata: claimedAttachmentMetadata(attachment),
      bytes,
    });
  } catch {
    return null;
  }
}

function captureArtifactMetadata(row: CaptureArtifactAttachmentRow): MobileCaptureArtifactMetadata {
  return Object.freeze({
    bugId: row.bug_id,
    projectId: row.project_id,
    captureId: row.artifact_capture_id,
    artifactKind: row.artifact_type,
    attachmentId: row.id,
    clientAttachmentId: row.client_attachment_id,
    filename: row.file_name,
    mediaType: row.media_type,
    size: row.size_bytes,
    sha256: row.sha256,
    scanStatus: "clean",
    ready: true,
    version: row.version,
  });
}

function selectMobileCaptureArtifact(
  database: DatabaseSync,
  input: GetMobileCaptureArtifactInput,
): CaptureArtifactAttachmentRow | null {
  return (
    (database
      .prepare(
        `SELECT bug.id AS bug_id,
                bundle.capture_id AS artifact_capture_id,
                artifact.artifact_type,
                attachment.id, attachment.account_id, attachment.project_id,
                attachment.actor_id, attachment.client_submission_id,
                attachment.client_attachment_id, attachment.capture_id,
                attachment.file_name, attachment.media_type, attachment.size_bytes,
                attachment.sha256, attachment.status, attachment.scan_state,
                attachment.version, blob.storage_key
         FROM bugs AS bug
         JOIN capture_bundles AS bundle
           ON bundle.account_id = bug.account_id
          AND bundle.project_id = bug.project_id
          AND bundle.status = 'bound'
          AND bundle.id = ?
          AND bundle.capture_id = ?
         JOIN attachments AS primary_attachment
           ON primary_attachment.account_id = bundle.account_id
          AND primary_attachment.project_id = bundle.project_id
          AND primary_attachment.id = bundle.primary_attachment_id
          AND primary_attachment.status = 'ready'
          AND primary_attachment.scan_state = 'clean'
         JOIN attachment_bindings AS primary_binding
           ON primary_binding.account_id = bundle.account_id
          AND primary_binding.project_id = bundle.project_id
          AND primary_binding.attachment_id = bundle.primary_attachment_id
          AND primary_binding.target_bug_id = bug.id
          AND primary_binding.state = 'claimed'
         JOIN bug_attachments AS primary_link
           ON primary_link.account_id = bug.account_id
          AND primary_link.project_id = bug.project_id
          AND primary_link.bug_id = bug.id
          AND primary_link.attachment_id = bundle.primary_attachment_id
          AND primary_link.binding_id = primary_binding.id
         JOIN capture_artifacts AS artifact
           ON artifact.account_id = bundle.account_id
          AND artifact.project_id = bundle.project_id
          AND artifact.capture_bundle_id = bundle.id
          AND artifact.capture_id = bundle.capture_id
          AND artifact.artifact_type = ?
          AND artifact.status = 'succeeded'
         JOIN attachments AS attachment
           ON attachment.account_id = artifact.account_id
          AND attachment.project_id = artifact.project_id
          AND attachment.id = artifact.attachment_id
          AND attachment.client_attachment_id = artifact.client_attachment_id
          AND attachment.capture_id = artifact.capture_id
          AND attachment.status = 'ready'
          AND attachment.scan_state = 'clean'
         JOIN blobs AS blob
           ON blob.account_id = attachment.account_id
          AND blob.id = attachment.blob_id
          AND blob.size_bytes = attachment.size_bytes
          AND blob.sha256 = attachment.sha256
          AND blob.state = 'ready'
         WHERE bug.account_id = ?
           AND bug.project_id = ?
           AND bug.id = ?`,
      )
      .get(
        input.captureId,
        input.captureId,
        input.artifactKind,
        input.accountId,
        input.projectId,
        input.bugId,
      ) as CaptureArtifactAttachmentRow | undefined) ?? null
  );
}

export function getMobileCaptureArtifact(
  database: DatabaseSync,
  roots: MobileAttachmentRoots,
  input: GetMobileCaptureArtifactInput,
): MobileCaptureArtifactDownload | null {
  requireRoots(roots);
  if (!hasActiveAttachmentReadMembership(database, input)) return null;
  const artifact = selectMobileCaptureArtifact(database, input);
  if (artifact === null) return null;
  const evidencePath = resolveEvidenceFile(roots.evidenceRoot, artifact.storage_key);
  if (evidencePath === null) return null;
  try {
    const bytes = readFileSync(evidencePath);
    if (bytes.length !== artifact.size_bytes || sha256(bytes) !== artifact.sha256) return null;
    return Object.freeze({
      metadata: captureArtifactMetadata(artifact),
      bytes,
    });
  } catch {
    return null;
  }
}
