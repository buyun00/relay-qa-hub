import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { createPortal } from "react-dom";
import PackagingProgressPanel from "./PackagingProgress";
import { usePackagingProgress } from "./usePackagingProgress";
import { QaHubApiError } from "./api";
import {
  BUILD_PRESETS,
  getPackagingStatus,
  triggerJenkinsBuild,
  type BuildPreset,
  type PackageFile,
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
function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
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
  const latest = BUILD_PRESETS.map((preset) => ({
    ...preset,
    file: status.apks.find((file) => file.preset === preset.id),
  }));
  const rows = (files: PackageFile[]) =>
    files.map((file) => (
      <div className="package-file-row" role="row" key={file.url}>
        <span className="package-filename" role="cell">
          <strong>{file.name}</strong>
          <small>{packageLabel(file.preset)}</small>
        </span>
        <span role="cell">{formatSize(file.size)}</span>
        <time role="cell" dateTime={file.modifiedAt}>
          {formatTime(file.modifiedAt)}
        </time>
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
    ));
  return (
    <section aria-labelledby="package-download-title" className="package-downloads">
      <div className="package-section-heading">
        <h2 id="package-download-title">APK 下载</h2>
        <span>按生成时间排序 · {status.apks.length} 个文件</span>
      </div>
      {status.apkError ? (
        <p className="banner error-banner">APK 目录暂时无法读取，稍后自动重试。</p>
      ) : (
        <>
          <div className="package-latest-grid">
            {latest.map(({ id, packageLabel: label, file }) => (
              <article className="package-latest-card" key={id}>
                <div className="package-latest-copy">
                  <span className="package-type">{label}</span>
                  <strong>{file ? "最新 APK" : "暂无 APK"}</strong>
                  {file ? (
                    <>
                      <p title={file.name}>{file.name}</p>
                      <small>
                        {formatSize(file.size)} · {formatTime(file.modifiedAt)}
                      </small>
                      <a
                        className="package-download-button"
                        href={file.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        ↓ 快速下载
                      </a>
                    </>
                  ) : (
                    <p>生成后会自动出现在这里</p>
                  )}
                </div>
                {file ? (
                  <div className="package-latest-qr">
                    <QRCodeSVG
                      value={file.url}
                      size={104}
                      marginSize={2}
                      title={`${label} 最新 APK 下载二维码`}
                    />
                    <small>内网扫码下载</small>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
          {status.apks.length > 0 ? (
            <div className="package-file-table" role="table" aria-label="可下载的 APK">
              <div className="package-file-row package-file-header" role="row">
                <span role="columnheader">文件</span>
                <span role="columnheader">大小</span>
                <span role="columnheader">生成时间</span>
                <span role="columnheader">下载</span>
              </div>
              {rows(status.apks.slice(0, 10))}
              {status.apks.length > 10 ? (
                <details className="package-older">
                  <summary>更早的 APK（{status.apks.length - 10}）</summary>
                  {rows(status.apks.slice(10))}
                </details>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      <div className="package-other-downloads">
        <article className="package-zip-card">
          <div>
            <h2>增量 ZIP</h2>
            <p>_pkg_cfg_2001_1002.zip</p>
            {status.zip ? (
              <>
                <small>
                  {formatSize(status.zip.size)}
                  {status.zip.modifiedAt ? ` · ${formatTime(status.zip.modifiedAt)}` : ""}
                </small>
                <a
                  className="package-download-button"
                  href={status.zip.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  ↓ 下载增量 ZIP
                </a>
              </>
            ) : (
              <small>暂时无法读取增量 ZIP，稍后自动重试。</small>
            )}
          </div>
          {status.zip ? (
            <QRCodeSVG
              value={status.zip.url}
              size={104}
              marginSize={2}
              title="增量 ZIP 下载二维码"
            />
          ) : null}
        </article>
        <article className="package-ipa-card">
          <h2>IPA 下载</h2>
          <p>iOS 包从 IPA 目录下载</p>
          <a
            className="package-link"
            href="http://10.100.5.129:8000/ipa/"
            target="_blank"
            rel="noreferrer"
          >
            打开 IPA 下载目录 ↗
          </a>
          {status.ipaError ? (
            <small>IPA 目录暂时无法读取</small>
          ) : status.ipas[0] ? (
            <>
              <a
                className="package-link package-ipa-file"
                href={status.ipas[0].url}
                target="_blank"
                rel="noreferrer"
              >
                ↓ {status.ipas[0].name}
              </a>
              <small>
                {formatSize(status.ipas[0].size)} · {formatTime(status.ipas[0].modifiedAt)}
              </small>
            </>
          ) : (
            <small>暂无 IPA</small>
          )}
        </article>
      </div>
    </section>
  );
}

export default function PackagingPage({
  active,
  refreshRevision,
  userId = "current",
  onOpen,
}: {
  active: boolean;
  refreshRevision: number;
  userId?: string;
  onOpen?: () => void;
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
  const monitor = usePackagingProgress(userId, active, refreshRevision, onCompleted);
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
    submitting.current = true;
    setPending(preset);
    setNotice(null);
    try {
      const receipt = await triggerJenkinsBuild(preset, crypto.randomUUID());
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
  const notifications = monitor.notices.length
    ? createPortal(
        <div className="package-notifications" aria-label="打包通知">
          {monitor.notices.map((item) => (
            <article className={`package-notification is-${item.kind}`} role="alert" key={item.id}>
              <strong>{item.title}</strong>
              <p>{item.body}</p>
              <div>
                <button
                  type="button"
                  onClick={() => {
                    onOpen?.();
                    monitor.dismiss(item.id);
                  }}
                >
                  查看构建
                </button>
                <button
                  type="button"
                  aria-label="关闭打包通知"
                  onClick={() => monitor.dismiss(item.id)}
                >
                  关闭
                </button>
              </div>
            </article>
          ))}
        </div>,
        document.body,
      )
    : null;
  if (!active) return notifications;
  return (
    <>
      {notifications}
      <main className="packaging-page">
        <section className="package-build-panel" aria-labelledby="packaging-title">
          <div className="package-section-heading">
            <div>
              <p className="eyebrow">OZDQP / ANDROID</p>
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
          <div className="package-build-buttons">
            {BUILD_PRESETS.map(({ id, label }) => (
              <button
                className="package-build-button"
                type="button"
                key={id}
                disabled={pending !== null || !status?.jenkins?.buildable || error !== null}
                onClick={() => void build(id)}
              >
                {pending === id ? "正在提交…" : label}
              </button>
            ))}
          </div>
          <p className="package-hint">
            使用 Jenkins 当前默认参数。内网会自动判断资源更新或整包；下载区展示已生成的文件。
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
