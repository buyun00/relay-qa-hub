package com.relayqahub.android.network

import com.relayqahub.android.data.OfflineOperationEntity
import com.relayqahub.android.data.QueueState
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QaHubApiClientTest {
    @Test
    fun `versioned request preserves api base path and required headers`() {
        val client = OkHttpQaHubApiClient(
            baseUrl = "https://qa-hub.example/api/v1/",
            httpClient = OkHttpClient(),
        )

        val request = client.buildRequest(operation(), "opaque-access-token")

        assertEquals("https://qa-hub.example/api/v1/bugs", request.url.toString())
        assertEquals(QaHubApiContract.JSON_ACCEPT, request.header("Accept"))
        assertEquals("Bearer opaque-access-token", request.header("Authorization"))
        assertEquals("submission:$SUBMISSION_ID:commit", request.header("Idempotency-Key"))
        val contentType = request.body?.contentType()
        assertEquals(
            QaHubApiContract.VERSIONED_JSON,
            contentType?.let { "${it.type}/${it.subtype}" },
        )
    }

    @Test
    fun `client rejects non https base url`() {
        val result = runCatching {
            OkHttpQaHubApiClient("http://qa-hub.example/api/v1/", OkHttpClient())
        }

        assertTrue(result.isFailure)
    }

    @Test
    fun `json client refuses to invent a fallback for binary upload chunks`() {
        val client = OkHttpQaHubApiClient(
            baseUrl = "https://qa-hub.example/api/v1/",
            httpClient = OkHttpClient(),
        )
        listOf(0, 1).forEach { chunkIndex ->
            val chunkOperation = operation().copy(
                httpMethod = "PUT",
                relativePath = "/uploads/session-1/chunks/$chunkIndex",
            )
            assertTrue(
                runCatching {
                    client.buildRequest(chunkOperation, "opaque-access-token")
                }.isFailure,
            )
        }
    }

    @Test
    fun `queued path cannot escape the frozen api origin or prefix`() {
        val client = OkHttpQaHubApiClient(
            baseUrl = "https://qa-hub.example/api/v1/",
            httpClient = OkHttpClient.Builder()
                .followRedirects(true)
                .followSslRedirects(true)
                .retryOnConnectionFailure(true)
                .build(),
        )

        listOf(
            "///attacker.example/leak",
            "//attacker.example/leak",
            "/../bugs",
            "/./bugs",
            "/%2e%2e/bugs",
            "/bugs?next=https://attacker.example",
            "/bugs#token",
            "/bugs\\escape",
            "/bugs//nested",
        ).forEach { path ->
            assertTrue(
                "Expected path rejection: $path",
                runCatching {
                    client.buildRequest(operation().copy(relativePath = path), "secret")
                }.isFailure,
            )
        }
        assertTrue(client.hasHardenedTransportPolicy())
    }

    @Test
    fun `base url requires the exact frozen api prefix`() {
        listOf(
            "https://qa-hub.example/",
            "https://qa-hub.example/api/v2/",
            "https://qa-hub.example/prefix/api/v1/",
        ).forEach { baseUrl ->
            assertTrue(
                runCatching { OkHttpQaHubApiClient(baseUrl, OkHttpClient()) }.isFailure,
            )
        }
    }

    @Test
    fun `http outcome classifier distinguishes retry auth and permanent failures`() {
        assertTrue(HttpOutcomeClassifier.classify(201) is ApiOutcome.Success)
        assertTrue(HttpOutcomeClassifier.classify(401) is ApiOutcome.AuthExpired)
        assertTrue(HttpOutcomeClassifier.classify(403) is ApiOutcome.PermanentFailure)
        assertTrue(HttpOutcomeClassifier.classify(429) is ApiOutcome.Retryable)
        assertTrue(HttpOutcomeClassifier.classify(503) is ApiOutcome.Retryable)
        assertTrue(HttpOutcomeClassifier.classify(422) is ApiOutcome.PermanentFailure)
    }

    @Test
    fun `fake records contract context without recording bearer token`() = runBlocking {
        val client = FakeQaHubApiClient()

        client.execute(operation(), "never-record-this-token")

        assertEquals(1, client.calls.size)
        assertEquals(
            RecordedApiCall(
                operationId = OPERATION_ID,
                operationKind = "CREATE_BUG",
                accountId = ACCOUNT_ID,
                projectId = PROJECT_ID,
                actorId = ACTOR_ID,
                installationId = INSTALLATION_ID,
                sessionId = SESSION_ID,
                httpMethod = "POST",
                relativePath = "/bugs",
                payloadJson = requestJson(),
                idempotencyKey = "submission:$SUBMISSION_ID:commit",
                contractVersion = QaHubApiContract.VERSION,
            ),
            client.calls.single(),
        )
        assertFalse(client.calls.single().toString().contains("never-record-this-token"))
    }

    @Test
    fun `real okhttp createBug accepts only frozen 201 vendor response and returns receipt`() =
        runBlocking {
            val outcome = responseClient(
                status = 201,
                contentType = QaHubApiContract.VERSIONED_JSON,
                body = successJson(replayed = false),
            ).execute(operation(), "opaque-access-token")

            val success = outcome as ApiOutcome.Success
            assertEquals(201, success.httpStatus)
            val receipt = checkNotNull(success.createBugReceipt)
            assertEquals(SUBMISSION_ID, receipt.clientSubmissionId)
            assertEquals(QA_ITEM_ID, receipt.qaItemId)
            assertEquals("QA-42", receipt.qaItemKey)
            assertEquals(PROJECT_ID, receipt.projectId)
            assertEquals(OCCURRENCE_ID, receipt.occurrenceId)
            assertEquals(EVENT_ID, receipt.eventId)
            assertFalse(receipt.replayed)
        }

    @Test
    fun `real okhttp exact replay receipt remains valid`() = runBlocking {
        val outcome = responseClient(
            status = 201,
            contentType = QaHubApiContract.VERSIONED_JSON,
            body = successJson(replayed = true),
        ).execute(operation(), "opaque-access-token")

        val receipt = checkNotNull((outcome as ApiOutcome.Success).createBugReceipt)
        assertEquals(QA_ITEM_ID, receipt.qaItemId)
        assertTrue(receipt.replayed)
    }

    @Test
    fun `createBug never persists protocol-invalid success responses`() = runBlocking {
        val cases = listOf(
            Triple(204, QaHubApiContract.VERSIONED_JSON, successJson()),
            Triple(201, QaHubApiContract.VERSIONED_JSON, ""),
            Triple(201, QaHubApiContract.VERSIONED_JSON, "{}"),
            Triple(201, QaHubApiContract.VERSIONED_JSON, "<html>not json</html>"),
            Triple(201, "application/json", successJson()),
            Triple(
                201,
                QaHubApiContract.VERSIONED_JSON,
                " ".repeat(MAX_CREATE_BUG_SUCCESS_BODY_BYTES + 1),
            ),
            Triple(
                201,
                QaHubApiContract.VERSIONED_JSON,
                successJson().replace(SUBMISSION_ID, OTHER_SUBMISSION_ID),
            ),
            Triple(
                201,
                QaHubApiContract.VERSIONED_JSON,
                successJson().replace(PROJECT_ID, OTHER_PROJECT_ID),
            ),
            Triple(
                201,
                QaHubApiContract.VERSIONED_JSON,
                successJson().replaceFirst(QA_ITEM_ID, OTHER_QA_ITEM_ID),
            ),
        )

        cases.forEachIndexed { index, (status, contentType, body) ->
            val outcome = responseClient(status, contentType, body)
                .execute(operation(), "opaque-access-token")
            assertFalse("case $index must not become success", outcome is ApiOutcome.Success)
        }
    }

    @Test
    fun `coroutine cancellation cancels the in flight okhttp call`() = runBlocking {
        val interceptorEntered = CountDownLatch(1)
        val releaseInterceptor = CountDownLatch(1)
        val observedCall = AtomicReference<Call>()
        val client = OkHttpQaHubApiClient(
            baseUrl = "https://qa-hub.example/api/v1/",
            httpClient = OkHttpClient.Builder()
                .addInterceptor { chain ->
                    observedCall.set(chain.call())
                    interceptorEntered.countDown()
                    check(releaseInterceptor.await(5, TimeUnit.SECONDS))
                    throw IOException("test interceptor released")
                }
                .build(),
        )

        val requestJob = launch(Dispatchers.IO) {
            client.execute(operation(), "opaque-access-token")
        }
        assertTrue(interceptorEntered.await(5, TimeUnit.SECONDS))

        requestJob.cancel()
        assertTrue(observedCall.get().isCanceled())
        releaseInterceptor.countDown()
        requestJob.cancelAndJoin()
        assertTrue(requestJob.isCancelled)
    }

    private fun responseClient(
        status: Int,
        contentType: String,
        body: String,
    ) = OkHttpQaHubApiClient(
        baseUrl = "https://qa-hub.example/api/v1/",
        httpClient = OkHttpClient.Builder()
            .addInterceptor { chain ->
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(status)
                    .message("test")
                    .body(body.toResponseBody(contentType.toMediaType()))
                    .build()
            }
            .build(),
    )

    private fun operation() = OfflineOperationEntity(
        operationId = OPERATION_ID,
        accountId = ACCOUNT_ID,
        projectId = PROJECT_ID,
        actorId = ACTOR_ID,
        installationId = INSTALLATION_ID,
        sessionId = SESSION_ID,
        operationKind = "CREATE_BUG",
        httpMethod = "POST",
        relativePath = "/bugs",
        payloadJson = requestJson(),
        idempotencyKey = "submission:$SUBMISSION_ID:commit",
        state = QueueState.PENDING,
        attemptCount = 0,
        nextAttemptAtEpochMs = 0,
        lastErrorCode = null,
        createdAtEpochMs = 0,
        updatedAtEpochMs = 0,
    )

    private fun requestJson(): String =
        """{"projectId":"$PROJECT_ID","clientSubmissionId":"$SUBMISSION_ID","attachmentIds":[],"captureBundleId":null}"""

    private fun successJson(replayed: Boolean = false): String = """
        {
          "clientSubmissionId":"$SUBMISSION_ID",
          "qaItem":{"type":"bug","id":"$QA_ITEM_ID","key":"QA-42"},
          "disposition":"created",
          "bug":{
            "id":"$QA_ITEM_ID",
            "projectId":"$PROJECT_ID",
            "number":42,
            "key":"QA-42",
            "title":"Example bug",
            "description":"Observed failure",
            "expectedBehavior":"Expected behavior",
            "moduleId":null,
            "state":"reported",
            "severity":"S2",
            "priority":"P2",
            "reporterId":"$ACTOR_ID",
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
          "occurrenceId":"$OCCURRENCE_ID",
          "attachmentIds":[],
          "captureBundleId":null,
          "eventId":"$EVENT_ID",
          "replayed":$replayed
        }
    """.trimIndent()

    private companion object {
        const val OPERATION_ID = "00000000-0000-4000-8000-000000000001"
        const val ACCOUNT_ID = "00000000-0000-4000-8000-000000000002"
        const val PROJECT_ID = "00000000-0000-4000-8000-000000000003"
        const val ACTOR_ID = "00000000-0000-4000-8000-000000000004"
        const val INSTALLATION_ID = "00000000-0000-4000-8000-000000000005"
        const val SESSION_ID = "00000000-0000-4000-8000-000000000006"
        const val SUBMISSION_ID = "00000000-0000-4000-8000-000000000007"
        const val QA_ITEM_ID = "00000000-0000-4000-8000-000000000008"
        const val OCCURRENCE_ID = "00000000-0000-4000-8000-000000000009"
        const val EVENT_ID = "00000000-0000-4000-8000-000000000010"
        const val OTHER_SUBMISSION_ID = "00000000-0000-4000-8000-000000000011"
        const val OTHER_PROJECT_ID = "00000000-0000-4000-8000-000000000012"
        const val OTHER_QA_ITEM_ID = "00000000-0000-4000-8000-000000000013"
    }
}
