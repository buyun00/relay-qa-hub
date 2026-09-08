# 项目 HTTP 与 MCP 调用说明

适用本工作树独立预览。API 为 `http://127.0.0.1:4419`，服务端 MCP 为 `http://127.0.0.1:4421/mcp`，预览桌面本地 MCP 为 `http://127.0.0.1:4420/mcp`。以下示例使用服务端入口，示例不会自动执行；姓名、项目、Bug、版本与凭据必须换成已经确认的测试对象。

服务端 MCP 的工具通过固定适配器进入同一 HTTP 业务处理器，继续检查会话、项目成员、GM、版本和幂等。工具不能提交任意 HTTP 路径、SQL、服务端文件路径或外部凭据。`/api/v1/mcp/call` 是同一工具适配器的简化 HTTP 包装，`/mcp` 才是 JSON-RPC 协议入口。

## 初始化、会话与项目

本实现是无状态 JSON 响应传输，不建立 `Mcp-Session-Id`，也不提供 SSE。MCP 传输标识不能代替业务登录令牌。服务端支持 `2025-06-18`；初始化请求其他版本时协商返回 `2025-06-18`。客户端若不支持该返回版本应停止。后续请求应带协商后的 `MCP-Protocol-Version`；未知或无效版本头返回 HTTP 400。缺版本头时保留既有单消息调用兼容，但不声明支持旧版完整协议：`2025-03-26` 明确要求接收 batch，而本入口不支持 batch。

PowerShell 7 示例，令牌仅保存在当前进程变量中，避免把它打印到日志或硬编码进脚本：

```powershell
$qaApi = 'http://127.0.0.1:4419'
$qaMcp = 'http://127.0.0.1:4421/mcp'
$qaProjectId = 'REPLACE_WITH_CONFIRMED_QA_PROJECT_UUID'
$qaRpcId = 0
$qaRpcHeaders = @{
  Accept = 'application/json, text/event-stream'
  'MCP-Protocol-Version' = '2025-06-18'
}

function Invoke-QaRpc {
  param([string]$Method, [hashtable]$Params = @{})
  $script:qaRpcId++
  $payload = @{
    jsonrpc = '2.0'; id = $script:qaRpcId
    method = $Method; params = $Params
  } | ConvertTo-Json -Depth 100 -Compress
  $envelope = Invoke-RestMethod -Method Post -Uri $qaMcp `
    -Headers $qaRpcHeaders -ContentType 'application/json' -Body $payload
  if ($null -ne $envelope.error) {
    throw "MCP protocol error $($envelope.error.code): $($envelope.error.message)"
  }
  return $envelope.result
}

function Invoke-QaTool {
  param([string]$Name, [hashtable]$Arguments = @{})
  $result = Invoke-QaRpc 'tools/call' @{ name = $Name; arguments = $Arguments }
  $value = if ($null -ne $result.structuredContent) {
    $result.structuredContent
  } else {
    ConvertFrom-Json -InputObject $result.content[0].text -Depth 100 -NoEnumerate
  }
  if ($result.isError) { throw "QA business error: $($value.code)" }
  return $value
}

$initialized = Invoke-QaRpc 'initialize' @{
  protocolVersion = '2025-06-18'
  capabilities = @{}
  clientInfo = @{ name = 'qa-preview-operator'; version = '1' }
}
$qaRpcHeaders['MCP-Protocol-Version'] = $initialized.protocolVersion
# A notification has no JSON-RPC id. A successful response is HTTP 202 with no body.
$notification = @{ jsonrpc = '2.0'; method = 'notifications/initialized' } |
  ConvertTo-Json -Compress
$null = Invoke-WebRequest -Method Post -Uri $qaMcp -Headers $qaRpcHeaders `
  -ContentType 'application/json' -Body $notification

$principal = Invoke-QaTool 'qa_login' @{
  projectId = $qaProjectId; name = 'REPLACE_WITH_CONFIRMED_EMPLOYEE_NAME'
}
$qaRpcHeaders.Authorization = "Bearer $($principal.accessToken)"
$qaHttpHeaders = @{
  Authorization = $qaRpcHeaders.Authorization
  Accept = 'application/vnd.relay-qa-hub.v1.1+json'
  'X-QA-Project-Id' = $qaProjectId
}
$projects = Invoke-QaTool 'qa_list_projects'
$session = Invoke-QaTool 'qa_get_session'
```

