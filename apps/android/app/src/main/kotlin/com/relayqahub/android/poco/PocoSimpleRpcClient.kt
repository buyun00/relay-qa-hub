package com.relayqahub.android.poco

import java.io.Closeable
import java.io.DataInputStream
import java.io.EOFException
import java.io.IOException
import java.io.OutputStream
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.Collections
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

enum class PocoEnrichmentStatus {
    UNAVAILABLE,
    PARTIAL,
    COMPLETE,
}

enum class PocoReadOnlyMethod(
    val wireName: String,
    internal val responseLimitBytes: Int,
) {
    GET_SDK_VERSION("GetSDKVersion", 64 * 1024),
    SCREENSHOT("Screenshot", 29_360_128),
    DUMP_VISIBLE("Dump", 1 * 1024 * 1024),
    QA_SNAPSHOT("qa.snapshot", 320 * 1024),
    GET_SCREEN_SIZE("GetScreenSize", 64 * 1024),
    GET_DEBUG_PROFILING_DATA("GetDebugProfilingData", 1 * 1024 * 1024),
}

sealed interface PocoArtifact {
    data class Screenshot(
        val bytes: ByteArray,
        val mediaType: String,
    ) : PocoArtifact

    data class Hierarchy(val json: String) : PocoArtifact

    data class Snapshot(val json: String) : PocoArtifact

    data class ScreenSize(
        val width: Int,
        val height: Int,
    ) : PocoArtifact

    data class Profiling(val json: String) : PocoArtifact
}

data class PocoMethodOutcome(
    val method: PocoReadOnlyMethod,
    val succeeded: Boolean,
    val startedAtElapsedNanos: Long,
    val completedAtElapsedNanos: Long,
    val payloadBytes: Int,
    val failureCode: String?,
)

data class PocoCollectionRequest(
    val captureId: String,
    val capturedAtEpochMillis: Long,
)

data class PocoEnrichmentResult(
    val captureId: String,
    val capturedAtEpochMillis: Long,
    val status: PocoEnrichmentStatus,
    val port: Int?,
    val sdkVersion: Int?,
    val outcomes: List<PocoMethodOutcome>,
    val artifacts: Map<PocoReadOnlyMethod, PocoArtifact>,
    val failureCode: String?,
) {
    val succeededMethods: List<PocoReadOnlyMethod>
        get() = outcomes.filter(PocoMethodOutcome::succeeded).map(PocoMethodOutcome::method)

    companion object {
        fun unavailable(
            request: PocoCollectionRequest,
            failureCode: String,
        ): PocoEnrichmentResult = PocoEnrichmentResult(
            captureId = request.captureId,
            capturedAtEpochMillis = request.capturedAtEpochMillis,
            status = PocoEnrichmentStatus.UNAVAILABLE,
            port = null,
            sdkVersion = null,
            outcomes = emptyList(),
            artifacts = emptyMap(),
            failureCode = failureCode,
        )
    }
}

data class PocoConnectionConfig(
    val configuredPort: Int = 5001,
    val fallbackPorts: List<Int> = (5001..5005).toList(),
    val connectTimeoutMillis: Int = 150,
    val readTimeoutMillis: Int = 250,
    val totalDeadlineMillis: Long = 3_000,
) {
    init {
        require(configuredPort in 1..65_535)
        require(fallbackPorts.all { it in 1..65_535 })
        require(connectTimeoutMillis in 1..5_000)
        require(readTimeoutMillis in 1..5_000)
        require(totalDeadlineMillis in 50..5_000)
    }

    val candidatePorts: List<Int>
        get() = buildList {
            add(configuredPort)
            addAll(fallbackPorts)
        }.distinct()
}

/**
 * Bounded, loopback-only adapter for the read-only RPCs proven by the vendored Poco spike.
 * There is deliberately no public raw-method or generic Invoke entry point.
 */
