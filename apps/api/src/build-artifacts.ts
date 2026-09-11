import {
  BUILD_DOWNLOAD_ROOT,
  QUICK_BUILD_PRESETS,
  type QuickBuildPreset,
} from "@relay-qa-hub/upload-contract";
import type { UploadSourceIdentity } from "./uploader-types.js";

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const fail = (): never => {
  throw new Error("BUILD_ARTIFACT_MISMATCH");
};
export interface BuildArtifact {
  name: string;
  url: string;
  size: number;
  sha256: string;
  kind: "apk" | "aab" | "ipa" | "zip";
}
export interface BuildResult {
  modifiedAt?: string;
  childBuildNumber?: number;
  version: string;
  buildNumber: number;
  requestId: string;
  sourceRevision: string;
  platform: "Android" | "iOS";
  configuration: "Debug" | "Release";
  productId: string;
  channelId: string;
  directory: string;
  packages: BuildArtifact[];
  hotUpdate: BuildArtifact;
  hotUpdateMode: "full" | "incremental";
}
export function validateBuildResult(
  value: unknown,
  preset: Pick<QuickBuildPreset, "platform" | "configuration" | "productId" | "channelId">,
  requireRequest = false,
): BuildResult {
  const info = object(value),
    hot = object(info["hotUpdate"]),
    target = object(info["expectedRuiXueTarget"]);
  const version = info["releaseVersion"],
    number = info["buildNumber"];
  if (
    info["schemaVersion"] !== 1 ||
    info["status"] !== "ready" ||
    info["platform"] !== preset.platform ||
    info["packageConfiguration"] !== preset.configuration ||
    info["resourceConfiguration"] !== preset.configuration ||
    info["productId"] !== preset.productId ||
    info["channelId"] !== preset.channelId ||
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    version.length > 80 ||
    !Number.isSafeInteger(number) ||
    Number(number) < 1 ||
    typeof info["sourceRevision"] !== "string" ||
    !/^[a-f0-9]{40}$/.test(info["sourceRevision"]) ||
    target["productId"] !== preset.productId ||
    target["channelId"] !== preset.channelId ||
    target["version"] !== version ||
    !Array.isArray(info["packages"]) ||
    !["full", "incremental"].includes(String(hot["mode"]))
  )
    fail();
  const directory = `${BUILD_DOWNLOAD_ROOT}${preset.platform}/${preset.configuration}/${version}/${number}/`;
  const artifact = (raw: unknown, area: "packages" | "hot-update"): BuildArtifact => {
    const entry = object(raw),
      file = entry["file"];
    if (
      typeof file !== "string" ||
      !new RegExp(`^${area}/[A-Za-z0-9][A-Za-z0-9._-]{0,230}\\.(apk|aab|ipa|zip)$`).test(file) ||
      file.includes("..") ||
      !Number.isSafeInteger(entry["size"]) ||
      Number(entry["size"]) <= 0 ||
      typeof entry["sha256"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry["sha256"])
    )
      fail();
    const name = String(file).split("/")[1]!,
      kind = name.split(".").at(-1) as BuildArtifact["kind"];
    if ((area === "hot-update") !== (kind === "zip")) fail();
    if (
      area === "packages" &&
      (preset.platform === "iOS"
        ? kind !== "ipa"
        : kind !== "apk" && (kind !== "aab" || preset.configuration !== "Release"))
    )
      fail();
    return {
      name,
      url: directory + String(file),
      size: Number(entry["size"]),
      sha256: String(entry["sha256"]),
      kind,
    };
  };
  const packages = (info["packages"] as unknown[]).map((p) => artifact(p, "packages"));
  const requestId = typeof info["requestId"] === "string" ? info["requestId"] : "";
  const childJob =
    preset.platform === "Android" ? "01-【OZDQP】【Android】" : "02-【OZDQP】【iOS】";
  const childText = requestId.startsWith(childJob + "#")
    ? requestId.slice(childJob.length + 1)
    : "";
  const childBuildNumber = /^[1-9]\d{0,9}$/.test(childText) ? Number(childText) : undefined;
  if (requireRequest && !childBuildNumber) fail();
  return {
    version: String(version),
    buildNumber: Number(number),
    requestId,
    sourceRevision: String(info["sourceRevision"]),
    platform: preset.platform,
    configuration: preset.configuration,
    ...(childBuildNumber ? { childBuildNumber } : {}),
    productId: preset.productId,
    channelId: preset.channelId,
    directory,
    packages,
    hotUpdate: artifact(hot, "hot-update"),
    hotUpdateMode: hot["mode"] as "full" | "incremental",
  };
}

