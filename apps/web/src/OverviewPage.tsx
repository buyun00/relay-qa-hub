import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  listBugs,
  updateBugOwner,
  updateBugPriority,
  updateBugVerificationOwner,
  type BrowserSessionPrincipal,
  type BugListItem,
  type BugPriority,
  type BugListState,
  type BugSeverity,
  type ProjectMember,
} from "./api";
import {
  TASK_STATUS_ORDER,
  taskStatusCopy,
  taskStatusForBugState,
  taskStatusLabel,
  type TaskStatus,
} from "./task-status";

type OwnerFilter = "all" | "unassigned" | "assigned" | `member:${string}`;
type StateGroup = "all" | TaskStatus;
type SortMode = "updated" | "created" | "priority";

const EDITABLE_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
const OVERVIEW_COLUMN_STORAGE_KEY = "relay-qa-hub:overview-column-widths:v1";

const overviewColumns = [
  { key: "key", label: "编号", defaultWidth: 86, minWidth: 72 },
  { key: "title", label: "反馈问题", defaultWidth: 560, minWidth: 300 },
  { key: "owner", label: "负责人", defaultWidth: 190, minWidth: 150 },
  { key: "verifier", label: "关闭人", defaultWidth: 190, minWidth: 150 },
  { key: "state", label: "处理状态", defaultWidth: 112, minWidth: 96 },
  { key: "created", label: "提出时间", defaultWidth: 118, minWidth: 104 },
  { key: "updated", label: "最后更新", defaultWidth: 118, minWidth: 104 },
] as const;

type OverviewColumnKey = (typeof overviewColumns)[number]["key"];
type OverviewColumnWidths = Record<OverviewColumnKey, number>;

interface ActiveColumnResize {
  readonly pointerId: number;
  readonly columnIndex: number;
  readonly startX: number;
  readonly startWidths: OverviewColumnWidths;
}

function defaultOverviewColumnWidths(): OverviewColumnWidths {
  return Object.fromEntries(
    overviewColumns.map((column) => [column.key, column.defaultWidth]),
  ) as OverviewColumnWidths;
}

function loadOverviewColumnWidths(): OverviewColumnWidths {
  const defaults = defaultOverviewColumnWidths();
  if (typeof window === "undefined") return defaults;
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(OVERVIEW_COLUMN_STORAGE_KEY) ?? "null",
    ) as Record<string, unknown> | null;
    if (stored === null) return defaults;
    return Object.fromEntries(
      overviewColumns.map((column) => {
        const value = stored[column.key];
        return [
          column.key,
          typeof value === "number" && Number.isFinite(value)
            ? Math.max(column.minWidth, Math.round(value))
            : defaults[column.key],
        ];
      }),
    ) as OverviewColumnWidths;
  } catch {
    return defaults;
  }
}

function saveOverviewColumnWidths(widths: OverviewColumnWidths): void {
  try {
    window.localStorage.setItem(OVERVIEW_COLUMN_STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Column resizing remains available when persistent browser storage is disabled.
  }
}

function resizedColumnWidths(
  widths: OverviewColumnWidths,
  columnIndex: number,
  requestedDelta: number,
): OverviewColumnWidths {
  const column = overviewColumns[columnIndex];
  if (column === undefined) return widths;
  const minimumDelta = column.minWidth - widths[column.key];
  const delta = Math.max(minimumDelta, Math.round(requestedDelta));
  return { ...widths, [column.key]: widths[column.key] + delta };
}

interface OverviewPageProps {
  readonly projectId: string;
  readonly members: readonly ProjectMember[];
  readonly principal: BrowserSessionPrincipal;
  readonly refreshToken: number;
  readonly selectedDate: string | null;
  readonly onCreateBug: () => void;
  readonly onDateBucketsChange: (buckets: readonly OverviewDateBucket[]) => void;
  readonly onOpenBug: (bugId: string) => void;
  readonly onMutated: () => void;
}

export interface OverviewDateBucket {
  readonly date: string;
  readonly count: number;
}

const stateGroupOrder: readonly StateGroup[] = ["all", ...TASK_STATUS_ORDER];

function stateMatches(group: StateGroup, state: BugListState): boolean {
  return group === "all" || taskStatusForBugState(state) === group;
}

function stateGroupLabel(group: StateGroup): string {
  return group === "all" ? "全部状态" : taskStatusCopy[group].label;
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

const overviewDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function overviewDateKey(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  const parts = overviewDateFormatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year === undefined || month === undefined || day === undefined
    ? null
    : `${year}-${month}-${day}`;
}

export function buildOverviewDateBuckets(
  items: readonly Pick<BugListItem, "createdAt">[],
): readonly OverviewDateBucket[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const date = overviewDateKey(item.createdAt);
    if (date !== null) counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([date, count]) => ({ date, count }));
}

export function formatOverviewDateLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return value;
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
}

