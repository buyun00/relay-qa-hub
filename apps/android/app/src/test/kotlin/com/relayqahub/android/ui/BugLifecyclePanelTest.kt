package com.relayqahub.android.ui

import com.relayqahub.android.FrozenVerificationResult
import com.relayqahub.android.PendingVerificationAttachment
import com.relayqahub.android.PendingVerificationSubmission
import com.relayqahub.android.QaPerson
import com.relayqahub.android.QaPersonRole
import com.relayqahub.android.QaPeopleConfig
import com.relayqahub.android.data.AccountProjectScope
import com.relayqahub.android.network.AttachmentUploadCheckpoint
import com.relayqahub.android.network.AccountSessionFailure
import com.relayqahub.android.network.BugWorkbenchResult
import com.relayqahub.android.network.RepairAttemptRecord
import com.relayqahub.android.network.RepairAttemptStatus
import com.relayqahub.android.network.RepairMode
import com.relayqahub.android.network.TerminalBugRecord
import com.relayqahub.android.network.VerificationRecord
import com.relayqahub.android.network.VerificationResultReceipt
import com.relayqahub.android.network.VerificationStatus
import com.relayqahub.android.network.WorkbenchAssignmentProof
import com.relayqahub.android.network.WorkbenchBug
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BugLifecyclePanelTest {
    private val projectId = "10000000-0000-4000-8000-000000000001"
    private val bugId = "20000000-0000-4000-8000-000000000001"
    private val actorId = "30000000-0000-4000-8000-000000000001"
    private val otherId = "30000000-0000-4000-8000-000000000002"
    private val verificationId = "40000000-0000-4000-8000-000000000001"

    @Test
    fun `verification controls allow any active member to create and keep an active verifier exclusive`() {
        val ready = bug("ready_for_verification", otherId, proofActorId = null)
        val noCurrentVerification = workflow(JSONObject.NULL)
        val people = listOf(verifier(actorId, roles = setOf(QaPersonRole.FIXER)), verifier(otherId))
        assertFalse(canActOnVerification(null, ready, null, scope(), people))
        assertTrue(canActOnVerification(noCurrentVerification, ready, null, scope(), people))

        val workflowAssignedElsewhere = workflow(verification(otherId, "requested"))
        assertFalse(canActOnVerification(workflowAssignedElsewhere, ready, null, scope(), people))
        assertTrue(
            canActOnVerification(
                workflowAssignedElsewhere,
                ready,
                null,
                scope(actor = otherId),
                people,
            ),
        )
        assertFalse(
            canActOnVerification(
                workflow(verification("invalid", "requested")),
                ready,
                null,
                scope(),
                people,
            ),
        )
        assertFalse(
            canActOnVerification(
                noCurrentVerification,
                bug("awaiting_build", otherId, proofActorId = null),
                null,
                scope(),
                people,
            ),
        )
        assertFalse(
            canActOnVerification(
                noCurrentVerification,
                ready.copy(projectId = "10000000-0000-4000-8000-000000000099"),
                null,
                scope(),
                people,
            ),
        )
    }

    @Test
    fun `unknown and disabled members stay read only while role labels do not gate acceptance`() {
        val workflow = workflow(JSONObject.NULL)
        val ready = bug("ready_for_verification", otherId, proofActorId = null)
        assertFalse(canActOnVerification(workflow, ready, null, scope(), emptyList()))
        assertFalse(
            canActOnVerification(
                workflow,
                ready,
                null,
                scope(),
                listOf(verifier(actorId, active = false)),
            ),
        )
        assertTrue(
            canActOnVerification(
                workflow,
                ready,
                null,
                scope(),
                listOf(verifier(actorId, roles = setOf(QaPersonRole.FIXER))),
            ),
        )
        assertTrue(
            canActOnVerification(
                workflow,
                ready,
                null,
                scope(),
                listOf(verifier(actorId, roles = emptySet())),
            ),
        )
    }

    @Test
    fun `an existing pending submission remains actionable only for its assigned verifier`() {
        val pending = PendingVerificationSubmission(
            scope = AccountProjectScope(
                "50000000-0000-4000-8000-000000000001",
                projectId,
                actorId,
                "60000000-0000-4000-8000-000000000001",
                "70000000-0000-4000-8000-000000000001",
            ),
            bugId = bugId,
            verificationId = verificationId,
            clientSubmissionId = "80000000-0000-4000-8000-000000000001",
        )
        val awaiting = bug("awaiting_build", actorId)
        val workflow = workflow(verification(actorId, "in_progress"))
        val people = listOf(verifier(actorId), verifier(otherId))
        assertTrue(canActOnVerification(workflow, awaiting, pending, scope(), people))
        assertFalse(canActOnVerification(workflow, awaiting, pending, scope(actor = otherId), people))
    }

    @Test
    fun `terminal workflow is read only unless it is replaying an existing frozen result`() {
        val terminal = workflow(verification(actorId, "passed"))
        val people = listOf(verifier(actorId))
        val ready = bug("ready_for_verification", actorId)
        assertFalse(canActOnVerification(terminal, ready, null, scope(), people))

        val frozenPending = pending().copy(
            frozenResult = FrozenVerificationResult(
                verificationId = verificationId,
                expectedVersion = 2,
                status = "passed",
                resultSummary = "durable summary",
                attachmentIds = emptyList(),
                captureBundleId = null,
                failureReason = null,
                blockedReason = null,
            ),
        )
        assertTrue(canActOnVerification(terminal, ready, frozenPending, scope(), people))
    }

    @Test
    fun `responsibility owner does not authorize another active verification`() {
        val responsibilityOwner = otherId
        val activeVerifier = "30000000-0000-4000-8000-000000000003"
        val ready = bug("ready_for_verification", responsibilityOwner, proofActorId = null)
        val people = listOf(verifier(actorId), verifier(responsibilityOwner), verifier(activeVerifier))

        assertFalse(
            canActOnVerification(
                workflow(verification(activeVerifier, "requested")),
                ready,
                null,
                scope(),
                people,
            ),
        )
        assertTrue(
            canActOnVerification(
                workflow(verification(actorId, "requested")),
                ready,
                null,
                scope(),
                people,
            ),
        )
    }

    @Test
    fun `a durable pending result cannot bypass another active verification`() {
        val otherVerificationId = "40000000-0000-4000-8000-000000000002"
        val workflow = workflow(
            verification(otherId, "requested", otherVerificationId),
        ).put("latestVerification", verification(actorId, "in_progress"))

        assertFalse(
            canActOnVerification(
                workflow,
                bug("ready_for_verification", otherId, proofActorId = null),
                pending(),
                scope(),
                listOf(verifier(actorId), verifier(otherId)),
            ),
        )
    }

    @Test
    fun `result receipt requires the acting member recorded on the formal verification`() {
        val responsibilityOwner = "30000000-0000-4000-8000-000000000003"
        val repairAttemptId = "50000000-0000-4000-8000-000000000001"
        val frozen = FrozenVerificationResult(
            verificationId = verificationId,
            expectedVersion = 2,
            status = "passed",
            resultSummary = "verified",
            attachmentIds = emptyList(),
            captureBundleId = null,
            failureReason = null,
            blockedReason = null,
        )
        val receipt = VerificationResultReceipt(
            clientSubmissionId = pending().clientSubmissionId,
            qaItemKey = "QA-1",
            verification = VerificationRecord(
                id = verificationId,
                bugId = bugId,
                repairAttemptId = repairAttemptId,
                buildId = null,
                status = VerificationStatus.PASSED,
                verifierId = actorId,
                criteriaSnapshot = "criteria",
                resultSummary = "verified",
                version = 3,
            ),
            repairAttempt = RepairAttemptRecord(
                id = repairAttemptId,
                bugId = bugId,
                sequence = 1,
                mode = RepairMode.HUMAN,
                status = RepairAttemptStatus.DELIVERED,
                assigneeId = otherId,
                parentAttemptId = null,
                summary = null,
                branch = null,
                commitSha = null,
                mergeRequestUrl = null,
                targetBuildId = null,
                version = 2,
            ),
            bug = TerminalBugRecord(bugId, projectId, "QA-1", "closed", 4),
            attachmentIds = emptyList(),
            captureBundleId = null,
            eventId = "60000000-0000-4000-8000-000000000001",
            replayed = true,
        )
        val assignedElsewhere = bug(
            "ready_for_verification",
            responsibilityOwner,
            proofActorId = null,
        )

        assertTrue(verificationResultReceiptMatches(receipt, pending(), frozen, assignedElsewhere))
        assertFalse(
            verificationResultReceiptMatches(
                receipt.copy(verification = receipt.verification.copy(verifierId = responsibilityOwner)),
                pending(),
                frozen,
                assignedElsewhere,
            ),
        )
        assertFalse(
            verificationResultReceiptMatches(
                receipt.copy(bug = receipt.bug.copy(projectId = otherId)),
                pending(),
                frozen,
                assignedElsewhere,
            ),
        )
    }

    @Test
    fun `submission callback refreshes membership project Bug and workflow at one snapshot`() = runBlocking {
        val responsibilityOwner = "30000000-0000-4000-8000-000000000003"
        var peopleReads = 0
        var bugReads = 0
        var workflowReads = 0
        val snapshot = loadConsistentVerificationActionSnapshot(
            bugId = bugId,
            projectId = projectId,
            actorId = actorId,
            readPeople = {
                peopleReads += 1
                QaPeopleConfig(4, "QA", listOf(verifier(actorId)), if (peopleReads == 1) 8 else SNAPSHOT)
            },
            readProjectBugs = {
                bugReads += 1
                BugWorkbenchResult(
                    SNAPSHOT,
                    listOf(bug("ready_for_verification", responsibilityOwner, proofActorId = null)),
                    null,
                )
            },
            readWorkflow = {
                workflowReads += 1
                workflow(verification(actorId, "requested"))
            },
        )

        assertEquals(2, peopleReads)
        assertEquals(2, bugReads)
        assertEquals(2, workflowReads)
        assertTrue(
            canActOnVerification(
                snapshot.workflow,
                snapshot.bug,
                null,
                scope(),
                snapshot.people.people,
            ),
        )
    }

    @Test
    fun `submission callback retries a project Bug stream snapshot race`() = runBlocking {
        val responsibilityOwner = "30000000-0000-4000-8000-000000000003"
        var peopleReads = 0
        var bugReads = 0
        var workflowReads = 0

        val snapshot = loadConsistentVerificationActionSnapshot(
            bugId = bugId,
            projectId = projectId,
            actorId = actorId,
            readPeople = {
                peopleReads += 1
                QaPeopleConfig(4, "QA", listOf(verifier(actorId)), SNAPSHOT)
            },
            readProjectBugs = {
                bugReads += 1
                if (bugReads == 1) {
                    throw com.relayqahub.android.network.BugWorkbenchFailure(
                        "WORKBENCH_SNAPSHOT_CHANGED",
                    )
                }
                BugWorkbenchResult(
                    SNAPSHOT,
                    listOf(bug("ready_for_verification", responsibilityOwner, proofActorId = null)),
                    null,
                )
            },
            readWorkflow = {
                workflowReads += 1
                workflow(verification(actorId, "requested"))
            },
        )

        assertEquals(2, peopleReads)
        assertEquals(2, bugReads)
        assertEquals(1, workflowReads)
        assertEquals(responsibilityOwner, snapshot.bug.verificationOwnerId)
    }

    @Test
    fun `submission callback rejects inactive membership and cross project Bug data`() {
        val inactive = runCatching {
            runBlocking {
                loadConsistentVerificationActionSnapshot(
                    bugId = bugId,
                    projectId = projectId,
                    actorId = actorId,
                    readPeople = {
                        QaPeopleConfig(
                            4,
                            "QA",
                            listOf(verifier(actorId, active = false)),
                            SNAPSHOT,
                        )
                    },
                    readProjectBugs = {
                        BugWorkbenchResult(
                            SNAPSHOT,
                            listOf(bug("ready_for_verification", otherId, proofActorId = null)),
                            null,
                        )
                    },
                    readWorkflow = { workflow(JSONObject.NULL) },
                )
            }
        }.exceptionOrNull()
        assertEquals("PROJECT_MEMBERSHIP_REQUIRED", inactive?.message)

        val otherProject = "10000000-0000-4000-8000-000000000099"
        val crossProject = runCatching {
            runBlocking {
                loadConsistentVerificationActionSnapshot(
                    bugId = bugId,
                    projectId = projectId,
                    actorId = actorId,
                    readPeople = {
                        QaPeopleConfig(4, "QA", listOf(verifier(actorId)), SNAPSHOT)
                    },
                    readProjectBugs = {
                        BugWorkbenchResult(
                            SNAPSHOT,
                            listOf(
                                bug("ready_for_verification", otherId, proofActorId = null)
                                    .copy(projectId = otherProject),
                            ),
                            null,
                        )
                    },
                    readWorkflow = { workflow(JSONObject.NULL) },
                )
            }
        }.exceptionOrNull()
        assertEquals("BUG_SCOPE_MISMATCH", crossProject?.message)
    }

    @Test
    fun `a frozen result retry uses its durable summary after process recreation`() {
        val pending = pending().copy(
            frozenResult = FrozenVerificationResult(
                verificationId = verificationId,
                expectedVersion = 2,
                status = "passed",
                resultSummary = "durable summary",
                attachmentIds = emptyList(),
                captureBundleId = null,
                failureReason = null,
                blockedReason = null,
            ),
        )

        assertEquals("durable summary", verificationSubmissionNote(pending, ""))
        assertEquals("fresh summary", verificationSubmissionNote(null, "  fresh summary  "))
    }

    @Test
    fun `attachment ids freeze in canonical order regardless of selection order`() {
        val first = "80000000-0000-4000-8000-000000000001"
        val second = "80000000-0000-4000-8000-000000000002"
        val selectedInReverse = listOf(
            attachment("90000000-0000-4000-8000-000000000002", second),
            attachment("90000000-0000-4000-8000-000000000001", first),
        )

        assertEquals(listOf(first, second), canonicalVerificationAttachmentIds(selectedInReverse))
    }

    @Test
    fun `capture identity locks at the first durable upload session`() {
        assertTrue(verificationCaptureCanChange(pending()))
        val initialized = pending().copy(
            attachments = listOf(
                PendingVerificationAttachment(
                    clientAttachmentId = "90000000-0000-4000-8000-000000000001",
                    filename = "evidence.png",
                    mediaType = "image/png",
                    expectedSize = 3,
                    sha256 = "a".repeat(64),
                    uploadCheckpoint = AttachmentUploadCheckpoint(
                        sessionId = "a0000000-0000-4000-8000-000000000001",
                        chunkSize = 262_144,
                        expectedChunkCount = 1,
                        uploadVersion = 1,
                        uploadExpiresAt = "2090-01-01T00:00:00Z",
                    ),
                ),
            ),
        )
        assertFalse(verificationCaptureCanChange(initialized))
    }

    @Test
    fun `frozen result renews an expired reservation only after the first result attempt`() = runBlocking {
        val attachment = attachment(
            "90000000-0000-4000-8000-000000000001",
            "80000000-0000-4000-8000-000000000001",
        )
        val stages = mutableListOf<String>()
        var resultAttempts = 0

        val receipt = recordVerificationResultWithReservationRecovery(
            attachments = listOf(attachment),
            record = {
                resultAttempts += 1
                stages += "result:$resultAttempts"
                if (resultAttempts == 1) throw AccountSessionFailure("INVALID_REQUEST")
                "accepted"
            },
            renew = {
                assertEquals(attachment.clientAttachmentId, it.clientAttachmentId)
                stages += "renew"
            },
        )

        assertEquals("accepted", receipt)
        assertEquals(listOf("result:1", "renew", "result:2"), stages)
    }

    @Test
    fun `lost result response replays before renewal and leaves claimed bindings untouched`() = runBlocking {
        val stages = mutableListOf<String>()

        val receipt = recordVerificationResultWithReservationRecovery(
            attachments = listOf(
                attachment(
                    "90000000-0000-4000-8000-000000000001",
                    "80000000-0000-4000-8000-000000000001",
                ),
            ),
            record = {
                stages += "result-replay"
                "idempotent-receipt"
            },
            renew = { stages += "renew" },
        )

        assertEquals("idempotent-receipt", receipt)
        assertEquals(listOf("result-replay"), stages)
    }

    @Test
    fun `unrelated result failures do not renew reservations`() = runBlocking {
        val stages = mutableListOf<String>()
        val failure = runCatching {
            recordVerificationResultWithReservationRecovery(
                attachments = listOf(
                    attachment(
                        "90000000-0000-4000-8000-000000000001",
                        "80000000-0000-4000-8000-000000000001",
                    ),
                ),
                record = {
                    stages += "result"
                    throw AccountSessionFailure("FORBIDDEN")
                },
                renew = { stages += "renew" },
            )
        }.exceptionOrNull()

        assertEquals("FORBIDDEN", (failure as? AccountSessionFailure)?.code)
        assertEquals(listOf("result"), stages)
    }

    private fun pending() = PendingVerificationSubmission(
        scope = scope(),
        bugId = bugId,
        verificationId = verificationId,
        clientSubmissionId = "80000000-0000-4000-8000-000000000001",
    )

    private fun verification(
        verifierId: String,
        status: String,
        id: String = verificationId,
    ) = JSONObject()
        .put("id", id)
        .put("bugId", bugId)
        .put("verifierId", verifierId)
        .put("status", status)

    private fun workflow(verification: Any) = JSONObject()
        .put("bugId", bugId)
        .put("snapshotSequence", SNAPSHOT)
        .put("verification", verification)

    private fun scope(
        project: String = projectId,
        actor: String = actorId,
    ) = AccountProjectScope(
        "50000000-0000-4000-8000-000000000001",
        project,
        actor,
        "60000000-0000-4000-8000-000000000001",
        "70000000-0000-4000-8000-000000000001",
    )

    private fun verifier(
        id: String,
        active: Boolean = true,
        roles: Set<QaPersonRole> = setOf(QaPersonRole.VERIFIER),
    ) = QaPerson(id, "Verifier", roles, active)

    private fun attachment(clientId: String, attachmentId: String) = PendingVerificationAttachment(
        clientAttachmentId = clientId,
        filename = "$clientId.png",
        mediaType = "image/png",
        expectedSize = 1,
        sha256 = "a".repeat(64),
        attachmentId = attachmentId,
    )

    private fun bug(
        state: String,
        verifierId: String?,
        proofActorId: String? = actorId,
    ) = WorkbenchBug(
        id = bugId,
        projectId = projectId,
        key = "QA-1",
        title = "Fixture",
        state = state,
        occurrenceCount = 1,
        updatedAt = "2026-09-09T00:00:00Z",
        verificationOwnerId = verifierId,
        verifierAssignmentProof = proofActorId?.let {
            WorkbenchAssignmentProof(projectId, it, SNAPSHOT)
        },
    )

    private companion object {
        const val SNAPSHOT = 10L
    }
}
