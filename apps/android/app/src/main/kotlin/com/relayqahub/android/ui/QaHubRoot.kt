package com.relayqahub.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.lifecycle.viewmodel.compose.viewModel
import com.relayqahub.android.FoundationViewModel
import com.relayqahub.android.QaHubApplication
import com.relayqahub.android.QaPerson
import com.relayqahub.android.network.AccountSessionFailure
import com.relayqahub.android.security.NativeCredentials
import com.relayqahub.android.security.VaultResult
import com.relayqahub.android.security.nativeSessionScope
import kotlinx.coroutines.launch

@Composable
fun QaHubRoot(
    onViewModelActive: (FoundationViewModel?) -> Unit,
    onStartCaptureSession: () -> Unit,
    onCaptureNow: () -> Unit,
    onStopCaptureSession: () -> Unit,
) {
    val application = LocalContext.current.applicationContext as QaHubApplication
    val container = application.container
    val identityStore = container.identityStore
    val coroutineScope = rememberCoroutineScope()
    val rememberedPerson = remember { identityStore.current() }
    var signedInPerson by remember { mutableStateOf<QaPerson?>(null) }
    var loginPending by rememberSaveable { mutableStateOf(rememberedPerson != null) }
    var loginError by rememberSaveable { mutableStateOf<String?>(null) }
    val establishSession: suspend (String) -> QaPerson = { name ->
        val session = container.accountSessionClient.login(name)
        val scope = FoundationViewModel.foundationScope(session.userId)
        when (
            container.credentialVault.put(
                scope.nativeSessionScope(),
                NativeCredentials(
                    accessToken = session.accessToken,
                    refreshToken = "backend-name-login-no-refresh",
                    accessTokenExpiresAtEpochMs = session.accessTokenExpiresAtEpochMs,
                    sharedDeviceSession = false,
                ),
            )
        ) {
            is VaultResult.Success -> identityStore.select(session.userId, session.displayName)
            is VaultResult.Missing -> throw AccountSessionFailure("SESSION_PERSIST_MISSING")
            is VaultResult.Unavailable -> throw AccountSessionFailure("SESSION_PERSIST_FAILED")
        }
    }
    LaunchedEffect(rememberedPerson?.id) {
        val remembered = rememberedPerson ?: return@LaunchedEffect
        try {
            signedInPerson = establishSession(remembered.displayName)
        } catch (failure: AccountSessionFailure) {
            identityStore.clear()
            loginError = when (failure.code) {
                "NETWORK_IO" -> "无法连接 QA Hub，请检查内网后重新登录。"
                else -> "原登录已失效，请重新输入姓名。"
            }
        } finally {
            loginPending = false
        }
    }
    val person = signedInPerson
    if (person == null) {
        DisposableEffect(Unit) {
            onViewModelActive(null)
            onDispose { }
        }
        IdentityGate(
            pending = loginPending,
            error = loginError,
            onLogin = { name ->
                if (!loginPending) {
                    loginPending = true
                    loginError = null
                    coroutineScope.launch {
                        try {
                            signedInPerson = establishSession(name)
                        } catch (failure: AccountSessionFailure) {
                            loginError = when (failure.code) {
                                "NETWORK_IO" -> "无法连接 QA Hub，请检查内网。"
                                "INVALID_ACCOUNT_NAME", "INVALID_REQUEST" -> "请输入有效姓名。"
                                "SESSION_PERSIST_MISSING", "SESSION_PERSIST_FAILED" ->
                                    "登录会话保存失败，请重试。"
                                else -> "登录失败：${failure.code}"
                            }
                        } finally {
                            loginPending = false
                        }
                    }
                }
            },
        )
        return
    }

    val foundationViewModel: FoundationViewModel = viewModel(key = "foundation:${person.id}")
    DisposableEffect(foundationViewModel) {
        onViewModelActive(foundationViewModel)
        onDispose { onViewModelActive(null) }
    }
    LaunchedEffect(foundationViewModel) {
        foundationViewModel.refreshPendingCapture()
        foundationViewModel.restoreLatestCaptureDraft()
        foundationViewModel.refreshBugWorkbench()
    }
    FoundationScreen(
        viewModel = foundationViewModel,
        signedInPerson = person,
        onSwitchIdentity = {
            coroutineScope.launch {
                container.credentialVault.deleteSession(
                    FoundationViewModel.foundationScope(person.id).nativeSessionScope(),
                )
                identityStore.clear()
                signedInPerson = null
            }
        },
        onStartCaptureSession = onStartCaptureSession,
        onCaptureNow = onCaptureNow,
        onStopCaptureSession = onStopCaptureSession,
    )
}

