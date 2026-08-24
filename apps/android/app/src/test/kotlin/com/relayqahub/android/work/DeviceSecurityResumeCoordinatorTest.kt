package com.relayqahub.android.work

import androidx.work.OneTimeWorkRequest
import com.relayqahub.android.data.AccountProjectScope
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceSecurityResumeCoordinatorTest {
    @Test
    fun `foreground unlock path re-enqueues each blocked device scope once`() = runBlocking {
        val controller = RecordingController()
        val coordinator = DeviceSecurityResumeCoordinator(
            blockedScopes = { listOf(SCOPE, SCOPE, OTHER_SCOPE) },
            syncWorkController = controller,
        )

        assertEquals(2, coordinator.resumeBlockedOperations())
        assertEquals(listOf(SCOPE, OTHER_SCOPE), controller.resumed)
    }

    private class RecordingController : SyncWorkController {
        val resumed = mutableListOf<AccountProjectScope>()

        override fun enqueue(scope: AccountProjectScope): OneTimeWorkRequest =
            SyncScheduler.buildRequest(scope)

        override fun enqueueContinuation(
            scope: AccountProjectScope,
            initialDelayMs: Long,
        ): OneTimeWorkRequest = SyncScheduler.buildRequest(scope, initialDelayMs)

        override fun resumeAfterDeviceUnlock(scope: AccountProjectScope): OneTimeWorkRequest {
            resumed += scope
            return SyncScheduler.buildRequest(scope)
        }

        override suspend fun cancel(scope: AccountProjectScope) = Unit
    }

    private companion object {
        val SCOPE = AccountProjectScope(
            "account-1",
            "project-1",
            "actor-1",
            "installation-1",
            "session-1",
        )
        val OTHER_SCOPE = SCOPE.copy(projectId = "project-2")
    }
}
