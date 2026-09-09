# 仅 API 更新的保全 runner：准备与审阅

状态：`prepared_not_run`。本目录只记录脚本准备、临时本地 fixture 和静态门禁。没有运行真实 `before`/`after`，没有读取运行 instance、数据库、设备、服务或 production 文件，没有部署或发布 Android feed。Android 更新鉴权修正的证据在另一个 `android-preview-update-routing/auth-hook-correction/` 目录，原244与246历史不在此改写。

候选冻结 runner：`scripts/project-components/retain-preview-android-update-state.mjs`，SHA256 `669042c8c82307d02bd291e9de99b1ddc5af86694a83425158bd55ee35c000f3`。对应 `.test.mjs` SHA256 `c85bd6ebeadd9e12c4797132124b8039ea531655fa631221a8488e945422d543`。

## 供 root 审阅的命令，尚未执行

须由 root 先建立无业务写入、无客户端升级/配置变更的明确窗口。安装中的预览 EXE 应仍为0.2.0-preview.8，Android preview23/daily14均须已运行，现有ADB server/对应emulator须可用。`.9`暂存打包不能发布或安装。脚本严格发现条件失败后退出，不启动设备、不创建测试员工、不修正现场。

```powershell
$taskInstance = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\instance.json'
$taskRetentionId = [Guid]::NewGuid().ToString()
node scripts/project-components/retain-preview-android-update-state.mjs --run before $taskInstance $taskRetentionId
if ($LASTEXITCODE -ne 0) { throw 'Retention failed; keep services and feed unchanged' }
```

只有 `before.json` 为 passed、归档已校验且 root 完成审阅后，root才可在脚本外按原部署计划用 manager **显式 `-Services api`** 更新API。该 runner 没有调用 manager、重启/停止进程、设置环境给API或修改feed的能力。

API恢复ready后，仍在同一静止窗口，由root使用同一UUID：

```powershell
node scripts/project-components/retain-preview-android-update-state.mjs --run after $taskInstance $taskRetentionId
if ($LASTEXITCODE -ne 0) { throw 'Comparison failed; retain all proofs and do not publish feed' }
```

不传 `--run` 时，仅打印 `not_run` 与用法；不读取instance或创建输出。错误mode/UUID/非精确instance路径会在运行数据读取之前拒绝。无需权限确认/服务操作的准备检查：

```powershell
node --check scripts/project-components/retain-preview-android-update-state.mjs
node --test scripts/project-components/retain-preview-android-update-state.test.mjs
```

## 保全内容与失败边界

真正执行时，source/runtime路径只接受当前worktree与 `qa-hub-preview-7c86`，端口固定4419/4274/4421/4420。沿用实例validator拒绝生产根、资源目录重叠和runtime内junction。所有实际输出为全新目录：

- 私有恢复点：`<backupRoot>/android-update-<UUID>/`，内含runner副本、online一致SQLite副本与manifest、带引用附件的归档及markers、quarantine完整副本、旧Android feed副本、Windows latest原文、code22直接下载/receipt和原code23APK。
- 公共证据：`docs/evidence/project-components/android-update-deployment-retention/<UUID>/before.json`、`after.json`。只追加，不能覆盖失败或通过的旧结果。公开数据库记录仅table/count/hash/schema定义hash，附件仅路径/count/bytes/SHA；配置只hash，不输出token、cookie、密码或进程命令行。

数据库由维护进程**只读打开API拥有的数据库**，使用SQLite online backup API生成一致副本；不声称调用了当前API worker/HTTP备份接口。运行库始终普通只读事务，读取归档副本才使用immutable选项。未复制运行DB主文件或live WAL/SHM。所有实际schema表均发现并fingerprint，包括17张原领域表、upload/capture/attachment_bindings及其余表，不忽略会话或未知表变化。缺必需表、schema不是14或任一project_components启用行都会拒绝；缺组件配置行按既有默认off语义记录。

