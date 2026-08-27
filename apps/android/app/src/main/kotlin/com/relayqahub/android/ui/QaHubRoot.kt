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
import androidx.compose.foundation.shape.CircleShape
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
import com.relayqahub.android.QaPeopleConfigLoader
import com.relayqahub.android.QaPerson

@Composable
fun QaHubRoot(
    onViewModelActive: (FoundationViewModel?) -> Unit,
    onStartCaptureSession: () -> Unit,
    onCaptureNow: () -> Unit,
    onStopCaptureSession: () -> Unit,
) {
    val application = LocalContext.current.applicationContext as QaHubApplication
    val identityStore = application.container.identityStore
    val configResult = remember {
        runCatching {
            QaPeopleConfigLoader.ensureExternalSeed(application)
            QaPeopleConfigLoader.load(application)
        }
    }
    val config = configResult.getOrNull()
    if (config == null) {
        IdentityConfigurationFailure(configResult.exceptionOrNull())
        return
    }

    var signedInPerson by remember(config) {
        mutableStateOf(identityStore.current(config))
    }
    val person = signedInPerson
    if (person == null) {
        DisposableEffect(Unit) {
            onViewModelActive(null)
            onDispose { }
        }
        IdentityGate(
            onLogin = { pinyin ->
                identityStore.selectByPinyin(config, pinyin)?.also { signedInPerson = it }
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
            identityStore.clear()
            signedInPerson = null
        },
        onStartCaptureSession = onStartCaptureSession,
        onCaptureNow = onCaptureNow,
        onStopCaptureSession = onStopCaptureSession,
    )
}

@Composable
private fun IdentityGate(onLogin: (String) -> QaPerson?) {
    var pinyin by rememberSaveable { mutableStateOf("") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    val submit: () -> Unit = {
        if (pinyin.isNotBlank() && onLogin(pinyin) == null) {
            error = "未找到该成员，请检查完整拼音。"
        }
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
                        text = "输入姓名拼音识别身份",
                        modifier = Modifier.padding(top = 8.dp, bottom = 24.dp),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                    OutlinedTextField(
                        value = pinyin,
                        onValueChange = {
                            pinyin = it
                            error = null
                        },
                        singleLine = true,
                        label = { Text("姓名拼音") },
                        placeholder = { Text("例如：luodongle") },
                        supportingText = error?.let { message -> ({ Text(message) }) },
                        isError = error != null,
                        shape = RoundedCornerShape(16.dp),
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Ascii,
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
                            .testTag("identity-pinyin"),
                    )
                    Button(
                        onClick = submit,
                        enabled = pinyin.isNotBlank(),
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
                        Text("进入工作台", fontWeight = FontWeight.Bold)
                    }
                    Text(
                        text = "仅用于内网身份识别，无需密码",
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
private fun IdentityConfigurationFailure(failure: Throwable?) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .statusBarsPadding()
            .navigationBarsPadding()
            .padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth().widthIn(max = 520.dp),
            shape = RoundedCornerShape(24.dp),
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.error.copy(alpha = 0.22f)),
            shadowElevation = 6.dp,
        ) {
            Column(modifier = Modifier.padding(24.dp)) {
                Surface(
                    modifier = Modifier.size(48.dp),
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.errorContainer,
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text(
                            text = "!",
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            fontSize = 22.sp,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
                Text(
                    "人员配置不可用",
                    modifier = Modifier.padding(top = 18.dp),
                    style = MaterialTheme.typography.headlineSmall,
                )
                Text(
                    "请检查 qa-people.json。${failure?.message?.let { " ($it)" }.orEmpty()}",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.padding(top = 8.dp),
                )
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
