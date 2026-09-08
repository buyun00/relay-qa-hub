package com.relayqahub.android.work

import android.content.Context
import android.os.Build
import com.relayqahub.android.BuildConfig
import com.relayqahub.android.FoundationCreateBugContract
import com.relayqahub.android.captureFilename
import com.relayqahub.android.toCaptureBundlePocoInput
import com.relayqahub.android.withPersistedArtifacts
import com.relayqahub.android.capture.CaptureArtifactStore
import com.relayqahub.android.capture.PendingCaptureDraftStore
import com.relayqahub.android.data.AccountProjectScope
import com.relayqahub.android.data.NewOfflineOperation
import com.relayqahub.android.data.OfflineAttachmentDraftDao
import com.relayqahub.android.data.OfflineOperationEntity
import com.relayqahub.android.data.QueueState
import com.relayqahub.android.data.ScopedRepository
import com.relayqahub.android.network.AttachmentUploadClient
import com.relayqahub.android.network.AttachmentUploadFailure
import com.relayqahub.android.network.AttachmentUploadReceipt
import com.relayqahub.android.network.CaptureAttachmentReceipt
import com.relayqahub.android.network.CaptureBundleArtifactUpload
import com.relayqahub.android.network.CaptureBundleDeviceInput
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal data class StagedOfflineAttachment(
    val clientAttachmentId: String,
    val filename: String,
    val expectedSize: Int,
    val sha256: String,
    val role: String,
)

internal data class StagedOfflineBugDraft(
    val submissionId: String,
    val observedAt: String,
    val qaAppVersion: String,
    val title: String,
    val description: String,
    val expectedBehavior: String,
    val ownerId: String? = null,
    val verificationOwnerId: String? = null,
    val captureId: String? = null,
    val capturedAtEpochMs: Long? = null,
    val attachments: List<StagedOfflineAttachment> = emptyList(),
)

internal object OfflineAttachmentDraftContract {
    const val OPERATION_KIND = "STAGE_CREATE_BUG_ATTACHMENT"
    private const val HTTP_METHOD = "POST"
    private const val RELATIVE_PATH = "/bugs"

    fun buildOperation(
        projectId: String,
        staged: StagedOfflineBugDraft,
    ): NewOfflineOperation {
        requireUuid(projectId, "projectId")
        requireValid(staged)
        return NewOfflineOperation(
            operationKind = OPERATION_KIND,
            httpMethod = HTTP_METHOD,
            relativePath = RELATIVE_PATH,
            payloadJson = JSONObject()
                .put("schemaVersion", SCHEMA_VERSION)
                .put("projectId", projectId)
                .put("clientSubmissionId", staged.submissionId)
                .put("observedAt", staged.observedAt)
                .put("qaAppVersion", staged.qaAppVersion)
                .put("title", staged.title)
                .put("description", staged.description)
                .put("expectedBehavior", staged.expectedBehavior)
                .put("attachments", JSONArray().also { array ->
                    staged.attachments.forEach { attachment ->
                        array.put(
                            JSONObject()
                                .put("clientAttachmentId", attachment.clientAttachmentId)
                                .put("filename", attachment.filename)
                                .put("expectedSize", attachment.expectedSize)
                                .put("sha256", attachment.sha256)
                                .put("role", attachment.role),
                        )
                    }
                })
                .apply {
                    staged.ownerId?.let { put("ownerId", it) }
                    staged.verificationOwnerId?.let { put("verificationOwnerId", it) }
                    staged.captureId?.let { put("captureId", it) }
                    staged.capturedAtEpochMs?.let { put("capturedAtEpochMs", it) }
                }
                .toString(),
            idempotencyKey = "submission:${staged.submissionId}:commit",
        )
    }

