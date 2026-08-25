package com.relayqahub.android.network

import com.relayqahub.android.BuildConfig
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
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

    suspend fun deliverAndLinkManualBuild(
        projectId: String,
        projectKey: String,
        attemptId: String,
        accessToken: String,
    ): HumanRepairBuildResult = withContext(Dispatchers.IO) {
        requireUuid(projectId, "projectId")
        requireUuid(attemptId, "attemptId")
        require(projectKey.matches(PROJECT_KEY_PATTERN))
        require(accessToken.isNotBlank())

        val running = executeJson(
            method = "POST",
            relativePath = "/repair-attempts/$attemptId/start",
            accessToken = accessToken,
            idempotencyKey = "workflow:startRepairAttempt:attempt:$attemptId:v1",
            expectedStatuses = setOf(200),
            body = JSONObject()
                .put("expectedVersion", 1)
                .put("reason", "Native human repair started"),
        ).body
        validateAttemptState(running, attemptId, "running", 2)

        val deliveredCommitSha =
            "qa-hub-human-delivery-v1|$attemptId".digestHex("SHA-1")
        val branch = "qa-hub/human/$attemptId"
        val delivered = executeJson(
            method = "POST",
            relativePath = "/repair-attempts/$attemptId/deliver",
            accessToken = accessToken,
            idempotencyKey = "workflow:deliverRepairAttempt:attempt:$attemptId:v2",
            expectedStatuses = setOf(200),
            body = JSONObject()
                .put("expectedVersion", 2)
                .put("summary", "Native human repair delivered")
                .put("deliveryKind", "code")
                .put("branch", branch)
                .put("commitSha", deliveredCommitSha),
        ).body
        validateAttemptState(delivered, attemptId, "delivered", 3)
        require(delivered.optString("commitSha") == deliveredCommitSha) {
            "REPAIR_DELIVERED_COMMIT_MISMATCH"
        }

        val wrongCommitSha = if (deliveredCommitSha == WRONG_COMMIT_SHA) {
            ALTERNATE_WRONG_COMMIT_SHA
        } else {
            WRONG_COMMIT_SHA
        }
        val wrongExternalId = "qa-hub-human-wrong-$attemptId"
        val wrongBuild = executeJson(
            method = "POST",
            relativePath = "/projects/$projectId/builds",
            accessToken = accessToken,
            idempotencyKey =
                "build:register:project:$projectId:provider:manual:external:$wrongExternalId",
            expectedStatuses = setOf(422),
            body = buildRegistrationBody(
                projectId = projectId,
                projectKey = projectKey,
                attemptId = attemptId,
                externalId = wrongExternalId,
                branch = branch,
                commitSha = wrongCommitSha,
            ),
        ).body
        val wrongShaRejectionCode = wrongBuild.optString("code")
        require(wrongShaRejectionCode == "BUILD_IDENTITY_MISMATCH") {
            "WRONG_SHA_REJECTION_NOT_EXPLICIT"
        }

        val externalId = "qa-hub-human-$attemptId"
        val registered = executeJson(
            method = "POST",
            relativePath = "/projects/$projectId/builds",
            accessToken = accessToken,
            idempotencyKey =
                "build:register:project:$projectId:provider:manual:external:$externalId",
            expectedStatuses = setOf(201),
            body = buildRegistrationBody(
                projectId = projectId,
                projectKey = projectKey,
                attemptId = attemptId,
                externalId = externalId,
                branch = branch,
                commitSha = deliveredCommitSha,
            ),
        ).body
        val registeredBuild = registered.optJSONObject("build") ?: registered
        val buildId = registeredBuild.requireRepairString("id")
        val buildVersion = registeredBuild.optInt("version", -1)
        require(registeredBuild.optString("sourceCommitSha") == deliveredCommitSha) {
            "BUILD_IDENTITY_MISMATCH"
        }
        require(registeredBuild.optString("status") == "ready" && buildVersion > 0) {
            "BUILD_NOT_READY"
        }

        val readBack = executeJson(
            method = "GET",
            relativePath = "/builds/$buildId",
            accessToken = accessToken,
            idempotencyKey = null,
            expectedStatuses = setOf(200),
            body = null,
        ).body
        val readBackBuild = readBack.optJSONObject("build") ?: readBack
        require(
            readBackBuild.optString("id") == buildId &&
                readBackBuild.optString("sourceCommitSha") == deliveredCommitSha &&
                readBackBuild.optString("status") == "ready"
        ) {
            "BUILD_READBACK_MISMATCH"
        }

        val link = executeJson(
            method = "POST",
            relativePath = "/builds/$buildId/link-repair",
            accessToken = accessToken,
            idempotencyKey = "build:link:$buildId:attempt:$attemptId:v$buildVersion",
            expectedStatuses = setOf(200),
            body = JSONObject()
                .put("expectedVersion", buildVersion)
                .put("expectedBugVersion", EXPECTED_NEW_BUG_DELIVERY_VERSION)
                .put("expectedBuildRequirementVersion", 1)
                .put("repairAttemptId", attemptId)
                .put("deliveredCommitSha", deliveredCommitSha)
                .put("evidenceType", "manifest"),
        ).body
        val linkedBug = link.optJSONObject("bug")
            ?: throw RepairAttemptFailure("LINK_BUG_MISSING")
        val requirement = link.optJSONObject("buildRequirement")
            ?: throw RepairAttemptFailure("LINK_REQUIREMENT_MISSING")
        val repairLink = link.optJSONObject("repairLink")
            ?: throw RepairAttemptFailure("REPAIR_LINK_MISSING")
        require(linkedBug.optString("state") == "ready_for_verification") {
            "BUG_NOT_READY_FOR_VERIFICATION"
        }
        require(
            requirement.optString("repairAttemptId") == attemptId &&
                requirement.optString("linkedBuildId") == buildId &&
                requirement.optString("deliveredCommitSha") == deliveredCommitSha
        ) {
            "BUILD_REQUIREMENT_LINK_MISMATCH"
        }
        require(
            repairLink.optString("repairAttemptId") == attemptId &&
                repairLink.optString("buildId") == buildId &&
                repairLink.optString("deliveredCommitSha") == deliveredCommitSha
        ) {
            "REPAIR_LINK_MISMATCH"
        }

        HumanRepairBuildResult(
            attemptId = attemptId,
            deliveredCommitSha = deliveredCommitSha,
            buildId = buildId,
            buildStatus = readBackBuild.requireRepairString("status"),
            bugState = linkedBug.requireRepairString("state"),
            wrongShaRejectionCode = wrongShaRejectionCode,
        )
    }

    private fun buildRegistrationBody(
        projectId: String,
        projectKey: String,
        attemptId: String,
        externalId: String,
        branch: String,
        commitSha: String,
    ): JSONObject {
        val artifactSha =
            "qa-hub-human-artifact-v1|$projectId|$externalId|$commitSha".digestHex("SHA-256")
        val providerDigest =
            "qa-hub-human-provider-v1|$projectId|$externalId|$commitSha".digestHex("SHA-256")
        return JSONObject()
            .put("provider", "manual")
            .put("externalId", externalId)
            .put("version", BuildConfig.VERSION_NAME)
            .put("channel", "qa")
            .put("projectKey", projectKey)
            .put("branch", branch)
            .put("sourceCommitSha", commitSha)
            .put("mode", "debug")
            .put("status", "ready")
            .put("repairAttemptId", attemptId)
            .put("downloadUrl", "https://qa-hub.local/qa-builds/$externalId.apk")
            .put(
                "manifest",
                JSONObject()
                    .put("commitShas", JSONArray().put(commitSha))
                    .put("artifactSha256", artifactSha)
                    .put("providerPayloadDigest", providerDigest),
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

    private fun validateAttemptState(
        value: JSONObject,
        attemptId: String,
        status: String,
        version: Int,
    ) {
        require(value.optString("id") == attemptId) { "REPAIR_ATTEMPT_ID_MISMATCH" }
        require(value.optString("mode") == "human") { "REPAIR_ATTEMPT_MODE_MISMATCH" }
        require(value.optString("status") == status) { "REPAIR_ATTEMPT_STATUS_MISMATCH" }
        require(value.optInt("version", -1) == version) { "REPAIR_ATTEMPT_VERSION_MISMATCH" }
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
        const val EXPECTED_NEW_BUG_DELIVERY_VERSION = 4
        const val WRONG_COMMIT_SHA = "ffffffffffffffffffffffffffffffffffffffff"
        const val ALTERNATE_WRONG_COMMIT_SHA = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "::1")
        val PROJECT_KEY_PATTERN = Regex("^[A-Z][A-Z0-9]{1,15}$")
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

data class HumanRepairBuildResult(
    val attemptId: String,
    val deliveredCommitSha: String,
    val buildId: String,
    val buildStatus: String,
    val bugState: String,
    val wrongShaRejectionCode: String,
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

private fun String.digestHex(algorithm: String): String = MessageDigest.getInstance(algorithm)
    .digest(toByteArray(Charsets.UTF_8))
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
