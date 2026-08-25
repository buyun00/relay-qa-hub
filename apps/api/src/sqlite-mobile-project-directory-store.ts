import type { MobileScopeBootstrap, SqliteStorageWorker } from "@relay-qa-hub/storage";

import type { MobileProjectDirectoryStore } from "./mobile-project-directory.js";

export interface SqliteMobileProjectDirectoryStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
}

export function createSqliteMobileProjectDirectoryStore(
  options: SqliteMobileProjectDirectoryStoreOptions,
): MobileProjectDirectoryStore {
  function requireActor(actorId: string): void {
    if (actorId !== options.scope.actorId) {
      throw new TypeError("actor does not match the authenticated project directory scope");
    }
  }

  return {
    async listProjects(query) {
      requireActor(query.actorId);
      return options.worker.listMobileVisibleProjects({
        accountId: options.scope.accountId,
        actorId: options.scope.actorId,
        limit: query.limit,
      });
    },

    async listMembers(query) {
      requireActor(query.actorId);
      return options.worker.listMobileProjectMembers({
        accountId: options.scope.accountId,
        actorId: options.scope.actorId,
        projectId: query.projectId,
        limit: query.limit,
      });
    },

    async listModules(query) {
      requireActor(query.actorId);
      return options.worker.listMobileProjectModules({
        accountId: options.scope.accountId,
        actorId: options.scope.actorId,
        projectId: query.projectId,
      });
    },
  };
}