export async function readArtifactJson(
  url: string,
  fetcher: typeof fetch = fetch,
  onHeaders?: (headers: Headers) => void,
): Promise<unknown> {
  const response = await fetcher(url, {
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("BUILD_RESULT_UNAVAILABLE");
  }
  onHeaders?.(response.headers);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("BUILD_RESULT_UNAVAILABLE");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 2 * 1024 * 1024) throw new Error("BUILD_RESULT_UNAVAILABLE");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel();
  }
}

/** The server collapses version/build directories into one listing entry when possible. */
export async function artifactCatalog(fetcher: typeof fetch = fetch): Promise<BuildResult[]> {
  const groups = QUICK_BUILD_PRESETS.filter((p) => p.mode === "App");
  const results = await Promise.all(
    groups.map(async (p) => {
      const prefix = `ozdqp/${p.platform}/${p.configuration}/`;
      const roots = object(
        await readArtifactJson(
          BUILD_DOWNLOAD_ROOT + `${p.platform}/${p.configuration}/?json=true`,
          fetcher,
        ),
      );
      if (!Array.isArray(roots["files"])) throw new Error("BUILD_RESULT_UNAVAILABLE");
      const paths: string[] = [];
      for (const raw of roots["files"].slice(0, 200)) {
        const f = object(raw),
          path = f["path"];
        if (f["type"] !== "dir" || typeof path !== "string" || !path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (/^\d+\.\d+\.\d+\/[1-9]\d*$/.test(rest)) paths.push(path);
        else if (/^\d+\.\d+\.\d+$/.test(rest)) {
          const nested = object(
            await readArtifactJson(`http://10.100.5.129:8000/${path}/?json=true`, fetcher),
          );
          for (const child of Array.isArray(nested["files"]) ? nested["files"].slice(0, 100) : []) {
            const c = object(child);
            if (
              c["type"] === "dir" &&
              typeof c["path"] === "string" &&
              c["path"].startsWith(path + "/") &&
              /^[1-9]\d*$/.test(c["path"].slice(path.length + 1))
            )
              paths.push(c["path"]);
          }
        }
      }
      const selected = [...new Set(paths)]
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .slice(0, 40);
      const output: BuildResult[] = [];
      // A directory may be visible before its ready receipt is written. It is never an upload candidate.
      for (const path of selected)
        try {
          let modified = "";
          const info = validateBuildResult(
            await readArtifactJson(
              `http://10.100.5.129:8000/${path}/build-info.json`,
              fetcher,
              (h) => {
                modified = h.get("last-modified") ?? "";
              },
            ),
            p,
          );
          if (!Number.isFinite(Date.parse(modified))) throw new Error("BUILD_RESULT_UNAVAILABLE");
          info.modifiedAt = new Date(modified).toISOString();
          if (info.directory !== `http://10.100.5.129:8000/${path}/`) fail();
          output.push(info);
        } catch {
          /* Partial or invalid builds have no verified download result. */
        }
      return output;
    }),
  );
  return results
    .flat()
    .sort(
      (a, b) =>
        b.version.localeCompare(a.version, undefined, { numeric: true }) ||
        b.buildNumber - a.buildNumber,
    );
}
export async function pinBuildSource(
  result: BuildResult,
  fetcher: typeof fetch = fetch,
): Promise<UploadSourceIdentity> {
  const file = result.hotUpdate;
  const head = await fetcher(file.url, {
    method: "HEAD",
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(15000),
  });
  const modified = Date.parse(head.headers.get("last-modified") ?? "");
  if (
    !head.ok ||
    Number(head.headers.get("content-length")) !== file.size ||
    !Number.isFinite(modified)
  )
    throw new Error("BUILD_ZIP_CHANGED");
  return {
    url: file.url + "?download=true",
    sha256: file.sha256,
    size: file.size,
    lastModified: new Date(modified).toUTCString(),
  };
}
