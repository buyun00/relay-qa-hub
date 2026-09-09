import { renderToStaticMarkup } from "react-dom/server";
import { act, Profiler } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App, { type AppDraft } from "./App";
import * as api from "./api";
import { listProjectComponents } from "./project-api";

vi.mock("./AppIcon", () => ({ default: () => null }));
vi.mock("./pending-submission", () => ({
  durableSubmissions: {
    recoverBug: vi.fn(async () => undefined),
    recoverComment: vi.fn(async () => undefined),
    rejection: vi.fn(async () => undefined),
  },
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  createVerification: vi.fn(),
  getBug: vi.fn(),
  getHumanWorkflow: vi.fn(),
  getVerification: vi.fn(),
  listBugAttachments: vi.fn(),
  listBugComments: vi.fn(),
  listBugEvents: vi.fn(),
  listBugRepairAttempts: vi.fn(),
  listAllBugs: vi.fn(),
  listProjectMembers: vi.fn(),
  listProjectModules: vi.fn(),
  listVisibleProjects: vi.fn(),
  recordFrozenVerificationResult: vi.fn(),
  refreshVerificationAttachmentBinding: vi.fn(),
  startVerification: vi.fn(),
  uploadVerificationAttachment: vi.fn(),
}));
vi.mock("./project-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./project-api")>()),
  listProjectComponents: vi.fn(),
}));

const projectId = "30000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000003";
const bugId = "20000000-0000-4000-8000-000000000001";
const principal = {
  accountId: "10000000-0000-4000-8000-000000000001",
  userId: actorId,
  email: "detail-loading@qa.local",
  displayName: "Detail loading fixture",
  csrfToken: "synthetic-detail-csrf",
};
const selectedDraft: AppDraft = {
  newContent: "",
  newOwnerId: "",
  newVerifierId: actorId,
  newSeverity: "S2",
  newFiles: [],
  createOpen: false,
  selectedId: bugId,
  comment: "",
  detailDraft: null,
  detailNewFiles: [],
  detailAttachmentIds: [],
  editingDetail: false,
  assignmentDrafts: {},
  returnDrafts: {},
};
const bug: api.BugDetail = {
  id: bugId,
  projectId,
  key: "DETAIL-1",
  number: 1,
  title: "Detail response fixture",
  description: "The requested Bug detail arrived.",
  expectedBehavior: "Show a pending request until a response arrives.",
  moduleId: null,
  state: "reported",
  severity: "S2",
  priority: "P2",
  reporterId: actorId,
  ownerId: actorId,
  verificationOwnerId: actorId,
  duplicateOfBugId: null,
  occurrenceCount: 1,
  reopenCount: 0,
  version: 1,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  closedAt: null,
};

function repairAttempt(patch: Partial<api.RepairAttempt> = {}): api.RepairAttempt {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    bugId,
    sequence: 1,
    mode: "human",
    status: "running",
    assigneeId: actorId,
    parentAttemptId: null,
    summary: "Reproduce and repair the detail failure",
    branch: null,
    commitSha: null,
    mergeRequestUrl: null,
    targetBuildId: null,
    version: 3,
    ...patch,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("UNEXPECTED_NETWORK"))),
  );
  const target = new EventTarget();
  vi.stubGlobal("window", {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
    setTimeout,
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  });
  vi.mocked(listProjectComponents).mockResolvedValue({ projectId, items: [] });
  vi.mocked(api.listVisibleProjects).mockResolvedValue({
    snapshotSequence: 1,
    items: [{ id: projectId, key: "DETAIL", name: "Detail fixture", active: true, roles: [] }],
    nextCursor: null,
  });
  vi.mocked(api.listProjectMembers).mockResolvedValue({
    projectId,
    snapshotSequence: 1,
    items: [
      { userId: actorId, projectId, displayName: principal.displayName, roles: [], active: true },
    ],
    nextCursor: null,
  });
  vi.mocked(api.listAllBugs).mockResolvedValue({
    snapshotSequence: 1,
    items: [bug],
    nextCursor: null,
  });
  vi.mocked(api.listBugEvents).mockResolvedValue({
    bugId,
    projectId,
    snapshotSequence: 1,
    items: [],
    nextCursor: null,
  });
  vi.mocked(api.listBugAttachments).mockResolvedValue({
    projectId,
    bugId,
    snapshotSequence: 1,
    items: [],
    nextCursor: null,
  });
  vi.mocked(api.listBugComments).mockResolvedValue({
    bugId,
    projectId,
    snapshotSequence: 1,
    items: [],
    nextCursor: null,
  });
  vi.mocked(api.listBugRepairAttempts).mockResolvedValue([]);
  vi.mocked(api.listProjectModules).mockResolvedValue({ projectId, items: [] });
  vi.mocked(api.refreshVerificationAttachmentBinding).mockImplementation(
    async (input) => input.checkpoint,
  );
  vi.mocked(api.getHumanWorkflow).mockResolvedValue({
    bugId,
    repairAttempt: null,
    buildRequirement: null,
    build: null,
    verification: null,
  });
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function mountWorkbench(
  commits: string[] = [],
  options: {
    readonly initialDraft?: AppDraft;
    readonly onDraftChange?: (draft: AppDraft) => Promise<void>;
  } = {},
) {
  await act(async () => {
    renderer = create(
      <Profiler
        id="real-App"
        onRender={() => {
          if (renderer) commits.push(JSON.stringify(renderer.toJSON()));
        }}
      >
        <App
          principal={principal}
          projectId={projectId}
          initialDraft={options.initialDraft}
          signingOut={false}
          onSignOut={() => undefined}
          onDraftChange={options.onDraftChange ?? (async () => undefined)}
        />
      </Profiler>,
    );
  });
  if (renderer === undefined) throw new Error("App did not mount");
  return renderer;
}

