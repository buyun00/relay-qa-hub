package com.relayqahub.android.ui

import com.relayqahub.android.FoundationUiState
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SubmissionStatusTest {
    @Test
    fun `pending submission cannot reuse an older successful bug key`() {
        val text = submissionStatusText(FoundationUiState(
            latestDeliveryState = "PENDING", latestQaItemKey = "LOCAL-OLD", queuedOperationCount = 1,
        ))!!
        assertTrue(text.contains("保存在本机"))
        assertFalse(text.contains("LOCAL-OLD"))
        assertFalse(text.contains("提交成功"))
    }

    @Test
    fun `permanent failures stay visible even after a newer submission succeeds`() {
        val text = submissionStatusText(FoundationUiState(
            latestDeliveryState = "SUCCEEDED", latestQaItemKey = "LOCAL-NEW", queuedOperationCount = 2,
        ))!!
        assertTrue(text.contains("LOCAL-NEW"))
        assertTrue(text.contains("还有 2 条提交未成功"))
    }

    @Test
    fun `network failures explain persistence and retry without pretending success`() {
        val text = submissionStatusText(FoundationUiState(
            latestDeliveryState = "RETRY", latestDeliveryError = "NETWORK_IO", queuedOperationCount = 1,
        ))!!
        assertTrue(text.contains("保存在本机"))
        assertTrue(text.contains("自动重试"))
        assertTrue(text.contains("NETWORK_IO"))
    }

    @Test
    fun `success requires a receipt key`() {
        val text = submissionStatusText(FoundationUiState(latestDeliveryState = "SUCCEEDED"))!!
        assertFalse(text.contains("提交成功"))
    }
}
