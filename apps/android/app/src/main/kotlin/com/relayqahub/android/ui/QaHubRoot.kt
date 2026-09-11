package com.relayqahub.android.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import com.relayqahub.android.*
import com.relayqahub.android.network.*
import com.relayqahub.android.security.*
import kotlinx.coroutines.launch

internal data class AuthenticatedSurface(
    val page: QaHubPage,
    val projectToolsOpen: Boolean,
)

internal fun AuthenticatedSurface.openAppUpdate(): AuthenticatedSurface = copy(
    page = QaHubPage.CAPTURE_SETTINGS,
    projectToolsOpen = false,
)

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
    var projectLogo by remember { mutableStateOf<ImageBitmap?>(null) }
    var token by remember { mutableStateOf<String?>(null) }
    var loginPending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var projectNameInput by rememberSaveable { mutableStateOf(identityStore.projectName().takeUnless { it == identityStore.projectId() }.orEmpty()) }
    var projectCodeInput by rememberSaveable { mutableStateOf("") }
    var serverMessage by rememberSaveable { mutableStateOf<String?>(null) }
    var toolsOpen by rememberSaveable { mutableStateOf(false) }
    var projectPickerOpen by remember { mutableStateOf(false) }
    val savedPages = rememberSaveableStateHolder()
    val establish: suspend (String, String, String) -> Unit = { name, requestedProjectName, requestedCode ->
        val session = container.accountSessionClient.login(requestedProjectName.trim(), requestedCode, name)
        NativeProjectBindings.register(session.accessToken, session.projectId)
        val sessionScope = scopedIdentity(container.apiBaseUrl, session.accountId, session.projectId, session.userId)
        when (container.credentialVault.put(sessionScope.nativeSessionScope(), NativeCredentials(
            session.accessToken, "project-code-login-no-refresh", session.accessTokenExpiresAtEpochMs, false,
        ))) {
            is VaultResult.Success -> Unit
            else -> throw AccountSessionFailure("SESSION_PERSIST_FAILED")
        }
        val availableProjects = container.projectOperationsClient.projects(session.accessToken)
        val entry = availableProjects.firstOrNull { it.id == session.projectId }
            ?: error("PROJECT_NOT_ACCESSIBLE")
        projectLogo = container.projectOperationsClient.logo(session.projectId, session.accessToken)?.let { bytes ->
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        }
        person = identityStore.select(session.accountId, session.userId, session.displayName, session.projectId, entry.name, entry.key)
        project = entry
        projectNameInput = entry.name
        projects = availableProjects
        token = session.accessToken
    }
    fun signIn(name: String, targetProjectName: String, targetCode: String) {
        if (loginPending) return
        loginPending = true
        error = null
        coroutineScope.launch {
            try { establish(name, targetProjectName, targetCode) }
            catch (failure: Exception) { error = loginFailureMessage(failure) }
            finally { loginPending = false }
        }
    }
    fun saveServerUrl(value: String) {
        serverMessage = try {
            val saved = QaRuntimeConfigLoader.save(application, value)
            "已保存 ${saved.apiBaseUrl}。请完全退出并重新打开应用后生效；现有草稿和离线队列会保留。"
        } catch (failure: Exception) {
            "服务器地址未保存：${failure.message ?: "地址无效"}"
        }
    }
    val currentPerson = person
    val currentProject = project
    val currentToken = token
    if (currentPerson == null || currentProject == null || currentToken == null) {
        DisposableEffect(Unit) { onViewModelActive(null); onDispose { } }
        IdentityGate(
            projectName = projectNameInput,
            onProjectNameChange = { projectNameInput = it },
            projectCode = projectCodeInput,
            onProjectCodeChange = { projectCodeInput = it },
            serviceUrl = container.apiBaseUrl,
            serverMessage = serverMessage,
            pending = loginPending,
            error = error,
            onSaveServerUrl = ::saveServerUrl,
        ) { name -> signIn(name, projectNameInput, projectCodeInput) }
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
                Row(verticalAlignment = Alignment.CenterVertically) {
                    projectLogo?.let { logo ->
                        Image(logo, "${currentProject.name} Logo", Modifier.size(40.dp).testTag("project-logo"))
                    }
                    Box {
                        TextButton(onClick = { projectPickerOpen = true }, enabled = !loginPending,
                            modifier = Modifier.testTag("project-switch")) { Text("${currentProject.name} ▾") }
                        DropdownMenu(expanded = projectPickerOpen, onDismissRequest = { projectPickerOpen = false }) {
                            projects.forEach { available -> DropdownMenuItem(text = { Text(available.name) }, onClick = {
                                projectPickerOpen = false
                                if (available.id != currentProject.id) {
                                    onStopCaptureSession()
                                    toolsOpen = false
                                    signIn(currentPerson.displayName, available.name, projectCodeInput)
                                }
                            }) }
                        }
                    }
                }
                Row {
                    TextButton(
                        onClick = {
                            val destination = AuthenticatedSurface(
                                page = foundationViewModel.uiState.value.page,
                                projectToolsOpen = toolsOpen,
                            ).openAppUpdate()
                            toolsOpen = destination.projectToolsOpen
                            foundationViewModel.navigateTo(destination.page)
                        },
                        modifier = Modifier.testTag("app-update-entry"),
                    ) {
                        Text("检查更新")
                    }
                    TextButton(onClick = { toolsOpen = !toolsOpen }, modifier = Modifier.testTag("project-tools")) {
                        Text(if (toolsOpen) "Bug 工作台" else "项目与组件")
                    }
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
    "AUTHENTICATION_FAILED" -> "项目名称或四位项目码不正确。"
    "RATE_LIMITED" -> "尝试次数过多，请稍后再试。"
    "PROJECT_MEMBERSHIP_DISABLED", "PROJECT_MEMBERSHIP_REVOKED", "MEMBERSHIP_DISABLED" -> "当前项目的人员关系已停用，请联系项目人员恢复。"
    else -> "操作失败：${failure.message ?: "UNKNOWN"}"
}

@Composable
private fun IdentityGate(
    projectName: String,
    onProjectNameChange: (String) -> Unit,
    projectCode: String,
    onProjectCodeChange: (String) -> Unit,
    serviceUrl: String,
    serverMessage: String?,
    pending: Boolean,
    error: String?,
    onSaveServerUrl: (String) -> Unit,
    onLogin: (String) -> Unit,
) {
    var name by rememberSaveable { mutableStateOf("") }
    var serverDraft by rememberSaveable(serviceUrl) { mutableStateOf(serviceUrl) }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()
        .verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("QA Hub 项目预览", style = MaterialTheme.typography.headlineMedium)
        Text("填写项目名称、四位项目码和姓名即可登记；项目码中的前导零会保留。", Modifier.padding(vertical = 16.dp))
        OutlinedTextField(
            value = serverDraft,
            onValueChange = { serverDraft = it },
            label = { Text("服务器地址") },
            supportingText = { Text("必须是 HTTPS 或已允许的内网 HTTP /api/v1/地址") },
            singleLine = true,
            enabled = !pending,
            modifier = Modifier.fillMaxWidth().testTag("identity-server-url"),
        )
        TextButton(
            onClick = { onSaveServerUrl(serverDraft) },
            enabled = !pending && serverDraft.isNotBlank(),
            modifier = Modifier.fillMaxWidth().testTag("identity-save-server"),
        ) { Text("保存服务器地址（重启后生效）") }
        serverMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        OutlinedTextField(
            value = projectName,
            onValueChange = onProjectNameChange,
            label = { Text("项目名称") },
            singleLine = true,
            enabled = !pending,
            modifier = Modifier.fillMaxWidth().testTag("identity-project-name"),
        )
        OutlinedTextField(
            value = projectCode,
            onValueChange = { value -> onProjectCodeChange(value.filter(Char::isDigit).take(4)) },
            label = { Text("四位项目码") },
            supportingText = { Text("固定四位数字，例如 0007") },
            singleLine = true,
            enabled = !pending,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth().testTag("identity-project-code"),
        )
        OutlinedTextField(name, { name = it }, label = { Text("姓名") }, singleLine = true,
            enabled = !pending, modifier = Modifier.fillMaxWidth().testTag("identity-name"))
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 8.dp)) }
        Button(
            onClick = { onLogin(name) },
            enabled = name.isNotBlank() && projectName.trim().isNotEmpty() && projectCode.length == 4 && !pending,
            modifier = Modifier.fillMaxWidth().padding(top = 16.dp).testTag("identity-login")) {
            Text(if (pending) "正在进入项目…" else "进入项目")
        }
    }
}
