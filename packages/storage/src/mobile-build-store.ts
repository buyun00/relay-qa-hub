import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  MobileRelayStorageError,
  type MobileRelayScope,
} from "./mobile-relay-store.js";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,15}$/u;
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\S+$/iu;

export type BuildProvider = "manual" | "ozdqp" | "custom";
export type BuildMode = "full" | "hot_update" | "cdn" | "debug" | "other";
export type BuildStatus =
  | "registered"
  | "queued"
  | "building"
  | "validating"
  | "publishing"
  | "ready"
  | "failed";

export interface MobileBuildRecord {
  readonly id: string;
  readonly projectId: string;
  readonly provider: BuildProvider;
  readonly externalId: string;
  readonly versionName: string;
  readonly channel: string;
  readonly projectKey: string;
  readonly branch: string;
  readonly sourceCommitSha: string;
  readonly mode: BuildMode;
  readonly status: BuildStatus;
  readonly manifest: {
    readonly commitShas: readonly string[];
    readonly artifactSha256: string | null;
  };
  readonly artifactSha256: string | null;
  readonly downloadUrl: string | null;
  readonly version: number;
}

export interface RegisterMobileBuildInput extends MobileRelayScope {
  readonly provider: BuildProvider;
  readonly externalId: string;
  readonly version: string;
  readonly channel: string;
  readonly projectKey: string;
  readonly branch: string;
  readonly sourceCommitSha: string;
  readonly mode: BuildMode;
  readonly status: BuildStatus;
  readonly resourceVersion?: string | null;
  readonly downloadUrl?: string | null;
  readonly manifest: {
    readonly commitShas: readonly string[];
    readonly artifactSha256?: string;
    readonly providerPayloadDigest?: string;
  };
  /** Optional exact human RepairAttempt provenance for the offline lane. */
  readonly repairAttemptId?: string;
  readonly buildId?: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export interface RegisterMobileBuildResult {
  readonly build: MobileBuildRecord;
  readonly eventId: string;
  readonly outboxMessageId: string;
  readonly replayed: boolean;
}

interface BuildRow {
  readonly id: string;
  readonly project_id: string;
  readonly provider: BuildProvider;
  readonly external_id: string;
  readonly version_name: string;
  readonly channel: string;
  readonly project_key: string;
  readonly branch: string;
  readonly source_commit_sha: string;
  readonly mode: BuildMode;
  readonly status: BuildStatus;
  readonly manifest_json: string;
  readonly artifact_sha256: string | null;
  readonly download_url: string | null;
  readonly version: number;
}

interface IdempotencyContext {
  readonly id: string;
  readonly scopeDigest: string;
}

function requireTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "mobile Build storage requires the caller's write transaction",
    );
  }
}

function requireUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} must be a UUID`);
  }
}

function requireCommit(value: string, field: string): void {
  if (!COMMIT_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} must be a lowercase full SHA-1`);
  }
}

function requireSha256(value: string, field: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} must be a lowercase SHA-256`);
  }
}

function requireNonEmpty(value: string, field: string, max: number): void {
  if (value.trim().length === 0 || value.length > max) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} is invalid`);
  }
}

function requireDigest(value: string): void {
  requireSha256(value, "requestDigest");
}

function requireTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "createdAt is invalid");
  }
}

function requireIdempotencyKey(value: string, expected: string): void {
  if (value !== expected || value.length > 255) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "Idempotency-Key is not canonical");
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "JSON is invalid");
  }
  return encoded;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function toBuild(row: BuildRow): MobileBuildRecord {
  let manifest: { commitShas: string[]; artifactSha256: string | null };
  try {
    const decoded = JSON.parse(row.manifest_json) as {
      readonly commitShas?: unknown;
      readonly artifactSha256?: unknown;
    };
    if (
      !Array.isArray(decoded.commitShas) ||
      decoded.commitShas.some((commit) => typeof commit !== "string") ||
      (decoded.artifactSha256 !== undefined && typeof decoded.artifactSha256 !== "string")
    ) {
      throw new Error("invalid manifest");
    }
    manifest = {
      commitShas: [...decoded.commitShas],
      artifactSha256: decoded.artifactSha256 ?? null,
    };
  } catch {
    throw new MobileRelayStorageError("BUILD_IDENTITY_MISMATCH", "Build manifest JSON is invalid");
  }
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    externalId: row.external_id,
    versionName: row.version_name,
    channel: row.channel,
    projectKey: row.project_key,
    branch: row.branch,
    sourceCommitSha: row.source_commit_sha,
    mode: row.mode,
    status: row.status,
    manifest: Object.freeze({
      commitShas: Object.freeze([...manifest.commitShas]),
      artifactSha256: manifest.artifactSha256,
    }),
    artifactSha256: row.artifact_sha256,
    downloadUrl: row.download_url,
    version: row.version,
  });
}

