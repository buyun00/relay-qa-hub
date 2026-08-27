package com.relayqahub.android

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.relayqahub.android.capture.CaptureResult
import com.relayqahub.android.capture.CaptureResultBridge
import com.relayqahub.android.capture.CaptureSessionController
import com.relayqahub.android.capture.CapturedDraftMode
import com.relayqahub.android.overlay.OverlayPermissionController
import com.relayqahub.android.network.ApkArtifactKind
import com.relayqahub.android.network.DownloadedApk
import com.relayqahub.android.ui.QaHubRoot
import com.relayqahub.android.ui.QaHubTheme
import java.io.Closeable
import java.io.File
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private var foundationViewModel: FoundationViewModel? = null
    private var captureResultRegistration: Closeable? = null
    private var installRequestJob: Job? = null
    private var pendingInstall: DownloadedApk? = null

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) continueStartAfterNotificationPermission()
        else foundationViewModel?.reportCaptureUnavailable("notification permission denied")
    }

    private val localNetworkPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            foundationViewModel?.refreshBugWorkbench()
        } else {
            Toast.makeText(
                this,
                "需要允许附近设备权限才能连接内网 QA Hub",
                Toast.LENGTH_LONG,
            ).show()
        }
    }

    private val overlayPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        val granted = OverlayPermissionController.isGranted(this)
        foundationViewModel?.reportOverlayPermissionState(granted)
        if (granted) {
            Toast.makeText(
                this,
                "已允许在其他应用上层显示；需要截图时再授权整屏捕获",
                Toast.LENGTH_LONG,
            ).show()
        } else {
            foundationViewModel?.reportCaptureUnavailable("overlay permission denied")
        }
    }

    private val projectionPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            foundationViewModel?.reportCaptureUnavailable("screen-sharing permission denied")
            return@registerForActivityResult
        }
        runCatching {
            foundationViewModel?.reportCaptureSessionStarting()
            CaptureSessionController.startAuthorizedSession(this, result.resultCode, data)
        }.onFailure {
            foundationViewModel?.reportCaptureUnavailable("capture foreground service could not start")
        }
    }

    private val unknownSourcesPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        val pending = pendingInstall ?: return@registerForActivityResult
        if (packageManager.canRequestPackageInstalls()) {
            launchPackageInstaller(pending)
        } else {
            foundationViewModel?.reportApkInstallFailure("APK_INSTALL_PERMISSION_DENIED")
            pendingInstall = null
            Toast.makeText(this, "未允许安装未知应用，APK 已保留，可稍后重试。", Toast.LENGTH_LONG).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        captureResultRegistration = CaptureResultBridge.register(this, ::onCaptureResult)
        requestLocalNetworkPermissionIfNeeded()
        enableEdgeToEdge()
        setContent {
            QaHubTheme {
                QaHubRoot(
                    onViewModelActive = ::activateViewModel,
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
        installRequestJob?.cancel()
        installRequestJob = null
        foundationViewModel = null
        super.onDestroy()
    }

    override fun onResume() {
        super.onResume()
        foundationViewModel?.reportOverlayPermissionState(
            OverlayPermissionController.isGranted(this),
        )
        foundationViewModel?.refreshPendingCapture()
        foundationViewModel?.restoreLatestCaptureDraft()
        // Unlocking the device resumes the foreground activity. Re-enqueue fail-closed
        // keystore operations here so BLOCKED_DEVICE never relies on an implicit retry.
        lifecycleScope.launch {
            (application as QaHubApplication).container.deviceSecurityResume
                .resumeBlockedOperations()
        }
    }

    private fun startCaptureSession() {
        if (!OverlayPermissionController.isGranted(this)) {
            overlayPermissionLauncher.launch(
                OverlayPermissionController.permissionSettingsIntent(this),
            )
            return
        }
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

    private fun activateViewModel(viewModel: FoundationViewModel?) {
        if (foundationViewModel === viewModel) return
        installRequestJob?.cancel()
        installRequestJob = null
        foundationViewModel = viewModel
        viewModel?.reportOverlayPermissionState(OverlayPermissionController.isGranted(this))
        if (viewModel != null) {
            installRequestJob = lifecycleScope.launch {
                lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                    viewModel.apkInstallRequests.collect(::requestApkInstall)
                }
            }
        }
    }

    private fun requestApkInstall(downloaded: DownloadedApk) {
        pendingInstall = downloaded
        if (!packageManager.canRequestPackageInstalls()) {
            unknownSourcesPermissionLauncher.launch(
                Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:$packageName"),
                ),
            )
            return
        }
        launchPackageInstaller(downloaded)
    }

    private fun launchPackageInstaller(downloaded: DownloadedApk) {
        val file = downloaded.file
        val expectedRoot = File(filesDir, "apk-downloads").canonicalFile
        val canonicalFile = runCatching { file.canonicalFile }.getOrNull()
        if (canonicalFile == null || canonicalFile.parentFile != expectedRoot || !canonicalFile.isFile) {
            foundationViewModel?.reportApkInstallFailure("APK_INSTALL_FILE_INVALID")
            pendingInstall = null
            return
        }
        val packageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.getPackageArchiveInfo(
                canonicalFile.absolutePath,
                PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()),
            )
        } else {
            @Suppress("DEPRECATION")
            packageManager.getPackageArchiveInfo(
                canonicalFile.absolutePath,
                PackageManager.GET_SIGNING_CERTIFICATES,
            )
        }
        if (packageInfo == null) {
            foundationViewModel?.reportApkInstallFailure("APK_PACKAGE_INVALID")
            pendingInstall = null
            return
        }
        val artifact = downloaded.artifact
        if (artifact.kind == ApkArtifactKind.SELF_UPDATE &&
            (packageInfo.packageName != artifact.expectedPackageName ||
                packageInfo.longVersionCode != artifact.expectedVersionCode)
        ) {
            foundationViewModel?.reportApkInstallFailure("APK_UPDATE_IDENTITY_MISMATCH")
            pendingInstall = null
            return
        }
        val contentUri = FileProvider.getUriForFile(
            this,
            "$packageName.apk-files",
            canonicalFile,
        )
        val installIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(contentUri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
            startActivity(installIntent)
            pendingInstall = null
        } catch (_: ActivityNotFoundException) {
            foundationViewModel?.reportApkInstallFailure("APK_INSTALLER_UNAVAILABLE")
            pendingInstall = null
        }
    }

    private fun requestLocalNetworkPermissionIfNeeded() {
        if (
            Build.VERSION.SDK_INT >= 37 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_LOCAL_NETWORK) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            localNetworkPermissionLauncher.launch(Manifest.permission.ACCESS_LOCAL_NETWORK)
        }
    }

    private fun continueStartAfterNotificationPermission() {
        launchProjectionConsent()
    }

    private fun launchProjectionConsent() {
        val manager = getSystemService(MediaProjectionManager::class.java)
        projectionPermissionLauncher.launch(manager.createScreenCaptureIntent())
    }

    private fun onCaptureResult(result: CaptureResult) {
        val viewModel = foundationViewModel ?: return
        when (result) {
            is CaptureResult.SessionState -> viewModel.reportCaptureSessionState(result.active)
            is CaptureResult.Unavailable -> viewModel.reportCaptureUnavailable(result.reason)
            is CaptureResult.Ready -> when (result.mode) {
                CapturedDraftMode.OPEN_DRAFT -> viewModel.onCaptureReady(
                    captureId = result.captureId,
                    privatePath = result.privatePath,
                    width = result.width,
                    height = result.height,
                    requestedAtEpochMs = result.requestedAtEpochMs,
                    pocoStatus = result.poco.status.name,
                )
                CapturedDraftMode.SAVE_PENDING -> viewModel.reportPendingCaptureSaved(
                    captureId = result.captureId,
                    width = result.width,
                    height = result.height,
                )
            }
        }
    }
}
