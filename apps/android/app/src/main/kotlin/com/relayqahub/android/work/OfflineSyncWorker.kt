package com.relayqahub.android.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.relayqahub.android.QaHubApplication
import com.relayqahub.android.data.AccountProjectScope

class OfflineSyncWorker(
    appContext: Context,
    workerParameters: WorkerParameters,
) : CoroutineWorker(appContext, workerParameters) {
    override suspend fun doWork(): Result {
        val accountId = inputData.getString(KEY_ACCOUNT_ID)
            ?: return Result.failure(workDataOf(KEY_ERROR_CODE to "MISSING_ACCOUNT_ID"))
        val projectId = inputData.getString(KEY_PROJECT_ID)
            ?: return Result.failure(workDataOf(KEY_ERROR_CODE to "MISSING_PROJECT_ID"))
        val actorId = inputData.getString(KEY_ACTOR_ID)
            ?: return Result.failure(workDataOf(KEY_ERROR_CODE to "MISSING_ACTOR_ID"))
        val installationId = inputData.getString(KEY_INSTALLATION_ID)
            ?: return Result.failure(workDataOf(KEY_ERROR_CODE to "MISSING_INSTALLATION_ID"))
        val sessionId = inputData.getString(KEY_SESSION_ID)
            ?: return Result.failure(workDataOf(KEY_ERROR_CODE to "MISSING_SESSION_ID"))
        val application = applicationContext as? QaHubApplication
            ?: return Result.failure(workDataOf(KEY_ERROR_CODE to "INVALID_APPLICATION"))

        val scope = AccountProjectScope(
            accountId,
            projectId,
            actorId,
            installationId,
            sessionId,
        )
        return when (val result = application.container.syncEngine.run(scope)) {
            is SyncRunResult.ContinueAt -> runCatching {
                application.container.syncScheduler.enqueueContinuation(
                    scope = scope,
                    initialDelayMs = maxOf(
                        0L,
                        result.nextAttemptAtEpochMs - System.currentTimeMillis(),
                    ),
                )
            }.fold(
                onSuccess = {
                    Result.success(
                        workDataOf(
                            KEY_STATUS to "CONTINUATION_SCHEDULED",
                            KEY_PROCESSED_COUNT to result.processedCount,
                        ),
                    )
                },
                onFailure = { Result.retry() },
            )
            is SyncRunResult.Exhausted -> Result.failure(
                workDataOf(
                    KEY_ERROR_CODE to "RETRY_EXHAUSTED",
                    KEY_PROCESSED_COUNT to result.processedCount,
                ),
            )
            is SyncRunResult.BlockedOnAuthentication -> Result.success(
                workDataOf(
                    KEY_STATUS to "BLOCKED_AUTH",
                    KEY_PROCESSED_COUNT to result.processedCount,
                ),
            )
            is SyncRunResult.BlockedOnDeviceSecurity -> Result.success(
                workDataOf(
                    KEY_STATUS to "BLOCKED_DEVICE",
                    KEY_PROCESSED_COUNT to result.processedCount,
                ),
            )
            is SyncRunResult.Completed -> Result.success(
                workDataOf(KEY_PROCESSED_COUNT to result.processedCount),
            )
        }
    }

    companion object {
        const val KEY_ACCOUNT_ID = "account_id"
        const val KEY_PROJECT_ID = "project_id"
        const val KEY_ACTOR_ID = "actor_id"
        const val KEY_INSTALLATION_ID = "installation_id"
        const val KEY_SESSION_ID = "session_id"
        const val KEY_ERROR_CODE = "error_code"
        const val KEY_STATUS = "status"
        const val KEY_PROCESSED_COUNT = "processed_count"
    }
}
