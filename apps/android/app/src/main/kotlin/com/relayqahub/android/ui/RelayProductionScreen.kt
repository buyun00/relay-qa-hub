package com.relayqahub.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.relayqahub.android.network.*
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Local durable records stay readable while the optional executor is disabled. */
@Composable
fun RelayProductionScreen(client: ProjectOperationsClient, project: QaProject, token: String,
    component: ProjectComponent, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val ready = component.enabled && component.status == "ready"
    var source by rememberSaveable(project.id, token) { mutableStateOf(RelayRecordSource.BATCHES) }
    var records by remember(project.id, token) { mutableStateOf(emptyList<RelayRecord>()) }
    var busy by remember(project.id, token) { mutableStateOf(false) }
    var error by remember(project.id, token) { mutableStateOf<String?>(null) }
    var message by remember(project.id, token) { mutableStateOf<String?>(null) }
    var detail by remember(project.id, token) { mutableStateOf<JSONObject?>(null) }
    var title by rememberSaveable(project.id, token) { mutableStateOf("") }
    var description by rememberSaveable(project.id, token) { mutableStateOf("") }
    var mergeCandidate by remember(project.id, token) { mutableStateOf<RelayRecord?>(null) }
    var mergeConfirmed by remember(project.id, token) { mutableStateOf(false) }

    suspend fun reload(selected: RelayRecordSource = source) {
        records = if (selected == RelayRecordSource.TASKS && !ready) emptyList() else
            RelayOperations.records(client.relay(RelayOperations.list(project.id, selected), token).toString(), project.id, selected)
    }
    fun operate(operation: RelayOperation, nextSource: RelayRecordSource = source) {
        if (busy) return
        busy = true; error = null
        scope.launch {
            try {
                check(operation.projectId == project.id) { "PROJECT_MISMATCH" }
                val receipt = client.relay(operation, token)
                if (operation.method == "GET") detail = receipt else {
                    detail = receipt
                    message = "请求已处理，请核对回读状态；排队或已投递不代表任务完成。"
                    if (source == nextSource) reload() else source = nextSource
                }
            } catch (failure: Exception) { error = failure.message ?: "RELAY_REQUEST_FAILED" }
            finally { busy = false }
        }
    }
    fun prepareMerge(record: RelayRecord) {
        if (busy || !ready) return
        busy = true; error = null
        scope.launch {
            try {
                // Confirmation is bound to this freshly read task and timestamp.
                val current = client.relay(RelayOperations.detail(record), token)
                mergeCandidate = RelayOperations.taskDetail(current.toString(), project.id, record.id)
                mergeConfirmed = false
            } catch (failure: Exception) { error = failure.message ?: "RELAY_REQUEST_FAILED" }
            finally { busy = false }
        }
    }
    LaunchedEffect(project.id, token, source, ready) {
        busy = true; error = null; records = emptyList(); detail = null
        try { reload() } catch (failure: Exception) { error = failure.message } finally { busy = false }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = onBack) { Text("返回项目") }
            TextButton(enabled = !busy, onClick = {
                busy = true; error = null
                scope.launch { try { reload() } catch (failure: Exception) { error = failure.message } finally { busy = false } }
            }) { Text("刷新") }
        }
        Text(component.displayName, style = MaterialTheme.typography.headlineSmall)
        Text(project.name)
        if (!ready) Text(if (component.enabled) "连接待配置；本地批次和投递记录仍可查看。" else "组件已停用；本地批次和投递记录保留，恢复按钮暂不可用。")
        Text("恢复使用记录原有的项目和配置版本。导入保护开启时，服务端会拒绝执行，重新开启组件也不会自动恢复暂停项。", style = MaterialTheme.typography.bodySmall)
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let { Text("请求失败：$it", color = MaterialTheme.colorScheme.error) }
        message?.let { Text(it) }
        Row(Modifier.fillMaxWidth()) {
            RelayRecordSource.entries.forEach { selected ->
                TextButton(enabled = !busy, onClick = { source = selected }, modifier = Modifier.weight(1f)) {
                    Text((if (source == selected) "✓ " else "") + selected.label)
                }
            }
        }
        if (source == RelayRecordSource.TASKS) {
            if (!ready) Text("组件恢复可用后，可读取远端任务。") else {
                OutlinedTextField(title, { title = it }, label = { Text("新任务标题") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(description, { description = it }, label = { Text("制作要求 / 继续说明") }, modifier = Modifier.fillMaxWidth())
                Button(enabled = !busy && title.isNotBlank() && title.length <= 200 && description.isNotBlank() && description.length <= 20_000, onClick = {
                    operate(RelayOperations.create(project.id, title, description), RelayRecordSource.BATCHES)
                }) { Text("创建制作任务") }
            }
        }
        if (!busy && records.isEmpty()) Text("当前项目暂无${source.label}。")
        records.forEach { record ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(record.title, style = MaterialTheme.typography.titleMedium)
                    Text("编号：${record.id}")
                    Text("状态：${componentStatus(record.state)}")
                    Text(record.componentVersion?.let { "原组件配置版本：$it" } ?: "配置版本由服务端原任务记录或当前连接判定。")
                    record.updatedAt?.let { Text("更新时间：$it") }
                    if (record.summary.isNotBlank()) Text(record.summary)
                    if (record.source != RelayRecordSource.OUTBOX) TextButton(enabled = !busy, onClick = {
                        operate(RelayOperations.detail(record))
                    }) { Text(if (record.source == RelayRecordSource.BATCHES) "查看批次结果" else "查看任务") }
                    if (record.canResume) TextButton(enabled = ready && !busy, onClick = {
                        operate(RelayOperations.resume(record, ready))
                    }) { Text(if (record.source == RelayRecordSource.OUTBOX) "恢复此条投递" else "按原配置恢复 / 重试批次") }
                    if (record.source == RelayRecordSource.TASKS) {
                        val actions = listOf("continue" to "继续", "cancel" to "停止", "retry" to "重试", "reopen" to "重新打开", "finish" to "结束")
                        actions.chunked(3).forEach { row -> Row(Modifier.fillMaxWidth()) {
                            row.forEach { (action, label) ->
                                TextButton(enabled = ready && !busy && record.updatedAt != null && (action != "continue" || (description.isNotBlank() && description.length <= 20_000)), onClick = {
                                    operate(RelayOperations.action(record, action, ready, description), RelayRecordSource.BATCHES)
                                }, modifier = Modifier.weight(1f)) { Text(label) }
                            }
                        } }
                        TextButton(enabled = ready && !busy, onClick = { prepareMerge(record) }) { Text("合并…") }
                    }
                }
            }
        }
        detail?.let { value ->
            HorizontalDivider()
            Text("服务端详情", style = MaterialTheme.typography.titleMedium)
            ComponentRecord(value.optJSONObject("task") ?: value)
            val rows = value.optJSONArray("items") ?: value.optJSONObject("result")?.optJSONArray("items")
            if (rows != null) for (index in 0 until rows.length()) rows.optJSONObject(index)?.let { ComponentRecord(it) }
        }
    }
    mergeCandidate?.let { selected ->
        AlertDialog(onDismissRequest = { mergeCandidate = null; mergeConfirmed = false },
            title = { Text("确认合并仓库") },
            text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("项目：${project.name}\n任务：${selected.title}\n编号：${selected.id}\n版本时间：${selected.updatedAt ?: "未返回"}")
                Text("这会请求合并仓库并处理关联缺陷。Bug 仍需按人工验收流程核对，合并不代表验收关闭。")
                Row { Checkbox(mergeConfirmed, { mergeConfirmed = it }); Text("我确认合并此任务并处理关联缺陷") }
            } },
            confirmButton = { TextButton(enabled = mergeConfirmed && ready && !busy && selected.updatedAt != null, onClick = {
                val command = RelayOperations.action(selected, "merge", ready, confirmMerge = mergeConfirmed)
                mergeCandidate = null; mergeConfirmed = false
                operate(command, RelayRecordSource.BATCHES)
            }) { Text("确认合并") } },
            dismissButton = { TextButton(onClick = { mergeCandidate = null; mergeConfirmed = false }) { Text("取消") } })
    }
}
