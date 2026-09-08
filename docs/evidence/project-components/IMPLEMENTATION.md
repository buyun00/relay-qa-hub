# QA Hub 项目制与组件化 v2.1 实施记录

更新日期：2026-09-09。本记录汇总独立预览实现、实际客户端验收和只读生产快照。业务写入、服务启停和安装均限独立预览或隔离fixture；生产边界按证据核对。**24 项最低基线尚未全部通过，持续目标不能标记 complete。** 编译、mock、目录存在、排队与真实外部完成分别记录。

## 工作树和边界

- 工作树：C:\Users\lin0\.codex\worktrees\7c86\Relay-QA-Hub。
- 分支：codex/project-components-v2-1；起点 62b4495c9b28dc3aea1d5633e870be4e1fdf841f。
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

已有真实管理和GM项目读回确认 API ready / schema **14**，database、evidence、worker均正常。最新公开进程回执为 API PID17912（2026-09-08T19:37:04.0646720Z）、Web PID20284、MCP转发PID15736；主代理报告本次API重启后ready。本次仅核对预览进程回执，没有重新探测预览API；回执不能替代每次操作前的身份与就绪检查。提交前已只读重新核对生产，结果见下一段。[GM就绪读回](runs/server-mcp-gm-project-live.json)、[生产盘点](production-inventory.md)、[生产留存读回](runs/production-after-preview5.json)。

最新只读生产快照为2026-09-08T19:30:39Z：六个文件hash、三个原PID/启动时点均与19:02:22Z一致，4319 ready/schema12，4174的Windows 3.3.5公开manifest原字节hash一致；日常APK code14/PID5051/安装时点保留，预览APK code21仍在。未读取配置正文或凭据，未启停任何应用，未重新验签。日期比较曾因PowerShell隐式转换丢失小数精度误报，已按原始UTC字符串100ns精度更正并保留说明。[提交前生产快照](runs/production-pre-commit.json)。

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

**Windows 最新已发布、实际升级并原生恢复的是0.2.0-preview.6。** releaseId为20260908T185123338Z，108378454字节、SHA-256 989b9c9c7ddd51310c5d2a5dc94b5875643d50c769e42a1f84d2d4cb7bc281f1，安装目录%LOCALAPPDATA%\Programs\RelayQaHubPreview。18:58:33Z的实际proof确认installed，原项目/人员/配置hash不变，原生文字+1张PNG草稿恢复；五份旧安装backup保留，.5旧update-result按原hash完整归档。[.6升级读回](runs/exe-after-preview6-upgrade.json)、[.6恢复界面](runs/exe-preview6-restored-draft.txt)。此次由.5复制的旧helper仍把本地时间误标Z，以proof.observedAt为准；.6修正helper后来经独立故意失败用例验证UTC，见下表；不追加更新成功。此前.4/.5共存与历史读回仍保留，[.5升级](runs/exe-after-preview5-upgrade.json)、[生产留存核对](runs/production-after-preview5.json)。.6→.5回退、重复升级及卸载同包重装随后均已实测，详见下段。

.5 原生 UI 真实创建含保留PNG的 Bug、指定当前员工、开始处理、人工完成、验收失败退回、再次完成、验收通过，Bug TA1788885078625-13 closed/v13；随后原生编辑描述并保存至 closed/v14，提交并读回1条评论。原184872字节PNG hash未变。[闭环](runs/exe-ui-bug-closed-readback.json)、[编辑评论](runs/exe-ui-edit-comment-readback.json)。另建测试Bug TA1788885078625-14，原生确认软删除后列表消失、MCP上下文/附件拒绝；只读SQLite仍保留Bug及删除actor/version/幂等审计，原Bug13保持closed/v14。[删除读回](runs/exe-ui-delete-readback.json)、[保留审计](runs/exe-ui-delete-retained-storage.json)。发布包含未提交工作树；commit不足以确认所有后续源码已入包。最新独立Web build index-CUjaBP8S.js已含outbox UI，不能据此推定.5内嵌Web同步；后续包与原生UI由主代理处理。

后续19:01:28Z已实际手工回退.6→.5：旧backup继续保留，整个.6目录另存为.rollback-retained-20260908T1901Z，profile未改；原生同员工/项目/文字+图恢复，Bug13仍closed/v14且原评论/附件hash保留。19:02:22Z生产六文件hash、三个原进程/启动时点及ready/schema12不变。[手工回退](runs/exe-preview6-to5-rollback.json)、[业务保留](runs/exe-rollback5-business-readback.json)、[生产核对](runs/production-after-preview6-rollback.json)。

