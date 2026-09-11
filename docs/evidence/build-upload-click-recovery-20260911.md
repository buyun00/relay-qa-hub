# 打包并上传点击后未触发 Jenkins：已发布状态未同步

2026-09-11 现场有 3 条 `android-debug-res` 任务在服务端排队，`queueId=null`、`errorCode=UPLOAD_CHANNEL_HELD`。点击请求已被接受；旧任务的渠道预留使它们没有进入 Jenkins。“只构建”不经过上传队列，因此仍能触发。

瑞雪真实 GET 返回 849、850、851、852 四个 2.5.1 版本均为状态 100，并有发布时间；本地 Worker 停在 `prepare_publish` 的状态 60，停止后没有再核对人工发布。修复复用 Worker 的版本、产品渠道、原上传对象资源目录和发布时间校验，只读核对远端发布结果。独立保存与原运行、配置和状态摘要绑定的核对收据；原状态、结果、日志和 ZIP 均保留。未知、身份不符和仍未发布的结果继续保留渠道锁。

页面新增提交回执、渠道等待的中文原因、上传状态检查反馈和菜单内错误提示；同页面再次点击本人尚未完成的相同打包预设时提示原任务，不再新建重复任务。已经存在的任务保留。

## 验证与证据

- 后端上传/构建宿主、资源选择 41 项通过，持久化队列与真实 Worker 进程 20 项通过。
- 回归覆盖只读 GET、身份与资源目录不匹配、未发布/不可达、运行中不核对、检查中状态改变、重启读取核对收据，以及释放原队列后不重复构建。
- 原始 140 个 JSON/JSONL 文件和一致性 SQLite 备份在 `work/build-upload-click-fix/server-before/`。使用备份副本运行新代码，真实查询瑞雪 4 次 GET，四项均核对成功，140 个原文件哈希不变；未发起平台写操作。详情在 `live-reconciliation.json`。
- Web 单元测试 56 项通过；独立浏览器交互验证提交回执、渠道等待原因、重复点击复用原任务、只构建、菜单内错误及账号/程序未就绪提示，记录在 `ui-verification.json`。该项使用明确标注的 HTTP 测试数据，不算业务上传成功。

## 部署、用户停止指令与最终状态

后端源码 `886c6b8d9f1183fa4ec79a12ec9b5fc88cb0ddfd` 已于 11:30 部署，readiness 为 ready。四条旧任务通过真实瑞雪 GET 核对后展示 `published=true / remoteStatus=100`，没有重新调用发布。

部署后原任务 `d37c5fd5-c4c4-4179-b6f3-6a6874c0ad49` 曾获得 Jenkins queue 931、快捷构建 17、Android 子构建 10182，证明原来的渠道阻塞已解除。随后用户明确指示“不要恢复原来的任务”：立即通过服务端取消三条原任务，包括另外两条 `a2b7f540-d156-4a1a-a8e9-532d69e2815b`、`bd87042d-8179-48cf-865c-7e4cacdc1255`；三条均为 cancelled、uploadJobId=null。核对父子构建身份后停止快捷构建 17，Jenkins 回读父构建及 Android 10182 均 `building=false / result=ABORTED`。未启动任何新的增量上传。回执为 `cancel-original-tasks.json`、`stop-restored-build.json`。

这次只修复未来提交的功能，原任务保持取消。上传记录仍有 16 条，接口可见的 20 条构建链记录均保留。原始 140 个文件中 139 个哈希完全不变；唯一变化是另一账号 auth.json 中正常续期的 accessToken/refreshToken，账号与其他字段不变。原 Worker 状态、结果、日志、配置和 ZIP 没有覆盖；新发布核对记录单独保留。详见 `production-verification.json`、`auth-preservation.json`。

EXE / Web 3.5.1 已发布，releaseId `20260911T033325460Z`，来源同一提交。安装器 150,487,036 bytes，SHA-256 `2bdaa8ebe471092bb2cc467014ed78c272e6db9d5a87aae8bd32e7bcde8e2bae`；便携 ZIP 155,464,825 bytes，SHA-256 `3c6e92d68c97000b4a4ccfadd0d1e80c315e5b9db5a1dd7d9f17dc9203d2974d`。线上两个下载文件哈希、签名清单、包内 release.json、打包源码及 Web 资源核对一致。

独立真实 EXE 连接生产 API，8 个菜单均验证产品/渠道/测试人和可用状态；MCP 回读四条已发布记录和三条已取消记录。此轮 EXE 验证没有提交打包或上传。日常安装 EXE 未停止或替换；独立验收客户端用后关闭，配置和回滚包保留。客户端发布证据在 `work/windows-3.5.1-release/`。用户更新 EXE 后获得新增的即时提示；后端的已发布状态核对已直接生效。
