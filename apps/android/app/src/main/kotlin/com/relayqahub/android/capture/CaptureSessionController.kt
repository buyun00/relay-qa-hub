package com.relayqahub.android.capture

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.relayqahub.android.overlay.OverlayPermissionController
import java.util.UUID

object CaptureSessionController {
    fun startAuthorizedSession(
        context: Context,
        resultCode: Int,
        resultData: Intent,
    ) {
        require(resultCode == Activity.RESULT_OK) { "MediaProjection consent is required" }
        ContextCompat.startForegroundService(
            context,
            CaptureSessionService.startIntent(context, resultCode, resultData),
        )
    }

    fun captureNow(context: Context) {
        OverlayPermissionController.hideForCapture(context, showStopControl = false)
        context.startService(
            CaptureSessionService.captureIntent(
                context,
                UUID.randomUUID().toString(),
                System.currentTimeMillis(),
            ),
        )
    }

    fun stop(context: Context) {
        context.startService(CaptureSessionService.stopIntent(context))
    }
}
