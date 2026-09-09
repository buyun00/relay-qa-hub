import type { WorkflowProjectionQuery, WorkflowProjectionStore } from "./workflow-projection.js";

/** Structural port lets the root add the worker method without importing unregistered exports. */
export interface WorkflowProjectionWorker {
  readonly getBugWorkflowProjection: (
    query: WorkflowProjectionQuery & {
      readonly accountId: string;
      readonly projectId: string;
    },
  ) => Promise<unknown>;
}
export function createSqliteWorkflowProjectionStore(options: {
  readonly worker: WorkflowProjectionWorker;
  readonly scope: { readonly accountId: string; readonly projectId: string };
}): WorkflowProjectionStore {
  return {
    async getPage(query) {
      // Snapshot getters before yielding: a later request/project cannot change this message.
      const input = Object.freeze({
        ...query,
        accountId: options.scope.accountId,
        projectId: options.scope.projectId,
      });
      return options.worker.getBugWorkflowProjection(input);
    },
  };
}
