import { Worker } from "node:worker_threads";

import type {
  BindMobileAttachmentInput,
  FinalizeMobileUploadInput,
  InitMobileUploadInput,
  MobileAttachmentReservation,
  MobileFinalizedAttachment,
  MobileUploadChunkReceipt,
  MobileUploadSession,
  PutMobileUploadChunkInput,
} from "./mobile-attachment-store.js";
import type {
  CreateMobileBugInput,
  MobileBugCreation,
  MobileBugRecord,
  MobileScopeBootstrap,
} from "./mobile-bug-store.js";
import type {
  ListMobileBugsInput,
  MobileBugList,
} from "./mobile-bug-list-store.js";
import type {
  CreateMobileCaptureInput,
  MobileCaptureBundleRecord,
  MobileCaptureCreation,
} from "./mobile-capture-store.js";
import type {
  MobileBuildRecord,
  RegisterMobileBuildInput,
  RegisterMobileBuildResult,
} from "./mobile-build-store.js";
import type {
  ListMobileDuplicateCandidatesInput,
  MobileDuplicateCandidateList,
} from "./mobile-duplicate-store.js";
import type {
  CompleteMobileRelayOutboxInput,
  CreateMobileManualRepairAttemptInput,
  CreateMobileRelayAttemptInput,
  DispatchMobileRelayInput,
  MobileRelayOutboxClaim,
  MobileRelayDispatchAccepted,
  MobileRelayReceipt,
  MobileRelayWebhookProjectionResult,
  MobileManualRepairAttemptRecord,
  MobileRepairAttemptRecord,
  ReceiveMobileRelayWebhookInput,
  RetryMobileRelayOutboxInput,
  TransitionMobileBugInput,
  GetMobileManualRepairAttemptInput,
} from "./mobile-relay-store.js";
import type {
  ListMobileNotificationsInput,
  MobileNotificationList,
} from "./mobile-inbox-store.js";
import type {
  InsertedBugIdentity,
  MigrationReport,
  NewBugStorageRecord,
  SqliteIntegrityReport,
} from "./sqlite.js";

export interface SqliteStorageWorkerOptions {
  readonly databaseFile: string;
  readonly busyTimeoutMs: number;
  readonly backupRoot?: string;
  readonly evidenceRoot?: string;
  readonly quarantineRoot?: string;
  /** @internal Enables migration stress-test commands. Never set in an application process. */
  readonly allowUnsafeTestCommands?: boolean;
}

interface WorkerResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export interface SqliteWorkerInitialization {
  readonly migration: MigrationReport;
  readonly migrationDigest: string;
}

export class SqliteStorageWorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SqliteStorageWorkerError";
  }
}

function workerEntryUrl(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("../dist/sqlite-worker-entry.js", import.meta.url)
    : new URL("./sqlite-worker-entry.js", import.meta.url);
}

export class SqliteStorageWorker {
  readonly initialization: Promise<SqliteWorkerInitialization>;

  private readonly worker: Worker;
  private readonly allowUnsafeTestCommands: boolean;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private closed = false;
  private terminalError: Error | undefined;

  constructor(options: SqliteStorageWorkerOptions) {
    this.allowUnsafeTestCommands = options.allowUnsafeTestCommands === true;
    this.worker = new Worker(workerEntryUrl(), { workerData: options });
    this.worker.on("message", (message: WorkerResponse) => this.onMessage(message));
    this.worker.on("error", (error) => this.terminateWithError(error));
    this.worker.on("exit", (code) => {
      if (!this.closed) {
        this.terminateWithError(
          new SqliteStorageWorkerError(
            "SQLITE_WORKER_EXITED",
            `SQLite worker exited with code ${code}`,
          ),
        );
      }
    });
    this.initialization = this.request<SqliteWorkerInitialization>("initialize").catch(
      async (error: unknown) => {
        const terminalError =
          error instanceof Error
            ? error
            : new SqliteStorageWorkerError(
                "SQLITE_WORKER_INITIALIZATION_FAILED",
                "SQLite worker initialization failed",
              );
        this.terminateWithError(terminalError);
        await this.worker.terminate();
        throw error;
      },
    );
  }

