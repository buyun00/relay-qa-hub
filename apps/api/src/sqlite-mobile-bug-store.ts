import { createHash } from "node:crypto";

import type {
  CreateMobileBugInput,
  MobileOccurrenceInput,
  MobileScopeBootstrap,
  SqliteStorageWorker,
  UpdateMobileBugInput,
} from "@relay-qa-hub/storage";

import type {
  MobileBugStore,
  MobileBugListQuery,
  MobileCreateBugRequest,
  MobileCreateBugResponse,
  MobileBugListResponse,
  MobileOccurrenceDraft,
} from "./mobile-bugs.js";

export interface SqliteMobileBugStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
  readonly now?: () => Date;
}

function payloadDigest(request: MobileCreateBugRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function occurrenceInput(occurrence: MobileOccurrenceDraft): MobileOccurrenceInput {
  return {
    observedAt: occurrence.observedAt,
    platform: occurrence.platform,
    ...(occurrence.appVersion == null ? {} : { appVersion: occurrence.appVersion }),
    ...(occurrence.resourceVersion == null ? {} : { resourceVersion: occurrence.resourceVersion }),
    ...(occurrence.gitSha == null ? {} : { gitSha: occurrence.gitSha }),
    ...(occurrence.deviceModel == null ? {} : { deviceModel: occurrence.deviceModel }),
    ...(occurrence.osVersion == null ? {} : { osVersion: occurrence.osVersion }),
    steps: occurrence.steps,
    actualBehavior: occurrence.actualBehavior,
    ...(occurrence.frequency == null ? {} : { frequency: occurrence.frequency }),
    ...(occurrence.errorSignature == null ? {} : { errorSignature: occurrence.errorSignature }),
    ...(occurrence.environment === undefined ? {} : { environment: occurrence.environment }),
  };
}

function requireFirstSliceRequest(
  request: MobileCreateBugRequest,
  scope: MobileScopeBootstrap,
): void {
  if (request.projectId !== scope.projectId) {
    throw new TypeError("projectId does not match the authenticated mobile scope");
  }
  if (request.moduleId != null) {
    throw new TypeError("moduleId is not available in the first mobile slice");
  }
}

export function createSqliteMobileBugStore(options: SqliteMobileBugStoreOptions): MobileBugStore {
  const now = options.now ?? (() => new Date());

  return {
    async createBug(command): Promise<MobileCreateBugResponse> {
      if (command.actorId !== options.scope.actorId) {
        throw new TypeError("actor does not match the authenticated mobile scope");
      }
      requireFirstSliceRequest(command.request, options.scope);
      const input: CreateMobileBugInput = {
        accountId: options.scope.accountId,
        projectId: options.scope.projectId,
        actorId: options.scope.actorId,
        clientSubmissionId: command.request.clientSubmissionId,
        payloadDigest: payloadDigest(command.request),
        title: command.request.title,
        description: command.request.description,
        expectedBehavior: command.request.expectedBehavior,
        severity: command.request.severity,
        priority: command.request.priority,
        occurrence: occurrenceInput(command.request.occurrence),
        attachmentIds: command.request.attachmentIds ?? [],
        captureBundleId: command.request.captureBundleId ?? null,
        createdAt: now().toISOString(),
      };
      const creation = await options.worker.createMobileBug(input);
      return {
        clientSubmissionId: creation.clientSubmissionId,
        qaItem: {
          type: "bug",
          id: creation.bug.id,
          key: creation.bug.key,
        },
        disposition: "created",
        bug: creation.bug,
        occurrenceId: creation.occurrenceId,
        attachmentIds: creation.attachmentIds,
        captureBundleId: creation.captureBundleId,
        eventId: creation.eventId,
        replayed: creation.replayed,
      };
    },

    async listBugs(query: MobileBugListQuery): Promise<MobileBugListResponse> {
      return options.worker.listMobileBugs({
        accountId: options.scope.accountId,
        projectId: query.projectId ?? options.scope.projectId,
        actorId: query.actorId,
        ...(query.q === undefined ? {} : { q: query.q }),
        ...(query.state === undefined ? {} : { state: query.state }),
        ...(query.severity === undefined ? {} : { severity: query.severity }),
        limit: query.limit,
      });
    },

    async getBug(query) {
      if (query.actorId !== options.scope.actorId) return null;
      return options.worker.getMobileBug({
        accountId: options.scope.accountId,
        projectId: options.scope.projectId,
        bugId: query.bugId,
      });
    },

    async updateBug(command) {
      if (command.actorId !== options.scope.actorId) {
        throw new TypeError("actor does not match the authenticated mobile scope");
      }
      const input: UpdateMobileBugInput = {
        accountId: options.scope.accountId,
        projectId: options.scope.projectId,
        actorId: options.scope.actorId,
        bugId: command.bugId,
        expectedVersion: command.request.expectedVersion,
        ...(command.request.title === undefined ? {} : { title: command.request.title }),
        ...(command.request.description === undefined
          ? {}
          : { description: command.request.description }),
        ...(command.request.expectedBehavior === undefined
          ? {}
          : { expectedBehavior: command.request.expectedBehavior }),
        ...(command.request.moduleId === undefined ? {} : { moduleId: command.request.moduleId }),
        ...(command.request.severity === undefined ? {} : { severity: command.request.severity }),
        ...(command.request.priority === undefined ? {} : { priority: command.request.priority }),
        ...(command.request.ownerId === undefined ? {} : { ownerId: command.request.ownerId }),
        ...(command.request.verificationOwnerId === undefined
          ? {}
          : { verificationOwnerId: command.request.verificationOwnerId }),
        idempotencyKey: command.idempotencyKey,
        requestDigest: createHash("sha256")
          .update(JSON.stringify({ bugId: command.bugId, request: command.request }))
          .digest("hex"),
        createdAt: now().toISOString(),
      };
      return options.worker.updateMobileBug(input);
    },
  };
}
