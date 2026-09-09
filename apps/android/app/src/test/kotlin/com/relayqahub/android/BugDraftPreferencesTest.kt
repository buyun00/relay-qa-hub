package com.relayqahub.android

import android.content.SharedPreferences
import com.relayqahub.android.data.AccountProjectScope
import com.relayqahub.android.data.NewOfflineOperation
import com.relayqahub.android.data.OfflineOperationEntity
import com.relayqahub.android.data.QueueState
import com.relayqahub.android.data.noBugPostRejectionFingerprint
import com.relayqahub.android.data.commitDurableBugDraft
import com.relayqahub.android.network.AttachmentUploadCheckpoint
import java.lang.reflect.Proxy
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BugDraftPreferencesTest {
    private val original = SavedBugDraft("original content", "fixer", "verifier")
    private val pending = PendingBugSubmission("submission-1", "attachment-1", original, null)
    private val scope = scopedIdentity("http://127.0.0.1:4419/api/v1/", "account", "project", "person")
    private val request = NewOfflineOperation("CREATE_BUG", "POST", "/bugs",
        """{"clientSubmissionId":"submission-1","description":"original immutable text","attachmentIds":["attachment-1"]}""",
        "submission:submission-1:commit")

    @Test
    fun `pending text submission survives a new preferences instance and other project activity`() {
        val storage = MemoryPreferences()
        val first = BugDraftPreferences(storage.value)
        first.save("server-project-person", original)
        first.savePending("server-project-person", pending)
        first.save("other-project", SavedBugDraft("other content"))
        val reopened = BugDraftPreferences(storage.value)
        assertEquals(pending, reopened.pending("server-project-person"))
        assertEquals(original, reopened.read("server-project-person"))
        assertEquals(null, reopened.pending("other-project"))
        assertFalse(reopened.confirmPending("server-project-person", "different-submission"))
        assertEquals(pending, reopened.pending("server-project-person"))
        assertTrue(reopened.confirmPending("server-project-person", pending.submissionId))
        assertEquals(SavedBugDraft(), reopened.read("server-project-person"))
        assertEquals(null, reopened.pending("server-project-person"))
        assertEquals("other content", reopened.read("other-project").content)
    }

    @Test
    fun `edited draft never replaces pending intent and survives original confirmation`() {
        val preferences = BugDraftPreferences(MemoryPreferences().value)
        preferences.save("scope", original)
        preferences.savePending("scope", pending)
        val changed = SavedBugDraft("edited while waiting", "another fixer", "another verifier")
        preferences.save("scope", changed)
        assertEquals(pending, preferences.pending("scope"))
        assertTrue(runCatching {
            preferences.savePending("scope", pending.copy(submissionId = "replacement"))
        }.isFailure)
        assertFalse(preferences.confirmPending("scope", pending.submissionId))
        assertEquals(changed, preferences.read("scope"))
        assertEquals(null, preferences.pending("scope"))
    }

    @Test
    fun `legacy pending submission with unknown original text conservatively keeps edits`() {
        val preferences = BugDraftPreferences(MemoryPreferences().value)
        preferences.save("scope", original)
        preferences.savePending("scope", pending.copy(originalDraft = null))
        assertFalse(preferences.confirmPending("scope", pending.submissionId))
        assertEquals(original, preferences.read("scope"))
    }

    @Test
    fun `new capture preserves the current draft even when its text is unchanged`() {
        val preferences = BugDraftPreferences(MemoryPreferences().value)
        preferences.save("scope", original)
        preferences.savePending("scope", pending)
        assertFalse(preferences.confirmPending("scope", pending.submissionId, preserveDraft = true))
        assertEquals(original, preferences.read("scope"))
        assertEquals(null, preferences.pending("scope"))
    }

    @Test
    fun `same capture confirmation cannot clear later annotation edits with unchanged text`() {
        val preferences = BugDraftPreferences(MemoryPreferences().value)
        preferences.save("scope", original)
        preferences.savePending("scope", pending.copy(captureId = "same-capture"))
        // The capture ID alone cannot prove that the open editor still contains the original pixels.
        assertFalse(preferences.confirmPending("scope", pending.submissionId))
        assertEquals(original, preferences.read("scope"))
        assertEquals(null, preferences.pending("scope"))
    }

    @Test
    fun `full queue scope survives relogin and refuses any changed scope even with same draft key`() {
        val storage = MemoryPreferences()
        val preferences = BugDraftPreferences(storage.value)
        val bound = pending.copy(scope = scope, request = request)
        preferences.savePending("draft-key", bound)
        val reopened = checkNotNull(BugDraftPreferences(storage.value).pending("draft-key"))
        val relogged = scopedIdentity("http://127.0.0.1:4419/api/v1/", "account", "project", "person")
        assertEquals(scope, relogged)
        assertEquals(request, reopened.preparedRequest(relogged))
        // Draft preference keys omit account/session/installation; the immutable intent does not.
        for (foreign in listOf(scope.copy(accountId = "other"), scope.copy(projectId = "other"),
            scope.copy(actorId = "other"), scope.copy(installationId = "other"), scope.copy(sessionId = "other"))) {
            assertTrue(runCatching { reopened.preparedRequest(foreign) }.isFailure)
        }
        assertEquals(bound, preferences.pending("draft-key"))
    }

    @Test
    fun `prepared recovery preserves original payload while missing queued row or scope fails closed`() {
        val storage = MemoryPreferences()
        val preferences = BugDraftPreferences(storage.value)
        val prepared = pending.copy(scope = scope, request = request)
        preferences.savePending("scope", prepared)
        preferences.save("scope", SavedBugDraft("edited while app was stopped"))
        assertEquals(request, checkNotNull(preferences.pending("scope")).preparedRequest(scope))
        assertTrue(runCatching { preferences.savePending("scope",
            prepared.copy(request = request.copy(payloadJson = "changed"))) }.isFailure)
        preferences.markQueued("scope", pending.submissionId, "original-operation")
        val queued = checkNotNull(BugDraftPreferences(storage.value).pending("scope"))
        assertEquals(request, queued.request)
        assertEquals("original-operation", queued.operationId)
        assertTrue(runCatching { queued.preparedRequest(scope) }.isFailure)
        assertTrue(runCatching { preferences.markQueued("scope", pending.submissionId, "replacement-operation") }.isFailure)
        assertTrue(runCatching { pending.preparedRequest(scope) }.isFailure)
        assertEquals("edited while app was stopped", preferences.read("scope").content)
    }

    @Test
    fun `adopted legacy text persists exact queue identity without claiming the current form is its payload`() {
        val originalRequest = request.copy(payloadJson =
            """{"projectId":"${scope.projectId}","clientSubmissionId":"submission-1","description":"code22 original"}""")
        val row = OfflineOperationEntity("code22-operation", scope.accountId, scope.projectId,
            scope.actorId, scope.installationId, scope.sessionId, originalRequest.operationKind,
            originalRequest.httpMethod, originalRequest.relativePath, originalRequest.payloadJson,
            originalRequest.idempotencyKey, QueueState.FAILED_PERMANENT, 4, 100, "RETRY_EXHAUSTED_NETWORK_IO", 0, 100)
        val adopted = PendingBugSubmission.fromQueuedCreate(scope, row)
        val storage = MemoryPreferences()
        val preferences = BugDraftPreferences(storage.value)
        preferences.save("scope", original)
        preferences.savePending("scope", adopted)
        val reopened = checkNotNull(BugDraftPreferences(storage.value).pending("scope"))
        assertEquals("code22-operation", reopened.operationId)
        assertEquals(originalRequest, reopened.request)
        assertEquals(null, reopened.originalDraft)
        assertFalse(preferences.confirmPending("scope", adopted.submissionId))
        assertEquals(original, preferences.read("scope"))
        assertTrue(runCatching { PendingBugSubmission.fromQueuedCreate(scope.copy(sessionId = "other"), row) }.isFailure)
        assertTrue(runCatching { PendingBugSubmission.fromQueuedCreate(scope,
            row.copy(idempotencyKey = "submission:other:commit")) }.isFailure)
    }

    private fun rejectedAttachmentRow() = OfflineOperationEntity(
        "rejected-stage", scope.accountId, scope.projectId, scope.actorId, scope.installationId, scope.sessionId,
        "STAGE_CREATE_BUG_ATTACHMENT", "POST", "/bugs",
        """{"projectId":"${scope.projectId}","clientSubmissionId":"submission-1","attachments":[{"clientAttachmentId":"original-image"}]}""",
        "submission:submission-1:commit", QueueState.FAILED_PERMANENT, 1, 100,
        "ATTACHMENT_FINALIZE_HTTP_400", 0, 100,
    )

    @Test
    fun `explicit attachment rejection recovery durably retains old intent before permitting modified draft`() {
        val storage = MemoryPreferences()
        val preferences = BugDraftPreferences(storage.value)
        val row = rejectedAttachmentRow()
        val failed = PendingBugSubmission.fromQueuedCreate(scope, row)
        preferences.save("scope", original)
        preferences.savePending("scope", failed)
        assertFalse(preferences.isReleasedRejection("scope", row))
        preferences.releaseRejectedBeforeBugPost("scope", scope, row)
        val reopened = BugDraftPreferences(storage.value)
        assertEquals(null, reopened.pending("scope"))
        assertTrue(reopened.isReleasedRejection("scope", row))
        assertEquals(original, reopened.read("scope"))
        val retained = org.json.JSONObject(checkNotNull(storage.value.getString(
            "rejected-original:scope:${row.operationId}:${row.noBugPostRejectionFingerprint()}", null)))
        assertEquals(row.operationId, retained.getString("operationId"))
        assertEquals(row.payloadJson, retained.getJSONObject("request").getString("payloadJson"))
        val retainedFailure = org.json.JSONObject(checkNotNull(storage.value.getString(
            "rejected-state:scope:${row.operationId}:${row.noBugPostRejectionFingerprint()}", null)))
        assertEquals(row.lastErrorCode, retainedFailure.getString("lastErrorCode"))
        assertEquals(row.state.name, retainedFailure.getString("state"))
        assertEquals(row.payloadJson, retainedFailure.getString("payloadJson"))
        reopened.savePending("scope", pending.copy(submissionId = "new-explicit-intent", attachmentId = "new-image"))
        assertTrue(reopened.isReleasedRejection("scope", row))
        assertEquals("new-explicit-intent", reopened.pending("scope")?.submissionId)
    }

    @Test
    fun `failed rejection commit never claims release or removes original pending intent`() {
        val storage = MemoryPreferences()
        val preferences = BugDraftPreferences(storage.value)
        val row = rejectedAttachmentRow()
        val failed = PendingBugSubmission.fromQueuedCreate(scope, row)
        preferences.savePending("scope", failed)
        storage.rejectCommit = true
        assertTrue(runCatching { preferences.releaseRejectedBeforeBugPost("scope", scope, row) }.isFailure)
        assertEquals(failed, preferences.pending("scope"))
        assertFalse(preferences.isReleasedRejection("scope", row))
    }

    @Test
    fun `failed disk commit with updated preference memory still cannot release the failed intent`() {
        val storage = MemoryPreferences()
        val preferences = BugDraftPreferences(storage.value)
        val row = rejectedAttachmentRow()
        preferences.savePending("scope", PendingBugSubmission.fromQueuedCreate(scope, row))
        storage.rejectCommit = true
        storage.updateMemoryWhenCommitFails = true
        assertTrue(runCatching { preferences.releaseRejectedBeforeBugPost("scope", scope, row) }.isFailure)
        assertFalse(preferences.isReleasedRejection("scope", row))
        // Legacy discovery will re-adopt this un-released row instead of assigning a new intent.
        assertEquals(null, preferences.pending("scope"))
    }

    @Test
    fun `release proof cannot cover a changed row phase payload error or execution attempt`() {
        val preferences = BugDraftPreferences(MemoryPreferences().value)
        val row = rejectedAttachmentRow()
        preferences.savePending("scope", PendingBugSubmission.fromQueuedCreate(scope, row))
        preferences.releaseRejectedBeforeBugPost("scope", scope, row)
        for (changed in listOf(row.copy(operationKind = "CREATE_BUG"), row.copy(state = QueueState.RETRY),
            row.copy(payloadJson = "changed"), row.copy(lastErrorCode = "ATTACHMENT_CHUNK_HTTP_400"),
            row.copy(attemptCount = 2), row.copy(sessionId = "different"))) {
            assertFalse(preferences.isReleasedRejection("scope", changed))
        }
    }

    @Test
    fun `unknown core effects cannot be released by a subsequent 4xx or success violation`() {
        for (code in listOf("HTTP_400", "HTTP_403", "HTTP_422", "UNEXPECTED_CREATE_BUG_SUCCESS_STATUS_200",
            "SUCCESS_RESPONSE_SCOPE_MISMATCH", "SUCCESS_RECEIPT_SCOPE_MISMATCH", "RETRY_EXHAUSTED_NETWORK_IO")) {
            val preferences = BugDraftPreferences(MemoryPreferences().value)
            val row = rejectedAttachmentRow().copy(operationKind = "CREATE_BUG", lastErrorCode = code, attemptCount = 5)
            val pendingCore = PendingBugSubmission.fromQueuedCreate(scope, row)
            preferences.savePending("scope", pendingCore)
            assertEquals(null, row.noBugPostRejectionFingerprint())
            assertTrue(runCatching { preferences.releaseRejectedBeforeBugPost("scope", scope, row) }.isFailure)
            assertEquals(pendingCore, preferences.pending("scope"))
        }
    }

    @Test
    fun `only exact known attachment rejection stages permit explicit no-Bug-POST recovery`() {
        val row = rejectedAttachmentRow()
        for (stage in listOf("INIT", "CHUNK", "FINALIZE", "BIND")) {
            for (status in listOf(400, 413, 415, 422)) {
                assertTrue(row.copy(lastErrorCode = "ATTACHMENT_${stage}_HTTP_$status").noBugPostRejectionFingerprint() != null)
            }
        }
        for (code in listOf("OFFLINE_ATTACHMENT_SIZE_MISMATCH", "OFFLINE_ATTACHMENT_HASH_MISMATCH")) {
            assertTrue(row.copy(lastErrorCode = code).noBugPostRejectionFingerprint() != null)
        }
        for (code in listOf("ATTACHMENT_INIT_HTTP_403", "ATTACHMENT_INIT_HTTP_409", "HTTP_400",
            "RETRY_EXHAUSTED_ATTACHMENT_NETWORK_IO", "INVALID_OFFLINE_ATTACHMENT_DRAFT", "SUCCESS_RECEIPT_SCOPE_MISMATCH")) {
            assertEquals(null, row.copy(lastErrorCode = code).noBugPostRejectionFingerprint())
        }
    }

    @Test
    fun `scheduler failure after queue commit keeps actual media and durable original intent`() = runBlocking {
        val storage = MemoryPreferences()
        val preferences = BugDraftPreferences(storage.value)
        val directory = Files.createTempDirectory("qa-hub-durable-draft-")
        val image = directory.resolve("original.png")
        val bytes = byteArrayOf(0x50, 0x4e, 0x47, 1, 2, 3)
        val hash = MessageDigest.getInstance("SHA-256").digest(bytes).toList()
        val rows = linkedMapOf<String, NewOfflineOperation>()
        try {
            val result = runCatching {
                commitDurableBugDraft(
                    prepare = { Files.write(image, bytes); request },
                    saveIntent = { preferences.savePending("scope", pending.copy(scope = scope, request = it)) },
                    enqueue = { rows["original-operation"] = it; "original-operation" },
                    markQueued = { preferences.markQueued("scope", pending.submissionId, it) },
                    schedule = { error("Synthetic scheduler unavailable after commit") },
                    discardStaged = { Files.delete(image) },
                )
            }
            assertTrue(result.isFailure)
            assertEquals(mapOf("original-operation" to request), rows)
            assertEquals(hash, MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(image)).toList())
            val reopened = checkNotNull(BugDraftPreferences(storage.value).pending("scope"))
            assertEquals(request, reopened.request)
            assertEquals("original-operation", reopened.operationId)
        } finally {
            Files.deleteIfExists(image)
            Files.delete(directory)
        }
    }

    @Test
    fun `queue insertion failure keeps prepared intent and media for original request recovery`() = runBlocking {
        val preferences = BugDraftPreferences(MemoryPreferences().value)
        var discarded = false
        assertTrue(runCatching {
            commitDurableBugDraft(
                prepare = { request },
                saveIntent = { preferences.savePending("scope", pending.copy(scope = scope, request = it)) },
                enqueue = { error("Synthetic Room insertion failure") },
                markQueued = { error("Must not mark queued") },
                schedule = { error("Must not dispatch") },
                discardStaged = { discarded = true },
            )
        }.isFailure)
        assertFalse(discarded)
        assertEquals(request, checkNotNull(preferences.pending("scope")).preparedRequest(scope))
    }

    @Test
    fun `preparation failure without durable references can discard incomplete staging`() = runBlocking {
        var discarded = false
        assertTrue(runCatching {
            commitDurableBugDraft(
                prepare = { error("Synthetic attachment staging failure") },
                saveIntent = { error("Must not save an incomplete intent") },
                enqueue = { error("Must not queue") },
                markQueued = { error("Must not mark queued") },
                schedule = { error("Must not dispatch") },
                discardStaged = { discarded = true },
            )
        }.isFailure)
        assertTrue(discarded)
    }

    @Test
    fun `failed disk commit cannot claim confirmation or forget the identity`() {
        val storage = MemoryPreferences()
        val preferences = BugDraftPreferences(storage.value)
        preferences.save("scope", original)
        preferences.savePending("scope", pending)
        storage.rejectCommit = true
        assertTrue(runCatching { preferences.confirmPending("scope", pending.submissionId) }.isFailure)
        assertEquals(pending, BugDraftPreferences(storage.value).pending("scope"))
        assertEquals(original, preferences.read("scope"))
    }

    @Test
    fun `corrupted pending metadata fails closed instead of allocating a fresh identity`() {
        val storage = MemoryPreferences()
        storage.value.edit().putString("pending:scope", "broken-json").commit()
        val preferences = BugDraftPreferences(storage.value)
        assertTrue(runCatching { preferences.pending("scope") }.isFailure)
        assertTrue(runCatching { preferences.savePending("scope", pending) }.isFailure)
    }

    @Test
    fun `verification submission keeps one identity and frozen blocked evidence across retry and project activity`() {
        val storage = MemoryPreferences()
        val preferences = BugDraftPreferences(storage.value)
        val verificationScope = AccountProjectScope(
            accountId = "10000000-0000-4000-8000-000000000001",
            projectId = "20000000-0000-4000-8000-000000000001",
            actorId = "30000000-0000-4000-8000-000000000001",
            installationId = "40000000-0000-4000-8000-000000000001",
            sessionId = "50000000-0000-4000-8000-000000000001",
        )
        val bugId = "60000000-0000-4000-8000-000000000001"
        val verificationId = "70000000-0000-4000-8000-000000000001"
        val clientAttachmentId = "80000000-0000-4000-8000-000000000001"
        val attachmentId = "90000000-0000-4000-8000-000000000001"
        val sessionId = "90000000-0000-4000-8000-000000000002"
        val bindingId = "90000000-0000-4000-8000-000000000003"
        val captureBundleId = "a0000000-0000-4000-8000-000000000001"

        val opened = preferences.openVerification("project-one", verificationScope, bugId, verificationId)
        val frozen = FrozenVerificationResult(
            verificationId = verificationId,
            expectedVersion = 2,
            status = "blocked",
            resultSummary = "测试环境尚未就绪",
            attachmentIds = listOf(attachmentId),
            captureBundleId = captureBundleId,
            blockedReason = "测试环境尚未就绪",
        )
        val captureBound = opened.copy(captureBundleId = captureBundleId)
        preferences.saveVerification("project-one", captureBound)
        preferences.saveVerification(
            "project-one",
            captureBound.copy(
                attachments = listOf(
                    PendingVerificationAttachment(
                        clientAttachmentId = clientAttachmentId,
                        filename = "blocked-evidence.png",
                        mediaType = "image/png",
                        expectedSize = 3,
                        sha256 = "a".repeat(64),
                        attachmentId = attachmentId,
                        uploadCheckpoint = AttachmentUploadCheckpoint(
                            sessionId = sessionId,
                            chunkSize = 262_144,
                            expectedChunkCount = 1,
                            confirmedChunks = listOf(0),
                            uploadVersion = 2,
                            uploadExpiresAt = "2090-01-01T00:00:00Z",
                            attachmentId = attachmentId,
                            finalizedVersion = 3,
                            finalizeConfirmed = true,
                            bindingId = bindingId,
                            leaseGeneration = 1,
                            bindingVersion = 4,
                            bindingExpiresAt = "2090-01-01T00:15:00Z",
                        ),
                    ),
                ),
                frozenResult = frozen,
            ),
        )
        preferences.openVerification(
            "other-project",
            verificationScope.copy(projectId = "20000000-0000-4000-8000-000000000002"),
            "60000000-0000-4000-8000-000000000002",
            "70000000-0000-4000-8000-000000000002",
        )

        val restartedPreferences = BugDraftPreferences(storage.value)
        val crossSessionFailure = runCatching {
            restartedPreferences.pendingVerificationForBug(
                "project-one",
                verificationScope.copy(sessionId = "50000000-0000-4000-8000-000000000099"),
                bugId,
            )
        }.exceptionOrNull()
        assertTrue(crossSessionFailure is IllegalStateException)
        val reopened = restartedPreferences.pendingVerificationForBug(
            "project-one",
            verificationScope,
            bugId,
        )
        assertEquals(opened.clientSubmissionId, reopened?.clientSubmissionId)
        assertEquals(frozen, reopened?.frozenResult)
        assertEquals(bindingId, reopened?.attachments?.single()?.uploadCheckpoint?.bindingId)
        assertEquals(null, preferences.confirmVerification("project-one", verificationId, UUID.randomUUID().toString()))
        assertEquals(opened.clientSubmissionId, preferences.pendingVerification("project-one", verificationId)?.clientSubmissionId)
        assertEquals(opened.clientSubmissionId, preferences.confirmVerification(
            "project-one", verificationId, opened.clientSubmissionId,
        )?.clientSubmissionId)
        assertEquals(null, preferences.pendingVerificationForBug("project-one", verificationScope, bugId))
    }

    @Test
    fun `verification persistence accepts canonical frozen ids for reverse attachment selection`() {
        val storage = MemoryPreferences()
        val preferences = BugDraftPreferences(storage.value)
        val verificationScope = AccountProjectScope(
            "10000000-0000-4000-8000-000000000001",
            "20000000-0000-4000-8000-000000000001",
            "30000000-0000-4000-8000-000000000001",
            "40000000-0000-4000-8000-000000000001",
            "50000000-0000-4000-8000-000000000001",
        )
        val bugId = "60000000-0000-4000-8000-000000000001"
        val verificationId = "70000000-0000-4000-8000-000000000001"
        val firstId = "80000000-0000-4000-8000-000000000001"
        val secondId = "80000000-0000-4000-8000-000000000002"
        val opened = preferences.openVerification("ordered", verificationScope, bugId, verificationId)
        fun attachment(index: Int, attachmentId: String) = PendingVerificationAttachment(
            clientAttachmentId = "90000000-0000-4000-8000-00000000000$index",
            filename = "$index.png",
            mediaType = "image/png",
            expectedSize = 1,
            sha256 = index.toString().repeat(64),
            attachmentId = attachmentId,
            uploadCheckpoint = AttachmentUploadCheckpoint(
                sessionId = "a0000000-0000-4000-8000-00000000000$index",
                chunkSize = 262_144,
                expectedChunkCount = 1,
                confirmedChunks = listOf(0),
                uploadVersion = 2,
                uploadExpiresAt = "2090-01-01T00:00:00Z",
                attachmentId = attachmentId,
                finalizedVersion = 3,
                finalizeConfirmed = true,
                bindingId = "b0000000-0000-4000-8000-00000000000$index",
                leaseGeneration = 1,
                bindingVersion = 4,
                bindingExpiresAt = "2090-01-01T00:15:00Z",
            ),
        )
        val selectedInReverse = listOf(attachment(2, secondId), attachment(1, firstId))
        val frozen = FrozenVerificationResult(
            verificationId,
            2,
            "passed",
            "Passed",
            listOf(firstId, secondId),
        )

        preferences.saveVerification(
            "ordered",
            opened.copy(attachments = selectedInReverse, frozenResult = frozen),
        )

        val reopened = checkNotNull(BugDraftPreferences(storage.value).pendingVerification("ordered", verificationId))
        assertEquals(listOf(secondId, firstId), reopened.attachments.map { it.attachmentId })
        assertEquals(listOf(firstId, secondId), reopened.frozenResult?.attachmentIds)
    }

    @Test
    fun `verification capture identity locks when upload init is durably checkpointed`() {
        val storage = MemoryPreferences()
        val preferences = BugDraftPreferences(storage.value)
        val verificationScope = AccountProjectScope(
            "10000000-0000-4000-8000-000000000001",
            "20000000-0000-4000-8000-000000000001",
            "30000000-0000-4000-8000-000000000001",
            "40000000-0000-4000-8000-000000000001",
            "50000000-0000-4000-8000-000000000001",
        )
        val bugId = "60000000-0000-4000-8000-000000000001"
        val verificationId = "70000000-0000-4000-8000-000000000001"
        val firstCaptureId = "80000000-0000-4000-8000-000000000001"
        val otherCaptureId = "80000000-0000-4000-8000-000000000002"
        val opened = preferences.openVerification("capture-lock", verificationScope, bugId, verificationId)
        val initialized = opened.copy(
            captureBundleId = firstCaptureId,
            attachments = listOf(
                PendingVerificationAttachment(
                    clientAttachmentId = "90000000-0000-4000-8000-000000000001",
                    filename = "evidence.png",
                    mediaType = "image/png",
                    expectedSize = 3,
                    sha256 = "a".repeat(64),
                    uploadCheckpoint = AttachmentUploadCheckpoint(
                        sessionId = "a0000000-0000-4000-8000-000000000001",
                        chunkSize = 262_144,
                        expectedChunkCount = 1,
                        uploadVersion = 1,
                        uploadExpiresAt = "2090-01-01T00:00:00Z",
                    ),
                ),
            ),
        )
        preferences.saveVerification("capture-lock", opened.copy(captureBundleId = firstCaptureId))
        preferences.saveVerification("capture-lock", initialized)

        val reopened = checkNotNull(
            BugDraftPreferences(storage.value).pendingVerification("capture-lock", verificationId),
        )
        assertEquals(firstCaptureId, reopened.captureBundleId)
        assertTrue(
            runCatching {
                preferences.saveVerification(
                    "capture-lock",
                    reopened.copy(captureBundleId = otherCaptureId),
                )
            }.isFailure,
        )
        assertEquals(
            firstCaptureId,
            BugDraftPreferences(storage.value)
                .pendingVerification("capture-lock", verificationId)
                ?.captureBundleId,
        )
    }

    @Test
    fun `verification persistence rejects out of contract upload checkpoint bounds`() {
        val preferences = BugDraftPreferences(MemoryPreferences().value)
        val verificationScope = AccountProjectScope(
            "10000000-0000-4000-8000-000000000001",
            "20000000-0000-4000-8000-000000000001",
            "30000000-0000-4000-8000-000000000001",
            "40000000-0000-4000-8000-000000000001",
            "50000000-0000-4000-8000-000000000001",
        )
        val opened = preferences.openVerification(
            "checkpoint-bounds",
            verificationScope,
            "60000000-0000-4000-8000-000000000001",
            "70000000-0000-4000-8000-000000000001",
        )
        fun submission(chunkSize: Int, chunkCount: Int) = opened.copy(
            attachments = listOf(
                PendingVerificationAttachment(
                    clientAttachmentId = "80000000-0000-4000-8000-000000000001",
                    filename = "evidence.png",
                    mediaType = "image/png",
                    expectedSize = 3,
                    sha256 = "a".repeat(64),
                    uploadCheckpoint = AttachmentUploadCheckpoint(
                        sessionId = "90000000-0000-4000-8000-000000000001",
                        chunkSize = chunkSize,
                        expectedChunkCount = chunkCount,
                        uploadVersion = 1,
                        uploadExpiresAt = "2090-01-01T00:00:00Z",
                    ),
                ),
            ),
        )

        assertTrue(
            runCatching {
                preferences.saveVerification("checkpoint-bounds", submission(262_143, 1))
            }.isFailure,
        )
        assertTrue(
            runCatching {
                preferences.saveVerification("checkpoint-bounds", submission(262_144, 2_001))
            }.isFailure,
        )
    }

    @Test
    fun `verification submission rejects replacement identity scope instance and frozen payload`() {
        val preferences = BugDraftPreferences(MemoryPreferences().value)
        val verificationScope = AccountProjectScope(
            "10000000-0000-4000-8000-000000000001",
            "20000000-0000-4000-8000-000000000001",
            "30000000-0000-4000-8000-000000000001",
            "40000000-0000-4000-8000-000000000001",
            "50000000-0000-4000-8000-000000000001",
        )
        val bugId = "60000000-0000-4000-8000-000000000001"
        val verificationId = "70000000-0000-4000-8000-000000000001"
        val opened = preferences.openVerification("scope", verificationScope, bugId, verificationId)
        assertTrue(runCatching {
            preferences.saveVerification("scope", opened.copy(clientSubmissionId = UUID.randomUUID().toString()))
        }.isFailure)
        assertTrue(runCatching {
            preferences.openVerification(
                "scope", verificationScope, bugId, "70000000-0000-4000-8000-000000000002",
            )
        }.isFailure)
        assertTrue(runCatching {
            preferences.pendingVerificationForBug(
                "scope",
                verificationScope.copy(projectId = "20000000-0000-4000-8000-000000000002"),
                bugId,
            )
        }.isFailure)
        val frozen = FrozenVerificationResult(
            verificationId, 2, "passed", "通过", emptyList(),
        )
        preferences.saveVerification("scope", opened.copy(frozenResult = frozen))
        assertTrue(runCatching {
            preferences.saveVerification(
                "scope",
                opened.copy(frozenResult = frozen.copy(status = "failed", failureReason = "改成失败")),
            )
        }.isFailure)
        assertEquals(frozen, preferences.pendingVerification("scope", verificationId)?.frozenResult)
    }

    /** Implements only the storage boundary; all draft serialization and decisions use the real class. */
    private class MemoryPreferences {
        private val strings = mutableMapOf<String, String>()
        var rejectCommit = false
        var updateMemoryWhenCommitFails = false
        val value = Proxy.newProxyInstance(
            SharedPreferences::class.java.classLoader, arrayOf(SharedPreferences::class.java),
        ) { _, method, args ->
            when (method.name) {
                "getString" -> strings[args[0] as String] ?: args[1]
                "edit" -> editor()
                else -> error("Unexpected preference read ${method.name}")
            }
        } as SharedPreferences

        private fun editor(): SharedPreferences.Editor {
            val changes = mutableMapOf<String, String?>()
            return Proxy.newProxyInstance(
                SharedPreferences.Editor::class.java.classLoader,
                arrayOf(SharedPreferences.Editor::class.java),
            ) { proxy, method, args ->
                when (method.name) {
                    "putString" -> { changes[args[0] as String] = args[1] as String?; proxy }
                    "remove" -> { changes[args[0] as String] = null; proxy }
                    "commit" -> {
                        if (!rejectCommit || updateMemoryWhenCommitFails) changes.forEach { (key, value) ->
                            if (value == null) strings.remove(key) else strings[key] = value
                        }
                        !rejectCommit
                    }
                    else -> error("Unexpected preference write ${method.name}")
                }
            } as SharedPreferences.Editor
        }
    }
}
