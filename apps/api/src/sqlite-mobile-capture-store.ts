import type {
  CreateMobileCaptureInput,
  MobileCaptureBundleRecord,
  MobileScopeBootstrap,
  SqliteStorageWorker,
} from "@relay-qa-hub/storage";

import type { MobileCaptureStore } from "./mobile-captures.js";

export interface SqliteMobileCaptureStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
  readonly now?: () => Date;
}

function requireProject(projectId: string, scope: MobileScopeBootstrap): void {
  if (projectId !== scope.projectId)
    throw new TypeError("projectId does not match the authenticated mobile scope");
}

export function createSqliteMobileCaptureStore(
  options: SqliteMobileCaptureStoreOptions,
): MobileCaptureStore {
  const now = options.now ?? (() => new Date());
  const actorScope = (actorId: string) =>
    ({
      accountId: options.scope.accountId,
      projectId: options.scope.projectId,
      actorId,
    }) as const;

  return {
    async createCapture(command) {
      requireProject(command.request.projectId, options.scope);
      const capture = command.request.capture;
      const input: CreateMobileCaptureInput = {
        ...actorScope(command.actorId),
        clientSubmissionId: command.request.clientSubmissionId,
        captureId: capture.captureId,
        capturedAt: capture.capturedAt,
        source: capture.source,
        primaryEvidenceClientAttachmentId: capture.primaryEvidenceClientAttachmentId,
        primaryEvidenceAttachmentId: capture.primaryEvidenceAttachmentId,
        artifacts: capture.artifacts,
        poco: capture.poco,
        deviceMetadata: capture.deviceMetadata,
        createdAt: now().toISOString(),
      };
      const creation = await options.worker.createMobileCapture(input);
      return {
        captureBundle: creation.captureBundle,
        replayed: creation.replayed,
      };
    },

    async getCapture(query): Promise<MobileCaptureBundleRecord | null> {
      return options.worker.getMobileCapture({
        ...actorScope(query.actorId),
        captureId: query.captureId,
      });
    },
  };
}
