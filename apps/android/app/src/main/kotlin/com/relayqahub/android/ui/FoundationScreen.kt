package com.relayqahub.android.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color as AndroidColor
import android.graphics.Paint
import android.graphics.Path
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.relayqahub.android.BugDetailUiState
import com.relayqahub.android.CaptureSessionUiStatus
import com.relayqahub.android.CaptureDraftUiState
import com.relayqahub.android.ApkDownloadUiState
import com.relayqahub.android.FoundationUiState
import com.relayqahub.android.FoundationViewModel
import com.relayqahub.android.QaHubPage
import com.relayqahub.android.QaPerson
import com.relayqahub.android.QaPersonRole
import com.relayqahub.android.network.ApkArtifact
import com.relayqahub.android.network.WorkbenchBug
import com.relayqahub.android.network.WorkbenchBugImage
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

internal const val UNASSIGNED_OWNER_FILTER = "__unassigned__"

internal enum class BugStatusFilter(val label: String) {
    ALL("全部状态"),
    PENDING("待处理"),
    IN_PROGRESS("处理中"),
    VERIFICATION("待验收"),
    COMPLETED("已完成"),
    OTHER("其他状态"),
}

internal data class BugListFilters(
    val reporterId: String? = null,
    val ownerId: String? = null,
    val status: BugStatusFilter = BugStatusFilter.ALL,
)

internal fun filterBugs(
    bugs: List<WorkbenchBug>,
    filters: BugListFilters,
): List<WorkbenchBug> = bugs.filter { bug ->
    val reporterMatches = filters.reporterId == null || bug.reporterId == filters.reporterId
    val ownerMatches = when (filters.ownerId) {
        null -> true
        UNASSIGNED_OWNER_FILTER -> bug.ownerId == null
        else -> bug.ownerId == filters.ownerId
    }
    val statusMatches = when (filters.status) {
        BugStatusFilter.ALL -> true
        BugStatusFilter.PENDING -> bug.state in setOf("reported", "needs_info", "ready")
        BugStatusFilter.IN_PROGRESS -> bug.state in setOf("in_progress", "awaiting_build")
        BugStatusFilter.VERIFICATION -> bug.state == "ready_for_verification"
        BugStatusFilter.COMPLETED -> bug.state == "closed"
        BugStatusFilter.OTHER -> bug.state in setOf("deferred", "rejected", "duplicate")
    }
    reporterMatches && ownerMatches && statusMatches
}

@Composable
fun FoundationScreen(
    viewModel: FoundationViewModel,
    signedInPerson: QaPerson,
    onSwitchIdentity: () -> Unit,
    onStartCaptureSession: () -> Unit,
    onCaptureNow: () -> Unit,
    onStopCaptureSession: () -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    LaunchedEffect(state.page) {
        if (state.page == QaHubPage.BUG_LIST) viewModel.refreshBugWorkbench()
    }
    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            QaHubTopBar(
                page = state.page,
                signedInPerson = signedInPerson,
                onSwitchIdentity = onSwitchIdentity,
            )
        },
        bottomBar = {
            QaHubBottomBar(
                selectedPage = state.page,
                onSelect = viewModel::navigateTo,
            )
        },
    ) { innerPadding ->
        when (state.page) {
            QaHubPage.CAPTURE_SETTINGS -> CaptureSettingsPage(
                state = state,
                onStartCaptureSession = onStartCaptureSession,
                onCaptureNow = onCaptureNow,
                onStopCaptureSession = onStopCaptureSession,
                onCheckForUpdate = { viewModel.checkForSelfUpdate(force = true) },
                onDownloadSelfUpdate = viewModel::downloadSelfUpdate,
                onRefreshGameApks = { viewModel.refreshGameApkCatalog(force = true) },
                onDownloadGameApk = viewModel::downloadGameApk,
                modifier = Modifier.padding(innerPadding),
            )
            QaHubPage.NEW_BUG -> NewBugPage(
                state = state,
                onCaptureNow = onCaptureNow,
                onSubmit = viewModel::submitNewBug,
                modifier = Modifier.padding(innerPadding),
            )
            QaHubPage.BUG_LIST -> BugListPage(
                state = state,
                onRefresh = viewModel::refreshBugWorkbench,
                onOpenBug = { viewModel.openBugDetail(it.id) },
                onCloseBug = viewModel::closeBugDetail,
                modifier = Modifier.padding(innerPadding),
            )
        }
    }
}

