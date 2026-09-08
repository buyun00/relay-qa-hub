export type WindowAction = "minimize" | "toggle-maximize" | "close";

interface WindowTarget {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setFullScreen(value: boolean): void;
  isMaximized(): boolean;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  close(): void;
}

export function applyWindowAction(window: WindowTarget | null, action: unknown): boolean {
  if (!window || window.isDestroyed()) return false;
  switch (action) {
    case "minimize":
      window.minimize();
      return true;
    case "toggle-maximize":
      if (window.isFullScreen()) window.setFullScreen(false);
      else if (window.isMaximized()) window.unmaximize();
      else window.maximize();
      return true;
    // Preserve the app's close-to-tray handler and background work.
    case "close":
      window.close();
      return true;
    default:
      return false;
  }
}
