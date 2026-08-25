import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";

import type { SqliteStorageWorker } from "@relay-qa-hub/storage";

export type ApiDependencyStatus = "ok" | "degraded" | "down";
export type ApiEvidenceStatus = "ok" | "read_only" | "low_space" | "down";
export type ApiWorkerStatus = "ok" | "stalled" | "down";

export interface ApiDependencyHealthSnapshot {
  readonly status: ApiDependencyStatus;
  readonly schemaVersion: string | null;
  readonly database: ApiDependencyStatus;
  readonly evidence: ApiEvidenceStatus;
  readonly worker: ApiWorkerStatus;
}

export interface ApiDependencyHealthProbe {
  readonly check: () => Promise<ApiDependencyHealthSnapshot>;
}

export interface SqliteApiHealthProbeOptions {
  readonly worker: SqliteStorageWorker;
  readonly evidenceRoot: string;
  readonly quarantineRoot: string;
}

async function checkAttachmentRoots(roots: readonly string[]): Promise<ApiEvidenceStatus> {
  try {
    for (const root of roots) {
      const metadata = await stat(root);
      if (!metadata.isDirectory()) return "down";
      await access(root, constants.R_OK | constants.W_OK);
    }
    return "ok";
  } catch {
    return "down";
  }
}

export function createSqliteApiHealthProbe(
  options: SqliteApiHealthProbeOptions,
): ApiDependencyHealthProbe {
  return Object.freeze({
    check: async (): Promise<ApiDependencyHealthSnapshot> => {
      let database: ApiDependencyStatus = "down";
      let worker: ApiWorkerStatus = "down";
      let schemaVersion: string | null = null;

      try {
        const initialization = await options.worker.initialization;
        schemaVersion = String(initialization.migration.toVersion);
        const integrity = await options.worker.integrity();
        worker = "ok";
        database = integrity.ok ? "ok" : "down";
      } catch {
        database = "down";
        worker = "down";
      }

      const evidence = await checkAttachmentRoots([options.evidenceRoot, options.quarantineRoot]);
      const status: ApiDependencyStatus =
        database === "ok" && evidence === "ok" && worker === "ok" ? "ok" : "down";
      return Object.freeze({ status, schemaVersion, database, evidence, worker });
    },
  });
}

export const unavailableApiDependencyHealthProbe: ApiDependencyHealthProbe = Object.freeze({
  check: async () =>
    Object.freeze({
      status: "down" as const,
      schemaVersion: null,
      database: "down" as const,
      evidence: "down" as const,
      worker: "down" as const,
    }),
});
