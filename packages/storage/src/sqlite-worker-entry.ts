import { parentPort, workerData } from "node:worker_threads";
import type { DatabaseSync } from "node:sqlite";

import {
  bindMobileAttachment,
  finalizeMobileUpload,
  initMobileUpload,
  putMobileUploadChunk,
  type BindMobileAttachmentInput,
  type FinalizeMobileUploadInput,
  type InitMobileUploadInput,
  type MobileAttachmentRoots,
  type PutMobileUploadChunkInput,
} from "./mobile-attachment-store.js";
import {
  createMobileBug,
  ensureMobileScope,
  getMobileBug,
  type CreateMobileBugInput,
  type MobileScopeBootstrap,
} from "./mobile-bug-store.js";
import {
  listMobileBugs,
  type ListMobileBugsInput,
} from "./mobile-bug-list-store.js";
import { getLatestMobileHumanWorkflow } from "./mobile-human-workflow-store.js";
import {
  createMobileComment,
  listMobileBugEvents,
  type CreateMobileCommentInput,
  type ListMobileBugEventsInput,
} from "./mobile-comment-store.js";
import {
  createMobileCapture,
  getMobileCapture,
  type CreateMobileCaptureInput,
} from "./mobile-capture-store.js";
import {
  getMobileBuild,
  registerMobileBuild,
  type RegisterMobileBuildInput,
} from "./mobile-build-store.js";
import {
  listMobileDuplicateCandidates,
  type ListMobileDuplicateCandidatesInput,
} from "./mobile-duplicate-store.js";
import {
  syncAndListMobileNotifications,
  type ListMobileNotificationsInput,
} from "./mobile-inbox-store.js";
import {
  claimMobileRelayOutbox,
  completeMobileRelayOutbox,
  createMobileManualRepairAttempt,
  createMobileRelayAttempt,
  deliverMobileRepairAttempt,
  dispatchMobileRelay,
  ensureMobileRelayRoles,
  getMobileRelayReceipt,
  getMobileManualRepairAttempt,
  linkMobileBuildRepair,
  receiveMobileRelayWebhook,
  retryMobileRelayOutbox,
  transitionMobileBugReady,
  type CompleteMobileRelayOutboxInput,
  type CreateMobileManualRepairAttemptInput,
  type CreateMobileRelayAttemptInput,
  type DeliverMobileRepairAttemptInput,
  type DispatchMobileRelayInput,
  type LinkMobileBuildRepairInput,
  type RetryMobileRelayOutboxInput,
  type ReceiveMobileRelayWebhookInput,
  type TransitionMobileBugInput,
  type GetMobileManualRepairAttemptInput,
  type StartMobileRepairAttemptInput,
  startMobileRepairAttempt,
} from "./mobile-relay-store.js";
import {
  createMobileVerification,
  getMobileVerification,
  recordMobileVerificationResult,
  startMobileVerification,
  type CreateMobileVerificationInput,
  type GetMobileVerificationInput,
  type RecordMobileVerificationResultInput,
  type StartMobileVerificationInput,
} from "./mobile-verification-store.js";
import {
  canonicalMigrationDigest,
  insertBugWithNextNumber,
  migrateSqliteDatabase,
  openSqliteDatabaseForWorker,
  verifySqliteIntegrity,
  type NewBugStorageRecord,
} from "./sqlite.js";

interface WorkerConfiguration {
  readonly databaseFile: string;
  readonly busyTimeoutMs: number;
  readonly backupRoot?: string;
  readonly evidenceRoot?: string;
  readonly quarantineRoot?: string;
  readonly allowUnsafeTestCommands?: boolean;
}

