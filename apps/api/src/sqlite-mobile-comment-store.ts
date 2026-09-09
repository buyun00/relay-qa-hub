import { createHash } from "node:crypto";

import type {
  CreateMobileCommentInput,
  ListMobileBugCommentsInput,
  MobileScopeBootstrap,
  SqliteStorageWorker,
} from "@relay-qa-hub/storage";

import type { MobileAddBugCommentRequest, MobileCommentStore } from "./mobile-comments.js";

export interface SqliteMobileCommentStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
  readonly now?: () => Date;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createSqliteMobileCommentStore(
  options: SqliteMobileCommentStoreOptions,
): MobileCommentStore {
  const now = options.now ?? (() => new Date());
  const actorScope = (actorId: string) =>
    ({
      accountId: options.scope.accountId,
      projectId: options.scope.projectId,
      actorId,
    }) as const;

  return {
    async listComments(query) {
      const input: ListMobileBugCommentsInput = {
        ...actorScope(query.actorId),
        authorizationProjectId: options.scope.projectId,
        bugId: query.bugId,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: query.limit,
      };
      return options.worker.listMobileBugComments(input);
    },

    async addComment(command) {
      const input: CreateMobileCommentInput = {
        ...actorScope(command.actorId),
        bugId: command.bugId,
        clientSubmissionId: command.request.clientSubmissionId,
        body: command.request.body,
        payloadDigest: digest({ bugId: command.bugId, request: command.request }),
        correlationId: command.correlationId,
        idempotencyKey: command.idempotencyKey,
        createdAt: now().toISOString(),
      };
      return options.worker.createMobileComment(input);
    },

    async listEvents(query) {
      return options.worker.listMobileBugEvents({
        ...actorScope(query.actorId),
        authorizationProjectId: options.scope.projectId,
        bugId: query.bugId,
        ...(query.afterSequence === undefined ? {} : { afterSequence: query.afterSequence }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: query.limit,
      });
    },
  };
}

export type { MobileAddBugCommentRequest };
