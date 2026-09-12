import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PackagingProgressPanel from "./PackagingProgress";
import { reconcileBuilds } from "./packaging-monitor";
import type { BuildProgress } from "./packaging-api";

const build: BuildProgress = {
  number: 10159,
  queueId: 760,
  preset: "external",
  status: "BUILDING",
  startedAt: "2026-09-08T05:40:32.865Z",
  elapsedMs: 600000,
  expectedMs: null,
  triggeredBy: "fixture",
  executor: "Jenkins",
  mode: null,
  includesZip: null,
  percent: 0,
  logError: false,
  queueWait: {
    active: true,
    blockingBuild: "iOS_Build #30",
    elapsedMs: 594072,
    timing: "recorded",
  },
  stages: [
    {
      id: "prepare",
      label: "准备环境",
      work: "同步代码",
      state: "waiting",
      elapsedMs: null,
      toolElapsedMs: null,
      timing: "unavailable",
      expectedMs: null,
      sampleCount: 0,
      alertAfterMs: 300000,
      alertBasis: "initial",
      percent: null,
      alert: false,
    },
  ],
};
const stage = build.stages[0];
const queueWait = build.queueWait;
if (!stage || !queueWait) throw new Error("Invalid queue fixture");
const snapshot = (value: BuildProgress) => ({
  checkedAt: "2026-09-08T05:50:00Z",
  builds: [value],
  queues: [],
});
describe("shared build environment queue display", () => {
  it("shows a started but blocked build as queued, with blocker and wait duration", () => {
    const html = renderToStaticMarkup(
      <PackagingProgressPanel
        progress={snapshot(build)}
        error={false}
        pendingQueues={[{ id: 760, reason: "submitted" }]}
      />,
    );
    expect(html).toContain("正在排队");
    expect(html).toContain("iOS_Build #30");
    expect(html).toContain("9 分 54 秒");
    expect(html).not.toContain("耗时异常");
    expect(html).not.toContain("package-stage is-");
    expect(html).not.toContain("排队 #760");
  });
  it("returns to the actual stage after acquisition and retains the separate wait timer", () => {
    const html = renderToStaticMarkup(
      <PackagingProgressPanel
        progress={snapshot({
          ...build,
          executionElapsedMs: 10000,
          queueWait: { ...queueWait, active: false },
          stages: [{ ...stage, state: "running", elapsedMs: 10000, timing: "recorded" }],
        })}
        error={false}
      />,
    );
    expect(html).toContain("准备环境");
    expect(html).toContain("进行中");
    expect(html).toContain("执行 ");
    expect(html).toContain("10 秒");
    expect(html).not.toContain("正在排队");
    expect(html).not.toContain("耗时异常");
  });
  it("does not send a system phase warning while queued, even with a stale alert flag", () => {
    const result = reconcileBuilds(
      [{ queueId: 760, submittedAt: Date.now(), finished: false, alerts: [] }],
      snapshot({ ...build, stages: [{ ...stage, alert: true }] }),
    );
    expect(result.notices).toEqual([]);
    expect(result.watched[0]?.finished).toBe(false);
    expect(result.watched[0]?.number).toBe(10159);
  });
});

describe("build progress with total-duration history", () => {
  it("renders an estimated bar and distinguishes missing stage timing from missing history", () => {
    const html = renderToStaticMarkup(
      <PackagingProgressPanel
        progress={snapshot({
          ...build,
          queueWait: { ...queueWait, active: false },
          expectedMs: 696706,
          historySampleCount: 2,
          progressBasis: "build_history",
          percent: 63,
          stages: [{ ...stage, state: "running", elapsedMs: 300000, timing: "recorded" }],
        })}
        error={false}
      />,
    );
    expect(html).toContain('aria-valuenow="63"');
    expect(html).toContain("width:63%");
    expect(html).toContain("2 次成功记录");
    expect(html).toContain("整体进度按同类成功构建总耗时估算");
    expect(html).toContain("历史记录未提供本阶段耗时");
    expect(html).not.toContain("正在积累同类构建耗时");
  });
});
