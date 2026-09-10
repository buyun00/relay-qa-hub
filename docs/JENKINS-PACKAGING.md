# OZDQP 统一快捷打包与下载（3.4.0）

Web、Windows 和 MCP 共用 Jenkins `00-【OZDQP】【快捷打包】`。点击下列任一项，选择“只构建”或“构建并上传增量”。API 仅提交 `打包用途`，其他参数沿用该任务当前默认值。Jenkins 凭据始终留在 API 服务端。

| preset | Jenkins 打包用途 | 产品 / 渠道 |
| --- | --- | --- |
| android-debug-app | Android Debug · APK、完整热更 | 2001 / 1002 |
| android-debug-res | Android Debug · 增量热更 | 2001 / 1002 |
| android-release-app | Android Release · APK、AAB、完整热更 | 2002 / 1002 |
| android-release-res | Android Release · 增量热更 | 2002 / 1002 |
| ios-debug-app | iOS Debug · IPA、完整热更 | 2001 / 2004 |
| ios-debug-res | iOS Debug · 增量热更 | 2001 / 2004 |
| ios-release-app | iOS Release · IPA、完整热更 | 2002 / 2004 |
| ios-release-res | iOS Release · 增量热更 | 2002 / 2004 |

增量构建缺少兼容基线时，打包脚本可能升级为完整构建；以最终清单的实际热更方式为准。

## 本次构建与上传的关联

后端持久化 queueId 与统一入口 buildNumber，等待该构建成功，再读取它归档的 `build-result.json`。检查清单中的下游 `requestId`、下游成功状态和 upstream cause，确保它确实属于本次统一构建。产物计数器与 Jenkins 下游构建编号可能不同：查询下游用 requestId，拼接下载目录用清单 buildNumber。

清单必须 ready，平台、Debug/Release、产品、渠道与选择一致；瑞雪版本、更新摘要和说明均直接使用清单 `releaseVersion`。旧上传草稿的版本号不会覆盖构建版本。App 模式检查必需的 APK/AAB/IPA 和完整热更结果。

下载统一来自：

```text
http://10.100.5.129:8000/ozdqp/{Android|iOS}/{Debug|Release}/{releaseVersion}/{buildNumber}/
  build-info.json
  packages/*.apk|*.aab|*.ipa
  hot-update/*.zip
```

后端根据经过验证的清单派生固定地址，上传前锁定 ZIP 大小、Last-Modified 和 SHA-256；worker 下载或复用缓存时再次校验大小与哈希。版本、目标、清单或文件不一致时停止上传，不回退到其他构建的最新 ZIP。恢复任务保留原包及原版本。

下载页按平台和配置分组，展示已核验版本、产物构建编号和真实文件链接。服务器折叠的 `版本/构建号` 目录同样支持。单独上传可选择已有版本；留空只选该平台配置最新的已核验构建。二维码与 EXE 下载指向同一原始文件，手机需能访问内网。

## 进度与兼容

登录后 GET `/api/v1/packaging`；POST `/api/v1/packaging/builds` 携带 `{preset}` 和 `Idempotency-Key`。GET `/api/v1/packaging/progress?queues=797&builds=2` 查询准确队列及构建。只有收到合法 Jenkins 队列回执才显示已提交；未知提交结果不得自动重发。单独构建去重仍是 API 进程内 24 小时缓存，不宣称跨服务重启的永久幂等。

统一任务进入下游后，后端校验上下游关系并读取实际下游阶段。等待构建锁时显示“正在排队”，等待耗时不计入准备环境。Unity 项目路径错误映射为 `BUILD_PROJECT_PATH_INVALID`，页面明确显示“Unity 项目路径配置无效”，不暴露原始日志或凭据。无可靠耗时样本不虚构百分比；状态未知时继续查询原任务。

旧的一键任务继续按其原 Android job 和原 ZIP 规则读取，不改写检查点；旧客户端 external 预设映射为 Android Release App，旧内网预设已不适用。新版页面使用独立的 quick-v1 跟踪存储键，防止旧 job 编号被套到新入口。

一键上传及上传执行始终在后端，关闭 EXE 不会停止。测试人默认 11562，保留用户显式选择；默认 8 个分片并发。只有“完成发布”和“最后确认前”两个模式。完成发布须同时满足 `published=true` 和 `remoteStatus=100`。

## 验证边界

8 项参数、渠道、跨重启交接、清单归属和文件校验有自动化测试。2026-09-10 真实统一构建 #2 已提交并追踪到 Android #10174，但打包机报告 Unity 项目路径重复拼接，构建失败，无上传触发。该结果只证明入口及失败回传，不能作为成功构建或瑞雪发布证据。发布验收见 `docs/evidence/windows-3.4.0-quick-build.md`。