function readBuild(database: DatabaseSync, input: MobileRelayScope, buildId: string): BuildRow | null {
  return (
    (database
      .prepare(
        `SELECT id, project_id, provider, external_id, version_name, channel,
                project_key, branch, source_commit_sha, mode, status, manifest_json,
                artifact_sha256, download_url, version
         FROM builds
         WHERE account_id = ? AND project_id = ? AND id = ?`,
      )
      .get(input.accountId, input.projectId, buildId) as BuildRow | undefined) ?? null
  );
}

function requireRole(database: DatabaseSync, input: MobileRelayScope, role: string): void {
  const row = database
    .prepare(
      `SELECT 1 AS present
       FROM accounts AS account
       JOIN projects AS project
         ON project.account_id = account.id AND project.id = ? AND project.status = 'active'
       JOIN users AS actor
         ON actor.account_id = account.id AND actor.id = ? AND actor.status = 'active'
       JOIN memberships AS membership
         ON membership.account_id = account.id AND membership.project_id = project.id
        AND membership.user_id = actor.id AND membership.status = 'active'
       JOIN membership_roles AS membership_role
         ON membership_role.account_id = membership.account_id
        AND membership_role.project_id = membership.project_id
        AND membership_role.membership_id = membership.id
        AND membership_role.role = ?
       WHERE account.id = ? AND account.status = 'active'`,
    )
    .get(input.projectId, input.actorId, role, input.accountId) as
    | { readonly present: number }
    | undefined;
  if (!row) {
    throw new MobileRelayStorageError("FORBIDDEN", `actor lacks required ${role} project authority`);
  }
}

function requireProjectKey(database: DatabaseSync, input: RegisterMobileBuildInput): void {
  const row = database
    .prepare(
      `SELECT project_key
       FROM projects
       WHERE account_id = ? AND id = ? AND status = 'active'`,
    )
    .get(input.accountId, input.projectId) as { readonly project_key: string } | undefined;
  if (!row) throw new MobileRelayStorageError("NOT_FOUND", "Project was not found");
  if (row.project_key !== input.projectKey) {
    throw new MobileRelayStorageError("BUILD_IDENTITY_MISMATCH", "Build project key is not exact");
  }
}

