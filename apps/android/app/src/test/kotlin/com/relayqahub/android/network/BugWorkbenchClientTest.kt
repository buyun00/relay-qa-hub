package com.relayqahub.android.network

import java.io.IOException
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BugWorkbenchClientTest {
    @Test
    fun `full Bug edit sends fields assignments and the final attachment set`() = runBlocking {
        var capturedBody = ""
        var capturedIdempotency = ""
        val http = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val request = chain.request()
                capturedBody = Buffer().also { request.body?.writeTo(it) }.readUtf8()
                capturedIdempotency = request.header("Idempotency-Key").orEmpty()
                assertEquals("PATCH", request.method)
                assertEquals("Bearer access-token", request.header("Authorization"))
                assertEquals("/api/v1/bugs/$BUG_ID", request.url.encodedPath)
                throw IOException("request captured")
            }
            .build()
        val client = BugWorkbenchClient(
            baseUrl = "https://qa-hub.example/api/v1/",
            httpClient = http,
        )

        val failure = runCatching {
            client.updateBug(
                request = WorkbenchBugUpdate(
                    bugId = BUG_ID,
                    expectedVersion = 7,
                    mutationId = MUTATION_ID,
                    title = "Edited title",
                    description = "Edited description",
                    expectedBehavior = "Edited expectation",
                    moduleId = null,
                    severity = "S1",
                    priority = "P0",
                    ownerId = null,
                    verificationOwnerId = VERIFIER_ID,
                    attachmentIds = listOf(ATTACHMENT_ID),
                ),
                accessToken = "access-token",
            )
        }.exceptionOrNull()

        assertEquals("NETWORK_IO", (failure as BugWorkbenchFailure).code)
        assertEquals(
            "android:updateBug:bug:$BUG_ID:v7:$MUTATION_ID",
            capturedIdempotency,
        )
        assertTrue(capturedBody.contains("\"moduleId\":null"))
        assertTrue(capturedBody.contains("\"ownerId\":null"))
        assertTrue(capturedBody.contains("\"verificationOwnerId\":\"$VERIFIER_ID\""))
        assertTrue(capturedBody.contains("\"priority\":\"P0\""))
        assertTrue(capturedBody.contains("\"attachmentIds\":[\"$ATTACHMENT_ID\"]"))
    }

    @Test
    fun `personal Bug list paginates owner and verifier indexes at one snapshot`() = runBlocking {
        val actorId = "10000000-0000-4000-8000-000000000001"
        val otherId = "10000000-0000-4000-8000-000000000002"
        val cursor = "b1.a.${"b".repeat(43)}"
        val requests = mutableListOf<String>()
        val owned = bugJson(
            "20000000-0000-4000-8000-000000000001",
            "QA-3",
            "2026-09-09T03:00:00Z",
            actorId,
            otherId,
        )
        val both = bugJson(
            "20000000-0000-4000-8000-000000000002",
            "QA-2",
            "2026-09-09T02:00:00Z",
            actorId,
            actorId,
        )
        val verifying = bugJson(
            "20000000-0000-4000-8000-000000000003",
            "QA-1",
            "2026-09-09T01:00:00Z",
            otherId,
            actorId,
        )
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            val owner = request.url.queryParameter("ownerId")
            val verifier = request.url.queryParameter("verificationOwnerId")
            val pageCursor = request.url.queryParameter("cursor")
            requests += "$owner|$verifier|$pageCursor"
            val response = when {
                owner == actorId && pageCursor == null -> bugList(77L, listOf(owned), cursor)
                owner == actorId && pageCursor == cursor -> bugList(77L, listOf(both), null)
                verifier == actorId && pageCursor == null -> bugList(77L, listOf(both, verifying), null)
                else -> error("Unexpected personal Bug request: ${request.url}")
            }
            jsonResponse(request, response)
        }.build()

        val result = BugWorkbenchClient("https://qa-hub.example/api/v1/", http)
            .listAssignedBugs(PROJECT_ID, actorId, 2, "access-token")

        assertEquals(77L, result.snapshotSequence)
        assertEquals(listOf("QA-3", "QA-2", "QA-1"), result.items.map { it.key })
        assertEquals(3, result.items.map { it.id }.distinct().size)
        val byKey = result.items.associateBy { it.key }
        assertEquals(actorId, byKey.getValue("QA-3").ownerAssignmentProof?.actorId)
        assertEquals(null, byKey.getValue("QA-3").verifierAssignmentProof)
        assertEquals(actorId, byKey.getValue("QA-2").ownerAssignmentProof?.actorId)
        assertEquals(actorId, byKey.getValue("QA-2").verifierAssignmentProof?.actorId)
        assertEquals(null, byKey.getValue("QA-1").ownerAssignmentProof)
        assertEquals(actorId, byKey.getValue("QA-1").verifierAssignmentProof?.actorId)
        assertEquals(
            listOf("$actorId|null|null", "$actorId|null|$cursor", "null|$actorId|null"),
            requests,
        )
    }

    @Test
    fun `project Bug authorization stream is complete and does not reuse responsibility filters`() =
        runBlocking {
            val cursor = "b1.a.${"b".repeat(43)}"
            val responsibilityOwner = "10000000-0000-4000-8000-000000000008"
            val responsibilityVerifier = "10000000-0000-4000-8000-000000000009"
            val requests = mutableListOf<String>()
            val first = bugJson(
                "20000000-0000-4000-8000-000000000001",
                "QA-2",
                "2026-09-09T02:00:00Z",
                responsibilityOwner,
                responsibilityVerifier,
            )
            val second = bugJson(
                "20000000-0000-4000-8000-000000000002",
                "QA-1",
                "2026-09-09T01:00:00Z",
                responsibilityOwner,
                responsibilityVerifier,
            )
            val http = OkHttpClient.Builder().addInterceptor { chain ->
                val request = chain.request()
                assertEquals("/api/v1/bugs", request.url.encodedPath)
                assertEquals(PROJECT_ID, request.url.queryParameter("projectId"))
                assertEquals(null, request.url.queryParameter("ownerId"))
                assertEquals(null, request.url.queryParameter("verificationOwnerId"))
                requests += request.url.queryParameter("cursor") ?: "first"
                jsonResponse(
                    request,
                    if (request.url.queryParameter("cursor") == null) {
                        bugList(77L, listOf(first), cursor)
                    } else {
                        bugList(77L, listOf(second), null)
                    },
                )
            }.build()

            val result = BugWorkbenchClient("https://qa-hub.example/api/v1/", http)
                .listProjectBugs(PROJECT_ID, 1, "access-token")

            assertEquals(77L, result.snapshotSequence)
            assertEquals(listOf("QA-2", "QA-1"), result.items.map { it.key })
            assertEquals(listOf("first", cursor), requests)
            assertTrue(result.items.all { it.ownerAssignmentProof == null })
            assertTrue(result.items.all { it.verifierAssignmentProof == null })
        }

    @Test
    fun `personal Bug list rejects snapshot changes within or across assignment indexes`() =
        runBlocking {
            val actorId = "10000000-0000-4000-8000-000000000001"
            val cursor = "b1.a.${"b".repeat(43)}"
            listOf(true, false).forEach { withinOwnerStream ->
                var requests = 0
                val http = OkHttpClient.Builder().addInterceptor { chain ->
                    val request = chain.request()
                    requests += 1
                    val owner = request.url.queryParameter("ownerId")
                    val pageCursor = request.url.queryParameter("cursor")
                    val response = when {
                        withinOwnerStream && requests == 1 -> bugList(10L, emptyList(), cursor)
                        withinOwnerStream && pageCursor == cursor -> bugList(11L, emptyList(), null)
                        !withinOwnerStream && owner != null -> bugList(10L, emptyList(), null)
                        !withinOwnerStream -> bugList(11L, emptyList(), null)
                        else -> error("Unexpected request")
                    }
                    jsonResponse(request, response)
                }.build()

                val failure = runCatching {
                    BugWorkbenchClient("https://qa-hub.example/api/v1/", http)
                        .listAssignedBugs(PROJECT_ID, actorId, 2, "access-token")
                }.exceptionOrNull()

                assertEquals("WORKBENCH_SNAPSHOT_CHANGED", (failure as BugWorkbenchFailure).code)
            }
        }

    @Test
    fun `personal Bug pagination rejects repeated and malformed cursors`() = runBlocking {
        val actorId = "10000000-0000-4000-8000-000000000001"
        val cursor = "b1.a.${"b".repeat(43)}"
        var requestCount = 0
        val repeatedHttp = OkHttpClient.Builder().addInterceptor { chain ->
            requestCount += 1
            jsonResponse(chain.request(), bugList(10L, emptyList(), cursor))
        }.build()
        val repeated = runCatching {
            BugWorkbenchClient("https://qa-hub.example/api/v1/", repeatedHttp)
                .listAssignedBugs(PROJECT_ID, actorId, 2, "access-token")
        }.exceptionOrNull()
        assertEquals("WORKBENCH_CURSOR_REPEATED", (repeated as BugWorkbenchFailure).code)
        assertEquals(2, requestCount)

        listOf(JSONObject.NULL, 7, "", "cursor").drop(1).forEach { malformed ->
            val http = OkHttpClient.Builder().addInterceptor { chain ->
                jsonResponse(
                    chain.request(),
                    JSONObject().put("snapshotSequence", 10).put("items", JSONArray())
                        .put("nextCursor", malformed),
                )
            }.build()
            val failure = runCatching {
                BugWorkbenchClient("https://qa-hub.example/api/v1/", http)
                    .listAssignedBugs(PROJECT_ID, actorId, 2, "access-token")
            }.exceptionOrNull()
            assertEquals("WORKBENCH_CURSOR_INVALID", (failure as BugWorkbenchFailure).code)
        }
    }

    @Test
    fun `personal Bug pagination rejects duplicate ids within and across pages`() = runBlocking {
        val actorId = "10000000-0000-4000-8000-000000000001"
        val cursor = "b1.a.${"b".repeat(43)}"
        val item = bugJson(
            "20000000-0000-4000-8000-000000000001",
            "QA-1",
            "2026-09-09T01:00:00Z",
            actorId,
            actorId,
        )
        listOf(true, false).forEach { withinPage ->
            var calls = 0
            val http = OkHttpClient.Builder().addInterceptor { chain ->
                calls += 1
                val response = when {
                    calls == 1 && withinPage -> bugList(10L, listOf(item, JSONObject(item.toString())), null)
                    calls == 1 -> bugList(10L, listOf(item), cursor)
                    else -> bugList(10L, listOf(JSONObject(item.toString())), null)
                }
                jsonResponse(chain.request(), response)
            }.build()

            val failure = runCatching {
                BugWorkbenchClient("https://qa-hub.example/api/v1/", http)
                    .listAssignedBugs(PROJECT_ID, actorId, 100, "access-token")
            }.exceptionOrNull()

            assertEquals("WORKBENCH_ITEM_REPEATED", (failure as BugWorkbenchFailure).code)
        }
    }

    @Test
    fun `personal Bug pagination requires an exact integer snapshot and explicit cursor`() = runBlocking {
        val actorId = "10000000-0000-4000-8000-000000000001"
        listOf("10", 10.5, -1).forEach { malformedSnapshot ->
            val http = OkHttpClient.Builder().addInterceptor { chain ->
                jsonResponse(
                    chain.request(),
                    JSONObject().put("snapshotSequence", malformedSnapshot)
                        .put("items", JSONArray()).put("nextCursor", JSONObject.NULL),
                )
            }.build()
            val failure = runCatching {
                BugWorkbenchClient("https://qa-hub.example/api/v1/", http)
                    .listAssignedBugs(PROJECT_ID, actorId, 2, "access-token")
            }.exceptionOrNull()
            assertEquals("WORKBENCH_SNAPSHOT_INVALID", (failure as BugWorkbenchFailure).code)
        }

        val missingCursorHttp = OkHttpClient.Builder().addInterceptor { chain ->
            jsonResponse(
                chain.request(),
                JSONObject().put("snapshotSequence", 10).put("items", JSONArray()),
            )
        }.build()
        val missing = runCatching {
            BugWorkbenchClient("https://qa-hub.example/api/v1/", missingCursorHttp)
                .listAssignedBugs(PROJECT_ID, actorId, 2, "access-token")
        }.exceptionOrNull()
        assertEquals("INVALID_WORKBENCH_RESPONSE", (missing as BugWorkbenchFailure).code)
    }

    @Test
    fun `personal Bug list trusts a successful server filter to retain linked identity aliases`() = runBlocking {
        val actorId = "10000000-0000-4000-8000-000000000001"
        val aliasId = "10000000-0000-4000-8000-000000000002"
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val matchesVerifier = chain.request().url.queryParameter("verificationOwnerId") == actorId
            jsonResponse(
                chain.request(),
                bugList(
                    10L,
                    if (matchesVerifier) listOf(
                        bugJson(
                            "20000000-0000-4000-8000-000000000001",
                            "QA-1",
                            "2026-09-09T01:00:00Z",
                            aliasId,
                            aliasId,
                        ),
                    ) else emptyList(),
                    null,
                ),
            )
        }.build()

        val result = BugWorkbenchClient("https://qa-hub.example/api/v1/", http)
            .listAssignedBugs(PROJECT_ID, actorId, 2, "access-token")

        assertEquals(1, result.items.size)
        assertEquals(aliasId, result.items.single().ownerId)
        assertEquals(aliasId, result.items.single().verificationOwnerId)
        assertEquals(actorId, result.items.single().verifierAssignmentProof?.actorId)
        assertEquals(10L, result.items.single().verifierAssignmentProof?.snapshotSequence)
    }

    @Test
    fun `personal Bug merge follows server number order for timestamp ties`() = runBlocking {
        val actorId = "10000000-0000-4000-8000-000000000001"
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val isVerifier = chain.request().url.queryParameter("verificationOwnerId") == actorId
            val items = if (isVerifier) listOf(
                bugJson("20000000-0000-4000-8000-000000000009", "QA-9", "2026-09-09T01:00:00Z", actorId, actorId),
                bugJson("20000000-0000-4000-8000-000000000010", "QA-10", "2026-09-09T01:00:00Z", actorId, actorId),
            ) else emptyList()
            jsonResponse(chain.request(), bugList(10L, items, null))
        }.build()

        val result = BugWorkbenchClient("https://qa-hub.example/api/v1/", http)
            .listAssignedBugs(PROJECT_ID, actorId, 100, "access-token")

        assertEquals(listOf("QA-10", "QA-9"), result.items.map { it.key })
    }

    @Test
    fun `personal Bug list rejects missing and coerced item fields`() = runBlocking {
        val actorId = "10000000-0000-4000-8000-000000000001"
        val valid = bugJson(
            "20000000-0000-4000-8000-000000000001",
            "QA-1",
            "2026-09-09T01:00:00Z",
            actorId,
            actorId,
        )
        val malformedItems = listOf(
            JSONObject(valid.toString()).apply { remove("description") },
            JSONObject(valid.toString()).put("version", "1"),
            JSONObject(valid.toString()).put("occurrenceCount", 1.5),
            JSONObject(valid.toString()).put("reporterId", "unknown"),
            JSONObject(valid.toString()).put("reporterId", "1-1-1-1-1"),
            JSONObject(valid.toString()).put("projectId", "20000000-0000-4000-8000-000000000099"),
            JSONObject(valid.toString()).put("unexpected", true),
        )
        malformedItems.forEach { malformed ->
            val http = OkHttpClient.Builder().addInterceptor { chain ->
                jsonResponse(chain.request(), bugList(10L, listOf(malformed), null))
            }.build()
            val failure = runCatching {
                BugWorkbenchClient("https://qa-hub.example/api/v1/", http)
                    .listAssignedBugs(PROJECT_ID, actorId, 2, "access-token")
            }.exceptionOrNull()

            assertEquals("INVALID_WORKBENCH_ITEM", (failure as BugWorkbenchFailure).code)
        }
    }

    @Test
    fun `personal Bug list rejects extra root fields`() = runBlocking {
        val actorId = "10000000-0000-4000-8000-000000000001"
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            jsonResponse(chain.request(), bugList(10L, emptyList(), null).put("projectId", PROJECT_ID))
        }.build()

        val failure = runCatching {
            BugWorkbenchClient("https://qa-hub.example/api/v1/", http)
                .listAssignedBugs(PROJECT_ID, actorId, 100, "access-token")
        }.exceptionOrNull()

        assertEquals("INVALID_WORKBENCH_RESPONSE", (failure as BugWorkbenchFailure).code)
    }

    private fun bugJson(
        id: String,
        key: String,
        updatedAt: String,
        ownerId: String,
        verificationOwnerId: String,
    ) = JSONObject()
        .put("id", id)
        .put("projectId", PROJECT_ID)
        .put("number", key.substringAfterLast('-').toInt())
        .put("key", key)
        .put("title", "$key fixture")
        .put("description", "$key description")
        .put("expectedBehavior", "$key expected behavior")
        .put("moduleId", JSONObject.NULL)
        .put("state", "ready_for_verification")
        .put("severity", "S2")
        .put("priority", "P2")
        .put("reporterId", "30000000-0000-4000-8000-000000000001")
        .put("ownerId", ownerId)
        .put("verificationOwnerId", verificationOwnerId)
        .put("duplicateOfBugId", JSONObject.NULL)
        .put("occurrenceCount", 1)
        .put("reopenCount", 0)
        .put("createdAt", "2026-09-09T00:00:00Z")
        .put("updatedAt", updatedAt)
        .put("closedAt", JSONObject.NULL)
        .put("version", 1)

    private fun bugList(snapshot: Long, items: List<JSONObject>, cursor: String?) = JSONObject()
        .put("snapshotSequence", snapshot)
        .put("items", JSONArray(items))
        .put("nextCursor", cursor ?: JSONObject.NULL)

    private fun jsonResponse(request: okhttp3.Request, body: JSONObject): Response =
        Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(200)
            .message("Fixture")
            .body(body.toString().toResponseBody())
            .build()

    private companion object {
        const val PROJECT_ID = "10000000-0000-4000-8000-000000000004"
        const val BUG_ID = "70000000-0000-4000-8000-000000000001"
        const val VERIFIER_ID = "10000000-0000-4000-8000-000000000005"
        const val ATTACHMENT_ID = "50000000-0000-4000-8000-000000000001"
        const val MUTATION_ID = "60000000-0000-4000-8000-000000000001"
    }
}
