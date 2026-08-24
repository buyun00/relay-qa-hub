package com.relayqahub.android.security

import com.relayqahub.android.data.AccountDataCleaner
import com.relayqahub.android.data.AccountProjectScope
import com.relayqahub.android.work.SyncWorkCanceller
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionLifecycleCoordinatorTest {
    @Test
    fun `sign out cancels scoped work removes credential and then clears account data`() =
        runBlocking {
            val events = mutableListOf<String>()
            val vault = RecordingVault(events)
            vault.put(SCOPE.nativeSessionScope(), CREDENTIALS)
            val siblingSession = SCOPE.copy(sessionId = "session-2").nativeSessionScope()
            vault.put(siblingSession, CREDENTIALS.copy(accessToken = "sibling-access"))
            val cleaner = RecordingCleaner(events)
            val coordinator = SessionLifecycleCoordinator(
                credentialVault = vault,
                accountDataCleaner = cleaner,
                syncWorkCanceller = RecordingCanceller(events),
            )

            assertSame(SessionExitResult.Completed, coordinator.signOut(SCOPE))

            assertEquals(listOf("cancel", "delete-session", "delete-account", "clear"), events)
            assertTrue(cleaner.cleared)
            assertSame(VaultResult.Missing, vault.read(SCOPE.nativeSessionScope()))
            assertSame(VaultResult.Missing, vault.read(siblingSession))
        }

    @Test
    fun `vault failure leaves local account fail closed after work cancellation`() = runBlocking {
        val events = mutableListOf<String>()
        val cleaner = RecordingCleaner(events)
        val coordinator = SessionLifecycleCoordinator(
            credentialVault = FakeCredentialVault(available = false),
            accountDataCleaner = cleaner,
            syncWorkCanceller = RecordingCanceller(events),
        )

        val result = coordinator.signOut(SCOPE)

        assertEquals("FAKE_UNAVAILABLE", (result as SessionExitResult.Blocked).reasonCode)
        assertEquals(listOf("cancel"), events)
        assertFalse(cleaner.cleared)
    }

    private class RecordingCanceller(
        private val events: MutableList<String>,
    ) : SyncWorkCanceller {
        override suspend fun cancel(scope: AccountProjectScope) {
            assertEquals(SCOPE, scope)
            events += "cancel"
        }
    }

    private class RecordingCleaner(
        private val events: MutableList<String>,
    ) : AccountDataCleaner {
        var cleared = false

        override suspend fun clearAccount(accountId: String) {
            assertEquals(SCOPE.accountId, accountId)
            events += "clear"
            cleared = true
        }
    }

    private class RecordingVault(
        private val events: MutableList<String>,
    ) : CredentialVault {
        private val delegate = FakeCredentialVault()

        override fun support(): CredentialVaultSupport = delegate.support()

        override suspend fun put(
            scope: NativeSessionScope,
            credentials: NativeCredentials,
        ): VaultResult<Unit> = delegate.put(scope, credentials)

        override suspend fun read(scope: NativeSessionScope): VaultResult<NativeCredentials> =
            delegate.read(scope)

        override suspend fun deleteSession(scope: NativeSessionScope): VaultResult<Unit> {
            events += "delete-session"
            return delegate.deleteSession(scope)
        }

        override suspend fun deleteAccount(accountId: String): VaultResult<Unit> {
            events += "delete-account"
            return delegate.deleteAccount(accountId)
        }
    }

    companion object {
        private val SCOPE = AccountProjectScope(
            "account-1",
            "project-1",
            "actor-1",
            "installation-1",
            "session-1",
        )
        private val CREDENTIALS = NativeCredentials(
            "access",
            "refresh",
            Long.MAX_VALUE,
            false,
        )
    }
}
