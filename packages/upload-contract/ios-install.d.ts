export const IOS_INSTALL_JOB: string;
export const IOS_DEFAULT_DEVICE: string;
export const IOS_INSTALL_ERRORS: Readonly<Record<string, string>>;
export function iosInstallError(code: string | null): string;
export function iosInstallFinished(state: string): boolean;
export function defaultIosDevice(devices: readonly IosTestDevice[]): string;
export interface IosTestDevice {
  id: string;
  name: string;
  model: string;
  osVersion: string;
  online: boolean;
  developerMode: boolean;
  connection: string;
}
export interface IosInstallSelection {
  configuration: "Debug" | "Release";
  version: string;
  buildNumber: number;
  filename: string;
  deviceId: string;
}
export interface IosInstallArtifact {
  url: string;
  sha256: string;
  size: number;
}
export interface IosInstallRequest {
  id: string;
  action: "devices" | "install";
  selection?: IosInstallSelection;
  artifact?: IosInstallArtifact;
}
export interface IosInstallReport {
  schemaVersion: 1;
  requestId: string;
  action: "devices" | "install";
  status: "complete" | "failed" | "unconfirmed";
  errorCode: string | null;
  checkedAt: string;
  devices: IosTestDevice[];
  deviceId?: string;
  artifactSha256?: string;
  bundleId?: string;
  appVersion?: string;
  appBuild?: string;
  signingMode?: "original" | "adhoc";
  preparedIpaSha256?: string;
  profileName?: string;
}
export interface IosInstallJob {
  id: string;
  action: "devices" | "install";
  createdAt: string;
  updatedAt: string;
  state:
    | "submitting"
    | "submission_unknown"
    | "queued"
    | "running"
    | "complete"
    | "failed"
    | "unconfirmed";
  queueId: number | null;
  buildNumber: number | null;
  errorCode: string | null;
  selection?: IosInstallSelection;
  report?: IosInstallReport;
}
export interface IosInstallSnapshot {
  devices: IosTestDevice[];
  checkedAt: string | null;
  scan: IosInstallJob | null;
  installs: IosInstallJob[];
}