引用附件归档调用现有 `archiveSqliteRecoveryPointWithAttachments`，之后独立校验一致副本、引用文件、manifest和complete/binding markers。所有evidence文件有独立清单/hash，真正复制的是副本引用的ready附件；未引用的孤立evidence文件没有被默认为归档内容。quarantine另行递归普通文件复制并对照源前/后及副本hash，保留未完成上传chunk；含junction或SQLite sidecar名称会拒绝。它不覆盖runtime外的旧上传/Relay/轻语任务目录或外部远端状态。

整个before结束再复核六入口/文件/配置；after首先校验私有全部恢复点文件hash仍与before一致，再重验附件归档，比较全部表/evidence/quarantine。唯一允许变化的是API进程启动身份，要求新启动时间、相同可执行路径及managerreceipt确切归属；Web、两个MCP、EXE、Android和production身份/config/feed仍须相同。API重启后的操作性表变化也会作为失败保留，不能事后静默忽略。

runner不会回滚/清理真实副本。数据/归档/身份/文件比较失败会留下create-only失败proof和已产生的私有文件。底层online-backup库有自己既有的原子失败目标清理规则，本脚本没有修改该库，也不声称它的未完成内部临时目标全部保留。正常本地unit fixture由测试在结束时清理，原始测试输出保留在本目录。

## 六入口与production的实际读取范围

| 入口 | 真正执行时读取 | 精确门禁 |
| --- | --- | --- |
| HTTP API | 4419 listener、managerreceipt与CIM；GET `/api/v1/health/ready` | ready/schema14；receipt的PID/start/path/commandLine须与进程匹配，公开只记录命令行匹配布尔 |
| Web | 4274 listener、receipt/CIM；GET `/`的真实字节hash | 同PID/start/path与相同index bytes |
| 服务端MCP | 4421 listener、receipt/CIM；GET `/health` | `preview-mcp.mjs`将其代理至4419 ready；真实status为ready，不能虚构独立业务调用 |
| 本地MCP | 4420 listener；GET `/health` | `mcp-server.ts`明确返回ready、relay-qa-hub-desktop-mcp、/mcp、streamable-http；没有要求不存在的schema字段 |
| Windows EXE | 4420 owner、同安装路径的全部CIM进程、文件版本、预览配置与marker | owner必须是预览EXE；version .8；固定instance/profile/API/Web/cookieName/MCP/feed配置 |
| Android | 仅连接已有127.0.0.1:5037的ADB协议，指定127.0.0.1:16384 transport | preview23/daily14 PID/version；preview runtimeConfig与prefs/capture-drafts SHA、daily prefs SHA均前后相同 |

Android没有调用adb.exe，因此server不在时连接失败，不会触发adb自动start-server；不启动/停止任何APP、模拟器，不登录、不切项目、不clear。协议只发送固定 `pidof`、`dumpsys package`、`sha256sum`及 `run-as ... find ... -exec sha256sum`。dumpsys仅提取版本，偏好文件不取正文；这些读取不能证明物理Android或原生安装更新。

production只按已审查的六个确切文件读取hash：RuntimeState、people配置、Windows latest/installer及两处daily desktop-runtime配置；CIM记录4319/4174监听者和daily EXE实际PID/start/path，GET4319 ready要求schema12。某些生产Node路径可能因Windows权限为null，脚本保留null，不能把null相等叫作已验证可执行路径。daily EXE实际路径必须可见。没有production数据库、队列、配置正文或业务API读取/写入。

## 已执行的准备门禁

首轮7项中5通过2失败，原 `runs/local-fixture-first.log` 保留：备份读回使用普通readonly会产生私有副本的空sidecar，已对副本改用immutable；hash解析器未接受末尾换行，已修正。它们是本地runner问题，没有真实数据影响。中间7/7在 `local-fixture-final.log` 保留。

最终8/8在 `local-fixture-freeze.log`：默认/非法参数inert；真实临时WAL数据库一致备份、引用附件和quarantine字节；损坏附件拒绝且备份/source保留；组件启用拒绝；重复/变化/junction/WAL复制拒绝；Android字符串/哈希解析；纯内存分片ADB协议；after仅排除API身份。ADB测试使用内存socket，没有连接真实5037。scoped lint、nodecheck、Prettier均通过。以上不替代未来真实before/after，不表示已经部署或发布code23。
