# QA Hub 项目制与组件化 v2.1 实施记录

更新日期：2026-09-09。本记录汇总独立预览实现、实际客户端验收和只读生产快照。业务写入、服务启停和安装均限独立预览或隔离fixture；生产边界按证据核对。**24 项最低基线尚未全部通过，持续目标不能标记 complete。** 编译、mock、目录存在、排队与真实外部完成分别记录。

## C/D 项目隔离实测补充

2026-09-08T22:12:32.958Z–22:12:44.758Z，直接 HTTP 4419 与服务端 JSON-RPC MCP 4421 在全新 C/D 项目完成 1,997 次请求、262 条断言。100 次授权拒绝（60 读取、40 写入）均有原项目 Bug、版本、事件、评论、附件字节、统计及分类前后不变读回；两项目无成员请求为403，双成员显式错记录项目为404，并有合法成功对照。仅配置读取确认五组件全关，没有调用组件任务或日志路由、UI、本地MCP或服务控制。[两轮证据和范围](project-isolation-live/README.md)。

基线06原文的修改、评论、上传绑定和状态四类在 HTTP/server MCP 两入口满足最低判据，另验证软删除；其它入口及整项未完成。额外绑定是 `bug_create` 预留和同键持久重放，不是把新附件认领到既有Bug；最初四份PNG已由真实创建事务认领。基线05仍是部分实测：组件任务日志未执行，事件和附件不替代日志。首次363请求/45已完成断言因脚本变量初始化顺序错误中止；原始失败、两个项目、员工、四Bug和预留全部保留，新fixture第二轮没有覆盖它。精确映射只覆盖13条HTTP路由及14个服务端工具，不推导所有分支或完整HTTP/MCP对等通过。

## 同键并发回执修复

人工流程并发实际失败与修复分别保留：[首次](workflow-concurrency-live/e94223b3-82c5-469d-b7ca-eea306ba0aab.json)98请求/86检查中19项失败，六动作同键重放被旧版本拒绝，以及创建同键不同payload返回错误500。修复提交 `8f7330a559fc9611e93f2ef62df0e63639f07afc` 新增事务内持久回执并统一创建409错误；API239/239、Storage117/117及原严格合同门禁通过。API-only部署后，2026-09-08T22:26:42.653Z–22:26:43.549Z [相同12并发组](workflow-concurrency-live/badce916-8b25-463b-9ee2-ddad3727350f.json)98请求/105检查全过，原86项逐label重测；新增18个成功资源比较和1个HTTP409断言。首次失败原样保留，不能把105与86的差异说成增加19个业务场景。

这证明 ready、人工修复计划/开始/无代码交付、验收创建/开始的同键并发与后续重放均返回已提交资源，且相同事件/操作者无重复；不同编辑键同旧版本一胜一冲突。基线14的HTTP/server MCP仍为部分实测，客户端真实timeout恢复、local MCP、更多动作、所有附件阶段和外部任务去重仍缺。仅升级前后17表指纹、3附件文件/228251字节、3配置hash相同及一致备份保留得到[重启前后证据](workflow-concurrency-live/after-restart-33c28537-73ad-4037-b1c4-bff011da9a53.json)支持，不推导外部队列恢复。

相反验收结论另有[独立真实竞争证据](workflow-verdict-concurrency-live/README.md)：66请求/56检查、四个双请求竞争，其中两组同manual_complete，两组verify_pass/verify_fail及close/reject。两组相反结论均由HTTP通过方胜出，Bug/Verification只前进一版本、审计只新增一事件；跨HTTP/server MCP的胜方原回执重放、败方旧版本拒绝、胜方改payload拒绝均有不变读回。所有新fixture保留且五组件关闭；不推导退回成功效果、客户端恢复、其它入口或完整基线14。

## 共享 Web 提交恢复源码与独立发布

提交 `7904e2c2d7285003884a5788a83300fbf521dbf1` 保存创建/评论的原业务ID、冻结请求、File及上传阶段回执；未知结果重试使用原意图，确认后保留后来修改或留空的草稿。明确无核心业务效果的拒绝经持久记录后提供显式纠稿入口，未知历史和权限/归属异常不能释放提交身份。Web99/99、App/Node类型检查、相关lint/format通过；[源码证明](web-pending-submission-source.md)明确测试使用本地替身，不作为实际浏览器/EXE恢复通过。

2026-09-08T23:22:03.396Z已把同一冻结Web源码构建至新runtime目录，再保留完整旧dist和全部旧assets、原子更新独立4274的index。新bundle为`assets/index-Ce9wROrH.js`；新index、新JS及旧JS均真实HTTP下载核对hash，未重启任何服务。[构建日志](runs/web-pending-submission-build.txt)、[发布及保留读回](runs/web-pending-submission-publication.json)。其他工作树修改尚在进行，发布proof仅绑定已核对的六个Web文件和上述提交；EXE/APK未因本次Web发布更新，浏览器故障注入验收尚未运行。

