import type {
  GetMobileMetricsOverviewInput,
  MobileMetricsOverview,
  MobileScopeBootstrap,
  SqliteStorageWorker,
} from "@relay-qa-hub/storage";

import type { MobileMetricsStore } from "./mobile-metrics.js";

export interface SqliteMobileMetricsStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
}

export function createSqliteMobileMetricsStore(
  options: SqliteMobileMetricsStoreOptions,
): MobileMetricsStore {
  return {
    async getOverview(query): Promise<MobileMetricsOverview> {
      const input: GetMobileMetricsOverviewInput = {
        accountId: options.scope.accountId,
        actorId: query.actorId,
        projectId: query.projectId,
        from: query.from,
        to: query.to,
      };
      return options.worker.getMobileMetricsOverview(input);
    },
  };
}
