package com.relayqahub.android.network

import java.util.UUID
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
    suspend fun projects(token: String): List<QaProject> = request("projects?limit=100", token).objects().map(::project)
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
    private fun uuid(value: String): String = UUID.fromString(value).toString()
}

internal fun JSONObject.objects(key: String = "items"): List<JSONObject> {
    val array = getJSONArray(key)
    return (0 until array.length()).map(array::getJSONObject)
}
