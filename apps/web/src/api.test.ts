import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APP_FIRST_API_MEDIA_TYPE,
  createVerification,
  failRepairAttempt,
  freezeVerificationResultRequest,
  getBrowserSession,
  getVerification,
  listAllBugs,
  listBugComments,
  listBugEvents,
  listBugs,
  listBugRepairAttempts,
  listProjectMembers,
  listVisibleProjects,
  loginBrowserSession,
  logoutBrowserSession,
  recordFrozenVerificationResult,
  recordVerificationBlocked,
  recordVerificationPassed,
  refreshVerificationAttachmentBinding,
  setBrowserCsrfToken,
  sha256Hex,
  startVerification,
  supersedeRepairAttempt,
  updateBugDetails,
  recordVerificationFailed,
  uploadVerificationAttachment,
  verificationAttachmentBindingHasRunway,
  verificationResultReadbackMatches,
  verificationResultReceiptMatches,
  type AttachmentBindingResponse,
  type BrowserSessionPrincipal,
  type BugDetail,
  type FrozenVerificationResultRequest,
  type UploadCheckpoint,
  type VerificationRecord,
  type VerificationResultResponse,
} from "./api";

const BUG_ID = "20000000-0000-4000-8000-000000000001";
const PROJECT_ID = "30000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "40000000-0000-4000-8000-000000000001";
const SUCCESSOR_ID = "40000000-0000-4000-8000-000000000002";
const ATTACHMENT_ID = "50000000-0000-4000-8000-000000000001";
const CAPTURE_ID = "60000000-0000-4000-8000-000000000001";
const SUBMISSION_ID = "70000000-0000-4000-8000-000000000001";
const VERIFICATION_ID = "90000000-0000-4000-8000-000000000004";
const BINDING_ID = "80000000-0000-4000-8000-000000000002";
const VERIFIER_ID = "10000000-0000-4000-8000-000000000002";

function verificationExpectation(frozen: FrozenVerificationResultRequest) {
  return {
    verificationId: frozen.verificationId,
    projectId: PROJECT_ID,
    bugId: BUG_ID,
    repairAttemptId: ATTEMPT_ID,
    verifierId: VERIFIER_ID,
  };
}

function verificationReadbackExpectation(frozen: FrozenVerificationResultRequest) {
  const expected = verificationExpectation(frozen);
  return {
    verificationId: expected.verificationId,
    bugId: expected.bugId,
    repairAttemptId: expected.repairAttemptId,
    verifierId: expected.verifierId,
  };
}

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

function bindingResponse(
  clientAttachmentId: string,
  patch: Partial<AttachmentBindingResponse> = {},
): AttachmentBindingResponse {
  return {
    bindingId: BINDING_ID,
    attachmentId: ATTACHMENT_ID,
    projectId: PROJECT_ID,
    clientSubmissionId: SUBMISSION_ID,
    clientAttachmentId,
    leaseGeneration: 1,
    intent: "verification_result",
    targetQaItemId: BUG_ID,
    status: "reserved",
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    version: 4,
    replayed: false,
    ...patch,
  };
}

function bindingResponseFromRequest(init: RequestInit | undefined): AttachmentBindingResponse {
  const body = JSON.parse(String(init?.body)) as { readonly clientAttachmentId: string };
  return bindingResponse(body.clientAttachmentId);
}

function verificationResultResponse(
  frozen: FrozenVerificationResultRequest,
  replayed: boolean,
): VerificationResultResponse {
  return {
    clientSubmissionId: frozen.clientSubmissionId,
    qaItem: { type: "bug", id: BUG_ID, key: "LOCAL-1" },
    verification: {
      id: frozen.verificationId,
      bugId: BUG_ID,
      repairAttemptId: ATTEMPT_ID,
      buildId: null,
      status: frozen.status,
      verifierId: VERIFIER_ID,
      criteriaSnapshot: "修正后的预期行为",
      resultSummary: frozen.resultSummary,
      version: frozen.expectedVersion + 1,
    },
    repairAttempt: {
      id: ATTEMPT_ID,
      bugId: BUG_ID,
      sequence: 1,
      mode: "human",
      status: frozen.status === "failed" ? "verification_failed" : "delivered",
      assigneeId: principal().userId,
      parentAttemptId: null,
      summary: "Repair",
      branch: null,
      commitSha: null,
      mergeRequestUrl: null,
      targetBuildId: null,
      version: 4,
    },
    bug: {
      ...bug(),
      state:
        frozen.status === "passed"
          ? "closed"
          : frozen.status === "failed"
            ? "ready"
            : "ready_for_verification",
      version: bug().version + 1,
    },
    attachmentIds: [...frozen.attachmentIds],
    captureBundleId: frozen.captureBundleId,
    eventId: "80000000-0000-4000-8000-000000000003",
    replayed,
  };
}

function verificationRecord(patch: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    id: VERIFICATION_ID,
    bugId: BUG_ID,
    repairAttemptId: ATTEMPT_ID,
    buildId: null,
    status: "requested",
    verifierId: VERIFIER_ID,
    criteriaSnapshot: "修正后的预期行为",
    resultSummary: null,
    failureReason: null,
    blockedReason: null,
    version: 1,
    ...patch,
  };
}

afterEach(() => {
  setBrowserCsrfToken(null);
  vi.unstubAllGlobals();
});

describe("Verification response ownership", () => {
  it.each([
    ["Bug", { bugId: "20000000-0000-4000-8000-000000000099" }],
    ["repair attempt", { repairAttemptId: "40000000-0000-4000-8000-000000000099" }],
    ["actor", { verifierId: "10000000-0000-4000-8000-000000000099" }],
  ] as const)("rejects a created Verification for the wrong %s", async (_label, patch) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(verificationRecord(patch))),
    );

    await expect(
      createVerification({
        bugId: BUG_ID,
        expectedBugVersion: 8,
        repairAttemptId: ATTEMPT_ID,
        buildId: null,
        verifierId: VERIFIER_ID,
        criteria: "修正后的预期行为",
      }),
    ).rejects.toMatchObject({ code: "VERIFICATION_CREATE_RESPONSE_MISMATCH" });
  });

  it.each([
    ["Bug", { bugId: "20000000-0000-4000-8000-000000000099" }],
    ["repair attempt", { repairAttemptId: "40000000-0000-4000-8000-000000000099" }],
    ["actor", { verifierId: "10000000-0000-4000-8000-000000000099" }],
  ] as const)("rejects a started Verification for the wrong %s", async (_label, patch) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(verificationRecord({ status: "in_progress", version: 2, ...patch })),
      ),
    );

    await expect(
      startVerification(VERIFICATION_ID, 1, {
        bugId: BUG_ID,
        repairAttemptId: ATTEMPT_ID,
        verifierId: VERIFIER_ID,
      }),
    ).rejects.toMatchObject({ code: "VERIFICATION_START_RESPONSE_MISMATCH" });
  });

  it.each([
    ["Verification", { id: "90000000-0000-4000-8000-000000000099" }],
    ["Bug", { bugId: "20000000-0000-4000-8000-000000000099" }],
    ["repair attempt", { repairAttemptId: "40000000-0000-4000-8000-000000000099" }],
    ["actor", { verifierId: "10000000-0000-4000-8000-000000000099" }],
  ] as const)("rejects a Verification readback for the wrong %s", async (_label, patch) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(verificationRecord(patch))),
    );

    await expect(
      getVerification(VERIFICATION_ID, {
        bugId: BUG_ID,
        repairAttemptId: ATTEMPT_ID,
        verifierId: VERIFIER_ID,
      }),
    ).rejects.toMatchObject({ code: "VERIFICATION_READBACK_SCOPE_MISMATCH" });
  });
});

