package com.relayqahub.android

import android.content.Context
import com.relayqahub.android.data.AccountProjectScope
import java.util.UUID

/** Identity, selected project and credentials never cross API origins. */
class QaIdentityStore(context: Context, val serviceUrl: String) {
    private val preferences = context.getSharedPreferences(
        "qa-hub-preview-identity-${namespaceId(serviceUrl)}", Context.MODE_PRIVATE,
    )
    fun current(): QaPerson? {
        val actorId = actorIdOrNull() ?: return null
        val name = preferences.getString("name", null)?.takeIf(String::isNotBlank) ?: return null
        return QaPerson(actorId, name, emptySet(), true)
    }
    fun actorIdOrNull(): String? = preferences.getString("actor", null)?.takeIf(String::isNotBlank)
    fun projectId(): String = preferences.getString("project", null) ?: BuildConfig.QA_HUB_PROJECT_ID
    fun projectName(): String = preferences.getString("project_name", null) ?: projectId()
    fun projectKey(): String = preferences.getString("project_key", null) ?: projectId()
    fun scope(): AccountProjectScope = scopedIdentity(
        serviceUrl,
        checkNotNull(preferences.getString("account", null)),
        projectId(), checkNotNull(actorIdOrNull()),
    )
    fun select(accountId: String, userId: String, name: String, projectId: String, projectName: String, projectKey: String): QaPerson {
        listOf(accountId, userId, projectId).forEach { UUID.fromString(it) }
        require(name.isNotBlank())
        check(preferences.edit().putString("account", accountId).putString("actor", userId)
            .putString("name", name).putString("project", projectId)
            .putString("project_name", projectName).putString("project_key", projectKey).commit())
        return QaPerson(userId, name, emptySet(), true)
    }
    fun clear() {
        // Project choice survives logout; no drafts, queue entries or capture files are removed.
        check(preferences.edit().remove("actor").remove("name").remove("account").commit())
    }
}

internal fun namespaceId(value: String): String =
    UUID.nameUUIDFromBytes(value.toByteArray(Charsets.UTF_8)).toString()

internal fun scopedIdentity(serviceUrl: String, accountId: String, projectId: String, actorId: String) =
    AccountProjectScope(accountId, projectId, actorId,
        namespaceId("preview-install:$serviceUrl"),
        namespaceId("preview-session:$serviceUrl:$projectId:$actorId"))

internal fun draftScopeKey(serviceUrl: String, projectId: String, actorId: String): String =
    namespaceId("$serviceUrl\u0000$projectId\u0000$actorId")
