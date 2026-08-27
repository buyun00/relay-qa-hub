package com.relayqahub.android.ui

import com.relayqahub.android.network.WorkbenchBug
import org.junit.Assert.assertEquals
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
            BugStatusFilter.IN_PROGRESS to listOf("in-progress", "awaiting-build"),
            BugStatusFilter.VERIFICATION to listOf("verification"),
            BugStatusFilter.COMPLETED to listOf("closed"),
            BugStatusFilter.OTHER to listOf("deferred", "rejected", "duplicate"),
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
