package com.relayqahub.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.relayqahub.android.QaPerson
import com.relayqahub.android.network.*
import kotlinx.coroutines.launch

@Composable
fun ProjectToolsScreen(client: ProjectOperationsClient, project: QaProject, actor: QaPerson, token: String) {
    val scope = rememberCoroutineScope()
    var people by remember(project.id, actor.id) { mutableStateOf<List<ManagedPerson>>(emptyList()) }
    var components by remember(project.id, actor.id) { mutableStateOf<List<ProjectComponent>>(emptyList()) }
    var error by remember(project.id, actor.id) { mutableStateOf<String?>(null) }
    var busy by remember(project.id, actor.id) { mutableStateOf(false) }
    var selectedUser by remember(project.id) { mutableStateOf<ManagedPerson?>(null) }
    var linkTarget by remember(project.id) { mutableStateOf<ManagedPerson?>(null) }
    var selectedComponent by remember(project.id) { mutableStateOf<ProjectComponent?>(null) }
    suspend fun reload() {
        people = client.people(project.id, token)
        components = client.components(project.id, token)
    }
    fun perform(block: suspend () -> Unit) {
        if (busy) return
        busy = true; error = null
        scope.launch {
            try { block(); reload() }
            catch (failure: Exception) { error = "操作失败：${failure.message ?: "UNKNOWN"}" }
            finally { busy = false }
        }
    }
    LaunchedEffect(project.id, actor.id) { perform { } }
    selectedComponent?.let { component ->
        if (component.key == "qingyu.sync") QingyuComponentScreen(client, project, token,
            component.enabled && component.status == "ready", onBack = { selectedComponent = null })
        else ComponentTaskScreen(client, project, token, component, onBack = { selectedComponent = null })
        return
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(project.name, style = MaterialTheme.typography.headlineSmall)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("项目人员", style = MaterialTheme.typography.titleLarge)
            TextButton(onClick = { perform { } }, enabled = !busy) { Text("刷新") }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        people.forEach { user ->
            Card(Modifier.fillMaxWidth().testTag("project-user-${user.id}")) {
                Column(Modifier.padding(12.dp)) {
                    Text(user.name, style = MaterialTheme.typography.titleMedium)
                    Text(if (user.active) "项目员工" else "已停用", style = MaterialTheme.typography.bodySmall)
                    user.linkedToName?.let { Text("已关联：$it") }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { selectedUser = user }, enabled = !busy && !user.protected && user.id != actor.id) { Text("关联姓名") }
                        if (user.linkedToId != null) TextButton(onClick = { perform { client.managePerson(project.id, user.id, "unlink", null, token) } }, enabled = !busy) { Text("解除关联") }
                        TextButton(onClick = { perform { client.managePerson(project.id, user.id, if (user.active) "disable" else "restore", null, token, expectedVersion = user.membershipVersion) } },
                            enabled = !busy && !user.protected && user.id != actor.id) { Text(if (user.active) "停用" else "恢复") }
                    }
                }
            }
        }
        HorizontalDivider()
        Text("项目组件", style = MaterialTheme.typography.titleLarge)
        Text("Bug 管理始终可用。组件按当前项目配置。", style = MaterialTheme.typography.bodySmall)
        components.forEach { component ->
            Card(Modifier.fillMaxWidth()) {
                Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(Modifier.weight(1f)) {
                        Text(component.displayName, style = MaterialTheme.typography.titleMedium)
                        Text(when (component.status) { "ready" -> "可使用"; "needs_configuration" -> "待配置"; else -> "未启用" })
                    }
                    TextButton(onClick = { selectedComponent = component }, enabled = !busy) {
                        Text(if (component.enabled) "打开" else "历史")
                    }
                }
            }
        }
    }
    selectedUser?.let { user ->
        AlertDialog(onDismissRequest = { selectedUser = null; linkTarget = null }, title = { Text("关联 ${user.name}") },
            text = { Column(Modifier.verticalScroll(rememberScrollState())) {
                Text("仅调整当前项目的姓名关联。")
                people.filter { it.active && it.id != user.id && it.linkedToId == null }.forEach { candidate ->
                    TextButton(onClick = { linkTarget = candidate }) { Text((if (linkTarget?.id == candidate.id) "✓ " else "") + candidate.name) }
                }
            } },
            confirmButton = { TextButton(enabled = linkTarget != null && !busy, onClick = {
                val target = linkTarget ?: return@TextButton
                selectedUser = null; linkTarget = null
                perform { client.managePerson(project.id, user.id, "link", target.id, token) }
            }) { Text("关联") } }, dismissButton = { TextButton(onClick = { selectedUser = null; linkTarget = null }) { Text("取消") } })
    }
}
