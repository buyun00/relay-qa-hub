# EXE preview.8：打包、升级与提交恢复验收计划

状态：`not_run`。本文件仅根据源码、既有证据和只读进程/文件检查编写；没有构建新包、发布清单、启动/退出 EXE、操作日常客户端或执行业务请求。由 root 在后续独立窗口执行，失败产物与原始记录永久保留。

准备阶段检查：4 个 PowerShell 代码块通过 PowerShell AST 语法解析，2 个内嵌 JavaScript 代码块通过 Node `--check`，文档通过 Prettier 检查。这些检查没有执行代码块中的构建、发布或服务命令，不代表命令运行成功。

## 1. 本次边界与当前只读基线

| 项目                                      | 固定值                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| 工作树                                    | `C:\Users\lin0\.codex\worktrees\7c86\Relay-QA-Hub`                             |
| 实例配置                                  | `C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\instance.json`     |
| runtime                                   | `C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86`                   |
| 实例/发布 channel                         | `qa-hub-preview-7c86`                                                          |
| 安装身份                                  | `RelayQaHubPreview`，scheme `qa-hub-preview`，当前用户安装                     |
| 安装路径                                  | `C:\Users\lin0\AppData\Local\Programs\RelayQaHubPreview\RelayQaHubPreview.exe` |
| profile                                   | runtime 下 `desktop\profile`；不换目录、不清理、不重新登录                     |
| HTTP / Web与下载 / server MCP / local MCP | `127.0.0.1:4419` / `4274` / `4421` / `4420`                                    |
| cookie                                    | `qa-hub-preview-7c86-session`                                                  |
| 计划版本                                  | `0.2.0-preview.8`；Windows FileVersion `0.2.0.8`                               |

2026-09-08T23:54:58.8981528Z 的只读复查：已安装 ProductVersion 仍为 `0.2.0-preview.7`；主进程 **23924**，启动 UTC `2026-09-08T21:18:26.3376550Z`，同路径子进程 15160/12520/11604，4420 归属 23924。4419/4274/4421 的 listener 分别归属 10036/20284/15736。只记录了 PID、父 PID、启动时间和路径，没有输出命令行或身份凭据。执行前必须重新查询，不能依赖这些易变 PID。

已安装 `preview-instance.json` SHA256：`aa98507fd6dbe84c360e845859af69c4f5ed1724975ecc10b7561015cf76ac83`。本轮没有读取私钥正文；runtime 的 `desktop-signing/private.pem` 与 `public.pem` 均已存在。必须沿用这一对密钥，并核对公钥等于已安装配置中的公钥；不能删除或重新生成后称作同 channel 的正常升级。

日常 EXE 的 17160/启动时间 `2026-09-08T10:24:12.5269520Z` 仅是既有证据值。本轮未重新核其身份。后续先从 root 已确认的日常安装路径做只读精确查询，保存当前路径/PID/启动时间，升级后逐项核对；不能按进程名称批量操作。API、Web、server MCP、日常 EXE/APK 均不属于此次升级的重启范围。

## 2. 必须保留的原现场

以下来自既有 `.7` 升级和恢复证据；后续升级前须再次通过当前 EXE 原生界面读回，不是新做出的现场断言。

| 对象         | 原值与验证要求                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 原员工       | `EXE实际验收0909`，actor `5ef57049-0e33-4476-8a3c-b320aa26bf68`                                                                 |
| 原项目 A     | `fb914b3b-4169-47f8-8dec-76f3a3cc780d`                                                                                          |
| 原 Bug 13    | `a32d175b-137c-47bd-bbd9-b952d4860b1e`；`closed`、version 14、occurrenceCount 1                                                 |
| 原评论       | `d7a5ee19-1145-4162-a9ff-44d89fa34f7c`；原记录评论数 1                                                                          |
| 原绑定附件   | `bbeaafee-effa-4265-873e-881111e40ae8`；184872 bytes；SHA256 `e0ed7b4b96935f06855a05ce3372ada01b9585ed459d3d5c183f1c6dc8e7cb8b` |
| 原未提交正文 | `EXE第6版升级与回退保留草稿 2026-09-09：同一员工、项目A、PNG附件与未提交正文必须保留。`                                         |
| 原未提交附件 | 1 张 `exe-test-input.png`；原生缩略图和文件名仍可见，不能上传、提交、替换或删除                                                 |

