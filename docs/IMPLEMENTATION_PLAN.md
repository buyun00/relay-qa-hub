# Relay QA Hub 独立产品实施总计划

> 文档版本：1.2
> 制定日期：2026-08-24  
> 目标版本：`0.1.0-debug`  
> 权威进度指针：[`../PROGRESS.md`](../PROGRESS.md)  
> 产品事实源：QA Hub；Relay 只是可选修复执行器  
> 轻语：不在产品、数据、认证、状态或运行链路中

```yaml
qa_hub_progress:
  current_phase: P3
  current_gate: G3-ANDROID-APP-READY
  status: executing
  gates_completed: 1
  gates_total: 11
  last_verified_commit: 15c668a7d1f6a36a09935ce39f0e6348eb78c73c
  last_verified_at: 2026-08-25T11:19:01+08:00
  next_action: P3.6 已证明 MuMu 显式 MediaProjection/悬浮球到 attachment/Bug 及拒绝降级；当前 P3.7 接 bounded Kotlin Poco read-only enrichment，并保持 no-Poco 普通截图建单
  blockers:
    - 当前 MuMu API35 MVP 垂直切片无外部 blocker；G1/G2 仍未正式关闭，但按执行 override 不阻塞 P3 主链路实现
    - P3.2 仅表示本仓库 Android foundation/APK/MuMu 基础验证完成，不表示 G3 完成
    - API37/真机/Poco Loopback-LAN 安全证据仍属于后续 G3/G9 发布 Gate，不阻塞当前 MuMu smoke
```

## 1. 决策摘要

QA Hub 是一个独立、手机优先的缺陷闭环系统。它必须在 Relay 完全不可用时仍能完成提单、分诊、人工分配、修复登记、构建关联、验收、失败重开和关闭。

G0 完成后用户将客户端架构正式改为 App-first：原生 Android App 是唯一主要人机客户端；独立 QA Hub API/数据库继续是唯一业务事实源；Relay 仍只是可选修复执行器。现有 Web 骨架保留为 post-MVP 桌面管理/只读诊断资产，不再发展为 PWA、安装入口或离线取证主客户端。

Relay 只通过一键派发和可靠事件回写参与某些修复尝试：

```text
QA Bug
├─ 人工修复 ───────┐
├─ Relay 修复 ─────┼─> 修复已交付 ─> 待构建/待验收 ─> 验收通过 ─> 关闭
└─ 其他外部修复 ───┘                                  └─> 验收失败 ─> 重新处理
```

以下原则不可破坏：

1. QA Hub 与 Relay 不共享数据库、附件目录、进程、服务账户或内部模块。
2. Bug 状态与处理方式正交；`human | relay | external` 不是 Bug 主状态。
3. Relay 的 `turn.delivered` 最多让 QA Bug 进入“待构建/待验收”，不能自动验收或关闭。
4. 关闭普通 Bug 必须存在针对精确修复尝试和可测构建的通过验收。
5. 所有写操作必须幂等、受权限控制、带审计，并用乐观锁防止覆盖并发修改。
6. 除完全相同的客户端提交外，重复候选只提示，不由 AI 自动合并。
7. 站内 Inbox 是通知事实源；Web Push、邮件或其他通知只是增强渠道。
8. 源码完成、临时端口或桌面模拟器不能算交付；必须按门禁验证真实运行状态。
9. 不重置、清理、暂存、覆盖或丢弃现有 Relay 工作区的任何改动。
10. 不推送 Git、不发布公网或删除生产数据，除非用户明确授权对应动作。

## 2. 产品范围

### 2.1 第一版必须交付

- 项目、模块、成员、角色和项目级权限。
- Android 原生 App 中完成快速上报、编辑、列表/筛选、去重提示、评论、附件、分配、状态、验收、审计、通知、离线队列和断点续传。
- Bug、Occurrence、RepairAttempt、Build、Verification、Event 完整模型。
- 分诊、分配、人工修复、Relay 修复、外部修复、待构建、待验收、失败重开和关闭。
- 唯一编号、传输幂等、相似 Bug 候选、追加发生记录。
- App 首页原生提供“待我处理”“待我验收”“由我报告”和全量检索/筛选，不使用 WebView 包壳。
- App 内一键交给 Relay、继续原 Relay 任务并展示自动回写的交付和构建进度。
- 站内 Inbox、Android 通知、超时提醒和共享测试机模式。
- 追加式审计、健康检查、结构化日志、备份、隔离恢复和回滚。
- Android 15/16/17 App/Poco 矩阵和独立 HTTPS canary；Android 15/API 35 是最低支持层，Android 16/API 36 是运行兼容层，Android 17/API 37 是默认编译/目标与行为 Gate，按 P9 真机要求执行。

### 2.2 第一版明确不做

- Sprint、需求、工时、OKR 等通用项目管理。
- 取代 GitLab、Relay、Unity Worker、构建系统或发布系统。
- 静默后台录屏、后台摄像头/麦克风监听。
- 将 Web/PWA、WebView 包壳或浏览器离线捕获作为 MVP 主客户端。
- 未经人工确认的语义自动合并或自动关闭。
- 多活、多区域和跨数据中心容灾。
- 依赖轻语账号、ID、状态、Cookie、API 或同步。

### 2.3 后续候选

- post-MVP 桌面批量管理/只读诊断 Web；不承担现场移动流转或离线取证。
- PostgreSQL、多实例、对象存储和企业 OIDC。
- AI 辅助归类、相似候选解释和摘要；始终保留人工决定权。

## 3. 用户、角色与权限

| 角色                  | 核心权限                                                        |
| --------------------- | --------------------------------------------------------------- |
| `viewer`              | 查看获授权项目、Bug 和附件                                      |
| `reporter`            | 创建 Bug/Occurrence、补充自己的证据、响应待补充                 |
| `developer`           | 领取/接受修复、维护 RepairAttempt、提交交付证据、一键交给 Relay |
| `verifier`            | 领取验收、填写通过/失败/阻塞和证据                              |
| `triager`             | 模块、严重度、优先级、负责人、验收人、重复/拒绝/暂缓/重开       |
| `release_manager`     | 登记 Build、确认构建包含 Commit、处理构建异常                   |
| `project_admin`       | 项目成员、角色、模块、策略、集成、通知、保留策略                |
| `system_admin`        | 系统配置、恢复、密钥轮换；不自动拥有业务验收权                  |
| `integration_service` | 仅写允许的 Relay/构建事件，不能验收、关闭、判重复或拒绝         |

强制权限守卫：

- S0/S1 默认要求修复人与验收人不同；其他严重度允许项目配置。
- 管理员跳过构建或例外关闭必须填写原因并产生高可见度审计事件。
- 机器身份不能执行人工决策。
- Event 不可编辑或覆盖；隐私脱敏必须是独立、受审计动作。
- 借用设备会话默认 30 分钟空闲注销，不请求 Push，不保留长期草稿。

## 4. 领域模型

内部 ID 使用 UUIDv7；对外编号使用项目内事务递增号，例如 `OZDQP-1024`。所有时间以 UTC 持久化，UI 按用户时区显示。可变聚合包含整数 `version`。

### 4.1 Bug

核心字段：

```text
id, project_id, number, key
title, description, expected_behavior
module_id, severity, priority, labels
state, resolution_reason
reporter_id, owner_id, verification_owner_id
active_repair_attempt_id, duplicate_of_bug_id
first_seen_build_id, last_seen_build_id, target_build_id
occurrence_count, reopen_count, version
created_at, updated_at, closed_at
```

约束：

- `(project_id, number)` 和 `(project_id, key)` 唯一。
- `duplicate_of_bug_id` 不得指向自己或形成环。
- 默认最多一个活跃 RepairAttempt。
- `occurrence_count` 是可重建缓存，不是事实源。

### 4.2 Occurrence

Occurrence 表示一次具体复现。首报时与 Bug 原子创建；确认相似 Bug 时只追加 Occurrence。

```text
id, project_id, bug_id, reporter_id, client_submission_id
observed_at, build_id, app_version, resource_version, git_sha
platform, device_model, os_version, network_type
scene, route, account_hash
steps, actual_behavior, frequency
error_signature, top_stack_frames
normalized_fingerprint, text_fingerprint, screenshot_phash
environment_json, created_at
```

约束：

- `(project_id, client_submission_id)` 唯一，防双击和断网重试。
- 账号只保存脱敏 ID。
- `environment_json` 有 schema、字段白名单和大小限制。

### 4.3 RepairAttempt

```text
id, bug_id, sequence
mode: human | relay | external
status: planned | queued | running | needs_input | blocked | delivered |
        failed | verification_failed | cancelled | superseded
assignee_id, service_actor_id, parent_attempt_id
summary, failure_reason
branch, commit_sha, merge_request_url, target_build_id
started_at, delivered_at, finished_at, version
```

规则：

- 更换处理方式时新建 Attempt，旧 Attempt 设为 `superseded`，不覆盖历史。
- 验收失败保留原 Attempt；继续 Relay 时新建子 Attempt，可复用同一 Relay Task/对话。
- 人工交付至少包含说明以及 Commit/MR/补丁链接，或带理由的“无需代码”证明。
- Relay 只有在签名事件证明 `pushed=true`、`verified=true`、`commitSha=remoteSha` 后才能自动 `delivered`。

### 4.4 Build

```text
id, project_id, provider, external_id, version, channel
source_commit_sha, resource_version, download_url
status: registered | queued | building | validating | publishing | ready | failed
manifest_json, started_at, finished_at, created_at
```

构建能否验收由 Commit 包含关系决定，不能只比版本名称。人工登记 Build 必须由 `release_manager` 确认并审计。

