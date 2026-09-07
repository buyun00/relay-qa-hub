import { useEffect, useState, type PropsWithChildren } from "react";

export default function DesktopWindow({ children }: PropsWithChildren) {
  const bridge = window.qaHubDesktop;
  const [square, setSquare] = useState(false);

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
        bridge?.windowControlsOverlay ? `desktop-window${square ? " is-square" : ""}` : undefined
      }
    >
      {children}
    </div>
  );
}
