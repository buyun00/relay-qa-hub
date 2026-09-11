import AppIcon from "./AppIcon";
import BuildCompatibilitySummary from "./BuildCompatibilitySummary";
import type { CompatibilityCheck } from "./packaging-api";
import { serverUploader, createUploadRequestId } from "./increment-upload-api";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BuildUploadChain,
  UploadInput,
  UploaderSnapshot,
} from "@relay-qa-hub/upload-contract";
import { uploadDraftDefaults, UPLOAD_MODES } from "./upload-model";
import {
  QUICK_BUILD_PRESETS,
  quickUploadInput,
  type QuickBuildPresetId,
} from "@relay-qa-hub/upload-contract";

const messages: Record<string, string> = {
  UPLOAD_CHANNEL_HELD:
    "已提交，正在等待同产品、渠道的上一任务结束。服务端会自动核对瑞雪发布状态并继续，请勿重复提交。",
  UPLOADER_MISSING: "服务端上传程序暂未就绪，请稍后重试。",
  UPLOAD_QUEUE_BUSY: "服务端正在核对任务，请稍后重试。",
  BUILD_PROJECT_PATH_INVALID: "打包机的 Unity 项目路径配置无效，构建未完成，没有上传。",
  BUILD_ARTIFACT_MISMATCH: "本次构建的版本、平台、产品渠道或 ZIP 哈希不一致，已停止上传。",
  BUILD_RESULT_UNAVAILABLE: "正在等待本次构建的产物核验结果，不会改取其他构建的 ZIP。",
  BUILD_PLATFORM_UNSUPPORTED: "此按钮构建 Android。请在上传增量页选择 iOS，上传已有的 iOS ZIP。",
  AUTH_REQUIRED: "请先到上传增量页登录平台账号。",
  UPLOAD_ACCOUNT_CHANGED: "上传平台账号已切换，自动上传已暂停；切回原账号后继续。",
  BUILD_UPLOAD_ALREADY_STARTED: "上传任务已经启动，请到上传增量页查看。",
  UPLOADER_BUSY: "当前上传尚未结束，完成后会自动衔接。",
  BUILD_CHAIN_ACTIVE: "已有自动上传正在等待打包，请先查看该任务。",
  BUILD_CHAIN_BUSY: "正在核对构建状态，请稍后再试。",
  BUILD_ZIP_CHANGED: "增量包未更新或已被其他构建替换，本次没有自动上传。",
  BUILD_ZIP_UNVERIFIABLE: "无法核对增量包的生成时间，本次没有自动上传。",
  BUILD_NO_ZIP: "本次构建没有生成增量 ZIP，没有自动上传。",
  BUILD_FAILED: "本次打包未成功，没有自动上传。",
  BUILD_QUEUE_UNKNOWN: "暂未找到排队记录，正在继续查询，请勿重复打包。",
  JENKINS_SUBMISSION_UNKNOWN: "提交结果未确认，请核对下方记录，避免重复打包。",
  BUILD_TIMED_OUT: "等待构建超过 24 小时，已停止自动上传。",
  BUILD_IDENTITY_MISMATCH: "构建身份不匹配，已停止自动上传。",
  BUILD_LOG_UNAVAILABLE: "正在等待构建日志恢复，以核对 ZIP 生成结果。",
};
const labels: Record<BuildUploadChain["status"], string> = {
  queued: "服务端等待打包",
  submitting: "正在提交打包",
  submission_unknown: "待核对打包提交结果",
  building: "等待打包完成",
  waiting_zip: "正在核对本次增量包",
  starting_upload: "正在衔接上传增量",
  upload_started: "已衔接上传增量",
  failed: "自动上传已停止",
  cancelled: "已取消自动上传",
};
export function buildUploadError(code: string): string {
  return messages[code] ?? `暂时无法完成操作，稍后重试（${code}）。`;
}
export default function BuildUploadControls({
  userId,
  disabled,
  onBuildOnly,
  onSubmitted,
  onOpenUpload,
  checks,
  checking = false,
  checkError = false,
  onRefreshChecks,
}: {
  userId?: string;
  disabled: boolean;
  onBuildOnly: (preset: QuickBuildPresetId) => void;
  onSubmitted: (queueId: number) => void;
  onOpenUpload?: ((jobId?: string) => void) | undefined;
  checks?: CompatibilityCheck[] | undefined;
  checking?: boolean;
  checkError?: boolean;
  onRefreshChecks?: (() => void) | undefined;
}) {
  const bridge = serverUploader;
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<QuickBuildPresetId>("android-release-app");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [input, setInput] = useState<UploadInput>(() => uploadDraftDefaults(null));
  const [snapshot, setSnapshot] = useState<UploaderSnapshot | null>(null);
  const [checkingUpload, setCheckingUpload] = useState(false);
  const snapshotRequest = useRef(0);
  const [notice, setNotice] = useState("");
  const [chains, setChains] = useState<BuildUploadChain[]>([]);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (!bridge?.buildChains) return;
    try {
      const result = await bridge.buildChains();
      if (result.ok) setChains(result.value);
    } catch {
      /* Server monitor continues while disconnected. */
    }
  }, [bridge]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const toggle = async (selected: QuickBuildPresetId) => {
    if (open && preset === selected) {
      setOpen(false);
      return;
    }
    setError("");
    setPreset(selected);
    setSnapshot(null);
    setCheckingUpload(true);
    const revision = ++snapshotRequest.current;
    try {
      setInput(
        quickUploadInput(
          uploadDraftDefaults(
            JSON.parse(localStorage.getItem(`qa-hub:upload-draft:${userId}`) ?? "{}"),
          ),
          selected,
        ),
      );
    } catch {
      setInput(quickUploadInput(uploadDraftDefaults(null), selected));
    }
    setOpen(true);
    if (bridge) {
      try {
        const result = await bridge.snapshot();
        if (revision !== snapshotRequest.current) return;
        if (result.ok) setSnapshot(result.value);
        else setError(result.code);
      } catch {
        if (revision === snapshotRequest.current) setError("UPLOADER_FAILED");
      } finally {
        if (revision === snapshotRequest.current) setCheckingUpload(false);
      }
    }
  };
  const combined = async () => {
    if (!bridge?.buildAndUpload || busyRef.current) return;
    const existing = chains.find(
      (chain) =>
        chain.canManage !== false &&
        chain.preset === preset &&
        !["failed", "cancelled", "upload_started"].includes(chain.status),
    );
    if (existing) {
      setNotice(`该打包上传任务已经提交（${existing.id.slice(0, 8)}），请查看下方进度。`);
      setOpen(false);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await bridge.buildAndUpload({
        requestId: createUploadRequestId(),
        preset,
        upload: input,
      });
      if (!result.ok) {
        setError(result.code);
        return;
      }
      setOpen(false);
      setNotice(`打包并上传任务已提交（${result.value.id.slice(0, 8)}），服务端正在排队处理。`);
      setChains((current) => [result.value, ...current.filter((c) => c.id !== result.value.id)]);
      if (result.value.queueId) onSubmitted(result.value.queueId);
      await refresh();
    } catch {
      setError("JENKINS_SUBMISSION_UNKNOWN");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const cancel = async (id: string) => {
    if (!bridge || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await bridge.cancelBuildUpload(id);
      if (!result.ok) setError(result.code);
      await refresh();
    } catch {
      setError("BUILD_SERVICE_UNAVAILABLE");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const activeChain = chains.find(
    (c) => !["failed", "cancelled", "upload_started"].includes(c.status),
  );
  const latest = activeChain ?? chains[0];
  const renderChoice = (selection: (typeof QUICK_BUILD_PRESETS)[number]) => (
    <div className="package-external-control" key={selection.id} data-mode={selection.mode}>
      <button
        ref={preset === selection.id ? trigger : undefined}
        className="package-build-button"
        data-build-preset={selection.id}
        aria-label={selection.label}
        type="button"
        disabled={disabled || busy}
        aria-expanded={open && preset === selection.id}
        aria-controls={`build-options-${selection.id}`}
        onClick={() => void toggle(selection.id)}
      >
        <span className="package-choice-title">
          <span>
            <AppIcon name={selection.mode === "App" ? "package" : "folder"} />
            {selection.mode === "App" ? "完整包" : "增量热更"}
          </span>
          <AppIcon name={open && preset === selection.id ? "up" : "down"} size={15} />
        </span>
        <span className="package-choice-files">
          {selection.mode === "Res"
            ? "热更 ZIP"
            : selection.platform === "iOS"
              ? "IPA + 完整热更 ZIP"
              : selection.configuration === "Release"
                ? "APK / AAB + 完整热更 ZIP"
                : "APK + 完整热更 ZIP"}
        </span>
      </button>
      {open && preset === selection.id ? (
        <div
          id={`build-options-${selection.id}`}
          className="package-build-options"
          role="region"
          aria-label={`${selection.label} 操作选项`}
        >
          <strong>选择本次操作</strong>
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => {
              setOpen(false);
              onBuildOnly(selection.id);
            }}
          >
            只构建
          </button>
          <button
            className="package-combined-action"
            type="button"
            disabled={
              busy ||
              disabled ||
              !bridge?.buildAndUpload ||
              !snapshot?.configured ||
              !snapshot.available
            }
            onClick={() => void combined()}
          >
            {busy ? "正在检查并提交…" : "构建完自动上传增量"}
          </button>
          <p>
            产品 {input.productId} · 渠道 {input.channelId} · 测试人 {input.testerId}
          </p>
          <p>版本与本次构建完全一致 · {UPLOAD_MODES.find((m) => m.id === input.mode)?.label}</p>
          <small>
            更新说明只写版本号。服务端在打包成功后自动上传，退出客户端或关闭电脑不影响执行。
          </small>
          {error ? (
            <p className="banner error-banner" role="alert">
              {buildUploadError(error)}
            </p>
          ) : null}
          {checkingUpload ? (
            <p role="status">正在检查上传账号与服务状态…</p>
          ) : !bridge?.buildAndUpload ? (
            <p>服务端上传暂时不可用。</p>
          ) : snapshot && !snapshot.available ? (
            <p>{buildUploadError("UPLOADER_MISSING")}</p>
          ) : snapshot && !snapshot.configured ? (
            <p>请先登录上传平台账号。</p>
          ) : null}
          {onOpenUpload ? (
            <button
              type="button"
              className="package-settings-link"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onOpenUpload();
              }}
            >
              修改上传设置 / 登录账号
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
  return (
    <div className="package-quick-controls" ref={root}>
      {notice ? (
        <p className="banner pending-banner" role="status">
          {notice}
        </p>
      ) : null}
      <div className="package-check-toolbar">
        <span>按对应安装包与最新代码判断 · 每次进入自动刷新</span>
        {onRefreshChecks ? (
          <button type="button" onClick={onRefreshChecks} disabled={checking}>
            <AppIcon name="refresh" busy={checking} size={15} />
            {checking ? "正在检测四组…" : "刷新判断"}
          </button>
        ) : null}
      </div>
      <div className="package-platform-grid">
        {(["Android", "iOS"] as const).map((platform) => (
          <section
            className="package-platform-group"
            key={platform}
            aria-label={platform + " 打包"}
            data-platform={platform}
          >
            <h2>{platform}</h2>
            {(["Debug", "Release"] as const).map((configuration) => (
              <div
                className="package-configuration-group"
                key={configuration}
                aria-label={platform + " " + configuration}
              >
                <h3>
                  <span className="package-configuration-tag" data-configuration={configuration}>
                    {configuration}
                  </span>
                </h3>
                <BuildCompatibilitySummary
                  check={checks?.find(
                    (c) =>
                      c.target.platform === platform && c.target.configuration === configuration,
                  )}
                  unavailable={checkError}
                />
                <div className="package-build-buttons">
                  {QUICK_BUILD_PRESETS.filter(
                    (p) => p.platform === platform && p.configuration === configuration,
                  ).map(renderChoice)}
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
      {latest ? (
        <div className="package-upload-chain" role="status">
          <strong>{labels[latest.status]}</strong>
          {chains.filter((chain) => chain.status === "queued").length > 0 ? (
            <span>
              服务端共有 {chains.filter((chain) => chain.status === "queued").length}{" "}
              条打包上传任务排队，尚未提交 Jenkins 的任务会自动继续。
            </span>
          ) : null}
          <span>
            {latest.buildNumber
              ? `构建 #${latest.buildNumber}`
              : latest.queueId
                ? `排队 #${latest.queueId}`
                : "等待构建"}{" "}
            {latest.buildVersion ? ` · ${latest.buildVersion}` : ""}
            {latest.preset
              ? ` · ${QUICK_BUILD_PRESETS.find((p) => p.id === latest.preset)?.label}`
              : ""}
            · {UPLOAD_MODES.find((m) => m.id === latest.input.mode)?.label}
          </span>
          {latest.errorCode ? <p>{buildUploadError(latest.errorCode)}</p> : null}
          {latest.uploadJobId && onOpenUpload ? (
            <button type="button" onClick={() => onOpenUpload(latest.uploadJobId ?? undefined)}>
              查看上传进度
            </button>
          ) : latest.canManage !== false && !["failed", "cancelled"].includes(latest.status) ? (
            <button type="button" disabled={busy} onClick={() => void cancel(latest.id)}>
              取消自动上传（保留打包）
            </button>
          ) : null}
        </div>
      ) : null}
      {error && !open ? (
        <p className="banner error-banner" role="alert">
          {buildUploadError(error)}
        </p>
      ) : null}
    </div>
  );
}
