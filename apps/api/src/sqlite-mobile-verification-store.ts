import { createHash } from "node:crypto";

import type {
  CreateMobileVerificationInput,
  GetMobileVerificationInput,
  MobileScopeBootstrap,
  RecordMobileVerificationResultInput,
  SqliteStorageWorker,
  StartMobileVerificationInput,
} from "@relay-qa-hub/storage";

import type {
  MobileCreateVerificationRequest,
  MobileRecordVerificationResultRequest,
  MobileStartVerificationRequest,
  MobileVerificationStore,
} from "./mobile-verification.js";

export interface SqliteMobileVerificationStoreOptions {
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

export function createSqliteMobileVerificationStore(
  options: SqliteMobileVerificationStoreOptions,
): MobileVerificationStore {
  const now = options.now ?? (() => new Date());
  const scope = {
    accountId: options.scope.accountId,
    projectId: options.scope.projectId,
    actorId: options.scope.actorId,
  } as const;

  return {
    async createVerification(command) {
      requireActor(command.actorId, options.scope);
      const request: MobileCreateVerificationRequest = command.request;
      const input: CreateMobileVerificationInput = {
        ...scope,
        bugId: command.bugId,
        expectedVersion: request.expectedVersion,
        repairAttemptId: request.repairAttemptId,
        buildId: request.buildId,
        verifierId: request.verifierId,
        criteria: request.criteria,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(request),
        createdAt: now().toISOString(),
      };
      return options.worker.createMobileVerification(input);
    },

    async getVerification(query) {
      requireActor(query.actorId, options.scope);
      const input: GetMobileVerificationInput = {
        ...scope,
        verificationId: query.verificationId,
      };
      return options.worker.getMobileVerification(input);
    },

    async startVerification(command) {
      requireActor(command.actorId, options.scope);
      const request: MobileStartVerificationRequest = command.request;
      const input: StartMobileVerificationInput = {
        ...scope,
        verificationId: command.verificationId,
        expectedVersion: request.expectedVersion,
        reason: request.reason ?? null,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(request),
        createdAt: now().toISOString(),
      };
      return options.worker.startMobileVerification(input);
    },

    async recordResult(command) {
      requireActor(command.actorId, options.scope);
      const request: MobileRecordVerificationResultRequest = command.request;
      const input: RecordMobileVerificationResultInput = {
        ...scope,
        verificationId: command.verificationId,
        expectedVersion: request.expectedVersion,
        status: request.status,
        resultSummary: request.resultSummary,
        clientSubmissionId: request.clientSubmissionId,
        attachmentIds: request.attachmentIds,
        captureBundleId: request.captureBundleId ?? null,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(request),
        createdAt: now().toISOString(),
      };
      return options.worker.recordMobileVerificationResult(input);
    },
  };
}
