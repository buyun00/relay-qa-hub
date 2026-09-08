# 项目身份与后端基础实施记录

日期：2026-09-09。依据 `docs/design/project-components-transformation-2026-09-08.md` v2.1，工作树 `C:\Users\lin0\.codex\worktrees\7c86\Relay-QA-Hub`，分支 `codex/project-components-v2-1`，基线 `62b4495c9b28dc3aea1d5633e870be4e1fdf841f`。本阶段没有启动、修改或迁移生产；测试只使用内存 SQLite 或系统临时目录中的独立 SQLite/备份及随机空闲 loopback 端口。

## 已实现

- 增量 schema 13：项目组件版本配置、不可改写管理事件、按项目的身份关联；旧人员 ID、旧关联历史、Bug 和附件索引保留。旧关联复制到其已知成员项目，新操作不再修改全局关联。
- 项目入口、创建、停用/恢复、成员分配/停用/恢复、组件配置服务和 HTTP 路由。新项目可选组件全部默认关闭。
- 姓名与拼音仍解析已有稳定人员 ID，包含英文姓名的精确匹配。首次项目登录只加入指定项目；已撤销成员关系拒绝登录，不会恢复。
- 项目停用只改变本项目；人员停用不改变 users 的全局状态、不撤销其他项目会话。人员关联与历史 owner 筛选按项目解释。
- 唯一 GM 由服务端稳定 ID 和独立口令确定。普通姓名命中 GM ID 会拒绝，输入“gm”不会产生全局权限。
- 会话记录 immutable login_project_id/is_gm；Web 和原生返回 projectId/isGm。独立 cookie 名支持字母、数字、下划线及连字符，登录、解析、退出使用同一独立名称。
- 全部员工统一授予旧 SQL 所需能力标记，客户端增加 identity=employee，旧 roles 字段只为兼容保留。
- 组件配置具有 expectedVersion、依赖检查及关闭依赖时的级联停用。返回配置采用公开字段白名单，任意新字段和密码/令牌默认不会回传。审计只记录变更字段名，不存秘密值。
- recordProject 支持 bug、attachment、capture、build、verification、repair、upload，核对实际归属和当前有效成员关系。

## 验证与结果

1. Storage build、Storage typecheck、API build 均通过。
2. `packages/storage/test/project-management-store.test.ts` 六项真实 SQLite 事务测试通过：双项目/稳定 ID、显式停用与恢复 CAS、关联隔离、组件脱敏和依赖、项目停用恢复、错误项目记录拒绝。
3. 原人员管理回归三项通过，已将关联断言改为 project_identity_links；历史 owner 筛选仍可匹配本项目关联人员。
4. Storage 全套 108 项首次运行 107 通过，唯一失败为旧迁移版本期望只到 12。将准确期望更新至 schema 13，并补充新增表检查后，受影响 migration 套件 14/14 通过。其余 94 项此前通过；没有把版本断言失败当业务通过。
5. `apps/api/test/project-management.test.mjs` 两项真实 TCP HTTP 测试通过，使用实际 Fastify、SQLite worker、身份服务；没有 mock 业务状态：
   - 入口、姓名/拼音、独立 GM 口令、GM ID 姓名冒充拒绝、成员分配和停用、组件私有配置脱敏、新旧 cookie 名不混用、退出撤销及其他会话继续可用。
   - 实际 createApiApp + ProjectRequestContext + SQLite Bug store，两用户同时提交 16 个 Bug，每项目 8 个；列表与创建者/项目读回匹配；错误项目和无成员关系拒绝；同人 A 会话通过记录 ID 正确读取已获成员资格的 B 项目；并发 A/B 显式 header 互不覆盖，header/query 项目冲突拒绝。

可复跑命令（本树 Node 24.19）：

```powershell
node .tools/npm-12.0.2/package/bin/npm-cli.js run build --workspace @relay-qa-hub/storage
node .tools/npm-12.0.2/package/bin/npm-cli.js run typecheck --workspace @relay-qa-hub/storage
node .tools/npm-12.0.2/package/bin/npm-cli.js run build --workspace @relay-qa-hub/api
node --import tsx --test packages/storage/test/project-management-store.test.ts packages/storage/test/user-management-store.test.ts packages/storage/test/sqlite-migrations.test.ts
node --test apps/api/test/project-management.test.mjs
```

## 主服务集成审查

- AsyncLocalStorage 每 HTTP 调用单独创建对象；上述真实并发测试验证上下文未跨请求共享。scope 离开请求后直接拒绝，不回退固定项目。
- 已向主代理指出 repair 路由实际参数 `attemptId`，不能仅识别 `repairAttemptId`；上传路由 `sessionId` 也必须从 upload_sessions 定位项目，不能只依赖登录项目。Storage 已补 upload 映射，主代理负责上下文参数接入。
- 主服务 GM 稳定 ID 应加入项目人员保护名单。GM 判断必须同时检查已登录会话 isGm 和配置 ID，不能单独比较姓名或 ID。
- 主服务旧 Qingyu/Relay/Jenkins 单例仍属于待组件化范围，禁止因为配置启用而接通生产默认连接。当前 isolateLegacyComponents=true 保持旧执行入口断开。
- 历史副本如包含多个项目，GM 虽有全局目录权限，旧 SQL 业务动作仍要求有效 membership；迁移初始化需给配置 GM 加相应兼容成员关系，不能把业务拒绝误判为 GM 已覆盖全部项目。

## 尚未验收

本记录仅证明已列出的后端基础与实际 HTTP 接入。它不代替 APK、EXE、Web 完整页面、服务端/本地 MCP、附件全流程、升级共存、旧库一致性副本或任何真实外部构建/上传/Relay/第三方任务验收。组件执行器改造正在下一阶段进行，真实独立外部资源尚待主代理核实。本记录不表示整个 Goal 完成。

## 2026-09-09 后续基础修正与组件阶段

配置 GM 撤销普通 membership 后的业务权限已经由 schema 14 的事务内 command authorization 补齐，主服务与固定后台 store factory 都按配置 GM 稳定 ID 传递最小项目授权；本节替代上文仅依靠额外 GM membership 的过渡建议。入口支持短 key。完整 Storage 最新回归 109/109、项目真实 HTTP 两套通过。

关闭 Bug 后 `verification` 保持 active 的原含义并清空；新增 `latestVerification` 独立读取该项目/Bug 的最近验收，保留关闭后的真实验收历史。评论正文直接来自 comments.body，按 account/project/Bug 与成员范围读取。

后续组件运行时、C# 实际 EXE、Relay outbox 项目/版本隔离、导入暂停与回归证据见 [backend-components.md](backend-components.md)。真实外部链路仍待独立资源，不能由合同测试替代。
