import { requestJson } from "./api";

export type ComponentKey =
  "build" | "build_upload.single" | "upload.incremental" | "relay.production" | "qingyu.sync";
export interface ProjectComponent {
  key: ComponentKey;
  enabled: boolean;
  status: "disabled" | "unconfigured" | "ready" | string;
  displayName?: string;
  version: number;
  config: Record<string, unknown>;
}
export interface ManagedProject {
  id: string;
  key: string;
  name: string;
  active: boolean;
  version: number;
  initializationStatus?: "pending" | "ready";
  joinName?: string | null;
  joinCode?: string;
  joinCodeVersion?: number;
  initializationTokenStatus?: "absent" | "issued" | "used" | "revoked";
  initializationLink?: string | null;
  initializationIssuedAt?: string | null;
  initializationUsedAt?: string | null;
  onboardingVersion?: number;
  logo?: {
    mediaType: "image/png" | "image/jpeg" | "image/webp";
    sha256: string;
    size: number;
  } | null;
}
export const componentLabels: Record<ComponentKey, string> = {
  build: "打包",
  "build_upload.single": "单次打包上传",
  "upload.incremental": "增量上传",
  "relay.production": "Relay AI 制作",
  "qingyu.sync": "第三方订单同步",
};
export async function getProjectEntry(projectId: string): Promise<ManagedProject> {
  return (await requestJson(
    `/api/v1/project-entry/${encodeURIComponent(projectId)}`,
    undefined,
    false,
  )) as ManagedProject;
}
export async function listProjectComponents(
  projectId: string,
): Promise<{ projectId: string; items: ProjectComponent[] }> {
  return (await requestJson(`/api/v1/projects/${encodeURIComponent(projectId)}/components`)) as {
    projectId: string;
    items: ProjectComponent[];
  };
}
export async function listGmProjects(): Promise<ManagedProject[]> {
  const value = (await requestJson("/api/v1/gm/projects")) as
    { items?: ManagedProject[] } | ManagedProject[];
  return Array.isArray(value) ? value : (value.items ?? []);
}
export async function saveProject(): Promise<ManagedProject> {
  return (await requestJson("/api/v1/gm/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })) as ManagedProject;
}
export async function resetProjectJoinCode(projectId: string): Promise<ManagedProject> {
  return (await requestJson(
    `/api/v1/gm/projects/${encodeURIComponent(projectId)}/join-code/reset`,
    { method: "POST" },
  )) as ManagedProject;
}
export async function rotateInitializationLink(projectId: string): Promise<ManagedProject> {
  return (await requestJson(
    `/api/v1/gm/projects/${encodeURIComponent(projectId)}/initialization-link/rotate`,
    { method: "POST" },
  )) as ManagedProject;
}
export async function revokeInitializationLink(projectId: string): Promise<ManagedProject> {
  return (await requestJson(
    `/api/v1/gm/projects/${encodeURIComponent(projectId)}/initialization-link/revoke`,
    { method: "POST" },
  )) as ManagedProject;
}
export interface ProjectInitializationInput {
  readonly token: string;
  readonly name: string;
  readonly initialMembers: readonly string[];
  readonly logo?: {
    mediaType: "image/png" | "image/jpeg" | "image/webp";
    dataBase64: string;
  } | null;
}
export async function inspectProjectInitialization(token: string): Promise<ManagedProject> {
  return (await requestJson(
    "/api/v1/project-initialization/inspect",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    },
    false,
  )) as ManagedProject;
}
export async function completeProjectInitialization(
  input: ProjectInitializationInput,
): Promise<ManagedProject> {
  return (await requestJson(
    "/api/v1/project-initialization/complete",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    false,
  )) as ManagedProject;
}
export async function updateProject(
  project: ManagedProject,
  change: { name?: string; active?: boolean },
): Promise<ManagedProject> {
  return (await requestJson(`/api/v1/gm/projects/${encodeURIComponent(project.id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: project.version, ...change }),
  })) as ManagedProject;
}
export async function saveComponent(
  projectId: string,
  component: ProjectComponent,
  enabled: boolean,
  config: Record<string, unknown>,
): Promise<void> {
  await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/components/${encodeURIComponent(component.key)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled, expectedVersion: component.version, config }),
    },
  );
}
export async function saveMembership(
  projectId: string,
  userId: string,
  active: boolean,
  expectedVersion: number,
  gm = false,
): Promise<void> {
  const path = gm
    ? `/api/v1/gm/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`
    : `/api/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`;
  await requestJson(path, {
    method: gm ? "PUT" : "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ active, expectedVersion }),
  });
}
