# 独立项目预览运行与回退说明

适用实例qa-hub-preview-7c86；更新日期2026-09-09。本记录汇总独立预览实现、实际客户端验收和只读生产快照。业务写入、服务启停和安装均限独立预览或隔离fixture；生产边界按证据核对。运行参数来自公开instance配置、启动器与发布回执，不含secrets内容。**Windows最新发包和真实升级/原生恢复为.7（native0.2.0.7，最新恢复PID23924），Bug闭环/编辑/评论/软删除证据来自.5；Android当前code22/preview.8。24基线仅09、10、11、12、15、23、24整项通过，物理Android和真实外部完整链路仍缺。**

## 项目隔离与API修复补充

2026-09-08T22:26Z已在预览完成一次API-only部署，加载人工流程幂等修复提交 `8f7330a559fc9611e93f2ef62df0e63639f07afc`；当时API PID10036 ready/schema14。部署前正常保留一致SQLite（3530752字节、SHA `a4bad9f7d3ae9c10f3cdf629b596549ed6abd6ea168909f659e5e25cf357bdf5`），17表、3附件文件/228251字节及3配置hash在重启前后相同。实际并发新run98请求/105检查通过，与原98请求/86检查的19项产品失败逐项对照；原失败和fixture不覆盖。[完整过程](workflow-concurrency-live/README.md)。这里仅API发生部署，EXE/本地MCP、Web和APK不因服务修复视为更新；操作前仍需核对真实进程身份。

新 C/D 项目隔离验收只使用显式 `instance.json` 和直接4419 HTTP、4421 JSON-RPC，不修改服务或EXE会话。脚本默认不执行；`--selftest` 只验证递归脱敏及协议字符串保真。在已授权的独立预览验收范围内，先核对实例配置和服务身份，再使用 `node scripts/project-components/project-isolation-live.mjs --run C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\instance.json`；每次都会创建新的独立项目和员工，不能当作只读健康检查。[完整脚本与两轮留存](project-isolation-live/README.md)。

既有第二轮1997请求/262断言通过，100次错误项目拒绝后的原项目快照不变；首次363请求因harness变量初始化顺序失败，所有原始记录与fixture保留。05的组件任务日志仍未执行；06仅HTTP/server MCP的最低四类写入归属判据通过，额外绑定属于 `bug_create` 预留，所有客户端或附件意图不随之通过。并发修复绑定上段独立实际部署proof，不把该隔离证据用作并发成功依据；14仍仅部分实测。

## 目录、端口和身份

2026-09-08T23:22Z共享Web已更新为`assets/index-Ce9wROrH.js`，对应已核对的提交`7904e2c`六个Web源码文件。99/99源码测试与独立构建通过；旧dist完整保存在runtime的`web-backups/140143dd-d18b-4616-a34a-4a2e02aa3fa1`，现服务目录继续保留全部旧assets。新index、新旧JS真实HTTP字节/hash匹配；无服务重启，不强制刷新既有页面。EXE仍为.7、APK仍code22。[发布证明](runs/web-pending-submission-publication.json)。真实浏览器响应丢失恢复尚待独立验收，单元测试不补齐该项。

| 用途                     | 显式配置                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| 源码                     | C:\Users\lin0\.codex\worktrees\7c86\Relay-QA-Hub                                                      |
| 实例配置                 | C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\instance.json                              |
| runtime                  | C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86                                            |
| 业务数据 / 备份          | runtime\data / runtime\backups；独立启动配置关闭自动备份 runner                                       |
| 日志 / 发布 / 打包工作区 | runtime\logs / runtime\downloads / runtime\packages\<releaseId>                                       |
| EXE profile              | runtime\desktop\profile；含项目身份、草稿、MCP 文件缓存、升级回执                                     |
| 组件 / 凭据引用          | runtime\components\projects\<projectId>\components\<key>\versions\<version> / runtime\credentials     |
| 秘密文件                 | instance.json 指定 runtime\secrets.json；专用启动器仅在进程内读取，不能进入命令参数、日志、文档或提交 |
| Cookie / 更新通道        | qa-hub-preview-7c86-session / qa-hub-preview-7c86                                                     |
| Windows                  | %LOCALAPPDATA%\Programs\RelayQaHubPreview\RelayQaHubPreview.exe；scheme qa-hub-preview                |
| Android                  | com.relayqahub.android.preview.debug；名称 QA Hub 项目预览；scheme qahub-preview                      |

