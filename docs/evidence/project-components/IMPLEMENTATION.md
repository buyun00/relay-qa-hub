# QA Hub 项目制与组件化 v2.1 实施记录

更新日期：2026-09-09。本记录汇总独立预览实现、实际客户端验收和只读生产快照。业务写入、服务启停和安装均限独立预览或隔离fixture；生产边界按证据核对。**24 项最低基线尚未全部通过，持续目标不能标记 complete。** 编译、mock、目录存在、排队与真实外部完成分别记录。

## 工作树和边界

- 工作树：C:\Users\lin0\.codex\worktrees\7c86\Relay-QA-Hub。
- 分支：codex/project-components-v2-1；起点 62b4495c9b28dc3aea1d5633e870be4e1fdf841f。首个实施提交为3b1371cbbaee4ab31f5861fe3cd72d6ff93c4789；本轮补充包含证据映射/判据校正，合同修复已提交09f7150，Android源已提交1be7724；本轮源码清单按最终内容冻结。
- 依据：完整读取 docs/design/project-components-transformation-2026-09-08.md v2.1，包含第 16、17 节；适用 C:\Users\lin0\.codex\AGENTS.md 和本任务生产隔离约束。
- 不合并 main、不推送生产分支、不发布或重启生产，不覆盖日常 EXE/APK，不清理已有草稿、附件、备份或任务。旧运维脚本中的生产路径和默认回退不能直接用于预览。
- 本工作树独立 npm 依赖已在前期安装；源码、运行目录、客户端身份、Cookie 和更新通道与日常实例分开。

设计文档只读复制来源和当时校验值保留如下；源文件未修改。

| 源文件 | SHA-256 |
| --- | --- |
| D:\Relay-QA-Hub\docs\design\project-components-transformation-2026-09-08.md | 8DABD8C8542F33659579BB0692A5831EF902ABF710941655779513548C21AF42 |
| D:\Relay-QA-Hub\docs\design\QA-Hub-项目制与组件化改造方案-v2.1-2026-09-09.docx | 18EB69F2507FE586D4E7438988BB16246BC410129C9319E876D2970080326B36 |

## 当前实现与运行基线

独立配置为 C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\instance.json。API 4419、Web/下载 4274、服务端 MCP 4421、本地 EXE MCP 4420。操作方法见 [preview-operations.md](preview-operations.md)。

已有真实管理和GM项目读回确认 API ready / schema **14**，database、evidence、worker均正常。最新API为PID18644（2026-09-08T20:39:13.7225210Z），实际HTTP读回ready/schema14；Web PID20284、MCP转发PID15736为此前回执。实际验证见最新frozen-workflow-live-readback；这些历史PID仍不能替代操作前身份核对。提交前已只读重新核对生产，结果见下一段。[GM就绪读回](runs/server-mcp-gm-project-live.json)、[生产盘点](production-inventory.md)、[生产留存读回](runs/production-after-preview5.json)。

此前提交前只读生产快照为2026-09-08T19:30:39Z：六个文件hash、三个原PID/启动时点均与19:02:22Z一致，4319 ready/schema12，4174的Windows 3.3.5公开manifest原字节hash一致；日常APK code14/PID5051/安装时点保留，预览APK code21仍在。未读取配置正文或凭据，未启停任何应用，未重新验签。日期比较曾因PowerShell隐式转换丢失小数精度误报，已按原始UTC字符串100ns精度更正并保留说明。[提交前生产快照](runs/production-pre-commit.json)。

此前.7升级后生产只读核对为2026-09-08T19:55:31.6095789Z：六文件hash、三个原PID及精确启动时点不变，4319 ready/schema12，4174 Windows3.3.5 manifest原字节SHA不变。日常EXE可读路径相同；两个Node的路径仍为null，不能视为新增可执行路径验证。本轮未重新查询Android，APK状态仍引用19:30快照；未读配置正文/凭据或修改生产。[.7后生产快照](runs/production-after-preview7.json)。

