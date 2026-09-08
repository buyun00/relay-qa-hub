# 实测证据映射审查

生成时点：2026-09-08T20:57:13.490Z。只读已有证据，没有操作 UI、API 或生产。

`passed` 只代表该行明确注明的实际入口与输入。细目控件/路由通过不代表全部负向分支或上层基线通过；HTTP 15项、MCP 13项不称全部动作。未使用源码存在、共享实现、编译、单元或外部合同 fixture 代替真实外部执行。

## 24 项基线校准

| 场景 | APK | EXE | Web | HTTP API | server MCP | local MCP |
| --- | --- | --- | --- | --- | --- | --- |
| 01 项目入口姓名登录 | not_run（部分实测） | not_run（部分实测） | passed | passed | not_run（部分实测） | not_run（部分实测） |
| 02 单项目和多项目人员 | not_run（部分实测） | not_run | passed | passed | not_run（部分实测） | not_run（部分实测） |
| 03 唯一 GM | not_run | not_run | not_run | passed | not_run | not_run |
| 04 项目人员停用 | not_run（部分实测） | not_run | not_run | passed | not_run | not_run |
| 05 非所属项目读取 | not_run | not_run | not_run | not_run | not_run | not_run |
| 06 写入归属 | not_run | not_run | not_run | not_run | not_run | not_run |
| 07 项目快速切换 | not_run（部分实测） | not_run（部分实测） | not_run | — | — | — |
| 08 多窗口和多客户端 | not_run | not_run | passed | not_run | not_run | not_run |
| 09 关闭所有组件的基础全流程 | passed | passed | passed | passed | passed | passed |
| 10 项目人员管理一致 | passed | not_run | not_run | passed | not_run | not_run |
| 11 HTTP API 独立使用 | — | — | — | not_run（部分实测） | — | — |
| 12 服务端 MCP 独立使用 | — | — | — | — | not_run（部分实测） | — |
| 13 HTTP/MCP 对等 | — | — | — | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） |
| 14 并发和重复提交 | not_run | not_run | not_run | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） |
| 15 附件三种读取 | — | — | — | passed | passed | passed |
| 16 项目组件开关 | not_run | not_run | not_run | not_run（部分实测） | not_run | not_run |
| 17 组件依赖和缺配置 | not_run | not_run | not_run | not_run（部分实测） | not_run | not_run |
| 18 运行中停用组件 | not_run（部分实测） | not_run | not_run（部分实测） | not_run | not_run | not_run |
| 19 上传和 Relay 项目归属 | not_run（部分实测） | not_run | not_run | not_run | not_run | not_run |
| 20 外部失败与人工处理 | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） |
| 21 旧数据副本迁移 | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） |
| 22 APK 共存与升级 | not_run（部分实测） | — | — | — | — | — |
| 23 EXE 共存与升级 | — | passed | — | — | — | — |
| 24 回退演练 | — | — | — | passed | — | — |

09按六个实际入口分别闭环；15严格按设计列出的HTTP下载、远端MCP资源、本地MCP落盘三个入口判定，三者有同一PNG归属和hash证据。23已有实际EXE升级恢复proof。24按设计13/24与10.3的服务恢复要求，由独立HTTP回退/保留/恢复证据判定；先前要求六入口各自降级超出该基线原文。EXE既有客户端恢复证据独立保留，其它APK/EXE/Web/MCP功能控件仍各自验收。22仍缺物理Android及适用的设备取证、文件和升级验证。

## 部分实测及剩余缺口

