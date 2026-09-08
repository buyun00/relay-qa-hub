# 独立项目预览运行与回退说明

适用实例qa-hub-preview-7c86；更新日期2026-09-09。本记录汇总独立预览实现、实际客户端验收和只读生产快照。业务写入、服务启停和安装均限独立预览或隔离fixture；生产边界按证据核对。运行参数来自公开instance配置、启动器与发布回执，不含secrets内容。**Windows最新真实升级/原生恢复为.6，Bug闭环/编辑/评论/软删除证据来自.5；Android当前code21/preview.7。24基线仅09、23整项通过，物理Android和真实外部完整链路仍缺。**

## 目录、端口和身份

| 用途 | 显式配置 |
| --- | --- |
| 源码 | C:\Users\lin0\.codex\worktrees\7c86\Relay-QA-Hub |
| 实例配置 | C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\instance.json |
| runtime | C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86 |
| 业务数据 / 备份 | runtime\data / runtime\backups；独立启动配置关闭自动备份 runner |
| 日志 / 发布 / 打包工作区 | runtime\logs / runtime\downloads / runtime\packages\<releaseId> |
| EXE profile | runtime\desktop\profile；含项目身份、草稿、MCP 文件缓存、升级回执 |
| 组件 / 凭据引用 | runtime\components\projects\<projectId>\components\<key>\versions\<version> / runtime\credentials |
| 秘密文件 | instance.json 指定 runtime\secrets.json；专用启动器仅在进程内读取，不能进入命令参数、日志、文档或提交 |
| Cookie / 更新通道 | qa-hub-preview-7c86-session / qa-hub-preview-7c86 |
| Windows | %LOCALAPPDATA%\Programs\RelayQaHubPreview\RelayQaHubPreview.exe；scheme qa-hub-preview |
| Android | com.relayqahub.android.preview.debug；名称 QA Hub 项目预览；scheme qahub-preview |

以下 runtime\... 相对于表内绝对目录，不是生产目录。

| 服务 | 地址 | 已保存证据 |
| --- | --- | --- |
| API | http://127.0.0.1:4419；就绪 /api/v1/health/ready | 2026-09-08T19:37:04.0646720Z新回执PID17912；主代理报告ready，已有独立管理读回schema14；操作前仍需身份/就绪检查 |
| Web/下载 | http://127.0.0.1:4274/；/downloads/<filename> | 17:52:36Z 回执 PID 20284；GM 浏览和 WebSocket 实际通过 |
| 服务端 MCP | http://127.0.0.1:4421/mcp；就绪 /health | 16:46:02Z 转发进程回执 PID 15736；后续核心/资源烟测通过 |
| EXE 本地 MCP | http://127.0.0.1:4420/mcp | 随独立 EXE 启动；.4 资源读回 90 工具和文件/hash |

PID 是历史回执，不能手写用于停止。生产 4319、4174、日常 MCP 4320 和日常应用不在这些命令范围内。预览端口当前已分配，不能再当空闲端口。

Web 由 scripts/project-components/preview-web.mjs 服务 apps/web/dist，将 /api/ 和通知 WebSocket 转发到显式 4419；下载仅来自独立 downloadsRoot。它不运行旧生产 Vite proxy。MCP 4421 转发同一 API，保持原认证。静态页面可打开不等于 API ready 或业务成功。

## 查看状态和限定服务启停

使用现有本工作树依赖和 Node 24.19。专用启动器校验配置/sourceRoot、目录边界与真实路径，再控制回执拥有的进程；缺配置、错误来源、端口占用或 PID 身份不符时拒绝。

PowerShell 操作变量：

~~~powershell
$qaPreviewSource = 'C:\Users\lin0\.codex\worktrees\7c86\Relay-QA-Hub'
$qaPreviewConfig = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\instance.json'
$qaPreviewManager = Join-Path $qaPreviewSource 'scripts\project-components\Manage-QAHubPreview.ps1'
~~~

只读身份状态：

~~~powershell
& $qaPreviewManager -Action Status -ConfigFile $qaPreviewConfig -Services @('api', 'web', 'mcp')
~~~

