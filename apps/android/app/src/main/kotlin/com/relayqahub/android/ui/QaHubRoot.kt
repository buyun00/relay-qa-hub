package com.relayqahub.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import com.relayqahub.android.*
import com.relayqahub.android.network.*
import com.relayqahub.android.security.*
import kotlinx.coroutines.launch

@Composable
fun QaHubRoot(
    onViewModelActive: (FoundationViewModel?) -> Unit,
    onStartCaptureSession: () -> Unit,
    onCaptureNow: () -> Unit,
    onStopCaptureSession: () -> Unit,
    entryProjectId: String? = null,
) {
    val application = LocalContext.current.applicationContext as QaHubApplication
    val container = application.container
    val identityStore = container.identityStore
    val coroutineScope = rememberCoroutineScope()
    var person by remember { mutableStateOf<QaPerson?>(null) }
    var project by remember { mutableStateOf<QaProject?>(null) }
    var projects by remember { mutableStateOf<List<QaProject>>(emptyList()) }
    var token by remember { mutableStateOf<String?>(null) }
    var loginPending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var projectInput by rememberSaveable { mutableStateOf(entryProjectId ?: identityStore.projectId()) }
    var toolsOpen by rememberSaveable { mutableStateOf(false) }
    var projectPickerOpen by remember { mutableStateOf(false) }
    val savedPages = rememberSaveableStateHolder()
    val establish: suspend (String, String) -> Unit = { name, requestedProject ->
        val entry = container.projectOperationsClient.entry(requestedProject.trim())
        val session = container.accountSessionClient.login(name, entry.id)
        NativeProjectBindings.register(session.accessToken, entry.id)
        val sessionScope = scopedIdentity(container.apiBaseUrl, session.accountId, entry.id, session.userId)
        when (container.credentialVault.put(sessionScope.nativeSessionScope(), NativeCredentials(
            session.accessToken, "backend-name-login-no-refresh", session.accessTokenExpiresAtEpochMs, false,
        ))) {
            is VaultResult.Success -> Unit
            else -> throw AccountSessionFailure("SESSION_PERSIST_FAILED")
        }
        val availableProjects = container.projectOperationsClient.projects(session.accessToken)
        check(availableProjects.any { it.id == entry.id }) { "PROJECT_NOT_ACCESSIBLE" }
        person = identityStore.select(session.accountId, session.userId, session.displayName, entry.id, entry.name, entry.key)
        project = entry
        projectInput = entry.id
        projects = availableProjects
        token = session.accessToken
    }
    fun signIn(name: String, target: String) {
        if (loginPending) return
        loginPending = true
        error = null
        coroutineScope.launch {
            try { establish(name, target) }
            catch (failure: Exception) { error = loginFailureMessage(failure) }
            finally { loginPending = false }
        }
    }
    LaunchedEffect(entryProjectId) {
        val target = entryProjectId ?: identityStore.projectId()
        projectInput = target
        val remembered = identityStore.current()
        if (entryProjectId != null && project?.id != target) {
            onStopCaptureSession()
            person = null
            project = null
            token = null
            toolsOpen = false
        }
        if (remembered != null && person == null) signIn(remembered.displayName, target)
    }
    val currentPerson = person
    val currentProject = project
    val currentToken = token
    if (currentPerson == null || currentProject == null || currentToken == null) {
        DisposableEffect(Unit) { onViewModelActive(null); onDispose { } }
        IdentityGate(projectInput, { projectInput = it }, container.apiBaseUrl, loginPending, error) { name -> signIn(name, projectInput) }
        return
    }
    // Clearing this owned store cancels old project coroutines; private drafts are durable.
    val owner = remember(currentProject.id, currentPerson.id) {
        object : ViewModelStoreOwner { override val viewModelStore = ViewModelStore() }
    }
    DisposableEffect(owner) { onDispose { owner.viewModelStore.clear() } }
    val foundationViewModel: FoundationViewModel = viewModel(
        viewModelStoreOwner = owner,
        key = "foundation:${currentProject.id}:${currentPerson.id}",
        factory = ViewModelProvider.AndroidViewModelFactory.getInstance(application),
    )
    DisposableEffect(foundationViewModel) {
        onViewModelActive(foundationViewModel)
        onDispose { onViewModelActive(null) }
    }
    LaunchedEffect(foundationViewModel) {
        foundationViewModel.refreshPendingCapture()
        foundationViewModel.restoreLatestCaptureDraft()
        foundationViewModel.refreshBugWorkbench()
    }
    Column(Modifier.fillMaxSize()) {
        Surface(tonalElevation = 2.dp) {
            Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 10.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                Box {
                    TextButton(onClick = { projectPickerOpen = true }, enabled = !loginPending,
                        modifier = Modifier.testTag("project-switch")) { Text("${currentProject.name} ▾") }
                    DropdownMenu(expanded = projectPickerOpen, onDismissRequest = { projectPickerOpen = false }) {
                        projects.forEach { available -> DropdownMenuItem(text = { Text(available.name) }, onClick = {
                            projectPickerOpen = false
                            if (available.id != currentProject.id) {
                                onStopCaptureSession()
                                toolsOpen = false
                                signIn(currentPerson.displayName, available.id)
                            }
                        }) }
                    }
                }
                TextButton(onClick = { toolsOpen = !toolsOpen }, modifier = Modifier.testTag("project-tools")) {
                    Text(if (toolsOpen) "Bug 工作台" else "项目与组件")
                }
            }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp)) }
        Box(Modifier.weight(1f)) { savedPages.SaveableStateProvider("${container.apiBaseUrl}:${currentProject.id}:${currentPerson.id}:$toolsOpen") {
            if (toolsOpen) ProjectToolsScreen(container.projectOperationsClient, currentProject, currentPerson, currentToken)
            else key(container.apiBaseUrl, currentProject.id, currentPerson.id) { FoundationScreen(
                viewModel = foundationViewModel, signedInPerson = currentPerson,
                onSwitchIdentity = {
                    onStopCaptureSession()
                    coroutineScope.launch {
                        container.credentialVault.deleteSession(identityStore.scope().nativeSessionScope())
                        identityStore.clear()
                        person = null; project = null; token = null; toolsOpen = false
                    }
                },
                onStartCaptureSession = onStartCaptureSession,
                onCaptureNow = onCaptureNow,
                onStopCaptureSession = onStopCaptureSession,
            ) }
        } }
    }
}

