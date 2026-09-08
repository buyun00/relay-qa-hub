import AppIcon from "./AppIcon";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listBugs,
  listBugAttachments,
  type AttachmentMetadata,
  type BugListItem,
  type ProjectMember,
} from "./api";
import { taskStatusLabel, taskStatusForBugState, TASK_STATUS_ORDER } from "./task-status";
import {
  defaultExecution,
  downloadProductionFile,
  productionError,
  productionGet,
  productionRetry,
  productionStatuses,
  productionSubmit,
  uploadProductionFile,
  type ExecutionOptions,
  type ProductionBatch,
  type ProductionDetail,
  type ProductionProject,
  type ProductionSubmission,
  type ProductionTask,
} from "./production-api";
import "./production.css";

interface Draft {
  title: string;
  message: string;
  mode: "create" | "bugs";
  execution: ExecutionOptions;
  bugIds: string[];
  extra: Record<string, string>;
}
const emptyDraft = (): Draft => ({
  title: "",
  message: "",
  mode: "create",
  execution: { ...defaultExecution },
  bugIds: [],
  extra: {},
});
const label = (status: string) => productionStatuses[status] ?? status;
const taskLabel = (task: ProductionTask) =>
  task.bugId && task.status === "waiting_user" && task.latestTurn?.status === "success"
    ? "待验收"
    : label(task.status);
const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
export function compareProductionBugPriority(
  a: Pick<BugListItem, "state">,
  b: Pick<BugListItem, "state">,
): number {
  return (
    TASK_STATUS_ORDER.indexOf(taskStatusForBugState(a.state)) -
    TASK_STATUS_ORDER.indexOf(taskStatusForBugState(b.state))
  );
}
const importStatusLabel = (bug: BugListItem) =>
  taskStatusForBugState(bug.state) === "pending" ? "待制作" : taskStatusLabel(bug.state);
