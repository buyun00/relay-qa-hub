import type { UploadInput } from "./index.js";
export type QuickBuildPresetId =
  | "android-debug-app"
  | "android-debug-res"
  | "android-release-app"
  | "android-release-res"
  | "ios-debug-app"
  | "ios-debug-res"
  | "ios-release-app"
  | "ios-release-res";
export interface QuickBuildPreset {
  id: QuickBuildPresetId;
  label: string;
  packageLabel: string;
  platform: "Android" | "iOS";
  configuration: "Debug" | "Release";
  mode: "App" | "Res";
  productId: "2001" | "2002";
  channelId: "1002" | "2004";
  childJob: string;
}
export declare const QUICK_JOB_NAME: string;
export declare const BUILD_DOWNLOAD_ROOT: string;
export declare const QUICK_BUILD_PRESETS: readonly Readonly<QuickBuildPreset>[];
export declare function quickBuildPreset(id: unknown): Readonly<QuickBuildPreset> | undefined;
export declare function quickUploadInput(input: UploadInput, id: QuickBuildPresetId): UploadInput;
