# MCP 冻结验收结果入口（源码与隔离 HTTP 验证）

本轮新增共享工具 `qa_record_verification_result`。它通过已有认证 HTTP 处理器提交 `passed`、`failed`、`blocked`，没有改变 `qa_bug_action` 的普通人工权限。候选目录为原 90 工具加 1；已安装 EXE、运行中的 API/服务端 MCP 仍属各自既有版本，本轮没有发布或操作这些实例。

## 实现范围与调用

产品增量只有 `apps/api/src/automation.ts` 和 `automation-verification-result.ts`。后者复用正式 `parseMobileRecordVerificationResultRequest`，仅接受显式 `projectId`、`verificationId`、`request` 和可选 `idempotencyKey`，禁止未知字段、旧 JSON 请求或请求体注入内部权限标志。

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "qa_record_verification_result",
    "arguments": {
      "projectId": "11111111-1111-4111-8111-111111111111",
      "verificationId": "22222222-2222-4222-8222-222222222222",
      "request": {
        "submissionContractVersion": "1.1.0",
        "clientSubmissionId": "33333333-3333-4333-8333-333333333333",
        "expectedVersion": 2,
        "status": "blocked",
        "resultSummary": "当前验收暂不可继续",
        "blockedReason": "本次合成示例的验收条件暂不可用",
        "attachmentIds": []
      }
    }
  }
}
```

示例 UUID 需替换为调用方的真实项目、验收记录与原始客户端提交 ID。省略键时按 `workflow:recordVerificationResult:verification:<verificationId>:v<expectedVersion>` 派生；显式键必须完全一致。不会生成或替换客户端提交 ID。

请求固定进入 `POST /api/v1/verifications/:verificationId/result`，使用 vendor 响应并转发原始 Bearer 或 Cookie/Origin/CSRF。Cookie 缺少 CSRF 时外层 HTTP 即返回 `403 CSRF_TOKEN_INVALID`；业务拒绝在成功的 JSON-RPC HTTP 信封内保留 `isError`、业务 `code` 与 `status`。当前项目资格和指派验收人关系在首次提交和每次重放时重新核验。

已有 `/api/v1/mcp/tools`、`/mcp tools/list` 与共享 `/api/v1/mcp/call` 自动使用同一个目录。桌面 shared API 模式通过 `apps/desktop/src/mcp-api.ts` 的动态目录与通用转发取得该工具，无新增桌面源码或 main/app 注册点。本次没有执行已安装客户端刷新或完整 main/server-MCP 进程验收。

## 已执行验证

- `runs/final-related-regression.txt`：8 个相关测试文件共 **92/92**，涵盖原 MCP 协议、附件/capture、501 评论与 101 附件分页、冻结响应，以及 Phase A/B 结果兼容。
- 其中新测试文件为 **6 组、7 个独立真实 SQLite worker、137 条实际随机 loopback HTTP 请求，schema 17**。137 仅是新测试文件计数，包括初始化、登录、准备和读回；不是全部 92 项的 HTTP 总数，也不把内部 `app.inject` 算作额外网络请求。
- passed/failed/blocked 首写后分别通过直接冻结 HTTP、JSON-RPC 工具和共享 HTTP 入口重放；逐字段比较完整原 vendor DTO（仅 `replayed` 合法变化）。修改 Bug 标题后仍返回原回执，异正文同键拒绝且表内容不变。
- blocked 检查完整修复轮次行不变、有效父轮次 ID、清空 active Verification 而保留 active Attempt；再创建新 Verification 并通过后，旧 blocked 回执仍按原版本返回。
- 显式/派生 canonical 键、未知参数、内部标志注入、无客户端 ID、旧 JSON、缺少或混合原因、错误目标版本、错误项目、非成员、非指派验收人、Cookie CSRF、撤权与软删除均有实际拒绝及原业务表不变断言。
- 普通 peer 的旧 `qa_bug_action verify_pass` 仍成功关闭并留下该 peer 的 `events.actor_user_id` 和 snapshot actor；相同 peer 调用冻结新工具被拒。旧 action `blocked` 仍为不支持，不偷偷映射成 failed。
- 定向 ESLint、Prettier、Node 语法检查和 API `--noEmit` 均 exit 0。API/Storage 构建由 Phase D 集成代理串行完成，本轮未并行写 dist。新夹具如实使用已集成的 schema 17。

`retained-fixture-audit.json` 另对四次相关运行保留的 **25 个已关闭 worker 的临时数据库**执行只读 `integrity_check`、`foreign_key_check`、schema 与计数核对，记录数据库和 immutable result snapshot 的字节 hash。该作者审计不替代独立源码 review。数据库含合成测试会话，留在所列私有临时目录，没有复制到 Git。

## 原始失败保留

1. `runs/first-actual-http.txt`：旧协议 7/7 通过，新 5 组在 `/mcp` 初始化 404。新夹具漏传 `automationPublicApiOrigin`，而正式 main 已配置；仅补夹具注册，未改变产品或错误预期。原测试版本见 `first-fixture.mjs.txt`，5 个库和 58 次基础 HTTP 原样保留。
2. `runs/second-actual-http.txt`：12/12，通过的 5 组新测试共 6 个库、122 HTTP，随后新增普通人工权限对照。
3. `runs/final-actual-http.txt` 虽名为 final，实际为 **12/13 通过的保留失败**：新增对照已成功执行旧人工关闭，随后作者错误读取 `events.actor_id`；真实列为 `actor_user_id`。原测试见 `human-comparison-fixture.mjs.txt`。只修正证据查询列名，没有删除或放宽 actor 断言。7 个库、136 HTTP 保留。
4. `runs/final-related-regression.txt`：修正列名后的最终相关回归 92/92，包含新增权限对照。

## 边界

这是真实 Fastify + 正式 SQLite worker 的随机端口测试，不是完整 main 启动或已安装客户端 E2E。没有访问常驻 4419/4421/4274、EXE、APK、生产目录或外部执行器；没有声明新工具在历史 90 工具运行实例已经上线。新结果测试使用空附件，未把附件 9–20 张、capture 结果绑定或外部任务执行记为新增验证。本轮没有修改冻结合同、矩阵、普通人工角色或现有 A/B 证据。

四个源/测试和相关 dist 的实际 SHA、保留库路径及原始日志 SHA 位于本目录 JSON 索引。源码提交基线记录为 `3b57719deed8d907fa84bba232e2939d18288351` 加本工作树增量；同时存在 D 公共接线，不能把整个工作树称为该提交的干净构建。
