import type {
  ListMobileNotificationsInput,
  MarkMobileNotificationReadInput,
  MobileNotificationList,
  MobileNotificationReadRecord,
  MobileScopeBootstrap,
  SqliteStorageWorker,
} from "@relay-qa-hub/storage";

import type { MobileNotificationStore } from "./mobile-inbox.js";
import { createMobileNotificationReadRequestDigest } from "./mobile-replay-digest.js";

export interface SqliteMobileInboxStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
  readonly replayDigestKey: Uint8Array;
  readonly now?: () => Date;
}

export function createSqliteMobileInboxStore(
  options: SqliteMobileInboxStoreOptions,
): MobileNotificationStore {
  const now = options.now ?? (() => new Date());
  const actorScope = (actorId: string) =>
    ({
      accountId: options.scope.accountId,
      projectId: options.scope.projectId,
      actorId,
    }) as const;

  return {
    async listNotifications(query): Promise<MobileNotificationList> {
      const input: ListMobileNotificationsInput = {
        ...actorScope(query.actorId),
        authorizationProjectId: options.scope.projectId,
        ...(query.projectId === undefined ? {} : { requestedProjectId: query.projectId }),
        ...(query.unreadOnly === undefined ? {} : { unreadOnly: query.unreadOnly }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: query.limit,
        now: now().toISOString(),
      };
      return options.worker.syncAndListMobileNotifications(input);
    },
    async markRead(command): Promise<MobileNotificationReadRecord> {
      const input: MarkMobileNotificationReadInput = {
        ...actorScope(command.actorId),
        notificationId: command.notificationId,
        expectedVersion: command.request.expectedVersion,
        idempotencyKey: command.idempotencyKey,
        requestDigest: createMobileNotificationReadRequestDigest({
          key: options.replayDigestKey,
          accountId: options.scope.accountId,
          projectId: options.scope.projectId,
          actorId: command.actorId,
          notificationId: command.notificationId,
          idempotencyKey: command.idempotencyKey,
          request: command.request,
        }),
        readAt: now().toISOString(),
      };
      return options.worker.markMobileNotificationRead(input);
    },
  };
}
