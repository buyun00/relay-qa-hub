import type {
  GetMobileMetricsOverviewInput,
  MobileMetricsOverview,
  MobileScopeBootstrap,
  SqliteStorageWorker,
} from "@relay-qa-hub/storage";

import type { MobileMetricsOverviewQuery, MobileMetricsStore } from "./mobile-metrics.js";

export interface SqliteMobileMetricsStoreOptions {
  readonly worker: SqliteStorageWorker;
  readonly scope: MobileScopeBootstrap;
}

function requireScope(query: MobileMetricsOverviewQuery, scope: MobileScopeBootstrap): void {
  if (query.actorId !== scope.actorId) {
    throw new TypeError("actor does not match the authenticated mobile scope");
  }
  if (query.projectId !== scope.projectId) {
    throw new TypeError("projectId does not match the authenticated mobile scope");
  }
}

export function createSqliteMobileMetricsStore(
  options: SqliteMobileMetricsStoreOptions,
): MobileMetricsStore {
  const scope = {
    accountId: options.scope.accountId,
    projectId: options.scope.projectId,
    actorId: options.scope.actorId,
  } as const;

  return {
    async getOverview(query): Promise<MobileMetricsOverview> {
      requireScope(query, options.scope);
      const input: GetMobileMetricsOverviewInput = {
        ...scope,
        from: query.from,
        to: query.to,
      };
      return options.worker.getMobileMetricsOverview(input);
    },
  };
}
