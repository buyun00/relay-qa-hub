package com.relayqahub.android.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.relayqahub.android.FoundationUiState

internal fun submissionStatusText(state: FoundationUiState): String? {
    val latest = when (state.latestDeliveryState) {
        "PENDING" -> "内容已保存在本机，正在准备上传。"
        "RUNNING" -> "正在上传，内容已保存在本机，请勿重复提交。"
        "RETRY" -> "上传未完成，内容已保存在本机，将自动重试。"
        "BLOCKED_AUTH" -> "上传被登录验证阻止，内容仍保存在本机。"
        "BLOCKED_DEVICE" -> "设备暂时无法完成上传，内容仍保存在本机。"
        "FAILED_PERMANENT" -> "上传失败，内容仍保存在本机，需要处理。"
        "SUCCEEDED" -> state.latestQaItemKey?.let { "已提交成功：$it。" }
            ?: "正在核对提交回执。"
        else -> null
    }
    val outstanding = state.queuedOperationCount.takeIf { it > 0 }
        ?.let { "本机还有 $it 条提交未成功。" }
    val error = state.latestDeliveryError?.takeIf {
        state.latestDeliveryState != "SUCCEEDED" && it.isNotBlank()
    }?.let { "错误：$it" }
    return listOfNotNull(latest, outstanding, error).takeIf { it.isNotEmpty() }?.joinToString("\n")
}

@Composable
internal fun SubmissionStatusCard(state: FoundationUiState) {
    val text = submissionStatusText(state) ?: return
    Surface(
        modifier = Modifier.fillMaxWidth().testTag("submission-status"),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.primaryContainer,
    ) {
        Text(text, modifier = Modifier.padding(14.dp), style = MaterialTheme.typography.bodyMedium)
    }
}