以下 runtime\... 相对于表内绝对目录，不是生产目录。

| 服务         | 地址                                             | 已保存证据                                                                                             |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| API          | http://127.0.0.1:4419；就绪 /api/v1/health/ready | 2026-09-08T20:39:13.7225210Z启动PID18644；最终dist已加载，实际HTTP读回ready/schema14；操作前仍核对身份 |
| Web/下载     | http://127.0.0.1:4274/；/downloads/<filename>    | 17:52:36Z 回执 PID 20284；GM 浏览和 WebSocket 实际通过                                                 |
| 服务端 MCP   | http://127.0.0.1:4421/mcp；就绪 /health          | 16:46:02Z 转发进程回执 PID 15736；后续核心/资源烟测通过                                                |
| EXE 本地 MCP | http://127.0.0.1:4420/mcp                        | 随独立 EXE 启动；.4 资源读回 90 工具和文件/hash                                                        |

PID 是历史回执，不能手写用于停止。生产 4319、4174、日常 MCP 4320 和日常应用不在这些命令范围内。预览端口当前已分配，不能再当空闲端口。

Web 由 scripts/project-components/preview-web.mjs 服务 apps/web/dist，将 /api/ 和通知 WebSocket 转发到显式 4419；下载仅来自独立 downloadsRoot。它不运行旧生产 Vite proxy。MCP 4421 转发同一 API，保持原认证。静态页面可打开不等于 API ready 或业务成功。

## 查看状态和限定服务启停

使用现有本工作树依赖和 Node 24.19。专用启动器校验配置/sourceRoot、目录边界与真实路径，再控制回执拥有的进程；缺配置、错误来源、端口占用或 PID 身份不符时拒绝。

PowerShell 操作变量：

```powershell
$qaPreviewSource = 'C:\Users\lin0\.codex\worktrees\7c86\Relay-QA-Hub'
$qaPreviewConfig = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\instance.json'
$qaPreviewManager = Join-Path $qaPreviewSource 'scripts\project-components\Manage-QAHubPreview.ps1'
```

只读身份状态：

```powershell
& $qaPreviewManager -Action Status -ConfigFile $qaPreviewConfig -Services @('api', 'web', 'mcp')
```

