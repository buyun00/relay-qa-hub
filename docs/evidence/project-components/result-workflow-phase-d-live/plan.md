# schema17 / 91 工具完整进程验收计划

准备状态：**闭包已复制，实际服务验收尚未运行**。产品输入是已审提交 `5208a8aef2c777ad8f3bf8d3fe0fccb2120881c1`（含 MCP 工具提交 `f319b5f`）。D 集成证据记录 Storage 123/123、API 243 MJS + 33 TS；这里不把这些测试当成本计划的完整进程验收。

## 固定输入

- 新脚本：`scripts/project-components/result-workflow-phase-d-e2e.mjs`，SHA256 `44e8453584a5484ca463b06acf7aaf5254865a14112aebef0e93ffbf36c1799d`。无参数默认只输出 `not_run`；Node 语法、ESLint、Prettier 检查均通过。
- 独立根：`C:\Users\lin0\.codex\parallel-runtimes\result-workflow-d-69618261-6c5a-4092-a8a6-2168a2768c8e`，其中 `source` 与 `runtime` 为兄弟目录。
- `plan.json` SHA256：`dfe24ec1c116629f730150b0290de58a0ad8a05b7f1b8f3c174a321781b503e2`。
- 5,815 文件闭包 `closure.json` SHA256：`cb49b92ba6d164c8e20eb0fe680090cb620e4462abf72229fbddde251671ec3b`。
- `runtime/instance.json` SHA256：`ac0c6b292d53869d3641ddfe372810f15a8e622c42d993cf148fbe07efe73649`。
- 沿用冻结 Phase B preload guard 的原字节，SHA256：`a11df8fc32fb3bbc927b937596fa1a512a3486805837fde7394eb1cd001f0346`。`QA_PHASE_B_*` 变量和 IPC 命令名是复用协议名称，不表示本次使用旧 schema16 产品。

`--prepare <reviewed-commit>` 已执行一次成功，未发 HTTP。它先验证两份冻结 D/MCP 证据及其源文件 SHA，然后 create-only 复制已构建 API/Storage dist、直接发布 `index.js` 的 upload-contract 包与依赖闭包。复制前后重新核对全部输入树；没有 install/build、junction 或跨生产依赖。准备结果位于本目录 `69618261-.../prepare.json`，原输入、拷贝和工作树并行变更情况均记录。后续 C/E 源码变更不进入该副本。

首次准备在创建目录之前失败：新增稳定性检查误把 upload-contract 当成带 dist 的包，实际该包直接导出 `index.js`。首次错误在工具输出保留，同样失败的直接复现见 `preparation/prepare-before-fix-reproduced.txt`；原候选脚本见 `first-candidate.mjs.txt`。仅修正输入清单路径后成功，不改变产品，也没有保留半初始化的首次 runtime。

## 独立配置与执行约束

仅监听 API `127.0.0.1:4459`、服务端 MCP `127.0.0.1:4461`。4458 仅作为 Origin 配置，4460 仅作为未启动桌面端配置；不启动 Web 或客户端。运行前检查 4459/4461 没有 listener，冲突直接停下。数据、备份、下载、日志、桌面目录、人员文件、GM ID、cookie 名和随机秘密均属于本次新目录。默认项目/员工/Bug 全部是本脚本新建；不借生产或现有 preview 身份。

`dataRoot/.qa-hub-import-hold.json` 固定 paused；每个新项目实际读取五组件并确认全部关闭。API preload 禁止所有出站，MCP preload 只允许请求自己的 4459；子进程启动、非许可 socket/fetch/HTTP/TLS/UDP/DNS 都拒绝。先实际运行保留的 guard self-test（主线程和 Worker），成功才启动 main。该 guard 是受控 Node 程序的隔离防护，不是抵御任意恶意 native 代码的通用沙箱。

启动使用副本 `run-preview-service.mjs <新配置> api|mcp`，API 导入副本完整 `dist/main.js` 并启动正式 worker，不拼装测试 Fastify。记录每个 child 的 PID、Node 可执行文件、开始/退出时窗、日志及退出码。正常关闭通过已验证 IPC 命令触发产品官方 SIGTERM 处理。后置只读审计将逐个结合退出事件、可执行文件和 CIM 创建时点核对，PID 后续被复用时区分新进程；不据同 PID 杀进程。

## 计划实际动作

1. 完整 main/worker readiness、schema_migrations 17，后置只读 PRAGMA user_version 17；服务端 JSON-RPC initialize/通知与 tools/list 91，原工具除新增项仍为 90。
2. 保留 Phase B 的旧 JSON/vendor blocked、原因/版本/当前授权、后续新 Verification 与旧回执检查，以及现有 MCP 人工评论和闭环对照。
3. 新工具分别提交 passed/failed/blocked。比较直接 HTTP 和服务端 MCP 原 DTO、默认/显式 canonical 键、后续标题变化后的原回执。覆盖错误键、未知字段/内部权限注入、目标版本、项目、非指派人、Cookie CSRF、撤权恢复和软删除。blocked 后再新建验收并通过，原 blocked 回执保持。
4. 新 Bug 用真正人工接管形成父/子两个 Attempt。workflow vendor GET 以 limit 1 分页；在第一页后真实提交 blocked，旧页保持原状态和版本，新 snapshot 看到新结果。
5. 正常关闭本次 MCP 与 API，确认旧端口释放后重启同一副本。用同 cursor 读取完全相同的已持久页，遍历直到 nextCursor=null，检查唯一 ID、固定 snapshotSequence/Bug version 和终止条件。
6. malformed/tampered cursor、换 limit、换 Bug/actor/project、不可接受媒体均拒绝，检查业务表和三个 projection 表不变。撤权后拒读，恢复后旧 cursor 失效但可新建 snapshot；软删除后新旧读取都拒绝，历史 projection 保留。
7. 正常最终关闭，保留停止前/后的 SQLite online backup、结果与原始过程日志，复核 FK/integrity、hold、闭包和外部 guard 日志。任何失败原件都保留。

基础请求限官方登录、GM 新项目/员工资格、Bug/Attempt/Verification/评论/人工动作、组件只读列表和 workflow GET；结果新工具走服务端 4461 真 JSON-RPC。直接 SQL 只用于读取一致状态和 online backup，不造业务数据。本次 workflow 的 builds/relayReceipts 为明确空集合，不把它们说成外部执行器或非空任务分页已验。

## 审核后运行命令

```powershell
node scripts/project-components/result-workflow-phase-d-e2e.mjs --run 'C:\Users\lin0\.codex\parallel-runtimes\result-workflow-d-69618261-6c5a-4092-a8a6-2168a2768c8e\plan.json' dfe24ec1c116629f730150b0290de58a0ad8a05b7f1b8f3c174a321781b503e2
```

运行前再次核对 runner、Node、plan、config、闭包；输出和 fixture create-only。凭据只从独立私有文件进入内存，JSON 内嵌字符串递归脱敏且保留 `"2.0"` 等 primitive 字符串，公有证据执行已知秘密值精确扫描。不修改已有 4419/4421/4274、生产、EXE/APK、全局配置或旧 A/B 证据。
