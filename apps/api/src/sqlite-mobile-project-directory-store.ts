import type { MobileScopeBootstrap, SqliteStorageWorker } from "@relay-qa-hub/storage";

import type { MobileProjectDirectoryStore } from "./mobile-project-directory.js";

export interface SqliteMobileProjectDirectoryStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
}

export function createSqliteMobileProjectDirectoryStore(
  options: SqliteMobileProjectDirectoryStoreOptions,
): MobileProjectDirectoryStore {
  return {
    async listProjects(query) {
      return options.worker.listMobileVisibleProjects({
        accountId: options.scope.accountId,
        actorId: query.actorId,
        limit: query.limit,
      });
    },

    async listMembers(query) {
      return options.worker.listMobileProjectMembers({
        accountId: options.scope.accountId,
        actorId: query.actorId,
        projectId: query.projectId,
        limit: query.limit,
      });
    },

    async listModules(query) {
      return options.worker.listMobileProjectModules({
        accountId: options.scope.accountId,
        actorId: query.actorId,
        projectId: query.projectId,
      });
    },
  };
}
