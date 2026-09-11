package com.relayqahub.android.work

import com.relayqahub.android.data.AccountProjectScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import androidx.work.NetworkType
import org.junit.Test

class SyncSchedulerTest {
    @Test
    fun `uploads and continuations never require a healthy battery`() {
        listOf(0L, 30_000L).forEach { delay ->
            val request = SyncScheduler.buildRequest(SCOPE, initialDelayMs = delay)
            assertFalse(request.workSpec.constraints.requiresBatteryNotLow())
            assertFalse(request.workSpec.constraints.requiresCharging())
            assertEquals(NetworkType.CONNECTED, request.workSpec.constraints.requiredNetworkType)
            assertEquals(delay, request.workSpec.initialDelay)
        }
        assertTrue(SyncScheduler.uniqueWorkName(SCOPE).startsWith("qa-hub-offline-sync-v2-"))
    }

    @Test
    fun `work request carries non-PII account and session cancellation tags`() {
        val request = SyncScheduler.buildRequest(SCOPE)

        assertTrue("qa-hub-offline-sync" in request.tags)
        assertTrue(SyncScheduler.accountWorkTag(SCOPE) in request.tags)
        assertTrue(SyncScheduler.sessionWorkTag(SCOPE) in request.tags)
        assertTrue(request.tags.none { SCOPE.accountId in it || SCOPE.sessionId in it })
        assertEquals(
            SCOPE.sessionId,
            request.workSpec.input.getString(OfflineSyncWorker.KEY_SESSION_ID),
        )
    }

    @Test
    fun `account tag spans projects while session tag isolates native sessions`() {
        val otherProject = SCOPE.copy(projectId = "project-2")
        val otherSession = SCOPE.copy(sessionId = "session-2")

        assertEquals(
            SyncScheduler.accountWorkTag(SCOPE),
            SyncScheduler.accountWorkTag(otherProject),
        )
        assertEquals(
            SyncScheduler.sessionWorkTag(SCOPE),
            SyncScheduler.sessionWorkTag(otherProject),
        )
        assertNotEquals(
            SyncScheduler.sessionWorkTag(SCOPE),
            SyncScheduler.sessionWorkTag(otherSession),
        )
        assertNotEquals(
            SyncScheduler.uniqueWorkName(SCOPE),
            SyncScheduler.uniqueWorkName(otherProject),
        )
    }

    private companion object {
        val SCOPE = AccountProjectScope(
            accountId = "account-1",
            projectId = "project-1",
            actorId = "actor-1",
            installationId = "installation-1",
            sessionId = "session-1",
        )
    }
}