`initialize` 必须包含非空 protocolVersion、capabilities 对象，以及含非空 name/version 的 clientInfo 对象。普通请求 id 使用字符串或可精确表示的整数，不能为 null、小数或不安全整数；不要重复使用请求 id。合法无 id 通知仅返回 202，不会执行工具写入。业务工具调用必须使用有 id 的 `tools/call` 请求。

姓名登录只加入明确所选项目；已停用成员不能通过重新登录恢复。业务身份是稳定 userId，不能用姓名冒充 GM。GM 工具登录为 `qa_login_gm`，参数形如 `{"request":{"password":"REPLACE_WITH_INDEPENDENT_GM_PASSWORD","projectId":"QA_PROJECT_UUID"}}`；密码从独立实例秘密来源读取，不写入配置模板或调用日志。GM 稳定 ID 由服务端配置决定。

GM 也可用 `{"projectId":"QA_PROJECT_UUID","request":{"password":"REPLACE_WITH_INDEPENDENT_GM_PASSWORD"}}` 明确选择项目，服务端会把顶层 projectId 合入正式登录 body。若顶层与 request.projectId 同时存在，必须一致，否则返回 PROJECT_MISMATCH，不创建另一项目会话。服务端 MCP、HTTP 适配器和桌面入口遵循同一选择规则。

所有项目操作明确携带 `projectId`。HTTP 可使用 `/api/v1/projects/<UUID>/...` 项目路径或 `X-QA-Project-Id`；存在路径、header、body、query 的多个项目值时必须一致。旧记录路径也核对记录所属项目。切换项目后更新调用参数和 header，不能依赖默认首项目。每次请求重新检查成员资格；撤销 A 项目成员不等于撤销 B 项目的独立会话。

## 同一动作的 HTTP 与 MCP 示例

读取员工目录的三个入口返回同一业务数据：

```powershell
# JSON-RPC MCP
$members = Invoke-QaTool 'qa_list_members' @{ projectId = $qaProjectId }

# Direct HTTP
$membersHttp = Invoke-RestMethod -Method Get `
  -Uri "$qaApi/api/v1/projects/$qaProjectId/members" -Headers $qaHttpHeaders

# HTTP tool adapter, without the JSON-RPC envelope
$body = @{ name = 'qa_list_members'; arguments = @{ projectId = $qaProjectId } } |
  ConvertTo-Json -Depth 20 -Compress
$membersAdapter = Invoke-RestMethod -Method Post -Uri "$qaApi/api/v1/mcp/call" `
  -Headers $qaHttpHeaders -ContentType 'application/json' -Body $body
```

创建测试 Bug 时，同一逻辑提交保留一个 clientSubmissionId。下例为 MCP 写入；对应直接 HTTP 为 `POST /api/v1/bugs`，body 加相同 projectId，header 使用 `Idempotency-Key: submission:<clientSubmissionId>:commit`。MCP 根据同一 clientSubmissionId 生成该幂等键。

```powershell
$qaSubmissionId = [guid]::NewGuid().ToString()
$qaCreation = @{
  submissionContractVersion = '1.1.0'
  clientSubmissionId = $qaSubmissionId
  title = '独立预览 API 合同验证'
  description = 'REPLACE_WITH_ACTUAL_OBSERVATION'
  expectedBehavior = 'REPLACE_WITH_ACTUAL_EXPECTATION'
  severity = 'S3'; priority = 'P3'; attachmentIds = @()
  occurrence = @{
    observedAt = [DateTimeOffset]::UtcNow.ToString('o')
    platform = 'web'
    steps = @('REPLACE_WITH_ACTUAL_REPRODUCTION_STEP')
    actualBehavior = 'REPLACE_WITH_ACTUAL_BEHAVIOR'
  }
}
$created = Invoke-QaTool 'qa_create_bug' @{ projectId = $qaProjectId; request = $qaCreation }
$qaBugId = $created.bug.id
```

变更之前重新读取记录，并使用返回的版本。下列人工完成动作只应用于实际已经人工修复的测试 Bug；它进入待验收阶段，不能证明验收通过或关闭。

