import { createHash } from "node:crypto";

import type { MobileScopeBootstrap, SqliteStorageWorker } from "@relay-qa-hub/storage";

import type { MobileRelayStore } from "./mobile-relay.js";

export interface SqliteMobileRelayStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
  readonly now?: () => Date;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireActor(actorId: string, scope: MobileScopeBootstrap): void {
  if (actorId !== scope.actorId) throw new TypeError("actor does not match the authenticated mobile scope");
}

export function createSqliteMobileRelayStore(
  options: SqliteMobileRelayStoreOptions,
): MobileRelayStore {
  const now = options.now ?? (() => new Date());
  const scope = {
    accountId: options.scope.accountId,
    projectId: options.scope.projectId,
    actorId: options.scope.actorId,
  } as const;
  return {
    async transitionBugReady(command) {
      requireActor(command.actorId, options.scope);
      return options.worker.transitionMobileBugReady({
        ...scope,
        bugId: command.bugId,
        expectedVersion: command.request.expectedVersion,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(command.request),
        createdAt: now().toISOString(),
      });
    },
    async createRelayAttempt(command) {
      requireActor(command.actorId, options.scope);
      return options.worker.createMobileRelayAttempt({
        ...scope,
        bugId: command.bugId,
        expectedVersion: command.request.expectedVersion,
        assigneeId: command.request.assigneeId,
        summary: command.request.summary ?? null,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(command.request),
        createdAt: now().toISOString(),
      });
    },
    async createManualAttempt(command) {
      requireActor(command.actorId, options.scope);
      return options.worker.createMobileManualRepairAttempt({
        ...scope,
        bugId: command.bugId,
        expectedVersion: command.request.expectedVersion,
        assigneeId: command.request.assigneeId,
        summary: command.request.summary ?? null,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(command.request),
        createdAt: now().toISOString(),
      });
    },
    async getManualAttempt(query) {
      if (query.actorId !== options.scope.actorId) return null;
      return options.worker.getMobileManualRepairAttempt({ ...scope, attemptId: query.attemptId });
    },
    async startManualAttempt(command) {
      requireActor(command.actorId, options.scope);
      return options.worker.startMobileRepairAttempt({
        ...scope,
        attemptId: command.attemptId,
        expectedVersion: command.request.expectedVersion,
        reason: command.request.reason ?? null,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(command.request),
        createdAt: now().toISOString(),
      });
    },
    async deliverManualAttempt(command) {
      requireActor(command.actorId, options.scope);
      return options.worker.deliverMobileRepairAttempt({
        ...scope,
        attemptId: command.attemptId,
        expectedVersion: command.request.expectedVersion,
        summary: command.request.summary,
        branch: command.request.branch,
        commitSha: command.request.commitSha,
        mergeRequestUrl: command.request.mergeRequestUrl ?? null,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(command.request),
        createdAt: now().toISOString(),
      });
    },
    async dispatchRelay(command) {
      requireActor(command.actorId, options.scope);
      return options.worker.dispatchMobileRelay({
        ...scope,
        attemptId: command.attemptId,
        expectedVersion: command.request.expectedVersion,
        handoffId: command.request.handoffId,
        selectedAttachmentIds: command.request.selectedAttachmentIds,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(command.request),
        createdAt: now().toISOString(),
      });
    },
    async getRelayReceipt(query) {
      if (query.actorId !== options.scope.actorId) return null;
      return options.worker.getMobileRelayReceipt({ ...scope, attemptId: query.attemptId });
    },
  };
}
