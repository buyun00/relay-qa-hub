import { createHash } from "node:crypto";

import type {
  MobileScopeBootstrap,
  LinkMobileBuildRepairInput,
  RegisterMobileBuildInput,
  SqliteStorageWorker,
} from "@relay-qa-hub/storage";

import type { MobileBuildStore } from "./mobile-builds.js";

export interface SqliteMobileBuildStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
  readonly now?: () => Date;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createSqliteMobileBuildStore(
  options: SqliteMobileBuildStoreOptions,
): MobileBuildStore {
  const now = options.now ?? (() => new Date());
  const actorScope = (actorId: string) => ({
    accountId: options.scope.accountId,
    projectId: options.scope.projectId,
    actorId,
  } as const);

  return {
    async registerBuild(command) {
      if (command.projectId !== options.scope.projectId) {
        throw new TypeError("projectId does not match the authenticated mobile scope");
      }
      const input: RegisterMobileBuildInput = {
        ...actorScope(command.actorId),
        provider: command.request.provider,
        externalId: command.request.externalId,
        version: command.request.version,
        channel: command.request.channel,
        projectKey: command.request.projectKey,
        branch: command.request.branch,
        sourceCommitSha: command.request.sourceCommitSha,
        mode: command.request.mode,
        status: command.request.status,
        ...(command.request.resourceVersion === undefined
          ? {}
          : { resourceVersion: command.request.resourceVersion }),
        downloadUrl: command.request.downloadUrl,
        manifest: command.request.manifest,
        ...(command.request.repairAttemptId === undefined
          ? {}
          : { repairAttemptId: command.request.repairAttemptId }),
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(command.request),
        createdAt: now().toISOString(),
      };
      return options.worker.registerMobileBuild(input);
    },

    async getBuild(query) {
      return options.worker.getMobileBuild({
        ...actorScope(query.actorId),
        buildId: query.buildId,
      });
    },

    async linkRepair(command) {
      const input: LinkMobileBuildRepairInput = {
        ...actorScope(command.actorId),
        buildId: command.buildId,
        expectedVersion: command.request.expectedVersion,
        ...(command.request.expectedBugVersion === undefined
          ? {}
          : { expectedBugVersion: command.request.expectedBugVersion }),
        ...(command.request.expectedBuildRequirementVersion === undefined
          ? {}
          : { expectedBuildRequirementVersion: command.request.expectedBuildRequirementVersion }),
        repairAttemptId: command.request.repairAttemptId,
        deliveredCommitSha: command.request.deliveredCommitSha,
        evidenceType: command.request.evidenceType,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(command.request),
        createdAt: now().toISOString(),
      };
      return options.worker.linkMobileBuildRepair(input);
    },
  };
}
