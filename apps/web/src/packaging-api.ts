import { requestJson } from "./api";

export const BUILD_PRESETS = [
  { id: "internal-nosdk", label: "打不带 SDK 的内网包", packageLabel: "内网 · 不带 SDK" },
  { id: "internal-sdk", label: "打带 SDK 的内网包", packageLabel: "内网 · 带 SDK" },
  { id: "external", label: "打外网包", packageLabel: "外网包" },
] as const;
export type BuildPreset = (typeof BUILD_PRESETS)[number]["id"];
export interface PackageFile {
  name: string;
  size: number;
  modifiedAt: string;
  url: string;
  kind: "apk" | "ipa";
  preset: BuildPreset | null;
}
export interface PackagingStatus {
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
