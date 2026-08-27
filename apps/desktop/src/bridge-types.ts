export type DesktopConnectionState =
  "disabled" | "stopped" | "connecting" | "connected" | "reconnecting" | "paused";

export interface DesktopConnectionStatus {
  readonly state: DesktopConnectionState;
  readonly reconnectAttempt: number;
  readonly lastError: string | null;
}

export type DesktopUpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "installing"
  | "error";

export interface DesktopUpdateStatus {
  readonly phase: DesktopUpdatePhase;
  readonly currentVersion: string;
  readonly availableVersion: string | null;
  readonly progressPercent: number | null;
  readonly checkedAt: string | null;
  readonly errorCode: string | null;
}

export interface QaHubDesktopBridge {
  readonly getConnectionStatus: () => Promise<DesktopConnectionStatus>;
  readonly getNotificationsPaused: () => Promise<boolean>;
  readonly getUpdateStatus: () => Promise<DesktopUpdateStatus>;
  readonly checkForUpdates: () => Promise<DesktopUpdateStatus>;
  readonly installUpdate: () => Promise<boolean>;
  readonly onConnectionStatus: (listener: (status: DesktopConnectionStatus) => void) => () => void;
  readonly onUpdateStatus: (listener: (status: DesktopUpdateStatus) => void) => () => void;
  readonly onOpenBug: (listener: (bugId: string) => void) => () => void;
}
