package com.relayqahub.android.security

import com.relayqahub.android.data.AccountProjectScope

data class NativeSessionScope(
    val accountId: String,
    val actorId: String,
    val installationId: String,
    val sessionId: String,
) {
    init {
        listOf(accountId, actorId, installationId, sessionId).forEach { value ->
            require(value.isNotBlank() && '\u0000' !in value)
        }
    }

    internal fun authenticatedContext(): ByteArray =
        "relay-qa-hub-native-v2\u0000$accountId\u0000$actorId\u0000$installationId\u0000$sessionId"
            .toByteArray(Charsets.UTF_8)
}

fun AccountProjectScope.nativeSessionScope(): NativeSessionScope = NativeSessionScope(
    accountId = accountId,
    actorId = actorId,
    installationId = installationId,
    sessionId = sessionId,
)

data class NativeCredentials(
    val accessToken: String,
    val refreshToken: String,
    val accessTokenExpiresAtEpochMs: Long,
    val sharedDeviceSession: Boolean,
) {
    init {
        require(accessToken.isNotBlank())
        require(refreshToken.isNotBlank())
    }
}

data class CredentialVaultSupport(
    val available: Boolean,
    val provider: String,
    val formatVersion: Int,
    val hardwareBacked: Boolean?,
    val reasonCode: String?,
)

sealed interface VaultResult<out T> {
    data class Success<T>(val value: T) : VaultResult<T>
    data object Missing : VaultResult<Nothing>
    data class Unavailable(val reasonCode: String) : VaultResult<Nothing>
}

interface CredentialVault {
    fun support(): CredentialVaultSupport

    suspend fun put(scope: NativeSessionScope, credentials: NativeCredentials): VaultResult<Unit>

    suspend fun read(scope: NativeSessionScope): VaultResult<NativeCredentials>

    /** Removes exactly one native actor/installation/session credential. */
    suspend fun deleteSession(scope: NativeSessionScope): VaultResult<Unit>

    /** Removes every native session credential associated with an account. */
    suspend fun deleteAccount(accountId: String): VaultResult<Unit>
}

class FakeCredentialVault(
    private val available: Boolean = true,
) : CredentialVault {
    private val entries = linkedMapOf<NativeSessionScope, NativeCredentials>()

    override fun support(): CredentialVaultSupport = CredentialVaultSupport(
        available = available,
        provider = "fake",
        formatVersion = 2,
        hardwareBacked = false,
        reasonCode = if (available) null else "FAKE_UNAVAILABLE",
    )

    override suspend fun put(
        scope: NativeSessionScope,
        credentials: NativeCredentials,
    ): VaultResult<Unit> {
        if (!available) return VaultResult.Unavailable("FAKE_UNAVAILABLE")
        entries[scope] = credentials
        return VaultResult.Success(Unit)
    }

    override suspend fun read(scope: NativeSessionScope): VaultResult<NativeCredentials> {
        if (!available) return VaultResult.Unavailable("FAKE_UNAVAILABLE")
        return entries[scope]
            ?.let { VaultResult.Success(it) }
            ?: VaultResult.Missing
    }

    override suspend fun deleteSession(scope: NativeSessionScope): VaultResult<Unit> {
        if (!available) return VaultResult.Unavailable("FAKE_UNAVAILABLE")
        entries.remove(scope)
        return VaultResult.Success(Unit)
    }

    override suspend fun deleteAccount(accountId: String): VaultResult<Unit> {
        if (!available) return VaultResult.Unavailable("FAKE_UNAVAILABLE")
        entries.keys.removeAll { it.accountId == accountId }
        return VaultResult.Success(Unit)
    }
}
