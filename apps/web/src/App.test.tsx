import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import App from "./App";
import { product } from "./product";

describe("Relay QA Hub browser workbench", () => {
  it("keeps the four-stage workbench and exposes the shared overview", () => {
    const markup = renderToStaticMarkup(
      <App
        onSignOut={() => undefined}
        principal={{
          accountId: "10000000-0000-4000-8000-000000000001",
          userId: "10000000-0000-4000-8000-000000000003",
          email: "luodongle@qa.local",
          displayName: "罗东乐",
          csrfToken: "test-csrf",
        }}
        signingOut={false}
      />,
    );

    expect(markup).toContain("统一事实源已连接");
    expect(markup).toContain("工作台");
    expect(markup).toContain("总览");
    expect(markup).toContain("待处理");
    expect(markup).toContain("处理中");
    expect(markup).toContain("待验收");
    expect(markup).toContain("已完成");
    expect(markup).not.toContain("全部 Bug · 表格视图");
    expect(markup).toContain("人员范围");
    expect(markup).toContain("新建 Bug");
    expect(markup).not.toContain("验证无效项目错误");
  });

  it("exposes the build and frozen contract versions", () => {
    expect(product.appVersion).toBe("1.1.0");
    expect(product.contractVersion).toBe("1.0.0");
  });
});