2026-09-08T23:13:03.140Z的[生产只读复核](runs/production-after-verdict.json)确认六文件hash、三个原PID启动身份、ready/schema12和3.3.5公开manifest仍与22:28证据相同；两个生产Node可执行路径不可读取，没有把null相等当作路径验证，也没有重新查询Android或验签。

## 工作树和边界

- 工作树：C:\Users\lin0\.codex\worktrees\7c86\Relay-QA-Hub。
- 分支：codex/project-components-v2-1；起点 62b4495c9b28dc3aea1d5633e870be4e1fdf841f。首个实施提交为3b1371cbbaee4ab31f5861fe3cd72d6ff93c4789；本轮补充包含证据映射/判据校正，合同修复已提交09f7150，Android源已提交1be7724；本轮源码清单按最终内容冻结。
- 依据：完整读取 docs/design/project-components-transformation-2026-09-08.md v2.1，包含第 16、17 节；适用 C:\Users\lin0\.codex\AGENTS.md 和本任务生产隔离约束。
- 不合并 main、不推送生产分支、不发布或重启生产，不覆盖日常 EXE/APK，不清理已有草稿、附件、备份或任务。旧运维脚本中的生产路径和默认回退不能直接用于预览。
- 本工作树独立 npm 依赖已在前期安装；源码、运行目录、客户端身份、Cookie 和更新通道与日常实例分开。

设计文档只读复制来源和当时校验值保留如下；源文件未修改。

| 源文件                                                                         | SHA-256                                                          |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| D:\Relay-QA-Hub\docs\design\project-components-transformation-2026-09-08.md    | 8DABD8C8542F33659579BB0692A5831EF902ABF710941655779513548C21AF42 |
| D:\Relay-QA-Hub\docs\design\QA-Hub-项目制与组件化改造方案-v2.1-2026-09-09.docx | 18EB69F2507FE586D4E7438988BB16246BC410129C9319E876D2970080326B36 |

## 当前实现与运行基线

独立配置为 C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\instance.json。API 4419、Web/下载 4274、服务端 MCP 4421、本地 EXE MCP 4420。操作方法见 [preview-operations.md](preview-operations.md)。

已有真实管理和GM项目读回确认 API ready / schema **14**，database、evidence、worker均正常。最新并发修复观测为API PID10036（2026-09-08T22:26:05.0349230Z），[实际ready](workflow-concurrency-live/readiness-after-restart.json)为schema14；[22:27进程边界](workflow-concurrency-live/processes-after-restart.json)中Web20284、MCP转发15736和预览EXE23924未随API-only部署改变。此前响应合同修复使用PID18644的记录继续保留；这些历史PID不能替代下一次操作前身份核对。[GM就绪读回](runs/server-mcp-gm-project-live.json)、[生产盘点](production-inventory.md)、[本次生产只读留存](workflow-concurrency-live/production-after-workflow-fix.json)。

此前提交前只读生产快照为2026-09-08T19:30:39Z：六个文件hash、三个原PID/启动时点均与19:02:22Z一致，4319 ready/schema12，4174的Windows 3.3.5公开manifest原字节hash一致；日常APK code14/PID5051/安装时点保留，预览APK code21仍在。未读取配置正文或凭据，未启停任何应用，未重新验签。日期比较曾因PowerShell隐式转换丢失小数精度误报，已按原始UTC字符串100ns精度更正并保留说明。[提交前生产快照](runs/production-pre-commit.json)。

此前.7升级后生产只读核对为2026-09-08T19:55:31.6095789Z：六文件hash、三个原PID及精确启动时点不变，4319 ready/schema12，4174 Windows3.3.5 manifest原字节SHA不变。日常EXE可读路径相同；两个Node的路径仍为null，不能视为新增可执行路径验证。本轮未重新查询Android，APK状态仍引用19:30快照；未读配置正文/凭据或修改生产。[.7后生产快照](runs/production-after-preview7.json)。

