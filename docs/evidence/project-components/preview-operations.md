# 独立项目预览运行与回退说明

适用实例qa-hub-preview-7c86；更新日期2026-09-09。本记录汇总独立预览实现、实际客户端验收和只读生产快照。业务写入、服务启停和安装均限独立预览或隔离fixture；生产边界按证据核对。运行参数来自公开instance配置、启动器与发布回执，不含secrets内容。**Windows最新发包和真实升级/原生恢复为.7（native0.2.0.7、PID11368），Bug闭环/编辑/评论/软删除证据来自.5；Android当前code22/preview.8。24基线仅09、15、23、24整项通过，物理Android和真实外部完整链路仍缺。**

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
| API | http://127.0.0.1:4419；就绪 /api/v1/health/ready | 2026-09-08T20:39:13.7225210Z启动PID18644；最终dist已加载，实际HTTP读回ready/schema14；操作前仍核对身份 |
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

最新独立Web构建index-CUjaBP8S.js包含Relay交接历史与暂停恢复入口。Web61/61、Desktop104/104、Storage109/109、最新完整API238/238（MJS205+TS33；旧184/175及分页/删除/协议17项保留为重叠历史子集），另有最新相关Web19/19、root unit4/skeleton1以及typecheck/lint已有日志；严格旧合同历史失败已修复，最新五步全部通过，详见[实施验证表](IMPLEMENTATION.md)。Vite dev/test需要显式QA_HUB_API_BASE_URL；本轮测试设置为4419，但outbox测试请求被限定到其随机本地fixture端口，并未调用预览4419。[Web验证范围](runs/web-outbox-verification.json)。新增生命周期9项的实际范围为成功监听后调度、绑定失败/构造失败清理、并发stop与HTTP/inflight drain；旧runtime已有onReady/onClose，不应描述为从未调度。[历史184日志](runs/api-final-lifecycle-source.txt)、[生命周期证据](component-runtime-lifecycle.md)。

已实际验证 EXE 异常退出边界：独立预览 EXE 及 4420 停止后，HTTP 核心 15 项、服务端 MCP 核心 13 项仍通过；重启预览后员工/文字/1 图片草稿恢复，日常 EXE 与生产 ready 不变。它证明这些已列子集的独立性，不是全部 API 动作或任意崩溃场景通过。[故障证据](runs/exe-fault-independent-api-mcp.json)、[恢复界面](runs/exe-preview4-after-fault-draft.txt)。

新增.6实际身份边界：原生退出后磁盘身份清除，本地MCP返回QA_HUB_LOGIN_REQUIRED；local MCP登录成功返回时身份已经落盘；原生重新登录同员工/项目后原文字+1张PNG草稿恢复。[退出读回](runs/exe-preview6-logout-readback.json)、[同步持久登录](runs/exe-preview6-login-durable-readback.json)、[原生重登草稿](runs/exe-preview6-relogin-draft.json)。登录后立即强停的组合命令被自动审批拒绝、未执行且未重试；这组证据明确processRestartNotTested，不能据此声称该强停场景通过。

新增预览.6真实双入口删除：服务端4421和已安装EXE的本地4420各创建独立Bug并调用默认删除；相同请求重放均replayed:true、删除时点相同，context返回NOT_FOUND，原Bug及删除actor/version审计保留。[双MCP删除实测](runs/mcp-delete-live-preview6.json)。仅映射对应qa_delete_bug入口，不把一个删除用例推定为全部HTTP/MCP动作对等或全量幂等通过。

此前提交前只读生产快照为2026-09-08T19:30:39Z：六个文件hash、三个原PID/启动时点均与19:02:22Z一致，4319 ready/schema12，4174的Windows 3.3.5公开manifest原字节hash一致；日常APK code14/PID5051/安装时点保留，预览APK code21仍在。未读取配置正文或凭据，未启停任何应用，未重新验签。日期比较曾因PowerShell隐式转换丢失小数精度误报，已按原始UTC字符串100ns精度更正并保留说明。[提交前生产快照](runs/production-pre-commit.json)。