| 范围 | 已落实行为 | 证据和边界 |
| --- | --- | --- |
| 项目与身份 | UUID/大小写不敏感短码入口、姓名登录、稳定人员 ID、所属项目列表；显式撤销后同名登录不能恢复；成员和身份关联按项目隔离 | [后端基础](backend-foundation.md)，持久管理 96/96 |
| GM | 独立口令加服务端唯一 UUID/account；每个 worker 消息固定最小项目授权，事务内清除或回滚；普通目录显示真实 membership | [GM 授权](gm-authorization.md)；非成员 GM Bug 实际 closed / v12 |
| 基础 Bug | 组件全关时创建、处理、人工完成、验收退回、再次完成和关闭，不等待 Relay 或第三方 | 基线09的 APK/EXE/Web/HTTP/serverMCP/localMCP 各有独立实际闭环；不推定各端其余动作全部通过 |
| Web | 请求固定 service/project/user 与项目头；取消旧请求；项目草稿/人员/File 持久化；撤权导出；GM 管理；全关时本地历史可读；新增 Relay outbox 暂停原因及范围确认恢复，保留原批次恢复 | [员工浏览](web-browser/results.md)、[双标签恢复](web-browser/dual-window-results.md)、[GM 浏览](web-browser/gm-results.md)、[outbox本地验证](runs/web-outbox-verification.json)；有数据的浏览器恢复点击未测 |
| 组件后端 | 五组件默认关闭；配置 CAS/依赖/公开白名单；任务固定项目/版本/人员及凭据摘要；暂停与显式恢复；导入 hold；Relay outbox 精确认领 | [组件后端](backend-components.md)、[运行合同](component-runtime.md)；外部完整链路未运行 |
| C# uploader | 0.5.0 独立执行器，显式来源/目标/项目/版本，独立鉴权和锁路径，拒绝生产默认回退 | 自检 40/40，包含本机 SDK 回环和 supervisor；realPlatformTested:false |
| MCP | 服务端与 EXE 共用 HTTP 业务映射，运行目录 90 工具；真实附件 materialize/read/resources 与 SHA-256 证据 | [目录](mcp-runtime-catalog.json)、[服务端资源](runs/server-mcp-real-resource-20260909.json)、[EXE .4 资源](runs/desktop-mcp-resource-preview4.json)；目录不是逐工具通过 |
| 通知 | Web 通知 WebSocket 代理保留项目 Cookie，API 检查认证 | [真实代理](runs/websocket-real-proxy.json)：认证 101、匿名 401 |

## 已发布和安装版本

**Windows 0.2.0-preview.7 已完成独立发布和实际6→7原生升级验收。** releaseId为20260908T194425490Z，108378668字节，SHA-256 fbf0656285474e2b4d521178cb9107dd26d3426dd463b9198fc21b239e02152a。公开回执sourceCommit为3b1371cbbaee4ab31f5861fe3cd72d6ff93c4789、sourceDirty:false；文档更新只读核对receipt及主代理实际原生升级proof；未额外操作安装或验签。回执位置：C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\packages\20260908T194425490Z\receipt.json。此包已含首装guard及提交内源码，升级passed依据下述实际proof。

.6→.7已通过原生“检查更新→安装并重启”实际完成，proof观测时点2026-09-08T19:54:02.443Z；当前已安装nativeVersion0.2.0.7、主PID11368。原员工/项目A、文字+1张PNG草稿和配置SHA保持，原Bug13 closed/v14、评论及184872字节原附件materialize/hash读回通过；旧更新结果及7份backup目录保留。新helper的成功result时间19:52:36Z位于真实原生点击区间，UTC已在本次成功更新中核对。[.7升级proof](runs/exe-after-preview7-upgrade.json)、[原生恢复](runs/exe-preview7-restored-draft.txt)。19:54:30Z本地4420与服务4421实际目录均为相同90工具、协议2025-06-18，不支持的协议头均400；此项只证明目录/协议，不能称90个业务工具全部通过。[双入口协议](runs/exe-preview7-live-protocol.json)。

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

