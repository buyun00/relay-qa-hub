# 项目组件配置与恢复操作说明

适用 2026-09-09 本工作树独立预览实例。以下全部为 **无真实凭据的模板**，`.invalid` 服务和示例 ID 必须替换为获准的独立测试资源，不能复制生产配置。模板默认 `enabled:false`。结构完整或状态 `ready` 只表示字段具备，不表示已经验证外部连接或完成真实任务。

## 实例目录和配置接口

当前预览 `runtimeRoot` 为 `C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86`，API 4419；组件配置、任务与凭据不使用生产目录。

- 凭据根：`runtimeRoot/credentials`。
- 组件根：`runtimeRoot/components`。
- 版本目录：`components/projects/<QA项目UUID>/components/<componentKey>/versions/<version>/`。
- SQLite 业务目录中的 `dataRoot/.qa-hub-import-hold.json` 控制离线导入后的执行暂停。`dataRoot` 以该独立实例配置为准，不等于组件目录。
- `GET /api/v1/projects/<QA项目UUID>/components` 读取配置及当前版本。员工响应采用公开字段白名单；GM 可读取经过脱敏的配置。不要把口令/token写入组件 config。
- GM 使用 `PUT /api/v1/projects/<QA项目UUID>/components/<componentKey>` 写入下列完整 body。新组件 `expectedVersion:0`；以后必须使用 GET 返回的当前 version，防止覆盖并发修改。
- `credentialRef:"sample-build-v1"` 对应 **且仅对应** `runtimeRoot/credentials/sample-build-v1.json`，引用不带扩展名，不允许斜杠、路径或跳出凭据目录的链接。内容限制 64 KiB，引用名限 1–80 个安全字母、数字、下划线、点、连字符。

## 打包 build

组件配置 body：

```json
{
  "enabled": false,
  "expectedVersion": 0,
  "config": {
    "baseUrl": "https://jenkins.preview.invalid",
    "job": "preview-folder/preview-client",
    "downloadOrigin": "https://artifacts.preview.invalid",
    "zipPath": "/project-a/increment.zip",
    "artifactUrlTemplate": "https://artifacts.preview.invalid/project-a/builds/{buildNumber}/increment.zip",
    "apkPath": "/project-a/apk/",
    "ipaPath": "/project-a/ipa/",
    "presets": {
      "preview": { "BuildMode": "Preview", "TargetPlatform": "Android" },
      "preview-ios": { "BuildMode": "Preview", "TargetPlatform": "iOS" }
    },
    "credentialRef": "sample-build-v1"
  }
}
```

凭据 `sample-build-v1.json`：

```json
{
  "username": "REPLACE_WITH_PREVIEW_JENKINS_USER",
  "apiToken": "REPLACE_WITH_PREVIEW_JENKINS_API_TOKEN"
}
```

`baseUrl` 与 `downloadOrigin` 必须是无子路径、查询、用户信息的 HTTP(S) 根来源。job 用 Jenkins folder/job 名称表示，不填 `/job/.../` API 路径。每个 preset 的参数名和值必须与目标 job 的真实参数定义匹配；模板没有预设真实构建能力。`artifactUrlTemplate` 必须包含 `{buildNumber}` 且与 downloadOrigin 同源，保证完成后的产物核对绑定本次构建。zipPath 为打包上传来源；apkPath/ipaPath 为可选包目录路径，省略时分别使用该 downloadOrigin 下的 `/apk/` 和 `/ipa/`，不会回退生产服务。

下载服务须支持已配置的目录 JSON、HEAD/GET、可信 Content-Length/Last-Modified。运行任务持续使用原 job 和凭据快照。Jenkins 提交结果不明确时为 `uncertain`，不得通过自动重提创建第二次构建。

## 增量上传 upload.incremental

组件配置 body：