此前.7升级后生产只读核对为2026-09-08T19:55:31.6095789Z：六文件hash、三个原PID及精确启动时点不变，4319 ready/schema12，4174 Windows3.3.5 manifest原字节SHA不变。日常EXE可读路径相同；两个Node的路径仍为null，不能视为新增可执行路径验证。本轮未重新查询Android，APK状态仍引用19:30快照；未读配置正文/凭据或修改生产。[.7后生产快照](runs/production-after-preview7.json)。

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

**Windows 0.2.0-preview.7 已完成独立发布和实际6→7原生升级验收。** releaseId为20260908T194425490Z，108378668字节，SHA-256 fbf0656285474e2b4d521178cb9107dd26d3426dd463b9198fc21b239e02152a。公开回执sourceCommit为3b1371cbbaee4ab31f5861fe3cd72d6ff93c4789、sourceDirty:false；文档更新只读核对receipt及主代理实际原生升级proof；未额外操作安装或验签。回执位置：C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\packages\20260908T194425490Z\receipt.json。此包已含首装guard及提交内源码，升级passed依据下述实际proof。

.6→.7已通过原生“检查更新→安装并重启”实际完成，proof观测时点2026-09-08T19:54:02.443Z；当前已安装nativeVersion0.2.0.7、主PID11368。原员工/项目A、文字+1张PNG草稿和配置SHA保持，原Bug13 closed/v14、评论及184872字节原附件materialize/hash读回通过；旧更新结果及7份backup目录保留。新helper的成功result时间19:52:36Z位于真实原生点击区间，UTC已在本次成功更新中核对。[.7升级proof](runs/exe-after-preview7-upgrade.json)、[原生恢复](runs/exe-preview7-restored-draft.txt)。19:54:30Z本地4420与服务4421实际目录均为相同90工具、协议2025-06-18，不支持的协议头均400；此项只证明目录/协议，不能称90个业务工具全部通过。[双入口协议](runs/exe-preview7-live-protocol.json)。

.7新增原生窗口子集验收（2026-09-08T19:56:56.606Z）：打开草稿时点击窗口关闭按钮后无可见窗口，本地MCP仍能读取原closed Bug；第二次启动精确已安装预览EXE后，原主进程PID11368及启动时点19:52:36.0963040Z不变，恢复窗口2165104中的同员工、原文字+1张PNG草稿。恢复通过第二次EXE启动并激活已观察的主窗口完成；短暂无标题窗口曾无法激活，后续选择标题主窗口成功。**这里只证明关闭到后台和单实例第二次启动恢复，不包含Windows系统托盘图标点击、进程重启或强停。** [窄范围proof](runs/exe-preview7-close-restore.json)、[原生恢复界面](runs/exe-preview7-tray-restored.txt)。

新发.7固定包：

http://127.0.0.1:4274/downloads/qa-hub-preview-7c86-windows-0.2.0-preview.7-20260908T194425490Z.exe

已验证升级/恢复的旧固定.6包（latest清单已更新为.7，不能当作固定回退引用）：

http://127.0.0.1:4274/downloads/qa-hub-preview-7c86-windows-0.2.0-preview.6-20260908T185123338Z.exe

回执为runtime\packages\20260908T185123338Z\receipt.json；108,378,454 bytes、SHA-256 989b9c9c7ddd51310c5d2a5dc94b5875643d50c769e42a1f84d2d4cb7bc281f1。清单带独立签名；本次只核对记录，未重新下载或验签。清单签名不等于Windows Authenticode证明。旧.5包108408228字节/hash1dadf0c65ae86680c9fe7646bb86cc13346ef1d26bd26c5076110f56297422f5继续留存。

安装目标固定%LOCALAPPDATA%\Programs\RelayQaHubPreview，校验实例marker与重解析点。旧安装保留.backup-<releaseId>，原preview-instance配置复制保留。实际.5升级恢复姓名/项目/文字+1图草稿且日常EXE未关闭，见[升级回执](runs/exe-after-preview5-upgrade.json)；.5原生闭环、编辑/评论和独立测试Bug软删除见[闭环](runs/exe-ui-bug-closed-readback.json)、[编辑评论](runs/exe-ui-edit-comment-readback.json)、[删除审计](runs/exe-ui-delete-retained-storage.json)。.5回执sourceDirty:true；后续源码和独立Web修改不一定已入.5包。

