import { act, useEffect, useRef } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AuthGate from "./AuthGate";
import * as api from "./api";
import type { DesktopBugRoute } from "./desktop";
import * as projectContext from "./project-context";
import * as projectApi from "./project-api";
import { readProjectDraft } from "./project-drafts";

const appRender = vi.hoisted(() => vi.fn());
const appMount = vi.hoisted(() => vi.fn());
const appOpenBug = vi.hoisted(() => vi.fn());

vi.mock("./App", async () => {
  interface StubRoute {
    readonly sequence: number;
    readonly projectId: string;
    readonly userId: string;
    readonly bugId: string;
  }
  interface StubProps {
    readonly projectId: string;
    readonly principal: { readonly userId: string };
    readonly desktopBugRoute?: StubRoute | null;
    readonly onDesktopBugRouteConsumed?: (sequence: number) => void;
    readonly projectDirectoryRevision?: number;
  }
  return {
    default: function AppStub(props: StubProps) {
      const consumed = useRef<number | null>(null);
      const initialProjectId = useRef(props.projectId).current;
      const route = props.desktopBugRoute;
      const consumeRoute = props.onDesktopBugRouteConsumed;
      const principalUserId = props.principal.userId;
      const projectId = props.projectId;
      appRender(props);
      useEffect(() => {
        appMount(initialProjectId);
      }, [initialProjectId]);
      useEffect(() => {
        if (
          route === null ||
          route === undefined ||
          route.projectId !== projectId ||
          route.userId !== principalUserId ||
          consumed.current === route.sequence
        ) {
          return;
        }
        consumed.current = route.sequence;
        appOpenBug({ projectId, route });
        consumeRoute?.(route.sequence);
      }, [consumeRoute, principalUserId, projectId, route]);
      return <div data-project-id={props.projectId} />;
    },
  };
});
vi.mock("./DesktopUpdateNotice", () => ({ default: () => null }));
vi.mock("./LocalDraftRecovery", () => ({ default: () => null }));
vi.mock("./ProjectManagementPage", () => ({ default: () => null }));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  getBrowserSession: vi.fn(),
  listVisibleProjects: vi.fn(),
  loginBrowserSession: vi.fn(),
  loginGmSession: vi.fn(),
  logoutBrowserSession: vi.fn(),
  setBrowserCsrfToken: vi.fn(),
}));
vi.mock("./project-api", () => ({
  completeProjectInitialization: vi.fn(),
  getProjectEntry: vi.fn(),
  inspectProjectInitialization: vi.fn(),
}));
vi.mock("./project-context", () => ({
  entryProjectId: vi.fn(() => "30000000-0000-4000-8000-000000000001"),
  invalidateProjectRequests: vi.fn(),
  projectStorageKey: vi.fn(
    (prefix: string, projectId: string, userId = "") => `${prefix}:${projectId}:${userId}`,
  ),
  setActiveProject: vi.fn(),
  setServiceIdentity: vi.fn(),
}));
vi.mock("./project-drafts", () => ({
  readProjectDraft: vi.fn(),
  writeProjectDraft: vi.fn(async () => undefined),
}));

const PROJECT_A = "30000000-0000-4000-8000-000000000001";
const PROJECT_B = "30000000-0000-4000-8000-000000000002";
const USER_ID = "10000000-0000-4000-8000-000000000003";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000004";
const BUG_ID = "20000000-0000-4000-8000-000000000001";
const principal: api.BrowserSessionPrincipal = {
  accountId: "10000000-0000-4000-8000-000000000001",
  userId: USER_ID,
  email: "desktop-route@qa.local",
  displayName: "Desktop route fixture",
  csrfToken: "desktop-route-csrf",
};

let renderer: ReactTestRenderer | undefined;
let openBug: ((route: DesktopBugRoute) => void) | undefined;

function projects(...ids: string[]) {
  return {
    snapshotSequence: 1,
    items: ids.map((id, index) => ({
      id,
      key: `ROUTE-${index + 1}`,
      name: `Route project ${index + 1}`,
      active: true as const,
      roles: [],
    })),
    nextCursor: null,
  };
}

