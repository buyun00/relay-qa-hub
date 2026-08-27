package com.relayqahub.android.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Color as AndroidColor
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.relayqahub.android.CaptureDraftUiState
import com.relayqahub.android.FoundationUiState
import com.relayqahub.android.FoundationViewModel
import com.relayqahub.android.QaHubPage
import com.relayqahub.android.QaPerson
import com.relayqahub.android.QaPersonRole
import com.relayqahub.android.network.WorkbenchBug
import java.io.ByteArrayOutputStream

@Composable
fun FoundationScreen(
    viewModel: FoundationViewModel,
    onStartCaptureSession: () -> Unit,
    onCaptureNow: () -> Unit,
    onStopCaptureSession: () -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    if (state.accountSession.phase != "signed_in") {
        AccountLoginScreen(
            loading = state.accountSession.phase == "loading",
            errorCode = state.accountSession.errorCode,
            onLogin = viewModel::login,
        )
        return
    }
    LaunchedEffect(state.page) {
        if (state.page != QaHubPage.NEW_BUG) viewModel.refreshBugWorkbench()
    }
    Scaffold(
        modifier = Modifier.fillMaxSize(),
        topBar = {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        text = "Relay QA Hub",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        state.accountSession.displayName.orEmpty(),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                OutlinedButton(onClick = viewModel::logout) { Text("退出") }
            }
        },
        bottomBar = {
            NavigationBar(Modifier.navigationBarsPadding()) {
                NavigationBarItem(
                    selected = state.page == QaHubPage.MY_BUGS,
                    onClick = { viewModel.navigateTo(QaHubPage.MY_BUGS) },
                    icon = { Text("我") },
                    label = { Text("我提交的 Bug") },
                )
                NavigationBarItem(
                    selected = state.page == QaHubPage.PROJECT_BUGS,
                    onClick = { viewModel.navigateTo(QaHubPage.PROJECT_BUGS) },
                    icon = { Text("全") },
                    label = { Text("项目全部 Bug") },
                )
                NavigationBarItem(
                    selected = state.page == QaHubPage.NEW_BUG,
                    onClick = { viewModel.navigateTo(QaHubPage.NEW_BUG) },
                    icon = { Text("+") },
                    label = { Text("新建 Bug") },
                )
            }
        },
    ) { innerPadding ->
        when (state.page) {
            QaHubPage.MY_BUGS -> BugListPage(
                state = state,
                mineOnly = true,
                modifier = Modifier.padding(innerPadding),
            )
            QaHubPage.PROJECT_BUGS -> BugListPage(
                state = state,
                mineOnly = false,
                modifier = Modifier.padding(innerPadding),
            )
            QaHubPage.NEW_BUG -> NewBugPage(
                state = state,
                onStartCaptureSession = onStartCaptureSession,
                onCaptureNow = onCaptureNow,
                onStopCaptureSession = onStopCaptureSession,
                onSubmit = viewModel::submitNewBug,
                modifier = Modifier.padding(innerPadding),
            )
        }
    }
}

@Composable
private fun AccountLoginScreen(
    loading: Boolean,
    errorCode: String?,
    onLogin: (String) -> Unit,
) {
    var name by rememberSaveable { mutableStateOf("") }
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Card(Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier.padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text("进入 Relay QA Hub", style = MaterialTheme.typography.headlineSmall)
                Text("输入姓名即可登录；后端没有记录时会自动创建新账号。")
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("姓名") },
                    singleLine = true,
                    enabled = !loading,
                    modifier = Modifier.fillMaxWidth().testTag("account-name"),
                )
                if (errorCode != null) {
                    Text(
                        if (errorCode == "INVALID_REQUEST") "请输入有效的姓名。" else "登录失败：$errorCode",
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                Button(
                    onClick = { onLogin(name) },
                    enabled = !loading,
                    modifier = Modifier.fillMaxWidth().testTag("account-login"),
                ) {
                    Text(if (loading) "正在登录…" else "登录")
                }
            }
        }
    }
}

