package com.relayqahub.android.network

import com.relayqahub.android.data.OfflineOperationEntity
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

class OkHttpQaHubApiClient(
    baseUrl: String,
    httpClient: OkHttpClient,
) : QaHubApiClient {
    private val apiBaseUrl: HttpUrl = baseUrl.toHttpUrl().let { parsed ->
        require(parsed.isHttps) { "QA Hub API base URL must use HTTPS" }
        require(parsed.username.isEmpty() && parsed.password.isEmpty())
        require(parsed.query == null && parsed.fragment == null)
        val normalized = parsed.newBuilder().apply {
            if (!parsed.encodedPath.endsWith('/')) addPathSegment("")
        }.build()
        require(normalized.encodedPath == API_BASE_PATH) {
            "QA Hub API base URL must use the frozen $API_BASE_PATH path"
        }
        normalized
    }
    private val httpClient = httpClient.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .build()

    override suspend fun execute(
        operation: OfflineOperationEntity,
        accessToken: String,
    ): ApiOutcome {
        val request = try {
            buildRequest(operation, accessToken)
        } catch (_: IllegalArgumentException) {
            return ApiOutcome.PermanentFailure("INVALID_QUEUED_REQUEST")
        }

        return suspendCancellableCoroutine { continuation ->
            val call = httpClient.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(
                object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        if (continuation.isActive) {
                            continuation.resume(ApiOutcome.Retryable("NETWORK_IO"))
                        }
                    }

                    override fun onResponse(call: Call, response: Response) {
                        val outcome = try {
                            response.use {
                                classifyResponse(operation, it)
                            }
                        } catch (_: IOException) {
                            ApiOutcome.Retryable("SUCCESS_BODY_READ_FAILED")
                        } catch (_: RuntimeException) {
                            ApiOutcome.Retryable("INVALID_SUCCESS_RESPONSE")
                        }
                        if (continuation.isActive) continuation.resume(outcome)
                    }
                },
            )
        }
    }

    internal fun buildRequest(
        operation: OfflineOperationEntity,
        accessToken: String,
    ): Request {
        require(accessToken.isNotBlank())
        require(!QaHubRelativePath.isBinaryUploadChunk(operation.relativePath)) {
            "Binary upload chunks cannot use the JSON API client"
        }
        if (operation.operationKind == CREATE_BUG_OPERATION) {
            CreateBugSuccessResponseValidator.requireQueuedOperation(operation)
        }
        val resolvedUrl = QaHubRelativePath.resolve(apiBaseUrl, operation.relativePath)
        val requestBody = operation.payloadJson.toRequestBody(VERSIONED_JSON_MEDIA_TYPE)
        return Request.Builder()
            .url(resolvedUrl)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .header("Idempotency-Key", operation.idempotencyKey)
            .method(operation.httpMethod, requestBody)
            .build()
    }

    internal fun hasHardenedTransportPolicy(): Boolean =
        !httpClient.followRedirects &&
            !httpClient.followSslRedirects &&
            !httpClient.retryOnConnectionFailure

    private fun classifyResponse(
        operation: OfflineOperationEntity,
        response: Response,
    ): ApiOutcome {
        if (operation.operationKind != CREATE_BUG_OPERATION) {
            return HttpOutcomeClassifier.classify(response.code)
        }
        if (response.code != CREATE_BUG_SUCCESS_STATUS) {
            return if (response.code in 200..299) {
                ApiOutcome.PermanentFailure("UNEXPECTED_CREATE_BUG_SUCCESS_STATUS_${response.code}")
            } else {
                HttpOutcomeClassifier.classify(response.code)
            }
        }
        val responseBody = response.body
            ?: return ApiOutcome.Retryable("MISSING_SUCCESS_BODY")
        val mediaType = responseBody.contentType()
            ?: return ApiOutcome.Retryable("MISSING_SUCCESS_MEDIA_TYPE")
        if (
            "${mediaType.type}/${mediaType.subtype}" != QaHubApiContract.VERSIONED_JSON ||
            mediaType.charset(StandardCharsets.UTF_8) != StandardCharsets.UTF_8
        ) {
            return ApiOutcome.Retryable("INVALID_SUCCESS_MEDIA_TYPE")
        }
        val responseJson = try {
            responseBody.readBoundedUtf8(MAX_CREATE_BUG_SUCCESS_BODY_BYTES)
        } catch (_: ResponseBodyTooLargeException) {
            return ApiOutcome.Retryable("SUCCESS_BODY_TOO_LARGE")
        } catch (_: IOException) {
            return ApiOutcome.Retryable("SUCCESS_BODY_READ_FAILED")
        }
        return try {
            ApiOutcome.Success(
                httpStatus = response.code,
                createBugReceipt = CreateBugSuccessResponseValidator.validate(
                    operation,
                    responseJson,
                ),
            )
        } catch (violation: SuccessResponseViolation) {
            if (violation.retryable) {
                ApiOutcome.Retryable(violation.errorCode)
            } else {
                ApiOutcome.PermanentFailure(violation.errorCode)
            }
        }
    }

    private companion object {
        const val API_BASE_PATH = "/api/v1/"
        const val CREATE_BUG_OPERATION = "CREATE_BUG"
        const val CREATE_BUG_SUCCESS_STATUS = 201
        val VERSIONED_JSON_MEDIA_TYPE = QaHubApiContract.VERSIONED_JSON.toMediaType()
    }
}

internal const val MAX_CREATE_BUG_SUCCESS_BODY_BYTES = 256 * 1024

private class ResponseBodyTooLargeException : IOException()

private fun okhttp3.ResponseBody.readBoundedUtf8(maxBytes: Int): String {
    require(maxBytes > 0)
    val declaredLength = contentLength()
    if (declaredLength > maxBytes) throw ResponseBodyTooLargeException()
    val output = ByteArrayOutputStream(
        when {
            declaredLength in 0..maxBytes.toLong() -> declaredLength.toInt()
            else -> 8 * 1024
        },
    )
    byteStream().use { input ->
        val buffer = ByteArray(8 * 1024)
        var total = 0
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > maxBytes) throw ResponseBodyTooLargeException()
            output.write(buffer, 0, read)
        }
    }
    return try {
        StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(output.toByteArray()))
            .toString()
    } catch (failure: java.nio.charset.CharacterCodingException) {
        throw IOException("Success body is not valid UTF-8", failure)
    }
}

object HttpOutcomeClassifier {
    fun classify(httpStatus: Int): ApiOutcome = when {
        httpStatus in 200..299 -> ApiOutcome.Success(httpStatus)
        httpStatus == 401 -> ApiOutcome.AuthExpired()
        httpStatus == 408 || httpStatus == 425 || httpStatus == 429 ->
            ApiOutcome.Retryable("HTTP_$httpStatus")
        httpStatus in 500..599 -> ApiOutcome.Retryable("HTTP_$httpStatus")
        else -> ApiOutcome.PermanentFailure("HTTP_$httpStatus")
    }
}
