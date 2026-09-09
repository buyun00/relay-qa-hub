# QA Hub 项目制与组件化真实验收矩阵

生成时点：2026-09-09T00:01:15.729Z；设计 v2.1；源码 HEAD：`33514cde1862e448cb56d7082177f34a88e42363`。

本文件是代码和需求的验收清单，初始全部为 `not_run`。代码存在、静态推导、mock、编译成功、端口监听或排队成功均不算通过。逐入口真实操作并读回项目、操作人、状态、版本、事件、附件及最终产物后，才登记结果。

机器记录保存在 `coverage-matrix.json`。每条包含前提、步骤、预期、适用入口、各入口状态/实际结果/证据和人工备注。直接编辑 JSON 中 `results` 与 `manual`；重新运行 `node scripts/project-components/generate-coverage-matrix.mjs` 会保留结果，源码变化会标记复验，消失条目转入 `retiredItems` 保留证据。

## 24 项最低基线

A = 此基线须通过该入口真实验收；— = 该条描述其他入口，不能据此排除本版本要求。所有状态均独立记录。

| 编号及场景 | APK | EXE | Web | HTTP API | server MCP | local MCP | 预期 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 项目入口姓名登录 | A · not_run | A · not_run | A · passed | A · passed | A · not_run | A · not_run | 首次登录只登记入口项目；原姓名仍解析为稳定原人员。 |
| 02 单项目和多项目人员 | A · not_run | A · not_run | A · passed | A · passed | A · not_run | A · not_run | 单项目直接进入；多项目只列出有效所属项目。 |
| 03 唯一 GM | A · not_run | A · not_run | A · not_run | A · passed | A · not_run | A · not_run | GM 管理全部项目；普通姓名 gm 不获得 GM 身份。 |
| 04 项目人员停用 | A · not_run | A · passed | A · not_run | A · passed | A · not_run | A · not_run | A 停用不影响 B；再次姓名登录不恢复显式停用关系。 |
| 05 非所属项目读取 | A · not_run | A · not_run | A · not_run | A · not_run | A · not_run | A · not_run | 列表、详情、附件、日志和统计均不泄露其他项目。 |
| 06 写入归属 | A · not_run | A · not_run | A · not_run | A · passed | A · passed | A · not_run | 编辑、评论、附件绑定和状态动作不能写到错误项目。 |
| 07 项目快速切换 | A · not_run | A · not_run | A · not_run | — | — | — | A 迟到请求、草稿及人员选择不能覆盖 B。 |
| 08 多窗口和多客户端 | A · not_run | A · not_run | A · passed | A · not_run | A · not_run | A · not_run | 同一人员并行打开不同项目；每个请求保持明确归属。 |
| 09 关闭所有组件的基础全流程 | A · passed | A · passed | A · passed | A · passed | A · passed | A · passed | APK/EXE/Web 均可创建、处理、人工完成、验收并关闭 Bug。 |
| 10 项目人员管理一致 | A · passed | A · passed | — | — | — | — | 两端均按现有方式完成项目人员查看、关联与停用。 |
| 11 HTTP API 独立使用 | — | — | — | A · passed | — | — | 关闭 EXE 后，外部程序仍可登录、查询、评论和改状态。 |
| 12 服务端 MCP 独立使用 | — | — | — | — | A · passed | — | 服务端 MCP 不依赖 EXE，并覆盖同样主要 Bug 动作。 |
| 13 HTTP/MCP 对等 | — | — | — | A · not_run | A · not_run | A · not_run | 等价输入得到一致状态、版本、操作人、幂等结果和错误。 |
| 14 并发和重复提交 | A · not_run | A · not_run | A · not_run | A · not_run | A · not_run | A · not_run | 旧 expectedVersion 被拒；同幂等键不重复创建轮次或外部任务。 |
| 15 附件三种读取 | — | — | — | A · passed | A · passed | A · passed | HTTP 字节下载、服务 MCP 资源、EXE 本地落盘均正确归属且哈希一致。 |
| 16 项目组件开关 | A · not_run | A · not_run | A · not_run | A · not_run | A · not_run | A · not_run | A 开启不影响 B；关闭后旧 HTTP/MCP/后台请求不能创建新任务。 |
| 17 组件依赖和缺配置 | A · not_run | A · not_run | A · not_run | A · not_run | A · not_run | A · not_run | 单次打包上传依赖清楚；缺连接显示待配置，不拖累 Bug 页面。 |
| 18 运行中停用组件 | A · not_run | A · not_run | A · not_run | A · not_run | A · not_run | A · not_run | 排队任务暂停、运行任务按规则收尾；历史产物保留；重启用不自动重放。 |
| 19 上传和 Relay 项目归属 | A · not_run | A · not_run | A · not_run | A · not_run | A · not_run | A · not_run | 列表、日志、取消、重试和回调只操作原项目任务。 |
| 20 外部失败与人工处理 | A · not_run | A · not_run | A · not_run | A · not_run | A · not_run | A · not_run | 打包、上传、Relay、同步失败不阻止本地人工完成与关闭。 |
| 21 旧数据副本迁移 | A · not_run | A · not_run | A · not_run | A · not_run | A · not_run | A · not_run | 一致性离线副本迁移前后 ID、Bug、人员、附件、历史和未完成任务可核对。 |
| 22 APK 共存与升级 | A · not_run | — | — | — | — | — | 新旧独立 applicationId 同设备共存；专用测试升级保留草稿和证据。 |
| 23 EXE 共存与升级 | — | A · passed | — | — | — | — | 新旧真实 EXE 同开；专用升级重启保留配置、草稿、历史及更新隔离。 |
| 24 回退演练 | — | — | — | A · passed | — | — | 能按文档恢复服务并保留回退前新增数据和任务证据；按设计10.3隔离保留新版数据，旧程序不读取已迁移的新库。 |

## 盘点规模

| 类别 | 条目数 |
| --- | --- |
| android_background_operation | 8 |
| android_control | 108 |
| android_page_component | 41 |
| background_operation | 16 |
| background_timer | 16 |
| baseline | 24 |
| desktop_event | 12 |
| desktop_ipc_action | 10 |
| desktop_menu_action | 6 |
| external_full_chain | 10 |
| http_registration_template | 2 |
| http_route | 193 |
| mcp_tool | 109 |
| required_mcp_parity | 17 |
| state_action | 12 |
| state_transition_pair | 100 |
| web_control | 273 |
| web_page_component | 34 |

## 待确认的独立资源

- **external-build** (unverified): Dedicated Jenkins test Job/workspace, licensed free executor, independent artifacts and upload target; do not borrow an active production Worker.
- **external-upload** (unverified): Dedicated test account/product/channel/prefix, final target/download verification and failure/retry/cancel scenarios.
- **external-relay** (unverified): Dedicated Relay project/workspace/test task, callback mapping and available independent executor.
- **external-qingyu** (unverified): Dedicated third-party test identity/project/order; no genuine work order mutation.
- **physical-android** (unverified): Physical device for appropriate capture/file/upgrade acceptance plus separate preview applicationId and test upgrade environment.
- **historical-copy** (partially_verified): The pinned main SQLite and 878 attachments have been restored, migrated and read through a held API. Read-only external-state inventory now locates 3 upload jobs, 2 chains, 9 Relay batches and the active queue/WAL. Live queue counts, cross-file consistent export, explicit project/version mapping and actual recovery of those external states remain unverified.
- **frozen-workflow-runtime-coverage** (partially_verified): The six registered mutation response schemas and strict static gates are repaired. Inherited 1.0 result requests/blocked writes and unregistered fail/supersede POST plus /bugs/:bugId/workflow GET remain gaps; rich existing GET history is a separate read model, not those missing operations.

## 静态盘点边界与运行补全

- Static discovery is a starting inventory, not proof of registered runtime routes or UI functionality.
- Desktop main enables sharedApi and its definition getter uses the server catalog. Server tool rows therefore also require local MCP acceptance; explicit legacy desktop tool rows remain as compatibility inventory. Verify live local tools/list and each invocation separately.
- Fastify direct routes, statically resolvable imports/templates/for-of loops and route helpers are expanded without running application code.
- Unresolvable computed registration, runtime component variations and visual-only affordances require a runtime inventory comparison before acceptance.
- Web component rows include reusable capitalized functions; Android controls are source-based Compose callback sites. Collapse duplicates only with a recorded reason and retained evidence.
- State-pair rows require contract review; every actual action/guard remains a required real test, and internal states must not be set with arbitrary database writes.
- Per-surface applicability describes that entry's origin and is not a design scope exemption. Baselines and required parity rows track cross-surface obligations.
- Working code may change concurrently; rerun after implementation stabilizes and compare source hashes.

完成验收前应与实际运行时 HTTP 路由表、服务端/本地 MCP tools/list、Web/EXE/Android 的页面与可点击控件逐项比对，补充动态入口。状态机必须核对每种动作的合法转换和失败输入；跨项目、无成员资格、旧版本、重复幂等键、删除、组件停用不能遗漏。有必测失败或未执行时不得将 Goal 标记 complete。

