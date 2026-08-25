import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface VersionedEntity {
  readonly id: string;
  readonly version: number;
}

export interface RepositoryReadOptions {
  readonly signal?: AbortSignal;
}

export interface RepositoryWriteOptions extends RepositoryReadOptions {
  readonly expectedVersion: number;
}

export interface PageRequest {
  readonly limit: number;
  readonly cursor?: string;
}

export interface Page<TEntity> {
  readonly items: readonly TEntity[];
  readonly nextCursor?: string;
}

/**
 * Persistence port for a single aggregate type. Implementations are supplied by
 * a UnitOfWork and must not outlive that transaction scope.
 */
export interface Repository<TEntity extends VersionedEntity, TFilter = undefined> {
  getById(id: string, options?: RepositoryReadOptions): Promise<TEntity | null>;
  list(filter: TFilter, page: PageRequest, options?: RepositoryReadOptions): Promise<Page<TEntity>>;
  insert(entity: TEntity, options?: RepositoryReadOptions): Promise<TEntity>;
  update(entity: TEntity, options: RepositoryWriteOptions): Promise<TEntity>;
  remove(id: string, options: RepositoryWriteOptions): Promise<void>;
}

export type AfterCommitEffect = () => void | Promise<void>;

export interface UnitOfWorkContext<TRepositories extends object> {
  readonly repositories: Readonly<TRepositories>;
  readonly signal: AbortSignal;
  afterCommit(effect: AfterCommitEffect): void;
}

export interface UnitOfWorkOptions {
  readonly mode: "read" | "write";
  readonly name: string;
  readonly signal?: AbortSignal;
}

/**
 * Transaction boundary. Implementations commit only when work resolves,
 * rollback when it throws or is aborted, then run registered after-commit
 * effects. Business state, audit events, and outbox rows therefore share one
 * atomic boundary without exposing a database handle to callers.
 */
export interface UnitOfWork<TRepositories extends object> {
  execute<TResult>(
    options: UnitOfWorkOptions,
    work: (context: UnitOfWorkContext<TRepositories>) => Promise<TResult>,
  ): Promise<TResult>;
}

export type StorageHealthStatus = "healthy" | "degraded" | "unhealthy";

export interface StorageHealthCheck {
  readonly dependency: string;
  readonly status: StorageHealthStatus;
  readonly checkedAt: string;
  readonly latencyMs: number;
  /** Sanitized operational detail only; never include paths or credentials. */
  readonly detail?: string;
}

export interface StorageHealthSnapshot {
  readonly status: StorageHealthStatus;
  readonly checkedAt: string;
  readonly checks: readonly StorageHealthCheck[];
}

export interface StorageHealthProbe {
  check(signal?: AbortSignal): Promise<StorageHealthSnapshot>;
}

export function summarizeStorageHealth(
  checks: readonly StorageHealthCheck[],
  checkedAt = new Date(),
): StorageHealthSnapshot {
  const copiedChecks = Object.freeze(checks.map((check) => Object.freeze({ ...check })));
  let status: StorageHealthStatus = "healthy";

  if (copiedChecks.length === 0) {
    status = "unhealthy";
  } else if (copiedChecks.some((check) => check.status === "unhealthy")) {
    status = "unhealthy";
  } else if (copiedChecks.some((check) => check.status === "degraded")) {
    status = "degraded";
  }

  return Object.freeze({
    status,
    checkedAt: checkedAt.toISOString(),
    checks: copiedChecks,
  });
}

export interface StorageConfig {
  readonly driver: "sqlite";
  readonly dataRoot: string;
  readonly databaseFile: string;
  readonly evidenceRoot: string;
  readonly quarantineRoot: string;
  readonly busyTimeoutMs: number;
  readonly wal: true;
}

export interface StorageConfigInput {
  readonly dataRoot: string;
  readonly sourceRoot?: string;
  readonly busyTimeoutMs?: number;
  readonly wal?: boolean;
}

export type StorageEnvironment = Readonly<Record<string, string | undefined>>;

