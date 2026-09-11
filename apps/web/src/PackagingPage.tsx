import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import PackagingProgressPanel from "./PackagingProgress";
import BuildUploadControls from "./BuildUploadControls";
import { useBuildCompatibility } from "./useBuildCompatibility";
import { usePackagingProgress } from "./usePackagingProgress";
import { requestPackagingNotificationPermission } from "./packaging-notifications";
import { QaHubApiError } from "./api";
import { createUploadRequestId } from "./increment-upload-api";
import {
  BUILD_PRESETS,
  getPackagingStatus,
  triggerJenkinsBuild,
  type BuildPreset,
  type PackagingStatus,
} from "./packaging-api";
import "./packaging.css";

function packageLabel(preset: BuildPreset | null): string {
  return BUILD_PRESETS.find((item) => item.id === preset)?.packageLabel ?? "其他构建";
}
function formatSize(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
function submissionError(error: unknown): string {
  const code = error instanceof QaHubApiError ? error.code : null;
  if (code === "JENKINS_PARAMETERS_CHANGED")
    return "Jenkins 的打包选项已变更，请核对 job 后再打包。";
  if (code === "JENKINS_JOB_DISABLED") return "Jenkins 当前已禁用这个打包任务。";
  if (code === "JENKINS_AUTH_FAILED") return "Jenkins 自动登录未成功，请稍后重试。";
  if (code === "JENKINS_SUBMISSION_UNKNOWN" || code === "REQUEST_TIMEOUT" || code === null) {
    return "暂未收到提交结果，Jenkins 可能已接收。请先查看下方排队和构建记录，避免重复打包。";
  }
  return "暂时无法连接打包服务，请稍后重试。";
}
export function PackageDownloads({ status }: { status: PackagingStatus }) {
  const [target, setTarget] = useState("Android/Release");
  const results = (status.artifacts ?? []).filter(
    (r) => r.platform + "/" + r.configuration === target,
  );
  return (
    <section aria-labelledby="package-download-title" className="package-downloads">
      <div className="package-section-heading">
        <h2 id="package-download-title">安装包与热更下载</h2>
        <span>按版本号与构建号排序</span>
      </div>
      <div className="package-target-tabs" role="group" aria-label="下载平台与配置">
        {["Android/Debug", "Android/Release", "iOS/Debug", "iOS/Release"].map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={target === item}
            onClick={() => setTarget(item)}
          >
            {item.replace("/", " ")}
          </button>
        ))}
      </div>
      {status.artifactError ? (
        <p className="banner error-banner">构建产物目录暂时无法读取，稍后自动重试。</p>
      ) : results.length === 0 ? (
        <p className="package-hint">此配置还没有核验完成的构建产物。</p>
      ) : null}
      {results.map((result) => (
        <article className="package-artifact-build" key={result.directory}>
          <div className="package-section-heading">
            <h3>
              {result.platform} {result.configuration} · {result.version}
            </h3>
            <span>
              构建 #{result.buildNumber} · 产品 {result.productId} / 渠道 {result.channelId}
            </span>
          </div>
          <div
            className="package-file-table"
            role="table"
            aria-label={`版本 ${result.version} 构建 ${result.buildNumber} 产物`}
          >
            {[...result.packages, result.hotUpdate].map((file) => (
              <div className="package-file-row" role="row" key={file.url}>
                <span className="package-filename" role="cell">
                  <strong>{file.name}</strong>
                  <small>
                    {file.kind === "zip"
                      ? result.hotUpdateMode === "full"
                        ? "完整热更 ZIP"
                        : "增量热更 ZIP"
                      : file.kind.toUpperCase()}
                  </small>
                </span>
                <span role="cell">{formatSize(file.size)}</span>
                <span role="cell">{result.version}</span>
                <span className="package-file-actions" role="cell">
                  <a className="package-link" href={file.url} target="_blank" rel="noreferrer">
                    下载
                  </a>
                  <details className="package-qr-details">
                    <summary>二维码</summary>
                    <div className="package-qr-popover">
                      <QRCodeSVG
                        value={file.url}
                        size={148}
                        marginSize={2}
                        title={`${file.name} 下载二维码`}
                      />
                      <small>连接内网后扫码下载</small>
                    </div>
                  </details>
                </span>
              </div>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}
export default function PackagingPage({
  active,
  refreshRevision,
  userId = "current",
  onOpen,
  onOpenUpload,
}: {
  active: boolean;
  refreshRevision: number;
  userId?: string;
  onOpen?: () => void;
  onOpenUpload?: (jobId?: string) => void;
}) {
  const [status, setStatus] = useState<PackagingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<BuildPreset | null>(null);
  const submitting = useRef(false);
  const request = useRef(0);
  const completedRefresh = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const id = ++request.current;
    try {
      const value = await getPackagingStatus(signal);
      if (signal?.aborted || id !== request.current) return;
      setStatus(value);
      setError(null);
    } catch {
      if (!signal?.aborted && id === request.current)
        setError("打包服务暂时无法连接，稍后自动重试。");
    }
  }, []);
  const onCompleted = useCallback(() => {
    void refresh();
    clearTimeout(completedRefresh.current);
    completedRefresh.current = setTimeout(() => void refresh(), 6_000);
  }, [refresh]);
  useEffect(() => () => clearTimeout(completedRefresh.current), []);
  const monitor = usePackagingProgress(userId, active, refreshRevision, onCompleted, onOpen);
  const compatibility = useBuildCompatibility(active);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.visibilityState !== "hidden") await refresh(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 10_000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, refreshRevision, refresh]);

  const build = async (preset: BuildPreset) => {
    if (submitting.current) return;
    requestPackagingNotificationPermission();
    submitting.current = true;
    setPending(preset);
    setNotice(null);
    try {
      const receipt = await triggerJenkinsBuild(preset, createUploadRequestId());
      monitor.watch(receipt.queueId);
      setNotice(`${packageLabel(preset)}已提交，排队编号 #${receipt.queueId}。`);
    } catch (cause) {
      setNotice(submissionError(cause));
    } finally {
      submitting.current = false;
      setPending(null);
      void refresh();
    }
  };
  if (!active) return null;
  return (
    <>
      <main className="packaging-page">
        <section className="package-build-panel" aria-labelledby="packaging-title">
          <div className="package-section-heading">
            <div>
              <p className="eyebrow">OZDQP / ANDROID &amp; iOS</p>
              <h1 id="packaging-title">打包与下载</h1>
            </div>
            <span
              className={`package-connection${status?.jenkins && !error ? " is-connected" : ""}`}
            >
              {status?.jenkins && !error
                ? "Jenkins 已连接"
                : status
                  ? "正在重连 Jenkins"
                  : "正在连接 Jenkins…"}
            </span>
          </div>
          <BuildUploadControls
            userId={userId}
            checks={compatibility.batch?.checks}
            checking={compatibility.refreshing}
            checkError={compatibility.error}
            onRefreshChecks={compatibility.refresh}
            disabled={pending !== null || !status?.jenkins?.buildable || error !== null}
            onBuildOnly={(id) => void build(id)}
            onSubmitted={(queueId) => {
              monitor.watch(queueId);
              void refresh();
            }}
            onOpenUpload={onOpenUpload}
          />
          <p className="package-hint">
            选择打包用途，再选择只构建或自动上传。安装包附带完整热更；增量缺少兼容基线时由构建机生成完整热更。
          </p>
          {notice ? (
            <p className="banner pending-banner" role="status">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p className="banner error-banner" role="alert">
              {error} 下方为上次读取的下载列表。
            </p>
          ) : status?.jenkinsError ? (
            <p className="banner error-banner">
              Jenkins 暂时无法连接，正在自动重试；已有文件仍可下载。
            </p>
          ) : status?.jenkins && !status.jenkins.buildable ? (
            <p className="banner error-banner">Jenkins 已禁用当前打包任务。</p>
          ) : null}
        </section>
        <PackagingProgressPanel
          progress={monitor.progress}
          error={monitor.error}
          pendingQueues={[
            ...monitor.pendingQueues.map((id) => ({
              id,
              reason: "已提交，正在等待 Jenkins 分配构建编号",
            })),
            ...(status?.jenkins?.queue ?? []),
          ]}
        />
        {status ? (
          <PackageDownloads status={status} />
        ) : (
          <div className="loading-row">正在读取可下载文件…</div>
        )}
      </main>
    </>
  );
}