Status 核对 PID、CreationDate、可执行路径和完整命令行，**不等于 HTTP ready**。实际就绪需分别读取：

~~~powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:4419/api/v1/health/ready'
Invoke-RestMethod -Uri 'http://127.0.0.1:4421/health'
~~~

要求 status:ready，并检查 database/evidence/worker；当前证据到 schema 14。上面是后续操作方法，本次文档更新没有调用。

启动时明确服务名；API 先启动，Web/MCP 依赖 API：

~~~powershell
& $qaPreviewManager -Action Start -ConfigFile $qaPreviewConfig -Services api
~~~

~~~powershell
& $qaPreviewManager -Action Start -ConfigFile $qaPreviewConfig -Services web
~~~

~~~powershell
& $qaPreviewManager -Action Start -ConfigFile $qaPreviewConfig -Services mcp
~~~

只重启 Web 时，停止与启动是两个独立操作：

~~~powershell
& $qaPreviewManager -Action Stop -ConfigFile $qaPreviewConfig -Services web
~~~

~~~powershell
& $qaPreviewManager -Action Start -ConfigFile $qaPreviewConfig -Services web
~~~

API 重启会打断浏览、Android/MCP 请求和本进程工作；先与当前验收者到达操作边界，再单独 Stop -Services api、确认结果、Start -Services api。MCP 同理。**不要省略 -Services，其默认值是三个服务。** 不按进程名批量终止，不使用上述历史 PID。脚本不管理 EXE MCP 4420，不关闭日常 EXE。

Start 不编译源码：API 使用 apps/api/dist/main.js，Web 使用 apps/web/dist。先完成相应构建和回归。仅 Web 静态 bundle 变化时，新开/刷新页面加载磁盘 dist；旧页面可能持有旧 bundle。EXE 使用安装包内 Web，独立 Web 更新不等于 EXE 升级。

最新独立Web构建index-CUjaBP8S.js包含Relay交接历史与暂停恢复入口。Web61/61、Desktop104/104、Storage109/109、最新完整API184/184（MJS151+TS33，含生命周期9项；旧175日志保留历史，分页/删除/协议17项为重叠子集）、root unit4/skeleton1以及typecheck/lint已有日志；严格旧合同冻结仍failed，另三项合同独立通过，详见[实施验证表](IMPLEMENTATION.md)。Vite dev/test需要显式QA_HUB_API_BASE_URL；本轮测试设置为4419，但outbox测试请求被限定到其随机本地fixture端口，并未调用预览4419。[Web验证范围](runs/web-outbox-verification.json)。新增生命周期9项的实际范围为成功监听后调度、绑定失败/构造失败清理、并发stop与HTTP/inflight drain；旧runtime已有onReady/onClose，不应描述为从未调度。[最新184日志](runs/api-final-lifecycle-source.txt)、[生命周期证据](component-runtime-lifecycle.md)。

已实际验证 EXE 异常退出边界：独立预览 EXE 及 4420 停止后，HTTP 核心 15 项、服务端 MCP 核心 13 项仍通过；重启预览后员工/文字/1 图片草稿恢复，日常 EXE 与生产 ready 不变。它证明这些已列子集的独立性，不是全部 API 动作或任意崩溃场景通过。[故障证据](runs/exe-fault-independent-api-mcp.json)、[恢复界面](runs/exe-preview4-after-fault-draft.txt)。

新增.6实际身份边界：原生退出后磁盘身份清除，本地MCP返回QA_HUB_LOGIN_REQUIRED；local MCP登录成功返回时身份已经落盘；原生重新登录同员工/项目后原文字+1张PNG草稿恢复。[退出读回](runs/exe-preview6-logout-readback.json)、[同步持久登录](runs/exe-preview6-login-durable-readback.json)、[原生重登草稿](runs/exe-preview6-relogin-draft.json)。登录后立即强停的组合命令被自动审批拒绝、未执行且未重试；这组证据明确processRestartNotTested，不能据此声称该强停场景通过。

