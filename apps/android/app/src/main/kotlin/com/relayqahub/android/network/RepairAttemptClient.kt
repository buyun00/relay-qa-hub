package com.relayqahub.android.network

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** Minimal native client for a Relay-independent, human-owned RepairAttempt. */
class RepairAttemptClient(
    baseUrl: String,
    private val httpClient: OkHttpClient,
    allowLoopbackHttp: Boolean = false,
) {
    private val apiBaseUrl: HttpUrl = baseUrl.toHttpUrl().let { parsed ->
        require(parsed.username.isEmpty() && parsed.password.isEmpty())
        val loopbackHttp = allowLoopbackHttp &&
            parsed.scheme == "http" &&
            parsed.host in LOOPBACK_HOSTS
        require(parsed.isHttps || loopbackHttp)
        require(parsed.query == null && parsed.fragment == null)
        val normalized = parsed.newBuilder().apply {
            if (!parsed.encodedPath.endsWith('/')) addPathSegment("")
        }.build()
        require(normalized.encodedPath == API_BASE_PATH)
        normalized
    }

    suspend fun createReadAndRejectMissingDeliveryEvidence(
        bugId: String,
        assigneeId: String,
        accessToken: String,
    ): ManualRepairAttemptResult = withContext(Dispatchers.IO) {
        requireUuid(bugId, "bugId")
        requireUuid(assigneeId, "assigneeId")
        require(accessToken.isNotBlank())

        val transitioned = executeJson(
            method = "POST",
            relativePath = "/bugs/$bugId/transitions",
            accessToken = accessToken,
            idempotencyKey = "workflow:transitionBug:bug:$bugId:v1:ready",
            expectedStatuses = setOf(200),
            body = JSONObject()
                .put("expectedVersion", 1)
                .put("toState", "ready"),
        ).body
        require(transitioned.optString("state") == "ready") {
            "BUG_TRANSITION_NOT_READY"
        }
        val readyVersion = transitioned.optInt("version", -1)
        require(readyVersion == 2) { "BUG_TRANSITION_VERSION_MISMATCH" }

        val created = executeJson(
            method = "POST",
            relativePath = "/bugs/$bugId/repair-attempts",
            accessToken = accessToken,
            idempotencyKey = "workflow:createRepairAttempt:bug:$bugId:v$readyVersion",
            expectedStatuses = setOf(201),
            body = JSONObject()
                .put("expectedVersion", readyVersion)
                .put("mode", "human")
                .put("assigneeId", assigneeId)
                .put("summary", "QA Hub native human repair"),
        ).body
        val attemptId = created.requireRepairString("id")
        validateAttempt(created, attemptId, bugId, assigneeId)

        val readBack = executeJson(
            method = "GET",
            relativePath = "/repair-attempts/$attemptId",
            accessToken = accessToken,
            idempotencyKey = null,
            expectedStatuses = setOf(200),
            body = null,
        ).body
        validateAttempt(readBack, attemptId, bugId, assigneeId)

        // Deliberately omit branch+commitSha, mergeRequestUrl, and patchUrl. A code
        // delivery without one of those evidence forms must fail before any mutation.
        val rejected = executeJson(
            method = "POST",
            relativePath = "/repair-attempts/$attemptId/deliver",
            accessToken = accessToken,
            idempotencyKey = "workflow:deliverRepairAttempt:attempt:$attemptId:v1",
            expectedStatuses = setOf(400, 422),
            body = JSONObject()
                .put("expectedVersion", 1)
                .put("summary", "Missing delivery evidence smoke")
                .put("deliveryKind", "code"),
        )
        val rejectionCode = rejected.body.optString("code")
        require(rejectionCode in MISSING_EVIDENCE_CODES) {
            "MISSING_EVIDENCE_REJECTION_NOT_EXPLICIT"
        }

        val unchanged = executeJson(
            method = "GET",
            relativePath = "/repair-attempts/$attemptId",
            accessToken = accessToken,
            idempotencyKey = null,
            expectedStatuses = setOf(200),
            body = null,
        ).body
        validateAttempt(unchanged, attemptId, bugId, assigneeId)

        ManualRepairAttemptResult(
            bugId = bugId,
            attemptId = attemptId,
            mode = unchanged.requireRepairString("mode"),
            status = unchanged.requireRepairString("status"),
            version = unchanged.optInt("version", -1),
            missingEvidenceRejectionCode = rejectionCode,
        )
    }

    private fun validateAttempt(
        value: JSONObject,
        attemptId: String,
        bugId: String,
        assigneeId: String,
    ) {
        require(value.optString("id") == attemptId) { "REPAIR_ATTEMPT_ID_MISMATCH" }
        require(value.optString("bugId") == bugId) { "REPAIR_ATTEMPT_BUG_MISMATCH" }
        require(value.optString("assigneeId") == assigneeId) {
            "REPAIR_ATTEMPT_ASSIGNEE_MISMATCH"
        }
        require(value.optString("mode") == "human") { "REPAIR_ATTEMPT_MODE_MISMATCH" }
        require(value.optString("status") == "planned") { "REPAIR_ATTEMPT_STATUS_MISMATCH" }
        require(value.optInt("version", -1) == 1) { "REPAIR_ATTEMPT_VERSION_MISMATCH" }
    }

    private fun executeJson(
        method: String,
        relativePath: String,
        accessToken: String,
        idempotencyKey: String?,
        expectedStatuses: Set<Int>,
        body: JSONObject?,
    ): RepairHttpResult {
        val url = apiBaseUrl.resolve(relativePath.removePrefix("/"))
            ?: throw RepairAttemptFailure("INVALID_REPAIR_PATH")
        val builder = Request.Builder()
            .url(url)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
        idempotencyKey?.let { builder.header("Idempotency-Key", it) }
        val requestBody = body?.toString()
            ?.toRequestBody(QaHubApiContract.VERSIONED_JSON.toMediaType())
        val request = builder.method(method, requestBody).build()
        val response = try {
            httpClient.newCall(request).execute()
        } catch (_: IOException) {
            throw RepairAttemptFailure("NETWORK_IO")
        }
        response.use { result ->
            val responseBody = result.body?.byteStream()?.use {
                it.readRepairUtf8(MAX_RESPONSE_BYTES)
            }.orEmpty()
            if (responseBody.toByteArray(Charsets.UTF_8).size > MAX_RESPONSE_BYTES) {
                throw RepairAttemptFailure("RESPONSE_TOO_LARGE")
            }
            val json = try {
                JSONObject(responseBody)
            } catch (_: RuntimeException) {
                throw RepairAttemptFailure("INVALID_REPAIR_RESPONSE")
            }
            if (result.code !in expectedStatuses) {
                throw RepairAttemptFailure(json.optString("code").ifBlank { "HTTP_${result.code}" })
            }
            return RepairHttpResult(result.code, json)
        }
    }

    private companion object {
        const val API_BASE_PATH = "/api/v1/"
        const val MAX_RESPONSE_BYTES = 256 * 1024
        val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "::1")
        val MISSING_EVIDENCE_CODES = setOf(
            "INVALID_REQUEST",
            "GUARD_FAILED",
            "RELAY_DELIVERY_EVIDENCE_INVALID",
        )
    }
}

data class ManualRepairAttemptResult(
    val bugId: String,
    val attemptId: String,
    val mode: String,
    val status: String,
    val version: Int,
    val missingEvidenceRejectionCode: String,
)

class RepairAttemptFailure(val code: String) : RuntimeException()

private data class RepairHttpResult(val status: Int, val body: JSONObject)

private fun JSONObject.requireRepairString(key: String): String = optString(key).also {
    require(it.isNotBlank()) { "REPAIR_RESPONSE_MISSING_$key" }
}

private fun requireUuid(value: String, label: String) {
    require(runCatching { UUID.fromString(value) }.isSuccess) { "$label must be a UUID" }
}

private fun InputStream.readRepairUtf8(maxBytes: Int): String {
    val output = ByteArrayOutputStream(minOf(maxBytes, 8 * 1024))
    val buffer = ByteArray(8 * 1024)
    var total = 0
    while (true) {
        val read = read(buffer)
        if (read < 0) break
        total += read
        output.write(buffer, 0, read)
        if (total > maxBytes) break
    }
    return output.toByteArray().toString(Charsets.UTF_8)
}
