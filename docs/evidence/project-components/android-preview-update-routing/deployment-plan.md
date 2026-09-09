# Code23 feed 与仅 API 部署：待 root 执行的顺序

状态：`not_run`。本文件不执行保全、服务操作或发布。当前工作树 API 源已经修复并完成编译/测试，运行中的4419仍加载旧进程代码；EXE升级与 Web 真 UI 验收尚有独立活动，必须等 root 明确给出静止窗口。本轮没有调用 manager、运行 main、创建运行数据库备份或写入 Android feed。

## 已完成的源门禁

- `npm run build --workspace @relay-qa-hub/api` 通过。
- 定向31/31，包括5个新增固定 channel/随机loopback真实HTTP测试、旧 API 合同测试、parallel environment隔离测试。
- 完整现有 `npm run test --workspace @relay-qa-hub/api` 通过：211个 `.mjs` 测试 + 33个 `.ts` 测试，合计244；无失败、无跳过。该脚本包含编译，未运行主服务入口。
- 4个TS源及2个测试通过 scoped eslint/Prettier。原始日志在本目录 `runs/`，保留 first 文件名，未覆盖失败结果。

## 1. 静止窗口、旧身份与可恢复数据

在任何 Stop/Start 之前，root 先结束或暂停其他代理的真实 Web/Android/EXE业务写入，保留它们未提交草稿，不以停止客户端来代替沟通边界。不能在并发写入中强行要求前后业务 hash 相同，或事后把差异改成预期。

重新读取实际 instance JSON并通过 `inspect-preview.mjs` 校验；只接受 `qa-hub-preview-7c86`、4419以及现有独立 data/backup/downloads路径。API 的旧 PID/start/path 应从 `logs/api-process.json` 与 CIM 实际一致性读回，而不是仅沿用历史10036。同期保存 Web4274、serverMCP4421、localMCP4420、preview EXE和日常 EXE的实际PID/start/path；EXE刚升级可能换PID，基线应采集当时真实值。公开proof不包含进程命令行、token或配置 secret 正文。

旧运行数据保全可沿用已审核 helper，但必须明确其语义：`retain-preview-api-state.mjs` 是维护进程只读打开 **API拥有的数据库**，通过 SQLite online backup API生成一致备份；它不是调用当前HTTP服务的远程备份接口。当前没有已注册的HTTP手工备份端点，不能编造一个。

下列是后续明确窗口中的命令，尚未执行：

```powershell
$taskInstance = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\instance.json'
$taskDeployId = [Guid]::NewGuid().ToString()
node scripts/project-components/retain-preview-api-state.mjs --before $taskInstance $taskDeployId
if ($LASTEXITCODE -ne 0) { throw 'API state retention failed; do not stop service' }
```

该 helper 只会在 `backupRoot/api-workflow-<UUID>/qa-hub.sqlite` 新建备份；before/after JSON固定落在 `workflow-concurrency-live/`，root可以引用其新UUID原件，不改旧proof。它已经记录17张领域表 fingerprints、全 evidence 文件清单汇总及instance/people/secrets的hash。SQLite备份成功并不自动等于附件归档成功。

为满足本次“引用附件可恢复”的要求，在新的独立 archive 目录调用现有 `archiveSqliteRecoveryPointWithAttachments({backupPath, manifestPath, evidenceRoot, archiveRoot})`，其中 backupPath 是刚产生的一致副本，evidenceRoot只取同instance `dataRoot/evidence`。然后用 `validateArchivedSqliteRecoveryPointWithAttachments({backupPath: archived.backupPath})` 校验恢复点、附件 manifest、complete/binding markers、数量/字节/SHA；所有目标必须为独立目录，不能与数据库/现有evidence重叠。不调用带retention删除策略的runner，不修改原引用附件。

这一 archive API依据一致副本里的引用收集附件，不保证归档未绑定的quarantine上传或runtime外的组件任务。另行保留当前API dataRoot下 upload quarantine 的文件清单/hash及仍引用的原文件；有需要恢复未完成上传时，在同一静止窗口把这些文件复制到独立私有子目录并做前后hash比对，不能把引用附件archive称为所有任务/草稿的全量备份。未知组件/外部资源不从生产补读。所有副本/原文件不清理。

