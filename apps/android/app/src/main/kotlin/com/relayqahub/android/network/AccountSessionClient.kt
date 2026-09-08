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

    internal fun buildLoginRequest(name: String, projectId: String): Request {
        UUID.fromString(projectId)
        val url = apiBaseUrl.resolve("auth/login")
            ?: throw AccountSessionFailure("INVALID_LOGIN_PATH")
        val body = "{\"name\":${name.toJsonString()},\"client\":\"android\",\"projectId\":${projectId.toJsonString()}}"
            .toRequestBody(JSON_MEDIA_TYPE)
        return Request.Builder()
            .url(url)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .post(body)
            .build()
    }

    suspend fun login(name: String, projectId: String): QaHubAccountSession = withContext(Dispatchers.IO) {
        val response = try {
            httpClient.newCall(buildLoginRequest(name, projectId)).execute()
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
            val expiresAtEpochMs = runCatching {
                Instant.parse(root.optString("expiresAt")).toEpochMilli()
            }.getOrNull()
            if (
                runCatching { UUID.fromString(accountId) }.isFailure ||
                runCatching { UUID.fromString(userId) }.isFailure ||
                displayName.isBlank() || root.optString("projectId") != projectId ||
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
        require(runCatching { UUID.fromString(projectId) }.isSuccess)
        val base = apiBaseUrl.resolve("projects/$projectId/members")
            ?: throw AccountSessionFailure("INVALID_PEOPLE_PATH")
        val request = Request.Builder()
            .url(base.newBuilder().addQueryParameter("limit", "100").build())
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .get()
            .build()
        val response = try {
            httpClient.newCall(request).execute()
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
            val root = parseObject(body, "INVALID_PEOPLE_RESPONSE")
            if (root.optString("projectId") != projectId) {
                throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
            }
            val items = root.optJSONArray("items")
                ?: throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
            if (items.length() > 100) throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
            val people = buildList {
                for (index in 0 until items.length()) {
                    val item = items.optJSONObject(index)
                        ?: throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
                    val userId = item.optString("userId")
                    val displayName = item.optString("displayName")
                    val rolesJson = item.optJSONArray("roles")
                        ?: throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
                    if (
                        runCatching { UUID.fromString(userId) }.isFailure ||
                        displayName.isBlank() ||
                        !item.optBoolean("active", false)
                    ) {
                        throw AccountSessionFailure("INVALID_PEOPLE_RESPONSE")
                    }
                    val roles = buildSet {
                        for (roleIndex in 0 until rolesJson.length()) {
                            when (rolesJson.optString(roleIndex)) {
                                "developer" -> add(QaPersonRole.FIXER)
                                "verifier" -> add(QaPersonRole.VERIFIER)
                            }
                        }
                    }
                    add(QaPerson(userId, displayName, setOf(QaPersonRole.FIXER, QaPersonRole.VERIFIER), active = true))
                }
            }
            QaPeopleConfig(schemaVersion = 4, projectKey = projectKey, people = people)
        }
    }

    private fun parseObject(body: String, errorCode: String): JSONObject = try {
        JSONObject(body)
    } catch (_: RuntimeException) {
        throw AccountSessionFailure(errorCode)
    }

    private companion object {
        const val MAX_RESPONSE_BYTES = 256 * 1024
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
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
