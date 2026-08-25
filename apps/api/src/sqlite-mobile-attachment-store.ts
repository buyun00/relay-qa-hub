import type { MobileScopeBootstrap, SqliteStorageWorker } from "@relay-qa-hub/storage";

import type { MobileAttachmentStore } from "./mobile-attachments.js";

export interface SqliteMobileAttachmentStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
  readonly now?: () => Date;
}

function requireActor(actorId: string, scope: MobileScopeBootstrap): void {
  if (actorId !== scope.actorId) {
    throw new TypeError("actor does not match the authenticated mobile scope");
  }
}

function requireProject(projectId: string, scope: MobileScopeBootstrap): void {
  if (projectId !== scope.projectId) {
    throw new TypeError("projectId does not match the authenticated mobile scope");
  }
}

export function createSqliteMobileAttachmentStore(
  options: SqliteMobileAttachmentStoreOptions,
): MobileAttachmentStore {
  const now = options.now ?? (() => new Date());
  const scope = {
    accountId: options.scope.accountId,
    projectId: options.scope.projectId,
    actorId: options.scope.actorId,
  } as const;

  return {
    async initUpload(command) {
      requireActor(command.actorId, options.scope);
      requireProject(command.request.projectId, options.scope);
      const session = await options.worker.initMobileUpload({
        ...scope,
        clientSubmissionId: command.request.clientSubmissionId,
        clientAttachmentId: command.request.clientAttachmentId,
        uploadAttempt: command.request.uploadAttempt,
        filename: command.request.filename,
        mediaType: command.request.mediaType,
        captureId: command.request.captureId ?? null,
        expectedSize: command.request.expectedSize,
        sha256: command.request.sha256,
        createdAt: now().toISOString(),
      });
      if (
        session.status !== "open" ||
        session.receivedBytes !== 0 ||
        session.attachmentId !== null
      ) {
        throw new TypeError("upload init replay is not open and empty");
      }
      return {
        sessionId: session.sessionId,
        projectId: session.projectId,
        clientSubmissionId: session.clientSubmissionId,
        clientAttachmentId: session.clientAttachmentId,
        uploadAttempt: session.uploadAttempt,
        status: "open",
        filename: session.filename,
        mediaType: session.mediaType,
        captureId: session.captureId,
        expectedSize: session.expectedSize,
        chunkSize: session.chunkSize,
        sha256: session.sha256,
        expectedChunkCount: session.expectedChunkCount,
        receivedBytes: 0,
        attachmentId: null,
        expiresAt: session.expiresAt,
        confirmedChunks: session.confirmedChunks,
        version: session.version,
        replayed: session.replayed,
      };
    },

    async putChunk(command) {
      requireActor(command.actorId, options.scope);
      return options.worker.putMobileUploadChunk({
        ...scope,
        idempotencyKey: command.idempotencyKey,
        sessionId: command.sessionId,
        chunkNumber: command.chunkNumber,
        expectedVersion: command.expectedVersion,
        clientSubmissionId: command.clientSubmissionId,
        clientAttachmentId: command.clientAttachmentId,
        sha256: command.chunkSha256,
        bytes: command.bytes,
        receivedAt: now().toISOString(),
      });
    },

    async finalizeUpload(command) {
      requireActor(command.actorId, options.scope);
      return options.worker.finalizeMobileUpload({
        ...scope,
        sessionId: command.sessionId,
        expectedVersion: command.request.expectedVersion,
        clientSubmissionId: command.request.clientSubmissionId,
        clientAttachmentId: command.request.clientAttachmentId,
        uploadAttempt: command.request.uploadAttempt,
        sha256: command.request.sha256,
        expectedSize: command.request.expectedSize,
        finalizedAt: now().toISOString(),
      });
    },

    async bindAttachment(command) {
      requireActor(command.actorId, options.scope);
      requireProject(command.request.projectId, options.scope);
      if (command.request.intent !== "bug_create" || command.request.targetQaItemId !== undefined) {
        throw new TypeError("the current mobile slice only supports bug_create reservations");
      }
      return options.worker.bindMobileAttachment({
        ...scope,
        attachmentId: command.attachmentId,
        expectedVersion: command.request.expectedVersion,
        clientSubmissionId: command.request.clientSubmissionId,
        clientAttachmentId: command.request.clientAttachmentId,
        leaseGeneration: command.request.leaseGeneration,
        intent: "bug_create",
        boundAt: now().toISOString(),
      });
    },
  };
}