新增预览.6真实双入口删除：服务端4421和已安装EXE的本地4420各创建独立Bug并调用默认删除；相同请求重放均replayed:true、删除时点相同，context返回NOT_FOUND，原Bug及删除actor/version审计保留。[双MCP删除实测](runs/mcp-delete-live-preview6.json)。仅映射对应qa_delete_bug入口，不把一个删除用例推定为全部HTTP/MCP动作对等或全量幂等通过。

最新只读生产快照为2026-09-08T19:30:39Z：六个文件hash、三个原PID/启动时点均与19:02:22Z一致，4319 ready/schema12，4174的Windows 3.3.5公开manifest原字节hash一致；日常APK code14/PID5051/安装时点保留，预览APK code21仍在。未读取配置正文或凭据，未启停任何应用，未重新验签。日期比较曾因PowerShell隐式转换丢失小数精度误报，已按原始UTC字符串100ns精度更正并保留说明。[提交前生产快照](runs/production-pre-commit.json)。

## 日志和失败处理

- 最新身份回执：runtime\logs\api-process.json、web-process.json、mcp-process.json；每次启动同时保留带 UTC launchId 的回执/stdout/stderr。
- PREVIEW_PID_IDENTITY_MISMATCH：停止控制并核对来源，不能跳过校验或改写回执接管未知进程。
- PREVIEW_PORT_OCCUPIED：定位占用归属，不能杀进程抢端口。
- PREVIEW_NOT_READY：脚本保留进程用于诊断；读取对应日志和 ready，不连续创建重叠实例。
- 证据仅摘取必要错误码、项目/任务/版本、时点和脱敏日志；保留历史日志、失败附件、草稿、队列、WAL 和版本快照。

UTC 规范化已处理早期 PowerShell 日期解析问题。曾被自动审批拒绝的组合命令未执行，后续主代理拆为状态、专用 Stop、专用 Start 后成功；不能把被拒绝那次记作启停证据。

## 项目和组件操作

Web 可带 ?projectId=<UUID或短码>；没有项目时显示输入框，不公开全项目目录。基础验收项目：

- A：fb914b3b-4169-47f8-8dec-76f3a3cc780d。
- B：383a122d-5c4b-478c-9bd7-7bb2196cf5b2。
- GM 浏览专用：fb81f6b5-43ed-4e8f-b848-502c0dcf9848；短码 GB1788890272232，小写登录已实际通过。

普通员工以项目/姓名登录，切换器只列有效所属项目。五组件默认关闭，基础 Bug 人工生命周期和本地组件历史仍可用。GM 从管理入口使用独立口令，配置写入携带当前 expectedVersion。凭据只写引用名，模板见 [component-runtime.md](component-runtime.md)，.invalid 地址不是可执行资源。

组件“可用”只表示字段满足合同。关闭后排队任务保持 paused，再开启不自动重放，须显式恢复对应任务。任务固定原项目/版本/配置，不能把旧任务改发新目标。组件启用不解除离线导入 hold。

Web“组件历史”现在分别显示Bug交接和批次历史。交接条目显示项目、Bug、handoff、配置版本、尝试次数和暂停原因；启用组件后选择“恢复此交接”，核对确认面板的具体scope再恢复。组件关闭时按钮禁用；IMPORT_EXECUTION_HELD拒绝时记录继续保留，解除冻结后刷新。批次恢复仍是原有入口，受原提交者约束。当前已通过临时SQLite/API的关闭/冻结/明确恢复/重复恢复验证；尚未以浏览器点击有数据的暂停交接，不把fixture渲染写成原生验收。

## 安装包和版本

Windows 独立清单：

http://127.0.0.1:4274/downloads/qa-hub-preview-7c86-windows-latest.json

已验证升级/恢复的固定.6包（latest清单可能随后续发布变化，应先核对版本）：

http://127.0.0.1:4274/downloads/qa-hub-preview-7c86-windows-0.2.0-preview.6-20260908T185123338Z.exe

