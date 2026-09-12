# OZDQP 统一快捷打包与下载（3.5.3）

Web、Windows 和 MCP 共用 Jenkins `00-【OZDQP】【快捷打包】`。点击下列任一项，选择“只构建”或“构建并上传增量”。API 仅提交 `打包用途`，其他参数沿用该任务当前默认值。Jenkins 凭据始终留在 API 服务端。

| preset              | Jenkins 打包用途                     | 产品 / 渠道 |
| ------------------- | ------------------------------------ | ----------- |
| android-debug-app   | Android Debug · APK、完整热更        | 2001 / 1002 |
| android-debug-res   | Android Debug · 增量热更             | 2001 / 1002 |
| android-release-app | Android Release · APK、AAB、完整热更 | 2002 / 1002 |
| android-release-res | Android Release · 增量热更           | 2002 / 1002 |
| ios-debug-app       | iOS Debug · IPA、完整热更            | 2001 / 2004 |
| ios-debug-res       | iOS Debug · 增量热更                 | 2001 / 2004 |
| ios-release-app     | iOS Release · IPA、完整热更          | 2002 / 2004 |
| ios-release-res     | iOS Release · 增量热更               | 2002 / 2004 |

增量构建缺少兼容基线时，打包脚本可能升级为完整构建；以最终清单的实际热更方式为准。

## 四组自动判断

页面按 Android / iOS 两列排列，每列分 Debug、Release，每组并排显示完整包与增量热更。窄窗口改为上下排列。默认显示“开始检测”，普通刷新只更新页面数据。从其他分页切入并连续停留 2 秒后自动检测一次；2 秒内离开取消。手动点击立即检测并取消待执行的自动检测；进行中的批次不会因再次点击、切页或刷新重复提交。检测期间继续显示排队、比较累计修改等状态，失败或未知不会沿用旧的绿色结论。

检测在 Jenkins 的独立 `【OZDQP】【兼容性检测】` 任务中执行，已去掉序号并保留原任务历史。每批只提交一个任务，占一个 executor，内部以 4 个线程同时运行四个 Python 检测进程。先同步一次 main，再为各组准备独立 Git 引用和报告目录，避免缺失基线补拉时争用 Git 锁；全局 executor 数量和正式打包的调度保持原样。后端每次读取原 `00-【OZDQP】【快捷打包】` 配置中当前嵌入的两个 Python 检测模块，校验模块名与大小后传给沙箱 Pipeline，未复制或重新解释用户的业务判断规则。页面关闭后 Jenkins 检测继续，服务端保留 queueId；多人同时进入时共用尚未结束的这一批检测。

该任务的 Pipeline 为仓库 `scripts/jenkins-compatibility.groovy`，必须启用 Groovy Sandbox、禁止同任务并行、quietPeriod=0；参数为 `四组并行 · 快捷检测` 及保留的四个 `{Android|iOS} {Debug|Release} · 快捷检测` 的 `打包用途` Choice、默认 `自动：最新成功版本` 的 `参考版本` String、空默认值的 `CHECK_SOURCE` Text。通过 QA Hub 启动时自动传入最新源码；Jenkins 页面直接启动且未提供源码会明确失败。检测源码格式发生变化时停止检测并提示重试，需要重新核对接口；不会改用旧规则。最初非沙箱方案被 Jenkins 审批机制拒绝，正式版本已改用沙箱，不放开内部 Jenkins API 权限。

登录后 POST `/api/v1/packaging/compatibility`，携带 UUID `Idempotency-Key`，不接受构建预设或命令；返回四项检测及批次 id。GET `/api/v1/packaging/compatibility?id={id}` 查询状态。每次手动检测或停留满 2 秒的页面入口使用新 id，正在运行的批次合并；同一 id 重试不会重投已确认任务。四项共用 queueId/buildNumber，按 `checks/{android-debug|android-release|ios-debug|ios-release}/compatibility.json` 读取各自报告，继续校验平台、配置与安装包 lineage。单项报告缺失只标记该项失败。服务端状态保存在生产 integrations 下 `build-compatibility/current.json` 与 `runs/{id}.json`。提交结果未知时不盲目重发。检测只读代码和产物并归档报告，不分配发布版本、不构建、不上传。

原脚本先找到该平台配置的最新成功版本，再沿 `playerLineage` 回溯到实际 APK/IPA，比较该安装包源码至最新 main 的全部变化。页面显示参考版本、实际安装包、两端源码 SHA、累计提交及文件数、检测时间和完整报告链接。结论有：必须重新打完整包、允许只打热更、缺少安装包基线、无法判断。**允许热更只表示安装包兼容；能否生成纯增量 ZIP 还需要已确认上传的资源基线**，不能混为一个结论。

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

统一任务进入下游后，后端校验上下游关系并读取实际下游阶段。等待构建锁时显示“正在排队”，等待耗时不计入准备环境。Unity 项目路径错误映射为 `BUILD_PROJECT_PATH_INVALID`，页面明确显示“Unity 项目路径配置无效”，不暴露原始日志或凭据。整体进度优先使用同一预设、实际构建方式与 ZIP 配置的成功记录总耗时中位数；显示样本数及“总耗时估算”，等待期间不增长，尚未确认成功最高显示 95%。历史日志缺少阶段时间戳时仍可估算整体进度，各阶段继续明确标记未记录。统一入口未计时的完成校验阶段可由已验证的下游成功结束时间恢复边界，避免丢失已有 Android 阶段样本。iOS 任务启用 Timestamper 后，后续构建会保存阶段时间戳；旧日志不补造时间。无可靠耗时样本不虚构阶段百分比；状态未知时继续查询原任务。

旧的一键任务继续按其原 Android job 和原 ZIP 规则读取，不改写检查点；旧客户端 external 预设映射为 Android Release App，旧内网预设已不适用。新版页面使用独立的 quick-v1 跟踪存储键，防止旧 job 编号被套到新入口。

一键上传及上传执行始终在后端，关闭 EXE 不会停止。测试人默认 11562，保留用户显式选择；默认 8 个分片并发。只有“完成发布”和“最后确认前”两个模式。完成发布须同时满足 `published=true` 和 `remoteStatus=100`。

## 验证边界

8 项参数、渠道、跨重启交接、清单归属和文件校验有自动化测试。2026-09-10 真实统一构建 #2 已提交并追踪到 Android #10174，但打包机报告 Unity 项目路径重复拼接，构建失败，无上传触发。该结果只证明入口及失败回传，不能作为成功构建或瑞雪发布证据。发布验收见 `docs/evidence/windows-3.4.0-quick-build.md`。