在17表之外增加本轮直接相关的只读表 fingerprints：`upload_sessions`、`upload_chunks`、`attachment_bindings`、`capture_bundles`、`capture_artifacts`；由实际schema列出存在的表再确定清单，遇到名称不符应记录真实schema而不是SQL造表。始终在一个只读事务快照内收集，公开只给table/count/hash。保全源和最终数据的所有相关业务差异必须解释，不能默默排除变更表。

同时保留正式 Android feed目录中所有已存在文件的 bytes/hash和完整旧latest；不存在latest就记录首次发布。保留旧code22直接下载与receipt、此次原code23，以及正式Windows latest的hash。新 Web/EXE产物属于其他验收，不能被API操作覆盖。保存当前API源码commit与已保留的旧可运行artifact来源；工作树dist此时已经是新编译结果，不要把它标成旧运行二进制。若没有旧dist副本，可保留变更前Git源快照作为重建输入，但不能声称已运行过回退包。

## 2. 只用 manager 操作 API

数据与附件归档通过后，由root执行精确实例、精确 `-Services api`：

```powershell
& .\scripts\project-components\Manage-QAHubPreview.ps1 -Action Status -ConfigFile $taskInstance -Services api
& .\scripts\project-components\Manage-QAHubPreview.ps1 -Action Stop -ConfigFile $taskInstance -Services api
& .\scripts\project-components\Manage-QAHubPreview.ps1 -Action Start -ConfigFile $taskInstance -Services api
```

manager默认 Services是api/web/mcp，所以每次都必须显式传api。其 `Read-OwnedProcess` 同时验证PID、路径、启动时间、命令行，Stop前再次验证；不能用名称批量停止。manager的Stop实现是对归属PID的 `Stop-Process`，不应记为HTTP优雅关闭证明。Start会独立记录launch日志并检查ready；启动失败保留该进程/日志诊断，不自动杀其他监听者或回收目录。

新ready必须来自4419、schema14，记录新API PID/start。Web、serverMCP、localMCP、两个EXE及所有非API服务相对于**本次部署前**记录保持相同。然后运行：

```powershell
node scripts/project-components/retain-preview-api-state.mjs --after $taskInstance $taskDeployId
if ($LASTEXITCODE -ne 0) { throw 'Post-deployment state mismatch; preserve records and investigate' }
```

用同样只读流程复核额外上传/捕获表、引用附件archive、原始evidence/quarantine文件和配置hash。不要在完成这些比对之前让新业务写入污染前后基线。preview feed未发布时，`GET /api/v1/android-updates/preview/latest.json` 应为明确未找到；`stable` 在这台明确preview配置的实例中不注册。该现象只证明新路径选择，不是code23下载验收。

## 3. 原code23发布与真实下载读回

仅在root随后明确允许发布时，按 [publication-plan.md](publication-plan.md) 的原artifact/template/create-only复制和原子latest步骤操作。目标只取 `downloads/android/qa-hub-preview-7c86`；不使用默认production publisher，不改instance.json，不碰daily stable路径。其余字段/文件名/package/channel与已经通过测试的preview合同一致。

发布后真实读取4419 `preview/latest.json`、APK完整body与SHA、HEAD和Range，并读回4274同一文件。旧code22直接下载SHA保持原值；Windows最新清单不变。在线旧preview客户端可能检查并下载新版，所以发布时间仍由root协调；实际安装需要独立原生验收，不能把manifest可读或下载完成算作install-r/同签名升级通过。

若metadata错误，preview API返回503 `ANDROID_UPDATE_METADATA_INVALID`，应保留错误文件并明确修正新的发布记录，不借stable URL或日常package绕过。不得为了回退让已装23的设备降级/卸载/清数据。发生数据、签名、安装身份、原artifact hash或未预期业务差异时，保持原副本及失败证据，由root决定下一步；本轮不自动执行任何部署或发布。
