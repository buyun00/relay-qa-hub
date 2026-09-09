# Frozen workflow 剩余入口：实现前只读差距审查

本轮只读源码、冻结合同与历史 proof；没有查询运行数据、调用 API、运行客户端、部署或修改产品/合同/基线/矩阵。源码观察起点为 `af5133abb3abea3423b8e6e1a75ec49e425bfccd`，逐文件 SHA、提取的 OpenAPI 操作及计划输入见本目录 `review.json` 和 `planned-requests.json`。这些输入只做内存 schema 校验，**不是动作执行证据**。原 [implementation](../contracts-remediation-implementation.md) 的历史边界不改写。

结论：**旧1.0 `/result` 请求、blocked 写入、fail POST、supersede POST、1.1 workflow GET 五项仍缺。** 可以在独立 SQLite/API fixture 中逐步实现和验证核心人工路径，不需要真实 Jenkins、Relay、上传目标或物理 Android。它们属于本目标内可安排的公开接口兼容补全；本次授权仅是审查，实施由根任务分 phase 安排。

## 设计适用范围与现有完成证据

- 设计 `project-components-transformation-2026-09-08.md:497`（§16.1）授权独立环境实现、构建、运行和真实测试，排除生产替换、日常客户端停止等。`:546–550`（§17.1）要求按实际功能与六入口分开建证据；`:552–567`（§17.2）要求 Bug 状态、接口/工具及异常输入实际走通；`:569–577`（§17.3）明确 unit/mock 不等于端到端。
- §17 没有逐字要求这四个 URI，也不能把它解释为重做全部旧 API。最低基线11/12要求独立登录、查询、评论和改状态，已有这些动作的真实证据不会因本报告失效；不能反过来把基线11/12通过写成所有冻结接口完整实现。
- 这些接口已出现在官方冻结 OpenAPI，故是有具体声明的能力缺口，不是自行发明的新功能。现有 no_code→人工完成/退回/关闭已经可走，`human-workflow` 丰富读回也存在；它们不等于缺失的 frozen `/workflow` 数组合同。
- 设计`:9,26,37`只保留员工和GM，业务分工字段不是额外身份。实现可用当前 `command_project_memberships` 和服务端兼容能力，不恢复“开发者/验收者”角色选择UI，也不能从请求信任 roles。冻结 workflow 的资源关系、分工与严重度守卫需在对应入口保留；不要把旧权限名称机械扩散为项目内新的通用限制。

## 当前实际入口与领域基础

| 项目 | 当前源码证据 | 差距 |
| --- | --- | --- |
| 1.0 result 请求 | `apps/api/src/app.ts:2377–2428` 已注册 POST；`:2388`只调 `parseMobileRecordVerificationResultRequest`；`mobile-verification.ts:145–202` 强制 `submissionContractVersion=1.1.0`、clientSubmissionId、attachmentIds | 旧 JSON 只需 expectedVersion/status/resultSummary，当前会在写入前被解析拒绝。旧响应白名单已修复，不代表旧请求已可用 |
| blocked result | 同 parser`:157–166`不允许 blockedReason/status；`sqlite-mobile-verification-store.ts:94–101`仅两分支；storage`:923–1091`仅 passed/failed，写 blocked_reason=NULL，非passed一律 Bug→ready | 不能只扩大 TypeScript union 或状态枚举；必须增加正确三聚合事务分支与完整回执 |
| fail/supersede POST | `app.ts:1859–1983`只有 create/start/get/deliver；`mobile-relay.ts`无这两条 path/方法；worker/运行 store 无对应公开 command | 纯领域 `decideDomainCommand` 已有 fail/supersede，SQLite typed triggers 已支持合法审计/状态；缺真实适配、事务写入、回执和路由 |
| frozen workflow GET | 全 `apps/api/src`/`packages/storage/src`未发现 `getBugWorkflowProjection` 或 frozen route；`mobile-human-workflow-store.ts:24–35,545–592`返回单个活动对象和latestVerification | 缺五集合、安全关系投影、固定快照与完整cursor，不可给 human-workflow 改名了事 |
| MCP | `automation.ts:402–414`通过 `qa_bug_action`共用现有动作；`bug-actions.ts:20–33`无fail/supersede/block；`automation-routes.ts`只已有 attempt/verification详情GET；context读 human-workflow | 目前90工具没有绕过缺失入口的隐藏实现。新HTTP实现后仍需独立补服务端和本地MCP适配/真实验证，不能只测HTTP就勾两种MCP |

