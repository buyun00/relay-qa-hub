import type { MobileHumanWorkflowProjection } from "@relay-qa-hub/storage";

export const MOBILE_HUMAN_WORKFLOW_LATEST_PATH =
  "/api/v1/projects/:projectId/human-workflows/latest" as const;

export interface MobileHumanWorkflowStore {
  readonly getLatest: (query: {
    readonly actorId: string;
    readonly projectId: string;
  }) => MobileHumanWorkflowProjection | null | Promise<MobileHumanWorkflowProjection | null>;
}
