import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import App, { canSubmitNewBug, collectClipboardImages, mergeCreateBugImages } from "./App";
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
    expect(markup.match(/class="nav-item is-active"/gu)).toHaveLength(1);
    expect(markup.match(/aria-current="page"/gu)).toHaveLength(1);
  });

  it("exposes the build and frozen contract versions", () => {
    expect(product.appVersion).toBe("1.1.0");
    expect(product.contractVersion).toBe("1.0.0");
  });

  it("collects supported clipboard images and gives them upload-safe names", () => {
    const png = new File([new Uint8Array([1, 2, 3])], "image.png", {
      type: "image/png",
      lastModified: 1,
    });
    const gif = new File([new Uint8Array([4])], "image.gif", {
      type: "image/gif",
      lastModified: 2,
    });
    const pasted = collectClipboardImages(
      [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "", getAsFile: () => png },
        { kind: "file", type: "image/gif", getAsFile: () => gif },
      ],
      1234,
    );

    expect(pasted).toHaveLength(1);
    expect(pasted[0]?.name).toBe("clipboard-1234-1.png");
    expect(pasted[0]?.type).toBe("image/png");
    expect(pasted[0]?.size).toBe(3);
  });

  it("appends supported images without duplicating the same selected file", () => {
    const png = new File([new Uint8Array([1])], "same.png", {
      type: "image/png",
      lastModified: 99,
    });
    const text = new File(["not an image"], "notes.txt", {
      type: "text/plain",
      lastModified: 100,
    });

    expect(mergeCreateBugImages([png], [png, text])).toEqual([png]);
  });

  it("allows creating a Bug without assigning a fixer", () => {
    expect(canSubmitNewBug(null, "verifier-id")).toBe(true);
    expect(canSubmitNewBug("正在提交", "verifier-id")).toBe(false);
    expect(canSubmitNewBug(null, "")).toBe(false);
  });
});
