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
  getBug: vi.fn(),
  getHumanWorkflow: vi.fn(),
  listBugAttachments: vi.fn(),
  listBugComments: vi.fn(),
  listBugEvents: vi.fn(),
  listBugs: vi.fn(),
  listProjectMembers: vi.fn(),
  listProjectModules: vi.fn(),
  listVisibleProjects: vi.fn(),
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
  vi.mocked(api.listBugs).mockResolvedValue({
    snapshotSequence: 1,
    items: [bug],
    nextCursor: null,
  });
  vi.mocked(api.listBugEvents).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(api.listBugAttachments).mockResolvedValue({
    projectId,
    bugId,
    snapshotSequence: 1,
    items: [],
    nextCursor: null,
  });
  vi.mocked(api.listBugComments).mockResolvedValue({ items: [] });
  vi.mocked(api.listProjectModules).mockResolvedValue({ projectId, items: [] });
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

async function mountWorkbench(commits: string[] = []) {
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
          signingOut={false}
          onSignOut={() => undefined}
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
