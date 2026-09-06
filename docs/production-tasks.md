# 制作任务

Windows / Web 1.3.0 在工作台后增加「制作任务」。页面使用 QA Hub 登录态，通过 QA Hub API 访问 Relay 的受限任务接口，不嵌入 Relay 调度台。

## 页面

- 当前任务、历史任务、单号 / 标题 / 提出人 / 进展筛选；展示关联 Bug 的四状态投影。
- 新建独立需求：标题、完整要求、附件、模型、思考强度、快速模式、执行方式、优先级、完成后保留现场。
- 从现有 QA Bug 批量制作：1–50 张独立任务；完整 Bug 内容、验收要求、选择附件和逐单补充说明。轻语先走现有导入入口。
- QA Bug 选择列表将待制作置顶，然后展示处理中、待验收；分别使用蓝、黄、绿底色及文字标签，同状态保留原有顺序。
- 验收打回支持在原因框直接粘贴截图，也可选择文件，提交前可预览或移除。每轮最多 8 张、合计 100 MB；截图绑定本轮验收并随原 Relay 任务的下一轮发送。在当前窗口切换 Bug 或提交失败时，理由与图片草稿按 Bug / 修复轮次保留。
- 任务详情：历次要求、回复、结果、验证、附件、分支、提交和构建记录。
- 原任务续改、停止、重试、重新打开、结束制作、合并并完成。合并有明确确认；结束制作与 QA 人工验收是不同操作。
- 草稿按登录用户 / 项目保存。批次先持久化，再逐项处理；失败项可重试，成功项保留。已关联的任务返回原任务，不创建副本。

## MCP

沿用 EXE 的 `http://127.0.0.1:4320/mcp`，新增：

`qa_list_relay_projects`, `qa_list_relay_tasks`, `qa_get_relay_task`, `qa_create_relay_task`, `qa_start_relay_batch`, `qa_continue_relay_task`, `qa_relay_task_action`, `qa_get_relay_batch`, `qa_retry_relay_batch`, `qa_materialize_relay_attachment`。

先用 `qa_list_projects` 获取可见 QA 项目 ID，再用 `qa_list_relay_projects` 查看实际映射仓库。批量提交示例：

```json
{
  "projectId": "已有 QA 项目的规范 ID",
  "requestId": "本次批次的唯一标识，超时重试必须复用",
  "bugs": [
    { "bugId": "已有 Bug 的规范 ID" },
    { "bugId": "第二张 Bug 的规范 ID" }
  ]
}
```

`qa_start_relay_batch` 返回批次 ID。用 `qa_get_relay_batch` 查询各项及移交回执，用 `qa_get_relay_task` 查询执行和交付。`accepted` 只表示提交已接收。状态操作需传入最新 `updatedAt`；`merge` 还需 `confirmMerge: true` 和用户授权。

## 服务配置与数据

- QA Hub 继续使用现有 Relay endpoint、M2M token、QA 实例配置。浏览器和 EXE 不接触 M2M token。
- Relay 的项目映射仍由 `PIPELINE_QA_HUB_PROJECT_MAP` 管理。新接口不能指定任意仓库、本机路径、工位或分支。
- Relay 的 `PIPELINE_QA_HUB_M2M_SCOPES` 在三个 `qa:handoff:*` scope 外增加 `qa:task:read`, `qa:task:write`, `qa:task:merge`。接口只接受 loopback M2M 调用。
- QA Hub 在用户可见项目范围内授权；写入需 reporter / developer / triager / release_manager / project_admin，合并限 developer / release_manager / project_admin。
- 批次与上传记录在 QA 数据根目录的 `integrations/production` 下；原有 Bug 移交仍走 storage outbox 和正式 webhook。每一步先保存输入，再用固定幂等键提交；重启恢复沿用同一输入。
- Relay 在已有数据库增加 `qa_task_commands` 表；创建和续改回执与 task / turn 同事务保存。外部操作结果不明时返回 `COMMAND_OUTCOME_UNKNOWN`，要求读取原任务核对，不自动重复合并。
- 附件支持 PNG、JPEG、WebP、TXT / LOG、JSON、ZIP，单文件 25 MB、单任务 8 个、合计 100 MB；按 SHA-256 校验。关联 Bug 的新附件先通过既有 Bug 编辑入口保存。

## 验证

新增 API / MCP / Relay 测试覆盖八单部分失败、重启恢复、响应丢失后重放、原任务续改、项目权限、版本冲突和附件校验。页面隔离浏览器检查覆盖列表、草稿保留、八单选择提交和原任务续改。跨仓库隔离检查验证 outbox 执行参数、回执摘要和完整验收要求传递。

更新只需重新启动 QA API、Relay API 和使用新版 EXE。Windows 发布沿用原有签名安装包、自更新与回滚流程；不强制关闭用户当前客户端。
