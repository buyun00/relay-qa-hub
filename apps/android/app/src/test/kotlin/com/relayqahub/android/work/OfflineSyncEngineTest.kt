package com.relayqahub.android.work

import com.relayqahub.android.PendingBugSubmission
import com.relayqahub.android.data.AccountProjectScope
import com.relayqahub.android.data.OfflineOperationDao
import com.relayqahub.android.data.OfflineOperationEntity
import com.relayqahub.android.data.OfflineOperationReceiptEntity
import com.relayqahub.android.data.QueueState
import com.relayqahub.android.data.UnconfirmedCreateSubmission
import com.relayqahub.android.data.isUnconfirmedCreate
import com.relayqahub.android.data.isReconfirmableCreateProtocolFailure
import com.sun.net.httpserver.HttpServer
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
import java.net.InetSocketAddress
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
    fun `retry ceiling preserves a readable uncertain submission for explicit confirmation`() = runBlocking {
        val dao = FakeOperationDao(
            operation(attemptCount = OfflineSyncEngine.MAX_OPERATION_ATTEMPTS - 1),
        )
        val engine = engine(dao, ApiOutcome.Retryable("HTTP_503"))

        val result = engine.run(SCOPE)

        assertTrue(result is SyncRunResult.Exhausted)
        assertEquals(QueueState.FAILED_PERMANENT, dao.operations.single().state)
        assertEquals("RETRY_EXHAUSTED_HTTP_503", dao.operations.single().lastErrorCode)
        assertTrue(dao.operations.single().isUnconfirmedCreate())
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
            val failed = dao.operations.single()
            val recovery = UnconfirmedCreateSubmission(dao) { 1L }
            assertEquals(failed, recovery.resume(SCOPE, failed.idempotencyKey))
            assertEquals(listOf(failed), recovery.legacyCandidates(SCOPE, null))
            engine(dao, ApiOutcome.Success(201, queued.syntheticCreateBugReceipt())).run(SCOPE)
            assertEquals(failed, dao.operations.single())
            assertTrue(dao.receipts.isEmpty())
            val rearmed = recovery.reconfirmProtocolFailure(SCOPE, failed.operationId, failed.idempotencyKey)
            assertEquals(failed.payloadJson, rearmed.payloadJson)
            engine(dao, ApiOutcome.Success(201, queued.syntheticCreateBugReceipt()), clock = { 1L }).run(SCOPE)
            assertEquals(QueueState.SUCCEEDED, dao.operations.single().state)
            assertEquals(queued.operationId, dao.receipts.single().operationId)
        }
    }

    @Test
    fun `attachment promotion posts bug and persists receipt in the same worker run`() = runBlocking {
        val queued = operation().copy(
            operationKind = OfflineAttachmentDraftContract.OPERATION_KIND,
            payloadJson = "{\"staged\":true}",
        )
        val dao = FakeOperationDao(queued)
        val promoted = queued.copy(
            operationKind = "CREATE_BUG",
            httpMethod = "POST",
            relativePath = "/bugs",
            payloadJson = "{\"promoted\":true}",
            state = QueueState.PENDING,
        )
        val promoter = object : OfflineAttachmentDraftPromoter {
            override suspend fun promote(
                scope: AccountProjectScope,
                operation: OfflineOperationEntity,
                accessToken: String,
            ): OfflineAttachmentStageResult {
                assertEquals(OfflineAttachmentDraftContract.OPERATION_KIND, operation.operationKind)
                dao.operations.replaceAll { current ->
                    if (current.operationId == operation.operationId) promoted else current
                }
                return OfflineAttachmentStageResult.Promoted(promoted)
            }
        }
        val api = FakeQaHubApiClient(
            listOf(ApiOutcome.Success(201, promoted.syntheticCreateBugReceipt())),
        )
        val vault = FakeCredentialVault()
        vault.put(SCOPE.nativeSessionScope(), credentials())
        val engine = OfflineSyncEngine(
            operationDao = dao,
            apiClient = api,
            credentialVault = vault,
            attachmentDraftProcessor = promoter,
            clock = { 0L },
        )

        val result = engine.run(SCOPE)

        assertTrue(result is SyncRunResult.Completed)
        assertEquals(listOf(promoted.operationId), api.calls.map { it.operationId })
        assertEquals(QueueState.SUCCEEDED, dao.operations.single().state)
        assertEquals(promoted.operationId, dao.receipts.single().operationId)
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
    fun `four real HTTP response losses then explicit retry confirm one original effect`() = runBlocking {
        var now = 0L
        val original = realOkHttpOperation()
        val dao = FakeOperationDao(original)
        val effects = linkedMapOf<String, String>()
        val observed = mutableListOf<Pair<String, String>>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/v1/bugs") { exchange ->
            val key = exchange.requestHeaders.getFirst("Idempotency-Key")
            val bytes = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
            synchronized(observed) {
                observed += key to bytes
                val existing = effects.putIfAbsent(key, bytes)
                check(existing == null || existing == bytes)
                if (observed.size <= 4) {
                    exchange.close() // Committed, but no status line or success receipt reaches OkHttp.
                } else {
                    val reply = CommittedThenLostInterceptor().successJson().toByteArray(Charsets.UTF_8)
                    exchange.responseHeaders.set("Content-Type", QaHubApiContract.VERSIONED_JSON)
                    exchange.sendResponseHeaders(201, reply.size.toLong())
                    exchange.responseBody.use { it.write(reply) }
                }
            }
        }
        server.start()
        try {
            val api = OkHttpQaHubApiClient(
                "http://127.0.0.1:${server.address.port}/api/v1/", OkHttpClient.Builder().build(),
                allowPrivateHttp = true,
            )
            val vault = FakeCredentialVault()
            vault.put(REAL_SCOPE.nativeSessionScope(), credentials())
            val engine = OfflineSyncEngine(dao, api, vault, clock = { now })
            repeat(4) {
                val result = engine.run(REAL_SCOPE)
                assertTrue(if (it < 3) result is SyncRunResult.ContinueAt else result is SyncRunResult.Exhausted)
                now = dao.operations.single().nextAttemptAtEpochMs
            }
            assertTrue(dao.operations.single().isUnconfirmedCreate())
            assertTrue(dao.receipts.isEmpty())
            assertEquals(1, effects.size)
            assertEquals(4, observed.size)
            assertEquals(SyncRunResult.Completed(0), engine.run(REAL_SCOPE))

            // Reopening the screen/restarting recovery does not create a replacement intent.
            val recovery = UnconfirmedCreateSubmission(dao, clock = { now })
            for (foreign in listOf(
                REAL_SCOPE.copy(accountId = "other-account"), REAL_SCOPE.copy(projectId = "other-project"),
                REAL_SCOPE.copy(actorId = "other-actor"), REAL_SCOPE.copy(installationId = "other-installation"),
                REAL_SCOPE.copy(sessionId = "other-session"),
            )) assertEquals(null, recovery.resume(foreign, original.idempotencyKey))
            val resumed = checkNotNull(recovery.resume(REAL_SCOPE, original.idempotencyKey))
            assertEquals(original.operationId, resumed.operationId)
            assertEquals(original.payloadJson, resumed.payloadJson)
            assertEquals(original.idempotencyKey, resumed.idempotencyKey)
            assertEquals(0, resumed.attemptCount)
            assertEquals(resumed, UnconfirmedCreateSubmission(dao) { now }.resume(REAL_SCOPE, original.idempotencyKey))
            assertTrue(engine.run(REAL_SCOPE) is SyncRunResult.Completed)
            assertEquals(1, effects.size)
            assertEquals(List(5) { original.idempotencyKey to original.payloadJson }, observed)
            assertEquals(1, dao.operations.size)
            assertEquals(1, dao.receipts.size)
            assertEquals(QA_ITEM_ID, dao.receipts.single().qaItemId)
            assertEquals(QueueState.SUCCEEDED, dao.operations.single().state)
            assertEquals(listOf("receipt", "succeeded"), dao.completionEvents)
            recovery.resume(REAL_SCOPE, original.idempotencyKey)
            assertEquals(SyncRunResult.Completed(0), engine.run(REAL_SCOPE))
            assertEquals(5, observed.size)
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `exhausted attachment staging retains original attachment identities and payload on resume`() = runBlocking {
        val original = operation(attemptCount = 3).copy(
            operationKind = OfflineAttachmentDraftContract.OPERATION_KIND,
            payloadJson = """{"clientSubmissionId":"test","attachments":[{"clientAttachmentId":"original-image"},{"clientAttachmentId":"annotated-image"}]}""",
        )
        val dao = FakeOperationDao(original)
        val api = FakeQaHubApiClient()
        val vault = FakeCredentialVault()
        vault.put(SCOPE.nativeSessionScope(), credentials())
        val promoter = object : OfflineAttachmentDraftPromoter {
            override suspend fun promote(scope: AccountProjectScope, operation: OfflineOperationEntity,
                accessToken: String): OfflineAttachmentStageResult =
                OfflineAttachmentStageResult.Retryable("UPLOAD_RESPONSE_LOST")
        }
        val engine = OfflineSyncEngine(dao, api, vault, attachmentDraftProcessor = promoter, clock = { 0L })
        assertTrue(engine.run(SCOPE) is SyncRunResult.Exhausted)
        assertTrue(api.calls.isEmpty())
        val resumed = checkNotNull(UnconfirmedCreateSubmission(dao) { 100L }.resume(SCOPE, original.idempotencyKey))
        assertEquals(original.operationId, resumed.operationId)
        assertEquals(original.operationKind, resumed.operationKind)
        assertEquals(original.payloadJson, resumed.payloadJson)
        assertEquals(original.idempotencyKey, resumed.idempotencyKey)
        assertEquals(QueueState.RETRY, resumed.state)
        assertEquals(1, dao.operations.size)
    }

    @Test
    fun `recovery cannot rearm a rejected or unrelated operation`() = runBlocking {
        for (original in listOf(
            operation().copy(state = QueueState.FAILED_PERMANENT, lastErrorCode = "HTTP_400"),
            operation().copy(operationKind = "OTHER", state = QueueState.FAILED_PERMANENT,
                lastErrorCode = "RETRY_EXHAUSTED_HTTP_503"),
        )) {
            val dao = FakeOperationDao(original)
            val result = UnconfirmedCreateSubmission(dao) { 123L }.resume(SCOPE, original.idempotencyKey)
            assertEquals(original, result)
            assertEquals(listOf(original), dao.operations)
        }
    }

    @Test
    fun `real client permanent success violations preserve original intent and block fresh creation`() = runBlocking {
        val valid = CommittedThenLostInterceptor().successJson()
        val foreign = valid.replace("\"projectId\":\"${REAL_SCOPE.projectId}\"",
            "\"projectId\":\"00000000-0000-4000-8000-000000000999\"")
        for ((status, body) in listOf(200 to valid, 202 to valid, 204 to valid, 201 to foreign)) {
            var serverRecovered = false
            val effects = linkedMapOf<String, String>()
            val requests = mutableListOf<Pair<String, String>>()
            val api = OkHttpQaHubApiClient("https://qa-hub.invalid/api/v1/", OkHttpClient.Builder()
                .addInterceptor { chain ->
                    val key = checkNotNull(chain.request().header("Idempotency-Key"))
                    val payload = Buffer().use { buffer ->
                        checkNotNull(chain.request().body).writeTo(buffer); buffer.readUtf8()
                    }
                    val prior = effects.putIfAbsent(key, payload)
                    check(prior == null || prior == payload)
                    requests += key to payload
                    Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                        .code(if (serverRecovered) 201 else status).message("Synthetic committed response")
                        .body((if (serverRecovered) valid else body).toResponseBody(QaHubApiContract.VERSIONED_JSON.toMediaType())).build()
                }.build())
            val original = realOkHttpOperation()
            val dao = FakeOperationDao(original)
            val vault = FakeCredentialVault()
            vault.put(REAL_SCOPE.nativeSessionScope(), credentials())
            var now = 0L
            val engine = OfflineSyncEngine(dao, api, vault, clock = { now })
            engine.run(REAL_SCOPE)
            val failed = dao.operations.single()
            assertEquals(QueueState.FAILED_PERMANENT, failed.state)
            assertEquals(if (status == 201) "SUCCESS_RESPONSE_SCOPE_MISMATCH"
                else "UNEXPECTED_CREATE_BUG_SUCCESS_STATUS_$status", failed.lastErrorCode)
            now = 10L
            val recovery = UnconfirmedCreateSubmission(dao) { now }
            assertEquals(listOf(failed), recovery.legacyCandidates(REAL_SCOPE, null))
            assertEquals(failed, recovery.resume(REAL_SCOPE, original.idempotencyKey))
            val pending = PendingBugSubmission.fromQueuedCreate(REAL_SCOPE, failed)
            assertEquals(original.payloadJson, pending.request?.payloadJson)
            assertEquals(original.operationId, pending.operationId)
            assertTrue(runCatching { pending.preparedRequest(REAL_SCOPE) }.isFailure)
            engine.run(REAL_SCOPE)
            assertEquals(1, requests.size)
            assertEquals(failed, dao.operations.single())
            assertEquals(1, dao.operations.size)
            assertTrue(dao.receipts.isEmpty())
            // A still-bad response also preserves the same intent; the user must explicitly retry again.
            recovery.reconfirmProtocolFailure(REAL_SCOPE, original.operationId, original.idempotencyKey)
            engine.run(REAL_SCOPE)
            assertEquals(QueueState.FAILED_PERMANENT, dao.operations.single().state)
            assertTrue(dao.receipts.isEmpty())
            // Fixing the server alone causes no automatic replay. A separate explicit action rearms it.
            serverRecovered = true
            engine.run(REAL_SCOPE)
            assertEquals(2, requests.size)
            recovery.reconfirmProtocolFailure(REAL_SCOPE, original.operationId, original.idempotencyKey)
            engine.run(REAL_SCOPE)
            assertEquals(List(3) { original.idempotencyKey to original.payloadJson }, requests)
            assertEquals(1, effects.size)
            assertEquals(1, dao.operations.size)
            assertEquals(QueueState.SUCCEEDED, dao.operations.single().state)
            assertEquals(original.operationId, dao.receipts.single().operationId)
            assertEquals(SUBMISSION_ID, dao.receipts.single().clientSubmissionId)
        }
    }

    @Test
    fun `explicit protocol reconfirmation refuses every foreign scope identity and generic failure`() = runBlocking {
        val original = realOkHttpOperation().copy(state = QueueState.FAILED_PERMANENT,
            lastErrorCode = "SUCCESS_RESPONSE_SCOPE_MISMATCH")
        val dao = FakeOperationDao(original)
        val recovery = UnconfirmedCreateSubmission(dao) { 100L }
        for (foreign in listOf(REAL_SCOPE.copy(accountId = "other"), REAL_SCOPE.copy(projectId = "other"),
            REAL_SCOPE.copy(actorId = "other"), REAL_SCOPE.copy(installationId = "other"), REAL_SCOPE.copy(sessionId = "other"))) {
            assertTrue(runCatching { recovery.reconfirmProtocolFailure(foreign, original.operationId, original.idempotencyKey) }.isFailure)
        }
        assertTrue(runCatching { recovery.reconfirmProtocolFailure(REAL_SCOPE, "other-operation", original.idempotencyKey) }.isFailure)
        assertTrue(runCatching { recovery.reconfirmProtocolFailure(REAL_SCOPE, original.operationId, "other-key") }.isFailure)
        assertEquals(listOf(original), dao.operations)
        for (code in listOf("HTTP_400", "HTTP_403", "HTTP_409", "INVALID_QUEUED_REQUEST", "UNREVIEWED_UNKNOWN",
            "UNEXPECTED_CREATE_BUG_SUCCESS_STATUS_201", "UNEXPECTED_CREATE_BUG_SUCCESS_STATUS_300")) {
            val denied = original.copy(lastErrorCode = code)
            val deniedDao = FakeOperationDao(denied)
            assertTrue(runCatching { UnconfirmedCreateSubmission(deniedDao) { 0L }
                .reconfirmProtocolFailure(REAL_SCOPE, denied.operationId, denied.idempotencyKey) }.isFailure)
            assertEquals(listOf(denied), deniedDao.operations)
        }
        for (denied in listOf(original.copy(state = QueueState.SUCCEEDED), original.copy(operationKind = "STAGE_CREATE_BUG_ATTACHMENT"),
            original.copy(httpMethod = "PATCH"), original.copy(relativePath = "/other"))) {
            assertTrue(!denied.isReconfirmableCreateProtocolFailure())
        }
    }

    @Test
    fun `legacy capture without preferences selects its exact exhausted operation and preserves attachments`() = runBlocking {
        val original = operation().copy(operationKind = OfflineAttachmentDraftContract.OPERATION_KIND,
            payloadJson = """{"projectId":"${SCOPE.projectId}","clientSubmissionId":"test","captureId":"capture-old","attachments":[{"clientAttachmentId":"old-annotated-image"}]}""",
            state = QueueState.FAILED_PERMANENT, attemptCount = 4, lastErrorCode = "RETRY_EXHAUSTED_NETWORK_IO")
        val other = operation("other").copy(idempotencyKey = "submission:other:commit")
        val dao = FakeOperationDao(other, original)
        val recovery = UnconfirmedCreateSubmission(dao) { 123L }
        assertEquals(listOf(original, other), recovery.legacyCandidates(SCOPE, "test"))
        assertEquals(QueueState.FAILED_PERMANENT, dao.operations.last().state) // Discovery never dispatches.
        val pending = PendingBugSubmission.fromQueuedCreate(SCOPE, original, "capture-old", "old-primary-image")
        assertEquals("test", pending.submissionId)
        assertEquals("old-annotated-image", pending.attachmentId)
        assertEquals("capture-old", pending.captureId)
        assertEquals(original.payloadJson, pending.request?.payloadJson)
        assertEquals(null, pending.originalDraft)
        val retried = checkNotNull(recovery.resume(SCOPE, original.idempotencyKey))
        assertEquals(original.operationId, retried.operationId)
        assertEquals(original.payloadJson, retried.payloadJson)
        assertEquals(original.idempotencyKey, retried.idempotencyKey)
        assertEquals(QueueState.RETRY, retried.state)
    }

    @Test
    fun `legacy text discovery keeps all unconfirmed records in exact scope instead of guessing latest`() = runBlocking {
        val first = operation("older").copy(state = QueueState.FAILED_PERMANENT, lastErrorCode = "HTTP_400")
        val second = operation("newer").copy(idempotencyKey = "submission:second:commit", state = QueueState.BLOCKED_AUTH)
        val foreign = operation("foreign").copy(accountId = "other")
        val unrelated = operation("not-create").copy(operationKind = "COMMENT")
        val dao = FakeOperationDao(first, second, foreign, unrelated)
        assertEquals(listOf(first, second), UnconfirmedCreateSubmission(dao) { 0L }.legacyCandidates(SCOPE, null))
        assertEquals(listOf(first, second, foreign, unrelated), dao.operations)
    }

    @Test
    fun `legacy capture refuses a matching identity hidden in any other queue scope`() = runBlocking {
        val original = operation()
        for (foreign in listOf(original.copy(accountId = "other"), original.copy(projectId = "other"),
            original.copy(actorId = "other"), original.copy(installationId = "other"), original.copy(sessionId = "other"))) {
            val dao = FakeOperationDao(foreign)
            assertTrue(runCatching { UnconfirmedCreateSubmission(dao) { 0L }.legacyCandidates(SCOPE, "test") }.isFailure)
            assertEquals(listOf(foreign), dao.operations)
        }
    }

    @Test
    fun `only succeeded with exact scoped receipt releases legacy creation guard`() = runBlocking {
        val original = realOkHttpOperation()
        val dao = FakeOperationDao(original)
        val vault = FakeCredentialVault()
        vault.put(REAL_SCOPE.nativeSessionScope(), credentials())
        OfflineSyncEngine(dao, FakeQaHubApiClient(), vault, clock = { 0L }).run(REAL_SCOPE)
        assertEquals(QueueState.SUCCEEDED, dao.operations.single().state)
        val recovery = UnconfirmedCreateSubmission(dao) { 0L }
        assertTrue(recovery.legacyCandidates(REAL_SCOPE, SUBMISSION_ID).isEmpty())
        val valid = dao.receipts.single()
        for (invalid in listOf(valid.copy(clientSubmissionId = "different"), valid.copy(accountId = "different"))) {
            dao.receipts.clear(); dao.receipts += invalid
            assertEquals(dao.operations, recovery.legacyCandidates(REAL_SCOPE, SUBMISSION_ID))
        }
        dao.receipts.clear()
        assertEquals(dao.operations, recovery.legacyCandidates(REAL_SCOPE, SUBMISSION_ID))
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
        clock: () -> Long = { 0L },
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
            clock = clock,
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

        fun successJson(): String = """
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

        override suspend fun resumeUnconfirmedCreate(
            accountId: String, projectId: String, actorId: String,
            installationId: String, sessionId: String, operationId: String, nowEpochMs: Long,
        ): Int {
            val index = operations.indexOfFirst {
                it.operationId == operationId &&
                    it.matches(accountId, projectId, actorId, installationId, sessionId) &&
                    it.isUnconfirmedCreate()
            }
            if (index < 0) return 0
            operations[index] = operations[index].copy(
                state = QueueState.RETRY, attemptCount = 0,
                nextAttemptAtEpochMs = nowEpochMs, updatedAtEpochMs = nowEpochMs,
            )
            return 1
        }

        override suspend fun hasForeignOperationForIdempotencyKey(
            accountId: String, projectId: String, actorId: String,
            installationId: String, sessionId: String, idempotencyKey: String,
        ): Boolean = operations.any {
            it.idempotencyKey == idempotencyKey &&
                !it.matches(accountId, projectId, actorId, installationId, sessionId)
        }

        override suspend fun reconfirmCreateProtocolFailure(
            accountId: String, projectId: String, actorId: String, installationId: String, sessionId: String,
            operationId: String, idempotencyKey: String, nowEpochMs: Long,
        ): Int {
            val index = operations.indexOfFirst {
                it.operationId == operationId && it.idempotencyKey == idempotencyKey &&
                    it.matches(accountId, projectId, actorId, installationId, sessionId) &&
                    it.isReconfirmableCreateProtocolFailure()
            }
            if (index < 0) return 0
            operations[index] = operations[index].copy(state = QueueState.RETRY, attemptCount = 0,
                nextAttemptAtEpochMs = nowEpochMs, updatedAtEpochMs = nowEpochMs)
            return 1
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