class PocoSimpleRpcClient(
    private val config: PocoConnectionConfig = PocoConnectionConfig(),
    private val socketFactory: () -> Socket = ::Socket,
) : Closeable {
    private val activeSockets = Collections.synchronizedSet(mutableSetOf<Socket>())
    private val json = Json {
        isLenient = false
        ignoreUnknownKeys = false
    }

    suspend fun collect(request: PocoCollectionRequest): PocoEnrichmentResult {
        if (!CAPTURE_ID_PATTERN.matches(request.captureId) || request.capturedAtEpochMillis <= 0L) {
            return PocoEnrichmentResult.unavailable(request, "INVALID_CAPTURE_REQUEST")
        }

        return try {
            withTimeout(config.totalDeadlineMillis) {
                withContext(Dispatchers.IO) {
                    collectWithinDeadline(
                        request = request,
                        deadlineNanos = System.nanoTime() + config.totalDeadlineMillis * 1_000_000L,
                    )
                }
            }
        } catch (_: TimeoutCancellationException) {
            PocoEnrichmentResult.unavailable(request, "TOTAL_DEADLINE_EXCEEDED")
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            PocoEnrichmentResult.unavailable(request, "POCO_UNAVAILABLE")
        }
    }

    override fun close() {
        val sockets = synchronized(activeSockets) { activeSockets.toList() }
        sockets.forEach { runCatching { it.close() } }
        activeSockets.clear()
    }

    private suspend fun collectWithinDeadline(
        request: PocoCollectionRequest,
        deadlineNanos: Long,
    ): PocoEnrichmentResult {
        var lastFailure = "POCO_NOT_RUNNING"
        for (port in config.candidatePorts) {
            kotlinx.coroutines.currentCoroutineContext().ensureActive()
            if (remainingMillis(deadlineNanos) <= 0) break

            val socket = socketFactory()
            activeSockets += socket
            try {
                socket.tcpNoDelay = true
                socket.connect(
                    InetSocketAddress(LOOPBACK_HOST, port),
                    boundedTimeout(config.connectTimeoutMillis, deadlineNanos),
                )
                val input = DataInputStream(socket.getInputStream())
                val output = socket.getOutputStream()
                val outcomes = mutableListOf<PocoMethodOutcome>()
                val artifacts = linkedMapOf<PocoReadOnlyMethod, PocoArtifact>()

                val handshake = call(
                    socket = socket,
                    input = input,
                    output = output,
                    method = PocoReadOnlyMethod.GET_SDK_VERSION,
                    params = EMPTY_PARAMS,
                    deadlineNanos = deadlineNanos,
                )
                val sdkVersion = handshake.result.jsonPrimitive.intOrNull
                if (sdkVersion != SUPPORTED_SDK_VERSION) {
                    throw PocoProtocolException("SDK_VERSION_MISMATCH")
                }
                outcomes += handshake.toOutcome(PocoReadOnlyMethod.GET_SDK_VERSION)

                var streamHealthy = collectOptional(
                    socket,
                    input,
                    output,
                    PocoReadOnlyMethod.SCREENSHOT,
                    EMPTY_PARAMS,
                    deadlineNanos,
                    outcomes,
                    artifacts,
                    ::parseScreenshot,
                )
                if (streamHealthy) {
                    val snapshotNonce = UUID.randomUUID().toString().replace("-", "")
                    streamHealthy = collectOptional(
                        socket,
                        input,
                        output,
                        PocoReadOnlyMethod.QA_SNAPSHOT,
                        buildSnapshotParams(request, snapshotNonce, deadlineNanos),
                        deadlineNanos,
                        outcomes,
                        artifacts,
                    ) { result -> parseSnapshot(result, request.captureId, snapshotNonce) }
                }
                if (streamHealthy) {
                    streamHealthy = collectOptional(
                        socket,
                        input,
                        output,
                        PocoReadOnlyMethod.DUMP_VISIBLE,
                        buildJsonArray { add(JsonPrimitive(true)) },
                        deadlineNanos,
                        outcomes,
                        artifacts,
                        ::parseHierarchy,
                    )
                }
                if (streamHealthy) {
                    streamHealthy = collectOptional(
                        socket,
                        input,
                        output,
                        PocoReadOnlyMethod.GET_SCREEN_SIZE,
                        EMPTY_PARAMS,
                        deadlineNanos,
                        outcomes,
                        artifacts,
                        ::parseScreenSize,
                    )
                }
                if (streamHealthy) {
                    collectOptional(
                        socket,
                        input,
                        output,
                        PocoReadOnlyMethod.GET_DEBUG_PROFILING_DATA,
                        EMPTY_PARAMS,
                        deadlineNanos,
                        outcomes,
                        artifacts,
                        ::parseProfiling,
                    )
                }

                val succeeded = outcomes.filter(PocoMethodOutcome::succeeded)
                    .map(PocoMethodOutcome::method)
                    .toSet()
                val complete = outcomes.size == PocoReadOnlyMethod.entries.size &&
                    outcomes.all(PocoMethodOutcome::succeeded) &&
                    CORE_METHODS.all(succeeded::contains)
                return PocoEnrichmentResult(
                    captureId = request.captureId,
                    capturedAtEpochMillis = request.capturedAtEpochMillis,
                    status = if (complete) PocoEnrichmentStatus.COMPLETE else PocoEnrichmentStatus.PARTIAL,
                    port = port,
                    sdkVersion = sdkVersion,
                    outcomes = outcomes.toList(),
                    artifacts = artifacts.toMap(),
                    failureCode = if (complete) {
                        null
                    } else {
                        outcomes.lastOrNull { !it.succeeded }?.failureCode ?: "POCO_PARTIAL"
                    },
                )
            } catch (failure: Throwable) {
                if (failure is CancellationException) throw failure
                lastFailure = failure.toPocoFailureCode()
            } finally {
                activeSockets -= socket
                runCatching { socket.close() }
            }
        }
        return PocoEnrichmentResult.unavailable(request, lastFailure)
    }

    private fun collectOptional(
        socket: Socket,
        input: DataInputStream,
        output: OutputStream,
        method: PocoReadOnlyMethod,
        params: JsonArray,
        deadlineNanos: Long,
        outcomes: MutableList<PocoMethodOutcome>,
        artifacts: MutableMap<PocoReadOnlyMethod, PocoArtifact>,
        parse: (JsonElement) -> PocoArtifact,
    ): Boolean {
        val started = System.nanoTime()
        try {
            val response = call(socket, input, output, method, params, deadlineNanos)
            artifacts[method] = parse(response.result)
            outcomes += response.toOutcome(method)
            return true
        } catch (failure: Throwable) {
            if (failure is CancellationException) throw failure
            outcomes += PocoMethodOutcome(
                method = method,
                succeeded = false,
                startedAtElapsedNanos = started,
                completedAtElapsedNanos = System.nanoTime(),
                payloadBytes = 0,
                failureCode = failure.toPocoFailureCode(),
            )
            return false
        }
    }

    private fun call(
        socket: Socket,
        input: DataInputStream,
        output: OutputStream,
        method: PocoReadOnlyMethod,
        params: JsonArray,
        deadlineNanos: Long,
    ): RpcSuccess {
        if (remainingMillis(deadlineNanos) <= 0) throw PocoProtocolException("DEADLINE_EXCEEDED")
        val id = UUID.randomUUID().toString()
        val request = buildJsonObject {
            put("jsonrpc", "2.0")
            put("method", method.wireName)
            put("params", params)
            put("id", id)
        }.toString().toByteArray(StandardCharsets.UTF_8)
        writeFrame(output, request)
        socket.soTimeout = boundedTimeout(config.readTimeoutMillis, deadlineNanos)
        val started = System.nanoTime()
        val responseBytes = readFrame(input, method.responseLimitBytes)
        val root = parseStrictObject(responseBytes)
        if (root["jsonrpc"]?.jsonPrimitive?.contentOrNull != "2.0") {
            throw PocoProtocolException("JSONRPC_VERSION_MISMATCH")
        }
        if (root["id"]?.jsonPrimitive?.contentOrNull != id) {
            throw PocoProtocolException("JSONRPC_ID_MISMATCH")
        }
        if (root["error"] != null && root["error"] !is JsonNull) {
            throw PocoProtocolException("RPC_ERROR")
        }
        val result = root["result"] ?: throw PocoProtocolException("RPC_RESULT_MISSING")
        return RpcSuccess(
            result = result,
            startedAtElapsedNanos = started,
            completedAtElapsedNanos = System.nanoTime(),
            payloadBytes = responseBytes.size,
        )
    }

    private fun parseStrictObject(bytes: ByteArray): JsonObject {
        val decoder = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        val text = try {
            decoder.decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: Throwable) {
            throw PocoProtocolException("INVALID_UTF8")
        }
        return try {
            json.parseToJsonElement(text).jsonObject
        } catch (_: Throwable) {
            throw PocoProtocolException("INVALID_JSON")
        }
    }

    private fun parseScreenshot(result: JsonElement): PocoArtifact.Screenshot {
        val values = try {
            result.jsonArray
        } catch (_: Throwable) {
            throw PocoProtocolException("SCREENSHOT_SHAPE_INVALID")
        }
        if (values.size != 2) throw PocoProtocolException("SCREENSHOT_SHAPE_INVALID")
        val encoded = values[0].jsonPrimitive.contentOrNull
            ?: throw PocoProtocolException("SCREENSHOT_DATA_MISSING")
        val format = values[1].jsonPrimitive.contentOrNull?.lowercase()
            ?: throw PocoProtocolException("SCREENSHOT_FORMAT_MISSING")
        val mediaType = when (format) {
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "webp" -> "image/webp"
            else -> throw PocoProtocolException("SCREENSHOT_FORMAT_UNSUPPORTED")
        }
        val bytes = try {
            Base64.getDecoder().decode(encoded)
        } catch (_: IllegalArgumentException) {
            throw PocoProtocolException("SCREENSHOT_BASE64_INVALID")
        }
        if (bytes.isEmpty() || bytes.size > MAX_DECODED_ARTIFACT_BYTES) {
            throw PocoProtocolException("SCREENSHOT_SIZE_INVALID")
        }
        return PocoArtifact.Screenshot(bytes, mediaType)
    }

    private fun parseHierarchy(result: JsonElement): PocoArtifact.Hierarchy {
        val payload = result.toString()
        if (payload.toByteArray(StandardCharsets.UTF_8).size > MAX_HIERARCHY_BYTES) {
            throw PocoProtocolException("HIERARCHY_TOO_LARGE")
        }
        return PocoArtifact.Hierarchy(payload)
    }

    private fun buildSnapshotParams(
        request: PocoCollectionRequest,
        nonce: String,
        deadlineNanos: Long,
    ): JsonArray = buildJsonArray {
        add(
            buildJsonObject {
                put("schemaVersion", SNAPSHOT_SCHEMA_VERSION)
                put("captureId", request.captureId)
                put("nonce", nonce)
                put(
                    "deadlineUnixMs",
                    System.currentTimeMillis() +
                        remainingMillis(deadlineNanos).coerceIn(1L, SNAPSHOT_DEADLINE_MILLIS),
                )
            },
        )
    }

    private fun parseSnapshot(
        result: JsonElement,
        expectedCaptureId: String,
        expectedNonce: String,
    ): PocoArtifact.Snapshot {
        val snapshot = try {
            when (result) {
                is JsonObject -> result
                is JsonPrimitive -> json.parseToJsonElement(
                    result.contentOrNull ?: throw PocoProtocolException("SNAPSHOT_SHAPE_INVALID"),
                ).jsonObject
                else -> throw PocoProtocolException("SNAPSHOT_SHAPE_INVALID")
            }
        } catch (failure: PocoProtocolException) {
            throw failure
        } catch (_: Throwable) {
            throw PocoProtocolException("SNAPSHOT_SHAPE_INVALID")
        }
        if (snapshot["captureId"]?.jsonPrimitive?.contentOrNull != expectedCaptureId) {
            throw PocoProtocolException("SNAPSHOT_CAPTURE_ID_MISMATCH")
        }
        val schemaVersion = snapshot["schemaVersion"]?.jsonPrimitive?.contentOrNull
        if (schemaVersion != SNAPSHOT_SCHEMA_VERSION.toString() && schemaVersion != "1.0.0") {
            throw PocoProtocolException("SNAPSHOT_SCHEMA_VERSION_MISMATCH")
        }
        snapshot["nonce"]?.jsonPrimitive?.contentOrNull?.let { responseNonce ->
            if (responseNonce != expectedNonce) {
                throw PocoProtocolException("SNAPSHOT_NONCE_MISMATCH")
            }
        }
        val payload = snapshot.toString()
        val payloadBytes = payload.toByteArray(StandardCharsets.UTF_8).size
        if (payloadBytes !in 2..MAX_SNAPSHOT_BYTES) {
            throw PocoProtocolException("SNAPSHOT_TOO_LARGE")
        }
        return PocoArtifact.Snapshot(payload)
    }

    private fun parseScreenSize(result: JsonElement): PocoArtifact.ScreenSize {
        val values = try {
            result.jsonArray
        } catch (_: Throwable) {
            throw PocoProtocolException("SCREEN_SIZE_SHAPE_INVALID")
        }
        if (values.size != 2) throw PocoProtocolException("SCREEN_SIZE_SHAPE_INVALID")
        val width = values[0].jsonPrimitive.intOrNull ?: 0
        val height = values[1].jsonPrimitive.intOrNull ?: 0
        if (width !in 1..32_768 || height !in 1..32_768) {
            throw PocoProtocolException("SCREEN_SIZE_RANGE_INVALID")
        }
        return PocoArtifact.ScreenSize(width, height)
    }

    private fun parseProfiling(result: JsonElement): PocoArtifact.Profiling {
        try {
            result.jsonObject
        } catch (_: Throwable) {
            throw PocoProtocolException("PROFILING_SHAPE_INVALID")
        }
        val payload = result.toString()
        if (payload.toByteArray(StandardCharsets.UTF_8).size > MAX_PROFILING_BYTES) {
            throw PocoProtocolException("PROFILING_TOO_LARGE")
        }
        return PocoArtifact.Profiling(payload)
    }

    private fun boundedTimeout(configuredMillis: Int, deadlineNanos: Long): Int =
        minOf(configuredMillis.toLong(), remainingMillis(deadlineNanos)).coerceAtLeast(1L).toInt()

    private fun remainingMillis(deadlineNanos: Long): Long =
        ((deadlineNanos - System.nanoTime()) / 1_000_000L).coerceAtLeast(0L)

    private fun writeFrame(output: OutputStream, payload: ByteArray) {
        if (payload.isEmpty() || payload.size > MAX_REQUEST_BYTES) {
            throw PocoProtocolException("REQUEST_SIZE_INVALID")
        }
        output.write(
            byteArrayOf(
                (payload.size and 0xff).toByte(),
                (payload.size ushr 8 and 0xff).toByte(),
                (payload.size ushr 16 and 0xff).toByte(),
                (payload.size ushr 24 and 0xff).toByte(),
            ),
        )
        output.write(payload)
        output.flush()
    }

    private fun readFrame(input: DataInputStream, maxPayloadBytes: Int): ByteArray {
        val header = ByteArray(4)
        try {
            input.readFully(header)
        } catch (_: EOFException) {
            throw PocoProtocolException("TRUNCATED_HEADER")
        }
        val length =
            (header[0].toInt() and 0xff) or
                ((header[1].toInt() and 0xff) shl 8) or
                ((header[2].toInt() and 0xff) shl 16) or
                ((header[3].toInt() and 0xff) shl 24)
        if (length <= 0 || length > maxPayloadBytes) {
            throw PocoProtocolException("FRAME_LENGTH_INVALID")
        }
        val payload = ByteArray(length)
        try {
            input.readFully(payload)
        } catch (_: EOFException) {
            throw PocoProtocolException("TRUNCATED_PAYLOAD")
        }
        return payload
    }

    private data class RpcSuccess(
        val result: JsonElement,
        val startedAtElapsedNanos: Long,
        val completedAtElapsedNanos: Long,
        val payloadBytes: Int,
    ) {
        fun toOutcome(method: PocoReadOnlyMethod): PocoMethodOutcome = PocoMethodOutcome(
            method = method,
            succeeded = true,
            startedAtElapsedNanos = startedAtElapsedNanos,
            completedAtElapsedNanos = completedAtElapsedNanos,
            payloadBytes = payloadBytes,
            failureCode = null,
        )
    }

    private class PocoProtocolException(val code: String) : IOException(code)

    private fun Throwable.toPocoFailureCode(): String = when (this) {
        is PocoProtocolException -> code
        is SocketTimeoutException -> "TIMEOUT"
        is ConnectException -> "CONNECTION_REFUSED"
        is EOFException -> "TRUNCATED_FRAME"
        is IOException -> "IO_FAILURE"
        else -> "POCO_UNAVAILABLE"
    }

    companion object {
        private const val LOOPBACK_HOST = "127.0.0.1"
        private const val SUPPORTED_SDK_VERSION = 6
        private const val MAX_REQUEST_BYTES = 64 * 1024
        private const val MAX_DECODED_ARTIFACT_BYTES = 20 * 1024 * 1024
        private const val MAX_HIERARCHY_BYTES = 1 * 1024 * 1024
        private const val MAX_PROFILING_BYTES = 1 * 1024 * 1024
        private const val MAX_SNAPSHOT_BYTES = 256 * 1024
        private const val SNAPSHOT_SCHEMA_VERSION = 1
        private const val SNAPSHOT_DEADLINE_MILLIS = 2_000L
        private val EMPTY_PARAMS = JsonArray(emptyList())
        private val CORE_METHODS = setOf(
            PocoReadOnlyMethod.GET_SDK_VERSION,
            PocoReadOnlyMethod.SCREENSHOT,
            PocoReadOnlyMethod.DUMP_VISIBLE,
        )
        private val CAPTURE_ID_PATTERN = Regex(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-" +
                "[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        )
    }
}
