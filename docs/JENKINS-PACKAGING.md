# OZDQP 打包与下载

Web 和 Windows 1.2.9 共用“打包与下载”分页。打包区仅有三个按钮，无账号、版本号、服务器或高级参数设置。

只有排队、等待确认或正在执行的任务才展开构建进度。任务结束后自动收起为一行“历史构建与阶段耗时”入口，点击可查看历史；尚无历史时不显示空白进度区。完成通知、下载刷新和任务跟踪继续正常执行。

总进度和阶段进度使用圆角渐变条：运行中为青蓝紫流动条纹，超时为橙色。无可靠阶段耗时样本时显示循环流动条，不提供虚构的百分比；终态自动收起，系统开启减少动态效果时停止动画。提交提示使用独立的正向间距，窄窗口顶栏收起辅助文案以容纳刷新按钮。

固定任务：`http://10.100.5.129:8080/job/01-【OZDQP】【Android】/`。
API 进程使用用户指定的内网固定账户自动认证；前端、二维码和下载服务器均不接收 Jenkins 凭据。

| 按钮 | networkScope | internalUseSdk | buildMode |
| --- | --- | --- | --- |
| 打不带 SDK 的内网包 | 内网_自动判断 | 不接入SDK | Auto_自动判断 |
| 打带 SDK 的内网包 | 内网_自动判断 | 接入SDK | Auto_自动判断 |
| 打外网包 | 外网_保留原参数 | 不接入SDK | App_资源和包体 |

外网行中的 `internalUseSdk` 是页面保持不变的内网参数；外网 SDK 来自现有 `BuildParam` 默认值。`buildMode` 的外网切换与 Jenkins 页面 ParameterUX 的联动一致。其他参数不随请求发送，由 Jenkins 使用当前默认值，包括空版本号及 JSON Editor 的 `BuildParam.startval`。2026-09-04 实际页面外网默认为法兰克福正式服、生成 APK 与 ZIP。

内网保持自动判断，可能只生成资源，因此成功构建不一定产生新 APK。下载列表单独读取实际文件，按文件更新时间排序，三类快捷入口通过 `_intra_nosdk.apk`、`_intra_sdk.apk`、`_extra_sdk.apk` 区分，不能把最近一次成功构建当作新 APK。

下载来源：

- APK：`http://10.100.5.129:8000/apk/?json=true`。
- IPA：`http://10.100.5.129:8000/ipa/?json=true`，提供对应目录和最新 IPA 链接。
- 增量 ZIP：`http://10.100.5.129:8000/pkg_zip/ozdqp/_pkg_cfg_2001_1002.zip`，通过 HEAD 读取大小和更新时间。
- 二维码在客户端生成，指向同一个真实下载文件。手机需要能访问内网。
- Windows 通过默认浏览器下载，限制为该固定服务器的 APK、IPA 与指定 ZIP，不经过有响应大小限制的桌面 API 代理。

API：登录后 GET `/api/v1/packaging`，POST `/api/v1/packaging/builds`（仅 `{preset}`，必须携带 `Idempotency-Key`）。沿用 QA Hub 会话与 CSRF 校验。只在收到 Jenkins 201 和合法队列编号后显示已提交。401/403 刷新 crumb 与会话后重试一次；超时或不明确响应不重发打包请求。相同请求键在 API 进程内保留 24 小时，包括结果不明确的请求；服务重启后该内存记录不保留，因此客户端不会自动重试结果不明确的提交。

下载区每 10 秒更新。构建进度独立每 5 秒读取；切换分页或最小化 EXE 后，已跟踪的任务仍会持续检查。队列编号与构建编号保存在当前 QA 用户的本地存储中，重新打开后继续跟踪，记录最多保留 7 天 / 10 个任务。已完成构建和每阶段警报均记录通知回执，避免重复弹窗。完全退出应用期间不推送，重新打开后补查。

Windows 1.2.6 更新器重启时保留当前用户配置目录，确保自定义配置目录下的登录、草稿和构建跟踪记录继续使用；失败回退也保留同一目录。旧版更新交接未提供该字段时沿用默认启动行为。