- 01 项目入口姓名登录 / APK：已测 实际项目A姓名登录、进入B、回A，code20恢复同一身份与A列表。仍缺 尚未逐一核对该基线完整首登/原历史姓名/有效成员目录组合；物理Android设备未测。
- 01 项目入口姓名登录 / EXE：已测 .6原生退出清除磁盘身份且本地MCP拒绝，local MCP登录成功响应时身份已落盘；原生重登同人同项目恢复原文字+1图。。仍缺 完整首次成员登记/已有姓名稳定ID/多项目入口组合未全部覆盖；该序列未强停进程。。
- 01 项目入口姓名登录 / server MCP：已测 实际项目姓名登录与项目目录、后续操作人读回。仍缺 完整首次成员登记/已有姓名稳定ID/多项目组合未逐项覆盖。
- 01 项目入口姓名登录 / local MCP：已测 实际项目姓名登录与项目目录、后续操作人读回。仍缺 完整首次成员登记/已有姓名稳定ID/多项目组合未逐项覆盖。
- 02 单项目和多项目人员 / APK：已测 实际项目A姓名登录、进入B、回A，code20恢复同一身份与A列表。仍缺 尚未逐一核对该基线完整首登/原历史姓名/有效成员目录组合；物理Android设备未测。
- 02 单项目和多项目人员 / server MCP：已测 实际列出当前员工所属项目。仍缺 单项目/多项目/撤销关系的完整目录组合未在该MCP入口覆盖。
- 02 单项目和多项目人员 / local MCP：已测 实际列出当前员工所属项目。仍缺 单项目/多项目/撤销关系的完整目录组合未在该MCP入口覆盖。
- 04 项目人员停用 / APK：已测 A 内原生停用/恢复及HTTP同名登录403/200已核对。仍缺 未在这次原生人员操作中验证同一人的 B 项目继续可用；物理设备未测。
- 07 项目快速切换 / APK：已测 A/B文字与图片草稿实际分离；20→21升级恢复原项目/身份/文字/未提交PNG且三个本地hash一致；code21→22覆盖升级及原生闭环后，旧草稿/PNG/sidecar三个hash和原文继续保留。仍缺 未刻意制造迟到网络响应；未覆盖全部编辑/组件/文件草稿与人员选择；物理设备和完整迟到响应/草稿类别仍未完成。
- 07 项目快速切换 / EXE：已测 .4升级及异常退出后的项目/姓名/文字/图片草稿恢复 .6原生退出重登后同一项目/员工原文字+1图草稿恢复；本序列不含强停。 .7原生更新后同员工/项目/文字+PNG草稿恢复。。仍缺 EXE内A/B快速切换和刻意延迟响应未完成。
- 11 HTTP API 独立使用 / HTTP API：已测 预览EXE和4420退出时，独立HTTP实际15项含登录/创建/查询/跨项目拒绝继续成功。仍缺 停EXE窗口内没有通过HTTP独立完成评论及全部主要状态动作，不能用MCP调用替代HTTP入口。
- 12 服务端 MCP 独立使用 / server MCP：已测 预览EXE/本地MCP退出时服务MCP13项仍完成真实创建、评论、人工完成和验收关闭。仍缺 编辑、删除、退回/重开等其余主要Bug动作及完整负向场景未在该独立窗口逐一覆盖。
- 13 HTTP/MCP 对等 / HTTP API：已测 真实临时HTTP/SQLite与MCP资源、分页501评论/101附件、协议/项目权限及部分API对等用例通过；真实预览六已注册POST的vendor/JSON冻结响应、两格式同请求重放与丰富历史读取；仅HTTP，没有独立MCP对照。仍缺 全部业务工具/动作的等价输入、版本/操作人/幂等/错误组合未完成；不是跨所有客户端的全量证明；完整HTTP/MCP对等输入矩阵仍未逐项执行。
- 13 HTTP/MCP 对等 / server MCP：已测 真实临时HTTP/SQLite与MCP资源、分页501评论/101附件、协议/项目权限及部分API对等用例通过 实际预览.6对应MCP入口默认删除、同请求重放、context拒绝和原记录/actor/version审计保留通过。 实际预览.7本地4420和服务4421目录相同90工具，协议2025-06-18，不支持的协议头400；未逐一执行所有工具。仍缺 全部业务工具/动作的等价输入、版本/操作人/幂等/错误组合未完成；不是跨所有客户端的全量证明。
- 13 HTTP/MCP 对等 / local MCP：已测 实际预览.6对应MCP入口默认删除、同请求重放、context拒绝和原记录/actor/version审计保留通过。 实际预览.7本地4420和服务4421目录相同90工具，协议2025-06-18，不支持的协议头400；未逐一执行所有工具。仍缺 全部业务动作的等价输入、版本/人员/幂等错误组合及并发场景仍未完成。。
- 14 并发和重复提交 / HTTP API：已测 真实同验收请求切换JSON/vendor重放，保留相同事件和Bug版本。仍缺 全部动作/错误/并发组合的幂等验证仍不完整。
- 14 并发和重复提交 / server MCP：已测 实际预览.6对应MCP入口默认删除、同请求重放、context拒绝和原记录/actor/version审计保留通过。。仍缺 全部业务动作的等价输入、版本/人员/幂等错误组合及并发场景仍未完成。。
- 14 并发和重复提交 / local MCP：已测 实际预览.6对应MCP入口默认删除、同请求重放、context拒绝和原记录/actor/version审计保留通过。。仍缺 全部业务动作的等价输入、版本/人员/幂等错误组合及并发场景仍未完成。。
- 15 附件三种读取 / APK：已测 真实MediaProjection PNG在APK提交绑定；同一图片三个读取入口hash一致。仍缺 APK物理设备和更多文件/游戏截图场景未测；MCP调用属于各自MCP入口，未记作APK调用。
- 16 项目组件开关 / HTTP API：已测 A配置开关不影响B；依赖级联关闭；普通员工禁止组件配置。仍缺 旧HTTP/MCP和后台创建任务的全组合禁止仍只部分fixture覆盖，没有真实外部任务验证。
- 17 组件依赖和缺配置 / HTTP API：已测 缺配置为needs_configuration；single依赖检查和级联关闭；基础人工闭环可用。仍缺 所有客户端可见配置引导及实际独立外部资源尚未全面验证。
- 18 运行中停用组件 / APK：已测 code21原生本地批次/交接/禁用远端三个tab可达；全关时本地空列表读回，远端无执行按钮。仍缺 有数据的暂停恢复/批次重试/merge原生点击未测；真实独立Relay任务及回调/外部执行未测。
- 18 运行中停用组件 / Web：已测 真实临时SQLite/API交接关闭暂停、启用不重放、hold拒绝、明确恢复、重复拒绝及单审计；外部请求0。仍缺 浏览器有数据的暂停条目确认/恢复未测；真实外部执行/运行中停用全组合未测。
- 19 上传和 Relay 项目归属 / APK：已测 code21原生本地批次/交接/禁用远端三个tab可达；全关时本地空列表读回，远端无执行按钮。仍缺 有数据的暂停恢复/批次重试/merge原生点击未测；真实独立Relay任务及回调/外部执行未测。
- 20 外部失败与人工处理 / APK：已测 本地合同fixture已验证实现的部分失败处理，作为背景证据；不算本入口外部失败实测。仍缺 真实独立Jenkins/上传/Relay/轻语失败时的完整客户端人工处理未执行。
- 20 外部失败与人工处理 / EXE：已测 本地合同fixture已验证实现的部分失败处理，作为背景证据；不算本入口外部失败实测。仍缺 真实独立Jenkins/上传/Relay/轻语失败时的完整客户端人工处理未执行。
- 20 外部失败与人工处理 / Web：已测 本地合同fixture已验证实现的部分失败处理，作为背景证据；不算本入口外部失败实测。仍缺 真实独立Jenkins/上传/Relay/轻语失败时的完整客户端人工处理未执行。
- 20 外部失败与人工处理 / HTTP API：已测 本地合同fixture已验证实现的部分失败处理，作为背景证据；不算本入口外部失败实测。仍缺 真实独立Jenkins/上传/Relay/轻语失败时的完整客户端人工处理未执行。
- 20 外部失败与人工处理 / server MCP：已测 本地合同fixture已验证实现的部分失败处理，作为背景证据；不算本入口外部失败实测。仍缺 真实独立Jenkins/上传/Relay/轻语失败时的完整客户端人工处理未执行。
- 20 外部失败与人工处理 / local MCP：已测 本地合同fixture已验证实现的部分失败处理，作为背景证据；不算本入口外部失败实测。仍缺 真实独立Jenkins/上传/Relay/轻语失败时的完整客户端人工处理未执行。
- 21 旧数据副本迁移 / APK：已测 主SQLite固定归档schema12→14；原ID/878附件/58业务表指纹保留，2021条主outbox均sent且数量/指纹不变；上述为恢复集证据；本客户端/工具入口的服务读回未由该证据宣称。仍缺 legacy increment-upload独立queue.sqlite及owner/workspace/job文件、Relay批次/state目录、轻语状态均未纳入RPO，缺少这些文件系统未完成任务的完整数量/状态/项目映射清单及迁移前后核对。
- 21 旧数据副本迁移 / EXE：已测 主SQLite固定归档schema12→14；原ID/878附件/58业务表指纹保留，2021条主outbox均sent且数量/指纹不变；上述为恢复集证据；本客户端/工具入口的服务读回未由该证据宣称。仍缺 legacy increment-upload独立queue.sqlite及owner/workspace/job文件、Relay批次/state目录、轻语状态均未纳入RPO，缺少这些文件系统未完成任务的完整数量/状态/项目映射清单及迁移前后核对。
- 21 旧数据副本迁移 / Web：已测 主SQLite固定归档schema12→14；原ID/878附件/58业务表指纹保留，2021条主outbox均sent且数量/指纹不变；上述为恢复集证据；本客户端/工具入口的服务读回未由该证据宣称。仍缺 legacy increment-upload独立queue.sqlite及owner/workspace/job文件、Relay批次/state目录、轻语状态均未纳入RPO，缺少这些文件系统未完成任务的完整数量/状态/项目映射清单及迁移前后核对。
- 21 旧数据副本迁移 / HTTP API：已测 主SQLite固定归档schema12→14；原ID/878附件/58业务表指纹保留，2021条主outbox均sent且数量/指纹不变；新的held schema14 API真实26项：旧姓名稳定ID、100 Bug/2评论/1附件3487861字节hash，匿名401/跨项目404/hold409；五组件off、出站0、原身份和核心表保留，正常exit0。仍缺 legacy increment-upload独立queue.sqlite及owner/workspace/job文件、Relay批次/state目录、轻语状态均未纳入RPO，缺少这些文件系统未完成任务的完整数量/状态/项目映射清单及迁移前后核对。
- 21 旧数据副本迁移 / server MCP：已测 主SQLite固定归档schema12→14；原ID/878附件/58业务表指纹保留，2021条主outbox均sent且数量/指纹不变；上述为恢复集证据；本客户端/工具入口的服务读回未由该证据宣称。仍缺 legacy increment-upload独立queue.sqlite及owner/workspace/job文件、Relay批次/state目录、轻语状态均未纳入RPO，缺少这些文件系统未完成任务的完整数量/状态/项目映射清单及迁移前后核对。
- 21 旧数据副本迁移 / local MCP：已测 主SQLite固定归档schema12→14；原ID/878附件/58业务表指纹保留，2021条主outbox均sent且数量/指纹不变；上述为恢复集证据；本客户端/工具入口的服务读回未由该证据宣称。仍缺 legacy increment-upload独立queue.sqlite及owner/workspace/job文件、Relay批次/state目录、轻语状态均未纳入RPO，缺少这些文件系统未完成任务的完整数量/状态/项目映射清单及迁移前后核对。
- 22 APK 共存与升级 / APK：已测 MuMu预览15→21实际共存/ADB升级；20→21的文字/未提交PNG/sidecar三hash逐一相同；日常code14/PID5051/安装时点/dataDir保留；code21→22/preview.8实际ADB install-r成功，87unit/lint0errors；日常14/PID5051/安装时间/dataDir/四配置hash不变，预览草稿/PNG/sidecar保留。仍缺 物理Android设备必测仍缺；应用内更新源/自安装链路未测；物理Android及应用内更新完整链路仍未验收。

