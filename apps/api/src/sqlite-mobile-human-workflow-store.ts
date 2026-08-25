import type { MobileScopeBootstrap, SqliteStorageWorker } from "@relay-qa-hub/storage";

import type { MobileHumanWorkflowStore } from "./mobile-human-workflows.js";

export interface SqliteMobileHumanWorkflowStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
}

function requireActor(actorId: string, scope: MobileScopeBootstrap): void {
  if (actorId !== scope.actorId) {
    throw new TypeError("actor does not match the authenticated mobile scope");
  }
}

export function createSqliteMobileHumanWorkflowStore(
  options: SqliteMobileHumanWorkflowStoreOptions,
): MobileHumanWorkflowStore {
  return {
    async getLatest(query) {
      requireActor(query.actorId, options.scope);
      return options.worker.getLatestMobileHumanWorkflow({
        accountId: options.scope.accountId,
        projectId: query.projectId,
        actorId: query.actorId,
      });
    },
  };
}
