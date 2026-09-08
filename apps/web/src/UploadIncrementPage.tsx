import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  UploadInput,
  UploadJob,
  UploadReply,
  UploaderSnapshot,
} from "../../desktop/src/uploader-types";
import {
  UPLOAD_MODES,
  UPLOAD_STEPS,
  uploadErrorLabel,
  uploadJobLabel,
  uploadProgress,
  uploadStageLabel,
} from "./upload-model";
import "./upload-increment.css";

const EMPTY: UploadInput = {
  productId: "",
  channelId: "",
  belongName: "",
  version: "",
  summary: "",
  description: "",
  mode: "publish_workflow",
  testerId: 0,
  testResultReference: "",
};
const size = (value: number) =>
  value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(2)} GB`
    : `${(value / 1024 ** 2).toFixed(1)} MB`;
const time = (value: string) =>
  Number.isNaN(Date.parse(value))
    ? "—"
    : new Date(value).toLocaleString("zh-CN", { hour12: false });
function unwrap<T>(reply: UploadReply<T>): T {
  if (!reply.ok) throw new Error(reply.code);
  return reply.value;
}

function JobProgress({ job }: { job: UploadJob | undefined }) {
  const progress = job ? uploadProgress(job) : null;
  const steps = UPLOAD_STEPS.slice(
    0,
    job?.input.mode === "upload_only" ? 4 : job?.input.mode === "prepare_test" ? 5 : 6,
  );
  return (
    <section className="upload-card upload-progress" aria-label="任务进度">
      <div className="upload-card-heading">
        <h2>任务进度</h2>
        <span className={`upload-badge ${job?.published ? "is-success" : ""}`}>
          {job
            ? job.active
              ? "进行中"
              : job.status === "succeeded"
                ? "已完成"
                : "待继续"
            : "待开始"}
        </span>
      </div>
      <h3 aria-live="polite">{job ? uploadJobLabel(job) : "准备好后，开始上传"}</h3>
      <p className="upload-muted">
        {job
          ? `${job.input.summary} · ${job.version || "自动版本号"}`
          : "下载、上传、解压与发布的进度会显示在这里。"}
      </p>
      {progress ? (
        <div className="upload-transfer">
          <div>
            <span>{job?.stage === "DOWNLOADING" ? "下载进度" : "上传进度"}</span>
            <strong>{progress.percent === null ? "处理中" : `${progress.percent}%`}</strong>
          </div>
          <progress
            aria-label={job?.stage === "DOWNLOADING" ? "下载进度" : "上传进度"}
            max={100}
            {...(progress.percent === null ? {} : { value: progress.percent })}
          />
          <small>
            {size(progress.completedBytes)}
            {progress.totalBytes ? ` / ${size(progress.totalBytes)}` : ""}
            {progress.totalParts ? ` · 分片 ${progress.completedParts}/${progress.totalParts}` : ""}
          </small>
        </div>
      ) : null}
      <ol className="upload-stages">
        {steps.map((step, index) => {
          const complete = !!job && (job.done.includes(step.done) || job.status === "succeeded");
          const current = !!job && step.stages.includes(job.stage) && !complete;
          return (
            <li key={step.label} className={complete ? "is-complete" : current ? "is-current" : ""}>
              <span>{complete ? "✓" : index + 1}</span>
              <div>
                <strong>{step.label}</strong>
                <small>
                  {complete
                    ? "已完成"
                    : current
                      ? job?.active
                        ? "正在处理"
                        : "等待继续"
                      : "等待前序步骤"}
                </small>
              </div>
            </li>
          );
        })}
      </ol>
      {job?.errorCode && !job.active ? (
        <p role="status" className="upload-callout">
          {uploadErrorLabel(job.errorCode)}
        </p>
      ) : null}
      {job?.pendingAction ? (
        <p className="upload-muted">
          存在待核对操作：{uploadStageLabel(job.pendingAction)}。恢复时会先核对结果。
        </p>
      ) : null}
      {job?.size ? (
        <details className="upload-evidence">
          <summary>文件与版本结果</summary>
          <dl>
            <dt>文件</dt>
            <dd>_pkg_cfg_2001_1002.zip · {size(job.size)}</dd>
            <dt>SHA-256</dt>
            <dd className="upload-hash">{job.sha256}</dd>
            <dt>平台版本 ID</dt>
            <dd>{job.versionId || "尚未创建"}</dd>
            <dt>正式发布</dt>
            <dd>
              {job.published ? `${job.publishTime} · 状态 ${job.remoteStatus}` : "尚未确认正式发布"}
            </dd>
          </dl>
        </details>
      ) : null}
      {job?.events.length ? (
        <details className="upload-evidence">
          <summary>最近处理记录</summary>
          <ol className="upload-event-list">
            {job.events
              .filter((event) => event.kind !== "progress" && event.kind !== "downloadProgress")
              .slice(-15)
              .reverse()
              .map((event, index) => (
                <li key={`${event.at}-${index}`}>
                  <time>{time(event.at)}</time>
                  <span>
                    {event.code ? uploadErrorLabel(event.code) : uploadStageLabel(event.stage)}
                  </span>
                </li>
              ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

export default function UploadIncrementPage({
  active,
  refreshRevision,
  userId,
}: {
  active: boolean;
  refreshRevision: number;
  userId: string;
}) {
  const bridge = typeof window === "undefined" ? undefined : window.qaHubDesktop?.uploader;
  const draftKey = `qa-hub:upload-draft:${userId}`;
  const [form, setForm] = useState<UploadInput>(() => {
    try {
      return { ...EMPTY, ...JSON.parse(localStorage.getItem(draftKey) ?? "{}") } as UploadInput;
    } catch {
      return { ...EMPTY };
    }
  });
  const [snapshot, setSnapshot] = useState<UploaderSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [kind, setKind] = useState<"email" | "subaccount">("email");
  const [busy, setBusy] = useState("");
  const busyRef = useRef(false);
  const refreshSequence = useRef(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState(false);
  const [testDrafts, setTestDrafts] = useState<
    Record<string, { testerId: number; testResultReference: string }>
  >({});
  const job = snapshot?.jobs.find((item) => item.id === selectedId) ?? snapshot?.jobs[0];
  const hasActive = snapshot?.jobs.some((item) => item.active) ?? false;
  const testDraft = job ? (testDrafts[job.id] ?? job.input) : EMPTY;
  const refresh = useCallback(async () => {
    if (!bridge) return;
    const sequence = ++refreshSequence.current;
    try {
      const next = unwrap(await bridge.snapshot());
      if (sequence === refreshSequence.current) setSnapshot(next);
    } catch (error) {
      if (sequence === refreshSequence.current)
        setError(error instanceof Error ? error.message : "UPLOADER_FAILED");
    }
  }, [bridge]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [active, refreshRevision, refresh]);
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify(form));
    } catch {
      /* Keep the in-memory draft if local storage is full. */
    }
  }, [draftKey, form]);
  const action = async (name: string, task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(name);
    setError("");
    setNotice("");
    try {
      await task();
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "UPLOADER_FAILED");
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  };
  const setField = <K extends keyof UploadInput>(key: K, value: UploadInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setReview(false);
  };
  const login = (event: FormEvent) => {
    event.preventDefault();
    if (!bridge) return;
    const secret = password;
    setPassword("");
    void action("login", async () => {
      unwrap(await bridge.login({ account, password: secret, kind }));
      setNotice("登录成功，已验证文件服务访问权限。后续任务会自动续期或登录。");
    });
  };
  const start = () => {
    if (!bridge) return;
    void action("start", async () => {
      const id = unwrap(await bridge.start(form));
      setSelectedId(id);
      setReview(false);
      setNotice("任务已启动，切换页面或关闭窗口后仍会继续运行。");
    });
  };
  const resume = () => {
    if (!bridge || !job) return;
    void action("resume", async () => {
      unwrap(
        await bridge.resume({
          id: job.id,
          testerId: testDraft.testerId,
          testResultReference: testDraft.testResultReference,
        }),
      );
      setNotice("正在恢复原任务，继续使用原增量包和版本。");
    });
  };

  return (
    <div className="upload-page">
      <header className="upload-heading">
        <div>
          <span className="upload-eyebrow">OZDQP · 版本交付</span>
          <h1>上传增量</h1>
          <p>自动获取增量包，一次完成上传、提测与发布。</p>
        </div>
        <span className="upload-badge">本机任务</span>
      </header>
      {!bridge ? (
        <section className="upload-card">
          <h2>请在桌面 EXE 中使用</h2>
          <p>上传工具需要在本机运行。安装最新桌面版本后，可在这里配置账号并启动任务。</p>
        </section>
      ) : (
        <>
          {error ? (
            <p className="banner error-banner" role="alert">
              {uploadErrorLabel(error)}
            </p>
          ) : null}
          {notice ? (
            <p className="upload-callout is-success" role="status">
              {notice}
            </p>
          ) : null}
          {snapshot && !snapshot.available ? (
            <p className="banner error-banner">{uploadErrorLabel("UPLOADER_MISSING")}</p>
          ) : null}
          {snapshot?.unreadableJobs ? (
            <p className="upload-callout">
              有 {snapshot.unreadableJobs} 条本机记录暂时无法读取，原文件已保留。
            </p>
          ) : null}
          {snapshot?.authError ? (
            <p className="upload-callout">本机登录配置无法读取，请重新登录保存。任务记录已保留。</p>
          ) : null}
          <details
            className="upload-card upload-account"
            open={snapshot?.configured === false ? true : undefined}
          >
            <summary>
              <span>
                <strong>平台账号</strong>
                <small>
                  {snapshot?.configured
                    ? `${snapshot.account || "已保存账号"} · ${snapshot.kind === "subaccount" ? "子账号" : "邮箱登录"}`
                    : "首次使用请先登录"}
                </small>
              </span>
              <span className="upload-badge">{snapshot?.configured ? "已配置" : "未配置"}</span>
            </summary>
            <form onSubmit={login} className="upload-account-form">
              <label>
                登录方式
                <select
                  value={kind}
                  disabled={!!busy || hasActive}
                  onChange={(event) => setKind(event.target.value as "email" | "subaccount")}
                >
                  <option value="email">邮箱账号</option>
                  <option value="subaccount">子账号</option>
                </select>
              </label>
              <label>
                账号
                <input
                  autoComplete="username"
                  maxLength={200}
                  required
                  value={account}
                  onChange={(event) => setAccount(event.target.value)}
                  placeholder={snapshot?.account || "输入平台账号"}
                  disabled={!!busy || hasActive}
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  autoComplete="current-password"
                  maxLength={1000}
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={!!busy || hasActive}
                />
              </label>
              <button type="submit" className="upload-primary" disabled={!!busy || hasActive}>
                {busy === "login" ? "正在登录…" : "登录并保存"}
              </button>
            </form>
            <div className="upload-account-footer">
              <small>账号密码按工具约定保存在本机，后续自动登录。</small>
              <div>
                <button
                  type="button"
                  disabled={!!busy || hasActive || !snapshot?.configured}
                  onClick={() =>
                    void action("check", async () => {
                      unwrap(await bridge.checkAuth());
                      setNotice("登录检查通过，当前账号可以访问上传文件服务。");
                    })
                  }
                >
                  {busy === "check" ? "检查中…" : "检查登录"}
                </button>
                <button
                  type="button"
                  disabled={!!busy || hasActive || !snapshot?.configured}
                  onClick={() =>
                    void action("logout", async () => {
                      unwrap(await bridge.logout());
                      setNotice("已清除本工具的本地登录配置。");
                    })
                  }
                >
                  退出平台账号
                </button>
              </div>
            </div>
          </details>
          <div className="upload-grid">
            <section className="upload-card">
              <div className="upload-card-heading">
                <h2>新建上传任务</h2>
                <span className="upload-muted">每次新任务获取最新包</span>
              </div>
              <div className="upload-source">
                <span>ZIP</span>
                <div>
                  <strong>_pkg_cfg_2001_1002.zip</strong>
                  <small>从内网构建服务自动下载并校验</small>
                  <details>
                    <summary>查看固定下载地址</summary>
                    <code>
                      {snapshot?.sourceUrl ??
                        "http://10.100.5.129:8000/pkg_zip/ozdqp/_pkg_cfg_2001_1002.zip?download=true"}
                    </code>
                  </details>
                </div>
              </div>
              <form
                className="upload-task-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  setReview(true);
                }}
              >
                <div className="upload-field-pair">
                  <label>
                    产品 ID
                    <input
                      required
                      inputMode="numeric"
                      pattern="[1-9][0-9]*"
                      maxLength={20}
                      value={form.productId}
                      placeholder="例如 2002"
                      onChange={(event) => setField("productId", event.target.value)}
                    />
                  </label>
                  <label>
                    渠道 ID
                    <input
                      required
                      inputMode="numeric"
                      pattern="[1-9][0-9]*"
                      maxLength={20}
                      value={form.channelId}
                      placeholder="例如 1002"
                      onChange={(event) => setField("channelId", event.target.value)}
                    />
                  </label>
                </div>
                <label>
                  产品 / 渠道名称
                  <input
                    required
                    maxLength={300}
                    value={form.belongName}
                    placeholder="例如 [2002]Baloot Go|[1002]谷歌-国际正式"
                    onChange={(event) => setField("belongName", event.target.value)}
                  />
                </label>
                <label>
                  版本号 <span className="upload-muted">留空由平台生成</span>
                  <input
                    maxLength={80}
                    pattern="[0-9A-Za-z][0-9A-Za-z._-]*"
                    value={form.version}
                    placeholder="自动使用下一个版本"
                    onChange={(event) => setField("version", event.target.value)}
                  />
                </label>
                <label>
                  版本概述
                  <input
                    required
                    maxLength={300}
                    value={form.summary}
                    placeholder="本次更新的简短概述"
                    onChange={(event) => setField("summary", event.target.value)}
                  />
                </label>
                <label>
                  更新说明
                  <textarea
                    required
                    rows={3}
                    maxLength={10000}
                    value={form.description}
                    placeholder="填写本次变更内容"
                    onChange={(event) => setField("description", event.target.value)}
                  />
                </label>
                <fieldset className="upload-mode-picker">
                  <legend>执行到哪一步</legend>
                  {UPLOAD_MODES.map((mode) => (
                    <label key={mode.id} className={form.mode === mode.id ? "is-selected" : ""}>
                      <input
                        type="radio"
                        name="upload-mode"
                        value={mode.id}
                        checked={form.mode === mode.id}
                        onChange={() => setField("mode", mode.id)}
                      />
                      <span>
                        <strong>{mode.label}</strong>
                        <small>{mode.description}</small>
                      </span>
                    </label>
                  ))}
                </fieldset>
                {form.mode === "publish_workflow" ? (
                  <details className="upload-test-input">
                    <summary>
                      测试结论 <span>可在提测后补充</span>
                    </summary>
                    <p>这里登记已有测试结果，不执行游戏测试。未填写时，任务会在提测后等待。</p>
                    <label>
                      平台测试人 ID
                      <input
                        type="number"
                        min={1}
                        max={2147483647}
                        step={1}
                        value={form.testerId || ""}
                        onChange={(event) => setField("testerId", Number(event.target.value))}
                      />
                    </label>
                    <label>
                      实际测试结论引用
                      <textarea
                        rows={2}
                        maxLength={2000}
                        value={form.testResultReference}
                        placeholder="本次测试报告链接或结论记录编号"
                        onChange={(event) => setField("testResultReference", event.target.value)}
                      />
                    </label>
                  </details>
                ) : null}
                {review ? (
                  <div className="upload-review" role="region" aria-label="确认上传任务">
                    <strong>
                      本次执行：{UPLOAD_MODES.find((mode) => mode.id === form.mode)?.label}
                    </strong>
                    <p>
                      {form.belongName}
                      <br />
                      产品 {form.productId} · 渠道 {form.channelId} · 版本{" "}
                      {form.version || "自动生成"}
                    </p>
                    <p>
                      {form.mode === "publish_workflow"
                        ? form.testerId && form.testResultReference.trim()
                          ? "将使用已填写的测试结论继续正式发布。"
                          : "将先上传并提测，等待补齐测试结论后再继续发布。"
                        : "按所选流程终点完成本次任务。"}
                    </p>
                    <button
                      className="upload-primary"
                      type="button"
                      onClick={start}
                      disabled={!!busy || hasActive || !snapshot?.configured || !snapshot.available}
                    >
                      {busy === "start" ? "正在启动…" : "确认并开始"}
                    </button>
                    <button type="button" onClick={() => setReview(false)}>
                      返回修改
                    </button>
                  </div>
                ) : (
                  <button
                    type="submit"
                    className="upload-primary upload-start"
                    disabled={!!busy || hasActive || !snapshot?.configured || !snapshot.available}
                  >
                    {hasActive ? "当前任务正在运行" : "检查并开始上传"}
                  </button>
                )}
              </form>
            </section>
            <div className="upload-right">
              <JobProgress job={job} />
              {job && !job.active && job.status !== "succeeded" ? (
                <section className="upload-card upload-resume">
                  <h2>继续此任务</h2>
                  <p>继续使用原版本和原增量包，已完成的步骤会保留。</p>
                  {job.input.mode === "publish_workflow" ? (
                    <>
                      <label>
                        平台测试人 ID
                        <input
                          type="number"
                          min={1}
                          max={2147483647}
                          step={1}
                          disabled={job.testResultLocked || !!busy}
                          value={testDraft.testerId || ""}
                          onChange={(event) =>
                            setTestDrafts((drafts) => ({
                              ...drafts,
                              [job.id]: { ...testDraft, testerId: Number(event.target.value) },
                            }))
                          }
                        />
                      </label>
                      <label>
                        实际测试结论引用
                        <textarea
                          rows={2}
                          maxLength={2000}
                          disabled={job.testResultLocked || !!busy}
                          value={testDraft.testResultReference}
                          onChange={(event) =>
                            setTestDrafts((drafts) => ({
                              ...drafts,
                              [job.id]: { ...testDraft, testResultReference: event.target.value },
                            }))
                          }
                        />
                      </label>
                      {job.testResultLocked ? (
                        <small>测试状态登记已开始，以上结论已锁定。</small>
                      ) : (
                        <small>填写本次真实测试结论后，可恢复完整发布流程。</small>
                      )}
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="upload-primary"
                    disabled={!!busy || hasActive}
                    onClick={resume}
                  >
                    {busy === "resume" ? "正在恢复…" : "恢复任务"}
                  </button>
                </section>
              ) : null}
            </div>
          </div>
          <section className="upload-card upload-history">
            <div className="upload-card-heading">
              <h2>本机上传记录</h2>
              <span className="upload-muted">
                {snapshot?.jobs.length ?? 0} 个任务 · 切换页面持续执行
              </span>
            </div>
            {snapshot?.jobs.length ? (
              <div className="upload-history-list">
                {snapshot.jobs.map((item) => (
                  <div
                    className={`upload-history-row ${item.id === job?.id ? "is-selected" : ""}`}
                    key={item.id}
                  >
                    <button
                      className="upload-history-select"
                      type="button"
                      onClick={() => setSelectedId(item.id)}
                      aria-pressed={item.id === job?.id}
                    >
                      <span>
                        <strong>{item.input.summary}</strong>
                        <small>
                          {item.version || "自动版本"} · 产品 {item.input.productId} / 渠道{" "}
                          {item.input.channelId}
                        </small>
                      </span>
                      <span>
                        <strong>{uploadJobLabel(item)}</strong>
                        <small>{time(item.createdAt)}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void action("folder", async () => {
                          unwrap(await bridge.openFolder(item.id));
                        })
                      }
                    >
                      打开记录目录
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="upload-empty">
                还没有上传任务。开始后，断点、处理记录和最终结果会自动保存在本机。
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
