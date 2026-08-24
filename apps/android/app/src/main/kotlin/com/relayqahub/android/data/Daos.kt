package com.relayqahub.android.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface AccountProjectDao {
    @Upsert
    suspend fun upsertAccount(account: AccountEntity)

    @Upsert
    suspend fun upsertProject(project: ProjectEntity)

    @Query("SELECT * FROM accounts WHERE accountId = :accountId LIMIT 1")
    fun observeAccount(accountId: String): Flow<AccountEntity?>

    @Query(
        "SELECT * FROM projects " +
            "WHERE accountId = :accountId AND projectId = :projectId LIMIT 1",
    )
    fun observeProject(accountId: String, projectId: String): Flow<ProjectEntity?>

    @Query("SELECT * FROM projects WHERE accountId = :accountId ORDER BY projectKey")
    suspend fun listProjects(accountId: String): List<ProjectEntity>

    @Query("DELETE FROM accounts WHERE accountId = :accountId")
    suspend fun deleteAccount(accountId: String)

    @Transaction
    suspend fun upsertScope(account: AccountEntity, project: ProjectEntity) {
        require(account.accountId == project.accountId)
        upsertAccount(account)
        upsertProject(project)
    }
}

@Dao
interface CachedQaItemDao {
    @Upsert
    suspend fun upsert(item: CachedQaItemEntity)

    @Query(
        "SELECT * FROM cached_qa_items " +
            "WHERE accountId = :accountId AND projectId = :projectId " +
            "ORDER BY updatedAtEpochMs DESC",
    )
    fun observeForScope(accountId: String, projectId: String): Flow<List<CachedQaItemEntity>>

    @Query(
        "SELECT * FROM cached_qa_items " +
            "WHERE accountId = :accountId AND projectId = :projectId " +
            "ORDER BY updatedAtEpochMs DESC",
    )
    suspend fun listForScope(accountId: String, projectId: String): List<CachedQaItemEntity>
}

