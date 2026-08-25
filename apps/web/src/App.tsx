import { useCallback, useEffect, useState } from "react";

import { listBugs, QaHubApiError, type BugListItem } from "./api";
import { product } from "./product";

const DEFAULT_PROJECT_ID =
  import.meta.env.VITE_QA_HUB_PROJECT_ID ?? "10000000-0000-4000-8000-000000000004";
const INVALID_PROJECT_ID = "10000000-0000-4000-8000-000000000099";

function BrandMark() {
  return (
    <svg aria-hidden="true" className="brand-mark" viewBox="0 0 64 64">
      <circle cx="29" cy="28" fill="none" r="16" stroke="currentColor" strokeWidth="6" />
      <path
        d="M40 40l10 10"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="6"
      />
      <path
        className="brand-mark__check"
        d="M21 29l6 6 14-15"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="5"
      />
    </svg>
  );
}

type RequestState = "idle" | "loading" | "success" | "error";

export default function App() {
  const [projectId, setProjectId] = useState(DEFAULT_PROJECT_ID);
  const [bugs, setBugs] = useState<readonly BugListItem[]>([]);
  const [snapshotSequence, setSnapshotSequence] = useState<number | null>(null);
  const [requestState, setRequestState] = useState<RequestState>("idle");
  const [error, setError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);

  const loadBugList = useCallback(async (nextProjectId: string): Promise<void> => {
    const normalizedProjectId = nextProjectId.trim();
    setProjectId(normalizedProjectId);
    setRequestState("loading");
    setError(null);
    try {
      const response = await listBugs(normalizedProjectId);
      setBugs(response.items);
      setSnapshotSequence(response.snapshotSequence);
      setRequestState("success");
    } catch (cause: unknown) {
      setBugs([]);
      setSnapshotSequence(null);
      setRequestState("error");
      if (cause instanceof QaHubApiError) {
        setError({ status: cause.status, code: cause.code });
      } else {
        setError({ status: 0, code: "NETWORK_ERROR" });
      }
    }
  }, []);

  useEffect(() => {
    void loadBugList(DEFAULT_PROJECT_ID);
  }, [loadBugList]);

  return (
    <main className="app-shell">
      <header className="hero">
        <div className="brand-row">
          <span className="brand-icon">
            <BrandMark />
          </span>
          <div>
            <p className="eyebrow">桌面管理平台 · 独立 QA 事实源</p>
            <h1>{product.name}</h1>
          </div>
        </div>
        <p className="hero__summary">
          Bug、证据、交付与人工验收全部由 QA Hub API/DB 统一保存；Relay 只是可选执行器。
        </p>
        <span className="skeleton-badge">Web 管理台 · 真实 API</span>
      </header>

      <section aria-labelledby="boundary-title" className="boundary-card">
        <div>
          <p className="card-kicker">产品边界</p>
          <h2 id="boundary-title">Relay（可选执行器）</h2>
        </div>
        <p>Relay 只可标记修复交付、待构建或待验收，不能验收或关闭 QA Bug。</p>
      </section>

      <section aria-labelledby="bug-list-title" className="workspace-card">
        <div className="section-heading">
          <div>
            <p className="card-kicker">真实 QA Hub API</p>
            <h2 id="bug-list-title">Bug 列表</h2>
          </div>
          <span className={`status-dot status-dot--${requestState}`}>
            {requestState === "loading" ? "读取中" : requestState === "error" ? "API 错误" : "已连接"}
          </span>
        </div>

        <form
          className="project-form"
          onSubmit={(event) => {
            event.preventDefault();
            void loadBugList(projectId);
          }}
        >
          <label htmlFor="project-id">项目 ID</label>
          <div className="project-form__controls">
            <input
              id="project-id"
              onChange={(event) => setProjectId(event.target.value)}
              spellCheck={false}
              value={projectId}
            />
            <button className="primary-button" disabled={requestState === "loading"} type="submit">
              读取 Bug
            </button>
          </div>
          <button
            className="link-button"
            onClick={() => void loadBugList(INVALID_PROJECT_ID)}
            type="button"
          >
            验证无效项目错误
          </button>
        </form>

        {requestState === "error" && error !== null && (
          <p aria-live="assertive" className="api-error">
            API 请求失败：HTTP {error.status === 0 ? "网络不可达" : error.status}
            {error.code === null ? "" : ` · ${error.code}`}。项目权限或参数错误会保留在此处，不会伪造为空列表。
          </p>
        )}

        {requestState === "success" && bugs.length === 0 && (
          <p className="empty-state">该项目当前没有符合条件的 Bug（snapshot {snapshotSequence}）。</p>
        )}

        {bugs.length > 0 && (
          <div aria-label="真实 Bug 列表" className="bug-list" role="list">
            {bugs.map((bug) => (
              <article className="bug-row" key={bug.id} role="listitem">
                <div className="bug-row__heading">
                  <strong>{bug.key}</strong>
                  <span className="bug-state">{bug.state}</span>
                </div>
                <h3>{bug.title}</h3>
                <p>
                  {bug.severity} · {bug.priority} · 更新于 {new Date(bug.updatedAt).toLocaleString()}
                </p>
              </article>
            ))}
          </div>
        )}

        {requestState === "success" && snapshotSequence !== null && (
          <p className="api-footnote">来自 QA Hub SQLite 事实源 · snapshot {snapshotSequence}</p>
        )}

        <div aria-label="后续管理台切片" className="next-slices">
          <span>下一段：详情 / 证据 / 时间线 / 评论</span>
          <span>Relay 仍只通过 QA Hub 服务端接入</span>
        </div>
      </section>

      <footer>
        <span>版本 {product.appVersion}</span>
        <span aria-hidden="true">·</span>
        <span>Contract {product.contractVersion}</span>
      </footer>
    </main>
  );
}
