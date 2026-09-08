import { useCallback, useEffect, useState } from "react";
import { requestJson } from "./api";
import { getActiveProjectId } from "./project-context";

export interface BuildTask {
  id: string;
  taskId: string;
  projectId: string;
  componentVersion: number;
  preset: string;
  state: string;
  queueId: number | null;
  buildNumber: number | null;
  errorCode: string | null;
  result?: { artifact?: { url: string; size: number; sha256: string; verifiedAt: string } };
  createdAt: string;
  updatedAt: string;
}
export const taskStateLabels: Record<string, string> = {
  queued: "等待执行",
  paused: "已暂停",
  dispatching: "正在提交",
  running: "正在执行",
  succeeded: "已完成",
  failed: "执行失败",
  uncertain: "结果待核对",
  cancelled: "已取消",
};
export default function BuildTasksPanel({
  projectId = getActiveProjectId(),
  enabled,
  revision = 0,
}: {
  projectId?: string;
  enabled: boolean;
  revision?: number;
}) {
  const [tasks, setTasks] = useState<BuildTask[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const value = (await requestJson(
        `/api/v1/projects/${encodeURIComponent(projectId)}/packaging/tasks`,
        signal ? { signal } : undefined,
      )) as { items: BuildTask[] };
      if (!signal?.aborted) {
        setTasks(value.items);
        setError("");
      }
    },
    [projectId],
  );
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await load(controller.signal);
      } catch {
        if (!controller.signal.aborted) setError("任务历史暂时无法读取。");
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [load, revision]);
  const act = async (task: BuildTask, action: "resume" | "cancel") => {
    setBusy(task.id);
    try {
      await requestJson(
        `/api/v1/projects/${encodeURIComponent(projectId)}/packaging/tasks/${encodeURIComponent(task.id)}/${action}`,
        { method: "POST" },
      );
      await load();
    } catch {
      setError("操作未完成，请刷新任务状态后重试。");
    } finally {
      setBusy("");
    }
  };
  return (
    <section aria-label="项目打包任务">
      <h2>打包任务</h2>
      {error && <p role="alert">{error}</p>}
      <ul className="project-history-list">
        {tasks.length === 0 ? (
          <li>暂无打包任务。</li>
        ) : (
          tasks.map((task) => (
            <li key={task.id}>
              <strong>
                {task.preset} · {taskStateLabels[task.state] ?? task.state}
              </strong>
              <p>
                任务 {task.taskId ?? task.id} · 配置版本 {task.componentVersion}
                {task.queueId ? ` · 排队 #${task.queueId}` : ""}
                {task.buildNumber ? ` · 构建 #${task.buildNumber}` : ""}
              </p>
              {task.errorCode && <p>{task.errorCode}</p>}
              {task.result?.artifact && (
                <p>
                  <a href={task.result.artifact.url} target="_blank" rel="noreferrer">
                    下载本次产物
                  </a>{" "}
                  · SHA-256 <code>{task.result.artifact.sha256}</code>
                </p>
              )}
              <div className="project-action-row">
                {task.state === "paused" && (
                  <button
                    disabled={!enabled || !!busy}
                    className="secondary-button"
                    onClick={() => void act(task, "resume")}
                  >
                    恢复此任务
                  </button>
                )}
                {["queued", "paused"].includes(task.state) && (
                  <button
                    disabled={!!busy}
                    className="secondary-button"
                    onClick={() => void act(task, "cancel")}
                  >
                    取消此任务
                  </button>
                )}
              </div>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