| 验证 | 结果 | 实际范围 |
| --- | --- | --- |
| 持久 HTTP 管理 | 96/96；GM 非成员完整人工闭环；配置见证器 0 出站 | [运行 JSON](runs/management-2026-09-08T17-53-20-441Z.json)，仅所列场景 |
| Web 浏览 | 员工 closed/v13；JPEG 下载匹配；A/B 草稿切换/刷新、双标签撤权导出恢复；GM 6/6、读回 5/5 | [Web 证据](web-browser/results.json)、[GM 最新结果](web-browser/gm-results.json)；旧员工报告的 GM not_run 只描述旧轮次 |
| Web 回归 | 14 文件 61/61，类型检查、新增文件lint、build通过 | [本轮执行输出摘要](runs/web-outbox-verification.json)：真实临时SQLite/API的outbox关闭/冻结/明确恢复/重复恢复，外部请求0；React静态渲染不等于浏览器点击 |
| Desktop 回归 | 104/104 | [当前日志](runs/desktop-final-pagination-protocol.txt)；含恢复并发与MCP分页协议，不替代原生验收 |
| 真实API分页/协议/附件 | 15/15，fail0；实际HTTP/SQLite分页501评论、101绑定附件且保持内容/归属 | [完整原始日志](runs/api-pagination-final.txt)；独立临时实例，含采集包附属资源、MCP协议与权限；不是生产大数据或外部执行器验收 |
| 后续精确授权/删除保护 | scope16/16；最终删除/协议/附件组合17/17 | [scope](runs/api-production-scope-final.txt)、[删除保护](runs/api-delete-guard-final.txt)：第101项目/成员与GM无普通membership精确授权；已删Bug附件metadata/raw/capture/materialize/resources拒绝且存储保留；套件重叠，不相加 |
| Native安装守卫/时间 | NSIS原始.onInit隔离fixture6/6；.6helper实际UTC验证通过 | [安装guard](runs/native-installer-guards.json)只含首建Programs/marker/junction/越界判断，未执行干净用户完整首装；[UTC](runs/native-updater-utc.json)故意无效空配置得到failed、未调用installer，不能计更新成功 |
| 冻结源码完整Storage/API/执行器 | 最新Storage109/109、API205mjs+33ts=238/238；C#40/40 | [最新Storage](runs/contracts-remediation-storage.txt)、[最新API238](runs/contracts-remediation-api-final.txt)、[历史API184](runs/api-final-lifecycle-source.txt)、[后端证据](backend-components.md)；先前[API175/175](runs/api-final-complete-source.txt)保留历史，上表15/16/17与175均为重叠轮次，不相加 |
| 组件运行生命周期 | 9项真实listener/runtime/SQLite/inflight验证；184历史轮次已有且最新238继续覆盖 | [生命周期说明](component-runtime-lifecycle.md)、[结构化证据](runs/component-runtime-lifecycle.json)：旧实现已有onReady/onClose，修复绑定成功前调度、构造失败清理及并发关闭/drain；不是外部执行器E2E |
| MCP | 服务端/本地核心场景、90 工具目录、Android 真截图资源读回，.4 本地文件/hash 匹配 | [服务端核心](runs/server-mcp-core-2026-09-08T17-52-56-155Z.json)、[本地核心（当时 .3）](runs/desktop-mcp-core-2026-09-08T17-52-57-495Z.json)、[.4 资源](runs/desktop-mcp-resource-preview4.json) |
| root 常规门禁 | unit4/4、skeleton1/1、workspace typecheck/lint通过 | [unit](runs/root-unit-final-retry.txt)、[skeleton](runs/skeleton-e2e-final-retry.txt)、[该轮typecheck](runs/typecheck-final-all-source.txt)、[该轮lint](runs/lint-final-all-source.txt)；早期失败日志保留 |
| root 严格合同基线 | 历史失败已修复；最新test:contract五步全过，原1.0/1.1 baseline/checker保持 | [失败日志](runs/contracts-final-retry.txt)、[只读审查](contracts-baseline-audit.md)：起点HEAD已有workflow冻结漂移；现以[真实响应修复](contracts-remediation-implementation.md)和[五步成功](runs/contracts-remediation-strict.txt)解决，历史失败不覆盖 |
| 独立合同检查 | app-first、additive、app-first breaking三项各自通过 | [app-first](runs/contracts-app-first.txt)、[additive](runs/contracts-additive.txt)、[breaking app-first](runs/contracts-breaking-app-first.txt)；这是修复前另行执行的历史记录；当前组合五步已另有成功证据 |
| Android | code22 build、87单测、lint0errors；MuMu21→22升级和原生no_code闭环 | [最新code22](android-code22-no-code.md)，旧[code21](android-implementation.md)保留；物理设备/真实代码交付/外部组件/更新源未覆盖 |
| 离线迁移/回退 | schema 12→14；完整性正常、外键 0；878 附件匹配；58 原业务表指纹不变；另存 schema 12 回退副本 | [迁移演练](migration-rehearsal.md)；原两副本仍paused且未启动，新的第三副本服务读回见下行，不覆盖独立组件目录 |
| held迁移副本服务读回 | 26/26，schema14 ready、100 Bug、2评论、1真实附件hash、401/404/hold409；出站0、正常退出0 | [新副本实际HTTP](migration-service-readback.md)、[JSON](migration-service-readback.json)；只补21的HTTP部分实测，不能代表schema12程序或迁移后新增数据回退 |

