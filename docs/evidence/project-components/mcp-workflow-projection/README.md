# 服务端 MCP 冻结工作流分页接线

本候选把已经由 HTTP 和 schema17 worker 验证的 `/api/v1/bugs/:bugId/workflow` 固定接入服务端 MCP，新增第 92 个工具 `qa_get_bug_workflow`。工具只接受显式 `projectId`、`bugId` 和可选 `query`，通过同一 `createApiApp` 内的正式 HTTP 路由取得 vendor DTO；MCP 成功结果的文本与 `structuredContent` 逐字段一致。

源码审查发现原通用适配器只在 `projectId` 是字符串时才转发项目头。对需要项目的工具传入 `null`、数字、布尔值或空字符串时，字段会被忽略，带 Bug ID 的 HTTP 路由可能再从记录推断项目。原始 12 请求失败及当时源码保存在 `before-scope-fix.*`、`automation-before-scope-fix.ts.txt` 和 `scope-negative-test.ts.txt`。修复后，所有 schema 明确要求 `projectId` 的工具在任何内部请求前统一调用非空字符串校验；这次观测证明的是显式项目校验缺陷，没有把它描述成已经发生的越权泄露。

## 实际组合验证

最终测试使用编译后的 `createApiApp`、正式 `ProjectRequestContext`、BrowserAuth 和真实 schema17 `SqliteStorageWorker`，监听随机 loopback 端口。一次运行执行 31 条真实 HTTP 请求：MCP 初始化、两种工具目录、三页冻结游标、直接 HTTP 对照、重复页、错误 query、错误 Bug/项目/人员/actor、GM 跨项目、成员停用/恢复、旧游标失效、新游标和软删除后拒读。三页共含 3 个真实 occurrence；`repairAttempts`、`verifications`、`builds`、`relayReceipts` 在本 fixture 中为空，因此不能据此声称五集合非空均已通过。

根代理在交接恢复后用同一源码重新执行：

- `node --test apps/api/test/automation-protocol.test.mjs apps/api/test/automation-verification-result.test.mjs`：13/13，通过；七个结果工具 worker fixture 共记录 137 条真实 HTTP 请求。
- `node --import tsx --test apps/api/test/automation-workflow-projection.test.ts`：1/1，通过；31 条真实 loopback HTTP，schema17、integrity ok、外键 0，临时数据库保留。
- 精确五文件 ESLint：exit 0；Prettier check：exit 0。

对应原始输出为 `root-final-normal-mjs.*`、`root-final-workflow-ts.*`、`root-final-lint.txt`、`root-final-format.txt` 和 `root-final-style.json`。`source-review.json` 是此前独立只读源码/产物复核；当前五个源码哈希与其冻结输入完全一致。编译后的 `automation.js` 和 `automation-routes.js` 也与 `scope-compiled-after`、`compiled-after` 中的保留副本逐字节一致。

## 保留范围与未完成项

最初 source HTTP 测试因错误地要求 MCP 错误响应包含 `structuredContent` 而失败；调整测试后通过。随后加入非法项目值时真实复现产品缺陷，修复后通过。这两类失败均原样保留，没有用最终日志覆盖。

本轮没有更新 4419、4421、4420、Web、EXE 或 APK，没有启停常驻预览和生产。它证明注册后的完整 Fastify 应用和 worker 组合可用，但不是完整 `main.js` 进程、服务端 MCP 转发进程重启或已安装 92 工具客户端验收。schema17/91 工具的完整 main 与 SIGTERM 重开证据另见 `../result-workflow-phase-d-live/README.md`；下一阶段仍需把本提交连同后续已接线功能构建到独立预览，再做真实 92 工具运行和客户端升级验证。冻结 workflow 合同清单仍遗漏其 400 枚举，该已知合同差距没有在本候选中重写。
