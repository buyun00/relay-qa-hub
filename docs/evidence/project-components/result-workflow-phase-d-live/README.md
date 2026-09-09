# schema17 / 91 工具完整 main 实际验收

本轮独立运行通过：**241 条真实网络请求、665/665 检查**。API 使用冻结副本完整 `main.js` 和正式 SQLite worker，服务端 MCP 使用独立 4461 转发至同副本 4459。实际执行新验收结果工具及 workflow GET，包括正常关闭、重开进程后继续原游标。没有部署现有预览或操作任何客户端。

实际运行时窗为 **2026-09-09T04:02:39.010Z–04:02:50.587Z**。请求分为直接 API 4459 **183** 条与服务端 JSON-RPC 4461 **58** 条；内部转发和 `app.inject` 不重复计数，启动 readiness 轮询也不冒充 ledger 中的业务请求。9 个独立项目 fixture、10 个合成 Bug、所有数据库和审计保留。

## 固定输入与原件

产品输入提交 `5208a8aef2c777ad8f3bf8d3fe0fccb2120881c1`，含新增 MCP 结果工具提交 `f319b5f`。根代理在启动前逐字节审查 plan、config、Node、guard 和 5,815 文件闭包。复制后的其他 C/E/工具源码修改不进入本次运行；本证据始终是 **schema17 / 91 工具**，不随后续工作树目录数变化。

| 原件 | SHA256 |
| --- | --- |
| `scripts/project-components/result-workflow-phase-d-e2e.mjs` | `44e8453584a5484ca463b06acf7aaf5254865a14112aebef0e93ffbf36c1799d` |
| 私有 `plan.json` | `dfe24ec1c116629f730150b0290de58a0ad8a05b7f1b8f3c174a321781b503e2` |
| 5,815 文件 `closure.json` | `cb49b92ba6d164c8e20eb0fe680090cb620e4462abf72229fbddde251671ec3b` |
| `runtime/instance.json` | `ac0c6b292d53869d3641ddfe372810f15a8e622c42d993cf148fbe07efe73649` |
| 复用的冻结 Phase B guard | `a11df8fc32fb3bbc927b937596fa1a512a3486805837fde7394eb1cd001f0346` |
| `69618261-6c5a-4092-a8a6-2168a2768c8e/667b0e87-e0fd-44bd-8bb3-c0506dbf5b81/result.json` | `a20f087468dd5bd29adef84359662313d6755ecde0c76c8ea4624b87fe18a08b` |
| 同运行目录 `audit-1788926811237.json` | `1e4de8a48cf6cadab96070e0122922f0bca8c40b4830e659aeaf574f6cb6e7ff` |

私有根为 `C:\Users\lin0\.codex\parallel-runtimes\result-workflow-d-69618261-6c5a-4092-a8a6-2168a2768c8e`。源码、配置、秘密文件、数据和 runs 均属于这一新实例；秘密未进入公有日志。`plan.md` 与静态准备日志保留其运行前历史时点，当前执行事实以本 README 和原始 result 为准。

## 实际结果与权限

新工具 `qa_record_verification_result` 在真实服务端 JSON-RPC 分别首写 passed/failed/blocked，并与直接冻结 HTTP 原 DTO 逐字段比较。默认/显式 canonical key 重放没有新效果；后来编辑标题或完成下一次 Verification 后仍返回原回执。异正文同键、未知字段、内部权限标志注入、错误目标版本、错误项目、非指派员工、撤权和软删除均实际拒绝，拒绝前后业务表 hash 保持。Cookie 经过服务端 MCP 时也必须提供正确 CSRF。

blocked 保留已交付的整个 Attempt 行及真实父轮次关系，只清除当前 Verification 指针；另建并完成下一次 Verification 后，旧 blocked 结果仍可按原键读回。旧 JSON/vendor blocked 请求继续与正式 HTTP 一致。原 `qa_bug_action` 仍保留普通人工闭环权限，旧 action `blocked` 仍明确不支持；没有借新工具改变这条旧语义。

