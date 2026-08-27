import type { MobileScopeBootstrap, SqliteStorageWorker } from "@relay-qa-hub/storage";

import type { MobileHumanWorkflowStore } from "./mobile-human-workflows.js";

export interface SqliteMobileHumanWorkflowStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
}

export function createSqliteMobileHumanWorkflowStore(
  options: SqliteMobileHumanWorkflowStoreOptions,
): MobileHumanWorkflowStore {
  return {
    async getLatest(query) {
      return options.worker.getLatestMobileHumanWorkflow({
        accountId: options.scope.accountId,
        projectId: query.projectId,
        actorId: query.actorId,
      });
    },

    async getForBug(query) {
      return options.worker.getMobileHumanWorkflowForBug({
        accountId: options.scope.accountId,
        projectId: options.scope.projectId,
        actorId: query.actorId,
        bugId: query.bugId,
      });
    },
  };
}
