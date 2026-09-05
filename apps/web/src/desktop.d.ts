interface QaHubDesktopBugChange {
  readonly notificationId: string;
  readonly eventId: string | null;
  readonly bugId: string | null;
}

interface QaHubDesktopRuntimeInfo {
  readonly apiBaseUrl: string;
  readonly notificationsEnabled: boolean;
  readonly version?: string;
  readonly mcp?: {
    readonly state: "disabled" | "stopped" | "starting" | "listening" | "failed";
    readonly port: number;
    readonly url: string;
    readonly lastError: string | null;
  };
}

interface QaHubDesktopConnectionStatus {
  readonly state: "disabled" | "stopped" | "connecting" | "connected" | "reconnecting" | "paused";
  readonly reconnectAttempt: number;
  readonly lastError: string | null;
}

type QaHubDesktopUpdateState =
  | { readonly status: "disabled"; readonly message: string }
  | { readonly status: "idle"; readonly currentReleaseId: string; readonly version: string }
  | { readonly status: "checking"; readonly currentReleaseId: string; readonly version: string }
  | { readonly status: "up-to-date"; readonly currentReleaseId: string; readonly version: string }
  | {
      readonly status: "downloading";
      readonly releaseId: string;
      readonly version: string;
      readonly progressPercent: number;
    }
  | {
      readonly status: "ready";
      readonly releaseId: string;
      readonly version: string;
      readonly publishedAt: string;
    }
  | { readonly status: "installing"; readonly releaseId: string; readonly version: string }
  | { readonly status: "error"; readonly message: string };

interface QaHubDesktopBridge {
  readonly windowControlsOverlay?: boolean;
  readonly getConnectionStatus?: () => Promise<QaHubDesktopConnectionStatus>;
  readonly onConnectionStatus?: (
    listener: (status: QaHubDesktopConnectionStatus) => void,
  ) => () => void;
  readonly notifyPackaging?: (notice: {
    id: string;
    kind: "success" | "warning" | "failure";
    title: string;
    body: string;
  }) => Promise<boolean>;
  readonly onOpenPackaging?: (listener: () => void) => () => void;
  readonly getRuntimeInfo: () => Promise<QaHubDesktopRuntimeInfo>;
  readonly getUpdateState: () => Promise<QaHubDesktopUpdateState>;
  readonly checkForUpdate: () => Promise<boolean>;
  readonly installUpdate: () => Promise<boolean>;
  readonly onBugChanged: (listener: (change: QaHubDesktopBugChange) => void) => () => void;
  readonly onOpenBug: (listener: (bugId: string) => void) => () => void;
  readonly onUpdateState: (listener: (state: QaHubDesktopUpdateState) => void) => () => void;
}

declare global {
  interface Window {
    readonly qaHubDesktop?: QaHubDesktopBridge;
  }
}

export {};