```json
{
  "enabled": false,
  "expectedVersion": 0,
  "config": {
    "apiBase": "https://file-platform.preview.invalid",
    "loginBase": "https://login.preview.invalid",
    "sourceKind": "file",
    "sourceUrl": "https://artifacts.preview.invalid/project-a/increment.zip",
    "targetPrefix": "preview/project-a/test/pkg/",
    "testDirectoryPrefix": "preview/project-a/test/dir/",
    "releaseDirectoryPrefix": "preview/project-a/release/dir/",
    "credentialRef": "sample-upload-v1",
    "defaults": {
      "productId": "900001",
      "channelId": "900002",
      "belongName": "独立测试项目",
      "testerId": 900003,
      "mode": "prepare_publish"
    }
  }
}
```

凭据 `sample-upload-v1.json`：

```json
{
  "kind": "email",
  "account": "REPLACE_WITH_PREVIEW_UPLOAD_ACCOUNT",
  "password": "REPLACE_WITH_PREVIEW_UPLOAD_PASSWORD",
  "accessToken": "REPLACE_WITH_PREVIEW_ACCESS_TOKEN",
  "refreshToken": "REPLACE_WITH_PREVIEW_REFRESH_TOKEN"
}
```

这些 productId/channelId/testerId 全是占位 ID，必须替换为独立平台中确认的目标。两个服务来源要求与 build 根来源相同的 URL 结构。三种前缀都必须是相对目录并以 `/` 结尾，不允许 `..`、反斜杠、冒号或根路径。API 根据 config 给个人版本缓存绑定 apiBase/loginBase；不从日常桌面登录缓存或环境 token 回退。`kind` 可按目标账号合同取 `email` 或 `subaccount`；口令可用于过期后的有限续期，已有有效 token 的凭据也可不保存口令。账号或token不完整会拒绝运行，不能把示例字符串当已验证凭据。

`sourceKind:file` 固定一个明确 ZIP。iOS 目录上传改为：

```json
{
  "sourceKind": "ios_directory",
  "sourceUrl": "https://artifacts.preview.invalid/project-a/ios/"
}
```

这两项用于替换上述 config 的对应字段，其余字段仍完整保留。运行时保留目录末尾 `/`。目录 `?json=true` 需要返回 `{files:[{name,type:"file",size,mtime}]}`，按修改时间选择 ZIP，再以 HEAD 核对大小和 Last-Modified。新任务记录选中的具体 ZIP 与来源身份；恢复使用原文件，不重新选最新包。iOS 目录模式暂不支持 `build_upload.single`。

服务器生成的 C# job 配置另含 projectId/componentVersion/sourceRoot 和三前缀。sourceRoot 根据已配置来源计算，客户端不能用请求覆盖到其他项目目录。C# 0.5.0 必须使用独立 OZDQP_AUTH_FILE/OZDQP_LOCK_ROOT，且进程项目环境与任务字段一致。

## 单次打包上传 build_upload.single

先完整配置同项目 `build` 和 `upload.incremental`，再保存：

```json
{
  "enabled": false,
  "expectedVersion": 0,
  "config": {
    "buildPreset": "preview"
  }
}
```

buildPreset 必须存在于该项目 build.presets。该组件继承 upload.incremental 的服务、来源、目标、defaults 与 credentialRef，并在快照中绑定 buildVersion/uploadVersion。不要手写这些版本字段，不需要再复制密码。更改依赖配置会使后续任务获得新的版本绑定；关闭依赖组件会级联关闭单次打包上传。

提交 `POST /api/v1/projects/<id>/increment-upload/build-chains`，body 为 `{"upload":{"mode":"prepare_publish","version":"PREVIEW_VERSION"}}`，带独立 `Idempotency-Key` UUID。`publish_workflow` 包含最终发布核对；`prepare_publish` 在最终确认前停止。队列返回 chain 对象只证明已排队，最终状态应通过 build-chains 与 upload jobs 读回，不能将队列返回当实际发布完成。

## Relay 制作 relay.production

组件配置 body：

