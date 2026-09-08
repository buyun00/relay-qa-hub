# 实测证据映射审查

生成时点：2026-09-08T19:18:16.465Z。只读已有证据，没有操作 UI、API 或生产。

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
| 14 并发和重复提交 | not_run | not_run | not_run | not_run | not_run（部分实测） | not_run（部分实测） |
| 15 附件三种读取 | not_run（部分实测） | not_run | not_run | passed | passed | passed |
| 16 项目组件开关 | not_run | not_run | not_run | not_run（部分实测） | not_run | not_run |
| 17 组件依赖和缺配置 | not_run | not_run | not_run | not_run（部分实测） | not_run | not_run |
| 18 运行中停用组件 | not_run（部分实测） | not_run | not_run（部分实测） | not_run | not_run | not_run |
| 19 上传和 Relay 项目归属 | not_run（部分实测） | not_run | not_run | not_run | not_run | not_run |
| 20 外部失败与人工处理 | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） |
| 21 旧数据副本迁移 | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） |
| 22 APK 共存与升级 | not_run（部分实测） | — | — | — | — | — |
| 23 EXE 共存与升级 | — | passed | — | — | — | — |
| 24 回退演练 | not_run | passed | not_run | not_run | not_run | not_run |

09 已按六个各自真实入口分别闭环；23 已按原生EXE .4/.5/.6升级和恢复proof判通过。22保持未测：MuMu共存、ADB升级与code21三个保留hash只是部分实测，物理Android与应用内更新链路缺失。15的HTTP、服务MCP和本地MCP分别有同一PNG字节/hash证据，不将资源读取传递为所有客户端整项通过。

## 部分实测及剩余缺口