@Composable
private fun IdentityGate(
    pending: Boolean,
    error: String?,
    onLogin: (String) -> Unit,
) {
    var name by rememberSaveable { mutableStateOf("") }
    val submit: () -> Unit = {
        if (name.isNotBlank() && !pending) onLogin(name)
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .statusBarsPadding()
            .navigationBarsPadding(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 22.dp, vertical = 28.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            BrandLockup()
            Spacer(Modifier.height(24.dp))

            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = 520.dp),
                shape = RoundedCornerShape(28.dp),
                color = MaterialTheme.colorScheme.surface,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                shadowElevation = 8.dp,
            ) {
                Column(
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 28.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Surface(
                        shape = RoundedCornerShape(100.dp),
                        color = QaLime.copy(alpha = 0.22f),
                    ) {
                        Text(
                            text = "内部 QA 工作台",
                            modifier = Modifier.padding(horizontal = 13.dp, vertical = 7.dp),
                            color = QaForest,
                            style = MaterialTheme.typography.labelLarge,
                        )
                    }
                    Text(
                        text = "欢迎回来",
                        modifier = Modifier.padding(top = 20.dp),
                        style = MaterialTheme.typography.headlineLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        text = "输入姓名；未登记的姓名会由后端自动创建账号",
                        modifier = Modifier.padding(top = 8.dp, bottom = 24.dp),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                    OutlinedTextField(
                        value = name,
                        onValueChange = {
                            name = it
                        },
                        singleLine = true,
                        label = { Text("姓名") },
                        placeholder = { Text("例如：罗东乐") },
                        supportingText = error?.let { message -> ({ Text(message) }) },
                        isError = error != null,
                        shape = RoundedCornerShape(16.dp),
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Text,
                            imeAction = ImeAction.Done,
                        ),
                        keyboardActions = KeyboardActions(onDone = { submit() }),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = QaForest,
                            focusedLabelColor = QaForest,
                            cursorColor = QaForest,
                            unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant,
                            focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                        ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("identity-name"),
                    )
                    Button(
                        onClick = submit,
                        enabled = name.isNotBlank() && !pending,
                        shape = RoundedCornerShape(16.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = QaForest,
                            contentColor = Color.White,
                            disabledContainerColor = QaForest.copy(alpha = 0.32f),
                            disabledContentColor = Color.White.copy(alpha = 0.72f),
                        ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 14.dp)
                            .height(56.dp)
                            .testTag("identity-login"),
                    ) {
                        Text(if (pending) "正在登录…" else "进入工作台", fontWeight = FontWeight.Bold)
                    }
                    Text(
                        text = "账号和团队成员均由 QA Hub 后端统一管理",
                        modifier = Modifier.padding(top = 16.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }
    }
}

@Composable
private fun BrandLockup() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(13.dp),
    ) {
        Surface(
            modifier = Modifier.size(52.dp),
            shape = RoundedCornerShape(16.dp),
            color = QaForest,
            shadowElevation = 3.dp,
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text(
                    text = "✓",
                    color = QaLime,
                    fontSize = 27.sp,
                    fontWeight = FontWeight.Black,
                )
            }
        }
        Column {
            Text(
                text = "Relay QA Hub",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                color = QaForest,
            )
            Text(
                text = "记录问题，推动完成",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
