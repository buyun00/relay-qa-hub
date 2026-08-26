package com.relayqahub.android.network

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

class BugWorkbenchClient(
    baseUrl: String,
    private val httpClient: OkHttpClient,
    allowLoopbackHttp: Boolean = false,
) {
    private val apiBaseUrl: HttpUrl = baseUrl.toHttpUrl().let { parsed ->
        require(parsed.username.isEmpty() && parsed.password.isEmpty())
        val loopbackHttp = allowLoopbackHttp &&
            parsed.scheme == "http" &&
            parsed.host in LOOPBACK_HOSTS
        require(parsed.isHttps || loopbackHttp)
        require(parsed.query == null && parsed.fragment == null)
        val normalized = parsed.newBuilder().apply {
            if (!parsed.encodedPath.endsWith('/')) addPathSegment("")
        }.build()
        require(normalized.encodedPath == API_BASE_PATH)
        normalized
    }

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
                    val bugId = item.optString("id")
                    val itemProjectId = item.optString("projectId")
                    val key = item.optString("key")
                    val title = item.optString("title")
                    val itemState = item.optString("state")
                    val reporterId = item.optString("reporterId")
                    val ownerId = item.optString("ownerId").takeIf(String::isNotBlank)
                    val verificationOwnerId = item.optString("verificationOwnerId")
                        .takeIf(String::isNotBlank)
                    val description = item.optString("description")
                    val occurrenceCount = item.optInt("occurrenceCount", -1)
                    val updatedAt = item.optString("updatedAt")
                    if (
                        runCatching { UUID.fromString(bugId) }.isFailure ||
                        itemProjectId != projectId ||
                        key.isBlank() ||
                        title.isBlank() ||
                        itemState !in BUG_STATES ||
                        (state != null && itemState != state) ||
                        reporterId.isBlank() ||
                        occurrenceCount < 0 ||
                        updatedAt.isBlank()
                    ) {
                        throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
                    }
                    add(
                        WorkbenchBug(
                            id = bugId,
                            key = key,
                            title = title,
                            state = itemState,
                            occurrenceCount = occurrenceCount,
                            updatedAt = updatedAt,
                            reporterId = reporterId,
                            ownerId = ownerId,
                            verificationOwnerId = verificationOwnerId,
                            description = description,
                            version = item.optInt("version", 1).coerceAtLeast(1),
                        ),
                    )
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
            (expectedProjectId != null && itemProjectId != expectedProjectId) ||
            key.isBlank() || title.isBlank() || itemState !in BUG_STATES ||
            reporterId.isBlank() || occurrenceCount < 0 || updatedAt.isBlank()
        ) throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
        return WorkbenchBug(
            id = bugId,
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
            version = item.optInt("version", 1).coerceAtLeast(1),
        )
    }

    private companion object {
        const val API_BASE_PATH = "/api/v1/"
        const val MAX_RESPONSE_BYTES = 1024 * 1024
        const val MAX_ITEMS = 100
        val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "::1")
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
    val key: String,
    val title: String,
    val state: String,
    val occurrenceCount: Int,
    val updatedAt: String,
    val reporterId: String = "",
    val ownerId: String? = null,
    val verificationOwnerId: String? = null,
    val description: String = "",
    val version: Int = 1,
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
