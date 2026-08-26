package com.relayqahub.android.capture

import android.content.Context
import com.relayqahub.android.poco.PocoArtifact
import com.relayqahub.android.poco.PocoEnrichmentResult
import com.relayqahub.android.poco.PocoReadOnlyMethod
import java.io.File
import java.io.FileOutputStream
import java.nio.charset.StandardCharsets

enum class CapturePocoArtifactKind(
    val wireName: String,
    val sourceMethod: PocoReadOnlyMethod,
) {
    SCREENSHOT("poco_screenshot", PocoReadOnlyMethod.SCREENSHOT),
    HIERARCHY("poco_hierarchy", PocoReadOnlyMethod.DUMP_VISIBLE),
    SNAPSHOT("poco_snapshot", PocoReadOnlyMethod.QA_SNAPSHOT),
    PROFILING("poco_profiling", PocoReadOnlyMethod.GET_DEBUG_PROFILING_DATA),
}

data class CapturePocoArtifactRef(
    val kind: CapturePocoArtifactKind,
    val privatePath: String,
    val mediaType: String,
    val startedAtEpochMs: Long,
    val endedAtEpochMs: Long,
    val truncated: Boolean,
)

data class CapturedPocoArtifact(
    val kind: CapturePocoArtifactKind,
    val mediaType: String,
    val bytes: ByteArray,
    val startedAtEpochMs: Long,
    val endedAtEpochMs: Long,
    val truncated: Boolean,
)

/** App-private artifact handoff. Only small file references cross the capture-result broadcast. */
class CaptureArtifactStore(context: Context) {
    private val draftRoot = File(context.filesDir, "capture-drafts").canonicalFile

    fun persistPocoArtifacts(
        captureId: String,
        capturedAtEpochMs: Long,
        anchorEpochMs: Long,
        anchorElapsedNanos: Long,
        result: PocoEnrichmentResult,
    ): List<CapturePocoArtifactRef> {
        requireCaptureId(captureId)
        require(result.captureId == captureId)
        val captureRoot = File(draftRoot, captureId).canonicalFile
        require(captureRoot.relativeToOrNull(draftRoot)?.path?.startsWith("..") == false)
        captureRoot.mkdirs()

        val created = mutableListOf<File>()
        return try {
            result.artifacts.mapNotNull { (method, artifact) ->
                val kind = method.toArtifactKind() ?: return@mapNotNull null
                val outcome = result.outcomes.singleOrNull { it.method == method && it.succeeded }
                    ?: return@mapNotNull null
                val stored = artifact.toStoredArtifact(kind) ?: return@mapNotNull null
                val target = File(captureRoot, stored.filename).canonicalFile
                require(target.parentFile == captureRoot)
                writeExact(target, stored.bytes)
                created += target
                val startedAt = outcome.startedAtElapsedNanos.toEpochMillis(
                    capturedAtEpochMs = capturedAtEpochMs,
                    anchorEpochMs = anchorEpochMs,
                    anchorElapsedNanos = anchorElapsedNanos,
                )
                val endedAt = outcome.completedAtElapsedNanos.toEpochMillis(
                    capturedAtEpochMs = capturedAtEpochMs,
                    anchorEpochMs = anchorEpochMs,
                    anchorElapsedNanos = anchorElapsedNanos,
                ).coerceAtLeast(startedAt)
                CapturePocoArtifactRef(
                    kind = kind,
                    privatePath = target.absolutePath,
                    mediaType = stored.mediaType,
                    startedAtEpochMs = startedAt,
                    endedAtEpochMs = endedAt,
                    truncated = false,
                )
            }
        } catch (failure: Throwable) {
            created.forEach { runCatching { it.delete() } }
            throw failure
        }
    }

    fun read(ref: CapturePocoArtifactRef): CapturedPocoArtifact {
        val file = File(ref.privatePath).canonicalFile
        val relative = file.relativeToOrNull(draftRoot)
            ?: error("Poco artifact path left the app-private draft root")
        require(!relative.path.startsWith("..")) {
            "Poco artifact path left the app-private draft root"
        }
        val bytes = file.readBytes()
        require(bytes.isNotEmpty() && bytes.size <= MAX_ARTIFACT_BYTES)
        return CapturedPocoArtifact(
            kind = ref.kind,
            mediaType = ref.mediaType,
            bytes = bytes,
            startedAtEpochMs = ref.startedAtEpochMs,
            endedAtEpochMs = ref.endedAtEpochMs,
            truncated = ref.truncated,
        )
    }

    private fun writeExact(target: File, bytes: ByteArray) {
        require(bytes.isNotEmpty() && bytes.size <= MAX_ARTIFACT_BYTES)
        FileOutputStream(target).use { output ->
            output.write(bytes)
            output.fd.sync()
        }
    }

    private data class StoredArtifact(
        val filename: String,
        val mediaType: String,
        val bytes: ByteArray,
    )

    private fun PocoArtifact.toStoredArtifact(kind: CapturePocoArtifactKind): StoredArtifact? =
        when (this) {
            is PocoArtifact.Screenshot -> {
                val extension = when (mediaType) {
                    "image/png" -> "png"
                    "image/jpeg" -> "jpg"
                    "image/webp" -> "webp"
                    else -> return null
                }
                StoredArtifact("${kind.wireName}.$extension", mediaType, bytes.copyOf())
            }

            is PocoArtifact.Hierarchy -> StoredArtifact(
                "${kind.wireName}.json",
                "application/json",
                json.toByteArray(StandardCharsets.UTF_8),
            )

            is PocoArtifact.Snapshot -> StoredArtifact(
                "${kind.wireName}.json",
                "application/json",
                json.toByteArray(StandardCharsets.UTF_8),
            )

            is PocoArtifact.Profiling -> StoredArtifact(
                "${kind.wireName}.json",
                "application/json",
                json.toByteArray(StandardCharsets.UTF_8),
            )

            is PocoArtifact.ScreenSize -> null
        }

    private fun PocoReadOnlyMethod.toArtifactKind(): CapturePocoArtifactKind? =
        CapturePocoArtifactKind.entries.singleOrNull { it.sourceMethod == this }

    private fun Long.toEpochMillis(
        capturedAtEpochMs: Long,
        anchorEpochMs: Long,
        anchorElapsedNanos: Long,
    ): Long {
        val raw = anchorEpochMs + ((this - anchorElapsedNanos).coerceAtLeast(0L) / 1_000_000L)
        return raw.coerceIn(capturedAtEpochMs, capturedAtEpochMs + MAX_CAPTURE_SKEW_MS)
    }

    private companion object {
        const val MAX_ARTIFACT_BYTES = 20 * 1024 * 1024
        const val MAX_CAPTURE_SKEW_MS = 5_000L
        val CAPTURE_ID_PATTERN = Regex(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-" +
                "[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        )

        fun requireCaptureId(value: String) {
            require(CAPTURE_ID_PATTERN.matches(value))
        }
    }
}
