import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import BuildUploadControls from "./BuildUploadControls";
import { compatibilityVerdict } from "./BuildCompatibilitySummary";
import { buildSourceBranches, type BuildBranchCatalog } from "@relay-qa-hub/upload-contract";
import type { CompatibilityCheck } from "./packaging-api";
const catalog: BuildBranchCatalog = {
  checkedAt: "",
  Debug: [
    { value: "main", label: "main | aaaaaaaaaa", resolvedBranch: "main", revision: "aaaaaaaaaa" },
  ],
  Release: [
    {
      value: "auto",
      label: "自动：release/2026-09-11",
      resolvedBranch: "release/2026-09-11",
      revision: "bbbbbbbbbb",
    },
    {
      value: "release/2026-08-30",
      label: "release/2026-08-30",
      resolvedBranch: "release/2026-08-30",
      revision: "cccccccccc",
    },
  ],
};
const check: CompatibilityCheck = {
  target: { id: "ios-release", platform: "iOS", configuration: "Release" },
  sourceBranch: "auto",
  state: "complete",
  queueId: 1,
  buildNumber: 1,
  checkedAt: "2026-09-14T00:00:00Z",
  reportUrl: null,
  errorCode: null,
  report: {
    sourceBranch: "release/2026-09-11",
    result: "HOT_UPDATE_ALLOWED",
    targetRevision: "b".repeat(40),
    baseRevision: "a".repeat(40),
    selectedVersion: null,
    playerVersion: null,
    commitCount: 1,
    changeCount: 1,
    changeCounts: {},
  },
};
describe("build branch controls", () => {
  const render = (branch = "auto") =>
    renderToStaticMarkup(
      <BuildUploadControls
        disabled={false}
        onBuildOnly={() => {}}
        onSubmitted={() => {}}
        branches={buildSourceBranches({ "ios-release": branch })}
        branchCatalog={catalog}
        onBranchChange={() => {}}
        checks={[check]}
      />,
    );
  it("shows four branch selectors and invalidates a verdict when another branch is selected", () => {
    expect(render().match(/<select\b/g)).toHaveLength(4);
    expect(render()).toContain("无需重打安装包，可只打热更");
    expect(render("release/2026-08-30")).not.toContain("无需重打安装包，可只打热更");
    expect(render("release/deleted")).toContain("原分支已不可用，请重新选择");
  });
  it("explains a branch ancestry mismatch instead of claiming the delta is safe", () => {
    if (!check.report) throw new Error("Missing test report");
    expect(
      compatibilityVerdict({
        ...check,
        report: { ...check.report, result: "UNKNOWN", reasonCode: "BASE_NOT_ANCESTOR" },
      }),
    ).toBe("参考安装包与当前分支不兼容，请打完整包");
  });
});