未提交 PNG 与 Bug 13 已绑定附件是两个验证对象；不能拿后者的 SHA 冒充草稿 PNG 的校验。保存原生截图/可见树、草稿持久状态与实际图片 bytes/hash 的可用读回；不要将 Chromium cookie、token、完整 IndexedDB 或 profile 内容放入仓库。

保留既有 `.7` 安装器：runtime 下 `downloads/qa-hub-preview-7c86-windows-0.2.0-preview.7-20260908T194425490Z.exe`，108378668 bytes，SHA256 `fbf0656285474e2b4d521178cb9107dd26d3426dd463b9198fc21b239e02152a`；保留原 package、所有 `RelayQaHubPreview.backup-*`、`retained-update-result-*` 和失败目录。新 `.8` 只能增加独立产物。

既有冷保留 `acceptance/exe-closed-profile-e4fb9c4e-4b06-429c-bdff-bc378c796531/profile` 有 109 文件/772540633 bytes 的逐文件三次一致校验，时间为 2026-09-08T21:15Z 左右。这是历史恢复点，**不是本次升级前最新 profile 的一致副本**。保持原样。

本次新保全目录使用 runtime 下 `acceptance/exe-preview8-<UUID>`。正在运行时可做可见草稿/业务只读记录、保留旧安装器和安装配置；若要声称最新整根 profile 的一致冷保留，必须先使用已观察到的正常退出入口，确认该精确路径所有进程退出且 4420 不监听，再复制到新的私有目录，按相对路径、大小、SHA256 核对源/副本/源三次相等，并确认全树无 reparse point。原目录与旧副本不移动、不覆盖、不删除。窗口 X 仅隐藏到托盘，不满足这个条件。如果当前工具仍无法操作正常退出入口，先完成隔离打包；不要以强停代替正常退出，或把运行中复制称作一致冷备份。后续由 root 明确记录采取的实际保全与退出方式。

## 3. 新包要包含的共享 Web

已发布 Web 源 commit：`7904e2c2d7285003884a5788a83300fbf521dbf1`。新包必须包含已审核并实际运行的 `assets/index-Ce9wROrH.js`：477454 bytes，SHA256 `c6e0392ff28cbb86a27aec2dc1fe1cd4b47bb3eb9e22025c95e58a7187ab367d`。`index.html` SHA256 为 `6cda7cc65a884dcaafd1ea1f8e2a3b424032cd53f0d2d972b749b374be1408b5`。本轮只读重新核对了工作树 dist 的这两个文件。

对应源文件 SHA256：

| 文件                                 | SHA256                                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| `apps/web/src/App.tsx`               | `b1e6b4eeedaf5f62d8bd1c4ce3715113f0069eaebc6ad5a35e178b586b015554` |
| `apps/web/src/api.ts`                | `b5e3c6164332e7e98aac120008315e3cdb93d4fcab2fd142105eccc128f5c2de` |
| `apps/web/src/project-drafts.ts`     | `6f0dbbca6f1d5c86e2e1b20c2d1503a93e314bf69ca3dd89c49a5314afbe9f01` |
| `apps/web/src/pending-submission.ts` | `723e2d6a83a7deb48ffa86b4ab3b0723bd5af418f6477339e6e59779ed2429d3` |

只需构建冻结的 desktop 源；此计划不要求覆盖当前已发布 Web dist。若另行重建 Web 导致 hash 改变，停止使用上述绑定结论，重新核对实际源和产物。包的完整 sourceCommit 必须记录实际打包时 HEAD，不能把 Web 的 commit 当作整个后续 EXE 的 HEAD。helper 会记录整个工作树的 sourceDirty，但不拒绝 dirty；需记录确切状态和冻结的产品源 hashes，不能因并行文档变化就虚构 `sourceDirty:false`。

## 4. 具体已读脚本风险与所用入口