后置只读审计 **186/186**：对实际数据库的 12 个 immutable result snapshot（6 blocked、1 failed、5 passed）核对 actor/project/verification、typed event、原结果版本、digest、提交幂等键和 committed receipt pointer。另对 ledger 中 29 个成功的 HTTP 或新 MCP 结果，使用冻结副本投影逐字段比对其原 SQL snapshot，不从当前 Bug 重建历史回执。审计是作者后置核对，不能替代另行独立审查。

## workflow 游标与真实进程重开

workflow fixture Bug `7e1ce128-16ca-482c-a55f-0b72e0fe3660` 通过实际 HTTP 人工接管形成父/子两个 Attempt。limit=1 共返回两页，含 1 occurrence、2 repairAttempts、1 verification；builds 和 relayReceipts 是明确空集合。

首次 snapshot 为 Bug version 7、Verification in_progress；第一页之后真实通过新 MCP 工具写入 blocked，当前 Bug 变为 version 8。原 cursor 页仍固定原版本和 snapshotSequence；新 snapshot 则返回 blocked。随后正常关闭 API/MCP，端口释放后重开同一私有副本，再提交同一 cursor 得到完全相同的原页。遍历终止为 nextCursor=null，没有重复 ID。

malformed/tampered cursor、变更 limit、换 Bug、换 actor、跨 project 和媒体拒绝均实际覆盖；每个拒绝后业务表及三个 projection 表保持。停用员工后拒读；恢复员工后旧 cursor 因 membership 变化失效，而新 snapshot 可用。最后软删除该新 Bug，新旧读取均拒绝，三个历史 snapshot 继续保留。vendor Content-Type、公开 DTO 字段白名单和没有私有签名键返回也由原件及后置审计核对。

## 停止与恢复点

| 角色 | PID | 启动 UTC | 官方正常退出 UTC |
| --- | ---: | --- | --- |
| API 第一轮 | 19404 | 04:02:40.432 | 04:02:46.472 |
| MCP 第一轮 | 7640 | 04:02:41.406 | 04:02:46.320 |
| API 重开 | 2356 | 04:02:47.542 | 04:02:50.464 |
| MCP 重开 | 22748 | 04:02:48.332 | 04:02:50.346 |

四个 owned Node child 均由 IPC 触发产品官方 SIGTERM handler，exit 0。审计同时核对 child 退出记录、冻结 Node 可执行文件、启动/退出时窗、固定 PID 的 CIM 当前创建身份及 4459/4461 listener；本次这些 PID 均已不存在，端口均空。审计逻辑允许明确晚于原退出时点的新 PID 生命周期，不把 PID 复用误认为原进程仍在运行，也不杀任何新进程。

两份 SQLite online backup 位于私有根的 `runs\667b0e87-e0fd-44bd-8bb3-c0506dbf5b81\consistent-before-stop.sqlite` 与 `consistent-after-stop.sqlite`。两份均 **2,293,760 字节**，同 SHA256 `3b6c72869fa7669e88e7800f6952fac3c4dd3ea258a42853d319c75f627cb636`。实际数据库与两份恢复点均 `PRAGMA user_version=17`、integrity ok、FK 0，12 个原回执字节相同。ready 明确返回字符串 `schemaVersion: "17"`，database/evidence/worker 均 ok。

## 保留边界

准备曾因 harness 把直接发布 index.js 的 upload-contract 包误当成 dist 包而失败，发生在 mkdir 前；初次工具输出、同错误真实复现日志和原候选源码均保留，仅修正清单路径。随后一次实际 full-main run 即通过，没有重做或清理业务 fixture。

guard self-test 在主线程及 Worker 各实拒 10 类越界操作；实际 API 两次和 MCP 两次的 forbidden-attempt 日志均为空，五组件持续关闭，import hold 持续 paused，闭包运行前后完全相同。没有访问原 4419/4421/4274、生产数据、EXE/APK、全局配置；没有外部执行器任务、真实构建或文件上传 E2E。本轮结果使用空附件；9–20 附件/capture 结果绑定以及非空 Build/Relay 分页不能据此记为通过。所有新项目、Bug、软删审计、数据库与日志永久保留，本轮没有提交或发布操作。
