package com.relayqahub.android

import android.content.Context
import android.content.SharedPreferences
import com.relayqahub.android.data.AccountProjectScope
import com.relayqahub.android.data.NewOfflineOperation
import com.relayqahub.android.data.OfflineOperationEntity
import com.relayqahub.android.data.isCreateIntent
import com.relayqahub.android.data.noBugPostRejectionFingerprint
import com.relayqahub.android.network.AttachmentUploadCheckpoint
import java.time.OffsetDateTime
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

data class SavedBugDraft(val content: String = "", val fixerId: String = "", val verifierId: String = "")

/**
 * Durable evidence identity for one Verification instance.
 *
 * The server binds upload reservations and the final result to the same client submission ID.
 * Keeping the complete scope here prevents a project switch or relogin from reusing that identity.
 */
data class PendingVerificationAttachment(
    val clientAttachmentId: String,
    val filename: String,
    val mediaType: String,
    val expectedSize: Int,
    val sha256: String,
    val attachmentId: String? = null,
    val uploadCheckpoint: AttachmentUploadCheckpoint = AttachmentUploadCheckpoint(),
)

data class FrozenVerificationResult(
    val verificationId: String,
    val expectedVersion: Int,
    val status: String,
    val resultSummary: String,
    val attachmentIds: List<String>,
    val captureBundleId: String? = null,
    val failureReason: String? = null,
    val blockedReason: String? = null,
)

data class PendingVerificationSubmission(
    val scope: AccountProjectScope,
    val bugId: String,
    val verificationId: String,
    val clientSubmissionId: String,
    val attachments: List<PendingVerificationAttachment> = emptyList(),
    val captureBundleId: String? = null,
    val frozenResult: FrozenVerificationResult? = null,
) {
    fun requireScope(current: AccountProjectScope, currentBugId: String, currentVerificationId: String) {
        check(
            scope.accountId == current.accountId &&
                scope.projectId == current.projectId &&
                scope.actorId == current.actorId &&
                scope.installationId == current.installationId &&
                scope.sessionId == current.sessionId &&
                bugId == currentBugId &&
                verificationId == currentVerificationId
        ) {
            "请回到原服务、项目、Bug 和验收轮次重试；原验收证据已保留。"
        }
    }
}

data class PendingBugSubmission(
    val submissionId: String,
    val attachmentId: String,
    val originalDraft: SavedBugDraft?,
    val captureId: String?,
    val scope: AccountProjectScope? = null,
    val request: NewOfflineOperation? = null,
    val operationId: String? = null,
) {
    fun requireScope(current: AccountProjectScope) {
        check(scope == current) { "请回到原服务、项目和登录身份确认上次提交；当前草稿已保留。" }
    }

    fun preparedRequest(current: AccountProjectScope): NewOfflineOperation {
        requireScope(current)
        check(operationId == null) { "原队列记录暂时无法读取；不能用新记录替代，请恢复本地队列。" }
        return checkNotNull(request) { "原提交内容暂时无法读取；请恢复本地提交记录。" }
    }

    companion object {
        fun fromQueuedCreate(
            scope: AccountProjectScope,
            operation: OfflineOperationEntity,
            captureId: String? = null,
            captureAttachmentId: String? = null,
        ): PendingBugSubmission {
            check(operation.isCreateIntent())
            check(scope == AccountProjectScope(operation.accountId, operation.projectId, operation.actorId,
                operation.installationId, operation.sessionId))
            val payload = JSONObject(operation.payloadJson)
            val submissionId = payload.getString("clientSubmissionId")
            check(payload.getString("projectId") == scope.projectId &&
                operation.idempotencyKey == "submission:$submissionId:commit")
            val storedCaptureId = payload.optString("captureId").takeIf(String::isNotBlank)
            check(captureId == null || storedCaptureId == null || captureId == storedCaptureId)
            val attachmentId = payload.optJSONArray("attachments")?.optJSONObject(0)
                ?.optString("clientAttachmentId")?.takeIf(String::isNotBlank)
                ?: payload.optString("clientAttachmentId").takeIf(String::isNotBlank)
                ?: captureAttachmentId
                // A promoted/text-only row may not retain a client attachment ID. This metadata
                // is never used to create or upload: the existing operation ID must remain present.
                ?: submissionId
            return PendingBugSubmission(submissionId, attachmentId, null, storedCaptureId ?: captureId,
                scope, NewOfflineOperation(operation.operationKind, operation.httpMethod,
                    operation.relativePath, operation.payloadJson, operation.idempotencyKey), operation.operationId)
        }
    }
}

