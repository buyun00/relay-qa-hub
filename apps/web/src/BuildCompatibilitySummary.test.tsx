import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import BuildCompatibilitySummary, { compatibilityVerdict } from "./BuildCompatibilitySummary";
import type { CompatibilityCheck } from "./packaging-api";
const check: CompatibilityCheck = {
  target: { id: "android-debug", platform: "Android", configuration: "Debug" },
  state: "complete",
  queueId: 1,
  buildNumber: 2,
  checkedAt: "2026-09-11T02:00:00Z",
  reportUrl: null,
  errorCode: null,
  report: {
    result: "HOT_UPDATE_ALLOWED",
    targetRevision: "b".repeat(40),
    baseRevision: "a".repeat(40),
    playerVersion: "Android/Debug/2.5.1/12",
    selectedVersion: "Android/Debug/2.5.2/13",
    commitCount: 8,
    changeCount: 26,
    changeCounts: { hot_update: 26 },
  },
};
const report = check.report;
if (!report) throw new Error("Missing comparison fixture");
describe("packaging compatibility evidence", () => {
  it("distinguishes comparison progress, no baseline and failures from permission to hot-update", () => {
    expect(compatibilityVerdict({ ...check, state: "queued" })).toContain("排队");
    expect(compatibilityVerdict({ ...check, state: "error" })).not.toContain("可只打热更");
    expect(compatibilityVerdict(check, true)).not.toContain("可只打热更");
    expect(
      compatibilityVerdict({ ...check, report: { ...report, result: "NO_BASELINE" } }),
    ).toContain("先打完整包");
    expect(compatibilityVerdict({ ...check, report: { ...report, result: "UNKNOWN" } })).toContain(
      "无法判断",
    );
    expect(
      compatibilityVerdict({
        ...check,
        report: { ...report, result: "PLAYER_REBUILD_REQUIRED" },
      }),
    ).toContain("重新打完整包");
  });
  it("shows both the selected hot update and its actual Player, and separates ZIP baseline requirements", () => {
    const markup = renderToStaticMarkup(<BuildCompatibilitySummary check={check} />);
    for (const text of [
      "2.5.1",
      "#12",
      "2.5.2",
      "#13",
      "aaaaaaaa",
      "bbbbbbbb",
      "26",
      "8",
      "已确认上传的资源基线",
    ])
      expect(markup).toContain(text);
    expect(
      renderToStaticMarkup(<BuildCompatibilitySummary check={check} unavailable />),
    ).not.toContain("可只打热更");
  });
});
