import { createHash } from "node:crypto";

import type {
  ListMobileDuplicateCandidatesInput,
  MarkMobileBugDuplicateInput,
  MobileScopeBootstrap,
  SqliteStorageWorker,
} from "@relay-qa-hub/storage";

import type { MobileDuplicateCandidateList, MobileDuplicateStore } from "./mobile-duplicates.js";

export interface SqliteMobileDuplicateStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
  readonly now?: () => Date;
}

export function createSqliteMobileDuplicateStore(
  options: SqliteMobileDuplicateStoreOptions,
): MobileDuplicateStore {
  const now = options.now ?? (() => new Date());
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
    async markDuplicate(command) {
      if (command.actorId !== options.scope.actorId) {
        throw new TypeError("actor does not match the authenticated mobile scope");
      }
      const input: MarkMobileBugDuplicateInput = {
        ...scope,
        bugId: command.bugId,
        expectedVersion: command.request.expectedVersion,
        canonicalBugId: command.request.canonicalBugId,
        reason: command.request.reason,
        idempotencyKey: command.idempotencyKey,
        requestDigest: createHash("sha256").update(JSON.stringify(command.request)).digest("hex"),
        createdAt: now().toISOString(),
      };
      return options.worker.markMobileBugDuplicate(input);
    },
  };
}
