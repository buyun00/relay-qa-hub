# Android code23：原产物发布与 preview feed 方案

发布状态：`not_run`。本轮仅核对源码、独立 runtime 文件及既有证据；未发布 APK/latest、未操作设备，也未连接当前 API 执行业务。原状清单在 [before.json](before.json)。后续 API 路由修复和隔离测试另行记录，不能当作实际发布或原生自更新。

## 原产物与默认项目

建议继续使用已经 `install -r` 并完成限定 legacy 文本恢复的 **原 code23 APK**，不为了发布再编译同 versionCode 的不同 bytes。

| 字段                    | 值                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原 APK                  | `C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\android-code23-recovery-65ee5dc8-3f23-4f28-ad97-daa1de8b0ece\qa-hub-preview-code23.apk` |
| 大小 / SHA256           | 35536941 / `9cfa87eb36b5be80f218e104fb4c6338fda3e96e5dcc694d897c5907df768548`                                                                       |
| package / version       | `com.relayqahub.android.preview.debug` / code23 / `0.2.0-preview.9`                                                                                 |
| 原签名证书 SHA256       | `9bbf6d2a68c27871c00abc3203fb319629aabacdcac03674483262bcf09e2a83`，与 code22 相同                                                                  |
| 构建默认项目            | `b9a42a41-c15d-4393-8568-61d22a30ba98`，独立 AndroidRecovery 项目                                                                                   |
| 已验证的 build 默认连接 | API `http://127.0.0.1:4419/api/v1/`；游戏包目录 `https://qa-hub.invalid/disabled/`；Poco5503 为隔离 fixture 值                                      |
| 当前保留 code22         | `runtime/android-code22-acceptance/qa-hub-preview-code22.apk`；SHA256 `733088b8f876c41ce767627c6de8dfe12e00803c0b61ff13c6facd3b8982d777`            |

本次只读重新计算两份 APK SHA，均与上述既有证据相同。签名结论绑定相同 APK bytes 和已保留的 apksigner 记录，没有操作设备重新验收。原 code23 结果为 `passed_scoped_legacy_text_recovery`，明确不是应用内自更新，也不是物理设备验证。

默认项目按 `entryProjectId` → 持久化项目 → BuildConfig 项目决定：`QaHubRoot.kt:41,75`、`QaIdentityStore.kt:18`。同 API origin 的现有安装保留原项目选择，不会因为 APK 默认 b9a42… 而自动改到该项目。新安装且没有选择时会预填 b9a42…；登录面板会读项目名并允许修改项目 ID（`QaHubRoot.kt:164–186`）。`QaRuntimeConfig.kt:19–21,50–53` 只允许 `schemaVersion/apiBaseUrl`，不能往 runtime JSON 添加 `projectId` 试图覆盖默认值。

因此：

- 当前独立试用/升级可以复用原 code23，并明确其新安装默认是恢复 fixture 项目。原项目的测试数据和证据必须保留，不能为了发布“清空”它。
- 若试用要进入 A 或另一个明确项目，可以使用登录面板或 `qahub-preview://project/<UUID>`（`MainActivity.kt:151–155`），不需要另一个 APK。现有用户不得被发布脚本切换身份。
- 若要求“全新安装打开即是另一个项目且不需入口选择”，那是另一次显式新 build，必须用大于23的新 versionCode、新产物路径和重新验证；不能覆盖已验证 code23。这不属于本轮。
- 原 code23 proof 的五组件均 off；本次未通过 HTTP 刷新当前配置。真正发布前由 root 以只读方式确认目标试用项目的五组件仍 off；不配置/调用生产资源。Poco 和真实游戏连接仍不作为已验证能力。

## 现有发布入口及确定缺口

当前独立 downloads 只有 code22 的不可变直接下载 APK 和 receipt，未发现 Android latest。code22 历史发布证据是 `runs/android-code22-download-publication.json`，明确没有验证应用内自更新。

`scripts/Publish-QAHubAndroid.ps1` 不应直接作为 preview publisher：默认读取生产 `D:\Relay-QA-Hub-Data\mvp-e2e-current.json`（3）；未给 SkipBuild 时调用生产默认 build（18–24）；即使明确 ApkPath，它仍从工作树当前 `output-metadata.json` 取版本/package（15–45），可能与保留 APK 不同；即使明确 UpdateRoot/SkipBuild，仍读取 RuntimeStatePath（53）。latest 替换后会删除旧 backup（97–104），不符合本次保留全部历史。`Build-QAHubAndroidDebug.ps1:3,35` 也有生产运行状态/4319 默认，不能用于此次原产物发布。

