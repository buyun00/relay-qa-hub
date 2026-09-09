package com.relayqahub.android.network

import com.relayqahub.android.NativeProjectBindings
import java.util.UUID
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONArray
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
                    "bugs/$bugId/workflow" -> workflowPage(
                        JSONArray().put(
                            frozenAttempt(
                                attemptId,
                                attemptStatus,
                                2,
                                "Fixture attempt",
                            ),
                        ),
                    )
                        .toString()
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
        assertEquals(
            listOf(
                "bugs/$bugId",
                "bugs/$bugId/human-workflow",
                "bugs/$bugId/workflow",
                "repair-attempts/$attemptId/deliver",
                "bugs/$bugId",
            ),
            fixture.calls.map { it.path },
        )
        assertEquals("no_code", fixture.calls[3].body!!.getString("deliveryKind"))
        assertEquals("Resolved without code", fixture.calls[3].body!!.getString("noCodeReason"))
        assertEquals(2, fixture.calls[3].body!!.getInt("expectedVersion"))
    }

    @Test fun `code delivery still completes with freshly read version and original attempt`() = runBlocking {
        val fixture = Fixture(freshState = "awaiting_build")
        fixture.client.submitFix(bug, "Actual code delivered", "fix/qa", "a".repeat(40))
        assertEquals("code", fixture.calls[3].body!!.getString("deliveryKind"))
        val complete = fixture.calls.last()
        assertEquals("bugs/$bugId/complete", complete.path)
        assertEquals(5, complete.body!!.getInt("expectedVersion"))
        assertEquals(attemptId, complete.body.getString("repairAttemptId"))
        assertEquals("workflow:completeBug:bug:$bugId:v5", complete.key)
    }

    @Test fun `already delivered no code attempt is read back without replaying either mutation`() = runBlocking {
        val fixture = Fixture(attemptStatus = "delivered")
        fixture.client.submitFix(bug, "Already delivered", null, null)
        assertEquals(4, fixture.calls.size)
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
            assertEquals(5, fixture.calls.size)
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

    @Test fun `comments load more than one hundred items through the same scoped cursor`() = runBlocking {
        val cursor = "comment page/+"
        var page = 0
        val client = historyClient { request ->
            assertEquals("projects/$project/bugs/$bugId/comments", request.historyPath())
            when (page++) {
                0 -> {
                    assertNull(request.url.queryParameter("cursor"))
                    HistoryFixture(
                        body = historyPage(
                            items = historyItems("comment", 0 until 100),
                            nextCursor = cursor,
                        ),
                    )
                }
                1 -> {
                    assertEquals(cursor, request.url.queryParameter("cursor"))
                    assertTrue(
                        request.url.encodedQuery.orEmpty()
                            .contains("cursor=comment%20page%2F%2B"),
                    )
                    HistoryFixture(
                        body = historyPage(items = historyItems("comment", 100 until 151)),
                    )
                }
                else -> error("Unexpected comments request ${request.url}")
            }
        }

        val result = client.comments(bugId)

        assertEquals(2, page)
        assertEquals(project, result.getString("projectId"))
        assertEquals(bugId, result.getString("bugId"))
        assertEquals(73L, result.getLong("snapshotSequence"))
        assertEquals(151, result.getJSONArray("items").length())
        assertEquals("comment-150", result.getJSONArray("items").getJSONObject(150).getString("id"))
        assertTrue(result.isNull("nextCursor"))
    }

    @Test fun `events load more than one hundred items and preserve the frozen project snapshot`() = runBlocking {
        var page = 0
        val client = historyClient { request ->
            assertEquals("bugs/$bugId/events", request.historyPath())
            when (page++) {
                0 -> HistoryFixture(
                    body = historyPage(
                        items = historyItems("event", 0 until 100),
                        nextCursor = "event-next",
                    ),
                )
                1 -> {
                    assertEquals("event-next", request.url.queryParameter("cursor"))
                    HistoryFixture(body = historyPage(items = historyItems("event", 100 until 125)))
                }
                else -> error("Unexpected events request ${request.url}")
            }
        }

        val result = client.events(bugId)

        assertEquals(2, page)
        assertEquals(project, result.getString("projectId"))
        assertEquals(73L, result.getLong("snapshotSequence"))
        assertEquals(125, result.getJSONArray("items").length())
        assertEquals("event-124", result.getJSONArray("items").getJSONObject(124).getString("id"))
        assertTrue(result.isNull("nextCursor"))
    }

    @Test fun `history rejects a repeated cursor before returning partial comments`() = runBlocking {
        var page = 0
        val client = historyClient {
            page++
            HistoryFixture(
                body = historyPage(
                    items = historyItems("comment", (page - 1) until page),
                    nextCursor = "same",
                ),
            )
        }
        var result: JSONObject? = null

        val failure = runCatching { result = client.comments(bugId) }.exceptionOrNull()

        assertNull(result)
        assertEquals("COMMENT_CURSOR_REPEATED", failure?.message)
        assertEquals(2, page)
    }

    @Test fun `history refuses a changed project or snapshot on a later page`() = runBlocking {
        val cases = listOf(
            historyPage(responseProjectId = attemptId) to "HISTORY_SCOPE_MISMATCH",
            historyPage(snapshotSequence = 74L) to "EVENT_SNAPSHOT_CHANGED",
        )
        cases.forEach { (secondPage, expected) ->
            var page = 0
            val client = historyClient {
                if (page++ == 0) {
                    HistoryFixture(body = historyPage(nextCursor = "next"))
                } else {
                    HistoryFixture(body = secondPage)
                }
            }

            assertEquals(expected, runCatching { client.events(bugId) }.exceptionOrNull()?.message)
            assertEquals(2, page)
        }
    }

    @Test fun `a later history page failure exposes no partial result`() = runBlocking {
        var page = 0
        val client = historyClient {
            if (page++ == 0) {
                HistoryFixture(
                    body = historyPage(
                        items = historyItems("event", 0 until 100),
                        nextCursor = "next",
                    ),
                )
            } else {
                HistoryFixture(code = 503, body = JSONObject().put("code", "PAGE_FAILED"))
            }
        }
        var result: JSONObject? = null

        val failure = runCatching { result = client.events(bugId) }.exceptionOrNull()

        assertNull(result)
        assertEquals("PAGE_FAILED", failure?.message)
        assertEquals(2, page)
    }

    @Test fun `history stops after the bounded maximum number of pages`() = runBlocking {
        var page = 0
        val client = historyClient {
            page++
            HistoryFixture(
                body = historyPage(
                    items = historyItems("event", (page - 1) until page),
                    nextCursor = "cursor-$page",
                ),
            )
        }

        val failure = runCatching { client.events(bugId) }.exceptionOrNull()

        assertEquals("EVENT_PAGE_LIMIT_EXCEEDED", failure?.message)
        assertEquals(100, page)
    }

    @Test fun `workflow paginates with an encoded cursor and keeps the newest external attempt`() = runBlocking {
        val successorId = "30000000-0000-4000-8000-000000000002"
        val cursor = "next page/+"
        var workflowPage = 0
        val client = workflowClient { request ->
            when (request.url.encodedPath.removePrefix("/api/v1/")) {
                "bugs/$bugId/human-workflow" -> JSONObject()
                    .put("bugId", bugId)
                    .put("repairAttempt", frozenAttempt(attemptId, "superseded", 3, "Old"))
                "bugs/$bugId/workflow" -> {
                    workflowPage++
                    if (workflowPage == 1) {
                        assertNull(request.url.queryParameter("cursor"))
                        workflowPage(
                            JSONArray().put(
                                frozenAttempt(attemptId, "superseded", 3, "Old"),
                            ),
                            nextCursor = cursor,
                            snapshotSequence = 91L,
                        )
                    } else {
                        assertEquals(cursor, request.url.queryParameter("cursor"))
                        assertTrue(request.url.encodedQuery.orEmpty().contains("cursor=next%20page%2F%2B"))
                        workflowPage(
                            JSONArray().put(
                                frozenAttempt(
                                    successorId, "planned", 1, "External", sequence = 2,
                                    mode = "external", parentAttemptId = attemptId,
                                ),
                            ),
                            snapshotSequence = 91L,
                        )
                    }
                }
                else -> error("Unexpected request ${request.url}")
            }
        }

        val workflow = client.workflow(bugId)

        assertEquals(2, workflowPage)
        assertEquals(successorId, workflow.getJSONObject("repairAttempt").getString("id"))
        assertEquals("external", workflow.getJSONObject("repairAttempt").getString("mode"))
    }

    @Test fun `workflow aggregates every frozen collection across the bounded snapshot`() = runBlocking {
        val secondAttemptId = "30000000-0000-4000-8000-000000000002"
        val firstBuildId = "50000000-0000-4000-8000-000000000001"
        var page = 0
        val client = workflowClient { request ->
            when (request.url.encodedPath.removePrefix("/api/v1/")) {
                "bugs/$bugId/human-workflow" -> JSONObject().put("bugId", bugId)
                    .put("repairAttempt", JSONObject.NULL)
                "bugs/$bugId/workflow" -> if (page++ == 0) {
                    workflowPage(
                        attempts = JSONArray().put(frozenAttempt(attemptId, "delivered", 2, "First")),
                        occurrences = JSONArray().put(frozenOccurrence("60000000-0000-4000-8000-000000000001")),
                        verifications = JSONArray().put(
                            frozenVerification(
                                "70000000-0000-4000-8000-000000000001",
                                "40000000-0000-4000-8000-000000000001",
                                "passed",
                                2,
                                firstBuildId,
                            ),
                        ),
                        builds = JSONArray().put(frozenBuild(firstBuildId)),
                        relayReceipts = JSONArray().put(
                            frozenRelayReceipt(
                                "80000000-0000-4000-8000-000000000001",
                                attemptId,
                                firstBuildId,
                            ),
                        ),
                        nextCursor = "next",
                        snapshotSequence = 91L,
                    )
                } else {
                    workflowPage(
                        attempts = JSONArray().put(
                            frozenAttempt(secondAttemptId, "planned", 1, "Second", sequence = 2),
                        ),
                        occurrences = JSONArray().put(frozenOccurrence("60000000-0000-4000-8000-000000000002")),
                        verifications = JSONArray().put(
                            frozenVerification(
                                "70000000-0000-4000-8000-000000000002",
                                "40000000-0000-4000-8000-000000000001",
                                "requested",
                                1,
                                buildId = null,
                                repairAttemptId = secondAttemptId,
                            ),
                        ),
                        relayReceipts = JSONArray().put(
                            frozenRelayReceipt(
                                "80000000-0000-4000-8000-000000000002",
                                secondAttemptId,
                                buildId = null,
                            ),
                        ),
                        snapshotSequence = 91L,
                    )
                }
                else -> error("Unexpected request ${request.url}")
            }
        }

        val workflow = client.workflow(bugId)

        assertEquals(2, page)
        assertEquals(2, workflow.getJSONArray("occurrences").length())
        assertEquals(2, workflow.getJSONArray("repairAttempts").length())
        assertEquals(2, workflow.getJSONArray("verifications").length())
        assertEquals(1, workflow.getJSONArray("builds").length())
        assertEquals(2, workflow.getJSONArray("relayReceipts").length())
        assertFalse(workflow.getBoolean("truncated"))
        assertTrue(workflow.isNull("nextCursor"))
        assertEquals(secondAttemptId, workflow.getJSONObject("repairAttempt").getString("id"))
    }

    @Test fun `workflow rejects non frozen roots duplicate collection identities and foreign builds`() = runBlocking {
        val malformed = listOf(
            workflowPage().put("extra", true) to "INVALID_WORKFLOW_RESPONSE",
            workflowPage(
                occurrences = JSONArray()
                    .put(frozenOccurrence("60000000-0000-4000-8000-000000000001"))
                    .put(frozenOccurrence("60000000-0000-4000-8000-000000000001")),
            ) to "WORKFLOW_OCCURRENCE_REPEATED",
            workflowPage(
                builds = JSONArray().put(
                    frozenBuild("50000000-0000-4000-8000-000000000001").put(
                        "projectId",
                        "10000000-0000-4000-8000-000000000099",
                    ),
                ),
            ) to "BUILD_SCOPE_MISMATCH",
        )
        malformed.forEach { (page, expected) ->
            val client = workflowClient { request ->
                when (request.url.encodedPath.removePrefix("/api/v1/")) {
                    "bugs/$bugId/human-workflow" -> JSONObject().put("bugId", bugId)
                        .put("repairAttempt", JSONObject.NULL)
                    "bugs/$bugId/workflow" -> page
                    else -> error("Unexpected request ${request.url}")
                }
            }
            assertEquals(expected, runCatching { client.workflow(bugId) }.exceptionOrNull()?.message)
        }
    }

    @Test fun `workflow rejects missing non-string and repeated cursors`() = runBlocking {
        val badPages = listOf<(Int) -> JSONObject>(
            { workflowPage().apply { remove("nextCursor") } },
            { workflowPage(nextCursor = 7) },
            { workflowPage(nextCursor = "same") },
        )
        badPages.forEachIndexed { caseIndex, pageFactory ->
            var page = 0
            val client = workflowClient { request ->
                when (request.url.encodedPath.removePrefix("/api/v1/")) {
                    "bugs/$bugId/human-workflow" -> JSONObject().put("bugId", bugId)
                        .put("repairAttempt", JSONObject.NULL)
                    "bugs/$bugId/workflow" -> pageFactory(page++)
                    else -> error("Unexpected request ${request.url}")
                }
            }
            val failure = runCatching { client.workflow(bugId) }.exceptionOrNull()
            assertEquals("cursor case $caseIndex", "INVALID_WORKFLOW_CURSOR", failure?.message)
            assertEquals("cursor case $caseIndex", if (caseIndex == 2) 2 else 1, page)
        }
    }

    @Test fun `workflow rejects malformed snapshot metadata and cursor truncation conflicts`() = runBlocking {
        val cases = listOf(
            workflowPage().apply { remove("snapshotSequence") } to "INVALID_WORKFLOW_SNAPSHOT",
            workflowPage(snapshotSequence = "7") to "INVALID_WORKFLOW_SNAPSHOT",
            workflowPage(bugVersion = "4") to "INVALID_WORKFLOW_BUG_VERSION",
            workflowPage(truncated = "false") to "INVALID_WORKFLOW_TRUNCATION",
            workflowPage(nextCursor = "next", truncated = false) to "INVALID_WORKFLOW_TRUNCATION",
            workflowPage(truncated = true) to "INVALID_WORKFLOW_TRUNCATION",
        )
        cases.forEachIndexed { index, (badPage, code) ->
            val client = workflowClient { request ->
                when (request.url.encodedPath.removePrefix("/api/v1/")) {
                    "bugs/$bugId/human-workflow" -> JSONObject().put("bugId", bugId)
                        .put("repairAttempt", JSONObject.NULL)
                    "bugs/$bugId/workflow" -> badPage
                    else -> error("Unexpected request ${request.url}")
                }
            }

            assertEquals(
                "metadata case $index",
                code,
                runCatching { client.workflow(bugId) }.exceptionOrNull()?.message,
            )
        }
    }

    @Test fun `workflow refuses to merge pages from another snapshot or bug version`() = runBlocking {
        val conflicts = listOf(
            (92L to 4) to "WORKFLOW_SNAPSHOT_CHANGED",
            (91L to 5) to "WORKFLOW_BUG_VERSION_CHANGED",
        )
        conflicts.forEach { (metadata, expectedCode) ->
            var pageNumber = 0
            val client = workflowClient { request ->
                when (request.url.encodedPath.removePrefix("/api/v1/")) {
                    "bugs/$bugId/human-workflow" -> JSONObject().put("bugId", bugId)
                        .put("repairAttempt", JSONObject.NULL)
                    "bugs/$bugId/workflow" -> if (pageNumber++ == 0) {
                        workflowPage(
                            JSONArray().put(frozenAttempt(attemptId, "superseded", 2, "First")),
                            nextCursor = "next",
                            snapshotSequence = 91L,
                            bugVersion = 4,
                        )
                    } else {
                        workflowPage(
                            JSONArray().put(
                                frozenAttempt(
                                    "30000000-0000-4000-8000-000000000002",
                                    "planned",
                                    1,
                                    "Second",
                                    sequence = 2,
                                ),
                            ),
                            snapshotSequence = metadata.first,
                            bugVersion = metadata.second,
                        )
                    }
                    else -> error("Unexpected request ${request.url}")
                }
            }

            assertEquals(
                expectedCode,
                runCatching { client.workflow(bugId) }.exceptionOrNull()?.message,
            )
            assertEquals(2, pageNumber)
        }
    }

    @Test fun `workflow rejects two attempt identities with the same server sequence`() = runBlocking {
        val otherAttemptId = "30000000-0000-4000-8000-000000000002"
        val client = workflowClient { request ->
            when (request.url.encodedPath.removePrefix("/api/v1/")) {
                "bugs/$bugId/human-workflow" -> JSONObject().put("bugId", bugId)
                    .put("repairAttempt", JSONObject.NULL)
                "bugs/$bugId/workflow" -> workflowPage(
                    JSONArray()
                        .put(frozenAttempt(attemptId, "superseded", 2, "First"))
                        .put(frozenAttempt(otherAttemptId, "planned", 1, "Second")),
                )
                else -> error("Unexpected request ${request.url}")
            }
        }

        assertEquals(
            "WORKFLOW_ATTEMPT_SEQUENCE_CONFLICT",
            runCatching { client.workflow(bugId) }.exceptionOrNull()?.message,
        )
    }

    @Test fun `workflow rejects shortened server UUIDs`() = runBlocking {
        val client = workflowClient { request ->
            when (request.url.encodedPath.removePrefix("/api/v1/")) {
                "bugs/$bugId/human-workflow" -> JSONObject().put("bugId", bugId)
                    .put("repairAttempt", JSONObject.NULL)
                "bugs/$bugId/workflow" -> workflowPage(
                    JSONArray().put(frozenAttempt("1-1-1-1-1", "planned", 1, "Invalid")),
                )
                else -> error("Unexpected request ${request.url}")
            }
        }

        assertEquals(
            "id must be a UUID",
            runCatching { client.workflow(bugId) }.exceptionOrNull()?.message,
        )
    }

    @Test fun `verification creation is refused while the bug is awaiting a build`() = runBlocking {
        val actorId = "70000000-0000-4000-8000-000000000001"
        val client = workflowClient { request ->
            when (request.url.encodedPath.removePrefix("/api/v1/")) {
                "bugs/$bugId/human-workflow" -> JSONObject().put("bugId", bugId)
                    .put("repairAttempt", JSONObject.NULL).put("verification", JSONObject.NULL)
                "bugs/$bugId/workflow" -> workflowPage()
                else -> error("Creation must stop before ${request.url}")
            }
        }
        val awaitingBuild = bug.copy(
            state = "awaiting_build",
            verificationOwnerId = actorId,
            verifierAssignmentProof = assignmentProof(actorId),
        )

        assertEquals(
            "VERIFICATION_NOT_READY",
            runCatching {
                client.ensureVerificationInProgress(
                    awaitingBuild,
                    actorId,
                    "Run acceptance",
                    activeProjectMemberIds = setOf(actorId),
                )
            }.exceptionOrNull()?.message,
        )
    }

    @Test fun `existing verification is refused for an actor other than its canonical verifier`() = runBlocking {
        val actorId = "70000000-0000-4000-8000-000000000001"
        val verifierId = "70000000-0000-4000-8000-000000000002"
        val verificationId = "60000000-0000-4000-8000-000000000001"
        val client = workflowClient { request ->
            when (request.url.encodedPath.removePrefix("/api/v1/")) {
                "bugs/$bugId/human-workflow" -> JSONObject().put("bugId", bugId)
                    .put("repairAttempt", frozenAttempt(attemptId, "delivered", 3, "Done"))
                    .put("verification", JSONObject()
                        .put("id", verificationId).put("bugId", bugId)
                        .put("repairAttemptId", attemptId).put("buildId", JSONObject.NULL)
                        .put("status", "requested").put("verifierId", verifierId)
                        .put("criteriaSnapshot", "Run acceptance")
                        .put("resultSummary", JSONObject.NULL).put("version", 1))
                "bugs/$bugId/workflow" -> workflowPage(
                    JSONArray().put(
                        frozenAttempt(attemptId, "delivered", 3, "Done"),
                    ),
                )
                else -> error("Wrong actor must stop before ${request.url}")
            }
        }
        val ready = bug.copy(
            state = "ready_for_verification",
            verificationOwnerId = actorId,
            verifierAssignmentProof = assignmentProof(actorId),
        )

        assertEquals(
            "VERIFICATION_ASSIGNEE_REQUIRED",
            runCatching {
                client.ensureVerificationInProgress(
                    ready,
                    actorId,
                    "Run acceptance",
                    activeProjectMemberIds = setOf(actorId),
                )
            }.exceptionOrNull()?.message,
        )
    }

    @Test fun `verification is refused when the actor is no longer an active project member`() = runBlocking {
        val actorId = "70000000-0000-4000-8000-000000000001"
        val client = workflowClient { request -> error("Revoked actor must stop before ${request.url}") }
        val ready = bug.copy(
            state = "ready_for_verification",
            verificationOwnerId = actorId,
            verifierAssignmentProof = assignmentProof(actorId),
        )

        assertEquals(
            "PROJECT_MEMBERSHIP_REQUIRED",
            runCatching {
                client.ensureVerificationInProgress(
                    ready,
                    actorId,
                    "Run acceptance",
                    activeProjectMemberIds = emptySet(),
                )
            }.exceptionOrNull()?.message,
        )
    }

    @Test fun `terminal workflow cannot create a pending result from a stale ready bug`() = runBlocking {
        val actorId = "70000000-0000-4000-8000-000000000001"
        val verificationId = "60000000-0000-4000-8000-000000000001"
        val paths = mutableListOf<String>()
        val client = workflowClient { request ->
            val path = request.url.encodedPath.removePrefix("/api/v1/")
            paths += path
            when (path) {
                "bugs/$bugId/human-workflow" -> JSONObject().put("bugId", bugId)
                    .put("repairAttempt", frozenAttempt(attemptId, "delivered", 3, "Done"))
                    .put(
                        "verification",
                        frozenVerification(verificationId, actorId, "passed", version = 3),
                    )
                "bugs/$bugId/workflow" -> workflowPage(
                    JSONArray().put(frozenAttempt(attemptId, "delivered", 3, "Done")),
                )
                else -> error("Terminal workflow must stop before ${request.url}")
            }
        }
        val staleReady = bug.copy(
            state = "ready_for_verification",
            verificationOwnerId = actorId,
            verifierAssignmentProof = assignmentProof(actorId),
        )

        assertEquals(
            "VERIFICATION_ALREADY_TERMINAL",
            runCatching {
                client.ensureVerificationInProgress(
                    staleReady,
                    actorId,
                    "Run acceptance",
                    activeProjectMemberIds = setOf(actorId),
                )
            }.exceptionOrNull()?.message,
        )
        assertEquals(listOf("bugs/$bugId/human-workflow", "bugs/$bugId/workflow"), paths)
    }

    @Test fun `ready workflow creation assigns the acting member while preserving responsibility ownership`() = runBlocking {
        val actorId = "70000000-0000-4000-8000-000000000001"
        val verifierAliasId = "70000000-0000-4000-8000-000000000002"
        val verificationId = "60000000-0000-4000-8000-000000000001"
        val buildId = "b0000000-0000-4000-8000-000000000001"
        val requirementId = "c0000000-0000-4000-8000-000000000001"
        val commitSha = "a".repeat(40)
        var createBody: JSONObject? = null
        val client = workflowClient { request ->
            val path = request.url.encodedPath.removePrefix("/api/v1/")
            when (path) {
                "bugs/$bugId/human-workflow" -> JSONObject().put("bugId", bugId)
                    .put(
                        "repairAttempt",
                        frozenAttempt(
                            attemptId,
                            "delivered",
                            3,
                            "Done",
                            commitSha = commitSha,
                        ),
                    )
                    .put("verification", JSONObject.NULL)
                    .put(
                        "buildRequirement",
                        JSONObject().put("id", requirementId).put("repairAttemptId", attemptId)
                            .put("deliveredCommitSha", commitSha).put("linkedBuildId", buildId)
                            .put("version", 2),
                    )
                    .put(
                        "build",
                        JSONObject().put("id", buildId).put("projectId", project)
                            .put("status", "ready").put("sourceCommitSha", commitSha),
                    )
                "bugs/$bugId/workflow" -> workflowPage(
                    JSONArray().put(
                        frozenAttempt(
                            attemptId,
                            "delivered",
                            3,
                            "Done",
                            commitSha = commitSha,
                        ),
                    ),
                )
                "bugs/$bugId" -> JSONObject().put("id", bugId).put("projectId", project)
                    .put("version", 4).put("state", "ready_for_verification")
                "bugs/$bugId/verifications" -> {
                    createBody = request.jsonBody()
                    frozenVerification(
                        verificationId,
                        actorId,
                        "requested",
                        version = 1,
                        buildId = buildId,
                    )
                }
                "verifications/$verificationId/start" -> frozenVerification(
                    verificationId,
                    actorId,
                    "in_progress",
                    version = 2,
                    buildId = buildId,
                )
                else -> error("Unexpected request ${request.url}")
            }
        }
        val ready = bug.copy(
            state = "ready_for_verification",
            verificationOwnerId = verifierAliasId,
            verifierAssignmentProof = assignmentProof(actorId),
        )

        val verification = client.ensureVerificationInProgress(
            ready,
            actorId,
            "Run acceptance",
            activeProjectMemberIds = setOf(actorId),
        )

        assertEquals(VerificationStatus.IN_PROGRESS, verification.status)
        assertEquals(buildId, verification.buildId)
        assertEquals(buildId, checkNotNull(createBody).getString("buildId"))
        assertEquals(attemptId, checkNotNull(createBody).getString("repairAttemptId"))
        assertEquals(actorId, checkNotNull(createBody).getString("verifierId"))
    }

    @Test fun `restart accepts canonical verification readback for a proven historical assignee`() = runBlocking {
        val actorId = "70000000-0000-4000-8000-000000000001"
        val verifierAliasId = "70000000-0000-4000-8000-000000000002"
        val verificationId = "60000000-0000-4000-8000-000000000001"
        val client = workflowClient { request ->
            when (request.url.encodedPath.removePrefix("/api/v1/")) {
                "bugs/$bugId/human-workflow" -> JSONObject()
                    .put("bugId", bugId)
                    .put("repairAttempt", frozenAttempt(attemptId, "delivered", 3, "Done"))
                    .put(
                        "verification",
                        frozenVerification(verificationId, verifierAliasId, "requested", version = 1),
                    )
                "bugs/$bugId/workflow" -> workflowPage(
                    JSONArray().put(frozenAttempt(attemptId, "delivered", 3, "Done")),
                )
                "verifications/$verificationId" -> frozenVerification(
                    verificationId,
                    actorId,
                    "requested",
                    version = 1,
                )
                "verifications/$verificationId/start" -> frozenVerification(
                    verificationId,
                    actorId,
                    "in_progress",
                    version = 2,
                )
                else -> error("Unexpected request ${request.url}")
            }
        }
        val ready = bug.copy(
            state = "ready_for_verification",
            verificationOwnerId = verifierAliasId,
            verifierAssignmentProof = assignmentProof(actorId),
        )

        val verification = client.ensureVerificationInProgress(
            ready,
            actorId,
            "Resume persisted acceptance",
            preferredVerificationId = verificationId,
            activeProjectMemberIds = setOf(actorId),
        )

        assertEquals(actorId, verification.verifierId)
        assertEquals(VerificationStatus.IN_PROGRESS, verification.status)
    }

    @Test fun `fail terminal uses exact observed version canonical key and vendor body`() = runBlocking {
        val token = "terminal-${UUID.randomUUID()}"
        NativeProjectBindings.register(token, project)
        val reason = "本轮环境损坏，退回待处理"
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            assertEquals("repair-attempts/$attemptId/fail", request.url.encodedPath.removePrefix("/api/v1/"))
            assertEquals(QaHubApiContract.JSON_ACCEPT, request.header("Accept"))
            assertEquals(QaHubApiContract.VERSIONED_JSON, request.vendorMediaType())
            assertEquals("workflow:failRepairAttempt:attempt:$attemptId:v3", request.header("Idempotency-Key"))
            val body = request.jsonBody()
            assertEquals(setOf("expectedVersion", "reason"), body.keys().asSequence().toSet())
            assertEquals(3, body.getInt("expectedVersion"))
            assertEquals(reason, body.getString("reason"))
            fixtureResponse(request, frozenAttempt(
                id = attemptId,
                status = "failed",
                version = 4,
                summary = reason,
            ).toString())
        }.build()
        val client = BugLifecycleClient(ProjectOperationsClient("https://fixture.invalid/api/v1/", http), project, token)

        val result = client.failRepairAttempt(attemptId, 3, reason)

        assertEquals(RepairAttemptStatus.FAILED, result.status)
        assertEquals(4, result.version)
        assertEquals(reason, result.summary)
    }

    @Test fun `vendor supersede sends explicit successor and verifies both typed attempts`() = runBlocking {
        val token = "supersede-${UUID.randomUUID()}"
        val successorId = "30000000-0000-4000-8000-000000000002"
        val assigneeId = "40000000-0000-4000-8000-000000000001"
        val eventId = "50000000-0000-4000-8000-000000000001"
        val reason = "改由外部同事接手"
        val summary = "在真机上复现并提交修复说明"
        NativeProjectBindings.register(token, project)
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            assertEquals("repair-attempts/$attemptId/supersede", request.url.encodedPath.removePrefix("/api/v1/"))
            assertEquals(QaHubApiContract.VERSIONED_JSON, request.vendorMediaType())
            assertEquals("workflow:supersedeRepairAttempt:attempt:$attemptId:v3", request.header("Idempotency-Key"))
            val body = request.jsonBody()
            assertEquals(setOf("expectedVersion", "reason", "successor"), body.keys().asSequence().toSet())
            val successor = body.getJSONObject("successor")
            assertEquals(setOf("id", "mode", "assigneeId", "summary"), successor.keys().asSequence().toSet())
            assertEquals(successorId, successor.getString("id"))
            assertEquals("external", successor.getString("mode"))
            assertEquals(assigneeId, successor.getString("assigneeId"))
            assertEquals(summary, successor.getString("summary"))
            fixtureResponse(request, JSONObject()
                .put("supersededAttempt", frozenAttempt(attemptId, "superseded", 4, reason))
                .put("successorAttempt", frozenAttempt(
                    successorId, "planned", 1, summary, sequence = 2, mode = "external",
                    assigneeId = assigneeId, parentAttemptId = attemptId,
                ))
                .put("bug", terminalBug("in_progress", 8))
                .put("eventId", eventId)
                .put("replayed", false)
                .toString())
        }.build()
        val client = BugLifecycleClient(ProjectOperationsClient("https://fixture.invalid/api/v1/", http), project, token)

        val receipt = client.supersedeRepairAttempt(SupersedeRepairAttemptCommand(
            attemptId, 3, reason, successorId, RepairMode.EXTERNAL, assigneeId, summary,
        ))

        assertEquals(RepairAttemptStatus.SUPERSEDED, receipt.supersededAttempt.status)
        assertEquals(RepairAttemptStatus.PLANNED, receipt.successorAttempt.status)
        assertEquals(RepairMode.EXTERNAL, receipt.successorAttempt.mode)
        assertEquals(attemptId, receipt.successorAttempt.parentAttemptId)
        assertFalse(receipt.replayed)
    }

    @Test fun `passed failed and blocked results preserve one submission and evidence on retry`() {
        val verificationId = "60000000-0000-4000-8000-000000000001"
        val verifierId = "70000000-0000-4000-8000-000000000001"
        val attachmentIds = listOf(
            "80000000-0000-4000-8000-000000000001",
            "80000000-0000-4000-8000-000000000002",
        )
        val captureBundleId = "90000000-0000-4000-8000-000000000001"
        val eventId = "a0000000-0000-4000-8000-000000000001"
        VerificationOutcome.entries.forEach { outcome ->
            val token = "verification-${outcome.wireName}-${UUID.randomUUID()}"
            val clientSubmissionId = UUID.randomUUID().toString()
            val summary = "${outcome.wireName} result"
            val bodies = mutableListOf<String>()
            NativeProjectBindings.register(token, project)
            val http = OkHttpClient.Builder().addInterceptor { chain ->
                val request = chain.request()
                assertEquals("verifications/$verificationId/result", request.url.encodedPath.removePrefix("/api/v1/"))
                assertEquals(QaHubApiContract.VERSIONED_JSON, request.vendorMediaType())
                assertEquals("workflow:recordVerificationResult:verification:$verificationId:v2", request.header("Idempotency-Key"))
                val body = request.jsonBody()
                bodies += body.toString()
                assertEquals(clientSubmissionId, body.getString("clientSubmissionId"))
                assertEquals(outcome.wireName, body.getString("status"))
                assertEquals(attachmentIds, body.getJSONArray("attachmentIds").let { array ->
                    (0 until array.length()).map(array::getString)
                })
                assertEquals(captureBundleId, body.getString("captureBundleId"))
                assertEquals(outcome == VerificationOutcome.FAILED, body.has("failureReason"))
                assertEquals(outcome == VerificationOutcome.BLOCKED, body.has("blockedReason"))
                fixtureResponse(request, JSONObject()
                    .put("clientSubmissionId", clientSubmissionId)
                    .put("qaItem", JSONObject().put("type", "bug").put("id", bugId).put("key", "QA-1"))
                    .put("verification", JSONObject()
                        .put("id", verificationId).put("bugId", bugId)
                        .put("repairAttemptId", attemptId).put("buildId", JSONObject.NULL)
                        .put("status", outcome.wireName).put("verifierId", verifierId)
                        .put("criteriaSnapshot", "Run acceptance").put("resultSummary", summary)
                        .put("version", 3))
                    .put(
                        "repairAttempt",
                        frozenAttempt(
                            attemptId,
                            if (outcome == VerificationOutcome.FAILED) "verification_failed" else "delivered",
                            5,
                            "Delivered",
                        ),
                    )
                    .put(
                        "bug",
                        terminalBug(
                            when (outcome) {
                                VerificationOutcome.PASSED -> "closed"
                                VerificationOutcome.FAILED -> "ready"
                                VerificationOutcome.BLOCKED -> "ready_for_verification"
                            },
                            9,
                        ),
                    )
                    .put("attachmentIds", org.json.JSONArray(attachmentIds))
                    .put("captureBundleId", captureBundleId)
                    .put("eventId", eventId)
                    .put("replayed", bodies.size > 1)
                    .toString())
            }.build()
            val client = BugLifecycleClient(ProjectOperationsClient("https://fixture.invalid/api/v1/", http), project, token)
            val command = VerificationResultCommand(
                bugId = bugId,
                verificationId = verificationId,
                expectedVersion = 2,
                outcome = outcome,
                resultSummary = summary,
                clientSubmissionId = clientSubmissionId,
                attachmentIds = attachmentIds,
                captureBundleId = captureBundleId,
                failureReason = summary.takeIf { outcome == VerificationOutcome.FAILED },
                blockedReason = summary.takeIf { outcome == VerificationOutcome.BLOCKED },
            )

            val receipts = listOf(runBlocking { client.recordVerificationResult(command) },
                runBlocking { client.recordVerificationResult(command) })

            assertEquals(bodies[0], bodies[1])
            assertEquals(listOf(false, true), receipts.map { it.replayed })
            assertTrue(receipts.all { it.clientSubmissionId == clientSubmissionId })
            assertTrue(receipts.all { it.attachmentIds == attachmentIds && it.captureBundleId == captureBundleId })
        }
    }

    @Test fun `verification result rejects a receipt with the wrong terminal bug or attempt state`() {
        val verificationId = "60000000-0000-4000-8000-000000000001"
        val verifierId = "70000000-0000-4000-8000-000000000001"
        val eventId = "a0000000-0000-4000-8000-000000000001"
        val invalidTerminalFacts = listOf(
            Triple(VerificationOutcome.PASSED, "ready", "delivered"),
            Triple(VerificationOutcome.FAILED, "ready", "delivered"),
            Triple(VerificationOutcome.BLOCKED, "ready_for_verification", "verification_failed"),
        )
        invalidTerminalFacts.forEach { (outcome, bugState, attemptStatus) ->
            val token = "invalid-terminal-${outcome.wireName}-${UUID.randomUUID()}"
            val clientSubmissionId = UUID.randomUUID().toString()
            val summary = "${outcome.wireName} result"
            NativeProjectBindings.register(token, project)
            val http = OkHttpClient.Builder().addInterceptor { chain ->
                val request = chain.request()
                fixtureResponse(
                    request,
                    JSONObject()
                        .put("clientSubmissionId", clientSubmissionId)
                        .put(
                            "qaItem",
                            JSONObject().put("type", "bug").put("id", bugId).put("key", "QA-1"),
                        )
                        .put(
                            "verification",
                            frozenVerification(verificationId, verifierId, outcome.wireName, version = 3)
                                .put("resultSummary", summary),
                        )
                        .put(
                            "repairAttempt",
                            frozenAttempt(attemptId, attemptStatus, 5, "Delivered"),
                        )
                        .put("bug", terminalBug(bugState, 9))
                        .put("attachmentIds", JSONArray())
                        .put("captureBundleId", JSONObject.NULL)
                        .put("eventId", eventId)
                        .put("replayed", false)
                        .toString(),
                )
            }.build()
            val client = BugLifecycleClient(
                ProjectOperationsClient("https://fixture.invalid/api/v1/", http),
                project,
                token,
            )
            val failure = runCatching {
                runBlocking {
                    client.recordVerificationResult(
                        VerificationResultCommand(
                            bugId = bugId,
                            verificationId = verificationId,
                            expectedVersion = 2,
                            outcome = outcome,
                            resultSummary = summary,
                            clientSubmissionId = clientSubmissionId,
                            attachmentIds = emptyList(),
                            failureReason = summary.takeIf { outcome == VerificationOutcome.FAILED },
                            blockedReason = summary.takeIf { outcome == VerificationOutcome.BLOCKED },
                        ),
                    )
                }
            }.exceptionOrNull()

            assertEquals("VERIFICATION_RESULT_RESPONSE_MISMATCH", failure?.message)
        }
    }

    @Test fun `verification receipt accepts canonical server ordering for a legacy reversed identity`() = runBlocking {
        val verificationId = "60000000-0000-4000-8000-000000000001"
        val verifierId = "70000000-0000-4000-8000-000000000001"
        val clientSubmissionId = "90000000-0000-4000-8000-000000000001"
        val selectedOrder = listOf(
            "80000000-0000-4000-8000-000000000002",
            "80000000-0000-4000-8000-000000000001",
        )
        val canonicalOrder = selectedOrder.sorted()
        val token = "verification-order-${UUID.randomUUID()}"
        NativeProjectBindings.register(token, project)
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            assertEquals(
                selectedOrder,
                request.jsonBody().getJSONArray("attachmentIds").let { array ->
                    (0 until array.length()).map(array::getString)
                },
            )
            fixtureResponse(
                request,
                JSONObject()
                    .put("clientSubmissionId", clientSubmissionId)
                    .put("qaItem", JSONObject().put("type", "bug").put("id", bugId).put("key", "QA-1"))
                    .put(
                        "verification",
                        frozenVerification(verificationId, verifierId, "passed", version = 3)
                            .put("resultSummary", "Passed"),
                    )
                    .put("repairAttempt", frozenAttempt(attemptId, "delivered", 5, "Delivered"))
                    .put("bug", terminalBug("closed", 9))
                    .put("attachmentIds", JSONArray(canonicalOrder))
                    .put("captureBundleId", JSONObject.NULL)
                    .put("eventId", "a0000000-0000-4000-8000-000000000001")
                    .put("replayed", true)
                    .toString(),
            )
        }.build()
        val client = BugLifecycleClient(
            ProjectOperationsClient("https://fixture.invalid/api/v1/", http),
            project,
            token,
        )

        val receipt = client.recordVerificationResult(
            VerificationResultCommand(
                bugId = bugId,
                verificationId = verificationId,
                expectedVersion = 2,
                outcome = VerificationOutcome.PASSED,
                resultSummary = "Passed",
                clientSubmissionId = clientSubmissionId,
                attachmentIds = selectedOrder,
            ),
        )

        assertEquals(canonicalOrder, receipt.attachmentIds)
    }

    @Test fun `verification result rejects coerced primitives shortened UUIDs and extra fields`() {
        val verificationId = "60000000-0000-4000-8000-000000000001"
        val verifierId = "70000000-0000-4000-8000-000000000001"
        val clientSubmissionId = "90000000-0000-4000-8000-000000000001"
        fun valid() = JSONObject()
            .put("clientSubmissionId", clientSubmissionId)
            .put("qaItem", JSONObject().put("type", "bug").put("id", bugId).put("key", "QA-1"))
            .put(
                "verification",
                frozenVerification(verificationId, verifierId, "passed", version = 3)
                    .put("resultSummary", "Passed"),
            )
            .put("repairAttempt", frozenAttempt(attemptId, "delivered", 5, "Delivered"))
            .put("bug", terminalBug("closed", 9))
            .put("attachmentIds", JSONArray())
            .put("captureBundleId", JSONObject.NULL)
            .put("eventId", "a0000000-0000-4000-8000-000000000001")
            .put("replayed", true)
        val malformed = listOf(
            valid().apply { getJSONObject("verification").put("version", "3") },
            valid().put("replayed", "true"),
            valid().put("eventId", "1-1-1-1-1"),
            valid().put("unexpected", true),
            valid().apply { remove("captureBundleId") },
        )
        malformed.forEachIndexed { index, response ->
            val token = "strict-result-$index-${UUID.randomUUID()}"
            NativeProjectBindings.register(token, project)
            val http = OkHttpClient.Builder().addInterceptor { chain ->
                fixtureResponse(chain.request(), response.toString())
            }.build()
            val client = BugLifecycleClient(
                ProjectOperationsClient("https://fixture.invalid/api/v1/", http),
                project,
                token,
            )

            val failure = runCatching {
                runBlocking {
                    client.recordVerificationResult(
                        VerificationResultCommand(
                            bugId = bugId,
                            verificationId = verificationId,
                            expectedVersion = 2,
                            outcome = VerificationOutcome.PASSED,
                            resultSummary = "Passed",
                            clientSubmissionId = clientSubmissionId,
                            attachmentIds = emptyList(),
                        ),
                    )
                }
            }.exceptionOrNull()

            assertTrue("malformed result fixture $index must be rejected", failure != null)
        }
    }

    private fun frozenAttempt(
        id: String,
        status: String,
        version: Int,
        summary: String,
        sequence: Int = 1,
        mode: String = "human",
        assigneeId: String = "40000000-0000-4000-8000-000000000001",
        parentAttemptId: String? = null,
        commitSha: String? = null,
    ) = JSONObject()
        .put("id", id).put("bugId", bugId).put("sequence", sequence).put("mode", mode)
        .put("status", status).put("assigneeId", assigneeId)
        .put("parentAttemptId", parentAttemptId ?: JSONObject.NULL).put("summary", summary)
        .put("branch", JSONObject.NULL).put("commitSha", commitSha ?: JSONObject.NULL)
        .put("mergeRequestUrl", JSONObject.NULL).put("targetBuildId", JSONObject.NULL)
        .put("version", version)

    private fun workflowPage(
        attempts: JSONArray = JSONArray(),
        occurrences: JSONArray = JSONArray(),
        verifications: JSONArray = JSONArray(),
        builds: JSONArray = JSONArray(),
        relayReceipts: JSONArray = JSONArray(),
        nextCursor: Any = JSONObject.NULL,
        snapshotSequence: Any = 73L,
        bugVersion: Any = 4,
        truncated: Any = nextCursor !== JSONObject.NULL,
    ) = JSONObject()
        .put("bugId", bugId)
        .put("bugVersion", bugVersion)
        .put("snapshotSequence", snapshotSequence)
        .put("truncated", truncated)
        .put("occurrences", occurrences)
        .put("repairAttempts", attempts)
        .put("verifications", verifications)
        .put("builds", builds)
        .put("relayReceipts", relayReceipts)
        .put("nextCursor", nextCursor)

    private fun terminalBug(state: String, version: Int) = JSONObject()
        .put("id", bugId).put("projectId", project).put("key", "QA-1")
        .put("number", 1).put("title", "Fixture").put("description", "Description")
        .put("expectedBehavior", "Expected").put("moduleId", JSONObject.NULL)
        .put("state", state).put("severity", "S2").put("priority", "P2")
        .put("reporterId", "70000000-0000-4000-8000-000000000099")
        .put("ownerId", JSONObject.NULL).put("verificationOwnerId", JSONObject.NULL)
        .put("duplicateOfBugId", JSONObject.NULL).put("occurrenceCount", 1).put("reopenCount", 0)
        .put("version", version).put("createdAt", "2026-09-09T00:00:00Z")
        .put("updatedAt", "2026-09-09T00:01:00Z")
        .put("closedAt", if (state == "closed") "2026-09-09T00:01:00Z" else JSONObject.NULL)

    private fun assignmentProof(actorId: String) = WorkbenchAssignmentProof(
        projectId = project,
        actorId = actorId,
        snapshotSequence = 73L,
    )

    private fun frozenVerification(
        id: String,
        verifierId: String,
        status: String,
        version: Int,
        buildId: String? = null,
        repairAttemptId: String = attemptId,
    ) = JSONObject()
        .put("id", id)
        .put("bugId", bugId)
        .put("repairAttemptId", repairAttemptId)
        .put("buildId", buildId ?: JSONObject.NULL)
        .put("status", status)
        .put("verifierId", verifierId)
        .put("criteriaSnapshot", "Run acceptance")
        .put("resultSummary", if (status in setOf("passed", "failed", "blocked")) "Done" else JSONObject.NULL)
        .put("version", version)

    private fun frozenOccurrence(id: String) = JSONObject()
        .put("id", id)
        .put("bugId", bugId)
        .put("reporterId", "40000000-0000-4000-8000-000000000001")
        .put("observedAt", "2026-09-09T00:00:00Z")
        .put("platform", "android")
        .put("appVersion", "0.2.0-preview.10")
        .put("resourceVersion", JSONObject.NULL)
        .put("gitSha", JSONObject.NULL)
        .put("deviceModel", "Fixture")
        .put("osVersion", "15")
        .put("steps", JSONArray().put("Open the Bug"))
        .put("actualBehavior", "Observed fixture behavior")
        .put("frequency", "always")
        .put("errorSignature", JSONObject.NULL)
        .put("environment", JSONObject.NULL)
        .put("attachmentIds", JSONArray())
        .put("captureBundleId", JSONObject.NULL)
        .put("createdAt", "2026-09-09T00:00:01Z")

    private fun frozenBuild(id: String) = JSONObject()
        .put("id", id)
        .put("projectId", project)
        .put("provider", "manual")
        .put("externalId", "fixture-build")
        .put("versionName", "0.2.0-preview.10")
        .put("channel", "preview")
        .put("projectKey", "QA")
        .put("branch", "codex/project-components-v2-1")
        .put("sourceCommitSha", "b".repeat(40))
        .put("mode", "debug")
        .put("status", "ready")
        .put("manifest", JSONObject().put("commitShas", JSONArray().put("b".repeat(40))))
        .put("version", 1)

    private fun frozenRelayReceipt(
        handoffId: String,
        repairAttemptId: String,
        buildId: String?,
    ) = JSONObject()
        .put("qaItem", JSONObject().put("type", "bug").put("id", bugId).put("key", "QA-1"))
        .put("repairAttemptId", repairAttemptId)
        .put("handoffId", handoffId)
        .put("relayInstanceId", "relay_fixture")
        .put("relayTaskId", "fixture-task")
        .put("handoffStatus", "awaiting_verification")
        .put("buildRequirement", if (buildId == null) "not_required" else "required")
        .put("buildEvidenceStatus", if (buildId == null) "not_required" else "exact_commit_eligible")
        .put("deliveredCommitSha", "b".repeat(40))
        .put("buildId", buildId ?: JSONObject.NULL)
        .put("externalRevision", 1)
        .put("requiresHumanVerification", true)
        .put("automationAuthority", "delivery_build_projection_only")
        .put("lastEventAt", "2026-09-09T00:00:02Z")
        .put("failureSummary", JSONObject.NULL)
        .put("version", 1)

    private fun workflowClient(response: (okhttp3.Request) -> JSONObject): BugLifecycleClient {
        val token = "workflow-${UUID.randomUUID()}"
        NativeProjectBindings.register(token, project)
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            fixtureResponse(request, response(request).toString())
        }.build()
        return BugLifecycleClient(
            ProjectOperationsClient("https://fixture.invalid/api/v1/", http),
            project,
            token,
        )
    }

    private data class HistoryFixture(val code: Int = 200, val body: JSONObject)

    private fun historyClient(response: (okhttp3.Request) -> HistoryFixture): BugLifecycleClient {
        val token = "history-${UUID.randomUUID()}"
        NativeProjectBindings.register(token, project)
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            assertEquals("Bearer $token", request.header("Authorization"))
            assertEquals(project, request.header("x-qa-project-id"))
            assertEquals("100", request.url.queryParameter("limit"))
            val fixture = response(request)
            Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(fixture.code)
                .message("Fixture")
                .body(fixture.body.toString().toResponseBody())
                .build()
        }.build()
        return BugLifecycleClient(
            ProjectOperationsClient("https://fixture.invalid/api/v1/", http),
            project,
            token,
        )
    }

    private fun okhttp3.Request.historyPath(): String =
        url.encodedPath.removePrefix("/api/v1/")

    private fun historyItems(prefix: String, range: IntRange): JSONArray = JSONArray().apply {
        range.forEach { index -> put(JSONObject().put("id", "$prefix-$index")) }
    }

    private fun historyPage(
        items: JSONArray = JSONArray(),
        nextCursor: Any = JSONObject.NULL,
        snapshotSequence: Any = 73L,
        responseProjectId: Any = project,
        responseBugId: Any = bugId,
    ) = JSONObject()
        .put("projectId", responseProjectId)
        .put("bugId", responseBugId)
        .put("snapshotSequence", snapshotSequence)
        .put("items", items)
        .put("nextCursor", nextCursor)

    private fun okhttp3.Request.jsonBody(): JSONObject = JSONObject(
        checkNotNull(body).let { Buffer().also(it::writeTo).readUtf8() },
    )

    private fun okhttp3.Request.vendorMediaType(): String = checkNotNull(body?.contentType()).let {
        "${it.type}/${it.subtype}"
    }

    private fun fixtureResponse(request: okhttp3.Request, body: String): Response = Response.Builder()
        .request(request).protocol(Protocol.HTTP_1_1).code(200).message("Fixture")
        .body(body.toResponseBody()).build()
}
