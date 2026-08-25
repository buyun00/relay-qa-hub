import { createHash } from "node:crypto";

import type {
  CreateMobileCommentInput,
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

function requireActor(actorId: string, scope: MobileScopeBootstrap): void {
  if (actorId !== scope.actorId) {
    throw new TypeError("actor does not match the authenticated mobile scope");
  }
}

export function createSqliteMobileCommentStore(
  options: SqliteMobileCommentStoreOptions,
): MobileCommentStore {
  const now = options.now ?? (() => new Date());
  const scope = {
    accountId: options.scope.accountId,
    projectId: options.scope.projectId,
    actorId: options.scope.actorId,
  } as const;

  return {
    async addComment(command) {
      requireActor(command.actorId, options.scope);
      const input: CreateMobileCommentInput = {
        ...scope,
        bugId: command.bugId,
        clientSubmissionId: command.request.clientSubmissionId,
        body: command.request.body,
        payloadDigest: digest({ bugId: command.bugId, request: command.request }),
        idempotencyKey: command.idempotencyKey,
        createdAt: now().toISOString(),
      };
      return options.worker.createMobileComment(input);
    },

    async listEvents(query) {
      requireActor(query.actorId, options.scope);
      return options.worker.listMobileBugEvents({
        ...scope,
        bugId: query.bugId,
        limit: query.limit,
      });
    },
  };
}

export type { MobileAddBugCommentRequest };