/** Keeps unsent text and choices through project changes, logout and app restart. */
class BugDraftPreferences(private val preferences: SharedPreferences) {
    private val failedReleaseCommits = mutableSetOf<String>()
    constructor(context: Context) : this(
        context.getSharedPreferences("qa-hub-preview-drafts-v2", Context.MODE_PRIVATE),
    )
    fun read(scopeKey: String): SavedBugDraft = runCatching {
        val value = JSONObject(preferences.getString("draft:$scopeKey", "{}").orEmpty())
        SavedBugDraft(value.optString("content"), value.optString("fixerId"), value.optString("verifierId"))
    }.getOrDefault(SavedBugDraft())
    fun save(scopeKey: String, draft: SavedBugDraft) {
        require(scopeKey.isNotBlank())
        check(preferences.edit().putString("draft:$scopeKey", JSONObject()
            .put("content", draft.content).put("fixerId", draft.fixerId)
            .put("verifierId", draft.verifierId).toString()).commit())
    }
    fun clear(scopeKey: String) { check(preferences.edit().remove("draft:$scopeKey").commit()) }

    fun pending(scopeKey: String): PendingBugSubmission? {
        val text = preferences.getString("pending:$scopeKey", null) ?: return null
        // A damaged identity must fail closed, never silently become a new submission.
        val value = JSONObject(text)
        return PendingBugSubmission(
            submissionId = value.getString("submissionId"),
            attachmentId = value.getString("attachmentId"),
            originalDraft = value.optJSONObject("originalDraft")?.let {
                SavedBugDraft(it.getString("content"), it.getString("fixerId"), it.getString("verifierId"))
            },
            captureId = if (value.isNull("captureId")) null else value.getString("captureId"),
            scope = value.optJSONObject("scope")?.let {
                AccountProjectScope(it.getString("accountId"), it.getString("projectId"),
                    it.getString("actorId"), it.getString("installationId"), it.getString("sessionId"))
            },
            request = value.optJSONObject("request")?.let {
                NewOfflineOperation(it.getString("operationKind"), it.getString("httpMethod"),
                    it.getString("relativePath"), it.getString("payloadJson"), it.getString("idempotencyKey"))
            },
            operationId = value.optString("operationId").takeIf(String::isNotBlank),
        ).also { require(it.submissionId.isNotBlank() && it.attachmentId.isNotBlank()) }
    }

    fun savePending(
        scopeKey: String,
        submission: PendingBugSubmission,
    ) {
        require(scopeKey.isNotBlank())
        val previous = pending(scopeKey)
        check(previous == null || previous.submissionId == submission.submissionId) {
            "请先确认上次提交的结果；当前修改已保留。"
        }
        check(previous == null || previous.submissionId != submission.submissionId || previous == submission) {
            "原提交内容已保存，不能用当前修改覆盖；请先确认原提交。"
        }
        submission.request?.let {
            require(it.idempotencyKey == "submission:${submission.submissionId}:commit" &&
                it.relativePath == "/bugs" && it.httpMethod == "POST" &&
                it.operationKind in setOf("CREATE_BUG", "STAGE_CREATE_BUG_ATTACHMENT"))
        }
        val value = JSONObject().put("submissionId", submission.submissionId)
            .put("attachmentId", submission.attachmentId)
            .put("captureId", submission.captureId ?: JSONObject.NULL)
        submission.originalDraft?.let {
            value.put("originalDraft", JSONObject().put("content", it.content)
                .put("fixerId", it.fixerId).put("verifierId", it.verifierId))
        }
        submission.scope?.let {
            value.put("scope", JSONObject().put("accountId", it.accountId).put("projectId", it.projectId)
                .put("actorId", it.actorId).put("installationId", it.installationId).put("sessionId", it.sessionId))
        }
        submission.request?.let {
            value.put("request", JSONObject().put("operationKind", it.operationKind).put("httpMethod", it.httpMethod)
                .put("relativePath", it.relativePath).put("payloadJson", it.payloadJson).put("idempotencyKey", it.idempotencyKey))
        }
        submission.operationId?.let { value.put("operationId", it) }
        check(preferences.edit().putString("pending:$scopeKey", value.toString()).commit())
    }