```powershell
$context = Invoke-QaTool 'qa_get_bug_context' @{ projectId = $qaProjectId; bugId = $qaBugId }
$qaActionKey = "operator:$([guid]::NewGuid())"
$qaAction = @{
  action = 'manual_complete'
  expectedVersion = $context.bug.version
  note = 'REPLACE_WITH_ACTUAL_HUMAN_DELIVERY_NOTE'
}

# Use one entry point for this logical action; retain this key and body on transport retry.
$changed = Invoke-QaTool 'qa_bug_action' @{
  projectId = $qaProjectId; bugId = $qaBugId
  action = $qaAction.action; expectedVersion = $qaAction.expectedVersion
  note = $qaAction.note; idempotencyKey = $qaActionKey
}

# Equivalent direct HTTP request, when using HTTP as the chosen entry point:
# $actionHeaders = $qaHttpHeaders.Clone()
# $actionHeaders['Idempotency-Key'] = $qaActionKey
# $changed = Invoke-RestMethod -Method Post `
#   -Uri "$qaApi/api/v1/projects/$qaProjectId/bugs/$qaBugId/actions" `
#   -Headers $actionHeaders -ContentType 'application/json' `
#   -Body ($qaAction | ConvertTo-Json -Compress)

$after = Invoke-QaTool 'qa_get_bug_context' @{ projectId = $qaProjectId; bugId = $qaBugId }
```

expectedVersion 属于当前变更的记录：Bug 操作用 Bug.version，开始或提交验收结果用 verification.version。版本冲突时先读回并重新判断动作，不能只增加版本数字后重放。超时重试保留原幂等键和原 body；不同逻辑动作生成新键。参数校验或业务拒绝不会变成成功收据。

工具通用 `request` 字段承载对应 HTTP body，`query` 承载允许的查询参数，`idempotencyKey` 转发为 HTTP header。具体动作、字段和参数 schema 以当前工具目录及 HTTP 合同为准。`qa_bug_action` 的 action 枚举覆盖人工修复、验收与关单；关闭后 active verification 可为 null，历史验收从 `humanWorkflow.latestVerification` 读回。

## 评论和附件分页

`qa_list_comments` 与 `qa_list_attachments` 接受 `query.limit` 和 `query.cursor`，对应 HTTP 的 `?limit=...&cursor=...`。评论默认每页 100、最多 500；附件默认 50、最多 100，保持原有每页限制。响应增加 `nextCursor:string|null`；只有 nextCursor 为 null 才到达末页。不要把第一页当所有记录，也不要在末页把空游标重新提交成第一页。

```powershell
$qaComments = @()
$qaNextCursor = $null
do {
  $qaPageQuery = @{ limit = 500 }
  if ($null -ne $qaNextCursor) { $qaPageQuery.cursor = $qaNextCursor }
  $qaPage = Invoke-QaTool 'qa_list_comments' @{
    projectId = $qaProjectId; bugId = $qaBugId; query = $qaPageQuery
  }
  $qaComments += $qaPage.items
  $qaNextCursor = $qaPage.nextCursor
} while ($null -ne $qaNextCursor)
```

附件使用同样循环，将工具改为 qa_list_attachments、每页 limit 设为 100。游标是不透明的 createdAt/id 后续位置，绑定账号、项目、Bug 和列表类型；跨项目、跨 Bug、评论/附件混用或损坏游标返回 INVALID_CURSOR。每一页重新验证当前成员资格。分页不是跨请求冻结的数据快照。

`qa_get_bug_context` 的 comments 与 attachments 各返回一页及其 nextCursor，可通过对应列表工具继续读取。`qa_materialize_attachment`、`qa_read_attachment` 与 resources/read 会内部沿所有附件页定位特定 attachmentId，仍执行原 Bug 绑定、项目权限及内容校验；不会因目标处于第 51 或第 101 条后误报不存在。异常上游重复游标会明确失败，避免无限请求。

qa_list_projects、qa_list_members、qa_list_users 也会转发 query.limit；它们是否支持 cursor 以各自 HTTP 合同为准，目前目录接口不支持游标，传入会明确拒绝。

## Cookie 会话与退出

自动化通常使用上述 Bearer。Web Cookie 会话必须通过正式 HTTP 登录取得 Cookie，不能手工假造人员标识。示例使用预览 Web 已配置来源：

```powershell
$qaWebOrigin = 'http://127.0.0.1:4274'
$webLogin = @{ client = 'web'; projectId = $qaProjectId; name = 'REPLACE_WITH_CONFIRMED_EMPLOYEE_NAME' } |
  ConvertTo-Json -Compress
