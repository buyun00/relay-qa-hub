package com.relayqahub.android.capture

import android.content.Context
import android.hardware.display.DisplayManager
import android.util.DisplayMetrics
import android.view.Display

internal data class CaptureDisplayGeometry(
    val width: Int,
    val height: Int,
    val densityDpi: Int,
) {
    init {
        require(width > 0)
        require(height > 0)
        require(densityDpi > 0)
    }

    fun requiresReconfigure(previous: CaptureDisplayGeometry?): Boolean = previous != this

    fun matchesFrame(frameWidth: Int, frameHeight: Int): Boolean =
        width == frameWidth && height == frameHeight

    companion object {
        fun fromPixels(width: Int, height: Int, densityDpi: Int): CaptureDisplayGeometry =
            CaptureDisplayGeometry(
                width = width.coerceAtLeast(1),
                height = height.coerceAtLeast(1),
                densityDpi = densityDpi.coerceAtLeast(1),
            )
    }
}

internal fun Context.currentCaptureDisplayGeometry(): CaptureDisplayGeometry {
    val fallback = resources.displayMetrics
    val metrics = DisplayMetrics()
    val display = getSystemService(DisplayManager::class.java)
        .getDisplay(Display.DEFAULT_DISPLAY)
    if (display != null) {
        @Suppress("DEPRECATION")
        display.getRealMetrics(metrics)
    }
    return CaptureDisplayGeometry.fromPixels(
        width = metrics.widthPixels.takeIf { it > 0 } ?: fallback.widthPixels,
        height = metrics.heightPixels.takeIf { it > 0 } ?: fallback.heightPixels,
        densityDpi = metrics.densityDpi.takeIf { it > 0 } ?: fallback.densityDpi,
    )
}
