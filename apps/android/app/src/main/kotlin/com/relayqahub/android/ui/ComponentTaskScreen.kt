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
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Native controls call the same existing component endpoints as Web/EXE. */
@Composable
fun ComponentTaskScreen(client: ProjectOperationsClient, project: QaProject, token: String,
    component: ProjectComponent, onBack: () -> Unit) {
    if (component.key == "relay.production") {
        RelayProductionScreen(client, project, token, component, onBack)
        return
    }
    val scope = rememberCoroutineScope()
    var response by remember(project.id, component.key) { mutableStateOf<JSONObject?>(null) }
    var error by remember(project.id, component.key) { mutableStateOf<String?>(null) }
    var busy by remember(project.id, component.key) { mutableStateOf(false) }
    var title by rememberSaveable(project.id, component.key) { mutableStateOf("") }
    var description by rememberSaveable(project.id, component.key) { mutableStateOf("") }
    var version by rememberSaveable(project.id, component.key) { mutableStateOf("") }
    var productId by rememberSaveable(project.id, component.key) { mutableStateOf("") }
    var channelId by rememberSaveable(project.id, component.key) { mutableStateOf("") }
    var targetName by rememberSaveable(project.id, component.key) { mutableStateOf("") }
    var testerId by rememberSaveable(project.id, component.key) { mutableStateOf("") }
    var testReference by rememberSaveable(project.id, component.key) { mutableStateOf("") }
    var preset by rememberSaveable(project.id, component.key) { mutableStateOf("internal-nosdk") }
    var message by remember(project.id, component.key) { mutableStateOf<String?>(null) }
    var detail by remember(project.id, component.key) { mutableStateOf<JSONObject?>(null) }
    val enabled = component.enabled && component.status == "ready"
    val path = when (component.key) {
        "build" -> "packaging"
        "build_upload.single" -> "increment-upload/build-chains"
        "upload.incremental" -> "increment-upload"
        "relay.production" -> if (enabled) "production/tasks?projectId=${project.id}" else "production/tasks/history?projectId=${project.id}"
        "qingyu.sync" -> "integrations/qingyu/session?projectId=${project.id}"
        else -> null
    }
    suspend fun reload() { if (path != null) response = client.request(path, token) }
    fun execute(operation: suspend () -> JSONObject) {
        if (busy) return
        busy = true; error = null
        scope.launch {
            try {
                val receipt = operation()
                message = when {
                    receipt.optString("value").matches(Regex("[a-fA-F0-9-]{36}")) -> "任务 ${receipt.optString("value")}：已排队，请刷新核对最终结果。"
                    receipt.has("taskId") -> "任务 ${receipt.optString("taskId")}：${componentStatus(receipt.optString("state", receipt.optString("status", "queued")))}，请核对任务最终结果。"
                    receipt.has("queueId") && !receipt.isNull("queueId") -> "已提交队列 ${receipt.optString("queueId")}，最终结果请刷新核对。"
                    receipt.has("id") -> "任务 ${receipt.optString("id")}：${componentStatus(receipt.optString("status", "已登记"))}"
                    else -> "已提交，请核对刷新后的实际状态。"
                }
                reload()
            } catch (failure: Exception) { error = failure.message ?: "COMPONENT_REQUEST_FAILED" }
            finally { busy = false }
        }
    }
    LaunchedEffect(project.id, component.key) {
        busy = true
        try { reload() } catch (failure: Exception) { error = failure.message } finally { busy = false }
    }
    fun uploadInput() = JSONObject().put("productId", productId).put("channelId", channelId)
        .put("belongName", targetName).put("version", version).put("summary", title)
        .put("description", description).put("mode", "prepare_publish")
        .put("testerId", testerId.toInt()).put("testResultReference", testReference)
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = onBack) { Text("返回项目") }
            TextButton(onClick = { execute { reload(); JSONObject() } }, enabled = !busy) { Text("刷新") }
        }
        Text(component.displayName, style = MaterialTheme.typography.headlineSmall)
        Text(project.name)
        if (!enabled) Text(if (component.enabled) "待配置独立连接；新任务暂不可用。" else "组件已停用，保留历史与产物。")
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let { Text("请求失败：$it", color = MaterialTheme.colorScheme.error) }
        message?.let { Text(it) }
        if (enabled && component.key == "build") {
            Text("打包方案", style = MaterialTheme.typography.titleMedium)
            listOf("internal-nosdk" to "内网，不接 SDK", "internal-sdk" to "内网，接入 SDK", "external" to "外网").forEach { (id, name) ->
                TextButton(onClick = { preset = id }) { Text((if (preset == id) "✓ " else "") + name) }
            }
            Button(enabled = !busy, onClick = { execute { client.request("packaging/builds", token, "POST", JSONObject().put("preset", preset)) } }) { Text("开始打包") }
        }
        if (enabled && component.key in listOf("build_upload.single", "upload.incremental")) {
            Text("上传目标", style = MaterialTheme.typography.titleMedium)
            ComponentField("产品 ID", productId) { productId = it }
            ComponentField("渠道 ID", channelId) { channelId = it }
            ComponentField("目标名称", targetName) { targetName = it }
            ComponentField("版本", version) { version = it }
            ComponentField("摘要", title) { title = it }
            ComponentField("说明", description) { description = it }
            ComponentField("测试人员 ID", testerId) { testerId = it }
            ComponentField("测试结果参考", testReference) { testReference = it }
            Text("源产物由当前项目服务端配置，提交后在任务中核对来源与目标。", style = MaterialTheme.typography.bodySmall)
            Button(enabled = !busy && listOf(productId, channelId, targetName, version, title, description).all(String::isNotBlank) && testerId.toIntOrNull() != null,
                onClick = { execute {
                    if (component.key == "build_upload.single") client.request("increment-upload/build-chains", token, "POST", JSONObject().put("upload", uploadInput()))
                    else client.request("increment-upload/jobs", token, "POST", uploadInput())
                } }) { Text(if (component.key == "build_upload.single") "打包并上传一次" else "上传已有产物") }
        }
        if (enabled && component.key == "relay.production") {
            ComponentField("任务标题", title) { title = it }
            ComponentField("制作要求 / 继续说明", description) { description = it }
            Button(enabled = !busy && title.isNotBlank() && description.isNotBlank(), onClick = { execute {
                client.request("production/batches", token, "POST", JSONObject().put("projectId", project.id)
                    .put("requestId", UUID.randomUUID().toString()).put("kind", "create")
                    .put("items", JSONArray().put(JSONObject().put("title", title).put("message", description).put("uploadIds", JSONArray()))))
            } }) { Text("创建制作任务") }
        }
        response?.let { data ->
            if (component.key == "build") {
                Text("当前项目打包任务", style = MaterialTheme.typography.titleMedium)
                val tasks = data.optJSONArray("tasks") ?: JSONArray()
                if (tasks.length() == 0) Text("当前项目暂无打包任务。")
                for (index in 0 until tasks.length()) {
                    val task = tasks.optJSONObject(index) ?: continue
                    val id = task.optString("taskId", task.optString("id"))
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp)) {
                            ComponentRecord(task)
                            if (id.isNotBlank()) {
                                TextButton(enabled = !busy, onClick = { execute {
                                    client.request("packaging/tasks/$id", token).also { detail = it }
                                } }) { Text("查看最新结果") }
                                if (task.optString("state") in listOf("queued", "paused")) TextButton(enabled = !busy,
                                    onClick = { execute { client.request("packaging/tasks/$id/cancel", token, "POST", JSONObject()) } }) { Text("取消排队") }
                                if (enabled && task.optString("state") == "paused") TextButton(enabled = !busy,
                                    onClick = { execute { client.request("packaging/tasks/$id/resume", token, "POST", JSONObject()) } }) { Text("恢复此任务") }
                            }
                        }
                    }
                }
                data.optString("jenkinsError").takeUnless { it.isBlank() || it == "null" }?.let { Text("打包服务：$it") }
                data.optJSONObject("jenkins")?.let { jenkins ->
                    ComponentRecords(jenkins.optJSONArray("builds"))
                    ComponentRecords(jenkins.optJSONArray("queue"))
                }
                Text("Android 产物", style = MaterialTheme.typography.titleMedium)
                ComponentRecords(data.optJSONArray("apks"))
                Text("iOS 产物", style = MaterialTheme.typography.titleMedium)
                ComponentRecords(data.optJSONArray("ipas"))
            } else if (component.key == "qingyu.sync") {
                Text(if (data.optBoolean("connected") || data.optBoolean("authenticated")) "第三方会话已连接" else "第三方会话未连接")
                // Connection credentials and project mappings are maintained in project settings.
                Text("订单连接按当前项目配置，状态同步失败不会阻止 Bug 人工完成。")
            } else {
                val records = data.optJSONArray("items") ?: data.optJSONArray("jobs") ?: JSONArray()
                for (index in 0 until records.length()) {
                    val item = records.optJSONObject(index) ?: continue
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            ComponentRecord(item)
                            val id = item.optString("id")
                            if (id.isNotBlank()) {
                                if (component.key == "relay.production") {
                                    TextButton(onClick = { execute { client.request("production/${if (enabled) "tasks" else "batches"}/$id?projectId=${project.id}", token).also { detail = it } } }, enabled = !busy) { Text(if (enabled) "查看任务" else "查看历史批次") }
                                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                        listOf("continue" to "继续", "cancel" to "停止", "retry" to "重试", "reopen" to "重新打开", "finish" to "结束").forEach { (action, label) ->
                                            TextButton(enabled = enabled && !busy && (action != "continue" || description.isNotBlank()), onClick = { execute {
                                                val input = JSONObject().put("taskId", id).put("expectedUpdatedAt", item.getString("updatedAt"))
                                                    .put("action", action).put("confirmMerge", false)
                                                if (action == "continue") input.put("message", description).put("uploadIds", JSONArray()).put("selectedAttachmentIds", JSONArray())
                                                client.request("production/batches", token, "POST", JSONObject().put("projectId", project.id)
                                                    .put("requestId", UUID.randomUUID().toString()).put("kind", "action").put("items", JSONArray().put(input)))
                                            } }) { Text(label) }
                                        }
                                    }
                                } else {
                                    val jobBase = if (component.key == "build_upload.single") "increment-upload/build-chains" else "increment-upload/jobs"
                                    if (item.optBoolean("canManage", true)) TextButton(enabled = !busy, onClick = { execute { client.request("$jobBase/$id/cancel", token, "POST", JSONObject()) } }) { Text("取消排队 / 停止") }
                                    if (enabled && item.optBoolean("canManage", true) && item.optString("status") == "paused") {
                                        val resume = if (component.key == "build_upload.single") "resume" else "resume-queued"
                                        TextButton(enabled = !busy, onClick = { execute { client.request("$jobBase/$id/$resume", token, "POST", JSONObject()) } }) { Text("恢复此任务") }
                                    }
                                    if (component.key == "upload.incremental") {
                                        TextButton(enabled = !busy, onClick = { execute { client.request("$jobBase/$id/logs", token).also { detail = it } } }) { Text("任务日志") }
                                        if (enabled && item.optString("status") in listOf("failed", "interrupted", "awaiting_test")) {
                                            TextButton(enabled = !busy && testerId.toIntOrNull() != null, onClick = { execute {
                                                client.request("$jobBase/$id/resume", token, "POST", JSONObject().put("testerId", testerId.toInt()).put("testResultReference", testReference))
                                            } }) { Text("恢复 / 重试") }
                                        }
                                        if (enabled && item.optString("status") == "awaiting_publish") TextButton(enabled = !busy, onClick = { execute { client.request("$jobBase/$id/confirm-publish", token, "POST", JSONObject()) } }) { Text("确认发布到当前目标") }
                                    }
                                }
                            }
                        }
                    }
                }
                if (records.length() == 0) Text("当前项目暂无任务。")
            }
        }
        detail?.let { record ->
            HorizontalDivider()
            Text("任务详情", style = MaterialTheme.typography.titleMedium)
            ComponentRecord(record.optJSONObject("task") ?: record)
            ComponentRecords(record.optJSONArray("events") ?: record.optJSONArray("items"))
            record.optString("logs").takeIf(String::isNotBlank)?.let { Text(it) }
        }
    }
}

