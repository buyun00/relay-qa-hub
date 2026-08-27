package com.relayqahub.android

import android.content.Context

/** App-private remembered identity created by the backend name-login contract. */
class QaIdentityStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun current(): QaPerson? {
        val actorId = actorIdOrNull() ?: return null
        val displayName = preferences.getString(KEY_DISPLAY_NAME, null)
            ?.trim()
            ?.takeIf(String::isNotEmpty)
            ?: run {
                clear()
                return null
            }
        return QaPerson(actorId, displayName, emptySet(), active = true)
    }

    fun select(userId: String, displayName: String): QaPerson {
        val normalizedName = displayName.trim()
        require(userId.isNotBlank() && normalizedName.isNotEmpty())
        check(
            preferences.edit()
                .putString(KEY_ACTOR_ID, userId)
                .putString(KEY_DISPLAY_NAME, normalizedName)
                .commit(),
        ) { "QA_IDENTITY_PERSIST_FAILED" }
        return QaPerson(userId, normalizedName, emptySet(), active = true)
    }

    fun actorIdOrNull(): String? = preferences.getString(KEY_ACTOR_ID, null)
        ?.trim()
        ?.takeIf(String::isNotEmpty)

    fun clear() {
        check(preferences.edit().clear().commit()) {
            "QA_IDENTITY_CLEAR_FAILED"
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "qa-hub-private-identity"
        const val KEY_ACTOR_ID = "actor_id"
        const val KEY_DISPLAY_NAME = "display_name"
    }
}
