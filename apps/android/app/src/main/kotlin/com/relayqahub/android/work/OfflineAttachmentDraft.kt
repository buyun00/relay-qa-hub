package com.relayqahub.android.work

import android.content.Context
import com.relayqahub.android.FoundationCreateBugContract
import com.relayqahub.android.data.AccountProjectScope
import com.relayqahub.android.data.NewOfflineOperation
import com.relayqahub.android.data.OfflineAttachmentDraftDao
import com.relayqahub.android.data.OfflineOperationEntity
import com.relayqahub.android.data.ScopedRepository
import com.relayqahub.android.network.AttachmentUploadClient
import com.relayqahub.android.network.AttachmentUploadFailure
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

internal data class StagedOfflineAttachment(
    val submissionId: String,
    val clientAttachmentId: String,
    val filename: String,
    val observedAt: String,
    val qaAppVersion: String,
    val expectedSize: Int,
    val sha256: String,
)

internal object OfflineAttachmentDraftContract {
    const val OPERATION_KIND = "STAGE_CREATE_BUG_ATTACHMENT"
    private const val HTTP_METHOD = "POST"
    private const val RELATIVE_PATH = "/bugs"

    fun buildOperation(
        projectId: String,
        staged: StagedOfflineAttachment,
    ): NewOfflineOperation {
        requireUuid(projectId, "projectId")
        requireValid(staged)
        return NewOfflineOperation(
            operationKind = OPERATION_KIND,
            httpMethod = HTTP_METHOD,
            relativePath = RELATIVE_PATH,
            payloadJson = JSONObject()
                .put("projectId", projectId)
                .put("clientSubmissionId", staged.submissionId)
                .put("clientAttachmentId", staged.clientAttachmentId)
                .put("filename", staged.filename)
                .put("observedAt", staged.observedAt)
                .put("qaAppVersion", staged.qaAppVersion)
                .put("expectedSize", staged.expectedSize)
                .put("sha256", staged.sha256)
                .toString(),
            idempotencyKey = "submission:${staged.submissionId}:commit",
        )
    }

    fun parse(operation: OfflineOperationEntity): StagedOfflineAttachment {
        require(operation.operationKind == OPERATION_KIND)
        require(operation.httpMethod == HTTP_METHOD)
        require(operation.relativePath == RELATIVE_PATH)
        val payload = JSONObject(operation.payloadJson)
        require(payload.length() == REQUIRED_KEYS.size)
        require(REQUIRED_KEYS.all(payload::has))
        require(payload.getString("projectId") == operation.projectId)
        val staged = StagedOfflineAttachment(
            submissionId = payload.getString("clientSubmissionId"),
            clientAttachmentId = payload.getString("clientAttachmentId"),
            filename = payload.getString("filename"),
            observedAt = payload.getString("observedAt"),
            qaAppVersion = payload.getString("qaAppVersion"),
            expectedSize = payload.getInt("expectedSize"),
            sha256 = payload.getString("sha256"),
        )
        requireValid(staged)
        require(operation.idempotencyKey == "submission:${staged.submissionId}:commit")
        return staged
    }

    private fun requireValid(staged: StagedOfflineAttachment) {
        requireUuid(staged.submissionId, "clientSubmissionId")
        requireUuid(staged.clientAttachmentId, "clientAttachmentId")
        require(staged.filename.isNotBlank() && staged.filename.length <= 255)
        require(!staged.filename.contains('/') && !staged.filename.contains('\\'))
        require(staged.observedAt.isNotBlank() && staged.observedAt.length <= 64)
        require(staged.qaAppVersion.isNotBlank() && staged.qaAppVersion.length <= 128)
        require(staged.expectedSize in 1..MAX_ATTACHMENT_BYTES)
        require(SHA256_PATTERN.matches(staged.sha256))
    }

    private fun requireUuid(value: String, label: String) {
        require(runCatching { UUID.fromString(value) }.isSuccess) { "$label must be a UUID" }
    }

    private val REQUIRED_KEYS = setOf(
        "projectId",
        "clientSubmissionId",
        "clientAttachmentId",
        "filename",
        "observedAt",
        "qaAppVersion",
        "expectedSize",
        "sha256",
    )
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

    internal suspend fun read(staged: StagedOfflineAttachment): ByteArray =
        withContext(Dispatchers.IO) {
        val bytes = resolve(staged.submissionId, staged.clientAttachmentId).readBytes()
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
    data object Promoted : OfflineAttachmentStageResult
    data class Retryable(val errorCode: String) : OfflineAttachmentStageResult
    data class AuthExpired(val errorCode: String) : OfflineAttachmentStageResult
    data class PermanentFailure(val errorCode: String) : OfflineAttachmentStageResult
}

class OfflineAttachmentDraftProcessor(
    private val draftDao: OfflineAttachmentDraftDao,
    private val scopedRepository: ScopedRepository,
    private val uploadClient: AttachmentUploadClient,
    private val draftStore: OfflineAttachmentDraftStore,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    internal suspend fun promote(
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
            val bytes = draftStore.read(staged)
            val uploadReceipt = uploadClient.uploadAndReserveBugCreate(
                scope = scope,
                clientSubmissionId = staged.submissionId,
                clientAttachmentId = staged.clientAttachmentId,
                filename = staged.filename,
                pngBytes = bytes,
                accessToken = accessToken,
            )
            scopedRepository.recordAttachmentReservation(scope, uploadReceipt)
            val createBug = FoundationCreateBugContract.buildOperation(
                projectId = scope.projectId,
                submissionId = staged.submissionId,
                observedAt = staged.observedAt,
                qaAppVersion = staged.qaAppVersion,
                attachmentIds = listOf(uploadReceipt.attachmentId),
            )
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
                    nowEpochMs = clock(),
                ) == 1,
            ) { "OFFLINE_ATTACHMENT_PROMOTION_LOST_SCOPE" }
            OfflineAttachmentStageResult.Promoted
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

private fun ByteArray.sha256Hex(): String = MessageDigest.getInstance("SHA-256")
    .digest(this)
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