async function openFirstBug(view: ReactTestRenderer) {
  await act(async () => {
    view.root.findByProps({ className: "table-row bug-row" }).props.onClick();
  });
}

function expectPending(view: ReactTestRenderer) {
  const modal = view.root.findByProps({ className: "detail-modal" });
  expect(modal.findAllByProps({ className: "detail-load-error" })).toHaveLength(0);
  expect(modal.findByType("span").children).toContain("正在读取 Bug 详情…");
}

describe("Bug detail loading and explicit failure", () => {
  it("shows loading for a selected record before the detail effect starts", () => {
    const markup = renderToStaticMarkup(
      <App
        principal={principal}
        projectId={projectId}
        initialDraft={selectedDraft}
        signingOut={false}
        onSignOut={() => undefined}
        onDraftChange={async () => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Bug 详情"');
    expect(markup).toContain("正在读取 Bug 详情…");
    expect(markup).not.toContain("Bug 详情读取失败");
    expect(markup).not.toContain("无法连接统一后端。");
    expect(markup).not.toContain("重新读取");
  });

  it("never commits an error when first selecting a Bug while its request is pending", async () => {
    const response = deferred<api.BugDetail>();
    vi.mocked(api.getBug).mockReturnValue(response.promise);
    const commits: string[] = [];
    const view = await mountWorkbench(commits);
    commits.length = 0;

    await openFirstBug(view);
    expect(api.getBug).toHaveBeenCalledExactlyOnceWith(bugId);
    expectPending(view);
    expect(commits.some((markup) => markup.includes("正在读取 Bug 详情…"))).toBe(true);
    expect(commits.every((markup) => !markup.includes("detail-load-error"))).toBe(true);

    await act(async () => response.resolve(bug));
    expect(view.root.findByProps({ className: "detail-key" }).children).toEqual([bug.key]);
    expect(view.root.findAllByProps({ className: "detail-loading" })).toHaveLength(0);
    expect(view.root.findAllByProps({ className: "detail-load-error" })).toHaveLength(0);
  });

  it("shows an actual asynchronous failure and retries through the same App load handler", async () => {
    const failed = deferred<api.BugDetail>();
    const retried = deferred<api.BugDetail>();
    vi.mocked(api.getBug).mockReturnValueOnce(failed.promise).mockReturnValueOnce(retried.promise);
    const view = await mountWorkbench();
    await openFirstBug(view);
    expectPending(view);

    await act(async () => failed.reject(new Error("明确的详情请求故障")));
    const error = view.root.findByProps({ className: "detail-load-error" });
    expect(error.props.role).toBe("alert");
    expect(error.findByType("p").children).toEqual(["明确的详情请求故障"]);
    expect(error.findByType("strong").children).toEqual(["Bug 详情读取失败"]);
    const retry = error.findByType("button");
    expect(retry.children).toEqual(["重新读取"]);

    await act(async () => retry.props.onClick());
    expect(api.getBug).toHaveBeenCalledTimes(2);
    expect(api.getBug).toHaveBeenNthCalledWith(2, bugId);
    expectPending(view);
    await act(async () => retried.resolve(bug));
    expect(view.root.findByProps({ className: "detail-key" }).children).toEqual([bug.key]);
    expect(view.root.findByProps({ className: "detail-modal-scroll" })).toBeDefined();
    expect(view.root.findAllByProps({ className: "detail-load-error" })).toHaveLength(0);
  });
});

describe("repair and verification actions", () => {
  it("keeps the prior personal list when owner and verifier streams have different snapshots", async () => {
    const ownerDrift: api.BugDetail = {
      ...bug,
      id: "20000000-0000-4000-8000-000000000002",
      key: "DETAIL-2",
      title: "Owner stream from a newer snapshot",
      description: "Owner-only drift must stay hidden.",
    };
    const verifierDrift: api.BugDetail = {
      ...bug,
      id: "20000000-0000-4000-8000-000000000003",
      key: "DETAIL-3",
      title: "Verifier stream from an older snapshot",
      description: "Verifier-only drift must stay hidden.",
    };
    const view = await mountWorkbench();
    await vi.waitFor(() =>
      expect(view.root.findByProps({ className: "result-inline" }).children.join("")).toBe(
        "1 个事项",
      ),
    );
    expect(JSON.stringify(view.toJSON())).toContain(bug.description);

    vi.mocked(api.listAllBugs)
      .mockResolvedValueOnce({ snapshotSequence: 3, items: [ownerDrift], nextCursor: null })
      .mockResolvedValueOnce({ snapshotSequence: 2, items: [verifierDrift], nextCursor: null });
    await act(async () => view.root.findByProps({ "aria-label": "刷新列表" }).props.onClick());
    await vi.waitFor(() =>
      expect(
        view.root.findByProps({ className: "banner error-banner" }).children.join(""),
      ).toContain("PERSONAL_BUG_SNAPSHOT_MISMATCH"),
    );

    const markup = JSON.stringify(view.toJSON());
    expect(markup).toContain(bug.description);
    expect(markup).not.toContain(ownerDrift.description);
    expect(markup).not.toContain(verifierDrift.description);
    expect(api.listAllBugs).toHaveBeenCalledTimes(6);
  });

  it("keeps responsibility-assigned work visible without treating that attribution as actor identity", async () => {
    const canonicalVerifierId = "10000000-0000-4000-8000-000000000010";
    const ownerId = "10000000-0000-4000-8000-000000000011";
    const verifierBug: api.BugDetail = {
      ...bug,
      state: "ready_for_verification",
      ownerId,
      verificationOwnerId: canonicalVerifierId,
      version: 4,
    };
    const attempt = repairAttempt({ status: "delivered", version: 4 });
    vi.mocked(api.listProjectMembers).mockResolvedValue({
      projectId,
      snapshotSequence: 2,
      items: [
        {
          userId: canonicalVerifierId,
          projectId,
          displayName: "Canonical verifier",
          roles: ["verifier"],
          active: true,
        },
        {
          userId: ownerId,
          projectId,
          displayName: "Repair owner",
          roles: ["developer"],
          active: true,
        },
      ],
      nextCursor: null,
    });
    vi.mocked(api.listAllBugs).mockResolvedValue({
      snapshotSequence: 2,
      items: [verifierBug],
      nextCursor: null,
    });
    vi.mocked(api.getBug).mockResolvedValue(verifierBug);
    vi.mocked(api.getHumanWorkflow).mockResolvedValue({
      bugId,
      repairAttempt: attempt,
      buildRequirement: null,
      build: null,
      verification: null,
    });

    const view = await mountWorkbench();
    expect(api.listAllBugs).toHaveBeenCalledWith(projectId, { ownerId: actorId });
    expect(api.listAllBugs).toHaveBeenCalledWith(projectId, {
      verificationOwnerId: actorId,
    });
    expect(view.root.findByProps({ className: "result-inline" }).children.join("")).toBe(
      "0 个事项",
    );
    await act(async () => {
      view.root.findByProps({ "data-status": "verification" }).props.onClick();
    });
    expect(view.root.findByProps({ className: "result-inline" }).children.join("")).toBe(
      "1 个事项",
    );
    await openFirstBug(view);
    expect(view.root.findByProps({ "aria-label": "验收说明和证据" })).toBeDefined();
    expect(
      view.root
        .findAllByType("button")
        .some((button) => button.children.join("") === "验收通过并关闭"),
    ).toBe(true);
  });

  it("lets an active project member create their own Verification when responsibility belongs to another member", async () => {
    const responsibleVerifierId = "10000000-0000-4000-8000-000000000010";
    const verificationId = "50000000-0000-4000-8000-000000000020";
    const completedBug: api.BugDetail = {
      ...bug,
      state: "ready_for_verification",
      verificationOwnerId: responsibleVerifierId,
      version: 4,
    };
    const attempt = repairAttempt({ status: "delivered", version: 4 });
    const requested: api.VerificationRecord = {
      id: verificationId,
      bugId,
      repairAttemptId: attempt.id,
      buildId: null,
      status: "requested",
      verifierId: actorId,
      criteriaSnapshot: completedBug.expectedBehavior,
      resultSummary: null,
      failureReason: null,
      blockedReason: null,
      version: 1,
    };
    const inProgress: api.VerificationRecord = {
      ...requested,
      status: "in_progress",
      version: 2,
    };
    const passed: api.VerificationRecord = {
      ...inProgress,
      status: "passed",
      resultSummary: "关闭人确认问题已解决，并完成本次验收。",
      version: 3,
    };
    vi.mocked(api.listProjectMembers).mockResolvedValue({
      projectId,
      snapshotSequence: 2,
      items: [
        {
          userId: actorId,
          projectId,
          displayName: principal.displayName,
          roles: ["developer"],
          active: true,
        },
        {
          userId: responsibleVerifierId,
          projectId,
          displayName: "Responsible verifier",
          roles: ["verifier"],
          active: true,
        },
      ],
      nextCursor: null,
    });
    vi.mocked(api.listAllBugs).mockImplementation(async (_projectId, filters) => ({
      snapshotSequence: 2,
      items: filters?.verificationOwnerId === actorId ? [] : [completedBug],
      nextCursor: null,
    }));
    vi.mocked(api.getBug).mockResolvedValue(completedBug);
    vi.mocked(api.getHumanWorkflow).mockResolvedValue({
      bugId,
      repairAttempt: attempt,
      buildRequirement: null,
      build: null,
      verification: null,
    });
    vi.mocked(api.createVerification).mockResolvedValue(requested);
    vi.mocked(api.startVerification).mockResolvedValue(inProgress);
    vi.mocked(api.getVerification).mockResolvedValueOnce(inProgress).mockResolvedValue(passed);
    vi.mocked(api.recordFrozenVerificationResult).mockImplementation(async (frozen) => ({
      clientSubmissionId: frozen.clientSubmissionId,
      qaItem: { type: "bug", id: bugId, key: completedBug.key },
      verification: {
        id: verificationId,
        bugId,
        repairAttemptId: attempt.id,
        buildId: null,
        status: "passed",
        verifierId: actorId,
        criteriaSnapshot: completedBug.expectedBehavior,
        resultSummary: passed.resultSummary,
        version: 3,
      },
      repairAttempt: attempt,
      bug: {
        ...completedBug,
        state: "closed",
        version: completedBug.version + 1,
        closedAt: "2026-09-09T01:00:00.000Z",
      },
      attachmentIds: frozen.attachmentIds,
      captureBundleId: frozen.captureBundleId,
      eventId: "90000000-0000-4000-8000-000000000020",
      replayed: false,
    }));

    const view = await mountWorkbench();
    await act(async () => {
      view.root.findByProps({ "data-status": "verification" }).props.onClick();
    });
    await openFirstBug(view);
    expect(JSON.stringify(view.toJSON())).toContain("Responsible verifier");
    const submit = view.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "验收通过并关闭");
    expect(submit).toBeDefined();

    await act(async () => submit?.props.onClick());
    await vi.waitFor(() => expect(api.createVerification).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(api.startVerification).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(api.recordFrozenVerificationResult).toHaveBeenCalledOnce());
    expect(api.createVerification).toHaveBeenCalledWith({
      bugId,
      expectedBugVersion: completedBug.version,
      repairAttemptId: attempt.id,
      buildId: null,
      verifierId: actorId,
      criteria: completedBug.expectedBehavior,
    });
    expect(api.startVerification).toHaveBeenCalledWith(verificationId, requested.version, {
      bugId,
      repairAttemptId: attempt.id,
      verifierId: actorId,
    });
  });

  it("does not take over another member's active Verification discovered after a lost create response", async () => {
    const responsibleVerifierId = "10000000-0000-4000-8000-000000000010";
    const completedBug: api.BugDetail = {
      ...bug,
      state: "ready_for_verification",
      verificationOwnerId: responsibleVerifierId,
      version: 4,
    };
    const attempt = repairAttempt({ status: "delivered", version: 4 });
    const otherVerification: api.VerificationRecord = {
      id: "50000000-0000-4000-8000-000000000021",
      bugId,
      repairAttemptId: attempt.id,
      buildId: null,
      status: "requested",
      verifierId: responsibleVerifierId,
      criteriaSnapshot: completedBug.expectedBehavior,
      resultSummary: null,
      failureReason: null,
      blockedReason: null,
      version: 1,
    };
    vi.mocked(api.listProjectMembers).mockResolvedValue({
      projectId,
      snapshotSequence: 2,
      items: [
        {
          userId: actorId,
          projectId,
          displayName: principal.displayName,
          roles: ["developer"],
          active: true,
        },
        {
          userId: responsibleVerifierId,
          projectId,
          displayName: "Responsible verifier",
          roles: ["verifier"],
          active: true,
        },
      ],
      nextCursor: null,
    });
    vi.mocked(api.listAllBugs).mockImplementation(async (_projectId, filters) => ({
      snapshotSequence: 2,
      items: filters?.verificationOwnerId === actorId ? [] : [completedBug],
      nextCursor: null,
    }));
    vi.mocked(api.getBug).mockResolvedValue(completedBug);
    vi.mocked(api.getHumanWorkflow)
      .mockResolvedValueOnce({
        bugId,
        repairAttempt: attempt,
        buildRequirement: null,
        build: null,
        verification: null,
      })
      .mockResolvedValue({
        bugId,
        repairAttempt: attempt,
        buildRequirement: null,
        build: null,
        verification: otherVerification,
      });
    vi.mocked(api.createVerification).mockRejectedValueOnce(new TypeError("response lost"));

    const view = await mountWorkbench();
    await act(async () => {
      view.root.findByProps({ "data-status": "verification" }).props.onClick();
    });
    await openFirstBug(view);
    const submit = view.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "验收通过并关闭");
    expect(submit).toBeDefined();

    await act(async () => submit?.props.onClick());
    await vi.waitFor(() =>
      expect(view.root.findAllByProps({ "aria-label": "验收说明和证据" })).toHaveLength(0),
    );
    expect(
      view.root
        .findByProps({ className: "action-note action-note-left", role: "status" })
        .children.join(""),
    ).toContain("Responsible verifier验收");
    expect(api.createVerification).toHaveBeenCalledOnce();
    expect(api.startVerification).not.toHaveBeenCalled();
    expect(api.recordFrozenVerificationResult).not.toHaveBeenCalled();
  });

  it("keeps Verification detail read-only while another member owns the active Verification", async () => {
    const assignedVerifierId = "10000000-0000-4000-8000-000000000010";
    const completedBug: api.BugDetail = {
      ...bug,
      state: "ready_for_verification",
      verificationOwnerId: assignedVerifierId,
      version: 4,
    };
    const attempt = repairAttempt({ status: "delivered", version: 4 });
    vi.mocked(api.listProjectMembers).mockResolvedValue({
      projectId,
      snapshotSequence: 2,
      items: [
        {
          userId: actorId,
          projectId,
          displayName: principal.displayName,
          roles: ["project_admin"],
          active: true,
        },
        {
          userId: assignedVerifierId,
          projectId,
          displayName: "Assigned verifier",
          roles: ["verifier"],
          active: true,
        },
      ],
      nextCursor: null,
    });
    vi.mocked(api.listAllBugs).mockImplementation(async (_projectId, filters) => ({
      snapshotSequence: 2,
      items: filters?.verificationOwnerId === actorId ? [] : [bug],
      nextCursor: null,
    }));
    vi.mocked(api.getBug).mockResolvedValue(completedBug);
    vi.mocked(api.getHumanWorkflow).mockResolvedValue({
      bugId,
      repairAttempt: attempt,
      buildRequirement: null,
      build: null,
      verification: {
        id: "50000000-0000-4000-8000-000000000001",
        bugId,
        repairAttemptId: attempt.id,
        buildId: null,
        status: "in_progress",
        verifierId: assignedVerifierId,
        criteriaSnapshot: completedBug.expectedBehavior,
        resultSummary: null,
        failureReason: null,
        blockedReason: null,
        version: 2,
      },
    });

    const view = await mountWorkbench();
    await openFirstBug(view);

    expect(view.root.findByProps({ className: "detail-content-card" })).toBeDefined();
    expect(view.root.findAllByProps({ "aria-label": "验收说明和证据" })).toHaveLength(0);
    const labels = view.root.findAllByType("button").map((button) => button.children.join(""));
    expect(labels).not.toContain("验收通过并关闭");
    expect(labels).not.toContain("暂缓验收");
    expect(labels).not.toContain("验收不通过，打回待处理");
    expect(
      view.root
        .findByProps({ className: "action-note action-note-left", role: "status" })
        .children.join(""),
    ).toContain("当前由 Assigned verifier验收");
  });

  it("persists the exact frozen result before POST and clears it only after a matching receipt", async () => {
    const completedBug: api.BugDetail = {
      ...bug,
      state: "ready_for_verification",
      version: 4,
    };
    const attempt = repairAttempt({ status: "delivered", version: 4 });
    const verification: api.VerificationRecord = {
      id: "50000000-0000-4000-8000-000000000001",
      bugId,
      repairAttemptId: attempt.id,
      buildId: null,
      status: "in_progress",
      verifierId: actorId,
      criteriaSnapshot: completedBug.expectedBehavior,
      resultSummary: null,
      failureReason: null,
      blockedReason: null,
      version: 2,
    };
    const draftKey = `${bugId}:${attempt.id}`;
    const clientSubmissionId = "70000000-0000-4000-8000-000000000001";
    const attachmentId = "60000000-0000-4000-8000-000000000001";
    const captureBundleId = "80000000-0000-4000-8000-000000000001";
    const file = new File([new Uint8Array([1, 2, 3])], "verification.png", {
      type: "image/png",
      lastModified: 1,
    });
    const initialDraft: AppDraft = {
      ...selectedDraft,
      returnDrafts: {
        [draftKey]: {
          reason: "Verified from durable evidence",
          files: [file],
          clientSubmissionId,
          captureBundleId,
          uploads: {},
        },
      },
    };
    vi.mocked(api.getBug).mockResolvedValue(completedBug);
    vi.mocked(api.getHumanWorkflow).mockResolvedValue({
      bugId,
      repairAttempt: attempt,
      buildRequirement: null,
      build: null,
      verification,
    });
    const readbackGate = deferred<api.VerificationRecord>();
    vi.mocked(api.getVerification)
      .mockResolvedValueOnce(verification)
      .mockReturnValue(readbackGate.promise);
    vi.mocked(api.uploadVerificationAttachment).mockImplementation(async (input) => {
      const checkpoint: api.UploadCheckpoint = input.checkpoint ?? {
        clientAttachmentId: "90000000-0000-4000-8000-000000000001",
        sha256: "a".repeat(64),
        nextChunk: 0,
      };
      if (input.deferBinding === true) {
        await input.saveCheckpoint?.({
          ...checkpoint,
          init: { sessionId: "upload-verification", chunkSize: 1024, version: 1 },
          nextChunk: 1,
          version: 3,
          finalized: { attachmentId, readyToBind: true, version: 3 },
        });
      } else {
        await input.saveCheckpoint?.({
          ...checkpoint,
          binding: {
            bindingId: "90000000-0000-4000-8000-000000000002",
            attachmentId,
            projectId,
            clientSubmissionId,
            clientAttachmentId: checkpoint.clientAttachmentId,
            leaseGeneration: 1,
            intent: "verification_result",
            targetQaItemId: bugId,
            status: "reserved",
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            version: 4,
            replayed: false,
          },
          bound: true,
        });
      }
      return attachmentId;
    });

    const frozenGate = deferred<undefined>();
    let frozenWriteStarted = false;
    let frozenWriteFinished = false;
    let resultPostFinished = false;
    let clearedAfterReceipt = false;
    let persistedFrozen: api.FrozenVerificationResultRequest | undefined;
    const onDraftChange = vi.fn(async (draft: AppDraft) => {
      const pending = draft.returnDrafts[draftKey]?.pendingResult;
      if (pending !== undefined) {
        persistedFrozen = pending;
        frozenWriteStarted = true;
        await frozenGate.promise;
        frozenWriteFinished = true;
      }
      if (resultPostFinished && draft.returnDrafts[draftKey] === undefined) {
        clearedAfterReceipt = true;
      }
    });
    vi.mocked(api.recordFrozenVerificationResult).mockImplementation(async (frozen) => {
      expect(frozenWriteFinished).toBe(true);
      const response: api.VerificationResultResponse = {
        clientSubmissionId: frozen.clientSubmissionId,
        qaItem: { type: "bug", id: bugId, key: completedBug.key },
        verification: {
          ...verification,
          status: frozen.status,
          resultSummary: frozen.resultSummary,
          version: frozen.expectedVersion + 1,
        },
        repairAttempt: attempt,
        bug: { ...completedBug, state: "closed", version: completedBug.version + 1 },
        attachmentIds: [...frozen.attachmentIds],
        captureBundleId: frozen.captureBundleId,
        eventId: "90000000-0000-4000-8000-000000000003",
        replayed: false,
      };
      resultPostFinished = true;
      return response;
    });

    const view = await mountWorkbench([], { initialDraft, onDraftChange });
    await vi.waitFor(() =>
      expect(view.root.findByProps({ className: "detail-key" })).toBeDefined(),
    );
    const submit = view.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "验收通过并关闭");
    expect(submit).toBeDefined();

    await act(async () => submit?.props.onClick());
    await vi.waitFor(() => expect(frozenWriteStarted).toBe(true));
    expect(api.recordFrozenVerificationResult).not.toHaveBeenCalled();
    expect(persistedFrozen).toMatchObject({
      verificationId: verification.id,
      expectedVersion: verification.version,
      status: "passed",
      resultSummary: "Verified from durable evidence",
      clientSubmissionId,
      attachmentIds: [attachmentId],
      captureBundleId,
    });
    if (persistedFrozen === undefined) throw new Error("Frozen result was not persisted");
    expect(JSON.parse(persistedFrozen.requestBody)).toMatchObject({
      expectedVersion: verification.version,
      status: "passed",
      attachmentIds: [attachmentId],
      captureBundleId,
    });

    await act(async () => frozenGate.resolve(undefined));
    await vi.waitFor(() => expect(api.recordFrozenVerificationResult).toHaveBeenCalledOnce());
    expect(clearedAfterReceipt).toBe(false);
    await act(async () =>
      readbackGate.resolve({
        ...verification,
        status: "passed",
        resultSummary: "Verified from durable evidence",
        version: verification.version + 1,
      }),
    );
    await vi.waitFor(() => expect(clearedAfterReceipt).toBe(true));
    expect(api.recordFrozenVerificationResult).toHaveBeenCalledWith(persistedFrozen);
    expect(api.uploadVerificationAttachment).toHaveBeenCalledTimes(2);
  });

  it("keeps the pending result when a receipt belongs to another project", async () => {
    const completedBug: api.BugDetail = {
      ...bug,
      state: "ready_for_verification",
      version: 4,
    };
    const attempt = repairAttempt({ status: "delivered", version: 4 });
    const verification: api.VerificationRecord = {
      id: "50000000-0000-4000-8000-000000000031",
      bugId,
      repairAttemptId: attempt.id,
      buildId: null,
      status: "in_progress",
      verifierId: actorId,
      criteriaSnapshot: completedBug.expectedBehavior,
      resultSummary: null,
      failureReason: null,
      blockedReason: null,
      version: 2,
    };
    const draftKey = `${bugId}:${attempt.id}`;
    const clientSubmissionId = "70000000-0000-4000-8000-000000000031";
    const frozenRequest = api.freezeVerificationResultRequest({
      verificationId: verification.id,
      expectedVersion: verification.version,
      resultSummary: "Verified against the expected behavior",
      clientSubmissionId,
      status: "passed",
      attachmentIds: [],
      captureBundleId: null,
    });
    const pendingResult = {
      ...frozenRequest,
      projectId,
      actorId,
      bugId,
      repairAttemptId: attempt.id,
      draftKey,
    };
    const initialDraft: AppDraft = {
      ...selectedDraft,
      returnDrafts: {
        [draftKey]: {
          reason: frozenRequest.resultSummary,
          files: [],
          clientSubmissionId,
          captureBundleId: null,
          uploads: {},
          pendingResult,
        },
      },
    };
    vi.mocked(api.getBug).mockResolvedValue(completedBug);
    vi.mocked(api.getHumanWorkflow).mockResolvedValue({
      bugId,
      repairAttempt: attempt,
      buildRequirement: null,
      build: null,
      verification,
    });
    vi.mocked(api.getVerification).mockResolvedValue(verification);
    vi.mocked(api.recordFrozenVerificationResult).mockResolvedValue({
      clientSubmissionId,
      qaItem: { type: "bug", id: bugId, key: completedBug.key },
      verification: {
        ...verification,
        status: "passed",
        resultSummary: frozenRequest.resultSummary,
        version: verification.version + 1,
      },
      repairAttempt: attempt,
      bug: {
        ...completedBug,
        projectId: "30000000-0000-4000-8000-000000000099",
        state: "closed",
        version: completedBug.version + 1,
      },
      attachmentIds: [],
      captureBundleId: null,
      eventId: "90000000-0000-4000-8000-000000000031",
      replayed: false,
    });
    let cleared = false;
    const onDraftChange = vi.fn(async (draft: AppDraft) => {
      if (draft.returnDrafts[draftKey] === undefined) cleared = true;
    });

    const view = await mountWorkbench([], { initialDraft, onDraftChange });
    await vi.waitFor(() =>
      expect(view.root.findByProps({ className: "detail-key" })).toBeDefined(),
    );
    const retry = view.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "重新确认验收提交");
    expect(retry).toBeDefined();

    await act(async () => retry?.props.onClick());
    await vi.waitFor(() => expect(api.recordFrozenVerificationResult).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        view.root.findByProps({ className: "banner error-banner" }).children.join(""),
      ).toContain("验收状态暂时无法写入"),
    );
    expect(cleared).toBe(false);
    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        returnDrafts: expect.objectContaining({
          [draftKey]: expect.objectContaining({ pendingResult }),
        }),
      }),
    );
  });

  it("renews an expired binding in place before replaying a refreshed frozen result", async () => {
    const completedBug: api.BugDetail = {
      ...bug,
      state: "ready_for_verification",
      version: 4,
    };
    const attempt = repairAttempt({ status: "delivered", version: 4 });
    const verification: api.VerificationRecord = {
      id: "50000000-0000-4000-8000-000000000011",
      bugId,
      repairAttemptId: attempt.id,
      buildId: null,
      status: "in_progress",
      verifierId: actorId,
      criteriaSnapshot: completedBug.expectedBehavior,
      resultSummary: null,
      failureReason: null,
      blockedReason: null,
      version: 2,
    };
    const draftKey = `${bugId}:${attempt.id}`;
    const clientSubmissionId = "70000000-0000-4000-8000-000000000011";
    const clientAttachmentId = "60000000-0000-4000-8000-000000000011";
    const attachmentId = "60000000-0000-4000-8000-000000000012";
    const bindingId = "60000000-0000-4000-8000-000000000013";
    const file = new File([new Uint8Array([4, 5, 6])], "frozen-retry.png", {
      type: "image/png",
      lastModified: 2,
    });
    const frozenRequest = api.freezeVerificationResultRequest({
      verificationId: verification.id,
      expectedVersion: verification.version,
      resultSummary: "The original defect remains",
      clientSubmissionId,
      status: "failed",
      failureReason: "The original defect remains",
      attachmentIds: [attachmentId],
      captureBundleId: null,
    });
    const pendingResult = {
      ...frozenRequest,
      projectId,
      actorId,
      bugId,
      repairAttemptId: attempt.id,
      draftKey,
    };
    const checkpoint: api.UploadCheckpoint = {
      clientAttachmentId,
      sha256: "c".repeat(64),
      init: { sessionId: "upload-frozen-retry", chunkSize: 1024, version: 1 },
      nextChunk: 1,
      version: 3,
      finalized: { attachmentId, readyToBind: true, version: 3 },
      binding: {
        bindingId,
        attachmentId,
        projectId,
        clientSubmissionId,
        clientAttachmentId,
        leaseGeneration: 1,
        intent: "verification_result",
        targetQaItemId: bugId,
        status: "reserved",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        version: 4,
        replayed: false,
      },
      bound: true,
    };
    const initialDraft: AppDraft = {
      ...selectedDraft,
      returnDrafts: {
        [draftKey]: {
          reason: "The original defect remains",
          files: [file],
          clientSubmissionId,
          captureBundleId: null,
          uploads: {
            frozen: { checkpoint, updatedAt: Date.now() - 60_000 },
          },
          pendingResult,
        },
      },
    };
    vi.mocked(api.getBug).mockResolvedValue(completedBug);
    vi.mocked(api.getHumanWorkflow).mockResolvedValue({
      bugId,
      repairAttempt: attempt,
      buildRequirement: null,
      build: null,
      verification,
    });
    vi.mocked(api.getVerification)
      .mockResolvedValueOnce(verification)
      .mockResolvedValueOnce(verification)
      .mockResolvedValueOnce(verification)
      .mockResolvedValue({
        ...verification,
        status: "failed",
        resultSummary: "The original defect remains",
        failureReason: "The original defect remains",
        version: verification.version + 1,
      });
    const originalBinding = checkpoint.binding;
    if (originalBinding === undefined) throw new Error("Expired binding fixture is invalid");

    const renewalGate = deferred<undefined>();
    let renewedReceiptPersisted = false;
    let renewalPersistenceAttempts = 0;
    let clearedAfterReceipt = false;
    let resultPosted = false;
    const onDraftChange = vi.fn(async (draft: AppDraft) => {
      const returnDraft = draft.returnDrafts[draftKey];
      const persisted = returnDraft?.uploads?.frozen?.checkpoint.binding;
      if (persisted?.leaseGeneration === 2) {
        expect(returnDraft?.pendingResult?.requestBody).toBe(pendingResult.requestBody);
        renewalPersistenceAttempts += 1;
        if (renewalPersistenceAttempts === 1) {
          throw new TypeError("IndexedDB write interrupted");
        }
        await renewalGate.promise;
        renewedReceiptPersisted = true;
      }
      if (resultPosted && returnDraft === undefined) clearedAfterReceipt = true;
    });
    vi.mocked(api.refreshVerificationAttachmentBinding).mockImplementation(async (input) => {
      expect(api.getVerification).toHaveBeenCalledWith(verification.id, {
        bugId,
        repairAttemptId: attempt.id,
        verifierId: actorId,
      });
      expect(input.checkpoint).toEqual(checkpoint);
      const refreshed: api.UploadCheckpoint = {
        ...input.checkpoint,
        binding: {
          ...originalBinding,
          leaseGeneration: 2,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          version: 5,
          replayed: false,
        },
      };
      await input.saveCheckpoint?.(refreshed);
      return refreshed;
    });
    vi.mocked(api.recordFrozenVerificationResult).mockImplementation(async (frozen) => {
      expect(renewedReceiptPersisted).toBe(true);
      expect(frozen).toEqual(pendingResult);
      expect(frozen.requestBody).toBe(pendingResult.requestBody);
      resultPosted = true;
      return {
        clientSubmissionId,
        qaItem: { type: "bug", id: bugId, key: completedBug.key },
        verification: {
          ...verification,
          status: "failed",
          resultSummary: frozen.resultSummary,
          version: frozen.expectedVersion + 1,
        },
        repairAttempt: { ...attempt, status: "verification_failed", version: attempt.version + 1 },
        bug: { ...completedBug, state: "ready", version: completedBug.version + 1 },
        attachmentIds: [...frozen.attachmentIds],
        captureBundleId: frozen.captureBundleId,
        eventId: "90000000-0000-4000-8000-000000000014",
        replayed: true,
      };
    });

    const view = await mountWorkbench([], { initialDraft, onDraftChange });
    await vi.waitFor(() =>
      expect(view.root.findByProps({ className: "detail-key" })).toBeDefined(),
    );
    const retry = view.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "重新确认验收提交");
    expect(retry).toBeDefined();

    await act(async () => retry?.props.onClick());
    await vi.waitFor(() =>
      expect(api.refreshVerificationAttachmentBinding).toHaveBeenCalledTimes(2),
    );
    expect(renewalPersistenceAttempts).toBeGreaterThanOrEqual(2);
    expect(api.refreshVerificationAttachmentBinding).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ checkpoint }),
    );
    expect(api.recordFrozenVerificationResult).not.toHaveBeenCalled();
    await act(async () => renewalGate.resolve(undefined));
    await vi.waitFor(() => expect(api.recordFrozenVerificationResult).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(clearedAfterReceipt).toBe(true));
    expect(api.uploadVerificationAttachment).not.toHaveBeenCalled();
  });

  it("shows explicit end and replacement controls to an eligible developer", async () => {
    const activeBug: api.BugDetail = { ...bug, state: "in_progress", version: 2 };
    const attempt = repairAttempt();
    vi.mocked(api.listVisibleProjects).mockResolvedValue({
      snapshotSequence: 1,
      items: [
        {
          id: projectId,
          key: "DETAIL",
          name: "Detail fixture",
          active: true,
          roles: ["developer"],
        },
      ],
      nextCursor: null,
    });
    vi.mocked(api.listProjectMembers).mockResolvedValue({
      projectId,
      snapshotSequence: 1,
      items: [
        {
          userId: actorId,
          projectId,
          displayName: principal.displayName,
          roles: ["developer"],
          active: true,
        },
      ],
      nextCursor: null,
    });
    vi.mocked(api.getBug).mockResolvedValue(activeBug);
    vi.mocked(api.listBugRepairAttempts).mockResolvedValue([attempt]);
    vi.mocked(api.getHumanWorkflow).mockResolvedValue({
      bugId,
      repairAttempt: null,
      buildRequirement: null,
      build: null,
      verification: null,
    });

    const view = await mountWorkbench();
    await openFirstBug(view);

    const adjustment = view.root.findByProps({ className: "repair-adjustment" });
    expect(adjustment.findByType("summary").children).toEqual(["调整本轮处理"]);
    expect(adjustment.findAllByType("option").map((option) => option.children.join(""))).toEqual([
      "人工处理",
      "外部协作",
      "选择接手人",
      principal.displayName,
    ]);

    const buttons = adjustment.findAllByType("button");
    const end = buttons.find((button) => button.children.join("") === "结束本轮处理");
    const replace = buttons.find((button) => button.children.join("") === "更换后继续处理");
    expect(end?.props.disabled).toBe(true);
    expect(replace?.props.disabled).toBe(true);

    await act(async () => {
      adjustment.findByType("textarea").props.onChange({
        target: { value: "The current path cannot continue" },
      });
    });
    expect(end?.props.disabled).toBe(false);
    expect(replace?.props.disabled).toBe(false);
  });

  it("offers the same evidence input for pass, blocked, and failed verification", async () => {
    const completedBug: api.BugDetail = {
      ...bug,
      state: "ready_for_verification",
      version: 4,
    };
    const attempt = repairAttempt({
      status: "delivered",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      version: 4,
    });
    vi.mocked(api.getBug).mockResolvedValue(completedBug);
    vi.mocked(api.getHumanWorkflow).mockResolvedValue({
      bugId,
      repairAttempt: attempt,
      buildRequirement: null,
      build: null,
      verification: {
        id: "50000000-0000-4000-8000-000000000001",
        bugId,
        repairAttemptId: attempt.id,
        buildId: null,
        status: "in_progress",
        verifierId: actorId,
        criteriaSnapshot: completedBug.expectedBehavior,
        resultSummary: null,
        failureReason: null,
        blockedReason: null,
        version: 2,
      },
    });

    const view = await mountWorkbench();
    await openFirstBug(view);

    const evidence = view.root.findByProps({ "aria-label": "验收说明和证据" });
    const picker = evidence.findByProps({ "aria-label": "添加验收截图或拍照" });
    expect(picker.props.accept).toBe("image/png,image/jpeg,image/webp");
    expect(picker.props.capture).toBe("environment");
    expect(picker.props.multiple).toBe(true);

    const findAction = (label: string) =>
      view.root.findAllByType("button").find((button) => button.children.join("") === label);
    const passed = findAction("验收通过并关闭");
    const blocked = findAction("暂缓验收");
    const failed = findAction("验收不通过，打回待处理");
    expect(passed?.props.disabled).toBe(false);
    expect(blocked?.props.disabled).toBe(true);
    expect(failed?.props.disabled).toBe(true);

    await act(async () => {
      evidence
        .findByType("textarea")
        .props.onChange({ target: { value: "Device is unavailable" } });
    });
    expect(blocked?.props.disabled).toBe(false);
    expect(failed?.props.disabled).toBe(false);
  });
});
