package com.relayqahub.android

import com.relayqahub.android.network.AndroidUpdateRelease
import com.relayqahub.android.network.ApkArtifactKind
import com.relayqahub.android.ui.AuthenticatedSurface
import com.relayqahub.android.ui.openAppUpdate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class ApkInstallFlowTest {
    @Test
    fun `newer self update is returned for immediate download`() {
        val release = release(versionCode = 12L)

        val decision = resolveSelfUpdate(
            release = release,
            applicationId = PACKAGE_NAME,
            currentVersionCode = 11L,
            checkedAtEpochMs = 123L,
        )

        assertEquals("available", decision.state.phase)
        assertEquals(release, decision.state.release)
        assertEquals(ApkArtifactKind.SELF_UPDATE, decision.autoDownload?.kind)
        assertEquals(release.downloadUrl, decision.autoDownload?.id)
    }

    @Test
    fun `current self update does not start another download`() {
        val decision = resolveSelfUpdate(
            release = release(versionCode = 11L),
            applicationId = PACKAGE_NAME,
            currentVersionCode = 11L,
            checkedAtEpochMs = 123L,
        )

        assertEquals("up_to_date", decision.state.phase)
        assertNull(decision.autoDownload)
    }

    @Test
    fun `installer launch resets only its completed handoff`() {
        val installing = ApkDownloadUiState(
            phase = "installing",
            artifactId = "game-apk",
            fileName = "game.apk",
            progressPercent = 100,
        )
        val downloading = installing.copy(phase = "downloading")

        assertEquals(ApkDownloadUiState(), completeInstallerHandoff(installing, "game-apk"))
        assertSame(installing, completeInstallerHandoff(installing, "another-apk"))
        assertSame(downloading, completeInstallerHandoff(downloading, "game-apk"))
    }

    @Test
    fun `app update entry leaves project detail and opens its visible update surface`() {
        val destination = AuthenticatedSurface(
            page = QaHubPage.BUG_LIST,
            projectToolsOpen = true,
        ).openAppUpdate()

        assertEquals(QaHubPage.CAPTURE_SETTINGS, destination.page)
        assertFalse(destination.projectToolsOpen)
    }

    private fun release(versionCode: Long) = AndroidUpdateRelease(
        versionCode = versionCode,
        versionName = "0.1.11-debug",
        packageName = PACKAGE_NAME,
        fileName = "Relay-QA-Hub.apk",
        sizeBytes = 1024L,
        sha256 = "a".repeat(64),
        downloadUrl = "http://10.100.5.157:4319/downloads/Relay-QA-Hub.apk",
    )

    companion object {
        private const val PACKAGE_NAME = "com.relayqahub.android.debug"
    }
}