### 4.5 Verification

```text
id, bug_id, repair_attempt_id, build_id
status: requested | in_progress | passed | failed | blocked | cancelled
verifier_id, criteria_snapshot
result_summary, failure_reason, blocked_reason
started_at, finished_at, created_at
```

守卫：

- 必须绑定最新且未被取代的 `delivered` Attempt。
- 要求构建的项目必须绑定确认包含精确 Commit 的 Build。
- `passed` 才允许普通 Bug 进入 `closed`。
- `failed` 将 Attempt 标记为 `verification_failed`，Bug 回到 `ready`。

### 4.6 Attachment/Blob

附件元数据和物理 Blob 分离；Blob 以 SHA-256 内容寻址。

```text
attachments: id, project_id, owner_type, owner_id, filename, media_type,
             size, sha256, storage_key, upload_status, scan_status,
             width, height, duration_ms, thumbnail_storage_key,
             created_by, created_at
blobs: sha256, size, storage_key, ref_count, scan_status, created_at
upload_sessions: id, actor_id, expected_size, chunk_size, expires_at, status
upload_chunks: session_id, chunk_number, offset, size, sha256
```

上传流程固定为 `init -> chunks -> finalize -> bind`。服务端必须校验大小、MIME、魔数、Hash、权限和配额。未知类型强制下载，不允许浏览器内联执行 HTML/SVG。

### 4.7 Event、Outbox、Inbox

```text
events: id, project_id, bug_id, sequence, type, actor_type, actor_id,
        source, from_state, to_state, payload_json, idempotency_key,
        correlation_id, causation_id, created_at
outbox_messages: id, topic, aggregate_id, payload_json, status,
                 attempt_count, next_attempt_at, created_at, updated_at
webhook_inbox: provider, external_event_id, delivery_id, body_sha256,
               received_at, applied_at, status
webhook_deliveries: outbox_id, target, status, http_status, error, attempted_at
```

业务状态、Event 和 Outbox 必须在同一事务提交。V1 不做完整 Event Sourcing；关系表是当前状态事实源，Event 用于审计、通知和集成。

### 4.8 IntegrationLink

```text
id, project_id, subject_type, subject_id
provider: relay | gitlab | ozdqp | custom
external_type: task | turn | commit | merge_request | build | job
external_id, external_url, status, external_revision, sync_cursor
metadata_json, last_synced_at, created_at
```

唯一约束：

```text
(project_id, provider, external_type, external_id, subject_type, subject_id)
```

## 5. Bug 状态机

主状态只回答“下一步轮到谁”：

```text
reported              待分诊
needs_info             待补充
ready                  待处理
in_progress            修复中
awaiting_build         待构建
ready_for_verification 待验收
closed                 已关闭
deferred               已暂缓
rejected               不处理
duplicate              重复
```

| 迁移                                       | 必要守卫                                 | 结果                                    |
| ------------------------------------------ | ---------------------------------------- | --------------------------------------- |
| 创建 -> `reported`                         | Bug、首个 Occurrence、Event 原子创建     | 分诊 Inbox 增加                         |
| `reported -> ready`                        | 模块、严重度、优先级、验收要求完整       | 可领取/分配                             |
| `reported -> needs_info`                   | 缺失内容和责任人明确                     | 通知报告人                              |
| `reported/ready -> duplicate`              | 同项目 canonical Bug、无环               | 追加关系和审计                          |
| `ready -> in_progress`                     | 原子创建/启动 RepairAttempt              | 记录处理方式和负责人                    |
| `in_progress -> awaiting_build`            | Attempt 已交付且要求构建                 | 进入发布待办                            |
| `in_progress -> ready_for_verification`    | Attempt 已交付且无需构建或已有可测 Build | 创建 Verification                       |
| `awaiting_build -> ready_for_verification` | Build 包含精确 Commit，或有审计覆盖      | 通知验收人                              |
| `ready_for_verification -> closed`         | 最新 Verification=`passed`               | 保存验收证据                            |
| 验收失败 -> `ready`                        | Verification=`failed`                    | Attempt=`verification_failed`，保留历史 |
| 关闭后新版本复现 -> `ready`                | 新 Occurrence 版本晚于已验收版本         | `reopen_count + 1`                      |

`needs_input`、Relay 阻塞和构建失败优先表现为 Attempt/Build 徽标，避免主状态组合爆炸。

## 6. 重复控制

### 6.1 传输重复

- 手机每次提交生成稳定 `client_submission_id`。
- 所有写接口接受 `Idempotency-Key`。
- 同 key 同 canonical payload 返回原结果。
- 同 key 不同 payload 返回 `409 IDEMPOTENCY_PAYLOAD_MISMATCH`。
- 数据库唯一约束是最终防线；并发重复必须稳定收敛到同一结果。

### 6.2 语义重复

候选只在同项目内检索，第一版按以下可解释信号打分：

- 相同错误签名/顶部堆栈：高权重。
- 相同模块、场景、路由、平台：中权重。
- 标题、现象、复现步骤的中文文本相似度：中权重。
- 截图感知 Hash：辅助权重。
- 同版本或相邻版本：加权。

界面最多展示 3-5 个候选和命中原因，用户选择“追加发生记录”或“仍然新建”。除相同 `client_submission_id` 外，系统不自动合并。

## 7. 独立系统架构

### 7.1 部署边界

```text
D:\Relay-QA-Hub\                 源码和文档
D:\Relay-QA-Hub-Data\            可配置持久目录，生产前核对磁盘容量
├─ db\
├─ evidence\
├─ quarantine\
├─ thumbnails\
├─ logs\
├─ backups\
└─ secrets\
```

- QA Hub 生产服务默认监听回环 `127.0.0.1:4320`。
- 外部入口使用独立 HTTPS 同源，例如 `https://qa.<internal-domain>`。
- 反向代理/Tunnel 只转发需要的 QA 路由，不暴露数据库、内部端口或 Relay 控制面。
- QA Hub 与 Relay 可同机，但任一服务停止不能阻断另一个系统的核心流程。
- QA Hub 不 import Relay 模块，不读取 Relay SQLite，不访问 Relay 附件目录。

### 7.2 建议技术栈

最终版本在 P0 通过 ADR 锁定；已验证起点：

- Node.js `>=24.19 <25`、TypeScript strict。
- npm workspaces 单仓库。
- `apps/web`：保留现有 React/Vite 骨架，post-MVP 仅作桌面批量管理/只读诊断；不再投入 PWA 安装、Service Worker 或浏览器离线捕获。
- `apps/api`：Fastify 或同等轻量 Node API，OpenAPI + Zod schema。
- `apps/worker`：通知、重复候选、Outbox/Inbox、Relay/Build adapter。
- `apps/android`：原生 Kotlin + Jetpack Compose 主客户端；Room 本地队列/缓存、WorkManager 受约束上传重试、前台服务承载 MediaProjection/悬浮球、最小 Poco SimpleRPC/Kotlin 只读 adapter。
- `packages/domain`：状态机和守卫，禁止依赖 Web/DB。
- `packages/contracts`：OpenAPI/事件 schema 和生成类型。
- `packages/storage`：Repository、SQLite 和附件存储接口。
- SQLite WAL 单节点首发；短事务、busy timeout、乐观锁、在线备份。
- Vitest/node:test、Playwright、契约测试和真实设备手工矩阵。

Android 基线冻结为 `minSdk=35`（Android 15）、`compileSdk=37`、`targetSdk=37`、AGP `9.1.1`、Gradle Wrapper `9.3.1`、Build-Tools `36.0.0`，纯 Kotlin/JVM/Android，不引入 NDK、CMake 或本地 C++。Android 16/API 36 仅是运行兼容测试层，不是默认编译目标。仓库已生成并固定 Wrapper/version catalog；本机开发使用 Android Studio bundled JDK，不要求单独安装系统 Java。`2026-08-24T19:27:07+08:00` 修正后的 preflight 已从 `platforms/android-37.0/source.properties` 识别稳定 API `37.0`、`PreviewSdkInt=0` 和真实 `android.jar`，并确认 Studio 2026.1.3、JBR 25.0.2、Platform-Tools 37.0.1、Build-Tools 36.0.0、Command-line Tools、Emulator、license、WHPX 可用。MuMu 实测是 Android 15/API 35、SELinux Permissive；仓库自有 APK 已完成 P3.2 foundation 安装以及 P3.3/P3.4/P3.6 API、附件与 capture 垂直切片。它们仍不是 Android 15+ 真机或 API37 runtime Gate 证据；边界记录在 `docs/ANDROID_SETUP.md`。

模拟器只使用已启用的 Windows Hypervisor Platform/WHPX；绝不为了 AEHD/HAXM 关闭 Hyper-V，因为 Relay worker 正在依赖 Hyper-V。需要的组件为稳定 SDK Platform 37（目录名可为 `android-37.0`，必须以 metadata 判断）、Build-Tools 36.0.0、Platform-Tools、Command-line Tools、Emulator；system image 缺失不阻断当前 API35 MuMu lane。NDK 只有未来明确引入 JNI/本地库时才按 Gradle 锁定版本安装。adb serial/endpoint 只允许通过开发配置注入，不能硬编码到生产 App。MuMu 只能补测试，不能替代 Android 15+ 真机对悬浮窗、MediaProjection、系统回收和 Poco `127.0.0.1` 的 Gate 证据；必须保存 live `getprop`，不能信产品标签。