    fun parse(operation: OfflineOperationEntity): StagedOfflineBugDraft {
        require(operation.operationKind == OPERATION_KIND)
        require(operation.httpMethod == HTTP_METHOD)
        require(operation.relativePath == RELATIVE_PATH)
        val payload = JSONObject(operation.payloadJson)
        require(payload.getString("projectId") == operation.projectId)
        val staged = if (payload.has("attachments")) parseCurrent(payload) else parseLegacy(payload)
        requireValid(staged)
        require(operation.idempotencyKey == "submission:${staged.submissionId}:commit")
        return staged
    }

    private fun parseCurrent(payload: JSONObject): StagedOfflineBugDraft {
        val keys = payload.keys().asSequence().toSet()
        require(keys.containsAll(REQUIRED_KEYS) && keys.all(ALLOWED_KEYS::contains))
        require(payload.getInt("schemaVersion") == SCHEMA_VERSION)
        val attachmentsJson = payload.getJSONArray("attachments")
        require(attachmentsJson.length() <= MAX_ATTACHMENTS)
        val attachments = (0 until attachmentsJson.length()).map { index ->
            val item = attachmentsJson.getJSONObject(index)
            require(item.keys().asSequence().toSet() == ATTACHMENT_KEYS)
            StagedOfflineAttachment(
                clientAttachmentId = item.getString("clientAttachmentId"),
                filename = item.getString("filename"),
                expectedSize = item.getInt("expectedSize"),
                sha256 = item.getString("sha256"),
                role = item.getString("role"),
            )
        }
        return StagedOfflineBugDraft(
            submissionId = payload.getString("clientSubmissionId"),
            observedAt = payload.getString("observedAt"),
            qaAppVersion = payload.getString("qaAppVersion"),
            title = payload.getString("title"),
            description = payload.getString("description"),
            expectedBehavior = payload.getString("expectedBehavior"),
            ownerId = payload.optString("ownerId").takeIf(String::isNotBlank),
            verificationOwnerId = payload.optString("verificationOwnerId")
                .takeIf(String::isNotBlank),
            captureId = payload.optString("captureId").takeIf(String::isNotBlank),
            capturedAtEpochMs = payload.optLong("capturedAtEpochMs", -1L).takeIf { it > 0L },
            attachments = attachments,
        )
    }

    /** Keeps already-persisted v1 stage rows deliverable after an in-place APK update. */
    private fun parseLegacy(payload: JSONObject): StagedOfflineBugDraft {
        val keys = payload.keys().asSequence().toSet()
        require(keys.containsAll(LEGACY_REQUIRED_KEYS) && keys.all(LEGACY_ALLOWED_KEYS::contains))
        return StagedOfflineBugDraft(
            submissionId = payload.getString("clientSubmissionId"),
            observedAt = payload.getString("observedAt"),
            qaAppVersion = payload.getString("qaAppVersion"),
            title = DEFAULT_TITLE,
            description = DEFAULT_DESCRIPTION,
            expectedBehavior = DEFAULT_EXPECTED_BEHAVIOR,
            captureId = payload.optString("captureId").takeIf(String::isNotBlank),
            attachments = listOf(
                StagedOfflineAttachment(
                    clientAttachmentId = payload.getString("clientAttachmentId"),
                    filename = payload.getString("filename"),
                    expectedSize = payload.getInt("expectedSize"),
                    sha256 = payload.getString("sha256"),
                    role = ROLE_ORIGINAL,
                ),
            ),
        )
    }