.6实际升级已在18:58:33Z完成原生核对：installed、同一配置hash/人员/项目、文字+1图草稿恢复；五个backup保留，.5旧update-result以retained-update-result-UUID.json保存且hash相同。[.6升级proof](runs/exe-after-preview6-upgrade.json)、[原生恢复](runs/exe-preview6-restored-draft.txt)。此次旧helper仍将本地时间误标Z，以observedAt为UTC时序依据；.6新helper的UTC后来另以故意失败用例验证，未调用installer。手工回退、重复升级及卸载同包重装已新增proof，见下节；操作前继续核对边界并保存新增数据。

此前code21构建文件为apps/android/app/build/outputs/apk/debug/app-debug.apk：com.relayqahub.android.preview.debug，0.2.0-preview.7，code21，35,471,401 bytes，SHA-256 D783E9908E7DACDD660565CF15E1624C567A820E973D01190A38A0981AFE7255。它是构建目录中的调试预览APK，不声称已进入签名更新源或完成应用内升级。code21的80测试/build/lint已过，20→21实际保留文字/未提交PNG/sidecar的三hash及日常code14/PID5051；三个原生Relay tab已达，列表为空。[Android记录](android-implementation.md)。

已执行方式是AAPT核对准确package/code后，对MuMu127.0.0.1:16384使用预览包adb install -r，仅增加tcp:4419 reverse。这不是物理设备或日常APK升级。code19与code20旧APK分别留存在apps/android/app/build/evidence/project-components/qa-hub-preview-code19.apk及qa-hub-preview-code20-retained.apk。最终包、原生UI与后续发布由主代理负责，本文不触发安装。

## 证据保留

索引：[IMPLEMENTATION.md](IMPLEMENTATION.md)、[矩阵](coverage-matrix.md)、[生产盘点](production-inventory.md)、[GM](gm-authorization.md)、[Web](web-browser/results.md)、[双标签](web-browser/dual-window-results.md)、[GM UI](web-browser/gm-results.md)、[组件](backend-components.md)、[Android](android-implementation.md)、[离线迁移](migration-rehearsal.md)、[held副本API读回](migration-service-readback.md)。

Git 忽略目录也须保留：

- runtime\logs 的逐次启动日志和回执。
- runtime\packages\<releaseId> 发布回执/包、runtime\downloads 各版本安装包。
- runtime\desktop\profile、升级回执及 .backup-* 旧安装。可能含登录相关数据，限制归档访问，不全文进入报告。
- apps/android/app/build/evidence/project-components 的截图、UI XML、脱敏读回和保留 APK；build 目录不是 Git 持久证据。
- runtime\migration-rehearsal-81deb464 的固定归档、校验报告、migrated/rollback 副本和 hold。

矩阵重生保留结果、人工备注和retiredItems，源码变化标记复验。当前985细目不是985项通过；24基线只有09、15、23、24整项通过，22保留物理Android必测缺口，15仅按设计列出的三种实际读取入口判定整项通过，APK/EXE/Web其它控件和17.3物理设备要求不受影响。源目录重复MCP注册行不重复计数。[映射规则与progress](coverage-mapping-review.md)。真实外部Jenkins、上传、Relay、轻语以及物理Android仍缺资源。

基线15已按设计原文重新核对三种读取并校准适用入口，没有增加not_applicable状态。当前09、15、23、24整项通过，其余功能仍按实际入口分别验收。21的缺口是主库归档以外的旧上传queue.sqlite/owner/workspace/job、Relay批次/state及轻语状态的未完成任务完整清单和迁移核对；schema12程序启动与新增数据回退不再作为21条件。主库及878附件已固定并通过迁移/held服务26项读回，historical-copy资源状态为partially_verified。