## android_background_operation

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| android_background_operation-1de2319f6822ee | private val notificationPermissionLauncher = registerForActivityResult( | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/MainActivity.kt:48 | not_run |
| android_background_operation-703609e9a6ec6e | private val localNetworkPermissionLauncher = registerForActivityResult( | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/MainActivity.kt:55 | not_run |
| android_background_operation-9e091dc631903d | private val overlayPermissionLauncher = registerForActivityResult( | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/MainActivity.kt:69 | not_run |
| android_background_operation-bf9617b0725a31 | private val projectionPermissionLauncher = registerForActivityResult( | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/MainActivity.kt:85 | not_run |
| android_background_operation-61a838806c5116 | private val unknownSourcesPermissionLauncher = registerForActivityResult( | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/MainActivity.kt:101 | not_run |
| android_background_operation-60881595ed8d72 | ServiceCompat.startForeground( | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/capture/CaptureSessionService.kt:472 | not_run |
| android_background_operation-2fb1bac12be60b | workManager.enqueueUniqueWork( | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/work/SyncScheduler.kt:40 | not_run |
| android_background_operation-2fb1bac12be60b-2 | workManager.enqueueUniqueWork( | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/work/SyncScheduler.kt:54 | not_run |

## android_control

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| android_control-344d465741210b | Button(enabled = mayAct, onClick = { perform { it.beginFix(bug, projectScope.actorId, note) } }, modifier = Modifier.testTag("bug-begin-fix")) { Text("开始修复") } OutlinedButton(enabled = mayAct, onClick = { perform { it.manualComplete(bug, no | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/BugLifecyclePanel.kt:86 | passed |
| android_control-f245715f5bce13 | OutlinedButton(enabled = mayAct, onClick = { perform { it.manualComplete(bug, note) } }, modifier = Modifier.testTag("bug-manual-complete")) { Text("人工完成") } } } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/BugLifecyclePanel.kt:87 | passed |
| android_control-e2c3c6bc8d9527 | Button(enabled = mayAct && (!codeDelivery \|\| branch.isNotBlank() && commit.matches(Regex("[0-9a-f]{40}"))), onClick = { perform { it.submitFix(bug, note, branch.takeIf { codeDelivery }, commit.takeIf { codeDelivery }) } }, modifier = Modifi | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/BugLifecyclePanel.kt:96 | not_run |
| android_control-1cd07b980530f5 | Button(enabled = mayAct, onClick = { perform { it.verify(bug, projectScope.actorId, true, note) } }, modifier = Modifier.testTag("bug-verify-pass")) { Text("验收通过并关闭") } OutlinedButton(enabled = mayAct, onClick = { perform { it.verify(bug, p | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/BugLifecyclePanel.kt:102 | passed |
| android_control-566e867254438e | OutlinedButton(enabled = mayAct, onClick = { perform { it.verify(bug, projectScope.actorId, false, note) } }, modifier = Modifier.testTag("bug-verify-fail")) { Text("验收失败并退回") } } } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/BugLifecyclePanel.kt:103 | passed |
| android_control-c74ab742733321 | Button(enabled = !busy && comment.isNotBlank(), onClick = { perform { container.commentTimelineClient.createComment(bug.id, commentId, comment, checkNotNull(token)) | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/BugLifecyclePanel.kt:109 | passed |
| android_control-94cd732fa8f632 | TextButton(onClick = { deleteConfirm = true }, enabled = !busy, modifier = Modifier.testTag("bug-delete")) { Text("删除 Bug（保留审计记录）") } qingyuLink?.let { link -> HorizontalDivider() | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/BugLifecyclePanel.kt:127 | not_run |
| android_control-ebe6ee5614e0e8 | if (bug.state == "closed") TextButton(enabled = !busy, onClick = { scope.launch { busy = true; qingyuError = null | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/BugLifecyclePanel.kt:133 | not_run |
| android_control-340045c328de0d | if (deleteConfirm) AlertDialog(onDismissRequest = { deleteConfirm = false }, title = { Text("删除 ${bug.key}") }, text = { Text("该 Bug 将从普通列表移除，历史和审计记录保留。") }, confirmButton = { TextButton(onClick = { deleteConfirm = false; perform(deleted =  | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/BugLifecyclePanel.kt:146 | not_run |
| android_control-b3fa76316b54f8 | confirmButton = { TextButton(onClick = { deleteConfirm = false; perform(deleted = true) { it.delete(bug) } }) { Text("删除") } }, dismissButton = { TextButton(onClick = { deleteConfirm = false }) { Text("取消") } }) } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/BugLifecyclePanel.kt:148 | not_run |
| android_control-b0d5f913dad7dc | dismissButton = { TextButton(onClick = { deleteConfirm = false }) { Text("取消") } }) } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/BugLifecyclePanel.kt:149 | not_run |
| android_control-3fa441fbf2db26 | TextButton(onClick = onBack) { Text("返回项目") } TextButton(onClick = { execute { reload(); JSONObject() } }, enabled = !busy) { Text("刷新") } } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:78 | not_run · revalidation required |
| android_control-638a71a5340ca4 | TextButton(onClick = { execute { reload(); JSONObject() } }, enabled = !busy) { Text("刷新") } } Text(component.displayName, style = MaterialTheme.typography.headlineSmall) | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:79 | not_run · revalidation required |
| android_control-dc861317120de8 | TextButton(onClick = { preset = id }) { Text((if (preset == id) "✓ " else "") + name) } } Button(enabled = !busy, onClick = { execute { client.request("packaging/builds", token, "POST", JSONObject().put("preset", preset)) } }) { Text("开始打包" | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:90 | not_run · revalidation required |
| android_control-02536c2007ee64 | Button(enabled = !busy, onClick = { execute { client.request("packaging/builds", token, "POST", JSONObject().put("preset", preset)) } }) { Text("开始打包") } } if (enabled && component.key in listOf("build_upload.single", "upload.incremental")) | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:92 | not_run · revalidation required |
| android_control-70b9b46b3e179f | onClick = { execute { if (component.key == "build_upload.single") client.request("increment-upload/build-chains", token, "POST", JSONObject().put("upload", uploadInput())) else client.request("increment-upload/jobs", token, "POST", uploadIn | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:106 | not_run · revalidation required |
| android_control-314421bc6f13fa | Button(enabled = !busy && title.isNotBlank() && description.isNotBlank(), onClick = { execute { client.request("production/batches", token, "POST", JSONObject().put("projectId", project.id) .put("requestId", UUID.randomUUID().toString()).pu | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:114 | not_run · revalidation required |
| android_control-784a10683dff8f | TextButton(enabled = !busy, onClick = { execute { client.request("packaging/tasks/$id", token).also { detail = it } } }) { Text("查看最新结果") } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:132 | not_run · revalidation required |
| android_control-775730fd4d5bf9 | onClick = { execute { client.request("packaging/tasks/$id/cancel", token, "POST", JSONObject()) } }) { Text("取消排队") } if (enabled && task.optString("state") == "paused") TextButton(enabled = !busy, onClick = { execute { client.request("pack | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:136 | not_run · revalidation required |
| android_control-59af906486dfa4 | onClick = { execute { client.request("packaging/tasks/$id/resume", token, "POST", JSONObject()) } }) { Text("恢复此任务") } } } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:138 | not_run · revalidation required |
| android_control-8622fafcfb850a | TextButton(onClick = { execute { client.request("production/${if (enabled) "tasks" else "batches"}/$id?projectId=${project.id}", token).also { detail = it } } }, enabled = !busy) { Text(if (enabled) "查看任务" else "查看历史批次") } Row(horizontalArr | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:166 | not_run · revalidation required |
| android_control-20ba0bec84782a | TextButton(enabled = enabled && !busy && (action != "continue" \|\| description.isNotBlank()), onClick = { execute { val input = JSONObject().put("taskId", id).put("expectedUpdatedAt", item.getString("updatedAt")) .put("action", action).put(" | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:169 | not_run · revalidation required |
| android_control-232271f5f37f9e | if (item.optBoolean("canManage", true)) TextButton(enabled = !busy, onClick = { execute { client.request("$jobBase/$id/cancel", token, "POST", JSONObject()) } }) { Text("取消排队 / 停止") } if (enabled && item.optBoolean("canManage", true) && ite | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:180 | not_run · revalidation required |
| android_control-66a481b8b54698 | TextButton(enabled = !busy, onClick = { execute { client.request("$jobBase/$id/$resume", token, "POST", JSONObject()) } }) { Text("恢复此任务") } } if (component.key == "upload.incremental") { | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:183 | not_run · revalidation required |
| android_control-92e4e50d616f60 | TextButton(enabled = !busy, onClick = { execute { client.request("$jobBase/$id/logs", token).also { detail = it } } }) { Text("任务日志") } if (enabled && item.optString("status") in listOf("failed", "interrupted", "awaiting_test")) { TextButto | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:186 | not_run · revalidation required |
| android_control-9a0f414d3afc8d | TextButton(enabled = !busy && testerId.toIntOrNull() != null, onClick = { execute { client.request("$jobBase/$id/resume", token, "POST", JSONObject().put("testerId", testerId.toInt()).put("testResultReference", testReference)) } }) { Text(" | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:188 | not_run · revalidation required |
| android_control-8210722f781cef | if (enabled && item.optString("status") == "awaiting_publish") TextButton(enabled = !busy, onClick = { execute { client.request("$jobBase/$id/confirm-publish", token, "POST", JSONObject()) } }) { Text("确认发布到当前目标") } } } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:192 | not_run · revalidation required |
| android_control-e99ef3080eaee7 | onSelect = viewModel::navigateTo, ) }, | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:176 | not_run · revalidation required |
| android_control-f95cd5dee2ef50 | onClick = onSwitchIdentity, modifier = Modifier.testTag("switch-identity"), shape = RoundedCornerShape(14.dp), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:269 | not_run · revalidation required |
| android_control-79d447a991d7c7 | onClick = { onSelect(QaHubPage.CAPTURE_SETTINGS) }, modifier = Modifier.weight(1f).testTag("nav-capture-settings"), ) | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:371 | not_run · revalidation required |
| android_control-952ce77c0e0e6f | onClick = { onSelect(QaHubPage.BUG_LIST) }, modifier = Modifier.weight(1f).testTag("nav-bug-list"), ) | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:379 | not_run · revalidation required |
| android_control-f95af8f236e1e1 | onClick = { onSelect(QaHubPage.NEW_BUG) }, modifier = Modifier.size(62.dp).testTag("nav-new-bug"), shape = CircleShape, | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:389 | passed · revalidation required |
| android_control-dd9f1496114940 | Surface(onClick = onClick, modifier = modifier.fillMaxHeight(), color = Color.Transparent) { Column( modifier = Modifier.fillMaxSize().padding(top = 11.dp), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:420 | not_run · revalidation required |
| android_control-e1d3f2cb7fca3d | onCheckedChange = { enabled -> if (enabled) onStartCaptureSession() else onStopCaptureSession() }, | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:532 | not_run · revalidation required |
| android_control-ef973454d585a1 | onClick = onStartCaptureSession, enabled = !active && !starting, modifier = Modifier.fillMaxWidth().testTag("start-capture"), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:545 | not_run · revalidation required |
| android_control-490a72bb53f181 | onClick = onCaptureNow, enabled = active, modifier = Modifier.weight(1f).testTag("capture-now"), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:563 | not_run · revalidation required |
| android_control-174f06380ad90a | onClick = onStopCaptureSession, enabled = active \|\| starting, modifier = Modifier.weight(1f).testTag("stop-capture"), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:570 | not_run · revalidation required |
| android_control-286c8e46aab738 | onClick = onCheck, enabled = update.phase != "checking", modifier = Modifier.testTag("check-apk-update"), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:701 | not_run · revalidation required |
| android_control-a36c942ecfc6b5 | onClick = onDownload, enabled = download.phase != "downloading" && download.phase != "installing", modifier = Modifier.fillMaxWidth().testTag("download-self-update"), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:713 | not_run · revalidation required |
| android_control-54706ba0488349 | onClick = onRefresh, enabled = catalog.phase != "loading", modifier = Modifier.testTag("refresh-game-apks"), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:758 | not_run · revalidation required |
| android_control-21149d458d8275 | onClick = onDownload, enabled = download.phase != "downloading" && download.phase != "installing", modifier = Modifier.testTag("download-game-apk-${artifact.versionName ?: artifact.fileName}"), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:826 | not_run · revalidation required |
| android_control-3e7deb0753391a | OutlinedButton(onClick = onRefresh, modifier = Modifier.testTag("refresh-bugs")) { Text("刷新") } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:912 | not_run · revalidation required |
| android_control-adcbf1c3c03791 | onClick = { reporterId = null ownerId = null | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:954 | not_run · revalidation required |
| android_control-eea6a336c81800 | BugRow(bug = bug, people = state.people.people, onClick = { onOpenBug(bug) }) } } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:983 | passed · revalidation required |
| android_control-fd5878e23634bd | onClick = { expanded = true }, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(12.dp), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1019 | not_run · revalidation required |
| android_control-811e51cc6b6337 | DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) { options.forEach { (key, name) -> DropdownMenuItem( | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1032 | not_run · revalidation required |
| android_control-21ee086df14d42 | onClick = { onSelected(key) expanded = false | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1036 | not_run · revalidation required |
| android_control-9543924f2eacef | onClick = onClick, modifier = Modifier.fillMaxWidth().testTag("bug-row-${bug.key}"), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1141 | passed · revalidation required |
| android_control-655c1a650391d7 | onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false), ) { | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1293 | not_run · revalidation required |
| android_control-d53623b1f6dbbe | onClick = onDismiss, modifier = Modifier.testTag("close-bug-detail"), shape = CircleShape, | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1326 | not_run · revalidation required |
| android_control-1284e5abdede2b | onClick = { resetDraft() editing = true | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1476 | not_run · revalidation required |
| android_control-8026b94223104d | onValueChange = { if (it.length <= 300) title = it }, label = { Text("标题") }, modifier = Modifier.fillMaxWidth().testTag("edit-bug-title"), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1504 | not_run · revalidation required |
| android_control-072c1889c01fba | onValueChange = { if (it.length <= 20_000) description = it }, label = { Text("问题内容") }, minLines = 5, | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1510 | not_run · revalidation required |
| android_control-c8638522986f83 | onValueChange = { if (it.length <= 10_000) expectedBehavior = it }, label = { Text("预期结果") }, minLines = 3, | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1517 | not_run · revalidation required |
| android_control-480e7ef5d30bbf | onClick = { imagePicker.launch("image/*") }, enabled = !saving && activeAttachments.size + newImages.size < 20, modifier = Modifier.fillMaxWidth().testTag("add-bug-images"), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1605 | not_run · revalidation required |
| android_control-38b87c024c76e7 | onClick = { resetDraft() editing = false | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1679 | not_run · revalidation required |
| android_control-947237d4ce6048 | onClick = { onSave( BugEditDraft( | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1689 | not_run · revalidation required |
| android_control-2081161dde0794 | TextButton(onClick = remove) { Text("移除") } } } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1746 | not_run · revalidation required |
| android_control-bf1912be0c1fcd | OutlinedButton(onClick = remove, modifier = Modifier.fillMaxWidth()) { Text("移除这张图片") } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1764 | not_run · revalidation required |
| android_control-8270ff34bb2f18 | onClick = onDeleteImage, enabled = !draft.isDeleting && !draft.isSubmitting, colors = ButtonDefaults.textButtonColors( | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1912 | not_run · revalidation required |
| android_control-eef9f3629ffe20 | onClick = { editorOpen = true }, enabled = !draft.isDeleting && !draft.isSubmitting, modifier = Modifier.fillMaxWidth().testTag("capture-preview"), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1924 | not_run · revalidation required |
| android_control-96d3277020ee9e | onClick = onCaptureNow, enabled = !draft.isDeleting && !draft.isSubmitting && state.captureSessionStatus != CaptureSessionUiStatus.STARTING, modifier = Modifier.testTag("new-bug-capture-now"), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1980 | passed · revalidation required |
| android_control-881eaaa8adb000 | onValueChange = { content = it onDraftChange(com.relayqahub.android.SavedBugDraft(it, fixerId, verifierId)) | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1993 | not_run · revalidation required |
| android_control-44808d673345f3 | onClick = { val bytes = image?.takeIf { savedStrokes.isNotEmpty() }?.let { renderAnnotatedPng(draft = draft, strokes = savedStrokes) | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2036 | passed · revalidation required |
| android_control-df46ef03a370e4 | onClick = onPreserveRejectedAndEdit, enabled = !draft.isDeleting && !draft.isSubmitting, modifier = Modifier.fillMaxWidth().testTag("preserve-rejected-and-edit"), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2057 | not_run · revalidation required |
| android_control-9998febc855ac2 | onClick = onReconfirmOriginalCreation, enabled = !draft.isDeleting && !draft.isSubmitting, modifier = Modifier.fillMaxWidth().testTag("reconfirm-original-creation"), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2066 | not_run · revalidation required |
| android_control-dc4ed9a9051eb6 | onDismissRequest = onCancel, properties = DialogProperties( usePlatformDefaultWidth = false, | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2154 | not_run · revalidation required |
| android_control-777012658ee76e | TextButton(onClick = onCancel) { Text("取消") } Column(horizontalAlignment = Alignment.CenterHorizontally) { Text( | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2168 | not_run · revalidation required |
| android_control-60db75b595e9f9 | onClick = { val completed = strokes + listOfNotNull(currentStroke.takeIf { it.size > 1 }) onSave(completed) | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2182 | not_run · revalidation required |
| android_control-d2d1eee2c79ffc | onClick = { if (strokes.isNotEmpty()) strokes = strokes.dropLast(1) }, enabled = strokes.isNotEmpty(), modifier = Modifier.weight(1f), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2232 | not_run · revalidation required |
| android_control-87cef7d17efde9 | onClick = { strokes = emptyList(); currentStroke = emptyList() }, enabled = strokes.isNotEmpty() \|\| currentStroke.isNotEmpty(), modifier = Modifier.weight(1f), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2237 | not_run · revalidation required |
| android_control-56d41c3102ae16 | onClick = { expanded = true }, modifier = Modifier.fillMaxWidth().height(52.dp).testTag("picker-$label"), shape = RoundedCornerShape(14.dp), | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2328 | not_run · revalidation required |
| android_control-7ecaf45ac18ba0 | DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) { if (allowUnassigned) { DropdownMenuItem( | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2355 | not_run · revalidation required |
| android_control-4f71e010e37877 | onClick = { onSelected(""); expanded = false }, ) } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2359 | not_run · revalidation required |
| android_control-d1849a4ad373a0 | onClick = { onSelected(person.id); expanded = false }, ) } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2365 | not_run · revalidation required |
| android_control-1891547324fab1 | onClick = { expanded = false }, ) } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2371 | not_run · revalidation required |
| android_control-de9f2539c529b9 | TextButton(onClick = { perform { } }, enabled = !busy) { Text("刷新") } } error?.let { Text(it, color = MaterialTheme.colorScheme.error) } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ProjectToolsScreen.kt:49 | not_run |
| android_control-b59c61834138b5 | TextButton(onClick = { selectedUser = user }, enabled = !busy && !user.protected && user.id != actor.id) { Text("关联姓名") } if (user.linkedToId != null) TextButton(onClick = { perform { client.managePerson(project.id, user.id, "unlink", null, | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ProjectToolsScreen.kt:60 | passed |
| android_control-fe522d49d6f527 | if (user.linkedToId != null) TextButton(onClick = { perform { client.managePerson(project.id, user.id, "unlink", null, token) } }, enabled = !busy) { Text("解除关联") } TextButton(onClick = { perform { client.managePerson(project.id, user.id, i | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ProjectToolsScreen.kt:61 | passed |
| android_control-f61cb33189fbb0 | TextButton(onClick = { perform { client.managePerson(project.id, user.id, if (user.active) "disable" else "restore", null, token, expectedVersion = user.membershipVersion) } }, enabled = !busy && !user.protected && user.id != actor.id) { Te | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ProjectToolsScreen.kt:62 | passed |
| android_control-36f775c6bcdc47 | TextButton(onClick = { selectedComponent = component }, enabled = !busy) { Text(if (component.enabled) "打开" else "历史") } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ProjectToolsScreen.kt:78 | not_run |
| android_control-7cd9cbaa9c2083 | AlertDialog(onDismissRequest = { selectedUser = null; linkTarget = null }, title = { Text("关联 ${user.name}") }, text = { Column(Modifier.verticalScroll(rememberScrollState())) { Text("仅调整当前项目的姓名关联。") | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ProjectToolsScreen.kt:86 | not_run |
| android_control-43fecc575c56b9 | TextButton(onClick = { linkTarget = candidate }) { Text((if (linkTarget?.id == candidate.id) "✓ " else "") + candidate.name) } } } }, | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ProjectToolsScreen.kt:90 | passed |
| android_control-cad4fd5917bd51 | confirmButton = { TextButton(enabled = linkTarget != null && !busy, onClick = { val target = linkTarget ?: return@TextButton selectedUser = null; linkTarget = null | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ProjectToolsScreen.kt:93 | passed |
| android_control-fe76292b0913cc | }) { Text("关联") } }, dismissButton = { TextButton(onClick = { selectedUser = null; linkTarget = null }) { Text("取消") } }) } } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ProjectToolsScreen.kt:97 | not_run |
| android_control-d535103c14e2f7 | TextButton(onClick = { projectPickerOpen = true }, enabled = !loginPending, modifier = Modifier.testTag("project-switch")) { Text("${currentProject.name} ▾") } DropdownMenu(expanded = projectPickerOpen, onDismissRequest = { projectPickerOpe | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/QaHubRoot.kt:118 | passed |
| android_control-57f820b113ae4e | DropdownMenu(expanded = projectPickerOpen, onDismissRequest = { projectPickerOpen = false }) { projects.forEach { available -> DropdownMenuItem(text = { Text(available.name) }, onClick = { projectPickerOpen = false | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/QaHubRoot.kt:120 | not_run |
| android_control-053937cef0ed1d | projects.forEach { available -> DropdownMenuItem(text = { Text(available.name) }, onClick = { projectPickerOpen = false if (available.id != currentProject.id) { | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/QaHubRoot.kt:121 | passed |
| android_control-331c1002d7728f | TextButton(onClick = { toolsOpen = !toolsOpen }, modifier = Modifier.testTag("project-tools")) { Text(if (toolsOpen) "Bug 工作台" else "项目与组件") } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/QaHubRoot.kt:131 | passed |
| android_control-3eacdab8beec11 | Button(onClick = { onLogin(name) }, enabled = name.isNotBlank() && projectId.isNotBlank() && !pending, modifier = Modifier.fillMaxWidth().padding(top = 16.dp).testTag("identity-login")) { Text(if (pending) "正在进入项目…" else "进入项目") | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/QaHubRoot.kt:186 | passed |
| android_control-ddc3095eb2aa97 | TextButton(onClick = onBack) { Text("返回项目") } Text("第三方订单 · ${project.name}", style = MaterialTheme.typography.headlineSmall) if (!enabled) Text("组件未启用或待配置；历史 Bug 与本地状态不受影响。") | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/QingyuComponentScreen.kt:46 | not_run |
| android_control-475d0e1e0a496c | Button(enabled = enabled && !busy, onClick = { perform { session = api.request("integrations/qingyu/login/start", token, "POST") } }) { Text("连接第三方账号") } val qrContent = session?.optJSONObject("login")?.optString("qrContent").orEmpty() val  | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/QingyuComponentScreen.kt:52 | not_run |
| android_control-c1cbd00bd997ca | if (qrContent.isNotBlank()) TextButton(enabled = !busy, onClick = { perform { refreshSession(true) } }) { Text("已扫码，检查连接") } } else { Text("已连接：${session?.optJSONObject("user")?.optString("name").orEmpty()}") | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/QingyuComponentScreen.kt:62 | not_run |
| android_control-30c20822b307af | TextButton(enabled = !busy, onClick = { perform { session = api.request("integrations/qingyu/logout", token, "POST") projects = emptyList(); defects = emptyList(); selected = emptySet(); externalProject = null | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/QingyuComponentScreen.kt:65 | not_run |
| android_control-62b2f7451b8d9e | projects.forEach { item -> TextButton(enabled = !busy, onClick = { externalProject = item; selected = emptySet(); perform { loadDefects() } }) { Text((if (externalProject?.optString("id") == item.optString("id")) "✓ " else "") + item.optStr | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/QingyuComponentScreen.kt:70 | not_run |
| android_control-7cb3bb0ff7f82a | Checkbox(id in selected, enabled = enabled && actionable && !busy, onCheckedChange = { checked -> selected = if (checked) selected + id else selected - id }) Column { Text(defect.optString("title")); Text("${defect.optString("code")} · ${de | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/QingyuComponentScreen.kt:77 | not_run |
| android_control-dd04d269da5d29 | Button(enabled = enabled && !busy && selected.isNotEmpty(), onClick = { perform { val id = checkNotNull(externalProject).getString("id") result = api.request("integrations/qingyu/import", token, "POST", JSONObject().put("projectId", id) | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/QingyuComponentScreen.kt:81 | not_run |
| android_control-eca78a6063e840 | TextButton(onClick = onBack) { Text("返回项目") } TextButton(enabled = !busy, onClick = { busy = true; error = null | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/RelayProductionScreen.kt:72 | not_run · revalidation required |
| android_control-c2e2ce499ecec0 | TextButton(enabled = !busy, onClick = { busy = true; error = null scope.launch { try { reload() } catch (failure: Exception) { error = failure.message } finally { busy = false } } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/RelayProductionScreen.kt:73 | not_run · revalidation required |
| android_control-70701562363164 | TextButton(enabled = !busy, onClick = { source = selected }, modifier = Modifier.weight(1f)) { Text((if (source == selected) "✓ " else "") + selected.label) } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/RelayProductionScreen.kt:87 | not_run · revalidation required |
| android_control-68705f8f5ae871 | Button(enabled = !busy && title.isNotBlank() && title.length <= 200 && description.isNotBlank() && description.length <= 20_000, onClick = { operate(RelayOperations.create(project.id, title, description), RelayRecordSource.BATCHES) }) { Tex | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/RelayProductionScreen.kt:96 | not_run |
| android_control-87e76f23a3ec55 | if (record.source != RelayRecordSource.OUTBOX) TextButton(enabled = !busy, onClick = { operate(RelayOperations.detail(record)) }) { Text(if (record.source == RelayRecordSource.BATCHES) "查看批次结果" else "查看任务") } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/RelayProductionScreen.kt:111 | not_run · revalidation required |
| android_control-9d4454977e399f | if (record.canResume) TextButton(enabled = ready && !busy, onClick = { operate(RelayOperations.resume(record, ready)) }) { Text(if (record.source == RelayRecordSource.OUTBOX) "恢复此条投递" else "按原配置恢复 / 重试批次") } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/RelayProductionScreen.kt:114 | not_run · revalidation required |
| android_control-0f9143db834ad9 | TextButton(enabled = ready && !busy && record.updatedAt != null && (action != "continue" \|\| (description.isNotBlank() && description.length <= 20_000)), onClick = { operate(RelayOperations.action(record, action, ready, description), RelayRe | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/RelayProductionScreen.kt:121 | not_run |
| android_control-940bd0acfd1644 | TextButton(enabled = ready && !busy, onClick = { prepareMerge(record) }) { Text("合并…") } } } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/RelayProductionScreen.kt:126 | not_run · revalidation required |
| android_control-c556ce73b97431 | AlertDialog(onDismissRequest = { mergeCandidate = null; mergeConfirmed = false }, title = { Text("确认合并仓库") }, text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/RelayProductionScreen.kt:140 | not_run · revalidation required |
| android_control-74c96a7a263f4b | confirmButton = { TextButton(enabled = mergeConfirmed && ready && !busy && selected.updatedAt != null, onClick = { val command = RelayOperations.action(selected, "merge", ready, confirmMerge = mergeConfirmed) mergeCandidate = null; mergeCon | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/RelayProductionScreen.kt:147 | not_run · revalidation required |
| android_control-1993189e4f00f5 | dismissButton = { TextButton(onClick = { mergeCandidate = null; mergeConfirmed = false }) { Text("取消") } }) } } | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/RelayProductionScreen.kt:152 | not_run · revalidation required |

## android_page_component

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| android_page_component-958057a4cdd2b9 | BugLifecyclePanel | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/BugLifecyclePanel.kt:20 | not_run |
| android_page_component-b57d968a446aff | ComponentTaskScreen | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:19 | not_run · revalidation required |
| android_page_component-40fd703b3305c9 | ComponentField | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:213 | not_run · revalidation required |
| android_page_component-46524e95871465 | ComponentRecords | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:217 | not_run · revalidation required |
| android_page_component-91633e7064ac8f | ComponentRecord | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ComponentTaskScreen.kt:224 | not_run · revalidation required |
| android_page_component-23cf18cbe26d93 | FoundationScreen | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:151 | not_run · revalidation required |
| android_page_component-4e2adf580386a1 | QaHubTopBar | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:220 | not_run · revalidation required |
| android_page_component-a7227e1cdd4094 | BottomGlyphIcon | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:316 | not_run · revalidation required |
| android_page_component-b0bd1d94700a38 | QaHubBottomBar | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:350 | not_run · revalidation required |
| android_page_component-92acbb52819323 | BottomSideTab | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:413 | not_run · revalidation required |
| android_page_component-96889c18d151b4 | CaptureSettingsPage | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:445 | not_run · revalidation required |
| android_page_component-662ec308f70bec | InstructionStep | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:614 | not_run · revalidation required |
| android_page_component-65ea5b7677179c | UsageNote | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:639 | not_run · revalidation required |
| android_page_component-6147494e818399 | SelfUpdateSection | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:657 | not_run · revalidation required |
| android_page_component-f0d0bcb2dd9075 | GameApkSection | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:732 | not_run · revalidation required |
| android_page_component-23cce1772e2ff7 | GameApkRow | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:783 | not_run · revalidation required |
| android_page_component-ca9ffedff6999d | ApkDownloadProgress | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:842 | not_run · revalidation required |
| android_page_component-1cceb121472b77 | BugListPage | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:874 | not_run · revalidation required |
| android_page_component-1445b7a87510fc | FilterDropdown | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1000 | not_run · revalidation required |
| android_page_component-096ad53ebccd86 | EmptyListCard | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1048 | not_run · revalidation required |
| android_page_component-623bb130091391 | PageHeading | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1079 | not_run · revalidation required |
| android_page_component-ffea6bcb6d9fbb | SectionCard | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1103 | not_run · revalidation required |
| android_page_component-e79551fe5aae10 | BugRow | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1135 | not_run · revalidation required |
| android_page_component-5ed4756a4d3b48 | PersonAvatar | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1228 | not_run · revalidation required |
| android_page_component-61225a5158f915 | BugStatusPill | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1246 | not_run · revalidation required |
| android_page_component-b280da6343c2a5 | BugDetailDialog | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1285 | not_run · revalidation required |
| android_page_component-07a186d81d3c06 | EditableBugDetail | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1366 | not_run · revalidation required |
| android_page_component-9c6374dfe25f2b | DetailImage | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1719 | not_run · revalidation required |
| android_page_component-2ef7a019ea82c1 | AttachmentPlaceholder | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1761 | not_run · revalidation required |
| android_page_component-13b735bcc4db56 | DetailFact | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1828 | not_run · revalidation required |
| android_page_component-6ae0a25a46f1b5 | NewBugPage | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:1840 | not_run · revalidation required |
| android_page_component-2da229b1f434e6 | AnnotationPreview | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2104 | not_run · revalidation required |
| android_page_component-9bdd580260d494 | AnnotationEditorDialog | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2132 | not_run · revalidation required |
| android_page_component-6bb372ac194140 | AnnotationCanvas | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2254 | not_run · revalidation required |
| android_page_component-8922a6200d8105 | PersonPicker | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/FoundationScreen.kt:2307 | not_run · revalidation required |
| android_page_component-d0cd40a6f416d0 | ProjectToolsScreen | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/ProjectToolsScreen.kt:16 | not_run |
| android_page_component-71f05acb34aaa9 | QaHubRoot | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/QaHubRoot.kt:24 | not_run |
| android_page_component-2373e9cd9452a2 | IdentityGate | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/QaHubRoot.kt:164 | not_run |
| android_page_component-75a67328b6d818 | QingyuComponentScreen | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/QingyuComponentScreen.kt:21 | not_run |
| android_page_component-76982dd5d1ca82 | RelayProductionScreen | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/RelayProductionScreen.kt:17 | not_run · revalidation required |
| android_page_component-f6cc561bddb616 | QaHubTheme | apk | apps/android/app/src/main/kotlin/com/relayqahub/android/ui/Theme.kt:135 | not_run |

## background_operation

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| background_operation-e4e7a859b27715 | dispatch | http, server_mcp | apps/api/src/automation.ts:200 | not_run · revalidation required |
| background_operation-013452c76ecfa1 | resume | http, server_mcp | apps/api/src/uploader-host.ts:633 | not_run · revalidation required |
| background_operation-24e1596dd2b915 | cancel | http, server_mcp | apps/api/src/build-upload-host.ts:210 | not_run |
| background_operation-27329f1366f44a | stop | http, server_mcp | apps/api/src/build-upload-host.ts:243 | not_run |
| background_operation-107b0fcad7cc1b | tick | http, server_mcp | apps/api/src/build-upload-host.ts:247 | not_run |
| background_operation-946a61b908cc7e | cancel | http, server_mcp | apps/api/src/increment-upload.ts:452 | not_run |
| background_operation-a7f7d1dac512ca | tick | http, server_mcp | apps/api/src/increment-upload.ts:683 | not_run |
| background_operation-30bb824bb01dce | startMobileRelayOutboxPump | http, server_mcp | apps/api/src/mobile-relay-outbox.ts:952 | not_run · revalidation required |
| background_operation-06adc4826d48f7 | stop | http, server_mcp | apps/api/src/mobile-relay-outbox.ts:973 | not_run · revalidation required |
| background_operation-fcd2d911fa614c | tick | http, server_mcp | apps/api/src/project-components-runtime.ts:1304 | not_run · revalidation required |
| background_operation-7cbcb043380ca9 | stop | http, server_mcp | apps/api/src/backup-runner.ts:561 | not_run |
| background_operation-2b9422c6dc843a | stop | exe, local_mcp | apps/desktop/src/notification-transport.ts:307 | not_run |
| background_operation-084cdd2350bb64 | resume | exe, local_mcp | apps/desktop/src/notification-transport.ts:325 | not_run |
| background_operation-e09e838c8e12d6 | dispatch | exe, local_mcp | apps/desktop/src/mcp-server.ts:193 | not_run · revalidation required |
| background_operation-55eabf0076368b | stop | exe, local_mcp | apps/desktop/src/mcp-server.ts:417 | not_run · revalidation required |
| background_operation-ec46b16b146670 | stop | http, server_mcp | apps/worker/src/index.ts:177 | not_run |

## background_timer

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| background_timer-2fc40f87226da6 | setInterval(() => void poll(), POLL_INTERVAL_MS) | http, server_mcp | apps/api/src/mobile-notification-hints.ts:384 | not_run · revalidation required |
| background_timer-2a8758bd3ab5d1 | setInterval(() => { const timestamp = Date.now(); for (const connection of connections) { if (timestamp - connection.lastPongAt > HEARTBEAT_TIMEOUT_MS) { removeConnection(connectio | http, server_mcp | apps/api/src/mobile-notification-hints.ts:386 | not_run · revalidation required |
| background_timer-c497ebc83e4a10 | setImmediate(resolve) | http, server_mcp | apps/api/src/mobile-notification-hints.ts:408 | not_run · revalidation required |
| background_timer-26d2ce51fdaec9 | setTimeout(() => reject(new HealthProbeTimeoutError()), timeoutMs) | http, server_mcp | apps/api/src/health.ts:50 | not_run |
| background_timer-40acb6b263f058 | setTimeout(() => controller.abort(), this.timeoutMs) | http, server_mcp | apps/api/src/qingyu-client.ts:527 | not_run |
| background_timer-40acb6b263f058-2 | setTimeout(() => controller.abort(), this.timeoutMs) | http, server_mcp | apps/api/src/qingyu-client.ts:716 | not_run |
| background_timer-3fe3bb268594eb | setTimeout(() => void poll(), 5000) | http, server_mcp | apps/api/src/build-upload-host.ts:237 | not_run |
| background_timer-7f3cb360b71d86 | setTimeout(poll, 2000) | http, server_mcp | apps/api/src/increment-upload.ts:669 | not_run |
| background_timer-eba164450d2246 | setTimeout(() => { active = deliverOne(options, leaseOwner) .then((delivered) => schedule(delivered ? 0 : 100)) .catch(() => schedule(250)); }, delayMs) | http, server_mcp | apps/api/src/mobile-relay-outbox.ts:963 | not_run · revalidation required |
| background_timer-4fa7ad50909f42 | setTimeout(loop, 2000) | http, server_mcp | apps/api/src/project-components-runtime.ts:1383 | not_run · revalidation required |
| background_timer-0e20cae93d3861 | setTimeout(() => { timer = undefined; if (stopped) return; void runBackup() .then((result) => { if (result !== undefined) recordSuccess(result); }) .catch((error: unknown) => { lat | http, server_mcp | apps/api/src/backup-runner.ts:494 | not_run |
| background_timer-811e1bc8cfd416 | setInterval(() => { heartbeat = heartbeat .then(() => writeJson(receipt, { ...runningReceipt, updatedAt: new Date().toISOString() })) .catch(() => {}); }, 5000) | http, server_mcp | apps/api/src/uploader-runner.ts:39 | not_run |
| background_timer-7633e0a377a93c | setTimeout(resolve, 100) | exe, local_mcp | apps/desktop/src/portable-updater.ts:543 | not_run · revalidation required |
| background_timer-a5fe8b8bc25271 | setTimeout(() => this.options.requestQuit(), 100) | exe, local_mcp | apps/desktop/src/portable-updater.ts:553 | not_run · revalidation required |
| background_timer-7a056b0ba0145b | setTimeout(() => void updater?.check(), 5_000) | exe, local_mcp | apps/desktop/src/main.ts:870 | not_run · revalidation required |
| background_timer-73021479b64050 | setInterval(() => void updater?.check(), 30 * 60 * 1_000) | exe, local_mcp | apps/desktop/src/main.ts:872 | not_run · revalidation required |

## desktop_event

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| desktop_event-76b9f528c794c9 | updater.error | exe | apps/desktop/src/portable-updater.ts:524 | not_run · revalidation required |
| desktop_event-74063749db8949 | updater.spawn | exe | apps/desktop/src/portable-updater.ts:528 | not_run · revalidation required |
| desktop_event-76b9f528c794c9-2 | updater.error | exe | apps/desktop/src/portable-updater.ts:529 | not_run · revalidation required |
| desktop_event-d9524f6f56abf5 | notification.click | exe | apps/desktop/src/main.ts:526 | not_run · revalidation required |
| desktop_event-6afbe7877a53ff | notification.show | exe | apps/desktop/src/main.ts:635 | not_run · revalidation required |
| desktop_event-f0cfb2a14936f6 | notification.failed | exe | apps/desktop/src/main.ts:640 | not_run · revalidation required |
| desktop_event-d9524f6f56abf5-2 | notification.click | exe | apps/desktop/src/main.ts:645 | not_run · revalidation required |
| desktop_event-9eba28266b4e95 | tray.click | exe | apps/desktop/src/main.ts:855 | not_run · revalidation required |
| desktop_event-bda40ddf0d791d | tray.double-click | exe | apps/desktop/src/main.ts:856 | not_run · revalidation required |
| desktop_event-66adc5b70ef413 | app.second-instance | exe | apps/desktop/src/main.ts:892 | not_run · revalidation required |
| desktop_event-1036cf4be9d8b1 | app.before-quit | exe | apps/desktop/src/main.ts:896 | not_run · revalidation required |
| desktop_event-729cf2c116cfae | app.window-all-closed | exe | apps/desktop/src/main.ts:903 | not_run · revalidation required |

## desktop_ipc_action

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| desktop_ipc_action-ca1ef438268b16 | handle desktop:uploader::action | exe | apps/desktop/src/main.ts:603 | not_run · revalidation required |
| desktop_ipc_action-69b5a7dec2121d | handle desktop:window-action | exe | apps/desktop/src/main.ts:608 | not_run · revalidation required |
| desktop_ipc_action-3de544a19482db | handle desktop:get-window-state | exe | apps/desktop/src/main.ts:616 | not_run · revalidation required |
| desktop_ipc_action-e602e25f511da7 | handle desktop:notify-packaging | exe | apps/desktop/src/main.ts:625 | not_run · revalidation required |
| desktop_ipc_action-00e739d975e38b | handle desktop:get-connection-status | exe | apps/desktop/src/main.ts:664 | not_run · revalidation required |
| desktop_ipc_action-461a5e177518e4 | handle desktop:get-runtime-info | exe | apps/desktop/src/main.ts:670 | not_run · revalidation required |
| desktop_ipc_action-e0109c258470bb | handle desktop:get-notifications-paused | exe | apps/desktop/src/main.ts:686 | not_run · revalidation required |
| desktop_ipc_action-1b2936d4f2c6aa | handle desktop:get-update-state | exe | apps/desktop/src/main.ts:690 | not_run · revalidation required |
| desktop_ipc_action-a5c0718eb53782 | handle desktop:check-update | exe | apps/desktop/src/main.ts:696 | not_run · revalidation required |
| desktop_ipc_action-e1a9ae39f347bc | handle desktop:install-update | exe | apps/desktop/src/main.ts:701 | not_run · revalidation required |

## desktop_menu_action

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| desktop_menu_action-c283e56c1ce9ec | 打开 QA Hub | exe | apps/desktop/src/main.ts:422 | not_run · revalidation required |
| desktop_menu_action-beab0813275be9 | 安装更新 :updater.state.version | exe | apps/desktop/src/main.ts:429 | not_run · revalidation required |
| desktop_menu_action-21fd9892b9679f | dynamic menu item | exe | apps/desktop/src/main.ts:435 | not_run · revalidation required |
| desktop_menu_action-21fd9892b9679f-2 | dynamic menu item | exe | apps/desktop/src/main.ts:448 | not_run · revalidation required |
| desktop_menu_action-325d29268d3966 | 登录时启动 | exe | apps/desktop/src/main.ts:456 | not_run · revalidation required |
| desktop_menu_action-816a53726d91ab | 退出 QA Hub | exe | apps/desktop/src/main.ts:463 | not_run · revalidation required |

## external_full_chain

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| external_full_chain-012a6715cc4d40 | APK build final result | apk | design v2.1 | not_run |
| external_full_chain-9969c5ea0f532d | APK build_upload.single final result | apk | design v2.1 | not_run |
| external_full_chain-69cb63d97a44d2 | APK upload.incremental final result | apk | design v2.1 | not_run |
| external_full_chain-deea2677f87e44 | APK relay.production final result | apk | design v2.1 | not_run |
| external_full_chain-33dc265d5cee35 | APK qingyu.sync final result | apk | design v2.1 | not_run |
| external_full_chain-177ce84830ecc3 | EXE build final result | exe | design v2.1 | not_run |
| external_full_chain-cff538a67d97b8 | EXE build_upload.single final result | exe | design v2.1 | not_run |
| external_full_chain-4d79ebb378f136 | EXE upload.incremental final result | exe | design v2.1 | not_run |
| external_full_chain-0fce9e466363bb | EXE relay.production final result | exe | design v2.1 | not_run |
| external_full_chain-719e54d03e52b9 | EXE qingyu.sync final result | exe | design v2.1 | not_run |

## http_registration_template

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| http_registration_template-bcfc5bdecbe65d | route helper template: method=method url=url | http | apps/api/src/increment-upload.ts:812 | not_run |
| http_registration_template-3095f117d7d73b | route helper template: method=method url=url | http | apps/api/src/project-components-runtime.ts:1417 | not_run · revalidation required |

## http_route

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| http_route-73141f37d37021 | GET /api/v1/android-updates/stable/:fileName | http | apps/api/src/android-updates.ts:112 | not_run · revalidation required |
| http_route-2af3ffd1e0e3b1 | HEAD /api/v1/android-updates/stable/:fileName | http | apps/api/src/android-updates.ts:112 | not_run · revalidation required |
| http_route-9a213e98c4b82e | POST /api/v1/auth/login | http | apps/api/src/browser-auth.ts:422 | passed · revalidation required |
| http_route-2eb89d61203136 | POST /api/v1/auth/gm/login | http | apps/api/src/browser-auth.ts:485 | passed · revalidation required |
| http_route-65f1a158c090f3 | GET /api/v1/auth/me | http | apps/api/src/browser-auth.ts:533 | not_run · revalidation required |
| http_route-c816ea405418e2 | POST /api/v1/auth/logout | http | apps/api/src/browser-auth.ts:547 | not_run · revalidation required |
| http_route-a770588d6792f9 | GET /api/v1/packaging | http | apps/api/src/jenkins-builds.ts:624 | not_run · revalidation required |
| http_route-27645fcd25cd14 | GET /api/v1/packaging/progress | http | apps/api/src/jenkins-builds.ts:625 | not_run · revalidation required |
| http_route-1259584f49b38b | POST /api/v1/packaging/builds | http | apps/api/src/jenkins-builds.ts:640 | not_run · revalidation required |
| http_route-d1f56343c69fad | GET /api/v1/project-entry/:projectId | http | apps/api/src/project-management.ts:198 | passed · revalidation required |
| http_route-e9a12c8504706b | GET /api/v1/gm/projects | http | apps/api/src/project-management.ts:205 | passed · revalidation required |
| http_route-94d32caae1b92a | POST /api/v1/gm/projects | http | apps/api/src/project-management.ts:212 | passed · revalidation required |
| http_route-0eb07268da2c77 | PATCH /api/v1/gm/projects/:projectId | http | apps/api/src/project-management.ts:225 | passed · revalidation required |
| http_route-8ac477f236413c | GET /api/v1/projects/:projectId/components | http | apps/api/src/project-management.ts:239 | passed · revalidation required |
| http_route-ea2cd9d03d6705 | PUT /api/v1/projects/:projectId/components/:componentKey | http | apps/api/src/project-management.ts:243 | passed · revalidation required |
| http_route-be275dd22184ef | PUT /api/v1/gm/projects/:projectId/members/:userId | http | apps/api/src/project-management.ts:273 | passed · revalidation required |
| http_route-711bab16dbbd66 | PATCH /api/v1/projects/:projectId/members/:userId | http | apps/api/src/project-management.ts:274 | passed · revalidation required |
| http_route-0d34e31f5346cd | GET /api/v1/projects/:projectId/management-events | http | apps/api/src/project-management.ts:275 | passed · revalidation required |
| http_route-8dace8b3dc8099 | GET /api/v1/bug-actions | http | apps/api/src/bug-actions.ts:161 | not_run |
| http_route-bdd491582fe181 | POST /api/v1/projects/:projectId/bugs/:bugId/actions | http | apps/api/src/bug-actions.ts:165 | passed |
| http_route-d0f051ba944955 | GET /api/v1/mcp/tools | http | apps/api/src/automation.ts:560 | not_run · revalidation required |
| http_route-b2ad8d3a3a7165 | POST /api/v1/mcp/call | http | apps/api/src/automation.ts:561 | not_run · revalidation required |
| http_route-30945d021e4660 | GET /mcp | http | apps/api/src/automation.ts:585 | not_run · revalidation required |
| http_route-42cad50255d522 | DELETE /mcp | http | apps/api/src/automation.ts:585 | not_run · revalidation required |
| http_route-7d07bccb2ec25d | POST /mcp | http | apps/api/src/automation.ts:592 | not_run · revalidation required |
| http_route-9e105e77e05c19 | GET /api/v1/increment-upload | http | apps/api/src/increment-upload.ts:836 | not_run |
| http_route-84def8a02f4dde | POST /api/v1/increment-upload/jobs | http | apps/api/src/increment-upload.ts:837 | not_run |
| http_route-82e192cee7b064 | POST /api/v1/increment-upload/login | http | apps/api/src/increment-upload.ts:839 | not_run |
| http_route-1a12833cd25ca6 | POST /api/v1/increment-upload/logout | http | apps/api/src/increment-upload.ts:839 | not_run |
| http_route-d325589dbcd8ba | POST /api/v1/increment-upload/check-auth | http | apps/api/src/increment-upload.ts:839 | not_run |
| http_route-4d108b917bed4c | POST /api/v1/increment-upload/jobs/:id/resume | http | apps/api/src/increment-upload.ts:840 | not_run |
| http_route-d66c8d8ec19c5a | POST /api/v1/increment-upload/jobs/:id/confirm-publish | http | apps/api/src/increment-upload.ts:843 | not_run |
| http_route-6a4da82817f706 | POST /api/v1/increment-upload/jobs/:id/cancel | http | apps/api/src/increment-upload.ts:846 | not_run |
| http_route-f7122cda848948 | GET /api/v1/increment-upload/jobs/:id/logs | http | apps/api/src/increment-upload.ts:847 | not_run |
| http_route-ed93ec8ec42ed6 | GET /api/v1/increment-upload/build-chains | http | apps/api/src/increment-upload.ts:848 | not_run |
| http_route-b3ecd71c7a08cd | POST /api/v1/increment-upload/build-chains | http | apps/api/src/increment-upload.ts:849 | not_run |
| http_route-7f1c9d2e01a673 | POST /api/v1/increment-upload/build-chains/:id/cancel | http | apps/api/src/increment-upload.ts:853 | not_run |
| http_route-4274717dc28cbe | GET /api/v1/production/project | http | apps/api/src/production-tasks.ts:939 | not_run · revalidation required |
| http_route-038e74acbf5190 | GET /api/v1/production/tasks | http | apps/api/src/production-tasks.ts:942 | not_run · revalidation required |
| http_route-21e077b4cbb84a | GET /api/v1/production/tasks/:id | http | apps/api/src/production-tasks.ts:943 | not_run · revalidation required |
| http_route-fe259ef17a4b1f | GET /api/v1/production/attachments/:id | http | apps/api/src/production-tasks.ts:946 | not_run · revalidation required |
| http_route-23838183327d02 | GET /api/v1/production/batches | http | apps/api/src/production-tasks.ts:949 | not_run · revalidation required |
| http_route-012b3da57a0162 | GET /api/v1/production/batches/:id | http | apps/api/src/production-tasks.ts:952 | not_run · revalidation required |
| http_route-02cbfbc7b91960 | POST /api/v1/production/batches/:id/retry | http | apps/api/src/production-tasks.ts:955 | not_run · revalidation required |
| http_route-8ba206cc1e6c03 | POST /api/v1/production/batches | http | apps/api/src/production-tasks.ts:960 | not_run · revalidation required |
| http_route-255aa18253e0ce | POST /api/v1/production/uploads | http | apps/api/src/production-tasks.ts:964 | not_run · revalidation required |
| http_route-d2e77a457d11dd | GET /api/v1/packaging | http | apps/api/src/project-components-runtime.ts:1450 | not_run · revalidation required |
| http_route-ea9d3f0cfc5ae3 | GET /api/v1/projects/:projectId/packaging | http | apps/api/src/project-components-runtime.ts:1450 | not_run · revalidation required |
| http_route-cf5ab3018cc69d | GET /api/v1/packaging/tasks | http | apps/api/src/project-components-runtime.ts:1451 | not_run · revalidation required |
| http_route-b73417f1cefc2f | GET /api/v1/projects/:projectId/packaging/tasks | http | apps/api/src/project-components-runtime.ts:1451 | not_run · revalidation required |
| http_route-f00efd29d80cdb | GET /api/v1/packaging/tasks/:id | http | apps/api/src/project-components-runtime.ts:1452 | not_run · revalidation required |
| http_route-350f746b313100 | GET /api/v1/projects/:projectId/packaging/tasks/:id | http | apps/api/src/project-components-runtime.ts:1452 | not_run · revalidation required |
| http_route-17ce8fd6dd8012 | GET /api/v1/packaging/progress | http | apps/api/src/project-components-runtime.ts:1455 | not_run · revalidation required |
| http_route-b88d5b8a2cc331 | GET /api/v1/projects/:projectId/packaging/progress | http | apps/api/src/project-components-runtime.ts:1455 | not_run · revalidation required |
| http_route-a4791e7c383ca9 | POST /api/v1/packaging/builds | http | apps/api/src/project-components-runtime.ts:1458 | not_run · revalidation required |
| http_route-257a4a9a05af34 | POST /api/v1/projects/:projectId/packaging/builds | http | apps/api/src/project-components-runtime.ts:1458 | not_run · revalidation required |
| http_route-b6dcc8d9487130 | POST /api/v1/packaging/tasks/:id/resume | http | apps/api/src/project-components-runtime.ts:1462 | not_run · revalidation required |
| http_route-72073d43f8ea3b | POST /api/v1/packaging/tasks/:id/cancel | http | apps/api/src/project-components-runtime.ts:1462 | not_run · revalidation required |
| http_route-36cc9ad4564f6d | POST /api/v1/projects/:projectId/packaging/tasks/:id/resume | http | apps/api/src/project-components-runtime.ts:1462 | not_run · revalidation required |
| http_route-54b14af04a11b3 | POST /api/v1/projects/:projectId/packaging/tasks/:id/cancel | http | apps/api/src/project-components-runtime.ts:1462 | not_run · revalidation required |
| http_route-fe07d9e5b45417 | GET /api/v1/increment-upload | http | apps/api/src/project-components-runtime.ts:1465 | not_run · revalidation required |
| http_route-8f4cc6357aed42 | GET /api/v1/projects/:projectId/increment-upload | http | apps/api/src/project-components-runtime.ts:1465 | not_run · revalidation required |
| http_route-8dfdcc83174e7b | GET /api/v1/increment-upload/build-chains | http | apps/api/src/project-components-runtime.ts:1468 | not_run · revalidation required |
| http_route-e4ad31ced05883 | GET /api/v1/projects/:projectId/increment-upload/build-chains | http | apps/api/src/project-components-runtime.ts:1468 | not_run · revalidation required |
| http_route-8a5b5fbfa66668 | POST /api/v1/increment-upload/jobs | http | apps/api/src/project-components-runtime.ts:1471 | not_run · revalidation required |
| http_route-af939fa21174f7 | POST /api/v1/projects/:projectId/increment-upload/jobs | http | apps/api/src/project-components-runtime.ts:1471 | not_run · revalidation required |
| http_route-3648d23ebd4a8a | POST /api/v1/increment-upload/build-chains | http | apps/api/src/project-components-runtime.ts:1474 | not_run · revalidation required |
| http_route-136af980a8ae9b | POST /api/v1/projects/:projectId/increment-upload/build-chains | http | apps/api/src/project-components-runtime.ts:1474 | not_run · revalidation required |
| http_route-1048ea843b4e63 | POST /api/v1/increment-upload/login | http | apps/api/src/project-components-runtime.ts:1484 | not_run · revalidation required |
| http_route-14a603fa64e62b | POST /api/v1/increment-upload/logout | http | apps/api/src/project-components-runtime.ts:1484 | not_run · revalidation required |
| http_route-ea7053af247d12 | POST /api/v1/increment-upload/check-auth | http | apps/api/src/project-components-runtime.ts:1484 | not_run · revalidation required |
| http_route-f1e38551bd65cd | POST /api/v1/projects/:projectId/increment-upload/login | http | apps/api/src/project-components-runtime.ts:1484 | not_run · revalidation required |
| http_route-695b5edc993a88 | POST /api/v1/projects/:projectId/increment-upload/logout | http | apps/api/src/project-components-runtime.ts:1484 | not_run · revalidation required |
| http_route-57126ff02dfa61 | POST /api/v1/projects/:projectId/increment-upload/check-auth | http | apps/api/src/project-components-runtime.ts:1484 | not_run · revalidation required |
| http_route-f50f667e61135d | POST /api/v1/increment-upload/jobs/:id/resume | http | apps/api/src/project-components-runtime.ts:1493 | not_run · revalidation required |
| http_route-b5d66c39625ba0 | POST /api/v1/increment-upload/jobs/:id/resume-queued | http | apps/api/src/project-components-runtime.ts:1493 | not_run · revalidation required |
| http_route-7715dc5ce88eb9 | POST /api/v1/increment-upload/jobs/:id/confirm-publish | http | apps/api/src/project-components-runtime.ts:1493 | not_run · revalidation required |
| http_route-f59d65e8568eb8 | POST /api/v1/increment-upload/jobs/:id/cancel | http | apps/api/src/project-components-runtime.ts:1493 | not_run · revalidation required |
| http_route-89e6fd575f5c17 | POST /api/v1/projects/:projectId/increment-upload/jobs/:id/resume | http | apps/api/src/project-components-runtime.ts:1493 | not_run · revalidation required |
| http_route-e1182a2d3e9e78 | POST /api/v1/projects/:projectId/increment-upload/jobs/:id/resume-queued | http | apps/api/src/project-components-runtime.ts:1493 | not_run · revalidation required |
| http_route-b73480792c0e55 | POST /api/v1/projects/:projectId/increment-upload/jobs/:id/confirm-publish | http | apps/api/src/project-components-runtime.ts:1493 | not_run · revalidation required |
| http_route-b84a51a5be3ba8 | POST /api/v1/projects/:projectId/increment-upload/jobs/:id/cancel | http | apps/api/src/project-components-runtime.ts:1493 | not_run · revalidation required |
| http_route-72f4ac69e15b17 | GET /api/v1/increment-upload/jobs/:id/logs | http | apps/api/src/project-components-runtime.ts:1503 | not_run · revalidation required |
| http_route-7e241f669a8cf1 | GET /api/v1/projects/:projectId/increment-upload/jobs/:id/logs | http | apps/api/src/project-components-runtime.ts:1503 | not_run · revalidation required |
| http_route-5c059d888715c3 | POST /api/v1/increment-upload/build-chains/:id/cancel | http | apps/api/src/project-components-runtime.ts:1506 | not_run · revalidation required |
| http_route-7f9b3a75338b60 | POST /api/v1/projects/:projectId/increment-upload/build-chains/:id/cancel | http | apps/api/src/project-components-runtime.ts:1506 | not_run · revalidation required |
| http_route-7307fc11a2d756 | POST /api/v1/increment-upload/build-chains/:id/resume | http | apps/api/src/project-components-runtime.ts:1516 | not_run · revalidation required |
| http_route-6601337cc1886e | POST /api/v1/projects/:projectId/increment-upload/build-chains/:id/resume | http | apps/api/src/project-components-runtime.ts:1516 | not_run · revalidation required |
| http_route-48aac5400c4a99 | GET /api/v1/production/tasks/history | http | apps/api/src/project-components-runtime.ts:1526 | not_run · revalidation required |
| http_route-8a44c827ca3611 | GET /api/v1/projects/:projectId/production/tasks/history | http | apps/api/src/project-components-runtime.ts:1526 | not_run · revalidation required |
| http_route-bdfe16b14f7d07 | GET /api/v1/production/project | http | apps/api/src/project-components-runtime.ts:1540 | not_run · revalidation required |
| http_route-65f9d00efee77b | GET /api/v1/production/tasks | http | apps/api/src/project-components-runtime.ts:1540 | not_run · revalidation required |
| http_route-104808d92fd7e3 | GET /api/v1/production/batches | http | apps/api/src/project-components-runtime.ts:1540 | not_run · revalidation required |
| http_route-cf52aed7b7702b | GET /api/v1/projects/:projectId/production/project | http | apps/api/src/project-components-runtime.ts:1540 | not_run · revalidation required |
| http_route-899f755e30e3bd | GET /api/v1/projects/:projectId/production/tasks | http | apps/api/src/project-components-runtime.ts:1540 | not_run · revalidation required |
| http_route-7840ea0a298511 | GET /api/v1/projects/:projectId/production/batches | http | apps/api/src/project-components-runtime.ts:1540 | not_run · revalidation required |
| http_route-6c6e90b6d8fb03 | GET /api/v1/production/tasks/:id | http | apps/api/src/project-components-runtime.ts:1548 | not_run · revalidation required |
| http_route-3f8412a9862baa | GET /api/v1/production/attachments/:id | http | apps/api/src/project-components-runtime.ts:1548 | not_run · revalidation required |
| http_route-9bb72f424270f2 | GET /api/v1/production/batches/:id | http | apps/api/src/project-components-runtime.ts:1548 | not_run · revalidation required |
| http_route-8cd5abed83e818 | GET /api/v1/projects/:projectId/production/tasks/:id | http | apps/api/src/project-components-runtime.ts:1548 | not_run · revalidation required |
| http_route-1ecd3a3f651bb6 | GET /api/v1/projects/:projectId/production/attachments/:id | http | apps/api/src/project-components-runtime.ts:1548 | not_run · revalidation required |
| http_route-35ffc6881ab3a4 | GET /api/v1/projects/:projectId/production/batches/:id | http | apps/api/src/project-components-runtime.ts:1548 | not_run · revalidation required |
| http_route-f2790972a9201b | POST /api/v1/production/batches | http | apps/api/src/project-components-runtime.ts:1557 | not_run · revalidation required |
| http_route-4f74fd437ff8a1 | POST /api/v1/projects/:projectId/production/batches | http | apps/api/src/project-components-runtime.ts:1557 | not_run · revalidation required |
| http_route-b3fc7bcec3ce33 | POST /api/v1/production/uploads | http | apps/api/src/project-components-runtime.ts:1560 | not_run · revalidation required |
| http_route-ff6a91aca255d2 | POST /api/v1/projects/:projectId/production/uploads | http | apps/api/src/project-components-runtime.ts:1560 | not_run · revalidation required |
| http_route-1d7884f10a41a9 | POST /api/v1/production/batches/:id/retry | http | apps/api/src/project-components-runtime.ts:1563 | not_run · revalidation required |
| http_route-7b14999039ad2b | POST /api/v1/projects/:projectId/production/batches/:id/retry | http | apps/api/src/project-components-runtime.ts:1563 | not_run · revalidation required |
| http_route-6bb0b144cd20b7 | GET /api/v1/production/outbox | http | apps/api/src/project-components-runtime.ts:1572 | not_run · revalidation required |
| http_route-dd102f03b3b352 | GET /api/v1/projects/:projectId/production/outbox | http | apps/api/src/project-components-runtime.ts:1572 | not_run · revalidation required |
| http_route-c154975a6b0800 | POST /api/v1/production/outbox/:id/resume | http | apps/api/src/project-components-runtime.ts:1575 | not_run · revalidation required |
| http_route-835c8b0613870e | POST /api/v1/projects/:projectId/production/outbox/:id/resume | http | apps/api/src/project-components-runtime.ts:1575 | not_run · revalidation required |
| http_route-dc2c05bb8659ca | GET /api/v1/qingyu/history | http | apps/api/src/project-components-runtime.ts:1578 | not_run · revalidation required |
| http_route-9057629cc82ae1 | GET /api/v1/projects/:projectId/qingyu/history | http | apps/api/src/project-components-runtime.ts:1578 | not_run · revalidation required |
| http_route-f1193252d91b6b | GET /api/v1/integrations/qingyu/session | http | apps/api/src/project-components-runtime.ts:1585 | not_run · revalidation required |
| http_route-791988da9be913 | GET /api/v1/integrations/qingyu/login/status | http | apps/api/src/project-components-runtime.ts:1585 | not_run · revalidation required |
| http_route-0d2b9be6655860 | GET /api/v1/integrations/qingyu/projects | http | apps/api/src/project-components-runtime.ts:1585 | not_run · revalidation required |
| http_route-21562685cc653d | GET /api/v1/integrations/qingyu/defects | http | apps/api/src/project-components-runtime.ts:1585 | not_run · revalidation required |
| http_route-11f31954e5f51e | GET /api/v1/projects/:projectId/integrations/qingyu/session | http | apps/api/src/project-components-runtime.ts:1585 | not_run · revalidation required |
| http_route-5b542331e47819 | GET /api/v1/projects/:projectId/integrations/qingyu/login/status | http | apps/api/src/project-components-runtime.ts:1585 | not_run · revalidation required |
| http_route-12d028315ec217 | GET /api/v1/projects/:projectId/integrations/qingyu/projects | http | apps/api/src/project-components-runtime.ts:1585 | not_run · revalidation required |
| http_route-304d72fc62f924 | GET /api/v1/projects/:projectId/integrations/qingyu/defects | http | apps/api/src/project-components-runtime.ts:1585 | not_run · revalidation required |
| http_route-68f9b10cee849b | POST /api/v1/integrations/qingyu/login/start | http | apps/api/src/project-components-runtime.ts:1593 | not_run · revalidation required |
| http_route-d0fd6bac63b8a2 | POST /api/v1/integrations/qingyu/logout | http | apps/api/src/project-components-runtime.ts:1593 | not_run · revalidation required |
| http_route-a88f3a4702034c | POST /api/v1/integrations/qingyu/import | http | apps/api/src/project-components-runtime.ts:1593 | not_run · revalidation required |
| http_route-689b772ea15c35 | POST /api/v1/projects/:projectId/integrations/qingyu/login/start | http | apps/api/src/project-components-runtime.ts:1593 | not_run · revalidation required |
| http_route-816c7cc443f181 | POST /api/v1/projects/:projectId/integrations/qingyu/logout | http | apps/api/src/project-components-runtime.ts:1593 | not_run · revalidation required |
| http_route-283634d5d78701 | POST /api/v1/projects/:projectId/integrations/qingyu/import | http | apps/api/src/project-components-runtime.ts:1593 | not_run · revalidation required |
| http_route-e92ee3d2d57fc4 | GET /api/v1/bugs/:id/integrations/qingyu | http | apps/api/src/project-components-runtime.ts:1596 | not_run · revalidation required |
| http_route-d65bf262601bf6 | GET /api/v1/projects/:projectId/bugs/:id/integrations/qingyu | http | apps/api/src/project-components-runtime.ts:1596 | not_run · revalidation required |
| http_route-def90a2a37e735 | POST /api/v1/bugs/:id/integrations/qingyu/resolve | http | apps/api/src/project-components-runtime.ts:1599 | not_run · revalidation required |
| http_route-fb184b4887747c | POST /api/v1/projects/:projectId/bugs/:id/integrations/qingyu/resolve | http | apps/api/src/project-components-runtime.ts:1599 | not_run · revalidation required |
| http_route-ba74efbe6c4a29 | GET /api/v1/projects/:projectId/bugs/:bugId/comments | http | apps/api/src/app.ts:645 | not_run · revalidation required |
| http_route-9b7f74dec2b2b9 | GET /api/v1/bugs/:bugId/comments | http | apps/api/src/app.ts:645 | passed · revalidation required |
| http_route-e20df3cb12ff98 | GET /api/v1/integrations/qingyu/session | http | apps/api/src/app.ts:857 | not_run · revalidation required |
| http_route-4d0d6a9945299e | POST /api/v1/integrations/qingyu/login/start | http | apps/api/src/app.ts:860 | not_run · revalidation required |
| http_route-b16fff4e38476e | GET /api/v1/integrations/qingyu/login/status | http | apps/api/src/app.ts:863 | not_run · revalidation required |
| http_route-0b9a05d3353c00 | POST /api/v1/integrations/qingyu/logout | http | apps/api/src/app.ts:866 | not_run · revalidation required |
| http_route-fb4df5d6788e96 | GET /api/v1/integrations/qingyu/projects | http | apps/api/src/app.ts:869 | not_run · revalidation required |
| http_route-734ef90385c2b4 | GET /api/v1/integrations/qingyu/defects | http | apps/api/src/app.ts:872 | not_run · revalidation required |
| http_route-05c527f410d563 | POST /api/v1/integrations/qingyu/import | http | apps/api/src/app.ts:884 | not_run · revalidation required |
| http_route-46019be68cb07c | GET /api/v1/bugs/:bugId/integrations/qingyu | http | apps/api/src/app.ts:907 | not_run · revalidation required |
| http_route-488ec5565e8dbb | POST /api/v1/bugs/:bugId/integrations/qingyu/resolve | http | apps/api/src/app.ts:914 | not_run · revalidation required |
| http_route-ce0b3ab5de0378 | GET /api/v1/health/live | http | apps/api/src/app.ts:939 | not_run · revalidation required |
| http_route-26df99fae8d3cb | GET /api/v1/health/ready | http | apps/api/src/app.ts:951 | passed · revalidation required |
| http_route-188681ac0da08e | GET /api/v1/health/deps | http | apps/api/src/app.ts:963 | not_run · revalidation required |
| http_route-15d30cfca91ddc | GET /api/v1/projects | http | apps/api/src/app.ts:986 | passed · revalidation required |
| http_route-86a5dccd36f9b9 | GET /api/v1/projects/:projectId/members | http | apps/api/src/app.ts:1017 | not_run · revalidation required |
| http_route-070fd3ccaaef52 | GET /api/v1/projects/:projectId/users | http | apps/api/src/app.ts:1054 | passed · revalidation required |
| http_route-59983f06154358 | POST /api/v1/projects/:projectId/users/:userId/identity-link | http | apps/api/src/app.ts:1085 | passed · revalidation required |
| http_route-9ffe2403f950fe | DELETE /api/v1/projects/:projectId/users/:userId/identity-link | http | apps/api/src/app.ts:1124 | passed · revalidation required |
| http_route-a08902abfe6362 | DELETE /api/v1/projects/:projectId/users/:userId | http | apps/api/src/app.ts:1160 | not_run · revalidation required |
| http_route-3941a7c4bf1de3 | GET /api/v1/projects/:projectId/modules | http | apps/api/src/app.ts:1196 | passed · revalidation required |
| http_route-28fa750120b0f6 | GET /api/v1/projects/:projectId/metrics/overview | http | apps/api/src/app.ts:1228 | passed · revalidation required |
| http_route-b1edbd66a463bf | POST /api/v1/integrations/relay/webhooks | http | apps/api/src/app.ts:1264 | not_run · revalidation required |
| http_route-869c95e9cb22b6 | POST /api/v1/bugs | http | apps/api/src/app.ts:1377 | passed · revalidation required |
| http_route-fc68d4ec88b267 | GET /api/v1/bugs | http | apps/api/src/app.ts:1410 | passed · revalidation required |
| http_route-c5244a2b94ee13 | GET /api/v1/bugs/:bugId | http | apps/api/src/app.ts:1446 | passed · revalidation required |
| http_route-662ac1e4f068be | GET /api/v1/bugs/:bugId/attachments | http | apps/api/src/app.ts:1461 | passed · revalidation required |
| http_route-f2b76a8f2d3bd2 | GET /api/v1/attachments/:attachmentId | http | apps/api/src/app.ts:1499 | passed · revalidation required |
| http_route-a04ed67480846a | GET /api/v1/bugs/:bugId/capture-bundles/:captureId/artifacts/:artifactKind | http | apps/api/src/app.ts:1536 | not_run · revalidation required |
| http_route-7cbbf0261f199e | PATCH /api/v1/bugs/:bugId | http | apps/api/src/app.ts:1574 | passed · revalidation required |
| http_route-3f8b6d79c3ec5a | DELETE /api/v1/bugs/:bugId | http | apps/api/src/app.ts:1615 | passed · revalidation required |
| http_route-ece15477c6d8f2 | GET /api/v1/bugs/:bugId/duplicate-candidates | http | apps/api/src/app.ts:1666 | not_run · revalidation required |
| http_route-fa0ad66b7c6d55 | POST /api/v1/bugs/:bugId/mark-duplicate | http | apps/api/src/app.ts:1698 | not_run · revalidation required |
| http_route-280fa057c65980 | POST /api/v1/bugs/:bugId/transitions | http | apps/api/src/app.ts:1779 | passed · revalidation required |
| http_route-1c63e6c6d88251 | POST /api/v1/bugs/:bugId/complete | http | apps/api/src/app.ts:1804 | not_run · revalidation required |
| http_route-91587d5ccb9fcd | POST /api/v1/bugs/:bugId/manual-complete | http | apps/api/src/app.ts:1829 | passed · revalidation required |
| http_route-133e8410ae7ef7 | POST /api/v1/bugs/:bugId/repair-attempts | http | apps/api/src/app.ts:1857 | passed · revalidation required |
| http_route-45735bc8af628d | POST /api/v1/repair-attempts/:attemptId/start | http | apps/api/src/app.ts:1898 | passed · revalidation required |
| http_route-41e2d865a8623c | GET /api/v1/repair-attempts/:attemptId | http | apps/api/src/app.ts:1931 | passed · revalidation required |
| http_route-144efd0c9334b8 | POST /api/v1/repair-attempts/:attemptId/deliver | http | apps/api/src/app.ts:1951 | passed · revalidation required |
| http_route-db5ad310cd3847 | POST /api/v1/repair-attempts/:attemptId/dispatch/relay | http | apps/api/src/app.ts:1984 | not_run · revalidation required |
| http_route-5e57e964b1adfd | POST /api/v1/repair-attempts/:attemptId/dispatch/relay/continue | http | apps/api/src/app.ts:2012 | not_run · revalidation required |
| http_route-76ef6845b5667f | GET /api/v1/repair-attempts/:attemptId/relay-receipt | http | apps/api/src/app.ts:2040 | not_run · revalidation required |
| http_route-458b653f20c1e7 | GET /api/v1/projects/:projectId/human-workflows/latest | http | apps/api/src/app.ts:2104 | not_run · revalidation required |
| http_route-58b6388e1f18b2 | GET /api/v1/bugs/:bugId/human-workflow | http | apps/api/src/app.ts:2129 | passed · revalidation required |
| http_route-9b794c870fa8c4 | POST /api/v1/bugs/:bugId/comments | http | apps/api/src/app.ts:2145 | passed · revalidation required |
| http_route-c72542c420f961 | GET /api/v1/bugs/:bugId/events | http | apps/api/src/app.ts:2188 | passed · revalidation required |
| http_route-845f3dd811fe15 | POST /api/v1/projects/:projectId/builds | http | apps/api/src/app.ts:2208 | not_run · revalidation required |
| http_route-0b655a74e571ea | GET /api/v1/builds/:buildId | http | apps/api/src/app.ts:2239 | not_run · revalidation required |
| http_route-9294236825da5b | POST /api/v1/builds/:buildId/link-repair | http | apps/api/src/app.ts:2256 | not_run · revalidation required |
| http_route-8d683a24515c8d | POST /api/v1/bugs/:bugId/verifications | http | apps/api/src/app.ts:2287 | passed · revalidation required |
| http_route-36af4a3289727c | GET /api/v1/verifications/:verificationId | http | apps/api/src/app.ts:2319 | passed · revalidation required |
| http_route-d250196281a746 | POST /api/v1/verifications/:verificationId/start | http | apps/api/src/app.ts:2342 | passed · revalidation required |
| http_route-71b69634fdaab2 | POST /api/v1/verifications/:verificationId/result | http | apps/api/src/app.ts:2376 | passed · revalidation required |
| http_route-b83c2fe59f4e18 | GET /api/v1/notifications | http | apps/api/src/app.ts:2432 | not_run · revalidation required |
| http_route-ac6d99044543fe | POST /api/v1/capture-bundles | http | apps/api/src/app.ts:2476 | not_run · revalidation required |
| http_route-b549a49f407c27 | GET /api/v1/capture-bundles/:captureId | http | apps/api/src/app.ts:2518 | not_run · revalidation required |
| http_route-52f4781153b6ba | POST /api/v1/uploads/init | http | apps/api/src/app.ts:2533 | not_run · revalidation required |
| http_route-1aed7cd39c68f5 | PUT /api/v1/uploads/:sessionId/chunks/:chunkNumber | http | apps/api/src/app.ts:2567 | not_run · revalidation required |
| http_route-fa84a8b7df5b30 | POST /api/v1/uploads/:sessionId/finalize | http | apps/api/src/app.ts:2621 | not_run · revalidation required |
| http_route-45b4878978d031 | POST /api/v1/attachments/:attachmentId/bind | http | apps/api/src/app.ts:2665 | passed · revalidation required |

## mcp_tool

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| mcp_tool-1df39376151c94 | qa_get_session | server_mcp, local_mcp | apps/api/src/automation-routes.ts:2 | not_run |
| mcp_tool-1df39376151c94-2 | qa_get_session | server_mcp, local_mcp | apps/api/src/automation-routes.ts:3 | not_run |
| mcp_tool-c631af195b9242 | qa_logout | server_mcp, local_mcp | apps/api/src/automation-routes.ts:4 | not_run |
| mcp_tool-d05b9883cd938a | qa_get_project_entry | server_mcp, local_mcp | apps/api/src/automation-routes.ts:5 | not_run |
| mcp_tool-4666cefe9b1e84 | qa_list_managed_projects | server_mcp, local_mcp | apps/api/src/automation-routes.ts:6 | not_run |
| mcp_tool-e3c04fa82991db | qa_list_management_events | server_mcp, local_mcp | apps/api/src/automation-routes.ts:7 | not_run |
| mcp_tool-efec7c028e95bb | qa_link_identity | server_mcp, local_mcp | apps/api/src/automation-routes.ts:13 | not_run |
| mcp_tool-ee5ffe4f833a87 | qa_unlink_identity | server_mcp, local_mcp | apps/api/src/automation-routes.ts:19 | not_run |
| mcp_tool-690a4661455f5c | qa_get_metrics | server_mcp, local_mcp | apps/api/src/automation-routes.ts:25 | not_run |
| mcp_tool-ae62642f5fa1f5 | qa_list_notifications | server_mcp, local_mcp | apps/api/src/automation-routes.ts:26 | not_run |
| mcp_tool-955c9ead3c3e0a | qa_get_duplicate_candidates | server_mcp, local_mcp | apps/api/src/automation-routes.ts:27 | not_run |
| mcp_tool-b972eff2ea9f1c | qa_mark_duplicate | server_mcp, local_mcp | apps/api/src/automation-routes.ts:33 | not_run |
| mcp_tool-ca354aab346084 | qa_get_repair_attempt | server_mcp, local_mcp | apps/api/src/automation-routes.ts:34 | not_run |
| mcp_tool-fda9844678505c | qa_get_relay_receipt | server_mcp, local_mcp | apps/api/src/automation-routes.ts:35 | not_run |
| mcp_tool-23414b42cfe6c5 | qa_get_verification | server_mcp, local_mcp | apps/api/src/automation-routes.ts:41 | not_run |
| mcp_tool-8c88047a002ab3 | qa_list_build_records | server_mcp, local_mcp | apps/api/src/automation-routes.ts:42 | not_run |
| mcp_tool-cd4e338f7cf4f4 | qa_create_build_record | server_mcp, local_mcp | apps/api/src/automation-routes.ts:43 | not_run |
| mcp_tool-154e867b58d92f | qa_get_build_record | server_mcp, local_mcp | apps/api/src/automation-routes.ts:44 | not_run |
| mcp_tool-8fac9886c23fe0 | qa_link_build_repair | server_mcp, local_mcp | apps/api/src/automation-routes.ts:45 | not_run |
| mcp_tool-dd8d5ecf0a6eaf | qa_create_capture | server_mcp, local_mcp | apps/api/src/automation-routes.ts:46 | not_run |
| mcp_tool-c96d25abe8fe05 | qa_get_capture | server_mcp, local_mcp | apps/api/src/automation-routes.ts:47 | not_run |
| mcp_tool-6e67fcd3461d4c | qa_init_upload | server_mcp, local_mcp | apps/api/src/automation-routes.ts:48 | not_run |
| mcp_tool-51d827e980362c | qa_finalize_upload | server_mcp, local_mcp | apps/api/src/automation-routes.ts:49 | not_run |
| mcp_tool-591e0ff5fd01d1 | qa_bind_attachment | server_mcp, local_mcp | apps/api/src/automation-routes.ts:50 | not_run |
| mcp_tool-2cc8bc1e557ea5 | qa_get_packaging | server_mcp, local_mcp | apps/api/src/automation-routes.ts:51 | not_run |
| mcp_tool-85fb3cec2f5fe9 | qa_list_build_tasks | server_mcp, local_mcp | apps/api/src/automation-routes.ts:52 | not_run |
| mcp_tool-0448eb08f468e8 | qa_get_build_task | server_mcp, local_mcp | apps/api/src/automation-routes.ts:53 | not_run |
| mcp_tool-8811c0eb4d2815 | qa_get_build_progress | server_mcp, local_mcp | apps/api/src/automation-routes.ts:54 | not_run |
| mcp_tool-9113fe53ed3442 | qa_enqueue_build | server_mcp, local_mcp | apps/api/src/automation-routes.ts:55 | not_run |
| mcp_tool-1dded35461f551 | qa_resume_build | server_mcp, local_mcp | apps/api/src/automation-routes.ts:56 | not_run |
| mcp_tool-571059bc84ce10 | qa_cancel_build | server_mcp, local_mcp | apps/api/src/automation-routes.ts:57 | not_run |
| mcp_tool-5aa07fbffc39ef | qa_get_upload_status | server_mcp, local_mcp | apps/api/src/automation-routes.ts:58 | not_run |
| mcp_tool-5b6c3984ddf817 | qa_list_build_upload_chains | server_mcp, local_mcp | apps/api/src/automation-routes.ts:59 | not_run |
| mcp_tool-1fd1727632e5be | qa_enqueue_upload | server_mcp, local_mcp | apps/api/src/automation-routes.ts:65 | not_run |
| mcp_tool-5f086fceaa701b | qa_enqueue_build_upload | server_mcp, local_mcp | apps/api/src/automation-routes.ts:66 | not_run |
| mcp_tool-43f5635dfdd6ee | qa_upload_login | server_mcp, local_mcp | apps/api/src/automation-routes.ts:72 | not_run |
| mcp_tool-ea3e16a4a16363 | qa_upload_logout | server_mcp, local_mcp | apps/api/src/automation-routes.ts:73 | not_run |
| mcp_tool-165b12f7c9d463 | qa_upload_check_auth | server_mcp, local_mcp | apps/api/src/automation-routes.ts:74 | not_run |
| mcp_tool-1b0865321b7524 | qa_resume_upload | server_mcp, local_mcp | apps/api/src/automation-routes.ts:75 | not_run |
| mcp_tool-353bf188207322 | qa_resume_queued_upload | server_mcp, local_mcp | apps/api/src/automation-routes.ts:76 | not_run |
| mcp_tool-306bfbe9c216cd | qa_confirm_upload_publish | server_mcp, local_mcp | apps/api/src/automation-routes.ts:82 | not_run |
| mcp_tool-9ab3296fda1969 | qa_cancel_upload | server_mcp, local_mcp | apps/api/src/automation-routes.ts:88 | not_run |
| mcp_tool-bb1116ebfdb090 | qa_get_upload_logs | server_mcp, local_mcp | apps/api/src/automation-routes.ts:89 | not_run |
| mcp_tool-c045f129fd668a | qa_cancel_build_upload | server_mcp, local_mcp | apps/api/src/automation-routes.ts:90 | not_run |
| mcp_tool-e17df691e5962d | qa_resume_build_upload | server_mcp, local_mcp | apps/api/src/automation-routes.ts:96 | not_run |
| mcp_tool-0e99880ca06f37 | qa_list_relay_outbox | server_mcp, local_mcp | apps/api/src/automation-routes.ts:102 | not_run |
| mcp_tool-72a6595b8141ee | qa_resume_relay_outbox | server_mcp, local_mcp | apps/api/src/automation-routes.ts:103 | not_run |
| mcp_tool-a414009491e067 | qa_get_relay_project | server_mcp, local_mcp | apps/api/src/automation-routes.ts:109 | not_run |
| mcp_tool-09f4971ea89690 | qa_list_relay_tasks | server_mcp, local_mcp | apps/api/src/automation-routes.ts:110 | not_run |
| mcp_tool-fc53c020d3791e | qa_list_relay_history | server_mcp, local_mcp | apps/api/src/automation-routes.ts:111 | not_run |
| mcp_tool-a63c091c14d3de | qa_get_relay_task | server_mcp, local_mcp | apps/api/src/automation-routes.ts:112 | not_run |
| mcp_tool-593d114c9cf923 | qa_get_relay_attachment | server_mcp, local_mcp | apps/api/src/automation-routes.ts:113 | not_run |
| mcp_tool-1c36b63303bcbf | qa_list_relay_batches | server_mcp, local_mcp | apps/api/src/automation-routes.ts:114 | not_run |
| mcp_tool-7001263ec4ec44 | qa_get_relay_batch | server_mcp, local_mcp | apps/api/src/automation-routes.ts:115 | not_run |
| mcp_tool-3e37d2dad26876 | qa_create_relay_batch | server_mcp, local_mcp | apps/api/src/automation-routes.ts:116 | not_run |
| mcp_tool-8ed5fd69dbfc20 | qa_upload_relay_attachment | server_mcp, local_mcp | apps/api/src/automation-routes.ts:117 | not_run |
| mcp_tool-d4036c3633f1b9 | qa_retry_relay_batch | server_mcp, local_mcp | apps/api/src/automation-routes.ts:118 | not_run |
| mcp_tool-e161d1dd23fe9e | qa_get_qingyu_history | server_mcp, local_mcp | apps/api/src/automation-routes.ts:124 | not_run |
| mcp_tool-836bfc88e8d906 | qa_get_qingyu_session | server_mcp, local_mcp | apps/api/src/automation-routes.ts:125 | not_run |
| mcp_tool-d5ce3581be3920 | qa_start_qingyu_login | server_mcp, local_mcp | apps/api/src/automation-routes.ts:126 | not_run |
| mcp_tool-5b250ee8a4f849 | qa_get_qingyu_login_status | server_mcp, local_mcp | apps/api/src/automation-routes.ts:127 | not_run |
| mcp_tool-9c860b882c761a | qa_qingyu_logout | server_mcp, local_mcp | apps/api/src/automation-routes.ts:133 | not_run |
| mcp_tool-0e2ff22912d7b6 | qa_list_qingyu_projects | server_mcp, local_mcp | apps/api/src/automation-routes.ts:134 | not_run |
| mcp_tool-736350e8c61979 | qa_list_qingyu_defects | server_mcp, local_mcp | apps/api/src/automation-routes.ts:140 | not_run |
| mcp_tool-4ca3061c001ed0 | qa_import_qingyu_defects | server_mcp, local_mcp | apps/api/src/automation-routes.ts:141 | not_run |
| mcp_tool-eee2d6479fd2e5 | qa_get_qingyu_link | server_mcp, local_mcp | apps/api/src/automation-routes.ts:142 | not_run |
| mcp_tool-944e97d1c305e4 | qa_resolve_qingyu_link | server_mcp, local_mcp | apps/api/src/automation-routes.ts:143 | not_run |
| mcp_tool-2678de841b07f7 | qa_put_upload_chunk | server_mcp, local_mcp | apps/api/src/automation.ts:80 | not_run · revalidation required |
| mcp_tool-906d9c559b282b | qa_read_attachment | server_mcp, local_mcp | apps/api/src/automation.ts:96 | not_run · revalidation required |
| mcp_tool-aac23a557e40f8 | qa_login_gm | server_mcp, local_mcp | apps/api/src/automation.ts:101 | not_run · revalidation required |
| mcp_tool-486db92a1dc001 | qa_login | server_mcp, local_mcp | apps/api/src/automation.ts:102 | passed · revalidation required |
| mcp_tool-05ad77d566fe48 | qa_list_projects | server_mcp, local_mcp | apps/api/src/automation.ts:103 | passed · revalidation required |
| mcp_tool-491b4d01a7ad0b | qa_list_bugs | server_mcp, local_mcp | apps/api/src/automation.ts:104 | not_run · revalidation required |
| mcp_tool-e115fd03bfb2f6 | qa_get_bug_context | server_mcp, local_mcp | apps/api/src/automation.ts:105 | passed · revalidation required |
| mcp_tool-74ebfb8a36a39b | qa_create_bug | server_mcp, local_mcp | apps/api/src/automation.ts:106 | passed · revalidation required |
| mcp_tool-6a5abbcebe63f8 | qa_update_bug | server_mcp, local_mcp | apps/api/src/automation.ts:107 | not_run · revalidation required |
| mcp_tool-65cae97a9470db | qa_delete_bug | server_mcp, local_mcp | apps/api/src/automation.ts:113 | passed · revalidation required |
| mcp_tool-5f4e4082b53976 | qa_bug_action | server_mcp, local_mcp | apps/api/src/automation.ts:114 | passed · revalidation required |
| mcp_tool-a483a7b73025b9 | qa_add_comment | server_mcp, local_mcp | apps/api/src/automation.ts:120 | passed · revalidation required |
| mcp_tool-c55b38696c3ed8 | qa_list_comments | server_mcp, local_mcp | apps/api/src/automation.ts:121 | passed · revalidation required |
| mcp_tool-f280c088ac3cdf | qa_list_events | server_mcp, local_mcp | apps/api/src/automation.ts:122 | not_run · revalidation required |
| mcp_tool-7cc097f0b5bccc | qa_list_members | server_mcp, local_mcp | apps/api/src/automation.ts:123 | not_run · revalidation required |
| mcp_tool-4e202f02c133f7 | qa_list_users | server_mcp, local_mcp | apps/api/src/automation.ts:124 | not_run · revalidation required |
| mcp_tool-556efe782b95c8 | qa_list_modules | server_mcp, local_mcp | apps/api/src/automation.ts:125 | not_run · revalidation required |
| mcp_tool-cce077edbd5113 | qa_get_components | server_mcp, local_mcp | apps/api/src/automation.ts:126 | not_run · revalidation required |
| mcp_tool-461ca157a6ba1b | qa_set_component | server_mcp, local_mcp | apps/api/src/automation.ts:127 | not_run · revalidation required |
| mcp_tool-1c47843f2106d8 | qa_set_membership | server_mcp, local_mcp | apps/api/src/automation.ts:128 | not_run · revalidation required |
| mcp_tool-da08f84480167b | qa_create_project | server_mcp, local_mcp | apps/api/src/automation.ts:129 | not_run · revalidation required |
| mcp_tool-c5a96c1d4d0fb5 | qa_update_project | server_mcp, local_mcp | apps/api/src/automation.ts:130 | not_run · revalidation required |
| mcp_tool-dec257152a419d | qa_list_attachments | server_mcp, local_mcp | apps/api/src/automation.ts:131 | not_run · revalidation required |
| mcp_tool-0e917e21bf6968 | qa_materialize_attachment | server_mcp, local_mcp | apps/api/src/automation.ts:132 | passed · revalidation required |
| mcp_tool-d2493ca2891e1e | qa_list_relay_projects | local_mcp | apps/desktop/src/mcp-production.ts:50 | not_run |
| mcp_tool-794cadcbe48b3b | qa_list_relay_tasks | local_mcp | apps/desktop/src/mcp-production.ts:57 | not_run |
| mcp_tool-266ef1843585cd | qa_get_relay_task | local_mcp | apps/desktop/src/mcp-production.ts:69 | not_run |
| mcp_tool-64fe212e6b0561 | qa_create_relay_task | local_mcp | apps/desktop/src/mcp-production.ts:76 | not_run |
| mcp_tool-a0150c0d3f4d8e | qa_start_relay_batch | local_mcp | apps/desktop/src/mcp-production.ts:92 | not_run |
| mcp_tool-6f7fb19c6b682a | qa_continue_relay_task | local_mcp | apps/desktop/src/mcp-production.ts:119 | not_run |
| mcp_tool-63c13c72630847 | qa_relay_task_action | local_mcp | apps/desktop/src/mcp-production.ts:136 | not_run |
| mcp_tool-cdd5d8fb3e5213 | qa_get_relay_batch | local_mcp | apps/desktop/src/mcp-production.ts:161 | not_run |
| mcp_tool-27bc8ce7422afb | qa_retry_relay_batch | local_mcp | apps/desktop/src/mcp-production.ts:168 | not_run |
| mcp_tool-a2c8ac99f2b547 | qa_materialize_relay_attachment | local_mcp | apps/desktop/src/mcp-production.ts:176 | not_run |
| mcp_tool-1fe3404b26c3ec | qa_list_projects | local_mcp | apps/desktop/src/mcp-api.ts:424 | not_run · revalidation required |
| mcp_tool-e0d44a3dc7cdee | qa_list_bugs | local_mcp | apps/desktop/src/mcp-api.ts:431 | not_run · revalidation required |
| mcp_tool-f2b31b8fb5dcf6 | qa_get_bug_context | local_mcp | apps/desktop/src/mcp-api.ts:465 | not_run · revalidation required |
| mcp_tool-7167b44ed53070 | qa_materialize_attachment | local_mcp | apps/desktop/src/mcp-api.ts:478 | not_run · revalidation required |
| mcp_tool-a7c37b4ca62c07 | qa_begin_fix | local_mcp | apps/desktop/src/mcp-api.ts:494 | not_run · revalidation required |
| mcp_tool-db080e0839ef44 | qa_add_comment | local_mcp | apps/desktop/src/mcp-api.ts:510 | not_run · revalidation required |
| mcp_tool-bf279f75b4dc69 | qa_submit_fix | local_mcp | apps/desktop/src/mcp-api.ts:525 | not_run · revalidation required |
| mcp_tool-98ee9a210d7eb1 | qa_resolve_qingyu_bug | local_mcp | apps/desktop/src/mcp-api.ts:551 | not_run · revalidation required |

## required_mcp_parity

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| required_mcp_parity-f2905296d98c41 | qa_list_projects | server_mcp, local_mcp | design v2.1 | not_run |
| required_mcp_parity-33e5812c3ae07e | qa_list_bugs | server_mcp, local_mcp | design v2.1 | not_run |
| required_mcp_parity-3d8dc550dd142f | qa_get_bug_context | server_mcp, local_mcp | design v2.1 | not_run |
| required_mcp_parity-f7b9b4d0bb4a64 | qa_create_bug | server_mcp, local_mcp | design v2.1 | not_run |
| required_mcp_parity-8e2df0da38069c | qa_update_bug | server_mcp, local_mcp | design v2.1 | not_run |
| required_mcp_parity-72162c527ddc6f | qa_begin_fix | server_mcp, local_mcp | design v2.1 | not_run |
| required_mcp_parity-88d8fd079a0c00 | qa_submit_fix | server_mcp, local_mcp | design v2.1 | not_run |
| required_mcp_parity-b045c12e311ef2 | qa_bug_action | server_mcp, local_mcp | design v2.1 | not_run |
| required_mcp_parity-143ccf1b9c2711 | qa_add_comment | server_mcp, local_mcp | design v2.1 | not_run |
| required_mcp_parity-ce4be4b540e23f | qa_upload_attachment | server_mcp, local_mcp | design v2.1 | not_run |
| required_mcp_parity-f50e7633011d12 | qa_bind_attachment | server_mcp, local_mcp | design v2.1 | not_run |
| required_mcp_parity-69e526f958b1fc | qa_materialize_attachment | server_mcp, local_mcp | design v2.1 | passed |
| required_mcp_parity-d33dbd5469c9ff | qa_delete_bug | server_mcp, local_mcp | design v2.1 | not_run |
| required_mcp_parity-969aa7d0a29016 | qa_list_users | server_mcp, local_mcp | design v2.1 | not_run |
| required_mcp_parity-0b1097e88c9932 | qa_manage_user | server_mcp, local_mcp | design v2.1 | not_run |
| required_mcp_parity-2647695dd216fc | qa_list_modules | server_mcp, local_mcp | design v2.1 | not_run |
| required_mcp_parity-4f706f43c97b32 | qa_get_metrics | server_mcp, local_mcp | design v2.1 | not_run |

## state_action

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| state_action-0de2482f00c607 | transitionBug (TransitionBugCommand) | apk, exe, web, http, server_mcp, local_mcp | packages/domain/src/state-machine.ts:314 | not_run |
| state_action-fe8d0050223ddf | markBugDuplicate (MarkBugDuplicateCommand) | apk, exe, web, http, server_mcp, local_mcp | packages/domain/src/state-machine.ts:323 | not_run |
| state_action-9af9b987d2e376 | reopenBug (ReopenBugCommand) | apk, exe, web, http, server_mcp, local_mcp | packages/domain/src/state-machine.ts:329 | not_run |
| state_action-f38ca13c04232e | createRepairAttempt (CreateRepairAttemptCommand) | apk, exe, web, http, server_mcp, local_mcp | packages/domain/src/state-machine.ts:334 | not_run |
| state_action-9b59374ef2e6c2 | startRepairAttempt (StartRepairAttemptCommand) | apk, exe, web, http, server_mcp, local_mcp | packages/domain/src/state-machine.ts:343 | not_run |
| state_action-2f4d145a12ce21 | failRepairAttempt (FailRepairAttemptCommand) | apk, exe, web, http, server_mcp, local_mcp | packages/domain/src/state-machine.ts:348 | not_run |
| state_action-4fe7b8bf6022a0 | supersedeRepairAttempt (SupersedeRepairAttemptCommandBase) | apk, exe, web, http, server_mcp, local_mcp | packages/domain/src/state-machine.ts:354 | not_run |
| state_action-b66753fe5ef4fc | deliverRepairAttempt (DeliveryCommandBase) | apk, exe, web, http, server_mcp, local_mcp | packages/domain/src/state-machine.ts:377 | not_run |
| state_action-176084974f9be6 | linkBuildRepair (LinkBuildRepairCommand) | apk, exe, web, http, server_mcp, local_mcp | packages/domain/src/state-machine.ts:397 | not_run |
| state_action-9a83c04cc9bba4 | createVerification (CreateVerificationCommand) | apk, exe, web, http, server_mcp, local_mcp | packages/domain/src/state-machine.ts:409 | not_run |
| state_action-cd2a54a19d7f9a | startVerification (StartVerificationCommand) | apk, exe, web, http, server_mcp, local_mcp | packages/domain/src/state-machine.ts:418 | not_run |
| state_action-96c71625f1ed42 | recordVerificationResult (RecordVerificationResultCommand) | apk, exe, web, http, server_mcp, local_mcp | packages/domain/src/state-machine.ts:423 | not_run |

## state_transition_pair

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| state_transition_pair-675f987ba034ff | reported → reported | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-245e4987200c0d | reported → needs_info | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-53ac1c18387cf9 | reported → ready | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-ca0032877fff92 | reported → in_progress | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-fba68ef173cda0 | reported → awaiting_build | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-9923a43b3825e0 | reported → ready_for_verification | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-73d0316ec5c202 | reported → closed | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-2335151dbf53df | reported → deferred | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-f173ea703fdb6f | reported → rejected | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-ce0f7798122e8b | reported → duplicate | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-6d557badbdbfe9 | needs_info → reported | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-65e9aaa76f1dec | needs_info → needs_info | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-58023275108bf5 | needs_info → ready | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-e7c53013818591 | needs_info → in_progress | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-6c894420561cc2 | needs_info → awaiting_build | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-06e3b7b30018d3 | needs_info → ready_for_verification | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-ef17421a553a96 | needs_info → closed | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-d89a37dd8a4c87 | needs_info → deferred | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-44cd01e4255cfd | needs_info → rejected | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-43d2275a722bb3 | needs_info → duplicate | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-472f83f99a3867 | ready → reported | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-5f5d2c0e47da9b | ready → needs_info | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-f843023c125c02 | ready → ready | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-3184e19dc57e94 | ready → in_progress | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-513c3ea0bf6cea | ready → awaiting_build | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-4da986978762ca | ready → ready_for_verification | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-28d476fce0ba66 | ready → closed | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-db87bbdfe9670c | ready → deferred | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-fc93702622d505 | ready → rejected | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-7aeab18cd5a331 | ready → duplicate | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-fc0bb084bc2b3f | in_progress → reported | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-838ddac30ad51d | in_progress → needs_info | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-01c60ca1599eb4 | in_progress → ready | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-ce979adf201b7d | in_progress → in_progress | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-786ef865f5042e | in_progress → awaiting_build | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-3397c61633cfe3 | in_progress → ready_for_verification | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-38ecf1d8a9229c | in_progress → closed | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-4e767ec44100ec | in_progress → deferred | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-26aaee99f91ef4 | in_progress → rejected | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-fa26dc10e748e6 | in_progress → duplicate | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-6f4781c6413b1e | awaiting_build → reported | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-0da5f6436d9df4 | awaiting_build → needs_info | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-748f503803d650 | awaiting_build → ready | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-4a323d2468aeb9 | awaiting_build → in_progress | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-ae8d493be9df27 | awaiting_build → awaiting_build | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-a19a545ce49132 | awaiting_build → ready_for_verification | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-adde0491e730ae | awaiting_build → closed | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-ab6b77d0496222 | awaiting_build → deferred | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-bfd03fe4175301 | awaiting_build → rejected | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-13acda8bb760c2 | awaiting_build → duplicate | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-a05140e46930a0 | ready_for_verification → reported | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-e6f7d3ff5fc886 | ready_for_verification → needs_info | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-fc1c378546ebc3 | ready_for_verification → ready | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-79cafe5e2c1312 | ready_for_verification → in_progress | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-26580bf65cbf6c | ready_for_verification → awaiting_build | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-c708f82f8f2eb1 | ready_for_verification → ready_for_verification | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-5f62d2856043fd | ready_for_verification → closed | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-95429ba63cec5b | ready_for_verification → deferred | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-cdb2f0768586df | ready_for_verification → rejected | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-3c71b0fbc93436 | ready_for_verification → duplicate | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-3717c5cc30c0bf | closed → reported | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-dfdd9c276bfc83 | closed → needs_info | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-f74ffa27c3cc2f | closed → ready | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-66f5001a1eab41 | closed → in_progress | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-474b286af2fbee | closed → awaiting_build | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-1d35a3f3005eba | closed → ready_for_verification | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-90f858590f2075 | closed → closed | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-3b5ab28fd3e13c | closed → deferred | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-59b5865b543c7e | closed → rejected | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-2c07745fb59ae8 | closed → duplicate | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-5ce47b400e5893 | deferred → reported | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-34876d519e11cf | deferred → needs_info | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-c618affc8c546f | deferred → ready | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-83da9515abb72e | deferred → in_progress | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-7778afc1be6c4d | deferred → awaiting_build | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-a7b9baa1876025 | deferred → ready_for_verification | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-57e6eba32e55f6 | deferred → closed | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-e05d3620876a01 | deferred → deferred | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-1d371b25478a39 | deferred → rejected | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-8cbd07e23dc3f9 | deferred → duplicate | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-8c44a57d91be15 | rejected → reported | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-d5b1628cb33935 | rejected → needs_info | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-561ce9e29c6c2c | rejected → ready | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-34773bff63017d | rejected → in_progress | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-5659a8701e8046 | rejected → awaiting_build | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-818f318e6796a6 | rejected → ready_for_verification | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-98090cc9cd1a97 | rejected → closed | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-2b304589baa604 | rejected → deferred | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-1d9835075cd8f0 | rejected → rejected | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-f3ea7160518da5 | rejected → duplicate | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-d2b937ae94b3ed | duplicate → reported | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-bcad8713b81180 | duplicate → needs_info | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-3ea9fb666551a6 | duplicate → ready | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-2566f061376693 | duplicate → in_progress | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-ef476af87355d5 | duplicate → awaiting_build | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-e610dc384480fb | duplicate → ready_for_verification | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-0faee594435acc | duplicate → closed | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-c7bc8a3c65a8bb | duplicate → deferred | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-79e693914f2d15 | duplicate → rejected | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |
| state_transition_pair-565f1751217720 | duplicate → duplicate | apk, exe, web, http, server_mcp, local_mcp | design v2.1 | not_run |

## web_control

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| web_control-95f9d3326fa00e | select \| aria-label="切换项目" \| onChange={(event) => onProjectChange?.(event.target.value)} | exe, web | apps/web/src/App.tsx:1926 | not_run · revalidation required |
| web_control-885ee75ff2513f | input \| aria-label="搜索编号、内容或人员" \| placeholder="搜索编号、内容或人员" \| type="search" \| onChange={(event) => setQuery(event.target.value)} | exe, web | apps/web/src/App.tsx:1946 | not_run · revalidation required |
| web_control-be25c9a08ae047 | button \| aria-label="刷新" \| type="button" \| onClick={() => { if (view === "workbench") void loadWorkbench(true); else if (view === "overview") setOverviewRevision((value) => value + 1); else if (view === | exe, web | apps/web/src/App.tsx:1967 | not_run · revalidation required |
| web_control-980a73f6e0b294 | button \| type="button" \| onClick={() => setView("workbench")} | exe, web | apps/web/src/App.tsx:1987 | not_run · revalidation required |
| web_control-54b92ad74c9281 | button \| type="button" \| onClick={() => setView("overview")} | exe, web | apps/web/src/App.tsx:2002 | not_run · revalidation required |
| web_control-bad5b4e49ec43b | button \| type="button" \| onClick={() => setOverviewDate(null)} | exe, web | apps/web/src/App.tsx:2018 | not_run · revalidation required |
| web_control-aaa55ee89b6f74 | input \| aria-label="选择总览日期" \| type="date" \| onChange={(event) => setOverviewDate(event.target.value \|\| null)} | exe, web | apps/web/src/App.tsx:2029 | not_run · revalidation required |
| web_control-74161b40197e7a | button \| type="button" \| onClick={() => setOverviewDate(bucket.date)} | exe, web | apps/web/src/App.tsx:2038 | not_run · revalidation required |
| web_control-f97d75adbc45a2 | button \| type="button" \| onClick={() => setView("production")} | exe, web | apps/web/src/App.tsx:2054 | not_run · revalidation required |
| web_control-f1c46d307b0810 | button \| type="button" \| onClick={() => setView("packaging")} | exe, web | apps/web/src/App.tsx:2070 | not_run · revalidation required |
| web_control-3c41095b88fda6 | button \| type="button" \| onClick={() => setView("upload")} | exe, web | apps/web/src/App.tsx:2086 | not_run · revalidation required |
| web_control-948e3869852d85 | button \| type="button" \| onClick={() => setView("history")} | exe, web | apps/web/src/App.tsx:2097 | not_run · revalidation required |
| web_control-a3fb6f470dcac3 | button \| type="button" \| onClick={() => setView("settings")} | exe, web | apps/web/src/App.tsx:2107 | not_run · revalidation required |
| web_control-6b539c71225c01 | button \| type="button" \| onClick={onSignOut} | exe, web | apps/web/src/App.tsx:2124 | not_run · revalidation required |
| web_control-bc006044c99d18 | button \| 从轻语导入 \| type="button" \| onClick={() => void openQingyuImport()} | exe, web | apps/web/src/App.tsx:2152 | not_run · revalidation required |
| web_control-f91f10e1eca1c0 | button \| 新建 Bug \| type="button" \| onClick={openCreateBug} | exe, web | apps/web/src/App.tsx:2160 | passed · revalidation required |
| web_control-c00d95475a492b | button \| type="button" \| onClick={() => setCategory(value)} | exe, web | apps/web/src/App.tsx:2180 | not_run · revalidation required |
| web_control-72441b1b81752d | select \| onChange={(event) => setScopeId(event.target.value)} | exe, web | apps/web/src/App.tsx:2205 | not_run · revalidation required |
| web_control-9c569a65e0e69a | button \| aria-label="刷新列表" \| type="button" \| onClick={() => void loadWorkbench(true)} | exe, web | apps/web/src/App.tsx:2219 | not_run · revalidation required |
| web_control-1b7cb5ffcb0d8b | button \| role="row" \| type="button" \| onClick={() => openDetail(bug.id)} | exe, web | apps/web/src/App.tsx:2255 | not_run · revalidation required |
| web_control-69db06d8396400 | UserManagementPage \| onChanged={() => void loadWorkbench(true, false)} | exe, web | apps/web/src/App.tsx:2317 | not_run · revalidation required |
| web_control-bd916d886e43c2 | ProjectManagementPage \| onChanged={() => { void loadProjects(); void refreshComponents(); }} | exe, web | apps/web/src/App.tsx:2326 | not_run · revalidation required |
| web_control-475c0351b208c0 | button \| aria-label="关闭详情" \| type="button" \| onClick={closeDetail} | exe, web | apps/web/src/App.tsx:2387 | not_run · revalidation required |
| web_control-475c0351b208c0-2 | button \| aria-label="关闭详情" \| type="button" \| onClick={closeDetail} | exe, web | apps/web/src/App.tsx:2396 | not_run · revalidation required |
| web_control-810154c55c8962 | button \| 重新读取 \| type="button" \| onClick={() => void loadDetail(selectedId)} | exe, web | apps/web/src/App.tsx:2410 | not_run · revalidation required |
| web_control-475c0351b208c0-3 | button \| aria-label="关闭详情" \| type="button" \| onClick={closeDetail} | exe, web | apps/web/src/App.tsx:2430 | not_run · revalidation required |
| web_control-810154c55c8962-2 | button \| 重新读取 \| type="button" \| onClick={() => void loadDetail(selectedId)} | exe, web | apps/web/src/App.tsx:2443 | not_run · revalidation required |
| web_control-28abccce0cb676 | a \| 打开轻语原单 | exe, web | apps/web/src/App.tsx:2463 | not_run · revalidation required |
| web_control-5e264eba3cbe52 | button \| 编辑详情 \| type="button" \| onClick={beginDetailEdit} | exe, web | apps/web/src/App.tsx:2479 | not_run · revalidation required |
| web_control-751aa347a99109 | form \| onSubmit={(event) => void saveBugDetail(event)} | exe, web | apps/web/src/App.tsx:2491 | not_run · revalidation required |
| web_control-e5a8986332427b | input \| onChange={(event) => setDetailDraft((current) => current === null ? current : { ...current, title: event.target.value }, ) } | exe, web | apps/web/src/App.tsx:2499 | not_run · revalidation required |
| web_control-06a335571c0d38 | textarea \| onChange={(event) => setDetailDraft((current) => current === null ? current : { ...current, description: event.target.value }, ) } | exe, web | apps/web/src/App.tsx:2515 | not_run · revalidation required |
| web_control-032b892afc8344 | textarea \| onChange={(event) => setDetailDraft((current) => current === null ? current : { ...current, expectedBehavior: event.target.value }, ) } | exe, web | apps/web/src/App.tsx:2531 | not_run · revalidation required |
| web_control-f218da59574974 | select \| onChange={(event) => setDetailDraft((current) => current === null ? current : { ...current, moduleId: event.target.value \|\| null }, ) } | exe, web | apps/web/src/App.tsx:2548 | not_run · revalidation required |
| web_control-658c4b48a4262b | select \| onChange={(event) => setDetailDraft((current) => current === null ? current : { ...current, severity: event.target.value as BugSeverity, }, ) } | exe, web | apps/web/src/App.tsx:2568 | not_run · revalidation required |
| web_control-af6c542346f6fb | select \| onChange={(event) => setDetailDraft((current) => current === null ? current : { ...current, priority: event.target.value as BugPriority, }, ) } | exe, web | apps/web/src/App.tsx:2588 | not_run · revalidation required |
| web_control-7a276f0124d004 | input \| type="file" \| onChange={(event) => { appendDetailFiles([...(event.target.files ?? [])]); event.currentTarget.value = ""; }} | exe, web | apps/web/src/App.tsx:2609 | not_run · revalidation required |
| web_control-60e8fbf424d0c0 | button \| aria-label={`移除图片 ${preview.file.name}`} \| type="button" \| onClick={() => setDetailNewFiles((current) => current.filter((file) => file !== preview.file), ) } | exe, web | apps/web/src/App.tsx:2630 | not_run · revalidation required |
| web_control-f1a357fbd06aea | button \| aria-label={`查看图片 ${image.filename}`} \| type="button" \| onClick={() => setPreviewImage(image)} | exe, web | apps/web/src/App.tsx:2688 | not_run · revalidation required |
| web_control-ebb2f03e9c5e8b | select \| onChange={(event) => updateAssignmentDraft({ ownerId: event.target.value }) } | exe, web | apps/web/src/App.tsx:2726 | not_run · revalidation required |
| web_control-ead93ac6647318 | select \| onChange={(event) => updateAssignmentDraft({ verifierId: event.target.value }) } | exe, web | apps/web/src/App.tsx:2742 | not_run · revalidation required |
| web_control-7e6499089d0417 | button \| 保存分配 \| type="button" \| onClick={() => void saveAssignments()} | exe, web | apps/web/src/App.tsx:2756 | not_run · revalidation required |
| web_control-f03d2a944dcbdb | summary \| 状态轨迹与处理记录 | exe, web | apps/web/src/App.tsx:2769 | not_run · revalidation required |
| web_control-d7e0b3ee49da01 | form \| onSubmit={(event) => void submitComment(event)} | exe, web | apps/web/src/App.tsx:2794 | not_run · revalidation required |
| web_control-6e6c00c34bb243 | input \| placeholder="补充评论或处理记录" \| onChange={(event) => { commentEditRevision.current += 1; setComment(event.target.value); }} | exe, web | apps/web/src/App.tsx:2798 | not_run · revalidation required |
| web_control-ab03d134d7b16c | button \| 记录 \| type="submit" | exe, web | apps/web/src/App.tsx:2806 | not_run · revalidation required |
| web_control-8596bbc05e99e0 | button \| 确认上次记录 \| type="button" \| onClick={() => void submitComment(undefined, true)} | exe, web | apps/web/src/App.tsx:2813 | not_run · revalidation required |
| web_control-96f068fc8e6d36 | button \| 保留失败记录并提交修改稿 \| type="button" \| onClick={() => void submitComment(undefined, false, commentRejection.id) } | exe, web | apps/web/src/App.tsx:2822 | not_run · revalidation required |
| web_control-728fbc6270f821 | button \| 取消 \| type="button" \| onClick={cancelDetailEdit} | exe, web | apps/web/src/App.tsx:2841 | not_run · revalidation required |
| web_control-45bd403087dfb7 | button \| type="submit" | exe, web | apps/web/src/App.tsx:2849 | not_run · revalidation required |
| web_control-e5db1e6ff8f9b1 | button \| type="button" \| onClick={() => void beginWork()} | exe, web | apps/web/src/App.tsx:2889 | not_run · revalidation required |
| web_control-6dc80ffcd977a7 | button \| 开始处理 \| type="button" \| onClick={() => void runCurrentBugMutation("已开始处理", async () => { await startHumanRepairAttempt( repairAttempt.id, repairAttempt.version, ); }) } | exe, web | apps/web/src/App.tsx:2901 | not_run · revalidation required |
| web_control-99dcec2dedf462 | button \| 人工标记完成 \| type="button" \| onClick={() => void completeWork()} | exe, web | apps/web/src/App.tsx:2918 | passed · revalidation required |
| web_control-a67d137d694a9a | textarea \| placeholder="说明仍可复现的问题和需要调整的地方，可直接 Ctrl+V 粘贴截图" \| onChange={(event) => updateReturnDraft({ reason: event.target.value }) } | exe, web | apps/web/src/App.tsx:2940 | not_run · revalidation required |
| web_control-a133e50bddad70 | input \| 选择截图 \| aria-label="添加打回截图" \| type="file" \| onChange={(event) => { appendReturnImages([...(event.target.files ?? [])]); event.target.value = ""; }} | exe, web | apps/web/src/App.tsx:2955 | not_run · revalidation required |
| web_control-775e258ba54861 | button \| type="button" \| aria-label={`移除打回截图 ${index + 1}`} \| onClick={() => { updateReturnDraft({ files: returnFiles.filter((_, i) => i !== index), }); setReturnImageError(null); }} | exe, web | apps/web/src/App.tsx:2975 | not_run · revalidation required |
| web_control-4dd30b33a2f205 | button \| 验收不通过，打回待处理 \| type="button" \| onClick={() => void returnBug()} | exe, web | apps/web/src/App.tsx:2993 | not_run · revalidation required |
| web_control-2939667dc90757 | button \| 验收通过并关闭 \| type="button" \| onClick={() => void acceptBug()} | exe, web | apps/web/src/App.tsx:3008 | passed · revalidation required |
| web_control-53e5bd938d9ead | button \| 可选：交给 Relay \| type="button" \| onClick={() => void handoffRelay()} | exe, web | apps/web/src/App.tsx:3021 | not_run · revalidation required |
| web_control-cf9a3d4de3be9a | button \| 删除 Bug \| type="button" \| onClick={() => void deleteSelectedBug()} | exe, web | apps/web/src/App.tsx:3042 | not_run · revalidation required |
| web_control-39df3baa08e48f | button \| aria-label="关闭图片预览" \| type="button" \| onClick={() => setPreviewImage(null)} | exe, web | apps/web/src/App.tsx:3061 | not_run · revalidation required |
| web_control-39df3baa08e48f-2 | button \| aria-label="关闭图片预览" \| type="button" \| onClick={() => setPreviewImage(null)} | exe, web | apps/web/src/App.tsx:3068 | not_run · revalidation required |
| web_control-b4609637b96548 | button \| type="button" \| onClick={() => { setQingyuOpen(false); setQingyuSelectedDefectIds([]); }} | exe, web | apps/web/src/App.tsx:3090 | not_run · revalidation required |
| web_control-423d369dfc472c | button \| 断开连接 \| type="button" \| onClick={() => void disconnectQingyu()} | exe, web | apps/web/src/App.tsx:3108 | not_run · revalidation required |
| web_control-2289f5ce00dbe5 | select \| onChange={(event) => { const nextProjectId = event.target.value; setQingyuProjectId(nextProjectId); setQingyuSelectedDefectIds([]); setQingyuBusy(true); setQing | exe, web | apps/web/src/App.tsx:3119 | not_run · revalidation required |
| web_control-35723253c20ea9 | button \| 全选可导入 \| type="button" \| onClick={() => setQingyuSelectedDefectIds(qingyuSelectableDefectIds)} | exe, web | apps/web/src/App.tsx:3151 | not_run · revalidation required |
| web_control-2dc4caf0e9312c | button \| 清空 \| type="button" \| onClick={() => setQingyuSelectedDefectIds([])} | exe, web | apps/web/src/App.tsx:3163 | not_run · revalidation required |
| web_control-caa3fe720bb20c | input \| aria-label={`选择 ${ defect.code === null ? defect.title : `${defect.code} ${defect.title}` }`} \| type="checkbox" \| onChange={(event) => setQingyuSelectedDefectIds((current) => updateQingyuDefectSelection( current, defect.id, event.ta | exe, web | apps/web/src/App.tsx:3187 | not_run · revalidation required |
| web_control-5e9fdff7b3d11e | button \| 取消 \| type="button" \| onClick={() => { setQingyuOpen(false); setQingyuSelectedDefectIds([]); }} | exe, web | apps/web/src/App.tsx:3231 | not_run · revalidation required |
| web_control-fbf7eced81fdba | button \| type="button" \| onClick={() => void importQingyuBugs()} | exe, web | apps/web/src/App.tsx:3241 | not_run · revalidation required |
| web_control-8da9aa06be7bce | button \| 重新生成二维码 \| type="button" \| onClick={() => void restartQingyuLogin()} | exe, web | apps/web/src/App.tsx:3279 | not_run · revalidation required |
| web_control-aad39905b5e347 | form \| onSubmit={(event) => void submitBug(event)} | exe, web | apps/web/src/App.tsx:3295 | not_run · revalidation required |
| web_control-e8feca08204796 | button \| type="button" \| onClick={() => setCreateOpen(false)} | exe, web | apps/web/src/App.tsx:3305 | not_run · revalidation required |
| web_control-ece01e1883ddfe | textarea \| Bug 内容 \| placeholder="描述你看到的问题、复现位置和需要修复的表现" \| onChange={(event) => editCreate(() => setNewContent(event.target.value))} | exe, web | apps/web/src/App.tsx:3311 | not_run · revalidation required |
| web_control-b342f1064552de | select \| onChange={(event) => editCreate(() => setNewSeverity(event.target.value as typeof newSeverity)) } | exe, web | apps/web/src/App.tsx:3325 | not_run · revalidation required |
| web_control-4987057ef98fb5 | select \| onChange={(event) => editCreate(() => setNewOwnerId(event.target.value))} | exe, web | apps/web/src/App.tsx:3338 | not_run · revalidation required |
| web_control-129f7d877b96ec | select \| onChange={(event) => editCreate(() => setNewVerifierId(event.target.value))} | exe, web | apps/web/src/App.tsx:3352 | not_run · revalidation required |
| web_control-c1ff9dcae86f29 | input \| 截图 / 标注图 \| type="file" \| onChange={(event) => { appendNewFiles([...(event.target.files ?? [])]); event.currentTarget.value = ""; }} | exe, web | apps/web/src/App.tsx:3366 | not_run · revalidation required |
| web_control-d2f6c76293a818 | button \| aria-label={`移除图片 ${preview.file.name}`} \| type="button" \| onClick={() => editCreate(() => setNewFiles((current) => current.filter((file) => file !== preview.file)), ) } | exe, web | apps/web/src/App.tsx:3387 | not_run · revalidation required |
| web_control-fb2f4bee4e9575 | button \| 确认上次提交 \| type="button" \| onClick={() => void submitBug(undefined, true)} | exe, web | apps/web/src/App.tsx:3404 | not_run · revalidation required |
| web_control-f59fc9cda1c3d9 | button \| 保留失败记录并提交修改稿 \| type="button" \| onClick={() => void submitBug(undefined, false, bugRejection.id)} | exe, web | apps/web/src/App.tsx:3413 | not_run · revalidation required |
| web_control-c4fd54c43ea557 | button \| 取消 \| type="button" \| onClick={() => setCreateOpen(false)} | exe, web | apps/web/src/App.tsx:3421 | not_run · revalidation required |
| web_control-45bd403087dfb7-2 | button \| type="submit" | exe, web | apps/web/src/App.tsx:3428 | not_run · revalidation required |
| web_control-330e6002f6f64a | button \| 返回登录 \| onClick={onSignOut} | exe, web | apps/web/src/AuthGate.tsx:91 | not_run |
| web_control-e22ca926ec6ff3 | button \| 重试 \| onClick={() => void checkSession()} | exe, web | apps/web/src/AuthGate.tsx:278 | not_run |
| web_control-93e075c744ef7f | form \| onSubmit={(event) => void submit(event)} | exe, web | apps/web/src/AuthGate.tsx:294 | not_run |
| web_control-72b79526807793 | input \| type="password" \| onChange={(event) => setPassword(event.target.value)} | exe, web | apps/web/src/AuthGate.tsx:298 | not_run |
| web_control-5a1009efb3f6cd | input \| placeholder="使用 GM 提供的项目入口" \| onChange={(event) => { entryRevision.current++; setProjectInput(event.target.value); setProjectName(""); }} \| onBlur={() => void verifyEntry()} | exe, web | apps/web/src/AuthGate.tsx:310 | not_run |
| web_control-d278e6d8db5196 | input \| placeholder="输入姓名" \| onChange={(event) => setName(event.target.value)} | exe, web | apps/web/src/AuthGate.tsx:323 | not_run |
| web_control-8fe345e6789b29 | button \| type="submit" | exe, web | apps/web/src/AuthGate.tsx:338 | not_run |
| web_control-e6750bade110ad | button \| type="button" \| onClick={() => { setGm((value) => !value); setMessage(""); setPassword(""); }} | exe, web | apps/web/src/AuthGate.tsx:342 | not_run |
| web_control-ca8b20a7d614e0 | button \| 退出 GM \| onClick={() => void signOut()} | exe, web | apps/web/src/AuthGate.tsx:359 | not_run |
| web_control-d0f57beaa02cf3 | a \| 下载本次产物 | exe, web | apps/web/src/BuildTasksPanel.tsx:106 | not_run |
| web_control-722b81ce0c3c81 | button \| 恢复此任务 \| onClick={() => void act(task, "resume")} | exe, web | apps/web/src/BuildTasksPanel.tsx:114 | not_run |
| web_control-6f31298457f192 | button \| 取消此任务 \| onClick={() => void act(task, "cancel")} | exe, web | apps/web/src/BuildTasksPanel.tsx:123 | not_run |
| web_control-bc79ec442278df | button \| type="button" \| onClick={() => void toggle()} | exe, web | apps/web/src/BuildUploadControls.tsx:180 | not_run |
| web_control-ada9a17d522181 | button \| 仅打包 \| type="button" \| onClick={() => { setOpen(false); onBuildOnly(); }} | exe, web | apps/web/src/BuildUploadControls.tsx:199 | not_run |
| web_control-7921bfc88a84ba | button \| type="button" \| onClick={() => void combined()} | exe, web | apps/web/src/BuildUploadControls.tsx:209 | not_run |
| web_control-601f5213e03149 | button \| 修改上传设置 / 登录账号 \| type="button" \| onClick={() => { setOpen(false); onOpenUpload(); }} | exe, web | apps/web/src/BuildUploadControls.tsx:241 | not_run |
| web_control-7257541cb9b140 | button \| 查看上传进度 \| type="button" \| onClick={() => onOpenUpload(latest.uploadJobId ?? undefined)} | exe, web | apps/web/src/BuildUploadControls.tsx:268 | not_run |
| web_control-58d9cf0fefeee3 | button \| 取消自动上传（保留打包） \| type="button" \| onClick={() => void cancel(latest.id)} | exe, web | apps/web/src/BuildUploadControls.tsx:272 | not_run |
| web_control-8a3b34ff107d57 | button \| 刷新组件历史 \| onClick={() => { setHeld(false); setNotice(""); void load(); }} | exe, web | apps/web/src/ComponentHistoryPage.tsx:161 | not_run |
| web_control-f4dc2e5d163f53 | button \| 确认恢复这一条交接 \| onClick={() => void confirmResumeOutbox()} | exe, web | apps/web/src/ComponentHistoryPage.tsx:193 | not_run |
| web_control-bb1dc03a1665f6 | button \| 保留暂停 \| onClick={() => setConfirmOutbox(null)} | exe, web | apps/web/src/ComponentHistoryPage.tsx:203 | not_run |
| web_control-7937d84afb3fce | button \| 保存任务日志 \| onClick={() => void serverUploader.openFolder(job.id)} | exe, web | apps/web/src/ComponentHistoryPage.tsx:226 | not_run · revalidation required |
| web_control-2136f0d736ea56 | button \| 恢复此上传 \| onClick={() => void resume("jobs", job.id)} | exe, web | apps/web/src/ComponentHistoryPage.tsx:233 | not_run · revalidation required |
| web_control-0572191be0c0cf | button \| 恢复此打包上传 \| onClick={() => void resume("build-chains", chain.id)} | exe, web | apps/web/src/ComponentHistoryPage.tsx:267 | not_run · revalidation required |
| web_control-ad70025c96afec | button \| 恢复此制作任务 \| onClick={() => void resumeRelay(item.id)} | exe, web | apps/web/src/ComponentHistoryPage.tsx:299 | not_run · revalidation required |
| web_control-4ec04c126edca5 | button \| type="button" \| onClick={onOpenUsers} | exe, web | apps/web/src/DesktopTools.tsx:182 | not_run |
| web_control-17c0bd3f49d350 | button \| type="button" \| onClick={() => openPanel("mcp")} | exe, web | apps/web/src/DesktopTools.tsx:197 | not_run |
| web_control-89b11f218940ed | button \| type="button" \| onClick={() => openPanel("status")} | exe, web | apps/web/src/DesktopTools.tsx:216 | not_run |
| web_control-c1b565edf3159f | dialog \| onClick={(event) => { if (event.target === event.currentTarget) setPanel(null); }} | exe, web | apps/web/src/DesktopTools.tsx:234 | not_run |
| web_control-d8c9e3cca2e2dc | button \| aria-label="关闭设置" \| type="button" \| onClick={() => setPanel(null)} | exe, web | apps/web/src/DesktopTools.tsx:249 | not_run |
| web_control-b6b0a5d38f516c | button \| 复制配置 \| type="button" \| onClick={() => void copy(configText, "配置")} | exe, web | apps/web/src/DesktopTools.tsx:279 | not_run |
| web_control-976f9e50e88ba3 | button \| 复制连接地址 \| type="button" \| onClick={() => void copy(mcp?.url ?? "", "连接地址")} | exe, web | apps/web/src/DesktopTools.tsx:292 | not_run |
| web_control-28b52b86f79915 | button \| type="button" \| onClick={() => void runUpdate()} | exe, web | apps/web/src/DesktopTools.tsx:354 | not_run |
| web_control-a877f032415e33 | button \| 重新检查 \| type="button" \| onClick={() => void bridge.checkForUpdate()} | exe, web | apps/web/src/DesktopUpdateNotice.tsx:42 | not_run |
| web_control-3fe72706b06ecb | button \| 安装并重启 \| type="button" \| onClick={() => void bridge.installUpdate()} | exe, web | apps/web/src/DesktopUpdateNotice.tsx:69 | not_run |
| web_control-c9d136d392d2e8 | button \| type="button" \| aria-label="最小化" \| title="最小化" \| onClick={() => void windowAction("minimize")} | exe, web | apps/web/src/DesktopWindow.tsx:52 | not_run |
| web_control-7ce28559e6e09a | button \| type="button" \| aria-label={square ? "还原窗口" : "最大化"} \| title={square ? "还原窗口" : "最大化"} \| onClick={() => void windowAction("toggle-maximize")} | exe, web | apps/web/src/DesktopWindow.tsx:61 | not_run |
| web_control-840f0479703ae7 | button \| type="button" \| aria-label="关闭窗口" \| title="关闭窗口，继续在托盘运行" \| onClick={() => void windowAction("close")} | exe, web | apps/web/src/DesktopWindow.tsx:71 | not_run |
| web_control-70b2bf2c0a92e3 | a \| 打开或保存 Poco 原图 | exe, web | apps/web/src/EvidencePanel.tsx:417 | not_run |
| web_control-0219a00822f822 | a \| 打开或保存原图 | exe, web | apps/web/src/EvidencePanel.tsx:453 | not_run |
| web_control-f0f2373c6e868d | button \| 重新读取 \| type="button" \| onClick={() => void retry(entry)} | exe, web | apps/web/src/EvidencePanel.tsx:457 | not_run |
| web_control-67632c2f6cf5a3 | button \| 保存草稿文本 \| onClick={exportText} | exe, web | apps/web/src/LocalDraftRecovery.tsx:53 | not_run |
| web_control-f51dc906e2efb7 | a \| 保存 | exe, web | apps/web/src/LocalDraftRecovery.tsx:58 | not_run |
| web_control-eb2ba900feed68 | form \| onSubmit={(event) => { event.preventDefault(); void load(projectId, fromDate, toDate); }} | exe, web | apps/web/src/MetricsPanel.tsx:88 | not_run |
| web_control-0a54297df798d2 | input \| 新 Bug 起始（UTC） \| type="date" \| onChange={(event) => setFromDate(event.target.value)} | exe, web | apps/web/src/MetricsPanel.tsx:97 | not_run |
| web_control-ad68003cca3b39 | input \| 截止、不含当日（UTC） \| type="date" \| onChange={(event) => setToDate(event.target.value)} | exe, web | apps/web/src/MetricsPanel.tsx:106 | not_run |
| web_control-99af58b2093545 | button \| 重新计算 \| type="submit" | exe, web | apps/web/src/MetricsPanel.tsx:113 | not_run |
| web_control-5ccfc2a39a8b43 | button \| 新建 Bug \| type="button" \| onClick={onCreateBug} | exe, web | apps/web/src/OverviewPage.tsx:507 | not_run |
| web_control-37e3c3574b7793 | input \| placeholder="编号、问题内容或行为" \| type="search" \| onChange={(event) => setQuery(event.target.value)} | exe, web | apps/web/src/OverviewPage.tsx:522 | not_run |
| web_control-693ee3934a02ef | select \| onChange={(event) => setOwnerFilter(event.target.value as OwnerFilter)} | exe, web | apps/web/src/OverviewPage.tsx:531 | not_run |
| web_control-5a455fe014523d | select \| onChange={(event) => setStateGroup(event.target.value as StateGroup)} | exe, web | apps/web/src/OverviewPage.tsx:547 | not_run |
| web_control-27864816b28e68 | select \| onChange={(event) => setSeverity(event.target.value as typeof severity)} | exe, web | apps/web/src/OverviewPage.tsx:560 | not_run |
| web_control-b3fe193d07be16 | select \| onChange={(event) => setSortMode(event.target.value as SortMode)} | exe, web | apps/web/src/OverviewPage.tsx:574 | not_run |
| web_control-9f5c8174a8c168 | button \| 未分配 \| type="button" \| onClick={() => setOwnerFilter(ownerFilter === "unassigned" ? "all" : "unassigned")} | exe, web | apps/web/src/OverviewPage.tsx:583 | not_run |
| web_control-3c11f744ff2525 | button \| aria-label="刷新总览" \| type="button" \| onClick={() => void load(true)} | exe, web | apps/web/src/OverviewPage.tsx:591 | not_run |
| web_control-9e6e111d8883b8 | button \| aria-label={`拖拽调整${column.label}列宽`} \| title={`拖拽调整${column.label}列宽`} \| type="button" \| onKeyDown={(event) => resizeColumnWithKeyboard(event, columnIndex)} \| onPointerDown={(event) => beginColumnResize(event, columnIndex)} | exe, web | apps/web/src/OverviewPage.tsx:616 | not_run |
| web_control-36808b515051d9 | select \| aria-label={`设置 ${bug.key} 优先级`} \| title="点击编号设置 P0-P3 优先级" \| onChange={(event) => void setPriority(bug, event.target.value as BugPriority)} | exe, web | apps/web/src/OverviewPage.tsx:657 | not_run |
| web_control-2b94c6c8b15798 | button \| type="button" \| onClick={() => onOpenBug(bug.id)} | exe, web | apps/web/src/OverviewPage.tsx:673 | not_run |
| web_control-95913981b4b5ab | button \| 认领 \| type="button" \| onClick={() => void assignOwner(bug, principal.userId)} | exe, web | apps/web/src/OverviewPage.tsx:678 | not_run |
| web_control-1a66d8acf8b5cd | select \| aria-label={`设置 ${bug.key} 负责人`} \| onChange={(event) => void assignOwner(bug, event.target.value \|\| null)} | exe, web | apps/web/src/OverviewPage.tsx:687 | not_run |
| web_control-b4a31b4b12789d | button \| 认领 \| type="button" \| onClick={() => void assignVerificationOwner(bug, principal.userId)} | exe, web | apps/web/src/OverviewPage.tsx:703 | not_run |
| web_control-e10dac28f61928 | select \| aria-label={`设置 ${bug.key} 关闭人`} \| onChange={(event) => void assignVerificationOwner(bug, event.target.value)} | exe, web | apps/web/src/OverviewPage.tsx:712 | not_run |
| web_control-807a6115369af3 | a \| 下载 | exe, web | apps/web/src/PackagingPage.tsx:72 | not_run · revalidation required |
| web_control-9d4147909750c2 | summary \| 二维码 | exe, web | apps/web/src/PackagingPage.tsx:76 | not_run · revalidation required |
| web_control-d57a0c42a94cd3 | a \| 快速下载 | exe, web | apps/web/src/PackagingPage.tsx:112 | not_run · revalidation required |
| web_control-a20618c5b33a78 | summary \| 更早的 APK（ ） | exe, web | apps/web/src/PackagingPage.tsx:150 | not_run · revalidation required |
| web_control-10955be7a2ad76 | a \| 下载增量 ZIP | exe, web | apps/web/src/PackagingPage.tsx:169 | not_run · revalidation required |
| web_control-2b1003fbc475d2 | a | exe, web | apps/web/src/PackagingPage.tsx:198 | not_run · revalidation required |
| web_control-4bc017d8651a0e | BuildUploadControls \| onSubmitted={(queueId) => { monitor.watch(queueId); void refresh(); }} | exe, web | apps/web/src/PackagingPage.tsx:325 | not_run · revalidation required |
| web_control-e17932ec98f801 | button \| type="button" \| onClick={() => void build(id)} | exe, web | apps/web/src/PackagingPage.tsx:339 | not_run · revalidation required |
| web_control-fc74e2c5abbc3a | summary \| 历史构建与阶段耗时（ ） | exe, web | apps/web/src/PackagingProgress.tsx:294 | not_run |
| web_control-ec27548980c26d | summary | exe, web | apps/web/src/PackagingProgress.tsx:302 | not_run |
| web_control-5f709f827208dd | summary \| 查看截断后的调用栈 | exe, web | apps/web/src/PocoContextPanel.tsx:117 | not_run |
| web_control-182d51830b8b96 | summary \| Poco 详情（截图时游戏上下文） | exe, web | apps/web/src/PocoContextPanel.tsx:128 | not_run |
| web_control-4dddaebf980f5c | summary | exe, web | apps/web/src/PocoContextPanel.tsx:229 | not_run |
| web_control-d7b8b707a542d1 | summary \| 原始采集信息 | exe, web | apps/web/src/PocoContextPanel.tsx:297 | not_run |
| web_control-0d100dada8d0a7 | div \| onDrop={(event) => { event.preventDefault(); add(Array.from(event.dataTransfer.files)); }} | exe, web | apps/web/src/ProductionPage.tsx:148 | not_run |
| web_control-73003e0a17bdef | input \| 附件 \| type="file" \| onChange={(event) => { add(Array.from(event.target.files ?? [])); event.target.value = ""; }} | exe, web | apps/web/src/ProductionPage.tsx:165 | not_run |
| web_control-feb66f1c1e084e | button \| 移除 \| type="button" \| onClick={() => onChange(files.filter((_, i) => i !== index))} | exe, web | apps/web/src/ProductionPage.tsx:181 | not_run |
| web_control-9590aa1081e752 | input \| type="checkbox" \| onChange={(event) => { const current = selected ?? files.map((f) => f.attachmentId); onSelect( event.target.checked ? [...current, file.attachmentId] : current. | exe, web | apps/web/src/ProductionPage.tsx:222 | not_run |
| web_control-3c69328e17220c | button \| 刷新 \| type="button" \| onClick={() => void refresh()} | exe, web | apps/web/src/ProductionPage.tsx:507 | not_run |
| web_control-24bfd3b8f2164c | button \| 新建 / 批量制作 \| type="button" \| onClick={() => setCreating(true)} | exe, web | apps/web/src/ProductionPage.tsx:510 | not_run |
| web_control-32f554308afb96 | button \| type="button" \| aria-label="关闭提示" \| onClick={() => setNotice("")} | exe, web | apps/web/src/ProductionPage.tsx:523 | not_run |
| web_control-eb0e06e26d2180 | button \| 核对上次提交 \| type="button" \| onClick={() => void mutate(`pending:${body.requestId}`, () => submit(body))} | exe, web | apps/web/src/ProductionPage.tsx:531 | not_run |
| web_control-360dd42fc4b1a4 | input \| aria-label="搜索制作任务" \| placeholder="搜索单号或标题" \| onChange={(event) => setSearch(event.target.value)} | exe, web | apps/web/src/ProductionPage.tsx:541 | not_run |
| web_control-5fa88d40e0814d | select \| aria-label="任务进展筛选" \| onChange={(event) => setState(event.target.value)} | exe, web | apps/web/src/ProductionPage.tsx:547 | not_run |
| web_control-809557bdfb0c3d | select \| aria-label="提出人筛选" \| onChange={(event) => setPerson(event.target.value)} | exe, web | apps/web/src/ProductionPage.tsx:562 | not_run |
| web_control-080c098e4fd0f2 | button \| 停止 \| type="button" \| onClick={() => setConfirmation({ tasks: selection, action: "cancel" })} | exe, web | apps/web/src/ProductionPage.tsx:577 | not_run |
| web_control-9e08508fc0ef6b | button \| 重试 \| type="button" \| onClick={() => void runAction(selection, "retry")} | exe, web | apps/web/src/ProductionPage.tsx:583 | not_run |
| web_control-4ddd82f072c14a | button \| 结束制作 \| type="button" \| onClick={() => setConfirmation({ tasks: selection, action: "finish" })} | exe, web | apps/web/src/ProductionPage.tsx:586 | not_run |
| web_control-365bcd3dd3a8ac | button \| 清空选择 \| type="button" \| onClick={() => setChecked([])} | exe, web | apps/web/src/ProductionPage.tsx:592 | not_run |
| web_control-a8f2174bea96fe | input \| type="checkbox" \| aria-label="选择当前列表" \| onChange={(event) => setChecked(event.target.checked ? visible.map((t) => t.id) : []) } | exe, web | apps/web/src/ProductionPage.tsx:603 | not_run |
| web_control-e88ad297fb704a | input \| type="checkbox" \| aria-label={`选择任务 ${task.number}`} \| onChange={(event) => setChecked((current) => event.target.checked ? [...current, task.id] : current.filter((id) => id !== task.id), ) } | exe, web | apps/web/src/ProductionPage.tsx:621 | not_run |
| web_control-66218d4a2fb6da | button \| type="button" \| onClick={() => void openTask(task.id)} | exe, web | apps/web/src/ProductionPage.tsx:635 | not_run |
| web_control-08a86f68fb6e00 | button \| 关闭详情 \| type="button" \| onClick={() => { selectedRef.current = null; setSelectedId(null); setDetail(null); }} | exe, web | apps/web/src/ProductionPage.tsx:677 | not_run |
| web_control-f62a21a8d78e73 | button \| 打开关联 Bug / 验收 / 填写打回理由 \| type="button" \| onClick={() => { if (detail.task.bugId) onOpenBug(detail.task.bugId); }} | exe, web | apps/web/src/ProductionPage.tsx:696 | not_run |
| web_control-e43a3e4829ec49 | button \| 停止当前制作 \| type="button" \| onClick={() => setConfirmation({ tasks: [detail.task], action: "cancel" })} | exe, web | apps/web/src/ProductionPage.tsx:715 | not_run |
| web_control-bb08fe394b39f3 | button \| 重试 \| type="button" \| onClick={() => void runAction([detail.task], "retry")} | exe, web | apps/web/src/ProductionPage.tsx:722 | not_run |
| web_control-336c90f4539609 | button \| 重新打开 \| type="button" \| onClick={() => void runAction([detail.task], "reopen")} | exe, web | apps/web/src/ProductionPage.tsx:730 | not_run |
| web_control-f9433cffe0f493 | button \| 结束制作 \| type="button" \| onClick={() => setConfirmation({ tasks: [detail.task], action: "finish" })} | exe, web | apps/web/src/ProductionPage.tsx:738 | not_run |
| web_control-6f04befd0f098e | button \| 合并并完成 \| type="button" \| onClick={() => setConfirmation({ tasks: [detail.task], action: "merge" })} | exe, web | apps/web/src/ProductionPage.tsx:746 | not_run |
| web_control-b1aeb715bce2f2 | form \| onSubmit={(event) => { event.preventDefault(); void runAction([detail.task], "continue"); }} | exe, web | apps/web/src/ProductionPage.tsx:754 | not_run |
| web_control-b42fb724fda92c | textarea \| placeholder="说明要继续修改的内容，沿用当前任务与分支" \| onChange={(event) => { setMessage(event.target.value); try { localStorage.setItem(continuationKey, event.target.value); } catch { /* Preserve in memory. */ } }} | exe, web | apps/web/src/ProductionPage.tsx:762 | not_run |
| web_control-9e56176563d371 | summary \| 选择 Bug 附件（新附件可在关联 Bug 中添加） | exe, web | apps/web/src/ProductionPage.tsx:780 | not_run |
| web_control-b4093c680c9306 | FilePicker \| onChange={setContinueFiles} | exe, web | apps/web/src/ProductionPage.tsx:794 | not_run |
| web_control-9adbc68c3d2f28 | button \| type="submit" | exe, web | apps/web/src/ProductionPage.tsx:796 | not_run |
| web_control-8700bf5f483ce7 | summary \| 第 轮 · | exe, web | apps/web/src/ProductionPage.tsx:811 | not_run |
| web_control-9522e92be4c260 | button \| type="button" \| onClick={() => void mutate(`download:${file.id}`, () => downloadProductionFile(projectId, file), ) } | exe, web | apps/web/src/ProductionPage.tsx:819 | not_run |
| web_control-c0265a25bf09f3 | summary \| 构建与交付 | exe, web | apps/web/src/ProductionPage.tsx:841 | not_run |
| web_control-0b3163fe9420e8 | summary \| 进度记录 | exe, web | apps/web/src/ProductionPage.tsx:851 | not_run |
| web_control-63cc9ed919ccc0 | summary \| · · 张 · | exe, web | apps/web/src/ProductionPage.tsx:874 | not_run |
| web_control-7ca8292f53609c | button \| 查看 \| type="button" \| onClick={() => void openTask(task.id)} | exe, web | apps/web/src/ProductionPage.tsx:914 | not_run |
| web_control-f1de20039fc233 | button \| 重试失败项 \| type="button" \| onClick={() => void mutate(`retry:${batch.id}`, async () => { await productionRetry(batch.id, projectId); await refresh(); }) } | exe, web | apps/web/src/ProductionPage.tsx:923 | not_run |
| web_control-70a22870e69aed | button \| 收起 · 保留草稿 \| type="button" \| onClick={() => setCreating(false)} | exe, web | apps/web/src/ProductionPage.tsx:953 | not_run |
| web_control-82b5bf829d0daf | form \| onSubmit={(event) => { event.preventDefault(); void create(); }} | exe, web | apps/web/src/ProductionPage.tsx:957 | not_run |
| web_control-f6486ec5a827f2 | button \| 新建需求 \| type="button" \| onClick={() => setDraft((current) => ({ ...current, mode: "create" }))} | exe, web | apps/web/src/ProductionPage.tsx:964 | not_run |
| web_control-380d39203d29fe | button \| 从 QA Bug 批量制作 \| type="button" \| onClick={() => setDraft((current) => ({ ...current, mode: "bugs" }))} | exe, web | apps/web/src/ProductionPage.tsx:971 | not_run |
| web_control-7d168595ad35c9 | input \| 标题 \| placeholder="简要描述需要制作或修复的内容" \| onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value })) } | exe, web | apps/web/src/ProductionPage.tsx:988 | not_run |
| web_control-0c4c2735654fd7 | textarea \| 需求与验收要求 \| placeholder="描述问题、复现步骤、期望行为和验收要求" \| onChange={(event) => setDraft((current) => ({ ...current, message: event.target.value })) } | exe, web | apps/web/src/ProductionPage.tsx:1000 | not_run |
| web_control-4aafcf6647d9fa | FilePicker \| onChange={setFiles} | exe, web | apps/web/src/ProductionPage.tsx:1011 | not_run |
| web_control-e0a61b96cb51b7 | input \| aria-label="搜索待制作 Bug" \| placeholder="搜索 Bug 单号或标题" \| onChange={(event) => setBugSearch(event.target.value)} | exe, web | apps/web/src/ProductionPage.tsx:1022 | not_run |
| web_control-c1bbceae3801b4 | select \| aria-label="Bug 负责人筛选" \| onChange={(event) => setBugOwner(event.target.value)} | exe, web | apps/web/src/ProductionPage.tsx:1028 | not_run |
| web_control-ee1be3c6f07804 | button \| 从轻语导入 \| type="button" \| onClick={() => { setCreating(false); onImport(); }} | exe, web | apps/web/src/ProductionPage.tsx:1041 | not_run |
| web_control-13b2ea22f9582e | button \| 选择筛选结果 \| type="button" \| onClick={() => setDraft((current) => ({ ...current, bugIds: bugChoices.slice(0, 50).map((bug) => bug.id), })) } | exe, web | apps/web/src/ProductionPage.tsx:1054 | not_run |
| web_control-a64a2f8183de0d | button \| 清空 \| type="button" \| onClick={() => setDraft((current) => ({ ...current, bugIds: [] }))} | exe, web | apps/web/src/ProductionPage.tsx:1065 | not_run |
| web_control-9655ce4d276bbb | input \| type="checkbox" \| onChange={(event) => setDraft((current) => ({ ...current, bugIds: event.target.checked ? [...current.bugIds, bug.id] : current.bugIds.filter((id) => id !== bug. | exe, web | apps/web/src/ProductionPage.tsx:1079 | not_run |
| web_control-a2d15161c83be4 | button \| 详情 / 补充附件 \| type="button" \| onClick={() => { setCreating(false); onOpenBug(bug.id); }} | exe, web | apps/web/src/ProductionPage.tsx:1107 | not_run |
| web_control-a1c91afcfbbf6c | summary \| 补充要求与选择附件 | exe, web | apps/web/src/ProductionPage.tsx:1119 | not_run |
| web_control-1a16a75f3e6a4b | textarea \| placeholder="此 Bug 的额外制作说明（可选）" \| onChange={(event) => setDraft((current) => ({ ...current, extra: { ...current.extra, [bug.id]: event.target.value }, })) } | exe, web | apps/web/src/ProductionPage.tsx:1120 | not_run |
| web_control-3d2e9643643fe6 | summary \| 高级设置 · / | exe, web | apps/web/src/ProductionPage.tsx:1151 | not_run |
| web_control-0d62c85999b48b | select \| onChange={(event) => setDraft((current) => ({ ...current, execution: { ...current.execution, codexModel: event.target.value, codexReasoningEffort: "xhigh", }, } | exe, web | apps/web/src/ProductionPage.tsx:1157 | not_run |
| web_control-294328ec4b2391 | select \| onChange={(event) => setDraft((current) => ({ ...current, execution: { ...current.execution, codexReasoningEffort: event.target.value, }, })) } | exe, web | apps/web/src/ProductionPage.tsx:1179 | not_run |
| web_control-19b6d22e84c1c1 | select \| onChange={(event) => setDraft((current) => ({ ...current, execution: { ...current.execution, executionProfile: event.target.value }, })) } | exe, web | apps/web/src/ProductionPage.tsx:1198 | not_run |
| web_control-6e4503f4d95e49 | input \| 优先级 \| type="number" \| onChange={(event) => setDraft((current) => ({ ...current, execution: { ...current.execution, priority: Number(event.target.value) }, })) } | exe, web | apps/web/src/ProductionPage.tsx:1214 | not_run |
| web_control-ed889b2d69742b | input \| 快速模式 \| type="checkbox" \| onChange={(event) => setDraft((current) => ({ ...current, execution: { ...current.execution, codexFastMode: event.target.checked }, })) } | exe, web | apps/web/src/ProductionPage.tsx:1228 | not_run |
| web_control-0048489faf784c | input \| 完成后保留制作现场 \| type="checkbox" \| onChange={(event) => setDraft((current) => ({ ...current, execution: { ...current.execution, autoRelease: !event.target.checked }, })) } | exe, web | apps/web/src/ProductionPage.tsx:1241 | not_run |
| web_control-299a6b008a3260 | textarea \| 统一补充要求 \| onChange={(event) => setDraft((current) => ({ ...current, execution: { ...current.execution, extraPrompt: event.target.value }, })) } | exe, web | apps/web/src/ProductionPage.tsx:1256 | not_run |
| web_control-9adbc68c3d2f28-2 | button \| type="submit" | exe, web | apps/web/src/ProductionPage.tsx:1271 | not_run |
| web_control-95f1d2cf328c11 | button \| 取消 \| type="button" \| onClick={() => setConfirmation(null)} | exe, web | apps/web/src/ProductionPage.tsx:1322 | not_run |
| web_control-9681f4bf9121eb | button \| 确认 \| type="button" \| onClick={() => void runAction( confirmation.tasks, confirmation.action, confirmation.action === "merge", ) } | exe, web | apps/web/src/ProductionPage.tsx:1325 | not_run |
| web_control-4314d425019907 | form \| onSubmit={(event) => void save(event)} | exe, web | apps/web/src/ProjectManagementPage.tsx:99 | not_run · revalidation required |
| web_control-19500da7b7df89 | input \| 为此项目启用 \| type="checkbox" \| onChange={(event) => setEnabled(event.target.checked)} | exe, web | apps/web/src/ProjectManagementPage.tsx:107 | not_run · revalidation required |
| web_control-85b9322ec8e8a3 | input \| onChange={(event) => setConfig((current) => ({ ...current, [field.key]: event.target.value })) } | exe, web | apps/web/src/ProjectManagementPage.tsx:120 | not_run · revalidation required |
| web_control-002462fc972bfb | textarea \| onChange={(event) => setObjectJson(event.target.value)} | exe, web | apps/web/src/ProjectManagementPage.tsx:132 | not_run · revalidation required |
| web_control-d72b5425978f77 | button \| type="submit" | exe, web | apps/web/src/ProjectManagementPage.tsx:153 | not_run · revalidation required |
| web_control-1e96c47ddc6c9b | button \| 刷新 \| onClick={() => void refresh().catch((cause) => setError(errorMessage(cause)))} | exe, web | apps/web/src/ProjectManagementPage.tsx:233 | not_run · revalidation required |
| web_control-7ef46456c429a3 | form \| onSubmit={(event) => { event.preventDefault(); void mutate(async () => { const created = await saveProject({ key: key.trim(), name: name.trim() }); setKey(""); | exe, web | apps/web/src/ProjectManagementPage.tsx:250 | not_run · revalidation required |
| web_control-4ebb878c0c0a5e | input \| 项目名称 \| onChange={(event) => setName(event.target.value)} | exe, web | apps/web/src/ProjectManagementPage.tsx:265 | not_run · revalidation required |
| web_control-b0d0cb3d60a3c2 | input \| 入口短码 \| placeholder="例如 QADEMO" \| title="2–16 位大写字母或数字，以字母开头" \| onChange={(event) => setKey(event.target.value.toUpperCase())} | exe, web | apps/web/src/ProjectManagementPage.tsx:274 | not_run · revalidation required |
| web_control-dbb4f8f84dbe89 | button \| 创建项目 | exe, web | apps/web/src/ProjectManagementPage.tsx:285 | not_run · revalidation required |
| web_control-c0b8b6c0d8eabf | select \| onChange={(event) => { setSelected(event.target.value); setComponents([]); setUsers([]); }} | exe, web | apps/web/src/ProjectManagementPage.tsx:291 | not_run · revalidation required |
| web_control-4999dc87fab90c | button \| 进入此项目 \| onClick={() => onSelectProject(current.id)} | exe, web | apps/web/src/ProjectManagementPage.tsx:316 | not_run · revalidation required |
| web_control-e5a8f3d4860eeb | button \| 修改名称 \| onClick={() => { const value = window.prompt("项目名称", current.name); if (value?.trim()) void mutate( () => updateProject(current, { name: value.trim() }), "项目名称已 | exe, web | apps/web/src/ProjectManagementPage.tsx:323 | not_run · revalidation required |
| web_control-e1b80d83a62a6f | button \| onClick={() => void mutate( () => updateProject(current, { active: !current.active }), current.active ? "项目已停用，历史保留。" : "项目已恢复。", ) } | exe, web | apps/web/src/ProjectManagementPage.tsx:337 | not_run · revalidation required |
| web_control-e39f61d572963c | form \| onSubmit={(event) => { event.preventDefault(); void mutate( () => saveMembership(selected, memberId.trim(), true, 0, true), "人员已加入项目。", ); }} | exe, web | apps/web/src/ProjectManagementPage.tsx:374 | not_run · revalidation required |
| web_control-cbff2e32a1ced9 | input \| 已有人员 ID \| placeholder="稳定人员 ID" \| onChange={(event) => setMemberId(event.target.value)} | exe, web | apps/web/src/ProjectManagementPage.tsx:385 | not_run · revalidation required |
| web_control-2da487e1d6d670 | button \| 加入项目 | exe, web | apps/web/src/ProjectManagementPage.tsx:392 | not_run · revalidation required |
| web_control-5fbd4a03daee4a | button \| onClick={() => void mutate( () => saveMembership( selected, user.userId, user.membershipStatus !== "active", user.membershipVersion ?? 1, true, ), "项目人员关系已保存。", | exe, web | apps/web/src/ProjectManagementPage.tsx:404 | not_run · revalidation required |
| web_control-625a820cc8f520 | button \| 恢复此交接 \| onClick={() => onResume(item)} | exe, web | apps/web/src/RelayOutboxPanel.tsx:68 | not_run |
| web_control-3afafa531e48fa | summary \| 文件与版本结果 | exe, web | apps/web/src/UploadIncrementPage.tsx:134 | not_run |
| web_control-97882b7a8b8bf3 | summary \| 最近处理记录 | exe, web | apps/web/src/UploadIncrementPage.tsx:155 | not_run |
| web_control-ae25019397ff62 | summary | exe, web | apps/web/src/UploadIncrementPage.tsx:374 | not_run |
| web_control-56717d33c33383 | form \| onSubmit={login} | exe, web | apps/web/src/UploadIncrementPage.tsx:385 | not_run |
| web_control-ddd302412476c2 | select \| onChange={(event) => setKind(event.target.value as "email" \| "subaccount")} | exe, web | apps/web/src/UploadIncrementPage.tsx:388 | not_run |
| web_control-dd464a6bad482a | input \| 账号 \| placeholder={snapshot?.account \|\| "输入平台账号"} \| onChange={(event) => setAccount(event.target.value)} | exe, web | apps/web/src/UploadIncrementPage.tsx:399 | not_run |
| web_control-407ed6d30f2f1e | input \| 密码 \| type="password" \| onChange={(event) => setPassword(event.target.value)} | exe, web | apps/web/src/UploadIncrementPage.tsx:411 | not_run |
| web_control-b166cca3261121 | button \| type="submit" | exe, web | apps/web/src/UploadIncrementPage.tsx:421 | not_run |
| web_control-c211b56658cd60 | button \| type="button" \| onClick={() => void action("check", async () => { unwrap(await bridge.checkAuth()); setNotice("登录检查通过，当前账号可以访问上传文件服务。"); }) } | exe, web | apps/web/src/UploadIncrementPage.tsx:428 | not_run |
| web_control-43e5c7ad07833a | button \| 退出平台账号 \| type="button" \| onClick={() => void action("logout", async () => { unwrap(await bridge.logout()); setNotice("已清除当前用户的服务端平台登录配置。"); }) } | exe, web | apps/web/src/UploadIncrementPage.tsx:440 | not_run |
| web_control-bac9d7b8cb9bfa | summary \| 查看取包地址 | exe, web | apps/web/src/UploadIncrementPage.tsx:473 | not_run |
| web_control-b86f05f0fac3f9 | form \| onSubmit={(event) => { event.preventDefault(); setReview(true); }} | exe, web | apps/web/src/UploadIncrementPage.tsx:478 | not_run |
| web_control-f6ef7c7044850a | input \| 版本号 \| placeholder="自动使用下一个版本" \| onChange={(event) => setField("version", event.target.value)} | exe, web | apps/web/src/UploadIncrementPage.tsx:488 | not_run |
| web_control-703d6722be2b6e | input \| 平台测试人 ID \| type="number" \| onChange={(event) => setField("testerId", Number(event.target.value))} | exe, web | apps/web/src/UploadIncrementPage.tsx:502 | not_run |
| web_control-66c3fc9de51a14 | input \| type="radio" \| name="upload-mode" \| onChange={() => setField("mode", mode.id)} | exe, web | apps/web/src/UploadIncrementPage.tsx:516 | not_run |
| web_control-590c0a5f6b0721 | button \| type="button" \| onClick={start} | exe, web | apps/web/src/UploadIncrementPage.tsx:547 | not_run |
| web_control-9add53e8db522d | button \| 返回修改 \| type="button" \| onClick={() => setReview(false)} | exe, web | apps/web/src/UploadIncrementPage.tsx:555 | not_run |
| web_control-9d063e93617a57 | button \| 检查并提交上传 \| type="submit" | exe, web | apps/web/src/UploadIncrementPage.tsx:560 | not_run |
| web_control-cf3d3579554d05 | button \| type="button" \| onClick={confirmPublish} | exe, web | apps/web/src/UploadIncrementPage.tsx:579 | not_run |
| web_control-41722f4ea96a21 | button \| 取消排队 \| type="button" \| onClick={() => void action("cancel", async () => { if (bridge.cancel) unwrap(await bridge.cancel(job.id)); }) } | exe, web | apps/web/src/UploadIncrementPage.tsx:595 | not_run |
| web_control-44924ea3108806 | input \| 平台测试人 ID \| type="number" \| onChange={(event) => setTestDrafts((drafts) => ({ ...drafts, [job.id]: { ...testDraft, testerId: Number(event.target.value) }, })) } | exe, web | apps/web/src/UploadIncrementPage.tsx:624 | not_run |
| web_control-e50929c0835755 | textarea \| 实际测试结论引用 \| onChange={(event) => setTestDrafts((drafts) => ({ ...drafts, [job.id]: { ...testDraft, testResultReference: event.target.value }, })) } | exe, web | apps/web/src/UploadIncrementPage.tsx:641 | not_run |
| web_control-ef8db1f76d71c6 | button \| type="button" \| onClick={resume} | exe, web | apps/web/src/UploadIncrementPage.tsx:661 | not_run |
| web_control-ceb2f01b857098 | button \| type="button" \| onClick={() => setSelectedId(item.id)} | exe, web | apps/web/src/UploadIncrementPage.tsx:685 | not_run |
| web_control-366b717d53c357 | button \| 下载服务端记录 \| type="button" \| onClick={() => void action("folder", async () => { unwrap(await bridge.openFolder(item.id)); }) } | exe, web | apps/web/src/UploadIncrementPage.tsx:703 | not_run |
| web_control-45aa9656847d66 | input \| placeholder="搜索用户名或用户 ID" \| type="search" \| onChange={(event) => setQuery(event.target.value)} | exe, web | apps/web/src/UserManagementPage.tsx:163 | not_run |
| web_control-6d8e13a0b5288b | select \| aria-label={`选择 ${user.displayName} 的主用户`} \| onChange={(event) => setTargets((currentTargets) => ({ ...currentTargets, [user.userId]: event.target.value, })) } | exe, web | apps/web/src/UserManagementPage.tsx:257 | not_run |
| web_control-8bbad9f431a583 | button \| 取消关联 \| title={protectedReason ?? undefined} \| type="button" \| onClick={() => void mutate( `unlink:${user.userId}`, () => unlinkManagedProjectUser(projectId, user.userId), `${user.displayName} 的关联已取消。`, ) } | exe, web | apps/web/src/UserManagementPage.tsx:279 | not_run |
| web_control-7a2ede0c1969d9 | button \| 确认关联 \| title={protectedReason ?? undefined} \| type="button" \| onClick={() => { const target = users.find((item) => item.userId === selectedTarget); if (target === undefined) return; if ( !globalThis.confirm( `将“${user.disp | exe, web | apps/web/src/UserManagementPage.tsx:295 | not_run |
| web_control-09dc23bb07f270 | button \| type="button" \| onClick={() => { if ( !globalThis.confirm( `停用“${user.displayName}”？其当前项目资格会被停用，其他项目不受影响， ${user.taskCount} 个历史任务引用会保留。`, ) ) return; void mutate( `disable:${us | exe, web | apps/web/src/UserManagementPage.tsx:321 | not_run |
| web_control-44096fd8d5a180 | button \| 恢复资格 \| type="button" \| onClick={() => void mutate( `restore:${user.userId}`, () => saveMembership( projectId, user.userId, true, user.membershipVersion ?? 1, ), `${user.displayName} 的 | exe, web | apps/web/src/UserManagementPage.tsx:351 | not_run |

## web_page_component

| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| web_page_component-65a7bf287b539a | App | exe, web | apps/web/src/App.tsx:468 | not_run · revalidation required |
| web_page_component-df47344b6f9e65 | AppIcon | exe, web | apps/web/src/AppIcon.tsx:99 | not_run |
| web_page_component-ccf63510e1b8db | ProjectWorkspace | exe, web | apps/web/src/AuthGate.tsx:27 | not_run |
| web_page_component-501369889e1d65 | AuthGate | exe, web | apps/web/src/AuthGate.tsx:116 | not_run |
| web_page_component-c99b476689e3a2 | BuildTasksPanel | exe, web | apps/web/src/BuildTasksPanel.tsx:29 | not_run |
| web_page_component-b86dbf5060f62a | BuildUploadControls | exe, web | apps/web/src/BuildUploadControls.tsx:45 | not_run |
| web_page_component-ee39d48add5c65 | ComponentHistoryPage | exe, web | apps/web/src/ComponentHistoryPage.tsx:28 | not_run · revalidation required |
| web_page_component-a52379c174bd7b | ConnectionLight | exe, web | apps/web/src/DesktopTools.tsx:92 | not_run |
| web_page_component-f8da047b576967 | DesktopTools | exe, web | apps/web/src/DesktopTools.tsx:104 | not_run |
| web_page_component-1ed3d115994539 | DesktopUpdateNotice | exe, web | apps/web/src/DesktopUpdateNotice.tsx:7 | not_run |
| web_page_component-126eac985f8f61 | DesktopWindow | exe, web | apps/web/src/DesktopWindow.tsx:5 | not_run |
| web_page_component-0da858d1b17cb9 | EvidencePanel | exe, web | apps/web/src/EvidencePanel.tsx:67 | not_run |
| web_page_component-fb692eae67853f | LocalDraftRecovery | exe, web | apps/web/src/LocalDraftRecovery.tsx:10 | not_run |
| web_page_component-a67d167ba6defa | MetricsPanel | exe, web | apps/web/src/MetricsPanel.tsx:28 | not_run |
| web_page_component-52a4b1d559a67b | OverviewPage | exe, web | apps/web/src/OverviewPage.tsx:195 | not_run |
| web_page_component-4906a7fa07deaa | PackageDownloads | exe, web | apps/web/src/PackagingPage.tsx:48 | not_run · revalidation required |
| web_page_component-0fd6674b4ea3af | PackagingPage | exe, web | apps/web/src/PackagingPage.tsx:219 | not_run · revalidation required |
| web_page_component-415da66ac4380a | ProgressMeter | exe, web | apps/web/src/PackagingProgress.tsx:30 | not_run |
| web_page_component-935a81fdc9a424 | BuildStages | exe, web | apps/web/src/PackagingProgress.tsx:60 | not_run |
| web_page_component-859830f67b35ce | BuildHeading | exe, web | apps/web/src/PackagingProgress.tsx:145 | not_run |
| web_page_component-e8c4b4c3e81958 | PackagingProgressPanel | exe, web | apps/web/src/PackagingProgress.tsx:173 | not_run |
| web_page_component-88839237f37756 | UiTreeNode | exe, web | apps/web/src/PocoContextPanel.tsx:68 | not_run |
| web_page_component-513f9926e1be60 | ErrorEntry | exe, web | apps/web/src/PocoContextPanel.tsx:103 | not_run |
| web_page_component-338ada74df5b82 | PocoContextPanel | exe, web | apps/web/src/PocoContextPanel.tsx:125 | not_run |
| web_page_component-92d0f4ad802f4d | ResultText | exe, web | apps/web/src/ProductionPage.tsx:97 | not_run |
| web_page_component-e3aabdfbfaaa91 | FilePicker | exe, web | apps/web/src/ProductionPage.tsx:133 | not_run |
| web_page_component-e9937e247fc8b0 | BugAttachments | exe, web | apps/web/src/ProductionPage.tsx:190 | not_run |
| web_page_component-69dad7ba8ebc74 | ProductionPage | exe, web | apps/web/src/ProductionPage.tsx:242 | not_run |
| web_page_component-4d97a7ae4db14d | ComponentEditor | exe, web | apps/web/src/ProjectManagementPage.tsx:54 | not_run · revalidation required |
| web_page_component-96139f283a4505 | ProjectManagementPage | exe, web | apps/web/src/ProjectManagementPage.tsx:160 | not_run · revalidation required |
| web_page_component-c05382e3c819c8 | RelayOutboxPanel | exe, web | apps/web/src/RelayOutboxPanel.tsx:11 | not_run |
| web_page_component-ab97b3680b2c1c | JobProgress | exe, web | apps/web/src/UploadIncrementPage.tsx:37 | not_run |
| web_page_component-d871920e786982 | UploadIncrementPage | exe, web | apps/web/src/UploadIncrementPage.tsx:176 | not_run |
| web_page_component-d5fe20a38f7f11 | UserManagementPage | exe, web | apps/web/src/UserManagementPage.tsx:45 | not_run |
