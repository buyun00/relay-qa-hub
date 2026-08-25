package com.relayqahub.android.poco

import java.io.DataInputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PocoSimpleRpcClientTest {
    @Test
    fun `rejects a wrong-id endpoint then collects the five read-only methods`() {
        runBlocking {
            val wrongIdServer = loopbackServer()
            val validServer = loopbackServer()
            val executor = Executors.newFixedThreadPool(2)
            val wrongFuture = executor.submit {
                wrongIdServer.accept().use { socket ->
                    readRequest(socket)
                    writeResponse(socket, JsonPrimitive("wrong-id"), JsonPrimitive(6))
                }
            }
            val validFuture = executor.submit {
                validServer.accept().use { socket ->
                    repeat(5) {
                        val request = readRequest(socket)
                        val method = request["method"]!!.jsonPrimitive.content
                        val id = request["id"]!!
                        val result: JsonElement = when (method) {
                            "GetSDKVersion" -> JsonPrimitive(6)
                            "Screenshot" -> buildJsonArray {
                                add(JsonPrimitive("AQID"))
                                add(JsonPrimitive("jpg"))
                            }
                            "Dump" -> buildJsonObject { put("name", "root") }
                            "GetScreenSize" -> buildJsonArray {
                                add(JsonPrimitive(1440))
                                add(JsonPrimitive(2560))
                            }
                            "GetDebugProfilingData" ->
                                buildJsonObject { put("frameTimeMs", 16) }
                            else -> error("unexpected method $method")
                        }
                        writeResponse(socket, id, result)
                    }
                }
            }

            try {
                val result = PocoSimpleRpcClient(
                    PocoConnectionConfig(
                        configuredPort = wrongIdServer.localPort,
                        fallbackPorts = listOf(validServer.localPort),
                        connectTimeoutMillis = 500,
                        readTimeoutMillis = 500,
                        totalDeadlineMillis = 3_000,
                    ),
                ).use { client ->
                    client.collect(
                        PocoCollectionRequest(
                            captureId = "10000000-0000-4000-8000-000000000099",
                            capturedAtEpochMillis = 1_700_000_000_000,
                        ),
                    )
                }

                assertEquals(PocoEnrichmentStatus.COMPLETE, result.status)
                assertEquals(validServer.localPort, result.port)
                assertEquals(6, result.sdkVersion)
                assertEquals(PocoReadOnlyMethod.entries.toSet(), result.succeededMethods.toSet())
                val screenshot = result.artifacts[PocoReadOnlyMethod.SCREENSHOT]
                    as PocoArtifact.Screenshot
                assertTrue(screenshot.bytes.contentEquals(byteArrayOf(1, 2, 3)))
                assertEquals("image/jpeg", screenshot.mediaType)
                wrongFuture.get(2, TimeUnit.SECONDS)
                validFuture.get(2, TimeUnit.SECONDS)
            } finally {
                wrongIdServer.close()
                validServer.close()
                executor.shutdownNow()
            }
        }
    }

    private fun loopbackServer(): ServerSocket = ServerSocket(
        0,
        1,
        InetAddress.getByName("127.0.0.1"),
    )

    private fun readRequest(socket: Socket) = DataInputStream(socket.getInputStream()).run {
        val header = ByteArray(4).also(::readFully)
        val length =
            (header[0].toInt() and 0xff) or
                ((header[1].toInt() and 0xff) shl 8) or
                ((header[2].toInt() and 0xff) shl 16) or
                ((header[3].toInt() and 0xff) shl 24)
        require(length in 1..64 * 1024)
        val body = ByteArray(length).also(::readFully)
        Json.parseToJsonElement(String(body, StandardCharsets.UTF_8)).jsonObject
    }

    private fun writeResponse(
        socket: Socket,
        id: JsonElement,
        result: JsonElement,
    ) {
        val payload = buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            put("result", result)
        }.toString().toByteArray(StandardCharsets.UTF_8)
        socket.getOutputStream().apply {
            write(
                byteArrayOf(
                    (payload.size and 0xff).toByte(),
                    (payload.size ushr 8 and 0xff).toByte(),
                    (payload.size ushr 16 and 0xff).toByte(),
                    (payload.size ushr 24 and 0xff).toByte(),
                ),
            )
            write(payload)
            flush()
        }
    }
}