    private fun requireValid(staged: StagedOfflineBugDraft) {
        requireUuid(staged.submissionId, "clientSubmissionId")
        require(staged.observedAt.isNotBlank() && staged.observedAt.length <= 64)
        require(staged.qaAppVersion.isNotBlank() && staged.qaAppVersion.length <= 128)
        require(staged.title.isNotBlank() && staged.title.length <= 300)
        require(staged.description.isNotBlank() && staged.description.length <= 20_000)
        require(staged.expectedBehavior.isNotBlank() && staged.expectedBehavior.length <= 10_000)
        staged.ownerId?.let { requireUuid(it, "ownerId") }
        staged.verificationOwnerId?.let { requireUuid(it, "verificationOwnerId") }
        staged.captureId?.let { requireUuid(it, "captureId") }
        require(staged.capturedAtEpochMs == null || staged.captureId != null)
        staged.capturedAtEpochMs?.let { require(it > 0L) }
        require(staged.attachments.size <= MAX_ATTACHMENTS)
        require(staged.attachments.map { it.clientAttachmentId }.distinct().size == staged.attachments.size)
        require(staged.attachments.count { it.role == ROLE_ORIGINAL } <= 1)
        require(staged.attachments.count { it.role == ROLE_ANNOTATED } <= 1)
        staged.attachments.forEach { attachment ->
            requireUuid(attachment.clientAttachmentId, "clientAttachmentId")
            require(attachment.filename.isNotBlank() && attachment.filename.length <= 255)
            require(!attachment.filename.contains('/') && !attachment.filename.contains('\\'))
            require(attachment.expectedSize in 1..MAX_ATTACHMENT_BYTES)
            require(SHA256_PATTERN.matches(attachment.sha256))
            require(attachment.role in setOf(ROLE_ORIGINAL, ROLE_ANNOTATED))
        }
    }

    private fun requireUuid(value: String, label: String) {
        require(runCatching { UUID.fromString(value) }.isSuccess) { "$label must be a UUID" }
    }

    private const val SCHEMA_VERSION = 2
    const val ROLE_ORIGINAL = "original"
    const val ROLE_ANNOTATED = "annotated"
    private const val MAX_ATTACHMENTS = 2
    private const val DEFAULT_TITLE = "Native QA Hub contract-validation draft"
    private const val DEFAULT_DESCRIPTION =
        "The Android foundation queued a representative Bug command for offline sync."
    private const val DEFAULT_EXPECTED_BEHAVIOR =
        "A valid App-first Bug command remains isolated to its authenticated project."
    private val REQUIRED_KEYS = setOf(
        "schemaVersion",
        "projectId",
        "clientSubmissionId",
        "observedAt",
        "qaAppVersion",
        "title",
        "description",
        "expectedBehavior",
        "attachments",
    )
    private val ALLOWED_KEYS = REQUIRED_KEYS + setOf(
        "ownerId",
        "verificationOwnerId",
        "captureId",
        "capturedAtEpochMs",
    )
    private val ATTACHMENT_KEYS = setOf(
        "clientAttachmentId",
        "filename",
        "expectedSize",
        "sha256",
        "role",
    )
    private val LEGACY_REQUIRED_KEYS = setOf(
        "projectId",
        "clientSubmissionId",
        "clientAttachmentId",
        "filename",
        "observedAt",
        "qaAppVersion",
        "expectedSize",
        "sha256",
    )
    private val LEGACY_ALLOWED_KEYS = LEGACY_REQUIRED_KEYS + "captureId"
    private val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
    const val MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
}

/** App-private, deterministic storage used before any network call is attempted. */
class OfflineAttachmentDraftStore(context: Context) {
    private val root = File(context.filesDir, "offline-submission-drafts").canonicalFile

    internal suspend fun persist(
        submissionId: String,
        clientAttachmentId: String,
        pngBytes: ByteArray,
    ): StagedOfflineAttachmentMetadata = withContext(Dispatchers.IO) {
        require(pngBytes.isNotEmpty() && pngBytes.size <= OfflineAttachmentDraftContract.MAX_ATTACHMENT_BYTES)
        val target = resolve(submissionId, clientAttachmentId)
        target.parentFile?.mkdirs()
        val temporary = File(target.parentFile, "${target.name}.tmp-${UUID.randomUUID()}")
        try {
            FileOutputStream(temporary).use { output ->
                output.write(pngBytes)
                output.fd.sync()
            }
            try {
                Files.move(
                    temporary.toPath(),
                    target.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING,
                )
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(
                    temporary.toPath(),
                    target.toPath(),
                    StandardCopyOption.REPLACE_EXISTING,
                )
            }
        } finally {
            temporary.delete()
        }
        StagedOfflineAttachmentMetadata(
            expectedSize = pngBytes.size,
            sha256 = pngBytes.sha256Hex(),
        )
    }