it("reads every page of one canonical Verification-owner assignment stream", async () => {
  const verificationOwnerId = principal().userId;
  const second = { ...bug(), id: "20000000-0000-4000-8000-000000000002", key: "LOCAL-2" };
  const responses = [
    { snapshotSequence: 2, items: [bug()], nextCursor: "cursor-page-2" },
    { snapshotSequence: 2, items: [second], nextCursor: null },
  ];
  const fetchMock = vi.fn(async (path: string) => {
    void path;
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    listAllBugs(PROJECT_ID, { verificationOwnerId }, undefined, 1),
  ).resolves.toMatchObject({ items: [{ id: BUG_ID }, { id: second.id }], nextCursor: null });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  const urls = fetchMock.mock.calls.map(([path]) => new URL(String(path), "http://qa-hub.local"));
  expect(urls.every((url) => url.pathname === "/api/v1/bugs")).toBe(true);
  expect(urls.every((url) => url.searchParams.get("projectId") === PROJECT_ID)).toBe(true);
  expect(
    urls.every((url) => url.searchParams.get("verificationOwnerId") === verificationOwnerId),
  ).toBe(true);
  expect(urls.every((url) => url.searchParams.get("limit") === "1")).toBe(true);
  expect(urls[0]?.searchParams.has("cursor")).toBe(false);
  expect(urls[1]?.searchParams.get("cursor")).toBe("cursor-page-2");
  expect(urls.every((url) => !url.searchParams.has("ownerId"))).toBe(true);
});

it("restarts one invalidated Bug-list snapshot from page one and discards its partial items", async () => {
  const verificationOwnerId = principal().userId;
  const staleItem = bug();
  const freshFirst = {
    ...bug(),
    id: "20000000-0000-4000-8000-000000000002",
    key: "LOCAL-2",
  };
  const freshSecond = {
    ...bug(),
    id: "20000000-0000-4000-8000-000000000003",
    key: "LOCAL-3",
  };
  const responses = [
    Response.json({ snapshotSequence: 2, items: [staleItem], nextCursor: "stale-cursor" }),
    Response.json({ code: "INVALID_REQUEST" }, { status: 400 }),
    Response.json({ snapshotSequence: 3, items: [freshFirst], nextCursor: "fresh-cursor" }),
    Response.json({ snapshotSequence: 3, items: [freshSecond], nextCursor: null }),
  ];
  const fetchMock = vi.fn(async (path: string) => {
    void path;
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected Bug-list request");
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(listAllBugs(PROJECT_ID, { verificationOwnerId }, undefined, 1)).resolves.toEqual({
    snapshotSequence: 3,
    items: [freshFirst, freshSecond],
    nextCursor: null,
  });

  expect(fetchMock).toHaveBeenCalledTimes(4);
  const urls = fetchMock.mock.calls.map(([path]) => new URL(String(path), "http://qa-hub.local"));
  expect(urls.map((url) => url.searchParams.get("cursor"))).toEqual([
    null,
    "stale-cursor",
    null,
    "fresh-cursor",
  ]);
  expect(
    urls.every((url) => url.searchParams.get("verificationOwnerId") === verificationOwnerId),
  ).toBe(true);
});

it("fails closed when a restarted Bug-list snapshot is invalidated again", async () => {
  const responses = [
    Response.json({ snapshotSequence: 2, items: [bug()], nextCursor: "stale-cursor-1" }),
    Response.json({ code: "INVALID_REQUEST" }, { status: 400 }),
    Response.json({ snapshotSequence: 3, items: [bug()], nextCursor: "stale-cursor-2" }),
    Response.json({ code: "INVALID_REQUEST" }, { status: 400 }),
  ];
  const fetchMock = vi.fn(async (path: string) => {
    void path;
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected Bug-list request");
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(listAllBugs(PROJECT_ID, {}, undefined, 1)).rejects.toMatchObject({
    status: 400,
    code: "INVALID_REQUEST",
  });

  expect(fetchMock).toHaveBeenCalledTimes(4);
  const urls = fetchMock.mock.calls.map(([path]) => new URL(String(path), "http://qa-hub.local"));
  expect(urls.map((url) => url.searchParams.get("cursor"))).toEqual([
    null,
    "stale-cursor-1",
    null,
    "stale-cursor-2",
  ]);
});

it("rejects a repeated Bug-list cursor immediately without restarting", async () => {
  const second = { ...bug(), id: "20000000-0000-4000-8000-000000000004", key: "LOCAL-4" };
  const responses = [
    Response.json({ snapshotSequence: 2, items: [bug()], nextCursor: "repeated-cursor" }),
    Response.json({ snapshotSequence: 2, items: [second], nextCursor: "repeated-cursor" }),
  ];
  const fetchMock = vi.fn(async (path: string) => {
    void path;
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected Bug-list request");
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(listAllBugs(PROJECT_ID, {}, undefined, 1)).rejects.toMatchObject({
    status: 200,
    code: "INVALID_BUG_LIST_CURSOR",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("fails closed on cross-page Bug-list snapshot drift without restarting", async () => {
  const responses = [
    Response.json({ snapshotSequence: 2, items: [bug()], nextCursor: "drift-cursor" }),
    Response.json({ snapshotSequence: 3, items: [bug()], nextCursor: null }),
  ];
  const fetchMock = vi.fn(async (path: string) => {
    void path;
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected Bug-list request");
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(listAllBugs(PROJECT_ID, {}, undefined, 1)).rejects.toMatchObject({
    status: 200,
    code: "INVALID_BUG_LIST_SNAPSHOT",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("rejects a duplicate Bug ID across pages without restarting", async () => {
  const responses = [
    Response.json({ snapshotSequence: 2, items: [bug()], nextCursor: "duplicate-cursor" }),
    Response.json({ snapshotSequence: 2, items: [bug()], nextCursor: null }),
  ];
  const fetchMock = vi.fn(async (path: string) => {
    void path;
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected Bug-list request");
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(listAllBugs(PROJECT_ID, {}, undefined, 1)).rejects.toMatchObject({
    status: 200,
    code: "INVALID_RESPONSE",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("rejects invalid Bug-list snapshot and cursor metadata at the response boundary", async () => {
  const invalidResponses = [
    { snapshotSequence: -1, items: [], nextCursor: null },
    { snapshotSequence: 1, items: [], nextCursor: "" },
    { snapshotSequence: 1, items: [], nextCursor: "x".repeat(501) },
  ];

  for (const invalidResponse of invalidResponses) {
    const fetchMock = vi.fn(async () => Response.json(invalidResponse));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listAllBugs(PROJECT_ID, {}, undefined, 1)).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  }
});

it("validates every frozen nativeBug field and rejects wrong-project or oversized pages", async () => {
  const missingProjectId: Record<string, unknown> = { ...bug() };
  delete missingProjectId.projectId;
  const invalidItems: readonly unknown[] = [
    missingProjectId,
    { ...bug(), projectId: "30000000-0000-4000-8000-000000000002" },
    { ...bug(), unexpected: true },
    { ...bug(), id: "not-a-uuid" },
    { ...bug(), number: 0 },
    { ...bug(), key: "invalid-1" },
    { ...bug(), moduleId: "not-a-uuid" },
    { ...bug(), occurrenceCount: 0 },
    { ...bug(), reopenCount: -1 },
    { ...bug(), createdAt: "2026-09-09" },
  ];
  for (const item of invalidItems) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ snapshotSequence: 1, items: [item], nextCursor: null })),
    );
    await expect(listBugs(PROJECT_ID)).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE",
    });
  }

  const oversized = Array.from({ length: 101 }, (_, index) => ({
    ...bug(),
    id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    number: index + 1,
    key: `LOCAL-${index + 1}`,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ snapshotSequence: 1, items: oversized, nextCursor: null })),
  );
  await expect(listBugs(PROJECT_ID, {}, undefined, 500)).rejects.toMatchObject({
    status: 200,
    code: "INVALID_RESPONSE",
  });
});

it("reads complete project and member directories with one frozen snapshot", async () => {
  const secondProjectId = "30000000-0000-4000-8000-000000000002";
  const firstMemberId = "10000000-0000-4000-8000-000000000011";
  const secondMemberId = "10000000-0000-4000-8000-000000000012";
  const responses = [
    Response.json({
      snapshotSequence: 9,
      items: [{ id: PROJECT_ID, key: "LOCAL", name: "Local", active: true, roles: ["developer"] }],
      nextCursor: "projects-page-2",
    }),
    Response.json({
      snapshotSequence: 9,
      items: [
        { id: secondProjectId, key: "OTHER", name: "Other", active: true, roles: ["viewer"] },
      ],
      nextCursor: null,
    }),
    Response.json({
      projectId: PROJECT_ID,
      snapshotSequence: 11,
      items: [
        {
          userId: firstMemberId,
          projectId: PROJECT_ID,
          displayName: "First",
          roles: ["developer"],
          active: true,
        },
      ],
      nextCursor: "members-page-2",
    }),
    Response.json({
      projectId: PROJECT_ID,
      snapshotSequence: 11,
      items: [
        {
          userId: secondMemberId,
          projectId: PROJECT_ID,
          displayName: "Second",
          roles: ["verifier"],
          active: true,
        },
      ],
      nextCursor: null,
    }),
  ];
  const fetchMock = vi.fn(async (_path: string) => {
    void _path;
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected directory request");
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(listVisibleProjects()).resolves.toMatchObject({
    snapshotSequence: 9,
    items: [{ id: PROJECT_ID }, { id: secondProjectId }],
    nextCursor: null,
  });
  await expect(listProjectMembers(PROJECT_ID)).resolves.toMatchObject({
    projectId: PROJECT_ID,
    snapshotSequence: 11,
    items: [{ userId: firstMemberId }, { userId: secondMemberId }],
    nextCursor: null,
  });
  const urls = fetchMock.mock.calls.map(([path]) => new URL(String(path), "http://qa-hub.local"));
  expect(urls.map((url) => url.searchParams.get("cursor"))).toEqual([
    null,
    "projects-page-2",
    null,
    "members-page-2",
  ]);
  expect(urls.every((url) => url.searchParams.get("limit") === "100")).toBe(true);
});

it("fails closed on directory snapshot drift, duplicate IDs, and cross-project members", async () => {
  const memberId = "10000000-0000-4000-8000-000000000011";
  const cases: readonly (readonly Response[])[] = [
    [
      Response.json({
        snapshotSequence: 1,
        items: [{ id: PROJECT_ID, key: "LOCAL", name: "Local", active: true, roles: ["viewer"] }],
        nextCursor: "next",
      }),
      Response.json({ snapshotSequence: 2, items: [], nextCursor: null }),
    ],
    [
      Response.json({
        projectId: PROJECT_ID,
        snapshotSequence: 1,
        items: [
          {
            userId: memberId,
            projectId: PROJECT_ID,
            displayName: "Member",
            roles: ["viewer"],
            active: true,
          },
        ],
        nextCursor: "next",
      }),
      Response.json({
        projectId: PROJECT_ID,
        snapshotSequence: 1,
        items: [
          {
            userId: memberId,
            projectId: PROJECT_ID,
            displayName: "Member",
            roles: ["viewer"],
            active: true,
          },
        ],
        nextCursor: null,
      }),
    ],
    [
      Response.json({
        projectId: PROJECT_ID,
        snapshotSequence: 1,
        items: [
          {
            userId: memberId,
            projectId: "30000000-0000-4000-8000-000000000002",
            displayName: "Member",
            roles: ["viewer"],
            active: true,
          },
        ],
        nextCursor: null,
      }),
    ],
  ];

  for (const [index, responseSet] of cases.entries()) {
    const responses = [...responseSet];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected fetch");
        return response;
      }),
    );
    const operation = index === 0 ? listVisibleProjects() : listProjectMembers(PROJECT_ID);
    await expect(operation).rejects.toBeInstanceOf(Error);
  }
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

it("uses the versioned media type and canonical keys for terminal repair actions", async () => {
  const failedAttempt = {
    id: ATTEMPT_ID,
    bugId: BUG_ID,
    sequence: 1,
    mode: "human",
    status: "failed",
    assigneeId: principal().userId,
    parentAttemptId: null,
    summary: "Cannot continue",
    branch: null,
    commitSha: null,
    mergeRequestUrl: null,
    targetBuildId: null,
    version: 2,
  };
  const successorAttempt = {
    ...failedAttempt,
    id: SUCCESSOR_ID,
    sequence: 2,
    mode: "external",
    status: "planned",
    parentAttemptId: ATTEMPT_ID,
    summary: "External specialist",
    version: 1,
  };
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(failedAttempt), { status: 200 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          supersededAttempt: { ...failedAttempt, status: "superseded" },
          successorAttempt,
          bug: bug(),
          eventId: "80000000-0000-4000-8000-000000000001",
          replayed: false,
        }),
        { status: 200 },
      ),
    );
  vi.stubGlobal("fetch", fetchMock);
  setBrowserCsrfToken("csrf-token");

  await failRepairAttempt(ATTEMPT_ID, 4, "This path cannot continue");
  await supersedeRepairAttempt({
    attemptId: ATTEMPT_ID,
    expectedVersion: 5,
    reason: "A specialist should take over",
    successor: {
      id: SUCCESSOR_ID,
      mode: "external",
      assigneeId: principal().userId,
      summary: "External specialist",
    },
  });

  const [failPath, failInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(failPath).toBe(`/api/v1/repair-attempts/${ATTEMPT_ID}/fail`);
  const failHeaders = new Headers(failInit.headers);
  expect(failHeaders.get("Content-Type")).toBe(APP_FIRST_API_MEDIA_TYPE);
  expect(failHeaders.get("Accept")).toBe(APP_FIRST_API_MEDIA_TYPE);
  expect(failHeaders.get("Idempotency-Key")).toBe(
    `workflow:failRepairAttempt:attempt:${ATTEMPT_ID}:v4`,
  );
  expect(JSON.parse(String(failInit.body))).toEqual({
    expectedVersion: 4,
    reason: "This path cannot continue",
  });

  const [supersedePath, supersedeInit] = fetchMock.mock.calls[1] as unknown as [
    string,
    RequestInit,
  ];
  expect(supersedePath).toBe(`/api/v1/repair-attempts/${ATTEMPT_ID}/supersede`);
  const supersedeHeaders = new Headers(supersedeInit.headers);
  expect(supersedeHeaders.get("Content-Type")).toBe(APP_FIRST_API_MEDIA_TYPE);
  expect(supersedeHeaders.get("Accept")).toBe(APP_FIRST_API_MEDIA_TYPE);
  expect(supersedeHeaders.get("Idempotency-Key")).toBe(
    `workflow:supersedeRepairAttempt:attempt:${ATTEMPT_ID}:v5`,
  );
  expect(JSON.parse(String(supersedeInit.body))).toEqual({
    expectedVersion: 5,
    reason: "A specialist should take over",
    successor: {
      id: SUCCESSOR_ID,
      mode: "external",
      assigneeId: principal().userId,
      summary: "External specialist",
    },
  });
});

it("loads every repair round from the full workflow projection", async () => {
  const parentAttempt = {
    id: ATTEMPT_ID,
    bugId: BUG_ID,
    sequence: 1,
    mode: "human",
    status: "superseded",
    assigneeId: principal().userId,
    parentAttemptId: null,
    summary: "Original repair round",
    branch: null,
    commitSha: null,
    mergeRequestUrl: null,
    targetBuildId: null,
    version: 3,
  };
  const successorAttempt = {
    ...parentAttempt,
    id: SUCCESSOR_ID,
    sequence: 2,
    mode: "external",
    status: "blocked",
    parentAttemptId: ATTEMPT_ID,
    summary: "Waiting for the vendor",
    version: 2,
  };
  const cursor = "opaque cursor+/=";
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ bugId: BUG_ID, repairAttempts: [parentAttempt], nextCursor: cursor }),
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ bugId: BUG_ID, repairAttempts: [successorAttempt], nextCursor: null }),
        { status: 200 },
      ),
    );
  vi.stubGlobal("fetch", fetchMock);

  await expect(listBugRepairAttempts(BUG_ID)).resolves.toEqual([parentAttempt, successorAttempt]);
  const [firstPath] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  const [secondPath] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
  expect(firstPath).toBe(`/api/v1/bugs/${BUG_ID}/workflow?limitPerCollection=100`);
  const secondUrl = new URL(secondPath, "http://qa-hub.test");
  expect(secondUrl.pathname).toBe(`/api/v1/bugs/${BUG_ID}/workflow`);
  expect(secondUrl.searchParams.get("limitPerCollection")).toBe("100");
  expect(secondUrl.searchParams.get("cursor")).toBe(cursor);
});

it("carries evidence for passed, failed, and blocked Verification results", async () => {
  const fetchMock = vi.fn(async () =>
    Promise.resolve(new Response(JSON.stringify({ replayed: false }), { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  const verificationIds = [
    "90000000-0000-4000-8000-000000000001",
    "90000000-0000-4000-8000-000000000002",
    "90000000-0000-4000-8000-000000000003",
  ] as const;

  await recordVerificationPassed(
    verificationIds[0],
    2,
    "Passed with evidence",
    SUBMISSION_ID,
    [ATTACHMENT_ID],
    CAPTURE_ID,
  );
  await recordVerificationFailed(
    verificationIds[1],
    3,
    "Still reproducible",
    "The defect remains",
    SUBMISSION_ID,
    [ATTACHMENT_ID],
    CAPTURE_ID,
  );
  await recordVerificationBlocked(
    verificationIds[2],
    4,
    "Device unavailable",
    "The required device is offline",
    SUBMISSION_ID,
    [ATTACHMENT_ID],
    CAPTURE_ID,
  );

  const bodies = (fetchMock.mock.calls as unknown as readonly [string, RequestInit][]).map(
    ([, init]) => JSON.parse(String(init.body)),
  );
  expect(bodies).toEqual([
    {
      submissionContractVersion: "1.1.0",
      clientSubmissionId: SUBMISSION_ID,
      expectedVersion: 2,
      status: "passed",
      resultSummary: "Passed with evidence",
      attachmentIds: [ATTACHMENT_ID],
      captureBundleId: CAPTURE_ID,
    },
    {
      submissionContractVersion: "1.1.0",
      clientSubmissionId: SUBMISSION_ID,
      expectedVersion: 3,
      status: "failed",
      resultSummary: "Still reproducible",
      failureReason: "The defect remains",
      attachmentIds: [ATTACHMENT_ID],
      captureBundleId: CAPTURE_ID,
    },
    {
      submissionContractVersion: "1.1.0",
      clientSubmissionId: SUBMISSION_ID,
      expectedVersion: 4,
      status: "blocked",
      resultSummary: "Device unavailable",
      blockedReason: "The required device is offline",
      attachmentIds: [ATTACHMENT_ID],
      captureBundleId: CAPTURE_ID,
    },
  ]);
  for (const [index, [path, init]] of (
    fetchMock.mock.calls as unknown as readonly [string, RequestInit][]
  ).entries()) {
    expect(path).toBe(`/api/v1/verifications/${verificationIds[index]}/result`);
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe(APP_FIRST_API_MEDIA_TYPE);
    expect(headers.get("Accept")).toBe(APP_FIRST_API_MEDIA_TYPE);
    expect(headers.get("Idempotency-Key")).toBe(
      `workflow:recordVerificationResult:verification:${verificationIds[index]}:v${index + 2}`,
    );
  }
});

it("keeps one submission identity from a selected file through the Verification result", async () => {
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/v1/uploads/init")
      return new Response(JSON.stringify({ sessionId: "upload-1", chunkSize: 1024, version: 1 }), {
        status: 200,
      });
    if (path.includes("/chunks/0"))
      return new Response(null, { status: 204, headers: { "X-Upload-Version": "2" } });
    if (path.endsWith("/finalize"))
      return new Response(
        JSON.stringify({ attachmentId: ATTACHMENT_ID, readyToBind: true, version: 3 }),
        { status: 200 },
      );
    if (path.endsWith("/bind"))
      return new Response(JSON.stringify(bindingResponseFromRequest(init)), { status: 200 });
    return new Response(JSON.stringify({ replayed: false }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const file = new File([new Uint8Array([1, 2, 3])], "proof.png", { type: "image/png" });

  const attachmentId = await uploadVerificationAttachment({
    projectId: PROJECT_ID,
    bugId: BUG_ID,
    clientSubmissionId: SUBMISSION_ID,
    file,
  });
  await recordVerificationPassed(
    "90000000-0000-4000-8000-000000000004",
    2,
    "Verified from the selected proof",
    SUBMISSION_ID,
    [attachmentId],
  );

  expect(attachmentId).toBe(ATTACHMENT_ID);
  const jsonBodies = fetchMock.mock.calls.flatMap(([, init]) => {
    const body = (init as RequestInit | undefined)?.body;
    if (typeof body !== "string") return [];
    return [JSON.parse(body) as Record<string, unknown>];
  });
  expect(jsonBodies).toHaveLength(4);
  expect(jsonBodies.every((body) => body.clientSubmissionId === SUBMISSION_ID)).toBe(true);
  const chunkHeaders = new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers);
  expect(chunkHeaders.get("X-Client-Submission-Id")).toBe(SUBMISSION_ID);
  expect(jsonBodies.at(-1)?.attachmentIds).toEqual([ATTACHMENT_ID]);
});

it("resumes a Verification evidence bind with the same attachment and submission identities", async () => {
  let checkpoint: Parameters<typeof uploadVerificationAttachment>[0]["checkpoint"];
  let bindAttempts = 0;
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/v1/uploads/init")
      return new Response(
        JSON.stringify({ sessionId: "upload-resume", chunkSize: 1024, version: 1 }),
        {
          status: 200,
        },
      );
    if (path.includes("/chunks/0"))
      return new Response(null, { status: 204, headers: { "X-Upload-Version": "2" } });
    if (path.endsWith("/finalize"))
      return new Response(
        JSON.stringify({ attachmentId: ATTACHMENT_ID, readyToBind: true, version: 3 }),
        { status: 200 },
      );
    bindAttempts += 1;
    if (bindAttempts === 1) throw new TypeError("connection closed after finalize");
    return new Response(JSON.stringify(bindingResponseFromRequest(init)), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const file = new File([new Uint8Array([1, 2, 3])], "resume.png", { type: "image/png" });
  const upload = () =>
    uploadVerificationAttachment({
      projectId: PROJECT_ID,
      bugId: BUG_ID,
      clientSubmissionId: SUBMISSION_ID,
      file,
      ...(checkpoint === undefined ? {} : { checkpoint }),
      saveCheckpoint: async (next) => {
        checkpoint = next;
      },
    });

  await expect(upload()).rejects.toThrow("connection closed after finalize");
  expect(checkpoint?.finalized?.attachmentId).toBe(ATTACHMENT_ID);
  await expect(upload()).resolves.toBe(ATTACHMENT_ID);

  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
    "/api/v1/uploads/init",
    "/api/v1/uploads/upload-resume/chunks/0",
    "/api/v1/uploads/upload-resume/finalize",
    `/api/v1/attachments/${ATTACHMENT_ID}/bind`,
    `/api/v1/attachments/${ATTACHMENT_ID}/bind`,
  ]);
  const bindBodies = (fetchMock.mock.calls as unknown as readonly [string, RequestInit][])
    .slice(-2)
    .map(([, init]) => JSON.parse(String(init.body)));
  expect(bindBodies[0]).toEqual(bindBodies[1]);
  expect(bindBodies[1]?.clientSubmissionId).toBe(SUBMISSION_ID);
});

it("restarts with a new attachment identity when same-metadata file bytes changed", async () => {
  const oldAttachmentId = "50000000-0000-4000-8000-000000000099";
  const oldFile = new File([new Uint8Array([1, 2, 3])], "same.png", {
    type: "image/png",
    lastModified: 123,
  });
  const newFile = new File([new Uint8Array([4, 5, 6])], "same.png", {
    type: "image/png",
    lastModified: 123,
  });
  const saved: UploadCheckpoint[] = [];
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/v1/uploads/init")
      return new Response(
        JSON.stringify({ sessionId: "upload-new-bytes", chunkSize: 1024, version: 1 }),
        { status: 200 },
      );
    if (path.includes("/chunks/0"))
      return new Response(null, { status: 204, headers: { "X-Upload-Version": "2" } });
    if (path.endsWith("/finalize"))
      return new Response(
        JSON.stringify({ attachmentId: ATTACHMENT_ID, readyToBind: true, version: 3 }),
        { status: 200 },
      );
    return new Response(JSON.stringify(bindingResponseFromRequest(init)), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    uploadVerificationAttachment({
      projectId: PROJECT_ID,
      bugId: BUG_ID,
      clientSubmissionId: SUBMISSION_ID,
      file: newFile,
      checkpoint: {
        clientAttachmentId: "50000000-0000-4000-8000-000000000098",
        sha256: await sha256Hex(oldFile),
        init: { sessionId: "upload-old-bytes", chunkSize: 1024, version: 1 },
        nextChunk: 1,
        version: 2,
        finalized: { attachmentId: oldAttachmentId, readyToBind: true, version: 3 },
        bound: true,
      },
      saveCheckpoint: async (checkpoint) => {
        saved.push(checkpoint);
      },
    }),
  ).resolves.toBe(ATTACHMENT_ID);

  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
    "/api/v1/uploads/init",
    "/api/v1/uploads/upload-new-bytes/chunks/0",
    "/api/v1/uploads/upload-new-bytes/finalize",
    `/api/v1/attachments/${ATTACHMENT_ID}/bind`,
  ]);
  const initBody = JSON.parse(
    String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
  ) as Record<string, unknown>;
  expect(initBody.sha256).toBe(await sha256Hex(newFile));
  expect(initBody.clientAttachmentId).not.toBe("50000000-0000-4000-8000-000000000098");
  expect(saved[0]?.clientAttachmentId).toBe(initBody.clientAttachmentId);
  expect(saved.at(-1)).toMatchObject({
    sha256: initBody.sha256,
    finalized: { attachmentId: ATTACHMENT_ID },
    bound: true,
  });
});

it("awaits the durable attachment identity checkpoint before the first network request", async () => {
  let releaseFirstCheckpoint!: () => void;
  const firstCheckpointGate = new Promise<void>((resolve) => {
    releaseFirstCheckpoint = resolve;
  });
  const saved: UploadCheckpoint[] = [];
  const fetchMock = vi.fn(async (path: string) => {
    if (path === "/api/v1/uploads/init")
      return new Response(
        JSON.stringify({ sessionId: "upload-durable-first", chunkSize: 1024, version: 1 }),
        { status: 200 },
      );
    if (path.includes("/chunks/0"))
      return new Response(null, { status: 204, headers: { "X-Upload-Version": "2" } });
    if (path.endsWith("/finalize"))
      return new Response(
        JSON.stringify({ attachmentId: ATTACHMENT_ID, readyToBind: true, version: 3 }),
        { status: 200 },
      );
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const file = new File([new Uint8Array([1, 2, 3])], "durable.png", {
    type: "image/png",
  });

  const upload = uploadVerificationAttachment({
    projectId: PROJECT_ID,
    bugId: BUG_ID,
    clientSubmissionId: SUBMISSION_ID,
    file,
    deferBinding: true,
    saveCheckpoint: async (checkpoint) => {
      saved.push(checkpoint);
      if (saved.length === 1) await firstCheckpointGate;
    },
  });

  await vi.waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toMatchObject({
    sha256: await sha256Hex(file),
    nextChunk: 0,
  });
  expect(fetchMock).not.toHaveBeenCalled();

  releaseFirstCheckpoint();
  await expect(upload).resolves.toBe(ATTACHMENT_ID);
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/uploads/init");
});

it("does not start a Verification upload when its first durable checkpoint write fails", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const file = new File([new Uint8Array([1, 2, 3])], "durable-failure.png", {
    type: "image/png",
  });

  await expect(
    uploadVerificationAttachment({
      projectId: PROJECT_ID,
      bugId: BUG_ID,
      clientSubmissionId: SUBMISSION_ID,
      file,
      deferBinding: true,
      saveCheckpoint: async () => {
        throw new Error("IndexedDB commit failed");
      },
    }),
  ).rejects.toThrow("IndexedDB commit failed");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("reuploads finalized bytes under a fresh identity when a retained binding lacks lease runway", async () => {
  const now = Date.parse("2026-09-09T01:00:00.000Z");
  const oldClientAttachmentId = "50000000-0000-4000-8000-000000000090";
  const oldAttachmentId = "50000000-0000-4000-8000-000000000091";
  const file = new File([new Uint8Array([7, 8, 9])], "lease.png", { type: "image/png" });
  const saved: UploadCheckpoint[] = [];
  let freshClientAttachmentId = "";
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/v1/uploads/init") {
      const body = JSON.parse(String(init?.body)) as { readonly clientAttachmentId: string };
      freshClientAttachmentId = body.clientAttachmentId;
      return new Response(
        JSON.stringify({ sessionId: "upload-fresh-lease", chunkSize: 1024, version: 1 }),
        { status: 200 },
      );
    }
    if (path.includes("/chunks/0"))
      return new Response(null, { status: 204, headers: { "X-Upload-Version": "2" } });
    if (path.endsWith("/finalize"))
      return new Response(
        JSON.stringify({ attachmentId: ATTACHMENT_ID, readyToBind: true, version: 3 }),
        { status: 200 },
      );
    if (path.endsWith("/bind")) {
      const response = bindingResponseFromRequest(init);
      return new Response(
        JSON.stringify({ ...response, expiresAt: new Date(now + 15 * 60_000).toISOString() }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const retained: UploadCheckpoint = {
    clientAttachmentId: oldClientAttachmentId,
    sha256: await sha256Hex(file),
    init: { sessionId: "upload-expiring", chunkSize: 1024, version: 1 },
    nextChunk: 1,
    version: 3,
    finalized: { attachmentId: oldAttachmentId, readyToBind: true, version: 3 },
    binding: bindingResponse(oldClientAttachmentId, {
      attachmentId: oldAttachmentId,
      expiresAt: new Date(now + 60_000).toISOString(),
    }),
    bound: true,
  };

  await expect(
    uploadVerificationAttachment({
      projectId: PROJECT_ID,
      bugId: BUG_ID,
      clientSubmissionId: SUBMISSION_ID,
      file,
      checkpoint: retained,
      minimumBindingRunwayMs: 2 * 60_000,
      now: () => now,
      saveCheckpoint: async (checkpoint) => {
        saved.push(checkpoint);
      },
    }),
  ).resolves.toBe(ATTACHMENT_ID);

  expect(freshClientAttachmentId).not.toBe(oldClientAttachmentId);
  expect(saved[0]?.clientAttachmentId).toBe(freshClientAttachmentId);
  expect(saved[0]?.init).toBeUndefined();
  expect(saved.at(-1)?.binding).toMatchObject({
    clientAttachmentId: freshClientAttachmentId,
    attachmentId: ATTACHMENT_ID,
    leaseGeneration: 1,
    expiresAt: new Date(now + 15 * 60_000).toISOString(),
  });
  const finalCheckpoint = saved.at(-1);
  if (finalCheckpoint === undefined) throw new Error("Binding checkpoint was not saved");
  expect(verificationAttachmentBindingHasRunway(finalCheckpoint, now, 2 * 60_000)).toBe(true);
  expect(
    verificationAttachmentBindingHasRunway(finalCheckpoint, now, 2 * 60_000, {
      projectId: PROJECT_ID,
      clientSubmissionId: "70000000-0000-4000-8000-000000000099",
      targetQaItemId: BUG_ID,
    }),
  ).toBe(false);
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
    "/api/v1/uploads/init",
    "/api/v1/uploads/upload-fresh-lease/chunks/0",
    "/api/v1/uploads/upload-fresh-lease/finalize",
    `/api/v1/attachments/${ATTACHMENT_ID}/bind`,
  ]);
});

it("persists a late replayed binding receipt and falls back to a fresh identity in the same retry", async () => {
  const now = Date.parse("2026-09-09T01:00:00.000Z");
  const oldClientAttachmentId = "50000000-0000-4000-8000-000000000092";
  const oldAttachmentId = "50000000-0000-4000-8000-000000000093";
  const file = new File([new Uint8Array([10, 11, 12])], "late-replay.png", {
    type: "image/png",
  });
  const saved: UploadCheckpoint[] = [];
  let bindCount = 0;
  let freshClientAttachmentId = "";
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === `/api/v1/attachments/${oldAttachmentId}/bind`) {
      bindCount += 1;
      return new Response(
        JSON.stringify(
          bindingResponse(oldClientAttachmentId, {
            attachmentId: oldAttachmentId,
            expiresAt: new Date(now + 30_000).toISOString(),
            replayed: true,
          }),
        ),
        { status: 200 },
      );
    }
    if (path === "/api/v1/uploads/init") {
      const body = JSON.parse(String(init?.body)) as { readonly clientAttachmentId: string };
      freshClientAttachmentId = body.clientAttachmentId;
      return new Response(
        JSON.stringify({ sessionId: "upload-after-late-replay", chunkSize: 1024, version: 1 }),
        { status: 200 },
      );
    }
    if (path.includes("/chunks/0"))
      return new Response(null, { status: 204, headers: { "X-Upload-Version": "2" } });
    if (path.endsWith("/finalize"))
      return new Response(
        JSON.stringify({ attachmentId: ATTACHMENT_ID, readyToBind: true, version: 3 }),
        { status: 200 },
      );
    if (path === `/api/v1/attachments/${ATTACHMENT_ID}/bind`) {
      bindCount += 1;
      const response = bindingResponseFromRequest(init);
      return new Response(
        JSON.stringify({ ...response, expiresAt: new Date(now + 15 * 60_000).toISOString() }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    uploadVerificationAttachment({
      projectId: PROJECT_ID,
      bugId: BUG_ID,
      clientSubmissionId: SUBMISSION_ID,
      file,
      checkpoint: {
        clientAttachmentId: oldClientAttachmentId,
        sha256: await sha256Hex(file),
        init: { sessionId: "upload-original", chunkSize: 1024, version: 1 },
        nextChunk: 1,
        version: 3,
        finalized: { attachmentId: oldAttachmentId, readyToBind: true, version: 3 },
      },
      minimumBindingRunwayMs: 2 * 60_000,
      now: () => now,
      saveCheckpoint: async (checkpoint) => {
        saved.push(checkpoint);
      },
    }),
  ).resolves.toBe(ATTACHMENT_ID);

  expect(bindCount).toBe(2);
  expect(saved.some((checkpoint) => checkpoint.binding?.attachmentId === oldAttachmentId)).toBe(
    true,
  );
  expect(freshClientAttachmentId).not.toBe(oldClientAttachmentId);
  expect(saved.at(-1)?.binding).toMatchObject({
    attachmentId: ATTACHMENT_ID,
    clientAttachmentId: freshClientAttachmentId,
    expiresAt: new Date(now + 15 * 60_000).toISOString(),
  });
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
    `/api/v1/attachments/${oldAttachmentId}/bind`,
    "/api/v1/uploads/init",
    "/api/v1/uploads/upload-after-late-replay/chunks/0",
    "/api/v1/uploads/upload-after-late-replay/finalize",
    `/api/v1/attachments/${ATTACHMENT_ID}/bind`,
  ]);
});

it("renews an expired frozen Verification binding in place and persists generation 2 before resolving", async () => {
  const now = Date.parse("2026-09-09T02:00:00.000Z");
  const checkpoint: UploadCheckpoint = {
    clientAttachmentId: "50000000-0000-4000-8000-000000000094",
    sha256: "b".repeat(64),
    init: { sessionId: "upload-frozen", chunkSize: 1024, version: 1 },
    nextChunk: 1,
    version: 3,
    finalized: { attachmentId: ATTACHMENT_ID, readyToBind: true, version: 3 },
    binding: bindingResponse("50000000-0000-4000-8000-000000000094", {
      expiresAt: new Date(now - 1).toISOString(),
    }),
    bound: true,
  };
  const durableGate = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  })();
  let saveStarted = false;
  let resolved = false;
  let saved: UploadCheckpoint | undefined;
  const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      readonly clientAttachmentId: string;
      readonly leaseGeneration: number;
    };
    return new Response(
      JSON.stringify(
        bindingResponse(body.clientAttachmentId, {
          leaseGeneration: body.leaseGeneration,
          expiresAt: new Date(now + 15 * 60_000).toISOString(),
          version: 5,
          replayed: true,
        }),
      ),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);

  const renewal = refreshVerificationAttachmentBinding({
    projectId: PROJECT_ID,
    bugId: BUG_ID,
    clientSubmissionId: SUBMISSION_ID,
    checkpoint,
    now: () => now,
    saveCheckpoint: async (next) => {
      saveStarted = true;
      saved = next;
      await durableGate.promise;
    },
  }).then((value) => {
    resolved = true;
    return value;
  });
  await vi.waitFor(() => expect(saveStarted).toBe(true));
  expect(resolved).toBe(false);

  const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/attachments/${ATTACHMENT_ID}/bind`);
  expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
    `submission:${SUBMISSION_ID}:attachment:${checkpoint.clientAttachmentId}:bind:2`,
  );
  expect(JSON.parse(String(init.body))).toEqual({
    submissionContractVersion: "1.1.0",
    expectedVersion: 4,
    projectId: PROJECT_ID,
    clientSubmissionId: SUBMISSION_ID,
    clientAttachmentId: checkpoint.clientAttachmentId,
    leaseGeneration: 2,
    intent: "verification_result",
    targetQaItemId: BUG_ID,
  });
  expect(saved?.binding).toEqual(
    bindingResponse(checkpoint.clientAttachmentId, {
      leaseGeneration: 2,
      expiresAt: new Date(now + 15 * 60_000).toISOString(),
      version: 5,
      replayed: true,
    }),
  );

  durableGate.resolve();
  await expect(renewal).resolves.toEqual(saved);
});

it("replays the exact generation 2 renewal after its response is lost before persistence", async () => {
  const now = Date.parse("2026-09-09T02:30:00.000Z");
  const clientAttachmentId = "50000000-0000-4000-8000-000000000096";
  const checkpoint: UploadCheckpoint = {
    clientAttachmentId,
    sha256: "e".repeat(64),
    init: { sessionId: "upload-lost-renewal", chunkSize: 1024, version: 1 },
    nextChunk: 1,
    version: 3,
    finalized: { attachmentId: ATTACHMENT_ID, readyToBind: true, version: 3 },
    binding: bindingResponse(clientAttachmentId, {
      expiresAt: new Date(now - 1).toISOString(),
    }),
    bound: true,
  };
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    void path;
    void init;
    if (fetchMock.mock.calls.length === 1) {
      throw new TypeError("connection closed after generation 2 committed");
    }
    return Response.json(
      bindingResponse(clientAttachmentId, {
        leaseGeneration: 2,
        expiresAt: new Date(now + 15 * 60_000).toISOString(),
        version: 5,
        replayed: true,
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const saveCheckpoint = vi.fn(async () => undefined);
  const renew = () =>
    refreshVerificationAttachmentBinding({
      projectId: PROJECT_ID,
      bugId: BUG_ID,
      clientSubmissionId: SUBMISSION_ID,
      checkpoint,
      now: () => now,
      saveCheckpoint,
    });

  await expect(renew()).rejects.toThrow("connection closed after generation 2 committed");
  expect(saveCheckpoint).not.toHaveBeenCalled();
  await expect(renew()).resolves.toMatchObject({
    binding: { leaseGeneration: 2, version: 5, replayed: true },
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  const requests = fetchMock.mock.calls.map(([, init]) => init as RequestInit);
  expect(requests.map((init) => new Headers(init.headers).get("Idempotency-Key"))).toEqual([
    `submission:${SUBMISSION_ID}:attachment:${clientAttachmentId}:bind:2`,
    `submission:${SUBMISSION_ID}:attachment:${clientAttachmentId}:bind:2`,
  ]);
  expect(requests.map((init) => JSON.parse(String(init.body)))).toEqual([
    {
      submissionContractVersion: "1.1.0",
      expectedVersion: 4,
      projectId: PROJECT_ID,
      clientSubmissionId: SUBMISSION_ID,
      clientAttachmentId,
      leaseGeneration: 2,
      intent: "verification_result",
      targetQaItemId: BUG_ID,
    },
    {
      submissionContractVersion: "1.1.0",
      expectedVersion: 4,
      projectId: PROJECT_ID,
      clientSubmissionId: SUBMISSION_ID,
      clientAttachmentId,
      leaseGeneration: 2,
      intent: "verification_result",
      targetQaItemId: BUG_ID,
    },
  ]);
  expect(saveCheckpoint).toHaveBeenCalledOnce();
});

it("keeps the generation 1 checkpoint when an older server rejects frozen binding renewal", async () => {
  const now = Date.parse("2026-09-09T03:00:00.000Z");
  const clientAttachmentId = "50000000-0000-4000-8000-000000000095";
  const checkpoint: UploadCheckpoint = {
    clientAttachmentId,
    sha256: "d".repeat(64),
    nextChunk: 1,
    version: 3,
    finalized: { attachmentId: ATTACHMENT_ID, readyToBind: true, version: 3 },
    binding: bindingResponse(clientAttachmentId, {
      expiresAt: new Date(now - 1).toISOString(),
    }),
    bound: true,
  };
  const saveCheckpoint = vi.fn(async () => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "SQLITE_UPLOAD_VERSION_CONFLICT" }), { status: 409 }),
    ),
  );

  await expect(
    refreshVerificationAttachmentBinding({
      projectId: PROJECT_ID,
      bugId: BUG_ID,
      clientSubmissionId: SUBMISSION_ID,
      checkpoint,
      now: () => now,
      saveCheckpoint,
    }),
  ).rejects.toMatchObject({ status: 409, code: "SQLITE_UPLOAD_VERSION_CONFLICT" });
  expect(saveCheckpoint).not.toHaveBeenCalled();
  expect(checkpoint.binding?.leaseGeneration).toBe(1);
});

it("replays the exact frozen Verification body after a lost response and validates its receipt", async () => {
  const earlierAttachmentId = "50000000-0000-4000-8000-000000000000";
  const frozen = freezeVerificationResultRequest({
    verificationId: VERIFICATION_ID,
    expectedVersion: 2,
    resultSummary: "Verified with frozen evidence",
    clientSubmissionId: SUBMISSION_ID,
    status: "passed",
    attachmentIds: [ATTACHMENT_ID, earlierAttachmentId],
    captureBundleId: CAPTURE_ID,
  });
  const bodies: string[] = [];
  const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) throw new TypeError("response lost after commit");
    return new Response(JSON.stringify(verificationResultResponse(frozen, true)), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(recordFrozenVerificationResult(frozen)).rejects.toThrow(
    "response lost after commit",
  );
  const replay = await recordFrozenVerificationResult(frozen);

  expect(bodies).toEqual([frozen.requestBody, frozen.requestBody]);
  expect(JSON.parse(frozen.requestBody)).toEqual({
    submissionContractVersion: "1.1.0",
    clientSubmissionId: SUBMISSION_ID,
    expectedVersion: 2,
    status: "passed",
    resultSummary: "Verified with frozen evidence",
    attachmentIds: [earlierAttachmentId, ATTACHMENT_ID],
    captureBundleId: CAPTURE_ID,
  });
  expect(verificationResultReceiptMatches(frozen, replay, verificationExpectation(frozen))).toBe(
    true,
  );
  expect(
    verificationResultReceiptMatches(
      frozen,
      { ...replay, attachmentIds: ["50000000-0000-4000-8000-000000000099"] },
      verificationExpectation(frozen),
    ),
  ).toBe(false);
  expect(
    verificationResultReceiptMatches(
      frozen,
      {
        ...replay,
        verification: { ...replay.verification, resultSummary: "Different summary" },
      },
      verificationExpectation(frozen),
    ),
  ).toBe(false);
  expect(
    verificationResultReceiptMatches(
      frozen,
      {
        ...replay,
        bug: {
          ...replay.bug,
          projectId: "30000000-0000-4000-8000-000000000099",
        },
      },
      verificationExpectation(frozen),
    ),
  ).toBe(false);
  expect(
    verificationResultReceiptMatches(
      frozen,
      {
        ...replay,
        verification: {
          ...replay.verification,
          repairAttemptId: "40000000-0000-4000-8000-000000000099",
        },
      },
      verificationExpectation(frozen),
    ),
  ).toBe(false);
  expect(
    verificationResultReceiptMatches(
      frozen,
      {
        ...replay,
        repairAttempt: {
          ...replay.repairAttempt,
          id: "40000000-0000-4000-8000-000000000099",
        },
      },
      verificationExpectation(frozen),
    ),
  ).toBe(false);
  expect(
    verificationResultReceiptMatches(
      frozen,
      {
        ...replay,
        repairAttempt: {
          ...replay.repairAttempt,
          bugId: "20000000-0000-4000-8000-000000000099",
        },
      },
      verificationExpectation(frozen),
    ),
  ).toBe(false);
  expect(
    verificationResultReceiptMatches(
      frozen,
      {
        ...replay,
        verification: {
          ...replay.verification,
          verifierId: "10000000-0000-4000-8000-000000000099",
        },
      },
      verificationExpectation(frozen),
    ),
  ).toBe(false);
});

it("requires the exact failed or blocked reason in the rich Verification readback", () => {
  const failed = freezeVerificationResultRequest({
    verificationId: VERIFICATION_ID,
    expectedVersion: 2,
    resultSummary: "Still reproducible",
    clientSubmissionId: SUBMISSION_ID,
    status: "failed",
    failureReason: "The original defect remains",
    attachmentIds: [ATTACHMENT_ID],
    captureBundleId: null,
  });
  const failedReceipt = verificationResultResponse(failed, false);
  expect(
    verificationResultReceiptMatches(failed, failedReceipt, verificationExpectation(failed)),
  ).toBe(true);
  const failedReadback = {
    ...failedReceipt.verification,
    failureReason: "The original defect remains",
    blockedReason: null,
  };
  expect(
    verificationResultReadbackMatches(
      failed,
      failedReadback,
      verificationReadbackExpectation(failed),
    ),
  ).toBe(true);
  expect(
    verificationResultReadbackMatches(
      failed,
      {
        ...failedReadback,
        failureReason: "A different failure reason",
      },
      verificationReadbackExpectation(failed),
    ),
  ).toBe(false);
  expect(
    verificationResultReadbackMatches(
      failed,
      {
        ...failedReadback,
        repairAttemptId: "40000000-0000-4000-8000-000000000099",
      },
      verificationReadbackExpectation(failed),
    ),
  ).toBe(false);
  expect(
    verificationResultReadbackMatches(
      failed,
      {
        ...failedReadback,
        verifierId: "10000000-0000-4000-8000-000000000099",
      },
      verificationReadbackExpectation(failed),
    ),
  ).toBe(false);

  const blocked = freezeVerificationResultRequest({
    verificationId: "90000000-0000-4000-8000-000000000005",
    expectedVersion: 7,
    resultSummary: "Cannot verify",
    clientSubmissionId: SUBMISSION_ID,
    status: "blocked",
    blockedReason: "The target device is offline",
    attachmentIds: [],
    captureBundleId: null,
  });
  const blockedReceipt = verificationResultResponse(blocked, true);
  expect(
    verificationResultReceiptMatches(blocked, blockedReceipt, verificationExpectation(blocked)),
  ).toBe(true);
  const blockedReadback = {
    ...blockedReceipt.verification,
    failureReason: null,
    blockedReason: "The target device is offline",
  };
  expect(
    verificationResultReadbackMatches(
      blocked,
      blockedReadback,
      verificationReadbackExpectation(blocked),
    ),
  ).toBe(true);
  expect(
    verificationResultReadbackMatches(
      blocked,
      {
        ...blockedReadback,
        blockedReason: null,
      },
      verificationReadbackExpectation(blocked),
    ),
  ).toBe(false);
});

it("refuses to send a persisted frozen result whose structured fields drifted", async () => {
  const frozen = freezeVerificationResultRequest({
    verificationId: VERIFICATION_ID,
    expectedVersion: 2,
    resultSummary: "Original frozen summary",
    clientSubmissionId: SUBMISSION_ID,
    status: "failed",
    failureReason: "Still reproducible",
    attachmentIds: [ATTACHMENT_ID],
    captureBundleId: null,
  });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    recordFrozenVerificationResult({ ...frozen, resultSummary: "Changed after refresh" }),
  ).rejects.toMatchObject({ code: "FROZEN_VERIFICATION_RESULT_MISMATCH" });
  expect(fetchMock).not.toHaveBeenCalled();
});

describe("Bug detail API", () => {
  it("reads comments beyond the first 50-item page", async () => {
    const comments = Array.from({ length: 51 }, (_, index) => ({
      id: `81000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      bugId: BUG_ID,
      projectId: PROJECT_ID,
      authorId: principal().userId,
      body: `Comment ${index + 1}`,
      attachmentIds: [],
      createdAt: `2026-09-09T00:${String(index).padStart(2, "0")}:00.000Z`,
      version: 1,
    }));
    const responses = [
      Response.json({
        bugId: BUG_ID,
        projectId: PROJECT_ID,
        snapshotSequence: 51,
        items: comments.slice(0, 50),
        nextCursor: "comments-page-2",
      }),
      Response.json({
        bugId: BUG_ID,
        projectId: PROJECT_ID,
        snapshotSequence: 51,
        items: comments.slice(50),
        nextCursor: null,
      }),
    ];
    const fetchMock = vi.fn(async (_path: string) => {
      void _path;
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected comments request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listBugComments(BUG_ID)).resolves.toMatchObject({
      snapshotSequence: 51,
      items: comments,
      nextCursor: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([path]) => new URL(String(path), "http://qa-hub.local"));
    expect(urls.map((url) => url.searchParams.get("cursor"))).toEqual([null, "comments-page-2"]);
  });

  it("reads events beyond the first 20-item page", async () => {
    const events = Array.from({ length: 21 }, (_, index) => ({
      projectionVersion: "1.1.0" as const,
      redactionPolicyVersion: "1.0.0" as const,
      id: `82000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      type: "comment.created",
      source: "qa-hub",
      projectId: PROJECT_ID,
      bugId: BUG_ID,
      aggregate: { type: "bug", id: BUG_ID, version: index + 1 },
      sequence: index + 1,
      actor: { type: "user", id: principal().userId },
      correlationId: `83000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      causationId: null,
      occurredAt: `2026-09-09T00:${String(index).padStart(2, "0")}:00.000Z`,
      fromState: null,
      toState: null,
      payload: {},
    }));
    const responses = [
      Response.json({
        bugId: BUG_ID,
        projectId: PROJECT_ID,
        snapshotSequence: 21,
        items: events.slice(0, 20),
        nextCursor: "events-page-2",
      }),
      Response.json({
        bugId: BUG_ID,
        projectId: PROJECT_ID,
        snapshotSequence: 21,
        items: events.slice(20),
        nextCursor: null,
      }),
    ];
    const fetchMock = vi.fn(async (_path: string) => {
      void _path;
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected events request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listBugEvents(BUG_ID)).resolves.toMatchObject({
      snapshotSequence: 21,
      items: events,
      nextCursor: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([path]) => new URL(String(path), "http://qa-hub.local"));
    expect(urls.map((url) => url.searchParams.get("cursor"))).toEqual([null, "events-page-2"]);
  });

  it("fails the whole comment read when a continuation page fails", async () => {
    const firstComment = {
      id: "81000000-0000-4000-8000-000000000001",
      bugId: BUG_ID,
      projectId: PROJECT_ID,
      authorId: principal().userId,
      body: "The first page must never escape as a complete history.",
      attachmentIds: [],
      createdAt: "2026-09-09T00:00:00.000Z",
      version: 1,
    };
    const responses = [
      Response.json({
        bugId: BUG_ID,
        projectId: PROJECT_ID,
        snapshotSequence: 2,
        items: [firstComment],
        nextCursor: "comments-page-2",
      }),
      Response.json({ code: "DEPENDENCY_UNAVAILABLE" }, { status: 503 }),
    ];
    const fetchMock = vi.fn(async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected comments request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listBugComments(BUG_ID)).rejects.toMatchObject({
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a repeated event continuation cursor", async () => {
    const responses = [
      Response.json({
        bugId: BUG_ID,
        projectId: PROJECT_ID,
        snapshotSequence: 1,
        items: [],
        nextCursor: "repeated-event-cursor",
      }),
      Response.json({
        bugId: BUG_ID,
        projectId: PROJECT_ID,
        snapshotSequence: 1,
        items: [],
        nextCursor: "repeated-event-cursor",
      }),
    ];
    const fetchMock = vi.fn(async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected events request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listBugEvents(BUG_ID)).rejects.toMatchObject({
      status: 200,
      code: "INVALID_EVENT_CURSOR",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

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