@Composable
private fun QaHubTopBar(
    page: QaHubPage,
    signedInPerson: QaPerson,
    onSwitchIdentity: () -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.surface) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 18.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Surface(
                    modifier = Modifier.size(42.dp),
                    shape = RoundedCornerShape(13.dp),
                    color = MaterialTheme.colorScheme.primary,
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text(
                            "✓",
                            color = MaterialTheme.colorScheme.primaryContainer,
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Black,
                        )
                    }
                }
                Spacer(Modifier.width(11.dp))
                Column {
                    Text(
                        text = "Relay QA Hub",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.ExtraBold,
                        modifier = Modifier.testTag("app-title"),
                    )
                    Text(
                        text = when (page) {
                            QaHubPage.CAPTURE_SETTINGS -> "悬浮球设置"
                            QaHubPage.NEW_BUG -> "现场提单"
                            QaHubPage.BUG_LIST -> "项目工作台"
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Surface(
                onClick = onSwitchIdentity,
                modifier = Modifier.testTag("switch-identity"),
                shape = RoundedCornerShape(14.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Surface(
                        modifier = Modifier.size(30.dp),
                        shape = RoundedCornerShape(10.dp),
                        color = Color(0xFFDCEEE7),
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Text(
                                signedInPerson.displayName.takeLast(1),
                                color = Color(0xFF315148),
                                fontWeight = FontWeight.ExtraBold,
                            )
                        }
                    }
                    Spacer(Modifier.width(8.dp))
                    Column {
                        Text(
                            signedInPerson.displayName,
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(
                            "切换身份",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

private enum class BottomGlyph {
    CAPTURE,
    LIST,
}

@Composable
private fun BottomGlyphIcon(glyph: BottomGlyph, selected: Boolean) {
    val color = if (selected) MaterialTheme.colorScheme.primary else Color(0xFF8A958E)
    val centerColor = if (selected) MaterialTheme.colorScheme.primaryContainer else color
    Canvas(Modifier.size(24.dp)) {
        when (glyph) {
            BottomGlyph.CAPTURE -> {
                drawCircle(color = color, radius = size.minDimension * 0.29f)
                drawCircle(
                    color = color,
                    radius = size.minDimension * 0.42f,
                    style = Stroke(width = 2.2f),
                )
                drawCircle(
                    color = centerColor,
                    radius = size.minDimension * 0.09f,
                )
            }
            BottomGlyph.LIST -> {
                repeat(3) { index ->
                    val y = size.height * (0.25f + index * 0.25f)
                    drawCircle(color = color, radius = 1.8f, center = Offset(size.width * 0.18f, y))
                    drawRoundRect(
                        color = color,
                        topLeft = Offset(size.width * 0.34f, y - 1.6f),
                        size = Size(size.width * 0.5f, 3.2f),
                        cornerRadius = CornerRadius(2f, 2f),
                    )
                }
            }
        }
    }
}

@Composable
private fun QaHubBottomBar(
    selectedPage: QaHubPage,
    onSelect: (QaHubPage) -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background)
            .navigationBarsPadding()
            .height(92.dp),
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth().height(72.dp).align(Alignment.BottomCenter),
            color = MaterialTheme.colorScheme.surface,
            shadowElevation = 12.dp,
        ) {
            Row(Modifier.fillMaxSize()) {
                BottomSideTab(
                    label = "悬浮球",
                    glyph = BottomGlyph.CAPTURE,
                    selected = selectedPage == QaHubPage.CAPTURE_SETTINGS,
                    onClick = { onSelect(QaHubPage.CAPTURE_SETTINGS) },
                    modifier = Modifier.weight(1f).testTag("nav-capture-settings"),
                )
                Spacer(Modifier.weight(1f))
                BottomSideTab(
                    label = "Bug 列表",
                    glyph = BottomGlyph.LIST,
                    selected = selectedPage == QaHubPage.BUG_LIST,
                    onClick = { onSelect(QaHubPage.BUG_LIST) },
                    modifier = Modifier.weight(1f).testTag("nav-bug-list"),
                )
            }
        }
        Column(
            modifier = Modifier.align(Alignment.TopCenter),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            FloatingActionButton(
                onClick = { onSelect(QaHubPage.NEW_BUG) },
                modifier = Modifier.size(62.dp).testTag("nav-new-bug"),
                shape = CircleShape,
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.primaryContainer,
            ) {
                Text("+", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Light)
            }
            Text(
                "新建",
                modifier = Modifier.offset(y = (-1).dp),
                color = if (selectedPage == QaHubPage.NEW_BUG) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

@Composable
private fun BottomSideTab(
    label: String,
    glyph: BottomGlyph,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(onClick = onClick, modifier = modifier.fillMaxHeight(), color = Color.Transparent) {
        Column(
            modifier = Modifier.fillMaxSize().padding(top = 11.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            BottomGlyphIcon(glyph, selected)
            Text(
                label,
                color = if (selected) MaterialTheme.colorScheme.primary else Color(0xFF7D8982),
                style = MaterialTheme.typography.labelMedium,
                fontWeight = if (selected) FontWeight.ExtraBold else FontWeight.Medium,
            )
            if (selected) {
                Surface(
                    modifier = Modifier.width(22.dp).height(3.dp),
                    color = MaterialTheme.colorScheme.primaryContainer,
                    shape = CircleShape,
                ) { }
            }
        }
    }
}

@Composable
private fun CaptureSettingsPage(
    state: FoundationUiState,
    onStartCaptureSession: () -> Unit,
    onCaptureNow: () -> Unit,
    onStopCaptureSession: () -> Unit,
    onCheckForUpdate: () -> Unit,
    onDownloadSelfUpdate: () -> Unit,
    onRefreshGameApks: () -> Unit,
    onDownloadGameApk: (ApkArtifact) -> Unit,
    modifier: Modifier = Modifier,
) {
    val active = state.captureSessionStatus == CaptureSessionUiStatus.ACTIVE
    val starting = state.captureSessionStatus == CaptureSessionUiStatus.STARTING
    val overlayGranted = state.overlayPermissionGranted
    Box(modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        LazyColumn(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .widthIn(max = 920.dp)
                .testTag("capture-settings-page"),
            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 22.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item {
                PageHeading(
                    eyebrow = "现场截图",
                    title = "悬浮球设置",
                    subtitle = "在游戏画面上随时截图，自动带图进入新建 Bug。",
                )
            }
            item {
                Card(
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primary),
                    shape = RoundedCornerShape(24.dp),
                ) {
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Surface(
                                    modifier = Modifier.size(48.dp),
                                    shape = CircleShape,
                                    color = MaterialTheme.colorScheme.primaryContainer,
                                ) {
                                    Box(contentAlignment = Alignment.Center) {
                                        Text("◎", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Black)
                                    }
                                }
                                Spacer(Modifier.width(12.dp))
                                Column {
                                    Text(
                                        when {
                                            active -> "悬浮球已开启"
                                            starting -> "正在开启截图会话"
                                            overlayGranted -> "上层显示已允许"
                                            else -> "悬浮球未开启"
                                        },
                                        color = Color.White,
                                        style = MaterialTheme.typography.titleMedium,
                                        fontWeight = FontWeight.ExtraBold,
                                    )
                                    Text(
                                        when (state.captureSessionStatus) {
                                            CaptureSessionUiStatus.ACTIVE -> "返回游戏即可看到 QA 悬浮球"
                                            CaptureSessionUiStatus.STARTING -> "请完成明确的整屏截图授权"
                                            CaptureSessionUiStatus.UNAVAILABLE -> "上次授权未完成，可重新开启"
                                            CaptureSessionUiStatus.STOPPED -> if (overlayGranted) {
                                                "下一步授权截图后才会显示悬浮球"
                                            } else {
                                                "先允许在其他应用上层显示"
                                            }
                                        },
                                        color = Color(0xFFB9C7BF),
                                        style = MaterialTheme.typography.bodySmall,
                                    )
                                }
                            }
                            Switch(
                                checked = active,
                                enabled = !starting,
                                onCheckedChange = { enabled ->
                                    if (enabled) onStartCaptureSession() else onStopCaptureSession()
                                },
                                colors = SwitchDefaults.colors(
                                    checkedThumbColor = MaterialTheme.colorScheme.primary,
                                    checkedTrackColor = MaterialTheme.colorScheme.primaryContainer,
                                    uncheckedThumbColor = Color.White,
                                    uncheckedTrackColor = Color(0xFF53655B),
                                ),
                                modifier = Modifier.testTag("capture-toggle"),
                            )
                        }
                        Button(
                            onClick = onStartCaptureSession,
                            enabled = !active && !starting,
                            modifier = Modifier.fillMaxWidth().testTag("start-capture"),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.primaryContainer,
                                contentColor = MaterialTheme.colorScheme.primary,
                            ),
                        ) {
                            Text(
                                when {
                                    starting -> "正在等待截图授权…"
                                    !overlayGranted -> "允许在其他应用上层显示"
                                    else -> "授权整屏截图并开启"
                                },
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            OutlinedButton(
                                onClick = onCaptureNow,
                                enabled = active,
                                modifier = Modifier.weight(1f).testTag("capture-now"),
                                colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White),
                                border = BorderStroke(1.dp, Color(0xFF65786D)),
                            ) { Text("立即截图") }
                            OutlinedButton(
                                onClick = onStopCaptureSession,
                                enabled = active || starting,
                                modifier = Modifier.weight(1f).testTag("stop-capture"),
                                colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White),
                                border = BorderStroke(1.dp, Color(0xFF65786D)),
                            ) { Text("关闭悬浮球") }
                        }
                    }
                }
            }
            item {
                SectionCard(title = "首次开启这样设置", subtitle = "悬浮显示和截图授权分开确认") {
                    InstructionStep("1", "允许在其他应用上层显示", "先在系统设置中允许 QA Hub 显示悬浮球；这一步不会开始截图。")
                    InstructionStep("2", "需要截图时再授权整屏捕获", "返回本页再次点击开启；选择整个屏幕后才会启动取证会话。")
                    InstructionStep("3", "进入游戏后点击悬浮球", "截图会自动带入新建 Bug；普通提单不会被 Poco 失败阻断。")
                }
            }
            item {
                SectionCard(title = "使用事项", subtitle = "减少误触，也避免把悬浮球拍进证据") {
                    UsageNote("单击", "截图并打开新建 Bug")
                    UsageNote("双击", "截图后先暂存，稍后再补内容")
                    UsageNote("拖动", "移动悬浮球位置；截图时它会自动隐藏")
                    UsageNote("测试结束", "回到此页关闭悬浮球，停止屏幕采集")
                }
            }
            item {
                SelfUpdateSection(
                    state = state,
                    onCheck = onCheckForUpdate,
                    onDownload = onDownloadSelfUpdate,
                )
            }
            item {
                GameApkSection(
                    state = state,
                    onRefresh = onRefreshGameApks,
                    onDownload = onDownloadGameApk,
                )
            }
        }
    }
}

@Composable
private fun InstructionStep(number: String, title: String, body: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Surface(
            modifier = Modifier.size(32.dp),
            shape = RoundedCornerShape(10.dp),
            color = MaterialTheme.colorScheme.primaryContainer,
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text(number, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Black)
            }
        }
        Spacer(Modifier.width(11.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.ExtraBold)
            Text(
                body,
                modifier = Modifier.padding(top = 3.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun UsageNote(label: String, body: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            label,
            modifier = Modifier.width(66.dp),
            color = MaterialTheme.colorScheme.primary,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.ExtraBold,
        )
        Text(body, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun SelfUpdateSection(
    state: FoundationUiState,
    onCheck: () -> Unit,
    onDownload: () -> Unit,
) {
    val update = state.selfUpdate
    val release = update.release
    val download = state.apkDownload
    val downloadingThis = release != null && download.artifactId == release.downloadUrl &&
        download.phase in setOf("downloading", "installing")
    SectionCard(
        title = "QA Hub 更新",
        subtitle = "每次启动自动检测新版本；下载后直接打开系统安装页",
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    "当前版本 ${update.currentVersionName}",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.ExtraBold,
                )
                Text(
                    when (update.phase) {
                        "checking" -> "正在检查更新…"
                        "available" -> "发现新版本 ${release?.versionName.orEmpty()}"
                        "up_to_date" -> "已经是最新版"
                        "not_published" -> "更新源暂未发布 APK"
                        "failed" -> "检查失败：${update.errorCode ?: "未知错误"}"
                        else -> "等待检查"
                    },
                    modifier = Modifier.padding(top = 3.dp),
                    color = if (update.phase == "available") {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            TextButton(
                onClick = onCheck,
                enabled = update.phase != "checking" && download.phase != "downloading",
                modifier = Modifier.testTag("check-apk-update"),
            ) { Text("重新检查") }
        }
        if (update.phase == "available" && release != null) {
            Text(
                "${formatBytes(release.sizeBytes)} · 安装包会校验大小、SHA-256、应用包名和版本号。",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
            Button(
                onClick = onDownload,
                enabled = download.phase != "downloading" && download.phase != "installing",
                modifier = Modifier.fillMaxWidth().testTag("download-self-update"),
            ) {
                Text(if (downloadingThis) "正在准备安装…" else "快速下载并更新")
            }
        }
        if (downloadingThis) ApkDownloadProgress(download)
        if (download.phase == "failed" && release != null && download.artifactId == release.downloadUrl) {
            Text(
                "下载或安装失败：${download.errorCode ?: "未知错误"}",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun GameApkSection(
    state: FoundationUiState,
    onRefresh: () -> Unit,
    onDownload: (ApkArtifact) -> Unit,
) {
    val catalog = state.gameApkCatalog
    SectionCard(
        title = "最新游戏 APK",
        subtitle = "来自 10.100.5.129:8000/apk，按上传时间显示最新 5 个",
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                when (catalog.phase) {
                    "loading" -> "正在读取列表…"
                    "ready" -> "共 ${catalog.items.size} 个可下载版本"
                    "failed" -> "读取失败：${catalog.errorCode ?: "未知错误"}"
                    else -> "尚未读取"
                },
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
            TextButton(
                onClick = onRefresh,
                enabled = catalog.phase != "loading",
                modifier = Modifier.testTag("refresh-game-apks"),
            ) { Text("刷新") }
        }
        catalog.items.forEachIndexed { index, artifact ->
            if (index > 0) {
                Surface(
                    modifier = Modifier.fillMaxWidth().height(1.dp),
                    color = MaterialTheme.colorScheme.outlineVariant,
                ) { }
            }
            GameApkRow(
                artifact = artifact,
                download = state.apkDownload,
                onDownload = { onDownload(artifact) },
            )
        }
        if (catalog.phase == "ready" && catalog.items.isEmpty()) {
            Text("目录中暂时没有游戏 APK。", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun GameApkRow(
    artifact: ApkArtifact,
    download: ApkDownloadUiState,
    onDownload: () -> Unit,
) {
    val thisDownload = download.artifactId == artifact.id
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                artifact.versionName?.let { "游戏版本 $it" } ?: artifact.displayName,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.ExtraBold,
            )
            Text(
                artifact.fileName,
                modifier = Modifier.padding(top = 3.dp),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                "${formatBytes(artifact.sizeBytes)} · ${formatEpochMillis(artifact.modifiedAtEpochMs)}",
                modifier = Modifier.padding(top = 3.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelSmall,
            )
            if (thisDownload && download.phase in setOf("downloading", "installing")) {
                ApkDownloadProgress(download)
            }
            if (thisDownload && download.phase == "failed") {
                Text(
                    "下载失败：${download.errorCode ?: "未知错误"}",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
        OutlinedButton(
            onClick = onDownload,
            enabled = download.phase != "downloading" && download.phase != "installing",
            modifier = Modifier.testTag("download-game-apk-${artifact.versionName ?: artifact.fileName}"),
        ) {
            Text(
                when {
                    thisDownload && download.phase == "downloading" -> "${download.progressPercent}%"
                    thisDownload && download.phase == "installing" -> "安装"
                    else -> "下载"
                },
            )
        }
    }
}

@Composable
private fun ApkDownloadProgress(download: ApkDownloadUiState) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        LinearProgressIndicator(
            progress = { download.progressPercent.coerceIn(0, 100) / 100f },
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            if (download.phase == "installing") "下载完成，正在打开系统安装页…"
            else "正在下载 ${download.progressPercent}%",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelSmall,
        )
    }
}

private fun formatBytes(bytes: Long): String = when {
    bytes >= 1024L * 1024L * 1024L -> "%.1f GB".format(bytes / (1024.0 * 1024.0 * 1024.0))
    bytes >= 1024L * 1024L -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
    bytes >= 1024L -> "%.0f KB".format(bytes / 1024.0)
    else -> "$bytes B"
}

private fun formatEpochMillis(value: Long?): String = value?.let { epochMs ->
    runCatching {
        DISPLAY_TIME_FORMAT.format(Instant.ofEpochMilli(epochMs).atZone(ZoneId.systemDefault()))
    }.getOrNull()
} ?: "时间未知"

@Composable
private fun BugListPage(
    state: FoundationUiState,
    onRefresh: () -> Unit,
    onOpenBug: (WorkbenchBug) -> Unit,
    onCloseBug: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var reporterId by rememberSaveable { mutableStateOf<String?>(null) }
    var ownerId by rememberSaveable { mutableStateOf<String?>(null) }
    var statusName by rememberSaveable { mutableStateOf(BugStatusFilter.ALL.name) }
    val status = BugStatusFilter.entries.firstOrNull { it.name == statusName } ?: BugStatusFilter.ALL
    val visibleItems = filterBugs(
        bugs = state.bugWorkbench.items,
        filters = BugListFilters(reporterId = reporterId, ownerId = ownerId, status = status),
    )
    val activePeople = state.people.people.filter { it.active }
    Box(modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        LazyColumn(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .widthIn(max = 1040.dp)
                .testTag("bug-list-page"),
            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 22.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.Bottom,
                ) {
                    PageHeading(
                        eyebrow = "项目 Bug",
                        title = "当前列表",
                        subtitle = "按提交人、责任人和状态快速找到要跟进的问题。",
                    )
                    OutlinedButton(onClick = onRefresh, modifier = Modifier.testTag("refresh-bugs")) {
                        Text("刷新")
                    }
                }
            }
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    shape = RoundedCornerShape(20.dp),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                ) {
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            FilterDropdown(
                                label = "提交人",
                                selectedKey = reporterId,
                                options = listOf(null to "全部提交人") + activePeople.map { it.id to it.displayName },
                                onSelected = { reporterId = it },
                                modifier = Modifier.weight(1f).testTag("filter-reporter"),
                            )
                            FilterDropdown(
                                label = "责任人",
                                selectedKey = ownerId,
                                options = listOf(null to "全部责任人", UNASSIGNED_OWNER_FILTER to "未分配") +
                                    state.people.activeFixers.map { it.id to it.displayName },
                                onSelected = { ownerId = it },
                                modifier = Modifier.weight(1f).testTag("filter-owner"),
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Bottom) {
                            FilterDropdown(
                                label = "状态",
                                selectedKey = status.name,
                                options = BugStatusFilter.entries.map { it.name to it.label },
                                onSelected = { statusName = it ?: BugStatusFilter.ALL.name },
                                modifier = Modifier.weight(1f).testTag("filter-state"),
                            )
                            OutlinedButton(
                                onClick = {
                                    reporterId = null
                                    ownerId = null
                                    statusName = BugStatusFilter.ALL.name
                                },
                                modifier = Modifier.weight(1f).height(48.dp).testTag("show-all-bugs"),
                            ) {
                                Text("全部显示")
                            }
                        }
                        Text(
                            "显示 ${visibleItems.size} 条 · 当前已加载 ${state.bugWorkbench.itemCount} 条",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
            when {
                state.bugWorkbench.phase == "loading" -> item {
                    EmptyListCard("正在刷新项目 Bug…")
                }
                state.bugWorkbench.phase == "failed" -> item {
                    EmptyListCard("暂时无法读取 Bug：${state.bugWorkbench.errorCode ?: "未知错误"}")
                }
                visibleItems.isEmpty() -> item {
                    EmptyListCard("当前筛选下没有 Bug")
                }
                else -> items(visibleItems, key = { it.id }) { bug ->
                    BugRow(bug = bug, people = state.people.people, onClick = { onOpenBug(bug) })
                }
            }
        }
    }
    if (state.bugDetail.phase != "idle") {
        BugDetailDialog(
            state = state.bugDetail,
            people = state.people.people,
            onDismiss = onCloseBug,
        )
    }
}

@Composable
private fun FilterDropdown(
    label: String,
    selectedKey: String?,
    options: List<Pair<String?, String>>,
    onSelected: (String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedLabel = options.firstOrNull { it.first == selectedKey }?.second ?: options.first().second
    Column(modifier) {
        Text(
            label,
            modifier = Modifier.padding(start = 3.dp, bottom = 5.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Bold,
        )
        Box {
            OutlinedButton(
                onClick = { expanded = true },
                modifier = Modifier.fillMaxWidth().height(48.dp),
                shape = RoundedCornerShape(12.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(selectedLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("⌄", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                options.forEach { (key, name) ->
                    DropdownMenuItem(
                        text = { Text(name) },
                        onClick = {
                            onSelected(key)
                            expanded = false
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun EmptyListCard(message: String) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(vertical = 34.dp, horizontal = 18.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Surface(
                modifier = Modifier.size(42.dp),
                shape = RoundedCornerShape(13.dp),
                color = MaterialTheme.colorScheme.primaryContainer,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text("✓", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Black)
                }
            }
            Text(
                message,
                modifier = Modifier.padding(top = 12.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun PageHeading(eyebrow: String, title: String, subtitle: String) {
    Column {
        Text(
            eyebrow,
            color = Color(0xFF6D8A79),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.ExtraBold,
        )
        Text(
            title,
            modifier = Modifier.padding(top = 5.dp),
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Black,
        )
        Text(
            subtitle,
            modifier = Modifier.padding(top = 6.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
private fun SectionCard(
    title: String,
    subtitle: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(20.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Column {
                Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.ExtraBold)
                subtitle?.let {
                    Text(
                        it,
                        modifier = Modifier.padding(top = 3.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            content()
        }
    }
}

@Composable
private fun BugRow(
    bug: WorkbenchBug,
    people: List<QaPerson>,
    onClick: () -> Unit,
) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().testTag("bug-row-${bug.key}"),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(20.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(13.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Surface(
                modifier = Modifier.size(44.dp),
                shape = RoundedCornerShape(13.dp),
                color = priorityContainerColor(bug.priority),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(
                        priorityLabel(bug.priority),
                        color = priorityContentColor(bug.priority),
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Black,
                    )
                }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        bug.key,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.Bold,
                    )
                    BugStatusPill(bug.state)
                }
                Text(
                    bug.description.ifBlank { "暂无内容" },
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.ExtraBold,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        PersonAvatar(personName(people, bug.ownerId, "待分配"))
                        Spacer(Modifier.width(7.dp))
                        Column {
                            Text(
                                personName(people, bug.ownerId, "待分配"),
                                style = MaterialTheme.typography.labelLarge,
                                fontWeight = FontWeight.Bold,
                            )
                            Text(
                                "责任人",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text(
                            displayTime(bug.updatedAt),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Text(
                            "查看详情  ›",
                            color = MaterialTheme.colorScheme.primary,
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun PersonAvatar(name: String) {
    Surface(
        modifier = Modifier.size(34.dp),
        shape = RoundedCornerShape(11.dp),
        color = Color(0xFFDCEEE7),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                name.takeLast(1),
                color = Color(0xFF315148),
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.Black,
            )
        }
    }
}

@Composable
private fun BugStatusPill(state: String) {
    val colors = bugStatusColors(state)
    Surface(shape = RoundedCornerShape(9.dp), color = colors.first) {
        Text(
            bugStateLabel(state),
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp),
            color = colors.second,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.ExtraBold,
        )
    }
}

private fun bugStatusColors(state: String): Pair<Color, Color> = when (state) {
    "ready_for_verification" -> Color(0xFFFFEDE2) to Color(0xFFC95722)
    "closed" -> Color(0xFFEAF8D5) to Color(0xFF4F7B17)
    "in_progress", "awaiting_build" -> Color(0xFFE8F0FF) to Color(0xFF3568D4)
    "needs_info" -> Color(0xFFFFE8E8) to Color(0xFFB84646)
    "deferred", "rejected", "duplicate" -> Color(0xFFF0F1F2) to Color(0xFF626A66)
    else -> Color(0xFFE8F0FF) to Color(0xFF3568D4)
}

private fun priorityLabel(priority: String): String = priority
    .trim()
    .uppercase()
    .takeIf { it.matches(Regex("P[0-4]")) }
    ?: "P3"

private fun priorityContainerColor(priority: String): Color = when (priorityLabel(priority)) {
    "P0", "P1" -> Color(0xFFFFE7E3)
    "P2" -> Color(0xFFFFEDDF)
    else -> Color(0xFFDCE7E2)
}

private fun priorityContentColor(priority: String): Color = when (priorityLabel(priority)) {
    "P0", "P1" -> Color(0xFFB84132)
    "P2" -> Color(0xFFBA5D23)
    else -> Color(0xFF567068)
}

@Composable
private fun BugDetailDialog(
    state: BugDetailUiState,
    people: List<QaPerson>,
    onDismiss: () -> Unit,
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .widthIn(max = 920.dp)
                .fillMaxHeight(0.94f)
                .padding(12.dp),
            shape = RoundedCornerShape(26.dp),
            color = MaterialTheme.colorScheme.background,
            tonalElevation = 8.dp,
        ) {
            Column(Modifier.fillMaxSize()) {
                Surface(color = MaterialTheme.colorScheme.surface) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column {
                            Text(
                                "Bug 详情",
                                style = MaterialTheme.typography.titleLarge,
                                fontWeight = FontWeight.Black,
                            )
                            Text(
                                "内容、图片与当前分工",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        Surface(
                            onClick = onDismiss,
                            modifier = Modifier.testTag("close-bug-detail"),
                            shape = CircleShape,
                            color = MaterialTheme.colorScheme.surfaceVariant,
                        ) {
                            Text(
                                "×",
                                modifier = Modifier.padding(horizontal = 13.dp, vertical = 7.dp),
                                style = MaterialTheme.typography.titleLarge,
                                fontWeight = FontWeight.Medium,
                            )
                        }
                    }
                }
                when (state.phase) {
                    "loading" -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("正在读取详情和图片…")
                    }
                    "failed" -> Box(Modifier.fillMaxSize().padding(20.dp), contentAlignment = Alignment.Center) {
                        Text(
                            "详情读取失败：${state.errorCode ?: "未知错误"}",
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                    else -> state.bug?.let { bug ->
                        LazyColumn(
                            modifier = Modifier.fillMaxSize().testTag("bug-detail"),
                            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 18.dp),
                            verticalArrangement = Arrangement.spacedBy(14.dp),
                        ) {
                            item {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(9.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        bug.key,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        style = MaterialTheme.typography.labelLarge,
                                        fontWeight = FontWeight.Bold,
                                    )
                                    BugStatusPill(bug.state)
                                    Surface(
                                        shape = RoundedCornerShape(8.dp),
                                        color = priorityContainerColor(bug.priority),
                                    ) {
                                        Text(
                                            priorityLabel(bug.priority),
                                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 5.dp),
                                            color = priorityContentColor(bug.priority),
                                            style = MaterialTheme.typography.labelMedium,
                                            fontWeight = FontWeight.Black,
                                        )
                                    }
                                }
                            }
                            item {
                                Card(
                                    modifier = Modifier.fillMaxWidth(),
                                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                                    shape = RoundedCornerShape(20.dp),
                                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                                ) {
                                    Row(Modifier.fillMaxWidth()) {
                                        Spacer(
                                            Modifier
                                                .width(6.dp)
                                                .height(108.dp)
                                                .background(MaterialTheme.colorScheme.primaryContainer),
                                        )
                                        Column(
                                            modifier = Modifier.weight(1f).padding(17.dp),
                                            verticalArrangement = Arrangement.spacedBy(7.dp),
                                        ) {
                                            Text(
                                                "内容",
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                style = MaterialTheme.typography.labelMedium,
                                                fontWeight = FontWeight.Bold,
                                            )
                                            Text(
                                                bug.description.ifBlank { "暂无内容" },
                                                style = MaterialTheme.typography.headlineSmall,
                                                fontWeight = FontWeight.Black,
                                            )
                                        }
                                    }
                                }
                            }
                            items(state.images, key = { it.attachmentId }) { image ->
                                DetailImage(image)
                            }
                            if (state.images.isEmpty()) item {
                                SectionCard("图片") {
                                    Text("本单没有图片", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                            state.imageErrorCode?.let { code ->
                                item { Text("部分图片暂时无法读取：$code", color = MaterialTheme.colorScheme.error) }
                            }
                            item {
                                SectionCard(title = "分工与进度", subtitle = "完整流转操作请在管理网页完成") {
                                    DetailFact("提报人", personName(people, bug.reporterId, "未知"))
                                    DetailFact("责任人", personName(people, bug.ownerId, "待分配"))
                                    DetailFact("验收人", personName(people, bug.verificationOwnerId, "待分配"))
                                    DetailFact("创建时间", displayTime(bug.createdAt))
                                    DetailFact("最后更新", displayTime(bug.updatedAt))
                                    DetailFact("出现次数", bug.occurrenceCount.toString())
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DetailImage(image: WorkbenchBugImage) {
    val bitmap = remember(image.attachmentId, image.bytes) {
        BitmapFactory.decodeByteArray(image.bytes, 0, image.bytes.size)?.asImageBitmap()
    }
    if (bitmap != null) {
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            shape = RoundedCornerShape(20.dp),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "现场图片",
                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.ExtraBold,
                )
                Image(
                    bitmap = bitmap,
                    contentDescription = "Bug 图片",
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)),
                    contentScale = ContentScale.FillWidth,
                )
            }
        }
    }
}

@Composable
private fun DetailFact(label: String, value: String) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        Text(value, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun NewBugPage(
    state: FoundationUiState,
    onCaptureNow: () -> Unit,
    onSubmit: (ByteArray?, String, String, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var content by rememberSaveable(state.currentActorId, state.newBugFormRevision) {
        mutableStateOf("")
    }
    var fixerId by rememberSaveable(state.currentActorId, state.newBugFormRevision) {
        mutableStateOf("")
    }
    var verifierId by rememberSaveable(state.currentActorId, state.newBugFormRevision) {
        mutableStateOf("")
    }
    var savedStrokes by remember(state.newBugFormRevision) {
        mutableStateOf<List<List<Offset>>>(emptyList())
    }
    var editorOpen by remember(state.newBugFormRevision) { mutableStateOf(false) }
    val draft = state.captureDraft
    val image = remember(draft.privatePath) {
        draft.privatePath?.let { BitmapFactory.decodeFile(it)?.asImageBitmap() }
    }
    val fixers = state.people.activeFixers
    val verifiers = state.people.activeVerifiers
    LaunchedEffect(draft.captureId) {
        savedStrokes = emptyList()
        editorOpen = false
    }
    LaunchedEffect(state.currentActorId, state.newBugFormRevision) {
        fixerId = ""
    }
    LaunchedEffect(state.currentActorId, verifiers) {
        if (verifiers.none { it.id == verifierId }) {
            verifierId = state.currentActorId.takeIf { actorId ->
                verifiers.any { it.id == actorId }
            }.orEmpty()
        }
    }

    Box(modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Column(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .widthIn(max = 880.dp)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 18.dp, vertical = 22.dp)
                .testTag("new-bug-page"),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            PageHeading(
                eyebrow = "快速提单",
                title = "新建 Bug",
                subtitle = "只写问题内容，确认分工后即可提交。",
            )
            SectionCard(
                title = "现场图片",
                subtitle = if (image == null) {
                    "可以先截图，也可以直接提交文字 Bug"
                } else {
                    "点击图片才进入标注；当前页面上下滑动不会误画"
                },
            ) {
                if (image != null) {
                    Card(
                        onClick = { editorOpen = true },
                        modifier = Modifier.fillMaxWidth().testTag("capture-preview"),
                        shape = RoundedCornerShape(16.dp),
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                    ) {
                        Box {
                            AnnotationPreview(
                                image = image,
                                strokes = savedStrokes,
                            )
                            Surface(
                                color = MaterialTheme.colorScheme.primary.copy(alpha = 0.9f),
                                shape = RoundedCornerShape(12.dp),
                                modifier = Modifier.align(Alignment.BottomCenter).padding(12.dp),
                            ) {
                                Text(
                                    if (savedStrokes.isEmpty()) {
                                        "点击图片开始标注"
                                    } else {
                                        "已保存 ${savedStrokes.size} 笔 · 点击继续编辑"
                                    },
                                    color = Color.White,
                                    style = MaterialTheme.typography.labelLarge,
                                    fontWeight = FontWeight.Bold,
                                    modifier = Modifier.padding(horizontal = 13.dp, vertical = 8.dp),
                                )
                            }
                        }
                    }
                } else {
                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(16.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant,
                    ) {
                        Column(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp, horizontal = 18.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Surface(
                                modifier = Modifier.size(44.dp),
                                shape = CircleShape,
                                color = MaterialTheme.colorScheme.primaryContainer,
                            ) {
                                Box(contentAlignment = Alignment.Center) {
                                    Text("◎", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Black)
                                }
                            }
                            Text(
                                "还没有截图",
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.ExtraBold,
                            )
                            OutlinedButton(onClick = onCaptureNow, modifier = Modifier.testTag("new-bug-capture-now")) {
                                Text("立即截图")
                            }
                        }
                    }
                }
            }
            SectionCard(title = "Bug 内容", subtitle = "不需要标题，直接描述看到的问题") {
                OutlinedTextField(
                    value = content,
                    onValueChange = { content = it },
                    label = { Text("问题内容") },
                    placeholder = { Text("例如：结算页面点击返回后一直停留在加载状态") },
                    minLines = 5,
                    shape = RoundedCornerShape(16.dp),
                    modifier = Modifier.fillMaxWidth().testTag("bug-content"),
                )
            }
            SectionCard(title = "分配", subtitle = "验收人默认自己，负责人默认留空、可稍后认领") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    PersonPicker(
                        label = "负责人",
                        people = fixers,
                        role = QaPersonRole.FIXER,
                        selectedId = fixerId,
                        onSelected = { fixerId = it },
                        allowUnassigned = true,
                        modifier = Modifier.weight(1f),
                    )
                    PersonPicker(
                        label = "验收人",
                        people = verifiers,
                        role = QaPersonRole.VERIFIER,
                        selectedId = verifierId,
                        onSelected = { verifierId = it },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            Button(
                onClick = {
                    val bytes = image?.takeIf { savedStrokes.isNotEmpty() }?.let {
                        renderAnnotatedPng(draft = draft, strokes = savedStrokes)
                    }
                    onSubmit(bytes, content, fixerId, verifierId)
                },
                enabled = content.isNotBlank() && verifierId.isNotBlank(),
                modifier = Modifier.fillMaxWidth().height(56.dp).testTag("submit-bug"),
                shape = RoundedCornerShape(16.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = Color.White,
                    disabledContainerColor = Color(0xFFDDE3DF),
                    disabledContentColor = Color(0xFF8A958E),
                ),
            ) {
                Text("提交 Bug", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.ExtraBold)
            }
            if (state.lastAction.isNotBlank()) {
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(14.dp),
                    color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.42f),
                ) {
                    Text(
                        state.lastAction,
                        modifier = Modifier.padding(13.dp),
                        color = MaterialTheme.colorScheme.primary,
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
    }
    if (editorOpen && image != null) {
        AnnotationEditorDialog(
            image = image,
            initialStrokes = savedStrokes,
            onCancel = { editorOpen = false },
            onSave = {
                savedStrokes = it
                editorOpen = false
            },
        )
    }
}

@Composable
private fun AnnotationPreview(image: ImageBitmap, strokes: List<List<Offset>>) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(image.width.toFloat() / image.height.toFloat()),
    ) {
        Image(
            bitmap = image,
            contentDescription = "待提交的截图预览",
            contentScale = ContentScale.FillBounds,
            modifier = Modifier.fillMaxSize(),
        )
        Canvas(Modifier.fillMaxSize()) {
            strokes.forEach { points ->
                points.zipWithNext().forEach { (start, end) ->
                    drawLine(
                        color = Color.Red,
                        start = Offset(start.x * size.width, start.y * size.height),
                        end = Offset(end.x * size.width, end.y * size.height),
                        strokeWidth = 6f,
                    )
                }
            }
        }
    }
}

@Composable
private fun AnnotationEditorDialog(
    image: ImageBitmap,
    initialStrokes: List<List<Offset>>,
    onCancel: () -> Unit,
    onSave: (List<List<Offset>>) -> Unit,
) {
    val activity = LocalContext.current.findActivity()
    val forceLandscape = image.width > image.height
    DisposableEffect(activity, forceLandscape) {
        val previousOrientation = activity?.requestedOrientation
        if (activity != null && forceLandscape) {
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        }
        onDispose {
            if (activity != null && forceLandscape && previousOrientation != null) {
                activity.requestedOrientation = previousOrientation
            }
        }
    }
    var strokes by remember { mutableStateOf(initialStrokes) }
    var currentStroke by remember { mutableStateOf<List<Offset>>(emptyList()) }
    Dialog(
        onDismissRequest = onCancel,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().padding(bottom = 12.dp)) {
                Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 4.dp) {
                    Row(
                        modifier = Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 10.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        TextButton(onClick = onCancel) { Text("取消") }
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(
                                "截图标注",
                                style = MaterialTheme.typography.titleLarge,
                                fontWeight = FontWeight.Black,
                            )
                            Text(
                                "画圈或手绘",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                        Button(
                            onClick = {
                                val completed = strokes + listOfNotNull(currentStroke.takeIf { it.size > 1 })
                                onSave(completed)
                            },
                            shape = RoundedCornerShape(12.dp),
                        ) { Text("保存") }
                    }
                }
                Surface(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.42f),
                ) {
                    Text(
                        "这里才会启用画笔；点击保存后标注才会带入 Bug。",
                        color = MaterialTheme.colorScheme.primary,
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 13.dp, vertical = 9.dp),
                    )
                }
                BoxWithConstraints(
                    modifier = Modifier.fillMaxWidth().weight(1f).padding(horizontal = 12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    val imageAspect = image.width.toFloat() / image.height.toFloat()
                    val availableAspect = maxWidth.value / maxHeight.value.coerceAtLeast(1f)
                    val canvasModifier = if (availableAspect > imageAspect) {
                        Modifier.fillMaxHeight().aspectRatio(imageAspect)
                    } else {
                        Modifier.fillMaxWidth().aspectRatio(imageAspect)
                    }
                    AnnotationCanvas(
                        image = image,
                        strokes = strokes,
                        currentStroke = currentStroke,
                        onStartStroke = { currentStroke = listOf(it) },
                        onContinueStroke = { point -> currentStroke = currentStroke + point },
                        onFinishStroke = {
                            if (currentStroke.size > 1) strokes = strokes + listOf(currentStroke)
                            currentStroke = emptyList()
                        },
                        modifier = canvasModifier,
                    )
                }
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedButton(
                        onClick = { if (strokes.isNotEmpty()) strokes = strokes.dropLast(1) },
                        enabled = strokes.isNotEmpty(),
                        modifier = Modifier.weight(1f),
                    ) { Text("撤销") }
                    OutlinedButton(
                        onClick = { strokes = emptyList(); currentStroke = emptyList() },
                        enabled = strokes.isNotEmpty() || currentStroke.isNotEmpty(),
                        modifier = Modifier.weight(1f),
                    ) { Text("清除") }
                }
            }
        }
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

@Composable
private fun AnnotationCanvas(
    image: ImageBitmap,
    strokes: List<List<Offset>>,
    currentStroke: List<Offset>,
    onStartStroke: (Offset) -> Unit,
    onContinueStroke: (Offset) -> Unit,
    onFinishStroke: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(Color.Black)
            .pointerInput(Unit) {
                fun normalized(position: Offset): Offset = Offset(
                    x = (position.x / size.width.coerceAtLeast(1)).coerceIn(0f, 1f),
                    y = (position.y / size.height.coerceAtLeast(1)).coerceIn(0f, 1f),
                )
                detectDragGestures(
                    onDragStart = { onStartStroke(normalized(it)) },
                    onDrag = { change, _ ->
                        change.consume()
                        onContinueStroke(normalized(change.position))
                    },
                    onDragEnd = onFinishStroke,
                    onDragCancel = onFinishStroke,
                )
            },
    ) {
        Image(
            bitmap = image,
            contentDescription = "正在标注的截图",
            contentScale = ContentScale.FillBounds,
            modifier = Modifier.fillMaxSize(),
        )
        Canvas(Modifier.fillMaxSize()) {
            fun drawStroke(points: List<Offset>) {
                points.zipWithNext().forEach { (start, end) ->
                    drawLine(
                        color = Color.Red,
                        start = Offset(start.x * size.width, start.y * size.height),
                        end = Offset(end.x * size.width, end.y * size.height),
                        strokeWidth = 6f,
                    )
                }
            }
            strokes.forEach(::drawStroke)
            drawStroke(currentStroke)
        }
    }
}

@Composable
private fun PersonPicker(
    label: String,
    people: List<QaPerson>,
    role: QaPersonRole,
    selectedId: String,
    onSelected: (String) -> Unit,
    allowUnassigned: Boolean = false,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = people.firstOrNull { it.id == selectedId }
    Column(modifier) {
        Text(
            label,
            modifier = Modifier.padding(start = 3.dp, bottom = 5.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Bold,
        )
        Box(Modifier.fillMaxWidth()) {
            OutlinedButton(
                onClick = { expanded = true },
                modifier = Modifier.fillMaxWidth().height(52.dp).testTag("picker-$label"),
                shape = RoundedCornerShape(14.dp),
                contentPadding = PaddingValues(horizontal = 11.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(
                        modifier = Modifier.weight(1f),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        selected?.let {
                            PersonAvatar(it.displayName)
                            Spacer(Modifier.width(7.dp))
                        }
                        Text(
                            selected?.displayName ?: if (allowUnassigned) "暂不指定" else "请选择",
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Text("⌄", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                if (allowUnassigned) {
                    DropdownMenuItem(
                        text = { Text("暂不指定") },
                        onClick = { onSelected(""); expanded = false },
                    )
                }
                people.filter { role in it.roles }.forEach { person ->
                    DropdownMenuItem(
                        text = { Text(person.displayName) },
                        onClick = { onSelected(person.id); expanded = false },
                    )
                }
                if (people.isEmpty()) {
                    DropdownMenuItem(
                        text = { Text("请先配置 qa-people.json") },
                        onClick = { expanded = false },
                    )
                }
            }
        }
    }
}

private fun renderAnnotatedPng(
    draft: CaptureDraftUiState,
    strokes: List<List<Offset>>,
): ByteArray? {
    val path = draft.privatePath ?: return null
    val source = BitmapFactory.decodeFile(path) ?: return null
    val bitmap = source.copy(Bitmap.Config.ARGB_8888, true)
    source.recycle()
    val canvas = Canvas(bitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = AndroidColor.RED
        style = Paint.Style.STROKE
        strokeWidth = (6f * bitmap.width / 1080f).coerceAtLeast(2f)
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    strokes.forEach { points ->
        if (points.size < 2) return@forEach
        val pathObject = Path()
        pathObject.moveTo(points.first().x * bitmap.width, points.first().y * bitmap.height)
        points.drop(1).forEach { point ->
            pathObject.lineTo(point.x * bitmap.width, point.y * bitmap.height)
        }
        canvas.drawPath(pathObject, paint)
    }
    return ByteArrayOutputStream().use { output ->
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
        bitmap.recycle()
        output.toByteArray()
    }
}

private fun personName(people: List<QaPerson>, id: String?, fallback: String): String =
    id?.let { personId -> people.firstOrNull { it.id == personId }?.displayName } ?: fallback

private fun bugStateLabel(state: String): String = when (state) {
    "reported" -> "待处理"
    "needs_info" -> "已打回"
    "ready" -> "待处理"
    "in_progress" -> "处理中"
    "awaiting_build" -> "等待构建"
    "ready_for_verification" -> "待验收"
    "closed" -> "已完成"
    "deferred" -> "已延期"
    "rejected" -> "已拒绝"
    "duplicate" -> "重复"
    else -> state
}

private fun displayTime(value: String): String = runCatching {
    DISPLAY_TIME_FORMAT.format(OffsetDateTime.parse(value).atZoneSameInstant(ZoneId.systemDefault()))
}.getOrDefault(value)

private val DISPLAY_TIME_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