| 范围        | 已落实行为                                                                                                                                                                     | 证据和边界                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目与身份  | UUID/大小写不敏感短码入口、姓名登录、稳定人员 ID、所属项目列表；显式撤销后同名登录不能恢复；成员和身份关联按项目隔离                                                           | [后端基础](backend-foundation.md)，持久管理 96/96                                                                                                                                                           |
| GM          | 独立口令加服务端唯一 UUID/account；每个 worker 消息固定最小项目授权，事务内清除或回滚；普通目录显示真实 membership                                                             | [GM 授权](gm-authorization.md)；非成员 GM Bug 实际 closed / v12                                                                                                                                             |
| 基础 Bug    | 组件全关时创建、处理、人工完成、验收退回、再次完成和关闭，不等待 Relay 或第三方                                                                                                | 基线09的 APK/EXE/Web/HTTP/serverMCP/localMCP 各有独立实际闭环；不推定各端其余动作全部通过                                                                                                                   |
| Web         | 请求固定 service/project/user 与项目头；取消旧请求；项目草稿/人员/File 持久化；撤权导出；GM 管理；全关时本地历史可读；新增 Relay outbox 暂停原因及范围确认恢复，保留原批次恢复 | [员工浏览](web-browser/results.md)、[双标签恢复](web-browser/dual-window-results.md)、[GM 浏览](web-browser/gm-results.md)、[outbox本地验证](runs/web-outbox-verification.json)；有数据的浏览器恢复点击未测 |
| 组件后端    | 五组件默认关闭；配置 CAS/依赖/公开白名单；任务固定项目/版本/人员及凭据摘要；暂停与显式恢复；导入 hold；Relay outbox 精确认领                                                   | [组件后端](backend-components.md)、[运行合同](component-runtime.md)；外部完整链路未运行                                                                                                                     |
| C# uploader | 0.5.0 独立执行器，显式来源/目标/项目/版本，独立鉴权和锁路径，拒绝生产默认回退                                                                                                  | 自检 40/40，包含本机 SDK 回环和 supervisor；realPlatformTested:false                                                                                                                                        |
| MCP         | 服务端与 EXE 共用 HTTP 业务映射，运行目录 90 工具；真实附件 materialize/read/resources 与 SHA-256 证据                                                                         | [目录](mcp-runtime-catalog.json)、[服务端资源](runs/server-mcp-real-resource-20260909.json)、[EXE .4 资源](runs/desktop-mcp-resource-preview4.json)；目录不是逐工具通过                                     |
| 通知        | Web 通知 WebSocket 代理保留项目 Cookie，API 检查认证                                                                                                                           | [真实代理](runs/websocket-real-proxy.json)：认证 101、匿名 401                                                                                                                                              |

## 已发布和安装版本

**Windows 0.2.0-preview.7 已完成独立发布和实际6→7原生升级验收。** releaseId为20260908T194425490Z，108378668字节，SHA-256 fbf0656285474e2b4d521178cb9107dd26d3426dd463b9198fc21b239e02152a。公开回执sourceCommit为3b1371cbbaee4ab31f5861fe3cd72d6ff93c4789、sourceDirty:false；文档更新只读核对receipt及主代理实际原生升级proof；未额外操作安装或验签。回执位置：C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\packages\20260908T194425490Z\receipt.json。此包已含首装guard及提交内源码，升级passed依据下述实际proof。

.6→.7已通过原生“检查更新→安装并重启”实际完成，proof观测时点2026-09-08T19:54:02.443Z；该次观测已安装nativeVersion0.2.0.7、主PID11368；最新受控停止恢复后为PID23924（21:18:26.3376550Z）。原员工/项目A、文字+1张PNG草稿和配置SHA保持，原Bug13 closed/v14、评论及184872字节原附件materialize/hash读回通过；旧更新结果及7份backup目录保留。新helper的成功result时间19:52:36Z位于真实原生点击区间，UTC已在本次成功更新中核对。[.7升级proof](runs/exe-after-preview7-upgrade.json)、[原生恢复](runs/exe-preview7-restored-draft.txt)。19:54:30Z本地4420与服务4421实际目录均为相同90工具、协议2025-06-18，不支持的协议头均400；此项只证明目录/协议，不能称90个业务工具全部通过。[双入口协议](runs/exe-preview7-live-protocol.json)。

.7新增原生窗口子集验收（2026-09-08T19:56:56.606Z）：打开草稿时点击窗口关闭按钮后无可见窗口，本地MCP仍能读取原closed Bug；第二次启动精确已安装预览EXE后，原主进程PID11368及启动时点19:52:36.0963040Z不变，恢复窗口2165104中的同员工、原文字+1张PNG草稿。恢复通过第二次EXE启动并激活已观察的主窗口完成；短暂无标题窗口曾无法激活，后续选择标题主窗口成功。**这里只证明关闭到后台和单实例第二次启动恢复，不包含Windows系统托盘图标点击、进程重启或强停。** [窄范围proof](runs/exe-preview7-close-restore.json)、[原生恢复界面](runs/exe-preview7-tray-restored.txt)。