当前 APK 固定 `QA_HUB_UPDATE_CHANNEL="preview"`（`build.gradle.kts:59`），客户端读取 `/api/v1/android-updates/preview/latest.json`（`ApkDistributionClient.kt:79`）。修复前 API 只注册 `stable` 固定路径（`android-updates.ts:7`）；4274 仅把 `/api/` 原样代理到4419（`preview-web.mjs:27–45`），不会补 preview alias。单独复制 latest 无法修复这条客户端路径。

最小路由修复：只允许 `stable | preview`，未配置仍 stable；parallel instance 显式选择 preview；只注册选定 channel 的固定路径，另一个返回404，不接受任意 channel/path。物理目录保持 instance 隔离：

```text
C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\downloads\android\qa-hub-preview-7c86
```

preview 新 manifest 要求 `channel:"preview"` 和精确 preview/debug package，校验 schema/version/文件名/大小/SHA 格式，错 channel 或日常 package 拒绝。stable 旧 schema1 无 channel 仍兼容，不能借修复提高其必填要求。服务不伪装为 APK 签名解析器：发布前验证原 artifact 签名/hash，原生下载校验 SHA，原生安装前核 package/version，Android 同包升级校验签名。

## 首次 preview manifest 模板与最小发布步骤

下面只是可审阅模板，尚未写入运行目录。API 文件名白名单要求 `Relay-QA-Hub-Android-...apk`，不能把现有 code22 自定义直接下载文件名直接放进 feed。

```json
{
  "schemaVersion": 1,
  "channel": "preview",
  "versionCode": 23,
  "versionName": "0.2.0-preview.9",
  "packageName": "com.relayqahub.android.preview.debug",
  "fileName": "Relay-QA-Hub-Android-23-0.2.0-preview.9.apk",
  "size": 35536941,
  "sha256": "9cfa87eb36b5be80f218e104fb4c6338fda3e96e5dcc694d897c5907df768548",
  "sourceCommit": "33514cde1862e448cb56d7082177f34a88e42363"
}
```

这是现有 Android schema1 元数据，不是 Ed25519 签名清单。新字段 channel 被当前客户端兼容忽略，由 preview API 校验；APK 自身的 debug certificate 与证据中的原包一致。

1. 根确认 API 修复已通过测试并在另一个明确窗口部署后，读取真正的 `/api/v1/android-updates/preview/latest.json`，区分未发布404和错误配置503。本轮不部署或重启。
2. 新建独立发布 acceptance 目录。保留现有 code22 APK、receipt、任何已有 latest 的完整原 bytes/hash；原目录文件不删除、不改名覆盖。当前没有 latest，则明确记录“首次发布”，不能造旧 manifest。
3. 从上面的原 code23 路径复制到该实例 feed root 下**唯一临时文件**，检查 35536941 bytes/SHA/package/version/certificate 与已验原包一致，再以 no-overwrite rename 为模板 fileName。目标已经存在且 hash 不同则拒绝；相同 bytes 仅作为已经保留产物读回，不覆盖。
4. 将精确 manifest 写入同目录唯一临时文件，检查 UTF-8/schema1/channel/package/fileName/size/SHA；只有全部通过后原子替换 preview latest。若已有 latest，先独立完整保留；不执行删除旧 APK/旧 manifest/失败临时文件。不要调用默认 publisher 或重新构建 APK。
5. 通过实际4419 preview GET/HEAD/Range 读回 manifest 与 APK 完整 body/SHA；确认 stable URL 不指向 preview 内容。通过4274时使用 `/downloads/android/qa-hub-preview-7c86/<fileName>` 可读同一份原包；记录真实内容类型/字节和实例头。API Web服务均无需因单纯文件发布重启。
6. 旧 code22 直接 URL `http://127.0.0.1:4274/downloads/qa-hub-preview-7c86-android-0.2.0-preview.8-code22.apk` 保持可读且 SHA 相同。新 feed 和旧直接 URL 并存，不强迫将旧包移走。回滚试用清单只回到已保留 metadata，不能宣称已经安装23的设备会自动降级22。

同设备已装23时版本比较会显示 up-to-date（`FoundationViewModel.kt:164–190`）；它不能证明22→23应用内安装流程。后续若验证该流程，应另行保全并授权适当的旧版本预览测试安装，不能对现有23或日常包做降级/清数据。本轮不操作设备，也不声称完成原生自更新。
