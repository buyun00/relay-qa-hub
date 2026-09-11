package com.relayqahub.android.network

import com.relayqahub.android.QaPeopleConfig
import com.relayqahub.android.QaPerson
import com.relayqahub.android.QaPersonRole
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

data class QaHubAccountSession(
    val accountId: String,
    val userId: String,
    val displayName: String,
    val accessToken: String,
    val accessTokenExpiresAtEpochMs: Long,
    val projectId: String,
    val isGm: Boolean = false,
)

class AccountSessionFailure(val code: String) : RuntimeException(code)

class AccountSessionClient(
    baseUrl: String,
    private val httpClient: OkHttpClient,
    allowPrivateHttp: Boolean = false,
) {
    private val apiBaseUrl: HttpUrl = QaHubApiEndpoint.parse(baseUrl, allowPrivateHttp)

    internal fun buildLoginRequest(projectName: String, code: String, name: String): Request {
        require(projectName.trim().isNotEmpty() && projectName.length <= 200) {
            "projectName is invalid"
        }
        require(code.length == 4 && code.all(Char::isDigit)) {
            "code is invalid"
        }
        require(name.isNotBlank() && name.length <= 100) { "name is invalid" }
        val url = apiBaseUrl.resolve("auth/login")
            ?: throw AccountSessionFailure("INVALID_LOGIN_PATH")
        // Keep code as a string: values such as "0007" are meaningful and must
        // not be coerced through an integer representation.
        val body = "{\"projectName\":${projectName.toJsonString()},\"code\":${code.toJsonString()},\"name\":${name.toJsonString()},\"client\":\"android\"}"
            .toRequestBody(JSON_MEDIA_TYPE)
        return Request.Builder()
            .url(url)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .post(body)
            .build()
    }

    suspend fun login(projectName: String, code: String, name: String): QaHubAccountSession = withContext(Dispatchers.IO) {
        val response = try {
            httpClient.newCall(buildLoginRequest(projectName, code, name)).execute()
        } catch (_: IOException) {
            throw AccountSessionFailure("NETWORK_IO")
        }
        response.use { result ->
            val body = result.body?.byteStream()?.use { it.readBoundedUtf8(MAX_RESPONSE_BYTES) }
                .orEmpty()
            if (result.code != 200) {
                val code = runCatching { JSONObject(body).optString("code") }.getOrNull().orEmpty()
                throw AccountSessionFailure(code.ifBlank { "HTTP_${result.code}" })
            }
            val root = parseObject(body, "INVALID_LOGIN_RESPONSE")
            val accountId = root.optString("accountId")
            val userId = root.optString("userId")
            val displayName = root.optString("displayName")
            val accessToken = root.optString("accessToken")
            val projectId = root.optString("projectId")
            val expiresAtEpochMs = runCatching {
                Instant.parse(root.optString("expiresAt")).toEpochMilli()
            }.getOrNull()
            if (
                runCatching { UUID.fromString(accountId) }.isFailure ||
                runCatching { UUID.fromString(userId) }.isFailure ||
                runCatching { UUID.fromString(projectId) }.isFailure ||
                displayName.isBlank() ||
                accessToken.length != 43 ||
                expiresAtEpochMs == null ||
                expiresAtEpochMs <= System.currentTimeMillis()
            ) {
                throw AccountSessionFailure("INVALID_LOGIN_RESPONSE")
            }
            QaHubAccountSession(accountId, userId, displayName, accessToken, expiresAtEpochMs, projectId, root.optBoolean("isGm"))
        }
    }

    suspend fun listPeople(
        projectId: String,
        projectKey: String,
        accessToken: String,
    ): QaPeopleConfig = withContext(Dispatchers.IO) {
        require(
            STRICT_PEOPLE_UUID.matches(projectId) &&
                runCatching { UUID.fromString(projectId) }.isSuccess,
        )
        val base = apiBaseUrl.resolve("projects/$projectId/members")
            ?: throw AccountSessionFailure("INVALID_PEOPLE_PATH")
        val people = mutableListOf<QaPerson>()
        val canonicalIds = mutableSetOf<String>()
        val seenCursors = mutableSetOf<String>()
        var cursor: String? = null
        var frozenSnapshotSequence: Long? = null
        repeat(MAX_PEOPLE_PAGES) {
            val request = Request.Builder()
                .url(base.newBuilder().addQueryParameter("limit", "100").apply {
                    cursor?.let { addQueryParameter("cursor", it) }
                }.build())
                .header("Accept", QaHubApiContract.JSON_ACCEPT)
                .header("Authorization", "Bearer $accessToken")
                .get()
                .build()
            val response = try {
                httpClient.newCall(request).execute()
            } catch (_: IOException) {
                throw AccountSessionFailure("NETWORK_IO")
            }
            val root = response.use { result ->
                val body = result.body?.byteStream()?.use { it.readBoundedUtf8(MAX_RESPONSE_BYTES) }
                    .orEmpty()
                if (result.code != 200) {
                    val code = runCatching { JSONObject(body).optString("code") }.getOrNull().orEmpty()
                    throw AccountSessionFailure(code.ifBlank { "HTTP_${result.code}" })
                }
                parseObject(body, "INVALID_PEOPLE_RESPONSE")
            }
            if (root.keys().asSequence().toSet() != PEOPLE_LIST_FIELDS) {
                throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
            }
            if (
                !root.has("projectId") || root.get("projectId") !is String ||
                root.getString("projectId") != projectId
            ) {
                throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
            }
            val snapshotSequence = root.requiredPeopleSnapshotSequence()
            if (frozenSnapshotSequence == null) {
                frozenSnapshotSequence = snapshotSequence
            } else if (frozenSnapshotSequence != snapshotSequence) {
                throw AccountSessionFailure("PEOPLE_SNAPSHOT_CHANGED")
            }
            val items = root.optJSONArray("items")
                ?: throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
            if (items.length() > 100) throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
            for (index in 0 until items.length()) {
                val item = items.optJSONObject(index)
                    ?: throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
                if (item.keys().asSequence().toSet() != PEOPLE_ITEM_FIELDS) {
                    throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
                }
                val userId = item.requiredPeopleString("userId")
                val displayName = item.requiredPeopleString("displayName")
                val rolesJson = item.optJSONArray("roles")
                    ?: throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
                if (
                    !STRICT_PEOPLE_UUID.matches(userId) ||
                    runCatching { UUID.fromString(userId) }.isFailure ||
                    item.requiredPeopleString("projectId") != projectId ||
                    displayName.isBlank() || displayName.length > 200 ||
                    !item.has("active") || item.get("active") !is Boolean
                ) {
                    throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
                }
                val roleNames = mutableSetOf<String>()
                val roles = buildSet {
                    for (roleIndex in 0 until rolesJson.length()) {
                        val rawRole = rolesJson.get(roleIndex)
                        if (rawRole !is String || !roleNames.add(rawRole)) {
                            throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
                        }
                        if (rawRole !in PROJECT_ROLES) {
                            throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
                        }
                        when (rawRole) {
                            "developer" -> add(QaPersonRole.FIXER)
                            "verifier" -> add(QaPersonRole.VERIFIER)
                        }
                    }
                }
                if (roleNames.isEmpty() || !canonicalIds.add(userId)) {
                    throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
                }
                people += QaPerson(userId, displayName, roles, active = item.getBoolean("active"))
                if (people.size > MAX_PEOPLE_ITEMS) {
                    throw AccountSessionFailure("PEOPLE_ITEM_LIMIT_EXCEEDED")
                }
            }
            val nextCursor = when {
                !root.has("nextCursor") -> throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
                root.isNull("nextCursor") -> null
                root.get("nextCursor") is String -> root.getString("nextCursor").also {
                    if (it.isBlank() || it.length > 500) {
                        throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
                    }
                }
                else -> throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
            }
            if (nextCursor == null) {
                return@withContext QaPeopleConfig(
                    schemaVersion = 4,
                    projectKey = projectKey,
                    people = people,
                    snapshotSequence = checkNotNull(frozenSnapshotSequence),
                )
            }
            if (!seenCursors.add(nextCursor)) {
                throw AccountSessionFailure("PEOPLE_CURSOR_REPEATED")
            }
            cursor = nextCursor
        }
        throw AccountSessionFailure("PEOPLE_PAGE_LIMIT_EXCEEDED")
    }

    private fun parseObject(body: String, errorCode: String): JSONObject = try {
        JSONObject(body)
    } catch (_: RuntimeException) {
        throw AccountSessionFailure(errorCode)
    }

    private companion object {
        const val MAX_RESPONSE_BYTES = 256 * 1024
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val PEOPLE_LIST_FIELDS = setOf("projectId", "snapshotSequence", "items", "nextCursor")
        val PEOPLE_ITEM_FIELDS = setOf("userId", "projectId", "displayName", "roles", "active")
        val PROJECT_ROLES = setOf(
            "viewer", "reporter", "developer", "verifier", "triager", "release_manager",
            "project_admin",
        )
        val STRICT_PEOPLE_UUID = Regex(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        )
        const val MAX_PEOPLE_PAGES = 100
        const val MAX_PEOPLE_ITEMS = 10_000
    }
}

