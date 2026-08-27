package com.relayqahub.android.security

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class BundledLanCredentialProviderTest {
    @Test
    fun `bundled LAN credential is available without device storage`() = runBlocking {
        val provider = BundledLanCredentialProvider("  controlled-lan-token  ")

        assertTrue(provider.support().available)
        assertEquals("bundled-lan-config", provider.support().provider)
        assertFalse(provider.support().hardwareBacked ?: true)

        val credentials = provider.read(scope) as VaultResult.Success
        assertEquals("controlled-lan-token", credentials.value.accessToken)
        assertEquals(Long.MAX_VALUE, credentials.value.accessTokenExpiresAtEpochMs)
        assertTrue(provider.deleteSession(scope) is VaultResult.Success)
        assertTrue(provider.deleteAccount(scope.accountId) is VaultResult.Success)
        assertEquals(
            "controlled-lan-token",
            (provider.read(scope) as VaultResult.Success).value.accessToken,
        )
    }

    @Test
    fun `missing build credential stays explicit and never falls back to local storage`() =
        runBlocking {
            val provider = BundledLanCredentialProvider("  ")

            assertFalse(provider.support().available)
            assertEquals("LAN_BACKEND_CONFIG_MISSING", provider.support().reasonCode)
            assertSame(VaultResult.Missing, provider.read(scope))
        }

    @Test
    fun `foreground write contract only accepts the bundled LAN credential`() = runBlocking {
        val provider = BundledLanCredentialProvider("controlled-lan-token")

        val accepted = provider.put(scope, credentials("controlled-lan-token"))
        val rejected = provider.put(scope, credentials("different-token"))

        assertTrue(accepted is VaultResult.Success)
        assertEquals(
            "LAN_BACKEND_CONFIG_MISMATCH",
            (rejected as VaultResult.Unavailable).reasonCode,
        )
    }

    private fun credentials(accessToken: String) = NativeCredentials(
        accessToken = accessToken,
        refreshToken = "unused",
        accessTokenExpiresAtEpochMs = Long.MAX_VALUE,
        sharedDeviceSession = false,
    )

    private val scope = NativeSessionScope(
        accountId = "account-a",
        actorId = "actor-a",
        installationId = "installation-a",
        sessionId = "session-a",
    )
}
