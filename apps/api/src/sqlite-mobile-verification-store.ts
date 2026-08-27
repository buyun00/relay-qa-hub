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

export function createSqliteMobileVerificationStore(
  options: SqliteMobileVerificationStoreOptions,
): MobileVerificationStore {
  const now = options.now ?? (() => new Date());
  const actorScope = (actorId: string) =>
    ({
      accountId: options.scope.accountId,
      projectId: options.scope.projectId,
      actorId,
    }) as const;

  return {
    async createVerification(command) {
      const request: MobileCreateVerificationRequest = command.request;
      const input: CreateMobileVerificationInput = {
        ...actorScope(command.actorId),
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
      const input: GetMobileVerificationInput = {
        ...actorScope(query.actorId),
        verificationId: query.verificationId,
      };
      return options.worker.getMobileVerification(input);
    },

    async startVerification(command) {
      const request: MobileStartVerificationRequest = command.request;
      const input: StartMobileVerificationInput = {
        ...actorScope(command.actorId),
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
      const request: MobileRecordVerificationResultRequest = command.request;
      const common = {
        ...actorScope(command.actorId),
        verificationId: command.verificationId,
        expectedVersion: request.expectedVersion,
        resultSummary: request.resultSummary,
        clientSubmissionId: request.clientSubmissionId,
        attachmentIds: request.attachmentIds,
        captureBundleId: request.captureBundleId ?? null,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest(request),
        createdAt: now().toISOString(),
      } as const;
      const input: RecordMobileVerificationResultInput =
        request.status === "failed"
          ? {
              ...common,
              status: "failed",
              failureReason: request.failureReason,
            }
          : { ...common, status: "passed", failureReason: null };
      return options.worker.recordMobileVerificationResult(input);
    },
  };
}
