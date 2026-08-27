package com.relayqahub.android

import com.relayqahub.android.network.QaHubApiContract
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FoundationViewModelContractTest {
    @Test
    fun `single field content derives only the hidden bounded contract summary`() {
        val content = "  登录后   点击开始按钮\n游戏卡住  "

        assertEquals("登录后 点击开始按钮 游戏卡住", internalBugSummary(content))
        assertEquals(80, internalBugSummary("问".repeat(120)).length)
        assertTrue(runCatching { internalBugSummary("  \n  ") }.isFailure)
    }

    @Test
    fun `foundation fake creates the frozen App-first Bug command`() {
        val request = request()

        FoundationCreateBugContract.requireValid(request, PROJECT_ID)
        val payload = request.payload
        val occurrence = payload["occurrence"] as Map<*, *>

        assertEquals("CREATE_BUG", request.operationKind)
        assertEquals("POST", request.httpMethod)
        assertEquals("/bugs", request.relativePath)
        assertEquals("submission:$SUBMISSION_ID:commit", request.idempotencyKey)
        assertEquals(QaHubApiContract.VERSION, payload["submissionContractVersion"])
        assertEquals(PROJECT_ID, payload["projectId"])
        assertEquals(SUBMISSION_ID, payload["clientSubmissionId"])
        assertEquals(OWNER_ID, payload["ownerId"])
        assertEquals(VERIFIER_ID, payload["verificationOwnerId"])
        assertTrue((payload["description"] as String).isNotBlank())
        assertTrue((payload["expectedBehavior"] as String).isNotBlank())
        assertEquals("S3", payload["severity"])
        assertEquals("P3", payload["priority"])
        assertEquals("2026-08-25T01:02:03Z", occurrence["observedAt"])
        assertEquals("android", occurrence["platform"])
        assertTrue((occurrence["steps"] as List<*>).isNotEmpty())
        assertTrue((occurrence["actualBehavior"] as String).isNotBlank())
    }

    @Test
    fun `new bug may leave fixer unassigned while keeping a verifier`() {
        val request = FoundationCreateBugContract.buildRequest(
            projectId = PROJECT_ID,
            submissionId = SUBMISSION_ID,
            observedAt = "2026-08-25T01:02:03Z",
            qaAppVersion = "0.1.4-debug",
            ownerId = null,
            verificationOwnerId = VERIFIER_ID,
        )

        FoundationCreateBugContract.requireValid(request, PROJECT_ID)
        assertTrue("ownerId" !in request.payload)
        assertEquals(VERIFIER_ID, request.payload["verificationOwnerId"])
    }

    @Test
    fun `foundation fake rejects any path other than exact bugs collection`() {
        val invalid = request().copy(relativePath = "//attacker.invalid/bugs")

        assertRejected(invalid)
    }

    @Test
    fun `foundation fake rejects idempotency key not derived from submission id`() {
        val invalid = request().copy(
            idempotencyKey = "submission:30000000-0000-4000-8000-000000000001:commit",
        )

        assertRejected(invalid)
    }

    @Test
    fun `foundation fake rejects a payload missing a frozen required field`() {
        val valid = request()
        val invalid = valid.copy(payload = valid.payload - "description")

        assertRejected(invalid)
    }

    @Test
    fun `foundation fake rejects a non UUID project scope`() {
        val invalid = request()

        val result = runCatching {
            FoundationCreateBugContract.requireValid(invalid, "local-foundation-project")
        }

        assertTrue(result.isFailure)
    }

    @Test
    fun `foundation fake rejects payload project outside queued scope`() {
        val valid = request()
        val invalid = valid.copy(
            payload = valid.payload +
                ("projectId" to "40000000-0000-4000-8000-000000000001"),
        )

        assertRejected(invalid)
    }

    @Test
    fun `foundation fake rejects incomplete occurrence`() {
        val valid = request()
        val occurrence = (valid.payload["occurrence"] as Map<*, *>)
            .entries
            .associate { (key, value) -> key as String to value } - "actualBehavior"
        val invalid = valid.copy(payload = valid.payload + ("occurrence" to occurrence))

        assertRejected(invalid)
    }

    @Test
    fun `foundation fake rejects sensitive occurrence environment fields`() {
        val valid = request()
        val occurrence = (valid.payload["occurrence"] as Map<*, *>)
            .entries
            .associate { (key, value) -> key as String to value }
        val environment = (occurrence["environment"] as Map<*, *>)
            .entries
            .associate { (key, value) -> key as String to value } +
            ("authToken" to "must-not-enter-the-queue")
        val invalid = valid.copy(
            payload = valid.payload +
                ("occurrence" to (occurrence + ("environment" to environment))),
        )

        assertRejected(invalid)
    }

    @Test
    fun `foundation identity fixture uses UUID contract identities`() {
        val scope = FoundationViewModel.foundationScope(ACTOR_ID)

        listOf(
            scope.accountId,
            scope.projectId,
            scope.actorId,
            scope.installationId,
            scope.sessionId,
        ).forEach { UUID.fromString(it) }
    }

    private fun request() = FoundationCreateBugContract.buildRequest(
        projectId = PROJECT_ID,
        submissionId = SUBMISSION_ID,
        observedAt = "2026-08-25T01:02:03Z",
        qaAppVersion = "0.1.0-debug",
        ownerId = OWNER_ID,
        verificationOwnerId = VERIFIER_ID,
    )

    private fun assertRejected(request: FoundationFakeCreateBugRequest) {
        val result = runCatching {
            FoundationCreateBugContract.requireValid(request, PROJECT_ID)
        }
        assertTrue(result.isFailure)
    }

    companion object {
        private const val PROJECT_ID = "10000000-0000-4000-8000-000000000004"
        private const val SUBMISSION_ID = "20000000-0000-4000-8000-000000000001"
        private const val ACTOR_ID = "20000000-0000-4000-8000-000000000002"
        private const val OWNER_ID = "20000000-0000-4000-8000-000000000003"
        private const val VERIFIER_ID = "20000000-0000-4000-8000-000000000004"
    }
}