@Dao
interface OfflineOperationDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(operation: OfflineOperationEntity)

    @Query(
        "SELECT COUNT(*) FROM offline_operations " +
            "WHERE accountId = :accountId AND projectId = :projectId " +
            "AND actorId = :actorId AND installationId = :installationId " +
            "AND sessionId = :sessionId " +
            "AND state IN ('PENDING', 'RUNNING', 'RETRY', 'BLOCKED_AUTH', 'BLOCKED_DEVICE')",
    )
    fun observeOutstandingCount(
        accountId: String,
        projectId: String,
        actorId: String,
        installationId: String,
        sessionId: String,
    ): Flow<Int>

    @Query(
        "SELECT * FROM offline_operations " +
            "WHERE accountId = :accountId AND projectId = :projectId " +
            "AND actorId = :actorId AND installationId = :installationId " +
            "AND sessionId = :sessionId " +
            "AND state IN ('PENDING', 'RETRY', 'BLOCKED_DEVICE') " +
            "AND nextAttemptAtEpochMs <= :nowEpochMs " +
            "ORDER BY createdAtEpochMs, operationId LIMIT :limit",
    )
    suspend fun listReady(
        accountId: String,
        projectId: String,
        actorId: String,
        installationId: String,
        sessionId: String,
        nowEpochMs: Long,
        limit: Int,
    ): List<OfflineOperationEntity>

    @Query(
        "SELECT * FROM offline_operations " +
            "WHERE accountId = :accountId AND projectId = :projectId " +
            "AND actorId = :actorId AND installationId = :installationId " +
            "AND sessionId = :sessionId " +
            "ORDER BY createdAtEpochMs, operationId",
    )
    suspend fun listForScope(
        accountId: String,
        projectId: String,
        actorId: String,
        installationId: String,
        sessionId: String,
    ): List<OfflineOperationEntity>

    @Query(
        "SELECT DISTINCT accountId, projectId, actorId, installationId, sessionId " +
            "FROM offline_operations WHERE state = 'BLOCKED_DEVICE' " +
            "ORDER BY accountId, projectId, actorId, installationId, sessionId",
    )
    suspend fun listBlockedDeviceScopes(): List<AccountProjectScope>

    @Query(
        "SELECT * FROM offline_operation_receipts WHERE operationId = :operationId LIMIT 1",
    )
    suspend fun findReceipt(operationId: String): OfflineOperationReceiptEntity?

    @Query(
        "UPDATE offline_operations SET state = 'RUNNING', updatedAtEpochMs = :nowEpochMs " +
            "WHERE operationId IN (:operationIds) " +
            "AND accountId = :accountId AND projectId = :projectId " +
            "AND actorId = :actorId AND installationId = :installationId " +
            "AND sessionId = :sessionId " +
            "AND state IN ('PENDING', 'RETRY', 'BLOCKED_DEVICE')",
    )
    suspend fun markRunning(
        accountId: String,
        projectId: String,
        actorId: String,
        installationId: String,
        sessionId: String,
        operationIds: List<String>,
        nowEpochMs: Long,
    ): Int

    @Query(
        "UPDATE offline_operations SET state = :state, attemptCount = attemptCount + 1, " +
            "nextAttemptAtEpochMs = :nextAttemptAtEpochMs, lastErrorCode = :errorCode, " +
            "updatedAtEpochMs = :nowEpochMs " +
            "WHERE operationId = :operationId " +
            "AND accountId = :accountId AND projectId = :projectId " +
            "AND actorId = :actorId AND installationId = :installationId " +
            "AND sessionId = :sessionId AND state = 'RUNNING' AND :state != 'SUCCEEDED'",
    )
    suspend fun recordAttempt(
        accountId: String,
        projectId: String,
        actorId: String,
        installationId: String,
        sessionId: String,
        operationId: String,
        state: QueueState,
        nextAttemptAtEpochMs: Long,
        errorCode: String?,
        nowEpochMs: Long,
    ): Int

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertReceipt(receipt: OfflineOperationReceiptEntity)

    @Query(
        "UPDATE offline_operations SET state = 'SUCCEEDED', attemptCount = attemptCount + 1, " +
            "nextAttemptAtEpochMs = :nowEpochMs, lastErrorCode = NULL, " +
            "updatedAtEpochMs = :nowEpochMs " +
            "WHERE operationId = :operationId " +
            "AND accountId = :accountId AND projectId = :projectId " +
            "AND actorId = :actorId AND installationId = :installationId " +
            "AND sessionId = :sessionId AND state = 'RUNNING' " +
            "AND EXISTS (SELECT 1 FROM offline_operation_receipts receipt " +
            "WHERE receipt.operationId = offline_operations.operationId " +
            "AND receipt.accountId = offline_operations.accountId " +
            "AND receipt.projectId = offline_operations.projectId " +
            "AND receipt.actorId = offline_operations.actorId " +
            "AND receipt.installationId = offline_operations.installationId " +
            "AND receipt.sessionId = offline_operations.sessionId)",
    )
    suspend fun markSucceededWithReceipt(
        accountId: String,
        projectId: String,
        actorId: String,
        installationId: String,
        sessionId: String,
        operationId: String,
        nowEpochMs: Long,
    ): Int

    @Transaction
    suspend fun completeCreateBug(
        operation: OfflineOperationEntity,
        receipt: OfflineOperationReceiptEntity,
        nowEpochMs: Long,
    ) {
        check(operation.operationKind == "CREATE_BUG")
        check(receipt.operationId == operation.operationId)
        check(receipt.accountId == operation.accountId)
        check(receipt.projectId == operation.projectId)
        check(receipt.actorId == operation.actorId)
        check(receipt.installationId == operation.installationId)
        check(receipt.sessionId == operation.sessionId)
        check(
            operation.idempotencyKey ==
                "submission:${receipt.clientSubmissionId}:commit",
        ) { "CreateBug receipt clientSubmissionId does not match the queued idempotency key" }
        insertReceipt(receipt)
        check(
            markSucceededWithReceipt(
                accountId = operation.accountId,
                projectId = operation.projectId,
                actorId = operation.actorId,
                installationId = operation.installationId,
                sessionId = operation.sessionId,
                operationId = operation.operationId,
                nowEpochMs = nowEpochMs,
            ) == 1,
        ) { "CreateBug receipt could not be bound to the running scoped operation" }
    }

    @Query(
        "UPDATE offline_operations SET state = 'BLOCKED_DEVICE', " +
            "lastErrorCode = :errorCode, nextAttemptAtEpochMs = :nowEpochMs, " +
            "updatedAtEpochMs = :nowEpochMs " +
            "WHERE operationId = :operationId " +
            "AND accountId = :accountId AND projectId = :projectId " +
            "AND actorId = :actorId AND installationId = :installationId " +
            "AND sessionId = :sessionId AND state = 'RUNNING'",
    )
    suspend fun recordDeviceBlock(
        accountId: String,
        projectId: String,
        actorId: String,
        installationId: String,
        sessionId: String,
        operationId: String,
        errorCode: String,
        nowEpochMs: Long,
    ): Int

    @Query(
        "UPDATE offline_operations SET state = 'RETRY', lastErrorCode = 'STALE_RUNNING_RECOVERED', " +
            "nextAttemptAtEpochMs = :nowEpochMs, updatedAtEpochMs = :nowEpochMs " +
            "WHERE accountId = :accountId AND projectId = :projectId " +
            "AND actorId = :actorId AND installationId = :installationId " +
            "AND sessionId = :sessionId " +
            "AND state = 'RUNNING' AND updatedAtEpochMs <= :staleBeforeEpochMs",
    )
    suspend fun recoverStaleRunning(
        accountId: String,
        projectId: String,
        actorId: String,
        installationId: String,
        sessionId: String,
        staleBeforeEpochMs: Long,
        nowEpochMs: Long,
    ): Int

    @Transaction
    suspend fun claimReady(
        accountId: String,
        projectId: String,
        actorId: String,
        installationId: String,
        sessionId: String,
        nowEpochMs: Long,
        limit: Int,
    ): List<OfflineOperationEntity> {
        val ready = listReady(
            accountId,
            projectId,
            actorId,
            installationId,
            sessionId,
            nowEpochMs,
            limit,
        )
        if (ready.isEmpty()) return emptyList()
        val claimed = markRunning(
            accountId,
            projectId,
            actorId,
            installationId,
            sessionId,
            ready.map(OfflineOperationEntity::operationId),
            nowEpochMs,
        )
        check(claimed == ready.size) { "Offline queue claim lost its session scope" }
        return ready.map { it.copy(state = QueueState.RUNNING, updatedAtEpochMs = nowEpochMs) }
    }
}
