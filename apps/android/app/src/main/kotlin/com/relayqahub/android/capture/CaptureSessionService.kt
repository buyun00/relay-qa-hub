package com.relayqahub.android.capture

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.relayqahub.android.MainActivity
import com.relayqahub.android.R
import com.relayqahub.android.overlay.OverlayCaptureBridge
import com.relayqahub.android.overlay.OverlayCaptureCommand
import com.relayqahub.android.overlay.OverlayPermissionController
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicReference

class CaptureSessionService : Service() {
    private data class PendingCapture(
        val captureId: String,
        val mode: CapturedDraftMode,
        val openApp: Boolean,
    )

    private val pendingCapture = AtomicReference<PendingCapture?>()
    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            endSession("projection_stopped", notifyUnavailable = true)
            stopSelf()
        }
    }

    private lateinit var frameThread: HandlerThread
    private lateinit var frameHandler: Handler
    private var overlayRegistration: Closeable? = null
    private var mediaProjection: MediaProjection? = null
    private var imageReader: ImageReader? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var endingSession = false

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        frameThread = HandlerThread("qa-hub-capture-frame").also { it.start() }
        frameHandler = Handler(frameThread.looper)
        overlayRegistration = OverlayCaptureBridge.register(this, ::onOverlayRequest)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START_SESSION -> startAuthorizedSession(intent)
            ACTION_CAPTURE_NOW -> requestCapture(
                captureId = intent.getStringExtra(EXTRA_CAPTURE_ID),
                mode = CapturedDraftMode.OPEN_DRAFT,
                openApp = false,
            )
            ACTION_STOP_SESSION -> {
                endSession("user_stopped", notifyUnavailable = false)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        endSession("task_removed", notifyUnavailable = true)
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        endSession("service_destroyed", notifyUnavailable = false)
        overlayRegistration?.close()
        overlayRegistration = null
        OverlayPermissionController.stop(this)
        frameThread.quitSafely()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startAuthorizedSession(intent: Intent) {
        if (mediaProjection != null) {
            CaptureResultBridge.send(this, CaptureResult.Unavailable("capture_session_already_active"))
            return
        }
        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
        val resultData = intent.readProjectionResultData()
        if (resultCode != Activity.RESULT_OK || resultData == null) {
            CaptureResultBridge.send(this, CaptureResult.Unavailable("media_projection_permission_denied"))
            stopSelf()
            return
        }

        startProjectionForeground()
        try {
            val manager = getSystemService(MediaProjectionManager::class.java)
            val projection = manager.getMediaProjection(resultCode, resultData)
                ?: error("MediaProjection token was not returned")
            endingSession = false
            mediaProjection = projection
            projection.registerCallback(projectionCallback, frameHandler)

            val bounds = getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds
            val width = bounds.width().coerceAtLeast(1)
            val height = bounds.height().coerceAtLeast(1)
            val densityDpi = resources.displayMetrics.densityDpi
            val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
            reader.setOnImageAvailableListener(::onImageAvailable, frameHandler)
            val display = projection.createVirtualDisplay(
                "Relay QA Hub evidence session",
                width,
                height,
                densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader.surface,
                null,
                frameHandler,
            )

            imageReader = reader
            virtualDisplay = display
            when (OverlayPermissionController.startAfterUserConsent(this)) {
                is com.relayqahub.android.overlay.OverlayStartResult.Started -> Unit
                is com.relayqahub.android.overlay.OverlayStartResult.PermissionRequired -> {
                    throw SecurityException("SYSTEM_ALERT_WINDOW permission was revoked")
                }
            }
            CaptureResultBridge.send(this, CaptureResult.SessionState(active = true))
        } catch (failure: Throwable) {
            endSession("capture_session_start_failed", notifyUnavailable = false)
            CaptureResultBridge.send(
                this,
                CaptureResult.Unavailable(
                    if (failure is SecurityException) "capture_permission_or_service_order_invalid"
                    else "capture_session_start_failed",
                ),
            )
            stopSelf()
        }
    }

    private fun onOverlayRequest(request: com.relayqahub.android.overlay.OverlayCaptureRequest) {
        when (request.command) {
            OverlayCaptureCommand.CAPTURE_AND_OPEN_DRAFT -> requestCapture(
                captureId = request.captureId,
                mode = CapturedDraftMode.OPEN_DRAFT,
                openApp = true,
            )

            OverlayCaptureCommand.CAPTURE_AND_SAVE_PENDING -> requestCapture(
                captureId = request.captureId,
                mode = CapturedDraftMode.SAVE_PENDING,
                openApp = false,
            )

            OverlayCaptureCommand.START_RECORDING,
            OverlayCaptureCommand.STOP_CAPTURE,
            -> {
                CaptureResultBridge.send(this, CaptureResult.Unavailable("recording_not_in_mvp_slice"))
                OverlayPermissionController.restoreAfterCapture(this)
            }
        }
    }

    private fun requestCapture(
        captureId: String?,
        mode: CapturedDraftMode,
        openApp: Boolean,
    ) {
        val id = captureId?.takeIf { CAPTURE_ID_PATTERN.matches(it) }
        if (id == null) {
            CaptureResultBridge.send(this, CaptureResult.Unavailable("capture_id_invalid"))
            OverlayPermissionController.restoreAfterCapture(this)
            return
        }
        if (mediaProjection == null || imageReader == null) {
            CaptureResultBridge.send(this, CaptureResult.Unavailable("capture_session_not_active"))
            OverlayPermissionController.restoreAfterCapture(this)
            return
        }
        if (!pendingCapture.compareAndSet(null, PendingCapture(id, mode, openApp))) {
            CaptureResultBridge.send(this, CaptureResult.Unavailable("capture_already_pending"))
            OverlayPermissionController.restoreAfterCapture(this)
        }
    }

    private fun onImageAvailable(reader: ImageReader) {
        val image = reader.acquireLatestImage() ?: return
        val pending = pendingCapture.getAndSet(null)
        if (pending == null) {
            image.close()
            return
        }

        try {
            val png = image.toPng()
            if (png.size > MAX_CAPTURE_BYTES) {
                throw IllegalStateException("captured PNG exceeds the current bounded upload")
            }
            val directory = File(filesDir, CAPTURE_DRAFT_DIRECTORY).apply { mkdirs() }
            val file = File(directory, "${pending.captureId}.png")
            FileOutputStream(file, false).use { output ->
                output.write(png)
                output.fd.sync()
            }
            CaptureResultBridge.send(
                this,
                CaptureResult.Ready(
                    captureId = pending.captureId,
                    privatePath = file.absolutePath,
                    width = image.width,
                    height = image.height,
                    mode = pending.mode,
                ),
            )
            if (pending.openApp) openAppFromUserCapture()
        } catch (_: Throwable) {
            CaptureResultBridge.send(this, CaptureResult.Unavailable("capture_frame_unavailable"))
        } finally {
            image.close()
            OverlayPermissionController.restoreAfterCapture(this)
        }
    }

    private fun startProjectionForeground() {
        val stop = PendingIntent.getService(
            this,
            STOP_REQUEST_CODE,
            stopIntent(this),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val openApp = PendingIntent.getActivity(
            this,
            OPEN_APP_REQUEST_CODE,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("QA Hub 正在取证")
            .setContentText("屏幕取证会话已由你明确启动；可随时停止")
            .setContentIntent(openApp)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(0, "立即停止", stop)
            .build()
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
        )
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "QA 取证会话",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "显示由用户明确启动的 QA 截图或录屏状态"
                setShowBadge(false)
            },
        )
    }

    private fun endSession(reason: String, notifyUnavailable: Boolean) {
        if (endingSession) return
        endingSession = true
        pendingCapture.set(null)
        imageReader?.setOnImageAvailableListener(null, null)
        virtualDisplay?.release()
        virtualDisplay = null
        imageReader?.close()
        imageReader = null
        val projection = mediaProjection
        mediaProjection = null
        projection?.unregisterCallback(projectionCallback)
        projection?.stop()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        CaptureResultBridge.send(this, CaptureResult.SessionState(active = false))
        if (notifyUnavailable) {
            CaptureResultBridge.send(this, CaptureResult.Unavailable(reason))
        }
    }

    private fun openAppFromUserCapture() {
        runCatching {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(
                        Intent.FLAG_ACTIVITY_NEW_TASK or
                            Intent.FLAG_ACTIVITY_CLEAR_TOP or
                            Intent.FLAG_ACTIVITY_SINGLE_TOP,
                    ),
            )
        }
    }

    private fun Image.toPng(): ByteArray {
        val plane = planes.firstOrNull() ?: error("captured image has no plane")
        require(plane.pixelStride == 4) { "unsupported capture pixel stride" }
        val paddedWidth = width + (plane.rowStride - plane.pixelStride * width) / plane.pixelStride
        val padded = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888)
        return try {
            plane.buffer.rewind()
            padded.copyPixelsFromBuffer(plane.buffer)
            val cropped = if (paddedWidth == width) padded else Bitmap.createBitmap(padded, 0, 0, width, height)
            try {
                ByteArrayOutputStream().use { output ->
                    check(cropped.compress(Bitmap.CompressFormat.PNG, 100, output))
                    output.toByteArray()
                }
            } finally {
                if (cropped !== padded) cropped.recycle()
            }
        } finally {
            padded.recycle()
        }
    }

    private fun Intent.readProjectionResultData(): Intent? =
        getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)

    companion object {
        private const val ACTION_START_SESSION =
            "com.relayqahub.android.capture.action.START_SESSION"
        private const val ACTION_CAPTURE_NOW =
            "com.relayqahub.android.capture.action.CAPTURE_NOW"
        private const val ACTION_STOP_SESSION =
            "com.relayqahub.android.capture.action.STOP_SESSION"
        private const val EXTRA_RESULT_CODE = "resultCode"
        private const val EXTRA_RESULT_DATA = "resultData"
        private const val EXTRA_CAPTURE_ID = "captureId"
        private const val NOTIFICATION_CHANNEL_ID = "qa_capture_session"
        private const val NOTIFICATION_ID = 3701
        private const val STOP_REQUEST_CODE = 3702
        private const val OPEN_APP_REQUEST_CODE = 3703
        private const val CAPTURE_DRAFT_DIRECTORY = "capture-drafts"
        private const val MAX_CAPTURE_BYTES = 20 * 1024 * 1024
        private val CAPTURE_ID_PATTERN = Regex(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        )

        fun startIntent(
            context: Context,
            resultCode: Int,
            resultData: Intent,
        ): Intent = Intent(context, CaptureSessionService::class.java)
            .setAction(ACTION_START_SESSION)
            .putExtra(EXTRA_RESULT_CODE, resultCode)
            .putExtra(EXTRA_RESULT_DATA, resultData)

        fun captureIntent(context: Context, captureId: String): Intent =
            Intent(context, CaptureSessionService::class.java)
                .setAction(ACTION_CAPTURE_NOW)
                .putExtra(EXTRA_CAPTURE_ID, captureId)

        fun stopIntent(context: Context): Intent =
            Intent(context, CaptureSessionService::class.java).setAction(ACTION_STOP_SESSION)
    }
}
