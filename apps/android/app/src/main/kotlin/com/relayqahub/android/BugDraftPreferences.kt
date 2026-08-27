package com.relayqahub.android

import android.content.Context
import java.util.UUID

/** Per-identity conveniences for repeated field submissions; never stores credentials. */
class BugDraftPreferences(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun lastFixerId(actorId: String): String? = preferences
        .getString(key(actorId), null)
        ?.takeIf(::isUuid)

    fun recordLastFixer(actorId: String, fixerId: String) {
        require(isUuid(actorId)) { "actorId must be a UUID" }
        require(isUuid(fixerId)) { "fixerId must be a UUID" }
        check(preferences.edit().putString(key(actorId), fixerId).commit()) {
            "BUG_DRAFT_DEFAULT_PERSIST_FAILED"
        }
    }

    private fun key(actorId: String): String {
        require(isUuid(actorId)) { "actorId must be a UUID" }
        return "$LAST_FIXER_PREFIX$actorId"
    }

    private fun isUuid(value: String): Boolean =
        runCatching { UUID.fromString(value) }.isSuccess

    private companion object {
        const val PREFERENCES_NAME = "qa-hub-bug-draft-defaults-v1"
        const val LAST_FIXER_PREFIX = "last_fixer:"
    }
}
