package com.relayqahub.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.relayqahub.android.QaHubApplication
import com.relayqahub.android.NativeProjectBindings
import com.relayqahub.android.network.*
import com.relayqahub.android.security.*
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID

@Composable
fun BugLifecyclePanel(bug: WorkbenchBug, onChanged: (Boolean) -> Unit) {
    val container = (LocalContext.current.applicationContext as QaHubApplication).container
    val projectScope = remember(bug.projectId, bug.id) { container.identityStore.scope() }
    val scope = rememberCoroutineScope()
    var workflow by remember(bug.id, bug.version) { mutableStateOf<JSONObject?>(null) }
    var events by remember(bug.id, bug.version) { mutableStateOf<List<JSONObject>>(emptyList()) }
    var comments by remember(bug.id, bug.version) { mutableStateOf<List<JSONObject>>(emptyList()) }
    var qingyuLink by remember(bug.id, bug.version) { mutableStateOf<JSONObject?>(null) }
    var qingyuError by remember(bug.id, bug.version) { mutableStateOf<String?>(null) }
    var token by remember(bug.id) { mutableStateOf<String?>(null) }
    var note by rememberSaveable(bug.projectId, bug.id) { mutableStateOf("") }
    var branch by rememberSaveable(bug.projectId, bug.id) { mutableStateOf("") }
    var commit by rememberSaveable(bug.projectId, bug.id) { mutableStateOf("") }
    var codeDelivery by rememberSaveable(bug.projectId, bug.id) { mutableStateOf(false) }
    var comment by rememberSaveable(bug.projectId, bug.id) { mutableStateOf("") }
    var commentId by rememberSaveable(bug.projectId, bug.id) { mutableStateOf(UUID.randomUUID().toString()) }
    var busy by remember(bug.id) { mutableStateOf(false) }
    var error by remember(bug.id) { mutableStateOf<String?>(null) }
    var deleteConfirm by remember(bug.id) { mutableStateOf(false) }
    suspend fun client(): BugLifecycleClient {
        check(projectScope.projectId == bug.projectId) { "BUG_SCOPE_MISMATCH" }
        val credentials = container.credentialVault.read(projectScope.nativeSessionScope())
        val accessToken = (credentials as? VaultResult.Success)?.value?.accessToken ?: error("SESSION_EXPIRED")
        NativeProjectBindings.register(accessToken, projectScope.projectId)
        token = accessToken
        return BugLifecycleClient(container.projectOperationsClient, bug.projectId, accessToken)
    }
    suspend fun reload(api: BugLifecycleClient) {
        workflow = api.workflow(bug.id)
        events = api.events(bug.id).objects()
        comments = api.comments(bug.id).objects()
        // An optional connector failure cannot turn the local Bug workflow into an error.
        runCatching {
            val accessToken = checkNotNull(token)
            val enabled = container.projectOperationsClient.components(bug.projectId, accessToken)
                .any { it.key == "qingyu.sync" && it.enabled }
            if (enabled) qingyuLink = container.projectOperationsClient.request("bugs/${bug.id}/integrations/qingyu", accessToken).optJSONObject("link")
        }.onFailure { qingyuError = it.message }
    }
    fun perform(deleted: Boolean = false, action: suspend (BugLifecycleClient) -> Unit) {
        if (busy) return
        busy = true; error = null
        scope.launch {
            try {
                val api = client()
                action(api)
                if (!deleted) reload(api)
                onChanged(deleted)
            } catch (failure: Exception) { error = "操作失败：${failure.message ?: "UNKNOWN"}" }
            finally { busy = false }
        }
    }
    LaunchedEffect(bug.id, bug.version) {
        try { reload(client()) } catch (failure: Exception) { error = failure.message }
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        Text("处理与验收", style = MaterialTheme.typography.titleLarge)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        val attempt = workflow?.optJSONObject("repairAttempt")
        attempt?.let { Text("修复轮次：${it.optString("sequence")} · ${it.optString("status")}") }
        workflow?.optJSONObject("verification")?.let { Text("验收：${it.optString("status")}") }
        OutlinedTextField(note, { note = it }, label = { Text("处理说明 / 验收结果") }, modifier = Modifier.fillMaxWidth().testTag("bug-action-note"))
        val mayAct = !busy && note.isNotBlank()
        if (bug.state in listOf("reported", "needs_info", "ready", "in_progress")) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(enabled = mayAct, onClick = { perform { it.beginFix(bug, projectScope.actorId, note) } }, modifier = Modifier.testTag("bug-begin-fix")) { Text("开始修复") }
                OutlinedButton(enabled = mayAct, onClick = { perform { it.manualComplete(bug, note) } }, modifier = Modifier.testTag("bug-manual-complete")) { Text("人工完成") }
            }
        }
        if (attempt?.optString("mode") == "human" && attempt.optString("status") in listOf("planned", "running")) {
            Row { Checkbox(codeDelivery, { codeDelivery = it }); Text("提交代码交付") }
            if (codeDelivery) {
                OutlinedTextField(branch, { branch = it }, label = { Text("实际分支") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(commit, { commit = it }, label = { Text("实际提交 SHA") }, modifier = Modifier.fillMaxWidth())
            }
            Button(enabled = mayAct && (!codeDelivery || branch.isNotBlank() && commit.matches(Regex("[0-9a-f]{40}"))), onClick = {
                perform { it.submitFix(bug, note, branch.takeIf { codeDelivery }, commit.takeIf { codeDelivery }) }
            }, modifier = Modifier.testTag("bug-submit-fix")) { Text(if (codeDelivery) "提交代码修复" else "提交无需代码的处理") }
        }
        if (bug.state in listOf("awaiting_build", "ready_for_verification")) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(enabled = mayAct, onClick = { perform { it.verify(bug, projectScope.actorId, true, note) } }, modifier = Modifier.testTag("bug-verify-pass")) { Text("验收通过并关闭") }
                OutlinedButton(enabled = mayAct, onClick = { perform { it.verify(bug, projectScope.actorId, false, note) } }, modifier = Modifier.testTag("bug-verify-fail")) { Text("验收失败并退回") }
            }
        }
        HorizontalDivider()
        Text("评论与历史", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(comment, { comment = it }, label = { Text("评论") }, modifier = Modifier.fillMaxWidth().testTag("bug-comment-input"))
        Button(enabled = !busy && comment.isNotBlank(), onClick = {
            perform {
                container.commentTimelineClient.createComment(bug.id, commentId, comment, checkNotNull(token))
                comment = ""; commentId = UUID.randomUUID().toString()
            }
        }, modifier = Modifier.testTag("bug-comment-submit")) { Text("添加评论") }
        comments.forEach { entry ->
            Text("${entry.optString("createdAt")} · ${entry.optString("authorId")}", style = MaterialTheme.typography.labelSmall)
            Text(entry.optString("body"))
        }
        events.forEach { event ->
            Text("${event.optString("occurredAt", event.optString("createdAt"))} · ${event.optString("type", event.optString("eventType"))}", style = MaterialTheme.typography.labelMedium)
            event.optJSONObject("payload")?.let { payload ->
                listOf("body", "commentBody", "reason", "resultSummary", "summary").forEach { field ->
                    payload.optString(field).takeIf(String::isNotBlank)?.let { Text(it) }
                }
            }
        }
        TextButton(onClick = { deleteConfirm = true }, enabled = !busy, modifier = Modifier.testTag("bug-delete")) { Text("删除 Bug（保留审计记录）") }
        qingyuLink?.let { link ->
            HorizontalDivider()
            Text("关联订单：${link.optString("defectTitle")}")
            Text("同步状态：${link.optString("syncStatus")}")
            qingyuError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (bug.state == "closed") TextButton(enabled = !busy, onClick = {
                scope.launch {
                    busy = true; qingyuError = null
                    try {
                        val accessToken = checkNotNull(token)
                        container.projectOperationsClient.request("bugs/${bug.id}/integrations/qingyu/resolve", accessToken, "POST")
                        qingyuLink = container.projectOperationsClient.request("bugs/${bug.id}/integrations/qingyu", accessToken).optJSONObject("link")
                    } catch (failure: Exception) { qingyuError = failure.message }
                    finally { busy = false }
                }
            }) { Text("核对 / 重试订单同步") }
        }
    }
    if (deleteConfirm) AlertDialog(onDismissRequest = { deleteConfirm = false }, title = { Text("删除 ${bug.key}") },
        text = { Text("该 Bug 将从普通列表移除，历史和审计记录保留。") },
        confirmButton = { TextButton(onClick = { deleteConfirm = false; perform(deleted = true) { it.delete(bug) } }) { Text("删除") } },
        dismissButton = { TextButton(onClick = { deleteConfirm = false }) { Text("取消") } })
}
