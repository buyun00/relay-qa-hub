package com.relayqahub.android.network

import com.relayqahub.android.data.AccountProjectScope
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.OffsetDateTime
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
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
    val leaseGeneration: Int,
    val bindingExpiresAt: String,
    val responseJson: String,
)

/** Durable progress for an idempotent upload/finalize/bind chain. */
data class AttachmentUploadCheckpoint(
    val uploadAttempt: Int = 1,
    val sessionId: String? = null,
    val chunkSize: Int? = null,
    val expectedChunkCount: Int? = null,
    val confirmedChunks: List<Int> = emptyList(),
    val uploadVersion: Int? = null,
    val uploadExpiresAt: String? = null,
    val attachmentId: String? = null,
    val finalizedVersion: Int? = null,
    val finalizeConfirmed: Boolean = false,
    val bindingId: String? = null,
    val leaseGeneration: Int? = null,
    val bindingVersion: Int? = null,
    val bindingExpiresAt: String? = null,
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

class AttachmentUploadFailure(
    val code: String,
    internal val serverCode: String? = null,
    internal val httpStatus: Int? = null,
) : IOException(code)

/**
 * Minimal native transport for the frozen 1.1 attachment path.
 *
 * The durable P3.4 resumable-media queue is intentionally separate. This client proves the real
 * adjacent HTTP path while preserving the canonical submission/attachment idempotency identities.
 */
class AttachmentUploadClient(
    baseUrl: String,
    httpClient: OkHttpClient,
    allowPrivateHttp: Boolean = false,
    private val nowEpochMs: () -> Long = System::currentTimeMillis,
) {
    private val apiBaseUrl: HttpUrl = QaHubApiEndpoint.parse(baseUrl, allowPrivateHttp)
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
        mediaType: String = PNG_MEDIA_TYPE_VALUE,
    ): AttachmentUploadReceipt = uploadAndReserve(
        scope = scope,
        clientSubmissionId = clientSubmissionId,
        clientAttachmentId = clientAttachmentId,
        filename = filename,
        contentBytes = pngBytes,
        accessToken = accessToken,
        captureId = captureId,
        mediaType = mediaType,
        intent = "bug_create",
        targetQaItemId = null,
        checkpoint = AttachmentUploadCheckpoint(),
        onCheckpoint = {},
    )

    /**
     * Upload and reserve evidence for one Verification result. The caller owns the stable
     * clientSubmissionId/clientAttachmentId pair and must reuse it on every retry.
     */
    suspend fun uploadAndReserveVerificationResult(
        scope: AccountProjectScope,
        bugId: String,
        clientSubmissionId: String,
        clientAttachmentId: String,
        filename: String,
        contentBytes: ByteArray,
        accessToken: String,
        captureId: String? = null,
        mediaType: String = PNG_MEDIA_TYPE_VALUE,
        checkpoint: AttachmentUploadCheckpoint = AttachmentUploadCheckpoint(),
        onCheckpoint: (AttachmentUploadCheckpoint) -> Unit = {},
    ): AttachmentUploadReceipt = uploadAndReserve(
        scope = scope,
        clientSubmissionId = clientSubmissionId,
        clientAttachmentId = clientAttachmentId,
        filename = filename,
        contentBytes = contentBytes,
        accessToken = accessToken,
        captureId = captureId,
        mediaType = mediaType,
        intent = "verification_result",
        targetQaItemId = bugId.also { requireUuid(it, "bugId") },
        checkpoint = checkpoint,
        onCheckpoint = onCheckpoint,
    )

    /** Reconcile the current reservation, then renew it only when server time has reached expiry. */
    suspend fun renewVerificationResultReservation(
        scope: AccountProjectScope,
        bugId: String,
        clientSubmissionId: String,
        clientAttachmentId: String,
        accessToken: String,
        checkpoint: AttachmentUploadCheckpoint,
        onCheckpoint: (AttachmentUploadCheckpoint) -> Unit,
    ): AttachmentUploadReceipt = withContext(Dispatchers.IO) {
        validateRequestIdentity(
            scope,
            clientSubmissionId,
            clientAttachmentId,
            accessToken,
            "verification_result",
            bugId.also { requireUuid(it, "bugId") },
        )
        validateCheckpoint(checkpoint, expectedSize = null)
        check(checkpoint.finalizeConfirmed && checkpoint.attachmentId != null) {
            "FINALIZED_ATTACHMENT_REQUIRED"
        }
        check(checkpoint.bindingId != null) { "ATTACHMENT_BINDING_REQUIRED" }
        bindOrRenew(
            scope = scope,
            clientSubmissionId = clientSubmissionId,
            clientAttachmentId = clientAttachmentId,
            accessToken = accessToken,
            intent = "verification_result",
            targetQaItemId = bugId,
            initial = checkpoint,
            assumeExpiredWhenServerDateMissing = true,
            onCheckpoint = onCheckpoint,
        )
    }

    private suspend fun uploadAndReserve(
        scope: AccountProjectScope,
        clientSubmissionId: String,
        clientAttachmentId: String,
        filename: String,
        contentBytes: ByteArray,
        accessToken: String,
        captureId: String?,
        mediaType: String,
        intent: String,
        targetQaItemId: String?,
        checkpoint: AttachmentUploadCheckpoint,
        onCheckpoint: (AttachmentUploadCheckpoint) -> Unit,
    ): AttachmentUploadReceipt = withContext(Dispatchers.IO) {
        validateRequestIdentity(
            scope,
            clientSubmissionId,
            clientAttachmentId,
            accessToken,
            intent,
            targetQaItemId,
        )
        captureId?.let { requireUuid(it, "captureId") }
        require(filename.isNotBlank() && filename.length <= 255)
        require('/' !in filename && '\\' !in filename)
        require(contentBytes.isNotEmpty() && contentBytes.size <= MAX_VERIFICATION_IMAGE_BYTES)
        require(mediaType in BUG_IMAGE_MEDIA_TYPES)
        val sha256 = contentBytes.sha256Hex()
        validateCheckpoint(checkpoint, contentBytes.size)
        var progress = checkpoint
        fun persist(next: AttachmentUploadCheckpoint) {
            validateCheckpoint(next, contentBytes.size)
            onCheckpoint(next)
            progress = next
        }

        if (progress.bindingId != null && !isExpired(progress.bindingExpiresAt, nowEpochMs())) {
            return@withContext progress.toReceipt(clientSubmissionId, clientAttachmentId)
        }
        if (progress.finalizeConfirmed) {
            return@withContext bindOrRenew(
                scope,
                clientSubmissionId,
                clientAttachmentId,
                accessToken,
                intent,
                targetQaItemId,
                progress,
                assumeExpiredWhenServerDateMissing = false,
                onCheckpoint = ::persist,
            )
        }

        var initialized = requestUploadInit(
            scope,
            clientSubmissionId,
            clientAttachmentId,
            filename,
            mediaType,
            contentBytes.size,
            sha256,
            captureId,
            accessToken,
            progress.uploadAttempt,
        )
        if (
            initialized.checkpoint.attachmentId == null &&
            isExpired(
                initialized.checkpoint.uploadExpiresAt,
                initialized.serverEpochMs ?: nowEpochMs(),
            )
        ) {
            initialized = requestUploadInit(
                scope,
                clientSubmissionId,
                clientAttachmentId,
                filename,
                mediaType,
                contentBytes.size,
                sha256,
                captureId,
                accessToken,
                progress.uploadAttempt + 1,
            )
        }
        persist(initialized.checkpoint)

        val sessionId = checkNotNull(progress.sessionId)
        val chunkSize = checkNotNull(progress.chunkSize)
        val expectedChunkCount = checkNotNull(progress.expectedChunkCount)
        for (chunkNumber in 0 until expectedChunkCount) {
            if (chunkNumber in progress.confirmedChunks) continue
            val start = chunkNumber * chunkSize
            val end = minOf(contentBytes.size, start + chunkSize)
            val chunk = contentBytes.copyOfRange(start, end)
            val expectedVersion = checkNotNull(progress.uploadVersion)
            val chunkKey =
                "submission:$clientSubmissionId:attachment:$clientAttachmentId:" +
                    "upload:${progress.uploadAttempt}:chunk:$chunkNumber"
            val request = Request.Builder()
                .url(resolve("/uploads/$sessionId/chunks/$chunkNumber"))
                .header("Accept", QaHubApiContract.JSON_ACCEPT)
                .header("Authorization", "Bearer $accessToken")
                .header(QA_HUB_ACTOR_ID_HEADER, scope.actorId)
                .header("Idempotency-Key", chunkKey)
                .header("If-Match", quotedVersion(expectedVersion))
                .header("Content-Length", chunk.size.toString())
                .header("X-Chunk-SHA256", chunk.sha256Hex())
                .header("X-Client-Submission-Id", clientSubmissionId)
                .header("X-Client-Attachment-Id", clientAttachmentId)
                .put(chunk.toRequestBody(OCTET_STREAM_MEDIA_TYPE))
                .build()
            httpClient.newCall(request).execute().use { response ->
                if (response.code != 204) throw response.asUploadFailure("CHUNK_$chunkNumber")
                val returnedVersion = response.requireUploadVersion("CHUNK_$chunkNumber")
                if (returnedVersion != expectedVersion + 1) {
                    throw AttachmentUploadFailure("CHUNK_VERSION_MISMATCH")
                }
                persist(
                    progress.copy(
                        confirmedChunks = (progress.confirmedChunks + chunkNumber).sorted(),
                        uploadVersion = returnedVersion,
                    ),
                )
            }
        }

        val finalizeExpectedVersion = INIT_VERSION + expectedChunkCount
        check(
            progress.confirmedChunks.size == expectedChunkCount &&
                checkNotNull(progress.uploadVersion) in
                finalizeExpectedVersion..(finalizeExpectedVersion + 1)
        ) { "UPLOAD_CHECKPOINT_INVALID" }
        val finalize = executeJsonResponse(
            request = jsonRequest(
                relativePath = "/uploads/$sessionId/finalize",
                method = "POST",
                body = JSONObject()
                    .put("submissionContractVersion", QaHubApiContract.VERSION)
                    .put("expectedVersion", finalizeExpectedVersion)
                    .put("clientSubmissionId", clientSubmissionId)
                    .put("clientAttachmentId", clientAttachmentId)
                    .put("uploadAttempt", progress.uploadAttempt)
                    .put("sha256", sha256)
                    .put("expectedSize", contentBytes.size)
                    .toString(),
                accessToken = accessToken,
                actorId = scope.actorId,
                idempotencyKey =
                    "submission:$clientSubmissionId:attachment:$clientAttachmentId:" +
                        "upload:${progress.uploadAttempt}:finalize",
            ),
            expectedStatus = 200,
            stage = "FINALIZE",
        ).body
        if (finalize.keys().asSequence().toSet() != FINALIZE_RESPONSE_FIELDS) {
            throw AttachmentUploadFailure("FINALIZE_RESPONSE_SHAPE_INVALID")
        }
        val attachmentId = finalize.requiredUuid("attachmentId")
        finalize.requireString("sessionId", sessionId)
        finalize.requireString("projectId", scope.projectId)
        finalize.requireString("clientSubmissionId", clientSubmissionId)
        finalize.requireString("clientAttachmentId", clientAttachmentId)
        finalize.requireInt("uploadAttempt", progress.uploadAttempt)
        finalize.requireString("filename", filename)
        finalize.requireString("mediaType", mediaType)
        finalize.requireString("sha256", sha256)
        requireNullableIdentity(finalize, "captureId", captureId, "FINALIZE")
        finalize.requireInt("size", contentBytes.size)
        finalize.requireString("scanStatus", "clean")
        finalize.requireBoolean("readyToBind", true)
        finalize.requireString("bindingStatus", "unbound")
        finalize.requireInt("version", finalizeExpectedVersion + 1)
        finalize.requiredBoolean("replayed")
        persist(
            progress.copy(
                attachmentId = attachmentId,
                finalizedVersion = finalizeExpectedVersion + 1,
                finalizeConfirmed = true,
            ),
        )

        bindOrRenew(
            scope,
            clientSubmissionId,
            clientAttachmentId,
            accessToken,
            intent,
            targetQaItemId,
            progress,
            assumeExpiredWhenServerDateMissing = false,
            onCheckpoint = ::persist,
        )
    }

    private data class JsonHttpResponse(
        val body: JSONObject,
        val serverEpochMs: Long?,
    )

    private data class InitializedCheckpoint(
        val checkpoint: AttachmentUploadCheckpoint,
        val serverEpochMs: Long?,
    )

    private fun requestUploadInit(
        scope: AccountProjectScope,
        clientSubmissionId: String,
        clientAttachmentId: String,
        filename: String,
        mediaType: String,
        expectedSize: Int,
        sha256: String,
        captureId: String?,
        accessToken: String,
        uploadAttempt: Int,
    ): InitializedCheckpoint {
        require(uploadAttempt > 0)
        val response = executeJsonResponse(
            request = jsonRequest(
                relativePath = "/uploads/init",
                method = "POST",
                body = JSONObject()
                    .put("submissionContractVersion", QaHubApiContract.VERSION)
                    .put("projectId", scope.projectId)
                    .put("clientSubmissionId", clientSubmissionId)
                    .put("clientAttachmentId", clientAttachmentId)
                    .put("uploadAttempt", uploadAttempt)
                    .put("filename", filename)
                    .put("mediaType", mediaType)
                    .put("expectedSize", expectedSize)
                    .put("sha256", sha256)
                    .apply { captureId?.let { put("captureId", it) } }
                    .toString(),
                accessToken = accessToken,
                actorId = scope.actorId,
                idempotencyKey =
                    "submission:$clientSubmissionId:attachment:$clientAttachmentId:" +
                        "upload:$uploadAttempt:init",
            ),
            expectedStatus = 201,
            stage = "INIT",
        )
        val init = response.body
        if (init.keys().asSequence().toSet() != INIT_RESPONSE_FIELDS) {
            throw AttachmentUploadFailure("INIT_RESPONSE_SHAPE_INVALID")
        }
        val sessionId = init.requiredUuid("sessionId")
        init.requireString("projectId", scope.projectId)
        init.requireString("clientSubmissionId", clientSubmissionId)
        init.requireString("clientAttachmentId", clientAttachmentId)
        init.requireInt("uploadAttempt", uploadAttempt)
        init.requireString("filename", filename)
        init.requireString("mediaType", mediaType)
        init.requireInt("expectedSize", expectedSize)
        init.requireString("sha256", sha256)
        requireNullableIdentity(init, "captureId", captureId, "INIT")
        val status = init.getString("status")
        if (status !in setOf("open", "finalizing", "finalized")) {
            throw AttachmentUploadFailure("INIT_STATUS_INVALID")
        }
        val chunkSize = init.requirePositiveInt("chunkSize")
        if (chunkSize !in MIN_SERVER_CHUNK_BYTES..MAX_SERVER_CHUNK_BYTES) {
            throw AttachmentUploadFailure("INIT_CHUNK_SIZE_INVALID")
        }
        val expectedChunkCount = init.requirePositiveInt("expectedChunkCount")
        if (
            expectedChunkCount > MAX_SERVER_CHUNK_COUNT ||
            expectedChunkCount != (expectedSize + chunkSize - 1) / chunkSize
        ) {
            throw AttachmentUploadFailure("INIT_CHUNK_COUNT_MISMATCH")
        }
        val confirmedChunks = init.requireIntegerArray("confirmedChunks")
        if (
            confirmedChunks != confirmedChunks.distinct().sorted() ||
            confirmedChunks.any { it !in 0 until expectedChunkCount }
        ) {
            throw AttachmentUploadFailure("INIT_CONFIRMED_CHUNKS_INVALID")
        }
        val receivedBytes = confirmedChunks.sumOf { chunkNumber ->
            minOf(chunkSize, expectedSize - chunkNumber * chunkSize)
        }
        init.requireInt("receivedBytes", receivedBytes)
        val attachmentId = when {
            !init.has("attachmentId") -> throw AttachmentUploadFailure("INIT_ATTACHMENT_SHAPE_INVALID")
            init.isNull("attachmentId") -> null
            else -> init.requiredUuid("attachmentId")
        }
        val allChunksPresent = confirmedChunks.size == expectedChunkCount
        if (
            (status == "open" && (allChunksPresent || attachmentId != null)) ||
            (status == "finalizing" && (!allChunksPresent || attachmentId != null)) ||
            (status == "finalized" && (!allChunksPresent || attachmentId == null))
        ) {
            throw AttachmentUploadFailure("INIT_STATUS_PROGRESS_MISMATCH")
        }
        val expectedVersion = INIT_VERSION + confirmedChunks.size + if (status == "finalized") 1 else 0
        init.requireInt("version", expectedVersion)
        val expiresAt = init.getString("expiresAt").also { OffsetDateTime.parse(it) }
        init.requiredBoolean("replayed")
        return InitializedCheckpoint(
            AttachmentUploadCheckpoint(
                uploadAttempt = uploadAttempt,
                sessionId = sessionId,
                chunkSize = chunkSize,
                expectedChunkCount = expectedChunkCount,
                confirmedChunks = confirmedChunks,
                uploadVersion = expectedVersion,
                uploadExpiresAt = expiresAt,
                attachmentId = attachmentId,
                finalizedVersion = expectedVersion.takeIf { attachmentId != null },
                finalizeConfirmed = false,
            ),
            response.serverEpochMs,
        )
    }

    private fun bindOrRenew(
        scope: AccountProjectScope,
        clientSubmissionId: String,
        clientAttachmentId: String,
        accessToken: String,
        intent: String,
        targetQaItemId: String?,
        initial: AttachmentUploadCheckpoint,
        assumeExpiredWhenServerDateMissing: Boolean,
        onCheckpoint: (AttachmentUploadCheckpoint) -> Unit,
    ): AttachmentUploadReceipt {
        var progress = initial
        val currentGeneration = progress.leaseGeneration
        var recoveredNextGeneration = false
        val first = if (currentGeneration == null) {
            sendBinding(
                scope,
                clientSubmissionId,
                clientAttachmentId,
                accessToken,
                intent,
                targetQaItemId,
                progress,
                leaseGeneration = 1,
                expectedVersion = checkNotNull(progress.finalizedVersion),
                expectedBindingId = null,
            )
        } else {
            try {
                sendBinding(
                    scope,
                    clientSubmissionId,
                    clientAttachmentId,
                    accessToken,
                    intent,
                    targetQaItemId,
                    progress,
                    leaseGeneration = currentGeneration,
                    expectedVersion = checkNotNull(progress.bindingVersion) - 1,
                    expectedBindingId = checkNotNull(progress.bindingId),
                )
            } catch (failure: AttachmentUploadFailure) {
                if (!failure.isBindingVersionConflict()) throw failure
                // A generation+1 renewal may have committed before its response was lost. Replay
                // that exact next-generation identity before considering any newer generation.
                recoveredNextGeneration = true
                sendBinding(
                    scope,
                    clientSubmissionId,
                    clientAttachmentId,
                    accessToken,
                    intent,
                    targetQaItemId,
                    progress,
                    leaseGeneration = currentGeneration + 1,
                    expectedVersion = checkNotNull(progress.bindingVersion),
                    expectedBindingId = checkNotNull(progress.bindingId),
                )
            }
        }
        progress = first.first
        onCheckpoint(progress)
        if (currentGeneration == null) return first.second

        val serverObservedAt = first.third
        val expired = if (serverObservedAt != null) {
            isExpired(progress.bindingExpiresAt, serverObservedAt)
        } else if (recoveredNextGeneration) {
            isExpired(progress.bindingExpiresAt, nowEpochMs())
        } else {
            assumeExpiredWhenServerDateMissing || isExpired(progress.bindingExpiresAt, nowEpochMs())
        }
        if (!expired) return first.second

        val renewed = sendBinding(
            scope,
            clientSubmissionId,
            clientAttachmentId,
            accessToken,
            intent,
            targetQaItemId,
            progress,
            leaseGeneration = checkNotNull(progress.leaseGeneration) + 1,
            expectedVersion = checkNotNull(progress.bindingVersion),
            expectedBindingId = checkNotNull(progress.bindingId),
        )
        onCheckpoint(renewed.first)
        return renewed.second
    }

    private fun sendBinding(
        scope: AccountProjectScope,
        clientSubmissionId: String,
        clientAttachmentId: String,
        accessToken: String,
        intent: String,
        targetQaItemId: String?,
        checkpoint: AttachmentUploadCheckpoint,
        leaseGeneration: Int,
        expectedVersion: Int,
        expectedBindingId: String?,
    ): Triple<AttachmentUploadCheckpoint, AttachmentUploadReceipt, Long?> {
        val attachmentId = checkNotNull(checkpoint.attachmentId)
        val response = executeJsonResponse(
            request = jsonRequest(
                relativePath = "/attachments/$attachmentId/bind",
                method = "POST",
                body = JSONObject()
                    .put("submissionContractVersion", QaHubApiContract.VERSION)
                    .put("expectedVersion", expectedVersion)
                    .put("projectId", scope.projectId)
                    .put("clientSubmissionId", clientSubmissionId)
                    .put("clientAttachmentId", clientAttachmentId)
                    .put("leaseGeneration", leaseGeneration)
                    .put("intent", intent)
                    .apply { targetQaItemId?.let { put("targetQaItemId", it) } }
                    .toString(),
                accessToken = accessToken,
                actorId = scope.actorId,
                idempotencyKey =
                    "submission:$clientSubmissionId:attachment:$clientAttachmentId:" +
                        "bind:$leaseGeneration",
            ),
            expectedStatus = 200,
            stage = "BIND_$leaseGeneration",
        )
        val binding = response.body
        if (binding.keys().asSequence().toSet() != BINDING_RESPONSE_FIELDS) {
            throw AttachmentUploadFailure("BINDING_RESPONSE_SHAPE_INVALID")
        }
        val bindingId = binding.requiredUuid("bindingId")
        if (expectedBindingId != null && bindingId != expectedBindingId) {
            throw AttachmentUploadFailure("BINDING_ID_CHANGED")
        }
        binding.requireString("attachmentId", attachmentId)
        binding.requireString("projectId", scope.projectId)
        binding.requireString("clientSubmissionId", clientSubmissionId)
        binding.requireString("clientAttachmentId", clientAttachmentId)
        binding.requireInt("leaseGeneration", leaseGeneration)
        binding.requireString("intent", intent)
        binding.requireString("status", "reserved")
        binding.requireInt("version", expectedVersion + 1)
        if (targetQaItemId == null) {
            if (!binding.has("targetQaItemId") || !binding.isNull("targetQaItemId")) {
                throw AttachmentUploadFailure("BIND_TARGET_MUST_BE_NULL")
            }
        } else {
            binding.requireString("targetQaItemId", targetQaItemId)
        }
        val expiresAt = binding.getString("expiresAt").also { OffsetDateTime.parse(it) }
        binding.requiredBoolean("replayed")
        val next = checkpoint.copy(
            bindingId = bindingId,
            leaseGeneration = leaseGeneration,
            bindingVersion = expectedVersion + 1,
            bindingExpiresAt = expiresAt,
        )
        validateCheckpoint(next, expectedSize = null)
        return Triple(
            next,
            AttachmentUploadReceipt(
                clientSubmissionId = clientSubmissionId,
                clientAttachmentId = clientAttachmentId,
                attachmentId = attachmentId,
                bindingId = bindingId,
                bindingStatus = "reserved",
                uploadVersion = checkNotNull(checkpoint.finalizedVersion),
                bindingVersion = expectedVersion + 1,
                leaseGeneration = leaseGeneration,
                bindingExpiresAt = expiresAt,
                responseJson = binding.toString(),
            ),
            response.serverEpochMs,
        )
    }

    private fun validateRequestIdentity(
        scope: AccountProjectScope,
        clientSubmissionId: String,
        clientAttachmentId: String,
        accessToken: String,
        intent: String,
        targetQaItemId: String?,
    ) {
        requireUuid(scope.projectId, "projectId")
        requireUuid(scope.actorId, "actorId")
        requireUuid(clientSubmissionId, "clientSubmissionId")
        requireUuid(clientAttachmentId, "clientAttachmentId")
        require(intent in setOf("bug_create", "verification_result"))
        require((intent == "bug_create") == (targetQaItemId == null))
        targetQaItemId?.let { requireUuid(it, "targetQaItemId") }
        require(accessToken.isNotBlank())
    }

    private fun validateCheckpoint(checkpoint: AttachmentUploadCheckpoint, expectedSize: Int?) {
        require(checkpoint.uploadAttempt > 0)
        if (checkpoint.sessionId == null) {
            check(
                checkpoint.chunkSize == null && checkpoint.expectedChunkCount == null &&
                    checkpoint.confirmedChunks.isEmpty() && checkpoint.uploadVersion == null &&
                    checkpoint.uploadExpiresAt == null && checkpoint.attachmentId == null &&
                    checkpoint.finalizedVersion == null && !checkpoint.finalizeConfirmed &&
                    checkpoint.bindingId == null && checkpoint.leaseGeneration == null &&
                    checkpoint.bindingVersion == null && checkpoint.bindingExpiresAt == null
            ) { "UPLOAD_CHECKPOINT_INVALID" }
            return
        }
        requireUuid(checkpoint.sessionId, "sessionId")
        val chunkSize = checkNotNull(checkpoint.chunkSize)
        val chunkCount = checkNotNull(checkpoint.expectedChunkCount)
        check(
            chunkSize in MIN_SERVER_CHUNK_BYTES..MAX_SERVER_CHUNK_BYTES &&
                chunkCount in 1..MAX_SERVER_CHUNK_COUNT
        ) {
            "UPLOAD_CHECKPOINT_INVALID"
        }
        expectedSize?.let {
            check(chunkCount == (it + chunkSize - 1) / chunkSize) { "UPLOAD_CHECKPOINT_INVALID" }
        }
        check(
            checkpoint.confirmedChunks == checkpoint.confirmedChunks.distinct().sorted() &&
                checkpoint.confirmedChunks.all { it in 0 until chunkCount } &&
                checkNotNull(checkpoint.uploadVersion) >= INIT_VERSION + checkpoint.confirmedChunks.size
        ) { "UPLOAD_CHECKPOINT_INVALID" }
        OffsetDateTime.parse(checkNotNull(checkpoint.uploadExpiresAt))
        if (checkpoint.attachmentId == null) {
            check(checkpoint.finalizedVersion == null && !checkpoint.finalizeConfirmed) {
                "UPLOAD_CHECKPOINT_INVALID"
            }
        } else {
            requireUuid(checkpoint.attachmentId, "attachmentId")
            check(checkpoint.confirmedChunks.size == chunkCount)
            checkNotNull(checkpoint.finalizedVersion)
        }
        if (checkpoint.finalizeConfirmed) check(checkpoint.attachmentId != null)
        val bindingParts = listOf(
            checkpoint.bindingId,
            checkpoint.leaseGeneration,
            checkpoint.bindingVersion,
            checkpoint.bindingExpiresAt,
        )
        check(bindingParts.all { it == null } || bindingParts.none { it == null }) {
            "UPLOAD_CHECKPOINT_INVALID"
        }
        checkpoint.bindingId?.let {
            requireUuid(it, "bindingId")
            check(checkpoint.finalizeConfirmed)
            val generation = checkNotNull(checkpoint.leaseGeneration)
            check(generation > 0)
            check(checkpoint.bindingVersion == checkNotNull(checkpoint.finalizedVersion) + generation)
            OffsetDateTime.parse(checkNotNull(checkpoint.bindingExpiresAt))
        }
    }

    private fun AttachmentUploadCheckpoint.toReceipt(
        clientSubmissionId: String,
        clientAttachmentId: String,
    ): AttachmentUploadReceipt {
        validateCheckpoint(this, expectedSize = null)
        val body = JSONObject()
            .put("bindingId", bindingId)
            .put("attachmentId", attachmentId)
            .put("leaseGeneration", leaseGeneration)
            .put("status", "reserved")
            .put("expiresAt", bindingExpiresAt)
            .put("version", bindingVersion)
        return AttachmentUploadReceipt(
            clientSubmissionId,
            clientAttachmentId,
            checkNotNull(attachmentId),
            checkNotNull(bindingId),
            "reserved",
            checkNotNull(finalizedVersion),
            checkNotNull(bindingVersion),
            checkNotNull(leaseGeneration),
            checkNotNull(bindingExpiresAt),
            body.toString(),
        )
    }

    private fun isExpired(expiresAt: String?, observedAtEpochMs: Long): Boolean =
        expiresAt != null && observedAtEpochMs >= OffsetDateTime.parse(expiresAt).toInstant().toEpochMilli()

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
        requireUuid(scope.actorId, "actorId")
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
                actorId = scope.actorId,
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
            .header(QA_HUB_ACTOR_ID_HEADER, scope.actorId)
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
                actorId = scope.actorId,
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
        requireUuid(scope.actorId, "actorId")
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
                when {
                    poco.connectedPort == null -> "not_probed"
                    "qa.snapshot" in poco.negotiatedMethods -> "qa_snapshot_available"
                    else -> "standard_only"
                },
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
                actorId = scope.actorId,
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
            .header(QA_HUB_ACTOR_ID_HEADER, scope.actorId)
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
        actorId: String,
        idempotencyKey: String,
    ): Request = Request.Builder()
        .url(resolve(relativePath))
        .header("Accept", QaHubApiContract.JSON_ACCEPT)
        .header("Authorization", "Bearer $accessToken")
        .header(QA_HUB_ACTOR_ID_HEADER, actorId)
        .header("Idempotency-Key", idempotencyKey)
        .method(method, body.toRequestBody(VERSIONED_JSON_MEDIA_TYPE))
        .build()

    private fun executeJson(
        request: Request,
        expectedStatus: Int,
        stage: String,
    ): JSONObject = executeJsonResponse(request, expectedStatus, stage).body

    private fun executeJsonResponse(
        request: Request,
        expectedStatus: Int,
        stage: String,
    ): JsonHttpResponse {
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
            JsonHttpResponse(
                body = JSONObject(String(bodyBytes, StandardCharsets.UTF_8)),
                serverEpochMs = response.header("Date")?.let { value ->
                    runCatching {
                        ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME)
                            .toInstant().toEpochMilli()
                    }.getOrNull()
                },
            )
        }
    }

    private fun resolve(relativePath: String): HttpUrl =
        QaHubRelativePath.resolve(apiBaseUrl, relativePath)

    private fun okhttp3.Response.asUploadFailure(stage: String): AttachmentUploadFailure {
        val parsedServerCode = runCatching {
            val bytes = body?.bytes() ?: return@runCatching null
            if (bytes.size > MAX_ERROR_BODY_BYTES) return@runCatching null
            JSONObject(String(bytes, StandardCharsets.UTF_8))
                .optString("code")
                .takeIf { it.matches(Regex("^[A-Z][A-Z0-9_]{0,127}$")) }
        }.getOrNull()
        val suffix = parsedServerCode ?: "HTTP_$code"
        return AttachmentUploadFailure(
            code = "${stage}_$suffix",
            serverCode = parsedServerCode,
            httpStatus = code,
        )
    }

    private fun okhttp3.Response.requireUploadVersion(stage: String): Int {
        val versionText = header("X-Upload-Version")
            ?: throw AttachmentUploadFailure("${stage}_VERSION_MISSING")
        if (!versionText.matches(Regex("^[1-9][0-9]*$"))) {
            throw AttachmentUploadFailure("${stage}_VERSION_INVALID")
        }
        val version = versionText.toIntOrNull()
            ?: throw AttachmentUploadFailure("${stage}_VERSION_INVALID")
        if (header("ETag") != quotedVersion(version)) {
            throw AttachmentUploadFailure("${stage}_ETAG_MISMATCH")
        }
        return version
    }

    private companion object {
        const val PNG_MEDIA_TYPE_VALUE = "image/png"
        const val UPLOAD_ATTEMPT = 1
        const val INIT_VERSION = 1
        const val CHUNK_VERSION = 2
        const val FINALIZE_VERSION = 3
        const val MAX_SUCCESS_BODY_BYTES = 256 * 1024
        const val MAX_ERROR_BODY_BYTES = 64 * 1024
        const val MAX_VERIFICATION_IMAGE_BYTES = 20 * 1024 * 1024
        const val MIN_SERVER_CHUNK_BYTES = 256 * 1024
        const val MAX_SERVER_CHUNK_BYTES = 8 * 1024 * 1024
        const val MAX_SERVER_CHUNK_COUNT = 2_000
        const val MAX_SINGLE_CHUNK_ARTIFACT_BYTES = 8 * 1024 * 1024
        const val MAX_CAPTURE_SKEW_MS = 5_000L
        val CAPTURE_ARTIFACT_MEDIA_TYPES =
            setOf("image/png", "image/jpeg", "image/webp", "application/json")
        val BUG_IMAGE_MEDIA_TYPES = setOf("image/png", "image/jpeg", "image/webp")
        val INIT_RESPONSE_FIELDS = setOf(
            "sessionId", "projectId", "clientSubmissionId", "clientAttachmentId", "uploadAttempt",
            "status", "filename", "mediaType", "captureId", "expectedSize", "chunkSize", "sha256",
            "expectedChunkCount", "receivedBytes", "attachmentId", "expiresAt", "confirmedChunks",
            "version", "replayed",
        )
        val FINALIZE_RESPONSE_FIELDS = setOf(
            "sessionId", "projectId", "clientSubmissionId", "uploadAttempt", "attachmentId",
            "clientAttachmentId", "filename", "mediaType", "captureId", "sha256", "size",
            "scanStatus", "readyToBind", "bindingStatus", "version", "replayed",
        )
        val BINDING_RESPONSE_FIELDS = setOf(
            "bindingId", "attachmentId", "projectId", "clientSubmissionId", "clientAttachmentId",
            "leaseGeneration", "intent", "targetQaItemId", "status", "expiresAt", "version",
            "replayed",
        )
        val POCO_ARTIFACT_KINDS =
            setOf("poco_screenshot", "poco_hierarchy", "poco_profiling", "poco_snapshot")
        val ALLOWED_POCO_METHODS = listOf(
            "GetSDKVersion",
            "Screenshot",
            "Dump",
            "GetScreenSize",
            "GetDebugProfilingData",
            "qa.snapshot",
        )
        val VERSIONED_JSON_MEDIA_TYPE = QaHubApiContract.VERSIONED_JSON.toMediaType()
        val OCTET_STREAM_MEDIA_TYPE = "application/octet-stream".toMediaType()
    }
}