    internal suspend fun read(
        submissionId: String,
        staged: StagedOfflineAttachment,
    ): ByteArray =
        withContext(Dispatchers.IO) {
        val bytes = resolve(submissionId, staged.clientAttachmentId).readBytes()
        check(bytes.size == staged.expectedSize) { "OFFLINE_ATTACHMENT_SIZE_MISMATCH" }
        check(bytes.sha256Hex() == staged.sha256) { "OFFLINE_ATTACHMENT_HASH_MISMATCH" }
        bytes
    }

    internal suspend fun delete(submissionId: String, clientAttachmentId: String) =
        withContext(Dispatchers.IO) {
            val target = resolve(submissionId, clientAttachmentId)
            if (target.exists()) check(target.delete()) { "OFFLINE_ATTACHMENT_DELETE_FAILED" }
            target.parentFile?.takeIf { it != root && it.list()?.isEmpty() == true }?.delete()
        }

    private fun resolve(submissionId: String, clientAttachmentId: String): File {
        requireUuid(submissionId)
        requireUuid(clientAttachmentId)
        val submissionRoot = File(root, submissionId.lowercase()).canonicalFile
        check(submissionRoot.parentFile == root)
        val target = File(submissionRoot, "${clientAttachmentId.lowercase()}.png").canonicalFile
        check(target.parentFile == submissionRoot)
        return target
    }

    private fun requireUuid(value: String) {
        require(runCatching { UUID.fromString(value) }.isSuccess)
    }
}

internal data class StagedOfflineAttachmentMetadata(
    val expectedSize: Int,
    val sha256: String,
)

sealed interface OfflineAttachmentStageResult {
    data class Promoted(val operation: OfflineOperationEntity) : OfflineAttachmentStageResult
    data class Retryable(val errorCode: String) : OfflineAttachmentStageResult
    data class AuthExpired(val errorCode: String) : OfflineAttachmentStageResult
    data class PermanentFailure(val errorCode: String) : OfflineAttachmentStageResult
}

interface OfflineAttachmentDraftPromoter {
    suspend fun promote(
        scope: AccountProjectScope,
        operation: OfflineOperationEntity,
        accessToken: String,
    ): OfflineAttachmentStageResult
}

