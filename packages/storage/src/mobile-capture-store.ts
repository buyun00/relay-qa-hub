import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { hasActiveAttachmentReadMembership } from "./mobile-attachment-store.js";
import { SqliteStorageError } from "./sqlite.js";

export const MOBILE_CAPTURE_ALLOWED_METHODS = Object.freeze([
  "GetSDKVersion",
  "Screenshot",
  "Dump",
  "GetScreenSize",
  "GetDebugProfilingData",
  "qa.snapshot",
] as const);

export type MobileCapturePocoMethod = (typeof MOBILE_CAPTURE_ALLOWED_METHODS)[number];
export type MobileCaptureArtifactKind =
  | "system_screenshot"
  | "system_recording"
  | "poco_screenshot"
  | "poco_hierarchy"
  | "poco_profiling"
  | "poco_snapshot";
export type MobileCaptureArtifactStatus = "succeeded" | "failed" | "skipped";
export type MobileCaptureEnrichmentStatus = "unavailable" | "partial" | "complete";

export interface MobileCaptureScreenSize {
  readonly width: number;
  readonly height: number;
}

export interface MobileCaptureDeviceMetadata {
  readonly manufacturer: string;
  readonly model: string;
  readonly androidApi: number;
  readonly androidRelease: string;
  readonly qaAppVersion: string;
  readonly buildId?: string | null;
  readonly testSessionId?: string | null;
  readonly networkType: "offline" | "wifi" | "cellular" | "ethernet" | "vpn" | "other";
}

export interface MobileCapturePocoInput {
  readonly attempted: boolean;
  readonly connectedPort: number | null;
  readonly sdkVersion: string | null;
  readonly snapshotCapability: "not_probed" | "standard_only" | "qa_snapshot_available";
  readonly screenSize: MobileCaptureScreenSize | null;
  readonly allowedReadOnlyMethods: readonly MobileCapturePocoMethod[];
  readonly negotiatedMethods: readonly MobileCapturePocoMethod[];
  readonly succeededMethods: readonly MobileCapturePocoMethod[];
  readonly failureReason:
    | null
    | "not_running"
    | "connection_refused"
    | "timeout"
    | "cancelled"
    | "invalid_frame"
    | "oversized_response"
    | "unsupported_version"
    | "unity_stopped"
    | "unknown";
}

export interface MobileCaptureArtifactInput {
  readonly captureId: string;
  readonly clientAttachmentId: string | null;
  readonly attachmentId: string | null;
  readonly kind: MobileCaptureArtifactKind;
  readonly status: MobileCaptureArtifactStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly skewMs: number;
  readonly truncated: boolean;
  readonly failureReason: string | null;
}

export interface CreateMobileCaptureInput {
  readonly accountId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly clientSubmissionId: string;
  readonly captureId: string;
  readonly capturedAt: string;
  readonly source:
    | "overlay_single_tap"
    | "overlay_double_tap"
    | "recording_marker"
    | "recording_stop"
    | "android_share"
    | "photo_picker";
  readonly primaryEvidenceClientAttachmentId: string;
  readonly primaryEvidenceAttachmentId: string;
  readonly artifacts: readonly MobileCaptureArtifactInput[];
  readonly poco: MobileCapturePocoInput;
  readonly deviceMetadata: MobileCaptureDeviceMetadata;
  readonly createdAt: string;
  /** The worker supplies this only for the optional qa.snapshot typed fact. */
  readonly evidenceRoot?: string;
}

export type MobileCaptureArtifactRecord = MobileCaptureArtifactInput;

export interface MobileCapturePocoRecord extends MobileCapturePocoInput {
  readonly status: MobileCaptureEnrichmentStatus;
}

export interface MobileCaptureBundleRecord {
  readonly captureId: string;
  readonly clientSubmissionId: string;
  readonly projectId: string;
  readonly capturedAt: string;
  readonly source: CreateMobileCaptureInput["source"];
  readonly primaryEvidenceClientAttachmentId: string;
  readonly primaryEvidenceAttachmentId: string;
  readonly artifacts: readonly MobileCaptureArtifactRecord[];
  readonly enrichmentStatus: MobileCaptureEnrichmentStatus;
  readonly poco: MobileCapturePocoRecord;
  readonly deviceMetadata: MobileCaptureDeviceMetadata;
}