private fun AttachmentUploadFailure.isBindingVersionConflict(): Boolean =
    serverCode in setOf("SQLITE_UPLOAD_VERSION_CONFLICT", "UPLOAD_VERSION_CONFLICT", "VERSION_CONFLICT")

private fun quotedVersion(version: Int): String = "\"$version\""

private fun ByteArray.sha256Hex(): String = MessageDigest.getInstance("SHA-256")
    .digest(this)
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

private fun requireUuid(value: String, label: String): String = value.also {
    require(
        STRICT_ATTACHMENT_UUID.matches(value) && runCatching { UUID.fromString(value) }.isSuccess,
    ) { "$label must be a UUID" }
}

private fun JSONObject.requiredUuid(key: String): String {
    if (!has(key) || isNull(key) || get(key) !is String) {
        throw AttachmentUploadFailure("INVALID_${key.uppercase()}_UUID")
    }
    return getString(key).also {
    if (!STRICT_ATTACHMENT_UUID.matches(it) || runCatching { UUID.fromString(it) }.isFailure) {
        throw AttachmentUploadFailure("INVALID_${key.uppercase()}_UUID")
    }
}
}

private fun JSONObject.requireString(key: String, expected: String) {
    if (!has(key) || isNull(key) || getString(key) != expected) {
        throw AttachmentUploadFailure("${key.uppercase()}_MISMATCH")
    }
}

