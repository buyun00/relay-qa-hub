package com.relayqahub.android.network

import java.util.UUID
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

data class QaProject(val id: String, val key: String, val name: String)
data class ProjectComponent(val key: String, val displayName: String, val enabled: Boolean, val status: String, val version: Long)
data class ManagedPerson(val id: String, val name: String, val active: Boolean, val linkedToId: String?, val linkedToName: String?, val protected: Boolean, val membershipVersion: Long)

/** Every mutation uses an immutable project path and its own bearer token. */
class ProjectOperationsClient(baseUrl: String, private val client: OkHttpClient) {
    private val base = QaHubApiEndpoint.parse(baseUrl, allowPrivateHttp = true)
    suspend fun entry(projectId: String): QaProject = project(request("project-entry/${uuid(projectId)}"))
    suspend fun projects(token: String): List<QaProject> {
        val projects = mutableListOf<QaProject>()
        val ids = mutableSetOf<String>()
        val seenCursors = mutableSetOf<String>()
        var cursor: String? = null
        var snapshotSequence: Long? = null
        repeat(MAX_DIRECTORY_PAGES) {
            val cursorQuery = cursor?.let {
                "&cursor=${URLEncoder.encode(it, StandardCharsets.UTF_8.name()).replace("+", "%20")}"
            }.orEmpty()
            val root = request("projects?limit=100$cursorQuery", token)
            check(root.keys().asSequence().toSet() == PROJECT_LIST_FIELDS) {
                "INVALID_PROJECT_LIST_RESPONSE"
            }
            val pageSequence = root.strictDirectorySequence()
            if (snapshotSequence == null) snapshotSequence = pageSequence
            check(snapshotSequence == pageSequence) { "PROJECT_LIST_SNAPSHOT_CHANGED" }
            val items = root.getJSONArray("items")
            check(items.length() <= 100) { "INVALID_PROJECT_LIST_RESPONSE" }
            for (index in 0 until items.length()) {
                val item = items.optJSONObject(index) ?: error("INVALID_PROJECT_LIST_RESPONSE")
                check(item.keys().asSequence().toSet() == PROJECT_ITEM_FIELDS) {
                    "INVALID_PROJECT_LIST_RESPONSE"
                }
                check(item.get("active") is Boolean && item.getBoolean("active")) {
                    "INVALID_PROJECT_LIST_RESPONSE"
                }
                val roles = item.getJSONArray("roles")
                val seenRoles = mutableSetOf<String>()
                check(roles.length() > 0) { "INVALID_PROJECT_LIST_RESPONSE" }
                for (roleIndex in 0 until roles.length()) {
                    val role = roles.get(roleIndex)
                    check(role is String && role in DIRECTORY_ROLES && seenRoles.add(role)) {
                        "INVALID_PROJECT_LIST_RESPONSE"
                    }
                }
                val parsed = QaProject(
                    uuid(item.strictString("id")),
                    item.strictString("key").also { value ->
                        check(PROJECT_KEY_PATTERN.matches(value)) { "INVALID_PROJECT_LIST_RESPONSE" }
                    },
                    item.strictString("name").also { value ->
                        check(value.isNotBlank() && value.length <= 200) {
                            "INVALID_PROJECT_LIST_RESPONSE"
                        }
                    },
                )
                check(ids.add(parsed.id)) { "PROJECT_LIST_ITEM_REPEATED" }
                projects += parsed
                check(projects.size <= MAX_DIRECTORY_ITEMS) { "PROJECT_LIST_ITEM_LIMIT_EXCEEDED" }
            }
            val nextCursor = when {
                !root.has("nextCursor") -> error("INVALID_PROJECT_LIST_RESPONSE")
                root.isNull("nextCursor") -> null
                root.get("nextCursor") is String -> root.getString("nextCursor").also {
                    check(it.isNotBlank() && it.length <= 500) { "INVALID_PROJECT_LIST_RESPONSE" }
                }
                else -> error("INVALID_PROJECT_LIST_RESPONSE")
            }
            if (nextCursor == null) return projects
            check(seenCursors.add(nextCursor)) { "PROJECT_LIST_CURSOR_REPEATED" }
            cursor = nextCursor
        }
        error("PROJECT_LIST_PAGE_LIMIT_EXCEEDED")
    }
    suspend fun components(projectId: String, token: String): List<ProjectComponent> {
        val root = request("projects/${uuid(projectId)}/components", token)
        check(root.getString("projectId") == projectId)
        return root.objects().map { ProjectComponent(it.getString("key"), it.optString("displayName", it.getString("key")),
            it.getBoolean("enabled"), it.getString("status"), it.optLong("version")) }
    }
    suspend fun people(projectId: String, token: String): List<ManagedPerson> {
        val root = request("projects/${uuid(projectId)}/users?limit=500", token)
        check(root.getString("projectId") == projectId)
        return root.objects().map { ManagedPerson(it.getString("userId"), it.getString("displayName"),
            it.optString("membershipStatus") == "active" && it.optString("status") == "active",
            it.optString("linkedToUserId").takeUnless { value -> value.isBlank() || value == "null" },
            it.optString("linkedToDisplayName").takeUnless { value -> value.isBlank() || value == "null" }, it.optBoolean("protected"), it.getLong("membershipVersion")) }
    }
    suspend fun managePerson(projectId: String, userId: String, action: String, canonicalUserId: String?, token: String, expectedVersion: Long? = null): JSONObject {
        val path = "projects/${uuid(projectId)}/users/${uuid(userId)}"
        return when (action) {
            "disable", "restore" -> request("projects/${uuid(projectId)}/members/${uuid(userId)}", token, "PATCH",
                JSONObject().put("active", action == "restore").put("expectedVersion", checkNotNull(expectedVersion)))
            "link" -> request("$path/identity-link", token, "POST", JSONObject().put("canonicalUserId", uuid(checkNotNull(canonicalUserId))))
            "unlink" -> request("$path/identity-link", token, "DELETE")
            else -> error("INVALID_PERSON_ACTION")
        }
    }
    suspend fun request(path: String, token: String? = null, method: String = "GET", body: JSONObject? = null,
        idempotencyKey: String? = null, contentType: String = "application/json; charset=utf-8"): JSONObject =
        requestEncoded(path, token, method, body?.toString(), idempotencyKey, contentType)

