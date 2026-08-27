import { useEffect, useState } from "react";

type DesktopUpdateState = Awaited<
  ReturnType<NonNullable<typeof window.qaHubDesktop>["getUpdateState"]>
>;

export default function DesktopUpdateNotice() {
  const bridge = window.qaHubDesktop;
  const [state, setState] = useState<DesktopUpdateState | null>(null);

  useEffect(() => {
    if (bridge === undefined) return;
    let active = true;
    void bridge
      .getUpdateState()
      .then((next) => {
        if (active) setState(next);
      })
      .catch(() => undefined);
    const unsubscribe = bridge.onUpdateState((next) => setState(next));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);

  if (
    bridge === undefined ||
    state === null ||
    state.status === "disabled" ||
    state.status === "idle" ||
    state.status === "checking" ||
    state.status === "up-to-date"
  ) {
    return null;
  }

  if (state.status === "error") {
    return (
      <aside className="desktop-update-notice is-error" role="alert">
        <span>更新未能安装，QA Hub 已保留当前版本。错误：{state.message}。请重新检查更新。</span>
        <button onClick={() => void bridge.checkForUpdate()} type="button">
          重新检查
        </button>
      </aside>
    );
  }

  if (state.status === "downloading") {
    return (
      <aside className="desktop-update-notice" role="status">
        <span>正在安全下载 QA Hub 更新 {state.version}</span>
        <strong>{state.progressPercent}%</strong>
      </aside>
    );
  }

  if (state.status === "installing") {
    return (
      <aside className="desktop-update-notice" role="status">
        <span>正在安装 QA Hub {state.version}，应用即将重启…</span>
      </aside>
    );
  }

  return (
    <aside className="desktop-update-notice is-ready" role="status">
      <span>QA Hub {state.version} 已下载并通过签名校验</span>
      <button onClick={() => void bridge.installUpdate()} type="button">
        安装并重启
      </button>
    </aside>
  );
}