export interface MobileCaptureCreation {
  readonly captureBundle: MobileCaptureBundleRecord;
  readonly replayed: boolean;
}

interface CaptureRow {
  readonly id: string;
  readonly account_id: string;
  readonly project_id: string;
  readonly actor_id: string;
  readonly capture_id: string;
  readonly client_submission_id: string;
  readonly source: CreateMobileCaptureInput["source"];
  readonly primary_client_attachment_id: string;
  readonly primary_attachment_id: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly captured_at: string;
  readonly device_metadata_json: string;
  readonly enrichment_status: MobileCaptureEnrichmentStatus;
  readonly status: "draft" | "queued" | "uploaded" | "bound" | "discarded";
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: number;
}

interface CaptureArtifactRow {
  readonly capture_id: string;
  readonly client_attachment_id: string | null;
  readonly attachment_id: string | null;
  readonly artifact_type: MobileCaptureArtifactKind;
  readonly status: "pending" | MobileCaptureArtifactStatus;
  readonly skew_ms: number;
  readonly truncated: number;
  readonly failure_reason: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
}

interface PocoEnrichmentRow {
  readonly status: MobileCaptureEnrichmentStatus;
  readonly attempted: number;
  readonly connected_port: number | null;
  readonly sdk_version: string | null;
  readonly snapshot_capability: MobileCapturePocoInput["snapshotCapability"];
  readonly screen_width: number | null;
  readonly screen_height: number | null;
  readonly failure_reason: string | null;
}

interface PocoMethodRow {
  readonly method: MobileCapturePocoMethod;
  readonly negotiated: number;
  readonly status: string;
}

function requireTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) {
    throw new SqliteStorageError(
      "SQLITE_TRANSACTION_REQUIRED",
      "mobile capture writes require the caller's transaction",
    );
  }
}

function captureInvalid(message: string): never {
  throw new SqliteStorageError("SQLITE_UPLOAD_INVALID", message);
}

function requireDate(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) captureInvalid(`${name} is not a valid date-time`);
  return parsed;
}