独立 Jenkins、上传平台/对象存储、Relay 目的实例和轻语测试租户/凭据仍缺；所有 `external_full_chain` 保持 not_run。离线迁移的数据库/附件指纹证明没有替代各入口执行。异常停止预览 EXE 证明进程独立和草稿恢复，不能自动记为完整版本回退。
已安装EXE的90工具共享目录与源码保留的18工具fallback目录分别统计；同名工具调用只通过共享目录对应行，fallback行保留未测，避免重复计数。

## 首次提交前证据补充

新增预览.6真实双入口删除：服务端4421和已安装EXE的本地4420各创建独立Bug并调用默认删除；相同请求重放均replayed:true、删除时点相同，context返回NOT_FOUND，原Bug及删除actor/version审计保留。[双MCP删除实测](runs/mcp-delete-live-preview6.json)。仅映射对应qa_delete_bug入口，不把一个删除用例推定为全部HTTP/MCP动作对等或全量幂等通过。

新增.6实际身份边界：原生退出后磁盘身份清除，本地MCP返回QA_HUB_LOGIN_REQUIRED；local MCP登录成功返回时身份已经落盘；原生重新登录同员工/项目后原文字+1张PNG草稿恢复。[退出读回](runs/exe-preview6-logout-readback.json)、[同步持久登录](runs/exe-preview6-login-durable-readback.json)、[原生重登草稿](runs/exe-preview6-relogin-draft.json)。登录后立即强停的组合命令被自动审批拒绝、未执行且未重试；这组证据明确processRestartNotTested，不能据此声称该强停场景通过。

