import { useCallback, useEffect, useMemo, useState } from "react";

import {
  listBugs,
  updateBugOwner,
  type BrowserSessionPrincipal,
  type BugListItem,
  type BugListState,
  type BugSeverity,
  type ProjectMember,
} from "./api";

type OwnerFilter = "all" | "unassigned" | "assigned" | `member:${string}`;
type StateGroup = "all" | "pending" | "inProgress" | "verification" | "completed";
type SortMode = "updated" | "created" | "priority";

interface OverviewPageProps {
  readonly projectId: string;
  readonly members: readonly ProjectMember[];
  readonly principal: BrowserSessionPrincipal;
  readonly refreshToken: number;
  readonly onCreateBug: () => void;
  readonly onOpenBug: (bugId: string) => void;
  readonly onMutated: () => void;
}

const stateCopy: Readonly<Record<BugListState, string>> = {
  reported: "待分配",
  needs_info: "需补充",
  ready: "待修复",
  in_progress: "处理中",
  awaiting_build: "等待构建",
  ready_for_verification: "待验收",
  closed: "已完成",
  deferred: "已延期",
  rejected: "不处理",
  duplicate: "重复项",
};

const stateGroupCopy: Readonly<Record<StateGroup, string>> = {
  all: "全部状态",
  pending: "待处理",
  inProgress: "处理中",
  verification: "待验收",
  completed: "已完成",
};

function stateMatches(group: StateGroup, state: BugListState): boolean {
  if (group === "all") return true;
  if (group === "pending")
    return state === "reported" || state === "needs_info" || state === "ready";
  if (group === "inProgress") return state === "in_progress" || state === "awaiting_build";
  if (group === "verification") return state === "ready_for_verification";
  return state === "closed";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "总览读取失败";
}

