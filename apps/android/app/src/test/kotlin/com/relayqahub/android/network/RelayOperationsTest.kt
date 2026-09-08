package com.relayqahub.android.network

import com.relayqahub.android.NativeProjectBindings
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test

class RelayOperationsTest {
    private val project = "10000000-0000-4000-8000-000000000001"
    private val other = "10000000-0000-4000-8000-000000000002"
    private val outboxId = "20000000-0000-4000-8000-000000000001"
    private val batchId = "a".repeat(64)
    private val updated = "2026-09-09T03:00:00.000Z"

    private fun record(source: RelayRecordSource, state: String = "paused") = RelayRecord(
        if (source == RelayRecordSource.BATCHES) batchId else outboxId,
        project, source, state, "Fixture task", if (source == RelayRecordSource.TASKS) null else 3L,
        updated, "", "{}",
    )

    @Test fun `local batch and outbox reads stay distinct from remote task calls`() {
        assertEquals("production/batches?projectId=$project", RelayOperations.list(project, RelayRecordSource.BATCHES).path)
        assertEquals("production/outbox?projectId=$project", RelayOperations.list(project, RelayRecordSource.OUTBOX).path)
        assertEquals("production/tasks?projectId=$project", RelayOperations.list(project, RelayRecordSource.TASKS).path)
    }

    @Test fun `paused outbox is recognized by projected state and retains original version`() {
        val json = """{"projectId":"$project","items":[{"id":"$outboxId","projectId":"$project","componentVersion":3,"state":"paused","status":"pending","attemptCount":2,"errorCode":"COMPONENT_DISABLED_PAUSED","extraFutureField":true}]}"""
        val item = RelayOperations.records(json, project, RelayRecordSource.OUTBOX).single()
        assertEquals("paused", item.state)
        assertEquals(3L, item.componentVersion)
        assertTrue(item.canResume)
        assertTrue(item.summary.contains("COMPONENT_DISABLED_PAUSED"))
    }

    @Test fun `older local batch remains visible and resumes through its fixed batch id`() {
        val json = """{"projectId":"$project","items":[{"id":"$batchId","projectId":"$project","componentVersion":3,"state":"paused","result":{"kind":"action","items":[]}}]}"""
        val item = RelayOperations.records(json, project, RelayRecordSource.BATCHES).single()
        assertEquals("production/batches/$batchId?projectId=$project", RelayOperations.detail(item).path)
        val resume = RelayOperations.resume(item, true)
        assertEquals(project, resume.projectId)
        assertEquals("production/batches/$batchId/retry", resume.path)
        assertEquals("{}", resume.body)
        assertEquals(3L, item.componentVersion)
    }

    @Test fun `outbox resume sends the existing empty body contract without invented CAS fields`() {
        val command = RelayOperations.resume(record(RelayRecordSource.OUTBOX), true)
        assertEquals("production/outbox/$outboxId/resume", command.path)
        assertEquals("POST", command.method)
        assertEquals("{}", command.body)
    }

    @Test fun `disabled components and completed records cannot enqueue a resume`() {
        for (source in listOf(RelayRecordSource.OUTBOX, RelayRecordSource.BATCHES)) {
            assertEquals("COMPONENT_DISABLED", runCatching { RelayOperations.resume(record(source), false) }.exceptionOrNull()?.message)
            assertFalse(record(source, "completed").canResume)
            assertTrue(runCatching { RelayOperations.resume(record(source, "completed"), true) }.isFailure)
        }
        assertTrue(record(RelayRecordSource.BATCHES, "partial_failure").canResume)
    }

    @Test fun `foreign projects and unproven local versions are rejected before displaying actions`() {
        for (json in listOf(
            """{"projectId":"$other","items":[]}""",
            """{"projectId":"$project","items":[{"id":"$outboxId","projectId":"$other","componentVersion":3}]}""",
            """{"projectId":"$project","items":[{"id":"$outboxId","projectId":"$project"}]}""",
        )) assertTrue(runCatching { RelayOperations.records(json, project, RelayRecordSource.OUTBOX) }.isFailure)
    }

