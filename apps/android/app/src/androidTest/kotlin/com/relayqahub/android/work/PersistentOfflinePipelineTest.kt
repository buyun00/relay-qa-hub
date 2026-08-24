package com.relayqahub.android.work

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.ListenableWorker
import androidx.work.WorkManager
import androidx.work.testing.TestListenableWorkerBuilder
import com.relayqahub.android.QaHubApplication
import com.relayqahub.android.data.AccountProjectScope
import com.relayqahub.android.data.NewOfflineOperation
import com.relayqahub.android.data.QueueState
import com.relayqahub.android.security.NativeCredentials
import com.relayqahub.android.security.SessionExitResult
import com.relayqahub.android.security.VaultResult
import com.relayqahub.android.security.nativeSessionScope
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PersistentOfflinePipelineTest {
    @Test
    fun realWorkerBatchesPersistentRoomAndLogoutClearsWorkRoomAndKeystore() = runBlocking {
        val application = ApplicationProvider.getApplicationContext<QaHubApplication>()
        val container = application.container
        val suffix = UUID.randomUUID().toString()
        val scope = scope(suffix, project = "primary", session = "primary")
        val siblingScope = scope(suffix, project = "sibling", session = "sibling")
        val credentials = NativeCredentials(
            accessToken = "access-$suffix",
            refreshToken = "refresh-$suffix",
            accessTokenExpiresAtEpochMs = 1,
            sharedDeviceSession = false,
        )

        container.scopedRepository.seedFoundationScope(scope)
        container.scopedRepository.seedFoundationScope(siblingScope)
        assertTrue(
            container.credentialVault.put(scope.nativeSessionScope(), credentials) is
                VaultResult.Success,
        )
        assertTrue(
            container.credentialVault.put(
                siblingScope.nativeSessionScope(),
                credentials.copy(accessToken = "sibling-access-$suffix"),
            ) is VaultResult.Success,
        )

        repeat(OfflineSyncEngine.BATCH_SIZE + 1) { index ->
            val submissionId = UUID.randomUUID().toString()
            container.scopedRepository.enqueue(
                scope,
                NewOfflineOperation(
                    operationKind = "CREATE_BUG",
                    httpMethod = "POST",
                    relativePath = "/bugs",
                    payloadJson =
                        "{\"projectId\":\"${scope.projectId}\"," +
                        "\"clientSubmissionId\":\"$submissionId\"," +
                        "\"sequence\":$index}",
                    idempotencyKey = "submission:$submissionId:commit",
                ),
            )
        }
        container.scopedRepository.enqueue(
            siblingScope,
            NewOfflineOperation(
                operationKind = "CREATE_BUG",
                httpMethod = "POST",
                relativePath = "/bugs",
                payloadJson = "{}",
                idempotencyKey = "submission:${UUID.randomUUID()}:commit",
            ),
        )

        val workerRequest = SyncScheduler.buildRequest(scope)
        assertEquals(scope.accountId, workerRequest.workSpec.input.getString(OfflineSyncWorker.KEY_ACCOUNT_ID))
        assertEquals(scope.projectId, workerRequest.workSpec.input.getString(OfflineSyncWorker.KEY_PROJECT_ID))
        assertEquals(scope.actorId, workerRequest.workSpec.input.getString(OfflineSyncWorker.KEY_ACTOR_ID))
        assertEquals(
            scope.installationId,
            workerRequest.workSpec.input.getString(OfflineSyncWorker.KEY_INSTALLATION_ID),
        )
        assertEquals(scope.sessionId, workerRequest.workSpec.input.getString(OfflineSyncWorker.KEY_SESSION_ID))

        val worker = TestListenableWorkerBuilder<OfflineSyncWorker>(application)
            .setInputData(workerRequest.workSpec.input)
            .build()
        assertEquals(
            ListenableWorker.Result.success(
                androidx.work.workDataOf(
                    OfflineSyncWorker.KEY_STATUS to "BLOCKED_AUTH",
                    OfflineSyncWorker.KEY_PROCESSED_COUNT to OfflineSyncEngine.BATCH_SIZE,
                ),
            ),
            worker.doWork(),
        )

        val persisted = container.database.offlineOperationDao().listForScope(
            scope.accountId,
            scope.projectId,
            scope.actorId,
            scope.installationId,
            scope.sessionId,
        )
        assertEquals(OfflineSyncEngine.BATCH_SIZE + 1, persisted.size)
        assertEquals(
            OfflineSyncEngine.BATCH_SIZE,
            persisted.count { it.state == QueueState.BLOCKED_AUTH },
        )
        assertEquals(1, persisted.count { it.state == QueueState.PENDING })
        persisted.forEach { operation ->
            assertEquals(scope.accountId, operation.accountId)
            assertEquals(scope.projectId, operation.projectId)
            assertEquals(scope.actorId, operation.actorId)
            assertEquals(scope.installationId, operation.installationId)
            assertEquals(scope.sessionId, operation.sessionId)
        }

        val primaryWork = container.syncScheduler.enqueueContinuation(scope, ONE_DAY_MS)
        val siblingWork = container.syncScheduler.enqueueContinuation(siblingScope, ONE_DAY_MS)
        assertSame(SessionExitResult.Completed, container.sessionLifecycle.signOut(scope))

        assertSame(VaultResult.Missing, container.credentialVault.read(scope.nativeSessionScope()))
        assertSame(
            VaultResult.Missing,
            container.credentialVault.read(siblingScope.nativeSessionScope()),
        )
        assertTrue(
            container.database.offlineOperationDao().listForScope(
                scope.accountId,
                scope.projectId,
                scope.actorId,
                scope.installationId,
                scope.sessionId,
            ).isEmpty(),
        )
        assertTrue(
            container.database.offlineOperationDao().listForScope(
                siblingScope.accountId,
                siblingScope.projectId,
                siblingScope.actorId,
                siblingScope.installationId,
                siblingScope.sessionId,
            ).isEmpty(),
        )
        val workManager = WorkManager.getInstance(application as Context)
        assertTrue(checkNotNull(workManager.getWorkInfoById(primaryWork.id).get()).state.isFinished)
        assertTrue(checkNotNull(workManager.getWorkInfoById(siblingWork.id).get()).state.isFinished)
    }

    private fun scope(
        suffix: String,
        project: String,
        session: String,
    ) = AccountProjectScope(
        accountId = "account-$suffix",
        projectId = "project-$project-$suffix",
        actorId = "actor-$session-$suffix",
        installationId = "installation-$suffix",
        sessionId = "session-$session-$suffix",
    )

    private companion object {
        const val ONE_DAY_MS = 24 * 60 * 60 * 1000L
    }
}