export default function OverviewPage({
  projectId,
  members,
  principal,
  refreshToken,
  onCreateBug,
  onOpenBug,
  onMutated,
}: OverviewPageProps) {
  const [items, setItems] = useState<readonly BugListItem[]>([]);
  const [query, setQuery] = useState("");
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>("all");
  const [stateGroup, setStateGroup] = useState<StateGroup>("all");
  const [severity, setSeverity] = useState<"all" | BugSeverity>("all");
  const [sortMode, setSortMode] = useState<SortMode>("updated");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  const activeFixers = useMemo(
    () => members.filter((member) => member.active && member.roles.includes("developer")),
    [members],
  );
  const memberName = useCallback(
    (userId: string | null) =>
      userId === null
        ? "未分配"
        : (members.find((member) => member.userId === userId)?.displayName ?? userId.slice(0, 8)),
    [members],
  );

  const load = useCallback(
    async (quiet = false) => {
      if (quiet) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const normalizedQuery = query.trim();
        const response = await listBugs(
          projectId,
          {
            ...(normalizedQuery.length === 0 ? {} : { q: normalizedQuery }),
            ...(ownerFilter === "unassigned" ? { ownerState: "unassigned" as const } : {}),
            ...(ownerFilter === "assigned" ? { ownerState: "assigned" as const } : {}),
            ...(ownerFilter.startsWith("member:")
              ? { ownerId: ownerFilter.slice("member:".length) }
              : {}),
            ...(severity === "all" ? {} : { severity }),
          },
          undefined,
          500,
        );
        setItems(response.items);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [ownerFilter, projectId, query, severity],
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 150);
    return () => window.clearTimeout(timeout);
  }, [load, refreshToken]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [load]);

  const visibleItems = useMemo(() => {
    const filtered = items.filter((bug) => stateMatches(stateGroup, bug.state));
    return [...filtered].sort((left, right) => {
      if (sortMode === "priority") {
        const priority = left.priority.localeCompare(right.priority);
        if (priority !== 0) return priority;
      }
      const leftTime = sortMode === "created" ? left.createdAt : left.updatedAt;
      const rightTime = sortMode === "created" ? right.createdAt : right.updatedAt;
      return rightTime.localeCompare(leftTime) || right.key.localeCompare(left.key);
    });
  }, [items, sortMode, stateGroup]);

  const assignOwner = async (bug: BugListItem, nextOwnerId: string | null) => {
    setMutatingId(bug.id);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateBugOwner(bug.id, bug.version, nextOwnerId);
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setNotice(
        nextOwnerId === null
          ? `${bug.key} 已设为未分配`
          : `${bug.key} 已分配给 ${memberName(nextOwnerId)}`,
      );
      onMutated();
      if (ownerFilter !== "all") await load(true);
    } catch (cause) {
      setError(errorMessage(cause));
      await load(true);
    } finally {
      setMutatingId(null);
    }
  };

  const unassignedCount = items.filter(
    (bug) => bug.ownerId === null && bug.state !== "closed",
  ).length;

  return (
    <main className="overview-page">
      <section className="overview-heading">
        <div>
          <p className="eyebrow">共享总表</p>
          <h1>Bug 总览</h1>
          <p>集中查看当前项目的全部单子，筛出未分配事项并直接认领或设置负责人。</p>
        </div>
        <button className="primary-button" onClick={onCreateBug} type="button">
          <span>＋</span> 新建 Bug
        </button>
      </section>

      {error === null ? null : <div className="banner error-banner">{error}</div>}
      {notice === null ? null : <div className="banner success-banner">✓ {notice}</div>}

      <section className="overview-toolbar" aria-label="总览筛选">
        <label className="overview-search">
          <span>搜索</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="编号、问题内容或行为"
            type="search"
            value={query}
          />
        </label>
        <label>
          <span>负责人</span>
          <select
            onChange={(event) => setOwnerFilter(event.target.value as OwnerFilter)}
            value={ownerFilter}
          >
            <option value="all">全部负责人</option>
            <option value="unassigned">未分配</option>
            <option value="assigned">已分配</option>
            {activeFixers.map((member) => (
              <option key={member.userId} value={`member:${member.userId}`}>
                {member.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>状态</span>
          <select
            onChange={(event) => setStateGroup(event.target.value as StateGroup)}
            value={stateGroup}
          >
            {(Object.keys(stateGroupCopy) as StateGroup[]).map((group) => (
              <option key={group} value={group}>
                {stateGroupCopy[group]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>严重程度</span>
          <select
            onChange={(event) => setSeverity(event.target.value as typeof severity)}
            value={severity}
          >
            <option value="all">全部级别</option>
            {(["S0", "S1", "S2", "S3", "S4"] as const).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>排序</span>
          <select
            onChange={(event) => setSortMode(event.target.value as SortMode)}
            value={sortMode}
          >
            <option value="updated">最近更新</option>
            <option value="created">最近提出</option>
            <option value="priority">优先级</option>
          </select>
        </label>
        <button
          className={`unassigned-filter-button${ownerFilter === "unassigned" ? " is-active" : ""}`}
          onClick={() => setOwnerFilter(ownerFilter === "unassigned" ? "all" : "unassigned")}
          type="button"
        >
          未分配 {unassignedCount}
        </button>
        <button
          aria-label="刷新总览"
          className="icon-button"
          disabled={refreshing}
          onClick={() => void load(true)}
          type="button"
        >
          ↻
        </button>
      </section>

      <section className="overview-sheet" aria-label="全部 Bug 总览">
        <div className="overview-sheet-meta">
          <strong>{visibleItems.length} 条当前结果</strong>
          <span>最多一次读取 500 条 · 自动刷新</span>
        </div>
        <div className="overview-grid overview-grid-head" role="row">
          <span>编号</span>
          <span>反馈问题</span>
          <span>优先级</span>
          <span>提报人</span>
          <span>负责人</span>
          <span>处理状态</span>
          <span>提出时间</span>
          <span>最后更新</span>
        </div>
        {loading ? <div className="overview-empty">正在读取全部 Bug…</div> : null}
        {!loading && visibleItems.length === 0 ? (
          <div className="overview-empty">当前筛选下没有 Bug。</div>
        ) : null}
        {visibleItems.map((bug) => (
          <div
            className={`overview-grid${bug.ownerId === null ? " is-unassigned" : ""}`}
            key={bug.id}
            role="row"
          >
            <button className="overview-key" onClick={() => onOpenBug(bug.id)} type="button">
              {bug.key}
            </button>
            <button className="overview-title" onClick={() => onOpenBug(bug.id)} type="button">
              <strong>{bug.description.trim() || bug.title}</strong>
              <small>{bug.expectedBehavior}</small>
            </button>
            <span>
              <b className={`priority ${bug.priority.toLowerCase()}`}>{bug.priority}</b>
              <small>{bug.severity}</small>
            </span>
            <span>{memberName(bug.reporterId)}</span>
            <span className="overview-owner-cell">
              {bug.ownerId === null ? (
                <button
                  className="claim-button"
                  disabled={mutatingId === bug.id}
                  onClick={() => void assignOwner(bug, principal.userId)}
                  type="button"
                >
                  认领
                </button>
              ) : null}
              <select
                aria-label={`设置 ${bug.key} 负责人`}
                disabled={mutatingId === bug.id}
                onChange={(event) => void assignOwner(bug, event.target.value || null)}
                value={bug.ownerId ?? ""}
              >
                <option value="">未分配</option>
                {activeFixers.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.displayName}
                  </option>
                ))}
              </select>
            </span>
            <span>
              <b className={`status-badge state-${bug.state}`}>{stateCopy[bug.state]}</b>
            </span>
            <span>{formatDate(bug.createdAt)}</span>
            <span>{formatDate(bug.updatedAt)}</span>
          </div>
        ))}
      </section>
    </main>
  );
}
