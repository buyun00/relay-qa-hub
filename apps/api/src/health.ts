import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, open, stat, statfs, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

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
  readonly timeoutMs?: number;
  readonly minimumFreeBytes?: bigint;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MINIMUM_FREE_BYTES = 512n * 1024n * 1024n;
const READ_ONLY_ERROR_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

class HealthProbeTimeoutError extends Error {
  constructor() {
    super("health dependency probe timed out");
    this.name = "HealthProbeTimeoutError";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HealthProbeTimeoutError()), timeoutMs);
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function checkAttachmentRoot(
  root: string,
  minimumFreeBytes: bigint,
): Promise<ApiEvidenceStatus> {
  const probePath = join(root, `.qa-hub-health-${process.pid}-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    const metadata = await stat(root);
    if (!metadata.isDirectory()) return "down";
    await access(root, constants.R_OK);
    handle = await open(probePath, "wx", 0o600);
    await handle.writeFile("qa-hub-health", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await unlink(probePath);
    const fileSystem = await statfs(root, { bigint: true });
    return fileSystem.bavail * fileSystem.bsize < minimumFreeBytes ? "low_space" : "ok";
  } catch (error: unknown) {
    return READ_ONLY_ERROR_CODES.has(errorCode(error) ?? "") ? "read_only" : "down";
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(probePath).catch(() => undefined);
  }
}

async function checkAttachmentRoots(
  roots: readonly string[],
  minimumFreeBytes: bigint,
): Promise<ApiEvidenceStatus> {
  const statuses = await Promise.all(
    roots.map((root) => checkAttachmentRoot(root, minimumFreeBytes)),
  );
  if (statuses.includes("down")) return "down";
  if (statuses.includes("read_only")) return "read_only";
  if (statuses.includes("low_space")) return "low_space";
  return "ok";
}

export function createSqliteApiHealthProbe(
  options: SqliteApiHealthProbeOptions,
): ApiDependencyHealthProbe {
  return Object.freeze({
    check: async (): Promise<ApiDependencyHealthSnapshot> => {
      let database: ApiDependencyStatus = "down";
      let worker: ApiWorkerStatus = "down";
      let schemaVersion: string | null = null;
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const minimumFreeBytes = options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES;
      const evidencePromise = checkAttachmentRoots(
        [options.evidenceRoot, options.quarantineRoot],
        minimumFreeBytes,
      );

      try {
        const result = await withTimeout(
          (async () => {
            const initialization = await options.worker.initialization;
            const integrity = await options.worker.integrity();
            return { initialization, integrity };
          })(),
          timeoutMs,
        );
        schemaVersion = String(result.initialization.migration.toVersion);
        worker = "ok";
        database = result.integrity.ok ? "ok" : "down";
      } catch (error: unknown) {
        if (error instanceof HealthProbeTimeoutError) {
          database = "degraded";
          worker = "stalled";
        } else {
          database = "down";
          worker = "down";
        }
      }

      const evidence = await evidencePromise;
      const status: ApiDependencyStatus =
        database === "down" || evidence === "down" || worker === "down"
          ? "down"
          : database === "ok" && evidence === "ok" && worker === "ok"
            ? "ok"
            : "degraded";
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
