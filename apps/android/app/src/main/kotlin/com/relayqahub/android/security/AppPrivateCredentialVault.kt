package com.relayqahub.android.security

import android.content.Context

/**
 * Persists backend-issued per-account sessions in app-private preferences.
 *
 * QA Hub is an internal LAN app and does not require a device PIN, biometric prompt,
 * or Android Keystore enrollment. Credentials never ship in the APK and are created
 * only after the backend accepts a name login.
 */
class AppPrivateCredentialVault(context: Context) : CredentialVault {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    override fun support(): CredentialVaultSupport = CredentialVaultSupport(
        available = true,
        provider = "app-private-session",
        formatVersion = 1,
        hardwareBacked = false,
        reasonCode = null,
    )

    override suspend fun put(
        scope: NativeSessionScope,
        credentials: NativeCredentials,
    ): VaultResult<Unit> {
        val prefix = scope.keyPrefix()
        val committed = preferences.edit()
            .putString(prefix + KEY_ACCESS_TOKEN, credentials.accessToken)
            .putString(prefix + KEY_REFRESH_TOKEN, credentials.refreshToken)
            .putLong(prefix + KEY_EXPIRES_AT, credentials.accessTokenExpiresAtEpochMs)
            .putBoolean(prefix + KEY_SHARED_DEVICE, credentials.sharedDeviceSession)
            .commit()
        return if (committed) VaultResult.Success(Unit) else VaultResult.Unavailable("SESSION_PERSIST_FAILED")
    }

    override suspend fun read(scope: NativeSessionScope): VaultResult<NativeCredentials> {
        val prefix = scope.keyPrefix()
        val accessToken = preferences.getString(prefix + KEY_ACCESS_TOKEN, null)
            ?.takeIf(String::isNotBlank)
            ?: return VaultResult.Missing
        val refreshToken = preferences.getString(prefix + KEY_REFRESH_TOKEN, null)
            ?.takeIf(String::isNotBlank)
            ?: return VaultResult.Missing
        return VaultResult.Success(
            NativeCredentials(
                accessToken = accessToken,
                refreshToken = refreshToken,
                accessTokenExpiresAtEpochMs = preferences.getLong(prefix + KEY_EXPIRES_AT, Long.MAX_VALUE),
                sharedDeviceSession = preferences.getBoolean(prefix + KEY_SHARED_DEVICE, false),
            ),
        )
    }

    override suspend fun deleteSession(scope: NativeSessionScope): VaultResult<Unit> {
        val prefix = scope.keyPrefix()
        val editor = preferences.edit()
        preferences.all.keys.filter { it.startsWith(prefix) }.forEach(editor::remove)
        return if (editor.commit()) VaultResult.Success(Unit) else VaultResult.Unavailable("SESSION_DELETE_FAILED")
    }

    override suspend fun deleteAccount(accountId: String): VaultResult<Unit> {
        val accountPrefix = "$KEY_PREFIX$accountId:"
        val editor = preferences.edit()
        preferences.all.keys.filter { it.startsWith(accountPrefix) }.forEach(editor::remove)
        return if (editor.commit()) VaultResult.Success(Unit) else VaultResult.Unavailable("ACCOUNT_SESSION_DELETE_FAILED")
    }

    private fun NativeSessionScope.keyPrefix(): String =
        "$KEY_PREFIX$accountId:$actorId:$installationId:$sessionId:"

    private companion object {
        const val PREFERENCES_NAME = "qa-hub-preview-account-sessions-v1"
        const val KEY_PREFIX = "session:"
        const val KEY_ACCESS_TOKEN = "access_token"
        const val KEY_REFRESH_TOKEN = "refresh_token"
        const val KEY_EXPIRES_AT = "expires_at"
        const val KEY_SHARED_DEVICE = "shared_device"
    }
}
