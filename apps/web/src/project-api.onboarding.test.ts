import { beforeEach, describe, expect, it, vi } from "vitest";

const requestJson = vi.hoisted(() => vi.fn());

vi.mock("./api", () => ({ requestJson }));

import {
  completeProjectInitialization,
  inspectProjectInitialization,
  resetProjectJoinCode,
  revokeInitializationLink,
  rotateInitializationLink,
  saveProject,
} from "./project-api";

describe("project onboarding API contract", () => {
  beforeEach(() => {
    requestJson.mockReset();
    requestJson.mockResolvedValue({ id: "project-a" });
  });

  it("creates a pending project with an empty POST body", async () => {
    await saveProject();
    expect(requestJson).toHaveBeenCalledWith("/api/v1/gm/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  });

  it("uses the token-only initialization endpoints without putting the token in a query", async () => {
    await inspectProjectInitialization("token-value");
    await completeProjectInitialization({
      token: "token-value",
      name: "项目 A",
      initialMembers: ["张三"],
      logo: { mediaType: "image/png", dataBase64: "aGVsbG8=" },
    });
    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      "/api/v1/project-initialization/inspect",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "token-value" }),
      }),
      false,
    );
    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      "/api/v1/project-initialization/complete",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          token: "token-value",
          name: "项目 A",
          initialMembers: ["张三"],
          logo: { mediaType: "image/png", dataBase64: "aGVsbG8=" },
        }),
      }),
      false,
    );
    expect(requestJson.mock.calls.flat().join(" ")).not.toContain("?token=");
  });

  it("exposes GM reset, rotate and revoke actions at their dedicated endpoints", async () => {
    await resetProjectJoinCode("project-a");
    await rotateInitializationLink("project-a");
    await revokeInitializationLink("project-a");
    expect(requestJson.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/gm/projects/project-a/join-code/reset",
      "/api/v1/gm/projects/project-a/initialization-link/rotate",
      "/api/v1/gm/projects/project-a/initialization-link/revoke",
    ]);
  });
});
