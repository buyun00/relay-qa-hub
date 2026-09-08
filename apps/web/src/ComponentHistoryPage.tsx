import { useCallback, useEffect, useRef, useState } from "react";
import type { UploadJob, UploaderSnapshot, BuildUploadChain } from "@relay-qa-hub/upload-contract";
import { QaHubApiError, requestJson } from "./api";
import BuildTasksPanel from "./BuildTasksPanel";
import { type ProjectComponent } from "./project-api";
import { uploadJobLabel } from "./upload-model";
import { serverUploader } from "./increment-upload-api";
import { taskStateLabels } from "./BuildTasksPanel";
import RelayOutboxPanel from "./RelayOutboxPanel";
import {
  listRelayOutbox,
  relayOutboxError,
  relayOutboxResumeReason,
  resumeRelayOutbox,
  type RelayOutboxItem,
} from "./relay-outbox-api";

interface IntegrationHistory {
  id: string;
  componentVersion: number;
  state: string;
  operation?: string;
  createdAt: string;
  updatedAt: string;
  errorCode?: string;
}

export default function ComponentHistoryPage({
  projectId,
  components,
}: {
  projectId: string;
  components: readonly ProjectComponent[];
}) {
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [chains, setChains] = useState<BuildUploadChain[]>([]);
  const [relay, setRelay] = useState<IntegrationHistory[]>([]);
  const [qingyu, setQingyu] = useState<IntegrationHistory[]>([]);
  const [outbox, setOutbox] = useState<RelayOutboxItem[]>([]);
  const [confirmOutbox, setConfirmOutbox] = useState<RelayOutboxItem | null>(null);
  const [held, setHeld] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const loadSequence = useRef(0);
  const enabled = (key: string) =>
    components.some((component) => component.key === key && component.enabled);
  const prefix = `/api/v1/projects/${encodeURIComponent(projectId)}`;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const sequence = ++loadSequence.current;
      const init = signal ? { signal } : undefined;
      const [uploads, chainList, relayList, qingyuList, outboxList] = await Promise.allSettled([
        requestJson(`${prefix}/increment-upload`, init) as Promise<UploaderSnapshot>,
        requestJson(`${prefix}/increment-upload/build-chains`, init) as Promise<BuildUploadChain[]>,
        requestJson(`${prefix}/production/tasks/history`, init) as Promise<{
          items: IntegrationHistory[];
        }>,
        requestJson(`${prefix}/qingyu/history`, init) as Promise<{ items: IntegrationHistory[] }>,
        listRelayOutbox(projectId, signal),
      ]);
      if (
        !signal?.aborted &&
        currentProject.current === projectId &&
        sequence === loadSequence.current
      ) {
        if (uploads.status === "fulfilled") setJobs(uploads.value.jobs);
        if (chainList.status === "fulfilled") setChains(chainList.value);
        if (relayList.status === "fulfilled") setRelay(relayList.value.items);
        if (qingyuList.status === "fulfilled") setQingyu(qingyuList.value.items);
        if (outboxList.status === "fulfilled") setOutbox(outboxList.value.items);
        setError(
          [uploads, chainList, relayList, qingyuList, outboxList].some(
            (item) => item.status === "rejected",
          )
            ? "部分组件历史暂时无法读取，已取得的记录继续显示。"
            : "",
        );
      }
    },
    [prefix, projectId],
  );
  useEffect(() => {
    const controller = new AbortController();
    setJobs([]);
    setChains([]);
    setRelay([]);
    setQingyu([]);
    setOutbox([]);
    setConfirmOutbox(null);
    setHeld(false);
    setNotice("");
    setError("");
    setBusy("");
    void load(controller.signal).catch(() => {
      if (!controller.signal.aborted) setError("上传历史暂时无法读取，记录保留在服务端。");
    });
    return () => controller.abort();
  }, [load]);
  const confirmResumeOutbox = async () => {
    const item = confirmOutbox;
    if (!item || relayOutboxResumeReason(item, projectId, enabled("relay.production"), held))
      return;
    const snapshot = projectId;
    setBusy(`outbox:${item.id}`);
    setError("");
    setNotice("");
    try {
      const result = await resumeRelayOutbox(snapshot, item);
      if (currentProject.current !== snapshot) return;
      ++loadSequence.current;
      setOutbox(result.items);
      setConfirmOutbox(null);
      setNotice("所选交接已恢复等待执行；请刷新查看后续结果。");
    } catch (cause) {
      if (currentProject.current !== snapshot) return;
      if (cause instanceof QaHubApiError && cause.code === "IMPORT_EXECUTION_HELD") setHeld(true);
      setError(relayOutboxError(cause));
      setConfirmOutbox(null);
    } finally {
      if (currentProject.current === snapshot) setBusy("");
    }
  };
  const resume = async (path: string, id: string) => {
    setBusy(id);
    try {
      await requestJson(
        `${prefix}/increment-upload/${path}/${encodeURIComponent(id)}/${path === "jobs" ? "resume-queued" : "resume"}`,
        { method: "POST" },
      );
      if (currentProject.current !== projectId) return;
      await load();
    } catch {
      if (currentProject.current === projectId)
        setError("恢复未完成；请核对组件设置及任务状态后重试。");
    } finally {
      if (currentProject.current === projectId) setBusy("");
    }
  };
  const resumeRelay = async (id: string) => {
    setBusy(id);
    try {
      await requestJson(`${prefix}/production/batches/${encodeURIComponent(id)}/retry`, {
        method: "POST",
      });
      if (currentProject.current !== projectId) return;
      await load();
    } catch {
      if (currentProject.current === projectId)
        setError("恢复未完成；只能恢复本人提交的任务，且需要先启用对应组件。");
    } finally {
      if (currentProject.current === projectId) setBusy("");
    }
  };
  return (
    <main className="project-management-page">
      <h1>组件历史</h1>
      <p>停用组件后，历史任务、日志与产物继续保留。恢复任务需要先启用组件，再明确选择该任务。</p>
      <button
        className="secondary-button"
        disabled={!!busy}
        onClick={() => {
          setHeld(false);
          setNotice("");
          void load();
        }}
      >
        刷新组件历史
      </button>
      <BuildTasksPanel projectId={projectId} enabled={enabled("build")} />
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <RelayOutboxPanel
        projectId={projectId}
        items={outbox}
        enabled={enabled("relay.production")}
        held={held}
        busy={!!busy}
        onResume={setConfirmOutbox}
      />
      {confirmOutbox && confirmOutbox.projectId === projectId && (
        <section
          role="alertdialog"
          aria-label="确认恢复 Relay 交接"
          aria-describedby="resume-outbox-scope"
        >
          <p id="resume-outbox-scope">
            仅恢复项目 {projectId} 的 Bug {confirmOutbox.bugId}，交接 {confirmOutbox.handoffId}
            ，配置版本 {confirmOutbox.componentVersion}。恢复后可继续向该任务保存的 Relay 目标提交。
          </p>
          <button
            className="primary-button"
            disabled={
              !!busy ||
              !!relayOutboxResumeReason(confirmOutbox, projectId, enabled("relay.production"), held)
            }
            onClick={() => void confirmResumeOutbox()}
          >
            确认恢复这一条交接
          </button>
          <button
            className="secondary-button"
            disabled={!!busy}
            onClick={() => setConfirmOutbox(null)}
          >
            保留暂停
          </button>
        </section>
      )}
      <h2>增量上传</h2>
      <ul className="project-history-list">
        {jobs.length === 0 ? (
          <li>暂无上传记录。</li>
        ) : (
          jobs.map((job) => (
            <li key={job.id}>
              <strong>
                {job.input.version || job.id} · {uploadJobLabel(job)}
              </strong>
              <p>
                {job.id} · 配置版本 {job.componentVersion ?? "历史"}
              </p>
              <div className="project-action-row">
                <button
                  className="secondary-button"
                  onClick={() => void serverUploader.openFolder(job.id)}
                >
                  保存任务日志
                </button>
                {job.status === "paused" && (
                  <button
                    className="secondary-button"
                    disabled={!enabled("upload.incremental") || !!busy}
                    onClick={() => void resume("jobs", job.id)}
                  >
                    恢复此上传
                  </button>
                )}
              </div>
            </li>
          ))
        )}
      </ul>
      <h2>单次打包上传</h2>
      <ul className="project-history-list">
        {chains.length === 0 ? (
          <li>暂无打包上传记录。</li>
        ) : (
          chains.map((chain) => (
            <li key={chain.id}>
              <strong>
                {chain.id} ·{" "}
                {chain.status === "paused"
                  ? "已暂停"
                  : chain.status === "upload_started"
                    ? "已衔接上传，请查看上传最终结果"
                    : chain.status === "failed"
                      ? "失败"
                      : chain.status === "cancelled"
                        ? "已取消"
                        : "等待完成"}
              </strong>
              {chain.errorCode && <p>{chain.errorCode}</p>}
              {chain.status === "paused" && (
                <button
                  className="secondary-button"
                  disabled={!enabled("build_upload.single") || !!busy}
                  onClick={() => void resume("build-chains", chain.id)}
                >
                  恢复此打包上传
                </button>
              )}
            </li>
          ))
        )}
      </ul>
      {[
        { label: "Relay AI 制作", items: relay },
        { label: "第三方订单同步", items: qingyu },
      ].map((group) => (
        <section key={group.label}>
          <h2>{group.label}</h2>
          <ul className="project-history-list">
            {group.items.length === 0 ? (
              <li>暂无本地历史记录。</li>
            ) : (
              group.items.map((item) => (
                <li key={item.id}>
                  <strong>
                    {item.operation ?? item.id} · {taskStateLabels[item.state] ?? item.state}
                  </strong>
                  <p>
                    配置版本 {item.componentVersion} · {item.updatedAt}
                  </p>
                  {item.errorCode && <p>{item.errorCode}</p>}
                  {group.label === "Relay AI 制作" && item.state === "paused" && (
                    <button
                      className="secondary-button"
                      disabled={!enabled("relay.production") || !!busy}
                      onClick={() => void resumeRelay(item.id)}
                    >
                      恢复此制作任务
                    </button>
                  )}
                  {group.label === "第三方订单同步" && item.state === "paused" && (
                    <p>启用组件后，请回到原导入或同步入口核对内容并明确重试。</p>
                  )}
                </li>
              ))
            )}
          </ul>
        </section>
      ))}
    </main>
  );
}