    fun markQueued(scopeKey: String, submissionId: String, operationId: String) {
        require(operationId.isNotBlank())
        val original = checkNotNull(pending(scopeKey))
        check(original.submissionId == submissionId &&
            (original.operationId == null || original.operationId == operationId))
        val value = JSONObject(checkNotNull(preferences.getString("pending:$scopeKey", null)))
            .put("operationId", operationId)
        check(preferences.edit().putString("pending:$scopeKey", value.toString()).commit())
    }

    /** Explicit user recovery retains the failed intent and does not mutate its queue/media. */
    fun releaseRejectedBeforeBugPost(scopeKey: String, scope: AccountProjectScope, operation: OfflineOperationEntity) {
        val original = checkNotNull(pending(scopeKey))
        original.requireScope(scope)
        val fingerprint = checkNotNull(operation.noBugPostRejectionFingerprint())
        val stored = PendingBugSubmission.fromQueuedCreate(scope, operation)
        check(original.operationId == operation.operationId && original.submissionId == stored.submissionId &&
            original.request == stored.request)
        val originalJson = checkNotNull(preferences.getString("pending:$scopeKey", null))
        val proofKey = "rejected-proof:$scopeKey:${operation.operationId}"
        val queueSnapshot = JSONObject().put("operationId", operation.operationId)
            .put("accountId", operation.accountId).put("projectId", operation.projectId)
            .put("actorId", operation.actorId).put("installationId", operation.installationId)
            .put("sessionId", operation.sessionId).put("operationKind", operation.operationKind)
            .put("httpMethod", operation.httpMethod).put("relativePath", operation.relativePath)
            .put("payloadJson", operation.payloadJson).put("idempotencyKey", operation.idempotencyKey)
            .put("state", operation.state.name).put("attemptCount", operation.attemptCount)
            .put("lastErrorCode", operation.lastErrorCode).put("createdAtEpochMs", operation.createdAtEpochMs)
            .put("nextAttemptAtEpochMs", operation.nextAttemptAtEpochMs).put("updatedAtEpochMs", operation.updatedAtEpochMs)
        // SharedPreferences can update memory even when commit reports disk failure.
        failedReleaseCommits += proofKey
        check(preferences.edit()
            .putString("rejected-original:$scopeKey:${operation.operationId}:$fingerprint", originalJson)
            .putString("rejected-state:$scopeKey:${operation.operationId}:$fingerprint", queueSnapshot.toString())
            .putString(proofKey, fingerprint).remove("pending:$scopeKey").commit())
        failedReleaseCommits -= proofKey
    }

    fun isReleasedRejection(scopeKey: String, operation: OfflineOperationEntity): Boolean {
        val fingerprint = operation.noBugPostRejectionFingerprint() ?: return false
        val proofKey = "rejected-proof:$scopeKey:${operation.operationId}"
        return proofKey !in failedReleaseCommits && preferences.getString(proofKey, null) == fingerprint
    }

    /** Clear only the confirmed original text. Edits made while confirming remain a new draft. */
    fun confirmPending(scopeKey: String, submissionId: String, preserveDraft: Boolean = false): Boolean {
        val pending = pending(scopeKey) ?: return false
        if (pending.submissionId != submissionId) return false
        // Capture IDs do not describe later annotation edits. Keep such drafts conservatively.
        val clearOriginal = !preserveDraft && pending.captureId == null &&
            pending.originalDraft != null && read(scopeKey) == pending.originalDraft
        val editor = preferences.edit().remove("pending:$scopeKey")
        if (clearOriginal) editor.remove("draft:$scopeKey")
        check(editor.commit())
        return clearOriginal
    }
    fun lastFixerId(scopeKey: String): String? = preferences.getString("fixer:$scopeKey", null)
    fun recordLastFixer(scopeKey: String, fixerId: String) {
        check(preferences.edit().putString("fixer:$scopeKey", fixerId).commit())
    }