此前提交前只读生产快照为2026-09-08T19:30:39Z：六个文件hash、三个原PID/启动时点均与19:02:22Z一致，4319 ready/schema12，4174的Windows 3.3.5公开manifest原字节hash一致；日常APK code14/PID5051/安装时点保留，预览APK code21仍在。未读取配置正文或凭据，未启停任何应用，未重新验签。日期比较曾因PowerShell隐式转换丢失小数精度误报，已按原始UTC字符串100ns精度更正并保留说明。[提交前生产快照](runs/production-pre-commit.json)。

此前.7升级后生产只读核对为2026-09-08T19:55:31.6095789Z：六文件hash、三个原PID及精确启动时点不变，4319 ready/schema12，4174 Windows3.3.5 manifest原字节SHA不变。日常EXE可读路径相同；两个Node的路径仍为null，不能视为新增可执行路径验证。本轮未重新查询Android，APK状态仍引用19:30快照；未读配置正文/凭据或修改生产。[.7后生产快照](runs/production-after-preview7.json)。

该阶段API完整回归为MJS151+TS33=184/184，旧175轮次保留；后续238最终回归见末节。生命周期9项覆盖真实监听、SQLite与inflight清理，修复的是绑定前调度/异常清理，旧runtime已有onReady/onClose；不得据此通过外部完整链路。[184原始日志](runs/api-final-lifecycle-source.txt)、[生命周期证据](component-runtime-lifecycle.md)。