async function mountAuthGate() {
  await act(async () => {
    renderer = create(<AuthGate />);
  });
  await vi.waitFor(() => expect(appMount).toHaveBeenCalledWith(PROJECT_A));
  if (renderer === undefined || openBug === undefined) throw new Error("AuthGate did not mount");
  return renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const events = new EventTarget();
  openBug = undefined;
  vi.stubGlobal("window", {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    qaHubDesktop: {
      getRuntimeInfo: vi.fn(async () => ({ apiBaseUrl: "http://127.0.0.1:4639" })),
      onOpenBug: vi.fn((listener: (route: DesktopBugRoute) => void) => {
        openBug = listener;
        return () => undefined;
      }),
    },
  });
  vi.stubGlobal("location", { href: `http://127.0.0.1:4640/?projectId=${PROJECT_A}` });
  vi.stubGlobal("history", { replaceState: vi.fn() });
  vi.mocked(api.getBrowserSession).mockResolvedValue(principal);
  vi.mocked(api.listVisibleProjects).mockResolvedValue(projects(PROJECT_A, PROJECT_B));
  vi.mocked(readProjectDraft).mockResolvedValue(undefined);
});

afterEach(async () => {
  if (renderer !== undefined) await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("AuthGate desktop Bug routing", () => {
  it("renders the one-use initialization page from a URL fragment without checking a session", async () => {
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:4640/#initialize=token-value",
      hash: "#initialize=token-value",
      pathname: "/",
      search: "",
    });
    vi.mocked(projectApi.inspectProjectInitialization).mockResolvedValue({
      ...principal,
      id: PROJECT_A,
      key: "PROJECT-A",
      name: "待初始化项目",
      active: true,
      version: 1,
      initializationStatus: "pending",
      joinName: null,
      joinCode: "0042",
      initializationTokenStatus: "issued",
      initializationLink: "http://127.0.0.1:4640/#initialize=token-value",
    });
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(<AuthGate />);
    });
    await vi.waitFor(() =>
      expect(view.root.findByProps({ id: "initialization-project-name" })).toBeTruthy(),
    );
    expect(projectApi.inspectProjectInitialization).toHaveBeenCalledWith("token-value");
    expect(api.getBrowserSession).not.toHaveBeenCalled();
    view.unmount();
  });

  it("uses the project name and four-digit code directly without probing project-entry", async () => {
    vi.mocked(api.getBrowserSession).mockRejectedValue(
      new api.QaHubApiError(401, "UNAUTHENTICATED"),
    );
    vi.mocked(api.loginBrowserSession).mockResolvedValue({
      ...principal,
      projectId: PROJECT_A,
    });
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(<AuthGate />);
    });
    await vi.waitFor(() => expect(view.root.findByProps({ id: "login-project" })).toBeTruthy());
    const projectInput = view.root.findByProps({ id: "login-project" });
    const codeInput = view.root.findByProps({ id: "login-code" });
    const nameInput = view.root.findByProps({ id: "login-name" });
    await act(async () => {
      projectInput.props.onChange({ target: { value: "Project A" } });
      codeInput.props.onChange({ target: { value: "0042" } });
      nameInput.props.onChange({ target: { value: "Employee" } });
    });
    const form = view.root.findByProps({ className: "auth-form" });
    await act(async () => {
      await form.props.onSubmit({ preventDefault: vi.fn() });
    });
    expect(api.loginBrowserSession).toHaveBeenCalledWith("Employee", "Project A", "0042");
    expect(projectApi.getProjectEntry).not.toHaveBeenCalled();
    view.unmount();
  });

  it("verifies visibility, switches project, remounts the keyed workspace, and consumes once", async () => {
    await mountAuthGate();
    expect(api.listVisibleProjects).toHaveBeenCalledTimes(1);

    await act(async () => {
      openBug?.({ projectId: PROJECT_B, userId: USER_ID, bugId: BUG_ID });
    });

    await vi.waitFor(() => expect(appOpenBug).toHaveBeenCalledTimes(1));
    expect(api.listVisibleProjects).toHaveBeenCalledTimes(2);
    expect(projectContext.setActiveProject).toHaveBeenCalledWith(PROJECT_B, USER_ID);
    expect(appMount).toHaveBeenCalledWith(PROJECT_B);
    expect(appOpenBug).toHaveBeenCalledWith({
      projectId: PROJECT_B,
      route: { sequence: 1, projectId: PROJECT_B, userId: USER_ID, bugId: BUG_ID },
    });
  });

  it("keeps the current project and refreshes the directory on identity mismatch", async () => {
    const view = await mountAuthGate();
    await act(async () => {
      openBug?.({ projectId: PROJECT_B, userId: OTHER_USER_ID, bugId: BUG_ID });
    });

    await vi.waitFor(() =>
      expect(view.root.findByProps({ role: "alert" }).children.join("")).toContain(
        "不属于当前登录人员",
      ),
    );
    expect(api.listVisibleProjects).toHaveBeenCalledTimes(2);
    expect(appOpenBug).not.toHaveBeenCalled();
    expect(projectContext.setActiveProject).not.toHaveBeenCalledWith(PROJECT_B, USER_ID);
    expect(appRender.mock.calls.at(-1)?.[0]).toMatchObject({
      projectId: PROJECT_A,
      projectDirectoryRevision: 1,
    });
  });

  it("keeps the current project and refreshes the directory after access is revoked", async () => {
    const view = await mountAuthGate();
    vi.mocked(api.listVisibleProjects).mockResolvedValueOnce(projects(PROJECT_A));
    await act(async () => {
      openBug?.({ projectId: PROJECT_B, userId: USER_ID, bugId: BUG_ID });
    });

    await vi.waitFor(() =>
      expect(view.root.findByProps({ role: "alert" }).children.join("")).toContain(
        "项目当前不可访问",
      ),
    );
    expect(api.listVisibleProjects).toHaveBeenCalledTimes(2);
    expect(appOpenBug).not.toHaveBeenCalled();
    expect(projectContext.setActiveProject).not.toHaveBeenCalledWith(PROJECT_B, USER_ID);
    expect(appRender.mock.calls.at(-1)?.[0]).toMatchObject({
      projectId: PROJECT_A,
      projectDirectoryRevision: 1,
    });
  });

  it("leaves a revoked current project without opening stale server data", async () => {
    const view = await mountAuthGate();
    vi.mocked(api.listVisibleProjects).mockResolvedValueOnce(projects(PROJECT_B));
    await act(async () => {
      openBug?.({ projectId: PROJECT_A, userId: USER_ID, bugId: BUG_ID });
    });

    await vi.waitFor(() => expect(appMount).toHaveBeenCalledWith(PROJECT_B));
    expect(view.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "当前项目已不可访问",
    );
    expect(projectContext.setActiveProject).toHaveBeenCalledWith(PROJECT_B, USER_ID);
    expect(appOpenBug).not.toHaveBeenCalled();
    expect(appRender.mock.calls.at(-1)?.[0]).toMatchObject({
      projectId: PROJECT_B,
      desktopBugRoute: null,
    });
  });

  it("keeps legacy null-scope deep links in the current project", async () => {
    await mountAuthGate();
    await act(async () => {
      openBug?.({ projectId: null, userId: null, bugId: BUG_ID });
    });

    await vi.waitFor(() => expect(appOpenBug).toHaveBeenCalledTimes(1));
    expect(api.listVisibleProjects).toHaveBeenCalledTimes(2);
    expect(appOpenBug).toHaveBeenCalledWith({
      projectId: PROJECT_A,
      route: { sequence: 1, projectId: PROJECT_A, userId: USER_ID, bugId: BUG_ID },
    });
    expect(projectContext.setActiveProject).not.toHaveBeenCalledWith(PROJECT_B, USER_ID);
  });
});
