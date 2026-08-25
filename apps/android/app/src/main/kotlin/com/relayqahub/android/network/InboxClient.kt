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

class InboxClient(
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

    suspend fun listNotifications(accessToken: String): InboxResult = withContext(Dispatchers.IO) {
        require(accessToken.isNotBlank())
        val url = apiBaseUrl.resolve("notifications")
            ?: throw InboxFailure("INVALID_INBOX_PATH")
        val request = Request.Builder()
            .url(url)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .get()
            .build()
        val response = try {
            httpClient.newCall(request).execute()
        } catch (_: IOException) {
            throw InboxFailure("NETWORK_IO")
        }
        response.use { result ->
            val body = result.body?.byteStream()?.use { it.readBoundedUtf8(MAX_RESPONSE_BYTES) }
                .orEmpty()
            if (body.toByteArray(Charsets.UTF_8).size > MAX_RESPONSE_BYTES) {
                throw InboxFailure("RESPONSE_TOO_LARGE")
            }
            if (result.code != 200) {
                val code = runCatching { JSONObject(body).optString("code") }.getOrNull().orEmpty()
                throw InboxFailure(code.ifBlank { "HTTP_${result.code}" })
            }
            val json = try {
                JSONObject(body)
            } catch (_: RuntimeException) {
                throw InboxFailure("INVALID_INBOX_RESPONSE")
            }
            val items = json.optJSONArray("items")
                ?: throw InboxFailure("INBOX_ITEMS_MISSING")
            val unreadCount = json.optInt("unreadCount", -1)
            if (unreadCount < 0) throw InboxFailure("INBOX_UNREAD_COUNT_INVALID")
            val notifications = buildList {
                for (index in 0 until items.length()) {
                    val item = items.optJSONObject(index)
                        ?: throw InboxFailure("INBOX_ITEM_INVALID")
                    val id = item.optString("id")
                    if (runCatching { UUID.fromString(id) }.isFailure) {
                        throw InboxFailure("INBOX_ITEM_ID_INVALID")
                    }
                    val title = item.optString("title")
                    val type = item.optString("type")
                    if (title.isBlank() || type.isBlank()) {
                        throw InboxFailure("INBOX_ITEM_FIELDS_MISSING")
                    }
                    add(InboxNotification(id = id, type = type, title = title))
                }
            }
            InboxResult(items = notifications, unreadCount = unreadCount)
        }
    }

    private companion object {
        const val API_BASE_PATH = "/api/v1/"
        const val MAX_RESPONSE_BYTES = 256 * 1024
        val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "::1")
    }
}

data class InboxNotification(
    val id: String,
    val type: String,
    val title: String,
)

data class InboxResult(
    val items: List<InboxNotification>,
    val unreadCount: Int,
)

class InboxFailure(val code: String) : RuntimeException()

private fun InputStream.readBoundedUtf8(maxBytes: Int): String {
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
