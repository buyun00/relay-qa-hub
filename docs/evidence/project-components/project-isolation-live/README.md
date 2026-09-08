# HTTP / 服务端 MCP 项目隔离实际验收

第二轮选定场景通过：1,997 次真实请求、262 条断言，其中 100 次授权拒绝均有前后原项目读回，40 次为写入拒绝。首次运行因测试脚本变量初始化顺序错误而失败，原始日志和业务记录全部保留。没有将第一轮失败改写为通过。

对应设计 v2.1 基线 05「列表、详情、附件、日志、统计都不返回其他项目数据」、06「修改、评论、上传绑定和状态操作不能写入错误项目」，及 §16 独立运行、§17.2 各真实入口和错误项目验证。本证据只覆盖直接 HTTP 4419 与服务端 JSON-RPC MCP 4421，**不表示 05/06 跨全部客户端通过**。05 的组件任务日志子项本轮未执行。

## 执行范围和入口

- 源码基线 `cb9454b195071e78b006dab5cdac1b8a900a1b9c`，显式配置为 `C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\instance.json`。服务使用主任务固定的现有预览运行窗口，API 实际 readiness 返回 `ready` / schema `14`；没有部署、重启或加载并行修改中的源码。
- 唯一驱动为 [project-isolation-live.mjs](../../../../scripts/project-components/project-isolation-live.mjs)。直接 HTTP 不经过 `/api/v1/mcp/call`；MCP 使用 `/mcp` 的 `initialize`、无 ID `notifications/initialized`、`tools/list`、`tools/call` 与 `resources/read`。协议字面值 `"2.0"` 保持原样。
- 每轮用配置 GM 密码在内存中登录，仅创建本轮全新 C/D 项目及 C-only、D-only、shared 员工。shared 在两项目保持同一稳定人员 ID。两项目各自实际确认五组件均关闭。
- 所有请求限定 `127.0.0.1:4419` 和 `127.0.0.1:4421`；禁止重定向、组件执行/日志路由、服务控制、UI、本地 4420 与退出当前客户端。没有改变 EXE 会话或调用生产/日常 APK。
- 真实附件为 68 字节合法测试 PNG，经 init → 实际二进制 chunk → finalize → bind → Bug 创建事务认领；SHA-256 为 `6b1048f8a6d40bac0b2954c18fefa40c4ea7a96120fc2e54b7317c0e43c2bbec`。这只是 API 附件测试字节，不是设备取证或外部构建产物。

## 第二轮结果

时间为 `2026-09-08T22:12:32.958Z` 至 `2026-09-08T22:12:44.758Z`，运行 ID `006a3b46-258e-4be8-a184-b605b26293e9`。

| 记录 | 数量或结果 |
| --- | --- |
| 直接 HTTP 4419 | 1,880 次请求，含独立持久读回 |
| 服务端 4421 | 117 次请求，业务为真实 JSON-RPC |
| 已验证的读取拒绝 | 60 次 |
| 已验证的写入拒绝 | 40 次 |
| 拒绝前后原项目快照相同 | 100 / 100 |
| 所有断言 | 262 / 262 |
| 修正后脚本 SHA-256 | `de8dbd8ac16a78677e24c60046fe4ae4c6ea141878d92a47279f3ec2e30ee4ab` |

读取包括列表、详情、评论正文、Bug 事件、附件元数据、HTTP 实际字节、MCP 附件字节/资源、统计和分类。非成员请求目标项目得到 `403 PROJECT_NOT_ACCESSIBLE`；具有 C/D 双成员资格的员工用另一项目参数读取本项目记录得到 `404 NOT_FOUND`。项目列表/统计/分类没有记录 ID，因此双成员对另一项目的合法读取按该项目返回，而非强行期待拒绝。MCP `resources/read` 的业务拒绝使用协议错误 `-32002`，错误 message 保留对应业务 code。

写入逐项覆盖编辑、评论、附件绑定预留、人工完成、软删除。每项先用无成员员工和双成员错误项目各请求一次，随后由合法 shared 员工完成成功对照；没有以格式错误或不存在记录的请求充当隔离证明。MCP 工具业务失败是 HTTP 200 下 `isError:true` 及对应 code/status，并非把 HTTP 200 当作成功。

每次拒绝前后通过原项目合法身份读取完整 Bug（含状态、版本、归属）、Bug 列表、评论、事件、附件元数据、实际 PNG 字节、固定时间窗统计和分类，逐字段相等并记录快照 SHA。正向 MCP 读取与同操作者直接 HTTP 逐字段对照；字节通过解码和哈希比较。事件操作者也核对为该轮 shared 员工。

额外上传的绑定测试采用 `intent:"bug_create"`，证明跨项目附件 ID 不能被预留，并在合法预留后以同键重放读取同一 `bindingId`、版本和 `replayed:true`。**这些额外预留没有认领到既有 Bug**；不能声称已完成 verification-result 跨 Bug 绑定、预留到期恢复或所有附件意图组合。最初用于四个 Bug 的 PNG 则已由真实创建事务认领并成功下载。