    fun pendingVerification(scopeKey: String, verificationId: String): PendingVerificationSubmission? {
        val text = preferences.getString(verificationKey(scopeKey, verificationId), null) ?: return null
        val value = JSONObject(text)
        val scope = value.getJSONObject("scope")
        val attachments = value.getJSONArray("attachments")
        return PendingVerificationSubmission(
            scope = AccountProjectScope(
                accountId = scope.getString("accountId"),
                projectId = scope.getString("projectId"),
                actorId = scope.getString("actorId"),
                installationId = scope.getString("installationId"),
                sessionId = scope.getString("sessionId"),
            ),
            bugId = value.getString("bugId"),
            verificationId = value.getString("verificationId"),
            clientSubmissionId = value.getString("clientSubmissionId"),
            attachments = (0 until attachments.length()).map { index ->
                val item = attachments.getJSONObject(index)
                PendingVerificationAttachment(
                    clientAttachmentId = item.getString("clientAttachmentId"),
                    filename = item.getString("filename"),
                    mediaType = item.getString("mediaType"),
                    expectedSize = item.getInt("expectedSize"),
                    sha256 = item.getString("sha256"),
                    attachmentId = if (item.isNull("attachmentId")) null else item.getString("attachmentId"),
                    uploadCheckpoint = item.optJSONObject("uploadCheckpoint")
                        ?.let(::parseAttachmentUploadCheckpoint)
                        ?: AttachmentUploadCheckpoint(),
                )
            },
            captureBundleId = if (value.isNull("captureBundleId")) null else value.getString("captureBundleId"),
            frozenResult = value.optJSONObject("frozenResult")?.let(::parseFrozenVerificationResult),
        ).also(::requireValidVerificationSubmission)
    }

    fun pendingVerificationForBug(
        scopeKey: String,
        scope: AccountProjectScope,
        bugId: String,
    ): PendingVerificationSubmission? {
        requireUuid(bugId, "bugId")
        val verificationId = preferences.getString(
            verificationBugKey(scopeKey, bugId),
            null,
        ) ?: return null
        return checkNotNull(pendingVerification(scopeKey, verificationId)) {
            "原验收提交索引损坏；请保留应用数据并联系管理员。"
        }.also { it.requireScope(scope, bugId, verificationId) }
    }

    /** Creates the stable ID once; reopening this exact Verification returns the original ID. */
    fun openVerification(
        scopeKey: String,
        scope: AccountProjectScope,
        bugId: String,
        verificationId: String,
    ): PendingVerificationSubmission {
        pendingVerificationForBug(scopeKey, scope, bugId)?.let { existing ->
            check(existing.verificationId == verificationId) {
                "这个 Bug 仍有另一轮验收待确认，请先重试原验收。"
            }
            return existing
        }
        pendingVerification(scopeKey, verificationId)?.let { existing ->
            existing.requireScope(scope, bugId, verificationId)
            return existing
        }
        return PendingVerificationSubmission(
            scope = scope,
            bugId = bugId,
            verificationId = verificationId,
            clientSubmissionId = UUID.randomUUID().toString(),
        ).also { saveVerification(scopeKey, it) }
    }