class OfflineAttachmentDraftProcessor(
    private val draftDao: OfflineAttachmentDraftDao,
    private val scopedRepository: ScopedRepository,
    private val uploadClient: AttachmentUploadClient,
    private val draftStore: OfflineAttachmentDraftStore,
    private val pendingCaptureDraftStore: PendingCaptureDraftStore? = null,
    private val captureArtifactStore: CaptureArtifactStore? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) : OfflineAttachmentDraftPromoter {
    override suspend fun promote(
        scope: AccountProjectScope,
        operation: OfflineOperationEntity,
        accessToken: String,
    ): OfflineAttachmentStageResult {
        val staged = try {
            require(operation.accountId == scope.accountId)
            require(operation.projectId == scope.projectId)
            require(operation.actorId == scope.actorId)
            require(operation.installationId == scope.installationId)
            require(operation.sessionId == scope.sessionId)
            OfflineAttachmentDraftContract.parse(operation)
        } catch (_: RuntimeException) {
            return OfflineAttachmentStageResult.PermanentFailure("INVALID_OFFLINE_ATTACHMENT_DRAFT")
        }

        return try {
            val uploadReceipts = staged.attachments.map { attachment ->
                val bytes = draftStore.read(staged.submissionId, attachment)
                uploadClient.uploadAndReserveBugCreate(
                    scope = scope,
                    clientSubmissionId = staged.submissionId,
                    clientAttachmentId = attachment.clientAttachmentId,
                    filename = attachment.filename,
                    pngBytes = bytes,
                    accessToken = accessToken,
                    captureId = staged.captureId,
                ).also { receipt ->
                    scopedRepository.recordAttachmentReservation(scope, receipt)
                }
            }
            val captureBundleId = createBestEffortCaptureBundle(
                scope = scope,
                staged = staged,
                uploadReceipts = uploadReceipts,
                accessToken = accessToken,
            )
            val createBug = FoundationCreateBugContract.buildOperation(
                projectId = scope.projectId,
                submissionId = staged.submissionId,
                observedAt = staged.observedAt,
                qaAppVersion = staged.qaAppVersion,
                attachmentIds = uploadReceipts.map { it.attachmentId },
                captureBundleId = captureBundleId,
                title = staged.title,
                description = staged.description,
                expectedBehavior = staged.expectedBehavior,
                ownerId = staged.ownerId,
                verificationOwnerId = staged.verificationOwnerId,
            )
            val promotedAt = clock()
            check(
                draftDao.promoteToCreateBug(
                    operationId = operation.operationId,
                    accountId = operation.accountId,
                    projectId = operation.projectId,
                    actorId = operation.actorId,
                    installationId = operation.installationId,
                    sessionId = operation.sessionId,
                    idempotencyKey = operation.idempotencyKey,
                    expectedOperationKind = OfflineAttachmentDraftContract.OPERATION_KIND,
                    operationKind = createBug.operationKind,
                    httpMethod = createBug.httpMethod,
                    relativePath = createBug.relativePath,
                    payloadJson = createBug.payloadJson,
                    nowEpochMs = promotedAt,
                ) == 1,
            ) { "OFFLINE_ATTACHMENT_PROMOTION_LOST_SCOPE" }
            OfflineAttachmentStageResult.Promoted(
                operation.copy(
                    operationKind = createBug.operationKind,
                    httpMethod = createBug.httpMethod,
                    relativePath = createBug.relativePath,
                    payloadJson = createBug.payloadJson,
                    state = QueueState.PENDING,
                    nextAttemptAtEpochMs = promotedAt,
                    lastErrorCode = null,
                    updatedAtEpochMs = promotedAt,
                ),
            )
        } catch (failure: CancellationException) {
            throw failure
        } catch (failure: AttachmentUploadFailure) {
            classifyUploadFailure(failure.code)
        } catch (_: IOException) {
            OfflineAttachmentStageResult.Retryable("ATTACHMENT_NETWORK_IO")
        } catch (failure: IllegalStateException) {
            val code = failure.message.orEmpty()
            if (code.startsWith("OFFLINE_ATTACHMENT_")) {
                OfflineAttachmentStageResult.PermanentFailure(code)
            } else {
                OfflineAttachmentStageResult.Retryable("ATTACHMENT_LOCAL_STATE")
            }
        } catch (_: RuntimeException) {
            OfflineAttachmentStageResult.PermanentFailure("INVALID_OFFLINE_ATTACHMENT_DRAFT")
        }
    }

    /** Poco/capture enrichment is deliberately best-effort and never blocks the ordinary Bug. */
    private suspend fun createBestEffortCaptureBundle(
        scope: AccountProjectScope,
        staged: StagedOfflineBugDraft,
        uploadReceipts: List<AttachmentUploadReceipt>,
        accessToken: String,
    ): String? {
        val captureId = staged.captureId ?: return null
        val capturedAtEpochMs = staged.capturedAtEpochMs ?: return null
        val pendingStore = pendingCaptureDraftStore ?: return null
        val artifactStore = captureArtifactStore ?: return null
        val originalIndex = staged.attachments.indexOfFirst {
            it.role == OfflineAttachmentDraftContract.ROLE_ORIGINAL
        }
        val primaryIndex = originalIndex.takeIf { it >= 0 }
            ?: staged.attachments.indexOfFirst { it.role == OfflineAttachmentDraftContract.ROLE_ANNOTATED }
        if (primaryIndex < 0) return null
        val primary = uploadReceipts.getOrNull(primaryIndex) ?: return null
        return try {
            val pending = pendingStore.find(captureId) ?: return null
            val uploadedArtifacts = pending.pocoArtifacts.mapNotNull { ref ->
                try {
                    val artifact = artifactStore.read(ref)
                    val clientAttachmentId = UUID.nameUUIDFromBytes(
                        "${staged.submissionId}:poco:${artifact.kind.wireName}"
                            .toByteArray(Charsets.UTF_8),
                    ).toString()
                    val receipt = uploadClient.uploadCaptureArtifact(
                        scope = scope,
                        clientSubmissionId = staged.submissionId,
                        clientAttachmentId = clientAttachmentId,
                        filename = artifact.captureFilename(captureId),
                        mediaType = artifact.mediaType,
                        contentBytes = artifact.bytes,
                        accessToken = accessToken,
                        captureId = captureId,
                    )
                    BestEffortPocoUpload(artifact, receipt)
                } catch (failure: Exception) {
                    if (failure is CancellationException) throw failure
                    null
                }
            }
            val durableSummary = pending.poco.withPersistedArtifacts(
                uploadedArtifacts.map { it.artifact.kind.wireName }.toSet(),
            )
            uploadClient.createCaptureBundleAndReadBack(
                scope = scope,
                clientSubmissionId = staged.submissionId,
                captureId = captureId,
                capturedAtEpochMs = capturedAtEpochMs,
                primaryAttachment = primary,
                artifacts = uploadedArtifacts.map { uploaded ->
                    CaptureBundleArtifactUpload(
                        kind = uploaded.artifact.kind.wireName,
                        attachment = uploaded.receipt,
                        startedAtEpochMs = uploaded.artifact.startedAtEpochMs,
                        endedAtEpochMs = uploaded.artifact.endedAtEpochMs,
                        truncated = uploaded.artifact.truncated,
                    )
                },
                poco = durableSummary.toCaptureBundlePocoInput(),
                device = CaptureBundleDeviceInput(
                    manufacturer = Build.MANUFACTURER,
                    model = Build.MODEL,
                    androidApi = Build.VERSION.SDK_INT,
                    androidRelease = Build.VERSION.RELEASE,
                    qaAppVersion = BuildConfig.VERSION_NAME,
                ),
                accessToken = accessToken,
            ).captureId
        } catch (failure: Exception) {
            if (failure is CancellationException) throw failure
            null
        }
    }

    private fun classifyUploadFailure(code: String): OfflineAttachmentStageResult {
        val status = HTTP_STATUS_SUFFIX.find(code)?.groupValues?.get(1)?.toIntOrNull()
        return when {
            status == 401 -> OfflineAttachmentStageResult.AuthExpired("NATIVE_SESSION_EXPIRED")
            status in PERMANENT_HTTP_STATUSES ->
                OfflineAttachmentStageResult.PermanentFailure("ATTACHMENT_$code")
            else -> OfflineAttachmentStageResult.Retryable("ATTACHMENT_$code")
        }
    }

    private companion object {
        val HTTP_STATUS_SUFFIX = Regex("_HTTP_([0-9]{3})$")
        val PERMANENT_HTTP_STATUSES = setOf(400, 403, 404, 409, 413, 415, 422)
    }
}

private data class BestEffortPocoUpload(
    val artifact: com.relayqahub.android.capture.CapturedPocoArtifact,
    val receipt: CaptureAttachmentReceipt,
)

private fun ByteArray.sha256Hex(): String = MessageDigest.getInstance("SHA-256")
    .digest(this)
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
