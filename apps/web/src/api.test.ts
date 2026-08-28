import { afterEach, describe, expect, it, vi } from "vitest";

import { setBrowserCsrfToken, updateBugDetails, type BugDetail } from "./api";

const BUG_ID = "20000000-0000-4000-8000-000000000001";

function bug(): BugDetail {
  return {
    id: BUG_ID,
    projectId: "30000000-0000-4000-8000-000000000001",
    number: 1,
    key: "LOCAL-1",
    title: "修正后的标题",
    description: "修正后的问题描述",
    expectedBehavior: "修正后的预期行为",
    moduleId: null,
    state: "reported",
    severity: "S1",
    priority: "P0",
    reporterId: "10000000-0000-4000-8000-000000000001",
    ownerId: null,
    verificationOwnerId: "10000000-0000-4000-8000-000000000002",
    duplicateOfBugId: null,
    occurrenceCount: 1,
    reopenCount: 0,
    version: 8,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:01:00.000Z",
    closedAt: null,
  };
}

afterEach(() => {
  setBrowserCsrfToken(null);
  vi.unstubAllGlobals();
});

describe("Bug detail API", () => {
  it("sends all editable fields with version, CSRF, and an idempotency key", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(bug()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    setBrowserCsrfToken("csrf-token");

    const result = await updateBugDetails(
      BUG_ID,
      7,
      {
        title: "修正后的标题",
        description: "修正后的问题描述",
        expectedBehavior: "修正后的预期行为",
        moduleId: null,
        severity: "S1",
        priority: "P0",
      },
      "50000000-0000-4000-8000-000000000001",
    );

    expect(result.version).toBe(8);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/v1/bugs/${BUG_ID}`);
    expect(init.method).toBe("PATCH");
    expect(init.credentials).toBe("same-origin");
    const headers = new Headers(init.headers);
    expect(headers.get("X-CSRF-Token")).toBe("csrf-token");
    expect(headers.get("Idempotency-Key")).toBe(
      `web:updateBugDetails:bug:${BUG_ID}:v7:50000000-0000-4000-8000-000000000001`,
    );
    expect(JSON.parse(String(init.body))).toEqual({
      expectedVersion: 7,
      title: "修正后的标题",
      description: "修正后的问题描述",
      expectedBehavior: "修正后的预期行为",
      moduleId: null,
      severity: "S1",
      priority: "P0",
    });
  });
});
