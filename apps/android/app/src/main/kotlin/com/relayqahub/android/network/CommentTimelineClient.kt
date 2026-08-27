package com.relayqahub.android.network

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** Minimal native Comment write plus immutable Bug audit readback. */
class CommentTimelineClient(
    baseUrl: String,
    private val httpClient: OkHttpClient,
    allowPrivateHttp: Boolean = false,
) {
    private val apiBaseUrl: HttpUrl = QaHubApiEndpoint.parse(baseUrl, allowPrivateHttp)

    suspend fun createComment(
        bugId: String,
        clientSubmissionId: String,
        body: String,
        accessToken: String,
    ): NativeComment = withContext(Dispatchers.IO) {
        requireCommentUuid(bugId, "bugId")
        requireCommentUuid(clientSubmissionId, "clientSubmissionId")
        require(body.length in 1..MAX_COMMENT_LENGTH)
        require(accessToken.isNotBlank())
        val response = executeJson(
            method = "POST",
            relativePath = "bugs/$bugId/comments",
            accessToken = accessToken,
            idempotencyKey = "comment:$bugId:$clientSubmissionId",
            expectedStatus = 201,
            body = JSONObject()
                .put("clientSubmissionId", clientSubmissionId)
                .put("body", body),
        )
        val comment = response.optJSONObject("comment")
            ?: throw CommentTimelineFailure("COMMENT_RESPONSE_MISSING")
        val result = NativeComment(
            id = comment.requireCommentUuid("id"),
            bugId = comment.requireCommentUuid("bugId"),
            authorId = comment.requireCommentUuid("authorId"),
            clientSubmissionId = comment.requireCommentUuid("clientSubmissionId"),
            body = comment.requireCommentString("body"),
            createdAt = comment.requireCommentString("createdAt"),
            version = comment.optInt("version", -1),
        )
        if (
            result.bugId != bugId ||
            result.clientSubmissionId != clientSubmissionId ||
            result.body != body ||
            result.version != 1
        ) {
            throw CommentTimelineFailure("INCONSISTENT_COMMENT_RESPONSE")
        }
        result
    }

    suspend fun readTimeline(
        bugId: String,
        limit: Int,
        accessToken: String,
    ): BugAuditTimeline = withContext(Dispatchers.IO) {
        requireCommentUuid(bugId, "bugId")
        require(limit in 1..MAX_TIMELINE_ITEMS)
        require(accessToken.isNotBlank())
        val base = apiBaseUrl.resolve("bugs/$bugId/events")
            ?: throw CommentTimelineFailure("INVALID_COMMENT_TIMELINE_PATH")
        val url = base.newBuilder()
            .addQueryParameter("limit", limit.toString())
            .build()
        val request = Request.Builder()
            .url(url)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .get()
            .build()
        val response = execute(request)
        response.use { result ->
            val responseBody = result.body?.byteStream()?.use {
                it.readCommentUtf8(MAX_RESPONSE_BYTES)
            }.orEmpty()
            if (responseBody.toByteArray(Charsets.UTF_8).size > MAX_RESPONSE_BYTES) {
                throw CommentTimelineFailure("RESPONSE_TOO_LARGE", result.code)
            }
            if (result.code != 200) {
                throw responseBody.toCommentFailure(result.code)
            }
            val root = responseBody.toCommentJson()
            val items = root.optJSONArray("items")
                ?: throw CommentTimelineFailure("TIMELINE_ITEMS_MISSING")
            if (items.length() > limit) {
                throw CommentTimelineFailure("TIMELINE_LIMIT_EXCEEDED")
            }
            val parsed = buildList {
                for (index in 0 until items.length()) {
                    val item = items.optJSONObject(index)
                        ?: throw CommentTimelineFailure("TIMELINE_ITEM_INVALID")
                    val aggregate = item.optJSONObject("aggregate")
                        ?: throw CommentTimelineFailure("TIMELINE_AGGREGATE_MISSING")
                    val payload = item.optJSONObject("payload") ?: JSONObject()
                    val itemBugId = item.requireCommentUuid("bugId")
                    val aggregateId = aggregate.requireCommentUuid("id")
                    val aggregateType = aggregate.requireCommentString("type")
                    val eventType = item.requireCommentString("type")
                    if (itemBugId != bugId) {
                        throw CommentTimelineFailure("TIMELINE_SCOPE_MISMATCH")
                    }
                    if (
                        eventType == "comment.created" &&
                        (aggregateType != "bug" || aggregateId != bugId)
                    ) {
                        throw CommentTimelineFailure("COMMENT_EVENT_SCOPE_MISMATCH")
                    }
                    add(
                        BugAuditEvent(
                            id = item.requireCommentUuid("id"),
                            type = eventType,
                            source = item.requireCommentString("source"),
                            bugId = itemBugId,
                            aggregateVersion = aggregate.optInt("version", -1),
                            sequence = item.optInt("sequence", -1),
                            occurredAt = item.requireCommentString("occurredAt"),
                            commentId = payload.optString("commentId").takeIf(String::isNotBlank),
                        ),
                    )
                }
            }
            if (parsed.any { it.aggregateVersion < 1 || it.sequence < 1 }) {
                throw CommentTimelineFailure("TIMELINE_SEQUENCE_INVALID")
            }
            BugAuditTimeline(
                items = parsed,
                nextCursor = if (root.isNull("nextCursor")) null else root.optString("nextCursor"),
            )
        }
    }

    private fun executeJson(
        method: String,
        relativePath: String,
        accessToken: String,
        idempotencyKey: String?,
        expectedStatus: Int,
        body: JSONObject?,
    ): JSONObject {
        val url = apiBaseUrl.resolve(relativePath.removePrefix("/"))
            ?: throw CommentTimelineFailure("INVALID_COMMENT_PATH")
        val builder = Request.Builder()
            .url(url)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
        idempotencyKey?.let { builder.header("Idempotency-Key", it) }
        val requestBody = body?.toString()
            ?.toRequestBody(QaHubApiContract.VERSIONED_JSON.toMediaType())
        val request = builder.method(method, requestBody).build()
        val response = execute(request)
        response.use { result ->
            val responseBody = result.body?.byteStream()?.use {
                it.readCommentUtf8(MAX_RESPONSE_BYTES)
            }.orEmpty()
            if (responseBody.toByteArray(Charsets.UTF_8).size > MAX_RESPONSE_BYTES) {
                throw CommentTimelineFailure("RESPONSE_TOO_LARGE", result.code)
            }
            if (result.code != expectedStatus) {
                throw responseBody.toCommentFailure(result.code)
            }
            return responseBody.toCommentJson()
        }
    }

    private fun execute(request: Request) = try {
        httpClient.newCall(request).execute()
    } catch (_: IOException) {
        throw CommentTimelineFailure("NETWORK_IO")
    }

    private companion object {
        const val MAX_COMMENT_LENGTH = 20_000
        const val MAX_TIMELINE_ITEMS = 100
        const val MAX_RESPONSE_BYTES = 1024 * 1024
    }
}

