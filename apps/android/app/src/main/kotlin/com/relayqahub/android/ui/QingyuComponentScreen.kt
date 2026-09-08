package com.relayqahub.android.ui

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import com.relayqahub.android.network.*
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

@Composable
fun QingyuComponentScreen(api: ProjectOperationsClient, project: QaProject, token: String, enabled: Boolean, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var session by remember(project.id) { mutableStateOf<JSONObject?>(null) }
    var projects by remember(project.id) { mutableStateOf<List<JSONObject>>(emptyList()) }
    var externalProject by remember(project.id) { mutableStateOf<JSONObject?>(null) }
    var defects by remember(project.id) { mutableStateOf<List<JSONObject>>(emptyList()) }
    var selected by remember(project.id) { mutableStateOf<Set<String>>(emptySet()) }
    var result by remember(project.id) { mutableStateOf<List<JSONObject>>(emptyList()) }
    var busy by remember(project.id) { mutableStateOf(false) }
    var error by remember(project.id) { mutableStateOf<String?>(null) }
    fun perform(action: suspend () -> Unit) {
        if (busy) return
        busy = true; error = null
        scope.launch { try { action() } catch (failure: Exception) { error = failure.message } finally { busy = false } }
    }
    suspend fun refreshSession(poll: Boolean = false) {
        session = api.request("integrations/qingyu/${if (poll) "login/status" else "session"}", token)
        if (session?.optBoolean("authenticated") == true) projects = api.request("integrations/qingyu/projects", token).objects()
    }
    suspend fun loadDefects() {
        val id = externalProject?.getString("id") ?: return
        defects = api.request("integrations/qingyu/defects?projectId=${java.net.URLEncoder.encode(id, "UTF-8")}", token).objects("defects")
    }
    LaunchedEffect(project.id) { perform { refreshSession() } }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        TextButton(onClick = onBack) { Text("返回项目") }
        Text("第三方订单 · ${project.name}", style = MaterialTheme.typography.headlineSmall)
        if (!enabled) Text("组件未启用或待配置；历史 Bug 与本地状态不受影响。")
        error?.let { Text("请求失败：$it", color = MaterialTheme.colorScheme.error) }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (session?.optBoolean("authenticated") != true) {
            Button(enabled = enabled && !busy, onClick = { perform { session = api.request("integrations/qingyu/login/start", token, "POST") } }) { Text("连接第三方账号") }
            val qrContent = session?.optJSONObject("login")?.optString("qrContent").orEmpty()
            val qr = remember(qrContent) { if (qrContent.isBlank()) null else runCatching {
                val matrix = MultiFormatWriter().encode(qrContent, BarcodeFormat.QR_CODE, 480, 480)
                Bitmap.createBitmap(480, 480, Bitmap.Config.ARGB_8888).apply {
                    val pixels = IntArray(480 * 480) { index -> if (matrix[index % 480, index / 480]) android.graphics.Color.BLACK else android.graphics.Color.WHITE }
                    setPixels(pixels, 0, 480, 0, 0, 480, 480)
                }.asImageBitmap()
            }.getOrNull() }
            qr?.let { Image(it, "第三方登录二维码", Modifier.size(240.dp)) }
            if (qrContent.isNotBlank()) TextButton(enabled = !busy, onClick = { perform { refreshSession(true) } }) { Text("已扫码，检查连接") }
        } else {
            Text("已连接：${session?.optJSONObject("user")?.optString("name").orEmpty()}")
            TextButton(enabled = !busy, onClick = { perform {
                session = api.request("integrations/qingyu/logout", token, "POST")
                projects = emptyList(); defects = emptyList(); selected = emptySet(); externalProject = null
            } }) { Text("断开当前项目连接") }
            Text("第三方项目", style = MaterialTheme.typography.titleMedium)
            projects.forEach { item -> TextButton(enabled = !busy, onClick = { externalProject = item; selected = emptySet(); perform { loadDefects() } }) {
                Text((if (externalProject?.optString("id") == item.optString("id")) "✓ " else "") + item.optString("name"))
            } }
            defects.forEach { defect ->
                val id = defect.getString("id")
                val actionable = defect.optBoolean("actionable") && (defect.isNull("importedBugId") || defect.optString("importedBugId").isBlank())
                Card(Modifier.fillMaxWidth()) { Row(Modifier.padding(10.dp)) {
                    Checkbox(id in selected, enabled = enabled && actionable && !busy, onCheckedChange = { checked -> selected = if (checked) selected + id else selected - id })
                    Column { Text(defect.optString("title")); Text("${defect.optString("code")} · ${defect.optString("status")}"); Text(defect.optString("description")) }
                } }
            }
            Button(enabled = enabled && !busy && selected.isNotEmpty(), onClick = { perform {
                val id = checkNotNull(externalProject).getString("id")
                result = api.request("integrations/qingyu/import", token, "POST", JSONObject().put("projectId", id)
                    .put("defectIds", JSONArray(selected.toList()))).objects()
                selected = emptySet(); loadDefects()
            } }) { Text("导入选中的 ${selected.size} 个订单") }
        }
        result.forEach { item -> Text("${item.optString("defectId")}：${item.optString("status")} ${item.optString("errorMessage")}") }
    }
}