interface WorkerRequest {
  readonly id: number;
  readonly operation:
    | "initialize"
    | "ensureMobileScope"
    | "createMobileBug"
    | "getMobileBug"
    | "listMobileBugs"
    | "getLatestMobileHumanWorkflow"
    | "createMobileComment"
    | "listMobileBugEvents"
    | "listMobileDuplicateCandidates"
    | "createMobileCapture"
    | "getMobileCapture"
    | "registerMobileBuild"
    | "getMobileBuild"
    | "createMobileVerification"
    | "getMobileVerification"
    | "startMobileVerification"
    | "recordMobileVerificationResult"
    | "syncAndListMobileNotifications"
    | "ensureMobileRelayRoles"
    | "transitionMobileBugReady"
    | "createMobileRelayAttempt"
    | "createMobileManualRepairAttempt"
    | "getMobileManualRepairAttempt"
    | "startMobileRepairAttempt"
    | "deliverMobileRepairAttempt"
    | "linkMobileBuildRepair"
    | "dispatchMobileRelay"
    | "getMobileRelayReceipt"
    | "receiveMobileRelayWebhook"
    | "claimMobileRelayOutbox"
    | "completeMobileRelayOutbox"
    | "retryMobileRelayOutbox"
    | "initMobileUpload"
    | "putMobileUploadChunk"
    | "finalizeMobileUpload"
    | "bindMobileAttachment"
    | "testCreateBug"
    | "integrity"
    | "close";
  readonly payload?: unknown;
}

interface WorkerResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

const port = parentPort;
if (!port) throw new Error("sqlite worker requires a parent port");

const configuration = workerData as WorkerConfiguration;
let database: DatabaseSync | undefined;

function errorResponse(id: number, error: unknown): WorkerResponse {
  const candidate = error as { code?: unknown; message?: unknown };
  return {
    id,
    ok: false,
    error: {
      code: typeof candidate?.code === "string" ? candidate.code : "SQLITE_WORKER_FAILED",
      message: typeof candidate?.message === "string" ? candidate.message : "SQLite worker failed",
    },
  };
}

function requireDatabase(): DatabaseSync {
  if (!database) throw new Error("sqlite worker is not initialized");
  return database;
}

function requireAttachmentRoots(): MobileAttachmentRoots {
  if (!configuration.evidenceRoot || !configuration.quarantineRoot) {
    throw Object.assign(new Error("SQLite worker attachment roots are not configured"), {
      code: "SQLITE_CONFIGURATION_INVALID",
    });
  }
  return {
    evidenceRoot: configuration.evidenceRoot,
    quarantineRoot: configuration.quarantineRoot,
  };
}

function inWriteTransaction<T>(work: (current: DatabaseSync) => T): T {
  const current = requireDatabase();
  current.exec("BEGIN IMMEDIATE");
  try {
    const value = work(current);
    current.exec("COMMIT");
    return value;
  } catch (error) {
    if (current.isTransaction) current.exec("ROLLBACK");
    throw error;
  }
}