function nextAggregateSequence(
  database: DatabaseSync,
  input: MobileRelayScope,
  aggregateType: string,
  aggregateId: string,
): number {
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(aggregate_sequence), 0) + 1 AS next_sequence
       FROM events
       WHERE account_id = ? AND project_id = ?
         AND aggregate_type = ? AND aggregate_id = ?`,
    )
    .get(input.accountId, input.projectId, aggregateType, aggregateId) as {
    readonly next_sequence: number;
  };
  return row.next_sequence;
}

function insertQaEvent(
  database: DatabaseSync,
  input: MobileRelayScope,
  values: {
    readonly id: string;
    readonly type: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly aggregateSequence: number;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly resourceVersionAfter: number;
    readonly requestDigest: string;
    readonly fromState: string | null;
    readonly toState: string | null;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO events(
        id, account_id, project_id, bug_id, type, source, actor_type,
        actor_user_id, aggregate_type, aggregate_id, aggregate_sequence,
        resource_type, resource_id, resource_version_after, request_digest,
        correlation_id, causation_id, from_state, to_state, payload_json, created_at
      ) VALUES (?, ?, ?, NULL, ?, 'qa_hub', 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      values.id,
      input.accountId,
      input.projectId,
      values.type,
      input.actorId,
      values.aggregateType,
      values.aggregateId,
      values.aggregateSequence,
      values.resourceType,
      values.resourceId,
      values.resourceVersionAfter,
      values.requestDigest,
      randomUUID(),
      values.fromState,
      values.toState,
      JSON.stringify(values.payload),
      values.createdAt,
    );
}

function insertNotificationOutbox(
  database: DatabaseSync,
  input: MobileRelayScope,
  values: {
    readonly eventId: string;
    readonly aggregateId: string;
    readonly aggregateVersion: number;
    readonly operationId: string;
    readonly createdAt: string;
  },
): string {
  const id = randomUUID();
  const messageId = randomUUID();
  database
    .prepare(
      `INSERT INTO outbox(
        id, account_id, project_id, aggregate_type, aggregate_id, aggregate_version,
        destination, dedupe_key, event_id, payload_json, status, attempt_count,
        next_attempt_at, created_at
      ) VALUES (?, ?, ?, 'build', ?, ?, 'qa-hub.notifications', ?, ?, ?, 'pending', 0, ?, ?)`,
    )
    .run(
      id,
      input.accountId,
      input.projectId,
      values.aggregateId,
      values.aggregateVersion,
      `${values.operationId}:${values.eventId}`,
      values.eventId,
      JSON.stringify({
        type: "notification.requested",
        sourceOperationId: values.operationId,
        eventId: values.eventId,
        messageIds: [messageId],
        recipientsEvaluatedFromCurrentMembership: true,
        committed: true,
        atomicWithEffect: true,
      }),
      values.createdAt,
      values.createdAt,
    );
  return id;
}

function idempotencyScopeDigest(
  input: MobileRelayScope,
  identity: Readonly<Record<string, string | number>>,
): string {
  return digest({
    operationId: "registerBuild",
    accountId: input.accountId,
    projectId: input.projectId,
    actorId: input.actorId,
    ...identity,
  });
}

function beginIdempotency(
  database: DatabaseSync,
  input: RegisterMobileBuildInput,
  scopeDigest: string,
): { readonly context: IdempotencyContext; readonly replay: RegisterMobileBuildResult | null } {
  const existing = database
    .prepare(
      `SELECT id, request_digest, status, response_json
       FROM idempotency_records
       WHERE account_id = ? AND actor_id = ? AND operation_id = 'registerBuild'
         AND scope_digest = ? AND idempotency_key = ?`,
    )
    .get(input.accountId, input.actorId, scopeDigest, input.idempotencyKey) as
    | {
        readonly id: string;
        readonly request_digest: string;
        readonly status: string;
        readonly response_json: string | null;
      }
    | undefined;
  if (existing) {
    if (existing.request_digest !== input.requestDigest) {
      throw new MobileRelayStorageError(
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
        "Idempotency-Key was already used with a different payload",
      );
    }
    if (existing.status !== "committed" || existing.response_json === null) {
      throw new MobileRelayStorageError("VERSION_CONFLICT", "idempotent Build write is not committed");
    }
    const response = JSON.parse(existing.response_json) as RegisterMobileBuildResult;
    return {
      context: { id: existing.id, scopeDigest },
      replay: Object.freeze({ ...response, replayed: true }),
    };
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.parse(now) + 2_592_000_000).toISOString();
  database
    .prepare(
      `INSERT INTO idempotency_records(
        id, account_id, project_id, actor_id, operation_id, idempotency_key,
        scope_digest, scope_json, request_digest, status, created_at, expires_at, version
      ) VALUES (?, ?, ?, ?, 'registerBuild', ?, ?, ?, ?, 'reserved', ?, ?, 1)`,
    )
    .run(
      id,
      input.accountId,
      input.projectId,
      input.actorId,
      input.idempotencyKey,
      scopeDigest,
      JSON.stringify({
        operationId: "registerBuild",
        accountId: input.accountId,
        projectId: input.projectId,
        actorId: input.actorId,
      }),
      input.requestDigest,
      now,
      expiresAt,
    );
  return { context: { id, scopeDigest }, replay: null };
}

function commitIdempotency(
  database: DatabaseSync,
  context: IdempotencyContext,
  response: RegisterMobileBuildResult,
  eventId: string,
): void {
  const result = database
    .prepare(
      `UPDATE idempotency_records
       SET status = 'committed', http_status = ?, response_json = ?, audit_event_id = ?, version = 2
       WHERE id = ? AND status = 'reserved' AND version = 1`,
    )
    .run(200, JSON.stringify(response), eventId, context.id);
  if (result.changes !== 1) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "idempotent Build write did not commit exactly once");
  }
}

function validateBuildRegistration(input: RegisterMobileBuildInput): void {
  requireUuid(input.accountId, "accountId");
  requireUuid(input.projectId, "projectId");
  requireUuid(input.actorId, "actorId");
  requireNonEmpty(input.externalId, "externalId", 300);
  requireNonEmpty(input.version, "version", 100);
  requireNonEmpty(input.channel, "channel", 100);
  requireNonEmpty(input.branch, "branch", 300);
  requireTimestamp(input.createdAt);
  if (!PROJECT_KEY_PATTERN.test(input.projectKey)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "projectKey is invalid");
  }
  requireCommit(input.sourceCommitSha, "sourceCommitSha");
  if (input.repairAttemptId !== undefined) requireUuid(input.repairAttemptId, "repairAttemptId");
  requireDigest(input.requestDigest);
  requireIdempotencyKey(
    input.idempotencyKey,
    `build:register:project:${input.projectId}:provider:${input.provider}:external:${input.externalId}`,
  );
  if (input.provider !== "manual") {
    throw new MobileRelayStorageError("INVALID_REQUEST", "the mobile Build slice only registers manual Builds");
  }
  if (input.mode !== "debug") {
    throw new MobileRelayStorageError("INVALID_REQUEST", "the mobile Build slice requires mode=debug");
  }
  if (input.status !== "ready") {
    throw new MobileRelayStorageError("INVALID_REQUEST", "the mobile Build slice requires status=ready");
  }
  if (
    input.manifest.commitShas.length === 0 ||
    new Set(input.manifest.commitShas).size !== input.manifest.commitShas.length
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "manifest.commitShas must be non-empty and unique");
  }
  for (const commit of input.manifest.commitShas) requireCommit(commit, "manifest.commitShas");
  if (!input.manifest.commitShas.includes(input.sourceCommitSha)) {
    throw new MobileRelayStorageError("BUILD_IDENTITY_MISMATCH", "Build manifest must contain sourceCommitSha");
  }
  if (input.manifest.artifactSha256 !== undefined) {
    requireSha256(input.manifest.artifactSha256, "manifest.artifactSha256");
  }
  if (input.manifest.providerPayloadDigest !== undefined) {
    requireSha256(input.manifest.providerPayloadDigest, "manifest.providerPayloadDigest");
  }
  if (input.resourceVersion !== undefined && input.resourceVersion !== null) {
    requireNonEmpty(input.resourceVersion, "resourceVersion", 100);
  }
  if (input.downloadUrl !== undefined && input.downloadUrl !== null && !URL_PATTERN.test(input.downloadUrl)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "downloadUrl must be an absolute URI");
  }
}

export function registerMobileBuild(
  database: DatabaseSync,
  input: RegisterMobileBuildInput,
): RegisterMobileBuildResult {
  requireTransaction(database);
  validateBuildRegistration(input);
  requireRole(database, input, "release_manager");
  requireProjectKey(database, input);
  const scopeDigest = idempotencyScopeDigest(input, {
    provider: input.provider,
    externalId: input.externalId,
  });
  const { context, replay } = beginIdempotency(database, input, scopeDigest);
  if (replay) return replay;

  const deliveredProvenance = input.repairAttemptId
    ? database
        .prepare(
          `SELECT 1 AS present
           FROM repair_attempts
           WHERE account_id = ? AND project_id = ? AND id = ?
             AND mode = 'human' AND status = 'delivered'
             AND commit_sha = ?`,
        )
        .get(
          input.accountId,
          input.projectId,
          input.repairAttemptId,
          input.sourceCommitSha,
        )
    : database
        .prepare(
          `SELECT 1 AS present
           FROM relay_receipts
           WHERE account_id = ? AND project_id = ?
             AND handoff_status = 'fix_delivered'
             AND delivered_commit_sha = ?
           LIMIT 1`,
        )
        .get(input.accountId, input.projectId, input.sourceCommitSha);
  if (!deliveredProvenance) {
    throw new MobileRelayStorageError(
      "BUILD_IDENTITY_MISMATCH",
      "Build sourceCommitSha is not backed by an exact delivered RepairAttempt provenance",
    );
  }

  const buildId = input.buildId ?? randomUUID();
  requireUuid(buildId, "buildId");
  const existing = database
    .prepare(
      `SELECT id
       FROM builds
       WHERE account_id = ? AND project_id = ? AND provider = ? AND external_id = ?`,
    )
    .get(input.accountId, input.projectId, input.provider, input.externalId) as
    | { readonly id: string }
    | undefined;
  if (existing) {
    throw new MobileRelayStorageError("BUILD_IDENTITY_MISMATCH", "provider/external Build identity already exists");
  }

  const artifactSha256 =
    input.manifest.artifactSha256 ??
    digest({
      accountId: input.accountId,
      projectId: input.projectId,
      buildId,
      sourceCommitSha: input.sourceCommitSha,
    });
  const downloadUrl = input.downloadUrl ?? `https://qa-hub.local/manual-builds/${buildId}`;
  const manifestObject = {
    commitShas: [...input.manifest.commitShas],
    artifactSha256,
    ...(input.manifest.providerPayloadDigest === undefined
      ? {}
      : { providerPayloadDigest: input.manifest.providerPayloadDigest }),
  };
  const manifestJson = canonicalJson(manifestObject);
  const manifestDigest = digest(manifestObject);
  const validatingAt = new Date().toISOString();
  const readyAt = new Date(Date.parse(validatingAt) + 1).toISOString();
  database
    .prepare(
      `INSERT INTO builds(
        id, account_id, project_id, provider, external_id, version_name, channel,
        project_key, branch, source_commit_sha, mode, status, manifest_json,
        manifest_digest, artifact_sha256, download_url, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'validating', ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      buildId,
      input.accountId,
      input.projectId,
      input.provider,
      input.externalId,
      input.version,
      input.channel,
      input.projectKey,
      input.branch,
      input.sourceCommitSha,
      input.mode,
      manifestJson,
      manifestDigest,
      artifactSha256,
      downloadUrl,
      validatingAt,
      validatingAt,
    );
  const insertManifestCommit = database.prepare(
    `INSERT INTO build_manifest_commits(
      account_id, project_id, build_id, commit_sha, ordinal
    ) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const [ordinal, commitSha] of input.manifest.commitShas.entries()) {
    insertManifestCommit.run(input.accountId, input.projectId, buildId, commitSha, ordinal);
  }
  const readyUpdate = database
    .prepare(
      `UPDATE builds
       SET status = 'ready', updated_at = ?, version = 2
       WHERE account_id = ? AND project_id = ? AND id = ?
         AND status = 'validating' AND version = 1`,
    )
    .run(readyAt, input.accountId, input.projectId, buildId);
  if (readyUpdate.changes !== 1) {
    throw new MobileRelayStorageError("VERSION_CONFLICT", "Build did not become ready exactly once");
  }

  const eventId = randomUUID();
  insertQaEvent(database, input, {
    id: eventId,
    type: "build.registered",
    aggregateType: "build",
    aggregateId: buildId,
    aggregateSequence: nextAggregateSequence(database, input, "build", buildId),
    resourceType: "build",
    resourceId: buildId,
    resourceVersionAfter: 2,
    requestDigest: input.requestDigest,
    // events.from_state/to_state are the frozen Bug-state columns; Build status
    // progression belongs in the typed payload instead of those Bug-only fields.
    fromState: null,
    toState: null,
    payload: {
      status: "ready",
      buildId,
      commitSha: input.sourceCommitSha,
      fromVersion: 1,
      toVersion: 2,
    },
    createdAt: readyAt,
  });
  const build = readBuild(database, input, buildId);
  if (!build) throw new MobileRelayStorageError("NOT_FOUND", "Build was not created");
  const outboxMessageId = insertNotificationOutbox(database, input, {
    eventId,
    aggregateId: buildId,
    aggregateVersion: build.version,
    operationId: "registerBuild",
    createdAt: readyAt,
  });
  const response: RegisterMobileBuildResult = Object.freeze({
    build: toBuild(build),
    eventId,
    outboxMessageId,
    replayed: false,
  });
  commitIdempotency(database, context, response, eventId);
  return response;
}

export function getMobileBuild(
  database: DatabaseSync,
  input: MobileRelayScope & { readonly buildId: string },
): MobileBuildRecord | null {
  requireUuid(input.accountId, "accountId");
  requireUuid(input.projectId, "projectId");
  requireUuid(input.actorId, "actorId");
  requireUuid(input.buildId, "buildId");
  requireRole(database, input, "reporter");
  const row = readBuild(database, input, input.buildId);
  return row ? toBuild(row) : null;
}