```json
{
  "enabled": false,
  "expectedVersion": 0,
  "config": {
    "baseUrl": "https://relay.preview.invalid",
    "externalProjectId": "PREVIEWA",
    "relayInstanceId": "relay-preview-a",
    "credentialRef": "sample-relay-v1"
  }
}
```

凭据 `sample-relay-v1.json`：

```json
{
  "bearerToken": "REPLACE_WITH_SCOPED_PREVIEW_RELAY_M2M_TOKEN"
}
```

这里 externalProjectId 的实际含义是 **Relay workbench / handoff 合同中的 projectKey**，不是 QA 项目 UUID，也不是 Relay 工作空间 UUID。当前 handoff 客户端接受形如 `PREVIEWA` 的大写项目 key（大写字母开头，随后大写字母或数字，总长 2–16）；必须与目标 Relay 配置完全匹配，不能借用 QA 的本地 projectKey。relayInstanceId 必须与真实目标回执匹配，格式为小写字母/数字开头，随后小写字母/数字/`_`/`-`，总长 3–64。

运行时使用 `/api/integrations/qa/v1/workbench/...` 和 `/api/integrations/qa/v1/handoffs`。目标实例必须实现真实工作台、交付回执与回调合同。M2M token 只能授予独立目标所需范围。实际 Relay 回调认证/地址也须由主部署配置与独立目标核对，不能因为队列已接受就宣称修复或 QA 验收完成。

outbox 固定保存 QA projectId、组件版本、snapshotDigest 和 externalProjectKey；精确范围 pump 才可认领。continue、人工验收接受通知和返工继承原 handoff 的绑定。修改 Relay 配置后，已知历史任务的操作查回原快照；混版本任务应分别提交批次。

## 轻语同步 qingyu.sync

组件配置 body：

```json
{
  "enabled": false,
  "expectedVersion": 0,
  "config": {
    "baseUrl": "https://qingyu.preview.invalid",
    "externalProjectId": "REPLACE_WITH_PREVIEW_QINGYU_PROJECT_ID",
    "credentialRef": "sample-qingyu-v1"
  }
}
```

采用员工扫码登录时，凭据 `sample-qingyu-v1.json`：

```json
{
  "stateSecret": "REPLACE_WITH_INDEPENDENT_RANDOM_SECRET_AT_LEAST_16_CHARACTERS"
}
```

stateSecret 用于本版本的加密会话文件，应由独立实例随机生成并妥善保留。每个员工在所选 QA 项目内扫码，外部项目始终限定为 externalProjectId。

仅在获准用固定独立测试账号时，凭据可增加以下字段作为服务端初始凭据：

```json
{
  "stateSecret": "REPLACE_WITH_INDEPENDENT_RANDOM_SECRET_AT_LEAST_16_CHARACTERS",
  "token": "REPLACE_WITH_PREVIEW_QINGYU_TOKEN",
  "user": {
    "id": "REPLACE_WITH_PREVIEW_QINGYU_USER_ID",
    "name": "独立轻语测试账号",
    "avatar": null
  }
}
```

初始服务端凭据不等于员工扫码登录历史；客户端 session 的 authenticated 字段目前表示员工扫码会话。同步只使用明确配置的轻语来源和项目，停用时禁止登录轮询、导入和新同步。外部同步失败保存原因和重试入口，不能阻断 QA 本地人工完成与关单。历史从本地读，不为显示历史发起远端读取。

## 版本、暂停和恢复

每次配置写入采用 expectedVersion。运行时首次使用该版本时持久保存配置和凭据文件 SHA-256；snapshotDigest 还绑定项目/组件/version/config/credentialDigest/创建时间。不要编辑版本目录中的 configuration.json 或覆盖已使用的凭据引用文件。轮换时新建例如 `sample-relay-v2.json`，再通过 GM 配置引用新名称；保留原版本资源，以便历史任务安全收尾。