function nextTimestamp(prior: string, candidate: string): string {
  const priorMs = requireDate(prior, "prior timestamp");
  const candidateMs = requireDate(candidate, "candidate timestamp");
  return new Date(Math.max(candidateMs, priorMs + 1)).toISOString();
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    captureInvalid("capture JSON identity is not serializable");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameMethods(first: readonly string[], second: readonly string[]): boolean {
  if (first.length !== second.length) return false;
  return first.every((method, index) => method === second[index]);
}

function validateMethods(methods: readonly MobileCapturePocoMethod[], name: string): Set<string> {
  if (new Set(methods).size !== methods.length) captureInvalid(`${name} must be unique`);
  for (const method of methods) {
    if (!MOBILE_CAPTURE_ALLOWED_METHODS.includes(method)) {
      captureInvalid(`${name} contains an unsupported method`);
    }
  }
  return new Set(methods);
}

function validatePoco(input: MobileCapturePocoInput): MobileCaptureEnrichmentStatus {
  if (!sameMethods(input.allowedReadOnlyMethods, MOBILE_CAPTURE_ALLOWED_METHODS)) {
    captureInvalid("allowed Poco methods must use the frozen read-only allowlist");
  }
  const negotiated = validateMethods(input.negotiatedMethods, "negotiatedMethods");
  const succeeded = validateMethods(input.succeededMethods, "succeededMethods");
  for (const method of succeeded) {
    if (!negotiated.has(method)) captureInvalid("succeeded Poco methods must be negotiated");
  }
  if (!Number.isInteger(input.connectedPort) && input.connectedPort !== null) {
    captureInvalid("connectedPort is invalid");
  }
  if (
    input.connectedPort !== null &&
    (input.connectedPort < 1 || input.connectedPort > 65535)
  ) {
    captureInvalid("connectedPort is invalid");
  }
  if (input.sdkVersion !== null && (input.sdkVersion.length < 1 || input.sdkVersion.length > 100)) {
    captureInvalid("sdkVersion is invalid");
  }
  if (
    input.screenSize !== null &&
    (!Number.isInteger(input.screenSize.width) ||
      !Number.isInteger(input.screenSize.height) ||
      input.screenSize.width < 1 ||
      input.screenSize.width > 32768 ||
      input.screenSize.height < 1 ||
      input.screenSize.height > 32768)
  ) {
    captureInvalid("screenSize is invalid");
  }
  if (!input.attempted) {
    if (
      negotiated.size !== 0 ||
      succeeded.size !== 0 ||
      input.connectedPort !== null ||
      input.sdkVersion !== null ||
      input.snapshotCapability !== "not_probed" ||
      input.screenSize !== null ||
      input.failureReason !== null
    ) {
      captureInvalid("an unattempted Poco enrichment must remain effect-free");
    }
    return "unavailable";
  }

  if ([...negotiated].some((method) => method !== "GetSDKVersion") && !succeeded.has("GetSDKVersion")) {
    captureInvalid("negotiated Poco methods require a successful SDK method");
  }
  if (succeeded.size > 0 && !succeeded.has("GetSDKVersion")) {
    captureInvalid("succeeded Poco methods require GetSDKVersion");
  }
  if ((input.connectedPort !== null) !== succeeded.has("GetSDKVersion")) {
    captureInvalid("connectedPort does not match GetSDKVersion");
  }
  if ((input.sdkVersion !== null) !== succeeded.has("GetSDKVersion")) {
    captureInvalid("sdkVersion does not match GetSDKVersion");
  }
  if ((input.screenSize !== null) !== succeeded.has("GetScreenSize")) {
    captureInvalid("screenSize does not match GetScreenSize");
  }
  if (
    (input.snapshotCapability === "qa_snapshot_available") !== negotiated.has("qa.snapshot") ||
    (input.snapshotCapability === "standard_only" && !succeeded.has("GetSDKVersion")) ||
    (input.snapshotCapability === "standard_only" && negotiated.has("qa.snapshot")) ||
    (input.snapshotCapability === "not_probed" && succeeded.has("GetSDKVersion"))
  ) {
    captureInvalid("snapshotCapability does not match Poco method facts");
  }
  if (succeeded.size === 0) return "unavailable";
  if (
    input.negotiatedMethods.length > 0 &&
    sameMethods(input.negotiatedMethods, input.succeededMethods) &&
    input.failureReason !== null
  ) {
    captureInvalid("a fully succeeded Poco set cannot report a failure reason");
  }
  return sameMethods(input.negotiatedMethods, input.succeededMethods) &&
    ["GetSDKVersion", "Screenshot", "Dump"].every((method) => succeeded.has(method as MobileCapturePocoMethod))
    ? "complete"
    : "partial";
}

function methodStatus(
  method: MobileCapturePocoMethod,
  poco: MobileCapturePocoInput,
): "succeeded" | "unavailable" | "timeout" | "cancelled" | "failed" {
  if (poco.succeededMethods.includes(method)) return "succeeded";
  if (!poco.negotiatedMethods.includes(method)) return "unavailable";
  if (poco.failureReason === "timeout") return "timeout";
  if (poco.failureReason === "cancelled") return "cancelled";
  return "failed";
}

function readCapture(database: DatabaseSync, input: CreateMobileCaptureInput): CaptureRow | null {
  return (
    (database
      .prepare(
        `SELECT id, account_id, project_id, actor_id, capture_id, client_submission_id,
                source, primary_client_attachment_id, primary_attachment_id,
                started_at, ended_at, captured_at, device_metadata_json,
                enrichment_status, status, created_at, updated_at, version
         FROM capture_bundles
         WHERE id = ? AND account_id = ? AND project_id = ? AND actor_id = ?`,
      )
      .get(input.captureId, input.accountId, input.projectId, input.actorId) as
      | CaptureRow
      | undefined) ?? null
  );
}

function readCaptureBySubmission(
  database: DatabaseSync,
  input: CreateMobileCaptureInput,
): CaptureRow | null {
  return (
    (database
      .prepare(
        `SELECT id, account_id, project_id, actor_id, capture_id, client_submission_id,
                source, primary_client_attachment_id, primary_attachment_id,
                started_at, ended_at, captured_at, device_metadata_json,
                enrichment_status, status, created_at, updated_at, version
         FROM capture_bundles
         WHERE account_id = ? AND project_id = ? AND actor_id = ?
           AND client_submission_id = ?`,
      )
      .get(input.accountId, input.projectId, input.actorId, input.clientSubmissionId) as
      | CaptureRow
      | undefined) ?? null
  );
}

function sameCaptureIdentity(
  database: DatabaseSync,
  row: CaptureRow,
  input: CreateMobileCaptureInput,
  startedAt: string,
  endedAt: string,
): boolean {
  if (
    row.id !== input.captureId ||
    row.capture_id !== input.captureId ||
    row.client_submission_id !== input.clientSubmissionId ||
    row.source !== input.source ||
    row.primary_client_attachment_id !== input.primaryEvidenceClientAttachmentId ||
    row.primary_attachment_id !== input.primaryEvidenceAttachmentId ||
    row.captured_at !== input.capturedAt ||
    row.started_at !== startedAt ||
    row.ended_at !== endedAt ||
    row.device_metadata_json !== jsonText(input.deviceMetadata)
  ) {
    return false;
  }
  const artifacts = database
    .prepare(
      `SELECT capture_id, client_attachment_id, attachment_id, artifact_type, status,
              skew_ms, truncated, failure_reason, started_at, ended_at
       FROM capture_artifacts
       WHERE account_id = ? AND project_id = ? AND capture_bundle_id = ?
       ORDER BY rowid`,
    )
    .all(input.accountId, input.projectId, input.captureId) as unknown as CaptureArtifactRow[];
  if (artifacts.length !== input.artifacts.length) return false;
  return artifacts.every((artifact, index) => {
    const expected = input.artifacts[index];
    if (!expected) return false;
    return (
      artifact.capture_id === expected.captureId &&
      artifact.client_attachment_id === expected.clientAttachmentId &&
      artifact.attachment_id === expected.attachmentId &&
      artifact.artifact_type === expected.kind &&
      artifact.status === expected.status &&
      artifact.skew_ms === expected.skewMs &&
      artifact.truncated === (expected.truncated ? 1 : 0) &&
      artifact.failure_reason === expected.failureReason &&
      artifact.started_at === expected.startedAt &&
      artifact.ended_at === expected.endedAt
    );
  });
}

function captureBundleRecord(database: DatabaseSync, row: CaptureRow): MobileCaptureBundleRecord {
  const artifacts = database
    .prepare(
      `SELECT capture_id, client_attachment_id, attachment_id, artifact_type, status,
              skew_ms, truncated, failure_reason, started_at, ended_at
       FROM capture_artifacts
       WHERE account_id = ? AND project_id = ? AND capture_bundle_id = ?
       ORDER BY rowid`,
    )
    .all(row.account_id, row.project_id, row.id) as unknown as CaptureArtifactRow[];
  const enrichment = database
    .prepare(
      `SELECT status, attempted, connected_port, sdk_version, snapshot_capability,
              screen_width, screen_height, failure_reason
       FROM poco_enrichments
       WHERE account_id = ? AND project_id = ? AND capture_bundle_id = ?`,
    )
    .get(row.account_id, row.project_id, row.id) as PocoEnrichmentRow | undefined;
  if (!enrichment) throw new SqliteStorageError("SQLITE_EFFECT_MISSING", "Poco enrichment is missing");
  const methods = database
    .prepare(
      `SELECT method, negotiated, status
       FROM capture_poco_methods
       WHERE account_id = ? AND project_id = ? AND capture_bundle_id = ?`,
    )
    .all(row.account_id, row.project_id, row.id) as unknown as PocoMethodRow[];
  const negotiatedMethods = MOBILE_CAPTURE_ALLOWED_METHODS.filter((method) =>
    methods.some((entry) => entry.method === method && entry.negotiated === 1),
  );
  const succeededMethods = MOBILE_CAPTURE_ALLOWED_METHODS.filter((method) =>
    methods.some((entry) => entry.method === method && entry.status === "succeeded"),
  );
  let deviceMetadata: MobileCaptureDeviceMetadata;
  try {
    deviceMetadata = JSON.parse(row.device_metadata_json) as MobileCaptureDeviceMetadata;
  } catch {
    throw new SqliteStorageError("SQLITE_EFFECT_MISSING", "capture device metadata is invalid");
  }
  return Object.freeze({
    captureId: row.capture_id,
    clientSubmissionId: row.client_submission_id,
    projectId: row.project_id,
    capturedAt: row.captured_at,
    source: row.source,
    primaryEvidenceClientAttachmentId: row.primary_client_attachment_id,
    primaryEvidenceAttachmentId: row.primary_attachment_id,
    artifacts: Object.freeze(
      artifacts.map((artifact) =>
        Object.freeze({
          captureId: artifact.capture_id,
          clientAttachmentId: artifact.client_attachment_id,
          attachmentId: artifact.attachment_id,
          kind: artifact.artifact_type,
          status: artifact.status === "pending" ? "failed" : artifact.status,
          startedAt: artifact.started_at,
          endedAt: artifact.ended_at ?? artifact.started_at,
          skewMs: artifact.skew_ms,
          truncated: artifact.truncated === 1,
          failureReason: artifact.failure_reason,
        }),
      ),
    ),
    enrichmentStatus: row.enrichment_status,
    poco: Object.freeze({
      status: enrichment.status,
      attempted: enrichment.attempted === 1,
      connectedPort: enrichment.connected_port,
      sdkVersion: enrichment.sdk_version,
      snapshotCapability: enrichment.snapshot_capability,
      screenSize:
        enrichment.screen_width === null || enrichment.screen_height === null
          ? null
          : Object.freeze({ width: enrichment.screen_width, height: enrichment.screen_height }),
      allowedReadOnlyMethods: MOBILE_CAPTURE_ALLOWED_METHODS,
      negotiatedMethods: Object.freeze(negotiatedMethods),
      succeededMethods: Object.freeze(succeededMethods),
      failureReason: enrichment.failure_reason as MobileCapturePocoInput["failureReason"],
    }),
    deviceMetadata: Object.freeze(deviceMetadata),
  });
}

function requireArtifactIdentity(
  input: CreateMobileCaptureInput,
  startedAt: number,
  capturedAt: number,
): void {
  if (input.artifacts.length < 1 || input.artifacts.length > 12) {
    captureInvalid("capture artifacts must contain from 1 through 12 entries");
  }
  const kinds = new Set<string>();
  const succeededAttachmentIds = new Set<string>();
  const succeededClientAttachmentIds = new Set<string>();
  let primaryFound = false;
  for (const artifact of input.artifacts) {
    if (artifact.captureId !== input.captureId) captureInvalid("artifact captureId does not match captureId");
    if (kinds.has(artifact.kind)) captureInvalid("capture artifact kinds must be unique");
    kinds.add(artifact.kind);
    const artifactStartedAt = requireDate(artifact.startedAt, "artifact.startedAt");
    const artifactEndedAt = requireDate(artifact.endedAt, "artifact.endedAt");
    if (artifactEndedAt < artifactStartedAt) captureInvalid("artifact endedAt precedes startedAt");
    const actualSkew = Math.abs(artifactStartedAt - capturedAt);
    if (
      !Number.isInteger(artifact.skewMs) ||
      artifact.skewMs < 0 ||
      artifact.skewMs > 5000 ||
      Math.abs(artifact.skewMs - actualSkew) > 1
    ) {
      captureInvalid("artifact skewMs does not match capturedAt");
    }
    const maxDuration = artifact.kind === "system_recording" ? 120_000 : 5_000;
    if (artifactEndedAt - artifactStartedAt > maxDuration) {
      captureInvalid("capture artifact duration is too long");
    }
    if (artifact.status === "succeeded") {
      if (artifact.attachmentId === null || artifact.clientAttachmentId === null || artifact.failureReason !== null) {
        captureInvalid("succeeded artifacts require exact attachment IDs");
      }
      if (succeededAttachmentIds.has(artifact.attachmentId) || succeededClientAttachmentIds.has(artifact.clientAttachmentId)) {
        captureInvalid("succeeded artifact attachment identities must be unique");
      }
      succeededAttachmentIds.add(artifact.attachmentId);
      succeededClientAttachmentIds.add(artifact.clientAttachmentId);
      if (
        artifact.attachmentId === input.primaryEvidenceAttachmentId &&
        artifact.clientAttachmentId === input.primaryEvidenceClientAttachmentId
      ) {
        primaryFound = artifact.kind === "system_screenshot" || artifact.kind === "system_recording";
      }
    } else if (
      artifact.attachmentId !== null ||
      artifact.clientAttachmentId !== null ||
      (artifact.status === "failed" && !artifact.failureReason)
    ) {
      captureInvalid("failed or skipped artifacts must not claim attachments");
    }
  }
  if (!primaryFound) captureInvalid("primary evidence must be one succeeded system artifact");
  if (Math.abs(startedAt - capturedAt) > 5000) {
    captureInvalid("capture artifact start is outside the bounded skew");
  }
}

function insertPocoSnapshotFact(
  database: DatabaseSync,
  input: CreateMobileCaptureInput,
): void {
  if (!input.poco.succeededMethods.includes("qa.snapshot")) return;
  const artifact = input.artifacts.find(
    (candidate) => candidate.kind === "poco_snapshot" && candidate.status === "succeeded",
  );
  if (!artifact?.attachmentId || !input.evidenceRoot) {
    captureInvalid("qa.snapshot requires a durable JSON snapshot attachment");
  }
  const blob = database
    .prepare(
      `SELECT blob.storage_key
       FROM attachments AS attachment
       JOIN blobs AS blob
         ON blob.account_id = attachment.account_id AND blob.id = attachment.blob_id
       WHERE attachment.account_id = ? AND attachment.project_id = ? AND attachment.id = ?
         AND blob.state = 'ready'`,
    )
    .get(input.accountId, input.projectId, artifact.attachmentId) as { readonly storage_key: string } | undefined;
  if (!blob) captureInvalid("qa.snapshot attachment backing blob is missing");
  let payload: Buffer;
  try {
    payload = readFileSync(join(input.evidenceRoot, blob.storage_key));
    JSON.parse(payload.toString("utf8"));
  } catch {
    captureInvalid("qa.snapshot attachment is not valid JSON");
  }
  if (payload.length < 2 || payload.length > 262144) {
    captureInvalid("qa.snapshot attachment exceeds its bounded JSON size");
  }
  database
    .prepare(
      `INSERT INTO poco_snapshots(
        id, account_id, project_id, capture_bundle_id, capture_id,
        schema_version, compression, uncompressed_bytes, payload_json,
        limited_error_count, created_at, version
      ) VALUES (?, ?, ?, ?, ?, '1.0.0', 'none', ?, ?, 0, ?, 1)`,
    )
    .run(
      randomUUID(),
      input.accountId,
      input.projectId,
      input.captureId,
      input.captureId,
      payload.length,
      payload.toString("utf8"),
      input.createdAt,
    );
}

export function createMobileCapture(
  database: DatabaseSync,
  input: CreateMobileCaptureInput,
): MobileCaptureCreation {
  requireTransaction(database);
  const capturedAt = requireDate(input.capturedAt, "capturedAt");
  validatePoco(input.poco);
  const artifactTimes = input.artifacts.map((artifact) => ({
    startedAt: requireDate(artifact.startedAt, "artifact.startedAt"),
    endedAt: requireDate(artifact.endedAt, "artifact.endedAt"),
  }));
  const startedAtMs = Math.min(...artifactTimes.map((value) => value.startedAt));
  const endedAtMs = Math.max(...artifactTimes.map((value) => value.endedAt));
  const startedAt = new Date(startedAtMs).toISOString();
  const endedAt = new Date(endedAtMs).toISOString();
  requireArtifactIdentity(input, startedAtMs, capturedAt);
  const existing = readCapture(database, input);
  if (existing) {
    if (!sameCaptureIdentity(database, existing, input, startedAt, endedAt)) {
      throw new SqliteStorageError("SQLITE_IDEMPOTENCY_MISMATCH", "capture identity conflicts with its replay");
    }
    return Object.freeze({ captureBundle: captureBundleRecord(database, existing), replayed: true });
  }
  const existingSubmissionCapture = readCaptureBySubmission(database, input);
  if (existingSubmissionCapture) {
    throw new SqliteStorageError("SQLITE_IDEMPOTENCY_MISMATCH", "client submission already owns another capture");
  }
  const existingSubmission = database
    .prepare(
      `SELECT 1 AS present
       FROM submissions
       WHERE account_id = ? AND project_id = ? AND actor_id = ? AND client_submission_id = ?`,
    )
    .get(input.accountId, input.projectId, input.actorId, input.clientSubmissionId) as
    | { readonly present: number }
    | undefined;
  if (existingSubmission) {
    throw new SqliteStorageError("SQLITE_IDEMPOTENCY_MISMATCH", "client submission is already committed by another intent");
  }

  const status = validatePoco(input.poco);
  const metadataJson = jsonText(input.deviceMetadata);
  database
    .prepare(
      `INSERT INTO capture_bundles(
        id, account_id, project_id, actor_id, capture_id, client_submission_id,
        source, primary_client_attachment_id, primary_attachment_id,
        started_at, ended_at, captured_at, device_metadata_json,
        enrichment_status, status, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unavailable', 'draft', ?, ?, 1)`,
    )
    .run(
      input.captureId,
      input.accountId,
      input.projectId,
      input.actorId,
      input.captureId,
      input.clientSubmissionId,
      input.source,
      input.primaryEvidenceClientAttachmentId,
      input.primaryEvidenceAttachmentId,
      startedAt,
      endedAt,
      input.capturedAt,
      metadataJson,
      input.createdAt,
      input.createdAt,
    );

  for (const artifact of input.artifacts) {
    database
      .prepare(
        `INSERT INTO capture_artifacts(
          id, account_id, project_id, capture_bundle_id, capture_id,
          client_attachment_id, attachment_id, artifact_type, status,
          skew_ms, truncated, failure_reason, metadata_json,
          started_at, ended_at, created_at, version
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 'pending', ?, ?, NULL, ?, ?, NULL, ?, 1)`,
      )
      .run(
        randomUUID(),
        input.accountId,
        input.projectId,
        input.captureId,
        input.captureId,
        artifact.kind,
        artifact.skewMs,
        artifact.truncated ? 1 : 0,
        jsonText({ kind: artifact.kind }),
        artifact.startedAt,
        input.createdAt,
      );
  }
  const artifactRows = database
    .prepare(
      `SELECT id, artifact_type
       FROM capture_artifacts
       WHERE account_id = ? AND project_id = ? AND capture_bundle_id = ?
       ORDER BY rowid`,
    )
    .all(input.accountId, input.projectId, input.captureId) as Array<{
    readonly id: string;
    readonly artifact_type: MobileCaptureArtifactKind;
  }>;
  for (const [index, artifact] of input.artifacts.entries()) {
    const row = artifactRows[index];
    if (!row || row.artifact_type !== artifact.kind) captureInvalid("capture artifact effect is missing");
    database
      .prepare(
        `UPDATE capture_artifacts
         SET client_attachment_id = ?, attachment_id = ?, status = ?,
             ended_at = ?, failure_reason = ?, version = version + 1
         WHERE account_id = ? AND project_id = ? AND id = ? AND version = 1`,
      )
      .run(
        artifact.clientAttachmentId,
        artifact.attachmentId,
        artifact.status,
        artifact.endedAt,
        artifact.failureReason,
        input.accountId,
        input.projectId,
        row.id,
      );
  }

  for (const method of MOBILE_CAPTURE_ALLOWED_METHODS) {
    const negotiated = input.poco.negotiatedMethods.includes(method) ? 1 : 0;
    database
      .prepare(
        `INSERT INTO capture_poco_methods(
          account_id, project_id, capture_bundle_id, method, negotiated,
          status, latency_ms, response_bytes, error_code, collected_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        input.accountId,
        input.projectId,
        input.captureId,
        method,
        negotiated,
        methodStatus(method, input.poco),
        negotiated === 1 && !input.poco.succeededMethods.includes(method)
          ? input.poco.failureReason
          : null,
        input.createdAt,
      );
  }
  const nonceHash = sha256(`${input.accountId}:${input.projectId}:${input.captureId}:${input.clientSubmissionId}`);
  database
    .prepare(
      `INSERT INTO poco_enrichments(
        id, account_id, project_id, capture_bundle_id, capture_id,
        nonce_hash, schema_version, attempted, connected_port, sdk_version,
        snapshot_capability, screen_width, screen_height, status,
        error_code, failure_reason, collected_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, '1.1.0', 0, NULL, NULL, 'not_probed', NULL, NULL,
                'unavailable', NULL, NULL, ?, 1)`,
    )
    .run(
      randomUUID(),
      input.accountId,
      input.projectId,
      input.captureId,
      input.captureId,
      nonceHash,
      input.createdAt,
    );
  if (input.poco.attempted) {
    database
      .prepare(
        `UPDATE poco_enrichments
         SET attempted = 1, connected_port = ?, sdk_version = ?,
             snapshot_capability = ?, screen_width = ?, screen_height = ?,
             status = ?, error_code = ?, failure_reason = ?, version = version + 1
         WHERE account_id = ? AND project_id = ? AND capture_bundle_id = ? AND version = 1`,
      )
      .run(
        input.poco.connectedPort,
        input.poco.sdkVersion,
        input.poco.snapshotCapability,
        input.poco.screenSize?.width ?? null,
        input.poco.screenSize?.height ?? null,
        status,
        input.poco.failureReason,
        input.poco.failureReason,
        input.accountId,
        input.projectId,
        input.captureId,
      );
  }
  insertPocoSnapshotFact(database, input);
  const updatedAt = nextTimestamp(input.createdAt, input.createdAt);
  database
    .prepare(
      `UPDATE capture_bundles
       SET enrichment_status = ?, status = 'uploaded', updated_at = ?, version = version + 1
       WHERE account_id = ? AND project_id = ? AND actor_id = ? AND id = ? AND version = 1`,
    )
    .run(status, updatedAt, input.accountId, input.projectId, input.actorId, input.captureId);
  const created = readCapture(database, input);
  if (!created) throw new SqliteStorageError("SQLITE_EFFECT_MISSING", "capture bundle effect is missing");
  return Object.freeze({ captureBundle: captureBundleRecord(database, created), replayed: false });
}

export function getMobileCapture(
  database: DatabaseSync,
  input: Pick<CreateMobileCaptureInput, "accountId" | "projectId" | "actorId" | "captureId">,
): MobileCaptureBundleRecord | null {
  if (!hasActiveAttachmentReadMembership(database, input)) return null;
  const row = database
    .prepare(
      `SELECT id, account_id, project_id, actor_id, capture_id, client_submission_id,
              source, primary_client_attachment_id, primary_attachment_id,
              started_at, ended_at, captured_at, device_metadata_json,
              enrichment_status, status, created_at, updated_at, version
       FROM capture_bundles
       WHERE id = ? AND account_id = ? AND project_id = ?`,
    )
    .get(input.captureId, input.accountId, input.projectId) as CaptureRow | undefined;
  if (!row || row.status === "discarded") return null;
  if (row.status !== "bound") {
    return row.actor_id === input.actorId ? captureBundleRecord(database, row) : null;
  }

  // A submitted capture is Bug evidence, readable by the same project members
  // as its attachments. Only unsubmitted captures remain private to their author.
  const visibleBug = database
    .prepare(
      `SELECT 1
       FROM bug_attachments AS link
       JOIN bugs AS bug
         ON bug.account_id = link.account_id
        AND bug.project_id = link.project_id
        AND bug.id = link.bug_id
       JOIN attachment_bindings AS binding
         ON binding.account_id = link.account_id
        AND binding.project_id = link.project_id
        AND binding.id = link.binding_id
        AND binding.attachment_id = link.attachment_id
        AND binding.target_bug_id = bug.id
        AND binding.state = 'claimed'
       WHERE link.account_id = ? AND link.project_id = ? AND link.attachment_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM bug_deletions AS deletion
           WHERE deletion.account_id = bug.account_id
             AND deletion.project_id = bug.project_id
             AND deletion.bug_id = bug.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM bug_attachment_removals AS removal
           WHERE removal.account_id = link.account_id
             AND removal.project_id = link.project_id
             AND removal.bug_id = link.bug_id
             AND removal.attachment_id = link.attachment_id
         )`,
    )
    .get(input.accountId, input.projectId, row.primary_attachment_id);
  return visibleBug ? captureBundleRecord(database, row) : null;
}
