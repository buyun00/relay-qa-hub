package com.relayqahub.android.network

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

/** Read-only native projection of the latest persisted human QA workflow. */
class HumanWorkflowClient(
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

    suspend fun readLatest(
        projectId: String,
        accessToken: String,
    ): HumanWorkflowProjection = withContext(Dispatchers.IO) {
        requireUuid(projectId, "projectId")
        require(accessToken.isNotBlank())
        val url = apiBaseUrl.resolve("projects/$projectId/human-workflows/latest")
            ?: throw HumanWorkflowFailure("INVALID_HUMAN_WORKFLOW_PATH")
        val request = Request.Builder()
            .url(url)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .get()
            .build()
        val response = try {
            httpClient.newCall(request).execute()
        } catch (_: IOException) {
            throw HumanWorkflowFailure("NETWORK_IO")
        }
        response.use { result ->
            val body = result.body?.byteStream()
                ?.use { it.readHumanWorkflowUtf8(MAX_RESPONSE_BYTES) }
                .orEmpty()
            if (body.toByteArray(Charsets.UTF_8).size > MAX_RESPONSE_BYTES) {
                throw HumanWorkflowFailure("RESPONSE_TOO_LARGE", result.code)
            }
            if (result.code != 200) {
                val error = runCatching { JSONObject(body) }.getOrNull()
                val code = error?.optString("code").orEmpty().ifBlank {
                    error?.optJSONObject("error")?.optString("code").orEmpty()
                }
                throw HumanWorkflowFailure(code.ifBlank { "HTTP_${result.code}" }, result.code)
            }
            parseProjection(body, projectId)
        }
    }

    private fun parseProjection(body: String, projectId: String): HumanWorkflowProjection {
        val root = try {
            JSONObject(body)
        } catch (_: RuntimeException) {
            throw HumanWorkflowFailure("INVALID_HUMAN_WORKFLOW_RESPONSE")
        }
        val workflow = root.optJSONObject("workflow")
            ?: throw HumanWorkflowFailure("HUMAN_WORKFLOW_MISSING")
        if (workflow.requireWorkflowString("projectId") != projectId) {
            throw HumanWorkflowFailure("HUMAN_WORKFLOW_PROJECT_MISMATCH")
        }
        val bug = workflow.requireWorkflowObject("bug")
        val attempt = workflow.requireWorkflowObject("repairAttempt")
        val build = workflow.requireWorkflowObject("build")
        val verification = workflow.requireWorkflowObject("verification")
        val closure = workflow.requireWorkflowObject("closure")
        val bugId = bug.requireWorkflowUuid("id")
        val attemptId = attempt.requireWorkflowUuid("id")
        val buildId = build.requireWorkflowUuid("id")
        val verificationId = verification.requireWorkflowUuid("id")
        val closureVerificationId = closure.requireWorkflowUuid("verificationId")
        val deliveredCommitSha = attempt.requireWorkflowString("deliveredCommitSha")
        val sourceCommitSha = build.requireWorkflowString("sourceCommitSha")
        val bugVersion = bug.optInt("version", -1)
        val verificationVersion = verification.optInt("version", -1)
        val acceptedBugVersion = closure.optInt("acceptedBugVersion", -1)
        if (
            bug.requireWorkflowString("state") != "closed" ||
            attempt.requireWorkflowString("mode") != "human" ||
            verification.requireWorkflowString("status") != "passed" ||
            closureVerificationId != verificationId ||
            sourceCommitSha != deliveredCommitSha ||
            bugVersion < 1 ||
            verificationVersion < 1 ||
            acceptedBugVersion != bugVersion
        ) {
            throw HumanWorkflowFailure("INCONSISTENT_HUMAN_WORKFLOW_RESPONSE")
        }
        return HumanWorkflowProjection(
            projectId = projectId,
            bugId = bugId,
            bugKey = bug.requireWorkflowString("key"),
            bugState = bug.requireWorkflowString("state"),
            bugVersion = bugVersion,
            repairAttemptId = attemptId,
            repairAttemptStatus = attempt.requireWorkflowString("status"),
            deliveredCommitSha = deliveredCommitSha,
            buildId = buildId,
            buildStatus = build.requireWorkflowString("status"),
            sourceCommitSha = sourceCommitSha,
            verificationId = verificationId,
            verificationStatus = verification.requireWorkflowString("status"),
            verificationVersion = verificationVersion,
            resultSummary = verification.requireWorkflowString("resultSummary"),
            closeEventId = closure.requireWorkflowUuid("closeEventId"),
            acceptedBugVersion = acceptedBugVersion,
            acceptedState = closure.requireWorkflowString("acceptedState"),
        )
    }

    private companion object {
        const val API_BASE_PATH = "/api/v1/"
        const val MAX_RESPONSE_BYTES = 256 * 1024
        val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "::1")
    }
}

data class HumanWorkflowProjection(
    val projectId: String,
    val bugId: String,
    val bugKey: String,
    val bugState: String,
    val bugVersion: Int,
    val repairAttemptId: String,
    val repairAttemptStatus: String,
    val deliveredCommitSha: String,
    val buildId: String,
    val buildStatus: String,
    val sourceCommitSha: String,
    val verificationId: String,
    val verificationStatus: String,
    val verificationVersion: Int,
    val resultSummary: String,
    val closeEventId: String,
    val acceptedBugVersion: Int,
    val acceptedState: String,
)

class HumanWorkflowFailure(
    val code: String,
    val httpStatus: Int? = null,
) : RuntimeException(code)

private fun JSONObject.requireWorkflowObject(key: String): JSONObject = optJSONObject(key)
    ?: throw HumanWorkflowFailure("HUMAN_WORKFLOW_${key.uppercase()}_MISSING")

private fun JSONObject.requireWorkflowString(key: String): String = optString(key).also {
    if (it.isBlank()) throw HumanWorkflowFailure("HUMAN_WORKFLOW_${key.uppercase()}_MISSING")
}

private fun JSONObject.requireWorkflowUuid(key: String): String = requireWorkflowString(key).also {
    requireUuid(it, key)
}

private fun requireUuid(value: String, label: String) {
    if (runCatching { UUID.fromString(value) }.isFailure) {
        throw HumanWorkflowFailure("HUMAN_WORKFLOW_${label.uppercase()}_INVALID")
    }
}

private fun InputStream.readHumanWorkflowUtf8(maxBytes: Int): String {
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