| 动作             | HTTP 路径（均可加 projects/:projectId）                | 含义                                     |
| ---------------- | ------------------------------------------------------ | ---------------------------------------- |
| 构建历史         | GET /api/v1/packaging/tasks                            | 本地任务与结果                           |
| 恢复暂停构建     | POST /api/v1/packaging/tasks/:id/resume                | 显式重入队列                             |
| 上传历史         | GET /api/v1/increment-upload                           | 本地 jobs                                |
| 上传链历史       | GET /api/v1/increment-upload/build-chains              | 本地 chain                               |
| 恢复未启动上传   | POST /api/v1/increment-upload/jobs/:id/resume-queued   | 原人员恢复暂停命令                       |
| 恢复执行中断上传 | POST /api/v1/increment-upload/jobs/:id/resume          | 沿用原任务与幂等键，body 按原任务输入    |
| 最终发布确认     | POST /api/v1/increment-upload/jobs/:id/confirm-publish | 仅允许处于等待确认边界的原任务           |
| 恢复暂停上传链   | POST /api/v1/increment-upload/build-chains/:id/resume  | 显式恢复原链                             |
| 制作历史         | GET /api/v1/production/tasks/history                   | 本地批次列表                             |
| 制作批次详情     | GET /api/v1/production/batches/:id                     | id 是 64hex 批次 ID                      |
| 批次重试         | POST /api/v1/production/batches/:id/retry              | 原人员按已保存步骤核对后重试             |
| Relay outbox     | GET /api/v1/production/outbox                          | 本地认领/回执/暂停状态                   |
| 恢复暂停 outbox  | POST /api/v1/production/outbox/:id/resume              | 空 body，审计当前员工；id 是 outbox UUID |
| 轻语历史         | GET /api/v1/qingyu/history                             | 本地导入/同步结果                        |

关闭组件后未启动任务保留 paused；重新打开不会自动解除。外部已运行任务保留原配置，不因开关强行删除或重建。Relay 未发送队列使用 `COMPONENT_DISABLED_PAUSED`，须显式恢复；旧无版本 outbox 不会被新项目 pump 认领。组件开启也不能解除离线导入 hold。

导入 marker 的受控释放格式为：

```json
{
  "markerVersion": 1,
  "state": "released",
  "release": {
    "actorId": "REPLACE_WITH_REVIEWING_EMPLOYEE_UUID",
    "releasedAt": "2026-09-09T00:00:00.000Z",
    "reason": "REPLACE_WITH_ACTUAL_RESTORE_REVIEW_AND_RESOURCE_CHECK"
  }
}
```

这里只描述格式，不是本次放行授权。实际释放须先核对归档一致性、队列范围、未完成工作、外部目标和凭据，并记录真实人员/时间/理由。损坏或只有 state=released 而无完整释放证据仍暂停。API runtime 与 Storage worker 共享同一解析器；持有 hold 时新执行/恢复/轮询被拒绝，本地历史仍可读。

## HTTP 收据与已验证边界

最后修复明确使用 application/json：普通 upload jobs/resume 返回 JSON 字符串 ID；单次 build-chains 提交返回已持久化 queued chain 对象。不会出现 Fastify 把字符串当 text/plain 使客户端 JSON 解析失败的情况。新增测试验证真实排队/读回、无外部调用、JSON Content-Type、64hex batch 详情、UUID outbox 恢复、iOS 目录分隔符。最后 API build 与 runtime **7/7** 通过。Storage **109/109**、标准 API **144/144** 与 C# **40/40** 的分阶段证据见 [backend-components.md](backend-components.md)。

## 仍缺真实资源

仍需独立 Jenkins 实例/job/可用构建资源及每次构建对应产物地址；独立文件平台账号、产品/渠道/测试人及 COS 目标前缀；独立 Relay 实例/projectKey/M2M token/回调认证；独立轻语项目和扫码或测试账号。没有这些资源，本次只能证明本机 SQL、HTTP 合同、子进程与 SDK 回环行为，不能证明真实构建、上传/发布、Relay 修复/交付或轻语闭单。没有运行生产替代测试，也没有伪造成功结果。
