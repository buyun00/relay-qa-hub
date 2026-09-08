package com.relayqahub.android.overlay

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.DisplayMetrics
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.TextView
import java.util.UUID
import kotlin.math.roundToInt

class QaOverlayService : Service() {
    private lateinit var windowManager: WindowManager
    private val mainHandler = Handler(Looper.getMainLooper())

    private var bubbleView: View? = null
    private var bubbleParams: WindowManager.LayoutParams? = null
    private var stopCaptureView: View? = null
    private var activeCaptureId: String? = null
    private var permissionDenied = false

    override fun onCreate() {
        super.onCreate()
        if (!OverlayPermissionController.isGranted(this)) {
            permissionDenied = true
            stopSelf()
            return
        }

        windowManager = getSystemService(WindowManager::class.java)
        runCatching { addOverlayViews() }
            .onFailure { stopSelf() }
    }

    override fun onStartCommand(
        intent: Intent?,
        flags: Int,
        startId: Int,
    ): Int {
        if (permissionDenied || !OverlayPermissionController.isGranted(this)) {
            stopSelf(startId)
            return START_NOT_STICKY
        }

        when (intent?.action ?: ACTION_START) {
            ACTION_START,
            ACTION_RESTORE_AFTER_CAPTURE,
            -> restoreBubble()

            ACTION_HIDE_FOR_CAPTURE -> hideForCapture(
                showStopControl = intent?.getBooleanExtra(EXTRA_SHOW_STOP_CONTROL, false) == true,
            )

            ACTION_STOP_SERVICE -> {
                stopSelf()
                return START_NOT_STICKY
            }
        }
        return START_NOT_STICKY
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        bubbleParams?.let { snapToNearestEdge(it) }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        removeViewSafely(bubbleView)
        removeViewSafely(stopCaptureView)
        bubbleView = null
        stopCaptureView = null
        activeCaptureId = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun addOverlayViews() {
        val bubbleSize = dp(56)
        val params = overlayParams(bubbleSize, bubbleSize).apply {
            gravity = Gravity.TOP or Gravity.START
            x = displayBounds().first - bubbleSize / 2
            y = displayBounds().second / 3
        }
        val bubble = TextView(this).apply {
            text = "QA"
            textSize = 16f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            contentDescription = "QA Hub 取证悬浮球"
            elevation = dp(8).toFloat()
            background = circleBackground(Color.rgb(36, 86, 211))
            setOnTouchListener(BubbleTouchListener(params))
        }
        windowManager.addView(bubble, params)
        bubbleView = bubble
        bubbleParams = params

        val stopParams = overlayParams(dp(132), dp(48)).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            y = dp(28)
        }
        val stopView = TextView(this).apply {
            text = "■  停止取证"
            textSize = 15f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            contentDescription = "立即停止 QA 取证"
            elevation = dp(8).toFloat()
            background = roundedBackground(Color.rgb(190, 28, 45), dp(24).toFloat())
            visibility = View.GONE
            setOnClickListener {
                visibility = View.GONE
                activeCaptureId?.let { captureId ->
                    emitCaptureCommand(OverlayCaptureCommand.STOP_CAPTURE, captureId)
                }
            }
        }
        windowManager.addView(stopView, stopParams)
        stopCaptureView = stopView
    }

    private fun onGesture(signal: OverlayGestureStateMachine.Signal) {
        when (signal) {
            OverlayGestureStateMachine.Signal.SINGLE_TAP ->
                beginCapture(OverlayCaptureCommand.CAPTURE_AND_OPEN_DRAFT, showStopControl = false)

            OverlayGestureStateMachine.Signal.DOUBLE_TAP ->
                beginCapture(
                    OverlayCaptureCommand.CAPTURE_AND_SAVE_PENDING,
                    showStopControl = false,
                )

            OverlayGestureStateMachine.Signal.LONG_PRESS ->
                beginCapture(OverlayCaptureCommand.START_RECORDING, showStopControl = true)

            else -> Unit
        }
    }