复用的真实领域代码：`packages/domain/src/state-machine.ts:1653–1782` 的 fail/legacy-supersede/vendor-supersede；`:2323–2422` 的 passed/failed/blocked；入口`:2431–2465`先校验snapshot、human actor、服务端授权事实。它们是纯决策函数，不自动持久化、授权查询或产生 HTTP。

存储已有关系保护：`sqlite-migrations.ts:4869–4902`约束fail/legacy supersede的typed audit和Bug指针；`:5305–5317`禁止改历史身份/sequence/mode/assignee/parent；`:5254–5296`明确blocked保持 delivered Attempt和Bug ready_for_verification，并清activeVerification。当前角色兼容/GM迁移已经替换相应有效成员来源，不能为测试关闭触发器。`mobile-relay-store.ts:2370–2407`的人工接管内部 supersede 可借鉴写入顺序，**不能复用整个 manual-complete**：它还创建、开始和交付人工轮次，产生额外业务效果。

## 冻结合同必须保持的行为

所有下列 POST 的 `expectedVersion` 指**路径目标资源**（Attempt或Verification）的版本，不能误用外层Bug版本；事务同时比较服务端当前Bug与关系。成功均HTTP200。错误类型分开：版本冲突412 `VERSION_CONFLICT`，不同payload重用key409 `IDEMPOTENCY_PAYLOAD_MISMATCH`，不合法状态409 `INVALID_TRANSITION`，关系/Build守卫422，未认证401、无权限403、目标不存在/删除404。当前 result 的 `buildErrorReply`（app`:2058–2092`）已经使用412；不要给新 frozen POST 直接套 `relayErrorReply` 或 `bug-actions` 的409版本映射。

身份方面，1.0 OpenAPI要求Cookie+CSRF；1.1为同一人类操作增加native Bearer OR分支（README`:11–21`）。Relay M2M不能写验收结论或QA状态（1.1 manifest`:123–126`）。每次首次执行和重放都重新校验账户、活动用户、项目及当前membership/GM上下文、目标Bug未删除，再校验完整 typed 关系；不能以成功receipt替代当前授权。

### 旧 result 与 blocked

- 基础 `bug.schema.json:288–308`：旧 JSON只有 expectedVersion/status/resultSummary，以及failed必需failureReason、blocked必需blockedReason；不要求也不允许1.1 submission/附件字段。
- 1.1 `app-first.schema.json:818–891`：新增 submissionContractVersion/clientSubmissionId/attachmentIds，最多20个附件及可选capture；reason与status互斥；原样保留旧表示。请求表示选择和响应 Accept 选择必须分开，不能通过较小 Accept 跳过证明。现有 Web/Android result发送vendor；server MCP公共 send（automation`:222`）默认JSON，因此适配时要明确媒体，不把已有1.1-body/JSON调用不经评估直接切断。
- passed：Verification版本+1，Bug closed、版本+1、清两active指针，Attempt保持delivered及版本。failed：Verification+1，Attempt verification_failed/+1，Bug ready/+1，清两指针。blocked：Verification blocked/+1及原因，Bug ready_for_verification/+1，清activeVerification，**保留activeAttempt和delivered Attempt版本**；可之后新建一次Verification，旧blocked记录不可改为passed。
- `api-manifest.json:144–147,201`及evaluator`:5989–6035`要求分派的verifier、latest delivered Attempt、精确Build/BuildRequirement关系和严重度职责分离。无代码路径可使用 `buildId:null`，不能把空Build当代码交付验收豁免。
- 现有 store 保存完整结果到 submissions.response_json（约`:1098`），但重放 `loadResultResponse:584–631`按当前Bug/Attempt重新组装；不能把它直接当“原始不可变receipt”基础。新增兼容路径应共享精确持久回执，测试操作后再次变化时仍重放原结果。`workflow-idempotency.ts:26–162`已有当前授权→作用域key→receipt机制，可扩大operation union复用；当前union不含result/fail/supersede。

### fail 与 supersede