本次仅将源码qa_delete_bug行 mcp_tool-65cae97a9470db 的server_mcp/local_mcp记通过；required_mcp_parity同名需求行仍not_run，不重复算全部对等。基线01/07的EXE与13/14的两MCP只补部分实测，该次补充后的wholepass为09/15/23；随后基线24服务证据及判据校正见专节。

mapper源保持冻结。本次新增结果及SHA使用既有JSON results/manual保留机制，审计元数据位于evidenceMapping.postFreezeSupplement，各行manual.postFreezeEvidence亦保留必要proof hash。只运行既有generate-coverage-matrix.mjs重生JSON/Markdown，不重写mapper代码。未来重跑旧mapper会刷新其自动审查段，需保留本补充段；人工行结果由既有matching-ID机制保留。

## 实施提交后的发布与迁移补充

**Windows 0.2.0-preview.7 已完成独立发布和实际6→7原生升级验收。** releaseId为20260908T194425490Z，108378668字节，SHA-256 fbf0656285474e2b4d521178cb9107dd26d3426dd463b9198fc21b239e02152a。公开回执sourceCommit为3b1371cbbaee4ab31f5861fe3cd72d6ff93c4789、sourceDirty:false；文档更新只读核对receipt及主代理实际原生升级proof；未额外操作安装或验签。回执位置：C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\packages\20260908T194425490Z\receipt.json。此包已含首装guard及提交内源码，升级passed依据下述实际proof。

.6→.7已通过原生“检查更新→安装并重启”实际完成，proof观测时点2026-09-08T19:54:02.443Z；当前已安装nativeVersion0.2.0.7、主PID11368。原员工/项目A、文字+1张PNG草稿和配置SHA保持，原Bug13 closed/v14、评论及184872字节原附件materialize/hash读回通过；旧更新结果及7份backup目录保留。新helper的成功result时间19:52:36Z位于真实原生点击区间，UTC已在本次成功更新中核对。[.7升级proof](runs/exe-after-preview7-upgrade.json)、[原生恢复](runs/exe-preview7-restored-draft.txt)。19:54:30Z本地4420与服务4421实际目录均为相同90工具、协议2025-06-18，不支持的协议头均400；此项只证明目录/协议，不能称90个业务工具全部通过。[双入口协议](runs/exe-preview7-live-protocol.json)。

新增保持冻结状态的迁移副本的真实API服务读回26项通过：固定schema12归档在新的service-readback-8b94d602中恢复并迁移至14，127.0.0.1:51708仅启动该副本API；稳定旧姓名ID登录后读出100 Bug、真实2评论及1附件（3487861字节、SHA-256 73470971577ea3ceb30edf4e8cb713d449a3b6e66c566cac5e897e136566e2ce），匿名401、跨项目404、外部读取hold409均实测。五组件关闭、出站和执行器子进程尝试均0；hold字节和核心业务/outbox指纹保持，原身份记录全部保留。新增的仅是官方独立GM和会话记录；不能称整个数据库字节无变化。进程8532正常exit0且监听关闭，旧migrated/rollback未启动且hash不变。[26项读回](migration-service-readback.md)、[脱敏JSON](migration-service-readback.json)。

该服务使用19:24:26Z冻结的独立编译样本，其已有onReady/onClose并由paused gate阻止调度；它不代替后续监听生命周期9项测试。此结果证明held schema14 API恢复读取，**未证明schema12程序启动、迁移后新增数据的完整回退、生产切换、客户端迁移或独立组件队列/workspace恢复**。归档2021条outbox原本全sent，也不单独证明pending任务冻结。前两次错误测试路由导致的harness失败已保留，不计成功。

该次迁移补充保留985条，仅补21的HTTP progress，不传递其它客户端/MCP通过；当时21/24仍not_run。后续24服务演练及判据校正另记，21外部任务清单与物理Android缺口仍保留。公开receipt摘要与hash记录于evidenceMapping.releaseAndMigrationSupplement，原始receipt仍位于独立runtime。该段发布证据形成时mapper源码保持冻结；本轮仅追加proof保留与基线判据校正。
## 基线判据及窄分支校正

设计13原文：“相同输入得到相同状态、版本、操作人和错误结果”。设计15原文：“HTTP 下载、远端 MCP 资源、本地 MCP 落盘均归属正确且可用”。15现在只按这三读取入口汇总，APK/EXE/Web其它功能控件保持各自状态，未增加not_applicable状态或豁免17.3物理设备要求。

