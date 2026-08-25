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

function requireActor(actorId: string, scope: MobileScopeBootstrap): void {
  if (actorId !== scope.actorId) {
    throw new TypeError("actor does not match the authenticated mobile scope");
  }
}

export function createSqliteMobileInboxStore(
  options: SqliteMobileInboxStoreOptions,
): MobileNotificationStore {
  const now = options.now ?? (() => new Date());
  const scope = {
    accountId: options.scope.accountId,
    projectId: options.scope.projectId,
    actorId: options.scope.actorId,
  } as const;

  return {
    async listNotifications(query): Promise<MobileNotificationList> {
      requireActor(query.actorId, options.scope);
      const input: ListMobileNotificationsInput = {
        ...scope,
        limit: query.limit,
        now: now().toISOString(),
      };
      return options.worker.syncAndListMobileNotifications(input);
    },
  };
}