    private fun beginCapture(
        command: OverlayCaptureCommand,
        showStopControl: Boolean,
    ) {
        val captureId = UUID.randomUUID().toString()
        activeCaptureId = captureId
        hideForCapture(showStopControl)
        emitCaptureCommand(command, captureId)
    }

    private fun emitCaptureCommand(
        command: OverlayCaptureCommand,
        captureId: String,
    ) {
        OverlayCaptureBridge.send(
            this,
            OverlayCaptureRequest(
                command = command,
                captureId = captureId,
                requestedAtEpochMs = System.currentTimeMillis(),
            ),
        )
    }

    private fun hideForCapture(showStopControl: Boolean) {
        bubbleView?.visibility = View.GONE
        stopCaptureView?.visibility = if (showStopControl) View.VISIBLE else View.GONE
    }

    private fun restoreBubble() {
        activeCaptureId = null
        stopCaptureView?.visibility = View.GONE
        bubbleView?.visibility = View.VISIBLE
    }

    private fun overlayParams(
        width: Int,
        height: Int,
    ): WindowManager.LayoutParams = WindowManager.LayoutParams(
        width,
        height,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    )

    private fun snapToNearestEdge(params: WindowManager.LayoutParams) {
        val (screenWidth, screenHeight) = displayBounds()
        val bubbleWidth = bubbleView?.width?.takeIf { it > 0 } ?: dp(56)
        val bubbleHeight = bubbleView?.height?.takeIf { it > 0 } ?: dp(56)
        val currentCenter = params.x + bubbleWidth / 2
        params.x = if (currentCenter < screenWidth / 2) {
            -bubbleWidth / 2
        } else {
            screenWidth - bubbleWidth / 2
        }
        params.y = params.y.coerceIn(0, (screenHeight - bubbleHeight).coerceAtLeast(0))
        bubbleView?.let { windowManager.updateViewLayout(it, params) }
    }