QA Hub App 的 APK provenance 与被测 Unity 游戏严格隔离：QA Hub APK 只能从 `D:\Relay-QA-Hub` 自有 `apps/android` Gradle 工程构建，并通过 Android SDK `adb` 安装。用户给出的 Jenkins build URL 和 `http://10.100.5.129:8000/apk` 只属于 Unity 游戏项目，严禁用于构建或下载 QA Hub App。只有 Unity 项目确实发生 QA Hub/Poco bridge 所需改动、且该改动按用户要求提交到 Unity 项目 `main` 后，才可触发该 Jenkins，并从 `/apk` 取得与该提交对应的 Unity APK 用于 MuMu 联调。

Android 17/API 37 行为必须显式设计和验证：QA Hub HTTPS 覆盖默认 Certificate Transparency 与网络库实际 ECH 能力；通知/MediaProjection 前台服务覆盖 API 37 通知与生命周期限制；所有 Compose 页面在 `sw600dp+`、多窗口、旋转与尺寸变化下保持自适应，不依赖方向/宽高比锁定。Poco 同机连接只允许同一 Android profile 内的 `127.0.0.1`；`127/8` 不属于产品的 LAN 访问需求，因此不得仅为 Poco 在 manifest 声明或运行时请求广泛的 `ACCESS_LOCAL_NETWORK`。API 37 实机和模拟器都必须证明无该权限时同 profile 回环仍可用、Wi-Fi/LAN 不可用、work profile/跨 profile 回环按平台预期被阻断。未来若新增局域网设备连接，必须另开产品/隐私决策并单独声明和请求该权限。

迁移 PostgreSQL 的触发条件：持续写锁、需要多实例、跨机容灾或数据量/并发实测超出约定。Repository 接口必须预留，但首版不提前引入分布式复杂度。

### 7.3 建议仓库结构

```text
apps/
  api/
  android/
  web/
  worker/
packages/
  contracts/
  domain/
  storage/
  relay-client/
  build-client/
tests/
  contract/
  e2e/
  fixtures/
docs/
  adr/
  runbooks/
scripts/
PROGRESS.md
```

## 8. API 草案

统一前缀 `/api/v1`。所有写请求支持 `Idempotency-Key`；修改已有聚合需要 `If-Match` 或 `expectedVersion`。

```text
POST   /bugs
GET    /bugs
GET    /bugs/{bugId}
PATCH  /bugs/{bugId}
POST   /bugs/{bugId}/transitions

POST   /bugs/{bugId}/occurrences
GET    /bugs/{bugId}/duplicate-candidates
POST   /bugs/{bugId}/mark-duplicate

POST   /bugs/{bugId}/repair-attempts
POST   /repair-attempts/{id}/start
POST   /repair-attempts/{id}/deliver
POST   /repair-attempts/{id}/fail
POST   /repair-attempts/{id}/supersede
POST   /repair-attempts/{id}/dispatch/relay
POST   /repair-attempts/{id}/continue-relay

POST   /bugs/{bugId}/verifications
POST   /verifications/{id}/start
POST   /verifications/{id}/result

POST   /uploads/init
PUT    /uploads/{sessionId}/chunks/{chunkNumber}
POST   /uploads/{sessionId}/finalize
GET    /attachments/{attachmentId}

GET    /bugs/{bugId}/events
GET    /events/stream
GET    /notifications
POST   /notifications/{id}/read
POST   /push/subscriptions

GET    /projects/{id}/builds
POST   /projects/{id}/builds
POST   /builds/{id}/link-repair

POST   /integrations/relay/webhooks
POST   /integrations/build/webhooks
GET    /health/live
GET    /health/ready
GET    /health/deps
```

统一错误：

- `409 INVALID_TRANSITION`
- `409 ACTIVE_REPAIR_EXISTS`
- `409 IDEMPOTENCY_PAYLOAD_MISMATCH`
- `412 VERSION_CONFLICT`
- `422 GUARD_FAILED`
- `401/403` 区分未认证和无权限
- 集成派发返回 `202` 只表示已可靠写入 Outbox，不表示外部系统已接单

## 9. Relay 集成契约

### 9.1 当前边界与禁止项

当前 Relay 已具备任务创建幂等、同任务追加 Turn、真实 `turn.delivered` 证据和构建 Outbox/状态监控，可以复用调度核心。但现有控制 API 无机器授权，SSE 无版本化契约且积压超过 250 条可能产生游标缺口，通用上传会暴露本机路径并缺少附件级授权。

因此：

- Android App 和任何 QA Hub 浏览器绝不直接调用 Relay 4317；客户端只调用 QA Hub API，M2M 仅存在于服务端 integration worker。
- 生产自动回写不依赖现有 UI SSE。
- 不复用 `project_management_*` 字段或轻语完成链路。
- 不向 Relay 同步大视频；Relay 只拉取被选中的图片和小型日志。
- 新增最小、版本化、M2M 认证的 QA Integration API 和 durable Webhook Outbox。

### 9.2 Relay 侧最小模型

```text
qa_handoffs:
  qa_instance_id, handoff_id, defect_id, defect_revision,
  task_id, initial_turn_id, request_hash, created_at, updated_at
  UNIQUE(qa_instance_id, handoff_id)

qa_turn_requests:
  qa_instance_id, action_id, handoff_id, turn_id, request_hash, created_at
  UNIQUE(qa_instance_id, action_id)
```

### 9.3 首次派发

```http
POST /api/integrations/qa/v1/handoffs
Authorization: Bearer <scoped-machine-token>
Idempotency-Key: qa:<instance>:handoff:<handoffId>
```

Relay 必须：

1. 验证 M2M 身份与 `qa:handoff:create` scope。
2. 对 canonical payload 计算 `request_hash`；临时签名 URL不参与。
3. 受控下载附件，校验 URL、跳转、Hash、类型、大小和总量。
4. 在同一事务创建 Task、首 Turn、附件和 handoff binding。
5. 丢失响应后，同请求返回同 Task/Turn；同 key 异 payload 返回 409。
6. 响应只返回安全字段，不返回宿主机路径、Token 或内部凭据。

稳定 key 使用 handoff ID，而不是仅用 Bug ID，因为同一 Bug 可有多次 Relay engagement。

### 9.4 验收失败继续原任务

```http
POST /api/integrations/qa/v1/handoffs/{handoffId}/turns
Authorization: Bearer <scoped-machine-token>
Idempotency-Key: qa:<instance>:action:<actionId>
```

新增动作级幂等后调用现有 Relay `appendTurn()`，确保网络超时重试不会产生重复 Turn。

### 9.5 对账接口

```http
GET /api/integrations/qa/v1/handoffs/{handoffId}
```

返回 Task/Turn 摘要、分支、Commit、thread、最新 delivery evidence、Build 状态、最后事件和 Webhook Outbox 健康。它用于修复推送延迟或映射丢失，不能只依赖 Webhook。

### 9.6 Webhook/Outbox

Relay 只为存在 QA binding 的任务创建版本化 integration outbox；payload 在源事件事务中快照。

```text
Idempotency-Key: relay-main:event:<eventId>
X-Relay-Delivery-Id: relay-main:event:<eventId>
X-Relay-Event-Id: <eventId>
X-Relay-Timestamp: <unix-seconds>
X-Relay-Signature: sha256=<HMAC(timestamp + "." + rawBody)>
```

要求：

- URL 和 secret 只来自服务配置，禁止请求体指定 Webhook URL。
- QA Hub 先校验签名和时间窗，再事务写入 Inbox，随后快速返回 2xx。
- `(relayInstanceId,eventId)` 和 `deliveryId` 唯一去重。
- 408/425/429/5xx 指数退避并遵守 `Retry-After`。
- 400/401/403 等配置错误进入 dead letter 并告警。
- Relay 重启把 `sending` 恢复为 `retrying`，复用同 delivery ID/body/key。
- 同 handoff 保序，不同 handoff 可并行。
- Webhook 禁止携带 Codex 全量消息、本机路径、凭据和未脱敏账号。

### 9.7 状态映射

Relay 事件只能更新当前 `RepairAttempt` 的 Relay receipt/投影和通知；不得自动修改 QA Bug 状态或任何 Verification 结果。允许的投影动作固定为 `repair.queued/submitted/running/needs_input/blocked/failed/fix_delivered/awaiting_build/awaiting_verification` 与 `build.pending/exact_commit_eligible`。

| Relay 来源                                      | RepairAttempt/receipt 投影 | QA 自动动作                                                     |
| ----------------------------------------------- | -------------------------- | --------------------------------------------------------------- |
| 创建响应/`turn.queued`                          | `queued`                   | 记录派发与队列元数据；不改变 Bug/Verification                   |
| 开始执行                                        | `running`                  | 展示正在处理；不改变 Bug/Verification                           |
| `needs_input`                                   | `needs_input`              | 通知报告人/负责人；由人工决定补充、转人工或重试                  |
| `blocked`                                       | `blocked`                  | 记录阻断并通知；不自动改 Bug 状态                               |
| `failed`                                        | `failed`                   | 记录本次 Attempt 失败并通知；Bug 不自动回 `ready`                |
| `turn.delivered` 且远端 Commit/分支证据完整     | `fix_delivered`            | 记录交付证据；按 Build 要求进入 `awaiting_build` 或待人工验收投影 |
| Build 排队/运行                                 | `awaiting_build`           | 更新 Build 进度；不产生 Verification 结果                       |
| Build completed 且精确包含交付 Commit           | `awaiting_verification`    | 绑定 Build 并通知人工验收；绝不自动验收或关闭                    |
| Build failed                                    | `fix_delivered`            | 记录 Build 失败；修复交付证据保留，等待人工处置                  |
| MR merged                                       | 元数据                     | 记录 MR/SHA；不表示 Build、验收或关闭                            |
| `cancelled`、Relay Task closed 或未知 Relay 状态 | 仅原始审计元数据           | 忽略其对 QA Bug/Verification 的任何状态暗示                      |

