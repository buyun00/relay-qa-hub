package com.relayqahub.android.capture

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import com.relayqahub.android.poco.PocoEnrichmentStatus
import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean

enum class CapturedDraftMode {
    OPEN_DRAFT,
    SAVE_PENDING,
}

data class CapturePocoSummary(
    val status: PocoEnrichmentStatus,
    val port: Int?,
    val sdkVersion: Int?,
    val succeededMethods: List<String>,
    val failureCode: String?,
)

sealed interface CaptureResult {
    data class Ready(
        val captureId: String,
        val privatePath: String,
        val width: Int,
        val height: Int,
        val mode: CapturedDraftMode,
        val requestedAtEpochMs: Long,
        val poco: CapturePocoSummary,
    ) : CaptureResult

    data class Unavailable(
        val reason: String,
    ) : CaptureResult

    data class SessionState(
        val active: Boolean,
    ) : CaptureResult
}

/** Package-local result transport. Large PNG bytes always remain in app-private storage. */
object CaptureResultBridge {
    private const val ACTION_CAPTURE_RESULT =
        "com.relayqahub.android.capture.action.RESULT"
    private const val EXTRA_KIND = "kind"
    private const val EXTRA_CAPTURE_ID = "captureId"
    private const val EXTRA_PRIVATE_PATH = "privatePath"
    private const val EXTRA_WIDTH = "width"
    private const val EXTRA_HEIGHT = "height"
    private const val EXTRA_MODE = "mode"
    private const val EXTRA_REQUESTED_AT_EPOCH_MS = "requestedAtEpochMs"
    private const val EXTRA_POCO_STATUS = "pocoStatus"
    private const val EXTRA_POCO_PORT = "pocoPort"
    private const val EXTRA_POCO_SDK_VERSION = "pocoSdkVersion"
    private const val EXTRA_POCO_SUCCEEDED_METHODS = "pocoSucceededMethods"
    private const val EXTRA_POCO_FAILURE_CODE = "pocoFailureCode"
    private const val EXTRA_REASON = "reason"
    private const val EXTRA_ACTIVE = "active"

    private const val KIND_READY = "ready"
    private const val KIND_UNAVAILABLE = "unavailable"
    private const val KIND_SESSION = "session"

    fun register(
        context: Context,
        onResult: (CaptureResult) -> Unit,
    ): Closeable {
        val appContext = context.applicationContext
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                intent.toCaptureResult()?.let(onResult)
            }
        }
        appContext.registerReceiver(
            receiver,
            IntentFilter(ACTION_CAPTURE_RESULT),
            Context.RECEIVER_NOT_EXPORTED,
        )
        return ReceiverRegistration(appContext, receiver)
    }

    internal fun send(
        context: Context,
        result: CaptureResult,
    ) {
        val intent = Intent(ACTION_CAPTURE_RESULT).setPackage(context.packageName)
        when (result) {
            is CaptureResult.Ready -> intent
                .putExtra(EXTRA_KIND, KIND_READY)
                .putExtra(EXTRA_CAPTURE_ID, result.captureId)
                .putExtra(EXTRA_PRIVATE_PATH, result.privatePath)
                .putExtra(EXTRA_WIDTH, result.width)
                .putExtra(EXTRA_HEIGHT, result.height)
                .putExtra(EXTRA_MODE, result.mode.name)
                .putExtra(EXTRA_REQUESTED_AT_EPOCH_MS, result.requestedAtEpochMs)
                .putExtra(EXTRA_POCO_STATUS, result.poco.status.name)
                .putExtra(EXTRA_POCO_PORT, result.poco.port ?: -1)
                .putExtra(EXTRA_POCO_SDK_VERSION, result.poco.sdkVersion ?: -1)
                .putStringArrayListExtra(
                    EXTRA_POCO_SUCCEEDED_METHODS,
                    ArrayList(result.poco.succeededMethods),
                )
                .putExtra(EXTRA_POCO_FAILURE_CODE, result.poco.failureCode)

            is CaptureResult.Unavailable -> intent
                .putExtra(EXTRA_KIND, KIND_UNAVAILABLE)
                .putExtra(EXTRA_REASON, result.reason)

            is CaptureResult.SessionState -> intent
                .putExtra(EXTRA_KIND, KIND_SESSION)
                .putExtra(EXTRA_ACTIVE, result.active)
        }
        context.sendBroadcast(intent)
    }

    private fun Intent.toCaptureResult(): CaptureResult? {
        if (action != ACTION_CAPTURE_RESULT) return null
        return when (getStringExtra(EXTRA_KIND)) {
            KIND_READY -> {
                val captureId = getStringExtra(EXTRA_CAPTURE_ID)?.takeIf(String::isNotBlank)
                    ?: return null
                val privatePath = getStringExtra(EXTRA_PRIVATE_PATH)?.takeIf(String::isNotBlank)
                    ?: return null
                val width = getIntExtra(EXTRA_WIDTH, 0).takeIf { it > 0 } ?: return null
                val height = getIntExtra(EXTRA_HEIGHT, 0).takeIf { it > 0 } ?: return null
                val mode = getStringExtra(EXTRA_MODE)
                    ?.let { runCatching { CapturedDraftMode.valueOf(it) }.getOrNull() }
                    ?: return null
                val requestedAtEpochMs = getLongExtra(EXTRA_REQUESTED_AT_EPOCH_MS, -1L)
                    .takeIf { it > 0L }
                    ?: return null
                val pocoStatus = getStringExtra(EXTRA_POCO_STATUS)
                    ?.let { runCatching { PocoEnrichmentStatus.valueOf(it) }.getOrNull() }
                    ?: return null
                CaptureResult.Ready(
                    captureId = captureId,
                    privatePath = privatePath,
                    width = width,
                    height = height,
                    mode = mode,
                    requestedAtEpochMs = requestedAtEpochMs,
                    poco = CapturePocoSummary(
                        status = pocoStatus,
                        port = getIntExtra(EXTRA_POCO_PORT, -1).takeIf { it in 1..65_535 },
                        sdkVersion = getIntExtra(EXTRA_POCO_SDK_VERSION, -1).takeIf { it > 0 },
                        succeededMethods = getStringArrayListExtra(EXTRA_POCO_SUCCEEDED_METHODS)
                            ?.filter(String::isNotBlank)
                            .orEmpty(),
                        failureCode = getStringExtra(EXTRA_POCO_FAILURE_CODE)
                            ?.takeIf(String::isNotBlank),
                    ),
                )
            }

            KIND_UNAVAILABLE -> CaptureResult.Unavailable(
                getStringExtra(EXTRA_REASON)?.takeIf(String::isNotBlank) ?: "unknown",
            )

            KIND_SESSION -> CaptureResult.SessionState(
                active = getBooleanExtra(EXTRA_ACTIVE, false),
            )

            else -> null
        }
    }

    private class ReceiverRegistration(
        private val context: Context,
        private val receiver: BroadcastReceiver,
    ) : Closeable {
        private val closed = AtomicBoolean(false)

        override fun close() {
            if (closed.compareAndSet(false, true)) context.unregisterReceiver(receiver)
        }
    }
}
