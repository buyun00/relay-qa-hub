import { Worker } from "node:worker_threads";

import type {
  ArchiveSqliteRecoveryPointWithAttachmentsOptions,
  SqliteRecoveryPointWithAttachmentsResult,
} from "@relay-qa-hub/storage";

export type BackupArchiveWorkerData = ArchiveSqliteRecoveryPointWithAttachmentsOptions;

interface SerializedWorkerError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
}

export type BackupArchiveWorkerMessage =
  | Readonly<{ ok: true; result: SqliteRecoveryPointWithAttachmentsResult }>
  | Readonly<{ ok: false; error: SerializedWorkerError }>;

interface BackupArchiveWorkerLaunchOptions {
  readonly workerUrl?: URL;
}

function defaultWorkerUrl(): URL {
  return new URL("./backup-archive-worker.js", import.meta.url);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkerMessage(value: unknown): value is BackupArchiveWorkerMessage {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") return false;
  if (value["ok"] === true) return isRecord(value["result"]);
  const error = value["error"];
  return (
    isRecord(error) && typeof error["name"] === "string" && typeof error["message"] === "string"
  );
}

function deserializeWorkerError(serialized: SerializedWorkerError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  if (serialized.stack !== undefined) error.stack = serialized.stack;
  if (serialized.code !== undefined) {
    Object.assign(error, { code: serialized.code });
  }
  return error;
}

/**
 * Run all archive I/O and validation in a disposable worker thread.
 *
 * The archive implementation deliberately uses synchronous create-only I/O in
 * several safety-critical sections. Keeping the whole operation off the API
 * event loop prevents a slow archive volume from stalling HTTP requests.
 */
export function archiveRecoveryPointOffThread(
  input: BackupArchiveWorkerData,
  launchOptions: BackupArchiveWorkerLaunchOptions = {},
): Promise<SqliteRecoveryPointWithAttachmentsResult> {
  const worker = new Worker(launchOptions.workerUrl ?? defaultWorkerUrl(), { workerData: input });

  return new Promise((resolve, reject) => {
    let settled = false;

    const settle = (
      complete: () => void,
      options: Readonly<{ terminate: boolean }> = { terminate: false },
    ): void => {
      if (settled) return;
      settled = true;
      worker.removeAllListeners();
      complete();
      if (options.terminate) void worker.terminate().catch(() => undefined);
    };

    worker.once("message", (message: unknown) => {
      if (!isWorkerMessage(message)) {
        settle(() => reject(new Error("backup archive worker returned an invalid response")), {
          terminate: true,
        });
        return;
      }
      if (message.ok) {
        settle(() => resolve(message.result), { terminate: true });
      } else {
        settle(() => reject(deserializeWorkerError(message.error)), { terminate: true });
      }
    });
    worker.once("error", (error) => settle(() => reject(error)));
    worker.once("exit", (code) => {
      if (code !== 0) {
        settle(() => reject(new Error(`backup archive worker exited with code ${code}`)));
      } else {
        settle(() => reject(new Error("backup archive worker exited without a response")));
      }
    });
  });
}
