package com.relayqahub.android

import android.content.Context

/** App-private selected QA identity. The canonical identity still comes from qa-people.json. */
class QaIdentityStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun current(config: QaPeopleConfig): QaPerson? {
        val actorId = actorIdOrNull() ?: return null
        return config.people.singleOrNull { it.active && it.id == actorId }
            ?: run {
                clear()
                null
            }
    }

    fun selectByPinyin(config: QaPeopleConfig, input: String): QaPerson? {
        val normalized = input.trim().lowercase()
        val person = config.people.singleOrNull { it.active && it.pinyin == normalized }
            ?: return null
        check(
            preferences.edit()
                .putString(KEY_ACTOR_ID, person.id)
                .commit(),
        ) { "QA_IDENTITY_PERSIST_FAILED" }
        return person
    }

    fun actorIdOrNull(): String? = preferences.getString(KEY_ACTOR_ID, null)
        ?.trim()
        ?.takeIf(String::isNotEmpty)

    fun clear() {
        check(preferences.edit().remove(KEY_ACTOR_ID).commit()) {
            "QA_IDENTITY_CLEAR_FAILED"
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "qa-hub-private-identity"
        const val KEY_ACTOR_ID = "actor_id"
    }
}