重新核对同一项目fb914b3b-4169-47f8-8dec-76f3a3cc780d、Bug b817a6cc-f096-415d-bdb8-faa9b6005c36、附件31c9b4be-d0f6-4c9a-864e-032cc9130562：184872字节PNG，三种读取SHA-256同为e0ed7b4b96935f06855a05ce3372ada01b9585ed459d3d5c183f1c6dc8e7cb8b；HTTP跨项目404。三份主要入口proof是[HTTP](../../../apps/android/app/build/evidence/project-components/preview-code17-capture-isolation-readback.json)、[远端MCP](runs/server-mcp-real-resource-20260909.json)、[本地落盘](runs/desktop-mcp-resource-preview4.json)，绑定ID来自原[采集读回](../../../apps/android/app/build/evidence/project-components/preview-code17-capture-bug-readback.json)。

21仅移除无关的schema12程序启动/新增数据回退条件；26项held服务读回同时写入HTTP actual/evidence和manual。主库与878附件恢复集已经可用，historical-copy改为partially_verified；仍缺legacy上传独立queue.sqlite/owner/workspace/job、Relay批次/state和轻语状态的未完成任务完整清单及迁移核对。故21整项仍not_run，不能从58表指纹或2021sent主outbox推出这些目录已迁移。

.7真实close和更新按钮仅EXE入口passed；window-action(close)、check-update成功、install-update成功和second-instance无深链恢复记录为manual.branchResults中的passed，复合handler整行仍not_run。tray.click/double-click及托盘菜单没有此证据，仍not_run。

可重放纠正由manual.reviewedEvidence保存结果、progress和实际proof SHA；mapper在重放前逐一核对hash，变化即拒绝并要求重审。它不是新的业务通过来源，也不会取消needsRevalidation。
## 本轮重放验证与合同边界

前轮生成器→mapper→生成器重放后985细目不变，当时wholepass为09、15、23；401个既有needsRevalidation以及sourceHash/人工复验字段的规范化SHA保持相同。实际运行mapper的内存文件系统替身用错误proof SHA验证拒绝且零写入；另一个用例证明后来的failed结果、负向note、partial note、item/manual复验标记和sourceHash均保留。原始磁盘证据未改。[实际重放验证](runs/coverage-criteria-replay.json)。

严格合同的历史失败已在提交09f7150fc1c671d867bbdbc257cab0e61c78d20f修复：五步test:contract全部通过，原1.0/1.1 baseline与checker未重写。六条已注册POST使用冻结响应投影，丰富事实仍可从原三条GET读取。完整API238/238（205mjs+33ts）、Storage109/109、相关Web19/19通过；其中52条响应fixture覆盖八种Accept，不能当作运行实例E2E。[实现与边界](contracts-remediation-implementation.md)、[严格五步](runs/contracts-remediation-strict.txt)、[最终API](runs/contracts-remediation-api-final.txt)。旧1.0 result请求、blocked写入和未注册fail/supersede POST及/bugs/:bugId/workflow GET仍缺，不能据静态门禁宣称完整运行合同。
## 基线24服务回退判据校正

设计13/24原文：“能按文档恢复服务并保留回退前新增数据和任务证据”。10.3同时要求旧服务不能读取已迁移的新库，新版停止或回退时保留新增操作和产物。因此24以服务/HTTP为必要入口；此前要求APK、EXE、Web、HTTP、两MCP各自降级是过度约束。已有EXE客户端回退/重装证据独立保留，APK/Web/MCP及所有功能控件不由服务演练自动通过。

[47项服务回退](baseline24-service-rollback.md)及[脱敏JSON](baseline24-service-rollback.json)记录59条真实HTTP状态/大小/hash：modern3b1371c/schema14新增两Bug、评论、68字节PNG及两人工RepairAttempt/两Verification，其中一项仍in_progress；正常停止后910文件753461759字节整根保留，old62b4495/schema12实际读取独立旧归档，再以M14原session恢复所有新增ID/版本/操作者/状态/hash。三进程均正常exit0，端口关闭，retained全文件hash仍一致。写入外层是HTTP /api/v1/mcp/call，另有标准domain GET；本证据没有建立独立JSON-RPC或客户端UI会话。

该证明的protectedBefore/After仅为固定archive/migrated/rollback副本，不是新一轮生产六文件快照；生产状态继续按各自带时点proof引用。它不证明旧外部queue.sqlite/workspace、Relay批次/state、轻语目录的完整迁移，也不承诺schema14新业务降级到12。18/19外部任务、21旧文件系统任务清单、22和17.3物理设备缺口保留。当前整项通过09、15、23、24，全部任务仍未完成。
## 最终API、Android与生产读回

