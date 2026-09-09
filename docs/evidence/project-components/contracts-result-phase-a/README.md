# Phase A：旧结果请求与原始回执

仅在当前工作树实现并用临时 SQLite、随机 loopback HTTP 验证。未部署、未访问运行中的 4419、未操作任何客户端或外部执行器。原只读 gap review、冻结合同、baseline 与矩阵未改。

本阶段完成 `POST /api/v1/verifications/:id/result` 的 legacy `passed` / `failed` 请求兼容，以及新结果的持久原始回执。API 全量 **260/260**，Storage 全量 **118/118**；新测试 **14 组、215 次真实 HTTP 请求**。源文件、原始日志和最终临时数据库位置/哈希见 [result.json](./result.json)。原失败日志全部保留。

## 请求与权限边界

- `application/json` 下合法旧字段 `{expectedVersion,status,resultSummary,failureReason?}` 按旧请求识别，允许 1–200 字符稳定幂等键；不产生冒充客户端提交身份的 ID。
- 旧请求默认及 JSON 可接受时返回旧 JSON DTO。按 Accept 的媒体范围、具体程度及质量值判断 JSON 是否允许；只允许 vendor 或明确排除 JSON 时，在写入前返回 `406 NOT_ACCEPTABLE`。例如 vendor 权重 1、JSON 权重 0.1 仍能返回合法 JSON。
- 新请求继续要求 `submissionContractVersion/clientSubmissionId/attachmentIds`，保留 vendor body + JSON Content-Type、以及 vendor body + JSON Accept 的现有用法；冻结入口仍要求 canonical key。请求识别与响应协商分开。
- 冻结入口通过服务端 command 显式设置 `requireAssignedVerifier: true`，首写和每次重放都校验当前成员资格、项目/账户/用户有效性、资源归属、未删除和指定验收人。请求 body 不能传入或覆盖该标志。
- 通用 BugAction/人工关闭保留原多员工权限。真实 HTTP 同一个非指定验收人员工在冻结入口得到 403，在通用 `verify_pass` 入口完成关闭；其通用重放仍成功，冻结重放仍 403。原有多员工 Storage 用例未改断言。
- `getMobileVerification` 补当前资格和软删除可见性检查。正常历史仍可查，软删除后不再从该 GET 旁路读回。

## schema15 与原子性

schema15 只增加 `verification_result_snapshots` 及其约束/触发器，不改写历史行，不改变通用回执的 **64 KiB** 隐私限制。

结果专用快照限制 **1 MiB**。当前可变正文保守上界为 83,640 字符：Bug 30,300、Verification 25,000、Attempt 28,340。按 JSON 最坏每字符 6 字节转义计 501,840 字节，再留 16 KiB 给字段名、UUID、计数、服务器时间、QA item 与当前最多 8 个附件，合计 518,224 字节。实际测试包含中文、控制字符和正常业务文字 `token text`，生成 **106,665 字节**快照；首次 HTTP、原样重放及 online backup 恢复后重放均通过。领域正文完整保留，只有结果审计摘要按 JSON 转义后的字节数截断，避免旧事件上限错误拒绝合法正文。

专用快照绑定 account/project/actor/bug/verification、请求摘要、操作、幂等键和 typed event。每层对象都有字段白名单、准确字段数及不同 key 数，数字字段要求 JSON integer。嵌套 DTO 与实际领域列逐字段相等，附件数组必须与已认领关联一致。约束检查结构字段，不扫描正常正文中的 password/token 字样。快照禁止更新和删除。

事务顺序为：typed 业务变化与事件/通知 → 完整快照 → vendor submission 身份指针 → 通用 receipt 同一指针。通用指针严格限定 8 个字段，并与快照 scope/key/digest/event 双向核对；vendor submission 与通用指针继续满足原有完全相等触发器。legacy 使用内部 `recordLegacyVerificationResult` receipt，不伪造 submission；两种请求家族仍检查同 key 冲突。内部通用 BugAction 沿用 255 字符 key 上限，冻结结果 HTTP 入口独立限制 200。

重放先授权，再按完整作用域和摘要读取快照，只把 `replayed` 改为 true；不会按当前 Bug 重组原 DTO。Bug 后续编辑、非首轮人工接管、同键竞争、异 body、撤权、错项目、软删除均有实测。结果中的 `parentAttemptId/targetBuildId` 与公共人工 Attempt 投影改为真实已查询列；原 null 分支保留。非 null 父轮次由现有人工接管 HTTP 产生；没有伪造外部构建或 Relay 成功。

恶意 SQL 结构负例覆盖重复 key/缺少 null 字段、bool 冒充整数、额外结构字段、错误作用域/actor/digest/event、指针替换/注入等；包含合法控制插入，整段事务随后回滚。另给最终 receipt 添加独立测试故障触发器，验证 vendor/legacy 在末尾失败时领域、审计、通知、快照、submission、reserved receipt 全部回滚；没有停用任何现有领域触发器。

## 历史与恢复

固定提交 `3baff66d84dd6ad2f9b5f48230ff4375510269ec` 的旧 result writer 经 Node 本地类型剥离后，仅在测试数据库执行。原文件 SHA256 为 `b6e77504faeb146078d01e17d6d96a2546ebdf51380f097645198f1c3dad7458`。它生成真实 typed 历史结果和旧 IDs-only submission；新 worker/HTTP 对重放返回 `412 VERSION_CONFLICT`，说明原回执不可用并指向保留历史。原行、事件和版本不变，Verification/Bug GET 仍可读取。没有自动补造快照、重跑结果或修改旧 submission。

14→15 演练使用合法 schema14 Bug，逐项对照 **69 张旧表**不变；升级前 online backup 仍可作为 schema14 数据库读取，升级后独立恢复副本为 schema15 并读回同 Bug。另恢复带新长结果的完整数据库，再用新 worker 重放出原 DTO。副本和失败现场均保留。这是本地数据恢复验证，未运行旧服务程序，也不是已部署实例的回退验收。

## 原始门禁与失败历史

最终门禁：

| 范围 | 原始日志 | 结果 |
|---|---|---|
| 全 API：227 MJS + 33 TS | `api-full-policy.txt` | 260/260 |
| 全 Storage：按现有 package test 列表调用本地 tsx | `storage-full-policy.txt` | 118/118 |
| 新真实 HTTP/SQLite | `http-policy-first.txt`，全量日志内也重跑 | 14/14，215 HTTP |
| 类型与 lint | `type-*-policy.txt`、`lint-policy.txt` | 通过 |
| 两版验证与冻结、加法合同检查 | `contracts10/11.txt`、`freeze10/11.txt`、`additive.txt` | 五项通过 |

第一次完整 Storage 命令被本机解包 npm.cmd 布局阻断；其后使用既有 package 中完全相同的测试文件清单与本地 tsx CLI，预先完成 Storage build。工具错误原日志保留。

开发失败包含：测试 helper 的表名/默认 Accept/调用签名错误；初版 schema 的 events 外键列错误；真实软删除 GET 可见性缺口；真实长控制字符审计大小缺口；初版无条件指定验收人限制导致原有多员工用例 116/118。每项原件及更正说明均在 result.json；没有删失败、关领域触发器或改旧期望换通过。

## 仍未完成

`blocked` 写入、结果附件 9–20 与 capture bundle、fail/supersede POST、workflow GET 属后续阶段；本阶段不声明其完成。历史 IDs-only 回执不能自动恢复为原完整 DTO。没有本阶段部署/客户端/MCP 实际验收，也没有真实外部构建、Relay 或其他组件执行证据。
