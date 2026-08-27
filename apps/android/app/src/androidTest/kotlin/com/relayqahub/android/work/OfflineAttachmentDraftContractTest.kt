package com.relayqahub.android.work

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.relayqahub.android.data.OfflineOperationEntity
import com.relayqahub.android.data.QueueState
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OfflineAttachmentDraftContractTest {
    @Test
    fun `durable draft round trips fields assignments and both images`() {
        val request = OfflineAttachmentDraftContract.buildOperation(
            projectId = PROJECT_ID,
            staged = StagedOfflineBugDraft(
                submissionId = SUBMISSION_ID,
                observedAt = "2026-08-26T02:03:04Z",
                qaAppVersion = "0.1.0-debug",
                title = "Lobby button is clipped",
                description = "The right edge disappears after rotation.",
                expectedBehavior = "The full button remains visible.",
                ownerId = OWNER_ID,
                verificationOwnerId = VERIFIER_ID,
                captureId = CAPTURE_ID,
                capturedAtEpochMs = 1_777_777_777_000L,
                attachments = listOf(
                    attachment(ORIGINAL_ID, "capture.png", OfflineAttachmentDraftContract.ROLE_ORIGINAL),
                    attachment(ANNOTATED_ID, "capture-annotated.png", OfflineAttachmentDraftContract.ROLE_ANNOTATED),
                ),
            ),
        )

        val parsed = OfflineAttachmentDraftContract.parse(
            OfflineOperationEntity(
                operationId = OPERATION_ID,
                accountId = ACCOUNT_ID,
                projectId = PROJECT_ID,
                actorId = ACTOR_ID,
                installationId = INSTALLATION_ID,
                sessionId = SESSION_ID,
                operationKind = request.operationKind,
                httpMethod = request.httpMethod,
                relativePath = request.relativePath,
                payloadJson = request.payloadJson,
                idempotencyKey = request.idempotencyKey,
                state = QueueState.PENDING,
                attemptCount = 0,
                nextAttemptAtEpochMs = 0,
                lastErrorCode = null,
                createdAtEpochMs = 0,
                updatedAtEpochMs = 0,
            ),
        )

        assertEquals("Lobby button is clipped", parsed.title)
        assertEquals(OWNER_ID, parsed.ownerId)
        assertEquals(VERIFIER_ID, parsed.verificationOwnerId)
        assertEquals(CAPTURE_ID, parsed.captureId)
        assertEquals(listOf(ORIGINAL_ID, ANNOTATED_ID), parsed.attachments.map { it.clientAttachmentId })
    }

    private fun attachment(id: String, filename: String, role: String) = StagedOfflineAttachment(
        clientAttachmentId = id,
        filename = filename,
        expectedSize = 4,
        sha256 = "a".repeat(64),
        role = role,
    )

    private companion object {
        const val OPERATION_ID = "00000000-0000-4000-8000-000000000001"
        const val ACCOUNT_ID = "00000000-0000-4000-8000-000000000002"
        const val PROJECT_ID = "00000000-0000-4000-8000-000000000003"
        const val ACTOR_ID = "00000000-0000-4000-8000-000000000004"
        const val INSTALLATION_ID = "00000000-0000-4000-8000-000000000005"
        const val SESSION_ID = "00000000-0000-4000-8000-000000000006"
        const val SUBMISSION_ID = "00000000-0000-4000-8000-000000000007"
        const val OWNER_ID = "00000000-0000-4000-8000-000000000008"
        const val VERIFIER_ID = "00000000-0000-4000-8000-000000000009"
        const val CAPTURE_ID = "00000000-0000-4000-8000-000000000010"
        const val ORIGINAL_ID = "00000000-0000-4000-8000-000000000011"
        const val ANNOTATED_ID = "00000000-0000-4000-8000-000000000012"
    }
}
