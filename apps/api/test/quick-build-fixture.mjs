import { QUICK_BUILD_PRESETS, QUICK_JOB_NAME } from "@relay-qa-hub/upload-contract";
export { QUICK_BUILD_PRESETS, QUICK_JOB_NAME };
export const modified = "Thu, 10 Sep 2026 09:49:00 GMT";
export function buildInfo(preset = QUICK_BUILD_PRESETS[2], number = 46, version = "2.4.37") {
  const entry = (area, suffix) => ({
    file: `${area}/ozdqp_${preset.platform.toLowerCase()}_${preset.configuration.toLowerCase()}_${version}_${number}.${suffix}`,
    size: 1234,
    sha256: "a".repeat(64),
  });
  return {
    schemaVersion: 1,
    status: "ready",
    requestId: `${preset.childJob}#${number}`,
    releaseVersion: version,
    buildNumber: number,
    sourceRevision: "b".repeat(40),
    productId: preset.productId,
    channelId: preset.channelId,
    platform: preset.platform,
    packageConfiguration: preset.configuration,
    resourceConfiguration: preset.configuration,
    packages:
      preset.mode === "Res"
        ? []
        : preset.platform === "iOS"
          ? [entry("packages", "ipa")]
          : preset.configuration === "Debug"
            ? [entry("packages", "apk")]
            : [entry("packages", "apk"), entry("packages", "aab")],
    hotUpdate: {
      ...entry("hot-update", "zip"),
      mode: preset.mode === "App" ? "full" : "incremental",
      baseline: null,
    },
    expectedRuiXueTarget: { productId: preset.productId, channelId: preset.channelId, version },
  };
}
export function catalogFetch(value, init = {}) {
  const url = new URL(value),
    headers = new Headers(init.headers);
  if (
    url.origin !== "http://10.100.5.129:8000" ||
    headers.has("authorization") ||
    headers.has("cookie")
  )
    throw new Error("Unsafe artifact fetch");
  const preset = QUICK_BUILD_PRESETS.find(
    (p) => p.mode === "App" && url.pathname.startsWith(`/ozdqp/${p.platform}/${p.configuration}/`),
  );
  if (!preset) return new Response(null, { status: 404 });
  const prefix = `ozdqp/${preset.platform}/${preset.configuration}/`,
    info = buildInfo(preset);
  if (init.method === "HEAD")
    return new Response(null, { headers: { "content-length": "1234", "last-modified": modified } });
  if (url.pathname.endsWith("build-info.json"))
    return Response.json(info, { headers: { "last-modified": modified } });
  return Response.json({
    files: [
      {
        name: "2.4.37/46",
        path: prefix + "2.4.37/46",
        type: "dir",
        mtime: Date.parse(modified),
        size: 0,
      },
    ],
  });
}
