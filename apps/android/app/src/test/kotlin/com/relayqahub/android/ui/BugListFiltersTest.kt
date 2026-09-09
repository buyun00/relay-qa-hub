package com.relayqahub.android.ui

import com.relayqahub.android.QaPerson
import com.relayqahub.android.QaPersonRole
import com.relayqahub.android.network.WorkbenchAssignmentProof
import com.relayqahub.android.network.WorkbenchBug
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BugListFiltersTest {
    private val bugs = listOf(
        bug(id = "reported-a", reporterId = "reporter-a", ownerId = "owner-a", state = "reported"),
        bug(id = "progress-a", reporterId = "reporter-a", ownerId = "owner-b", state = "in_progress"),
        bug(id = "verification-b", reporterId = "reporter-b", ownerId = "owner-a", state = "ready_for_verification"),
        bug(id = "closed-b", reporterId = "reporter-b", ownerId = "owner-b", state = "closed"),
        bug(id = "unassigned", reporterId = "reporter-c", ownerId = null, state = "needs_info"),
        bug(id = "deferred", reporterId = "reporter-c", ownerId = "owner-c", state = "deferred"),
    )

    @Test
    fun `all filters return every loaded bug in source order`() {
        assertEquals(
            bugs.map { it.id },
            filterBugs(bugs, BugListFilters()).map { it.id },
        )
    }

    @Test
    fun `reporter filter returns only bugs submitted by that person`() {
        assertEquals(
            listOf("reported-a", "progress-a"),
            filterBugs(bugs, BugListFilters(reporterId = "reporter-a")).map { it.id },
        )
    }

    @Test
    fun `owner filter returns only bugs assigned to that person`() {
        assertEquals(
            listOf("reported-a", "verification-b"),
            filterBugs(bugs, BugListFilters(ownerId = "owner-a")).map { it.id },
        )
    }

    @Test
    fun `unassigned owner filter matches only null owners`() {
        assertEquals(
            listOf("unassigned"),
            filterBugs(
                bugs,
                BugListFilters(ownerId = UNASSIGNED_OWNER_FILTER),
            ).map { it.id },
        )
    }

    @Test
    fun `status filters map backend states into the visible groups`() {
        val statusBugs = listOf(
            bug(id = "reported", reporterId = "r", ownerId = "o", state = "reported"),
            bug(id = "needs-info", reporterId = "r", ownerId = "o", state = "needs_info"),
            bug(id = "ready", reporterId = "r", ownerId = "o", state = "ready"),
            bug(id = "in-progress", reporterId = "r", ownerId = "o", state = "in_progress"),
            bug(id = "awaiting-build", reporterId = "r", ownerId = "o", state = "awaiting_build"),
            bug(id = "verification", reporterId = "r", ownerId = "o", state = "ready_for_verification"),
            bug(id = "closed", reporterId = "r", ownerId = "o", state = "closed"),
            bug(id = "deferred", reporterId = "r", ownerId = "o", state = "deferred"),
            bug(id = "rejected", reporterId = "r", ownerId = "o", state = "rejected"),
            bug(id = "duplicate", reporterId = "r", ownerId = "o", state = "duplicate"),
        )
        val expectedByStatus = mapOf(
            BugStatusFilter.PENDING to listOf("reported", "needs-info", "ready"),
            BugStatusFilter.IN_PROGRESS to listOf("in-progress"),
            BugStatusFilter.VERIFICATION to listOf("awaiting-build", "verification"),
            BugStatusFilter.CLOSED to listOf("closed", "deferred", "rejected", "duplicate"),
        )

        expectedByStatus.forEach { (status, expectedIds) ->
            assertEquals(
                status.name,
                expectedIds,
                filterBugs(statusBugs, BugListFilters(status = status)).map { it.id },
            )
        }
    }

    @Test
    fun `every backend workflow detail projects to exactly one of four task labels`() {
        listOf("reported", "needs_info", "ready").forEach { state ->
            assertEquals("待处理", bugStateLabel(state))
        }
        assertEquals("处理中", bugStateLabel("in_progress"))
        assertEquals("已完成待验收", bugStateLabel("awaiting_build"))
        assertEquals("已完成待验收", bugStateLabel("ready_for_verification"))
        listOf("closed", "deferred", "rejected", "duplicate").forEach { state ->
            assertEquals("关闭", bugStateLabel(state))
        }
    }

    @Test
    fun `reporter owner and status filters combine with AND semantics`() {
        assertEquals(
            listOf("verification-b"),
            filterBugs(
                bugs,
                BugListFilters(
                    reporterId = "reporter-b",
                    ownerId = "owner-a",
                    status = BugStatusFilter.VERIFICATION,
                ),
            ).map { it.id },
        )
    }

    @Test
    fun `canonical owner filter accepts only an exact server assignment proof`() {
        val projectId = "10000000-0000-4000-8000-000000000001"
        val actorId = "20000000-0000-4000-8000-000000000001"
        val sourceId = "30000000-0000-4000-8000-000000000001"
        val assigned = bugs.first().copy(
            projectId = projectId,
            ownerId = sourceId,
            ownerAssignmentProof = WorkbenchAssignmentProof(projectId, actorId, 42),
        )

        assertEquals(
            listOf(assigned.id),
            filterBugs(
                listOf(assigned),
                BugListFilters(ownerId = actorId),
                assignmentSnapshotSequence = 42,
            ).map { it.id },
        )
        assertTrue(
            filterBugs(
                listOf(assigned),
                BugListFilters(ownerId = actorId),
                assignmentSnapshotSequence = 41,
            ).isEmpty(),
        )
        assertTrue(
            filterBugs(
                listOf(
                    assigned.copy(
                        ownerAssignmentProof = WorkbenchAssignmentProof(
                            "10000000-0000-4000-8000-000000000099",
                            actorId,
                            42,
                        ),
                    ),
                ),
                BugListFilters(ownerId = actorId),
                assignmentSnapshotSequence = 42,
            ).isEmpty(),
        )
    }

    @Test
    fun `historical assignment labels and picker aliases require matching authority`() {
        val projectId = "10000000-0000-4000-8000-000000000001"
        val actorId = "20000000-0000-4000-8000-000000000001"
        val ownerSourceId = "30000000-0000-4000-8000-000000000001"
        val verifierSourceId = "30000000-0000-4000-8000-000000000002"
        val people = listOf(
            QaPerson(
                id = actorId,
                displayName = "Canonical teammate",
                roles = setOf(QaPersonRole.FIXER, QaPersonRole.VERIFIER),
                active = true,
            ),
        )
        val assigned = bugs.first().copy(
            projectId = projectId,
            ownerId = ownerSourceId,
            verificationOwnerId = verifierSourceId,
            ownerAssignmentProof = WorkbenchAssignmentProof(projectId, actorId, 42),
            verifierAssignmentProof = WorkbenchAssignmentProof(projectId, actorId, 42),
        )

        assertEquals(
            "Canonical teammate",
            assignmentPersonName(people, assigned, BugAssignment.OWNER, 42, "待分配"),
        )
        assertEquals(
            "Canonical teammate",
            assignmentPersonName(people, assigned, BugAssignment.VERIFIER, 42, "待分配"),
        )
        assertTrue(
            assignmentPersonName(people, assigned, BugAssignment.OWNER, 41, "待分配")
                .startsWith("历史人员 · "),
        )
        val projected = assignmentPeopleForBug(people, assigned, 42)
        assertEquals(
            "Canonical teammate（历史身份）",
            projected.single { it.id == ownerSourceId }.displayName,
        )
        assertEquals(
            "Canonical teammate（历史身份）",
            projected.single { it.id == verifierSourceId }.displayName,
        )
        assertFalse(assignmentPeopleForBug(people, assigned, 41).any { it.id == ownerSourceId })
    }

    private fun bug(
        id: String,
        reporterId: String,
        ownerId: String?,
        state: String,
    ) = WorkbenchBug(
        id = id,
        projectId = "project",
        key = id,
        title = id,
        state = state,
        occurrenceCount = 1,
        updatedAt = "2026-08-27T00:00:00Z",
        reporterId = reporterId,
        ownerId = ownerId,
    )
}
