import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import OverviewPage from "./OverviewPage";

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
      />,
    );

    expect(markup).toContain("Bug 总览");
    expect(markup).toContain("共享总表");
    expect(markup).toContain("未分配");
    expect(markup).toContain("全部状态");
    expect(markup).toContain("反馈问题");
    expect(markup).toContain("负责人");
    expect(markup).toContain("验收人");
    expect(markup).toContain("拖拽调整负责人列宽");
    expect(markup).toContain("拖拽调整验收人列宽");
    expect(markup).toContain("最多一次读取 500 条");
  });
});
