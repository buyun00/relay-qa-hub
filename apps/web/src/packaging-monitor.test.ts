import { describe, expect, it } from "vitest";
import { readWatchedBuilds, reconcileBuilds, type WatchedBuild } from "./packaging-monitor";
import type { BuildProgress, PackagingProgress } from "./packaging-api";

const watch = (): WatchedBuild => ({
  queueId: 12,
  submittedAt: Date.now(),
  finished: false,
  alerts: [],
});
const build = (overrides: Partial<BuildProgress> = {}): BuildProgress => ({
  number: 34,
  queueId: 12,
  preset: "internal-nosdk",
  status: "BUILDING",
  startedAt: new Date().toISOString(),
  elapsedMs: 1000,
  expectedMs: null,
  triggeredBy: "admin",
  executor: "Jenkins",
  mode: "Res",
  includesZip: false,
  percent: 30,
  stages: [],
  logError: false,
  ...overrides,
});
const snapshot = (builds: BuildProgress[]): PackagingProgress => ({
  checkedAt: new Date().toISOString(),
  builds,
  queues: [],
});
describe("packaging monitor", () => {
  it("persists exact build identity, refreshes on completion once and distinguishes a resources-only build", () => {
    const running = reconcileBuilds([watch()], snapshot([build()]));
    expect(running.watched[0]?.number).toBe(34);
    const restored = readWatchedBuilds(JSON.stringify(running.watched));
    const finished = reconcileBuilds(
      restored,
      snapshot([build({ queueId: null, status: "SUCCESS" })]),
    );
    expect(finished.completed).toBe(true);
    expect(finished.notices).toHaveLength(1);
    expect(finished.notices[0]?.body).toContain("不生成新 APK");
    expect(
      reconcileBuilds(
        readWatchedBuilds(JSON.stringify(finished.watched)),
        snapshot([build({ status: "SUCCESS" })]),
      ).notices,
    ).toHaveLength(0);
  });
  it("does not confuse another build, outages or expired queues with completion", () => {
    expect(
      reconcileBuilds([watch()], snapshot([build({ queueId: 13, status: "SUCCESS" })])).notices,
    ).toHaveLength(0);
    expect(
      reconcileBuilds([watch()], {
        ...snapshot([]),
        queues: [{ id: 12, status: "UNKNOWN", reason: "expired" }],
      }).watched[0]?.finished,
    ).toBe(false);
    const cancelled = reconcileBuilds([watch()], {
      ...snapshot([]),
      queues: [{ id: 12, status: "CANCELLED", reason: "cancelled" }],
    });
    expect(cancelled.watched[0]?.finished).toBe(true);
    expect(cancelled.notices[0]?.kind).toBe("failure");
  });
  it("alerts once per slow stage, remains retryable after log loss and never claims failed builds succeeded", () => {
    const stage = {
      id: "unity",
      label: "Unity 导出",
      work: "编译脚本",
      state: "running" as const,
      elapsedMs: 300_000,
      toolElapsedMs: null,
      timing: "recorded" as const,
      expectedMs: 100_000,
      sampleCount: 3,
      alertAfterMs: 200_000,
      alertBasis: "history" as const,
      percent: 95,
      alert: true,
    };
    expect(
      reconcileBuilds([watch()], snapshot([build({ stages: [stage], logError: true })])).notices,
    ).toHaveLength(0);
    const warned = reconcileBuilds([watch()], snapshot([build({ stages: [stage] })]));
    expect(warned.notices[0]?.kind).toBe("warning");
    expect(
      reconcileBuilds(
        readWatchedBuilds(JSON.stringify(warned.watched)),
        snapshot([build({ stages: [stage] })]),
      ).notices,
    ).toHaveLength(0);
    const failed = reconcileBuilds(warned.watched, snapshot([build({ status: "FAILURE" })]));
    expect(failed.notices[0]?.kind).toBe("failure");
    expect(failed.notices[0]?.title).not.toBe("打包完成");
  });
  it("rejects corrupted and expired persisted watches", () => {
    expect(readWatchedBuilds("invalid")).toEqual([]);
    expect(
      readWatchedBuilds(
        JSON.stringify([
          { ...watch(), queueId: -1 },
          { ...watch(), submittedAt: 0 },
        ]),
      ),
    ).toEqual([]);
  });
});
