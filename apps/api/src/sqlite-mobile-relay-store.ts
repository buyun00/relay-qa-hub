import { createHash } from "node:crypto";

import type { MobileScopeBootstrap, SqliteStorageWorker } from "@relay-qa-hub/storage";

import type { MobileRelayStore } from "./mobile-relay.js";

export interface SqliteMobileRelayStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
  readonly now?: () => Date;
  /** Production sets this only when the complete real Relay runtime is configured. */
  readonly relayDispatchEnabled?: boolean;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

class RelayIntegrationNotConfiguredError extends Error {
  readonly code = "RELAY_INTEGRATION_NOT_CONFIGURED" as const;

  constructor() {
    super("Relay integration is not configured");
    this.name = "RelayIntegrationNotConfiguredError";
  }
}

function requireRelayDispatch(options: SqliteMobileRelayStoreOptions): void {
  if (options.relayDispatchEnabled === false) {
    throw new RelayIntegrationNotConfiguredError();
  }
}

export function createSqliteMobileRelayStore(
  options: SqliteMobileRelayStoreOptions,
): MobileRelayStore {
  const now = options.now ?? (() => new Date());
  const actorScope = (actorId: string) =>
    ({
      accountId: options.scope.accountId,
      projectId: options.scope.projectId,
      actorId,
    }) as const;
  return {
    async transitionBugReady(command) {
      return options.worker.transitionMobileBugReady({
        ...actorScope(command.actorId),
        bugId: command.bugId,
        expectedVersion: command.request.expectedVersion,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(command.request),
        createdAt: now().toISOString(),
      });
    },
    async createRelayAttempt(command) {
      requireRelayDispatch(options);
      return options.worker.createMobileRelayAttempt({
        ...actorScope(command.actorId),
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
      return options.worker.createMobileManualRepairAttempt({
        ...actorScope(command.actorId),
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
      return options.worker.getMobileManualRepairAttempt({
        ...actorScope(query.actorId),
        attemptId: query.attemptId,
      });
    },
    async startManualAttempt(command) {
      return options.worker.startMobileRepairAttempt({
        ...actorScope(command.actorId),
        attemptId: command.attemptId,
        expectedVersion: command.request.expectedVersion,
        reason: command.request.reason ?? null,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(command.request),
        createdAt: now().toISOString(),
      });
    },
    async deliverManualAttempt(command) {
      const common = {
        ...actorScope(command.actorId),
        attemptId: command.attemptId,
        expectedVersion: command.request.expectedVersion,
        summary: command.request.summary,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(command.request),
        createdAt: now().toISOString(),
      } as const;
      return command.request.deliveryKind === "code"
        ? options.worker.deliverMobileRepairAttempt({
            ...common,
            deliveryKind: "code",
            branch: command.request.branch,
            commitSha: command.request.commitSha,
            mergeRequestUrl: command.request.mergeRequestUrl ?? null,
            patchUrl: command.request.patchUrl ?? null,
            noCodeReason: null,
          })
        : options.worker.deliverMobileRepairAttempt({
            ...common,
            deliveryKind: "no_code",
            branch: null,
            commitSha: null,
            mergeRequestUrl: null,
            patchUrl: null,
            noCodeReason: command.request.noCodeReason,
          });
    },
    async dispatchRelay(command) {
      requireRelayDispatch(options);
      return options.worker.dispatchMobileRelay({
        ...actorScope(command.actorId),
        attemptId: command.attemptId,
        expectedVersion: command.request.expectedVersion,
        handoffId: command.request.handoffId,
        selectedAttachmentIds: command.request.selectedAttachmentIds,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(command.request),
        createdAt: now().toISOString(),
      });
    },
    async continueRelay(command) {
      requireRelayDispatch(options);
      return options.worker.continueMobileRelay({
        ...actorScope(command.actorId),
        attemptId: command.attemptId,
        handoffId: command.request.handoffId,
        actionId: command.request.actionId,
        prompt: command.request.prompt,
        selectedAttachmentIds: command.request.selectedAttachmentIds,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(command.request),
        createdAt: now().toISOString(),
      });
    },
    async getRelayReceipt(query) {
      return options.worker.getMobileRelayReceipt({
        ...actorScope(query.actorId),
        attemptId: query.attemptId,
      });
    },
  };
}
