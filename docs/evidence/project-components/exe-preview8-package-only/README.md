# preview.8 隔离打包证据

最终状态：`packaged_verified_not_published`。新安装器已经完成隔离构建和校验；正式下载目录、latest manifest、已安装 EXE、profile 配置和服务保持原状态。本轮没有安装或运行新客户端，也没有验证 `.8` 原生升级、正常重启、草稿恢复或本地 MCP。

汇总记录：[result.json](result.json)。原始记录和工具日志在 [runs](runs)；所有副本均与私有原件逐字节同 hash，原件保留在下列 acceptance 目录。失败记录没有被更名成通过，也没有覆盖。

## 构建与产物

| 字段                       | 实际值                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Run ID                     | `f4ea57e7-b24e-434c-80dd-029686bc1a98`                                                                                  |
| Source HEAD                | `33514cde1862e448cb56d7082177f34a88e42363`                                                                              |
| Source dirty               | `true`，包含并行矩阵/证据修改；原始状态清单已保留                                                                       |
| Release ID                 | `20260909T000712593Z`                                                                                                   |
| 产品/Windows版本           | `0.2.0-preview.8` / `0.2.0.8`                                                                                           |
| Desktop typecheck / build  | 均 exit 0                                                                                                               |
| Desktop unit tests         | 104/104，通过日志完整保留；不代表真实 EXE 验收                                                                          |
| Package helper             | exit 0；2026-09-09T00:07:07.659Z 至 00:09:46.364Z                                                                       |
| 最终验包                   | 41/41；只验证已有产物，没有重新打包                                                                                     |
| Installer bytes / SHA256   | 108333764 / `b72f04e882873ea0c6f69ccbb09aa7eb612a20343cff0708c0a4816d6dafa147`                                          |
| Staged manifest SHA256     | `8345d8cbf7353cde9a6c077224f32886c5b433d2efb4dcd0c39cca86df94e417`                                                      |
| 新 app.asar bytes / SHA256 | 5529881 / `0f278a740a90f198d74fce03205a311463f1f626f7d634389c6ca794540fab05`                                            |
| 包内共享 Web               | `web/assets/index-Ce9wROrH.js`，477454 bytes，SHA256 `c6e0392ff28cbb86a27aec2dc1fe1cd4b47bb3eb9e22025c95e58a7187ab367d` |
| Ed25519                    | 使用原 preview 公钥验证通过；没有替换签名密钥                                                                           |
| Authenticode               | 独立只读检查为 `NotSigned`，不与 manifest Ed25519 混为一谈                                                              |

固定路径：

```text
acceptance:
C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\acceptance\exe-preview8-f4ea57e7-b24e-434c-80dd-029686bc1a98

installer:
C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\acceptance\exe-preview8-f4ea57e7-b24e-434c-80dd-029686bc1a98\staged-downloads\qa-hub-preview-7c86-windows-0.2.0-preview.8-20260909T000712593Z.exe

staged manifest:
C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\acceptance\exe-preview8-f4ea57e7-b24e-434c-80dd-029686bc1a98\staged-downloads\qa-hub-preview-7c86-windows-latest.json

portable package:
C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\packages\20260909T000712593Z\portable\RelayQaHubPreview-win32-x64

canonical generated receipt:
C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\packages\20260909T000712593Z\receipt.json

identical retained receipt for later publisher:
C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\acceptance\exe-preview8-f4ea57e7-b24e-434c-80dd-029686bc1a98\package-receipt.json
```

两份 receipt 的 SHA256 均为 `48f141b124a0305382bcdaaf1de3537d4bd6fdce7c762c2db243f68b6ba3a2e4`。临时 `package-instance.json` 仅改变 `downloadsRoot` 为此次独立 `staged-downloads`；其他字段与正式 preview instance 相同，并通过 `readParallelInstanceConfig`。该文件没有用于运行任何服务。

包内 `preview-instance.json` 所有字段与当前已安装配置相同，保留原 instance、runtime `desktop/profile`、API4419、Web4274、local MCP4420、cookie、更新 URL 和公钥。包内 HTML 及 bundle 实际 bytes 已读取和 hash 校验，并非只检查文件名。Web dist 全部文件的前后清单相同，没有重建或修改 Web；desktop 源及三个打包/updater 源也保持不变。

