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
const apkName = `Relay-QA-Hub-团队版-Android-${versionName}-${versionCode}.apk`;
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
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#172b21">
  <title>Relay QA Hub 团队版下载</title>
  <style>
    :root{color:#17231d;background:#f3f6f2;font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-synthesis:none;--ink:#17231d;--muted:#68746d;--line:#e2e8e2;--surface:#fff;--canvas:#f3f6f2;--forest:#172b21;--lime:#b9f34a;--lime-soft:#effbdc;--orange:#ff7b31;--orange-soft:#fff2e7;--shadow:0 20px 55px rgba(23,43,33,.09)}
    *{box-sizing:border-box}html{min-height:100%;background:var(--canvas)}body{min-height:100vh;margin:0;color:var(--ink);background:radial-gradient(circle at 85% 0,rgba(185,243,74,.12),transparent 28rem),var(--canvas);-webkit-font-smoothing:antialiased}a{color:inherit}.shell{width:min(1180px,calc(100% - 48px));margin:0 auto}.topbar{height:78px;display:flex;align-items:center;justify-content:space-between}.brand{display:flex;align-items:center;gap:12px;text-decoration:none}.brand-mark{position:relative;width:42px;height:42px;display:grid;place-items:center;border-radius:14px;color:var(--lime);background:var(--forest);font-size:14px;font-weight:900;letter-spacing:-.04em;box-shadow:0 9px 22px rgba(23,43,33,.18)}.brand-mark:after{content:"";position:absolute;right:-2px;bottom:-2px;width:11px;height:11px;border:3px solid var(--canvas);border-radius:50%;background:var(--orange)}.brand-copy{display:grid;gap:2px}.brand-copy strong{font-size:17px;letter-spacing:-.02em}.brand-copy small{color:#7f8b84;font-size:11px}.workspace-link{display:inline-flex;align-items:center;gap:7px;padding:9px 13px;border:1px solid #dce4dc;border-radius:11px;background:rgba(255,255,255,.72);font-size:12px;font-weight:800;text-decoration:none;transition:.18s ease}.workspace-link:hover{border-color:#bdc9bf;background:#fff;transform:translateY(-1px)}
    main{padding:20px 0 64px}.hero{position:relative;overflow:hidden;min-height:292px;padding:48px;border-radius:28px;color:#fff;background:linear-gradient(135deg,#172b21 0%,#224c37 100%);box-shadow:var(--shadow)}.hero:before,.hero:after{content:"";position:absolute;border-radius:50%;pointer-events:none}.hero:before{right:-90px;top:-130px;width:350px;height:350px;border:1px solid rgba(255,255,255,.11)}.hero:after{right:72px;bottom:-126px;width:250px;height:250px;background:rgba(185,243,74,.1)}.eyebrow{margin:0 0 12px;color:var(--lime);font-size:12px;font-weight:850;letter-spacing:.11em}.hero h1{position:relative;z-index:1;max-width:720px;margin:0;font-size:clamp(34px,5vw,58px);line-height:1.04;letter-spacing:-.055em}.hero-copy{position:relative;z-index:1;max-width:650px;margin:18px 0 0;color:#c9d7cf;font-size:15px;line-height:1.8}.connection{position:relative;z-index:1;margin-top:27px;display:inline-flex;align-items:center;gap:9px;padding:9px 12px;border:1px solid rgba(255,255,255,.13);border-radius:12px;background:rgba(255,255,255,.07);color:#edf4ef;font-size:12px}.connection i{width:8px;height:8px;border-radius:50%;background:var(--lime);box-shadow:0 0 0 5px rgba(185,243,74,.12)}.connection code{color:#fff;font:700 12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
    .section-head{margin:42px 0 17px;display:flex;align-items:end;justify-content:space-between;gap:18px}.section-head h2{margin:0;font-size:25px;letter-spacing:-.035em}.section-head p{margin:0;color:var(--muted);font-size:13px}.package-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.package-card{position:relative;overflow:hidden;min-height:330px;padding:27px;border:1px solid var(--line);border-radius:22px;background:var(--surface);box-shadow:0 12px 34px rgba(31,48,39,.045);transition:.2s ease}.package-card:hover{transform:translateY(-2px);border-color:#c5d1c7;box-shadow:0 18px 40px rgba(31,48,39,.08)}.package-head{display:flex;align-items:center;justify-content:space-between}.platform-mark{width:48px;height:48px;display:grid;place-items:center;border-radius:15px;color:var(--forest);background:var(--lime-soft);font-size:17px;font-weight:900}.platform-mark.android{color:#b64c16;background:var(--orange-soft)}.recommended{padding:5px 9px;border-radius:999px;color:#416219;background:var(--lime-soft);font-size:10px;font-weight:850}.package-card h3{margin:24px 0 8px;font-size:22px;letter-spacing:-.03em}.package-card>p{min-height:44px;margin:0;color:var(--muted);font-size:13px;line-height:1.65}.release-meta{margin:20px 0;display:flex;gap:8px;flex-wrap:wrap}.release-meta span{padding:6px 9px;border:1px solid #e7ebe7;border-radius:9px;color:#536159;background:#f8faf8;font-size:11px;font-weight:750}.download-button{width:100%;min-height:46px;display:flex;align-items:center;justify-content:center;gap:9px;border-radius:13px;color:#fff;background:var(--forest);font-size:13px;font-weight:850;text-decoration:none;box-shadow:0 10px 24px rgba(23,43,33,.13);transition:.18s ease}.download-button:hover{transform:translateY(-1px);box-shadow:0 14px 28px rgba(23,43,33,.2)}.download-button svg{width:17px;height:17px;stroke:var(--lime)}details{margin-top:15px;color:#7e8982;font-size:11px}summary{width:max-content;cursor:pointer;font-weight:750}details code{display:block;margin-top:8px;padding:10px;border-radius:9px;background:#f6f8f6;color:#5f6d64;font:10px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
    .guide{margin-top:18px;padding:25px 27px;border:1px solid var(--line);border-radius:22px;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:18px;background:rgba(255,255,255,.78)}.guide-mark{width:42px;height:42px;display:grid;place-items:center;border-radius:13px;color:var(--orange);background:var(--orange-soft);font-size:18px;font-weight:900}.guide h3{margin:0 0 5px;font-size:15px}.guide p{margin:0;color:var(--muted);font-size:12px;line-height:1.65}.manifest-link{padding:9px 12px;border:1px solid #dce4dc;border-radius:10px;background:#fff;font-size:11px;font-weight:800;text-decoration:none}.footer{padding:25px 0 0;display:flex;justify-content:space-between;gap:16px;color:#89938d;font-size:11px}.footer p{margin:0}
    @media(max-width:760px){.shell{width:min(100% - 28px,1180px)}.topbar{height:68px}.brand-copy small{display:none}.workspace-link{padding:8px 10px}.hero{min-height:auto;padding:34px 25px;border-radius:22px}.hero h1{font-size:36px}.package-grid{grid-template-columns:1fr}.section-head{align-items:start;flex-direction:column}.package-card{min-height:0}.guide{grid-template-columns:auto 1fr}.manifest-link{grid-column:1/-1;text-align:center}.footer{flex-direction:column}}
  </style>
</head>
<body data-page="team-downloads">
  <header class="shell topbar">
    <a class="brand" href="${config.publicWebBaseUrl}">
      <span class="brand-mark">QA</span>
      <span class="brand-copy"><strong>Relay QA Hub</strong><small>团队版 · 局域网交付</small></span>
    </a>
    <a class="workspace-link" href="${config.publicWebBaseUrl}">进入工作台 <span aria-hidden="true">→</span></a>
  </header>
  <main class="shell">
    <section class="hero">
      <p class="eyebrow">RELAY QA HUB · TEAM EDITION</p>
      <h1>安装团队客户端，<br>继续手上的工作。</h1>
      <p class="hero-copy">Windows 与 Android 共用当前项目、人员和 Bug 数据。覆盖升级会保留本机登录信息与未提交草稿。</p>
      <div class="connection"><i></i><span>当前局域网服务</span><code>${config.publicWebBaseUrl}</code></div>
    </section>
    <div class="section-head"><h2>选择你的设备</h2><p>正式版本 1.0.0 · 仅限办公局域网</p></div>
    <section class="package-grid" aria-label="客户端下载">
      <article class="package-card">
        <div class="package-head"><span class="platform-mark">WIN</span><span class="recommended">推荐</span></div>
        <h3>Windows 团队版</h3>
        <p>适用于日常 Bug 管理、打包任务和桌面通知，可直接覆盖已有团队版。</p>
        <div class="release-meta"><span>版本 ${distribution.windows.version}</span><span>${size(installer.length)}</span><span>x64</span></div>
        <a class="download-button" href="${distribution.windows.installerUrl}"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14"/></svg>下载 Windows 安装器</a>
        <details><summary>查看文件校验值</summary><code>SHA-256 ${distribution.windows.sha256}</code></details>
      </article>
      <article class="package-card">
        <div class="package-head"><span class="platform-mark android">APK</span><span class="recommended">内部安装</span></div>
        <h3>Android 团队版</h3>
        <p>适用于移动端现场提交、截图草稿和任务跟进，请允许系统安装内部应用。</p>
        <div class="release-meta"><span>版本 ${versionName}</span><span>Code ${versionCode}</span><span>${size(apk.length)}</span></div>
        <a class="download-button" href="${distribution.android.downloadUrl}"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14"/></svg>下载 Android APK</a>
        <details><summary>查看文件校验值</summary><code>SHA-256 ${apkSha256}</code></details>
      </article>
    </section>
    <section class="guide">
      <div class="guide-mark">!</div>
      <div><h3>安装前保持局域网连接</h3><p>服务器断网、休眠或关机时客户端暂时无法连接；本机已有草稿仍会保留。</p></div>
      <a class="manifest-link" href="/downloads/distribution.json">查看交付清单</a>
    </section>
    <footer class="footer"><p>Relay QA Hub 团队版</p><p>统一项目数据 · 独立客户端配置</p></footer>
  </main>
</body>
</html>\n`;
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
