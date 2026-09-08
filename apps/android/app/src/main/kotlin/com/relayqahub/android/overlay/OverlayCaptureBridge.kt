package com.relayqahub.android.overlay

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean

enum class OverlayCaptureCommand {
    CAPTURE_AND_OPEN_DRAFT,
    CAPTURE_AND_SAVE_PENDING,
    START_RECORDING,
    STOP_CAPTURE,
}

data class OverlayCaptureRequest(
    val command: OverlayCaptureCommand,
    val captureId: String,
    val requestedAtEpochMs: Long,
)

/**
 * Process-local integration point for the capture lane.
 *
 * The broadcast is package-scoped and listeners are registered as not
 * exported. The Application/capture owner should retain the returned handle
 * and close it when the listener is no longer valid.
 */
object OverlayCaptureBridge {
    private const val ACTION_CAPTURE_COMMAND =
        "com.relayqahub.android.preview.overlay.action.CAPTURE_COMMAND"
    private const val EXTRA_COMMAND = "command"
    private const val EXTRA_CAPTURE_ID = "captureId"
    private const val EXTRA_REQUESTED_AT_EPOCH_MS = "requestedAtEpochMs"

    fun register(
        context: Context,
        onRequest: (OverlayCaptureRequest) -> Unit,
    ): Closeable {
        val appContext = context.applicationContext
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(
                context: Context,
                intent: Intent,
            ) {
                intent.toCaptureRequest()?.let(onRequest)
            }
        }
        ContextCompat.registerReceiver(
            appContext,
            receiver,
            IntentFilter(ACTION_CAPTURE_COMMAND),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        return ReceiverRegistration(appContext, receiver)
    }

    internal fun send(
        context: Context,
        request: OverlayCaptureRequest,
    ) {
        val intent = Intent(ACTION_CAPTURE_COMMAND)
            .setPackage(context.packageName)
            .putExtra(EXTRA_COMMAND, request.command.name)
            .putExtra(EXTRA_CAPTURE_ID, request.captureId)
            .putExtra(EXTRA_REQUESTED_AT_EPOCH_MS, request.requestedAtEpochMs)
        context.sendBroadcast(intent)
    }

    private fun Intent.toCaptureRequest(): OverlayCaptureRequest? {
        if (action != ACTION_CAPTURE_COMMAND) return null
        val command = getStringExtra(EXTRA_COMMAND)
            ?.let { runCatching { OverlayCaptureCommand.valueOf(it) }.getOrNull() }
            ?: return null
        val captureId = getStringExtra(EXTRA_CAPTURE_ID)
            ?.takeIf(String::isNotBlank)
            ?: return null
        val requestedAtEpochMs = getLongExtra(EXTRA_REQUESTED_AT_EPOCH_MS, -1L)
            .takeIf { it > 0L }
            ?: return null
        return OverlayCaptureRequest(command, captureId, requestedAtEpochMs)
    }

    private class ReceiverRegistration(
        private val context: Context,
        private val receiver: BroadcastReceiver,
    ) : Closeable {
        private val closed = AtomicBoolean(false)

        override fun close() {
            if (closed.compareAndSet(false, true)) {
                context.unregisterReceiver(receiver)
            }
        }
    }
}
