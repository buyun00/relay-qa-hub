import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import App from "./App";
import { getPwaNotice, type PwaStatus } from "./pwa-events";
import { product } from "./product";

describe("Relay QA Hub app shell", () => {
  it("states the source-of-truth and Relay authority boundaries", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("独立 QA 事实源");
    expect(markup).toContain("Relay（可选执行器）");
    expect(markup).toContain("不能验收或关闭 QA Bug");
    expect(markup).toContain("P0 运行骨架 · 暂未连接业务 API");
  });

  it("exposes the build and frozen contract versions", () => {
    expect(product.appVersion).toBe("0.1.0-debug");
    expect(product.contractVersion).toBe("1.0.0");
    expect(product.mobileBaselineCssPixels).toBe(360);
  });

  it.each<[PwaStatus, string]>([
    [{ kind: "offline-ready" }, "业务数据仍以服务器为准"],
    [{ kind: "update", apply: vi.fn() }, "发现 QA Hub 新版本"],
    [{ kind: "registration-error" }, "在线 QA 流程不受影响"],
  ])("maps %s to an honest PWA notice", (status, expectedText) => {
    expect(getPwaNotice(status).message).toContain(expectedText);
  });
});