.7仅两个实际按钮新增EXE passed：关闭窗口、状态面板检查更新/安装并重启。window-action(close)、check-update成功、install-update成功、second-instance无深链恢复记为分支passed，复合handler仍not_run；托盘图标点击仍未测。生成/映射脚本本轮仅为持久重放这些证据作有界修改，不改应用源码；保留401个既有复验标记，proof SHA不一致时拒绝且不写矩阵。[映射审查](coverage-mapping-review.md)、[实际重放验证](runs/coverage-criteria-replay.json)。

严格合同的历史失败已在提交09f7150fc1c671d867bbdbc257cab0e61c78d20f修复：五步test:contract全部通过，原1.0/1.1 baseline与checker未重写。六条已注册POST使用冻结响应投影，丰富事实仍可从原三条GET读取。完整API238/238（205mjs+33ts）、Storage109/109、相关Web19/19通过；其中52条响应fixture覆盖八种Accept，不能当作运行实例E2E。[实现与边界](contracts-remediation-implementation.md)、[严格五步](runs/contracts-remediation-strict.txt)、[最终API](runs/contracts-remediation-api-final.txt)。旧1.0 result请求、blocked写入和未注册fail/supersede POST及/bugs/:bugId/workflow GET仍缺，不能据静态门禁宣称完整运行合同。

## 回退和恢复

**服务**：核对预览身份，停止必要预览服务，保留当前 dist/数据/日志/配置；恢复已核对的预览构建后再启动并验证 ready 和业务。无发布回执的源码不能视为已验证回退版本。不能把 schema 12 程序直接指向 schema 14 工作库。

**Windows**：.6升级读回已保留RelayQaHubPreview.backup-20260908T172125402Z、...174125783Z、...175032165Z、...182326239Z、...185123338Z。NSIS源码在文件复制失败时保留failed目录并恢复旧安装，但这不是故障注入已测证明。手工恢复前核对备份release.json、实例marker、配置和精确目标路径，在预览EXE安全退出后通过受控流程恢复；保留失败版本和profile。不卸载日常EXE，不清空profile。成功.4/.5/.6升级和草稿恢复已有证据，.6→.5手工回退见下段；其余回退范围不自动通过。

19:01:28Z已有一次真实预览.6→.5手工回退：源backup保持原样，.6整个安装另存%LOCALAPPDATA%\Programs\RelayQaHubPreview.rollback-retained-20260908T1901Z；恢复.5后同员工/项目/文字+PNG草稿以及closed/v14、原评论/附件hash读回。生产六文件hash、三个原进程与ready/schema12不变。[回退proof](runs/exe-preview6-to5-rollback.json)、[保留读回](runs/exe-rollback5-business-readback.json)、[生产边界](runs/production-after-preview6-rollback.json)。

之后实际重复升级.6成功：同release的原backup继续保留，新backup追加-1后缀。卸载.6将安装目录保留为RelayQaHubPreview.uninstalled-20260908T185123338Z，profile全部102文件/663514299字节在卸载前后逐一hash一致；精确同一.6包重装后原生恢复同员工/项目/配置/文字+1图，原closed/v14、评论/附件hash读回。[重复安装](runs/exe-preview6-repeat-upgrade.json)、[卸载保留](runs/exe-preview6-uninstall-readback.json)、[同包重装](runs/exe-preview6-after-uninstall-reinstall.json)。最新已安装并有成功原生恢复proof的版本为.7；上面回退/卸载重装仍按实际发生的.6版本记录。这里仅完成当时EXE客户端回退/恢复范围；基线24随后已有独立47项服务/HTTP证据，APK及其它客户端功能不因此通过。

后续首装guard修正在源中完成，原始.onInit经隔离native NSIS编译的6项检查通过，涵盖不存在Programs目录、合法/错误marker、Programs/install junction和越界INSTDIR；所有目录位于runtime fixture根，未执行真实用户Programs/注册表/安装卸载主体。这不是干净Windows用户完整首装通过。[guard范围](runs/native-installer-guards.json)。.7已从实施提交3b1371c打包纳入该修正，sourceDirty:false；实际6→7原生升级及同身份/草稿/配置/历史保留已通过；干净Windows用户完整首装仍未测。.6helper的UTC序列化已用无AppPath的故意失败配置实际验证，installerInvoked:false，不计另一次升级成功。[时间证据](runs/native-updater-utc.json)。

