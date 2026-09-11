# 配套脚本验证记录

验证时间：2026-09-09 15:47（北京时间）。运行环境：Windows、Node.js v24.19.0、ADB 连接的 MuMu `127.0.0.1:16384`；包名 `com.relayqahub.android.debug`，版本 `0.1.13-debug` / 14。

- 对已有测试账号执行完整只读导出，连续两遍 DB/WAL 一致。
- `PRAGMA integrity_check` 返回 `ok`，外键异常 0。
- 找到 1 条 `SUCCEEDED`，同一操作、账号、项目、安装、会话与提交 ID 的回执匹配；异常 0。
- 两个限定媒体目录成功导出为 tar，当前目录为空；归档条目可读取。未通过此验证证明非空媒体或用户真实手机图片完整。
- 使用王蕊 actorId 检查该 MuMu，得到 0 条；脚本返回 `allRecordedOperationsConfirmedInLocalSnapshot=false`，没有把“设备上没找到这个账号的记录”认定为全部上传。
- 初次运行发现 Android `ls` 默认输出多列；脚本已改为 `ls -1`，上述通过结果来自修正后的版本。

验证期间未安装 APK、未停止应用、未修改设备数据库、未创建或补交任何 Bug。只在维护电脑创建证据文件。

**此记录只证明脚本在上述环境的读取路径可用。王蕊实际手机未连接到维护电脑，本记录不能证明其队列清空。**

复核记录保存在维护工作区 `work/android-queue-handoff-validation-20260909-r2/` 和 `work/android-queue-handoff-validation-20260909-empty/`，不包含在交付压缩包内，避免传递无关账号的原始数据库。