此前0.2.0-preview.6的实际升级和原生恢复证据继续保留。 releaseId为20260908T185123338Z，108378454字节、SHA-256 989b9c9c7ddd51310c5d2a5dc94b5875643d50c769e42a1f84d2d4cb7bc281f1，安装目录%LOCALAPPDATA%\Programs\RelayQaHubPreview。18:58:33Z的实际proof确认installed，原项目/人员/配置hash不变，原生文字+1张PNG草稿恢复；五份旧安装backup保留，.5旧update-result按原hash完整归档。[.6升级读回](runs/exe-after-preview6-upgrade.json)、[.6恢复界面](runs/exe-preview6-restored-draft.txt)。此次由.5复制的旧helper仍把本地时间误标Z，以proof.observedAt为准；.6修正helper后来经独立故意失败用例验证UTC，见下表；不追加更新成功。此前.4/.5共存与历史读回仍保留，[.5升级](runs/exe-after-preview5-upgrade.json)、[生产留存核对](runs/production-after-preview5.json)。.6→.5回退、重复升级及卸载同包重装随后均已实测，详见下段。

.5 原生 UI 真实创建含保留PNG的 Bug、指定当前员工、开始处理、人工完成、验收失败退回、再次完成、验收通过，Bug TA1788885078625-13 closed/v13；随后原生编辑描述并保存至 closed/v14，提交并读回1条评论。原184872字节PNG hash未变。[闭环](runs/exe-ui-bug-closed-readback.json)、[编辑评论](runs/exe-ui-edit-comment-readback.json)。另建测试Bug TA1788885078625-14，原生确认软删除后列表消失、MCP上下文/附件拒绝；只读SQLite仍保留Bug及删除actor/version/幂等审计，原Bug13保持closed/v14。[删除读回](runs/exe-ui-delete-readback.json)、[保留审计](runs/exe-ui-delete-retained-storage.json)。发布包含未提交工作树；commit不足以确认所有后续源码已入包。最新独立Web build index-CUjaBP8S.js已含outbox UI，不能据此推定.5内嵌Web同步；后续包与原生UI由主代理处理。

后续19:01:28Z已实际手工回退.6→.5：旧backup继续保留，整个.6目录另存为.rollback-retained-20260908T1901Z，profile未改；原生同员工/项目/文字+图恢复，Bug13仍closed/v14且原评论/附件hash保留。19:02:22Z生产六文件hash、三个原进程/启动时点及ready/schema12不变。[手工回退](runs/exe-preview6-to5-rollback.json)、[业务保留](runs/exe-rollback5-business-readback.json)、[生产核对](runs/production-after-preview6-rollback.json)。

随后重复升级.6成功，原.backup-release与新增-1备份同时存在，原生草稿恢复。实际卸载.6时整个安装转存.uninstalled-release，profile的102文件/663514299字节逐一hash完全不变；之后使用精确相同.6包重装成功，原员工A/配置/文字+1图恢复，原closed/v14、1评论和附件hash读回。[重复升级](runs/exe-preview6-repeat-upgrade.json)、[卸载保留](runs/exe-preview6-uninstall-readback.json)、[同包重装](runs/exe-preview6-after-uninstall-reinstall.json)。**这里仅记录EXE客户端回退/恢复通过；基线24随后由独立47项服务/HTTP演练满足，其他客户端功能不传递通过。** 当前最新成功安装和原生恢复proof为.7；.6回退/卸载重装只证明当时的客户端范围。

**Android 当前为 com.relayqahub.android.preview.debug，0.2.0-preview.8 / versionCode 22；新增原生验证见下方code22专节。** 此前code21证据继续保留。 与日常包分离；15→21 预览升级、手工闭环、截图/附件和人员管理有 MuMu Android 15 模拟器证据。20→21实际恢复原项目/身份/文字和未提交PNG，drafts/sidecar/PNG三份hash不变；code21本地批次/交接/禁用远端三个tab实际可达，前两者为空列表，未操作有数据的恢复或merge。日常code14/PID5051/安装时点/dataDir不变。**没有物理Android设备证据**；基线22保持not_run，ADB更新不是签名更新源和应用内自升级通过。[Android完整记录](android-implementation.md)。

EXE 异常退出独立性已取得真实子集证据：仅停止预览 EXE 后，预览进程及本地 4420 消失，独立 HTTP 核心 15 项与服务端 MCP 核心 13 项继续通过；恢复预览后原员工、文字及 1 张图片草稿保留。日常 EXE PID 17160/启动时间不变，生产仍 ready/schema 12。这不代表全部 HTTP 动作通过。[异常退出读回](runs/exe-fault-independent-api-mcp.json)、[HTTP 15 项](runs/http-core-2026-09-08T18-19-04-805Z.json)、[MCP 13 项](runs/server-mcp-core-2026-09-08T18-19-05-946Z.json)、[草稿界面](runs/exe-preview4-after-fault-draft.txt)。

