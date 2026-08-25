package com.relayqahub.android.data

import com.relayqahub.android.network.AttachmentUploadReceipt
import com.relayqahub.android.network.QaHubRelativePath
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine

data class LocalSubmissionSnapshot(
    val operation: OfflineOperationEntity?,
    val receipt: OfflineOperationReceiptEntity?,
)

data class AccountProjectScope(
    val accountId: String,
    val projectId: String,
    val actorId: String,
    val installationId: String,
    val sessionId: String,
) {
    init {
        require(accountId.isNotBlank())
        require(projectId.isNotBlank())
        require(actorId.isNotBlank())
        require(installationId.isNotBlank())
        require(sessionId.isNotBlank())
    }
}

data class NewOfflineOperation(
    val operationKind: String,
    val httpMethod: String,
    val relativePath: String,
    val payloadJson: String,
    val idempotencyKey: String,
)

interface AccountDataCleaner {
    suspend fun clearAccount(accountId: String)
}

class ScopedRepository(
    private val accountProjectDao: AccountProjectDao,
    private val cachedQaItemDao: CachedQaItemDao,
    private val offlineOperationDao: OfflineOperationDao,
    private val attachmentPipelineReceiptDao: AttachmentPipelineReceiptDao,
    private val submissionReceiptDao: SubmissionReceiptDao,
    private val clock: () -> Long = System::currentTimeMillis,
) : AccountDataCleaner {
    fun observeAccount(accountId: String): Flow<AccountEntity?> =
        accountProjectDao.observeAccount(accountId)

    fun observeProject(scope: AccountProjectScope): Flow<ProjectEntity?> =
        accountProjectDao.observeProject(scope.accountId, scope.projectId)

    fun observeCachedItems(scope: AccountProjectScope): Flow<List<CachedQaItemEntity>> =
        cachedQaItemDao.observeForScope(scope.accountId, scope.projectId)

    fun observeOutstandingCount(scope: AccountProjectScope): Flow<Int> =
        offlineOperationDao.observeOutstandingCount(
            scope.accountId,
            scope.projectId,
            scope.actorId,
            scope.installationId,
            scope.sessionId,
        )

    fun observeLatestSubmission(
        scope: AccountProjectScope,
    ): Flow<LocalSubmissionSnapshot> = combine(
        submissionReceiptDao.observeLatestOperationForScope(
            scope.accountId,
            scope.projectId,
            scope.actorId,
            scope.installationId,
            scope.sessionId,
        ),
        submissionReceiptDao.observeLatestForScope(
            scope.accountId,
            scope.projectId,
            scope.actorId,
            scope.installationId,
            scope.sessionId,
        ),
    ) { operation, receipt -> LocalSubmissionSnapshot(operation, receipt) }

    suspend fun listBlockedDeviceScopes(): List<AccountProjectScope> =
        offlineOperationDao.listBlockedDeviceScopes()

    suspend fun seedFoundationScope(scope: AccountProjectScope) {
        val now = clock()
        accountProjectDao.upsertScope(
            account = AccountEntity(
                accountId = scope.accountId,
                displayName = "Local foundation account",
                updatedAtEpochMs = now,
            ),
            project = ProjectEntity(
                accountId = scope.accountId,
                projectId = scope.projectId,
                projectKey = "LOCAL",
                displayName = "Native foundation",
                updatedAtEpochMs = now,
            ),
        )
    }

    suspend fun enqueue(scope: AccountProjectScope, request: NewOfflineOperation): String {
        val method = request.httpMethod.uppercase(Locale.ROOT)
        require(method in ALLOWED_WRITE_METHODS) { "Only API write methods can be queued" }
        QaHubRelativePath.requireValid(request.relativePath)
        require(!QaHubRelativePath.isBinaryUploadChunk(request.relativePath)) {
            "Binary upload chunks require the dedicated binary transport"
        }
        require(request.idempotencyKey.isNotBlank())
        require(request.operationKind.isNotBlank())
        val now = clock()
        val operationId = UUID.randomUUID().toString()
        offlineOperationDao.insert(
            OfflineOperationEntity(
                operationId = operationId,
                accountId = scope.accountId,
                projectId = scope.projectId,
                actorId = scope.actorId,
                installationId = scope.installationId,
                sessionId = scope.sessionId,
                operationKind = request.operationKind,
                httpMethod = method,
                relativePath = request.relativePath,
                payloadJson = request.payloadJson,
                idempotencyKey = request.idempotencyKey,
                state = QueueState.PENDING,
                attemptCount = 0,
                nextAttemptAtEpochMs = now,
                lastErrorCode = null,
                createdAtEpochMs = now,
                updatedAtEpochMs = now,
            ),
        )
        return operationId
    }

    suspend fun findReceipt(
        scope: AccountProjectScope,
        operationId: String,
    ): OfflineOperationReceiptEntity? {
        require(operationId.isNotBlank())
        return offlineOperationDao.findReceiptForScope(
            operationId = operationId,
            accountId = scope.accountId,
            projectId = scope.projectId,
            actorId = scope.actorId,
            installationId = scope.installationId,
            sessionId = scope.sessionId,
        )
    }

    suspend fun findOperationByIdempotencyKey(
        scope: AccountProjectScope,
        idempotencyKey: String,
    ): OfflineOperationEntity? {
        require(idempotencyKey.isNotBlank())
        return offlineOperationDao.findForScopeByIdempotencyKey(
            accountId = scope.accountId,
            projectId = scope.projectId,
            actorId = scope.actorId,
            installationId = scope.installationId,
            sessionId = scope.sessionId,
            idempotencyKey = idempotencyKey,
        )
    }

    suspend fun recordAttachmentReservation(
        scope: AccountProjectScope,
        receipt: AttachmentUploadReceipt,
    ) {
        require(receipt.bindingStatus == "reserved")
        attachmentPipelineReceiptDao.upsert(
            AttachmentPipelineReceiptEntity(
                accountId = scope.accountId,
                projectId = scope.projectId,
                actorId = scope.actorId,
                installationId = scope.installationId,
                sessionId = scope.sessionId,
                clientSubmissionId = receipt.clientSubmissionId,
                clientAttachmentId = receipt.clientAttachmentId,
                attachmentId = receipt.attachmentId,
                bindingId = receipt.bindingId,
                bindingStatus = receipt.bindingStatus,
                qaItemId = null,
                qaItemKey = null,
                responseJson = receipt.responseJson,
                updatedAtEpochMs = clock(),
            ),
        )
    }

    suspend fun recordAttachmentClaimed(
        scope: AccountProjectScope,
        clientSubmissionId: String,
        clientAttachmentId: String,
        qaItemId: String,
        qaItemKey: String,
        responseJson: String,
    ): AttachmentPipelineReceiptEntity {
        require(qaItemId.isNotBlank() && qaItemKey.isNotBlank())
        val reserved = attachmentPipelineReceiptDao.findForScope(
            accountId = scope.accountId,
            projectId = scope.projectId,
            actorId = scope.actorId,
            installationId = scope.installationId,
            sessionId = scope.sessionId,
            clientSubmissionId = clientSubmissionId,
            clientAttachmentId = clientAttachmentId,
        ) ?: error("Attachment reservation receipt is missing")
        val claimed = reserved.copy(
            bindingStatus = "claimed",
            qaItemId = qaItemId,
            qaItemKey = qaItemKey,
            responseJson = responseJson,
            updatedAtEpochMs = clock(),
        )
        attachmentPipelineReceiptDao.upsert(claimed)
        return claimed
    }

    suspend fun findAttachmentReceipt(
        scope: AccountProjectScope,
        clientSubmissionId: String,
        clientAttachmentId: String,
    ): AttachmentPipelineReceiptEntity? = attachmentPipelineReceiptDao.findForScope(
        accountId = scope.accountId,
        projectId = scope.projectId,
        actorId = scope.actorId,
        installationId = scope.installationId,
        sessionId = scope.sessionId,
        clientSubmissionId = clientSubmissionId,
        clientAttachmentId = clientAttachmentId,
    )

    override suspend fun clearAccount(accountId: String) {
        accountProjectDao.deleteAccount(accountId)
    }

    companion object {
        private val ALLOWED_WRITE_METHODS = setOf("POST", "PUT", "PATCH", "DELETE")
    }
}
