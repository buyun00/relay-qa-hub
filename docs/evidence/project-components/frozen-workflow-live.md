# 已部署预览 API 的冻结响应实测

API 修复提交 `09f7150fc1c671d867bbdbc257cab0e61c78d20f` 已通过独立实例管理器部署到预览 4419，PID 18644，启动时点 `2026-09-08T20:39:13.7225210Z`。实际 readiness 为 ready / schema 14，database、evidence、worker 均正常；编译后的路由、响应投影和历史读取模块哈希与已验证产物一致。

真实网络回归共 **31 次 HTTP 调用通过**。脚本在项目 A 使用新建的专用员工和两个独立 Bug，分别完成 vendor 失败验收与 legacy JSON 响应的通过验收。两个流程均通过实际创建／开始／无需代码交付修复、创建／开始／记录验收六条已注册接口，按原冻结 schema 验证响应。还核对丰富原因读取、相同幂等键跨响应格式重放不重复改变版本，以及错误项目读取历史返回 404。五个组件均保持关闭，没有发起真实外部任务。

原始记录见 [31 次 HTTP 结果](runs/frozen-workflow-live-2026-09-08T20-40-57-088Z.json)。随后从原始响应独立核对全部 **14 个写入及重放响应的 Content-Type**，与请求选择的媒体类型一致；核对结果和原始文件 SHA-256 见 [部署及保全读回](runs/frozen-workflow-live-readback.json)。同一读回还通过已安装 EXE 的本地 MCP 确认原 Bug 仍 closed/v14，原评论和 184872 字节 PNG 哈希不变。

脚本 `scripts/project-components/frozen-workflow-live.mjs` 的默认幂等键在第一次真实执行前已改为各路由的规范键。Content-Type 断言在独立核对原始响应后加入脚本，未为此重复创建测试 Bug。脚本会创建独立测试数据，使用时必须显式提供预览配置和两个不同项目 UUID。

本记录证明六条已注册接口的响应合同及所列场景。请求仍使用 1.1 形状，旧 1.0 请求和 blocked 写入未由本轮实现；冻结声明中的 fail、supersede、完整 workflow 历史接口也仍未注册。静态严格合同五步已通过，不能据此声称全部路由、状态和客户端入口已完成。实现及测试边界见 [响应兼容修复](contracts-remediation-implementation.md)。
