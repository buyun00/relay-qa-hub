# 项目组件后端与执行器证据

日期：2026-09-09。工作树：`C:\Users\lin0\.codex\worktrees\7c86\Relay-QA-Hub`；基线 `62b4495c9b28dc3aea1d5633e870be4e1fdf841f`。本文件记录后端组件实现与本机合同验证，不代表真实外部链路或整个方案验收完成。未修改或运行生产工作树、数据库、队列或外部任务。

## 配置、任务和历史

- `ProjectComponentsRuntime` 只从项目组件的私有配置与独立 `credentialRoot/<credentialRef>.json` 构造服务。固定生产 Jenkins、上传与轻语连接已移除；未配置时拒绝执行。凭据内容不回传客户端，凭据引用路径经过目录与真实路径检查。
- 每个版本的配置快照写入 `components/projects/<projectId>/components/<key>/versions/<version>/configuration.json`。快照绑定项目、组件、版本、配置、凭据 SHA-256 和创建时间。修改既有凭据文件导致旧版本拒绝执行，须保留旧文件并为新配置使用新引用。
- 构建任务持久保存在独立 runtime SQLite；上传任务、登录缓存、日志与上传链分别存入项目/版本/人员目录。后台存储使用固定项目 scope，不依赖 HTTP 当前项目。任务切换配置后继续用原版本；新项目无任务或凭据继承。
- 关闭组件暂停未启动构建、上传、打包上传与制作批次；重新开启不自动重放暂停任务。运行构建使用原配置完成轮询与产物核对。Jenkins 提交不明确时保留 `uncertain`，不重试创建。下载产物校验非空内容、大小和 SHA-256；不会把 Jenkins 状态单独视为产物验证。
- 关闭时历史仅从本地 SQLite/JSON 读取；不会因缺失旧凭据而隐藏完成历史。新增 `production/tasks/history`、`qingyu/history`、构建任务列表与上传历史按请求项目限定。轻语部分失败保留 `partial_failure` / `failed`，不同步成伪成功。
- 原制作动作继续通过 `POST production/batches` 的 `kind: action` 支持 continue/cancel/retry/reopen/finish/merge；merge 保留显式确认。对已知历史任务的操作通过本地批次/回执查回原配置版本，混版本批次拒绝，避免配置更换后把旧任务发送到另一服务。

## Relay 队列与导入暂停

- outbox 的不可变 payload 原子保存 QA `projectId` 与 `componentRoute: {componentVersion,snapshotDigest,externalProjectKey}`。`externalProjectId` 在 Relay 组件中表示外部 Relay **projectKey**；目标 `relayInstanceId` 必须显式配置。QA 本地项目 key 不作为新组件的外部默认值。
- continue、人工验收接受通知和返工任务继承原 handoff 的路由。版本与快照比较使用字段值，JSON 键顺序不影响身份。现有 schema 14 即可保存这些字段，无需破坏性迁移。
- 每个 Relay 配置版本独立启动和关闭 pump，严格按 account/project/version/snapshotDigest/Relay 实例认领。旧无 componentRoute 队列只允许旧兼容 claim；旧全局 pump 在新 main 中不再启动。返工调度同样限制到认领范围，不能在 claim 前全局创建其他项目的轮次。
- 认领前检查组件和项目启用；HTTP 发送前再次检查动态门禁。停用且未发送的消息持久标记 `COMPONENT_DISABLED_PAUSED`。重新启用不会清除它；员工显式恢复会记录 `relay.outbox.resumed` 与实际 actor 的审计事件。
- 本地队列历史：`GET /api/v1/projects/:projectId/production/outbox`，返回 `{projectId,items:[{id,projectId,componentVersion,handoffId,bugId,relayTaskId,state,status,attemptCount,errorCode,createdAt,submittedAt}]}`。恢复：`POST` 同路径 `/:id/resume`，空 body，返回新列表。旧前缀也注册，必须由项目请求上下文解析归属。
- `dataRoot/.qa-hub-import-hold.json` 使用 Storage/API 共用解析器：缺失时不暂停；损坏、过大、未知状态及无完整释放证据一律暂停。释放须 `markerVersion:1,state:released` 及 actorId、有效 releasedAt、非空 reason。
- API runtime 拒绝新提交/恢复并停止 tick；SQLite worker 独立拒绝 Relay 创建/提交/继续与认领，避免直接调用 worker 绕开 API。历史与 QA 本地人工生命周期保持可读可用。main 将明确 marker 路径传给 worker。

