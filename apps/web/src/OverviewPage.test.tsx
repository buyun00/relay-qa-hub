import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import OverviewPage, {
  buildOverviewDateBuckets,
  displayBugNumber,
  formatOverviewDateLabel,
  overviewDateKey,
} from "./OverviewPage";

describe("Bug overview", () => {
  it("renders the shared-table filters and ownership controls", () => {
    const markup = renderToStaticMarkup(
      <OverviewPage
        members={[
          {
            userId: "10000000-0000-4000-8000-000000000003",
            projectId: "10000000-0000-4000-8000-000000000004",
            displayName: "罗东乐",
            roles: ["developer"],
            active: true,
          },
        ]}
        onCreateBug={() => undefined}
        onDateBucketsChange={() => undefined}
        onMutated={() => undefined}
        onOpenBug={() => undefined}
        principal={{
          accountId: "10000000-0000-4000-8000-000000000001",
          userId: "10000000-0000-4000-8000-000000000003",
          email: "luodongle@qa.local",
          displayName: "罗东乐",
          csrfToken: "test-csrf",
        }}
        projectId="10000000-0000-4000-8000-000000000004"
        refreshToken={0}
        selectedDate={null}
      />,
    );

    expect(markup).toContain("Bug 总览");
    expect(markup).toContain("共享总表");
    expect(markup).toContain("未分配");
    expect(markup).toContain("全部状态");
    expect(markup).toContain("反馈问题");
    expect(markup).toContain("负责人");
    expect(markup).toContain("关闭人");
    expect(markup).toContain("拖拽调整负责人列宽");
    expect(markup).toContain("拖拽调整关闭人列宽");
    expect(markup).not.toContain("拖拽调整优先级列宽");
    expect(markup).not.toContain("拖拽调整提报人列宽");
    expect(markup).toContain("最多一次读取 500 条");
  });

  it("shows LOCAL keys as plain numeric task numbers", () => {
    expect(displayBugNumber("LOCAL-18")).toBe("18");
    expect(displayBugNumber("local-7")).toBe("7");
    expect(displayBugNumber("QA-42")).toBe("QA-42");
  });

  it("groups Bugs by their Shanghai creation day for the overview date pages", () => {
    expect(overviewDateKey("2026-08-30T16:30:00.000Z")).toBe("2026-08-31");
    expect(overviewDateKey("invalid")).toBeNull();
    expect(
      buildOverviewDateBuckets([
        { createdAt: "2026-08-30T16:30:00.000Z" },
        { createdAt: "2026-08-31T03:00:00.000Z" },
        { createdAt: "2026-08-29T03:00:00.000Z" },
      ]),
    ).toEqual([
      { date: "2026-08-31", count: 2 },
      { date: "2026-08-29", count: 1 },
    ]);
    expect(formatOverviewDateLabel("2026-08-31")).toBe("2026年8月31日");
  });

  it("shows the selected creation date as the active overview scope", () => {
    const markup = renderToStaticMarkup(
      <OverviewPage
        members={[]}
        onCreateBug={() => undefined}
        onDateBucketsChange={() => undefined}
        onMutated={() => undefined}
        onOpenBug={() => undefined}
        principal={{
          accountId: "10000000-0000-4000-8000-000000000001",
          userId: "10000000-0000-4000-8000-000000000003",
          email: "luodongle@qa.local",
          displayName: "罗东乐",
          csrfToken: "test-csrf",
        }}
        projectId="10000000-0000-4000-8000-000000000004"
        refreshToken={0}
        selectedDate="2026-08-31"
      />,
    );

    expect(markup).toContain("Bug 总览 · 2026年8月31日");
    expect(markup).toContain("当前只显示 2026年8月31日 提出的单子");
    expect(markup).toContain('aria-label="2026年8月31日 Bug 总览"');
  });
});
