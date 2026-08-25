import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import App from "./App";
import { product } from "./product";

describe("Relay QA Hub desktop management shell", () => {
  it("states the source-of-truth and Relay authority boundaries", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("桌面管理平台");
    expect(markup).toContain("Relay（可选执行器）");
    expect(markup).toContain("不能验收或关闭 QA Bug");
    expect(markup).toContain("Bug 列表");
    expect(markup).toContain("验证无效项目错误");
  });

  it("exposes the build and frozen contract versions", () => {
    expect(product.appVersion).toBe("0.1.0-debug");
    expect(product.contractVersion).toBe("1.0.0");
  });
});
