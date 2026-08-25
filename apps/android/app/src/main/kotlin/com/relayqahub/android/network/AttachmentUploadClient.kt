package com.relayqahub.android.network

import com.relayqahub.android.data.AccountProjectScope
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.OffsetDateTime
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

data class AttachmentUploadReceipt(
    val clientSubmissionId: String,
    val clientAttachmentId: String,
    val attachmentId: String,
    val bindingId: String,
    val bindingStatus: String,
    val uploadVersion: Int,
    val bindingVersion: Int,
    val responseJson: String,
)

class AttachmentUploadFailure(val code: String) : IOException(code)

/**
 * Minimal native transport for the frozen 1.1 attachment path.
 *
 * The durable P3.4 resumable-media queue is intentionally separate. This client proves the real
 * adjacent HTTP path while preserving the canonical submission/attachment idempotency identities.
 */
class AttachmentUploadClient(
    baseUrl: String,
    httpClient: OkHttpClient,
    allowLoopbackHttp: Boolean = false,
) {
    private val apiBaseUrl: HttpUrl = baseUrl.toHttpUrl().let { parsed ->
        require(parsed.username.isEmpty() && parsed.password.isEmpty()) {
            "QA Hub API base URL must not embed credentials"
        }
        val isAllowedLoopbackHttp =
            allowLoopbackHttp && parsed.scheme == "http" && parsed.host in LOOPBACK_HOSTS
        require(parsed.isHttps || isAllowedLoopbackHttp) {
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
    private val httpClient = httpClient.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .build()

    suspend fun uploadAndReserveBugCreate(
        scope: AccountProjectScope,
        clientSubmissionId: String,
        clientAttachmentId: String,
        filename: String,
        pngBytes: ByteArray,
        accessToken: String,
    ): AttachmentUploadReceipt = withContext(Dispatchers.IO) {
        requireUuid(scope.projectId, "projectId")
        requireUuid(clientSubmissionId, "clientSubmissionId")
        requireUuid(clientAttachmentId, "clientAttachmentId")
        require(filename.isNotBlank() && filename.length <= 255)
        require(pngBytes.isNotEmpty() && pngBytes.size <= MAX_SMOKE_PNG_BYTES)
        require(accessToken.isNotBlank())

        val sha256 = pngBytes.sha256Hex()
        val initKey =
            "submission:$clientSubmissionId:attachment:$clientAttachmentId:" +
                "upload:$UPLOAD_ATTEMPT:init"
        val initBody = JSONObject()
            .put("submissionContractVersion", QaHubApiContract.VERSION)
            .put("projectId", scope.projectId)
            .put("clientSubmissionId", clientSubmissionId)
            .put("clientAttachmentId", clientAttachmentId)
            .put("uploadAttempt", UPLOAD_ATTEMPT)
            .put("filename", filename)
            .put("mediaType", PNG_MEDIA_TYPE_VALUE)
            .put("expectedSize", pngBytes.size)
            .put("sha256", sha256)
            .toString()
        val init = executeJson(
            request = jsonRequest(
                relativePath = "/uploads/init",
                method = "POST",
                body = initBody,
                accessToken = accessToken,
                idempotencyKey = initKey,
            ),
            expectedStatus = 201,
            stage = "INIT",
        )
        val sessionId = init.requiredUuid("sessionId")
        init.requireString("projectId", scope.projectId)
        init.requireString("clientSubmissionId", clientSubmissionId)
        init.requireString("clientAttachmentId", clientAttachmentId)
        init.requireInt("uploadAttempt", UPLOAD_ATTEMPT)
        init.requireString("status", "open")
        init.requireString("filename", filename)
        init.requireString("mediaType", PNG_MEDIA_TYPE_VALUE)
        init.requireInt("expectedSize", pngBytes.size)
        init.requireString("sha256", sha256)
        init.requireInt("expectedChunkCount", 1)
        init.requireInt("receivedBytes", 0)
        init.requireInt("version", INIT_VERSION)
        if (!init.isNull("attachmentId")) throw AttachmentUploadFailure("INIT_ATTACHMENT_PRESENT")

        val chunkKey =
            "submission:$clientSubmissionId:attachment:$clientAttachmentId:" +
                "upload:$UPLOAD_ATTEMPT:chunk:0"
        val chunkRequest = Request.Builder()
            .url(resolve("/uploads/$sessionId/chunks/0"))
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .header("Idempotency-Key", chunkKey)
            .header("If-Match", quotedVersion(INIT_VERSION))
            .header("Content-Length", pngBytes.size.toString())
            .header("X-Chunk-SHA256", sha256)
            .header("X-Client-Submission-Id", clientSubmissionId)
            .header("X-Client-Attachment-Id", clientAttachmentId)
            .put(pngBytes.toRequestBody(OCTET_STREAM_MEDIA_TYPE))
            .build()
        httpClient.newCall(chunkRequest).execute().use { response ->
            if (response.code != 204) throw response.asUploadFailure("CHUNK")
            if (response.header("ETag") != quotedVersion(CHUNK_VERSION)) {
                throw AttachmentUploadFailure("CHUNK_ETAG_MISMATCH")
            }
            if (response.header("X-Upload-Version") != CHUNK_VERSION.toString()) {
                throw AttachmentUploadFailure("CHUNK_VERSION_MISMATCH")
            }
        }

        val finalizeKey =
            "submission:$clientSubmissionId:attachment:$clientAttachmentId:" +
                "upload:$UPLOAD_ATTEMPT:finalize"
        val finalizeBody = JSONObject()
            .put("submissionContractVersion", QaHubApiContract.VERSION)
            .put("expectedVersion", CHUNK_VERSION)
            .put("clientSubmissionId", clientSubmissionId)
            .put("clientAttachmentId", clientAttachmentId)
            .put("uploadAttempt", UPLOAD_ATTEMPT)
            .put("sha256", sha256)
            .put("expectedSize", pngBytes.size)
            .toString()
        val finalized = executeJson(
            request = jsonRequest(
                relativePath = "/uploads/$sessionId/finalize",
                method = "POST",
                body = finalizeBody,
                accessToken = accessToken,
                idempotencyKey = finalizeKey,
            ),
            expectedStatus = 200,
            stage = "FINALIZE",
        )
        val attachmentId = finalized.requiredUuid("attachmentId")
        finalized.requireString("sessionId", sessionId)
        finalized.requireString("projectId", scope.projectId)
        finalized.requireString("clientSubmissionId", clientSubmissionId)
        finalized.requireString("clientAttachmentId", clientAttachmentId)
        finalized.requireString("sha256", sha256)
        finalized.requireInt("size", pngBytes.size)
        finalized.requireString("scanStatus", "clean")
        finalized.requireBoolean("readyToBind", true)
        finalized.requireString("bindingStatus", "unbound")
        finalized.requireInt("version", FINALIZE_VERSION)

        val bindKey =
            "submission:$clientSubmissionId:attachment:$clientAttachmentId:" +
                "bind:$LEASE_GENERATION"
        val bindBody = JSONObject()
            .put("submissionContractVersion", QaHubApiContract.VERSION)
            .put("expectedVersion", FINALIZE_VERSION)
            .put("projectId", scope.projectId)
            .put("clientSubmissionId", clientSubmissionId)
            .put("clientAttachmentId", clientAttachmentId)
            .put("leaseGeneration", LEASE_GENERATION)
            .put("intent", "bug_create")
            .toString()
        val binding = executeJson(
            request = jsonRequest(
                relativePath = "/attachments/$attachmentId/bind",
                method = "POST",
                body = bindBody,
                accessToken = accessToken,
                idempotencyKey = bindKey,
            ),
            expectedStatus = 200,
            stage = "BIND",
        )
        val bindingId = binding.requiredUuid("bindingId")
        binding.requireString("attachmentId", attachmentId)
        binding.requireString("projectId", scope.projectId)
        binding.requireString("clientSubmissionId", clientSubmissionId)
        binding.requireString("clientAttachmentId", clientAttachmentId)
        binding.requireInt("leaseGeneration", LEASE_GENERATION)
        binding.requireString("intent", "bug_create")
        binding.requireString("status", "reserved")
        binding.requireInt("version", BIND_VERSION)
        if (!binding.isNull("targetQaItemId")) {
            throw AttachmentUploadFailure("BIND_TARGET_MUST_BE_NULL")
        }
        OffsetDateTime.parse(binding.getString("expiresAt"))

        AttachmentUploadReceipt(
            clientSubmissionId = clientSubmissionId,
            clientAttachmentId = clientAttachmentId,
            attachmentId = attachmentId,
            bindingId = bindingId,
            bindingStatus = "reserved",
            uploadVersion = FINALIZE_VERSION,
            bindingVersion = BIND_VERSION,
            responseJson = binding.toString(),
        )
    }

    private fun jsonRequest(
        relativePath: String,
        method: String,
        body: String,
        accessToken: String,
        idempotencyKey: String,
    ): Request = Request.Builder()
        .url(resolve(relativePath))
        .header("Accept", QaHubApiContract.JSON_ACCEPT)
        .header("Authorization", "Bearer $accessToken")
        .header("Idempotency-Key", idempotencyKey)
        .method(method, body.toRequestBody(VERSIONED_JSON_MEDIA_TYPE))
        .build()

    private fun executeJson(
        request: Request,
        expectedStatus: Int,
        stage: String,
    ): JSONObject {
        return httpClient.newCall(request).execute().use { response ->
            if (response.code != expectedStatus) throw response.asUploadFailure(stage)
            val body = response.body ?: throw AttachmentUploadFailure("MISSING_SUCCESS_BODY")
            val mediaType = body.contentType()
                ?: throw AttachmentUploadFailure("MISSING_SUCCESS_MEDIA_TYPE")
            if (
                "${mediaType.type}/${mediaType.subtype}" != QaHubApiContract.VERSIONED_JSON ||
                mediaType.charset(StandardCharsets.UTF_8) != StandardCharsets.UTF_8
            ) {
                throw AttachmentUploadFailure("INVALID_SUCCESS_MEDIA_TYPE")
            }
            val bodyBytes = body.bytes()
            if (bodyBytes.size > MAX_SUCCESS_BODY_BYTES) {
                throw AttachmentUploadFailure("SUCCESS_BODY_TOO_LARGE")
            }
            JSONObject(String(bodyBytes, StandardCharsets.UTF_8))
        }
    }

    private fun resolve(relativePath: String): HttpUrl =
        QaHubRelativePath.resolve(apiBaseUrl, relativePath)

    private fun okhttp3.Response.asUploadFailure(stage: String): AttachmentUploadFailure =
        AttachmentUploadFailure("${stage}_HTTP_${code}")

    private companion object {
        const val API_BASE_PATH = "/api/v1/"
        const val PNG_MEDIA_TYPE_VALUE = "image/png"
        const val UPLOAD_ATTEMPT = 1
        const val LEASE_GENERATION = 1
        const val INIT_VERSION = 1
        const val CHUNK_VERSION = 2
        const val FINALIZE_VERSION = 3
        const val BIND_VERSION = 4
        const val MAX_SUCCESS_BODY_BYTES = 256 * 1024
        const val MAX_SMOKE_PNG_BYTES = 20 * 1024 * 1024
        val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "::1")
        val VERSIONED_JSON_MEDIA_TYPE = QaHubApiContract.VERSIONED_JSON.toMediaType()
        val OCTET_STREAM_MEDIA_TYPE = "application/octet-stream".toMediaType()
    }
}

private fun quotedVersion(version: Int): String = "\"$version\""

private fun ByteArray.sha256Hex(): String = MessageDigest.getInstance("SHA-256")
    .digest(this)
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

private fun requireUuid(value: String, label: String): String = value.also {
    require(runCatching { UUID.fromString(value) }.isSuccess) { "$label must be a UUID" }
}

private fun JSONObject.requiredUuid(key: String): String = getString(key).also {
    if (runCatching { UUID.fromString(it) }.isFailure) {
        throw AttachmentUploadFailure("INVALID_${key.uppercase()}_UUID")
    }
}

private fun JSONObject.requireString(key: String, expected: String) {
    if (!has(key) || isNull(key) || getString(key) != expected) {
        throw AttachmentUploadFailure("${key.uppercase()}_MISMATCH")
    }
}

private fun JSONObject.requireInt(key: String, expected: Int) {
    if (!has(key) || optInt(key, Int.MIN_VALUE) != expected) {
        throw AttachmentUploadFailure("${key.uppercase()}_MISMATCH")
    }
}

private fun JSONObject.requireBoolean(key: String, expected: Boolean) {
    if (!has(key) || optBoolean(key) != expected) {
        throw AttachmentUploadFailure("${key.uppercase()}_MISMATCH")
    }
}
