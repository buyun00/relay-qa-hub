package com.relayqahub.android

import android.content.Context
import org.json.JSONObject

data class SavedBugDraft(val content: String = "", val fixerId: String = "", val verifierId: String = "")

/** Keeps unsent text and choices through project changes, logout and app restart. */
class BugDraftPreferences(context: Context) {
    private val preferences = context.getSharedPreferences("qa-hub-preview-drafts-v2", Context.MODE_PRIVATE)
    fun read(scopeKey: String): SavedBugDraft = runCatching {
        val value = JSONObject(preferences.getString("draft:$scopeKey", "{}").orEmpty())
        SavedBugDraft(value.optString("content"), value.optString("fixerId"), value.optString("verifierId"))
    }.getOrDefault(SavedBugDraft())
    fun save(scopeKey: String, draft: SavedBugDraft) {
        require(scopeKey.isNotBlank())
        check(preferences.edit().putString("draft:$scopeKey", JSONObject()
            .put("content", draft.content).put("fixerId", draft.fixerId)
            .put("verifierId", draft.verifierId).toString()).commit())
    }
    fun clear(scopeKey: String) { check(preferences.edit().remove("draft:$scopeKey").commit()) }
    fun lastFixerId(scopeKey: String): String? = preferences.getString("fixer:$scopeKey", null)
    fun recordLastFixer(scopeKey: String, fixerId: String) {
        check(preferences.edit().putString("fixer:$scopeKey", fixerId).commit())
    }
}