回执为runtime\packages\20260908T185123338Z\receipt.json；108,378,454 bytes、SHA-256 989b9c9c7ddd51310c5d2a5dc94b5875643d50c769e42a1f84d2d4cb7bc281f1。清单带独立签名；本次只核对记录，未重新下载或验签。清单签名不等于Windows Authenticode证明。旧.5包108408228字节/hash1dadf0c65ae86680c9fe7646bb86cc13346ef1d26bd26c5076110f56297422f5继续留存。

安装目标固定%LOCALAPPDATA%\Programs\RelayQaHubPreview，校验实例marker与重解析点。旧安装保留.backup-<releaseId>，原preview-instance配置复制保留。实际.5升级恢复姓名/项目/文字+1图草稿且日常EXE未关闭，见[升级回执](runs/exe-after-preview5-upgrade.json)；.5原生闭环、编辑/评论和独立测试Bug软删除见[闭环](runs/exe-ui-bug-closed-readback.json)、[编辑评论](runs/exe-ui-edit-comment-readback.json)、[删除审计](runs/exe-ui-delete-retained-storage.json)。.5回执sourceDirty:true；后续源码和独立Web修改不一定已入.5包。

.6实际升级已在18:58:33Z完成原生核对：installed、同一配置hash/人员/项目、文字+1图草稿恢复；五个backup保留，.5旧update-result以retained-update-result-UUID.json保存且hash相同。[.6升级proof](runs/exe-after-preview6-upgrade.json)、[原生恢复](runs/exe-preview6-restored-draft.txt)。此次旧helper仍将本地时间误标Z，以observedAt为UTC时序依据；.6新helper的UTC后来另以故意失败用例验证，未调用installer。手工回退、重复升级及卸载同包重装已新增proof，见下节；操作前继续核对边界并保存新增数据。

Android当前文件为apps/android/app/build/outputs/apk/debug/app-debug.apk：com.relayqahub.android.preview.debug，0.2.0-preview.7，code21，35,471,401 bytes，SHA-256 D783E9908E7DACDD660565CF15E1624C567A820E973D01190A38A0981AFE7255。它是构建目录中的调试预览APK，不声称已进入签名更新源或完成应用内升级。code21的80测试/build/lint已过，20→21实际保留文字/未提交PNG/sidecar的三hash及日常code14/PID5051；三个原生Relay tab已达，列表为空。[Android记录](android-implementation.md)。

已执行方式是AAPT核对准确package/code后，对MuMu127.0.0.1:16384使用预览包adb install -r，仅增加tcp:4419 reverse。这不是物理设备或日常APK升级。code19与code20旧APK分别留存在apps/android/app/build/evidence/project-components/qa-hub-preview-code19.apk及qa-hub-preview-code20-retained.apk。最终包、原生UI与后续发布由主代理负责，本文不触发安装。

## 证据保留

索引：[IMPLEMENTATION.md](IMPLEMENTATION.md)、[矩阵](coverage-matrix.md)、[生产盘点](production-inventory.md)、[GM](gm-authorization.md)、[Web](web-browser/results.md)、[双标签](web-browser/dual-window-results.md)、[GM UI](web-browser/gm-results.md)、[组件](backend-components.md)、[Android](android-implementation.md)、[迁移](migration-rehearsal.md)。

Git 忽略目录也须保留：

- runtime\logs 的逐次启动日志和回执。
- runtime\packages\<releaseId> 发布回执/包、runtime\downloads 各版本安装包。
- runtime\desktop\profile、升级回执及 .backup-* 旧安装。可能含登录相关数据，限制归档访问，不全文进入报告。
- apps/android/app/build/evidence/project-components 的截图、UI XML、脱敏读回和保留 APK；build 目录不是 Git 持久证据。
- runtime\migration-rehearsal-81deb464 的固定归档、校验报告、migrated/rollback 副本和 hold。

矩阵重生保留结果、人工备注和retiredItems，源码变化标记复验。当前985细目不是985项通过；24基线只有09和23整项通过，22保留物理Android必测缺口，15只将已实际调用的三种读取入口标通过。源目录重复MCP注册行不重复计数。[映射规则与progress](coverage-mapping-review.md)。真实外部Jenkins、上传、Relay、轻语以及物理Android仍缺资源。