async function execute(request: WorkerRequest): Promise<unknown> {
  if (request.operation === "initialize") {
    if (database) throw new Error("sqlite worker is already initialized");
    database = openSqliteDatabaseForWorker(configuration);
    const migration = await migrateSqliteDatabase(database, configuration.databaseFile, {
      ...(configuration.backupRoot === undefined ? {} : { backupRoot: configuration.backupRoot }),
    });
    return { migration, migrationDigest: canonicalMigrationDigest() };
  }

  if (request.operation === "testCreateBug") {
    if (configuration.allowUnsafeTestCommands !== true) {
      throw Object.assign(new Error("Unsafe SQLite worker test commands are disabled"), {
        code: "SQLITE_TEST_COMMAND_DISABLED",
      });
    }
    const current = requireDatabase();
    current.exec("BEGIN IMMEDIATE");
    try {
      const identity = insertBugWithNextNumber(current, request.payload as NewBugStorageRecord);
      current.exec("COMMIT");
      return identity;
    } catch (error) {
      if (current.isTransaction) current.exec("ROLLBACK");
      throw error;
    }
  }

  if (request.operation === "ensureMobileScope") {
    const current = requireDatabase();
    current.exec("BEGIN IMMEDIATE");
    try {
      ensureMobileScope(current, request.payload as MobileScopeBootstrap);
      current.exec("COMMIT");
      return { ready: true };
    } catch (error) {
      if (current.isTransaction) current.exec("ROLLBACK");
      throw error;
    }
  }

  if (request.operation === "createMobileBug") {
    const current = requireDatabase();
    current.exec("BEGIN IMMEDIATE");
    try {
      const result = createMobileBug(current, request.payload as CreateMobileBugInput);
      current.exec("COMMIT");
      return result;
    } catch (error) {
      if (current.isTransaction) current.exec("ROLLBACK");
      throw error;
    }
  }

  if (request.operation === "getMobileBug") {
    const payload = request.payload as {
      readonly accountId: string;
      readonly projectId: string;
      readonly bugId: string;
    };
    return getMobileBug(requireDatabase(), payload, payload.bugId);
  }

  if (request.operation === "listMobileBugs") {
    return listMobileBugs(requireDatabase(), request.payload as ListMobileBugsInput);
  }

  if (request.operation === "getLatestMobileHumanWorkflow") {
    return getLatestMobileHumanWorkflow(
      requireDatabase(),
      request.payload as {
        readonly accountId: string;
        readonly projectId: string;
        readonly actorId: string;
      },
    );
  }

  if (request.operation === "createMobileComment") {
    return inWriteTransaction((current) =>
      createMobileComment(current, request.payload as CreateMobileCommentInput),
    );
  }

  if (request.operation === "listMobileBugEvents") {
    return listMobileBugEvents(requireDatabase(), request.payload as ListMobileBugEventsInput);
  }

  if (request.operation === "listMobileDuplicateCandidates") {
    return listMobileDuplicateCandidates(
      requireDatabase(),
      request.payload as ListMobileDuplicateCandidatesInput,
    );
  }

  if (request.operation === "createMobileCapture") {
    const current = requireDatabase();
    current.exec("BEGIN IMMEDIATE");
    try {
      const payload = request.payload as CreateMobileCaptureInput;
      const result = createMobileCapture(current, {
        ...payload,
        ...(configuration.evidenceRoot === undefined
          ? {}
          : { evidenceRoot: configuration.evidenceRoot }),
      });
      current.exec("COMMIT");
      return result;
    } catch (error) {
      if (current.isTransaction) current.exec("ROLLBACK");
      throw error;
    }
  }

  if (request.operation === "getMobileCapture") {
    const payload = request.payload as {
      readonly accountId: string;
      readonly projectId: string;
      readonly actorId: string;
      readonly captureId: string;
    };
    return getMobileCapture(requireDatabase(), payload);
  }

  if (request.operation === "registerMobileBuild") {
    return inWriteTransaction((current) =>
      registerMobileBuild(current, request.payload as RegisterMobileBuildInput),
    );
  }

  if (request.operation === "getMobileBuild") {
    const payload = request.payload as {
      readonly accountId: string;
      readonly projectId: string;
      readonly actorId: string;
      readonly buildId: string;
    };
    return getMobileBuild(requireDatabase(), payload);
  }

  if (request.operation === "createMobileVerification") {
    return inWriteTransaction((current) =>
      createMobileVerification(current, request.payload as CreateMobileVerificationInput),
    );
  }

  if (request.operation === "getMobileVerification") {
    return getMobileVerification(
      requireDatabase(),
      request.payload as GetMobileVerificationInput,
    );
  }

  if (request.operation === "startMobileVerification") {
    return inWriteTransaction((current) =>
      startMobileVerification(current, request.payload as StartMobileVerificationInput),
    );
  }

  if (request.operation === "recordMobileVerificationResult") {
    return inWriteTransaction((current) =>
      recordMobileVerificationResult(
        current,
        request.payload as RecordMobileVerificationResultInput,
      ),
    );
  }

  if (request.operation === "syncAndListMobileNotifications") {
    return inWriteTransaction((current) =>
      syncAndListMobileNotifications(current, request.payload as ListMobileNotificationsInput),
    );
  }

  if (request.operation === "ensureMobileRelayRoles") {
    return inWriteTransaction((current) => {
      ensureMobileRelayRoles(current, request.payload as MobileScopeBootstrap);
      return { ready: true };
    });
  }

  if (request.operation === "transitionMobileBugReady") {
    return inWriteTransaction((current) =>
      transitionMobileBugReady(current, request.payload as TransitionMobileBugInput),
    );
  }

  if (request.operation === "createMobileRelayAttempt") {
    return inWriteTransaction((current) =>
      createMobileRelayAttempt(current, request.payload as CreateMobileRelayAttemptInput),
    );
  }

  if (request.operation === "createMobileManualRepairAttempt") {
    return inWriteTransaction((current) =>
      createMobileManualRepairAttempt(
        current,
        request.payload as CreateMobileManualRepairAttemptInput,
      ),
    );
  }

  if (request.operation === "getMobileManualRepairAttempt") {
    return getMobileManualRepairAttempt(
      requireDatabase(),
      request.payload as GetMobileManualRepairAttemptInput,
    );
  }

  if (request.operation === "startMobileRepairAttempt") {
    return inWriteTransaction((current) =>
      startMobileRepairAttempt(current, request.payload as StartMobileRepairAttemptInput),
    );
  }

  if (request.operation === "deliverMobileRepairAttempt") {
    return inWriteTransaction((current) =>
      deliverMobileRepairAttempt(current, request.payload as DeliverMobileRepairAttemptInput),
    );
  }

  if (request.operation === "linkMobileBuildRepair") {
    return inWriteTransaction((current) =>
      linkMobileBuildRepair(current, request.payload as LinkMobileBuildRepairInput),
    );
  }

  if (request.operation === "dispatchMobileRelay") {
    return inWriteTransaction((current) =>
      dispatchMobileRelay(current, request.payload as DispatchMobileRelayInput),
    );
  }

  if (request.operation === "getMobileRelayReceipt") {
    const payload = request.payload as {
      readonly accountId: string;
      readonly projectId: string;
      readonly actorId: string;
      readonly attemptId: string;
    };
    return getMobileRelayReceipt(requireDatabase(), payload);
  }

  if (request.operation === "receiveMobileRelayWebhook") {
    return inWriteTransaction((current) =>
      receiveMobileRelayWebhook(current, request.payload as ReceiveMobileRelayWebhookInput),
    );
  }

  if (request.operation === "claimMobileRelayOutbox") {
    return inWriteTransaction((current) =>
      claimMobileRelayOutbox(
        current,
        request.payload as {
          readonly leaseOwner: string;
          readonly now: string;
          readonly leaseExpiresAt: string;
        },
      ),
    );
  }

  if (request.operation === "completeMobileRelayOutbox") {
    return inWriteTransaction((current) =>
      completeMobileRelayOutbox(current, request.payload as CompleteMobileRelayOutboxInput),
    );
  }

  if (request.operation === "retryMobileRelayOutbox") {
    return inWriteTransaction((current) =>
      retryMobileRelayOutbox(current, request.payload as RetryMobileRelayOutboxInput),
    );
  }

  if (request.operation === "initMobileUpload") {
    return inWriteTransaction((current) =>
      initMobileUpload(current, request.payload as InitMobileUploadInput),
    );
  }

  if (request.operation === "putMobileUploadChunk") {
    return inWriteTransaction((current) =>
      putMobileUploadChunk(
        current,
        requireAttachmentRoots(),
        request.payload as PutMobileUploadChunkInput,
      ),
    );
  }

  if (request.operation === "finalizeMobileUpload") {
    return inWriteTransaction((current) =>
      finalizeMobileUpload(
        current,
        requireAttachmentRoots(),
        request.payload as FinalizeMobileUploadInput,
      ),
    );
  }

  if (request.operation === "bindMobileAttachment") {
    return inWriteTransaction((current) =>
      bindMobileAttachment(current, request.payload as BindMobileAttachmentInput),
    );
  }

  if (request.operation === "integrity") {
    return verifySqliteIntegrity(requireDatabase());
  }

  if (request.operation === "close") {
    const current = requireDatabase();
    current.close();
    database = undefined;
    return { closed: true };
  }

  throw Object.assign(new Error(`Unsupported SQLite worker operation: ${request.operation}`), {
    code: "SQLITE_WORKER_OPERATION_UNSUPPORTED",
  });
}

let queue = Promise.resolve();
port.on("message", (request: WorkerRequest) => {
  queue = queue.then(async () => {
    try {
      const value = await execute(request);
      port.postMessage({ id: request.id, ok: true, value } satisfies WorkerResponse);
    } catch (error) {
      port.postMessage(errorResponse(request.id, error));
    }
  });
});