export function displayBugNumber(key: string): string {
  return key.replace(/^LOCAL-/i, "");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "总览读取失败";
}

export default function OverviewPage({
  projectId,
  members,
  principal,
  refreshToken,
  selectedDate,
  onCreateBug,
  onDateBucketsChange,
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
  const [pendingVerifierIds, setPendingVerifierIds] = useState<Readonly<Record<string, string>>>(
    {},
  );
  const loadRequestRef = useRef(0);
  const [columnWidths, setColumnWidths] = useState<OverviewColumnWidths>(loadOverviewColumnWidths);
  const [resizingColumn, setResizingColumn] = useState<OverviewColumnKey | null>(null);
  const columnWidthsRef = useRef(columnWidths);
  const activeColumnResizeRef = useRef<ActiveColumnResize | null>(null);
  const columnResizeCleanupRef = useRef<(() => void) | null>(null);

  const activeFixers = useMemo(
    () => members.filter((member) => member.active && member.roles.includes("developer")),
    [members],
  );
  const activeVerifiers = useMemo(
    () => members.filter((member) => member.active && member.roles.includes("verifier")),
    [members],
  );
  const memberId = useCallback(
    (userId: string | null): string | null => {
      if (userId === null) return null;
      return (
        members.find(
          (member) => member.userId === userId || member.linkedUserIds?.includes(userId) === true,
        )?.userId ?? userId
      );
    },
    [members],
  );
  const memberName = useCallback(
    (userId: string | null) =>
      userId === null
        ? "未分配"
        : (members.find(
            (member) => member.userId === userId || member.linkedUserIds?.includes(userId) === true,
          )?.displayName ?? userId.slice(0, 8)),
    [members],
  );

  const load = useCallback(
    async (quiet = false) => {
      const requestId = ++loadRequestRef.current;
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
        if (requestId !== loadRequestRef.current) return;
        setItems((current) => {
          const currentById = new Map(current.map((item) => [item.id, item]));
          return response.items.map((item) => {
            const existing = currentById.get(item.id);
            return existing && existing.version > item.version ? existing : item;
          });
        });
      } catch (cause) {
        if (requestId === loadRequestRef.current) setError(errorMessage(cause));
      } finally {
        if (requestId === loadRequestRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [ownerFilter, projectId, query, severity],
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 150);
    return () => {
      window.clearTimeout(timeout);
      loadRequestRef.current += 1;
    };
  }, [load, refreshToken]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [load]);

  useEffect(() => () => columnResizeCleanupRef.current?.(), []);

  const dateBuckets = useMemo(() => buildOverviewDateBuckets(items), [items]);

  useEffect(() => {
    onDateBucketsChange(dateBuckets);
  }, [dateBuckets, onDateBucketsChange]);

  const dateScopedItems = useMemo(
    () =>
      selectedDate === null
        ? items
        : items.filter((bug) => overviewDateKey(bug.createdAt) === selectedDate),
    [items, selectedDate],
  );

  const visibleItems = useMemo(() => {
    const filtered = dateScopedItems.filter((bug) => stateMatches(stateGroup, bug.state));
    return [...filtered].sort((left, right) => {
      if (sortMode === "priority") {
        const priority = left.priority.localeCompare(right.priority);
        if (priority !== 0) return priority;
      }
      const leftTime = sortMode === "created" ? left.createdAt : left.updatedAt;
      const rightTime = sortMode === "created" ? right.createdAt : right.updatedAt;
      return rightTime.localeCompare(leftTime) || right.key.localeCompare(left.key);
    });
  }, [dateScopedItems, sortMode, stateGroup]);

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

  const assignVerificationOwner = async (bug: BugListItem, nextVerifierId: string) => {
    if (memberId(bug.verificationOwnerId ?? bug.reporterId) === nextVerifierId) return;
    setPendingVerifierIds((current) => ({ ...current, [bug.id]: nextVerifierId }));
    setMutatingId(bug.id);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateBugVerificationOwner(bug.id, bug.version, nextVerifierId);
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setNotice(`${bug.key} 的关闭人已设为 ${memberName(nextVerifierId)}`);
      onMutated();
    } catch (cause) {
      setError(errorMessage(cause));
      await load(true);
    } finally {
      setPendingVerifierIds((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => id !== bug.id)),
      );
      setMutatingId(null);
    }
  };

  const setPriority = async (bug: BugListItem, priority: BugPriority) => {
    if (priority === bug.priority) return;
    setMutatingId(bug.id);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateBugPriority(bug.id, bug.version, priority);
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setNotice(`${bug.key} 的优先级已设为 ${priority}`);
      onMutated();
    } catch (cause) {
      setError(errorMessage(cause));
      await load(true);
    } finally {
      setMutatingId(null);
    }
  };

  const updateColumnWidths = (next: OverviewColumnWidths, persist = false) => {
    columnWidthsRef.current = next;
    setColumnWidths(next);
    if (persist) saveOverviewColumnWidths(next);
  };

  const beginColumnResize = (event: ReactPointerEvent<HTMLButtonElement>, columnIndex: number) => {
    event.preventDefault();
    const column = overviewColumns[columnIndex];
    if (column === undefined) return;
    activeColumnResizeRef.current = {
      pointerId: event.pointerId,
      columnIndex,
      startX: event.clientX,
      startWidths: columnWidthsRef.current,
    };
    setResizingColumn(column.key);
    columnResizeCleanupRef.current?.();
    let cleanup = () => undefined;
    const move = (moveEvent: PointerEvent) => {
      const activeResize = activeColumnResizeRef.current;
      if (activeResize === null || activeResize.pointerId !== moveEvent.pointerId) return;
      updateColumnWidths(
        resizedColumnWidths(
          activeResize.startWidths,
          activeResize.columnIndex,
          moveEvent.clientX - activeResize.startX,
        ),
      );
    };
    const finish = (finishEvent: PointerEvent) => {
      const activeResize = activeColumnResizeRef.current;
      if (activeResize === null || activeResize.pointerId !== finishEvent.pointerId) return;
      cleanup();
      activeColumnResizeRef.current = null;
      setResizingColumn(null);
      saveOverviewColumnWidths(columnWidthsRef.current);
    };
    cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      columnResizeCleanupRef.current = null;
    };
    columnResizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const resizeColumnWithKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    columnIndex: number,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    updateColumnWidths(
      resizedColumnWidths(
        columnWidthsRef.current,
        columnIndex,
        event.key === "ArrowLeft" ? -12 : 12,
      ),
      true,
    );
  };

  const gridTemplateColumns = overviewColumns
    .map((column) => `${columnWidths[column.key]}px`)
    .join(" ");
  const gridWidth = overviewColumns.reduce((sum, column) => sum + columnWidths[column.key], 0);
  const overviewGridStyle = { gridTemplateColumns, minWidth: gridWidth } satisfies CSSProperties;
  const overviewContentStyle = { minWidth: gridWidth } satisfies CSSProperties;

  const verifierOptionsFor = (bug: BugListItem) => {
    const candidateIds = [
      memberId(bug.verificationOwnerId),
      memberId(bug.reporterId),
      principal.userId,
      ...activeVerifiers.map((member) => member.userId),
    ];
    return candidateIds
      .filter((userId): userId is string => userId !== null)
      .filter((userId, index, ids) => ids.indexOf(userId) === index);
  };

  const unassignedCount = dateScopedItems.filter(
    (bug) => bug.ownerId === null && bug.state !== "closed",
  ).length;
  const selectedDateLabel =
    selectedDate === null ? "全部日期" : formatOverviewDateLabel(selectedDate);

  return (
    <main className="overview-page">
      <section className="overview-heading">
        <div>
          <p className="eyebrow">共享总表</p>
          <h1>Bug 总览 · {selectedDateLabel}</h1>
          <p>
            {selectedDate === null
              ? "集中查看当前项目的全部单子，或从左侧按提出日期分类。"
              : `当前只显示 ${selectedDateLabel} 提出的单子，可继续叠加负责人、状态和级别筛选。`}
          </p>
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
            {stateGroupOrder.map((group) => (
              <option key={group} value={group}>
                {stateGroupLabel(group)}
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

      <section
        className={`overview-sheet${resizingColumn === null ? "" : " is-resizing"}`}
        aria-label={`${selectedDateLabel} Bug 总览`}
      >
        <div className="overview-sheet-meta" style={overviewContentStyle}>
          <strong>
            {selectedDateLabel} · {visibleItems.length} 条当前结果
          </strong>
          <span>最多一次读取 500 条 · 自动刷新</span>
        </div>
        <div className="overview-grid overview-grid-head" role="row" style={overviewGridStyle}>
          {overviewColumns.map((column, columnIndex) => (
            <span key={column.key}>
              {column.label}
              <button
                aria-label={`拖拽调整${column.label}列宽`}
                className="overview-column-resizer"
                onKeyDown={(event) => resizeColumnWithKeyboard(event, columnIndex)}
                onPointerDown={(event) => beginColumnResize(event, columnIndex)}
                title={`拖拽调整${column.label}列宽`}
                type="button"
              />
            </span>
          ))}
        </div>
        {loading ? (
          <div className="overview-empty" style={overviewContentStyle}>
            正在读取全部 Bug…
          </div>
        ) : null}
        {!loading && visibleItems.length === 0 ? (
          <div className="overview-empty" style={overviewContentStyle}>
            {selectedDate === null
              ? "当前筛选下没有 Bug。"
              : `${selectedDateLabel} 没有符合筛选的 Bug。`}
          </div>
        ) : null}
        {visibleItems.map((bug) => {
          const rowMutating = mutatingId === bug.id || pendingVerifierIds[bug.id] !== undefined;
          const effectiveOwnerId = memberId(bug.ownerId);
          const effectiveVerifierId =
            pendingVerifierIds[bug.id] ??
            memberId(bug.verificationOwnerId ?? bug.reporterId) ??
            bug.reporterId;
          return (
            <div
              className={`overview-grid${bug.ownerId === null ? " is-unassigned" : ""}`}
              data-created-date={overviewDateKey(bug.createdAt) ?? undefined}
              key={bug.id}
              role="row"
              style={overviewGridStyle}
            >
              <span className={`overview-key-priority ${bug.priority.toLowerCase()}`}>
                <span className="overview-key-number">{displayBugNumber(bug.key)}</span>
                <small>{bug.priority}</small>
                <select
                  aria-label={`设置 ${bug.key} 优先级`}
                  className="overview-key-priority-select"
                  disabled={rowMutating}
                  onChange={(event) => void setPriority(bug, event.target.value as BugPriority)}
                  title="点击编号设置 P0-P3 优先级"
                  value={bug.priority}
                >
                  {bug.priority === "P4" ? <option value="P4">P4</option> : null}
                  {EDITABLE_PRIORITIES.map((priority) => (
                    <option key={priority} value={priority}>
                      {priority}
                    </option>
                  ))}
                </select>
              </span>
              <button className="overview-title" onClick={() => onOpenBug(bug.id)} type="button">
                <strong>{bug.description.trim() || bug.title}</strong>
              </button>
              <span className="overview-owner-cell overview-person-cell">
                {bug.ownerId === null ? (
                  <button
                    className="claim-button"
                    disabled={rowMutating}
                    onClick={() => void assignOwner(bug, principal.userId)}
                    type="button"
                  >
                    认领
                  </button>
                ) : null}
                <select
                  aria-label={`设置 ${bug.key} 负责人`}
                  disabled={rowMutating}
                  onChange={(event) => void assignOwner(bug, event.target.value || null)}
                  value={effectiveOwnerId ?? ""}
                >
                  <option value="">未分配</option>
                  {activeFixers.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.displayName}
                    </option>
                  ))}
                </select>
              </span>
              <span className="overview-verifier-cell overview-person-cell">
                {effectiveVerifierId === principal.userId ? null : (
                  <button
                    className="claim-button"
                    disabled={rowMutating}
                    onClick={() => void assignVerificationOwner(bug, principal.userId)}
                    type="button"
                  >
                    认领
                  </button>
                )}
                <select
                  aria-label={`设置 ${bug.key} 关闭人`}
                  disabled={rowMutating}
                  onChange={(event) => void assignVerificationOwner(bug, event.target.value)}
                  value={effectiveVerifierId}
                >
                  {verifierOptionsFor(bug).map((userId) => (
                    <option key={userId} value={userId}>
                      {memberName(userId)}
                    </option>
                  ))}
                </select>
              </span>
              <span>
                <b className={`status-badge state-${bug.state}`}>{taskStatusLabel(bug.state)}</b>
              </span>
              <span>{formatDate(bug.createdAt)}</span>
              <span>{formatDate(bug.updatedAt)}</span>
            </div>
          );
        })}
      </section>
    </main>
  );
}
