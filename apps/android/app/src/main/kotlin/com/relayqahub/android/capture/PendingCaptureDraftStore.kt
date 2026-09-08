package com.relayqahub.android.capture

import android.content.Context
import com.relayqahub.android.BuildConfig
import com.relayqahub.android.poco.PocoEnrichmentStatus
import java.io.File
import java.io.FileOutputStream
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

data class PendingCaptureDraft(
    val captureId: String,
    val requestedAtEpochMs: Long,
    val width: Int,
    val height: Int,
    val primaryPath: String,
    val primarySize: Int,
    val primarySha256: String,
    val clientSubmissionId: String,
    val clientAttachmentId: String,
    val observedAt: String,
    val qaAppVersion: String,
    val poco: CapturePocoSummary,
    val pocoArtifacts: List<CapturePocoArtifactRef>,
)

/** Durable completion marker shared by single-tap drafts and double-tap pending captures. */
class PendingCaptureDraftStore(context: Context) {
    private val root = File(context.filesDir, CAPTURE_DRAFT_DIRECTORY).canonicalFile

    suspend fun persist(result: CaptureResult.Ready): PendingCaptureDraft =
        withContext(Dispatchers.IO) {
            require(
                result.mode == CapturedDraftMode.OPEN_DRAFT ||
                    result.mode == CapturedDraftMode.SAVE_PENDING,
            )
            requireCaptureId(result.captureId)
            require(result.requestedAtEpochMs > 0L)
            require(result.width in 1..MAX_DIMENSION && result.height in 1..MAX_DIMENSION)

            val primary = resolvePrimary(result.captureId, result.privatePath)
            val primarySize = primary.length().toBoundedInt(MAX_PRIMARY_BYTES)
            val primarySha256 = primary.sha256Hex()
            val artifacts = result.pocoArtifacts.map { validateArtifact(it, result.captureId) }
            val existing = runCatching { readSidecar(sidecar(result.captureId)) }.getOrNull()
            val submissionId = existing?.clientSubmissionId ?: UUID.randomUUID().toString()
            val attachmentId = existing?.clientAttachmentId ?: UUID.randomUUID().toString()
            val draft = PendingCaptureDraft(
                captureId = result.captureId,
                requestedAtEpochMs = result.requestedAtEpochMs,
                width = result.width,
                height = result.height,
                primaryPath = primary.absolutePath,
                primarySize = primarySize,
                primarySha256 = primarySha256,
                clientSubmissionId = submissionId,
                clientAttachmentId = attachmentId,
                observedAt = Instant.ofEpochMilli(result.requestedAtEpochMs).toString(),
                qaAppVersion = BuildConfig.VERSION_NAME,
                poco = result.poco,
                pocoArtifacts = artifacts,
            )
            writeSidecar(draft)
            draft
        }

    suspend fun latest(): PendingCaptureDraft? = withContext(Dispatchers.IO) {
        root.listFiles()
            .orEmpty()
            .asSequence()
            .filter { it.isFile && it.name.endsWith(SIDECAR_SUFFIX) }
            .mapNotNull { file -> runCatching { readSidecar(file) }.getOrNull() }
            .sortedWith(
                compareByDescending<PendingCaptureDraft> { it.requestedAtEpochMs }
                    .thenByDescending { it.captureId },
            )
            .firstOrNull()
    }

    suspend fun find(captureId: String): PendingCaptureDraft? = withContext(Dispatchers.IO) {
        requireCaptureId(captureId)
        sidecar(captureId).takeIf(File::isFile)?.let(::readSidecar)
    }

    suspend fun readPrimary(draft: PendingCaptureDraft): ByteArray = withContext(Dispatchers.IO) {
        val primary = resolvePrimary(draft.captureId, draft.primaryPath)
        check(primary.length().toBoundedInt(MAX_PRIMARY_BYTES) == draft.primarySize) {
            "PENDING_CAPTURE_SIZE_MISMATCH"
        }
        check(primary.sha256Hex() == draft.primarySha256) {
            "PENDING_CAPTURE_HASH_MISMATCH"
        }
        primary.readBytes()
    }

    suspend fun delete(draft: PendingCaptureDraft) = withContext(Dispatchers.IO) {
        requireCaptureId(draft.captureId)
        deletePendingCaptureFiles(root, draft)
    }

