import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";
import { publishVersionedJson } from "./versioned-json-publication.mjs";

const [configFile, apkSource, versionCodeText, versionName] = process.argv.slice(2);
if (!configFile || !apkSource || !versionCodeText || !versionName)
  throw new Error(
    "Usage: node publish-lan-distribution.mjs CONFIG_FILE APK VERSION_CODE VERSION_NAME",
  );
const config = readParallelInstanceConfig(configFile);
if (config.deploymentMode !== "lan") throw new Error("LAN_CONFIGURATION_REQUIRED");
const versionCode = Number(versionCodeText);
if (!Number.isSafeInteger(versionCode) || versionCode < 1)
  throw new Error("ANDROID_VERSION_INVALID");
if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(versionName))
  throw new Error("ANDROID_VERSION_INVALID");
const apk = readFileSync(apkSource);
if (apk.length === 0 || apk.length > 512 * 1024 * 1024) throw new Error("ANDROID_APK_INVALID");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const apkSha256 = sha256(apk);
const packageName = "com.relayqahub.android.lan.v22.debug";
const apkName = `Relay-QA-Hub-Android-${versionCode}-${versionName}.apk`;
const androidRoot = join(config.downloadsRoot, "android", config.releaseChannel);
mkdirSync(androidRoot, { recursive: true });
const apkTarget = join(androidRoot, apkName);
if (existsSync(apkTarget)) {
  if (sha256(readFileSync(apkTarget)) !== apkSha256) {
    throw new Error("ANDROID_APK_ALREADY_PUBLISHED");
  }
} else {
  copyFileSync(apkSource, apkTarget);
}
if (sha256(readFileSync(apkTarget)) !== apkSha256) throw new Error("ANDROID_APK_COPY_MISMATCH");
const androidManifest = {
  schemaVersion: 1,
  channel: "preview",
  versionCode,
  versionName,
  packageName,
  fileName: apkName,
  size: apk.length,
  sha256: apkSha256,
};
publishVersionedJson({
  target: join(androidRoot, "latest.json"),
  bytes: Buffer.from(`${JSON.stringify(androidManifest, null, 2)}\n`),
  versionCode,
});

const windowsManifestName = `${config.instanceId}-windows-latest.json`;
const windowsManifestPath = join(config.downloadsRoot, windowsManifestName);
const windowsManifest = JSON.parse(readFileSync(windowsManifestPath, "utf8"));
if (
  typeof windowsManifest.archive?.url !== "string" ||
  typeof windowsManifest.archive?.sha256 !== "string" ||
  !Number.isSafeInteger(windowsManifest.archive?.size)
)
  throw new Error("WINDOWS_MANIFEST_INVALID");
const installerName = basename(windowsManifest.archive.url);
const installerPath = join(config.downloadsRoot, installerName);
const installer = readFileSync(installerPath);
if (
  installer.length !== windowsManifest.archive.size ||
  sha256(installer) !== windowsManifest.archive.sha256
)
  throw new Error("WINDOWS_INSTALLER_BINDING_MISMATCH");
const generatedAt = new Date().toISOString();
const distribution = {
  schemaVersion: 1,
  instanceId: config.instanceId,
  generatedAt,
  webBaseUrl: config.publicWebBaseUrl,
  windows: {
    version: windowsManifest.version,
    manifestUrl: `${config.publicWebBaseUrl}/downloads/${windowsManifestName}`,
    installerUrl: `${config.publicWebBaseUrl}${windowsManifest.archive.url}`,
    fileName: installerName,
    size: installer.length,
    sha256: windowsManifest.archive.sha256,
  },
  android: {
    versionCode,
    versionName,
    packageName,
    updateManifestUrl: `${config.publicWebBaseUrl}/api/v1/android-updates/preview/latest.json`,
    downloadUrl: `${config.publicWebBaseUrl}/downloads/android/${config.releaseChannel}/${apkName}`,
    fileName: apkName,
    size: apk.length,
    sha256: apkSha256,
  },
};
writeFileSync(
  join(config.downloadsRoot, "distribution.json"),
  `${JSON.stringify(distribution, null, 2)}\n`,
);
const size = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA Hub 局域网客户端下载</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 24px;color:#17211b}article{border:1px solid #dfe6df;border-radius:16px;padding:20px;margin:16px 0}a{display:inline-block;background:#17211b;color:white;padding:10px 16px;border-radius:10px;text-decoration:none}code{word-break:break-all}small{display:block;margin:10px 0;color:#5f6e64}</style></head>
<body><h1>QA Hub 局域网客户端下载</h1><p>服务器入口：<a href="${config.publicWebBaseUrl}">${config.publicWebBaseUrl}</a></p>
<article><h2>Windows</h2><p>${distribution.windows.version} · ${size(installer.length)}</p><a href="${distribution.windows.installerUrl}">下载 Windows 安装器</a><small>SHA-256</small><code>${distribution.windows.sha256}</code></article>
<article><h2>Android</h2><p>${versionName} (${versionCode}) · ${size(apk.length)}</p><a href="${distribution.android.downloadUrl}">下载 Android APK</a><small>SHA-256</small><code>${apkSha256}</code></article>
<p><a href="/downloads/distribution.json">机器可读交付清单</a></p><p>使用前请确保设备连接同一办公局域网；服务器断网、休眠或关机时不可连接，客户端草稿仍保留。</p></body></html>\n`;
writeFileSync(join(config.downloadsRoot, "index.html"), html);
console.log(
  JSON.stringify({
    distributionManifest: join(config.downloadsRoot, "distribution.json"),
    downloadPage: `${config.publicWebBaseUrl}/downloads/`,
    windows: distribution.windows,
    android: distribution.android,
    files: {
      installer: statSync(installerPath).size,
      apk: statSync(apkTarget).size,
    },
  }),
);