**Android**：code19/code20和旧证据保留，不声称执行降级。先保留预览数据库、草稿和截图，在专门可恢复测试安装中验证兼容性；不以卸载、清数据或覆盖日常包作为恢复步骤。

**数据**：离线恢复集演练及新第三副本的held API读回分别保留。固定输入 runtime\migration-rehearsal-81deb464\source\rpo；migrated 是 schema 14，rollback 是独立 schema 12 副本。原两者仍paused且未启动API/worker/连接器；后续服务只在新service-readback-8b94d602副本启动并已正常退出。878 附件和 58 原业务表指纹一致，回退库哈希等于固定 schema 12 源。迁移前备份/原归档/报告保留；滚动原归档后来到期，不再以活动生产库替代。[实际结果](migration-rehearsal.md)。

新增保持冻结状态的迁移副本的真实API服务读回26项通过：固定schema12归档在新的service-readback-8b94d602中恢复并迁移至14，127.0.0.1:51708仅启动该副本API；稳定旧姓名ID登录后读出100 Bug、真实2评论及1附件（3487861字节、SHA-256 73470971577ea3ceb30edf4e8cb713d449a3b6e66c566cac5e897e136566e2ce），匿名401、跨项目404、外部读取hold409均实测。五组件关闭、出站和执行器子进程尝试均0；hold字节和核心业务/outbox指纹保持，原身份记录全部保留。新增的仅是官方独立GM和会话记录；不能称整个数据库字节无变化。进程8532正常exit0且监听关闭，旧migrated/rollback未启动且hash不变。[26项读回](migration-service-readback.md)、[脱敏JSON](migration-service-readback.json)。

该服务使用19:24:26Z冻结的独立编译样本，其已有onReady/onClose并由paused gate阻止调度；它不代替后续监听生命周期9项测试。此结果证明held schema14 API恢复读取，**未证明schema12程序启动、迁移后新增数据的完整回退、生产切换、客户端迁移或独立组件队列/workspace恢复**。归档2021条outbox原本全sent，也不单独证明pending任务冻结。前两次错误测试路由导致的harness失败已保留，不计成功。

offline-import.mjs 要求显式 archive、expected-sha256、allowed-root、data-root 和 mode，使用官方恢复/校验。恢复到新的独立目录并核对报告，不能覆盖当前库。独立上传队列/workspace、Relay 批次和轻语状态不在该主库附件归档内，不能宣称一并回退成功。

导入 .qa-hub-import-hold.json 在资源/队列复核和明确释放记录前保持 paused；损坏或不完整 released 声明仍被拒绝。组件启用不解除 hold。本记录所列新副本API已完成hold保持的读取并正常退出；没有释放hold或重放外部任务。

## 服务回退47项与基线24校准

新增三阶段真实服务回退演练47/47通过，记录59条HTTP状态/大小/hash。modern3b1371c/schema14新增两Bug、评论、68字节PNG及两人工RepairAttempt/两Verification（含in_progress未完成任务）；正常停止后910文件/753461759字节整根保留，old62b4495/schema12实际读取独立旧归档，随后M14以原session恢复新增ID、版本、操作者、状态和hash。三进程正常exit0，端口关闭，retained全文件hash仍一致。[47项服务回退](baseline24-service-rollback.md)、[JSON](baseline24-service-rollback.json)。外层写入为HTTP /api/v1/mcp/call，标准domain GET读回；本次没有独立JSON-RPC或客户端UI操作。protectedBefore/After只核对固定archive/migrated/rollback，不是新一轮生产六文件快照。

基线24按设计13/24“能按文档恢复服务并保留回退前新增数据和任务证据”和10.3的隔离回退边界校准：服务/HTTP是必要入口，旧程序不需要读取或合并新版数据。先前要求六入口各自降级、或让APK回退阻止该服务基线通过，属于过度约束，现已纠正。既有EXE客户端恢复证据单独保留；APK/Web/MCP及其它功能控件保持各自实测状态。24整项通过不补齐18/19外部组件、21旧queue/workspace完整清单、22及17.3物理设备缺口，整个任务仍未完成。

