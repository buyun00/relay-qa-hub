package com.relayqahub.android.work

import com.relayqahub.android.data.AccountProjectScope
import com.relayqahub.android.data.AttachmentPipelineReceiptDao
import com.relayqahub.android.data.OfflineOperationDao
import com.relayqahub.android.data.OfflineOperationEntity
import com.relayqahub.android.data.OfflineOperationReceiptEntity
import com.relayqahub.android.data.QueueState
import com.relayqahub.android.network.ApiOutcome
import com.relayqahub.android.network.CreateBugReceipt
import com.relayqahub.android.network.QaHubApiClient
import com.relayqahub.android.security.CredentialVault
import com.relayqahub.android.security.VaultResult
import com.relayqahub.android.security.nativeSessionScope
import kotlin.math.min

sealed interface SyncRunResult {
    data class Completed(val processedCount: Int) : SyncRunResult
    data class ContinueAt(
        val processedCount: Int,
        val nextAttemptAtEpochMs: Long,
    ) : SyncRunResult
    data class BlockedOnAuthentication(val processedCount: Int) : SyncRunResult
    data class BlockedOnDeviceSecurity(val processedCount: Int) : SyncRunResult
    data class Exhausted(val processedCount: Int) : SyncRunResult
}

class OfflineSyncEngine(
    private val operationDao: OfflineOperationDao,
    private val apiClient: QaHubApiClient,
    private val credentialVault: CredentialVault,
    private val attachmentDraftProcessor: OfflineAttachmentDraftProcessor? = null,
    private val attachmentReceiptDao: AttachmentPipelineReceiptDao? = null,
    private val attachmentDraftStore: OfflineAttachmentDraftStore? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    suspend fun run(
        scope: AccountProjectScope,
    ): SyncRunResult {
        val now = clock()
        operationDao.recoverStaleRunning(
            accountId = scope.accountId,
            projectId = scope.projectId,
            actorId = scope.actorId,
            installationId = scope.installationId,
            sessionId = scope.sessionId,
            staleBeforeEpochMs = now - STALE_RUNNING_AFTER_MS,
            nowEpochMs = now,
        )
        val ready = operationDao.claimReady(
            accountId = scope.accountId,
            projectId = scope.projectId,
            actorId = scope.actorId,
            installationId = scope.installationId,
            sessionId = scope.sessionId,
            nowEpochMs = now,
            limit = BATCH_SIZE,
        )
        if (ready.isEmpty()) return nextScheduledResult(scope, processedCount = 0, now)

        val credentials = when (val result = credentialVault.read(scope.nativeSessionScope())) {
            is VaultResult.Success -> result.value
            VaultResult.Missing -> {
                ready.forEach { operation ->
                    record(
                        scope = scope,
                        operation = operation,
                        state = QueueState.BLOCKED_AUTH,
                        errorCode = "NATIVE_SESSION_MISSING",
                        nextAttemptAtEpochMs = now,
                    )
                }
                return SyncRunResult.BlockedOnAuthentication(ready.size)
            }
            is VaultResult.Unavailable -> {
                ready.forEach { operation ->
                    recordDeviceBlock(scope, operation, result.reasonCode, now)
                }
                return SyncRunResult.BlockedOnDeviceSecurity(ready.size)
            }
        }

        if (credentials.accessTokenExpiresAtEpochMs <= now) {
            ready.forEach { operation ->
                record(
                    scope = scope,
                    operation = operation,
                    state = QueueState.BLOCKED_AUTH,
                    errorCode = "NATIVE_SESSION_EXPIRED",
                    nextAttemptAtEpochMs = now,
                )
            }
            return SyncRunResult.BlockedOnAuthentication(ready.size)
        }

        var sawAuthFailure = false
        var exhaustedRetry = false
        ready.forEach { operation ->
            if (operation.operationKind == OfflineAttachmentDraftContract.OPERATION_KIND) {
                when (
                    val stage = attachmentDraftProcessor?.promote(
                        scope,
                        operation,
                        credentials.accessToken,
                    ) ?: OfflineAttachmentStageResult.PermanentFailure(
                        "OFFLINE_ATTACHMENT_PROCESSOR_UNAVAILABLE",
                    )
                ) {
                    OfflineAttachmentStageResult.Promoted -> Unit
                    is OfflineAttachmentStageResult.AuthExpired -> {
                        sawAuthFailure = true
                        record(
                            scope,
                            operation,
                            QueueState.BLOCKED_AUTH,
                            stage.errorCode,
                            now,
                        )
                    }
                    is OfflineAttachmentStageResult.PermanentFailure -> record(
                        scope,
                        operation,
                        QueueState.FAILED_PERMANENT,
                        stage.errorCode,
                        now,
                    )
                    is OfflineAttachmentStageResult.Retryable -> {
                        val nextPersistentAttempt = operation.attemptCount + 1
                        if (nextPersistentAttempt >= MAX_OPERATION_ATTEMPTS) {
                            exhaustedRetry = true
                            record(
                                scope,
                                operation,
                                QueueState.FAILED_PERMANENT,
                                "RETRY_EXHAUSTED_${stage.errorCode}",
                                now,
                            )
                        } else {
                            record(
                                scope,
                                operation,
                                QueueState.RETRY,
                                stage.errorCode,
                                now + retryDelayMs(operation.attemptCount),
                            )
                        }
                    }
                }
                return@forEach
            }
            when (val outcome = apiClient.execute(operation, credentials.accessToken)) {
                is ApiOutcome.Success -> {
                    val receipt = outcome.createBugReceipt
                    if (
                        outcome.httpStatus != 201 ||
                        operation.operationKind != "CREATE_BUG" ||
                        receipt == null ||
                        receipt.projectId != operation.projectId ||
                        receipt.bugId != receipt.qaItemId ||
                        operation.idempotencyKey !=
                        "submission:${receipt.clientSubmissionId}:commit"
                    ) {
                        record(
                            scope,
                            operation,
                            QueueState.FAILED_PERMANENT,
                            "SUCCESS_RECEIPT_SCOPE_MISMATCH",
                            now,
                        )
                    } else {
                        operationDao.completeCreateBug(
                            operation = operation,
                            receipt = OfflineOperationReceiptEntity(
                                operationId = operation.operationId,
                                accountId = operation.accountId,
                                projectId = operation.projectId,
                                actorId = operation.actorId,
                                installationId = operation.installationId,
                                sessionId = operation.sessionId,
                                clientSubmissionId = receipt.clientSubmissionId,
                                qaItemId = receipt.qaItemId,
                                qaItemKey = receipt.qaItemKey,
                                bugId = receipt.bugId,
                                occurrenceId = receipt.occurrenceId,
                                eventId = receipt.eventId,
                                replayed = receipt.replayed,
                                responseJson = receipt.responseJson,
                                receivedAtEpochMs = clock(),
                            ),
                            nowEpochMs = clock(),
                        )
                        completeAttachmentSubmission(operation, receipt)
                    }
                }
                is ApiOutcome.AuthExpired -> {
                    sawAuthFailure = true
                    record(
                        scope,
                        operation,
                        QueueState.BLOCKED_AUTH,
                        outcome.errorCode,
                        now,
                    )
                }
                is ApiOutcome.PermanentFailure -> record(
                    scope,
                    operation,
                    QueueState.FAILED_PERMANENT,
                    outcome.errorCode,
                    now,
                )
                is ApiOutcome.Retryable -> {
                    val nextPersistentAttempt = operation.attemptCount + 1
                    if (nextPersistentAttempt >= MAX_OPERATION_ATTEMPTS) {
                        exhaustedRetry = true
                        record(
                            scope,
                            operation,
                            QueueState.FAILED_PERMANENT,
                            "RETRY_EXHAUSTED_${outcome.errorCode}",
                            now,
                        )
                    } else {
                        record(
                            scope,
                            operation,
                            QueueState.RETRY,
                            outcome.errorCode,
                            now + retryDelayMs(operation.attemptCount),
                        )
                    }
                }
            }
        }

        return when {
            sawAuthFailure -> SyncRunResult.BlockedOnAuthentication(ready.size)
            else -> nextScheduledResult(
                scope = scope,
                processedCount = ready.size,
                nowEpochMs = now,
                exhaustedRetry = exhaustedRetry,
            )
        }
    }

    private suspend fun completeAttachmentSubmission(
        operation: OfflineOperationEntity,
        receipt: CreateBugReceipt,
    ) {
        val receiptDao = attachmentReceiptDao ?: return
        val staged = receiptDao.listForSubmission(
            accountId = operation.accountId,
            projectId = operation.projectId,
            actorId = operation.actorId,
            installationId = operation.installationId,
            sessionId = operation.sessionId,
            clientSubmissionId = receipt.clientSubmissionId,
        )
        if (staged.isEmpty()) return
        check(
            receiptDao.markSubmissionClaimed(
                accountId = operation.accountId,
                projectId = operation.projectId,
                actorId = operation.actorId,
                installationId = operation.installationId,
                sessionId = operation.sessionId,
                clientSubmissionId = receipt.clientSubmissionId,
                qaItemId = receipt.qaItemId,
                qaItemKey = receipt.qaItemKey,
                responseJson = receipt.responseJson,
                updatedAtEpochMs = clock(),
            ) == staged.size,
        ) { "Attachment claim receipt lost its scoped reservation" }
        val store = attachmentDraftStore ?: return
        staged.forEach { attachment ->
            runCatching {
                store.delete(receipt.clientSubmissionId, attachment.clientAttachmentId)
            }
        }
    }

    private suspend fun nextScheduledResult(
        scope: AccountProjectScope,
        processedCount: Int,
        nowEpochMs: Long,
        exhaustedRetry: Boolean = false,
    ): SyncRunResult {
        val nextAttemptAt = operationDao.listForScope(
            accountId = scope.accountId,
            projectId = scope.projectId,
            actorId = scope.actorId,
            installationId = scope.installationId,
            sessionId = scope.sessionId,
        ).asSequence()
            .filter { operation ->
                operation.state in setOf(
                    QueueState.PENDING,
                    QueueState.RETRY,
                    QueueState.BLOCKED_DEVICE,
                )
            }
            .minOfOrNull(OfflineOperationEntity::nextAttemptAtEpochMs)
        return when {
            nextAttemptAt != null -> SyncRunResult.ContinueAt(
                processedCount = processedCount,
                nextAttemptAtEpochMs = maxOf(nowEpochMs, nextAttemptAt),
            )
            exhaustedRetry -> SyncRunResult.Exhausted(processedCount)
            else -> SyncRunResult.Completed(processedCount)
        }
    }

    private suspend fun record(
        scope: AccountProjectScope,
        operation: OfflineOperationEntity,
        state: QueueState,
        errorCode: String?,
        nextAttemptAtEpochMs: Long,
    ) {
        check(
            operationDao.recordAttempt(
                accountId = scope.accountId,
                projectId = scope.projectId,
                actorId = scope.actorId,
                installationId = scope.installationId,
                sessionId = scope.sessionId,
                operationId = operation.operationId,
                state = state,
                nextAttemptAtEpochMs = nextAttemptAtEpochMs,
                errorCode = errorCode,
                nowEpochMs = clock(),
            ) == 1,
        ) { "Offline queue result lost its session scope" }
    }

    private suspend fun recordDeviceBlock(
        scope: AccountProjectScope,
        operation: OfflineOperationEntity,
        errorCode: String,
        nowEpochMs: Long,
    ) {
        check(
            operation.accountId == scope.accountId &&
                operation.projectId == scope.projectId &&
                operation.actorId == scope.actorId &&
                operation.installationId == scope.installationId &&
                operation.sessionId == scope.sessionId,
        )
        check(
            operationDao.recordDeviceBlock(
                accountId = scope.accountId,
                projectId = scope.projectId,
                actorId = scope.actorId,
                installationId = scope.installationId,
                sessionId = scope.sessionId,
                operationId = operation.operationId,
                errorCode = errorCode,
                nowEpochMs = nowEpochMs,
            ) == 1,
        ) { "Offline queue device block lost its session scope" }
    }

    companion object {
        const val MAX_OPERATION_ATTEMPTS = 4
        const val BATCH_SIZE = 20
        const val STALE_RUNNING_AFTER_MS = 15 * 60 * 1000L
        const val INITIAL_RETRY_DELAY_MS = 30 * 1000L
        const val MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000L

        fun retryDelayMs(persistedAttemptCount: Int): Long {
            val exponent = persistedAttemptCount.coerceIn(0, 10)
            return min(INITIAL_RETRY_DELAY_MS * (1L shl exponent), MAX_RETRY_DELAY_MS)
        }
    }
}
