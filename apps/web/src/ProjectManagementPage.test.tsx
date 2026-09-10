import { describe, expect, it } from "vitest";

import { QaHubApiError } from "./api";
import { projectManagementErrorMessage } from "./ProjectManagementPage";

describe("project component errors", () => {
  it("distinguishes an unmet single-upload dependency from a stale version", () => {
    expect(
      projectManagementErrorMessage(new QaHubApiError(409, "COMPONENT_DEPENDENCY_REQUIRED")),
    ).toContain("先启用打包和增量上传");
    expect(projectManagementErrorMessage(new QaHubApiError(409, "VERSION_CONFLICT"))).toContain(
      "记录已变化",
    );
  });
});
