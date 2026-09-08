package com.relayqahub.android.network

import com.relayqahub.android.NativeProjectBindings
import java.util.UUID
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class BugLifecycleClientTest {
    private val project = "10000000-0000-4000-8000-000000000001"
    private val bugId = "20000000-0000-4000-8000-000000000001"
    private val attemptId = "30000000-0000-4000-8000-000000000001"
    private val bug = WorkbenchBug(bugId, project, "QA-1", "Fixture", "in_progress", 1, "2026-09-09T00:00:00Z", version = 4)
    private data class Call(val path: String, val body: JSONObject?, val key: String?)

    private inner class Fixture(
        private val freshState: String = "ready_for_verification",
        private val initialId: String = bugId,
        private val initialProject: String = project,
        private val initialVersion: Int = 4,
        private val freshId: String = bugId,
        private val freshProject: String = project,
        private val attemptStatus: String = "running",
        private val completeStatus: Int = 200,
    ) {
        val calls = mutableListOf<Call>()
        private var reads = 0
        private val token = "fixture-${UUID.randomUUID()}"
        val client: BugLifecycleClient
        init {
            NativeProjectBindings.register(token, project)
            val http = OkHttpClient.Builder().addInterceptor { chain ->
                val request = chain.request()
                assertEquals("Bearer $token", request.header("Authorization"))
                assertEquals(project, request.header("x-qa-project-id"))
                val path = request.url.encodedPath.removePrefix("/api/v1/")
                val body = request.body?.let { Buffer().also(it::writeTo).readUtf8() }?.let(::JSONObject)
                calls.add(Call(path, body, request.header("Idempotency-Key")))
                val response = when (path) {
                    "bugs/$bugId" -> {
                        reads++
                        if (reads == 1) """{"id":"$initialId","projectId":"$initialProject","version":$initialVersion,"state":"in_progress"}"""
                        else """{"id":"$freshId","projectId":"$freshProject","version":5,"state":"$freshState"}"""
                    }
                    "bugs/$bugId/human-workflow" -> """{"bugId":"$bugId","repairAttempt":{"id":"$attemptId","mode":"human","status":"$attemptStatus","version":2}}"""
                    "repair-attempts/$attemptId/deliver" -> """{"id":"$attemptId","status":"delivered","version":3}"""
                    "bugs/$bugId/complete" -> if (completeStatus == 200) """{"id":"$bugId","state":"ready_for_verification","version":6}""" else """{"code":"VERSION_CONFLICT"}"""
                    else -> error("Unexpected request $path")
                }
                Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
                    .code(if (path.endsWith("/complete")) completeStatus else 200).message("Fixture")
                    .body(response.toResponseBody()).build()
            }.build()
            client = BugLifecycleClient(ProjectOperationsClient("https://fixture.invalid/api/v1/", http), project, token)
        }
    }

    @Test fun `no code delivery succeeds from fresh server state without redundant completion`() = runBlocking {
        val fixture = Fixture()
        fixture.client.submitFix(bug, "Resolved without code", null, null)
        assertEquals(listOf("bugs/$bugId", "bugs/$bugId/human-workflow", "repair-attempts/$attemptId/deliver", "bugs/$bugId"), fixture.calls.map { it.path })
        assertEquals("no_code", fixture.calls[2].body!!.getString("deliveryKind"))
        assertEquals("Resolved without code", fixture.calls[2].body!!.getString("noCodeReason"))
        assertEquals(2, fixture.calls[2].body!!.getInt("expectedVersion"))
    }

    @Test fun `code delivery still completes with freshly read version and original attempt`() = runBlocking {
        val fixture = Fixture(freshState = "awaiting_build")
        fixture.client.submitFix(bug, "Actual code delivered", "fix/qa", "a".repeat(40))
        assertEquals("code", fixture.calls[2].body!!.getString("deliveryKind"))
        val complete = fixture.calls.last()
        assertEquals("bugs/$bugId/complete", complete.path)
        assertEquals(5, complete.body!!.getInt("expectedVersion"))
        assertEquals(attemptId, complete.body.getString("repairAttemptId"))
        assertEquals("workflow:completeBug:bug:$bugId:v5", complete.key)
    }

    @Test fun `already delivered no code attempt is read back without replaying either mutation`() = runBlocking {
        val fixture = Fixture(attemptStatus = "delivered")
        fixture.client.submitFix(bug, "Already delivered", null, null)
        assertEquals(3, fixture.calls.size)
        assertTrue(fixture.calls.all { it.body == null })
    }

    @Test fun `another bug or project in initial response prevents delivery`() = runBlocking {
        for (fixture in listOf(Fixture(initialId = attemptId), Fixture(initialProject = attemptId))) {
            assertEquals("BUG_SCOPE_MISMATCH", runCatching { fixture.client.submitFix(bug, "Note", null, null) }.exceptionOrNull()?.message)
            assertEquals(1, fixture.calls.size)
        }
    }

    @Test fun `another bug or project in fresh ready response cannot be mistaken for success`() = runBlocking {
        for (fixture in listOf(Fixture(freshId = attemptId), Fixture(freshProject = attemptId))) {
            assertEquals("BUG_SCOPE_MISMATCH", runCatching { fixture.client.submitFix(bug, "Note", null, null) }.exceptionOrNull()?.message)
            assertEquals(4, fixture.calls.size)
            assertFalse(fixture.calls.any { it.path.endsWith("/complete") })
        }
    }

    @Test fun `stale bug version prevents delivery`() = runBlocking {
        val fixture = Fixture(initialVersion = 5)
        assertEquals("VERSION_CONFLICT", runCatching { fixture.client.submitFix(bug, "Note", null, null) }.exceptionOrNull()?.message)
        assertEquals(1, fixture.calls.size)
    }

    @Test fun `other fresh states keep server completion guards and propagate conflict`() = runBlocking {
        for (state in listOf("awaiting_build", "closed", "in_progress")) {
            val fixture = Fixture(freshState = state, completeStatus = 409)
            assertEquals("VERSION_CONFLICT", runCatching { fixture.client.submitFix(bug, "Note", "fix/qa", "a".repeat(40)) }.exceptionOrNull()?.message)
            assertEquals("bugs/$bugId/complete", fixture.calls.last().path)
        }
    }
}