迟到事件必须检查当前 Attempt generation 和 handling mode，不能覆盖已经转人工或被取代的 Attempt。`cancelled`、`task.closed` 和未识别的原始状态只存审计元数据，不得扩展投影动作 allowlist。

## 10. Android 原生主客户端、离线、取证与通知

### 10.1 App-first 业务体验

- Android App 是唯一主要人机客户端，首页原生实现缺陷创建/编辑、列表/筛选、相似候选、评论、附件、分配、状态、验收、审计、通知，以及“一键交给 Relay”和 Relay 回执；禁止 WebView 包壳。
- QA Hub API/数据库是唯一事实源。Room 只保存按账号/项目隔离的缓存、草稿和本地操作队列；上线后以服务端版本/事件对账，不能在本地决定最终状态或验收。
- Relay 离线时，App 到 QA Hub 的提单、分诊、人工修复登记、Build 关联、验收、失败重开和关闭仍完整可用。
- 共享测试机采用短会话、显式用户/项目上下文、退出撤销通知并清除本账号 Room/媒体/token 命名空间。

### 10.2 Room 队列、WorkManager 与附件

- 草稿、媒体、upload session、chunk ack 和待提交动作进入 Room；每个业务提交持久化稳定 `clientSubmissionId`，映射到 canonical `Idempotency-Key`。
- WorkManager 只承担有网络/电量/存储约束的上传和对账重试；UI 与用户手动重试也是基线。MediaProjection 会话绝不由 WorkManager 或进程重启恢复。
- 上传流程固定为 `/uploads/init -> chunks -> finalize -> bind -> Bug/Occurrence`；响应必须返回 attachment ID 和最终 QA item ID。相同 key/payload 重放返回同一结果，同 key 异 payload 409。
- UI 明确区分“仅本机、等待网络、上传中、失败可重试、已提交、需要重新登录”，禁止把排队或本地保存显示为服务端成功。
- 本地媒体使用 app-private storage 与 Android Keystore 支持的加密；成功后按策略清理，失败/草稿保留期可配置且可手动删除。

### 10.3 悬浮球、MediaProjection 与系统降级

- `SYSTEM_ALERT_WINDOW` 必须经系统设置显式授权并在每次显示前检查；球可拖动、贴边收起。权限撤销时立即移除悬浮球并停止捕获。
- 用户显式开始“测试取证会话”并同意 MediaProjection 后，以 `mediaProjection` 类型前台服务和持续通知维持；不得无感、永久或开机自动截图/录屏。
- Android 14+ 每会话重新同意；token/MediaProjection/virtual display 按单次约束使用，创建前注册 `onStop()`，旋转使用 resize/setSurface。锁屏、用户/系统停止、权限撤销、服务或进程被杀时释放所有 capture 资源并在 UI 解释。
- 悬浮球单击=隐藏悬浮球后采集系统截图与 Poco enrichment 并打开极简草稿；双击=保存待补充草稿；长按=显式开始/停止短录屏。手势可配置且有节流、互斥、触觉/视觉反馈和防误触。
- 硬件截图降级使用 Sharesheet `ACTION_SEND image/*`，其次由用户通过 Photo Picker 选择；不得扫描相册。Android 14 Activity screenshot callback 仅提示本 App 可见 Activity 的截图事件，不提供或冒充其他 App 的截图图像。
- 显著显示捕获状态和立即停止入口；尊重 `FLAG_SECURE`/系统黑屏或拒绝，不绕过、不假成功。提示通知栏、密码、支付、聊天等敏感画面误采风险；通知权限不足以保证显著状态时阻止 capture 并降级到 Share/Picker。

### 10.4 Poco QA Bridge

- Android App 内实现最小 Poco SimpleRPC/Kotlin 客户端。协议是 4 字节 little-endian Int32 长度头加 UTF-8 JSON-RPC 2.0；分配缓冲前拒绝负数/零/超限/截断帧。优先连接配置的 `127.0.0.1` 端口，并兼容探测 Poco 默认 `5001..5005`；以 `GetSDKVersion` 验证标准 Poco，但不能据此推断 Invoke capability。每步都有短超时、总 deadline、取消即关 socket、响应/解压大小上限和无 Poco fallback。
- 点击悬浮球后先隐藏球，再以同一 `captureId`/timestamp 启动系统画面与 Poco enrichment：MediaProjection 用户所见系统画面（主证据）、Poco `Screenshot` 干净 Unity framebuffer（若可得）、`Dump(true)` 可见 UI hierarchy（压缩/裁剪/上限）、`GetScreenSize`/`GetSDKVersion`/`GetDebugProfilingData`（若可得）和自定义 `qa.snapshot`（若 capability 存在）。Poco 重操作在 Unity 主线程可能串行，标准 RPC 也不保证同一帧，因此每个 artifact 记录 start/end/skew，不能宣称原子同帧。任何 Poco 失败都不阻断普通截图草稿；UI 显示“已获取 Unity 上下文 / 部分 / 未连接”，并持久化 `enrichmentStatus=complete|partial|unavailable`。
- capability spike 必须先从实际内置 Poco 源码/assembly/version 证明是否支持 `PocoListenersBase`、`PocoMethod` 和 Invoke 扩展。上游在 Invoke 引入前后都可能返回 `GetSDKVersion=6`，所以必须静态检查相关类型/字段/RPCParser 分支并真实探测 `qa.snapshot`。支持时，测试包可提供 `QaPocoSnapshotProvider : PocoListenersBase`，用 `[PocoMethod("qa.snapshot")]` 暴露只读方法并绑定到 `PocoManager.pocoListenersBase`；旧版仅使用标准 Screenshot/Dump，把 `qa.snapshot` 作为小型、可审计兼容补丁，不能假装原生支持。
- `qa.snapshot` 请求携带 `captureId`、`nonce`、`deadlineMs`、`schemaVersion`，响应回显同一 captureId，并返回带 schemaVersion 的 JSON：build/version/gitSha、scene、game time、脱敏测试用户 ID、关卡/模式、关键网络环境、有限最近错误和项目自定义字段。字段逐步可选；业务状态不硬编码进 App。
- 安全前提：QA/Debug 构建必须把 Poco 从源码默认的 `AsyncTcpServer(IPAddress.Any, port)` 限制为 `IPAddress.Loopback/127.0.0.1`，禁止 LAN 暴露。只做 App allowlist 不足以防恶意同机客户端；Unity server 也必须只注册 `GetSDKVersion`、`Screenshot`、`Dump`、`GetScreenSize`、`GetDebugProfilingData` 和 listener 限定为 `qa.snapshot` 的 Invoke，拒绝 SetText/touch/SendMessage/RotateObject 等操作方法。若实际版本无法安全限制回环和服务端只读面，只能在受控测试机临时使用，并阻断 `G3-ANDROID-APP-READY`。
- 录屏期间不持续 Dump 全层级，只在用户打点或停止录屏时拉取一次。Unity ReadPixels/Poco Screenshot/Dump 必须至少采样 100 次，由 QA 测试自行计算 P50/P95，并测主线程与帧时间影响；标准 profiling 仅是最近值，不能冒充分位统计。超时或超限立刻降级。
- 系统画面、Unity framebuffer、hierarchy 和 snapshot 以同一 captureId 组成证据包。敏感字段默认不采集，错误日志同时限制条数与字节数；nonce/deadline 过期、captureId 不匹配或 schema 不支持的响应被拒绝。