新增.6实际身份边界：原生退出后磁盘身份清除，本地MCP返回QA_HUB_LOGIN_REQUIRED；local MCP登录成功返回时身份已经落盘；原生重新登录同员工/项目后原文字+1张PNG草稿恢复。[退出读回](runs/exe-preview6-logout-readback.json)、[同步持久登录](runs/exe-preview6-login-durable-readback.json)、[原生重登草稿](runs/exe-preview6-relogin-draft.json)。登录后立即强停的组合命令被自动审批拒绝、未执行且未重试；这组证据明确processRestartNotTested，不能据此声称该强停场景通过。

新增预览.6真实双入口删除：服务端4421和已安装EXE的本地4420各创建独立Bug并调用默认删除；相同请求重放均replayed:true、删除时点相同，context返回NOT_FOUND，原Bug及删除actor/version审计保留。[双MCP删除实测](runs/mcp-delete-live-preview6.json)。仅映射对应qa_delete_bug入口，不把一个删除用例推定为全部HTTP/MCP动作对等或全量幂等通过。

## 已取得的验证

| 验证                           | 结果                                                                                         | 实际范围                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 持久 HTTP 管理                 | 96/96；GM 非成员完整人工闭环；配置见证器 0 出站                                              | [运行 JSON](runs/management-2026-09-08T17-53-20-441Z.json)，仅所列场景                                                                                                                                                                                                                                   |
| Web 浏览                       | 员工 closed/v13；JPEG 下载匹配；A/B 草稿切换/刷新、双标签撤权导出恢复；GM 6/6、读回 5/5      | [Web 证据](web-browser/results.json)、[GM 最新结果](web-browser/gm-results.json)；旧员工报告的 GM not_run 只描述旧轮次                                                                                                                                                                                   |
| Web 回归                       | 14 文件 61/61，类型检查、新增文件lint、build通过                                             | [本轮执行输出摘要](runs/web-outbox-verification.json)：真实临时SQLite/API的outbox关闭/冻结/明确恢复/重复恢复，外部请求0；React静态渲染不等于浏览器点击                                                                                                                                                   |
| Desktop 回归                   | 104/104                                                                                      | [当前日志](runs/desktop-final-pagination-protocol.txt)；含恢复并发与MCP分页协议，不替代原生验收                                                                                                                                                                                                          |
| 真实API分页/协议/附件          | 15/15，fail0；实际HTTP/SQLite分页501评论、101绑定附件且保持内容/归属                         | [完整原始日志](runs/api-pagination-final.txt)；独立临时实例，含采集包附属资源、MCP协议与权限；不是生产大数据或外部执行器验收                                                                                                                                                                             |
| 后续精确授权/删除保护          | scope16/16；最终删除/协议/附件组合17/17                                                      | [scope](runs/api-production-scope-final.txt)、[删除保护](runs/api-delete-guard-final.txt)：第101项目/成员与GM无普通membership精确授权；已删Bug附件metadata/raw/capture/materialize/resources拒绝且存储保留；套件重叠，不相加                                                                             |
| Native安装守卫/时间            | NSIS原始.onInit隔离fixture6/6；.6helper实际UTC验证通过                                       | [安装guard](runs/native-installer-guards.json)只含首建Programs/marker/junction/越界判断，未执行干净用户完整首装；[UTC](runs/native-updater-utc.json)故意无效空配置得到failed、未调用installer，不能计更新成功                                                                                            |
| 冻结源码完整Storage/API/执行器 | 并发修复Storage117/117、API206mjs+33ts=239/239；C#40/40 | [最新Storage117](workflow-concurrency-live/storage-regression.txt)、[最新API239](workflow-concurrency-live/api-regression.txt)、[历史API238](runs/contracts-remediation-api-final.txt)、[历史API184](runs/api-final-lifecycle-source.txt)、[后端证据](backend-components.md)；先前[API175/175](runs/api-final-complete-source.txt)保留历史，重叠轮次不相加 |
| 组件运行生命周期               | 9项真实listener/runtime/SQLite/inflight验证；184历史轮次已有且最新238继续覆盖                | [生命周期说明](component-runtime-lifecycle.md)、[结构化证据](runs/component-runtime-lifecycle.json)：旧实现已有onReady/onClose，修复绑定成功前调度、构造失败清理及并发关闭/drain；不是外部执行器E2E                                                                                                      |
| MCP                            | 服务端/本地核心场景、90 工具目录、Android 真截图资源读回，.4 本地文件/hash 匹配              | [服务端核心](runs/server-mcp-core-2026-09-08T17-52-56-155Z.json)、[本地核心（当时 .3）](runs/desktop-mcp-core-2026-09-08T17-52-57-495Z.json)、[.4 资源](runs/desktop-mcp-resource-preview4.json)                                                                                                         |
| root 常规门禁                  | unit4/4、skeleton1/1、workspace typecheck/lint通过                                           | [unit](runs/root-unit-final-retry.txt)、[skeleton](runs/skeleton-e2e-final-retry.txt)、[该轮typecheck](runs/typecheck-final-all-source.txt)、[该轮lint](runs/lint-final-all-source.txt)；早期失败日志保留                                                                                                |
| root 严格合同基线              | 历史失败已修复；最新test:contract五步全过，原1.0/1.1 baseline/checker保持                    | [失败日志](runs/contracts-final-retry.txt)、[只读审查](contracts-baseline-audit.md)：起点HEAD已有workflow冻结漂移；现以[真实响应修复](contracts-remediation-implementation.md)和[五步成功](runs/contracts-remediation-strict.txt)解决，历史失败不覆盖                                                    |
| 独立合同检查                   | app-first、additive、app-first breaking三项各自通过                                          | [app-first](runs/contracts-app-first.txt)、[additive](runs/contracts-additive.txt)、[breaking app-first](runs/contracts-breaking-app-first.txt)；这是修复前另行执行的历史记录；当前组合五步已另有成功证据                                                                                                |
| Android                        | code22 build、87单测、lint0errors；MuMu21→22升级和原生no_code闭环                            | [最新code22](android-code22-no-code.md)，旧[code21](android-implementation.md)保留；物理设备/真实代码交付/外部组件/更新源未覆盖                                                                                                                                                                          |
| 离线迁移/回退                  | schema 12→14；完整性正常、外键 0；878 附件匹配；58 原业务表指纹不变；另存 schema 12 回退副本 | [迁移演练](migration-rehearsal.md)；原两副本仍paused且未启动，新的第三副本服务读回见下行，不覆盖独立组件目录                                                                                                                                                                                             |
| held迁移副本服务读回           | 26/26，schema14 ready、100 Bug、2评论、1真实附件hash、401/404/hold409；出站0、正常退出0      | [新副本实际HTTP](migration-service-readback.md)、[JSON](migration-service-readback.json)；只补21的HTTP部分实测，不能代表schema12程序或迁移后新增数据回退                                                                                                                                                 |

