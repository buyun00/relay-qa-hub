import { parentPort, workerData } from "node:worker_threads";
import { basename } from "node:path";

import { archiveSqliteRecoveryPointWithAttachments } from "@relay-qa-hub/storage";

import type {
  BackupArchiveWorkerData,
  BackupArchiveWorkerMessage,
  BackupArchiveWorkerResult,
} from "./backup-archive-worker-client.js";
import { pruneRecoveryPoints } from "./backup-retention.js";

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
  const input = workerData as BackupArchiveWorkerData;
  const result: BackupArchiveWorkerResult = {
    ...(await archiveSqliteRecoveryPointWithAttachments(input)),
  };
  if (input.retentionBackupRoot !== undefined) {
    try {
      const retention = await pruneRecoveryPoints({
        backupRoot: input.retentionBackupRoot,
        archiveRoot: input.archiveRoot,
        successfulBackupName: basename(result.backupPath),
      });
      Object.assign(result, { retention });
    } catch (error) {
      // Cleanup must never turn a successful backup into a failed backup, or
      // prevent the next scheduled attempt. Report the failure separately.
      Object.assign(result, {
        retentionError: error instanceof Error ? error.message : String(error),
      });
    }
  }
  port.postMessage({ ok: true, result } satisfies BackupArchiveWorkerMessage);
} catch (error) {
  port.postMessage({
    ok: false,
    error: serializeError(error),
  } satisfies BackupArchiveWorkerMessage);
} finally {
  port.close();
}