function readDraft(key: string): Draft {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<Draft> | null;
    return saved
      ? { ...emptyDraft(), ...saved, execution: { ...defaultExecution, ...saved.execution } }
      : emptyDraft();
  } catch {
    return emptyDraft();
  }
}
function readPending(key: string): ProductionSubmission[] {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as
      ProductionSubmission | ProductionSubmission[] | null;
    return saved ? (Array.isArray(saved) ? saved : [saved]) : [];
  } catch {
    return [];
  }
}
function store(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* The mounted form still preserves the draft when storage is unavailable. */
  }
}
function ResultText({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return <pre className="production-text">{value}</pre>;
  const result = value as Record<string, unknown>;
  return (
    <div className="production-result">
      {["summary", "message", "changedFiles", "validation", "risks", "nextSteps"]
        .filter((key) => result[key])
        .map((key) => (
          <div key={key}>
            <strong>
              {
                {
                  summary: "制作结果",
                  message: "说明",
                  changedFiles: "修改文件",
                  validation: "验证记录",
                  risks: "注意事项",
                  nextSteps: "后续处理",
                }[key]
              }
            </strong>
            <pre className="production-text">
              {Array.isArray(result[key])
                ? result[key]
                    .map((item) =>
                      typeof item === "string" ? item : JSON.stringify(item, null, 2),
                    )
                    .join("\n")
                : String(result[key])}
            </pre>
          </div>
        ))}
    </div>
  );
}
function FilePicker({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  const [error, setError] = useState("");
  const add = (incoming: File[]) => {
    const combined = [...files, ...incoming];
    if (
      combined.length > 8 ||
      combined.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024
    ) {
      setError("每张单最多 8 个附件，总计不超过 100 MB");
      return;
    }
    setError("");
    onChange(combined);
  };
  return (
    <div
      className="production-files"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        add(Array.from(event.dataTransfer.files));
      }}
      onPaste={(event) => {
        const incoming = Array.from(event.clipboardData.files);
        if (incoming.length) {
          event.preventDefault();
          add(incoming);
        }
      }}
    >
      <label>
        附件{" "}
        <input
          type="file"
          multiple
          accept=".png,.jpg,.jpeg,.webp,.txt,.log,.json,.zip"
          onChange={(event) => {
            add(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
      </label>
      <small>可拖入文件或在此粘贴图片。支持图片、日志、JSON、ZIP；每个最多 25 MB。</small>
      {files.map((file, index) => (
        <div key={`${file.name}:${index}`}>
          <span>
            {file.name} · {(file.size / 1024).toFixed(0)} KB
          </span>
          <button type="button" onClick={() => onChange(files.filter((_, i) => i !== index))}>
            移除
          </button>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
function BugAttachments({
  bugId,
  selected,
  onSelect,
}: {
  bugId: string;
  selected?: string[] | undefined;
  onSelect: (ids: string[]) => void;
}) {
  const [files, setFiles] = useState<readonly AttachmentMetadata[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    void listBugAttachments(bugId)
      .then((result) => {
        if (!disposed) setFiles(result.items);
      })
      .catch((error) => {
        if (!disposed) setError(productionError(error));
      });
    return () => {
      disposed = true;
    };
  }, [bugId]);
  if (error) return <p role="alert">{error}</p>;
  return (
    <div className="production-attachment-choices">
      {files.length === 0 ? (
        <small>暂无附件</small>
      ) : (
        files.map((file) => (
          <label key={file.attachmentId}>
            <input
              type="checkbox"
              checked={selected ? selected.includes(file.attachmentId) : true}
              onChange={(event) => {
                const current = selected ?? files.map((f) => f.attachmentId);
                onSelect(
                  event.target.checked
                    ? [...current, file.attachmentId]
                    : current.filter((id) => id !== file.attachmentId),
                );
              }}
            />
            {file.filename}
          </label>
        ))
      )}
    </div>
  );
}

export default function ProductionPage({
  active,
  refreshRevision = 0,
  userId,
  projectId,
  members,
  onOpenBug,
  onImport,
}: {
  active: boolean;
  refreshRevision?: number;
  userId: string;
  projectId: string;
  members: readonly ProjectMember[];
  onOpenBug: (id: string) => void;
  onImport: () => void;
}) {
  const draftKey = `qa-production-draft:${userId}:${projectId}`,
    pendingKey = `${draftKey}:pending`;
  const [draft, setDraft] = useState(() => readDraft(draftKey));
  const [pending, setPending] = useState<ProductionSubmission[]>(() => readPending(pendingKey));
  const [project, setProject] = useState<ProductionProject | null>(null),
    [tasks, setTasks] = useState<ProductionTask[]>([]),
    [bugs, setBugs] = useState<readonly BugListItem[]>([]),
    [batches, setBatches] = useState<ProductionBatch[]>([]);
  const [detail, setDetail] = useState<ProductionDetail | null>(null),
    [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState(""),
    [person, setPerson] = useState(""),
    [state, setState] = useState("current"),
    [checked, setChecked] = useState<string[]>([]);
  const [creating, setCreating] = useState(false),
    [files, setFiles] = useState<File[]>([]),
    [attachmentChoices, setAttachmentChoices] = useState<Record<string, string[]>>({});
  const [bugSearch, setBugSearch] = useState(""),
    [bugOwner, setBugOwner] = useState(""),
    [message, setMessage] = useState(""),
    [continueFiles, setContinueFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set()),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<{
    tasks: ProductionTask[];
    action: string;
  } | null>(null);
  const refreshInFlight = useRef(false),
    selectedRef = useRef<string | null>(null),
    detailRevision = useRef(0);
  const actionLocks = useRef(new Set<string>()),
    uploaded = useRef(new WeakMap<File, string>());
  const pendingRef = useRef(pending);
  const pendingCreate = pending.find((body) => body.kind !== "action");
  const updatePending = (items: ProductionSubmission[]) => {
    pendingRef.current = items;
    setPending(items);
    store(pendingKey, items);
  };
  const continuationKey = selectedId ? `${draftKey}:continue:${selectedId}` : "";
  useEffect(() => {
    store(draftKey, draft);
  }, [draftKey, draft]);
  useEffect(() => {
    store(pendingKey, pending);
  }, [pendingKey, pending]);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (refreshInFlight.current || !projectId) return;
      refreshInFlight.current = true;
      try {
        const results = await Promise.allSettled([
          productionGet<ProductionProject>("/project", projectId, signal),
          productionGet<{ items: ProductionTask[] }>("/tasks", projectId, signal),
          listBugs(projectId, {}, signal, 500),
          productionGet<{ items: ProductionBatch[] }>("/batches", projectId, signal),
        ]);
        if (signal?.aborted) return;
        if (results[0].status === "fulfilled") setProject(results[0].value);
        if (results[1].status === "fulfilled") setTasks(results[1].value.items);
        if (results[2].status === "fulfilled") setBugs(results[2].value.items);
        if (results[3].status === "fulfilled") setBatches(results[3].value.items);
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") setError(productionError(failed.reason));
        else setError("");
        const id = selectedRef.current,
          revision = detailRevision.current;
        if (id) {
          const next = await productionGet<ProductionDetail>(`/tasks/${id}`, projectId, signal);
          if (!signal?.aborted && id === selectedRef.current && revision === detailRevision.current)
            setDetail(next);
        }
      } catch (error) {
        if (!signal?.aborted) setError(productionError(error));
      } finally {
        refreshInFlight.current = false;
      }
    },
    [projectId],
  );
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => void refresh(controller.signal), 8000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [active, refresh, refreshRevision]);
  const openTask = async (id: string) => {
    selectedRef.current = id;
    const revision = ++detailRevision.current;
    setSelectedId(id);
    setDetail(null);
    setContinueFiles([]);
    setCreating(false);
    try {
      setMessage(localStorage.getItem(`${draftKey}:continue:${id}`) ?? "");
    } catch {
      setMessage("");
    }
    try {
      const next = await productionGet<ProductionDetail>(`/tasks/${id}`, projectId);
      if (selectedRef.current === id && revision === detailRevision.current) setDetail(next);
    } catch (error) {
      setError(productionError(error));
    }
  };
  const mutate = async (key: string, operation: () => Promise<void>) => {
    if (actionLocks.current.has(key)) return;
    actionLocks.current.add(key);
    setBusy(new Set(actionLocks.current));
    setError("");
    try {
      await operation();
    } catch (error) {
      setError(productionError(error));
    } finally {
      actionLocks.current.delete(key);
      setBusy(new Set(actionLocks.current));
    }
  };
  const submit = async (body: ProductionSubmission) => {
    updatePending([
      ...pendingRef.current.filter((item) => item.requestId !== body.requestId),
      body,
    ]);
    const result = await productionSubmit(body);
    setBatches((current) => [result, ...current.filter((batch) => batch.id !== result.id)]);
    updatePending(pendingRef.current.filter((item) => item.requestId !== body.requestId));
    setNotice("提交已记录。请在批次记录中查看每张单的结果。");
    await refresh();
  };
  const uploadFiles = async (selected: File[]) => {
    const ids: string[] = [];
    for (const file of selected) {
      let id = uploaded.current.get(file);
      if (!id) {
        id = await uploadProductionFile(projectId, file);
        uploaded.current.set(file, id);
      }
      ids.push(id);
    }
    return ids;
  };
  const create = () =>
    mutate("create", async () => {
      if (pendingCreate) {
        await submit(pendingCreate);
        return;
      }
      const items =
        draft.mode === "create"
          ? [{ title: draft.title, message: draft.message, uploadIds: await uploadFiles(files) }]
          : draft.bugIds.map((bugId) => ({
              bugId,
              ...(attachmentChoices[bugId]
                ? { selectedAttachmentIds: attachmentChoices[bugId] }
                : {}),
              extraPrompt: draft.extra[bugId] ?? "",
            }));
      await submit({
        projectId,
        requestId: crypto.randomUUID(),
        kind: draft.mode,
        items,
        execution: draft.execution,
      });
      setCreating(false);
      setFiles([]);
      setDraft(emptyDraft());
      setAttachmentChoices({});
    });
  const runAction = (selected: ProductionTask[], action: string, confirmMerge = false) =>
    mutate(`action:${selected.map((t) => t.id).join(",")}`, async () => {
      if (
        pending.some(
          (body) =>
            body.kind === "action" &&
            body.items.some((item) => selected.some((task) => task.id === item.taskId)),
        )
      ) {
        setNotice("此任务的上次操作尚未确认，请先核对该次提交。");
        return;
      }
      const uploadIds = action === "continue" ? await uploadFiles(continueFiles) : [];
      const items = selected.map((task) => ({
        taskId: task.id,
        expectedUpdatedAt: task.updatedAt,
        action,
        confirmMerge,
        ...(action === "continue"
          ? {
              message,
              uploadIds,
              selectedAttachmentIds: task.bugId ? (attachmentChoices[task.bugId] ?? []) : [],
            }
          : {}),
      }));
      await submit({ projectId, requestId: crypto.randomUUID(), kind: "action", items });
      setConfirmation(null);
      if (action === "continue") {
        setMessage("");
        setContinueFiles([]);
        try {
          localStorage.removeItem(continuationKey);
        } catch {
          /* Keep running without storage. */
        }
      }
    });
  const bugById = useMemo(() => new Map(bugs.map((bug) => [bug.id, bug])), [bugs]);
  const people = [...new Set(tasks.map((task) => task.createdBy))].filter(Boolean);
  const visible = tasks.filter(
    (task) =>
      (state === "all" ||
        (state === "current" && task.status !== "closed") ||
        state === task.status) &&
      (!person || task.createdBy === person) &&
      `${task.number} ${task.title} ${bugById.get(task.bugId ?? "")?.key ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const bugChoices = bugs
    .filter(
      (bug) =>
        !["closed", "deferred", "rejected", "duplicate"].includes(bug.state) &&
        (!bugOwner || bug.ownerId === bugOwner) &&
        `${bug.key} ${bug.title}`.toLowerCase().includes(bugSearch.toLowerCase()),
    )
    .sort(compareProductionBugPriority);
  const selection = tasks.filter((task) => checked.includes(task.id));
  const currentBusy = selectedId ? [...busy].some((key) => key.includes(selectedId)) : false;
  const draftHasFiles = files.length > 0;
  return (
    <main className="production-page">
      <header className="production-header">
        <div>
          <span className="production-eyebrow">RELAY · TASKS</span>
          <h1>制作任务</h1>
          <p>查看当前单子，提交新需求，继续修改和管理进展。</p>
        </div>
        <div className="production-actions">
          <button type="button" onClick={() => void refresh()}>
            刷新
          </button>
          <button type="button" className="primary-button" onClick={() => setCreating(true)}>
            <AppIcon name="plus" /> 新建 / 批量制作
          </button>
        </div>
      </header>
      {error && (
        <div className="banner error-banner" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="banner" role="status">
          {notice}
          <button type="button" aria-label="关闭提示" onClick={() => setNotice("")}>
            <AppIcon name="close" />
          </button>
        </div>
      )}
      {pending.map((body) => (
        <div className="production-pending" role="status" key={body.requestId}>
          {body.items.length} 张单的上次提交尚未确认。
          <button
            type="button"
            disabled={busy.has(`pending:${body.requestId}`)}
            onClick={() => void mutate(`pending:${body.requestId}`, () => submit(body))}
          >
            核对上次提交
          </button>
        </div>
      ))}
      <div className="production-toolbar">
        <input
          aria-label="搜索制作任务"
          placeholder="搜索单号或标题"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="任务进展筛选"
          value={state}
          onChange={(event) => setState(event.target.value)}
        >
          <option value="current">当前任务</option>
          <option value="all">全部任务</option>
          {Object.entries(productionStatuses)
            .filter(([key]) => tasks.some((task) => task.status === key))
            .map(([key, text]) => (
              <option key={key} value={key}>
                {text}
              </option>
            ))}
        </select>
        <select
          aria-label="提出人筛选"
          value={person}
          onChange={(event) => setPerson(event.target.value)}
        >
          <option value="">全部提出人</option>
          {people.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <span>{visible.length} 张单</span>
      </div>
      {selection.length > 0 && (
        <div className="production-selection">
          <strong>已选 {selection.length} 张</strong>
          <button
            type="button"
            onClick={() => setConfirmation({ tasks: selection, action: "cancel" })}
          >
            停止
          </button>
          <button type="button" onClick={() => void runAction(selection, "retry")}>
            重试
          </button>
          <button
            type="button"
            onClick={() => setConfirmation({ tasks: selection, action: "finish" })}
          >
            结束制作
          </button>
          <button type="button" onClick={() => setChecked([])}>
            清空选择
          </button>
        </div>
      )}
      <div className={`production-workspace${selectedId && !creating ? " has-detail" : ""}`}>
        <section className="production-list" aria-label="制作任务列表">
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="选择当前列表"
                    checked={visible.length > 0 && visible.every((t) => checked.includes(t.id))}
                    onChange={(event) =>
                      setChecked(event.target.checked ? visible.map((t) => t.id) : [])
                    }
                  />
                </th>
                <th>单子</th>
                <th>进展</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((task) => (
                <tr key={task.id} className={selectedId === task.id ? "is-selected" : ""}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`选择任务 ${task.number}`}
                      checked={checked.includes(task.id)}
                      onChange={(event) =>
                        setChecked((current) =>
                          event.target.checked
                            ? [...current, task.id]
                            : current.filter((id) => id !== task.id),
                        )
                      }
                    />
                  </td>
                  <td>
                    <button
                      className="production-task-title"
                      type="button"
                      onClick={() => void openTask(task.id)}
                    >
                      <small>
                        #{task.number}
                        {task.bugId && bugById.get(task.bugId)
                          ? ` · ${bugById.get(task.bugId)?.key}`
                          : ""}
                      </small>
                      <strong>{task.title}</strong>
                    </button>
                    <small>{task.createdBy}</small>
                  </td>
                  <td>
                    <span className={`production-status state-${task.status}`}>
                      {taskLabel(task)}
                    </span>
                    {task.bugId && bugById.get(task.bugId) && (
                      <small>
                        Bug：{taskStatusLabel(bugById.get(task.bugId)?.state ?? "reported")}
                      </small>
                    )}
                  </td>
                  <td>
                    <time>{date(task.updatedAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && (
            <div className="production-empty">
              {project
                ? "当前筛选下暂无任务，可新建需求或从 QA Bug 批量制作。"
                : "正在连接制作服务…"}
            </div>
          )}
        </section>
        {selectedId && !creating && (
          <aside className="production-detail" aria-label="制作任务详情">
            <button
              className="production-close"
              type="button"
              onClick={() => {
                selectedRef.current = null;
                setSelectedId(null);
                setDetail(null);
              }}
            >
              关闭详情 <AppIcon name="close" />
            </button>
            {detail ? (
              <>
                <span className="production-eyebrow">任务 #{detail.task.number}</span>
                <h2>{detail.task.title}</h2>
                <span className={`production-status state-${detail.task.status}`}>
                  {taskLabel(detail.task)}
                </span>
                {detail.task.bugId && (
                  <button
                    type="button"
                    className="production-link"
                    onClick={() => {
                      if (detail.task.bugId) onOpenBug(detail.task.bugId);
                    }}
                  >
                    打开关联 Bug / 验收 / 填写打回理由
                  </button>
                )}
                <div className="production-detail-meta">
                  <span>提出人：{detail.task.createdBy}</span>
                  <span>分支：{detail.task.branchName ?? "待创建"}</span>
                  <span>提交：{detail.task.latestCommitSha?.slice(0, 12) ?? "尚未交付"}</span>
                  <span>
                    {detail.task.codexModel} · {detail.task.codexReasoningEffort}
                  </span>
                </div>
                <div className="production-actions">
                  <button
                    type="button"
                    disabled={currentBusy}
                    onClick={() => setConfirmation({ tasks: [detail.task], action: "cancel" })}
                  >
                    停止当前制作
                  </button>
                  <button
                    type="button"
                    disabled={currentBusy}
                    onClick={() => void runAction([detail.task], "retry")}
                  >
                    重试
                  </button>
                  {detail.task.status === "closed" ? (
                    <button
                      type="button"
                      disabled={currentBusy}
                      onClick={() => void runAction([detail.task], "reopen")}
                    >
                      重新打开
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={currentBusy || detail.task.status !== "waiting_user"}
                      onClick={() => setConfirmation({ tasks: [detail.task], action: "finish" })}
                    >
                      结束制作
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={currentBusy || detail.task.status !== "waiting_user"}
                    onClick={() => setConfirmation({ tasks: [detail.task], action: "merge" })}
                  >
                    合并并完成
                  </button>
                </div>
                <form
                  className="production-continue"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runAction([detail.task], "continue");
                  }}
                >
                  <label htmlFor="production-continue">补充要求 / 继续修改</label>
                  <textarea
                    id="production-continue"
                    required
                    maxLength={20000}
                    rows={4}
                    value={message}
                    onChange={(event) => {
                      setMessage(event.target.value);
                      try {
                        localStorage.setItem(continuationKey, event.target.value);
                      } catch {
                        /* Preserve in memory. */
                      }
                    }}
                    placeholder="说明要继续修改的内容，沿用当前任务与分支"
                  />
                  {detail.task.bugId ? (
                    <details>
                      <summary>选择 Bug 附件（新附件可在关联 Bug 中添加）</summary>
                      <BugAttachments
                        key={detail.task.bugId}
                        bugId={detail.task.bugId}
                        selected={attachmentChoices[detail.task.bugId] ?? []}
                        onSelect={(ids) =>
                          setAttachmentChoices((current) => ({
                            ...current,
                            [detail.task.bugId ?? ""]: ids,
                          }))
                        }
                      />
                    </details>
                  ) : (
                    <FilePicker files={continueFiles} onChange={setContinueFiles} />
                  )}
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={
                      currentBusy ||
                      !message.trim() ||
                      pending.some((body) => body.items.some((item) => item.taskId === selectedId))
                    }
                  >
                    {currentBusy ? "提交中…" : "发送并继续制作"}
                  </button>
                </form>
                <h3>需求与制作记录</h3>
                {[...detail.turns].reverse().map((turn, index) => (
                  <details className="production-turn" key={turn.id} open={index === 0}>
                    <summary>
                      第 {turn.sequence} 轮 · {label(turn.status)}{" "}
                      <time>{date(turn.createdAt)}</time>
                    </summary>
                    <strong>{turn.authorName}</strong>
                    <pre className="production-text">{turn.userMessage}</pre>
                    <div className="production-actions">
                      {turn.attachments.map((file) => (
                        <button
                          type="button"
                          key={file.id}
                          onClick={() =>
                            void mutate(`download:${file.id}`, () =>
                              downloadProductionFile(projectId, file),
                            )
                          }
                        >
                          <AppIcon name="download" /> {file.filename}
                        </button>
                      ))}
                    </div>
                    {turn.errorMessage && (
                      <p className="banner error-banner">{turn.errorMessage}</p>
                    )}
                    <ResultText value={turn.result} />
                    {turn.commitSha && <small>提交 {turn.commitSha}</small>}
                  </details>
                ))}
                {detail.builds.length > 0 && (
                  <details>
                    <summary>构建与交付</summary>
                    {detail.builds.map((build) => (
                      <p key={build.id}>
                        {label(build.status)} · {build.commitSha?.slice(0, 12)} {build.lastError}
                      </p>
                    ))}
                  </details>
                )}
                {detail.progress.length > 0 && (
                  <details>
                    <summary>进度记录</summary>
                    {detail.progress.slice(-30).map((event) => (
                      <p key={event.id}>
                        <time>{date(event.createdAt)}</time> {event.message}
                      </p>
                    ))}
                  </details>
                )}
              </>
            ) : (
              <p>正在读取任务…</p>
            )}
          </aside>
        )}
      </div>
      {batches.length > 0 && (
        <section className="production-batches">
          <h2>我的提交记录</h2>
          {batches.slice(0, 8).map((batch) => (
            <details
              key={batch.id}
              open={batch.status === "running" || batch.status === "partial_failure"}
            >
              <summary>
                {date(batch.createdAt)} ·{" "}
                {batch.kind === "bugs"
                  ? "批量制作"
                  : batch.kind === "create"
                    ? "新建制作"
                    : "任务操作"}{" "}
                · {batch.items.length} 张 ·{" "}
                {batch.status === "running"
                  ? "提交中"
                  : batch.status === "partial_failure"
                    ? "部分失败"
                    : "已处理"}
              </summary>
              {batch.items.map((item, index) => {
                const bug = bugById.get(item.input.bugId ?? item.result?.bugId ?? ""),
                  task = tasks.find(
                    (task) =>
                      task.id === item.result?.taskId || (task.bugId && task.bugId === bug?.id),
                  );
                return (
                  <div className="production-batch-row" key={index}>
                    <span>
                      {bug?.key ?? (task ? `#${task.number}` : `${index + 1}`)} ·{" "}
                      {bug?.title ?? item.input.title ?? task?.title ?? "任务操作"}
                    </span>
                    <strong>
                      {item.error?.message ??
                        item.delivery?.failureSummary ??
                        (item.status === "existing"
                          ? "已有任务"
                          : task
                            ? taskLabel(task)
                            : item.status === "accepted"
                              ? item.delivery
                                ? `移交：${label(item.delivery.status)}`
                                : "已接收，等待移交"
                              : label(item.status))}
                    </strong>
                    {task && (
                      <button type="button" onClick={() => void openTask(task.id)}>
                        查看
                      </button>
                    )}
                    {item.error && <small>{item.error.code}</small>}
                  </div>
                );
              })}
              {batch.status === "partial_failure" && (
                <button
                  type="button"
                  disabled={busy.has(`retry:${batch.id}`)}
                  onClick={() =>
                    void mutate(`retry:${batch.id}`, async () => {
                      await productionRetry(batch.id, projectId);
                      await refresh();
                    })
                  }
                >
                  重试失败项
                </button>
              )}
            </details>
          ))}
        </section>
      )}
      {creating && (
        <div className="production-modal-overlay">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="production-create-heading"
            className="production-modal"
          >
            <div className="production-modal-heading">
              <div>
                <span className="production-eyebrow">NEW TASK</span>
                <h2 id="production-create-heading">新建制作</h2>
              </div>
              <button type="button" onClick={() => setCreating(false)}>
                收起 · 保留草稿 <AppIcon name="close" />
              </button>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <div className="production-mode">
                <button
                  type="button"
                  aria-pressed={draft.mode === "create"}
                  onClick={() => setDraft((current) => ({ ...current, mode: "create" }))}
                >
                  新建需求
                </button>
                <button
                  type="button"
                  aria-pressed={draft.mode === "bugs"}
                  onClick={() => setDraft((current) => ({ ...current, mode: "bugs" }))}
                >
                  从 QA Bug 批量制作
                </button>
              </div>
              <div className="production-repository">
                <strong>{project?.project.name ?? "仓库连接中"}</strong>
                <span>{project?.project.repoUrl}</span>
                <small>基于 {project?.project.defaultBranch ?? "默认分支"} 创建独立任务分支</small>
              </div>
              {draft.mode === "create" ? (
                <>
                  <label>
                    标题
                    <input
                      required
                      maxLength={200}
                      placeholder="简要描述需要制作或修复的内容"
                      value={draft.title}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, title: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    需求与验收要求
                    <textarea
                      required
                      rows={8}
                      maxLength={20000}
                      placeholder="描述问题、复现步骤、期望行为和验收要求"
                      value={draft.message}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, message: event.target.value }))
                      }
                    />
                  </label>
                  <FilePicker files={files} onChange={setFiles} />
                  {draftHasFiles && <small>文件保留在当前窗口；关闭 EXE 后需重新选择。</small>}
                </>
              ) : (
                <>
                  <div className="production-toolbar">
                    <input
                      aria-label="搜索待制作 Bug"
                      placeholder="搜索 Bug 单号或标题"
                      value={bugSearch}
                      onChange={(event) => setBugSearch(event.target.value)}
                    />
                    <select
                      aria-label="Bug 负责人筛选"
                      value={bugOwner}
                      onChange={(event) => setBugOwner(event.target.value)}
                    >
                      <option value="">全部负责人</option>
                      {members.map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.displayName}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => {
                        setCreating(false);
                        onImport();
                      }}
                    >
                      从轻语导入
                    </button>
                  </div>
                  <div className="production-bug-select">
                    <strong>已选择 {draft.bugIds.length} 张 / 最多 50 张</strong>
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          bugIds: bugChoices.slice(0, 50).map((bug) => bug.id),
                        }))
                      }
                    >
                      选择筛选结果
                    </button>
                    <button
                      type="button"
                      onClick={() => setDraft((current) => ({ ...current, bugIds: [] }))}
                    >
                      清空
                    </button>
                  </div>
                  <div className="production-bug-choices">
                    {bugChoices.map((bug) => (
                      <div
                        key={bug.id}
                        className={`production-bug-choice production-bug-choice-${taskStatusForBugState(bug.state)}`}
                      >
                        <label>
                          <input
                            type="checkbox"
                            checked={draft.bugIds.includes(bug.id)}
                            disabled={!draft.bugIds.includes(bug.id) && draft.bugIds.length >= 50}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                bugIds: event.target.checked
                                  ? [...current.bugIds, bug.id]
                                  : current.bugIds.filter((id) => id !== bug.id),
                              }))
                            }
                          />
                          <span>
                            <strong>
                              {bug.key} · {bug.title}
                            </strong>
                            <small>
                              <span
                                className={`production-bug-status production-bug-status-${taskStatusForBugState(bug.state)}`}
                              >
                                {importStatusLabel(bug)}
                              </span>
                              {" · "}
                              {members.find((m) => m.userId === bug.ownerId)?.displayName ??
                                "未分配"}
                            </small>
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setCreating(false);
                              onOpenBug(bug.id);
                            }}
                          >
                            详情 / 补充附件
                          </button>
                        </label>
                        {draft.bugIds.includes(bug.id) && (
                          <details>
                            <summary>补充要求与选择附件</summary>
                            <textarea
                              rows={2}
                              maxLength={20000}
                              placeholder="此 Bug 的额外制作说明（可选）"
                              value={draft.extra[bug.id] ?? ""}
                              onChange={(event) =>
                                setDraft((current) => ({
                                  ...current,
                                  extra: { ...current.extra, [bug.id]: event.target.value },
                                }))
                              }
                            />
                            <BugAttachments
                              bugId={bug.id}
                              selected={attachmentChoices[bug.id]}
                              onSelect={(ids) =>
                                setAttachmentChoices((current) => ({ ...current, [bug.id]: ids }))
                              }
                            />
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="production-hint">
                    每张 Bug
                    使用完整描述、验收要求和所选附件独立制作。已有任务会直接关联，避免重复创建。
                  </p>
                </>
              )}
              <details className="production-advanced">
                <summary>
                  高级设置 · {draft.execution.codexModel} / {draft.execution.codexReasoningEffort}
                </summary>
                <div className="production-option-grid">
                  <label>
                    模型
                    <select
                      value={draft.execution.codexModel}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          execution: {
                            ...current.execution,
                            codexModel: event.target.value,
                            codexReasoningEffort: "xhigh",
                          },
                        }))
                      }
                    >
                      {Object.keys(project?.models ?? { [defaultExecution.codexModel]: [] }).map(
                        (model) => (
                          <option key={model}>{model}</option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    思考强度
                    <select
                      value={draft.execution.codexReasoningEffort}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          execution: {
                            ...current.execution,
                            codexReasoningEffort: event.target.value,
                          },
                        }))
                      }
                    >
                      {(project?.models[draft.execution.codexModel] ?? ["xhigh"]).map((effort) => (
                        <option key={effort}>{effort}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    制作方式
                    <select
                      value={draft.execution.executionProfile}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          execution: { ...current.execution, executionProfile: event.target.value },
                        }))
                      }
                    >
                      <option value="auto">自动判断</option>
                      <option value="code_only">仅代码修改</option>
                      <option value="unity_asset">Unity 资源制作</option>
                    </select>
                  </label>
                  <label>
                    优先级
                    <input
                      type="number"
                      min={-100}
                      max={100}
                      value={draft.execution.priority}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          execution: { ...current.execution, priority: Number(event.target.value) },
                        }))
                      }
                    />
                  </label>
                  <label className="production-check">
                    <input
                      type="checkbox"
                      checked={draft.execution.codexFastMode}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          execution: { ...current.execution, codexFastMode: event.target.checked },
                        }))
                      }
                    />
                    快速模式
                  </label>
                  <label className="production-check">
                    <input
                      type="checkbox"
                      checked={!draft.execution.autoRelease}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          execution: { ...current.execution, autoRelease: !event.target.checked },
                        }))
                      }
                    />
                    完成后保留制作现场
                  </label>
                </div>
                <label>
                  统一补充要求
                  <textarea
                    rows={3}
                    maxLength={10000}
                    value={draft.execution.extraPrompt}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        execution: { ...current.execution, extraPrompt: event.target.value },
                      }))
                    }
                  />
                </label>
              </details>
              <footer className="production-modal-footer">
                <span>提交后可收起页面，批次会继续执行。</span>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={
                    busy.has("create") ||
                    !project?.project.enabled ||
                    (draft.mode === "bugs" && draft.bugIds.length === 0)
                  }
                >
                  {busy.has("create")
                    ? "正在提交…"
                    : pendingCreate
                      ? "核对上次提交"
                      : draft.mode === "bugs"
                        ? `启动 ${draft.bugIds.length} 张单的制作`
                        : "创建并开始制作"}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
      {confirmation && (
        <div className="production-confirm-overlay">
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="production-confirm-heading"
          >
            <h2 id="production-confirm-heading">
              {confirmation.action === "merge"
                ? "合并并完成"
                : confirmation.action === "finish"
                  ? "结束制作"
                  : "停止制作"}
            </h2>
            <p>
              {confirmation.action === "merge"
                ? "将合并此任务的仓库合并请求，并处理 Relay 关联的轻语缺陷。QA Hub 的人工验收仍需在 Bug 工作台完成。"
                : confirmation.action === "finish"
                  ? "将结束所选制作任务，保留记录和分支。QA Bug 的验收状态保持原有流程。"
                  : "将停止所选任务的当前制作。之后可在原任务中继续。"}
            </p>
            <ul>
              {confirmation.tasks.map((task) => (
                <li key={task.id}>
                  #{task.number} {task.title}
                </li>
              ))}
            </ul>
            <div className="production-actions">
              <button type="button" onClick={() => setConfirmation(null)}>
                取消
              </button>
              <button
                type="button"
                disabled={[...busy].some((key) => key.startsWith("action:"))}
                onClick={() =>
                  void runAction(
                    confirmation.tasks,
                    confirmation.action,
                    confirmation.action === "merge",
                  )
                }
              >
                确认
                {confirmation.action === "merge"
                  ? "合并"
                  : confirmation.action === "finish"
                    ? "结束"
                    : "停止"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
