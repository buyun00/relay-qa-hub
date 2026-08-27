package com.relayqahub.android.network

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

class BugWorkbenchClient(
    baseUrl: String,
    private val httpClient: OkHttpClient,
    allowPrivateHttp: Boolean = false,
) {
    private val apiBaseUrl: HttpUrl = QaHubApiEndpoint.parse(baseUrl, allowPrivateHttp)

    suspend fun listBugs(
        projectId: String,
        state: String? = null,
        limit: Int,
        accessToken: String,
    ): BugWorkbenchResult = withContext(Dispatchers.IO) {
        require(runCatching { UUID.fromString(projectId) }.isSuccess)
        state?.let { require(it in BUG_STATES) }
        require(limit in 1..MAX_ITEMS)
        require(accessToken.isNotBlank())
        val base = apiBaseUrl.resolve("bugs")
            ?: throw BugWorkbenchFailure("INVALID_WORKBENCH_PATH")
        val url = base.newBuilder().apply {
            addQueryParameter("projectId", projectId)
            state?.let { addQueryParameter("state", it) }
            addQueryParameter("limit", limit.toString())
        }.build()
        val request = Request.Builder()
            .url(url)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .get()
            .build()
        val response = try {
            httpClient.newCall(request).execute()
        } catch (_: IOException) {
            throw BugWorkbenchFailure("NETWORK_IO")
        }
        response.use { result ->
            val body = result.body?.byteStream()?.use { it.readWorkbenchUtf8(MAX_RESPONSE_BYTES) }
                .orEmpty()
            if (body.toByteArray(Charsets.UTF_8).size > MAX_RESPONSE_BYTES) {
                throw BugWorkbenchFailure("RESPONSE_TOO_LARGE")
            }
            if (result.code != 200) {
                val code = runCatching { JSONObject(body).optString("code") }.getOrNull().orEmpty()
                throw BugWorkbenchFailure(code.ifBlank { "HTTP_${result.code}" })
            }
            val root = try {
                JSONObject(body)
            } catch (_: RuntimeException) {
                throw BugWorkbenchFailure("INVALID_WORKBENCH_RESPONSE")
            }
            val snapshotSequence = root.optLong("snapshotSequence", -1)
            val itemsJson = root.optJSONArray("items")
                ?: throw BugWorkbenchFailure("WORKBENCH_ITEMS_MISSING")
            if (snapshotSequence < 0 || itemsJson.length() > limit) {
                throw BugWorkbenchFailure("INVALID_WORKBENCH_RESPONSE")
            }
            val items = buildList {
                for (index in 0 until itemsJson.length()) {
                    val item = itemsJson.optJSONObject(index)
                        ?: throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
                    val parsed = parseBug(item, expectedProjectId = projectId)
                    if (state != null && parsed.state != state) {
                        throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
                    }
                    add(parsed)
                }
            }
            BugWorkbenchResult(
                snapshotSequence = snapshotSequence,
                items = items,
                nextCursor = if (root.isNull("nextCursor")) null else root.optString("nextCursor"),
            )
        }
    }

    suspend fun getBug(
        bugId: String,
        accessToken: String,
    ): WorkbenchBug = withContext(Dispatchers.IO) {
        require(runCatching { UUID.fromString(bugId) }.isSuccess)
        require(accessToken.isNotBlank())
        val url = apiBaseUrl.resolve("bugs/$bugId")
            ?: throw BugWorkbenchFailure("INVALID_WORKBENCH_PATH")
        val request = Request.Builder()
            .url(url)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .get()
            .build()
        val response = runCatching { httpClient.newCall(request).execute() }
            .getOrElse { throw BugWorkbenchFailure("NETWORK_IO") }
        response.use { result ->
            val body = result.body?.byteStream()?.use { it.readWorkbenchUtf8(MAX_RESPONSE_BYTES) }
                .orEmpty()
            if (result.code != 200) {
                val code = runCatching { JSONObject(body).optString("code") }.getOrNull().orEmpty()
                throw BugWorkbenchFailure(code.ifBlank { "HTTP_${result.code}" })
            }
            val item = runCatching { JSONObject(body) }
                .getOrElse { throw BugWorkbenchFailure("INVALID_WORKBENCH_RESPONSE") }
            parseBug(item, expectedProjectId = null)
        }
    }

    /** Reads the Bug and its image attachments without exposing management actions on Android. */
    suspend fun getBugDetail(
        bugId: String,
        accessToken: String,
    ): WorkbenchBugDetail = withContext(Dispatchers.IO) {
        val bug = getBug(bugId, accessToken)
        var imageErrorCode: String? = null
        val metadata = runCatching { listImageAttachments(bug, accessToken) }
            .getOrElse { failure ->
                imageErrorCode = failure.workbenchCode("ATTACHMENT_READ_FAILED")
                emptyList()
            }
        val images = metadata.take(MAX_DETAIL_IMAGES).mapNotNull { item ->
            runCatching { downloadImage(item, accessToken) }
                .onFailure { failure ->
                    if (imageErrorCode == null) {
                        imageErrorCode = failure.workbenchCode("ATTACHMENT_READ_FAILED")
                    }
                }
                .getOrNull()
        }
        WorkbenchBugDetail(
            bug = bug,
            images = images,
            imageErrorCode = imageErrorCode,
        )
    }

    private fun listImageAttachments(
        bug: WorkbenchBug,
        accessToken: String,
    ): List<WorkbenchBugImageMetadata> {
        val base = apiBaseUrl.resolve("bugs/${bug.id}/attachments")
            ?: throw BugWorkbenchFailure("INVALID_WORKBENCH_PATH")
        val request = Request.Builder()
            .url(base.newBuilder().addQueryParameter("limit", "20").build())
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .get()
            .build()
        val response = try {
            httpClient.newCall(request).execute()
        } catch (_: IOException) {
            throw BugWorkbenchFailure("ATTACHMENT_NETWORK_IO")
        }
        response.use { result ->
            val body = result.body?.byteStream()?.use { it.readWorkbenchUtf8(MAX_RESPONSE_BYTES) }
                .orEmpty()
            if (result.code != 200) {
                val code = runCatching { JSONObject(body).optString("code") }.getOrNull().orEmpty()
                throw BugWorkbenchFailure(code.ifBlank { "ATTACHMENT_HTTP_${result.code}" })
            }
            val root = runCatching { JSONObject(body) }
                .getOrElse { throw BugWorkbenchFailure("INVALID_ATTACHMENT_RESPONSE") }
            if (root.optString("bugId") != bug.id || root.optString("projectId") != bug.projectId) {
                throw BugWorkbenchFailure("INVALID_ATTACHMENT_RESPONSE")
            }
            val items = root.optJSONArray("items")
                ?: throw BugWorkbenchFailure("INVALID_ATTACHMENT_RESPONSE")
            return buildList {
                for (index in 0 until items.length()) {
                    val item = items.optJSONObject(index)
                        ?: throw BugWorkbenchFailure("INVALID_ATTACHMENT_RESPONSE")
                    val attachmentId = item.optString("attachmentId")
                    val filename = item.optString("filename")
                    val mediaType = item.optString("mediaType")
                    val size = item.optLong("size", -1L)
                    val sha256 = item.optString("sha256")
                    if (
                        runCatching { UUID.fromString(attachmentId) }.isFailure ||
                        filename.isBlank() || mediaType.isBlank() ||
                        size !in 1..MAX_DETAIL_IMAGE_BYTES.toLong() ||
                        !SHA256_PATTERN.matches(sha256)
                    ) continue
                    if (mediaType.startsWith("image/", ignoreCase = true)) {
                        add(WorkbenchBugImageMetadata(attachmentId, filename, mediaType, size, sha256))
                    }
                }
            }.sortedByDescending { it.filename.contains("annotated", ignoreCase = true) }
        }
    }

    private fun downloadImage(
        metadata: WorkbenchBugImageMetadata,
        accessToken: String,
    ): WorkbenchBugImage {
        val url = apiBaseUrl.resolve("attachments/${metadata.attachmentId}")
            ?: throw BugWorkbenchFailure("INVALID_WORKBENCH_PATH")
        val request = Request.Builder()
            .url(url)
            .header("Accept", metadata.mediaType)
            .header("Authorization", "Bearer $accessToken")
            .get()
            .build()
        val response = try {
            httpClient.newCall(request).execute()
        } catch (_: IOException) {
            throw BugWorkbenchFailure("ATTACHMENT_NETWORK_IO")
        }
        response.use { result ->
            if (result.code != 200) {
                throw BugWorkbenchFailure("ATTACHMENT_HTTP_${result.code}")
            }
            val bytes = result.body?.byteStream()?.use { it.readWorkbenchBytes(MAX_DETAIL_IMAGE_BYTES) }
                ?: throw BugWorkbenchFailure("ATTACHMENT_BODY_MISSING")
            if (bytes.size.toLong() != metadata.size || bytes.sha256Hex() != metadata.sha256) {
                throw BugWorkbenchFailure("ATTACHMENT_INTEGRITY_FAILED")
            }
            return WorkbenchBugImage(
                attachmentId = metadata.attachmentId,
                filename = metadata.filename,
                mediaType = metadata.mediaType,
                bytes = bytes,
            )
        }
    }

    private fun parseBug(item: JSONObject, expectedProjectId: String?): WorkbenchBug {
        val bugId = item.optString("id")
        val itemProjectId = item.optString("projectId")
        val key = item.optString("key")
        val title = item.optString("title")
        val itemState = item.optString("state")
        val reporterId = item.optString("reporterId")
        val occurrenceCount = item.optInt("occurrenceCount", -1)
        val updatedAt = item.optString("updatedAt")
        if (
            runCatching { UUID.fromString(bugId) }.isFailure ||
            runCatching { UUID.fromString(itemProjectId) }.isFailure ||
            (expectedProjectId != null && itemProjectId != expectedProjectId) ||
            key.isBlank() || title.isBlank() || itemState !in BUG_STATES ||
            reporterId.isBlank() || occurrenceCount < 0 || updatedAt.isBlank()
        ) throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
        return WorkbenchBug(
            id = bugId,
            projectId = itemProjectId,
            key = key,
            title = title,
            state = itemState,
            occurrenceCount = occurrenceCount,
            updatedAt = updatedAt,
            reporterId = reporterId,
            ownerId = item.optString("ownerId").takeIf(String::isNotBlank),
            verificationOwnerId = item.optString("verificationOwnerId")
                .takeIf(String::isNotBlank),
            description = item.optString("description"),
            expectedBehavior = item.optString("expectedBehavior"),
            severity = item.optString("severity"),
            priority = item.optString("priority"),
            createdAt = item.optString("createdAt").ifBlank { updatedAt },
            closedAt = item.optString("closedAt").takeIf(String::isNotBlank),
            version = item.optInt("version", 1).coerceAtLeast(1),
        )
    }

    private companion object {
        const val MAX_RESPONSE_BYTES = 1024 * 1024
        const val MAX_ITEMS = 100
        const val MAX_DETAIL_IMAGES = 4
        const val MAX_DETAIL_IMAGE_BYTES = 24 * 1024 * 1024
        val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
        val BUG_STATES = setOf(
            "reported",
            "needs_info",
            "ready",
            "in_progress",
            "awaiting_build",
            "ready_for_verification",
            "closed",
            "deferred",
            "rejected",
            "duplicate",
        )
    }
}

