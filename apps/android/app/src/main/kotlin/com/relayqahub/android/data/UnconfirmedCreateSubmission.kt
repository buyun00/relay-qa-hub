package com.relayqahub.android.data

import java.security.MessageDigest

/** Kept in the existing persisted state vocabulary so older APKs can still read their queue. */
internal const val UNCERTAIN_CREATE_ERROR_PREFIX = "RETRY_EXHAUSTED_"

internal fun OfflineOperationEntity.isCreateIntent(): Boolean =
    operationKind in setOf("CREATE_BUG", "STAGE_CREATE_BUG_ATTACHMENT") &&
        httpMethod == "POST" && relativePath == "/bugs"

internal fun OfflineOperationEntity.isUnconfirmedCreate(): Boolean =
    isCreateIntent() &&
        state == QueueState.FAILED_PERMANENT &&
        lastErrorCode?.startsWith(UNCERTAIN_CREATE_ERROR_PREFIX) == true

internal fun OfflineOperationEntity.isReconfirmableCreateProtocolFailure(): Boolean =
    operationKind == "CREATE_BUG" && isCreateIntent() && state == QueueState.FAILED_PERMANENT &&
        (lastErrorCode in setOf("SUCCESS_RESPONSE_SCOPE_MISMATCH", "SUCCESS_RECEIPT_SCOPE_MISMATCH") ||
            (lastErrorCode?.matches(Regex("UNEXPECTED_CREATE_BUG_SUCCESS_STATUS_2[0-9][0-9]")) == true &&
                lastErrorCode != "UNEXPECTED_CREATE_BUG_SUCCESS_STATUS_201"))

/** STAGE is durably promoted before /bugs is sent and is never restored afterwards. */
internal fun OfflineOperationEntity.noBugPostRejectionFingerprint(): String? {
    if (operationKind != "STAGE_CREATE_BUG_ATTACHMENT" || !isCreateIntent() ||
        state != QueueState.FAILED_PERMANENT) return null
    val definitiveRejection = lastErrorCode in setOf("OFFLINE_ATTACHMENT_SIZE_MISMATCH", "OFFLINE_ATTACHMENT_HASH_MISMATCH") ||
        lastErrorCode?.matches(Regex("ATTACHMENT_(INIT|CHUNK|FINALIZE|BIND)_HTTP_(400|413|415|422)")) == true
    if (!definitiveRejection) return null
    val fields = listOf(operationId, accountId, projectId, actorId, installationId, sessionId,
        operationKind, httpMethod, relativePath, payloadJson, idempotencyKey, state.name,
        attemptCount.toString(), createdAtEpochMs.toString(), nextAttemptAtEpochMs.toString(),
        updatedAtEpochMs.toString(), lastErrorCode.orEmpty())
    val bytes = fields.joinToString("") { "${it.length}:$it" }.toByteArray(Charsets.UTF_8)
    return MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}

internal class UnconfirmedCreateSubmission(
    private val dao: OfflineOperationDao,
    private val clock: () -> Long,
) {
    /** Called only by the separate user action, never by automatic queue/session recovery. */
    suspend fun reconfirmProtocolFailure(scope: AccountProjectScope, operationId: String, key: String): OfflineOperationEntity {
        suspend fun read() = dao.findForScopeByIdempotencyKey(
            scope.accountId, scope.projectId, scope.actorId, scope.installationId, scope.sessionId, key,
        )
        val original = checkNotNull(read())
        check(original.operationId == operationId && original.isReconfirmableCreateProtocolFailure())
        check(dao.reconfirmCreateProtocolFailure(scope.accountId, scope.projectId, scope.actorId,
            scope.installationId, scope.sessionId, operationId, key, clock()) == 1)
        return checkNotNull(read()).also {
            check(it.operationId == original.operationId && it.payloadJson == original.payloadJson &&
                it.idempotencyKey == original.idempotencyKey)
        }
    }

    /** Discovery is read-only. A permanent transport classification is not a no-effect receipt. */
    suspend fun legacyCandidates(scope: AccountProjectScope, captureSubmissionId: String?): List<OfflineOperationEntity> {
        val captureKey = captureSubmissionId?.let { "submission:$it:commit" }
        if (captureKey != null) {
            check(!dao.hasForeignOperationForIdempotencyKey(
                scope.accountId, scope.projectId, scope.actorId, scope.installationId, scope.sessionId, captureKey,
            )) { "截图关联的原队列位于其他登录环境；请返回原环境确认，不能替换创建身份。" }
        }
        val rows = dao.listForScope(
            scope.accountId, scope.projectId, scope.actorId, scope.installationId, scope.sessionId,
        ).filter { it.isCreateIntent() }
        val candidates = rows.filter { row ->
            val receipt = if (row.state == QueueState.SUCCEEDED) dao.findReceiptForScope(
                row.operationId, scope.accountId, scope.projectId, scope.actorId, scope.installationId, scope.sessionId,
            ) else null
            receipt == null || row.idempotencyKey != "submission:${receipt.clientSubmissionId}:commit" ||
                receipt.qaItemId != receipt.bugId
        }
        val capture = candidates.firstOrNull { it.idempotencyKey == captureKey }
        return if (capture != null) listOf(capture) + candidates.filter { it.operationId != capture.operationId } else candidates
    }

    /** A repeated click can only rearm the same scoped row; it cannot supply replacement bytes. */
    suspend fun resume(scope: AccountProjectScope, key: String): OfflineOperationEntity? {
        suspend fun read() = dao.findForScopeByIdempotencyKey(
            scope.accountId, scope.projectId, scope.actorId, scope.installationId, scope.sessionId, key,
        )
        val original = read() ?: return null
        if (original.isUnconfirmedCreate()) {
            dao.resumeUnconfirmedCreate(
                scope.accountId, scope.projectId, scope.actorId, scope.installationId, scope.sessionId,
                original.operationId, clock(),
            )
        }
        return read() ?: error("原提交记录无法读取，请稍后重试。")
    }
}