    private fun writeSidecar(draft: PendingCaptureDraft) {
        root.mkdirs()
        val target = sidecar(draft.captureId)
        val temporary = File(root, "${target.name}.tmp-${UUID.randomUUID()}")
        val payload = draft.toJson().toString().toByteArray(Charsets.UTF_8)
        require(payload.size <= MAX_SIDECAR_BYTES)
        try {
            FileOutputStream(temporary).use { output ->
                output.write(payload)
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
    }

    private fun readSidecar(file: File): PendingCaptureDraft {
        val canonical = file.canonicalFile
        require(canonical.parentFile == root && canonical.name.endsWith(SIDECAR_SUFFIX))
        require(canonical.length() in 1..MAX_SIDECAR_BYTES.toLong())
        val json = JSONObject(canonical.readText(Charsets.UTF_8))
        require(json.getInt("schemaVersion") == SCHEMA_VERSION)
        val captureId = json.getString("captureId").also(::requireCaptureId)
        require(canonical == sidecar(captureId))
        val primary = resolveRelative(json.getString("primaryRelativePath"))
        require(primary.parentFile == root && primary.name == "$captureId.png")
        val primarySize = json.getInt("primarySize").also {
            require(it in 1..MAX_PRIMARY_BYTES)
        }
        require(primary.length() == primarySize.toLong())
        val primarySha256 = json.getString("primarySha256").also(::requireSha256)
        require(primary.sha256Hex() == primarySha256)
        val artifactsJson = json.getJSONArray("pocoArtifacts")
        require(artifactsJson.length() <= CapturePocoArtifactKind.entries.size)
        val artifacts = (0 until artifactsJson.length()).map { index ->
            val item = artifactsJson.getJSONObject(index)
            val ref = CapturePocoArtifactRef(
                kind = CapturePocoArtifactKind.valueOf(item.getString("kind")),
                privatePath = resolveRelative(item.getString("relativePath")).absolutePath,
                mediaType = item.getString("mediaType"),
                startedAtEpochMs = item.getLong("startedAtEpochMs"),
                endedAtEpochMs = item.getLong("endedAtEpochMs"),
                truncated = item.getBoolean("truncated"),
            )
            val validated = validateArtifact(ref, captureId)
            require(File(validated.privatePath).length() == item.getInt("size").toLong())
            val expectedSha256 = item.getString("sha256").also(::requireSha256)
            require(File(validated.privatePath).sha256Hex() == expectedSha256)
            validated
        }
        val pocoJson = json.getJSONObject("poco")
        return PendingCaptureDraft(
            captureId = captureId,
            requestedAtEpochMs = json.getLong("requestedAtEpochMs").also { require(it > 0L) },
            width = json.getInt("width").also { require(it in 1..MAX_DIMENSION) },
            height = json.getInt("height").also { require(it in 1..MAX_DIMENSION) },
            primaryPath = primary.absolutePath,
            primarySize = primarySize,
            primarySha256 = primarySha256,
            clientSubmissionId = json.getString("clientSubmissionId").also(::requireUuid),
            clientAttachmentId = json.getString("clientAttachmentId").also(::requireUuid),
            observedAt = json.getString("observedAt").also { require(it.isNotBlank()) },
            qaAppVersion = json.getString("qaAppVersion").also { require(it.isNotBlank()) },
            poco = CapturePocoSummary(
                status = PocoEnrichmentStatus.valueOf(pocoJson.getString("status")),
                port = pocoJson.optInt("port", -1).takeIf { it in 1..65_535 },
                sdkVersion = pocoJson.optInt("sdkVersion", -1).takeIf { it > 0 },
                attemptedMethods = pocoJson.getJSONArray("attemptedMethods").toStrings(),
                succeededMethods = pocoJson.getJSONArray("succeededMethods").toStrings(),
                screenWidth = pocoJson.optInt("screenWidth", -1).takeIf { it in 1..MAX_DIMENSION },
                screenHeight = pocoJson.optInt("screenHeight", -1).takeIf { it in 1..MAX_DIMENSION },
                failureCode = if (pocoJson.isNull("failureCode")) {
                    null
                } else {
                    pocoJson.getString("failureCode").takeIf(String::isNotBlank)
                },
            ),
            pocoArtifacts = artifacts,
        )
    }

    private fun validateArtifact(
        ref: CapturePocoArtifactRef,
        captureId: String,
    ): CapturePocoArtifactRef {
        requireCaptureId(captureId)
        require(ref.mediaType.isNotBlank())
        require(ref.startedAtEpochMs > 0L && ref.endedAtEpochMs >= ref.startedAtEpochMs)
        val file = File(ref.privatePath).canonicalFile
        val relative = file.relativeToOrNull(root) ?: error("artifact left capture root")
        require(!relative.path.startsWith(".."))
        require(file.parentFile == File(root, captureId).canonicalFile)
        file.length().toBoundedInt(MAX_ARTIFACT_BYTES)
        return ref.copy(privatePath = file.absolutePath)
    }

    private fun resolvePrimary(captureId: String, path: String): File {
        requireCaptureId(captureId)
        val file = File(path).canonicalFile
        require(file.parentFile == root && file.name == "$captureId.png")
        require(file.isFile)
        return file
    }

    private fun resolveRelative(path: String): File {
        require(path.isNotBlank() && !File(path).isAbsolute)
        val file = File(root, path).canonicalFile
        val relative = file.relativeToOrNull(root) ?: error("path left capture root")
        require(!relative.path.startsWith("..") && file.isFile)
        return file
    }

    private fun sidecar(captureId: String): File {
        requireCaptureId(captureId)
        return File(root, "$captureId$SIDECAR_SUFFIX").canonicalFile.also {
            require(it.parentFile == root)
        }
    }

    private fun PendingCaptureDraft.toJson(): JSONObject = JSONObject()
        .put("schemaVersion", SCHEMA_VERSION)
        .put("captureId", captureId)
        .put("requestedAtEpochMs", requestedAtEpochMs)
        .put("width", width)
        .put("height", height)
        .put("primaryRelativePath", File(primaryPath).canonicalFile.relativeTo(root).path)
        .put("primarySize", primarySize)
        .put("primarySha256", primarySha256)
        .put("clientSubmissionId", clientSubmissionId)
        .put("clientAttachmentId", clientAttachmentId)
        .put("observedAt", observedAt)
        .put("qaAppVersion", qaAppVersion)
        .put("poco", poco.toJson())
        .put("pocoArtifacts", JSONArray().also { array ->
            pocoArtifacts.forEach { ref ->
                val file = File(ref.privatePath).canonicalFile
                array.put(
                    JSONObject()
                        .put("kind", ref.kind.name)
                        .put("relativePath", file.relativeTo(root).path)
                        .put("mediaType", ref.mediaType)
                        .put("startedAtEpochMs", ref.startedAtEpochMs)
                        .put("endedAtEpochMs", ref.endedAtEpochMs)
                        .put("truncated", ref.truncated)
                        .put("size", file.length())
                        .put("sha256", file.sha256Hex()),
                )
            }
        })

    private fun CapturePocoSummary.toJson(): JSONObject = JSONObject()
        .put("status", status.name)
        .put("port", port ?: JSONObject.NULL)
        .put("sdkVersion", sdkVersion ?: JSONObject.NULL)
        .put("attemptedMethods", JSONArray(attemptedMethods))
        .put("succeededMethods", JSONArray(succeededMethods))
        .put("screenWidth", screenWidth ?: JSONObject.NULL)
        .put("screenHeight", screenHeight ?: JSONObject.NULL)
        .put("failureCode", failureCode ?: JSONObject.NULL)

    private fun JSONArray.toStrings(): List<String> = (0 until length()).map { index ->
        getString(index).also { require(it.isNotBlank()) }
    }

    private fun File.sha256Hex(): String {
        val digest = MessageDigest.getInstance("SHA-256")
        inputStream().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun Long.toBoundedInt(max: Int): Int {
        require(this in 1..max.toLong())
        return toInt()
    }

    private fun requireCaptureId(value: String) {
        require(CAPTURE_ID_PATTERN.matches(value))
    }

    private fun requireUuid(value: String) {
        require(runCatching { UUID.fromString(value) }.isSuccess)
    }

    private fun requireSha256(value: String) {
        require(SHA256_PATTERN.matches(value))
    }

    private companion object {
        const val CAPTURE_DRAFT_DIRECTORY = "capture-drafts"
        const val SIDECAR_SUFFIX = ".pending.json"
        const val SCHEMA_VERSION = 1
        const val MAX_SIDECAR_BYTES = 128 * 1024
        const val MAX_PRIMARY_BYTES = 20 * 1024 * 1024
        const val MAX_ARTIFACT_BYTES = 20 * 1024 * 1024
        const val MAX_DIMENSION = 32_768
        val CAPTURE_ID_PATTERN = Regex(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-" +
                "[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        )
        val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
    }
}

/** Validate every target before deleting only this capture's app-private files. */
internal fun deletePendingCaptureFiles(directory: File, draft: PendingCaptureDraft) {
    val root = directory.canonicalFile
    val artifactRoot = File(root, draft.captureId).canonicalFile
    require(artifactRoot.parentFile == root)
    val primary = File(draft.primaryPath).canonicalFile
    require(primary.parentFile == root && primary.name == "${draft.captureId}.png")
    val marker = File(root, "${draft.captureId}.pending.json").canonicalFile
    require(marker.parentFile == root)
    val artifacts = draft.pocoArtifacts.map { ref ->
        File(ref.privatePath).canonicalFile.also { require(it.parentFile == artifactRoot) }
    }
    val targets = (artifacts + primary + marker).distinct()
    require(targets.all { !it.exists() || it.isFile })
    // Unlike File.delete(), this reports failed removal instead of hiding it from the UI.
    targets.forEach { Files.deleteIfExists(it.toPath()) }
    if (artifactRoot.isDirectory && artifactRoot.list()?.isEmpty() == true) {
        Files.deleteIfExists(artifactRoot.toPath())
    }
}