@Composable
private fun BugListPage(
    state: FoundationUiState,
    mineOnly: Boolean,
    modifier: Modifier = Modifier,
) {
    val items = if (mineOnly) {
        state.bugWorkbench.items.filter { it.reporterId == state.accountSession.userId }
    } else {
        state.bugWorkbench.items
    }
    var selected by remember { mutableStateOf<WorkbenchBug?>(null) }
    Column(
        modifier = modifier.fillMaxSize().padding(horizontal = 16.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                if (mineOnly) "我提交的 Bug" else "项目全部 Bug",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
            )
            Text("${items.size}", color = MaterialTheme.colorScheme.primary)
        }
        when {
            state.bugWorkbench.phase == "loading" -> Text("正在刷新…", Modifier.padding(vertical = 16.dp))
            state.bugWorkbench.phase == "failed" -> Text(
                "暂时无法读取 Bug：${state.bugWorkbench.errorCode ?: "未知错误"}",
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(vertical = 16.dp),
            )
            items.isEmpty() -> Text("暂无 Bug", Modifier.padding(vertical = 16.dp))
            else -> LazyColumn(
                modifier = Modifier.fillMaxSize().testTag(if (mineOnly) "my-bugs" else "project-bugs"),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 20.dp),
            ) {
                items(items, key = { it.id }) { bug -> BugRow(bug) { selected = bug } }
            }
        }
        selected?.let { bug -> BugDetailCard(bug) { selected = null } }
    }
}

@Composable
private fun BugRow(bug: WorkbenchBug, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("${bug.key}  ${bug.title}", fontWeight = FontWeight.SemiBold)
            Text("状态：${bug.state}", color = MaterialTheme.colorScheme.primary)
            Text("更新：${bug.updatedAt}", style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun BugDetailCard(bug: WorkbenchBug, onDismiss: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("${bug.key} 详情", fontWeight = FontWeight.Bold)
            Text(bug.title)
            if (bug.description.isNotBlank()) Text(bug.description)
            Text("当前状态：${bug.state}")
            Text("出现次数：${bug.occurrenceCount}")
            OutlinedButton(onClick = onDismiss) { Text("收起") }
        }
    }
}

