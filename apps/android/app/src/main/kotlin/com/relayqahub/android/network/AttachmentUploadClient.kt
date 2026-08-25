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
import org.json.JSONArray
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

data class CaptureAttachmentReceipt(
    val clientAttachmentId: String,
    val attachmentId: String,
    val filename: String,
    val mediaType: String,
    val size: Int,
    val sha256: String,
)

data class CaptureBundleArtifactUpload(
    val kind: String,
    val attachment: CaptureAttachmentReceipt,
    val startedAtEpochMs: Long,
    val endedAtEpochMs: Long,
    val truncated: Boolean,
)

data class CaptureBundlePocoInput(
    val attempted: Boolean,
    val connectedPort: Int?,
    val sdkVersion: String?,
    val screenWidth: Int?,
    val screenHeight: Int?,
    val negotiatedMethods: List<String>,
    val succeededMethods: List<String>,
    val failureReason: String?,
)

data class CaptureBundleDeviceInput(
    val manufacturer: String,
    val model: String,
    val androidApi: Int,
    val androidRelease: String,
    val qaAppVersion: String,
)

data class CaptureBundleReceipt(
    val captureId: String,
    val enrichmentStatus: String,
    val artifactAttachmentIds: List<String>,
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
        captureId: String? = null,
    ): AttachmentUploadReceipt = withContext(Dispatchers.IO) {
        requireUuid(scope.projectId, "projectId")
        requireUuid(clientSubmissionId, "clientSubmissionId")
        requireUuid(clientAttachmentId, "clientAttachmentId")
        captureId?.let { requireUuid(it, "captureId") }
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
            .apply { captureId?.let { put("captureId", it) } }
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
        if (captureId == null) {
            if (!init.isNull("captureId")) throw AttachmentUploadFailure("INIT_CAPTURE_PRESENT")
        } else {
            init.requireString("captureId", captureId)
        }
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
        if (captureId == null) {
            if (!finalized.isNull("captureId")) {
                throw AttachmentUploadFailure("FINALIZE_CAPTURE_PRESENT")
            }
        } else {
            finalized.requireString("captureId", captureId)
        }
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

    suspend fun uploadCaptureArtifact(
        scope: AccountProjectScope,
        clientSubmissionId: String,
        clientAttachmentId: String,
        filename: String,
        mediaType: String,
        contentBytes: ByteArray,
        accessToken: String,
        captureId: String,
    ): CaptureAttachmentReceipt = withContext(Dispatchers.IO) {
        requireUuid(scope.projectId, "projectId")
        requireUuid(clientSubmissionId, "clientSubmissionId")
        requireUuid(clientAttachmentId, "clientAttachmentId")
        requireUuid(captureId, "captureId")
        require(filename.isNotBlank() && filename.length <= 255)
        require(mediaType in CAPTURE_ARTIFACT_MEDIA_TYPES)
        require(contentBytes.isNotEmpty() && contentBytes.size <= MAX_SINGLE_CHUNK_ARTIFACT_BYTES)
        require(accessToken.isNotBlank())

        val sha256 = contentBytes.sha256Hex()
        val initKey =
            "submission:$clientSubmissionId:attachment:$clientAttachmentId:" +
                "upload:$UPLOAD_ATTEMPT:init"
        val init = executeJson(
            request = jsonRequest(
                relativePath = "/uploads/init",
                method = "POST",
                body = JSONObject()
                    .put("submissionContractVersion", QaHubApiContract.VERSION)
                    .put("projectId", scope.projectId)
                    .put("clientSubmissionId", clientSubmissionId)
                    .put("clientAttachmentId", clientAttachmentId)
                    .put("uploadAttempt", UPLOAD_ATTEMPT)
                    .put("filename", filename)
                    .put("mediaType", mediaType)
                    .put("expectedSize", contentBytes.size)
                    .put("sha256", sha256)
                    .put("captureId", captureId)
                    .toString(),
                accessToken = accessToken,
                idempotencyKey = initKey,
            ),
            expectedStatus = 201,
            stage = "ARTIFACT_INIT",
        )
        val sessionId = init.requiredUuid("sessionId")
        init.requireString("projectId", scope.projectId)
        init.requireString("clientSubmissionId", clientSubmissionId)
        init.requireString("clientAttachmentId", clientAttachmentId)
        init.requireString("filename", filename)
        init.requireString("mediaType", mediaType)
        init.requireString("captureId", captureId)
        init.requireString("sha256", sha256)
        init.requireInt("expectedSize", contentBytes.size)
        init.requireInt("expectedChunkCount", 1)
        init.requireInt("version", INIT_VERSION)

        val chunkKey =
            "submission:$clientSubmissionId:attachment:$clientAttachmentId:" +
                "upload:$UPLOAD_ATTEMPT:chunk:0"
        val chunkRequest = Request.Builder()
            .url(resolve("/uploads/$sessionId/chunks/0"))
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .header("Idempotency-Key", chunkKey)
            .header("If-Match", quotedVersion(INIT_VERSION))
            .header("Content-Length", contentBytes.size.toString())
            .header("X-Chunk-SHA256", sha256)
            .header("X-Client-Submission-Id", clientSubmissionId)
            .header("X-Client-Attachment-Id", clientAttachmentId)
            .put(contentBytes.toRequestBody(OCTET_STREAM_MEDIA_TYPE))
            .build()
        httpClient.newCall(chunkRequest).execute().use { response ->
            if (response.code != 204) throw response.asUploadFailure("ARTIFACT_CHUNK")
            if (response.header("ETag") != quotedVersion(CHUNK_VERSION)) {
                throw AttachmentUploadFailure("ARTIFACT_CHUNK_ETAG_MISMATCH")
            }
        }

        val finalizeKey =
            "submission:$clientSubmissionId:attachment:$clientAttachmentId:" +
                "upload:$UPLOAD_ATTEMPT:finalize"
        val finalized = executeJson(
            request = jsonRequest(
                relativePath = "/uploads/$sessionId/finalize",
                method = "POST",
                body = JSONObject()
                    .put("submissionContractVersion", QaHubApiContract.VERSION)
                    .put("expectedVersion", CHUNK_VERSION)
                    .put("clientSubmissionId", clientSubmissionId)
                    .put("clientAttachmentId", clientAttachmentId)
                    .put("uploadAttempt", UPLOAD_ATTEMPT)
                    .put("sha256", sha256)
                    .put("expectedSize", contentBytes.size)
                    .toString(),
                accessToken = accessToken,
                idempotencyKey = finalizeKey,
            ),
            expectedStatus = 200,
            stage = "ARTIFACT_FINALIZE",
        )
        val attachmentId = finalized.requiredUuid("attachmentId")
        finalized.requireString("sessionId", sessionId)
        finalized.requireString("projectId", scope.projectId)
        finalized.requireString("clientSubmissionId", clientSubmissionId)
        finalized.requireString("clientAttachmentId", clientAttachmentId)
        finalized.requireString("filename", filename)
        finalized.requireString("mediaType", mediaType)
        finalized.requireString("captureId", captureId)
        finalized.requireString("sha256", sha256)
        finalized.requireInt("size", contentBytes.size)
        finalized.requireString("scanStatus", "clean")
        finalized.requireInt("version", FINALIZE_VERSION)
        CaptureAttachmentReceipt(
            clientAttachmentId = clientAttachmentId,
            attachmentId = attachmentId,
            filename = filename,
            mediaType = mediaType,
            size = contentBytes.size,
            sha256 = sha256,
        )
    }

    suspend fun createCaptureBundleAndReadBack(
        scope: AccountProjectScope,
        clientSubmissionId: String,
        captureId: String,
        capturedAtEpochMs: Long,
        primaryAttachment: AttachmentUploadReceipt,
        artifacts: List<CaptureBundleArtifactUpload>,
        poco: CaptureBundlePocoInput,
        device: CaptureBundleDeviceInput,
        accessToken: String,
    ): CaptureBundleReceipt = withContext(Dispatchers.IO) {
        requireUuid(scope.projectId, "projectId")
        requireUuid(clientSubmissionId, "clientSubmissionId")
        requireUuid(captureId, "captureId")
        require(primaryAttachment.clientSubmissionId == clientSubmissionId)
        require(capturedAtEpochMs > 0L)
        require(artifacts.map { it.kind }.distinct().size == artifacts.size)
        require(poco.succeededMethods.all(poco.negotiatedMethods::contains))
        val capturedAt = java.time.Instant.ofEpochMilli(capturedAtEpochMs).toString()
        val systemArtifact = JSONObject()
            .put("captureId", captureId)
            .put("clientAttachmentId", primaryAttachment.clientAttachmentId)
            .put("attachmentId", primaryAttachment.attachmentId)
            .put("kind", "system_screenshot")
            .put("status", "succeeded")
            .put("startedAt", capturedAt)
            .put("endedAt", capturedAt)
            .put("skewMs", 0)
            .put("truncated", false)
            .put("failureReason", JSONObject.NULL)
        val artifactArray = JSONArray().put(systemArtifact)
        artifacts.forEach { artifact ->
            require(artifact.kind in POCO_ARTIFACT_KINDS)
            require(artifact.endedAtEpochMs >= artifact.startedAtEpochMs)
            val skewMs = kotlin.math.abs(artifact.startedAtEpochMs - capturedAtEpochMs)
            require(skewMs <= MAX_CAPTURE_SKEW_MS)
            artifactArray.put(
                JSONObject()
                    .put("captureId", captureId)
                    .put("clientAttachmentId", artifact.attachment.clientAttachmentId)
                    .put("attachmentId", artifact.attachment.attachmentId)
                    .put("kind", artifact.kind)
                    .put("status", "succeeded")
                    .put(
                        "startedAt",
                        java.time.Instant.ofEpochMilli(artifact.startedAtEpochMs).toString(),
                    )
                    .put(
                        "endedAt",
                        java.time.Instant.ofEpochMilli(artifact.endedAtEpochMs).toString(),
                    )
                    .put("skewMs", skewMs)
                    .put("truncated", artifact.truncated)
                    .put("failureReason", JSONObject.NULL),
            )
        }
        val screenSize = if (poco.screenWidth != null && poco.screenHeight != null) {
            JSONObject().put("width", poco.screenWidth).put("height", poco.screenHeight)
        } else {
            JSONObject.NULL
        }
        val pocoJson = JSONObject()
            .put("attempted", poco.attempted)
            .put("connectedPort", poco.connectedPort ?: JSONObject.NULL)
            .put("sdkVersion", poco.sdkVersion ?: JSONObject.NULL)
            .put(
                "snapshotCapability",
                if (poco.connectedPort == null) "not_probed" else "standard_only",
            )
            .put("screenSize", screenSize)
            .put("allowedReadOnlyMethods", JSONArray(ALLOWED_POCO_METHODS))
            .put("negotiatedMethods", JSONArray(poco.negotiatedMethods))
            .put("succeededMethods", JSONArray(poco.succeededMethods))
            .put("failureReason", poco.failureReason ?: JSONObject.NULL)
        val capture = JSONObject()
            .put("captureId", captureId)
            .put("clientSubmissionId", clientSubmissionId)
            .put("projectId", scope.projectId)
            .put("capturedAt", capturedAt)
            .put("source", "overlay_single_tap")
            .put("primaryEvidenceClientAttachmentId", primaryAttachment.clientAttachmentId)
            .put("primaryEvidenceAttachmentId", primaryAttachment.attachmentId)
            .put("artifacts", artifactArray)
            .put("poco", pocoJson)
            .put(
                "deviceMetadata",
                JSONObject()
                    .put("manufacturer", device.manufacturer)
                    .put("model", device.model)
                    .put("androidApi", device.androidApi)
                    .put("androidRelease", device.androidRelease)
                    .put("qaAppVersion", device.qaAppVersion)
                    .put("buildId", JSONObject.NULL)
                    .put("testSessionId", JSONObject.NULL)
                    .put("networkType", "other"),
            )
        val requestBody = JSONObject()
            .put("submissionContractVersion", QaHubApiContract.VERSION)
            .put("projectId", scope.projectId)
            .put("clientSubmissionId", clientSubmissionId)
            .put("capture", capture)
            .toString()
        val idempotencyKey = "submission:$clientSubmissionId:capture:$captureId"
        val created = executeJson(
            request = jsonRequest(
                relativePath = "/capture-bundles",
                method = "POST",
                body = requestBody,
                accessToken = accessToken,
                idempotencyKey = idempotencyKey,
            ),
            expectedStatus = 201,
            stage = "CAPTURE_CREATE",
        )
        val createdBundle = created.getJSONObject("captureBundle")
        val expectedAttachmentIds = artifacts.map { it.attachment.attachmentId }
        val createdReceipt = validateCaptureBundle(
            bundle = createdBundle,
            scope = scope,
            clientSubmissionId = clientSubmissionId,
            captureId = captureId,
            primaryAttachment = primaryAttachment,
            artifactAttachmentIds = expectedAttachmentIds,
        )
        val readRequest = Request.Builder()
            .url(resolve("/capture-bundles/$captureId"))
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .get()
            .build()
        val readBack = executeJson(readRequest, expectedStatus = 200, stage = "CAPTURE_READ")
        val readReceipt = validateCaptureBundle(
            bundle = readBack,
            scope = scope,
            clientSubmissionId = clientSubmissionId,
            captureId = captureId,
            primaryAttachment = primaryAttachment,
            artifactAttachmentIds = expectedAttachmentIds,
        )
        require(createdReceipt.enrichmentStatus == readReceipt.enrichmentStatus)
        readReceipt.copy(responseJson = readBack.toString())
    }

    private fun validateCaptureBundle(
        bundle: JSONObject,
        scope: AccountProjectScope,
        clientSubmissionId: String,
        captureId: String,
        primaryAttachment: AttachmentUploadReceipt,
        artifactAttachmentIds: List<String>,
    ): CaptureBundleReceipt {
        bundle.requireString("captureId", captureId)
        bundle.requireString("clientSubmissionId", clientSubmissionId)
        bundle.requireString("projectId", scope.projectId)
        bundle.requireString(
            "primaryEvidenceClientAttachmentId",
            primaryAttachment.clientAttachmentId,
        )
        bundle.requireString("primaryEvidenceAttachmentId", primaryAttachment.attachmentId)
        val enrichmentStatus = bundle.getString("enrichmentStatus")
        if (enrichmentStatus !in setOf("unavailable", "partial", "complete")) {
            throw AttachmentUploadFailure("CAPTURE_STATUS_INVALID")
        }
        val returnedIds = buildList {
            val returned = bundle.getJSONArray("artifacts")
            for (index in 0 until returned.length()) {
                val artifact = returned.getJSONObject(index)
                if (artifact.getString("kind") != "system_screenshot") {
                    add(artifact.requiredUuid("attachmentId"))
                }
            }
        }
        if (returnedIds.toSet() != artifactAttachmentIds.toSet()) {
            throw AttachmentUploadFailure("CAPTURE_ARTIFACTS_MISMATCH")
        }
        return CaptureBundleReceipt(
            captureId = captureId,
            enrichmentStatus = enrichmentStatus,
            artifactAttachmentIds = returnedIds,
            responseJson = bundle.toString(),
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
        const val MAX_SINGLE_CHUNK_ARTIFACT_BYTES = 8 * 1024 * 1024
        const val MAX_CAPTURE_SKEW_MS = 5_000L
        val CAPTURE_ARTIFACT_MEDIA_TYPES =
            setOf("image/png", "image/jpeg", "image/webp", "application/json")
        val POCO_ARTIFACT_KINDS =
            setOf("poco_screenshot", "poco_hierarchy", "poco_profiling")
        val ALLOWED_POCO_METHODS = listOf(
            "GetSDKVersion",
            "Screenshot",
            "Dump",
            "GetScreenSize",
            "GetDebugProfilingData",
            "qa.snapshot",
        )
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
