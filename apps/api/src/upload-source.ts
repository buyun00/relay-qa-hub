import type { UploadSourceIdentity } from "./uploader-types.js";
import { artifactCatalog, pinBuildSource } from "./build-artifacts.js";
import type { UploadInput } from "./uploader-types.js";

export async function resolveUploadBuild(input: UploadInput, fetcher: typeof fetch = fetch) {
  if (!["2001", "2002"].includes(input.productId) || !["1002", "2004"].includes(input.channelId))
    throw new Error("INVALID_INPUT");
  const results = await artifactCatalog(fetcher);
  const result = results.find(
    (r) =>
      r.productId === input.productId &&
      r.channelId === input.channelId &&
      (!input.version || r.version === input.version),
  );
  if (!result) throw new Error("UPLOAD_SOURCE_NO_ZIP");
  const expectedSource = await pinBuildSource(result, fetcher);
  return {
    version: result.version,
    downloadUrl: expectedSource.url!,
    sourceFileName: result.hotUpdate.name,
    expectedSource,
  };
}

export interface ResolvedUploadSource {
  downloadUrl: string;
  sourceFileName: string;
  expectedSource: UploadSourceIdentity;
}
const maxListingBytes = 4 * 1024 * 1024;
const validName = (name: unknown): name is string =>
  typeof name === "string" &&
  name.length <= 240 &&
  /^[^/\\:*?"<>|\u0000-\u001f\u007f]+\.zip$/iu.test(name);

export async function latestIosUploadSource(
  fetcher: typeof fetch = fetch,
  directory?: string,
): Promise<ResolvedUploadSource> {
  if (!directory) throw new Error("COMPONENT_NOT_CONFIGURED");
  try {
    const listing = await fetcher(directory + "?json=true", {
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
      credentials: "omit",
    });
    if (!listing.ok || Number(listing.headers.get("content-length")) > maxListingBytes)
      throw new Error("UPLOAD_SOURCE_UNAVAILABLE");
    const reader = listing.body?.getReader();
    if (!reader) throw new Error("UPLOAD_SOURCE_UNAVAILABLE");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > maxListingBytes) throw new Error("UPLOAD_SOURCE_UNAVAILABLE");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const files = (body as { files?: unknown })?.files;
    if (!Array.isArray(files)) throw new Error("UPLOAD_SOURCE_UNAVAILABLE");
    const candidates = files
      .filter(
        (file): file is { name: string; size: number; mtime: number } =>
          !!file &&
          file.type === "file" &&
          validName(file.name) &&
          Number.isSafeInteger(file.size) &&
          file.size > 0 &&
          typeof file.mtime === "number" &&
          Number.isFinite(file.mtime) &&
          Number.isFinite(new Date(file.mtime).valueOf()),
      )
      .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    const latest = candidates[0];
    if (!latest) throw new Error("UPLOAD_SOURCE_NO_ZIP");
    const downloadUrl = directory + encodeURIComponent(latest.name) + "?download=true";
    const head = await fetcher(downloadUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
      credentials: "omit",
    });
    const size = Number(head.headers.get("content-length"));
    const modified = Date.parse(head.headers.get("last-modified") ?? "");
    if (
      !head.ok ||
      size !== latest.size ||
      !Number.isFinite(modified) ||
      Math.floor(modified / 1000) !== Math.floor(latest.mtime / 1000)
    )
      throw new Error("BUILD_ZIP_CHANGED");
    return {
      downloadUrl,
      sourceFileName: latest.name,
      expectedSource: { size, lastModified: new Date(modified).toUTCString() },
    };
  } catch (error) {
    if (
      error instanceof Error &&
      ["UPLOAD_SOURCE_NO_ZIP", "BUILD_ZIP_CHANGED"].includes(error.message)
    )
      throw error;
    throw new Error("UPLOAD_SOURCE_UNAVAILABLE");
  }
}
