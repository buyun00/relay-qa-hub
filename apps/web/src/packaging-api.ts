import { requestJson } from "./api";
import { QUICK_BUILD_PRESETS, type QuickBuildPresetId } from "@relay-qa-hub/upload-contract";

export const BUILD_PRESETS = QUICK_BUILD_PRESETS;
export type BuildPreset = QuickBuildPresetId | "internal-nosdk" | "internal-sdk" | "external";
export interface BuildArtifactFile {
  name: string;
  url: string;
  size: number;
  sha256: string;
  kind: "apk" | "aab" | "ipa" | "zip";
}
export interface BuildArtifactResult {
  version: string;
  buildNumber: number;
  platform: "Android" | "iOS";
  configuration: "Debug" | "Release";
  productId: string;
  channelId: string;
  directory: string;
  packages: BuildArtifactFile[];
  hotUpdate: BuildArtifactFile;
  hotUpdateMode: "full" | "incremental";
}
export interface BuildStageProgress {
  id: string;
  label: string;
  work: string;
  state: "waiting" | "running" | "complete" | "skipped" | "failed";
  elapsedMs: number | null;
  toolElapsedMs: number | null;
  timing: "recorded" | "observed" | "unavailable";
  expectedMs: number | null;
  sampleCount: number;
  alertAfterMs: number;
  alertBasis: "history" | "initial";
  percent: number | null;
  alert: boolean;
}
export interface BuildProgress {
  errorCode?: string;
  number: number;
  queueId: number | null;
  preset: BuildPreset | null;
  status: string;
  startedAt: string;
  elapsedMs: number;
  executionElapsedMs?: number | null;
  queueWait?: {
    active: boolean;
    blockingBuild: string | null;
    elapsedMs: number | null;
    timing: "recorded" | "observed" | "unavailable";
  };
  expectedMs: number | null;
  triggeredBy: string;
  executor: string;
  mode: "App" | "Res" | "Script" | null;
  includesZip: boolean | null;
  percent: number;
  stages: BuildStageProgress[];
  logError: boolean;
}
export interface PackagingProgress {
  checkedAt: string;
  builds: BuildProgress[];
  queues: { id: number; status: "QUEUED" | "CANCELLED" | "UNKNOWN"; reason: string }[];
}
export interface PackageFile {
  name: string;
  size: number;
  modifiedAt: string;
  url: string;
  kind: "apk" | "ipa";
  preset: BuildPreset | null;
}
export interface PackagingStatus {
  artifacts?: BuildArtifactResult[];
  artifactError?: string | null;
  checkedAt: string;
  jenkins: {
    buildable: boolean;
    builds: { number: number; startedAt: string; status: string; preset: BuildPreset | null }[];
    queue: { id: number; reason: string; preset: BuildPreset | null }[];
  } | null;
  jenkinsError: string | null;
  apks: PackageFile[];
  apkError: string | null;
  ipas: PackageFile[];
  ipaError: string | null;
  zip: { url: string; name: string; size: number; modifiedAt: string | null } | null;
  zipError: string | null;
}

export async function getPackagingStatus(signal?: AbortSignal): Promise<PackagingStatus> {
  return (await requestJson("/api/v1/packaging", signal ? { signal } : {})) as PackagingStatus;
}

export async function getPackagingProgress(
  queues: number[],
  builds: number[],
  signal?: AbortSignal,
): Promise<PackagingProgress> {
  const query = new URLSearchParams();
  if (queues.length) query.set("queues", queues.join(","));
  if (builds.length) query.set("builds", builds.join(","));
  return (await requestJson(
    `/api/v1/packaging/progress?${query}`,
    signal ? { signal } : {},
  )) as PackagingProgress;
}

export async function triggerJenkinsBuild(
  preset: BuildPreset,
  requestId: string,
): Promise<{ queueId: number }> {
  return (await requestJson("/api/v1/packaging/builds", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": requestId },
    body: JSON.stringify({ preset }),
  })) as { queueId: number };
}