随后重复升级.6成功，原.backup-release与新增-1备份同时存在，原生草稿恢复。实际卸载.6时整个安装转存.uninstalled-release，profile的102文件/663514299字节逐一hash完全不变；之后使用精确相同.6包重装成功，原员工A/配置/文字+1图恢复，原closed/v14、1评论和附件hash读回。[重复升级](runs/exe-preview6-repeat-upgrade.json)、[卸载保留](runs/exe-preview6-uninstall-readback.json)、[同包重装](runs/exe-preview6-after-uninstall-reinstall.json)。**24仅EXE客户端范围passed，完整服务数据与APK回退仍not_run，24整项未通过。** 当前最后成功安装版本为.6；.7拟包含首装guard修正，尚未发布/原生验收。

**Android 当前为 com.relayqahub.android.preview.debug，0.2.0-preview.7 / versionCode 21。** 与日常包分离；15→21 预览升级、手工闭环、截图/附件和人员管理有 MuMu Android 15 模拟器证据。20→21实际恢复原项目/身份/文字和未提交PNG，drafts/sidecar/PNG三份hash不变；code21本地批次/交接/禁用远端三个tab实际可达，前两者为空列表，未操作有数据的恢复或merge。日常code14/PID5051/安装时点/dataDir不变。**没有物理Android设备证据**；基线22保持not_run，ADB更新不是签名更新源和应用内自升级通过。[Android完整记录](android-implementation.md)。

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
| 冻结源码完整Storage/API/执行器 | Storage109/109；最新API MJS151+TS33=184/184；C#40/40 | [Storage](runs/storage-final-complete-source.txt)、[生命周期修复后最新API](runs/api-final-lifecycle-source.txt)、[后端证据](backend-components.md)；先前[API175/175](runs/api-final-complete-source.txt)保留历史，上表15/16/17与175均为重叠轮次，不相加 |
| 组件运行生命周期 | 9项真实listener/runtime/SQLite/inflight验证；纳入最新184 | [生命周期说明](component-runtime-lifecycle.md)、[结构化证据](runs/component-runtime-lifecycle.json)：旧实现已有onReady/onClose，修复绑定成功前调度、构造失败清理及并发关闭/drain；不是外部执行器E2E |
| MCP | 服务端/本地核心场景、90 工具目录、Android 真截图资源读回，.4 本地文件/hash 匹配 | [服务端核心](runs/server-mcp-core-2026-09-08T17-52-56-155Z.json)、[本地核心（当时 .3）](runs/desktop-mcp-core-2026-09-08T17-52-57-495Z.json)、[.4 资源](runs/desktop-mcp-resource-preview4.json) |
| root 常规门禁 | unit4/4、skeleton1/1、workspace typecheck/lint通过 | [unit](runs/root-unit-final-retry.txt)、[skeleton](runs/skeleton-e2e-final-retry.txt)、[最新typecheck](runs/typecheck-final-all-source.txt)、[最新lint](runs/lint-final-all-source.txt)；早期失败日志保留 |
| root 严格合同基线 | check:contracts通过，check:contract-breaking仍failed，组合test:contract未通过 | [失败日志](runs/contracts-final-retry.txt)、[只读审查](contracts-baseline-audit.md)：起点HEAD已有workflow冻结漂移；未重写baseline，不能豁免为成功 |
| 独立合同检查 | app-first、additive、app-first breaking三项各自通过 | [app-first](runs/contracts-app-first.txt)、[additive](runs/contracts-additive.txt)、[breaking app-first](runs/contracts-breaking-app-first.txt)；这是另行执行，不代表前述组合门禁通过 |
| Android | code21 assembleDebug/testDebugUnitTest/lintDebug通过；80测试无失败；模拟器安装与交互 | [Android 证据](android-implementation.md)，物理设备/有数据恢复merge/完整组件/更新源未覆盖 |
| 离线迁移/回退 | schema 12→14；完整性正常、外键 0；878 附件匹配；58 原业务表指纹不变；另存 schema 12 回退副本 | [迁移演练](migration-rehearsal.md)；两副本仍 paused，未启动 API/执行器，不覆盖独立组件目录 |

## 矩阵和未完成事项

