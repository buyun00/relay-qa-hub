export type DesktopConnectionState =
  "disabled" | "stopped" | "connecting" | "connected" | "reconnecting" | "paused";

export interface DesktopConnectionStatus {
  readonly state: DesktopConnectionState;
  readonly reconnectAttempt: number;
  readonly lastError: string | null;
}

export interface QaHubDesktopBridge {
  readonly getConnectionStatus: () => Promise<DesktopConnectionStatus>;
  readonly getNotificationsPaused: () => Promise<boolean>;
  readonly onConnectionStatus: (listener: (status: DesktopConnectionStatus) => void) => () => void;
  readonly onOpenBug: (listener: (bugId: string) => void) => () => void;
}