新增保持冻结状态的迁移副本的真实API服务读回26项通过：固定schema12归档在新的service-readback-8b94d602中恢复并迁移至14，127.0.0.1:51708仅启动该副本API；稳定旧姓名ID登录后读出100 Bug、真实2评论及1附件（3487861字节、SHA-256 73470971577ea3ceb30edf4e8cb713d449a3b6e66c566cac5e897e136566e2ce），匿名401、跨项目404、外部读取hold409均实测。五组件关闭、出站和执行器子进程尝试均0；hold字节和核心业务/outbox指纹保持，原身份记录全部保留。新增的仅是官方独立GM和会话记录；不能称整个数据库字节无变化。进程8532正常exit0且监听关闭，旧migrated/rollback未启动且hash不变。[26项读回](migration-service-readback.md)、[脱敏JSON](migration-service-readback.json)。

该服务使用19:24:26Z冻结的独立编译样本，其已有onReady/onClose并由paused gate阻止调度；它不代替后续监听生命周期9项测试。此结果证明held schema14 API恢复读取，**未证明schema12程序启动、迁移后新增数据的完整回退、生产切换、客户端迁移或独立组件队列/workspace恢复**。归档2021条outbox原本全sent，也不单独证明pending任务冻结。前两次错误测试路由导致的harness失败已保留，不计成功。

## 矩阵和未完成事项

[coverage-matrix.json](coverage-matrix.json) / [Markdown](coverage-matrix.md) 已更新到 **985 条、24基线、193 HTTP路由、109 MCP源码注册行、269 Web控件、106 Android控件**。980是添加Web outbox前的旧计数。运行目录去重90工具，源码保留18工具fallback分别记未测；同名调用不会重复通过。**整项通过的基线为09、10、11、12、15、23、24**；22物理Android仍缺。15按设计列出的HTTP/服务MCP/本地MCP三读取入口及同一PNG归属/hash证据整项通过；其它客户端控件未因此通过。早期HTTP15和服务MCP13核心脚本不等于全部动作；新69请求/140边界独立性实测按设计原文使11/12通过，完整功能仍单独验收。精确入口结果、证明文件hash和剩余缺口见[映射审查](coverage-mapping-review.md)；旧失败、退役项与源码复验标记保留。

仍缺：

