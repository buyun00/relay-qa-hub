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

/**
 * Native, human-authorized projection of an exact delivered commit into a QA Hub Build.
 *
 * The UI action is limited to Build registration and a server read-back.
 */
class BuildProjectionClient(
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

    /**
     * Registers a manual ready Build for the exact delivered Relay commit, then reads it back
     * from QA Hub. This is intentionally not a verification, close, start, deliver, or link
     * action; those remain separate server-owned workflow actions.
     */
    suspend fun adoptFixAndBindQaBuild(
        projectId: String,
        projectKey: String,
        handoff: RelayHandoffResult,
        accessToken: String,
        deliveredCommitShaOverride: String? = null,
    ): BuildProjectionResult = withContext(Dispatchers.IO) {
        requireUuid(projectId, "projectId")
        require(projectKey.matches(PROJECT_KEY_PATTERN)) { "projectKey must be uppercase" }
        require(accessToken.isNotBlank())
        if (handoff.handoffStatus != "fix_delivered") {
            throw BuildProjectionFailure("BUILD_ADOPTION_REQUIRES_FIX_DELIVERED")
        }
        val deliveredSha = handoff.deliveredCommitSha
            ?.takeIf { it.matches(COMMIT_SHA_PATTERN) }
            ?: throw BuildProjectionFailure("BUILD_DELIVERED_COMMIT_MISSING")
        val adoptionSha = deliveredCommitShaOverride ?: deliveredSha
        if (!adoptionSha.matches(COMMIT_SHA_PATTERN)) {
            throw BuildProjectionFailure("BUILD_DELIVERED_COMMIT_INVALID")
        }
        val deliveryBranch = handoff.deliveredBranch ?: DEFAULT_DELIVERY_BRANCH

        val externalId = "qa-hub-native-${handoff.handoffId}"
        val artifactSha256 =
            "qa-hub-fake-artifact-v1|$projectId|$externalId|$adoptionSha".sha256Hex()
        val providerPayloadDigest =
            "qa-hub-fake-provider-v1|$projectId|$externalId|$adoptionSha".sha256Hex()
        val manifest = JSONObject()
            .put("commitShas", JSONArray().put(adoptionSha))
            .put("artifactSha256", artifactSha256)
            .put("providerPayloadDigest", providerPayloadDigest)
        val registered = executeJson(
            method = "POST",
            relativePath = "/projects/$projectId/builds",
            accessToken = accessToken,
            idempotencyKey =
                "build:register:project:$projectId:provider:manual:external:$externalId",
            expectedStatus = 201,
            body = JSONObject()
                .put("provider", "manual")
                .put("externalId", externalId)
                .put("version", BuildConfig.VERSION_NAME)
                .put("channel", "qa")
                .put("projectKey", projectKey)
                .put("branch", deliveryBranch)
                .put("sourceCommitSha", adoptionSha)
                .put("mode", "debug")
                .put("status", "ready")
                .put("downloadUrl", "https://qa-hub.local/qa-builds/$externalId.apk")
                .put("manifest", manifest),
        )
        val registeredBuild = registered.optJSONObject("build") ?: registered
        val registeredBuildId = registeredBuild.requireString("id")
        val registeredSha = registeredBuild.optString("sourceCommitSha")
        if (registeredSha.isNotBlank() && registeredSha != adoptionSha) {
            throw BuildProjectionFailure("BUILD_IDENTITY_MISMATCH")
        }
        val registeredBuildVersion = registeredBuild.optionalInt("version")
            ?: throw BuildProjectionFailure("BUILD_RESPONSE_VERSION_MISSING")
        val readBack = executeJson(
            method = "GET",
            relativePath = "/builds/$registeredBuildId",
            accessToken = accessToken,
            idempotencyKey = null,
            expectedStatus = 200,
            body = null,
        )
        val readBackBuild = readBack.optJSONObject("build") ?: readBack
        val readBackId = readBackBuild.requireString("id")
        if (readBackId != registeredBuildId) {
            throw BuildProjectionFailure("BUILD_READBACK_ID_MISMATCH")
        }
        val readBackSha = readBackBuild.requireString("sourceCommitSha")
        if (readBackSha != adoptionSha) {
            throw BuildProjectionFailure("BUILD_IDENTITY_MISMATCH")
        }
        val readBackStatus = readBackBuild.requireString("status")
        if (readBackStatus != "ready") {
            throw BuildProjectionFailure("BUILD_READBACK_NOT_READY")
        }
        BuildProjectionResult(
            buildId = readBackId,
            deliveredCommitSha = readBackSha,
            status = readBackStatus,
            linked = false,
            buildVersion = registeredBuildVersion,
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
            ?: throw BuildProjectionFailure("INVALID_BUILD_PATH")
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
            throw BuildProjectionFailure("NETWORK_IO")
        }
        response.use { result ->
            val responseBody = result.body?.byteStream()?.use {
                it.readBoundedUtf8(MAX_RESPONSE_BYTES)
            }.orEmpty()
            if (responseBody.toByteArray(Charsets.UTF_8).size > MAX_RESPONSE_BYTES) {
                throw BuildProjectionFailure("RESPONSE_TOO_LARGE")
            }
            if (result.code != expectedStatus) {
                val errorCode = runCatching { JSONObject(responseBody).errorCode() }
                    .getOrNull().orEmpty()
                throw BuildProjectionFailure(
                    if (errorCode.isBlank()) "HTTP_${result.code}" else errorCode,
                )
            }
            if (responseBody.isBlank()) throw BuildProjectionFailure("EMPTY_BUILD_RESPONSE")
            return try {
                JSONObject(responseBody)
            } catch (_: RuntimeException) {
                throw BuildProjectionFailure("INVALID_BUILD_RESPONSE")
            }
        }
    }

    private companion object {
        const val API_BASE_PATH = "/api/v1/"
        const val MAX_RESPONSE_BYTES = 256 * 1024
        const val DEFAULT_DELIVERY_BRANCH = "qa-hub/fake-delivery"
        val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "::1")
        val COMMIT_SHA_PATTERN = Regex("^[0-9a-f]{40}$")
        val PROJECT_KEY_PATTERN = Regex("^[A-Z][A-Z0-9]{1,15}$")
    }
}

data class BuildProjectionResult(
    val buildId: String,
    val deliveredCommitSha: String,
    val status: String,
    val linked: Boolean,
    val buildVersion: Int,
)

class BuildProjectionFailure(val code: String) : RuntimeException()

private fun JSONObject.requireString(key: String): String = optString(key).also {
    require(it.isNotBlank()) { "BUILD_RESPONSE_MISSING_$key" }
}

private fun JSONObject.optionalInt(key: String): Int? = if (isNull(key) || !has(key)) {
    null
} else {
    optInt(key).takeIf { it > 0 }
}

private fun JSONObject.errorCode(): String {
    val nested = optJSONObject("error")
    return nested?.optString("code").orEmpty()
        .ifBlank { optString("code") }
        .ifBlank { optString("errorCode") }
}

private fun requireUuid(value: String, label: String) {
    require(runCatching { UUID.fromString(value) }.isSuccess) {
        "$label must be a UUID"
    }
}

private fun InputStream.readBoundedUtf8(maxBytes: Int): String {
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

private fun String.sha256Hex(): String = MessageDigest.getInstance("SHA-256")
    .digest(toByteArray(Charsets.UTF_8))
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
