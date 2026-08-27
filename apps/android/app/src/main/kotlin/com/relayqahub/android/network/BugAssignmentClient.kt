package com.relayqahub.android.network

import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** Minimal field-client assignment step; desktop remains the full management UI. */
class BugAssignmentClient(
    baseUrl: String,
    private val httpClient: OkHttpClient,
    allowPrivateHttp: Boolean = false,
) {
    private val apiBaseUrl: HttpUrl = QaHubApiEndpoint.parse(baseUrl, allowPrivateHttp)

    suspend fun assign(
        bugId: String,
        expectedVersion: Int,
        fixerId: String,
        verifierId: String,
        accessToken: String,
    ): AssignmentResult = withContext(Dispatchers.IO) {
        requireUuid(bugId)
        require(expectedVersion > 0)
        require(fixerId.isNotBlank() && verifierId.isNotBlank())
        require(accessToken.isNotBlank())
        val idempotencyKey = "field-assignment:$bugId:$expectedVersion:$fixerId:$verifierId"
        val payload = JSONObject()
            .put("expectedVersion", expectedVersion)
            .put("ownerId", fixerId)
            .put("verificationOwnerId", verifierId)
            .toString()
        val url = apiBaseUrl.resolve("bugs/$bugId")
            ?: throw BugAssignmentFailure("INVALID_ASSIGNMENT_PATH")
        val request = Request.Builder()
            .url(url)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Content-Type", "${QaHubApiContract.VERSIONED_JSON}; charset=utf-8")
            .header("Authorization", "Bearer $accessToken")
            .header("Idempotency-Key", idempotencyKey)
            .patch(payload.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        val response = try {
            httpClient.newCall(request).execute()
        } catch (_: IOException) {
            throw BugAssignmentFailure("NETWORK_IO")
        }
        response.use { result ->
            val body = result.body?.string().orEmpty()
            if (result.code != 200) {
                val code = runCatching { JSONObject(body).optString("code") }
                    .getOrNull().orEmpty()
                throw BugAssignmentFailure(code.ifBlank { "HTTP_${result.code}" })
            }
            val json = runCatching { JSONObject(body) }
                .getOrElse { throw BugAssignmentFailure("INVALID_ASSIGNMENT_RESPONSE") }
            AssignmentResult(
                bugId = json.optString("id").ifBlank { bugId },
                ownerId = json.optString("ownerId").ifBlank { fixerId },
                verificationOwnerId = json.optString("verificationOwnerId")
                    .ifBlank { verifierId },
                version = json.optInt("version", expectedVersion + 1),
            )
        }
    }

    private fun requireUuid(value: String) {
        require(runCatching { UUID.fromString(value) }.isSuccess)
    }

    private companion object {
        val JSON_MEDIA_TYPE = "${QaHubApiContract.VERSIONED_JSON}; charset=utf-8".toMediaType()
    }
}

data class AssignmentResult(
    val bugId: String,
    val ownerId: String,
    val verificationOwnerId: String,
    val version: Int,
)

class BugAssignmentFailure(val code: String) : RuntimeException()
