package com.relayqahub.android.network

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

class DuplicateCandidateClient(
    baseUrl: String,
    private val httpClient: OkHttpClient,
    allowPrivateHttp: Boolean = false,
) {
    private val apiBaseUrl: HttpUrl = QaHubApiEndpoint.parse(baseUrl, allowPrivateHttp)

    suspend fun listCandidates(
        bugId: String,
        accessToken: String,
    ): DuplicateCandidateResult = withContext(Dispatchers.IO) {
        require(runCatching { UUID.fromString(bugId) }.isSuccess)
        require(accessToken.isNotBlank())
        val url = apiBaseUrl.resolve("bugs/$bugId/duplicate-candidates")
            ?: throw DuplicateCandidateFailure("INVALID_DUPLICATE_PATH")
        val request = Request.Builder()
            .url(url)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .get()
            .build()
        val response = try {
            httpClient.newCall(request).execute()
        } catch (_: IOException) {
            throw DuplicateCandidateFailure("NETWORK_IO")
        }
        response.use { result ->
            val body = result.body?.byteStream()?.use { it.readBoundedUtf8(MAX_RESPONSE_BYTES) }
                .orEmpty()
            if (body.toByteArray(Charsets.UTF_8).size > MAX_RESPONSE_BYTES) {
                throw DuplicateCandidateFailure("RESPONSE_TOO_LARGE")
            }
            if (result.code != 200) {
                val code = runCatching { JSONObject(body).optString("code") }.getOrNull().orEmpty()
                throw DuplicateCandidateFailure(code.ifBlank { "HTTP_${result.code}" })
            }
            val json = try {
                JSONObject(body)
            } catch (_: RuntimeException) {
                throw DuplicateCandidateFailure("INVALID_DUPLICATE_RESPONSE")
            }
            val candidatesJson = json.optJSONArray("candidates")
                ?: throw DuplicateCandidateFailure("DUPLICATE_CANDIDATES_MISSING")
            if (candidatesJson.length() > MAX_CANDIDATES) {
                throw DuplicateCandidateFailure("DUPLICATE_CANDIDATES_UNBOUNDED")
            }
            val candidates = buildList {
                for (index in 0 until candidatesJson.length()) {
                    val item = candidatesJson.optJSONObject(index)
                        ?: throw DuplicateCandidateFailure("DUPLICATE_CANDIDATE_INVALID")
                    val candidateBugId = item.optString("bugId")
                    val bugKey = item.optString("bugKey")
                    val score = item.optDouble("score", -1.0)
                    val reasonsJson = item.optJSONArray("reasons")
                        ?: throw DuplicateCandidateFailure("DUPLICATE_REASONS_MISSING")
                    if (
                        runCatching { UUID.fromString(candidateBugId) }.isFailure ||
                        bugKey.isBlank() ||
                        score !in 0.0..1.0 ||
                        reasonsJson.length() < 1
                    ) {
                        throw DuplicateCandidateFailure("DUPLICATE_CANDIDATE_INVALID")
                    }
                    val reasons = buildList {
                        for (reasonIndex in 0 until reasonsJson.length()) {
                            val reason = reasonsJson.optString(reasonIndex)
                            if (reason.isBlank()) {
                                throw DuplicateCandidateFailure("DUPLICATE_REASON_INVALID")
                            }
                            add(reason)
                        }
                    }
                    add(
                        DuplicateCandidate(
                            bugId = candidateBugId,
                            bugKey = bugKey,
                            score = score,
                            reasons = reasons,
                        ),
                    )
                }
            }
            DuplicateCandidateResult(sourceBugId = bugId, candidates = candidates)
        }
    }

    private companion object {
        const val MAX_RESPONSE_BYTES = 256 * 1024
        const val MAX_CANDIDATES = 5
    }
}

data class DuplicateCandidate(
    val bugId: String,
    val bugKey: String,
    val score: Double,
    val reasons: List<String>,
)

data class DuplicateCandidateResult(
    val sourceBugId: String,
    val candidates: List<DuplicateCandidate>,
)

class DuplicateCandidateFailure(val code: String) : RuntimeException()

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