Poco 协议/安全基线以官方上游源码为准：[SimpleRPC Python framing](https://github.com/AirtestProject/Poco/blob/master/poco/utils/simplerpc/transport/tcp/protocol.py)、[Unity TcpServer/framing](https://github.com/AirtestProject/Poco-SDK/blob/master/Unity3D/TcpServer.cs)、[PocoManager RPC/端口注册](https://github.com/AirtestProject/Poco-SDK/blob/master/Unity3D/PocoManager.cs)、[PocoListenerUtils](https://github.com/AirtestProject/Poco-SDK/blob/master/Unity3D/PocoListenerUtils.cs)、[PocoMethodAttribute](https://github.com/AirtestProject/Poco-SDK/blob/master/Unity3D/PocoMethodAttribute.cs) 和 [Unity3D driver/Invoke 文档](https://poco.readthedocs.io/en/latest/source/doc/drivers/unity3d.html)。实际 vendored Poco 优先于上游 `master`，必须保存版本/文件 SHA 并现场验证。

### 10.5 Android 通知

- 业务事务同时写 notification outbox，站内 Inbox 是事实源；Android 通知可失败且不回滚业务。
- 事件覆盖待分诊、被分配、待补充、修复已交付、待构建、待验收、超时和重新打开；点击深链到原生 App 对应 item。
- 锁屏只显示最少信息；订阅失效自动清理，支持静默期、个人偏好和共享测试机退出撤销。

### 10.6 post-MVP Web

现有 `apps/web` 代码和 P0.4 提交完整保留，但从 MVP 关键路径移除，归入 P7.4 的 post-MVP 桌面批量管理/只读诊断台。后续不继续开发 PWA 安装、Service Worker、浏览器离线草稿或浏览器截图/录屏；Web 不称 PWA，也不替代原生 App 的现场流转。

Android 平台基线以官方文档为准：[`SYSTEM_ALERT_WINDOW`](https://developer.android.com/reference/android/Manifest.permission#SYSTEM_ALERT_WINDOW)、[MediaProjection](https://developer.android.com/media/grow/media-projection)、[mediaProjection 前台服务类型](https://developer.android.com/develop/background-work/services/fgs/service-types)、[用户停止前台服务](https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping)、[接收 Sharesheet 内容](https://developer.android.com/develop/ui/compose/sharing/receive)、[Photo Picker](https://developer.android.com/training/data-storage/shared/photo-picker)、[Android 14 截图检测](https://developer.android.com/about/versions/14/features/screenshot-detection)、[`FLAG_SECURE`](https://developer.android.com/reference/android/view/Display#FLAG_SECURE)、[Android Keystore](https://developer.android.com/privacy-and-security/keystore) 和 [app-specific storage](https://developer.android.com/training/data-storage/app-specific)。

## 11. 安全、隐私与审计

- 正式用户优先接 OIDC；不可用时使用本地账户、强密码 Hash、管理员一次性初始化。
- Session Cookie：`HttpOnly; Secure; SameSite=Lax`，写操作具有 CSRF 防护和严格 Origin/Host。
- M2M Token 与 Webhook Secret 仅在环境变量或受保护 secret 文件中，不写 DB、Event、日志或错误体。
- 全面测试 IDOR：跨项目 Bug、附件、Build、Verification、通知均不可访问。
- 上传进入 quarantine，流式写盘，校验魔数/MIME/Hash/配额并进行病毒扫描。
- CSP、HSTS、Referrer-Policy、`nosniff`、下载 disposition 和文件名净化。
- 速率限制：登录、报告、搜索、上传 init/chunk/finalize、Webhook。
- 日志禁止包含 Cookie、Authorization、密码、Token、正文、原始附件和未脱敏账号。
- 共享手机退出时撤销本设备 Android 通知订阅，清理当前用户的 Room、app-private 媒体、token 和内存预览；post-MVP Web 若未来启用，另行清理其浏览器命名空间。
- 关键状态写入审计失败时，业务事务应 fail closed。

## 12. 进度与并行协议

[`../PROGRESS.md`](../PROGRESS.md) 是唯一人工进度指针。状态只允许：

```text
PLANNED | IN_PROGRESS | BLOCKED | VERIFYING | DONE | DEFERRED
```

规则：

1. 每次开发前更新 Active pointer；完成验证后才改 `DONE`。
2. “代码已写、尚未验证”必须是 `VERIFYING`。
3. `DONE` 必须填写验证命令/手工步骤、结果、证据路径、Commit 和时间。
4. 进度使用“完成门禁数/总门禁数”，不使用主观百分比。
5. `last green commit` 与 `last deployed commit` 分开记录。
6. Blocker 必须写证据、影响、解除条件和仍可并行的工作包。
7. 并行时每个工作包只有一个 owner；主代理独占 shared contracts、迁移和 `PROGRESS.md`。
8. 多代理不得同时编辑同一文件；按目录独占分工。
9. 每个 Gate 后运行全量集成验证，再决定是否继续下阶段。

## 13. 分阶段实施计划

App-first 核心关键路径为 `G0 -> G1 -> G2 -> G3-ANDROID-APP-READY -> G4 -> G5 -> G6 -> G8 -> G9 -> G10`，即 Backend/API -> Android App -> Relay adapter -> E2E/发布。P0/G0 历史保持不变；P3 未开始的 Web/PWA 计划由原生 Android 计划取代。

### P0 - G0：计划、ADR 与独立骨架

#### P0.1 初始化独立仓库

要做：

- 在 `D:\Relay-QA-Hub` 初始化 Git、`.gitignore`、npm workspace 和文档入口。
- 明确源码、运行数据、Secret 和备份目录互不嵌套。
- 记录 Node/npm 的绝对可执行路径；PATH 缺 Node 时使用 Codex bundled runtime。

验证：

- `git status --short` 只显示 QA Hub 自身文件。
- `D:\Relay-Unity-Orchestrator` 状态前后逐项一致。
- 数据目录被 Git 忽略且不在源码目录中。

#### P0.2 冻结 ADR

至少形成：

- ADR-0001：QA Hub 是事实源，Relay 是可选执行器。
- ADR-0002：Bug 主状态、RepairAttempt 和 Verification 分离。
- ADR-0003：SQLite WAL 首发与 PostgreSQL 迁移触发条件。
- ADR-0004：附件内容寻址、quarantine 和断点续传。
- ADR-0005：可靠 Outbox/Inbox 与签名 Webhook。
- ADR-0006：认证、共享测试机和项目级 RBAC。

验证：

- 每份 ADR 有 Context、Decision、Consequences、Rejected alternatives。
- 本文所有不可破坏原则均能映射到 ADR。

#### P0.3 冻结 contracts

要做：

- OpenAPI、状态迁移表、错误码、事件 envelope、Relay Handoff/Webhook schema。
- 建立 schema lint、示例 payload 验证和 Breaking Change 检查。

验证：

- 12 个关键场景走查无歧义。
- schema 示例全部自动验证。
- Relay 完成不会自动关闭 QA Bug。

#### P0.4 建立最小运行骨架

要做：

- Web/API/Worker/Domain/Contracts/Storage 空骨架。
- `/health/live` 和版本信息。
- lint、typecheck、unit、build、contract、e2e 命令占位并在 CI/本机可运行。

验证：

- 空库启动、健康 200、优雅退出、重启均成功。
- `npm ci`、lint、typecheck、test、build 全绿。

Gate `G0-CONTRACT-READY`：P0.1-P0.4 全绿，进度文件证据齐全。

### P1 - G1：独立基础、数据库与可靠消息

#### P1.1 数据模型和迁移

要做：

- 实现 users、projects、memberships、modules、bugs、occurrences、repair_attempts、builds、verifications、attachments/blobs、events、integration_links、outbox/inbox、notifications。
- 外键、唯一约束、Check、索引、FTS 基础和 `version` 乐观锁。

验证：

- 空库迁移、重复运行、从前一 schema 升级均成功。
- `foreign_key_check`、`integrity_check` 通过。
- 50 并发建单仍生成唯一项目编号。

#### P1.2 Domain 状态机

要做：

- 在纯 Domain 包实现所有迁移和守卫，不允许 UI/DB 绕过。
- 状态、Event、Outbox 同事务。

验证：

- 每个合法/非法迁移有单元测试。
- 缺 Verification 关闭、修复人自验 S0/S1、重复环、双活跃 Attempt 均被拒绝。
- 并发版本冲突返回 412，不覆盖他人变更。

#### P1.3 可靠 Outbox/Inbox

要做：

- claim、指数退避、`Retry-After`、dead letter、重启恢复、同聚合保序。
- Inbox 去重、乱序/迟到保护和可重放投影。

验证：

- 事务后崩溃、发送中重启、重复/乱序/迟到事件无丢失或重复应用。
- Outbox 不可用不回滚已完成业务事务。

#### P1.4 健康、日志和配置

要做：

- `/health/live|ready|deps`、request ID、JSON 日志、配置 schema、Secret 脱敏。

验证：

- 断 DB、附件盘只读、磁盘阈值和 Worker 停止能区分健康状态。
- 自动扫描日志不含敏感头和正文。

Gate `G1-INDEPENDENT-FOUNDATION`：关闭 Relay 后 QA Hub 仍可启动、创建测试数据、恢复 Outbox。

### P2 - G2：认证、权限与审计

#### P2.1 用户认证

要做：

- 本地账户首发或 OIDC adapter；一次性管理员初始化；会话撤销、密码重置、限流。
- 报告邀请 QR：短期、项目/Build/Test Cycle 限权，不赋予列表或管理权限。

验证：

- 未登录、过期、撤销、错误密码、爆破和会话固定攻击测试。
- Cookie/CSRF/Origin/Host 策略通过自动测试。

#### P2.2 项目 RBAC

要做：

- 角色矩阵和项目成员管理；服务身份使用独立 scope。

验证：

- 每个角色对每个核心端点的 allow/deny 矩阵自动化。
- 跨项目 IDOR 全部 403/404，不泄露资源存在性。

#### P2.3 追加审计

要做：

- actor、request、IP、user-agent、correlation、状态前后、理由和证据引用。
- 不记录请求正文、Secret 和原始附件。

验证：

- 关键变更与审计原子；审计写失败时关键动作不悄悄成功。
- 审计事件不可通过普通 API 修改/删除。

Gate `G2-SECURITY-READY`：鉴权/RBAC/CSRF/IDOR/审计测试全绿。

### P3 - G3：Android 原生主客户端与 Poco QA Bridge

#### P3.0 App-first contract delta

根代理基于 P0.3 的 `1.0.0` 历史基线发布追加 contract 版本，冻结 native auth/短会话、首页列表/筛选/评论/分配/状态/验收/审计/通知读取与写入、上传 finalize 返回 `attachmentId`、附件 bind、`clientSubmissionId -> Idempotency-Key`、最终 QA item ID、Relay handoff/receipt 读模型、capture bundle 和 Poco enrichment schema。写路径同时冻结：交付创建版本化 BuildRequirement 及不可变 decision audit，明确 `code_requires_build | no_code_delivery | authorized_no_build_exemption`；要求构建时，Build/交付时 Bug 版本/BuildRequirement 三重 CAS 后才原子绑定 exact manifest evidence 或带理由、actor、policy、audit 的 release-manager override，并且只能推进到 `ready_for_verification`；create/result 必须复用该已提交 decision/relation。所有声明 vendor media 的写操作同时保留可达的冻结 `application/json` wire，shape 未变化时 vendor media 复用经正确 rebasing 的基础 schema。1.1 vendor supersede 在同一事务创建唯一、server-sequenced、client-identified successor，继承的 `application/json` 明确保留“旧 Attempt superseded、Bug ready，再 createRepairAttempt(parent=old)”两步兼容语义。新增版本、OpenAPI 示例、错误、executable scenarios 与 breaking 检查，不改写 P0.3 提交。

验证：Android 所需 API 没有隐式 Web session 或 Relay 依赖；`init -> chunks -> finalize -> bind -> create/append` 可重放；同 key 异 payload 409；跨账号/项目拒绝；captureId/enrichmentStatus/QA item ID 响应无歧义；逐操作证明 legacy/vendor request 与 success wire 都可达；`deliver(required) -> register -> link(manifest|audited override) -> createVerification -> start -> human result` 以及 `deliver(code+authorized no-Build exemption) -> createVerification -> start -> human result` 都是连续可达的同一 decision/relation 版本链。foreign artifact/manifest scope、缺 Build/link、stale Bug/requirement、不可能 BuildRequirement wire 状态、伪造 decision/evidence audit、重复 successor、自动验收/关闭均拒绝；vendor/legacy 精确 replay 只在当前可见并重新授权后返回原收据。P3.0 全绿后才能开始原生业务实现。

#### P3.1 Poco capability 与安全 spike

只读定位实际被测 Unity 内置 Poco 的 package/assembly/source/version/文件 SHA，核实 4-byte little-endian frame 与 JSON-RPC shape、`GetSDKVersion`/`Screenshot`/`Dump(true)`/`GetScreenSize`/`GetDebugProfilingData`、5001..5005 回退，以及 `PocoListenersBase`/`PocoMethod`/Invoke 是否真实存在。`GetSDKVersion=6` 不能证明 Invoke；必须检查 vendored 源码并做真实 probe。证明当前监听地址和已注册 RPC；若源码是 `AsyncTcpServer(IPAddress.Any, port)` 或注册操作方法，给出最小 Loopback+server read-only 补丁和回滚边界。此 spike 可与 P3.2 并行，不修改 Relay。

验证：保存实际版本/commit 或 vendored SHA 与源码行证据；127.0.0.1 握手成功；LAN IP 连接失败；5001 占用或非 Poco 服务时安全回退/不误判 5002..5005；恶意同机客户端的操作 RPC 被 server 拒绝；旧版/无扩展机制被准确标注而非假装支持。未找到权威 Unity 工程路径时记录 blocker/解除条件，但不阻断 P1/P2/P3.2 的 fake 实现。

#### P3.2 Android native foundation

在独立 `apps/android` 建立 Kotlin/Jetpack Compose 主客户端、原生导航/首页、版本化 API client、Room 账号/项目隔离缓存与队列、WorkManager 约束重试、Keystore 支持的本地加密、fake QA Hub 和 unit/instrumented test 基础。不是 WebView，也不 import Relay。

验证：工具链 preflight 以 metadata 识别稳定 API 37 并已通过；生成工程后 clean Gradle build、lint/unit、进程重启、账号切换/退出清理、schema 版本升级/降级拒绝、fake API offline/reconcile 全绿；`minSdk=35`、`compileSdk=37`、`targetSdk=37`、AGP `9.1.1`、Gradle `9.3.1`、Build-Tools `36.0.0` 有 version catalog/module/wrapper 证据。工程未生成或 build/test 未跑时本步骤不得标 DONE 或声称 APK 已构建。QA Hub APK 必须出自本仓库 Gradle task 并记录 SHA，不能取自 Unity Jenkins 或 Unity `/apk` 目录。

#### P3.3 后端证据与移动 API

实现 quarantine、分块、Hash、MIME/魔数、病毒扫描、finalize、bind、孤儿清理、安全预览，以及 Android 首页所需分页/筛选/评论/分配/状态/验收/审计/通知 API。Domain/RBAC/audit 仍是服务端守卫，App 不可绕过。

验证：空/超限/伪 MIME、路径穿越、恶意 SVG/HTML、重复/缺块、并发 finalize、跨项目 bind 和 IDOR fail closed；最终 Blob 仅一份；分页/筛选与详情一致。

#### P3.4 Room/WorkManager 离线附件队列

实现草稿、媒体、upload session/chunk ack、业务动作和 auth-refresh 状态机；网络恢复后续传，响应丢失后以同一 key 对账，服务端 ID 回写本地 item。上传成功按策略清理，失败/草稿保留可配置。

验证：飞行模式、Wi-Fi/蜂窝切换、进程/App 被杀、服务重启、登录过期、重复点击和响应丢失最终只产生一个 attachment/QA item；20 MiB 图片和短录屏续传成功，不产生孤儿。

#### P3.5 原生全流转首页

实现创建/编辑、列表/筛选、去重候选、评论、附件、分配、主状态、人工/外部修复、Build、验收、审计时间线、通知 Inbox，以及 Relay 一键派发/回执展示位。P3 阶段使用 fake Relay；P5 再接真实 adapter。

验证：App 内完整人工闭环；Relay 关闭仍可上报到验收关闭；30 秒快速提单；修复人与验收、版本冲突、重复候选人工决定和未通过 Verification 禁止关闭均成立。

#### P3.6 悬浮球、MediaProjection 与系统分享

实现 SAW 明示授权、拖动/贴边收起、显式取证会话、mediaProjection 前台服务/通知、Android 14+ 单次授权与 onStop 清理、单击/双击/长按、防误触、Sharesheet receiver、Photo Picker 和 `FLAG_SECURE` 安全降级。单击先隐藏悬浮球，再创建 captureId 并行调用 P3.7 enrichment。

验证：拖动不触发、双击不连带单击、长按恰一次；权限拒绝/撤销、旋转、锁屏、来电/弹窗、Task Manager Stop、服务/App 被杀都不自动恢复捕获；普通截图草稿始终可提交。

#### P3.7 Android Poco 只读 adapter 与证据包

实现 allowlist-only 的最小 SimpleRPC/Kotlin client：配置端口优先、127.0.0.1:5001..5005 能力探测、GetSDKVersion 标准握手、4-byte little-endian frame 校验、短超时/总 deadline/取消即关 socket、响应与解压上限。以同一 captureId 关联系统画面、Poco Screenshot、Dump(true)、screen/version/profiling 和可选 `qa.snapshot`，记录每项 start/end/skew 并产生 `complete|partial|unavailable`；不实现 SetText/touch/SendMessage。

验证：负数/零/超长/截断 frame、错 JSON-RPC id、非法 JSON、Poco 不存在/旧版/非 Poco 占端口/超时/取消/超大 hierarchy/Unity 崩溃均快速降级且不阻断草稿；captureId/nonce/deadline/schema 不匹配被拒；录屏仅打点或停止时 Dump，一次 capture 的结果按时间稳定关联但不冒充同帧原子快照。

#### P3.8 Unity qa.snapshot 最小兼容层

在实际 Poco capability 证据基础上，仅对内部 QA/Debug 测试包新增薄层：支持扩展的版本实现 `QaPocoSnapshotProvider : PocoListenersBase`、`[PocoMethod("qa.snapshot")]` 并绑定 `PocoManager.pocoListenersBase`；旧版采用最小兼容 patch 或只保留标准 Screenshot/Dump。监听必须改为 Loopback，server 注册表必须移除操作 RPC，返回版本化、大小受限、默认脱敏且回显 captureId 的 JSON；IL2CPP stripping 使用 `[Preserve]`/最小 link.xml 保护 provider，不实现完整 Reporter 或业务控制。

验证：Mono/IL2CPP、横竖屏、弱机下可用；恶意同机客户端、过期 nonce/deadline、超大/敏感字段被拒；同 profile 的 127.0.0.1 可连且 Wi-Fi/LAN 地址不可连。API 37 下不得为同机 Poco 请求 `ACCESS_LOCAL_NETWORK`，work profile/跨 profile 回环必须失败。若无法限制 Loopback，阻断 G3 debug-ready。

#### P3.9 App/Poco 真机、性能与安全矩阵

至少覆盖 Android 15/API 35（当前 MuMu + 一台真机）、Android 16/API 36、Android 17/API 37、Pixel/AOSP 与一个强省电 OEM；当前 MuMu 已实测为 Android 15/API 35/SELinux Permissive，只承担 API35 emulator lane。交叉权限回收、方向/分辨率、锁屏、来电/弹窗、断网、重复、20 MiB 图片/短录屏、App/Unity crash、5001 占用、Poco 不存在/旧版、超时/超大 Dump、IL2CPP、弱机、恶意同机客户端和 `FLAG_SECURE`。API 37 额外覆盖 `ACCESS_LOCAL_NETWORK` 不声明/不请求的同 profile loopback 正例与 LAN/跨 profile 反例、`sw600dp+` 强制自适应和方向限制失效、CT/ECH、通知自定义视图与 MediaProjection 前台服务行为。测量 Unity ReadPixels/Screenshot/Dump 的 P50/P95 延迟、主线程和帧影响。MuMu API level 必须以 adb `getprop ro.build.version.sdk` 为证据，且不能替代任何真机的 overlay/MediaProjection/系统回收/Poco/SELinux 验证。

Gate `G3-ANDROID-APP-READY`：P3.0-P3.9 全绿；Android App 是可安装的原生主要客户端并跑通 Relay 离线人工闭环；普通截图在 Poco 任意失败下可提交；Poco 只允许回环只读；重复/重试只有一个 QA item；保存 APK/AAB SHA、设备/Unity/Poco 版本、request ID/item ID、性能与录屏证据。此 Gate 是 App-first 核心关键路径。

### P4 - G4：人工修复和验收闭环

#### P4.1 人工/外部 RepairAttempt

要做：领取、分配、进度、交付证据、Commit/MR/外部链接、转交和 supersede。

验证：Relay 停止时，人工和 external 流程完整可用；缺交付证据不可进入待验收。

#### P4.2 Build 登记与 Commit 包含关系

要做：手工 Build、provider adapter 接口、精确 SHA 和 Release Manager 审计覆盖。

验证：错误 SHA、仅版本名匹配、失败 Build 都不能用于验收。

#### P4.3 Verification 和失败重开

要做：验收领取、criteria snapshot、通过/失败/阻塞、S0/S1 分离职责、关闭和重开。

验证：

- 完整人工流程从上报到通过关闭。
- 缺 Verification 无法关闭。
- 验收失败保留全部历史并回到 `ready`。
- 关闭后新版本复现可重开，旧版本复现默认只追加 Occurrence。

Gate `G4-HUMAN-CLOSED-LOOP`：在 Relay 完全离线状态，通过 Android App 跑通一条真实人工 Bug。

### P5 - G5：Relay 一键派发与可靠回写

#### P5.1 QA 侧 Relay Client 和 Fake Relay

要做：版本化 contract、M2M、Outbox、附件选择、fake server、错误/重试/对账测试。

验证：QA 侧在不改 Relay 的情况下完成 contract tests；Android App 和任何浏览器都看不到服务端 M2M 凭据。

#### P5.2 Relay 侧最小 Integration API

要做：qa_handoffs、qa_turn_requests、scoped M2M、canonical hash、安全附件拉取、对账接口。

约束：

- 开始前重新审计 Relay 脏工作树和重叠文件。
- 不 reset/clean/stash/restore/rebase；保留用户全部改动。
- 尽量新增独立模块，核心 Scheduler/Worker 语义不变。

验证：同 handoff 连点 10 次只创建一个 Task；同 key 异 payload 409；并发重复稳定；附件失败无任务/临时残留。

#### P5.3 Relay Webhook Outbox

要做：签名、快照 payload、重试、dead letter、保序、重启恢复和 QA Inbox。

验证：

- QA 下线时 Relay Turn 仍成功，Outbox 持续重试。
- 篡改、过期、重复、乱序、迟到事件安全处理。
- 模拟超过 250 条事件无缺口，证明未继承 SSE 风险。
- 对账接口能修复投影缺口。

#### P5.4 状态投影和继续原任务

要做：delivery evidence 校验、Build 投影、needs_input/blocked/failed、验收失败 action 幂等追加 Turn，并在 Android App 原生页面展示 handoff/receipt/对账状态。

验证：

- Codex 完成但 Git 交付失败不标记 delivered。
- 远端 SHA 验证通过才自动待构建/待验收。
- `task.closed` 不关闭 QA Bug。
- 验收失败重试两次只追加一个 Turn。
- Bug 转人工后迟到 Relay 事件不覆盖当前处理人。

#### P5.5 Relay 生产 reload 门禁

只有确实需要重载 Relay 时：重新查询 `/api/health`、`/api/snapshot`、Ops、live Turn、checkpoint maintenance；等待所有 Active/Queued/Ops/maintenance 门禁空闲，不暂停、抢占或取消任务。通过 Guardian 安全重载后验证真实 4317/3000、scheduler 未暂停、现有任务不受影响。

Gate `G5-RELAY-INTEGRATED`：真实 QA Bug 一键创建 Relay Task，交付后自动进入正确状态但未自动关闭。

### P6 - G6：构建流水线和通知

#### P6.1 Build adapter

要做：通用 Build contract、OZDQP adapter、人工 provider、状态重试和 Commit identity。

验证：completed 只在 Job/项目/分支/完整 SHA/mode 均匹配时接受；失败后同 Job 恢复可继续推进。

#### P6.2 Inbox、Android 通知和提醒

要做：站内 Inbox、Android notification/push token 轮换、静默期、原生待办深链、超时升级；Push 失败不影响 Inbox 事实。

验证：服务/App 崩溃重启后通知不丢不重；过时提醒被取消；Android 15/16/17 真机通知；API 37 自定义通知视图大小限制和 MediaProjection 前台服务可见通知满足平台约束；拒绝通知权限时 App Inbox 可靠降级。

Gate `G6-BUILD-VERIFICATION`：真实构建完成后指定验收人收到通知并进入待验收。

### P7 - G7：重复候选、搜索和工作台

#### P7.1 相似候选

要做：FTS、规范化指纹、错误签名、可选截图 pHash、候选解释。

验证：固定数据集 precision/recall 基线；不跨项目；绝不自动语义合并。

#### P7.2 工作台和筛选

要做：待我处理/验收/补充、由我报告、模块、版本、负责人、严重度、状态、发生次数、保存视图。

验证：复杂组合筛选可重放、分页稳定、无重复/遗漏；Android App 与 API 查询结果一致。

#### P7.3 统计

要做：新 Bug、回归、重复率、交付到验收时长、重新打开率、版本分布；导出 CSV/Excel 只读快照。

验证：指标能从事实表重算；导出不能反向覆盖 QA Hub。

#### P7.4 post-MVP 桌面管理/诊断 Web

状态：`DEFERRED`，不属于 `0.1.0-debug` App-first 关键路径。完整保留 P0.4 `apps/web` 资产；未来若恢复投入，只实现大屏批量管理或只读诊断，并先移除“PWA/手机主客户端/离线取证”产品表述。不得用它替代 Android 真机 Gate。

Gate `G7-WORKBENCH-READY`：真实 Debug 数据能快速定位负责人、状态、版本和待办。

### P8 - G8：安全、性能、备份与恢复

#### P8.1 安全加固

验证：鉴权、RBAC、CSRF、XSS、IDOR、上传、速率限制、安全 Header、Secret 扫描全部通过。

#### P8.2 性能和故障注入

验证：约定并发/数据量下 p95/p99 达标；DB busy、磁盘不足、Push/Relay/Build 下线无数据丢失或假成功。

#### P8.3 备份

建议初值：

- 每 15 分钟 SQLite 在线备份，保留 24 小时。
- 每小时 DB + 新附件清单到异盘，保留 7 天。
- 每日完整一致性清单到离机位置，保留 30 天。
- 每周和重要 migration 前执行隔离恢复演练。

每个备份必须运行 integrity/foreign key、附件引用/Hash 和清单校验。

#### P8.4 隔离恢复

恢复到独立目录/端口，默认关闭通知和 Relay 集成；验证登录、搜索、Bug、时间线、附件和计数，不覆盖当前生产目录。

Gate `G8-OPERATIONS-READY`：随机备份真实恢复，记录实际 RPO/RTO，前一版本可回切。

### P9 - G9：Android/Poco 真实设备和 E2E

#### P9.1 真实设备矩阵

测试槽位：

| 槽位                     |     原生全流转 |             Capture/Share |                                              Poco 标准 RPC |     qa.snapshot | 离线/续传 |            通知 |
| ------------------------ | -------------: | ------------------------: | ---------------------------------------------------------: | --------------: | --------: | --------------: |
| 当前 MuMu / Android 15 / API 35 / Permissive | 自动化/补测 | 补测，不作安全 Gate | 回环功能补测 | capability 决定 | 必测 | 补测 |
| Android 15 / API 35 真机 |           必测 |         FGS/BOOT 限制必测 |                                                       必测 | capability 决定 |      必测 |            必测 |
| Android 16 / API 36 真机 |   运行兼容必测 |       API 36 兼容行为必测 |                                                       必测 | capability 决定 |      必测 |            必测 |
| Android 17 / API 37 真机 | target 37 必测 |   FGS/通知/大屏自适应必测 | 同 profile loopback 成功且无 LAN 权限；LAN/跨 profile 失败 | capability 决定 |      必测 | API 37 限制必测 |
| 强省电 OEM 真机          |           必测 |        权限回收/kill 必测 |                                              回环/LAN 必测 | capability 决定 |      必测 |            必测 |

每个槽位交叉 Wi-Fi/蜂窝/切换/飞行模式/弱网、锁屏/后台/App kill/Unity crash、权限拒绝/撤销、磁盘不足、20 MiB 图片/短录屏、单/双/长按、横竖屏/分辨率/字体 200%/深色模式、5001 占用与 5002..5005 回退、超时/超大 hierarchy、IL2CPP/弱机/恶意同机客户端/`FLAG_SECURE`。API 37 还要保存未声明 `ACCESS_LOCAL_NETWORK` 的 manifest 证据、同 profile/跨 profile loopback 结果、LAN 拒绝、`sw600dp+`/多窗口状态保存、默认 CT 与所选网络库 ECH 协商/fallback、通知/FGS 结果。MuMu 的真实 API level 在 adb 可用后用 `getprop ro.build.version.sdk` 记录；模拟器只补自动化，不替代任何必测真机。

Gate `G9-REAL-DEVICE`：保存 Android/设备/Unity/Poco/App 完整版本、APK/AAB SHA、录屏、request ID/item ID、P50/P95 和结果；不能用 DevTools、MuMu 标签或模拟器替代真机证据。

### P10 - G10：独立生产 Canary 与 Debug 上线

#### P10.1 Windows 服务化

- 独立低权限账户、回环监听、外部 watchdog、延迟启动、日志轮转、防火墙。
- 杀进程后自动拉起；服务账户不能读取 Relay secrets。

#### P10.2 蓝绿/可回滚发布

- 隔离端口启动新版本，健康和 canary 后切反代。
- migration 前在线备份；版本、schema、Build SHA 可查询。
- 回切不依赖数据库降级，前一目录保留。

#### P10.3 真实 Canary

使用已记录 SHA 的 Android App，在真实 HTTPS、真实数据目录、真实通知和真实 Relay 上完成：

```text
原生登录 -> 悬浮球系统截图+Poco enrichment -> 离线草稿 -> 断点上传 -> 提单 -> 分诊 ->
人工修复 -> 验收失败重开 -> 验收通过 ->
Relay 一键派发 -> 自动交付/构建标记 -> 待验收 ->
搜索/筛选 -> 备份 -> 隔离恢复抽查
```

#### P10.4 小范围上线

- 专用测试项目/小组运行 24 小时，再扩大。
- 24 小时内不得出现数据丢失、技术重复 Bug、严重越权、通知积压或磁盘异常。
- QA、开发、运维三方确认。

Gate `G10-PRODUCTION-CANARY`：真实用户 URL 验证通过并记录最后部署 SHA、备份和回滚点。

## 14. 可并行执行车道

P0 contracts 冻结后：

| 车道                   | 独占目录/工作                                                                                      | 可并行阶段                     | 汇合点     |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------ | ---------- |
| A Domain/API           | `packages/domain`, API handlers；主代理独占迁移/contracts                                          | P1/P2/P4                       | G4         |
| B Android App          | `apps/android`；Compose、Room、WorkManager、capture、Poco client、原生流转 UI；使用 fake contracts | P3.2/P3.4-P3.7/P4；P3.0 后启动 | G3/G4      |
| C Evidence/Reliability | storage、upload、outbox/inbox、worker                                                              | P1/P3/P6                       | G6         |
| D Integrations/Test    | relay-client、build-client、fake servers、contract/e2e                                             | P5/P6                          | G6         |
| E Ops/Security         | runbooks、health、backup、service scripts、安全测试                                                | P2/P8/P10                      | G8/G10     |
| F Poco QA Bridge       | 实际 Unity QA/Debug 测试包中的最小 loopback/provider 兼容层；先只读审计，后独占明确文件            | P3.1/P3.8                      | G3         |
| W post-MVP Web         | `apps/web`；仅未来桌面批量管理/只读诊断                                                            | P7.4 DEFERRED                  | 不阻塞 0.1 |

并行纪律：

- 根代理独占 `package*.json`、workspace 配置、contracts、迁移、`PROGRESS.md` 和最终集成。
- 子代理只编辑被明确分配的独占目录，不修改共享文件。
- 需要共享 schema 时先由根代理冻结版本，再并行。
- 每个车道先跑局部测试，汇合时根代理跑全量测试。
- Relay 侧改动与 QA Hub 核心开发可并行，但生产重载必须单独执行 Relay 空闲门禁。

## 15. 全局验证矩阵

### 自动化

- lint、format check、TypeScript strict、依赖锁一致性。
- Domain 状态机和权限矩阵单测。
- SQLite migration、约束、并发、事务/Outbox/inbox 测试。
- OpenAPI/Event schema/Breaking Change 契约测试。
- API integration、CSRF/IDOR/幂等/乐观锁测试。
- 上传对抗、续传、Hash、病毒扫描和孤儿清理测试。
- Relay fake/真实 contract、Webhook 签名/乱序/重试/对账测试。
- Android Compose/Room/WorkManager、权限/手势/lifecycle、fake API、幂等队列、加密保留和 URI/MIME 对抗测试。
- Poco protocol fixtures、allowlist、timeout/cancel/size、captureId/nonce/deadline/schema 与 loopback/LAN 安全测试。
- post-MVP Web 不新增 PWA/Service Worker/offline 测试投入；现有 P0.4 build 仅作为保留资产回归。
- 备份校验和隔离恢复脚本测试。

### 必须手工或真实环境验证

- Android 15/16/17 原生 App 安装、全流转、MediaProjection/overlay/Share/Picker、离线恢复与通知；API 35 是最低支持层，API 36 为运行兼容层，API 37 额外覆盖本地网络权限、同/跨 profile 回环、大屏自适应、CT/ECH 与通知/FGS 行为。
- Poco 真实回环连接、LAN 不可达、标准/旧版/qa.snapshot、IL2CPP/弱机和 ReadPixels/Dump 性能矩阵。
- 真实借用设备退出后的本地数据清理。
- 真实 Relay 一键派发和 delivery evidence。
- 真实 Build/CDN identity 和待验收通知。
- Windows 服务开机恢复、watchdog、日志轮转、防火墙。
- 真实 HTTPS canary、备份和隔离恢复。

## 16. 发布门禁

生产切流必须全部为绿：

1. `BUILD`：锁文件、lint、typecheck、unit、API、migration、build。
2. `DATA`：migration 前备份，新旧版本 schema 兼容。
3. `SECURITY`：认证、RBAC、CSRF、IDOR、上传、限流、Header。
4. `ANDROID`：G3/G9 原生 App、capture、Poco loopback 和真机矩阵通过，记录 APK/AAB SHA。
5. `RESILIENCE`：App/服务/Unity 重启、重复提交、通知/Relay/Build 故障无丢失。
6. `OPS`：watchdog、告警、磁盘、日志轮转、备份年龄正常。
7. `RESTORE`：当前 release 备份在隔离端口恢复成功。
8. `CANARY`：真实 HTTPS 在 Wi-Fi/蜂窝完成 E2E。
9. `ROLLBACK`：前一构建和回切步骤存在，不要求 DB 降级。
10. `APPROVAL`：QA、开发、运维确认。

独立 QA Hub 部署不需要等待 Relay Active Turns 为零；只有同批次修改/重载 Relay adapter 时，才执行 Relay 专属空闲门禁。

Android App 是主工件且 `G3-ANDROID-APP-READY` 位于关键路径；没有真实 APK/AAB、真机/Poco/离线证据时，服务端临时端口或保留的 Web 壳都不能代替 App-first 完成。

## 17. 完成定义

QA Hub `0.1.0-debug` 只有满足以下全部条件才算完成：

- 无轻语运行时、数据、认证或状态依赖。
- Relay 完全离线时人工闭环可用。
- 一键交给 Relay 幂等，自动回写可靠，Relay 不可自动关闭 Bug。
- 人工、Relay、外部三种修复模式均有真实 E2E。
- 修复人与验收、交付与构建、构建与精确 Commit 的边界可证明。
- Android App 原生首页覆盖全部现场流转；30 秒上报、Room 离线草稿、WorkManager 断点续传和通知在真实设备通过。
- 悬浮球系统画面是主证据，Poco enrichment 可用/部分/未连接均真实显示且不阻断普通缺陷；Poco 仅回环只读。
- 重复提交不重复建单，相似候选不自动合并。
- 权限、审计、附件安全、备份、恢复、监控和回滚门禁通过。
- 生产 URL、部署 SHA、schema、最近备份、最近恢复演练和回滚点写入 `PROGRESS.md`。

## 18. 最高风险与应对

| 风险                                | 应对                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 现有 Relay API 无 M2M 授权          | 新建 scoped integration routes；Android/Web 客户端都不直连 Relay，M2M 凭据只在服务端                                  |
| SSE 超 250 条可能漏事件             | durable webhook outbox + inbox + reconcile API                                                                        |
| 创建幂等无 payload hash             | handoff/action canonical hash + DB unique                                                                             |
| 后续 Turn 无幂等                    | 新增 `qa_turn_requests` 动作键                                                                                        |
| Relay 上传接口暴露本机路径          | QA 保管证据，Relay 受控拉取，响应白名单                                                                               |
| Relay 工作树已有大量用户改动        | 独立目录开发；Relay 阶段逐文件审计，禁止破坏性 Git                                                                    |
| SQLite 写竞争或附件膨胀             | WAL/短事务/指标/磁盘阈值；达到触发条件迁移 PostgreSQL                                                                 |
| Android 工具链已绿但工程/设备证据未产生 | P3.0/P3.1/P1/P2 继续；P3.2 生成并 pin AGP 9.1.1 + Gradle 9.3.1 + SDK37/Build-Tools36.0.0；adb 无设备时不宣称 instrumented/真机通过 |
| Android 截图权限或生命周期被误解    | 每次显式 MediaProjection 同意、前台服务通知、onStop 清理、Sharesheet/Photo Picker 降级；禁止静默捕获和相册扫描        |
| App 误采敏感内容或 Poco 暴露控制面  | 显著状态/停止入口、尊重 FLAG_SECURE、本地加密/保留；Poco 仅 loopback+只读 allowlist，LAN 暴露阻断 Gate                |
| Poco 不存在、旧版或自定义扩展不兼容 | 先做实际版本 capability spike；标准 Screenshot/Dump fallback，qa.snapshot 薄兼容层，不实现完整 Reporter               |
| 借用手机数据串用                    | 短会话、默认无 Push、退出清理本地命名空间                                                                             |
| Relay 迟到事件覆盖人工处理          | Attempt generation、handling mode 和 event order 守卫                                                                 |
| Build 完成但不含修复 Commit         | 精确 SHA/manifest identity，Release Manager 覆盖需审计                                                                |
| 源码完成被误当上线                  | 真实 URL、真实设备、真实恢复和 canary 门禁                                                                            |

## 19. 开始实施时的第一批动作

严格按顺序：

1. 更新 `PROGRESS.md`：P0.1=`IN_PROGRESS`，记录 owner 和时间。
2. 在 `D:\Relay-QA-Hub` 初始化独立 Git/npm workspace，不改 Relay。
3. 将本文决策拆成 ADR，并冻结 contracts。
4. 建立本机可运行的 Web/API/Worker/Domain/Contracts/Storage 骨架。
5. 验证空库健康、全量基础命令和 Relay 工作区未变化。
6. App-first 决策后执行 P3.0 contract delta；通过后并行启动 P3.1 Poco spike、P3.2 Android foundation 与 P1/P2 backend。
7. Android toolchain preflight 已通过；P3.2 生成工程并完成 clean build/lint/unit 前仍不得标 build green，adb 无 MuMu/真机时不得标 instrumented/device green；绝不为模拟器关闭 Hyper-V。