新增保持冻结状态的迁移副本的真实API服务读回26项通过：固定schema12归档在新的service-readback-8b94d602中恢复并迁移至14，127.0.0.1:51708仅启动该副本API；稳定旧姓名ID登录后读出100 Bug、真实2评论及1附件（3487861字节、SHA-256 73470971577ea3ceb30edf4e8cb713d449a3b6e66c566cac5e897e136566e2ce），匿名401、跨项目404、外部读取hold409均实测。五组件关闭、出站和执行器子进程尝试均0；hold字节和核心业务/outbox指纹保持，原身份记录全部保留。新增的仅是官方独立GM和会话记录；不能称整个数据库字节无变化。进程8532正常exit0且监听关闭，旧migrated/rollback未启动且hash不变。[26项读回](migration-service-readback.md)、[脱敏JSON](migration-service-readback.json)。

该服务使用19:24:26Z冻结的独立编译样本，其已有onReady/onClose并由paused gate阻止调度；它不代替后续监听生命周期9项测试。此结果证明held schema14 API恢复读取，**未证明schema12程序启动、迁移后新增数据的完整回退、生产切换、客户端迁移或独立组件队列/workspace恢复**。归档2021条outbox原本全sent，也不单独证明pending任务冻结。前两次错误测试路由导致的harness失败已保留，不计成功。

## 矩阵和未完成事项

[coverage-matrix.json](coverage-matrix.json) / [Markdown](coverage-matrix.md) 已更新到 **985 条、24基线、193 HTTP路由、109 MCP源码注册行、269 Web控件、106 Android控件**。980是添加Web outbox前的旧计数。运行目录去重90工具，源码保留18工具fallback分别记未测；同名调用不会重复通过。**整项通过的基线为09、15、23、24**；22物理Android仍缺。15按设计列出的HTTP/服务MCP/本地MCP三读取入口及同一PNG归属/hash证据整项通过；其它客户端控件未因此通过。HTTP15和服务MCP13核心脚本不等于全部动作，11/12仍为部分实测。精确入口结果、证明文件hash和剩余缺口见[映射审查](coverage-mapping-review.md)；旧失败、退役项与源码复验标记保留。

仍缺：

1. 独立 Jenkins 实例/Job/构建资源、严格对应每次 buildNumber 的产物地址，最终文件大小、SHA-256 与下载验证。
2. 独立上传平台账号、产品/渠道/测试人、测试/正式解压目录及 COS 相对前缀，真实上传、最终发布与失败恢复。
3. 独立 Relay 实例、projectKey、受限 M2M 凭据、回调认证/地址和真实执行/交付；Relay 完成仍不等于 QA 关闭。
4. 独立轻语项目、测试订单、扫码或专用账号；真实导入、失败重试和外部关闭失败不阻断本地关单的证明。
5. 物理 Android 设备、游戏内 overlay/Poco/文件选择和升级；模拟器不能替代物理设备。
6. 各端剩余页面/动作、版本和幂等负向场景、人工延迟网络、跨设备并发、组件功能对齐和最终原生包验收。
7. 独立组件目录和未完成任务迁移/恢复。归档 2,021 条 outbox 原本全为 sent，不能用于证明 pending 导入任务被 hold 阻止，该门禁另有本机 fixture。

五组件真实外部完整链路仍为 **not_run**，24 基线未全过。没有借生产目标测试，没有把 queued/uncertain/mock 写成成功。

基线15已按设计原文重新核对三种读取并校准适用入口，没有增加not_applicable状态。当前09、15、23、24整项通过，其余功能仍按实际入口分别验收。21的缺口是主库归档以外的旧上传queue.sqlite/owner/workspace/job、Relay批次/state及轻语状态的未完成任务完整清单和迁移核对；schema12程序启动与新增数据回退不再作为21条件。主库及878附件已固定并通过迁移/held服务26项读回，historical-copy资源状态为partially_verified。

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

