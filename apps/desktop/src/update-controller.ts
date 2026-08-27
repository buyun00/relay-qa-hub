import type { AppUpdater, ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from "electron-updater";

import type { DesktopUpdateStatus } from "./bridge-types.js";

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/u;

function safeVersion(value: unknown): string | null {
  return typeof value === "string" && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(value)
    ? value
    : null;
}

function safeProgress(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

function safeErrorCode(error: Error): string {
  const candidate = (error as NodeJS.ErrnoException).code;
  return typeof candidate === "string" && ERROR_CODE_PATTERN.test(candidate)
    ? candidate
    : "UPDATE_FAILED";
}

export interface DesktopUpdateControllerOptions {
  readonly updater: AppUpdater | null;
  readonly currentVersion: string;
  readonly enabled: boolean;
  readonly now?: () => Date;
}

export class DesktopUpdateController {
  private readonly updater: AppUpdater | null;
  private readonly now: () => Date;
  private readonly listeners = new Set<(status: DesktopUpdateStatus) => void>();
  private state: DesktopUpdateStatus;

  constructor(options: DesktopUpdateControllerOptions) {
    if (options.enabled && options.updater === null) {
      throw new Error("An enabled desktop update controller requires an updater");
    }
    this.updater = options.updater;
    this.now = options.now ?? (() => new Date());
    this.state = Object.freeze({
      phase: options.enabled ? "idle" : "disabled",
      currentVersion: options.currentVersion,
      availableVersion: null,
      progressPercent: null,
      checkedAt: null,
      errorCode: null,
    });
    if (options.enabled && this.updater !== null) this.bindUpdater(this.updater);
  }

  get status(): DesktopUpdateStatus {
    return this.state;
  }

  subscribe(listener: (status: DesktopUpdateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async checkForUpdates(): Promise<DesktopUpdateStatus> {
    if (this.updater === null || this.state.phase === "disabled") return this.state;
    if (
      this.state.phase === "checking" ||
      this.state.phase === "downloading" ||
      this.state.phase === "installing"
    ) {
      return this.state;
    }
    this.publish({ phase: "checking", progressPercent: null, errorCode: null });
    try {
      await this.updater.checkForUpdates();
    } catch (error: unknown) {
      this.publish({
        phase: "error",
        checkedAt: this.now().toISOString(),
        progressPercent: null,
        errorCode: safeErrorCode(error instanceof Error ? error : new Error("update failed")),
      });
    }
    return this.state;
  }

  installUpdate(): boolean {
    if (this.updater === null || this.state.phase !== "downloaded") return false;
    this.publish({ phase: "installing", errorCode: null });
    this.updater.quitAndInstall(false, true);
    return true;
  }

  private bindUpdater(updater: AppUpdater): void {
    updater.on("checking-for-update", () => {
      this.publish({ phase: "checking", progressPercent: null, errorCode: null });
    });
    updater.on("update-available", (info: UpdateInfo) => {
      this.publish({
        phase: "available",
        availableVersion: safeVersion(info.version),
        progressPercent: 0,
        errorCode: null,
      });
    });
    updater.on("update-not-available", (info: UpdateInfo) => {
      this.publish({
        phase: "up-to-date",
        availableVersion: safeVersion(info.version),
        progressPercent: null,
        checkedAt: this.now().toISOString(),
        errorCode: null,
      });
    });
    updater.on("download-progress", (progress: ProgressInfo) => {
      this.publish({
        phase: "downloading",
        progressPercent: safeProgress(progress.percent),
        errorCode: null,
      });
    });
    updater.on("update-downloaded", (info: UpdateDownloadedEvent) => {
      this.publish({
        phase: "downloaded",
        availableVersion: safeVersion(info.version),
        progressPercent: 100,
        checkedAt: this.now().toISOString(),
        errorCode: null,
      });
    });
    updater.on("error", (error: Error) => {
      this.publish({
        phase: "error",
        progressPercent: null,
        checkedAt: this.now().toISOString(),
        errorCode: safeErrorCode(error),
      });
    });
  }

  private publish(patch: Partial<DesktopUpdateStatus>): void {
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const listener of this.listeners) listener(this.state);
  }
}
