# Phase D：冻结工作流快照与分页

八个独立文件的源码验证已通过，公共注册和实际部署待 root 接线。[result.json](result.json) 绑定当前八文件、依赖及所有日志 SHA。最终组合测试 **5/5**，包括随机回环 HTTP **20 个请求**；storage/API `tsc --noEmit`、限定八文件 lint/format 均退出 0。没有写在用 dist，没有请求主预览端口、外部组件或客户端。

实现新增 vendor `GET /api/v1/bugs/:bugId/workflow`，五个集合共用同一持久快照，各自使用独立游标水位。首次查询在同一 SQLite 事务内读取同 account/project/Bug 的 typed 事实并保存安全 DTO；后续分页只读这份 DTO。私有随机 32 字节签名材料留在数据库，游标仅携带快照/分页 UUID 和 HMAC，长度约 119 字符，不超过冻结上限 500。每页重新检查当前账户、员工、项目、会员和 Bug 软删除状态；撤权后恢复也使原会员版本绑定的游标失效。

快照、分页记录不可更新或删除，DTO 集合插满声明数量后禁止追加。默认 15 分钟有效期；过期只拒绝游标，保留记录。默认每页50、最高100；单快照10,000项/64MiB，每 account+actor 最多64个有效快照、1024个保留快照、256MiB保留 DTO。达到容量明确返回 `RATE_LIMITED`，不静默裁剪或清理历史。累计容量不包括数据库索引与元数据字节，不能把256MiB称作整个 SQLite 文件大小上限。

测试最强证据是 101 occurrences、7 attempts、3 verifications、3 Builds、3 Relay receipts 的非空逐页读取：所有页都通过原冻结 Ajv `workflowProjection` schema；页长1与100、稀疏集合结束、同游标重放、重开 SQLite、合法 planned→running 后仍读原 planned DTO均已验证。Relay 是正式 `dispatchMobileRelay` 在本地 SQLite 生成的排队回执，随后正式人工完成/验收退回保留历史；没有 claim 或执行外部请求。Build 是明确的本地 typed SQL validating→ready fixture，由真实 occurrence 外键引用，不能当作 Jenkins 或 Relay 构建 E2E。

HTTP 测试组合真实 BrowserAuth 会话存储、ProjectRequestContext、Fastify 与 SQLite。测试内 worker port 直接调用真实 store，不等于已注册生产 worker 消息。随机端口上的20请求覆盖200、401、跨项目404、非法查询/游标400、媒体406、撤权403；另一个故意注入的存储异常返回500 `INTERNAL_ERROR`，未泄露私有 key。adapter 测试确认请求发出前已固定 actor/project/cursor，后续项目变化不能修改消息。

本轮首次失败保留在 `runs/`：fixture 缺 `busyTimeoutMs`、误以为人工完成已创建验收、漏开始验收、尝试修改受保护 occurrence，以及测试类型推断错误。已分别修正；occurrence 的不可变守卫没有被绕过，改用正式 start 动作验证后置状态变化。中途第三个 DTO 插入故障的隔离测试确认 snapshot header 与前两个 DTO 同事务回滚。

## 接线分工

| 新文件 | root 后续接线 |
| --- | --- |
| `packages/storage/src/workflow-projection-migration.ts` | 将 `WORKFLOW_PROJECTION_SNAPSHOT_SQL` 注册为 **schema17**。早期 schema16 方案已被 Phase B 的16占用替代，历史记录不重写。当前测试是在 schema15 上独立事务应用该 SQL，尚未证明注册后的16→17迁移。 |
| `workflow-projection-types.ts`、`workflow-projection-cursor.ts`、`workflow-projection-store.ts` | storage index 导出需要的 store/types；私有签名 key 不经 API 返回。 |
| `packages/storage/test/workflow-projection.test.ts` | 加入 storage 常规测试列表；测试使用 `node --import tsx` 直接读取源码，保留临时 SQLite。 |
| `apps/api/src/sqlite-workflow-projection-store.ts` | 给 worker 增加 `getBugWorkflowProjection` 消息；消息在 async scope 中立即快照。entry 必须在现有 `withWriteTransaction` 与可信 GM 临时授权包装内执行整个 store 调用，不能另设全局 GM 状态。 |
| `apps/api/src/workflow-projection.ts` | app options 注入新 store，在真实 BrowserAuth/ProjectRequestContext 之后调用 `registerWorkflowProjectionRoutes`。main 使用当前 scoped factory 创建 adapter。 |
| `apps/api/test/workflow-projection.test.mjs` | 加入源码或构建后测试工作流；当前命令为 `node --import tsx --test apps/api/test/workflow-projection.test.mjs`。 |

root 接线后仍需完整 schema16→17 数据保全、真实 worker 进程消息/可信 GM、已注册 full-main HTTP 与部署门禁。现有 `human-workflow` 路径、历史失败和冻结合同不改；冻结 manifest 未列400但非法游标须400的缺口继续保留，不虚构旧请求兼容。`environment.testSessionId` 仍是冻结允许的客户端 opaque UUID，当前没有同名服务端业务表，不虚造关联。

本证据只证明局部持久合同和本地 HTTP 组合，没有提升全功能基线、物理设备或外部执行器验收状态。