严格合同的历史失败已在提交09f7150fc1c671d867bbdbc257cab0e61c78d20f修复：五步test:contract全部通过，原1.0/1.1 baseline与checker未重写。六条已注册POST使用冻结响应投影，丰富事实仍可从原三条GET读取。完整API238/238（205mjs+33ts）、Storage109/109、相关Web19/19通过；其中52条响应fixture覆盖八种Accept，不能当作运行实例E2E。[实现与边界](contracts-remediation-implementation.md)、[严格五步](runs/contracts-remediation-strict.txt)、[最终API](runs/contracts-remediation-api-final.txt)。旧1.0 result请求、blocked写入和未注册fail/supersede POST及/bugs/:bugId/workflow GET仍缺，不能据静态门禁宣称完整运行合同。

最终dist已在独立API PID18644加载，启动时点2026-09-08T20:39:13.7225210Z，4419 ready/schema14。root实际31个HTTP调用通过：六条冻结POST的vendor/JSON输出、同幂等请求切换媒体重放、丰富历史读取及跨项目404；另核对14个媒体头与原EXE Bug closed/v14、评论及184872字节附件hash。[31次实际请求](runs/frozen-workflow-live-2026-09-08T20-40-57-088Z.json)、[媒体/旧业务读回](runs/frozen-workflow-live-readback.json)。请求均使用1.1；没有以此补齐旧1.0请求、未注册路由或全部HTTP/MCP对等。

Android最新实际安装为com.relayqahub.android.preview.debug，code22 / 0.2.0-preview.8，MuMu中21→22覆盖升级与原生开始→无需代码提交→验收通过关闭完成。Bug386cdd2f-44c9-4a79-992a-891d595766fd closed/v6；49条对应HTTP均2xx，deliver1次、complete0次，87单测通过，lint0errors/29warnings。原有草稿/PNG/sidecar三hash、日常code14/PID5051/安装时间及四配置hash保留。Bug由API准备，后续状态写入来自原生按钮。修复文件BugLifecycleClient.kt由本目标3b1371c新增，62b起点不存在，不能描述为旧基线故障。[code22原生记录](android-code22-no-code.md)、[机器证据](android-code22-no-code.json)。真实物理设备、真实代码分支交付及外部组件仍not_run。

最新生产只读核对为2026-09-08T20:49:45.0734634Z：相对19:55快照，六文件hash、三个原PID精确启动时点及可见日常EXE路径保持，4319 ready/schema12，4174 Windows3.3.5 manifest原字节hash不变。两个Node的可执行路径仍null，没有新增路径证明；未重新验签/下载生产安装包。Android引用code22证据20:46:37.419Z的daily14/PID5051/配置保留，root未重复ADB查询。[最新生产只读证据](runs/production-after-api-fix-code22.json)。

14条HTTP路由仅映射该实际调用子集。Android开始按钮记实测通过，submitFix的no_code分支记录passed但真实代码分支未测，复合按钮整行仍not_run。基线09保留原APK原生创建证据并追加本轮状态链，22仅追加模拟器升级progress；09、15、23、24为整项通过，18/19/21/22及17.3缺口继续保留。

