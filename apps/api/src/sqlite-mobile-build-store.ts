import { createHash } from "node:crypto";

import type {
  MobileScopeBootstrap,
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

function requireActor(actorId: string, scope: MobileScopeBootstrap): void {
  if (actorId !== scope.actorId) {
    throw new TypeError("actor does not match the authenticated mobile scope");
  }
}

export function createSqliteMobileBuildStore(
  options: SqliteMobileBuildStoreOptions,
): MobileBuildStore {
  const now = options.now ?? (() => new Date());
  const scope = {
    accountId: options.scope.accountId,
    projectId: options.scope.projectId,
    actorId: options.scope.actorId,
  } as const;

  return {
    async registerBuild(command) {
      requireActor(command.actorId, options.scope);
      if (command.projectId !== options.scope.projectId) {
        throw new TypeError("projectId does not match the authenticated mobile scope");
      }
      const input: RegisterMobileBuildInput = {
        ...scope,
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
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(command.request),
        createdAt: now().toISOString(),
      };
      return options.worker.registerMobileBuild(input);
    },

    async getBuild(query) {
      requireActor(query.actorId, options.scope);
      return options.worker.getMobileBuild({ ...scope, buildId: query.buildId });
    },
  };
}
