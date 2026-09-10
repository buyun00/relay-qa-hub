import type { MobileScopeBootstrap, SqliteStorageWorker } from "@relay-qa-hub/storage";

import type { MobileAttachmentStore } from "./mobile-attachments.js";

export interface SqliteMobileAttachmentStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
  readonly now?: () => Date;
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
  const actorScope = (actorId: string) =>
    ({
      accountId: options.scope.accountId,
      projectId: options.scope.projectId,
      actorId,
    }) as const;

  return {
    async initUpload(command) {
      requireProject(command.request.projectId, options.scope);
      const session = await options.worker.initMobileUpload({
        ...actorScope(command.actorId),
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
      return options.worker.putMobileUploadChunk({
        ...actorScope(command.actorId),
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
      return options.worker.finalizeMobileUpload({
        ...actorScope(command.actorId),
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

    async getUploadSession(query) {
      return options.worker.getMobileUploadSession({
        ...actorScope(query.actorId),
        sessionId: query.sessionId,
        observedAt: now().toISOString(),
      });
    },

    async bindAttachment(command) {
      requireProject(command.request.projectId, options.scope);
      if (
        command.request.intent !== "bug_create" &&
        command.request.intent !== "verification_result"
      ) {
        throw new TypeError("only Bug creation and Verification result reservations are supported");
      }
      return options.worker.bindMobileAttachment({
        ...actorScope(command.actorId),
        attachmentId: command.attachmentId,
        expectedVersion: command.request.expectedVersion,
        clientSubmissionId: command.request.clientSubmissionId,
        clientAttachmentId: command.request.clientAttachmentId,
        leaseGeneration: command.request.leaseGeneration,
        intent: command.request.intent,
        ...(command.request.targetQaItemId
          ? { targetQaItemId: command.request.targetQaItemId }
          : {}),
        boundAt: now().toISOString(),
      });
    },

    async listBugAttachments(query) {
      return options.worker.listMobileBugAttachments({
        ...actorScope(query.actorId),
        bugId: query.bugId,
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
    },

    async getAttachment(query) {
      const download = await options.worker.getMobileAttachment({
        ...actorScope(query.actorId),
        attachmentId: query.attachmentId,
      });
      if (download === null) return null;
      return {
        metadata: download.metadata,
        bytes: Buffer.from(download.bytes),
      };
    },

    async getAttachmentMetadata(query) {
      return options.worker.getMobileAttachmentMetadata({
        ...actorScope(query.actorId),
        attachmentId: query.attachmentId,
      });
    },

    async getCaptureArtifact(query) {
      const download = await options.worker.getMobileCaptureArtifact({
        ...actorScope(query.actorId),
        bugId: query.bugId,
        captureId: query.captureId,
        artifactKind: query.artifactKind,
      });
      if (download === null) return null;
      return {
        metadata: download.metadata,
        bytes: Buffer.from(download.bytes),
      };
    },
  };
}
