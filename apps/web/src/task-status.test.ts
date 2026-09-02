import { describe, expect, it } from "vitest";

import {
  TASK_STATUS_ORDER,
  taskStatusCopy,
  taskStatusForBugState,
  taskStatusLabel,
} from "./task-status";

describe("public task statuses", () => {
  it("exposes exactly the four product statuses", () => {
    expect(TASK_STATUS_ORDER).toEqual(["pending", "inProgress", "verification", "closed"]);
    expect(TASK_STATUS_ORDER.map((status) => taskStatusCopy[status].label)).toEqual([
      "待处理",
      "处理中",
      "已完成待验收",
      "关闭",
    ]);
  });

  it("projects internal workflow details into the four task statuses", () => {
    for (const state of ["reported", "needs_info", "ready"] as const) {
      expect(taskStatusForBugState(state)).toBe("pending");
      expect(taskStatusLabel(state)).toBe("待处理");
    }
    expect(taskStatusForBugState("in_progress")).toBe("inProgress");
    expect(taskStatusLabel("in_progress")).toBe("处理中");
    expect(taskStatusForBugState("awaiting_build")).toBe("verification");
    expect(taskStatusLabel("awaiting_build")).toBe("已完成待验收");
    expect(taskStatusLabel("ready_for_verification")).toBe("已完成待验收");
    expect(taskStatusLabel("closed")).toBe("关闭");
  });
});
