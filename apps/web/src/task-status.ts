import type { BugListState } from "./api";

export const TASK_STATUS_ORDER = ["pending", "inProgress", "verification", "closed"] as const;

export type TaskStatus = (typeof TASK_STATUS_ORDER)[number];

export const taskStatusCopy: Readonly<
  Record<TaskStatus, { readonly label: string; readonly hint: string; readonly icon: string }>
> = {
  pending: {
    label: "待处理",
    hint: "待分配、需补充或等待开始处理",
    icon: "✓",
  },
  inProgress: {
    label: "处理中",
    hint: "修复人正在处理",
    icon: "…",
  },
  verification: {
    label: "已完成待验收",
    hint: "修复已完成，等待人工验收",
    icon: "↗",
  },
  closed: {
    label: "关闭",
    hint: "已验收并关闭",
    icon: "◎",
  },
};

// BugListState carries internal workflow/audit detail. Product surfaces must
// project it through this function instead of presenting extra task statuses.
export function taskStatusForBugState(state: BugListState): TaskStatus {
  if (state === "in_progress") return "inProgress";
  if (state === "awaiting_build" || state === "ready_for_verification") return "verification";
  if (state === "closed" || state === "deferred" || state === "rejected" || state === "duplicate") {
    return "closed";
  }
  return "pending";
}

export function taskStatusLabel(state: BugListState): string {
  return taskStatusCopy[taskStatusForBugState(state)].label;
}

export function taskStatusMatches(status: TaskStatus, state: BugListState): boolean {
  return taskStatusForBugState(state) === status;
}
