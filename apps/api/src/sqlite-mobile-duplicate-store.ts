import type {
  ListMobileDuplicateCandidatesInput,
  MobileScopeBootstrap,
  SqliteStorageWorker,
} from "@relay-qa-hub/storage";

import type {
  MobileDuplicateCandidateList,
  MobileDuplicateStore,
} from "./mobile-duplicates.js";

export interface SqliteMobileDuplicateStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
}

export function createSqliteMobileDuplicateStore(
  options: SqliteMobileDuplicateStoreOptions,
): MobileDuplicateStore {
  const scope = {
    accountId: options.scope.accountId,
    projectId: options.scope.projectId,
    actorId: options.scope.actorId,
  } as const;

  return {
    async listCandidates(query): Promise<MobileDuplicateCandidateList> {
      if (query.actorId !== options.scope.actorId) {
        throw new TypeError("actor does not match the authenticated mobile scope");
      }
      const input: ListMobileDuplicateCandidatesInput = {
        ...scope,
        bugId: query.bugId,
      };
      return options.worker.listMobileDuplicateCandidates(input);
    },
  };
}
