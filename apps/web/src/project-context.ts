let serviceIdentity = typeof location === "undefined" ? "test" : location.origin;
let activeProjectId = "";
let activeUserId = "";
let controller = new AbortController();

export function setServiceIdentity(value: string): void {
  serviceIdentity = value.replace(/\/+$/u, "");
}

export function projectStorageKey(
  kind: string,
  projectId = activeProjectId,
  userId = activeUserId,
): string {
  return `qa-hub:preview:v2:${JSON.stringify([serviceIdentity, projectId, userId, kind])}`;
}

export function getActiveProjectId(): string {
  return activeProjectId;
}

export function invalidateProjectRequests(): void {
  controller.abort(new DOMException("Project access changed", "AbortError"));
  controller = new AbortController();
}

export function setActiveProject(projectId: string, userId = activeUserId): void {
  if (activeProjectId !== projectId || activeUserId !== userId) {
    controller.abort(new DOMException("Project context changed", "AbortError"));
    controller = new AbortController();
  }
  activeProjectId = projectId;
  activeUserId = userId;
  try {
    sessionStorage.setItem(projectStorageKey("selected-project", "", ""), projectId);
  } catch {
    /* A project remains explicit even without storage. */
  }
}

export function entryProjectId(): string {
  if (typeof location === "undefined") return "";
  const supplied = new URL(location.href).searchParams.get("projectId");
  if (supplied) return supplied.trim();
  try {
    return sessionStorage.getItem(projectStorageKey("selected-project", "", "")) ?? "";
  } catch {
    return "";
  }
}

export function projectRequestSnapshot(
  init: RequestInit = {},
  projectId = activeProjectId,
): RequestInit {
  const headers = new Headers(init.headers);
  if (projectId && !headers.has("x-qa-project-id")) headers.set("x-qa-project-id", projectId);
  return {
    ...init,
    headers,
    signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
  };
}

export function assertProjectRequest(init: RequestInit): void {
  if (init.signal?.aborted)
    throw new DOMException("项目已切换，此请求已停止。原项目草稿已保留。", "AbortError");
}