本轮按最终冻结源码重新盘点：188个源码文件、985细目，保留既有人工结果、负向备注与needsRevalidation；09、15、23、24整项通过，其余基线和独立功能仍按实际缺口验收。

## 最终API、Android与生产读回

最终dist已在独立API PID18644加载，启动时点2026-09-08T20:39:13.7225210Z，4419 ready/schema14。root实际31个HTTP调用通过：六条冻结POST的vendor/JSON输出、同幂等请求切换媒体重放、丰富历史读取及跨项目404；另核对14个媒体头与原EXE Bug closed/v14、评论及184872字节附件hash。[31次实际请求](runs/frozen-workflow-live-2026-09-08T20-40-57-088Z.json)、[媒体/旧业务读回](runs/frozen-workflow-live-readback.json)。请求均使用1.1；没有以此补齐旧1.0请求、未注册路由或全部HTTP/MCP对等。

Android最新实际安装为com.relayqahub.android.preview.debug，code22 / 0.2.0-preview.8，MuMu中21→22覆盖升级与原生开始→无需代码提交→验收通过关闭完成。Bug386cdd2f-44c9-4a79-992a-891d595766fd closed/v6；49条对应HTTP均2xx，deliver1次、complete0次，87单测通过，lint0errors/29warnings。原有草稿/PNG/sidecar三hash、日常code14/PID5051/安装时间及四配置hash保留。Bug由API准备，后续状态写入来自原生按钮。修复文件BugLifecycleClient.kt由本目标3b1371c新增，62b起点不存在，不能描述为旧基线故障。[code22原生记录](android-code22-no-code.md)、[机器证据](android-code22-no-code.json)。真实物理设备、真实代码分支交付及外部组件仍not_run。

当前固定APK为C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/android-code22-acceptance/qa-hub-preview-code22.apk，35,471,405 bytes，SHA-256 733088b8f876c41ce767627c6de8dfe12e00803c0b61ff13c6facd3b8982d777。code21原包保留为同目录retained-code21.apk，SHA-256 d783e9908e7dacdd660565cf15e1624c567a820e973d01190a38a0981afe7255。本次使用相同debug签名的adb install-r，不声称应用内签名更新源/自升级通过。EXE最新成功包仍为.7，不能把Android .8版本当作EXE新包。

最新生产只读核对为2026-09-08T20:49:45.0734634Z：相对19:55快照，六文件hash、三个原PID精确启动时点及可见日常EXE路径保持，4319 ready/schema12，4174 Windows3.3.5 manifest原字节hash不变。两个Node的可执行路径仍null，没有新增路径证明；未重新验签/下载生产安装包。Android引用code22证据20:46:37.419Z的daily14/PID5051/配置保留，root未重复ADB查询。[最新生产只读证据](runs/production-after-api-fix-code22.json)。

code22同一已验收APK已发布为不可变预览下载：[下载Android code22 / preview.8](http://127.0.0.1:4274/downloads/qa-hub-preview-7c86-android-0.2.0-preview.8-code22.apk)。完整HTTP下载35,471,405字节、SHA-256 733088b8f876c41ce767627c6de8dfe12e00803c0b61ff13c6facd3b8982d777，实例响应头/类型匹配，Windows manifest未变。Android源内容与提交1be772469671d75cbb5e31240bf345dcc7c4a267一致，APK构建发生在提交之前；本次发布没有重新构建或安装。回执不是签名更新manifest，不能记为应用内自升级或物理设备通过。[下载发布证据](runs/android-code22-download-publication.json)。

本轮冻结盘点锚点为81e70d43638f3cb2f3dbd3994acd46f413e5364e，其中API兼容源码提交09f7150、Android源码提交1be7724；188个源码文件hash逐一匹配，985条细目、21条退役历史保留。连续生成器→mapper→生成器重放的语义hash一致；错误proof hash在任何写入前拒绝（0写入），人工负向结果和item/manual复验、sourceHash标记均保留，既有needsRevalidation零丢失。审计结果见coverage-matrix.json的evidenceMapping.finalReplayVerification。