## 回退和恢复

**服务**：核对预览身份，停止必要预览服务，保留当前 dist/数据/日志/配置；恢复已核对的预览构建后再启动并验证 ready 和业务。无发布回执的源码不能视为已验证回退版本。不能把 schema 12 程序直接指向 schema 14 工作库。

**Windows**：.6升级读回已保留RelayQaHubPreview.backup-20260908T172125402Z、...174125783Z、...175032165Z、...182326239Z、...185123338Z。NSIS源码在文件复制失败时保留failed目录并恢复旧安装，但这不是故障注入已测证明。手工恢复前核对备份release.json、实例marker、配置和精确目标路径，在预览EXE安全退出后通过受控流程恢复；保留失败版本和profile。不卸载日常EXE，不清空profile。成功.4/.5/.6升级和草稿恢复已有证据，.6→.5手工回退见下段；其余回退范围不自动通过。

19:01:28Z已有一次真实预览.6→.5手工回退：源backup保持原样，.6整个安装另存%LOCALAPPDATA%\Programs\RelayQaHubPreview.rollback-retained-20260908T1901Z；恢复.5后同员工/项目/文字+PNG草稿以及closed/v14、原评论/附件hash读回。生产六文件hash、三个原进程与ready/schema12不变。[回退proof](runs/exe-preview6-to5-rollback.json)、[保留读回](runs/exe-rollback5-business-readback.json)、[生产边界](runs/production-after-preview6-rollback.json)。

之后实际重复升级.6成功：同release的原backup继续保留，新backup追加-1后缀。卸载.6将安装目录保留为RelayQaHubPreview.uninstalled-20260908T185123338Z，profile全部102文件/663514299字节在卸载前后逐一hash一致；精确同一.6包重装后原生恢复同员工/项目/配置/文字+1图，原closed/v14、评论/附件hash读回。[重复安装](runs/exe-preview6-repeat-upgrade.json)、[卸载保留](runs/exe-preview6-uninstall-readback.json)、[同包重装](runs/exe-preview6-after-uninstall-reinstall.json)。最新已恢复安装版为.6。这里只完成EXE客户端回退/恢复范围，24的服务数据/APK部分仍not_run，不能整项passed。

后续首装guard修正在源中完成，原始.onInit经隔离native NSIS编译的6项检查通过，涵盖不存在Programs目录、合法/错误marker、Programs/install junction和越界INSTDIR；所有目录位于runtime fixture根，未执行真实用户Programs/注册表/安装卸载主体。这不是干净Windows用户完整首装通过。[guard范围](runs/native-installer-guards.json)。.7计划纳入该修正，当前未声称已发布或原生安装。.6helper的UTC序列化已用无AppPath的故意失败配置实际验证，installerInvoked:false，不计另一次升级成功。[时间证据](runs/native-updater-utc.json)。

**Android**：code19/code20和旧证据保留，不声称执行降级。先保留预览数据库、草稿和截图，在专门可恢复测试安装中验证兼容性；不以卸载、清数据或覆盖日常包作为恢复步骤。

**数据**：已完成的是离线恢复集演练。固定输入 runtime\migration-rehearsal-81deb464\source\rpo；migrated 是 schema 14，rollback 是独立 schema 12 副本。两者仍 paused，未启动 API/worker/连接器。878 附件和 58 原业务表指纹一致，回退库哈希等于固定 schema 12 源。迁移前备份/原归档/报告保留；滚动原归档后来到期，不再以活动生产库替代。[实际结果](migration-rehearsal.md)。

offline-import.mjs 要求显式 archive、expected-sha256、allowed-root、data-root 和 mode，使用官方恢复/校验。恢复到新的独立目录并核对报告，不能覆盖当前库。独立上传队列/workspace、Relay 批次和轻语状态不在该主库附件归档内，不能宣称一并回退成功。

导入 .qa-hub-import-hold.json 在资源/队列复核和明确释放记录前保持 paused；损坏或不完整 released 声明仍被拒绝。组件启用不解除 hold。本文没有释放 hold、启动副本或重放外部任务。