- 01 项目入口姓名登录 / APK：已测 实际项目A姓名登录、进入B、回A，code20恢复同一身份与A列表。仍缺 尚未逐一核对该基线完整首登/原历史姓名/有效成员目录组合；物理Android设备未测。
- 01 项目入口姓名登录 / server MCP：已测 实际项目姓名登录与项目目录、后续操作人读回。仍缺 完整首次成员登记/已有姓名稳定ID/多项目组合未逐项覆盖。
- 01 项目入口姓名登录 / local MCP：已测 实际项目姓名登录与项目目录、后续操作人读回。仍缺 完整首次成员登记/已有姓名稳定ID/多项目组合未逐项覆盖。
- 02 单项目和多项目人员 / APK：已测 实际项目A姓名登录、进入B、回A，code20恢复同一身份与A列表。仍缺 尚未逐一核对该基线完整首登/原历史姓名/有效成员目录组合；物理Android设备未测。
- 02 单项目和多项目人员 / server MCP：已测 实际列出当前员工所属项目。仍缺 单项目/多项目/撤销关系的完整目录组合未在该MCP入口覆盖。
- 02 单项目和多项目人员 / local MCP：已测 实际列出当前员工所属项目。仍缺 单项目/多项目/撤销关系的完整目录组合未在该MCP入口覆盖。
- 04 项目人员停用 / APK：已测 A 内原生停用/恢复及HTTP同名登录403/200已核对。仍缺 未在这次原生人员操作中验证同一人的 B 项目继续可用；物理设备未测。
- 07 项目快速切换 / APK：已测 A/B文字与图片草稿实际分离；20→21升级恢复原项目/身份/文字/未提交PNG且三个本地hash一致。仍缺 未刻意制造迟到网络响应；未覆盖全部编辑/组件/文件草稿与人员选择。
- 07 项目快速切换 / EXE：已测 .4升级及异常退出后的项目/姓名/文字/图片草稿恢复。仍缺 EXE内A/B快速切换和刻意延迟响应未完成。
- 11 HTTP API 独立使用 / HTTP API：已测 预览EXE和4420退出时，独立HTTP实际15项含登录/创建/查询/跨项目拒绝继续成功。仍缺 停EXE窗口内没有通过HTTP独立完成评论及全部主要状态动作，不能用MCP调用替代HTTP入口。
- 12 服务端 MCP 独立使用 / server MCP：已测 预览EXE/本地MCP退出时服务MCP13项仍完成真实创建、评论、人工完成和验收关闭。仍缺 编辑、删除、退回/重开等其余主要Bug动作及完整负向场景未在该独立窗口逐一覆盖。
- 13 HTTP/MCP 对等 / HTTP API：已测 真实临时HTTP/SQLite与MCP资源、分页501评论/101附件、协议/项目权限及部分API对等用例通过。仍缺 全部业务工具/动作的等价输入、版本/操作人/幂等/错误组合未完成；不是跨所有客户端的全量证明。
- 13 HTTP/MCP 对等 / server MCP：已测 真实临时HTTP/SQLite与MCP资源、分页501评论/101附件、协议/项目权限及部分API对等用例通过。仍缺 全部业务工具/动作的等价输入、版本/操作人/幂等/错误组合未完成；不是跨所有客户端的全量证明。
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
- 21 旧数据副本迁移 / APK：已测 离线schema12→14及独立schema12回退副本，878附件/58业务表指纹匹配，两副本paused。仍缺 本入口未在迁移副本执行完整业务读回；独立组件目录/未完成外部任务迁移不在该恢复集。
- 21 旧数据副本迁移 / EXE：已测 离线schema12→14及独立schema12回退副本，878附件/58业务表指纹匹配，两副本paused。仍缺 本入口未在迁移副本执行完整业务读回；独立组件目录/未完成外部任务迁移不在该恢复集。
- 21 旧数据副本迁移 / Web：已测 离线schema12→14及独立schema12回退副本，878附件/58业务表指纹匹配，两副本paused。仍缺 本入口未在迁移副本执行完整业务读回；独立组件目录/未完成外部任务迁移不在该恢复集。
- 21 旧数据副本迁移 / HTTP API：已测 离线schema12→14及独立schema12回退副本，878附件/58业务表指纹匹配，两副本paused。仍缺 本入口未在迁移副本执行完整业务读回；独立组件目录/未完成外部任务迁移不在该恢复集。
- 21 旧数据副本迁移 / server MCP：已测 离线schema12→14及独立schema12回退副本，878附件/58业务表指纹匹配，两副本paused。仍缺 本入口未在迁移副本执行完整业务读回；独立组件目录/未完成外部任务迁移不在该恢复集。
- 21 旧数据副本迁移 / local MCP：已测 离线schema12→14及独立schema12回退副本，878附件/58业务表指纹匹配，两副本paused。仍缺 本入口未在迁移副本执行完整业务读回；独立组件目录/未完成外部任务迁移不在该恢复集。
- 22 APK 共存与升级 / APK：已测 MuMu预览15→21实际共存/ADB升级；20→21的文字/未提交PNG/sidecar三hash逐一相同；日常code14/PID5051/安装时点/dataDir保留。仍缺 物理Android设备必测仍缺；应用内更新源/自安装链路未测。

独立 Jenkins、上传平台/对象存储、Relay 目的实例和轻语测试租户/凭据仍缺；所有 `external_full_chain` 保持 not_run。离线迁移的数据库/附件指纹证明没有替代各入口执行。异常停止预览 EXE 证明进程独立和草稿恢复，不能自动记为完整版本回退。
已安装EXE的90工具共享目录与源码保留的18工具fallback目录分别统计；同名工具调用只通过共享目录对应行，fallback行保留未测，避免重复计数。

## 首次提交前证据补充

新增预览.6真实双入口删除：服务端4421和已安装EXE的本地4420各创建独立Bug并调用默认删除；相同请求重放均replayed:true、删除时点相同，context返回NOT_FOUND，原Bug及删除actor/version审计保留。[双MCP删除实测](runs/mcp-delete-live-preview6.json)。仅映射对应qa_delete_bug入口，不把一个删除用例推定为全部HTTP/MCP动作对等或全量幂等通过。

新增.6实际身份边界：原生退出后磁盘身份清除，本地MCP返回QA_HUB_LOGIN_REQUIRED；local MCP登录成功返回时身份已经落盘；原生重新登录同员工/项目后原文字+1张PNG草稿恢复。[退出读回](runs/exe-preview6-logout-readback.json)、[同步持久登录](runs/exe-preview6-login-durable-readback.json)、[原生重登草稿](runs/exe-preview6-relogin-draft.json)。登录后立即强停的组合命令被自动审批拒绝、未执行且未重试；这组证据明确processRestartNotTested，不能据此声称该强停场景通过。

