package com.relayqahub.android.capture

import com.relayqahub.android.poco.PocoEnrichmentStatus
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PendingCaptureDeletionTest {
    @get:Rule
    val temporary = TemporaryFolder()

    @Test
    fun `removes the selected screenshot recovery marker and context only`() {
        val root = temporary.newFolder("capture-drafts")
        val selected = draft(root, FIRST_ID)
        val newer = draft(root, SECOND_ID)

        deletePendingCaptureFiles(root, selected)

        assertFalse(File(selected.primaryPath).exists())
        assertFalse(File(root, "$FIRST_ID.pending.json").exists())
        assertFalse(File(root, FIRST_ID).exists())
        assertEquals("screenshot", File(newer.primaryPath).readText())
        assertTrue(File(root, "$SECOND_ID.pending.json").isFile)
        assertTrue(File(newer.pocoArtifacts.single().privatePath).isFile)
    }

    @Test
    fun `repeated deletion succeeds when selected files are already absent`() {
        val root = temporary.newFolder("capture-drafts")
        val selected = draft(root, FIRST_ID)

        deletePendingCaptureFiles(root, selected)
        deletePendingCaptureFiles(root, selected)

        assertTrue(root.list()!!.isEmpty())
    }

    @Test
    fun `rejects another capture artifact before removing any selected files`() {
        val root = temporary.newFolder("capture-drafts")
        val selected = draft(root, FIRST_ID)
        val other = draft(root, SECOND_ID)
        val invalid = selected.copy(pocoArtifacts = selected.pocoArtifacts + other.pocoArtifacts)

        assertTrue(runCatching { deletePendingCaptureFiles(root, invalid) }.isFailure)

        assertTrue(File(selected.primaryPath).isFile)
        assertTrue(File(root, "$FIRST_ID.pending.json").isFile)
        assertTrue(File(selected.pocoArtifacts.single().privatePath).isFile)
        assertTrue(File(other.pocoArtifacts.single().privatePath).isFile)
    }

    @Test
    fun `rejects a screenshot outside the draft root without deleting it`() {
        val root = temporary.newFolder("capture-drafts")
        val selected = draft(root, FIRST_ID)
        val outside = temporary.newFile("$FIRST_ID.png").apply { writeText("keep") }

        assertTrue(runCatching {
            deletePendingCaptureFiles(root, selected.copy(primaryPath = outside.path))
        }.isFailure)

        assertEquals("keep", outside.readText())
        assertTrue(File(selected.primaryPath).isFile)
        assertTrue(File(root, "$FIRST_ID.pending.json").isFile)
    }

    private fun draft(root: File, id: String): PendingCaptureDraft {
        val primary = File(root, "$id.png").apply { writeText("screenshot") }
        File(root, "$id.pending.json").writeText("recovery marker")
        val artifactRoot = File(root, id).apply { mkdirs() }
        val artifact = File(artifactRoot, "snapshot.json").apply { writeText("context") }
        return PendingCaptureDraft(
            captureId = id,
            requestedAtEpochMs = 1L,
            width = 1,
            height = 1,
            primaryPath = primary.path,
            primarySize = primary.length().toInt(),
            primarySha256 = "a".repeat(64),
            clientSubmissionId = id,
            clientAttachmentId = id,
            observedAt = "2026-09-08T00:00:00Z",
            qaAppVersion = "test",
            poco = CapturePocoSummary(
                status = PocoEnrichmentStatus.UNAVAILABLE,
                port = null,
                sdkVersion = null,
                attemptedMethods = emptyList(),
                succeededMethods = emptyList(),
                screenWidth = null,
                screenHeight = null,
                failureCode = null,
            ),
            pocoArtifacts = listOf(CapturePocoArtifactRef(
                kind = CapturePocoArtifactKind.SNAPSHOT,
                privatePath = artifact.path,
                mediaType = "application/json",
                startedAtEpochMs = 1L,
                endedAtEpochMs = 1L,
                truncated = false,
            )),
        )
    }

    private companion object {
        const val FIRST_ID = "00000000-0000-4000-8000-000000000001"
        const val SECOND_ID = "00000000-0000-4000-8000-000000000002"
    }
}
