package com.relayqahub.android.security

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidKeystoreCredentialVaultTest {
    @Test
    fun encryptedCredentialsSupportSessionAndAccountWideDeletion() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val vault = AndroidKeystoreCredentialVault(context)
        val accountId = "instrumented-${UUID.randomUUID()}"
        val scope = NativeSessionScope(
            accountId = accountId,
            actorId = "actor-${UUID.randomUUID()}",
            installationId = "installation-${UUID.randomUUID()}",
            sessionId = "session-${UUID.randomUUID()}",
        )
        val credentials = NativeCredentials(
            accessToken = "opaque-access-${UUID.randomUUID()}",
            refreshToken = "opaque-refresh-${UUID.randomUUID()}",
            accessTokenExpiresAtEpochMs = System.currentTimeMillis() + 60_000,
            sharedDeviceSession = false,
        )

        assertTrue(vault.support().available)
        assertTrue(vault.put(scope, credentials) is VaultResult.Success)
        assertEquals(credentials, (vault.read(scope) as VaultResult.Success).value)
        assertEquals(
            VaultResult.Missing,
            vault.read(scope.copy(sessionId = "different-session")),
        )
        assertTrue(vault.deleteSession(scope) is VaultResult.Success)
        assertEquals(VaultResult.Missing, vault.read(scope))

        val first = scope.copy(sessionId = "session-${UUID.randomUUID()}")
        val second = scope.copy(
            actorId = "actor-${UUID.randomUUID()}",
            sessionId = "session-${UUID.randomUUID()}",
        )
        val other = nativeScope("other-${UUID.randomUUID()}", "session-${UUID.randomUUID()}")
        vault.put(first, credentials)
        vault.put(second, credentials)
        vault.put(other, credentials)

        assertTrue(vault.deleteAccount(accountId) is VaultResult.Success)

        assertEquals(VaultResult.Missing, vault.read(first))
        assertEquals(VaultResult.Missing, vault.read(second))
        assertEquals(credentials, (vault.read(other) as VaultResult.Success).value)
        vault.deleteAccount(other.accountId)
        Unit
    }

    private fun nativeScope(accountId: String, sessionId: String) = NativeSessionScope(
        accountId = accountId,
        actorId = "actor-${UUID.randomUUID()}",
        installationId = "installation-${UUID.randomUUID()}",
        sessionId = sessionId,
    )
}