    suspend fun relay(operation: RelayOperation, token: String): JSONObject {
        check(com.relayqahub.android.NativeProjectBindings.projectFor(token) == operation.projectId) { "TOKEN_PROJECT_MISMATCH" }
        return requestEncoded(operation.path, token, operation.method, operation.body)
    }

    private suspend fun requestEncoded(path: String, token: String?, method: String, body: String?,
        idempotencyKey: String? = null, contentType: String = "application/json; charset=utf-8"): JSONObject = withContext(Dispatchers.IO) {
        require(!path.startsWith('/') && !path.contains("..") && !path.contains("://"))
        val url = requireNotNull(base.resolve(path))
        check(url.host == base.host && url.port == base.port && url.encodedPath.startsWith(base.encodedPath))
        val builder = Request.Builder().url(url).header("Accept", QaHubApiContract.JSON_ACCEPT)
        if (token != null) {
            builder.header("Authorization", "Bearer $token")
            com.relayqahub.android.NativeProjectBindings.projectFor(token)?.let { builder.header("x-qa-project-id", it) }
        }
        if (method != "GET") builder.header("Idempotency-Key", idempotencyKey ?: UUID.randomUUID().toString())
        builder.method(method, if (method in listOf("POST", "PUT", "PATCH") || body != null)
            (body ?: "{}").toRequestBody(contentType.toMediaType()) else null)
        client.newCall(builder.build()).execute().use { response ->
            val bytes = response.body?.byteStream()?.use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (output.size() + count > 1_048_576) throw AccountSessionFailure("RESPONSE_TOO_LARGE")
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            } ?: byteArrayOf()
            if (bytes.size > 1_048_576) throw AccountSessionFailure("RESPONSE_TOO_LARGE")
            val text = bytes.toString(Charsets.UTF_8).trim()
            val root = when {
                text.isEmpty() -> JSONObject()
                text.startsWith("[") -> JSONObject().put("items", org.json.JSONArray(text))
                text.startsWith("{") -> JSONObject(text)
                else -> JSONObject().put("value", org.json.JSONTokener(text).nextValue())
            }
            if (!response.isSuccessful) throw AccountSessionFailure(root.optString("code", "HTTP_${response.code}"))
            root
        }
    }
    private fun project(value: JSONObject): QaProject {
        check(value.optBoolean("active", true))
        return QaProject(uuid(value.getString("id")), value.getString("key"), value.getString("name"))
    }
    private fun uuid(value: String): String {
        require(STRICT_UUID_PATTERN.matches(value)) { "value must be a UUID" }
        return UUID.fromString(value).toString()
    }

    private companion object {
        const val MAX_DIRECTORY_PAGES = 100
        const val MAX_DIRECTORY_ITEMS = 10_000
        val STRICT_UUID_PATTERN = Regex(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        )
        val PROJECT_KEY_PATTERN = Regex("^[A-Z][A-Z0-9]{1,15}$")
        val PROJECT_LIST_FIELDS = setOf("snapshotSequence", "items", "nextCursor")
        val PROJECT_ITEM_FIELDS = setOf("id", "key", "name", "roles", "active")
        val DIRECTORY_ROLES = setOf(
            "viewer", "reporter", "developer", "verifier", "triager", "release_manager",
            "project_admin",
        )
    }
}

private fun JSONObject.strictDirectorySequence(): Long {
    check(has("snapshotSequence")) { "INVALID_PROJECT_LIST_RESPONSE" }
    val value = when (val raw = get("snapshotSequence")) {
        is Int -> raw.toLong()
        is Long -> raw
        else -> error("INVALID_PROJECT_LIST_RESPONSE")
    }
    check(value in 0..9_007_199_254_740_991L) { "INVALID_PROJECT_LIST_RESPONSE" }
    return value
}

private fun JSONObject.strictString(key: String): String {
    check(has(key) && !isNull(key) && get(key) is String) { "INVALID_PROJECT_LIST_RESPONSE" }
    return getString(key)
}

internal fun JSONObject.objects(key: String = "items"): List<JSONObject> {
    val array = getJSONArray(key)
    return (0 until array.length()).map(array::getJSONObject)
}
