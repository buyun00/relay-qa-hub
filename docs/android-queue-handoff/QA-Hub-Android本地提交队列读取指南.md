# QA Hub Android 本地提交队列读取指南（交给另一台电脑上的 AI）

适用场景：实际提交用的手机连接在用户自己的电脑上，需要查明 Bug 是否仍保存在本地、还有多少条没有上传。电脑不需要安装 QA Hub 服务端，也不需要有本项目仓库。

本文及配套 `read-android-queue.mjs` 根据 2026-09-09 的 QA Hub Android 源码核对。已知线上 APK 为 `0.1.13-debug`、versionCode `14`；执行时必须再次检查手机实际包名和版本。本文只授权读取与在电脑上保存诊断文件，不包含补交、修改队列或应用升级。

## 直接交给 AI 的任务说明

> 请检查连接到本机的 QA Hub Android 手机本地提交队列。先确认目标设备、包名和账号，再按本文执行配套只读脚本。保留数据库、WAL、原始证据及需要保护的附件；不要清数据、卸载、切换账号、强行停止应用、修改数据库、安装替代 APK 或重复创建 Bug。按全部历史会话检查相关账号，不要只查今天或当前 session。输出未成功的数量、每条内容、错误码、已成功的 Bug 编号以及回执异常。执行失败、没有权限或查到零条都不能直接解释为“已经全部上传”。先完成诊断；任何补交或恢复操作另行提出具体方案。

## 1. 准备与识别手机

用户把**发生问题的手机**用 USB 数据线连接自己的电脑，打开“开发者选项 → USB 调试”，在手机上允许当前电脑调试。AI 不能代替用户绕过手机确认。

电脑需要 Android SDK Platform-Tools 中的 ADB，以及 Node.js **24 或更高版本**。配套脚本只使用 Node 内置模块，不需要 `npm install`。已有 Android Studio 时，ADB 常见路径为 `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`，但必须检查实际存在。

