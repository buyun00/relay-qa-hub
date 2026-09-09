# Phase D 公共接线与隔离验证

本轮完成 schema17、真实 worker 消息、storage 导出与常规测试列表，以及 createApiApp/main 的项目作用域适配。新入口为 GET /api/v1/bugs/:bugId/workflow，必须在 BrowserAuth 和 ProjectRequestContext 后注册；缺少任一配置直接拒绝启动该组合。主预览和生产未部署、未重启，客户端未操作。

[result.json](result.json) 固定18份拥有的源文件与已编译产品文件 SHA。原七份候选产品/存储测试文件保持 r2 字节；唯一候选变化是 API MJS 测试改为导入已构建 dist .js，解决正常 node --test 对 TS 参数属性语法的执行失败。改前原字节保存在 [candidate-r2-http-test.mjs.txt](candidate-r2-http-test.mjs.txt)，r2 原证据未覆盖。

- Storage 常规列表 **123/123**，本次显式启用保留归档迁移检查，无 skip。见 [storage-final.txt](storage-final.txt)。
- API 最终构建后的 MJS **243/243**、TS **33/33**，合计 **276/276**。见 [api-built-source-final.txt](api-built-source-final.txt)、[api-workspace-ts.txt](api-workspace-ts.txt)。
- Storage/API build、两项 noEmit、定向 ESLint/Prettier 与五项冻结合同检查均 exit0；原始日志和命令退出记录列在 result。
- 新 createApiApp 随机端口实际 **19 HTTP**，真实 bearer 登录、ProjectRequestContext 与 worker；覆盖非成员 GM、并发 A/B、分页重放、401/403/404/400/406、撤权后403、恢复后旧 cursor400、软删除后404，以及原 human-workflow 仍可读。源级两项候选 API 测试另有24请求；两组不能合称客户端 E2E。
- 实际 worker 验证重开后的同 cursor DTO、GM 临时授权与相邻普通消息隔离、异常事务回滚、零授权残留、无普通 GM membership 增生和保留行数。

[迁移副本审查](migration-artifact-review.json) 读取 Phase B 已停止服务的固定一致归档及新复制库：原档 SHA b1380cee2f8fa55732cdef74a171ec9af356b0b517c9495886bdf8ed4fb02d19 保持；只对新副本执行16→17，自动保留的 v16 在线一致备份可读。**70张旧表、7份不可变 Verification 结果、全部原迁移记录和15/16校验和保持**。公开证据只输出计数和哈希，不输出 DB 私有签名或认证值。这不是生产当前状态检查或旧外部队列迁移。

失败原件全部保留：npm 未能在 shell 解析（构建未执行）；HTTP fixture 的 web 无 Origin 被正确 CSRF 拒绝、非成员错误码预期、GM 创建项目自带 membership 的 fixture 设置；候选 MJS 直接导入 TS 的执行门禁；旧迁移数组漏17；从仓库根而非 apps/api 启动导致上传器相对 fixture 路径不可用。最终修正 runner/fixture/测试导入和显式版本断言后通过，未放宽产品约束。

接线已完成，root 后续负责独立 full-main 与实际部署。非空 Build/Relay 五集合覆盖来自前轮本地 typed SQLite fixture，未证明外部执行。冻结枚举仍缺400这一原始合同说明，未修改合同文件。容量或有效期达到上限明确拒绝，未新增历史清理。本轮不更新矩阵、整体基线或根实施说明。
