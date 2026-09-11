package com.relayqahub.android.work

import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import com.relayqahub.android.data.AccountProjectScope
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

interface SyncWorkCanceller {
    /** Cancels and waits for every queued/running work item sharing this account or session. */
    suspend fun cancel(scope: AccountProjectScope)
}

interface SyncWorkController : SyncWorkCanceller {
    fun enqueue(scope: AccountProjectScope): OneTimeWorkRequest

    fun enqueueContinuation(
        scope: AccountProjectScope,
        initialDelayMs: Long,
    ): OneTimeWorkRequest

    /** Explicit foreground/unlock hook for BLOCKED_DEVICE operations. */
    fun resumeAfterDeviceUnlock(scope: AccountProjectScope): OneTimeWorkRequest
}

class SyncScheduler(
    private val workManager: WorkManager,
) : SyncWorkController {
    override fun enqueue(scope: AccountProjectScope): OneTimeWorkRequest {
        val request = buildRequest(scope, initialDelayMs = 0)
        workManager.enqueueUniqueWork(
            uniqueWorkName(scope),
            ExistingWorkPolicy.KEEP,
            request,
        )
        return request
    }

    override fun enqueueContinuation(
        scope: AccountProjectScope,
        initialDelayMs: Long,
    ): OneTimeWorkRequest {
        require(initialDelayMs >= 0)
        val request = buildRequest(scope, initialDelayMs)
        workManager.enqueueUniqueWork(
            uniqueWorkName(scope),
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            request,
        )
        return request
    }

    override fun resumeAfterDeviceUnlock(scope: AccountProjectScope): OneTimeWorkRequest =
        enqueueContinuation(scope, initialDelayMs = 0)

    override suspend fun cancel(scope: AccountProjectScope) {
        withContext(Dispatchers.IO) {
            val cancellationTags = listOf(accountWorkTag(scope), sessionWorkTag(scope))
            val cancellations = buildList {
                // Also catches a pre-tag work item created by the earlier foundation build.
                add(workManager.cancelUniqueWork(uniqueWorkName(scope)))
                addAll(
                    cancellationTags
                        .map(workManager::cancelAllWorkByTag),
                )
            }
            cancellations.forEach { operation -> operation.result.get() }
            check(
                workManager.getWorkInfosForUniqueWork(uniqueWorkName(scope)).get()
                    .all { it.state.isFinished },
            ) { "Scoped sync cancellation did not reach a terminal state" }
            cancellationTags.forEach { tag ->
                check(workManager.getWorkInfosByTag(tag).get().all { it.state.isFinished }) {
                    "Account/session sync cancellation did not reach a terminal state"
                }
            }
        }
    }

    companion object {
        fun buildRequest(
            scope: AccountProjectScope,
            initialDelayMs: Long = 0,
        ): OneTimeWorkRequest {
            require(initialDelayMs >= 0)
            return OneTimeWorkRequestBuilder<OfflineSyncWorker>()
                .setInputData(
                    workDataOf(
                        OfflineSyncWorker.KEY_ACCOUNT_ID to scope.accountId,
                        OfflineSyncWorker.KEY_PROJECT_ID to scope.projectId,
                        OfflineSyncWorker.KEY_ACTOR_ID to scope.actorId,
                        OfflineSyncWorker.KEY_INSTALLATION_ID to scope.installationId,
                        OfflineSyncWorker.KEY_SESSION_ID to scope.sessionId,
                    ),
                )
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    OfflineSyncEngine.INITIAL_RETRY_DELAY_MS,
                    TimeUnit.MILLISECONDS,
                )
                .setInitialDelay(initialDelayMs, TimeUnit.MILLISECONDS)
                .addTag(ROOT_WORK_TAG)
                .addTag(accountWorkTag(scope))
                .addTag(sessionWorkTag(scope))
                .build()
        }

        fun uniqueWorkName(scope: AccountProjectScope): String {
            // A fresh name also bypasses battery-constrained work persisted by older APKs.
            // The Room transaction still arbitrates claims across old/new workers.
            return "qa-hub-offline-sync-v2-${digest(scopeIdentity(scope, includeProject = true))}"
        }

        fun accountWorkTag(scope: AccountProjectScope): String =
            "qa-hub-account-${digest(scope.accountId)}"

        fun sessionWorkTag(scope: AccountProjectScope): String =
            "qa-hub-session-${digest(scopeIdentity(scope, includeProject = false))}"

        private fun scopeIdentity(
            scope: AccountProjectScope,
            includeProject: Boolean,
        ): String = buildList {
            add(scope.accountId)
            if (includeProject) add(scope.projectId)
            add(scope.actorId)
            add(scope.installationId)
            add(scope.sessionId)
        }.joinToString("\u0000")

        private fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte ->
                String.format(Locale.ROOT, "%02x", byte.toInt() and 0xff)
            }

        private const val ROOT_WORK_TAG = "qa-hub-offline-sync"
    }
}
