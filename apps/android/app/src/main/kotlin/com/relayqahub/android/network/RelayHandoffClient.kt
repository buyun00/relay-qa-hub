package com.relayqahub.android.network

import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
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
    allowPrivateHttp: Boolean = false,
) {
    private val apiBaseUrl: HttpUrl = QaHubApiEndpoint.parse(baseUrl, allowPrivateHttp)

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
        val initialAttemptVersion = attempt.optionalInt("version")
            ?: throw RelayHandoffFailure("REPAIR_ATTEMPT_VERSION_MISSING")

        val handoffId = java.util.UUID.randomUUID().toString()
        executeJson(
            method = "POST",
            relativePath = "/repair-attempts/$attemptId/dispatch/relay",
            accessToken = accessToken,
            idempotencyKey = "relay:dispatch:$handoffId",
            expectedStatus = 202,
            body = JSONObject()
                .put("expectedVersion", initialAttemptVersion)
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
            if (current.optString("handoffStatus") !in NON_TERMINAL_RECEIPT_STATUSES) break
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
        val buildLink = finalReceipt.optJSONObject("buildLink")
            ?: finalReceipt.optJSONObject("buildProjection")
        val build = finalReceipt.optJSONObject("build")
        val responseBugId = qaItem?.optString("id").orEmpty()
            .ifBlank { finalReceipt.optString("bugId") }
        require(responseBugId == bugId) { "RELAY_RECEIPT_BUG_MISMATCH" }

        RelayHandoffResult(
            bugId = bugId,
            bugKey = qaItem?.optString("key").orEmpty().ifBlank { bugKey },
            repairAttemptId = attemptId,
            initialAttemptVersion = initialAttemptVersion,
            handoffId = handoffId,
            handoffStatus = finalReceipt.requireString("handoffStatus"),
            relayTaskId = finalReceipt.nullableString("relayTaskId"),
            requiresHumanVerification = requiresHumanVerification,
            deliveredCommitSha = finalReceipt.nullableString("deliveredCommitSha"),
            deliveredBranch = finalReceipt.nullableString("branch")
                ?: finalReceipt.nullableString("deliveredBranch"),
            buildRequirement = finalReceipt.nullableString("buildRequirement"),
            buildId = finalReceipt.nullableString("buildId")
                ?: build?.nullableString("id"),
            externalRevision = finalReceipt.optionalInt("externalRevision"),
            receiptVersion = finalReceipt.optionalInt("version"),
            attemptVersion = finalReceipt.optionalInt("attemptVersion")
                ?: finalReceipt.optionalInt("repairAttemptVersion"),
            buildLinkExpectedVersion = finalReceipt.optionalInt("expectedVersion")
                ?: buildLink?.optionalInt("expectedVersion"),
            expectedBugVersion = finalReceipt.optionalInt("expectedBugVersion")
                ?: buildLink?.optionalInt("expectedBugVersion"),
            expectedBuildRequirementVersion =
                finalReceipt.optionalInt("expectedBuildRequirementVersion")
                    ?: buildLink?.optionalInt("expectedBuildRequirementVersion"),
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
        const val RECEIPT_POLL_ATTEMPTS = 12
        const val RECEIPT_POLL_DELAY_MS = 250L
        val NON_TERMINAL_RECEIPT_STATUSES = setOf("queued", "submitted", "running")
    }
}

data class RelayHandoffResult(
    val bugId: String,
    val bugKey: String,
    val repairAttemptId: String,
    /** Version returned by createRepairAttempt; the adoption action uses this exact value. */
    val initialAttemptVersion: Int,
    val handoffId: String,
    val handoffStatus: String,
    val relayTaskId: String?,
    val requiresHumanVerification: Boolean,
    /** Exact commit reported by the Relay receipt; never inferred from a build or task. */
    val deliveredCommitSha: String? = null,
    val deliveredBranch: String? = null,
    /** Server-owned build requirement state, when the receipt exposes it. */
    val buildRequirement: String? = null,
    /** Build identity returned by the receipt, if one is already linked. */
    val buildId: String? = null,
    val externalRevision: Int? = null,
    val receiptVersion: Int? = null,
    /** Optional server-owned CAS facts used by the explicit build-link action. */
    val attemptVersion: Int? = null,
    val buildLinkExpectedVersion: Int? = null,
    val expectedBugVersion: Int? = null,
    val expectedBuildRequirementVersion: Int? = null,
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

private fun JSONObject.optionalInt(key: String): Int? = if (isNull(key) || !has(key)) {
    null
} else {
    optInt(key).takeIf { it > 0 }
}

private fun requireUuid(value: String, label: String) {
    require(runCatching { java.util.UUID.fromString(value) }.isSuccess) {
        "$label must be a UUID"
    }
}