data class WorkbenchBug(
    val id: String,
    val projectId: String,
    val key: String,
    val title: String,
    val state: String,
    val occurrenceCount: Int,
    val updatedAt: String,
    val reporterId: String = "",
    val ownerId: String? = null,
    val verificationOwnerId: String? = null,
    val description: String = "",
    val expectedBehavior: String = "",
    val severity: String = "",
    val priority: String = "",
    val createdAt: String = "",
    val closedAt: String? = null,
    val version: Int = 1,
)

data class WorkbenchBugImageMetadata(
    val attachmentId: String,
    val filename: String,
    val mediaType: String,
    val size: Long,
    val sha256: String,
)

data class WorkbenchBugImage(
    val attachmentId: String,
    val filename: String,
    val mediaType: String,
    val bytes: ByteArray,
)

data class WorkbenchBugDetail(
    val bug: WorkbenchBug,
    val images: List<WorkbenchBugImage>,
    val imageErrorCode: String? = null,
)

data class BugWorkbenchResult(
    val snapshotSequence: Long,
    val items: List<WorkbenchBug>,
    val nextCursor: String?,
)

class BugWorkbenchFailure(val code: String) : RuntimeException()

private fun InputStream.readWorkbenchUtf8(maxBytes: Int): String {
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

private fun InputStream.readWorkbenchBytes(maxBytes: Int): ByteArray {
    val output = ByteArrayOutputStream(minOf(maxBytes, 64 * 1024))
    val buffer = ByteArray(16 * 1024)
    var total = 0
    while (true) {
        val read = read(buffer)
        if (read < 0) break
        total += read
        if (total > maxBytes) throw BugWorkbenchFailure("ATTACHMENT_TOO_LARGE")
        output.write(buffer, 0, read)
    }
    return output.toByteArray()
}

private fun ByteArray.sha256Hex(): String = MessageDigest.getInstance("SHA-256")
    .digest(this)
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

private fun Throwable.workbenchCode(fallback: String): String =
    (this as? BugWorkbenchFailure)?.code ?: fallback
