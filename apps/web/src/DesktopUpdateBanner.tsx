import { useEffect, useState } from "react";

type DesktopUpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "installing"
  | "error";

interface DesktopUpdateStatus {
  readonly phase: DesktopUpdatePhase;
  readonly currentVersion: string;
  readonly availableVersion: string | null;
  readonly progressPercent: number | null;
  readonly checkedAt: string | null;
  readonly errorCode: string | null;
}

interface DesktopUpdateBridge {
  readonly getUpdateStatus: () => Promise<DesktopUpdateStatus>;
  readonly checkForUpdates: () => Promise<DesktopUpdateStatus>;
  readonly installUpdate: () => Promise<boolean>;
  readonly onUpdateStatus: (listener: (status: DesktopUpdateStatus) => void) => () => void;
}

interface DesktopUpdateWindow extends Window {
  readonly qaHubDesktop?: DesktopUpdateBridge;
}

function statusText(status: DesktopUpdateStatus): string {
  switch (status.phase) {
    case "disabled":
      return `当前版本 ${status.currentVersion}；开发模式不执行自动更新。`;
    case "idle":
      return `当前版本 ${status.currentVersion}，将在后台自动检查更新。`;
    case "checking":
      return "正在安全检查新版本……";
    case "available":
      return `发现 ${status.availableVersion ?? "新版本"}，正在准备下载。`;
    case "downloading":
      return `正在下载 ${status.availableVersion ?? "新版本"}：${status.progressPercent ?? 0}%`;
    case "downloaded":
      return `${status.availableVersion ?? "新版本"} 已下载并完成校验，可以重启安装。`;
    case "up-to-date":
      return `当前 ${status.currentVersion} 已是最新版本。`;
    case "installing":
      return "正在退出并安装更新，完成后会自动重新打开。";
    case "error":
      return `更新检查失败${status.errorCode === null ? "" : `（${status.errorCode}）`}，可稍后重试。`;
  }
}

export function DesktopUpdateBanner() {
  const bridge =
    typeof window === "undefined" ? undefined : (window as DesktopUpdateWindow).qaHubDesktop;
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (bridge === undefined) return;
    let active = true;
    void bridge.getUpdateStatus().then((next) => {
      if (active) setStatus(next);
    });
    const unsubscribe = bridge.onUpdateStatus((next) => {
      if (active) setStatus(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);

  if (bridge === undefined || status === null) return null;

  const canCheck =
    status.phase === "idle" || status.phase === "up-to-date" || status.phase === "error";
  const canInstall = status.phase === "downloaded";

  const performAction = async (): Promise<void> => {
    if (!canCheck && !canInstall) return;
    setSubmitting(true);
    try {
      if (canInstall) await bridge.installUpdate();
      else setStatus(await bridge.checkForUpdates());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section aria-label="桌面应用更新" className={`desktop-update desktop-update--${status.phase}`}>
      <div>
        <strong>桌面应用更新</strong>
        <p aria-live="polite">{statusText(status)}</p>
      </div>
      {(canCheck || canInstall) && (
        <button
          className={canInstall ? "primary-button" : "secondary-button"}
          disabled={submitting}
          onClick={() => void performAction()}
          type="button"
        >
          {canInstall ? "重启并安装" : "检查更新"}
        </button>
      )}
    </section>
  );
}
