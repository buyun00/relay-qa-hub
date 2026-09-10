import LocalDraftRecovery from "./LocalDraftRecovery";
import "./project.css";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import App, { type AppDraft, type PendingDesktopBugRoute } from "./App";
import DesktopUpdateNotice from "./DesktopUpdateNotice";
import ProjectManagementPage from "./ProjectManagementPage";
import type { DesktopBugRoute } from "./desktop";
import {
  getBrowserSession,
  listVisibleProjects,
  loginBrowserSession,
  loginGmSession,
  logoutBrowserSession,
  QaHubApiError,
  setBrowserCsrfToken,
  type BrowserSessionPrincipal,
} from "./api";
import { getProjectEntry } from "./project-api";
import {
  entryProjectId,
  invalidateProjectRequests,
  projectStorageKey,
  setActiveProject,
  setServiceIdentity,
} from "./project-context";
import { readProjectDraft, writeProjectDraft } from "./project-drafts";

function ProjectWorkspace({
  principal,
  projectId,
  signingOut,
  onSignOut,
  onProjectChange,
  desktopBugRoute,
  onDesktopBugRouteConsumed,
  projectDirectoryRevision,
}: {
  principal: BrowserSessionPrincipal;
  projectId: string;
  signingOut: boolean;
  onSignOut: () => void;
  onProjectChange: (id: string) => void;
  desktopBugRoute: PendingDesktopBugRoute | null;
  onDesktopBugRouteConsumed: (sequence: number) => void;
  projectDirectoryRevision: number;
}) {
  const [loaded, setLoaded] = useState(false);
  const [denied, setDenied] = useState(false);
  const latestDraft = useRef<AppDraft | undefined>(undefined);
  useEffect(() => {
    const handle = (event: Event) => {
      if ((event as CustomEvent<string>).detail === projectId) {
        invalidateProjectRequests();
        setDenied(true);
      }
    };
    window.addEventListener("qa-hub:project-access-denied", handle);
    return () => window.removeEventListener("qa-hub:project-access-denied", handle);
  }, [projectId]);
  const [draft, setDraft] = useState<AppDraft | undefined>();
  const [draftError, setDraftError] = useState("");
  const draftKey = projectStorageKey("bug-drafts", projectId, principal.userId);
  const draftWriteQueue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let active = true;
    void readProjectDraft<AppDraft>(draftKey)
      .then((value) => {
        if (active) {
          setDraft(value);
          latestDraft.current = value;
        }
      })
      .catch(() => {
        if (active) setDraftError("本地草稿存储暂不可用，请保持窗口打开并保存未提交的文件。");
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [draftKey]);
  const saveDraft = useCallback(
    (value: AppDraft): Promise<void> => {
      latestDraft.current = value;
      const write = draftWriteQueue.current.then(() => writeProjectDraft(draftKey, value));
      draftWriteQueue.current = write.catch(() => undefined);
      return write.catch((cause: unknown) => {
        setDraftError("本地保存失败；当前窗口保留输入，请保存文件后再关闭。");
        throw cause;
      });
    },
    [draftKey],
  );
  if (!loaded) return <main className="auth-status">正在恢复此项目的本地草稿…</main>;
  if (denied)
    return (
      <main className="project-management-page">
        <h1>当前项目访问已停用</h1>
        <p>请联系 GM 或项目人员恢复资格。</p>
        <LocalDraftRecovery draft={latestDraft.current} projectId={projectId} />
        <button className="secondary-button" onClick={onSignOut}>
          返回登录
        </button>
      </main>
    );
  return (
    <>
      {draftError && (
        <div className="banner error-banner" role="status">
          {draftError}
        </div>
      )}
      <App
        principal={principal}
        projectId={projectId}
        signingOut={signingOut}
        onSignOut={onSignOut}
        onProjectChange={onProjectChange}
        initialDraft={draft}
        onDraftChange={saveDraft}
        desktopBugRoute={desktopBugRoute}
        onDesktopBugRouteConsumed={onDesktopBugRouteConsumed}
        projectDirectoryRevision={projectDirectoryRevision}
      />
    </>
  );
}

interface QueuedDesktopBugRoute {
  readonly sequence: number;
  readonly route: DesktopBugRoute;
}

export default function AuthGate() {
  const authRevision = useRef(0);
  const entryRevision = useRef(0);
  const desktopBugRouteSequence = useRef(0);
  const [state, setState] = useState<"checking" | "signed-out" | "signed-in" | "unavailable">(
    "checking",
  );
  const [principal, setPrincipal] = useState<BrowserSessionPrincipal | null>(null);
  const [projectId, setProjectId] = useState(entryProjectId);
  const [projectInput, setProjectInput] = useState(entryProjectId);
  const [projectName, setProjectName] = useState("");
  const [name, setName] = useState("");
  const [gm, setGm] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [queuedDesktopBugRoute, setQueuedDesktopBugRoute] = useState<QueuedDesktopBugRoute | null>(
    null,
  );
  const [pendingDesktopBugRoute, setPendingDesktopBugRoute] =
    useState<PendingDesktopBugRoute | null>(null);
  const [desktopBugRouteMessage, setDesktopBugRouteMessage] = useState("");
  const [projectDirectoryRevision, setProjectDirectoryRevision] = useState(0);
  const selectProject = useCallback(
    (id: string) => {
      setActiveProject(id, principal?.userId ?? "");
      setProjectId(id);
      setProjectInput(id);
      const url = new URL(location.href);
      if (id) url.searchParams.set("projectId", id);
      else url.searchParams.delete("projectId");
      history.replaceState(null, "", url);
    },
    [principal?.userId],
  );
  useEffect(() => {
    const bridge = window.qaHubDesktop;
    if (bridge === undefined) return;
    return bridge.onOpenBug((route) => {
      setQueuedDesktopBugRoute({
        sequence: ++desktopBugRouteSequence.current,
        route,
      });
    });
  }, []);
  const consumeDesktopBugRoute = useCallback((sequence: number) => {
    setPendingDesktopBugRoute((current) => (current?.sequence === sequence ? null : current));
  }, []);
  useEffect(() => {
    if (
      queuedDesktopBugRoute === null ||
      state !== "signed-in" ||
      principal === null ||
      !projectId
    ) {
      return;
    }
    const request = queuedDesktopBugRoute;
    let active = true;
    const clearRequest = () => {
      setQueuedDesktopBugRoute((current) =>
        current?.sequence === request.sequence ? null : current,
      );
    };
    const rejectRoute = (reason: string) => {
      setDesktopBugRouteMessage(reason);
      setProjectDirectoryRevision((value) => value + 1);
      clearRequest();
    };
    void listVisibleProjects()
      .then((available) => {
        if (!active) return;
        const { route } = request;
        const isLegacyRoute = route.projectId === null && route.userId === null;
        const isScopedRoute = route.projectId !== null && route.userId !== null;
        if (!isLegacyRoute && !isScopedRoute) {
          rejectRoute("通知路由无效，已保持当前项目并刷新项目列表。");
          return;
        }
        const currentProjectVisible = available.items.some(
          (project) => project.id.toLowerCase() === projectId.toLowerCase(),
        );
        if (!currentProjectVisible) {
          const fallback = available.items[0];
          setProjectDirectoryRevision((value) => value + 1);
          clearRequest();
          setPendingDesktopBugRoute(null);
          if (fallback !== undefined) {
            setDesktopBugRouteMessage("当前项目已不可访问，已切换到仍可访问的项目并刷新项目列表。");
            selectProject(fallback.id);
          } else {
            invalidateProjectRequests();
            setBrowserCsrfToken(null);
            setActiveProject(projectId, "");
            setDesktopBugRouteMessage("");
            setMessage("当前项目访问已停用，请联系 GM 或项目人员恢复资格。");
            setName(principal.displayName);
            setPrincipal(null);
            setState("signed-out");
          }
          return;
        }
        if (!isLegacyRoute && route.userId?.toLowerCase() !== principal.userId.toLowerCase()) {
          rejectRoute("这条通知不属于当前登录人员，已保持当前项目并刷新项目列表。");
          return;
        }
        const targetProjectId = route.projectId ?? projectId;
        if (
          !available.items.some(
            (project) => project.id.toLowerCase() === targetProjectId.toLowerCase(),
          )
        ) {
          rejectRoute("通知所属项目当前不可访问，已保持当前项目并刷新项目列表。");
          return;
        }
        setDesktopBugRouteMessage("");
        setPendingDesktopBugRoute({
          sequence: request.sequence,
          projectId: targetProjectId,
          userId: principal.userId,
          bugId: route.bugId,
        });
        clearRequest();
        if (targetProjectId !== projectId) selectProject(targetProjectId);
      })
      .catch(() => {
        if (active) rejectRoute("暂时无法核对通知所属项目，已保持当前项目。");
      });
    return () => {
      active = false;
    };
  }, [principal, projectId, queuedDesktopBugRoute, selectProject, state]);
  const checkSession = async () => {
    const request = ++authRevision.current;
    setState("checking");
    setMessage("");
    try {
      const runtime = await window.qaHubDesktop?.getRuntimeInfo();
      if (request !== authRevision.current) return;
      if (runtime?.apiBaseUrl) {
        setEndpoint(runtime.apiBaseUrl);
        setServiceIdentity(runtime.apiBaseUrl);
      }
      const entry = entryProjectId();
      setActiveProject(entry);
      setProjectInput(entry);
      const current = await getBrowserSession();
      if (request !== authRevision.current) return;
      const available = await listVisibleProjects();
      if (request !== authRevision.current) return;
      const chosen =
        entry ||
        current.projectId ||
        (available.items.length === 1 ? (available.items[0]?.id ?? "") : "");
      if (!current.isGm && (!chosen || !available.items.some((project) => project.id === chosen))) {
        setName(current.displayName);
        setPrincipal(null);
        setState("signed-out");
        return;
      }
      setActiveProject(chosen, current.userId);
      setProjectId(chosen);
      setPrincipal(current);
      setState("signed-in");
    } catch (cause) {
      if (request !== authRevision.current) return;
      setBrowserCsrfToken(null);
      setPrincipal(null);
      setState(
        cause instanceof QaHubApiError && [400, 401, 403, 404].includes(cause.status)
          ? "signed-out"
          : "unavailable",
      );
    }
  };
  useEffect(() => {
    void checkSession();
    const revisionRef = authRevision;
    return () => {
      revisionRef.current++;
    };
  }, []);
  const verifyEntry = useCallback(async () => {
    const request = ++entryRevision.current;
    if (!projectInput.trim()) return;
    try {
      const entry = await getProjectEntry(projectInput.trim());
      if (request !== entryRevision.current) return;
      setProjectId(entry.id);
      setProjectName(entry.name);
      setMessage("");
    } catch (cause) {
      if (request !== entryRevision.current) return;
      setProjectName("");
      setMessage(
        cause instanceof QaHubApiError && cause.status === 404
          ? "此项目入口不存在或已停用。"
          : "暂时无法读取项目入口。",
      );
    }
  }, [projectInput]);
  useEffect(() => {
    if (state !== "signed-out" || gm || !projectInput.trim()) return;
    const timer = setTimeout(() => void verifyEntry(), 250);
    return () => clearTimeout(timer);
  }, [state, gm, projectInput, verifyEntry]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      let id = projectId;
      if (!gm) {
        const entry = await getProjectEntry(projectInput.trim());
        id = entry.id;
        setProjectName(entry.name);
        setActiveProject(id);
      }
      const current = gm ? await loginGmSession(password) : await loginBrowserSession(name, id);
      setPassword("");
      setPrincipal(current);
      setActiveProject(gm ? "" : id, current.userId);
      setProjectId(gm ? "" : id);
      const url = new URL(location.href);
      if (gm) url.searchParams.delete("projectId");
      else url.searchParams.set("projectId", id);
      history.replaceState(null, "", url);
      setState("signed-in");
    } catch (cause) {
      setMessage(
        cause instanceof QaHubApiError &&
          ["PROJECT_MEMBERSHIP_DISABLED", "PROJECT_NOT_ACCESSIBLE"].includes(cause.code ?? "")
          ? "你在此项目的资格已停用，请联系 GM 或项目人员恢复。"
          : cause instanceof QaHubApiError
            ? `登录未完成：${cause.code ?? cause.status}`
            : "登录服务暂时不可用。",
      );
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    setBusy(true);
    try {
      await logoutBrowserSession();
      setActiveProject(projectId, "");
      setQueuedDesktopBugRoute(null);
      setPendingDesktopBugRoute(null);
      setDesktopBugRouteMessage("");
      setPrincipal(null);
      setState("signed-out");
      setName("");
    } catch {
      setMessage("退出失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };
  if (state === "checking") return <main className="auth-status">正在核对项目会话…</main>;
  if (state === "unavailable")
    return (
      <main className="auth-status">
        <h1>QA Hub 暂时无法连接</h1>
        <p>请检查独立预览服务是否正在运行。</p>
        {endpoint && (
          <p>
            服务地址：<code>{endpoint}</code>
          </p>
        )}
        <button onClick={() => void checkSession()}>重试</button>
      </main>
    );
  if (state === "signed-out" || !principal)
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-labelledby="login-title">
          <p className="eyebrow">QA Hub · 项目预览</p>
          <h1 id="login-title">
            {gm ? "GM 管理登录" : projectName ? `进入 ${projectName}` : "进入项目"}
          </h1>
          <p>
            {gm
              ? "使用服务端配置的唯一 GM 管理口令。"
              : "从项目入口填写姓名；首次登录仅登记到此项目。"}
          </p>
          <form className="auth-form" onSubmit={(event) => void submit(event)}>
            {gm ? (
              <>
                <label htmlFor="gm-password">管理口令</label>
                <input
                  id="gm-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </>
            ) : (
              <>
                <label htmlFor="login-project">项目 ID 或入口短码</label>
                <input
                  id="login-project"
                  value={projectInput}
                  onChange={(event) => {
                    entryRevision.current++;
                    setProjectInput(event.target.value);
                    setProjectName("");
                  }}
                  onBlur={() => void verifyEntry()}
                  placeholder="使用 GM 提供的项目入口"
                  required
                />
                <label htmlFor="login-name">姓名</label>
                <input
                  id="login-name"
                  autoComplete="off"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="输入姓名"
                  required
                />
              </>
            )}
            {message && (
              <p className="auth-error" role="alert">
                {message}
              </p>
            )}
            <button disabled={busy} type="submit">
              {busy ? "登录中…" : "登录"}
            </button>
          </form>
          <button
            className="project-login-mode"
            type="button"
            onClick={() => {
              setGm((value) => !value);
              setMessage("");
              setPassword("");
            }}
          >
            {gm ? "返回项目姓名登录" : "GM 管理入口"}
          </button>
        </section>
      </main>
    );
  if (principal.isGm && !projectId)
    return (
      <>
        <button className="project-gm-signout secondary-button" onClick={() => void signOut()}>
          退出 GM
        </button>
        <ProjectManagementPage projectId="" onSelectProject={selectProject} />
      </>
    );
  return (
    <>
      <DesktopUpdateNotice />
      {desktopBugRouteMessage && (
        <div className="banner error-banner" role="alert">
          {desktopBugRouteMessage}
        </div>
      )}
      <ProjectWorkspace
        key={projectStorageKey("workspace", projectId, principal.userId)}
        principal={principal}
        projectId={projectId}
        signingOut={busy}
        onSignOut={() => void signOut()}
        onProjectChange={selectProject}
        desktopBugRoute={pendingDesktopBugRoute}
        onDesktopBugRouteConsumed={consumeDesktopBugRoute}
        projectDirectoryRevision={projectDirectoryRevision}
      />
    </>
  );
}