[coverage-matrix.json](coverage-matrix.json) / [Markdown](coverage-matrix.md) 已更新到 **985 条、24基线、193 HTTP路由、109 MCP源码注册行、269 Web控件、106 Android控件**。980是添加Web outbox前的旧计数。运行目录去重90工具，源码保留18工具fallback分别记未测；同名调用不会重复通过。**整项通过的基线只有09与23**；22物理Android仍缺。15仅HTTP/服务MCP/本地MCP三读取入口有同一PNG hash证据。HTTP15和服务MCP13核心脚本不等于全部动作，11/12仍为部分实测。精确入口结果、证明文件hash和剩余缺口见[映射审查](coverage-mapping-review.md)；旧失败、退役项与源码复验标记保留。

仍缺：

1. 独立 Jenkins 实例/Job/构建资源、严格对应每次 buildNumber 的产物地址，最终文件大小、SHA-256 与下载验证。
2. 独立上传平台账号、产品/渠道/测试人、测试/正式解压目录及 COS 相对前缀，真实上传、最终发布与失败恢复。
3. 独立 Relay 实例、projectKey、受限 M2M 凭据、回调认证/地址和真实执行/交付；Relay 完成仍不等于 QA 关闭。
4. 独立轻语项目、测试订单、扫码或专用账号；真实导入、失败重试和外部关闭失败不阻断本地关单的证明。
5. 物理 Android 设备、游戏内 overlay/Poco/文件选择和升级；模拟器不能替代物理设备。
6. 各端剩余页面/动作、版本和幂等负向场景、人工延迟网络、跨设备并发、组件功能对齐和最终原生包验收。
7. 独立组件目录和未完成任务迁移/恢复。归档 2,021 条 outbox 原本全为 sent，不能用于证明 pending 导入任务被 hold 阻止，该门禁另有本机 fixture。

五组件真实外部完整链路仍为 **not_run**，24 基线未全过。没有借生产目标测试，没有把 queued/uncertain/mock 写成成功。

## 保留的问题和修复历史

早期启动上下文、独立 Cookie、evidence 目录、未使用轻语 singleton 问题已处理；启动日志和身份回执按次保留。早期 http-core-2026-09-08T16-29-27-868Z.json 仅检查 HTTP 200，不能证明 ready，应采用后续检查响应体的运行。

Web 首次附件失败是 JPEG 字节误命名/声明 PNG，服务端正确拒绝；按 JPEG 重传后哈希一致。GM 非成员和短码入口由 schema 14/服务接线修复；项目停用后的刷新误报已在新 Web bundle 实测修复。Android 空 ID、旧成员恢复路径、截图授权入口及离线迁移清单问题均保留修复前后证据，不删除失败样本或覆盖历史事实。

后续真实隔离fixture发现软删除后某些HTTP附件读取仍返回200，原始观测保留在[删除前修复审计](runs/api-soft-deleted-attachment-audit.txt)。该脚本pass只表示观测断言运行成功，**业务门禁在当时是失败**；不能将它作为已删除附件保护通过。修复后17/17日志验证普通附件、capture及MCP资源拒绝而存储证据保留，并统一MCP删除参数键。另修复Relay以100条列表作为授权依据的问题，改为精确授权并实测第101项目/成员。两项均不通过重写旧证据掩盖失败。

先前完整API175/175通过前，第一轮固定时钟fixture与真实server lease时点不一致导致失败；测试已改用真实租约时间并通过，首轮日志保留为[failed-clock-fixture](runs/api-final-complete-source.failed-clock-fixture.txt)。这是已纠正的fixture前置条件，不将它报告为尚未解决的业务失败；严格旧合同基线失败仍另行保留。

安装guard fixture初次将两个测试junction条目留在预览runtime内，触发正式启动器的路径校验拒绝；已按主代理授权仅将链接条目移到runtime外的专用fixture目录，目标/sentinel hash保留，manager只读Status恢复exit0。native6/6结果不变；布局修正和映射保存在[native guard证据](runs/native-installer-guards.json)，矩阵采用修正后的证据hash。

8份MCP证据的嵌套JSON凭据已完成脱敏，原件经hash校验保留于独立runtime私有目录；本轮矩阵读取并重算的是脱敏后的工作树文件，没有读取私有原件。对应新旧hash与规则见[脱敏清单](commit-safety-redaction.json)。提交和归档应保留公开证明与受限私有原件的边界。
