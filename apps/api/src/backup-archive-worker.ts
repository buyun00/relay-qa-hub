import { parentPort, workerData } from "node:worker_threads";

import { archiveSqliteRecoveryPointWithAttachments } from "@relay-qa-hub/storage";

import type {
  BackupArchiveWorkerData,
  BackupArchiveWorkerMessage,
} from "./backup-archive-worker-client.js";

function serializeError(
  error: unknown,
): Extract<BackupArchiveWorkerMessage, { ok: false }>["error"] {
  if (error instanceof Error) {
    const code = (error as Error & { readonly code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === "string" ? { code } : {}),
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { name: "Error", message: "backup archive worker failed with a non-Error value" };
}

const port = parentPort;
if (port === null) throw new Error("backup archive worker requires a parent port");

try {
  const result = await archiveSqliteRecoveryPointWithAttachments(
    workerData as BackupArchiveWorkerData,
  );
  port.postMessage({ ok: true, result } satisfies BackupArchiveWorkerMessage);
} catch (error) {
  port.postMessage({
    ok: false,
    error: serializeError(error),
  } satisfies BackupArchiveWorkerMessage);
} finally {
  port.close();
}
