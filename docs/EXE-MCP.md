# QA Hub EXE 本地 MCP

启动 `RelayQaHub.exe` 并按姓名登录后，EXE 会在本机提供 Streamable HTTP MCP：

```text
http://127.0.0.1:4320/mcp
```

它只监听回环地址，不开放到局域网。MCP 复用 EXE 当前的 QA Hub 登录会话；退出 EXE 后接口随即停止。健康检查为 `GET http://127.0.0.1:4320/health`。

本仓库已带项目级 Codex 配置 [`.codex/config.toml`](../.codex/config.toml)。信任并重新打开该项目后，Codex 桌面、CLI 和 IDE 扩展会使用同一条 `relay_qa_hub` 配置。也可以按 [OpenAI 官方 MCP 配置说明](https://developers.openai.com/codex/mcp) 在其他本地项目或编辑器中添加上述 Streamable HTTP URL。

## 工具

- `qa_list_projects`：读取当前登录人和可见项目。
- `qa_list_bugs`：读取当前单子；默认隐藏关闭、延期、驳回和重复项。
- `qa_get_bug_context`：读取 Bug、RepairAttempt、构建/关闭状态、事件、成员、模块、附件和采集快照。
- `qa_materialize_attachment`：下载附件到 `%APPDATA%\RelayQaHub\mcp-attachments` 下的 EXE 用户数据目录，校验大小与 SHA-256，再返回绝对路径。
- `qa_begin_fix`：当前登录人领取未分配单子并沿现有状态机创建、启动 RepairAttempt；已属于他人的单子会拒绝抢占。
- `qa_add_comment`：回写真实调查进度、阻塞或验证记录。
- `qa_submit_fix`：提交分支、40 位 Git SHA、修复摘要和实际验证命令。
- `qa_resolve_qingyu_bug`：输入 QA Hub 单号（如 `LOCAL-83` 或 `83`），查找持久化的轻语关联并把对应轻语 Bug 设为“已解决”；不改变 QA Hub 本地验收状态。

MCP 负责回写修复和真实验证证据；代码交付仍需精确构建证据。进入待关闭后项目内任意已登录成员都能在 EXE 详情中直接关闭，不再检查提报人、负责人或关闭人身份；关闭后统一计入“已完成”。详情也支持删除，删除后会从 Web、EXE 与 MCP 读取结果中隐藏并保留底层审计记录。

## 建议工作流

1. 调用 `qa_list_projects` 和 `qa_list_bugs` 找到待处理单子。
2. 调用 `qa_get_bug_context`；有附件时用 `qa_materialize_attachment` 拉到本机。
3. 确认仓库与单子匹配后调用 `qa_begin_fix`。
4. 在 AI 编辑器里审计代码、做窄改动、运行相关测试，并创建 Git commit。
5. 用 `qa_submit_fix` 回写真实验证命令、分支和完整 commit SHA。
6. 等待精确构建；进入待关闭后由任意项目成员在详情中直接关闭。验收通过时后端会先自动解决关联轻语单并回读确认，再提交 QA Hub 本地关闭。若被打回，重新读取上下文后继续原 RepairAttempt 链。

如果历史单据或异常重试只需要补做轻语同步，可调用 `qa_resolve_qingyu_bug`。该工具会回传命中的 QA Hub 单号、轻语 defect ID、最终外部状态和是否原本就已解决；它不会代替人工验收，也不会修改 QA Hub 状态。

## 打包和上传增量（Windows 3.3.7 起）

| MCP 工具 | 用途 |
| --- | --- |
| `qa_get_packaging_status` | 查询排队原因、构建阶段、结果及下载地址；可传 `queueIds`、`buildNumbers` |
| `qa_start_build` | 单独打包，`preset` 支持 `external`、`internal-nosdk`、`internal-sdk` |
| `qa_build_and_upload` | 一键 Android 外网打包，后端自动检测本次 ZIP 并上传、提测及发布 |
| `qa_start_increment_upload` | 上传已有 ZIP，`platform` 支持 `android`、`ios` |
| `qa_get_increment_upload_status` | 查看所有人的记录，或用 `chainId` / `jobId` 查询单个任务；`includeLogs:true` 附带脱敏记录 |
| `qa_resume_increment_upload` | 恢复本人失败或中断的原上传，保留原版本、ZIP、测试人和分片 |
| `qa_confirm_increment_publish` | 对本人 `awaiting_publish` 任务执行最后一步正式发布 |
| `qa_cancel_increment_upload` | 取消本人尚未开始的上传排队 |
| `qa_cancel_build_upload` | 取消本人打包后的自动上传；已提交的 Jenkins 构建继续运行 |

一键调用示例（每次新任务使用新的 UUID，重试同一任务复用原值）：

```json
{
  "name": "qa_build_and_upload",
  "arguments": {
    "requestId": "bca850fa-c4d1-4d96-802a-e4c23c0c631c"
  }
}
```

默认产品 ID `2002`、Android 渠道 `1002`、测试人 `11562`、8 分片并发、自动版本号，更新说明只填最终版本号。`mode` 只有两个选项：默认 `publish_workflow` 完成正式发布；`prepare_publish` 停在最后确认前。可显式指定 `version` 和 `testerId`。iOS 上传使用 `qa_start_increment_upload` 并传 `platform:"ios"`，后端从固定 iOS 目录选最新 ZIP，渠道为 `2004`。现有构建预设是 Android，一键构建不接受 iOS。

返回 `accepted:true` 只表示任务已提交。保留返回的 `chainId`，通过 `qa_get_increment_upload_status` 跟踪；`chain.status=upload_started` 仍需继续查看关联 `job`。正式发布完成应同时核对 `job.published=true`、`job.remoteStatus=100`。不要把提测、上传完成或提交成功当成正式发布完成。

MCP 复用 EXE 当前用户的 QA Hub 会话和该用户已配置在后端的上传账户，不接受平台密码、本机 ZIP 路径或任意服务器地址。若状态返回 `configured:false`，先在“上传增量”页面设置上传账户。所有人可查询记录，恢复、取消和确认仍由创建者执行。任务及进度由后端持久化，提交后关闭 EXE 或断开 MCP 不会中断执行；再次连接可按原 ID 查询。

一键任务及上传请求在后端持久化去重，超时后用原 `requestId` 查询/重试，不要生成新 ID。单独打包沿用现有 Jenkins 接口，其去重缓存只在当前 API 进程保留 24 小时，因此该工具不宣称永久幂等；发生未知提交结果或 API 重启时，先查询构建队列核对，不要自动重新提交。

安装新版并重启 EXE 后，本机 MCP 才会加载这 9 个新工具（总计 27 个）；已提交的后端任务不受 EXE 更新影响。

## 运行配置

便携包旁及 `%LOCALAPPDATA%\Relay QA Hub\desktop-runtime.json` 支持：

```json
{
  "schemaVersion": 1,
  "mcpEnabled": true,
  "mcpPort": 4320
}
```

也可用环境变量 `QA_HUB_DESKTOP_MCP_ENABLED` 和 `QA_HUB_DESKTOP_MCP_PORT` 覆盖。端口冲突会在托盘显示 `MCP：不可用`，但不会影响主界面；释放端口后重启 EXE 即可。

该接口会代表当前 EXE 登录人执行领取和交付操作，所以只应连接受信任的本机 AI 编辑器。浏览器跨站 Origin、非回环连接、超大请求、重定向和非 QA Hub API 目标都会被拒绝。
