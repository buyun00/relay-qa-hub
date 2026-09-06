import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getBrowserSession,
  loginBrowserSession,
  logoutBrowserSession,
  setBrowserCsrfToken,
  updateBugDetails,
  recordVerificationFailed,
  type BrowserSessionPrincipal,
  type BugDetail,
} from "./api";

const BUG_ID = "20000000-0000-4000-8000-000000000001";

function principal(): BrowserSessionPrincipal {
  return {
    accountId: "10000000-0000-4000-8000-000000000001",
    userId: "10000000-0000-4000-8000-000000000003",
    email: "developer@example.test",
    displayName: "开发者",
    csrfToken: "csrf-token",
  };
}

function installMemoryStorage(): Map<string, string> {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  return values;
}

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

it("submits rejection screenshots with the same Verification result identity", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ replayed: false }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const attachmentIds = ["40000000-0000-4000-8000-000000000001"];
  await recordVerificationFailed(BUG_ID, 2, "位置不对", "见截图", "submission-1", attachmentIds);
  const request = fetch.mock.calls[0]?.[1] as RequestInit;
  expect(JSON.parse(String(request.body))).toMatchObject({
    status: "failed",
    failureReason: "见截图",
    clientSubmissionId: "submission-1",
    attachmentIds,
  });
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

describe("permanent browser identity", () => {
  it("silently recreates an invalid session from the remembered Chinese display name", async () => {
    installMemoryStorage();
    const current = principal();
    const responses = [
      new Response(JSON.stringify(current), { status: 200 }),
      new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), { status: 401 }),
      new Response(JSON.stringify(current), { status: 200 }),
      new Response(JSON.stringify(current), { status: 200 }),
    ];
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => {
      void _path;
      void _init;
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected fetch");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await loginBrowserSession("kaifazhe");
    expect(await getBrowserSession()).toEqual(current);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/auth/login",
      "/api/v1/auth/me",
      "/api/v1/auth/login",
      "/api/v1/auth/me",
    ]);
    const recoveryBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
      name: string;
    };
    expect(recoveryBody.name).toBe("开发者");
  });

  it("forgets the permanent identity only after an explicit logout", async () => {
    const storage = installMemoryStorage();
    const responses = [
      new Response(JSON.stringify(principal()), { status: 200 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected fetch");
        return response;
      }),
    );

    await loginBrowserSession("开发者");
    expect([...storage.values()]).toEqual(["开发者"]);
    await logoutBrowserSession();
    expect(storage.size).toBe(0);
  });
});
