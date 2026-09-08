import AppIcon from "./AppIcon";
import { BUILD_PRESETS, type BuildProgress, type PackagingProgress } from "./packaging-api";

export function duration(ms: number | null): string {
  if (ms === null) return "未记录";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`
    : seconds >= 60
      ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
      : `${seconds} 秒`;
}
const STATES: Record<string, string> = {
  BUILDING: "打包中",
  SUCCESS: "已完成",
  FAILURE: "失败",
  ABORTED: "已取消",
  UNSTABLE: "不稳定",
  NOT_BUILT: "未执行",
  UNKNOWN: "待确认",
};
const STAGES = {
  waiting: "等待",
  running: "进行中",
  complete: "完成",
  skipped: "跳过",
  failed: "中止于此",
};

function ProgressMeter({
  label,
  value,
  active = false,
  tone = "running",
}: {
  label: string;
  value: number | null;
  active?: boolean;
  tone?: "running" | "success" | "warning" | "failure" | "paused";
}) {
  const percent = value === null ? undefined : Math.max(0, Math.min(100, value));
  return (
    <div
      className={`package-meter is-${tone}${active ? " is-active" : ""}${percent === undefined ? " is-indeterminate" : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={percent === undefined ? "等待进度数据" : `${percent}%`}
    >
      <span
        className="package-meter-fill"
        style={percent === undefined ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

export function BuildStages({ build }: { build: BuildProgress }) {
  return (
    <div className="package-stage-list">
      {build.logError ? (
        <p className="package-progress-warning" role="status">
          阶段日志暂时无法读取，正在重试；构建状态来自 Jenkins。
        </p>
      ) : (
        build.stages.map((stage, index) => (
          <article
            className={`package-stage is-${stage.state}${stage.alert ? " has-alert" : ""}`}
            key={stage.id}
          >
            <span className="package-stage-dot" aria-hidden="true">
              {stage.state === "complete" ? (
                <AppIcon name="check" size={15} />
              ) : stage.state === "skipped" ? (
                <AppIcon name="minus" size={15} />
              ) : stage.state === "running" ? (
                <AppIcon name="loader" busy size={15} />
              ) : (
                index + 1
              )}
            </span>
            <div className="package-stage-work">
              <strong>
                {stage.label} <small>{STAGES[stage.state]}</small>
              </strong>
              <p>{stage.work}</p>
              <small>执行：{build.executor}</small>
              {stage.state === "running" ? (
                <div className="package-stage-meter">
                  <ProgressMeter
                    label={`${stage.label}阶段进度${stage.percent === null ? "，等待耗时样本" : "，估算"}`}
                    value={stage.percent}
                    active
                    tone={stage.alert ? "warning" : "running"}
                  />
                  <small>
                    {stage.percent === null
                      ? "正在执行，等待阶段完成信号"
                      : `估算 ${stage.percent}%`}
                  </small>
                </div>
              ) : null}
              {stage.alert ? (
                <p className="package-stage-alert" role="alert">
                  ⚠ 耗时异常 · 已超过 {duration(stage.alertAfterMs)}，请检查此阶段；任务继续执行。
                </p>
              ) : null}
            </div>
            <div className="package-stage-time">
              <strong>
                {stage.state === "skipped"
                  ? "无需执行"
                  : stage.state === "waiting"
                    ? "—"
                    : `${stage.timing === "observed" ? "≥ " : ""}${duration(stage.elapsedMs)}`}
              </strong>
              {stage.toolElapsedMs !== null && stage.elapsedMs === null ? (
                <small>Gradle 编译：{duration(stage.toolElapsedMs)}</small>
              ) : null}
              {stage.expectedMs !== null ? (
                <small>
                  历史中位 {duration(stage.expectedMs)} · {stage.sampleCount} 次
                </small>
              ) : (
                <small>
                  {stage.timing === "observed" ? "从首次观测开始计时" : "暂无同类阶段计时样本"}
                </small>
              )}
              {build.status === "BUILDING" && stage.state !== "skipped" ? (
                <small>
                  警戒 {duration(stage.alertAfterMs)} ·{" "}
                  {stage.alertBasis === "history" ? "历史基线" : "初始阈值"}
                </small>
              ) : null}
            </div>
          </article>
        ))
      )}
    </div>
  );
}

function BuildHeading({ build }: { build: BuildProgress }) {
  return (
    <>
      <strong>
        #{build.number} ·{" "}
        {BUILD_PRESETS.find((p) => p.id === build.preset)?.packageLabel ?? "其他构建"}
      </strong>
      <span>
        {STATES[build.status] ?? build.status} ·{" "}
        {build.mode === "Res"
          ? "仅资源"
          : build.mode === "Script"
            ? "仅包体"
            : build.mode === "App"
              ? "资源和包体"
              : "正在判断流程"}{" "}
        · 执行{" "}
        {duration(
          build.executionElapsedMs === undefined ? build.elapsedMs : build.executionElapsedMs,
        )}
        {build.queueWait
          ? ` · 排队 ${build.queueWait.timing === "observed" ? "≥ " : ""}${duration(build.queueWait.elapsedMs)}`
          : ""}
      </span>
    </>
  );
}

export default function PackagingProgressPanel({
  progress,
  error,
  pendingQueues = [],
}: {
  progress: PackagingProgress | null;
  error: boolean;
  pendingQueues?: { id: number; reason: string }[];
}) {
  const current =
    progress?.builds.filter((build) => build.status === "BUILDING" && !build.queueWait?.active) ??
    [];
  const waiting =
    progress?.builds.filter((build) => build.status === "BUILDING" && build.queueWait?.active) ??
    [];
  const history = progress?.builds.filter((build) => build.status !== "BUILDING") ?? [];
  const queues = [
    ...(progress?.queues ?? []),
    ...pendingQueues
      .filter(
        (q, i) =>
          pendingQueues.findIndex((p) => p.id === q.id) === i &&
          !progress?.queues.some((p) => p.id === q.id) &&
          !progress?.builds.some((b) => b.queueId === q.id),
      )
      .map((q) => ({ ...q, status: "QUEUED" as const })),
  ].filter((queue) => queue.status !== "CANCELLED");
  const hasActiveBuild = current.length > 0 || waiting.length > 0 || queues.length > 0;
  if (!hasActiveBuild && !history.length && !error) return null;
  return (
    <section
      className={`package-progress-panel${hasActiveBuild ? "" : " is-idle"}`}
      aria-labelledby={hasActiveBuild ? "package-progress-title" : undefined}
    >
      {hasActiveBuild ? (
        <div className="package-section-heading">
          <h2 id="package-progress-title">构建进度</h2>
          <span>
            {progress
              ? `更新于 ${new Date(progress.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}`
              : "正在读取历史与阶段…"}
          </span>
        </div>
      ) : null}
      {error ? (
        <p className="package-progress-warning" role="status">
          进度连接暂时中断，显示上次读取的结果，正在自动重连。
        </p>
      ) : null}
      {queues.map((queue) => (
        <div className="package-queued-progress" key={queue.id}>
          <strong>
            排队 #{queue.id} · {queue.status === "UNKNOWN" ? "状态待确认" : "等待执行"}
          </strong>
          <ProgressMeter label={`排队 ${queue.id}`} value={null} active />
          <p>{queue.reason}</p>
        </div>
      ))}
      {waiting.map((build) => (
        <div className="package-queued-progress" key={`build-${build.number}`} role="status">
          <strong>构建 #{build.number} · 正在排队</strong>
          <ProgressMeter
            label={`构建 ${build.number} 正在排队`}
            value={null}
            active
            tone="paused"
          />
          <p>
            {build.queueWait?.blockingBuild
              ? `正在等待 ${build.queueWait.blockingBuild} 完成并释放构建环境。`
              : "已有构建占用环境，正在等待可用环境。"}
          </p>
          <p>
            已排队 {build.queueWait?.timing === "observed" ? "≥ " : ""}
            {duration(build.queueWait?.elapsedMs ?? null)} · 等待期间不计入准备环境耗时
          </p>
          {build.logError ? <p>日志暂时无法读取，显示上次排队状态，正在重试。</p> : null}
        </div>
      ))}
      {current.map((build) => (
        <article className="package-current-build" key={build.number}>
          <div className="package-current-heading">
            <BuildHeading build={build} />
          </div>
          <div className="package-overall-progress">
            <ProgressMeter
              label={`构建 ${build.number} 总进度`}
              value={build.percent}
              active={build.status === "BUILDING"}
              tone={
                build.status === "SUCCESS"
                  ? "success"
                  : build.status === "FAILURE"
                    ? "failure"
                    : build.status === "UNSTABLE" || build.stages.some((stage) => stage.alert)
                      ? "warning"
                      : build.status === "BUILDING"
                        ? "running"
                        : "paused"
              }
            />
            <strong>{build.percent}%</strong>
          </div>
          <div className="package-build-meta">
            <span>发起人：{build.triggeredBy}</span>
            <span>
              {build.expectedMs !== null
                ? `同类构建通常 ${duration(build.expectedMs)}`
                : "正在积累同类构建耗时"}
            </span>
            <span>
              {build.status === "BUILDING"
                ? "百分比按已完成阶段与历史耗时估算"
                : "状态已由 Jenkins 确认"}
            </span>
          </div>
          <BuildStages build={build} />
        </article>
      ))}
      {history.length ? (
        <details className="package-progress-history">
          <summary>历史构建与阶段耗时（{history.length}）</summary>
          <p className="package-hint">
            按内外网、SDK、实际构建方式和 ZIP
            流程比较成功构建。旧日志未记录的阶段耗时显示“未记录”；后续构建自动积累时间戳。历史样本不足
            3 次时使用初始警戒线。
          </p>
          {history.map((build) => (
            <details className="package-history-build" key={build.number}>
              <summary>
                <BuildHeading build={build} />
              </summary>
              <p className="package-build-meta">
                {new Date(build.startedAt).toLocaleString("zh-CN", { hour12: false })} · 发起人：
                {build.triggeredBy}
              </p>
              <BuildStages build={build} />
            </details>
          ))}
        </details>
      ) : null}
    </section>
  );
}
