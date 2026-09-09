export const WORKFLOW_COLLECTIONS = [
  "occurrences",
  "repairAttempts",
  "verifications",
  "builds",
  "relayReceipts",
] as const;
export type WorkflowCollection = (typeof WORKFLOW_COLLECTIONS)[number];
export type WorkflowDto = Readonly<Record<string, unknown>>;

/** Only server-derived scope is accepted. This is never an authorization token. */
export interface GetBugWorkflowProjectionInput {
  readonly accountId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly bugId: string;
  readonly cursor?: string;
  readonly limitPerCollection?: number;
}
export interface BugWorkflowProjection {
  readonly bugId: string;
  readonly bugVersion: number;
  readonly snapshotSequence: number;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly occurrences: readonly WorkflowDto[];
  readonly repairAttempts: readonly WorkflowDto[];
  readonly verifications: readonly WorkflowDto[];
  readonly builds: readonly WorkflowDto[];
  readonly relayReceipts: readonly WorkflowDto[];
}
export interface WorkflowWatermark {
  readonly lastSortKey: string | null;
  readonly hasMore: boolean;
}
export type WorkflowWatermarks = Readonly<Record<WorkflowCollection, WorkflowWatermark>>;
export interface WorkflowProjectionOptions {
  readonly now?: () => Date;
  /** Expired snapshots are retained, not deleted. */
  readonly ttlMs?: number;
  readonly maxItemsPerSnapshot?: number;
  readonly maxBytesPerSnapshot?: number;
  readonly maxActiveSnapshotsPerActor?: number;
  /** Includes expired snapshots: history is retained and a full store rejects new snapshots. */
  readonly maxRetainedSnapshotsPerActor?: number;
  readonly maxRetainedBytesPerActor?: number;
}
export type WorkflowProjectionErrorCode =
  | "INVALID_REQUEST"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "SQLITE_TRANSACTION_REQUIRED";
export class WorkflowProjectionError extends Error {
  constructor(
    readonly code: WorkflowProjectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowProjectionError";
  }
}
