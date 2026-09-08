import { QaHubApiError, requestJson } from "./api";

export interface RelayOutboxItem {
  id: string;
  projectId: string;
  componentVersion: number;
  relayTaskId: string | null;
  handoffId: string;
  bugId: string;
  state: string;
  status: string;
  attemptCount: number;
  errorCode: string | null;
  createdAt: string;
  submittedAt: string | null;
}
export interface RelayOutboxList {
  projectId: string;
  items: RelayOutboxItem[];
}

function scopedList(value: unknown, projectId: string): RelayOutboxList {
  const list = value as RelayOutboxList;
  if (
    list?.projectId !== projectId ||
    !Array.isArray(list.items) ||
    list.items.some((item) => item.projectId !== projectId)
  )
    throw new QaHubApiError(200, "OUTBOX_PROJECT_MISMATCH");
  return list;
}
export async function listRelayOutbox(projectId: string, signal?: AbortSignal) {
  return scopedList(
    await requestJson(
      `/api/v1/projects/${encodeURIComponent(projectId)}/production/outbox`,
      signal ? { signal } : undefined,
    ),
    projectId,
  );
}
export async function resumeRelayOutbox(projectId: string, item: RelayOutboxItem) {
  if (item.projectId !== projectId) throw new QaHubApiError(409, "OUTBOX_PROJECT_MISMATCH");
  return scopedList(
    await requestJson(
      `/api/v1/projects/${encodeURIComponent(projectId)}/production/outbox/${encodeURIComponent(item.id)}/resume`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ),
    projectId,
  );
}
export function relayOutboxResumeReason(
  item: RelayOutboxItem,
  projectId: string,
  enabled: boolean,
  held: boolean,
) {
  if (item.projectId !== projectId) return "此交接不属于当前项目。";
  if (held) return "此实例处于导入冻结；交接记录保留，解除冻结后请刷新。";
  if (!enabled) return "请先启用当前项目的 Relay AI 制作组件。";
  if (
    item.state !== "paused" ||
    item.errorCode !== "COMPONENT_DISABLED_PAUSED" ||
    !["pending", "retry", "claimed"].includes(item.status)
  )
    return "这条交接没有等待显式恢复。";
  return "";
}
export function relayOutboxError(cause: unknown) {
  if (cause instanceof QaHubApiError) {
    const messages: Record<string, string> = {
      IMPORT_EXECUTION_HELD: "此实例处于导入冻结，交接尚未恢复，记录继续保留。",
      COMPONENT_DISABLED: "当前项目的 Relay 组件已关闭，交接尚未恢复。",
      TASK_NOT_PAUSED: "交接状态已变化或仍在执行，请刷新后核对。",
      PROJECT_NOT_ACCESSIBLE: "当前项目不可用，请核对项目及人员关系。",
      PROJECT_MEMBERSHIP_DISABLED: "当前项目人员关系已停用，交接记录仍保留。",
      OUTBOX_PROJECT_MISMATCH: "返回的交接不属于当前项目，已停止显示或恢复。",
    };
    const message = cause.code ? messages[cause.code] : undefined;
    if (message) return message;
  }
  return "交接恢复未完成，请刷新核对状态后重试。";
}
