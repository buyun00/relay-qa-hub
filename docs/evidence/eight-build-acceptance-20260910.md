# 八项打包与瑞雪上传实测（进行中）

用户要求先完成四种安装包与增量，再完成四种纯增量。首轮统一为 2.5.1；第二轮计划 2.5.2，必须使用首轮真实基线，不把自动回退的完整热更计为纯增量通过。

## 已核验的真实结果

以下四项均通过独立 Windows EXE 的真实 MCP 4321 提交，由后端执行统一 Jenkins 打包与上传；瑞雪状态均为 60，未确认正式发布。

| 用途 | 产品/渠道 | 统一/子 Jenkins 编号 | 产物编号 | 瑞雪版本记录 |
| --- | --- | --- | --- | --- |
| Android Debug App | 2001/1002 | 10/10178 | 10179 | 849 |
| Android Release App | 2002/1002 | 13/10179 | 10180 | 852 |
| iOS Debug App | 2001/2004 | 11/46 | 47 | 850 |
| iOS Release App | 2002/2004 | 12/47 | 48 | 851 |

四项构建源码固定为 `f093f682f438c6958ad38fc4998fca5939c92c2d`。已核对精确父子构建关系、归档 build-info、APK/IPA 内实际版本与构建号、产物 SHA-256、下载 ZIP SHA-256、ZIP 内渠道配置、瑞雪版本与更新说明、测试人 11562、并发 8、资源正式目录及状态 60。Android Release 同时产出 APK/AAB；AAB 哈希已核对，真实子构建日志确认其版本、构建号与签名校验通过。

产物位于 `http://10.100.5.129:8000/ozdqp/{Android|iOS}/{Debug|Release}/2.5.1/{产物编号}/`，安装包为 packages，上传 ZIP 为 hot-update。完整本机证据在 `work/eight-build-acceptance/matrix.json`、四份 `verified-*.json`、`packages-*.json`，保留所有失败与恢复尝试。

## 实测修复

1. Android 打包脚本将 SDK/NDK 两行写成字面量 `\n`，导致 Unity 成功后 Gradle 失败。已在游戏仓库 main 提交上述 f093f682，使用 printf 写真实两行，并在 Mac 两种 xpg_echo 设置下校验。后续两种 Android 安装包均真实生成。
2. 新统一构建日志缺少旧 shell tracing 标记，页面停在准备环境。QA Hub `9d044b1` 识别新的构建、Gradle、Xcode 与 iOS 模式日志；15 项进度测试通过，真实失败日志能定位 APK 阶段。
3. Android Release 852 在 12:34:17 UTC 的 CompleteMultipartUpload 返回 403。全部 156 片此前已上传。恢复同一个任务后，核对原分片，待传分片为 0，合并成功并到状态 60。记录见 `android-release-upload-failure.json`。服务端未返回可用 serviceCode，不能断言 403 的远端原因；代码确实存在合并绕过 STS 刷新的缺口，与超过五分钟后的失败和刷新后恢复相符。
4. Worker 0.5.1 统一所有 COS 请求的凭证入口，包括合并、HEAD 与分页查询。到期和并发失败触发串行刷新；合并结果不明确时保留原检查点并返回 REMOTE_RESULT_UNKNOWN。52 项本地自检及 63 项后端回归通过，含真实 supervisor/worker 进程检查。两份旧测试同步到新产物路径与本地目录夹具。该回归不等于 0.5.1 已完成真实 COS 上传；首轮四项使用 0.5.0。

## 尚未完成

四项纯增量尚未启动。正式发布调用曾被自动审批拒绝，反馈仅为 `blocked by policy`；19:43 已询问本轮核验通过版本的最终发布授权，仍待回复。未绕过渠道预留或修改任务状态。

取得授权后，先确认四个 2.5.1 实际发布至瑞雪状态 100，再使用打包机已有 ConfirmOzdqpUploadedBaseline.py 登记基线；这一步当前是操作员脚本，并非 QA Hub 自动回写。接着固定同源码 2.5.2 批次，执行四项 Res，核对实际 incremental、基线 2.5.1、对应 Player、目标渠道与瑞雪版本。

日常 EXE、原任务、原分片、旧版本 Worker、备份和无关 docs/design 保留。Mac Android 有最终清单与备份；旧 iOS 目录备份不覆盖实际 iOS-sdk 工作目录，不宣称后者已有构建前备份。详细运行记录与后端部署前后回执位于上述 work 目录。
