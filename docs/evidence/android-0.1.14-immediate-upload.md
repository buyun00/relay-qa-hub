# Android 0.1.14：点击提交立即上传，取消低电量限制

发布日期：2026-09-09。产品源码提交：`ea2c5fcbd08f52bd6ef813694ed278983995db9b`。

## 最终行为

- 点击提交后仍先把字段与图片持久保存，再启动前台同步；无需等待 WorkManager 的调度时机。
- 自动重试继续保留联网约束，移除 `batteryNotLow`。后台任务使用 v2 名称，避免升级后继续沿用旧任务保存的电量约束；Room 原子领取与原有提交幂等键继续防重。
- 调度/网络错误与本地持久化失败分开处理，已入队的图片不会因调度异常进入保存失败的清理路径。
- 列表和新建页显示本地提交状态、未成功数量、错误码或对应 Bug 编号。永久失败也计入未成功数量，列表刷新不再覆盖提交提示。
- 最新操作只匹配同一 operationId 的回执，避免用之前成功单的回执解释正在提交的单。

本次不包含 Android 列表超过 100 条后的分页改造。

## 验证

Android 单元测试 72 条通过，失败/错误 0；`:app:lintDebug` 通过。随后从干净 main 克隆重新构建并运行同一套单元测试，发布的就是该构建产物。

创建了独立 MuMu Android 15 测试实例，索引 1，ADB `127.0.0.1:16416`。现有索引 0 的并行预览测试和未提交表单未操作。以下操作均在独立实例完成：

| 场景 | 证据与结果 |
| --- | --- |
| 旧版低电量阻塞 | 安装线上 versionCode 14，模拟电量 5%、未充电。提交 `QA_TEST_LOW_BATTERY_UPGRADE_20260909` 后，Room 为 `PENDING`，服务端尚无此单；系统记录 Battery not low=false。 |
| 保留数据升级恢复 | `adb install -r` 覆盖为 versionCode 15，保持 5% 电量。打开 APK 后原操作成功上传为 `LOCAL-430`；原账号及提交 ID 保留。 |
| 新版低电量直接提交 | 5% 电量下点击提交 `QA_TEST_LOW_BATTERY_DIRECT_20260909`，服务端约 423 ms 后入库为 `LOCAL-431`；页面显示对应成功编号。时间从测试工具发起点击前开始计量。 |
| 网络失败时保存图片 | 在同一测试实例截屏，通过仅对该实例生效的本地转发器中断 POST 连接。提交 `QA_TEST_LOW_BATTERY_RETRY_IMAGE_20260909`，本地 `RETRY`、attemptCount=1、错误 `ATTACHMENT_NETWORK_IO`；页面明确显示本机保存/自动重试。 |
| 恢复连接后自动补交 | 恢复转发器后，约 30 秒重试时上传成功，为 `LOCAL-433`。同一 operationId 和 clientSubmissionId 被保留；最终三条操作全部 `SUCCEEDED` 且回执匹配。 |

网络失败时导出的本地 PNG 为 195,912 bytes，SHA-256 为 `368b72126b8565102a6a9f6e6b0117c1a34585e865d5bb70518f181e3b42d4b2`，与草稿元数据及最终服务端附件完全一致。三条测试 Bug 均通过正式 API 按 ID 回读 200，ID 一致；没有伪造回执或手工改写本地队列状态。

首次尝试直接关闭测试实例 Wi-Fi 时，其 TCP ADB 连接也中断；使用该独立实例的 UI 恢复 Wi-Fi，随后采用转发器注入连接失败，以便在失败期间读取本地队列及图片。实际完成的失败验证是连接中断，并非持续关闭 Wi-Fi 的设备断网测试。

截图已人工视觉核对：`work/android-0.1.14-e2e/upload-failed-retained.png` 与 `retry-success.png`。原始数据库、图片归档、故障注入日志及服务端对账存于同目录，不提交包含原始数据的归档。

## 发布与回滚证据

- 稳定版本：`0.1.14-debug`，versionCode `15`。
- 包名：`com.relayqahub.android.debug`。
- APK：`Relay-QA-Hub-Android-15-0.1.14-debug.apk`。
- 大小：34,357,129 bytes。
- SHA-256：`3b759fc1ebcdbf0d06dcf9d2d1376feb7625b75f62943b1ec1ab4e60cd344530`。
- LAN 稳定 manifest、实际下载 APK、测试设备已安装 base.apk 三者大小/哈希一致。
- `apksigner verify` 通过，v2 签名有效。
- 发布后 API readiness=`ready`，schemaVersion=12。
- 前一版本 APK 保留在发布目录；旧 manifest 另存 `work/android-0.1.14-e2e/previous-latest.json`，没有覆盖同 versionCode 的不同发布字节。
- 下载地址：<http://10.100.5.157:4319/api/v1/android-updates/stable/Relay-QA-Hub-Android-15-0.1.14-debug.apk>。

测试收尾恢复了独立实例的原 API 配置、Wi-Fi 与实际电池状态，移除专用 ADB 转发并停止测试转发器。保留独立模拟器数据用于复核，测试结束关闭该实例，未删除磁盘。现有日常实例未重启、未升级、未清数据。

需要用户在实际手机安装更新后生效；上述验证不代表已操作王蕊的实体手机。