$webPrincipal = Invoke-RestMethod -Method Post -Uri "$qaApi/api/v1/auth/login" `
  -Headers @{ Origin = $qaWebOrigin } -ContentType 'application/json' `
  -Body $webLogin -SessionVariable qaCookieSession
$qaCookieHeaders = @{
  Origin = $qaWebOrigin
  'X-CSRF-Token' = $webPrincipal.csrfToken
  'X-QA-Project-Id' = $qaProjectId
}
```

随后 Cookie HTTP 或 MCP 请求传 `-WebSession $qaCookieSession`；写操作保留真实 Origin 和 X-CSRF-Token。Cookie 名由独立实例配置，不能硬编码生产 Cookie 名。`/mcp` 的 Origin 只接受明确配置的 API/Web 来源；无 Origin 的本地自动化请求可用，非法来源返回 403。Bearer 请求同样不能通过伪造 Origin 绕过该校验。

退出业务会话使用 `qa_logout` 或 `POST /api/v1/auth/logout`。`DELETE /mcp` 返回 405，因为本实现没有 MCP 传输会话可销毁；它不会替代业务退出。API 与 MCP 的鉴权、成员停用和退出均进入同一服务。

## 附件与资源读取

`qa_materialize_attachment` 返回授权下载地址及 `qa-hub://attachment/<projectId>/<bugId>/<attachmentId>` 资源 URI。服务端不会返回任意本地文件。`qa_read_attachment` 或 `resources/read` 返回经过成员、Bug 绑定、内容状态和哈希核对的 base64 数据，单资源上限 32 MiB。

```powershell
$qaAttachmentId = 'REPLACE_WITH_ATTACHMENT_UUID_BOUND_TO_THIS_BUG'
$materialized = Invoke-QaTool 'qa_materialize_attachment' @{
  projectId = $qaProjectId; bugId = $qaBugId; attachmentId = $qaAttachmentId
}
$resource = Invoke-QaRpc 'resources/read' @{ uri = $materialized.resource.uri }
$bytes = [Convert]::FromBase64String($resource.contents[0].blob)

# Alternatively read the authorized HTTP download URL with the same session/project headers.
# Invoke-WebRequest -Uri $materialized.downloadUrl -Headers $qaHttpHeaders -OutFile $chosenOutputPath
```

截图采集包的次级产物会通过所属 Bug 的 capture artifact 路径读取。仅知道 attachmentId、captureId 或 URI 不能跨项目读取。`file://`、未绑定附件、停用成员、隔离/失败内容及哈希不匹配都会拒绝；不要绕过接口直接读服务端证据目录。

上传遵循 init → chunk → finalize → bind → 创建/更新业务记录的既有合同。`qa_put_upload_chunk` 使用 bytesBase64/chunkSha256/chunkNumber/expectedVersion/clientSubmissionId/clientAttachmentId/idempotencyKey，对应同一原始分块 HTTP PUT。单分块上限 8 MiB，MCP POST 总 body 上限 36 MiB。请按实际字节选择 MIME；扩展名、声明类型和内容不一致时不能靠重试绕过校验。

## 90 工具目录与固定 HTTP 映射

读取当前实例目录：`GET /api/v1/mcp/tools` 或 JSON-RPC `tools/list`。二者由同一 `AUTOMATION_TOOLS` 生成，当前共 **90** 个唯一工具，其中 **66** 个直接 HTTP 映射，另 **24** 个处理登录、组合上下文、附件内容或特殊提交合同。不要复制一份手工维护的工具清单。

在工作树根目录先编译 API，然后运行以下只读生成入口，输出完整 definitions、必填字段、注解及当前固定映射。组合适配器标为 `automation.ts dispatch`，其实际路由仍由同一服务端 switch 确定。

```powershell
node .tools/npm-12.0.2/package/bin/npm-cli.js run build --workspace @relay-qa-hub/api
@'
import { AUTOMATION_TOOLS } from './apps/api/dist/automation.js';
import { AUTOMATION_HTTP_ROUTES } from './apps/api/dist/automation-routes.js';
const entries = AUTOMATION_TOOLS.map(tool => {
  const route = AUTOMATION_HTTP_ROUTES.find(item => item[0] === tool.name);
  return {
    ...tool,
    http: route ? { method: route[2], path: route[3] } : { adapter: 'automation.ts dispatch' }
  };
});
if (entries.length !== 90 || new Set(entries.map(item => item.name)).size !== entries.length)
  throw new Error('Review the current tool catalog before using this documented count');
process.stdout.write(JSON.stringify({ count: entries.length, tools: entries }, null, 2) + '\n');
'@ | node --input-type=module
```

