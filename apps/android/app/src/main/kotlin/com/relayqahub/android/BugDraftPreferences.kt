package com.relayqahub.android

import android.content.Context
import android.content.SharedPreferences
import com.relayqahub.android.data.AccountProjectScope
import com.relayqahub.android.data.NewOfflineOperation
import com.relayqahub.android.data.OfflineOperationEntity
import com.relayqahub.android.data.isCreateIntent
import com.relayqahub.android.data.noBugPostRejectionFingerprint
import org.json.JSONObject

data class SavedBugDraft(val content: String = "", val fixerId: String = "", val verifierId: String = "")

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
}