## C# 上传执行器 0.5.0

独立 .NET SDK 10.0.400 / Runtime 10.0.11 构建 Windows x64 自包含 EXE，仅替换本工作树 `apps/desktop/vendor/ozdqp-uploader/ozdqp-uploader.exe`；API host 校验相同哈希与版本。

SHA-256：`0d5e930bd6421550ac18d816a4f08ca444c3a8f078df26e2c051e960649fc907`。

任务必填 projectId/componentVersion/apiBase/loginBase/downloadUrl/sourceRoot/targetPrefix/testDirectoryPrefix/releaseDirectoryPrefix，且进程项目环境必须匹配。来源只允许明确目录下的直接 ZIP 子项；拒绝跨源、目录逃逸及重定向。没有固定来源、产品、渠道或日常凭据缓存回退。凭据与锁分别来自独立 OZDQP_AUTH_FILE/OZDQP_LOCK_ROOT；来源不同的缓存在网络请求之前拒绝。旧未绑定项目任务不能套用新配置恢复。

EXE 自检 **40/40**，报告见 `uploader-0.5.0-self-test.json`。包括真实腾讯 SDK 对本机回环服务的分片字节、并发、失败恢复测试，以及新增项目/来源绑定拒绝测试。`realPlatformTested: false`。

实际 supervisor 测试启动了本机新 EXE，随后关闭 API service，由独立 supervisor 持久写入 `AUTH_REQUIRED` 终态，重建服务后正确读取且不重发。测试使用 `.invalid` 服务来源与故意不匹配的独立鉴权缓存，确认在网络前失败；没有外部业务写入。

## 回归结果

| 验证                                    | 结果    | 范围                                                                                   |
| --------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| Storage build、API build                | 通过    | 当前源码                                                                               |
| Storage 全部测试                        | 109/109 | SQLite 迁移、事务、不变量、归属、备份恢复、人员和组件                                  |
| API 标准回归                            | 144/144 | 主套件 111 + uploader/build/source 33；含真实 supervisor                               |
| 最后 uploader host 归属改动后的相关回归 | 33/33   | 从 apps/api 目录运行，使用正确 vendor 相对路径                                         |
| 项目 HTTP 基础                          | 2/2     | 实际 TCP Fastify + SQLite；身份/GM/成员与 A/B 16 次并发创建                            |
| 项目 runtime                            | 7/7     | 开关/版本/产物、配置拒绝、导入暂停、原Relay端点、真实queued chain、HTTP JSON与标识合同 |
| 项目 Relay SQLite 队列                  | 2/2     | A/B/版本/错误实例/全局互不偷取、暂停与审计恢复、损坏 marker、认领后发送前关门          |
| 原 Relay 传输合同                       | 1/1     | 本机 HTTP 服务、prior handoff、人工验收接受与临时失败重试                              |
| owned ESLint / Prettier                 | 通过    | 本阶段修改的 API 执行文件与 Storage 队列/worker 文件                                   |

标准 API 套件已包含部分单项，表格不应相加当成唯一测试总数。详细成功输出：`backend-storage-regression-final.log`、`backend-api-regression-final.log`。期间有测试 fixture 漏显式 null 字段、未在 apps/api cwd 运行和 npm 不在 PATH 的调用失败，已纠正后按准确命令重跑；未把失败调用当通过。

## 仍需真实外部验收

真实独立 Jenkins/job/构建资源、上传平台账号与 COS 目标、Relay 目标实例和项目、轻语项目与账号尚未提供。本机 mock/回环测试不能证明真实构建、上传、发布、Relay 执行/回调或轻语闭单成功。本阶段未发起这些真实任务，也没有制作假成功回执。预览 API/Web 重启及客户端/MCP 完整业务验收由主代理统一执行；本文件不代替这些证据。

## 最后响应合同补丁

组件通用路由显式返回 application/json，并保留 jobs/resume 的 JSON 字符串 ID；build-chains POST 则按原客户端合同返回持久化的 queued chain 对象。新增两项合同测试验证排队后读回、无外部调用、64hex batch 详情与 UUID outbox 恢复路径。API build 与最新 runtime 6/6 均通过。队列收据只证明接受和持久化，不是外部工作完成。

配置模板与凭据字段、恢复操作见 [component-runtime.md](component-runtime.md)。编写模板时发现 iOS 目录的末尾斜杠被通用 URL 处理去除，现已修复并增加无外呼快照测试；最后 API build 与 runtime 7/7 通过。
