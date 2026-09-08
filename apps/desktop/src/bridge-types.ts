import type { UploaderBridge } from "./uploader-types.js";

export type DesktopConnectionState =
  "disabled" | "stopped" | "connecting" | "connected" | "reconnecting" | "paused";

export interface DesktopConnectionStatus {
  readonly state: DesktopConnectionState;
  readonly reconnectAttempt: number;
  readonly lastError: string | null;
}

export interface DesktopBugChange {
  readonly notificationId: string;
  readonly eventId: string | null;
  readonly bugId: string | null;
}

export interface DesktopRuntimeInfo {
  readonly apiBaseUrl: string;
  readonly notificationsEnabled: boolean;
  readonly version: string;
  readonly mcp: {
    readonly state: "disabled" | "stopped" | "starting" | "listening" | "failed";
    readonly port: number;
    readonly url: string;
    readonly lastError: string | null;
  };
}

export type DesktopUpdateState =
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

export interface QaHubDesktopBridge {
  readonly uploader: UploaderBridge;
  readonly windowControlsOverlay: boolean;
  readonly getWindowState: () => Promise<DesktopWindowState>;
  readonly onWindowState: (listener: (state: DesktopWindowState) => void) => () => void;
  readonly notifyPackaging: (notice: DesktopPackagingNotice) => Promise<boolean>;
  readonly onOpenPackaging: (listener: () => void) => () => void;
  readonly getConnectionStatus: () => Promise<DesktopConnectionStatus>;
  readonly getRuntimeInfo: () => Promise<DesktopRuntimeInfo>;
  readonly getNotificationsPaused: () => Promise<boolean>;
  readonly getUpdateState: () => Promise<DesktopUpdateState>;
  readonly checkForUpdate: () => Promise<boolean>;
  readonly installUpdate: () => Promise<boolean>;
  readonly onConnectionStatus: (listener: (status: DesktopConnectionStatus) => void) => () => void;
  readonly onBugChanged: (listener: (change: DesktopBugChange) => void) => () => void;
  readonly onOpenBug: (listener: (bugId: string) => void) => () => void;
  readonly onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
}

export interface DesktopWindowState {
  readonly maximized: boolean;
  readonly fullScreen: boolean;
}

export interface DesktopPackagingNotice {
  readonly id: string;
  readonly kind: "success" | "warning" | "failure";
  readonly title: string;
  readonly body: string;
}