## 构建进度与警报

登录后 GET `/api/v1/packaging/progress?queues=735&builds=10140`。每类最多 10 个编号。先用准确的 `queueId` 匹配构建；队列转为执行时读取其 `executable.number`；已知构建离开最近列表后仍按编号读取。队列取消与状态暂时不可确认分别显示，连接失败不会重新提交构建。

后端读取最近 24 个构建的总耗时、触发人和阶段标记；日志只返回白名单中的工作内容和计时，不转发原始控制台文本。日志读取最多并发 3 个、单份上限 2 MiB、整次进度读取 18 秒截止，历史缓存有数量上限。阶段包括准备环境、Unity 导出、APK 编译、CDN 发布、ZIP 和完成校验；实际仅资源流程跳过 APK，未开启 ZIP 的构建跳过 ZIP。

2026-09-04 历史检查：#10139 外网整包总计 14 分 2 秒、Gradle 编译 5 分 4 秒；#10138 内网 SDK 整包总计 13 分 21 秒、Gradle 5 分 1 秒；#10135 内网无 SDK 仅资源总计 5 分 40 秒。旧构建没有启用时间戳，因此只能确认总耗时、阶段顺序和日志中单独报告的 Gradle 编译耗时，不能还原每个阶段的完整耗时。

已为此 Jenkins Freestyle job 加入已安装的 Timestamper build wrapper，后续构建通过官方 `/timestamps/?elapsed=HH:mm:ss.SSS&appendLog` 读取时间。原始配置备份于部署主机 `work/jenkins-config-before-progress.xml`，构建脚本和参数未改动。配置保存时 Jenkins 会规范化 XML 序列化格式。参考 [Timestamper 官方 API 文档](https://plugins.jenkins.io/timestamper/#plugin-content-scripting)。

计时规则：有时间戳的阶段按开始与下一阶段边界计时；运行中的旧日志仅展示首次观测后的耗时下限（≥），不作为历史样本；缺少记录显示“未记录”。工作内容来自实际脚本标记；触发人取 Jenkins cause，执行者显示 Jenkins 节点，不虚构人工负责人。

阶段预期采用同环境、SDK、实际 App/Res/Script 方式及 ZIP 流程的成功构建中位数。满 3 个完整阶段样本后，警戒线取 `max(2 × 中位数, 中位数 + 60 秒, P90 + 30 秒)`；样本不足时，准备 / Unity / APK / CDN / ZIP / 校验分别采用 5 / 30 / 15 / 10 / 10 / 3 分钟初始警戒线。运行中阶段超线时显示警报并弹窗，不中止任务。无日志时不新增阶段警报。总进度按完成阶段与阶段耗时估算，未成功时不显示 100%；无可靠阶段样本时阶段条显示不定进度，等待 Jenkins 实际阶段信号。

构建成功、失败或取消均有明确通知。网页弹窗不依赖浏览器通知权限，Windows 同时使用系统通知；点击通知返回打包页。完成后立即及 6 秒后重读真实下载目录；仅资源任务明确提示不生成新 APK。Jenkins 故障不影响已有文件下载；提交状态局限于打包区，切换工作台不被锁定。

验证：API 模拟 Jenkins 检查参数、认证重连、重复请求、队列转构建、阶段边界、历史分组、超时判定与日志缺失；Web 检查三按钮、下载、通知去重、失败/取消及持久跟踪；桌面检查下载 URL 白名单及通知 IPC 输入。浏览器独立预览验证排队、阶段进度、切页后警报、断线恢复、完成弹窗与下载刷新。所有测试打包 POST 均由本地测试服务接收，未额外启动真实 Jenkins 构建。

JSON Editor 默认参数行为参考该插件 [JsonEditorParameterDefinition 源码](https://github.com/jenkinsci/json-editor-parameter-plugin/blob/71962f37a416/src/main/java/io/jenkins/plugins/json_editor_parameter/JsonEditorParameterDefinition.java)。
