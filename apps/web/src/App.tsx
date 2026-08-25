import { useCallback, useEffect, useState } from "react";

import {
  addBugComment,
  getBug,
  listBugEvents,
  listBugs,
  QaHubApiError,
  transitionBugReady,
  updateBugOwner,
  type BugDetail,
  type BugEvent,
  type BugListItem,
} from "./api";
import { product } from "./product";

const DEFAULT_PROJECT_ID =
  import.meta.env.VITE_QA_HUB_PROJECT_ID ?? "10000000-0000-4000-8000-000000000004";
const INVALID_PROJECT_ID = "10000000-0000-4000-8000-000000000099";
const MISSING_BUG_ID = "20000000-0000-4000-8000-000000000099";
const MVP_OWNER_ID = "10000000-0000-4000-8000-000000000003";

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
type MutationState = "idle" | "submitting" | "success" | "error";

function mutationError(cause: unknown): { readonly status: number; readonly code: string | null } {
  if (cause instanceof QaHubApiError) return { status: cause.status, code: cause.code };
  return { status: 0, code: "NETWORK_ERROR" };
}

function mutationErrorMessage(error: { readonly status: number; readonly code: string | null }) {
  if (error.code === "VERSION_CONFLICT" || error.status === 412) {
    return "版本冲突：Bug 已被其他操作更新，请重新读取后再提交。";
  }
  return `请求失败：HTTP ${error.status === 0 ? "网络不可达" : error.status}${
    error.code === null ? "" : ` · ${error.code}`
  }。`;
}

