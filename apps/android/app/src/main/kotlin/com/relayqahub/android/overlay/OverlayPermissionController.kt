package com.relayqahub.android.overlay

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings

sealed interface OverlayStartResult {
    data object Started : OverlayStartResult

    /** The caller must visibly present and launch this system permission screen. */
    data class PermissionRequired(
        val settingsIntent: Intent,
    ) : OverlayStartResult
}

/**
 * Explicit entry points for the overlay lifecycle. Nothing in this package
 * starts at boot or silently opens the system permission screen.
 */
object OverlayPermissionController {
    fun isGranted(context: Context): Boolean = Settings.canDrawOverlays(context)

    fun permissionSettingsIntent(context: Context): Intent =
        Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:${context.packageName}"),
        )

    fun startAfterUserConsent(context: Context): OverlayStartResult {
        if (!isGranted(context)) {
            return OverlayStartResult.PermissionRequired(permissionSettingsIntent(context))
        }

        context.startService(QaOverlayService.startIntent(context))
        return OverlayStartResult.Started
    }

    fun hideForCapture(
        context: Context,
        showStopControl: Boolean,
    ) {
        context.startService(QaOverlayService.hideIntent(context, showStopControl))
    }

    fun restoreAfterCapture(context: Context) {
        context.startService(QaOverlayService.restoreIntent(context))
    }

    fun stop(context: Context) {
        context.stopService(Intent(context, QaOverlayService::class.java))
    }
}
