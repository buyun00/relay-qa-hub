import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CaptureBundleSummary } from "./api";
import PocoContextPanel from "./PocoContextPanel";
import { summarizePocoHierarchy, summarizeUnitySnapshot } from "./poco-context";

const hierarchy = {
  name: "<Root>",
  payload: { name: "<Root>", type: "Root", visible: true },
  children: [
    {
      name: "GameFramework",
      payload: { name: "GameFramework", type: "GameObject", visible: true },
      children: [
        {
          name: "UI",
          payload: { name: "UI", type: "GameObject", visible: true },
          children: [
            {
              name: "CameraLayer",
              payload: { name: "CameraLayer", type: "Node", visible: true },
              children: [
                {
                  name: "MenuLayer",
                  payload: { name: "MenuLayer", type: "Node", visible: true },
                  children: [
                    {
                      name: "Hall-3_optimized(Clone)",
                      payload: {
                        name: "Hall-3_optimized(Clone)",
                        type: "Node",
                        visible: true,
                        _instanceId: -4452,
                        components: ["RectTransform", "HallLobbyMainView", "HallView", "UIForm"],
                      },
                      children: [
                        {
                          name: "btn_start",
                          payload: {
                            name: "btn_start",
                            type: "Button",
                            visible: true,
                            clickable: true,
                            text: "开始游戏",
                            texture: "Assets/UI/Hall/btn_start.png",
                            components: ["RectTransform", "Button"],
                          },
                        },
                        {
                          name: "hidden_panel",
                          payload: { name: "hidden_panel", type: "Node", visible: false },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const snapshot = {
  schemaVersion: 1,
  captureId: "1c6222ea-2375-493d-8d86-0843e68d6194",
  status: "partial",
  capturedAtUnixMs: 1_787_795_182_497,
  data: {
    appVersion: "2.1.65",
    unityVersion: "2022.3.62f3",
    scene: "Hall",
    recentErrorWindowMs: 120_000,
    ui: {
      groups: [
        {
          name: "MenuLayer",
          forms: [
            {
              prefabName: "HallLobby",
              assetKey: "Assets/UI/Hall/Hall-3_optimized.prefab",
              instanceName: "Hall-3_optimized(Clone)",
              hierarchyPath: "GameFramework/UI/CameraLayer/MenuLayer/Hall-3_optimized(Clone)",
              rootInstanceId: -4452,
              siblingIndex: 7,
              shown: true,
              activeInHierarchy: true,
            },
          ],
        },
      ],
    },
    recentErrors: [
      {
        type: "Exception",
        message: "NullReferenceException in HallLobbyMainView",
        lastAtUnixMs: 1_787_795_179_000,
        occurrences: 2,
      },
    ],
  },
  warnings: ["business_fields_unavailable"],
};

const bundle: CaptureBundleSummary = {
  captureId: "1c6222ea-2375-493d-8d86-0843e68d6194",
  enrichmentStatus: "partial",
  artifacts: [
    {
      captureId: "1c6222ea-2375-493d-8d86-0843e68d6194",
      attachmentId: "10000000-0000-4000-8000-000000000001",
      kind: "poco_hierarchy",
      status: "succeeded",
    },
    {
      captureId: "1c6222ea-2375-493d-8d86-0843e68d6194",
      attachmentId: "10000000-0000-4000-8000-000000000002",
      kind: "poco_snapshot",
      status: "succeeded",
    },
  ],
  poco: {
    status: "partial",
    attempted: true,
    connectedPort: 5001,
    sdkVersion: "6",
    snapshotCapability: "qa_snapshot_available",
    negotiatedMethods: ["GetSDKVersion", "Screenshot", "qa.snapshot", "Dump"],
    succeededMethods: ["GetSDKVersion", "Screenshot", "qa.snapshot", "Dump"],
    failureReason: null,
  },
};

describe("Poco debug context", () => {
  it("finds the visible UIForm and keeps its useful child hierarchy", () => {
    const summary = summarizePocoHierarchy(hierarchy);

    expect(summary).not.toBeNull();
    expect(summary?.pageRoots).toHaveLength(1);
    expect(summary?.pageRoots[0]?.name).toBe("Hall-3_optimized(Clone)");
    expect(summary?.pageRoots[0]?.path).toBe(
      "GameFramework / UI / CameraLayer / MenuLayer / Hall-3_optimized(Clone)",
    );
    expect(summary?.pageRoots[0]?.children.map((node) => node.name)).toEqual(["btn_start"]);
    expect(summary?.pageRoots[0]?.children[0]?.clickable).toBe(true);
    expect(summary?.pageRoots[0]?.children[0]?.runtimeText).toBe("开始游戏");
    expect(summary?.pageRoots[0]?.children[0]?.visuals).toContain("Assets/UI/Hall/btn_start.png");
  });

  it("reads optional business page identity and bounded recent errors", () => {
    const summary = summarizeUnitySnapshot(snapshot);

    expect(summary?.scene).toBe("Hall");
    expect(summary?.activePages[0]?.prefab).toBe("Assets/UI/Hall/Hall-3_optimized.prefab");
    expect(summary?.activePages[0]?.rootInstanceId).toBe(-4452);
    expect(summary?.recentErrorsAvailable).toBe(true);
    expect(summary?.recentErrors[0]).toMatchObject({
      level: "exception",
      repeatCount: 2,
      message: "NullReferenceException in HallLobbyMainView",
    });
  });

  it("distinguishes a missing game log provider from an empty error window", () => {
    const summary = summarizeUnitySnapshot({
      schemaVersion: 1,
      status: "partial",
      data: { scene: "Hall" },
      warnings: ["business_provider_unavailable"],
    });

    expect(summary?.recentErrorsAvailable).toBe(false);
    expect(summary?.recentErrors).toEqual([]);
  });

  it("renders readable pages and errors instead of only raw snapshot JSON", () => {
    const markup = renderToStaticMarkup(
      <PocoContextPanel
        captures={[
          {
            captureId: bundle.captureId,
            bundle,
            hierarchy,
            snapshot,
            error: null,
          },
        ]}
      />,
    );

    expect(markup).toContain("Poco 详情（截图时游戏上下文）");
    expect(markup).toContain("当前可见页面与层级");
    expect(markup).toContain("Hall-3_optimized(Clone)");
    expect(markup).toContain("Assets/UI/Hall/Hall-3_optimized.prefab");
    expect(markup).toContain("文：开始游戏");
    expect(markup).toContain("图/纹理：Assets/UI/Hall/btn_start.png");
    expect(markup).toContain("截图前的近期错误");
    expect(markup).toContain("NullReferenceException in HallLobbyMainView");
    expect(markup).toContain("原始采集信息");
  });

  it("keeps a visible Poco region when the capture bundle cannot be read", () => {
    const markup = renderToStaticMarkup(
      <PocoContextPanel
        captures={[
          {
            captureId: bundle.captureId,
            bundle: null,
            hierarchy: null,
            snapshot: null,
            error: "HTTP 404 · NOT_FOUND",
          },
        ]}
      />,
    );

    expect(markup).toContain("Poco 详情暂不可用");
    expect(markup).toContain(bundle.captureId);
    expect(markup).toContain("HTTP 404 · NOT_FOUND");
  });
});