export default function App() {
  const [projectId, setProjectId] = useState(DEFAULT_PROJECT_ID);
  const [bugs, setBugs] = useState<readonly BugListItem[]>([]);
  const [snapshotSequence, setSnapshotSequence] = useState<number | null>(null);
  const [requestState, setRequestState] = useState<RequestState>("idle");
  const [error, setError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [selectedBugId, setSelectedBugId] = useState<string | null>(null);
  const [selectedBug, setSelectedBug] = useState<BugDetail | null>(null);
  const [timeline, setTimeline] = useState<readonly BugEvent[]>([]);
  const [detailState, setDetailState] = useState<RequestState>("idle");
  const [detailError, setDetailError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [commentState, setCommentState] = useState<"idle" | "submitting" | "success" | "error">(
    "idle",
  );
  const [commentId, setCommentId] = useState<string | null>(null);
  const [commentError, setCommentError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [ownerSelection, setOwnerSelection] = useState("");
  const [assignmentState, setAssignmentState] = useState<MutationState>("idle");
  const [assignmentError, setAssignmentError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [transitionState, setTransitionState] = useState<MutationState>("idle");
  const [transitionError, setTransitionError] = useState<{
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

  const loadBugDetails = useCallback(
    async (
      bugId: string,
      preserveComment = false,
    ): Promise<{ readonly bug: BugDetail; readonly events: readonly BugEvent[] } | null> => {
      setSelectedBugId(bugId);
      setSelectedBug(null);
      setTimeline([]);
      setDetailState("loading");
      setDetailError(null);
      if (!preserveComment) {
        setCommentId(null);
        setCommentState("idle");
        setCommentError(null);
      }
      try {
        const [bug, events] = await Promise.all([getBug(bugId), listBugEvents(bugId)]);
        setSelectedBug(bug);
        setOwnerSelection(bug.ownerId ?? "");
        setTimeline(events.items);
        setDetailState("success");
        return { bug, events: events.items };
      } catch (cause: unknown) {
        setDetailState("error");
        if (cause instanceof QaHubApiError) {
          setDetailError({ status: cause.status, code: cause.code });
        } else {
          setDetailError({ status: 0, code: "NETWORK_ERROR" });
        }
        return null;
      }
    },
    [],
  );

  const assignOwner = useCallback(async (): Promise<void> => {
    if (selectedBug === null) return;
    const nextOwnerId = ownerSelection.length === 0 ? null : ownerSelection;
    setAssignmentState("submitting");
    setAssignmentError(null);
    try {
      await updateBugOwner(selectedBug.id, selectedBug.version, nextOwnerId);
      const refreshed = await loadBugDetails(selectedBug.id, true);
      if (refreshed?.bug.ownerId === nextOwnerId) {
        setAssignmentState("success");
      } else {
        setAssignmentState("error");
        setAssignmentError({ status: 200, code: "OWNER_READBACK_MISMATCH" });
      }
    } catch (cause: unknown) {
      setAssignmentState("error");
      setAssignmentError(mutationError(cause));
    }
  }, [loadBugDetails, ownerSelection, selectedBug]);

  const markReady = useCallback(async (): Promise<void> => {
    if (selectedBug === null || selectedBug.state !== "reported") return;
    setTransitionState("submitting");
    setTransitionError(null);
    try {
      await transitionBugReady(selectedBug.id, selectedBug.version);
      const refreshed = await loadBugDetails(selectedBug.id, true);
      if (refreshed?.bug.state === "ready") {
        setTransitionState("success");
      } else {
        setTransitionState("error");
        setTransitionError({ status: 200, code: "STATE_READBACK_MISMATCH" });
      }
    } catch (cause: unknown) {
      setTransitionState("error");
      setTransitionError(mutationError(cause));
    }
  }, [loadBugDetails, selectedBug]);

  const submitComment = useCallback(async (): Promise<void> => {
    if (selectedBugId === null || commentBody.trim().length === 0) return;
    const clientSubmissionId = globalThis.crypto.randomUUID();
    setCommentState("submitting");
    setCommentError(null);
    try {
      const result = await addBugComment(selectedBugId, commentBody.trim(), clientSubmissionId);
      setCommentBody("");
      setCommentId(result.comment.id);
      const refreshed = await loadBugDetails(selectedBugId, true);
      const eventConfirmed =
        refreshed?.events.some(
          (event) =>
            event.type === "comment.created" && event.payload.commentId === result.comment.id,
        ) === true;
      if (eventConfirmed) {
        setCommentState("success");
      } else {
        setCommentState("error");
        setCommentError({ status: 200, code: "COMMENT_EVENT_MISSING" });
      }
    } catch (cause: unknown) {
      setCommentState("error");
      if (cause instanceof QaHubApiError) {
        setCommentError({ status: cause.status, code: cause.code });
      } else {
        setCommentError({ status: 0, code: "NETWORK_ERROR" });
      }
    }
  }, [commentBody, loadBugDetails, selectedBugId]);

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
            {requestState === "loading"
              ? "读取中"
              : requestState === "error"
                ? "API 错误"
                : "已连接"}
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
            {error.code === null ? "" : ` · ${error.code}`}
            。项目权限或参数错误会保留在此处，不会伪造为空列表。
          </p>
        )}

        {requestState === "success" && bugs.length === 0 && (
          <p className="empty-state">
            该项目当前没有符合条件的 Bug（snapshot {snapshotSequence}）。
          </p>
        )}

        {bugs.length > 0 && (
          <div aria-label="真实 Bug 列表" className="bug-list" role="list">
            {bugs.map((bug) => (
              <button
                className={`bug-row${selectedBugId === bug.id ? " bug-row--selected" : ""}`}
                key={bug.id}
                onClick={() => void loadBugDetails(bug.id)}
                type="button"
              >
                <div className="bug-row__heading">
                  <strong>{bug.key}</strong>
                  <span className="bug-state">{bug.state}</span>
                </div>
                <h3>{bug.title}</h3>
                <p>
                  {bug.severity} · {bug.priority} · 更新于{" "}
                  {new Date(bug.updatedAt).toLocaleString()}
                </p>
              </button>
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

      <section aria-labelledby="bug-detail-title" className="workspace-card detail-card">
        <div className="section-heading">
          <div>
            <p className="card-kicker">Bug / audit</p>
            <h2 id="bug-detail-title">详情与时间线</h2>
          </div>
          <span className={`status-dot status-dot--${detailState}`}>
            {detailState === "loading"
              ? "读取中"
              : detailState === "error"
                ? "NOT_FOUND / API 错误"
                : "可选"}
          </span>
        </div>

        <button
          className="link-button detail-card__missing"
          onClick={() => void loadBugDetails(MISSING_BUG_ID)}
          type="button"
        >
          验证不存在 Bug（应显示 404 NOT_FOUND）
        </button>

        {detailState === "error" && detailError !== null && (
          <p aria-live="assertive" className="api-error">
            Bug 详情/时间线请求失败：HTTP{" "}
            {detailError.status === 0 ? "网络不可达" : detailError.status}
            {detailError.code === null ? "" : ` · ${detailError.code}`}。
          </p>
        )}

        {selectedBug !== null && detailState === "success" && (
          <>
            <article className="bug-detail">
              <div className="bug-row__heading">
                <strong>{selectedBug.key}</strong>
                <span className="bug-state">{selectedBug.state}</span>
              </div>
              <h3>{selectedBug.title}</h3>
              <dl className="bug-detail__facts">
                <div>
                  <dt>描述</dt>
                  <dd>{selectedBug.description}</dd>
                </div>
                <div>
                  <dt>预期行为</dt>
                  <dd>{selectedBug.expectedBehavior}</dd>
                </div>
                <div>
                  <dt>负责人</dt>
                  <dd>{selectedBug.ownerId ?? "未分配"}</dd>
                </div>
                <div>
                  <dt>版本</dt>
                  <dd>v{selectedBug.version}</dd>
                </div>
              </dl>
              <div aria-label="Bug 管理操作" className="bug-actions">
                <div className="bug-action">
                  <label htmlFor="bug-owner">负责人</label>
                  <div className="bug-action__controls">
                    <select
                      id="bug-owner"
                      onChange={(event) => setOwnerSelection(event.target.value)}
                      value={ownerSelection}
                    >
                      <option value="">未分配</option>
                      <option value={MVP_OWNER_ID}>QA 值班成员（MVP）</option>
                    </select>
                    <button
                      className="secondary-button"
                      disabled={assignmentState === "submitting"}
                      onClick={() => void assignOwner()}
                      type="button"
                    >
                      {assignmentState === "submitting" ? "保存中" : "保存负责人"}
                    </button>
                  </div>
                  <small>使用当前版本 v{selectedBug.version} 乐观锁提交</small>
                </div>
                <div className="bug-action">
                  <span className="bug-action__label">状态</span>
                  <div className="bug-action__controls">
                    <button
                      className="secondary-button"
                      disabled={
                        transitionState === "submitting" || selectedBug.state !== "reported"
                      }
                      onClick={() => void markReady()}
                      type="button"
                    >
                      {transitionState === "submitting" ? "更新中" : "标记为 ready"}
                    </button>
                    <span className="bug-action__hint">
                      {selectedBug.state === "reported"
                        ? "reported → ready"
                        : `当前为 ${selectedBug.state}`}
                    </span>
                  </div>
                </div>
              </div>
              {assignmentState === "success" && (
                <p aria-live="polite" className="success-note">
                  负责人已保存，并已 GET 回读版本/负责人。
                </p>
              )}
              {assignmentState === "error" && assignmentError !== null && (
                <p aria-live="assertive" className="api-error">
                  负责人更新失败：{mutationErrorMessage(assignmentError)}
                </p>
              )}
              {transitionState === "success" && (
                <p aria-live="polite" className="success-note">
                  状态已更新为 ready，并已 GET 回读版本/状态。
                </p>
              )}
              {transitionState === "error" && transitionError !== null && (
                <p aria-live="assertive" className="api-error">
                  状态更新失败：{mutationErrorMessage(transitionError)}
                </p>
              )}
            </article>

            <div className="timeline-block">
              <div className="subsection-heading">
                <h3>审计时间线</h3>
                <span>{timeline.length} 条 / limit 20</span>
              </div>
              {timeline.length === 0 ? (
                <p className="empty-state">当前 Bug 暂无时间线事件。</p>
              ) : (
                <ol className="timeline-list">
                  {timeline.map((event) => (
                    <li key={event.id}>
                      <div className="timeline-list__heading">
                        <strong>{event.type}</strong>
                        <span>#{event.sequence}</span>
                      </div>
                      <p>
                        aggregate={event.aggregate.type}:{event.aggregate.id.slice(0, 8)} ·{" "}
                        {new Date(event.occurredAt).toLocaleString()}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <form
              className="comment-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitComment();
              }}
            >
              <label htmlFor="comment-body">追加评论</label>
              <textarea
                id="comment-body"
                onChange={(event) => setCommentBody(event.target.value)}
                placeholder="写下可审计的处理备注"
                rows={3}
                value={commentBody}
              />
              <div className="comment-form__footer">
                <span>使用 clientSubmissionId + 匹配 Idempotency-Key</span>
                <button
                  className="primary-button"
                  disabled={commentState === "submitting" || commentBody.trim().length === 0}
                  type="submit"
                >
                  {commentState === "submitting" ? "提交中" : "提交评论"}
                </button>
              </div>
            </form>
            {commentState === "success" && commentId !== null && (
              <p aria-live="polite" className="success-note">
                Comment 已创建：{commentId}；时间线已重新读取并确认 comment.created。
              </p>
            )}
            {commentState === "error" && commentError !== null && (
              <p aria-live="assertive" className="api-error">
                Comment 请求失败：HTTP{" "}
                {commentError.status === 0 ? "网络不可达" : commentError.status}
                {commentError.code === null ? "" : ` · ${commentError.code}`}。
              </p>
            )}
          </>
        )}
      </section>

      <footer>
        <span>版本 {product.appVersion}</span>
        <span aria-hidden="true">·</span>
        <span>Contract {product.contractVersion}</span>
      </footer>
    </main>
  );
}