data class NativeComment(
    val id: String,
    val bugId: String,
    val authorId: String,
    val clientSubmissionId: String,
    val body: String,
    val createdAt: String,
    val version: Int,
)

data class BugAuditEvent(
    val id: String,
    val type: String,
    val source: String,
    val bugId: String,
    val aggregateVersion: Int,
    val sequence: Int,
    val occurredAt: String,
    val commentId: String?,
)

data class BugAuditTimeline(
    val items: List<BugAuditEvent>,
    val nextCursor: String?,
)

class CommentTimelineFailure(
    val code: String,
    val httpStatus: Int? = null,
) : RuntimeException(code)

private fun String.toCommentJson(): JSONObject = try {
    JSONObject(this)
} catch (_: RuntimeException) {
    throw CommentTimelineFailure("INVALID_COMMENT_RESPONSE")
}

private fun String.toCommentFailure(httpStatus: Int): CommentTimelineFailure {
    val root = runCatching { JSONObject(this) }.getOrNull()
    val code = root?.optString("code").orEmpty().ifBlank {
        root?.optJSONObject("error")?.optString("code").orEmpty()
    }
    return CommentTimelineFailure(code.ifBlank { "HTTP_$httpStatus" }, httpStatus)
}

private fun JSONObject.requireCommentString(key: String): String = optString(key).also {
    if (it.isBlank()) throw CommentTimelineFailure("COMMENT_${key.uppercase()}_MISSING")
}

private fun JSONObject.requireCommentUuid(key: String): String = requireCommentString(key).also {
    requireCommentUuid(it, key)
}

private fun requireCommentUuid(value: String, label: String) {
    if (runCatching { UUID.fromString(value) }.isFailure) {
        throw CommentTimelineFailure("COMMENT_${label.uppercase()}_INVALID")
    }
}

private fun InputStream.readCommentUtf8(maxBytes: Int): String {
    val output = ByteArrayOutputStream(minOf(maxBytes, 8 * 1024))
    val buffer = ByteArray(8 * 1024)
    var total = 0
    while (true) {
        val read = read(buffer)
        if (read < 0) break
        total += read
        output.write(buffer, 0, read)
        if (total > maxBytes) break
    }
    return output.toByteArray().toString(Charsets.UTF_8)
}