1. 独立 Jenkins 实例/Job/构建资源、严格对应每次 buildNumber 的产物地址，最终文件大小、SHA-256 与下载验证。
2. 独立上传平台账号、产品/渠道/测试人、测试/正式解压目录及 COS 相对前缀，真实上传、最终发布与失败恢复。
3. 独立 Relay 实例、projectKey、受限 M2M 凭据、回调认证/地址和真实执行/交付；Relay 完成仍不等于 QA 关闭。
4. 独立轻语项目、测试订单、扫码或专用账号；真实导入、失败重试和外部关闭失败不阻断本地关单的证明。
5. 物理 Android 设备、游戏内 overlay/Poco/文件选择和升级；模拟器不能替代物理设备。
6. 各端剩余页面/动作、版本和幂等负向场景、人工延迟网络、跨设备并发、组件功能对齐和最终原生包验收。
7. 独立组件目录和未完成任务迁移/恢复。归档 2,021 条 outbox 原本全为 sent，不能用于证明 pending 导入任务被 hold 阻止，该门禁另有本机 fixture。

五组件真实外部完整链路仍为 **not_run**，24 基线未全过。没有借生产目标测试，没有把 queued/uncertain/mock 写成成功。

基线15已按设计原文重新核对三种读取并校准适用入口，没有增加not_applicable状态。当前09、10、11、12、15、23、24整项通过，其余功能仍按实际入口分别验收。21已只读定位旧上传queue.sqlite/owner/job/chain、Relay批次及轻语状态；仍缺活queue数量/状态、跨文件一致恢复集、明确项目/版本映射及实际迁移核对；schema12程序启动与新增数据回退不再作为21条件。主库及878附件已固定并通过迁移/held服务26项读回，historical-copy资源状态为partially_verified。

.7仅两个实际按钮新增EXE passed：关闭窗口、状态面板检查更新/安装并重启。window-action(close)、check-update成功、install-update成功、second-instance无深链恢复记为分支passed，复合handler仍not_run；托盘图标点击仍未测。生成/映射脚本本轮仅为持久重放这些证据作有界修改，不改应用源码；保留401个既有复验标记，proof SHA不一致时拒绝且不写矩阵。[映射审查](coverage-mapping-review.md)、[实际重放验证](runs/coverage-criteria-replay.json)。

严格合同的历史失败已在提交09f7150fc1c671d867bbdbc257cab0e61c78d20f修复：五步test:contract全部通过，原1.0/1.1 baseline与checker未重写。六条已注册POST使用冻结响应投影，丰富事实仍可从原三条GET读取。完整API238/238（205mjs+33ts）、Storage109/109、相关Web19/19通过；其中52条响应fixture覆盖八种Accept，不能当作运行实例E2E。[实现与边界](contracts-remediation-implementation.md)、[严格五步](runs/contracts-remediation-strict.txt)、[最终API](runs/contracts-remediation-api-final.txt)。旧1.0 result请求、blocked写入和未注册fail/supersede POST及/bugs/:bugId/workflow GET仍缺，不能据静态门禁宣称完整运行合同。

## 保留的问题和修复历史

早期启动上下文、独立 Cookie、evidence 目录、未使用轻语 singleton 问题已处理；启动日志和身份回执按次保留。早期 http-core-2026-09-08T16-29-27-868Z.json 仅检查 HTTP 200，不能证明 ready，应采用后续检查响应体的运行。

Web 首次附件失败是 JPEG 字节误命名/声明 PNG，服务端正确拒绝；按 JPEG 重传后哈希一致。GM 非成员和短码入口由 schema 14/服务接线修复；项目停用后的刷新误报已在新 Web bundle 实测修复。Android 空 ID、旧成员恢复路径、截图授权入口及离线迁移清单问题均保留修复前后证据，不删除失败样本或覆盖历史事实。

后续真实隔离fixture发现软删除后某些HTTP附件读取仍返回200，原始观测保留在[删除前修复审计](runs/api-soft-deleted-attachment-audit.txt)。该脚本pass只表示观测断言运行成功，**业务门禁在当时是失败**；不能将它作为已删除附件保护通过。修复后17/17日志验证普通附件、capture及MCP资源拒绝而存储证据保留，并统一MCP删除参数键。另修复Relay以100条列表作为授权依据的问题，改为精确授权并实测第101项目/成员。两项均不通过重写旧证据掩盖失败。

先前完整API175/175通过前，第一轮固定时钟fixture与真实server lease时点不一致导致失败；测试已改用真实租约时间并通过，首轮日志保留为[failed-clock-fixture](runs/api-final-complete-source.failed-clock-fixture.txt)。这是已纠正的fixture前置条件，不将它报告为尚未解决的业务失败；严格旧合同基线失败仍另行保留。

安装guard fixture初次将两个测试junction条目留在预览runtime内，触发正式启动器的路径校验拒绝；已按主代理授权仅将链接条目移到runtime外的专用fixture目录，目标/sentinel hash保留，manager只读Status恢复exit0。native6/6结果不变；布局修正和映射保存在[native guard证据](runs/native-installer-guards.json)，矩阵采用修正后的证据hash。