  /** @internal Migration concurrency probe only; production callers must use a complete UnitOfWork. */
  async createBugForMigrationTest(record: NewBugStorageRecord): Promise<InsertedBugIdentity> {
    if (!this.allowUnsafeTestCommands) {
      throw new SqliteStorageWorkerError(
        "SQLITE_TEST_COMMAND_DISABLED",
        "Unsafe SQLite worker test commands are disabled",
      );
    }
    await this.initialization;
    return this.request<InsertedBugIdentity>("testCreateBug", record);
  }

  async ensureMobileScope(scope: MobileScopeBootstrap): Promise<void> {
    await this.initialization;
    await this.request("ensureMobileScope", scope);
  }

  async createMobileBug(input: CreateMobileBugInput): Promise<MobileBugCreation> {
    await this.initialization;
    return this.request<MobileBugCreation>("createMobileBug", input);
  }

  async initMobileUpload(input: InitMobileUploadInput): Promise<MobileUploadSession> {
    await this.initialization;
    return this.request<MobileUploadSession>("initMobileUpload", input);
  }

  async putMobileUploadChunk(input: PutMobileUploadChunkInput): Promise<MobileUploadChunkReceipt> {
    await this.initialization;
    return this.request<MobileUploadChunkReceipt>("putMobileUploadChunk", input);
  }

  async finalizeMobileUpload(input: FinalizeMobileUploadInput): Promise<MobileFinalizedAttachment> {
    await this.initialization;
    return this.request<MobileFinalizedAttachment>("finalizeMobileUpload", input);
  }

  async bindMobileAttachment(
    input: BindMobileAttachmentInput,
  ): Promise<MobileAttachmentReservation> {
    await this.initialization;
    return this.request<MobileAttachmentReservation>("bindMobileAttachment", input);
  }

  async getMobileBug(input: {
    readonly accountId: string;
    readonly projectId: string;
    readonly bugId: string;
  }): Promise<MobileBugRecord | null> {
    await this.initialization;
    return this.request<MobileBugRecord | null>("getMobileBug", input);
  }

  async listMobileBugs(input: ListMobileBugsInput): Promise<MobileBugList> {
    await this.initialization;
    return this.request<MobileBugList>("listMobileBugs", input);
  }

  async listMobileDuplicateCandidates(
    input: ListMobileDuplicateCandidatesInput,
  ): Promise<MobileDuplicateCandidateList> {
    await this.initialization;
    return this.request<MobileDuplicateCandidateList>("listMobileDuplicateCandidates", input);
  }

  async createMobileCapture(input: CreateMobileCaptureInput): Promise<MobileCaptureCreation> {
    await this.initialization;
    return this.request<MobileCaptureCreation>("createMobileCapture", input);
  }

  async getMobileCapture(input: {
    readonly accountId: string;
    readonly projectId: string;
    readonly actorId: string;
    readonly captureId: string;
  }): Promise<MobileCaptureBundleRecord | null> {
    await this.initialization;
    return this.request<MobileCaptureBundleRecord | null>("getMobileCapture", input);
  }

  async registerMobileBuild(input: RegisterMobileBuildInput): Promise<RegisterMobileBuildResult> {
    await this.initialization;
    return this.request<RegisterMobileBuildResult>("registerMobileBuild", input);
  }

  async getMobileBuild(input: {
    readonly accountId: string;
    readonly projectId: string;
    readonly actorId: string;
    readonly buildId: string;
  }): Promise<MobileBuildRecord | null> {
    await this.initialization;
    return this.request<MobileBuildRecord | null>("getMobileBuild", input);
  }

  async syncAndListMobileNotifications(
    input: ListMobileNotificationsInput,
  ): Promise<MobileNotificationList> {
    await this.initialization;
    return this.request<MobileNotificationList>("syncAndListMobileNotifications", input);
  }

  async ensureMobileRelayRoles(scope: MobileScopeBootstrap): Promise<void> {
    await this.initialization;
    await this.request("ensureMobileRelayRoles", scope);
  }

  async transitionMobileBugReady(input: TransitionMobileBugInput): Promise<MobileBugRecord> {
    await this.initialization;
    return this.request<MobileBugRecord>("transitionMobileBugReady", input);
  }