code22同一已验收APK已发布为不可变预览下载：[下载Android code22 / preview.8](http://127.0.0.1:4274/downloads/qa-hub-preview-7c86-android-0.2.0-preview.8-code22.apk)。完整HTTP下载35,471,405字节、SHA-256 733088b8f876c41ce767627c6de8dfe12e00803c0b61ff13c6facd3b8982d777，实例响应头/类型匹配，Windows manifest未变。Android源内容与提交1be772469671d75cbb5e31240bf345dcc7c4a267一致，APK构建发生在提交之前；本次发布没有重新构建或安装。回执不是签名更新manifest，不能记为应用内自升级或物理设备通过。[下载发布证据](runs/android-code22-download-publication.json)。
## 最终源码及映射冻结

本轮冻结盘点锚点为81e70d43638f3cb2f3dbd3994acd46f413e5364e，其中API兼容源码提交09f7150、Android源码提交1be7724；188个源码文件hash逐一匹配，985条细目、21条退役历史保留。连续生成器→mapper→生成器重放的语义hash一致；错误proof hash在任何写入前拒绝（0写入），人工负向结果和item/manual复验、sourceHash标记均保留，既有needsRevalidation零丢失。审计结果见coverage-matrix.json的evidenceMapping.finalReplayVerification。

[运行HTTP回归说明](frozen-workflow-live.md)保留六注册路由的31请求和14媒体头边界。此次新增API/Android/下载证据没有补齐旧请求、blocked写入、未注册状态路由、外部队列迁移或物理设备验收。

## 可重放与审计

- 响应修复最终API MJS205/205：已有成功输出，见[runs/contracts-remediation-api-final.txt](runs/contracts-remediation-api-final.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 响应修复最终API TS33/33（合计238/238）：已有成功输出，见[runs/contracts-remediation-api-final.txt](runs/contracts-remediation-api-final.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 响应修复Storage109/109：已有成功输出，见[runs/contracts-remediation-storage.txt](runs/contracts-remediation-storage.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 响应修复相关Web19/19：已有成功输出，见[runs/contracts-remediation-web-configured.txt](runs/contracts-remediation-web-configured.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 严格合同五步恢复通过（原baseline/checker保留）：已有成功输出，见[runs/contracts-remediation-strict.txt](runs/contracts-remediation-strict.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- Desktop 104/104：已有成功输出，见[runs/desktop-final-pagination-protocol.txt](runs/desktop-final-pagination-protocol.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- Storage 109/109：已有成功输出，见[runs/storage-final.txt](runs/storage-final.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 冻结源码最终Storage109/109：已有成功输出，见[runs/storage-final-complete-source.txt](runs/storage-final-complete-source.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 冻结源码最终API MJS142/142：已有成功输出，见[runs/api-final-complete-source.txt](runs/api-final-complete-source.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 冻结源码最终API TS33/33（两组共175/175）：已有成功输出，见[runs/api-final-complete-source.txt](runs/api-final-complete-source.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 真实临时HTTP/SQLite与MCP分页/协议15/15，501评论/101附件：已有成功输出，见[runs/api-pagination-final.txt](runs/api-pagination-final.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- root unit 4/4：已有成功输出，见[runs/root-unit-final-retry.txt](runs/root-unit-final-retry.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- skeleton 1/1：已有成功输出，见[runs/skeleton-e2e-final-retry.txt](runs/skeleton-e2e-final-retry.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 精确Relay授权及组件scope16/16，含第101项目/成员：已有成功输出，见[runs/api-production-scope-final.txt](runs/api-production-scope-final.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- MCP删除合同及已删除Bug附件读取保护17/17：已有成功输出，见[runs/api-delete-guard-final.txt](runs/api-delete-guard-final.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 独立app-first合同检查通过：已有成功输出，见[runs/contracts-app-first.txt](runs/contracts-app-first.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 独立additive检查通过：已有成功输出，见[runs/contracts-additive.txt](runs/contracts-additive.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 独立app-first breaking检查通过：已有成功输出，见[runs/contracts-breaking-app-first.txt](runs/contracts-breaking-app-first.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 原始NSIS .onInit隔离native guard6/6：已有成功输出，见[runs/native-installer-guards.json](runs/native-installer-guards.json)。仅首建Programs、marker、junction与越界目录守卫；未执行真实用户完整首装或卸载。
- .6 native helper以故意无效空配置实际返回failed并验证UTC序列化：已有成功输出，见[runs/native-updater-utc.json](runs/native-updater-utc.json)。预期失败仅验证UTC；没有调用installer，不计更新成功。
- Web61/61+typecheck/lint/build；outbox真实临时API/SQLite、外部请求0：已有成功输出，见[runs/web-outbox-verification.json](runs/web-outbox-verification.json)。React静态渲染及隔离API实测；浏览器暂停条目点击未测。

严格旧合同冻结失败保留为历史，后续六条响应边界修复已有独立五步门禁成功日志与实际HTTP读回。旧1.0请求/blocked写入、未注册的fail/supersede POST和workflow GET仍缺，静态合同通过不代表全部运行能力。EXE各版本升级/回退/原生操作按对应proof记录，不能传递为所有控件通过。NSIS6项仅guard，不证明干净用户完整首装。完整迁移和服务回退仍按各自缺口与实际证据判定，不能从客户端恢复或表指纹推定完成。

依次执行 `node scripts/project-components/generate-coverage-matrix.mjs`、`node scripts/project-components/map-coverage-evidence.mjs`、`node scripts/project-components/generate-coverage-matrix.mjs`。生成器保留 matching ID 的人工结果和 `manual.surfaceProgress`；源码变更仍保留 `needsRevalidation`，不会自动清除未复核标记。此映射器只对明确识别的证据行赋值；其它人工结果保留。

映射器对 JSON proof 读取记录 SHA-256（UTF-8 文本原文），见 coverage-matrix.json 的 evidenceMapping.proofHashes；正文、原生 UI tree 和截图从证据字段追溯。缺少 optional proof 时不新增通过。所有凭据均不参与读取和输出。

当前细目计数：985。设计明确的必要入口均满足而整行 passed 的基线：09 关闭所有组件的基础全流程、15 附件三种读取、23 EXE 共存与升级、24 回退演练。其余基线不能称整体完成。