@Composable
private fun NewBugPage(
    state: FoundationUiState,
    onStartCaptureSession: () -> Unit,
    onCaptureNow: () -> Unit,
    onStopCaptureSession: () -> Unit,
    onSubmit: (ByteArray?, String, String, String, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var title by rememberSaveable { mutableStateOf("") }
    var description by rememberSaveable { mutableStateOf("") }
    var fixerId by rememberSaveable { mutableStateOf("") }
    var verifierId by rememberSaveable { mutableStateOf("") }
    var strokes by remember { mutableStateOf<List<List<Offset>>>(emptyList()) }
    var currentStroke by remember { mutableStateOf<List<Offset>>(emptyList()) }
    var canvasSize by remember { mutableStateOf(IntSize.Zero) }
    val draft = state.captureDraft
    val image = remember(draft.privatePath) {
        draft.privatePath?.let { BitmapFactory.decodeFile(it)?.asImageBitmap() }
    }
    val fixers = state.people.activeFixers
    val verifiers = state.people.activeVerifiers

    Column(
        modifier = modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("新建 Bug", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onStartCaptureSession) { Text("开启悬浮球") }
            OutlinedButton(onClick = onCaptureNow) { Text("立即截图") }
            OutlinedButton(onClick = onStopCaptureSession) { Text("停止") }
        }
        if (image != null) {
            Text("截图已载入，可在图上画圈或手绘标记。", style = MaterialTheme.typography.bodySmall)
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
                onSizeChanged = { canvasSize = it },
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { if (strokes.isNotEmpty()) strokes = strokes.dropLast(1) },
                    enabled = strokes.isNotEmpty(),
                ) { Text("撤销") }
                OutlinedButton(
                    onClick = { strokes = emptyList(); currentStroke = emptyList() },
                    enabled = strokes.isNotEmpty() || currentStroke.isNotEmpty(),
                ) { Text("清除标记") }
            }
        } else {
            Text("尚未选择截图；仍可提交文字 Bug。", style = MaterialTheme.typography.bodySmall)
        }
        OutlinedTextField(
            value = title,
            onValueChange = { title = it },
            label = { Text("标题") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = description,
            onValueChange = { description = it },
            label = { Text("问题描述") },
            minLines = 4,
            modifier = Modifier.fillMaxWidth(),
        )
        PersonPicker("修复人", fixers, QaPersonRole.FIXER, fixerId) { fixerId = it }
        PersonPicker("验收人", verifiers, QaPersonRole.VERIFIER, verifierId) { verifierId = it }
        Button(
            onClick = {
                val completedStrokes = strokes +
                    listOfNotNull(currentStroke.takeIf { it.size > 1 })
                val bytes = image?.takeIf { completedStrokes.isNotEmpty() }?.let {
                    renderAnnotatedPng(
                        draft = draft,
                        strokes = completedStrokes,
                        canvasSize = canvasSize,
                    )
                }
                onSubmit(bytes, title, description, fixerId, verifierId)
            },
            enabled = title.isNotBlank() && description.isNotBlank() &&
                fixerId.isNotBlank() && verifierId.isNotBlank(),
            modifier = Modifier.fillMaxWidth().testTag("submit-bug"),
        ) { Text("一键提交") }
        if (state.lastAction.isNotBlank()) Text(state.lastAction, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun AnnotationCanvas(
    image: ImageBitmap,
    strokes: List<List<Offset>>,
    currentStroke: List<Offset>,
    onStartStroke: (Offset) -> Unit,
    onContinueStroke: (Offset) -> Unit,
    onFinishStroke: () -> Unit,
    onSizeChanged: (IntSize) -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(image.width.toFloat() / image.height.toFloat())
            .clip(RoundedCornerShape(12.dp))
            .background(Color.Black)
            .onSizeChanged(onSizeChanged)
            .pointerInput(Unit) {
                detectDragGestures(
                    onDragStart = onStartStroke,
                    onDrag = { change, _ -> onContinueStroke(change.position) },
                    onDragEnd = onFinishStroke,
                    onDragCancel = onFinishStroke,
                )
            },
    ) {
        Image(
            bitmap = image,
            contentDescription = "待提交的截图",
            contentScale = ContentScale.FillBounds,
            modifier = Modifier.fillMaxSize(),
        )
        Canvas(Modifier.fillMaxSize()) {
            fun drawStroke(points: List<Offset>) {
                points.zipWithNext().forEach { (start, end) ->
                    drawLine(Color.Red, start, end, strokeWidth = 6f)
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
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = people.firstOrNull { it.id == selectedId }
    Box(Modifier.fillMaxWidth()) {
        OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) {
            Text(selected?.displayName ?: "选择$label")
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            people.filter { role in it.roles }.forEach { person ->
                DropdownMenuItem(
                    text = { Text(person.displayName) },
                    onClick = { onSelected(person.id); expanded = false },
                )
            }
            if (people.isEmpty()) {
                DropdownMenuItem(
                    text = { Text("后端没有可用人员") },
                    onClick = { expanded = false },
                )
            }
        }
    }
}

private fun renderAnnotatedPng(
    draft: CaptureDraftUiState,
    strokes: List<List<Offset>>,
    canvasSize: IntSize,
): ByteArray? {
    val path = draft.privatePath ?: return null
    val source = BitmapFactory.decodeFile(path) ?: return null
    val bitmap = source.copy(Bitmap.Config.ARGB_8888, true)
    source.recycle()
    if (canvasSize.width > 0 && canvasSize.height > 0) {
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = AndroidColor.RED
            style = Paint.Style.STROKE
            strokeWidth = (6f * bitmap.width / canvasSize.width).coerceAtLeast(2f)
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        val sx = bitmap.width.toFloat() / canvasSize.width
        val sy = bitmap.height.toFloat() / canvasSize.height
        strokes.forEach { points ->
            if (points.size < 2) return@forEach
            val pathObject = Path()
            pathObject.moveTo(points.first().x * sx, points.first().y * sy)
            points.drop(1).forEach { point -> pathObject.lineTo(point.x * sx, point.y * sy) }
            canvas.drawPath(pathObject, paint)
        }
    }
    return ByteArrayOutputStream().use { output ->
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
        bitmap.recycle()
        output.toByteArray()
    }
}