private fun JSONObject.requireInt(key: String, expected: Int) {
    val raw = if (has(key)) get(key) else null
    val value = when (raw) {
        is Int -> raw
        is Long -> raw.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()
        else -> null
    }
    if (value != expected) {
        throw AttachmentUploadFailure("${key.uppercase()}_MISMATCH")
    }
}

private fun JSONObject.requireBoolean(key: String, expected: Boolean) {
    if (!has(key) || get(key) !is Boolean || getBoolean(key) != expected) {
        throw AttachmentUploadFailure("${key.uppercase()}_MISMATCH")
    }
}

private fun JSONObject.requiredBoolean(key: String): Boolean {
    if (!has(key) || get(key) !is Boolean) {
        throw AttachmentUploadFailure("${key.uppercase()}_INVALID")
    }
    return getBoolean(key)
}

private fun JSONObject.requirePositiveInt(key: String): Int {
    val raw = if (has(key)) get(key) else null
    val value = when (raw) {
        is Int -> raw
        is Long -> raw.takeIf { it in 1..Int.MAX_VALUE }?.toInt()
        else -> null
    }
    if (value == null || value < 1) {
        throw AttachmentUploadFailure("${key.uppercase()}_INVALID")
    }
    return value
}

private fun JSONObject.requireIntegerArray(key: String): List<Int> {
    val array = optJSONArray(key) ?: throw AttachmentUploadFailure("${key.uppercase()}_INVALID")
    return (0 until array.length()).map { index ->
        val raw = array.get(index)
        val value = when (raw) {
            is Int -> raw
            is Long -> raw.takeIf { it in 0..Int.MAX_VALUE }?.toInt()
            else -> null
        }
        if (value == null || value < 0) {
            throw AttachmentUploadFailure("${key.uppercase()}_INVALID")
        }
        value
    }
}

private fun requireNullableIdentity(
    value: JSONObject,
    key: String,
    expected: String?,
    stage: String,
) {
    if (!value.has(key)) throw AttachmentUploadFailure("${stage}_${key.uppercase()}_MISSING")
    if (expected == null) {
        if (!value.isNull(key)) throw AttachmentUploadFailure("${stage}_${key.uppercase()}_PRESENT")
    } else {
        value.requireString(key, expected)
    }
}

private val STRICT_ATTACHMENT_UUID = Regex(
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
)