    /** Progress may be appended, but the original scoped submission identity cannot be replaced. */
    fun saveVerification(scopeKey: String, submission: PendingVerificationSubmission) {
        require(scopeKey.isNotBlank())
        requireValidVerificationSubmission(submission)
        val previous = pendingVerification(scopeKey, submission.verificationId)
        check(
            previous == null ||
                previous.scope == submission.scope &&
                previous.bugId == submission.bugId &&
                previous.verificationId == submission.verificationId &&
                previous.clientSubmissionId == submission.clientSubmissionId
        ) { "原验收提交仍待确认，不能换成新的提交身份。" }
        previous?.let { saved ->
            check(submission.attachments.size >= saved.attachments.size) {
                "已保存的验收证据不能移除。"
            }
            if (
                saved.attachments.any { it.uploadCheckpoint.sessionId != null } ||
                submission.attachments.any { it.uploadCheckpoint.sessionId != null }
            ) {
                check(saved.captureBundleId == submission.captureBundleId) {
                    "附件开始上传后不能更换采集包。"
                }
            }
            saved.attachments.forEachIndexed { index, attachment ->
                requireAttachmentProgress(attachment, submission.attachments[index])
            }
        }
        if (previous?.frozenResult != null) {
            check(previous.frozenResult == submission.frozenResult) {
                "原验收结果已发送，重试必须保留完全相同的结果和证据。"
            }
        }
        val indexedVerificationId = preferences.getString(
            verificationBugKey(scopeKey, submission.bugId),
            null,
        )
        check(indexedVerificationId == null || indexedVerificationId == submission.verificationId) {
            "这个 Bug 仍有另一轮验收待确认，请先重试原验收。"
        }
        val json = JSONObject()
            .put("scope", JSONObject()
                .put("accountId", submission.scope.accountId)
                .put("projectId", submission.scope.projectId)
                .put("actorId", submission.scope.actorId)
                .put("installationId", submission.scope.installationId)
                .put("sessionId", submission.scope.sessionId))
            .put("bugId", submission.bugId)
            .put("verificationId", submission.verificationId)
            .put("clientSubmissionId", submission.clientSubmissionId)
            .put("captureBundleId", submission.captureBundleId ?: JSONObject.NULL)
            .put("attachments", JSONArray().also { array ->
                submission.attachments.forEach { attachment ->
                    array.put(JSONObject()
                        .put("clientAttachmentId", attachment.clientAttachmentId)
                        .put("filename", attachment.filename)
                        .put("mediaType", attachment.mediaType)
                        .put("expectedSize", attachment.expectedSize)
                        .put("sha256", attachment.sha256)
                        .put("attachmentId", attachment.attachmentId ?: JSONObject.NULL)
                        .put("uploadCheckpoint", attachment.uploadCheckpoint.toJson()))
                }
            })
            .put("frozenResult", submission.frozenResult?.toJson() ?: JSONObject.NULL)
        check(
            preferences.edit()
                .putString(verificationKey(scopeKey, submission.verificationId), json.toString())
                .putString(
                    verificationBugKey(scopeKey, submission.bugId),
                    submission.verificationId,
                )
                .commit()
        )
    }

    /** Remove only the submission whose exact server receipt has been accepted by the caller. */
    fun confirmVerification(
        scopeKey: String,
        verificationId: String,
        clientSubmissionId: String,
    ): PendingVerificationSubmission? {
        val pending = pendingVerification(scopeKey, verificationId) ?: return null
        if (pending.clientSubmissionId != clientSubmissionId) return null
        val editor = preferences.edit().remove(verificationKey(scopeKey, verificationId))
        if (
            preferences.getString(verificationBugKey(scopeKey, pending.bugId), null) == verificationId
        ) {
            editor.remove(verificationBugKey(scopeKey, pending.bugId))
        }
        check(editor.commit())
        return pending
    }

    private fun verificationKey(scopeKey: String, verificationId: String): String {
        require(scopeKey.isNotBlank())
        requireUuid(verificationId, "verificationId")
        return "verification:$scopeKey:$verificationId"
    }

    private fun verificationBugKey(scopeKey: String, bugId: String): String {
        require(scopeKey.isNotBlank())
        requireUuid(bugId, "bugId")
        return "verification-bug:$scopeKey:$bugId"
    }
}

private fun requireValidVerificationSubmission(value: PendingVerificationSubmission) {
    listOf(
        value.scope.accountId,
        value.scope.projectId,
        value.scope.actorId,
        value.scope.installationId,
        value.scope.sessionId,
        value.bugId,
        value.verificationId,
        value.clientSubmissionId,
    ).forEach { requireUuid(it, "verification identity") }
    require(value.attachments.size <= 20)
    require(value.attachments.map { it.clientAttachmentId }.distinct().size == value.attachments.size)
    require(value.attachments.mapNotNull { it.attachmentId }.distinct().size ==
        value.attachments.mapNotNull { it.attachmentId }.size)
    require(value.attachments.sumOf { it.expectedSize.toLong() } <= 100L * 1024L * 1024L)
    value.captureBundleId?.let { requireUuid(it, "captureBundleId") }
    value.attachments.forEach { attachment ->
        requireUuid(attachment.clientAttachmentId, "clientAttachmentId")
        attachment.attachmentId?.let { requireUuid(it, "attachmentId") }
        require(
            attachment.filename.isNotBlank() &&
                attachment.filename.length <= 255 &&
                !attachment.filename.contains('/') &&
                !attachment.filename.contains('\\')
        )
        require(attachment.mediaType in setOf("image/png", "image/jpeg", "image/webp"))
        require(attachment.expectedSize in 1..20 * 1024 * 1024)
        require(attachment.sha256.matches(Regex("^[0-9a-f]{64}$")))
        requireAttachmentCheckpoint(attachment)
    }
    value.frozenResult?.let { result ->
        require(result.verificationId == value.verificationId)
        require(result.expectedVersion > 0)
        require(result.status in setOf("passed", "failed", "blocked"))
        require(result.resultSummary.isNotBlank() && result.resultSummary.length <= 10_000)
        require(result.attachmentIds.sorted() == value.attachments.mapNotNull { it.attachmentId }.sorted())
        require(result.captureBundleId == value.captureBundleId)
        require(
            when (result.status) {
                "passed" -> result.failureReason == null && result.blockedReason == null
                "failed" -> !result.failureReason.isNullOrBlank() && result.blockedReason == null
                else -> result.failureReason == null && !result.blockedReason.isNullOrBlank()
            }
        )
    }
}

