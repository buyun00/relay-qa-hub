import { useEffect, useState, type PropsWithChildren } from "react";
import AppIcon from "./AppIcon";

export default function DesktopWindow({ children }: PropsWithChildren) {
  const bridge = window.qaHubDesktop;
  const [square, setSquare] = useState(false);
  const [error, setError] = useState(false);
  const windowAction = async (action: "minimize" | "toggle-maximize" | "close") => {
    try {
      setError((await bridge?.windowAction?.(action)) !== true);
    } catch {
      setError(true);
    }
  };

  useEffect(() => {
    if (!bridge?.windowControlsOverlay) return;
    let active = true;
    const update = (state: { maximized: boolean; fullScreen: boolean }) => {
      if (active) setSquare(state.maximized || state.fullScreen);
    };
    const unsubscribe = bridge.onWindowState?.(update);
    void bridge
      .getWindowState?.()
      .then(update)
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [bridge]);

  return (
    <div
      className={
        bridge?.windowControlsOverlay
          ? `desktop-window${bridge.windowAction ? " has-custom-controls" : ""}${square ? " is-square" : ""}`
          : undefined
      }
    >
      {children}
      {bridge?.windowAction ? (
        <div className="window-controls" role="group" aria-label="窗口控制">
          <button
            type="button"
            className="window-control window-minimize"
            aria-label="最小化"
            title="最小化"
            onClick={() => void windowAction("minimize")}
          >
            <AppIcon name="minimize" />
          </button>
          <button
            type="button"
            className={`window-control window-maximize${square ? " is-maximized" : ""}`}
            aria-label={square ? "还原窗口" : "最大化"}
            title={square ? "还原窗口" : "最大化"}
            aria-pressed={square}
            onClick={() => void windowAction("toggle-maximize")}
          >
            <AppIcon name={square ? "restore" : "maximize"} />
          </button>
          <button
            type="button"
            className="window-control window-close"
            aria-label="关闭窗口"
            title="关闭窗口，继续在托盘运行"
            onClick={() => void windowAction("close")}
          >
            <AppIcon name="close" />
          </button>
          {error ? (
            <span className="window-control-error" role="alert">
              窗口操作失败，请重试
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
