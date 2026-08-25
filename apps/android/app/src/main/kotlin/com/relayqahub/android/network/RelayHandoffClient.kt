package com.relayqahub.android.network

import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/**
 * Small native-human client for the QA Hub owned Relay handoff flow.
 *
 * This client never carries a Relay/M2M credential. It only uses the native QA Hub
 * access token and keeps the four server-owned workflow calls in one cancellable
 * application action.
 */
class RelayHandoffClient(
    baseUrl: String,
    private val httpClient: OkHttpClient,
    allowLoopbackHttp: Boolean = false,
) {
    private val apiBaseUrl: HttpUrl = baseUrl.toHttpUrl().let { parsed ->
        require(parsed.username.isEmpty() && parsed.password.isEmpty()) {
            "QA Hub API base URL must not embed credentials"
        }
        val loopbackHttp = allowLoopbackHttp &&
            parsed.scheme == "http" &&
            parsed.host in LOOPBACK_HOSTS
        require(parsed.isHttps || loopbackHttp) {
            "QA Hub API base URL must use HTTPS unless loopback HTTP is explicitly enabled"
        }
        require(parsed.query == null && parsed.fragment == null)
        val normalized = parsed.newBuilder().apply {
            if (!parsed.encodedPath.endsWith('/')) addPathSegment("")
        }.build()
        require(normalized.encodedPath == API_BASE_PATH) {
            "QA Hub API base URL must use the frozen $API_BASE_PATH path"
        }
        normalized
    }

    suspend fun dispatchBugToRelay(
        bugId: String,
        bugKey: String,
        actorId: String,
        accessToken: String,
    ): RelayHandoffResult = withContext(Dispatchers.IO) {
        requireUuid(bugId, "bugId")
        requireUuid(actorId, "actorId")
        require(accessToken.isNotBlank())

        // A newly submitted mobile Bug is reported/version 1. The guarded transition
        // is intentionally explicit: createRepairAttempt requires the resulting ready/v2.
        val transitioned = executeJson(
            method = "POST",
            relativePath = "/bugs/$bugId/transitions",
            accessToken = accessToken,
            idempotencyKey = "workflow:transitionBug:bug:$bugId:v1:ready",
            expectedStatus = 200,
            body = JSONObject()
                .put("expectedVersion", 1)
                .put("toState", "ready"),
        )
        val transitionedVersion = transitioned.optInt("version", 2)
        require(transitioned.optString("state") == "ready") {
            "BUG_TRANSITION_NOT_READY"
        }
        require(transitionedVersion == 2) { "BUG_TRANSITION_VERSION_MISMATCH" }

        val attempt = executeJson(
            method = "POST",
            relativePath = "/bugs/$bugId/repair-attempts",
            accessToken = accessToken,
            idempotencyKey = "workflow:createRepairAttempt:bug:$bugId:v2",
            expectedStatus = 201,
            body = JSONObject()
                .put("expectedVersion", 2)
                .put("mode", "relay")
                .put("assigneeId", actorId)
                .put("summary", "Relay QA Hub native handoff"),
        )
        val attemptId = attempt.requireString("id")
        require(attempt.optString("bugId") == bugId) { "REPAIR_ATTEMPT_BUG_MISMATCH" }
        require(attempt.optString("mode") == "relay") { "REPAIR_ATTEMPT_MODE_MISMATCH" }

        val handoffId = java.util.UUID.randomUUID().toString()
        executeJson(
            method = "POST",
            relativePath = "/repair-attempts/$attemptId/dispatch/relay",
            accessToken = accessToken,
            idempotencyKey = "relay:dispatch:$handoffId",
            expectedStatus = 202,
            body = JSONObject()
                .put("expectedVersion", 1)
                .put("handoffId", handoffId)
                .put("selectedAttachmentIds", JSONArray()),
        )

        var receipt: JSONObject? = null
        for (poll in 0 until RECEIPT_POLL_ATTEMPTS) {
            val current = executeJson(
                method = "GET",
                relativePath = "/repair-attempts/$attemptId/relay-receipt",
                accessToken = accessToken,
                idempotencyKey = null,
                expectedStatus = 200,
                body = null,
            )
            receipt = current
            if (current.optString("handoffStatus") != "queued") break
            if (poll + 1 < RECEIPT_POLL_ATTEMPTS) delay(RECEIPT_POLL_DELAY_MS)
        }
        val finalReceipt = requireNotNull(receipt)
        val receiptHandoffId = finalReceipt.requireString("handoffId")
        require(receiptHandoffId == handoffId) { "RELAY_RECEIPT_HANDOFF_MISMATCH" }
        require(finalReceipt.requireString("repairAttemptId") == attemptId) {
            "RELAY_RECEIPT_ATTEMPT_MISMATCH"
        }
        val requiresHumanVerification = finalReceipt.optBoolean("requiresHumanVerification", false)
        require(requiresHumanVerification) { "RELAY_RECEIPT_HUMAN_VERIFICATION_FALSE" }
        val qaItem = finalReceipt.optJSONObject("qaItem")
        val responseBugId = qaItem?.optString("id").orEmpty()
            .ifBlank { finalReceipt.optString("bugId") }
        require(responseBugId == bugId) { "RELAY_RECEIPT_BUG_MISMATCH" }

        RelayHandoffResult(
            bugId = bugId,
            bugKey = qaItem?.optString("key").orEmpty().ifBlank { bugKey },
            repairAttemptId = attemptId,
            handoffId = handoffId,
            handoffStatus = finalReceipt.requireString("handoffStatus"),
            relayTaskId = finalReceipt.nullableString("relayTaskId"),
            requiresHumanVerification = requiresHumanVerification,
        )
    }

    private fun executeJson(
        method: String,
        relativePath: String,
        accessToken: String,
        idempotencyKey: String?,
        expectedStatus: Int,
        body: JSONObject?,
    ): JSONObject {
        val url = apiBaseUrl.resolve(relativePath.removePrefix("/"))
            ?: throw RelayHandoffFailure("INVALID_RELAY_PATH")
        val requestBuilder = Request.Builder()
            .url(url)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
        idempotencyKey?.let { requestBuilder.header("Idempotency-Key", it) }
        val requestBody = body?.toString()
            ?.toRequestBody(QaHubApiContract.VERSIONED_JSON.toMediaType())
        val request = requestBuilder.method(method, requestBody).build()

        val response = try {
            httpClient.newCall(request).execute()
        } catch (_: IOException) {
            throw RelayHandoffFailure("NETWORK_IO")
        }
        response.use { result ->
            val responseBody = result.body?.string().orEmpty()
            if (result.code != expectedStatus) {
                val errorCode = runCatching {
                    JSONObject(responseBody).optString("code")
                }.getOrNull().orEmpty()
                throw RelayHandoffFailure(
                    if (errorCode.isBlank()) "HTTP_${result.code}" else errorCode,
                )
            }
            if (responseBody.isBlank()) throw RelayHandoffFailure("EMPTY_RELAY_RESPONSE")
            return try {
                JSONObject(responseBody)
            } catch (_: RuntimeException) {
                throw RelayHandoffFailure("INVALID_RELAY_RESPONSE")
            }
        }
    }

    private companion object {
        const val API_BASE_PATH = "/api/v1/"
        const val RECEIPT_POLL_ATTEMPTS = 12
        const val RECEIPT_POLL_DELAY_MS = 250L
        val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "::1")
    }
}

data class RelayHandoffResult(
    val bugId: String,
    val bugKey: String,
    val repairAttemptId: String,
    val handoffId: String,
    val handoffStatus: String,
    val relayTaskId: String?,
    val requiresHumanVerification: Boolean,
)

class RelayHandoffFailure(val code: String) : RuntimeException()

private fun JSONObject.requireString(key: String): String = optString(key).also {
    require(it.isNotBlank()) { "RELAY_RESPONSE_MISSING_$key" }
}

private fun JSONObject.nullableString(key: String): String? = if (isNull(key)) {
    null
} else {
    optString(key).takeIf(String::isNotBlank)
}

private fun requireUuid(value: String, label: String) {
    require(runCatching { java.util.UUID.fromString(value) }.isSuccess) {
        "$label must be a UUID"
    }
}