  async createMobileRelayAttempt(
    input: CreateMobileRelayAttemptInput,
  ): Promise<MobileRepairAttemptRecord> {
    await this.initialization;
    return this.request<MobileRepairAttemptRecord>("createMobileRelayAttempt", input);
  }

  async createMobileManualRepairAttempt(
    input: CreateMobileManualRepairAttemptInput,
  ): Promise<MobileManualRepairAttemptRecord> {
    await this.initialization;
    return this.request<MobileManualRepairAttemptRecord>(
      "createMobileManualRepairAttempt",
      input,
    );
  }

  async getMobileManualRepairAttempt(
    input: GetMobileManualRepairAttemptInput,
  ): Promise<MobileManualRepairAttemptRecord | null> {
    await this.initialization;
    return this.request<MobileManualRepairAttemptRecord | null>(
      "getMobileManualRepairAttempt",
      input,
    );
  }

  async dispatchMobileRelay(input: DispatchMobileRelayInput): Promise<MobileRelayDispatchAccepted> {
    await this.initialization;
    return this.request<MobileRelayDispatchAccepted>("dispatchMobileRelay", input);
  }

  async getMobileRelayReceipt(input: {
    readonly accountId: string;
    readonly projectId: string;
    readonly actorId: string;
    readonly attemptId: string;
  }): Promise<MobileRelayReceipt | null> {
    await this.initialization;
    return this.request<MobileRelayReceipt | null>("getMobileRelayReceipt", input);
  }

  async receiveMobileRelayWebhook(
    input: ReceiveMobileRelayWebhookInput,
  ): Promise<MobileRelayWebhookProjectionResult> {
    await this.initialization;
    return this.request<MobileRelayWebhookProjectionResult>("receiveMobileRelayWebhook", input);
  }

  async claimMobileRelayOutbox(input: {
    readonly leaseOwner: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<MobileRelayOutboxClaim | null> {
    await this.initialization;
    return this.request<MobileRelayOutboxClaim | null>("claimMobileRelayOutbox", input);
  }

  async completeMobileRelayOutbox(
    input: CompleteMobileRelayOutboxInput,
  ): Promise<MobileRelayReceipt> {
    await this.initialization;
    return this.request<MobileRelayReceipt>("completeMobileRelayOutbox", input);
  }

  async retryMobileRelayOutbox(input: RetryMobileRelayOutboxInput): Promise<boolean> {
    await this.initialization;
    return this.request<boolean>("retryMobileRelayOutbox", input);
  }

  /** @internal Forces an unexpected worker exit for terminal-state regression tests. */
  async terminateForMigrationTest(): Promise<void> {
    if (!this.allowUnsafeTestCommands) {
      throw new SqliteStorageWorkerError(
        "SQLITE_TEST_COMMAND_DISABLED",
        "Unsafe SQLite worker test commands are disabled",
      );
    }
    await this.initialization;
    await this.worker.terminate();
  }

  async integrity(): Promise<SqliteIntegrityReport> {
    await this.initialization;
    return this.request<SqliteIntegrityReport>("integrity");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.initialization;
    await this.request("close");
    this.closed = true;
    await this.worker.terminate();
  }

  private request<T>(operation: string, payload?: unknown): Promise<T> {
    if (this.terminalError !== undefined) {
      return Promise.reject(this.terminalError);
    }
    if (this.closed) {
      return Promise.reject(
        new SqliteStorageWorkerError("SQLITE_WORKER_CLOSED", "SQLite worker is closed"),
      );
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.worker.postMessage({ id, operation, payload });
      } catch (error) {
        this.pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : new SqliteStorageWorkerError(
                "SQLITE_WORKER_POST_FAILED",
                "Could not send the SQLite worker request",
              ),
        );
      }
    });
  }

  private onMessage(message: WorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.value);
    } else {
      pending.reject(
        new SqliteStorageWorkerError(
          message.error?.code ?? "SQLITE_WORKER_FAILED",
          message.error?.message ?? "SQLite worker failed",
        ),
      );
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private terminateWithError(error: Error): void {
    if (this.terminalError !== undefined) return;
    this.terminalError = error;
    this.closed = true;
    this.failAll(error);
  }
}
