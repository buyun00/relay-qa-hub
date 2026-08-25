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
        state: String,
        limit: Int,
        accessToken: String,
    ): BugWorkbenchResult = withContext(Dispatchers.IO) {
        require(runCatching { UUID.fromString(projectId) }.isSuccess)
        require(state in BUG_STATES)
        require(limit in 1..MAX_ITEMS)
        require(accessToken.isNotBlank())
        val base = apiBaseUrl.resolve("bugs")
            ?: throw BugWorkbenchFailure("INVALID_WORKBENCH_PATH")
        val url = base.newBuilder()
            .addQueryParameter("projectId", projectId)
            .addQueryParameter("state", state)
            .addQueryParameter("limit", limit.toString())
            .build()
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
                    val occurrenceCount = item.optInt("occurrenceCount", -1)
                    val updatedAt = item.optString("updatedAt")
                    if (
                        runCatching { UUID.fromString(bugId) }.isFailure ||
                        itemProjectId != projectId ||
                        key.isBlank() ||
                        title.isBlank() ||
                        itemState !in BUG_STATES ||
                        itemState != state ||
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
