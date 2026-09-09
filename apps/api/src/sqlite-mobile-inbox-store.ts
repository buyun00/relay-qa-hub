import type {
  ListMobileNotificationsInput,
  MobileNotificationList,
  MobileScopeBootstrap,
  SqliteStorageWorker,
} from "@relay-qa-hub/storage";

import type { MobileNotificationStore } from "./mobile-inbox.js";

export interface SqliteMobileInboxStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
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
  };
}
