# QA Hub v2.1 Web + HTTP + server MCP 定向验收（Luna）

时间：2026-09-10（隔离预览）  
端点：API `http://127.0.0.1:4639`、Web `http://127.0.0.1:4640`、server MCP `http://127.0.0.1:4641/mcp`  
源码只读：`C:\Users\lin0\.codex\worktrees\7c86\Relay-QA-Hub`  
运行时：`C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-v21-e2e-fresh-0910`

## 本次新增真实 UI 证据

- **PASS — GM 项目管理**：通过可见浏览器 UI 登录 GM，创建 `Luna UI E2E 0910`，入口短码 `LUI0910`，项目 ID `62a2f031-c436-402b-ba7d-57488c83450d`。页面显示“项目已创建，仅启用 Bug 管理”。
- **PASS — 项目姓名登录与范围**：姓名 `Luna UI User` 首次登录成功；项目切换器只显示当前所属隔离项目，人员范围显示“我 · Luna UI User”。
- **PASS — Bug 列表/详情/新建/编辑**：创建 `LUI0910-1`；列表和详情均可见；详情显示 P2/S2、未分配；编辑标题后页面显示“LUI0910-1 的 Bug 详情已更新”，历史记录从 1 条变为 2 条。
- **PASS — 正确身份撤销/恢复**：GM UI 停用 `Luna UI User` 后，重新姓名登录立即显示“你在此项目的资格已停用，请联系 GM 或项目人员恢复。”；GM UI 恢复后姓名登录成功，并重新看到原 Bug。
- **PASS — GM 人员与组件管理可见**：人员列表显示姓名、稳定人员 ID、使用中/已停用及停用/恢复控件；五个组件均可见，默认仅 Bug 管理启用。
- **PASS — 安全 dummy 打包配置保存/回读**：以 `127.0.0.1:9` 和 dummy job/path/ref 配置打包组件，保存后页面显示“可用”，刷新/重新选择项目后配置逐项回读；未调用外部服务。
- **PASS — 组件依赖顺序与回读**：先启用并保存 `upload.incremental` 后，再启用并保存 `build_upload.single`；可见 UI 显示单次上传“可用”。HTTP 回读见 `component-readback.json`：`build=ready/v1`、`build_upload.single=ready/v1`、`upload.incremental=needs_configuration/v1`（dummy credential ref 尚无真实外部凭据，因此不是 ready）。此前“版本冲突”是依赖未满足时的 `COMPONENT_DEPENDENCY_REQUIRED` 语义，不计为版本冲突。
- **PASS — Web 评论 UI**：展开“状态轨迹与处理记录”后出现评论输入框；提交唯一评论 `Luna UI comment 0910 unique-4f7c`，UI 显示“处理记录已添加”、轨迹为 3 条并回显完整正文。

## 既有定向证据（未重复执行）

- `acceptance\luna-web-api-mcp-e2e-result.json`：schema20、GM/项目创建、姓名身份、Bug 建/读/改、MCP initialize + 96 tools、错误项目拒绝、成员撤销/恢复、精确 replay 均已有 PASS 记录。
- `acceptance\api-readbacks\comment-history-after-fix.json` 与主结果中的 `comment readback`：HTTP 评论回读含 `snapshotSequence` 与完整 comment item，已有 PASS；本次未重跑。
- 主结果中的旧 `A sees only A=False`、`membership revoked zero visibility=False` 属于前一轮 cookie/bearer 身份混用，不作为本次正确隔离 UI 结论；本次用独立可见姓名登录重新验证为 PASS。

## 附件与外部连接结论

- **PASS — HTTP + server MCP 附件实际链路**：在 `web-luna-thread/fixture-1x1.png` 上完成 HTTP init `201` → chunk `204` → finalize `200` → bind `200`；生成隔离 Bug `LUI0910-2`，HTTP 下载 68 字节与 fixture 逐字节相同，SHA-256 均为 `6b1048f8a6d40bac0b2954c18fefa40c4ea7a96120fc2e54b7317c0e43c2bbec`。server MCP `qa_list_attachments` 与 `qa_materialize_attachment` 均回读元数据/resource link；随机错误项目返回 `NOT_FOUND`，无跨项目暴露。完整摘要见 `attachment-e2e.json`。
- **UNRUN / BLOCKER — 外部打包、单次上传、增量上传、Relay、第三方订单同步、青鱼**：没有隔离真实外部资源；仅验证了 dummy 配置保存/回读，未把配置成功当作 E2E。

## 总结

Web 核心项目/姓名登录、Bug CRUD、正确身份隔离、成员撤销立即拒绝与恢复登录、折叠评论 UI、组件依赖保存回读、附件 HTTP/MCP 字节链路均有真实 PASS。发布级结论仍为 **BLOCKED/UNRUN**：增量上传状态为 `needs_configuration`（安全 dummy 凭据未接外部服务），Relay、第三方订单、青鱼及真实外部打包/上传仍无隔离资源，不能宣称外部 E2E 通过。
