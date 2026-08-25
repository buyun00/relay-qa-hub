import type { MobileScopeBootstrap, SqliteStorageWorker } from "@relay-qa-hub/storage";

import type { MobileRelayWebhookStore } from "./mobile-relay-webhook.js";

export interface SqliteMobileRelayWebhookStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
}

export function createSqliteMobileRelayWebhookStore(
  options: SqliteMobileRelayWebhookStoreOptions,
): MobileRelayWebhookStore {
  return {
    receiveRelayWebhook(command) {
      return options.worker.receiveMobileRelayWebhook({
        accountId: options.scope.accountId,
        projectId: options.scope.projectId,
        ...command,
      });
    },
  };
}