private fun JSONObject.requiredPeopleString(key: String): String {
    if (!has(key) || isNull(key) || get(key) !is String) {
        throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
    }
    return getString(key)
}

private fun JSONObject.requiredPeopleSnapshotSequence(): Long {
    if (!has("snapshotSequence")) throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
    val sequence = when (val raw = get("snapshotSequence")) {
        is Int -> raw.toLong()
        is Long -> raw
        else -> throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
    }
    if (sequence !in 0..9_007_199_254_740_991L) {
        throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
    }
    return sequence
}

private fun String.toJsonString(): String = buildString {
    append('"')
    this@toJsonString.forEach { character ->
        when (character) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\b' -> append("\\b")
            '\u000c' -> append("\\f")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (character.code < 0x20) {
                append("\\u").append(character.code.toString(16).padStart(4, '0'))
            } else {
                append(character)
            }
        }
    }
    append('"')
}

private fun InputStream.readBoundedUtf8(maxBytes: Int): String {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8 * 1024)
    var total = 0
    while (true) {
        val read = read(buffer)
        if (read < 0) break
        total += read
        if (total > maxBytes) throw AccountSessionFailure("RESPONSE_TOO_LARGE")
        output.write(buffer, 0, read)
    }
    return output.toString(Charsets.UTF_8.name())
}