主要源码：[automation.ts](../../../apps/api/src/automation.ts)、[automation-routes.ts](../../../apps/api/src/automation-routes.ts)、[bug-actions.ts](../../../apps/api/src/bug-actions.ts)。桌面本地 MCP 转发同一 HTTP 业务并额外负责本机附件落盘；服务端 MCP 和本地 MCP 的启动/连接入口独立，不能把其中一个监听正常当另一入口或业务执行已经验证。

## 协议错误与本次回归

JSON 语法错误返回 HTTP 400 / JSON-RPC -32700；非法单消息结构、batch、非法 id 返回 400 / -32600；未知 method 返回 -32601；initialize、tools/call 外层参数及未知工具返回 -32602。合法业务调用的权限、版本或执行失败保留 `result.isError:true` 和原业务 code/status/details。`resources/read` 的远端业务读取失败为协议 error，不产生假内容。

合法无 id 通知及已接收的 JSON-RPC 响应返回 HTTP 202 空 body；被拒绝的通知可返回 HTTP 错误，但不会返回 JSON-RPC 响应。GET/DELETE `/mcp` 返回 405 和 `Allow: POST`。HTTP POST 响应为 application/json；客户端应发送同时接受 JSON/SSE 的 Accept，当前服务保留对省略 Accept 的旧调用兼容。MCP parser 错误处理仅作用于 `/mcp`，不改变普通 API 的错误合同。

按 MCP 官方 [2025-06-18 传输规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)、[生命周期规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)、[工具错误规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) 及 [JSON-RPC 2.0](https://www.jsonrpc.org/specification) 检查。新增 automation-protocol.test.mjs 使用随机本地 TCP 端口，覆盖初始化/版本、非法 JSON 与 id、无 id 不执行业务、响应消息、错误分层、90 工具合同、Origin、版本 header、GET/DELETE，以及真实 BrowserAuth + SQLite 的 GM 项目选择、冲突拒绝和会话读回。**6/6** 通过；联合已有真实 HTTP + SQLite 上传/绑定/资源和采集包测试，共 **11/11**（含子测试）通过。API build、两个修改文件 ESLint/Prettier 通过。既有真实 MCP smoke 的 initialize 已带完整 clientInfo，无需放宽参数校验。

本次测试没有连接运行中的预览或生产服务，没有调用外部执行器，也没有重启实例。组件的真实 Jenkins 构建、上传平台发布、Relay 修复/交付回调、轻语同步仍缺获准的独立外部资源。构建或上传队列返回 taskId/chain/jobId 只证明接受与持久化；最终状态、产物和第三方结果必须另行读回验证，不能当作完成。配置与恢复说明见 [component-runtime.md](component-runtime.md)。

后续分页回归使用 501 条真实 HTTP 评论、101 个经过真实 HTTP 上传/校验/预绑定的小 PNG。为覆盖历史列表大于单次创建表单 20 个附件的情况，采用正式 Storage 创建事务一次认领这 101 个预绑定附件；没有 SQL 填充、关闭约束或伪造证据文件。真实 HTTP/MCP 分页证明同时间戳下按 ID 稳定读取、最后 nextCursor=null、跨项目/跨 Bug/跨列表游标拒绝、成员撤销后下一页拒绝，并从第 101 个附件通过 MCP/resources/read 读回完全相同字节。另有异常上游重复游标终止测试。初次 fixture 使用普通 text/plain 而被附件内容合同拒绝，随后改用实际合法 PNG；撤销 fixture 的旧固定时间早于真实登录时间也被 SQL 约束正确拒绝，已改为真实后续撤销时间后通过。

分页补丁后的最终验证：Storage/API build 通过，Storage 全套 **109/109**；automation protocol（现 **7/7**）、分页、原 integration/capture 和 project-management 联合 **15/15**（含子测试）通过。修改文件 ESLint/Prettier 通过。本次没有新增工具，目录仍为 90 项。
