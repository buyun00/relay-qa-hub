# EXE 停止期间的 HTTP 与服务端 MCP 实测

2026-09-09 已完成独立预览 EXE 的受控故障停止、HTTP/MCP 业务验证及原生恢复。正式业务脚本执行一次通过，共 **69 次请求、140 次进程和端口边界检查**；没有失败后重建记录或重跑。实际业务窗口为 `2026-09-08T21:14:14.415Z` 至 `21:17:11.392Z`（北京时间 05:14–05:17）。

设计第 13 节基线 11 要求关闭 EXE 后仍能登录、查询、评论和改状态；基线 12 要求服务端 MCP 独立完成相应主要 Bug 动作。这两项独立性要求已满足。第 17 节的逐功能、逐状态和负向输入覆盖仍由完整矩阵分别追踪。

## 实际业务及入口

| 入口                     | 请求数 | 独立测试 Bug                                                  | 操作者                                 |
| ------------------------ | ------ | ------------------------------------------------------------- | -------------------------------------- |
| 4419 HTTP 直接业务路由   | 33     | `8a0be07a-deed-413c-8ceb-b3249ac9af79` / `TA1788885078625-20` | `9203fd01-1dba-4344-8f63-6f83bcffa854` |
| 4421 服务端 JSON-RPC MCP | 36     | `be958e15-22f2-4022-8bb9-b3ec9bca35a1` / `TA1788885078625-21` | `82b2dcc6-1288-4bd8-8f11-9a420c41a2f2` |

两套新员工和新 Bug 均属于项目 `fb914b3b-4169-47f8-8dec-76f3a3cc780d`，五组件全关。HTTP 未使用 `/api/v1/mcp/call` 包装；MCP 实际执行 initialize、initialized 通知及工具调用，并检查协议、响应 ID 和业务 isError。

每条链路都完成登录、项目和列表/详情查询、编辑、持久评论、人工完成、验收退回、再次完成、验收关闭以及测试记录软删除后的详情拒绝/列表消失。状态依次为 reported/v1、ready_for_verification/v5、ready/v7、ready_for_verification/v10、closed/v12；编辑及验收过程的中间版本保存在原始响应。各 17 条事件的操作者均匹配该链路新员工；评论和人工完成的幂等重放、错误项目及旧版本负例也通过。

原始证据：[69 次请求及 140 次边界检查](runs/exe-closed-api-mcp.json)，SHA-256 `e04530bbdb74f054093dcc8e15fff2742643b82ff02bdef4adde4b4e0e52d62a`；[执行摘要](runs/exe-closed-api-mcp.raw.log)。执行脚本 `scripts/project-components/exe-closed-api-mcp.smoke.mjs` 的验收版本 SHA-256 为 `6b73e317b7bec06784e3957b10c71786d75f83a85160b88b331b2da2b91b52fd`，不包含任何进程启停操作。

## 停止与保全

停止前实际核对原生员工、原有文字和一张 PNG 草稿，以及原 Bug closed/v14、1 条评论和预览配置 SHA。仅在核对安装路径、PID 11368、精确启动时点 `19:52:36.0963040Z` 和配置哈希后停止预览主进程；其三个同路径子进程随后全部消失，4420 无监听。日常 EXE PID 17160 的路径和精确启动时点保持；独立 API 和服务端 MCP 仍 ready。[停止记录](runs/exe-independence-controlled-stop.json)、[原生草稿基线](runs/exe-independence-before-draft.txt)、[停止前业务基线](runs/exe-independence-before.json)。

停止后的整个预览 profile 保留到新的仓库外目录，109 个文件、772540633 字节，复制前后源目录和副本逐文件 SHA 完全一致。私有身份和数据文件没有进入 Git；公开证据只记录目录和清单哈希。[完整 profile 保留](runs/exe-independence-profile-retained.json)。

140 个检查位于运行首尾及每次请求前后，均确认准确预览安装目录/同名候选进程不存在、4420 无监听。这是已记录边界上的实际检查，不是托盘隐藏或 mock；测试期间未启动其他预览 EXE。

## 已恢复与限制

测试结束后启动同一份已安装 preview.7。新主 PID **23924**，启动时点 `2026-09-08T21:18:26.3376550Z`，本地 MCP 4420 恢复；原生仍显示原员工和原文字加一张 PNG 草稿。原 Bug `a32d175b-137c-47bd-bbd9-b952d4860b1e` 仍 closed/v14、评论 1 条；原 184872 字节附件实际落盘 SHA 仍为 `e0ed7b4b96935f06855a05ce3372ada01b9585ed459d3d5c183f1c6dc8e7cb8b`，配置 SHA 未变。[恢复读回](runs/exe-independence-restored.json)、[原生恢复](runs/exe-independence-restored-draft.txt)。

恢复后 `21:22:09.4439761Z` 的生产只读核对通过：六文件哈希、三个原进程及精确启动时点、ready/schema12 和 Windows 3.3.5 公开 manifest 原字节 SHA 不变。两个 Node 进程路径仍不可读，Android 继续引用其明确带时点的已有证据。[生产读回](runs/production-after-independence.json)。

本次明确为受控故障停止，不是正常托盘退出，也没有执行此前被自动审批拒绝的登录后立即强停组合。它不证明全部 HTTP/MCP 对等、全部状态和客户端控件、真实外部组件链路或物理 Android 已通过。试用 API/Web/MCP 和恢复后的独立 EXE 均继续保留运行。
