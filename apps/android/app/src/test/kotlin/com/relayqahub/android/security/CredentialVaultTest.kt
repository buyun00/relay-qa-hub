package com.relayqahub.android.security

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class CredentialVaultTest {
    @Test
    fun `fake vault can delete one session without crossing account boundaries`() = runBlocking {
        val vault = FakeCredentialVault()
        val first = credentials("access-a", "refresh-a")
        val second = credentials("access-b", "refresh-b")

        val firstScope = scope("account-a", "actor-a", "session-a")
        val secondScope = scope("account-b", "actor-b", "session-b")
        vault.put(firstScope, first)
        vault.put(secondScope, second)
        vault.deleteSession(firstScope)

        assertSame(VaultResult.Missing, vault.read(firstScope))
        assertEquals(second, (vault.read(secondScope) as VaultResult.Success).value)
    }

    @Test
    fun `fake vault account deletion removes every session for only that account`() = runBlocking {
        val vault = FakeCredentialVault()
        val first = scope("account-a", "actor-a", "session-a")
        val second = scope("account-a", "actor-b", "session-b")
        val otherAccount = scope("account-b", "actor-a", "session-a")
        vault.put(first, credentials("access-a", "refresh-a"))
        vault.put(second, credentials("access-b", "refresh-b"))
        vault.put(otherAccount, credentials("access-c", "refresh-c"))

        assertTrue(vault.deleteAccount("account-a") is VaultResult.Success)

        assertSame(VaultResult.Missing, vault.read(first))
        assertSame(VaultResult.Missing, vault.read(second))
        assertEquals(
            "access-c",
            (vault.read(otherAccount) as VaultResult.Success).value.accessToken,
        )
    }

    @Test
    fun `fake vault reports an explicit unavailable boundary`() = runBlocking {
        val vault = FakeCredentialVault(available = false)

        val result = vault.read(scope("account-a", "actor-a", "session-a"))

        assertEquals("FAKE_UNAVAILABLE", (result as VaultResult.Unavailable).reasonCode)
        assertEquals(false, vault.support().available)
    }

    private fun credentials(access: String, refresh: String) = NativeCredentials(
        accessToken = access,
        refreshToken = refresh,
        accessTokenExpiresAtEpochMs = Long.MAX_VALUE,
        sharedDeviceSession = false,
    )

    private fun scope(account: String, actor: String, session: String) = NativeSessionScope(
        accountId = account,
        actorId = actor,
        installationId = "installation-a",
        sessionId = session,
    )
}