export class StorageConfigurationError extends Error {
  readonly code = "STORAGE_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "StorageConfigurationError";
  }
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

function requireAbsolutePath(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) {
    throw new StorageConfigurationError(`${field} must be an absolute path`);
  }

  return resolve(trimmed);
}

function isWithinOrEqual(candidate: string, parent: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function pathsOverlap(first: string, second: string): boolean {
  return isWithinOrEqual(first, second) || isWithinOrEqual(second, first);
}

function parseBusyTimeout(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_BUSY_TIMEOUT_MS;
  }

  if (!/^\d+$/.test(value)) {
    throw new StorageConfigurationError("QA_HUB_SQLITE_BUSY_TIMEOUT_MS must be an integer");
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 60_000) {
    throw new StorageConfigurationError(
      "QA_HUB_SQLITE_BUSY_TIMEOUT_MS must be between 1 and 60000",
    );
  }

  return parsed;
}

function parseWal(value: string | undefined): boolean {
  if (value === undefined || value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new StorageConfigurationError("QA_HUB_SQLITE_WAL must be true when explicitly configured");
}

export function defineStorageConfig(input: StorageConfigInput): StorageConfig {
  const dataRoot = requireAbsolutePath(input.dataRoot, "dataRoot");
  const sourceRoot =
    input.sourceRoot === undefined
      ? undefined
      : requireAbsolutePath(input.sourceRoot, "sourceRoot");

  if (sourceRoot !== undefined && pathsOverlap(dataRoot, sourceRoot)) {
    throw new StorageConfigurationError("dataRoot and sourceRoot must not contain one another");
  }

  const busyTimeoutMs = input.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) {
    throw new StorageConfigurationError("busyTimeoutMs must be between 1 and 60000");
  }

  if (input.wal === false) {
    throw new StorageConfigurationError("SQLite WAL is required by the frozen storage boundary");
  }

  return Object.freeze({
    driver: "sqlite",
    dataRoot,
    databaseFile: join(dataRoot, "db", "qa-hub.sqlite"),
    evidenceRoot: join(dataRoot, "evidence"),
    quarantineRoot: join(dataRoot, "quarantine"),
    busyTimeoutMs,
    wal: true,
  });
}

export function parseStorageEnvironment(environment: StorageEnvironment): StorageConfig {
  const dataRoot = environment.QA_HUB_DATA_ROOT;
  if (dataRoot === undefined || dataRoot.trim().length === 0) {
    throw new StorageConfigurationError("QA_HUB_DATA_ROOT is required");
  }

  const wal = parseWal(environment.QA_HUB_SQLITE_WAL);
  return defineStorageConfig({
    dataRoot,
    ...(environment.QA_HUB_SOURCE_ROOT === undefined
      ? {}
      : { sourceRoot: environment.QA_HUB_SOURCE_ROOT }),
    busyTimeoutMs: parseBusyTimeout(environment.QA_HUB_SQLITE_BUSY_TIMEOUT_MS),
    wal,
  });
}

