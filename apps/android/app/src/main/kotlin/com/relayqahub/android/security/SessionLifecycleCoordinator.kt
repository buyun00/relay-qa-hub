package com.relayqahub.android.security

import com.relayqahub.android.data.AccountDataCleaner
import com.relayqahub.android.data.AccountProjectScope
import com.relayqahub.android.work.SyncWorkCanceller

sealed interface SessionExitResult {
    data object Completed : SessionExitResult
    data class Blocked(val reasonCode: String) : SessionExitResult
}

class SessionLifecycleCoordinator(
    private val credentialVault: CredentialVault,
    private val accountDataCleaner: AccountDataCleaner,
    private val syncWorkCanceller: SyncWorkCanceller,
) {
    suspend fun signOut(scope: AccountProjectScope): SessionExitResult {
        runCatching { syncWorkCanceller.cancel(scope) }.getOrElse {
            return SessionExitResult.Blocked("SYNC_CANCELLATION_FAILED")
        }
        when (val deletion = credentialVault.deleteSession(scope.nativeSessionScope())) {
            is VaultResult.Unavailable -> return SessionExitResult.Blocked(deletion.reasonCode)
            VaultResult.Missing,
            is VaultResult.Success,
            -> Unit
        }
        when (val deletion = credentialVault.deleteAccount(scope.accountId)) {
            is VaultResult.Unavailable -> return SessionExitResult.Blocked(deletion.reasonCode)
            VaultResult.Missing,
            is VaultResult.Success,
            -> Unit
        }
        return runCatching {
            accountDataCleaner.clearAccount(scope.accountId)
            SessionExitResult.Completed
        }.getOrElse {
            SessionExitResult.Blocked("LOCAL_ACCOUNT_CLEANUP_FAILED")
        }
    }
}
