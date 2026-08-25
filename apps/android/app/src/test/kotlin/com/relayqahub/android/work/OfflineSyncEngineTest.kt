package com.relayqahub.android.work

import com.relayqahub.android.data.AccountProjectScope
import com.relayqahub.android.data.OfflineOperationDao
import com.relayqahub.android.data.OfflineOperationEntity
import com.relayqahub.android.data.OfflineOperationReceiptEntity
import com.relayqahub.android.data.QueueState
import com.relayqahub.android.network.ApiOutcome
import com.relayqahub.android.network.FakeQaHubApiClient
import com.relayqahub.android.network.IdempotentReconcileFakeQaHubApiClient
import com.relayqahub.android.network.OkHttpQaHubApiClient
import com.relayqahub.android.network.QaHubApiContract
import com.relayqahub.android.network.syntheticCreateBugReceipt
import com.relayqahub.android.security.FakeCredentialVault
import com.relayqahub.android.security.NativeCredentials
import com.relayqahub.android.security.nativeSessionScope
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OfflineSyncEngineTest {
    @Test
    fun `retryable result is requeued with bounded backoff`() = runBlocking {
        val dao = FakeOperationDao(operation())
        val engine = engine(dao, ApiOutcome.Retryable("HTTP_503"))

        val result = engine.run(SCOPE)

        assertTrue(result is SyncRunResult.ContinueAt)
        assertEquals(QueueState.RETRY, dao.operations.single().state)
        assertEquals("HTTP_503", dao.operations.single().lastErrorCode)
        assertEquals(30_000L, dao.operations.single().nextAttemptAtEpochMs)
    }

    @Test
    fun `retry ceiling becomes an explicit permanent queue state`() = runBlocking {
        val dao = FakeOperationDao(
            operation(attemptCount = OfflineSyncEngine.MAX_OPERATION_ATTEMPTS - 1),
        )
        val engine = engine(dao, ApiOutcome.Retryable("HTTP_503"))

        val result = engine.run(SCOPE)

        assertTrue(result is SyncRunResult.Exhausted)
        assertEquals(QueueState.FAILED_PERMANENT, dao.operations.single().state)
        assertEquals("RETRY_EXHAUSTED_HTTP_503", dao.operations.single().lastErrorCode)
    }

    @Test
    fun `queue cannot become succeeded without exact scoped 201 receipt`() = runBlocking {
        val queued = operation()
        listOf(
            ApiOutcome.Success(201),
            ApiOutcome.Success(204, queued.syntheticCreateBugReceipt()),
            ApiOutcome.Success(
                201,
                queued.syntheticCreateBugReceipt().copy(projectId = "wrong-project"),
            ),
        ).forEach { outcome ->
            val dao = FakeOperationDao(queued)

            engine(dao, outcome).run(SCOPE)

            assertEquals(QueueState.FAILED_PERMANENT, dao.operations.single().state)
            assertEquals("SUCCESS_RECEIPT_SCOPE_MISMATCH", dao.operations.single().lastErrorCode)
            assertTrue(dao.receipts.isEmpty())
        }
    }

    @Test
    fun `missing credentials blocks queue without invoking api`() = runBlocking {
        val dao = FakeOperationDao(operation())
        val api = FakeQaHubApiClient()
        val engine = OfflineSyncEngine(
            operationDao = dao,
            apiClient = api,
            credentialVault = FakeCredentialVault(),
            clock = { 0L },
        )

        val result = engine.run(SCOPE)

        assertTrue(result is SyncRunResult.BlockedOnAuthentication)
        assertTrue(api.calls.isEmpty())
        assertEquals(QueueState.BLOCKED_AUTH, dao.operations.single().state)
    }

    @Test
    fun `temporarily unavailable keystore blocks without consuming retry budget`() = runBlocking {
        val dao = FakeOperationDao(operation())
        val api = FakeQaHubApiClient()
        val engine = OfflineSyncEngine(
            operationDao = dao,
            apiClient = api,
            credentialVault = FakeCredentialVault(available = false),
            clock = { 0L },
        )

        val result = engine.run(SCOPE)

        assertTrue(result is SyncRunResult.BlockedOnDeviceSecurity)
        assertTrue(api.calls.isEmpty())
        assertEquals(QueueState.BLOCKED_DEVICE, dao.operations.single().state)
        assertEquals(0, dao.operations.single().attemptCount)
    }

    @Test
    fun `retry replays the exact queued operation and idempotency identity`() = runBlocking {
        var now = 0L
        val dao = FakeOperationDao(operation())
        val api = FakeQaHubApiClient(
            outcomes = listOf(
                ApiOutcome.Retryable("HTTP_503"),
                ApiOutcome.Success(201, operation().syntheticCreateBugReceipt()),
            ),
        )
        val vault = FakeCredentialVault()
        vault.put(SCOPE.nativeSessionScope(), credentials())
        val engine = OfflineSyncEngine(dao, api, vault, clock = { now })

        assertTrue(engine.run(SCOPE) is SyncRunResult.ContinueAt)
        now = 30_000L
        assertTrue(engine.run(SCOPE) is SyncRunResult.Completed)

        assertEquals(QueueState.SUCCEEDED, dao.operations.single().state)
        assertEquals(operation().operationId, dao.receipts.single().operationId)
        assertEquals(listOf("receipt", "succeeded"), dao.completionEvents)
        assertEquals(listOf("operation-1", "operation-1"), api.calls.map { it.operationId })
        assertEquals("submission:test:commit", dao.operations.single().idempotencyKey)
    }

    @Test
    fun `committed effect with lost response replays exact payload and returns original receipt`() =
        runBlocking {
            var now = 0L
            val queued = operation().copy(payloadJson = "{\"title\":\"exact queued bytes\"}")
            val dao = FakeOperationDao(queued)
            val api = IdempotentReconcileFakeQaHubApiClient(
                loseFirstResponseFor = setOf(queued.idempotencyKey),
            )
            val vault = FakeCredentialVault()
            vault.put(SCOPE.nativeSessionScope(), credentials())
            val engine = OfflineSyncEngine(dao, api, vault, clock = { now })

            assertTrue(engine.run(SCOPE) is SyncRunResult.ContinueAt)
            val committedReceipt = api.receiptFor(queued.idempotencyKey)
            assertEquals(1, api.effectCount)
            assertTrue(committedReceipt != null)
            assertTrue(api.returnedReceiptIds.isEmpty())

            now = 30_000L
            assertTrue(engine.run(SCOPE) is SyncRunResult.Completed)

            assertEquals(1, api.effectCount)
            assertEquals(listOf(queued.payloadJson, queued.payloadJson), api.observedPayloads)
            assertEquals(
                listOf(queued.idempotencyKey, queued.idempotencyKey),
                api.observedIdempotencyKeys,
            )
            assertEquals(listOf(committedReceipt), api.returnedReceiptIds)
            assertEquals(QueueState.SUCCEEDED, dao.operations.single().state)
            assertEquals(queued.operationId, dao.receipts.single().operationId)
            assertEquals(committedReceipt, dao.receipts.single().qaItemId)
            assertEquals(listOf("receipt", "succeeded"), dao.completionEvents)
        }

    @Test
    fun `real okhttp response loss replays one server effect and persists receipt before success`() =
        runBlocking {
            var now = 0L
            val queued = realOkHttpOperation()
            val dao = FakeOperationDao(queued)
            val server = CommittedThenLostInterceptor()
            val api = OkHttpQaHubApiClient(
                baseUrl = "https://qa-hub.example/api/v1/",
                httpClient = OkHttpClient.Builder().addInterceptor(server).build(),
            )
            val vault = FakeCredentialVault()
            vault.put(REAL_SCOPE.nativeSessionScope(), credentials())
            val engine = OfflineSyncEngine(dao, api, vault, clock = { now })

            assertTrue(engine.run(REAL_SCOPE) is SyncRunResult.ContinueAt)
            assertEquals(1, server.effectCount)
            assertTrue(dao.receipts.isEmpty())
            assertEquals(QueueState.RETRY, dao.operations.single().state)

            now = 30_000L
            assertTrue(engine.run(REAL_SCOPE) is SyncRunResult.Completed)

            assertEquals(1, server.effectCount)
            assertEquals(listOf(queued.payloadJson, queued.payloadJson), server.payloads)
            assertEquals(
                listOf(queued.idempotencyKey, queued.idempotencyKey),
                server.idempotencyKeys,
            )
            assertEquals(QA_ITEM_ID, dao.receipts.single().qaItemId)
            assertTrue(dao.receipts.single().replayed)
            assertEquals(listOf("receipt", "succeeded"), dao.completionEvents)
            assertEquals(QueueState.SUCCEEDED, dao.operations.single().state)
        }

    @Test
    fun `successful batch exposes a durable continuation for remaining ready work`() = runBlocking {
        val operations = (1..OfflineSyncEngine.BATCH_SIZE + 1).map { index ->
            operation(operationId = "operation-$index")
        }
        val dao = FakeOperationDao(*operations.toTypedArray())
        val vault = FakeCredentialVault()
        vault.put(SCOPE.nativeSessionScope(), credentials())
        val engine = OfflineSyncEngine(
            operationDao = dao,
            apiClient = FakeQaHubApiClient(),
            credentialVault = vault,
            clock = { 0L },
        )

        val first = engine.run(SCOPE)
        assertEquals(OfflineSyncEngine.BATCH_SIZE, (first as SyncRunResult.ContinueAt).processedCount)
        assertEquals(1, dao.operations.count { it.state == QueueState.PENDING })

        assertTrue(engine.run(SCOPE) is SyncRunResult.Completed)
        assertTrue(dao.operations.all { it.state == QueueState.SUCCEEDED })
    }

    @Test
    fun `retry delays are exponential and capped`() {
        assertEquals(30_000L, OfflineSyncEngine.retryDelayMs(0))
        assertEquals(60_000L, OfflineSyncEngine.retryDelayMs(1))
        assertEquals(
            OfflineSyncEngine.MAX_RETRY_DELAY_MS,
            OfflineSyncEngine.retryDelayMs(100),
        )
    }

    private suspend fun engine(
        dao: FakeOperationDao,
        outcome: ApiOutcome,
    ): OfflineSyncEngine {
        val vault = FakeCredentialVault()
        vault.put(
            SCOPE.nativeSessionScope(),
            credentials(),
        )
        return OfflineSyncEngine(
            operationDao = dao,
            apiClient = FakeQaHubApiClient(listOf(outcome)),
            credentialVault = vault,
            clock = { 0L },
        )
    }

    private fun operation(
        operationId: String = "operation-1",
        attemptCount: Int = 0,
    ) = OfflineOperationEntity(
        operationId = operationId,
        accountId = SCOPE.accountId,
        projectId = SCOPE.projectId,
        actorId = SCOPE.actorId,
        installationId = SCOPE.installationId,
        sessionId = SCOPE.sessionId,
        operationKind = "CREATE_BUG",
        httpMethod = "POST",
        relativePath = "/bugs",
        payloadJson = "{}",
        idempotencyKey = "submission:test:commit",
        state = QueueState.PENDING,
        attemptCount = attemptCount,
        nextAttemptAtEpochMs = 0,
        lastErrorCode = null,
        createdAtEpochMs = 0,
        updatedAtEpochMs = 0,
    )

    private fun realOkHttpOperation() = OfflineOperationEntity(
        operationId = "00000000-0000-4000-8000-000000000101",
        accountId = REAL_SCOPE.accountId,
        projectId = REAL_SCOPE.projectId,
        actorId = REAL_SCOPE.actorId,
        installationId = REAL_SCOPE.installationId,
        sessionId = REAL_SCOPE.sessionId,
        operationKind = "CREATE_BUG",
        httpMethod = "POST",
        relativePath = "/bugs",
        payloadJson =
            """{"projectId":"${REAL_SCOPE.projectId}","clientSubmissionId":"$SUBMISSION_ID","attachmentIds":[],"captureBundleId":null}""",
        idempotencyKey = "submission:$SUBMISSION_ID:commit",
        state = QueueState.PENDING,
        attemptCount = 0,
        nextAttemptAtEpochMs = 0,
        lastErrorCode = null,
        createdAtEpochMs = 0,
        updatedAtEpochMs = 0,
    )

    private class CommittedThenLostInterceptor : Interceptor {
        private val effects = linkedMapOf<String, String>()
        val payloads = mutableListOf<String>()
        val idempotencyKeys = mutableListOf<String>()
        val effectCount: Int
            get() = effects.size

        override fun intercept(chain: Interceptor.Chain): Response {
            val request = chain.request()
            val key = checkNotNull(request.header("Idempotency-Key"))
            val payload = Buffer().use { buffer ->
                checkNotNull(request.body).writeTo(buffer)
                buffer.readUtf8()
            }
            payloads += payload
            idempotencyKeys += key
            val committed = effects[key]
            if (committed == null) {
                effects[key] = payload
                throw IOException("response lost after committed effect")
            }
            check(committed == payload) { "Idempotent replay payload changed" }
            return Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(201)
                .message("Created")
                .body(successJson().toResponseBody(QaHubApiContract.VERSIONED_JSON.toMediaType()))
                .build()
        }

        private fun successJson(): String = """
            {
              "clientSubmissionId":"$SUBMISSION_ID",
              "qaItem":{"type":"bug","id":"$QA_ITEM_ID","key":"QA-9"},
              "disposition":"created",
              "bug":{
                "id":"$QA_ITEM_ID",
                "projectId":"${REAL_SCOPE.projectId}",
                "number":9,
                "key":"QA-9",
                "title":"Response lost",
                "description":"The first response was lost after commit.",
                "expectedBehavior":"Exact replay returns the original QA item.",
                "moduleId":null,
                "state":"reported",
                "severity":"S2",
                "priority":"P2",
                "reporterId":"${REAL_SCOPE.actorId}",
                "ownerId":null,
                "verificationOwnerId":null,
                "duplicateOfBugId":null,
                "occurrenceCount":1,
                "reopenCount":0,
                "version":1,
                "createdAt":"2026-08-25T00:00:00Z",
                "updatedAt":"2026-08-25T00:00:00Z",
                "closedAt":null
              },
              "occurrenceId":"00000000-0000-4000-8000-000000000109",
              "attachmentIds":[],
              "captureBundleId":null,
              "eventId":"00000000-0000-4000-8000-000000000110",
              "replayed":true
            }
        """.trimIndent()
    }

    private class FakeOperationDao(vararg initial: OfflineOperationEntity) : OfflineOperationDao {
        val operations = initial.toMutableList()
        val receipts = mutableListOf<OfflineOperationReceiptEntity>()
        val completionEvents = mutableListOf<String>()

        override suspend fun insert(operation: OfflineOperationEntity) {
            operations += operation
        }

        override fun observeOutstandingCount(
            accountId: String,
            projectId: String,
            actorId: String,
            installationId: String,
            sessionId: String,
        ): Flow<Int> = flowOf(operations.count {
            it.matches(accountId, projectId, actorId, installationId, sessionId)
        })

        override suspend fun listReady(
            accountId: String,
            projectId: String,
            actorId: String,
            installationId: String,
            sessionId: String,
            nowEpochMs: Long,
            limit: Int,
        ): List<OfflineOperationEntity> = operations.filter {
            it.matches(accountId, projectId, actorId, installationId, sessionId) &&
                it.state in setOf(
                    QueueState.PENDING,
                    QueueState.RETRY,
                    QueueState.BLOCKED_DEVICE,
                ) &&
                it.nextAttemptAtEpochMs <= nowEpochMs
        }.take(limit)

        override suspend fun listForScope(
            accountId: String,
            projectId: String,
            actorId: String,
            installationId: String,
            sessionId: String,
        ): List<OfflineOperationEntity> = operations.filter {
            it.matches(accountId, projectId, actorId, installationId, sessionId)
        }

        override suspend fun findForScopeByIdempotencyKey(
            accountId: String,
            projectId: String,
            actorId: String,
            installationId: String,
            sessionId: String,
            idempotencyKey: String,
        ): OfflineOperationEntity? = operations.singleOrNull {
            it.matches(accountId, projectId, actorId, installationId, sessionId) &&
                it.idempotencyKey == idempotencyKey
        }

        override suspend fun listBlockedDeviceScopes(): List<AccountProjectScope> = operations
            .filter { it.state == QueueState.BLOCKED_DEVICE }
            .map {
                AccountProjectScope(
                    it.accountId,
                    it.projectId,
                    it.actorId,
                    it.installationId,
                    it.sessionId,
                )
            }
            .distinct()

        override suspend fun findReceipt(operationId: String): OfflineOperationReceiptEntity? =
            receipts.singleOrNull { it.operationId == operationId }

        override suspend fun findReceiptForScope(
            operationId: String,
            accountId: String,
            projectId: String,
            actorId: String,
            installationId: String,
            sessionId: String,
        ): OfflineOperationReceiptEntity? = receipts.singleOrNull {
            it.operationId == operationId &&
                it.accountId == accountId &&
                it.projectId == projectId &&
                it.actorId == actorId &&
                it.installationId == installationId &&
                it.sessionId == sessionId
        }

        override suspend fun markRunning(
            accountId: String,
            projectId: String,
            actorId: String,
            installationId: String,
            sessionId: String,
            operationIds: List<String>,
            nowEpochMs: Long,
        ): Int {
            var changed = 0
            operations.replaceAll { operation ->
                if (
                    operation.operationId in operationIds &&
                    operation.matches(
                        accountId,
                        projectId,
                        actorId,
                        installationId,
                        sessionId,
                    )
                ) {
                    changed += 1
                    operation.copy(state = QueueState.RUNNING, updatedAtEpochMs = nowEpochMs)
                } else {
                    operation
                }
            }
            return changed
        }

        override suspend fun recordAttempt(
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
        ): Int {
            var changed = 0
            operations.replaceAll { operation ->
                if (
                    operation.operationId == operationId &&
                    operation.matches(
                        accountId,
                        projectId,
                        actorId,
                        installationId,
                        sessionId,
                    ) && operation.state == QueueState.RUNNING && state != QueueState.SUCCEEDED
                ) {
                    changed += 1
                    operation.copy(
                        state = state,
                        attemptCount = operation.attemptCount + 1,
                        nextAttemptAtEpochMs = nextAttemptAtEpochMs,
                        lastErrorCode = errorCode,
                        updatedAtEpochMs = nowEpochMs,
                    )
                } else {
                    operation
                }
            }
            return changed
        }

        override suspend fun insertReceipt(receipt: OfflineOperationReceiptEntity) {
            check(receipts.none { it.operationId == receipt.operationId })
            receipts += receipt
            completionEvents += "receipt"
        }

        override suspend fun markSucceededWithReceipt(
            accountId: String,
            projectId: String,
            actorId: String,
            installationId: String,
            sessionId: String,
            operationId: String,
            nowEpochMs: Long,
        ): Int {
            val receipt = receipts.singleOrNull { it.operationId == operationId } ?: return 0
            var changed = 0
            operations.replaceAll { operation ->
                if (
                    operation.operationId == operationId &&
                    operation.matches(
                        accountId,
                        projectId,
                        actorId,
                        installationId,
                        sessionId,
                    ) &&
                    operation.state == QueueState.RUNNING &&
                    receipt.accountId == operation.accountId &&
                    receipt.projectId == operation.projectId &&
                    receipt.actorId == operation.actorId &&
                    receipt.installationId == operation.installationId &&
                    receipt.sessionId == operation.sessionId
                ) {
                    changed += 1
                    completionEvents += "succeeded"
                    operation.copy(
                        state = QueueState.SUCCEEDED,
                        attemptCount = operation.attemptCount + 1,
                        nextAttemptAtEpochMs = nowEpochMs,
                        lastErrorCode = null,
                        updatedAtEpochMs = nowEpochMs,
                    )
                } else {
                    operation
                }
            }
            return changed
        }

        override suspend fun recordDeviceBlock(
            accountId: String,
            projectId: String,
            actorId: String,
            installationId: String,
            sessionId: String,
            operationId: String,
            errorCode: String,
            nowEpochMs: Long,
        ): Int {
            var changed = 0
            operations.replaceAll { operation ->
                if (
                    operation.operationId == operationId &&
                    operation.matches(
                        accountId,
                        projectId,
                        actorId,
                        installationId,
                        sessionId,
                    ) && operation.state == QueueState.RUNNING
                ) {
                    changed += 1
                    operation.copy(
                        state = QueueState.BLOCKED_DEVICE,
                        nextAttemptAtEpochMs = nowEpochMs,
                        lastErrorCode = errorCode,
                        updatedAtEpochMs = nowEpochMs,
                    )
                } else {
                    operation
                }
            }
            return changed
        }

        override suspend fun recoverStaleRunning(
            accountId: String,
            projectId: String,
            actorId: String,
            installationId: String,
            sessionId: String,
            staleBeforeEpochMs: Long,
            nowEpochMs: Long,
        ): Int = 0

        private fun OfflineOperationEntity.matches(
            accountId: String,
            projectId: String,
            actorId: String,
            installationId: String,
            sessionId: String,
        ): Boolean = this.accountId == accountId &&
            this.projectId == projectId &&
            this.actorId == actorId &&
            this.installationId == installationId &&
            this.sessionId == sessionId
    }

    companion object {
        private val SCOPE = AccountProjectScope(
            "account-1",
            "project-1",
            "actor-1",
            "installation-1",
            "session-1",
        )
        private val REAL_SCOPE = AccountProjectScope(
            accountId = "00000000-0000-4000-8000-000000000102",
            projectId = "00000000-0000-4000-8000-000000000103",
            actorId = "00000000-0000-4000-8000-000000000104",
            installationId = "00000000-0000-4000-8000-000000000105",
            sessionId = "00000000-0000-4000-8000-000000000106",
        )
        private const val SUBMISSION_ID = "00000000-0000-4000-8000-000000000107"
        private const val QA_ITEM_ID = "00000000-0000-4000-8000-000000000108"

        private fun credentials() = NativeCredentials(
            accessToken = "opaque-token",
            refreshToken = "opaque-refresh",
            accessTokenExpiresAtEpochMs = Long.MAX_VALUE,
            sharedDeviceSession = false,
        )
    }
}