private fun requireAttachmentCheckpoint(attachment: PendingVerificationAttachment) {
    val checkpoint = attachment.uploadCheckpoint
    require(checkpoint.uploadAttempt > 0)
    if (checkpoint.sessionId == null) {
        require(
            checkpoint == AttachmentUploadCheckpoint(uploadAttempt = checkpoint.uploadAttempt) &&
                attachment.attachmentId == null
        )
        return
    }
    requireUuid(checkpoint.sessionId, "sessionId")
    val chunkSize = checkNotNull(checkpoint.chunkSize)
    val chunkCount = checkNotNull(checkpoint.expectedChunkCount)
    require(chunkSize in 256 * 1024..8 * 1024 * 1024)
    require(chunkCount in 1..2_000)
    require(chunkCount == (attachment.expectedSize + chunkSize - 1) / chunkSize)
    require(checkpoint.confirmedChunks == checkpoint.confirmedChunks.distinct().sorted())
    require(checkpoint.confirmedChunks.all { it in 0 until chunkCount })
    require(checkNotNull(checkpoint.uploadVersion) >= 1 + checkpoint.confirmedChunks.size)
    OffsetDateTime.parse(checkNotNull(checkpoint.uploadExpiresAt))
    require(attachment.attachmentId == checkpoint.attachmentId)
    checkpoint.attachmentId?.let {
        requireUuid(it, "attachmentId")
        require(checkpoint.confirmedChunks.size == chunkCount)
        require(checkpoint.finalizedVersion != null)
    }
    if (checkpoint.finalizeConfirmed) require(checkpoint.attachmentId != null)
    val bindingParts = listOf(
        checkpoint.bindingId,
        checkpoint.leaseGeneration,
        checkpoint.bindingVersion,
        checkpoint.bindingExpiresAt,
    )
    require(bindingParts.all { it == null } || bindingParts.none { it == null })
    checkpoint.bindingId?.let {
        requireUuid(it, "bindingId")
        require(checkpoint.finalizeConfirmed)
        val generation = checkNotNull(checkpoint.leaseGeneration)
        require(generation > 0)
        require(checkpoint.bindingVersion == checkNotNull(checkpoint.finalizedVersion) + generation)
        OffsetDateTime.parse(checkNotNull(checkpoint.bindingExpiresAt))
    }
}

private fun requireAttachmentProgress(
    previous: PendingVerificationAttachment,
    current: PendingVerificationAttachment,
) {
    require(
        previous.clientAttachmentId == current.clientAttachmentId &&
            previous.filename == current.filename && previous.mediaType == current.mediaType &&
            previous.expectedSize == current.expectedSize && previous.sha256 == current.sha256
    ) { "验收证据身份不能在重试时更改。" }
    require(previous.attachmentId == null || previous.attachmentId == current.attachmentId) {
        "已完成上传的验收证据不能更换。"
    }
    val before = previous.uploadCheckpoint
    val after = current.uploadCheckpoint
    require(after.uploadAttempt in before.uploadAttempt..(before.uploadAttempt + 1))
    if (after.uploadAttempt > before.uploadAttempt) {
        require(before.attachmentId == null && after.attachmentId == null)
        return
    }
    require(before.sessionId == null || before.sessionId == after.sessionId)
    require(before.chunkSize == null || before.chunkSize == after.chunkSize)
    require(before.expectedChunkCount == null || before.expectedChunkCount == after.expectedChunkCount)
    require(after.confirmedChunks.containsAll(before.confirmedChunks))
    require(before.uploadVersion == null || checkNotNull(after.uploadVersion) >= before.uploadVersion)
    require(before.attachmentId == null || before.attachmentId == after.attachmentId)
    require(!before.finalizeConfirmed || after.finalizeConfirmed)
    require(before.bindingId == null || before.bindingId == after.bindingId)
    require(
        before.leaseGeneration == null ||
            checkNotNull(after.leaseGeneration) in before.leaseGeneration..(before.leaseGeneration + 1)
    )
    require(before.bindingVersion == null || checkNotNull(after.bindingVersion) >= before.bindingVersion)
}