## 失败历史与计划勘误

1. [first-build-result.json](runs/first-build-result.json)：typecheck、104 tests、build、package 均 exit 0，已完成 23 个检查全部通过。随后 harness 用 `JSON.parse(all stdout)` 解析了 `Packaging app ...` 与 JSON 回执组合，抛出 SyntaxError。安装器实际已成功生成。保留原 runner、日志和失败 JSON，没有重打包。
2. [first-verification-result.json](runs/first-verification-result.json)：24 个已完成检查通过，随后 Windows `@electron/asar` 的多层路径查找拒绝了 `'web/assets/index-Ce9wROrH.js'`。只读 archive listing 证明文件存在；该库内部按 `path.sep` 分层。新验证脚本使用 `path.join('web','assets','index-Ce9wROrH.js')` 读取到正确 bytes。原失败记录保留。
3. [windows-verification-result.json](runs/windows-verification-result.json)：直接读取工具生成的 `receipt.json`，用 Windows `path.join` 访问 asar，41/41 校验通过。没有重建或修改安装器。其嵌套 Windows PowerShell 无法自动加载 `Microsoft.PowerShell.Security`，所以原 JSON 的 `metadata.AuthenticodeStatus` 为空；不能据此声称 Authenticode 检查通过。随后在工具宿主 PowerShell 独立执行的真实 [authenticode-readback.json](runs/authenticode-readback.json) 为 `NotSigned`。该补充没有改写前一份记录。

冻结的 `exe-preview8-recovery-plan.md` 仍是准备历史。后续执行其命令时必须应用两项已经实测确认的勘误：用生成的 receipt 文件代替解析整个 packager stdout；Windows asar 多级文件名用 `path.join`。发布时可直接采用上面的同 hash receipt 副本，不需要再跑 package helper。

## 正式运行现场未变

前置记录时间 `2026-09-09T00:06:56.9276937Z`，最终对照时间 `2026-09-09T00:13:24.6987958Z`。精确路径/PID/父 PID/启动时间全部相同，包括 preview 主进程 23924、日常主进程 17160 及它们列出的子进程。listener 始终为 Web4274→20284、API4419→10036、local MCP4420→23924、server MCP4421→15736；都仅绑定 127.0.0.1。

| 保留对象                     | 前后相同的 SHA256                                                  |
| ---------------------------- | ------------------------------------------------------------------ |
| 正式 preview instance.json   | `2b8e97ce9b62d072b74eaf00015fb04f5b818d318203f2a91e59d15873da349b` |
| 正式 `.7` latest manifest    | `ead43d0162c71581834e8917035db85f97c74e86a064b386894c6cdda24efc7c` |
| 已安装 preview-instance.json | `aa98507fd6dbe84c360e845859af69c4f5ed1724975ecc10b7561015cf76ac83` |
| 已安装旧 app.asar            | `6b1eb7d4fe064a8c3046acaa744520d887790c69f7663e0f1b00ce37d3102ba9` |
| 已安装旧 EXE                 | `0bf93a8496b9b233e8d0f7ef15be4274a3759e3b047dda982e4045e528a1b099` |
| 原 preview 公钥              | `e0a52488fc59ed7c1c8c119d1ba73332a3cce7a33cad168754e46ebb2ff914b1` |

正式下载目录没有新 `.8` 安装器，正式 latest 仍为 `.7`，已安装版本仍 `0.2.0-preview.7` / `0.2.0.7`。本轮没有读取或复制正在运行的 profile 全量内容，也没有重新检查原生旧草稿；进程/config 未变不能替代最新草稿的真实保全证据。

root 后续需要另立窗口完成审核后的发布、保全、实际升级、正常退出/重启和 4420 本地 MCP 读回。本目录不能将 EXE 未知回执恢复、原生 UI 升级或整个基线14标记为通过。所有源/矩阵/原 proof 保持不改；本轮没有提交。