成功对照把四个 Bug 人工完成至 `ready_for_verification` / v5，然后执行该脚本明确创建记录的软删除；原项目详情返回 404，列表不再出现。这里没有执行验收关闭，不把人工完成叫作关闭。项目、员工、原附件以及审计数据保留，没有清理。

| 入口/项目 | 项目 ID | Bug ID |
| --- | --- | --- |
| HTTP / C | `388be255-c610-432b-9f35-b87627e696fe` | `62c2c30b-3805-4a26-931e-1f6a1287a8f6` |
| HTTP / D | `ba45b31d-2eb2-4c27-8f9f-7e406d9b9442` | `649d8621-9701-4369-b39e-2e12c9155a49` |
| MCP / C | `388be255-c610-432b-9f35-b87627e696fe` | `24b06c92-17dc-4b31-8090-b165441e651f` |
| MCP / D | `ba45b31d-2eb2-4c27-8f9f-7e406d9b9442` | `404106ab-bd2f-4ef9-8d7a-ac1dfe6e3551` |

shared 操作者为 `e21141d7-b0b4-45a2-8bf1-a82de091c2c7`；两单项目员工及所有附件/预留 ID 在 [summary.json](006a3b46-258e-4be8-a184-b605b26293e9/summary.json) 中。逐请求原始脱敏记录为 [requests.jsonl](006a3b46-258e-4be8-a184-b605b26293e9/requests.jsonl)，断言为 [assertions.jsonl](006a3b46-258e-4be8-a184-b605b26293e9/assertions.jsonl)，进程输出为 [second-run.raw.log](second-run.raw.log)。

## 第一轮失败保留

`2026-09-08T22:10:25.643Z` 至 `22:10:27.948Z`，运行 ID `789bd648-e5df-43d7-b5b1-283327f83b07`，脚本 SHA 为 `c5faad15796b585d878243e15f5a8725a43cb786e32d2081ecd90d3387451512`。

运行记录 363 次请求、45 条已完成断言。HTTP-C 已完成 13 次读取拒绝及编辑/评论各两次写入拒绝，共 17 次拒绝和 17 次原项目不变快照。之后新增的附件预留重放检查块被错误放在 `const result` 定义前：它先合法建立了一次新附件预留，再发生 `ReferenceError: Cannot access 'result' before initialization`。该错误来自 harness，未观测到越权请求成功，也未据此改动产品或错误码期望。

修正只移动该检查块到成功请求结果定义之后，并增加执行前 `no-use-before-define` 变量/类检查。第二轮经主任务明确指示新建独立 fixture；第一轮 C 项目 `dce10aa7-d1fb-41ba-b14d-8ed6f9c7136a`、D 项目 `830d47ec-dd27-45d8-87ba-7acab4225db6`、三名员工、四个 Bug、五份上传附件及一次额外预留均保留。四 Bug ID 为 `5f27a7e5-d703-409b-a00c-70a513b8a244`、`b707ab3d-76c3-4a40-b39a-002121dc0b38`、`d53a3939-a4ed-4fd4-a924-5f41778092ab`、`abfbf5ca-5c98-4af6-b9c9-fb377ada100b`。

原始 [失败 summary](789bd648-e5df-43d7-b5b1-283327f83b07/summary.json)、[请求](789bd648-e5df-43d7-b5b1-283327f83b07/requests.jsonl)、[已完成断言](789bd648-e5df-43d7-b5b1-283327f83b07/assertions.jsonl) 和 [first-run.raw.log](first-run.raw.log) 均未覆盖。

## 脱敏审计与未执行范围

[post-run-audit.json](post-run-audit.json) 是结束后只读解析证据所得：两轮内嵌 JSON 字符串递归敏感字段扫描、JWT 形状扫描、限定来源/路由检查通过；首轮 31 处、第二轮 231 处 JSON-RPC 字段均为原字面字符串 `"2.0"`。该文件记录所有原始 JSON/JSONL 的字节数和 SHA。密码、访问令牌、Cookie、CSRF 等不进入请求记录或终端输出；本轮没有将原始含密凭据另行落盘。

最终 summary SHA 为 `d90f329c16461792e4f56bb10340c9d44cd6f86c617c25b8bee4953a2d9be53b`，最终 requests SHA 为 `bc936b7c142a089db4827a526a69e95b517318c466806dd724cd1ff83be7b90f`。

- 组件任务日志未调用。当前基础 Bug 没有独立 raw-log 路由；Bug 事件和附件不是组件日志，不能据本轮证据勾选基线 05 的日志子项。
- 未操作 APK、EXE、Web UI 或本地 MCP，不迁移其入口状态；没有取代物理 Android 验收。
- 未调用外部组件、回调、运行任务、队列恢复或组件取消/重试；所有状态转换组合、停用成员/项目组合及继承的未实现接口也不在本轮范围。
- 未修改 API、Storage、客户端源码、覆盖矩阵或既有 proof；本目录只有此次两轮的新证据。本轮不提交或重启服务。