private fun AttachmentUploadCheckpoint.toJson(): JSONObject = JSONObject()
    .put("uploadAttempt", uploadAttempt)
    .put("sessionId", sessionId ?: JSONObject.NULL)
    .put("chunkSize", chunkSize ?: JSONObject.NULL)
    .put("expectedChunkCount", expectedChunkCount ?: JSONObject.NULL)
    .put("confirmedChunks", JSONArray(confirmedChunks))
    .put("uploadVersion", uploadVersion ?: JSONObject.NULL)
    .put("uploadExpiresAt", uploadExpiresAt ?: JSONObject.NULL)
    .put("attachmentId", attachmentId ?: JSONObject.NULL)
    .put("finalizedVersion", finalizedVersion ?: JSONObject.NULL)
    .put("finalizeConfirmed", finalizeConfirmed)
    .put("bindingId", bindingId ?: JSONObject.NULL)
    .put("leaseGeneration", leaseGeneration ?: JSONObject.NULL)
    .put("bindingVersion", bindingVersion ?: JSONObject.NULL)
    .put("bindingExpiresAt", bindingExpiresAt ?: JSONObject.NULL)

private fun parseAttachmentUploadCheckpoint(value: JSONObject): AttachmentUploadCheckpoint =
    AttachmentUploadCheckpoint(
        uploadAttempt = value.getInt("uploadAttempt"),
        sessionId = value.nullableString("sessionId"),
        chunkSize = value.nullableInt("chunkSize"),
        expectedChunkCount = value.nullableInt("expectedChunkCount"),
        confirmedChunks = value.getJSONArray("confirmedChunks").let { array ->
            (0 until array.length()).map(array::getInt)
        },
        uploadVersion = value.nullableInt("uploadVersion"),
        uploadExpiresAt = value.nullableString("uploadExpiresAt"),
        attachmentId = value.nullableString("attachmentId"),
        finalizedVersion = value.nullableInt("finalizedVersion"),
        finalizeConfirmed = value.getBoolean("finalizeConfirmed"),
        bindingId = value.nullableString("bindingId"),
        leaseGeneration = value.nullableInt("leaseGeneration"),
        bindingVersion = value.nullableInt("bindingVersion"),
        bindingExpiresAt = value.nullableString("bindingExpiresAt"),
    )

private fun JSONObject.nullableString(key: String): String? =
    if (isNull(key)) null else getString(key)

private fun JSONObject.nullableInt(key: String): Int? =
    if (isNull(key)) null else getInt(key)

private fun FrozenVerificationResult.toJson(): JSONObject = JSONObject()
    .put("verificationId", verificationId)
    .put("expectedVersion", expectedVersion)
    .put("status", status)
    .put("resultSummary", resultSummary)
    .put("attachmentIds", JSONArray(attachmentIds))
    .put("captureBundleId", captureBundleId ?: JSONObject.NULL)
    .put("failureReason", failureReason ?: JSONObject.NULL)
    .put("blockedReason", blockedReason ?: JSONObject.NULL)

private fun parseFrozenVerificationResult(value: JSONObject): FrozenVerificationResult =
    FrozenVerificationResult(
        verificationId = value.getString("verificationId"),
        expectedVersion = value.getInt("expectedVersion"),
        status = value.getString("status"),
        resultSummary = value.getString("resultSummary"),
        attachmentIds = value.getJSONArray("attachmentIds").let { array ->
            (0 until array.length()).map(array::getString)
        },
        captureBundleId = if (value.isNull("captureBundleId")) null else value.getString("captureBundleId"),
        failureReason = if (value.isNull("failureReason")) null else value.getString("failureReason"),
        blockedReason = if (value.isNull("blockedReason")) null else value.getString("blockedReason"),
    )

private fun requireUuid(value: String, label: String) {
    require(
        value.matches(Regex(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        )) && runCatching { UUID.fromString(value) }.isSuccess,
    ) { "$label must be a UUID" }
}
