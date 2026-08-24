import { parentPort, workerData } from "node:worker_threads";
import type { DatabaseSync } from "node:sqlite";

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
  readonly allowUnsafeTestCommands?: boolean;
}

interface WorkerRequest {
  readonly id: number;
  readonly operation: "initialize" | "testCreateBug" | "integrity" | "close";
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
