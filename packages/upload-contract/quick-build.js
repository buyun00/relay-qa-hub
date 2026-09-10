export const QUICK_JOB_NAME = "00-【OZDQP】【快捷打包】";
export const BUILD_DOWNLOAD_ROOT = "http://10.100.5.129:8000/ozdqp/";
export const QUICK_BUILD_PRESETS = Object.freeze(
  [
    ["android-debug-app", "Android Debug · APK、完整热更", "Android", "Debug", "App"],
    ["android-debug-res", "Android Debug · 增量热更", "Android", "Debug", "Res"],
    ["android-release-app", "Android Release · APK、AAB、完整热更", "Android", "Release", "App"],
    ["android-release-res", "Android Release · 增量热更", "Android", "Release", "Res"],
    ["ios-debug-app", "iOS Debug · IPA、完整热更", "iOS", "Debug", "App"],
    ["ios-debug-res", "iOS Debug · 增量热更", "iOS", "Debug", "Res"],
    ["ios-release-app", "iOS Release · IPA、完整热更", "iOS", "Release", "App"],
    ["ios-release-res", "iOS Release · 增量热更", "iOS", "Release", "Res"],
  ].map(([id, label, platform, configuration, mode]) =>
    Object.freeze({
      id,
      label,
      platform,
      configuration,
      mode,
      packageLabel: label,
      productId: configuration === "Debug" ? "2001" : "2002",
      channelId: platform === "Android" ? "1002" : "2004",
      childJob: platform === "Android" ? "01-【OZDQP】【Android】" : "02-【OZDQP】【iOS】",
    }),
  ),
);
export function quickBuildPreset(id) {
  return QUICK_BUILD_PRESETS.find((p) => p.id === id);
}
export function quickUploadInput(input, id) {
  const p = quickBuildPreset(id);
  if (!p) throw new Error("INVALID_INPUT");
  return {
    ...input,
    productId: p.productId,
    channelId: p.channelId,
    belongName: `[${p.productId}]Baloot Go|[${p.channelId}]${p.platform === "Android" ? "谷歌-国际正式" : "iOS"}`,
    version: "",
    summary: "",
    description: "",
  };
}