8份MCP证据的嵌套JSON凭据已完成脱敏，原件经hash校验保留于独立runtime私有目录；本轮矩阵读取并重算的是脱敏后的工作树文件，没有读取私有原件。对应新旧hash与规则见[脱敏清单](commit-safety-redaction.json)。提交和归档应保留公开证明与受限私有原件的边界。

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

## 原生旧提交恢复与矩阵实际重放（2026-09-09 08:24 +08:00）

上述准备检查点后，MuMu 上已完成 code22→code23 原位升级和文字旧记录恢复。四次真实201丢回执后，原队列重试耗尽；升级后第一次原生提交只认领旧记录，第二次按原key/body确认同一Bug。冷归档只读核对原操作、完整scope、payload和ID不变，新增一份匹配回执，其他两条旧记录及回执保留。重启后编辑稿仍在；切回原A/AndroidCaptureQA后，旧草稿与原图真实可见且哈希不变。日常APK code14/PID5051与偏好设置未变，4559代理正常退出，4419反向映射已恢复。[真实原生结果](android-code23-recovery-live/65ee5dc8-3f23-4f28-ad97-daa1de8b0ece/README.md)、[独立审计与保留的首次审计失败](android-recovery-proxy-audits/65ee5dc8-first/README.md)。这是模拟器文字恢复及install-r证据，应用内更新、带图未知回执、物理Android和完整基线14/21仍未完成。

实际矩阵生成链先发现备注归档持续增长及新文本框继承旧通过，原失败保留；窄修复已提交 `b62e259`。两轮generate→map→generate共6次执行均成功，语义SHA同为`9682b626eed0074ce98a2dbb0337d46ce462baee4367d052d566f9d0a47c37a6`、差异0。991项/191源码、28退役历史、484复验标记，159条原备注保持；13个新节点均未自动通过。组合回归10/10，613个合成失败结果与进度不提升。[实际成功](coverage-actual-replay-88366a43.json)、[原失败](coverage-actual-replay-4e637e1a-failed.json)。本轮未把映射正确性当业务通过；整项仍只有09、10、11、12、15、23、24。

EXE `.8` 独立打包及41项验包通过，包含Ce9wROrH共享Web；104项desktop测试通过，Ed25519使用原公钥，安装器及旧失败harness记录保留。[打包证明](exe-preview8-package-only/README.md)。该证明时点仍未发布/安装，实际升级另记。Android还发现预览客户端请求preview更新地址而API仅提供stable；独立通道修复正在本工作树验证，尚未部署，也未改生产通道。

## 09:07 +08:00 实际升级与两项修复检查点

EXE 已实际通过应用内入口从 `.7` 升级 `.8`，新PID19500/local MCP4420；原员工/项目、未提交文字及PNG、原closed/v14 Bug和20条处理记录保留。原生按钮、真实updater UTF-16LE回执、签名下载和安装字节闭合；独立前后51/51及59/59、产物复核54/54通过。正常更新退出窗口中保留67文件/11041573字节，明确排除顶层updates，不称完整profile冷备份。首次详情误报和一次控件在屏幕外的工具拒绝均保留。[实际原生过程及限制](exe-preview8-live/1786509a-9de7-4d1a-ba8c-9fb282c9c453/README.md)。六个生产文件哈希、三个生产进程和预览API/Web/serverMCP启动时点在该次独立对照中未变。

Web 坏媒体拒绝后的显式换稿已完成一轮真实验收并提交 `31eca88`，81/81：真实finalize400后Bug POST仍0；人工换稿动作创建新意图，只生成一个Bug、occurrence和有效PNG，旧拒绝记录/坏Blob/quarantine chunk及两条journal跨正常重开保留。[原始证据与root复核](web-rejected-media-recovery-live/README.md)。这是14.Web的部分实测，不替代EXE/APK或未知提交史之后的4xx场景。

Android独立preview更新路由及正式项目鉴权组合修复已提交 `0a00ae2`。初版31/244没有装配真实项目context，独立复审发现匿名更新会401；修正只公开已注册下载模板的GET/HEAD，12/12组合与完整246/246通过，业务/相邻/写路由继续验证权限。原401产品失败和一次测试路径404保留。[组合修正](android-preview-update-routing/auth-hook-correction/README.md)。本检查点仍未部署4419、未发布Android feed；API10036继续旧代码。

详情首帧误报的两行共享Web修复已提交 `bc2b347`：无实际错误显示加载，真实错误仍可重试。真实App首帧/异步选中/失败后重试三项回归和完整102/102通过。[修复证据](web-detail-loading-fix.md)。当前4274和已安装`.8`仍是原Ce9wROrH包，后续`.9`先在独立web-dist构建；不能直接build正在被4274服务的apps/web/dist并将其称为仅打包。矩阵上一轮191源码哈希是历史快照，新源码须重新标为待复验；整项通过仍为7/24，未提升总验收状态。