    @Suppress("DEPRECATION")
    private fun displayBounds(): Pair<Int, Int> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val bounds = windowManager.currentWindowMetrics.bounds
        bounds.width() to bounds.height()
    } else {
        DisplayMetrics().also(windowManager.defaultDisplay::getRealMetrics).let { metrics ->
            metrics.widthPixels to metrics.heightPixels
        }
    }

    private fun removeViewSafely(view: View?) {
        if (view != null) runCatching { windowManager.removeView(view) }
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).roundToInt()

    private fun circleBackground(color: Int): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(color)
            setStroke(dp(2), Color.argb(180, 255, 255, 255))
        }

    private fun roundedBackground(
        color: Int,
        radius: Float,
    ): GradientDrawable = GradientDrawable().apply {
        cornerRadius = radius
        setColor(color)
    }

    private inner class BubbleTouchListener(
        private val params: WindowManager.LayoutParams,
    ) : View.OnTouchListener {
        private val configuration = ViewConfiguration.get(this@QaOverlayService)
        private val gestures = OverlayGestureStateMachine(
            dragSlopPx = configuration.scaledTouchSlop.toFloat(),
            doubleTapSlopPx = configuration.scaledDoubleTapSlop.toFloat(),
            doubleTapTimeoutMs = ViewConfiguration.getDoubleTapTimeout().toLong(),
            longPressTimeoutMs = ViewConfiguration.getLongPressTimeout().toLong(),
        )

        private var downRawX = 0f
        private var downRawY = 0f
        private var downWindowX = 0
        private var downWindowY = 0

        private val longPressRunnable = Runnable {
            onGesture(gestures.onLongPressDeadline(SystemClock.uptimeMillis()))
        }
        private val singleTapRunnable = Runnable {
            onGesture(gestures.onSingleTapDeadline(SystemClock.uptimeMillis()))
        }

        override fun onTouch(
            view: View,
            event: MotionEvent,
        ): Boolean {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = event.rawX
                    downRawY = event.rawY
                    downWindowX = params.x
                    downWindowY = params.y
                    gestures.onDown(event.eventTime, event.rawX, event.rawY)
                    mainHandler.removeCallbacks(longPressRunnable)
                    mainHandler.postDelayed(
                        longPressRunnable,
                        ViewConfiguration.getLongPressTimeout().toLong(),
                    )
                }

                MotionEvent.ACTION_MOVE -> {
                    if (gestures.onMove(event.rawX, event.rawY) == OverlayGestureStateMachine.Signal.DRAG) {
                        mainHandler.removeCallbacks(longPressRunnable)
                        mainHandler.removeCallbacks(singleTapRunnable)
                        moveBubble(event.rawX, event.rawY)
                    }
                }

                MotionEvent.ACTION_UP -> {
                    mainHandler.removeCallbacks(longPressRunnable)
                    when (val signal = gestures.onUp(event.eventTime, event.rawX, event.rawY)) {
                        OverlayGestureStateMachine.Signal.DRAG_END -> snapToNearestEdge(params)
                        OverlayGestureStateMachine.Signal.DOUBLE_TAP -> {
                            mainHandler.removeCallbacks(singleTapRunnable)
                            onGesture(signal)
                        }

                        OverlayGestureStateMachine.Signal.NONE -> {
                            mainHandler.removeCallbacks(singleTapRunnable)
                            mainHandler.postDelayed(
                                singleTapRunnable,
                                ViewConfiguration.getDoubleTapTimeout().toLong(),
                            )
                        }

                        else -> onGesture(signal)
                    }
                }

                MotionEvent.ACTION_CANCEL -> {
                    mainHandler.removeCallbacks(longPressRunnable)
                    gestures.cancelPointer()
                    snapToNearestEdge(params)
                }
            }
            return true
        }

        private fun moveBubble(
            rawX: Float,
            rawY: Float,
        ) {
            val (screenWidth, screenHeight) = displayBounds()
            val bubbleWidth = bubbleView?.width?.takeIf { it > 0 } ?: dp(56)
            val bubbleHeight = bubbleView?.height?.takeIf { it > 0 } ?: dp(56)
            params.x = (downWindowX + rawX - downRawX)
                .roundToInt()
                .coerceIn(0, (screenWidth - bubbleWidth).coerceAtLeast(0))
            params.y = (downWindowY + rawY - downRawY)
                .roundToInt()
                .coerceIn(0, (screenHeight - bubbleHeight).coerceAtLeast(0))
            bubbleView?.let { windowManager.updateViewLayout(it, params) }
        }
    }

    companion object {
        private const val ACTION_START =
            "com.relayqahub.android.preview.overlay.action.START"
        private const val ACTION_HIDE_FOR_CAPTURE =
            "com.relayqahub.android.preview.overlay.action.HIDE_FOR_CAPTURE"
        private const val ACTION_RESTORE_AFTER_CAPTURE =
            "com.relayqahub.android.preview.overlay.action.RESTORE_AFTER_CAPTURE"
        private const val ACTION_STOP_SERVICE =
            "com.relayqahub.android.preview.overlay.action.STOP_SERVICE"
        private const val EXTRA_SHOW_STOP_CONTROL = "showStopControl"

        fun startIntent(context: Context): Intent =
            Intent(context, QaOverlayService::class.java).setAction(ACTION_START)

        fun hideIntent(
            context: Context,
            showStopControl: Boolean,
        ): Intent = Intent(context, QaOverlayService::class.java)
            .setAction(ACTION_HIDE_FOR_CAPTURE)
            .putExtra(EXTRA_SHOW_STOP_CONTROL, showStopControl)

        fun restoreIntent(context: Context): Intent =
            Intent(context, QaOverlayService::class.java).setAction(ACTION_RESTORE_AFTER_CAPTURE)

        fun stopIntent(context: Context): Intent =
            Intent(context, QaOverlayService::class.java).setAction(ACTION_STOP_SERVICE)
    }
}