export { SqliteStorageWorker, SqliteStorageWorkerError } from "./sqlite-worker.js";
export type { SqliteStorageWorkerOptions, SqliteWorkerInitialization } from "./sqlite-worker.js";
export type {
  CreateMobileBugInput,
  MobileBugCreation,
  MobileBugRecord,
  MobileOccurrenceInput,
  MobileScopeBootstrap,
} from "./mobile-bug-store.js";
export { getLatestMobileHumanWorkflow } from "./mobile-human-workflow-store.js";
export type { MobileHumanWorkflowProjection } from "./mobile-human-workflow-store.js";
export { createMobileComment, listMobileBugEvents } from "./mobile-comment-store.js";
export type {
  CreateMobileCommentInput,
  ListMobileBugEventsInput,
  MobileBugEvent,
  MobileBugEvents,
  MobileCommentCreation,
  MobileCommentRecord,
} from "./mobile-comment-store.js";
export { listMobileBugs } from "./mobile-bug-list-store.js";
export type {
  ListMobileBugsInput,
  MobileBugList,
  MobileBugListState,
} from "./mobile-bug-list-store.js";
export { listMobileDuplicateCandidates, markMobileBugDuplicate } from "./mobile-duplicate-store.js";
export type {
  ListMobileDuplicateCandidatesInput,
  MarkMobileBugDuplicateInput,
  MobileDuplicateCandidate,
  MobileDuplicateCandidateList,
} from "./mobile-duplicate-store.js";
export {
  MOBILE_FAKE_RELAY_INSTANCE_ID,
  MOBILE_FAKE_RELAY_PRINCIPAL_ID,
  MobileRelayStorageError,
  createMobileManualRepairAttempt,
  deliverMobileRepairAttempt,
  getMobileManualRepairAttempt,
  linkMobileBuildRepair,
  receiveMobileRelayWebhook,
  startMobileRepairAttempt,
  updateMobileBug,
} from "./mobile-relay-store.js";
export type {
  CompleteMobileRelayOutboxInput,
  CreateMobileManualRepairAttemptInput,
  CreateMobileRelayAttemptInput,
  DeliverMobileRepairAttemptInput,
  DispatchMobileRelayInput,
  MobileRelayDispatchAccepted,
  MobileRelayOutboxClaim,
  MobileRelayReceipt,
  MobileRelayScope,
  MobileRelayWebhookProjectionResult,
  LinkMobileBuildRepairInput,
  LinkMobileBuildRepairResult,
  MobileManualRepairAttemptRecord,
  MobileBuildRequirementRecord,
  MobileBuildRepairLinkRecord,
  MobileRepairAttemptRecord,
  GetMobileManualRepairAttemptInput,
  ReceiveMobileRelayWebhookInput,
  RetryMobileRelayOutboxInput,
  TransitionMobileBugInput,
  UpdateMobileBugInput,
  StartMobileRepairAttemptInput,
} from "./mobile-relay-store.js";
export type {
  BindMobileAttachmentInput,
  FinalizeMobileUploadInput,
  InitMobileUploadInput,
  MobileAttachmentReservation,
  MobileAttachmentRoots,
  MobileAttachmentScope,
  MobileFinalizedAttachment,
  MobileUploadChunkReceipt,
  MobileUploadSession,
  PutMobileUploadChunkInput,
} from "./mobile-attachment-store.js";
export {
  MOBILE_CAPTURE_ALLOWED_METHODS,
  createMobileCapture,
  getMobileCapture,
} from "./mobile-capture-store.js";
export { getMobileBuild, registerMobileBuild } from "./mobile-build-store.js";
export type {
  MobileBuildRecord,
  RegisterMobileBuildInput,
  RegisterMobileBuildResult,
} from "./mobile-build-store.js";
export {
  createMobileVerification,
  getMobileVerification,
  recordMobileVerificationResult,
  startMobileVerification,
} from "./mobile-verification-store.js";
export type {
  CreateMobileVerificationInput,
  GetMobileVerificationInput,
  MobileVerificationRecord,
  MobileVerificationResultResponse,
  MobileVerificationStatus,
  RecordMobileVerificationResultInput,
  StartMobileVerificationInput,
} from "./mobile-verification-store.js";
export { syncAndListMobileNotifications } from "./mobile-inbox-store.js";
export type {
  ListMobileNotificationsInput,
  MobileNotificationList,
  MobileNotificationRecord,
} from "./mobile-inbox-store.js";
export type {
  CreateMobileCaptureInput,
  MobileCaptureArtifactInput,
  MobileCaptureArtifactKind,
  MobileCaptureArtifactRecord,
  MobileCaptureArtifactStatus,
  MobileCaptureBundleRecord,
  MobileCaptureCreation,
  MobileCaptureDeviceMetadata,
  MobileCaptureEnrichmentStatus,
  MobileCapturePocoInput,
  MobileCapturePocoMethod,
  MobileCapturePocoRecord,
  MobileCaptureScreenSize,
} from "./mobile-capture-store.js";
