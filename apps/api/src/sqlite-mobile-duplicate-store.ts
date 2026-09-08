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
  const actorScope = (actorId: string) =>
    ({
      accountId: options.scope.accountId,
      projectId: options.scope.projectId,
      actorId,
    }) as const;

  return {
    async listCandidates(query): Promise<MobileDuplicateCandidateList> {
      const input: ListMobileDuplicateCandidatesInput = {
        ...actorScope(query.actorId),
        bugId: query.bugId,
      };
      return options.worker.listMobileDuplicateCandidates(input);
    },
    async markDuplicate(command) {
      const input: MarkMobileBugDuplicateInput = {
        ...actorScope(command.actorId),
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