private fun loginFailureMessage(failure: Exception): String = when ((failure as? AccountSessionFailure)?.code) {
    "NETWORK_IO" -> "无法连接预览服务，请检查内网与服务地址。"
    "PROJECT_MEMBERSHIP_DISABLED", "PROJECT_MEMBERSHIP_REVOKED", "MEMBERSHIP_DISABLED" -> "当前项目的人员关系已停用，请联系项目人员恢复。"
    else -> "操作失败：${failure.message ?: "UNKNOWN"}"
}

@Composable
private fun IdentityGate(projectId: String, onProjectChange: (String) -> Unit, serviceUrl: String,
    pending: Boolean, error: String?, onLogin: (String) -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    val container = (LocalContext.current.applicationContext as QaHubApplication).container
    var projectLabel by remember(projectId) { mutableStateOf<String?>(null) }
    LaunchedEffect(projectId) {
        if (runCatching { java.util.UUID.fromString(projectId) }.isSuccess) {
            kotlinx.coroutines.delay(300)
            projectLabel = runCatching { container.projectOperationsClient.entry(projectId).name }.getOrNull()
        }
    }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()
        .verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("QA Hub 项目预览", style = MaterialTheme.typography.headlineMedium)
        Text("从项目入口进入，填写姓名即可登记到该项目。", Modifier.padding(vertical = 16.dp))
        Text(serviceUrl, style = MaterialTheme.typography.bodySmall)
        projectLabel?.let { Text("登录项目：$it", style = MaterialTheme.typography.titleMedium) }
        OutlinedTextField(projectId, onProjectChange, label = { Text("项目入口 ID") }, singleLine = true,
            enabled = !pending, modifier = Modifier.fillMaxWidth().testTag("identity-project"))
        OutlinedTextField(name, { name = it }, label = { Text("姓名") }, singleLine = true,
            enabled = !pending, modifier = Modifier.fillMaxWidth().testTag("identity-name"))
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 8.dp)) }
        Button(onClick = { onLogin(name) }, enabled = name.isNotBlank() && projectId.isNotBlank() && !pending,
            modifier = Modifier.fillMaxWidth().padding(top = 16.dp).testTag("identity-login")) {
            Text(if (pending) "正在进入项目…" else "进入项目")
        }
    }
}
