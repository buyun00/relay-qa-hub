package com.relayqahub.android

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.relayqahub.android.capture.CaptureResult
import com.relayqahub.android.capture.CaptureResultBridge
import com.relayqahub.android.capture.CaptureSessionController
import com.relayqahub.android.capture.CapturedDraftMode
import com.relayqahub.android.overlay.OverlayPermissionController
import com.relayqahub.android.ui.FoundationScreen
import com.relayqahub.android.ui.QaHubTheme
import java.io.Closeable
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private val foundationViewModel: FoundationViewModel by viewModels()
    private var captureResultRegistration: Closeable? = null

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) continueStartAfterNotificationPermission()
        else foundationViewModel.reportCaptureUnavailable("notification permission denied")
    }

    private val overlayPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        if (OverlayPermissionController.isGranted(this)) launchProjectionConsent()
        else foundationViewModel.reportCaptureUnavailable("overlay permission denied")
    }

    private val projectionPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            foundationViewModel.reportCaptureUnavailable("screen-sharing permission denied")
            return@registerForActivityResult
        }
        runCatching {
            foundationViewModel.reportCaptureSessionStarting()
            CaptureSessionController.startAuthorizedSession(this, result.resultCode, data)
        }.onFailure {
            foundationViewModel.reportCaptureUnavailable("capture foreground service could not start")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        captureResultRegistration = CaptureResultBridge.register(this, ::onCaptureResult)
        enableEdgeToEdge()
        setContent {
            QaHubTheme {
                FoundationScreen(
                    viewModel = foundationViewModel,
                    onStartCaptureSession = ::startCaptureSession,
                    onCaptureNow = { CaptureSessionController.captureNow(this) },
                    onStopCaptureSession = { CaptureSessionController.stop(this) },
                )
            }
        }
    }

    override fun onDestroy() {
        captureResultRegistration?.close()
        captureResultRegistration = null
        super.onDestroy()
    }

    override fun onResume() {
        super.onResume()
        // Unlocking the device resumes the foreground activity. Re-enqueue fail-closed
        // keystore operations here so BLOCKED_DEVICE never relies on an implicit retry.
        lifecycleScope.launch {
            (application as QaHubApplication).container.deviceSecurityResume
                .resumeBlockedOperations()
        }
    }

    private fun startCaptureSession() {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        continueStartAfterNotificationPermission()
    }

    private fun continueStartAfterNotificationPermission() {
        if (!OverlayPermissionController.isGranted(this)) {
            overlayPermissionLauncher.launch(
                OverlayPermissionController.permissionSettingsIntent(this),
            )
            return
        }
        launchProjectionConsent()
    }

    private fun launchProjectionConsent() {
        val manager = getSystemService(MediaProjectionManager::class.java)
        projectionPermissionLauncher.launch(manager.createScreenCaptureIntent())
    }

    private fun onCaptureResult(result: CaptureResult) {
        when (result) {
            is CaptureResult.SessionState -> foundationViewModel.reportCaptureSessionState(result.active)
            is CaptureResult.Unavailable -> foundationViewModel.reportCaptureUnavailable(result.reason)
            is CaptureResult.Ready -> when (result.mode) {
                CapturedDraftMode.OPEN_DRAFT -> submitPrivateCapture(result)
                CapturedDraftMode.SAVE_PENDING -> foundationViewModel.reportPendingCaptureSaved(
                    captureId = result.captureId,
                    width = result.width,
                    height = result.height,
                )
            }
        }
    }

    private fun submitPrivateCapture(result: CaptureResult.Ready) {
        lifecycleScope.launch {
            val bytes = withContext(Dispatchers.IO) {
                val draftRoot = File(filesDir, "capture-drafts").canonicalFile
                val captureFile = File(result.privatePath).canonicalFile
                val relative = captureFile.relativeToOrNull(draftRoot)
                    ?: error("capture path left the app-private draft root")
                require(!relative.path.startsWith("..")) { "capture path left the private root" }
                captureFile.readBytes()
            }
            foundationViewModel.submitCapturedPng(result.captureId, bytes, result.poco)
        }
    }
}