- 基础 `workflow.schema.json:72–81` 两者请求 `{expectedVersion,reason}`，reason 1..5000；1.1 fail形状相同。官方1.1key分别为 `workflow:failRepairAttempt:attempt:<id>:v<v>` 与 `workflow:supersedeRepairAttempt:attempt:<id>:v<v>`。
- `manifest:145,195–196`、evaluator`:5353–5450`：只能处理当前active、Bug in_progress，Attempt状态为planned/queued/running/needs_input/blocked之一。不得覆写delivered、verification_failed、cancelled、superseded历史。
- fail：旧Attempt failed/+1，Bug ready/+1、清activeAttempt，原mode/assignee/parent/交付字段保留；一条 `repair_attempt.failed` typed事件、对应通知outbox和原receipt同事务。
- legacy supersede：旧Attempt superseded/+1、Bug ready/+1、清activeAttempt；没有后继。随后调用createRepairAttempt，`parentAttemptId`必须是该旧轮次，服务器生成下一sequence。
- vendor supersede `app-first.schema:473–515`：请求额外明确successor `{id,mode,assigneeId,summary?}`，id从未使用、人员在同项目有效可分派；原子结束旧轮次并创建唯一planned/version1后继，parent=old，sequence由服务端历史导出，Bug仍in_progress、active指向后继、Bug只+1。响应包含两Attempt、Bug、eventId、replayed。不能 silently clone旧mode/assignee，也不能拆成两个HTTP事务。
- 更改旧 mode为relay/external只是在允许时记录计划，不能自动发起外部任务；已有组件开关和导入hold仍控制dispatch。缺外部资源不阻止human→human本地验收，但未执行的Relay后台/回调竞态不能因此标通过。

### frozen workflow GET

`manifest:702–717`与schema`:1343–1401`：只读、vendor响应，包含bugId/bugVersion/snapshotSequence/truncated/nextCursor，及occurrences、repairAttempts、verifications、builds、relayReceipts五个数组。各集合默认50、最大100，按UUID升序独立翻页；所有用户、附件、capture、Build、receipt都经同account/project/Bug服务端关系投影，Relay输出只能安全字段，不得暴露凭据/任意外部URL内容。

一个有完整性保护的opaque cursor绑定account、actor、当前membership revision/set digest、project/bug、limit/filter、一份冻结snapshot、各集合独立lastSortKey/hasMore。耗尽的集合后续为空，不能因为其它集合还有页就重放它；全体结束时truncated=false、nextCursor=null，存在下一页必须至少有一集合前进（evaluator`:2175–2295`）。

当前 `scoped-list-cursor.ts`只有comments/attachments、createdAt/id，既非签名token，也没有actor/membership/frozen snapshot及五watermark，因此只能借鉴scope检查，不能直接扩一个kind就宣称满足。只存snapshotSequence后继续查询可变行也不等于冻结快照：旧Attempt在分页期间可能被修改。最小可靠方向是新建专用持久投影snapshot存储（私有固定dataRoot，首读同一SQLite事务捕获安全DTO及授权摘要；后续只读此快照并重验当前权限），cursor引用snapshot并签名，限时/限量失效策略需在实现中明确；不要长期保持读事务占用运行连接。

## 实现前必须显式保留的合同/复用差异

1. **workflow错误枚举存在冻结内部缺口。** `semantics/behavior-scenarios.json:1473–1482`明确跨snapshot/跨Bug cursor→`INVALID_REQUEST`；同版本 manifest`:717`及生成OpenAPI该GET只列401/403/404/406/429/500，遗漏400。应保留这两份原声明，合理错误实现可以按已有语义拒绝，但不能宣称响应状态表完全覆盖；不得改baseline或把非法cursor静默当第一页。根任务须在实施phase记录这一精确遗留边界。
2. 1.0 OpenAPI `Idempotency-Key` schema是1..200任意稳定key；1.1同operation描述进一步指定canonical模板。当前result严格要求模板。本阶段计划正向使用模板满足共同子集；若要承诺“所有旧客户端key均兼容”，还需明确legacy键策略，不能把较小请求body已兼容夸大为完整旧线协议验收。
3. 纯domain fail/supersede目前设置failureReason/supersedeReason而保留summary（`:1674–1676,1715–1718`）；1.1evaluator`:5358,5381`要求响应summary=request.reason。直接序列化domain快照会漏掉这条冻结响应语义；应在有界实现中一致保存原因与冻结可见summary，继续保留丰富历史原因。
4. 纯domain result允许reporter或assigned verifier（`:2341–2345`）；冻结1.1evaluator`:6009`要求assigned verifier。不能未经选择直接扩大 frozen入口权限；也不要反向更改本目标的通用人工接管/关闭权限。对应入口关系检查与现有员工能力兼容须单独测试。
5. 现有result parser最多20附件，store`:938–945`实际只接受8且拒capture；这不是本轮新缺陷，也不是添加blocked即可解决的事项。先以无附件覆盖核心legacy/blocked，再另列9..20与capture的适用缺口；不能称完整1.1result附件能力已通过。

## 最小分阶段方案及触达文件