最新只读生产快照为2026-09-08T19:30:39Z：六个文件hash、三个原PID/启动时点均与19:02:22Z一致，4319 ready/schema12，4174的Windows 3.3.5公开manifest原字节hash一致；日常APK code14/PID5051/安装时点保留，预览APK code21仍在。未读取配置正文或凭据，未启停任何应用，未重新验签。日期比较曾因PowerShell隐式转换丢失小数精度误报，已按原始UTC字符串100ns精度更正并保留说明。[提交前生产快照](runs/production-pre-commit.json)。

最新API完整回归为MJS151+TS33=184/184，旧175轮次保留。生命周期9项覆盖真实监听、SQLite与inflight清理，修复的是绑定前调度/异常清理，旧runtime已有onReady/onClose；不得据此通过外部完整链路。[184原始日志](runs/api-final-lifecycle-source.txt)、[生命周期证据](component-runtime-lifecycle.md)。

本次仅将源码qa_delete_bug行 mcp_tool-65cae97a9470db 的server_mcp/local_mcp记通过；required_mcp_parity同名需求行仍not_run，不重复算全部对等。基线01/07的EXE与13/14的两MCP只补部分实测，09/23仍是仅有wholepass。

mapper源保持冻结。本次新增结果及SHA使用既有JSON results/manual保留机制，审计元数据位于evidenceMapping.postFreezeSupplement，各行manual.postFreezeEvidence亦保留必要proof hash。只运行既有generate-coverage-matrix.mjs重生JSON/Markdown，不重写mapper代码。未来重跑旧mapper会刷新其自动审查段，需保留本补充段；人工行结果由既有matching-ID机制保留。

## 可重放与审计

- Desktop 104/104：已有成功输出，见[runs/desktop-final-pagination-protocol.txt](runs/desktop-final-pagination-protocol.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- Storage 109/109：已有成功输出，见[runs/storage-final.txt](runs/storage-final.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 冻结源码最终Storage109/109：已有成功输出，见[runs/storage-final-complete-source.txt](runs/storage-final-complete-source.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 先前冻结源码API MJS142/142（历史）：已有成功输出，见[runs/api-final-complete-source.txt](runs/api-final-complete-source.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 先前冻结源码API TS33/33（两组共175/175，历史）：已有成功输出，见[runs/api-final-complete-source.txt](runs/api-final-complete-source.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
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

严格旧合同冻结基线仍failed（workflow canonical drift在起点HEAD已存在）；三项独立合同成功不抵消该失败。EXE.6升级/回退/重复升级/卸载后精确包重装已有真实proof，24仅EXE入口passed，完整数据服务/APK仍缺，不标wholepassed。.5原生Bug闭环/编辑/评论/删除按发生版本记录，不推定.6全部操作已测。NSIS6项仅guard，UTC用例故意failed且未调用installer，均不推定干净用户完整首装或额外更新成功。.7仅计划，不提前映射。

依次执行 `node scripts/project-components/generate-coverage-matrix.mjs`、`node scripts/project-components/map-coverage-evidence.mjs`、`node scripts/project-components/generate-coverage-matrix.mjs`。生成器保留 matching ID 的人工结果和 `manual.surfaceProgress`；源码变更仍保留 `needsRevalidation`，不会自动清除未复核标记。此映射器只对明确识别的证据行赋值；其它人工结果保留。

映射器对 JSON proof 读取记录 SHA-256（UTF-8 文本原文），见 coverage-matrix.json 的 evidenceMapping.proofHashes；正文、原生 UI tree 和截图从证据字段追溯。缺少 optional proof 时不新增通过。所有凭据均不参与读取和输出。

当前细目计数：985。全部入口均满足而整行 passed 的基线：09 关闭所有组件的基础全流程、23 EXE 共存与升级。其余基线不能称整体完成。
