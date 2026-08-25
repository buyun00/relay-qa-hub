import type {
  MobileHumanWorkflowForBugProjection,
  MobileHumanWorkflowProjection,
} from "@relay-qa-hub/storage";

export const MOBILE_HUMAN_WORKFLOW_LATEST_PATH =
  "/api/v1/projects/:projectId/human-workflows/latest" as const;
export const MOBILE_BUG_HUMAN_WORKFLOW_PATH = "/api/v1/bugs/:bugId/human-workflow" as const;

export interface MobileHumanWorkflowStore {
  readonly getLatest: (query: {
    readonly actorId: string;
    readonly projectId: string;
  }) => MobileHumanWorkflowProjection | null | Promise<MobileHumanWorkflowProjection | null>;
  readonly getForBug: (query: {
    readonly actorId: string;
    readonly bugId: string;
  }) => MobileHumanWorkflowForBugProjection | Promise<MobileHumanWorkflowForBugProjection>;
}
