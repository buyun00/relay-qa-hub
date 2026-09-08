import AppIcon from "./AppIcon";
import { serverUploader, createUploadRequestId } from "./increment-upload-api";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BuildUploadChain,
  UploadInput,
  UploaderSnapshot,
} from "@relay-qa-hub/upload-contract";
import { uploadDraftDefaults, UPLOAD_MODES, uploadPlatform } from "./upload-model";

const messages: Record<string, string> = {
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
  submitting: "正在提交外网打包",
  submission_unknown: "待核对打包提交结果",
  building: "等待外网打包完成",
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
}: {
  userId?: string;
  disabled: boolean;
  onBuildOnly: () => void;
  onSubmitted: (queueId: number) => void;
  onOpenUpload?: ((jobId?: string) => void) | undefined;
}) {
  const bridge = serverUploader;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [input, setInput] = useState<UploadInput>(() => uploadDraftDefaults(null));
  const [snapshot, setSnapshot] = useState<UploaderSnapshot | null>(null);
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
  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setError("");
    setSnapshot(null);
    try {
      setInput(
        uploadDraftDefaults(
          JSON.parse(localStorage.getItem(`qa-hub:upload-draft:${userId}`) ?? "{}"),
        ),
      );
    } catch {
      setInput(uploadDraftDefaults(null));
    }
    setOpen(true);
    if (bridge) {
      try {
        const result = await bridge.snapshot();
        if (result.ok) setSnapshot(result.value);
        else setError(result.code);
      } catch {
        setError("UPLOADER_FAILED");
      }
    }
  };
  const combined = async () => {
    if (!bridge?.buildAndUpload || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await bridge.buildAndUpload({
        requestId: createUploadRequestId(),
        upload: input,
      });
      if (!result.ok) {
        setError(result.code);
        return;
      }
      setOpen(false);
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
  return (
    <div className="package-external-control" ref={root}>
      <button
        ref={trigger}
        className="package-build-button"
        type="button"
        disabled={disabled || busy}
        aria-expanded={open}
        aria-controls="external-build-options"
        onClick={() => void toggle()}
      >
        打外网包 <AppIcon name={open ? "up" : "down"} />
      </button>
      {open ? (
        <div
          id="external-build-options"
          className="package-build-options"
          role="region"
          aria-label="外网打包选项"
        >
          <strong>选择本次操作</strong>
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => {
              setOpen(false);
              onBuildOnly();
            }}
          >
            仅打外网包
          </button>
          <button
            className="package-combined-action"
            type="button"
            disabled={
              busy ||
              disabled ||
              !bridge?.buildAndUpload ||
              !snapshot?.configured ||
              !snapshot.available ||
              uploadPlatform(input) === "ios"
            }
            onClick={() => void combined()}
          >
            {busy ? "正在检查并提交…" : "打包并上传增量"}
          </button>
          <p>
            产品 {input.productId} · 渠道 {input.channelId} · 测试人 {input.testerId}
          </p>
          {uploadPlatform(input) === "ios" ? <p>{messages.BUILD_PLATFORM_UNSUPPORTED}</p> : null}
          <p>
            版本 {input.version || "自动生成"} ·{" "}
            {UPLOAD_MODES.find((m) => m.id === input.mode)?.label}
          </p>
          <small>
            更新说明只写版本号。服务端在打包成功后自动上传，退出客户端或关闭电脑不影响执行。
          </small>
          {!bridge?.buildAndUpload ? (
            <p>服务端上传暂时不可用。</p>
          ) : !snapshot?.configured ? (
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
      {latest ? (
        <div className="package-upload-chain" role="status">
          <strong>{labels[latest.status]}</strong>
          <span>
            {latest.buildNumber
              ? `构建 #${latest.buildNumber}`
              : latest.queueId
                ? `排队 #${latest.queueId}`
                : "外网包"}{" "}
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
      {error ? (
        <p className="banner error-banner" role="alert">
          {buildUploadError(error)}
        </p>
      ) : null}
    </div>
  );
}
