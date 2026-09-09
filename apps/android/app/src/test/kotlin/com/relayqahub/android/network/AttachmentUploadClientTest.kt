package com.relayqahub.android.network

import com.relayqahub.android.data.AccountProjectScope
import java.io.IOException
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AttachmentUploadClientTest {
    @Test
    fun `verification evidence retries keep submission identity and bind to the exact bug`() = runBlocking {
        val scope = AccountProjectScope(
            accountId = "10000000-0000-4000-8000-000000000001",
            projectId = "20000000-0000-4000-8000-000000000001",
            actorId = "30000000-0000-4000-8000-000000000001",
            installationId = "40000000-0000-4000-8000-000000000001",
            sessionId = "50000000-0000-4000-8000-000000000001",
        )
        val bugId = "60000000-0000-4000-8000-000000000001"
        val clientSubmissionId = "70000000-0000-4000-8000-000000000001"
        val clientAttachmentId = "80000000-0000-4000-8000-000000000001"
        val captureBundleId = "90000000-0000-4000-8000-000000000001"
        val sessionId = "a0000000-0000-4000-8000-000000000001"
        val attachmentId = "b0000000-0000-4000-8000-000000000001"
        val bindingId = "c0000000-0000-4000-8000-000000000001"
        val bytes = byteArrayOf(1, 2, 3, 4)
        val sha256 = MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
        val requests = mutableListOf<Pair<String, String>>()
        var callIndex = 0
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            val stage = callIndex++ % 4
            assertEquals("Bearer token", request.header("Authorization"))
            assertEquals(scope.actorId, request.header("x-qa-actor-id"))
            assertEquals(QaHubApiContract.JSON_ACCEPT, request.header("Accept"))
            requests += request.url.encodedPath to request.header("Idempotency-Key").orEmpty()
            when (stage) {
                0 -> {
                    assertEquals("/api/v1/uploads/init", request.url.encodedPath)
                    assertEquals(
                        "submission:$clientSubmissionId:attachment:$clientAttachmentId:upload:1:init",
                        request.header("Idempotency-Key"),
                    )
                    assertEquals(QaHubApiContract.VERSIONED_JSON, request.body?.contentType()?.let {
                        "${it.type}/${it.subtype}"
                    })
                    val body = request.jsonBody()
                    assertEquals(scope.projectId, body.getString("projectId"))
                    assertEquals(clientSubmissionId, body.getString("clientSubmissionId"))
                    assertEquals(clientAttachmentId, body.getString("clientAttachmentId"))
                    assertEquals(captureBundleId, body.getString("captureId"))
                    jsonResponse(request, 201, JSONObject()
                        .put("sessionId", sessionId).put("projectId", scope.projectId)
                        .put("clientSubmissionId", clientSubmissionId)
                        .put("clientAttachmentId", clientAttachmentId).put("uploadAttempt", 1)
                         .put("status", "open").put("filename", "proof.png")
                         .put("mediaType", "image/png").put("expectedSize", bytes.size)
                         .put("sha256", sha256).put("captureId", captureBundleId)
                         .put("chunkSize", 1_048_576).put("expectedChunkCount", 1)
                         .put("receivedBytes", 0).put("confirmedChunks", org.json.JSONArray())
                         .put("expiresAt", "2090-01-01T00:00:00Z")
                         .put("version", 1).put("attachmentId", JSONObject.NULL)
                         .put("replayed", callIndex > 4))
                }
                1 -> {
                    assertEquals("/api/v1/uploads/$sessionId/chunks/0", request.url.encodedPath)
                    assertEquals(
                        "submission:$clientSubmissionId:attachment:$clientAttachmentId:upload:1:chunk:0",
                        request.header("Idempotency-Key"),
                    )
                    assertEquals(clientSubmissionId, request.header("X-Client-Submission-Id"))
                    assertEquals(clientAttachmentId, request.header("X-Client-Attachment-Id"))
                    assertEquals(bytes.toList(), request.bodyBytes().toList())
                    Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
                        .code(204).message("Fixture").header("ETag", "\"2\"")
                        .header("X-Upload-Version", "2").body(ByteArray(0).toResponseBody()).build()
                }
                2 -> {
                    assertEquals("/api/v1/uploads/$sessionId/finalize", request.url.encodedPath)
                    assertEquals(
                        "submission:$clientSubmissionId:attachment:$clientAttachmentId:upload:1:finalize",
                        request.header("Idempotency-Key"),
                    )
                    val body = request.jsonBody()
                    assertEquals(clientSubmissionId, body.getString("clientSubmissionId"))
                    assertEquals(clientAttachmentId, body.getString("clientAttachmentId"))
                    assertEquals(2, body.getInt("expectedVersion"))
                    jsonResponse(request, 200, JSONObject()
                         .put("attachmentId", attachmentId).put("sessionId", sessionId)
                         .put("projectId", scope.projectId).put("clientSubmissionId", clientSubmissionId)
                         .put("clientAttachmentId", clientAttachmentId).put("uploadAttempt", 1)
                         .put("filename", "proof.png").put("mediaType", "image/png").put("sha256", sha256)
                         .put("captureId", captureBundleId).put("size", bytes.size)
                         .put("scanStatus", "clean").put("readyToBind", true)
                         .put("bindingStatus", "unbound").put("version", 3)
                         .put("replayed", callIndex > 4))
                }
                else -> {
                    assertEquals("/api/v1/attachments/$attachmentId/bind", request.url.encodedPath)
                    assertEquals(
                        "submission:$clientSubmissionId:attachment:$clientAttachmentId:bind:1",
                        request.header("Idempotency-Key"),
                    )
                    val body = request.jsonBody()
                    assertEquals("verification_result", body.getString("intent"))
                    assertEquals(bugId, body.getString("targetQaItemId"))
                    assertEquals(clientSubmissionId, body.getString("clientSubmissionId"))
                    jsonResponse(request, 200, JSONObject()
                        .put("bindingId", bindingId).put("attachmentId", attachmentId)
                        .put("projectId", scope.projectId).put("clientSubmissionId", clientSubmissionId)
                        .put("clientAttachmentId", clientAttachmentId).put("leaseGeneration", 1)
                         .put("intent", "verification_result").put("status", "reserved")
                         .put("version", 4).put("targetQaItemId", bugId)
                         .put("expiresAt", "2090-01-01T00:15:00Z")
                         .put("replayed", callIndex > 4))
                }
            }
        }.build()
        val client = AttachmentUploadClient("https://fixture.invalid/api/v1/", http)

        val receipts = List(2) {
            client.uploadAndReserveVerificationResult(
                scope, bugId, clientSubmissionId, clientAttachmentId, "proof.png", bytes,
                "token", captureBundleId, "image/png",
            )
        }

        assertTrue(receipts.all { it.clientSubmissionId == clientSubmissionId })
        assertTrue(receipts.all { it.clientAttachmentId == clientAttachmentId })
        assertTrue(receipts.all { it.attachmentId == attachmentId && it.bindingId == bindingId })
        assertEquals(requests.take(4), requests.drop(4))
    }

    @Test
    fun `twenty MiB evidence follows server chunk geometry and evolving versions`() = runBlocking {
        val bytes = ByteArray(20 * 1024 * 1024) { index -> (index % 251).toByte() }
        val fixture = ResumableFixture(bytes, 8 * 1024 * 1024)
        var checkpoint = AttachmentUploadCheckpoint()
        val saved = mutableListOf<AttachmentUploadCheckpoint>()

        val receipt = fixture.client().uploadAndReserveVerificationResult(
            fixture.scope,
            fixture.bugId,
            fixture.clientSubmissionId,
            fixture.clientAttachmentId,
            "boundary.png",
            bytes,
            "token",
            mediaType = "image/png",
            checkpoint = checkpoint,
            onCheckpoint = { next -> checkpoint = next; saved += next },
        )

        assertEquals(listOf(8 * 1024 * 1024, 8 * 1024 * 1024, 4 * 1024 * 1024), fixture.chunkSizes)
        assertEquals(listOf(1, 2, 3), fixture.chunkIfMatchVersions)
        assertEquals(listOf(0, 1, 2), checkpoint.confirmedChunks)
        assertEquals(5, checkpoint.finalizedVersion)
        assertEquals(6, checkpoint.bindingVersion)
        assertEquals(1, receipt.leaseGeneration)
        assertTrue(saved.any { it.confirmedChunks == listOf(0) })
        assertTrue(saved.any { it.confirmedChunks == listOf(0, 1, 2) })

        val callsBeforeOversize = fixture.paths.size
        val failure = runCatching {
            fixture.client().uploadAndReserveVerificationResult(
                fixture.scope,
                fixture.bugId,
                fixture.clientSubmissionId,
                "80000000-0000-4000-8000-000000000099",
                "too-large.png",
                ByteArray(20 * 1024 * 1024 + 1),
                "token",
            )
        }.exceptionOrNull()
        assertTrue(failure is IllegalArgumentException)
        assertEquals(callsBeforeOversize, fixture.paths.size)
    }

    @Test
    fun `lost init chunk finalize and bind responses resume after process recreation`() = runBlocking {
        val bytes = ByteArray(600_000) { (it % 251).toByte() }
        val fixture = ResumableFixture(
            bytes,
            chunkSize = 262_144,
            loseFirstResponseFor = setOf("init", "chunk:0", "finalize", "bind:1"),
        )
        var checkpoint = AttachmentUploadCheckpoint()
        var receipt: AttachmentUploadReceipt? = null
        var invocations = 0
        for (attempt in 1..8) {
            invocations = attempt
            try {
                receipt = fixture.client().uploadAndReserveVerificationResult(
                    fixture.scope,
                    fixture.bugId,
                    fixture.clientSubmissionId,
                    fixture.clientAttachmentId,
                    "resumable.png",
                    bytes,
                    "token",
                    checkpoint = checkpoint,
                    onCheckpoint = { checkpoint = it },
                )
                break
            } catch (_: IOException) {
                // A new client instance on the next iteration simulates process recreation.
            }
        }

        assertNotNull(receipt)
        assertEquals(5, invocations)
        assertEquals(listOf(0, 1, 2), checkpoint.confirmedChunks)
        assertTrue(checkpoint.finalizeConfirmed)
        assertNotNull(checkpoint.bindingId)
        assertEquals(1, fixture.paths.count { it.endsWith("/chunks/0") })
        assertEquals(2, fixture.paths.count { it.endsWith("/finalize") })
        assertEquals(2, fixture.paths.count { it.endsWith("/bind") })
        assertEquals(1, fixture.acceptedAttachmentCount)
        assertEquals(1, fixture.acceptedBindingCount)
    }

    @Test
    fun `expired verification reservation renews the same binding with the next generation`() = runBlocking {
        val scope = AccountProjectScope(
            "10000000-0000-4000-8000-000000000001",
            "20000000-0000-4000-8000-000000000001",
            "30000000-0000-4000-8000-000000000001",
            "40000000-0000-4000-8000-000000000001",
            "50000000-0000-4000-8000-000000000001",
        )
        val bugId = "60000000-0000-4000-8000-000000000001"
        val submissionId = "70000000-0000-4000-8000-000000000001"
        val clientAttachmentId = "80000000-0000-4000-8000-000000000001"
        val attachmentId = "90000000-0000-4000-8000-000000000001"
        val bindingId = "a0000000-0000-4000-8000-000000000001"
        val generations = mutableListOf<Int>()
        val expectedVersions = mutableListOf<Int>()
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            val body = request.jsonBody()
            val generation = body.getInt("leaseGeneration")
            generations += generation
            expectedVersions += body.getInt("expectedVersion")
            jsonResponse(
                request,
                200,
                JSONObject().put("bindingId", bindingId).put("attachmentId", attachmentId)
                    .put("projectId", scope.projectId).put("clientSubmissionId", submissionId)
                    .put("clientAttachmentId", clientAttachmentId).put("leaseGeneration", generation)
                    .put("intent", "verification_result").put("targetQaItemId", bugId)
                    .put("status", "reserved").put("version", 3 + generation)
                    .put(
                        "expiresAt",
                        if (generation == 1) "2026-09-09T00:00:00Z" else "2026-09-09T00:31:00Z",
                    )
                    .put("replayed", generation == 1),
                date = "Wed, 09 Sep 2026 00:16:00 GMT",
            )
        }.build()
        var checkpoint = AttachmentUploadCheckpoint(
            sessionId = "b0000000-0000-4000-8000-000000000001",
            chunkSize = 262_144,
            expectedChunkCount = 1,
            confirmedChunks = listOf(0),
            uploadVersion = 3,
            uploadExpiresAt = "2026-09-09T01:00:00Z",
            attachmentId = attachmentId,
            finalizedVersion = 3,
            finalizeConfirmed = true,
            bindingId = bindingId,
            leaseGeneration = 1,
            bindingVersion = 4,
            bindingExpiresAt = "2026-09-09T00:00:00Z",
        )

        val receipt = AttachmentUploadClient("https://fixture.invalid/api/v1/", http)
            .renewVerificationResultReservation(
                scope,
                bugId,
                submissionId,
                clientAttachmentId,
                "token",
                checkpoint,
            ) { checkpoint = it }

        assertEquals(listOf(1, 2), generations)
        assertEquals(listOf(3, 4), expectedVersions)
        assertEquals(bindingId, receipt.bindingId)
        assertEquals(2, receipt.leaseGeneration)
        assertEquals(2, checkpoint.leaseGeneration)
        assertEquals(5, checkpoint.bindingVersion)
    }

    @Test
    fun `lost next-generation response resumes by replaying that generation after process recreation`() =
        runBlocking {
            val scope = AccountProjectScope(
                "10000000-0000-4000-8000-000000000001",
                "20000000-0000-4000-8000-000000000001",
                "30000000-0000-4000-8000-000000000001",
                "40000000-0000-4000-8000-000000000001",
                "50000000-0000-4000-8000-000000000001",
            )
            val bugId = "60000000-0000-4000-8000-000000000001"
            val submissionId = "70000000-0000-4000-8000-000000000001"
            val clientAttachmentId = "80000000-0000-4000-8000-000000000001"
            val attachmentId = "90000000-0000-4000-8000-000000000001"
            val bindingId = "a0000000-0000-4000-8000-000000000001"
            val generations = mutableListOf<Int>()
            val expectedVersions = mutableListOf<Int>()
            var serverGeneration = 1
            var acceptedRenewals = 0
            var loseGenerationTwoResponse = true

            fun client(): AttachmentUploadClient {
                val http = OkHttpClient.Builder().addInterceptor { chain ->
                    val request = chain.request()
                    val body = request.jsonBody()
                    val generation = body.getInt("leaseGeneration")
                    val expectedVersion = body.getInt("expectedVersion")
                    generations += generation
                    expectedVersions += expectedVersion

                    if (generation < serverGeneration) {
                        return@addInterceptor jsonResponse(
                            request,
                            500,
                            JSONObject().put("code", "SQLITE_UPLOAD_VERSION_CONFLICT"),
                        )
                    }
                    assertTrue(generation == serverGeneration || generation == serverGeneration + 1)
                    if (generation == serverGeneration + 1) {
                        assertEquals(4, expectedVersion)
                        serverGeneration = generation
                        acceptedRenewals += 1
                    }
                    val response = jsonResponse(
                        request,
                        200,
                        JSONObject().put("bindingId", bindingId).put("attachmentId", attachmentId)
                            .put("projectId", scope.projectId).put("clientSubmissionId", submissionId)
                            .put("clientAttachmentId", clientAttachmentId)
                            .put("leaseGeneration", serverGeneration)
                            .put("intent", "verification_result").put("targetQaItemId", bugId)
                            .put("status", "reserved")
                            .put("version", 3 + serverGeneration)
                            .put(
                                "expiresAt",
                                if (serverGeneration == 1) {
                                    "2026-09-09T00:00:00Z"
                                } else {
                                    "2090-01-01T00:31:00Z"
                                },
                            )
                            .put("replayed", generation == serverGeneration),
                    )
                    if (generation == 2 && acceptedRenewals == 1 && loseGenerationTwoResponse) {
                        loseGenerationTwoResponse = false
                        response.close()
                        throw IOException("lost generation-2 response")
                    }
                    response
                }.build()
                return AttachmentUploadClient("https://fixture.invalid/api/v1/", http)
            }

            var checkpoint = AttachmentUploadCheckpoint(
                sessionId = "b0000000-0000-4000-8000-000000000001",
                chunkSize = 262_144,
                expectedChunkCount = 1,
                confirmedChunks = listOf(0),
                uploadVersion = 3,
                uploadExpiresAt = "2026-09-09T01:00:00Z",
                attachmentId = attachmentId,
                finalizedVersion = 3,
                finalizeConfirmed = true,
                bindingId = bindingId,
                leaseGeneration = 1,
                bindingVersion = 4,
                bindingExpiresAt = "2026-09-09T00:00:00Z",
            )

            val firstFailure = runCatching {
                client().renewVerificationResultReservation(
                    scope,
                    bugId,
                    submissionId,
                    clientAttachmentId,
                    "token",
                    checkpoint,
                ) { checkpoint = it }
            }.exceptionOrNull()
            assertTrue(firstFailure is IOException)
            assertEquals(1, checkpoint.leaseGeneration)
            assertEquals(2, serverGeneration)

            val receipt = client().renewVerificationResultReservation(
                scope,
                bugId,
                submissionId,
                clientAttachmentId,
                "token",
                checkpoint,
            ) { checkpoint = it }

            assertEquals(listOf(1, 2, 1, 2), generations)
            assertEquals(listOf(3, 4, 3, 4), expectedVersions)
            assertEquals(1, acceptedRenewals)
            assertEquals(bindingId, receipt.bindingId)
            assertEquals(2, receipt.leaseGeneration)
            assertEquals(5, receipt.bindingVersion)
            assertEquals(2, checkpoint.leaseGeneration)
            assertEquals(5, checkpoint.bindingVersion)
        }

    @Test
    fun `binding receipt rejects coerced primitives shortened UUIDs and extra fields`() = runBlocking {
        val scope = AccountProjectScope(
            "10000000-0000-4000-8000-000000000001",
            "20000000-0000-4000-8000-000000000001",
            "30000000-0000-4000-8000-000000000001",
            "40000000-0000-4000-8000-000000000001",
            "50000000-0000-4000-8000-000000000001",
        )
        val bugId = "60000000-0000-4000-8000-000000000001"
        val submissionId = "70000000-0000-4000-8000-000000000001"
        val clientAttachmentId = "80000000-0000-4000-8000-000000000001"
        val attachmentId = "90000000-0000-4000-8000-000000000001"
        val bindingId = "a0000000-0000-4000-8000-000000000001"
        val checkpoint = AttachmentUploadCheckpoint(
            sessionId = "b0000000-0000-4000-8000-000000000001",
            chunkSize = 262_144,
            expectedChunkCount = 1,
            confirmedChunks = listOf(0),
            uploadVersion = 3,
            uploadExpiresAt = "2090-01-01T01:00:00Z",
            attachmentId = attachmentId,
            finalizedVersion = 3,
            finalizeConfirmed = true,
            bindingId = bindingId,
            leaseGeneration = 1,
            bindingVersion = 4,
            bindingExpiresAt = "2090-01-01T00:15:00Z",
        )
        listOf("integer", "boolean", "uuid", "extra").forEach { malformedField ->
            val http = OkHttpClient.Builder().addInterceptor { chain ->
                val request = chain.request()
                val response = JSONObject().put("bindingId", bindingId).put("attachmentId", attachmentId)
                    .put("projectId", scope.projectId).put("clientSubmissionId", submissionId)
                    .put("clientAttachmentId", clientAttachmentId).put("leaseGeneration", 1)
                    .put("intent", "verification_result").put("targetQaItemId", bugId)
                    .put("status", "reserved").put("version", 4)
                    .put("expiresAt", "2090-01-01T00:15:00Z").put("replayed", true)
                if (malformedField == "integer") response.put("leaseGeneration", "1")
                if (malformedField == "boolean") response.put("replayed", "true")
                if (malformedField == "uuid") response.put("bindingId", "1-1-1-1-1")
                if (malformedField == "extra") response.put("unexpected", true)
                jsonResponse(request, 200, response, date = "Wed, 09 Sep 2026 00:00:00 GMT")
            }.build()

            val failure = runCatching {
                AttachmentUploadClient("https://fixture.invalid/api/v1/", http)
                    .renewVerificationResultReservation(
                        scope,
                        bugId,
                        submissionId,
                        clientAttachmentId,
                        "token",
                        checkpoint,
                    ) {}
            }.exceptionOrNull()

            assertTrue(failure is AttachmentUploadFailure)
            assertEquals(
                when (malformedField) {
                    "integer" -> "LEASEGENERATION_MISMATCH"
                    "boolean" -> "REPLAYED_INVALID"
                    "uuid" -> "INVALID_BINDINGID_UUID"
                    else -> "BINDING_RESPONSE_SHAPE_INVALID"
                },
                (failure as AttachmentUploadFailure).code,
            )
        }
    }

    @Test
    fun `init finalize and bind reject fields outside the frozen response schema`() = runBlocking {
        listOf(
            "init" to "INIT_RESPONSE_SHAPE_INVALID",
            "finalize" to "FINALIZE_RESPONSE_SHAPE_INVALID",
            "bind" to "BINDING_RESPONSE_SHAPE_INVALID",
        ).forEach { (stage, expectedCode) ->
            val fixture = ResumableFixture(
                bytes = byteArrayOf(1, 2, 3),
                chunkSize = 262_144,
                mutateJson = { currentStage, value ->
                    if (currentStage == stage) value.put("unexpected", true) else value
                },
            )
            val failure = runCatching {
                fixture.client().uploadAndReserveVerificationResult(
                    fixture.scope,
                    fixture.bugId,
                    fixture.clientSubmissionId,
                    fixture.clientAttachmentId,
                    "strict.png",
                    byteArrayOf(1, 2, 3),
                    "token",
                )
            }.exceptionOrNull()

            assertEquals(expectedCode, (failure as AttachmentUploadFailure).code)
        }
    }

    private inner class ResumableFixture(
        private val bytes: ByteArray,
        private val chunkSize: Int,
        private val loseFirstResponseFor: Set<String> = emptySet(),
        private val mutateJson: (String, JSONObject) -> JSONObject = { _, value -> value },
    ) {
        val scope = AccountProjectScope(
            "10000000-0000-4000-8000-000000000001",
            "20000000-0000-4000-8000-000000000001",
            "30000000-0000-4000-8000-000000000001",
            "40000000-0000-4000-8000-000000000001",
            "50000000-0000-4000-8000-000000000001",
        )
        val bugId = "60000000-0000-4000-8000-000000000001"
        val clientSubmissionId = "70000000-0000-4000-8000-000000000001"
        val clientAttachmentId = "80000000-0000-4000-8000-000000000001"
        private val sessionId = "90000000-0000-4000-8000-000000000001"
        private val attachmentId = "a0000000-0000-4000-8000-000000000001"
        private val bindingId = "b0000000-0000-4000-8000-000000000001"
        val paths = mutableListOf<String>()
        val chunkSizes = mutableListOf<Int>()
        val chunkIfMatchVersions = mutableListOf<Int>()
        private val confirmed = sortedSetOf<Int>()
        private val lost = mutableSetOf<String>()
        private var uploadVersion = 1
        private var finalized = false
        private var bound = false
        var acceptedAttachmentCount = 0
            private set
        var acceptedBindingCount = 0
            private set

        fun client(): AttachmentUploadClient {
            val http = OkHttpClient.Builder().addInterceptor { chain -> respond(chain.request()) }.build()
            return AttachmentUploadClient("https://fixture.invalid/api/v1/", http)
        }

        private fun respond(request: okhttp3.Request): Response {
            val path = request.url.encodedPath
            paths += path
            return when {
                path.endsWith("/uploads/init") -> {
                    currentFilename = request.jsonBody().getString("filename")
                    val status = when {
                        finalized -> "finalized"
                        confirmed.size == expectedChunkCount -> "finalizing"
                        else -> "open"
                    }
                    val response = jsonResponse(
                        request,
                        201,
                        mutateJson("init", JSONObject().put("sessionId", sessionId).put("projectId", scope.projectId)
                            .put("clientSubmissionId", clientSubmissionId)
                            .put("clientAttachmentId", clientAttachmentId).put("uploadAttempt", 1)
                            .put("status", status).put("filename", currentFilename)
                            .put("mediaType", "image/png").put("captureId", JSONObject.NULL)
                            .put("expectedSize", bytes.size).put("chunkSize", chunkSize)
                            .put("sha256", bytes.sha256()).put("expectedChunkCount", expectedChunkCount)
                            .put("receivedBytes", confirmed.sumOf(::chunkLength))
                            .put("confirmedChunks", org.json.JSONArray(confirmed.toList()))
                            .put("attachmentId", if (finalized) attachmentId else JSONObject.NULL)
                            .put("expiresAt", "2090-01-01T00:00:00Z")
                            .put("version", uploadVersion).put("replayed", paths.size > 1)),
                    )
                    lose("init", response)
                }
                path.contains("/chunks/") -> {
                    val chunkNumber = path.substringAfterLast('/').toInt()
                    val body = request.bodyBytes()
                    assertEquals(bytes.copyOfRange(
                        chunkNumber * chunkSize,
                        minOf(bytes.size, (chunkNumber + 1) * chunkSize),
                    ).toList(), body.toList())
                    assertEquals(body.sha256(), request.header("X-Chunk-SHA256"))
                    if (chunkNumber !in confirmed) {
                        chunkSizes += body.size
                        chunkIfMatchVersions += request.header("If-Match")!!.trim('"').toInt()
                        assertEquals(uploadVersion, chunkIfMatchVersions.last())
                        confirmed += chunkNumber
                        uploadVersion++
                    }
                    val response = Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
                        .code(204).message("Fixture").header("ETag", "\"$uploadVersion\"")
                        .header("X-Upload-Version", uploadVersion.toString())
                        .body(ByteArray(0).toResponseBody()).build()
                    lose("chunk:$chunkNumber", response)
                }
                path.endsWith("/finalize") -> {
                    assertEquals(expectedChunkCount, confirmed.size)
                    assertEquals(1 + expectedChunkCount, request.jsonBody().getInt("expectedVersion"))
                    if (!finalized) {
                        finalized = true
                        acceptedAttachmentCount++
                        uploadVersion++
                    }
                    lose("finalize", jsonResponse(
                        request,
                        200,
                        mutateJson("finalize", JSONObject().put("sessionId", sessionId).put("projectId", scope.projectId)
                            .put("clientSubmissionId", clientSubmissionId)
                            .put("clientAttachmentId", clientAttachmentId).put("uploadAttempt", 1)
                            .put("attachmentId", attachmentId).put("filename", currentFilename)
                            .put("mediaType", "image/png").put("captureId", JSONObject.NULL)
                            .put("sha256", bytes.sha256()).put("size", bytes.size)
                            .put("scanStatus", "clean").put("readyToBind", true)
                            .put("bindingStatus", "unbound").put("version", uploadVersion)
                            .put("replayed", acceptedAttachmentCount > 0)),
                    ))
                }
                path.endsWith("/bind") -> {
                    val body = request.jsonBody()
                    assertEquals("verification_result", body.getString("intent"))
                    assertEquals(bugId, body.getString("targetQaItemId"))
                    if (!bound) {
                        bound = true
                        acceptedBindingCount++
                    }
                    lose(
                        "bind:1",
                        jsonResponse(
                            request,
                            200,
                            mutateJson("bind", JSONObject().put("bindingId", bindingId).put("attachmentId", attachmentId)
                                .put("projectId", scope.projectId).put("clientSubmissionId", clientSubmissionId)
                                .put("clientAttachmentId", clientAttachmentId).put("leaseGeneration", 1)
                                .put("intent", "verification_result").put("targetQaItemId", bugId)
                                .put("status", "reserved").put("expiresAt", "2090-01-01T00:15:00Z")
                                .put("version", uploadVersion + 1).put("replayed", acceptedBindingCount > 0)),
                        ),
                    )
                }
                else -> error("Unexpected request $path")
            }
        }

        private var currentFilename = ""
        private val expectedChunkCount: Int get() = (bytes.size + chunkSize - 1) / chunkSize
        private fun chunkLength(index: Int): Int = minOf(chunkSize, bytes.size - index * chunkSize)

        private fun lose(stage: String, response: Response): Response {
            if (stage in loseFirstResponseFor && lost.add(stage)) {
                response.close()
                throw IOException("lost $stage response")
            }
            return response
        }
    }

    private fun okhttp3.Request.jsonBody(): JSONObject = JSONObject(
        String(bodyBytes(), Charsets.UTF_8),
    )

    private fun okhttp3.Request.bodyBytes(): ByteArray =
        Buffer().also { checkNotNull(body).writeTo(it) }.readByteArray()

    private fun jsonResponse(
        request: okhttp3.Request,
        status: Int,
        body: JSONObject,
        date: String? = null,
    ): Response = Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
        .code(status).message("Fixture")
        .apply { date?.let { header("Date", it) } }
        .body(body.toString().toResponseBody(
            "${QaHubApiContract.VERSIONED_JSON}; charset=utf-8".toMediaType(),
        )).build()

    private fun ByteArray.sha256(): String = MessageDigest.getInstance("SHA-256").digest(this)
        .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
}
