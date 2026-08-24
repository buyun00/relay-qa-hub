package com.relayqahub.android.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class AndroidKeystoreCredentialVault(
    context: Context,
) : CredentialVault {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    override fun support(): CredentialVaultSupport = try {
        keyStore()
        ensureCurrentStore()
        CredentialVaultSupport(
            available = true,
            provider = KEYSTORE_PROVIDER,
            formatVersion = FORMAT_VERSION,
            hardwareBacked = null,
            reasonCode = null,
        )
    } catch (_: Exception) {
        CredentialVaultSupport(
            available = false,
            provider = KEYSTORE_PROVIDER,
            formatVersion = FORMAT_VERSION,
            hardwareBacked = null,
            reasonCode = "ANDROID_KEYSTORE_UNAVAILABLE",
        )
    }

    override suspend fun put(
        scope: NativeSessionScope,
        credentials: NativeCredentials,
    ): VaultResult<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            cipher.updateAAD(scope.authenticatedContext())
            val encrypted = cipher.doFinal(encode(credentials))
            val encoded = listOf(
                FORMAT_PREFIX,
                cipher.iv.toBase64(),
                encrypted.toBase64(),
            ).joinToString(".")
            synchronized(storeLock) {
                ensureCurrentStoreLocked()
                val indexKey = accountIndexKey(scope.accountId)
                val indexedEntries = preferences.getStringSet(indexKey, emptySet())
                    .orEmpty()
                    .toMutableSet()
                    .apply { add(preferenceKey(scope)) }
                check(
                    preferences.edit()
                        .putString(preferenceKey(scope), encoded)
                        .putStringSet(indexKey, indexedEntries)
                        .commit(),
                )
            }
        }.fold(
            onSuccess = { VaultResult.Success(Unit) },
            onFailure = { VaultResult.Unavailable("CREDENTIAL_WRITE_FAILED") },
        )
    }

    override suspend fun read(scope: NativeSessionScope): VaultResult<NativeCredentials> =
        withContext(Dispatchers.IO) {
            runCatching {
                ensureCurrentStore()
                val encoded = preferences.getString(preferenceKey(scope), null)
                    ?: return@runCatching null
                val parts = encoded.split('.')
                require(parts.size == 3 && parts[0] == FORMAT_PREFIX)
                val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
                cipher.init(
                    Cipher.DECRYPT_MODE,
                    getExistingKey(),
                    GCMParameterSpec(GCM_TAG_BITS, parts[1].fromBase64()),
                )
                cipher.updateAAD(scope.authenticatedContext())
                decode(cipher.doFinal(parts[2].fromBase64()))
            }.fold(
                onSuccess = { credentials ->
                    credentials?.let { VaultResult.Success(it) } ?: VaultResult.Missing
                },
                onFailure = { VaultResult.Unavailable("CREDENTIAL_READ_FAILED") },
            )
        }

    override suspend fun deleteSession(scope: NativeSessionScope): VaultResult<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                synchronized(storeLock) {
                    ensureCurrentStoreLocked()
                    val entryKey = preferenceKey(scope)
                    val indexKey = accountIndexKey(scope.accountId)
                    val indexedEntries = preferences.getStringSet(indexKey, emptySet())
                        .orEmpty()
                        .toMutableSet()
                        .apply { remove(entryKey) }
                    val editor = preferences.edit().remove(entryKey)
                    if (indexedEntries.isEmpty()) {
                        editor.remove(indexKey)
                    } else {
                        editor.putStringSet(indexKey, indexedEntries)
                    }
                    check(editor.commit())
                }
            }.fold(
                onSuccess = { VaultResult.Success(Unit) },
                onFailure = { VaultResult.Unavailable("CREDENTIAL_DELETE_FAILED") },
            )
        }

    override suspend fun deleteAccount(accountId: String): VaultResult<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                require(accountId.isNotBlank() && '\u0000' !in accountId)
                synchronized(storeLock) {
                    ensureCurrentStoreLocked()
                    val indexKey = accountIndexKey(accountId)
                    val editor = preferences.edit()
                    preferences.getStringSet(indexKey, emptySet())
                        .orEmpty()
                        .forEach(editor::remove)
                    check(editor.remove(indexKey).commit())
                }
            }.fold(
                onSuccess = { VaultResult.Success(Unit) },
                onFailure = { VaultResult.Unavailable("CREDENTIAL_ACCOUNT_DELETE_FAILED") },
            )
        }

    private fun getOrCreateKey(): SecretKey {
        val existing = keyStore().getKey(KEY_ALIAS, null) as? SecretKey
        if (existing != null) return existing

        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER).run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setUnlockedDeviceRequired(true)
                    .build(),
            )
            generateKey()
        }
    }

    private fun getExistingKey(): SecretKey =
        keyStore().getKey(KEY_ALIAS, null) as? SecretKey
            ?: error("Credential key is missing")

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply {
        load(null)
    }

    private fun preferenceKey(scope: NativeSessionScope): String {
        return ENTRY_KEY_PREFIX + MessageDigest.getInstance("SHA-256")
            .digest(scope.authenticatedContext())
            .toBase64()
    }

    private fun accountIndexKey(accountId: String): String =
        ACCOUNT_INDEX_KEY_PREFIX + MessageDigest.getInstance("SHA-256")
            .digest("relay-qa-hub-account\u0000$accountId".toByteArray(Charsets.UTF_8))
            .toBase64()

    private fun ensureCurrentStore() {
        synchronized(storeLock) { ensureCurrentStoreLocked() }
    }

    /**
     * The v2 store had no account index, so an account-wide logout could not prove deletion of
     * every session. Fail closed on upgrade by invalidating those foundation credentials once.
     */
    private fun ensureCurrentStoreLocked() {
        if (preferences.getInt(STORE_SCHEMA_KEY, 0) == STORE_SCHEMA_VERSION) return
        check(
            preferences.edit()
                .clear()
                .putInt(STORE_SCHEMA_KEY, STORE_SCHEMA_VERSION)
                .commit(),
        )
    }

    private fun encode(credentials: NativeCredentials): ByteArray =
        ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeInt(FORMAT_VERSION)
                output.writeUTF(credentials.accessToken)
                output.writeUTF(credentials.refreshToken)
                output.writeLong(credentials.accessTokenExpiresAtEpochMs)
                output.writeBoolean(credentials.sharedDeviceSession)
            }
            bytes.toByteArray()
        }

    private fun decode(bytes: ByteArray): NativeCredentials =
        DataInputStream(ByteArrayInputStream(bytes)).use { input ->
            require(input.readInt() == FORMAT_VERSION)
            NativeCredentials(
                accessToken = input.readUTF(),
                refreshToken = input.readUTF(),
                accessTokenExpiresAtEpochMs = input.readLong(),
                sharedDeviceSession = input.readBoolean(),
            )
        }

    private fun ByteArray.toBase64(): String =
        Base64.encodeToString(this, Base64.NO_WRAP or Base64.URL_SAFE)

    private fun String.fromBase64(): ByteArray =
        Base64.decode(this, Base64.NO_WRAP or Base64.URL_SAFE)

    companion object {
        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        private const val CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_BITS = 128
        private const val FORMAT_VERSION = 3
        private const val FORMAT_PREFIX = "v3"
        private const val KEY_ALIAS = "relay.qa.hub.native.credentials.v3"
        private const val PREFERENCES_NAME = "qa_hub_credentials_v2"
        private const val STORE_SCHEMA_KEY = "__vault_store_schema"
        private const val STORE_SCHEMA_VERSION = 3
        private const val ENTRY_KEY_PREFIX = "credential:"
        private const val ACCOUNT_INDEX_KEY_PREFIX = "account-index:"
    }

    private val storeLock = Any()
}