    @Test fun `all ordinary remote actions preserve the exact observed timestamp and require no merge confirmation`() {
        for (action in listOf("continue", "cancel", "retry", "reopen", "finish")) {
            val command = RelayOperations.action(record(RelayRecordSource.TASKS, "running"), action, true, "Human continuation")
            val body = Json.parseToJsonElement(command.body!!).jsonObject
            assertEquals(project, body["projectId"]?.jsonPrimitive?.content)
            val item = body["items"]!!.jsonArray.single().jsonObject
            assertEquals(updated, item["expectedUpdatedAt"]?.jsonPrimitive?.content)
            assertEquals(action, item["action"]?.jsonPrimitive?.content)
            assertEquals(false, item["confirmMerge"]?.jsonPrimitive?.boolean)
            if (action == "continue") assertEquals("Human continuation", item["message"]?.jsonPrimitive?.content)
        }
    }

    @Test fun `merge requires explicit confirmation and uses the freshly read task identity`() {
        val json = """{"task":{"id":"$outboxId","title":"Current task","updatedAt":"$updated","status":"ready"}}"""
        val current = RelayOperations.taskDetail(json, project, outboxId)
        assertNull(current.componentVersion)
        assertEquals("MERGE_CONFIRMATION_REQUIRED", runCatching { RelayOperations.action(current, "merge", true) }.exceptionOrNull()?.message)
        val command = RelayOperations.action(current, "merge", true, confirmMerge = true)
        val item = Json.parseToJsonElement(command.body!!).jsonObject["items"]!!.jsonArray.single().jsonObject
        assertTrue(item["confirmMerge"]!!.jsonPrimitive.boolean)
        assertEquals(updated, item["expectedUpdatedAt"]!!.jsonPrimitive.content)
        assertEquals(outboxId, item["taskId"]!!.jsonPrimitive.content)
        assertTrue(runCatching { RelayOperations.taskDetail(json, project, other) }.isFailure)
    }

    @Test fun `missing remote timestamp and unsafe record ids cannot produce a mutation`() {
        assertTrue(runCatching { RelayOperations.action(record(RelayRecordSource.TASKS).copy(updatedAt = null), "finish", true) }.isFailure)
        assertTrue(runCatching { RelayOperations.detail(record(RelayRecordSource.BATCHES).copy(id = "../other")) }.isFailure)
        assertTrue(runCatching { RelayOperations.action(record(RelayRecordSource.TASKS), "continue", true) }.isFailure)
    }

    @Test fun `native transport keeps fixed project bearer and exact resume body without external requests`() = runBlocking {
        val token = "fixture-${UUID.randomUUID()}"
        NativeProjectBindings.register(token, project)
        var calls = 0
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            calls++
            val request = chain.request()
            assertEquals("Bearer $token", request.header("Authorization"))
            assertEquals(project, request.header("x-qa-project-id"))
            assertEquals("/api/v1/production/outbox/$outboxId/resume", request.url.encodedPath)
            assertEquals("{}", Buffer().also { request.body!!.writeTo(it) }.readUtf8())
            throw IOException("intercepted before any network access")
        }.build()
        val client = ProjectOperationsClient("https://fixture.invalid/api/v1/", http)
        assertTrue(runCatching { client.relay(RelayOperations.resume(record(RelayRecordSource.OUTBOX), true), token) }.exceptionOrNull() is IOException)
        assertEquals(1, calls)
        assertEquals("TOKEN_PROJECT_MISMATCH", runCatching {
            client.relay(RelayOperations.list(other, RelayRecordSource.BATCHES), token)
        }.exceptionOrNull()?.message)
        assertEquals(1, calls)
    }
}
