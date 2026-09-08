# Android code 22：无需代码提交与原生闭环

2026-09-09 在独立 MuMu 预览包完成 **21 → 22 覆盖升级，以及原生“开始修复 → 提交无需代码的处理 → 验收通过并关闭”**。修复后交付请求成功，界面进入待验收，最终关闭。此问题位于本目标提交 `3b1371cbbaee4ab31f5861fe3cd72d6ff93c4789` 新增的 `BugLifecycleClient.kt`；该文件在基线 `62b4495c9b28dc3aea1d5633e870be4e1fdf841f` 中不存在。

客户端在交付后重新读取 Bug，核对请求 Bug ID、响应 ID 和项目 ID。实际状态已经为 `ready_for_verification` 时返回成功；其他状态保留原 `/complete` 请求、最新版本 CAS 和服务端前置条件。代码交付仍使用原有真实分支／提交字段。`BugLifecyclePanel` 原生按钮直接调用该客户端，未替换 UI 路径或增加测试专用成功分支。

新增 7 条测试直接执行实际 `BugLifecycleClient` 与 `ProjectOperationsClient`，拦截请求并返回合同响应：覆盖无需代码不重复完成、代码交付继续完成且使用最新版本、已交付请求不重放、首次／交付后错误 Bug 或项目拒绝、旧版本拒绝、其他状态完成冲突向 UI 传播。`org.json:json:20240303` 仅为 JVM 单元测试依赖，不加入 APK 运行依赖。全部 **87/87 单元测试通过，lint 0 errors / 29 warnings**，之后单独离线构建 APK。原始输出见 [unit/lint](runs/android-code22-unit-lint-retry.txt)、[build](runs/android-code22-build.txt) 和 [新增 JUnit 原始结果](android-code22/BugLifecycleClientTest.xml)。首次 PowerShell 未引号 `-D` 参数导致 Gradle 任务名解析失败，未运行测试，其 [原始失败输出](runs/android-code22-unit-lint.txt) 保留。

| 原生动作           | 官方 HTTP 读回                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| 开始修复           | Bug `in_progress` v3；human RepairAttempt `running` v2                                                    |
| 提交无需代码的处理 | Bug `ready_for_verification` v4；RepairAttempt `delivered` v3；构建需求 `not_required / no_code_delivery` |
| 验收通过并关闭     | Bug `closed` v6；Verification `passed` v3                                                                 |

项目 `fb914b3b-4169-47f8-8dec-76f3a3cc780d`，Bug `386cdd2f-44c9-4a79-992a-891d595766fd`（`TA1788885078625-17`），操作者 `69730f4d-53d5-44bc-873d-7337a01e8365`。RepairAttempt `841d3463-a86a-4c30-b246-4c8c97db1d7d`；Verification `5d527027-62ca-4a78-a75c-cd598eab8e54`。Bug 通过官方预览 API 创建为独立 fixture，后续上述所有状态写入均由已安装 APK 的原生按钮触发；独立 HTTP 仅作读回。API PID `18644` 的真实日志中，按这三个 ID 匹配的 **49 个请求全部 2xx，`deliver` 为 1 次，`/complete` 为 0 次**。精确时间、请求 ID、路径和状态均收录于 [机器证据](android-code22-no-code.json)。开始至关闭时间为 `2026-09-08T20:42:24.552Z` 至 `20:43:31.345Z` 附近。

原生证据：[开始后](android-code22/after-start.png)、[提交按钮](android-code22/submit-ready.png)、[提交后待验收](android-code22/after-submit.png)、[可达验收按钮](android-code22/verify-actions.png)、[验收确认前](android-code22/verify-ready.png)、[关闭](android-code22/closed.png)、[原有未提交草稿仍在](android-code22/retained-draft-three.png)。相邻同名 XML 保留 UI 层级。MuMu 的 `uiautomator dump` 在报告成功写出 XML 后多次返回 139，另一次返回其他非零状态；独立 `screencap`、应用存活和实际 HTTP 读回均正常，后续层级抓取改用每步唯一目标文件并保留退出状态。这是工具退出异常，不作为 APK 流程失败或成功的替代依据。

安装前将 code 21 APK 和预览应用 `shared_prefs/files/databases` 私有归档；不清除数据、不卸载。使用相同 debug 签名执行 `adb install -r`，升级前／升级后／闭环后逐项验证：预览草稿 XML、待上传 PNG 和 sidecar 三个 SHA256 一致；日用 `com.relayqahub.android.debug` 仍为 code 14、PID 5051，安装时间、数据路径和四份配置文件 SHA256 不变。实际打开新建页仍显示 `UNSENT_CODE20_TO_CODE21_CAPTURE_DRAFT_KEEP` 与原截图。会话和应用私有归档只保存在仓库外，不进入证据目录。

最终 APK：`C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/android-code22-acceptance/qa-hub-preview-code22.apk`，35,471,405 bytes；包名 `com.relayqahub.android.preview.debug`，code 22，`0.2.0-preview.8`；SHA256 **`733088b8f876c41ce767627c6de8dfe12e00803c0b61ff13c6facd3b8982d777`**。新旧证书 SHA256 均为 `9bbf6d2a68c27871c00abc3203fb319629aabacdcac03674483262bcf09e2a83`。code 21 保留在同目录 `retained-code21.apk`，SHA256 `d783e9908e7dacdd660565cf15e1624c567a820e973d01190a38a0981afe7255`。全部私有脚本、原始读回、设备保全 JSON 和数据归档保留在该 runtime 根。

本次仅证明独立模拟器中的预览 APK 升级和无需代码人工作业。真实物理设备、真实代码分支交付和外部组件执行未运行；五组件均保持停用。未触碰生产、日用 APK 进程／数据、已有未提交草稿，未自行提交 source。