官方说明和下载入口：[Android ADB 文档](https://developer.android.com/tools/adb)、[SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools)、[Node.js 下载](https://nodejs.org/en/download)。

PowerShell 示例，所有占位值都由执行 AI 根据实际情况填写：

```powershell
$adbPath = 'C:\实际位置\platform-tools\adb.exe'
& $adbPath devices -l
node --version
```

- 选择用户确认的实体手机序列号。多设备时，后续每条 ADB 命令必须携带 `-s`，不能默认选第一个设备或模拟器。
- `unauthorized`：请用户解锁手机并允许 USB 调试。`offline`：检查连接。空列表：检查数据线、USB 模式和驱动。
- 有应用分身、工作资料或多个 Android 用户时，确认问题发生在哪一个实例；读到另一实例的空数据库不算检查完成。

```powershell
$deviceSerial = '实际手机序列号'
& $adbPath -s $deviceSerial shell pm list packages com.relayqahub
$packageName = 'com.relayqahub.android.debug'
& $adbPath -s $deviceSerial shell dumpsys package $packageName |
    Select-String 'versionCode=|versionName='
& $adbPath -s $deviceSerial exec-out run-as $packageName id
& $adbPath -s $deviceSerial exec-out run-as $packageName ls databases
```

已知 debug 包名是 `com.relayqahub.android.debug`，基础 applicationId 是 `com.relayqahub.android`。不要漏掉 `.debug`；也不要在没找到时随意读取其他应用。

若 `run-as` 返回 `package not debuggable`、`unknown package` 或权限错误，停止导出并记录原因。不要用卸载重装、root、解锁 bootloader、关闭安全机制或清数据来绕过。此时需要核对包名/用户资料，或由维护方提供保留数据的官方导出功能；不能保证普通 `adb pull /data/data/...` 能读到私有目录。

## 2. 运行配套只读脚本

把本文和 `read-android-queue.mjs` 放在同一个电脑目录，在该目录打开 PowerShell。手机尽量暂停编辑和连续点击，但保持原账号，不必关闭进程。USB 充电本身可能让后台恢复，因此记录导出时间，只能把结果解释为该时刻的快照。

先查看全部账号范围，避免因为账号 ID 不正确而误报零条：

```powershell
node .\read-android-queue.mjs --adb $adbPath --serial $deviceSerial --package $packageName --out .\queue-audit-first --include-media
```

每次使用**新的输出目录名**。如果目录已经存在，脚本拒绝覆盖。`--include-media` 同时备份该应用的离线提交图片和截图草稿目录；需要保护缺失提交时应带上。原始文件可能包含多个登录过的账号内容，只保存在用户控制的电脑上，不上传公共网盘或代码仓库。

需要单独查看王蕊时，本次已核实的账号 ID 是：

```text
3807ffeb-910b-428a-8890-810be9102b7c
```

该 ID 只针对本次生产环境。先核对全量报告中的 `actorId`，不要根据相近姓名猜测账号，也不要把历史 ID 当成其他部署的通用 ID。

```powershell
node .\read-android-queue.mjs --adb $adbPath --serial $deviceSerial --package $packageName --actor 3807ffeb-910b-428a-8890-810be9102b7c --out .\queue-audit-wangrui
```

脚本不会联系服务端、发送 Bug、修改手机文件或导出登录凭据。它会在电脑的新目录中保存：

| 文件 | 用途 |
| --- | --- |
| `device.txt` | 设备序列号、包名、版本和读取时电池状态 |
| `raw/qa-hub-cache-v1.db` 及存在的 `-wal`、`-shm` | 原始数据库证据，保留不动 |
| `analysis/` | 仅供电脑 SQLite 读取的副本，避免分析过程影响原始证据 |
| `snapshot.json` | 读取时间窗、方式、每个数据库文件的大小和 SHA-256 |
| `integrity.json` | SQLite 完整性和外键检查 |
| `queue-report.json` | 状态统计、各账号/项目/安装/会话统计、内容与匹配回执 |
| `queue-attention.json` | 所有未成功记录，以及成功状态缺回执等异常记录 |
| 两个 `.tar` 和 `media-export.json` | 使用 `--include-media` 时生成的媒体备份及结果 |
| `FAILED.json` | 导出或分析失败原因；出现此文件代表结论未确定 |

AI 阅读 `queue-report.json`、`queue-attention.json` 即可分析。不要把含二进制数据的 ADB 输出通过旧版 PowerShell 的 `>`、`Out-File` 或文本管道保存成数据库；脚本使用二进制输出直接写文件。

## 3. 为什么必须保留 WAL

数据库路径相对于 `run-as` 的应用私有工作目录：

```text
databases/qa-hub-cache-v1.db
databases/qa-hub-cache-v1.db-wal
databases/qa-hub-cache-v1.db-shm
```

最新已提交的数据库事务可能仍在 WAL 文件中。只导出主 `.db` 可能读到旧状态，不能删除 WAL 后分析，也不要使用可能忽略实时 WAL 的 `immutable=1` 打开方式。参见 [SQLite WAL 官方说明](https://www.sqlite.org/wal.html)。

脚本连续读取两遍主数据库与 WAL，比较字节哈希，发生变化最多重试 5 次；之后在电脑副本上以只读模式打开并运行完整性检查。`-shm` 原样留证，分析副本让 SQLite 在电脑上重建它。

**这是尽力取得稳定的在线文件快照，不是手机端原子 SQLite 备份。** 数据库与媒体也是分开读取。持续写入、文件轮换或检查失败时，结果应标记“需要重新采样”，不能据此认定数据丢失或队列为空。不要擅自强制停止应用来取得快照；本地未落盘的表单可能仍在进程中。

## 4. 如何解释队列状态

队列表：`offline_operations`。成功回执表：`offline_operation_receipts`。两者必须按 `operationId` **逐条匹配**，同时核对账号、项目、actor、installation、session 和 `clientSubmissionId`；不能把“最近一条回执”当作所有提交都成功的证明。

| `state` | 含义 | 算已上传成功吗 |
| --- | --- | --- |
| `PENDING` | 已持久保存，等待执行 | 否 |
| `RUNNING` | 执行中，也可能是中断后尚未恢复的状态 | 否，需查回执和后续变化 |
| `RETRY` | 失败后等待重试 | 否 |
| `BLOCKED_AUTH` | 登录凭据相关阻塞 | 否 |
| `BLOCKED_DEVICE` | 设备安全/凭据读取等条件阻塞 | 否 |
| `FAILED_PERMANENT` | 自动重试已停止或遇到不可自动恢复的错误 | 否，仍需保留并处理 |
| `SUCCEEDED` | 本地同步流程已确认成功 | 还需对应回执匹配 |

特别注意：现有 APK 的 `queuedOperationCount` **不包含 `FAILED_PERMANENT`**。不能因为“等待数量为 0”就说所有记录都提交了。脚本按所有非 `SUCCEEDED` 状态统计，且不限制日期或当前会话。

重点查看：`title`、`description`、`state`、`lastErrorCode`、`attemptCount`、`createdAt`、`updatedAt`、`nextAttemptAt`、`clientSubmissionId`、`receiptMatches`、`bugId`、`bugKey`。脚本时间均为 UTC ISO 格式，向用户报告时转换成北京时间 UTC+8。

`operationKind=STAGE_CREATE_BUG_ATTACHMENT` 表示仍处于持久草稿/上传准备阶段；文字 Bug 也可能经过这个阶段，不代表一定有图片。`CREATE_BUG` 表示已进入正式创建请求阶段，不能单凭这个字段说服务端已经收到。

## 5. 确认是否全部提交

只有同时满足下面条件，才可写“该手机、该应用实例、相关账号在本次快照中的所有队列记录均已确认成功”：

1. 设备、包名和账号无误，数据库导出及完整性检查通过。
2. 检查覆盖该账号全部历史 installation/session；未成功状态数量为 0，未知状态数量为 0。
3. 每条 `SUCCEEDED` 都有属于同一操作和完整范围的成功回执，包含匹配的提交 ID、Bug ID 和编号。
4. 对用户明确缺失的内容逐条找到记录，不以总数猜测。标题相同也可能是两次不同提交。

脚本中的 `allRecordedOperationsConfirmedInLocalSnapshot=true` 只证明**已记录操作在本地快照中的状态**。零条记录时该字段为 false，因为可能读错实例、账号或设备；需要进一步解释。

如要确认当前服务端实际可见，还需通过已有授权的 QA Hub API/MCP，按回执 Bug ID 逐条读取，检查项目、提报人、内容和删除状态。不能只查列表前 100 条；没有服务端访问条件时，明确标注“已核对本地成功回执，尚未实时核对服务端”。不要为了核对而要求用户公开 access token。

手机上的后台可能继续运行。需要确认稳定收尾时，间隔片刻导出到另一个新目录，对比 `operationId` 集合与状态；仍以各自读取时间为界，不承诺将来不会新增记录。

“队列全部成功”不等于“从未点击提交的表单和截图也都上传了”。内存中尚未提交的文字表单不在该队列表内；截图草稿也要单独检查。

## 6. 图片和截图草稿的保存位置

```text
files/offline-submission-drafts/<clientSubmissionId>/<clientAttachmentId>.png
files/capture-drafts/
```

`--include-media` 会只读打包这两个目录，不读取 `shared_prefs`、凭据保险库或其他应用数据。如果目录不存在或打包中途发生变化，会记录结果。成功同步可能正常清理离线提交图片，因此成功记录没有本地 PNG 不能直接解释为图片丢失。

对尚未成功且仍处于 `STAGE_CREATE_BUG_ATTACHMENT` 的记录，AI 可以在电脑上检查备份内对应文件的大小和 SHA-256，匹配 `payloadJson.attachments[].expectedSize/sha256`。原始 payload 留在数据库副本中；报告列出 `attachments` 元数据。已转换成 `CREATE_BUG` 的记录还需要结合 `attachment_pipeline_receipts` 查看上传/绑定回执，不要把已上传的附件再次创建一份。

需要解包时，只解到电脑上的新目录；先检查 tar 条目，拒绝绝对路径、`..` 路径和符号链接/硬链接，不能让归档条目写出指定目录。不要把恢复出的文件推回手机。数据库和媒体不是同一个原子快照，缺失时应复查时间差。

## 7. 遇到未成功记录后怎么做

先保存报告和原始文件，再提出处理方案。本次读取不要自动执行：

- `pm clear`、卸载、换包覆盖、账号切换、数据库 `DELETE/UPDATE`、删除图片或 WAL。
- 强行把状态改成 `SUCCEEDED` 或重置重试计数。
- 直接用新 UUID 重建所有 Bug。原请求可能已被服务端接收但回执未回到手机，会产生重复单。
- 为查错误而导出全部登录信息，或向无关人员发送原始数据库。

用户另行要求恢复时，应保留原 `clientSubmissionId`、幂等键和附件关联，优先走应用支持的恢复流程；先核对服务端是否已有对应记录，再决定是否重试。不要未经分析就建议退出再登录：旧会话范围中的记录可能需要专门处理。

已知当前源码设置了后台 `batteryNotLow` 约束，但不能仅凭这一点认定所有阻塞都是低电量。结合快照中的错误码、重试时间、当前电池状态和后续变化判断；USB 插入后的电量状态也不能证明提交当时的电量。

## 8. 本次事件对账基线（历史快照）

截至北京时间 **2026-09-09 15:40:10**，生产服务端核实王蕊当天已有 6 条新建：

| Bug 编号 | 内容 | 服务端入库时间（北京时间） |
| --- | --- | --- |
| LOCAL-396 | 锦标赛玩家信息加载不出来 | 14:19:56 |
| LOCAL-415 | 收到好友卡包直接在对局弹出了 应该是返回大厅弹 | 14:52:51 |
| LOCAL-418 | 好友索要卡片消息 页签和大厅 没显示红点 | 14:54:54 |
| LOCAL-426 | hand最后一张牌bug | 15:39:29 |
| LOCAL-427 | 111 | 15:39:29 |
| LOCAL-428 | 111 | 15:39:29 |

这只能作为本次排查的已有证据，执行时应重新核对。两条 `111` 对应不同提交，不要自动删除或合并。

## 9. AI 最终应交付的报告

```text
检查时间：北京时间……；快照读取时间窗……
目标：实体手机……，包名……，版本……，actorId……
数据库：稳定读取/完整性检查是否通过；是否存在采样限制
范围：全部历史会话；检查记录共……条
状态：PENDING … / RUNNING … / RETRY … / BLOCKED_AUTH … /
      BLOCKED_DEVICE … / FAILED_PERMANENT … / SUCCEEDED …
回执异常：……条
未成功清单：内容、创建时间、状态、错误码、操作 ID、提交 ID
成功对账：内容 → Bug 编号；111 是否对应 LOCAL-427、LOCAL-428
媒体备份：成功/不存在/读取中发生变化；是否已验证未成功记录的图片
服务端核对：已实时核对 / 只有本地回执 / 无访问权限
结论：当前快照无积压 / 仍有……条 / 证据不足不能判断
文件位置：……
```

优先把上述摘要和相关条目发给用户。原始数据库/图片只在确有需要时经用户授权传递。

## 10. 维护方验证记录

配套脚本会在交付前用已连接的 MuMu 执行只读导出，验证 DB/WAL、回执分析和媒体备份路径。该验证只检查工具可执行性，不能代替读取用户实际手机，也不证明王蕊手机队列已经清空。实际验证结果见同目录 `VALIDATION.md`。

源码核对位置（供有仓库的 AI 使用；没有仓库也可直接运行脚本）：`apps/android/app/src/main/kotlin/com/relayqahub/android/data/Entities.kt`、`data/Daos.kt`、`AppContainer.kt`、`work/OfflineAttachmentDraft.kt`、`work/SyncScheduler.kt`、`capture/PendingCaptureDraftStore.kt`。