| 源文件位置                                                          | 实际行为与本次选择                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/scripts/package-windows.ps1:112,125–132`              | 产品名 `RelayQaHub`、`--overwrite`；API/WS 4319、Web 4174、MCP 4320、`autoStartAtLogin=true`。不执行这个默认打包入口。                              |
| `apps/desktop/scripts/build-installer.ps1:10,22`                    | 调用上述 production 便携包脚本。不能用默认 `npm run package:win`。                                                                                  |
| `apps/desktop/scripts/sign-update.mjs:40–46`                        | 默认 publisher 密钥位于 `%LOCALAPPDATA%/Relay QA Hub Publisher/update-signing-private.pem`。本次使用 preview helper 的 runtime 独立签名密钥。       |
| `apps/desktop/scripts/test-self-update.ps1:4,7,57,275,279,293,302`  | 默认 4174 manifest/4321 MCP；访问日常自启动注册项，收尾有强制停进程及删除测试目录。不能原样当 preview 升级验收。                                    |
| `apps/desktop/scripts/test-portable-package.ps1:5,18–19,82,516,552` | 默认 4320/`RelayQaHub.exe`/`desktop-runtime.json`；涉及日常自启动项、强停和清理。不直接运行。                                                       |
| `scripts/project-components/package-preview.mjs:17–38,39–47`        | 要求显式实例、NSIS、版本；复制现有 desktop/Web dist，自己不运行编译测试；新 release 目录且不覆盖；记录 HEAD/dirty。                                 |
| 同文件 `:73–106,130–153`                                            | runtime 独立 Ed25519 密钥、校验缓存 Electron zip；固定 preview 身份/原 profile/4419/4274/4420；生成的 updater 限定真实 preview 安装路径。           |
| 同文件 `:171–202`                                                   | **打包结束会写 downloadsRoot 的 latest manifest 并 rename 发布。** 所以不能对正式 instance 直接调用后才验包。下面只重定向临时实例的 downloadsRoot。 |
| `scripts/project-components/preview-installer.nsi:20–53,56–81`      | 固定用户级 preview 目录、实例标记和 reparse 检查；唯一 backup 目录；先保留旧安装，再安装，恢复原 `preview-instance.json`。                          |
| 同文件 `:82–111,116–167`                                            | 仅 preview 快捷方式/注册项；失败保留新失败目录并尝试恢复旧目录；卸载也保留目录，但卸载不在本次范围内。                                              |
| `apps/desktop/scripts/updater.nsi:104–138`                          | 等待指定 ParentPid 退出，执行已下载安装器，然后以原 AppPath/profile 重启；等待超时应失败，不能转用批量 kill。                                       |
| `apps/desktop/src/portable-updater.ts:447–460,478–517,563`          | 安装前重新检查最新 manifest；保留旧结果、写独立 updater 配置、启动隐藏 helper、就绪后请求 app 正常退出。因此实际升级期间须固定此次已审核 manifest。 |
| `apps/desktop/src/main.ts:508–516,896–907`                          | 正常退出停止 transport/local MCP 并 `app.quit()`；`window-all-closed` 特意保留托盘进程。窗口关开与进程重启分开计证。                                |
| `apps/desktop/src/preview-config.ts:38–143`                         | 读取相邻 preview 配置，校验 profile/URL/端口，清理继承的 QA_HUB 环境并禁用 preview 自启动。保持原配置，不能指定日常 profile。                       |

这里的源码行是计划编写时位置。脚本发生变化时先重读，不把历史行号当作未来执行证明。

## 5. 后续可执行的隔离准备和打包命令

以下命令**尚未执行**。在新的专用 PowerShell 会话运行，只清理该子会话中继承的配置环境；不修改机器环境、正在运行的进程或用户设置。执行前 root 确认 desktop/Web 产品源冻结，保存 `git status --short` 与 HEAD。显式 node24 路径可由本机 `Get-Command node` 解析后锁定；不要调用 production package/release 脚本。

```powershell
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'C:\Users\lin0\.codex\worktrees\7c86\Relay-QA-Hub'
$taskNode = (Get-Command node -CommandType Application).Source
$taskNpm = Join-Path (Get-Location).Path '.tools\npm-12.0.2\package\bin\npm-cli.js'
$taskInstance = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\instance.json'
$taskRuntime = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86'
$taskMakensis = 'C:\Users\lin0\AppData\Local\electron-builder\Cache\nsis-3.0.4.1\nsis-3.0.4.1-1mx3n\makensis.exe'
$taskAcceptance = Join-Path $taskRuntime ('acceptance\exe-preview8-' + [Guid]::NewGuid())
if (Test-Path -LiteralPath $taskAcceptance) { throw 'Acceptance target already exists' }
New-Item -ItemType Directory -Path $taskAcceptance | Out-Null
Get-ChildItem Env: | Where-Object { $_.Name -like 'QA_HUB_*' -or $_.Name -in @('NODE_OPTIONS','ELECTRON_RUN_AS_NODE') } |
  ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