Status 核对 PID、CreationDate、可执行路径和完整命令行，**不等于 HTTP ready**。实际就绪需分别读取：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:4419/api/v1/health/ready'
Invoke-RestMethod -Uri 'http://127.0.0.1:4421/health'
```

要求 status:ready，并检查 database/evidence/worker；当前证据到 schema 14。上面是后续操作方法，本次文档更新没有调用。

启动时明确服务名；API 先启动，Web/MCP 依赖 API：

```powershell
& $qaPreviewManager -Action Start -ConfigFile $qaPreviewConfig -Services api
```

```powershell
& $qaPreviewManager -Action Start -ConfigFile $qaPreviewConfig -Services web
```

```powershell
& $qaPreviewManager -Action Start -ConfigFile $qaPreviewConfig -Services mcp
```

只重启 Web 时，停止与启动是两个独立操作：

```powershell
& $qaPreviewManager -Action Stop -ConfigFile $qaPreviewConfig -Services web
```

```powershell
& $qaPreviewManager -Action Start -ConfigFile $qaPreviewConfig -Services web
```

API 重启会打断浏览、Android/MCP 请求和本进程工作；先与当前验收者到达操作边界，再单独 Stop -Services api、确认结果、Start -Services api。MCP 同理。**不要省略 -Services，其默认值是三个服务。** 不按进程名批量终止，不使用上述历史 PID。脚本不管理 EXE MCP 4420，不关闭日常 EXE。

Start 不编译源码：API 使用 apps/api/dist/main.js，Web 使用 apps/web/dist。先完成相应构建和回归。仅 Web 静态 bundle 变化时，新开/刷新页面加载磁盘 dist；旧页面可能持有旧 bundle。EXE 使用安装包内 Web，独立 Web 更新不等于 EXE 升级。

最新独立Web构建index-CUjaBP8S.js包含Relay交接历史与暂停恢复入口。Web61/61、Desktop104/104；并发修复后的Storage117/117、完整API239/239（MJS206+TS33；旧238/184/175及分页/删除/协议17项保留为重叠历史子集），另有最新相关Web19/19、root unit4/skeleton1以及typecheck/lint已有日志；严格旧合同历史失败已修复，最新五步全部通过，详见[实施验证表](IMPLEMENTATION.md)。Vite dev/test需要显式QA_HUB_API_BASE_URL；本轮测试设置为4419，但outbox测试请求被限定到其随机本地fixture端口，并未调用预览4419。[Web验证范围](runs/web-outbox-verification.json)。新增生命周期9项的实际范围为成功监听后调度、绑定失败/构造失败清理、并发stop与HTTP/inflight drain；旧runtime已有onReady/onClose，不应描述为从未调度。[历史184日志](runs/api-final-lifecycle-source.txt)、[生命周期证据](component-runtime-lifecycle.md)。

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

.6→.7已通过原生“检查更新→安装并重启”实际完成，proof观测时点2026-09-08T19:54:02.443Z；该次观测已安装nativeVersion0.2.0.7、主PID11368；最新受控停止恢复后为PID23924（21:18:26.3376550Z）。原员工/项目A、文字+1张PNG草稿和配置SHA保持，原Bug13 closed/v14、评论及184872字节原附件materialize/hash读回通过；旧更新结果及7份backup目录保留。新helper的成功result时间19:52:36Z位于真实原生点击区间，UTC已在本次成功更新中核对。[.7升级proof](runs/exe-after-preview7-upgrade.json)、[原生恢复](runs/exe-preview7-restored-draft.txt)。19:54:30Z本地4420与服务4421实际目录均为相同90工具、协议2025-06-18，不支持的协议头均400；此项只证明目录/协议，不能称90个业务工具全部通过。[双入口协议](runs/exe-preview7-live-protocol.json)。

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

矩阵重生保留结果、人工备注和retiredItems，源码变化标记复验。当前985细目不是985项通过；24基线只有09、10、11、12、15、23、24整项通过，22保留物理Android必测缺口，15仅按设计列出的三种实际读取入口判定整项通过，APK/EXE/Web其它控件和17.3物理设备要求不受影响。源目录重复MCP注册行不重复计数。[映射规则与progress](coverage-mapping-review.md)。真实外部Jenkins、上传、Relay、轻语以及物理Android仍缺资源。

基线15已按设计原文重新核对三种读取并校准适用入口，没有增加not_applicable状态。当前09、10、11、12、15、23、24整项通过，其余功能仍按实际入口分别验收。21已只读定位旧上传queue.sqlite/owner/job/chain、Relay批次及轻语状态；仍缺活queue数量/状态、跨文件一致恢复集、明确项目/版本映射及实际迁移核对；schema12程序启动与新增数据回退不再作为21条件。主库及878附件已固定并通过迁移/held服务26项读回，historical-copy资源状态为partially_verified。

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

前轮按冻结源码盘点：188个源码文件、985细目，保留既有人工结果、负向备注与needsRevalidation；当时09、11、12、15、23、24整项通过，其余基线和独立功能仍按实际缺口验收。

## 最终API、Android与生产读回

响应合同修复时的dist已在独立API PID18644加载，启动时点2026-09-08T20:39:13.7225210Z，4419 ready/schema14。root实际31个HTTP调用通过：六条冻结POST的vendor/JSON输出、同幂等请求切换媒体重放、丰富历史读取及跨项目404；另核对14个媒体头与原EXE Bug closed/v14、评论及184872字节附件hash。[31次实际请求](runs/frozen-workflow-live-2026-09-08T20-40-57-088Z.json)、[媒体/旧业务读回](runs/frozen-workflow-live-readback.json)。请求均使用1.1；没有以此补齐旧1.0请求、未注册路由或全部HTTP/MCP对等。

Android最新实际安装为com.relayqahub.android.preview.debug，code22 / 0.2.0-preview.8，MuMu中21→22覆盖升级与原生开始→无需代码提交→验收通过关闭完成。Bug386cdd2f-44c9-4a79-992a-891d595766fd closed/v6；49条对应HTTP均2xx，deliver1次、complete0次，87单测通过，lint0errors/29warnings。原有草稿/PNG/sidecar三hash、日常code14/PID5051/安装时间及四配置hash保留。Bug由API准备，后续状态写入来自原生按钮。修复文件BugLifecycleClient.kt由本目标3b1371c新增，62b起点不存在，不能描述为旧基线故障。[code22原生记录](android-code22-no-code.md)、[机器证据](android-code22-no-code.json)。真实物理设备、真实代码分支交付及外部组件仍not_run。

当前固定APK为C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/android-code22-acceptance/qa-hub-preview-code22.apk，35,471,405 bytes，SHA-256 733088b8f876c41ce767627c6de8dfe12e00803c0b61ff13c6facd3b8982d777。code21原包保留为同目录retained-code21.apk，SHA-256 d783e9908e7dacdd660565cf15e1624c567a820e973d01190a38a0981afe7255。本次使用相同debug签名的adb install-r，不声称应用内签名更新源/自升级通过。EXE最新成功包仍为.7，不能把Android .8版本当作EXE新包。

前轮生产只读核对为2026-09-08T20:49:45.0734634Z：相对19:55快照，六文件hash、三个原PID精确启动时点及可见日常EXE路径保持，4319 ready/schema12，4174 Windows3.3.5 manifest原字节hash不变。两个Node的可执行路径仍null，没有新增路径证明；未重新验签/下载生产安装包。Android引用code22证据20:46:37.419Z的daily14/PID5051/配置保留，root未重复ADB查询。[前轮生产只读证据](runs/production-after-api-fix-code22.json)。

code22同一已验收APK已发布为不可变预览下载：[下载Android code22 / preview.8](http://127.0.0.1:4274/downloads/qa-hub-preview-7c86-android-0.2.0-preview.8-code22.apk)。完整HTTP下载35,471,405字节、SHA-256 733088b8f876c41ce767627c6de8dfe12e00803c0b61ff13c6facd3b8982d777，实例响应头/类型匹配，Windows manifest未变。Android源内容与提交1be772469671d75cbb5e31240bf345dcc7c4a267一致，APK构建发生在提交之前；本次发布没有重新构建或安装。回执不是签名更新manifest，不能记为应用内自升级或物理设备通过。[下载发布证据](runs/android-code22-download-publication.json)。

前轮冻结盘点锚点为81e70d43638f3cb2f3dbd3994acd46f413e5364e，其中API兼容源码提交09f7150、Android源码提交1be7724；188个源码文件hash逐一匹配，985条细目、21条退役历史保留。连续生成器→mapper→生成器重放的语义hash一致；错误proof hash在任何写入前拒绝（0写入），人工负向结果和item/manual复验、sourceHash标记均保留，既有needsRevalidation零丢失。审计结果见coverage-matrix.json的evidenceMapping.finalReplayVerification。

## EXE 停止期间的 HTTP / 服务端 MCP 独立性

设计基线11原文为“关闭 EXE 后，外部程序仍可登录、查询、评论和改状态”；12为“服务端 MCP 不依赖 EXE，并覆盖同样主要 Bug 动作”。此前生成器把“全部动作/完整负向场景”加入这两个基线，超出原文；这些要求继续由§17全功能矩阵及13/14对等、并发项目验收。该轮按独立性纠正11/12，当时整项通过为09、11、12、15、23、24。

2026-09-08T21:13:39.2199432Z，主代理对已核对精确路径/启动时点的预览EXE主进程11368执行 controlled_fault_stop；没有登录后立即强停的组合，也没有操作日常EXE。独立性脚本在21:14:14.415Z–21:17:11.392Z一次运行通过：33次直接HTTP请求、36次服务端4421请求（业务为真实JSON-RPC）、140次逐请求前后及首尾边界，预览目录/同名进程和4420监听始终不存在。两个独立员工和Bug各完成登录、查询、编辑、评论重放、人工完成、验收失败退回、再次完成和通过关闭v12，随后软删除并读回拒绝/列表消失；各17条事件actor、验收人及旧版本/错项目负例均核对。[可读全过程](exe-independent-services.md)、[69请求和140边界](runs/exe-closed-api-mcp.json)、[精确停止](runs/exe-independence-controlled-stop.json)。

停止期间，109个预览profile文件共772540633字节冷保留，全部hash相同。21:18:26.3376550Z恢复同一已安装.7，主PID23924、4420恢复；原员工/项目/文字+1PNG/配置SHA，以及原Bug closed/v14、1评论和184872字节原附件hash读回不变；API18644、服务MCP15736、Web20284继续运行。[冷保留](runs/exe-independence-profile-retained.json)、[原生恢复和业务读回](runs/exe-independence-restored.json)、[恢复界面](runs/exe-independence-restored-draft.txt)。该实测不证明正常托盘退出、Windows托盘图标点击或任意崩溃组合。

最新生产只读快照为2026-09-08T21:22:09.4439761Z：六文件hash、三个原PID精确启动时点和可见日常EXE路径保持；4319 ready/schema12，4174 Windows3.3.5 manifest原字节SHA不变。两个Node路径仍null；本次没有重新ADB查询，Android仍引用20:46:37.419Z的code22证据。[独立性恢复后生产快照](runs/production-after-independence.json)。

21的旧外部状态现已找到并只读盘点：53文件，3上传job/2chain/9Relay batch共17items，以及活queue/WAL位置。活SQLite未打开，队列行数/状态未知；未建立跨文件一致导出或迁移，项目/组件版本绑定及Qingyu密文/密钥恢复仍缺，因此21保持not_run。[盘点及限制](baseline21-external-state-inventory.md)、[脱敏元数据](baseline21-external-state-inventory.json)。本轮只把实际17条HTTP路由和12个服务MCP源码工具行追加对应证据，没有转移到本地MCP、APK/Web控件或全部状态组合。

## 独立性证据与脱敏保真最终检查点

前轮源码盘点锚点为538c78f03e74aef8d02d13ad3e166ab3ece4a06f（脱敏修正提交）；业务API源码仍09f7150，Android源码仍1be7724。8份新的corrected派生由已核对原始SHA的私有原件生成，旧公开proof保留；它们修复104个JSON-RPC版本和240个事件schemaVersion的证据文本，业务结果、失败历史、检查数量未变，绝不计作新增业务运行。mapper只读取公开文件，核对index及old/corrected两侧SHA后解析派生内容，在当前结果保留old引用并追加corrected引用。[更正说明](redaction-corrections/README.md)、[公开哈希索引](redaction-corrections/index.json)。两份实际脱敏helper共有18/18纯函数测试通过；原1.0请求/blocked及未注册路由的业务能力缺口不因本证据修正改变。

前轮仅11/12及所对应实际入口新增通过；当时整项基线为09、11、12、15、23、24。985项/188源码文件/21退役历史、401复验标记继续保留；完整HTTP/MCP对等与并发、§17全功能、18/19外部执行、21一致迁移和22物理Android仍未完成。预览EXE当前已恢复PID23924；最新生产观测为21:22:09.4439761Z，均以本轮独立性proof为准，前轮时点保留为历史。

前轮最终重放已完成（2026-09-08T21:38:02.173Z）：985项、188源码hash逐一相符、21退役历史和401复验标记保留。两次generate→map→generate的语义SHA-256同为cc470e52d6f9537a9790a75a5e9fe1a6d96957e62174dfc38b58a6d695639f48；实际mapper的内存FS故障测试证实manual/source-change标记及reviewed失败结果保留，独立性proof或corrected proof错hash均在任何写入前拒绝（0写入）。该轮只有8个入口状态由not_run变passed：11/12两基线、HTTP的DELETE/manual-complete/events三路、server MCP的list_bugs/update_bug/list_events三工具；派生脱敏本身没有新增业务通过。审计字段见coverage-matrix.json的evidenceMapping.finalReplayVerification，前轮检查点保留在finalReplayVerificationHistory。

## EXE人员管理补充与基线10判据

以dc9889263cbe2b7d499ec0efbff33b512a490ef9为本轮证据锚点。设计444“两端均按现有方式完成项目人员查看、关联与停用”承接443的APK、EXE；10现在仅用这两个必要入口汇总。已有MuMu code19原生人员查看/关联/解除/停用/恢复和稳定ID读回，加上此次已安装EXE .7的独立实际操作，满足10整项；其它入口人员功能及§17.3物理Android继续独立验收，既有HTTP结果保留。

本次4个EXE业务动作、24辅助HTTP、6组截图/树、7项断言通过：A内关联/解除有2条唯一身份事件；停用/恢复有2条原actor成员事件，A主资格v1→2→3，B两人active/v1且无link；A同名登录及旧session403，B仍200。原Bug完整DTO、员工及文字+PNG草稿保持。5条UI/REPL诊断保留，未重做业务变更；新员工任务数0，不证明非零引用保全。[原生验收](exe-native-personnel/README.md)、[结果](exe-native-personnel/result.json)。

新增通过限于4.EXE、10.EXE与确认关联/取消关联/停用/恢复四按钮；搜索、主用户选择及整页只记录部分实测。当前wholepass为09、10、11、12、15、23、24，4整体仍not_run。生产最新仍21:22:09.4439761Z快照；本轮没有再次探测生产，也没有启停服务。

本轮重放以dc98892为锚点，985项/188源码hash/21退役项/401复验标记保持；相对该提交仅6个EXE入口状态新增通过，10的必要入口改为APK/EXE并保留旧HTTP证据。稳定重放语义SHA为c23f07f22c0195b2dc59eab39c7cb4f84d32c79ea770cd0a884147ea33902b9f。proof统一按原始字节求SHA；首次JPG文本hash不匹配被拒绝后修正，旧JSON及14份人员proof的字节hash均核对不变。

## 本轮提交恢复检查点（2026-09-09）

共享 Web 修复已在提交 `7904e2c` 冻结并仅发布到4274：实际新包 `assets/index-Ce9wROrH.js` 的下载哈希已核对，旧完整目录和旧资源保留，Web服务未重启。实际浏览器的第二轮 `bf3a4621-6c48-459e-b776-5c9011d7d327` 完成101/101检查：Bug和评论各丢失一次服务端真实201回执、三次正常浏览器重启后，原键确认仅产生一份记录，PNG与两份后改稿、两份确认回执保留。首轮38项后控件识别超时及完整profile仍留存；修正仅在验收脚本。[两轮真实过程与独立审计](web-submission-recovery-live/README.md)。这只补充14.Web的部分能力，其他入口及旧版本拒绝、跨窗并发、其他动作仍须分别验收。

Android恢复源码已提交 `fb2eca7`：原提交身份、请求和图片持久保留，旧code22队列先确认，协议异常只由专用按钮按原请求重试。115/115单测和lint0错误/33警告；一处CRLF提交规范化在proof中保留前后哈希，没有声称重复运行测试。[源码与限制](android-offline-create-recovery.md)、[code23实际验收计划](android-code23-recovery-plan.md)。code23/.9已完成隔离构建，但本检查点设备仍为code22，EXE仍为preview.7；源码测试和构建不计作安装或原生恢复通过。

矩阵映射保护修复已提交 `6b28723`：13项纯内存审计证明失败结果、401个复验标记、159条原说明均保留，说明归档稳定为218条；关闭两个保护分支的对照复现68条失败降级，现修复为0。[纯内存审计](mapper-memory-audit.json)。该审计没有写实际矩阵，后续实际重放另记，不能把静态映射审核计作业务验收。

## 08:24 +08:00 原生恢复检查点

MuMu预览APK现为code23/`0.2.0-preview.9`，已按原key/body找回code22耗尽重试的文字Bug，修改稿和原A草稿/图片保留；原项目与AndroidCaptureQA已在界面恢复。独立API确认仅一个Bug/occurrence/event；本地只有一份匹配重放回执，其余旧操作/回执未变。日常APK仍code14/PID5051，原runtime配置及日常偏好哈希一致。临时4559代理已通过stop标记正常退出，设备4419恢复到主机4419。[原生记录](android-code23-recovery-live/65ee5dc8-3f23-4f28-ad97-daa1de8b0ece/README.md)。所有私有冷归档、旧APK、harness失败、测试项目和草稿保留；此操作不是应用内更新或物理Android验收。

矩阵实际两轮生成已完成并提交`b62e259`，991项/191源码/28退役/484复验，语义零差异，原159条说明保留；13个新增控件未自动通过。首轮生成失败独立保留，整项通过仍为7/24。[重放证据](coverage-actual-replay-88366a43.json)。后续代码变化必须重新标识待复验，不得将旧摘要当当前新结果。

EXE `.8` 的已验安装器留在独立staged-downloads，SHA `b72f04e882873ea0c6f69ccbb09aa7eb612a20343cff0708c0a4816d6dafa147`；[打包证据](exe-preview8-package-only/README.md)记录当时未发布/安装。root后续从实际`.7`应用内更新入口执行升级，结果另记。Android preview feed路由补齐仍处于源码测试阶段，API4419保持PID10036；APK及EXE的发布都只允许独立预览目录/通道。

## 09:07 +08:00 独立实例新检查点

EXE现已由应用内更新完成`.7`→`.8`（native0.2.0.8，release20260909T000712593Z，主PID19500/local MCP4420），正式预览Windows latest指向已验证b72f04e8…安装器。原项目A/员工/未提交文字+exe-test-input.png和既有Bug/评论/图片保持；旧`.7`包、manifest、backup目录及私有冷副本留存。[实际升级与限制](exe-preview8-live/1786509a-9de7-4d1a-ba8c-9fb282c9c453/README.md)。冷副本只包含排除顶层updates的67个应用文件，不可据此覆盖或清理原profile。原生详情首次误报单独保留为`.8`缺陷。

共享Web坏媒体显式换稿81/81真实验收已提交`31eca88`，其fixture/profile/旧坏图及失败journal均保留。Android route/context修复`0a00ae2`已过246/246，但本检查点API4419仍PID10036、尚未部署或发布Android feed。后续先在无业务写入窗口完成一致SQLite+引用附件archive、quarantine及实际上传表/配置/PID对照，再只用manager显式`-Services api`操作该实例。

Web详情加载修复`bc2b347`已过102/102，尚未出现在正式4274或已安装`.8`。4274直接服务apps/web/dist；下一包必须先构建到独立runtime web-dist，不能因打包而隐式替换正在服务的目录。当前旧Web包及所有证据继续保留，新构建、发布、原生`.9`验收分别记录；旧生产服务和日常客户端不操作。

## 预览API更新完成后的运行状态

API-only部署已实际完成并提交`947664b`，当前4419为PID22852/start2026-09-09T01:22:20.2728640Z，ready/schema14；旧10036经manager精确停止后另证CIM不存在、4419无监听。保全与前后对照通过，70表、全部附件/quarantine和其他入口/生产身份配置不变。[完整范围](android-update-deployment-retention/7a94eb90-63a2-4841-afa5-318612eb06ce/README.md)。私有38文件恢复点及旧API源码ZIP保留，后者只是重建输入。

EXE当前仍`.8` PID19500，Web4274仍Ce9wROrH；Android仍code23，预览23733/日常5051。`.9`已在独立web-dist完成封包并提交`daf67d2`，只有staged manifest及安装器，尚未发布/安装。Android preview匿名latest现为正确注册路由返回的404/ANDROID_UPDATE_NOT_FOUND，原code23 feed将另行发布；stable匿名401是项目鉴权组合的实际结果。所有后续动作仍限独立预览通道，原生产与日常客户端保持。

## code23 feed 与 .9 自更新完成后的运行状态

Android预览feed现已提供code23/0.2.0-preview.9，原APK SHA9cfa87eb…、35536941字节；实际发布与13次下载校验已提交`5cb6947`。API4419和Web4274的manifest/APK均核对通过，旧code22下载仍在；发布锁和所有私有候选/旧文件副本保留。[feed执行记录](android-code23-feed-publication/29a9b98b-2fa8-4625-a465-5d75a91b70e8/README.md)。这是下载源发布，不是Android设备升级；本窗口未调用设备。

Windows预览latest已指向`.9`/release20260909T011704801Z，108334255字节/SHA2c50fe1b…安装器。已安装EXE通过原生应用内自更新进入`.9`（native0.2.0.9），主PID13564/start01:44:08.4163170Z并持有4420。原配置和公钥不变，旧`.8`回退目录、先前8个回退目录及安装器仍在；私有67文件冷副本只排除顶层updates，不能用作清理或覆盖原profile的依据。最终窗口仍显示原员工A的未提交文字及PNG。

新EXE实际首选旧Bug显示加载后成功，无需重试；独立前后53/62项和安装产物114项通过。API22852、Web20284、server MCP15736及生产原进程/六文件在该次对照中保持。共享Web4274仍为Ce9wROrH，下一步只部署已冻结的独立8文件构建，并保留正在服务的旧目录与资源；不可在apps/web/dist直接build。所有完成声明仍限各自证据时段和入口，整体验收未完成。