@Composable
private fun ComponentField(label: String, value: String, onChange: (String) -> Unit) {
    OutlinedTextField(value, onChange, label = { Text(label) }, modifier = Modifier.fillMaxWidth())
}
@Composable
private fun ComponentRecords(records: JSONArray?) {
    if (records == null || records.length() == 0) Text("暂无记录")
    else for (index in 0 until records.length()) records.optJSONObject(index)?.let { item ->
        Card(Modifier.fillMaxWidth().padding(vertical = 4.dp)) { Column(Modifier.padding(10.dp)) { ComponentRecord(item) } }
    }
}
@Composable
internal fun ComponentRecord(item: JSONObject) {
    val labels = linkedMapOf("title" to "任务", "name" to "文件", "id" to "编号", "taskId" to "任务编号", "number" to "构建", "status" to "状态", "state" to "状态",
        "componentVersion" to "组件配置版本", "preset" to "方案",
        "stage" to "阶段", "version" to "版本", "queueId" to "队列", "buildNumber" to "构建", "reason" to "说明",
        "errorCode" to "错误", "sha256" to "SHA-256", "size" to "字节数", "url" to "产物地址", "sourceUrl" to "来源",
        "updatedAt" to "更新时间", "modifiedAt" to "产物时间", "message" to "说明", "code" to "结果")
    labels.forEach { (key, label) ->
        item.optString(key).takeUnless { it.isBlank() || it == "null" }?.let {
            Text("$label：${if (key == "status" || key == "state") componentStatus(it) else it}", style = MaterialTheme.typography.bodyMedium)
        }
    }
    item.optJSONObject("input")?.let { input ->
        input.optString("title").takeIf(String::isNotBlank)?.let { Text("任务：$it") }
        if (input.has("belongName")) Text("目标：${input.optString("belongName")} / ${input.optString("productId")} / ${input.optString("channelId")}")
    }
    item.optJSONObject("result")?.let { result ->
        result.optString("taskId").takeIf(String::isNotBlank)?.let { Text("任务编号：$it") }
        result.optJSONObject("build")?.let { ComponentRecord(it) }
        ComponentRecords(result.optJSONArray("artifacts"))
        result.optJSONArray("items")?.let { ComponentRecords(it) }
    }
    item.optJSONObject("error")?.let { failure ->
        Text("错误：${failure.optString("code")} ${failure.optString("message")}", color = MaterialTheme.colorScheme.error)
    }
}

internal fun componentStatus(value: String): String = when (value.lowercase()) {
    "queued" -> "排队中"
    "paused" -> "已暂停"
    "dispatching" -> "正在提交"
    "pending" -> "等待投递"
    "submitted", "sent", "accepted", "existing" -> "已投递，待核对执行结果"
    "retry" -> "等待重试"
    "running", "started" -> "执行中"
    "succeeded", "completed", "success" -> "已完成"
    "failed", "failure" -> "失败"
    "cancelled", "canceled" -> "已取消"
    "uncertain" -> "结果待核实"
    "interrupted" -> "已中断"
    "awaiting_test" -> "等待测试"
    "awaiting_publish" -> "等待确认发布"
    else -> value
}