& $taskNode --version
git rev-parse HEAD
git status --short
foreach ($taskKey in @('private.pem','public.pem')) {
  if (-not (Test-Path -LiteralPath (Join-Path $taskRuntime ('desktop-signing\' + $taskKey)))) {
    throw 'Existing preview signing pair required'
  }
}
# This validates only public path/config fields; it does not read the referenced secrets.
& $taskNode scripts/project-components/inspect-preview.mjs $taskInstance
if ($LASTEXITCODE -ne 0) { throw 'Preview configuration rejected' }
```

NSIS root executable SHA256 at preparation: `f2b2b7726ac0d4e720dff52bfca11a5518d550fc75ed34a48dc47921527293f0`. It is the existing NSIS launcher (2560 bytes) with its sibling `Bin\makensis.exe` and Include tree; preserve that directory layout. Do not copy only the launcher into a new directory or install a different SDK to make an unexamined command pass.

The next block creates a **new staging configuration only**. The original instance stays byte-identical. `readParallelInstanceConfig` allows a configuration inside its runtime with nonoverlapping contained data directories (`parallel-instance.ts:122–153`). Keep every field except downloadsRoot unchanged. This staging variant is only for `package-preview.mjs`, never for `run-preview-service.mjs` or the Web server.

```powershell
$taskStageDownloads = Join-Path $taskAcceptance 'staged-downloads'
New-Item -ItemType Directory -Path $taskStageDownloads | Out-Null
$taskStagingConfig = Join-Path $taskAcceptance 'package-instance.json'
$taskConfig = Get-Content -LiteralPath $taskInstance -Raw | ConvertFrom-Json
if ($taskConfig.instanceId -ne 'qa-hub-preview-7c86' -or $taskConfig.runtimeRoot -ne $taskRuntime) {
  throw 'Unexpected instance'
}
$taskConfig.downloadsRoot = $taskStageDownloads
[IO.File]::WriteAllText($taskStagingConfig, ($taskConfig | ConvertTo-Json -Depth 15), [Text.UTF8Encoding]::new($false))
& $taskNode scripts/project-components/inspect-preview.mjs $taskStagingConfig
if ($LASTEXITCODE -ne 0) { throw 'Staging configuration rejected' }
foreach ($taskGate in @('typecheck','test','build')) {
  & $taskNode $taskNpm run $taskGate --workspace '@relay-qa-hub/desktop' 2>&1 |
    Tee-Object -FilePath (Join-Path $taskAcceptance ('desktop-' + $taskGate + '.log'))
  if ($LASTEXITCODE -ne 0) { throw ('Desktop gate failed: ' + $taskGate) }
}
$taskPackageOutput = & $taskNode scripts/project-components/package-preview.mjs $taskStagingConfig $taskMakensis 8
if ($LASTEXITCODE -ne 0) { throw 'Preview package failed; retain its package directory and logs' }
[IO.File]::WriteAllText((Join-Path $taskAcceptance 'package-receipt.json'), ($taskPackageOutput -join "`n"), [Text.UTF8Encoding]::new($false))
$taskReceipt = ($taskPackageOutput -join "`n") | ConvertFrom-Json
```

This packages without touching the current EXE/profile/listener. It writes a unique runtime `packages/<releaseId>` and publishes **only to staged-downloads**. It is not yet a real update or a served release. Record previous served manifest bytes/hash before and after; require equality.

## 6. Check the staged package before publication

Use the saved receipt path, not a guessed newest directory. Independently check installer size/SHA256, signed manifest Ed25519 signature using the existing public key, release identity, package EXE FileVersion/ProductVersion, package `preview-instance.json` equality to the installed one, and the asar Web bytes. This read-only Node example has no private-key access and no EXE execution:

```powershell
@'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, verify } from 'node:crypto';
import { createRequire } from 'node:module';
const { extractFile } = createRequire(import.meta.url)('@electron/asar');
const receipt = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(receipt.version, '0.2.0-preview.8');
const manifest = JSON.parse(readFileSync(receipt.manifestPath, 'utf8'));
const { signature, ...payload } = manifest;
const publicKey = readFileSync(process.argv[3], 'utf8');
assert(verify(null, Buffer.from(JSON.stringify(payload)), publicKey, Buffer.from(signature, 'base64')));
assert.equal(payload.releaseId, receipt.releaseId);
assert.equal(payload.version, receipt.version);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const archive = readFileSync(receipt.installer);
assert.equal(archive.length, payload.archive.size);
assert.equal(sha(archive), payload.archive.sha256);
assert.equal(payload.archive.sha256, receipt.sha256);
const identity = JSON.parse(readFileSync(join(receipt.packageDirectory, 'preview-instance.json'), 'utf8'));
const installed = JSON.parse(readFileSync(process.argv[4], 'utf8'));
assert.deepEqual(identity, installed);
assert.equal(identity.updatePublicKeyPem, publicKey);
const asar = join(receipt.packageDirectory, 'resources', 'app.asar');
const html = extractFile(asar, 'web/index.html');
const bundle = extractFile(asar, 'web/assets/index-Ce9wROrH.js');
assert.equal(sha(html), '6cda7cc65a884dcaafd1ea1f8e2a3b424032cd53f0d2d972b749b374be1408b5');
assert.equal(sha(bundle), 'c6e0392ff28cbb86a27aec2dc1fe1cd4b47bb3eb9e22025c95e58a7187ab367d');
assert.equal(bundle.length, 477454);
const release = JSON.parse(extractFile(asar, 'release.json').toString('utf8'));
assert.equal(release.version, receipt.version);
assert.equal(release.sourceCommit, receipt.sourceCommit);
assert.equal(release.instanceId, 'qa-hub-preview-7c86');
console.log(JSON.stringify({ passed: true, releaseId: receipt.releaseId, installerSha256: sha(archive), bundleSha256: sha(bundle) }));
'@ | & $taskNode --input-type=module - (Join-Path $taskAcceptance 'package-receipt.json') (Join-Path $taskRuntime 'desktop-signing\public.pem') 'C:\Users\lin0\AppData\Local\Programs\RelayQaHubPreview\preview-instance.json'
if ($LASTEXITCODE -ne 0) { throw 'Staged artifact validation failed' }
(Get-Item -LiteralPath (Join-Path $taskReceipt.packageDirectory 'RelayQaHubPreview.exe')).VersionInfo |
  Select-Object FileVersion,ProductVersion
Get-AuthenticodeSignature -LiteralPath $taskReceipt.installer | Select-Object Status,StatusMessage
```

Require `0.2.0.8` / `0.2.0-preview.8`. An Ed25519-signed update manifest does not imply Authenticode signing; record the actual status separately. The source of `@electron/asar` is the already installed local dependency, not an installation step. Keep updater/installer build logs and signed-manifest/receipt, including any failed run; do not retry into an existing release directory.

Only after these checks, root can preserve the currently served latest manifest to a new private filename, copy the **unique** `.8` installer into the real instance downloadsRoot using no-overwrite semantics, check bytes/hash again, then write the exact verified signed manifest to a unique temporary file beside the real latest and atomically rename it over that one preview latest. Resolve both paths through the validated original configuration, require the installer URL basename to equal the receipt installer basename, and reject an existing destination installer. Do not sign again, edit JSON fields after signature, overwrite `.7`, or switch the running Web server to the staging configuration. Read back `http://127.0.0.1:4274/downloads/<instance>-windows-latest.json` and its exact archive URL and compare signature/bytes/SHA. Until root explicitly performs this publication, status remains `packaged_only`.

Separate publication command, for root to run **only at that later publication step** (not part of building/checking):

```powershell
@'
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, renameSync, constants } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash, randomUUID, verify } from 'node:crypto';
import { readParallelInstanceConfig, canonicalInstancePath, isInstancePathWithin } from './apps/api/src/parallel-instance.ts';
const [configFile, receiptFile, acceptanceDirectory, confirmation] = process.argv.slice(2);
assert.equal(confirmation, '--publish-preview8');
const config = readParallelInstanceConfig(configFile);
assert.equal(config.instanceId, 'qa-hub-preview-7c86');
const acceptance = canonicalInstancePath(acceptanceDirectory);
assert(isInstancePathWithin(acceptance, join(config.runtimeRoot, 'acceptance')));
assert(isInstancePathWithin(canonicalInstancePath(receiptFile), acceptance));
const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
assert.equal(receipt.version, '0.2.0-preview.8');
for (const file of [receipt.installer, receipt.manifestPath]) {
  assert(isInstancePathWithin(canonicalInstancePath(file), join(acceptance, 'staged-downloads')));
}
const signed = JSON.parse(readFileSync(receipt.manifestPath, 'utf8'));
const { signature, ...payload } = signed;
assert(verify(null, Buffer.from(JSON.stringify(payload)), readFileSync(join(config.runtimeRoot, 'desktop-signing', 'public.pem')), Buffer.from(signature, 'base64')));
assert.equal(payload.version, receipt.version);
assert.equal(payload.releaseId, receipt.releaseId);
assert.equal(payload.archive.url, '/downloads/' + basename(receipt.installer));
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
assert.equal(sha(receipt.installer), payload.archive.sha256);
assert.equal(readFileSync(receipt.installer).length, payload.archive.size);
const latest = join(config.downloadsRoot, config.instanceId + '-windows-latest.json');
const destination = join(config.downloadsRoot, basename(receipt.installer));
copyFileSync(latest, join(acceptance, 'previous-served-manifest.json'), constants.COPYFILE_EXCL);
copyFileSync(receipt.installer, destination, constants.COPYFILE_EXCL);
assert.equal(sha(destination), payload.archive.sha256);
const temporary = latest + '.' + randomUUID() + '.tmp';
copyFileSync(receipt.manifestPath, temporary, constants.COPYFILE_EXCL);
assert.equal(sha(temporary), sha(receipt.manifestPath));
renameSync(temporary, latest);
console.log(JSON.stringify({ published: true, releaseId: receipt.releaseId, version: receipt.version, installerSha256: sha(destination), manifestSha256: sha(latest) }));
'@ | & $taskNode --input-type=module - $taskInstance (Join-Path $taskAcceptance 'package-receipt.json') $taskAcceptance --publish-preview8
if ($LASTEXITCODE -ne 0) { throw 'Publication incomplete; preserve all files and diagnose before retry' }
```

The exclusive copies deliberately make a partial retry fail rather than silently overwrite an earlier attempt. Do not delete partial files to force a rerun. The configuration validator rejects runtime links; repeat it immediately before this step and keep concurrent filesystem mutations out of the publication window. This is an explicit local publisher for a trusted reviewed receipt, not a generic sandbox for attacker-controlled files.

## 7. Actual upgrade and readback sequence for root

1. Record current source/artifact identities and per-path preview/daily process boundaries, original config hash and original native employee/project/draft. Read original Bug 13, its comment and attachment bytes through the authorized project-scoped existing session without any mutation. Preserve current profile using the actual approach described above. If a normal quit/cold-copy/relaunch of `.7` is used, prove its own exit and restart first; keep its evidence separate from `.7`→`.8` update evidence.
2. Publish only the staged, verified `.8` release. Use the already observed installed EXE status panel's **check updates → install and restart** action. Do not launch the installer manually and call that an application self-update. Keep the latest manifest fixed through `performInstall`'s fresh check.
3. Observe actual old preview PID exit, the `.8` installer/updater result, and the new exact-path main PID/start time. Save the newly generated `last-update-result.json` and its release/version/UTC timestamp with hashes, keep the preexisting result and backup directories, and verify the helper reports the same release. A TCP listener, hidden window reactivation, or result file alone is insufficient.
4. Verify installed ProductVersion/FileVersion, `.preview-instance-id`, unchanged original `preview-instance.json` SHA, profile path and public key. Re-read installed `resources/app.asar` with the same hash checks. Observe the actual EXE Web UI loaded from its packaged assets (`main.ts:209–225` asset resolution) and its update/version display; separately confirm the expected bundle is the packaged/loaded source. A successful `4274` browser page proves Web publication, not the running EXE's content.
5. Native readback must show the same employee/A and the exact original unsent text plus one `exe-test-input.png`. Open/read original Bug 13 without changing it; compare its closed state, version, actor fields, occurrence/comment count, attachment ID/bytes/SHA to the immediately preceding snapshot. Do not submit the old draft to test recovery. Any later commit-loss/receipt-recovery mutation uses separately authorized fresh fixtures only and does not inherit the old browser proof as an EXE pass.
6. Confirm 4420 now belongs to the new installed preview PID. Send actual local MCP JSON-RPC to `http://127.0.0.1:4420/mcp`: `initialize` with `{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"preview8-readback",version:"1"}}`, then the no-id `notifications/initialized`, then `tools/list`. Record returned version/tool directory and exact count. With the existing EXE session, call only read tools such as `qa_list_projects` and `qa_get_bug_context` with explicit A/old Bug 13, and read the known attachment through the advertised authorized resource route. Do not call `qa_login`/GM login or mutate the original identity to make a read succeed. `4421` server MCP evidence cannot substitute for this local 4420 restart/readback.
7. Independently retain direct HTTP readback of the same Bug/attachment, and verify API4419, Web4274 and serverMCP4421 retain their recorded process identities. Daily exact-path PID/start and installation/config identity must remain unchanged. If performing an additional normal restart to verify receipt/draft persistence, observe an actual process exit and new process with the same profile, then repeat native/local-MCP checks; closing the main window into the tray is recorded only as hide/restore.

MCP/HTTP records must recursively redact secret fields inside objects and JSON object/array strings, preserve primitive strings such as `"2.0"`/`"1.1.0"`, and scan known in-memory tokens before saving public evidence. Do not output private signing material, cookies, full session configuration, or profile contents. Record request/response mirrors separately from actual request counts.

## 8. Evidence and unresolved acceptance boundary

Add a new `.8` evidence directory/JSON and keep raw failures rather than rewriting them. Record: run ID/time window; actual HEAD/dirty/product source hashes; staged/published installer paths/hash/bytes/signature and Authenticode status; package+installed asar/bundle hashes; old/new preview process identities; unchanged daily/service identities; config/profile preservation approach and file manifest counts/hash; updater result and backups; native before/after screenshots; original actor/project/Bug version/comment/artifact readback; actual local MCP initialization and selected reads. Never publish private profile snapshots.

This plan has not demonstrated packaging, update, EXE commit-loss recovery, normal restart, or `.8` local MCP operation. Prior Web recovery has a successful 101-check real UI run, but applies to its independent Edge profile and Web entry only. Prior `.7` local MCP directory/readback and existing shared-source tests do not prove `.8` installed behavior. Full EXE unknown-receipt recovery, all MCP tools, external component execution and physical Android remain separate acceptance work.

Existing references retained unchanged:

- `runs/exe-after-preview7-upgrade.json` — native `.6`→`.7` update and original data/draft.
- `runs/exe-preview7-close-restore.json` — window hide/restore distinction.
- `runs/exe-independence-profile-retained.json` and `runs/exe-independence-restored.json` — historical cold preservation and same-profile restoration.
- `exe-native-personnel/result.json` — later native personnel work kept the original actor/project and original Bug.
- `runs/web-pending-submission-publication.json` — exact shared Web source/dist publication, explicitly not installed EXE update.
- `web-submission-recovery-live/README.md` and `audit.json` — both retained Web runs and the precise Web-only recovery proof.
