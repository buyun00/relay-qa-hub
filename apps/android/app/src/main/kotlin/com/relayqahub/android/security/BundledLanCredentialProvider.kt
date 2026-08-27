package com.relayqahub.android.security

/**
 * Supplies the single controlled-LAN backend credential bundled into the QA debug APK.
 *
 * This intentionally performs no device credential storage, encryption, PIN/biometric check,
 * or per-user authentication. QA identity is selected separately from qa-people.json, while the
 * same build-scoped backend credential is available to foreground requests and WorkManager retry.
 */
class BundledLanCredentialProvider(
    accessToken: String,
) : CredentialVault {
    private val normalizedAccessToken = accessToken.trim()

    override fun support(): CredentialVaultSupport = CredentialVaultSupport(
        available = normalizedAccessToken.isNotEmpty(),
        provider = "bundled-lan-config",
        formatVersion = 1,
        hardwareBacked = false,
        reasonCode = if (normalizedAccessToken.isEmpty()) {
            "LAN_BACKEND_CONFIG_MISSING"
        } else {
            null
        },
    )

    override suspend fun put(
        scope: NativeSessionScope,
        credentials: NativeCredentials,
    ): VaultResult<Unit> {
        if (normalizedAccessToken.isEmpty()) {
            return VaultResult.Unavailable("LAN_BACKEND_CONFIG_MISSING")
        }
        return if (credentials.accessToken == normalizedAccessToken) {
            VaultResult.Success(Unit)
        } else {
            VaultResult.Unavailable("LAN_BACKEND_CONFIG_MISMATCH")
        }
    }

    override suspend fun read(scope: NativeSessionScope): VaultResult<NativeCredentials> {
        if (normalizedAccessToken.isEmpty()) return VaultResult.Missing
        return VaultResult.Success(
            NativeCredentials(
                accessToken = normalizedAccessToken,
                refreshToken = NO_REFRESH_TOKEN,
                accessTokenExpiresAtEpochMs = Long.MAX_VALUE,
                sharedDeviceSession = false,
            ),
        )
    }

    // The credential belongs to the controlled APK build, not to a person or device session.
    override suspend fun deleteSession(scope: NativeSessionScope): VaultResult<Unit> =
        VaultResult.Success(Unit)

    override suspend fun deleteAccount(accountId: String): VaultResult<Unit> =
        VaultResult.Success(Unit)

    private companion object {
        const val NO_REFRESH_TOKEN = "bundled-lan-config-does-not-refresh"
    }
}