| 阶段 | 有界结果 | 最小触达（建议，不是本轮修改） | 必须留下的验证 |
| --- | --- | --- | --- |
| A | legacy result请求与当前passed/failed共用精确原receipt；保持现有vendor响应 | `mobile-verification.ts`、`sqlite-mobile-verification-store.ts`、`mobile-verification-store.ts`、`workflow-idempotency.ts`、worker输入类型/分支、`app.ts`/`frozen-workflow-response.ts` | 真SQLite+随机loopback HTTP，两种媒体、Cookie+CSRF/Bearer、key冲突/版本/撤权/软删、后续状态变化后的原receipt；原response DTO strict Ajv |
| B | blocked完整事务与历史可读 | 在A文件的三分支状态/typed事件/通知/receipt补全，复用已有schema/trigger；不关trigger造状态 | 真no_code交付→create/start Verification→blocked→新Verification→passed；原blocked原因、指针、版本、单审计/outbox，blocked/pass并发仅一winner |
| C | fail及两种supersede | 新小型 workflow mutation service/store或扩现有mobile-relay adapter；worker transaction；`app.ts`两POST；domain辅助仅在必要合同语义处调整 | human planned/running失败、legacy两步、vendor原子后继；无效后继回滚；复用ID/错scope/旧version/重复/并发；所有旧轮次只读保留 |
| D | frozen workflow GET及安全分页 | 新`workflow-projection-store.ts`/cursor+必要additive snapshot migration、worker读服务、API路由/DTO | 五集合schema；>100人工历史/occurrence分页，页间新增/修改/停用/删除；actor/项目/limit/cursor签名篡改；空/不均衡集合与终止；服务重启策略明确 |
| E | 两种MCP接同一个实现并真实回归 | `automation-routes.ts`/`automation.ts`和desktop共享路由/typed映射；如用`qa_bug_action`增加动作，需同时处理其当前409版本映射 | 服务端4421真JSON-RPC与独立本地MCP分开证明；同body/version/actor/key/错误/receipt，不能HTTP包一层冒充serverMCP |

建议先A，再B/C，D可独立实施；MCP适配随对应阶段完成。若采用新增直接工具（fail、supersede、workflow page），先把精确名称/参数/数量变化报根任务，保留已有90工具契约，不在只读报告中擅自增删工具。整个阶段不需要重写基础状态机或旧迁移；新表仅additive，生产不迁移。

## 真实验证输入与证据边界

本目录计划输入均为合成UUID，占位ID不是运行中Bug。执行时只创建fresh C/D项目、C-only/D-only/shared员工、另一位verifier及GM；五组件全部off，独立runtime/data/credentials与随机loopback API，先做真实SQLite/HTTP fixture，后由根任务部署预览并另开明确的真实窗口。凭据只内存，实际HTTP/JSON-RPC递归脱敏保留primitive类型，失败原records不可覆盖。

- A/B：正式创建Bug→ready→human Attempt→start→no_code deliver，随后create Verification(buildId:null,另一员工verifier)→start。legacy body无需submission/attachment；vendor blocked携clientSubmissionId、attachmentIds:[]。逐项比较Bug/Attempt/Verification版本、状态、actor、事件ID、notification outbox和receipt；一个blocked Verification不能直接再录passed。
- C：用正式create/start制造planned/running，不能SQL造状态或删trigger。legacy supersede后显式create(parent=old)；vendor指定fresh successor UUID，同事务Bug版本只+1；注入无效/跨项目assignee或已用successor，应整个事务回滚。并发同key同body和相反动作，比较准确winner、原receipt和单effect。
- D：通过正式occurrence与fail/再create循环产生>100可翻页人工历史；首读后新增与修改旧事实，再读其后页，应仍是首份安全DTO快照，权限则按当前状态重验。无Build/Relay记录的纯Bug fixture必须返回空数组，不能伪造外部成功。非空Build/Relay多页、安全字段与typed关系可用**明确标注的本地持久合同fixture**验证；没有真实独立执行器时，外部来源端到端仍not_run。
- 所有拒绝后在原scope读回，证明业务版本、事件/附件/计数不变；重放前撤权/删除的原receipt仍不得泄露。S0/S1职责分离、错assigned verifier、无membership、shared员工显式错project、跨Bug关系、无效media和reason按各自合同逐项验证。

可借鉴已存在 `apps/api/test/frozen-workflow-response.test.mjs`（真实OpenAPI `$ref`/Ajv）、`repair-attempt-history.test.mjs`、`packages/storage/test/workflow-idempotency.test.ts`，以及 `scripts/project-components/frozen-workflow-live.mjs`、两份workflow concurrency live runner的真实网络/留证结构。它们不是缺失入口已通过的证据，不能原样运行后把新功能算完成。全量回归和新增真实场景通过后才可记录各入口适用功能通过；本报告不更新矩阵、不免除任何既有未测项。