本轮按最终冻结源码重新盘点：188个源码文件、985细目，保留既有人工结果、负向备注与needsRevalidation；09、15、23、24整项通过，其余基线和独立功能仍按实际缺口验收。

## 最终API、Android与生产读回

最终dist已在独立API PID18644加载，启动时点2026-09-08T20:39:13.7225210Z，4419 ready/schema14。root实际31个HTTP调用通过：六条冻结POST的vendor/JSON输出、同幂等请求切换媒体重放、丰富历史读取及跨项目404；另核对14个媒体头与原EXE Bug closed/v14、评论及184872字节附件hash。[31次实际请求](runs/frozen-workflow-live-2026-09-08T20-40-57-088Z.json)、[媒体/旧业务读回](runs/frozen-workflow-live-readback.json)。请求均使用1.1；没有以此补齐旧1.0请求、未注册路由或全部HTTP/MCP对等。

Android最新实际安装为com.relayqahub.android.preview.debug，code22 / 0.2.0-preview.8，MuMu中21→22覆盖升级与原生开始→无需代码提交→验收通过关闭完成。Bug386cdd2f-44c9-4a79-992a-891d595766fd closed/v6；49条对应HTTP均2xx，deliver1次、complete0次，87单测通过，lint0errors/29warnings。原有草稿/PNG/sidecar三hash、日常code14/PID5051/安装时间及四配置hash保留。Bug由API准备，后续状态写入来自原生按钮。修复文件BugLifecycleClient.kt由本目标3b1371c新增，62b起点不存在，不能描述为旧基线故障。[code22原生记录](android-code22-no-code.md)、[机器证据](android-code22-no-code.json)。真实物理设备、真实代码分支交付及外部组件仍not_run。

当前固定APK为C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/android-code22-acceptance/qa-hub-preview-code22.apk，35,471,405 bytes，SHA-256 733088b8f876c41ce767627c6de8dfe12e00803c0b61ff13c6facd3b8982d777。code21原包保留为同目录retained-code21.apk，SHA-256 d783e9908e7dacdd660565cf15e1624c567a820e973d01190a38a0981afe7255。本次使用相同debug签名的adb install-r，不声称应用内签名更新源/自升级通过。EXE最新成功包仍为.7，不能把Android .8版本当作EXE新包。

最新生产只读核对为2026-09-08T20:49:45.0734634Z：相对19:55快照，六文件hash、三个原PID精确启动时点及可见日常EXE路径保持，4319 ready/schema12，4174 Windows3.3.5 manifest原字节hash不变。两个Node的可执行路径仍null，没有新增路径证明；未重新验签/下载生产安装包。Android引用code22证据20:46:37.419Z的daily14/PID5051/配置保留，root未重复ADB查询。[最新生产只读证据](runs/production-after-api-fix-code22.json)。

code22同一已验收APK已发布为不可变预览下载：[下载Android code22 / preview.8](http://127.0.0.1:4274/downloads/qa-hub-preview-7c86-android-0.2.0-preview.8-code22.apk)。完整HTTP下载35,471,405字节、SHA-256 733088b8f876c41ce767627c6de8dfe12e00803c0b61ff13c6facd3b8982d777，实例响应头/类型匹配，Windows manifest未变。Android源内容与提交1be772469671d75cbb5e31240bf345dcc7c4a267一致，APK构建发生在提交之前；本次发布没有重新构建或安装。回执不是签名更新manifest，不能记为应用内自升级或物理设备通过。[下载发布证据](runs/android-code22-download-publication.json)。

本轮冻结盘点锚点为81e70d43638f3cb2f3dbd3994acd46f413e5364e，其中API兼容源码提交09f7150、Android源码提交1be7724；188个源码文件hash逐一匹配，985条细目、21条退役历史保留。连续生成器→mapper→生成器重放的语义hash一致；错误proof hash在任何写入前拒绝（0写入），人工负向结果和item/manual复验、sourceHash标记均保留，既有needsRevalidation零丢失。审计结果见coverage-matrix.json的evidenceMapping.finalReplayVerification。
