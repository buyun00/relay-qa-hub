import { describe, expect, it } from "vitest";

import {
  TASK_STATUS_ORDER,
  taskStatusCopy,
  taskStatusForBugState,
  taskStatusLabel,
} from "./task-status";

describe("public task statuses", () => {
  it("exposes exactly the three product statuses", () => {
    expect(TASK_STATUS_ORDER).toEqual(["pending", "verification", "closed"]);
    expect(TASK_STATUS_ORDER.map((status) => taskStatusCopy[status].label)).toEqual([
      "待处理",
      "已完成待验收",
      "关闭",
    ]);
  });

  it("keeps repair and build details inside the pending task status", () => {
    for (const state of [
      "reported",
      "needs_info",
      "ready",
      "in_progress",
      "awaiting_build",
    ] as const) {
      expect(taskStatusForBugState(state)).toBe("pending");
      expect(taskStatusLabel(state)).toBe("待处理");
    }
    expect(taskStatusLabel("ready_for_verification")).toBe("已完成待验收");
    expect(taskStatusLabel("closed")).toBe("关闭");
  });
});
